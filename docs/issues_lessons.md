# issues_lessons.md — WebGPU → WebGL2 移植的经验教训

> 日期：2026-08-16
> 背景：把 `WebGpuWaterEngine`（全 compute 的 Raw WebGPU 水面引擎）一比一移植到 WebGL2。
> 规格与契约见 [`docs/webgl2-port/`](webgl2-port/)。
>
> **本仓库说明（yong-webgl2-water）**：本文精简自源项目 `inkwell-webgpu-water`
> （commit `7dbf39c` / `7331e81`），已删去纯 WebGPU 侧的条目。文中提到的
> `src/lib/webgpu-water-engine.ts`、`ship-*.ts`、React 页面等路径指向**源仓库**；
> 本仓库只保留 WebGL2 实现，不含 WebGPU 代码、Three.js 适配层与船体渲染。

---

# 一、API 语义差异（最容易悄悄改变画面的一类）

## 1.1 深度范围：`[0, 1]` vs `[-1, 1]`

WebGPU / Metal / D3D 的 NDC 深度是 `[0, 1]`，OpenGL / WebGL2 默认是 `[-1, 1]`。
投影矩阵必须按目标范围分别构造，**并且所有硬编码的深度字面量都要跟着换算**：
天空的裁剪深度、天际裙边的深度、任何「贴着远平面画」的技巧都属于这一类。

- 本项目：`water-math.ts` 的 `perspective()` 显式接受 `"zero-to-one" | "minus-one-to-one"`；
  GL 侧天空 z = 0.999998、天际裙边 0.99998。
- 若环境支持 `EXT_clip_control`，可以把 GL 也切到 `[0, 1]`，两后端深度编码就完全相同——
  这是本项目列在待办里的优化项。

## 1.2 屏幕/纹理坐标的 v 轴方向

WebGPU 的帧缓冲原点在左上，WebGL2 在左下。经验是**不要**在全局做一次 flip，
而是逐处判断哪一个量真的处于哪个坐标系里：

- 折射的屏幕空间偏移：v 分量取反；
- 离屏结果 blit 到画布：uv **不**翻转（两侧都是 framebuffer 空间，翻转反而会上下颠倒）。

判断依据是「这个值最终喂给谁」，不是「它长得像 UV」。

## 1.3 `select()` 与三元表达式的参数顺序

WGSL 是 `select(falseValue, trueValue, condition)`，GLSL 是 `condition ? trueValue : falseValue`。
顺序**相反**。移植时逐个 `select` 站点核对，本项目在浅水求解器里就有 6 处。
这类错误不会报编译错，只会让画面「差一点点」。

## 1.4 `discard` 的语义差异

WGSL 的 `discard` 把该 invocation 降级为 helper invocation，quad 内的屏幕空间导数仍然有定义；
GLSL ES 的 `discard` 直接终止 invocation，邻居的 `dFdx` / `dFdy` 会变成未定义。

修法：把所有纹理采样与导数计算**上提到** alpha mask 测试之前。
本项目在船体片元着色器里这样做，恢复了 WebGPU 的语义，且因为这些计算不依赖 mask，存活片元的结果不变。

## 1.5 计算着色器 → 片元着色器的索引还原

compute 的 `global_invocation_id` 是整数；片元 pass 里只有 `gl_FragCoord`，
纹素中心在 `+0.5`，所以 `int(gl_FragCoord.x)` 的截断刚好还原索引——
前提是 **viewport 与目标纹理尺寸严格一致**。1D 的 compute（如 256 长的碎波事件历史）
要渲染成 256×1 的 FBO，不能用一张更大的纹理凑合。

## 1.6 浮点纹理的可过滤性

`RGBA32F` 在 WebGL2 里默认**不可线性过滤**（需要 `OES_texture_float_linear`）。
因此所有 32 位浮点查找表（旋转因子、初始谱、波矢表）必须走 NEAREST + `texelFetch`。
不要因为「原来的 WGSL 用了 sampler」就照搬成 `texture()`。

## 1.7 顶点阶段的纹理读取

顶点着色器里没有隐式导数，`texture()` 的 LOD 未定义。顶点阶段一律用
`textureLod(..., 0.0)` 或 `texelFetch(..., 0)`。本项目的水面顶点位移与船体变换读取都属于这一类。

## 1.8 纹理不会被零初始化

WebGPU 保证新建纹理内容为零，WebGL2 **不保证**。
一旦未初始化的 NaN 进入 ping-pong 的水体状态，它会永远反馈下去。
所有谱场 / 水体状态 / 碎波事件纹理在分配后必须显式 `clear`（本项目共 16 张）。

## 1.9 采样器状态与纹理解耦

WebGPU 的 sampler 与 texture 是分开的对象；WebGL2 的采样参数默认挂在纹理上。
用 WebGL2 Sampler Object 恢复这种解耦，才能让同一张纹理在不同 pass 里用不同的 wrap/filter，
而不需要在帧中途改纹理参数（那会造成隐式的状态污染）。

## 1.10 精度声明

GLSL ES 3.00 的片元着色器没有默认 `float` 精度。
所有着色器顶部必须有 `precision highp float; precision highp int; precision highp sampler2D;`，
否则不同驱动的默认精度不同，海浪细节会在部分设备上退化。
本项目由 `composeShaderSource()` 统一插入 `#version` 行、`#define` 列表与精度前导块，
并用 `preambleLineCount()` 把驱动报的行号映射回着色器正文——这在调试 GLSL 编译错误时很关键。

---

# 二、资源与生命周期

## 2.1 一块 canvas 终身只有一种上下文

`getContext("webgpu")` 成功之后，同一元素上的 `getContext("webgl2")` 永远返回 `null`。
所以「先试 WebGPU，失败了再试 WebGL2」这种直觉写法是**错的**：
必须在任何引擎碰 canvas 之前，用 `navigator.gpu` 单独探测完再决定。

推论：WebGPU 的 `init()` 失败也不能就地降级，只能换 canvas 或重新加载。

## 2.2 `loseContext()` 是共享资源上的破坏性操作

`canvas.getContext("webgl2")` 在 canvas 生命周期内返回**同一个**上下文对象。
在 `dispose()` 里调 `WEBGL_lose_context.loseContext()` 会连带杀死「接替自己」的下一个引擎，
React 开发期 StrictMode 双挂载必现。
引擎只应删除自己创建的对象，上下文随 canvas 消亡。

## 2.4 资源重建先建后放

任何「重新分配」路径（resize、改模拟分辨率）都要先构造新资源，成功后再释放旧的。
反过来写，一次分配失败就会同时失去资源和继续渲染的能力。

## 2.5 多步资源构造需要显式 unwind 栈

没有 RAII 的语言里，一长串 `create*` 中途抛错就会泄漏前面的句柄。
用一个「创建即压栈、失败逆序展开、成功交给 dispose」的小工具解决。

## 2.6 停机必须留下原因

会终止渲染循环的路径（上下文丢失、分配失败、资源缺失）都要写入一个可读的错误文案，
并且**保留第一个**错误——后续的 GL 错误通常只是后果，会掩盖真正的原因。

---

# 三、模块结构

## 3.1 桶文件 + 模板字面量常量 = 暂时性死区

`src/lib/webgl2/index.ts` 同时导出基础设施层与 pass 层。
pass 模块若从桶文件反向导入，加载顺序会变成：pass → 桶 → 其它 pass，
于是拼 GLSL 的模板字面量在它插值的常量初始化之前求值，读到 `undefined`，
最终表现为「着色器里出现字面量 `undefined` 的语法错误」。

三道防线：
1. pass 一律从具体同级模块导入；
2. 桶文件内部把基础设施层排在 pass 层之前，并在注释中写明这个顺序是有约束力的；
3. eslint `no-restricted-imports` 把约定变成错误（注意规则里必须写精确 specifier，
   裸 `.` / `./` 会被当作 gitignore 风格前缀而封掉所有同级导入）。

## 3.2 用于互相比较的度量只能有一份实现

两个后端各写一份指标组装，很快就会在三角形口径、分位数算法、卡顿阈值上分叉，
性能与视觉对比同时失效。度量抽成共享模块，调用方只传采样缓冲。

## 3.3 边界校验做在边界上

选项的取整与钳制若只写在 setter 里，构造函数就是一个绕过校验的后门
（`?simulation=256.5` 直接进纹理尺寸）。归一化函数放在类型模块里，两个引擎的构造函数共用。

配套的两点：
- URL 参数在组件层用 `Math.round`，而不是让引擎去 `floor`（两者对 `256.5` 给出不同结果）；
- 需要整数的地方用 `Number.isInteger` / `Number.isFinite` 显式判断，
  不要依赖 `Number(x) || fallback`（`0` 会被吞掉）。

---

# 四、流程经验

## 4.1 先冻结一份源码副本，规格里的行号才有意义

移植开始前把参照实现（`webgpu-water-engine.ts`、`shared-wgsl.ts`、`ship-shaders.ts`、
`ship-renderer.ts` 等）复制到只读目录，规格文档与源码注释一律引用这份冻结副本的行号。
否则主干一重构，所有「engine:1287-1535」这类引用同时失效。

入库后改用 `文件名@7dbf39c:行号` 记法，读者可以用 `git show 7dbf39c:src/lib/...` 精确复原。

## 4.2 规格文档先行，再并行实现

先产出 `spec-engine.md`（引擎公共 API、帧序、渲染 pass）、`spec-compute.md`（全部常量、
compute 算法、移植检查清单）与 `contract.md`（基础设施层怎么用、移植约定），
再让多个实现方向并行推进。共享的是文档而不是口头约定，才不会各写各的坐标系。

## 4.3 GLSL 常量与 WGSL 常量做机器比对

不要靠肉眼核对几百个魔数。把两边的常量抽成可枚举集合，用测试断言「多重集相等」，
以及「关键字面量出现在着色器文本里」。本项目的 `tests/webgl2-*.test.ts`
就是对拼好的 GLSL 文本做断言，不需要 GPU。

## 4.4 保留 CPU 镜像做数值对拍

`src/lib/nearshore-reference.ts` 是浅水求解器单格更新的 CPU 实现，
它既是 WGSL 的数值契约，也是 GLSL 的数值契约。
移植时先让 GLSL 与这份镜像对上，再去比整帧画面，能把问题定位到「哪一项算错了」。

## 4.5 固定帧数 + 固定时间 = 可逐字节比较的截图

只有 `fixedTime` 不够：两个后端的 rAF 帧数不同，累积状态（碎波事件、泡沫、尾流）就会分叉。
加上 `frameLimit`，让两边渲染**相同帧数**后各自停机，截图才真正可比。
这是 `scripts/compare-backends.mjs` 能给出 0.0x% 级别结论的前提。

## 4.6 双路径验收

同一批场景分别用 Chrome DevTools MCP 手工核验与 Playwright 脚本自动对比。
手工路径能看到控制台、扩展列表、实际 adapter 字符串；
脚本路径给出可回归的数字。两条路径结论一致，才算通过。

## 4.7 差异要定位到成因，而不是只报一个比例

最终残余的 0.0x% 差异全部落在船体薄几何边缘（光栅化覆盖与深度 tie-break 的 API 差异），
水体逐像素一致。把「差在哪里」说清楚，才能判断这个数字是可接受的还是掩盖了真正的 bug。

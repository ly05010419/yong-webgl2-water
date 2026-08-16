# yong-webgl2-water

Tethys 水体的 **WebGL2 实现**：一个不依赖任何框架的水面渲染引擎，外加一个用
Vite + 原生 TypeScript 写的演示页。

本项目从 [`inkwell-webgpu-water`](https://github.com/ly05010419/inkwell-webgpu-water)
（commit `7dbf39c` / `7331e81`）中抽取而来，**只保留 WebGL2 渲染路径**：不含
WebGPU 引擎、不含 Three.js WebGPU 适配层。
引擎的数学、GLSL 与每帧执行顺序一行未改，因此在相同参数下与源项目 `/webgl2` 页面
**逐像素零差异**（见〈像素对齐验证〉）。

---

## 它渲染什么

| 子系统 | 实现方式 |
| --- | --- |
| 远海浪谱 | 三级 JONSWAP/TMA 级联，128² 初始谱在 CPU 上确定性生成，GPU 侧每帧演化 |
| 逆变换 | Stockham 自排序 IFFT，三级级联打包进一张 atlas，14 个片元 pass 完成 |
| 近岸水动力 | Rusanov 通量的守恒型浅水求解器（水深 + 双向流量），静水重构保证 well-balanced |
| 碎波事件 | 一行 256 宽的事件纹理，记录碎波前沿的位置与强度（`BREAKER_ENABLED` 当前关闭） |
| 地形 | 一次性烘焙的 512² 地形场纹理，海岸线与海床剖面由解析函数生成 |
| 水面几何 | 10 级 clipmap 环（64² / 环，最外圈 16384 m）+ 20 km 天际裙边 |
| 着色 | Cox-Munk 微面元 BRDF、深度感知吸收、屏幕空间折射、解析反射、焦散与泡沫 |
| GPGPU | 全部用片元着色器 ping-pong 完成（WebGL2 没有 compute shader） |
| 状态管理 | 一层 GL 状态缓存去重绑定；开发构建下每帧结束做一次一致性抽查 |

场景两种：`open`（开阔水域，直接绘制到默认帧缓冲）与 `shore`（岛屿海岸，需要离屏
捕获场景颜色与深度供水面折射采样）。视角两种：`surface` 与 `underwater`。

---

## 快速开始

```bash
npm install
npm run dev        # 演示页（Vite dev server）
npm run build      # 演示页 + 库（dist-demo/ 与 dist/）
npm run preview    # 预览已构建的演示页
npm test           # vitest（451 个用例）
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm run check      # lint + typecheck + test + build
```

浏览器要求：**WebGL2**，且具备 `EXT_color_buffer_float` 或
`EXT_color_buffer_half_float` 其一（浮点渲染目标）。缺少二者会给出中文报错并停止渲染。
`OES_texture_float_linear` 与 `EXT_disjoint_timer_query_webgl2` 是可选增强
（前者影响 `rgba32f` 的线性过滤，后者提供 GPU 计时指标）。

---

## 作为库使用

```ts
import { WebGl2WaterEngine } from "yong-webgl2-water";

const canvas = document.querySelector("canvas")!;
const engine = new WebGl2WaterEngine(canvas, { scene: "open", view: "surface" });

await engine.init();          // 申请上下文、编译着色器、分配资源；失败会 reject
// …
engine.setScene("shore");     // 运行时切换
console.log(engine.getMetrics());

engine.dispose();             // 停止渲染循环并释放全部 GL 对象
```

引擎自带轨道相机（拖拽旋转、滚轮缩放）与 `ResizeObserver`，画布只需在 CSS 里给定尺寸。
DPR 上限 1.5（`benchmark: true` 时为 1），再乘以 `renderScale`。

### 选项与对应 setter

`new WebGl2WaterEngine(canvas, options)` 接受 `Partial<WaterLabOptions>`，
构造时即按下表钳制，与调用对应 setter 完全等价。

| 选项 | 类型 / 范围 | 默认 | setter | 说明 |
| --- | --- | --- | --- | --- |
| `mode` | `"optimized" \| "reference"` | `optimized` | `setMode` | 参考模式跑两个 1/120 s 子步 |
| `view` | `"surface" \| "underwater"` | `surface` | `setView` | 相机所处介质 |
| `scene` | `"open" \| "shore"` | `open` | `setScene` | 切换会重建近岸场 |
| `meshResolution` | 96 – 320（整数） | 240 | `setMeshResolution` | 地形网格；`shore` 固定 512² |
| `simulationResolution` | 64 – 512（整数） | 256 | `setSimulationResolution` | 近岸场分辨率；切换会重建 |
| `renderScale` | 0.5 – 1.25 | 1 | `setRenderScale` | 离屏分辨率倍率；变化会重建帧目标 |
| `waveScale` | 0.15 – 1.6 | 1 | `setWaveScale` | 浪高倍率 |
| `distantRoughness` | 0 – 3 | 0 | `setDistantRoughness` | 远景 BRDF 粗糙度补偿 |
| `detailRange` | 0.4 – 8 | 1 | `setDetailRange` | 毛细波/浪冠淡出距离倍率 |
| `swellSmoothing` | 0 – 3 | 1 | `setSwellSmoothing` | 远景坡度屏幕空间平滑 |
| `longCascadeScale` | 80 – 480 | 240 | `setLongCascadeScale` | 长浪级联瓦片尺寸（米） |
| `mediumCascadeScale` | 24 – 128 | 64 | `setMediumCascadeScale` | 中浪级联瓦片尺寸（米） |
| `fogReach` | 0 – 3 | 0 | `setFogReach` | 远海径向雾距；0 为关闭 |
| `fixedTime` | `number?` | — | — | 冻结模拟时间，用于可复现截图 |
| `frameLimit` | `number?` | — | — | 渲染 N 帧后停止循环 |
| `benchmark` | `boolean` | `false` | — | DPR 上限降为 1 |
| `cameraYaw` / `cameraPitch` | `number?` | — | — | 初始轨道角覆盖 |

范围表本身以 `WATER_LAB_OPTION_BOUNDS` 导出，演示页的滑杆直接读它，
所以面板永远不会给出引擎会钳掉的值。

### 包导出

`WebGl2WaterEngine`、`DEFAULT_WATER_LAB_OPTIONS`、`WATER_LAB_OPTION_BOUNDS`、
`normalizeWaterLabOption`、`normalizeWaterLabOptions`、`parseWaterLabQuery`、
`WATER_PROFILES`、`TETHYS_WATER_LEVEL`、`TETHYS_WATER_FIELD_SIZE`、
`TETHYS_REFERENCE_SIMULATION_RESOLUTION`、`waterSimulationBytes`、
`waterTriangleCount`、`frameTriangleCount`、相机轨道常量与
`resolveInitialCameraOrbit` / `clampCameraPitch`，以及 `WaterLabOptions`、
`WaterLabMetrics`、`WaterRenderMode`、`WaterScene`、`WaterView`、
`CameraOrbitState` 等类型。`tests/package-api.test.ts` 会把这份清单钉死。

---

## 演示页 URL 参数

`parseWaterLabQuery(location.search)` 是纯函数，DOM 无关，可直接在 node 里测试。

| 参数 | 含义 |
| --- | --- |
| `mode` | `reference` 走双子步参考路径，其余值为 `optimized` |
| `view` | `underwater` 或 `surface` |
| `scene` | `shore` 或 `open` |
| `mesh` / `simulation` / `scale` | `meshResolution` / `simulationResolution` / `renderScale` |
| `waves` / `farRough` / `detail` / `smooth` | `waveScale` / `distantRoughness` / `detailRange` / `swellSmoothing` |
| `longScale` / `mediumScale` / `fog` | 两级级联尺度与雾距 |
| `fixedTime` | 冻结模拟时间（秒）；`fixedTime=0` 有效，不会当成缺省 |
| `frames` | 渲染 N 帧后停止；小于 1 视为不限制 |
| `benchmark` | `1` 时把 DPR 上限降到 1 |
| `yaw` / `pitch` | 初始轨道角 |
| `ui` | `0` 隐藏控制面板（干净截图用） |

数值参数全部经过与 setter 相同的钳制，所以一段 URL 和等价的 setter 调用序列
落到完全相同的引擎状态上。

### 自动化桥

演示页在 `window.__WEBGL2_WATER_LAB__` 上挂一个桥，方法名与源项目的
`window.__WEBGPU_WATER_LAB__` **完全一致**（只有全局名不同），因此源项目的
Playwright 脚本可以原样复用：

```
ready, getMetrics(), resetMetrics(),
setMode, setView, setScene,
setMeshResolution, setSimulationResolution, setRenderScale,
setWaveScale, setDistantRoughness, setDetailRange, setSwellSmoothing,
setLongCascadeScale, setMediumCascadeScale, setFogReach
```

桥在 `init()` **之前**就以占位形式安装好（所有 setter 为 no-op、`ready: false`），
这样一次启动失败也能通过 `getMetrics().error` 读到原因，而不是让脚本卡到超时。

---

## 指标说明

`getMetrics()` 返回一份快照，演示页每 250 ms 拉取一次。

| 字段 | 含义 |
| --- | --- |
| `ready` | 渲染循环是否已启动 |
| `triangles` | 每帧提交的三角形数：地形 + clipmap 环（外圈按 1.5 退化系数）+ 碎波片 |
| `simulationBytes` | 近岸场 ping-pong 对占用的字节数 |
| `simulationSubsteps` | 1（优化）或 2（参考） |
| `sceneCapturePasses` | `shore` 为 1，`open` 为 0 |
| `disturbanceCount` | 已注入的尾迹脉冲次数 |
| `frameMeanMs` / `frameP95Ms` / `frameP99Ms` / `frameMaxMs` / `fps` | 最近 360 帧的滑动窗口统计（最近秩百分位） |
| `hitchFrames` | 窗口内超过 50 ms 的帧数 |
| `submitMeanMs` | 每帧 JS 侧提交耗时 |
| `gpuSimulationMeanMs` / `gpuRenderMeanMs` / …P95 | GPU 计时；无 `EXT_disjoint_timer_query_webgl2` 时为 `null` |
| `gpuTimestampSamples` | 两个计时器都产出的样本对数 |
| `adapter` | `"WebGL2 · <renderer 字符串>"`，软件渲染时追加提示 |
| `error` | 首个致命错误（中文），渲染循环随之停止 |

---

## 像素对齐验证

```bash
# 源项目在 http://127.0.0.1:3200 起生产服务器（npm run build && npm run start）
npm run build:demo
npx vite preview --port 4173 --strictPort &
node scripts/compare-with-source.mjs        # 三场景，pixelmatch threshold 0
node scripts/interaction-smoke.mjs          # 桥接 setter + 视口 resize 回归
```

`compare-with-source.mjs` 在 1280×800 / DPR 1 下抓取 `open+surface`、
`shore+surface`、`open+underwater` 三个场景，参数为
`fixedTime=8.25&frames=240&ui=0`。它做两件必要的事：

1. **等待渲染循环自己停下**——轮询 `getMetrics()` 直到两次快照完全相同。
   `frames=240` 之后指标就冻结了，固定 sleep 做不到这个保证。
2. **拦截源项目的 `**/models/**` 请求**——源项目的演示页还会画一艘 glTF 帆船，
   而本项目按设计不含船体。拦下模型下载后源引擎会跳过船体（缺失资产在那边是可选布景），
   两边渲染的就是同一个场景。源仓库一个字节都不用改。

当前结果：三场景 `mismatch=0`、`maxΔ=0`。

---

## 目录结构

```
src/index.ts              库入口
src/lib/webgl2-water-engine.ts   引擎主类（生命周期、每帧顺序、指标、公共 API）
src/lib/webgl2/           WebGL2 层：基础设施（gl-*）+ 各 pass + GLSL 模板
src/lib/*.ts              GPU 无关的 CPU 模块：谱生成、相机/uniform 打包、
                          交互、选项钳制、指标、URL 解析、浅水 CPU 参考实现
src/demo/                 演示页：main.ts、panel.ts、panel-model.ts、bridge.ts、
                          labels.ts、dom.ts、panel.css
tests/                    23 个 vitest 文件
scripts/                  Playwright：像素对比、交互回归、文档截图
docs/                     移植规格、经验教训、进度与测试说明
```

`src/lib/webgl2/index.ts` 是给外部与测试用的桶文件；**内部禁止**从它导入
（会造成循环依赖，让 GLSL 常量在 TDZ 里读到 `undefined`），这条规则由
`eslint.config.mjs` 的 `no-restricted-imports` 强制。

---

## 致谢与许可

MIT。原始 Tethys 水体研究与 Raw WebGPU 实现来自
[`inkwell-webgpu-water`](https://github.com/ly05010419/inkwell-webgpu-water)
（© James Addison，修改 © Yong Li）；本仓库是它的 WebGL2 抽取版。
移植过程中的规格与经验记录见 [`docs/`](docs/)，第三方声明见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

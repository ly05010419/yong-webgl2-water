# WebGL2 降级引擎 · 基础设施层契约（Phase A2 交付）

> **本仓库说明（yong-webgl2-water）**
>
> 本文档复制自源项目 `inkwell-webgpu-water`（commit `7dbf39c` / `7331e81`）。
> 文中所有行号与文件路径（`src/lib/webgpu-water-engine.ts`、`src/lib/create-water-engine.ts`、
> `src/lib/webgl2/ship-*.ts` 等）指向的是**源仓库**，不是本仓库。
> 本仓库只包含 WebGL2 实现，已移除 WebGPU 引擎、Three.js 适配层与船体渲染，
> 因此文中涉及「双后端对比」「船体/glTF」「React 页面」的段落仅作历史背景阅读。
> 引擎的数学、GLSL 与每帧顺序与源项目逐像素一致，本文档描述的规格依然有效。

> **行号基准（入库说明）**
>
> 本文档中的行号引用的是 `src/lib/webgpu-water-engine.ts` 等文件在 commit `7dbf39c` 时的版本
> （`git show 7dbf39c:src/lib/webgpu-water-engine.ts`）。WebGL2 移植完成后，主干源码已被重构：
> 共享的 CPU 逻辑被抽到 `src/lib/spectral-ocean.ts`、`water-math.ts`、`water-constants.ts`、
> `water-frame.ts`、`water-interaction.ts`、`water-lab-types.ts`、`water-metrics.ts`，
> 因此这里的行号已不再与工作树一致。核对时请检出该 commit，或以符号名（函数名 / 常量名）为准。
>
> 文中的 `engine:NNNN` 是 `src/lib/webgpu-water-engine.ts@7dbf39c:NNNN` 的简写；
> 源码注释里出现的 `文件名@7dbf39c:行号` 也是同一含义。
> 本文档从实现期的临时目录入库到 `docs/webgl2-port/` 时，文件内的绝对路径已改写为仓库相对路径，
> 交叉引用改为 `docs/webgl2-port/spec-engine.md` / `spec-compute.md` / `contract.md`。


> 适用对象：并行实现谱 FFT / 浅水模拟 / 渲染着色器 / 船体的 4 个 agent，以及最终组装 `WebGl2WaterEngine` 的集成 agent。
> 事实来源优先级：`docs/webgl2-port/spec-engine.md`、`docs/webgl2-port/spec-compute.md`（含冻结源码行号）> 本文 > 你的直觉。本文只规定**怎么用基础设施层**和**移植约定**，不复述算法。
> 代码位置：`src/lib/webgl2/`。所有基础设施函数都已 `tsc --strict` + `eslint` 通过，`tests/webgl2-shared-glsl.test.ts` 覆盖纯函数与 GLSL 文本。

---

## 0. 目录结构

```
src/lib/webgl2/
├── types.ts              共享类型：GlTexture / GlSampler / GlFramebuffer / GlProgram / GlUniformBuffer /
│                         GlLimits / WaterGlContext / GlPass / PingPongTargets / GpuTimer / ExtDisjointTimerQueryWebgl2
├── gl-context.ts         createWaterGlContext · onContextLost · checkGlError · 错误文案常量
├── gl-program.ts         composeShaderSource(纯函数) · createGlProgram · uniformLocations · bindUniformBlock · assignSamplerUnits
├── gl-texture.ts         createTexture2D · uploadTexture2D · createGlSampler · bindTextureUnit · unbindTextureUnit · dispose*
├── gl-framebuffer.ts     createGlFramebuffer(MRT) · bindFramebufferForDraw · clearFramebufferToZero · createPingPongTargets · blitFramebuffer
├── gl-geometry.ts        FULLSCREEN_TRIANGLE_VERTEX_GLSL · createEmptyVao/bindVao · drawFullscreenTriangle · drawProcedural
├── gl-uniform-buffer.ts  WORLD_UNIFORMS_BINDING(=0) · WORLD_UNIFORM_BYTES(=256) · createUniformBuffer · updateUniformBuffer · bindUniformBufferBase
├── gl-timer.ts           createGpuTimer（EXT_disjoint_timer_query_webgl2，缺失时全 no-op）
├── gl-state.ts           SKY_STATE / OPAQUE_STATE / WATER_STATE / COMPUTE_STATE · applyRenderState
├── shared-glsl.ts        WORLD_UNIFORMS_GLSL · COLOR_GLSL · SKY_GLSL · AERIAL_GLSL · TERRAIN_HEIGHT_GLSL · WORLD_SHADING_GLSL
└── index.ts              桶导出（pass 模块**必须直接 import 兄弟模块**，由 eslint `no-restricted-imports` 强制：
                          从桶回导会让模块图成环，pass 在 GLSL 常量初始化前被求值（TDZ）。
                          桶只供测试与外部消费者使用）
```

**建议的后续文件（每个 agent 一个或多个，200-400 行/文件）：**

| agent | 文件 | 导出工厂 |
|---|---|---|
| 谱 FFT | `src/lib/webgl2/spectral-passes.ts`（+ `spectral-glsl.ts`） | `createSpectralOceanPasses(ctx, deps)` |
| 浅水模拟 | `src/lib/webgl2/simulation-pass.ts`、`terrain-pass.ts`、`breaker-pass.ts`（+ 各自 `-glsl.ts`） | `createTerrainFieldPass` / `createSimulationPass` / `createBreakerEventPass` |
| 渲染 | `src/lib/webgl2/render-passes.ts`（+ `sky-glsl.ts` / `terrain-render-glsl.ts` / `water-glsl.ts`） | `createSkyPass` / `createTerrainRenderPass` / `createWaterPass` / `createPresentPass` |
| 船体 | `src/lib/webgl2/ship-gl.ts`（+ `ship-glsl.ts`） | `createGlShipRenderer(ctx, model, …)` |
| 集成 | `src/lib/webgl2-water-engine.ts`（在 `src/lib/` 根） | `class WebGl2WaterEngine`（公共 API 与 `WebGpuWaterEngine` 逐一同名） |

---

## 1. 类型（`types.ts`）

```ts
type GlTextureFormat = "rgba16f" | "rgba32f" | "rgba8" | "srgb8a8" | "depth24";
type GlFilter = "linear" | "nearest";
type GlWrap = "clamp" | "repeat";
type GlShaderStage = "vertex" | "fragment";

interface GlTexture      { label; handle: WebGLTexture; width; height; format: GlTextureFormat; filterable: boolean }
interface GlSampler      { label; handle: WebGLSampler; wrap: GlWrap; filter: GlFilter }
interface GlFramebuffer  { label; handle: WebGLFramebuffer; width; height; color: readonly GlTexture[]; depth: GlTexture | null }
interface GlProgram      { label; handle: WebGLProgram }
interface GlUniformBuffer{ label; handle: WebGLBuffer; byteLength }
interface GlLimits       { maxTextureSize; maxColorAttachments; maxDrawBuffers; maxTextureImageUnits; maxVertexTextureImageUnits;
                           maxCombinedTextureImageUnits; maxUniformBufferBindings; maxUniformBlockSize; maxRenderbufferSize;
                           maxViewportWidth; maxViewportHeight; floatLinearFilter: boolean; colorBufferFloat: boolean }
interface WaterGlContext { gl: WebGL2RenderingContext; canvas; adapterLabel: string; timerQuery: ExtDisjointTimerQueryWebgl2 | null; limits: GlLimits }
interface GlPass         { dispose(): void }
interface PingPongTargets{ label; width; height; targets: readonly [GlFramebuffer, GlFramebuffer];
                           index(): 0|1; at(i: 0|1): GlFramebuffer; source(): GlFramebuffer; destination(): GlFramebuffer;
                           swap(): void; reset(): void; dispose(): void }
interface GpuTimer       { label; supported: boolean; begin(); end(); poll(): number | null; pending(): number; dispose() }
```

所有工厂返回 `Object.freeze` 的记录；**唯一带内部可变状态**的是 `PingPongTargets` 的游标（`index/swap/reset`）与 `GpuTimer` 的查询队列，都已封装并注释。

---

## 2. 基础设施 API 精确签名与用法

### 2.1 `gl-context.ts`

```ts
const WATER_GL_CONTEXT_ATTRIBUTES: Readonly<WebGLContextAttributes>;   // alpha:false antialias:false depth:true stencil:false premultipliedAlpha:false powerPreference:"high-performance" preserveDrawingBuffer:false
const GL_UNSUPPORTED_MESSAGE: string;     // 「当前浏览器不支持 WebGL2。请使用较新版本的浏览器，并确保已启用硬件加速。」
const GL_FLOAT_TARGET_MESSAGE: string;    // 两个 color-buffer 浮点扩展都缺失时的说明
function createWaterGlContext(canvas: HTMLCanvasElement): WaterGlContext;   // 抛中文错误
function onContextLost(canvas, callback: (event: Event) => void, options?: { allowRestore?: boolean }): () => void;
const GL_DEBUG_CHECKS_ENABLED: boolean;   // NODE_ENV !== "production"
function checkGlError(gl, label: string, enabled?: boolean): void;   // 仅 dev；抛「WebGL2 错误（label）：INVALID_OPERATION」
```

- `createWaterGlContext` 会：取 context（失败/画布已被别的 context 占用 → 抛）；**必检** `EXT_color_buffer_float` 或 `EXT_color_buffer_half_float`（二者其一即可，两个都没有才抛 `GL_FLOAT_TARGET_MESSAGE`；只拿到后者时 `limits.colorBufferFloat = false`，`rgba32f` 不可渲染，船体变换目标降为 `rgba16f`）；可选 `OES_texture_float_linear`（记录到 `limits.floatLinearFilter`）、`EXT_disjoint_timer_query_webgl2`（`ctx.timerQuery`）、`WEBGL_debug_renderer_info`（不可用回退 `gl.RENDERER`）；校验 `MAX_TEXTURE_SIZE ≥ 513`、`MAX_DRAW_BUFFERS ≥ 2`、顶点/片元纹理单元 ≥ 12。
- `depth: true` 自 F-19 起：open 场景把天空 / 地形 / 船体 / 水面直接画到默认帧缓冲，需要画布自带深度。
  但这只是**偏好**，实现可以给任意精度：`createWaterGlContext` 取到上下文后立刻读 `DEPTH_BITS`
  （此刻绑定的一定是默认帧缓冲）→ `limits.defaultDepthBits`，并派生
  `limits.defaultFramebufferDepth = defaultDepthBits >= 24`。低于 24 位**不报错**，
  而是让 open 回退到 §3.5 的离屏路径（离屏深度是 `depth24`，更浅的默认缓冲会改变轮廓处的深度 tie-break）。
  驱动拒答该查询（`DEPTH_BITS` 在 ES 3.0 属遗留查询）一律记 0 位，同样走回退。
- `adapterLabel` 形如 `"WebGL2 · ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)"`；直接写入 `WaterLabMetrics.adapter`。
- 引擎里：`const off = onContextLost(canvas, () => this.fail("WebGL2 上下文已丢失。"))`，`dispose()` 时调用 `off()`。**画布只能取一次 context**：降级分流必须在 `getContext("webgpu")` 之前决定（spec-engine §6.3）。

### 2.2 `gl-program.ts`

```ts
type ShaderDefines = Readonly<Record<string, string | number>>;
interface GlProgramSource { label: string; vertexSource: string; fragmentSource: string; defines?: ShaderDefines }
const GLSL_VERSION_LINE = "#version 300 es";
const GLSL_PRECISION_PREAMBLE = "precision highp float;\nprecision highp int;\nprecision highp sampler2D;";
function composeShaderSource(stage: GlShaderStage, body: string, defines?: ShaderDefines): string;   // 纯函数
function preambleLineCount(defines?: ShaderDefines): number;                                       // 驱动行号 - 该值 = body 行号
function createGlProgram(gl, source: GlProgramSource): GlProgram;
function deleteGlProgram(gl, program: GlProgram): void;
function uniformLocations<const N extends readonly string[]>(gl, program, names: N): Readonly<Record<N[number], WebGLUniformLocation | null>>;
function bindUniformBlock(gl, program, blockName: string, bindingIndex: number, expectedByteLength?: number): void;
function assignSamplerUnits<const N extends readonly string[]>(gl, program, samplerNames: N): Readonly<Record<N[number], number>>;
```

- 你写的着色器是 **body**：不写 `#version`、不写 `precision`（否则抛错）。`#define` 会插在 `#version` 之后、精度之前，所以 body 里可以 `#ifdef REFERENCE_MODE`/`#if REFERENCE_MODE == 1`。数字 define 原样字符串化：`{ REFERENCE_MODE: 1 }` → `#define REFERENCE_MODE 1`；需要 float 请传 `"1.0"`。
- 不要在 body 里放 `#extension`（fwidth/dFdx 在 ES 3.00 是核心功能，不需要）。
- 编译失败的错误信息含 label、stage、驱动日志、出错行 ±2 行源码摘录。
- `bindUniformBlock(gl, p, "WorldUniforms", WORLD_UNIFORMS_BINDING, WORLD_UNIFORM_BYTES)` —— 第 5 个参数会核对 std140 大小，写错字段顺序立刻抛错。block 未被着色器实际读取时会被优化掉 → `INVALID_INDEX` → 抛错；此时你要么删掉绑定调用，要么确认着色器确实要读它。
- `assignSamplerUnits(gl, p, ["terrainField", "waterState", …])`：按数组顺序绑到单元 0..n-1 并返回映射；被优化掉的采样器仍占位，保证同一 pass 的两个变体（optimized/reference）单元号一致。**副作用：`useProgram(p)`**。

```ts
// 典型 pass 初始化
const program = createGlProgram(gl, { label: "water · optimized", vertexSource: WATER_VERTEX_GLSL, fragmentSource: WATER_FRAGMENT_GLSL, defines: { REFERENCE_MODE: 0 } });
bindUniformBlock(gl, program, "WorldUniforms", WORLD_UNIFORMS_BINDING, WORLD_UNIFORM_BYTES);
const units = assignSamplerUnits(gl, program, ["terrainField", "waterState", "longField0", "longField1", "mediumField0", "mediumField1", "shortField0", "shortField1", "breakerEvents", "sceneColorTexture", "sceneDepthTexture"] as const);
const uniforms = uniformLocations(gl, program, ["uTerrainDims"] as const);
```

### 2.3 `gl-texture.ts`

```ts
interface CreateTexture2DOptions { label; width; height; format: GlTextureFormat; data?: ArrayBufferView | ImageBitmap | null; minFilter?: GlFilter; magFilter?: GlFilter; wrap?: GlWrap }
function createTexture2D(gl, options): GlTexture;      // texStorage2D 1 级；默认 rgba32f/depth24 → nearest，其它 → linear；默认 clamp
function uploadTexture2D(gl, texture, data: ArrayBufferView | ImageBitmap, region?: { x?; y?; width?; height? }): void;   // ≈ queue.writeTexture
interface CreateSamplerOptions { label?: string; wrap: GlWrap; filter: GlFilter }
function createGlSampler(gl, options): GlSampler;
function bindTextureUnit(gl, unit: number, texture: GlTexture, sampler?: GlSampler | null): void;   // activeTexture + bindTexture + bindSampler
function unbindTextureUnit(gl, unit: number): void;
function disposeTexture(gl, texture): void;  function disposeSampler(gl, sampler): void;
function textureFormatInfo(format): TextureFormatInfo;   // 纯函数：internalFormat/format/type/bytesPerTexel/isDepth/filterableByDefault/needsFloatColorBuffer
```

- 上传数据类型：`Float32Array` → rgba16f（驱动转半精度）/rgba32f；`Uint16Array`（IEEE half）→ rgba16f；`Uint8Array` / `ImageBitmap` → rgba8 / srgb8a8；depth24 不能上传。长度不足、格式不匹配、区域越界都抛错。
- 上传前会固定 `UNPACK_FLIP_Y_WEBGL=false`、`UNPACK_PREMULTIPLY_ALPHA_WEBGL=false`、`UNPACK_COLORSPACE_CONVERSION_WEBGL=NONE`、`UNPACK_ALIGNMENT=4`。船体贴图请 `createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" })`。
- **RGBA32F 只允许 NEAREST**（除非 `limits.floatLinearFilter`）。`createTexture2D` 与 `bindTextureUnit` 都会校验：linear 采样器 + 不可过滤纹理 → 抛错。谱输入（twiddle / initial / waveData）与船体 transform 纹理只用 `texelFetch`，绑定时传 `sampler = null` 即可。
- **Sampler Object 解耦**（spec-compute R16）：引擎创建且只创建两个采样器并注入各 pass：
  `fieldSampler = createGlSampler(gl, { label: "fieldSampler", wrap: "clamp", filter: "linear" })`、
  `spectrumSampler = createGlSampler(gl, { label: "spectrumSampler", wrap: "repeat", filter: "linear" })`。
  同一张纹理可在不同 pass 用不同采样器（engine:541 泡沫回溯用 repeat 采 waterState、engine:957 用 clamp）。**永远不要**在创建后对共享纹理调用 `texParameteri`。

### 2.4 `gl-framebuffer.ts`

```ts
interface CreateFramebufferOptions { label; color: readonly GlTexture[]; depth?: GlTexture | null }
function createGlFramebuffer(gl, options): GlFramebuffer;      // MRT：color[i] → COLOR_ATTACHMENT0+i，自动 drawBuffers；不完整抛中文错误；创建后保持绑定
function bindFramebufferForDraw(gl, fbo: GlFramebuffer | null, width?: number, height?: number): void;   // null = 默认帧缓冲；顺带 viewport
function clearFramebufferToZero(gl, fbo): void;                  // 每个颜色附件 clearBufferfv(0,0,0,0)，深度 1
function disposeFramebuffer(gl, fbo, disposeAttachments = true): void;
interface PingPongOptions { label; width; height; formats: readonly GlTextureFormat[]; minFilter?; magFilter?; wrap?; clearToZero?: boolean /* 默认 true */ }
function createPingPongTargets(gl, options): PingPongTargets;
type BlitMask = "color" | "depth" | "color+depth";
interface BlitOptions { source: GlFramebuffer; destination: GlFramebuffer | null; mask: BlitMask; destinationWidth?; destinationHeight?; filter?: GlFilter }
function blitFramebuffer(gl, options): void;                    // 深度 blit 强制 NEAREST 且两侧格式相同；目标为 null 时不能含深度
```

- **零初始化（R18）**：`waterTextures[2]`、`breakerEventTextures[2]`、`spectralFields[3][2][2]` 共 16 张必须清零。用 `createPingPongTargets`（默认清零）就自动满足；自己 `createGlFramebuffer` 的目标请显式 `clearFramebufferToZero`。
- `PingPongTargets` 语义：`source()` = **上一趟已完成的结果**（读它的 `color[i]`），`destination()` = 下一趟的渲染目标，画完 `swap()`。FFT 建议用确定式 `at(pass % 2)` / `at(1 - pass % 2)`，最后一趟（pass 13）落在 `at(0)`，与 WebGPU 一致；`reset()` 把游标归零（`allocateFields()` 后调用）。
- MRT 片元输出：`layout(location = 0) out vec4 outField0; layout(location = 1) out vec4 outField1;`。
- 同一张纹理**不能既是当前 FBO 附件又被当前程序采样**（反馈回路，R4）。规则：`bindFramebufferForDraw(dst)` 之前，把上一 pass 中把 dst 附件绑到过的单元 `unbindTextureUnit`，或直接用本 pass 的输入覆盖那些单元（`bindTextureUnit` 覆盖即可）。因为每个 pass 都完整重绑自己的所有单元，一般只需保证「本 pass 输入里没有 dst 的附件」。

### 2.5 `gl-geometry.ts`

```ts
const FULLSCREEN_TRIANGLE_VERTEX_GLSL: string;   // out vec2 vNdc; out vec2 vUv;  vUv = ndc*0.5+0.5（GL 左下原点）；可 define FULLSCREEN_Z
const FULLSCREEN_TRIANGLE_VERTEX_COUNT = 3;
function createEmptyVao(gl): WebGLVertexArrayObject;   function bindVao(gl, vao | null): void;   function disposeVao(gl, vao): void;
function drawFullscreenTriangle(gl): void;               // drawArrays(TRIANGLES, 0, 3)
function drawProcedural(gl, vertexCount: number, instanceCount = 1): void;   // 1 → drawArrays；>1 → drawArraysInstanced
```

- **程序化绘制必须绑定一个非默认 VAO**：引擎在 init 里 `vao = createEmptyVao(gl); bindVao(gl, vao)`，此后所有无 VBO 的 pass 直接 draw。船体有自己的 VAO，画完必须 `bindVao(gl, engineVao)` 归还。
- 全屏三角形顶点：`gl_VertexID` 0/1/2 → NDC (-1,-1)/(3,-1)/(-1,3)。GPGPU pass 一律用这个 VS + `drawFullscreenTriangle`。

### 2.6 `gl-uniform-buffer.ts`

```ts
const WORLD_UNIFORMS_BINDING = 0;   const WORLD_UNIFORM_BYTES = 256;
function createUniformBuffer(gl, byteLength: number, label: string): GlUniformBuffer;   // 16 的倍数，DYNAMIC_DRAW，零填充
function updateUniformBuffer(gl, buffer, data: ArrayBufferView, byteOffset = 0): void;  // bufferSubData，越界抛错
function bindUniformBufferBase(gl, index: number, buffer): void;                        // bindBufferBase(UNIFORM_BUFFER, index, …)
function disposeUniformBuffer(gl, buffer): void;
```

**UBO 绑定点约定（全局，不是 per-program）：**

| index | block 名（GLSL） | 字节 | 拥有者 |
|---|---|---|---|
| **0** | `WorldUniforms`（`} uniforms;`） | 256 | 引擎每帧 `updateUniformBuffer(worldUbo, packWorldUniforms(...))`，init 时 `bindUniformBufferBase(gl, 0, worldUbo)` 一次 |
| 1 | `SimulationParams`（`vec4 impulse; vec4 stepFoamShift;`） | 32 | 模拟 pass；impulse / calm 两个缓冲轮流 `bindUniformBufferBase(gl, 1, …)` |
| 2 | `ShipPlacement`（vec4） | 16 | 船体 |
| 3 | `ShipHullSpan`（vec4） | 16 | 船体 |
| 4 | `ShipMaterial`（vec4：alphaCutoff, isMask, metallic, roughness） | 16 | 船体（每 primitive 切换缓冲） |
| — | FFT 的 `axis/stage/size/finalize` | — | **不用 UBO**：axis 分成两个 program（`#define FFT_AXIS 0/1`），`stage`/`finalize` 用 `uniform int`（spec-compute R9） |

### 2.7 `gl-timer.ts`

```ts
function createGpuTimer(gl, extension: ExtDisjointTimerQueryWebgl2 | null, label: string): GpuTimer;
```
引擎：`simTimer = createGpuTimer(gl, ctx.timerQuery, "simulation")`、`renderTimer = …("render")`。每帧 `simTimer.begin()` … 所有 GPGPU pass … `simTimer.end()`；`renderTimer.begin()` … 场景 + 水 + present … `renderTimer.end()`；帧末 `const ms = simTimer.poll()`（null 表示还没好或不支持）。**两个计时区间不能重叠**（同一时刻只能有一个 TIME_ELAPSED 查询）。不支持时 `supported=false`，`WaterLabMetrics.gpu*Ms` 返回 `null`，`gpuTimestampSamples` 为 0（benchmark 脚本的等待条件需要另行处理，见 spec-engine §7.4）。

### 2.8 `gl-state.ts`

```ts
const SKY_STATE     // depthTest on, write off, ALWAYS, no blend        ← sky
const OPAQUE_STATE  // depthTest on, write on,  LESS,   no blend        ← terrain, ship
const WATER_STATE   // depthTest on, write off, LESS,   blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA)  ← water, breaker patch
const COMPUTE_STATE // depthTest off, no blend                          ← 所有 GPGPU pass、blit
function applyRenderState(gl, preset): void;   // 同时 disable CULL_FACE / SCISSOR_TEST，colorMask 全开
```
每个 pass 的 `run()` 开头调用一次；不要假设上一个 pass 留下的状态。

### 2.9 `shared-glsl.ts`

| 常量 | 内容 | 对应冻结 WGSL |
|---|---|---|
| `WORLD_UNIFORMS_GLSL` | `layout(std140) uniform WorldUniforms { mat4 viewProj; vec4 cameraTime; … vec4 atmosphere; } uniforms;` | shared-wgsl.ts:6-31 |
| `WORLD_UNIFORM_FIELDS` | 13 个字段名（声明顺序） | 同上 |
| `COLOR_GLSL` | `vec3 linearToSrgb(vec3)`、`vec3 aces(vec3)` | shared-wgsl.ts:33-40 |
| `SKY_GLSL` | `float cloudHash3(vec3)`、`float cloudNoise3(vec3)`、`vec3 skyColor(vec3 direction, float time, vec3 sunDirection)` | shared-wgsl.ts:42-90 |
| `AERIAL_GLSL` | `vec3 tethysAerialColor(vec3 color, vec3 world, vec3 cameraPos, float worldScale, bool underwater, float dryLand)`，内部读 `uniforms.atmosphere.x` → 前面必须有 `WORLD_UNIFORMS_GLSL` | shared-wgsl.ts:93-118 |
| `TERRAIN_HEIGHT_GLSL` | `hash21`、`valueNoise`、`tethysCoastalShelf`、`terrainHeight(vec2 p, float shoreMix)`（已按声明先后重排；字面量 2.02/3.95 由 `TETHYS_WATER_LEVEL` 内插） | engine:220-323 |
| `WORLD_SHADING_GLSL` | `WORLD_UNIFORMS_GLSL + COLOR_GLSL + SKY_GLSL + AERIAL_GLSL` | — |

拼接示例（顺序 = 依赖顺序）：
```ts
const TERRAIN_FIELD_FRAGMENT = /* glsl */ `
${WORLD_UNIFORMS_GLSL}
${TERRAIN_HEIGHT_GLSL}
uniform ivec2 uFieldDims;            // = (513, 513)，替代 textureDimensions(fieldOut)
layout(location = 0) out vec4 outField;
void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec2 dims = vec2(uFieldDims);
  vec2 uv = vec2(id) / (dims - 1.0);
  …
}`;
```
`WORLD_UNIFORMS_GLSL` 在顶点和片元着色器里都可以各写一份（同一 block 名 + 同一 layout 即可共享 binding）。

---

## 3. 全局约定（所有 pass 模块必须遵守）

### 3.1 模块形状

```ts
export interface XxxPass extends GlPass {
  run(gl: WebGL2RenderingContext, input: XxxRunInput): void;   // 输入纹理 / UBO / 目标全部作为参数传入
}
export function createXxxPass(ctx: WaterGlContext, deps: XxxDeps): XxxPass;
```
- 构造期（`createXxx`）：编译 program、`bindUniformBlock`、`assignSamplerUnits`、缓存 `uniformLocations`、创建**本 pass 私有**的资源。
- 运行期（`run`）：`applyRenderState` → `useProgram` → `bindFramebufferForDraw(target)` → 逐单元 `bindTextureUnit` → 设 per-draw uniform → draw。**不要**在模块级持有纹理/FBO 的全局单例；被多个 pass 共享的纹理（terrain、waterState、spectralFields、samplers、worldUbo）由引擎创建并作为参数注入。
- `dispose()` 只释放自己创建的资源；顺序无关紧要但要幂等安全（调用一次）。
- 所有错误抛 `Error`（中文可读 + 上下文），引擎 `fail()` 只保留第一条。

### 3.2 纹理单元与采样器命名

- 单元号 = `assignSamplerUnits` 返回值，**按采样器名数组顺序**分配。不要手写数字。
- GLSL 采样器名与 WGSL 绑定名一致（`terrainField`、`waterState`、`longField0/1`、`mediumField0/1`、`shortField0/1`、`breakerEvents`、`sceneColorTexture`、`sceneDepthTexture`、`initialSpectrum`、`waveData`、`twiddleTable`、`input0/1`、`previousState`、`previousEvents`、`longField`、`mediumField`），这样 WGSL 的 `textureSampleLevel(longField0, spectrumSampler, uv, 0.0)` 逐字变成 `textureLod(longField0, uv, 0.0)`（去掉采样器参数；采样器由 `bindTextureUnit(gl, unit, tex, spectrumSampler)` 决定）。
- 采样状态一律通过 `GlSampler` 对象注入；`texelFetch` 用的输入绑 `null`。

### 3.3 WGSL → GLSL ES 3.00 翻译表

| WGSL | GLSL | 备注 |
|---|---|---|
| `vec3<f32>(…)` / `f32(x)` / `u32(x)` / `i32(x)` | `vec3(…)` / `float(x)` / `uint(x)` / `int(x)` | |
| `let x = …` / `var x = …` | `float x = …` / `vec2 x = …`（显式类型） | |
| `fn f(a: vec2<f32>) -> f32 {` | `float f(vec2 a) {` | **必须先声明后使用**：helper 放前面 |
| `select(f, t, cond)` | `cond ? t : f` | **参数顺序反转**（R10）；spec-compute R10 列出全部出现点 |
| `atan2(y, x)` | `atan(y, x)` | |
| `textureLoad(t, coord, 0)` | `texelFetch(t, coord, 0)` | 越界 UB：保留全部原有 clamp（R7） |
| `textureSampleLevel(t, s, uv, 0.0)` | `textureLod(t, uv, 0.0)` | 顶点着色器里只能用 `textureLod` |
| `textureSample(t, s, uv)` | `texture(t, uv)` | 仅片元 |
| `textureDimensions(t)` | `uniform ivec2 uXxxDims` | 三种用法分别复现：`dims-1`（terrain 513→512）、`terrainDims-1`（terrainAtWorld）、`dims.x`（cellSize=192/256，**不减 1**）（R8） |
| `textureStore(out, coord, v)` | `layout(location = n) out vec4 outX; outX = v;` | 多目标 → MRT，location 0/1 |
| `@builtin(global_invocation_id) id` | `ivec2 id = ivec2(gl_FragCoord.xy);` | 像素中心 +0.5，`ivec2()` 截断即 texel 索引；viewport = 目标尺寸，无需 `if (id.x >= size) return;`（保留也无害） |
| `@builtin(vertex_index)` / `@builtin(instance_index)` | `gl_VertexID` / `gl_InstanceID`（均为 `int`） | `uint(gl_VertexID) / 6u` 或直接 int 运算；clipmap `float(gl_InstanceID)` |
| `@builtin(position)` 片元读 | `gl_FragCoord` | `screenUv = gl_FragCoord.xy / max(uniforms.interaction.zw, vec2(1.0))`，**不翻转** |
| `override REFERENCE_MODE: u32` | `defines: { REFERENCE_MODE: 0/1 }` → `#if REFERENCE_MODE == 1` | 两个 program 变体 |
| `var<uniform> uniforms: WorldUniforms` | `WORLD_UNIFORMS_GLSL`（`uniforms.xxx` 拼写不变） | binding 0 |
| `var<uniform> params: SimulationParams` | `layout(std140) uniform SimulationParams { vec4 impulse; vec4 stepFoamShift; } params;` | binding 1 |
| `var<storage, read_write>`（船体 transform） | 4×2 `rgba32f` FBO + 片元写；顶点 `texelFetch(shipTransform, ivec2(col,row), 0)` | spec-compute R3 方案 A |
| `array<vec3<f32>, 2>` 返回（`hydrostaticPair`） | `struct HydrostaticPair { vec3 left; vec3 right; };` 返回 struct | R14 |
| `%` on `u32` | `int`/`uint` 的 `%` | `(id.x + id.y) % 2` |
| `fwidth / dpdx / dpdy` | `fwidth / dFdx / dFdy` | 必须在 `discard` 之前算（engine:1305 → 1311） |
| `tanh(clamp(x,-30,30))` | 同 | 保留 clamp（R15） |
| `bool` uniform | 用 `float`/`int` 传，比较得 bool | GLSL uniform 可以是 bool，但 UBO 里避免 |
| `discard;` | `discard;` | |
| `pow(x, y)` | 同 | 保持行为一致：`pow(submergedRatio, 0.35)` 不加保护（R20 已记录） |

**精度**：所有着色器顶部由 `createGlProgram` 自动加 `precision highp float; precision highp int; precision highp sampler2D;`（R19），不要再自己写。

### 3.4 坐标 / 深度 / 方向约定

| 项 | WebGPU 值 | WebGL2 值 | 说明 |
|---|---|---|---|
| 投影矩阵 | `perspective(fov, aspect, near, far)`（z ∈ [0,1]） | `perspective(fov, aspect, near, far, "minus-one-to-one")`（A1 的 `src/lib/water-math.ts`） | 其余 `lookAt/multiply/packWorldUniforms` 原样复用 |
| sky 顶点 z | 0.999999 | **0.999998**（`defines: { FULLSCREEN_Z: "0.999998" }`） | 经视口变换后窗口深度 = 0.999999，与 WebGPU 相同 |
| 天际裙边 | `clip.z = clip.w * 0.99999` | `clip.z = clip.w * 0.99998` | engine:1199 |
| `capturedDepth` 阈值 | `1.0 - step(0.9995, d)` | **不变** | 读的是深度纹理的窗口空间值 [0,1] |
| 深度范围/清除 | clear 1，compare less | `clearBufferfv(DEPTH, 0, [1])`，`LESS`，不动 `depthRange` | |
| 全屏 blit uv | `(x*0.5+0.5, 0.5 - y*0.5)` | `(x*0.5+0.5, y*0.5+0.5)`（即 `FULLSCREEN_TRIANGLE_VERTEX_GLSL` 的 `vUv`） | GL 纹理原点左下 |
| `screenUv` | `position.xy / interaction.zw` | `gl_FragCoord.xy / interaction.zw`，**不翻转** | 两侧「屏幕 y」与「纹理 v」方向各自一致 |
| 折射偏移 | `vec2(N.x, -N.z)` | **`vec2(N.x, +N.z)`** | engine:1411；`textureLoad(sceneDepth, refractionUv*dims)` 同 uv |
| texel 索引 | `id.xy` | `ivec2(gl_FragCoord.xy)` | 行 0 = 缓冲第一行，两侧一致，**上传数据不翻转** |
| 纹理上传 | `writeTexture(…, Float32Array)` | `uploadTexture2D(gl, tex, Float32Array)`（无 flip） | 128×128 谱：行长 2048 B，alignment 4 |
| 256×1 目标 | dispatch(4,1,1) | `bindFramebufferForDraw(fbo)` → viewport(0,0,256,1) + 全屏三角形，`id.x = int(gl_FragCoord.x)` | R2 |
| 颜色空间 | `bgra8unorm` + 手工 `linearToSrgb` | 离屏 `rgba8`（**非** srgb8a8）+ 手工 `linearToSrgb`；船体 baseColor 例外用 `srgb8a8` | 不存在 FRAMEBUFFER_SRGB |
| Y-up 世界坐标 | 同 | 同 | 不变 |

### 3.5 渲染目标方案（shore：离屏 + 深度副本 + 最终 blit；open：直接画画布）

WebGPU 版在 water pass 里把 `depthTexture` 同时当只读附件和采样纹理（`depthReadOnly: true` + `texture_depth_2d`），WebGL2 里这是反馈回路（spec-engine §8.1.3）。**shore 场景**因此走下述捕获路径；**open 场景**自 F-19 起直接画到默认帧缓冲（context 以 `depth: true` 创建），与 WebGPU 的 open 路径完全同构：

| 场景 / 条件 | 路径 | 每帧 FBO 绑定 | 每帧 blit |
|---|---|---:|---:|
| shore | `sceneFbo` → `blit(color+depth)` → `waterFbo` → 呈现 blit | 25 | 2 |
| open，`limits.defaultFramebufferDepth` | **直接画默认帧缓冲**，无离屏、无 blit | 21 | 0 |
| open，画布深度 < 24 位（回退） | 全部画进 `waterFbo` → 呈现 blit（F-16 原路） | 23 | 1 |

（计数为 1280×800 实测中位数，含 GPGPU 半帧的绑定。）

open 直绘的具体形状：

```
bindFramebufferForDraw(gl, null, gl.drawingBufferWidth, gl.drawingBufferHeight)
clearBufferfv(COLOR, 0, [0.18,0.45,0.49,1]); clearBufferfv(DEPTH, 0, [1])
sky(SKY_STATE) → terrain(OPAQUE_STATE) → ship(OPAQUE_STATE) → water(WATER_STATE)
（结束；水面在画布自己的深度上做只读 LESS 测试 + 直通 alpha 混合，无呈现 blit）
```

shore 的捕获路径：

```
每帧（尺寸 = gl.drawingBufferWidth × drawingBufferHeight，resize 时重建）：
  sceneFbo  = { color: [sceneColor rgba8], depth: sceneDepth depth24 }
  waterFbo  = { color: [frameColor rgba8], depth: sceneDepthCopy depth24 }

  1. bindFramebufferForDraw(sceneFbo); clearBufferfv(COLOR,0,[0.18,0.45,0.49,1]); clearBufferfv(DEPTH,0,[1])
     sky(SKY_STATE) → terrain(OPAQUE_STATE) → ship(OPAQUE_STATE)
  2. blitFramebuffer({ source: sceneFbo, destination: waterFbo, mask: "color+depth" })
     ← 同时完成 WebGPU 的 sceneBlit（shore）与深度副本；同尺寸 rgba8→rgba8 / depth24→depth24 是精确拷贝
  3. bindFramebufferForDraw(waterFbo); water(WATER_STATE)：深度测试用 sceneDepthCopy，采样 sceneColor + sceneDepth（属于未绑定的 sceneFbo → 无反馈回路）
  4. blitFramebuffer({ source: waterFbo, destination: null, mask: "color" })   ← 呈现到画布
```
- open 场景在 WebGPU 里不做捕获，水面着色器仍声明 `sceneColorTexture/sceneDepthTexture` 但 `environment.x = 0` 时不会读取；两条 open 路径下引擎都把它们绑到 1×1 占位纹理（rgba8 / depth24，由 engine-resources 持有）：回退路径上真附件正是当前绘制目标（反馈回路），直绘路径上默认帧缓冲根本不是纹理。实现见 `engine-frame.ts` 的 `renderComposite`（F-16 / F-19，两次优化前后都逐像素零差异）。
- `sceneFbo` 与 `waterFbo` 在**两个场景下都照常分配**，open 直绘时两者都闲置：`setScene()` 可在任意两帧之间翻转场景，`resize()` 只有一条与场景无关的分配路径，按场景惰性分配会让两者都长出重建分支。
- 所有 `rgba8` 目标写入的是 `linearToSrgb(aces(color))`，画布也一样（不存在 `FRAMEBUFFER_SRGB`，默认帧缓冲不做编码转换），所以 open 直绘与「离屏再 blit」写出的字节完全相同；呈现 blit 同尺寸 NEAREST，是逐字节拷贝；画布 `alpha:false`（水面混合的颜色通道不读目标 alpha，两条路径的 RGB 一致）。
- `renderScale` / 窗口尺寸变化：`canvas.width/height` 改后按 `gl.drawingBufferWidth/Height` 重建上述 4 张纹理 + 2 个 FBO（对应 engine `resize()` 2245-2262）。
- 深度纹理只做 `texelFetch(sceneDepthTexture, ivec2(clamp(...)), 0).r`，`TEXTURE_COMPARE_MODE = NONE`（`createTexture2D` 已设置），nearest。

### 3.6 GPGPU pass 通用配方

```ts
applyRenderState(gl, COMPUTE_STATE);
bindGlProgram(gl, program);                               // 而不是 gl.useProgram：走 §3.7 的状态缓存
bindFramebufferForDraw(gl, target);                       // 自动 viewport = 目标尺寸
bindTextureUnit(gl, units.previousState, waterPing.source().color[0], spectrumSampler);   // 或 null → texelFetch
bindTextureUnit(gl, units.terrainField, terrain, null);
gl.uniform2i(uniforms.uDims, target.width, target.height);
drawFullscreenTriangle(gl);
waterPing.swap();
```
- 每帧顺序（spec-compute §5，必须保序）：terrain（仅一次）→ 谱级联（atlas：1 次 evolve + 13 级堆叠 IFFT + 3 次写回）→ simulate ×(1|2) → breaker → ship transform → scene → blit（**仅 shore**，见 §3.5）→ water → present（**open 直绘时没有这一步**）。
- FFT 乒乓（atlas 布局）：一对 128×384 的 rgba16f MRT 乒乓承载三个级联，`atlas.at(pass % 2)` 读、`at(1 - pass % 2)` 写，堆叠级跑到 pass 12（写回槽 1）；**收尾的第 13 级不写 atlas**，而是分 `cascadeCount` 次 draw 从槽 1 直接写进各级联自己的 128×128 rgba16f 场纹理（linear/repeat），棋盘符号翻转就发生在这几次 draw 里。中间格式全程 `rgba16f`（R6）。
- 三个级联纵向打包成 128×384 的 atlas 是**默认路径**（1 演化 + 13 atlas 级 + 3 收尾 = 17 draw，R17）；`layout: "separate"` 是保留下来的参照实现（每级联一套 128×128 乒乓，45 draw），两者共享同一份 GLSL、逐位相同。下游一律读各级联独立的 `field0(c)` / `field1(c)`，与布局无关。

### 3.7 性能注意

- 每帧 GPGPU 部分 ≈ 17（谱级联 atlas）+ 1（浅水，reference 模式 2）+ 1（碎波）+ 1（船体 transform）次全屏 draw，另加一次性的地形场；渲染部分是 sky / terrain / ship / water 的几次几何 draw 加 1-2 次 blit。1280×800 open 场景实测每帧 26 次 draw、21 次 `bindFramebuffer`、**0 次 `blitFramebuffer`**（直绘画布，F-19；shore 为 25 / 2）。避免每次 draw 重新 `getUniformLocation`、`getExtension`、`getParameter`；全部在 `createXxx` 阶段缓存。
- `bindUniformBufferBase(0, worldUbo)` 每帧最多一次；`updateUniformBuffer` 每帧一次 256 B。
- 不要在渲染循环里调用 `gl.getError()`（`checkGlError` 默认只在 dev，且应放在 init 后而不是每帧）、`gl.finish()`、`readPixels`。
- 船体 transform 走 4×2 浮点 FBO：有 `EXT_color_buffer_float` 时是 `rgba32f`，只有 `EXT_color_buffer_half_float` 时降为 `rgba16f`（见 `transformTargetFormat`）；顶点着色器 `texelFetch` 读 8 个 texel。
- 采样器对象状态切换极便宜；`assignSamplerUnits` 让单元号静态化。
- 大量 `drawArraysInstanced(24576, 10)` 与 shore 场景 1.57M 顶点的 terrain draw 在 WebGL2 无问题，但 CPU 提交开销略高于 WebGPU；不要拆成更多 draw。

#### GL 状态缓存（`gl-state-cache.ts`）

上面这些 draw 里，重复下发的绑定占大头：atlas FFT 的 17 次 draw 反复绑同一张旋转因子表，
`COMPUTE_STATE` 在 GPGPU 半帧里连着应用 5 次，水面 pass 的两次 draw 绑的是同一批 12 张纹理。
`gl-state-cache.ts` 按 `WebGL2RenderingContext` 用 `WeakMap` 记住当前状态，只下发真正会改变
状态的调用（每帧状态调用 520 → 378，−27%；draw 数与绑定顺序一字未动）。缓存的内容是：
每个纹理单元的 `(texture, sampler)`、当前 `activeTexture` / program、**分开记的 READ / DRAW
帧缓冲**、`(fbo, x, y, w, h)` 视口、以及最后应用的 `RenderStatePreset`。

**三条不变量**（违反其一就会漏掉一次必要的绑定，症状是偶发的错纹理或反馈回路）：

1. `undefined` = **未知**，`null` = **已知未绑定**。全新缓存全是未知，所以每一类的第一次调用一定下发。
2. 相等判断一律用**对象引用**：`WebGLTexture` / `WebGLSampler` / `WebGLProgram` /
   `WebGLFramebuffer` 在上下文生命周期内是唯一的 JS 对象，`RenderStatePreset` 是冻结单例。
3. 任何在该模块之外改动这些状态的地方必须**记账或作废**，不得沉默。

因此 pass 侧的写法固定为：程序用 `bindGlProgram(gl, program)`（不是 `gl.useProgram`），
纹理用 `bindTextureUnit` / `unbindTextureUnit(s)`，目标用 `bindFramebufferForDraw`，
固定管线用 `applyRenderState` —— 这些 helper 本身已经走缓存。

**失效点**（记账或作废的具体落点）：

| 时机 | 调用 |
|---|---|
| 上下文创建后、上下文丢失、`resize()`、`allocateFields()`、`dispose()` | `invalidateGlStateCache` |
| `createTexture2D` / `uploadTexture2D` 在**当前活动单元**上的裸 `gl.bindTexture` | `noteActiveUnitTextureBinding`（活动单元未知时保守清空所有已记录的纹理绑定） |
| `clearFramebufferToZero` 与 `engine-frame.ts` 的场景清屏（钉 `depthMask` / `colorMask` / `disable(SCISSOR)`） | `invalidateRenderStateCache` |
| 删除 GL 对象（WebGL 会替我们解绑）：`disposeTexture` / `disposeSampler` / `deleteGlProgram` / `disposeFramebuffer` / `deleteFramebufferHandle` | `forgetGlTexture` / `forgetGlSampler` / `forgetGlProgram` / `forgetGlFramebuffer` |

开发期保险在 `gl-state-cache-verify.ts`：`verifyGlStateCache(gl, label)` 把每一项**已知**的缓存
与 `gl.getParameter` / `gl.isEnabled` 的实际状态逐条比对，不一致抛中文错误；
`verifyGlStateCacheAfterInvalidation(gl, label)` 在每次 `invalidateGlStateCache` 之后补一次同样的比对。
两者都由 `GL_DEBUG_CHECKS_ENABLED` 控制（production 为 false）——`getParameter` 会同步阻塞管线，
**不要**在发布构建的帧循环里调用。

### 3.8 测试落点

- node 下只能测纯函数与 GLSL 文本：每个 agent 为自己的 `-glsl.ts` 写 `tests/webgl2-<module>.test.ts`，至少断言：函数/`out` 变量名存在、MRT `layout(location = 1)` 存在（若适用）、无 WGSL 残留（`vec3<f32>`、`select(`、`textureSampleLevel`、`@builtin`、`fn `、`atan2(`）、`composeShaderSource("fragment", body)` 不抛错、硬编码字面量（1.18/1.05/0.40/12.0/9.81/0.035/0.018/2.02/3.95）存在。
- 数值对拍继续用 `src/lib/nearshore-reference.ts` 的 CPU 镜像模式；集成 agent 增加 `tests/webgl2-engine-api.test.ts` 比较两引擎 `prototype` 方法名集合。
- 真机验证用 `scripts/visual-gate.mjs` 把 `["reference","optimized"]` 换成两个后端的 URL 参数做逐像素对拍。

---

## 4. 引擎级装配示例（供集成 agent，也是各 pass 的用法上下文）

```ts
import {
  COMPUTE_STATE, WORLD_UNIFORMS_BINDING, WORLD_UNIFORM_BYTES, applyRenderState, bindUniformBufferBase, bindVao,
  createEmptyVao, createGlSampler, createGpuTimer, createPingPongTargets, createTexture2D, createUniformBuffer,
  createWaterGlContext, onContextLost, updateUniformBuffer,
} from "./webgl2";

const ctx = createWaterGlContext(canvas);                       // 抛中文错误 → init() 直接 throw
const { gl } = ctx;
const offLost = onContextLost(canvas, () => this.fail("WebGL2 上下文已丢失。"));
const vao = createEmptyVao(gl); bindVao(gl, vao);
const worldUbo = createUniformBuffer(gl, WORLD_UNIFORM_BYTES, "WorldUniforms");
bindUniformBufferBase(gl, WORLD_UNIFORMS_BINDING, worldUbo);
const fieldSampler = createGlSampler(gl, { label: "fieldSampler", wrap: "clamp", filter: "linear" });
const spectrumSampler = createGlSampler(gl, { label: "spectrumSampler", wrap: "repeat", filter: "linear" });

// allocateFields() 对应物
const terrain = createTexture2D(gl, { label: "terrainField", width: 513, height: 513, format: "rgba16f" });   // 由 terrain pass 的 FBO 写一次
const water = createPingPongTargets(gl, { label: "waterState", width: sim, height: sim, formats: ["rgba16f"] });   // 已清零
const breaker = createPingPongTargets(gl, { label: "breakerEvents", width: 256, height: 1, formats: ["rgba16f"] });
const twiddle = createTexture2D(gl, { label: "twiddle", width: 128, height: 7, format: "rgba32f", data: buildSpectralTwiddleTable(128, 7) });   // nearest
const cascades = [0, 1, 2].map((c) => ({
  initial: createTexture2D(gl, { label: `initial${c}`, width: 128, height: 128, format: "rgba32f", data: ocean[c].initialSpectrum }),
  waveData: createTexture2D(gl, { label: `waveData${c}`, width: 128, height: 128, format: "rgba32f", data: ocean[c].waveData }),
  fields: createPingPongTargets(gl, { label: `spectralFields${c}`, width: 128, height: 128, formats: ["rgba16f", "rgba16f"], wrap: "repeat" }),
}));

// 每帧
updateUniformBuffer(gl, worldUbo, packWorldUniforms({ … projection: perspective(fov, aspect, near, far, "minus-one-to-one") … }));
simTimer.begin();
applyRenderState(gl, COMPUTE_STATE);
spectral.run(gl, { cascades });                     // evolve + 14 IFFT × 3 → cascades[c].fields.at(0)
simulation.run(gl, { water, terrain, long: cascades[0].fields.at(0), medium: cascades[1].fields.at(0), params: impulseUbo });   // 内部 swap
…
simTimer.end();
```

---

## 5. 快速核对清单（每个 pass 交付前自查）

1. 着色器 body 无 `#version` / `precision`；通过 `createGlProgram` 编译；label 唯一可读。
2. `bindUniformBlock(..., "WorldUniforms", 0, 256)`；其它 block 按 §2.6 表分配。
3. 采样器名与 WGSL 绑定名一致；单元号来自 `assignSamplerUnits`；`rgba32f` 输入绑 `null` 采样器 + `texelFetch`。
4. 目标 FBO 用 `bindFramebufferForDraw`（viewport 自动）；输入里没有目标附件；乒乓用 `PingPongTargets`。
5. 新建的乒乓/状态纹理已零初始化。
6. `select` 顺序、`textureDimensions` 三种变体、`hydrostaticPair` struct、`tanh` clamp、`fwidth` 在 `discard` 前。
7. 深度：投影 `minus-one-to-one`、sky z 0.999998、裙边 0.99998、`capturedDepth` 阈值不变、折射偏移 `+N.z`。
8. `applyRenderState` 在每个 `run()` 开头；船体画完 `bindVao(gl, engineVao)`。
9. `dispose()` 释放本模块创建的全部 GL 对象；错误信息中文 + 上下文。
10. `tests/webgl2-<module>.test.ts` 覆盖 GLSL 文本；`npm run lint && npm test && npx tsc --noEmit -p tsconfig.json` 通过。

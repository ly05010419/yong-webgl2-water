# Tethys 水面引擎 · 计算管线规格（WebGPU → WebGL2 移植基准）

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


参考源码：
- `src/lib/webgpu-water-engine.ts`（2548 行）
- `src/lib/shared-wgsl.ts`（118 行）
- `src/lib/water-profiles.ts`（24 行）
- `src/lib/ship-shaders.ts`、`ship-renderer.ts`（船体 compute）
- 交叉验证参考：`src/three/spectral-waves.ts`（同算法的 Three.js TSL 版，行 335-409，可作为第二实现来源）

---

## 1. 全部常量清单

### 1.1 分辨率

| 常量 | 值 | 源码 | 说明 |
|---|---|---|---|
| `TERRAIN_FIELD_RESOLUTION` | 512 | engine:160 | 地形场逻辑分辨率 |
| 地形纹理实际尺寸 | 513 × 513 | engine:1988-1989 (`TERRAIN_FIELD_RESOLUTION + 1`) | 顶点栅格需要 N+1 采样点 |
| `SPECTRAL_RESOLUTION` | 128 | engine:165 | 每个谱级联的 FFT 网格 |
| `SPECTRAL_LOG_SIZE` | 7 | engine:166 | log2(128)，即每轴 FFT 级数 |
| `BREAKER_EVENT_RESOLUTION` | 256 | engine:169 | breaker 事件历史，1D（256×1 纹理） |
| `BREAKER_PATCH_ALONG_RESOLUTION` | 256 | engine:167 | 碎浪补丁沿脊方向网格（仅渲染） |
| `BREAKER_PATCH_ACROSS_RESOLUTION` | 48 | engine:168 | 碎浪补丁横向网格（仅渲染） |
| `BREAKER_PATCH_TRIANGLES` | 256×48×2 = 24576 | engine:170 | |
| `WATER_CLIPMAP_RESOLUTION` | 64 | engine:187 | 水面 clipmap 每环网格 |
| `WATER_CLIPMAP_LEVELS` | 10 | engine:198 | 环数，最远 32·2⁹ = 16384 m |
| 模拟分辨率（可变） | `clamp(floor(opt), 64, 512)`，默认 256 | engine:1990-1991；默认见 engine:48 / water-profiles:10,13 | profile "dense" = 384（water-profiles:14） |
| `TETHYS_REFERENCE_SIMULATION_RESOLUTION` | 256 | water-profiles:10 | |
| 网格分辨率 `meshResolution` | 默认 240，`clamp(96,320)` | engine:43, engine:2129 | shore 场景强制 512（engine:2312, 2404） |

### 1.2 级联数量与配置

`SPECTRAL_CASCADES`，共 **3 个级联**，engine:209-215：

```
[0] long   : lengthScale=240, cutoffLow=0.024, cutoffHigh=0.36,  amplitudeScale=0.45, choppiness=1.18, secondaryScale=0.22, seed=0x51f15e
[1] medium : lengthScale=64,  cutoffLow=0.30,  cutoffHigh=1.42,  amplitudeScale=0.45, choppiness=1.05, secondaryScale=0.08, seed=0x72a93b
[2] short  : lengthScale=12,  cutoffLow=1.22,  cutoffHigh=24.0,  amplitudeScale=0.82, choppiness=0.40, secondaryScale=0,    seed=0x19ce47
```

- 级联 0/1 的 `lengthScale` 是**运行期可变的**，由 `this.cascadeScale(index)` 覆盖（engine:2146-2150），取值来自 `options.longCascadeScale` / `mediumCascadeScale`（默认 240 / 64，engine:50-51）。范围：`LONG_SCALE_RANGE = [80, 480]`（engine:135）、`MEDIUM_SCALE_RANGE = [24, 128]`（engine:136）。
- 级联 2 的 12.0 m 是**编译期字面量**，被 `.toFixed(1)` 内联进 shader 字符串（engine:862, 1315, 1332）。
- `choppiness` 同样是编译期内联字面量：`"1.18"`, `"1.05"`, `"0.40"`（engine:410-411, 610-611, 867-870, 1087-1097, 1365-1367, 1488-1489）。**移植时必须硬编码，不能做 uniform**（除非同时改所有引用点）。

### 1.3 Workgroup 尺寸与 dispatch

| 管线 | workgroup_size | dispatch | 源码 |
|---|---|---|---|
| terrain field | `@workgroup_size(16,16)` | `ceil(513/16)=33` × 33 | engine:331 / engine:2355 |
| water simulation | `@workgroup_size(16,16)` | `ceil(simRes/16)` × 同 （256→16×16） | engine:480 / engine:2377-2378 |
| breaker event | `@workgroup_size(64,1)` | `ceil(256/64)=4`（1D） | engine:582 / engine:2387 |
| spectrum evolution | `@workgroup_size(8,8)` | `ceil(128/8)=16` × 16 | engine:646 / engine:2364, 2368 |
| spectral IFFT | `@workgroup_size(8,8)` | 16 × 16 | engine:696 / engine:2372 |
| ship updateTransform | `@workgroup_size(1)` | 1 | ship-shaders:44 / ship-renderer:316 |

**没有任何 compute shader 使用 workgroup shared memory（`var<workgroup>`）**。全部逐 invocation 独立，因此可以逐字改写成 fragment shader。已 grep 确认。

### 1.4 物理与世界常量

| 常量 | 值 | 源码 |
|---|---|---|
| `GRAVITY` | 9.81 | engine:365（另 engine:602 内联 `9.81`） |
| `MIN_DEPTH` | 0.035 | engine:366 |
| Manning 摩擦系数 | 0.018 | engine:511 |
| `TETHYS_WATER_LEVEL` | 1.4 | water-profiles:5 → uniform `sunWater.w` |
| `TETHYS_WATER_FIELD_SIZE` | 192（m，模拟域边长） | water-profiles:9 → uniform `simulation.z` |
| 模拟域中心 | (0, −12) | engine:2309 → uniform `simulation.xy` |
| cell size | 192/256 = 0.75 m | engine:490（`simulation.z / dimensions.x`） |
| `TERRAIN_EXTENT` | 520 | engine:98 → uniform `terrain.x` |
| `OPEN_WATER_VIEW_SCALE` | 100 | engine:106 → uniform `environment.w` |
| `OPEN_WATER_MAX_ORBIT` | 12000 | engine:115 |
| `OPEN_WATER_FAR_PLANE` | 50000；near = 0.12；FOV = 52° | engine:208, 2287 |
| `WATER_HORIZON_REACH` | 20000 | engine:203 |
| 太阳方向 | `normalize([-0.52, 0.30, -0.80])` | engine:2307 |
| 风/主浪方向 | `normalize(vec2(0.887, -0.462))` | engine:407, 587, 980, 1016, 1029, 1051, 1223, 1254 |
| `BREAKER_ENABLED` | **false** | engine:185；`BREAKER_SHADER_GATE = "0.0"` engine:186 |
| `WORLD_UNIFORM_BYTES` | 256 | engine:162 |
| `SIMULATION_PARAM_BYTES` | 32 | engine:163 |
| `DEPTH_FORMAT` | `depth24plus` | engine:164 |
| `FRAME_HISTORY` | 360 | engine:161 |
| `MIN_WAVE_SCALE / MAX_WAVE_SCALE` | 0.15 / 1.6 | engine:121-122 |
| `MAX_DISTANT_ROUGHNESS` | 3 | engine:125 |
| `MIN_DETAIL_RANGE / MAX_DETAIL_RANGE` | 0.4 / 8 | engine:127-128 |
| `MAX_SWELL_SMOOTHING` | 3 | engine:131 |
| `MAX_FOG_REACH` | 3 | engine:139 |

### 1.5 CPU 端谱生成常量（`buildSpectralOceanData`, engine:1567-1674）

engine:1569-1578：
```
gravity        = 9.81
depth          = 54          (TMA 有限水深)
windSpeed      = 11.5 m/s
fetch          = 120000 m
windAngle      = -0.48 rad
peakEnhancement= 3.3         (JONSWAP γ)
swell          = 0.38
deltaK         = 2π / lengthScale
alpha          = 0.076 * (g*fetch / windSpeed²)^(-0.22)
peakOmega      = 22 * (windSpeed*fetch / g²)^(-0.33)
```
副谱（`secondaryScale > 0` 时，engine:1624-1640）：`swellWindSpeed = 8.4`, `swellFetch = 310000`, γ = 2.6，方向偏移 `windAngle + 0.82`，展宽常数 `+9.0`、×0.72。
短波衰减：`exp(-0.00016 * k²)`（engine:1622）。
方向展宽：`spreadPower = ((ω>ωp ? 9.77*r^-2.5 : 6.97*r^5) + 16*tanh(min(r,20))*swell²) * 0.58`（engine:1617-1618）。

---

## 2. 纹理与缓冲资源清单

所有资源在 `allocateFields()`（engine:1971-2118）分配；窗口相关的在 `resize()`（engine:2235-2263）。

### 2.1 GPU 纹理

| 名称 | 格式 | 尺寸 | usage | 用途 | ping-pong |
|---|---|---|---|---|---|
| `terrainTexture` | `rgba16float` | 513×513 | STORAGE + TEXTURE | (height, N.x, N.z, 0) | 否，只写一次（`terrainPrepared`, engine:2351-2358） |
| `waterTextures[0..1]` | `rgba16float` | simRes² (256²) | STORAGE + TEXTURE + COPY_DST | (eta, qx, qz, foam) | **是**，`activeSimulationIndex`（engine:1790, 2376-2384） |
| `breakerEventTextures[0..1]` | `rgba16float` | **256 × 1** | STORAGE + TEXTURE + COPY_DST | (activation, spectralInstab, nearshoreInstab, compression) | **是**，`activeBreakerEventIndex`（engine:1791, 2386-2388） |
| `spectralTwiddleTexture` | `rgba32float` | **128 × 7** | TEXTURE + COPY_DST | (cos, sin, firstIdx, secondIdx) | 否，CPU 上传一次（engine:2014，仅 cascade 0 上传，三级联共用） |
| `spectralInitialTextures[c]` (c=0..2) | `rgba32float` | 128×128 | TEXTURE + COPY_DST | (h0(k).re, h0(k).im, h0(−k)*.re, h0(−k)*.im) | 否 |
| `spectralWaveDataTextures[c]` | `rgba32float` | 128×128 | TEXTURE + COPY_DST | (kx, 1/\|k\|, kz, ω) | 否 |
| `spectralFields[c][ping][field]` | `rgba16float` | 128×128 | TEXTURE + STORAGE | 4 组/级联，共 3×2×2 = 12 张 | **是**，FFT 内部乒乓（engine:2005-2010, 2026-2027） |
| `depthTexture` | `depth24plus` | canvas | RENDER_ATTACHMENT + TEXTURE | 场景深度，水面折射用 | 否 |
| `sceneColorTexture` | preferred canvas format | canvas | RENDER_ATTACHMENT + TEXTURE | shore 场景捕获 | 否 |

**关键：`waterTextures` 与 `breakerEventTextures` 从不被 CPU 写入**（grep `writeTexture` 只命中 engine:2012-2014, 2160-2161，全是谱数据）。它们依赖 **WebGPU 的纹理零初始化**。→ WebGL2 移植必须在创建后显式 `glClear` 两张 ping-pong FBO 为 `(0,0,0,0)`，否则第一帧读到未定义内容会产生 NaN 并被状态反馈锁死。

### 2.2 谱场通道语义（IFFT 之后）

| 纹理 | 通道 | 含义 | 消费点 |
|---|---|---|---|
| `field0` (=`spectralFields[c][0][0]`) | `.r` | Dx（水平位移 x） | engine:1087 |
| | `.g` | Dz（水平位移 z） | engine:1087 |
| | `.b` | Dy（高度） | engine:399-400, 1088-1089 |
| | `.a` | ∂Dz/∂x（交叉导数） | engine:410, 1093 |
| `field1` (=`spectralFields[c][0][1]`) | `.r` | ∂Dy/∂x（坡度 x） | engine:1094 |
| | `.g` | ∂Dy/∂z（坡度 z） | engine:1095 |
| | `.b` | ∂Dx/∂x | engine:411, 1097 |
| | `.a` | ∂Dz/∂z | engine:411, 1097 |

**最终结果永远落在 ping index 0**（`fields[c][0][*]`），因为 14 个 pass 中 pass 13 的 `destination = 1 - (13%2) = 0`（engine:2026-2027）。所有下游 bind group 都硬编码 `spectralFields[c][0][k]`（engine:2044-2047, 2058-2061, 2073-2076, 2088-2093）。

### 2.3 GPU 缓冲

| 名称 | 大小 | 类型 | 内容 |
|---|---|---|---|
| `worldUniformBuffer` | 256 B | UNIFORM | `WorldUniforms`（见 §3.0） |
| `impulseParamBuffer` | 32 B | UNIFORM | `SimulationParams`，impulse 非零 |
| `calmParamBuffer` | 32 B | UNIFORM | `SimulationParams`，impulse.z = 0 |
| `spectralIfftParamBuffers[0..13]` | 16 B ×14 | UNIFORM | `uvec4(axis, stage, size, finalize)`（engine:1996-2000） |
| ship `placementBuffer` | 16 B | UNIFORM | `(centre.x, centre.y, heading, draft)` |
| ship `hullSpanBuffer` | 16 B | UNIFORM | `(halfLength, halfBeam, longScale, mediumScale)` |
| ship `transformBuffer` | 128 B | **STORAGE** | 2× `mat4x4<f32>`（model, normalMatrix） |
| `querySet`/`queryResolve`/`queryReadback` | 4 slots / 32 B | timestamp | 仅性能统计，移植可丢弃 |

### 2.4 Sampler

- `fieldSampler`：`clamp-to-edge`, linear/linear（engine:1913）
- `spectrumSampler`：`repeat`, linear/linear（engine:1914）

注意 engine:541 里泡沫回溯用的是 **`spectrumSampler`（repeat）去采样水面 state 纹理**，但 UV 已被 clamp 到 `[0.002, 0.998]`，实际不会 wrap。移植时用哪个 wrap 模式都可，但必须保留 clamp。

---

## 3. 每个 compute 管线的完整规格

### 3.0 共享 uniform：`WorldUniforms`（shared-wgsl.ts:6-31，写入见 engine:2295-2319）

std140/WGSL 布局，共 64 个 f32 = 256 B：

| 偏移(float) | 字段 | 内容 | 写入行 |
|---|---|---|---|
| 0-15 | `viewProj` | mat4（列主序） | 2301 |
| 16-19 | `cameraTime` | `(eye.x, eye.y, eye.z, elapsedSeconds)` | 2302 |
| 20-23 | `cameraRight` | `(right.xyz, tanHalfFov*aspect)` | 2304 |
| 24-27 | `cameraUp` | `(up.xyz, tanHalfFov)` | 2305 |
| 28-31 | `cameraForward` | `(forward.xyz, 0)` | 2306 |
| 32-35 | `sunWater` | `(sunDir.xyz, waterLevel=1.4)` | 2307 |
| 36-39 | `terrain` | `(TERRAIN_EXTENT=520, meshResolution, simulationResolution, underwater?1:0)` | 2308 |
| 40-43 | `simulation` | `(centreX=0, centreZ=-12, extent=192, 1/simRes)` | 2309 |
| 44-47 | `player` | `(px, pz, vx, vz)` | 2310 |
| 48-51 | `interaction` | `(speed, 1, canvasWidth, canvasHeight)` | 2311 |
| 52-55 | `environment` | `(shore?1:0, validationMesh, validationMesh, worldScale=100)` | 2313 |
| 56-59 | `waves` | `(waveScale, waveScale², distantRoughness, detailRange)` | 2315 |
| 60-63 | `atmosphere` | `(fogReach, swellSmoothing, longCascadeScale, mediumCascadeScale)` | 2316 |

`tanHalfFov = tan(52°/2)`（engine:2303）。`validationMesh = shore ? 512 : meshResolution`（engine:2312）。

---

### 3.1 静态地形场 compute — `buildTerrain`

**源码**：shader engine:325-346；WGSL 辅助 `TETHYS_TERRAIN_WGSL` engine:220-323；dispatch engine:2351-2358。

**绑定布局**（engine:328-329）：
| binding | 资源 | 读写 |
|---|---|---|
| 0 | `WorldUniforms` UBO | read |
| 1 | `fieldOut : texture_storage_2d<rgba16float, write>` | **write only** |

**dispatch**：`(33, 33, 1)`，`@workgroup_size(16,16)`。**每帧调用 0 次**——只在 `terrainPrepared == false` 时跑一次（engine:2351-2357）。`setScene()`（engine:2126）和 `allocateFields()`（engine:2105）会重置该标志。

**算法**（engine:332-345）：
```
dims = 513
if (id.x >= 513 || id.y >= 513) return;
uv      = id.xy / (dims - 1)                 // [0,1] 闭区间
p       = (uv - 0.5) * terrain.x             // terrain.x = 520
spacing = terrain.x / (dims.x - 1)           // 520/512 = 1.015625
h  = terrainHeight(p, environment.x)
hL = terrainHeight(p - (spacing,0), env.x)
hR = terrainHeight(p + (spacing,0), env.x)
hB = terrainHeight(p - (0,spacing), env.x)
hF = terrainHeight(p + (0,spacing), env.x)
N  = normalize(vec3(hL - hR, spacing*2, hB - hF))
store(vec4(h, N.x, N.z, 0))
```
即 **5 次 `terrainHeight` 求值**，中央差分求法线，法线 y 分量在消费端由 `sqrt(1 - g² - b²)` 还原（engine:802, 1404）。

**`terrainHeight(p, shoreMix)`**（engine:245-305），必须逐行照抄：
1. 域扭曲：`warped.x += sin(p.y*0.018 + 0.8)*2.4`；`warped.y += sin(p.x*0.016 - 0.2)*2.1`
2. 基底 `height = -8.5`，加三条正弦（0.62 / 0.39 / 0.14 振幅）
3. 4 个 `tethysCoastalShelf` 的 6 次幂求和，再开 6 次方（软 max），engine:254-258。参数见源码，中心分别 (0,14)/(−112,−79)/(116,−92)/(−6,−196)。
4. 沙丘：`duneInterior = smoothstep(2.02, 3.95, height)`（由 `TETHYS_WATER_LEVEL+0.62 / +2.55` 在字符串模板里 `toFixed(2)` 内联，engine:262 → **实际字面量是 `2.02` 和 `3.95`**）；域扭曲 ×17.0；`duneRidges = sign(b)*pow(abs(b)*0.68, 1.32)`；加权 `0.52 / 0.82 / 0.16`（engine:263-274）
5. 海床：`seabed = min(height, -4.35)` + 三条正弦（0.38 / 0.24 / 0.48）（engine:277-280）
6. 边界淡出：`borderFade = 1 - smoothstep(245, 258, max(|p.x|,|p.y|))`（engine:288）
7. `shaped = mix(seabed, height, shoreMix * borderFade)`（engine:289）
8. 陆架重映射：`shelfPivot = -2.5`；`submergedRatio = clamp((pivot - shaped)/6, 0, 1)`；`plunged = pivot - 6*pow(ratio, 0.35)`；`shaped = shaped < pivot ? plunged : shaped`（engine:300-303）
9. `return mix(-8.5, shaped, borderFade)`（engine:304）

**`hash21` / `valueNoise`**（engine:307-322）——移植必须完全一致，否则地形不同：
```
hash21(p): p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
           p3 += dot(p3, p3.yzx + 33.33);
           return fract((p3.x + p3.y) * p3.z);
valueNoise(p): cell=floor(p); local=fract(p); local = local*local*(3-2*local);
               双线性混合 4 个 hash21 角点
```

---

### 3.2 谱演化 compute — `evolveSpectrum`

**源码**：engine:634-672；dispatch engine:2366-2368。

**绑定布局**（engine:636-640）：
| binding | 资源 | 读写 |
|---|---|---|
| 0 | `WorldUniforms` UBO | read（只用 `cameraTime.w`） |
| 1 | `initialSpectrum : texture_2d<f32>` (rgba32float) | `textureLoad` |
| 2 | `waveData : texture_2d<f32>` (rgba32float) | `textureLoad` |
| 3 | `field0 : texture_storage_2d<rgba16float, write>` | **write** |
| 4 | `field1 : texture_storage_2d<rgba16float, write>` | **write** |

绑定组构造：engine:2018-2024。目标恒为 `fields[0][0]` 和 `fields[0][1]`（ping index 0）。

**dispatch**：`(16, 16, 1)`，`@workgroup_size(8,8)`。**每帧 3 次**（三个级联各一次，engine:2365-2368）。

**算法**（engine:647-671），逐行：
```
initial = load(initialSpectrum, coord)   // (h0.re, h0.im, h0conj.re, h0conj.im)
wave    = load(waveData, coord)          // (kx, 1/|k|, kz, omega)
phase    = wave.w * time                 // time = cameraTime.w
exponent = vec2(cos(phase), sin(phase))
h  = cmul(initial.xy, exponent) + cmul(initial.zw, vec2(exponent.x, -exponent.y))
ih = vec2(-h.y, h.x)                     // i*h

Dx   = ih * wave.x * wave.y              // i*kx/|k| * h
Dy   = h
Dz   = ih * wave.z * wave.y
Dxdx = -h * wave.x * wave.x * wave.y     // -kx²/|k| * h
Dydx = ih * wave.x
Dzdx = -h * wave.x * wave.z * wave.y
Dydz = ih * wave.z
Dzdz = -h * wave.z * wave.z * wave.y

// 两个实数场打包成一个复数场（IFFT 后 re=A, im=B）
dxDz   = vec2(Dx.x   - Dz.y,   Dx.y   + Dz.x)
dyDxz  = vec2(Dy.x   - Dzdx.y, Dy.y   + Dzdx.x)
dyxDyz = vec2(Dydx.x - Dydz.y, Dydx.y + Dydz.x)
dxxDzz = vec2(Dxdx.x - Dzdz.y, Dxdx.y + Dzdz.x)

store(field0, coord, vec4(dxDz, dyDxz))
store(field1, coord, vec4(dyxDyz, dxxDzz))
```
`cmul(a,b) = vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x)`（engine:642-644）。

**CPU 端 `initialSpectrum` / `waveData` 构造**（engine:1589-1658），移植必须原样保留：
- 波矢：`nx = x - size/2`, `nz = y - size/2`, `kx = nx*deltaK`, `kz = nz*deltaK`，`deltaK = 2π/lengthScale`。→ **谱原点在纹理中心**，这是最后 checkerboard 符号翻转存在的原因。
- 截止外：`waveData = (0, 1, 0, 0)`，`initialK` 保持 0（engine:1598-1601）。注意 `wave.y = 1`（不是 0），避免除零语义。
- 色散：`kh = min(k*54, 20)`；`ω = sqrt(g*k*tanh(kh))`；`dω/dk = g*(54*k*sech² + tanh)/max(2ω,1e-5)`（engine:1602-1606）
- TMA 因子（engine:1608）、JONSWAP（engine:1613-1614）、双成分方向展宽（engine:1615-1621）
- 振幅：`sqrt(max(0, 2*S*|dω/dk|/k * deltaK²)) * amplitudeScale`（engine:1641）
- 高斯：Box-Muller（engine:1582-1588），RNG 是 `deterministicRandom(seed)`（engine:1538-1547，PCG 风格 `Math.imul` 混合）——**必须逐位一致否则波形不同**。
- 共轭镜像打包（engine:1649-1657）：`mirror = ((size - y) % size)*size + ((size - x) % size)`，写入 `(K[p].re, K[p].im, K[mirror].re, -K[mirror].im)`。

---

### 3.3 谱逆 FFT compute — `inverseFftStage`（**Stockham autosort**）

**源码**：shader engine:674-724；params 构造 engine:1996-2000；twiddle 构造 engine:1659-1672；绑定组 engine:2025-2036；dispatch engine:2369-2373。

#### FFT 变体判定（确定结论）

- **Stockham autosort，radix-2，decimation-in-time，out-of-place**。管线 label 与纹理 label 都明写 "Stockham"（engine:1919, 1994）。
- **不需要位反转 pass**。Stockham 的排序由每级的读索引置换隐式完成，14 个 pass 后输出即自然序。源码中**不存在任何 bit-reversal 代码**。
- **不使用 workgroup shared memory**，每个 invocation 独立做一个蝶形输出。
- **pass 数 = SPECTRAL_LOG_SIZE × 2 = 14**：pass 0-6 = 水平轴（`axis=0`，沿 x 变换），pass 7-13 = 垂直轴（`axis=1`，沿 y 变换）。
- **每个 pass 是一次完整的 128×128 dispatch**，即每个输出 texel 一个 invocation（不是 N/2 个）。twiddle 表的后半（列 64-127）存了取负的旋转因子，用来表达蝶形的 "减" 分支。
- **每帧 42 次 dispatch**（3 级联 × 14）。

#### 绑定布局（engine:681-686）

| binding | 资源 | 读写 |
|---|---|---|
| 0 | `params : uniform Params` | read |
| 1 | `twiddleTable : texture_2d<f32>` (rgba32float, 128×7) | `textureLoad` |
| 2 | `input0 : texture_2d<f32>` (rgba16float) | `textureLoad` ×2 |
| 3 | `input1 : texture_2d<f32>` (rgba16float) | `textureLoad` ×2 |
| 4 | `output0 : texture_storage_2d<rgba16float, write>` | **write** |
| 5 | `output1 : texture_storage_2d<rgba16float, write>` | **write** |

#### uniform `Params`（engine:675-680，值见 engine:1998）

```
struct Params { axis: u32, stage: u32, size: u32, finalize: u32 }
pass p ∈ [0,14):
  axis     = p < 7 ? 0 : 1
  stage    = p % 7
  size     = 128
  finalize = (p == 13) ? 1 : 0
```

#### ping-pong（engine:2025-2036）

```
source      = pass % 2
destination = 1 - source
input0/1  = fields[source][0], fields[source][1]
output0/1 = fields[destination][0], fields[destination][1]
```
pass 0 读 ping 0（谱演化的输出）→ 写 ping 1；……；pass 13 读 ping 1 → 写 **ping 0**（最终结果）。

#### twiddle 表（CPU，engine:1659-1672）

纹理 128 宽 × 7 高，rgba32float，`(cos, sin, firstIndex, secondIndex)`：
```js
for (stage = 0; stage < 7; stage++) {
  block = size >> (stage + 1);              // 64,32,16,8,4,2,1
  for (output = 0; output < size/2; output++) {   // 0..63
    first = (2*block*floor(output/block) + output % block) % size;
    angle = -2*PI/size * floor(output/block) * block;
    cosine = cos(angle); sine = sin(angle);
    // 行 = stage，列 = output
    texel[stage][output]          = (cosine, sine, first, first + block);
    texel[stage][output + size/2] = (-cosine, -sine, first, first + block);
  }
}
```
即：设 `b = N >> (s+1)`，`g = floor(j/b)`，`r = j % b`，则
- `first  = (2*b*g + r) mod N`
- `second = first + b`
- `W = exp(-2πi/N · b·g)`

输出：`y[j] = x[first] + W·x[second]`，`y[j + N/2] = x[first] − W·x[second]`（后者通过存 `-W` 实现）。

> 校验：stage 0（b=64），j<64 → g=0，first=j，second=j+64，W=1；j≥64 → W=−1。即 `y[j]=x[j]+x[j+64]`, `y[j+64]=x[j]−x[j+64]`。stage 1（b=32），j=32 → g=1，first=32+32=64，second=96，angle=−π/2。与 Stockham autosort DIT 公式一致。

#### shader 算法（engine:697-723）

```
if (id.x >= size || id.y >= size) return;
outputCoord    = ivec2(id.xy)
transformIndex = (axis == 0) ? id.x : id.y
data   = textureLoad(twiddleTable, ivec2(transformIndex, stage), 0)
first  = i32(round(data.z))
second = i32(round(data.w))
coord0 = coord1 = ivec2(id.xy)
if (axis == 0) { coord0.x = first; coord1.x = second; }
else           { coord0.y = first; coord1.y = second; }

inverseTwiddle = vec2(data.x, -data.y)     // 共轭 → 逆变换核 e^{+iθ}

value0 = butterfly(load(input0, coord0), load(input0, coord1), inverseTwiddle)
value1 = butterfly(load(input1, coord0), load(input1, coord1), inverseTwiddle)

if (finalize == 1) {
  checker = 1.0 - 2.0 * f32((id.x + id.y) % 2u)   // +1 / -1 棋盘
  value0 *= checker; value1 *= checker;
}
store(output0, outputCoord, value0);
store(output1, outputCoord, value1);
```
`butterfly(a, b, tw) = vec4(a.xy + cmul(tw, b.xy), a.zw + cmul(tw, b.zw))`（engine:692-694）——**每个 RGBA texel 承载两个复数（xy 一个、zw 一个）**，所以一次蝶形处理两个复数场。

**关键细节**：
1. **没有 1/N 归一化**。振幅归一化被吸收进 CPU 端谱幅值。移植时**不要**加 `/N` 或 `/N²`。
2. **`finalize` 的棋盘符号翻转**只在最后一个 pass（pass 13）做，等价于 `fftshift`（因为 CPU 端谱把原点放在纹理中心）。
3. **共轭 twiddle** 是逆变换的唯一标志（`vec2(data.x, -data.y)`）。
4. **中间结果存在 rgba16float**，即 f16 精度已经是参考行为的一部分（见 §4 风险 R6）。
5. `round(data.z)` 从 f32 纹理里取整数索引——必须用 32 位浮点纹理承载 twiddle，否则 cos/sin 精度不够。

---

### 3.4 水面模拟 compute — `simulate`（守恒型浅水方程 / Rusanov）

**源码**：shader engine:348-557；params 写入 engine:2321-2337；绑定组 engine:2052-2065；dispatch engine:2375-2384。

#### 绑定布局（engine:354-363）

| binding | 资源 | 读写 |
|---|---|---|
| 0 | `uniforms : WorldUniforms` | read |
| 1 | `params : SimulationParams` UBO | read |
| 2 | `previousState : texture_2d<f32>` = `waterTextures[source]` | `textureLoad` ×5 + `textureSampleLevel` ×1 |
| 3 | `nextState : texture_storage_2d<rgba16float, write>` = `waterTextures[dest]` | **write** |
| 4 | `terrainField : texture_2d<f32>` | `textureLoad`（**nearest**） |
| 5 | `longField0` = `spectralFields[0][0][0]` | `textureSampleLevel`（linear + repeat） |
| 6 | `longField1` = `spectralFields[0][0][1]` | 同上 |
| 7 | `mediumField0` = `spectralFields[1][0][0]` | 同上 |
| 8 | `mediumField1` = `spectralFields[1][0][1]` | 同上 |
| 9 | `spectrumSampler`（repeat, linear） | — |

#### uniform `SimulationParams`（engine:350-353，写入 engine:2333-2334）

```
struct SimulationParams { impulse: vec4<f32>, stepFoamShift: vec4<f32> }

impulse.x = (player.x - 0) / 192 + 0.5        // 冲量中心 UV.x
impulse.y = (player.z + 12) / 192 + 0.5       // 冲量中心 UV.y
impulse.z = wakeDue ? -0.012 : 0              // 强度（注意是负值）
impulse.w = 0.54 / 192                        // 半径（UV 单位）
stepFoamShift.x = dt = (mode=="reference") ? 1/120 : 1/60
stepFoamShift.y = 0.72                        // 泡沫产生倍率
stepFoamShift.zw = 0
```
`wakeDue = elapsed - lastWakeAt >= 0.10`（engine:2324）——即每 0.1 秒发一次冲量。`calmParamBuffer` 除 `impulse.z = 0` 外完全相同（engine:2334）。

#### dispatch 与每帧次数

- `(ceil(simRes/16), ceil(simRes/16), 1)`，`@workgroup_size(16,16)`。
- **optimized 模式：每帧 1 次**（impulse group，engine:2375-2378）
- **reference 模式：每帧 2 次**（impulse group 后再跑一次 calm group，engine:2380-2384），dt 各 1/120。
- 每次 dispatch 后 `activeSimulationIndex = 1 - activeSimulationIndex`（engine:2379, 2383）。

#### 算法逐段

**(a) 辅助函数**
```
clampedCoord(c, dims)  = clamp(c, 0, dims-1)                        // engine:376-378
worldPosition(c, dims) = simulation.xy + ((c + 0.5)/dims - 0.5) * simulation.z   // engine:380-383
terrainAtWorld(p):                                                   // engine:385-390
    uv    = clamp(p / terrain.x + 0.5, 0, 1)          // terrain.x = 520
    coord = ivec2(round(uv * (terrainDims - 1)))      // terrainDims = 513 → *512
    return textureLoad(terrainField, coord, 0).r      // ★ NEAREST，不是双线性
```

**(b) `loadCell`**（engine:416-428）
```
coord  = clampedCoord(coordIn, dims)          // 边界 = clamp（零梯度/反射式）
raw    = textureLoad(previousState, coord, 0)
bottom = terrainAtWorld(worldPosition(coord, dims))
depth  = max(sunWater.w + raw.r - bottom, 0)  // sunWater.w = 1.4
eta    = raw.r
q      = (depth <= MIN_DEPTH) ? vec2(0) : raw.gb
foam   = raw.a
```

**(c) 水静力重构 + Rusanov 通量**（engine:430-478）
```
conservativeState(cell, hRec):
   scale = (cell.depth <= MIN_DEPTH) ? 0 : hRec / max(cell.depth, MIN_DEPTH)
   return vec3(hRec, cell.q * scale)

physicalFluxX(s): h = max(s.x, MIN_DEPTH); v = s.yz / h
   return vec3(s.y, s.y*v.x + 0.5*G*s.x*s.x, s.y*v.y)
physicalFluxY(s): h = max(s.x, MIN_DEPTH); v = s.yz / h
   return vec3(s.z, s.z*v.x, s.z*v.y + 0.5*G*s.x*s.x)

hydrostaticPair(a, b):                         // 井平衡重构
   ib = max(a.bottom, b.bottom)
   hA = max(0, (1.4 + a.eta) - ib)
   hB = max(0, (1.4 + b.eta) - ib)
   return [conservativeState(a, hA), conservativeState(b, hB)]

rusanovX(a, b):
   [L, R] = hydrostaticPair(a, b)
   uL = (L.x <= MIN_DEPTH) ? 0 : L.y / max(L.x, MIN_DEPTH)
   uR = (R.x <= MIN_DEPTH) ? 0 : R.y / max(R.x, MIN_DEPTH)
   speed = max(|uL| + sqrt(G*L.x), |uR| + sqrt(G*R.x))
   return 0.5*(fluxX(L) + fluxX(R)) - 0.5*speed*(R - L)
rusanovY(a, b): 同构，用 .z 分量与 fluxY

sidePressureCorrection(h0, hRec) = 0.5*G*(h0*h0 - hRec*hRec)
```

**(d) 主体**（engine:481-520）
```
center/west/east/south/north = loadCell(coord + {0,∓x,∓y})
cellSize = simulation.z / dims.x       // 192/256 = 0.75
dt       = params.stepFoamShift.x

eastPair  = hydrostaticPair(center, east)
westPair  = hydrostaticPair(west, center)
northPair = hydrostaticPair(center, north)
southPair = hydrostaticPair(south, center)
eastFlux  = rusanovX(center, east);   eastFlux.y  += sidePressureCorrection(center.depth, eastPair[0].x)
westFlux  = rusanovX(west, center);   westFlux.y  += sidePressureCorrection(center.depth, westPair[1].x)
northFlux = rusanovY(center, north);  northFlux.z += sidePressureCorrection(center.depth, northPair[0].x)
southFlux = rusanovY(south, center);  southFlux.z += sidePressureCorrection(center.depth, southPair[1].x)

next = vec3(center.depth, center.q) - dt*((eastFlux - westFlux) + (northFlux - southFlux)) / cellSize
next.x = max(next.x, 0)
nextDepth = next.x
nextQ     = (nextDepth <= MIN_DEPTH) ? vec2(0) : next.yz
speed     = length(nextQ) / max(nextDepth, MIN_DEPTH)      // ★ 摩擦前的 speed，后面复用
manning   = 0.018
friction  = G*manning*manning*speed / max(pow(max(nextDepth, MIN_DEPTH), 1.333333), 0.001)
nextQ    /= 1 + dt*friction
```

**(e) 冲量**（engine:515-522）
```
uv = (id.xy + 0.5) / dims
radius  = max(impulse.w, 0.0001)
d       = length((uv - impulse.xy) / radius)
impulseFalloff = exp(-d*d*3.2)
ring    = exp(-pow(d - 0.72, 2) * 18.0)
nextDepth = max(0, nextDepth + (impulseFalloff - ring*0.28) * impulse.z)
dir       = normalize(vec2(player.z, player.w) + vec2(0.0001, 0))   // 玩家速度方向
nextQ    += dir * ring * impulse.z * 1.6
```

**(f) 谱边界耦合 / 海绵层**（engine:524-537）
```
edgeDistance = min(min(uv.x, 1-uv.x), min(uv.y, 1-uv.y))
sponge       = 1 - smoothstep(0, 0.085, edgeDistance)
stillDepth   = max(sunWater.w - center.bottom, 0)
boundary     = spectralBoundaryState(worldPosition(coord, dims), stillDepth)
deepWarmup   = smoothstep(4.8, 9.5, stillDepth) * (1 - sponge) * 0.42
coupling     = min(1, dt * (12.0*sponge + 2.4*deepWarmup))
nextDepth    = mix(nextDepth, max(stillDepth + boundary.x, 0), coupling)
nextQ        = mix(nextQ, boundary.yz, coupling)
```

`spectralBoundaryState(p, depth)`（engine:392-414）：
```
longUv   = fract(p / atmosphere.z + 0.5)      // atmosphere.z = longCascadeScale
mediumUv = fract(p / atmosphere.w + 0.5)      // atmosphere.w = mediumCascadeScale
long0 = sampleLevel(longField0, spectrumSampler, longUv, 0) * waves.x
long1 = sampleLevel(longField1, ...) * waves.x
medium0/medium1 同理
longH = long0.b;  medH = medium0.b
eta = longH + medH + 0.14*(longH² - 0.080*waves.y) + 0.32*(medH² - 0.030*waves.y)
meanDirection = normalize(vec2(0.887, -0.462))
direction     = normalize(meanDirection - (long1.rg + medium1.rg) * 0.055)
phaseSpeed    = sqrt(G * max(depth, MIN_DEPTH))
crossDeriv      = long0.a * 1.18 + medium0.a * 1.05
horizontalDeriv = long1.ba * 1.18 + medium1.ba * 1.05
jacobian = (1 + hd.x)*(1 + hd.y) - cd*cd
return vec4(eta, direction * eta * phaseSpeed, max(0, 1 - jacobian))
```

**(g) 泡沫**（engine:539-552）
```
velocity      = nextQ / max(nextDepth, MIN_DEPTH)
backtraceUv   = clamp(uv - velocity*dt/simulation.z, 0.002, 0.998)
backtracedFoam= sampleLevel(previousState, spectrumSampler, backtraceUv, 0).a
neighbourFoam = (west.foam + east.foam + south.foam + north.foam) * 0.25
foam          = mix(backtracedFoam, neighbourFoam, min(0.11, dt*1.4))

froude             = speed / max(sqrt(G*nextDepth), 0.001)
surfaceCompression = max(0, -(east.q.x - west.q.x + north.q.y - south.q.y) / (2*cellSize))
breakingBirth      = smoothstep(0.58, 0.92, froude) * smoothstep(0.03, 0.32, surfaceCompression)
shorelineBirth     = (1 - smoothstep(0.16, 1.7, nextDepth)) * smoothstep(0.03, 0.24, speed)
spectralBirth      = smoothstep(0.115, 0.31, boundary.w) * smoothstep(0.27, 0.76, boundary.x)
shorelineWaveBirth = (1 - smoothstep(0.10, 1.55, nextDepth)) * smoothstep(0.18, 0.64, boundary.x)

foam *= exp(-dt * 0.58)
foam += dt * (spectralBirth*0.48 + breakingBirth*2.4 + shorelineBirth*0.52 + shorelineWaveBirth*1.25) * stepFoamShift.y
foam  = max(foam, ring * abs(impulse.z) * 4.0 * stepFoamShift.y)
```

**(h) 输出**（engine:554-555）
```
eta = nextDepth + center.bottom - sunWater.w
store(nextState, coord, vec4(clamp(eta, -1.8, 1.8),
                             clamp(nextQ, vec2(-12), vec2(12)),
                             clamp(foam, 0, 1)))
```

**边界处理总结**：所有邻居读取经 `clampedCoord`（零梯度反射），域外由 `sponge` 在最外 8.5% 强制拉回谱边界态。

---

### 3.5 Breaker event compute — `updateBreakerEvents`

**源码**：shader engine:559-632；绑定组 engine:2066-2082；dispatch engine:2385-2388。

**注意**：`BREAKER_ENABLED = false`（engine:185），所以此 pass 的输出在渲染端被 `BREAKER_SHADER_GATE = "0.0"` 乘零掉（engine:1035, 1072, 1228, 1288）。**但 compute pass 仍然每帧执行**（engine:2385-2387 无条件）。移植时可以保留也可以在同样的门控下省略；如果省略，`breakerEvents` 纹理仍需存在并读到 0，因为 `breakerEventActivation`（engine:1010-1013）会去采样它。

**绑定布局**（engine:561-571）：
| binding | 资源 | 读写 |
|---|---|---|
| 0 | `uniforms` | read |
| 1 | `previousEvents : texture_2d<f32>` (256×1) | `textureLoad` ×3 |
| 2 | `nextEvents : texture_storage_2d<rgba16float, write>` (256×1) | **write** |
| 3 | `terrainField` | `textureSampleLevel`（**linear**，与 3.4 的 nearest 不同！） |
| 4 | `waterState` = `waterTextures[activeSimulationIndex]` | `textureSampleLevel`（linear） |
| 5 | `fieldSampler`（clamp, linear） | — |
| 6-9 | `longField0/1`, `mediumField0/1` | `textureSampleLevel`（repeat, linear） |
| 10 | `spectrumSampler` | — |

**dispatch**：`(4, 1, 1)`，`@workgroup_size(64,1)`，每帧 1 次。之后 `activeBreakerEventIndex` 翻转（engine:2388）。

**算法**（engine:573-631）：
```
if (id.x >= 256) return;
uv    = (id.x + 0.5) / 256
along = mix(-180, 180, uv)                 // 沿脊坐标，米
travelDirection  = normalize(vec2(0.887, -0.462))
tangentDirection = vec2(-travel.y, travel.x)
time = cameraTime.w

frontPosition(t):  ph = t*2.4 + 12;  return ph - floor(ph/72)*72 - 36     // 周期 72 m，范围 [-36,36)
meander = sin(along*0.055 + time*0.055 + 0.7)*3.8 + sin(along*0.14 - time*0.032 - 1.3)*1.2
p = tangentDirection*along + travelDirection*(frontPosition(time) + meander)

terrainUv  = clamp(p/terrain.x + 0.5, 0, 1)
bottom     = sampleLevel(terrainField, fieldSampler, terrainUv, 0).r
stillDepth = max(sunWater.w - bottom, 0)
simUv      = (p - simulation.xy)/simulation.z + 0.5
inside     = step(0,simUv.x)*step(0,simUv.y)*step(simUv.x,1)*step(simUv.y,1)
state      = sampleLevel(waterState, fieldSampler, clamp(simUv,0,1), 0) * inside
dynamicDepth = max(stillDepth + state.r, 0.035)
speed        = length(state.gb) / dynamicDepth
froude       = speed / max(sqrt(9.81*dynamicDepth), 0.001)

// 谱不稳定度
long/medium 采样同 spectralBoundaryState（×waves.x）
crossDeriv = long0.a*1.18 + medium0.a*1.05
horizDeriv = long1.ba*1.18 + medium1.ba*1.05
jacobian   = (1+hd.x)*(1+hd.y) - cd*cd
compression = max(0, 1 - jacobian)
slope       = length(long1.rg + medium1.rg)
spectralInstability = smoothstep(0.035, 0.160, compression) * mix(0.34, 1.0, smoothstep(0.045, 0.205, slope))

// 近岸不稳定度
depthRatio = |state.r| / max(dynamicDepth, 0.12)
nearshoreInstability = (1 - smoothstep(2.2, 6.0, dynamicDepth))
                     * max(smoothstep(0.46, 0.86, froude), smoothstep(0.38, 0.76, depthRatio))
targetInstability = clamp(max(spectralInstability, nearshoreInstability), 0, 1)

// 横向扩散 + 快起慢落
eventHistory(c) = textureLoad(previousEvents, ivec2(clamp(c, 0, 255), 0), 0).r
center  = eventHistory(id.x)
history = center*0.50 + eventHistory(id.x - 1)*0.25 + eventHistory(id.x + 1)*0.25
rate    = (targetInstability > history) ? 7.5 : 0.62      // attack / release
blend   = 1 - exp(-rate / 60.0)                           // ★ 硬编码 60 Hz，不是 dt
activation = mix(history, targetInstability, blend)

store(nextEvents, ivec2(id.x, 0), vec4(activation, spectralInstability, nearshoreInstability, compression))
```

---

### 3.6 船体 `updateTransform` compute — `buildShipTransform`

**源码**：shader ship-shaders.ts:33-105；绑定组 ship-renderer.ts:121-135；dispatch ship-renderer.ts:313-317；调用点 engine:2389。

**绑定布局**（ship-shaders:35-42）：
| binding | 资源 | 读写 |
|---|---|---|
| 0 | `uniforms : WorldUniforms` UBO | read |
| 1 | `longField : texture_2d<f32>` = `spectralFields[0][0][0]` | `textureSampleLevel` ×5 |
| 2 | `mediumField : texture_2d<f32>` = `spectralFields[1][0][0]` | `textureSampleLevel` ×5 |
| 3 | `spectrumSampler`（repeat, linear） | — |
| 4 | `placement : uniform vec4` = (centre.x, centre.y, heading, draft) | read |
| 5 | `hullSpan : uniform vec4` = (halfLength, halfBeam, longScale, mediumScale) | read |
| 6 | `shipTransform : storage, read_write` (128 B = 2×mat4) | **write** |

**dispatch**：`(1,1,1)`，`@workgroup_size(1)`，**每帧 1 次**，在 compute pass 最末（engine:2389），必须在渲染船体的 scene pass 之前（ship-renderer:312 注释）。

**算法**（ship-shaders:45-104）：
```
shipWaveHeight(p, longScale, mediumScale):                       // ship-shaders:13-25
   longUv   = fract(p/longScale + 0.5)
   mediumUv = fract(p/mediumScale + 0.5)
   longH   = sampleLevel(longField,   spectrumSampler, longUv,   0).b * waves.x
   mediumH = sampleLevel(mediumField, spectrumSampler, mediumUv, 0).b * waves.x
   return longH + mediumH + 0.14*(longH² - 0.080*waves.y) + 0.32*(mediumH² - 0.030*waves.y)
   // ★ 与 evaluateWaterSurface 的 spectralHeight（engine:1090-1092）完全一致

forward   = vec2(cos(heading), sin(heading))
starboard = vec2(-forward.y, forward.x)
hCentre    = shipWaveHeight(centre)
hFore      = shipWaveHeight(centre + forward*halfLength)
hAft       = shipWaveHeight(centre - forward*halfLength)
hPort      = shipWaveHeight(centre - starboard*halfBeam)
hStarboard = shipWaveHeight(centre + starboard*halfBeam)

heave = (hCentre*2 + hFore + hAft + hPort + hStarboard) / 6      // 水线面均值
trim  = atan2(hFore - hAft,       2*halfLength) * 0.55
heel  = atan2(hStarboard - hPort, 2*halfBeam)   * 0.45

cy=cos(heading) sy=sin(heading) cp=cos(trim) sp=sin(trim) cr=cos(heel) sr=sin(heel)
m00 = cy*cp;            m01 = sp;      m02 = -sy*cp
m10 = -cy*sp*cr + sy*sr; m11 = cp*cr;  m12 = sy*sp*cr + cy*sr
m20 = cy*sp*sr + sy*cr;  m21 = -cp*sr; m22 = -sy*sp*sr + cy*cr

model        = mat4(col0=(m00,m01,m02,0), col1=(m10,m11,m12,0), col2=(m20,m21,m22,0),
                    col3=(centre.x, waterLevel + heave + placement.w, centre.y, 1))
normalMatrix = 同旋转块，col3 = (0,0,0,1)
```
`halfLength = max(model.max[0]-model.min[0], 1)*0.5`，`halfBeam = max(model.max[2]-model.min[2], 1)*0.5`（ship-renderer:175-176）。`placement.w = draft = -0.65`（engine:150, 157）。

---

## 4. WebGL2 移植风险清单

### R1. `textureStore` 双目标输出 → MRT
- **出现位置**：谱演化 `field0`/`field1`（engine:639-640, 669-670）；IFFT `output0`/`output1`（engine:685-686, 721-722）。
- **方案**：WebGL2 原生支持 MRT。FBO 挂 2 个 `COLOR_ATTACHMENT`，`gl.drawBuffers([COLOR_ATTACHMENT0, COLOR_ATTACHMENT1])`，fragment shader 用 `layout(location=0) out vec4 outField0; layout(location=1) out vec4 outField1;`。
- **注意**：MRT 的所有附件必须尺寸一致（都是 128×128，满足）。`MAX_DRAW_BUFFERS` 在 WebGL2 保证 ≥ 4。

### R2. 单目标 `textureStore` → 单附件 FBO
- **出现位置**：terrain `fieldOut`（engine:329, 344）、simulation `nextState`（engine:357, 555）、breaker `nextEvents`（engine:563, 630）。
- **方案**：普通 fullscreen-quad 到 FBO。
- **陷阱**：breaker 目标是 **256×1**。必须 `gl.viewport(0, 0, 256, 1)`，且 fullscreen triangle 的 NDC → 像素映射要正确落在唯一那一行；用 `gl_FragCoord.x` 取 `id.x`（`int(gl_FragCoord.x)`，因为 texel center 在 +0.5）。
- **陷阱**：terrain 目标是 **513×513**（非 2 的幂），WebGL2 支持 NPOT 的 clamp/nearest/linear，无问题。

### R3. Storage buffer（船体 transform）→ 无对应物
- **出现位置**：`ship-shaders.ts:42`（`var<storage, read_write>`）、`ship-shaders.ts:128`（`var<storage, read>` 在 vertex stage）。
- **WebGL2 没有 SSBO，也没有 compute shader。**
- **推荐方案 A（保真度最高）**：把 transform compute 改成渲染到一张 **4×2 的 `RGBA32F` 纹理**（第 0 行 = model 的 4 个 column，第 1 行 = normalMatrix 的 4 个 column），fragment 用 `gl_FragCoord` 决定输出哪一列。船体 vertex shader 用 `texelFetch` 读回（WebGL2 保证 `MAX_VERTEX_TEXTURE_IMAGE_UNITS ≥ 16`，顶点纹理取样可用）。**需要 `EXT_color_buffer_float` 才能渲染到 RGBA32F**；若不可用退回 RGBA16F（矩阵元素都在 [-1,1] 与世界坐标量级，f16 对 col3 的世界坐标（可达 ±100 m）精度约 0.06 m，可接受但会抖）→ 建议世界平移分量单独存或用 RGBA32F。
- **方案 B**：直接在船体 vertex shader 里算（5 次 texture fetch/顶点）。ship-shaders.ts:29-32 的注释明确说明为什么放弃了这条路（~64k 顶点 × 5 次采样）。仅在顶点数很少时可行。
- **方案 C**：CPU 端算。需要把长/中级联的 5 个采样点从 GPU 读回（`readPixels` 同步 stall）或在 CPU 重算谱 → 不推荐。

### R4. `texture_storage_2d` + 同 pass 内先写后读 → 需要 FBO/纹理绑定切换
- **出现位置**：单个 compute pass（engine:2360-2390）里，simulation 写 `waterTextures[dest]`（engine:2378），随后 breaker event pass 读同一张（engine:2386，`breakerEventGroup(..., simulationIndex = activeSimulationIndex)`，此时已翻转为 dest）。WebGPU 保证同 pass 内 dispatch 顺序与内存可见性。
- **WebGL2**：绘制调用天然有序，但**同一张纹理不能同时是当前 FBO 附件和被采样对象**。必须在 breaker 的 draw 之前把 simulation FBO 解绑，并把 `waterTextures[dest]` 绑到纹理单元。这是常规操作，但必须显式做，且不要依赖任何隐式 barrier。
- 同理，FFT 的每一 pass 之间必须切换 FBO（已经是 ping-pong，天然满足）。

### R5. `rg32float` / `rgba32float` 的可渲染性与可过滤性
- **本工程实际没有 `rg32float`**。用到的 32 位浮点纹理是 `rgba32float` 三处：`spectralTwiddleTexture`（engine:1994）、`spectralInitialTextures`（engine:2003）、`spectralWaveDataTextures`（engine:2004）。
- **好消息**：这三张**只被 `textureLoad` 读，从不被 sample、从不被写**（engine:651-652, 701）。→ WebGL2 里用 `RGBA32F` + `NEAREST` + `texelFetch`，**不需要 `OES_texture_float_linear`，也不需要 `EXT_color_buffer_float`**（不作为渲染目标）。
- **必须确认**：`gl.texImage2D(..., gl.RGBA32F, ..., gl.RGBA, gl.FLOAT, data)` 在 WebGL2 core 可用（是的，RGBA32F 是 core sized format，texture-complete 但 filter 必须是 NEAREST）。

### R6. `rgba16float` 渲染目标 + f16 精度差异
- **出现位置**：所有 storage 目标（engine:329, 357, 563, 639-640, 685-686；纹理创建 engine:1989, 1992, 1993, 2005-2010）。
- **WebGL2**：`RGBA16F` 作为 FBO 附件需要 **`EXT_color_buffer_half_float`**（或 `EXT_color_buffer_float`）。必须在初始化时检测并给出降级路径。
- **可过滤性**：`RGBA16F` 在 WebGL2 core 中是 texture-filterable（ES 3.0 表），LINEAR 采样直接可用。这一点对 engine:395-398（谱场 linear 采样）、engine:541（泡沫回溯 linear）、engine:595, 599（breaker 用 fieldSampler linear）是必需的。
- **精度一致性建议**：**FFT 中间结果必须也用 RGBA16F**，因为 WebGPU 版本本来就在每个 pass 之间量化到 f16（engine:685-686）。如果 WebGL2 改用 RGBA32F，结果会"更准"但与参考不一致——若目标是逐像素对齐参考，请保持 RGBA16F。
- **危险点**：simulation 状态存 f16，`eta` 被 clamp 到 ±1.8、`q` 到 ±12、`foam` 到 [0,1]（engine:555），这些范围在 f16 下相对精度约 1e-3，足够；但**中间量 `0.5*G*h²` 在 h≈10 m 时约 490，f16 尾数 10 bit → 相对误差 5e-4**。中间计算全在 highp float 里做，只有存储量化，所以没问题。GLSL 里务必声明 `precision highp float;`。

### R7. `textureLoad` → `texelFetch` 的语义差异
- **出现位置**：engine:389, 418, 579, 651, 652, 701, 714, 715, 1416。
- WGSL `textureLoad(t, coord, level)`：**越界返回 0**（WebGPU 规范保证）。GLSL `texelFetch` **越界是未定义行为**。
- 逐处核查：
  - engine:389（terrain）：coord 由 `clamp(uv,0,1)*512` 后 `round` 得到，∈[0,512]，安全。
  - engine:418（previousState）：经 `clampedCoord`，安全。
  - engine:579（previousEvents）：显式 `clamp(coord, 0, 255)`，安全。
  - engine:651-652（谱输入）：coord = id.xy，已被 `id >= dims` 提前 return 保护，安全。
  - engine:701（twiddle）：`transformIndex ∈ [0,127]`, `stage ∈ [0,6]`，安全。
  - engine:714-715（FFT 输入）：`first/second` 由 twiddle 表给出，`second = first + block ≤ 127`，安全。
  - engine:1416（scene depth）：显式 clamp，安全。
- **结论**：全部安全，可以直接 `texelFetch`。但请保留所有 clamp，不要"优化掉"。

### R8. `textureDimensions()` → 无对应物
- **出现位置**：engine:333（terrain 输出维度）、engine:386（terrain 输入维度）、engine:482（nextState 维度）、engine:648（field0 维度）、engine:1414（scene depth 维度）。
- **方案**：全部改为 uniform 常量传入。注意 engine:337 用 `dimensions.x - 1u`、engine:388 用 `terrainDimensions - 1`、engine:490 用 `dimensions.x`（**不减 1**）——这三个不同的用法必须分别精确复现。

### R9. 整数纹理 / u32 uniform
- **出现位置**：IFFT 的 `Params { axis: u32, stage: u32, size: u32, finalize: u32 }`（engine:675-680），CPU 端用 `Uint32Array` 写入（engine:1998）。
- **方案**：WebGL2 支持 `uniform uint` / `uvec4` 与 UBO（std140）。更简单的做法：因为只有 14 个 pass 且 pass 数编译期已知，可以**为 axis=0/axis=1 各编译一个 program，把 `stage` 和 `finalize` 做成普通 `uniform int` / `uniform float`**，避免 UBO 对齐问题。
- **注意**：`(id.x + id.y) % 2u` 的 checker（engine:717）在 GLSL 里用 `int(gl_FragCoord.x) + int(gl_FragCoord.y)` 取模，务必确认 `gl_FragCoord` 的半像素偏移（`floor(gl_FragCoord.xy)` 才是 texel index）。

### R10. `select()` 参数顺序
- **出现位置**：engine:423, 431, 460-461, 470-471, 509, 880, 1430, 1469, 1515, 1519, 598-599(用 step 代替)、627、1362、1364。
- WGSL `select(falseValue, trueValue, condition)` — **与 GLSL `mix(a, b, t)` 的直觉顺序一致但与 C 三元相反**。逐处翻译时极易写反。engine:627 的 `select(0.62, 7.5, target > history)` = "条件真取 7.5"。

### R11. `fwidth` / `dpdx` / `dpdy`
- **出现位置**：engine:1305（`fwidth(waterColumn)`，水面片元）；ship-shaders:158-161, 200。
- WebGL2 core 提供 `dFdx/dFdy/fwidth`（GLSL ES 3.00 内置），无需扩展。**但精度提示**：ES 3.00 的导数默认精度可能低于 WGSL；若出现岸线抖动，用 highp 声明。

### R12. `@builtin(instance_index)` + `override` 常量
- **出现位置**：engine:1138（`instance_index`，水面 clipmap 10 环）、engine:910（`override REFERENCE_MODE`）。
- **方案**：`gl_InstanceID` + `drawArraysInstanced`；`override` → 两个 program 变体（`#define REFERENCE_MODE 1`）或 `uniform bool`。engine:1957-1958 已经是编译两条管线，直接对应两个 program。

### R13. `texture_depth_2d` + `textureLoad` 深度
- **出现位置**：engine:928, 1414-1416（shore 场景水下折射读取捕获深度）。
- **方案**：WebGL2 把深度渲染到 `DEPTH_COMPONENT24` 纹理，采样时必须 `TEXTURE_COMPARE_MODE = NONE`，用 `texelFetch(sampler2D, coord, 0).r`。仅 shore 场景需要（`environment.x > 0.5`，engine:1413）。

### R14. 数组返回值 `array<vec3<f32>, 2>`
- **出现位置**：engine:447-454（`hydrostaticPair`）。
- GLSL ES 3.00 允许数组作为返回类型，但部分驱动实现有 bug。**建议改成 struct 或两个 `out` 参数**。这是移植中最容易踩驱动坑的一处。

### R15. `tanh` 溢出
- **出现位置**：engine:1041（顶点着色器 breaker warp），源码已用 `clamp(x, -30, 30)` 修补，注释在 engine:1037-1040 说明 Metal 的 tanh 在 |x|>89 溢出成 NaN，而 `0 * NaN = NaN`。
- **移植必须保留这个 clamp**。GLSL ES 3.00 有 `tanh`，但同样存在驱动差异。

### R16. 采样器 wrap 模式的按纹理绑定 vs 按 sampler 对象
- WebGPU 里 sampler 与纹理解耦：同一张 `waterTextures` 在 engine:541 用 repeat sampler、在 engine:957/1292 用 clamp sampler。
- WebGL2 core 有 **Sampler Object**（`gl.createSampler` / `gl.bindSampler`），可以完全复现这一解耦。**不要**依赖 `texParameteri` 的按纹理状态，否则 engine:541 与 engine:957 会互相干扰。

### R17. 每帧 draw call 数量暴涨
- WebGPU 版一个 compute pass 里做完：3×(1 evolution + 14 IFFT) + 1~2 simulation + 1 breaker + 1 ship = **47~48 次 dispatch**（engine:2360-2390）。
- WebGL2 会变成 47~48 次 FBO 切换 + fullscreen draw，其中 45 次是 128×128 的微小 draw。**这是主要性能风险**。
- **可选优化**：三个级联共用同一 twiddle 表与同一 pass 参数（engine:2014 只上传 cascade 0 的表，因为三者相同）。可以把 3 个级联打包成 atlas，把 45 次 draw 压到 15 次。**但注意**：建议**纵向排列（128 宽 × 384 高）**，这样 axis=0 pass 完全不需要改（每行独立），axis=1 pass 只需 `first += cascade*128`。

### R18. 纹理零初始化
- 见 §2.1。WebGPU 保证零初始化；WebGL2 不保证。**必须**在创建 `waterTextures[0..1]`、`breakerEventTextures[0..1]`、`spectralFields[c][p][f]`（共 2+2+12 = 16 张）后显式 clear 为 0。
- 尤其 `waterTextures`：一旦第一帧读到 NaN，`nextQ`/`foam` 的反馈会把 NaN 永久锁在状态里，表现为整片水面消失。

### R19. GLSL ES 3.00 精度声明
- GLSL ES 3.00 fragment shader **默认 float 精度未定义，必须显式 `precision highp float;` 和 `precision highp int;`**，否则移动端 GPU 会用 mediump 跑 Rusanov 通量，`0.5*G*h²` 直接爆掉。

### R20. `exp2` / `pow` 边界
- engine:512 `pow(max(nextDepth, MIN_DEPTH), 1.333333)`：底数 ≥ 0.035，安全。
- engine:302 `pow(submergedRatio, 0.35)`：ratio 已 clamp 到 [0,1]，但 `pow(0, 0.35)` 在部分驱动返回 NaN。**建议加 `max(ratio, 1e-6)`**（原代码没有，属于潜在既有问题，移植时保持行为一致或修正需记录）。
- engine:1500 `pow(crestPinch, 4.0)`、engine:1069 `pow(max(crestProfile,0), 3.0)` — 已有 max 保护。

---

## 5. 每帧 pass 依赖图

`render()`：engine:2339-2469。

```
[CPU] writeUniforms()            engine:2295-2319  → worldUniformBuffer
[CPU] writeSimulationParams()    engine:2321-2337  → impulseParamBuffer / calmParamBuffer

┌── (仅首帧 / 场景切换 / 分辨率变更) ────────────────────────────────┐
│ PASS-T  buildTerrain                              engine:2352-2357 │
│   in : worldUniformBuffer                                          │
│   out: terrainTexture (513²)                                       │
└────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼ (terrainTexture 之后一直只读)

╔══ COMPUTE PASS "Tethys spectral ocean and local wake simulation" ══╗
║                                            engine:2360-2390        ║
║ for c in [0, 1, 2]:                        engine:2365-2374        ║
║   PASS-E(c)  evolveSpectrum                engine:2366-2368        ║
║     in : worldUniform(time), initial[c], waveData[c]               ║
║     out: fields[c][0][0], fields[c][0][1]                          ║
║        │                                                           ║
║        ▼                                                           ║
║   PASS-F(c, 0..6)  inverseFftStage  axis=0 (水平)                  ║
║   PASS-F(c, 7..13) inverseFftStage  axis=1 (垂直), pass13 finalize ║
║     in : twiddleTable, fields[c][pass%2][0..1]                     ║
║     out: fields[c][1-pass%2][0..1]                                 ║
║     最终结果 → fields[c][0][0], fields[c][0][1]                    ║
║        │                                                           ║
║        ▼ (三级联全部完成)                                          ║
║ PASS-S  simulate                           engine:2375-2378        ║
║   in : worldUniform, impulseParams,                                ║
║        waterTextures[active], terrainTexture,                      ║
║        fields[0][0][0..1], fields[1][0][0..1]                      ║
║   out: waterTextures[1-active]                                     ║
║   → activeSimulationIndex ^= 1                    engine:2379      ║
║        │                                                           ║
║   (reference 模式) PASS-S2 simulate w/ calmParams  engine:2380-2384║
║     in : waterTextures[active] (即上一步的输出)                    ║
║     out: waterTextures[1-active]                                   ║
║     → activeSimulationIndex ^= 1                                   ║
║        │                                                           ║
║        ▼                                                           ║
║ PASS-B  updateBreakerEvents                engine:2385-2387        ║
║   in : worldUniform, breakerEventTextures[activeB],                ║
║        terrainTexture, waterTextures[activeSim] ← 依赖 PASS-S      ║
║        fields[0][0][0..1], fields[1][0][0..1]   ← 依赖 PASS-F      ║
║   out: breakerEventTextures[1-activeB]                             ║
║   → activeBreakerEventIndex ^= 1                  engine:2388      ║
║        │                                                           ║
║        ▼                                                           ║
║ PASS-H  buildShipTransform                 engine:2389             ║
║   in : worldUniform, fields[0][0][0], fields[1][0][0] ← 依赖 PASS-F║
║   out: shipTransformBuffer (storage)                               ║
╚════════════════════════════════════════════════════════════════════╝
                                     │
                                     ▼
┌── RENDER PASS "captured atmosphere and terrain" ─ engine:2393-2407 ┐
│  目标: shore ? sceneColorTexture : swapchain ; depth: depthTexture │
│  1. sky        (3 顶点)                          engine:2399-2401  │
│  2. terrain    (mesh² × 6 顶点)                  engine:2402-2405  │
│       reads terrainTexture, waterTextures[activeSim],              │
│             fields[1][0][*], fields[2][0][*]                       │
│  3. ship       drawIndexed                       engine:2406       │
│       reads shipTransformBuffer ← 依赖 PASS-H                      │
└────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌── RENDER PASS "captured-scene water composite" ── engine:2408-2440 ┐
│  目标: swapchain ; depth: depthTexture (readOnly)                  │
│  0. (shore) sceneBlit 3 顶点                     engine:2414-2418  │
│  1. water   draw(64*64*6, instances = 10)        engine:2428       │
│       group0 reads terrainTexture, waterTextures[activeSim],       │
│                    fields[0..2][0][0..1], breakerEvents[activeB]   │
│       group1 reads sceneColorTexture, depthTexture                 │
│  2. (BREAKER_ENABLED=false → 跳过) breaker patch  engine:2429-2439 │
└────────────────────────────────────────────────────────────────────┘
```

### 依赖边总结（谁写 → 谁读）

| 生产者 | 产物 | 消费者 |
|---|---|---|
| PASS-T | `terrainTexture` | PASS-S (nearest, engine:389)、PASS-B (linear, engine:595)、terrain render (engine:791, 801)、water render (engine:1077, 1300, 1347) |
| PASS-E(c) | `fields[c][0][0..1]`（频域） | PASS-F(c, 0) |
| PASS-F(c, p) | `fields[c][1-p%2][0..1]` | PASS-F(c, p+1)；p=13 时 → `fields[c][0][0..1]`（空域最终） |
| PASS-F(0), PASS-F(1) | long/medium 场 | PASS-S (engine:395-398)、PASS-B (engine:606-609)、PASS-H (ship-shaders:18-19)、water render (engine:1083-1086, 1351-1354) |
| PASS-F(1), PASS-F(2) | medium/short 场 | terrain render (engine:863-866) |
| PASS-F(2) | short 场 | water render (engine:1316-1317) |
| PASS-S | `waterTextures[dest]` | PASS-B (engine:599)、terrain render (engine:816)、water render (engine:957, 1292)、下一帧 PASS-S |
| PASS-B | `breakerEventTextures[dest]` | water render `breakerEventActivation` (engine:1012)、下一帧 PASS-B |
| PASS-H | `shipTransformBuffer` | ship vertex (ship-shaders:148, 152) |
| scene pass | `sceneColorTexture`, `depthTexture` | water fragment 折射 (engine:1414-1428)、sceneBlit (engine:905) |

### 关键时序约束（移植必须保序）

1. **三级联的 evolution + 14 IFFT 必须全部完成，才能跑 PASS-S**。源码里 evolution(c) 与 IFFT(c) 是交错发出的（engine:2365-2374：c=0 evolution → c=0 的 14 pass → c=1 evolution → …），但因为每个级联的场纹理互不相干，可以任意重排级联顺序或并行。
2. **PASS-S 必须在 PASS-B 之前**，PASS-B 读的是 PASS-S 刚写出的 `waterTextures[activeSim]`（engine:2386 的下标已翻转）。
3. **PASS-H 必须在 scene pass 之前**（ship-renderer:312）。
4. **PASS-B 的输出在同帧被 water render 读**（engine:2421/2425 用翻转后的 `activeBreakerEventIndex`）。
5. **reference 模式做 2 个 substep，每步 dt = 1/120**；optimized 做 1 步 dt = 1/60（engine:2332, 2380-2384）。dt 是**固定步长，不随实际帧时间变化**。

---

## 6. 移植检查清单（建议实现 agent 逐项验收）

1. 三张 `RGBA32F` 输入纹理（twiddle / initial / waveData）用 NEAREST + `texelFetch`，且 CPU 生成代码与 engine:1567-1674 逐位一致（含 `deterministicRandom` 的 `Math.imul` 序列）。
2. 14 个 IFFT pass 的 `(axis, stage, finalize)` 序列 = `(0,0,0)(0,1,0)…(0,6,0)(1,0,0)…(1,5,0)(1,6,1)`。
3. IFFT 无 `1/N` 归一化；仅最后一 pass 做 `1 - 2*((x+y)%2)` 棋盘。
4. 最终谱场落在 ping index 0；下游一律绑 `fields[c][0][0..1]`。
5. `waterTextures` / `breakerEventTextures` / `spectralFields` 共 16 张在分配后显式清零。
6. `terrainAtWorld` 用 **NEAREST**（`round(uv*512)`），而 breaker/render 端用 **LINEAR** —— 两者不可统一。
7. `cellSize = 192 / 256`（除以 `dims.x`，不减 1）；terrain `spacing = 520 / 512`（减 1）。
8. `choppiness` 1.18 / 1.05 / 0.40 与 `SPECTRAL_CASCADES[2].lengthScale = 12.0` 作为字面量硬编码。
9. `select()` 全部检查参数顺序。
10. `precision highp float; precision highp int;` 写在所有 fragment shader 顶部。
11. `hydrostaticPair` 的数组返回改成 struct。
12. 船体 transform 走 4×2 的 RGBA32F 纹理 + vertex `texelFetch`。
13. 所有 sampler 用 WebGL2 Sampler Object 解耦（repeat/linear 与 clamp/linear 两套）。
14. dt 固定：optimized 1/60 单步；reference 1/120 双步。
15. `tanh` 的 `clamp(x, -30, 30)`（engine:1041）保留。

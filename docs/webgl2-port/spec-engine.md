# spec-engine.md — Raw WebGPU 水面引擎规格（WebGL2 降级实现的唯一事实来源）

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


> 所有行号均指向仓库根目录下的源文件在 commit `7dbf39c` 时的版本（见上方入库说明）。
> 核心文件：`src/lib/webgpu-water-engine.ts`(2548 行)、`src/lib/shared-wgsl.ts`(118)、`src/lib/ship-renderer.ts`(335)、`src/lib/ship-shaders.ts`(232)、`src/lib/gltf-loader.ts`(219)、`src/lib/water-profiles.ts`(24)、`src/lib/nearshore-reference.ts`(99)、`src/components/webgpu-water-lab-experience.tsx`(319)、`src/index.ts`(18)。

---

## 0. 顶层结论（给实现 agent 的 5 句话）

1. 引擎是**自持有 rAF 循环**的类：`init()` 之后自己 `requestAnimationFrame`，宿主只负责 `new` / `dispose()` / 调 setter / 轮询 `getMetrics()`（组件里没有任何 rAF）。
2. 渲染侧**没有任何顶点缓冲**（除船体外）：sky / terrain / water / breaker / blit 全部由 `@builtin(vertex_index)` + `@builtin(instance_index)` 程序化生成。
3. 水面几何是**相机吸附的 10 级 clipmap**，与 `meshResolution` 无关；`meshResolution` 只控制**地形网格**（且岸滩场景被强制为 512）。
4. 模拟侧全是 compute（3 级谱 IFFT + 近岸浅水方程 + 碎波事件 + 船体刚体变换），WebGL2 必须全部改写为 ping-pong FBO 片元 pass。
5. 唯一的 CPU 回读是 timestamp query（`mapAsync`，见 §1.6），浮力**完全不回读 CPU**。

---

## 1. 公共 API 完整清单

### 1.1 导出面（`src/index.ts:1-18`）

```
export { DEFAULT_WATER_LAB_OPTIONS, WebGpuWaterEngine, type WaterLabMetrics, type WaterLabOptions } from "./lib/webgpu-water-engine";
export { TETHYS_REFERENCE_SIMULATION_RESOLUTION, TETHYS_WATER_FIELD_SIZE, TETHYS_WATER_LEVEL,
         WATER_PROFILES, waterSimulationBytes, waterTriangleCount,
         type WaterRenderMode, type WaterScene, type WaterView } from "./lib/water-profiles";
```

`water-profiles.ts` 常量：`TETHYS_WATER_LEVEL = 1.4`(5)、`TETHYS_WATER_FIELD_SIZE = 192`(9，米，近岸场世界边长)、`TETHYS_REFERENCE_SIMULATION_RESOLUTION = 256`(10)、`WATER_PROFILES` 三档预设(12-16)、`waterTriangleCount(n) = n*n*4`(18-20)、`waterSimulationBytes(n) = n*n*8*2`(22-24)。

### 1.2 构造函数（`webgpu-water-engine.ts:1819-1826`）

```ts
constructor(canvas: HTMLCanvasElement, options: Partial<WaterLabOptions> = {})
```

* `this.options = { ...DEFAULT_WATER_LAB_OPTIONS, ...options }`(1821)。
* 岸滩场景且未显式给相机角时：`yaw = Math.PI`、`pitch = 0.22`(1822-1823)。
* 显式 `cameraYaw` 直接赋值(1824)；`cameraPitch` 夹到 `[-0.24, 1.08]`(1825)。
* 构造函数**不做任何 GPU 工作**，纯同步。所有 GPU 初始化在 `init()`。

### 1.3 `WaterLabOptions` 每字段（类型 17-37，默认 39-55，钳制来自各 setter）

| 字段 | 类型 | 默认 | 范围（钳制处） | 语义 / 副作用 |
|---|---|---|---|---|
| `mode` | `"optimized"｜"reference"` | `"optimized"` | — | reference = 2 个模拟子步(2380-2384) + 更宽反射采样(1445-1449) |
| `view` | `"surface"｜"underwater"` | `"surface"` | — | 写入 `terrain.w`(2308)，水下相机轨道被夹到 19 m(2277) |
| `scene` | `"open"｜"shore"` | `"open"` | — | shore 启用场景捕获 + blit + 512² 地形；写入 `environment.x`(2313) |
| `meshResolution` | number | 240 | `[96, 320]` 整数(2129) | **只影响地形网格**（`environment.y`，2313 / 顶点数 2404-2405）；open 场景生效，shore 强制 512 |
| `simulationResolution` | number | 256 | `[64, 512]` 整数(1990, 2131) | 近岸场纹理边长；变更触发 `allocateFields()` 全量重建 |
| `renderScale` | number | 1 | `[0.5, 1.25]`(2136) | 乘到 DPR 上直接改 canvas 后备缓冲尺寸(2239)，触发 `resize(true)` |
| `waveScale` | number | 1 | `[0.15, 1.6]`(121-122, 2138) | `waves.x`；`waves.y = waveScale²`(2315) |
| `distantRoughness` | number | 0 | `[0, 3]`(125, 2141) | `waves.z`，远场坡度方差回收量 |
| `detailRange` | number | 1 | `[0.4, 8]`(127-128, 2144) | `waves.w`，细节淡出距离倍率 |
| `swellSmoothing` | number | 1 | `[0, 3]`(131, 2178) | `atmosphere.y`；0 = 完全关闭屏幕空间坡度淡出 |
| `longCascadeScale` | number | 240 | `[80, 480]`(135, 2164) | `atmosphere.z`；变更会**在 CPU 重算谱**并 `writeTexture` 覆盖(2154-2162) |
| `mediumCascadeScale` | number | 64 | `[24, 128]`(136, 2171) | `atmosphere.w`；同上 |
| `fogReach` | number | 0 | `[0, 3]`(139, 2181) | `atmosphere.x`；0 = 关闭开阔海域径向雾 |
| `fixedTime?` | number | `undefined` | — | 覆盖 `elapsedSeconds`，用于确定性截图(2273) |
| `benchmark?` | boolean | `false` | — | DPR 上限从 1.5 降到 1(2238) |
| `cameraYaw?` / `cameraPitch?` | number | `undefined` | pitch 夹 `[-0.24,1.08]` | 仅构造期生效 |
| `shipModelUrl?` | `string｜null` | `null` | — | 为 null 时完全不加载船体；npm 包不带模型(35-36) |

### 1.4 公共方法与副作用矩阵

| 方法 | 行 | 钳制 | 是否重建 | 备注 |
|---|---|---|---|---|
| `async init()` | 1828-1893 | — | 全量创建 | 见 §2 |
| `setMode(m)` | 2120 | 无 | 否 | 仅切换 pipeline + 子步数 |
| `setView(v)` | 2121 | 无 | 否 | 仅 uniform |
| `setScene(s)` | 2122-2128 | 相同则 early-return | **是**：`terrainPrepared=false` + `allocateFields()` | 同时 `ship.setPlacement()` |
| `setMeshResolution(v)` | 2129 | 96..320, floor | 否 | 只改 draw count / uniform |
| `setSimulationResolution(v)` | 2130-2135 | 64..512, floor；相同则 early-return | **是**：`allocateFields()` | 会销毁并重建全部谱纹理与 bind group |
| `setRenderScale(v)` | 2136 | 0.5..1.25 | **是**：`resize(true)` | 重建 depth / sceneColor / scene bind group |
| `setWaveScale(v)` | 2137-2139 | 0.15..1.6，非有限数→1 | 否 | |
| `setDistantRoughness(v)` | 2140-2142 | 0..3，非有限→0 | 否 | |
| `setDetailRange(v)` | 2143-2145 | 0.4..8，非有限→1 | 否 | |
| `setLongCascadeScale(v)` | 2163-2169 | 80..480；相同 early-return | **部分**：重算 cascade 0 谱并 writeTexture；不重建 pipeline | 同步 `ship.setCascadeScales` |
| `setMediumCascadeScale(v)` | 2170-2176 | 24..128；相同 early-return | 同上，cascade 1 | |
| `setSwellSmoothing(v)` | 2177-2179 | 0..3，非有限→1 | 否 | |
| `setFogReach(v)` | 2180-2182 | 0..3，非有限→0 | 否 | |
| `resetMetrics()` | 2184-2189 | — | 否 | 清空 4 个采样数组长度 |
| `getMetrics()` | 2471-2511 | — | 否 | 见 §1.5 |
| `dispose()` | 2520-2545 | — | 释放全部 | 见 §1.7 |

**私有但对移植关键**：`cascadeScale(i)`(2146-2150，index 2 恒为 12 m)、`uploadCascadeSpectrum(i)`(2154-2162)、`allocateFields()`(1971-2118)、`resize(force)`(2235-2263)、`worldScale()`(2267-2269，恒返回 100)、`frameState(t)`(2271-2293)、`writeUniforms(t)`(2295-2319)、`writeSimulationParams(f)`(2321-2337)、`render`(2339-2469)、`fail(msg)`(2513-2518)。

### 1.5 `WaterLabMetrics` 每字段的计算方式（类型 57-90，实现 2471-2511）

| 字段 | 计算 |
|---|---|
| `ready` | `init()` 末尾置 true(1889) |
| `mode/view/meshResolution/simulationResolution/waveScale/distantRoughness/detailRange/swellSmoothing/longCascadeScale/mediumCascadeScale/fogReach` | 直接回读 `this.options`(2475-2485) |
| `triangles` | `2486-2490`：地形 `(shore?512²:mesh²)*2` + 内环 `64*64*2` + 外 9 环 `9*64*64*1.5`（1.5 = 中心退化后的近似）+ `BREAKER_ENABLED?24576:0` + `ship.triangleCount`（= Σ indexCount/3，ship-renderer:308-310） |
| `simulationBytes` | `waterSimulationBytes(res) = res²*8*2`（2 张 rgba16float） |
| `simulationSubsteps` | `mode==="reference" ? 2 : 1`(2492) |
| `sceneCapturePasses` | `scene==="shore" ? 1 : 0`(2493) |
| `disturbanceCount` | 每次尾流冲量自增(2327)，冲量节流 0.10 s(2324) |
| `particleCount` | **恒 0**(2495) |
| `frameMeanMs / P95 / P99 / Max` | 来自 `frameTimes`（rAF 时间戳差，滤掉 ≤0 与 ≥1000 ms，2343-2346），环形上限 `FRAME_HISTORY=360`(161)；`percentile()` 见 1676-1680（排序后 `floor(len*frac)`） |
| `fps` | `1000 / frameMeanMs`(2500) |
| `hitchFrames` | `frameTimes.filter(v => v > 50).length`(2501) |
| `submitMeanMs` | CPU 侧 `performance.now()` 包住整个 encode+submit(2349, 2447) |
| `gpuSimulationMeanMs/P95Ms` | **timestamp query**：query index 0/1 包住 compute pass(2362)，`(t1-t0)/1e6`(2454)；无样本返回 `null` |
| `gpuRenderMeanMs/P95Ms` | query index 2（scene pass 开始 2397）到 index 3（water pass 结束 2412），跨两个 pass(2455) |
| `gpuTimestampSamples` | `min(simTimes.length, renderTimes.length)`(2507) |
| `adapter` | `adapterLabel`(1848) = `[vendor, architecture, device, description].filter(Boolean).join(" · ")`，否则 `"WebGPU 适配器"`；船体失败时追加 `" · 船体加载失败: <msg>"`(2508) |
| `error` | `fail()` 记录的**第一条**错误(2516)，之后不覆盖 |

采样开关：`measureGpu = querySet && !queryPending && frameIndex % 8 === 0`(2359)，即每 8 帧最多测一次，且上一次 readback 未完成则跳过。有效值过滤 `>=0 && <1000 ms`(2456, 2460)。

### 1.6 timestamp readback 时序（唯一 CPU 回读）

`2441-2445` 编码 `resolveQuerySet(0,4,queryResolve,0)` + `copyBufferToBuffer(→queryReadback, 32B)`，置 `queryPending = true`；`submit` 之后(2446) `queryReadback.mapAsync(READ)`(2450)，回调里 `new BigUint64Array(getMappedRange().slice(0))` → `unmap()` → 推入数组 → `queryPending = false`(2464)；`.catch` 也复位标志(2465)。

### 1.7 `dispose()` 释放顺序（2520-2545，逐条）

1. `disposed = true`（**所有 `init()` await 点都会检查这个标志**）
2. `cancelAnimationFrame(animationFrame)`
3. `resizeObserver.disconnect()`
4. `removeInteraction()`（移除 5 个事件监听 2199-2205）
5. `sceneColorTexture` → `depthTexture` → `terrainTexture` → `waterTextures[2]`
6. `spectralInitialTextures[]` → `spectralWaveDataTextures[]` → `spectralTwiddleTexture` → `spectralFields.flat(2)`
7. `spectralIfftParamBuffers[]`
8. `worldUniformBuffer` / `impulseParamBuffer` / `calmParamBuffer`
9. `querySet` / `queryResolve` / `queryReadback`
10. `ship.dispose()`（ship-renderer:330-334，销毁全部 buffer + texture）→ `ship = null`
11. `device.destroy()`

> 注意 **`breakerEventTextures` 在 dispose 中被遗漏**（2528 只销毁了 `waterTextures`），是既有小泄漏；`allocateFields()` 里则正确销毁(1976)。WebGL2 版本应补齐。

---

## 2. `init()` 流程（1828-1893）

```
1. if (!navigator.gpu) throw "当前浏览器不支持 WebGPU。请使用较新版本的 Chromium 内核浏览器，并确保已启用硬件加速。"   (1829)
2. adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })                              (1830)
3. if (disposed) return                                                                                               (1836)
4. if (!adapter) throw "未找到可用的 WebGPU 适配器。"                                                                   (1837)
5. requiredFeatures = adapter.features.has("timestamp-query") ? ["timestamp-query"] : []                               (1838)
   —— 没有任何 requiredLimits，全部走默认 limits
6. device = await adapter.requestDevice({ requiredFeatures })                                                          (1839)
7. if (disposed) { device.destroy(); device = null; return }                                                            (1840-1844)
8. device.lost.then(info => fail(`WebGPU 设备已丢失：${info.message || info.reason}`))                                  (1845)
9. device.addEventListener("uncapturederror", e => fail(e.error.message))                                              (1846)
10. adapterLabel = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(" · ")          (1847-1848)
11. context = canvas.getContext("webgpu"); if (!context) throw "无法创建 WebGPU 画布上下文。"                            (1849-1850)
12. format = navigator.gpu.getPreferredCanvasFormat()                                                                  (1851)
13. context.configure({ device, format, alphaMode: "opaque" })   // 未指定 usage → 默认 RENDER_ATTACHMENT               (1852)
14. await createResources()                                                                                            (1853)
15. if (disposed) return                                                                                               (1854)
16. 若 device 支持 timestamp-query：createQuerySet({type:"timestamp", count:4})，
    queryResolve(32B, QUERY_RESOLVE|COPY_SRC)，queryReadback(32B, COPY_DST|MAP_READ)                                    (1855-1859)
17. installInteraction()  → pointerdown/move/up/cancel + wheel{passive:false}                                           (1860, 2191-2197)
18. resizeObserver = new ResizeObserver(() => resize()); observe(canvas); resize()                                      (1861-1863)
19. 若 shipModelUrl：try { ship = await ShipRenderer.create({...}) } catch { shipError = msg }                           (1866-1883)
20. if (disposed) { ship?.dispose(); ship = null; return }                                                              (1884-1888)
21. ready = true; startTime = lastFrameTime = performance.now(); animationFrame = rAF(render)                            (1889-1892)
```

### 2.1 `createResources()`（1895-1969）

* **9 个 shader module 并行编译**并强制校验(1898-1908)：`assertShaderModule()`(1726-1734) 调 `getCompilationInfo()`，若有 error 则 throw `` `${label}: line:col message | …` ``。
* buffer：`worldUniformBuffer` 256 B(UNIFORM|COPY_DST, 1910)、`impulseParamBuffer` 32 B(1911)、`calmParamBuffer` 32 B(1912)。
* sampler 两个(1913-1914)：
  * `fieldSampler`：clamp-to-edge / linear / linear
  * `spectrumSampler`：repeat / linear / linear
* 5 个 compute pipeline（全 `layout:"auto"`，全 `createComputePipelineAsync`）：terrain(1915)、simulation(1916)、breakerEvent(1917)、spectrumEvolution(1918)、spectralIfft(1919)。
* 7 个 render pipeline（详见 §3）：sky(1920)、terrain(1928)、sceneBlit(1936)、optimizedWater(1957)、referenceWater(1958)、optimizedBreakerPatch(1963)、referenceBreakerPatch(1964)。
* 最后 `if (disposed) return; allocateFields();`(1967-1968)。

### 2.2 `allocateFields()`（1971-2118）

先 destroy 全部旧场纹理与参数 buffer(1974-1987)，再：
* `terrainTexture`：`513×513 rgba16float`，STORAGE|TEXTURE_BINDING(1988-1989)，`TERRAIN_FIELD_RESOLUTION = 512`(160)。
* `waterTextures[2]`：`sim×sim rgba16float`，STORAGE|TEXTURE_BINDING|COPY_DST(1992)。
* `breakerEventTextures[2]`：`256×1 rgba16float`(1993)。
* `spectralTwiddleTexture`：`128×7 rgba32float`，TEXTURE_BINDING|COPY_DST(1994)。
* 14 个 IFFT 参数 buffer(16 B 各)，内容 `[axis, stage, size, finalize]`：`axis = pass<7?0:1`，`stage = pass%7`，`size = 128`，`finalize = (pass===13)`(1996-2000)。
* 每级 cascade（3 级）：initial spectrum(128² rgba32float)、waveData(128² rgba32float)、`fields[2][2]`(4 张 128² rgba16float ping-pong)，CPU 生成 `buildSpectralOceanData()`(1567-1674) 后 writeTexture；twiddle 只在 cascade 0 上传(2014)。
* 建立全部 bind group：terrain compute(2038)、sky(2039)、terrain×2(2040-2051)、simulation impulse/calm×2(2052-2065)、breakerEvent 2×2(2066-2082)、water 2×2 × 4 条 pipeline(2083-2104)。
* 复位 `terrainPrepared=false`、`activeSimulationIndex=0`、`activeBreakerEventIndex=0`(2105-2107)。
* 若已有 ship，重新绑定谱纹理视图(2111-2117)。

### 2.3 中文错误文案汇总（降级引擎必须保持一致）

| 位置 | 文案 |
|---|---|
| 1814 | `正在请求 WebGPU 适配器…`（`adapterLabel` 初值，也是 `EMPTY_METRICS.adapter`，组件 73） |
| 1829 | `当前浏览器不支持 WebGPU。请使用较新版本的 Chromium 内核浏览器，并确保已启用硬件加速。` |
| 1837 | `未找到可用的 WebGPU 适配器。` |
| 1845 | `WebGPU 设备已丢失：${info.message \|\| info.reason}` |
| 1850 | `无法创建 WebGPU 画布上下文。` |
| 2298 | `特提斯 uniform 缓冲不可用。` |
| 2508 | `${adapterLabel} · 船体加载失败: ${shipError}` |
| 组件 315 | 启动占位 `正在构建特提斯计算场…` |

---

## 3. 每个 render pipeline 的规格

**全局**：所有 pipeline `layout:"auto"`；**无任何 MSAA**（没有 `multisample`，sampleCount = 1）；深度格式统一 `DEPTH_FORMAT = "depth24plus"`(164)；颜色附件格式统一 `this.format = getPreferredCanvasFormat()`（macOS 上是 `bgra8unorm`，默认字段值见 1742）。

### 3.1 sky（1920-1927 / shader 727-752）

| 项 | 值 |
|---|---|
| 顶点 | `skyVertex`，无 VBO，3 顶点全屏三角形 `(-1,-1),(3,-1),(-1,3)`(734)，**z = 0.999999**(736)，输出 `ndc` 到 location 0 |
| 绑定 | group0/binding0 = WorldUniforms（唯一绑定，bind group 2039） |
| 深度 | `depthWriteEnabled:false, depthCompare:"always"`(1926) |
| 混合 | 无 |
| Cull | 未指定（默认 `"none"`） |
| Draw | `scenePass.draw(3)`(2401)，第一条 |

### 3.2 terrain（1928-1935 / shader 760-884）

| 项 | 值 |
|---|---|
| 顶点 | `terrainVertex`，无 VBO；`resolution = u32(environment.y)`(786)，`cellId = vertexId/6`，`cell = (cellId%res, cellId/res)`，6 角查表 `(0,0),(0,1),(1,0),(0,1),(1,1),(1,0)`(782-785)，`uv = grid/res`；高度来自 `textureSampleLevel(terrainField, fieldSampler, uv, 0)`(791)，world = `((uv.x-0.5)*terrain.x, h, (uv.y-0.5)*terrain.x)`(792) |
| 绑定 group0 | 0 uniform / 1 terrainField / 2 fieldSampler / 3-4 mediumField0,1 (= cascade1) / 5-6 shortField0,1 (= cascade2) / 7 spectrumSampler / 8 waterState（2040-2050，注意 3-6 取的是 `spectralFields[1]`、`spectralFields[2]`） |
| 深度 | `depthWriteEnabled:true, depthCompare:"less"`(1934) |
| Cull | `"none"`(1933) |
| 混合 | 无 |
| Draw | `draw(sceneMeshResolution² * 6)`，`sceneMeshResolution = shore ? 512 : meshResolution`(2404-2405)；shore 场景 = 1 572 864 顶点 |

### 3.3 sceneBlit（1936-1943 / shader 886-907）

| 项 | 值 |
|---|---|
| 顶点 | 3 顶点全屏三角，z = 0.0；**uv = `(x*0.5+0.5, 0.5 - y*0.5)`（Y 翻转）**(900) |
| 绑定 | 0 sceneColor(texture_2d) / 1 sceneSampler（用的是 `fieldSampler`，2250-2253） |
| 深度 | write false / compare always(1942) |
| Draw | 仅 shore 场景，water pass 第一条 `draw(3)`(2414-2418) |

### 3.4 water（optimized / reference，1944-1958 / shader 909-1535）

```ts
waterBase = { layout:"auto",
  vertex:{ module: waterModule, entryPoint:"waterVertex" },
  primitive:{ topology:"triangle-list", cullMode:"none" },
  depthStencil:{ format:"depth24plus", depthWriteEnabled:false, depthCompare:"less" } }   // 1944-1949
waterTarget = { format, blend:{ color:{src-alpha, one-minus-src-alpha},
                                alpha:{one, one-minus-src-alpha} } }                       // 1950-1956
```
* 片元 `waterFragment`，两条 pipeline 唯一差别是 **pipeline-overridable constant** `REFERENCE_MODE`（声明 910，值 0/1，1957-1958）→ WebGL2 用两个 `#define` 变体程序。
* **绑定 group0**（12 项，2083-2096）：0 uniform / 1 terrainField / 2 waterState / 3 fieldSampler / 4-5 long(cascade0)0,1 / 6-7 medium(cascade1)0,1 / 8-9 short(cascade2)0,1 / 10 spectrumSampler / 11 breakerEvents。
* **绑定 group1**（3 项，2254-2258）：0 sceneColorTexture / 1 sceneDepthTexture(`texture_depth_2d`) / 2 sceneColorSampler(= fieldSampler)。
* Draw：`renderPass.draw(64*64*6 = 24576, 10)`(2428) —— 24576 顶点 × 10 实例。

**clipmap 顶点生成（1138-1214）**：
```
resolution = 64                                          (1144)
cellId = vertexId/6; cell = (cellId%64, cellId/64); grid = cell + corners[vertexId%6]; uv = grid/64  (1145-1148)
level = f32(instanceId); halfExtent = 32 * exp2(level)   (1153-1154)   // 32 m … 16384 m
cellSize = halfExtent*2/64                               (1155)
snappedCamera = floor(cameraTime.xz / cellSize) * cellSize (1156)
baseP = snappedCamera + (uv-0.5)*halfExtent*2            (1157)
if (instanceId > 0):                                                     (1158-1166)
   innerHalf = halfExtent*0.5 - cellSize
   cellCenter = snappedCamera + ((cell+0.5)/64 - 0.5)*halfExtent*2
   if all(|cellCenter - snappedCamera| < innerHalf) → baseP = (10000,10000)   // 退化中心
if (instanceId == 9):                                                    (1173-1180)
   onHorizonSkirt = grid.x==0 || grid.x==64 || grid.y==0 || grid.y==64
   若是：outward = baseP - snappedCamera; reach = max(|outward.x|,|outward.y|)
        baseP = snappedCamera + outward * (20000 / max(reach,1))
```
再经 `adaptiveBreakerCoordinates()` 变形(1183-1185，`BREAKER_ENABLED=false` 时 concentration=0，等价恒等映射，但 `tanh` 的 clamp(±30) 必须保留 1041)，`evaluateWaterSurface(p)`(1186) 得到位移面，切线经链式法则复合(1187-1188)。
天际裙边顶点特殊投影(1191-1200)：`towardHorizon = world - eye; towardHorizon.y = 0; clip = viewProj * vec4(towardHorizon, 0.0); clip.z = clip.w * 0.99999`。

### 3.5 breaker patch（optimized / reference，1959-1964 / shader 1241-1285）

* 继承 `waterBase`，只换 `entryPoint:"breakerPatchVertex"`(1961)；片元仍是 `waterFragment`。
* 顶点：`alongResolution = 256`、`acrossResolution = 48`(1246-1247)；`along = mix(-180,180,uv.x)`、`across = mix(-12,12,uv.y)`(1252-1253)。
* Draw `256*48*6 = 73728`(2439)，**但 `BREAKER_ENABLED = false`(185) 使 `drawBreakerPatch` 恒为 false**(2429)，所以当前从不执行。`BREAKER_SHADER_GATE = "0.0"`(186) 也把着色器内所有碎波项乘 0。
  > **WebGL2 移植建议**：碎波路径整条可以先不实现，但 `waterFragment` 里 1288-1291 的 discard 分支必须保留其数学等价（在 gate=0 时 `patchVisible=0` → 两条 discard 都不触发）。

### 3.6 ship（`ship-renderer.ts:191-210`）

| 项 | 值 |
|---|---|
| 顶点 | **唯一有 VBO 的 pipeline**：`arrayStride = 32`，attr0 float32x3 @0（position）、attr1 float32x3 @12（normal）、attr2 float32x2 @24（uv）(197-204) |
| 索引 | `uint32`，`drawIndexed(indexCount)`(325-326) |
| 绑定 group0 | 0 WorldUniforms / 1 shipTransform（`var<storage, read>`，128 B = 2×mat4）(212-219) |
| 绑定 group1 | 0 baseColor / 1 normal / 2 arm(ORM) / 3 materialSampler / 4 MaterialParams(16 B)(280-290) |
| Cull | `"none"`（资产全双面）(208) |
| 深度 | write true / less(209) |
| 混合 | 无（alpha 用 `discard` 做 MASK，shader 187） |
| 录制位置 | scene pass 内、terrain 之后(2406) |

### 3.7 渲染目标结构与 renderScale

* `resize()`(2235-2263)：
  ```
  maximumDpr = benchmark ? 1 : 1.5                       (2238)
  dpr = min(devicePixelRatio||1, maximumDpr) * renderScale (2239)
  width  = max(1, floor(canvas.clientWidth  * dpr))       (2240)
  height = max(1, floor(canvas.clientHeight * dpr))       (2241)
  非 force 且尺寸未变则直接 return                          (2242)
  canvas.width/height = …（即改后备缓冲，CSS 尺寸不变）      (2243-2244)
  ```
  → **不存在独立的低分辨率离屏 buffer**；`renderScale` 直接缩放 swapchain 与全部附件，靠浏览器合成时放大。
* `depthTexture`：`[w,h] depth24plus, RENDER_ATTACHMENT|TEXTURE_BINDING`(2247)
* `sceneColorTexture`：`[w,h] format, RENDER_ATTACHMENT|TEXTURE_BINDING`(2248)
* **scene pass**(2393-2407)：
  * color = `shore ? sceneColorTexture.createView() : swapchainView`(2395)，`clearValue {0.18,0.45,0.49,1}`，`loadOp:"clear"`, `storeOp:"store"`
  * depth = `depthTexture`，`depthClearValue:1, depthLoadOp:"clear", depthStoreOp:"store"`(2396)
  * 即：**open 场景直接画到屏幕，不做捕获**；shore 场景才画到中间纹理。
* **water pass**(2408-2413)：
  * color = 永远是 swapchainView，`loadOp = shore ? "clear" : "load"`(2410)
  * depth = `{ view: depthTexture, depthReadOnly: true }`(2411) —— 复用 scene pass 的深度做遮挡但只读
  * shore 时先 blit 中间纹理再画水(2414-2418)

---

## 4. 着色器逻辑说明（可一比一改写 GLSL）

### 4.0 共享片段（`shared-wgsl.ts`）

* **`WorldUniforms`**(6-31)：`mat4 viewProj` + 12 个 `vec4`，共 **256 B**，std140 兼容，可直接映射为 WebGL2 UBO。字段语义（写入见 `webgpu-water-engine.ts:2300-2317`）：

| float 偏移 | 字段 | 内容 |
|---|---|---|
| 0..15 | `viewProj` | `multiply(perspective, lookAt)`(2292) |
| 16 | `cameraTime` | `xyz = eye`，`w = elapsedSeconds` |
| 20 | `cameraRight` | `xyz = right`，`w = tan(26°) * aspect` |
| 24 | `cameraUp` | `xyz = up`，`w = tan(26°)` |
| 28 | `cameraForward` | `xyz = forward`，`w = 0` |
| 32 | `sunWater` | `xyz = normalize(-0.52, 0.30, -0.80)`，`w = 1.4`（水位） |
| 36 | `terrain` | `x = 520`(TERRAIN_EXTENT)，`y = meshResolution`(**着色器未用**)，`z = simulationResolution`(**未用**)，`w = underwater?1:0` |
| 40 | `simulation` | `xy = (0,-12)` 场中心，`z = 192` 场边长(m)，`w = 1/simulationResolution` |
| 44 | `player` | `xy = 位置`，`zw = 速度` |
| 48 | `interaction` | `x = 速度模`，`y = 1`，`z = canvas.width`，`w = canvas.height` |
| 52 | `environment` | `x = shore?1:0`，`y = 地形网格分辨率`(shore 时 512)，`z = 同 y`(**未用**)，`w = worldScale = 100` |
| 56 | `waves` | `x = waveScale`，`y = waveScale²`，`z = distantRoughness`，`w = detailRange` |
| 60 | `atmosphere` | `x = fogReach`，`y = swellSmoothing`，`z = longCascadeScale`，`w = mediumCascadeScale` |

* `linearToSrgb`(34-36)、`aces`(38-40) —— **所有片元着色器最后都是 `linearToSrgb(aces(color))`**，写入非 sRGB UNORM 目标。WebGL2 必须同样禁用 framebuffer sRGB 转换。
* `cloudHash3`(42-46) / `cloudNoise3`(48-63) / `skyColor(direction, time, sunDirection)`(65-90)。
* `tethysAerialColor(color, world, cameraPos, worldScale, underwater, dryLand)`(93-118)：
  ```
  density = underwater ? 0.0075 : 0.00155 / worldScale                     (99)
  fog = 1 - exp(-max(dist - (underwater ? 2.0 : 20.0*worldScale), 0) * density) (100)
  oceanRadialFog = fogReach<=0 ? 0 : smoothstep(116*ws*fr, 145*ws*fr, |world.xz|) (107-111)
  islandRadialFog = smoothstep(166*ws, 205*ws, radial) * 0.58              (112)
  fog = clamp(fog + mix(oceanRadial, islandRadial, dryLand), 0, mix(0.99,0.72,dryLand)) (113)
  waterAerial = underwater ? (0.012,0.205,0.185) : (0.42,0.66,0.71)        (114)
  aerial = mix(waterAerial, (0.24,0.39,0.43), dryLand)                     (115)
  return mix(color, aerial, fog)                                          (116)
  ```
  注意此函数**直接引用全局 `uniforms.atmosphere.x`**(107)，不是参数 —— GLSL 移植时同样要在 UBO 可见处内联。

### 4.1 sky 片元（741-751）

```
ray = normalize(cameraForward.xyz
      + ndc.x * cameraRight.xyz * cameraRight.w
      + ndc.y * cameraUp.xyz    * cameraUp.w)                  (742)
color = skyColor(ray, time, normalize(sunWater.xyz))           (743)
若 underwater (terrain.w>0.5)：                                 (744-749)
  upward = smoothstep(-0.42, 0.72, ray.y)
  volume = mix((0.012,0.155,0.158), (0.050,0.385,0.335), upward)
  lightColumn = pow(max(dot(ray,sunDir),0),14) * upward
  color = volume + (0.18,0.30,0.23)*lightColumn*0.22
return vec4(linearToSrgb(aces(color)), 1.0)                    (750)
```
`skyColor` 内部要点（shared-wgsl 65-90）：天顶渐变 `mix((0.34,0.54,0.64),(0.070,0.26,0.43), smoothstep(-0.035,0.34,y))`(70)；地平线压暗(71)；太阳晕 `pow(sunDot,4)*exp(-|y|*12)*0.12`(73-74) 与 `pow(sunDot,20)*0.08`(75)；三层 3D 值噪声云 `0.54/0.29/0.17` 权重(78-80)，包络 `smoothstep(-0.045,0.018,y) * (1-smoothstep(0.30,0.43,y))`(81)，云体/云核/云边三段(82-84)，漂移速度 `(0.0040, -0.0014, 0.0023)*time`(76)。

### 4.2 terrain 片元（800-883）

关键链路（顺序不可换）：
1. 法线重建：`normalY = sqrt(1 - g² - b²)`，`N = normalize(g, normalY, b)`(802-803)；`diffuse = clamp(dot(N,L)*0.56 + 0.48, 0, 1)`(805)。
2. 6 层 `valueNoise` 采样构成沙/岩/沉积（broad 0.075、grain 0.38、geology 0.021、erosion 各向异性、sedimentMacro 0.018、sedimentMeso）(807-812)。
3. 近岸场耦合：`simulationUv = (p - simulation.xy)/simulation.z + 0.5`，`inSimulation` 四段 step(813-815)；`localWaterLevel = sunWater.w + clamp(shoreState.r, -0.16, 0.18) * inSimulation * environment.x`(817-818)。
4. 湿沙 / 干沙 / 岩石三套调色，用 `exposed`(825)、`coast`(847)、`solverWash`(848-850) 三个 mask 逐层 mix(853-855)。
5. **焦散**(856-877)：沿折射太阳方向偏移 `L.xz/max(L.y,0.12)*depth*0.18`(859)，采 medium + short 两级谱的 Jacobian，`surfaceFocus = max(0,1-J_med)*0.48 + max(0,1-J_short)*0.52`(873)，`focusedLight = pow(smoothstep(0.060,0.27,focus),2) * smoothstep(0.6,2.2,depth) * (1-smoothstep(11,20,depth))`(874-875)，乘 `0.94 + 0.14*focusedLight` 并加 `(0.095,0.105,0.045)*focusedLight*0.060`(876-877)。
6. `tethysAerialColor(..., dryLand = exposed*(1-underwater))`(878-881) → `linearToSrgb(aces(color))`(882)。

### 4.3 water 顶点面求值 `evaluateWaterSurface`（1075-1136）—— 顶点与片元共用

```
fieldUv         = clamp(p/terrain.x + 0.5, 0, 1)                                  (1076)
depth           = sunWater.w - terrain.r                                          (1078)
shallowAttenuation = smoothstep(0.14, 2.7, depth)                                 (1079)
simUv           = (p - simulation.xy)/simulation.z + 0.5                          (1080)
longUv          = fract(p/atmosphere.z + 0.5)   // 长浪 tile                       (1081)
mediumUv        = fract(p/atmosphere.w + 0.5)                                     (1082)
long0/1, medium0/1 = textureSampleLevel(...) * waves.x                             (1083-1086)
horizontalDisplacement = long0.rg*1.18 + medium0.rg*1.05      // choppiness        (1087)
spectralHeight = longH + medH + 0.14*(longH² - 0.080*waves.y)
                              + 0.32*(medH²  - 0.030*waves.y)  // 束缚谐波          (1090-1092)
crossDerivative = long0.a*1.18 + medium0.a*1.05                                    (1093)
longSlope   = long1.rg  * (1 + 0.28*longH)                                        (1094)
mediumSlope = medium1.rg* (1 + 0.64*medH)                                         (1095)
horizontalDerivative = long1.ba*1.18 + medium1.ba*1.05                             (1097)
近岸场中心差分：texel = simulation.w，四邻采样 → simulationDerivative                 (1099-1105)
simulationCoverage = step(0, edge) * smoothstep(0.008, 0.055, edge)               (1106-1107)
baseJacobian = (1+hd.x)(1+hd.y) - cross²                                          (1108)
nearshoreOwnership = simulationCoverage * (1 - smoothstep(3.8, 5.55, depth))      (1116)
wave  = mix(spectralHeight*atten, sim.r, ownership) + breaker.y                   (1117)
world = (p.x + hDisp.x*atten + breaker.x,  sunWater.w + wave,
         p.y + hDisp.y*atten + breaker.z)                                          (1118-1122)
blendedSlope = mix(spectralSlope*atten, simulationDerivative, ownership)          (1123)
tangentPX = (1 + hd.x*atten + bdx.x,  slope.x + bdx.y,  cross*atten + bdx.z)      (1124)
tangentPZ = (cross*atten + bdz.x,     slope.y + bdz.y,  1 + hd.y*atten + bdz.z)   (1125)
compression = max(0, 1-baseJacobian)*atten + breaker.w*0.38                       (1133)
```
顶点法线：`normalize(cross(tangentZ, tangentX))`(1205)（注意参数顺序）。
choppiness 常量来自 `SPECTRAL_CASCADES`(209-215)：cascade0 = 1.18、cascade1 = 1.05、cascade2 = 0.40；tile 默认 240 / 64 / 12 m。

### 4.4 water 片元 `waterFragment`（1287-1535）—— 逐段公式

**(a) 碎波带交接 discard**（1288-1291）：主面在 patch 覆盖区 discard，patch 在区外 discard。gate=0 时两者均不触发。

**(b) 岸线覆盖 / discard**（1299-1312）
```
displacedTerrainUv = clamp(world.xz/terrain.x + 0.5, 0, 1)                (1299)
waterColumn = world.y - terrain.r                                        (1304)
shorelineWidth = clamp(fwidth(waterColumn), 0.006, 0.06)                 (1305)
shorelineThreshold = mix(0.018, 0.28, environment.x)                     (1309)
shorelineCoverage = smoothstep(thr-width, thr+width, waterColumn)        (1310)
if (shorelineCoverage < 0.01) discard;                                   (1311)
depth = max(waterColumn, 0.018)                                          (1312)
```
`shorelineCoverage` **就是最终输出的 alpha**(1534)。

**(c) 屏幕空间采样率淡出（关键，决定远景观感）**（1328-1367）
```
pixelWorldSize  = eyeDistance * 2 * cameraUp.w / max(interaction.w, 1)   (1330)
pixelsPerWave   = 12.0 / 12.0 / pixelWorldSize        // cascade2 tile=12 m, 峰值波长≈tile/12 (1332)
shortDistanceFade = smoothstep(3, 14, pixelsPerWave * detailRange)       (1333)
mediumPixelsPerWave = atmosphere.w / 8  / pixelWorldSize                 (1360)
mediumFadeF = swellSmoothing<=0 ? 1 : smoothstep(3,14, mppw*detailRange/max(ss,0.001)) (1362)
longPixelsPerWave   = atmosphere.z / 5  / pixelWorldSize                 (1363)
longFadeF   = 同上                                                       (1364)
```
**(d) 逐片元法线细化**（1345-1384）：从 `simulationUv` 反解未位移参数 `surfaceParam = (simUv-0.5)*simulation.z + simulation.xy`(1345)，用它重采 3 级谱 + 近岸导数，重建 `tangentXF/tangentZF`(1378-1379)，`baseNormal = normalize(cross(tangentZF, tangentXF))`(1382)；**breaker patch 例外，用顶点法线**(1383)；再叠加毛细坡度 `N = normalize(baseNormal + vec3(-shortSlope.x, 0, -shortSlope.y)*0.42)`(1384)。

**(e) 方差回收（distantRoughness）**（1393-1397）
```
fadedSlope = |short1.rg|*(1-shortFade) + |medium1F.rg|*(1-medFade) + |long1F.rg|*(1-longFade)
recoveredVariance = fadedSlope² * waves.z
surfaceRoughness  = mix(0.035, 0.115, smoothstep(0.012, 0.30, |shortSlope| + fadedSlope*waves.z))
```
水下时 `N *= -1`(1399)。

**(f) Fresnel / 折射**（1400-1442）
```
V = normalize(eye - world); L = normalize(sunWater.xyz); ndv = |dot(N,V)|        (1400-1402)
fresnel = dielectricFresnel(ndv)      // 精确 Fresnel，eta=1/1.333，全内反射返回1  (960-968)
refractedOffset = N.xz * depth * mix(0.42, 1.25, 1-ndv)                          (1406)
floorColor = ((0.46,0.37,0.225) + sandVariation) * mix(0.70, 1.02, floorLight)   (1408-1409)
screenUv = position.xy / max(interaction.zw, 1)                                  (1410)
refractionUv = clamp(screenUv + vec2(N.x, -N.z)*(0.0025 + min(depth,14)*0.00072), 0.001, 0.999) (1411)
若 environment.x > 0.5（shore）：                                                 (1413-1429)
  capturedDepth  = textureLoad(sceneDepthTexture, coord, 0)
  capturedLinear = pow(textureSample(sceneColorTexture, sampler, refractionUv).rgb, 2.2)
  capturedGeometry = 1 - step(0.9995, capturedDepth)
  captureCoverage  = 1 - smoothstep(6.5, 8.5, depth)
  floorColor = mix(floorColor, capturedLinear, capturedGeometry*captureCoverage*0.88)
opticalDepth = underwater ? max(0, sunWater.w - eye.y)/max(|dot(N,V)|,0.32)
                          : depth/max(ndv,0.28)                                  (1430)
absorption   = (0.37, 0.125, 0.054);  transmission = exp(-absorption*min(od,24)) (1431-1432)
scatterColor = (0.0035, 0.096, 0.092)                                            (1435)
phaseG = 0.24; phase = (1-g²)/pow(max(1+g²-2g*cos, 0.04), 1.5)                   (1437-1439)
refracted = floorColor*transmission + scatterColor*(1-transmission)*(0.72 + phase*0.060) (1440)
refracted = mix(refracted, scatterColor, smoothstep(3,15,od)*0.08)               (1441-1442)
```

**(g) 反射**（1443-1466）
```
reflected = skyColor(reflect(-V, N), time, L)                                    (1443-1444)
若 REFERENCE_MODE：额外 2 个抖动方向 tap，权重 0.64/0.18/0.18                      (1445-1449)
reflectionSpread = sqrt(recoveredVariance) * 1.9                                 (1455)
若 spread > 0.002：3 个锥形 tap，权重 0.40 + 0.20*3                                (1456-1463)
reflected *= mix((0.70,0.77,0.80), (0.76,0.81,0.83), surfaceRoughness)           (1466)
```

**(h) 合成 + 浅水**（1467-1479）
```
reflectionWeight = underwater ? fresnel*0.07 : fresnel                           (1469)
shoreShallows = environment.x * (1 - smoothstep(0.12, 1.02, depth))              (1470)
shallowTransmission = capturedLinear*(0.66,0.62,0.52) + (0.004,0.013,0.011)*smoothstep(0.10,0.90,depth) (1474-1475)
refracted = mix(refracted, shallowTransmission, shoreShallows*0.76)              (1476)
reflectionWeight *= (1 - shoreShallows*0.56) * mix(1, 0.38, nearSwimmer*interaction.y) (1477-1478)
color = mix(refracted, reflected, clamp(reflectionWeight, 0, 0.92))              (1479)
```

**(i) 泡沫**（1482-1517）
```
wakeRibbon = exp(-(|横向距离|/0.64)²) * (1-smoothstep(0.8,6.5,dist)) * behind     (1485)
wake       = wakeRibbon * smoothstep(0.5,5.5,interaction.x) * interaction.y      (1486)
crestHeight= smoothstep(0.27, 0.72, waveHeight)                                  (1487)
surfaceCompression = input.compression + max(0,1-shortJacobian)*shortFade*0.62   (1491)
crestPinch = smoothstep(0.16, 0.34, surfaceCompression)                          (1492)
crestVariation = 3 层 valueNoise(0.37/1.41/3.7 频率，权重 0.55/0.30/0.15，随时间漂移) (1493-1495)
crestBreakup   = smoothstep(0.60, 0.80, crestVariation)                          (1496)
crestDistanceFade = 1 - smoothstep(95*detailRange, 188*detailRange, eyeDist)     (1497)
whitecap = max(crestHeight*pow(crestPinch,4)*crestBreakup, breakerFoam*0.78) * crestDistanceFade (1500)
persistentFoam = state.a*0.58*foamBreakup*(1-environment.x)                      (1505)
shoreStateFoam = environment.x * activeSwash * swashDepth * foamBreakup * 0.62   (1509-1512)
foam = max(max(max(persistentFoam, shoreStateFoam), wake*0.16), whitecap)        (1513)
visibleFoam = mix(smoothstep(0.16,0.66,foam), smoothstep(0.055,0.40,foam), environment.x) (1514)
foam = underwater ? 0 : visibleFoam                                              (1515)
foamCoverage = max(clamp(foam*0.21, 0, 0.145), breakerFoam*0.22)                 (1516)
color = mix(color, (0.80,0.88,0.84), clamp(foamCoverage, 0, 0.22))               (1517)
```

**(j) 太阳闪光 + 雾 + 输出**（1518-1534）
```
sunGlitter = oceanSunGlitter(N, V, L, recoveredVariance)                          (1518, 定义 975-996)
  —— Cox-Munk 各向异性斜率分布：alongVariance = 0.0363 + extra, acrossVariance = 0.0251 + extra (989-990)
     风向 windWorld = normalize(0.887, 0, -0.462)(980)，Smith 可见性 msSlope = 0.0307 + extra(994)
color += (1.0, 0.91, 0.70) * min(sunGlitter*0.070, 0.34) * (underwater ? 0.08 : 1) (1519)
若 underwater：color = mix(color, (0.012,0.205,0.190), 0.42 + min(dist,22)/22*0.12) (1520-1523)
若 !underwater：color = tethysAerialColor(color, world, eye, environment.w, false, 0.0) (1531-1533)
return vec4(linearToSrgb(aces(color)), shorelineCoverage)                         (1534)
```

### 4.5 ship 着色（`ship-shaders.ts:112-232`）

* 顶点(143-155)：`world = shipTransform.model * vec4(pos,1)`，`position = viewProj * world`，法线用 `normalMatrix`（正交，无需逆转置，注释 96-97）。
* 片元(185-231)：alpha MASK `discard`(187)；ORM 通道 = `arm.r` AO / `arm.g` roughness / `arm.b` metallic(190-192)；**逐片元切线重建** `perturbNormal()`(157-169) 用 `dpdx/dpdy(world)` 与 `dpdx/dpdy(uv)`；UV 足迹过大时淡出扰动 `tangentTrust = 1 - smoothstep(0.012, 0.055, uvFootprint)`(200-202)；背面法线翻转 `if (dot(N,V)<0) N = -N`(206)；GGX 高光(171-183)，`sunColor = (1.0,0.955,0.88)*5.6`(215)，半球环境光 `mix(waterBounce(0.24,0.46,0.47), skyAmbient(0.62,0.74,0.88), N.y*0.5+0.5)`(222-224)，AO 部分应用 `mix(1, occlusion, 0.72)*1.25`(227)；最后同样 `tethysAerialColor` + `linearToSrgb(aces())`(229-230)。

---

## 5. 船体与浮力

### 5.1 glTF 加载（`gltf-loader.ts`）

* `loadGltf(url)`(158-219)：只支持 **.gltf + 单个外部 .bin**（GLB / data-URI 明确报错 166）；`asset.version` 必须 `"2.0"`(161)；只接受 `mode === 4`(TRIANGLES, 177)、必须有 `POSITION`(179) 与 `indices`(180)；NORMAL / TEXCOORD_0 缺失时填零(184-189)。
* `readAccessor()`(92-117) 支持 6 种 componentType(35-42) 与 SCALAR/VEC2/3/4(44)，**尊重 `byteStride`**(102)，越界检查(105-106)，统一输出 `Float64Array` 再转 `Float32Array`/`Uint32Array`。
* 材质(126-140)：`baseColorUri / normalUri / metallicRoughnessUri`(131-134，只取 URI 不做 IO)、`alphaMode`(129)、`alphaCutoff` 默认 0.5、`metallicFactor`/`roughnessFactor` 默认 1；URI 在 201-212 处拼上 `baseDirectory(url)`。
* 返回值含全模型 AABB `min/max`(171-172, 192-198)。

### 5.2 ShipRenderer 创建（`ship-renderer.ts:163-306`）

1. `loadGltf(modelUrl)`(165)。
2. `transformBuffer`：128 B，`usage: STORAGE`（**无 COPY_DST，纯 GPU 写**）(167-171)。
3. 半长 / 半宽从模型包围盒推出：`halfLength = max(max[0]-min[0],1)*0.5`、`halfBeam = max(max[2]-min[2],1)*0.5`(175-176)。
4. `placementBuffer`(UNIFORM, `[centreX, centreZ, heading, draft]`)(177-179)、`hullSpanBuffer`(UNIFORM, `[halfLength, halfBeam, longScale, mediumScale]`)(180-182)。
5. compute pipeline `buildShipTransform`(184-189)、render pipeline(190-210)。
6. 每 primitive：3 张纹理（缺省用 1×1 fallback：base `(200,200,200,255)` sRGB、normal `(128,128,255,255)`、ARM `(255,200,0,255)`，233-236），按 URI 去重缓存(239-248)；材质 UBO 16 B `[alphaCutoff, isMask, metallic, roughness]`(258-268)；顶点交错为 stride 32(70-85)。

### 5.3 浮力：**完全不回读 CPU**

`SHIP_TRANSFORM_SHADER`(ship-shaders 33-105) 是 `@workgroup_size(1)` 的单线程 compute：
```
5 个探针高度：centre / ±forward*halfLength / ±starboard*halfBeam        (57-61)
shipWaveHeight() 只采 long+medium 两级，含与水面完全一致的束缚谐波修正      (13-25)
heave = (hCentre*2 + hFore + hAft + hPort + hStarboard) / 6              (66)
trim  = atan2(hFore - hAft, 2*halfLength) * 0.55                        (68)
heel  = atan2(hStarboard - hPort, 2*halfBeam) * 0.45                    (69)
yaw→trim→heel 复合旋转，列主序写入 model / normalMatrix 两个 mat4         (80-103)
平移 = (centre.x, waterLevel + heave + placement.w /*draft*/, centre.y)  (94)
```
结果写入 storage buffer，**同一帧内**由 ship vertex shader 以 `var<storage, read>` 读取。时序保证：`ship.updateTransform(computePass)` 在 compute pass 末尾(2389)，`ship.render(scenePass)` 在其后的 render pass(2406)，WebGPU 自动插入 barrier。

> **WebGL2 对应**：没有 storage buffer 也没有 compute。三条可行路径：
> (1) 在 CPU 复算 `shipWaveHeight`（需要一份 CPU 侧的谱高度场，代价高）；
> (2) 用 1×2 的 RGBA32F FBO 跑一个 2 像素片元 pass 产出两个 mat4，vertex shader 用 `texelFetch` 读（等价且最省事，推荐）；
> (3) `gl.readPixels` 回读 5 个探针高度到 CPU 再算矩阵传 uniform —— 会引入同步停顿，不推荐。

### 5.4 摆位（`SHIP_PLACEMENTS`，engine 145-159）

* `open`: centre `[7, -12]`，heading `2.60`，draft `-0.65`
* `shore`: centre `[50, 60]`，heading `3.12`，draft `-0.65`
* 切场景时 `setPlacement()`(157-161) 只重写 uniform buffer；改 cascade 尺度时 `setCascadeScales()`(151-155) 重写 hullSpan.zw。
* `bindSpectralFields()`(142-144) 在 `allocateFields()` 后被调用(2111-2117)，否则会持有已销毁的纹理视图。

---

## 6. demo 组件集成（`src/components/webgpu-water-lab-experience.tsx`）

### 6.1 生命周期

* 单个 `useEffect(..., [])`(101-200)：
  * 读 URL query 并钳制（104-126），全部参数：`mode / view / scene / mesh / simulation / scale / waves / farRough / detail / smooth / fog / longScale / mediumScale / fixedTime / yaw / pitch / benchmark / ui`。
  * `new WebGpuWaterEngine(canvas, {...})`(140-159)，**`shipModelUrl` 硬编码为 `/models/dutch_ship_medium/dutch_ship_medium_2k.gltf`**(158)。
  * 挂 `window.__WEBGPU_WATER_LAB__` 桥（类型 17-34，实现 161-178），供 `scripts/benchmark.mjs` / `visual-gate.mjs` / `capture-screenshots.mjs` 驱动。
  * `void engine.init().then(...).catch(...)`(183-191)，用 `cancelled` 标志防 StrictMode 双挂载(182)；`catch` 把消息塞进 `metrics.error`(190)。
  * `setInterval(() => setMetrics(engine.getMetrics()), 250)`(192) —— **UI 更新与渲染完全解耦**。
  * cleanup(193-199)：`cancelled = true` → `clearInterval` → `engine.dispose()` → `delete window.__WEBGPU_WATER_LAB__`。
* **组件内没有 requestAnimationFrame**；rAF 在引擎内部(1892, 2468)。

### 6.2 控件 → setter 映射

| UI | 行 | 调用 |
|---|---|---|
| 优化路径 / 参考对照 | 225-226 | `setMode("optimized"｜"reference")` |
| 水面上 / 水面下 | 234-235 | `setView("surface"｜"underwater")` |
| 开阔水域 / 岛屿海岸 | 242-243 | `setScene("open"｜"shore")` |
| 质量档位（3 个预设） | 250 → 205-212 | `setMeshResolution + setSimulationResolution + setRenderScale` |
| 水面网格 96-320 step8 | 257 | `setMeshResolution` |
| 近岸场 128-512 step64 | 261 | `setSimulationResolution` |
| 长浪尺度 80-480 step10 | 265 | `setLongCascadeScale` |
| 中浪尺度 24-128 step4 | 269 | `setMediumCascadeScale` |
| 浪高 0.15-1.6 step0.05 | 273 | `setWaveScale` |
| 细节距离 0.4-8 step0.1（显示 `detailRange*118` m） | 277 | `setDetailRange` |
| 远景平滑 0-3 step0.05 | 281 | `setSwellSmoothing` |
| 远景粗糙度 0-3 step0.05 | 285 | `setDistantRoughness` |
| 雾距 0-3 step0.05（显示 `fog*145*100` m） | 289 | `setFogReach` |
| 渲染缩放 0.5-1.25 step0.05 | 293 | `setRenderScale` |

指标面板 297-309；适配器串 311；错误 / 启动遮罩 315；QA 输出 `<output id="webgpu-water-lab-qa" data-ready=…>` 316（脚本用它判断就绪）。

### 6.3 「后端自动降级 + 显示当前后端」最小侵入接入点

推荐改动**只有 3 处**，UI 结构不变：

1. **新增工厂**（新文件，如 `src/lib/create-water-engine.ts`）：
   ```ts
   export type WaterBackend = "webgpu" | "webgl2";
   export interface WaterEngineLike { /* 与 WebGpuWaterEngine 完全同名的公共方法 */ }
   export async function createWaterEngine(canvas, options): Promise<{ engine: WaterEngineLike; backend: WaterBackend }>
   ```
   内部：`if (navigator.gpu) { try { const e = new WebGpuWaterEngine(...); await e.init(); return {...} } catch { /* 必须先 e.dispose() 再降级 */ } }` → 回落 `WebGl2WaterEngine`。
   **注意 canvas 只能取一次 context**：WebGPU `configure` 失败后同一个 `<canvas>` 无法再 `getContext("webgl2")`。因此降级时必须由调用方替换 canvas 节点，或工厂内部先做 `navigator.gpu.requestAdapter()` 探测再决定用哪个 context —— 建议**探测优先**（`requestAdapter()` 返回 null 或 throw 即判定降级），只有在 `getContext("webgpu")` 之前分流才安全。

2. **组件第 140 行**：把 `new WebGpuWaterEngine(canvas, {...})` + 第 183 行的 `engine.init()` 合并为 `await createWaterEngine(canvas, {...})`，把返回的 `backend` 存进 state。`engineRef`、`window.__WEBGPU_WATER_LAB__`（17-34 的桥接口）、cleanup（193-199）**一行都不用改**，因为方法名一致。

3. **显示后端**，二选一：
   * **零 UI 改动方案**：在降级引擎里把 `adapterLabel` 直接写成 `"WebGL2 · <GL_RENDERER>"`（对应 WebGPU 的 1848），第 311 行的 `{metrics.adapter}` 自动显示。
   * **显式字段方案**：`WaterLabMetrics` 增加 `backend: WaterBackend`（类型 57-90 与 `EMPTY_METRICS` 42-75 同步补），面板 297-309 的 `<dl>` 里加一项 `<div><dt>后端</dt><dd>{metrics.backend}</dd></div>`。

   > `getMetrics()` 里 `gpuSimulationMeanMs` 等已经是 `number | null`(83-86)，WebGL2 无 timestamp query 时返回 `null` 不会破坏 UI（307-308 已处理 `null` → `"—"`）。

---

## 7. 测试与构建

### 7.1 npm scripts（`package.json:33-48`）

| 命令 | 内容 |
|---|---|
| `npm run dev` | `next dev` |
| `npm run build` | `next build` |
| `npm start` | `next start` |
| `npm run lint` | `eslint .`（配置 `eslint.config.mjs`，忽略 `.next/ .vercel/ benchmarks/ docs/screenshots/ next-env.d.ts`） |
| `npm test` | **`vitest run`**（vitest ^4.1.10，无 vitest.config，走默认 `**/*.test.ts`） |
| `npm run check` | `lint && test && build` |
| `npm run build:lib` | `tsup src/index.ts src/three/index.ts src/three/globe-water.ts src/three/spectral-waves.ts src/three/buoyancy.ts src/three/surface.ts --format esm --dts --clean --target es2022 --platform browser --treeshake --splitting --external three … --tsconfig tsconfig.lib.json` |
| `npm run release:check` | `check && build:lib && npm pack --dry-run` |
| `npm run benchmark` | `build && node scripts/benchmark.mjs` |
| `npm run screenshots` | `build && node scripts/capture-screenshots.mjs` |
| `npm run visual:baseline` / `visual:gate` | `build && [WATER_VISUAL_BASELINE=1] node scripts/visual-gate.mjs` |

### 7.2 tests/ 形态

**纯 vitest 单元测试，无 DOM、无 WebGPU、无 Playwright runner**（`@playwright/test` 只被 `scripts/*.mjs` 以库形式 import）：

* `tests/water-profiles.test.ts`(23 行)：预设分辨率契约、`waterSimulationBytes(256)===1048576`、`waterTriangleCount(176)===123904`。
* `tests/package-api.test.ts`(21 行)：`WebGpuWaterEngine` 是函数、默认 `mode==="optimized"`、`shipModelUrl===null`、常量导出稳定。
* `tests/nearshore-reference.test.ts`(39 行)：以 `src/lib/nearshore-reference.ts` 的 CPU 镜像做数值契约（静水保持、底阶梯 well-balanced、干湿前沿非负、两格守恒）。
* `tests/three-package-api.test.ts`(81 行)：Three.js 适配层 API。

> **降级引擎的测试落点**：`nearshore-reference.ts`(66-98 `stepNearshoreCell`) 是「GPU 数学的 CPU 镜像」这一模式的样板 —— WebGL2 版本应复用同一份 CPU 参考做数值对拍，并在 `tests/` 里加一个 `webgl2-engine-api.test.ts` 断言公共方法签名与 WebGPU 版逐一对应（可用 `Object.getOwnPropertyNames(Class.prototype)` 做集合比较）。

### 7.3 tsconfig / 库构建范围

* `tsconfig.json`：`target ES2017`、`strict: true`、`noEmit: true`、`moduleResolution: "bundler"`、`paths: {"@/*": ["./src/*"]}`，`include` 覆盖全仓库 `**/*.ts(x)`。
* `tsconfig.lib.json`（4 行 compilerOptions + include/exclude）：
  ```
  extends ./tsconfig.json；incremental:false, noEmit:false, plugins:[]
  include: ["src/index.ts", "src/lib/**/*.ts"]
  exclude: ["node_modules", ".next", "tests"]
  ```
  → **新增的 `src/lib/webgl2-water-engine.ts` 会自动进入库构建的类型检查范围**；只要从 `src/index.ts` 导出就会随 `dist` 发布。注意 `src/lib/*.ts` 里目前只有 `webgpu-water-engine.ts` 依赖 `@webgpu/types`（顶部 `/// <reference types="@webgpu/types" />` 第 1 行），WebGL2 版本不应引入 WebGPU 类型，以免包消费者被迫安装。
* `package.json` exports 两个入口：`"."` → `dist/index.js`，`"./three"` → `dist/three/index.js`；`files: ["dist", "THIRD_PARTY_NOTICES.md"]`。

### 7.4 benchmark / visual gate（对降级引擎同样适用的驱动方式）

* `scripts/benchmark.mjs`：起 `next start`(28-32) → Playwright chromium 带 `--enable-unsafe-webgpu --use-angle=metal …`(74) → 9 个 case(16-26) → 等 `window.__WEBGPU_WATER_LAB__.ready===true && getMetrics().error===null`(84) 与 `gpuTimestampSamples>=8`(85) → 1.2 s 预热 → `resetMetrics()` → 240 个 rAF 间隔采样(89-111) → 门限(126-148: fps≥58、mean≤17.5 ms、p95≤20 ms、0 次 >50 ms hitch、simulationBytes≤4 MiB、优化路径 GPU 时间必须优于 reference、shore-dense GPU ≤12 ms、零 console/page error)。
  > **降级引擎必须把 `gpuTimestampSamples` 这一等待条件考虑进去**：WebGL2 拿不到 timestamp，脚本第 85 行会超时。要么在降级路径下让脚本跳过该等待，要么让降级引擎把 `gpuTimestampSamples` 报成一个满足条件的哨兵值（不推荐）。
* `scripts/visual-gate.mjs`：`fixedTime=8.25` 下 optimized vs reference 逐像素比对，阈值 `mismatchRatio ≤ 0.08 / MAE ≤ 3.5 / p95 ≤ 9`(15-19)。这套正好可以复用为 **WebGPU vs WebGL2 的视觉对拍**（把 65 行的 `["reference","optimized"]` 换成两个后端的 URL 参数即可）。
* `scripts/capture-screenshots.mjs`：7 组固定 query 出图(12-20)。

---

## 8. WebGL2 移植注意点（按风险从高到低）

### 8.1 阻断级

1. **没有 compute shader**。5 条 compute pipeline 全部要改写为片元 pass + FBO：
   * `buildTerrain`(325-346) → 一次性渲到 513² RGBA16F FBO。
   * `evolveSpectrum`(634-672) → 128² **MRT 双附件**（field0/field1）。
   * `inverseFftStage`(674-723) → 14 趟 ping-pong，每趟双附件 MRT；`textureLoad` → `texelFetch`。
   * `simulate`(348-557) → sim² 单附件 ping-pong。
   * `updateBreakerEvents`(559-632) → 256×1 ping-pong（当前无实际视觉贡献，可先跳过并把 breakerEvents 绑成常量 0 纹理）。
   * `buildShipTransform` → 见 §5.3。
   * WebGL2 最多 8 个 draw buffer，MRT 双附件安全。
2. **RGBA16F 可渲染 + 可线性过滤**：`EXT_color_buffer_float`（或 `EXT_color_buffer_half_float`）是**必检扩展**，没有就无法降级。RGBA16F 的线性过滤在 WebGL2 核心里已保证；但 twiddle / initialSpectrum 用的 **RGBA32F 只做 `textureLoad`**（701, 651-652），改成 `texelFetch` + `NEAREST` 即可，不需要 `OES_texture_float_linear`。
3. **深度纹理的读写冲突**。WebGPU water pass 用 `depthReadOnly: true` 把 `depthTexture` 同时作为附件与 `texture_depth_2d` 采样(2411 vs 928/1414-1419)。WebGL2 里这是**反馈回路（undefined behaviour）**。解法：
   * 该采样只在 `environment.x > 0.5`（shore）时发生(1413)；
   * 最省事：shore 场景下把 scene pass 的深度渲到纹理 A，water pass 绑定深度纹理 B（A 的拷贝，用 `blitFramebuffer` 或一次 depth-copy pass），或干脆 water pass 用一张独立深度附件并在 blit 时把 A 的深度也写进去。
   * 深度格式：`depth24plus` → `DEPTH_COMPONENT24` **纹理**（不能是 renderbuffer，否则无法采样）。
4. **NDC 深度范围**。`perspective()`(1709-1714) 生成的是 WebGPU 风格（z ∈ [0,1]，第 11 项 `far/(near-far)`、第 15 项 `near*far/(near-far)`）。WebGL2 没有 `glClipControl`，必须换成经典 GL 形式：第 11 项 `(far+near)/(near-far)`、第 15 项 `2*far*near/(near-far)`。**连带影响 3 处硬编码深度**：
   * sky 顶点 `z = 0.999999`(736) → GL 需 `0.999998`（即 `2*0.999999-1`）；
   * 天际裙边 `horizonClip.z = horizonClip.w * 0.99999`(1199) → `w * 0.99998`；
   * `1.0 - step(0.9995, capturedDepth)`(1419) —— 这个读的是**深度纹理值**（仍是 [0,1] 窗口空间），阈值**不用改**。
   * near/far = `0.12 / 50000`(2287)，GL 的 [-1,1] 映射会损失约 1 bit 深度精度，`depth24` 下仍可接受，但若出现 z-fighting 可考虑把 far 降到 20000（`WATER_HORIZON_REACH` 是 20000，见 203）。
5. **无 VBO 绘制**。GLSL ES 3.00 有 `gl_VertexID`，但 WebGL2 里 **必须绑定一个非默认 VAO**（有些驱动在默认 VAO + 零 enabled attribute 时行为不一致），且 Safari/ANGLE 上建议保留一个 dummy 属性以免被优化裁掉。绘制量：terrain shore 场景 1 572 864 顶点/帧、water 24576×10 —— 数量上 WebGL2 没问题，但 `drawArraysInstanced` 的 CPU 开销更高。

### 8.2 高风险

6. **`instance_index`**：`gl_InstanceID` 在 WebGL2 **恒为 0-based**（没有 `baseInstance`），与 WGSL `@builtin(instance_index)` 在 `draw(count, 10)`（无 firstInstance，2428）下语义完全一致。安全。但注意 clipmap 用 `f32(instanceId)` 直接当 level(1153)，`int → float` 转换必须显式。
7. **Y 轴方向**：
   * `blitVertex` 的 `uv.y = 0.5 - position.y*0.5`(900) 是为 WebGPU 纹理原点在左上而写的；GL 纹理原点在左下，必须改成 `0.5 + position.y*0.5`。
   * `screenUv = position.xy / interaction.zw`(1410)：WebGPU `@builtin(position).y` 自上而下、纹理 v 也自上而下 → 一致；GL `gl_FragCoord.y` 自下而上、纹理 v 也自下而上 → **同样一致，无需改**。
   * 但 `refractionUv` 的法线偏移 `vec2(N.x, -N.z)`(1411) 的 y 分量方向依赖屏幕 v 的世界朝向，GL 下要翻成 `vec2(N.x, +N.z)` 才能保持相同视觉。
   * `textureLoad(sceneDepthTexture, refractionUv*dims)`(1415) 沿用上面同一约定。
8. **canvas 配置差异**：`configure({ alphaMode: "opaque" })`(1852) ≈ `getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: "high-performance" })`。
   * `antialias: false` 必须显式（WebGPU 侧无 MSAA）。
   * `depth: false`：所有深度都在自建 FBO 上（引擎从不用默认 framebuffer 的深度，见 2396/2411 都指向 `depthTexture`）—— 但 water pass 直接画到默认 framebuffer 且需要深度测试！所以要么 `depth: true` 并把 scene 深度 blit 到默认 FB，要么**把 water pass 也画到离屏 FBO 再最终 blit 到屏幕**（推荐，同时顺带解决 §8.1.3 的反馈回路）。
   * `premultipliedAlpha`：water 输出的是**非预乘** `vec4(color, shorelineCoverage)`(1534)，若 `alpha:false` 则完全无关；若 `alpha:true` 必须设 `premultipliedAlpha: false`，否则边缘会变暗。
9. **颜色空间**：目标格式是 **非 sRGB UNORM**（`bgra8unorm`，不是 `-srgb`），着色器手工做 `linearToSrgb`(shared-wgsl 34-36)。GL 侧：中间纹理用 `RGBA8`（**不要** `SRGB8_ALPHA8`），且不要 `gl.enable(FRAMEBUFFER_SRGB)`（WebGL2 本来也没有）。`capturedLinear = pow(scene, 2.2)`(1418) 的解码假设必须与之配套。
10. **混合状态**：water = `blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA)`(1950-1956)，其余 pass 关混合。深度：sky `depthMask(false)+depthFunc(ALWAYS)`；terrain/ship `depthMask(true)+LESS`；water/breaker `depthMask(false)+LESS`；blit `depthMask(false)+ALWAYS`。cull 一律 `disable(CULL_FACE)`。
11. **viewport / scissor**：WebGPU 每个 render pass 自动把 viewport 设为附件尺寸；WebGL2 必须在每次 `bindFramebuffer` 后手动 `gl.viewport(0,0,w,h)` —— 特别是 128² 谱 FBO、513² 地形 FBO、sim² 场 FBO、256×1 碎波 FBO 与全屏 FBO 之间来回切换时。引擎从不使用 scissor。

### 8.3 中低风险

12. **overridable constants** `REFERENCE_MODE`(910, 1957-1958) → 两份 `#define REFERENCE_MODE 0/1` 的程序，或一个 `uniform bool`（分支代价可接受，因为它只影响 1445-1449 的 3 次 skyColor tap）。
13. **sampler 分离**：WGSL 用 `fieldSampler`(clamp/linear) 与 `spectrumSampler`(repeat/linear) 两个独立采样器，且**同一张纹理会被两种采样器采**（例如 `previousState` 在 541 用 spectrumSampler、在 417 用 textureLoad）。WebGL2 用 **Sampler Object**（`gl.createSampler` + `gl.bindSampler(unit, s)`）复刻，不要靠 `texParameteri` 改纹理自身状态。
14. **`textureSampleLevel(..., 0.0)`** → `textureLod(tex, uv, 0.0)`（顶点着色器里必须用 `textureLod`，`texture()` 在 vertex stage 无隐式 LOD）。所有纹理都没有 mip（创建时未指定 `mipLevelCount`），`minFilter` 用 `LINEAR` 而非 `LINEAR_MIPMAP_*`。
15. **`fwidth` / `dpdx` / `dpdy`**：GLSL ES 3.00 核心支持（水面 1305，船体 158-161、200）。注意 `discard` 之后的导数是未定义的 —— 水面 1305 的 `fwidth` 在 1311 的 discard **之前**，顺序必须保留。
16. **`tanh`**：GLSL ES 3.00 有；但 1041 的 `clamp(x, -30, 30)` 是为了绕开 Metal 的 NaN 溢出，**照抄不要删**（Angle/D3D 后端同样脆弱）。
17. **整数运算**：`cellId % resolution`、`vertexId / 6u` 等在 GLSL 里用 `int`/`uint`；`gl_VertexID` 是 `int`，注意 `uint` 转换与除法的符号语义。
18. **timestamp query**：`EXT_disjoint_timer_query_webgl2` 在多数浏览器默认不可用。`WaterLabMetrics` 的 4 个 gpu 字段已声明为 `number | null`(83-86)，直接返回 `null` 即可，UI(307-308) 与 benchmark 的 `averageGpu`(60-63) 都能容忍 —— 但 benchmark 的等待条件(85) 需要调整（见 §7.4）。
19. **上下文丢失**：`device.lost` / `uncapturederror`(1845-1846) 对应 `webglcontextlost` / `webglcontextrestored` 事件 + `gl.getError()` 轮询；文案保持中文并复用 `fail()` 的「只保留第一条」语义(2516)。
20. **纹理上传**：`device.queue.writeTexture(tex, Float32Array, {bytesPerRow: 128*16, rowsPerImage: 128}, [128,128])`(2012-2014) → `gl.texSubImage2D(TEXTURE_2D, 0, 0,0, 128,128, RGBA, FLOAT, data)`，注意 `UNPACK_ALIGNMENT` 与行长（RGBA32F 每行 2048 B，默认 alignment 4 即可）。
21. **`copyExternalImageToTexture`**（ship-renderer 62）→ `gl.texImage2D(..., ImageBitmap)`，需要 `UNPACK_FLIP_Y_WEBGL = false` + `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE`（对应 `createImageBitmap(..., {colorSpaceConversion:"none"})`，54）；`rgba8unorm-srgb` → `SRGB8_ALPHA8`（这是**唯一**应该用 sRGB 内部格式的地方，因为 base color 需要硬件解码）。
22. **索引类型**：船体用 `uint32`(326) → `gl.UNSIGNED_INT`，WebGL2 核心支持。
23. **`interaction.zw` 是 canvas 后备缓冲尺寸**(2311)，不是 CSS 尺寸；`resize()` 里改的是 `canvas.width/height`(2243-2244)，GL 侧要同步 `gl.viewport` 与所有全屏 FBO 附件重建（对应 2245-2262 的销毁/重建 + 4 个 scene bind group）。

### 8.4 可以直接照搬、无需担心的部分

* 全部 CPU 数学：`buildSpectralOceanData()`(1567-1674)、`spectrumNormalisationFactor()`(1556-1563)、`deterministicRandom()`(1538-1547)、`lookAt`(1699-1707)、`multiply`(1716-1724)、`percentile/mean`(1676-1684)、`SPECTRAL_CASCADES`(209-215)、`SHIP_PLACEMENTS`(145-159)、`frameState()`(2271-2293)、`writeSimulationParams()`(2321-2337)、交互处理(2207-2233)。这些一行不改就能复用（`perspective()` 是唯一例外，见 §8.1.4）。
* uniform 结构（256 B / mat4 + 12 vec4）与 std140 完全兼容，可原样作为 UBO 上传。
* 指标采集、rAF 循环结构、dispose 顺序、错误文案。

---

## 附：一帧完整时间线（`render`，2339-2469）

```
0  提前 return 守卫（27 个非空检查）                                   2340
1  frameDelta 采样 → frameTimes                                       2341-2346
2  writeUniforms(timestamp) → 256 B                                   2347 / 2295-2319
3  writeSimulationParams(frame) → 2×32 B                              2348 / 2321-2337
4  encoder = createCommandEncoder()                                   2350
5  [仅首帧/重建后] terrain compute pass，dispatch ceil(513/16)² = 33²   2351-2358
6  compute pass「Tethys spectral ocean and local wake simulation」     2360-2390
   ├ ×3 cascade: evolveSpectrum dispatch 16²                          2366-2368
   │             + 14 × inverseFftStage dispatch 16²                  2369-2373
   ├ simulate dispatch ceil(sim/16)²      （activeSimulationIndex 翻转）2375-2379
   ├ [reference] 第二个 calm 子步         （再次翻转）                  2380-2384
   ├ updateBreakerEvents dispatch ceil(256/64)=4                      2385-2388
   └ ship.updateTransform(1 个 workgroup)                             2389
7  scene render pass（color = shore?sceneColor:swapchain, depth clear）2393-2407
   ├ sky draw(3)                                                      2399-2401
   ├ terrain draw(res²×6)                                             2402-2405
   └ ship.render()（逐 primitive setVertexBuffer/setIndexBuffer/drawIndexed）2406
8  water render pass（color = swapchain, depth readOnly）              2408-2440
   ├ [shore] blit draw(3)                                             2414-2418
   ├ water draw(24576, 10 instances)                                  2419-2428
   └ [BREAKER_ENABLED=false → 不执行] breaker patch draw(73728)        2429-2439
9  [每 8 帧] resolveQuerySet + copyBufferToBuffer(32 B)                2441-2445
10 queue.submit + submitTimes 采样                                     2446-2448
11 [每 8 帧] queryReadback.mapAsync → 解析 4 个 u64 → unmap            2449-2466
12 frameIndex++；requestAnimationFrame(render)                        2467-2468
```

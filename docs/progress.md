# progress.md — yong-webgl2-water

> 本仓库是 [`inkwell-webgpu-water`](https://github.com/ly05010419/inkwell-webgpu-water)
> （commit `7dbf39c` / `7331e81`）的 **WebGL2 抽取版**。目标：只保留 WebGL2 水体，
> 去掉 WebGPU 引擎、Three.js 适配层与船体渲染，演示页改用 Vite + 原生 TypeScript，
> 并保证与源项目 `/webgl2` 页面逐像素零差异。

## 已完成

### 1. 引擎抽取（数学 / GLSL / 每帧顺序一行未改）

- 复制 `src/lib/webgl2/` 全部模块，去掉 `ship-assets-gl.ts`、`ship-glsl.ts`、
  `ship-renderer-gl.ts`、`ship-transform-math.ts` 四个文件，以及 `gltf-loader.ts`。
- `engine-frame.ts`：删掉 `FramePassInput.ship` 字段、`ship?.updateTransform()`
  与 `ship?.render()` 两个调用点。场景绘制顺序变为 **sky → terrain → water**。
- `engine-resources.ts` 无船体分支，未改动（船体资源本就由引擎主类持有）。
- `webgl2-water-engine.ts`：删掉 `ship` / `shipError` 字段、`GlShipRenderer.create`
  的 await 段、`setPlacement` / `setCascadeScales` 调用、`adapter` 的船体失败后缀，
  以及 `SHIP_PLACEMENTS` 导入。`init()` 里保留 dispose 竞态的重新检查。
- `src/lib/webgl2/index.ts` 去掉 `GlShipRenderer` 一行导出；其余导出不变。

### 2. 共享 CPU 模块

- `water-constants.ts`：删 `SHIP_PLACEMENTS` 与 `WaterShipPlacement`。
- `water-lab-types.ts`：删 `WaterBackend` 类型、`WaterLabOptions.shipModelUrl`、
  `WaterLabMetrics.backend`。
- `water-metrics.ts`：`MetricsInput` 删 `backend` / `shipTriangles`；
  `frameTriangleCount(options)` 少一个参数，不再累加船体三角形。
- `water-lab-query.ts`：删 `backendPreference` 与 `readBackendPreference`。
- `spectral-ocean.ts`、`water-math.ts`、`water-frame.ts`、`water-interaction.ts`、
  `water-profiles.ts`、`nearshore-reference.ts` 仅调整了失效的文档注释。
- `gl-context.ts` 的 `GL_DEBUG_CHECKS_ENABLED` 改为优先读 `import.meta.env.DEV`，
  在库构建 / vitest 下回退到 `process.env.NODE_ENV`。

### 3. 演示页（原生 TypeScript）

- `src/demo/main.ts`：读 URL → 建页面 → 起引擎 → 250 ms 轮询指标 →
  `pagehide` 时 dispose。
- `src/demo/panel.ts` + `panel-model.ts` + `labels.ts` + `dom.ts` + `panel.css`：
  逐项复刻源面板（见 README 与验收记录）。
- `src/demo/bridge.ts`：`window.__WEBGL2_WATER_LAB__`，方法名与源项目一致。

### 4. 验证

- `npm run lint` / `npx tsc --noEmit` / `npm test`（23 文件 451 用例）/
  `npm run build`（演示页 + 库）/ `npm run preview` 全部通过。
- `scripts/compare-with-source.mjs`：三场景 `mismatch=0`、`maxΔ=0`（1280×800、DPR 1）。
- `scripts/interaction-smoke.mjs`：4 组视口 × 23 次 setter 调用后
  `getMetrics().error === null`，无 console / pageerror。

## 未做（可选后续）

- `docs/screenshots/` 尚未生成（`npm run screenshots` 可一键产出）。
- `BREAKER_ENABLED` 仍为 `false`，碎波片几何与主面 discard 一并处于关闭状态，
  与源项目一致。
- 若环境支持 `EXT_clip_control`，可把深度范围切到 `[0, 1]`，省掉
  `perspective()` 的分支——源项目也把这条列在待办里。
- 库构建目前只输出 ESM；如需 CJS 可在 `build:lib` 加 `--format esm,cjs`。

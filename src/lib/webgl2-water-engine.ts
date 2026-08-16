// The Tethys water engine on WebGL2 — the whole public surface of this
// package. Same clamps, same per-frame ordering and same metrics as the raw
// WebGPU original this was ported from; only the GPU API underneath differs.
//
// The two structural departures from the WebGPU version are forced by WebGL2
// and documented in docs/webgl2-port/contract.md §3.4/§3.5: the projection
// targets the [-1, 1] depth range, and the shore scene renders offscreen so the
// water can sample the scene depth it is no longer attached to. Everything else
// comes from the GPU-agnostic CPU modules in `src/lib/`.
//
// Two behaviours are worth stating up front, because both are decisions rather
// than consequences:
//
//   1. `fail()` stops the render loop and disconnects the ResizeObserver. A GL
//      pass throws synchronously, from inside `render()`, and would throw again
//      on every one of the next sixty frames — sixty identical console errors a
//      second, with nothing on screen changing. Stopping keeps the first cause
//      readable in `getMetrics().error`.
//   2. `setRenderScale()` (and the other rebuild setters) return early when the
//      clamped value equals the current one. The skipped work — reallocating
//      the offscreen targets at an identical size — has no observable effect on
//      the next frame, so the pixels are unchanged either way.

import { WaterInteractionController, resolveInitialCameraOrbit } from "./water-interaction";
import {
  normalizeWaterLabOption,
  normalizeWaterLabOptions,
  type WaterLabMetrics,
  type WaterLabOptions,
} from "./water-lab-types";
import { buildWaterLabMetrics } from "./water-metrics";
import type { WaterRenderMode, WaterScene, WaterView } from "./water-profiles";
import { FrameTimings, GPU_SAMPLE_INTERVAL } from "./water-timing";
import { renderComposite, runComputePasses } from "./webgl2/engine-frame";
import { writeSimulationParams, writeWorldUniforms } from "./webgl2/engine-uniforms";
import { createWaterGlResources, type WaterGlResources } from "./webgl2/engine-resources";
import { createFrameTargets, type FrameTargets } from "./webgl2/frame-targets";
import { createWaterGlContext, onContextLost } from "./webgl2/gl-context";
import { bindVao } from "./webgl2/gl-geometry";
import { invalidateGlStateCache } from "./webgl2/gl-state-cache";
import { verifyFrameBoundary } from "./webgl2/gl-state-cache-verify";
import type { WaterGlContext } from "./webgl2/types";
import { createWaterSimulationPass, type WaterSimulationPass } from "./webgl2/water-simulation-pass";

export { DEFAULT_WATER_LAB_OPTIONS, type WaterLabMetrics, type WaterLabOptions } from "./water-lab-types";

/** Label shown before the context is up. */
const PENDING_ADAPTER_LABEL = "正在请求 WebGL2 上下文…";
/** Raised when the render loop finds its own resources gone without a cause. */
const MISSING_RESOURCES_MESSAGE = "WebGL2 渲染资源缺失，水面渲染已停止。";

export class WebGl2WaterEngine {
  private readonly canvas: HTMLCanvasElement;
  private options: WaterLabOptions;
  private ctx: WaterGlContext | null = null;
  private resources: WaterGlResources | null = null;
  private simulation: WaterSimulationPass | null = null;
  private targets: FrameTargets | null = null;
  private detachContextLost: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly interaction: WaterInteractionController;
  private terrainPrepared = false;
  private readonly timings = new FrameTimings();
  private animationFrame = 0;
  private frameIndex = 0;
  private startTime = performance.now();
  private lastFrameTime = 0;
  private elapsedSeconds = 0;
  private initStarted = false;
  private ready = false;
  private disposed = false;
  private adapterLabel = PENDING_ADAPTER_LABEL;
  private error: string | null = null;
  private disturbanceCount = 0;
  private lastWakeAt = -10;

  constructor(canvas: HTMLCanvasElement, options: Partial<WaterLabOptions> = {}) {
    this.canvas = canvas;
    // Clamped at construction so a caller-supplied option cannot reach a
    // texture size or a matrix in a state the setters would have rejected.
    this.options = normalizeWaterLabOptions(options);
    this.interaction = new WaterInteractionController(resolveInitialCameraOrbit(this.options));
  }

  async init() {
    // Re-entrant calls (a double mount, or a caller that retries) must not
    // build a second set of resources over the first: the canvas hands out one
    // context, and the loser would leak everything it created.
    if (this.initStarted || this.disposed) return;
    this.initStarted = true;
    try {
      const ctx = createWaterGlContext(this.canvas);
      if (this.disposed) return;
      this.ctx = ctx;
      this.adapterLabel = ctx.adapterLabel;
      // `getContext("webgl2")` hands out the *same* context object for the life
      // of the canvas, so a remount inherits whatever the previous engine left
      // in the binding cache. Start from "nothing is known" either way.
      invalidateGlStateCache(ctx.gl);
      this.detachContextLost = onContextLost(this.canvas, () => {
        // Every handle in the cache died with the context.
        invalidateGlStateCache(ctx.gl);
        this.fail("WebGL2 上下文已丢失，水面渲染已停止。");
      });
      this.resources = createWaterGlResources(ctx, this.options);
      this.simulation = createWaterSimulationPass(ctx, this.resources.simulationProgram, this.options.simulationResolution);
      this.interaction.attach(this.canvas);
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas);
      this.resize(true);
      // `resize()` reports an allocation failure through `fail()` instead of
      // throwing, because it also runs from the ResizeObserver where there is
      // no caller to catch. During start-up there *is* one, and an engine with
      // no frame targets can never draw: rethrow the recorded cause so it lands
      // in the `catch` below (which keeps the first message) and reaches both
      // the rejected `init()` promise and the factory's `dispose()`.
      if (this.error !== null) throw new Error(this.error);
      // `init()` is `async` and a caller may dispose the engine while it is
      // suspended, so re-check before starting the loop. Hand the shared
      // context back a valid VAO in that case: `getContext("webgl2")` returns
      // the same object for the life of the canvas, and the engine that
      // replaces us on it inherits whatever is bound.
      if (this.disposed) {
        if (this.resources) bindVao(ctx.gl, this.resources.vao);
        return;
      }
      bindVao(ctx.gl, this.resources.vao);
      this.ready = true;
      this.startTime = performance.now();
      this.lastFrameTime = this.startTime;
      this.animationFrame = requestAnimationFrame(this.render);
    } catch (error) {
      // A start-up failure has to reach both places a caller looks: the rejected
      // promise `createWaterEngine` propagates, and `getMetrics().error`, which
      // the demo bridge and the capture scripts poll. Recording it first also
      // stops the loop and the ResizeObserver, exactly like a runtime failure.
      this.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  setMode(mode: WaterRenderMode) { this.options = { ...this.options, mode }; }
  setView(view: WaterView) { this.options = { ...this.options, view }; }
  setScene(scene: WaterScene) {
    if (scene === this.options.scene) return;
    this.options = { ...this.options, scene };
    this.allocateFields();
  }
  setMeshResolution(value: number) {
    this.options = { ...this.options, meshResolution: normalizeWaterLabOption("meshResolution", value) };
  }
  setSimulationResolution(value: number) {
    const next = normalizeWaterLabOption("simulationResolution", value);
    if (next === this.options.simulationResolution) return;
    this.options = { ...this.options, simulationResolution: next };
    this.allocateFields();
  }
  setRenderScale(value: number) {
    const next = normalizeWaterLabOption("renderScale", value);
    if (next === this.options.renderScale) return;
    this.options = { ...this.options, renderScale: next };
    this.resize(true);
  }
  setWaveScale(value: number) {
    this.options = { ...this.options, waveScale: normalizeWaterLabOption("waveScale", value) };
  }
  setDistantRoughness(value: number) {
    this.options = { ...this.options, distantRoughness: normalizeWaterLabOption("distantRoughness", value) };
  }
  setDetailRange(value: number) {
    this.options = { ...this.options, detailRange: normalizeWaterLabOption("detailRange", value) };
  }
  setLongCascadeScale(value: number) {
    const next = normalizeWaterLabOption("longCascadeScale", value);
    if (next === this.options.longCascadeScale) return;
    this.options = { ...this.options, longCascadeScale: next };
    // The option is updated either way — `getMetrics()` and a later rebuild
    // must see the value the caller asked for. Only the GPU write is skipped
    // once the context is gone.
    if (!this.liveContext()) return;
    this.resources?.cascades.uploadCascade(0, this.options);
  }
  setMediumCascadeScale(value: number) {
    const next = normalizeWaterLabOption("mediumCascadeScale", value);
    if (next === this.options.mediumCascadeScale) return;
    this.options = { ...this.options, mediumCascadeScale: next };
    // See `setLongCascadeScale`: option first, GPU upload only while live.
    if (!this.liveContext()) return;
    this.resources?.cascades.uploadCascade(1, this.options);
  }
  setSwellSmoothing(value: number) {
    this.options = { ...this.options, swellSmoothing: normalizeWaterLabOption("swellSmoothing", value) };
  }
  setFogReach(value: number) {
    this.options = { ...this.options, fogReach: normalizeWaterLabOption("fogReach", value) };
  }

  resetMetrics() {
    this.timings.reset();
  }

  /**
   * The context while it may still be driven: `null` once the engine is
   * disposed, has already failed, or the driver took the context away. Every
   * allocation path goes through this so nothing is rebuilt after a loss.
   */
  private liveContext(): WaterGlContext | null {
    const ctx = this.ctx;
    if (!ctx || this.disposed || this.error !== null || ctx.gl.isContextLost()) return null;
    return ctx;
  }

  // Rebuilds everything sized by `simulationResolution` and re-zeroes the
  // persistent state — the `allocateFields()` counterpart. The terrain field is
  // re-derived too because `environment.x` changes with the scene. The compiled
  // solver is engine-owned and survives; only its ping-pong pair is rebuilt.
  private allocateFields() {
    const ctx = this.liveContext();
    const resources = this.resources;
    if (!ctx || !resources) return;
    let next: WaterSimulationPass;
    try {
      // Build first, release second: a failure here leaves the previous field
      // live and the engine still rendering rather than half-torn-down.
      next = createWaterSimulationPass(ctx, resources.simulationProgram, this.options.simulationResolution);
    } catch (error) {
      this.fail(`无法重建 ${this.options.simulationResolution}² 近岸模拟场：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.simulation?.dispose();
    this.simulation = next;
    this.terrainPrepared = false;
    resources.breaker.reset();
    // The old pass's textures and FBOs are gone and the new ones are bound in
    // ways this method did not record; nothing cached is trustworthy any more.
    invalidateGlStateCache(ctx.gl);
    bindVao(ctx.gl, resources.vao);
  }

  private resize(force = false) {
    const ctx = this.liveContext();
    if (!ctx) return;
    const { gl } = ctx;
    const maximumDpr = this.options.benchmark ? 1 : 1.5;
    const dpr = Math.min(window.devicePixelRatio || 1, maximumDpr) * this.options.renderScale;
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    // `force` only bypasses the CSS-size comparison (the render scale changed
    // under an unchanged element); it never forces a redundant reallocation.
    if (!force && this.canvas.width === width && this.canvas.height === height && this.targets) return;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    // The drawing buffer may be clamped below the requested size; every
    // viewport, `uSceneDims` and `interaction.zw` has to agree with it.
    const bufferWidth = gl.drawingBufferWidth;
    const bufferHeight = gl.drawingBufferHeight;
    if (this.targets && this.targets.width === bufferWidth && this.targets.height === bufferHeight) return;
    let next: FrameTargets;
    try {
      next = createFrameTargets(gl, bufferWidth, bufferHeight);
    } catch (error) {
      this.fail(`无法分配 ${bufferWidth}×${bufferHeight} 的离屏帧目标：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.targets?.dispose();
    this.targets = next;
    // A resized drawing buffer does *not* reset the GL viewport, and both
    // offscreen targets were just replaced: drop every recorded binding rather
    // than reason about which of them survived.
    invalidateGlStateCache(gl);
  }

  /** Solves the camera, uploads both uniform blocks and advances the wake throttle. */
  private writeFrameUniforms(ctx: WaterGlContext, resources: WaterGlResources, timestamp: number, targets: FrameTargets): void {
    const frame = writeWorldUniforms({
      gl: ctx.gl,
      worldUbo: resources.worldUbo,
      options: this.options,
      camera: this.interaction.state,
      timestamp,
      startTime: this.startTime,
      canvasWidth: targets.width,
      canvasHeight: targets.height,
    });
    this.elapsedSeconds = frame.elapsedSeconds;
    const wakeTriggered = writeSimulationParams({
      gl: ctx.gl,
      impulseUbo: resources.impulseUbo,
      calmUbo: resources.calmUbo,
      frame,
      options: this.options,
      lastWakeAt: this.lastWakeAt,
    });
    if (wakeTriggered) {
      this.disturbanceCount += 1;
      this.lastWakeAt = this.elapsedSeconds;
    }
  }

  private render = (timestamp: number) => {
    // A disposed engine, a failed one and a lost context are all orderly
    // stops: leave without a diagnostic and without asking for another frame.
    const ctx = this.liveContext();
    if (!ctx) return;
    const resources = this.resources;
    const simulation = this.simulation;
    const targets = this.targets;
    // Anything else missing means an allocation silently went away; that is a
    // bug, not a shutdown, so it has to reach the UI instead of stalling.
    if (!resources || !simulation || !targets) { this.fail(MISSING_RESOURCES_MESSAGE); return; }
    const frameDelta = timestamp - this.lastFrameTime;
    this.lastFrameTime = timestamp;
    this.timings.recordFrameDelta(frameDelta);
    const submitStartedAt = performance.now();
    try {
      this.writeFrameUniforms(ctx, resources, timestamp, targets);
      const pass = { ctx, resources, simulation, targets, options: this.options };
      const measureGpu = this.frameIndex % GPU_SAMPLE_INTERVAL === 0;
      bindVao(ctx.gl, resources.vao);
      // Outside the timed span: the terrain field is built once and its cost
      // is not part of the simulation metric.
      if (!this.terrainPrepared) {
        resources.terrainField.build();
        this.terrainPrepared = true;
      }
      if (measureGpu) resources.simulationTimer.begin();
      const fields = runComputePasses(pass);
      if (measureGpu) resources.simulationTimer.end();
      if (measureGpu) resources.renderTimer.begin();
      renderComposite(pass, fields);
      if (measureGpu) resources.renderTimer.end();
      // One synchronous sweep over every binding, in dev builds only.
      verifyFrameBoundary(ctx.gl, this.frameIndex);
    } catch (error) {
      // A throwing pass would otherwise repeat its failure sixty times a
      // second; record the first cause and stop the loop, like a lost device.
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }
    this.timings.recordSubmit(performance.now() - submitStartedAt);
    this.timings.collectGpuSamples(resources.simulationTimer, resources.renderTimer);
    this.frameIndex += 1;
    const limit = this.options.frameLimit;
    if (typeof limit === "number" && Number.isFinite(limit) && this.frameIndex >= limit) return;
    this.animationFrame = requestAnimationFrame(this.render);
  };

  getMetrics(): WaterLabMetrics {
    return buildWaterLabMetrics({
      ready: this.ready,
      options: this.options,
      disturbanceCount: this.disturbanceCount,
      frameTimes: this.timings.frameTimes,
      submitTimes: this.timings.submitTimes,
      gpuSimulationTimes: this.timings.gpuSimulationTimes,
      gpuRenderTimes: this.timings.gpuRenderTimes,
      adapter: this.adapterLabel,
      error: this.error,
    });
  }

  private fail(message: string) {
    // Preserve the first failure: later GL errors are usually consequences and
    // would otherwise hide the cause.
    if (!this.error) this.error = message;
    // The loop is over, so a later element resize must not try to reallocate
    // targets on a context that just proved it cannot serve them.
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    console.error(message);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.interaction.detach();
    this.detachContextLost?.();
    this.detachContextLost = null;
    this.targets?.dispose();
    this.targets = null;
    this.simulation?.dispose();
    this.simulation = null;
    this.resources?.dispose();
    this.resources = null;
    // The context outlives this engine (see below), so hand its successor a
    // cache that claims nothing about the objects we just deleted.
    if (this.ctx) invalidateGlStateCache(this.ctx.gl);
    // Deliberately no `WEBGL_lose_context.loseContext()`: `getContext("webgl2")`
    // hands out the *same* context object for the life of the canvas, so a
    // remount reuses this one. Killing it here would take down the engine that
    // replaced us on the same element. Deleting the objects we created is all
    // this engine may do; the context dies with the canvas.
    this.ctx = null;
  }
}

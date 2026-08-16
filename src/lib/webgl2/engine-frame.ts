// One frame of the WebGL2 fallback engine, split into the two halves the
// WebGPU version encodes as a compute pass and two render passes.
//
// The ordering here is load-bearing (docs/webgl2-port/spec-compute.md §5): the three cascades must
// finish their inverse FFTs before the shallow-water step reads them, and the
// breaker pass reads the state the simulation just wrote. Every function is
// a plain function over explicit inputs so the engine class keeps no per-frame
// state beyond the "has the static terrain been built" flag.

import { BREAKER_ENABLED, SHORE_TERRAIN_MESH_RESOLUTION } from "../water-constants";
import type { WaterLabOptions } from "../water-lab-types";
import type { WaterGlResources } from "./engine-resources";
import { SCENE_CLEAR_COLOR, SCENE_CLEAR_DEPTH, type FrameTargets } from "./frame-targets";
import { bindFramebufferForDraw, blitFramebuffer } from "./gl-framebuffer";
import { bindVao } from "./gl-geometry";
import { invalidateRenderStateCache } from "./gl-state-cache";
import type { GlFramebuffer, GlTexture, WaterGlContext } from "./types";
import type { WaterSimulationPass } from "./water-simulation-pass";

// `clearBufferfv` only takes a `Float32List`, and the exported constants are
// frozen plain arrays so no importer can rewrite them. Copy them once here.
const CLEAR_COLOR_VALUES = new Float32Array(SCENE_CLEAR_COLOR);
const CLEAR_DEPTH_VALUES = new Float32Array(SCENE_CLEAR_DEPTH);

/** The six spectral field textures the simulation and render passes read. */
export interface CascadeFields {
  readonly long0: GlTexture;
  readonly long1: GlTexture;
  readonly medium0: GlTexture;
  readonly medium1: GlTexture;
  readonly short0: GlTexture;
  readonly short1: GlTexture;
}

/** Everything one frame touches. Nothing in it is mutated by these functions. */
export interface FramePassInput {
  readonly ctx: WaterGlContext;
  readonly resources: WaterGlResources;
  readonly simulation: WaterSimulationPass;
  readonly targets: FrameTargets;
  readonly options: WaterLabOptions;
}

/** Latest spatial field textures of all three cascades. */
export function cascadeFields(resources: WaterGlResources): CascadeFields {
  const { cascades } = resources;
  return Object.freeze({
    long0: cascades.field0(0),
    long1: cascades.field1(0),
    medium0: cascades.field0(1),
    medium1: cascades.field1(1),
    short0: cascades.field0(2),
    short1: cascades.field1(2),
  });
}

/**
 * The GPGPU half: three cascades of spectrum evolution plus 14 inverse-FFT
 * stages → one or two shallow-water sub-steps → breaker events.
 *
 * The one-off static terrain build is deliberately **not** here: the WebGPU
 * engine runs it outside its timestamp span, so timing it would make the
 * fallback's first `gpuSimulationMeanMs` sample incomparable. The engine calls
 * `resources.terrainField.build()` before opening the timer instead.
 */
export function runComputePasses(input: FramePassInput): CascadeFields {
  const { resources, simulation, options } = input;
  resources.cascades.update();
  const fields = cascadeFields(resources);
  const shared = {
    terrain: resources.terrainField.texture,
    spectrumSampler: resources.spectrumSampler,
    longField0: fields.long0,
    longField1: fields.long1,
    mediumField0: fields.medium0,
    mediumField1: fields.medium1,
  };
  simulation.step({ ...shared, params: resources.impulseUbo });
  // Reference mode integrates two 1/120 s sub-steps; the second carries no
  // impulse so the wake is injected exactly once per frame.
  if (options.mode === "reference") simulation.step({ ...shared, params: resources.calmUbo });
  resources.breaker.step({ ...shared, waterState: simulation.currentState(), fieldSampler: resources.fieldSampler });
  return fields;
}

/** What the water pass binds as `sceneColorTexture` / `sceneDepthTexture`. */
interface CapturedScene {
  readonly color: GlTexture;
  readonly depth: GlTexture;
}

/**
 * Sky + terrain into `target`, from a clean clear.
 *
 * `target` is `sceneFbo` in the shore scene, where the water shader reads the
 * result back through `sceneColorTexture` / `sceneDepthTexture`; `null` — the
 * canvas itself — in the open scene on a context with a deep enough default
 * depth buffer; and `waterFbo` in the open scene without one. `null` picks up
 * the drawing-buffer size for its viewport, which `resize()` guarantees is also
 * `targets.width` × `targets.height`, so `uniforms.interaction.zw` agrees with
 * it on every path.
 */
function drawSceneGeometry(input: FramePassInput, fields: CascadeFields, target: GlFramebuffer | null): void {
  const { ctx, resources, simulation, options } = input;
  const { gl } = ctx;
  bindFramebufferForDraw(gl, target);
  // The previous pass left depth writes and the scissor in an unknown state;
  // `clearBufferfv` obeys both, so pin them before clearing.
  gl.disable(gl.SCISSOR_TEST);
  gl.colorMask(true, true, true, true);
  gl.depthMask(true);
  // Those three bypass `applyRenderState`, and `depthMask(true)` in particular
  // contradicts the `COMPUTE_STATE` the GPGPU half left behind. Drop the cached
  // preset so the sky's `applyRenderState` re-issues the whole set.
  invalidateRenderStateCache(gl);
  gl.clearBufferfv(gl.COLOR, 0, CLEAR_COLOR_VALUES);
  gl.clearBufferfv(gl.DEPTH, 0, CLEAR_DEPTH_VALUES);
  resources.sky.draw();
  resources.terrain.draw({
    fieldSampler: resources.fieldSampler,
    spectrumSampler: resources.spectrumSampler,
    meshResolution: options.scene === "shore" ? SHORE_TERRAIN_MESH_RESOLUTION : options.meshResolution,
    terrain: resources.terrainField.texture,
    waterState: simulation.currentState(),
    mediumField0: fields.medium0,
    mediumField1: fields.medium1,
    shortField0: fields.short0,
    shortField1: fields.short1,
  });
}

/**
 * The raster half. Two shapes, exactly as in the WebGPU engine (engine 1983-2010):
 *
 * - **shore** — sky + terrain into `sceneFbo`, one colour+depth blit into
 *   `waterFbo` (the WebGPU `sceneBlit` and the depth copy at once), the water
 *   composite, then the presentation blit onto the canvas. The water shader
 *   samples the capture, so it must not be attached to the target it draws into.
 * - **open** — sky + terrain go straight onto the **canvas** and the
 *   water composites on top of them in the same framebuffer, which is exactly
 *   what the WebGPU engine does: scene pass onto the swap chain, water pass
 *   `loadOp: "load"` + `depthReadOnly: true`. `environment.x` is 0 there, so
 *   the shader's captured-scene branch never runs and every offscreen hop is
 *   pure cost: no `sceneFbo`, no `waterFbo`, no blit at all — one framebuffer
 *   bind for the whole raster half.
 *
 *   A context whose default framebuffer came back with fewer than 24 depth bits
 *   (`ctx.limits.defaultFramebufferDepth` false) keeps the previous open route:
 *   the same single pass, but into `waterFbo` and with the presentation blit
 *   after it. Only the depth *precision* differs between the two, and only at
 *   silhouettes — but the whole point of the fast path is that it is bit-exact,
 *   so a shallow buffer is not allowed to take part.
 *
 * The water's depth test is unaffected in all three shapes: it reads the very
 * depth attachment the terrain just wrote (depth-read-only via
 * `WATER_STATE`, WebGPU's `depthReadOnly: true`). Only the route the values
 * took there differs.
 */
export function renderComposite(input: FramePassInput, fields: CascadeFields): void {
  const { ctx, resources, simulation, targets, options } = input;
  const { gl } = ctx;
  // The shore scene is the only reader of the captured colour and depth
  // (`uniforms.environment.x > 0.5` in `water-fragment-glsl.ts`), so it is the
  // only one that pays for capturing them.
  const capturesScene = options.scene === "shore";
  // …and with nothing to capture and a canvas that owns a depth buffer of its
  // own, the open scene has no reason to touch an offscreen target at all.
  const drawsToCanvas = !capturesScene && ctx.limits.defaultFramebufferDepth;
  const sceneTarget = capturesScene ? targets.sceneFbo : drawsToCanvas ? null : targets.waterFbo;
  drawSceneGeometry(input, fields, sceneTarget);
  if (capturesScene) {
    blitFramebuffer(gl, { source: targets.sceneFbo, destination: targets.waterFbo, mask: "color+depth" });
    bindFramebufferForDraw(gl, targets.waterFbo);
  }
  // The sky and terrain passes each bind a VAO of their own. They both
  // restore the engine's empty VAO before returning, but the water pass never
  // binds one at all and its vertex shader is attribute-less, so it would
  // silently inherit whatever is current. Pin it explicitly — this is also the
  // binding the next frame's attribute-less GPGPU draws start from, since
  // nothing below changes it again.
  bindVao(gl, resources.vao);
  // Open binds 1x1 stand-ins rather than the real (unwritten) capture: those
  // attachments belong to `sceneFbo`, while the current draw target is the
  // canvas (or `waterFbo`'s own colour and depth on the fallback route), and
  // binding a live attachment for sampling is a feedback loop even when the
  // shader branch that would read it is dead. The canvas is not a texture at
  // all, so there it is not even bindable.
  const captured: CapturedScene = capturesScene
    ? { color: targets.sceneColor, depth: targets.sceneDepth }
    : { color: resources.sceneColorPlaceholder, depth: resources.sceneDepthPlaceholder };
  resources.water.draw({
    fieldSampler: resources.fieldSampler,
    spectrumSampler: resources.spectrumSampler,
    mode: options.mode,
    // BREAKER_ENABLED is false today; the scene guard keeps this aligned with
    // engine:2429 for when the crest patch is switched back on.
    drawBreakerPatch: BREAKER_ENABLED && options.scene === "open",
    terrain: resources.terrainField.texture,
    waterState: simulation.currentState(),
    longField0: fields.long0,
    longField1: fields.long1,
    mediumField0: fields.medium0,
    mediumField1: fields.medium1,
    shortField0: fields.short0,
    shortField1: fields.short1,
    breakerEvents: resources.breaker.currentEvents(),
    sceneColor: captured.color,
    sceneDepth: captured.depth,
    // Taken from the bound texture rather than from `targets`, so the pass's
    // "dimensions match the depth texture" check holds for the 1x1 stand-in as
    // it does for the canvas-sized capture.
    sceneWidth: captured.depth.width,
    sceneHeight: captured.depth.height,
    depthSampler: resources.depthSampler,
  });
  // Already on the canvas, with the drawing-buffer viewport still current and
  // both framebuffer bindings on `null`: nothing left to present or restore.
  if (drawsToCanvas) return;
  // Same size on both sides, so NEAREST is an exact copy and skips the
  // filtering LINEAR would ask a driver for.
  blitFramebuffer(gl, { source: targets.waterFbo, destination: null, mask: "color", filter: "nearest" });
  bindFramebufferForDraw(gl, null, gl.drawingBufferWidth, gl.drawingBufferHeight);
}

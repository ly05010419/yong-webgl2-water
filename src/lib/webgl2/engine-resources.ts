// Long-lived GL objects of the WebGL2 fallback engine: the shared uniform
// buffers, the three sampler objects, the attribute-less VAO every procedural
// draw needs, the two GPU timers and every pass. That includes the compiled
// shallow-water solver: only its ping-pong pair is sized by
// `simulationResolution`, so the engine rebuilds those two textures on its own
// and never recompiles the program. Grouping them here keeps
// `webgl2-water-engine.ts` focused on per-frame ordering and on the public API.
//
// This is the `createResources()` + samplers half of `allocateFields()`
// (docs/webgl2-port/spec-engine.md §2.1 / §2.2). Creation order is also the reverse of disposal
// order, and every step unwinds what already succeeded when a later one throws.

import type { CascadeScaleOptions } from "../spectral-ocean";
import { SIMULATION_PARAM_BYTES } from "../water-constants";
import { createBreakerEventPass, type BreakerEventPass } from "./breaker-event-pass";
import { createGpuTimer } from "./gl-timer";
import { createGlUnwindStack, type GlUnwindStack } from "./gl-unwind";
import { createGlSampler, createTexture2D, disposeSampler, disposeTexture } from "./gl-texture";
import { bindUniformBufferBase, createUniformBuffer, disposeUniformBuffer, WORLD_UNIFORMS_BINDING, WORLD_UNIFORM_BYTES } from "./gl-uniform-buffer";
import { bindVao, createEmptyVao, disposeVao } from "./gl-geometry";
import { createSkyPass, type SkyPass } from "./sky-pass";
import { createSpectralCascadeSet, type SpectralCascadeSet } from "./spectral-cascades";
import { createTerrainFieldPass, type TerrainFieldPass } from "./terrain-field-pass";
import { createTerrainPass, type TerrainPass } from "./terrain-pass";
import type { GlSampler, GlTexture, GlUniformBuffer, GpuTimer, WaterGlContext } from "./types";
import { createWaterPass, type WaterPass } from "./water-pass";
import { createWaterSimulationProgram, type WaterSimulationProgram } from "./water-simulation-pass";

/** Everything the engine creates once and keeps until `dispose()`. */
export interface WaterGlResources {
  /** Bound for the whole engine lifetime; every procedural draw needs it. */
  readonly vao: WebGLVertexArrayObject;
  /** 256-byte `WorldUniforms`, always at binding 0. */
  readonly worldUbo: GlUniformBuffer;
  /** 32-byte `SimulationParams` for the impulse sub-step. */
  readonly impulseUbo: GlUniformBuffer;
  /** Same block with the impulse zeroed, for the reference mode's calm sub-step. */
  readonly calmUbo: GlUniformBuffer;
  /** clamp-to-edge + linear — the WGSL `fieldSampler`. */
  readonly fieldSampler: GlSampler;
  /** repeat + linear — the WGSL `spectrumSampler`. */
  readonly spectrumSampler: GlSampler;
  /** clamp + nearest, for the depth texture the water pass `texelFetch`es. */
  readonly depthSampler: GlSampler;
  /** 1x1 rgba8 stand-in for `sceneColorTexture` when nothing was captured. */
  readonly sceneColorPlaceholder: GlTexture;
  /** 1x1 depth24 stand-in for `sceneDepthTexture` when nothing was captured. */
  readonly sceneDepthPlaceholder: GlTexture;
  readonly terrainField: TerrainFieldPass;
  readonly cascades: SpectralCascadeSet;
  readonly breaker: BreakerEventPass;
  readonly sky: SkyPass;
  readonly terrain: TerrainPass;
  readonly water: WaterPass;
  /** The compiled shallow-water solver; `createWaterSimulationPass` borrows it. */
  readonly simulationProgram: WaterSimulationProgram;
  /** Wraps the GPGPU half of the frame; unsupported timers return `null` samples. */
  readonly simulationTimer: GpuTimer;
  /** Wraps the scene + water half of the frame. */
  readonly renderTimer: GpuTimer;
  dispose(): void;
}

/**
 * Runs `steps` in order and returns the stack that releases them newest-first.
 * A step that throws unwinds everything already built before the error escapes,
 * so a half-created resource set never reaches the caller. The stack itself
 * comes from `./gl-unwind`, which makes `unwind()` idempotent and keeps one
 * failing release from stranding the resources registered before it.
 */
function buildInOrder(steps: readonly (() => () => void)[]): GlUnwindStack {
  const stack = createGlUnwindStack();
  try {
    for (const step of steps) stack.track(step(), (release) => release());
  } catch (error) {
    stack.unwind();
    throw error;
  }
  return stack;
}

/**
 * Creates every long-lived GL object and leaves the engine VAO and the
 * `WorldUniforms` binding point live. Throws (in Chinese) on the first failure
 * after releasing whatever had already been created.
 */
export function createWaterGlResources(ctx: WaterGlContext, options: CascadeScaleOptions): WaterGlResources {
  const { gl } = ctx;
  // `let` + definite assignment inside the ordered builder: each closure both
  // publishes its object and returns the matching release step.
  let vao!: WebGLVertexArrayObject;
  let worldUbo!: GlUniformBuffer;
  let impulseUbo!: GlUniformBuffer;
  let calmUbo!: GlUniformBuffer;
  let fieldSampler!: GlSampler;
  let spectrumSampler!: GlSampler;
  let depthSampler!: GlSampler;
  let sceneColorPlaceholder!: GlTexture;
  let sceneDepthPlaceholder!: GlTexture;
  let terrainField!: TerrainFieldPass;
  let cascades!: SpectralCascadeSet;
  let breaker!: BreakerEventPass;
  let sky!: SkyPass;
  let terrain!: TerrainPass;
  let water!: WaterPass;
  let simulationProgram!: WaterSimulationProgram;
  let simulationTimer!: GpuTimer;
  let renderTimer!: GpuTimer;

  const teardown = buildInOrder([
    () => { vao = createEmptyVao(gl); bindVao(gl, vao); return () => disposeVao(gl, vao); },
    () => {
      worldUbo = createUniformBuffer(gl, WORLD_UNIFORM_BYTES, "WorldUniforms");
      bindUniformBufferBase(gl, WORLD_UNIFORMS_BINDING, worldUbo);
      return () => disposeUniformBuffer(gl, worldUbo);
    },
    () => { impulseUbo = createUniformBuffer(gl, SIMULATION_PARAM_BYTES, "SimulationParams · impulse"); return () => disposeUniformBuffer(gl, impulseUbo); },
    () => { calmUbo = createUniformBuffer(gl, SIMULATION_PARAM_BYTES, "SimulationParams · calm"); return () => disposeUniformBuffer(gl, calmUbo); },
    () => { fieldSampler = createGlSampler(gl, { label: "fieldSampler", wrap: "clamp", filter: "linear" }); return () => disposeSampler(gl, fieldSampler); },
    () => { spectrumSampler = createGlSampler(gl, { label: "spectrumSampler", wrap: "repeat", filter: "linear" }); return () => disposeSampler(gl, spectrumSampler); },
    () => { depthSampler = createGlSampler(gl, { label: "sceneDepthSampler", wrap: "clamp", filter: "nearest" }); return () => disposeSampler(gl, depthSampler); },
    // The open scene never captures the atmosphere pass, but the water program
    // still declares `sceneColorTexture` / `sceneDepthTexture`, and GL requires
    // every sampler a linked program declares to have a legal, non-conflicting
    // binding: the real attachments are off limits there because the water
    // composite is now drawn straight into the framebuffer that owns them
    // (a feedback loop, R4). These two 1x1 textures are that legal binding.
    // Nothing ever samples them -- the only reader is the water shader's
    // `uniforms.environment.x > 0.5` branch, and `environment.x` is 0 in
    // exactly the scene that binds them.
    () => {
      sceneColorPlaceholder = createTexture2D(gl, {
        label: "captured scene placeholder colour",
        width: 1,
        height: 1,
        format: "rgba8",
        wrap: "clamp",
        data: new Uint8Array([0, 0, 0, 255]),
      });
      return () => disposeTexture(gl, sceneColorPlaceholder);
    },
    // Depth textures take no CPU upload (`createTexture2D` refuses it), so this
    // one keeps the zero-filled contents WebGL guarantees for a fresh texture.
    () => {
      sceneDepthPlaceholder = createTexture2D(gl, {
        label: "captured scene placeholder depth",
        width: 1,
        height: 1,
        format: "depth24",
        wrap: "clamp",
      });
      return () => disposeTexture(gl, sceneDepthPlaceholder);
    },
    () => { terrainField = createTerrainFieldPass(ctx); return () => terrainField.dispose(); },
    () => { cascades = createSpectralCascadeSet(ctx, options); return () => cascades.dispose(); },
    () => { breaker = createBreakerEventPass(ctx); return () => breaker.dispose(); },
    () => { sky = createSkyPass(ctx); return () => sky.dispose(); },
    () => { terrain = createTerrainPass(ctx); return () => terrain.dispose(); },
    () => { water = createWaterPass(ctx); return () => water.dispose(); },
    () => { simulationProgram = createWaterSimulationProgram(ctx); return () => simulationProgram.dispose(); },
    // The timers own query objects like every other step, so they belong in the
    // same ordered build rather than after it: a `createGpuTimer` that threw
    // used to leave every pass above it allocated with nothing to free them.
    () => { simulationTimer = createGpuTimer(gl, ctx.timerQuery, "simulation"); return () => simulationTimer.dispose(); },
    () => { renderTimer = createGpuTimer(gl, ctx.timerQuery, "render"); return () => renderTimer.dispose(); },
  ]);

  // The passes each bound their own VAO while compiling; hand the engine's
  // back so the first frame's GPGPU draws start from a known state.
  bindVao(gl, vao);

  return Object.freeze({
    vao,
    worldUbo,
    impulseUbo,
    calmUbo,
    fieldSampler,
    spectrumSampler,
    depthSampler,
    sceneColorPlaceholder,
    sceneDepthPlaceholder,
    terrainField,
    cascades,
    breaker,
    sky,
    terrain,
    water,
    simulationProgram,
    simulationTimer,
    renderTimer,
    // `unwind()` is idempotent and runs the release steps in reverse creation
    // order, which is exactly the disposal contract this record had before.
    dispose: (): void => teardown.unwind(),
  });
}

// Shallow-water simulation pass — the WebGL2 stand-in for the `simulate`
// compute dispatch (docs/webgl2-port/spec-compute.md §3.4, engine:2375-2384).
//
// It is split in two because only one half depends on `simulationResolution`:
//
//   createWaterSimulationProgram(ctx)              compiled once, engine-owned
//   createWaterSimulationPass(ctx, program, size)  the ping-pong pair only
//
// so changing the nearshore resolution (or the scene) reallocates two textures
// instead of recompiling the fragment shader (docs/webgl2-port/spec-engine.md §2.2).
//
// The pass owns the ping-pong pair that replaces `waterTextures[0..1]`: two
// square rgba16f targets holding `(eta, qx, qz, foam)`, zero-filled at creation
// because WebGL2 gives no zero-initialisation guarantee and a single NaN feeds
// back forever (docs/webgl2-port/spec-compute.md R18). `step()` reads the current source, renders
// the next state into the destination and flips the cursor — the exact
// `activeSimulationIndex ^= 1` of the WebGPU engine — so `currentState()`
// afterwards is `waterTextures[activeSimulationIndex]`.
//
// Call it once per frame in `optimized` mode with the impulse params, twice in
// `reference` mode (impulse then calm, both dt = 1/120). The pass never looks
// at the mode: the engine simply hands it the matching 32-byte UBO.
//
// Imports name their modules directly rather than going through `./index`: the
// barrel re-exports this file, and a cycle through it would evaluate the GLSL
// template constants after they are interpolated (TDZ).

import { SIMULATION_PARAM_BYTES } from "../water-constants";
import {
  bindFramebufferForDraw,
  clearFramebufferToZero,
  createPingPongTargets,
} from "./gl-framebuffer";
import { FULLSCREEN_TRIANGLE_VERTEX_GLSL, drawFullscreenTriangle } from "./gl-geometry";
import { assignSamplerUnits, bindGlProgram, bindUniformBlock, createGlProgram, deleteGlProgram, uniformLocations } from "./gl-program";
import { COMPUTE_STATE, applyRenderState } from "./gl-state";
import { bindTextureUnit, unbindTextureUnits } from "./gl-texture";
import { WORLD_UNIFORMS_BINDING, WORLD_UNIFORM_BYTES, bindUniformBufferBase } from "./gl-uniform-buffer";
import type {
  GlPass,
  GlProgram,
  GlSampler,
  GlTexture,
  GlUniformBuffer,
  PingPongTargets,
  WaterGlContext,
} from "./types";
import { WATER_SIMULATION_FRAGMENT_GLSL } from "./water-simulation-glsl";

/** UBO binding index of the `SimulationParams` block (contract §2.6). */
export const SIMULATION_PARAMS_BINDING = 1;

/** Sampler uniform names, in the order that fixes their texture units. */
const SAMPLER_NAMES = ["previousState", "terrainField", "longField0", "longField1", "mediumField0", "mediumField1"] as const;

/** Everything one simulation step reads. All of it is owned by the engine. */
export interface WaterSimulationStepInput {
  /** 32-byte `SimulationParams` UBO already holding the impulse or calm data. */
  readonly params: GlUniformBuffer;
  /** 513x513 terrain field; fetched with `texelFetch`, no sampler. */
  readonly terrain: GlTexture;
  readonly longField0: GlTexture;
  readonly longField1: GlTexture;
  readonly mediumField0: GlTexture;
  readonly mediumField1: GlTexture;
  /** repeat + linear; used for the spectral cascades and the foam backtrace. */
  readonly spectrumSampler: GlSampler;
}

/**
 * The compiled solver: the program plus the sampler units and uniform
 * locations resolved from it. Lives as long as the engine, independent of the
 * simulation resolution, and is disposed by whoever created it.
 */
export interface WaterSimulationProgram extends GlPass {
  readonly program: GlProgram;
  readonly units: Readonly<Record<(typeof SAMPLER_NAMES)[number], number>>;
  readonly uniforms: Readonly<Record<"uDims" | "uTerrainDims", WebGLUniformLocation | null>>;
}

/** Conservative shallow-water solver over the nearshore field. */
export interface WaterSimulationPass extends GlPass {
  /** Side of the (square) simulation grid. */
  readonly resolution: number;
  /** The state written by the most recent `step()`; zero-filled before the first. */
  currentState(): GlTexture;
  /** Advances one fixed timestep and flips the ping-pong cursor. */
  step(input: WaterSimulationStepInput): void;
  /** Zeroes both state textures and returns the cursor to index 0. */
  reset(): void;
}

function assertResolution(ctx: WaterGlContext, resolution: number): void {
  if (!Number.isInteger(resolution) || resolution < 2) {
    throw new Error(`水面模拟分辨率必须是不小于 2 的整数，收到 ${resolution}。`);
  }
  if (resolution > ctx.limits.maxTextureSize) {
    throw new Error(`水面模拟分辨率 ${resolution} 超过当前设备的最大纹理尺寸 ${ctx.limits.maxTextureSize}。`);
  }
}

function assertStepInput(input: WaterSimulationStepInput): void {
  if (input.params.byteLength !== SIMULATION_PARAM_BYTES) {
    throw new Error(
      `SimulationParams 缓冲「${input.params.label}」为 ${input.params.byteLength} 字节，` +
        `与约定的 ${SIMULATION_PARAM_BYTES} 字节不符。`,
    );
  }
  if (input.terrain.width !== input.terrain.height) {
    throw new Error(`地形场纹理「${input.terrain.label}」必须是正方形，收到 ${input.terrain.width}×${input.terrain.height}。`);
  }
  if (input.spectrumSampler.wrap !== "repeat" || input.spectrumSampler.filter !== "linear") {
    throw new Error(
      `水面模拟需要 repeat + linear 的谱采样器，收到「${input.spectrumSampler.label}」` +
        `（${input.spectrumSampler.wrap} / ${input.spectrumSampler.filter}）。`,
    );
  }
}

/**
 * Compiles the solver once. The engine keeps the result for its whole lifetime
 * and hands it to every `createWaterSimulationPass`; disposing it invalidates
 * any pass still holding it.
 */
export function createWaterSimulationProgram(ctx: WaterGlContext): WaterSimulationProgram {
  const { gl } = ctx;
  const program = createGlProgram(gl, {
    label: "waterSimulation · simulate",
    vertexSource: FULLSCREEN_TRIANGLE_VERTEX_GLSL,
    fragmentSource: WATER_SIMULATION_FRAGMENT_GLSL,
  });
  try {
    bindUniformBlock(gl, program, "WorldUniforms", WORLD_UNIFORMS_BINDING, WORLD_UNIFORM_BYTES);
    bindUniformBlock(gl, program, "SimulationParams", SIMULATION_PARAMS_BINDING, SIMULATION_PARAM_BYTES);
    const units = assignSamplerUnits(gl, program, SAMPLER_NAMES);
    const uniforms = uniformLocations(gl, program, ["uDims", "uTerrainDims"] as const);
    let disposed = false;
    return Object.freeze({
      program,
      units,
      uniforms,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        deleteGlProgram(gl, program);
      },
    });
  } catch (error) {
    deleteGlProgram(gl, program);
    throw error;
  }
}

/**
 * Creates the simulation pass with its own zero-filled ping-pong pair.
 * `resolution` is the engine's `simulationResolution` (64..512, default 256);
 * `compiled` is the engine-owned program and is **not** disposed with the pass.
 */
export function createWaterSimulationPass(
  ctx: WaterGlContext,
  compiled: WaterSimulationProgram,
  resolution: number,
): WaterSimulationPass {
  const { gl } = ctx;
  assertResolution(ctx, resolution);
  const { program, units, uniforms } = compiled;
  // Linear + clamp: the render passes sample this state bilinearly, and the
  // foam backtrace clamps its uv to [0.002, 0.998] so wrap never matters.
  const targets: PingPongTargets = createPingPongTargets(gl, {
    label: "waterState",
    width: resolution,
    height: resolution,
    formats: ["rgba16f"],
    minFilter: "linear",
    magFilter: "linear",
    wrap: "clamp",
    clearToZero: true,
  });
  let disposed = false;

  return Object.freeze({
    resolution,
    currentState: () => targets.source().color[0],
    step: (input: WaterSimulationStepInput) => {
      if (disposed) throw new Error("水面模拟 pass 已释放，无法继续推进。");
      assertStepInput(input);
      applyRenderState(gl, COMPUTE_STATE);
      bindGlProgram(gl, program);
      bindUniformBufferBase(gl, SIMULATION_PARAMS_BINDING, input.params);
      // The destination is never among the inputs (`source()` is), so binding
      // the units before the target cannot create a feedback loop (R4).
      bindTextureUnit(gl, units.previousState, targets.source().color[0], input.spectrumSampler);
      bindTextureUnit(gl, units.terrainField, input.terrain, null);
      bindTextureUnit(gl, units.longField0, input.longField0, input.spectrumSampler);
      bindTextureUnit(gl, units.longField1, input.longField1, input.spectrumSampler);
      bindTextureUnit(gl, units.mediumField0, input.mediumField0, input.spectrumSampler);
      bindTextureUnit(gl, units.mediumField1, input.mediumField1, input.spectrumSampler);
      bindFramebufferForDraw(gl, targets.destination());
      gl.uniform2i(uniforms.uDims, resolution, resolution);
      gl.uniform2i(uniforms.uTerrainDims, input.terrain.width, input.terrain.height);
      drawFullscreenTriangle(gl);
      targets.swap();
      // Leave no state texture bound: the next pass to render into one of them
      // (this pass again, or the spectral FFT into its own fields) must not
      // inherit a stale sampler binding of its own attachment.
      unbindTextureUnits(gl, SAMPLER_NAMES.map((name) => units[name]));
    },
    reset: () => {
      if (disposed) throw new Error("水面模拟 pass 已释放，无法重置。");
      targets.targets.forEach((target) => clearFramebufferToZero(gl, target));
      targets.reset();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      targets.dispose();
    },
  });
}

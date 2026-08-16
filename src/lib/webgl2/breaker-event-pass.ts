// Breaker event pass — the WebGL2 stand-in for the `updateBreakerEvents`
// compute dispatch (docs/webgl2-port/spec-compute.md §3.5, engine:2385-2388).
//
// It owns the 256x1 rgba16f ping-pong pair replacing `breakerEventTextures`,
// zero-filled at creation like every other feedback target (R18). One
// full-screen triangle with the viewport set to 256x1 covers the single row;
// `int(gl_FragCoord.x)` recovers the invocation index (R2).
//
// Ordering matters: this pass reads the water state the simulation wrote in
// the same frame, so it must run after `WaterSimulationPass.step()` and before
// the water render pass, which reads the activation this pass just produced
// (docs/webgl2-port/spec-compute.md §5, constraints 2 and 4). The WebGPU engine keeps running it
// even though `BREAKER_ENABLED` is false and the render side multiplies the
// result by zero; the port keeps that behaviour so the two backends stay
// comparable pass for pass.

import { BREAKER_EVENT_RESOLUTION } from "../water-constants";
import { bindFramebufferForDraw, clearFramebufferToZero, createPingPongTargets } from "./gl-framebuffer";
import { FULLSCREEN_TRIANGLE_VERTEX_GLSL, drawFullscreenTriangle } from "./gl-geometry";
import { assignSamplerUnits, bindGlProgram, bindUniformBlock, createGlProgram, deleteGlProgram } from "./gl-program";
import { COMPUTE_STATE, applyRenderState } from "./gl-state";
import { bindTextureUnit, unbindTextureUnits } from "./gl-texture";
import { WORLD_UNIFORMS_BINDING, WORLD_UNIFORM_BYTES } from "./gl-uniform-buffer";
import type { GlPass, GlProgram, GlSampler, GlTexture, PingPongTargets, WaterGlContext } from "./types";
import { BREAKER_EVENT_FRAGMENT_GLSL } from "./breaker-event-glsl";

/** Sampler uniform names, in the order that fixes their texture units. */
const SAMPLER_NAMES = [
  "previousEvents",
  "terrainField",
  "waterState",
  "longField0",
  "longField1",
  "mediumField0",
  "mediumField1",
] as const;

/** Everything one breaker-event update reads. */
export interface BreakerEventStepInput {
  /** 513x513 terrain field, sampled with `fieldSampler` (clamp + linear). */
  readonly terrain: GlTexture;
  /** The state the simulation pass wrote this frame (`currentState()`). */
  readonly waterState: GlTexture;
  readonly longField0: GlTexture;
  readonly longField1: GlTexture;
  readonly mediumField0: GlTexture;
  readonly mediumField1: GlTexture;
  /** clamp + linear; terrain and water state. */
  readonly fieldSampler: GlSampler;
  /** repeat + linear; the two displacing cascades. */
  readonly spectrumSampler: GlSampler;
}

/** 256-cell breaking-state history along the travelling crest line. */
export interface BreakerEventPass extends GlPass {
  /** The row written by the most recent `step()`; zero-filled before the first. */
  currentEvents(): GlTexture;
  /** Advances the history one frame and flips the ping-pong cursor. */
  step(input: BreakerEventStepInput): void;
  /** Zeroes both event textures and returns the cursor to index 0. */
  reset(): void;
}

function assertSampler(sampler: GlSampler, wrap: GlSampler["wrap"], role: string): void {
  if (sampler.wrap !== wrap || sampler.filter !== "linear") {
    throw new Error(
      `碎波事件 pass 的${role}需要 ${wrap} + linear 采样器，收到「${sampler.label}」` +
        `（${sampler.wrap} / ${sampler.filter}）。`,
    );
  }
}

interface BreakerResources {
  readonly targets: PingPongTargets;
  readonly program: GlProgram;
}

/** Allocates the 256x1 ping-pong pair and the program, unwinding on failure. */
function createBreakerResources(gl: WebGL2RenderingContext): BreakerResources {
  const targets = createPingPongTargets(gl, {
    label: "breakerEvents",
    width: BREAKER_EVENT_RESOLUTION,
    height: 1,
    formats: ["rgba16f"],
    minFilter: "linear",
    magFilter: "linear",
    wrap: "clamp",
    clearToZero: true,
  });
  try {
    const program = createGlProgram(gl, {
      label: "breakerEvents · updateBreakerEvents",
      vertexSource: FULLSCREEN_TRIANGLE_VERTEX_GLSL,
      fragmentSource: BREAKER_EVENT_FRAGMENT_GLSL,
    });
    bindUniformBlock(gl, program, "WorldUniforms", WORLD_UNIFORMS_BINDING, WORLD_UNIFORM_BYTES);
    return { targets, program };
  } catch (error) {
    targets.dispose();
    throw error;
  }
}

/** Creates the breaker event pass with its own zero-filled 256x1 ping-pong pair. */
export function createBreakerEventPass(ctx: WaterGlContext): BreakerEventPass {
  const { gl } = ctx;
  const { targets, program } = createBreakerResources(gl);
  const units = assignSamplerUnits(gl, program, SAMPLER_NAMES);
  let disposed = false;

  return Object.freeze({
    currentEvents: () => targets.source().color[0],
    step: (input: BreakerEventStepInput) => {
      if (disposed) throw new Error("碎波事件 pass 已释放，无法继续推进。");
      assertSampler(input.fieldSampler, "clamp", "地形/水面采样器");
      assertSampler(input.spectrumSampler, "repeat", "谱采样器");
      applyRenderState(gl, COMPUTE_STATE);
      bindGlProgram(gl, program);
      bindTextureUnit(gl, units.previousEvents, targets.source().color[0], null);
      bindTextureUnit(gl, units.terrainField, input.terrain, input.fieldSampler);
      bindTextureUnit(gl, units.waterState, input.waterState, input.fieldSampler);
      bindTextureUnit(gl, units.longField0, input.longField0, input.spectrumSampler);
      bindTextureUnit(gl, units.longField1, input.longField1, input.spectrumSampler);
      bindTextureUnit(gl, units.mediumField0, input.mediumField0, input.spectrumSampler);
      bindTextureUnit(gl, units.mediumField1, input.mediumField1, input.spectrumSampler);
      bindFramebufferForDraw(gl, targets.destination());
      drawFullscreenTriangle(gl);
      targets.swap();
      // Same reason as the simulation pass: nothing this pass sampled may stay
      // bound while another pass renders into it.
      unbindTextureUnits(gl, SAMPLER_NAMES.map((name) => units[name]));
    },
    reset: () => {
      if (disposed) throw new Error("碎波事件 pass 已释放，无法重置。");
      targets.targets.forEach((target) => clearFramebufferToZero(gl, target));
      targets.reset();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      deleteGlProgram(gl, program);
      targets.dispose();
    },
  });
}

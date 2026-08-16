// Fixed-function state presets matching the WebGPU pipelines one-to-one
// (docs/webgl2-port/spec-engine.md §3 and §8.2.10). Every pass applies its preset before drawing so
// no pass inherits stale depth/blend state from another module.
//
// The presets are frozen singletons, so "is the driver already in this state?"
// is an identity check against `./gl-state-cache` — five of the eight
// `applyRenderState` calls in a frame ask for the preset that is already live
// (the whole GPGPU half runs on `COMPUTE_STATE`, and the terrain uses
// `OPAQUE_STATE`). Anything that changes these flags without coming through
// here must call `invalidateRenderStateCache`.

import { isRenderStateCurrent, noteRenderState } from "./gl-state-cache";

/** Depth compare functions used by the engine. */
export type DepthCompare = "less" | "always";

/** Blend presets: none, or the water pass's straight-alpha blend. */
export type BlendPreset = "none" | "water";

/** Fixed-function state for one render pass. */
export interface RenderStatePreset {
  readonly label: string;
  readonly depthTest: boolean;
  readonly depthWrite: boolean;
  readonly depthCompare: DepthCompare;
  readonly blend: BlendPreset;
}

/** sky: no depth write, always passes (WebGPU: depthWriteEnabled false, compare always). */
export const SKY_STATE: RenderStatePreset = Object.freeze({ label: "sky", depthTest: true, depthWrite: false, depthCompare: "always", blend: "none" });
/** terrain: opaque, depth write, LESS. */
export const OPAQUE_STATE: RenderStatePreset = Object.freeze({ label: "opaque", depthTest: true, depthWrite: true, depthCompare: "less", blend: "none" });
/** water / breaker patch: depth read-only LESS, straight-alpha blend. */
export const WATER_STATE: RenderStatePreset = Object.freeze({ label: "water", depthTest: true, depthWrite: false, depthCompare: "less", blend: "water" });
/** blit / every GPGPU pass: no depth, no blend. */
export const COMPUTE_STATE: RenderStatePreset = Object.freeze({ label: "compute", depthTest: false, depthWrite: false, depthCompare: "always", blend: "none" });

/**
 * Applies a preset. Culling is always disabled (every WebGPU pipeline uses
 * `cullMode: "none"`), scissor is always disabled, and colour writes are all on.
 *
 * Returns immediately when the context is already in `preset` — the sequence of
 * GL calls below is deterministic per preset, so re-issuing it cannot change
 * anything the driver is not already set to.
 */
export function applyRenderState(gl: WebGL2RenderingContext, preset: RenderStatePreset): void {
  if (isRenderStateCurrent(gl, preset)) return;
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.SCISSOR_TEST);
  gl.colorMask(true, true, true, true);
  if (preset.depthTest) {
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(preset.depthCompare === "less" ? gl.LESS : gl.ALWAYS);
  } else {
    gl.disable(gl.DEPTH_TEST);
  }
  gl.depthMask(preset.depthWrite);
  const blend = preset.blend === "water";
  if (blend) {
    gl.enable(gl.BLEND);
    // WebGPU: color src-alpha / one-minus-src-alpha, alpha one / one-minus-src-alpha.
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.blendEquation(gl.FUNC_ADD);
  } else {
    gl.disable(gl.BLEND);
  }
  noteRenderState(gl, preset, {
    depthTest: preset.depthTest,
    depthWrite: preset.depthWrite,
    depthFunc: preset.depthCompare === "less" ? gl.LESS : gl.ALWAYS,
    blend,
  });
}

// The two uniform-block writes one frame performs, as functions over explicit
// inputs. Both are the CPU packers from `src/lib/water-frame.ts` followed by a
// single `bufferSubData`; nothing here reads or writes engine state, which is
// what lets `webgl2-water-engine.ts` stay about lifetime and ordering.

import { OPEN_WATER_VIEW_SCALE } from "../water-constants";
import { computeFrameState, computeSimulationParams, packWorldUniforms, type CameraOrbitState, type FrameState } from "../water-frame";
import type { WaterLabOptions } from "../water-lab-types";
import { updateUniformBuffer } from "./gl-uniform-buffer";
import type { GlUniformBuffer } from "./types";

/** Everything the 256-byte `WorldUniforms` block is derived from. */
export interface WorldUniformWrite {
  readonly gl: WebGL2RenderingContext;
  readonly worldUbo: GlUniformBuffer;
  readonly options: WaterLabOptions;
  readonly camera: CameraOrbitState;
  /** requestAnimationFrame timestamp, and `performance.now()` at loop start. */
  readonly timestamp: number;
  readonly startTime: number;
  /** Backing-store size of the render target, not the CSS size. */
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

/**
 * Solves the camera for this frame, packs `WorldUniforms` and uploads it.
 * Returns the frame state, because the simulation write and the engine's own
 * `elapsedSeconds` both need it.
 */
export function writeWorldUniforms(input: WorldUniformWrite): FrameState {
  const frame = computeFrameState({
    options: input.options,
    camera: input.camera,
    timestamp: input.timestamp,
    startTime: input.startTime,
    canvasWidth: input.canvasWidth,
    canvasHeight: input.canvasHeight,
    // WebGL2 has no `glClipControl`: the projection has to produce the
    // classic [-1, 1] clip depth (docs/webgl2-port/contract.md §3.4).
    depthRange: "minus-one-to-one",
  });
  updateUniformBuffer(input.gl, input.worldUbo, packWorldUniforms({
    frame,
    options: input.options,
    canvasWidth: input.canvasWidth,
    canvasHeight: input.canvasHeight,
    // How much further than the authored 145 m the camera can see. Both
    // scenes currently share this one constant; nothing branches on the scene.
    worldScale: OPEN_WATER_VIEW_SCALE,
  }));
  return frame;
}

/** Everything the two 32-byte `SimulationParams` blocks are derived from. */
export interface SimulationParamWrite {
  readonly gl: WebGL2RenderingContext;
  readonly impulseUbo: GlUniformBuffer;
  readonly calmUbo: GlUniformBuffer;
  readonly frame: FrameState;
  readonly options: WaterLabOptions;
  /** Simulated time of the previous wake impulse. */
  readonly lastWakeAt: number;
}

/**
 * Uploads the impulse block and its impulse-free twin (the reference mode's
 * second sub-step). Returns whether this frame emitted a wake, so the caller
 * can advance its own throttle state.
 */
export function writeSimulationParams(input: SimulationParamWrite): boolean {
  const params = computeSimulationParams({
    playerPosition: input.frame.playerPosition,
    elapsedSeconds: input.frame.elapsedSeconds,
    lastWakeAt: input.lastWakeAt,
    mode: input.options.mode,
  });
  updateUniformBuffer(input.gl, input.impulseUbo, params.impulse);
  updateUniformBuffer(input.gl, input.calmUbo, params.calm);
  return params.wakeTriggered;
}

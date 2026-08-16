// `WaterLabMetrics` assembly. The formulas are the original renderer's
// (docs/webgl2-port/spec-engine.md §1.5) verbatim — same triangle accounting,
// same nearest-rank percentiles, same 50 ms hitch threshold — so a capture from
// this engine compares like with like against one from the source. Nothing here
// touches a GPU API: the caller hands in the sample buffers it already keeps.

import {
  BREAKER_ENABLED,
  BREAKER_PATCH_TRIANGLES,
  FRAME_HISTORY,
  SHORE_TERRAIN_MESH_RESOLUTION,
  WATER_CLIPMAP_LEVELS,
  WATER_CLIPMAP_RESOLUTION,
} from "./water-constants";
import type { WaterLabMetrics, WaterLabOptions } from "./water-lab-types";
import { mean, percentile } from "./water-math";
import { waterSimulationBytes } from "./water-profiles";

/** Frames slower than this count as hitches. */
const HITCH_THRESHOLD_MS = 50;
/** Outer clipmap rings degenerate at their centre; 1.5 is the authored approximation. */
const OUTER_RING_TRIANGLE_FACTOR = 1.5;

/** Everything the engine has to hand when the UI asks for metrics. */
export interface MetricsInput {
  readonly ready: boolean;
  readonly options: WaterLabOptions;
  readonly disturbanceCount: number;
  readonly frameTimes: readonly number[];
  readonly submitTimes: readonly number[];
  readonly gpuSimulationTimes: readonly number[];
  readonly gpuRenderTimes: readonly number[];
  readonly adapter: string;
  readonly error: string | null;
}

/**
 * Appends one timing sample and drops the oldest until at most `limit` remain,
 * so the buffer is a bounded sliding window of the most recent `FRAME_HISTORY`
 * values — an array that shifts, not a ring buffer with a moving write index.
 * The only place the engine mutates a sample buffer.
 */
export function pushBoundedSample(samples: number[], value: number, limit: number = FRAME_HISTORY): void {
  samples.push(value);
  while (samples.length > limit) samples.shift();
}

/** Triangles submitted per frame: terrain + clipmap rings + breaker patch. */
export function frameTriangleCount(options: WaterLabOptions): number {
  const terrainResolution = options.scene === "shore" ? SHORE_TERRAIN_MESH_RESOLUTION : options.meshResolution;
  const ring = WATER_CLIPMAP_RESOLUTION * WATER_CLIPMAP_RESOLUTION;
  return terrainResolution * terrainResolution * 2
    + ring * 2
    + (WATER_CLIPMAP_LEVELS - 1) * ring * OUTER_RING_TRIANGLE_FACTOR
    + (BREAKER_ENABLED ? BREAKER_PATCH_TRIANGLES : 0);
}

/** Builds the metrics snapshot handed to the UI and the benchmark scripts. */
export function buildWaterLabMetrics(input: MetricsInput): WaterLabMetrics {
  const { options, frameTimes, gpuSimulationTimes, gpuRenderTimes } = input;
  const frameMeanMs = mean(frameTimes);
  return {
    ready: input.ready,
    mode: options.mode,
    view: options.view,
    meshResolution: options.meshResolution,
    simulationResolution: options.simulationResolution,
    waveScale: options.waveScale,
    distantRoughness: options.distantRoughness,
    detailRange: options.detailRange,
    swellSmoothing: options.swellSmoothing,
    longCascadeScale: options.longCascadeScale,
    mediumCascadeScale: options.mediumCascadeScale,
    fogReach: options.fogReach,
    triangles: frameTriangleCount(options),
    simulationBytes: waterSimulationBytes(options.simulationResolution),
    simulationSubsteps: options.mode === "reference" ? 2 : 1,
    sceneCapturePasses: options.scene === "shore" ? 1 : 0,
    disturbanceCount: input.disturbanceCount,
    particleCount: 0,
    frameMeanMs,
    frameP95Ms: percentile(frameTimes, 0.95),
    frameP99Ms: percentile(frameTimes, 0.99),
    frameMaxMs: frameTimes.length ? Math.max(...frameTimes) : 0,
    fps: frameMeanMs > 0 ? 1000 / frameMeanMs : 0,
    hitchFrames: frameTimes.filter((value) => value > HITCH_THRESHOLD_MS).length,
    submitMeanMs: mean(input.submitTimes),
    gpuSimulationMeanMs: gpuSimulationTimes.length ? mean(gpuSimulationTimes) : null,
    gpuSimulationP95Ms: gpuSimulationTimes.length ? percentile(gpuSimulationTimes, 0.95) : null,
    gpuRenderMeanMs: gpuRenderTimes.length ? mean(gpuRenderTimes) : null,
    gpuRenderP95Ms: gpuRenderTimes.length ? percentile(gpuRenderTimes, 0.95) : null,
    gpuTimestampSamples: Math.min(gpuSimulationTimes.length, gpuRenderTimes.length),
    adapter: input.adapter,
    error: input.error,
  };
}

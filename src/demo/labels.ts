// Presentation tables for the demo panel: what to show before the engine has
// reported, and how wide each slider may go.
//
// Split out of `panel.ts` so that file stays about DOM construction. All of it
// is frozen data or pure functions, which is also what makes the "the slider
// range comes from `WATER_LAB_OPTION_BOUNDS`, never a second copy of it" rule
// checkable at a glance.

import {
  DEFAULT_WATER_LAB_OPTIONS,
  WATER_LAB_OPTION_BOUNDS,
  type NumericWaterLabOption,
  type WaterLabMetrics,
} from "../lib/water-lab-types";
import { frameTriangleCount } from "../lib/water-metrics";

/** Adapter placeholder shown until the engine reports its own string. */
export const PENDING_ADAPTER_LABEL = "正在请求 WebGL2 上下文…";

/** Slider granularity per option; the range itself comes from the shared bounds. */
const SLIDER_STEPS: Readonly<Record<NumericWaterLabOption, number>> = Object.freeze({
  meshResolution: 8,
  simulationResolution: 64,
  renderScale: 0.05,
  waveScale: 0.05,
  distantRoughness: 0.05,
  detailRange: 0.1,
  swellSmoothing: 0.05,
  longCascadeScale: 10,
  mediumCascadeScale: 4,
  fogReach: 0.05,
});

/**
 * `min`/`max`/`step` for one slider. The range is read from
 * `WATER_LAB_OPTION_BOUNDS` rather than repeated here, so a panel control can
 * never offer a value the engine would clamp away (or hide one it accepts).
 */
export function sliderRange(option: NumericWaterLabOption): { min: number; max: number; step: number } {
  return {
    min: WATER_LAB_OPTION_BOUNDS[option].min,
    max: WATER_LAB_OPTION_BOUNDS[option].max,
    step: SLIDER_STEPS[option],
  };
}

/**
 * The metrics the panel shows before the engine has reported for the first
 * time. `triangles` is computed rather than transcribed, so the first paint
 * cannot disagree with the clipmap the engine actually submits.
 */
export const PENDING_METRICS: WaterLabMetrics = Object.freeze({
  ready: false,
  mode: DEFAULT_WATER_LAB_OPTIONS.mode,
  view: DEFAULT_WATER_LAB_OPTIONS.view,
  meshResolution: DEFAULT_WATER_LAB_OPTIONS.meshResolution,
  simulationResolution: DEFAULT_WATER_LAB_OPTIONS.simulationResolution,
  waveScale: DEFAULT_WATER_LAB_OPTIONS.waveScale,
  distantRoughness: DEFAULT_WATER_LAB_OPTIONS.distantRoughness,
  detailRange: DEFAULT_WATER_LAB_OPTIONS.detailRange,
  swellSmoothing: DEFAULT_WATER_LAB_OPTIONS.swellSmoothing,
  longCascadeScale: DEFAULT_WATER_LAB_OPTIONS.longCascadeScale,
  mediumCascadeScale: DEFAULT_WATER_LAB_OPTIONS.mediumCascadeScale,
  fogReach: DEFAULT_WATER_LAB_OPTIONS.fogReach,
  triangles: frameTriangleCount(DEFAULT_WATER_LAB_OPTIONS),
  simulationBytes: 1_048_576,
  simulationSubsteps: 1,
  sceneCapturePasses: 0,
  disturbanceCount: 0,
  particleCount: 0,
  frameMeanMs: 0,
  frameP95Ms: 0,
  frameP99Ms: 0,
  frameMaxMs: 0,
  fps: 0,
  hitchFrames: 0,
  submitMeanMs: 0,
  gpuSimulationMeanMs: null,
  gpuSimulationP95Ms: null,
  gpuRenderMeanMs: null,
  gpuRenderP95Ms: null,
  gpuTimestampSamples: 0,
  adapter: PENDING_ADAPTER_LABEL,
  error: null,
});

export function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    notation: value >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: 2,
  }).format(value);
}

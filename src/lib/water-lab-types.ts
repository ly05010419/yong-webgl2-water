// Public option and metric shapes of the water engine. They live apart from
// the engine class so the panel, the URL parser and the tests can depend on the
// option surface without pulling in a line of GL.

import { LONG_SCALE_RANGE, MEDIUM_SCALE_RANGE } from "./spectral-ocean";
import {
  MAX_DETAIL_RANGE,
  MAX_DISTANT_ROUGHNESS,
  MAX_FOG_REACH,
  MAX_SWELL_SMOOTHING,
  MAX_WAVE_SCALE,
  MIN_DETAIL_RANGE,
  MIN_WAVE_SCALE,
} from "./water-constants";
import type { WaterRenderMode, WaterScene, WaterView } from "./water-profiles";

export type WaterLabOptions = {
  mode: WaterRenderMode;
  view: WaterView;
  meshResolution: number;
  simulationResolution: number;
  renderScale: number;
  waveScale: number;
  distantRoughness: number;
  detailRange: number;
  swellSmoothing: number;
  longCascadeScale: number;
  mediumCascadeScale: number;
  fogReach: number;
  fixedTime?: number;
  /**
   * Stop the render loop after this many rendered frames. `undefined` (the
   * default) runs forever. A fixed `fixedTime` plus a fixed `frameLimit`
   * produces byte-comparable captures.
   */
  frameLimit?: number;
  benchmark?: boolean;
  cameraYaw?: number;
  cameraPitch?: number;
  scene: WaterScene;
};

export const DEFAULT_WATER_LAB_OPTIONS: Readonly<WaterLabOptions> = Object.freeze({
  mode: "optimized",
  view: "surface",
  scene: "open",
  meshResolution: 240,
  simulationResolution: 256,
  renderScale: 1,
  waveScale: 1,
  distantRoughness: 0,
  detailRange: 1,
  swellSmoothing: 1,
  longCascadeScale: 240,
  mediumCascadeScale: 64,
  fogReach: 0,
  benchmark: false,
});

export type WaterLabMetrics = {
  ready: boolean;
  mode: WaterRenderMode;
  view: WaterView;
  meshResolution: number;
  simulationResolution: number;
  waveScale: number;
  distantRoughness: number;
  detailRange: number;
  swellSmoothing: number;
  longCascadeScale: number;
  mediumCascadeScale: number;
  fogReach: number;
  triangles: number;
  simulationBytes: number;
  simulationSubsteps: number;
  sceneCapturePasses: number;
  disturbanceCount: number;
  particleCount: number;
  frameMeanMs: number;
  frameP95Ms: number;
  frameP99Ms: number;
  frameMaxMs: number;
  fps: number;
  hitchFrames: number;
  submitMeanMs: number;
  gpuSimulationMeanMs: number | null;
  gpuSimulationP95Ms: number | null;
  gpuRenderMeanMs: number | null;
  gpuRenderP95Ms: number | null;
  gpuTimestampSamples: number;
  adapter: string;
  error: string | null;
};

/**
 * Clamp range of every numeric option, in one place so the constructor and the
 * setters cannot drift apart. The bounds are the ones the
 * setters have always applied; `integer` marks the two resolutions, which are
 * floored before clamping (for integer bounds the two orders agree).
 */
export const WATER_LAB_OPTION_BOUNDS = Object.freeze({
  meshResolution: Object.freeze({ min: 96, max: 320, integer: true }),
  simulationResolution: Object.freeze({ min: 64, max: 512, integer: true }),
  renderScale: Object.freeze({ min: 0.5, max: 1.25, integer: false }),
  waveScale: Object.freeze({ min: MIN_WAVE_SCALE, max: MAX_WAVE_SCALE, integer: false }),
  distantRoughness: Object.freeze({ min: 0, max: MAX_DISTANT_ROUGHNESS, integer: false }),
  detailRange: Object.freeze({ min: MIN_DETAIL_RANGE, max: MAX_DETAIL_RANGE, integer: false }),
  swellSmoothing: Object.freeze({ min: 0, max: MAX_SWELL_SMOOTHING, integer: false }),
  longCascadeScale: Object.freeze({ min: LONG_SCALE_RANGE[0], max: LONG_SCALE_RANGE[1], integer: false }),
  mediumCascadeScale: Object.freeze({ min: MEDIUM_SCALE_RANGE[0], max: MEDIUM_SCALE_RANGE[1], integer: false }),
  fogReach: Object.freeze({ min: 0, max: MAX_FOG_REACH, integer: false }),
});

/** The `WaterLabOptions` fields that carry a clamp range. */
export type NumericWaterLabOption = keyof typeof WATER_LAB_OPTION_BOUNDS;

/**
 * Clamps one numeric option. A non-finite input falls back to that option's
 * default rather than propagating `NaN` into a texture size or a matrix — the
 * fallbacks the setters already used (`waveScale` 1, `fogReach` 0, …) are
 * exactly the defaults, so this is the same rule stated once.
 */
export function normalizeWaterLabOption(option: NumericWaterLabOption, value: number): number {
  const bound = WATER_LAB_OPTION_BOUNDS[option];
  const candidate = bound.integer ? Math.floor(value) : value;
  const resolved = Number.isFinite(candidate) ? candidate : DEFAULT_WATER_LAB_OPTIONS[option];
  return Math.max(bound.min, Math.min(bound.max, resolved));
}

/**
 * Fills in the defaults and clamps every numeric field, so an engine built from
 * caller-supplied options starts in exactly the state the equivalent sequence
 * of setters would have produced. Pure: the input is never mutated, and keys
 * absent from `input` stay absent unless `DEFAULT_WATER_LAB_OPTIONS` has them
 * (`fixedTime`, `frameLimit` and the camera overrides remain optional).
 */
export function normalizeWaterLabOptions(input: Partial<WaterLabOptions> = {}): WaterLabOptions {
  const merged = { ...DEFAULT_WATER_LAB_OPTIONS, ...input };
  return {
    ...merged,
    meshResolution: normalizeWaterLabOption("meshResolution", merged.meshResolution),
    simulationResolution: normalizeWaterLabOption("simulationResolution", merged.simulationResolution),
    renderScale: normalizeWaterLabOption("renderScale", merged.renderScale),
    waveScale: normalizeWaterLabOption("waveScale", merged.waveScale),
    distantRoughness: normalizeWaterLabOption("distantRoughness", merged.distantRoughness),
    detailRange: normalizeWaterLabOption("detailRange", merged.detailRange),
    swellSmoothing: normalizeWaterLabOption("swellSmoothing", merged.swellSmoothing),
    longCascadeScale: normalizeWaterLabOption("longCascadeScale", merged.longCascadeScale),
    mediumCascadeScale: normalizeWaterLabOption("mediumCascadeScale", merged.mediumCascadeScale),
    fogReach: normalizeWaterLabOption("fogReach", merged.fogReach),
  };
}

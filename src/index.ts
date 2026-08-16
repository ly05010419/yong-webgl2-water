// Public entry point of `yong-webgl2-water`: the WebGL2 Tethys water engine and
// the option/metric surface a host application needs to drive it.
//
// Everything below is either the engine itself, a pure helper over its options,
// or a constant a caller would otherwise have to transcribe. The `src/lib/webgl2/`
// layer is deliberately *not* re-exported here — it is the engine's internals,
// and pinning it into the package surface would freeze thirty modules that
// exist to be rearranged.

export { WebGl2WaterEngine } from "./lib/webgl2-water-engine";

export {
  DEFAULT_WATER_LAB_OPTIONS,
  WATER_LAB_OPTION_BOUNDS,
  normalizeWaterLabOption,
  normalizeWaterLabOptions,
  type NumericWaterLabOption,
  type WaterLabMetrics,
  type WaterLabOptions,
} from "./lib/water-lab-types";

export {
  TETHYS_REFERENCE_SIMULATION_RESOLUTION,
  TETHYS_WATER_FIELD_SIZE,
  TETHYS_WATER_LEVEL,
  WATER_PROFILES,
  waterSimulationBytes,
  waterTriangleCount,
  type WaterRenderMode,
  type WaterScene,
  type WaterView,
} from "./lib/water-profiles";

// `?mode=…&scene=…` → a fully defaulted, clamped `WaterLabOptions`. Pure and
// DOM-free, so a host can parse its own query string without a browser.
export { parseWaterLabQuery, type WaterLabQuery } from "./lib/water-lab-query";

// The orbit camera the engine drives itself. Exported so a host that wants its
// own camera can reuse the same clamps rather than re-deriving them.
export {
  DEFAULT_CAMERA_ORBIT,
  MAX_CAMERA_PITCH,
  MIN_CAMERA_PITCH,
  MIN_ORBIT_RADIUS,
  clampCameraPitch,
  resolveInitialCameraOrbit,
  type CameraOrbitState,
} from "./lib/water-interaction";

// Metric assembly, for a host that renders its own panel from the same numbers.
export { frameTriangleCount } from "./lib/water-metrics";

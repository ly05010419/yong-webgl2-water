export type WaterRenderMode = "optimized" | "reference";
export type WaterView = "surface" | "underwater";
export type WaterScene = "open" | "shore";

export const TETHYS_WATER_LEVEL = 1.4;
// The nearshore residual solver covers the central island shelf and its
// approach. At 256² this is a 0.75 m cell, small enough for visible shoaling
// while the spectral cascades continue to own the far ocean.
export const TETHYS_WATER_FIELD_SIZE = 192;
export const TETHYS_REFERENCE_SIMULATION_RESOLUTION = 256;

export const WATER_PROFILES = Object.freeze([
  Object.freeze({ id: "balanced", label: "特提斯均衡", meshResolution: 240, simulationResolution: 256, renderScale: 1 }),
  Object.freeze({ id: "dense", label: "密集水面", meshResolution: 240, simulationResolution: 384, renderScale: 1 }),
  Object.freeze({ id: "long", label: "广阔海洋", meshResolution: 220, simulationResolution: 256, renderScale: 1.1 }),
]);

export function waterTriangleCount(meshResolution: number) {
  return meshResolution * meshResolution * 4;
}

export function waterSimulationBytes(resolution: number) {
  return resolution * resolution * 8 * 2;
}

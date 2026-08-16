// Aggregate entry point for the three GPGPU fragment shaders that replace the
// WebGPU compute pipelines of the nearshore solver:
//
//   TERRAIN_FIELD_FRAGMENT_GLSL     ← buildTerrain        (docs/webgl2-port/spec-compute.md §3.1)
//   WATER_SIMULATION_FRAGMENT_GLSL  ← simulate            (docs/webgl2-port/spec-compute.md §3.4)
//   BREAKER_EVENT_FRAGMENT_GLSL     ← updateBreakerEvents (docs/webgl2-port/spec-compute.md §3.5)
//
// Each lives in its own module so no single file carries three shaders' worth
// of transcription notes; import from here (or from the individual modules —
// both are stable) when you want all three.

export { TERRAIN_FIELD_FRAGMENT_GLSL } from "./terrain-field-glsl";
export { WATER_SIMULATION_FRAGMENT_GLSL } from "./water-simulation-glsl";
export { BREAKER_EVENT_FRAGMENT_GLSL } from "./breaker-event-glsl";

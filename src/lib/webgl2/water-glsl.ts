// Aggregate entry point for the WebGL2 water shader sources.
//
// The port is split across three files purely to keep each under the 400-line
// budget; together they are a line-for-line translation of the frozen WGSL
// `WATER_RENDER_SHADER` (`webgpu-water-engine.ts@7dbf39c:909-1535`):
//
//   water-surface-glsl.ts   bindings, BRDF helpers, breaker family,
//                           `evaluateWaterSurface`   (WGSL 911-1136)
//   water-vertex-glsl.ts    `waterVertex`, `breakerPatchVertex` (WGSL 1138-1285)
//   water-fragment-glsl.ts  `waterFragment`                     (WGSL 1287-1535)
//
// The four WebGPU pipelines map onto four GL programs: {clipmap, breaker patch}
// x {REFERENCE_MODE 0, REFERENCE_MODE 1}, the constant supplied as a `#define`
// through `createGlProgram({ defines })`.

export {
  WATER_SAMPLER_NAMES,
  WATER_SURFACE_GLSL,
  WATER_SURFACE_SAMPLERS_GLSL,
  WATER_FRAGMENT_SAMPLERS_GLSL,
  WATER_VARYINGS,
  waterVaryingsGlsl,
  type WaterVarying,
} from "./water-surface-glsl";

export { WATER_BREAKER_PATCH_VERTEX_GLSL, WATER_VERTEX_GLSL } from "./water-vertex-glsl";

export { WATER_FRAGMENT_GLSL } from "./water-fragment-glsl";

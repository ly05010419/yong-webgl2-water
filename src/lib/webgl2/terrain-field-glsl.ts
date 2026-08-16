// GLSL ES 3.00 port of the `buildTerrain` compute shader
// (`webgpu-water-engine.ts@7dbf39c:325-346`, docs/webgl2-port/spec-compute.md §3.1).
//
// The WGSL wrote a single `texture_storage_2d<rgba16float, write>`; here the
// pass renders a full-screen triangle into a 513x513 single-attachment FBO
// (docs/webgl2-port/spec-compute.md R2), so `@builtin(global_invocation_id)` becomes
// `ivec2(gl_FragCoord.xy)` and `textureStore` becomes the `out vec4`.
//
// `textureDimensions(fieldOut)` has no GLSL equivalent (R8) and is replaced by
// `uFieldDims`. The two distinct uses of it in the WGSL are reproduced
// separately: `dimensions - 1` for the closed-interval uv, and
// `dimensions.x - 1` for the central-difference spacing.
//
// Imports go straight to `./shared-glsl` rather than the barrel: these
// constants are built at module-evaluation time, so a future barrel re-export
// of this file must not be able to observe them in their temporal dead zone.

import { TERRAIN_HEIGHT_GLSL, WORLD_UNIFORMS_GLSL } from "./shared-glsl";

/**
 * Fragment body for the static terrain field. Pair it with
 * `FULLSCREEN_TRIANGLE_VERTEX_GLSL`.
 *
 * Uniforms: `WorldUniforms` block (binding 0) — reads `terrain.x`
 * (TERRAIN_EXTENT) and `environment.x` (shoreMix) — plus `uFieldDims`.
 * No samplers. Output: `(height, N.x, N.z, 0)` into an rgba16f target, with
 * the normal's y component restored downstream as `sqrt(1 - g² - b²)`.
 */
export const TERRAIN_FIELD_FRAGMENT_GLSL = /* glsl */ `
${WORLD_UNIFORMS_GLSL}
${TERRAIN_HEIGHT_GLSL}
// Replaces textureDimensions(fieldOut); always (513, 513).
uniform ivec2 uFieldDims;

layout(location = 0) out vec4 outField;

void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  vec2 dimensions = vec2(uFieldDims);
  // The viewport already equals the target, so this never fires; it is kept
  // because the WGSL had it and removing guards is how ports drift.
  if (id.x >= uFieldDims.x || id.y >= uFieldDims.y) { discard; }
  vec2 uv = vec2(id) / (dimensions - vec2(1.0));
  vec2 p = (uv - vec2(0.5)) * uniforms.terrain.x;
  float spacing = uniforms.terrain.x / float(uFieldDims.x - 1);
  float height = terrainHeight(p, uniforms.environment.x);
  float left = terrainHeight(p - vec2(spacing, 0.0), uniforms.environment.x);
  float right = terrainHeight(p + vec2(spacing, 0.0), uniforms.environment.x);
  float back = terrainHeight(p - vec2(0.0, spacing), uniforms.environment.x);
  float front = terrainHeight(p + vec2(0.0, spacing), uniforms.environment.x);
  vec3 normal = normalize(vec3(left - right, spacing * 2.0, back - front));
  outField = vec4(height, normal.x, normal.z, 0.0);
}
`;

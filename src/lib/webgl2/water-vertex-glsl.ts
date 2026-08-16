// GLSL ES 3.00 ports of the two water vertex stages.
//
// Source of truth: the frozen WGSL `WATER_RENDER_SHADER`
// (`webgpu-water-engine.ts@7dbf39c`): `waterVertex` 1138-1214 and
// `breakerPatchBreakup` / `breakerPatchExtra` / `breakerPatchVertex` 1216-1285.
//
// Translation notes beyond docs/webgl2-port/contract.md §3.3:
// - `@builtin(vertex_index)` → `gl_VertexID`, `@builtin(instance_index)` →
//   `gl_InstanceID`; both are `int`, so every use is explicitly converted
//   (`uint(gl_VertexID)` for the cell arithmetic, `float(gl_InstanceID)` for
//   the clipmap level).
// - `all(abs(a - b) < vec2(c))` → `all(lessThan(abs(a - b), vec2(c)))`: GLSL has
//   no component-wise `<` operator on vectors.
// - The horizon skirt writes `clip.z = clip.w * 0.99998` rather than the WGSL's
//   `0.99999`, because the GL projection maps clip z to [-1, 1] instead of
//   [0, 1] (contract §3.4). After the viewport transform both land on the same
//   window depth 0.999995.
// - `output.position` → `gl_Position`; the `Output` struct's `@location(n)`
//   fields become the `v*` varyings declared by `waterVaryingsGlsl("out")`.

import {
  BREAKER_PATCH_ACROSS_RESOLUTION,
  BREAKER_PATCH_ALONG_RESOLUTION,
  BREAKER_SHADER_GATE,
  WATER_CLIPMAP_LEVELS,
  WATER_CLIPMAP_RESOLUTION,
  WATER_HORIZON_REACH,
} from "../water-constants";
import { WORLD_UNIFORMS_GLSL } from "./shared-glsl";
import { WATER_SURFACE_GLSL, WATER_SURFACE_SAMPLERS_GLSL, waterVaryingsGlsl } from "./water-surface-glsl";

/**
 * The six corners of one grid cell, shared by both vertex stages
 * (WGSL 1139-1142 / 1242-1245). Declared once at global scope and marked const
 * rather than re-declared as a local array at the top of each `main()`: the
 * table is a compile-time constant and both stages read it. Values unchanged.
 */
const CELL_CORNERS_GLSL = /* glsl */ `const uvec2 corners[6] = uvec2[6](
  uvec2(0u, 0u), uvec2(0u, 1u), uvec2(1u, 0u),
  uvec2(0u, 1u), uvec2(1u, 1u), uvec2(1u, 0u)
);
`;

/** Prelude every water vertex stage needs: uniforms, samplers, shared surface code, varyings, cell table. */
const WATER_VERTEX_PRELUDE = `${WORLD_UNIFORMS_GLSL}${WATER_SURFACE_SAMPLERS_GLSL}${WATER_SURFACE_GLSL}${waterVaryingsGlsl("out")}${CELL_CORNERS_GLSL}`;

/**
 * `waterVertex` (WGSL 1138-1214): the 10-level camera-snapped clipmap drawn as
 * `drawArraysInstanced(TRIANGLES, 0, 64 * 64 * 6, 10)`.
 */
export const WATER_VERTEX_GLSL = /* glsl */ `${WATER_VERTEX_PRELUDE}
void main() {
  bool onHorizonSkirt = false;
  uint resolution = ${WATER_CLIPMAP_RESOLUTION}u;
  uint cellId = uint(gl_VertexID) / 6u;
  uvec2 cell = uvec2(cellId % resolution, cellId / resolution);
  uvec2 grid = cell + corners[uint(gl_VertexID) % 6u];
  vec2 uv = vec2(grid) / float(resolution);
  // Both scenes share the camera-snapped clipmap: the island scene is the
  // same open ocean with the authored archipelago exposed at the world centre.
  vec2 baseP = vec2(0.0);
  {
    float level = float(gl_InstanceID);
    float halfExtent = 32.0 * exp2(level);
    float cellSize = halfExtent * 2.0 / float(resolution);
    vec2 snappedCamera = floor(uniforms.cameraTime.xz / cellSize) * cellSize;
    baseP = snappedCamera + (uv - vec2(0.5)) * halfExtent * 2.0;
    if (gl_InstanceID > 0) {
      // Degenerate the covered centre of each coarser level. A one-cell
      // underlap keeps T-junctions hidden while all ring origins stay snapped.
      float innerHalf = halfExtent * 0.5 - cellSize;
      vec2 cellCenter = snappedCamera + ((vec2(cell) + vec2(0.5)) / float(resolution) - vec2(0.5)) * halfExtent * 2.0;
      if (all(lessThan(abs(cellCenter - snappedCamera), vec2(innerHalf)))) {
        baseP = vec2(10000.0);
      }
    }
    // The rings are a finite square, so their outer edge is a visible cut
    // wherever fog does not reach it. Push the outermost ring of vertices out
    // to the horizon: the last row of quads becomes a skirt that closes the gap
    // to the skyline. Those triangles are enormous but land within a few pixels
    // of the horizon, where the surface is far below one sample per wave
    // anyway. Without this, removing the fog wall just exposes the cut.
    if (gl_InstanceID == ${WATER_CLIPMAP_LEVELS - 1}) {
      onHorizonSkirt = grid.x == 0u || grid.x == resolution || grid.y == 0u || grid.y == resolution;
      if (onHorizonSkirt) {
        vec2 outward = baseP - snappedCamera;
        float reach = max(abs(outward.x), abs(outward.y));
        baseP = snappedCamera + outward * (${WATER_HORIZON_REACH}.0 / max(reach, 1.0));
      }
    }
  }
  float coordinateStep = 0.55;
  vec2 p = adaptiveBreakerCoordinates(baseP, uniforms.cameraTime.w);
  vec2 pDx = (adaptiveBreakerCoordinates(baseP + vec2(coordinateStep, 0.0), uniforms.cameraTime.w) - p) / coordinateStep;
  vec2 pDz = (adaptiveBreakerCoordinates(baseP + vec2(0.0, coordinateStep), uniforms.cameraTime.w) - p) / coordinateStep;
  SurfaceEvaluation surface = evaluateWaterSurface(p);
  vec3 tangentX = surface.tangentPX * pDx.x + surface.tangentPZ * pDx.y;
  vec3 tangentZ = surface.tangentPX * pDz.x + surface.tangentPZ * pDz.y;
  vec2 breakerCoord = breakerCoordinates(p, uniforms.cameraTime.w);
  if (onHorizonSkirt) {
    // Project the skirt vertex as a direction so it lands on the horizon, and
    // flatten the direction's vertical component first: from a high orbit the
    // eye-to-vertex drop would otherwise depress the skirt's square rim by
    // atan(eyeHeight / 20 km) below the true horizon, exposing its corners.
    vec3 towardHorizon = surface.world - uniforms.cameraTime.xyz;
    towardHorizon.y = 0.0;
    vec4 horizonClip = uniforms.viewProj * vec4(towardHorizon, 0.0);
    horizonClip.z = horizonClip.w * 0.99998;
    gl_Position = horizonClip;
  } else {
    gl_Position = uniforms.viewProj * vec4(surface.world, 1.0);
  }
  vWorld = surface.world;
  vNormal = normalize(cross(tangentZ, tangentX));
  vFieldUv = surface.fieldUv;
  vSimulationUv = surface.simulationUv;
  vWaveHeight = surface.waveHeight;
  vCompression = surface.compression;
  vBreakerLip = surface.breakerLip;
  vBreakerCoord = breakerCoord;
  vSurfaceKind = 0.0;
}
`;

/** `breakerPatchBreakup` / `breakerPatchExtra` (WGSL 1216-1239): patch-only helpers. */
const BREAKER_PATCH_HELPERS_GLSL = /* glsl */ `
float breakerPatchBreakup(float along, float time) {
  float breakupSignal = sin(along * 0.041 + time * 0.08 + 0.4)
    + 0.48 * sin(along * 0.097 - time * 0.035 - 1.2);
  return smoothstep(-0.10, 0.65, breakupSignal);
}

vec3 breakerPatchExtra(float across, float along, float time) {
  vec2 travelDirection = normalize(vec2(0.887, -0.462));
  float frontVisibility = breakerFrontVisibility(breakerFrontPosition(time));
  float u = across / 9.0;
  float edgeWindow = 1.0 - smoothstep(0.70, 1.24, abs(u));
  float alongWindow = 1.0 - smoothstep(158.0, 176.0, abs(along));
  float envelope = exp(-0.58 * u * u) * edgeWindow * alongWindow * frontVisibility * breakerEventActivation(along) * (1.0 - uniforms.environment.x) * ${BREAKER_SHADER_GATE};
  float phase = 3.14159265 * u;
  float alongVariation = 0.86 + 0.14 * sin(along * 0.092 + 1.8);
  float breakup = 0.24 + 0.76 * breakerPatchBreakup(along, time);
  float lip = pow(max(cos(phase), 0.0), 3.0);
  // A narrow crest-nose correction rather than another full wave profile.
  // The base spectral/bound-harmonic surface owns the body of the wave; this
  // only rounds and leans locally breaking sections without forming a shelf.
  float horizontalAmount = 0.62 * breakup * lip * envelope * alongVariation;
  float vertical = 0.14 * breakup * lip * envelope * alongVariation;
  return vec3(travelDirection.x * horizontalAmount, vertical, travelDirection.y * horizontalAmount);
}
`;

/**
 * `breakerPatchVertex` (WGSL 1241-1285): the attached 256x48 crest patch, drawn
 * as `drawArrays(TRIANGLES, 0, 256 * 48 * 6)` and shaded by the same fragment
 * program. `BREAKER_ENABLED` is false, so the engine never issues this draw --
 * the stage is ported in full anyway so re-enabling the gate needs no new code.
 */
export const WATER_BREAKER_PATCH_VERTEX_GLSL = /* glsl */ `${WATER_VERTEX_PRELUDE}${BREAKER_PATCH_HELPERS_GLSL}
void main() {
  uint alongResolution = ${BREAKER_PATCH_ALONG_RESOLUTION}u;
  uint acrossResolution = ${BREAKER_PATCH_ACROSS_RESOLUTION}u;
  uint cellId = uint(gl_VertexID) / 6u;
  uvec2 cell = uvec2(cellId % alongResolution, cellId / alongResolution);
  uvec2 grid = cell + corners[uint(gl_VertexID) % 6u];
  vec2 uv = vec2(grid) / vec2(float(alongResolution), float(acrossResolution));
  float along = mix(-180.0, 180.0, uv.x);
  float across = mix(-12.0, 12.0, uv.y);
  vec2 travelDirection = normalize(vec2(0.887, -0.462));
  vec2 tangentDirection = vec2(-travelDirection.y, travelDirection.x);
  float time = uniforms.cameraTime.w;
  float meander = sin(along * 0.055 + time * 0.055 + 0.7) * 3.8
    + sin(along * 0.14 - time * 0.032 - 1.3) * 1.2;
  float meanderDerivative = cos(along * 0.055 + time * 0.055 + 0.7) * 0.209
    + cos(along * 0.14 - time * 0.032 - 1.3) * 0.168;
  vec2 p = tangentDirection * along + travelDirection * (breakerFrontPosition(time) + meander + across);
  vec2 pAlong = tangentDirection + travelDirection * meanderDerivative;
  vec2 pAcross = travelDirection;
  SurfaceEvaluation surface = evaluateWaterSurface(p);
  vec3 extra = breakerPatchExtra(across, along, time);
  float derivativeStep = 0.12;
  vec3 extraAlong = (breakerPatchExtra(across, along + derivativeStep, time) - breakerPatchExtra(across, along - derivativeStep, time)) / (2.0 * derivativeStep);
  vec3 extraAcross = (breakerPatchExtra(across + derivativeStep, along, time) - breakerPatchExtra(across - derivativeStep, along, time)) / (2.0 * derivativeStep);
  vec3 tangentAlong = surface.tangentPX * pAlong.x + surface.tangentPZ * pAlong.y + extraAlong;
  vec3 tangentAcross = surface.tangentPX * pAcross.x + surface.tangentPZ * pAcross.y + extraAcross;
  vec3 world = surface.world + extra;
  gl_Position = uniforms.viewProj * vec4(world, 1.0);
  vWorld = world;
  vNormal = normalize(cross(tangentAlong, tangentAcross));
  vFieldUv = surface.fieldUv;
  vSimulationUv = surface.simulationUv;
  vWaveHeight = surface.waveHeight + extra.y;
  float patchBreakup = breakerPatchBreakup(along, time);
  vCompression = surface.compression + smoothstep(0.62, 0.94, patchBreakup) * (1.0 - smoothstep(0.3, 4.5, abs(across))) * 0.055;
  vBreakerLip = surface.breakerLip;
  vBreakerCoord = vec2(across, along);
  vSurfaceKind = 1.0;
}
`;

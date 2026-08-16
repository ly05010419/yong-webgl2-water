// GLSL ES 3.00 ports of the WGSL shared by every Tethys shader.
//
// Each constant is a *body fragment*: no `#version`, no precision statement —
// `createGlProgram` prepends those. Every function is transcribed line by line,
// constant by constant, in the same operation order as the frozen WGSL source
// (`shared-wgsl.ts@7dbf39c` and `webgpu-water-engine.ts@7dbf39c`),
// so a diff against the WGSL should only show syntax, never numbers.
//
// Translation rules applied throughout (see docs/webgl2-port/contract.md):
// - `vecN<f32>(…)` → `vecN(…)`; `f32(x)` → `float(x)`; `let`/`var` → typed locals.
// - `select(falseValue, trueValue, cond)` → `cond ? trueValue : falseValue`.
// - `atan2(y, x)` → `atan(y, x)`.
// - GLSL needs declaration before use, so helpers precede their callers.
//
// `TETHYS_WATER_LEVEL` is imported for the two dune literals so the emitted
// text is byte-identical to the WGSL template (`(1.4 + 0.62).toFixed(2)` etc.).

import { TETHYS_WATER_LEVEL } from "../water-profiles";

/**
 * WorldUniforms as a std140 block with instance name `uniforms`, so ported
 * shaders keep the WGSL spelling `uniforms.cameraTime` verbatim.
 * Source: shared-wgsl.ts:6-31. Layout: mat4 (64 B) + 12 × vec4 = 256 B.
 * Field semantics: docs/webgl2-port/spec-engine.md §4.0. Bind with
 * `bindUniformBlock(gl, program, "WorldUniforms", WORLD_UNIFORMS_BINDING, 256)`.
 */
export const WORLD_UNIFORMS_GLSL = /* glsl */ `
layout(std140) uniform WorldUniforms {
  mat4 viewProj;
  vec4 cameraTime;
  vec4 cameraRight;
  vec4 cameraUp;
  vec4 cameraForward;
  vec4 sunWater;
  vec4 terrain;
  vec4 simulation;
  vec4 player;
  vec4 interaction;
  vec4 environment;
  // x: swell amplitude multiplier, y: its square (for the bound-harmonic mean
  // terms, which are quadratic in wave height). z: how much of the faded-out
  // capillary slope is returned to BRDF roughness. w: multiplier on the
  // distance over which surface detail survives.
  vec4 waves;
  // x: multiplier on where the open ocean's radial fog closes; 0 disables it.
  // y: strength of the swell cascades' screen-space slope fade -- higher
  // smooths the far field sooner, 0 disables the fade entirely.
  // zw: live tile sizes (metres) of the long and medium cascades; every
  // consumer must divide by these rather than bake the authored 240/64.
  vec4 atmosphere;
} uniforms;
`;

/** Field names of `WorldUniforms` in declaration (= std140 offset) order. */
export const WORLD_UNIFORM_FIELDS = Object.freeze([
  "viewProj",
  "cameraTime",
  "cameraRight",
  "cameraUp",
  "cameraForward",
  "sunWater",
  "terrain",
  "simulation",
  "player",
  "interaction",
  "environment",
  "waves",
  "atmosphere",
] as const);

/**
 * `linearToSrgb` and `aces`. Source: shared-wgsl.ts:33-40.
 * Every fragment shader ends with `linearToSrgb(aces(color))` written to a
 * non-sRGB target — never enable sRGB framebuffer conversion.
 */
export const COLOR_GLSL = /* glsl */ `
vec3 linearToSrgb(vec3 value) {
  return mix(value * 12.92, 1.055 * pow(max(value, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), value));
}

vec3 aces(vec3 color) {
  return clamp((color * (2.51 * color + vec3(0.03))) / (color * (2.43 * color + vec3(0.59)) + vec3(0.14)), vec3(0.0), vec3(1.0));
}
`;

/**
 * `cloudHash3`, `cloudNoise3`, `skyColor(direction, time, sunDirection)`.
 * Source: shared-wgsl.ts:42-90.
 */
export const SKY_GLSL = /* glsl */ `
float cloudHash3(vec3 pInput) {
  vec3 p = fract(pInput * 0.1031);
  p += vec3(dot(p, p.yzx + vec3(33.33)));
  return fract((p.x + p.y) * p.z);
}

float cloudNoise3(vec3 p) {
  vec3 cell = floor(p);
  vec3 local = fract(p);
  local = local * local * (vec3(3.0) - 2.0 * local);
  float n000 = cloudHash3(cell + vec3(0.0, 0.0, 0.0));
  float n100 = cloudHash3(cell + vec3(1.0, 0.0, 0.0));
  float n010 = cloudHash3(cell + vec3(0.0, 1.0, 0.0));
  float n110 = cloudHash3(cell + vec3(1.0, 1.0, 0.0));
  float n001 = cloudHash3(cell + vec3(0.0, 0.0, 1.0));
  float n101 = cloudHash3(cell + vec3(1.0, 0.0, 1.0));
  float n011 = cloudHash3(cell + vec3(0.0, 1.0, 1.0));
  float n111 = cloudHash3(cell + vec3(1.0, 1.0, 1.0));
  float nearPlane = mix(mix(n000, n100, local.x), mix(n010, n110, local.x), local.y);
  float farPlane = mix(mix(n001, n101, local.x), mix(n011, n111, local.x), local.y);
  return mix(nearPlane, farPlane, local.z);
}

vec3 skyColor(vec3 direction, float time, vec3 sunDirection) {
  float elevation = direction.y;
  float upper = smoothstep(-0.035, 0.34, elevation);
  // Lower-energy linear-light values leave headroom for the sun and clouds.
  // The old near-white dome flattened both the sky and its water reflection.
  vec3 color = mix(vec3(0.34, 0.54, 0.64), vec3(0.070, 0.26, 0.43), upper);
  color = mix(vec3(0.055, 0.22, 0.31), color, smoothstep(-0.34, 0.055, elevation));
  float sunDot = max(dot(direction, sunDirection), 0.0);
  float horizon = exp(-abs(elevation) * 12.0);
  color = mix(color, vec3(0.72, 0.55, 0.31), pow(sunDot, 4.0) * horizon * 0.12);
  color += vec3(0.28, 0.42, 0.62) * pow(sunDot, 20.0) * 0.08;
  vec3 drift = vec3(time * 0.0040, -time * 0.0014, time * 0.0023);
  vec3 cloudPoint = direction * 10.5 + drift;
  float cloudField = cloudNoise3(cloudPoint) * 0.54
    + cloudNoise3(cloudPoint * 2.03 + vec3(7.1, -3.4, 5.8)) * 0.29
    + cloudNoise3(cloudPoint * 4.07 + vec3(-2.7, 9.3, 1.9)) * 0.17;
  float envelope = smoothstep(-0.045, 0.018, elevation) * (1.0 - smoothstep(0.30, 0.43, elevation));
  float cloudBody = smoothstep(0.535, 0.68, cloudField) * envelope;
  float cloudCore = smoothstep(0.63, 0.78, cloudField) * envelope;
  float cloudEdge = (smoothstep(0.51, 0.59, cloudField) - smoothstep(0.67, 0.76, cloudField)) * envelope;
  vec3 cloudShade = mix(vec3(0.42, 0.50, 0.55), vec3(0.82, 0.76, 0.63), pow(sunDot, 0.35));
  color = mix(color, cloudShade, cloudBody * 0.42);
  color -= vec3(0.08, 0.10, 0.12) * cloudCore * (1.0 - sunDot) * 0.28;
  color += vec3(0.60, 0.49, 0.30) * cloudEdge * sunDot * 0.055;
  return color;
}
`;

/**
 * `tethysAerialColor(color, world, cameraPos, worldScale, underwater, dryLand)`.
 * Source: shared-wgsl.ts:93-118. Reads `uniforms.atmosphere.x` directly, so
 * `WORLD_UNIFORMS_GLSL` must precede this fragment in the final source.
 * `select(a, b, cond)` sites (WGSL 99, 100, 108-111, 114) become ternaries with
 * the *true* branch first.
 */
export const AERIAL_GLSL = /* glsl */ `
vec3 tethysAerialColor(vec3 color, vec3 world, vec3 cameraPos, float worldScale, bool underwater, float dryLand) {
  // worldScale arrives in environment.w: 1 for the island scene, which is then
  // bit-for-bit unchanged. Underwater density is a property of the medium, not
  // of how much world surrounds it, so it stays unscaled.
  float distanceToEye = distance(cameraPos, world);
  float density = underwater ? 0.0075 : 0.00155 / worldScale;
  float fog = 1.0 - exp(-max(distanceToEye - (underwater ? 2.0 : 20.0 * worldScale), 0.0) * density);
  float radial = length(world.xz);
  // The open ocean's radial wall is adjustable and off by default. It never
  // modelled atmosphere -- it concealed the far edge of a finite water mesh --
  // so turning it off buys view distance at the cost of exposing that edge when
  // the camera is pulled back. The island scene keeps its own unconditionally,
  // where the ring bounds an authored world rather than hiding an artifact.
  float fogReach = uniforms.atmosphere.x;
  float oceanRadialFog = (fogReach <= 0.0)
    ? 0.0
    : smoothstep(116.0 * worldScale * fogReach, 145.0 * worldScale * fogReach, radial);
  float islandRadialFog = smoothstep(166.0 * worldScale, 205.0 * worldScale, radial) * 0.58;
  fog = clamp(fog + mix(oceanRadialFog, islandRadialFog, dryLand), 0.0, mix(0.99, 0.72, dryLand));
  vec3 waterAerial = underwater ? vec3(0.012, 0.205, 0.185) : vec3(0.42, 0.66, 0.71);
  vec3 aerial = mix(waterAerial, vec3(0.24, 0.39, 0.43), dryLand);
  return mix(color, aerial, fog);
}
`;

/**
 * `hash21`, `valueNoise`, `tethysCoastalShelf`, `terrainHeight(p, shoreMix)`.
 * Source: webgpu-water-engine.ts@7dbf39c:220-323 (`TETHYS_TERRAIN_WGSL`):
 *   tethysCoastalShelf 221-243 · terrainHeight 245-305 · hash21 307-311 ·
 *   valueNoise 313-322. Order is changed only to satisfy GLSL's
 *   declare-before-use rule (hash21 → valueNoise → shelf → terrainHeight).
 * The dune literals are interpolated exactly as the WGSL template does
 * (`(TETHYS_WATER_LEVEL + 0.62).toFixed(2)` → 2.02, `+ 2.55` → 3.95).
 * `select(shaped, plunged, shaped < shelfPivot)` (WGSL 303) → ternary.
 */
export const TERRAIN_HEIGHT_GLSL = /* glsl */ `
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += vec3(dot(p3, p3.yzx + vec3(33.33)));
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  local = local * local * (vec2(3.0) - 2.0 * local);
  return mix(
    mix(hash21(cell), hash21(cell + vec2(1.0, 0.0)), local.x),
    mix(hash21(cell + vec2(0.0, 1.0)), hash21(cell + vec2(1.0, 1.0)), local.x),
    local.y
  );
}

float tethysCoastalShelf(vec2 p, vec2 center, vec2 radiusScale, float lift, float relief, float phase) {
  vec2 delta = p - center;
  float angle = phase * 0.23;
  vec2 local = vec2(
    delta.x * cos(angle) - delta.y * sin(angle),
    delta.x * sin(angle) + delta.y * cos(angle)
  ) / radiusScale;
  float radius = length(local);
  float coastAngle = atan(local.y, local.x);
  float coastNoise = sin(coastAngle * 3.0 + phase) * 0.040
    + sin(coastAngle * 7.0 - phase * 0.8) * 0.022
    + sin((p.x + p.y) * 0.031 + phase) * 0.018;
  float coastalDistance = radius + coastNoise;
  float coast = 1.0 - smoothstep(0.58, 1.035, coastalDistance);
  float interior = 1.0 - smoothstep(0.12, 0.57, coastalDistance);
  float erosion = sin(p.x * 0.038 + p.y * 0.017 + phase) * 0.52
    + sin(p.x * -0.019 + p.y * 0.043 - phase * 0.7) * 0.31
    + sin((p.x + p.y) * 0.081 + phase * 1.4) * 0.17;
  float longRidge = sin(p.x * 0.014 - p.y * 0.021 + phase * 2.1);
  float highland = pow(smoothstep(-0.20, 0.85, longRidge), 1.35);
  float rollingRelief = -0.08 + erosion * 0.22 + highland * 0.86;
  return max(0.0, coast * (lift + relief * rollingRelief * interior));
}

float terrainHeight(vec2 p, float shoreMix) {
  vec2 warped = p;
  warped.x += sin(p.y * 0.018 + 0.8) * 2.4;
  warped.y += sin(p.x * 0.016 - 0.2) * 2.1;
  float height = -8.5;
  height += sin(warped.x * 0.052 + warped.y * 0.016) * 0.62;
  height += sin(warped.x * -0.024 + warped.y * 0.046 + 1.7) * 0.39;
  height += sin((warped.x + warped.y) * 0.12) * 0.14;
  float shelfPower = 0.0;
  shelfPower += pow(tethysCoastalShelf(warped, vec2(0.0, 14.0), vec2(76.0, 50.0), 12.8, 8.0, 0.3), 6.0);
  shelfPower += pow(tethysCoastalShelf(warped, vec2(-112.0, -79.0), vec2(62.0, 40.0), 12.6, 11.0, 1.7), 6.0);
  shelfPower += pow(tethysCoastalShelf(warped, vec2(116.0, -92.0), vec2(65.0, 44.0), 12.5, 12.0, 3.4), 6.0);
  shelfPower += pow(tethysCoastalShelf(warped, vec2(-6.0, -196.0), vec2(112.0, 40.0), 12.9, 10.0, 5.1), 6.0);
  height += pow(max(shelfPower, 0.0), 1.0 / 6.0);
  // Build broad, domain-warped dune ridges inland. Keeping their mask above
  // the swash zone protects the waterline contour while giving the exposed
  // islands a wind-shaped silhouette instead of a smooth clay mound.
  float duneInterior = smoothstep(${(TETHYS_WATER_LEVEL + 0.62).toFixed(2)}, ${(TETHYS_WATER_LEVEL + 2.55).toFixed(2)}, height);
  vec2 duneWarp = vec2(
    valueNoise(p * 0.021 + vec2(7.1, -3.8)) - 0.5,
    valueNoise(p * 0.024 + vec2(-5.3, 9.6)) - 0.5
  );
  vec2 duneP = p + duneWarp * 17.0;
  float duneBands = sin(duneP.x * 0.098 + duneP.y * 0.031)
    + sin(duneP.x * 0.047 - duneP.y * 0.071 + 1.8) * 0.47;
  float duneRidges = sign(duneBands) * pow(abs(duneBands) * 0.68, 1.32);
  float broadDunes = valueNoise(duneP * 0.038 + vec2(2.3, 6.7)) - 0.5;
  float erodedDetail = valueNoise(duneP * 0.14 + vec2(4.7, -2.1)) - 0.5;
  height += shoreMix * duneInterior
    * (duneRidges * 0.52 + broadDunes * 0.82 + erodedDetail * 0.16);
  // This lab isolates the water material. Preserve Tethys' shelf contours as
  // a submerged seabed, but never expose an island or terrestrial surface.
  float seabed = min(height, -4.35);
  seabed += sin(p.x * 0.071 + p.y * 0.026) * 0.38;
  seabed += sin(p.x * -0.033 + p.y * 0.083 + 1.7) * 0.24;
  seabed += sin(p.x * 0.017 - p.y * 0.013 + 0.6) * 0.48;
  // The material lab keeps the original all-submerged view, while the coastal
  // scene restores authored Tethys islands for wet/dry and run-up validation.
  // Everything fades to the flat deep border before the field edge: exposed
  // land back to seabed, and the seabed's own dunes down to the -8.5 m floor.
  // The border row is clamp-repeated to infinity by every out-of-field sample,
  // so any relief left on it casts a visible shallow-water ray outward; see
  // the TERRAIN_EXTENT note.
  float borderFade = 1.0 - smoothstep(245.0, 258.0, max(abs(p.x), abs(p.y)));
  float shaped = mix(seabed, height, shoreMix * borderFade);
  // The authored shelves skirt every island with a 4-6 m bank that reads as a
  // hard green/blue split from above. Below a narrow swash shelf the heights
  // are remapped toward the deep floor (identity at the pivot and at -8.5 m,
  // mid-depths pushed down), so the islands rise from open blue water instead
  // of a turquoise plateau. The pivot sits 3.9 m under the waterline rather
  // than at it: that band keeps the authored gentle slope, which is what
  // shallowAttenuation needs to bleed the swell off before it reaches the
  // beach -- plunging straight from the waterline sent full-height waves into
  // a near-vertical shore, and their vertex-rate crests read as sawtooth
  // triangles climbing the sand.
  float shelfPivot = -2.5;
  float submergedRatio = clamp((shelfPivot - shaped) / 6.0, 0.0, 1.0);
  float plunged = shelfPivot - 6.0 * pow(submergedRatio, 0.35);
  shaped = (shaped < shelfPivot) ? plunged : shaped;
  return mix(-8.5, shaped, borderFade);
}
`;

/**
 * Convenience bundle for shaders that shade with sky + aerial perspective:
 * uniforms → colour → sky → aerial, in dependency order.
 */
export const WORLD_SHADING_GLSL = `${WORLD_UNIFORMS_GLSL}${COLOR_GLSL}${SKY_GLSL}${AERIAL_GLSL}`;

// GLSL ES 3.00 port of the shared half of the Tethys water shader: the sampler
// declarations, the Fresnel / glitter BRDF helpers, the whole breaker family and
// `evaluateWaterSurface`, which the clipmap vertex stage, the breaker-patch
// vertex stage and (for `simulationSample` / `dielectricFresnel` /
// `oceanSunGlitter` / `breakerFrontVisibility`) the fragment stage all share.
//
// Source of truth: the frozen WGSL `WATER_RENDER_SHADER`
// (`webgpu-water-engine.ts@7dbf39c:909-1136`). Every literal is
// transcribed one for one; a diff against the WGSL must only show syntax.
//
// Translation rules (docs/webgl2-port/contract.md §3.3):
// - `vecN<f32>(…)` → `vecN(…)`; `f32(x)` → `float(x)`; `let`/`var` → typed local.
// - `textureSampleLevel(t, s, uv, 0.0)` → `textureLod(t, uv, 0.0)` (the sampler
//   argument disappears; wrap/filter comes from the bound `GlSampler`).
// - `select(f, t, cond)` → `cond ? t : f` (argument order reverses).
// - GLSL declares before use, so the helper order is unchanged from the WGSL.
// - `tanh`'s `clamp(x, -30.0, 30.0)` is kept verbatim (Metal/ANGLE NaN guard).
// - The breaker path is ported in full even though `BREAKER_SHADER_GATE` is
//   "0.0": the gate multiplies, it never removes code.

import { SPECTRAL_CASCADES } from "../spectral-ocean";
import { BREAKER_SHADER_GATE } from "../water-constants";

/**
 * Sampler uniform names in the order `assignSamplerUnits` must receive them.
 * Names match the WGSL binding names exactly (contract §3.2), so every
 * `textureSample*(name, sampler, …)` became `texture(name, …)` textually.
 */
export const WATER_SAMPLER_NAMES = Object.freeze([
  "terrainField",
  "waterState",
  "longField0",
  "longField1",
  "mediumField0",
  "mediumField1",
  "shortField0",
  "shortField1",
  "breakerEvents",
  "sceneColorTexture",
  "sceneDepthTexture",
] as const);

/** One interpolated value carried from either water vertex stage to the fragment. */
export interface WaterVarying {
  readonly type: string;
  readonly name: string;
  /** `@location(n)` of the WGSL `Output` struct this replaces. */
  readonly location: number;
}

/**
 * The WGSL `Output` struct (909 shader, `struct Output` at 931-941) as flat
 * varyings. `@builtin(position)` becomes `gl_Position` / `gl_FragCoord` and is
 * not listed. Names gain a `v` prefix because the vertex stage keeps locals
 * called `world` / `normal` from `SurfaceEvaluation`.
 */
export const WATER_VARYINGS: readonly WaterVarying[] = Object.freeze([
  Object.freeze({ type: "vec3", name: "vWorld", location: 0 }),
  Object.freeze({ type: "vec3", name: "vNormal", location: 1 }),
  Object.freeze({ type: "vec2", name: "vFieldUv", location: 2 }),
  Object.freeze({ type: "vec2", name: "vSimulationUv", location: 3 }),
  Object.freeze({ type: "float", name: "vWaveHeight", location: 4 }),
  Object.freeze({ type: "float", name: "vCompression", location: 5 }),
  Object.freeze({ type: "float", name: "vBreakerLip", location: 6 }),
  Object.freeze({ type: "vec2", name: "vBreakerCoord", location: 7 }),
  Object.freeze({ type: "float", name: "vSurfaceKind", location: 8 }),
]);

/** Emits the varying block for one stage (`out` in a vertex, `in` in the fragment). */
export function waterVaryingsGlsl(qualifier: "out" | "in"): string {
  return `${WATER_VARYINGS.map((varying) => `${qualifier} ${varying.type} ${varying.name};`).join("\n")}\n`;
}

/**
 * The seven samplers both vertex stages need (WGSL group0 bindings 1, 2, 4-9, 11
 * minus the capillary cascade). `fieldSampler` / `spectrumSampler` are WebGL2
 * Sampler Objects bound alongside the texture, so they have no GLSL declaration.
 */
export const WATER_SURFACE_SAMPLERS_GLSL = /* glsl */ `
uniform sampler2D terrainField;
uniform sampler2D waterState;
uniform sampler2D longField0;
uniform sampler2D longField1;
uniform sampler2D mediumField0;
uniform sampler2D mediumField1;
uniform sampler2D breakerEvents;
`;

/**
 * Fragment-only bindings: the capillary cascade (group0 8-9) plus the captured
 * scene (group1 0-1). `sceneDepthTexture` is a plain `sampler2D` with
 * `TEXTURE_COMPARE_MODE = NONE` read only through `texelFetch(...).r`, and
 * `uSceneDims` replaces WGSL's `textureDimensions(sceneDepthTexture)` (§3.3).
 */
export const WATER_FRAGMENT_SAMPLERS_GLSL = /* glsl */ `
uniform sampler2D shortField0;
uniform sampler2D shortField1;
uniform sampler2D sceneColorTexture;
uniform sampler2D sceneDepthTexture;
uniform ivec2 uSceneDims;
`;

/**
 * WGSL 943-1136: `SurfaceEvaluation`, `simulationSample`, `dielectricFresnel`,
 * `smithVisibility`, `oceanSunGlitter`, the breaker front / event / coordinate
 * helpers and `evaluateWaterSurface`. Requires `WORLD_UNIFORMS_GLSL` and the
 * sampler declarations above to precede it.
 */
export const WATER_SURFACE_GLSL = /* glsl */ `
struct SurfaceEvaluation {
  vec3 world;
  vec3 tangentPX;
  vec3 tangentPZ;
  vec2 fieldUv;
  vec2 simulationUv;
  float waveHeight;
  float compression;
  float breakerLip;
};

vec4 simulationSample(vec2 uv) {
  float inside = step(0.0, uv.x) * step(0.0, uv.y) * step(uv.x, 1.0) * step(uv.y, 1.0);
  return textureLod(waterState, clamp(uv, vec2(0.0), vec2(1.0)), 0.0) * inside;
}

float dielectricFresnel(float cosine) {
  float eta = 1.0 / 1.333;
  float sinTransmittedSquared = eta * eta * max(0.0, 1.0 - cosine * cosine);
  if (sinTransmittedSquared >= 1.0) { return 1.0; }
  float transmittedCosine = sqrt(max(0.0, 1.0 - sinTransmittedSquared));
  float parallel = (cosine - 1.333 * transmittedCosine) / max(cosine + 1.333 * transmittedCosine, 0.0001);
  float perpendicular = (transmittedCosine - 1.333 * cosine) / max(transmittedCosine + 1.333 * cosine, 0.0001);
  return 0.5 * (parallel * parallel + perpendicular * perpendicular);
}

float smithVisibility(float cosine, float meanSquareSlope) {
  float tangentSquared = max(0.0, 1.0 - cosine * cosine) / max(cosine * cosine, 0.0001);
  return 2.0 / (1.0 + sqrt(1.0 + meanSquareSlope * tangentSquared));
}

float oceanSunGlitter(vec3 N, vec3 V, vec3 L, float extraVariance) {
  float ndv = max(dot(N, V), 0.001);
  float ndl = max(dot(N, L), 0.001);
  vec3 H = normalize(V + L);
  float ndh = max(dot(N, H), 0.001);
  vec3 windWorld = normalize(vec3(0.887, 0.0, -0.462));
  vec3 T = normalize(windWorld - N * dot(windWorld, N));
  vec3 B = normalize(cross(N, T));
  float alongSlope = dot(H, T) / ndh;
  float acrossSlope = dot(H, B) / ndh;
  // Cox-Munk clean-sea mean-square slopes at an 11.5 m/s wind. extraVariance
  // carries the capillary slope that distance faded out of the normal: this
  // distribution is exactly where sub-resolution slope belongs, so returning it
  // here broadens the glitter instead of letting the far water go mirror-flat.
  float alongVariance = 0.0363 + extraVariance;
  float acrossVariance = 0.0251 + extraVariance;
  float slopePdf = exp(-0.5 * (alongSlope * alongSlope / alongVariance + acrossSlope * acrossSlope / acrossVariance))
    / (6.2831853 * sqrt(alongVariance * acrossVariance));
  float facetDistribution = slopePdf / max(ndh * ndh * ndh * ndh, 0.0001);
  float visibility = smithVisibility(ndv, 0.0307 + extraVariance) * smithVisibility(ndl, 0.0307 + extraVariance);
  return dielectricFresnel(max(dot(V, H), 0.0)) * facetDistribution * visibility / max(4.0 * ndv, 0.001);
}

float breakerFrontPosition(float time) {
  float travellingPhase = time * 2.4 + 12.0;
  return travellingPhase - floor(travellingPhase / 72.0) * 72.0 - 36.0;
}

float breakerFrontVisibility(float front) {
  // Fade the front out before its periodic reset, then reintroduce it from the
  // opposite side. This avoids a 72 m position pop in both geometry and the
  // adaptive sampling warp.
  return 1.0 - smoothstep(28.0, 35.0, abs(front));
}

float breakerEventActivation(float along) {
  vec2 uv = vec2(clamp(along / 360.0 + 0.5, 0.0, 1.0), 0.5);
  return smoothstep(0.035, 0.68, textureLod(breakerEvents, uv, 0.0).r);
}

vec2 breakerCoordinates(vec2 p, float time) {
  vec2 travelDirection = normalize(vec2(0.887, -0.462));
  vec2 tangentDirection = vec2(-travelDirection.y, travelDirection.x);
  float along = dot(p, tangentDirection);
  float meander = sin(along * 0.055 + time * 0.055 + 0.7) * 3.8
    + sin(along * 0.14 - time * 0.032 - 1.3) * 1.2;
  float signedDistance = dot(p, travelDirection) - breakerFrontPosition(time) - meander;
  return vec2(signedDistance, along);
}

vec2 adaptiveBreakerCoordinates(vec2 p, float time) {
  // Concentrate the existing uniform-grid samples around the moving front.
  // The linear compensation makes the warp approach zero at the domain edge,
  // so this is a redistribution of vertices rather than an expanding patch.
  vec2 travelDirection = normalize(vec2(0.887, -0.462));
  vec2 tangentDirection = vec2(-travelDirection.y, travelDirection.x);
  float across = dot(p, travelDirection);
  float along = dot(p, tangentDirection);
  float front = breakerFrontPosition(time);
  float domainHalfDiagonal = 276.0;
  float concentration = 8.2 * breakerFrontVisibility(front) * breakerEventActivation(along) * ${BREAKER_SHADER_GATE};
  float bandWidth = 12.5;
  // tanh must see a bounded argument: Metal's tanh overflows to NaN past
  // roughly |x| = 89, and the disabled-breaker gate multiplies by 0 only
  // *after* -- 0 * NaN is still NaN, which drops every far-field vertex it
  // touches and tears a cell-quantised wedge out of the downwind horizon.
  float correction = -concentration * tanh(clamp((across - front) / bandWidth, -30.0, 30.0))
    + concentration * across / domainHalfDiagonal;
  return p + travelDirection * correction;
}

vec4 localizedBreakerDisplacement(vec2 p, float time) {
  // A travelling, meandering nonlinear wavefront blended into the same water
  // parameterization. Unlike the rejected detached crest sheet, its edges
  // converge to the spectral surface and its horizontal motion can fold the
  // grid naturally when the crest becomes steep.
  vec2 travelDirection = normalize(vec2(0.887, -0.462));
  vec2 breakerCoord = breakerCoordinates(p, time);
  float along = breakerCoord.y;
  float travellingFront = breakerFrontPosition(time);
  float frontVisibility = breakerFrontVisibility(travellingFront);
  float signedDistance = breakerCoord.x;
  float u = signedDistance / 9.0;
  float edgeWindow = 1.0 - smoothstep(0.82, 1.34, abs(u));
  float localEnvelope = exp(-0.55 * u * u) * edgeWindow;
  float phase = 3.14159265 * u;
  float crestProfile = cos(phase);
  float alongSignal = sin(along * 0.041 + time * 0.08 + 0.4)
    + 0.48 * sin(along * 0.097 - time * 0.035 - 1.2);
  float alongBreakup = smoothstep(-0.35, 0.72, alongSignal);
  float alongVariation = (0.42 + 0.58 * alongBreakup)
    * (0.90 + 0.10 * sin(along * 0.092 + 1.8));
  float vertical = 2.45 * localEnvelope * crestProfile * alongVariation;
  vec2 horizontal = -travelDirection * 2.15 * localEnvelope * sin(phase) * alongVariation;
  float lip = pow(max(crestProfile, 0.0), 3.0) * localEnvelope;
  horizontal += travelDirection * 0.72 * lip * alongVariation;
  float activation = breakerEventActivation(along);
  return vec4(horizontal.x, vertical, horizontal.y, lip) * frontVisibility * activation * (1.0 - uniforms.environment.x) * ${BREAKER_SHADER_GATE};
}

SurfaceEvaluation evaluateWaterSurface(vec2 p) {
  vec2 fieldUv = clamp(p / uniforms.terrain.x + vec2(0.5), vec2(0.0), vec2(1.0));
  vec4 terrain = textureLod(terrainField, fieldUv, 0.0);
  float depth = uniforms.sunWater.w - terrain.r;
  float shallowAttenuation = smoothstep(0.14, 2.7, depth);
  vec2 simUv = (p - uniforms.simulation.xy) / uniforms.simulation.z + vec2(0.5);
  vec2 longUv = fract(p / uniforms.atmosphere.z + vec2(0.5));
  vec2 mediumUv = fract(p / uniforms.atmosphere.w + vec2(0.5));
  vec4 long0 = textureLod(longField0, longUv, 0.0) * uniforms.waves.x;
  vec4 long1 = textureLod(longField1, longUv, 0.0) * uniforms.waves.x;
  vec4 medium0 = textureLod(mediumField0, mediumUv, 0.0) * uniforms.waves.x;
  vec4 medium1 = textureLod(mediumField1, mediumUv, 0.0) * uniforms.waves.x;
  vec2 horizontalDisplacement = long0.rg * ${SPECTRAL_CASCADES[0].choppiness.toFixed(2)} + medium0.rg * ${SPECTRAL_CASCADES[1].choppiness.toFixed(2)};
  float longHeight = long0.b;
  float mediumHeight = medium0.b;
  float spectralHeight = longHeight + mediumHeight
    + 0.14 * (longHeight * longHeight - 0.080 * uniforms.waves.y)
    + 0.32 * (mediumHeight * mediumHeight - 0.030 * uniforms.waves.y);
  float crossDerivative = long0.a * ${SPECTRAL_CASCADES[0].choppiness.toFixed(2)} + medium0.a * ${SPECTRAL_CASCADES[1].choppiness.toFixed(2)};
  vec2 longSlope = long1.rg * (1.0 + 0.28 * longHeight);
  vec2 mediumSlope = medium1.rg * (1.0 + 0.64 * mediumHeight);
  vec2 spectralSlope = longSlope + mediumSlope;
  vec2 horizontalDerivative = long1.ba * ${SPECTRAL_CASCADES[0].choppiness.toFixed(2)} + medium1.ba * ${SPECTRAL_CASCADES[1].choppiness.toFixed(2)};
  vec4 sim = simulationSample(simUv);
  float texel = uniforms.simulation.w;
  float left = simulationSample(simUv - vec2(texel, 0.0)).r;
  float right = simulationSample(simUv + vec2(texel, 0.0)).r;
  float back = simulationSample(simUv - vec2(0.0, texel)).r;
  float front = simulationSample(simUv + vec2(0.0, texel)).r;
  float worldTexel = uniforms.simulation.z * texel;
  vec2 simulationDerivative = vec2(right - left, front - back) / max(worldTexel * 2.0, 0.001);
  float simulationEdge = min(min(simUv.x, 1.0 - simUv.x), min(simUv.y, 1.0 - simUv.y));
  float simulationCoverage = step(0.0, simulationEdge) * smoothstep(0.008, 0.055, simulationEdge);
  float baseJacobian = (1.0 + horizontalDerivative.x) * (1.0 + horizontalDerivative.y) - crossDerivative * crossDerivative;
  vec4 breaker = localizedBreakerDisplacement(p, uniforms.cameraTime.w) * shallowAttenuation;
  float breakerStep = 0.55;
  vec4 breakerDx = (localizedBreakerDisplacement(p + vec2(breakerStep, 0.0), uniforms.cameraTime.w) * shallowAttenuation - breaker) / breakerStep;
  vec4 breakerDz = (localizedBreakerDisplacement(p + vec2(0.0, breakerStep), uniforms.cameraTime.w) * shallowAttenuation - breaker) / breakerStep;
  // The nonlinear field is a replacement for the far FFT within its domain,
  // not an additive wake texture. Its relaxation band already matches the FFT,
  // and this narrow geometric blend hides the finite-domain edge.
  float nearshoreOwnership = simulationCoverage * (1.0 - smoothstep(3.8, 5.55, depth));
  float wave = mix(spectralHeight * shallowAttenuation, sim.r, nearshoreOwnership) + breaker.y;
  vec3 world = vec3(
    p.x + horizontalDisplacement.x * shallowAttenuation + breaker.x,
    uniforms.sunWater.w + wave,
    p.y + horizontalDisplacement.y * shallowAttenuation + breaker.z
  );
  vec2 blendedSlope = mix(spectralSlope * shallowAttenuation, simulationDerivative, nearshoreOwnership);
  vec3 tangentPX = vec3(1.0 + horizontalDerivative.x * shallowAttenuation + breakerDx.x, blendedSlope.x + breakerDx.y, crossDerivative * shallowAttenuation + breakerDx.z);
  vec3 tangentPZ = vec3(crossDerivative * shallowAttenuation + breakerDz.x, blendedSlope.y + breakerDz.y, 1.0 + horizontalDerivative.y * shallowAttenuation + breakerDz.z);
  SurfaceEvaluation result;
  result.world = world;
  result.tangentPX = tangentPX;
  result.tangentPZ = tangentPZ;
  result.fieldUv = fieldUv;
  result.simulationUv = simUv;
  result.waveHeight = wave;
  result.compression = max(0.0, 1.0 - baseJacobian) * shallowAttenuation + breaker.w * 0.38;
  result.breakerLip = breaker.w;
  return result;
}
`;

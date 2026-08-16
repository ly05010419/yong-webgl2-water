// GLSL ES 3.00 port of `waterFragment` (frozen WGSL
// `webgpu-water-engine.ts@7dbf39c:1287-1535`), shared by all four water
// programs (clipmap / breaker patch x optimized / reference).
//
// Section letters follow docs/webgl2-port/spec-engine.md §4.4: (a) breaker hand-over discards,
// (b) shoreline coverage, (c) capillary + per-fragment cascade slopes,
// (d) shading normal and recovered variance, (e) refraction and captured scene,
// (f) absorption / scattering, (g) sky reflection (REFERENCE_MODE taps),
// (h) shallow-water and swimmer weighting, (i) foam, (j) glitter + aerial.
//
// Translation notes beyond docs/webgl2-port/contract.md §3.3:
// - `override REFERENCE_MODE: bool` becomes a preprocessor define supplied by
//   `createGlProgram({ defines: { REFERENCE_MODE: 0 | 1 } })`, so the three
//   extra `skyColor` taps are compiled out of the optimized program entirely.
// - `input.position.xy / interaction.zw` → `gl_FragCoord.xy / interaction.zw`,
//   **not** flipped: WebGPU's frag position and its texture v both run
//   downwards, GL's `gl_FragCoord.y` and its texture v both run upwards.
// - The refraction normal offset is `vec2(N.x, N.z)` where the WGSL has
//   `vec2(N.x, -N.z)`. Screen v points the opposite way in GL, so keeping the
//   WGSL sign would push the refracted sample the wrong way along z.
// - `textureDimensions(sceneDepthTexture)` → the `uSceneDims` uniform, and
//   `textureLoad(sceneDepthTexture, coord, 0)` → `texelFetch(..., 0).r`
//   (`sceneDepthTexture` is a plain `sampler2D` with compare mode NONE).
// - `fwidth(waterColumn)` stays *above* the shoreline `discard`, as in the WGSL:
//   derivatives taken after a discard are undefined.
// - The same rule covers the `texture()` calls that follow every `discard` here.
//   Implicit-LOD sampling is a derivative, so on paper it is as undefined as
//   `fwidth` once part of the quad has terminated. It is safe in this shader
//   only because every texture the engine binds has exactly one mip level and
//   LINEAR filtering (`createTexture2D` uses `texStorage2D(..., 1, ...)`, and
//   no pass ever calls `generateMipmap`): whatever LOD the hardware computes,
//   level 0 is the only one there is, so a wrong derivative cannot select a
//   wrong mip. Introducing a mipmapped texture into the water pass would break
//   that and the sampling below would have to move above the discards or become
//   an explicit `textureLod`.
// - The two breaker hand-over `discard`s in section (a) sit *above* the
//   `fwidth(waterColumn)` of section (b), which the rule above would forbid.
//   They are safe only because `BREAKER_ENABLED` is false: `BREAKER_SHADER_GATE`
//   multiplies `patchVisible` to a constant 0, `vSurfaceKind` is 0 on every
//   drawn primitive (the crest patch is not submitted at all), so neither
//   condition can ever be true and no invocation terminates there. The
//   difference matters because WGSL `discard` only demotes the invocation to a
//   helper — it keeps contributing derivatives — while GLSL ES terminates it,
//   leaving `fwidth` undefined for the surviving neighbours in the quad.
//   Switching the crest patch back on therefore requires hoisting the
//   `fwidth(waterColumn)` (and the `waterColumn` it is taken of) above these
//   two discards, exactly as `SHIP_FRAGMENT_GLSL` hoists its derivatives above
//   the alpha-mask discard.
// - `@location(0) vec4` return → `layout(location = 0) out vec4 waterColor`.

import { SPECTRAL_CASCADES } from "../spectral-ocean";
import { BREAKER_SHADER_GATE } from "../water-constants";
import { TERRAIN_HEIGHT_GLSL, WORLD_SHADING_GLSL } from "./shared-glsl";
import {
  WATER_FRAGMENT_SAMPLERS_GLSL,
  WATER_SURFACE_GLSL,
  WATER_SURFACE_SAMPLERS_GLSL,
  waterVaryingsGlsl,
} from "./water-surface-glsl";

// `WORLD_SHADING_GLSL` supplies uniforms + linearToSrgb/aces + skyColor +
// tethysAerialColor; `TERRAIN_HEIGHT_GLSL` supplies the very same `valueNoise`
// the terrain field is built from -- the sand and crest breakup must be the
// identical hash, so it is reused rather than re-derived.
const WATER_FRAGMENT_PRELUDE =
  `${WORLD_SHADING_GLSL}${TERRAIN_HEIGHT_GLSL}${WATER_SURFACE_SAMPLERS_GLSL}${WATER_FRAGMENT_SAMPLERS_GLSL}` +
  `${WATER_SURFACE_GLSL}${waterVaryingsGlsl("in")}`;

export const WATER_FRAGMENT_GLSL = /* glsl */ `#ifndef REFERENCE_MODE
#define REFERENCE_MODE 0
#endif
${WATER_FRAGMENT_PRELUDE}layout(location = 0) out vec4 waterColor;

void main() {
  float patchVisible = breakerFrontVisibility(breakerFrontPosition(uniforms.cameraTime.w)) * (1.0 - uniforms.environment.x) * ${BREAKER_SHADER_GATE};
  float patchAlong = 1.0 - smoothstep(158.0, 176.0, abs(vBreakerCoord.y));
  if (vSurfaceKind < 0.5 && patchVisible * patchAlong > 0.001 && abs(vBreakerCoord.x) < 11.72) { discard; }
  if (vSurfaceKind > 0.5 && (patchVisible <= 0.001 || abs(vBreakerCoord.x) > 11.82 || patchAlong <= 0.001)) { discard; }
  vec4 state = simulationSample(vSimulationUv);
  // Clamp rather than discard past the terrain field. The vertex stage already
  // clamps this same lookup, so discarding here cut the water along the field
  // border while the surface it was shaded from continued -- invisible when
  // fog closed at 145 m, but a hard sawtooth edge with bare seabed behind it
  // once the open ocean reaches 1450 m. Outside the authored centre the field
  // border is flat -8.5 m seabed, so the clamped depth is the correct one.
  vec2 displacedTerrainUv = clamp(vWorld.xz / uniforms.terrain.x + vec2(0.5), vec2(0.0), vec2(1.0));
  vec4 terrain = texture(terrainField, displacedTerrainUv);
  // Coverage must be derived from the same displaced surface that produced
  // the raster depth. Re-evaluating height per fragment makes colour and depth
  // disagree at wet/dry intersections, exposing a checkerboard of triangles.
  float waterColumn = vWorld.y - terrain.r;
  float shorelineWidth = clamp(fwidth(waterColumn), 0.006, 0.06);
  // Leave a centimetre-scale wet-sand margin in the island scene. Rendering
  // translucent water almost coplanar with terrain is visually unstable and
  // was the remaining source of dotted/checker shoreline fragments.
  float shorelineThreshold = mix(0.018, 0.28, uniforms.environment.x);
  float shorelineCoverage = smoothstep(shorelineThreshold - shorelineWidth, shorelineThreshold + shorelineWidth, waterColumn);
  if (shorelineCoverage < 0.01) { discard; }
  float depth = max(waterColumn, 0.018);
  vec2 p = vWorld.xz;
  float time = uniforms.cameraTime.w;
  vec2 shortUv = fract(p / ${SPECTRAL_CASCADES[2].lengthScale.toFixed(1)} + vec2(0.5));
  vec4 short0 = texture(shortField0, shortUv);
  vec4 short1 = texture(shortField1, shortUv);
  // Capillary detail is dropped as it approaches the sampling limit, because
  // sub-pixel waves alias into crawling highlights. The threshold is a
  // quality/stability trade-off rather than a constant, so it is exposed.
  //
  // The test is screen-space sampling density, not world distance. Fading over
  // a fixed 42-118 m band looks abrupt: screen row maps to distance as 1/d, so
  // the far half of that band collapses into a few dozen pixels and the detail
  // appears to switch off. Pixels-per-wavelength is uniform in screen space, so
  // the ramp reads evenly, and it self-adjusts to field of view, resolution and
  // render scale instead of assuming the authored camera.
  float detailRange = uniforms.waves.w;
  float eyeDistance = distance(uniforms.cameraTime.xyz, vWorld);
  float pixelWorldSize = eyeDistance * 2.0 * uniforms.cameraUp.w / max(uniforms.interaction.w, 1.0);
  // Representative wavelength of the capillary cascade's energy peak.
  float pixelsPerWave = ${SPECTRAL_CASCADES[2].lengthScale.toFixed(1)} / 12.0 / max(pixelWorldSize, 1e-6);
  float shortDistanceFade = smoothstep(3.0, 14.0, pixelsPerWave * detailRange);
  vec2 shortSlope = short1.rg * shortDistanceFade;
  // Short waves become an aggregate slope distribution instead of a literal
  // high-frequency normal texture. This is the geometry-to-BRDF transition
  // used to avoid sparkling/streaking as sub-pixel waves recede.
  // Cascade 0/1 slopes are re-sampled here rather than interpolated from the
  // vertices: the clipmap doubles its cell size every ring, so a few hundred
  // metres out the grid undersamples the 64 m cascade and vertex-rate normals
  // shade as cell-sized facets with a visible seam at every ring boundary.
  // Geometry stays vertex-rate; only the shading normal is refined. The
  // pre-displacement surface parameter is recovered from the simulation UV,
  // which is affine in it and never clamped in the vertex stage.
  vec2 surfaceParam = (vSimulationUv - vec2(0.5)) * uniforms.simulation.z + uniforms.simulation.xy;
  vec2 paramFieldUv = clamp(surfaceParam / uniforms.terrain.x + vec2(0.5), vec2(0.0), vec2(1.0));
  float paramDepth = uniforms.sunWater.w - texture(terrainField, paramFieldUv).r;
  float paramAttenuation = smoothstep(0.14, 2.7, paramDepth);
  vec2 longUvF = fract(surfaceParam / uniforms.atmosphere.z + vec2(0.5));
  vec2 mediumUvF = fract(surfaceParam / uniforms.atmosphere.w + vec2(0.5));
  vec4 long0F = texture(longField0, longUvF) * uniforms.waves.x;
  vec4 long1F = texture(longField1, longUvF) * uniforms.waves.x;
  vec4 medium0F = texture(mediumField0, mediumUvF) * uniforms.waves.x;
  vec4 medium1F = texture(mediumField1, mediumUvF) * uniforms.waves.x;
  // The same screen-space sampling-rate fade the capillary cascade gets, per
  // cascade: near the horizon one pixel spans many medium wavelengths, and
  // per-fragment slopes alias into a glittering noise band there. Each faded
  // slope joins the recovered-variance path below, so the distant-roughness
  // control keeps deciding whether the energy returns as BRDF roughness.
  float mediumPixelsPerWave = uniforms.atmosphere.w / 8.0 / max(pixelWorldSize, 1e-6);
  float swellSmoothing = uniforms.atmosphere.y;
  float mediumFadeF = (swellSmoothing <= 0.0) ? 1.0 : smoothstep(3.0, 14.0, mediumPixelsPerWave * detailRange / max(swellSmoothing, 0.001));
  float longPixelsPerWave = uniforms.atmosphere.z / 5.0 / max(pixelWorldSize, 1e-6);
  float longFadeF = (swellSmoothing <= 0.0) ? 1.0 : smoothstep(3.0, 14.0, longPixelsPerWave * detailRange / max(swellSmoothing, 0.001));
  float crossDerivativeF = long0F.a * ${SPECTRAL_CASCADES[0].choppiness.toFixed(2)} * longFadeF + medium0F.a * ${SPECTRAL_CASCADES[1].choppiness.toFixed(2)} * mediumFadeF;
  vec2 spectralSlopeF = long1F.rg * (1.0 + 0.28 * long0F.b) * longFadeF + medium1F.rg * (1.0 + 0.64 * medium0F.b) * mediumFadeF;
  vec2 horizontalDerivativeF = long1F.ba * ${SPECTRAL_CASCADES[0].choppiness.toFixed(2)} * longFadeF + medium1F.ba * ${SPECTRAL_CASCADES[1].choppiness.toFixed(2)} * mediumFadeF;
  float simTexelF = uniforms.simulation.w;
  float simLeftF = simulationSample(vSimulationUv - vec2(simTexelF, 0.0)).r;
  float simRightF = simulationSample(vSimulationUv + vec2(simTexelF, 0.0)).r;
  float simBackF = simulationSample(vSimulationUv - vec2(0.0, simTexelF)).r;
  float simFrontF = simulationSample(vSimulationUv + vec2(0.0, simTexelF)).r;
  vec2 simulationDerivativeF = vec2(simRightF - simLeftF, simFrontF - simBackF) / max(uniforms.simulation.z * simTexelF * 2.0, 0.001);
  float simulationEdgeF = min(min(vSimulationUv.x, 1.0 - vSimulationUv.x), min(vSimulationUv.y, 1.0 - vSimulationUv.y));
  float simulationCoverageF = step(0.0, simulationEdgeF) * smoothstep(0.008, 0.055, simulationEdgeF);
  float nearshoreOwnershipF = simulationCoverageF * (1.0 - smoothstep(3.8, 5.55, paramDepth));
  vec2 blendedSlopeF = mix(spectralSlopeF * paramAttenuation, simulationDerivativeF, nearshoreOwnershipF);
  vec3 tangentXF = vec3(1.0 + horizontalDerivativeF.x * paramAttenuation, blendedSlopeF.x, crossDerivativeF * paramAttenuation);
  vec3 tangentZF = vec3(crossDerivativeF * paramAttenuation, blendedSlopeF.y, 1.0 + horizontalDerivativeF.y * paramAttenuation);
  // The breaker patch carries bespoke crest normals from its vertex stage and
  // keeps them; everything else takes the refined per-fragment normal.
  vec3 baseNormal = normalize(cross(tangentZF, tangentXF));
  if (vSurfaceKind > 0.5) { baseNormal = normalize(vNormal); }
  vec3 N = normalize(baseNormal + vec3(-shortSlope.x, 0.0, -shortSlope.y) * 0.42);
  // Fading the capillary slope out of the normal is what stops sub-pixel waves
  // from sparkling, but on its own it also drains the roughness that those
  // waves represent, so the far surface collapses toward a mirror. Feed the
  // discarded slope back in as an aggregate statistic instead: the normal stays
  // smooth while the BRDF keeps the energy. At 0 this is the original
  // behaviour; at 1 the full variance is retained.
  // Variance is the square of slope, and it is what the Cox-Munk distribution
  // in oceanSunGlitter consumes.
  float fadedSlope = length(short1.rg) * (1.0 - shortDistanceFade)
    + length(medium1F.rg) * (1.0 - mediumFadeF)
    + length(long1F.rg) * (1.0 - longFadeF);
  float recoveredVariance = fadedSlope * fadedSlope * uniforms.waves.z;
  float surfaceRoughness = mix(0.035, 0.115, smoothstep(0.012, 0.30, length(shortSlope) + fadedSlope * uniforms.waves.z));
  bool underwater = uniforms.terrain.w > 0.5;
  if (underwater) { N *= -1.0; }
  vec3 V = normalize(uniforms.cameraTime.xyz - vWorld);
  vec3 L = normalize(uniforms.sunWater.xyz);
  float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
  float fresnel = dielectricFresnel(ndv);
  float terrainNormalY = sqrt(max(1.0 - terrain.g * terrain.g - terrain.b * terrain.b, 0.0001));
  float floorLight = clamp(dot(normalize(vec3(terrain.g, terrainNormalY, terrain.b)), L) * 0.56 + 0.48, 0.0, 1.0);
  vec2 refractedOffset = N.xz * depth * mix(0.42, 1.25, 1.0 - ndv);
  vec2 refractedP = p + refractedOffset;
  float sandVariation = valueNoise(refractedP * 0.18) * 0.055 + valueNoise(refractedP * 0.62 + vec2(7.1, -3.4)) * 0.018;
  vec3 floorColor = (vec3(0.46, 0.37, 0.225) + vec3(sandVariation)) * mix(0.70, 1.02, floorLight);
  vec2 screenUv = gl_FragCoord.xy / max(uniforms.interaction.zw, vec2(1.0));
  vec2 refractionUv = clamp(screenUv + vec2(N.x, N.z) * (0.0025 + min(depth, 14.0) * 0.00072), vec2(0.001), vec2(0.999));
  vec3 capturedLinear = floorColor;
  if (uniforms.environment.x > 0.5) {
    ivec2 sceneDimensions = uSceneDims;
    ivec2 sceneCoord = ivec2(clamp(refractionUv * vec2(sceneDimensions), vec2(0.0), vec2(sceneDimensions - ivec2(1))));
    float capturedDepth = texelFetch(sceneDepthTexture, sceneCoord, 0).r;
    vec3 capturedScene = texture(sceneColorTexture, refractionUv).rgb;
    capturedLinear = pow(max(capturedScene, vec3(0.0)), vec3(2.2));
    float capturedGeometry = 1.0 - step(0.9995, capturedDepth);
    // The capture only contains seabed out to the terrain mesh; past its far
    // edge the sample falls back to the analytic floor, and the two disagree
    // enough that the hand-over drew a visible square around the field. The
    // capture only carries information the analytic floor lacks in shallow
    // water (caustics, swash, wet sand), so hand over by depth instead: deep
    // water reads the world-continuous analytic floor on both sides and the
    // seam never exists.
    float captureCoverage = 1.0 - smoothstep(6.5, 8.5, depth);
    floorColor = mix(floorColor, capturedLinear, capturedGeometry * captureCoverage * 0.88);
  }
  float opticalDepth = underwater ? max(0.0, uniforms.sunWater.w - uniforms.cameraTime.y) / max(abs(dot(N, V)), 0.32) : depth / max(ndv, 0.28);
  vec3 absorption = vec3(0.37, 0.125, 0.054);
  vec3 transmission = exp(-absorption * min(opticalDepth, 24.0));
  // Open water is not a cyan diffuse material.  Keep the in-scattered body
  // colour low-energy so the interface reflection supplies the bright values.
  vec3 scatterColor = vec3(0.0035, 0.096, 0.092);
  vec3 scatterAmount = vec3(1.0) - transmission;
  float phaseG = 0.24;
  float lightCosine = dot(-V, L);
  float phase = (1.0 - phaseG * phaseG) / pow(max(1.0 + phaseG * phaseG - 2.0 * phaseG * lightCosine, 0.04), 1.5);
  vec3 refracted = floorColor * transmission + scatterColor * scatterAmount * (0.72 + phase * 0.060);
  float refractionSoftness = smoothstep(3.0, 15.0, opticalDepth) * 0.08;
  refracted = mix(refracted, scatterColor, refractionSoftness);
  vec3 reflectedDirection = reflect(-V, N);
  vec3 reflected = skyColor(reflectedDirection, time, L);
#if REFERENCE_MODE == 1
  {
    vec3 blurA = skyColor(normalize(reflectedDirection + vec3(0.012, 0.006, -0.009)), time, L);
    vec3 blurB = skyColor(normalize(reflectedDirection - vec3(0.010, 0.004, -0.012)), time, L);
    reflected = reflected * 0.64 + blurA * 0.18 + blurB * 0.18;
  }
#endif
  // Sub-resolution slope scatters the mirror direction into a cone. Broadening
  // the glitter lobe alone barely shows, because away from the sun's reflection
  // the far surface is dominated by this sky term -- and a single tap makes it
  // a perfect mirror no matter how rough the water statistically is. Cost is
  // only paid where the control is engaged; at 0 the whole branch is skipped.
  float reflectionSpread = sqrt(recoveredVariance) * 1.9;
  if (reflectionSpread > 0.002) {
    vec3 spreadT = normalize(cross(reflectedDirection, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 1e-4));
    vec3 spreadB = cross(reflectedDirection, spreadT);
    vec3 tapA = skyColor(normalize(reflectedDirection + spreadT * reflectionSpread), time, L);
    vec3 tapB = skyColor(normalize(reflectedDirection - spreadT * 0.55 * reflectionSpread + spreadB * 0.84 * reflectionSpread), time, L);
    vec3 tapC = skyColor(normalize(reflectedDirection - spreadT * 0.55 * reflectionSpread - spreadB * 0.84 * reflectionSpread), time, L);
    reflected = reflected * 0.40 + (tapA + tapB + tapC) * 0.20;
  }
  // Preserve environment contrast.  Tinting the reflection toward the water
  // body colour was the main source of the previous milky/plastic response.
  reflected *= mix(vec3(0.70, 0.77, 0.80), vec3(0.76, 0.81, 0.83), surfaceRoughness);
  float playerDistance = length(p - uniforms.player.xy);
  float nearSwimmer = 1.0 - smoothstep(0.85, 3.4, playerDistance);
  float reflectionWeight = underwater ? fresnel * 0.07 : fresnel;
  float shoreShallows = uniforms.environment.x * (1.0 - smoothstep(0.12, 1.02, depth));
  // At the waterline the captured sand is still the dominant optical path.
  // Suppress the old cyan body-colour halo and retain a thin, green-blue
  // transmission tint instead of treating centimetres of water like ocean.
  vec3 shallowTransmission = capturedLinear * vec3(0.66, 0.62, 0.52)
    + vec3(0.004, 0.013, 0.011) * smoothstep(0.10, 0.90, depth);
  refracted = mix(refracted, shallowTransmission, shoreShallows * 0.76);
  reflectionWeight *= 1.0 - shoreShallows * 0.56;
  reflectionWeight *= mix(1.0, 0.38, nearSwimmer * uniforms.interaction.y);
  vec3 color = mix(refracted, reflected, clamp(reflectionWeight, 0.0, 0.92));
  // A height-based colour wash made crests look like translucent resin.  The
  // spectral normal, Fresnel response and actual foam now carry that contrast.
  vec2 velocityDirection = normalize(uniforms.player.zw + vec2(0.0001, 0.0));
  vec2 toPlayer = p - uniforms.player.xy;
  float behind = smoothstep(-0.2, 2.8, dot(toPlayer, -velocityDirection));
  float wakeRibbon = exp(-pow(abs(dot(toPlayer, vec2(-velocityDirection.y, velocityDirection.x))) / 0.64, 2.0)) * (1.0 - smoothstep(0.8, 6.5, playerDistance)) * behind;
  float wake = wakeRibbon * smoothstep(0.5, 5.5, uniforms.interaction.x) * uniforms.interaction.y;
  float crestHeight = smoothstep(0.27, 0.72, vWaveHeight);
  float shortCrossDerivative = short0.a * ${SPECTRAL_CASCADES[2].choppiness.toFixed(2)};
  vec2 shortHorizontalDerivative = short1.ba * ${SPECTRAL_CASCADES[2].choppiness.toFixed(2)};
  float shortJacobian = (1.0 + shortHorizontalDerivative.x) * (1.0 + shortHorizontalDerivative.y) - shortCrossDerivative * shortCrossDerivative;
  float surfaceCompression = vCompression + max(0.0, 1.0 - shortJacobian) * shortDistanceFade * 0.62;
  float crestPinch = smoothstep(0.16, 0.34, surfaceCompression);
  float crestVariation = valueNoise(p * 0.37 + vec2(time * 0.021, -time * 0.016)) * 0.55
    + valueNoise(p * 1.41 + vec2(-time * 0.043, time * 0.032)) * 0.30
    + valueNoise(p * 3.7 + vec2(time * 0.081, -time * 0.066)) * 0.15;
  float crestBreakup = smoothstep(0.60, 0.80, crestVariation);
  float crestDistanceFade = 1.0 - smoothstep(95.0 * detailRange, 188.0 * detailRange, distance(uniforms.cameraTime.xyz, vWorld));
  float breakerBreakup = smoothstep(0.43, 0.62, crestVariation);
  float breakerFoam = smoothstep(0.24, 0.72, vBreakerLip) * breakerBreakup * crestDistanceFade;
  float whitecap = max(crestHeight * pow(crestPinch, 4.0) * crestBreakup, breakerFoam * 0.78) * crestDistanceFade;
  float persistentBreakup = 0.48
    + valueNoise(p * 0.72 + vec2(time * 0.012, -time * 0.009)) * 0.34
    + valueNoise(p * 2.45 + vec2(-time * 0.024, time * 0.018)) * 0.18;
  float foamBreakup = smoothstep(0.46, 0.78, persistentBreakup);
  float persistentFoam = state.a * 0.58 * foamBreakup * (1.0 - uniforms.environment.x);
  // The coastal wash is selected by the conservative nearshore state rather
  // than by a decorative noise strip. Momentum makes active run-up brighter;
  // the depth window lets it naturally retreat with the simulated waterline.
  float nearshoreSpeed = length(state.gb) / max(depth, 0.08);
  float swashDepth = smoothstep(0.035, 0.11, depth) * (1.0 - smoothstep(0.24, 0.62, depth));
  float activeSwash = smoothstep(0.018, 0.24, state.a) * clamp(0.46 + nearshoreSpeed * 0.12, 0.46, 0.88);
  float shoreStateFoam = uniforms.environment.x * activeSwash * swashDepth * foamBreakup * 0.62;
  float foam = max(max(max(persistentFoam, shoreStateFoam), wake * 0.16), whitecap);
  float visibleFoam = mix(smoothstep(0.16, 0.66, foam), smoothstep(0.055, 0.40, foam), uniforms.environment.x);
  foam = underwater ? 0.0 : visibleFoam;
  float foamCoverage = max(clamp(foam * 0.21, 0.0, 0.145), breakerFoam * 0.22);
  color = mix(color, vec3(0.80, 0.88, 0.84), clamp(foamCoverage, 0.0, 0.22));
  float sunGlitter = oceanSunGlitter(N, V, L, recoveredVariance);
  color += vec3(1.0, 0.91, 0.70) * min(sunGlitter * 0.070, 0.34) * (underwater ? 0.08 : 1.0);
  if (underwater) {
    float viewDepth = min(distance(uniforms.cameraTime.xyz, vWorld), 22.0);
    color = mix(color, vec3(0.012, 0.205, 0.190), 0.42 + viewDepth / 22.0 * 0.12);
  }
  // The water pass carries no aerial term of its own: unfogged water reading
  // to the horizon is the authored look, and the island scene depends on it.
  // The 10x open ocean is the exception -- there the surface reaches far enough
  // that it needs the same fade as the terrain to settle into the horizon.
  // dryLand is 0 here: this surface is water, never exposed shore.
  // Underwater is excluded too: that camera is clamped to a ~19 m orbit and
  // already got its murk from the viewDepth blend just above.
  if (!underwater) {
    color = tethysAerialColor(color, vWorld, uniforms.cameraTime.xyz, uniforms.environment.w, false, 0.0);
  }
  waterColor = vec4(linearToSrgb(aces(color)), shorelineCoverage);
}
`;

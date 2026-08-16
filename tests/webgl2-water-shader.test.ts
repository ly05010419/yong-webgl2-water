import { describe, expect, it } from "vitest";

import { SPECTRAL_CASCADES } from "../src/lib/spectral-ocean";
import {
  BREAKER_PATCH_ACROSS_RESOLUTION,
  BREAKER_PATCH_ALONG_RESOLUTION,
  BREAKER_ENABLED,
  BREAKER_SHADER_GATE,
  WATER_CLIPMAP_LEVELS,
  WATER_CLIPMAP_RESOLUTION,
  WATER_HORIZON_REACH,
} from "../src/lib/water-constants";
import {
  WATER_BREAKER_PATCH_VERTEX_GLSL,
  WATER_FRAGMENT_GLSL,
  WATER_FRAGMENT_SAMPLERS_GLSL,
  WATER_SAMPLER_NAMES,
  WATER_SURFACE_GLSL,
  WATER_SURFACE_SAMPLERS_GLSL,
  WATER_VARYINGS,
  WATER_VERTEX_GLSL,
  waterVaryingsGlsl,
} from "../src/lib/webgl2/water-glsl";
import { BREAKER_PATCH_VERTEX_COUNT, WATER_CLIPMAP_VERTEX_COUNT } from "../src/lib/webgl2/water-pass";

// These tests cover everything about the water port that is pure text or pure
// arithmetic. Compiling the four programs needs a real WebGL2 context and is
// exercised by the engine itself.

const SOURCES: ReadonlyArray<readonly [string, string]> = [
  ["WATER_SURFACE_GLSL", WATER_SURFACE_GLSL],
  ["WATER_VERTEX_GLSL", WATER_VERTEX_GLSL],
  ["WATER_BREAKER_PATCH_VERTEX_GLSL", WATER_BREAKER_PATCH_VERTEX_GLSL],
  ["WATER_FRAGMENT_GLSL", WATER_FRAGMENT_GLSL],
];

const WGSL_RESIDUE = [
  "vec2<f32>",
  "vec3<f32>",
  "vec4<f32>",
  "vec2<u32>",
  "array<",
  "select(",
  "textureSample(",
  "textureSampleLevel",
  "textureLoad(",
  "textureDimensions(",
  "@builtin",
  "@group",
  "@binding",
  "@vertex",
  "@fragment",
  "@location",
  "override ",
  "atan2(",
  "f32(",
  "u32(",
  "i32(",
  " -> ",
  ": f32",
  "vertexId",
  "instanceId",
  "input.",
  "output.",
] as const;

const WGSL_KEYWORD_LINE = /^\s*(fn|let|var)\s/m;

function stripComments(source: string): string {
  return source.replace(/\/\/.*$/gm, "");
}

function braceBalance(source: string): number {
  const stripped = stripComments(source);
  return (stripped.match(/\{/g) ?? []).length - (stripped.match(/\}/g) ?? []).length;
}

// Every literal below is copied out of the frozen WGSL water shader
// (webgpu-water-engine.ts:909-1535). A single changed digit is a visual
// regression that no screenshot diff would attribute correctly.
const PORTED_CONSTANTS: ReadonlyArray<readonly [string, string]> = [
  ["dielectric eta", "float eta = 1.0 / 1.333;"],
  ["fresnel parallel", "(cosine - 1.333 * transmittedCosine)"],
  ["Cox-Munk along variance", "float alongVariance = 0.0363 + extraVariance;"],
  ["Cox-Munk across variance", "float acrossVariance = 0.0251 + extraVariance;"],
  ["Smith mean square slope", "smithVisibility(ndv, 0.0307 + extraVariance)"],
  ["glitter normalisation", "(6.2831853 * sqrt(alongVariance * acrossVariance))"],
  ["wind direction", "normalize(vec3(0.887, 0.0, -0.462))"],
  ["breaker front period", "float travellingPhase = time * 2.4 + 12.0;"],
  ["breaker front wrap", "floor(travellingPhase / 72.0) * 72.0 - 36.0"],
  ["breaker front visibility", "1.0 - smoothstep(28.0, 35.0, abs(front))"],
  ["breaker event window", "smoothstep(0.035, 0.68, textureLod(breakerEvents, uv, 0.0).r)"],
  ["breaker meander", "sin(along * 0.055 + time * 0.055 + 0.7) * 3.8"],
  ["breaker concentration", "float concentration = 8.2 * breakerFrontVisibility(front)"],
  ["breaker band width", "float bandWidth = 12.5;"],
  ["breaker domain half diagonal", "float domainHalfDiagonal = 276.0;"],
  ["tanh NaN guard", "tanh(clamp((across - front) / bandWidth, -30.0, 30.0))"],
  ["breaker envelope", "float localEnvelope = exp(-0.55 * u * u) * edgeWindow;"],
  ["breaker crest amplitude", "float vertical = 2.45 * localEnvelope * crestProfile * alongVariation;"],
  ["breaker horizontal amplitude", "-travelDirection * 2.15 * localEnvelope * sin(phase) * alongVariation"],
  ["breaker lip lean", "travelDirection * 0.72 * lip * alongVariation"],
  ["shallow attenuation", "smoothstep(0.14, 2.7, depth)"],
  ["bound harmonic long", "0.14 * (longHeight * longHeight - 0.080 * uniforms.waves.y)"],
  ["bound harmonic medium", "0.32 * (mediumHeight * mediumHeight - 0.030 * uniforms.waves.y)"],
  ["long slope gain", "long1.rg * (1.0 + 0.28 * longHeight)"],
  ["medium slope gain", "medium1.rg * (1.0 + 0.64 * mediumHeight)"],
  ["simulation coverage", "smoothstep(0.008, 0.055, simulationEdge)"],
  ["nearshore ownership", "1.0 - smoothstep(3.8, 5.55, depth)"],
  ["breaker derivative step", "float breakerStep = 0.55;"],
  ["compression lip weight", "breaker.w * 0.38;"],
];

const FRAGMENT_CONSTANTS: ReadonlyArray<readonly [string, string]> = [
  ["patch hand-over along window", "1.0 - smoothstep(158.0, 176.0, abs(vBreakerCoord.y))"],
  ["patch hand-over inner band", "abs(vBreakerCoord.x) < 11.72"],
  ["patch hand-over outer band", "abs(vBreakerCoord.x) > 11.82"],
  ["shoreline width clamp", "clamp(fwidth(waterColumn), 0.006, 0.06)"],
  ["shoreline threshold", "mix(0.018, 0.28, uniforms.environment.x)"],
  ["shoreline discard", "if (shorelineCoverage < 0.01) { discard; }"],
  ["minimum depth", "float depth = max(waterColumn, 0.018);"],
  ["capillary screen fade", "smoothstep(3.0, 14.0, pixelsPerWave * detailRange)"],
  ["medium pixels per wave", "uniforms.atmosphere.w / 8.0 / max(pixelWorldSize, 1e-6)"],
  ["long pixels per wave", "uniforms.atmosphere.z / 5.0 / max(pixelWorldSize, 1e-6)"],
  ["swell smoothing guard", "max(swellSmoothing, 0.001)"],
  ["capillary normal weight", "vec3(-shortSlope.x, 0.0, -shortSlope.y) * 0.42"],
  ["surface roughness range", "mix(0.035, 0.115, smoothstep(0.012, 0.30, length(shortSlope)"],
  ["terrain normal reconstruction", "sqrt(max(1.0 - terrain.g * terrain.g - terrain.b * terrain.b, 0.0001))"],
  ["floor light", "* 0.56 + 0.48, 0.0, 1.0)"],
  ["refraction depth gain", "mix(0.42, 1.25, 1.0 - ndv)"],
  ["sand colour", "vec3(0.46, 0.37, 0.225)"],
  ["sand variation", "valueNoise(refractedP * 0.18) * 0.055 + valueNoise(refractedP * 0.62 + vec2(7.1, -3.4)) * 0.018"],
  ["floor light range", "mix(0.70, 1.02, floorLight)"],
  ["refraction offset scale", "(0.0025 + min(depth, 14.0) * 0.00072)"],
  ["captured depth threshold", "1.0 - step(0.9995, capturedDepth)"],
  ["captured gamma", "pow(max(capturedScene, vec3(0.0)), vec3(2.2))"],
  ["capture coverage", "1.0 - smoothstep(6.5, 8.5, depth)"],
  ["capture blend", "capturedGeometry * captureCoverage * 0.88"],
  ["optical depth grazing clamp", "depth / max(ndv, 0.28)"],
  ["underwater optical depth clamp", "max(abs(dot(N, V)), 0.32)"],
  ["absorption", "vec3 absorption = vec3(0.37, 0.125, 0.054);"],
  ["scatter colour", "vec3 scatterColor = vec3(0.0035, 0.096, 0.092);"],
  ["phase g", "float phaseG = 0.24;"],
  ["phase floor", "2.0 * phaseG * lightCosine, 0.04), 1.5)"],
  ["scatter weight", "(0.72 + phase * 0.060)"],
  ["refraction softness", "smoothstep(3.0, 15.0, opticalDepth) * 0.08"],
  ["reference blur A", "vec3(0.012, 0.006, -0.009)"],
  ["reference blur B", "vec3(0.010, 0.004, -0.012)"],
  ["reference blur weights", "reflected * 0.64 + blurA * 0.18 + blurB * 0.18"],
  ["reflection spread gain", "sqrt(recoveredVariance) * 1.9"],
  ["reflection spread threshold", "if (reflectionSpread > 0.002)"],
  ["reflection spread taps", "spreadT * 0.55 * reflectionSpread + spreadB * 0.84 * reflectionSpread"],
  ["reflection spread mix", "reflected * 0.40 + (tapA + tapB + tapC) * 0.20"],
  ["reflection tint", "mix(vec3(0.70, 0.77, 0.80), vec3(0.76, 0.81, 0.83), surfaceRoughness)"],
  ["near swimmer", "1.0 - smoothstep(0.85, 3.4, playerDistance)"],
  ["underwater fresnel", "underwater ? fresnel * 0.07 : fresnel"],
  ["shore shallows", "1.0 - smoothstep(0.12, 1.02, depth)"],
  ["shallow transmission tint", "capturedLinear * vec3(0.66, 0.62, 0.52)"],
  ["shallow transmission floor", "vec3(0.004, 0.013, 0.011) * smoothstep(0.10, 0.90, depth)"],
  ["shallow transmission blend", "shoreShallows * 0.76"],
  ["shore reflection damping", "1.0 - shoreShallows * 0.56"],
  ["swimmer reflection damping", "mix(1.0, 0.38, nearSwimmer * uniforms.interaction.y)"],
  ["reflection weight clamp", "clamp(reflectionWeight, 0.0, 0.92)"],
  ["wake ribbon width", "/ 0.64, 2.0)"],
  ["wake distance fade", "1.0 - smoothstep(0.8, 6.5, playerDistance)"],
  ["wake behind", "smoothstep(-0.2, 2.8, dot(toPlayer, -velocityDirection))"],
  ["wake speed gate", "smoothstep(0.5, 5.5, uniforms.interaction.x)"],
  ["crest height", "smoothstep(0.27, 0.72, vWaveHeight)"],
  ["short jacobian weight", "shortDistanceFade * 0.62"],
  ["crest pinch", "smoothstep(0.16, 0.34, surfaceCompression)"],
  ["crest variation octaves", "valueNoise(p * 0.37 + vec2(time * 0.021, -time * 0.016)) * 0.55"],
  ["crest breakup", "smoothstep(0.60, 0.80, crestVariation)"],
  ["crest distance fade", "smoothstep(95.0 * detailRange, 188.0 * detailRange"],
  ["breaker breakup", "smoothstep(0.43, 0.62, crestVariation)"],
  ["breaker foam", "smoothstep(0.24, 0.72, vBreakerLip)"],
  ["whitecap", "max(crestHeight * pow(crestPinch, 4.0) * crestBreakup, breakerFoam * 0.78)"],
  ["persistent breakup", "float persistentBreakup = 0.48"],
  ["foam breakup", "smoothstep(0.46, 0.78, persistentBreakup)"],
  ["persistent foam", "state.a * 0.58 * foamBreakup"],
  ["nearshore speed", "length(state.gb) / max(depth, 0.08)"],
  ["swash depth window", "smoothstep(0.035, 0.11, depth) * (1.0 - smoothstep(0.24, 0.62, depth))"],
  ["active swash", "smoothstep(0.018, 0.24, state.a) * clamp(0.46 + nearshoreSpeed * 0.12, 0.46, 0.88)"],
  ["shore state foam", "foamBreakup * 0.62;"],
  ["wake foam weight", "wake * 0.16"],
  ["visible foam", "mix(smoothstep(0.16, 0.66, foam), smoothstep(0.055, 0.40, foam), uniforms.environment.x)"],
  ["foam coverage", "max(clamp(foam * 0.21, 0.0, 0.145), breakerFoam * 0.22)"],
  ["foam colour", "vec3(0.80, 0.88, 0.84), clamp(foamCoverage, 0.0, 0.22)"],
  ["sun glitter tint", "vec3(1.0, 0.91, 0.70) * min(sunGlitter * 0.070, 0.34)"],
  ["underwater glitter", "(underwater ? 0.08 : 1.0)"],
  ["underwater murk", "vec3(0.012, 0.205, 0.190), 0.42 + viewDepth / 22.0 * 0.12"],
  ["underwater view depth", "min(distance(uniforms.cameraTime.xyz, vWorld), 22.0)"],
];

const PATCH_CONSTANTS: ReadonlyArray<readonly [string, string]> = [
  ["patch breakup signal", "sin(along * 0.041 + time * 0.08 + 0.4)"],
  ["patch breakup harmonic", "0.48 * sin(along * 0.097 - time * 0.035 - 1.2)"],
  ["patch breakup window", "smoothstep(-0.10, 0.65, breakupSignal)"],
  ["patch envelope", "exp(-0.58 * u * u)"],
  ["patch edge window", "1.0 - smoothstep(0.70, 1.24, abs(u))"],
  ["patch along window", "1.0 - smoothstep(158.0, 176.0, abs(along))"],
  ["patch along variation", "0.86 + 0.14 * sin(along * 0.092 + 1.8)"],
  ["patch breakup mix", "0.24 + 0.76 * breakerPatchBreakup(along, time)"],
  ["patch horizontal amount", "0.62 * breakup * lip * envelope * alongVariation"],
  ["patch vertical amount", "0.14 * breakup * lip * envelope * alongVariation"],
  ["patch meander derivative", "cos(along * 0.055 + time * 0.055 + 0.7) * 0.209"],
  ["patch meander derivative harmonic", "cos(along * 0.14 - time * 0.032 - 1.3) * 0.168"],
  ["patch derivative step", "float derivativeStep = 0.12;"],
  ["patch extent along", "mix(-180.0, 180.0, uv.x)"],
  ["patch extent across", "mix(-12.0, 12.0, uv.y)"],
  ["patch compression bump", "smoothstep(0.62, 0.94, patchBreakup) * (1.0 - smoothstep(0.3, 4.5, abs(across))) * 0.055"],
];

describe("water GLSL port", () => {
  it.each(SOURCES)("%s carries no WGSL syntax", (_name, source) => {
    for (const residue of WGSL_RESIDUE) expect(source).not.toContain(residue);
    expect(stripComments(source)).not.toMatch(WGSL_KEYWORD_LINE);
    expect(source).not.toContain("#version");
    expect(source).not.toMatch(/precision\s+\w+\s+float/);
    expect(braceBalance(source)).toBe(0);
  });

  it.each(PORTED_CONSTANTS)("keeps the shared surface constant: %s", (_label, snippet) => {
    expect(WATER_SURFACE_GLSL).toContain(snippet);
  });

  it.each(FRAGMENT_CONSTANTS)("keeps the fragment constant: %s", (_label, snippet) => {
    expect(WATER_FRAGMENT_GLSL).toContain(snippet);
  });

  it.each(PATCH_CONSTANTS)("keeps the breaker patch constant: %s", (_label, snippet) => {
    expect(WATER_BREAKER_PATCH_VERTEX_GLSL).toContain(snippet);
  });

  it("interpolates the cascade choppiness and tile literals exactly as the WGSL template does", () => {
    expect(SPECTRAL_CASCADES[0].choppiness.toFixed(2)).toBe("1.18");
    expect(SPECTRAL_CASCADES[1].choppiness.toFixed(2)).toBe("1.05");
    expect(SPECTRAL_CASCADES[2].choppiness.toFixed(2)).toBe("0.40");
    expect(SPECTRAL_CASCADES[2].lengthScale.toFixed(1)).toBe("12.0");
    expect(WATER_SURFACE_GLSL).toContain("long0.rg * 1.18 + medium0.rg * 1.05");
    expect(WATER_SURFACE_GLSL).toContain("long0.a * 1.18 + medium0.a * 1.05");
    expect(WATER_SURFACE_GLSL).toContain("long1.ba * 1.18 + medium1.ba * 1.05");
    expect(WATER_FRAGMENT_GLSL).toContain("fract(p / 12.0 + vec2(0.5))");
    expect(WATER_FRAGMENT_GLSL).toContain("float pixelsPerWave = 12.0 / 12.0 / max(pixelWorldSize, 1e-6);");
    expect(WATER_FRAGMENT_GLSL).toContain("long0F.a * 1.18 * longFadeF + medium0F.a * 1.05 * mediumFadeF");
    expect(WATER_FRAGMENT_GLSL).toContain("float shortCrossDerivative = short0.a * 0.40;");
    expect(WATER_FRAGMENT_GLSL).toContain("vec2 shortHorizontalDerivative = short1.ba * 0.40;");
  });

  it("gates every breaker term through BREAKER_SHADER_GATE without deleting the code", () => {
    expect(BREAKER_ENABLED).toBe(false);
    expect(BREAKER_SHADER_GATE).toBe("0.0");
    // Two sites live in the shared surface code, so every stage that embeds it
    // inherits them: the patch vertex and the fragment each add one of their own.
    const gated = [
      [WATER_SURFACE_GLSL, 2],
      [WATER_VERTEX_GLSL, 2],
      [WATER_BREAKER_PATCH_VERTEX_GLSL, 3],
      [WATER_FRAGMENT_GLSL, 3],
    ] as const;
    for (const [source, occurrences] of gated) {
      expect(source.split(`* ${BREAKER_SHADER_GATE};`).length - 1).toBe(occurrences);
    }
    // The two hand-over discards survive even though the gate makes them dead.
    expect(WATER_FRAGMENT_GLSL).toContain("if (vSurfaceKind < 0.5 && patchVisible * patchAlong > 0.001");
    expect(WATER_FRAGMENT_GLSL).toContain("if (vSurfaceKind > 0.5 && (patchVisible <= 0.001");
    expect(WATER_FRAGMENT_GLSL.match(/discard;/g)?.length).toBe(3);
    // localizedBreakerDisplacement and its two finite differences.
    expect(WATER_SURFACE_GLSL.match(/localizedBreakerDisplacement\(/g)?.length).toBe(4);
  });

  it("handles REFERENCE_MODE with the preprocessor instead of a WGSL override", () => {
    expect(WATER_FRAGMENT_GLSL).toContain("#ifndef REFERENCE_MODE");
    expect(WATER_FRAGMENT_GLSL).toContain("#define REFERENCE_MODE 0");
    expect(WATER_FRAGMENT_GLSL).toContain("#if REFERENCE_MODE == 1");
    expect(WATER_FRAGMENT_GLSL).toContain("#endif");
    expect(WATER_FRAGMENT_GLSL).not.toContain("if (REFERENCE_MODE)");
    // Exactly the three extra sky taps of the reference variant sit inside it.
    const guarded = WATER_FRAGMENT_GLSL.slice(
      WATER_FRAGMENT_GLSL.indexOf("#if REFERENCE_MODE == 1"),
      WATER_FRAGMENT_GLSL.indexOf("  // Sub-resolution slope"),
    );
    expect(guarded.match(/skyColor\(/g)?.length).toBe(2);
    expect(guarded).toContain("#endif");
  });

  it("declares the six-corner cell table once, at global scope, for both vertex stages", () => {
    for (const source of [WATER_VERTEX_GLSL, WATER_BREAKER_PATCH_VERTEX_GLSL]) {
      expect(source).toContain("const uvec2 corners[6] = uvec2[6](");
      expect(source).toContain(
        "uvec2(0u, 0u), uvec2(0u, 1u), uvec2(1u, 0u),\n  uvec2(0u, 1u), uvec2(1u, 1u), uvec2(1u, 0u)",
      );
      // Exactly one declaration, and it precedes main() rather than sitting in it.
      expect(source.split("const uvec2 corners[6]").length - 1).toBe(1);
      expect(source.indexOf("const uvec2 corners[6]")).toBeLessThan(source.indexOf("void main()"));
    }
  });

  it("builds the clipmap from gl_VertexID / gl_InstanceID with the degenerate centre and horizon skirt", () => {
    expect(WATER_VERTEX_GLSL).toContain("uint cellId = uint(gl_VertexID) / 6u;");
    expect(WATER_VERTEX_GLSL).toContain("corners[uint(gl_VertexID) % 6u]");
    expect(WATER_VERTEX_GLSL).toContain("float level = float(gl_InstanceID);");
    expect(WATER_VERTEX_GLSL).toContain(`uint resolution = ${WATER_CLIPMAP_RESOLUTION}u;`);
    expect(WATER_VERTEX_GLSL).toContain("float halfExtent = 32.0 * exp2(level);");
    expect(WATER_VERTEX_GLSL).toContain("floor(uniforms.cameraTime.xz / cellSize) * cellSize");
    expect(WATER_VERTEX_GLSL).toContain("if (gl_InstanceID > 0) {");
    expect(WATER_VERTEX_GLSL).toContain("float innerHalf = halfExtent * 0.5 - cellSize;");
    expect(WATER_VERTEX_GLSL).toContain("all(lessThan(abs(cellCenter - snappedCamera), vec2(innerHalf)))");
    expect(WATER_VERTEX_GLSL).toContain("baseP = vec2(10000.0);");
    expect(WATER_VERTEX_GLSL).toContain(`if (gl_InstanceID == ${WATER_CLIPMAP_LEVELS - 1}) {`);
    expect(WATER_VERTEX_GLSL).toContain("grid.x == 0u || grid.x == resolution || grid.y == 0u || grid.y == resolution");
    expect(WATER_VERTEX_GLSL).toContain(`outward * (${WATER_HORIZON_REACH}.0 / max(reach, 1.0))`);
    expect(WATER_VERTEX_GLSL).toContain("float coordinateStep = 0.55;");
    expect(WATER_VERTEX_GLSL).toContain("vNormal = normalize(cross(tangentZ, tangentX));");
  });

  it("projects the horizon skirt at GL's [-1, 1] depth equivalent of the WGSL 0.99999", () => {
    expect(WATER_VERTEX_GLSL).toContain("towardHorizon.y = 0.0;");
    expect(WATER_VERTEX_GLSL).toContain("uniforms.viewProj * vec4(towardHorizon, 0.0)");
    expect(WATER_VERTEX_GLSL).toContain("horizonClip.z = horizonClip.w * 0.99998;");
    expect(WATER_VERTEX_GLSL).not.toContain("0.99999;");
    // WebGPU writes ndc z = 0.99999 directly (z in [0, 1]); GL's viewport
    // transform maps ndc z = 0.99998 in [-1, 1] onto the same window depth.
    expect(0.99998 * 0.5 + 0.5).toBeCloseTo(0.99999, 10);
  });

  it("flips the refraction normal offset for GL's upward screen v", () => {
    expect(WATER_FRAGMENT_GLSL).toContain("vec2 screenUv = gl_FragCoord.xy / max(uniforms.interaction.zw, vec2(1.0));");
    expect(WATER_FRAGMENT_GLSL).toContain("clamp(screenUv + vec2(N.x, N.z) * (0.0025 + min(depth, 14.0) * 0.00072), vec2(0.001), vec2(0.999))");
    expect(WATER_FRAGMENT_GLSL).not.toContain("vec2(N.x, -N.z)");
    expect(WATER_FRAGMENT_GLSL).not.toContain("-N.z");
    // No y flip anywhere: screen y and texture v run the same way in GL.
    expect(WATER_FRAGMENT_GLSL).not.toContain("1.0 - screenUv");
    expect(WATER_FRAGMENT_GLSL).not.toContain("0.5 - gl_FragCoord");
  });

  it("reads the captured depth through texelFetch with uSceneDims instead of textureDimensions", () => {
    expect(WATER_FRAGMENT_SAMPLERS_GLSL).toContain("uniform sampler2D sceneDepthTexture;");
    expect(WATER_FRAGMENT_SAMPLERS_GLSL).toContain("uniform ivec2 uSceneDims;");
    expect(WATER_FRAGMENT_GLSL).toContain("ivec2 sceneDimensions = uSceneDims;");
    expect(WATER_FRAGMENT_GLSL).toContain("ivec2(clamp(refractionUv * vec2(sceneDimensions), vec2(0.0), vec2(sceneDimensions - ivec2(1))))");
    expect(WATER_FRAGMENT_GLSL).toContain("texelFetch(sceneDepthTexture, sceneCoord, 0).r");
    expect(WATER_FRAGMENT_GLSL).toContain("texture(sceneColorTexture, refractionUv).rgb");
  });

  it("computes fwidth before the shoreline discard", () => {
    const fwidthAt = WATER_FRAGMENT_GLSL.indexOf("fwidth(waterColumn)");
    const discardAt = WATER_FRAGMENT_GLSL.indexOf("if (shorelineCoverage < 0.01) { discard; }");
    expect(fwidthAt).toBeGreaterThan(-1);
    expect(discardAt).toBeGreaterThan(fwidthAt);
  });

  it("turns every WGSL select() into a ternary with the true branch first", () => {
    expect(WATER_FRAGMENT_GLSL).toContain("float mediumFadeF = (swellSmoothing <= 0.0) ? 1.0 :");
    expect(WATER_FRAGMENT_GLSL).toContain("float longFadeF = (swellSmoothing <= 0.0) ? 1.0 :");
    expect(WATER_FRAGMENT_GLSL).toContain("float opticalDepth = underwater ? max(0.0, uniforms.sunWater.w - uniforms.cameraTime.y)");
    expect(WATER_FRAGMENT_GLSL).toContain("foam = underwater ? 0.0 : visibleFoam;");
  });

  it("outputs sRGB-encoded tonemapped colour with shoreline coverage in alpha", () => {
    expect(WATER_FRAGMENT_GLSL).toContain("layout(location = 0) out vec4 waterColor;");
    expect(WATER_FRAGMENT_GLSL).toContain("waterColor = vec4(linearToSrgb(aces(color)), shorelineCoverage);");
    expect(WATER_FRAGMENT_GLSL).toContain(
      "color = tethysAerialColor(color, vWorld, uniforms.cameraTime.xyz, uniforms.environment.w, false, 0.0);",
    );
  });

  it("declares the WGSL Output struct as matching varyings on both stages", () => {
    expect(WATER_VARYINGS.map((entry) => entry.location)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(WATER_VARYINGS.map((entry) => entry.name)).toEqual([
      "vWorld", "vNormal", "vFieldUv", "vSimulationUv", "vWaveHeight",
      "vCompression", "vBreakerLip", "vBreakerCoord", "vSurfaceKind",
    ]);
    expect(waterVaryingsGlsl("out")).toContain("out vec3 vWorld;");
    expect(waterVaryingsGlsl("in")).toContain("in float vSurfaceKind;");
    for (const varying of WATER_VARYINGS) {
      expect(WATER_VERTEX_GLSL).toContain(`out ${varying.type} ${varying.name};`);
      expect(WATER_BREAKER_PATCH_VERTEX_GLSL).toContain(`out ${varying.type} ${varying.name};`);
      expect(WATER_FRAGMENT_GLSL).toContain(`in ${varying.type} ${varying.name};`);
    }
    expect(WATER_VERTEX_GLSL).toContain("vSurfaceKind = 0.0;");
    expect(WATER_BREAKER_PATCH_VERTEX_GLSL).toContain("vSurfaceKind = 1.0;");
  });

  it("keeps the WGSL binding names as sampler uniforms in texture-unit order", () => {
    expect(WATER_SAMPLER_NAMES).toEqual([
      "terrainField", "waterState", "longField0", "longField1", "mediumField0", "mediumField1",
      "shortField0", "shortField1", "breakerEvents", "sceneColorTexture", "sceneDepthTexture",
    ]);
    const declarations = `${WATER_SURFACE_SAMPLERS_GLSL}${WATER_FRAGMENT_SAMPLERS_GLSL}`;
    for (const name of WATER_SAMPLER_NAMES) expect(declarations).toContain(`uniform sampler2D ${name};`);
    // Vertex stages never touch the capillary cascade or the captured scene.
    for (const name of ["shortField0", "shortField1", "sceneColorTexture", "sceneDepthTexture"]) {
      expect(WATER_SURFACE_SAMPLERS_GLSL).not.toContain(name);
    }
  });

  it("uses textureLod in the vertex-shared code and texture() only in the fragment", () => {
    expect(WATER_SURFACE_GLSL).toContain("textureLod(waterState,");
    expect(WATER_SURFACE_GLSL).toContain("textureLod(terrainField, fieldUv, 0.0)");
    expect(WATER_SURFACE_GLSL).toContain("textureLod(longField0, longUv, 0.0)");
    expect(stripComments(WATER_SURFACE_GLSL)).not.toMatch(/[^d]\btexture\(/);
    expect(WATER_FRAGMENT_GLSL).toContain("texture(terrainField, displacedTerrainUv)");
    expect(WATER_FRAGMENT_GLSL).toContain("texture(shortField0, shortUv)");
  });
});

describe("water pass draw accounting", () => {
  it("matches the WebGPU draw calls", () => {
    expect(WATER_CLIPMAP_VERTEX_COUNT).toBe(WATER_CLIPMAP_RESOLUTION * WATER_CLIPMAP_RESOLUTION * 6);
    expect(WATER_CLIPMAP_VERTEX_COUNT).toBe(24576);
    expect(WATER_CLIPMAP_LEVELS).toBe(10);
    expect(BREAKER_PATCH_VERTEX_COUNT).toBe(BREAKER_PATCH_ALONG_RESOLUTION * BREAKER_PATCH_ACROSS_RESOLUTION * 6);
    expect(BREAKER_PATCH_VERTEX_COUNT).toBe(73728);
  });

  it("reaches 16384 m on the outermost ring, inside the 20000 m skirt", () => {
    const outerHalfExtent = 32 * 2 ** (WATER_CLIPMAP_LEVELS - 1);
    expect(outerHalfExtent).toBe(16384);
    expect(WATER_HORIZON_REACH).toBeGreaterThan(outerHalfExtent);
  });
});

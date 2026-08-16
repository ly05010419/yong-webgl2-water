import { describe, expect, it } from "vitest";

import { composeShaderSource } from "../src/lib/webgl2";
import { SKY_CLIP_Z, SKY_FRAGMENT_GLSL, SKY_VERTEX_COUNT, SKY_VERTEX_GLSL } from "../src/lib/webgl2/sky-glsl";
import {
  TERRAIN_FRAGMENT_GLSL,
  TERRAIN_VERTEX_GLSL,
  TERRAIN_VERTICES_PER_CELL,
} from "../src/lib/webgl2/terrain-glsl";
import { terrainVertexCount } from "../src/lib/webgl2/terrain-pass";
import { SPECTRAL_CASCADES } from "../src/lib/spectral-ocean";

// Node cannot link GLSL, so these tests cover what is verifiable off-GPU: that
// the ported sources carry no WGSL syntax, that every frozen constant of the
// sky (engine 727-752) and terrain (760-884) shaders survived the translation,
// that the sampler names still match the WGSL binding names, and that the draw
// arithmetic of the terrain pass is right.

const SHADER_BODIES: ReadonlyArray<readonly [string, string]> = [
  ["SKY_VERTEX_GLSL", SKY_VERTEX_GLSL],
  ["SKY_FRAGMENT_GLSL", SKY_FRAGMENT_GLSL],
  ["TERRAIN_VERTEX_GLSL", TERRAIN_VERTEX_GLSL],
  ["TERRAIN_FRAGMENT_GLSL", TERRAIN_FRAGMENT_GLSL],
];

const WGSL_RESIDUE = [
  "vec2<f32>",
  "vec3<f32>",
  "vec4<f32>",
  "vec2<u32>",
  "array<",
  "select(",
  "textureSampleLevel",
  "textureSample(",
  "textureLoad",
  "textureStore",
  "@builtin",
  "@group",
  "@binding",
  "@location",
  "@vertex",
  "@fragment",
  "fn ",
  "let ",
  "var<",
  "var ",
  "atan2(",
  " -> ",
  ": f32",
] as const;

const WGSL_KEYWORD_LINE = /^\s*(fn|let|var)\s/m;

function stripComments(source: string): string {
  return source.replace(/\/\/.*$/gm, "");
}

function braceBalance(source: string): number {
  const stripped = stripComments(source);
  return (stripped.match(/\{/g) ?? []).length - (stripped.match(/\}/g) ?? []).length;
}

describe("sky / terrain GLSL bodies", () => {
  it.each(SHADER_BODIES)("%s carries no WGSL syntax", (_name, source) => {
    const code = stripComments(source);
    for (const residue of WGSL_RESIDUE) expect(code).not.toContain(residue);
    expect(code).not.toMatch(WGSL_KEYWORD_LINE);
    expect(source).not.toContain("#version");
    expect(source).not.toMatch(/precision\s+\w+\s+float/);
    expect(braceBalance(source)).toBe(0);
  });

  it.each(SHADER_BODIES)("%s composes into a GLSL ES 3.00 source", (_name, source) => {
    const stage = source === SKY_VERTEX_GLSL || source === TERRAIN_VERTEX_GLSL ? "vertex" : "fragment";
    const composed = composeShaderSource(stage, source);
    expect(composed.startsWith("#version 300 es\n")).toBe(true);
    expect(composed).toContain("precision highp float;");
  });
});

describe("sky pass shaders", () => {
  it("generates the full-screen triangle from gl_VertexID at the GL-mapped sky depth", () => {
    expect(SKY_VERTEX_GLSL).toContain("gl_VertexID");
    expect(SKY_VERTEX_GLSL).toContain("vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0))");
    // WebGPU wrote 0.999999 into a [0, 1] clip volume; GL clips against
    // [-1, 1], so the same window depth needs 2 * 0.999999 - 1.
    expect(SKY_VERTEX_GLSL).toContain("0.999998");
    expect(SKY_CLIP_Z).toBe("0.999998");
    expect(Number(SKY_CLIP_Z)).toBeCloseTo(2 * 0.999999 - 1, 12);
    expect(SKY_VERTEX_GLSL).toContain("out vec2 vNdc;");
    expect(SKY_VERTEX_GLSL).toContain("vNdc = position;");
    expect(SKY_VERTEX_COUNT).toBe(3);
  });

  it("rebuilds the camera ray and the underwater volume with the frozen constants", () => {
    expect(SKY_FRAGMENT_GLSL).toContain("in vec2 vNdc;");
    expect(SKY_FRAGMENT_GLSL).toContain("layout(location = 0) out vec4 outColor;");
    expect(SKY_FRAGMENT_GLSL).toContain(
      "normalize(uniforms.cameraForward.xyz + vNdc.x * uniforms.cameraRight.xyz * uniforms.cameraRight.w + vNdc.y * uniforms.cameraUp.xyz * uniforms.cameraUp.w)",
    );
    expect(SKY_FRAGMENT_GLSL).toContain("skyColor(ray, uniforms.cameraTime.w, normalize(uniforms.sunWater.xyz))");
    expect(SKY_FRAGMENT_GLSL).toContain("uniforms.terrain.w > 0.5");
    expect(SKY_FRAGMENT_GLSL).toContain("smoothstep(-0.42, 0.72, ray.y)");
    expect(SKY_FRAGMENT_GLSL).toContain("mix(vec3(0.012, 0.155, 0.158), vec3(0.050, 0.385, 0.335), upward)");
    expect(SKY_FRAGMENT_GLSL).toContain("14.0) * upward");
    expect(SKY_FRAGMENT_GLSL).toContain("vec3(0.18, 0.30, 0.23) * lightColumn * 0.22");
    expect(SKY_FRAGMENT_GLSL).toContain("outColor = vec4(linearToSrgb(aces(color)), 1.0);");
  });

  it("reads WorldUniforms and the shared sky helpers", () => {
    expect(SKY_FRAGMENT_GLSL).toContain("layout(std140) uniform WorldUniforms {");
    expect(SKY_FRAGMENT_GLSL).toContain("vec3 skyColor(vec3 direction, float time, vec3 sunDirection)");
    expect(SKY_FRAGMENT_GLSL).toContain("vec3 aces(vec3 color)");
  });
});

describe("terrain vertex shader", () => {
  it("expands the procedural grid from gl_VertexID and environment.y", () => {
    expect(TERRAIN_VERTEX_GLSL).toContain("gl_VertexID");
    expect(TERRAIN_VERTEX_GLSL).toContain("uint resolution = uint(uniforms.environment.y);");
    expect(TERRAIN_VERTEX_GLSL).toContain("uint cellId = vertexId / 6u;");
    expect(TERRAIN_VERTEX_GLSL).toContain("uvec2 cell = uvec2(cellId % resolution, cellId / resolution);");
    // The cell table is a global `const` array, not a local re-declared per
    // invocation; the six values and their order are what must not change.
    expect(TERRAIN_VERTEX_GLSL).toContain("const uvec2 corners[6] = uvec2[6](");
    expect(TERRAIN_VERTEX_GLSL).toContain(
      "uvec2(0u, 0u), uvec2(0u, 1u), uvec2(1u, 0u),\n  uvec2(0u, 1u), uvec2(1u, 1u), uvec2(1u, 0u)",
    );
    expect(TERRAIN_VERTEX_GLSL.indexOf("const uvec2 corners[6]")).toBeLessThan(TERRAIN_VERTEX_GLSL.indexOf("void main()"));
    expect(TERRAIN_VERTEX_GLSL).toContain("corners[int(vertexId % 6u)]");
    expect(TERRAIN_VERTEX_GLSL).toContain("vec2 uv = vec2(grid) / float(resolution);");
  });

  it("samples the height with textureLod and matches the WGSL world mapping", () => {
    expect(TERRAIN_VERTEX_GLSL).toContain("textureLod(terrainField, uv, 0.0)");
    expect(TERRAIN_VERTEX_GLSL).toContain(
      "vec3 world = vec3((uv.x - 0.5) * uniforms.terrain.x, heightSample.r, (uv.y - 0.5) * uniforms.terrain.x);",
    );
    expect(TERRAIN_VERTEX_GLSL).toContain("gl_Position = uniforms.viewProj * vec4(world, 1.0);");
    expect(TERRAIN_VERTEX_GLSL).toContain("out vec3 vWorld;");
    expect(TERRAIN_VERTEX_GLSL).toContain("out vec2 vFieldUv;");
    // `sample` is reserved in GLSL ES 3.00.
    expect(TERRAIN_VERTEX_GLSL).not.toMatch(/\bsample\b\s*=/);
  });
});

describe("terrain fragment shader", () => {
  it("declares every WGSL binding under its original name", () => {
    for (const name of ["terrainField", "mediumField0", "mediumField1", "shortField0", "shortField1", "waterState"]) {
      expect(TERRAIN_FRAGMENT_GLSL).toContain(`uniform sampler2D ${name};`);
    }
    expect(TERRAIN_FRAGMENT_GLSL).toContain("in vec3 vWorld;");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("in vec2 vFieldUv;");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("layout(location = 0) out vec4 outColor;");
  });

  it("rebuilds the normal and the diffuse term", () => {
    expect(TERRAIN_FRAGMENT_GLSL).toContain("sqrt(max(1.0 - field.g * field.g - field.b * field.b, 0.0001))");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("vec3 N = normalize(vec3(field.g, normalY, field.b));");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("clamp(dot(N, L) * 0.56 + 0.48, 0.0, 1.0)");
  });

  it("keeps the six valueNoise layers with their frequencies", () => {
    expect(TERRAIN_FRAGMENT_GLSL).toContain("valueNoise(p * 0.075 - vec2(8.1, -2.4))");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("valueNoise(p * 0.38 + vec2(4.7, -9.2))");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("valueNoise(p * 0.021 + vec2(13.2, -6.7))");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("valueNoise(vec2(p.x * 0.055 + p.y * 0.018, p.y * 0.19 - p.x * 0.025))");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("valueNoise(p * 0.018 + vec2(-11.4, 6.8))");
    expect(TERRAIN_FRAGMENT_GLSL).toContain(
      "valueNoise(vec2(p.x * 0.092 + p.y * 0.027, p.y * 0.105 - p.x * 0.021) + vec2(3.9, -7.1))",
    );
    expect(TERRAIN_FRAGMENT_GLSL).toContain("float valueNoise(vec2 p)");
  });

  it("couples the near-shore solver field into the local waterline", () => {
    expect(TERRAIN_FRAGMENT_GLSL).toContain(
      "vec2 simulationUv = (p - uniforms.simulation.xy) / uniforms.simulation.z + vec2(0.5);",
    );
    expect(TERRAIN_FRAGMENT_GLSL).toContain(
      "step(0.0, simulationUv.x) * step(simulationUv.x, 1.0)\n    * step(0.0, simulationUv.y) * step(simulationUv.y, 1.0)",
    );
    expect(TERRAIN_FRAGMENT_GLSL).toContain("texture(waterState, clamp(simulationUv, vec2(0.0), vec2(1.0)))");
    expect(TERRAIN_FRAGMENT_GLSL).toContain(
      "clamp(shoreState.r, -0.16, 0.18) * inSimulation * uniforms.environment.x",
    );
  });

  it("keeps the wet / dry / rock palettes and their masks", () => {
    expect(TERRAIN_FRAGMENT_GLSL).toContain("mix(vec3(0.22, 0.185, 0.115), vec3(0.43, 0.345, 0.19), sedimentMacro)");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("mix(vec3(0.235, 0.135, 0.050), vec3(0.48, 0.315, 0.115), broad)");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("mix(vec3(0.22, 0.175, 0.125), vec3(0.39, 0.285, 0.175), geology)");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("smoothstep(0.18, 0.58, 1.0 - N.y) * 0.72 + smoothstep(0.68, 0.90, erosion) * 0.24");
    expect(TERRAIN_FRAGMENT_GLSL).toContain(
      "smoothstep(localWaterLevel + 0.18, localWaterLevel + 0.64, vWorld.y) * uniforms.environment.x",
    );
    expect(TERRAIN_FRAGMENT_GLSL).toContain(
      "smoothstep(localWaterLevel - 0.30, localWaterLevel + 0.34, vWorld.y) * uniforms.environment.x",
    );
    expect(TERRAIN_FRAGMENT_GLSL).toContain("smoothstep(0.018, 0.22, shoreState.a)");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("(1.0 - smoothstep(0.05, 0.62, abs(vWorld.y - localWaterLevel)))");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("mix(vec3(0.18, 0.135, 0.088), vec3(0.255, 0.185, 0.105), broad)");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("color = mix(color, wetSand, coast);");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("color = mix(color, wetSand * vec3(0.82, 0.88, 0.84), solverWash * 0.12);");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("color = mix(color, drySandLayered, exposed);");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("normalize(vec2(-0.52, -0.80))");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("mix(drySand, polishedSand, 0.28 + windPolish * 0.24)");
  });

  it("keeps the caustic chain and the interpolated cascade constants", () => {
    expect(SPECTRAL_CASCADES[2].lengthScale.toFixed(1)).toBe("12.0");
    expect(SPECTRAL_CASCADES[1].choppiness.toFixed(2)).toBe("1.05");
    expect(SPECTRAL_CASCADES[2].choppiness.toFixed(2)).toBe("0.40");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("vec2 refractedSunOffset = L.xz / max(L.y, 0.12) * depth * 0.18;");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("fract(surfaceP / uniforms.atmosphere.w + vec2(0.5))");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("fract(surfaceP / 12.0 + vec2(0.5))");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("texture(mediumField0, mediumUv) * uniforms.waves.x");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("texture(mediumField1, mediumUv) * uniforms.waves.x");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("vec4 short0 = texture(shortField0, shortUv);");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("float mediumCross = medium0.a * 1.05;");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("vec2 mediumDerivative = medium1.ba * 1.05;");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("float shortCross = short0.a * 0.40;");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("vec2 shortDerivative = short1.ba * 0.40;");
    expect(TERRAIN_FRAGMENT_GLSL).toContain(
      "max(0.0, 1.0 - mediumJacobian) * 0.48 + max(0.0, 1.0 - shortJacobian) * 0.52",
    );
    expect(TERRAIN_FRAGMENT_GLSL).toContain("pow(smoothstep(0.060, 0.27, surfaceFocus), 2.0)");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("smoothstep(0.6, 2.2, depth) * (1.0 - smoothstep(11.0, 20.0, depth))");
    expect(TERRAIN_FRAGMENT_GLSL).toContain("color *= 0.94 + focusedLight * 0.14 * (1.0 - exposed);");
    expect(TERRAIN_FRAGMENT_GLSL).toContain(
      "color += vec3(0.095, 0.105, 0.045) * focusedLight * 0.060 * (1.0 - exposed);",
    );
  });

  it("ends with the shared aerial perspective and the manual sRGB encode", () => {
    expect(TERRAIN_FRAGMENT_GLSL).toContain("bool underwater = uniforms.terrain.w > 0.5;");
    // WGSL `select(0.0, 1.0, underwater)` — the ternary reverses the operands.
    expect(TERRAIN_FRAGMENT_GLSL).toContain("float dryLand = exposed * (1.0 - (underwater ? 1.0 : 0.0));");
    expect(TERRAIN_FRAGMENT_GLSL).toContain(
      "tethysAerialColor(color, vWorld, uniforms.cameraTime.xyz, uniforms.environment.w, underwater, dryLand)",
    );
    expect(TERRAIN_FRAGMENT_GLSL).toContain("outColor = vec4(linearToSrgb(aces(color)), 1.0);");
  });
});

describe("terrainVertexCount", () => {
  it("matches the WebGPU draw count", () => {
    expect(TERRAIN_VERTICES_PER_CELL).toBe(6);
    expect(terrainVertexCount(512)).toBe(1_572_864);
    expect(terrainVertexCount(256)).toBe(256 * 256 * 6);
    expect(terrainVertexCount(1)).toBe(6);
  });

  it("rejects non-positive and non-integer resolutions", () => {
    expect(() => terrainVertexCount(0)).toThrow(/正整数/);
    expect(() => terrainVertexCount(-4)).toThrow(/正整数/);
    expect(() => terrainVertexCount(12.5)).toThrow(/正整数/);
    expect(() => terrainVertexCount(Number.NaN)).toThrow(/正整数/);
  });
});

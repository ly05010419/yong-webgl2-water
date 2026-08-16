import { describe, expect, it } from "vitest";

import {
  AERIAL_GLSL,
  COLOR_GLSL,
  COMPUTE_STATE,
  FULLSCREEN_TRIANGLE_VERTEX_GLSL,
  GLSL_PRECISION_PREAMBLE,
  GLSL_VERSION_LINE,
  SKY_GLSL,
  TERRAIN_HEIGHT_GLSL,
  WATER_STATE,
  WORLD_SHADING_GLSL,
  WORLD_UNIFORMS_BINDING,
  WORLD_UNIFORMS_GLSL,
  WORLD_UNIFORM_BYTES,
  WORLD_UNIFORM_FIELDS,
  composeShaderSource,
  preambleLineCount,
  textureFormatInfo,
} from "../src/lib/webgl2";
import { TETHYS_WATER_LEVEL } from "../src/lib/water-profiles";

// The GL runtime helpers (context, textures, framebuffers, programs) need a
// real WebGL2RenderingContext and are exercised in the browser by the engine
// itself; these tests cover everything that is pure: GLSL text, source
// composition, format tables and state presets.

const GLSL_FRAGMENTS: ReadonlyArray<readonly [string, string]> = [
  ["WORLD_UNIFORMS_GLSL", WORLD_UNIFORMS_GLSL],
  ["COLOR_GLSL", COLOR_GLSL],
  ["SKY_GLSL", SKY_GLSL],
  ["AERIAL_GLSL", AERIAL_GLSL],
  ["TERRAIN_HEIGHT_GLSL", TERRAIN_HEIGHT_GLSL],
  ["FULLSCREEN_TRIANGLE_VERTEX_GLSL", FULLSCREEN_TRIANGLE_VERTEX_GLSL],
];

const WGSL_RESIDUE = [
  "vec2<f32>",
  "vec3<f32>",
  "vec4<f32>",
  "mat4x4<f32>",
  "select(",
  "textureSampleLevel",
  "textureLoad(",
  "@builtin",
  "@group",
  "@binding",
  "atan2(",
  "f32(",
  "u32(",
  "i32(",
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

describe("shared GLSL fragments", () => {
  it.each(GLSL_FRAGMENTS)("%s carries no WGSL syntax", (_name, source) => {
    for (const residue of WGSL_RESIDUE) expect(source).not.toContain(residue);
    expect(stripComments(source)).not.toMatch(WGSL_KEYWORD_LINE);
    expect(source).not.toContain("#version");
    expect(source).not.toMatch(/precision\s+\w+\s+float/);
    expect(braceBalance(source)).toBe(0);
  });

  it("declares WorldUniforms as a std140 block named `uniforms` with the WGSL field order", () => {
    expect(WORLD_UNIFORMS_GLSL).toContain("layout(std140) uniform WorldUniforms {");
    expect(WORLD_UNIFORMS_GLSL).toMatch(/\}\s*uniforms;/);
    expect(WORLD_UNIFORMS_GLSL).toContain("mat4 viewProj;");
    const offsets = WORLD_UNIFORM_FIELDS.map((field) => WORLD_UNIFORMS_GLSL.indexOf(` ${field};`));
    offsets.forEach((offset) => expect(offset).toBeGreaterThan(-1));
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
    expect(WORLD_UNIFORM_FIELDS).toEqual([
      "viewProj", "cameraTime", "cameraRight", "cameraUp", "cameraForward", "sunWater", "terrain",
      "simulation", "player", "interaction", "environment", "waves", "atmosphere",
    ]);
    // mat4 (64 B) + 12 vec4 (192 B) = 256 B, binding 0.
    expect(64 + (WORLD_UNIFORM_FIELDS.length - 1) * 16).toBe(WORLD_UNIFORM_BYTES);
    expect(WORLD_UNIFORMS_BINDING).toBe(0);
  });

  it("ports the colour helpers with their exact constants", () => {
    expect(COLOR_GLSL).toContain("vec3 linearToSrgb(vec3 value)");
    expect(COLOR_GLSL).toContain("vec3 aces(vec3 color)");
    expect(COLOR_GLSL).toContain("value * 12.92");
    expect(COLOR_GLSL).toContain("vec3(1.0 / 2.4)");
    expect(COLOR_GLSL).toContain("step(vec3(0.0031308), value)");
    expect(COLOR_GLSL).toContain("2.51 * color + vec3(0.03)");
    expect(COLOR_GLSL).toContain("2.43 * color + vec3(0.59)");
  });

  it("ports the sky helpers in dependency order", () => {
    const hash = SKY_GLSL.indexOf("float cloudHash3(vec3 pInput)");
    const noise = SKY_GLSL.indexOf("float cloudNoise3(vec3 p)");
    const sky = SKY_GLSL.indexOf("vec3 skyColor(vec3 direction, float time, vec3 sunDirection)");
    expect(hash).toBeGreaterThan(-1);
    expect(noise).toBeGreaterThan(hash);
    expect(sky).toBeGreaterThan(noise);
    expect(SKY_GLSL).toContain("vec3(time * 0.0040, -time * 0.0014, time * 0.0023)");
    expect(SKY_GLSL).toContain("smoothstep(0.535, 0.68, cloudField)");
    expect(SKY_GLSL).toContain("pow(sunDot, 20.0) * 0.08");
  });

  it("ports the aerial perspective with select() branches turned into ternaries", () => {
    expect(AERIAL_GLSL).toContain(
      "vec3 tethysAerialColor(vec3 color, vec3 world, vec3 cameraPos, float worldScale, bool underwater, float dryLand)",
    );
    expect(AERIAL_GLSL).toContain("uniforms.atmosphere.x");
    expect(AERIAL_GLSL).toContain("underwater ? 0.0075 : 0.00155 / worldScale");
    expect(AERIAL_GLSL).toContain("(underwater ? 2.0 : 20.0 * worldScale)");
    expect(AERIAL_GLSL).toContain("(fogReach <= 0.0)");
    expect(AERIAL_GLSL).toContain("underwater ? vec3(0.012, 0.205, 0.185) : vec3(0.42, 0.66, 0.71)");
    expect(AERIAL_GLSL).toContain("mix(0.99, 0.72, dryLand)");
  });

  it("bundles the shading prelude with uniforms before the aerial function", () => {
    expect(WORLD_SHADING_GLSL.indexOf("uniform WorldUniforms")).toBeLessThan(WORLD_SHADING_GLSL.indexOf("vec3 tethysAerialColor("));
    expect(WORLD_SHADING_GLSL.indexOf("vec3 skyColor(")).toBeLessThan(WORLD_SHADING_GLSL.indexOf("vec3 tethysAerialColor("));
  });

  it("ports the terrain height field in declare-before-use order with the interpolated dune literals", () => {
    const hash = TERRAIN_HEIGHT_GLSL.indexOf("float hash21(vec2 p)");
    const noise = TERRAIN_HEIGHT_GLSL.indexOf("float valueNoise(vec2 p)");
    const shelf = TERRAIN_HEIGHT_GLSL.indexOf(
      "float tethysCoastalShelf(vec2 p, vec2 center, vec2 radiusScale, float lift, float relief, float phase)",
    );
    const height = TERRAIN_HEIGHT_GLSL.indexOf("float terrainHeight(vec2 p, float shoreMix)");
    expect(hash).toBeGreaterThan(-1);
    expect(noise).toBeGreaterThan(hash);
    expect(shelf).toBeGreaterThan(noise);
    expect(height).toBeGreaterThan(shelf);
    expect((TETHYS_WATER_LEVEL + 0.62).toFixed(2)).toBe("2.02");
    expect((TETHYS_WATER_LEVEL + 2.55).toFixed(2)).toBe("3.95");
    expect(TERRAIN_HEIGHT_GLSL).toContain("smoothstep(2.02, 3.95, height)");
    expect(TERRAIN_HEIGHT_GLSL).toContain("atan(local.y, local.x)");
    expect(TERRAIN_HEIGHT_GLSL).toContain("(shaped < shelfPivot) ? plunged : shaped");
    expect(TERRAIN_HEIGHT_GLSL).toContain("smoothstep(245.0, 258.0, max(abs(p.x), abs(p.y)))");
    expect(TERRAIN_HEIGHT_GLSL).toContain("pow(submergedRatio, 0.35)");
    expect(TERRAIN_HEIGHT_GLSL).toContain("vec2(-6.0, -196.0), vec2(112.0, 40.0), 12.9, 10.0, 5.1");
    expect(TERRAIN_HEIGHT_GLSL).toContain("fract(vec3(p.x, p.y, p.x) * 0.1031)");
    expect(TERRAIN_HEIGHT_GLSL).toContain("p3.yzx + vec3(33.33)");
  });

  it("generates the full-screen triangle from gl_VertexID with bottom-left uv", () => {
    expect(FULLSCREEN_TRIANGLE_VERTEX_GLSL).toContain("gl_VertexID");
    expect(FULLSCREEN_TRIANGLE_VERTEX_GLSL).toContain("vUv = vNdc * 0.5 + 0.5;");
    expect(FULLSCREEN_TRIANGLE_VERTEX_GLSL).toContain("#define FULLSCREEN_Z 0.0");
    // Emulate the integer maths for ids 0..2.
    const corners = [0, 1, 2].map((id) => [(id & 1) * 4 - 1, (id & 2) * 2 - 1]);
    expect(corners).toEqual([[-1, -1], [3, -1], [-1, 3]]);
  });
});

describe("composeShaderSource", () => {
  it("puts #version 300 es on the first line, then defines, then highp precision", () => {
    const source = composeShaderSource("fragment", "void main() {}", { REFERENCE_MODE: 1, TILE: "12.0" });
    const lines = source.split("\n");
    expect(lines[0]).toBe(GLSL_VERSION_LINE);
    expect(lines[0]).toBe("#version 300 es");
    expect(lines[1]).toBe("#define REFERENCE_MODE 1");
    expect(lines[2]).toBe("#define TILE 12.0");
    expect(source).toContain(GLSL_PRECISION_PREAMBLE);
    expect(source).toContain("precision highp float;");
    expect(source).toContain("precision highp int;");
    expect(source).toContain("precision highp sampler2D;");
    expect(source.indexOf("#define")).toBeLessThan(source.indexOf("precision highp float;"));
    expect(source.indexOf("precision highp sampler2D;")).toBeLessThan(source.indexOf("void main() {}"));
    expect(source.endsWith("\n")).toBe(true);
  });

  it("applies the same preamble to the vertex stage", () => {
    const source = composeShaderSource("vertex", "void main() { gl_Position = vec4(0.0); }");
    expect(source.startsWith("#version 300 es\n")).toBe(true);
    expect(source).toContain("precision highp float;");
    expect(preambleLineCount()).toBe(source.split("\n").indexOf("void main() { gl_Position = vec4(0.0); }"));
  });

  it("rejects bodies that already carry #version, empty bodies and bad define names", () => {
    expect(() => composeShaderSource("fragment", "#version 300 es\nvoid main() {}")).toThrow(/#version/);
    expect(() => composeShaderSource("fragment", "   ")).toThrow(/为空/);
    expect(() => composeShaderSource("fragment", "void main() {}", { "1BAD": 1 })).toThrow(/不合法/);
    expect(() => composeShaderSource("fragment", "void main() {}", { NAN: Number.NaN })).toThrow(/有限数/);
  });
});

describe("texture format table", () => {
  it("describes every supported format", () => {
    expect(textureFormatInfo("rgba16f")).toMatchObject({ bytesPerTexel: 8, isDepth: false, filterableByDefault: true, needsFloatColorBuffer: true });
    expect(textureFormatInfo("rgba32f")).toMatchObject({ bytesPerTexel: 16, isDepth: false, filterableByDefault: false, needsFloatColorBuffer: true });
    expect(textureFormatInfo("rgba8")).toMatchObject({ bytesPerTexel: 4, isDepth: false, filterableByDefault: true, needsFloatColorBuffer: false });
    expect(textureFormatInfo("srgb8a8")).toMatchObject({ bytesPerTexel: 4, isDepth: false, filterableByDefault: true });
    expect(textureFormatInfo("depth24")).toMatchObject({ bytesPerTexel: 4, isDepth: true, filterableByDefault: false });
    // GL enum sanity: RGBA16F / RGBA32F / DEPTH_COMPONENT24.
    expect(textureFormatInfo("rgba16f").internalFormat).toBe(0x881a);
    expect(textureFormatInfo("rgba32f").internalFormat).toBe(0x8814);
    expect(textureFormatInfo("depth24").internalFormat).toBe(0x81a6);
  });
});

describe("render state presets", () => {
  it("mirror the WebGPU pipelines", () => {
    expect(WATER_STATE).toMatchObject({ depthTest: true, depthWrite: false, depthCompare: "less", blend: "water" });
    expect(COMPUTE_STATE).toMatchObject({ depthTest: false, blend: "none" });
    expect(Object.isFrozen(WATER_STATE)).toBe(true);
  });
});

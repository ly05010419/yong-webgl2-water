import { describe, expect, it } from "vitest";

import { SPECTRAL_CASCADES } from "../src/lib/spectral-ocean";
import { BREAKER_EVENT_RESOLUTION, TERRAIN_FIELD_RESOLUTION } from "../src/lib/water-constants";
import { TETHYS_WATER_LEVEL } from "../src/lib/water-profiles";
import { composeShaderSource } from "../src/lib/webgl2";
import {
  BREAKER_EVENT_FRAGMENT_GLSL,
  TERRAIN_FIELD_FRAGMENT_GLSL,
  WATER_SIMULATION_FRAGMENT_GLSL,
} from "../src/lib/webgl2/simulation-glsl";

// Node has no WebGL2 context, so the pass factories (terrain-field-pass,
// water-simulation-pass, breaker-event-pass) are exercised in the browser by
// the engine. What is testable here is the part that actually decides whether
// the port is faithful: the GLSL text, and the arithmetic it encodes.

const SHADERS: ReadonlyArray<readonly [string, string]> = [
  ["TERRAIN_FIELD_FRAGMENT_GLSL", TERRAIN_FIELD_FRAGMENT_GLSL],
  ["WATER_SIMULATION_FRAGMENT_GLSL", WATER_SIMULATION_FRAGMENT_GLSL],
  ["BREAKER_EVENT_FRAGMENT_GLSL", BREAKER_EVENT_FRAGMENT_GLSL],
];

const WGSL_RESIDUE = [
  "vec2<f32>",
  "vec3<f32>",
  "vec4<f32>",
  "vec2<i32>",
  "vec2<u32>",
  "array<",
  "select(",
  "textureSampleLevel",
  "textureLoad(",
  "textureStore(",
  "textureDimensions(",
  "@builtin",
  "@group",
  "@binding",
  "@compute",
  "workgroup_size",
  "atan2(",
  "f32(",
  "u32(",
  "i32(",
  " -> ",
  ": f32",
  "texture_2d",
  "texture_storage_2d",
] as const;

const WGSL_KEYWORD_LINE = /^\s*(fn|let|var)\s/m;

function stripComments(source: string): string {
  return source.replace(/\/\/.*$/gm, "");
}

function braceBalance(source: string): number {
  const stripped = stripComments(source);
  return (stripped.match(/\{/g) ?? []).length - (stripped.match(/\}/g) ?? []).length;
}

describe("nearshore GLSL passes", () => {
  it.each(SHADERS)("%s is a compilable GLSL body with no WGSL residue", (_name, source) => {
    // Comments are stripped first: the port notes quote the WGSL they replaced
    // ("Replaces textureDimensions(...)", "WGSL returned array<vec3<f32>, 2>"),
    // and that prose is documentation, not leftover syntax.
    const code = stripComments(source);
    for (const residue of WGSL_RESIDUE) expect(code).not.toContain(residue);
    expect(code).not.toMatch(WGSL_KEYWORD_LINE);
    expect(source).not.toContain("#version");
    expect(source).not.toMatch(/precision\s+\w+\s+float/);
    expect(braceBalance(source)).toBe(0);
    expect(() => composeShaderSource("fragment", source)).not.toThrow();
    // Every pass writes a single colour attachment; none of them is MRT.
    expect(source).toContain("layout(location = 0) out vec4 ");
    expect(source).not.toContain("layout(location = 1)");
    expect(source).toContain("layout(std140) uniform WorldUniforms {");
  });

  it("derives the invocation index from gl_FragCoord in every pass", () => {
    expect(TERRAIN_FIELD_FRAGMENT_GLSL).toContain("ivec2 id = ivec2(gl_FragCoord.xy);");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("ivec2 id = ivec2(gl_FragCoord.xy);");
    // The breaker target is 256x1, so only the x lane carries the index (R2).
    expect(BREAKER_EVENT_FRAGMENT_GLSL).toContain("int id = int(gl_FragCoord.x);");
  });
});

describe("terrain field fragment", () => {
  it("replaces textureDimensions with uFieldDims and keeps both of its uses distinct", () => {
    expect(TERRAIN_FIELD_FRAGMENT_GLSL).toContain("uniform ivec2 uFieldDims;");
    // uv spans the closed interval: divide by dims - 1.
    expect(TERRAIN_FIELD_FRAGMENT_GLSL).toContain("vec2 uv = vec2(id) / (dimensions - vec2(1.0));");
    // spacing likewise uses dims.x - 1 (520 / 512), not dims.x.
    expect(TERRAIN_FIELD_FRAGMENT_GLSL).toContain("float spacing = uniforms.terrain.x / float(uFieldDims.x - 1);");
    expect(TERRAIN_FIELD_RESOLUTION + 1).toBe(513);
  });

  it("evaluates terrainHeight five times and central-differences the normal", () => {
    const calls = TERRAIN_FIELD_FRAGMENT_GLSL.match(/= terrainHeight\(/g) ?? [];
    expect(calls).toHaveLength(5);
    expect(TERRAIN_FIELD_FRAGMENT_GLSL).toContain("vec2 p = (uv - vec2(0.5)) * uniforms.terrain.x;");
    expect(TERRAIN_FIELD_FRAGMENT_GLSL).toContain("normalize(vec3(left - right, spacing * 2.0, back - front))");
    expect(TERRAIN_FIELD_FRAGMENT_GLSL).toContain("outField = vec4(height, normal.x, normal.z, 0.0);");
    // shoreMix comes from the shared uniform block, not a pass argument.
    expect(TERRAIN_FIELD_FRAGMENT_GLSL).toContain("uniforms.environment.x");
    // The interpolated dune thresholds ride along with TERRAIN_HEIGHT_GLSL.
    expect(TERRAIN_FIELD_FRAGMENT_GLSL).toContain("smoothstep(2.02, 3.95, height)");
    expect((TETHYS_WATER_LEVEL + 0.62).toFixed(2)).toBe("2.02");
  });
});

describe("water simulation fragment", () => {
  it("declares the SimulationParams block and every sampler the WGSL bound", () => {
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("layout(std140) uniform SimulationParams {");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toMatch(/vec4 impulse;[\s\S]*vec4 stepFoamShift;[\s\S]*\}\s*params;/);
    for (const name of ["previousState", "terrainField", "longField0", "longField1", "mediumField0", "mediumField1"]) {
      expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain(`uniform sampler2D ${name};`);
    }
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("uniform ivec2 uDims;");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("uniform ivec2 uTerrainDims;");
  });

  it("returns a struct from hydrostaticPair instead of an array (R14)", () => {
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("struct HydrostaticPair {");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("HydrostaticPair hydrostaticPair(CellState a, CellState b) {");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("return HydrostaticPair(conservativeState(a, hA), conservativeState(b, hB));");
    // pair[0] / pair[1] became .left / .right at every consumer.
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("eastPair.left.x");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("westPair.right.x");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("northPair.left.x");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("southPair.right.x");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).not.toMatch(/pair\[[01]\]/);
  });

  it("declares helpers before use, as GLSL requires", () => {
    const order = [
      "ivec2 clampedCoord(",
      "vec2 worldPosition(",
      "float terrainAtWorld(",
      "vec4 spectralBoundaryState(",
      "CellState loadCell(",
      "vec3 conservativeState(",
      "vec3 physicalFluxX(",
      "vec3 physicalFluxY(",
      "HydrostaticPair hydrostaticPair(",
      "vec3 rusanovX(",
      "vec3 rusanovY(",
      "float sidePressureCorrection(",
      "void main(",
    ].map((signature) => WATER_SIMULATION_FRAGMENT_GLSL.indexOf(signature));
    order.forEach((index) => expect(index).toBeGreaterThan(-1));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("keeps every select() branch on the correct side of the ternary (R10)", () => {
    // WGSL select(falseValue, trueValue, cond) -> cond ? trueValue : falseValue.
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("result.q = depth <= MIN_DEPTH ? vec2(0.0) : raw.gb;");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain(
      "float scale = cell.depth <= MIN_DEPTH ? 0.0 : reconstructedDepth / max(cell.depth, MIN_DEPTH);",
    );
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("float uLeft = left.x <= MIN_DEPTH ? 0.0 : left.y / max(left.x, MIN_DEPTH);");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("float uRight = right.x <= MIN_DEPTH ? 0.0 : right.y / max(right.x, MIN_DEPTH);");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("float vSouth = south.x <= MIN_DEPTH ? 0.0 : south.z / max(south.x, MIN_DEPTH);");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("float vNorth = north.x <= MIN_DEPTH ? 0.0 : north.z / max(north.x, MIN_DEPTH);");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("vec2 nextQ = nextDepth <= MIN_DEPTH ? vec2(0.0) : next.yz;");
  });

  it("fetches the terrain with nearest semantics and the spectra with linear sampling", () => {
    // round(uv * (terrainDims - 1)) is the NEAREST tap the WGSL used; the
    // breaker pass deliberately reads the same texture with LINEAR instead.
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("ivec2 coord = ivec2(round(uv * vec2(uTerrainDims - ivec2(1))));");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("return texelFetch(terrainField, coord, 0).r;");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("vec4 raw = texelFetch(previousState, coord, 0);");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("float backtracedFoam = textureLod(previousState, backtraceUv, 0.0).a;");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("vec4 long0 = textureLod(longField0, longUv, 0.0) * uniforms.waves.x;");
    // Five stencil fetches through clampedCoord, one filtered foam backtrace.
    expect((WATER_SIMULATION_FRAGMENT_GLSL.match(/loadCell\(coord/g) ?? [])).toHaveLength(5);
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("return clamp(coord, ivec2(0), dimensions - ivec2(1));");
  });

  it("carries the physical constants of the frozen WGSL verbatim", () => {
    const literals = [
      "const float GRAVITY = 9.81;",
      "const float MIN_DEPTH = 0.035;",
      "float manning = 0.018;",
      "max(pow(max(nextDepth, MIN_DEPTH), 1.333333), 0.001)",
      // impulse
      "float radius = max(params.impulse.w, 0.0001);",
      "exp(-impulseDistance * impulseDistance * 3.2)",
      // `pow` with a negative base is undefined; the squared form is exact.
      "float ringOffset = impulseDistance - 0.72;",
      "exp(-(ringOffset * ringOffset) * 18.0)",
      "(impulse - ring * 0.28) * params.impulse.z",
      "vec2(0.0001, 0.0)",
      "ring * params.impulse.z * 1.6",
      // sponge / spectral coupling
      "smoothstep(0.0, 0.085, edgeDistance)",
      "smoothstep(4.8, 9.5, stillDepth) * (1.0 - sponge) * 0.42",
      "min(1.0, dt * (12.0 * sponge + 2.4 * deepWarmup))",
      "0.14 * (longHeight * longHeight - 0.080 * uniforms.waves.y)",
      "0.32 * (mediumHeight * mediumHeight - 0.030 * uniforms.waves.y)",
      "normalize(vec2(0.887, -0.462))",
      "normalize(meanDirection - (long1.rg + medium1.rg) * 0.055)",
      "sqrt(GRAVITY * max(depth, MIN_DEPTH))",
      // foam
      "clamp(uv - velocity * dt / uniforms.simulation.z, vec2(0.002), vec2(0.998))",
      "mix(backtracedFoam, neighbourFoam, min(0.11, dt * 1.4))",
      "smoothstep(0.58, 0.92, froude) * smoothstep(0.03, 0.32, surfaceCompression)",
      "(1.0 - smoothstep(0.16, 1.7, nextDepth)) * smoothstep(0.03, 0.24, speed)",
      "smoothstep(0.115, 0.31, boundary.w) * smoothstep(0.27, 0.76, boundary.x)",
      "(1.0 - smoothstep(0.10, 1.55, nextDepth)) * smoothstep(0.18, 0.64, boundary.x)",
      "foam *= exp(-dt * 0.58);",
      "spectralBirth * 0.48 + breakingBirth * 2.4 + shorelineBirth * 0.52 + shorelineWaveBirth * 1.25",
      "max(foam, ring * abs(params.impulse.z) * 4.0 * params.stepFoamShift.y)",
      // output clamps
      "clamp(eta, -1.8, 1.8)",
      "clamp(nextQ, vec2(-12.0), vec2(12.0))",
      "clamp(foam, 0.0, 1.0)",
      // cellSize divides by dims.x with no -1 (checklist §6.7)
      "float cellSize = uniforms.simulation.z / float(dimensions.x);",
    ];
    for (const literal of literals) expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain(literal);
  });

  it("hard-codes the cascade choppiness the same way the WGSL template did", () => {
    expect(SPECTRAL_CASCADES[0].choppiness.toFixed(2)).toBe("1.18");
    expect(SPECTRAL_CASCADES[1].choppiness.toFixed(2)).toBe("1.05");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("float crossDerivative = long0.a * 1.18 + medium0.a * 1.05;");
    expect(WATER_SIMULATION_FRAGMENT_GLSL).toContain("vec2 horizontalDerivative = long1.ba * 1.18 + medium1.ba * 1.05;");
  });
});

describe("breaker event fragment", () => {
  it("declares the samplers of the WGSL bind group and clamps its history reads", () => {
    for (const name of ["previousEvents", "terrainField", "waterState", "longField0", "longField1", "mediumField0", "mediumField1"]) {
      expect(BREAKER_EVENT_FRAGMENT_GLSL).toContain(`uniform sampler2D ${name};`);
    }
    expect(BREAKER_EVENT_RESOLUTION).toBe(256);
    expect(BREAKER_EVENT_FRAGMENT_GLSL).toContain("texelFetch(previousEvents, ivec2(clamp(coord, 0, 255), 0), 0).r");
    expect(BREAKER_EVENT_FRAGMENT_GLSL).toContain("float uv = (float(id) + 0.5) / 256.0;");
    expect(BREAKER_EVENT_FRAGMENT_GLSL).toContain("if (id >= 256) { discard; }");
    // Terrain and water state go through the clamp/linear fieldSampler here.
    expect(BREAKER_EVENT_FRAGMENT_GLSL).toContain("float bottom = textureLod(terrainField, terrainUv, 0.0).r;");
    expect(BREAKER_EVENT_FRAGMENT_GLSL).toContain(
      "vec4 state = textureLod(waterState, clamp(simulationUv, vec2(0.0), vec2(1.0)), 0.0) * simulationInside;",
    );
    expect(BREAKER_EVENT_FRAGMENT_GLSL).not.toContain("texelFetch(terrainField");
  });

  it("keeps the travelling front, instability thresholds and the 60 Hz blend", () => {
    const literals = [
      "float travellingPhase = time * 2.4 + 12.0;",
      "return travellingPhase - floor(travellingPhase / 72.0) * 72.0 - 36.0;",
      "float along = mix(-180.0, 180.0, uv);",
      "vec2 travelDirection = normalize(vec2(0.887, -0.462));",
      "vec2 tangentDirection = vec2(-travelDirection.y, travelDirection.x);",
      "sin(along * 0.055 + time * 0.055 + 0.7) * 3.8",
      "sin(along * 0.14 - time * 0.032 - 1.3) * 1.2",
      "float dynamicDepth = max(stillDepth + state.r, 0.035);",
      "float froude = speed / max(sqrt(9.81 * dynamicDepth), 0.001);",
      "smoothstep(0.035, 0.160, compression)",
      "mix(0.34, 1.0, smoothstep(0.045, 0.205, slope))",
      "abs(state.r) / max(dynamicDepth, 0.12)",
      "(1.0 - smoothstep(2.2, 6.0, dynamicDepth))",
      "max(smoothstep(0.46, 0.86, froude), smoothstep(0.38, 0.76, depthRatio))",
      "float crossDerivative = long0.a * 1.18 + medium0.a * 1.05;",
      "vec2 horizontalDerivative = long1.ba * 1.18 + medium1.ba * 1.05;",
      "float history = center * 0.50 + eventHistory(id - 1) * 0.25 + eventHistory(id + 1) * 0.25;",
      // select(0.62, 7.5, target > history): true branch is the fast attack.
      "float rate = targetInstability > history ? 7.5 : 0.62;",
      // 60 is hard-coded in the WGSL; it is not the timestep.
      "float blend = 1.0 - exp(-rate / 60.0);",
      "outEvent = vec4(activation, spectralInstability, nearshoreInstability, compression);",
    ];
    for (const literal of literals) expect(BREAKER_EVENT_FRAGMENT_GLSL).toContain(literal);
  });
});

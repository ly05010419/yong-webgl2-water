import { describe, expect, it } from "vitest";

import { SPECTRAL_LOG_SIZE, SPECTRAL_RESOLUTION } from "../src/lib/spectral-ocean";
import { composeShaderSource } from "../src/lib/webgl2";
import {
  SPECTRAL_IFFT_FRAGMENT_GLSL,
  SPECTRAL_IFFT_SAMPLERS,
  SPECTRUM_EVOLUTION_FRAGMENT_GLSL,
  SPECTRUM_EVOLUTION_SAMPLERS,
  spectralAtlasPassSchedule,
  spectralIfftPassSchedule,
  type SpectralAtlasGatherDraw,
  type SpectralAtlasStackedDraw,
} from "../src/lib/webgl2/spectral-glsl";

const CASCADE_COUNT = 3;

/**
 * Minimal `#ifndef` / `#if X == n` / `#else` / `#endif` evaluator — just enough
 * for the two integer defines the spectral shaders branch on. It exists so the
 * index conventions of every compiled variant can be asserted as text: the
 * whole bit-identity argument for the atlas layout rests on those branches
 * changing integer indexing and nothing else.
 */
function preprocess(source: string, defines: Readonly<Record<string, number>>): string {
  const values = new Map<string, number>(Object.entries(defines));
  const output: string[] = [];
  const stack: boolean[] = [];
  const active = (): boolean => stack.every(Boolean);
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    const ifndef = /^#ifndef\s+(\w+)$/.exec(trimmed);
    const ifEqual = /^#if\s+(\w+)\s*==\s*(-?\d+)$/.exec(trimmed);
    const define = /^#define\s+(\w+)\s+(-?\d+)$/.exec(trimmed);
    if (ifndef) { stack.push(!values.has(ifndef[1])); continue; }
    if (ifEqual) { stack.push(values.get(ifEqual[1]) === Number(ifEqual[2])); continue; }
    if (trimmed === "#else") { stack[stack.length - 1] = !stack[stack.length - 1]; continue; }
    if (trimmed === "#endif") { stack.pop(); continue; }
    if (define) { if (active()) values.set(define[1], Number(define[2])); continue; }
    // `composeShaderSource` prepends `#version`; it is not a conditional and is
    // emitted verbatim so a composed source can be expanded too.
    if (trimmed.startsWith("#version")) { if (active()) output.push(line); continue; }
    if (trimmed.startsWith("#")) throw new Error(`unsupported preprocessor directive: ${trimmed}`);
    if (active()) output.push(line);
  }
  if (stack.length !== 0) throw new Error("unbalanced #if in shader source");
  return output.join("\n");
}

/** One compiled inverse-FFT variant, expanded. */
function ifftVariant(axis: 0 | 1, gather: 0 | 1): string {
  return preprocess(SPECTRAL_IFFT_FRAGMENT_GLSL, {
    FFT_AXIS: axis,
    SPECTRAL_GATHER: gather,
    SPECTRAL_CASCADE_COUNT: CASCADE_COUNT,
  });
}

const IFFT_VARIANTS: ReadonlyArray<readonly [string, 0 | 1, 0 | 1]> = [
  ["atlas · axis 0", 0, 0],
  ["atlas · axis 1", 1, 0],
  ["gather · axis 0", 0, 1],
  ["gather · axis 1", 1, 1],
];

// Only pure artefacts are testable in node: the GLSL text of the two spectral
// compute ports and the inverse-FFT pass schedule. The GL side (programs,
// framebuffers, draws) needs a real WebGL2 context and is covered by the
// browser visual gate.

const SPECTRAL_FRAGMENTS: ReadonlyArray<readonly [string, string]> = [
  ["SPECTRUM_EVOLUTION_FRAGMENT_GLSL", SPECTRUM_EVOLUTION_FRAGMENT_GLSL],
  ["SPECTRAL_IFFT_FRAGMENT_GLSL", SPECTRAL_IFFT_FRAGMENT_GLSL],
];

const WGSL_RESIDUE = [
  "vec2<f32>",
  "vec3<f32>",
  "vec4<f32>",
  "select(",
  "textureLoad",
  "textureStore",
  "textureSampleLevel",
  "textureDimensions",
  "@builtin",
  "@group",
  "@binding",
  "@compute",
  "@workgroup_size",
  "fn ",
  "let ",
  "var<",
] as const;

function stripComments(source: string): string {
  return source.replace(/\/\/.*$/gm, "");
}

describe("spectral GLSL", () => {
  it.each(SPECTRAL_FRAGMENTS)("%s carries no WGSL residue", (_name, source) => {
    for (const residue of WGSL_RESIDUE) expect(source).not.toContain(residue);
    expect(source).not.toContain("#version");
    expect(source).not.toMatch(/precision\s+\w+\s+float/);
  });

  it.each(SPECTRAL_FRAGMENTS)("%s declares the MRT pair and reads by texelFetch", (_name, source) => {
    expect(source).toContain("layout(location = 0) out vec4 outField0;");
    expect(source).toContain("layout(location = 1) out vec4 outField1;");
    expect(source).toContain("outField0 =");
    expect(source).toContain("outField1 =");
    expect(source).toContain("texelFetch(");
    expect(source).not.toContain("texture(");
    expect(source).toContain("ivec2 id = ivec2(gl_FragCoord.xy);");
  });

  it.each(SPECTRAL_FRAGMENTS)("%s composes into a valid GLSL ES 3.00 source", (_name, source) => {
    const composed = composeShaderSource("fragment", source, { FFT_AXIS: 0 });
    expect(composed.startsWith("#version 300 es\n")).toBe(true);
    expect(composed).toContain("#define FFT_AXIS 0");
    expect(composed).toContain("precision highp float;");
    const stripped = stripComments(composed);
    expect((stripped.match(/\{/g) ?? []).length).toBe((stripped.match(/\}/g) ?? []).length);
  });

  it("keeps the evolution shader identical to the WGSL packing", () => {
    const source = SPECTRUM_EVOLUTION_FRAGMENT_GLSL;
    expect(source).toContain("float phase = wave.w * uniforms.cameraTime.w;");
    expect(source).toContain("vec2 exponent = vec2(cos(phase), sin(phase));");
    expect(source).toContain(
      "vec2 h = complexMultiply(initial.xy, exponent) + complexMultiply(initial.zw, vec2(exponent.x, -exponent.y));",
    );
    expect(source).toContain("vec2 ih = vec2(-h.y, h.x);");
    expect(source).toContain("outField0 = vec4(dxDz, dyDxz);");
    expect(source).toContain("outField1 = vec4(dyxDyz, dxxDzz);");
    for (const sampler of SPECTRUM_EVOLUTION_SAMPLERS) expect(source).toContain(`uniform sampler2D ${sampler};`);
  });

  it("keeps the inverse FFT shader unnormalised, conjugated and checkerboarded", () => {
    const source = SPECTRAL_IFFT_FRAGMENT_GLSL;
    expect(source).toContain("vec2 inverseTwiddle = vec2(data.x, -data.y);");
    // Cascade-local row, so the sign pattern of a stacked cascade is the same
    // one it had on its own. The constants are the WGSL's, unchanged.
    expect(source).toContain("float checker = 1.0 - 2.0 * float((id.x + localRow) % 2);");
    expect(source).toContain("vec4 butterfly(vec4 a, vec4 b, vec2 twiddle) {");
    expect(source).toContain("return vec4(a.xy + complexMultiply(twiddle, b.xy), a.zw + complexMultiply(twiddle, b.zw));");
    expect(source).toContain("int first = int(round(data.z));");
    expect(source).toContain("int second = int(round(data.w));");
    // No 1/N normalisation anywhere: amplitude is baked into the CPU spectrum.
    expect(source).not.toMatch(/\/\s*float\(uSize\)/);
    expect(source).not.toContain("0.0078125");
    for (const sampler of SPECTRAL_IFFT_SAMPLERS) expect(source).toContain(`uniform sampler2D ${sampler};`);
    for (const name of ["uStage", "uSize", "uFinalize"]) expect(source).toContain(`uniform int ${name};`);
  });

  it("branches on the axis at compile time, not at runtime", () => {
    expect(SPECTRAL_IFFT_FRAGMENT_GLSL).toContain("#if FFT_AXIS == 0");
    expect(SPECTRAL_IFFT_FRAGMENT_GLSL).toContain("#ifndef FFT_AXIS");
    expect(SPECTRAL_IFFT_FRAGMENT_GLSL).not.toContain("uniform int uAxis");
    for (const axis of [0, 1] as const) {
      expect(composeShaderSource("fragment", SPECTRAL_IFFT_FRAGMENT_GLSL, { FFT_AXIS: axis })).toContain(`#define FFT_AXIS ${axis}`);
    }
  });

  it("branches on the cascade layout at compile time too, defaulting to one cascade per texture", () => {
    expect(SPECTRAL_IFFT_FRAGMENT_GLSL).toContain("#ifndef SPECTRAL_GATHER");
    expect(SPECTRAL_IFFT_FRAGMENT_GLSL).toContain("#define SPECTRAL_GATHER 1");
    expect(SPECTRAL_IFFT_FRAGMENT_GLSL).toContain("#ifndef SPECTRAL_CASCADE_COUNT");
    expect(SPECTRAL_IFFT_FRAGMENT_GLSL).toContain("#define SPECTRAL_CASCADE_COUNT 1");
    expect(SPECTRAL_IFFT_FRAGMENT_GLSL).toContain("uniform int uCascade;");
    expect(SPECTRAL_IFFT_FRAGMENT_GLSL).not.toContain("uniform int uLayout");
    // The undefined-macro default must be the per-cascade variant, so a caller
    // that forgets the define gets the original shader rather than atlas
    // indexing against a 128-row texture.
    expect(preprocess(SPECTRAL_IFFT_FRAGMENT_GLSL, { FFT_AXIS: 1 })).toContain("int cascadeBase = uCascade * uSize;");
  });

  it("gathers one cascade per draw with a uniform row block", () => {
    for (const axis of [0, 1] as const) {
      const variant = ifftVariant(axis, 1);
      expect(variant).toContain("uniform int uCascade;");
      expect(variant).toContain("if (id.x >= uSize || id.y >= uSize) { discard; }");
      expect(variant).toContain("int cascadeBase = uCascade * uSize;");
      // The fragment's own row *is* the cascade-local row here, so `uCascade`
      // at 0 reduces every index below to the pre-atlas 128×128 shader.
      expect(variant).toContain("int localRow = id.y;");
    }
    expect(ifftVariant(0, 1)).toContain("int transformIndex = id.x;");
    expect(ifftVariant(1, 1)).toContain("int transformIndex = localRow;");
  });

  it("reads the cascade off the row in the atlas variant and never touches uCascade", () => {
    for (const axis of [0, 1] as const) {
      const variant = ifftVariant(axis, 0);
      expect(variant).not.toContain("uCascade");
      expect(variant).toContain("if (id.x >= uSize || id.y >= uSize * SPECTRAL_CASCADE_COUNT) { discard; }");
      expect(variant).toContain("int cascadeBase = (id.y / uSize) * uSize;");
      expect(variant).toContain("int localRow = id.y - cascadeBase;");
    }
    // Horizontal stages are cascade-private by construction: rows never mix, so
    // only the column index moves. Vertical ones offset both butterfly rows by
    // the cascade's block — the single indexing change the atlas needs.
    expect(ifftVariant(0, 0)).toContain("int transformIndex = id.x;");
    expect(ifftVariant(0, 0)).toContain("  coord0.x = first;\n  coord1.x = second;");
    expect(ifftVariant(1, 0)).toContain("int transformIndex = localRow;");
    expect(ifftVariant(1, 0)).toContain("  coord0.y = cascadeBase + first;\n  coord1.y = cascadeBase + second;");
  });

  it.each(IFFT_VARIANTS)("%s runs the same arithmetic as every other variant", (_name, axis, gather) => {
    const variant = ifftVariant(axis, gather);
    // Everything that touches a float is outside the layout branches, in one
    // order, in all four variants. That — not a tolerance — is why the atlas
    // and per-cascade layouts agree bit for bit.
    for (const line of [
      "  vec4 data = texelFetch(twiddleTable, ivec2(transformIndex, uStage), 0);",
      "  int first = int(round(data.z));",
      "  int second = int(round(data.w));",
      "  ivec2 coord0 = ivec2(id.x, cascadeBase + localRow);",
      "  ivec2 coord1 = coord0;",
      "  vec2 inverseTwiddle = vec2(data.x, -data.y);",
      "  vec4 value0 = butterfly(texelFetch(input0, coord0, 0), texelFetch(input0, coord1, 0), inverseTwiddle);",
      "  vec4 value1 = butterfly(texelFetch(input1, coord0, 0), texelFetch(input1, coord1, 0), inverseTwiddle);",
      "  if (uFinalize == 1) {",
      "    float checker = 1.0 - 2.0 * float((id.x + localRow) % 2);",
      "    value0 *= checker;",
      "    value1 *= checker;",
      "  outField0 = value0;",
      "  outField1 = value1;",
    ]) expect(variant).toContain(line);
    expect(variant).not.toMatch(/\/\s*float\(uSize\)/);
  });

  it.each(IFFT_VARIANTS)("%s composes into a valid GLSL ES 3.00 source", (_name, axis, gather) => {
    const composed = composeShaderSource("fragment", SPECTRAL_IFFT_FRAGMENT_GLSL, {
      FFT_AXIS: axis,
      SPECTRAL_GATHER: gather,
      SPECTRAL_CASCADE_COUNT: CASCADE_COUNT,
    });
    expect(composed).toContain(`#define SPECTRAL_GATHER ${gather}`);
    expect(composed).toContain(`#define SPECTRAL_CASCADE_COUNT ${CASCADE_COUNT}`);
    const stripped = stripComments(preprocess(composed, { FFT_AXIS: axis, SPECTRAL_GATHER: gather, SPECTRAL_CASCADE_COUNT: CASCADE_COUNT }));
    expect((stripped.match(/\{/g) ?? []).length).toBe((stripped.match(/\}/g) ?? []).length);
  });
});

describe("spectralIfftPassSchedule", () => {
  const schedule = spectralIfftPassSchedule(SPECTRAL_LOG_SIZE);

  it("has one pass per stage per axis", () => {
    expect(SPECTRAL_LOG_SIZE).toBe(7);
    expect(SPECTRAL_RESOLUTION).toBe(128);
    expect(schedule).toHaveLength(14);
  });

  it("matches the frozen (axis, stage, finalize) sequence", () => {
    const encoded = schedule.map((pass) => `${pass.axis}${pass.stage}${pass.finalize}`);
    expect(encoded).toEqual(["000", "010", "020", "030", "040", "050", "060", "100", "110", "120", "130", "140", "150", "161"]);
  });

  it("reads slot pass % 2 and writes the other slot", () => {
    schedule.forEach((pass, index) => {
      expect(pass.sourceIndex).toBe(index % 2);
      expect(pass.destinationIndex).toBe(1 - (index % 2));
      expect(pass.sourceIndex).not.toBe(pass.destinationIndex);
    });
  });

  it("finalizes exactly once, on the last pass, landing back in slot 0", () => {
    const finalizing = schedule.filter((pass) => pass.finalize === 1);
    expect(finalizing).toHaveLength(1);
    const last = schedule[schedule.length - 1];
    expect(last.finalize).toBe(1);
    expect(last.axis).toBe(1);
    expect(last.stage).toBe(SPECTRAL_LOG_SIZE - 1);
    expect(last.destinationIndex).toBe(0);
  });

  it("is frozen and rejects invalid sizes", () => {
    expect(Object.isFrozen(schedule)).toBe(true);
    expect(Object.isFrozen(schedule[0])).toBe(true);
    for (const bad of [0, -1, 2.5, Number.NaN]) expect(() => spectralIfftPassSchedule(bad)).toThrow(/正整数/);
  });
});


describe("spectralAtlasPassSchedule", () => {
  const passes = spectralIfftPassSchedule(SPECTRAL_LOG_SIZE);
  const schedule = spectralAtlasPassSchedule(SPECTRAL_LOG_SIZE, CASCADE_COUNT);
  // `kind` is the discriminant of the draw union, so these predicates are what
  // gives each arm its own fields — a stacked draw has `destinationIndex` and
  // no `cascade`, a gather draw the reverse.
  const stackedDraws = schedule.filter((draw): draw is SpectralAtlasStackedDraw => draw.kind === "atlas");
  const gatherDraws = schedule.filter((draw): draw is SpectralAtlasGatherDraw => draw.kind === "gather");

  it("collapses 42 per-cascade passes into 16 draws", () => {
    // 13 stacked stages + one closing draw per cascade. With the single
    // evolution draw that is 17 draws a frame against the old 3 × (1 + 14) = 45
    // (docs/webgl2-port/spec-compute.md R17).
    expect(schedule).toHaveLength(passes.length - 1 + CASCADE_COUNT);
    expect(schedule).toHaveLength(16);
    expect(1 + schedule.length).toBe(17);
    expect(stackedDraws).toHaveLength(13);
    expect(gatherDraws).toHaveLength(CASCADE_COUNT);
  });

  it("keeps the frozen (axis, stage) sequence and ping-pong of the per-cascade schedule", () => {
    stackedDraws.forEach((draw, index) => {
      const pass = passes[index];
      expect(draw.axis).toBe(pass.axis);
      expect(draw.stage).toBe(pass.stage);
      expect(draw.sourceIndex).toBe(pass.sourceIndex);
      expect(draw.destinationIndex).toBe(pass.destinationIndex);
      expect(draw.sourceIndex).toBe(index % 2);
      // A stacked stage advances every cascade at once, so it names none:
      // the union has no `cascade` arm to fall back on.
      expect(draw).not.toHaveProperty("cascade");
    });
  });

  it("writes back once per cascade, from the last pass's source slot", () => {
    const last = passes[passes.length - 1];
    expect(gatherDraws.map((draw) => draw.cascade)).toEqual([0, 1, 2]);
    for (const draw of gatherDraws) {
      expect(draw.axis).toBe(last.axis);
      expect(draw.axis).toBe(1);
      expect(draw.stage).toBe(last.stage);
      expect(draw.stage).toBe(SPECTRAL_LOG_SIZE - 1);
      expect(draw.sourceIndex).toBe(last.sourceIndex);
      expect(draw.sourceIndex).toBe(1);
      // The final field pair is its own texture, not an atlas slot.
      expect(draw).not.toHaveProperty("destinationIndex");
    }
    // Every write-back reads the same atlas slot, so the three draws are
    // independent and the stacked stages never have to run twice.
    expect(new Set(gatherDraws.map((draw) => draw.sourceIndex)).size).toBe(1);
  });

  it("checkerboards only on the closing stage", () => {
    const finalizing = schedule.filter((draw) => draw.finalize === 1);
    expect(finalizing).toHaveLength(CASCADE_COUNT);
    for (const draw of finalizing) expect(draw.kind).toBe("gather");
    for (const draw of stackedDraws) expect(draw.finalize).toBe(0);
  });

  it("is frozen and rejects invalid sizes", () => {
    expect(Object.isFrozen(schedule)).toBe(true);
    expect(Object.isFrozen(schedule[0])).toBe(true);
    expect(Object.isFrozen(schedule[schedule.length - 1])).toBe(true);
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      expect(() => spectralAtlasPassSchedule(SPECTRAL_LOG_SIZE, bad)).toThrow(/正整数/);
      expect(() => spectralAtlasPassSchedule(bad, CASCADE_COUNT)).toThrow(/正整数/);
    }
  });

  it("degenerates to the per-cascade schedule for a single cascade", () => {
    const single = spectralAtlasPassSchedule(SPECTRAL_LOG_SIZE, 1);
    expect(single).toHaveLength(passes.length);
    expect(single.map((draw) => `${draw.axis}${draw.stage}${draw.finalize}`)).toEqual(
      passes.map((pass) => `${pass.axis}${pass.stage}${pass.finalize}`),
    );
  });
});

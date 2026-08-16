// GLSL ES 3.00 ports of the two spectral-ocean compute shaders: the per-frame
// spectrum evolution and one stage of the Stockham autosort inverse FFT.
//
// Both are line-by-line transcriptions of the frozen WGSL
// (`webgpu-water-engine.ts@7dbf39c` 634-724). Nothing is reordered,
// nothing is folded, no normalisation is introduced -- the wave field only
// matches the WebGPU backend while the arithmetic stays identical.
//
// Translation rules applied (docs/webgl2-port/contract.md §3.3):
// - compute invocation id -> `ivec2(gl_FragCoord.xy)` (texel centres are +0.5,
//   so truncation yields the texel index);
// - storage-texture writes -> MRT outputs `outField0` / `outField1`;
// - `textureDimensions()` -> `uniform ivec2 uFieldDims` / `uniform int uSize`;
// - integer texture reads -> `texelFetch` (rgba32f inputs are NEAREST-only and
//   are bound with a null sampler object);
// - the WGSL `axis` branch -> two program variants via `#define FFT_AXIS 0|1`,
//   with `stage` / `finalize` staying ordinary `uniform int` (docs/webgl2-port/spec-compute.md R9).
//
// A second `#define` axis, `SPECTRAL_GATHER`, selects how a fragment finds its
// cascade: one cascade per texture, or three stacked in a 128 x 384 atlas
// (docs/webgl2-port/spec-compute.md R17). It changes integer indexing only --
// every float operation, in every variant, stays in the order above.

import { WORLD_UNIFORMS_GLSL } from "./shared-glsl";

/**
 * Spectrum evolution (WGSL `evolveSpectrum`, engine:634-672).
 *
 * Reads the static `initialSpectrum` (h0(k), h0(-k)*) and `waveData`
 * (kx, 1/|k|, kz, omega) rgba32f tables, advances every mode by
 * `omega * uniforms.cameraTime.w`, and packs eight real derivative fields into
 * four complex ones so a pair of complex IFFTs recovers all of them.
 *
 * Target: the cascade's field ping-pong at index 0 (MRT pair, both rgba16f).
 * Uniform block `WorldUniforms` at binding 0 supplies the time.
 */
export const SPECTRUM_EVOLUTION_FRAGMENT_GLSL = /* glsl */ `
${WORLD_UNIFORMS_GLSL}
uniform sampler2D initialSpectrum;
uniform sampler2D waveData;
// Stands in for the WGSL field-dimensions query: (128, 128) per cascade, or
// (128, 128 · cascadeCount) when the three cascades share one atlas. Only the
// bounds check reads it, so the arithmetic is the same either way.
uniform ivec2 uFieldDims;

layout(location = 0) out vec4 outField0;
layout(location = 1) out vec4 outField1;

vec2 complexMultiply(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  if (id.x >= uFieldDims.x || id.y >= uFieldDims.y) { discard; }
  ivec2 coord = id;
  vec4 initial = texelFetch(initialSpectrum, coord, 0);
  vec4 wave = texelFetch(waveData, coord, 0);
  float phase = wave.w * uniforms.cameraTime.w;
  vec2 exponent = vec2(cos(phase), sin(phase));
  vec2 h = complexMultiply(initial.xy, exponent) + complexMultiply(initial.zw, vec2(exponent.x, -exponent.y));
  vec2 ih = vec2(-h.y, h.x);
  vec2 displacementX = ih * wave.x * wave.y;
  vec2 displacementY = h;
  vec2 displacementZ = ih * wave.z * wave.y;
  vec2 displacementXdx = -h * wave.x * wave.x * wave.y;
  vec2 displacementYdx = ih * wave.x;
  vec2 displacementZdx = -h * wave.x * wave.z * wave.y;
  vec2 displacementYdz = ih * wave.z;
  vec2 displacementZdz = -h * wave.z * wave.z * wave.y;
  vec2 dxDz = vec2(displacementX.x - displacementZ.y, displacementX.y + displacementZ.x);
  vec2 dyDxz = vec2(displacementY.x - displacementZdx.y, displacementY.y + displacementZdx.x);
  vec2 dyxDyz = vec2(displacementYdx.x - displacementYdz.y, displacementYdx.y + displacementYdz.x);
  vec2 dxxDzz = vec2(displacementXdx.x - displacementZdz.y, displacementXdx.y + displacementZdz.x);
  outField0 = vec4(dxDz, dyDxz);
  outField1 = vec4(dyxDyz, dxxDzz);
}
`;

/**
 * One inverse-FFT stage (WGSL `inverseFftStage`, engine:674-724).
 *
 * Radix-2 Stockham autosort, decimation in time, out of place: every output
 * texel performs its own butterfly, so no bit-reversal pass and no workgroup
 * memory are involved. Each rgba texel carries two complex numbers (xy and zw),
 * which is why one draw transforms two packed fields at once.
 *
 * Compile with `defines: { FFT_AXIS: 0 }` for the seven horizontal passes and
 * `{ FFT_AXIS: 1 }` for the seven vertical ones. `uStage` selects the twiddle
 * row, `uFinalize` enables the closing checkerboard sign flip (the fftshift
 * matching a spectrum whose origin sits at the texture centre).
 *
 * `SPECTRAL_GATHER` picks the *index convention* only — the butterfly itself is
 * one body of code shared by both cascade layouts (docs/webgl2-port/spec-compute.md R17):
 * - `SPECTRAL_GATHER 1` (**gather**): source and target hold one cascade each,
 *   `uCascade` names the block of source rows this draw reads. With `uCascade`
 *   at its default 0 this is byte-for-byte the per-cascade 128×128 shader.
 * - `SPECTRAL_GATHER 0` (**atlas**): source and target are the same
 *   128 × (128·`SPECTRAL_CASCADE_COUNT`) stack and the cascade a fragment
 *   belongs to is read off its own row, so one draw advances all three.
 *
 * Either way every texel runs the identical sequence of float operations on the
 * identical `texelFetch` results, which is what keeps the two layouts
 * bit-identical rather than merely close.
 *
 * There is deliberately **no 1/N normalisation**: the amplitude is baked into
 * the CPU-side spectrum, exactly as in the WebGPU backend.
 */
export const SPECTRAL_IFFT_FRAGMENT_GLSL = /* glsl */ `
#ifndef FFT_AXIS
#define FFT_AXIS 0
#endif
// Index convention; see the doc comment above. The default reproduces the
// original one-cascade-per-texture behaviour.
#ifndef SPECTRAL_GATHER
#define SPECTRAL_GATHER 1
#endif
#ifndef SPECTRAL_CASCADE_COUNT
#define SPECTRAL_CASCADE_COUNT 1
#endif

uniform sampler2D twiddleTable;
uniform sampler2D input0;
uniform sampler2D input1;
// params.stage / params.size / params.finalize of the WGSL uniform block.
uniform int uStage;
uniform int uSize;
uniform int uFinalize;
#if SPECTRAL_GATHER == 1
// Which 128-row block of the source belongs to this draw's cascade. Always 0
// for the per-cascade layout, where the source holds a single cascade already.
uniform int uCascade;
#endif

layout(location = 0) out vec4 outField0;
layout(location = 1) out vec4 outField1;

vec2 complexMultiply(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

vec4 butterfly(vec4 a, vec4 b, vec2 twiddle) {
  return vec4(a.xy + complexMultiply(twiddle, b.xy), a.zw + complexMultiply(twiddle, b.zw));
}

void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
#if SPECTRAL_GATHER == 1
  if (id.x >= uSize || id.y >= uSize) { discard; }
  int cascadeBase = uCascade * uSize;
  int localRow = id.y;
#else
  if (id.x >= uSize || id.y >= uSize * SPECTRAL_CASCADE_COUNT) { discard; }
  int cascadeBase = (id.y / uSize) * uSize;
  int localRow = id.y - cascadeBase;
#endif
#if FFT_AXIS == 0
  int transformIndex = id.x;
#else
  int transformIndex = localRow;
#endif
  vec4 data = texelFetch(twiddleTable, ivec2(transformIndex, uStage), 0);
  int first = int(round(data.z));
  int second = int(round(data.w));
  ivec2 coord0 = ivec2(id.x, cascadeBase + localRow);
  ivec2 coord1 = coord0;
#if FFT_AXIS == 0
  coord0.x = first;
  coord1.x = second;
#else
  coord0.y = cascadeBase + first;
  coord1.y = cascadeBase + second;
#endif
  // Conjugated twiddle -- the single marker that this is the inverse transform.
  vec2 inverseTwiddle = vec2(data.x, -data.y);
  vec4 value0 = butterfly(texelFetch(input0, coord0, 0), texelFetch(input0, coord1, 0), inverseTwiddle);
  vec4 value1 = butterfly(texelFetch(input1, coord0, 0), texelFetch(input1, coord1, 0), inverseTwiddle);
  if (uFinalize == 1) {
    // Cascade-local row: in the atlas the checkerboard must not shift with the
    // block offset. (128 is even, so both spellings agree -- the local row is
    // the one that is right by construction.)
    float checker = 1.0 - 2.0 * float((id.x + localRow) % 2);
    value0 *= checker;
    value1 *= checker;
  }
  outField0 = value0;
  outField1 = value1;
}
`;

/** Sampler uniform names of the evolution shader, in texture-unit order. */
export const SPECTRUM_EVOLUTION_SAMPLERS = ["initialSpectrum", "waveData"] as const;

/** Sampler uniform names of the inverse-FFT shader, in texture-unit order. */
export const SPECTRAL_IFFT_SAMPLERS = ["twiddleTable", "input0", "input1"] as const;

/** One scheduled inverse-FFT draw: shader variant plus ping-pong indices. */
export interface SpectralIfftPass {
  /** 0 = transform along x (rows), 1 = along y (columns). Picks the program variant. */
  readonly axis: 0 | 1;
  /** Twiddle-table row, `pass % logSize`. */
  readonly stage: number;
  /** 1 only on the very last pass, where the checkerboard sign flip happens. */
  readonly finalize: 0 | 1;
  /** Ping-pong slot read by this pass (`pass % 2`). */
  readonly sourceIndex: 0 | 1;
  /** Ping-pong slot written by this pass (`1 - pass % 2`). */
  readonly destinationIndex: 0 | 1;
}

/**
 * The fixed `logSize * 2` pass schedule of the inverse FFT, mirroring the
 * WebGPU parameter buffers (engine:1996-2000) and bind groups (engine:2025-2036):
 * `(0,0)(0,1)…(0,6)(1,0)…(1,5)(1,6 finalize)`, reading slot `pass % 2` and
 * writing `1 - pass % 2`. The last pass index is always odd, so the final
 * result always lands in slot 0 -- which is what every downstream pass binds.
 *
 * Pure function; the cascade set evaluates it once at construction.
 */
export function spectralIfftPassSchedule(logSize: number): readonly SpectralIfftPass[] {
  if (!Number.isInteger(logSize) || logSize <= 0) {
    throw new Error(`谱逆 FFT 的级数 logSize 必须是正整数，收到 ${logSize}。`);
  }
  const total = logSize * 2;
  const passes = Array.from({ length: total }, (_unused, pass): SpectralIfftPass => {
    const sourceIndex: 0 | 1 = pass % 2 === 0 ? 0 : 1;
    const entry: SpectralIfftPass = {
      axis: pass < logSize ? 0 : 1,
      stage: pass % logSize,
      finalize: pass === total - 1 ? 1 : 0,
      sourceIndex,
      destinationIndex: sourceIndex === 0 ? 1 : 0,
    };
    return Object.freeze(entry);
  });
  return Object.freeze(passes);
}

/**
 * What both kinds of atlas-layout draw carry.
 *
 * The two kinds differ in how they address their cascades:
 * - `atlas` — source and target are both the 128 × (128·cascadeCount) stack;
 *   one draw advances every cascade.
 * - `gather` — the target is one cascade's own 128×128 field pair and
 *   `cascade` selects the block of source rows to read.
 */
interface SpectralAtlasDrawBase {
  /** 0 = transform along x (rows), 1 = along y (columns). Picks the program variant. */
  readonly axis: 0 | 1;
  /** Twiddle-table row, `pass % logSize`. */
  readonly stage: number;
  /** 1 only on the closing `gather` draws, where the checkerboard sign flip happens. */
  readonly finalize: 0 | 1;
  /** Atlas ping-pong slot read by this draw. */
  readonly sourceIndex: 0 | 1;
}

/** A stacked stage: reads one atlas slot, writes the other, for every cascade at once. */
export interface SpectralAtlasStackedDraw extends SpectralAtlasDrawBase {
  readonly kind: "atlas";
  /** Atlas ping-pong slot written by this draw. */
  readonly destinationIndex: 0 | 1;
}

/** A closing stage: reads one cascade's row block, writes that cascade's own field pair. */
export interface SpectralAtlasGatherDraw extends SpectralAtlasDrawBase {
  readonly kind: "gather";
  /** Target cascade — both the source row block and the destination field pair. */
  readonly cascade: number;
}

/**
 * One scheduled draw of the atlas layout, as a discriminated union: a stacked
 * stage names an atlas slot and never a cascade, a closing draw names a cascade
 * and never a slot. Keeping them apart is what lets `spectral-atlas.ts` pick a
 * target without a fallback for a field that "cannot" be absent.
 */
export type SpectralAtlasDraw = SpectralAtlasStackedDraw | SpectralAtlasGatherDraw;

/** The discriminant of `SpectralAtlasDraw`; derived, so it cannot drift from it. */
export type SpectralAtlasDrawKind = SpectralAtlasDraw["kind"];

/**
 * The atlas-layout draw list: the same `spectralIfftPassSchedule` sequence, with
 * every pass but the last run once over the whole stack, and the last one
 * expanded into one `gather` draw per cascade that writes the final 128×128
 * field pair every downstream pass samples.
 *
 * `logSize·2 - 1 + cascadeCount` draws (16 for 7 and 3) instead of
 * `cascadeCount · logSize · 2` (42) — see docs/webgl2-port/spec-compute.md R17.
 * Splitting the last pass rather than adding a copy keeps the draw count at the
 * minimum *and* keeps the per-texel arithmetic identical to the per-cascade
 * layout: the checkerboard-finalising butterfly simply writes somewhere else.
 *
 * Pure function; the cascade set evaluates it once at construction.
 */
export function spectralAtlasPassSchedule(logSize: number, cascadeCount: number): readonly SpectralAtlasDraw[] {
  if (!Number.isInteger(cascadeCount) || cascadeCount <= 0) {
    throw new Error(`谱级联数量 cascadeCount 必须是正整数，收到 ${cascadeCount}。`);
  }
  const passes = spectralIfftPassSchedule(logSize);
  const last = passes.length - 1;
  const draws = passes.flatMap((pass, index): SpectralAtlasDraw[] => {
    if (index < last) {
      return [{
        kind: "atlas",
        axis: pass.axis,
        stage: pass.stage,
        finalize: pass.finalize,
        sourceIndex: pass.sourceIndex,
        destinationIndex: pass.destinationIndex,
      }];
    }
    return Array.from({ length: cascadeCount }, (_unused, cascade): SpectralAtlasDraw => ({
      kind: "gather",
      axis: pass.axis,
      stage: pass.stage,
      finalize: pass.finalize,
      sourceIndex: pass.sourceIndex,
      cascade,
    }));
  });
  return Object.freeze(draws.map((draw) => Object.freeze(draw)));
}

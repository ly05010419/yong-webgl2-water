// The compiled artefacts both spectral cascade layouts share: the spectrum
// evolution program, the inverse-FFT program variants (FFT axis × index mode)
// and the texture-unit bookkeeping every layout needs when it releases units.
//
// Keeping this here is what lets `atlas` and `separate` run the *same* GLSL.
// The layouts differ only in which index-mode variant they compile and which
// framebuffer each draw targets — never in the arithmetic, which is the whole
// reason the atlas layout can be bit-identical to the per-cascade one
// (docs/webgl2-port/spec-compute.md R17).

import { SPECTRAL_RESOLUTION, type CascadeScaleOptions } from "../spectral-ocean";
import { FULLSCREEN_TRIANGLE_VERTEX_GLSL } from "./gl-geometry";
import { assignSamplerUnits, bindUniformBlock, createGlProgram, uniformLocations } from "./gl-program";
import { WORLD_UNIFORMS_BINDING, WORLD_UNIFORM_BYTES } from "./gl-uniform-buffer";
import {
  SPECTRAL_IFFT_FRAGMENT_GLSL,
  SPECTRAL_IFFT_SAMPLERS,
  SPECTRUM_EVOLUTION_FRAGMENT_GLSL,
  SPECTRUM_EVOLUTION_SAMPLERS,
} from "./spectral-glsl";
import type { GlProgram, GlTexture } from "./types";

/**
 * How the three cascades are stored while they are evolved and transformed.
 *
 * - `"atlas"` (default) — one 128 × 384 rgba16f MRT ping-pong for all three,
 *   17 draws per frame.
 * - `"separate"` — the original one-ping-pong-per-cascade layout, 45 draws.
 *   Kept as a switchable reference implementation: it is the thing the atlas
 *   layout is diffed against when a pixel goes wrong, and both run the same
 *   shader bodies, so the comparison isolates the indexing.
 */
export type SpectralLayout = "atlas" | "separate";

/** Index convention compiled into one inverse-FFT program variant. */
export type SpectralIndexMode = "atlas" | "gather";

/** Compiled spectrum-evolution program plus its cached binding points. */
export interface EvolutionProgram {
  readonly program: GlProgram;
  readonly units: Readonly<Record<(typeof SPECTRUM_EVOLUTION_SAMPLERS)[number], number>>;
}

/** One inverse-FFT program variant plus its cached uniform locations. */
export interface IfftProgram {
  readonly program: GlProgram;
  readonly units: Readonly<Record<(typeof SPECTRAL_IFFT_SAMPLERS)[number], number>>;
  readonly stage: WebGLUniformLocation | null;
  readonly finalize: WebGLUniformLocation | null;
  /** Only present on `gather` variants; `null` on `atlas` ones, which derive the row block. */
  readonly cascade: WebGLUniformLocation | null;
}

/**
 * What a layout implementation owes the public cascade set. Deliberately the
 * public `SpectralCascadeSet` minus the parts the facade itself provides
 * (`cascadeCount`, argument validation, liveness checks and disposal), so a
 * layout module never has to know it is being wrapped.
 */
export interface SpectralCascadeRuntime {
  update(): void;
  field0(cascade: number): GlTexture;
  field1(cascade: number): GlTexture;
  uploadCascade(cascade: number, options: CascadeScaleOptions): void;
}

/**
 * Compiles the evolution program. `fieldHeight` is the target's height — 128
 * per cascade, or 128 · cascadeCount for the atlas — and feeds the shader's
 * bounds check only; every texel does the same work either way.
 */
export function createEvolutionProgram(gl: WebGL2RenderingContext, fieldHeight: number): EvolutionProgram {
  const program = createGlProgram(gl, {
    label: `spectral · spectrum evolution (${SPECTRAL_RESOLUTION}×${fieldHeight})`,
    vertexSource: FULLSCREEN_TRIANGLE_VERTEX_GLSL,
    fragmentSource: SPECTRUM_EVOLUTION_FRAGMENT_GLSL,
  });
  bindUniformBlock(gl, program, "WorldUniforms", WORLD_UNIFORMS_BINDING, WORLD_UNIFORM_BYTES);
  // Leaves `program` current, which the constant uniform below relies on.
  const units = assignSamplerUnits(gl, program, SPECTRUM_EVOLUTION_SAMPLERS);
  const { uFieldDims } = uniformLocations(gl, program, ["uFieldDims"] as const);
  gl.uniform2i(uFieldDims, SPECTRAL_RESOLUTION, fieldHeight);
  return Object.freeze({ program, units });
}

/**
 * Compiles one inverse-FFT variant. `cascadeCount` only reaches the `atlas`
 * variant's bounds check; `gather` variants get their row block from the
 * `uCascade` uniform, which is initialised to 0 here so the `separate` layout
 * never has to set it at all.
 */
export function createIfftProgram(
  gl: WebGL2RenderingContext,
  axis: 0 | 1,
  mode: SpectralIndexMode,
  cascadeCount: number,
): IfftProgram {
  const gather = mode === "gather" ? 1 : 0;
  const program = createGlProgram(gl, {
    label: `spectral · inverse FFT axis ${axis} · ${mode}`,
    vertexSource: FULLSCREEN_TRIANGLE_VERTEX_GLSL,
    fragmentSource: SPECTRAL_IFFT_FRAGMENT_GLSL,
    defines: { FFT_AXIS: axis, SPECTRAL_GATHER: gather, SPECTRAL_CASCADE_COUNT: cascadeCount },
  });
  // Leaves `program` current, which the constant uniforms below rely on.
  const units = assignSamplerUnits(gl, program, SPECTRAL_IFFT_SAMPLERS);
  const locations = uniformLocations(gl, program, ["uStage", "uSize", "uFinalize", "uCascade"] as const);
  // `size` never changes (128); only stage / finalize / cascade vary per draw.
  gl.uniform1i(locations.uSize, SPECTRAL_RESOLUTION);
  if (locations.uCascade !== null) gl.uniform1i(locations.uCascade, 0);
  return Object.freeze({
    program,
    units,
    stage: locations.uStage,
    finalize: locations.uFinalize,
    cascade: locations.uCascade,
  });
}

/**
 * Every texture unit the given programs bind, deduplicated. A layout releases
 * all of them after its last draw so no field texture is still bound as an
 * input when the next frame renders into it (docs/webgl2-port/spec-compute.md R4).
 */
export function spectralBoundUnits(evolution: EvolutionProgram, ifftPrograms: readonly IfftProgram[]): readonly number[] {
  return Object.freeze([
    ...new Set<number>([
      ...Object.values(evolution.units),
      ...ifftPrograms.flatMap((variant) => Object.values(variant.units)),
    ]),
  ]);
}

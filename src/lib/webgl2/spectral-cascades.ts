// The three spectral ocean cascades as WebGL2 fragment passes.
//
// Replaces the WebGPU compute chain `evolveSpectrum` + 14 × `inverseFftStage`
// per cascade (engine:2360-2374) with fragment-shader MRT ping-pong: every
// former compute dispatch becomes a full-screen triangle into an rgba16f MRT
// pair. Two storage layouts implement that, both from the same shader bodies:
//
// | layout       | storage                        | draws / frame |
// |--------------|--------------------------------|---------------|
// | `"atlas"`    | one 128×384 stack (default)    | 17            |
// | `"separate"` | one 128×128 pair per cascade   | 45            |
//
// `"atlas"` is the shipping path (docs/webgl2-port/spec-compute.md R17); `"separate"` is the
// original transcription, kept switchable as the reference the atlas is diffed
// against. They are bit-identical by construction — see `./spectral-atlas`.
//
// Ownership: this module creates and owns everything spectral (twiddle table,
// initial-spectrum / wave-data tables, the field targets) and exposes the final
// fields as textures. The engine only has to keep the `WorldUniforms` UBO bound
// at binding 0 (the evolution shader reads the time from `cameraTime.w`) and
// keep a non-default VAO bound for procedural draws.

import {
  SPECTRAL_CASCADES,
  SPECTRAL_LOG_SIZE,
  SPECTRAL_RESOLUTION,
  buildSpectralTwiddleTable,
  type CascadeScaleOptions,
} from "../spectral-ocean";
import { createGlUnwindStack, type GlUnwindStack } from "./gl-unwind";
import { createTexture2D, disposeTexture } from "./gl-texture";
import { createAtlasCascadeRuntime } from "./spectral-atlas";
import type { SpectralCascadeRuntime, SpectralLayout } from "./spectral-programs";
import { createSeparateCascadeRuntime } from "./spectral-separate";
import type { GlPass, GlTexture, WaterGlContext } from "./types";

/** Number of cascades (long / medium / short). */
const CASCADE_COUNT = SPECTRAL_CASCADES.length;

/** Layout used when the caller does not ask for one. */
const DEFAULT_LAYOUT: SpectralLayout = "atlas";

export type { SpectralLayout } from "./spectral-programs";

/** Construction knobs that do not affect the produced fields, only how they are computed. */
export interface SpectralCascadeSetOptions {
  /** Storage layout; defaults to `"atlas"`. Both produce bit-identical fields. */
  readonly layout?: SpectralLayout;
}

/**
 * The spectral cascade set: one `update()` per frame advances every cascade
 * from the frozen CPU spectrum to a spatial displacement/derivative field.
 *
 * Channel semantics of the results (docs/webgl2-port/spec-compute.md §2.2):
 * `field0` = (Dx, Dz, Dy, ∂Dz/∂x), `field1` = (∂Dy/∂x, ∂Dy/∂z, ∂Dx/∂x, ∂Dz/∂z).
 */
export interface SpectralCascadeSet extends GlPass {
  /** Always 3; mirrors `SPECTRAL_CASCADES.length`. */
  readonly cascadeCount: number;
  /**
   * Runs spectrum evolution + the 14 inverse-FFT stages for every cascade.
   * Requires: `WorldUniforms` bound at binding 0 with the current time, a bound
   * VAO, and no other pass depending on the currently bound framebuffer.
   * Allocation-free.
   */
  update(): void;
  /** Final `(Dx, Dz, Dy, ∂Dz/∂x)` field of `cascade`. */
  field0(cascade: number): GlTexture;
  /** Final `(∂Dy/∂x, ∂Dy/∂z, ∂Dx/∂x, ∂Dz/∂z)` field of `cascade`. */
  field1(cascade: number): GlTexture;
  /**
   * Rebuilds one cascade's spectrum on the CPU for a new tile size and
   * overwrites its input texels in place (the WebGPU `uploadCascadeSpectrum`
   * analogue, engine:1794-1802). The twiddle table is shared and never changes.
   */
  uploadCascade(cascade: number, options: CascadeScaleOptions): void;
}

function assertCascadeIndex(cascade: number): void {
  if (!Number.isInteger(cascade) || cascade < 0 || cascade >= CASCADE_COUNT) {
    throw new Error(`谱级联索引必须是 0 到 ${CASCADE_COUNT - 1} 之间的整数，收到 ${String(cascade)}。`);
  }
}

function assertScaleOptions(options: CascadeScaleOptions): void {
  const { longCascadeScale, mediumCascadeScale } = options;
  if (!Number.isFinite(longCascadeScale) || longCascadeScale <= 0 || !Number.isFinite(mediumCascadeScale) || mediumCascadeScale <= 0) {
    throw new Error(`级联尺度必须是正有限数，收到 long=${String(longCascadeScale)}、medium=${String(mediumCascadeScale)}。`);
  }
}

function assertLayout(layout: SpectralLayout): void {
  if (layout !== "atlas" && layout !== "separate") {
    throw new Error(`谱级联布局只能是 "atlas" 或 "separate"，收到 ${String(layout)}。`);
  }
}

/** 128 × 7 rgba32f, identical for all three cascades — uploaded once. */
function createTwiddleTable(gl: WebGL2RenderingContext, stack: GlUnwindStack): GlTexture {
  return stack.track(createTexture2D(gl, {
    label: "spectral Stockham twiddle table",
    width: SPECTRAL_RESOLUTION,
    height: SPECTRAL_LOG_SIZE,
    format: "rgba32f",
    data: buildSpectralTwiddleTable(SPECTRAL_RESOLUTION, SPECTRAL_LOG_SIZE),
    minFilter: "nearest",
    magFilter: "nearest",
  }), (texture) => disposeTexture(gl, texture));
}

/** Builds the shared twiddle table and the chosen layout's runtime, in order. */
function buildRuntime(
  gl: WebGL2RenderingContext,
  options: CascadeScaleOptions,
  layout: SpectralLayout,
  stack: GlUnwindStack,
): SpectralCascadeRuntime {
  const twiddle = createTwiddleTable(gl, stack);
  return layout === "atlas"
    ? createAtlasCascadeRuntime(gl, options, CASCADE_COUNT, twiddle, stack)
    : createSeparateCascadeRuntime(gl, options, CASCADE_COUNT, twiddle, stack);
}

/**
 * Builds the three cascades, their shared Stockham twiddle table and every
 * shader program. Throws readable Chinese errors on any GL or argument
 * failure. Construction is more than a dozen independent GL allocations, so a
 * failure part-way through rolls back what already succeeded (`./gl-unwind`)
 * instead of stranding it for the life of the context.
 */
export function createSpectralCascadeSet(
  ctx: WaterGlContext,
  options: CascadeScaleOptions,
  setOptions: SpectralCascadeSetOptions = {},
): SpectralCascadeSet {
  assertScaleOptions(options);
  const layout = setOptions.layout ?? DEFAULT_LAYOUT;
  assertLayout(layout);
  const { gl } = ctx;
  if (ctx.limits.maxDrawBuffers < 2) {
    throw new Error(`谱级联需要至少 2 个绘制缓冲（MRT），当前设备上限为 ${ctx.limits.maxDrawBuffers}。`);
  }
  const stack = createGlUnwindStack();
  let runtime: SpectralCascadeRuntime;
  try {
    runtime = buildRuntime(gl, options, layout, stack);
  } catch (error) {
    stack.unwind();
    throw error;
  }
  let disposed = false;

  function assertLive(): void {
    if (disposed) throw new Error("谱级联集合已被释放（dispose），不能继续使用。");
  }

  return Object.freeze({
    cascadeCount: CASCADE_COUNT,
    update(): void {
      assertLive();
      runtime.update();
    },
    field0(cascade: number): GlTexture {
      assertLive();
      assertCascadeIndex(cascade);
      return runtime.field0(cascade);
    },
    field1(cascade: number): GlTexture {
      assertLive();
      assertCascadeIndex(cascade);
      return runtime.field1(cascade);
    },
    uploadCascade(cascade: number, next: CascadeScaleOptions): void {
      assertLive();
      assertCascadeIndex(cascade);
      assertScaleOptions(next);
      runtime.uploadCascade(cascade, next);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // The same stack that would have rolled construction back: it holds every
      // program, texture and render target, and releases them newest-first.
      stack.unwind();
    },
  });
}

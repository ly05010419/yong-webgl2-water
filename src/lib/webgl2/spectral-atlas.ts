// The atlas spectral layout: all three cascades stacked vertically into one
// 128 × 384 rgba16f MRT ping-pong, so a whole frame of spectrum evolution and
// inverse FFT costs **17 draws instead of 45** (docs/webgl2-port/spec-compute.md R17).
//
//   row [c·128, (c+1)·128) of every atlas belongs to cascade c
//
//   1 draw   spectrum evolution over the whole stack
//  13 draws  inverse-FFT stages 0..12 over the whole stack
//   3 draws  stage 13 (the checkerboard-finalising one), one per cascade,
//            straight into that cascade's own 128×128 field pair
//
// The vertical stacking is what makes this free of arithmetic changes: the
// seven horizontal stages transform along rows, which are cascade-private by
// construction, and the seven vertical ones only need `± cascade·128` on the
// butterfly's two row indices. The closing stage is *split* rather than
// followed by a copy so the fields every downstream pass samples keep their
// own textures — same size, same rgba16f, same repeat/linear state, same
// `field0(c)` / `field1(c)` objects as the per-cascade layout handed out.
//
// Every texel therefore runs the identical sequence of float operations on the
// identical `texelFetch` results, through the identical rgba16f rounding at
// every stage boundary: the two layouts are bit-identical, not merely close.

import {
  SPECTRAL_LOG_SIZE,
  SPECTRAL_RESOLUTION,
  buildSpectralOceanData,
  resolveCascadeConfig,
  type CascadeScaleOptions,
} from "../spectral-ocean";
import {
  bindFramebufferForDraw,
  clearFramebufferToZero,
  createGlFramebuffer,
  createPingPongTargets,
  deleteFramebufferHandle,
  disposeFramebuffer,
} from "./gl-framebuffer";
import { drawFullscreenTriangle } from "./gl-geometry";
import { bindGlProgram, deleteGlProgram } from "./gl-program";
import { COMPUTE_STATE, applyRenderState } from "./gl-state";
import { bindTextureUnit, createTexture2D, disposeTexture, unbindTextureUnits, uploadTexture2D } from "./gl-texture";
import { createGlUnwindStack, type GlUnwindStack } from "./gl-unwind";
import { spectralAtlasPassSchedule, type SpectralAtlasDraw } from "./spectral-glsl";
import {
  createEvolutionProgram,
  createIfftProgram,
  spectralBoundUnits,
  type IfftProgram,
  type SpectralCascadeRuntime,
} from "./spectral-programs";
import type { GlFramebuffer, GlTexture, PingPongTargets } from "./types";

/** The two rgba32f input tables, stacked the same way as the fields. */
interface AtlasInputs {
  readonly initialSpectrum: GlTexture;
  readonly waveData: GlTexture;
}

/** Both inverse-FFT axes of one index mode. */
type AxisPair = readonly [IfftProgram, IfftProgram];

/** First row of `cascade` in every atlas. */
function cascadeRow(cascade: number): number {
  return cascade * SPECTRAL_RESOLUTION;
}

/**
 * Only the vertical `gather` program is compiled, because the schedule's
 * closing pass is always the vertical one. Checked once at construction rather
 * than trusted: a schedule that ever produced a horizontal closing draw would
 * otherwise transform along the wrong axis and be visible only as wrong pixels.
 */
function assertGatherAxis(schedule: readonly SpectralAtlasDraw[]): void {
  const wrongAxis = schedule.find((draw) => draw.kind === "gather" && draw.axis !== 1);
  if (wrongAxis) {
    throw new Error(`谱 atlas 调度的收尾 draw 必须沿垂直轴（axis 1），收到 axis ${wrongAxis.axis}。`);
  }
}

/** Rebuilds one cascade's spectrum on the CPU and writes it into its rows. */
function uploadCascadeRows(
  gl: WebGL2RenderingContext,
  inputs: AtlasInputs,
  cascade: number,
  options: CascadeScaleOptions,
): void {
  const data = buildSpectralOceanData(SPECTRAL_RESOLUTION, resolveCascadeConfig(cascade, options));
  const region = { y: cascadeRow(cascade), height: SPECTRAL_RESOLUTION } as const;
  uploadTexture2D(gl, inputs.initialSpectrum, data.initialSpectrum, region);
  uploadTexture2D(gl, inputs.waveData, data.waveData, region);
}

/**
 * The two stacked input tables. Created without initial data and then filled
 * cascade by cascade, which covers every row — the same code path
 * `uploadCascade` takes later, so there is only one way rows are written.
 */
function createAtlasInputs(
  gl: WebGL2RenderingContext,
  options: CascadeScaleOptions,
  cascadeCount: number,
  height: number,
  stack: GlUnwindStack,
): AtlasInputs {
  const table = (label: string): GlTexture =>
    stack.track(createTexture2D(gl, {
      label,
      width: SPECTRAL_RESOLUTION,
      height,
      format: "rgba32f",
      minFilter: "nearest",
      magFilter: "nearest",
    }), (texture) => disposeTexture(gl, texture));
  const inputs: AtlasInputs = Object.freeze({
    initialSpectrum: table("spectral atlas initial spectrum"),
    waveData: table("spectral atlas wave data"),
  });
  for (let cascade = 0; cascade < cascadeCount; cascade += 1) uploadCascadeRows(gl, inputs, cascade, options);
  return inputs;
}

/**
 * One cascade's final field pair: the 128×128 rgba16f MRT the closing draw
 * writes and every downstream pass samples. Repeat + linear because they are
 * tiled across the world; zero-filled because WebGL2 does not do it for us
 * (docs/webgl2-port/spec-compute.md R18) and `field0()` is readable before the first `update()`.
 */
function createFieldTarget(gl: WebGL2RenderingContext, cascade: number): GlFramebuffer {
  const inner = createGlUnwindStack();
  try {
    const color = [0, 1].map((slot) =>
      inner.track(createTexture2D(gl, {
        label: `spectral cascade ${cascade} field${slot}`,
        width: SPECTRAL_RESOLUTION,
        height: SPECTRAL_RESOLUTION,
        format: "rgba16f",
        minFilter: "linear",
        magFilter: "linear",
        wrap: "repeat",
      }), (texture) => disposeTexture(gl, texture)));
    // Tracked with the framebuffer delete only: the attachments are already on
    // the stack, and `disposeFramebuffer` would take them a second time.
    const fbo = inner.track(
      createGlFramebuffer(gl, { label: `spectral cascade ${cascade} fields`, color }),
      (entry) => deleteFramebufferHandle(gl, entry.handle),
    );
    clearFramebufferToZero(gl, fbo);
    return fbo;
  } catch (error) {
    inner.unwind();
    throw error;
  }
}

/**
 * Builds the atlas layout. `twiddle` is owned by the caller (shared, never
 * changes); everything allocated here is registered on `stack`, so a throw
 * part-way through rolls the whole set back.
 */
export function createAtlasCascadeRuntime(
  gl: WebGL2RenderingContext,
  options: CascadeScaleOptions,
  cascadeCount: number,
  twiddle: GlTexture,
  stack: GlUnwindStack,
): SpectralCascadeRuntime {
  const atlasHeight = SPECTRAL_RESOLUTION * cascadeCount;
  const evolution = stack.track(createEvolutionProgram(gl, atlasHeight), (entry) => deleteGlProgram(gl, entry.program));
  const trackProgram = (axis: 0 | 1, mode: "atlas" | "gather"): IfftProgram =>
    stack.track(createIfftProgram(gl, axis, mode, cascadeCount), (entry) => deleteGlProgram(gl, entry.program));
  // Both axes of the stacked stages: the schedule alternates between them.
  const stacked: AxisPair = [trackProgram(0, "atlas"), trackProgram(1, "atlas")];
  // Only the vertical `gather` variant. The closing draws are the schedule's
  // last inverse-FFT pass, and that pass is always a vertical one (its index is
  // `logSize·2 - 1`, never below `logSize`), so a horizontal `gather` program
  // would be compiled and never used. `assertGatherAxis` below turns that
  // reasoning into a construction-time check instead of a per-draw branch.
  const gather = trackProgram(1, "gather");
  const inputs = createAtlasInputs(gl, options, cascadeCount, atlasHeight, stack);
  // Zero-filled like the per-cascade ping-pongs: the first evolution draw
  // overwrites slot 0 completely, but slot 1 is read by stage 13 of frame 1
  // before anything has written it if a stage ever discards (R18).
  const atlas: PingPongTargets = stack.track(createPingPongTargets(gl, {
    label: "spectral cascade atlas",
    width: SPECTRAL_RESOLUTION,
    height: atlasHeight,
    formats: ["rgba16f", "rgba16f"],
    // Read exclusively through `texelFetch`, which ignores filter and wrap.
    minFilter: "nearest",
    magFilter: "nearest",
    clearToZero: true,
  }), (targets) => targets.dispose());
  const fields: readonly GlFramebuffer[] = Object.freeze(
    Array.from({ length: cascadeCount }, (_unused, cascade) =>
      stack.track(createFieldTarget(gl, cascade), (fbo) => disposeFramebuffer(gl, fbo))),
  );
  const schedule = spectralAtlasPassSchedule(SPECTRAL_LOG_SIZE, cascadeCount);
  assertGatherAxis(schedule);
  const boundUnits = spectralBoundUnits(evolution, [...stacked, gather]);

  /** Spectrum evolution for every cascade at once, into atlas slot 0. */
  function runEvolution(): void {
    bindGlProgram(gl, evolution.program);
    // Target is ping slot 0; its attachments are never inputs of this pass, so
    // there is no feedback loop (docs/webgl2-port/spec-compute.md R4).
    bindFramebufferForDraw(gl, atlas.at(0));
    bindTextureUnit(gl, evolution.units.initialSpectrum, inputs.initialSpectrum, null);
    bindTextureUnit(gl, evolution.units.waveData, inputs.waveData, null);
    drawFullscreenTriangle(gl);
  }

  /** One scheduled draw: same butterfly, different target and row block. */
  function runDraw(draw: SpectralAtlasDraw): void {
    const variant = draw.kind === "atlas" ? stacked[draw.axis] : gather;
    const source = atlas.at(draw.sourceIndex);
    const target = draw.kind === "atlas" ? atlas.at(draw.destinationIndex) : fields[draw.cascade];
    bindGlProgram(gl, variant.program);
    bindFramebufferForDraw(gl, target);
    bindTextureUnit(gl, variant.units.twiddleTable, twiddle, null);
    bindTextureUnit(gl, variant.units.input0, source.color[0], null);
    bindTextureUnit(gl, variant.units.input1, source.color[1], null);
    gl.uniform1i(variant.stage, draw.stage);
    gl.uniform1i(variant.finalize, draw.finalize);
    // `uCascade` exists on `gather` variants only; the stacked ones read the
    // row block off `gl_FragCoord.y` and declare no such uniform.
    if (draw.kind === "gather" && variant.cascade !== null) gl.uniform1i(variant.cascade, draw.cascade);
    drawFullscreenTriangle(gl);
  }

  return Object.freeze({
    update(): void {
      applyRenderState(gl, COMPUTE_STATE);
      runEvolution();
      for (let index = 0; index < schedule.length; index += 1) runDraw(schedule[index]);
      // Same discipline as the simulation and breaker passes: leave nothing
      // bound, so correctness never rests on some later pass unbinding first.
      unbindTextureUnits(gl, boundUnits);
    },
    field0: (cascade: number): GlTexture => fields[cascade].color[0],
    field1: (cascade: number): GlTexture => fields[cascade].color[1],
    uploadCascade: (cascade: number, next: CascadeScaleOptions): void => uploadCascadeRows(gl, inputs, cascade, next),
  });
}

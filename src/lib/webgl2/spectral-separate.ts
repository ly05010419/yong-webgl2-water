// The per-cascade spectral layout: one 128×128 rgba16f MRT ping-pong, one
// initial-spectrum table and one wave-data table per cascade, and one draw per
// (cascade, pass) — 3 × (1 evolution + 14 inverse-FFT stages) = 45 draws.
//
// This is the original transcription of the WebGPU compute chain and is kept as
// the reference implementation the `atlas` layout is checked against: both run
// the same shader bodies (`./spectral-programs`), so any difference between
// them is an indexing difference and nothing else. See `./spectral-atlas` for
// the 17-draw variant that ships by default.

import {
  SPECTRAL_LOG_SIZE,
  SPECTRAL_RESOLUTION,
  buildSpectralOceanData,
  resolveCascadeConfig,
  type CascadeScaleOptions,
} from "../spectral-ocean";
import { bindFramebufferForDraw, createPingPongTargets } from "./gl-framebuffer";
import { drawFullscreenTriangle } from "./gl-geometry";
import { COMPUTE_STATE, applyRenderState } from "./gl-state";
import { bindTextureUnit, createTexture2D, disposeTexture, unbindTextureUnits, uploadTexture2D } from "./gl-texture";
import type { GlUnwindStack } from "./gl-unwind";
import { spectralIfftPassSchedule, type SpectralIfftPass } from "./spectral-glsl";
import {
  createEvolutionProgram,
  createIfftProgram,
  spectralBoundUnits,
  type IfftProgram,
  type SpectralCascadeRuntime,
} from "./spectral-programs";
import { bindGlProgram, deleteGlProgram } from "./gl-program";
import type { GlTexture, PingPongTargets } from "./types";

/** GL objects backing one cascade. */
interface CascadeResources {
  readonly initialSpectrum: GlTexture;
  readonly waveData: GlTexture;
  readonly fields: PingPongTargets;
}

function createCascadeResources(
  gl: WebGL2RenderingContext,
  cascade: number,
  options: CascadeScaleOptions,
  stack: GlUnwindStack,
): CascadeResources {
  const data = buildSpectralOceanData(SPECTRAL_RESOLUTION, resolveCascadeConfig(cascade, options));
  const initialSpectrum = stack.track(createTexture2D(gl, {
    label: `spectral cascade ${cascade} initial spectrum`,
    width: SPECTRAL_RESOLUTION,
    height: SPECTRAL_RESOLUTION,
    format: "rgba32f",
    data: data.initialSpectrum,
    minFilter: "nearest",
    magFilter: "nearest",
  }), (texture) => disposeTexture(gl, texture));
  const waveData = stack.track(createTexture2D(gl, {
    label: `spectral cascade ${cascade} wave data`,
    width: SPECTRAL_RESOLUTION,
    height: SPECTRAL_RESOLUTION,
    format: "rgba32f",
    data: data.waveData,
    minFilter: "nearest",
    magFilter: "nearest",
  }), (texture) => disposeTexture(gl, texture));
  // Both slots zero-filled (docs/webgl2-port/spec-compute.md R18); repeat + linear because every
  // downstream consumer tiles these fields across the world.
  const fields = stack.track(createPingPongTargets(gl, {
    label: `spectral cascade ${cascade} fields`,
    width: SPECTRAL_RESOLUTION,
    height: SPECTRAL_RESOLUTION,
    formats: ["rgba16f", "rgba16f"],
    minFilter: "linear",
    magFilter: "linear",
    wrap: "repeat",
    clearToZero: true,
  }), (targets) => targets.dispose());
  return Object.freeze({ initialSpectrum, waveData, fields });
}

/**
 * Builds the per-cascade layout. `twiddle` is owned by the caller (it is shared
 * with any other layout and never changes), and every allocation made here is
 * registered on `stack`, so a throw part-way through rolls the whole set back.
 */
export function createSeparateCascadeRuntime(
  gl: WebGL2RenderingContext,
  options: CascadeScaleOptions,
  cascadeCount: number,
  twiddle: GlTexture,
  stack: GlUnwindStack,
): SpectralCascadeRuntime {
  const evolution = stack.track(createEvolutionProgram(gl, SPECTRAL_RESOLUTION), (entry) => deleteGlProgram(gl, entry.program));
  // `gather` with `uCascade` pinned to 0: the source holds a single cascade, so
  // the row block offset is zero and the shader reduces to the original one.
  const ifftPrograms: readonly [IfftProgram, IfftProgram] = [
    stack.track(createIfftProgram(gl, 0, "gather", cascadeCount), (entry) => deleteGlProgram(gl, entry.program)),
    stack.track(createIfftProgram(gl, 1, "gather", cascadeCount), (entry) => deleteGlProgram(gl, entry.program)),
  ];
  const cascades: readonly CascadeResources[] = Object.freeze(
    Array.from({ length: cascadeCount }, (_unused, cascade) => createCascadeResources(gl, cascade, options, stack)),
  );
  const schedule = spectralIfftPassSchedule(SPECTRAL_LOG_SIZE);
  const boundUnits = spectralBoundUnits(evolution, ifftPrograms);

  function runEvolution(cascade: CascadeResources): void {
    bindGlProgram(gl, evolution.program);
    // Target is ping slot 0; its attachments are never inputs of this pass, so
    // there is no feedback loop (docs/webgl2-port/spec-compute.md R4).
    bindFramebufferForDraw(gl, cascade.fields.at(0));
    bindTextureUnit(gl, evolution.units.initialSpectrum, cascade.initialSpectrum, null);
    bindTextureUnit(gl, evolution.units.waveData, cascade.waveData, null);
    drawFullscreenTriangle(gl);
  }

  function runIfftPass(cascade: CascadeResources, pass: SpectralIfftPass): void {
    const variant = ifftPrograms[pass.axis];
    const source = cascade.fields.at(pass.sourceIndex);
    bindGlProgram(gl, variant.program);
    bindFramebufferForDraw(gl, cascade.fields.at(pass.destinationIndex));
    bindTextureUnit(gl, variant.units.twiddleTable, twiddle, null);
    bindTextureUnit(gl, variant.units.input0, source.color[0], null);
    bindTextureUnit(gl, variant.units.input1, source.color[1], null);
    gl.uniform1i(variant.stage, pass.stage);
    gl.uniform1i(variant.finalize, pass.finalize);
    drawFullscreenTriangle(gl);
  }

  return Object.freeze({
    update(): void {
      applyRenderState(gl, COMPUTE_STATE);
      for (let cascade = 0; cascade < cascades.length; cascade += 1) {
        const resources = cascades[cascade];
        runEvolution(resources);
        for (let pass = 0; pass < schedule.length; pass += 1) runIfftPass(resources, schedule[pass]);
      }
      // Same discipline as the simulation and breaker passes: leave nothing
      // bound, so correctness never rests on some later pass unbinding first.
      unbindTextureUnits(gl, boundUnits);
    },
    field0: (cascade: number): GlTexture => cascades[cascade].fields.at(0).color[0],
    field1: (cascade: number): GlTexture => cascades[cascade].fields.at(0).color[1],
    uploadCascade(cascade: number, next: CascadeScaleOptions): void {
      const resources = cascades[cascade];
      const data = buildSpectralOceanData(SPECTRAL_RESOLUTION, resolveCascadeConfig(cascade, next));
      uploadTexture2D(gl, resources.initialSpectrum, data.initialSpectrum);
      uploadTexture2D(gl, resources.waveData, data.waveData);
    },
  });
}

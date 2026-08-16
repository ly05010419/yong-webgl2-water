// The water render pass: four GL programs mirroring the four WebGPU pipelines
// (`optimizedWaterPipeline` / `referenceWaterPipeline` /
// `optimizedBreakerPatchPipeline` / `referenceBreakerPatchPipeline`,
// `webgpu-water-engine.ts@7dbf39c:1944-1964`) and the draws at 2418-2439.
//
// The pass owns nothing but its programs: every texture, sampler and the world
// UBO are created by the engine and injected per draw (contract §3.1). It also
// does not bind a framebuffer -- the engine binds the water target (and the VAO)
// before calling `draw`, exactly as the WebGPU version reuses one render pass.

import {
  BREAKER_PATCH_ACROSS_RESOLUTION,
  BREAKER_PATCH_ALONG_RESOLUTION,
  WATER_CLIPMAP_LEVELS,
  WATER_CLIPMAP_RESOLUTION,
} from "../water-constants";
import type { WaterRenderMode } from "../water-profiles";
import { drawProcedural } from "./gl-geometry";
import { assignSamplerUnits, bindGlProgram, bindUniformBlock, createGlProgram, deleteGlProgram, uniformLocations } from "./gl-program";
import { WATER_STATE, applyRenderState } from "./gl-state";
import { createGlUnwindStack, type GlUnwindStack } from "./gl-unwind";
import { bindTextureUnit, unbindTextureUnits } from "./gl-texture";
import { WORLD_UNIFORMS_BINDING, WORLD_UNIFORM_BYTES } from "./gl-uniform-buffer";
import type { GlPass, GlProgram, GlSampler, GlTexture, WaterGlContext } from "./types";
import {
  WATER_BREAKER_PATCH_VERTEX_GLSL,
  WATER_FRAGMENT_GLSL,
  WATER_SAMPLER_NAMES,
  WATER_VERTEX_GLSL,
} from "./water-glsl";

// Which of the two fragment variants to draw with (`REFERENCE_MODE` 0 / 1).
// Re-exported rather than re-declared: the engine, the demo UI and the public
// package entry all speak `../water-profiles`'s definition, and a structurally
// identical copy here would silently stop matching if that one ever grew a mode.
export type { WaterRenderMode };

/** Vertices of one clipmap instance: 64 x 64 cells x 6 vertices = 24576 (engine 2428). */
export const WATER_CLIPMAP_VERTEX_COUNT = WATER_CLIPMAP_RESOLUTION * WATER_CLIPMAP_RESOLUTION * 6;
/** Vertices of the attached crest patch: 256 x 48 x 6 = 73728 (engine 2439). */
export const BREAKER_PATCH_VERTEX_COUNT = BREAKER_PATCH_ALONG_RESOLUTION * BREAKER_PATCH_ACROSS_RESOLUTION * 6;

type WaterSamplerName = (typeof WATER_SAMPLER_NAMES)[number];

/** Everything one water draw needs. All textures/samplers are engine-owned. */
export interface WaterPassDrawInput {
  readonly mode: WaterRenderMode;
  /** Engine passes `BREAKER_ENABLED`; false skips the crest-patch draw entirely. */
  readonly drawBreakerPatch: boolean;
  readonly terrain: GlTexture;
  readonly waterState: GlTexture;
  readonly longField0: GlTexture;
  readonly longField1: GlTexture;
  readonly mediumField0: GlTexture;
  readonly mediumField1: GlTexture;
  readonly shortField0: GlTexture;
  readonly shortField1: GlTexture;
  readonly breakerEvents: GlTexture;
  readonly sceneColor: GlTexture;
  /** depth24 copy of the scene depth; read only through `texelFetch`. */
  readonly sceneDepth: GlTexture;
  /**
   * Replaces WGSL `textureDimensions(sceneDepthTexture)`; must match
   * `sceneDepth`, whatever that is. The shore scene binds the canvas-sized
   * capture; the open scene captures nothing and binds the engine's 1x1
   * stand-ins, because there the water draws into the framebuffer that owns
   * the real attachments. Either way the shader only reads these under
   * `uniforms.environment.x > 0.5`, i.e. never with the stand-ins bound.
   */
  readonly sceneWidth: number;
  readonly sceneHeight: number;
  /** clamp + linear (WGSL `fieldSampler`, also used as `sceneColorSampler`). */
  readonly fieldSampler: GlSampler;
  /** repeat + linear (WGSL `spectrumSampler`). */
  readonly spectrumSampler: GlSampler;
  /** nearest sampler for the depth texture, or null to keep its own state. */
  readonly depthSampler: GlSampler | null;
}

export interface WaterPass extends GlPass {
  draw(input: WaterPassDrawInput): void;
}

interface WaterProgram {
  readonly program: GlProgram;
  readonly units: Readonly<Record<WaterSamplerName, number>>;
  readonly sceneDims: WebGLUniformLocation | null;
}

interface WaterPrograms {
  readonly optimized: WaterProgram;
  readonly reference: WaterProgram;
}

function buildProgram(
  gl: WebGL2RenderingContext,
  label: string,
  vertexSource: string,
  referenceMode: 0 | 1,
  stack: GlUnwindStack,
): WaterProgram {
  const program = stack.track(
    createGlProgram(gl, {
      label,
      vertexSource,
      fragmentSource: WATER_FRAGMENT_GLSL,
      defines: { REFERENCE_MODE: referenceMode },
    }),
    (handle) => deleteGlProgram(gl, handle),
  );
  bindUniformBlock(gl, program, "WorldUniforms", WORLD_UNIFORMS_BINDING, WORLD_UNIFORM_BYTES);
  const units = assignSamplerUnits(gl, program, WATER_SAMPLER_NAMES);
  const { uSceneDims } = uniformLocations(gl, program, ["uSceneDims"] as const);
  return Object.freeze({ program, units, sceneDims: uSceneDims });
}

// Property order in the literal is evaluation order, so `optimized` is always
// compiled before `reference` and the rollback order stays deterministic.
function buildVariants(gl: WebGL2RenderingContext, label: string, vertexSource: string, stack: GlUnwindStack): WaterPrograms {
  return Object.freeze({
    optimized: buildProgram(gl, `${label} · optimized`, vertexSource, 0, stack),
    reference: buildProgram(gl, `${label} · reference`, vertexSource, 1, stack),
  });
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`水面 pass 的 ${name} 必须是正整数，收到 ${value}。`);
  }
}

function validateDrawInput(input: WaterPassDrawInput): void {
  if (input.mode !== "optimized" && input.mode !== "reference") {
    throw new Error(`水面 pass 的渲染模式必须是 "optimized" 或 "reference"，收到 ${String(input.mode)}。`);
  }
  assertPositiveInteger(input.sceneWidth, "sceneWidth");
  assertPositiveInteger(input.sceneHeight, "sceneHeight");
  if (input.sceneWidth !== input.sceneDepth.width || input.sceneHeight !== input.sceneDepth.height) {
    throw new Error(
      `水面 pass 的场景尺寸 ${input.sceneWidth}×${input.sceneHeight} 与深度纹理「${input.sceneDepth.label}」的 ` +
        `${input.sceneDepth.width}×${input.sceneDepth.height} 不一致：折射采样会取到错误的 texel。`,
    );
  }
  if (input.sceneDepth.format !== "depth24") {
    throw new Error(`水面 pass 的 sceneDepth 必须是 depth24 纹理，收到「${input.sceneDepth.label}」的 ${input.sceneDepth.format}。`);
  }
  if (input.depthSampler !== null && input.depthSampler.filter !== "nearest") {
    throw new Error(`水面 pass 的 depthSampler 必须是 nearest（深度纹理不可线性过滤），收到「${input.depthSampler.label}」的 ${input.depthSampler.filter}。`);
  }
  if (input.fieldSampler.wrap !== "clamp" || input.fieldSampler.filter !== "linear") {
    throw new Error(`水面 pass 的 fieldSampler 必须是 clamp + linear，收到「${input.fieldSampler.label}」的 ${input.fieldSampler.wrap} + ${input.fieldSampler.filter}。`);
  }
  if (input.spectrumSampler.wrap !== "repeat" || input.spectrumSampler.filter !== "linear") {
    throw new Error(`水面 pass 的 spectrumSampler 必须是 repeat + linear，收到「${input.spectrumSampler.label}」的 ${input.spectrumSampler.wrap} + ${input.spectrumSampler.filter}。`);
  }
}

function bindWaterInputs(gl: WebGL2RenderingContext, entry: WaterProgram, input: WaterPassDrawInput): void {
  const { units } = entry;
  bindTextureUnit(gl, units.terrainField, input.terrain, input.fieldSampler);
  bindTextureUnit(gl, units.waterState, input.waterState, input.fieldSampler);
  bindTextureUnit(gl, units.longField0, input.longField0, input.spectrumSampler);
  bindTextureUnit(gl, units.longField1, input.longField1, input.spectrumSampler);
  bindTextureUnit(gl, units.mediumField0, input.mediumField0, input.spectrumSampler);
  bindTextureUnit(gl, units.mediumField1, input.mediumField1, input.spectrumSampler);
  bindTextureUnit(gl, units.shortField0, input.shortField0, input.spectrumSampler);
  bindTextureUnit(gl, units.shortField1, input.shortField1, input.spectrumSampler);
  bindTextureUnit(gl, units.breakerEvents, input.breakerEvents, input.fieldSampler);
  // WGSL group1 binding 2 (`sceneColorSampler`) is the very same clamp+linear
  // sampler object as `fieldSampler` (engine 2254-2258).
  bindTextureUnit(gl, units.sceneColorTexture, input.sceneColor, input.fieldSampler);
  bindTextureUnit(gl, units.sceneDepthTexture, input.sceneDepth, input.depthSampler);
  if (entry.sceneDims !== null) gl.uniform2i(entry.sceneDims, input.sceneWidth, input.sceneHeight);
}

/**
 * Releases every unit `bindWaterInputs` used. Both variants share
 * `WATER_SAMPLER_NAMES`, and `assignSamplerUnits` numbers units by position in
 * that list, so one sweep covers the clipmap and the crest patch alike.
 */
function unbindWaterInputs(gl: WebGL2RenderingContext, entry: WaterProgram): void {
  unbindTextureUnits(gl, WATER_SAMPLER_NAMES.map((name) => entry.units[name]));
}

/**
 * Compiles the four water programs. Throws (in Chinese) on any compile, link,
 * uniform-block or std140-size mismatch, so a broken port fails at init rather
 * than as a black surface. The fourth program failing must not strand the three
 * that linked, so the build is rolled back through `./gl-unwind`.
 */
export function createWaterPass(ctx: WaterGlContext): WaterPass {
  const { gl } = ctx;
  const stack = createGlUnwindStack();
  let clipmap: WaterPrograms;
  let breakerPatch: WaterPrograms;
  try {
    clipmap = buildVariants(gl, "Tethys water", WATER_VERTEX_GLSL, stack);
    breakerPatch = buildVariants(gl, "Tethys breaker patch", WATER_BREAKER_PATCH_VERTEX_GLSL, stack);
  } catch (error) {
    stack.unwind();
    throw error;
  }
  let disposed = false;

  return Object.freeze({
    draw(input: WaterPassDrawInput): void {
      if (disposed) throw new Error("水面 pass 已释放，无法再绘制。");
      validateDrawInput(input);
      applyRenderState(gl, WATER_STATE);
      const surface = clipmap[input.mode];
      bindGlProgram(gl, surface.program);
      bindWaterInputs(gl, surface, input);
      drawProcedural(gl, WATER_CLIPMAP_VERTEX_COUNT, WATER_CLIPMAP_LEVELS);
      if (input.drawBreakerPatch) {
        const patch = breakerPatch[input.mode];
        bindGlProgram(gl, patch.program);
        bindWaterInputs(gl, patch, input);
        drawProcedural(gl, BREAKER_PATCH_VERTEX_COUNT);
      }
      // The captured scene colour/depth (when there is a capture) and the
      // simulation state are all render targets of earlier passes, and the next
      // frame writes into them again. Unbind here rather than relying on
      // whoever runs next to do it first.
      unbindWaterInputs(gl, surface);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // The same stack that would have rolled the compile back; it holds all
      // four programs and deletes them newest-first.
      stack.unwind();
    },
  });
}

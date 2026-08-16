// Terrain (seabed / beach) render pass — docs/webgl2-port/spec-engine.md §3.2, WebGPU pipeline
// `webgpu-water-engine.ts@7dbf39c:1928-1935`, bind group 2040-2050, draw 2404-2405.
//
// Fully procedural mesh: `resolution² * 6` vertices with no vertex buffer, the
// height fetched in the vertex stage from the 513² terrain field. Opaque state
// (depth write + LESS, no blend, no culling), drawn straight after the sky into
// the same scene framebuffer.
//
// Every texture is owned by the engine and injected per draw, as are the two
// shared sampler objects; the pass owns only its program and its empty VAO.

import { drawProcedural, bindVao, createEmptyVao, disposeVao } from "./gl-geometry";
import { assignSamplerUnits, bindGlProgram, bindUniformBlock, createGlProgram, deleteGlProgram } from "./gl-program";
import { OPAQUE_STATE, applyRenderState } from "./gl-state";
import { bindTextureUnit, unbindTextureUnits } from "./gl-texture";
import { WORLD_UNIFORMS_BINDING, WORLD_UNIFORM_BYTES } from "./gl-uniform-buffer";
import { TERRAIN_FRAGMENT_GLSL, TERRAIN_VERTEX_GLSL, TERRAIN_VERTICES_PER_CELL } from "./terrain-glsl";
import type { GlPass, GlSampler, GlTexture, GlWrap, WaterGlContext } from "./types";

/** Label used in every error message and in the compiled program. */
const TERRAIN_PASS_LABEL = "terrain";

/**
 * Sampler uniform names, in the order that fixes their texture units. The names
 * match the WGSL binding names one-to-one (docs/webgl2-port/contract.md §3.2).
 */
const TERRAIN_SAMPLERS = ["terrainField", "waterState", "mediumField0", "mediumField1", "shortField0", "shortField1"] as const;

/** Everything one terrain draw consumes. All resources are engine-owned. */
export interface TerrainDrawInput {
  /**
   * Grid resolution of this frame's mesh — `shore ? 512 : meshResolution`,
   * resolved by the engine. It must equal the value written into
   * `environment.y`, because the vertex shader derives the cell grid from that
   * uniform while the draw count comes from here.
   */
  readonly meshResolution: number;
  /** 513² RGBA16F terrain field: R = height, GB = slope, sampled with `fieldSampler`. */
  readonly terrain: GlTexture;
  /** Latest shallow-water state (`waterState.source()`), sampled with `fieldSampler`. */
  readonly waterState: GlTexture;
  /** Cascade 1 field0 (`spectralFields[1].at(0).color[0]`), `spectrumSampler`. */
  readonly mediumField0: GlTexture;
  /** Cascade 1 field1 (`spectralFields[1].at(0).color[1]`), `spectrumSampler`. */
  readonly mediumField1: GlTexture;
  /** Cascade 2 field0 (`spectralFields[2].at(0).color[0]`), `spectrumSampler`. */
  readonly shortField0: GlTexture;
  /** Cascade 2 field1 (`spectralFields[2].at(0).color[1]`), `spectrumSampler`. */
  readonly shortField1: GlTexture;
  /** clamp + linear — the WGSL `fieldSampler`. */
  readonly fieldSampler: GlSampler;
  /** repeat + linear — the WGSL `spectrumSampler`. */
  readonly spectrumSampler: GlSampler;
}

/** The terrain pass: one draw per frame plus disposal. */
export interface TerrainPass extends GlPass {
  /** Draws the terrain into the currently bound framebuffer. */
  draw(input: TerrainDrawInput): void;
}

/**
 * Vertices in a `resolution × resolution` terrain draw: two triangles per cell.
 * Shore scene: 512² × 6 = 1 572 864 (docs/webgl2-port/spec-engine.md §3.2).
 */
export function terrainVertexCount(meshResolution: number): number {
  if (!Number.isInteger(meshResolution) || meshResolution <= 0) {
    throw new Error(`地形网格分辨率必须是正整数，收到 ${String(meshResolution)}。`);
  }
  return meshResolution * meshResolution * TERRAIN_VERTICES_PER_CELL;
}

function requireSampler(sampler: GlSampler, wrap: GlWrap, role: string): GlSampler {
  if (sampler.wrap !== wrap || sampler.filter !== "linear") {
    throw new Error(
      `地形 pass 的 ${role} 必须是 ${wrap} + linear 采样器，` +
        `收到「${sampler.label}」（${sampler.wrap} + ${sampler.filter}）。`,
    );
  }
  return sampler;
}

/**
 * Compiles the terrain program and returns its pass. Throws (in Chinese) on
 * shader compile/link failure or a missing `WorldUniforms` block.
 */
export function createTerrainPass(ctx: WaterGlContext): TerrainPass {
  const { gl } = ctx;
  const program = createGlProgram(gl, {
    label: TERRAIN_PASS_LABEL,
    vertexSource: TERRAIN_VERTEX_GLSL,
    fragmentSource: TERRAIN_FRAGMENT_GLSL,
  });
  let vao: WebGLVertexArrayObject;
  let units: Readonly<Record<(typeof TERRAIN_SAMPLERS)[number], number>>;
  try {
    bindUniformBlock(gl, program, "WorldUniforms", WORLD_UNIFORMS_BINDING, WORLD_UNIFORM_BYTES);
    units = assignSamplerUnits(gl, program, TERRAIN_SAMPLERS);
    vao = createEmptyVao(gl);
  } catch (error) {
    deleteGlProgram(gl, program);
    throw error;
  }

  // The only mutable state in the pass: whether its GL objects still exist.
  let disposed = false;

  return Object.freeze({
    draw(input: TerrainDrawInput): void {
      if (disposed) throw new Error("地形 pass 已释放，无法再绘制。");
      const vertexCount = terrainVertexCount(input.meshResolution);
      const fieldSampler = requireSampler(input.fieldSampler, "clamp", "fieldSampler");
      const spectrumSampler = requireSampler(input.spectrumSampler, "repeat", "spectrumSampler");
      applyRenderState(gl, OPAQUE_STATE);
      bindGlProgram(gl, program);
      bindVao(gl, vao);
      bindTextureUnit(gl, units.terrainField, input.terrain, fieldSampler);
      bindTextureUnit(gl, units.waterState, input.waterState, fieldSampler);
      bindTextureUnit(gl, units.mediumField0, input.mediumField0, spectrumSampler);
      bindTextureUnit(gl, units.mediumField1, input.mediumField1, spectrumSampler);
      bindTextureUnit(gl, units.shortField0, input.shortField0, spectrumSampler);
      bindTextureUnit(gl, units.shortField1, input.shortField1, spectrumSampler);
      drawProcedural(gl, vertexCount);
      // Every input here is another pass's render target (the terrain field, the
      // simulation state, four cascade fields). Release the units so the next
      // frame's GPGPU writes never depend on an implicit unbind elsewhere.
      unbindTextureUnits(gl, TERRAIN_SAMPLERS.map((name) => units[name]));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      disposeVao(gl, vao);
      deleteGlProgram(gl, program);
    },
  });
}

// Static terrain field pass — the WebGL2 stand-in for the `buildTerrain`
// compute dispatch (docs/webgl2-port/spec-compute.md §3.1, engine:2351-2358).
//
// It owns the 513x513 rgba16f `terrainField` texture, which every other pass
// only ever reads: the shallow-water solver with `texelFetch` (nearest), the
// breaker events and the terrain / water render passes with clamp+linear
// sampling. The WebGPU engine runs the dispatch exactly once per scene, gated
// by `terrainPrepared`; `build()` is the equivalent and the engine decides when
// to call it (on init, on `setScene`, and after `allocateFields`).
//
// Both shader inputs — `terrain.x` (extent) and `environment.x` (shore mix) —
// come from the WorldUniforms block, so `build()` takes no arguments; the
// engine only has to have written the UBO for the current scene first.

import { TERRAIN_FIELD_RESOLUTION } from "../water-constants";
import { bindFramebufferForDraw, createGlFramebuffer, disposeFramebuffer } from "./gl-framebuffer";
import { FULLSCREEN_TRIANGLE_VERTEX_GLSL, drawFullscreenTriangle } from "./gl-geometry";
import { bindGlProgram, bindUniformBlock, createGlProgram, deleteGlProgram, uniformLocations } from "./gl-program";
import { COMPUTE_STATE, applyRenderState } from "./gl-state";
import { createTexture2D, disposeTexture } from "./gl-texture";
import { WORLD_UNIFORMS_BINDING, WORLD_UNIFORM_BYTES } from "./gl-uniform-buffer";
import type { GlFramebuffer, GlPass, GlProgram, GlTexture, WaterGlContext } from "./types";
import { TERRAIN_FIELD_FRAGMENT_GLSL } from "./terrain-field-glsl";

/**
 * Side of the terrain texture: the field is `TERRAIN_FIELD_RESOLUTION` cells
 * wide, so it needs one more sample per axis (engine:1988-1989).
 */
export const TERRAIN_FIELD_TEXTURE_SIZE = TERRAIN_FIELD_RESOLUTION + 1;

/** Static terrain height + normal field, built once per scene. */
export interface TerrainFieldPass extends GlPass {
  /** 513x513 rgba16f `(height, N.x, N.z, 0)`; filterable, clamp-to-edge. */
  readonly texture: GlTexture;
  /** Renders the field. Idempotent — call it whenever the scene invalidates. */
  build(): void;
}

interface TerrainResources {
  readonly texture: GlTexture;
  readonly framebuffer: GlFramebuffer;
  readonly program: GlProgram;
}

/** Allocates target + program, unwinding whatever already succeeded on failure. */
function createTerrainResources(gl: WebGL2RenderingContext, size: number): TerrainResources {
  const texture = createTexture2D(gl, {
    label: "terrainField",
    width: size,
    height: size,
    format: "rgba16f",
    minFilter: "linear",
    magFilter: "linear",
    wrap: "clamp",
  });
  try {
    const framebuffer = createGlFramebuffer(gl, { label: "terrainField", color: [texture] });
    try {
      const program = createGlProgram(gl, {
        label: "terrainField · buildTerrain",
        vertexSource: FULLSCREEN_TRIANGLE_VERTEX_GLSL,
        fragmentSource: TERRAIN_FIELD_FRAGMENT_GLSL,
      });
      bindUniformBlock(gl, program, "WorldUniforms", WORLD_UNIFORMS_BINDING, WORLD_UNIFORM_BYTES);
      return { texture, framebuffer, program };
    } catch (error) {
      disposeFramebuffer(gl, framebuffer, false);
      throw error;
    }
  } catch (error) {
    disposeTexture(gl, texture);
    throw error;
  }
}

/**
 * Creates the terrain field pass. Throws a readable error when the shader
 * fails to compile or the 513x513 rgba16f target is not renderable (the
 * context factory already requires `EXT_color_buffer_float`).
 */
export function createTerrainFieldPass(ctx: WaterGlContext): TerrainFieldPass {
  const { gl } = ctx;
  const size = TERRAIN_FIELD_TEXTURE_SIZE;
  if (ctx.limits.maxTextureSize < size) {
    throw new Error(`当前设备的最大纹理尺寸为 ${ctx.limits.maxTextureSize}，无法创建 ${size}×${size} 的地形场纹理。`);
  }
  const { texture, framebuffer, program } = createTerrainResources(gl, size);
  const uniforms = uniformLocations(gl, program, ["uFieldDims"] as const);
  let disposed = false;

  return Object.freeze({
    texture,
    build: () => {
      if (disposed) throw new Error("地形场 pass 已释放，无法再次构建。");
      applyRenderState(gl, COMPUTE_STATE);
      bindGlProgram(gl, program);
      bindFramebufferForDraw(gl, framebuffer);
      gl.uniform2i(uniforms.uFieldDims, size, size);
      drawFullscreenTriangle(gl);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      deleteGlProgram(gl, program);
      disposeFramebuffer(gl, framebuffer);
    },
  });
}

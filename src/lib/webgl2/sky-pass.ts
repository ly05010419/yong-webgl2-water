// Sky render pass (docs/webgl2-port/spec-engine.md §3.1, WebGPU pipeline `webgpu-water-engine.ts@7dbf39c:1920-1927`,
// draw at 2401). One attribute-less full-screen triangle, depth test on with
// `ALWAYS` and no depth write, no blending, no textures — its only binding is
// `WorldUniforms` at UBO binding 0, which the engine fills and binds once.
//
// The pass owns nothing but its program and its own empty VAO; the caller owns
// the render target, so `draw()` must be issued while the scene framebuffer is
// bound (docs/webgl2-port/contract.md §3.5 step 1).

import { drawProcedural, bindVao, createEmptyVao, disposeVao } from "./gl-geometry";
import { bindGlProgram, bindUniformBlock, createGlProgram, deleteGlProgram } from "./gl-program";
import { SKY_STATE, applyRenderState } from "./gl-state";
import { WORLD_UNIFORMS_BINDING, WORLD_UNIFORM_BYTES } from "./gl-uniform-buffer";
import { SKY_FRAGMENT_GLSL, SKY_VERTEX_COUNT, SKY_VERTEX_GLSL } from "./sky-glsl";
import type { GlPass, WaterGlContext } from "./types";

/** Label used in every error message and in the compiled program. */
const SKY_PASS_LABEL = "sky";

/** The sky pass: a single parameter-less draw plus disposal. */
export interface SkyPass extends GlPass {
  /**
   * Draws the sky into the currently bound framebuffer. Expects
   * `WorldUniforms` to be live at binding 0 and the viewport to be set by the
   * caller's `bindFramebufferForDraw`.
   */
  draw(): void;
}

/**
 * Compiles the sky program and returns its pass. Throws (in Chinese) when the
 * shader fails to compile/link or when `WorldUniforms` is missing from the
 * linked program.
 */
export function createSkyPass(ctx: WaterGlContext): SkyPass {
  const { gl } = ctx;
  const program = createGlProgram(gl, {
    label: SKY_PASS_LABEL,
    vertexSource: SKY_VERTEX_GLSL,
    fragmentSource: SKY_FRAGMENT_GLSL,
  });
  let vao: WebGLVertexArrayObject;
  try {
    bindUniformBlock(gl, program, "WorldUniforms", WORLD_UNIFORMS_BINDING, WORLD_UNIFORM_BYTES);
    vao = createEmptyVao(gl);
  } catch (error) {
    deleteGlProgram(gl, program);
    throw error;
  }

  // The only mutable state in the pass: whether its GL objects still exist.
  let disposed = false;

  return Object.freeze({
    draw(): void {
      if (disposed) throw new Error("天空 pass 已释放，无法再绘制。");
      applyRenderState(gl, SKY_STATE);
      bindGlProgram(gl, program);
      bindVao(gl, vao);
      drawProcedural(gl, SKY_VERTEX_COUNT);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      disposeVao(gl, vao);
      deleteGlProgram(gl, program);
    },
  });
}

// Procedural-draw helpers. The engine owns no vertex buffers at all:
// sky / terrain / water / blit / every GPGPU pass generate their vertices from
// `gl_VertexID` (+ `gl_InstanceID` for the clipmap). WebGL2 requires a bound,
// non-default VAO for that to be well defined on every driver.

/**
 * Vertex shader body for a full-screen triangle (WGSL `skyVertex` / `blitVertex`
 * analogue). Vertex ids 0,1,2 → NDC (-1,-1), (3,-1), (-1,3).
 *
 * Outputs:
 * - `vNdc` — clip-space xy, what the sky shader turns into a view ray;
 * - `vUv`  — `ndc * 0.5 + 0.5`, i.e. **GL convention, origin bottom-left**.
 *   The WGSL blit used `0.5 - y*0.5` because WebGPU textures are top-left; here
 *   the plain `+` is correct because GL textures are bottom-left as well.
 *
 * `FULLSCREEN_Z` may be overridden with a `#define`, but nothing does today:
 * every consumer is a GPGPU pass that keeps the default 0, and the sky — the
 * one stage that needs a depth just short of the far plane — builds its own
 * vertices in `SKY_VERTEX_GLSL` rather than reusing this body.
 */
export const FULLSCREEN_TRIANGLE_VERTEX_GLSL = /* glsl */ `
#ifndef FULLSCREEN_Z
#define FULLSCREEN_Z 0.0
#endif
out vec2 vNdc;
out vec2 vUv;
void main() {
  float x = float((gl_VertexID & 1) * 4 - 1);
  float y = float((gl_VertexID & 2) * 2 - 1);
  vNdc = vec2(x, y);
  vUv = vNdc * 0.5 + 0.5;
  gl_Position = vec4(vNdc, FULLSCREEN_Z, 1.0);
}
`;

/** Vertex count of the full-screen triangle. */
export const FULLSCREEN_TRIANGLE_VERTEX_COUNT = 3;

/**
 * Creates the (attribute-less) VAO that every procedural draw must have bound.
 * One VAO per engine is enough — bind it once after context creation and
 * rebind after any code path that binds another VAO.
 */
export function createEmptyVao(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error("无法创建顶点数组对象（VAO），程序化绘制需要它。");
  return vao;
}

/** Binds a VAO (or unbinds with `null`). */
export function bindVao(gl: WebGL2RenderingContext, vao: WebGLVertexArrayObject | null): void {
  gl.bindVertexArray(vao);
}

/** Deletes a VAO. */
export function disposeVao(gl: WebGL2RenderingContext, vao: WebGLVertexArrayObject): void {
  gl.deleteVertexArray(vao);
}

/** Issues the 3-vertex full-screen draw. Requires a bound VAO and program. */
export function drawFullscreenTriangle(gl: WebGL2RenderingContext): void {
  gl.drawArrays(gl.TRIANGLES, 0, FULLSCREEN_TRIANGLE_VERTEX_COUNT);
}

/**
 * Procedural triangle-list draw: `drawArrays` when `instanceCount === 1`,
 * `drawArraysInstanced` otherwise (the water clipmap uses 24576 × 10).
 */
export function drawProcedural(gl: WebGL2RenderingContext, vertexCount: number, instanceCount = 1): void {
  if (!Number.isInteger(vertexCount) || vertexCount <= 0) throw new Error(`程序化绘制的顶点数必须是正整数，收到 ${vertexCount}。`);
  if (!Number.isInteger(instanceCount) || instanceCount <= 0) throw new Error(`程序化绘制的实例数必须是正整数，收到 ${instanceCount}。`);
  if (instanceCount === 1) {
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
    return;
  }
  gl.drawArraysInstanced(gl.TRIANGLES, 0, vertexCount, instanceCount);
}

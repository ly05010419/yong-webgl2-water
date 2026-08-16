// Uniform buffer objects. Convention (contract §UBO): binding index 0 is
// always the 256-byte WorldUniforms block; passes that own extra blocks
// (SimulationParams, FFT params) take indices ≥ 1.

import type { GlUniformBuffer } from "./types";

/** UBO binding index reserved for `WorldUniforms` in every program. */
export const WORLD_UNIFORMS_BINDING = 0;

/** std140 size of `WorldUniforms`: mat4 (64 B) + 12 × vec4 (192 B). */
export const WORLD_UNIFORM_BYTES = 256;

const STD140_ALIGNMENT = 16;

/**
 * Allocates a UBO of `byteLength` bytes (`DYNAMIC_DRAW`, zero-filled).
 * `byteLength` must be a positive multiple of 16 (std140 rounds every block
 * to vec4 alignment, so anything else means the CPU layout is wrong).
 */
export function createUniformBuffer(gl: WebGL2RenderingContext, byteLength: number, label: string): GlUniformBuffer {
  if (!Number.isInteger(byteLength) || byteLength <= 0 || byteLength % STD140_ALIGNMENT !== 0) {
    throw new Error(`uniform 缓冲「${label}」的大小必须是 16 的正整数倍，收到 ${byteLength}。`);
  }
  const handle = gl.createBuffer();
  if (!handle) throw new Error(`无法创建 uniform 缓冲「${label}」。`);
  gl.bindBuffer(gl.UNIFORM_BUFFER, handle);
  gl.bufferData(gl.UNIFORM_BUFFER, byteLength, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.UNIFORM_BUFFER, null);
  return Object.freeze({ label, handle, byteLength });
}

/**
 * Uploads `data` at `byteOffset` (the `queue.writeBuffer` analogue). Throws
 * when the write would overflow the buffer.
 */
export function updateUniformBuffer(gl: WebGL2RenderingContext, buffer: GlUniformBuffer, data: ArrayBufferView, byteOffset = 0): void {
  if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset + data.byteLength > buffer.byteLength) {
    throw new Error(`写入 uniform 缓冲「${buffer.label}」越界：偏移 ${byteOffset} + ${data.byteLength} 字节 > ${buffer.byteLength}。`);
  }
  gl.bindBuffer(gl.UNIFORM_BUFFER, buffer.handle);
  gl.bufferSubData(gl.UNIFORM_BUFFER, byteOffset, data);
  gl.bindBuffer(gl.UNIFORM_BUFFER, null);
}

/**
 * Binds the whole buffer to UBO binding point `index`. Programs reach it via
 * `bindUniformBlock(gl, program, blockName, index)`. Binding-point state is
 * global (not per program), so bind once per frame per index, not per draw.
 */
export function bindUniformBufferBase(gl: WebGL2RenderingContext, index: number, buffer: GlUniformBuffer): void {
  if (!Number.isInteger(index) || index < 0) throw new Error(`UBO 绑定点必须是非负整数，收到 ${index}（${buffer.label}）。`);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, index, buffer.handle);
}

/** Deletes the buffer. */
export function disposeUniformBuffer(gl: WebGL2RenderingContext, buffer: GlUniformBuffer): void {
  gl.deleteBuffer(buffer.handle);
}

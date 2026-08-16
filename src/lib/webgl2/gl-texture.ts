// Texture and sampler helpers for the WebGL2 water fallback.
//
// Textures are allocated with immutable storage (`texStorage2D`, one mip
// level) and given a complete base sampling state so they are usable even
// without a sampler object. Sampler Objects (`createGlSampler`) reproduce the
// WebGPU decoupling of sampler state from textures (docs/webgl2-port/spec-compute.md R16): the same
// texture is sampled with clamp/linear in one pass and repeat/linear in another.

import {
  bindCachedTextureUnit,
  forgetGlSampler,
  forgetGlTexture,
  noteActiveUnitTextureBinding,
} from "./gl-state-cache";
import type { GlFilter, GlSampler, GlTexture, GlTextureFormat, GlWrap } from "./types";

/** Static description of a supported sized format. Pure data, unit-testable. */
export interface TextureFormatInfo {
  readonly internalFormat: number;
  readonly format: number;
  /** Default upload type: HALF_FLOAT for rgba16f, FLOAT for rgba32f, UNSIGNED_BYTE for 8-bit, UNSIGNED_INT for depth. */
  readonly type: number;
  readonly bytesPerTexel: number;
  readonly isDepth: boolean;
  /** LINEAR is legal without any extension. */
  readonly filterableByDefault: boolean;
  /** Renderable only with EXT_color_buffer_float. */
  readonly needsFloatColorBuffer: boolean;
}

// GL enum values (identical on every WebGL2 implementation; kept literal so the
// table stays a pure constant usable in node tests).
const GL_RGBA = 0x1908;
const GL_DEPTH_COMPONENT = 0x1902;
const GL_UNSIGNED_BYTE = 0x1401;
const GL_UNSIGNED_INT = 0x1405;
const GL_FLOAT = 0x1406;
const GL_HALF_FLOAT = 0x140b;
const GL_RGBA8 = 0x8058;
const GL_SRGB8_ALPHA8 = 0x8c43;
const GL_RGBA16F = 0x881a;
const GL_RGBA32F = 0x8814;
const GL_DEPTH_COMPONENT24 = 0x81a6;

const FORMAT_TABLE: Readonly<Record<GlTextureFormat, TextureFormatInfo>> = Object.freeze({
  rgba16f: Object.freeze({ internalFormat: GL_RGBA16F, format: GL_RGBA, type: GL_HALF_FLOAT, bytesPerTexel: 8, isDepth: false, filterableByDefault: true, needsFloatColorBuffer: true }),
  rgba32f: Object.freeze({ internalFormat: GL_RGBA32F, format: GL_RGBA, type: GL_FLOAT, bytesPerTexel: 16, isDepth: false, filterableByDefault: false, needsFloatColorBuffer: true }),
  rgba8: Object.freeze({ internalFormat: GL_RGBA8, format: GL_RGBA, type: GL_UNSIGNED_BYTE, bytesPerTexel: 4, isDepth: false, filterableByDefault: true, needsFloatColorBuffer: false }),
  srgb8a8: Object.freeze({ internalFormat: GL_SRGB8_ALPHA8, format: GL_RGBA, type: GL_UNSIGNED_BYTE, bytesPerTexel: 4, isDepth: false, filterableByDefault: true, needsFloatColorBuffer: false }),
  depth24: Object.freeze({ internalFormat: GL_DEPTH_COMPONENT24, format: GL_DEPTH_COMPONENT, type: GL_UNSIGNED_INT, bytesPerTexel: 4, isDepth: true, filterableByDefault: false, needsFloatColorBuffer: false }),
});

/** Returns the static format description (pure). */
export function textureFormatInfo(format: GlTextureFormat): TextureFormatInfo {
  return FORMAT_TABLE[format];
}

/** Options for `createTexture2D`. */
export interface CreateTexture2DOptions {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly format: GlTextureFormat;
  /** Initial contents. Typed array (Float32Array / Uint16Array / Uint8Array) or an ImageBitmap for 8-bit formats. */
  readonly data?: ArrayBufferView | ImageBitmap | null;
  /** Base texture state; a bound sampler object overrides it. Defaults: rgba32f/depth24 → nearest, else linear. */
  readonly minFilter?: GlFilter;
  readonly magFilter?: GlFilter;
  /** Base wrap state; default clamp. */
  readonly wrap?: GlWrap;
}

function glFilter(gl: WebGL2RenderingContext, filter: GlFilter): number {
  return filter === "linear" ? gl.LINEAR : gl.NEAREST;
}

function glWrap(gl: WebGL2RenderingContext, wrap: GlWrap): number {
  return wrap === "repeat" ? gl.REPEAT : gl.CLAMP_TO_EDGE;
}

function assertDimensions(gl: WebGL2RenderingContext, label: string, width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`纹理「${label}」的尺寸必须是正整数，收到 ${width}×${height}。`);
  }
  const maxSize: unknown = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (typeof maxSize === "number" && (width > maxSize || height > maxSize)) {
    throw new Error(`纹理「${label}」的尺寸 ${width}×${height} 超过当前设备上限 ${maxSize}。`);
  }
}

function isFloatLinearAvailable(gl: WebGL2RenderingContext): boolean {
  return gl.getExtension("OES_texture_float_linear") !== null;
}

type UploadArray = Float32Array | Uint16Array | Uint8Array | Uint8ClampedArray;

/** Picks the upload `type` for a typed array and validates it against the format. */
function uploadTypeFor(label: string, format: GlTextureFormat, data: ArrayBufferView): { readonly type: number; readonly array: UploadArray } {
  const info = FORMAT_TABLE[format];
  if (info.isDepth) throw new Error(`深度纹理「${label}」不支持 CPU 上传数据。`);
  if (data instanceof Float32Array) {
    if (format === "rgba16f" || format === "rgba32f") return { type: GL_FLOAT, array: data };
    throw new Error(`纹理「${label}」（${format}）不能用 Float32Array 上传，请使用 Uint8Array。`);
  }
  if (data instanceof Uint16Array) {
    if (format === "rgba16f") return { type: GL_HALF_FLOAT, array: data };
    throw new Error(`纹理「${label}」（${format}）不能用 Uint16Array（半精度）上传。`);
  }
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
    if (format === "rgba8" || format === "srgb8a8") return { type: GL_UNSIGNED_BYTE, array: data };
    throw new Error(`纹理「${label}」（${format}）不能用 Uint8Array 上传，请使用 Float32Array 或 Uint16Array。`);
  }
  throw new Error(`纹理「${label}」收到不支持的数据类型：${data.constructor.name}。`);
}

function assertDataLength(label: string, array: UploadArray, width: number, height: number): void {
  const required = width * height * 4;
  if (array.length < required) {
    throw new Error(`纹理「${label}」的数据长度不足：需要 ${required} 个分量（${width}×${height}×4），收到 ${array.length}。`);
  }
}

function setUnpackState(gl: WebGL2RenderingContext): void {
  // Deterministic upload state: no Y flip (WGSL and GLSL agree on row 0 being
  // the first row of the buffer), no premultiply, no colour-space conversion
  // (matches createImageBitmap({ colorSpaceConversion: "none" })).
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
}

/**
 * Creates an immutable-storage 2D texture with one mip level. Depth textures
 * refuse initial data; `rgba32f` refuses linear filtering unless
 * `OES_texture_float_linear` is present. Leaves the texture bound to
 * `TEXTURE_2D` on the current active unit.
 */
export function createTexture2D(gl: WebGL2RenderingContext, options: CreateTexture2DOptions): GlTexture {
  const { label, width, height, format } = options;
  assertDimensions(gl, label, width, height);
  const info = FORMAT_TABLE[format];
  const filterable = info.filterableByDefault || (format === "rgba32f" && isFloatLinearAvailable(gl));
  const defaultFilter: GlFilter = filterable ? "linear" : "nearest";
  const minFilter = options.minFilter ?? defaultFilter;
  const magFilter = options.magFilter ?? defaultFilter;
  if (!filterable && (minFilter === "linear" || magFilter === "linear")) {
    throw new Error(`纹理「${label}」（${format}）不可线性过滤，请改用 nearest（rgba32f 需要 OES_texture_float_linear，深度纹理只能 texelFetch）。`);
  }
  const handle = gl.createTexture();
  if (!handle) throw new Error(`无法创建纹理对象「${label}」。`);
  gl.bindTexture(gl.TEXTURE_2D, handle);
  // Binds on whatever unit is active; the cache has to learn about it or it
  // would later skip a `bindTextureUnit` for that unit (docs/webgl2-port/contract.md §3.7).
  noteActiveUnitTextureBinding(gl, handle);
  gl.texStorage2D(gl.TEXTURE_2D, 1, info.internalFormat, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, glFilter(gl, minFilter));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, glFilter(gl, magFilter));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, glWrap(gl, options.wrap ?? "clamp"));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, glWrap(gl, options.wrap ?? "clamp"));
  if (info.isDepth) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.NONE);
  const texture: GlTexture = Object.freeze({ label, handle, width, height, format, filterable });
  if (options.data) uploadTexture2D(gl, texture, options.data);
  return texture;
}

/** Sub-rectangle for `uploadTexture2D`; defaults to the whole texture. */
export interface UploadRegion {
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
}

/**
 * Uploads CPU data into an existing texture (the `queue.writeTexture` analogue).
 * Float32Array → rgba16f/rgba32f, Uint16Array (IEEE half) → rgba16f,
 * Uint8Array / ImageBitmap → rgba8/srgb8a8. Leaves the texture bound.
 */
export function uploadTexture2D(
  gl: WebGL2RenderingContext,
  texture: GlTexture,
  data: ArrayBufferView | ImageBitmap,
  region: UploadRegion = {},
): void {
  const x = region.x ?? 0;
  const y = region.y ?? 0;
  const width = region.width ?? texture.width - x;
  const height = region.height ?? texture.height - y;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > texture.width || y + height > texture.height) {
    throw new Error(`纹理「${texture.label}」的上传区域 (${x},${y}) ${width}×${height} 超出 ${texture.width}×${texture.height}。`);
  }
  const info = FORMAT_TABLE[texture.format];
  gl.bindTexture(gl.TEXTURE_2D, texture.handle);
  noteActiveUnitTextureBinding(gl, texture.handle);
  setUnpackState(gl);
  if (ArrayBuffer.isView(data)) {
    const upload = uploadTypeFor(texture.label, texture.format, data);
    assertDataLength(texture.label, upload.array, width, height);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, info.format, upload.type, upload.array);
    return;
  }
  if (texture.format !== "rgba8" && texture.format !== "srgb8a8") {
    throw new Error(`纹理「${texture.label}」（${texture.format}）不能从 ImageBitmap 上传。`);
  }
  if (data.width !== width || data.height !== height) {
    throw new Error(`纹理「${texture.label}」的 ImageBitmap 尺寸 ${data.width}×${data.height} 与目标区域 ${width}×${height} 不符。`);
  }
  gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, info.format, info.type, data);
}

/** Options for `createGlSampler`. */
export interface CreateSamplerOptions {
  readonly label?: string;
  readonly wrap: GlWrap;
  readonly filter: GlFilter;
}

/**
 * Creates a Sampler Object. The engine needs exactly two: `fieldSampler`
 * (clamp/linear) and `spectrumSampler` (repeat/linear); a nearest variant is
 * used for `rgba32f` inputs when they must go through a sampler at all.
 */
export function createGlSampler(gl: WebGL2RenderingContext, options: CreateSamplerOptions): GlSampler {
  const handle = gl.createSampler();
  if (!handle) throw new Error(`无法创建采样器对象「${options.label ?? "sampler"}」。`);
  gl.samplerParameteri(handle, gl.TEXTURE_MIN_FILTER, glFilter(gl, options.filter));
  gl.samplerParameteri(handle, gl.TEXTURE_MAG_FILTER, glFilter(gl, options.filter));
  gl.samplerParameteri(handle, gl.TEXTURE_WRAP_S, glWrap(gl, options.wrap));
  gl.samplerParameteri(handle, gl.TEXTURE_WRAP_T, glWrap(gl, options.wrap));
  return Object.freeze({
    label: options.label ?? `${options.wrap}/${options.filter}`,
    handle,
    wrap: options.wrap,
    filter: options.filter,
  });
}

/**
 * Binds `texture` (and optionally `sampler`) to texture unit `unit`. Pass a
 * `null` sampler to fall back to the texture's own base state (needed for
 * `texelFetch`-only inputs, which ignore sampling state anyway).
 * Throws when a linear sampler is paired with a non-filterable texture.
 *
 * Goes through `./gl-state-cache`, so a unit that already holds this exact
 * texture/sampler pair costs nothing — the FFT rebinding one twiddle table 14
 * times and the water pass rebinding twelve inputs for its second draw both
 * collapse to zero calls.
 */
export function bindTextureUnit(gl: WebGL2RenderingContext, unit: number, texture: GlTexture, sampler: GlSampler | null = null): void {
  if (!Number.isInteger(unit) || unit < 0) throw new Error(`纹理单元索引必须是非负整数，收到 ${unit}（${texture.label}）。`);
  if (sampler && sampler.filter === "linear" && !texture.filterable) {
    throw new Error(`纹理「${texture.label}」（${texture.format}）不可线性过滤，却绑定了线性采样器「${sampler.label}」。`);
  }
  bindCachedTextureUnit(gl, unit, texture.handle, sampler ? sampler.handle : null);
}

/**
 * Unbinds whatever is on `unit`. Use before rendering into a texture that was
 * sampled by the previous pass — WebGL2 treats a texture that is both an FBO
 * attachment and a bound sampler input as a feedback loop (docs/webgl2-port/spec-compute.md R4).
 */
export function unbindTextureUnit(gl: WebGL2RenderingContext, unit: number): void {
  bindCachedTextureUnit(gl, unit, null, null);
}

/**
 * Unbinds a whole list of units in one call — the shape every pass needs when
 * it releases the units it bound. Duplicates are harmless (the cache turns a
 * repeat into a no-op), so callers may pass a plain `names.map(...)` without
 * deduplicating first.
 */
export function unbindTextureUnits(gl: WebGL2RenderingContext, units: readonly number[]): void {
  for (const unit of units) unbindTextureUnit(gl, unit);
}

/** Deletes the texture. The frozen record must not be used afterwards. */
export function disposeTexture(gl: WebGL2RenderingContext, texture: GlTexture): void {
  gl.deleteTexture(texture.handle);
  // WebGL unbinds a deleted texture from every unit it sat on, so the cache
  // must stop claiming it — otherwise a later texture bound to that unit would
  // be skipped as "already bound".
  forgetGlTexture(gl, texture.handle);
}

/** Deletes the sampler object. */
export function disposeSampler(gl: WebGL2RenderingContext, sampler: GlSampler): void {
  gl.deleteSampler(sampler.handle);
  forgetGlSampler(gl, sampler.handle);
}

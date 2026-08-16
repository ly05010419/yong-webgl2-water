// Framebuffer helpers for the WebGL2 water fallback: MRT creation with
// completeness checks, bind + viewport, explicit zero-initialisation (WebGPU
// zero-fills textures, WebGL2 does not — docs/webgl2-port/spec-compute.md R18), ping-pong pairs
// and framebuffer blits.

import {
  bindCachedDrawFramebuffer,
  bindCachedFramebuffer,
  bindCachedFramebufferForDraw,
  bindCachedReadFramebuffer,
  forgetGlFramebuffer,
  invalidateRenderStateCache,
} from "./gl-state-cache";
import { createTexture2D, disposeTexture, textureFormatInfo } from "./gl-texture";
import { createGlUnwindStack } from "./gl-unwind";
import type { GlFilter, GlFramebuffer, GlTexture, GlTextureFormat, GlWrap, PingPongTargets } from "./types";

/** Options for `createGlFramebuffer`. */
export interface CreateFramebufferOptions {
  readonly label: string;
  /** Colour attachments in `COLOR_ATTACHMENT0..n-1` order (MRT when n > 1). May be empty for depth-only. */
  readonly color: readonly GlTexture[];
  readonly depth?: GlTexture | null;
}

const STATUS_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0x8cd6: "FRAMEBUFFER_INCOMPLETE_ATTACHMENT",
  0x8cd7: "FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT",
  0x8cd9: "FRAMEBUFFER_INCOMPLETE_DIMENSIONS",
  0x8cdd: "FRAMEBUFFER_UNSUPPORTED",
  0x8d56: "FRAMEBUFFER_INCOMPLETE_MULTISAMPLE",
});

function assertAttachments(gl: WebGL2RenderingContext, options: CreateFramebufferOptions): { width: number; height: number } {
  const { label, color } = options;
  const depth = options.depth ?? null;
  const first = color[0] ?? depth;
  if (!first) throw new Error(`帧缓冲「${label}」至少需要一个颜色或深度附件。`);
  const maxDrawBuffers: unknown = gl.getParameter(gl.MAX_DRAW_BUFFERS);
  if (typeof maxDrawBuffers === "number" && color.length > maxDrawBuffers) {
    throw new Error(`帧缓冲「${label}」请求 ${color.length} 个颜色附件，超过设备上限 ${maxDrawBuffers}。`);
  }
  color.forEach((texture, index) => {
    if (textureFormatInfo(texture.format).isDepth) {
      throw new Error(`帧缓冲「${label}」的颜色附件 ${index}（${texture.label}）是深度格式。`);
    }
    if (texture.width !== first.width || texture.height !== first.height) {
      throw new Error(`帧缓冲「${label}」的附件尺寸不一致：${texture.label} 为 ${texture.width}×${texture.height}，首个附件为 ${first.width}×${first.height}。`);
    }
  });
  if (depth) {
    if (!textureFormatInfo(depth.format).isDepth) throw new Error(`帧缓冲「${label}」的深度附件（${depth.label}）不是深度格式。`);
    if (depth.width !== first.width || depth.height !== first.height) {
      throw new Error(`帧缓冲「${label}」的深度附件尺寸 ${depth.width}×${depth.height} 与颜色附件 ${first.width}×${first.height} 不符。`);
    }
  }
  return { width: first.width, height: first.height };
}

/**
 * Creates a framebuffer, attaches every colour texture as
 * `COLOR_ATTACHMENT0 + i`, sets `drawBuffers` accordingly, attaches the depth
 * texture, and throws a Chinese error if the FBO is incomplete. Leaves the
 * new FBO bound to `FRAMEBUFFER`.
 */
export function createGlFramebuffer(gl: WebGL2RenderingContext, options: CreateFramebufferOptions): GlFramebuffer {
  const { label } = options;
  const { width, height } = assertAttachments(gl, options);
  const handle = gl.createFramebuffer();
  if (!handle) throw new Error(`无法创建帧缓冲对象「${label}」。`);
  bindCachedFramebuffer(gl, handle);
  const drawBuffers = options.color.map((texture, index) => {
    const attachment = gl.COLOR_ATTACHMENT0 + index;
    gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, texture.handle, 0);
    return attachment;
  });
  gl.drawBuffers(drawBuffers.length > 0 ? drawBuffers : [gl.NONE]);
  const depth = options.depth ?? null;
  if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth.handle, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    deleteFramebufferHandle(gl, handle);
    const formats = options.color.map((texture) => texture.format).join(", ");
    throw new Error(
      `帧缓冲「${label}」不完整（${STATUS_NAMES[status] ?? `0x${status.toString(16)}`}）：颜色附件 [${formats}]` +
        `${depth ? ` + 深度 ${depth.format}` : ""}，尺寸 ${width}×${height}。` +
        `浮点附件需要 EXT_color_buffer_float。`,
    );
  }
  return Object.freeze({ label, handle, width, height, color: Object.freeze([...options.color]), depth });
}

/**
 * Binds `fbo` (or the default framebuffer when `null`) for drawing and sets
 * the viewport — WebGPU sets the viewport per pass automatically, WebGL2 does
 * not, and the engine hops between 128², 513², sim², 256×1 and canvas-sized
 * targets every frame. `width`/`height` default to the FBO's own size, or to
 * the drawing buffer size for the default framebuffer.
 */
export function bindFramebufferForDraw(
  gl: WebGL2RenderingContext,
  fbo: GlFramebuffer | null,
  width: number = fbo ? fbo.width : gl.drawingBufferWidth,
  height: number = fbo ? fbo.height : gl.drawingBufferHeight,
): void {
  bindCachedFramebufferForDraw(gl, fbo ? fbo.handle : null, width, height);
}

/**
 * Binds the default framebuffer without touching the viewport — what a builder
 * wants after creating an FBO, so it does not leave its scratch target current.
 */
export function unbindFramebuffer(gl: WebGL2RenderingContext): void {
  bindCachedFramebuffer(gl, null);
}

/**
 * `deleteFramebuffer` plus the cache invalidation it implies: WebGL rebinds the
 * default framebuffer when the current one is deleted, so a cache still naming
 * the dead object would skip the next bind of a *different* target.
 */
export function deleteFramebufferHandle(gl: WebGL2RenderingContext, handle: WebGLFramebuffer): void {
  gl.deleteFramebuffer(handle);
  forgetGlFramebuffer(gl, handle);
}

const ZERO_COLOR = new Float32Array([0, 0, 0, 0]);
const ONE_DEPTH = new Float32Array([1]);

/**
 * Clears every colour attachment to (0,0,0,0) and the depth attachment to 1.
 * WebGPU guarantees zero-initialised textures; WebGL2 does not, and an
 * uninitialised NaN in the water state feeds back forever (docs/webgl2-port/spec-compute.md R18).
 * Call once after creating `waterTextures`, `breakerEventTextures` and the
 * spectral field ping-pongs. Leaves scissor disabled and write masks enabled.
 */
export function clearFramebufferToZero(gl: WebGL2RenderingContext, fbo: GlFramebuffer): void {
  bindFramebufferForDraw(gl, fbo);
  gl.disable(gl.SCISSOR_TEST);
  gl.colorMask(true, true, true, true);
  gl.depthMask(true);
  // The three lines above set state `applyRenderState` also owns (`depthMask`
  // in particular is `false` in most presets), so the preset the cache believes
  // is live no longer describes the driver.
  invalidateRenderStateCache(gl);
  fbo.color.forEach((_texture, index) => gl.clearBufferfv(gl.COLOR, index, ZERO_COLOR));
  if (fbo.depth) gl.clearBufferfv(gl.DEPTH, 0, ONE_DEPTH);
}

/** Deletes the FBO and, when `disposeAttachments` is true (default), its textures. */
export function disposeFramebuffer(gl: WebGL2RenderingContext, fbo: GlFramebuffer, disposeAttachments = true): void {
  deleteFramebufferHandle(gl, fbo.handle);
  if (!disposeAttachments) return;
  fbo.color.forEach((texture) => disposeTexture(gl, texture));
  if (fbo.depth) disposeTexture(gl, fbo.depth);
}

/** Options for `createPingPongTargets`. */
export interface PingPongOptions {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  /** One format per colour attachment; length 2 gives the MRT pair the spectral FFT needs. */
  readonly formats: readonly GlTextureFormat[];
  /** Base texture state (a bound sampler object overrides it). */
  readonly minFilter?: GlFilter;
  readonly magFilter?: GlFilter;
  readonly wrap?: GlWrap;
  /** Zero-fill both targets on creation (default true; see R18). */
  readonly clearToZero?: boolean;
}

/**
 * One side of the pair: `formats.length` textures plus the FBO that owns them.
 *
 * The MRT case allocates several textures before the FBO exists, and both
 * `createTexture2D` (out-of-range size, unfilterable format) and
 * `createGlFramebuffer` (incompleteness) throw. Without the unwind stack a throw
 * on the second attachment would strand the first for the life of the context —
 * there is no handle left to delete it with. On success nothing is unwound: the
 * returned FBO takes its attachments down with it in `disposeFramebuffer`.
 */
function createPingPongSide(gl: WebGL2RenderingContext, options: PingPongOptions, side: 0 | 1): GlFramebuffer {
  const stack = createGlUnwindStack();
  try {
    const color = options.formats.map((format, index) =>
      stack.track(
        createTexture2D(gl, {
          label: `${options.label}[${side}].color${index}`,
          width: options.width,
          height: options.height,
          format,
          minFilter: options.minFilter,
          magFilter: options.magFilter,
          wrap: options.wrap,
        }),
        (texture) => disposeTexture(gl, texture),
      ),
    );
    return createGlFramebuffer(gl, { label: `${options.label}[${side}]`, color });
  } catch (error) {
    stack.unwind();
    throw error;
  }
}

/**
 * Both sides, with the same guarantee one level up: a second side that throws
 * (or a `clearFramebufferToZero` that does) releases the first side's FBO
 * *and* its attachments before the error reaches the caller.
 */
function createPingPongPair(gl: WebGL2RenderingContext, options: PingPongOptions): readonly [GlFramebuffer, GlFramebuffer] {
  const stack = createGlUnwindStack();
  try {
    const pair: readonly [GlFramebuffer, GlFramebuffer] = [
      stack.track(createPingPongSide(gl, options, 0), (fbo) => disposeFramebuffer(gl, fbo)),
      stack.track(createPingPongSide(gl, options, 1), (fbo) => disposeFramebuffer(gl, fbo)),
    ];
    if (options.clearToZero ?? true) pair.forEach((target) => clearFramebufferToZero(gl, target));
    return pair;
  } catch (error) {
    stack.unwind();
    throw error;
  }
}

/**
 * Creates two identical FBOs (each with `formats.length` colour attachments).
 * The returned object carries the *only* mutable state in this module: the
 * current source index. It is intentionally tiny and encapsulated — the engine
 * flips `activeSimulationIndex` the same way — and `at(i)` remains available
 * for callers that prefer computing the index themselves (`pass % 2`).
 */
export function createPingPongTargets(gl: WebGL2RenderingContext, options: PingPongOptions): PingPongTargets {
  if (options.formats.length === 0) throw new Error(`乒乓目标「${options.label}」至少需要一个颜色格式。`);
  const targets = createPingPongPair(gl, options);
  // Mutable cursor: 0 or 1. Everything else on the object is frozen.
  let sourceIndex: 0 | 1 = 0;
  return Object.freeze({
    label: options.label,
    width: options.width,
    height: options.height,
    targets,
    index: () => sourceIndex,
    at: (index: 0 | 1) => targets[index],
    source: () => targets[sourceIndex],
    destination: () => targets[sourceIndex === 0 ? 1 : 0],
    swap: () => {
      sourceIndex = sourceIndex === 0 ? 1 : 0;
    },
    reset: () => {
      sourceIndex = 0;
    },
    dispose: () => targets.forEach((target) => disposeFramebuffer(gl, target)),
  });
}

/** What `blitFramebuffer` copies. */
export type BlitMask = "color" | "depth" | "color+depth";

/** Options for `blitFramebuffer`. */
export interface BlitOptions {
  readonly source: GlFramebuffer;
  /** `null` = default framebuffer (the canvas). */
  readonly destination: GlFramebuffer | null;
  readonly mask: BlitMask;
  /** Destination size when `destination` is `null`; defaults to the drawing buffer. */
  readonly destinationWidth?: number;
  readonly destinationHeight?: number;
  /** Only meaningful for colour; depth blits are always NEAREST. */
  readonly filter?: GlFilter;
}

/**
 * Copies colour and/or depth between framebuffers with `gl.blitFramebuffer`.
 * Used for (a) the final offscreen → canvas presentation and (b) duplicating
 * the scene depth so the water pass can sample depth without a feedback loop
 * (docs/webgl2-port/spec-engine.md §8.1.3). Depth blits require identical formats (depth24 →
 * depth24). Leaves READ/DRAW framebuffer bindings on the blit operands.
 */
export function blitFramebuffer(gl: WebGL2RenderingContext, options: BlitOptions): void {
  const { source, destination } = options;
  const dstWidth = options.destinationWidth ?? (destination ? destination.width : gl.drawingBufferWidth);
  const dstHeight = options.destinationHeight ?? (destination ? destination.height : gl.drawingBufferHeight);
  const wantsColor = options.mask !== "depth";
  const wantsDepth = options.mask !== "color";
  if (wantsDepth && (!source.depth || (destination !== null && !destination.depth))) {
    throw new Error(`blit「${source.label}」→「${destination?.label ?? "canvas"}」请求复制深度，但两侧不都持有深度附件。`);
  }
  // The context does ask for `depth: true`, so this blit may well be legal on a
  // given driver — but its precision and format are whatever the implementation
  // chose (`limits.defaultDepthBits`), not the `depth24` the sources use, and a
  // depth blit between mismatched formats is `INVALID_OPERATION`. Nothing in the
  // engine needs it: the one path that renders onto the canvas draws its own
  // depth there. Keep refusing it rather than let a future caller discover the
  // format question at runtime.
  if (wantsDepth && destination === null) {
    throw new Error(`默认帧缓冲的深度附件格式由实现决定，与 depth24 不保证一致，无法把「${source.label}」的深度 blit 到画布。`);
  }
  const mask = (wantsColor ? gl.COLOR_BUFFER_BIT : 0) | (wantsDepth ? gl.DEPTH_BUFFER_BIT : 0);
  const filter = wantsDepth || options.filter === "nearest" ? gl.NEAREST : gl.LINEAR;
  bindCachedReadFramebuffer(gl, source.handle);
  bindCachedDrawFramebuffer(gl, destination ? destination.handle : null);
  gl.blitFramebuffer(0, 0, source.width, source.height, 0, 0, dstWidth, dstHeight, mask, filter);
}

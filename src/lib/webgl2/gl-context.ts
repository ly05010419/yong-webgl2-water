// WebGL2 context acquisition for the Tethys water fallback engine.
//
// Mirrors `WebGpuWaterEngine.init()` steps 1-13 (docs/webgl2-port/spec-engine.md §2): acquire the
// context, verify that float render targets are available in some form, record
// limits, and build the adapter label the UI shows in place of the WebGPU
// adapter string.

import type { ExtDisjointTimerQueryWebgl2, GlLimits, WaterGlContext } from "./types";

/**
 * Attributes chosen to match `context.configure({ alphaMode: "opaque" })` with
 * no MSAA (docs/webgl2-port/spec-engine.md §8.2.8).
 *
 * `depth: true` since F-19: the open scene draws sky, terrain and the
 * water composite straight onto the default framebuffer, so the canvas needs a
 * depth buffer of its own to depth-test against — the same shape the WebGPU
 * engine uses there (scene pass onto the swap chain, water pass `loadOp:
 * "load"` + `depthReadOnly`). The shore scene still renders every pass
 * offscreen, because its water shader samples the scene colour and depth it
 * would otherwise be attached to (§8.1.3), and so does the open scene on a
 * context whose default depth buffer is shallower than the offscreen
 * `depth24` one (`limits.defaultFramebufferDepth`), where the extra precision
 * loss would change the depth tie-break along the water/terrain silhouette.
 */
export const WATER_GL_CONTEXT_ATTRIBUTES: Readonly<WebGLContextAttributes> = Object.freeze({
  alpha: false,
  antialias: false,
  depth: true,
  stencil: false,
  premultipliedAlpha: false,
  powerPreference: "high-performance",
  preserveDrawingBuffer: false,
});

/** Error message shown when the browser cannot hand out a WebGL2 context. */
export const GL_UNSUPPORTED_MESSAGE =
  "当前浏览器不支持 WebGL2。请使用较新版本的浏览器，并确保已启用硬件加速。";

/** Error message shown when neither float-render-target extension is available. */
export const GL_FLOAT_TARGET_MESSAGE =
  "当前 WebGL2 环境缺少 EXT_color_buffer_float 与 EXT_color_buffer_half_float 扩展，无法把谱场与近岸模拟渲染到浮点纹理，水面无法运行。请更新显卡驱动或更换浏览器。";

/** Suffix appended to `adapterLabel` when the renderer string names a software rasteriser. */
export const GL_SOFTWARE_RENDERER_NOTE = "（软件渲染，性能受限）";

const MIN_TEXTURE_SIZE = 513;
const MIN_DRAW_BUFFERS = 2;
const MIN_TEXTURE_UNITS = 12;
/**
 * Bindings 0..4 must be available. The engine itself uses 0 (WorldUniforms) and
 * 1 (SimulationParams); the floor is kept at five so the context check matches
 * the one the full renderer applies and no machine passes here but fails there.
 */
const MIN_UNIFORM_BUFFER_BINDINGS = 5;
/**
 * Depth precision the default framebuffer must reach before the open scene may
 * be drawn straight onto it. The offscreen path depth-tests against a `depth24`
 * texture, so anything shallower (a 16-bit default buffer, which the WebGL spec
 * permits when `depth: true` is only a *preference*) would resolve the
 * water-against-terrain comparisons differently and cost
 * the two paths their pixel-for-pixel equality. Such a context keeps the
 * offscreen route instead — slower, but identical.
 */
const MIN_DEFAULT_DEPTH_BITS = 24;

/**
 * Renderer substrings that identify a CPU rasteriser. Matched case-insensitively
 * and only used to annotate the label — the engine still starts, because a slow
 * picture beats no picture and the caller may only be taking a screenshot.
 */
const SOFTWARE_RENDERER_MARKERS: readonly string[] = Object.freeze(["swiftshader", "llvmpipe", "software"]);

/** Typed wrapper around `getExtension`, which the DOM lib types as `any` for unknown names. */
function getTypedExtension<T>(gl: WebGL2RenderingContext, name: string): T | null {
  const extension: unknown = gl.getExtension(name);
  return extension === null || extension === undefined ? null : (extension as T);
}

function readIntParameter(gl: WebGL2RenderingContext, parameter: number, label: string): number {
  const value: unknown = gl.getParameter(parameter);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`无法读取 WebGL2 限制 ${label}（返回值：${String(value)}）。`);
  }
  return value;
}

/**
 * `DEPTH_BITS` of the framebuffer that is current when this runs — always the
 * default one, because `createWaterGlContext` reads the limits before anything
 * binds an FBO.
 *
 * Deliberately lenient where `readIntParameter` throws: a driver that answers
 * with `null` (the query is legacy in ES 3.0, where the modern spelling is
 * `getFramebufferAttachmentParameter`) is reported as 0 bits, which only means
 * the open scene keeps the offscreen path. Refusing to start over a diagnostic
 * query would be a far worse trade.
 */
function readDefaultDepthBits(gl: WebGL2RenderingContext): number {
  const value: unknown = gl.getParameter(gl.DEPTH_BITS);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

function readViewportDims(gl: WebGL2RenderingContext): readonly [number, number] {
  const value: unknown = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  if (value instanceof Int32Array && value.length >= 2) return [value[0], value[1]];
  return [MIN_TEXTURE_SIZE, MIN_TEXTURE_SIZE];
}

/**
 * Snapshots the implementation limits. Only `maxTextureSize`, `maxDrawBuffers` /
 * `maxColorAttachments`, the two texture-unit counts and
 * `maxUniformBufferBindings` gate startup (`assertLimits`); every other field —
 * `maxCombinedTextureImageUnits`, `maxUniformBlockSize`, `maxRenderbufferSize`
 * and the viewport pair — is recorded for diagnostics only and is never
 * asserted, because nothing in the engine can exceed them at the sizes it uses.
 *
 * `defaultDepthBits` is the one entry that steers behaviour without gating
 * startup: it decides whether the open scene renders onto the canvas directly
 * (`defaultFramebufferDepth`) or keeps the offscreen route.
 */
function readLimits(gl: WebGL2RenderingContext, floatLinearFilter: boolean, colorBufferFloat: boolean): GlLimits {
  const [maxViewportWidth, maxViewportHeight] = readViewportDims(gl);
  const defaultDepthBits = readDefaultDepthBits(gl);
  return Object.freeze({
    maxTextureSize: readIntParameter(gl, gl.MAX_TEXTURE_SIZE, "MAX_TEXTURE_SIZE"),
    maxColorAttachments: readIntParameter(gl, gl.MAX_COLOR_ATTACHMENTS, "MAX_COLOR_ATTACHMENTS"),
    maxDrawBuffers: readIntParameter(gl, gl.MAX_DRAW_BUFFERS, "MAX_DRAW_BUFFERS"),
    maxTextureImageUnits: readIntParameter(gl, gl.MAX_TEXTURE_IMAGE_UNITS, "MAX_TEXTURE_IMAGE_UNITS"),
    maxVertexTextureImageUnits: readIntParameter(gl, gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS, "MAX_VERTEX_TEXTURE_IMAGE_UNITS"),
    maxCombinedTextureImageUnits: readIntParameter(gl, gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS, "MAX_COMBINED_TEXTURE_IMAGE_UNITS"),
    maxUniformBufferBindings: readIntParameter(gl, gl.MAX_UNIFORM_BUFFER_BINDINGS, "MAX_UNIFORM_BUFFER_BINDINGS"),
    maxUniformBlockSize: readIntParameter(gl, gl.MAX_UNIFORM_BLOCK_SIZE, "MAX_UNIFORM_BLOCK_SIZE"),
    maxRenderbufferSize: readIntParameter(gl, gl.MAX_RENDERBUFFER_SIZE, "MAX_RENDERBUFFER_SIZE"),
    maxViewportWidth,
    maxViewportHeight,
    floatLinearFilter,
    colorBufferFloat,
    defaultDepthBits,
    defaultFramebufferDepth: defaultDepthBits >= MIN_DEFAULT_DEPTH_BITS,
  });
}

/** Rejects contexts that cannot host the engine's largest resources. */
function assertLimits(limits: GlLimits): void {
  if (limits.maxTextureSize < MIN_TEXTURE_SIZE) {
    throw new Error(`当前 WebGL2 环境的最大纹理尺寸为 ${limits.maxTextureSize}，低于地形场所需的 ${MIN_TEXTURE_SIZE}。`);
  }
  if (limits.maxDrawBuffers < MIN_DRAW_BUFFERS || limits.maxColorAttachments < MIN_DRAW_BUFFERS) {
    throw new Error(`当前 WebGL2 环境不支持双附件 MRT（MAX_DRAW_BUFFERS=${limits.maxDrawBuffers}），谱 FFT 无法运行。`);
  }
  if (limits.maxVertexTextureImageUnits < MIN_TEXTURE_UNITS || limits.maxTextureImageUnits < MIN_TEXTURE_UNITS) {
    throw new Error(
      `当前 WebGL2 环境的纹理单元过少（顶点 ${limits.maxVertexTextureImageUnits}，片元 ${limits.maxTextureImageUnits}），` +
        `水面着色器至少需要 ${MIN_TEXTURE_UNITS} 个。`,
    );
  }
  if (limits.maxUniformBufferBindings < MIN_UNIFORM_BUFFER_BINDINGS) {
    throw new Error(
      `当前 WebGL2 环境的 uniform 缓冲绑定点只有 ${limits.maxUniformBufferBindings} 个，` +
        `引擎需要 ${MIN_UNIFORM_BUFFER_BINDINGS} 个（0：WorldUniforms，1：SimulationParams，2-4：船体的三个块）。`,
    );
  }
}

function readRendererString(gl: WebGL2RenderingContext): string {
  const debugInfo = getTypedExtension<WEBGL_debug_renderer_info>(gl, "WEBGL_debug_renderer_info");
  const unmasked: unknown = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null;
  if (typeof unmasked === "string" && unmasked.trim().length > 0) return unmasked.trim();
  const renderer: unknown = gl.getParameter(gl.RENDERER);
  if (typeof renderer === "string" && renderer.trim().length > 0) return renderer.trim();
  return "未知渲染器";
}

/** True when the renderer string names a known CPU rasteriser. */
function isSoftwareRenderer(renderer: string): boolean {
  const lowered = renderer.toLowerCase();
  return SOFTWARE_RENDERER_MARKERS.some((marker) => lowered.includes(marker));
}

/** `"WebGL2 · <renderer>"`, with a warning suffix when that renderer runs on the CPU. */
function buildAdapterLabel(gl: WebGL2RenderingContext): string {
  const renderer = readRendererString(gl);
  return `WebGL2 · ${renderer}${isSoftwareRenderer(renderer) ? GL_SOFTWARE_RENDERER_NOTE : ""}`;
}

function acquireContext(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  let context: WebGL2RenderingContext | null = null;
  try {
    context = canvas.getContext("webgl2", WATER_GL_CONTEXT_ATTRIBUTES);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${GL_UNSUPPORTED_MESSAGE}（getContext 抛出：${detail}）`);
  }
  if (!context) throw new Error(GL_UNSUPPORTED_MESSAGE);
  return context;
}

/**
 * Resolves float render-target support, preferring the full-precision extension.
 *
 * `EXT_color_buffer_float` makes both `rgba16f` and `rgba32f` renderable and is
 * what the engine wants. `EXT_color_buffer_half_float` only covers `rgba16f`,
 * which is still enough for every per-frame target (the spectral fields, the
 * simulation state, the breaker row, the terrain field); the `rgba32f` textures
 * the engine also creates — twiddle table, initial spectrum, wave data — are
 * sampled, never rendered into, so they stay legal, and every target the
 * engine renders into is `rgba16f` or `rgba8`.
 *
 * Returns `true` for the full extension, `false` for the half-float fallback,
 * and throws `GL_FLOAT_TARGET_MESSAGE` when neither is present.
 */
function resolveColorBufferFloat(gl: WebGL2RenderingContext): boolean {
  if (getTypedExtension<EXT_color_buffer_float>(gl, "EXT_color_buffer_float") !== null) return true;
  if (getTypedExtension<unknown>(gl, "EXT_color_buffer_half_float") !== null) return false;
  throw new Error(GL_FLOAT_TARGET_MESSAGE);
}

/**
 * Creates the WebGL2 context the fallback engine runs on.
 *
 * Throws (Chinese, user-readable) when WebGL2 is missing, when the canvas
 * already owns a different context type, when neither float-render-target
 * extension is present, or when a hard limit is below what the engine needs.
 * `OES_texture_float_linear` and `EXT_disjoint_timer_query_webgl2` are optional
 * and only recorded. A software rasteriser is annotated, not rejected.
 */
export function createWaterGlContext(canvas: HTMLCanvasElement): WaterGlContext {
  const gl = acquireContext(canvas);
  if (gl.isContextLost()) throw new Error("WebGL2 上下文在创建后立即丢失，无法初始化水面引擎。");

  const colorBufferFloat = resolveColorBufferFloat(gl);
  const floatLinear = getTypedExtension<OES_texture_float_linear>(gl, "OES_texture_float_linear");
  const timerQuery = getTypedExtension<ExtDisjointTimerQueryWebgl2>(gl, "EXT_disjoint_timer_query_webgl2");
  const limits = readLimits(gl, floatLinear !== null, colorBufferFloat);
  assertLimits(limits);

  return Object.freeze({
    gl,
    canvas,
    adapterLabel: buildAdapterLabel(gl),
    timerQuery,
    limits,
  });
}

/** Options for `onContextLost`. */
export interface ContextLostOptions {
  /**
   * Call `preventDefault()` on the lost event so the browser may later fire
   * `webglcontextrestored`. The engine treats loss as fatal (like WebGPU's
   * `device.lost`), so this defaults to `false` and nothing in the repository
   * passes `true`. A real recovery path would have to set it, tear every GL
   * object down (none of the old handles survive a lost context) and rebuild
   * from a `webglcontextrestored` listener of its own; the half-wired
   * `onContextRestored` helper that used to sit here was removed rather than
   * left as dead code.
   */
  readonly allowRestore?: boolean;
}

/**
 * Subscribes to `webglcontextlost`. Returns the unsubscribe function.
 * Pair with `fail("WebGL2 上下文已丢失…")` in the engine, keeping the
 * "first error wins" semantics of the WebGPU version (docs/webgl2-port/spec-engine.md §1.5).
 */
export function onContextLost(
  canvas: HTMLCanvasElement,
  callback: (event: Event) => void,
  options: ContextLostOptions = {},
): () => void {
  const listener = (event: Event) => {
    if (options.allowRestore) event.preventDefault();
    callback(event);
  };
  canvas.addEventListener("webglcontextlost", listener);
  return () => canvas.removeEventListener("webglcontextlost", listener);
}

/**
 * Vite replaces `import.meta.env.DEV` with a literal at build time, so a
 * production bundle sees `false` and the whole check tree is dead code the
 * minifier removes. The two guards cover the environments where the constant
 * does not exist at all: a `tsup`/`node` consumer of the library build, and
 * Vitest, which does define it. Anything unresolvable is treated as production
 * — the safe direction, since the checks cost a pipeline flush.
 */
function resolveDebugDefault(): boolean {
  try {
    const env: { DEV?: boolean } | undefined = import.meta.env;
    if (env !== undefined && typeof env.DEV === "boolean") return env.DEV;
    return typeof process !== "undefined" && process.env !== undefined && process.env.NODE_ENV !== "production";
  } catch {
    return false;
  }
}

/**
 * Default for `checkGlError`'s `enabled` flag: true outside production builds.
 * `gl.getError()` forces a pipeline flush, so never leave it on in release.
 */
export const GL_DEBUG_CHECKS_ENABLED: boolean = resolveDebugDefault();

const GL_ERROR_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0x0500: "INVALID_ENUM",
  0x0501: "INVALID_VALUE",
  0x0502: "INVALID_OPERATION",
  0x0505: "OUT_OF_MEMORY",
  0x0506: "INVALID_FRAMEBUFFER_OPERATION",
  0x9242: "CONTEXT_LOST_WEBGL",
});

const MAX_ERROR_DRAIN = 8;

/**
 * Drains `gl.getError()` and throws if anything was pending. Intended for use
 * right after a setup step during development (`enabled` defaults to
 * `GL_DEBUG_CHECKS_ENABLED`); pass `false` or leave production builds alone.
 */
export function checkGlError(gl: WebGL2RenderingContext, label: string, enabled: boolean = GL_DEBUG_CHECKS_ENABLED): void {
  if (!enabled) return;
  const codes: number[] = [];
  for (let attempt = 0; attempt < MAX_ERROR_DRAIN; attempt += 1) {
    const code = gl.getError();
    if (code === gl.NO_ERROR) break;
    codes.push(code);
    if (code === gl.CONTEXT_LOST_WEBGL) break;
  }
  if (codes.length === 0) return;
  const names = codes.map((code) => GL_ERROR_NAMES[code] ?? `0x${code.toString(16)}`).join(", ");
  throw new Error(`WebGL2 错误（${label}）：${names}`);
}

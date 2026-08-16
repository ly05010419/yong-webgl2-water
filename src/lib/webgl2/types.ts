// Shared types for the WebGL2 fallback of the Tethys water engine.
//
// Every object handed out by the `src/lib/webgl2/` helpers is a plain frozen
// record around a raw WebGL handle. Nothing here depends on `@webgpu/types`;
// the DOM lib's WebGL2 typings are sufficient.

/** Sized internal formats the engine needs. Mirrors the WebGPU usage:
 *  - `rgba16f`  → `rgba16float`  (all simulation / spectral render targets)
 *  - `rgba32f`  → `rgba32float`  (twiddle / initial spectrum / wave data)
 *  - `rgba8`    → `bgra8unorm`   (captured scene colour, final offscreen colour)
 *  - `srgb8a8`  → `rgba8unorm-srgb` (sRGB colour uploads)
 *  - `depth24`  → `depth24plus`  (scene depth; sampled with texelFetch only)
 */
export type GlTextureFormat = "rgba16f" | "rgba32f" | "rgba8" | "srgb8a8" | "depth24";

/** Filtering mode used both for texture base state and for sampler objects. */
export type GlFilter = "linear" | "nearest";

/** Wrap mode used both for texture base state and for sampler objects. */
export type GlWrap = "clamp" | "repeat";

/** Shader stage marker for source composition. */
export type GlShaderStage = "vertex" | "fragment";

/** Immutable description of a 2D texture created via `createTexture2D`. */
export interface GlTexture {
  readonly label: string;
  readonly handle: WebGLTexture;
  readonly width: number;
  readonly height: number;
  readonly format: GlTextureFormat;
  /**
   * Whether LINEAR filtering is legal on this texture. `rgba32f` is only
   * filterable when `OES_texture_float_linear` is present; `depth24` never is.
   * `bindTextureUnit` refuses to pair a non-filterable texture with a linear
   * sampler so the mistake surfaces immediately instead of as black texels.
   */
  readonly filterable: boolean;
}

/** WebGL2 Sampler Object — decouples wrap/filter state from the texture. */
export interface GlSampler {
  readonly label: string;
  readonly handle: WebGLSampler;
  readonly wrap: GlWrap;
  readonly filter: GlFilter;
}

/** Framebuffer with `n` colour attachments (MRT) and an optional depth texture. */
export interface GlFramebuffer {
  readonly label: string;
  readonly handle: WebGLFramebuffer;
  readonly width: number;
  readonly height: number;
  /** Colour attachments in `COLOR_ATTACHMENT0..n-1` order. */
  readonly color: readonly GlTexture[];
  readonly depth: GlTexture | null;
}

/** Linked program plus its label (used in every error message). */
export interface GlProgram {
  readonly label: string;
  readonly handle: WebGLProgram;
}

/** Uniform buffer object created by `createUniformBuffer`. */
export interface GlUniformBuffer {
  readonly label: string;
  readonly handle: WebGLBuffer;
  readonly byteLength: number;
}

/** Implementation limits captured once at context creation. */
export interface GlLimits {
  readonly maxTextureSize: number;
  readonly maxColorAttachments: number;
  readonly maxDrawBuffers: number;
  readonly maxTextureImageUnits: number;
  readonly maxVertexTextureImageUnits: number;
  readonly maxCombinedTextureImageUnits: number;
  readonly maxUniformBufferBindings: number;
  readonly maxUniformBlockSize: number;
  readonly maxRenderbufferSize: number;
  readonly maxViewportWidth: number;
  readonly maxViewportHeight: number;
  /** `OES_texture_float_linear` present → `rgba32f` may use LINEAR. */
  readonly floatLinearFilter: boolean;
  /**
   * `EXT_color_buffer_float` present, so `rgba32f` is renderable. `false` means
   * the context fell back to `EXT_color_buffer_half_float`: `rgba16f` targets
   * still work, which is every target this engine renders to. Neither
   * extension present is a hard failure.
   */
  readonly colorBufferFloat: boolean;
  /**
   * `DEPTH_BITS` of the default framebuffer, read once at context creation
   * (the context asks for `depth: true`, which the implementation may serve
   * with any precision it likes, or not at all). `0` also stands for "the
   * driver would not answer the query"; both cases are diagnostics only.
   */
  readonly defaultDepthBits: number;
  /**
   * `defaultDepthBits >= 24`, i.e. the canvas' own depth buffer is at least as
   * precise as the `depth24` attachment of the offscreen targets. Only then may
   * the open scene be drawn straight onto the default framebuffer; below it the
   * engine keeps rendering open offscreen, because a shallower depth buffer
   * would break the two paths' pixel-for-pixel equality at the silhouettes.
   * The shore scene never looks at this — its water shader samples the very
   * scene colour and depth it would be attached to, so it is offscreen either
   * way.
   */
  readonly defaultFramebufferDepth: boolean;
}

/**
 * `EXT_disjoint_timer_query_webgl2` is not part of `lib.dom.d.ts`, so it is
 * declared here. Query creation / begin / end / result readback use the core
 * WebGL2 query API (`createQuery`, `beginQuery`, `getQueryParameter`).
 */
export interface ExtDisjointTimerQueryWebgl2 {
  readonly QUERY_COUNTER_BITS_EXT: 0x8864;
  readonly TIME_ELAPSED_EXT: 0x88bf;
  readonly TIMESTAMP_EXT: 0x8e28;
  readonly GPU_DISJOINT_EXT: 0x8fbb;
  queryCounterEXT(query: WebGLQuery, target: number): void;
}

/** Result of `createWaterGlContext`. Immutable; the `gl` handle itself is live state. */
export interface WaterGlContext {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  /** `"WebGL2 · <renderer string>"` — shown where the WebGPU engine shows its adapter label. */
  readonly adapterLabel: string;
  /** Null when GPU timing is unavailable (the common case). */
  readonly timerQuery: ExtDisjointTimerQueryWebgl2 | null;
  readonly limits: GlLimits;
}

/** Everything a pass module returns must at least be disposable. */
export interface GlPass {
  dispose(): void;
}

/**
 * Two identical framebuffers used for GPGPU ping-pong. `source()` holds the
 * latest *completed* result (read from its textures); `destination()` is the
 * target the next pass renders into; call `swap()` after each pass.
 * `at(i)` gives deterministic access (the FFT uses `pass % 2` explicitly).
 */
export interface PingPongTargets {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly targets: readonly [GlFramebuffer, GlFramebuffer];
  index(): 0 | 1;
  at(index: 0 | 1): GlFramebuffer;
  source(): GlFramebuffer;
  destination(): GlFramebuffer;
  swap(): void;
  reset(): void;
  dispose(): void;
}

/** GPU timer built on `EXT_disjoint_timer_query_webgl2`; all no-ops when unsupported. */
export interface GpuTimer {
  readonly label: string;
  readonly supported: boolean;
  /** Starts a TIME_ELAPSED query. Ignored if one is already open or unsupported. */
  begin(): void;
  /** Ends the open query and queues it for `poll()`. */
  end(): void;
  /** Returns the oldest finished sample in milliseconds, or `null` if none is ready. */
  poll(): number | null;
  /** Number of samples still waiting on the GPU. */
  pending(): number;
  dispose(): void;
}

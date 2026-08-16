// Per-context de-duplication of the GL state the engine re-sets every frame.
//
// The fallback issues ~25 draws per frame and every one of them re-binds its
// inputs, its target and its fixed-function preset. Most of those calls ask the
// driver for state it is already in: the atlas FFT binds the same twiddle table
// 14 times, `COMPUTE_STATE` is applied five times in a row, and the water
// clipmap and the crest patch bind the identical twelve textures back to back.
// A redundant binding is not free — every one crosses the JS/driver boundary
// and (in ANGLE) walks a validation path.
//
// This module is the single source of truth for what the context is currently
// bound to. It caches, per `WebGL2RenderingContext`:
//
//   * per texture unit: the `WebGLTexture` and the `WebGLSampler` on it,
//   * the active texture unit,
//   * the current `WebGLProgram`,
//   * the READ and DRAW framebuffer bindings (tracked separately, because
//     `blitFramebuffer` splits them and `FRAMEBUFFER` sets both),
//   * the viewport rectangle together with the framebuffer it was set for,
//   * the `RenderStatePreset` last applied, plus the flags it produced.
//
// Three rules keep it honest:
//
//   1. `undefined` means *unknown* and `null` means *known to be unbound*. A
//      fresh cache is entirely unknown, so the first call of every kind always
//      reaches the driver.
//   2. Equality is object identity. `WebGLTexture` / `WebGLSampler` /
//      `WebGLProgram` / `WebGLFramebuffer` are unique JS objects for the life
//      of the context, and the render-state presets are frozen singletons.
//   3. Anything that changes one of these bindings *outside* this module must
//      either record the new value (`noteActiveUnitTextureBinding`) or drop the
//      stale one (`forget*`, `invalidateRenderStateCache`,
//      `invalidateGlStateCache`). Deleting a GL object counts: WebGL unbinds it
//      behind our back, so `disposeTexture` and friends call `forget*`.
//
// The cache entry is the one deliberately mutable structure in the WebGL2
// layer. It mirrors state that is mutable by definition and is written on the
// hot path a few thousand times a second; allocating a replacement record per
// binding would cost more than the calls it saves. The only reader outside this
// module is `./gl-state-cache-verify`, the development-only sweep that compares
// every recorded binding against `gl.getParameter`; it reaches the entry through
// `peekGlStateCache` rather than through a second copy of the bookkeeping.

/**
 * One texture unit. `undefined` = not known (never recorded, or the recorded
 * object has since been deleted); `null` = known to be unbound.
 */
export interface TextureUnitState {
  texture: WebGLTexture | null | undefined;
  sampler: WebGLSampler | null | undefined;
}

/**
 * The viewport rectangle *and* the framebuffer it was set for. The GL viewport
 * is context state rather than per-framebuffer state, so the framebuffer is not
 * needed for correctness — it is in the key deliberately, so that a viewport is
 * only ever skipped for a target that is already the current draw target.
 */
export interface ViewportState {
  readonly framebuffer: WebGLFramebuffer | null;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The fixed-function flags a `RenderStatePreset` produced, for verification. */
export interface AppliedRenderState {
  readonly depthTest: boolean;
  readonly depthWrite: boolean;
  /** GL enum (`LESS` / `ALWAYS`); only meaningful when `depthTest` is true. */
  readonly depthFunc: number;
  readonly blend: boolean;
}

/** What the cache knows about one context. Read outside this module only by `./gl-state-cache-verify`. */
export interface GlStateCacheEntry {
  activeUnit: number | undefined;
  readonly units: Map<number, TextureUnitState>;
  program: WebGLProgram | null | undefined;
  readFramebuffer: WebGLFramebuffer | null | undefined;
  drawFramebuffer: WebGLFramebuffer | null | undefined;
  viewport: ViewportState | undefined;
  /** The preset object last applied; compared by identity. */
  renderState: object | undefined;
  /** What that preset set the driver to; only read by `./gl-state-cache-verify`. */
  appliedRenderState: AppliedRenderState | undefined;
}

// Keyed by context so a page holding two canvases (or a StrictMode remount that
// hands the same context to a replacement engine) never shares one cache
// between two contexts. Weak, so a dead context takes its entry with it.
const CACHES = new WeakMap<WebGL2RenderingContext, GlStateCacheEntry>();

function emptyEntry(): GlStateCacheEntry {
  return {
    activeUnit: undefined,
    units: new Map<number, TextureUnitState>(),
    program: undefined,
    readFramebuffer: undefined,
    drawFramebuffer: undefined,
    viewport: undefined,
    renderState: undefined,
    appliedRenderState: undefined,
  };
}

function cacheOf(gl: WebGL2RenderingContext): GlStateCacheEntry {
  const existing = CACHES.get(gl);
  if (existing) return existing;
  const created = emptyEntry();
  CACHES.set(gl, created);
  return created;
}

function unitState(cache: GlStateCacheEntry, unit: number): TextureUnitState {
  const existing = cache.units.get(unit);
  if (existing) return existing;
  const created: TextureUnitState = { texture: undefined, sampler: undefined };
  cache.units.set(unit, created);
  return created;
}

/**
 * Contexts whose cache was dropped and whose next sweep has not happened yet.
 * Separate from the entry because `invalidateGlStateCache` replaces the entry
 * wholesale — a flag stored inside it would be thrown away with it.
 */
const PENDING_VERIFICATION = new WeakSet<WebGL2RenderingContext>();

/**
 * Drops everything known about `gl`. Call it wherever the engine cannot vouch
 * for the driver's state any more: right after the context is created, on
 * context loss, after a `resize()` / `allocateFields()` rebuild, and when an
 * engine hands the context back on `dispose()`.
 */
export function invalidateGlStateCache(gl: WebGL2RenderingContext): void {
  CACHES.set(gl, emptyEntry());
  // Recorded unconditionally: the flag costs one `WeakSet.add` and only the
  // *consumer* is development-gated, which keeps the behaviour testable in
  // builds where `GL_DEBUG_CHECKS_ENABLED` is false.
  PENDING_VERIFICATION.add(gl);
}

/**
 * Takes (and clears) the "this context was invalidated" flag. Used only by
 * `verifyGlStateCacheAfterInvalidation`; one invalidation therefore yields at
 * most one follow-up sweep.
 */
export function takeGlStateCacheVerificationRequest(gl: WebGL2RenderingContext): boolean {
  if (!PENDING_VERIFICATION.has(gl)) return false;
  PENDING_VERIFICATION.delete(gl);
  return true;
}

/** The entry `gl` currently has, or `undefined` when nothing was ever recorded. */
export function peekGlStateCache(gl: WebGL2RenderingContext): GlStateCacheEntry | undefined {
  return CACHES.get(gl);
}

/**
 * Binds `texture` and `sampler` (either may be `null`) to unit `unit`, issuing
 * only the calls that actually change something. `activeTexture` is skipped
 * when the unit is already active *and* when only the sampler differs —
 * `bindSampler` takes the unit as an argument and ignores the active unit.
 */
export function bindCachedTextureUnit(
  gl: WebGL2RenderingContext,
  unit: number,
  texture: WebGLTexture | null,
  sampler: WebGLSampler | null,
): void {
  const cache = cacheOf(gl);
  const state = unitState(cache, unit);
  if (state.texture === texture && state.sampler === sampler) return;
  if (state.texture !== texture) {
    if (cache.activeUnit !== unit) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      cache.activeUnit = unit;
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    state.texture = texture;
  }
  if (state.sampler !== sampler) {
    gl.bindSampler(unit, sampler);
    state.sampler = sampler;
  }
}

/**
 * Records a raw `gl.bindTexture(TEXTURE_2D, …)` made outside this module —
 * texture creation and CPU uploads both bind on whatever unit happens to be
 * active. When the active unit is not known, every recorded texture binding
 * could be the one that just changed, so they are all dropped.
 */
export function noteActiveUnitTextureBinding(gl: WebGL2RenderingContext, texture: WebGLTexture | null): void {
  const cache = cacheOf(gl);
  if (cache.activeUnit === undefined) {
    for (const state of cache.units.values()) state.texture = undefined;
    return;
  }
  unitState(cache, cache.activeUnit).texture = texture;
}

/** `gl.useProgram`, skipped when `program` is already current. */
export function bindCachedProgram(gl: WebGL2RenderingContext, program: WebGLProgram): void {
  const cache = cacheOf(gl);
  if (cache.program === program) return;
  gl.useProgram(program);
  cache.program = program;
}

/** `bindFramebuffer(FRAMEBUFFER, …)`, which sets the READ and DRAW bindings at once. */
export function bindCachedFramebuffer(gl: WebGL2RenderingContext, framebuffer: WebGLFramebuffer | null): void {
  const cache = cacheOf(gl);
  if (cache.readFramebuffer === framebuffer && cache.drawFramebuffer === framebuffer) return;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  cache.readFramebuffer = framebuffer;
  cache.drawFramebuffer = framebuffer;
}

/** `bindFramebuffer(READ_FRAMEBUFFER, …)` — the source half of a blit. */
export function bindCachedReadFramebuffer(gl: WebGL2RenderingContext, framebuffer: WebGLFramebuffer | null): void {
  const cache = cacheOf(gl);
  if (cache.readFramebuffer === framebuffer) return;
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
  cache.readFramebuffer = framebuffer;
}

/** `bindFramebuffer(DRAW_FRAMEBUFFER, …)` — the destination half of a blit. */
export function bindCachedDrawFramebuffer(gl: WebGL2RenderingContext, framebuffer: WebGLFramebuffer | null): void {
  const cache = cacheOf(gl);
  if (cache.drawFramebuffer === framebuffer) return;
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer);
  cache.drawFramebuffer = framebuffer;
}

/**
 * Binds `framebuffer` for drawing and sets the viewport to `0, 0, w, h`,
 * skipping whichever of the two the context is already in.
 */
export function bindCachedFramebufferForDraw(
  gl: WebGL2RenderingContext,
  framebuffer: WebGLFramebuffer | null,
  width: number,
  height: number,
): void {
  bindCachedFramebuffer(gl, framebuffer);
  const cache = cacheOf(gl);
  const current = cache.viewport;
  if (
    current !== undefined &&
    current.framebuffer === framebuffer &&
    current.x === 0 &&
    current.y === 0 &&
    current.width === width &&
    current.height === height
  ) {
    return;
  }
  gl.viewport(0, 0, width, height);
  cache.viewport = { framebuffer, x: 0, y: 0, width, height };
}

/** True when `preset` is the one `applyRenderState` last put the driver in. */
export function isRenderStateCurrent(gl: WebGL2RenderingContext, preset: object): boolean {
  return cacheOf(gl).renderState === preset;
}

/** Records the preset just applied and the driver flags it produced. */
export function noteRenderState(gl: WebGL2RenderingContext, preset: object, applied: AppliedRenderState): void {
  const cache = cacheOf(gl);
  cache.renderState = preset;
  cache.appliedRenderState = applied;
}

/**
 * Forgets the current preset. Anything that touches depth/blend/scissor/colour
 * masks without going through `applyRenderState` — `clearFramebufferToZero` and
 * the scene clear in `engine-frame.ts` both pin `depthMask(true)` — must call
 * this, or the next `applyRenderState` for the same preset would be skipped
 * while the driver is no longer in it.
 */
export function invalidateRenderStateCache(gl: WebGL2RenderingContext): void {
  const cache = cacheOf(gl);
  cache.renderState = undefined;
  cache.appliedRenderState = undefined;
}

/**
 * Forgets a deleted texture. WebGL unbinds a deleted object from every binding
 * point it occupies, so the cached entry would otherwise claim a binding the
 * driver has already dropped — and a *new* texture that happened to be bound to
 * that unit would then be skipped.
 */
export function forgetGlTexture(gl: WebGL2RenderingContext, texture: WebGLTexture): void {
  const cache = CACHES.get(gl);
  if (!cache) return;
  for (const state of cache.units.values()) {
    if (state.texture === texture) state.texture = undefined;
  }
}

/** Forgets a deleted sampler object (see `forgetGlTexture`). */
export function forgetGlSampler(gl: WebGL2RenderingContext, sampler: WebGLSampler): void {
  const cache = CACHES.get(gl);
  if (!cache) return;
  for (const state of cache.units.values()) {
    if (state.sampler === sampler) state.sampler = undefined;
  }
}

/** Forgets a deleted program (see `forgetGlTexture`). */
export function forgetGlProgram(gl: WebGL2RenderingContext, program: WebGLProgram): void {
  const cache = CACHES.get(gl);
  if (!cache) return;
  if (cache.program === program) cache.program = undefined;
}

/** Forgets a deleted framebuffer, including a viewport that was keyed on it. */
export function forgetGlFramebuffer(gl: WebGL2RenderingContext, framebuffer: WebGLFramebuffer): void {
  const cache = CACHES.get(gl);
  if (!cache) return;
  if (cache.readFramebuffer === framebuffer) cache.readFramebuffer = undefined;
  if (cache.drawFramebuffer === framebuffer) cache.drawFramebuffer = undefined;
  if (cache.viewport !== undefined && cache.viewport.framebuffer === framebuffer) cache.viewport = undefined;
}

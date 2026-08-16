// The development-only half of the GL state cache: comparing what
// `./gl-state-cache` believes against what the driver actually reports.
//
// It lives in its own module because every function here is off the hot path
// and exists only to catch the one failure mode the cache can have — a binding
// that changed behind its back and was neither recorded nor invalidated. The
// symptom of that is an occasional wrong texture or a feedback loop, with no
// error and no reliable repro, so the check is worth having even though it can
// never run in production.
//
// Every check is a synchronous `getParameter` / `isEnabled`, which stalls the
// pipeline. Nothing here may be called per frame in a shipping build.

import { GL_DEBUG_CHECKS_ENABLED } from "./gl-context";
import {
  peekGlStateCache,
  takeGlStateCacheVerificationRequest,
  type GlStateCacheEntry,
} from "./gl-state-cache";

function describeHandle(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "未知";
  return "已绑定对象";
}

function compareHandles(mismatches: string[], name: string, expected: unknown, actual: unknown): void {
  if (expected === actual) return;
  mismatches.push(`${name}：缓存为 ${describeHandle(expected)}，实际为 ${describeHandle(actual)}`);
}

function verifyViewport(gl: WebGL2RenderingContext, cache: GlStateCacheEntry, mismatches: string[]): void {
  const expected = cache.viewport;
  if (expected === undefined) return;
  const actual: unknown = gl.getParameter(gl.VIEWPORT);
  if (!(actual instanceof Int32Array) || actual.length < 4) return;
  if (actual[0] === expected.x && actual[1] === expected.y && actual[2] === expected.width && actual[3] === expected.height) return;
  mismatches.push(
    `VIEWPORT：缓存为 ${expected.x},${expected.y},${expected.width},${expected.height}，` +
      `实际为 ${actual[0]},${actual[1]},${actual[2]},${actual[3]}`,
  );
}

function verifyRenderState(gl: WebGL2RenderingContext, cache: GlStateCacheEntry, mismatches: string[]): void {
  const applied = cache.appliedRenderState;
  if (applied === undefined) return;
  const compare = (name: string, expected: unknown, actual: unknown): void => {
    if (expected === actual) return;
    mismatches.push(`${name}：缓存为 ${String(expected)}，实际为 ${String(actual)}`);
  };
  compare("DEPTH_TEST", applied.depthTest, gl.isEnabled(gl.DEPTH_TEST));
  compare("DEPTH_WRITEMASK", applied.depthWrite, gl.getParameter(gl.DEPTH_WRITEMASK));
  if (applied.depthTest) compare("DEPTH_FUNC", applied.depthFunc, gl.getParameter(gl.DEPTH_FUNC));
  compare("BLEND", applied.blend, gl.isEnabled(gl.BLEND));
  compare("CULL_FACE", false, gl.isEnabled(gl.CULL_FACE));
  compare("SCISSOR_TEST", false, gl.isEnabled(gl.SCISSOR_TEST));
  const colorMask: unknown = gl.getParameter(gl.COLOR_WRITEMASK);
  if (Array.isArray(colorMask) && colorMask.some((channel) => channel !== true)) {
    mismatches.push(`COLOR_WRITEMASK：缓存为全开，实际为 ${colorMask.map(String).join(",")}`);
  }
}

function verifyTextureUnits(gl: WebGL2RenderingContext, cache: GlStateCacheEntry, mismatches: string[]): void {
  if (cache.activeUnit !== undefined) {
    const actual: unknown = gl.getParameter(gl.ACTIVE_TEXTURE);
    if (actual !== gl.TEXTURE0 + cache.activeUnit) {
      mismatches.push(`ACTIVE_TEXTURE：缓存为单元 ${cache.activeUnit}，实际为 ${String(actual)}`);
    }
  }
  let visited: number | null = null;
  for (const [unit, state] of cache.units) {
    if (state.texture === undefined && state.sampler === undefined) continue;
    gl.activeTexture(gl.TEXTURE0 + unit);
    visited = unit;
    if (state.texture !== undefined) {
      compareHandles(mismatches, `单元 ${unit} 的 TEXTURE_BINDING_2D`, state.texture, gl.getParameter(gl.TEXTURE_BINDING_2D) ?? null);
    }
    if (state.sampler !== undefined) {
      compareHandles(mismatches, `单元 ${unit} 的 SAMPLER_BINDING`, state.sampler, gl.getParameter(gl.SAMPLER_BINDING) ?? null);
    }
  }
  if (visited === null) return;
  // The sweep moved the active unit; put it back, or record where it ended up
  // when the cache did not know it in the first place.
  if (cache.activeUnit !== undefined) gl.activeTexture(gl.TEXTURE0 + cache.activeUnit);
  else cache.activeUnit = visited;
}

/**
 * Compares every *known* cache entry against the driver and throws a Chinese
 * error listing the divergences.
 *
 * Every check is a synchronous `getParameter`, which stalls the pipeline, so
 * this is development-only (`enabled` defaults to `GL_DEBUG_CHECKS_ENABLED`,
 * false in production builds) and is deliberately **not** wired into the frame
 * loop unconditionally — the engine calls it at the end of the first frame and
 * of any frame that followed an invalidation (see
 * `verifyGlStateCacheAfterInvalidation`), where the stall is affordable. Put a
 * call at the top of `renderComposite` to sample it per frame when chasing a
 * suspected cache divergence, and take it out again.
 */
export function verifyGlStateCache(
  gl: WebGL2RenderingContext,
  label: string,
  enabled: boolean = GL_DEBUG_CHECKS_ENABLED,
): void {
  if (!enabled) return;
  const cache = peekGlStateCache(gl);
  if (!cache) return;
  const mismatches: string[] = [];
  if (cache.program !== undefined) {
    compareHandles(mismatches, "CURRENT_PROGRAM", cache.program, gl.getParameter(gl.CURRENT_PROGRAM) ?? null);
  }
  if (cache.drawFramebuffer !== undefined) {
    compareHandles(mismatches, "DRAW_FRAMEBUFFER_BINDING", cache.drawFramebuffer, gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) ?? null);
  }
  if (cache.readFramebuffer !== undefined) {
    compareHandles(mismatches, "READ_FRAMEBUFFER_BINDING", cache.readFramebuffer, gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) ?? null);
  }
  verifyViewport(gl, cache, mismatches);
  verifyRenderState(gl, cache, mismatches);
  verifyTextureUnits(gl, cache, mismatches);
  if (mismatches.length === 0) return;
  throw new Error(`WebGL2 状态缓存与实际状态不一致（${label}）：${mismatches.join("；")}。`);
}

/**
 * Development-only follow-up sweep: runs `verifyGlStateCache` once at the end
 * of the first frame after any `invalidateGlStateCache`, and does nothing
 * otherwise. Returns whether it swept.
 *
 * Invalidation points — context creation and loss, `resize()`,
 * `allocateFields()`, `dispose()` — are exactly where the engine admits it can
 * no longer vouch for the driver, and therefore where a *missing* record is
 * most likely: the rebuilt resources are bound by code paths the cache never
 * saw. A single sweep on the next frame boundary catches that while keeping
 * the `getParameter` stall out of the steady state.
 *
 * The pending request is consumed whether or not the sweep runs, so one
 * invalidation never buys two checks.
 */
export function verifyGlStateCacheAfterInvalidation(
  gl: WebGL2RenderingContext,
  label: string,
  enabled: boolean = GL_DEBUG_CHECKS_ENABLED,
): boolean {
  if (!enabled) return false;
  if (!takeGlStateCacheVerificationRequest(gl)) return false;
  verifyGlStateCache(gl, label, true);
  return true;
}

/**
 * The engine's frame-boundary sweep, in one call.
 *
 * A frame boundary is where the state cache is at its richest — twelve texture
 * units, both framebuffer bindings, the viewport, the program and the water
 * preset — and the two moments worth paying the `getParameter` stall for are
 * the first frame and the first frame after any `invalidateGlStateCache`
 * (`resize()`, `allocateFields()`, context loss), where the rebuilt resources
 * are bound by code paths the cache never saw.
 *
 * `verifyGlStateCacheAfterInvalidation` consumes the pending request either
 * way, so the init-time invalidation does not also buy frame 1 a second sweep.
 * Development builds only (`GL_DEBUG_CHECKS_ENABLED`); to chase a suspected
 * divergence, drop both guards and sweep every frame.
 */
export function verifyFrameBoundary(gl: WebGL2RenderingContext, frameIndex: number): void {
  const sweptAfterInvalidation = verifyGlStateCacheAfterInvalidation(gl, "WebGL2 状态缓存失效后首帧结束");
  if (!sweptAfterInvalidation && frameIndex === 0) verifyGlStateCache(gl, "WebGL2 首帧结束");
}

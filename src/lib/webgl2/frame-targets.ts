// Canvas-sized offscreen render targets for the WebGL2 fallback engine
// (docs/webgl2-port/contract.md §3.5). WebGPU composites the water straight onto the
// swap chain while sampling the very depth texture it is attached to; WebGL2
// calls that a feedback loop.
//
// The fix is two identical canvas-sized framebuffers:
//
//   sceneFbo { sceneColor rgba8, sceneDepth depth24 }   ← sky + terrain
//   waterFbo { frameColor rgba8, waterDepth depth24 }   ← the water composite
//
// A colour+depth blit between them doubles as the WebGPU `sceneBlit` pass and
// as the depth copy, so the water pass depth-tests against `waterDepth` while
// sampling `sceneColor` / `sceneDepth` of the now-unbound `sceneFbo`. A final
// colour blit presents `frameColor` on the canvas.
//
// Only the shore scene needs that route. The water shader reads the capture
// exclusively under `uniforms.environment.x > 0.5`, which is 0 in the open
// scene, so `engine-frame.ts` draws sky/terrain *and* the water straight
// onto the default framebuffer there and touches neither target — the same
// shape the WebGPU engine uses when it renders the scene pass onto the swap
// chain and loads it in the water pass. That needs the canvas to carry depth,
// which is why the context asks for `depth: true`; a context that came back
// with fewer than 24 depth bits keeps an offscreen open path through
// `waterFbo` (`limits.defaultFramebufferDepth`, F-19).
//
// Both targets are allocated in every scene regardless — the open scene may
// not use either of them on this frame. `setScene()` may flip the scene between
// any two frames without touching the targets, and `resize()` has a single
// scene-independent allocation path, so a scene-conditional allocation would
// need both of them to grow a rebuild branch to guarantee the shore path always
// finds its target. The cost of keeping them is four idle canvas-sized
// textures; the cost of dropping them is a state machine.

import { createGlFramebuffer, disposeFramebuffer } from "./gl-framebuffer";
import { createTexture2D, disposeTexture } from "./gl-texture";
import type { GlFramebuffer, GlTexture } from "./types";

// Frozen plain arrays rather than `Float32Array`s: a typed array cannot be
// frozen with elements in it, so an exported one would be a shared mutable
// buffer that any importer could overwrite for the whole process. The frame
// module copies these into its own private typed arrays once at module load.
/** Clear colour of the scene pass — the WebGPU `clearValue` (engine:2395). */
export const SCENE_CLEAR_COLOR: readonly number[] = Object.freeze([0.18, 0.45, 0.49, 1]);

/** Depth clear value of the scene pass. */
export const SCENE_CLEAR_DEPTH: readonly number[] = Object.freeze([1]);

/** One frame's worth of canvas-sized offscreen targets. */
export interface FrameTargets {
  readonly width: number;
  readonly height: number;
  /** Shore-only sky + terrain target; owns the depth the water samples. */
  readonly sceneFbo: GlFramebuffer;
  /** Water composite target; unused by the open scene unless the canvas lacks depth. */
  readonly waterFbo: GlFramebuffer;
  /** `sceneFbo`'s colour attachment — the shore water pass's `sceneColorTexture`. */
  readonly sceneColor: GlTexture;
  /** `sceneFbo`'s depth attachment — the shore water pass's `sceneDepthTexture`. */
  readonly sceneDepth: GlTexture;
  dispose(): void;
}

function createTargetPair(
  gl: WebGL2RenderingContext,
  role: string,
  width: number,
  height: number,
): { readonly framebuffer: GlFramebuffer; readonly color: GlTexture; readonly depth: GlTexture } {
  // rgba8, never SRGB8_ALPHA8: both shaders write `linearToSrgb(...)` by hand,
  // exactly as the WebGPU version does into `bgra8unorm` (docs/webgl2-port/spec-engine.md §8.2.9).
  const color = createTexture2D(gl, { label: `${role} colour`, width, height, format: "rgba8", wrap: "clamp" });
  try {
    // Sampled only through `texelFetch`, so nearest and COMPARE_MODE = NONE
    // (both set by `createTexture2D` for depth formats).
    const depth = createTexture2D(gl, { label: `${role} depth`, width, height, format: "depth24", wrap: "clamp" });
    try {
      return { framebuffer: createGlFramebuffer(gl, { label: role, color: [color], depth }), color, depth };
    } catch (error) {
      disposeTexture(gl, depth);
      throw error;
    }
  } catch (error) {
    disposeTexture(gl, color);
    throw error;
  }
}

/**
 * Allocates both canvas-sized targets. `width`/`height` must be the drawing
 * buffer size (`gl.drawingBufferWidth/Height`), not the CSS size — the water
 * shader's `uSceneDims` and `interaction.zw` both refer to the backing store.
 */
export function createFrameTargets(gl: WebGL2RenderingContext, width: number, height: number): FrameTargets {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`帧目标尺寸必须是正整数，收到 ${width}×${height}。`);
  }
  const scene = createTargetPair(gl, "captured scene", width, height);
  let water: ReturnType<typeof createTargetPair>;
  try {
    water = createTargetPair(gl, "water composite", width, height);
  } catch (error) {
    disposeFramebuffer(gl, scene.framebuffer);
    throw error;
  }
  let disposed = false;
  return Object.freeze({
    width,
    height,
    sceneFbo: scene.framebuffer,
    waterFbo: water.framebuffer,
    sceneColor: scene.color,
    sceneDepth: scene.depth,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      disposeFramebuffer(gl, water.framebuffer);
      disposeFramebuffer(gl, scene.framebuffer);
    },
  });
}

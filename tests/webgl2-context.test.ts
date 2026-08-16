import { describe, expect, it } from "vitest";

import {
  GL_FLOAT_TARGET_MESSAGE,
  GL_SOFTWARE_RENDERER_NOTE,
  GL_UNSUPPORTED_MESSAGE,
  WATER_GL_CONTEXT_ATTRIBUTES,
  createWaterGlContext,
} from "../src/lib/webgl2/gl-context";

// `createWaterGlContext` only ever calls `getContext`, `isContextLost`,
// `getExtension` and `getParameter`, so a small stub exercises the whole
// extension-fallback / limit-assertion / adapter-label path in node.

/**
 * Parameter enums. The production code always reads them off the same context
 * object it queries, so the values only have to be distinct, not real.
 */
const PARAM = Object.freeze({
  MAX_TEXTURE_SIZE: 1,
  MAX_COLOR_ATTACHMENTS: 2,
  MAX_DRAW_BUFFERS: 3,
  MAX_TEXTURE_IMAGE_UNITS: 4,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 5,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 6,
  MAX_UNIFORM_BUFFER_BINDINGS: 7,
  MAX_UNIFORM_BLOCK_SIZE: 8,
  MAX_RENDERBUFFER_SIZE: 9,
  MAX_VIEWPORT_DIMS: 10,
  RENDERER: 11,
  DEPTH_BITS: 12,
});

/** Limits a healthy desktop context reports; individual tests override one key. */
const HEALTHY_PARAMS: Readonly<Record<number, unknown>> = Object.freeze({
  [PARAM.MAX_TEXTURE_SIZE]: 16384,
  [PARAM.MAX_COLOR_ATTACHMENTS]: 8,
  [PARAM.MAX_DRAW_BUFFERS]: 8,
  [PARAM.MAX_TEXTURE_IMAGE_UNITS]: 16,
  [PARAM.MAX_VERTEX_TEXTURE_IMAGE_UNITS]: 16,
  [PARAM.MAX_COMBINED_TEXTURE_IMAGE_UNITS]: 32,
  [PARAM.MAX_UNIFORM_BUFFER_BINDINGS]: 24,
  [PARAM.MAX_UNIFORM_BLOCK_SIZE]: 65536,
  [PARAM.MAX_RENDERBUFFER_SIZE]: 16384,
  [PARAM.MAX_VIEWPORT_DIMS]: new Int32Array([32767, 32767]),
  [PARAM.RENDERER]: "ANGLE (Apple, Apple M2 Pro, OpenGL 4.1)",
  // What every desktop driver answers for a `depth: true` context.
  [PARAM.DEPTH_BITS]: 24,
});

interface StubOptions {
  readonly extensions?: readonly string[];
  readonly params?: Readonly<Record<number, unknown>>;
  /** Omit the context entirely, as a browser without WebGL2 does. */
  readonly noContext?: boolean;
  /** Receives the attribute record `createWaterGlContext` asked `getContext` for. */
  readonly onAttributes?: (attributes: WebGLContextAttributes | undefined) => void;
}

/** Builds a canvas whose `getContext("webgl2")` returns the configured stub. */
function stubCanvas(options: StubOptions = {}): HTMLCanvasElement {
  const extensions = new Set(options.extensions ?? ["EXT_color_buffer_float"]);
  const params: Readonly<Record<number, unknown>> = { ...HEALTHY_PARAMS, ...(options.params ?? {}) };
  const gl = {
    ...PARAM,
    isContextLost: (): boolean => false,
    getExtension: (name: string): object | null => (extensions.has(name) ? {} : null),
    getParameter: (parameter: number): unknown => params[parameter],
  };
  return {
    getContext: (kind: string, attributes?: WebGLContextAttributes): unknown => {
      options.onAttributes?.(attributes);
      return options.noContext || kind !== "webgl2" ? null : gl;
    },
  } as unknown as HTMLCanvasElement;
}

describe("float render-target extension fallback", () => {
  it("prefers EXT_color_buffer_float and records it", () => {
    const ctx = createWaterGlContext(stubCanvas({ extensions: ["EXT_color_buffer_float"] }));
    expect(ctx.limits.colorBufferFloat).toBe(true);
  });

  it("accepts EXT_color_buffer_half_float alone and records the downgrade", () => {
    const ctx = createWaterGlContext(stubCanvas({ extensions: ["EXT_color_buffer_half_float"] }));
    expect(ctx.limits.colorBufferFloat).toBe(false);
  });

  it("still reports full support when both extensions are present", () => {
    const both = ["EXT_color_buffer_float", "EXT_color_buffer_half_float"];
    expect(createWaterGlContext(stubCanvas({ extensions: both })).limits.colorBufferFloat).toBe(true);
  });

  it("throws the Chinese float-target error when neither is present", () => {
    expect(() => createWaterGlContext(stubCanvas({ extensions: [] }))).toThrow(GL_FLOAT_TARGET_MESSAGE);
  });

  it("still rejects a browser with no WebGL2 at all", () => {
    expect(() => createWaterGlContext(stubCanvas({ noContext: true }))).toThrow(GL_UNSUPPORTED_MESSAGE);
  });
});

describe("limit assertions", () => {
  it("requires five uniform-buffer bindings, because the engine uses 0..4", () => {
    const tooFew = stubCanvas({ params: { [PARAM.MAX_UNIFORM_BUFFER_BINDINGS]: 4 } });
    expect(() => createWaterGlContext(tooFew)).toThrow(/uniform 缓冲绑定点/);
    // The WebGL2 floor is 24, so a conforming context always clears the bar.
    expect(createWaterGlContext(stubCanvas()).limits.maxUniformBufferBindings).toBe(24);
  });

  it("keeps rejecting a terrain-sized texture limit, MRT-less contexts and thin unit counts", () => {
    expect(() => createWaterGlContext(stubCanvas({ params: { [PARAM.MAX_TEXTURE_SIZE]: 512 } }))).toThrow(/最大纹理尺寸/);
    expect(() => createWaterGlContext(stubCanvas({ params: { [PARAM.MAX_DRAW_BUFFERS]: 1 } }))).toThrow(/双附件 MRT/);
    expect(() => createWaterGlContext(stubCanvas({ params: { [PARAM.MAX_TEXTURE_IMAGE_UNITS]: 8 } }))).toThrow(/纹理单元过少/);
  });
});

describe("adapter label", () => {
  it("annotates software rasterisers without refusing to start", () => {
    for (const renderer of ["Google SwiftShader", "llvmpipe (LLVM 15.0.7, 256 bits)", "Microsoft Basic Render Driver Software"]) {
      const ctx = createWaterGlContext(stubCanvas({ params: { [PARAM.RENDERER]: renderer } }));
      expect(ctx.adapterLabel).toContain(renderer);
      expect(ctx.adapterLabel).toContain(GL_SOFTWARE_RENDERER_NOTE);
    }
  });

  it("leaves a hardware renderer label untouched", () => {
    const ctx = createWaterGlContext(stubCanvas());
    expect(ctx.adapterLabel).toBe("WebGL2 · ANGLE (Apple, Apple M2 Pro, OpenGL 4.1)");
    expect(ctx.adapterLabel).not.toContain(GL_SOFTWARE_RENDERER_NOTE);
  });

  it("falls back to a readable placeholder when the renderer string is missing", () => {
    const ctx = createWaterGlContext(stubCanvas({ params: { [PARAM.RENDERER]: "   " } }));
    expect(ctx.adapterLabel).toBe("WebGL2 · 未知渲染器");
  });
});

describe("default framebuffer depth (F-19)", () => {
  it("asks for a depth buffer on the canvas, and nothing else changed", () => {
    // The open scene draws sky/terrain/water straight onto the default
    // framebuffer and depth-tests there, so the canvas needs depth of its own.
    // Every other attribute still mirrors `configure({ alphaMode: "opaque" })`.
    expect(WATER_GL_CONTEXT_ATTRIBUTES).toEqual({
      alpha: false,
      antialias: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });
  });

  it("passes exactly those attributes to getContext", () => {
    let seen: WebGLContextAttributes | undefined;
    createWaterGlContext(stubCanvas({ onAttributes: (attributes) => { seen = attributes; } }));
    expect(seen).toBe(WATER_GL_CONTEXT_ATTRIBUTES);
  });

  it.each([24, 32])("enables the direct-to-canvas open path at %i depth bits", (bits) => {
    const ctx = createWaterGlContext(stubCanvas({ params: { [PARAM.DEPTH_BITS]: bits } }));
    expect(ctx.limits.defaultDepthBits).toBe(bits);
    expect(ctx.limits.defaultFramebufferDepth).toBe(true);
  });

  it.each([0, 16])("falls back to the offscreen open path at %i depth bits, without failing", (bits) => {
    // `depth: true` is a preference, not a guarantee. A shallower buffer would
    // resolve the water/terrain depth tie-break differently from the `depth24`
    // offscreen targets, so the engine keeps rendering open offscreen there.
    const ctx = createWaterGlContext(stubCanvas({ params: { [PARAM.DEPTH_BITS]: bits } }));
    expect(ctx.limits.defaultDepthBits).toBe(bits);
    expect(ctx.limits.defaultFramebufferDepth).toBe(false);
  });

  it.each([null, undefined, "24", Number.NaN, -1])("reads an unanswerable DEPTH_BITS (%s) as 0 rather than throwing", (value) => {
    // `DEPTH_BITS` is legacy in ES 3.0; a driver that declines the query must
    // cost the optimisation, not the engine.
    const ctx = createWaterGlContext(stubCanvas({ params: { [PARAM.DEPTH_BITS]: value } }));
    expect(ctx.limits.defaultDepthBits).toBe(0);
    expect(ctx.limits.defaultFramebufferDepth).toBe(false);
  });
});

import { beforeEach, describe, expect, it } from "vitest";

import {
  bindFramebufferForDraw,
  blitFramebuffer,
  clearFramebufferToZero,
  disposeFramebuffer,
} from "../src/lib/webgl2/gl-framebuffer";
import { bindGlProgram, deleteGlProgram } from "../src/lib/webgl2/gl-program";
import { COMPUTE_STATE, OPAQUE_STATE, WATER_STATE, applyRenderState } from "../src/lib/webgl2/gl-state";
import {
  bindCachedFramebuffer,
  bindCachedTextureUnit,
  invalidateGlStateCache,
  invalidateRenderStateCache,
  noteActiveUnitTextureBinding,
  takeGlStateCacheVerificationRequest,
} from "../src/lib/webgl2/gl-state-cache";
import {
  verifyGlStateCache,
  verifyGlStateCacheAfterInvalidation,
} from "../src/lib/webgl2/gl-state-cache-verify";
import {
  bindTextureUnit,
  disposeSampler,
  disposeTexture,
  unbindTextureUnit,
  unbindTextureUnits,
  uploadTexture2D,
} from "../src/lib/webgl2/gl-texture";
import type { GlFramebuffer, GlProgram, GlSampler, GlTexture } from "../src/lib/webgl2/types";

// The whole point of Opt-3 is that a redundant binding never reaches the
// driver, and that a *needed* one always does. Both halves are observable
// without a GPU: every helper funnels through `gl-state-cache`, so a recording
// stand-in for `WebGL2RenderingContext` pins the exact call list.
//
// The dangerous half is the second one. A cache that skips too much is a
// silent, intermittent rendering bug — the cases below are the four ways the
// driver can move out from under the cache: an object is deleted (WebGL
// unbinds it for us), a texture is created or uploaded (a raw `bindTexture` on
// the active unit), a clear pins depth/colour masks behind
// `applyRenderState`'s back, and a blit splits the READ/DRAW bindings.

const GL_ENUMS = {
  TEXTURE0: 0x84c0,
  TEXTURE_2D: 0x0de1,
  TEXTURE_BINDING_2D: 0x8069,
  SAMPLER_BINDING: 0x8919,
  ACTIVE_TEXTURE: 0x84e0,
  CURRENT_PROGRAM: 0x8b8d,
  FRAMEBUFFER: 0x8d40,
  READ_FRAMEBUFFER: 0x8ca8,
  DRAW_FRAMEBUFFER: 0x8ca9,
  READ_FRAMEBUFFER_BINDING: 0x8caa,
  DRAW_FRAMEBUFFER_BINDING: 0x8ca6,
  VIEWPORT: 0x0ba2,
  COLOR: 0x1800,
  DEPTH: 0x1801,
  COLOR_BUFFER_BIT: 0x00004000,
  DEPTH_BUFFER_BIT: 0x00000100,
  NEAREST: 0x2600,
  LINEAR: 0x2601,
  CULL_FACE: 0x0b44,
  SCISSOR_TEST: 0x0c11,
  DEPTH_TEST: 0x0b71,
  BLEND: 0x0be2,
  DEPTH_WRITEMASK: 0x0b72,
  DEPTH_FUNC: 0x0b74,
  COLOR_WRITEMASK: 0x0c23,
  LESS: 0x0201,
  ALWAYS: 0x0207,
  SRC_ALPHA: 0x0302,
  ONE_MINUS_SRC_ALPHA: 0x0303,
  ONE: 1,
  FUNC_ADD: 0x8006,
  RGBA: 0x1908,
  UNSIGNED_BYTE: 0x1401,
  UNPACK_FLIP_Y_WEBGL: 0x9240,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
  UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243,
  UNPACK_ALIGNMENT: 0x0cf5,
  NONE: 0,
} as const;

/** One recorded call, as `"op(args…)"` — readable in a failing diff. */
type Recorder = {
  readonly gl: WebGL2RenderingContext;
  readonly calls: string[];
  /** Everything recorded since the last `reset()`, then clears the log. */
  drain(): readonly string[];
};

interface FakeDriverState {
  activeUnit: number;
  textures: Map<number, WebGLTexture | null>;
  samplers: Map<number, WebGLSampler | null>;
  program: WebGLProgram | null;
  readFbo: WebGLFramebuffer | null;
  drawFbo: WebGLFramebuffer | null;
  viewport: [number, number, number, number];
  enabled: Map<number, boolean>;
  depthMask: boolean;
  depthFunc: number;
  colorMask: [boolean, boolean, boolean, boolean];
}

/**
 * A recording `WebGL2RenderingContext` that also *models* the state it is told
 * to enter, so `verifyGlStateCache` can be pointed at it. Only the entry points
 * the helpers under test touch are implemented.
 */
function createRecordingGl(): Recorder {
  const calls: string[] = [];
  const state: FakeDriverState = {
    activeUnit: 0,
    textures: new Map(),
    samplers: new Map(),
    program: null,
    readFbo: null,
    drawFbo: null,
    viewport: [0, 0, 0, 0],
    enabled: new Map(),
    depthMask: true,
    depthFunc: GL_ENUMS.LESS,
    colorMask: [true, true, true, true],
  };
  const gl = {
    ...GL_ENUMS,
    drawingBufferWidth: 1280,
    drawingBufferHeight: 800,
    activeTexture(unit: number) {
      calls.push(`activeTexture(${unit - GL_ENUMS.TEXTURE0})`);
      state.activeUnit = unit - GL_ENUMS.TEXTURE0;
    },
    bindTexture(_target: number, texture: WebGLTexture | null) {
      calls.push(`bindTexture(${label(texture)})`);
      state.textures.set(state.activeUnit, texture);
    },
    bindSampler(unit: number, sampler: WebGLSampler | null) {
      calls.push(`bindSampler(${unit},${label(sampler)})`);
      state.samplers.set(unit, sampler);
    },
    useProgram(program: WebGLProgram | null) {
      calls.push(`useProgram(${label(program)})`);
      state.program = program;
    },
    bindFramebuffer(target: number, framebuffer: WebGLFramebuffer | null) {
      const name = target === GL_ENUMS.READ_FRAMEBUFFER ? "read" : target === GL_ENUMS.DRAW_FRAMEBUFFER ? "draw" : "both";
      calls.push(`bindFramebuffer(${name},${label(framebuffer)})`);
      if (target !== GL_ENUMS.DRAW_FRAMEBUFFER) state.readFbo = framebuffer;
      if (target !== GL_ENUMS.READ_FRAMEBUFFER) state.drawFbo = framebuffer;
    },
    viewport(x: number, y: number, width: number, height: number) {
      calls.push(`viewport(${x},${y},${width},${height})`);
      state.viewport = [x, y, width, height];
    },
    enable(capability: number) {
      calls.push(`enable(${capability})`);
      state.enabled.set(capability, true);
    },
    disable(capability: number) {
      calls.push(`disable(${capability})`);
      state.enabled.set(capability, false);
    },
    isEnabled: (capability: number) => state.enabled.get(capability) ?? false,
    depthMask(value: boolean) {
      calls.push(`depthMask(${value})`);
      state.depthMask = value;
    },
    depthFunc(value: number) {
      calls.push(`depthFunc(${value})`);
      state.depthFunc = value;
    },
    colorMask(r: boolean, g: boolean, b: boolean, a: boolean) {
      calls.push("colorMask()");
      state.colorMask = [r, g, b, a];
    },
    blendFuncSeparate: () => calls.push("blendFuncSeparate()"),
    blendEquation: () => calls.push("blendEquation()"),
    clearBufferfv: (buffer: number) => calls.push(`clearBufferfv(${buffer === GL_ENUMS.COLOR ? "color" : "depth"})`),
    blitFramebuffer: () => calls.push("blitFramebuffer()"),
    deleteTexture: (texture: WebGLTexture) => calls.push(`deleteTexture(${label(texture)})`),
    deleteSampler: (sampler: WebGLSampler) => calls.push(`deleteSampler(${label(sampler)})`),
    deleteProgram: (program: WebGLProgram) => calls.push(`deleteProgram(${label(program)})`),
    deleteFramebuffer: (framebuffer: WebGLFramebuffer) => calls.push(`deleteFramebuffer(${label(framebuffer)})`),
    texSubImage2D: () => calls.push("texSubImage2D()"),
    pixelStorei: () => undefined,
    getParameter(parameter: number): unknown {
      switch (parameter) {
        case GL_ENUMS.ACTIVE_TEXTURE: return GL_ENUMS.TEXTURE0 + state.activeUnit;
        case GL_ENUMS.TEXTURE_BINDING_2D: return state.textures.get(state.activeUnit) ?? null;
        case GL_ENUMS.SAMPLER_BINDING: return state.samplers.get(state.activeUnit) ?? null;
        case GL_ENUMS.CURRENT_PROGRAM: return state.program;
        case GL_ENUMS.READ_FRAMEBUFFER_BINDING: return state.readFbo;
        case GL_ENUMS.DRAW_FRAMEBUFFER_BINDING: return state.drawFbo;
        case GL_ENUMS.VIEWPORT: return Int32Array.from(state.viewport);
        case GL_ENUMS.DEPTH_WRITEMASK: return state.depthMask;
        case GL_ENUMS.DEPTH_FUNC: return state.depthFunc;
        case GL_ENUMS.COLOR_WRITEMASK: return [...state.colorMask];
        default: return null;
      }
    },
  } as unknown as WebGL2RenderingContext;
  return {
    gl,
    calls,
    drain(): readonly string[] {
      const taken = [...calls];
      calls.length = 0;
      return taken;
    },
  };
}

/** Handles print as their label, so a failing expectation names the object. */
function label(handle: unknown): string {
  if (handle === null || handle === undefined) return "null";
  const named = handle as { readonly label?: string };
  return named.label ?? "?";
}

function fakeTexture(name: string, width = 4, height = 4): GlTexture {
  return Object.freeze({
    label: name,
    handle: { label: name } as unknown as WebGLTexture,
    width,
    height,
    format: "rgba8" as const,
    filterable: true,
  });
}

function fakeSampler(name: string): GlSampler {
  return Object.freeze({ label: name, handle: { label: name } as unknown as WebGLSampler, wrap: "clamp" as const, filter: "linear" as const });
}

function fakeProgram(name: string): GlProgram {
  return Object.freeze({ label: name, handle: { label: name } as unknown as WebGLProgram });
}

function fakeFramebuffer(name: string, width = 128, height = 128): GlFramebuffer {
  return Object.freeze({
    label: name,
    handle: { label: name } as unknown as WebGLFramebuffer,
    width,
    height,
    color: Object.freeze([fakeTexture(`${name}.color`, width, height)]),
    depth: null,
  });
}

describe("WebGL2 状态缓存", () => {
  let recorder: Recorder;

  beforeEach(() => {
    recorder = createRecordingGl();
    invalidateGlStateCache(recorder.gl);
  });

  describe("纹理单元", () => {
    it("第一次绑定下发调用，重复绑定完全跳过", () => {
      const texture = fakeTexture("terrainField");
      const sampler = fakeSampler("fieldSampler");
      bindTextureUnit(recorder.gl, 3, texture, sampler);
      expect(recorder.drain()).toEqual(["activeTexture(3)", "bindTexture(terrainField)", "bindSampler(3,fieldSampler)"]);
      bindTextureUnit(recorder.gl, 3, texture, sampler);
      bindTextureUnit(recorder.gl, 3, texture, sampler);
      expect(recorder.drain()).toEqual([]);
    });

    it("换纹理只重发纹理绑定，换采样器只重发采样器绑定", () => {
      const first = fakeTexture("longField0");
      const second = fakeTexture("longField1");
      const clamp = fakeSampler("fieldSampler");
      const repeat = fakeSampler("spectrumSampler");
      bindTextureUnit(recorder.gl, 0, first, clamp);
      recorder.drain();
      bindTextureUnit(recorder.gl, 0, second, clamp);
      // Unit 0 is still active, so no `activeTexture` and no `bindSampler`.
      expect(recorder.drain()).toEqual(["bindTexture(longField1)"]);
      bindTextureUnit(recorder.gl, 0, second, repeat);
      expect(recorder.drain()).toEqual(["bindSampler(0,spectrumSampler)"]);
    });

    it("换单元时才重发 activeTexture", () => {
      const texture = fakeTexture("waterState");
      bindTextureUnit(recorder.gl, 1, texture, null);
      bindTextureUnit(recorder.gl, 2, texture, null);
      recorder.drain();
      // Unit 2 is active; rebinding unit 1 needs the switch back.
      bindTextureUnit(recorder.gl, 1, fakeTexture("other"), null);
      expect(recorder.drain()).toEqual(["activeTexture(1)", "bindTexture(other)"]);
    });

    it("解绑同一个单元两次只下发一次", () => {
      const texture = fakeTexture("breakerEvents");
      bindTextureUnit(recorder.gl, 5, texture, fakeSampler("fieldSampler"));
      recorder.drain();
      unbindTextureUnits(recorder.gl, [5, 5, 5]);
      expect(recorder.drain()).toEqual(["bindTexture(null)", "bindSampler(5,null)"]);
      unbindTextureUnit(recorder.gl, 5);
      expect(recorder.drain()).toEqual([]);
    });

    it("失效之后重新下发", () => {
      const texture = fakeTexture("terrainField");
      bindTextureUnit(recorder.gl, 0, texture, null);
      recorder.drain();
      invalidateGlStateCache(recorder.gl);
      bindTextureUnit(recorder.gl, 0, texture, null);
      expect(recorder.drain()).toEqual(["activeTexture(0)", "bindTexture(terrainField)", "bindSampler(0,null)"]);
    });

    it("删除纹理后同一个单元的绑定不被误跳过", () => {
      const texture = fakeTexture("waterState");
      bindTextureUnit(recorder.gl, 2, texture, null);
      recorder.drain();
      // WebGL unbinds the deleted object itself; the cache must not keep
      // claiming unit 2 holds it.
      disposeTexture(recorder.gl, texture);
      recorder.drain();
      bindTextureUnit(recorder.gl, 2, texture, null);
      expect(recorder.drain()).toEqual(["bindTexture(waterState)"]);
    });

    it("删除采样器后同一个单元的采样器绑定不被误跳过", () => {
      const texture = fakeTexture("mediumField0");
      const sampler = fakeSampler("spectrumSampler");
      bindTextureUnit(recorder.gl, 1, texture, sampler);
      recorder.drain();
      disposeSampler(recorder.gl, sampler);
      recorder.drain();
      bindTextureUnit(recorder.gl, 1, texture, sampler);
      expect(recorder.drain()).toEqual(["bindSampler(1,spectrumSampler)"]);
    });

    it("上传纹理之后，同一个单元的绑定不被误跳过", () => {
      const bound = fakeTexture("longField0");
      const uploaded = fakeTexture("initialSpectrum");
      bindTextureUnit(recorder.gl, 4, bound, null);
      recorder.drain();
      // `uploadTexture2D` binds on the active unit (4), which now holds
      // `initialSpectrum` rather than `longField0`.
      uploadTexture2D(recorder.gl, uploaded, new Uint8Array(4 * 4 * 4));
      expect(recorder.drain()).toEqual(["bindTexture(initialSpectrum)", "texSubImage2D()"]);
      bindTextureUnit(recorder.gl, 4, bound, null);
      expect(recorder.drain()).toEqual(["bindTexture(longField0)"]);
    });

    it("活动单元未知时，上传纹理会清掉所有已记录的纹理绑定", () => {
      const first = fakeTexture("a");
      const second = fakeTexture("b");
      bindTextureUnit(recorder.gl, 0, first, null);
      bindTextureUnit(recorder.gl, 1, second, null);
      recorder.drain();
      // A cache that has never seen an `activeTexture` cannot tell which unit a
      // raw bind landed on, so it may not vouch for any of them.
      invalidateGlStateCache(recorder.gl);
      noteActiveUnitTextureBinding(recorder.gl, first.handle);
      bindCachedTextureUnit(recorder.gl, 0, first.handle, null);
      expect(recorder.drain()).toEqual(["activeTexture(0)", "bindTexture(a)", "bindSampler(0,null)"]);
    });
  });

  describe("着色器程序", () => {
    it("重复选择同一个程序只下发一次，换程序会下发", () => {
      const first = fakeProgram("water · optimized");
      const second = fakeProgram("water · reference");
      bindGlProgram(recorder.gl, first);
      bindGlProgram(recorder.gl, first);
      expect(recorder.drain()).toEqual(["useProgram(water · optimized)"]);
      bindGlProgram(recorder.gl, second);
      bindGlProgram(recorder.gl, first);
      expect(recorder.drain()).toEqual(["useProgram(water · reference)", "useProgram(water · optimized)"]);
    });

    it("删除当前程序后重新选择它不被误跳过", () => {
      const program = fakeProgram("sky");
      bindGlProgram(recorder.gl, program);
      recorder.drain();
      deleteGlProgram(recorder.gl, program);
      recorder.drain();
      bindGlProgram(recorder.gl, program);
      expect(recorder.drain()).toEqual(["useProgram(sky)"]);
    });
  });

  describe("帧缓冲与视口", () => {
    it("重复绑定同一个目标既不重发 bindFramebuffer 也不重发 viewport", () => {
      const target = fakeFramebuffer("spectral atlas", 128, 384);
      bindFramebufferForDraw(recorder.gl, target);
      expect(recorder.drain()).toEqual(["bindFramebuffer(both,spectral atlas)", "viewport(0,0,128,384)"]);
      bindFramebufferForDraw(recorder.gl, target);
      expect(recorder.drain()).toEqual([]);
    });

    it("换目标会重发两者，换回来同样重发", () => {
      const ping = fakeFramebuffer("atlas[0]", 128, 384);
      const pong = fakeFramebuffer("atlas[1]", 128, 384);
      bindFramebufferForDraw(recorder.gl, ping);
      recorder.drain();
      bindFramebufferForDraw(recorder.gl, pong);
      expect(recorder.drain()).toEqual(["bindFramebuffer(both,atlas[1])", "viewport(0,0,128,384)"]);
    });

    it("blit 拆开 READ/DRAW 之后，重新绑定同一个目标仍会下发", () => {
      const scene = fakeFramebuffer("captured scene", 1280, 800);
      const water = fakeFramebuffer("water composite", 1280, 800);
      bindFramebufferForDraw(recorder.gl, scene);
      recorder.drain();
      // READ is already `scene`, so only the DRAW half reaches the driver.
      blitFramebuffer(recorder.gl, { source: scene, destination: water, mask: "color" });
      expect(recorder.drain()).toEqual(["bindFramebuffer(draw,water composite)", "blitFramebuffer()"]);
      // DRAW is `water` but READ is still `scene`: `FRAMEBUFFER` must be re-set.
      // The viewport comes with it because its cache key names the framebuffer,
      // even though the rectangle happens to be unchanged.
      bindFramebufferForDraw(recorder.gl, water);
      expect(recorder.drain()).toEqual(["bindFramebuffer(both,water composite)", "viewport(0,0,1280,800)"]);
    });

    it("删除帧缓冲后重新绑定不被误跳过", () => {
      const target = fakeFramebuffer("waterState[1]", 256, 256);
      bindFramebufferForDraw(recorder.gl, target);
      recorder.drain();
      disposeFramebuffer(recorder.gl, target, false);
      recorder.drain();
      bindFramebufferForDraw(recorder.gl, target);
      expect(recorder.drain()).toEqual(["bindFramebuffer(both,waterState[1])", "viewport(0,0,256,256)"]);
    });

    it("只绑定不设视口时，之后同尺寸的 bindFramebufferForDraw 仍会补上视口", () => {
      const target = fakeFramebuffer("spectral transform", 4, 2);
      bindCachedFramebuffer(recorder.gl, target.handle);
      recorder.drain();
      bindFramebufferForDraw(recorder.gl, target);
      expect(recorder.drain()).toEqual(["viewport(0,0,4,2)"]);
    });
  });

  describe("固定管线预设", () => {
    it("同一个预设只应用一次，换预设会重新应用", () => {
      applyRenderState(recorder.gl, COMPUTE_STATE);
      const first = recorder.drain();
      expect(first).toContain(`disable(${GL_ENUMS.DEPTH_TEST})`);
      applyRenderState(recorder.gl, COMPUTE_STATE);
      applyRenderState(recorder.gl, COMPUTE_STATE);
      expect(recorder.drain()).toEqual([]);
      applyRenderState(recorder.gl, WATER_STATE);
      expect(recorder.drain()).toContain(`enable(${GL_ENUMS.BLEND})`);
    });

    it("clearFramebufferToZero 之后同一个预设会被重新应用", () => {
      const target = fakeFramebuffer("waterState[0]", 256, 256);
      applyRenderState(recorder.gl, COMPUTE_STATE);
      recorder.drain();
      // The clear pins `depthMask(true)`, which `COMPUTE_STATE` set to false.
      clearFramebufferToZero(recorder.gl, target);
      recorder.drain();
      applyRenderState(recorder.gl, COMPUTE_STATE);
      expect(recorder.drain()).toContain("depthMask(false)");
    });

    it("显式失效之后重新应用", () => {
      applyRenderState(recorder.gl, OPAQUE_STATE);
      recorder.drain();
      invalidateRenderStateCache(recorder.gl);
      applyRenderState(recorder.gl, OPAQUE_STATE);
      expect(recorder.drain()).toContain(`depthFunc(${GL_ENUMS.LESS})`);
    });
  });

  describe("verifyGlStateCache", () => {
    it("缓存与实际一致时不抛错", () => {
      const target = fakeFramebuffer("scene", 1280, 800);
      bindFramebufferForDraw(recorder.gl, target);
      bindGlProgram(recorder.gl, fakeProgram("terrain"));
      bindTextureUnit(recorder.gl, 0, fakeTexture("terrainField"), fakeSampler("fieldSampler"));
      unbindTextureUnit(recorder.gl, 1);
      applyRenderState(recorder.gl, WATER_STATE);
      expect(() => verifyGlStateCache(recorder.gl, "测试", true)).not.toThrow();
    });

    it("实际状态被绕过修改时抛出中文错误", () => {
      bindTextureUnit(recorder.gl, 0, fakeTexture("terrainField"), null);
      // A raw bind that nothing recorded: exactly the divergence the check is for.
      recorder.gl.bindTexture(recorder.gl.TEXTURE_2D, null);
      expect(() => verifyGlStateCache(recorder.gl, "测试", true)).toThrow(/状态缓存与实际状态不一致/);
    });

    it("默认关闭时不读取任何 getParameter", () => {
      bindTextureUnit(recorder.gl, 0, fakeTexture("terrainField"), null);
      recorder.gl.bindTexture(recorder.gl.TEXTURE_2D, null);
      expect(() => verifyGlStateCache(recorder.gl, "测试", false)).not.toThrow();
    });
  });

  // The engine cannot vouch for the driver right after an invalidation, and the
  // frame that follows one is where a *missing* record is most likely: the
  // rebuilt resources get bound by code the cache never saw. So each
  // invalidation buys exactly one dev-only sweep at the next frame end.
  describe("失效后的开发期复查", () => {
    it("失效之后复查一次，之后不再复查", () => {
      // `beforeEach` invalidated the cache, so one sweep is already pending.
      bindTextureUnit(recorder.gl, 0, fakeTexture("terrainField"), null);
      expect(verifyGlStateCacheAfterInvalidation(recorder.gl, "测试", true)).toBe(true);
      expect(verifyGlStateCacheAfterInvalidation(recorder.gl, "测试", true)).toBe(false);
    });

    it("每一次失效都重新排一次复查", () => {
      expect(verifyGlStateCacheAfterInvalidation(recorder.gl, "测试", true)).toBe(true);
      invalidateGlStateCache(recorder.gl);
      expect(verifyGlStateCacheAfterInvalidation(recorder.gl, "测试", true)).toBe(true);
    });

    it("复查同样会报告不一致", () => {
      bindTextureUnit(recorder.gl, 0, fakeTexture("terrainField"), null);
      recorder.gl.bindTexture(recorder.gl.TEXTURE_2D, null);
      expect(() => verifyGlStateCacheAfterInvalidation(recorder.gl, "测试", true)).toThrow(/状态缓存与实际状态不一致/);
    });

    it("关闭时既不复查也不消费待办", () => {
      bindTextureUnit(recorder.gl, 0, fakeTexture("terrainField"), null);
      recorder.gl.bindTexture(recorder.gl.TEXTURE_2D, null);
      expect(verifyGlStateCacheAfterInvalidation(recorder.gl, "测试", false)).toBe(false);
      // The request survives a production build, so a dev build that runs later
      // against the same context still gets its sweep.
      expect(takeGlStateCacheVerificationRequest(recorder.gl)).toBe(true);
    });
  });
});

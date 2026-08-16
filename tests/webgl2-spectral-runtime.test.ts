import { describe, expect, it } from "vitest";

import { SPECTRAL_LOG_SIZE, SPECTRAL_RESOLUTION, type CascadeScaleOptions } from "../src/lib/spectral-ocean";
import { createSpectralCascadeSet, type SpectralLayout } from "../src/lib/webgl2/spectral-cascades";
import { spectralAtlasPassSchedule } from "../src/lib/webgl2/spectral-glsl";
import type { GlLimits, WaterGlContext } from "../src/lib/webgl2/types";

// `tests/webgl2-spectral.test.ts` pins the *pure* artefacts: the GLSL text of
// every variant and the pass schedule as data. What it cannot see is whether
// the runtime actually issues that schedule — which program, into which target,
// with which uniforms. That gap is exactly where the atlas layout can go wrong
// while every text assertion still passes: one draw aimed at the wrong ping-pong
// slot, one `uCascade` left over from the previous draw, one write-back into the
// wrong cascade's field pair. All of it is visible off-GPU, because every call
// funnels through the helpers in `src/lib/webgl2/`, so a recording stand-in for
// `WebGL2RenderingContext` can replay a whole `update()` and be asserted on.
//
// The same stand-in also runs the `separate` reference layout, which is how the
// "45 draws vs 17" claim in docs/功能和bug.md F-17 stays a checked number rather
// than a remembered one.

const CASCADE_COUNT = 3;
const ATLAS_HEIGHT = SPECTRAL_RESOLUTION * CASCADE_COUNT;
const SCALE_OPTIONS: CascadeScaleOptions = Object.freeze({ longCascadeScale: 240, mediumCascadeScale: 64 });

// Real GL enum values, so a recorded call reads as GL rather than as an index
// into this table.
const GL_ENUMS = {
  TEXTURE_2D: 0x0de1,
  TEXTURE0: 0x84c0,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  TEXTURE_COMPARE_MODE: 0x884c,
  NEAREST: 0x2600,
  LINEAR: 0x2601,
  REPEAT: 0x2901,
  CLAMP_TO_EDGE: 0x812f,
  MAX_TEXTURE_SIZE: 0x0d33,
  MAX_DRAW_BUFFERS: 0x8824,
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  INVALID_INDEX: 0xffffffff,
  UNIFORM_BLOCK_DATA_SIZE: 0x8a40,
  FRAMEBUFFER: 0x8d40,
  READ_FRAMEBUFFER: 0x8ca8,
  DRAW_FRAMEBUFFER: 0x8ca9,
  COLOR_ATTACHMENT0: 0x8ce0,
  DEPTH_ATTACHMENT: 0x8d00,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  COLOR: 0x1800,
  DEPTH: 0x1801,
  TRIANGLES: 0x0004,
  NONE: 0,
  CULL_FACE: 0x0b44,
  SCISSOR_TEST: 0x0c11,
  DEPTH_TEST: 0x0b71,
  BLEND: 0x0be2,
  LESS: 0x0201,
  ALWAYS: 0x0207,
  SRC_ALPHA: 0x0302,
  ONE_MINUS_SRC_ALPHA: 0x0303,
  ONE: 1,
  FUNC_ADD: 0x8006,
  UNPACK_FLIP_Y_WEBGL: 0x9240,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
  UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243,
  UNPACK_ALIGNMENT: 0x0cf5,
} as const;

/** A fake `WebGLTexture` that remembers the storage it was given. */
interface FakeTexture {
  width: number;
  height: number;
}

/** A fake `WebGLProgram`, identified by the `#define`s its fragment source carries. */
interface FakeProgram {
  /** `atlas · axis 0`, `gather · axis 1`, `evolution`, … — the variant name. */
  variant: string;
  defines: Readonly<Record<string, number>>;
  fragmentSource: string;
}

/** A fake `WebGLUniformLocation`; the name is what the assertions read back. */
interface FakeUniformLocation {
  readonly program: FakeProgram;
  readonly name: string;
}

/** One recorded `texSubImage2D`, reduced to the region it wrote. */
interface UploadRecord {
  readonly texture: FakeTexture;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Everything one recorded draw is asserted on. */
interface DrawRecord {
  readonly variant: string;
  /** Colour attachments of the framebuffer bound for drawing. */
  readonly target: readonly FakeTexture[];
  readonly targetWidth: number;
  readonly targetHeight: number;
  /** Current value of every `uniform1i` the program has been given. */
  readonly uniforms: Readonly<Record<string, number>>;
  /** Texture on each unit at draw time, by unit index. */
  readonly units: ReadonlyMap<number, FakeTexture | null>;
}

interface RecordingGl {
  readonly ctx: WaterGlContext;
  readonly draws: readonly DrawRecord[];
  readonly uploads: readonly UploadRecord[];
  /** Texture currently on each unit, after the run. */
  readonly units: ReadonlyMap<number, FakeTexture | null>;
  reset(): void;
}

/**
 * Reads the `#define NAME value` block `composeShaderSource` puts at the top of
 * every source. Those are the only defines the spectral programs branch on, and
 * they are what distinguishes one compiled variant from another.
 */
function readDefines(source: string): Readonly<Record<string, number>> {
  const defines: Record<string, number> = {};
  for (const line of source.split("\n")) {
    const match = /^#define\s+(\w+)\s+(-?\d+)$/.exec(line.trim());
    // Stop at the body: its own `#ifndef` fallbacks are not what this program
    // was compiled with, and reading them would mask a missing define.
    if (!match) {
      if (line.startsWith("#version") || line.startsWith("precision") || line.trim().length === 0) continue;
      break;
    }
    defines[match[1]] = Number(match[2]);
  }
  return Object.freeze(defines);
}

/** Names a compiled variant from its defines — how a recorded draw is identified. */
function variantName(defines: Readonly<Record<string, number>>): string {
  if (defines.FFT_AXIS === undefined) return "evolution";
  const mode = defines.SPECTRAL_GATHER === 1 ? "gather" : "atlas";
  return `${mode} · axis ${defines.FFT_AXIS}`;
}

/**
 * A `WebGL2RenderingContext` that models just enough state for the spectral
 * layouts to run end to end: texture storage, framebuffer attachments, the
 * current program, the draw target, texture units and integer uniforms. Every
 * `drawArrays` snapshots that state into `draws`.
 */
function createRecordingGl(): RecordingGl {
  const draws: DrawRecord[] = [];
  const uploads: UploadRecord[] = [];
  const units = new Map<number, FakeTexture | null>();
  const attachments = new Map<object, FakeTexture[]>();
  const uniformValues = new Map<FakeProgram, Record<string, number>>();
  let activeUnit = 0;
  let boundTexture: FakeTexture | null = null;
  let currentProgram: FakeProgram | null = null;
  let drawFramebuffer: object | null = null;
  let lastShaderSource = "";

  const gl = {
    ...GL_ENUMS,
    drawingBufferWidth: 1280,
    drawingBufferHeight: 800,
    getParameter(parameter: number): unknown {
      if (parameter === GL_ENUMS.MAX_TEXTURE_SIZE) return 4096;
      if (parameter === GL_ENUMS.MAX_DRAW_BUFFERS) return 8;
      return null;
    },
    // `rgba32f` linear filtering is unavailable, exactly as on the machines the
    // fallback targets; the spectral tables are NEAREST anyway.
    getExtension: () => null,
    createTexture: (): FakeTexture => ({ width: 0, height: 0 }),
    bindTexture(_target: number, texture: FakeTexture | null) {
      boundTexture = texture;
      units.set(activeUnit, texture);
    },
    activeTexture(unit: number) {
      activeUnit = unit - GL_ENUMS.TEXTURE0;
    },
    bindSampler: () => undefined,
    texStorage2D(_target: number, _levels: number, _internalFormat: number, width: number, height: number) {
      if (boundTexture) {
        boundTexture.width = width;
        boundTexture.height = height;
      }
    },
    texParameteri: () => undefined,
    pixelStorei: () => undefined,
    texSubImage2D(
      _target: number,
      _level: number,
      x: number,
      y: number,
      width: number,
      height: number,
    ) {
      if (boundTexture) uploads.push({ texture: boundTexture, x, y, width, height });
    },
    deleteTexture: () => undefined,
    deleteSampler: () => undefined,
    createShader: (): object => ({}),
    shaderSource(_shader: object, source: string) {
      // `createGlProgram` composes the vertex source first and the fragment
      // source second, both from the same defines, and only then creates the
      // program — so the last source seen is the fragment one.
      lastShaderSource = source;
    },
    compileShader: () => undefined,
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    deleteShader: () => undefined,
    isContextLost: () => false,
    createProgram(): FakeProgram {
      const defines = readDefines(lastShaderSource);
      return { variant: variantName(defines), defines, fragmentSource: lastShaderSource };
    },
    attachShader: () => undefined,
    detachShader: () => undefined,
    linkProgram: () => undefined,
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    deleteProgram: () => undefined,
    useProgram(program: FakeProgram | null) {
      currentProgram = program;
    },
    getUniformBlockIndex: () => 0,
    getActiveUniformBlockParameter: () => 256,
    uniformBlockBinding: () => undefined,
    getUniformLocation(program: FakeProgram, name: string): FakeUniformLocation | null {
      // `uCascade` is declared inside `#if SPECTRAL_GATHER == 1`, so the atlas
      // variants really do link without it — the one uniform whose presence
      // depends on the defines, and the one this test cares about.
      if (name === "uCascade" && program.defines.SPECTRAL_GATHER !== 1) return null;
      if (!program.fragmentSource.includes(name)) return null;
      return { program, name };
    },
    uniform1i(location: FakeUniformLocation | null, value: number) {
      if (!location) return;
      const values = uniformValues.get(location.program) ?? {};
      values[location.name] = value;
      uniformValues.set(location.program, values);
    },
    uniform2i: () => undefined,
    createFramebuffer: (): object => ({}),
    bindFramebuffer(target: number, framebuffer: object | null) {
      if (target !== GL_ENUMS.READ_FRAMEBUFFER) drawFramebuffer = framebuffer;
    },
    framebufferTexture2D(_target: number, attachment: number, _texTarget: number, texture: FakeTexture) {
      if (!drawFramebuffer) return;
      const list = attachments.get(drawFramebuffer) ?? [];
      list[attachment - GL_ENUMS.COLOR_ATTACHMENT0] = texture;
      attachments.set(drawFramebuffer, list);
    },
    drawBuffers: () => undefined,
    checkFramebufferStatus: () => GL_ENUMS.FRAMEBUFFER_COMPLETE,
    deleteFramebuffer: () => undefined,
    clearBufferfv: () => undefined,
    viewport: () => undefined,
    enable: () => undefined,
    disable: () => undefined,
    colorMask: () => undefined,
    depthMask: () => undefined,
    depthFunc: () => undefined,
    blendFuncSeparate: () => undefined,
    blendEquation: () => undefined,
    drawArrays() {
      if (!currentProgram) throw new Error("draw without a current program");
      const target = drawFramebuffer ? attachments.get(drawFramebuffer) ?? [] : [];
      const first = target[0];
      draws.push({
        variant: currentProgram.variant,
        target: Object.freeze([...target]),
        targetWidth: first?.width ?? 0,
        targetHeight: first?.height ?? 0,
        uniforms: Object.freeze({ ...(uniformValues.get(currentProgram) ?? {}) }),
        units: new Map(units),
      });
    },
  } as unknown as WebGL2RenderingContext;

  const limits = { maxDrawBuffers: 8 } as unknown as GlLimits;
  return {
    ctx: { gl, limits } as unknown as WaterGlContext,
    draws,
    uploads,
    units,
    reset() {
      draws.length = 0;
      uploads.length = 0;
    },
  };
}

/** Builds a cascade set on a fresh recording context and runs one `update()`. */
function runUpdate(layout: SpectralLayout): RecordingGl & { readonly set: ReturnType<typeof createSpectralCascadeSet> } {
  const recorder = createRecordingGl();
  const set = createSpectralCascadeSet(recorder.ctx, SCALE_OPTIONS, { layout });
  // Construction clears both ping-pong sides and uploads the CPU spectra; only
  // the frame itself is under test.
  recorder.reset();
  set.update();
  return { ...recorder, set };
}

describe("谱级联 atlas 布局的运行期调度", () => {
  const run = runUpdate("atlas");
  const schedule = spectralAtlasPassSchedule(SPECTRAL_LOG_SIZE, CASCADE_COUNT);

  it("每帧恰好 17 次 draw：1 次演化 + 13 级堆叠 + 3 次写回", () => {
    expect(run.draws).toHaveLength(17);
    expect(run.draws[0].variant).toBe("evolution");
    expect(run.draws.filter((draw) => draw.variant.startsWith("atlas · "))).toHaveLength(13);
    expect(run.draws.filter((draw) => draw.variant.startsWith("gather · "))).toHaveLength(CASCADE_COUNT);
    // The whole point of the layout: 45 draws would be the per-cascade one.
    expect(run.draws.length).toBe(1 + schedule.length);
  });

  it("演化写进 atlas 的一个 128×384 槽位", () => {
    const evolution = run.draws[0];
    expect(evolution.targetWidth).toBe(SPECTRAL_RESOLUTION);
    expect(evolution.targetHeight).toBe(ATLAS_HEIGHT);
    // MRT pair, like every stage after it.
    expect(evolution.target).toHaveLength(2);
  });

  it("13 级堆叠 draw 的 (变体, 目标, stage, finalize) 与调度逐条一致", () => {
    const stacked = schedule.filter((draw) => draw.kind === "atlas");
    // Slot 0 is the one evolution wrote; slot 1 is the other 128×384 target.
    const slot0 = run.draws[0].target;
    stacked.forEach((expected, index) => {
      const actual = run.draws[index + 1];
      expect(actual.variant).toBe(`atlas · axis ${expected.axis}`);
      expect(actual.targetWidth).toBe(SPECTRAL_RESOLUTION);
      expect(actual.targetHeight).toBe(ATLAS_HEIGHT);
      expect(actual.uniforms.uStage).toBe(expected.stage);
      expect(actual.uniforms.uFinalize).toBe(expected.finalize);
      // Ping-pong: a draw that writes slot 0 has evolution's target, and a draw
      // that writes slot 1 has the other one. Identity, not an index guess.
      const writesSlot0 = actual.target[0] === slot0[0] && actual.target[1] === slot0[1];
      expect(writesSlot0).toBe(expected.destinationIndex === 0);
      // …and it reads the slot it does not write, on the two input units.
      const readsSlot0 = actual.units.get(1) === slot0[0] && actual.units.get(2) === slot0[1];
      expect(readsSlot0).toBe(expected.sourceIndex === 0);
    });
  });

  it("堆叠 draw 从不设 uCascade，收尾 draw 每次都设", () => {
    for (let index = 1; index <= 13; index += 1) {
      // The atlas variants do not declare it at all, so it can never go stale.
      expect(run.draws[index].uniforms).not.toHaveProperty("uCascade");
    }
    const writeBack = run.draws.slice(14);
    expect(writeBack.map((draw) => draw.uniforms.uCascade)).toEqual([0, 1, 2]);
  });

  it("3 次写回都是垂直 gather，带棋盘翻转，写进各级联自己的 128×128 场纹理", () => {
    const writeBack = run.draws.slice(14);
    writeBack.forEach((draw, cascade) => {
      expect(draw.variant).toBe("gather · axis 1");
      expect(draw.uniforms.uStage).toBe(SPECTRAL_LOG_SIZE - 1);
      expect(draw.uniforms.uFinalize).toBe(1);
      expect(draw.targetWidth).toBe(SPECTRAL_RESOLUTION);
      expect(draw.targetHeight).toBe(SPECTRAL_RESOLUTION);
      // The exact textures `field0(c)` / `field1(c)` hand downstream — the
      // reason the closing stage is split rather than followed by a copy.
      expect(draw.target[0]).toBe(run.set.field0(cascade).handle);
      expect(draw.target[1]).toBe(run.set.field1(cascade).handle);
    });
    // All three read the same atlas slot, so they are independent of each other.
    const sources = writeBack.map((draw) => draw.units.get(1));
    expect(new Set(sources).size).toBe(1);
  });

  it("draw 结束后已绑定的纹理单元都被解绑", () => {
    // Otherwise a field texture would still be an input when the next frame
    // renders into it — the feedback loop R4 forbids.
    for (const [, texture] of run.units) expect(texture).toBeNull();
    expect(run.units.size).toBeGreaterThan(0);
  });
});

describe("谱级联 separate 参照布局", () => {
  it("每帧 45 次 draw：3 × (1 次演化 + 14 级 IFFT)", () => {
    const run = runUpdate("separate");
    expect(run.draws).toHaveLength(CASCADE_COUNT * (1 + SPECTRAL_LOG_SIZE * 2));
    expect(run.draws).toHaveLength(45);
    expect(run.draws.filter((draw) => draw.variant === "evolution")).toHaveLength(CASCADE_COUNT);
    // One cascade per texture: every variant is `gather`, with `uCascade` pinned
    // to 0 at construction and never touched again.
    for (const draw of run.draws) {
      expect(draw.targetWidth).toBe(SPECTRAL_RESOLUTION);
      expect(draw.targetHeight).toBe(SPECTRAL_RESOLUTION);
      if (draw.variant !== "evolution") expect(draw.uniforms.uCascade).toBe(0);
    }
  });
});

describe("谱级联的上传与参数校验", () => {
  it("atlas 布局的 uploadCascade(1) 只覆盖第二段 128 行", () => {
    const recorder = createRecordingGl();
    const set = createSpectralCascadeSet(recorder.ctx, SCALE_OPTIONS, { layout: "atlas" });
    recorder.reset();
    set.uploadCascade(1, { longCascadeScale: 300, mediumCascadeScale: 80 });
    // Two stacked rgba32f tables: the initial spectrum and the wave data.
    expect(recorder.uploads).toHaveLength(2);
    for (const upload of recorder.uploads) {
      expect(upload).toMatchObject({ x: 0, y: SPECTRAL_RESOLUTION, width: SPECTRAL_RESOLUTION, height: SPECTRAL_RESOLUTION });
      expect(upload.texture.height).toBe(ATLAS_HEIGHT);
    }
  });

  it("separate 布局的 uploadCascade 覆盖整张 128×128", () => {
    const recorder = createRecordingGl();
    const set = createSpectralCascadeSet(recorder.ctx, SCALE_OPTIONS, { layout: "separate" });
    recorder.reset();
    set.uploadCascade(1, { longCascadeScale: 300, mediumCascadeScale: 80 });
    expect(recorder.uploads).toHaveLength(2);
    for (const upload of recorder.uploads) {
      expect(upload).toMatchObject({ x: 0, y: 0, width: SPECTRAL_RESOLUTION, height: SPECTRAL_RESOLUTION });
    }
  });

  it("非法布局名抛中文错误", () => {
    const recorder = createRecordingGl();
    expect(() => createSpectralCascadeSet(recorder.ctx, SCALE_OPTIONS, { layout: "stacked" as SpectralLayout }))
      .toThrow(/谱级联布局只能是 "atlas" 或 "separate"/);
  });
});

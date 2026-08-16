import { describe, expect, it } from "vitest";

import { DEFAULT_WATER_LAB_OPTIONS, type WaterLabOptions } from "../src/lib/water-lab-types";
import { renderComposite, type CascadeFields, type FramePassInput } from "../src/lib/webgl2/engine-frame";
import { SCENE_CLEAR_COLOR, SCENE_CLEAR_DEPTH, type FrameTargets } from "../src/lib/webgl2/frame-targets";
import type { WaterPassDrawInput } from "../src/lib/webgl2/water-pass";
import type { GlFramebuffer, GlSampler, GlTexture, WaterGlContext } from "../src/lib/webgl2/types";

// `renderComposite` is the one place the scenes take different routes through
// the framebuffers, and getting it wrong is either a wasted full-screen blit
// (shore's cost paid in open) or a feedback loop (the water sampling the target
// it draws into). Neither shows up in a shader test, and both are verifiable
// off-GPU: the pass modules are injected, so a recording stand-in for
// `WebGL2RenderingContext` pins the exact sequence of binds and blits.
//
// Three routes are pinned here: shore's capture path, open straight onto the
// canvas (F-19, the default when the context reported >= 24 default depth bits)
// and open through `waterFbo` (the F-16 path, still taken when it did not).

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 800;

// The handful of GL enums the helpers under test read off the context. The
// values are the real ones, so a recorded call is readable as GL rather than as
// an index into this table.
const GL_ENUMS = {
  COLOR: 0x1800,
  DEPTH: 0x1801,
  SCISSOR_TEST: 0x0c11,
  FRAMEBUFFER: 0x8d40,
  READ_FRAMEBUFFER: 0x8ca8,
  DRAW_FRAMEBUFFER: 0x8ca9,
  COLOR_BUFFER_BIT: 0x00004000,
  DEPTH_BUFFER_BIT: 0x00000100,
  NEAREST: 0x2600,
  LINEAR: 0x2601,
} as const;

/** One recorded GL call, reduced to what the assertions care about. */
type GlCall =
  | { readonly op: "bindFramebuffer"; readonly target: number; readonly handle: unknown }
  | { readonly op: "blitFramebuffer"; readonly mask: number }
  | { readonly op: "clearBufferfv"; readonly buffer: number; readonly values: readonly number[] }
  | { readonly op: "viewport"; readonly width: number; readonly height: number };

/**
 * What `drawTarget()` answers before anything was bound. `null` is a real
 * binding here — the canvas — so "nothing yet" needs a value of its own.
 */
const NEVER_BOUND = Object.freeze({ label: "never bound" });

interface RecordingGl {
  readonly gl: WebGL2RenderingContext;
  readonly calls: readonly GlCall[];
  /** Handle currently bound to `FRAMEBUFFER` / `DRAW_FRAMEBUFFER`, or `NEVER_BOUND`. */
  drawTarget(): unknown;
}

function createRecordingGl(): RecordingGl {
  const calls: GlCall[] = [];
  let drawTarget: unknown = NEVER_BOUND;
  const gl = {
    ...GL_ENUMS,
    drawingBufferWidth: CANVAS_WIDTH,
    drawingBufferHeight: CANVAS_HEIGHT,
    bindFramebuffer(target: number, handle: unknown) {
      calls.push({ op: "bindFramebuffer", target, handle });
      if (target === GL_ENUMS.FRAMEBUFFER || target === GL_ENUMS.DRAW_FRAMEBUFFER) drawTarget = handle;
    },
    blitFramebuffer(
      _sx0: number,
      _sy0: number,
      _sx1: number,
      _sy1: number,
      _dx0: number,
      _dy0: number,
      _dx1: number,
      _dy1: number,
      mask: number,
    ) {
      calls.push({ op: "blitFramebuffer", mask });
    },
    clearBufferfv(buffer: number, _index: number, values: Float32List) {
      calls.push({ op: "clearBufferfv", buffer, values: [...(values as Float32Array)] });
    },
    viewport(_x: number, _y: number, width: number, height: number) {
      calls.push({ op: "viewport", width, height });
    },
    bindVertexArray: () => undefined,
    colorMask: () => undefined,
    depthMask: () => undefined,
    disable: () => undefined,
  } as unknown as WebGL2RenderingContext;
  return { gl, calls, drawTarget: () => drawTarget };
}

function fakeTexture(label: string, width: number, height: number, format: GlTexture["format"]): GlTexture {
  // Only `depth24` is unfilterable among the formats these fakes use; that is
  // what stops a linear sampler from being paired with the depth stand-in.
  const filterable = format !== "depth24";
  return Object.freeze({ label, handle: { label } as unknown as WebGLTexture, width, height, format, filterable });
}

function fakeFramebuffer(label: string, color: GlTexture, depth: GlTexture): GlFramebuffer {
  return Object.freeze({
    label,
    handle: { label } as unknown as WebGLFramebuffer,
    width: color.width,
    height: color.height,
    color: Object.freeze([color]),
    depth,
  });
}

function fakeSampler(label: string, wrap: GlSampler["wrap"], filter: GlSampler["filter"]): GlSampler {
  return Object.freeze({ label, handle: { label } as unknown as WebGLSampler, wrap, filter });
}

function fakeTargets(): FrameTargets {
  const sceneColor = fakeTexture("captured scene colour", CANVAS_WIDTH, CANVAS_HEIGHT, "rgba8");
  const sceneDepth = fakeTexture("captured scene depth", CANVAS_WIDTH, CANVAS_HEIGHT, "depth24");
  const frameColor = fakeTexture("water composite colour", CANVAS_WIDTH, CANVAS_HEIGHT, "rgba8");
  const waterDepth = fakeTexture("water composite depth", CANVAS_WIDTH, CANVAS_HEIGHT, "depth24");
  return Object.freeze({
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    sceneFbo: fakeFramebuffer("captured scene", sceneColor, sceneDepth),
    waterFbo: fakeFramebuffer("water composite", frameColor, waterDepth),
    sceneColor,
    sceneDepth,
    dispose: () => undefined,
  });
}

/** What one `renderComposite` run recorded, plus the inputs the passes saw. */
interface CompositeRun {
  readonly calls: readonly GlCall[];
  readonly targets: FrameTargets;
  readonly waterInput: WaterPassDrawInput;
  /** Framebuffer bound for drawing at the moment the water pass ran. */
  readonly waterDrawTarget: unknown;
  readonly sceneOrder: readonly string[];
  readonly placeholderColor: GlTexture;
  readonly placeholderDepth: GlTexture;
}

/**
 * Runs one composite. `defaultFramebufferDepth` is what `createWaterGlContext`
 * recorded for this context; it only steers the open scene, and defaults to the
 * value every desktop driver reports.
 */
function runComposite(scene: WaterLabOptions["scene"], defaultFramebufferDepth = true): CompositeRun {
  const { gl, calls, drawTarget } = createRecordingGl();
  const targets = fakeTargets();
  const placeholderColor = fakeTexture("captured scene placeholder colour", 1, 1, "rgba8");
  const placeholderDepth = fakeTexture("captured scene placeholder depth", 1, 1, "depth24");
  const sceneOrder: string[] = [];
  let waterInput: WaterPassDrawInput | null = null;
  let waterDrawTarget: unknown = null;
  const field = fakeTexture("field", 256, 256, "rgba16f");
  const resources = {
    vao: {} as WebGLVertexArrayObject,
    fieldSampler: fakeSampler("fieldSampler", "clamp", "linear"),
    spectrumSampler: fakeSampler("spectrumSampler", "repeat", "linear"),
    depthSampler: fakeSampler("sceneDepthSampler", "clamp", "nearest"),
    sceneColorPlaceholder: placeholderColor,
    sceneDepthPlaceholder: placeholderDepth,
    terrainField: { texture: fakeTexture("terrain field", 512, 512, "rgba16f") },
    breaker: { currentEvents: () => fakeTexture("breaker events", 256, 1, "rgba32f") },
    sky: { draw: () => sceneOrder.push("sky") },
    terrain: { draw: () => sceneOrder.push("terrain") },
    water: {
      draw: (input: WaterPassDrawInput) => {
        sceneOrder.push("water");
        waterInput = input;
        waterDrawTarget = drawTarget();
      },
    },
  };
  const input = {
    ctx: { gl, limits: { defaultFramebufferDepth } } as unknown as WaterGlContext,
    resources,
    simulation: { currentState: () => fakeTexture("water state", 256, 256, "rgba16f") },
    targets,
    options: { ...DEFAULT_WATER_LAB_OPTIONS, scene },
  } as unknown as FramePassInput;
  const fields = Object.freeze({
    long0: field,
    long1: field,
    medium0: field,
    medium1: field,
    short0: field,
    short1: field,
  }) as CascadeFields;
  renderComposite(input, fields);
  if (waterInput === null) throw new Error("water pass was never drawn");
  return { calls, targets, waterInput, waterDrawTarget, sceneOrder, placeholderColor, placeholderDepth };
}

function framebufferBinds(calls: readonly GlCall[]): readonly unknown[] {
  return calls.filter((call) => call.op === "bindFramebuffer" && call.target === GL_ENUMS.FRAMEBUFFER).map((call) => (call as { handle: unknown }).handle);
}

function blitMasks(calls: readonly GlCall[]): readonly number[] {
  return calls.filter((call) => call.op === "blitFramebuffer").map((call) => (call as { mask: number }).mask);
}

const COLOR_AND_DEPTH = GL_ENUMS.COLOR_BUFFER_BIT | GL_ENUMS.DEPTH_BUFFER_BIT;

/** The three routes, as `(label, scene, defaultFramebufferDepth)`. */
const ROUTES: readonly [string, WaterLabOptions["scene"], boolean][] = [
  ["open · canvas", "open", true],
  ["open · offscreen fallback", "open", false],
  ["shore", "shore", true],
];

describe("renderComposite scene routing", () => {
  it("draws the open scene straight onto the canvas, with no offscreen target and no blit", () => {
    const { calls, sceneOrder } = runComposite("open", true);
    // Sky/terrain and the water composite share the default framebuffer,
    // so it is the only thing bound for the whole raster half.
    expect(framebufferBinds(calls)).toEqual([null]);
    // Nothing to present: the frame was drawn where it is displayed from.
    expect(blitMasks(calls)).toEqual([]);
    expect(sceneOrder).toEqual(["sky", "terrain", "water"]);
  });

  it("keeps the open scene offscreen when the canvas has too few depth bits", () => {
    const { calls, targets, sceneOrder } = runComposite("open", false);
    // The F-16 route: one shared offscreen target, then the presentation copy.
    expect(framebufferBinds(calls)).toEqual([targets.waterFbo.handle, null]);
    expect(blitMasks(calls)).toEqual([GL_ENUMS.COLOR_BUFFER_BIT]);
    expect(sceneOrder).toEqual(["sky", "terrain", "water"]);
  });

  it.each([true, false])("keeps the shore capture path whatever the canvas depth is (%s)", (canvasDepth) => {
    // Shore is offscreen because its water pass *samples* the capture, which
    // has nothing to do with how deep the default framebuffer is.
    const { calls, targets, sceneOrder } = runComposite("shore", canvasDepth);
    expect(framebufferBinds(calls)).toEqual([targets.sceneFbo.handle, targets.waterFbo.handle, null]);
    expect(blitMasks(calls)).toEqual([COLOR_AND_DEPTH, GL_ENUMS.COLOR_BUFFER_BIT]);
    expect(sceneOrder).toEqual(["sky", "terrain", "water"]);
  });

  it.each(ROUTES)("clears %s to the WebGPU clear values once", (_label, scene, canvasDepth) => {
    const clears = runComposite(scene, canvasDepth).calls.filter((call) => call.op === "clearBufferfv");
    // Round-tripped through `Float32Array`, because that is what the frame
    // module hands `clearBufferfv` and 0.18 is not representable in binary32.
    // The canvas route clears the default framebuffer with the very same two
    // calls — that equality is what keeps its output bit-identical.
    expect(clears).toEqual([
      { op: "clearBufferfv", buffer: GL_ENUMS.COLOR, values: [...new Float32Array(SCENE_CLEAR_COLOR)] },
      { op: "clearBufferfv", buffer: GL_ENUMS.DEPTH, values: [...new Float32Array(SCENE_CLEAR_DEPTH)] },
    ]);
  });

  it.each(ROUTES)("sets the canvas-sized viewport for every %s pass", (_label, scene, canvasDepth) => {
    const viewports = runComposite(scene, canvasDepth).calls.filter((call) => call.op === "viewport");
    expect(viewports).not.toHaveLength(0);
    for (const viewport of viewports) expect(viewport).toMatchObject({ width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
  });
});

describe("renderComposite captured-scene bindings", () => {
  it("hands the shore water pass the real capture at canvas size", () => {
    const { targets, waterInput } = runComposite("shore");
    expect(waterInput.sceneColor).toBe(targets.sceneColor);
    expect(waterInput.sceneDepth).toBe(targets.sceneDepth);
    expect(waterInput.sceneWidth).toBe(CANVAS_WIDTH);
    expect(waterInput.sceneHeight).toBe(CANVAS_HEIGHT);
  });

  it.each([true, false])("hands the open water pass the 1x1 stand-ins instead (canvas depth: %s)", (canvasDepth) => {
    const { waterInput, placeholderColor, placeholderDepth } = runComposite("open", canvasDepth);
    expect(waterInput.sceneColor).toBe(placeholderColor);
    expect(waterInput.sceneDepth).toBe(placeholderDepth);
    expect(waterInput.sceneWidth).toBe(1);
    expect(waterInput.sceneHeight).toBe(1);
  });

  it.each(ROUTES)("keeps the %s dimensions consistent with the bound depth texture", (_label, scene, canvasDepth) => {
    // The invariant `water-pass.ts` enforces at draw time: a mismatch would
    // make `texelFetch(sceneDepthTexture, ...)` read the wrong texel.
    const { waterInput } = runComposite(scene, canvasDepth);
    expect(waterInput.sceneWidth).toBe(waterInput.sceneDepth.width);
    expect(waterInput.sceneHeight).toBe(waterInput.sceneDepth.height);
    expect(waterInput.sceneDepth.format).toBe("depth24");
  });

  it.each(ROUTES)("never samples an attachment of the %s draw target", (_label, scene, canvasDepth) => {
    // The reason the open scene cannot simply bind `targets.sceneColor/Depth`:
    // on the offscreen route the water draws into the framebuffer those would
    // have to be read from, which is a feedback loop even with the reading
    // branch dead. On the canvas route the target is not a texture at all.
    const { waterInput, waterDrawTarget, targets } = runComposite(scene, canvasDepth);
    const drawsToCanvas = scene === "open" && canvasDepth;
    expect(waterDrawTarget).toBe(drawsToCanvas ? null : targets.waterFbo.handle);
    const attachments = drawsToCanvas ? [] : [...targets.waterFbo.color, targets.waterFbo.depth];
    expect(attachments).not.toContain(waterInput.sceneColor);
    expect(attachments).not.toContain(waterInput.sceneDepth);
  });
});

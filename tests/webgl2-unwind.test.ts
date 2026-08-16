import { describe, expect, it, vi } from "vitest";

import { createPingPongTargets } from "../src/lib/webgl2/gl-framebuffer";
import { createGlUnwindStack } from "../src/lib/webgl2/gl-unwind";

// `createGlUnwindStack` is the only thing standing between a half-finished GL
// build and a leak that lasts the whole session, so its three guarantees are
// pinned here: reverse order, idempotence, and "one bad release step does not
// stop the others".

describe("createGlUnwindStack", () => {
  it("hands each tracked value straight back", () => {
    const stack = createGlUnwindStack();
    const value = { id: 1 };
    expect(stack.track(value, () => undefined)).toBe(value);
  });

  it("releases newest-first", () => {
    const released: string[] = [];
    const stack = createGlUnwindStack();
    stack.track("a", (value) => released.push(value));
    stack.track("b", (value) => released.push(value));
    stack.track("c", (value) => released.push(value));
    stack.unwind();
    expect(released).toEqual(["c", "b", "a"]);
  });

  it("is idempotent: a second unwind releases nothing twice", () => {
    const released: string[] = [];
    const stack = createGlUnwindStack();
    stack.track("a", (value) => released.push(value));
    stack.track("b", (value) => released.push(value));
    stack.unwind();
    stack.unwind();
    stack.unwind();
    expect(released).toEqual(["b", "a"]);
  });

  it("does nothing when nothing was tracked", () => {
    expect(() => createGlUnwindStack().unwind()).not.toThrow();
  });

  it("keeps releasing after a step throws, and reports the failures once", () => {
    const released: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stack = createGlUnwindStack();
    stack.track("a", (value) => released.push(value));
    stack.track("b", () => { throw new Error("driver refused the delete"); });
    stack.track("c", (value) => released.push(value));
    // The failure is swallowed, not rethrown: `unwind()` runs from a `catch`
    // that is about to rethrow the real cause.
    expect(() => stack.unwind()).not.toThrow();
    // "c" ran before the throw, "a" after it — neither is stranded.
    expect(released).toEqual(["c", "a"]);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain("driver refused the delete");
    // The stack is still empty afterwards, failure or not.
    released.length = 0;
    stack.unwind();
    expect(released).toEqual([]);
    consoleError.mockRestore();
  });

  it("collects every failure rather than stopping at the first", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stack = createGlUnwindStack();
    stack.track("a", () => { throw new Error("first"); });
    stack.track("b", () => { throw new Error("second"); });
    stack.unwind();
    const message = String(consoleError.mock.calls[0][0]);
    expect(message).toContain("2");
    expect(message).toContain("first");
    expect(message).toContain("second");
    consoleError.mockRestore();
  });
});

/**
 * `WebGL2RenderingContext` stand-in for `createPingPongTargets`: enough of the
 * texture and framebuffer surface for a complete build, with `failTextureAt` /
 * `failFramebufferAt` turning the Nth creation into the `null` return that
 * makes `createTexture2D` / `createGlFramebuffer` throw. Everything created and
 * everything deleted is recorded, which is the whole point — a partial build
 * must leave nothing behind.
 */
function createPingPongGl(limits: { failTextureAt?: number; failFramebufferAt?: number } = {}) {
  const created: string[] = [];
  const deleted: string[] = [];
  let textures = 0;
  let framebuffers = 0;
  const gl = {
    TEXTURE_2D: 0x0de1,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    DEPTH_ATTACHMENT: 0x8d00,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_DRAW_BUFFERS: 0x8824,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812f,
    REPEAT: 0x2901,
    NONE: 0,
    getParameter: (pname: number): number => (pname === 0x8824 ? 8 : 4096),
    getExtension: (): null => null,
    createTexture: (): string | null => {
      textures += 1;
      if (textures === limits.failTextureAt) return null;
      const name = `texture${textures}`;
      created.push(name);
      return name;
    },
    deleteTexture: (handle: string): void => void deleted.push(handle),
    bindTexture: (): void => undefined,
    texStorage2D: (): void => undefined,
    texParameteri: (): void => undefined,
    createFramebuffer: (): string | null => {
      framebuffers += 1;
      if (framebuffers === limits.failFramebufferAt) return null;
      const name = `framebuffer${framebuffers}`;
      created.push(name);
      return name;
    },
    deleteFramebuffer: (handle: string): void => void deleted.push(handle),
    bindFramebuffer: (): void => undefined,
    framebufferTexture2D: (): void => undefined,
    drawBuffers: (): void => undefined,
    checkFramebufferStatus: (): number => 0x8cd5,
  };
  return { gl: gl as unknown as WebGL2RenderingContext, created, deleted };
}

const PING_PONG_OPTIONS = { label: "spectral field", width: 128, height: 128, formats: ["rgba8", "rgba8"] } as const;

describe("createPingPongTargets rollback", () => {
  it("builds both sides and deletes nothing on the happy path", () => {
    const fake = createPingPongGl();
    const targets = createPingPongTargets(fake.gl, { ...PING_PONG_OPTIONS, clearToZero: false });
    expect(targets.at(0).color).toHaveLength(2);
    // 2 sides × (2 textures + 1 FBO).
    expect(fake.created).toHaveLength(6);
    expect(fake.deleted).toEqual([]);
  });

  it("releases the first attachment when the second texture of a side fails", () => {
    const fake = createPingPongGl({ failTextureAt: 2 });
    expect(() => createPingPongTargets(fake.gl, { ...PING_PONG_OPTIONS, clearToZero: false })).toThrow(/无法创建纹理对象/);
    // The one texture that did get made is the one that gets deleted; without
    // the unwind stack it would have no owner and no handle left to free it.
    expect(fake.created).toEqual(["texture1"]);
    expect(fake.deleted).toEqual(["texture1"]);
  });

  it("releases the whole first side when the second side fails", () => {
    const fake = createPingPongGl({ failTextureAt: 3 });
    expect(() => createPingPongTargets(fake.gl, { ...PING_PONG_OPTIONS, clearToZero: false })).toThrow(/无法创建纹理对象/);
    expect(fake.created).toEqual(["texture1", "texture2", "framebuffer1"]);
    // Newest-first: side 0's FBO, then the attachments it owned.
    expect(fake.deleted).toEqual(["framebuffer1", "texture1", "texture2"]);
    expect(new Set(fake.deleted)).toEqual(new Set(fake.created));
  });

  it("releases both textures when the first side's framebuffer fails", () => {
    const fake = createPingPongGl({ failFramebufferAt: 1 });
    expect(() => createPingPongTargets(fake.gl, { ...PING_PONG_OPTIONS, clearToZero: false })).toThrow(/无法创建帧缓冲对象/);
    expect(fake.deleted).toEqual(["texture2", "texture1"]);
  });

  it("releases the first side when the second side's framebuffer fails", () => {
    const fake = createPingPongGl({ failFramebufferAt: 2 });
    expect(() => createPingPongTargets(fake.gl, { ...PING_PONG_OPTIONS, clearToZero: false })).toThrow(/无法创建帧缓冲对象/);
    // Side 1's two textures first (its own side-level unwind), then side 0.
    expect(fake.deleted).toEqual(["texture4", "texture3", "framebuffer1", "texture1", "texture2"]);
    expect(new Set(fake.deleted)).toEqual(new Set(fake.created));
  });
});

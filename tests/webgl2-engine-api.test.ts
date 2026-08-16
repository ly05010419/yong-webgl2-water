import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_WATER_LAB_OPTIONS, type WaterLabOptions } from "../src/lib/water-lab-types";
import { WebGl2WaterEngine } from "../src/lib/webgl2-water-engine";

// The engine's public surface, pinned. Not "does it render" — that needs a GPU
// — but "does it still expose exactly these methods, and does its constructor
// still clamp before anything downstream can see an out-of-range value".
// Everything here runs without a canvas: no `init()` is called, so no context
// is ever requested.

/** Every method a host application (or the demo bridge) is allowed to rely on. */
const PUBLIC_METHODS = [
  "init",
  "dispose",
  "getMetrics",
  "resetMetrics",
  "setMode",
  "setView",
  "setScene",
  "setMeshResolution",
  "setSimulationResolution",
  "setRenderScale",
  "setWaveScale",
  "setDistantRoughness",
  "setDetailRange",
  "setSwellSmoothing",
  "setLongCascadeScale",
  "setMediumCascadeScale",
  "setFogReach",
] as const;

// `dispose()` cancels the frame it may have requested. Node has no
// `cancelAnimationFrame`, so stub it rather than let the engine grow a guard
// that only exists for the tests.
beforeEach(() => {
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A canvas stand-in: the constructor only stores it, so nothing has to work. */
function stubCanvas(): HTMLCanvasElement {
  return {} as HTMLCanvasElement;
}

function engineWith(options: Partial<WaterLabOptions> = {}): WebGl2WaterEngine {
  return new WebGl2WaterEngine(stubCanvas(), options);
}

describe("WebGl2WaterEngine public API", () => {
  it("exposes every documented method and nothing else", () => {
    const prototype = Object.getPrototypeOf(engineWith()) as object;
    const own = Object.getOwnPropertyNames(prototype).filter((name) => name !== "constructor");
    // Private helpers are `#`-free TypeScript privates, so they do land on the
    // prototype; the assertion is one-directional on purpose — every public
    // method must exist, and the whitelist is what a consumer may bind to.
    for (const method of PUBLIC_METHODS) {
      expect(own).toContain(method);
      expect(typeof (engineWith() as unknown as Record<string, unknown>)[method]).toBe("function");
    }
  });

  it("reports the pending adapter label and no error before init()", () => {
    const metrics = engineWith().getMetrics();
    expect(metrics.ready).toBe(false);
    expect(metrics.error).toBeNull();
    expect(metrics.adapter).toBe("正在请求 WebGL2 上下文…");
  });

  it("carries no backend field on its metrics", () => {
    expect(Object.keys(engineWith().getMetrics())).not.toContain("backend");
  });

  it("clamps constructor options exactly as the setters would", () => {
    const metrics = engineWith({ meshResolution: 10_000, simulationResolution: 1, waveScale: -3, fogReach: 99 }).getMetrics();
    expect(metrics.meshResolution).toBe(320);
    expect(metrics.simulationResolution).toBe(64);
    expect(metrics.waveScale).toBe(0.15);
    expect(metrics.fogReach).toBe(3);
  });

  it("applies the same clamps through the setters", () => {
    const engine = engineWith();
    engine.setMeshResolution(10_000);
    engine.setSimulationResolution(1);
    engine.setDetailRange(0);
    expect(engine.getMetrics().meshResolution).toBe(320);
    expect(engine.getMetrics().simulationResolution).toBe(64);
    expect(engine.getMetrics().detailRange).toBe(0.4);
  });

  it("mirrors the mode and view straight through", () => {
    const engine = engineWith();
    engine.setMode("reference");
    engine.setView("underwater");
    expect(engine.getMetrics().mode).toBe("reference");
    expect(engine.getMetrics().view).toBe("underwater");
    expect(engine.getMetrics().simulationSubsteps).toBe(2);
  });

  it("defaults every option a caller left out", () => {
    const metrics = engineWith().getMetrics();
    expect(metrics.meshResolution).toBe(DEFAULT_WATER_LAB_OPTIONS.meshResolution);
    expect(metrics.longCascadeScale).toBe(DEFAULT_WATER_LAB_OPTIONS.longCascadeScale);
    expect(metrics.mediumCascadeScale).toBe(DEFAULT_WATER_LAB_OPTIONS.mediumCascadeScale);
  });

  it("is safe to dispose without ever having been initialised", () => {
    expect(() => engineWith().dispose()).not.toThrow();
  });

  it("refuses to start after dispose()", async () => {
    const engine = engineWith();
    engine.dispose();
    await expect(engine.init()).resolves.toBeUndefined();
    expect(engine.getMetrics().ready).toBe(false);
  });
});

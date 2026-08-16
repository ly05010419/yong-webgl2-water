import { describe, expect, it } from "vitest";

import { FRAME_HISTORY } from "../src/lib/water-constants";
import { DEFAULT_WATER_LAB_OPTIONS, type WaterLabOptions } from "../src/lib/water-lab-types";
import { buildWaterLabMetrics, frameTriangleCount, pushBoundedSample, type MetricsInput } from "../src/lib/water-metrics";

/** 64² inner ring plus nine outer rings at the 1.5 degenerate-triangle factor. */
const CLIPMAP_TRIANGLES = 64 * 64 * 2 + 9 * 64 * 64 * 1.5;

function options(overrides: Partial<WaterLabOptions> = {}): WaterLabOptions {
  return { ...DEFAULT_WATER_LAB_OPTIONS, ...overrides };
}

function input(overrides: Partial<MetricsInput> = {}): MetricsInput {
  return {
    ready: true,
    options: options(),
    disturbanceCount: 0,
    frameTimes: [],
    submitTimes: [],
    gpuSimulationTimes: [],
    gpuRenderTimes: [],
    adapter: "test adapter",
    error: null,
    ...overrides,
  };
}

describe("frameTriangleCount", () => {
  it("uses the fixed 512² terrain for the island scene", () => {
    expect(frameTriangleCount(options({ scene: "shore", meshResolution: 96 }))).toBe(512 * 512 * 2 + CLIPMAP_TRIANGLES);
  });

  it("uses meshResolution for the open ocean", () => {
    expect(frameTriangleCount(options({ scene: "open", meshResolution: 240 })))
      .toBe(240 * 240 * 2 + CLIPMAP_TRIANGLES);
  });

  it("scales with the mesh resolution only in the open scene", () => {
    const open = frameTriangleCount(options({ scene: "open", meshResolution: 320 }));
    const shore = frameTriangleCount(options({ scene: "shore", meshResolution: 320 }));
    expect(open).toBe(320 * 320 * 2 + CLIPMAP_TRIANGLES);
    expect(shore).toBe(512 * 512 * 2 + CLIPMAP_TRIANGLES);
  });
});

describe("pushBoundedSample", () => {
  it("keeps the newest samples inside the window", () => {
    const samples: number[] = [];
    for (let index = 0; index < 5; index += 1) pushBoundedSample(samples, index, 3);
    expect(samples).toEqual([2, 3, 4]);
  });

  it("defaults to the shared frame history window", () => {
    const samples: number[] = [];
    for (let index = 0; index < FRAME_HISTORY + 10; index += 1) pushBoundedSample(samples, index);
    expect(samples.length).toBe(FRAME_HISTORY);
    expect(samples[samples.length - 1]).toBe(FRAME_HISTORY + 9);
  });
});

describe("buildWaterLabMetrics", () => {
  it("derives the frame statistics from the sample window", () => {
    const frameTimes = [10, 20, 30, 100];
    const metrics = buildWaterLabMetrics(input({ frameTimes, submitTimes: [1, 3] }));
    expect(metrics.frameMeanMs).toBeCloseTo(40, 10);
    expect(metrics.frameMaxMs).toBe(100);
    expect(metrics.fps).toBeCloseTo(25, 10);
    // Nearest rank: floor(4 * 0.95) = 3 and floor(4 * 0.99) = 3.
    expect(metrics.frameP95Ms).toBe(100);
    expect(metrics.frameP99Ms).toBe(100);
    expect(metrics.hitchFrames).toBe(1);
    expect(metrics.submitMeanMs).toBe(2);
  });

  it("returns zeroed timings and null GPU samples before the first frame", () => {
    const metrics = buildWaterLabMetrics(input({ ready: false }));
    expect(metrics.ready).toBe(false);
    expect(metrics.frameMeanMs).toBe(0);
    expect(metrics.frameMaxMs).toBe(0);
    expect(metrics.fps).toBe(0);
    expect(metrics.gpuSimulationMeanMs).toBeNull();
    expect(metrics.gpuSimulationP95Ms).toBeNull();
    expect(metrics.gpuRenderMeanMs).toBeNull();
    expect(metrics.gpuRenderP95Ms).toBeNull();
    expect(metrics.gpuTimestampSamples).toBe(0);
  });

  it("counts GPU samples as the pairs both timers produced", () => {
    const metrics = buildWaterLabMetrics(input({ gpuSimulationTimes: [1, 2, 3], gpuRenderTimes: [4, 6] }));
    expect(metrics.gpuSimulationMeanMs).toBeCloseTo(2, 10);
    expect(metrics.gpuRenderMeanMs).toBeCloseTo(5, 10);
    expect(metrics.gpuTimestampSamples).toBe(2);
  });

  it("mirrors the option and scene bookkeeping", () => {
    const metrics = buildWaterLabMetrics(input({
      options: options({ mode: "reference", scene: "shore", simulationResolution: 384, fogReach: 1.5 }),
      disturbanceCount: 7,
      adapter: "Adapter X",
      error: "boom",
    }));
    expect(metrics.simulationSubsteps).toBe(2);
    expect(metrics.sceneCapturePasses).toBe(1);
    expect(metrics.simulationBytes).toBe(384 * 384 * 16);
    expect(metrics.triangles).toBe(512 * 512 * 2 + CLIPMAP_TRIANGLES);
    expect(metrics.fogReach).toBe(1.5);
    expect(metrics.disturbanceCount).toBe(7);
    expect(metrics.particleCount).toBe(0);
    expect(metrics.adapter).toBe("Adapter X");
    expect(metrics.error).toBe("boom");
  });

  it("keeps one substep and no scene capture in the optimized open scene", () => {
    const metrics = buildWaterLabMetrics(input({ options: options({ mode: "optimized", scene: "open" }) }));
    expect(metrics.simulationSubsteps).toBe(1);
    expect(metrics.sceneCapturePasses).toBe(0);
  });
});

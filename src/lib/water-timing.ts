// The engine's four timing sample buffers, and the rules for what may enter
// them. Split out of `webgl2-water-engine.ts` because none of it is about GL:
// it is bookkeeping over numbers the render loop already has, and keeping it
// here leaves the engine file about resources and per-frame ordering.
//
// The windows themselves stay `FRAME_HISTORY` long via `pushBoundedSample`, so
// the percentiles `buildWaterLabMetrics` computes are over exactly the most
// recent 360 samples.

import type { GpuTimer } from "./webgl2/types";
import { pushBoundedSample } from "./water-metrics";

/** Each GPU timing sample costs a query object, so one frame in eight is enough. */
export const GPU_SAMPLE_INTERVAL = 8;
/** GPU timings outside this window are disjoint-clock garbage. */
const MAX_VALID_GPU_MS = 1000;
/** A frame delta beyond this is a tab that was backgrounded, not a slow frame. */
const MAX_VALID_FRAME_MS = 1000;

/** The four sliding windows, in the shape `buildWaterLabMetrics` reads them. */
export interface TimingWindows {
  readonly frameTimes: readonly number[];
  readonly submitTimes: readonly number[];
  readonly gpuSimulationTimes: readonly number[];
  readonly gpuRenderTimes: readonly number[];
}

/**
 * Owns the four sample buffers. Every `record*` method applies the same
 * validity rule the engine has always applied before appending, so a rejected
 * sample can never reach a percentile.
 */
export class FrameTimings implements TimingWindows {
  readonly frameTimes: number[] = [];
  readonly submitTimes: number[] = [];
  readonly gpuSimulationTimes: number[] = [];
  readonly gpuRenderTimes: number[] = [];

  /** Wall-clock gap since the previous frame; a backgrounded tab is dropped. */
  recordFrameDelta(delta: number): void {
    if (delta > 0 && delta < MAX_VALID_FRAME_MS) pushBoundedSample(this.frameTimes, delta);
  }

  /** How long the JS half of one frame took to submit. */
  recordSubmit(milliseconds: number): void {
    pushBoundedSample(this.submitTimes, milliseconds);
  }

  /**
   * Drains one finished sample from each GPU timer. `null` means "nothing ready
   * yet"; a negative or absurdly large value means the driver's timer went
   * disjoint mid-query and the sample is meaningless.
   */
  collectGpuSamples(simulationTimer: GpuTimer, renderTimer: GpuTimer): void {
    const simulation = simulationTimer.poll();
    if (simulation !== null && simulation >= 0 && simulation < MAX_VALID_GPU_MS) {
      pushBoundedSample(this.gpuSimulationTimes, simulation);
    }
    const render = renderTimer.poll();
    if (render !== null && render >= 0 && render < MAX_VALID_GPU_MS) {
      pushBoundedSample(this.gpuRenderTimes, render);
    }
  }

  /** Empties every window; the next `getMetrics()` reports from a clean slate. */
  reset(): void {
    this.frameTimes.length = 0;
    this.submitTimes.length = 0;
    this.gpuSimulationTimes.length = 0;
    this.gpuRenderTimes.length = 0;
  }
}

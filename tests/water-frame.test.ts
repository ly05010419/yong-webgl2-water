import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { OPEN_WATER_VIEW_SCALE, TERRAIN_EXTENT } from "../src/lib/water-constants";
import {
  WORLD_UNIFORM_OFFSETS,
  computeFrameState,
  computeSimulationParams,
  packWorldUniforms,
  type FrameState,
  type FrameStateInput,
} from "../src/lib/water-frame";
import { DEFAULT_CAMERA_ORBIT, resolveInitialCameraOrbit } from "../src/lib/water-interaction";
import { DEFAULT_WATER_LAB_OPTIONS, type WaterLabOptions } from "../src/lib/water-lab-types";
import { TETHYS_WATER_FIELD_SIZE, TETHYS_WATER_LEVEL } from "../src/lib/water-profiles";

function sha256(data: Float32Array): string {
  return createHash("sha256").update(Buffer.from(data.buffer, data.byteOffset, data.byteLength)).digest("hex");
}

function options(overrides: Partial<WaterLabOptions> = {}): WaterLabOptions {
  return { ...DEFAULT_WATER_LAB_OPTIONS, ...overrides };
}

function slice(values: Float32Array, offset: number, count = 4) {
  return Array.from(values.subarray(offset, offset + count));
}

const START_TIME = 1000;

describe("computeFrameState", () => {
  const base: FrameStateInput = {
    options: options(),
    camera: DEFAULT_CAMERA_ORBIT,
    timestamp: START_TIME + 167,
    startTime: START_TIME,
    canvasWidth: 1280,
    canvasHeight: 720,
  };

  it("derives elapsed time from the frame timestamp unless fixedTime is set", () => {
    expect(computeFrameState(base).elapsedSeconds).toBeCloseTo(0.167, 12);
    expect(computeFrameState({ ...base, options: options({ fixedTime: 8.25 }) }).elapsedSeconds).toBe(8.25);
  });

  it("orbits the surface target with an orthonormal camera basis", () => {
    const frame = computeFrameState(base);
    expect(frame.underwater).toBe(false);
    expect(frame.eye[0]).toBeCloseTo(30.7333487372894, 10);
    expect(frame.eye[1]).toBeCloseTo(9.2566851455769, 10);
    expect(frame.eye[2]).toBeCloseTo(27.020450640745928, 10);
    expect(Math.hypot(...frame.forward)).toBeCloseTo(1, 12);
    expect(Math.hypot(...frame.right)).toBeCloseTo(1, 12);
    expect(Math.hypot(...frame.up)).toBeCloseTo(1, 12);
    expect(frame.forward[0] * frame.right[0] + frame.forward[1] * frame.right[1] + frame.forward[2] * frame.right[2]).toBeCloseTo(0, 12);
    expect(frame.viewProjection).toBeInstanceOf(Float32Array);
    expect(frame.viewProjection.length).toBe(16);
  });

  it("clamps the submerged camera below the waterline and to a 19 m orbit", () => {
    const frame = computeFrameState({ ...base, options: options({ view: "underwater" }), camera: { yaw: -1.2, pitch: 1.08, radius: 12000 } });
    expect(frame.underwater).toBe(true);
    expect(frame.eye[1]).toBeLessThanOrEqual(TETHYS_WATER_LEVEL - 0.9);
    const horizontal = Math.hypot(frame.eye[0], frame.eye[2] - -18);
    expect(horizontal).toBeCloseTo(Math.cos(1.08) * 19, 10);
  });

  it("moves the wake source around its authored ellipse", () => {
    const rest = computeFrameState({ ...base, timestamp: START_TIME });
    expect(rest.playerPosition).toEqual([0, -12.8]);
    expect(rest.playerVelocity).toEqual([1.65, -0]);
    const later = computeFrameState({ ...base, options: options({ fixedTime: 8.25 }) });
    expect(later.playerPosition[0]).toBeCloseTo(Math.sin(8.25 * 0.22) * 7.5, 12);
    expect(later.playerPosition[1]).toBeCloseTo(-18 + Math.cos(8.25 * 0.22) * 5.2, 12);
  });

  it("only changes the projection when asked for the GL depth range", () => {
    const webgpu = computeFrameState(base);
    const gl = computeFrameState({ ...base, depthRange: "minus-one-to-one" });
    expect(gl.eye).toEqual(webgpu.eye);
    expect(gl.forward).toEqual(webgpu.forward);
    expect(gl.playerPosition).toEqual(webgpu.playerPosition);
    expect(gl.viewProjection).not.toEqual(webgpu.viewProjection);
    const project = (matrix: Float32Array, point: [number, number, number]) => [0, 1, 2, 3].map((row) => matrix[row] * point[0] + matrix[4 + row] * point[1] + matrix[8 + row] * point[2] + matrix[12 + row]);
    const clipWebGpu = project(webgpu.viewProjection, [4, TETHYS_WATER_LEVEL, -30]);
    const clipGl = project(gl.viewProjection, [4, TETHYS_WATER_LEVEL, -30]);
    expect(clipGl[0] / clipGl[3]).toBeCloseTo(clipWebGpu[0] / clipWebGpu[3], 5);
    expect((clipGl[2] / clipGl[3]) * 0.5 + 0.5).toBeCloseTo(clipWebGpu[2] / clipWebGpu[3], 5);
  });

  it("does not mutate its input", () => {
    const camera = Object.freeze({ yaw: 0.3, pitch: 0.2, radius: 40 });
    const input = Object.freeze({ ...base, camera, options: Object.freeze(options()) });
    expect(() => computeFrameState(input)).not.toThrow();
    expect(camera).toEqual({ yaw: 0.3, pitch: 0.2, radius: 40 });
  });
});

describe("packWorldUniforms", () => {
  const frame: FrameState = {
    elapsedSeconds: 3.5,
    eye: [1, 2, 3],
    forward: [10, 11, 12],
    right: [4, 5, 6],
    up: [7, 8, 9],
    viewProjection: new Float32Array(Array.from({ length: 16 }, (_, index) => index + 100)),
    playerPosition: [13, 14],
    playerVelocity: [3, 4],
    underwater: true,
  };

  it("uses the WorldUniforms float offsets from the shared WGSL struct", () => {
    expect(WORLD_UNIFORM_OFFSETS).toEqual({
      viewProj: 0, cameraTime: 16, cameraRight: 20, cameraUp: 24, cameraForward: 28, sunWater: 32,
      terrain: 36, simulation: 40, player: 44, interaction: 48, environment: 52, waves: 56, atmosphere: 60,
    });
  });

  it("packs every field of the 256-byte block at its offset", () => {
    const values = packWorldUniforms({
      frame,
      options: options({ meshResolution: 200, simulationResolution: 128, scene: "open", waveScale: 1.5, distantRoughness: 0.7, detailRange: 2.5, fogReach: 1.2, swellSmoothing: 0.4, longCascadeScale: 133, mediumCascadeScale: 37 }),
      canvasWidth: 1920,
      canvasHeight: 1080,
      worldScale: OPEN_WATER_VIEW_SCALE,
    });
    const tanHalfFov = Math.tan(26 * Math.PI / 180);
    expect(values.length).toBe(64);
    expect(values.byteLength).toBe(256);
    expect(slice(values, 0, 16)).toEqual(Array.from(frame.viewProjection));
    expect(slice(values, WORLD_UNIFORM_OFFSETS.cameraTime)).toEqual([1, 2, 3, 3.5]);
    expect(slice(values, WORLD_UNIFORM_OFFSETS.cameraRight)).toEqual([4, 5, 6, Math.fround(tanHalfFov * (1920 / 1080))]);
    expect(slice(values, WORLD_UNIFORM_OFFSETS.cameraUp)).toEqual([7, 8, 9, Math.fround(tanHalfFov)]);
    expect(slice(values, WORLD_UNIFORM_OFFSETS.cameraForward)).toEqual([10, 11, 12, 0]);
    const sunLength = Math.hypot(-0.52, 0.30, -0.80);
    expect(slice(values, WORLD_UNIFORM_OFFSETS.sunWater)).toEqual([Math.fround(-0.52 / sunLength), Math.fround(0.30 / sunLength), Math.fround(-0.80 / sunLength), Math.fround(TETHYS_WATER_LEVEL)]);
    expect(slice(values, WORLD_UNIFORM_OFFSETS.terrain)).toEqual([TERRAIN_EXTENT, 200, 128, 1]);
    expect(slice(values, WORLD_UNIFORM_OFFSETS.simulation)).toEqual([0, -12, TETHYS_WATER_FIELD_SIZE, 1 / 128]);
    expect(slice(values, WORLD_UNIFORM_OFFSETS.player)).toEqual([13, 14, 3, 4]);
    expect(slice(values, WORLD_UNIFORM_OFFSETS.interaction)).toEqual([5, 1, 1920, 1080]);
    expect(slice(values, WORLD_UNIFORM_OFFSETS.environment)).toEqual([0, 200, 200, 100]);
    expect(slice(values, WORLD_UNIFORM_OFFSETS.waves)).toEqual([1.5, 2.25, Math.fround(0.7), 2.5]);
    expect(slice(values, WORLD_UNIFORM_OFFSETS.atmosphere)).toEqual([Math.fround(1.2), Math.fround(0.4), 133, 37]);
  });

  it("flags the island scene and forces its 512 terrain grid", () => {
    const values = packWorldUniforms({ frame, options: options({ scene: "shore", meshResolution: 240 }), canvasWidth: 640, canvasHeight: 360, worldScale: 100 });
    expect(slice(values, WORLD_UNIFORM_OFFSETS.environment)).toEqual([1, 512, 512, 100]);
    expect(slice(values, WORLD_UNIFORM_OFFSETS.terrain)).toEqual([TERRAIN_EXTENT, 240, 256, 1]);
  });

  it("returns a new buffer on every call", () => {
    const input = { frame, options: options(), canvasWidth: 8, canvasHeight: 8, worldScale: 100 };
    expect(packWorldUniforms(input)).not.toBe(packWorldUniforms(input));
  });
});

describe("computeSimulationParams", () => {
  it("emits an impulse only when the wake interval has elapsed", () => {
    const base = { playerPosition: [0, -12] as const, mode: "optimized" as const };
    expect(computeSimulationParams({ ...base, elapsedSeconds: 0, lastWakeAt: -10 }).wakeTriggered).toBe(true);
    expect(computeSimulationParams({ ...base, elapsedSeconds: 0.05, lastWakeAt: 0 }).wakeTriggered).toBe(false);
    expect(computeSimulationParams({ ...base, elapsedSeconds: 0.1, lastWakeAt: 0 }).wakeTriggered).toBe(true);
    // 0.15 - 0.05 is just under 0.10 in floating point, exactly as the engine behaved.
    expect(computeSimulationParams({ ...base, elapsedSeconds: 0.15, lastWakeAt: 0.05 }).wakeTriggered).toBe(false);
    expect(computeSimulationParams({ ...base, elapsedSeconds: 0.16, lastWakeAt: 0.05 }).wakeTriggered).toBe(true);
  });

  it("lays out the impulse and calm blocks", () => {
    const params = computeSimulationParams({ playerPosition: [0, -12], elapsedSeconds: 1, lastWakeAt: -10, mode: "optimized" });
    expect(Array.from(params.impulse)).toEqual([0.5, 0.5, Math.fround(-0.012), Math.fround(0.54 / 192), Math.fround(1 / 60), Math.fround(0.72), 0, 0]);
    expect(Array.from(params.calm)).toEqual([0.5, 0.5, 0, Math.fround(0.54 / 192), Math.fround(1 / 60), Math.fround(0.72), 0, 0]);
    expect(params.impulse.byteLength).toBe(32);
    expect(params.calm.byteLength).toBe(32);
  });

  it("halves the step in reference mode and zeroes the strength when idle", () => {
    const params = computeSimulationParams({ playerPosition: [96, 84], elapsedSeconds: 1.05, lastWakeAt: 1, mode: "reference" });
    expect(params.wakeTriggered).toBe(false);
    expect(params.impulse[2]).toBe(0);
    expect(params.impulse[4]).toBe(Math.fround(1 / 120));
    expect(params.impulse[0]).toBe(1);
    expect(params.impulse[1]).toBe(1);
    expect(Array.from(params.impulse)).toEqual(Array.from(params.calm));
  });
});

describe("frame pipeline golden snapshots", () => {
  // Captured from the WebGPU engine's queue.writeBuffer payloads before the
  // extraction; startTime 1000 ms in every scenario.
  const worldScale = OPEN_WATER_VIEW_SCALE;

  function run(input: FrameStateInput, fullOptions: WaterLabOptions, lastWakeAt: number) {
    const frame = computeFrameState(input);
    const uniforms = packWorldUniforms({ frame, options: fullOptions, canvasWidth: input.canvasWidth, canvasHeight: input.canvasHeight, worldScale });
    const params = computeSimulationParams({ playerPosition: frame.playerPosition, elapsedSeconds: frame.elapsedSeconds, lastWakeAt, mode: fullOptions.mode });
    return { frame, uniforms, params };
  }

  it("matches the default open-ocean frame", () => {
    const opts = options();
    const { uniforms, params } = run({ options: opts, camera: DEFAULT_CAMERA_ORBIT, timestamp: START_TIME + 167, startTime: START_TIME, canvasWidth: 1280, canvasHeight: 720 }, opts, -10);
    expect(sha256(uniforms)).toBe("1abef0d23bb4d1215d59e78389fd72170107ac4350c07a01ebf3ce5d2b9e8e4d");
    expect(params.wakeTriggered).toBe(true);
    expect(sha256(params.impulse)).toBe("936244de1be720545cc57f518d810f838f7bc35a070298b5ded7a998cc4a5b23");
    expect(sha256(params.calm)).toBe("8357fd4bee8774d44a4196e16acfc2a57bb8526d5d8825ba18d3042397080494");
  });

  it("matches the submerged reference frame at the orbit ceiling", () => {
    const opts = options({ view: "underwater", mode: "reference", cameraPitch: 5, cameraYaw: -1.2 });
    const camera = { ...resolveInitialCameraOrbit(opts), radius: 12000 };
    expect(camera).toEqual({ yaw: -1.2, pitch: 1.08, radius: 12000 });
    const { uniforms, params } = run({ options: opts, camera, timestamp: START_TIME + 40000, startTime: START_TIME, canvasWidth: 1024, canvasHeight: 512 }, opts, -10);
    expect(sha256(uniforms)).toBe("c00108f9f941e69bf8f0a5295d42eae73ffcf1a83197b093515409a7e9113bbb");
    expect(sha256(params.impulse)).toBe("a95dfc6eaf33d6e3e7da3d59e4786b053fee4851fa8d497961003cb68aaffda1");
    expect(sha256(params.calm)).toBe("1dd82a17062fcbf85f7c5f3d16b9170d2e3bfabc115590122d3610c5d16c3d4f");
  });

  it("matches a fixed-time frame with the camera clamped to its limits", () => {
    const opts = options({ fixedTime: 8.25, cameraYaw: 2.05, cameraPitch: -0.02, meshResolution: 96 });
    const camera = { yaw: 2.05, pitch: 1.08, radius: 6 };
    const first = run({ options: opts, camera, timestamp: START_TIME + 100, startTime: START_TIME, canvasWidth: 800, canvasHeight: 600 }, opts, -10);
    expect(sha256(first.uniforms)).toBe("e7473485d6f7f2c3efbb2e7c044ba7e00f8741791a9ea77c4d3d139f32e49490");
    expect(sha256(first.params.impulse)).toBe("1e6921b28bdcfb5b690ccace5f883f6fcb9db85eb55113f2b06e36f6e74623c1");
    const second = run({ options: opts, camera, timestamp: START_TIME + 116.7, startTime: START_TIME, canvasWidth: 800, canvasHeight: 600 }, opts, 8.25);
    expect(sha256(second.uniforms)).toBe("e7473485d6f7f2c3efbb2e7c044ba7e00f8741791a9ea77c4d3d139f32e49490");
    expect(second.params.wakeTriggered).toBe(false);
    expect(sha256(second.params.impulse)).toBe("3c701940d05a2e5093c18a5dd8676a917427e54ccd3a0cfbfcdd8655e3fb4b46");
    expect(sha256(second.params.calm)).toBe("3c701940d05a2e5093c18a5dd8676a917427e54ccd3a0cfbfcdd8655e3fb4b46");
  });

  it("matches the island scene across a wake-throttled frame sequence", () => {
    const opts = options({ scene: "shore" });
    const camera = resolveInitialCameraOrbit(opts);
    expect(camera).toEqual({ yaw: Math.PI, pitch: 0.22, radius: 58 });
    const expectedUniforms = [
      "1b1ff5be2af7b4a75388410dbae206c555bb17842c9e8d7028a8ee6c411ec51b",
      "e87abc3af16a1ca0c35585ff7a7f292e39ba5c09694fa00518df8338c87a4da4",
      "a1b7e3089c8bce5625681cd409e7e90203d9f67e816cc28c46cd462b081ae599",
      "96ec6f7c67c61e46f21af22e4746af071db983299c3df81aeea29f0973d4ca5c",
    ];
    const expectedImpulse = [
      "7d875f25b228be8c77da83a035bddc394f7b3a997c97ded0173c5b20e2d4129f",
      "3503462241bb97ba0dc082a64540e6e23b8d6346d9e0626fb63b56c8942ba2c6",
      "b11249857a5baa68cf72453554474399c5ee7d589ae0bb3f608b90a1a8327839",
      "e8f403ae11d62bacea7049cecd626c1df29dce13f514db5878649074808b3d91",
    ];
    const expectedWakes = [true, false, true, false];
    const state = [50, 150, 160, 250].reduce((accumulator, offset, index) => {
      const { frame, uniforms, params } = run({ options: opts, camera, timestamp: START_TIME + offset, startTime: START_TIME, canvasWidth: 640, canvasHeight: 360 }, opts, accumulator.lastWakeAt);
      expect(sha256(uniforms)).toBe(expectedUniforms[index]);
      expect(sha256(params.impulse)).toBe(expectedImpulse[index]);
      expect(params.wakeTriggered).toBe(expectedWakes[index]);
      return params.wakeTriggered
        ? { lastWakeAt: frame.elapsedSeconds, disturbances: accumulator.disturbances + 1 }
        : accumulator;
    }, { lastWakeAt: -10, disturbances: 0 });
    expect(state).toEqual({ lastWakeAt: 0.16, disturbances: 2 });
  });
});

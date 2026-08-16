import { describe, expect, it } from "vitest";

import * as api from "../src/index";

// The package surface, pinned. Adding an export here is a deliberate act; this
// test is what makes an accidental one visible in a diff.

const EXPECTED_EXPORTS = [
  "DEFAULT_CAMERA_ORBIT",
  "DEFAULT_WATER_LAB_OPTIONS",
  "MAX_CAMERA_PITCH",
  "MIN_CAMERA_PITCH",
  "MIN_ORBIT_RADIUS",
  "TETHYS_REFERENCE_SIMULATION_RESOLUTION",
  "TETHYS_WATER_FIELD_SIZE",
  "TETHYS_WATER_LEVEL",
  "WATER_LAB_OPTION_BOUNDS",
  "WATER_PROFILES",
  "WebGl2WaterEngine",
  "clampCameraPitch",
  "frameTriangleCount",
  "normalizeWaterLabOption",
  "normalizeWaterLabOptions",
  "parseWaterLabQuery",
  "resolveInitialCameraOrbit",
  "waterSimulationBytes",
  "waterTriangleCount",
] as const;

describe("package surface", () => {
  it("exports exactly the documented names", () => {
    expect(Object.keys(api).sort()).toEqual([...EXPECTED_EXPORTS].sort());
  });

  it("hands out the engine class itself, not a factory", () => {
    expect(typeof api.WebGl2WaterEngine).toBe("function");
    expect(api.WebGl2WaterEngine.name).toBe("WebGl2WaterEngine");
  });

  it("freezes the shared option defaults and bounds", () => {
    expect(Object.isFrozen(api.DEFAULT_WATER_LAB_OPTIONS)).toBe(true);
    expect(Object.isFrozen(api.WATER_LAB_OPTION_BOUNDS)).toBe(true);
  });

  it("re-exports no WebGPU, Three.js or ship symbol", () => {
    const names = Object.keys(api).join(" ");
    expect(names).not.toMatch(/WebGpu|WebGPU|Three|Ship|Gltf/);
  });
});

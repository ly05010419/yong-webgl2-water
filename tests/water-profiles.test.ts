import { describe, expect, it } from "vitest";

import {
  TETHYS_REFERENCE_SIMULATION_RESOLUTION,
  WATER_PROFILES,
  waterSimulationBytes,
  waterTriangleCount,
} from "../src/lib/water-profiles";

describe("Tethys WebGPU quality contracts", () => {
  it("retains the production 256-square simulation in the balanced profile", () => {
    expect(WATER_PROFILES[0].simulationResolution).toBe(TETHYS_REFERENCE_SIMULATION_RESOLUTION);
    expect(WATER_PROFILES[0].meshResolution).toBe(240);
  });

  it("accounts for two rgba16float simulation fields", () => {
    expect(waterSimulationBytes(256)).toBe(1_048_576);
  });

  it("counts both terrain and water procedural grids", () => {
    expect(waterTriangleCount(176)).toBe(123_904);
  });
});

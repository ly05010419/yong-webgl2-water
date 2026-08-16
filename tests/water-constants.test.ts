import { describe, expect, it } from "vitest";

import {
  BREAKER_ENABLED,
  BREAKER_PATCH_TRIANGLES,
  BREAKER_SHADER_GATE,
  OPEN_WATER_FAR_PLANE,
  SUN_DIRECTION,
  TERRAIN_EXTENT,
  WATER_CLIPMAP_LEVELS,
  WATER_HORIZON_REACH,
  WORLD_UNIFORM_BYTES,
} from "../src/lib/water-constants";
import * as lab from "../src/lib/water-lab-types";

describe("shared water constants", () => {
  it("keeps the authored world and shader gate values", () => {
    expect(TERRAIN_EXTENT).toBe(520);
    expect(WORLD_UNIFORM_BYTES).toBe(256);
    expect(BREAKER_ENABLED).toBe(false);
    expect(BREAKER_SHADER_GATE).toBe("0.0");
    expect(BREAKER_PATCH_TRIANGLES).toBe(256 * 48 * 2);
    // the horizon skirt must lie beyond the outermost clipmap ring and inside the far plane
    expect(WATER_HORIZON_REACH).toBeGreaterThan(32 * 2 ** (WATER_CLIPMAP_LEVELS - 1));
    expect(WATER_HORIZON_REACH).toBeLessThan(OPEN_WATER_FAR_PLANE);
    expect(SUN_DIRECTION).toEqual([-0.52, 0.30, -0.80]);
  });
});

describe("water lab option types", () => {
  it("freezes the shared defaults and carries no ship or backend field", () => {
    expect(Object.isFrozen(lab.DEFAULT_WATER_LAB_OPTIONS)).toBe(true);
    expect(lab.DEFAULT_WATER_LAB_OPTIONS).toEqual({
      mode: "optimized",
      view: "surface",
      scene: "open",
      meshResolution: 240,
      simulationResolution: 256,
      renderScale: 1,
      waveScale: 1,
      distantRoughness: 0,
      detailRange: 1,
      swellSmoothing: 1,
      longCascadeScale: 240,
      mediumCascadeScale: 64,
      fogReach: 0,
      benchmark: false,
    });
    expect(Object.keys(lab.DEFAULT_WATER_LAB_OPTIONS)).not.toContain("shipModelUrl");
  });
});

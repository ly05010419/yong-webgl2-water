import { describe, expect, it } from "vitest";

import { parseWaterLabQuery } from "../src/lib/water-lab-query";
import { DEFAULT_WATER_LAB_OPTIONS, WATER_LAB_OPTION_BOUNDS } from "../src/lib/water-lab-types";

// The demo's URL contract. Every numeric parameter goes through the shared
// clamp, so a URL and the equivalent sequence of setter calls have to land on
// the same engine state — this file is what pins that.

describe("parseWaterLabQuery defaults", () => {
  it("returns the shared defaults for an empty query", () => {
    const { options, showUi } = parseWaterLabQuery("");
    expect(showUi).toBe(true);
    expect(options.mode).toBe(DEFAULT_WATER_LAB_OPTIONS.mode);
    expect(options.view).toBe(DEFAULT_WATER_LAB_OPTIONS.view);
    expect(options.scene).toBe(DEFAULT_WATER_LAB_OPTIONS.scene);
    expect(options.meshResolution).toBe(DEFAULT_WATER_LAB_OPTIONS.meshResolution);
    expect(options.simulationResolution).toBe(DEFAULT_WATER_LAB_OPTIONS.simulationResolution);
    expect(options.waveScale).toBe(DEFAULT_WATER_LAB_OPTIONS.waveScale);
    expect(options.fixedTime).toBeUndefined();
    expect(options.frameLimit).toBeUndefined();
    expect(options.benchmark).toBe(false);
  });

  it("accepts a leading question mark", () => {
    expect(parseWaterLabQuery("?scene=shore").options.scene).toBe("shore");
    expect(parseWaterLabQuery("scene=shore").options.scene).toBe("shore");
  });

  it("reads the enumerated parameters and falls back on anything else", () => {
    const shore = parseWaterLabQuery("mode=reference&view=underwater&scene=shore").options;
    expect(shore.mode).toBe("reference");
    expect(shore.view).toBe("underwater");
    expect(shore.scene).toBe("shore");
    const nonsense = parseWaterLabQuery("mode=fast&view=aerial&scene=lagoon").options;
    expect(nonsense.mode).toBe("optimized");
    expect(nonsense.view).toBe("surface");
    expect(nonsense.scene).toBe("open");
  });

  it("hides the panel only for ui=0", () => {
    expect(parseWaterLabQuery("ui=0").showUi).toBe(false);
    expect(parseWaterLabQuery("ui=1").showUi).toBe(true);
    expect(parseWaterLabQuery("").showUi).toBe(true);
  });
});

describe("parseWaterLabQuery numeric clamping", () => {
  it("clamps to the shared bounds rather than a second copy of them", () => {
    const low = parseWaterLabQuery("mesh=1&simulation=1&scale=0&waves=0&detail=0&longScale=1&mediumScale=1").options;
    expect(low.meshResolution).toBe(WATER_LAB_OPTION_BOUNDS.meshResolution.min);
    expect(low.simulationResolution).toBe(WATER_LAB_OPTION_BOUNDS.simulationResolution.min);
    expect(low.renderScale).toBe(WATER_LAB_OPTION_BOUNDS.renderScale.min);
    expect(low.waveScale).toBe(WATER_LAB_OPTION_BOUNDS.waveScale.min);
    expect(low.detailRange).toBe(WATER_LAB_OPTION_BOUNDS.detailRange.min);
    expect(low.longCascadeScale).toBe(WATER_LAB_OPTION_BOUNDS.longCascadeScale.min);
    expect(low.mediumCascadeScale).toBe(WATER_LAB_OPTION_BOUNDS.mediumCascadeScale.min);

    const high = parseWaterLabQuery("mesh=9999&simulation=9999&scale=9&waves=9&farRough=9&smooth=9&fog=9").options;
    expect(high.meshResolution).toBe(WATER_LAB_OPTION_BOUNDS.meshResolution.max);
    expect(high.simulationResolution).toBe(WATER_LAB_OPTION_BOUNDS.simulationResolution.max);
    expect(high.renderScale).toBe(WATER_LAB_OPTION_BOUNDS.renderScale.max);
    expect(high.waveScale).toBe(WATER_LAB_OPTION_BOUNDS.waveScale.max);
    expect(high.distantRoughness).toBe(WATER_LAB_OPTION_BOUNDS.distantRoughness.max);
    expect(high.swellSmoothing).toBe(WATER_LAB_OPTION_BOUNDS.swellSmoothing.max);
    expect(high.fogReach).toBe(WATER_LAB_OPTION_BOUNDS.fogReach.max);
  });

  it("rounds fractional grid resolutions instead of flooring them", () => {
    // B-03: `?simulation=256.5` used to reach the engine as a fraction and fail
    // texture allocation. Rounding is the friendlier snap; the clamp then
    // guarantees an integer inside the bounds either way.
    expect(parseWaterLabQuery("simulation=256.5").options.simulationResolution).toBe(257);
    expect(parseWaterLabQuery("mesh=239.4").options.meshResolution).toBe(239);
  });

  it("ignores unparseable and empty values", () => {
    const options = parseWaterLabQuery("mesh=abc&simulation=&scale=NaN&waves=Infinity").options;
    expect(options.meshResolution).toBe(DEFAULT_WATER_LAB_OPTIONS.meshResolution);
    expect(options.simulationResolution).toBe(DEFAULT_WATER_LAB_OPTIONS.simulationResolution);
    expect(options.renderScale).toBe(DEFAULT_WATER_LAB_OPTIONS.renderScale);
    expect(options.waveScale).toBe(DEFAULT_WATER_LAB_OPTIONS.waveScale);
  });

  it("keeps zero as a real value where the bounds allow it", () => {
    const options = parseWaterLabQuery("smooth=0&fog=0&farRough=0").options;
    expect(options.swellSmoothing).toBe(0);
    expect(options.fogReach).toBe(0);
    expect(options.distantRoughness).toBe(0);
  });
});

describe("parseWaterLabQuery capture parameters", () => {
  it("floors frames before testing it, so a sub-frame request runs forever", () => {
    expect(parseWaterLabQuery("frames=240").options.frameLimit).toBe(240);
    expect(parseWaterLabQuery("frames=240.9").options.frameLimit).toBe(240);
    // Floor(0.5) = 0 would have stopped the loop before the first frame.
    expect(parseWaterLabQuery("frames=0.5").options.frameLimit).toBeUndefined();
    expect(parseWaterLabQuery("frames=0").options.frameLimit).toBeUndefined();
    expect(parseWaterLabQuery("frames=-5").options.frameLimit).toBeUndefined();
    expect(parseWaterLabQuery("frames=abc").options.frameLimit).toBeUndefined();
  });

  it("passes fixedTime, the camera overrides and benchmark through", () => {
    const options = parseWaterLabQuery("fixedTime=8.25&yaw=1.5&pitch=-0.2&benchmark=1").options;
    expect(options.fixedTime).toBe(8.25);
    expect(options.cameraYaw).toBe(1.5);
    expect(options.cameraPitch).toBe(-0.2);
    expect(options.benchmark).toBe(true);
    expect(parseWaterLabQuery("benchmark=true").options.benchmark).toBe(false);
  });

  it("keeps fixedTime=0 rather than treating it as absent", () => {
    expect(parseWaterLabQuery("fixedTime=0").options.fixedTime).toBe(0);
  });
});

import { describe, expect, it } from "vitest";

import {
  DEFAULT_WATER_LAB_OPTIONS,
  WATER_LAB_OPTION_BOUNDS,
  normalizeWaterLabOption,
  normalizeWaterLabOptions,
  type NumericWaterLabOption,
  type WaterLabOptions,
} from "../src/lib/water-lab-types";

const NUMERIC_OPTIONS = Object.keys(WATER_LAB_OPTION_BOUNDS) as NumericWaterLabOption[];

describe("normalizeWaterLabOption", () => {
  it.each(NUMERIC_OPTIONS)("clamps %s to both ends of its range", (option) => {
    const { min, max } = WATER_LAB_OPTION_BOUNDS[option];
    expect(normalizeWaterLabOption(option, min - 1000)).toBe(min);
    expect(normalizeWaterLabOption(option, max + 1000)).toBe(max);
    expect(normalizeWaterLabOption(option, min)).toBe(min);
    expect(normalizeWaterLabOption(option, max)).toBe(max);
  });

  it.each(NUMERIC_OPTIONS)("falls back to the default of %s for every non-finite input", (option) => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(normalizeWaterLabOption(option, value)).toBe(DEFAULT_WATER_LAB_OPTIONS[option]);
    }
  });

  it.each(NUMERIC_OPTIONS)("keeps %s inside its range for every default", (option) => {
    const { min, max } = WATER_LAB_OPTION_BOUNDS[option];
    const value = DEFAULT_WATER_LAB_OPTIONS[option];
    expect(value).toBeGreaterThanOrEqual(min);
    expect(value).toBeLessThanOrEqual(max);
  });

  it("floors the two grid resolutions and leaves the continuous options alone", () => {
    expect(normalizeWaterLabOption("meshResolution", 240.9)).toBe(240);
    expect(normalizeWaterLabOption("meshResolution", 95.5)).toBe(96);
    expect(normalizeWaterLabOption("simulationResolution", 255.9)).toBe(255);
    expect(normalizeWaterLabOption("simulationResolution", 512.9)).toBe(512);
    expect(normalizeWaterLabOption("renderScale", 0.7532)).toBe(0.7532);
    expect(normalizeWaterLabOption("waveScale", 1.234)).toBe(1.234);
  });

  it("matches the ranges the engines document", () => {
    expect(normalizeWaterLabOption("meshResolution", 0)).toBe(96);
    expect(normalizeWaterLabOption("meshResolution", 10_000)).toBe(320);
    expect(normalizeWaterLabOption("simulationResolution", 0)).toBe(64);
    expect(normalizeWaterLabOption("simulationResolution", 10_000)).toBe(512);
    expect(normalizeWaterLabOption("renderScale", 0)).toBe(0.5);
    expect(normalizeWaterLabOption("renderScale", 9)).toBe(1.25);
    expect(normalizeWaterLabOption("waveScale", 0)).toBe(0.15);
    expect(normalizeWaterLabOption("waveScale", 9)).toBe(1.6);
    expect(normalizeWaterLabOption("distantRoughness", -1)).toBe(0);
    expect(normalizeWaterLabOption("distantRoughness", 9)).toBe(3);
    expect(normalizeWaterLabOption("detailRange", 0)).toBe(0.4);
    expect(normalizeWaterLabOption("detailRange", 99)).toBe(8);
    expect(normalizeWaterLabOption("swellSmoothing", -1)).toBe(0);
    expect(normalizeWaterLabOption("swellSmoothing", 99)).toBe(3);
    expect(normalizeWaterLabOption("longCascadeScale", 1)).toBe(80);
    expect(normalizeWaterLabOption("longCascadeScale", 9_999)).toBe(480);
    expect(normalizeWaterLabOption("mediumCascadeScale", 1)).toBe(24);
    expect(normalizeWaterLabOption("mediumCascadeScale", 9_999)).toBe(128);
    expect(normalizeWaterLabOption("fogReach", -1)).toBe(0);
    expect(normalizeWaterLabOption("fogReach", 99)).toBe(3);
  });
});

describe("normalizeWaterLabOptions", () => {
  it("returns the defaults for an empty input", () => {
    expect(normalizeWaterLabOptions({})).toEqual({ ...DEFAULT_WATER_LAB_OPTIONS });
    expect(normalizeWaterLabOptions()).toEqual({ ...DEFAULT_WATER_LAB_OPTIONS });
  });

  it("clamps every numeric field at once", () => {
    const normalized = normalizeWaterLabOptions({
      meshResolution: 10_000,
      simulationResolution: 1,
      renderScale: 4,
      waveScale: -3,
      distantRoughness: 99,
      detailRange: 0,
      swellSmoothing: -2,
      longCascadeScale: 1,
      mediumCascadeScale: 9_999,
      fogReach: 42,
    });
    expect(normalized).toMatchObject({
      meshResolution: 320,
      simulationResolution: 64,
      renderScale: 1.25,
      waveScale: 0.15,
      distantRoughness: 3,
      detailRange: 0.4,
      swellSmoothing: 0,
      longCascadeScale: 80,
      mediumCascadeScale: 128,
      fogReach: 3,
    });
  });

  it("replaces every non-finite numeric field with its default", () => {
    const broken = Object.fromEntries(NUMERIC_OPTIONS.map((option) => [option, Number.NaN])) as Partial<WaterLabOptions>;
    const normalized = normalizeWaterLabOptions(broken);
    for (const option of NUMERIC_OPTIONS) expect(normalized[option]).toBe(DEFAULT_WATER_LAB_OPTIONS[option]);
  });

  it("keeps floored resolutions and untouched non-numeric fields", () => {
    const normalized = normalizeWaterLabOptions({
      meshResolution: 200.9,
      simulationResolution: 383.5,
      mode: "reference",
      view: "underwater",
      scene: "shore",
      fixedTime: 8.25,
      frameLimit: 240,
      benchmark: true,
      cameraYaw: -1.5,
      cameraPitch: 0.4,
    });
    expect(normalized.meshResolution).toBe(200);
    expect(normalized.simulationResolution).toBe(383);
    expect(normalized.mode).toBe("reference");
    expect(normalized.view).toBe("underwater");
    expect(normalized.scene).toBe("shore");
    expect(normalized.fixedTime).toBe(8.25);
    expect(normalized.frameLimit).toBe(240);
    expect(normalized.benchmark).toBe(true);
    // Pitch clamping belongs to `resolveInitialCameraOrbit`, not to this pass.
    expect(normalized.cameraYaw).toBe(-1.5);
    expect(normalized.cameraPitch).toBe(0.4);
  });

  it("leaves the optional keys absent when the caller omitted them", () => {
    const normalized = normalizeWaterLabOptions({ scene: "open" });
    expect("fixedTime" in normalized).toBe(false);
    expect("frameLimit" in normalized).toBe(false);
    expect("cameraYaw" in normalized).toBe(false);
    expect("cameraPitch" in normalized).toBe(false);
  });

  it("is pure and idempotent", () => {
    const input: Partial<WaterLabOptions> = { meshResolution: 10_000, waveScale: Number.NaN };
    const once = normalizeWaterLabOptions(input);
    const twice = normalizeWaterLabOptions(once);
    expect(twice).toEqual(once);
    expect(input).toEqual({ meshResolution: 10_000, waveScale: Number.NaN });
  });
});

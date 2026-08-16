import { describe, expect, it } from "vitest";

import { stepNearshoreCell, type NearshoreCell } from "../src/lib/nearshore-reference";

function cell(depth: number, bottom = -4, qx = 0, qz = 0): NearshoreCell {
  return { depth, bottom, qx, qz };
}

describe("nearshore conservative solver contract", () => {
  it("preserves a flat lake at rest", () => {
    const still = cell(5.4);
    expect(stepNearshoreCell(still, still, still, still, still, 1 / 120, 0.75)).toEqual([5.4, 0, 0]);
  });

  it("is well balanced over a bottom step with a level surface", () => {
    const center = cell(5.4, -4);
    const shallow = cell(3.4, -2);
    const next = stepNearshoreCell(center, center, shallow, center, center, 1 / 240, 0.75);
    expect(next[0]).toBeCloseTo(center.depth, 10);
    expect(next[1]).toBeCloseTo(0, 10);
    expect(next[2]).toBeCloseTo(0, 10);
  });

  it("never creates negative water depth at a wet-dry front", () => {
    const wet = cell(0.05, 1.35, 0.08, 0);
    const dry = cell(0, 1.45);
    const next = stepNearshoreCell(wet, dry, dry, dry, dry, 1 / 240, 0.75);
    expect(Number.isFinite(next[0])).toBe(true);
    expect(next[0]).toBeGreaterThanOrEqual(0);
  });

  it("conserves depth across two closed neighbouring cells", () => {
    const high = cell(5.6);
    const low = cell(5.2);
    const nextHigh = stepNearshoreCell(high, high, low, high, high, 1 / 240, 0.75);
    const nextLow = stepNearshoreCell(low, high, low, low, low, 1 / 240, 0.75);
    expect(nextHigh[0] + nextLow[0]).toBeCloseTo(high.depth + low.depth, 10);
  });
});

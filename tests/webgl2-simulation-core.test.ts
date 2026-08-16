import { describe, expect, it } from "vitest";

import {
  NEARSHORE_GRAVITY,
  NEARSHORE_MIN_DEPTH,
  stepNearshoreCell,
  type NearshoreCell,
  type NearshoreState,
} from "../src/lib/nearshore-reference";
import { TETHYS_WATER_LEVEL } from "../src/lib/water-profiles";
import { WATER_SIMULATION_FRAGMENT_GLSL } from "../src/lib/webgl2/water-simulation-glsl";

// --- Numerical cross-check -------------------------------------------------
//
// `stepNearshoreCell` in src/lib/nearshore-reference.ts is the independent CPU
// mirror of one conservative cell update. The functions below are a literal
// transcription of the GLSL above (same order, same clamps, same ternaries),
// so agreement between the two means the port did not flip a select, swap the
// members of HydrostaticPair or lose a pressure correction. The two differ in
// one deliberate way, which is exactly what makes the comparison meaningful:
// the reference reconstructs interface surfaces as `bottom + depth`, while the
// shader uses `waterLevel + eta` — they must coincide for every wet cell.

const WATER_LEVEL = TETHYS_WATER_LEVEL;
const GRAVITY = Number(/const float GRAVITY = ([\d.]+);/.exec(WATER_SIMULATION_FRAGMENT_GLSL)?.[1]);
const MIN_DEPTH = Number(/const float MIN_DEPTH = ([\d.]+);/.exec(WATER_SIMULATION_FRAGMENT_GLSL)?.[1]);

type Vec3 = [number, number, number];
type GlslCell = { readonly eta: number; readonly q: readonly [number, number]; readonly bottom: number; readonly depth: number };

/** Builds the cell `loadCell` would produce for a given depth and bottom. */
function glslCell(depth: number, bottom: number, qx: number, qz: number): GlslCell {
  const eta = depth + bottom - WATER_LEVEL;
  const loadedDepth = Math.max(WATER_LEVEL + eta - bottom, 0);
  const q: readonly [number, number] = loadedDepth <= MIN_DEPTH ? [0, 0] : [qx, qz];
  return { eta, q, bottom, depth: loadedDepth };
}

function conservativeState(cell: GlslCell, reconstructedDepth: number): Vec3 {
  const scale = cell.depth <= MIN_DEPTH ? 0 : reconstructedDepth / Math.max(cell.depth, MIN_DEPTH);
  return [reconstructedDepth, cell.q[0] * scale, cell.q[1] * scale];
}

function physicalFluxX(state: Vec3): Vec3 {
  const h = Math.max(state[0], MIN_DEPTH);
  return [state[1], state[1] * (state[1] / h) + 0.5 * GRAVITY * state[0] * state[0], state[1] * (state[2] / h)];
}

function physicalFluxY(state: Vec3): Vec3 {
  const h = Math.max(state[0], MIN_DEPTH);
  return [state[2], state[2] * (state[1] / h), state[2] * (state[2] / h) + 0.5 * GRAVITY * state[0] * state[0]];
}

function hydrostaticPair(a: GlslCell, b: GlslCell): readonly [Vec3, Vec3] {
  const interfaceBottom = Math.max(a.bottom, b.bottom);
  const hA = Math.max(0, WATER_LEVEL + a.eta - interfaceBottom);
  const hB = Math.max(0, WATER_LEVEL + b.eta - interfaceBottom);
  return [conservativeState(a, hA), conservativeState(b, hB)];
}

function rusanov(a: GlslCell, b: GlslCell, axis: 1 | 2): Vec3 {
  const [left, right] = hydrostaticPair(a, b);
  const uLeft = left[0] <= MIN_DEPTH ? 0 : left[axis] / Math.max(left[0], MIN_DEPTH);
  const uRight = right[0] <= MIN_DEPTH ? 0 : right[axis] / Math.max(right[0], MIN_DEPTH);
  const speed = Math.max(Math.abs(uLeft) + Math.sqrt(GRAVITY * left[0]), Math.abs(uRight) + Math.sqrt(GRAVITY * right[0]));
  const flux = axis === 1 ? physicalFluxX : physicalFluxY;
  const fluxLeft = flux(left);
  const fluxRight = flux(right);
  return [0, 1, 2].map((i) => 0.5 * (fluxLeft[i] + fluxRight[i]) - 0.5 * speed * (right[i] - left[i])) as Vec3;
}

function sidePressureCorrection(originalDepth: number, reconstructedDepth: number): number {
  return 0.5 * GRAVITY * (originalDepth * originalDepth - reconstructedDepth * reconstructedDepth);
}

/** The conservative core of `void main()`, up to the friction term. */
function stepGlslCell(
  center: GlslCell,
  west: GlslCell,
  east: GlslCell,
  south: GlslCell,
  north: GlslCell,
  dt: number,
  cellSize: number,
): Vec3 {
  const eastPair = hydrostaticPair(center, east);
  const westPair = hydrostaticPair(west, center);
  const northPair = hydrostaticPair(center, north);
  const southPair = hydrostaticPair(south, center);
  const eastFlux = rusanov(center, east, 1);
  const westFlux = rusanov(west, center, 1);
  const northFlux = rusanov(center, north, 2);
  const southFlux = rusanov(south, center, 2);
  eastFlux[1] += sidePressureCorrection(center.depth, eastPair[0][0]);
  westFlux[1] += sidePressureCorrection(center.depth, westPair[1][0]);
  northFlux[2] += sidePressureCorrection(center.depth, northPair[0][0]);
  southFlux[2] += sidePressureCorrection(center.depth, southPair[1][0]);
  const base: Vec3 = [center.depth, center.q[0], center.q[1]];
  const next = base.map((value, i) => value - dt * ((eastFlux[i] - westFlux[i]) + (northFlux[i] - southFlux[i])) / cellSize) as Vec3;
  next[0] = Math.max(next[0], 0);
  if (next[0] <= MIN_DEPTH) {
    next[1] = 0;
    next[2] = 0;
  }
  return next;
}

function toReferenceCell(cell: GlslCell): NearshoreCell {
  return { depth: cell.depth, qx: cell.q[0], qz: cell.q[1], bottom: cell.bottom };
}

function expectClose(actual: NearshoreState, expected: NearshoreState): void {
  actual.forEach((value, index) => {
    const other = expected[index];
    expect(Number.isFinite(value)).toBe(true);
    expect(Math.abs(value - other)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(value), Math.abs(other)));
  });
}

describe("water simulation core vs nearshore-reference", () => {
  it("reads the same GRAVITY and MIN_DEPTH out of the shader text", () => {
    expect(GRAVITY).toBe(NEARSHORE_GRAVITY);
    expect(MIN_DEPTH).toBe(NEARSHORE_MIN_DEPTH);
  });

  it("reproduces the CPU mirror on a deep, moving cell", () => {
    const center = glslCell(3.2, -1.8, 0.42, -0.17);
    const west = glslCell(3.1, -1.9, 0.38, -0.12);
    const east = glslCell(3.35, -1.7, 0.47, -0.22);
    const south = glslCell(3.05, -1.75, 0.31, -0.09);
    const north = glslCell(3.4, -1.85, 0.55, -0.28);
    expectClose(
      stepGlslCell(center, west, east, south, north, 1 / 60, 0.75),
      stepNearshoreCell(
        toReferenceCell(center),
        toReferenceCell(west),
        toReferenceCell(east),
        toReferenceCell(south),
        toReferenceCell(north),
        1 / 60,
        0.75,
      ),
    );
  });

  it("reproduces the CPU mirror across a wet/dry front and on a still pond", () => {
    const cases: ReadonlyArray<readonly GlslCell[]> = [
      // A dry (zero-depth) east neighbour: the well-balanced reconstruction
      // and the MIN_DEPTH gates all have to fire on the same side.
      [glslCell(0.9, 0.5, 0.2, 0.05), glslCell(1.4, 0.0, 0.25, 0.02), glslCell(0, 1.4, 0, 0), glslCell(1.0, 0.4, 0.1, 0.0), glslCell(0.8, 0.6, 0.05, 0.08)],
      // Lake at rest over uneven bathymetry: the flux divergence must vanish.
      [glslCell(2.0, -0.6, 0, 0), glslCell(2.6, -1.2, 0, 0), glslCell(1.4, 0.0, 0, 0), glslCell(3.0, -1.6, 0, 0), glslCell(1.9, -0.5, 0, 0)],
      // Steep momentum gradient at 1/120 s (reference-mode substep).
      [glslCell(5.5, -4.1, -1.9, 2.4), glslCell(5.1, -3.7, -2.4, 2.9), glslCell(6.0, -4.6, -1.2, 1.7), glslCell(5.8, -4.4, -0.6, 3.1), glslCell(5.2, -3.8, -2.8, 1.1)],
    ];
    const steps = [1 / 60, 1 / 60, 1 / 120];
    cases.forEach((cells, index) => {
      const [center, west, east, south, north] = cells;
      expectClose(
        stepGlslCell(center, west, east, south, north, steps[index], 0.75),
        stepNearshoreCell(
          toReferenceCell(center),
          toReferenceCell(west),
          toReferenceCell(east),
          toReferenceCell(south),
          toReferenceCell(north),
          steps[index],
          0.75,
        ),
      );
    });
  });

  it("keeps a lake at rest at rest (well-balanced property)", () => {
    const flat = (bottom: number) => glslCell(WATER_LEVEL - bottom, bottom, 0, 0);
    const next = stepGlslCell(flat(-2.0), flat(-2.4), flat(-1.6), flat(-2.9), flat(-1.1), 1 / 60, 0.75);
    expect(next[0]).toBeCloseTo(WATER_LEVEL + 2.0, 10);
    expect(next[1]).toBeCloseTo(0, 12);
    expect(next[2]).toBeCloseTo(0, 12);
  });
});

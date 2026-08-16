export const NEARSHORE_GRAVITY = 9.81;
export const NEARSHORE_MIN_DEPTH = 0.035;

export type NearshoreCell = Readonly<{
  depth: number;
  qx: number;
  qz: number;
  bottom: number;
}>;

export type NearshoreState = [depth: number, qx: number, qz: number];

function conservativeState(cell: NearshoreCell, reconstructedDepth: number): NearshoreState {
  if (cell.depth <= NEARSHORE_MIN_DEPTH) return [reconstructedDepth, 0, 0];
  const scale = reconstructedDepth / Math.max(cell.depth, NEARSHORE_MIN_DEPTH);
  return [reconstructedDepth, cell.qx * scale, cell.qz * scale];
}

function hydrostaticPair(a: NearshoreCell, b: NearshoreCell): [NearshoreState, NearshoreState] {
  const interfaceBottom = Math.max(a.bottom, b.bottom);
  const surfaceA = a.bottom + a.depth;
  const surfaceB = b.bottom + b.depth;
  return [
    conservativeState(a, Math.max(0, surfaceA - interfaceBottom)),
    conservativeState(b, Math.max(0, surfaceB - interfaceBottom)),
  ];
}

function fluxX(state: NearshoreState): NearshoreState {
  const [depth, qx, qz] = state;
  const safeDepth = Math.max(depth, NEARSHORE_MIN_DEPTH);
  return [qx, qx * qx / safeDepth + 0.5 * NEARSHORE_GRAVITY * depth * depth, qx * qz / safeDepth];
}

function fluxZ(state: NearshoreState): NearshoreState {
  const [depth, qx, qz] = state;
  const safeDepth = Math.max(depth, NEARSHORE_MIN_DEPTH);
  return [qz, qz * qx / safeDepth, qz * qz / safeDepth + 0.5 * NEARSHORE_GRAVITY * depth * depth];
}

function rusanov(a: NearshoreCell, b: NearshoreCell, axis: "x" | "z"): NearshoreState {
  const [left, right] = hydrostaticPair(a, b);
  const momentumIndex = axis === "x" ? 1 : 2;
  const leftVelocity = left[0] <= NEARSHORE_MIN_DEPTH ? 0 : left[momentumIndex] / left[0];
  const rightVelocity = right[0] <= NEARSHORE_MIN_DEPTH ? 0 : right[momentumIndex] / right[0];
  const speed = Math.max(
    Math.abs(leftVelocity) + Math.sqrt(NEARSHORE_GRAVITY * left[0]),
    Math.abs(rightVelocity) + Math.sqrt(NEARSHORE_GRAVITY * right[0]),
  );
  const leftFlux = axis === "x" ? fluxX(left) : fluxZ(left);
  const rightFlux = axis === "x" ? fluxX(right) : fluxZ(right);
  return [0, 1, 2].map((index) =>
    0.5 * (leftFlux[index] + rightFlux[index]) - 0.5 * speed * (right[index] - left[index]),
  ) as NearshoreState;
}

function pressureCorrection(originalDepth: number, reconstructedDepth: number) {
  return 0.5 * NEARSHORE_GRAVITY * (originalDepth * originalDepth - reconstructedDepth * reconstructedDepth);
}

/**
 * CPU mirror of one conservative WGSL cell update. It is intentionally small:
 * tests use it as a numerical contract, while production simulation remains on
 * the GPU. Boundary conditions are supplied by the caller through neighbours.
 */
export function stepNearshoreCell(
  center: NearshoreCell,
  west: NearshoreCell,
  east: NearshoreCell,
  south: NearshoreCell,
  north: NearshoreCell,
  dt: number,
  cellSize: number,
): NearshoreState {
  const eastPair = hydrostaticPair(center, east);
  const westPair = hydrostaticPair(west, center);
  const northPair = hydrostaticPair(center, north);
  const southPair = hydrostaticPair(south, center);
  const eastFlux = rusanov(center, east, "x");
  const westFlux = rusanov(west, center, "x");
  const northFlux = rusanov(center, north, "z");
  const southFlux = rusanov(south, center, "z");
  eastFlux[1] += pressureCorrection(center.depth, eastPair[0][0]);
  westFlux[1] += pressureCorrection(center.depth, westPair[1][0]);
  northFlux[2] += pressureCorrection(center.depth, northPair[0][0]);
  southFlux[2] += pressureCorrection(center.depth, southPair[1][0]);

  const next: NearshoreState = [
    center.depth - dt * (eastFlux[0] - westFlux[0] + northFlux[0] - southFlux[0]) / cellSize,
    center.qx - dt * (eastFlux[1] - westFlux[1] + northFlux[1] - southFlux[1]) / cellSize,
    center.qz - dt * (eastFlux[2] - westFlux[2] + northFlux[2] - southFlux[2]) / cellSize,
  ];
  next[0] = Math.max(0, next[0]);
  if (next[0] <= NEARSHORE_MIN_DEPTH) {
    next[1] = 0;
    next[2] = 0;
  }
  return next;
}

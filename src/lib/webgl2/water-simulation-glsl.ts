// GLSL ES 3.00 port of the `simulate` compute shader — the conservative
// shallow-water / Rusanov nearshore solver
// (`webgpu-water-engine.ts@7dbf39c:348-557`, docs/webgl2-port/spec-compute.md §3.4).
//
// Transcribed statement by statement. Every clamp, `max`, `select` and the
// order of the arithmetic are preserved; nothing is folded or reassociated,
// because the reference is the WebGPU pixel output, not a tidier formula.
//
// Port decisions (docs/webgl2-port/contract.md §3.3, docs/webgl2-port/spec-compute.md §4):
// - `select(f, t, cond)` → `cond ? t : f` (argument order reverses, R10).
//   Sites: loadCell.q, conservativeState.scale, rusanovX u{Left,Right},
//   rusanovY v{South,North}, main nextQ. Six in total.
// - `array<vec3<f32>, 2>` from `hydrostaticPair` → `struct HydrostaticPair`
//   with `left` / `right` members (R14): array returns hit driver bugs.
// - `textureLoad(t, c, 0)` → `texelFetch(t, c, 0)`; every original clamp is
//   kept because out-of-range `texelFetch` is undefined rather than zero (R7).
// - `textureSampleLevel(t, s, uv, 0.0)` → `textureLod(t, uv, 0.0)`; the
//   sampler is supplied by the pass through `bindTextureUnit` (R16).
// - `textureDimensions()` → `uDims` / `uTerrainDims` uniforms (R8). Note the
//   asymmetry the WGSL relies on: `cellSize` divides by `dims.x` (no -1)
//   while `terrainAtWorld` scales by `terrainDims - 1`.
// - `terrainField` is fetched with NEAREST semantics (`round(uv * 512)`), not
//   filtered — deliberately different from the breaker pass (docs/webgl2-port/spec-compute.md §6.6).
//
// Imports resolve to the concrete modules, not the barrel: these constants are
// assembled during module evaluation.

import { SPECTRAL_CASCADES } from "../spectral-ocean";
import { WORLD_UNIFORMS_GLSL } from "./shared-glsl";

const LONG_CHOPPINESS = SPECTRAL_CASCADES[0].choppiness.toFixed(2);
const MEDIUM_CHOPPINESS = SPECTRAL_CASCADES[1].choppiness.toFixed(2);

/**
 * Fragment body for one shallow-water step. Pair it with
 * `FULLSCREEN_TRIANGLE_VERTEX_GLSL` and render into the destination half of
 * the water-state ping-pong.
 *
 * Uniform blocks: `WorldUniforms` (binding 0) and `SimulationParams`
 * (binding 1, 32 bytes: `impulse`, `stepFoamShift`).
 * Samplers: `previousState` (repeat/linear — `texelFetch` x5 for the stencil
 * plus one `textureLod` for the foam backtrace), `terrainField` (no sampler,
 * `texelFetch` only), `longField0/1` and `mediumField0/1` (repeat/linear).
 * Scalar uniforms: `uDims` (simulation resolution), `uTerrainDims` (513).
 * Output: `(clamp(eta, -1.8, 1.8), clamp(q, -12, 12), clamp(foam, 0, 1))`.
 */
export const WATER_SIMULATION_FRAGMENT_GLSL = /* glsl */ `
${WORLD_UNIFORMS_GLSL}
layout(std140) uniform SimulationParams {
  // xy: impulse centre in field uv, z: strength (negative), w: radius in uv.
  vec4 impulse;
  // x: fixed timestep, y: foam birth multiplier, zw: unused.
  vec4 stepFoamShift;
} params;

uniform sampler2D previousState;
uniform sampler2D terrainField;
uniform sampler2D longField0;
uniform sampler2D longField1;
uniform sampler2D mediumField0;
uniform sampler2D mediumField1;
// Replaces textureDimensions(nextState) and textureDimensions(terrainField).
uniform ivec2 uDims;
uniform ivec2 uTerrainDims;

layout(location = 0) out vec4 outState;

const float GRAVITY = 9.81;
const float MIN_DEPTH = 0.035;

struct CellState {
  float eta;
  vec2 q;
  float foam;
  float bottom;
  float depth;
};

// WGSL returned array<vec3<f32>, 2>; a struct is the portable equivalent.
struct HydrostaticPair {
  vec3 left;
  vec3 right;
};

ivec2 clampedCoord(ivec2 coord, ivec2 dimensions) {
  return clamp(coord, ivec2(0), dimensions - ivec2(1));
}

vec2 worldPosition(ivec2 coord, ivec2 dimensions) {
  vec2 uv = (vec2(coord) + vec2(0.5)) / vec2(dimensions);
  return uniforms.simulation.xy + (uv - vec2(0.5)) * uniforms.simulation.z;
}

float terrainAtWorld(vec2 p) {
  vec2 uv = clamp(p / uniforms.terrain.x + vec2(0.5), vec2(0.0), vec2(1.0));
  ivec2 coord = ivec2(round(uv * vec2(uTerrainDims - ivec2(1))));
  return texelFetch(terrainField, coord, 0).r;
}

vec4 spectralBoundaryState(vec2 p, float depth) {
  vec2 longUv = fract(p / uniforms.atmosphere.z + vec2(0.5));
  vec2 mediumUv = fract(p / uniforms.atmosphere.w + vec2(0.5));
  vec4 long0 = textureLod(longField0, longUv, 0.0) * uniforms.waves.x;
  vec4 long1 = textureLod(longField1, longUv, 0.0) * uniforms.waves.x;
  vec4 medium0 = textureLod(mediumField0, mediumUv, 0.0) * uniforms.waves.x;
  vec4 medium1 = textureLod(mediumField1, mediumUv, 0.0) * uniforms.waves.x;
  float longHeight = long0.b;
  float mediumHeight = medium0.b;
  float eta = longHeight + mediumHeight
    + 0.14 * (longHeight * longHeight - 0.080 * uniforms.waves.y)
    + 0.32 * (mediumHeight * mediumHeight - 0.030 * uniforms.waves.y);
  // The boundary transport follows the dominant spectrum direction. Interior
  // momentum immediately becomes bathymetry-aware through the conservative
  // flux. This is a relaxation boundary, not a second rendered wave layer.
  vec2 meanDirection = normalize(vec2(0.887, -0.462));
  vec2 direction = normalize(meanDirection - (long1.rg + medium1.rg) * 0.055);
  float phaseSpeed = sqrt(GRAVITY * max(depth, MIN_DEPTH));
  float crossDerivative = long0.a * ${LONG_CHOPPINESS} + medium0.a * ${MEDIUM_CHOPPINESS};
  vec2 horizontalDerivative = long1.ba * ${LONG_CHOPPINESS} + medium1.ba * ${MEDIUM_CHOPPINESS};
  float jacobian = (1.0 + horizontalDerivative.x) * (1.0 + horizontalDerivative.y) - crossDerivative * crossDerivative;
  return vec4(eta, direction * eta * phaseSpeed, max(0.0, 1.0 - jacobian));
}

CellState loadCell(ivec2 coordIn, ivec2 dimensions) {
  ivec2 coord = clampedCoord(coordIn, dimensions);
  vec4 raw = texelFetch(previousState, coord, 0);
  float bottom = terrainAtWorld(worldPosition(coord, dimensions));
  float depth = max(uniforms.sunWater.w + raw.r - bottom, 0.0);
  CellState result;
  result.eta = raw.r;
  result.q = depth <= MIN_DEPTH ? vec2(0.0) : raw.gb;
  result.foam = raw.a;
  result.bottom = bottom;
  result.depth = depth;
  return result;
}

vec3 conservativeState(CellState cell, float reconstructedDepth) {
  float scale = cell.depth <= MIN_DEPTH ? 0.0 : reconstructedDepth / max(cell.depth, MIN_DEPTH);
  return vec3(reconstructedDepth, cell.q * scale);
}

vec3 physicalFluxX(vec3 state) {
  float h = max(state.x, MIN_DEPTH);
  vec2 velocity = state.yz / h;
  return vec3(state.y, state.y * velocity.x + 0.5 * GRAVITY * state.x * state.x, state.y * velocity.y);
}

vec3 physicalFluxY(vec3 state) {
  float h = max(state.x, MIN_DEPTH);
  vec2 velocity = state.yz / h;
  return vec3(state.z, state.z * velocity.x, state.z * velocity.y + 0.5 * GRAVITY * state.x * state.x);
}

HydrostaticPair hydrostaticPair(CellState a, CellState b) {
  float interfaceBottom = max(a.bottom, b.bottom);
  float surfaceA = uniforms.sunWater.w + a.eta;
  float surfaceB = uniforms.sunWater.w + b.eta;
  float hA = max(0.0, surfaceA - interfaceBottom);
  float hB = max(0.0, surfaceB - interfaceBottom);
  return HydrostaticPair(conservativeState(a, hA), conservativeState(b, hB));
}

vec3 rusanovX(CellState a, CellState b) {
  HydrostaticPair pair = hydrostaticPair(a, b);
  vec3 left = pair.left;
  vec3 right = pair.right;
  float uLeft = left.x <= MIN_DEPTH ? 0.0 : left.y / max(left.x, MIN_DEPTH);
  float uRight = right.x <= MIN_DEPTH ? 0.0 : right.y / max(right.x, MIN_DEPTH);
  float speed = max(abs(uLeft) + sqrt(GRAVITY * left.x), abs(uRight) + sqrt(GRAVITY * right.x));
  return 0.5 * (physicalFluxX(left) + physicalFluxX(right)) - 0.5 * speed * (right - left);
}

vec3 rusanovY(CellState a, CellState b) {
  HydrostaticPair pair = hydrostaticPair(a, b);
  vec3 south = pair.left;
  vec3 north = pair.right;
  float vSouth = south.x <= MIN_DEPTH ? 0.0 : south.z / max(south.x, MIN_DEPTH);
  float vNorth = north.x <= MIN_DEPTH ? 0.0 : north.z / max(north.x, MIN_DEPTH);
  float speed = max(abs(vSouth) + sqrt(GRAVITY * south.x), abs(vNorth) + sqrt(GRAVITY * north.x));
  return 0.5 * (physicalFluxY(south) + physicalFluxY(north)) - 0.5 * speed * (north - south);
}

float sidePressureCorrection(float originalDepth, float reconstructedDepth) {
  return 0.5 * GRAVITY * (originalDepth * originalDepth - reconstructedDepth * reconstructedDepth);
}

void main() {
  ivec2 dimensions = uDims;
  ivec2 id = ivec2(gl_FragCoord.xy);
  if (id.x >= dimensions.x || id.y >= dimensions.y) { discard; }
  ivec2 coord = id;
  CellState center = loadCell(coord, dimensions);
  CellState west = loadCell(coord - ivec2(1, 0), dimensions);
  CellState east = loadCell(coord + ivec2(1, 0), dimensions);
  CellState south = loadCell(coord - ivec2(0, 1), dimensions);
  CellState north = loadCell(coord + ivec2(0, 1), dimensions);
  float cellSize = uniforms.simulation.z / float(dimensions.x);
  float dt = params.stepFoamShift.x;

  HydrostaticPair eastPair = hydrostaticPair(center, east);
  HydrostaticPair westPair = hydrostaticPair(west, center);
  HydrostaticPair northPair = hydrostaticPair(center, north);
  HydrostaticPair southPair = hydrostaticPair(south, center);
  vec3 eastFlux = rusanovX(center, east);
  vec3 westFlux = rusanovX(west, center);
  vec3 northFlux = rusanovY(center, north);
  vec3 southFlux = rusanovY(south, center);
  eastFlux.y += sidePressureCorrection(center.depth, eastPair.left.x);
  westFlux.y += sidePressureCorrection(center.depth, westPair.right.x);
  northFlux.z += sidePressureCorrection(center.depth, northPair.left.x);
  southFlux.z += sidePressureCorrection(center.depth, southPair.right.x);

  vec3 next = vec3(center.depth, center.q) - dt * ((eastFlux - westFlux) + (northFlux - southFlux)) / cellSize;
  next.x = max(next.x, 0.0);
  float nextDepth = next.x;
  vec2 nextQ = nextDepth <= MIN_DEPTH ? vec2(0.0) : next.yz;
  float speed = length(nextQ) / max(nextDepth, MIN_DEPTH);
  float manning = 0.018;
  float friction = GRAVITY * manning * manning * speed / max(pow(max(nextDepth, MIN_DEPTH), 1.333333), 0.001);
  nextQ /= 1.0 + dt * friction;

  vec2 uv = (vec2(id) + vec2(0.5)) / vec2(dimensions);
  float radius = max(params.impulse.w, 0.0001);
  float impulseDistance = length((uv - params.impulse.xy) / radius);
  float impulse = exp(-impulseDistance * impulseDistance * 3.2);
  float ringOffset = impulseDistance - 0.72;
  float ring = exp(-(ringOffset * ringOffset) * 18.0);
  nextDepth = max(0.0, nextDepth + (impulse - ring * 0.28) * params.impulse.z);
  vec2 impulseDirection = normalize(vec2(uniforms.player.z, uniforms.player.w) + vec2(0.0001, 0.0));
  nextQ += impulseDirection * ring * params.impulse.z * 1.6;

  // Couple the far-field FFT to the nonlinear domain. A strong sponge forces
  // the outer band to the incident sea state, while deeper interior cells get
  // a much weaker source during warm-up. Shallow cells are then owned by the
  // conservative solver, allowing bathymetric refraction and run-up.
  float edgeDistance = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  float sponge = 1.0 - smoothstep(0.0, 0.085, edgeDistance);
  float stillDepth = max(uniforms.sunWater.w - center.bottom, 0.0);
  vec4 boundary = spectralBoundaryState(worldPosition(coord, dimensions), stillDepth);
  float deepWarmup = smoothstep(4.8, 9.5, stillDepth) * (1.0 - sponge) * 0.42;
  float coupling = min(1.0, dt * (12.0 * sponge + 2.4 * deepWarmup));
  nextDepth = mix(nextDepth, max(stillDepth + boundary.x, 0.0), coupling);
  // Linear shallow-water transport is q = c * eta. Multiplying by depth a
  // second time over-forces the wet/dry front and produces a vertical wall.
  nextQ = mix(nextQ, boundary.yz, coupling);

  vec2 velocity = nextQ / max(nextDepth, MIN_DEPTH);
  vec2 backtraceUv = clamp(uv - velocity * dt / uniforms.simulation.z, vec2(0.002), vec2(0.998));
  float backtracedFoam = textureLod(previousState, backtraceUv, 0.0).a;
  float neighbourFoam = (west.foam + east.foam + south.foam + north.foam) * 0.25;
  float foam = mix(backtracedFoam, neighbourFoam, min(0.11, dt * 1.4));
  float froude = speed / max(sqrt(GRAVITY * nextDepth), 0.001);
  float surfaceCompression = max(0.0, -(east.q.x - west.q.x + north.q.y - south.q.y) / (2.0 * cellSize));
  float breakingBirth = smoothstep(0.58, 0.92, froude) * smoothstep(0.03, 0.32, surfaceCompression);
  float shorelineBirth = (1.0 - smoothstep(0.16, 1.7, nextDepth)) * smoothstep(0.03, 0.24, speed);
  float spectralBirth = smoothstep(0.115, 0.31, boundary.w) * smoothstep(0.27, 0.76, boundary.x);
  float shorelineWaveBirth = (1.0 - smoothstep(0.10, 1.55, nextDepth)) * smoothstep(0.18, 0.64, boundary.x);
  foam *= exp(-dt * 0.58);
  foam += dt * (spectralBirth * 0.48 + breakingBirth * 2.4 + shorelineBirth * 0.52 + shorelineWaveBirth * 1.25) * params.stepFoamShift.y;
  foam = max(foam, ring * abs(params.impulse.z) * 4.0 * params.stepFoamShift.y);

  float eta = nextDepth + center.bottom - uniforms.sunWater.w;
  outState = vec4(clamp(eta, -1.8, 1.8), clamp(nextQ, vec2(-12.0), vec2(12.0)), clamp(foam, 0.0, 1.0));
}
`;

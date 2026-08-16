// GLSL ES 3.00 port of the `updateBreakerEvents` compute shader
// (`webgpu-water-engine.ts@7dbf39c:559-632`, docs/webgl2-port/spec-compute.md §3.5).
//
// The WGSL dispatched a 1D grid over a 256x1 storage texture. Here the pass
// renders the same full-screen triangle into a 256x1 FBO with the viewport set
// to match (docs/webgl2-port/spec-compute.md R2), so `id.x` is `int(gl_FragCoord.x)` — the texel
// centre sits at +0.5, and truncating recovers the index exactly.
//
// Sampling differs from the simulation pass on purpose: `terrainField` and
// `waterState` are read through the clamp/linear `fieldSampler` here, while the
// simulation reads terrain with NEAREST `texelFetch` (docs/webgl2-port/spec-compute.md §6.6). The two
// must not be unified.
//
// `blend = 1 - exp(-rate / 60.0)` keeps the hard-coded 60 Hz of the original:
// it is not the timestep, and substituting `dt` would change the attack and
// release rates of the breaking state.

import { BREAKER_EVENT_RESOLUTION } from "../water-constants";
import { SPECTRAL_CASCADES } from "../spectral-ocean";
import { WORLD_UNIFORMS_GLSL } from "./shared-glsl";

const LONG_CHOPPINESS = SPECTRAL_CASCADES[0].choppiness.toFixed(2);
const MEDIUM_CHOPPINESS = SPECTRAL_CASCADES[1].choppiness.toFixed(2);

/**
 * Fragment body for the 256x1 breaker-event history. Pair it with
 * `FULLSCREEN_TRIANGLE_VERTEX_GLSL`.
 *
 * Uniform block: `WorldUniforms` (binding 0).
 * Samplers: `previousEvents` (no sampler — `texelFetch` x3 with an explicit
 * 0..255 clamp), `terrainField` and `waterState` (clamp/linear `fieldSampler`),
 * `longField0/1` and `mediumField0/1` (repeat/linear `spectrumSampler`).
 * Output: `(activation, spectralInstability, nearshoreInstability, compression)`.
 */
export const BREAKER_EVENT_FRAGMENT_GLSL = /* glsl */ `
${WORLD_UNIFORMS_GLSL}
uniform sampler2D previousEvents;
uniform sampler2D terrainField;
uniform sampler2D waterState;
uniform sampler2D longField0;
uniform sampler2D longField1;
uniform sampler2D mediumField0;
uniform sampler2D mediumField1;

layout(location = 0) out vec4 outEvent;

float frontPosition(float time) {
  float travellingPhase = time * 2.4 + 12.0;
  return travellingPhase - floor(travellingPhase / 72.0) * 72.0 - 36.0;
}

float eventHistory(int coord) {
  return texelFetch(previousEvents, ivec2(clamp(coord, 0, ${BREAKER_EVENT_RESOLUTION - 1}), 0), 0).r;
}

void main() {
  int id = int(gl_FragCoord.x);
  if (id >= ${BREAKER_EVENT_RESOLUTION}) { discard; }
  float uv = (float(id) + 0.5) / ${BREAKER_EVENT_RESOLUTION}.0;
  float along = mix(-180.0, 180.0, uv);
  vec2 travelDirection = normalize(vec2(0.887, -0.462));
  vec2 tangentDirection = vec2(-travelDirection.y, travelDirection.x);
  float time = uniforms.cameraTime.w;
  float meander = sin(along * 0.055 + time * 0.055 + 0.7) * 3.8
    + sin(along * 0.14 - time * 0.032 - 1.3) * 1.2;
  vec2 p = tangentDirection * along + travelDirection * (frontPosition(time) + meander);

  vec2 terrainUv = clamp(p / uniforms.terrain.x + vec2(0.5), vec2(0.0), vec2(1.0));
  float bottom = textureLod(terrainField, terrainUv, 0.0).r;
  float stillDepth = max(uniforms.sunWater.w - bottom, 0.0);
  vec2 simulationUv = (p - uniforms.simulation.xy) / uniforms.simulation.z + vec2(0.5);
  float simulationInside = step(0.0, simulationUv.x) * step(0.0, simulationUv.y) * step(simulationUv.x, 1.0) * step(simulationUv.y, 1.0);
  vec4 state = textureLod(waterState, clamp(simulationUv, vec2(0.0), vec2(1.0)), 0.0) * simulationInside;
  float dynamicDepth = max(stillDepth + state.r, 0.035);
  float speed = length(state.gb) / dynamicDepth;
  float froude = speed / max(sqrt(9.81 * dynamicDepth), 0.001);

  vec2 longUv = fract(p / uniforms.atmosphere.z + vec2(0.5));
  vec2 mediumUv = fract(p / uniforms.atmosphere.w + vec2(0.5));
  vec4 long0 = textureLod(longField0, longUv, 0.0) * uniforms.waves.x;
  vec4 long1 = textureLod(longField1, longUv, 0.0) * uniforms.waves.x;
  vec4 medium0 = textureLod(mediumField0, mediumUv, 0.0) * uniforms.waves.x;
  vec4 medium1 = textureLod(mediumField1, mediumUv, 0.0) * uniforms.waves.x;
  float crossDerivative = long0.a * ${LONG_CHOPPINESS} + medium0.a * ${MEDIUM_CHOPPINESS};
  vec2 horizontalDerivative = long1.ba * ${LONG_CHOPPINESS} + medium1.ba * ${MEDIUM_CHOPPINESS};
  float jacobian = (1.0 + horizontalDerivative.x) * (1.0 + horizontalDerivative.y) - crossDerivative * crossDerivative;
  float compression = max(0.0, 1.0 - jacobian);
  float slope = length(long1.rg + medium1.rg);
  float spectralInstability = smoothstep(0.035, 0.160, compression)
    * mix(0.34, 1.0, smoothstep(0.045, 0.205, slope));
  float depthRatio = abs(state.r) / max(dynamicDepth, 0.12);
  float nearshoreInstability = (1.0 - smoothstep(2.2, 6.0, dynamicDepth))
    * max(smoothstep(0.46, 0.86, froude), smoothstep(0.38, 0.76, depthRatio));
  float targetInstability = clamp(max(spectralInstability, nearshoreInstability), 0.0, 1.0);

  // Lateral history diffusion gives contiguous breaking segments. Fast attack
  // and slow release implement the persistent breaking state used by practical
  // nearshore solvers instead of flickering on a single threshold crossing.
  float center = eventHistory(id);
  float history = center * 0.50 + eventHistory(id - 1) * 0.25 + eventHistory(id + 1) * 0.25;
  float rate = targetInstability > history ? 7.5 : 0.62;
  float blend = 1.0 - exp(-rate / 60.0);
  float activation = mix(history, targetInstability, blend);
  outEvent = vec4(activation, spectralInstability, nearshoreInstability, compression);
}
`;

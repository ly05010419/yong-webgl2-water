// GLSL ES 3.00 port of the WGSL terrain (seabed / beach) pass.
//
// Frozen source: `webgpu-water-engine.ts@7dbf39c:760-884`
// (`TERRAIN_RENDER_SHADER`, entry points `terrainVertex` / `terrainFragment`),
// described in docs/webgl2-port/spec-engine.md §3.2 and §4.2.
//
// Both constants are shader *bodies*: `createGlProgram` prepends `#version 300
// es` and the highp precision preamble (docs/webgl2-port/contract.md §2.2). Every literal
// and every operation keeps the original order, including the two template
// interpolations the WGSL performs on the cascade presets — they are re-read
// from `SPECTRAL_CASCADES` here so the emitted text stays byte-identical.
//
// Translation notes (docs/webgl2-port/contract.md §3.3):
// - `@builtin(vertex_index) vertexId: u32` becomes `uint(gl_VertexID)`; the
//   cell/corner arithmetic stays unsigned exactly as in WGSL.
// - `textureSampleLevel(t, fieldSampler, uv, 0.0)` becomes `textureLod(t, uv,
//   0.0)` (mandatory in the vertex stage) and `textureSample(t, s, uv)` becomes
//   `texture(t, uv)`. Wrap/filter now live on the injected sampler objects, so
//   the sampler names disappear from the call while the *texture* names stay
//   identical to the WGSL bindings (docs/webgl2-port/contract.md §3.2).
// - The WGSL local `sample` is renamed `heightSample`: `sample` is a reserved
//   word in GLSL ES 3.00.
// - `select(0.0, 1.0, underwater)` (WGSL 880) becomes `underwater ? 1.0 : 0.0`.
// - The shared prelude is the WGSL's `WORLD_UNIFORMS + TETHYS_TERRAIN_WGSL +
//   COLOR_FUNCTIONS + TETHYS_AERIAL_WGSL`. `WORLD_SHADING_GLSL` already bundles
//   uniforms + colour + sky + aerial; `TERRAIN_HEIGHT_GLSL` (which only
//   contributes `valueNoise` here) has no dependency on any of them, so
//   appending it is equivalent to the WGSL's ordering.

import { SPECTRAL_CASCADES } from "../spectral-ocean";
import { TERRAIN_HEIGHT_GLSL, WORLD_SHADING_GLSL } from "./shared-glsl";

/** Vertices per grid cell: two triangles from the shared 6-corner table. */
export const TERRAIN_VERTICES_PER_CELL = 6;

/**
 * `terrainVertex` (WGSL 776-796). The mesh is fully procedural: `environment.y`
 * carries the live grid resolution (512 in the shore scene), cell `n` owns
 * vertices `6n..6n+5`, and the height comes from the R channel of the 513²
 * terrain field. `terrain.x` is TERRAIN_EXTENT (520 m).
 *
 * The draw count must be `resolution² * 6` for the same `resolution` the engine
 * wrote into `environment.y` — `createTerrainPass().draw()` takes it as input.
 */
export const TERRAIN_VERTEX_GLSL = /* glsl */ `
${WORLD_SHADING_GLSL}
uniform sampler2D terrainField;

out vec3 vWorld;
out vec2 vFieldUv;

// Two triangles per cell. Hoisted out of main() and marked const: the table is
// a compile-time constant, so this states that instead of re-declaring a local
// array on every invocation. Same six values, same order.
const uvec2 corners[6] = uvec2[6](
  uvec2(0u, 0u), uvec2(0u, 1u), uvec2(1u, 0u),
  uvec2(0u, 1u), uvec2(1u, 1u), uvec2(1u, 0u)
);

void main() {
  uint vertexId = uint(gl_VertexID);
  uint resolution = uint(uniforms.environment.y);
  uint cellId = vertexId / 6u;
  uvec2 cell = uvec2(cellId % resolution, cellId / resolution);
  uvec2 grid = cell + corners[int(vertexId % 6u)];
  vec2 uv = vec2(grid) / float(resolution);
  vec4 heightSample = textureLod(terrainField, uv, 0.0);
  vec3 world = vec3((uv.x - 0.5) * uniforms.terrain.x, heightSample.r, (uv.y - 0.5) * uniforms.terrain.x);
  gl_Position = uniforms.viewProj * vec4(world, 1.0);
  vWorld = world;
  vFieldUv = uv;
}
`;

/**
 * `terrainFragment` (WGSL 798-883): normal reconstruction from the field's GB
 * slope channels, six `valueNoise` layers of sand / rock / sediment, the
 * near-shore solver coupling that moves the local waterline, the wet / dry /
 * polished sand palettes, the refracted-sun caustic built from the medium and
 * short cascade Jacobians, and finally the shared aerial perspective.
 */
export const TERRAIN_FRAGMENT_GLSL = /* glsl */ `
${WORLD_SHADING_GLSL}
${TERRAIN_HEIGHT_GLSL}
uniform sampler2D terrainField;
uniform sampler2D mediumField0;
uniform sampler2D mediumField1;
uniform sampler2D shortField0;
uniform sampler2D shortField1;
uniform sampler2D waterState;

in vec3 vWorld;
in vec2 vFieldUv;
layout(location = 0) out vec4 outColor;

void main() {
  vec4 field = texture(terrainField, vFieldUv);
  float normalY = sqrt(max(1.0 - field.g * field.g - field.b * field.b, 0.0001));
  vec3 N = normalize(vec3(field.g, normalY, field.b));
  vec3 L = normalize(uniforms.sunWater.xyz);
  float diffuse = clamp(dot(N, L) * 0.56 + 0.48, 0.0, 1.0);
  vec2 p = vWorld.xz;
  float broad = valueNoise(p * 0.075 - vec2(8.1, -2.4));
  float grain = valueNoise(p * 0.38 + vec2(4.7, -9.2));
  float geology = valueNoise(p * 0.021 + vec2(13.2, -6.7));
  float erosion = valueNoise(vec2(p.x * 0.055 + p.y * 0.018, p.y * 0.19 - p.x * 0.025));
  float sedimentMacro = valueNoise(p * 0.018 + vec2(-11.4, 6.8));
  float sedimentMeso = valueNoise(vec2(p.x * 0.092 + p.y * 0.027, p.y * 0.105 - p.x * 0.021) + vec2(3.9, -7.1));
  vec2 simulationUv = (p - uniforms.simulation.xy) / uniforms.simulation.z + vec2(0.5);
  float inSimulation = step(0.0, simulationUv.x) * step(simulationUv.x, 1.0)
    * step(0.0, simulationUv.y) * step(simulationUv.y, 1.0);
  vec4 shoreState = texture(waterState, clamp(simulationUv, vec2(0.0), vec2(1.0)));
  float localWaterLevel = uniforms.sunWater.w
    + clamp(shoreState.r, -0.16, 0.18) * inSimulation * uniforms.environment.x;
  vec3 sandSource = mix(vec3(0.22, 0.185, 0.115), vec3(0.43, 0.345, 0.19), sedimentMacro)
    * (0.88 + broad * 0.15 + grain * 0.045 + (sedimentMeso - 0.5) * 0.18);
  float granularVariation = (broad - 0.5) * 0.07 + (grain - 0.5) * 0.025;
  vec3 color = mix(sandSource * vec3(0.74, 0.84, 0.72), vec3(0.045, 0.17, 0.145), 0.10)
    * mix(0.68, 1.08, diffuse) * (1.0 + granularVariation);
  float depth = max(0.0, localWaterLevel - vWorld.y);
  float exposed = smoothstep(localWaterLevel + 0.18, localWaterLevel + 0.64, vWorld.y) * uniforms.environment.x;
  vec3 sandBase = mix(vec3(0.235, 0.135, 0.050), vec3(0.48, 0.315, 0.115), broad);
  vec3 rockBase = mix(vec3(0.22, 0.175, 0.125), vec3(0.39, 0.285, 0.175), geology);
  float rockMask = smoothstep(0.18, 0.58, 1.0 - N.y) * 0.72 + smoothstep(0.68, 0.90, erosion) * 0.24;
  float ripplePhase = p.x * 0.21 + p.y * 0.065 + valueNoise(p * 0.030 + vec2(2.7, -5.4)) * 5.2;
  float sandRipple = sin(ripplePhase) * 0.5 + 0.5;
  float duneMacro = valueNoise(p * 0.026 + vec2(-3.4, 7.1));
  float duneMeso = valueNoise(vec2(p.x * 0.063 + p.y * 0.017, p.y * 0.071 - p.x * 0.012) + vec2(6.2, -1.8));
  float duneTone = (duneMacro - 0.5) * 0.31
    + (duneMeso - 0.5) * 0.15
    + (sandRipple - 0.5) * 0.045;
  float sunwardCrest = clamp(dot(N.xz, normalize(vec2(-0.52, -0.80))) * 0.5 + 0.5, 0.0, 1.0);
  float windPolish = smoothstep(0.64, 0.90, N.y) * smoothstep(0.48, 0.76, duneMeso);
  vec3 sandPalette = mix(sandBase * vec3(0.84, 0.89, 0.82), sandBase * vec3(1.13, 1.07, 0.91), duneMacro);
  float elevationTone = smoothstep(localWaterLevel + 0.30, localWaterLevel + 4.8, vWorld.y);
  vec3 elevationSand = mix(vec3(0.255, 0.145, 0.052), vec3(0.53, 0.35, 0.135), elevationTone);
  vec3 drySand = mix(sandBase, rockBase, clamp(rockMask, 0.0, 0.82))
    * mix(0.72, 1.03, diffuse)
    * (0.84 + broad * 0.15 + grain * 0.047 + (erosion - 0.5) * 0.065 + duneTone);
  vec3 polishedSand = mix(sandPalette, elevationSand, 0.42) * mix(0.82, 1.04, diffuse);
  vec3 drySandLayered = mix(drySand, polishedSand, 0.28 + windPolish * 0.24)
    * mix(0.83, 1.07, sunwardCrest);
  float coast = smoothstep(localWaterLevel - 0.30, localWaterLevel + 0.34, vWorld.y) * uniforms.environment.x;
  float solverWash = inSimulation * uniforms.environment.x
    * smoothstep(0.018, 0.22, shoreState.a)
    * (1.0 - smoothstep(0.05, 0.62, abs(vWorld.y - localWaterLevel)));
  vec3 wetSand = mix(vec3(0.18, 0.135, 0.088), vec3(0.255, 0.185, 0.105), broad)
    * mix(0.74, 0.98, diffuse) * (0.91 + grain * 0.055 + sandRipple * 0.025);
  color = mix(color, wetSand, coast);
  color = mix(color, wetSand * vec3(0.82, 0.88, 0.84), solverWash * 0.12);
  color = mix(color, drySandLayered, exposed);
  // Project the seabed point toward the refracted sun ray before sampling the
  // actual animated surface derivatives. This keeps the caustic tied to the
  // spectral water instead of painting a cellular texture onto the sand.
  vec2 refractedSunOffset = L.xz / max(L.y, 0.12) * depth * 0.18;
  vec2 surfaceP = p - refractedSunOffset;
  vec2 mediumUv = fract(surfaceP / uniforms.atmosphere.w + vec2(0.5));
  vec2 shortUv = fract(surfaceP / ${SPECTRAL_CASCADES[2].lengthScale.toFixed(1)} + vec2(0.5));
  vec4 medium0 = texture(mediumField0, mediumUv) * uniforms.waves.x;
  vec4 medium1 = texture(mediumField1, mediumUv) * uniforms.waves.x;
  vec4 short0 = texture(shortField0, shortUv);
  vec4 short1 = texture(shortField1, shortUv);
  float mediumCross = medium0.a * ${SPECTRAL_CASCADES[1].choppiness.toFixed(2)};
  vec2 mediumDerivative = medium1.ba * ${SPECTRAL_CASCADES[1].choppiness.toFixed(2)};
  float shortCross = short0.a * ${SPECTRAL_CASCADES[2].choppiness.toFixed(2)};
  vec2 shortDerivative = short1.ba * ${SPECTRAL_CASCADES[2].choppiness.toFixed(2)};
  float mediumJacobian = (1.0 + mediumDerivative.x) * (1.0 + mediumDerivative.y) - mediumCross * mediumCross;
  float shortJacobian = (1.0 + shortDerivative.x) * (1.0 + shortDerivative.y) - shortCross * shortCross;
  float surfaceFocus = max(0.0, 1.0 - mediumJacobian) * 0.48 + max(0.0, 1.0 - shortJacobian) * 0.52;
  float focusedLight = pow(smoothstep(0.060, 0.27, surfaceFocus), 2.0)
    * smoothstep(0.6, 2.2, depth) * (1.0 - smoothstep(11.0, 20.0, depth));
  color *= 0.94 + focusedLight * 0.14 * (1.0 - exposed);
  color += vec3(0.095, 0.105, 0.045) * focusedLight * 0.060 * (1.0 - exposed);
  // WGSL 878 computes this too and never reads it; kept so the port stays a
  // line-for-line transcription of the frozen shader.
  float distanceToEye = distance(uniforms.cameraTime.xyz, vWorld);
  bool underwater = uniforms.terrain.w > 0.5;
  float dryLand = exposed * (1.0 - (underwater ? 1.0 : 0.0));
  color = tethysAerialColor(color, vWorld, uniforms.cameraTime.xyz, uniforms.environment.w, underwater, dryLand);
  outColor = vec4(linearToSrgb(aces(color)), 1.0);
}
`;

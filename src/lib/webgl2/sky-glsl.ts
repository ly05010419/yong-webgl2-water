// GLSL ES 3.00 port of the WGSL sky pass.
//
// Frozen source: `webgpu-water-engine.ts@7dbf39c:727-752`
// (`SKY_SHADER`, entry points `skyVertex` / `skyFragment`), described in
// docs/webgl2-port/spec-engine.md §3.1 and §4.1.
//
// Both constants are shader *bodies*: no `#version`, no precision statement —
// `createGlProgram` prepends those (docs/webgl2-port/contract.md §2.2). Every literal and
// every operation is transcribed in the original order; a diff against the WGSL
// should show syntax only, never numbers.
//
// Translation notes (docs/webgl2-port/contract.md §3.3 / §3.4):
// - `@builtin(vertex_index) id: u32` becomes `gl_VertexID` (an `int`), which
//   indexes the same three-corner table.
// - The WGSL writes clip z = 0.999999 into WebGPU's [0, 1] clip space. WebGL2
//   clips against [-1, 1], so the identical *window* depth 0.999999 needs
//   `2 * 0.999999 - 1 = 0.999998` here. `depthRange` stays at its default.
// - `@location(0) ndc` becomes the `vNdc` varying pair.
// - The shared prelude covers `linearToSrgb`, `aces` and `skyColor`; the WGSL
//   pastes `WORLD_UNIFORMS + COLOR_FUNCTIONS` (shared-wgsl.ts:6-90), which is
//   exactly `WORLD_SHADING_GLSL` minus the (unused, dead-stripped) aerial
//   function.

import { WORLD_SHADING_GLSL } from "./shared-glsl";

/** Vertices in the sky draw: one full-screen triangle (engine 2401 `draw(3)`). */
export const SKY_VERTEX_COUNT = 3;

/**
 * Window-space depth the sky writes, in GL clip space. WebGPU used 0.999999 in
 * a [0, 1] clip volume; `2 * 0.999999 - 1` reproduces it under [-1, 1].
 */
export const SKY_CLIP_Z = "0.999998";

/**
 * `skyVertex` (WGSL 733-739). Ids 0/1/2 generate NDC (-1,-1), (3,-1), (-1,3);
 * the raw corner is forwarded as `vNdc` so the fragment stage can rebuild the
 * view ray. No vertex buffer and no attributes — a non-default VAO must be
 * bound (docs/webgl2-port/contract.md §2.5).
 */
export const SKY_VERTEX_GLSL = /* glsl */ `
out vec2 vNdc;

void main() {
  vec2 positions[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  vec2 position = positions[gl_VertexID];
  gl_Position = vec4(position, ${SKY_CLIP_Z}, 1.0);
  vNdc = position;
}
`;

/**
 * `skyFragment` (WGSL 741-751): rebuild the camera ray from the two half-extent
 * scales packed into `cameraRight.w` / `cameraUp.w`, shade it with the shared
 * `skyColor`, and replace the result with the underwater volume when
 * `terrain.w > 0.5`. Output is `linearToSrgb(aces(color))` written to a
 * non-sRGB RGBA8 target (docs/webgl2-port/spec-engine.md §8.2.9).
 */
export const SKY_FRAGMENT_GLSL = /* glsl */ `
${WORLD_SHADING_GLSL}
in vec2 vNdc;
layout(location = 0) out vec4 outColor;

void main() {
  vec3 ray = normalize(uniforms.cameraForward.xyz + vNdc.x * uniforms.cameraRight.xyz * uniforms.cameraRight.w + vNdc.y * uniforms.cameraUp.xyz * uniforms.cameraUp.w);
  vec3 color = skyColor(ray, uniforms.cameraTime.w, normalize(uniforms.sunWater.xyz));
  if (uniforms.terrain.w > 0.5) {
    float upward = smoothstep(-0.42, 0.72, ray.y);
    vec3 volume = mix(vec3(0.012, 0.155, 0.158), vec3(0.050, 0.385, 0.335), upward);
    float lightColumn = pow(max(dot(ray, normalize(uniforms.sunWater.xyz)), 0.0), 14.0) * upward;
    color = volume + vec3(0.18, 0.30, 0.23) * lightColumn * 0.22;
  }
  outColor = vec4(linearToSrgb(aces(color)), 1.0);
}
`;

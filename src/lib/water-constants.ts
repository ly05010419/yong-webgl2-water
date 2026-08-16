// World, camera and tuning constants of the water engine. Nothing here touches
// a GPU API: the values are consumed by the CPU-side frame logic and are also
// interpolated into shader source templates, so they must stay bit-identical
// with the renderer they were ported from.

// Baseline world extent, and the reference the fog/far-plane scale divides by.
// 520 m across a 512-tap terrain field is 1.02 m per texel -- widened from the
// authored 390 m so the southern island (shelf centre at z = -196) fits inside
// with margin. Land must never reach the border row: everything beyond the
// field is border-clamped, so an island touching the edge casts a dry-land
// shadow to infinity through the clamp, discarding the water above it.
export const TERRAIN_EXTENT = 520;
// The open ocean sees 10x further. This scales fog reach, the far plane and the
// water's mesh coverage -- deliberately NOT the terrain field, which stays at
// 390 m across 512 taps (0.76 m/texel). Stretching the field to match would
// have dropped it to 7.6 m/texel and flattened the seabed dunes that the
// underwater camera looks straight at. Past the authored centre the field
// clamps to its flat -8.5 m border, and water absorption hides the seabed long
// before that, so the water can extend far beyond the terrain for free.
export const OPEN_WATER_VIEW_SCALE = 100;
// Orbit ceiling. Both scenes currently share this one value: the island scene
// once kept the authored 145 m, but its camera is pinned to 96 m anyway, so no
// code branches on the scene any more. The open ocean's old 250 m ceiling
// guarded against "bare seabed emerging past ~300 m of orbit" -- that was the
// breaker-warp tanh overflowing to NaN and dropping the downwind water wedge,
// fixed at the clamp in adaptiveBreakerCoordinates. With the surface intact
// the ceiling only needs to stay inside the clipmap's 16384 m reach so water
// still surrounds the camera; 12 km also keeps f32 world coordinates well
// clear of visible spectral-UV jitter.
export const OPEN_WATER_MAX_ORBIT = 12000;
// Swell amplitude multiplier. The floor is not zero: a dead-flat surface has no
// slope for the BRDF to work with and the ocean turns into a mirror.
export const MIN_WAVE_SCALE = 0.15;
export const MAX_WAVE_SCALE = 1.6;
// How much of the faded capillary slope is returned to BRDF roughness.
// 0 reproduces the original look, where the far surface tends toward a mirror.
export const MAX_DISTANT_ROUGHNESS = 3;
// Multiplier on the 42-118 m capillary fade and the 95-188 m crest fade.
export const MIN_DETAIL_RANGE = 0.4;
export const MAX_DETAIL_RANGE = 8;
// Strength of the swell cascades' screen-space slope fade. 1 reproduces the
// tuned look, 0 keeps full per-fragment slope to the horizon (glittery).
export const MAX_SWELL_SMOOTHING = 3;
// Where the open ocean's radial fog closes, relative to its authored position.
// 0 removes it entirely, which is the default.
export const MAX_FOG_REACH = 3;

export const TERRAIN_FIELD_RESOLUTION = 512;
export const FRAME_HISTORY = 360;
export const WORLD_UNIFORM_BYTES = 256;
export const SIMULATION_PARAM_BYTES = 32;
export const BREAKER_PATCH_ALONG_RESOLUTION = 256;
export const BREAKER_PATCH_ACROSS_RESOLUTION = 48;
export const BREAKER_EVENT_RESOLUTION = 256;
export const BREAKER_PATCH_TRIANGLES = BREAKER_PATCH_ALONG_RESOLUTION * BREAKER_PATCH_ACROSS_RESOLUTION * 2;
// The travelling localized breaker front. It is a single long crest line that
// sweeps across the open-ocean domain, so a camera aimed along its tangent sees
// one continuous ridge spanning the frame. Disabled here; the spectral cascades
// and the nearshore state keep owning the surface.
//
// This gates five coupled sites that must agree, or the surface tears:
//   1. the adaptive vertex warp that concentrates the grid on the front
//   2. the crest displacement added to the main water surface
//   3. the attached 256x48 crest patch geometry
//   4. the main-surface discard that hands the band over to that patch
//   5. the patch draw call and its triangle accounting
//   6. the per-fragment shading normal in waterFragment, which must fold the
//      breaker displacement derivatives back in once the crest returns
// Leaving 4 enabled without 3 punches a transparent hole along the crest band.
export const BREAKER_ENABLED = false;
export const BREAKER_SHADER_GATE = BREAKER_ENABLED ? "1.0" : "0.0";
export const WATER_CLIPMAP_RESOLUTION = 64;
// Rings are 32 * 2^level metres of half-extent, so the count sets reach while
// the innermost ring keeps its cell size. Raising the base extent instead
// would have coarsened the water right under the camera.
//
// Ten levels reach 16384 m, past the 14500 m point where the open-ocean radial
// fog is already opaque. That headroom is not waste: the rings are
// snapped to the camera while the terrain field stays centred on the world, so
// at the 1450 m zoom limit the water must still span the 1950 m terrain radius
// from an off-centre origin (1450 + 1950 = 3400 m). Falling short of that lets
// the seabed and the sky show through beyond the water's edge.
export const WATER_CLIPMAP_LEVELS = 10;
// Where the outermost ring's edge vertices are thrown to, in metres. Two hard
// bounds: it must exceed the outermost ring (16384 m) or the skirt would pull
// geometry inward, and its depth must stay in front of the sky, which writes
// 0.999999. With near 0.12 m and the far plane below, 20 km satisfies both.
export const WATER_HORIZON_REACH = 20000;
// The far plane is fixed rather than scaled: it has to clear the skirt
// regardless of view scale, and pushing it further only costs depth precision.
// Both scenes currently share this one value — the island scene once kept the
// authored 560 m for its waterline precision, but nothing branches on the scene
// any more (`computeFrameState` reads this constant unconditionally).
export const OPEN_WATER_FAR_PLANE = 50000;
// Vertical field of view of the orbit camera, in degrees, and its near plane
// in metres. The far plane is OPEN_WATER_FAR_PLANE.
export const CAMERA_FOV_DEGREES = 52;
export const CAMERA_NEAR_PLANE = 0.12;
// Direction toward the sun before normalisation. Consumers normalise it when
// packing uniforms (sunWater.xyz).
export const SUN_DIRECTION: readonly [number, number, number] = Object.freeze([-0.52, 0.30, -0.80] as [number, number, number]);
// World-space XZ centre of the nearshore simulation field; its side length is
// TETHYS_WATER_FIELD_SIZE metres. The wake impulse is expressed relative to it.
export const SIMULATION_FIELD_CENTRE: readonly [number, number] = Object.freeze([0, -12] as [number, number]);
// The island scene always tessellates its terrain at this fixed grid
// resolution regardless of `meshResolution`.
export const SHORE_TERRAIN_MESH_RESOLUTION = 512;

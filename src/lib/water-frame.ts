// Per-frame CPU work: the orbit camera, the 256-byte WorldUniforms block and
// the nearshore wake parameters. Every function here is pure -- it reads plain
// inputs and returns fresh objects -- so the engine only has to upload the
// returned arrays.

import {
  CAMERA_FOV_DEGREES,
  CAMERA_NEAR_PLANE,
  OPEN_WATER_FAR_PLANE,
  SHORE_TERRAIN_MESH_RESOLUTION,
  SIMULATION_FIELD_CENTRE,
  SUN_DIRECTION,
  TERRAIN_EXTENT,
  WORLD_UNIFORM_BYTES,
} from "./water-constants";
import type { WaterLabOptions } from "./water-lab-types";
import { cross, lookAt, multiply, normalize, perspective, type ProjectionDepthRange, type Vec3 } from "./water-math";
import { TETHYS_WATER_FIELD_SIZE, TETHYS_WATER_LEVEL, type WaterRenderMode } from "./water-profiles";

/** Orbit camera state: yaw/pitch in radians about the scene target, radius in metres. */
export type CameraOrbitState = {
  readonly yaw: number;
  readonly pitch: number;
  readonly radius: number;
};

export type FrameStateInput = {
  readonly options: Pick<WaterLabOptions, "view" | "scene" | "fixedTime">;
  readonly camera: CameraOrbitState;
  /** requestAnimationFrame timestamp in milliseconds. */
  readonly timestamp: number;
  /** performance.now() captured when the render loop started. */
  readonly startTime: number;
  /** Backing-store size of the canvas (not CSS pixels). */
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  /** Projection depth convention; defaults to the WebGPU zero-to-one range. */
  readonly depthRange?: ProjectionDepthRange;
};

export type FrameState = {
  /** `options.fixedTime` when set, otherwise seconds since `startTime`. */
  readonly elapsedSeconds: number;
  readonly eye: Vec3;
  readonly forward: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  /** Column-major `projection * view`. */
  readonly viewProjection: Float32Array<ArrayBuffer>;
  readonly playerPosition: readonly [number, number];
  readonly playerVelocity: readonly [number, number];
  readonly underwater: boolean;
};

// Camera framing. The underwater view orbits a closer, deeper target so the
// seabed and the underside of the surface both stay in frame.
const UNDERWATER_TARGET_HEIGHT = -5.0;
const SHORE_TARGET_Z = 14;
const UNDERWATER_TARGET_Z = -18;
const OPEN_TARGET_Z = -22;
const UNDERWATER_MAX_ORBIT = 19;
const UNDERWATER_VERTICAL_ORBIT_SCALE = 0.22;
const UNDERWATER_DEFAULT_EYE_HEIGHT = -2.0;
const SURFACE_DEFAULT_EYE_HEIGHT = 5.2;
// The submerged camera never rises above this margin below the waterline.
const UNDERWATER_EYE_CEILING_MARGIN = 0.9;
// The wake source circles the simulation field.
const PLAYER_ANGULAR_SPEED = 0.22;
const PLAYER_ORBIT_RADIUS_X = 7.5;
const PLAYER_ORBIT_RADIUS_Z = 5.2;
const PLAYER_ORBIT_CENTRE_Z = -18;
const PLAYER_SPEED_X = 1.65;
const PLAYER_SPEED_Z = 1.14;

export function computeFrameState(input: FrameStateInput): FrameState {
  const { options, camera, timestamp, startTime, canvasWidth, canvasHeight, depthRange } = input;
  const liveSeconds = (timestamp - startTime) / 1000;
  const elapsedSeconds = options.fixedTime ?? liveSeconds;
  const underwater = options.view === "underwater";
  const shoreScene = options.scene === "shore";
  const target: Vec3 = [0, underwater ? UNDERWATER_TARGET_HEIGHT : TETHYS_WATER_LEVEL, shoreScene ? SHORE_TARGET_Z : (underwater ? UNDERWATER_TARGET_Z : OPEN_TARGET_Z)];
  const orbitRadius = underwater ? Math.min(camera.radius, UNDERWATER_MAX_ORBIT) : camera.radius;
  const horizontal = Math.cos(camera.pitch) * orbitRadius;
  const verticalOrbit = Math.sin(camera.pitch) * orbitRadius * (underwater ? UNDERWATER_VERTICAL_ORBIT_SCALE : 1.0);
  const defaultY = underwater ? UNDERWATER_DEFAULT_EYE_HEIGHT : SURFACE_DEFAULT_EYE_HEIGHT;
  const orbitY = defaultY + verticalOrbit;
  const eye: Vec3 = [
    target[0] + Math.sin(camera.yaw) * horizontal,
    underwater ? Math.min(TETHYS_WATER_LEVEL - UNDERWATER_EYE_CEILING_MARGIN, orbitY) : orbitY,
    target[2] + Math.cos(camera.yaw) * horizontal,
  ];
  const forward = normalize([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = normalize(cross(right, forward));
  const farPlane = OPEN_WATER_FAR_PLANE;
  const projection = perspective(CAMERA_FOV_DEGREES * Math.PI / 180, canvasWidth / canvasHeight, CAMERA_NEAR_PLANE, farPlane, depthRange);
  const view = lookAt(eye, target);
  const playerAngle = elapsedSeconds * PLAYER_ANGULAR_SPEED;
  const playerPosition: [number, number] = [Math.sin(playerAngle) * PLAYER_ORBIT_RADIUS_X, PLAYER_ORBIT_CENTRE_Z + Math.cos(playerAngle) * PLAYER_ORBIT_RADIUS_Z];
  const playerVelocity: [number, number] = [Math.cos(playerAngle) * PLAYER_SPEED_X, -Math.sin(playerAngle) * PLAYER_SPEED_Z];
  return { elapsedSeconds, eye, forward, right, up, viewProjection: multiply(projection, view), playerPosition, playerVelocity, underwater };
}

export type WorldUniformOptions = Pick<
  WaterLabOptions,
  | "meshResolution"
  | "simulationResolution"
  | "scene"
  | "waveScale"
  | "distantRoughness"
  | "detailRange"
  | "fogReach"
  | "swellSmoothing"
  | "longCascadeScale"
  | "mediumCascadeScale"
>;

export type WorldUniformInput = {
  readonly frame: FrameState;
  readonly options: WorldUniformOptions;
  /** Backing-store size of the canvas, written to interaction.zw. */
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  /** environment.w -- how much further than the authored 145 m the scene sees. */
  readonly worldScale: number;
};

/** Float offset of each vec4 in the 256-byte WorldUniforms block. */
export const WORLD_UNIFORM_OFFSETS = Object.freeze({
  viewProj: 0,
  cameraTime: 16,
  cameraRight: 20,
  cameraUp: 24,
  cameraForward: 28,
  sunWater: 32,
  terrain: 36,
  simulation: 40,
  player: 44,
  interaction: 48,
  environment: 52,
  waves: 56,
  atmosphere: 60,
});

/** Packs the WorldUniforms block (mat4 + 12 vec4 = 64 floats) into a fresh array. */
export function packWorldUniforms(input: WorldUniformInput): Float32Array<ArrayBuffer> {
  const { frame, options, canvasWidth, canvasHeight, worldScale } = input;
  const values = new Float32Array(WORLD_UNIFORM_BYTES / 4);
  values.set(frame.viewProjection, WORLD_UNIFORM_OFFSETS.viewProj);
  values.set([...frame.eye, frame.elapsedSeconds], WORLD_UNIFORM_OFFSETS.cameraTime);
  const tanHalfFov = Math.tan(CAMERA_FOV_DEGREES * Math.PI / 360);
  values.set([...frame.right, tanHalfFov * (canvasWidth / canvasHeight)], WORLD_UNIFORM_OFFSETS.cameraRight);
  values.set([...frame.up, tanHalfFov], WORLD_UNIFORM_OFFSETS.cameraUp);
  values.set([...frame.forward, 0], WORLD_UNIFORM_OFFSETS.cameraForward);
  values.set([...normalize([SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2]]), TETHYS_WATER_LEVEL], WORLD_UNIFORM_OFFSETS.sunWater);
  values.set([TERRAIN_EXTENT, options.meshResolution, options.simulationResolution, frame.underwater ? 1 : 0], WORLD_UNIFORM_OFFSETS.terrain);
  values.set([SIMULATION_FIELD_CENTRE[0], SIMULATION_FIELD_CENTRE[1], TETHYS_WATER_FIELD_SIZE, 1 / options.simulationResolution], WORLD_UNIFORM_OFFSETS.simulation);
  values.set([...frame.playerPosition, ...frame.playerVelocity], WORLD_UNIFORM_OFFSETS.player);
  values.set([Math.hypot(...frame.playerVelocity), 1, canvasWidth, canvasHeight], WORLD_UNIFORM_OFFSETS.interaction);
  const validationMesh = options.scene === "shore" ? SHORE_TERRAIN_MESH_RESOLUTION : options.meshResolution;
  values.set([options.scene === "shore" ? 1 : 0, validationMesh, validationMesh, worldScale], WORLD_UNIFORM_OFFSETS.environment);
  const waveScale = options.waveScale;
  values.set([waveScale, waveScale * waveScale, options.distantRoughness, options.detailRange], WORLD_UNIFORM_OFFSETS.waves);
  values.set([options.fogReach, options.swellSmoothing, options.longCascadeScale, options.mediumCascadeScale], WORLD_UNIFORM_OFFSETS.atmosphere);
  return values;
}

// Wake impulses are throttled to one every 0.10 s of simulated time.
const WAKE_INTERVAL_SECONDS = 0.10;
const WAKE_IMPULSE_STRENGTH = -0.012;
const WAKE_IMPULSE_RADIUS_METRES = 0.54;
const WAKE_FOAM_SHIFT = 0.72;
const REFERENCE_SUBSTEP_SECONDS = 1 / 120;
const OPTIMIZED_STEP_SECONDS = 1 / 60;

export type SimulationParamInput = {
  readonly playerPosition: readonly [number, number];
  readonly elapsedSeconds: number;
  /** Simulated time of the previous impulse; start well in the past (e.g. -10). */
  readonly lastWakeAt: number;
  readonly mode: WaterRenderMode;
};

export type SimulationParams = {
  /** SimulationParams for the impulse step: (uvX, uvY, strength, radius, dt, foamShift, 0, 0). */
  readonly impulse: Float32Array<ArrayBuffer>;
  /** Same block with the impulse strength zeroed, for the calm sub-step. */
  readonly calm: Float32Array<ArrayBuffer>;
  /** True when this frame emits an impulse; the caller records the wake time. */
  readonly wakeTriggered: boolean;
};

/** Computes both 32-byte SimulationParams blocks for one frame. */
export function computeSimulationParams(input: SimulationParamInput): SimulationParams {
  const { playerPosition, elapsedSeconds, lastWakeAt, mode } = input;
  const wakeDue = elapsedSeconds - lastWakeAt >= WAKE_INTERVAL_SECONDS;
  const impulseStrength = wakeDue ? WAKE_IMPULSE_STRENGTH : 0;
  const impulseUvX = (playerPosition[0] - SIMULATION_FIELD_CENTRE[0]) / TETHYS_WATER_FIELD_SIZE + 0.5;
  const impulseUvY = (playerPosition[1] - SIMULATION_FIELD_CENTRE[1]) / TETHYS_WATER_FIELD_SIZE + 0.5;
  const step = mode === "reference" ? REFERENCE_SUBSTEP_SECONDS : OPTIMIZED_STEP_SECONDS;
  const radius = WAKE_IMPULSE_RADIUS_METRES / TETHYS_WATER_FIELD_SIZE;
  const impulse = new Float32Array([impulseUvX, impulseUvY, impulseStrength, radius, step, WAKE_FOAM_SHIFT, 0, 0]);
  const calm = new Float32Array([impulseUvX, impulseUvY, 0, radius, step, WAKE_FOAM_SHIFT, 0, 0]);
  return { impulse, calm, wakeTriggered: impulseStrength !== 0 };
}

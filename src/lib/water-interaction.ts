// Pointer-drag orbit and wheel zoom for the water lab camera. The controller
// owns the orbit state and exposes it as an
// immutable snapshot; each event replaces the snapshot rather than mutating it.

import { OPEN_WATER_MAX_ORBIT } from "./water-constants";
import type { CameraOrbitState } from "./water-frame";
import type { WaterLabOptions } from "./water-lab-types";

export type { CameraOrbitState } from "./water-frame";

// Start near the wind-opposed sun azimuth so the physically generated
// Cox-Munk glitter path is visible in the default review shot.
export const DEFAULT_CAMERA_ORBIT: CameraOrbitState = Object.freeze({ yaw: 0.56, pitch: 0.07, radius: 58 });
// The island scene looks back at the shore from the water.
const SHORE_CAMERA_YAW = Math.PI;
const SHORE_CAMERA_PITCH = 0.22;
export const MIN_CAMERA_PITCH = -0.24;
export const MAX_CAMERA_PITCH = 1.08;
export const MIN_ORBIT_RADIUS = 6;
const YAW_PER_PIXEL = 0.005;
const PITCH_PER_PIXEL = 0.004;
const ZOOM_PER_WHEEL_DELTA = 0.001;

/** The pointer currently dragging the camera, and where it was last seen. */
type ActivePointer = {
  readonly id: number;
  readonly x: number;
  readonly y: number;
};

/** Minimal canvas surface the controller needs; a real HTMLCanvasElement satisfies it. */
export type InteractionCanvas = Pick<HTMLCanvasElement, "addEventListener" | "removeEventListener" | "setPointerCapture">;

export function clampCameraPitch(pitch: number): number {
  return Math.max(MIN_CAMERA_PITCH, Math.min(MAX_CAMERA_PITCH, pitch));
}

/**
 * The orbit the camera starts from: explicit `cameraYaw`/`cameraPitch` win,
 * otherwise the island scene faces the shore and the open ocean keeps the
 * authored review framing.
 */
export function resolveInitialCameraOrbit(options: Pick<WaterLabOptions, "scene" | "cameraYaw" | "cameraPitch">): CameraOrbitState {
  const shore = options.scene === "shore";
  const yaw = typeof options.cameraYaw === "number" && Number.isFinite(options.cameraYaw)
    ? options.cameraYaw
    : shore ? SHORE_CAMERA_YAW : DEFAULT_CAMERA_ORBIT.yaw;
  const pitch = typeof options.cameraPitch === "number" && Number.isFinite(options.cameraPitch)
    ? clampCameraPitch(options.cameraPitch)
    : shore ? SHORE_CAMERA_PITCH : DEFAULT_CAMERA_ORBIT.pitch;
  return Object.freeze({ yaw, pitch, radius: DEFAULT_CAMERA_ORBIT.radius });
}

export class WaterInteractionController {
  private current: CameraOrbitState;
  private pointer: ActivePointer | null = null;
  private canvas: InteractionCanvas | null = null;

  constructor(initial: CameraOrbitState) {
    this.current = Object.freeze({ ...initial });
  }

  /** The live orbit; a new frozen object after every event. */
  get state(): CameraOrbitState {
    return this.current;
  }

  /** Registers pointer and wheel listeners; the wheel listener is non-passive so it can prevent scrolling. */
  attach(canvas: InteractionCanvas) {
    if (this.canvas) this.detach();
    this.canvas = canvas;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  /** Removes the listeners; safe to call when never attached. */
  detach() {
    const canvas = this.canvas;
    if (!canvas) return;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerUp);
    canvas.removeEventListener("wheel", this.onWheel);
    this.canvas = null;
    // A drag in progress ends with the listeners: the matching `pointerup` can
    // no longer arrive, so keeping the pointer would leave the controller
    // believing a button is still down. `attach()` (including the re-attach it
    // does for a second canvas) then starts from a clean, idle state.
    this.pointer = null;
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    this.canvas?.setPointerCapture(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.pointer || event.pointerId !== this.pointer.id) return;
    const dx = event.clientX - this.pointer.x;
    const dy = event.clientY - this.pointer.y;
    this.pointer = { id: this.pointer.id, x: event.clientX, y: event.clientY };
    this.current = Object.freeze({
      ...this.current,
      yaw: this.current.yaw - dx * YAW_PER_PIXEL,
      pitch: clampCameraPitch(this.current.pitch + dy * PITCH_PER_PIXEL),
    });
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (this.pointer?.id === event.pointerId) {
      this.pointer = null;
    }
  };

  private readonly onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const ceiling = OPEN_WATER_MAX_ORBIT;
    this.current = Object.freeze({
      ...this.current,
      radius: Math.max(MIN_ORBIT_RADIUS, Math.min(ceiling, this.current.radius * Math.exp(event.deltaY * ZOOM_PER_WHEEL_DELTA))),
    });
  };
}

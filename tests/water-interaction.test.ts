import { describe, expect, it } from "vitest";

import { OPEN_WATER_MAX_ORBIT } from "../src/lib/water-constants";
import {
  DEFAULT_CAMERA_ORBIT,
  MAX_CAMERA_PITCH,
  MIN_CAMERA_PITCH,
  MIN_ORBIT_RADIUS,
  WaterInteractionController,
  clampCameraPitch,
  resolveInitialCameraOrbit,
  type InteractionCanvas,
} from "../src/lib/water-interaction";

type FakeCanvas = EventTarget & InteractionCanvas & { captured: number[] };

function fakeCanvas(): FakeCanvas {
  const target = new EventTarget() as FakeCanvas;
  target.captured = [];
  target.setPointerCapture = (pointerId: number) => { target.captured.push(pointerId); };
  return target;
}

function pointer(type: string, pointerId: number, clientX = 0, clientY = 0) {
  return Object.assign(new Event(type, { cancelable: true }), { pointerId, clientX, clientY });
}

function wheel(deltaY: number) {
  return Object.assign(new Event("wheel", { cancelable: true }), { deltaY });
}

describe("resolveInitialCameraOrbit", () => {
  it("uses the review framing for the open ocean and faces the shore for the island", () => {
    expect(resolveInitialCameraOrbit({ scene: "open" })).toEqual(DEFAULT_CAMERA_ORBIT);
    expect(resolveInitialCameraOrbit({ scene: "shore" })).toEqual({ yaw: Math.PI, pitch: 0.22, radius: 58 });
  });

  it("honours explicit finite angles and clamps the pitch", () => {
    expect(resolveInitialCameraOrbit({ scene: "shore", cameraYaw: 2.05, cameraPitch: -0.02 })).toEqual({ yaw: 2.05, pitch: -0.02, radius: 58 });
    expect(resolveInitialCameraOrbit({ scene: "open", cameraPitch: 5 }).pitch).toBe(MAX_CAMERA_PITCH);
    expect(resolveInitialCameraOrbit({ scene: "open", cameraPitch: -5 }).pitch).toBe(MIN_CAMERA_PITCH);
    expect(resolveInitialCameraOrbit({ scene: "shore", cameraYaw: Number.NaN, cameraPitch: Number.POSITIVE_INFINITY })).toEqual({ yaw: Math.PI, pitch: 0.22, radius: 58 });
  });

  it("clamps pitch to the authored range", () => {
    expect(clampCameraPitch(0.5)).toBe(0.5);
    expect(clampCameraPitch(-1)).toBe(-0.24);
    expect(clampCameraPitch(2)).toBe(1.08);
  });
});

describe("WaterInteractionController", () => {
  it("starts from the given orbit and exposes it immutably", () => {
    const controller = new WaterInteractionController({ yaw: 0.3, pitch: 0.1, radius: 40 });
    expect(controller.state).toEqual({ yaw: 0.3, pitch: 0.1, radius: 40 });
    expect(Object.isFrozen(controller.state)).toBe(true);
  });

  it("orbits with pointer drags and captures the pointer", () => {
    const canvas = fakeCanvas();
    const controller = new WaterInteractionController({ yaw: Math.PI, pitch: 0.22, radius: 58 });
    controller.attach(canvas);
    const before = controller.state;
    canvas.dispatchEvent(pointer("pointerdown", 3, 100, 100));
    expect(canvas.captured).toEqual([3]);
    canvas.dispatchEvent(pointer("pointermove", 3, 140, 70));
    expect(controller.state.yaw).toBeCloseTo(Math.PI - 40 * 0.005, 12);
    expect(controller.state.pitch).toBeCloseTo(0.22 - 30 * 0.004, 12);
    // a different pointer id is ignored
    canvas.dispatchEvent(pointer("pointermove", 9, 999, 999));
    expect(controller.state.yaw).toBeCloseTo(Math.PI - 40 * 0.005, 12);
    canvas.dispatchEvent(pointer("pointermove", 3, 141, 71));
    expect(controller.state.yaw).toBeCloseTo(Math.PI - 41 * 0.005, 12);
    expect(controller.state.pitch).toBeCloseTo(0.22 - 30 * 0.004 + 0.004, 12);
    canvas.dispatchEvent(pointer("pointerup", 3));
    canvas.dispatchEvent(pointer("pointermove", 3, 500, 500));
    expect(controller.state.yaw).toBeCloseTo(Math.PI - 41 * 0.005, 12);
    // earlier snapshots are untouched
    expect(before).toEqual({ yaw: Math.PI, pitch: 0.22, radius: 58 });
    controller.detach();
  });

  it("clamps the pitch during a drag", () => {
    const canvas = fakeCanvas();
    const controller = new WaterInteractionController({ yaw: 2.05, pitch: -0.02, radius: 58 });
    controller.attach(canvas);
    canvas.dispatchEvent(pointer("pointerdown", 1, 0, 0));
    canvas.dispatchEvent(pointer("pointermove", 1, 0, 100000));
    expect(controller.state.pitch).toBe(MAX_CAMERA_PITCH);
    canvas.dispatchEvent(pointer("pointermove", 1, 0, -100000));
    expect(controller.state.pitch).toBe(MIN_CAMERA_PITCH);
    canvas.dispatchEvent(pointer("pointercancel", 1));
    canvas.dispatchEvent(pointer("pointermove", 1, 50, 50));
    expect(controller.state.pitch).toBe(MIN_CAMERA_PITCH);
    controller.detach();
  });

  it("zooms exponentially with the wheel inside the orbit limits and prevents scrolling", () => {
    const canvas = fakeCanvas();
    const controller = new WaterInteractionController({ yaw: 0, pitch: 0, radius: 58 });
    controller.attach(canvas);
    const event = wheel(240);
    canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(controller.state.radius).toBeCloseTo(58 * Math.exp(0.24), 12);
    canvas.dispatchEvent(wheel(-55));
    expect(controller.state.radius).toBeCloseTo(58 * Math.exp(0.24) * Math.exp(-0.055), 12);
    canvas.dispatchEvent(wheel(100000));
    expect(controller.state.radius).toBe(OPEN_WATER_MAX_ORBIT);
    canvas.dispatchEvent(wheel(-100000));
    expect(controller.state.radius).toBe(MIN_ORBIT_RADIUS);
    controller.detach();
  });

  it("stops listening after detach and tolerates detach without attach", () => {
    const canvas = fakeCanvas();
    const controller = new WaterInteractionController(DEFAULT_CAMERA_ORBIT);
    expect(() => controller.detach()).not.toThrow();
    controller.attach(canvas);
    controller.detach();
    canvas.dispatchEvent(wheel(500));
    canvas.dispatchEvent(pointer("pointerdown", 1, 0, 0));
    canvas.dispatchEvent(pointer("pointermove", 1, 100, 100));
    expect(controller.state).toEqual(DEFAULT_CAMERA_ORBIT);
    expect(canvas.captured).toEqual([]);
  });

  it("re-attaching moves the listeners to the new canvas", () => {
    const first = fakeCanvas();
    const second = fakeCanvas();
    const controller = new WaterInteractionController(DEFAULT_CAMERA_ORBIT);
    controller.attach(first);
    controller.attach(second);
    first.dispatchEvent(wheel(500));
    expect(controller.state.radius).toBe(DEFAULT_CAMERA_ORBIT.radius);
    second.dispatchEvent(wheel(500));
    expect(controller.state.radius).toBeCloseTo(58 * Math.exp(0.5), 12);
    controller.detach();
  });
});

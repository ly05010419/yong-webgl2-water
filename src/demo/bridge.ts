// The automation bridge the capture and comparison scripts drive the demo
// through. Installed on `window` synchronously, *before* `init()` resolves: a
// start-up that fails never reaches `attach()`, and without the placeholder a
// script would time out waiting for a global instead of reading the cause out
// of `getMetrics().error`.

import type { WebGl2WaterEngine } from "../lib/webgl2-water-engine";
import type { WaterLabMetrics } from "../lib/water-lab-types";
import type { WaterRenderMode, WaterScene, WaterView } from "../lib/water-profiles";
import type { PanelActions } from "./panel-model";

/** Method names match the source project's bridge so its scripts port over unchanged. */
export interface WaterLabBridge {
  ready: boolean;
  getMetrics: () => WaterLabMetrics;
  setMode: (mode: WaterRenderMode) => void;
  setView: (view: WaterView) => void;
  setScene: (scene: WaterScene) => void;
  setMeshResolution: (resolution: number) => void;
  setSimulationResolution: (resolution: number) => void;
  setRenderScale: (scale: number) => void;
  setWaveScale: (scale: number) => void;
  setDistantRoughness: (value: number) => void;
  setDetailRange: (value: number) => void;
  setSwellSmoothing: (value: number) => void;
  setLongCascadeScale: (value: number) => void;
  setMediumCascadeScale: (value: number) => void;
  setFogReach: (value: number) => void;
  resetMetrics: () => void;
}

declare global {
  interface Window {
    __WEBGL2_WATER_LAB__?: WaterLabBridge;
  }
}

/**
 * The placeholder bridge: it can report, and every setter is a deliberate
 * no-op. There is no engine to drive yet, and moving the panel alone would
 * claim a state the renderer is not in — configure a not-yet-started run
 * through the URL parameters instead.
 */
export function installPendingBridge(metrics: () => WaterLabMetrics): void {
  const noEngineYet = (): void => undefined;
  window.__WEBGL2_WATER_LAB__ = {
    ready: false,
    getMetrics: metrics,
    setMode: noEngineYet,
    setView: noEngineYet,
    setScene: noEngineYet,
    setMeshResolution: noEngineYet,
    setSimulationResolution: noEngineYet,
    setRenderScale: noEngineYet,
    setWaveScale: noEngineYet,
    setDistantRoughness: noEngineYet,
    setDetailRange: noEngineYet,
    setSwellSmoothing: noEngineYet,
    setLongCascadeScale: noEngineYet,
    setMediumCascadeScale: noEngineYet,
    setFogReach: noEngineYet,
    resetMetrics: noEngineYet,
  };
}

/**
 * Replaces the placeholder with the live bridge once the engine is running.
 * Every method routes through the same `actions` table the panel uses, so a
 * scripted change and a click land on exactly the same code path — including
 * the clamp and the panel refresh that follow it.
 */
export function installLiveBridge(engine: WebGl2WaterEngine, actions: PanelActions): void {
  window.__WEBGL2_WATER_LAB__ = {
    ready: true,
    getMetrics: () => engine.getMetrics(),
    setMode: actions.mode,
    setView: actions.view,
    setScene: actions.scene,
    setMeshResolution: actions.meshResolution,
    setSimulationResolution: actions.simulationResolution,
    setRenderScale: actions.renderScale,
    setWaveScale: actions.waveScale,
    setDistantRoughness: actions.distantRoughness,
    setDetailRange: actions.detailRange,
    setSwellSmoothing: actions.swellSmoothing,
    setLongCascadeScale: actions.longCascadeScale,
    setMediumCascadeScale: actions.mediumCascadeScale,
    setFogReach: actions.fogReach,
    resetMetrics: () => engine.resetMetrics(),
  };
}

export function removeBridge(): void {
  delete window.__WEBGL2_WATER_LAB__;
}

// Demo entry point: read the URL, build the page, start the engine, keep the
// panel and the automation bridge fed.
//
// The whole file is one `start()` because the page has exactly one engine and
// exactly one lifetime. `?ui=0` drops the panel for clean captures; the status
// overlay is built either way, because a start-up failure has to be visible on
// a page that asked for no UI just as much as on one that did.

import { WebGl2WaterEngine } from "../lib/webgl2-water-engine";
import { parseWaterLabQuery } from "../lib/water-lab-query";
import {
  normalizeWaterLabOption,
  type NumericWaterLabOption,
  type WaterLabMetrics,
  type WaterLabOptions,
} from "../lib/water-lab-types";
import type { WaterRenderMode, WaterScene, WaterView } from "../lib/water-profiles";
import { installLiveBridge, installPendingBridge, removeBridge } from "./bridge";
import { element } from "./dom";
import { PENDING_METRICS } from "./labels";
import { createWaterLabPanel } from "./panel";
import type { PanelActions } from "./panel-model";
import "./panel.css";

/** How often the panel re-reads the engine's metrics. */
const TELEMETRY_INTERVAL_MS = 250;
const STARTING_MESSAGE = "正在构建特提斯计算场…";
const MISSING_ROOT_MESSAGE = "页面缺少 #app 挂载节点，演示无法启动。";

/**
 * Which engine setter each numeric option is driven through. Written out rather
 * than derived from the option name, so a renamed setter is a compile error
 * instead of a silently dead control.
 */
const ENGINE_SETTERS: Readonly<Record<NumericWaterLabOption, (engine: WebGl2WaterEngine, value: number) => void>> = Object.freeze({
  meshResolution: (engine, value) => engine.setMeshResolution(value),
  simulationResolution: (engine, value) => engine.setSimulationResolution(value),
  renderScale: (engine, value) => engine.setRenderScale(value),
  waveScale: (engine, value) => engine.setWaveScale(value),
  distantRoughness: (engine, value) => engine.setDistantRoughness(value),
  detailRange: (engine, value) => engine.setDetailRange(value),
  swellSmoothing: (engine, value) => engine.setSwellSmoothing(value),
  longCascadeScale: (engine, value) => engine.setLongCascadeScale(value),
  mediumCascadeScale: (engine, value) => engine.setMediumCascadeScale(value),
  fogReach: (engine, value) => engine.setFogReach(value),
});

/** The page chrome around the canvas: shell, status overlay and the QA probe. */
interface Chrome {
  readonly shell: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly status: HTMLElement;
  readonly statusText: HTMLElement;
  readonly qa: HTMLElement;
}

function buildChrome(): Chrome {
  const canvas = element("canvas", {
    className: "canvas",
    attributes: { "aria-label": "WebGL2 特提斯水体生物群系" },
  });
  const statusText = element("p", { className: "statusText", text: STARTING_MESSAGE });
  const status = element("div", {
    className: "status",
    children: [element("div", { className: "statusBody", children: [statusText] })],
  });
  // Mirrors the source project's `#webgpu-water-lab-qa` probe: a hidden element
  // carrying the full metrics JSON, for a harness that would rather read the
  // DOM than call into `window`.
  const qa = element("output", {
    attributes: { id: "webgl2-water-lab-qa", "data-ready": "false", hidden: "" },
  });
  const shell = element("main", { className: "shell", children: [canvas, status, qa] });
  return { shell, canvas, status, statusText, qa };
}

/** Shows the overlay while starting, and keeps it up (with the cause) on failure. */
function renderStatus(chrome: Chrome, starting: boolean, metrics: WaterLabMetrics): void {
  const visible = starting || metrics.error !== null;
  chrome.status.style.display = visible ? "" : "none";
  chrome.statusText.textContent = metrics.error ?? STARTING_MESSAGE;
  chrome.qa.dataset.ready = metrics.ready ? "true" : "false";
  chrome.qa.textContent = JSON.stringify(metrics);
}

function start(): void {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error(MISSING_ROOT_MESSAGE);
  const { options, showUi } = parseWaterLabQuery(window.location.search);

  const chrome = buildChrome();
  root.append(chrome.shell);

  // The demo's own copy of the options. The engine clamps and keeps its own,
  // but never hands them back, so this is what the panel renders from — kept
  // honest by routing every write through `normalizeWaterLabOption`, the very
  // function the engine's setters use.
  let state: WaterLabOptions = options;
  let metrics: WaterLabMetrics = { ...PENDING_METRICS };
  let starting = true;
  let engine: WebGl2WaterEngine | null = null;

  const applyView = (view: WaterView): void => {
    chrome.shell.classList.toggle("underwaterShell", view === "underwater");
  };

  const refresh = (): void => {
    panel.sync(state);
    applyView(state.view);
  };

  const publish = (next: WaterLabMetrics): void => {
    metrics = next;
    panel.renderMetrics(next);
    renderStatus(chrome, starting, next);
  };

  /** One numeric option: clamp it, record it, drive the engine, redraw. */
  const setNumber = (option: NumericWaterLabOption) => (value: number): void => {
    const clamped = normalizeWaterLabOption(option, value);
    state = { ...state, [option]: clamped };
    if (engine) ENGINE_SETTERS[option](engine, clamped);
    refresh();
  };

  const actions: PanelActions = {
    meshResolution: setNumber("meshResolution"),
    simulationResolution: setNumber("simulationResolution"),
    renderScale: setNumber("renderScale"),
    waveScale: setNumber("waveScale"),
    distantRoughness: setNumber("distantRoughness"),
    detailRange: setNumber("detailRange"),
    swellSmoothing: setNumber("swellSmoothing"),
    longCascadeScale: setNumber("longCascadeScale"),
    mediumCascadeScale: setNumber("mediumCascadeScale"),
    fogReach: setNumber("fogReach"),
    mode: (value: WaterRenderMode): void => { state = { ...state, mode: value }; engine?.setMode(value); refresh(); },
    view: (value: WaterView): void => { state = { ...state, view: value }; engine?.setView(value); refresh(); },
    scene: (value: WaterScene): void => { state = { ...state, scene: value }; engine?.setScene(value); refresh(); },
  };

  const panel = createWaterLabPanel(actions);
  if (showUi) chrome.shell.append(panel.element);
  refresh();
  publish(metrics);

  // Installed *now*, not after `init()` resolves: a start-up that fails never
  // reaches `installLiveBridge`, and without this placeholder every capture
  // script would time out instead of reading the cause out of `getMetrics()`.
  installPendingBridge(() => metrics);

  const created = new WebGl2WaterEngine(chrome.canvas, options);
  void created.init().then(() => {
    engine = created;
    starting = false;
    installLiveBridge(created, actions);
    publish(created.getMetrics());
  }).catch((error: unknown) => {
    starting = false;
    publish({ ...metrics, error: error instanceof Error ? error.message : String(error) });
  });

  const telemetry = window.setInterval(() => {
    if (engine) publish(engine.getMetrics());
  }, TELEMETRY_INTERVAL_MS);

  // `pagehide` rather than `unload`: it also fires when the page enters the
  // back/forward cache, which is exactly when the render loop must stop.
  window.addEventListener("pagehide", () => {
    window.clearInterval(telemetry);
    created.dispose();
    engine = null;
    removeBridge();
  });
}

start();

// The control panel, built from `panel-model.ts` as plain DOM.
//
// It owns no state of its own: `sync()` writes the caller's options into the
// controls and `renderMetrics()` writes the latest sample into the grid. Every
// control reports through `actions`, so the engine and the panel can never
// disagree about who holds the value — the caller does.

import type { WaterLabMetrics, NumericWaterLabOption } from "../lib/water-lab-types";
import { WATER_PROFILES } from "../lib/water-profiles";
import { element, labelledSection } from "./dom";
import { sliderRange } from "./labels";
import {
  METRIC_ROWS,
  MODE_HINTS,
  MODE_SEGMENT,
  SCENE_SEGMENT,
  SLIDER_SPECS,
  VIEW_SEGMENT,
  type PanelActions,
  type PanelState,
  type SegmentSpec,
} from "./panel-model";

const EYEBROW = "Inkwell 渲染器实验";
const TITLE = "WebGL2 特提斯";
const INTRO = "特提斯水体、水下沙床、传播尾迹、深度感知波浪、折射、反射与焦散，全部集成于一个框架无关的 WebGL2 渲染器中。";
const CONTROLS_HINT = "拖拽旋转视角 · 滚轮缩放 · 面板为原生 DOM";

/** A segmented control plus the buttons it has to re-style on every `sync()`. */
interface Segment<T extends string> {
  readonly section: HTMLElement;
  readonly buttons: ReadonlyMap<T, HTMLButtonElement>;
}

function buildSegment<T extends string>(spec: SegmentSpec<T>, onSelect: (value: T) => void, extra?: Node): Segment<T> {
  const buttons = new Map<T, HTMLButtonElement>();
  const group = element("div", { className: "segmented" });
  for (const [value, text] of spec.choices) {
    const button = element("button", { text, attributes: { type: "button" } });
    button.addEventListener("click", () => onSelect(value));
    buttons.set(value, button);
    group.append(button);
  }
  const body: Node[] = extra ? [group, extra] : [group];
  return { section: labelledSection(spec.label, ...body), buttons };
}

function selectSegment<T extends string>(segment: Segment<T>, active: T): void {
  for (const [value, button] of segment.buttons) button.classList.toggle("active", value === active);
}

/** One labelled range input; its bounds and step come from the shared table. */
interface Slider {
  readonly label: HTMLLabelElement;
  readonly input: HTMLInputElement;
  readonly readout: HTMLOutputElement;
}

function buildSlider(option: NumericWaterLabOption, title: string, onInput: (value: number) => void): Slider {
  const { min, max, step } = sliderRange(option);
  const readout = element("output");
  const input = element("input", {
    attributes: { type: "range", min: String(min), max: String(max), step: String(step) },
  });
  input.addEventListener("input", () => onInput(Number(input.value)));
  const label = element("label", {
    children: [element("span", { children: [element("span", { text: title }), readout] }), input],
  });
  return { label, input, readout };
}

export interface WaterLabPanel {
  readonly element: HTMLElement;
  /** Mirrors the caller's options into every control. */
  sync(state: PanelState): void;
  /** Writes one metrics sample into the grid and the adapter line. */
  renderMetrics(metrics: WaterLabMetrics): void;
}

/**
 * Builds the panel. `actions` is called on every user edit; nothing is applied
 * to the controls until the caller calls `sync()` back, which is what keeps the
 * displayed value equal to the *clamped* value the engine accepted.
 */
export function createWaterLabPanel(actions: PanelActions): WaterLabPanel {
  const hint = element("p", { className: "hint" });
  const mode = buildSegment(MODE_SEGMENT, actions.mode, hint);
  const view = buildSegment(VIEW_SEGMENT, actions.view);
  const scene = buildSegment(SCENE_SEGMENT, actions.scene);

  const presets = element("div", { className: "profilePresets" });
  for (const profile of WATER_PROFILES) {
    const button = element("button", { text: profile.label, attributes: { type: "button" } });
    button.addEventListener("click", () => {
      actions.meshResolution(profile.meshResolution);
      actions.simulationResolution(profile.simulationResolution);
      actions.renderScale(profile.renderScale);
    });
    presets.append(button);
  }

  const sliders = new Map<NumericWaterLabOption, Slider>();
  const sliderSection = element("section", { className: "sliders" });
  for (const spec of SLIDER_SPECS) {
    const slider = buildSlider(spec.option, spec.label, actions[spec.option]);
    sliders.set(spec.option, slider);
    sliderSection.append(slider.label);
  }

  const metricValues: HTMLElement[] = [];
  const metricsGrid = element("dl", { className: "metrics" });
  for (const row of METRIC_ROWS) {
    const value = element("dd");
    metricValues.push(value);
    metricsGrid.append(element("div", { children: [element("dt", { text: row.term }), value] }));
  }

  const adapter = element("p", { className: "adapter" });
  const panel = element("aside", {
    className: "panel",
    children: [
      element("p", { className: "eyebrow", text: EYEBROW }),
      element("h1", { text: TITLE }),
      element("p", { className: "intro", text: INTRO }),
      mode.section,
      view.section,
      scene.section,
      labelledSection("质量档位", presets),
      sliderSection,
      metricsGrid,
      adapter,
      element("p", { className: "controls", text: CONTROLS_HINT }),
    ],
  });

  return {
    element: panel,
    sync(state) {
      selectSegment(mode, state.mode);
      selectSegment(view, state.view);
      selectSegment(scene, state.scene);
      hint.textContent = MODE_HINTS[state.mode];
      for (const spec of SLIDER_SPECS) {
        const slider = sliders.get(spec.option);
        if (!slider) continue;
        const value = state[spec.option];
        slider.input.value = String(value);
        slider.readout.textContent = spec.format(value);
      }
    },
    renderMetrics(metrics) {
      METRIC_ROWS.forEach((row, index) => {
        const target = metricValues[index];
        if (target) target.textContent = row.value(metrics);
      });
      adapter.textContent = metrics.adapter;
    },
  };
}

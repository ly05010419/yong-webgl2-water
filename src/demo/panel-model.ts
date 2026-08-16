// What the panel shows, as data: one row per slider and one row per metric.
//
// Keeping the tables here rather than inline in the DOM builder is what makes
// "the panel offers exactly these ten sliders, in this order, with these units"
// a thing you can read in twenty lines — and what lets `panel.ts` stay a loop.

import type { WaterLabMetrics, WaterLabOptions, NumericWaterLabOption } from "../lib/water-lab-types";
import type { WaterRenderMode, WaterScene, WaterView } from "../lib/water-profiles";
import { formatCount } from "./labels";

/** One slider: which option it drives, its Chinese label and its unit format. */
export interface SliderSpec {
  readonly option: NumericWaterLabOption;
  readonly label: string;
  readonly format: (value: number) => string;
}

/** The authored fade distance one unit of `detailRange` corresponds to. */
const DETAIL_RANGE_METRES = 118;
/** The authored fog distance, and the world scale the open ocean multiplies it by. */
const FOG_REACH_METRES = 145 * 100;

/** The ten sliders, in the order the source panel lists them. */
export const SLIDER_SPECS: readonly SliderSpec[] = Object.freeze([
  { option: "meshResolution", label: "水面网格", format: (value) => `${value}²` },
  { option: "simulationResolution", label: "近岸场", format: (value) => `${value}²` },
  { option: "longCascadeScale", label: "长浪尺度", format: (value) => `${value.toFixed(0)}m` },
  { option: "mediumCascadeScale", label: "中浪尺度", format: (value) => `${value.toFixed(0)}m` },
  { option: "waveScale", label: "浪高", format: (value) => `${value.toFixed(2)}×` },
  { option: "detailRange", label: "细节距离", format: (value) => `${(value * DETAIL_RANGE_METRES).toFixed(0)}m` },
  { option: "swellSmoothing", label: "远景平滑", format: (value) => (value === 0 ? "关闭" : `${value.toFixed(2)}×`) },
  { option: "distantRoughness", label: "远景粗糙度", format: (value) => value.toFixed(2) },
  { option: "fogReach", label: "雾距", format: (value) => (value === 0 ? "关闭" : `${(value * FOG_REACH_METRES).toFixed(0)}m`) },
  { option: "renderScale", label: "渲染缩放", format: (value) => `${value.toFixed(2)}×` },
] satisfies readonly SliderSpec[]);

/** One `<dt>/<dd>` pair of the metrics grid. */
export interface MetricRow {
  readonly term: string;
  readonly value: (metrics: WaterLabMetrics) => string;
}

const BYTES_PER_MIB = 1_048_576;

/** The twelve metric rows, in the order the source panel lists them. */
export const METRIC_ROWS: readonly MetricRow[] = Object.freeze([
  { term: "后端", value: () => "WebGL2" },
  { term: "三角形数", value: (m) => formatCount(m.triangles) },
  { term: "近岸状态", value: (m) => `${(m.simulationBytes / BYTES_PER_MIB).toFixed(2)} MiB` },
  { term: "模拟", value: (m) => `${m.simulationSubsteps} 个计算步` },
  { term: "场景捕获", value: (m) => `${m.sceneCapturePasses} 次共享` },
  { term: "扰动数", value: (m) => formatCount(m.disturbanceCount) },
  { term: "帧率 / 平均", value: (m) => `${m.fps.toFixed(0)} · ${m.frameMeanMs.toFixed(2)}ms` },
  { term: "p95 / p99", value: (m) => `${m.frameP95Ms.toFixed(2)} · ${m.frameP99Ms.toFixed(2)}ms` },
  { term: "最大 / 卡顿", value: (m) => `${m.frameMaxMs.toFixed(2)} · ${m.hitchFrames}` },
  { term: "JS 提交", value: (m) => `${m.submitMeanMs.toFixed(3)}ms` },
  { term: "GPU 模拟", value: (m) => (m.gpuSimulationMeanMs === null ? "—" : `${m.gpuSimulationMeanMs.toFixed(3)}ms`) },
  { term: "GPU 渲染", value: (m) => (m.gpuRenderMeanMs === null ? "—" : `${m.gpuRenderMeanMs.toFixed(2)}ms`) },
] satisfies readonly MetricRow[]);

/** One two-button segmented control. */
export interface SegmentSpec<T extends string> {
  readonly label: string;
  readonly choices: readonly (readonly [value: T, text: string])[];
}

export const MODE_SEGMENT: SegmentSpec<WaterRenderMode> = Object.freeze({
  label: "水体路径",
  choices: Object.freeze([
    Object.freeze(["optimized", "优化路径"] as const),
    Object.freeze(["reference", "参考对照 A/B"] as const),
  ]),
});

export const VIEW_SEGMENT: SegmentSpec<WaterView> = Object.freeze({
  label: "相机介质",
  choices: Object.freeze([
    Object.freeze(["surface", "水面上"] as const),
    Object.freeze(["underwater", "水面下"] as const),
  ]),
});

export const SCENE_SEGMENT: SegmentSpec<WaterScene> = Object.freeze({
  label: "验证场景",
  choices: Object.freeze([
    Object.freeze(["open", "开阔水域"] as const),
    Object.freeze(["shore", "岛屿海岸"] as const),
  ]),
});

/** The one-line explanation under the mode segment. */
export const MODE_HINTS: Readonly<Record<WaterRenderMode, string>> = Object.freeze({
  optimized: "单次计算传播步 + 解析式场景折射/反射；无重复场景捕获。",
  reference: "两个生产级传播子步，以及更宽的反射采样参考实现。",
});

/** Every option the panel can write, as one callback table. */
export type PanelActions = {
  readonly [K in NumericWaterLabOption]: (value: number) => void;
} & {
  readonly mode: (value: WaterRenderMode) => void;
  readonly view: (value: WaterView) => void;
  readonly scene: (value: WaterScene) => void;
};

/** The subset of the options the panel mirrors back into its controls. */
export type PanelState = Pick<
  WaterLabOptions,
  "mode" | "view" | "scene" | NumericWaterLabOption
>;

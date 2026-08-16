// `?mode=…&scene=…&…` → engine options, in one pure function.
//
// The demo used to inline every clamp next to its `query.get(...)`, which meant
// a second copy of the bounds that `WATER_LAB_OPTION_BOUNDS` already declares —
// and they had started to disagree (the panel offered `simulation` from 128
// while the engine accepts 64). Everything numeric now goes through
// `normalizeWaterLabOption`, so a URL and the equivalent setter call land on
// exactly the same value.
//
// Pure and DOM-free: it takes the `location.search` string, so it is testable
// in node and the component keeps no parsing logic of its own.

import {
  WATER_LAB_OPTION_BOUNDS,
  normalizeWaterLabOption,
  normalizeWaterLabOptions,
  type NumericWaterLabOption,
  type WaterLabOptions,
} from "./water-lab-types";
import type { WaterRenderMode, WaterScene, WaterView } from "./water-profiles";

/** Everything the demo reads out of the URL. */
export interface WaterLabQuery {
  /** Fully defaulted and clamped; ready to hand to either engine constructor. */
  readonly options: WaterLabOptions;
  /** `?ui=0` hides the control panel for clean captures. */
  readonly showUi: boolean;
}

/** Query parameter name → the option it clamps against. */
const NUMERIC_PARAMETERS: Readonly<Record<string, NumericWaterLabOption>> = Object.freeze({
  mesh: "meshResolution",
  simulation: "simulationResolution",
  scale: "renderScale",
  waves: "waveScale",
  farRough: "distantRoughness",
  detail: "detailRange",
  smooth: "swellSmoothing",
  longScale: "longCascadeScale",
  mediumScale: "mediumCascadeScale",
  fog: "fogReach",
});

/**
 * A finite number for `key`, or `undefined` when the parameter is absent, empty
 * or unparseable. `undefined` means "leave the default alone" everywhere below,
 * which is what keeps an unrecognised value from becoming `NaN` downstream.
 */
function readNumber(query: URLSearchParams, key: string): number | undefined {
  const raw = query.get(key);
  if (raw === null || raw.trim().length === 0) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * One clamped numeric option. Grid resolutions are **rounded** before the shared
 * clamp floors them: `?simulation=256.5` reads as "about 256", and rounding to
 * the nearest legal grid is friendlier than silently dropping to 256 the way a
 * bare floor would — the clamp then still guarantees the engine sees an integer
 * inside `WATER_LAB_OPTION_BOUNDS`.
 */
function readOption(query: URLSearchParams, key: string, option: NumericWaterLabOption): number | undefined {
  const value = readNumber(query, key);
  if (value === undefined) return undefined;
  const rounded = WATER_LAB_OPTION_BOUNDS[option].integer ? Math.round(value) : value;
  return normalizeWaterLabOption(option, rounded);
}

/** `?frames=N` stops the loop after N rendered frames; anything below 1 is ignored. */
function readFrameLimit(query: URLSearchParams): number | undefined {
  const value = readNumber(query, "frames");
  if (value === undefined) return undefined;
  // Floor first, then test: `frames=0.5` is not "half a frame", it is a request
  // the loop cannot honour, so it must fall back to "run forever" rather than
  // become a limit of 0 that would stop before the first frame.
  const frames = Math.floor(value);
  return frames > 0 ? frames : undefined;
}

/** Parses `location.search` (with or without the leading `?`). */
export function parseWaterLabQuery(search: string): WaterLabQuery {
  const query = new URLSearchParams(search);
  const numeric: Partial<WaterLabOptions> = {};
  for (const [parameter, option] of Object.entries(NUMERIC_PARAMETERS)) {
    const value = readOption(query, parameter, option);
    if (value !== undefined) numeric[option] = value;
  }
  const mode: WaterRenderMode = query.get("mode") === "reference" ? "reference" : "optimized";
  const view: WaterView = query.get("view") === "underwater" ? "underwater" : "surface";
  const scene: WaterScene = query.get("scene") === "shore" ? "shore" : "open";
  return Object.freeze({
    // `normalizeWaterLabOptions` fills in every default and re-clamps, so the
    // result is a complete, valid `WaterLabOptions` whatever the URL contained.
    options: normalizeWaterLabOptions({
      ...numeric,
      mode,
      view,
      scene,
      fixedTime: readNumber(query, "fixedTime"),
      frameLimit: readFrameLimit(query),
      benchmark: query.get("benchmark") === "1",
      cameraYaw: readNumber(query, "yaw"),
      cameraPitch: readNumber(query, "pitch"),
    }),
    showUi: query.get("ui") !== "0",
  });
}

#!/usr/bin/env node
// Pixel-for-pixel comparison against the source project's `/webgl2` page.
//
// Both pages are driven through the same URL contract and the same automation
// bridge, so the only thing that can differ is the renderer. `pixelmatch` runs
// at threshold 0: any non-zero mismatch is a regression, not a tolerance.
//
//   node scripts/compare-with-source.mjs \
//     --source=http://127.0.0.1:3200/webgl2 --target=http://127.0.0.1:4173
//
// The target server must already be running (`npm run preview`).

import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const argument = (name, fallback) => {
  const hit = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const sourceUrl = argument("source", "http://127.0.0.1:3200/webgl2");
const targetUrl = argument("target", "http://127.0.0.1:4173");
const outputDir = path.resolve(argument("out", path.join(import.meta.dirname, "..", "tmp", "parity")));

const VIEWPORT = { width: 1280, height: 800 };
/** How long the "metrics stopped moving" poll waits between samples. */
const STABLE_POLL_MS = 400;
const STABLE_TIMEOUT_MS = 30_000;

/** The three scenes the parity gate covers. */
const SCENES = [
  { name: "open-surface", query: "scene=open&view=surface&mode=optimized&fixedTime=8.25&frames=240&ui=0" },
  { name: "shore-surface", query: "scene=shore&view=surface&mode=optimized&fixedTime=8.25&frames=240&ui=0" },
  { name: "open-underwater", query: "scene=open&view=underwater&mode=optimized&fixedTime=8.25&frames=240&ui=0" },
];

/** Both pages expose a bridge; only the global's name differs. */
const BRIDGES = ["__WEBGPU_WATER_LAB__", "__WEBGL2_WATER_LAB__"];

/** The live bridge of whichever page this is. */
function readBridge(names) {
  for (const name of names) {
    const bridge = window[name];
    if (bridge?.ready === true) return bridge;
  }
  return null;
}

/**
 * Waits until `?frames=N` has stopped the render loop. Both pages freeze their
 * metrics the moment the last frame lands, so two identical snapshots taken
 * `STABLE_POLL_MS` apart mean "this page will not change again" — which is what
 * a pixel comparison needs, and what a fixed sleep cannot promise.
 */
async function waitForFrozenFrame(page) {
  const deadline = Date.now() + STABLE_TIMEOUT_MS;
  let previous = null;
  while (Date.now() < deadline) {
    const snapshot = await page.evaluate((names) => JSON.stringify(readBridge(names)?.getMetrics() ?? null), BRIDGES);
    if (previous !== null && snapshot === previous) return;
    previous = snapshot;
    await page.waitForTimeout(STABLE_POLL_MS);
  }
  throw new Error("渲染循环在超时前仍未停止，无法进行确定性比较（请确认 URL 里带了 frames=N）。");
}

async function capture(context, url, query, file, { blockModels = false } = {}) {
  const page = await context.newPage();
  await page.addInitScript(`window.readBridge = ${readBridge.toString()}`);
  const errors = [];
  // The blocked hull download is noise this script created itself; everything
  // else is a real failure and has to fail the run.
  const selfInflicted = (text) => blockModels && /Failed to load resource|ERR_FAILED/.test(text);
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (selfInflicted(message.text())) return;
    errors.push(message.text());
  });
  // The source demo also draws a glTF hull, which this project deliberately
  // does not contain. Refusing the download makes its engine skip the hull
  // (a missing asset is optional scenery there), so the two pages render the
  // same scene — sky, terrain and water — and nothing in the source repository
  // has to be touched to compare them.
  if (blockModels) await page.route("**/models/**", (route) => route.abort());
  await page.goto(`${url}?${query}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction((names) => {
    const bridge = readBridge(names);
    return bridge !== null && bridge.getMetrics()?.error === null;
  }, BRIDGES, { timeout: 60_000 });
  await waitForFrozenFrame(page);
  await page.screenshot({ path: file });
  await page.close();
  return errors;
}

const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--use-gl=angle"] });
let failures = 0;
try {
  await fs.mkdir(outputDir, { recursive: true });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  for (const scene of SCENES) {
    const sourceFile = path.join(outputDir, `${scene.name}-source.png`);
    const targetFile = path.join(outputDir, `${scene.name}-target.png`);
    const sourceErrors = await capture(context, sourceUrl, scene.query, sourceFile, { blockModels: true });
    const targetErrors = await capture(context, targetUrl, scene.query, targetFile);
    const a = PNG.sync.read(await fs.readFile(sourceFile));
    const b = PNG.sync.read(await fs.readFile(targetFile));
    if (a.width !== b.width || a.height !== b.height) {
      failures += 1;
      process.stdout.write(`${scene.name}: 尺寸不一致 ${a.width}×${a.height} vs ${b.width}×${b.height}\n`);
      continue;
    }
    const diff = new PNG({ width: a.width, height: a.height });
    const mismatch = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0 });
    let maxDelta = 0;
    for (let index = 0; index < a.data.length; index += 1) maxDelta = Math.max(maxDelta, Math.abs(a.data[index] - b.data[index]));
    if (mismatch > 0) {
      failures += 1;
      await fs.writeFile(path.join(outputDir, `${scene.name}-diff.png`), PNG.sync.write(diff));
    }
    const noise = [...sourceErrors, ...targetErrors];
    if (noise.length > 0) {
      failures += 1;
      process.stdout.write(`${scene.name}: 控制台/页面错误 ${JSON.stringify(noise)}\n`);
    }
    process.stdout.write(`${scene.name}: mismatch=${mismatch} maxΔ=${maxDelta} (${a.width}×${a.height})\n`);
  }
} finally {
  await browser.close();
}
process.exitCode = failures === 0 ? 0 : 1;

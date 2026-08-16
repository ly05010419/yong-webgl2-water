#!/usr/bin/env node
// Interaction regression: drive every bridge setter and a viewport resize, then
// assert the engine is still healthy and the page produced no console noise.
//
//   node scripts/interaction-smoke.mjs --target=http://127.0.0.1:4173

import { chromium } from "@playwright/test";

const argument = (name, fallback) => {
  const hit = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const targetUrl = argument("target", "http://127.0.0.1:4173");

/** `[method, argument]` pairs, run in order against the live bridge. */
const STEPS = [
  ["setScene", "shore"],
  ["setSimulationResolution", 128],
  ["setRenderScale", 0.75],
  ["setLongCascadeScale", 320],
  ["setMediumCascadeScale", 96],
  ["setMode", "reference"],
  ["setView", "underwater"],
  ["setScene", "open"],
  ["setSimulationResolution", 384],
  ["setRenderScale", 1.25],
  ["setLongCascadeScale", 120],
  ["setMediumCascadeScale", 32],
  ["setMode", "optimized"],
  ["setView", "surface"],
  ["setMeshResolution", 320],
  ["setWaveScale", 1.4],
  ["setDistantRoughness", 1.5],
  ["setDetailRange", 4],
  ["setSwellSmoothing", 0],
  ["setFogReach", 2],
  ["setScene", "shore"],
  ["setSimulationResolution", 256],
  ["setRenderScale", 1],
];

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 900, height: 620 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
];

const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--use-gl=angle"] });
const noise = [];
try {
  const context = await browser.newContext({ viewport: VIEWPORTS[0], deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("pageerror", (error) => noise.push(`pageerror: ${error}`));
  page.on("console", (message) => { if (message.type() === "error") noise.push(`console: ${message.text()}`); });
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => window.__WEBGL2_WATER_LAB__?.ready === true, null, { timeout: 60_000 });

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    for (const [method, value] of STEPS) {
      await page.evaluate(([name, argument]) => {
        const bridge = window.__WEBGL2_WATER_LAB__;
        if (!bridge) throw new Error("桥接对象缺失");
        bridge[name](argument);
      }, [method, value]);
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(200);
  }

  await page.evaluate(() => window.__WEBGL2_WATER_LAB__?.resetMetrics());
  await page.waitForTimeout(400);
  const metrics = await page.evaluate(() => window.__WEBGL2_WATER_LAB__?.getMetrics());
  if (!metrics) throw new Error("getMetrics() 返回空值");
  if (metrics.error !== null) throw new Error(`引擎报错：${metrics.error}`);
  if (metrics.ready !== true) throw new Error("引擎在交互后不再处于 ready 状态");
  process.stdout.write(`steps=${STEPS.length * VIEWPORTS.length} resizes=${VIEWPORTS.length} error=${metrics.error} ready=${metrics.ready} fps=${metrics.fps.toFixed(1)} adapter=${metrics.adapter}\n`);
} finally {
  await browser.close();
}
if (noise.length > 0) {
  process.stdout.write(`控制台/页面错误：\n${noise.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("无 console / pageerror 输出\n");
}

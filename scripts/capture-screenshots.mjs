#!/usr/bin/env node
// Documentation stills. Starts `vite preview` on a private port, drives the
// demo through its automation bridge and saves one panel shot plus one clean
// shot per view into `docs/screenshots/`.
//
//   npm run screenshots
//
// Every view pins `fixedTime` and `frames`, so the captures are reproducible:
// the render loop stops itself and the page freezes on a known frame.

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.WATER_SCREENSHOT_PORT || 4179);
const baseUrl = `http://127.0.0.1:${port}`;
const outputDir = path.join(repoRoot, "docs", "screenshots");

const VIEWS = [
  { name: "tethys-surface-optimized", query: "mode=optimized&view=surface&scene=open&fixedTime=18.25&frames=240" },
  { name: "tethys-underwater-optimized", query: "mode=optimized&view=underwater&scene=open&fixedTime=8.25&frames=240" },
  { name: "tethys-surface-reference", query: "mode=reference&view=surface&scene=open&fixedTime=18.25&frames=240" },
  { name: "tethys-island-shore", query: "mode=optimized&view=surface&scene=shore&fixedTime=18.25&frames=240" },
];

const server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], {
  cwd: repoRoot,
  stdio: "ignore",
});

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if ((await fetch(baseUrl)).ok) return; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("截图服务器启动超时");
}

let browser;
try {
  await waitForServer();
  await fs.mkdir(outputDir, { recursive: true });
  browser = await chromium.launch({ headless: true, args: ["--use-angle=metal", "--use-gl=angle"] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  for (const view of VIEWS) {
    const page = await context.newPage();
    await page.goto(`${baseUrl}/?${view.query}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(
      () => window.__WEBGL2_WATER_LAB__?.ready === true && window.__WEBGL2_WATER_LAB__.getMetrics()?.error === null,
      null,
      { timeout: 60_000 },
    );
    await page.waitForTimeout(6_000);
    await page.screenshot({ path: path.join(outputDir, `${view.name}.png`) });
    await page.addStyleTag({ content: "aside { display: none !important; }" });
    await page.screenshot({ path: path.join(outputDir, `${view.name}-clean.png`) });
    await page.close();
  }
  process.stdout.write(`已保存 ${VIEWS.length * 2} 张截图到 ${outputDir}\n`);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}

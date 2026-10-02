#!/usr/bin/env node
/**
 * tools/perf.mjs — real-time performance run.
 *
 *   node tools/perf.mjs [preset=core-perf] [--duration 10] [--w 1920] [--h 1080] [--vsync] [--timeout ms] [--out report.json]
 *
 * Loads ?shot=<preset>&perf=1 (real time, loop keeps running, scripted input loops via preset.inputLoop)
 * in GPU Chromium with vsync + frame-rate limit DISABLED (unless --vsync) so frame times reflect real
 * cost, lets it run for --duration seconds, and reports frame-time percentiles, CPU/GPU ms, draw calls
 * and triangles. Budget: p95 frame <= 16.6 ms (60 fps) at 1920x1080 on the RTX 5070.
 * Exit codes: 0 within budget | 1 error | 2 timeout | 3 no GPU | 5 over budget
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  parseArgs, startServer, launchBrowser, openPage, waitForReady, cleanupAll, buildUrl, printJson, isHardwareRenderer, log,
} from './lib/harness.mjs';

const BUDGET_P95_MS = 16.6;
const args = parseArgs(process.argv.slice(2));
const preset = args._[0] || 'core-perf';
const duration = Number(args.duration || 10);
const width = Number(args.w || 1920);
const height = Number(args.h || 1080);
const timeout = Number(args.timeout || 90000);
const started = Date.now();
const report = { ok: false, preset, width, height, durationS: duration, vsync: !!args.vsync };
let exitCode = 0;

try {
  const { url } = await startServer();
  const { browser, mode } = await launchBrowser({ width, height, uncapped: !args.vsync, headed: !!args.headed });
  report.browserMode = mode;
  const { page, diag } = await openPage(browser, { width, height });
  await page.goto(buildUrl(url, { shot: preset, perf: 1, w: width, h: height }), { timeout });
  try {
    await waitForReady(page, timeout);
  } catch (e) {
    if (/Timeout/i.test(e.message)) throw Object.assign(new Error(`timed out after ${timeout} ms`), { code: 2 });
    throw e;
  }
  log(`running ${preset} for ${duration}s ...`);
  await page.evaluate(() => window.__GAME__.resetPerf());
  await page.waitForTimeout(duration * 1000);
  const stats = await page.evaluate(() => window.__GAME__.perf());
  const systemErrors = await page.evaluate(() => window.__SYSTEM_ERRORS__ || []);
  Object.assign(report, {
    frames: stats.samples,
    frameMs: { avg: stats.avg, p50: stats.p50, p95: stats.p95, p99: stats.p99, max: stats.max },
    fps: stats.fps,
    cpuMs: { avg: stats.cpuAvg, p95: stats.cpuP95 },
    gpuMs: { avg: stats.gpuAvg, p95: stats.gpuP95 },
    drawCalls: stats.drawCalls,
    maxDrawCalls: stats.maxDrawCalls,
    triangles: stats.triangles,
    maxTriangles: stats.maxTriangles,
    geometries: stats.geometries,
    textures: stats.textures,
    programs: stats.programs,
    renderer: stats.renderer,
    gpuHardware: isHardwareRenderer(stats.renderer),
    budget: { p95Ms: BUDGET_P95_MS, pass: stats.p95 <= BUDGET_P95_MS },
    systemErrors,
    ...diag,
  });
  report.ok = true;
  if (!report.gpuHardware) exitCode = 3;
  else if (!report.budget.pass) exitCode = 5;
} catch (e) {
  report.error = e.message;
  exitCode = e.code === 2 ? 2 : 1;
  log('error:', e.message);
} finally {
  report.wallMs = Date.now() - started;
  await cleanupAll();
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(String(args.out))), { recursive: true });
    fs.writeFileSync(path.resolve(String(args.out)), JSON.stringify(report, null, 2));
  }
  printJson(report);
  process.exit(exitCode);
}

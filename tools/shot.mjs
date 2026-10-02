#!/usr/bin/env node
/**
 * tools/shot.mjs — deterministic screenshot harness.
 *
 *   node tools/shot.mjs <preset> [--out <png>] [--w 1920] [--h 1080] [--frames N]
 *                                [--sequence N --interval ms] [--timeout ms] [--seed N]
 *                                [--only a,b] [--faults sys:phase,...] [--debug] [--headed] [--allow-software] [--strict]
 *   node tools/shot.mjs --list
 *
 * Starts a PRIVATE Vite server on a free port (many agents can run this concurrently), launches
 * GPU-accelerated Chromium (verifies the WebGL renderer is a hardware GPU), loads ?shot=<preset>,
 * waits for window.__SHOT_READY__, saves PNG(s) and prints a JSON summary to stdout:
 *   { ok, preset, png, frames?, contactSheet?, renderer, browserMode, perf, consoleErrors, pageErrors,
 *     networkErrors, systemErrors, systems, durationMs }
 * Exit codes: 0 ok | 1 error | 2 timeout | 3 software renderer (no GPU) | 4 --strict and errors present
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  parseArgs, startServer, launchBrowser, openPage, waitForReady, cleanupAll, timestamp, ensureDir,
  buildUrl, printJson, SHOTS_DIR, isHardwareRenderer, log,
} from './lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const listMode = args.list === true || args._[0] === '--list';
const preset = args._[0];

if (!listMode && !preset) {
  console.error('usage: node tools/shot.mjs <preset|--list> [--out png] [--w 1920] [--h 1080] [--frames N] [--sequence N --interval ms] [--timeout ms]');
  process.exit(1);
}

const timeout = Number(args.timeout || 90000);
const started = Date.now();
const summary = { ok: false, preset: preset || null };
let exitCode = 0;

async function main() {
  const { url } = await startServer();
  const wArg = args.w ? Number(args.w) : null;
  const hArg = args.h ? Number(args.h) : null;
  const { browser, mode, renderer: probeRenderer } = await launchBrowser({ width: wArg || 1920, height: hArg || 1080, headed: !!args.headed });
  summary.browserMode = mode;
  const { page, diag } = await openPage(browser, { width: 1280, height: 720 });

  // 1) resolve preset list (validates the name, gives default resolution)
  await page.goto(buildUrl(url, { shot: '__list__' }));
  await waitForReady(page, timeout);
  const list = await page.evaluate(() => window.__SHOT_LIST__);
  if (listMode) {
    Object.assign(summary, { ok: true, ...list });
    delete summary.preset;
    return;
  }
  const entry = list.presets.find((p) => p.name === preset);
  if (!entry && !preset.includes(':')) {
    throw Object.assign(new Error(`unknown preset "${preset}". Available: ${list.presets.map((p) => p.name).join(', ')}`), { code: 1 });
  }
  const width = wArg || entry?.resolution?.[0] || 1920;
  const height = hArg || entry?.resolution?.[1] || 1080;
  for (const k of Object.keys(diag)) diag[k].length = 0;

  // 2) load the shot
  await page.setViewportSize({ width, height });
  const shotUrl = buildUrl(url, {
    shot: preset, w: width, h: height, warmup: args.frames, seed: args.seed, only: args.only, faults: args.faults, debug: args.debug ? 1 : undefined,
  });
  summary.url = shotUrl.replace(url, '');
  const tLoad = Date.now();
  try {
    await waitForReadyAfterGoto(page, shotUrl);
  } catch (e) {
    if (/Timeout/i.test(e.message)) {
      const tp = defaultOut('TIMEOUT');
      try { await page.screenshot({ path: tp }); summary.timeoutPng = tp; } catch { /* ignore */ }
      Object.assign(summary, await collect(page), diag);
      throw Object.assign(new Error(`timed out after ${timeout} ms waiting for __SHOT_READY__`), { code: 2 });
    }
    Object.assign(summary, await collect(page).catch(() => ({})), diag);
    throw e;
  }
  summary.readyMs = Date.now() - tLoad;

  // 3) capture
  const seqN = Number(args.sequence || 0);
  if (seqN > 1) {
    const interval = Number(args.interval || 100);
    const sheetPath = args.out ? path.resolve(String(args.out)) : defaultOut('sheet');
    const dir = ensureDir(sheetPath.replace(/\.png$/i, '') + '-frames');
    const frames = [];
    let simMs = 0;
    for (let i = 0; i < seqN; i++) {
      const fp = path.join(dir, `frame-${String(i).padStart(2, '0')}.png`);
      await page.screenshot({ path: fp });
      frames.push({ png: fp, tMs: Math.round(simMs) });
      if (i < seqN - 1) {
        const n = await page.evaluate((ms) => window.__GAME__.advanceMs(ms), interval);
        simMs += (n * 1000) / 60;
      }
    }
    await contactSheet(browser, frames, sheetPath, { width, height, preset, interval });
    summary.frames = frames;
    summary.contactSheet = sheetPath;
    summary.png = sheetPath;
  } else {
    const out = args.out ? path.resolve(String(args.out)) : defaultOut();
    ensureDir(path.dirname(out));
    await page.screenshot({ path: out });
    summary.png = out;
  }

  Object.assign(summary, await collect(page), diag);
  summary.renderer = summary.perf?.renderer || probeRenderer;
  summary.gpuHardware = isHardwareRenderer(summary.renderer);
  summary.ok = true;
  if (!summary.gpuHardware && !args['allow-software']) {
    summary.ok = false;
    summary.error = `software renderer "${summary.renderer}" (no GPU). Pass --allow-software to accept.`;
    exitCode = 3;
  } else if (args.strict && (summary.consoleErrors.length || summary.pageErrors.length || summary.systemErrors.length)) {
    exitCode = 4;
  }
}

async function waitForReadyAfterGoto(page, u) {
  await page.goto(u, { timeout });
  await waitForReady(page, timeout);
}

async function collect(page) {
  return page.evaluate(() => ({
    perf: window.__PERF__ || null,
    systemErrors: window.__SYSTEM_ERRORS__ || [],
    systems: window.__SHOT_INFO__?.systems || null,
    shotInfo: window.__SHOT_INFO__ ? { file: window.__SHOT_INFO__.file, t: window.__SHOT_INFO__.t, frame: window.__SHOT_INFO__.frame, seed: window.__SHOT_INFO__.seed } : null,
  }));
}

function defaultOut(suffix) {
  ensureDir(SHOTS_DIR);
  const safe = String(preset).replace(/[^a-z0-9_.-]+/gi, '_');
  return path.join(SHOTS_DIR, `${safe}-${timestamp()}${suffix ? '-' + suffix : ''}.png`);
}

/** Tile frames into one labelled PNG using a canvas in the browser. */
async function contactSheet(browser, frames, outPath, { width, height, preset: name, interval }) {
  const n = frames.length;
  const cols = n <= 4 ? n : n <= 9 ? 3 : 4;
  const rows = Math.ceil(n / cols);
  const maxW = 2560;
  const tileW = Math.min(width, Math.floor(maxW / cols));
  const tileH = Math.round((tileW * height) / width);
  const pad = 6;
  const header = 34;
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await ctx.newPage();
  try {
    const images = frames.map((f) => 'data:image/png;base64,' + fs.readFileSync(f.png).toString('base64'));
    const labels = frames.map((f, i) => `#${i}  t+${f.tMs}ms`);
    const dataUrl = await page.evaluate(async ({ images, labels, cols, rows, tileW, tileH, pad, header, title }) => {
      const c = document.createElement('canvas');
      c.width = cols * tileW + (cols + 1) * pad;
      c.height = header + rows * tileH + (rows + 1) * pad;
      const g = c.getContext('2d');
      g.fillStyle = '#111';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#eee';
      g.font = 'bold 18px sans-serif';
      g.fillText(title, pad + 4, 24);
      g.imageSmoothingQuality = 'high';
      for (let i = 0; i < images.length; i++) {
        const img = new Image();
        img.src = images[i];
        await img.decode();
        const x = pad + (i % cols) * (tileW + pad);
        const y = header + pad + Math.floor(i / cols) * (tileH + pad);
        g.drawImage(img, x, y, tileW, tileH);
        g.fillStyle = 'rgba(0,0,0,0.65)';
        g.fillRect(x, y, 150, 26);
        g.fillStyle = '#ffd24a';
        g.font = 'bold 15px monospace';
        g.fillText(labels[i], x + 6, y + 18);
      }
      return c.toDataURL('image/png');
    }, { images, labels, cols, rows, tileW, tileH, pad, header, title: `${name} — ${frames.length} frames @ ${interval}ms` });
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  } finally {
    await ctx.close();
  }
}

try {
  await main();
} catch (e) {
  summary.ok = false;
  summary.error = e.message;
  exitCode = e.code === 2 ? 2 : exitCode || 1;
  log('error:', e.message);
} finally {
  summary.durationMs = Date.now() - started;
  await cleanupAll();
  printJson(summary);
  process.exit(exitCode);
}

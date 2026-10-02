#!/usr/bin/env node
/**
 * Weapons bench: load ONE shot preset, then run many scripted steps against the live page and screenshot
 * each one (much faster than one tools/shot.mjs run per pose).
 *
 *   node tools/weapons/bench.mjs <scenario.mjs> [--w 1920 --h 1080] [--only a,b] [--dir shots/weapons/bench]
 *
 * scenario module:
 *   export default {
 *     preset: 'weapons-hip', only: 'materials,lighting,world,postfx,player,weapons',
 *     steps: [ { name: 'hip', fn: (arg) => { const w = __GAME__.ctx.services.weapons; ... }, arg: {...}, frames: 20 } ],
 *   }
 * `fn` runs in the page (must be self-contained). After it, `frames` fixed frames are simulated and a PNG is saved.
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  parseArgs, startServer, launchBrowser, openPage, waitForReady, cleanupAll, ensureDir, buildUrl, ROOT,
} from '../lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const scenPath = path.resolve(String(args._[0] || ''));
const scen = (await import(pathToFileURL(scenPath).href)).default;
const dir = ensureDir(path.resolve(ROOT, String(args.dir || 'shots/weapons/bench')));
const width = Number(args.w || scen.w || 1920), height = Number(args.h || scen.h || 1080);

try {
  const { url } = await startServer();
  const { browser } = await launchBrowser({ width, height });
  const { page, diag } = await openPage(browser, { width, height });
  const u = buildUrl(url, { shot: scen.preset, w: width, h: height, only: args.only || scen.only, warmup: scen.warmup });
  await page.goto(u, { timeout: 120000 });
  await waitForReady(page, 120000);
  const filter = args.filter ? String(args.filter) : null;
  const shots = [];
  for (const s of scen.steps) {
    if (filter && !s.name.includes(filter)) continue;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (s.fn) await page.evaluate(s.fn, s.arg ?? null);
        await page.evaluate((n) => window.__GAME__.advanceFrames(n), s.frames ?? 1);
        break;
      } catch (e) {
        console.log(`step ${s.name}: ${String(e.message).slice(0, 120)} -> reloading`);
        await page.goto(u, { timeout: 120000 });
        await waitForReady(page, 120000);
      }
    }
    if (s.fn2) await page.evaluate(s.fn2, s.arg ?? null);
    if (s.shot === false) continue;
    const out = path.join(dir, `${s.name}.png`);
    await page.screenshot({ path: out, clip: s.clip ? { x: s.clip[0], y: s.clip[1], width: s.clip[2], height: s.clip[3] } : undefined });
    shots.push({ png: out, label: s.name });
  }
  if (shots.length > 1 && !args.nosheet) {
    const sheet = path.join(dir, `_sheet-${path.basename(scenPath, '.mjs')}${args.filter ? '-' + args.filter : ''}.png`);
    await makeSheet(browser, shots, sheet, Number(args.cols || scen.cols || 0));
    console.log('sheet', sheet);
  } else for (const s of shots) console.log('shot', s.png);
  const errs = await page.evaluate(() => (window.__SYSTEM_ERRORS__ || []).map((e) => `${e.system}:${e.phase}: ${e.message || e.error}`));
  if (errs.length) console.log('systemErrors:', errs.join('\n  '));
  if (diag.consoleErrors.length) console.log('consoleErrors:', diag.consoleErrors.slice(0, 10).join('\n  '));
  if (diag.pageErrors.length) console.log('pageErrors:', diag.pageErrors.slice(0, 10).join('\n  '));
  const perf = await page.evaluate(() => window.__GAME__.perf());
  console.log('perf', JSON.stringify({ dc: perf?.drawCalls, tris: perf?.triangles }));
} catch (e) {
  console.log('BENCH ERROR', e?.stack || e);
} finally {
  await cleanupAll();
  process.exit(0);
}

async function makeSheet(browser, shots, outPath, colsArg) {
  const n = shots.length;
  const cols = colsArg || (n <= 4 ? 2 : n <= 9 ? 3 : 4);
  const rows = Math.ceil(n / cols);
  const tileW = Math.floor(2400 / cols), tileH = Math.round((tileW * height) / width);
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await ctx.newPage();
  const images = shots.map((f) => 'data:image/png;base64,' + fs.readFileSync(f.png).toString('base64'));
  const labels = shots.map((f) => f.label);
  const dataUrl = await page.evaluate(async ({ images, labels, cols, rows, tileW, tileH }) => {
    const pad = 4;
    const c = document.createElement('canvas');
    c.width = cols * tileW + (cols + 1) * pad; c.height = rows * tileH + (rows + 1) * pad;
    const g = c.getContext('2d');
    g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = 'high';
    for (let i = 0; i < images.length; i++) {
      const img = new Image(); img.src = images[i]; await img.decode();
      const x = pad + (i % cols) * (tileW + pad), y = pad + Math.floor(i / cols) * (tileH + pad);
      g.drawImage(img, x, y, tileW, tileH);
      g.fillStyle = 'rgba(0,0,0,0.65)'; g.fillRect(x, y, 16 + labels[i].length * 10, 24);
      g.fillStyle = '#ffd24a'; g.font = 'bold 16px monospace'; g.fillText(labels[i], x + 6, y + 17);
    }
    return c.toDataURL('image/png');
  }, { images, labels, cols, rows, tileW, tileH });
  fs.writeFileSync(outPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  await ctx.close();
}

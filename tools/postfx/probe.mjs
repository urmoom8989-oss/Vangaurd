#!/usr/bin/env node
/**
 * tools/postfx/probe.mjs <preset> <script.js> [--perf] [--w 1920 --h 1080]
 * Opens the game with ?shot=<preset> (optionally &perf=1), waits for readiness, then evaluates the
 * body of <script.js> as an async function in the page (it receives `G` = window.__GAME__) and prints
 * the returned JSON. Postfx debugging / timing aid. In the page, `await __probeShot(name)` saves a
 * screenshot to shots/postfx/<name>.png (use with G.advanceFrames(n) in paused shot mode).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, parseArgs, startServer, launchBrowser, openPage, waitForReady, cleanupAll, buildUrl, printJson,
} from '../lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const [preset, scriptPath] = args._;
const width = Number(args.w || 1920);
const height = Number(args.h || 1080);
let out = { ok: false };
try {
  const body = fs.readFileSync(scriptPath, 'utf8');
  const { url } = await startServer();
  const { browser } = await launchBrowser({ width, height, uncapped: !!args.perf });
  const { page, diag } = await openPage(browser, { width, height });
  const params = { shot: preset, w: width, h: height };
  if (args.perf) params.perf = 1;
  const shotDir = path.join(ROOT, 'shots', 'postfx');
  fs.mkdirSync(shotDir, { recursive: true });
  const taken = [];
  await page.exposeFunction('__probeShot', async (name) => {
    const file = path.join(shotDir, `${name}.png`);
    await page.screenshot({ path: file });
    taken.push(file);
    return file;
  });
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.error('[probe] navigated', f.url()); });
  page.on('console', (m) => { if (args.verbose) console.error('[page]', m.type(), m.text().slice(0, 300)); });
  await page.goto(buildUrl(url, params), { timeout: 120000 });
  // the dev server may full-reload the page while other agents edit files: retry on navigation
  let result;
  for (let attempt = 0; ; attempt++) {
    try {
      await waitForReady(page, 120000);
      taken.length = 0;
      result = await page.evaluate(`(async (G) => { ${body} })(window.__GAME__)`);
      break;
    } catch (e) {
      if (attempt >= 6 || !/destroyed|navigation|Target closed/i.test(String(e))) throw e;
      console.error('[probe] page reloaded, retrying');
      await page.waitForTimeout(500);
    }
  }
  out = { ok: true, result, shots: taken, errors: diag.consoleErrors?.slice(0, 5), systemErrors: await page.evaluate(() => window.__SYSTEM_ERRORS__ || []) };
} catch (e) {
  out.error = String(e?.stack || e);
} finally {
  await cleanupAll();
  printJson(out);
}

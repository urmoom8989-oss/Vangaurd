#!/usr/bin/env node
/** tools/audio/probe.mjs — boot the game (interactive) and evaluate an expression against services.audio. Debug helper.
 *   node tools/audio/probe.mjs "<js expression using A (services.audio) and G (ctx)>" [--only a,b] [--wait ms] */
import { parseArgs, startServer, launchBrowser, openPage, cleanupAll, printJson } from '../lib/harness.mjs';
const args = parseArgs(process.argv.slice(2));
const expr = args._[0] || 'A.stats()';
const out = {};
try {
  const { url } = await startServer();
  const { browser } = await launchBrowser({ width: 960, height: 540 });
  const { page, diag } = await openPage(browser, { width: 960, height: 540 });
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.error('[probe] navigated', f.url()); });
  page.on('console', (m) => { const t = m.text(); if (/vite|reload|audio/i.test(t)) console.error('[probe console]', t.slice(0, 300)); });
  page.on('crash', () => console.error('[probe] PAGE CRASH'));
  await page.goto(url + '/' + (args.only ? `?only=${args.only}` : ''), { timeout: 90000 });
  // the dev server may force one full reload shortly after boot (late dependency optimisation by other
  // systems); wait until every system is initialised AND no navigation happened for a while
  let navs = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++; });
  for (let tries = 0; tries < 6; tries++) {
    try {
      await page.waitForFunction(() => window.__GAME__?.systems && window.__GAME__.systems().every((s) => (s.status || s.state) !== 'created'), null, { timeout: 180000, polling: 500 });
      const n0 = navs;
      await page.waitForTimeout(8000);
      if (navs === n0) break;
    } catch (e) { if (!/destroyed|navigation/i.test(e.message)) throw e; }
  }
  await page.waitForTimeout(Number(args.wait || 2000));
  out.result = await page.evaluate(async (ex) => { const G = window.__GAME__.ctx; const A = G.services.audio; try { return await (0, eval)(`(async (A, G) => (${ex}))`)(A, G); } catch (e) { return 'ERR ' + e.stack; } }, expr);
  out.systemErrors = await page.evaluate(() => window.__SYSTEM_ERRORS__);
  out.consoleErrors = diag.consoleErrors; out.pageErrors = diag.pageErrors;
  out.audioWarnings = diag.consoleWarnings.filter((w) => /audio/i.test(w));
} catch (e) { out.error = e.message; }
await cleanupAll();
printJson(out);

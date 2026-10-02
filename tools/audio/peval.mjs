#!/usr/bin/env node
/** tools/audio/peval.mjs — evaluate async JS in the lightweight audio page (?shot=__audio__). A = services.audio.
 *   node tools/audio/peval.mjs "<expression>" */
import { parseArgs, startServer, launchBrowser, openPage, waitForReady, cleanupAll, buildUrl, printJson } from '../lib/harness.mjs';
const args = parseArgs(process.argv.slice(2));
const out = {};
try {
  const { url } = await startServer();
  const { browser } = await launchBrowser({ width: 800, height: 600 });
  const { page, diag } = await openPage(browser, { width: 800, height: 600 });
  await page.goto(buildUrl(url, { shot: '__audio__' }), { timeout: 90000 });
  await waitForReady(page, 90000);
  out.result = await page.evaluate(async (ex) => { const G = window.__GAME__.ctx; const A = G.services.audio; try { return await (0, eval)(`(async (A, G) => (${ex}))`)(A, G); } catch (e) { return 'ERR ' + e.stack; } }, args._[0]);
  out.pageErrors = diag.pageErrors;
} catch (e) { out.error = e.message; }
await cleanupAll();
printJson(out);

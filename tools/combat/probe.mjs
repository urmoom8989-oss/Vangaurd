#!/usr/bin/env node
/**
 * Debug probe (owner: combat): load a shot preset and evaluate a JS expression in the page.
 *   node tools/combat/probe.mjs <preset> "<expression using G (= __GAME__), ctx, THREE>" [--frames N]
 * The expression may be async (await allowed). Prints the JSON result.
 */
import { startServer, launchBrowser, openPage, waitForReady, buildUrl, parseArgs, cleanupAll, printJson } from '../lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const [preset, expr] = args._;

async function main() {
  const { url } = await startServer();
  const { browser } = await launchBrowser({ width: 960, height: 540 });
  const { page, diag } = await openPage(browser, { width: 960, height: 540 });
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.WebSocket = function (u, p) { return String(p || '').includes('vite') ? { readyState: 0, send() {}, close() {}, addEventListener() {}, removeEventListener() {} } : new Native(u, p); };
  });
  await page.goto(buildUrl(url, { shot: '__list__' }), { timeout: 120000 });
  await waitForReady(page, 90000);
  await page.goto(buildUrl(url, { shot: preset, w: 960, h: 540, warmup: args.frames }), { timeout: 120000 });
  await waitForReady(page, 90000);
  const out = await page.evaluate(async (src) => {
    const G = window.__GAME__; const ctx = G.ctx; const THREE = G.THREE;
    void G; void ctx; void THREE;
    // eslint-disable-next-line no-eval
    return await eval(`(async () => (${src}))()`);
  }, expr || 'null');
  printJson({ out, systemErrors: await page.evaluate(() => (window.__SYSTEM_ERRORS__ || []).map((e) => `${e.system}:${e.phase}`)), pageErrors: diag.pageErrors });
  await cleanupAll();
}
main().catch(async (e) => { console.error(e); await cleanupAll(); process.exit(2); });

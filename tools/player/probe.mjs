#!/usr/bin/env node
/**
 * tools/player/probe.mjs — load a shot preset and evaluate a JS snippet in the page (debug helper).
 *
 *   node tools/player/probe.mjs <preset> "<async js body using G (=__GAME__), ctx, S (=services)>" [--warmup N]
 *
 * The body runs as an async function; whatever it returns is printed as JSON.
 */
import {
  parseArgs, startServer, launchBrowser, openPage, waitForReady, cleanupAll, buildUrl,
} from '../lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const [preset, body] = args._;
if (!preset || !body) { console.error('usage: node tools/player/probe.mjs <preset> "<js>"'); process.exit(1); }

async function main() {
  const { url } = await startServer();
  const { browser } = await launchBrowser({ width: 960, height: 540 });
  const { page, diag } = await openPage(browser, { width: 960, height: 540 });
  await page.goto(buildUrl(url, { shot: preset, w: 960, h: 540, only: args.only, warmup: args.warmup }));
  await waitForReady(page, 120000);
  const out = await page.evaluate(async (src) => {
    const G = window.__GAME__;
    const ctx = G.ctx;
    const S = ctx.services;
    // eslint-disable-next-line no-new-func
    const fn = new Function('G', 'ctx', 'S', `return (async () => { ${src} })();`);
    const r = await fn(G, ctx, S);
    return JSON.parse(JSON.stringify(r ?? null, (k, v) => (v && v.isVector3 ? [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)] : v)));
  }, body);
  console.log(JSON.stringify(out, null, 1));
  const sysErr = await page.evaluate(() => window.__SYSTEM_ERRORS__ || []);
  if (sysErr.length) console.log('SYSTEM ERRORS', JSON.stringify(sysErr).slice(0, 2000));
  if (diag.pageErrors.length) console.log('PAGE ERRORS', diag.pageErrors.slice(0, 5));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => cleanupAll().then(() => process.exit()));

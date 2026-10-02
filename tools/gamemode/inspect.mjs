#!/usr/bin/env node
/**
 * tools/gamemode/inspect.mjs — load a shot preset and print services.gamemode state (+ optional JS).
 *   node tools/gamemode/inspect.mjs gamemode-wave-live [--frames 60] [--eval "expr"]
 */
import { startServer, launchBrowser, openPage, waitForReady, buildUrl, parseArgs, cleanupAll } from '../lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const preset = args._[0] || 'gamemode-wave-live';
const { url } = await startServer();
const { browser } = await launchBrowser({ width: 960, height: 540 });
const { page, diag } = await openPage(browser, { width: 960, height: 540 });
await page.goto(buildUrl(url, { shot: preset, w: 960, h: 540 }));
await waitForReady(page, 120000);
if (args.frames) await page.evaluate((n) => window.__GAME__.advanceFrames(n), Number(args.frames));
const out = await page.evaluate((expr) => {
  const g = window.__GAME__;
  const s = g.ctx.services;
  const st = s.gamemode.state;
  const res = { state: JSON.parse(JSON.stringify(st, (k, v) => (v === Infinity ? 'Inf' : v))), flow: { stage: s.gamemode.flow?.stage, stageT: s.gamemode.flow?.stageT }, ai: s.ai.count?.(), hudMenu: s.hud.menu, systems: g.systems().map((x) => `${x.name}:${x.status}`).join(' ') };
  if (expr) { try { res.eval = eval(expr); } catch (e) { res.eval = 'ERR ' + e.message; } }
  return res;
}, args.eval || null);
console.log(JSON.stringify(out, null, 2));
console.log('systemErrors:', JSON.stringify(await page.evaluate(() => (window.__SYSTEM_ERRORS__ || []).map((e) => `${e.system}:${e.phase}:${String(e.message).slice(0, 160)}`))));
console.log('pageErrors:', diag.pageErrors);
await cleanupAll();
process.exit(0);

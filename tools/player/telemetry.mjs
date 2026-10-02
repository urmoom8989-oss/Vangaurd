#!/usr/bin/env node
/**
 * tools/player/telemetry.mjs — frame-by-frame movement telemetry for a shot preset.
 *
 *   node tools/player/telemetry.mjs <preset> [--frames 120] [--every 1] [--only a,b] [--json out.json]
 *
 * Loads the preset through the normal shot harness (deterministic), then advances one frame at a
 * time and samples services.player.state + motor internals. Prints a compact table and all
 * player:* events (with the frame they fired on). Used to tune acceleration curves, slide distance,
 * mantle timing, landing impact, footstep cadence etc. without eyeballing screenshots.
 */
import fs from 'node:fs';
import {
  parseArgs, startServer, launchBrowser, openPage, waitForReady, cleanupAll, buildUrl, printJson,
} from '../lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const preset = args._[0];
if (!preset) { console.error('usage: node tools/player/telemetry.mjs <preset> [--frames N] [--every k]'); process.exit(1); }
const frames = Number(args.frames || 120);
const every = Number(args.every || 1);

async function main() {
  const { url } = await startServer();
  const { browser } = await launchBrowser({ width: 640, height: 360 });
  const { page, diag } = await openPage(browser, { width: 640, height: 360 });
  await page.goto(buildUrl(url, { shot: preset, w: 640, h: 360, only: args.only, warmup: args.warmup ?? 0 }));
  await waitForReady(page, 90000);
  const out = await page.evaluate(async ({ frames, every }) => {
    const G = window.__GAME__;
    const ctx = G.ctx;
    const ev = [];
    const names = ['player:footstep', 'player:jump', 'player:land', 'player:stance', 'player:slide', 'player:mantle', 'player:tacsprint', 'player:damaged', 'player:died', 'player:regen'];
    for (const n of names) ctx.events.on(n, (e) => ev.push({ f: ctx.time.frame, n, e: JSON.parse(JSON.stringify(e, (k, v) => (v && v.isVector3 ? [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)] : (k === 'info' ? undefined : v)))) }));
    const rows = [];
    const r2 = (v) => Math.round(v * 100) / 100;
    for (let i = 0; i < frames; i++) {
      await G.advanceFrames(1);
      if (i % every) continue;
      const s = ctx.services.player.state;
      const m = ctx.services.player.motor;
      rows.push({
        f: ctx.time.frame, mode: m?.mode, st: s.stance, g: s.grounded ? 1 : 0,
        x: r2(s.position.x), y: r2(s.position.y), z: r2(s.position.z),
        spd: r2(s.speed), vy: r2(s.velocity.y), spr: s.sprinting ? (s.tacSprinting ? 'T' : 'S') : '-',
        eye: r2(s.eyeHeight), camY: r2(ctx.camera.position.y), fov: r2(s.fov),
        pitch: r2(ctx.camera.rotation.x * 57.3), roll: r2(ctx.camera.rotation.z * 57.3), hp: r2(s.health),
      });
    }
    return { rows, ev };
  }, { frames, every });
  const cols = Object.keys(out.rows[0] || {});
  console.log(cols.map((c) => c.padStart(6)).join(''));
  for (const r of out.rows) console.log(cols.map((c) => String(r[c]).padStart(6)).join(''));
  for (const e of out.ev) console.log(`#${e.f} ${e.n} ${JSON.stringify(e.e)}`);
  if (diag.pageErrors.length || diag.consoleErrors.length) console.log('ERRORS', diag.pageErrors, diag.consoleErrors.slice(0, 5));
  const sysErr = await page.evaluate(() => window.__SYSTEM_ERRORS__ || []);
  if (sysErr.length) console.log('SYSTEM ERRORS', JSON.stringify(sysErr, null, 1).slice(0, 3000));
  if (args.json) fs.writeFileSync(String(args.json), JSON.stringify(out, null, 1));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => cleanupAll().then(() => process.exit()));
void printJson;

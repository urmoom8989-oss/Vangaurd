#!/usr/bin/env node
/**
 * tools/player/stress.mjs — drive the player around the REAL level with pseudo-random input and check
 * collision invariants (complements sim.mjs, which uses a private test world).
 *
 *   node tools/player/stress.mjs [--frames 3600] [--seed 7] [--preset player-crouch-prone]
 *
 * Every frame: random-ish walk/sprint/tac/strafe/turn, occasional jump / crouch / prone / slide.
 * Checks: capsule penetration at rest (> 3 cm), fall-through (feet below ground under them by > 0.3 m),
 * camera teleports (eye moves > 0.9 m in one frame without a respawn), NaNs, stuck-in-air (> 4 s),
 * and reports mantle / slide / jump / land counts.
 */
import {
  parseArgs, startServer, launchBrowser, openPage, waitForReady, cleanupAll, buildUrl,
} from '../lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const frames = Number(args.frames || 3600);
const seed = Number(args.seed || 7);
const preset = args.preset || 'player-crouch-prone';

async function main() {
  const { url } = await startServer();
  const { browser } = await launchBrowser({ width: 480, height: 270 });
  const { page, diag } = await openPage(browser, { width: 480, height: 270 });
  await page.goto(buildUrl(url, { shot: preset, w: 480, h: 270, only: 'materials,lighting,world,player', warmup: 0 }));
  await waitForReady(page, 120000);
  const out = await page.evaluate(async ({ frames, seed }) => {
    const G = window.__GAME__;
    const ctx = G.ctx;
    const S = ctx.services;
    const P = S.player;
    const st = P.state;
    const input = ctx.input;
    const T = G.THREE;
    let s = seed >>> 0;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    const counts = { jump: 0, land: 0, mantle: 0, vault: 0, slide: 0, footstep: 0, respawn: 0, damaged: 0 };
    ctx.events.on('player:jump', () => counts.jump++);
    ctx.events.on('player:land', () => counts.land++);
    ctx.events.on('player:mantle', (e) => { if (e.phase === 'start') (e.vault ? counts.vault++ : counts.mantle++); });
    ctx.events.on('player:slide', (e) => { if (e.phase === 'start') counts.slide++; });
    ctx.events.on('player:footstep', () => counts.footstep++);
    ctx.events.on('player:respawn', () => counts.respawn++);
    ctx.events.on('player:damaged', () => counts.damaged++);
    P.setInvulnerable(true);
    const issues = [];
    const cap = { start: new T.Vector3(), end: new T.Vector3(), radius: 0.33 };
    const prevEye = new T.Vector3().copy(st.eye);
    let air = 0;
    let mx = 0, my = 1, turn = 0;
    let lastRespawn = counts.respawn;
    const pts = [];
    for (let f = 0; f < frames; f++) {
      // re-plan every ~0.5-2 s
      if (f % 45 === 0) {
        const r = rnd();
        my = r < 0.7 ? 1 : r < 0.85 ? -1 : 0;
        mx = rnd() < 0.3 ? (rnd() < 0.5 ? -1 : 1) : 0;
        turn = (rnd() - 0.5) * 18;
        if (rnd() < 0.5) { input.inject('sprint', true); }
        if (rnd() < 0.25) { input.inject('sprint', true); }
      } else if (f % 45 === 1 || f % 45 === 3) input.inject('sprint', false);
      else if (f % 45 === 2 && rnd() < 0.3) input.inject('sprint', true);
      if (f % 45 === 20) {
        const r = rnd();
        if (r < 0.3) input.inject('jump', true);
        else if (r < 0.45) input.inject('crouch', true);
        else if (r < 0.5) input.inject('prone', true);
      } else if (f % 45 === 21) { input.inject('jump', false); input.inject('crouch', false); input.inject('prone', false); }
      if (f % 45 === 30 && st.stance !== 'stand') { input.inject('jump', true); }
      if (f % 45 === 31) input.inject('jump', false);
      if (f % 600 === 599) { // relocate to a random nav point every 10 s
        const p = S.world.nav.randomPoint(new T.Vector3());
        P.teleport(p, rnd() * Math.PI * 2, 0);
      }
      input.injectMove(mx, my);
      input.injectLook(turn, 0);
      await G.advanceFrames(1);
      const p = st.position;
      if (!Number.isFinite(p.x + p.y + p.z + st.eye.y)) { issues.push({ f, kind: 'nan' }); break; }
      // penetration (ignore mantles: kinematic)
      if (!st.mantling) {
        const h = st.stance === 'prone' ? 0.66 : st.stance === 'crouch' || st.sliding ? 1.2 : 1.8;
        cap.start.set(p.x, p.y + 0.35, p.z); cap.end.set(p.x, p.y + Math.max(0.36, h - 0.35), p.z);
        const c = S.world.collideCapsule(cap);
        if (c && c.depth > 0.03) issues.push({ f, kind: 'penetration', depth: +c.depth.toFixed(3), n: [+c.normal.x.toFixed(2), +c.normal.y.toFixed(2), +c.normal.z.toFixed(2)], p: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)], stance: st.stance });
      }
      const gy = S.world.groundHeight(p.x, p.z, p.y + 0.5);
      if (st.grounded && gy - p.y > 0.3) issues.push({ f, kind: 'below-ground', dy: +(gy - p.y).toFixed(2), p: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)] });
      const jumpDist = st.eye.distanceTo(prevEye);
      if (jumpDist > 0.9 && counts.respawn === lastRespawn && f % 600 !== 599) issues.push({ f, kind: 'camera-teleport', d: +jumpDist.toFixed(2) });
      lastRespawn = counts.respawn;
      prevEye.copy(st.eye);
      air = st.grounded || st.mantling ? 0 : air + 1;
      if (air === 240) issues.push({ f, kind: 'long-air', p: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)] });
      if (f % 300 === 0) pts.push([+p.x.toFixed(1), +p.y.toFixed(2), +p.z.toFixed(1)]);
    }
    const kinds = {};
    for (const i of issues) kinds[i.kind] = (kinds[i.kind] || 0) + 1;
    return { counts, kinds, issues: issues.slice(0, 25), path: pts };
  }, { frames, seed });
  console.log(JSON.stringify(out, null, 1));
  const sysErr = await page.evaluate(() => window.__SYSTEM_ERRORS__ || []);
  if (sysErr.length) console.log('SYSTEM ERRORS', JSON.stringify(sysErr).slice(0, 2000));
  if (diag.pageErrors.length) console.log('PAGE ERRORS', diag.pageErrors.slice(0, 5));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => cleanupAll().then(() => process.exit()));

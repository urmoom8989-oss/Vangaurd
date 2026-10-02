#!/usr/bin/env node
/**
 * tools/gamemode/playtest.mjs — scripted end-to-end playtest of "Hold Vardanek" through Playwright.
 *
 *   node tools/gamemode/playtest.mjs [--minutes 3] [--w 960 --h 540] [--mock-ai auto|on|off] [--shots] [--seed N]
 *
 * Boots the full game in deterministic shot mode (preset `gamemode-playtest`, which starts at the main menu with the
 * complete flow live), then drives it like a player: clicks DEPLOY in whichever main menu is showing (hud-owned or
 * gamemode fallback), rides the intro/warmup, fights waves with an input-injected aim assist (input.injectLook +
 * input.inject('fire')), holds INTERACT to skip an intermission, pauses/resumes, dies and redeploys, gets overrun,
 * checks the end-of-game summary and clicks RESTART. Sim time advances via __GAME__.advanceFrames (1/60 s steps).
 *
 * If services.ai.spawn() returns null (AI system not ready), a test-only mock AI is injected into the page:
 * hitbox dummies registered with the REAL combat system that walk toward the plaza, so the kill → score → wave-clear
 * chain is still exercised end to end (--mock-ai off disables it; the wave-clear-without-AI fallback is then tested).
 *
 * Output: a JSON report on stdout ({ok, checks[], stats, simSeconds, ...}); exit 0 when every check passed, 1 otherwise.
 * --shots writes milestone PNGs to shots/gamemode/playtest/.
 */
import path from 'node:path';
import { startServer, launchBrowser, openPage, waitForReady, buildUrl, parseArgs, cleanupAll, ensureDir, ROOT, log } from '../lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const W = Number(args.w || 960);
const H = Number(args.h || 540);
const MINUTES = Number(args.minutes || 3);
const MOCK = String(args['mock-ai'] || 'auto');
const SHOTS = !!args.shots;
const outDir = ensureDir(path.join(ROOT, 'shots', 'gamemode', 'playtest'));

const checks = [];
const t0 = Date.now();
function check(name, pass, detail = '') {
  checks.push({ name, pass: !!pass, detail: String(detail) });
  console.error(`[playtest] ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

const { url } = await startServer();
const { browser, renderer } = await launchBrowser({ width: W, height: H });
const { page, diag } = await openPage(browser, { width: W, height: H });
// Long runs: keep Vite's HMR client from reloading the page if its websocket drops (test-only; no HMR needed here).
let navigations = 0;
try { await page.routeWebSocket(/.*/, () => { /* mock socket: accept and stay silent */ }); } catch (e) { log('routeWebSocket unavailable: ' + e.message); }
page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });
await page.goto(buildUrl(url, { shot: 'gamemode-playtest', w: W, h: H, seed: args.seed }));
await waitForReady(page, 180000);

let simFrames = 0;
const adv = async (n) => { await page.evaluate((k) => window.__GAME__.advanceFrames(k), n); simFrames += n; };
const snap = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(outDir, `${name}.png`) }); };
const gm = () => page.evaluate(() => {
  const s = window.__GAME__.ctx.services;
  const st = s.gamemode.state;
  const f = s.gamemode.flow;
  return {
    stage: st.stage, phase: st.phase, paused: st.paused, wave: st.wave, score: st.score.friendly, kills: st.kills,
    headshots: st.headshots, lives: st.lives, deaths: st.deaths, remaining: st.enemiesRemaining, alive: st.enemiesAlive,
    total: st.enemiesTotal, streak: st.streak, bestStreak: st.bestStreak, stageT: f?.stageT, countdown: f?.countdown,
    playerAlive: s.player.state.alive, health: s.player.state.health, aiCount: s.ai.count?.() ?? 0,
    hudMenu: s.hud.menu ?? null, ext: !!f?.ext,
  };
});

// ------------------------------------------------------------------ page helpers (aim assist, mock AI, click-by-text)
await page.evaluate((mockMode) => {
  const G = window.__GAME__;
  const { ctx, THREE } = G;
  const S = ctx.services;
  const T = (window.__PT = { log: [], resupplies: 0, kills: 0, events: {} });
  for (const ev of ['gamemode:wave', 'gamemode:kill', 'gamemode:streak', 'gamemode:medal', 'gamemode:resupply', 'gamemode:stage', 'gamemode:phase', 'gamemode:death', 'gamemode:end', 'gamemode:respawn', 'combat:kill', 'ai:spawn', 'ai:death']) {
    T.events[ev] = 0;
    ctx.events.on(ev, (e) => {
      T.events[ev]++;
      if (ev === 'gamemode:stage') T.log.push(`${ctx.time.t.toFixed(1)}s stage ${e.prev}→${e.stage}`);
      if (ev === 'gamemode:wave') T.log.push(`${ctx.time.t.toFixed(1)}s wave ${e.wave} ${e.phase} (${e.total})`);
    });
  }

  // ---- mock AI (test harness only): used when the real AI can't spawn
  const probe = (() => { try { return S.ai.spawn.length >= 0 && S.ai.spawn({ position: new THREE.Vector3(0, -500, 0), yaw: 0, behavior: { probe: true } }); } catch { return null; } })();
  if (probe) { try { probe.object?.parent?.remove(probe.object); } catch { /* ignore */ } S.ai.killAll?.(); }
  T.realAI = !!probe;
  T.mock = mockMode === 'on' || (mockMode === 'auto' && !probe);
  if (T.mock) {
    const agents = [];
    const mats = { body: new THREE.MeshStandardMaterial({ color: 0x3a3f33 }), head: new THREE.MeshStandardMaterial({ color: 0x8a1b16 }) };
    const bodyGeo = new THREE.BoxGeometry(0.55, 1.35, 0.32);
    const headGeo = new THREE.BoxGeometry(0.26, 0.28, 0.26);
    let nextId = 1;
    const ai = S.ai;
    ai.agents = agents;
    ai.spawn = ({ position, yaw = 0 } = {}) => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, mats.body);
      body.position.y = 0.72; body.userData.zone = 'torso';
      const head = new THREE.Mesh(headGeo, mats.head);
      head.position.y = 1.58; head.userData.zone = 'head';
      g.add(body, head);
      g.position.copy(position);
      g.rotation.y = yaw;
      ctx.scene.add(g);
      g.updateMatrixWorld(true);
      const agent = { id: nextId++, object: g, position: g.position, alive: true, state: 'advance', team: 'enemy', loadout: 'rifle' };
      agent.d = S.combat.registerDamageable({
        object: g, health: 100, team: 'enemy',
        onDeath: (info) => {
          agent.alive = false; agent.state = 'dead';
          ctx.scene.remove(g);
          ctx.events.emit('ai:death', { agent, info });
        },
      });
      agents.push(agent);
      ctx.events.emit('ai:spawn', { agent });
      return agent;
    };
    ai.count = () => agents.filter((a) => a.alive).length;
    ai.killAll = () => { for (const a of agents) if (a.alive) S.combat.applyDamage(a.d, 1e6, { source: 'script', zone: 'torso' }); agents.length = 0; };
    ai.setEnabled = (b) => { T.mockEnabled = b; };
    T.mockEnabled = true;
    const tmp = new THREE.Vector3();
    T.moveMock = (dt) => {
      if (!T.mockEnabled) return;
      const obj = new THREE.Vector3(0, 0, 0);
      const pz = S.world.zones?.plaza;
      if (pz) pz.getCenter(obj);
      for (const a of agents) {
        if (!a.alive) continue;
        tmp.set(obj.x - a.position.x, 0, obj.z - a.position.z);
        const d = tmp.length();
        if (d > 14) {
          tmp.multiplyScalar(Math.min(d - 14, 4.5 * dt) / d);
          a.position.add(tmp);
          try { a.position.y = S.world.groundHeight(a.position.x, a.position.z, a.position.y + 2); } catch { /* ignore */ }
          a.object.updateMatrixWorld(true);
        }
      }
    };
  }

  // ---- aim assist: steer the view with injected mouse counts, fire when on target with line of sight
  const eye = new THREE.Vector3();
  const tgt = new THREE.Vector3();
  const dir = new THREE.Vector3();
  let firing = false;
  let burst = 0;
  T.aim = (frames) => {
    const P = S.player.state;
    if (!P.alive) { if (firing) { ctx.input.inject('fire', false); firing = false; } return { target: false }; }
    eye.copy(P.eye);
    let best = null;
    let bestD = 1e9;
    let bestLos = false;
    for (const a of S.ai.agents || []) {
      if (!a.alive || !a.object) continue;
      let head = null;
      a.object.traverse((o) => { if (!head && o.userData?.zone === 'head') head = o; });
      if (head) head.getWorldPosition(tgt); else tgt.copy(a.position).setY(a.position.y + 1.5);
      dir.subVectors(tgt, eye);
      const d = dir.length();
      dir.multiplyScalar(1 / d);
      const hit = S.world.raycast(eye, dir, d);
      const los = !hit || hit.distance > d - 0.4;
      const score = d - (los ? 1000 : 0);
      if (score < bestD) { bestD = score; best = tgt.clone(); bestLos = los; }
    }
    if (!best) { if (firing) { ctx.input.inject('fire', false); firing = false; } return { target: false }; }
    dir.subVectors(best, eye);
    const wantYaw = Math.atan2(-dir.x, -dir.z);
    const wantPitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z));
    let dy = wantYaw - P.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    const dp = wantPitch - P.pitch;
    const sens = 0.022 * ctx.settings.data.controls.sensitivity * Math.PI / 180;
    const k = 0.6; // converge over a few steps (the player camera may smooth input)
    ctx.input.injectLook((-dy / sens) * k, (-dp / sens) * k);
    const onTarget = Math.abs(dy) < 0.03 && Math.abs(dp) < 0.03;
    const ws = S.weapons.state;
    if (ws && ws.ammo === 0 && !ws.reloading) { ctx.input.inject('fire', false); firing = false; ctx.input.inject('reload', true); setTimeout(() => ctx.input.inject('reload', false), 0); }
    burst += frames;
    const want = bestLos && onTarget && burst % 40 < 24;
    if (want !== firing) { ctx.input.inject('fire', want); firing = want; }
    return { target: true, los: bestLos, onTarget, dist: Math.round(bestD + (bestLos ? 1000 : 0)) };
  };
  T.stopFire = () => { ctx.input.inject('fire', false); firing = false; };
  /** Assisted kill (keeps long runs moving when the aim assist has no line of sight). */
  T.assistKill = (zone = 'head') => {
    for (const a of S.ai.agents || []) {
      if (!a.alive) continue;
      const d = (S.combat.damageables || []).find((x) => x.alive && (x.object === a.object || a.object?.getObjectById?.(x.object?.id)));
      if (d) { S.combat.applyDamage(d, 1e6, { source: 'player', weaponId: 'rifle', zone }); return true; }
    }
    return false;
  };
  /** Bounding box of the first visible element (in #ui) whose own text matches. */
  T.findText = (re) => {
    const rx = new RegExp(re, 'i');
    const els = Array.from(document.querySelectorAll('#ui *'));
    for (const el of els) {
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
      if (!own || !rx.test(own)) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden') continue;
      let p = el; let vis = true;
      while (p && p !== document.body) { const c = getComputedStyle(p); if (c.display === 'none' || Number(c.opacity) === 0) { vis = false; break; } p = p.parentElement; }
      if (!vis) continue;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: own };
    }
    return null;
  };
}, MOCK);

async function clickText(re) {
  const b = await page.evaluate((r) => window.__PT.findText(r), re);
  if (!b) return null;
  await page.mouse.click(b.x, b.y);
  return b.text;
}
async function step(frames) {
  await page.evaluate((f) => { window.__PT.moveMock?.(f / 60); return window.__PT.aim(f); }, frames);
  await adv(frames);
}
async function runUntil(pred, maxFrames, { fight = true, chunk = 4, assistAfter = 0 } = {}) {
  let waited = 0;
  let sinceAssist = 0;
  while (waited < maxFrames) {
    const g = await gm();
    if (pred(g)) return g;
    if (fight) await step(chunk); else await adv(chunk);
    waited += chunk;
    sinceAssist += chunk;
    if (assistAfter && sinceAssist >= assistAfter) { sinceAssist = 0; await page.evaluate(() => window.__PT.assistKill('head')); }
  }
  return gm();
}

const info0 = await page.evaluate(() => ({ realAI: window.__PT.realAI, mock: window.__PT.mock }));
log(`AI: ${info0.realAI ? 'real' : 'unavailable'}; mock AI ${info0.mock ? 'ON' : 'off'}`);

// ------------------------------------------------------------------ 1. main menu → deploy
let g = await gm();
check('boots to main menu', g.stage === 'menu', `stage=${g.stage} hudMenu=${g.hudMenu}`);
await adv(30);
await snap('01-menu');
const clicked = await clickText('^deploy');
check('DEPLOY button found and clicked', !!clicked, clicked || 'no visible "Deploy" in #ui');
await adv(2);
g = await runUntil((x) => x.stage === 'warmup', 120, { fight: false });
check('deploy → warmup (mission intro)', g.stage === 'warmup', `stage=${g.stage}`);
await adv(330);
await snap('02-intro');
g = await gm();
check('objective set / intro running', g.stage === 'warmup' && g.countdown > 0, `countdown=${g.countdown?.toFixed(1)}`);

// ------------------------------------------------------------------ 2. warmup → wave 1 live
g = await runUntil((x) => x.stage === 'live', 60 * 30, { fight: false, chunk: 30 });
check('warmup countdown → wave 1 live', g.stage === 'live' && g.wave === 1, `wave=${g.wave} total=${g.total}`);
g = await runUntil((x) => x.aiCount > 0 || x.stage !== 'live', 60 * 8, { fight: false, chunk: 10 });
const spawnedW1 = await page.evaluate(() => window.__PT.events['ai:spawn']);
check('wave 1 hostiles spawned via services.ai.spawn', spawnedW1 > 0 || !info0.mock && !info0.realAI, `ai:spawn=${spawnedW1} alive=${g.aiCount}`);
await snap('03-wave1');

// ------------------------------------------------------------------ 3. fight wave 1 (aim assist; assisted kills only if stalled)
g = await runUntil((x) => x.stage !== 'live', 60 * 90, { chunk: 4, assistAfter: 60 * 12 });
const killsW1 = (await gm()).kills;
check('wave 1 cleared → intermission', g.stage === 'intermission', `stage=${g.stage} kills=${killsW1} score=${g.score}`);
check('kills counted + scored', killsW1 > 0 ? g.score >= killsW1 * 100 : !info0.mock && !info0.realAI, `kills=${killsW1} score=${g.score}`);
const ev1 = await page.evaluate(() => ({ ...window.__PT.events }));
check('ammo resupply at intermission', ev1['gamemode:resupply'] >= 2, `resupply events=${ev1['gamemode:resupply']}`);
await adv(60);
await snap('04-intermission');

// ------------------------------------------------------------------ 4. skip intermission by holding INTERACT
await page.evaluate(() => window.__GAME__.ctx.input.inject('interact', true));
g = await runUntil((x) => x.stage === 'live', 60 * 3, { fight: false, chunk: 6 });
await page.evaluate(() => window.__GAME__.ctx.input.inject('interact', false));
check('hold INTERACT skips intermission → wave 2', g.stage === 'live' && g.wave === 2, `stage=${g.stage} wave=${g.wave}`);

// ------------------------------------------------------------------ 5. headshot bonus via a scripted kill
g = await runUntil((x) => x.aiCount > 0, 60 * 10, { fight: false, chunk: 10 });
const before = await gm();
const hs = await page.evaluate(() => window.__PT.assistKill('head'));
await adv(2);
const after = await gm();
check('headshot kill scores kill + headshot bonus', !hs || (after.headshots === before.headshots + 1 && after.score - before.score >= 150), `Δscore=${after.score - before.score} headshots=${after.headshots}`);

// ------------------------------------------------------------------ 6. pause freezes the flow; resume continues
await page.evaluate(() => window.__GAME__.ctx.services.gamemode.pause());
const p0 = await gm();
await adv(90);
const p1 = await gm();
check('pause freezes wave logic', p1.paused && Math.abs(p1.stageT - p0.stageT) < 1e-6, `paused=${p1.paused} ΔstageT=${(p1.stageT - p0.stageT).toFixed(3)}`);
await snap('05-pause');
await page.evaluate(() => window.__GAME__.ctx.services.gamemode.resume());
await adv(30);
const p2 = await gm();
check('resume continues', !p2.paused && p2.stageT > p1.stageT, `paused=${p2.paused}`);

// ------------------------------------------------------------------ 7. death → death screen → redeploy (reinforcement used)
const livesBefore = p2.lives;
await page.evaluate(() => { const P = window.__GAME__.ctx.services.player; (P.kill ? P.kill({ source: 'script' }) : P.damage(9999, { source: 'script' })); });
await adv(70);
g = await gm();
check('player death → dead stage', g.stage === 'dead' && !g.playerAlive, `stage=${g.stage} alive=${g.playerAlive}`);
await snap('06-death');
g = await runUntil((x) => x.stage !== 'dead', 60 * 9, { fight: false, chunk: 15 });
const prot = await page.evaluate(() => { const P = window.__GAME__.ctx.services.player; P.kill?.({ source: 'script' }); return P.state.alive; });
await adv(2);
check('spawn protection right after redeploy', prot === true && (await gm()).stage !== 'dead', `alive after kill attempt=${prot}`);
check('redeploy after countdown (reinforcement consumed)', g.playerAlive && g.stage === 'live' && g.lives === livesBefore - 1, `stage=${g.stage} lives=${livesBefore}→${g.lives} health=${g.health}`);

// ------------------------------------------------------------------ 8. long fight (sim time budget)
const targetFrames = Math.max(0, MINUTES * 3600 - simFrames - 60 * 25);
const fightStart = simFrames;
let wavesSeen = new Set([1, 2]);
while ((simFrames - fightStart < targetFrames || wavesSeen.size < 4) && simFrames - fightStart < 60 * 60 * 6) {
  g = await runUntil((x) => x.stage !== 'live', 60 * 30, { chunk: 4, assistAfter: 60 * 10 });
  if (g.stage === 'intermission') {
    await page.evaluate(() => window.__GAME__.ctx.services.gamemode.skipIntermission());
    await adv(4);
  }
  g = await gm();
  wavesSeen.add(g.wave);
  if (g.stage === 'dead' || g.stage === 'ended') break;
}
g = await gm();
check('multiple waves progressed', wavesSeen.size >= 3, `waves=${[...wavesSeen].join(',')} kills=${g.kills} score=${g.score}`);
await snap('07-late-wave');

// ------------------------------------------------------------------ 9. spawn protection, then overrun until no reinforcements → summary
g = await gm();
if (g.stage === 'dead') g = await runUntil((x) => x.stage !== 'dead', 60 * 9, { fight: false, chunk: 15 });
for (let i = 0; i < 12; i++) {
  g = await gm();
  if (g.stage === 'ended') break;
  if (g.stage === 'dead') { g = await runUntil((x) => x.stage !== 'dead', 60 * 9, { fight: false, chunk: 15 }); continue; }
  await adv(170); // outlast spawn protection
  await page.evaluate(() => { const P = window.__GAME__.ctx.services.player; (P.kill ? P.kill({ source: 'script' }) : P.damage(9999, { source: 'script' })); });
  await adv(30);
}
g = await gm();
check('final death → end-of-game summary', g.stage === 'ended' && g.phase === 'ended', `stage=${g.stage} phase=${g.phase} deaths=${g.deaths}`);
await adv(150);
await snap('08-summary');
const sumVisible = await page.evaluate(() => { const el = document.querySelector('.gmx .summary'); return !!el && !el.classList.contains('hide') && Number(getComputedStyle(el).opacity) > 0.5; });
check('summary screen visible', sumVisible);

// ------------------------------------------------------------------ 10. restart from the summary
const rc = await clickText('^restart');
await adv(10);
g = await gm();
check('RESTART → fresh run in warmup', !!rc && g.stage === 'warmup' && g.score === 0 && g.kills === 0 && g.playerAlive && g.wave === 0, `clicked=${rc} stage=${g.stage} score=${g.score} alive=${g.playerAlive}`);
await adv(60 * 3);
await snap('09-restart');

// ------------------------------------------------------------------ report
const errs = await page.evaluate(() => (window.__SYSTEM_ERRORS__ || []).map((e) => ({ system: e.system, phase: e.phase, message: String(e.message).slice(0, 200) })));
const mine = errs.filter((e) => e.system === 'gamemode');
check('no gamemode system errors', mine.length === 0, mine.map((e) => `${e.phase}: ${e.message}`).join(' | '));
check('no uncaught page errors', diag.pageErrors.length === 0, diag.pageErrors.slice(0, 3).join(' | '));
const T = await page.evaluate(() => ({ events: window.__PT.events, log: window.__PT.log.slice(-40) }));
const report = {
  ok: checks.every((c) => c.pass),
  passed: checks.filter((c) => c.pass).length,
  failed: checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`),
  ai: info0.realAI ? 'real' : info0.mock ? 'mock (services.ai.spawn returned null)' : 'none',
  simSeconds: Math.round(simFrames / 60),
  wallSeconds: Math.round((Date.now() - t0) / 1000),
  final: g,
  events: T.events,
  flowLog: T.log,
  otherSystemErrors: [...new Set(errs.filter((e) => e.system !== 'gamemode').map((e) => `${e.system}:${e.phase}`))],
  renderer,
  checks,
};
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
await cleanupAll();
process.exit(report.ok ? 0 : 1);

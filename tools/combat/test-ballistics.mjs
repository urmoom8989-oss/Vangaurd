#!/usr/bin/env node
/**
 * Combat ballistics regression tests (owner: combat).
 *
 *   node tools/combat/test-ballistics.mjs [--verbose] [--headed]
 *
 * Boots the real game through the shared harness (private Vite server + GPU Chromium) with the
 * `combat-test` shot preset (materials, world, player, combat), builds a firing range with
 * src/systems/combat/fixtures.js inside the page, and asserts through window.__GAME__:
 *   - hit registration + zone damage (chest / stomach / arm / neck / head) and headshot multipliers
 *   - per-weapon damage falloff at range
 *   - the penetration table (wood / plaster / sheet metal / glass pass; concrete / brick / sandbags /
 *     thick steel / thick timber stop), damage loss through material, exit measurement
 *   - explosion falloff by distance, zero damage outside the radius, occlusion behind concrete,
 *     partial transmission through wood
 *   - friendly-fire filtering, kill event + onDeath, player capsule hits from AI fire
 *   - frag grenade: gravity arc, bounce off a wall, comes to rest on the floor (never tunnels),
 *     cook timer shortens the fuse, detonation damages targets
 * Prints a JSON report; exit code 0 = all passed, 1 = failures, 2 = harness error.
 */
import { startServer, launchBrowser, openPage, waitForReady, buildUrl, parseArgs, cleanupAll, printJson } from '../lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const W = 960, H = 540;

async function main() {
  const { url } = await startServer();
  const { browser, renderer } = await launchBrowser({ width: W, height: H, headed: !!args.headed });
  const { page, diag } = await openPage(browser, { width: W, height: H });
  // Other agents edit files while the test runs: stop Vite HMR from full-reloading the page mid-test by
  // giving its client a socket that never connects (it then stays idle).
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (String(protocols || '').includes('vite')) {
        return { readyState: 0, send() {}, close() {}, addEventListener() {}, removeEventListener() {} };
      }
      return new Native(url, protocols);
    };
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  });
  // warm the dev server first (like tools/shot.mjs), then load the harness preset; retry once if Vite
  // reloads the page underneath us.
  await page.goto(buildUrl(url, { shot: '__list__' }), { timeout: 120000 });
  await waitForReady(page, 90000);
  let report = null;
  for (let attempt = 0; attempt < 3 && !report; attempt++) {
    try {
      await page.goto(buildUrl(url, { shot: 'combat-test', w: W, h: H }), { timeout: 120000 });
      await waitForReady(page, 90000);
      report = await page.evaluate(runTests);
    } catch (e) {
      if (!/context was destroyed|navigation/i.test(e.message) || attempt === 2) throw e;
      console.error('[combat-test] page reloaded during test, retrying');
    }
  }
  report.renderer = renderer;
  const sysErr = await page.evaluate(() => window.__SYSTEM_ERRORS__ || []);
  report.systemErrors = sysErr.filter((e) => e.system === 'combat');
  report.otherSystemErrors = sysErr.filter((e) => e.system !== 'combat').map((e) => `${e.system}:${e.phase}: ${String(e.message).slice(0, 160)}`);
  report.consoleErrors = diag.consoleErrors.filter((m) => /combat/i.test(m)).map((m) => m.slice(0, 400));
  report.pageErrors = diag.pageErrors;
  const failed = report.results.filter((r) => !r.pass);
  report.summary = `${report.results.length - failed.length}/${report.results.length} passed`;
  if (!args.verbose) report.results = report.results.map((r) => (r.pass ? `PASS ${r.name}` : r));
  printJson(report);
  await cleanupAll();
  process.exit(failed.length || report.systemErrors.length || report.pageErrors.length ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------------
// Runs inside the page.
async function runTests() {
  const G = window.__GAME__;
  const { ctx, THREE } = G;
  const combat = ctx.services.combat;
  const results = [];
  const approx = (a, b, tol = 0.05) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
  const check = (name, pass, detail = {}) => results.push({ name, pass: !!pass, ...detail });
  const { buildRange, ensureWorld } = await import('/src/systems/combat/fixtures.js');

  // If the world system failed to load (another agent mid-edit), a minimal raycast world is installed over
  // the fixture colliders so the ballistics themselves can still be verified. Reported as worldMode.
  const worldMode = ensureWorld(ctx);

  const tables = combat.tables;
  const ar7 = combat.getWeaponProfile('ar7');
  const p9 = combat.getWeaponProfile('p9');

  // elevated platform: the world's terrain now extends far past the playable bounds and must not
  // intersect the test lanes (grenade rest heights, explosion occlusion)
  const range = buildRange(ctx, { origin: [0, 25, 260], yaw: 0, floorSize: [140, 90] });
  // --- lanes (local x) -------------------------------------------------------------------------
  const T = {};
  T.near = range.target({ x: 0, z: -10, health: 1000, name: 'near' });
  T.far40 = range.target({ x: 3, z: -40, health: 1000, name: 'far40' });
  T.far60 = range.target({ x: 6, z: -60, health: 1000, name: 'far60' });
  // penetration lanes: panel at z=-4, target at z=-7, lanes 1.6 m apart starting x=-20
  const PEN = [
    ['wood_planks', 0.05, true],
    ['wood_planks', 0.4, false],
    ['plaster_painted', 0.12, true],
    ['plaster_painted', 0.35, false],
    ['corrugated_metal', 0.004, true],
    ['metal_painted', 0.03, false],
    ['glass', 0.01, true],
    ['concrete_wall', 0.2, false],
    ['brick_red', 0.24, false],
    ['sandbags', 0.6, false],
    ['cardboard', 0.02, true],
  ];
  const penLanes = PEN.map(([mat, t, expect], i) => {
    const x = -24 + i * 1.6;
    range.panel({ material: mat, w: 1.2, h: 2.2, t, x, z: -4 - t / 2 });
    const tg = range.target({ x, z: -7, health: 1000, name: `pen_${mat}_${t}` });
    return { mat, t, expect, x, tg };
  });
  // explosion lanes (x = 30.., z = -20): targets at increasing distance from a blast point
  const EXP_D = [0.8, 2.0, 3.5, 5.0, 6.5, 9.0];
  const expTargets = EXP_D.map((d) => range.target({ x: 30 + d, z: -20, ry: -Math.PI / 2, health: 1000, name: `exp_${d}` }));
  // occlusion: concrete wall between blast and target / wood between blast and target
  range.panel({ material: 'concrete_wall', w: 2.4, h: 2.6, t: 0.3, x: 30, z: -34.5, ry: 0 });
  const occConcrete = range.target({ x: 30, z: -36, health: 1000, name: 'occ_concrete' });
  range.panel({ material: 'wood_planks', w: 2.4, h: 2.6, t: 0.03, x: 46, z: -34.5 });
  const occWood = range.target({ x: 46, z: -36, health: 1000, name: 'occ_wood' });
  const openTgt = range.target({ x: 62, z: -36, health: 1000, name: 'occ_open' });
  // friendly
  const friendly = range.target({ x: -6, z: -14, health: 100, name: 'friendly', team: 'player' });
  // kill target
  let deathInfo = null;
  const killTgt = range.target({ x: 10, z: -10, health: 60, name: 'kill' });
  killTgt.damageable.onDeath = (info) => { deathInfo = info; };
  // grenade area: floor + wall
  range.panel({ material: 'concrete_wall', w: 6, h: 2, t: 0.3, x: -40, z: -30 });
  range.finish();

  const ft = range.floorTop;
  const W = (x, y, z) => range.toWorld([x, y, z]);
  const shoot = (from, to, opts = {}) => {
    const o = W(...from);
    const d = W(...to).sub(o).normalize();
    return combat.fireHitscan({ origin: o, direction: d, damage: 30, source: 'player', weaponId: 'ar7', tracer: false, ...opts });
  };
  const resetHp = (t) => { t.damageable.health = t.damageable.maxHealth; t.damageable.alive = true; };

  // --- 1. hit registration & zones ---------------------------------------------------------------
  {
    const r = shoot([0, 1.37, 0], [0, 1.37, -10]);
    check('hit registers on target (chest)', r && r.target === T.near.damageable && r.zone === 'chest', { zone: r?.zone, dmg: r?.damage });
    check('chest damage = base', r && approx(r.damage, 30), { dmg: r?.damage });
    const s = shoot([0, 1.1, 0], [0, 1.1, -10]);
    check('stomach zone multiplier', s && s.zone === 'stomach' && approx(s.damage, 30 * tables.ZONE_MULT.stomach), { dmg: s?.damage, zone: s?.zone });
    const a = shoot([0.33, 1.28, 0], [0.33, 1.28, -10]);
    check('arm (limb) zone multiplier', a && a.zone === 'arm' && approx(a.damage, 30 * tables.ZONE_MULT.arm), { dmg: a?.damage, zone: a?.zone });
    const h = shoot([0, 1.74, 0], [0, 1.74, -10]);
    check('headshot multiplier (AR-7 x1.4)', h && h.zone === 'head' && h.headshot && approx(h.damage, 30 * ar7.head), { dmg: h?.damage, zone: h?.zone, mult: ar7.head });
    const hp = shoot([0, 1.74, 0], [0, 1.74, -10], { weaponId: 'p9', damage: 28 });
    check('headshot multiplier (P9 x1.35)', hp && approx(hp.damage, 28 * p9.head), { dmg: hp?.damage });
    const n = shoot([0, 1.59, 0], [0, 1.59, -10]);
    check('neck zone', n && n.zone === 'neck' && approx(n.damage, 30 * tables.ZONE_MULT.neck), { dmg: n?.damage, zone: n?.zone });
    const miss = shoot([0, 1.37, 0], [2.5, 1.37, -10]);
    check('miss does not register a target', !miss || !miss.target, { target: miss?.target?.name });
    const hpBefore = T.near.damageable.health;
    shoot([0, 1.37, 0], [0, 1.37, -10]);
    check('damage applied to damageable health', approx(hpBefore - T.near.damageable.health, 30), { delta: hpBefore - T.near.damageable.health });
  }

  // --- 2. damage falloff ---------------------------------------------------------------------------
  {
    const r40 = shoot([3, 1.37, 0], [3, 1.37, -40]);
    const r60 = shoot([6, 1.37, 0], [6, 1.37, -60]);
    const exp40 = 30 * (combat.damageAt('ar7', 40, 'chest', 30) / 30);
    const exp60 = combat.damageAt('ar7', 60, 'chest', 30);
    check('falloff: AR-7 chest @40m', r40 && approx(r40.damage, exp40) && r40.damage < 30, { dmg: r40?.damage, expected: exp40 });
    check('falloff: AR-7 chest @60m', r60 && approx(r60.damage, exp60) && r60.damage < r40.damage, { dmg: r60?.damage, expected: exp60 });
    const shotgunFar = combat.damageAt('shotgun', 18, 'chest', 30);
    check('falloff: shotgun loses most damage by 18m', shotgunFar < 30 * 0.3, { dmg: shotgunFar });
  }

  // --- 3. penetration table ----------------------------------------------------------------------------
  for (const lane of penLanes) {
    const hp0 = lane.tg.damageable.health;
    const r = shoot([lane.x, 1.37, 0], [lane.x, 1.37, -10]);
    const got = lane.tg.damageable.health < hp0;
    const wallHit = r?.hits?.[0];
    const detail = { thicknessCm: +(lane.t * 100).toFixed(1), measuredCm: wallHit?.penetrated ? +(wallHit.thickness * 100).toFixed(2) : null, dmg: +(hp0 - lane.tg.damageable.health).toFixed(2) };
    check(`penetration ${lane.mat} ${detail.thicknessCm}cm -> ${lane.expect ? 'passes' : 'stops'}`, got === lane.expect, detail);
    if (lane.expect && got) {
      check(`  damage reduced through ${lane.mat}`, hp0 - lane.tg.damageable.health < 30 - 1e-3, detail);
      if (lane.t >= 0.02) check(`  exit thickness measured for ${lane.mat}`, wallHit && Math.abs(wallHit.thickness - lane.t) < 0.01, detail);
    }
  }
  {
    // pistol has less power: 12cm plaster passes with AR, 12cm plaster stops pistol? (13 power vs 18 cost)
    const lane = penLanes.find((l) => l.mat === 'plaster_painted' && l.t === 0.12);
    const hp0 = lane.tg.damageable.health;
    shoot([lane.x, 1.2, 0], [lane.x, 1.2, -10], { weaponId: 'p9', damage: 28 });
    check('pistol cannot pass 12cm plaster', lane.tg.damageable.health === hp0, { dmg: hp0 - lane.tg.damageable.health });
    const lmgHp = lane.tg.damageable.health;
    shoot([lane.x, 1.2, 0], [lane.x, 1.2, -10], { weaponId: 'lmg', damage: 34 });
    check('LMG passes 12cm plaster with more damage kept', lane.tg.damageable.health < lmgHp, { dmg: lmgHp - lane.tg.damageable.health });
    // grazing ricochet off wood
    let rico = 0;
    const off = ctx.events.on('combat:ricochet', () => rico++);
    const wl = penLanes[0];
    const o = W(wl.x - 0.55, 1.37, -3.95);
    const d = W(wl.x + 0.55, 1.37, -4.07).sub(o).normalize();
    combat.fireHitscan({ origin: o, direction: d, damage: 30, source: 'player', weaponId: 'ar7', tracer: false });
    off();
    check('grazing shot ricochets instead of penetrating', rico === 1, { rico });
  }

  // --- 4. explosions: falloff + occlusion ----------------------------------------------------------------
  {
    expTargets.forEach(resetHp);
    const blast = W(30, 0.05, -20);
    const rep = combat.explode({ position: blast, type: 'frag', source: 'test' });
    const dmg = expTargets.map((t) => +(t.damageable.maxHealth - t.damageable.health).toFixed(1));
    const mono = dmg.every((v, i) => i === 0 || v <= dmg[i - 1] + 1e-6);
    check('explosion damage decreases with distance', mono && dmg[0] > dmg[3], { distances: EXP_D, dmg });
    check('explosion inner radius = full damage', dmg[0] >= tables.EXPLOSIVES.frag.damage * 0.9, { dmg0: dmg[0] });
    check('explosion lethal (>100) at 3.5 m', dmg[2] > 100, { dmg: dmg[2] });
    check('explosion zero outside radius (9 m > 7.5 m)', dmg[5] === 0, { dmg: dmg[5] });
    check('explosion report lists targets', rep && rep.results.length >= 5, { n: rep?.results.length });
    // occlusion
    [occConcrete, occWood, openTgt].forEach(resetHp);
    for (const [x, t] of [[30, occConcrete], [46, occWood], [62, openTgt]]) combat.explode({ position: W(x, 0.05, -33), type: 'frag', source: 'test' });
    const dc = 1000 - occConcrete.damageable.health, dw = 1000 - occWood.damageable.health, dopen = 1000 - openTgt.damageable.health;
    check('explosion occluded by concrete wall', dc < dopen * 0.15, { behindConcrete: dc, open: dopen });
    check('explosion partially through thin wood', dw > dc && dw < dopen, { behindWood: dw, open: dopen });
  }

  // --- 5. friendly fire / kill / events -------------------------------------------------------------------------
  {
    const hp0 = friendly.damageable.health;
    const r = shoot([-6, 1.37, 0], [-6, 1.37, -14]);
    check('friendly (team player) not damaged by player', friendly.damageable.health === hp0 && (!r || r.target !== friendly.damageable), {});
    let kills = 0; let killPayload = null;
    const off = ctx.events.on('combat:kill', (e) => { kills++; killPayload = { zone: e.zone, headshot: e.headshot, weaponId: e.weaponId, victim: e.victim }; });
    let hits = 0;
    const off2 = ctx.events.on('combat:hit', () => hits++);
    shoot([10, 1.74, 0], [10, 1.74, -10]); // 42
    shoot([10, 1.74, 0], [10, 1.74, -10]); // 84 -> dead (60 hp)
    off(); off2();
    check('kill event + onDeath on lethal headshot', kills === 1 && deathInfo && killPayload.headshot && !killTgt.damageable.alive, { kills, killPayload });
    check('combat:hit emitted per hit', hits >= 2, { hits });
    const r2 = shoot([10, 1.37, 0], [10, 1.37, -10]);
    check('dead damageable no longer registers hits', !r2 || r2.target !== killTgt.damageable, {});
  }

  // --- 6. player capsule from AI fire ------------------------------------------------------------------------
  {
    const ps = ctx.services.player.state;
    const before = combat.stats.playerDamage;
    const eye = ps.position.clone().add(new THREE.Vector3(0, 1.3, 0));
    const from = eye.clone().add(new THREE.Vector3(0, 0, -12));
    const res = combat.fireHitscan({ origin: from, direction: eye.clone().sub(from).normalize(), damage: 25, source: 'ai:9', weaponId: 'ai_rifle', tracer: false });
    check('AI round hits the player capsule', res && res.hits.some((h) => h.isPlayer) && combat.stats.playerDamage > before, { dmg: combat.stats.playerDamage - before });
    const r2 = combat.fireHitscan({ origin: eye.clone().add(new THREE.Vector3(0.1, 0, 2)), direction: new THREE.Vector3(0, 0, 1), damage: 25, source: 'player', weaponId: 'ar7', tracer: false });
    check('player cannot shoot themselves', !r2 || !r2.hits.some((h) => h.isPlayer), {});
  }

  // --- 7. grenades ------------------------------------------------------------------------------------------
  {
    combat.clear();
    // (a) lob onto the floor: arc, land, roll, rest on the floor top
    const o = W(-44, 1.5, -20);
    const g = combat.throwGrenade({ origin: o, velocity: range.dirToWorld([0.25, 0.45, -1]).multiplyScalar(8), fuse: 30, source: 'test' });
    let minY = Infinity, maxY = -Infinity, apexFrame = -1;
    for (let f = 0; f < 240; f++) {
      await G.advanceFrames(1);
      if (g.position.y > maxY) { maxY = g.position.y; apexFrame = f; }
      minY = Math.min(minY, g.position.y);
    }
    const floorY = range.origin.y + ft;
    check('grenade flies a ballistic arc (apex above launch)', maxY > o.y + 0.3 && apexFrame > 3, { maxY: +maxY.toFixed(3), launchY: +o.y.toFixed(3) });
    check('grenade never tunnels through the floor', minY >= floorY + 0.02, { minY: +minY.toFixed(4), floorY });
    check('grenade comes to rest on the floor', g.resting && Math.abs(g.position.y - (floorY + tables.GRENADE.radius)) < 0.01, { y: +g.position.y.toFixed(4), resting: g.resting, bounces: g.bounces });
    // (a2) flat, fast throw (skids in at a grazing angle): must tumble to a stop within a few metres of
    //      where it first touched down, not skate across the floor
    combat.clear();
    const o3 = W(-48, 0.55, -10);
    const g3 = combat.throwGrenade({ origin: o3, velocity: range.dirToWorld([0, 0.06, -1]).multiplyScalar(11), fuse: 30, source: 'test' });
    let touch = null;
    for (let f = 0; f < 300 && !g3.resting; f++) {
      await G.advanceFrames(1);
      if (!touch && g3.bounces > 0) touch = g3.position.clone();
    }
    const skid = touch ? Math.hypot(g3.position.x - touch.x, g3.position.z - touch.z) : -1;
    check('flat skidding grenade stops within 1.5-5 m of touchdown', g3.resting && skid > 1.5 && skid < 5, { skid: +skid.toFixed(2), resting: g3.resting, bounces: g3.bounces });
    // (b) throw hard at a wall: must bounce back, never pass through
    const wallZ = range.origin.z - 30; // wall front face at local z=-29.85
    const o2 = W(-40, 1.0, -26);
    const g2 = combat.throwGrenade({ origin: o2, velocity: range.dirToWorld([0, 0.1, -1]).multiplyScalar(18), fuse: 30, source: 'test' });
    let maxZdepth = Infinity;
    for (let f = 0; f < 150; f++) { await G.advanceFrames(1); maxZdepth = Math.min(maxZdepth, g2.position.z); }
    check('grenade bounces off a wall (no tunnelling)', maxZdepth > wallZ + 0.15 - 0.02 - 0.001 && g2.position.z > wallZ + 0.3, { minZ: +maxZdepth.toFixed(3), wallFace: wallZ + 0.15, z: +g2.position.z.toFixed(3) });
    check('grenade bounced (reflected velocity)', g2.bounces > 0, { bounces: g2.bounces });
    combat.clear();
    // (c) cook timer
    const ps = ctx.services.player.state;
    const cooked = combat.cookGrenade();
    await G.advanceFrames(60);
    combat.releaseGrenade();
    let thrown = null;
    const off = ctx.events.on('combat:grenade', (e) => { if (e.phase === 'thrown') thrown = e.grenade; });
    await G.advanceFrames(12);
    off();
    check('cooking 1s shortens the fuse', cooked && thrown && approx(thrown.fuseLeft, tables.GRENADE.fuse - 1 - 12 / 60, 0.03), { fuseLeft: thrown && +thrown.fuseLeft.toFixed(3) });
    combat.clear();
    // (d) detonation damages nearby target
    const tgt = range.target({ x: -34, z: -20, health: 500, name: 'nade_victim' });
    let exploded = 0;
    const off3 = ctx.events.on('combat:explosion', () => exploded++);
    combat.throwGrenade({ origin: W(-34.8, 0.5, -20), velocity: new THREE.Vector3(0, 0.5, 0), fuse: 0.8, source: 'test' });
    await G.advanceFrames(70);
    off3();
    check('grenade detonates at fuse end and damages target', exploded === 1 && tgt.damageable.health < 500, { exploded, dmg: 500 - tgt.damageable.health });
  }

  // --- 8. spread handling, fragments, grenade input ownership -----------------------------------------------
  {
    // spread is a FULL cone angle; applied by combat when the caller passes the camera boresight
    const cam = ctx.camera;
    const fwd = new THREE.Vector3(); cam.getWorldDirection(fwd);
    const eye = cam.getWorldPosition(new THREE.Vector3());
    let maxDev = 0, anyDev = false;
    for (let i = 0; i < 64; i++) {
      const r = combat.fireHitscan({ origin: eye, direction: fwd, damage: 0.001, source: 'player', weaponId: 'ar7', spread: 4, tracer: false, impactFx: false, range: 5 });
      const d = r ? r.direction : null;
      if (d) { const dev = Math.acos(Math.min(1, d.dot(fwd))) * 180 / Math.PI; maxDev = Math.max(maxDev, dev); if (dev > 1e-3) anyDev = true; }
    }
    // (a result exists only on a hit; fall back to combat:shot directions)
    let shotDirs = [];
    const offS = ctx.events.on('combat:shot', (e) => shotDirs.push(e.direction.clone()));
    for (let i = 0; i < 64; i++) combat.fireHitscan({ origin: eye, direction: fwd, damage: 0.001, source: 'player', weaponId: 'ar7', spread: 4, tracer: false, impactFx: false, range: 5 });
    const devs = shotDirs.map((d) => Math.acos(Math.min(1, d.dot(fwd))) * 180 / Math.PI);
    shotDirs = [];
    // pre-spread direction (as the weapons system does): must be used as-is
    const pre = fwd.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.01).normalize();
    for (let i = 0; i < 8; i++) combat.fireHitscan({ origin: eye, direction: pre, damage: 0.001, source: 'player', weaponId: 'ar7', spread: 4, tracer: false, impactFx: false, range: 5 });
    offS();
    const preKept = shotDirs.length === 8 && shotDirs.every((d) => d.angleTo(pre) < 1e-6);
    const maxShot = Math.max(...devs);
    check('spread: boresight shots get a cone of half-angle 4 deg (0.6 < max dev <= 4)', devs.length === 64 && maxShot > 0.6 && maxShot <= 4.0001, { maxDevDeg: +maxShot.toFixed(3), anyDev, maxDev: +maxDev.toFixed(3) });
    check('spread: pre-spread direction is not spread again', preKept, { n: shotDirs.length });
    // fragments: blast next to a wall peppers it, blast in the open sky hits nothing
    const nearWall = combat.explode({ position: W(-40, 0.05, -28.8), type: 'frag', source: 'test' });
    const sky = combat.explode({ position: W(-60, 40, 30), type: 'frag', source: 'test' });
    check('frag fragment spray hits nearby wall/floor', nearWall && nearWall.fragmentHits >= 10, { hits: nearWall?.fragmentHits });
    check('frag fragment spray in open air hits nothing', sky && sky.fragmentHits === 0, { hits: sky?.fragmentHits });
    // grenade key ownership: once the weapons system reports its own lethal, combat stops cooking on the key
    const st = combat.grenade;
    const was = st.weaponsOwnsLethal;
    st.weaponsOwnsLethal = false;
    const ownedBefore = combat.grenadeInputOwned();
    ctx.events.emit('weapons:grenade', { phase: 'thrown', position: new THREE.Vector3() });
    const ownedAfter = combat.grenadeInputOwned();
    st.weaponsOwnsLethal = was;
    check('grenade input auto: yields to a weapons-owned lethal', ownedAfter === false && (ownedBefore === true || typeof ctx.services.weapons.state?.lethal === 'number'), { ownedBefore, ownedAfter });
  }

  // --- 8b. grenade danger indicator ---------------------------------------------------------------------------
  {
    combat.clear();
    const findRoot = () => { let r = null; ctx.camera.traverse((o) => { if (o.name === 'combat_danger_indicator') r = o; }); return r; };
    const ps = ctx.services.player.state;
    const eye = ps.eye.clone();
    // enemy frag dropped 3 m from the player, long fuse
    combat.throwGrenade({ origin: eye.clone().add(new THREE.Vector3(2.2, -1.0, -2.0)), velocity: new THREE.Vector3(0, 0, 0), fuse: 30, source: 'ai:test', team: 'enemy', spoon: false });
    await G.advanceFrames(3);
    const root = findRoot();
    const vis = root ? root.children.filter((c) => c.visible).length : -1;
    // far grenade (25 m) -> no indicator
    combat.clear();
    combat.throwGrenade({ origin: eye.clone().add(new THREE.Vector3(0, 0, -25)), velocity: new THREE.Vector3(0, 0, 0), fuse: 30, source: 'ai:test', team: 'enemy', spoon: false });
    await G.advanceFrames(3);
    const visFar = root ? root.children.filter((c) => c.visible).length : -1;
    combat.clear();
    await G.advanceFrames(1);
    const visNone = root ? root.children.filter((c) => c.visible).length : -1;
    check('danger indicator shows for a nearby enemy grenade (icon + chevron)', vis === 2, { vis });
    check('danger indicator hidden for a distant grenade / none live', visFar === 0 && visNone === 0, { visFar, visNone });
  }

  // --- 9. perf: raw hitscan cost ----------------------------------------------------------------------------
  {
    const o = W(0, 1.37, 0), d = W(0, 1.37, -10).sub(o).normalize();
    const t0 = performance.now();
    const N = 400;
    for (let i = 0; i < N; i++) combat.fireHitscan({ origin: o, direction: d, damage: 0.0001, source: 'player', weaponId: 'ar7', tracer: false, impactFx: false });
    const ms = (performance.now() - t0) / N;
    check('hitscan cost < 0.25 ms/shot (stub world)', ms < 0.25, { msPerShot: +ms.toFixed(4) });
  }

  range.dispose();
  return { worldMode, results, stats: { ...combat.stats } };
}

main().catch(async (e) => {
  console.error(e);
  await cleanupAll();
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message || e) }) + '\n');
  process.exit(2);
});

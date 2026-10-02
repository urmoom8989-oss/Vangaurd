import * as THREE from 'three';
import {
  MODE_ID, TOTAL_WAVES, OBJECTIVE_TEXT, SCORE, STREAKS, MULTI_NAMES, DIFFICULTY_ORDER,
  difficulty, waveSpec,
} from './config.js';
import { createSpawner } from './spawner.js';
import { createView } from './ui.js';
import { createCinematic } from './cinematic.js';
import { createStorage } from './storage.js';

/**
 * gamemode — GAME FLOW for "Hold Vardanek" (wave survival). Owner: gamemode agent.
 *
 * Flow:  menu → deploying (fade) → warmup (mission intro + countdown) → live wave ⇄ intermission
 *        → … → ended (summary).  Player death → dead (death screen) → redeploy (if reinforcements
 *        remain) or ended.  Pause (Esc / P / pointer-lock loss) freezes the simulation.
 *
 * services.gamemode (contract + extensions, see README.md):
 *   state: { mode, phase 'warmup'|'live'|'ended', score: {friendly, enemy}, timeLeft, round,
 *            stage, paused, wave, waveTotal, enemiesTotal, enemiesRemaining, enemiesAlive, kills, headshots,
 *            deaths, lives, streak, bestStreak, xp, shotsFired, shotsHit, difficulty, objective, endless, victory }
 *   start(mode?, opts?)  end(reason?)  addScore(team, points)
 *   pause() resume() restart() openMenu() deploy() setDifficulty(key) redeploy() skipIntermission()
 *   scenario(opts)   (shots/tests: jump straight into a flow state)
 *
 * Shot mode: inert 'sandbox' unless the preset has a `gamemode` block (see src/shots/gamemode.js), so it never
 * covers other systems' captures. Everything is driven by ctx.time / a deterministic UI clock.
 */
const IN_GAME = { warmup: true, live: true, intermission: true, 'match-live': true, 'match-dead': true };
const PHASE_OF = {
  boot: 'warmup', sandbox: 'live', menu: 'warmup', deploying: 'warmup', warmup: 'warmup',
  live: 'live', intermission: 'live', 'match-live': 'live', 'match-dead': 'live', dead: 'live', ended: 'ended',
};
const INTRO_LINES = ['Hold Vardanek', 'Day 3 — 17:42 local', 'S/Sgt. Tomas Rehn', 'Task Force Iron Vigil', 'Vardanek · Plaza District'];
const DEATH_REDEPLOY = 6.0; // seconds before auto-redeploy
const DEATH_FINAL = 4.2; // seconds on the death screen before the summary
const MIN_LIVE = 4.0;
const SPAWN_PROTECT = 2.5; // s of invulnerability after a redeploy // a wave lasts at least this long (banner readability, AI-less fallback)
const STALL_REVEAL = 40; // s without a kill while few hostiles remain → reveal
const STALL_REMOVE = 110; // s → remove unreachable hostiles so a wave can't soft-lock
const RESUPPLY_LETHAL = 2; // frag grenades topped up to this count on resupply

export default function createSystem(ctx) {
  const { events, input, time } = ctx;
  const rng = ctx.rng.fork('gamemode');
  const shotCfg = ctx.shot?.gamemode || null;
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const sandboxOnly = (ctx.flags.shotMode && !shotCfg) || params.get('gamemode') === 'sandbox';

  // ------------------------------------------------------------------ public state (contract + extensions)
  const state = {
    mode: sandboxOnly ? 'sandbox' : MODE_ID,
    matchType: 'protection',
    playerTeam: 'player',
    scoreLimit: 30,
    winner: '',
    matchTime: 0,
    phase: sandboxOnly ? 'live' : 'warmup',
    stage: sandboxOnly ? 'sandbox' : 'boot',
    paused: false,
    score: { friendly: 0, enemy: 0 },
    timeLeft: Infinity,
    round: 0,
    wave: 0,
    waveTotal: TOTAL_WAVES,
    enemiesTotal: 0,
    enemiesRemaining: 0,
    enemiesAlive: 0,
    kills: 0,
    headshots: 0,
    deaths: 0,
    lives: 0,
    streak: 0,
    bestStreak: 0,
    xp: 0,
    shotsFired: 0,
    shotsHit: 0,
    difficulty: 'regular',
    objective: OBJECTIVE_TEXT,
    waveTitle: '',
    livesMax: 0,
    maxLives: 0,
    respawnIn: 0,
    respawnDelay: DEATH_REDEPLOY,
    endless: false,
    victory: false,
  };

  // ------------------------------------------------------------------ flow model (read by the view)
  const G = {
    state,
    stage: state.stage,
    stageT: 0,
    uiT: 0,
    menuT: 0,
    fade: 0,
    paused: false,
    diffKey: 'regular',
    livesMax: 0,
    endless: false,
    spec: null,
    nextSpec: null,
    bannerT: 99,
    flankBearing: null,
    countdown: 0,
    skipHold: 0,
    introLines: INTRO_LINES,
    introEnd: 9.6,
    objStart: 2.9,
    objEnd: 8.0,
    cdStart: 8.6,
    clearedHold: 6.2,
    lastWave: 0,
    lastWaveFinal: false,
    bonusLines: [],
    bonusKey: '',
    wavesSurvived: 0,
    scoreboard: false,
    hideTracker: false,
    death: { killer: '', distance: 0, final: false, redeployIn: 0, redeployTotal: DEATH_REDEPLOY },
    summary: { victory: false, newBest: false, prevBest: null, persisted: false, rank: '—', medals: [], medalKey: '', time: 0, waves: [], wavesKey: '' },
    bestFor: (d) => storage.bestFor(d),
    waveLog: null,
  };

  // wave runtime
  const wave = {
    active: false, spec: null, toSpawn: 0, dropped: 0, killed: 0, spawnTimer: 0, squads: 0,
    failStreak: 0, liveT: 0, damageTaken: 0, lastKillT: 0, kills: 0, shots0: 0, hits0: 0, heads0: 0,
  };
  const tracked = []; // [{agent, meta, down, spawnT, lastPos, stillT, revealed}]
  const byAgent = new Map();
  const medals = new Map();
  const waveLog = []; // [{wave, kills, time, flawless, failed}]
  let multiCount = 0;
  let lastKillTime = -99;
  let combatTime = 0;
  let resumeStage = null;
  let resumeStageT = 0;
  let resetting = false;
  let shotHitCounted = true;
  let aiPlayerDeaths = 0;
  let combatPlayerKills = 0;
  let fallbackCredited = 0;
  let lastAiDeathT = 0;
  let slowmo = 0;
  let lastReal = -1;
  let pendingResume = 0;
  let deployT = 0;
  let audioNames = null;
  let hudHidden = null;
  let savedScale = 1;
  let spawnProtect = 0;
  let matchRespawn = 0;
  const matchFactions = [];
  const matchBotRespawns = [];
  const matchSpawnRng = rng.fork('match-spawns');

  const objective = new THREE.Vector3();
  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();

  const storage = createStorage(!ctx.flags.shotMode);
  const spawner = createSpawner(ctx, rng);
  const cinematic = createCinematic(ctx);
  let view = null;

  // ------------------------------------------------------------------ helpers
  const S = () => ctx.services;
  const isPlayerSource = (src) => src === 'player' || (typeof src === 'string' && src.startsWith('player'));
  const diff = () => difficulty(G.diffKey);

  function emitPhase(prevPhase) {
    if (state.phase !== prevPhase) events.emit('gamemode:phase', { phase: state.phase, stage: state.stage });
  }
  function setStage(name) {
    const prevPhase = state.phase;
    const prev = G.stage;
    G.stage = name;
    state.stage = name;
    G.stageT = 0;
    state.phase = PHASE_OF[name] || 'live';
    events.emit('gamemode:stage', { stage: name, prev });
    emitPhase(prevPhase);
  }

  function hudVisible(on) {
    if (hudHidden === !on) return;
    hudHidden = !on;
    try { S().hud.setVisible(on); } catch (e) { ctx.reportError('gamemode', 'hud.setVisible', e); }
  }

  /** True when the hud publishes its own menu stack (main/pause/settings/death): gamemode then yields those screens. */
  function extUI() { return typeof S().hud.openMenu === 'function'; }
  /** True when the hud has its own feed (banner/medal/xp popups): gamemode then routes transient feedback to it. */
  function hudFeed() {
    const h = S().hud;
    return typeof h.banner === 'function' || typeof h.scorePopup === 'function';
  }

  function notify(text, opts) {
    const hud = S().hud;
    const fallback = hud.notify === S().defaults?.hud?.notify;
    if (fallback) view?.toast(text, opts?.kind, opts?.duration);
    else {
      try { hud.notify(text, opts); } catch (e) { ctx.reportError('gamemode', 'hud.notify', e); }
    }
  }

  function uiSound(name) {
    if (ctx.flags.shotMode) return;
    try {
      const a = S().audio;
      if (!audioNames) audioNames = new Set(a.list?.() || []);
      const cands = UI_SOUNDS[name];
      if (!cands) return;
      for (const c of cands) if (audioNames.has(c)) { a.play(c, { bus: 'ui' }); return; }
    } catch { /* audio optional */ }
  }

  function setInputEnabled(on) {
    if (!on) input.releaseAll?.();
    input.enabled = on;
  }

  function simFreeze(on) {
    if (!time.deterministic) {
      if (on) { savedScale = time.scale || 1; time.scale = 0; } else time.scale = savedScale || 1;
    }
    try { S().ai.setEnabled(!on); } catch { /* optional */ }
    try { S().player.setMovementEnabled(!on); } catch { /* optional */ }
  }

  function resolveObjective() {
    const w = S().world;
    if (w.map?.center) {
      objective.set(w.map.center[0], 0, w.map.center[1]);
      try { objective.y = w.groundHeight(objective.x, objective.z, 30); } catch { objective.y = 0; }
      return;
    }
    const zone = w.zones?.plaza;
    if (zone?.isBox3) {
      zone.getCenter(objective);
      try { objective.y = w.groundHeight(objective.x, objective.z, zone.max.y); } catch { objective.y = 0; }
      return;
    }
    const p = w.pois?.plaza || w.objectives?.plaza || w.landmarks?.plaza;
    if (p && (p.isVector3 || Array.isArray(p) || p.position)) {
      if (p.isVector3) objective.copy(p);
      else if (Array.isArray(p)) objective.fromArray(p);
      else if (p.position?.isVector3) objective.copy(p.position);
      else objective.fromArray(p.position);
    } else {
      const sp = w.spawnPoints?.player?.[0];
      if (sp) objective.copy(sp.position);
      else objective.set(0, 0, 0);
    }
  }

  function objectiveText() {
    const map = S().world.map;
    return map?.id && map.id !== 'plaza' ? `Hold the ${map.name}` : OBJECTIVE_TEXT;
  }

  // ------------------------------------------------------------------ player / weapons plumbing (optional extensions)
  function respawnPlayer(sp) {
    const P = S().player;
    try {
      if (typeof P.respawn === 'function') P.respawn(sp.position, sp.yaw);
      else {
        P.teleport(sp.position, sp.yaw, 0);
        const ps = P.state;
        if (ps) { ps.health = ps.maxHealth || 100; ps.alive = true; }
      }
      P.setMovementEnabled(true);
    } catch (e) { ctx.reportError('gamemode', 'respawnPlayer', e); }
    events.emit('gamemode:respawn', { position: sp.position, yaw: sp.yaw });
  }

  function resupply(reason) {
    const W = S().weapons;
    let done = false;
    try {
      if (typeof W.resupply === 'function') { W.resupply(); done = true; }
      else if (typeof W.refillAmmo === 'function') { W.refillAmmo(); done = true; }
      else if (typeof W.addAmmo === 'function') { W.addAmmo(9999); done = true; } // clamped to reserveMax by weapons
      if (typeof W.resupply !== 'function' && typeof W.addGrenades === 'function') {
        const lethal = W.state?.lethal;
        if (Number.isFinite(lethal) && lethal < RESUPPLY_LETHAL) W.addGrenades(RESUPPLY_LETHAL - lethal);
      }
    } catch (e) { ctx.reportError('gamemode', 'weapons.resupply', e); }
    if (!done) {
      const ws = W.state;
      if (ws && ws.magSize > 0) ws.reserve = Math.max(ws.reserve || 0, ws.magSize * 4);
    }
    events.emit('gamemode:resupply', { reason });
  }

  // ------------------------------------------------------------------ scoring
  function addScore(team, points) {
    if (!team) team = SCORE.friendlyTeam;
    state.score[team] = (state.score[team] || 0) + points;
    if (team === SCORE.friendlyTeam) state.xp = state.score[team];
    events.emit('gamemode:score', { team, score: state.score[team], points });
  }

  function medal(name) { medals.set(name, (medals.get(name) || 0) + 1); }

  function creditKill(info) {
    const mult = diff().scoreMult;
    const t = time.t;
    state.kills++;
    wave.kills++;
    const head = info.zone === 'head';
    if (head) state.headshots++;
    let pts = SCORE.kill;
    let label = 'Kill';
    const wid = String(info.weaponId || '');
    if (/melee|knife/i.test(wid)) { pts += SCORE.melee; label = 'Melee kill'; }
    else if (/frag|grenade|explos/i.test(wid)) { pts += SCORE.explosive; label = 'Explosive kill'; }
    if (head) { pts += SCORE.headshot; label = 'Headshot'; }
    let dist = 0;
    if (info.target?.object?.getWorldPosition) {
      info.target.object.getWorldPosition(tmpV);
      dist = tmpV.distanceTo(S().player.state.position);
      if (dist >= SCORE.longshotDistance) { pts += SCORE.longshot; label = head ? 'Longshot headshot' : 'Longshot'; medal('Longshot'); }
    }
    if (head) medal('Headshot');
    pts = Math.round(pts * mult);
    addScore(SCORE.friendlyTeam, pts);
    notify(`+${pts} ${label}`, { kind: 'xp', points: pts, label, headshot: head, duration: 1.4 });

    // multi-kill chain
    if (t - lastKillTime <= SCORE.multiWindow) multiCount++;
    else multiCount = 1;
    lastKillTime = t;
    if (multiCount >= 2) {
      const name = MULTI_NAMES[Math.min(5, multiCount)];
      const bonus = Math.round((SCORE.multi[Math.min(4, multiCount)] || 150) * mult);
      addScore(SCORE.friendlyTeam, bonus);
      medal(name);
      notify(name, { kind: 'medal', points: bonus, sub: `+${bonus}`, icon: 'multi', tier: Math.min(3, multiCount - 1), count: multiCount, duration: 2.2 });
      events.emit('gamemode:medal', { name, points: bonus, kind: 'multikill', count: multiCount });
    }

    // streak
    state.streak++;
    if (state.streak > state.bestStreak) state.bestStreak = state.streak;
    for (const s of STREAKS) {
      if (s.count !== state.streak) continue;
      const bonus = Math.round(s.bonus * mult);
      addScore(SCORE.friendlyTeam, bonus);
      medal(s.name);
      notify(s.name, { kind: 'streak', points: bonus, sub: `${s.count} kill streak · +${bonus}${s.resupply ? ' · Ammo resupplied' : ''}`, tier: s.count >= 10 ? 3 : s.count >= 5 ? 2 : 1, count: s.count, duration: 3.0 });
      events.emit('gamemode:streak', { count: s.count, name: s.name, points: bonus });
      if (s.resupply) resupply('streak');
    }
    events.emit('gamemode:kill', { points: pts, headshot: head, streak: state.streak, distance: dist, weaponId: info.weaponId || null });
  }

  // ------------------------------------------------------------------ hostiles tracking
  function track(agent, meta) {
    if (!agent || byAgent.has(agent)) return;
    const rec = { agent, meta: meta || null, down: false, spawnT: time.t, lastPos: new THREE.Vector3(), stillT: 0, revealed: false };
    if (agent.position) rec.lastPos.copy(agent.position);
    tracked.push(rec);
    byAgent.set(agent, rec);
    state.enemiesAlive++;
  }

  function markDown(rec) {
    if (rec.down) return;
    rec.down = true;
    state.enemiesAlive = Math.max(0, state.enemiesAlive - 1);
    if (wave.active) {
      wave.killed++;
      wave.lastKillT = wave.liveT;
    }
    byAgent.delete(rec.agent);
    const i = tracked.indexOf(rec);
    if (i >= 0) tracked.splice(i, 1);
    refreshRemaining();
  }

  function refreshRemaining() {
    if (!wave.active) { state.enemiesRemaining = 0; return; }
    state.enemiesTotal = Math.max(0, wave.spec.total - wave.dropped);
    state.enemiesRemaining = wave.toSpawn + state.enemiesAlive;
  }

  function clearHostiles() {
    resetting = true;
    try {
      const ai = S().ai;
      ai.killAll();
      ai.clear?.();
    } catch (e) { ctx.reportError('gamemode', 'ai.killAll', e); }
    resetting = false;
    tracked.length = 0;
    byAgent.clear();
    state.enemiesAlive = 0;
  }

  // ------------------------------------------------------------------ flow
  function resetRun() {
    clearHostiles();
    matchBotRespawns.length = 0;
    matchFactions.length = 0;
    try { S().vfx.clear?.(); } catch { /* optional */ }
    state.score.friendly = 0;
    state.score.enemy = 0;
    state.score.blue = 0;
    state.score.red = 0;
    state.score.player = 0;
    state.winner = '';
    state.matchTime = 0;
    matchRespawn = 0;
    state.xp = 0;
    state.wave = 0;
    state.round = 0;
    state.kills = 0;
    state.headshots = 0;
    state.deaths = 0;
    state.streak = 0;
    state.bestStreak = 0;
    state.shotsFired = 0;
    state.shotsHit = 0;
    state.enemiesTotal = 0;
    state.enemiesRemaining = 0;
    state.victory = false;
    G.summary.victory = false;
    G.summary.endless = false;
    state.endless = false;
    G.endless = false;
    G.wavesSurvived = 0;
    G.spec = null;
    G.nextSpec = null;
    G.bannerT = 99;
    G.flankBearing = null;
    wave.active = false;
    medals.clear();
    waveLog.length = 0;
    multiCount = 0;
    lastKillTime = -99;
    combatTime = 0;
    aiPlayerDeaths = 0;
    combatPlayerKills = 0;
    fallbackCredited = 0;
    spawner.reset();
    events.emit('gamemode:score', { team: SCORE.friendlyTeam, score: 0, points: 0 });
  }

  function openMenu(opts = {}) {
    if (G.paused) unpauseInternal();
    resetRun();
    setStage('menu');
    G.menuT = 0;
    G.fade = 0;
    state.timeLeft = Infinity;
    hudVisible(false);
    setInputEnabled(false);
    try { S().player.setMovementEnabled(false); } catch { /* optional */ }
    try { input.unlock?.(); } catch { /* ignore */ }
    resolveObjective();
    if (extUI()) {
      cinematic.stop();
      try { if (S().hud.menu !== 'main' && !opts.fromHud) S().hud.openMenu('main'); } catch (e) { ctx.reportError('gamemode', 'hud.openMenu', e); }
    } else cinematic.start(objective, 0);
    try { S().hud.setObjective(null); } catch { /* optional */ }
  }

  function deploy() {
    if (G.stage !== 'menu') return;
    // the click on DEPLOY is the user gesture: take pointer lock + wake audio (core's boot overlay is disabled)
    if (!ctx.flags.shotMode) {
      try { ctx.ui.requestPointerLock(); } catch { /* ignore */ }
      events.emit('core:user-gesture');
      try { S().audio.resume(); } catch { /* ignore */ }
    }
    uiSound('deploy');
    setStage('deploying');
    deployT = 0;
  }

  function matchEdgeSpawns() {
    const world = S().world;
    const all = world.spawnPoints?.ai || [];
    if (!all.length) return { all: world.spawnPoints?.player || [], north: [], south: [] };
    const bounds = world.bounds;
    const cx = world.map?.center?.[0] ?? (bounds ? (bounds.min.x + bounds.max.x) * 0.5 : 0);
    const cz = world.map?.center?.[1] ?? (bounds ? (bounds.min.z + bounds.max.z) * 0.5 : 0);
    const radius = Math.max(1, ...all.map((sp) => Math.hypot(sp.position.x - cx, sp.position.z - cz)));
    const extent = radius * 0.68;
    const edges = all.filter((sp) => Math.hypot(sp.position.x - cx, sp.position.z - cz) >= extent);
    const roster = edges.length ? edges : all;
    const split = Math.max(6, radius * 0.3);
    let north = roster.filter((sp) => sp.position.z < cz - split).sort((a, b) => a.position.z - b.position.z);
    let south = roster.filter((sp) => sp.position.z > cz + split).sort((a, b) => b.position.z - a.position.z);
    if (north.length < 2) north = roster.slice().sort((a, b) => a.position.z - b.position.z).slice(0, Math.max(2, Math.ceil(roster.length / 3)));
    if (south.length < 2) south = roster.slice().sort((a, b) => b.position.z - a.position.z).slice(0, Math.max(2, Math.ceil(roster.length / 3)));
    return { all: roster, north, south };
  }

  function matchSpawnForPlayer(agents = S().ai.agents || []) {
    const groups = matchEdgeSpawns();
    const candidates = state.matchType === 'tdm'
      ? groups.south
      : groups.all;
    if (!candidates.length) return S().world.spawnPoints?.player?.[0] || null;
    let best = candidates[0], bestScore = -Infinity;
    for (const sp of candidates) {
      let nearestEnemy = Infinity;
      for (const a of agents) {
        if (!a?.alive || a.team === state.playerTeam || !a.position) continue;
        nearestEnemy = Math.min(nearestEnemy, sp.position.distanceTo(a.position));
      }
      const score = nearestEnemy + matchSpawnRng.next() * 0.5;
      if (score > bestScore) { bestScore = score; best = sp; }
    }
    const out = { position: best.position.clone(), yaw: Math.atan2(-(objective.x - best.position.x), -(objective.z - best.position.z)) };
    return out;
  }

  function spawnMatchRoster(playerSpawn) {
    const groups = matchEdgeSpawns();
    const blue = groups.south.length ? groups.south : groups.all;
    const red = groups.north.length ? groups.north : groups.all;
    const playerIndex = blue.reduce((best, sp, i) => sp.position.distanceToSquared(playerSpawn.position) < sp.position.distanceToSquared(blue[best].position) ? i : best, 0);
    const blueRoster = blue.filter((_, i) => i !== playerIndex);
    for (let i = 0; i < 4; i++) spawnMatchBot({ team: 'blue', index: i, label: 'Ally' }, blueRoster.length ? blueRoster : blue);
    for (let i = 0; i < 5; i++) spawnMatchBot({ team: 'red', index: i, label: 'Vanguard' }, red);
  }

  function spawnMatchBot(roster, spawnPoints = null) {
    const groups = matchEdgeSpawns();
    const points = spawnPoints || (roster.team === 'blue'
      ? (groups.south.length ? groups.south : groups.all)
      : (groups.north.length ? groups.north : groups.all));
    if (!points.length) return null;
    const world = S().world;
    const center = objective;
    const { team, index, label } = roster;
    const base = points[index % points.length];
    const angle = index * 2.399 + (team === 'red' ? Math.PI : 0);
    const pos = base.position.clone();
    if (index >= points.length) pos.add(new THREE.Vector3(Math.cos(angle) * 0.7, 0, Math.sin(angle) * 0.7));
    const gy = world.groundHeight(pos.x, pos.z, pos.y + 4);
    if (Number.isFinite(gy)) pos.y = gy;
    const loadout = index % 4 === 3 ? 'smg' : 'rifle';
    const behavior = {
      name: `${label} ${index + 1}`,
      target: 'match', objective: center, squad: `match:${team}:${index}`,
      aggression: 0.9, accuracy: 0.9, health: 100,
    };
    const bot = S().ai.spawn({
      position: pos,
      yaw: Math.atan2(-(center.x - pos.x), -(center.z - pos.z)),
      loadout,
      team,
      behavior,
    });
    if (bot) {
      bot.matchRoster = { ...roster };
      matchFactions.push(bot);
    }
    return bot;
  }

  function updateMatchBotRespawns(dt) {
    for (let i = matchBotRespawns.length - 1; i >= 0; i--) {
      const pending = matchBotRespawns[i];
      pending.remaining -= dt;
      if (pending.remaining > 0) continue;
      const bot = spawnMatchBot(pending.roster);
      if (bot) matchBotRespawns.splice(i, 1);
      else pending.remaining = 0.5;
    }
  }

  function beginMatch() {
    state.playerTeam = state.matchType === 'tdm' ? 'blue' : 'player';
    state.scoreLimit = 30;
    state.score.blue = 0; state.score.red = 0; state.score.player = 0;
    state.matchTime = 0;
    matchFactions.length = 0;
    matchBotRespawns.length = 0;
    resolveObjective();
    const spawn = matchSpawnForPlayer([]);
    if (spawn) respawnPlayer(spawn);
    resupply('match start');
    try { S().player.setInvulnerable?.(true); spawnProtect = SPAWN_PROTECT; } catch { /* optional */ }
    try { S().ai.setEnabled(true); } catch { /* optional */ }
    setInputEnabled(true);
    hudVisible(true);
    state.wave = 1; state.round = 1; state.lives = 0;
    state.kills = state.deaths = state.headshots = state.streak = state.bestStreak = 0;
    state.enemiesTotal = 5;
    state.enemiesRemaining = state.enemiesTotal;
    state.enemiesAlive = state.enemiesTotal;
    matchRespawn = 0;
    G.fade = 0;
    G.paused = false;
    G.countdown = 0;
    setStage('match-live');
    spawnMatchRoster(spawn || { position: objective.clone(), yaw: 0 });
    notify(`Team Deathmatch · first to ${state.scoreLimit}`, { kind: 'banner', duration: 3.5 });
    events.emit('gamemode:start', { mode: state.matchType, difficulty: G.diffKey });
  }

  function finishMatch(winner, label) {
    if (G.stage === 'ended') return;
    state.winner = label || winner;
    state.victory = winner === state.playerTeam;
    G.summary.victory = state.victory;
    G.summary.endless = false;
    matchBotRespawns.length = 0;
    state.timeLeft = 0;
    state.objective = state.victory ? 'Match victory' : 'Match complete';
    state.enemiesRemaining = 0;
    try { S().ai.setEnabled(false); } catch { /* optional */ }
    try { S().player.setMovementEnabled(false); } catch { /* optional */ }
    setStage('ended');
    notify(state.victory ? `VICTORY · ${state.winner} wins` : `MATCH OVER · ${state.winner} wins`, { kind: 'banner', duration: 6 });
    events.emit('gamemode:match-end', { winner, label: state.winner, score: { ...state.score } });
    if (extUI()) {
      try { S().hud.showMatchResult?.(); } catch { /* optional */ }
    }
  }

  function awardMatchKill(e) {
    if (!(G.stage === 'match-live' || G.stage === 'match-dead') || !e?.target) return;
    const targetTeam = e.target.team || (e.target.isPlayer ? 'player' : '');
    const source = e.source;
    const isHuman = isPlayerSource(source);
    const attacker = isHuman ? null : (S().ai.agents || []).find((a) => a.key === source);
    if (isHuman) {
      if (targetTeam === state.playerTeam || targetTeam === 'friendly' || targetTeam === 'player' && state.matchType === 'tdm') return;
      state.kills++;
      state.streak++;
      state.bestStreak = Math.max(state.bestStreak, state.streak);
      state.score.blue++;
      state.score.friendly = state.score.blue;
      state.score.enemy = state.score.red;
      if (state.score.blue >= state.scoreLimit) finishMatch('blue', 'BLUE TEAM');
      return;
    }
    if (!attacker) return;
    if (state.matchType === 'tdm') {
      if (attacker.team === targetTeam) return;
      const scoreKey = attacker.team === 'blue' ? 'blue' : 'red';
      state.score[scoreKey] = (state.score[scoreKey] || 0) + 1;
      state.score.friendly = state.score.blue;
      state.score.enemy = state.score.red;
      if (state.score[scoreKey] >= state.scoreLimit) finishMatch(scoreKey, scoreKey === 'blue' ? 'BLUE TEAM' : 'RED TEAM');
    }
  }

  function beginMission(opts = {}) {
    if (G.paused) unpauseInternal();
    resetRun();
    G.diffKey = ctx.settings.get('gameplay.difficulty', 'regular');
    if (!DIFFICULTY_ORDER.includes(G.diffKey)) G.diffKey = 'regular';
    state.difficulty = G.diffKey;
    const d = diff();
    state.lives = d.lives;
    state.livesMax = d.lives;
    state.maxLives = d.lives;
    G.livesMax = d.lives;
    if (state.matchType === 'tdm') {
      cinematic.stop();
      resolveObjective();
      beginMatch();
      return;
    }
    state.playerTeam = 'player';
    cinematic.stop();
    resolveObjective();
    state.objective = objectiveText();
    if (opts.teleport !== false) {
      const sp = S().world.spawnPoints?.player?.[0];
      if (sp) respawnPlayer(sp);
    } else {
      try {
        const ps = S().player.state;
        if (ps && !ps.alive) { ps.health = ps.maxHealth || 100; ps.alive = true; }
        S().player.setMovementEnabled(true);
      } catch { /* optional */ }
    }
    resupply('deploy');
    if (spawnProtect > 0) { spawnProtect = 0; try { S().player.setInvulnerable?.(false); } catch { /* optional */ } }
    try { S().ai.setEnabled(true); } catch { /* optional */ }
    setInputEnabled(true);
    hudVisible(true);
    try { S().hud.setObjective(state.objective, { position: objective }); } catch { /* optional */ }
    const warm = opts.warmup ?? d.warmup;
    G.countdown = warm;
    G.cdStart = Math.max(3.2, Math.min(8.6, warm - 4.5));
    G.objStart = Math.min(2.9, G.cdStart - 2.6);
    G.objEnd = G.cdStart - 0.5;
    G.introEnd = Math.min(9.6, warm - 0.5);
    G.skipHold = 0;
    state.timeLeft = warm;
    setStage('warmup');
    G.fade = 1;
    events.emit('gamemode:start', { mode: state.mode, difficulty: G.diffKey });
  }

  function startWave(n, quiet = false) {
    const spec = waveSpec(n, G.diffKey);
    wave.active = true;
    wave.spec = spec;
    wave.toSpawn = spec.total;
    wave.dropped = 0;
    wave.killed = 0;
    wave.spawnTimer = spec.firstDelay;
    wave.squads = 0;
    wave.failStreak = 0;
    wave.liveT = 0;
    wave.damageTaken = 0;
    wave.lastKillT = 0;
    wave.kills = 0;
    wave.shots0 = state.shotsFired;
    wave.hits0 = state.shotsHit;
    wave.heads0 = state.headshots;
    state.wave = n;
    state.round = n;
    state.timeLeft = Infinity;
    G.spec = spec;
    G.bannerT = 0;
    G.flankBearing = null;
    state.waveTitle = spec.subtitle;
    refreshRemaining();
    setStage('live');
    G.hudBanner = hudFeed();
    if (!quiet) announceWave();
    events.emit('gamemode:wave', { wave: n, phase: 'start', total: spec.total, heavy: spec.heavy, final: spec.final });
  }

  /** Wave-start banner (hud feed when available, else the gamemode banner keyed off G.bannerT). */
  function announceWave() {
    const spec = wave.spec;
    if (!spec) return;
    G.bannerT = 0;
    if (G.hudBanner) {
      notify(`Wave ${spec.wave}`, {
        kind: 'wave', kicker: spec.final ? 'Final wave' : spec.heavy ? 'Heavy wave' : 'Hold Vardanek',
        sub: `${spec.total} hostiles · ${spec.title}`, warn: !!spec.final, duration: 3.6,
      });
    }
    uiSound('wave');
  }

  function waveCleared() {
    const spec = wave.spec;
    wave.active = false;
    const mult = diff().scoreMult;
    const lines = [];
    const clear = Math.round(SCORE.waveClearPerWave * spec.wave * mult);
    addScore(SCORE.friendlyTeam, clear);
    lines.push({ label: 'Wave clear bonus', points: clear });
    if (wave.damageTaken <= 0 && wave.kills > 0) {
      const f = Math.round(SCORE.flawless * mult);
      addScore(SCORE.friendlyTeam, f);
      lines.push({ label: 'Flawless defense', points: f, accent: true });
      medal('Flawless');
    }
    const wf = state.shotsFired - wave.shots0;
    const wh = state.shotsHit - wave.hits0;
    lines.push({ label: 'Eliminated', value: String(wave.kills), stat: true });
    lines.push({ label: 'Headshots', value: String(Math.max(0, state.headshots - wave.heads0)), stat: true });
    lines.push({ label: 'Accuracy', value: wf > 0 ? `${Math.round((100 * wh) / wf)}%` : '—', stat: true });
    lines.push({ label: 'Wave time', value: fmtTime(wave.liveT), stat: true });
    waveLog.push({ wave: spec.wave, kills: wave.kills, time: wave.liveT, flawless: wave.damageTaken <= 0 && wave.kills > 0, failed: false });
    resupply('intermission');
    lines.push({ label: 'Ammunition restocked', value: 'Lethals topped up', resupply: true });
    G.bonusLines = lines;
    G.bonusKey = `${spec.wave}:${lines.length}:${clear}`;
    G.lastWave = spec.wave;
    G.lastWaveFinal = spec.final && !G.endless;
    G.wavesSurvived = spec.wave;
    const victory = spec.wave >= TOTAL_WAVES && !G.endless;
    G.nextSpec = victory ? null : waveSpec(spec.wave + 1, G.diffKey);
    G.countdown = victory ? 6.5 : diff().intermission;
    G.clearedHold = victory ? 5.8 : 6.2;
    G.skipHold = 0;
    state.timeLeft = G.countdown;
    state.enemiesRemaining = 0;
    setStage('intermission');
    uiSound('cleared');
    events.emit('gamemode:wave', { wave: spec.wave, phase: 'clear', total: spec.total });
  }

  function onPlayerDied(info) {
    if (!(G.stage in IN_GAME)) return;
    state.deaths++;
    state.streak = 0;
    multiCount = 0;
    if (state.matchType === 'tdm') {
      state.respawnDelay = 2.4;
      state.respawnIn = 2.4;
      matchRespawn = 2.4;
      setStage('match-dead');
      hudVisible(false);
      try { S().player.setMovementEnabled(false); } catch { /* optional */ }
      return;
    }
    addScore(SCORE.enemyTeam, 1);
    resumeStage = G.stage;
    resumeStageT = G.stageT;
    const D = G.death;
    D.final = state.lives <= 0;
    D.killer = '';
    D.distance = 0;
    const src = info?.source;
    if (typeof src === 'string' && src.startsWith('ai')) {
      let label = 'Crimson Vanguard';
      for (const rec of tracked) {
        const a = rec.agent;
        if (src === `ai:${a.id}`) {
          label = `Vanguard ${rec.meta?.role?.label || 'Rifleman'}`;
          if (a.position) D.distance = a.position.distanceTo(S().player.state.position);
          break;
        }
      }
      D.killer = label;
    } else if (info?.type === 'explosion' || /grenade|explos/i.test(String(src || info?.weaponId || ''))) {
      D.killer = 'Explosive';
    } else if (info?.label) D.killer = String(info.label);
    if (!D.distance && info?.position?.isVector3) D.distance = info.position.distanceTo(S().player.state.position);
    D.redeployTotal = D.final ? DEATH_FINAL : DEATH_REDEPLOY;
    D.redeployIn = D.redeployTotal;
    state.respawnDelay = D.final ? 0 : DEATH_REDEPLOY;
    state.respawnIn = D.final ? 0 : DEATH_REDEPLOY;
    setStage('dead');
    if (D.final) {
      // hud game-over state keys off phase 'ended' while the death screen is still up
      const prevPhase = state.phase;
      state.phase = 'ended';
      emitPhase(prevPhase);
    }
    hudVisible(false);
    if (!time.deterministic) slowmo = 1.1;
    uiSound('death');
    events.emit('gamemode:death', { final: D.final, lives: state.lives });
  }

  function redeploy() {
    if (G.stage !== 'dead' || G.death.final) return;
    state.lives--;
    state.respawnIn = 0;
    const sp = spawner.pickPlayerSpawn(S().ai.agents || []) || S().world.spawnPoints?.player?.[0];
    if (sp) respawnPlayer(sp);
    resupply('redeploy');
    // brief spawn protection so a redeploy can't be camped
    try { S().player.setInvulnerable?.(true); spawnProtect = SPAWN_PROTECT; } catch { /* optional */ }
    // hud death screen (if the hud owns it) must not linger over the redeployed player
    try { if (S().hud.menu === 'death') S().hud.closeMenu(); } catch { /* optional */ }
    hudVisible(true);
    const back = resumeStage || 'live';
    const prevPhase = state.phase;
    G.stage = back;
    state.stage = back;
    state.phase = PHASE_OF[back];
    G.stageT = resumeStageT;
    events.emit('gamemode:stage', { stage: back, prev: 'dead' });
    emitPhase(prevPhase);
    G.fade = 0.85;
    notify('Redeployed', { kind: 'info', duration: 1.6 });
  }

  function endMission(victory, reason) {
    if (G.stage === 'ended') return;
    if (G.paused) unpauseInternal();
    wave.active = false;
    state.victory = !!victory;
    const run = { score: state.score.friendly || 0, wave: Math.max(state.wave, 1), kills: state.kills };
    const { newBest, prev } = storage.record(G.diffKey, run);
    if (!victory && wave.spec && (waveLog.length === 0 || waveLog[waveLog.length - 1].wave !== wave.spec.wave)) {
      waveLog.push({ wave: wave.spec.wave, kills: wave.kills, time: wave.liveT, flawless: false, failed: true });
    }
    wave.active = false;
    const Sm = G.summary;
    Sm.victory = !!victory;
    Sm.newBest = newBest;
    Sm.prevBest = prev;
    Sm.persisted = storage.enabled;
    Sm.time = combatTime;
    Sm.rank = rankFor(run.score, G.wavesSurvived, victory);
    const list = [];
    for (const [name, count] of medals) list.push({ name, count });
    list.sort((a, b) => b.count - a.count);
    Sm.medals = list.slice(0, 8);
    Sm.medalKey = list.map((m) => m.name + m.count).join('|');
    Sm.waves = waveLog.slice();
    Sm.wavesKey = waveLog.map((w) => `${w.wave}:${w.kills}:${w.flawless ? 1 : 0}${w.failed ? 1 : 0}`).join('|');
    state.timeLeft = 0;
    setStage('ended');
    hudVisible(false);
    setInputEnabled(false);
    try { S().ai.setEnabled(false); } catch { /* optional */ }
    try { S().player.setMovementEnabled(false); } catch { /* optional */ }
    try { input.unlock?.(); } catch { /* ignore */ }
    if (extUI()) { try { S().hud.closeMenu(); } catch { /* optional */ } }
    resolveObjective();
    cinematic.start(objective, 2.1);
    events.emit('gamemode:end', { victory: !!victory, reason: reason || (victory ? 'victory' : 'defeat'), score: run.score, wave: run.wave });
  }

  function rankFor(score, waves, victory) {
    if (victory && G.diffKey === 'extreme') return 'Iron Vigil';
    if (victory) return 'Plaza Warden';
    if (waves >= 7) return 'Veteran defender';
    if (waves >= 4) return 'Line holder';
    if (waves >= 1) return 'Rifleman';
    return 'Recruit';
  }

  function continueEndless() {
    if (G.stage !== 'ended' || !state.victory) return;
    G.endless = true;
    state.endless = true;
    state.victory = false;
    cinematic.stop();
    hudVisible(true);
    setInputEnabled(true);
    try { S().ai.setEnabled(true); } catch { /* optional */ }
    try { S().player.setMovementEnabled(true); } catch { /* optional */ }
    if (!ctx.flags.shotMode) { try { ctx.ui.requestPointerLock(); } catch { /* ignore */ } }
    G.nextSpec = waveSpec(state.wave + 1, G.diffKey);
    G.countdown = diff().intermission;
    G.bonusLines = [{ label: 'Ammunition restocked', value: 'Endless assault begins', resupply: true }];
    G.bonusKey = 'endless';
    G.lastWave = state.wave;
    G.lastWaveFinal = false;
    G.clearedHold = 4.0;
    resupply('endless');
    setStage('intermission');
  }

  // ------------------------------------------------------------------ pause
  function pause() {
    if (G.paused || !(G.stage in IN_GAME)) return;
    G.paused = true;
    state.paused = true;
    G.pauseOwner = 'gm';
    simFreeze(true);
    setInputEnabled(false);
    hudVisible(false);
    try { input.unlock?.(); } catch { /* ignore */ }
    uiSound('pause');
    events.emit('gamemode:pause', { paused: true });
  }
  function unpauseInternal() {
    if (!G.paused) return;
    G.paused = false;
    state.paused = false;
    pendingResume = 0;
    if (G.pauseOwner === 'gm') simFreeze(false);
    G.pauseOwner = null;
    setInputEnabled(true);
    events.emit('gamemode:pause', { paused: false });
  }
  function resume() {
    if (!G.paused) return;
    if (!ctx.flags.shotMode && !input.locked) {
      // resume once pointer lock is granted (input:lock); fall back to unlocked play after a moment
      pendingResume = 0.7;
      try { ctx.ui.requestPointerLock(); } catch { /* ignore */ }
      return;
    }
    unpauseInternal();
    hudVisible(true);
  }

  function restart() {
    if (G.paused) unpauseInternal();
    G.fade = 1;
    beginMission({ teleport: true });
    if (!ctx.flags.shotMode) { try { ctx.ui.requestPointerLock(); } catch { /* ignore */ } }
  }

  function setDifficulty(key) {
    if (!DIFFICULTY_ORDER.includes(key)) return;
    ctx.settings.set('gameplay.difficulty', key);
    if (G.stage === 'menu') { G.diffKey = key; state.difficulty = key; }
  }

  function setMode(mode) {
    if (!['protection', 'tdm'].includes(mode)) return false;
    if (!(G.stage === 'menu' || G.stage === 'ended')) return false;
    state.matchType = mode;
    state.mode = mode === 'protection' ? MODE_ID : mode;
    state.playerTeam = mode === 'tdm' ? 'blue' : 'player';
    events.emit('gamemode:mode', { mode });
    return true;
  }

  function setSetting(path, v) {
    ctx.settings.set(path, v);
    try {
      if (path.startsWith('audio.')) S().audio.setVolume(path.slice(6), v);
      if (path === 'graphics.quality') S().postfx.setQuality(v);
    } catch { /* optional */ }
  }

  // ------------------------------------------------------------------ per-frame logic
  function updateLive(dt) {
    wave.liveT += dt;
    if (G._announceAt > 0 && wave.liveT >= G._announceAt) { G._announceAt = 0; announceWave(); }
    combatTime += dt;
    G.bannerT += dt;
    const spec = wave.spec;
    const ai = S().ai;

    // poll hostiles: death fallback, fall-out, stall handling
    for (let i = tracked.length - 1; i >= 0; i--) {
      const rec = tracked[i];
      const a = rec.agent;
      if (!a.alive) { markDown(rec); continue; }
      if (a.position) {
        if (a.position.y < (S().world.bounds?.min?.y ?? -1) - 25) { markDown(rec); continue; }
        if (a.position.distanceToSquared(rec.lastPos) > 1) { rec.lastPos.copy(a.position); rec.stillT = 0; } else rec.stillT += dt;
      }
    }
    const sinceKill = wave.liveT - wave.lastKillT;
    if (wave.toSpawn === 0 && state.enemiesAlive > 0 && state.enemiesAlive <= 3 && sinceKill > STALL_REVEAL) {
      for (const rec of tracked) {
        if (rec.revealed) continue;
        rec.revealed = true;
        try { ai.reveal?.(rec.agent); } catch { /* optional */ }
        events.emit('gamemode:reveal', { agent: rec.agent });
        try {
          const h = S().hud;
          if (h.revealEnemy) h.revealEnemy(rec.agent, 30);
          else h.ping?.(rec.agent.position, { kind: 'enemy', duration: 30 });
        } catch { /* optional */ }
      }
      if (!G._revealNotified) { G._revealNotified = true; notify('Remaining hostiles marked', { kind: 'warning', duration: 2.5 }); }
    }
    if (wave.toSpawn === 0 && sinceKill > STALL_REMOVE) {
      for (let i = tracked.length - 1; i >= 0; i--) {
        const rec = tracked[i];
        try { ai.despawn?.(rec.agent); } catch { /* optional */ }
        markDown(rec);
      }
    }

    // kill-credit fallback when ai:death reports player kills that combat:kill did not
    const deficit = aiPlayerDeaths - combatPlayerKills - fallbackCredited;
    if (deficit > 0 && time.t - lastAiDeathT > 0.3) {
      for (let k = 0; k < deficit; k++) creditKill({ zone: 'torso' });
      fallbackCredited += deficit;
    }

    // spawning
    if (wave.toSpawn > 0) {
      wave.spawnTimer -= dt;
      const room = spec.maxAlive - state.enemiesAlive;
      if (wave.spawnTimer <= 0 && room > 0) {
        const flank = wave.squads > 0 && rng.next() < spec.flankChance;
        let size = spec.squadMin + Math.floor(rng.next() * (spec.squadMax - spec.squadMin + 1));
        size = Math.min(size, room, wave.toSpawn);
        // shot/showcase scenarios may pin squad anchors (G._spawnAt, consumed in order) for readable framing
        const pk = G._spawnAt?.length ? spawner.pinned(G._spawnAt.shift()) : spawner.pick({ flank, t: time.t, visible: G._preferVisible === true });
        let spawned = 0;
        if (pk) {
          G._spawning = true;
          let res;
          try {
            res = spawner.spawnSquad({
              pick: pk, size, spec, objective, wave: spec.wave,
              onAgent: (agent, meta) => track(agent, meta),
            });
          } finally { G._spawning = false; }
          spawned = res.spawned;
          if (spawned > 0) {
            wave.squads++;
            wave.toSpawn -= spawned;
            wave.failStreak = 0;
            if (pk.flank) {
              G.flankBearing = pk.bearing;
              if (G.bannerT > 4.3 || G.hudBanner) notify(`Flanking movement · ${pk.bearing}`, { kind: 'warning', duration: 2.6 });
              events.emit('gamemode:flank', { bearing: pk.bearing, count: spawned });
            }
          }
        }
        if (spawned === 0) {
          wave.failStreak++;
          if (!pk || wave.failStreak >= 3) {
            // AI can't spawn (stub, broken, or no spawn points): drop the rest so the wave can finish
            wave.dropped += wave.toSpawn;
            wave.toSpawn = 0;
          }
        }
        wave.spawnTimer = spawned > 0 ? spec.spawnInterval * (0.75 + rng.next() * 0.5) : 1.5;
      }
    }
    refreshRemaining();

    if (wave.toSpawn === 0 && state.enemiesAlive === 0 && wave.liveT >= MIN_LIVE) waveCleared();
  }

  function updateSkip(dt) {
    if (input.isDown('interact')) G.skipHold = Math.min(1, G.skipHold + dt / 0.9);
    else G.skipHold = Math.max(0, G.skipHold - dt * 3);
    if (G.skipHold >= 1) { G.countdown = 0; G.skipHold = 0; }
  }

  function update(dt) {
    // UI clock: fixed steps in deterministic mode, wall clock otherwise (keeps animating while paused)
    let uiDt;
    if (time.deterministic) uiDt = time.fixedStep;
    else {
      const r = time.real;
      uiDt = lastReal < 0 ? 0 : Math.min(0.1, Math.max(0, r - lastReal));
      lastReal = r;
    }
    G.uiT += uiDt;

    if (G.stage === 'sandbox') return;

    // slow motion on death (interactive only)
    if (slowmo > 0) {
      slowmo -= uiDt;
      if (!G.paused) time.scale = slowmo > 0 ? 0.35 + 0.65 * Math.max(0, 1 - slowmo / 1.1) ** 2 : 1;
      if (slowmo <= 0) time.scale = 1;
    }

    if (pendingResume > 0) {
      pendingResume -= uiDt;
      if (input.locked || pendingResume <= 0) { unpauseInternal(); hudVisible(true); }
    }

    // edge-triggered game inputs
    G.ext = extUI();
    if (!G.ext && (G.stage in IN_GAME) && !G.paused && input.pressed('pause')) pause();
    G.scoreboard = input.isDown('scoreboard');

    G.stageT += G.paused ? 0 : (G.stage === 'menu' || G.stage === 'ended' || G.stage === 'dead' || G.stage === 'deploying' ? uiDt : dt);

    if (spawnProtect > 0 && !G.paused) {
      spawnProtect -= dt;
      if (spawnProtect <= 0) { try { S().player.setInvulnerable?.(false); } catch { /* optional */ } }
    }

    switch (G.stage) {
      case 'menu':
        G.menuT += uiDt;
        break;
      case 'deploying':
        deployT += uiDt;
        G.fade = Math.min(1, deployT / 0.55);
        if (deployT >= 0.7) beginMission({ teleport: true });
        break;
      case 'warmup':
        if (!G.paused) {
          G.fade = Math.max(0, 1 - Math.max(0, G.stageT - 0.25) / 1.4);
          G.countdown -= dt;
          if (G.stageT > G.cdStart) updateSkip(dt);
          state.timeLeft = Math.max(0, G.countdown);
          if (G.countdown <= 0) startWave(1);
        }
        break;
      case 'live':
        if (!G.paused) {
          G.fade = Math.max(0, G.fade - uiDt * 1.6);
          updateLive(dt);
        }
        break;
      case 'intermission':
        if (!G.paused) {
          G.fade = Math.max(0, G.fade - uiDt * 1.6);
          combatTime += dt;
          G.countdown -= dt;
          if (G.stageT > 1.0 && !G.lastWaveFinal) updateSkip(dt);
          state.timeLeft = Math.max(0, G.countdown);
          if (G.countdown <= 0) {
            if (G.lastWaveFinal) endMission(true, 'victory');
            else startWave(state.wave + 1);
          }
        }
        break;
      case 'dead': {
        const D = G.death;
        if (!G.paused) {
          D.redeployIn -= uiDt;
          state.respawnIn = D.final ? 0 : Math.max(0.001, D.redeployIn);
          if (D.final) {
            if (G.stageT >= D.redeployTotal) endMission(false, 'overrun');
          } else if (D.redeployIn <= 0 || (G.stageT > 1.2 && (input.pressed('jump') || input.pressed('interact')))) {
            redeploy();
          }
        }
        break;
      }
      case 'match-live':
        if (!G.paused) {
          state.matchTime += dt;
          updateMatchBotRespawns(dt);
          state.enemiesAlive = (S().ai.agents || []).filter((a) => a.alive && a.team === 'red').length;
          state.enemiesRemaining = state.enemiesAlive;
        }
        break;
      case 'match-dead':
        if (!G.paused) {
          state.matchTime += dt;
          updateMatchBotRespawns(dt);
          matchRespawn = Math.max(0, matchRespawn - dt);
          state.respawnIn = matchRespawn;
          if (matchRespawn <= 0) {
            const sp = matchSpawnForPlayer(S().ai.agents || []);
            if (sp) respawnPlayer(sp);
            resupply('match respawn');
            try { S().player.setInvulnerable?.(true); spawnProtect = SPAWN_PROTECT; } catch { /* optional */ }
            state.respawnIn = 0;
            setStage('match-live');
            hudVisible(true);
          }
        }
        break;
      default:
        break;
    }

    syncHudMatch();
    if (view) view.update(G, uiDt);
  }

  /**
   * Drive the hud's match panel (top-left) through hud.setMatchInfo overrides, only when a value changes:
   * warmup hides the wave row and shows the assault timer (instead of "wave 00 · 0 hostiles"), intermission shows the
   * next-wave timer; live combat clears the overrides so the hud reads state.enemiesRemaining directly.
   */
  const hudMatch = { wave: undefined, hostiles: undefined, timer: undefined };
  let hudMatchKey = '';
  let hudMatchStage = '';
  let hudMatchSec = -1;
  let hudMatchScore = '';
  function syncHudMatch() {
    const h = S().hud;
    if (typeof h.setMatchInfo !== 'function') return;
    const timed = G.stage === 'warmup' || G.stage === 'intermission';
    const sec = timed ? Math.max(0, Math.ceil(G.countdown - 1e-6)) : -1;
    const matchScore = state.matchType === 'tdm' ? `${state.score.blue}:${state.score.red}` : `${state.score.player}`;
    if (G.stage === hudMatchStage && sec === hudMatchSec && hudMatchKey === (timed ? state.wave : -1) && hudMatchScore === matchScore) return;
    hudMatchStage = G.stage;
    hudMatchSec = sec;
    hudMatchKey = timed ? state.wave : -1;
    hudMatchScore = matchScore;
    if (state.matchType === 'tdm') {
      hudMatch.wave = 'TDM';
      hudMatch.hostiles = null;
      hudMatch.timer = `FIRST TO ${state.scoreLimit}`;
      hudMatch.objective = `BLUE ${state.score.blue} — RED ${state.score.red}`;
    } else if (G.stage === 'warmup') {
      hudMatch.wave = null; // hide the wave row (a changing wave number would also trigger the hud's auto banner)
      hudMatch.hostiles = null;
      hudMatch.timer = `Assault in ${fmtClock(sec)}`;
      hudMatch.objective = objectiveText();
    } else if (G.stage === 'intermission') {
      hudMatch.wave = state.wave;
      hudMatch.hostiles = null;
      hudMatch.timer = G.lastWaveFinal ? 'Relief column inbound' : `Next wave in ${fmtClock(sec)}`;
      hudMatch.objective = objectiveText();
    } else {
      hudMatch.wave = undefined;
      hudMatch.hostiles = undefined;
      hudMatch.timer = undefined;
      hudMatch.objective = objectiveText();
    }
    try { h.setMatchInfo(hudMatch); } catch (e) { ctx.reportError('gamemode', 'hud.setMatchInfo', e); }
  }

  function lateUpdate() {
    if (cinematic.active) cinematic.apply(G.uiT);
  }

  // ------------------------------------------------------------------ event wiring
  const off = [];
  function on(name, fn) { events.on(name, fn); off.push([name, fn]); }

  function wireEvents() {
    on('combat:kill', (e) => {
      if (state.matchType === 'tdm') { awardMatchKill(e); return; }
      if (!isPlayerSource(e?.source)) return;
      const team = e.target?.team;
      if (team === 'player' || team === 'friendly') return;
      if (G.stage === 'sandbox') { addScore(SCORE.friendlyTeam, SCORE.kill); state.kills++; return; }
      if (!(G.stage in IN_GAME) || resetting) return;
      combatPlayerKills++;
      creditKill(e);
    });
    on('ai:death', (e) => {
      if (resetting) return;
      if (state.matchType === 'tdm' && (G.stage === 'match-live' || G.stage === 'match-dead') && e?.agent?.matchRoster) {
        matchBotRespawns.push({ roster: e.agent.matchRoster, remaining: 2.4 });
      }
      const rec = e?.agent ? byAgent.get(e.agent) : null;
      if (rec) markDown(rec);
      if ((G.stage in IN_GAME) && isPlayerSource(e?.info?.source)) { aiPlayerDeaths++; lastAiDeathT = time.t; }
    });
    on('ai:spawn', (e) => {
      // agents spawned by someone else during a wave (e.g. AI reinforcement logic) count toward it
      const a = e?.agent;
      if (!a || byAgent.has(a) || !wave.active || G._spawning) return;
      if (a.team && a.team !== 'enemy') return;
      track(a, null);
      wave.spec.total++;
      refreshRemaining();
    });
    on('player:died', (e) => onPlayerDied(e?.info));
    // ---- hud-owned menus drive the flow (README: coexistence protocol)
    on('hud:play', () => {
      if (G.stage === 'menu' || G.stage === 'boot') beginMission({ teleport: true });
    });
    on('hud:pause', (e) => {
      const p = !!e?.paused;
      if (p === G.paused) return;
      if (p && !(G.stage in IN_GAME)) return;
      G.paused = p;
      state.paused = p;
      G.pauseOwner = p ? 'hud' : null;
      events.emit('gamemode:pause', { paused: p });
    });
    on('player:damaged', (e) => { if (wave.active) wave.damageTaken += e?.amount || 0; });
    on('weapon:fired', () => {
      if (!(G.stage in IN_GAME)) return;
      state.shotsFired++;
      shotHitCounted = false;
    });
    on('combat:hit', (e) => {
      if (!(G.stage in IN_GAME) || shotHitCounted || !e?.target || !isPlayerSource(e.source)) return;
      shotHitCounted = true;
      state.shotsHit++;
    });
    on('input:lock', ({ locked }) => {
      if (ctx.flags.shotMode || extUI()) return;
      if (!locked && (G.stage in IN_GAME) && !G.paused && S().player.state?.alive !== false) pause();
      else if (locked && G.paused) { unpauseInternal(); hudVisible(true); }
    });
  }

  function onKeyDown(e) {
    if (e.code === 'Escape' && (G.stage in IN_GAME) && !G.paused && !input.locked && S().player.state?.alive !== false && !ctx.flags.shotMode && !extUI()) pause();
  }

  // ------------------------------------------------------------------ shots / tests
  function scenario(o = {}) {
    const sc = o.scenario || 'menu';
    if (o.difficulty) ctx.settings.set('gameplay.difficulty', o.difficulty);
    if (sc === 'menu') { openMenu(); G.menuT = o.stageTime ?? 1.5; return; }
    beginMission({ teleport: o.teleport ?? !ctx.shot?.player, warmup: o.warmup });
    if (o.invulnerable) { try { S().player.setInvulnerable?.(true); } catch { /* optional */ } }
    const st = o.stats || {};
    const applyStats = () => {
      for (const k of ['kills', 'headshots', 'deaths', 'bestStreak', 'streak', 'shotsFired', 'shotsHit']) if (st[k] !== undefined) state[k] = st[k];
      if (st.score !== undefined) { state.score.friendly = st.score; state.xp = st.score; }
      if (st.lives !== undefined) state.lives = st.lives;
      if (st.medals) for (const [n, c] of Object.entries(st.medals)) medals.set(n, c);
      if (st.combatTime !== undefined) combatTime = st.combatTime;
      // keep the hud's own tallies (pause/death screens read them) consistent with the scenario
      const hs = S().hud.stats;
      if (hs && typeof hs === 'object') {
        for (const k of ['kills', 'headshots', 'deaths', 'bestStreak', 'streak', 'shotsFired', 'shotsHit']) if (st[k] !== undefined && k in hs) hs[k] = st[k];
        if (st.score !== undefined && 'score' in hs) hs.score = st.score;
        if ('combatTime' in hs) hs.combatTime = st.combatTime ?? (40 + (o.wave || 1) * 38);
      }
    };
    const synthLog = (upTo, failedLast) => {
      // plausible per-wave kill split for capture scenarios (sums to stats.kills)
      waveLog.length = 0;
      const lastK = failedLast ? Math.min(3, st.kills ?? 0) : 0;
      const total = (st.kills ?? 0) - lastK;
      const n = failedLast ? upTo - 1 : upTo;
      let weight = 0;
      for (let i = 1; i <= n; i++) weight += waveSpec(i, G.diffKey).total;
      let left = total;
      for (let i = 1; i <= n; i++) {
        const k = i === n ? left : Math.min(left, Math.round((total * waveSpec(i, G.diffKey).total) / Math.max(1, weight)));
        left -= k;
        waveLog.push({ wave: i, kills: k, time: 40 + i * 9, flawless: i % 3 === 1, failed: false });
      }
      return lastK;
    };
    applyStats();
    if (sc === 'intro') { G.stageT = o.stageTime ?? 0; return; }
    const w = o.wave || 1;
    G.wavesSurvived = Math.max(0, w - 1);
    if (o.preferVisible) G._preferVisible = true;
    if (Array.isArray(o.spawnAt)) G._spawnAt = o.spawnAt.slice();
    if (sc === 'live') {
      startWave(w, o.announceAt > 0);
      if (o.announceAt > 0) { G._announceAt = o.announceAt; G.bannerT = 99; }
      if (o.spawnNow) wave.spawnTimer = 0;
      if (o.bannerTime !== undefined) G.bannerT = o.bannerTime;
      G.fade = 0;
      return;
    }
    if (sc === 'intermission') {
      startWave(w, true);
      wave.kills = st.waveKills ?? 0;
      wave.liveT = o.waveTime ?? 58 + w * 6;
      wave.shots0 = state.shotsFired - (st.waveShots ?? 0);
      wave.hits0 = state.shotsHit - (st.waveHits ?? 0);
      wave.heads0 = state.headshots - (st.waveHeads ?? 0);
      wave.damageTaken = o.flawless ? 0 : 1;
      wave.toSpawn = 0;
      waveCleared();
      G.fade = 0;
      if (o.stageTime !== undefined) G.stageT = o.stageTime;
      applyStats();
      return;
    }
    if (sc === 'dead' || sc === 'ended') {
      startWave(w, true);
      G.fade = 0;
      applyStats();
      if (sc === 'ended') {
        wave.kills = synthLog(w, !o.victory);
        if (o.victory) { G.wavesSurvived = w; wave.spec = null; }
      }
      if (sc === 'dead') {
        if (o.final) state.lives = 0;
        const info = { source: 'scenario', label: o.killer || 'Vanguard Gunner', killer: o.killer || 'Vanguard Gunner' };
        const P = S().player;
        try { if (typeof P.kill === 'function') P.kill(info); } catch (e) { ctx.reportError('gamemode', 'player.kill', e); }
        if (G.stage !== 'dead') onPlayerDied(info);
        if (o.distance) G.death.distance = o.distance;
        if (o.stageTime !== undefined) { G.stageT = o.stageTime; G.death.redeployIn = G.death.redeployTotal - o.stageTime; }
        return;
      }
      endMission(!!o.victory, o.victory ? 'victory' : 'overrun');
      if (o.stageTime !== undefined) G.stageT = o.stageTime;
      if (o.newBest) G.summary.newBest = true;
      if (o.prevBest) G.summary.prevBest = o.prevBest;
    }
    if (sc === 'pause') {
      startWave(w, true);
      G.fade = 0;
      G.bannerT = 99;
      applyStats();
      if (extUI()) {
        G.paused = true;
        state.paused = true;
        try { S().hud.openMenu('pause'); } catch (e) { ctx.reportError('gamemode', 'hud.openMenu', e); }
      } else pause();
    }
  }

  // ------------------------------------------------------------------ service
  const api = {
    state,
    start(mode = state.matchType || 'protection', opts = {}) {
      if (mode === 'sandbox') {
        clearHostiles();
        cinematic.stop();
        setStage('sandbox');
        state.mode = 'sandbox';
        return;
      }
      setMode(['protection', 'tdm'].includes(mode) ? mode : 'protection');
      if (opts.difficulty) setDifficulty(opts.difficulty);
      if (G.stage === 'warmup' && G.stageT === 0) return; // already started this frame (hud:play + start)
      beginMission(opts);
    },
    end(reason = 'ended') {
      // 'quit' (hud pause menu → main menu) abandons the run without a summary
      if (reason === 'quit' || reason === 'menu') { openMenu({ fromHud: true }); return; }
      endMission(reason === 'victory', reason);
    },
    addScore,
    // ---- extensions (optional for consumers: use ?.())
    pause,
    resume,
    restart,
    openMenu,
    deploy,
    redeploy,
    respawn: redeploy,
    setDifficulty,
    setMode,
    continueEndless,
    skipIntermission() { if (G.stage === 'intermission' || G.stage === 'warmup') G.countdown = 0; },
    scenario,
    /** Register an agent spawned outside the wave director so it counts toward the current wave. */
    trackAgent(agent) { if (wave.active && agent) { track(agent, null); wave.spec.total++; refreshRemaining(); } },
    get flow() { return G; },
    difficulties: DIFFICULTY_ORDER.map((k) => ({ key: k, label: difficulty(k).label })),
  };

  return {
    name: 'gamemode',
    async init() {
      ctx.services.provide('gamemode', api);
      wireEvents();
      G.diffKey = ctx.settings.get('gameplay.difficulty', 'regular');
      state.difficulty = G.diffKey;
      events.emit('gamemode:mode', { mode: state.matchType });
      if (sandboxOnly) {
        // keep other systems' captures untouched; still score kills for sandbox HUDs
        return;
      }
      ctx.ui.setBootOverlayEnabled(false);
      G.ext = extUI();
      view = createView(ctx, {
        deploy, resume, restart, setDifficulty, setSetting, redeploy, continueEndless,
        quitToMenu: () => { uiSound('back'); openMenu(); },
        uiSound,
      });
      view.mount();
      window.addEventListener('keydown', onKeyDown);
      if (shotCfg) scenario(shotCfg);
      else openMenu({ fromHud: extUI() });
      view.update(G, 0);
    },
    update,
    lateUpdate,
    dispose() {
      for (const [n, fn] of off) events.off(n, fn);
      off.length = 0;
      window.removeEventListener('keydown', onKeyDown);
      cinematic.stop();
      view?.dispose();
      view = null;
      if (!time.deterministic) time.scale = 1;
    },
  };
}

function fmtClock(sec) {
  const s = Math.max(0, Math.ceil(sec - 1e-6));
  return `${Math.floor(s / 60)}:${s % 60 < 10 ? '0' : ''}${s % 60}`;
}

function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Candidate audio names for UI cues (first one the audio system lists is used). */
const UI_SOUNDS = {
  hover: ['ui_hover', 'ui_tick', 'ui_move'],
  select: ['ui_select', 'ui_click', 'ui_confirm'],
  back: ['ui_back', 'ui_cancel', 'ui_click'],
  deploy: ['ui_deploy', 'ui_confirm', 'ui_select'],
  wave: ['wave_start', 'gamemode_wave_start', 'ui_alert'],
  cleared: ['wave_clear', 'gamemode_wave_clear', 'ui_success'],
  death: ['player_death', 'ui_death'],
  pause: ['ui_pause', 'ui_click'],
};

/**
 * hud — HUD & menus for Opus of Duty. Owner: hud agent.
 *
 * DOM lives in ctx.ui.hudRoot (#hud: gameplay HUD) and ctx.ui.uiRoot (#ui: menus). Everything is
 * scaled by a single `--u` unit (1 u = 1 px at 1080p) and animated from the UI clock (sim-time based
 * in shot mode, so shots stay bit-identical). DOM writes are cached: a node is only touched when its
 * value actually changes.
 *
 * services.hud (contract + extensions):
 *   root: HTMLElement
 *   setVisible(bool)
 *   hitmarker('hit'|'headshot'|'kill')
 *   damageIndicator(sourcePos: Vector3 | null, strength = 1)
 *   notify(text, { kind?: 'info'|'xp'|'medal'|'streak'|'wave'|'banner'|'warning'|'objective', duration?, sub?, points?, tier?, icon? })
 *   killfeed({ killer, victim, weapon, headshot, killerTeam?, victimTeam?, kind? })
 *   setCrosshairSpread(deg)
 *   setObjective(text, { position? })
 *   --- extensions (use with ?.()) ---
 *   scorePopup(points, label)             '+100 KILL' style popup
 *   medal({ title, sub?, kind?, tier?, count? })
 *   banner(title, { sub?, kicker?, warn?, duration? })
 *   setInteraction(text | null, { key?, action?, progress? })   center interaction prompt
 *   ping(position, { duration?, kind?: 'enemy'|'ping'|'obj' })   reveal a point on the minimap/compass
 *   revealEnemy(agentOrId, seconds = 3)
 *   setMatchInfo({ wave?, hostiles?, objective?, timer?, lives?: {left, max}, modeName? })   overrides
 *   openMenu('main'|'pause'|'settings'|'controls'|'death') / closeMenu() / menu (current screen name)
 *   rebakeMinimap()
 *   stats: { kills, headshots, deaths, shotsFired, shotsHit, streak, bestStreak, score }
 *
 * Events emitted: 'hud:menu' {screen, open}, 'hud:play', 'hud:pause' {paused}, 'hud:restart',
 *                 'hud:quit', 'hud:respawn'. See README.md in this folder.
 */
import * as THREE from 'three';
import { CSS } from './style.js';
import { el, setOpacity, clamp, clamp01, damp, wrapPi, hash01 } from './util.js';
import { createCompass } from './compass.js';
import { createMinimap } from './minimap.js';
import { createCenter } from './center.js';
import { createFeed } from './feed.js';
import { createPanels } from './panels.js';
import { createMenus } from './menus.js';
import { getPlayerName } from './account.js';

const SURNAMES = ['Drazen', 'Kovac', 'Merak', 'Sokol', 'Brankov', 'Tesar', 'Vukan', 'Radan', 'Lazar', 'Horak', 'Petrak', 'Zoran',
  'Ilko', 'Marek', 'Dusan', 'Kiril', 'Bogdan', 'Stanek', 'Oren', 'Varga', 'Nemec', 'Rusev', 'Talin', 'Juric'];
const ROLE = { rifle: 'Rifleman', smg: 'Assaulter', lmg: 'Gunner', shotgun: 'Breacher', sniper: 'Marksman' };
const HM_PRIO = { hit: 0, headshot: 1, kill: 2, killhs: 3 };
const DEFAULT_BINDINGS_FALLBACK = {};
const EMPTY = [];

export default function createSystem(ctx) {
  const { events } = ctx;
  const listeners = [];
  const on = (name, fn) => {
    events.on(name, fn);
    listeners.push([name, fn]);
  };

  // ---------------------------------------------------------------------------------- shared hud ctx
  const hud = {
    ctx,
    layer: null,
    uiLayer: null,
    u: 1,
    dpr: 1,
    viewW: 1920,
    viewH: 1080,
    uiTime: 0,
    mode: 'play', // 'boot' | 'play' | 'pause' | 'dead'
    visible: true,
    minimap: null,
    stats: { kills: 0, headshots: 0, deaths: 0, shotsFired: 0, shotsHit: 0, streak: 0, bestStreak: 0, score: 0, best: 0, combatTime: 0 },
    deathInfo: { killer: '', faction: '', weaponId: '', weaponName: '', kind: '', distance: null },
  };

  let compass, minimap, center, feed, panels, menus;
  let styleEl = null;
  let fpsEl = null;
  let matchHudEl = null;
  let fpsElapsed = 0;
  let fpsFrames = 0;
  let lastReal = -1;
  let combatIdle = 99;
  let objectiveOverride = null;
  let objectivePos = null;
  const matchOverride = {};
  const auto = { feed: true, xp: true, medal: true, banner: true };
  const pendingKills = [];
  const revealed = new Map(); // agent id -> until (uiTime)
  const pings = []; // {x, z, until, kind, born}
  const blips = [];
  for (let i = 0; i < 48; i++) blips.push({ x: 0, z: 0, alpha: 0, kind: 'enemy', age: 0 });
  const compassItems = [];
  for (let i = 0; i < 10; i++) compassItems.push({ kind: 'enemy', bearing: 0, alpha: 0, clampEdge: false });
  let hmFrame = -1;
  let hmKind = 'hit';
  let multi = { count: 0, last: -99 };
  let lastWave = null;
  let pendingLock = null; // 'play' | 'resume'
  let pendingLockAge = 0;
  let matchAssetsReady = false;
  let matchLockAcquired = false;
  let timeScaleSaved = null;
  let deathTimer = -1;
  let userGestured = false;
  let lastSpreadCall = -99;
  const playerPosPrev = new THREE.Vector3();
  const tmpV = new THREE.Vector3();

  // ------------------------------------------------------------------------------------ helpers
  function enemyName(target) {
    if (!target) return 'Hostile';
    if (target.name && !/^(ai[_:-]?\d+|agent|mesh|group|object)/i.test(target.name)) return target.name;
    const id = target.key ?? target.id ?? target.object?.id ?? 0;
    const s = SURNAMES[Math.floor(hash01(String(id)) * SURNAMES.length)];
    hud.enemyNames.add(s);
    return s;
  }
  hud.enemyNames = new Set();
  hud.isPlayerName = (n) => n === getPlayerName() || n === 'You' || n === 'player';
  hud.isEnemyName = (n) => hud.enemyNames.has(n) || /vanguard|hostile|enemy/i.test(n);

  function findAgent(source) {
    if (source == null) return null;
    const agents = ctx.services.ai.agents || EMPTY;
    const s = String(source);
    const m = /(\d+)$/.exec(s);
    const id = m ? Number(m[1]) : null;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a === source || a.id === source || String(a.id) === s || (id != null && a.id === id) || a.key === s) return a;
    }
    for (const a of api.debugAgents) if (a === source || a.id === source) return a;
    return null;
  }

  function agentName(agent, fallbackSource) {
    if (agent) {
      if (agent.name && typeof agent.name === 'string') return agent.name;
      const s = SURNAMES[Math.floor(hash01(String(agent.id)) * SURNAMES.length)];
      hud.enemyNames.add(s);
      return s;
    }
    if (fallbackSource && String(fallbackSource).startsWith('ai')) {
      const s = SURNAMES[Math.floor(hash01(String(fallbackSource).replace(/\D/g, '')) * SURNAMES.length)];
      hud.enemyNames.add(s);
      return s;
    }
    return 'Unknown';
  }

  function onResize() {
    const w = window.innerWidth || ctx.engine.width || 1920;
    const h = window.innerHeight || ctx.engine.height || 1080;
    const scale = clamp(Number(ctx.settings.get('hud.scale', 1)) || 1, 0.6, 1.5);
    hud.viewW = w;
    hud.viewH = h;
    hud.u = Math.min(w / 1920, h / 1080);
    hud.dpr = ctx.flags.shotMode ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    if (hud.layer) hud.layer.style.setProperty('--u', `${(hud.u * scale).toFixed(5)}px`);
    if (hud.uiLayer) hud.uiLayer.style.setProperty('--u', `${hud.u.toFixed(5)}px`);
    hud.u *= 1; // UI layer uses the unscaled unit, the HUD uses u*scale via hudU
    hud.hudU = hud.u * scale;
    minimap?.resize();
  }
  hud.onResize = onResize;

  // ------------------------------------------------------------------------------ mode / pause
  const interactive = !ctx.flags.shotMode;

  hud.applyPause = () => {
    if (!interactive) return;
    const scr = menus?.screen ?? 'none';
    const freezeWorld = scr === 'entry' || scr === 'main' || scr === 'pause' || scr === 'settings' || scr === 'resume' || scr === 'loading';
    const pauseMatch = freezeWorld || scr === 'replay';
    if (freezeWorld && timeScaleSaved == null) {
      timeScaleSaved = ctx.time.scale || 1;
      ctx.time.scale = 0;
    } else if (!freezeWorld && timeScaleSaved != null) {
      ctx.time.scale = timeScaleSaved;
      timeScaleSaved = null;
    }
    if (hud.matchPaused !== pauseMatch) {
      hud.matchPaused = pauseMatch;
      events.emit('hud:pause', { paused: pauseMatch });
    }
  };

  function gesture() {
    if (userGestured) return;
    userGestured = true;
    events.emit('core:user-gesture');
    try { ctx.services.audio.resume?.(); } catch { /* ignore */ }
  }

  async function waitForMatchAssets() {
    const startedAt = performance.now();
    menus.setLoadingMessage('Loading world, materials, weapons, and effects…');
    const readiness = [ctx.services.world?.ready, ctx.services.materials?.ready].filter(Boolean);
    await Promise.allSettled(readiness);
    let idleFrames = 0;
    while (idleFrames < 2) {
      await ctx.assets?.whenIdle?.();
      await new Promise(requestAnimationFrame);
      idleFrames = (ctx.assets?.pending?.size || 0) === 0 ? idleFrames + 1 : 0;
    }
    while (performance.now() - startedAt < 400) await new Promise(requestAnimationFrame);
    const failures = ctx.assets?.failed?.length || 0;
    menus.setLoadingMessage(failures
      ? 'Some assets were unavailable; fallback content is ready.'
      : 'All currently requested match assets are ready.');
  }

  hud.requestPlay = () => {
    gesture();
    if (!interactive) {
      finishPlay();
      return;
    }
    if (pendingLock === 'play') return;
    pendingLock = 'play';
    pendingLockAge = 0;
    matchAssetsReady = false;
    matchLockAcquired = false;
    menus.openLoading();
    // This is still inside the mode-selection click gesture, so the browser can grant pointer lock
    // while assets load instead of requiring a second Deploy/Continue click afterward.
    try { ctx.ui.requestPointerLock(); } catch { /* fallback: match still auto-deploys when ready */ }
    waitForMatchAssets().then(() => {
      matchAssetsReady = true;
      pendingLock = null;
      finishPlay();
    }).catch((err) => {
      ctx.reportError('hud', 'match-preload', err);
      matchAssetsReady = true;
      menus.setLoadingMessage('Preload finished · Deploying with available assets');
      pendingLock = null;
      finishPlay();
    });
  };
  function finishPlay() {
    pendingLock = null;
    const first = hud.mode === 'boot';
    hud.mode = 'play';
    menus.close();
    try { ctx.services.ai.setEnabled?.(true); } catch { /* ignore */ }
    try { ctx.services.player.setMovementEnabled?.(true); } catch { /* ignore */ }
    if (first) {
      events.emit('hud:play', {});
      const gm = ctx.services.gamemode;
      if (gm.state?.phase === 'ended') gm.start?.();
    }
  }
  hud.requestResume = () => {
    gesture();
    pendingLock = 'resume';
    pendingLockAge = 0;
    ctx.ui.requestPointerLock();
    if (!interactive) {
      hud.mode = 'play';
      menus.close();
    }
  };
  hud.requestRestart = () => {
    resetStats();
    events.emit('hud:restart', {});
    try { ctx.services.gamemode.start?.(ctx.services.gamemode.state?.mode); } catch (e) { ctx.reportError('hud', 'restart', e); }
    hud.mode = 'play';
    menus.close();
    hud.requestResume();
  };
  hud.requestQuit = () => {
    events.emit('hud:quit', {});
    try { ctx.services.gamemode.end?.('quit'); } catch { /* ignore */ }
    hud.mode = 'boot';
    resetStats();
    try { ctx.input.unlock?.(); } catch { /* ignore */ }
    menus.open('entry');
  };
  hud.showMatchResult = () => {
    pendingLock = null;
    hud.mode = 'pause';
    menus.close();
    try { ctx.input.unlock?.(); } catch { /* ignore */ }
  };
  hud.requestRespawn = () => {
    events.emit('hud:respawn', {});
    try { ctx.services.gamemode.respawn?.(); } catch { /* ignore */ }
  };
  hud.isGameOver = () => ctx.services.gamemode.state?.matchType !== 'tdm' && ctx.services.gamemode.state?.phase === 'ended' && hud.mode === 'dead';
  hud.respawnStatus = () => {
    const s = ctx.services.gamemode.state || {};
    const rem = s.respawnIn ?? s.respawnTime ?? s.respawnTimer;
    const tot = s.respawnDelay ?? s.respawnTotal ?? 5;
    const lm = matchInfo().lives;
    const lives = lm && lm.max > 0 ? lm.left : null;
    if (typeof rem === 'number' && Number.isFinite(rem) && rem > 0) return { remaining: rem, progress: 1 - rem / tot, lives };
    return { remaining: 0, progress: null, lives };
  };
  hud.defaultBinding = (action) => ctx.input.constructor?.DEFAULT_BINDINGS?.[action] || DEFAULT_BINDINGS_FALLBACK[action] || ctx.input.bindings?.[action] || [];
  hud.onMenuChanged = (screen) => {
    const hide = screen === 'entry' || screen === 'main' || screen === 'pause' || screen === 'settings' || screen === 'death' || screen === 'replay' || screen === 'loading';
    if (hud.layer) hud.layer.style.visibility = hide || !hud.visible ? 'hidden' : '';
  };
  hud.onMapBaked = () => menus?.onMapBaked();

  function resetStats() {
    const st = hud.stats;
    st.best = Math.max(st.best, Number(matchInfo().wave) || 0);
    st.kills = st.headshots = st.deaths = st.shotsFired = st.shotsHit = st.streak = st.score = st.combatTime = 0;
    multi = { count: 0, last: -99 };
  }

  // ------------------------------------------------------------------------------ match info
  const matchCache = { wave: null, hostiles: null, objective: '', timer: '', lives: null, modeName: '' };
  function matchInfo() {
    const gm = ctx.services.gamemode.state || {};
    const ai = ctx.services.ai;
    let wave = gm.wave ?? (gm.mode && gm.mode !== 'sandbox' ? gm.round : null);
    if (matchOverride.wave !== undefined) wave = matchOverride.wave;
    let hostiles = gm.enemiesRemaining ?? gm.remaining ?? gm.hostiles ?? gm.enemiesLeft ?? null;
    if (hostiles == null && wave != null) hostiles = ai.count?.() ?? null;
    if (matchOverride.hostiles !== undefined) hostiles = matchOverride.hostiles;
    let objective = objectiveOverride ?? gm.objective ?? gm.objectiveText ?? (wave != null ? 'Hold the plaza' : '');
    if (matchOverride.objective !== undefined) objective = matchOverride.objective;
    let timer = '';
    const phase = gm.phase;
    const tl = gm.timeLeft ?? gm.intermission ?? gm.nextWaveIn;
    if ((phase === 'warmup' || phase === 'intermission' || phase === 'break') && Number.isFinite(tl) && tl > 0) {
      const t = Math.ceil(tl);
      timer = `${wave ? 'Next wave' : 'Starting'} ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    }
    if (matchOverride.timer !== undefined) timer = matchOverride.timer;
    let lives = null;
    const lv = gm.lives ?? gm.reinforcements;
    if (typeof lv === 'number') lives = { left: lv, max: gm.maxLives ?? gm.livesMax ?? Math.max(lv, 2) };
    if (matchOverride.lives !== undefined) lives = matchOverride.lives;
    matchCache.wave = wave;
    matchCache.hostiles = hostiles;
    matchCache.objective = objective;
    matchCache.timer = timer;
    matchCache.lives = lives;
    return matchCache;
  }
  function currentScore() {
    if (matchOverride.score !== undefined) return matchOverride.score;
    const gmState = ctx.services.gamemode.state;
    const sc = gmState?.score;
    if (sc && typeof sc === 'object') {
      if (gmState.matchType === 'tdm') return sc.blue || 0;
      const v = sc.player ?? sc.friendly;
      if (typeof v === 'number') return v;
    } else if (typeof sc === 'number') return sc;
    return hud.stats.score;
  }
  const gmLive = () => { const g = ctx.services.gamemode.state; return !!g && g.mode && g.mode !== 'sandbox'; };
  hud.matchSnapshot = () => {
    const m = matchInfo();
    const s = hud.stats;
    const t = Math.floor(s.combatTime);
    return {
      wave: m.wave,
      hostiles: m.hostiles,
      kills: matchOverride.kills ?? (gmLive() ? ctx.services.gamemode.state.kills : null) ?? s.kills,
      headshots: matchOverride.headshots ?? (gmLive() ? ctx.services.gamemode.state.headshots : null) ?? s.headshots,
      score: currentScore(),
      accuracy: s.shotsFired ? `${Math.round((100 * s.shotsHit) / s.shotsFired)}%` : '—',
      time: `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`,
    };
  };

  // ------------------------------------------------------------------------------ API impl
  function hitmarker(kind = 'hit') {
    let k = kind === 'kill' || kind === 'headshot' ? kind : kind === 'killhs' ? 'killhs' : 'hit';
    const frame = ctx.time.frame;
    if (frame === hmFrame) {
      if ((hmKind === 'headshot' && k === 'kill') || (hmKind === 'kill' && k === 'headshot')) k = 'killhs';
      if (HM_PRIO[k] < HM_PRIO[hmKind]) return;
      if (k === hmKind) return;
    }
    hmFrame = frame;
    hmKind = k;
    center.hitmarker(k);
    combatIdle = 0;
    try { ctx.services.postfx.pulse?.('hitmarker', k === 'hit' ? 0.35 : 0.8, 0.12); } catch { /* ignore */ }
  }

  function notify(text, opts = {}) {
    const kind = opts.kind || 'info';
    const t = String(text ?? '');
    switch (kind) {
      case 'xp':
      case 'score': {
        auto.xp = false;
        let pts = opts.points;
        let label = opts.label ?? t;
        const m = /^\s*\+?\s*(\d[\d,]*)\s*(.*)$/.exec(t);
        if (pts == null && m) {
          pts = Number(m[1].replace(/,/g, ''));
          label = opts.label ?? m[2];
        }
        feed.scorePopup(pts || 0, (label || '').trim());
        break;
      }
      case 'medal':
      case 'streak':
        auto.medal = false;
        feed.pushMedal({ title: t, sub: opts.sub || (opts.points ? `+${opts.points}` : ''), kind: opts.icon || (kind === 'streak' ? 'streak' : guessMedalKind(t)), tier: opts.tier ?? (kind === 'streak' ? 3 : 1), count: opts.count, life: opts.duration });
        break;
      case 'wave':
      case 'banner':
        auto.banner = false;
        feed.pushBanner(t, { sub: opts.sub, kicker: opts.kicker, warn: opts.warn, duration: opts.duration ?? 3.4 });
        break;
      case 'warning':
        feed.pushToast(t, { warn: true, duration: opts.duration ?? 2.2 });
        break;
      case 'objective':
        objectiveOverride = t;
        feed.pushBanner(t, { kicker: 'New objective', duration: opts.duration ?? 3 });
        break;
      default:
        feed.pushToast(t, { duration: opts.duration ?? 2 });
    }
  }

  function guessMedalKind(t) {
    const s = t.toLowerCase();
    if (/double|triple|quad|multi|fury/.test(s)) return 'multi';
    if (/head/.test(s)) return 'headshot';
    if (/long/.test(s)) return 'longshot';
    if (/first/.test(s)) return 'first';
    if (/melee|knife|blade/.test(s)) return 'melee';
    if (/wave|survived|clear/.test(s)) return 'wave';
    return 'streak';
  }

  function damageIndicator(pos, strength = 1) {
    if (pos && pos.x !== undefined) center.damage(pos, strength);
    else center.damage(null, strength);
  }

  function ping(position, { duration = 4, kind = 'ping' } = {}) {
    if (!position) return;
    if (pings.length > 24) pings.shift();
    pings.push({ x: position.x, z: position.z, until: hud.uiTime + duration, kind, born: hud.uiTime });
  }
  function revealEnemy(agentOrId, seconds = 3) {
    const a = typeof agentOrId === 'object' ? agentOrId : findAgent(agentOrId);
    if (!a) return;
    revealed.set(a.id, Math.max(revealed.get(a.id) || 0, hud.uiTime + seconds));
  }

  // ------------------------------------------------------------------------------ auto features
  function onKill(e) {
    // copy (payload may be pooled) and defer one frame so producers calling our API win
    pendingKills.push({
      frame: ctx.time.frame,
      target: e.target,
      source: e.source,
      weaponId: e.weaponId,
      zone: e.zone,
      kind: e.kind || e.info?.kind || '',
      dist: e.distance ?? null,
    });
    if (e.source === 'player' || e.source === 'Player') {
      hitmarker(e.zone === 'head' ? 'killhs' : 'kill');
      const st = hud.stats;
      st.kills++;
      if (e.zone === 'head') st.headshots++;
      st.streak++;
      st.bestStreak = Math.max(st.bestStreak, st.streak);
      combatIdle = 0;
    }
  }

  function processKills() {
    const frame = ctx.time.frame;
    for (let i = 0; i < pendingKills.length; i++) {
      const k = pendingKills[i];
      if (k.frame >= frame) continue;
      pendingKills.splice(i--, 1);
      const byPlayer = k.source === 'player' || k.source === 'Player';
      const victim = k.target;
      const vTeam = victim?.team || 'enemy';
      const vName = vTeam === 'friendly' || victim?.key === 'player' ? getPlayerName() : enemyName(victim);
      let kName = '';
      if (byPlayer) kName = getPlayerName();
      else if (k.source) kName = agentName(findAgent(k.source), k.source);
      const wpn = k.weaponId || '';
      const kindStr = k.kind || (/(frag|grenade|explo)/.test(wpn) ? 'explosion' : '');
      if (auto.feed) internalFeed({ killer: kName, victim: vName, weapon: wpn, headshot: k.zone === 'head', killerTeam: byPlayer ? 'friendly' : 'enemy', victimTeam: vTeam, kind: kindStr });
      if (!byPlayer) continue;

      // distance for longshot / point blank
      let dist = k.dist;
      if (dist == null && victim?.object) {
        victim.object.getWorldPosition(tmpV);
        dist = tmpV.distanceTo(ctx.services.player.state.position);
      }
      const t = hud.uiTime;
      multi.count = t - multi.last <= 1.75 ? multi.count + 1 : 1;
      multi.last = t;
      const st = hud.stats;
      let pts = 100;
      if (auto.xp) {
        feed.scorePopup(100, kindStr === 'melee' ? 'Melee kill' : 'Kill');
        if (k.zone === 'head') { feed.scorePopup(50, 'Headshot'); pts += 50; }
        if (dist != null && dist > 35) { feed.scorePopup(50, 'Longshot'); pts += 50; }
        if (dist != null && dist < 3) { feed.scorePopup(25, 'Point blank'); pts += 25; }
        if (multi.count >= 2) { const b = [0, 0, 50, 100, 150][Math.min(4, multi.count)]; feed.scorePopup(b, 'Multi kill'); pts += b; }
      }
      st.score += pts;
      if (auto.medal) {
        const names = { 2: 'Double Kill', 3: 'Triple Kill', 4: 'Quad Kill' };
        if (multi.count >= 2) feed.pushMedal({ title: names[multi.count] || 'Fury Kill', sub: `${multi.count} kills`, kind: 'multi', tier: Math.min(4, multi.count), count: multi.count });
        else if (st.kills === 1) feed.pushMedal({ title: 'First Blood', sub: 'First kill of the operation', kind: 'first', tier: 2 });
        else if (dist != null && dist > 35) feed.pushMedal({ title: 'Longshot', sub: `${Math.round(dist)} m`, kind: 'longshot', tier: 2 });
        const streaks = { 3: ['Steady Hand', 1], 5: ['Iron Nerve', 2], 7: ['Plaza Warden', 2], 10: ['Vigilant', 3], 15: ['Unbroken Line', 3], 20: ['Last Bastion', 4], 25: ['Legend of Vardanek', 4] };
        const sk = streaks[st.streak];
        if (sk) feed.pushMedal({ title: sk[0], sub: `${st.streak} kill streak`, kind: 'streak', tier: sk[1] });
      }
    }
  }

  function internalFeed(d) {
    feed.killfeed(d);
  }

  function onPlayerDamaged(e) {
    const info = e.info || {};
    const p = ctx.services.player.state;
    combatIdle = 0;
    let src = info.sourcePosition || info.origin || info.from || null;
    const agent = findAgent(info.source ?? info.attacker);
    if (!src && agent) src = agent.position || agent.object?.position;
    if (!src && info.position && (info.type === 'explosion' || info.kind === 'explosion')) src = info.position;
    if (!src && info.direction) {
      tmpV.copy(p.position).addScaledVector(info.direction, -20);
      src = tmpV;
    }
    if (!src && info.position) src = info.position;
    const maxH = p.maxHealth || 100;
    const strength = clamp((e.amount || 10) / (maxH * 0.25), 0.4, 1.4);
    if (src) center.damage(src, strength);
    panels.damageFlash(e.amount || 10);
    if (agent) revealEnemy(agent, 3);
    try { ctx.services.postfx.pulse?.('damage', clamp((e.amount || 10) / 40, 0.25, 1), 0.45); } catch { /* ignore */ }
  }

  function onPlayerDied(e) {
    const info = e?.info || {};
    const agent = findAgent(info.source ?? info.attacker);
    const d = hud.deathInfo;
    d.killer = agent || String(info.source || '').startsWith('ai') ? agentName(agent, info.source) : info.killer || (info.kind === 'fall' ? 'Fall damage' : 'Crimson Vanguard');
    const role = agent?.loadout && ROLE[agent.loadout] ? ROLE[agent.loadout] : agent?.role || 'Rifleman';
    d.faction = `Crimson Vanguard · ${role}`;
    d.weaponId = info.weaponId || agent?.loadout || 'rifle';
    d.kind = info.kind || info.type || '';
    d.weaponName = info.weaponName || weaponDisplayName(d.weaponId, d.kind);
    const killerKey = agent?.key || (typeof info.source === 'string' ? info.source : '');
    const matchType = ctx.services.gamemode.state?.matchType;
    d.killReplay = matchType !== 'protection' && killerKey ? (ctx.services.ai?.getReplayFrames?.(killerKey, 3.5) || []) : [];
    const p = ctx.services.player.state;
    const sp = info.sourcePosition || info.origin || agent?.position || null;
    d.distance = sp ? Math.hypot(sp.x - p.position.x, sp.z - p.position.z) : null;
    hud.stats.deaths++;
    hud.stats.streak = 0;
    multi = { count: 0, last: -99 };
    hud.mode = 'dead';
    ctx.input.unlock?.();
    deathTimer = d.killReplay.length > 1 ? -1 : 0.9;
    if (deathTimer < 0) menus.open('replay');
    if (auto.feed) internalFeed({ killer: d.killer, victim: getPlayerName(), weapon: d.weaponId, headshot: info.zone === 'head', killerTeam: 'enemy', victimTeam: 'friendly', kind: d.kind });
  }

  function weaponDisplayName(id, kind) {
    const s = String(id || '').toLowerCase();
    if (kind === 'explosion' || /frag|grenade/.test(s)) return 'Frag grenade';
    if (/lmg/.test(s)) return 'Light machine gun';
    if (/smg/.test(s)) return 'Submachine gun';
    if (/shotgun/.test(s)) return 'Shotgun';
    if (/pistol/.test(s)) return 'Pistol';
    return 'Assault rifle';
  }

  function onCombatHit(e) {
    const src = e.source;
    if (src === 'player') {
      if (e.target) {
        hud.stats.shotsHit++;
        hitmarker(e.zone === 'head' ? 'headshot' : 'hit');
      }
      return;
    }
    if (typeof src === 'string' && src.startsWith('ai') && !e.suppressed) revealEnemy(src, 3);
  }

  function onAiFire(e) {
    if (e?.suppressed) return;
    const a = e?.agent ?? findAgent(e?.source ?? e?.id);
    if (a) revealEnemy(a, 3);
  }

  // ------------------------------------------------------------------------------ service
  const api = {
    root: null,
    setVisible(v) {
      hud.visible = !!v;
      hud.onMenuChanged(menus?.screen ?? 'none');
    },
    hitmarker,
    damageIndicator,
    notify,
    killfeed(d) {
      auto.feed = false;
      feed.killfeed(d || {});
    },
    setCrosshairSpread(deg) {
      lastSpreadCall = hud.uiTime;
      center.setSpread(deg, 0.3);
    },
    setObjective(text, opts = {}) {
      objectiveOverride = text == null ? null : String(text);
      objectivePos = opts.position ? { x: opts.position.x, z: opts.position.z } : null;
    },
    scorePopup(points, label) {
      auto.xp = false;
      feed.scorePopup(points, label);
    },
    medal(m) {
      auto.medal = false;
      feed.pushMedal(m || {});
    },
    banner(title, opts) {
      auto.banner = false;
      feed.pushBanner(title, opts);
    },
    setInteraction(text, opts) {
      panels.setInteraction(text, opts);
    },
    ping,
    revealEnemy,
    setMatchInfo(o = {}) {
      for (const k of ['wave', 'hostiles', 'objective', 'timer', 'lives', 'modeName', 'score', 'streak', 'kills', 'headshots']) if (k in o) matchOverride[k] = o[k];
    },
    openMenu(name) {
      if (name === 'main') hud.mode = 'boot';
      if (name === 'pause') hud.mode = 'pause';
      menus.open(name);
    },
    async prepareStartup() {
      try {
        await menus.prewarmMenuScene();
      } catch (error) {
        ctx.reportError('hud', 'startup-render-warmup', error);
      }
      hud.mode = 'boot';
      menus.open('entry');
    },
    closeMenu() {
      menus.close();
    },
    get menu() {
      return menus?.screen ?? 'none';
    },
    getKillReplayCameraPosition() {
      return menus?.getKillReplayCameraPosition?.(tmpV) || null;
    },
    rebakeMinimap() {
      minimap.bake();
    },
    stats: hud.stats,
    /** Test/shot hook: extra pseudo-agents ({id, alive, team, position}) treated like ai.agents. */
    debugAgents: [],
  };

  // ------------------------------------------------------------------------------ per-frame
  const frameInfo = {
    spreadDeg: 0, vfovDeg: 60, ads: 0, sprinting: false, reloading: false, visible: 1, playerBearing: 0, px: 0, pz: 0, overEnemy: false,
  };
  const panelInfo = { weapon: null, player: null, visible: 1, alive: true, score: 0, streak: 0, lives: null, match: null, combatIdle: 0 };
  const mapP = { x: 0, z: 0, bearing: 0, hfov: 1.5 };
  let compassAlpha = 1;
  let mapAlpha = 1;

  function update(dt) {
    // UI clock: sim-locked in shot mode (deterministic), wall clock otherwise (keeps menus alive while paused)
    let udt;
    if (ctx.time.deterministic) udt = ctx.time.frozen ? 0 : ctx.time.fixedStep;
    else {
      const r = ctx.time.real;
      udt = lastReal < 0 ? 1 / 60 : clamp(r - lastReal, 0, 0.1);
      lastReal = r;
    }
    hud.uiTime += udt;
    combatIdle += udt;

    const fpsEnabled = ctx.settings.get('graphics.showFps', false) === true;
    if (fpsEl) fpsEl.style.display = fpsEnabled ? '' : 'none';
    if (fpsEnabled) {
      fpsElapsed += udt;
      fpsFrames++;
      if (fpsElapsed >= 0.5) {
        fpsEl.textContent = `${Math.round(fpsFrames / fpsElapsed)} FPS`;
        fpsElapsed = 0;
        fpsFrames = 0;
      }
    }
    if (matchHudEl) {
      const match = ctx.services.gamemode.state || {};
      const activeMatch = match.matchType === 'tdm';
      matchHudEl.style.display = activeMatch && ['match-live', 'match-dead', 'ended'].includes(match.stage) ? '' : 'none';
      if (activeMatch) {
        const score = match.score || {};
        matchHudEl.textContent = `TEAM DEATHMATCH  ·  BLUE ${score.blue || 0} — RED ${score.red || 0}  ·  FIRST TO ${match.scoreLimit || 30}`;
      }
    }

    const ps = ctx.services.player.state;
    const ws = ctx.services.weapons.state;
    if (interactive && menus.screen === 'none' && hud.mode === 'play' && ps.alive !== false) hud.stats.combatTime += dt;

    // ---- pointer-lock driven transitions (interactive only)
    if (interactive) {
      if (pendingLock) {
        pendingLockAge += udt;
        if (pendingLock === 'resume' && pendingLockAge > 0.9 && menus.screen !== 'resume' && !ctx.input.locked) menus.open('resume');
      }
      if (hud.mode === 'play' && ctx.input.pressed('pause') && menus.screen === 'none') {
        if (ctx.input.locked) ctx.input.unlock();
        else openPause();
      }
      // death flow
      if (hud.mode === 'dead') {
        if (ps.alive !== false && deathTimer < 0) {
          hud.mode = 'play';
          if (menus.screen === 'death') menus.close();
          if (!ctx.input.locked) hud.requestResume();
        } else if (deathTimer >= 0) {
          deathTimer -= udt;
          if (deathTimer < 0) {
            if (ps.alive === false) {
              menus.open('death');
              if (hud.isGameOver()) ctx.input.unlock?.();
            } else hud.mode = 'play';
          }
        }
      }
    } else if (hud.mode === 'dead' && deathTimer >= 0) {
      deathTimer -= udt;
      if (deathTimer < 0 && ps.alive === false && menus.screen === 'none') menus.open('death');
    }

    // ---- minimap bake (lazy; re-bakes when the world changes)
    minimap.maybeRebake(udt);

    // ---- auto kill processing
    if (pendingKills.length) processKills();

    // ---- wave banner auto
    const m = matchInfo();
    if (m.wave != null && m.wave !== lastWave) {
      if (lastWave != null && auto.banner) {
        const sub = ctx.services.gamemode.state?.waveTitle || 'Hostiles converging on the plaza';
        feed.pushBanner(`Wave ${m.wave}`, { kicker: 'Hold Vardanek', sub, duration: 3.4 });
      }
      lastWave = m.wave;
    }

    const vis = hud.visible && menus.screen === 'none' ? 1 : 0;
    const alive = ps.alive !== false;

    // ---- center
    const bearing = wrapPi(-ps.yaw);
    frameInfo.spreadDeg = Number.isFinite(ws.spread) ? ws.spread : 2;
    frameInfo.vfovDeg = ctx.camera.fov || 60;
    frameInfo.ads = ws.ads || 0;
    frameInfo.sprinting = !!(ws.sprinting || ps.sprinting || ws.action === 'sprint');
    frameInfo.reloading = !!ws.reloading;
    frameInfo.visible = vis && alive && !!ws.id ? 1 : 0;
    frameInfo.playerBearing = bearing;
    frameInfo.px = ps.position.x;
    frameInfo.pz = ps.position.z;
    frameInfo.overEnemy = frameInfo.visible ? aimOverEnemy() : false;
    center.update(udt, frameInfo);
    void lastSpreadCall;

    // ---- activity tracking
    const moved = Math.abs(ps.position.x - playerPosPrev.x) + Math.abs(ps.position.z - playerPosPrev.z) > 0.001;
    playerPosPrev.copy(ps.position);

    // ---- panels
    panelInfo.weapon = ws;
    panelInfo.player = ps;
    panelInfo.visible = vis;
    panelInfo.alive = alive;
    panelInfo.score = currentScore();
    panelInfo.streak = matchOverride.streak ?? ctx.services.gamemode.state?.streak ?? hud.stats.streak;
    panelInfo.lives = m.lives;
    panelInfo.match = m;
    panelInfo.combatIdle = combatIdle;
    panels.update(udt, panelInfo);

    // ---- feed / popups
    feed.update(udt);

    // ---- blips (minimap + compass)
    const bearingDeg = (bearing * 180) / Math.PI;
    let nb = 0;
    let nc = 0;
    agentLists[0] = ctx.services.ai.agents || EMPTY;
    agentLists[1] = api.debugAgents;
    for (let li = 0; li < 2; li++) for (let i = 0; i < agentLists[li].length && nb < blips.length; i++) {
      const a = agentLists[li][i];
      if (!a || a.alive === false || a.team === 'friendly' || a.team === ctx.services.gamemode.state?.playerTeam) continue;
      const until = revealed.get(a.id);
      if (until == null) continue;
      const rem = until - hud.uiTime;
      if (rem <= 0) {
        revealed.delete(a.id);
        continue;
      }
      const pos = a.position || a.object?.position;
      if (!pos) continue;
      const alpha = clamp01(rem / 0.8);
      const b = blips[nb++];
      b.x = pos.x; b.z = pos.z; b.alpha = alpha; b.kind = 'enemy'; b.age = 0;
      if (nc < 6) {
        const c = compassItems[nc++];
        c.kind = 'enemy';
        c.bearing = (Math.atan2(pos.x - ps.position.x, -(pos.z - ps.position.z)) * 180) / Math.PI;
        c.alpha = alpha;
        c.clampEdge = false;
      }
    }
    for (let i = pings.length - 1; i >= 0; i--) {
      if (pings[i].until <= hud.uiTime) pings.splice(i, 1);
    }
    for (let i = 0; i < pings.length && nb < blips.length; i++) {
      const pg = pings[i];
      const b = blips[nb++];
      b.x = pg.x; b.z = pg.z; b.alpha = clamp01((pg.until - hud.uiTime) / 0.8); b.kind = pg.kind === 'enemy' ? 'enemy' : pg.kind === 'obj' ? 'obj' : 'ping'; b.age = hud.uiTime - pg.born;
      if (nc < compassItems.length && pg.kind !== 'obj') {
        const c = compassItems[nc++];
        c.kind = 'enemy';
        c.bearing = (Math.atan2(pg.x - ps.position.x, -(pg.z - ps.position.z)) * 180) / Math.PI;
        c.alpha = b.alpha;
        c.clampEdge = false;
      }
    }
    const objP = objectivePos;
    if (objP && nb < blips.length) {
      const b = blips[nb++];
      b.x = objP.x; b.z = objP.z; b.alpha = 1; b.kind = 'obj'; b.age = 0;
      if (nc < compassItems.length) {
        const c = compassItems[nc++];
        c.kind = 'obj';
        c.bearing = (Math.atan2(objP.x - ps.position.x, -(objP.z - ps.position.z)) * 180) / Math.PI;
        c.alpha = 1;
        c.clampEdge = true;
      }
    }

    // ---- compass + minimap (fade slightly when idle)
    const idle = combatIdle > 6 && !moved;
    const showCompass = ctx.settings.get('hud.compass', true) !== false;
    compassAlpha = damp(compassAlpha, vis * (showCompass ? (idle ? 0.7 : 1) : 0), 4, udt);
    mapAlpha = damp(mapAlpha, vis * (idle ? 0.8 : 1), 4, udt);
    compass.setAlpha(compassAlpha);
    if (compassAlpha > 0.004) compass.update(bearingDeg, compassItems, nc);
    minimap.setAlpha(mapAlpha);
    if (mapAlpha > 0.004) {
      mapP.x = ps.position.x;
      mapP.z = ps.position.z;
      mapP.bearing = ctx.settings.get('hud.minimapRotate', true) === false ? 0 : bearing;
      const hf = (ctx.settings.data.graphics?.fov || 90) * (Math.PI / 180);
      mapP.hfov = hf;
      if (mapP.bearing === 0 && ctx.settings.get('hud.minimapRotate', true) === false) {
        // north-up: rotate the cone instead of the map (drawn as rotated map with bearing 0)
      }
      minimap.draw(mapP, blips, nb, hud.uiTime);
    }

    menus.update(udt);
  }

  /**
   * Crosshair enemy highlight: nearest living hostile whose torso/head capsule lies under the aim ray
   * (analytic, no allocations). Occlusion is confirmed with one world ray every few frames, only
   * while a candidate exists.
   */
  const aimPos = new THREE.Vector3();
  const aimDir = new THREE.Vector3();
  const aimTo = new THREE.Vector3();
  let aimCand = null;
  let aimVisible = false;
  let aimCheckFrame = -99;
  const agentLists = [null, null];
  function aimOverEnemy() {
    agentLists[0] = ctx.services.ai.agents || EMPTY;
    agentLists[1] = api.debugAgents;
    if (!agentLists[0].length && !agentLists[1].length) return false;
    const cam = ctx.camera;
    cam.getWorldPosition(aimPos);
    cam.getWorldDirection(aimDir);
    let best = null;
    let bestAlong = 150;
    let bestY = 0;
    for (let li = 0; li < 2; li++) for (let i = 0; i < agentLists[li].length; i++) {
      const a = agentLists[li][i];
      if (!a || a.alive === false || a.team === 'friendly' || a.team === ctx.services.gamemode.state?.playerTeam) continue;
      const p = a.position || a.object?.position;
      if (!p) continue;
      // test chest and head heights (feet-origin agents), capsule radius ~0.38 m
      for (let k = 0; k < 2; k++) {
        const y = p.y + (k === 0 ? 1.2 : 1.62);
        const dx = p.x - aimPos.x, dy = y - aimPos.y, dz = p.z - aimPos.z;
        const along = dx * aimDir.x + dy * aimDir.y + dz * aimDir.z;
        if (along <= 0.5 || along >= bestAlong) continue;
        const px = dx - aimDir.x * along, py = dy - aimDir.y * along, pz = dz - aimDir.z * along;
        const r = k === 0 ? 0.36 : 0.2;
        if (px * px + py * py + pz * pz < r * r) { best = a; bestAlong = along; bestY = y; }
      }
    }
    if (!best) { aimCand = null; return false; }
    const frame = ctx.time.frame;
    if (best !== aimCand || frame - aimCheckFrame >= 4) {
      aimCand = best;
      aimCheckFrame = frame;
      const p = best.position || best.object.position;
      aimTo.set(p.x - aimPos.x, bestY - aimPos.y, p.z - aimPos.z);
      const len = aimTo.length();
      aimTo.multiplyScalar(1 / len);
      let hit = null;
      try { hit = ctx.services.world.raycast(aimPos, aimTo, len); } catch { hit = null; }
      aimVisible = !hit || hit.distance > len - 0.6;
    }
    return aimVisible;
  }

  function openPause() {
    hud.mode = 'pause';
    menus.open('pause');
  }

  function lateUpdate() {
    let udt = ctx.time.deterministic ? (ctx.time.frozen ? 0 : ctx.time.fixedStep) : clamp(ctx.time.real - (lateUpdate.last ?? ctx.time.real), 0, 0.1);
    lateUpdate.last = ctx.time.real;
    if (!ctx.time.deterministic && udt === 0) udt = 1 / 60;
    menus.lateUpdate(udt);
  }

  // ------------------------------------------------------------------------------ lifecycle
  return {
    name: 'hud',
    async init() {
      ctx.settings.registerDefaults('hud', { scale: 1, minimapRotate: true, compass: true });

      styleEl = document.createElement('style');
      styleEl.textContent = CSS;
      styleEl.textContent += '\n.od-fps-counter{position:fixed;right:28px;top:26px;z-index:80;padding:7px 10px;background:rgba(8,12,11,.62);border:1px solid rgba(255,255,255,.18);color:#f0eee6;font:700 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;pointer-events:none}.od-match-score{position:fixed;left:50%;top:calc(82px + 4.8*var(--u,1px));transform:translateX(-50%);z-index:70;padding:8px 13px;background:rgba(8,12,11,.58);border:1px solid rgba(255,255,255,.14);color:#f0eee6;font:700 10px/1.2 system-ui,sans-serif;letter-spacing:.12em;white-space:nowrap;pointer-events:none}@media(max-width:600px){.od-fps-counter{right:12px;top:12px}.od-match-score{top:94px;font-size:8px;letter-spacing:.06em}}';
      ctx.ui.hudRoot.appendChild(styleEl);
      hud.layer = el('div', 'od-layer od-hud', ctx.ui.hudRoot);
      hud.uiLayer = el('div', 'od-layer od-ui', ctx.ui.uiRoot);
      fpsEl = el('div', 'od-fps-counter', ctx.ui.hudRoot);
      fpsEl.setAttribute('aria-live', 'off');
      fpsEl.style.display = 'none';
      matchHudEl = el('div', 'od-match-score', ctx.ui.hudRoot);
      matchHudEl.style.display = 'none';
      api.root = hud.layer;
      onResize();

      minimap = createMinimap(hud);
      hud.minimap = minimap;
      compass = createCompass(hud);
      panels = createPanels(hud);
      center = createCenter(hud);
      feed = createFeed(hud);
      menus = createMenus(hud);
      onResize();

      on('resize', onResize);
      window.addEventListener('resize', onResize);
      on('settings:changed', ({ path }) => {
        if (path === 'hud.scale') onResize();
      });
      on('combat:kill', onKill);
      on('combat:hit', onCombatHit);
      on('player:damaged', onPlayerDamaged);
      on('player:died', onPlayerDied);
      on('weapon:fired', () => {
        hud.stats.shotsFired++;
        combatIdle = 0;
      });
      on('ai:fire', onAiFire);
      on('ai:fired', onAiFire);
      on('ai:shot', onAiFire);
      on('ai:shoot', onAiFire);
      on('input:lock', ({ locked }) => {
        if (!interactive) return;
        if (locked) {
          if (pendingLock === 'play') {
            matchLockAcquired = true;
            if (matchAssetsReady) {
              pendingLock = null;
              finishPlay();
            }
          }
          else if (pendingLock === 'resume' || menus.screen === 'resume' || menus.screen === 'pause') {
            hud.mode = hud.mode === 'dead' ? 'dead' : 'play';
            if (menus.screen !== 'death') menus.close();
            pendingLock = null;
          }
        } else if (hud.mode === 'play' && menus.screen === 'none') {
          openPause();
        }
      });
      on('gamemode:phase', ({ phase } = {}) => {
        if (phase === 'ended' && hud.mode === 'dead') menus.refreshDeath();
      });

      ctx.services.provide('hud', api);

      if (interactive) {
        ctx.ui.setBootOverlayEnabled(false);
        hud.mode = 'boot';
        menus.openLoading('Preparing Vardanek and rendering the map…');
        const g = () => gesture();
        ctx.ui.uiRoot.addEventListener('pointerdown', g, { once: true });
        window.addEventListener('keydown', g, { once: true });
      }

      // first bake right away if the world is there (shot mode: deterministic, before warmup)
      try {
        await ctx.services.world.ready;
        minimap.bake();
      } catch (e) {
        ctx.reportError('hud', 'minimap-bake', e);
      }
    },
    update,
    lateUpdate,
    dispose() {
      for (const [n, fn] of listeners) events.off(n, fn);
      window.removeEventListener('resize', onResize);
      if (timeScaleSaved != null) ctx.time.scale = timeScaleSaved;
      menus?.dispose();
      minimap?.dispose();
      hud.layer?.remove();
      fpsEl?.remove();
      matchHudEl?.remove();
      styleEl?.remove();
    },
  };
}

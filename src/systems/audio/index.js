/**
 * audio — procedural game audio for Opus of Duty. Owner: audio agent. See README.md in this folder.
 *
 * Every sound is synthesized (sounds/*.js on top of dsp.js), baked into AudioBuffers by a Web Worker at
 * boot (bake.worker.js), and played through engine.js: buses, HRTF spatialization, distance + air
 * absorption, speed-of-sound delay, world-raycast occlusion, environment reverb (procedural IRs, ir.js,
 * picked by probing the space around the listener), ducking, concussion, glue compressor + limiter.
 *
 * services.audio (contract + extensions):
 *   context, play(name, opts), playAt(name, position, opts), list(), setVolume(bus, v), resume(),
 *   renderOffline(name, {duration, sampleRate, channels, params})  -> AudioBuffer (sounds AND scenes)
 *   extensions: gunshot({origin, direction, weaponId, suppressed, end}), impact({point, surface, flesh}),
 *   explosion({position, radius}), footstepAt(position, surface, speed), ui(kind), stinger(name),
 *   setEnvironment(name|null), environment, setIntensity(0..1), setAmbience(bool), setMuffled(bool),
 *   describe(name), stats(), engine
 * Shots are silent (play is a no-op in shot mode); renderOffline works everywhere.
 */
import * as THREE from 'three';
import catalog from './sounds/index.js';
import { AudioEngine, Bank, NULL_HANDLE, bakeOne } from './engine.js';
import { AmbienceDirector } from './ambience.js';
import { SCENES } from './scenes.js';
import { IR_NAMES, IR_PRESETS, REFLECT_PRESETS, reflectDir } from './ir.js';
import { weaponClass } from './sounds/weapons.js';
import { footSurface } from './sounds/surfaces.js';
import { Rand } from './dsp.js';

const BAKE_SR = 48000;

/**
 * Names other systems call directly (weapons clip cues etc.) -> catalog names. `null` = intentionally silent.
 * Keys may use the weapon kind prefix: `<kind>_<cue>`; kind 'pistol' has its own variants.
 */
const ALIAS = {
  rifle_mag_out: 'mag_out', rifle_mag_in: 'mag_in', rifle_bolt_release: 'bolt_release', rifle_charge: 'charging_handle',
  pistol_bolt_release: 'pistol_slide_release', pistol_slide: 'pistol_slide_release', pistol_charge: 'pistol_slide_release',
  rifle_grab_start: 'reload_grab', pistol_grab_start: 'reload_grab',
  rifle_magSwap: 'mag_pouch', pistol_magSwap: 'mag_pouch', rifle_magNew: null, pistol_magNew: null,
  rifle_rattle: 'weapon_rattle', pistol_rattle: 'pistol_rattle',
  rifle_magTap: 'mag_tap', pistol_magTap: 'mag_tap',
  rifle_inspect_start: 'weapon_inspect', pistol_inspect_start: 'weapon_inspect',
  rifle_melee_swing: 'melee_swing', pistol_melee_swing: 'melee_swing',
  rifle_equip: 'weapon_raise', pistol_equip: 'pistol_raise', frag_equip: 'grenade_equip',
  fire_mode: 'fire_select', firemode: 'fire_select', grenade_bounce: 'grenade_bounce_concrete', grenade: 'grenade_throw',
  kill_confirm: 'hitmarker_kill', headshot: 'hitmarker_headshot',
};
/** Reload-stage names: when weapons plays these itself, stop deriving them from reloadProgress. */
const RELOAD_STAGE = /^(mag_out|mag_in|bolt_release|charging_handle|pistol_mag_out|pistol_mag_in|pistol_slide_release|mag_pouch)$/;
const GUN_RE = /^(rifle|pistol|smg|lmg|sniper|shotgun)_fire(_suppressed)?$/;

/** Bake priority: what the player hears first must exist first. Lower = earlier. */
function priorityOf(name) {
  if (/^(rifle|pistol)_fire(_3p)?$/.test(name) || /^hitmarker|^kill_confirm|^bullet_|^impact_(concrete|flesh|dirt|metal)$/.test(name)) return 0;
  if (/^footstep_(concrete|dirt|gravel|metal|wood)(_run)?$/.test(name) || /^(mag_|bolt_|charging|dry_fire|weapon_raise|ads_|fire_select)/.test(name)) return 1;
  if (/^(explosion_|player_hit|rifle_fire_far|grenade_|ui_|jump|land_concrete|stance_|slide|low_ammo)/.test(name)) return 2;
  if (/^amb_(wind|bed)$/.test(name)) return 3;
  if (/^music_/.test(name)) return 6;
  if (/^amb_/.test(name)) return 5;
  return 4;
}

export default function createSystem(ctx) {
  const { events } = ctx;
  const S = () => ctx.services;
  const bank = new Bank();
  const rng = ctx.rng.fork('audio');
  const shotMode = !!ctx.flags?.shotMode;
  let ac = null, eng = null, director = null, worker = null;
  let bakeQueue = null, bakeTotal = 0, bakeDone = 0, workerBusy = false;
  const offs = [];
  let disposed = false;

  // ------------------------------------------------------------------ settings / volumes
  ctx.settings.registerDefaults('audio', { master: 0.9, sfx: 1, music: 0.6, voice: 1, ui: 0.9, ambience: 1, hrtf: true, hitmarkers: true, music_stingers: true });
  const vol = () => {
    const a = ctx.settings.data.audio || {};
    return { master: a.master ?? 0.9, sfx: a.sfx ?? 1, music: a.music ?? 0.6, voice: a.voice ?? 1, ui: a.ui ?? 0.9, ambience: a.ambience ?? 1 };
  };

  // ------------------------------------------------------------------ baking
  function buildJobs() {
    const names = Object.keys(catalog).sort((a, b) => priorityOf(a) - priorityOf(b));
    const jobs = [{ kind: 'ir', name: 'street' }];
    const maxV = names.reduce((m, n) => Math.max(m, catalog[n].variants || 1), 1);
    for (let v = 0; v < maxV; v++) {
      for (const n of names) if (v < (catalog[n].variants || 1)) jobs.push({ kind: 'sound', name: n, variant: v });
      if (v === 0) for (const ir of IR_NAMES) if (ir !== 'street') jobs.push({ kind: 'ir', name: ir });
    }
    return jobs;
  }

  function onBaked(m) {
    if (m.kind === 'ir') bank.putIR(m.name, m.chans, m.sr);
    else if (m.kind === 'sound') bank.put(m.name, m.variant, m.chans, m.sr);
    else if (m.kind === 'error') console.warn(`[system:audio] bake failed for ${m.name}#${m.variant}: ${m.message}`);
    bakeDone++;
    if (m.kind === 'ir' && eng && !eng.env && m.name === 'street') eng.setEnvironment('street', 0);
  }

  function startBaking() {
    const jobs = buildJobs();
    bakeTotal = jobs.length;
    try {
      worker = new Worker(new URL('./bake.worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        if (e.data?.done) { workerBusy = false; worker?.terminate(); worker = null; return; }
        onBaked(e.data);
      };
      worker.onerror = (e) => {
        console.warn('[system:audio] bake worker failed, baking on the main thread instead', e?.message || e);
        try { worker?.terminate(); } catch { /* ignore */ }
        worker = null; workerBusy = false;
        bakeQueue = jobs.filter((j) => (j.kind === 'ir' ? !bank.irs.has(j.name) : !(bank.data.get(j.name)?.[j.variant])));
      };
      // send in two batches so the essentials come back as early as possible
      workerBusy = true;
      worker.postMessage({ jobs, sr: BAKE_SR });
    } catch (err) {
      console.warn('[system:audio] Worker unavailable, main-thread bake', err);
      bakeQueue = jobs;
    }
  }

  /** Main-thread fallback: one job per frame. */
  function bakeStep() {
    if (!bakeQueue || !bakeQueue.length) return;
    const j = bakeQueue.shift();
    try {
      if (j.kind === 'ir') bank.bakeIRSync(j.name, BAKE_SR);
      else if (!(bank.data.get(j.name)?.[j.variant])) bank.put(j.name, j.variant, bakeOne(j.name, j.variant, BAKE_SR), BAKE_SR);
    } catch (err) { ctx.reportError('audio', 'bake', err); }
    bakeDone++;
  }

  // ------------------------------------------------------------------ context / engine
  function ensure() {
    if (ac || shotMode || disposed) return ac;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      try { ac = new AC({ latencyHint: 'interactive', sampleRate: BAKE_SR }); } catch { ac = new AC({ latencyHint: 'interactive' }); }
      eng = new AudioEngine(ac, bank, { rng: rng.fork('engine'), volumes: vol(), hrtf: ctx.settings.get('audio.hrtf', true) !== false });
      eng.occlude = occlude;
      if (!bank.irs.has('street')) bank.bakeIRSync('street', BAKE_SR);
      eng.setEnvironment(envState.current || 'street', 0, envLevel(envState.current || 'street'));
      director = new AmbienceDirector(eng, rng.fork('ambience'));
      director.setEmitters(findEmitters());
      ac.onstatechange = () => { if (ac?.state === 'running' && director && !director.started && ambienceOn) director.start(eng.now() + 0.3, 5); };
      if (ac.state === 'running' && ambienceOn) director.start(eng.now() + 0.3, 5);
    } catch (e) {
      console.warn('[system:audio] AudioContext unavailable', e);
      ac = null; eng = null;
    }
    return ac;
  }
  const live = () => (eng && ac && ac.state === 'running' ? eng : null);

  // ------------------------------------------------------------------ world queries (occlusion, env probe, emitters)
  const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3();
  let occBudget = 16;
  function occlude(pos) {
    if (occBudget <= 0) return 0;
    const L = eng.listener.pos;
    _d.set(pos.x - L.x, pos.y - L.y, pos.z - L.z);
    const dist = _d.length();
    if (dist < 1.5 || dist > 250) return 0;
    occBudget--;
    _d.multiplyScalar(1 / dist);
    _o.set(L.x, L.y, L.z);
    const w = S().world;
    const h = w.raycast(_o, _d, dist - 0.5);
    if (!h) return 0;
    // second ray over the top: low cover diffracts; only "fully occluded" if both are blocked
    _o.y += 1.2;
    _d.set(pos.x - _o.x, pos.y + 1.0 - _o.y, pos.z - _o.z);
    const d2 = _d.length(); _d.multiplyScalar(1 / d2);
    const h2 = w.raycast(_o, _d, d2 - 0.5);
    return h2 ? 1 : 0.55;
  }

  const envState = { current: null, candidate: null, votes: 0, ray: 0, dist: new Float32Array(9), timer: 0 };
  const PROBE = [];
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; PROBE.push(new THREE.Vector3(Math.cos(a), 0.08, Math.sin(a)).normalize()); }
  PROBE.push(new THREE.Vector3(0, 1, 0));
  const REFL = { concrete: 0.9, brick: 0.9, asphalt: 0.85, plaster: 0.85, tile: 0.95, metal: 1, glass: 0.85, wood: 0.65, cardboard: 0.4, rubber: 0.4, dirt: 0.35, sand: 0.3, gravel: 0.4, grass: 0.25, fabric: 0.25, flesh: 0.2, water: 0.7 };
  const reflectivity = (s) => REFL[s] ?? 0.8;
  const envLevel = (n) => ({ street: 1, open: 0.8, alley: 1.1, room: 1.15, hall: 1.2 }[n] ?? 1);
  let envOverride = null;

  function probeEnvironment(dt) {
    const w = S().world;
    if (!w || !eng) return;
    const L = eng.listener.pos;
    _o.set(L.x, L.y, L.z);
    for (let k = 0; k < 3; k++) { // 3 rays per frame
      const i = envState.ray;
      const far = i === 8 ? 25 : 60;
      const h = w.raycast(_o, PROBE[i], far);
      envState.dist[i] = h ? h.distance : far;
      // same ray drives that direction's early reflection (slapback) tap
      eng.setReflection(i, h ? h.distance : null, h ? reflectivity(h.surface) : 0, PROBE[i]);
      envState.ray = (i + 1) % 9;
      if (envState.ray === 0) classify();
    }
  }
  function classify() {
    const d = envState.dist;
    const covered = d[8] < 9;
    let sum = 0, near35 = 0;
    for (let i = 0; i < 8; i++) { sum += d[i]; if (d[i] < 35) near35++; }
    const mean = sum / 8;
    let alley = false;
    for (let i = 0; i < 4; i++) if (d[i] < 4.5 && d[i + 4] < 4.5) alley = true;
    let env;
    if (covered) env = mean < 8 ? 'room' : 'hall';
    else if (alley) env = 'alley';
    else if (near35 >= 3) env = 'street';
    else env = 'open';
    if (envOverride) env = envOverride;
    if (env === envState.current) { envState.votes = 0; return; }
    if (env === envState.candidate) envState.votes++; else { envState.candidate = env; envState.votes = 1; }
    if (envState.votes >= 2 || !envState.current) {
      envState.current = env; envState.votes = 0;
      if (eng && bank.irs.has(env)) eng.setEnvironment(env, 0.9, envLevel(env));
      else if (eng) { bank.bakeIRSync(env, BAKE_SR); eng.setEnvironment(env, 0.9, envLevel(env)); }
      events.emit('audio:environment', { environment: env });
    }
  }

  function findEmitters() {
    const fires = [], tarps = [];
    const root = S().world?.root;
    if (!root) return { fires, tarps };
    root.traverse((o) => {
      const n = (o.name || '').toLowerCase();
      if (!n) return;
      if (/fire|burn|flame/.test(n) && fires.length < 12) { o.getWorldPosition(_p); fires.push({ x: _p.x, y: _p.y, z: _p.z }); }
      else if (/tarp|awning|canvas|tent|flag|banner|cloth/.test(n) && tarps.length < 24) { o.getWorldPosition(_p); tarps.push({ x: _p.x, y: _p.y + 1, z: _p.z }); }
    });
    return { fires, tarps };
  }

  // ------------------------------------------------------------------ game state tracking
  let lastPlayerShot = -1;
  let lastSurface = 'concrete';
  let intensity = 0;
  let ambienceOn = true;
  let markerPending = null; // 'hit' | 'headshot' | 'kill' | 'killhead'
  let seenRicochetEvents = false;
  const reload = { active: false, empty: false, stage: 0, stagesFromEvents: false, cls: 'rifle' };
  const wpn = { id: undefined, fireMode: undefined, ads: 0, adsState: false };
  const ply = { sprinting: false, sliding: false, alive: true, lowHealth: 0 };
  const aiSteps = new Map();
  let aiFootEvents = false;
  const feet = { x: 0, y: 0, z: 0 };
  const isPlayerSource = (s) => s == null || s === 'player' || s === 'local';
  const isAISource = (s) => typeof s === 'string' && s.startsWith('ai');

  function bump(k) { intensity = Math.min(1, intensity + k); }

  function playerShot(weaponId, suppressed) {
    const e = live();
    if (!e) return NULL_HANDLE;
    const t = e.now();
    if (t - lastPlayerShot < 0.025) return NULL_HANDLE; // same trigger pull reported twice (event + direct call)
    lastPlayerShot = t;
    const ws = S().weapons.state || {};
    const ammoFrac = ws.magSize ? (ws.ammo ?? ws.magSize) / ws.magSize : 1;
    const ps = S().player.state;
    if (ps?.position) { feet.x = ps.position.x; feet.y = ps.position.y; feet.z = ps.position.z; }
    bump(0.03);
    return e.playerShot({ weaponId: weaponId || ws.id || 'rifle', suppressed: !!(suppressed ?? ws.suppressed), ammoFrac, surface: lastSurface, feet: ps?.position ? feet : null });
  }

  function remoteShot(origin, direction, weaponId, suppressed, end) {
    const e = live();
    if (!e) return;
    bump(0.02);
    if (end && direction) {
      // only let the round "fly by" if it actually travelled past the listener
      const L = e.listener.pos;
      const len = Math.hypot(end.x - origin.x, end.y - origin.y, end.z - origin.z);
      const along = (L.x - origin.x) * direction.x + (L.y - origin.y) * direction.y + (L.z - origin.z) * direction.z;
      if (along > len + 1) direction = null;
    }
    e.remoteShot({ origin, dir: direction, weaponId: weaponId || 'rifle', suppressed: !!suppressed });
  }

  // ------------------------------------------------------------------ event wiring
  function on(name, fn) { offs.push(events.on(name, fn)); }

  function wire() {
    on('core:user-gesture', () => { api.resume(); });
    on('settings:changed', ({ path, value }) => {
      if (!path?.startsWith('audio.') || !eng) return;
      const k = path.slice(6);
      if (k === 'hrtf') eng.hrtf = value !== false;
      else eng.setBusVolume(k, value);
    });
    on('world:ready', () => { director?.setEmitters(findEmitters()); });

    // --- weapons
    on('weapon:fired', (e) => {
      if (isAISource(e?.source)) { remoteShot(e.origin, e.direction, e.weaponId, e.suppressed); return; }
      playerShot(e?.weaponId, e?.suppressed);
    });
    on('combat:shot', (e) => {
      if (isAISource(e.source)) remoteShot(e.origin, e.direction, e.weaponId, e.suppressed, e.end);
      else if (isPlayerSource(e.source) && e.weaponId !== 'frag') playerShot(e.weaponId, e.suppressed);
    });
    for (const n of ['ai:fired', 'ai:fire', 'ai:shot', 'ai:shoot']) {
      on(n, (e) => {
        const o = e?.origin || e?.position || e?.agent?.position;
        if (!o) return;
        _p.set(o.x, o.y + (e.origin ? 0 : 1.45), o.z);
        remoteShot(_p, e.direction || e.dir || null, e.weaponId || e.agent?.weaponId, e.suppressed, e.end);
      });
    }
    on('weapon:reload', (e) => {
      const ws = S().weapons.state || {};
      const cls = weaponClass(e?.weaponId || ws.id);
      if (e?.phase === 'start') {
        reload.active = true; reload.stage = 0; reload.cls = cls;
        reload.empty = (ws.ammo ?? 1) <= 0 || !!e.empty;
        live()?.play('cloth_rustle', { volume: 0.6 });
      } else if (e?.phase === 'end' || e?.phase === 'cancel') {
        reload.active = false;
      } else if (e?.phase) {
        // explicit stage events from weapons (preferred when present): magout | magin | bolt | charge | slide
        reload.stagesFromEvents = true;
        const map = cls === 'pistol'
          ? { magout: 'pistol_mag_out', magin: 'pistol_mag_in', bolt: 'pistol_slide_release', slide: 'pistol_slide_release', charge: 'pistol_slide_release' }
          : { magout: 'mag_out', magin: 'mag_in', bolt: 'bolt_release', slide: 'bolt_release', charge: 'charging_handle' };
        const n = map[e.phase];
        if (n) live()?.play(n);
      }
    });
    on('weapon:equip', (e) => {
      wpn.id = e?.weaponId;
      const w = String(e?.weaponId || '');
      api.play(/frag|grenade/.test(w) ? 'grenade_equip' : weaponClass(w) === 'pistol' ? 'pistol_raise' : 'weapon_raise');
    });
    // weapons drives its own reload choreography through clip cues -> stop deriving it from reloadProgress
    on('weapons:cue', () => { reload.stagesFromEvents = true; });
    on('weapons:firemode', () => api.play('fire_select'));
    // real brass: one tink per physical casing bounce (vfx), surface from the player's feet / a short ray
    on('vfx:shell_bounce', (e) => {
      const en = live();
      if (!en || !e?.position) return;
      en.autoCasings = false;
      const sp = e.speed ?? 1;
      if (sp < 0.7) return;
      const p = e.position;
      const ps = S().player.state;
      let surf = footSurface(lastSurface);
      if (!ps?.position || Math.abs(p.y - ps.position.y) > 0.6 || Math.hypot(p.x - ps.position.x, p.z - ps.position.z) > 3) {
        _o.set(p.x, p.y + 0.15, p.z); _d.set(0, -1, 0);
        try { const h = S().world.raycast(_o, _d, 0.5); if (h?.surface) surf = footSurface(h.surface); } catch { /* keep */ }
      }
      const cs = surf === 'metal' ? 'metal' : surf === 'wood' ? 'wood' : (surf === 'dirt' || surf === 'grass' || surf === 'gravel' || surf === 'water') ? 'dirt' : 'concrete';
      en.play(`shell_tink_${cs}`, { position: p, propagate: false, volume: Math.min(1, 0.25 + sp / 5), pitch: e.weaponClass === 'pistol' ? 1.22 : 1 });
    });
    // a round passing within ~1.6 m of the eye: guarantee a snap/whizz even when the shot event did not
    on('combat:near-miss', (e) => {
      const en = live();
      if (!en || !e?.position || isPlayerSource(e.source)) return;
      if (en.now() - en.lastFlyby < 0.08) return;
      const dir = e.direction;
      if (!dir) return;
      // synthesize an origin 60 m up-range along the reverse direction
      _p.set(e.position.x - dir.x * 60, e.position.y - dir.y * 60, e.position.z - dir.z * 60);
      en.flyby(_p, dir, { supersonic: weaponClass(e.weaponId) !== 'pistol' && weaponClass(e.weaponId) !== 'smg' });
    });
    on('ai:grenade', (e) => {
      const p = e?.position;
      if (p) live()?.play('grenade_throw', { position: p, volume: 0.7 });
    });
    on('player:regen', (e) => { if (e?.phase === 'start') live()?.play('breath_recover', { volume: 0.8 }); });
    on('weapon:empty', () => live()?.play('dry_fire'));

    // --- combat
    on('combat:hit', (e) => {
      const en = live();
      if (!en || !e?.point) return;
      const fromPlayer = isPlayerSource(e.source);
      const L = en.listener.pos;
      const dl = Math.hypot(e.point.x - L.x, e.point.y - L.y, e.point.z - L.z);
      const hitsPlayer = e.target && (e.target === S().player || e.target?.isPlayer || e.target?.team === 'player' || dl < 0.9);
      if (!hitsPlayer) en.impact({ point: e.point, surface: e.surface, flesh: !!e.target, near: !fromPlayer && dl < 4 });
      if (fromPlayer && e.target && !hitsPlayer && ctx.settings.get('audio.hitmarkers', true) !== false) {
        const head = e.zone === 'head';
        if (markerPending !== 'kill' && markerPending !== 'killhead') markerPending = head ? 'headshot' : (markerPending === 'headshot' ? 'headshot' : 'hit');
      }
    });
    on('combat:kill', (e) => {
      if (isPlayerSource(e?.source) && e?.target && !(e.target?.isPlayer || e.target?.team === 'player') && ctx.settings.get('audio.hitmarkers', true) !== false) {
        markerPending = e.zone === 'head' || e.headshot ? 'killhead' : 'kill';
      }
    });
    on('combat:ricochet', (e) => {
      if (!seenRicochetEvents && eng) eng.randomRicochet = false;
      seenRicochetEvents = true;
      if (e?.point) live()?.play('ricochet', { position: e.point });
    });
    on('combat:penetration', (e) => { if (e?.point) live()?.impact({ point: e.point, surface: e.surface })?.setVolume?.(0.5); });
    on('combat:explosion', (e) => {
      const en = live();
      if (!en || !e?.position) return;
      bump(0.35);
      en.explosion({ position: e.position, radius: e.radius || 6 });
    });
    on('combat:grenade', (e) => {
      const en = live();
      if (!en) return;
      const own = isPlayerSource(e?.source);
      if (e?.phase === 'cook' && own) en.play('grenade_pin');
      else if (e?.phase === 'release' && own) en.play('grenade_throw');
      else if (e?.phase === 'thrown' && !own && e.position) en.play('grenade_throw', { position: e.position, volume: 0.6 });
      else if (e?.phase === 'empty') en.play('dry_fire', { volume: 0.4 });
    });
    on('combat:grenade-bounce', (e) => {
      const en = live();
      if (!en || !e?.position) return;
      const sp = e.speed ?? 3;
      if (sp < 0.6) return;
      const s = footSurface(e.surface);
      const n = s === 'metal' ? 'grenade_bounce_metal' : (s === 'dirt' || s === 'grass' || s === 'water' || s === 'gravel') ? 'grenade_bounce_dirt' : 'grenade_bounce_concrete';
      en.play(n, { position: e.position, volume: Math.min(1, 0.25 + sp / 8) });
    });
    on('ai:death', (e) => {
      const p = e?.agent?.position || e?.agent?.object?.position;
      if (p) live()?.play('body_fall', { position: { x: p.x, y: p.y + 0.3, z: p.z }, delay: 0.35 + rng.next() * 0.3 });
    });
    on('ai:footstep', (e) => {
      aiFootEvents = true;
      if (e?.position) live()?.footstep({ surface: e.surface, position: e.position, speed: e.speed ?? 3, stance: e.stance });
    });

    // --- player
    on('player:footstep', (e) => {
      lastSurface = e?.surface || lastSurface;
      const en = live();
      if (!en) return;
      en.footstep({ surface: lastSurface, speed: e.speed ?? 3, stance: e.stance, own: true })?.setVolume?.(0.6 + 0.5 * (e.volume ?? 0.75));
    });
    on('player:jump', () => live()?.play('jump'));
    on('player:land', (e) => {
      const s = footSurface(lastSurface);
      const base = s === 'metal' || s === 'wood' || s === 'gravel' || s === 'dirt' ? s : s === 'grass' || s === 'water' ? 'dirt' : 'concrete';
      live()?.play(`land_${base}${(e?.speed ?? 4) > 7 ? '_heavy' : ''}`, { volume: Math.min(1.2, 0.5 + (e?.speed ?? 4) / 10) });
    });
    on('player:stance', (e) => {
      const st = e?.stance;
      live()?.play(st === 'prone' ? 'stance_prone' : st === 'crouch' ? 'stance_crouch' : 'stance_stand');
    });
    on('player:slide', (e) => { if (e?.phase === 'start') live()?.play('slide', { volume: Math.min(1.1, 0.6 + (e.speed ?? 6) / 20) }); });
    on('player:mantle', (e) => {
      const en = live();
      if (!en) return;
      if (e?.phase === 'start') { en.play('cloth_rustle', { volume: 0.9 }); en.play('gear_rattle', { volume: 0.7, delay: 0.1 }); }
      else if (e?.phase === 'end') en.play(`land_${footSurface(lastSurface) === 'metal' ? 'metal' : 'concrete'}`, { volume: 0.45 });
    });
    on('player:tacsprint', (e) => { if (e?.active) { live()?.play('gear_rattle', { volume: 0.8 }); live()?.play('cloth_rustle', { volume: 0.7 }); } });
    on('player:damaged', (e) => {
      const en = live();
      if (!en) return;
      const amt = e?.amount ?? 20;
      const kind = e?.info?.kind || e?.info?.type;
      if (kind !== 'explosion' && kind !== 'fall') en.play('player_hit', { volume: Math.min(1.2, 0.45 + amt / 60) });
      else if (kind === 'fall') en.play('land_concrete_heavy');
      bump(0.1);
    });
    on('player:died', () => {
      const en = live();
      if (!en) return;
      en.setLowHealth(0);
      en.setMuffled(true);
      ply.alive = false;
      if (ctx.settings.get('audio.music_stingers', true) !== false) en.play('music_death', { delay: 0.4 });
    });
    const revive = () => { const en = live(); if (!en) return; ply.alive = true; en.setMuffled(false); en.play('ui_deploy', { volume: 0.7 }); };
    on('player:respawn', revive);

    // --- game mode, HUD, music
    const stinger = (n, delay = 0) => { if (ctx.settings.get('audio.music_stingers', true) !== false) live()?.play(n, { delay }); };
    on('gamemode:wave', (e) => {
      if (e?.phase === 'start') { stinger('music_wave_start'); live()?.play('ui_objective', { delay: 0.1 }); }
      else if (e?.phase === 'clear') stinger('music_wave_clear', 0.3);
    });
    on('gamemode:end', (e) => stinger(e?.victory ? 'music_victory' : 'music_death', 0.2));
    on('gamemode:streak', () => live()?.play('ui_killstreak', { delay: 0.25 }));
    on('gamemode:medal', () => live()?.play('ui_notify', { delay: 0.2 }));
    on('gamemode:kill', (e) => live()?.play('ui_score', { delay: 0.16, volume: e?.headshot ? 0.9 : 0.7 }));
    on('gamemode:resupply', () => { live()?.play('ui_notify'); live()?.play('gear_rattle', { delay: 0.1 }); });
    on('gamemode:flank', () => live()?.play('ui_notify', { volume: 0.8 }));
    on('gamemode:respawn', revive);
    const onPause = (e) => {
      const en = live();
      if (!en) return;
      en.setMuffled(!!e?.paused || !ply.alive);
      if (director) director.enabled = !e?.paused;
    };
    on('gamemode:pause', onPause);
    on('hud:pause', onPause);
    on('hud:menu', (e) => { if (e?.open) live()?.play('ui_click'); });
    on('hud:play', () => live()?.play('ui_deploy'));
    on('hud:restart', () => live()?.play('ui_confirm'));
    on('hud:respawn', () => live()?.play('ui_confirm'));
    on('hud:quit', () => live()?.play('ui_back'));
    on('audio:play', (e) => { if (e?.name) (e.position ? api.playAt(e.name, e.position, e) : api.play(e.name, e)); });
  }

  // ------------------------------------------------------------------ per-frame polling
  function pollWeapons(en) {
    const ws = S().weapons.state;
    if (!ws) return;
    if (wpn.fireMode !== undefined && ws.fireMode !== wpn.fireMode && ws.fireMode) api.play('fire_select');
    wpn.fireMode = ws.fireMode;
    const ads = ws.ads ?? 0;
    if (!wpn.adsState && ads > 0.35 && wpn.ads <= 0.35) { wpn.adsState = true; en.play('ads_in'); }
    else if (wpn.adsState && ads < 0.3) { wpn.adsState = false; en.play('ads_out'); }
    wpn.ads = ads;
    if (wpn.id !== undefined && ws.id && ws.id !== wpn.id) api.play(weaponClass(ws.id) === 'pistol' ? 'pistol_raise' : 'weapon_raise');
    if (ws.id) wpn.id = ws.id;
    // reload choreography from progress (unless weapons sends explicit stage events)
    const reloading = !!ws.reloading;
    if (reloading && !reload.active) { reload.active = true; reload.stage = 0; reload.cls = weaponClass(ws.id); reload.empty = (ws.ammo ?? 1) <= 0; }
    if (!reloading && reload.active && ws.reloadProgress === 0) reload.active = false;
    if (reload.active && !reload.stagesFromEvents) {
      const p = ws.reloadProgress ?? 0;
      const pistol = reload.cls === 'pistol';
      const steps = reload.empty ? [0.14, 0.52, 0.8] : [0.18, 0.62];
      while (reload.stage < steps.length && p >= steps[reload.stage]) {
        const st = reload.stage++;
        if (st === 0) en.play(pistol ? 'pistol_mag_out' : 'mag_out');
        else if (st === 1) en.play(pistol ? 'pistol_mag_in' : 'mag_in');
        else en.play(pistol ? 'pistol_slide_release' : 'bolt_release');
      }
      if (!reloading) reload.active = false;
    }
  }

  function pollPlayer(en) {
    const ps = S().player.state;
    if (!ps) return;
    if (ps.sprinting && !ply.sprinting) en.play('gear_rattle', { volume: 0.55 });
    ply.sprinting = !!ps.sprinting;
    const hp = ps.maxHealth ? ps.health / ps.maxHealth : 1;
    const low = ps.alive === false ? 0 : hp < 0.45 ? Math.min(1, (0.45 - hp) / 0.35) : 0;
    en.setLowHealth(low);
    if (ps.alive && !ply.alive) { ply.alive = true; en.setMuffled(false); }
  }

  function pollAI(en, dt) {
    if (aiFootEvents) return;
    const agents = S().ai.agents;
    if (!agents || !agents.length || dt <= 0) return;
    const L = en.listener.pos;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const p = a?.position;
      if (!p) continue;
      let r = aiSteps.get(a.id);
      if (!r) { r = { x: p.x, z: p.z, acc: 0, surface: 'concrete', n: 0 }; aiSteps.set(a.id, r); continue; }
      const dx = p.x - r.x, dz = p.z - r.z;
      r.x = p.x; r.z = p.z;
      if (!a.alive) continue;
      const d = Math.hypot(dx, dz);
      if (d > 3) continue; // teleport / spawn
      const speed = d / dt;
      if (speed < 0.4) { r.acc = 0; continue; }
      r.acc += d;
      const stride = speed > 4.2 ? 1.45 : 0.85;
      if (r.acc < stride) continue;
      r.acc -= stride;
      const dl = Math.hypot(p.x - L.x, p.y - L.y, p.z - L.z);
      if (dl > 40) continue;
      if ((r.n++ & 3) === 0) { // refresh the surface under the agent every 4 steps
        _o.set(p.x, p.y + 0.5, p.z); _d.set(0, -1, 0);
        const h = S().world.raycast(_o, _d, 2);
        if (h?.surface) r.surface = h.surface;
      }
      _p.set(p.x, p.y + 0.05, p.z);
      en.footstep({ surface: r.surface, position: _p, speed, stance: a.stance || 'stand' });
    }
  }

  // listener from the camera world matrix (no allocations)
  const _fwd = { x: 0, y: 0, z: -1 }, _up = { x: 0, y: 1, z: 0 }, _pos = { x: 0, y: 0, z: 0 };
  function updateListener(en) {
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    const m = cam.matrixWorld.elements;
    _pos.x = m[12]; _pos.y = m[13]; _pos.z = m[14];
    _fwd.x = -m[8]; _fwd.y = -m[9]; _fwd.z = -m[10];
    _up.x = m[4]; _up.y = m[5]; _up.z = m[6];
    en.setListener(_pos, _fwd, _up);
  }

  function flushMarker(en) {
    if (!markerPending) return;
    const k = markerPending;
    markerPending = null;
    if (k === 'kill') en.play('hitmarker_kill');
    else if (k === 'killhead') { en.play('hitmarker_kill'); en.play('hitmarker_headshot', { volume: 0.7 }); }
    else if (k === 'headshot') en.play('hitmarker_headshot');
    else en.play('hitmarker');
  }

  // ------------------------------------------------------------------ offline render (tools/audio.mjs)
  async function renderOffline(name, { duration, sampleRate = 48000, channels = 2, params = {} } = {}) {
    const scene = SCENES[name];
    const def = catalog[name];
    if (!scene && !def) throw new Error(`unknown sound "${name}". Available: ${api.list().join(', ')}`);
    const sr = sampleRate;
    const env = params.env || scene?.env || (def?.bus === 'ui' || def?.bus === 'music' ? 'street' : 'street');
    bank.bakeIRSync(env, sr);
    if (def) bank.bakeSync(name, sr);
    let dur = duration;
    if (dur == null) {
      if (scene) dur = scene.duration;
      else {
        const e = bank.data.get(name)[params.variant ?? 0];
        const len = e.chans[0].length / e.sr;
        const wet = def.loop ? 0 : (def.reverb || 0) > 0.05 ? Math.min(2.6, IR_PRESETS[env].len * 0.8) : 0.1;
        dur = Math.min(40, len + wet + 0.1);
      }
    }
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    // pre-roll: DynamicsCompressor gain starts at 0 and ramps up over ~100 ms at the start of a render
    // (it is settled in the realtime game), so render PRE seconds early and drop them afterwards
    const PRE = params.noPreroll ? 0 : 0.3;
    const pre = Math.round(PRE * sr);
    const oac = new OAC(channels, Math.max(1, Math.ceil(dur * sr)) + pre, sr);
    const e = new AudioEngine(oac, bank, { rng: new Rand(`offline:${name}`), offline: true, volumes: { master: 1, sfx: 1, music: 1, ui: 1, voice: 1, ambience: 1 } });
    e.timeBase = -pre / sr;
    e.onMissing = (n) => bank.bakeSync(n, sr);
    // diagnostics: bypass the master dynamics / the environment reverb
    if (params.noMaster) { e.master.disconnect(); e.master.connect(oac.destination); }
    if (params.onlyGlue) { e.master.disconnect(); e.master.connect(e.glue); e.glue.disconnect(); e.glue.connect(oac.destination); }
    if (params.onlyLimiter) { e.master.disconnect(); e.master.connect(e.limiter); }
    if (params.noReverb) e.revOut.gain.value = 0;
    if (params.onlyReverb) e.onlyReverb = true;
    e.setEnvironment(env, 0, params.envLevel ?? envLevel(env));
    const walls = params.walls || REFLECT_PRESETS[env] || [];
    for (let i = 0; i < 9; i++) { const w = walls[i] || [null]; e.setReflection(i, w[0], w[1] ?? 0.85, reflectDir(i), 0); }
    e._updateER(0);
    if (params.listener) e.setListener(params.listener.pos || { x: 0, y: 0, z: 0 }, params.listener.fwd || { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });
    if (scene) scene.build(e, new Rand(`scene:${name}`));
    else if (GUN_RE.test(name) && !params.dry) e.playerShot({ weaponId: name.split('_')[0], suppressed: name.includes('suppressed'), at: 0.02 });
    else e.play(name, { at: 0.02, variant: params.variant ?? 0, position: params.position, loop: def.loop ? true : undefined });
    const full = await oac.startRendering();
    if (!pre) return full;
    const out = new AudioBuffer({ numberOfChannels: full.numberOfChannels, length: full.length - pre, sampleRate: sr });
    for (let c = 0; c < full.numberOfChannels; c++) out.copyToChannel(full.getChannelData(c).subarray(pre), c);
    return out;
  }

  // ------------------------------------------------------------------ name resolution / helpers
  const recent = new Map();
  function resolve(name) {
    if (catalog[name]) return name;
    if (Object.prototype.hasOwnProperty.call(ALIAS, name)) return ALIAS[name];
    // '<kind>_<cue>' from any weapon kind: try the rifle/pistol mapping by class
    const m = /^([a-z0-9]+)_(.+)$/i.exec(name);
    if (m) {
      const cls = weaponClass(m[1]);
      const k = `${cls === 'pistol' ? 'pistol' : 'rifle'}_${m[2]}`;
      if (Object.prototype.hasOwnProperty.call(ALIAS, k)) return ALIAS[k];
      if (catalog[m[2]]) return m[2];
    }
    return name; // engine warns once for unknown names
  }
  // grenade bounce with the surface under it (one short ray)
  const _bo = new THREE.Vector3(), _bd = new THREE.Vector3(0, -1, 0);
  function bounceAt(name, position, opts) {
    const en = live();
    if (!en) return NULL_HANDLE;
    let surf = 'concrete';
    try {
      _bo.set(position.x, position.y + 0.25, position.z);
      const h = S().world.raycast(_bo, _bd, 0.8);
      if (h?.surface) surf = footSurface(h.surface);
    } catch { /* keep concrete */ }
    const n = surf === 'metal' ? 'grenade_bounce_metal' : (surf === 'dirt' || surf === 'grass' || surf === 'water' || surf === 'gravel') ? 'grenade_bounce_dirt' : 'grenade_bounce_concrete';
    return en.play(n, { ...opts, position });
  }

  // ------------------------------------------------------------------ public API
  const api = {
    get context() { return ac; },
    get engine() { return eng; },
    get environment() { return envState.current; },
    get bakeProgress() { return bakeTotal ? bakeDone / bakeTotal : 0; },
    play(name, opts = {}) {
      if (shotMode || typeof name !== 'string') return NULL_HANDLE;
      const en = live();
      if (!en) return NULL_HANDLE;
      if (!opts.position && GUN_RE.test(name)) return playerShot(name.split('_')[0], name.includes('suppressed'));
      name = resolve(name);
      if (!name) return NULL_HANDLE;
      if (RELOAD_STAGE.test(name)) reload.stagesFromEvents = true;
      if (!opts.position && !opts.loop) {
        // the same 2D cue reported twice (event handler + direct call from another system) -> play once
        const t = en.now(), last = recent.get(name);
        const gap = catalog[name]?.minGap ?? 0.09;
        if (last !== undefined && t - last < gap) return NULL_HANDLE;
        recent.set(name, t);
      }
      if (name.startsWith('grenade_bounce') && opts.position && !opts.surfaced) return bounceAt(name, opts.position, opts);
      return en.play(name, opts);
    },
    playAt(name, position, opts = {}) {
      if (shotMode || !position) return api.play(name, opts);
      const en = live();
      if (!en || typeof name !== 'string') return NULL_HANDLE;
      if (GUN_RE.test(name) || /_fire_3p$/.test(name)) { remoteShot(position, opts.direction || null, name.split('_')[0], name.includes('suppressed')); return NULL_HANDLE; }
      name = resolve(name);
      if (!name) return NULL_HANDLE;
      if (name.startsWith('grenade_bounce') && !opts.surfaced) return bounceAt(name, position, opts);
      return en.play(name, { ...opts, position });
    },
    list: () => [...Object.keys(catalog), ...Object.keys(SCENES)],
    setVolume(bus, v) {
      if (typeof v !== 'number') return;
      eng?.setBusVolume(bus, v);
    },
    resume() {
      if (shotMode) return Promise.resolve();
      const a = ensure();
      if (!a) return Promise.resolve();
      return a.resume().catch(() => {});
    },
    renderOffline,
    // ---- extensions
    gunshot({ origin, direction = null, weaponId = 'rifle', suppressed = false, end = null, source = 'ai' } = {}) {
      if (shotMode) return;
      if (isPlayerSource(source)) playerShot(weaponId, suppressed); else if (origin) remoteShot(origin, direction, weaponId, suppressed, end);
    },
    impact(o) { return shotMode ? NULL_HANDLE : live()?.impact(o) || NULL_HANDLE; },
    explosion(o) { if (!shotMode) live()?.explosion(o); },
    footstepAt(position, surface = 'concrete', speed = 3, stance = 'stand') { return shotMode ? NULL_HANDLE : live()?.footstep({ position, surface, speed, stance }) || NULL_HANDLE; },
    ui(kind) { return api.play(kind.startsWith('ui_') ? kind : `ui_${kind}`); },
    stinger(name) { return api.play(name.startsWith('music_') ? name : `music_${name}`); },
    setEnvironment(name) { envOverride = name && IR_PRESETS[name] ? name : null; if (envOverride) { envState.current = null; classify(); } },
    setIntensity(v) { intensity = Math.max(0, Math.min(1, v)); },
    setAmbience(onOff) { ambienceOn = !!onOff; if (!director) return; if (ambienceOn && live()) director.start(eng.now(), 3); else director.stop(2); },
    setMuffled(b) { live()?.setMuffled(b); },
    describe(name) { const d = catalog[name]; if (!d) return SCENES[name] ? { scene: true, description: SCENES[name].description, duration: SCENES[name].duration } : null; const { gen, ...meta } = d; return meta; },
    stats() { return { ...(eng?.stats || {}), voices: eng?.voices.length || 0, state: ac?.state || 'none', environment: envState.current, bake: `${bakeDone}/${bakeTotal}`, intensity }; },
  };

  return {
    name: 'audio',
    async init() {
      ctx.services.provide('audio', api);
      if (shotMode) return; // silent & deterministic; renderOffline still works
      startBaking();
      wire();
      if (ctx.debug?.gui) {
        const f = ctx.debug.gui.addFolder('audio');
        const o = { env: 'auto', test: 'rifle_fire', play: () => api.play(o.test), stats: () => console.log('[system:audio]', api.stats()) };
        f.add(o, 'env', ['auto', ...IR_NAMES]).onChange((v) => api.setEnvironment(v === 'auto' ? null : v));
        f.add(o, 'test', Object.keys(catalog));
        f.add(o, 'play'); f.add(o, 'stats');
        f.close();
      }
    },
    update(dt) {
      if (!eng || disposed) return;
      if (bakeQueue) bakeStep();
      const en = live();
      if (!en) return;
      occBudget = 16;
      try { pollWeapons(en); } catch (e) { ctx.reportError('audio', 'pollWeapons', e); }
      pollPlayer(en);
      pollAI(en, dt);
      probeEnvironment(dt);
      intensity = Math.max(0, intensity - dt * 0.04);
      if (director) { director.intensity = intensity; director.update(en.now()); }
      en.update();
    },
    lateUpdate() {
      const en = live();
      if (!en) return;
      updateListener(en);
      flushMarker(en);
    },
    dispose() {
      disposed = true;
      for (const off of offs) { try { off(); } catch { /* ignore */ } }
      offs.length = 0;
      try { worker?.terminate(); } catch { /* ignore */ }
      try { director?.stop(0.1); eng?.stopAll(0.05); } catch { /* ignore */ }
      try { ac?.close(); } catch { /* ignore */ }
      ac = null; eng = null; director = null;
    },
  };
}

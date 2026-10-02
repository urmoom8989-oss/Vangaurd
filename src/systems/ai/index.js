import * as THREE from 'three';
import { SoldierFactory, VARIANTS } from './character/factory.js';
import { SoldierBody, disposeShared } from './character/body.js';
import { WorldQuery } from './worldquery.js';
import { CoverManager } from './brain/cover.js';
import { Squad } from './brain/squad.js';
import { Agent } from './brain/agent.js';
import { CFG } from './brain/config.js';
import { GrenadeSystem } from './grenade.js';

/**
 * ai — Crimson Vanguard PMC soldiers. Owner: ai agent. See PROGRESS.md.
 *
 * services.ai (contract + extensions):
 *   agents: Agent[]   Agent = { id, object, position, alive, state, team, +key 'ai:<id>', +name, +weaponId,
 *                               +loadoutName, +health, +maxHealth, +squad, +velocity, +mode }
 *   spawn({position?, yaw? (rad), loadout?: 'rifle'|'smg'|'lmg'|'shotgun', behavior?, team?}) -> Agent | null
 *      behavior: { role:'assault'|'flank'|'rush', aggression 0..1.3, accuracy 0.2..1.5, objective: Vector3,
 *                  target:'player', squad: id, name, health }
 *   count() -> alive agents;  killAll();  setEnabled(bool);  +clear() (despawn everything incl. corpses)
 *   +stats() -> {alive, corpses, shots, kills, lod:[n0,n1,n2], factory}
 *   +setPuppet(agent, puppet|null)   drive an agent directly (shots / cinematics)
 * Emits: 'ai:spawn' {agent}, 'ai:death' {agent, info}, 'ai:alert' {agent, target, position},
 *        'ai:footstep' {surface, position, speed, stance, agent}, 'ai:fire' {source, weaponId} (HUD reveal only)
 * Listens: weapon:fired (hearing), combat:shot (near-miss suppression), combat:hit (impacts nearby).
 */

const _cam = new THREE.Vector3();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _pm = new THREE.Matrix4();
const _sphere = new THREE.Sphere(new THREE.Vector3(), 1.3);
const DEG = Math.PI / 180;

export default function createSystem(ctx) {
  const rng = ctx.rng.fork('ai');
  const factory = new SoldierFactory(ctx);
  const wq = new WorldQuery(ctx);
  const cover = new CoverManager(wq);
  const agents = [];
  const free = []; // pooled idle agents (bodies kept)
  const replayHistory = new Map();
  const squads = new Map();
  const offs = [];
  let nextId = 1;
  let frame = 0;
  let replaySampleT = -1;
  let fallbackGrenades = null;

  const sys = {
    ctx, wq, cover, agents, rng,
    enabled: true,
    cpuFixed: 0, cpuMs: 0, cpuMax: 0,
    stats: { shots: 0, kills: 0, spawned: 0 },
    lastGrenadeT: -1e9,
    playerFiredT: -1e9,
    pendingUnregister: [],
    impulse: { point: new THREE.Vector3(), dir: new THREE.Vector3(), strength: 1, zone: 'torso' },
    grenadeFallback(from, target, agent) {
      if (!fallbackGrenades) fallbackGrenades = new GrenadeSystem(ctx, wq);
      const vel = GrenadeSystem.solve(from, target, 0.75, new THREE.Vector3());
      fallbackGrenades.throw(from, vel, agent);
    },
    onAgentDeath(agent, info) {
      sys.stats.kills++;
      agent.squad?.remove(agent);
      ctx.events.emit('ai:death', { agent, info });
    },
  };

  // ------------------------------------------------------------------ spawning
  function makeAgent() {
    const id = nextId++;
    const variant = (id * 7 + 3) % VARIANTS.length;
    const mat = factory.materials[(id * 5 + 1) % factory.materials.length];
    const body = new SoldierBody({ geometries: factory.geometries[variant], material: mat, name: `ai_soldier_${id}` });
    const a = new Agent(sys, id, body);
    a.variant = variant;
    return a;
  }

  function reuseAgent() {
    // recycle a pooled body under a fresh id (ids stay unique for combat/hud lookups)
    const a = free.pop();
    a.id = nextId++;
    a.key = `ai:${a.id}`;
    return a;
  }

  function spawn(opts = {}) {
    if (!factory.geometries.length) return null;
    let alive = 0;
    for (const a of agents) if (a.alive) alive++;
    if (alive >= CFG.maxAgents) return null;
    // make room: drop the oldest corpse when the scene is full
    if (agents.length >= CFG.maxAgents + CFG.corpseLimit) {
      const oldest = agents.filter((a) => !a.alive).sort((x, y) => x.deathT - y.deathT)[0];
      if (oldest) removeAgent(oldest);
    }
    const t = ctx.time.t;
    const pos = _p;
    if (opts.position) pos.copy(opts.position);
    else {
      const sp = ctx.services.world.spawnPoints?.ai;
      if (sp && sp.length) pos.copy(sp[Math.floor(rng.next() * sp.length)].position);
      else ctx.services.world.nav.randomPoint(pos);
    }
    const a = free.length ? reuseAgent() : makeAgent();
    if (opts.variant !== undefined) {
      a.variant = opts.variant % VARIANTS.length;
      a.body.geometries = factory.geometries[a.variant];
      a.body.lod = -1; a.body.setLOD(0);
    }
    if (opts.tint !== undefined) a.body.mesh.material = factory.materials[opts.tint % factory.materials.length];
    ctx.scene.add(a.body.group);
    const behavior = opts.behavior || {};
    a.spawn({ position: pos, yaw: opts.yaw ?? 0, loadout: opts.loadout || 'rifle', behavior, team: opts.team || 'enemy', t });
    const sqId = behavior.squad ?? `solo${a.id}`;
    let sq = squads.get(sqId);
    if (!sq || sq.alive === 0) { sq = new Squad(typeof sqId === 'number' ? sqId : a.id * 13); squads.set(sqId, sq); }
    sq.add(a);
    agents.push(a);
    sys.stats.spawned++;
    ctx.events.emit('ai:spawn', { agent: a });
    return a;
  }

  function removeAgent(a) {
    a.despawn();
    replayHistory.delete(a.key);
    const i = agents.indexOf(a);
    if (i >= 0) agents.splice(i, 1);
    free.push(a);
  }

  function recordReplayFrames(t) {
    if (t - replaySampleT < 0.08) return;
    replaySampleT = t;
    for (const agent of agents) {
      if (!agent.alive) continue;
      let history = replayHistory.get(agent.key);
      if (!history) { history = { frames: Array.from({ length: 50 }, () => ({})), next: 0, count: 0 }; replayHistory.set(agent.key, history); }
      const sample = history.frames[history.next];
      sample.t = t;
      sample.x = agent.position.x;
      sample.y = agent.position.y + 1.64;
      sample.z = agent.position.z;
      sample.yaw = agent.aimYaw;
      sample.pitch = agent.aimPitch;
      // Killcam mount: perched just above the killer's head and slightly forward so the view feels
      // like an overhead spectator angle instead of a camera embedded in the skull.
      const cp = Math.cos(agent.aimPitch);
      const fx = Math.sin(agent.aimYaw) * cp;
      const fy = Math.sin(agent.aimPitch);
      const fz = Math.cos(agent.aimYaw) * cp;
      const rx = Math.cos(agent.aimYaw);
      const rz = -Math.sin(agent.aimYaw);
      sample.cx = agent.position.x - fx * 0.16 + rx * 0.08;
      sample.cy = agent.position.y + 1.96 - fy * 0.12 + 0.18;
      sample.cz = agent.position.z - fz * 0.16 + rz * 0.08;
      history.next = (history.next + 1) % history.frames.length;
      history.count = Math.min(history.count + 1, history.frames.length);
    }
  }

  function getReplayFrames(agentId, duration = 3) {
    const history = replayHistory.get(String(agentId));
    if (!history || history.count < 2) return [];
    const oldest = (history.next - history.count + history.frames.length) % history.frames.length;
    const all = [];
    for (let i = 0; i < history.count; i++) all.push(history.frames[(oldest + i) % history.frames.length]);
    const cutoff = all[all.length - 1].t - Math.max(0.5, duration);
    return all.filter((sample) => sample.t >= cutoff).map(({ t, x, y, z, yaw, pitch, cx, cy, cz }) => ({ t, x, y, z, yaw, pitch, cx, cy, cz }));
  }

  function killAll() {
    for (const a of agents.slice()) {
      if (!a.alive || !a.damageable) continue;
      ctx.services.combat.applyDamage(a.damageable, 1e6, { source: 'world', kind: 'fall', zone: 'torso', direction: _v.set(0, 0, 1) });
      if (a.alive) a.onDeath({ kind: 'fall', zone: 'torso' });
    }
  }

  function clear() {
    for (const a of agents.slice()) removeAgent(a);
    squads.clear();
    fallbackGrenades?.clear();
  }

  // ------------------------------------------------------------------ perception events
  function onWeaponFired(e) {
    if (!e?.origin) return;
    const t = ctx.time.t;
    sys.playerFiredT = t;
    const suppressed = /suppress|silenc/i.test(String(e.weaponId || ''));
    for (const a of agents) if (a.alive) a.hear(e.origin, t, suppressed ? 0.25 : 1);
  }

  const _seg = new THREE.Vector3();
  function onShot(e) {
    if (!e || e.source !== 'player' || !e.origin) return;
    const end = e.end || e.point;
    if (!end) return;
    const t = ctx.time.t;
    _seg.subVectors(end, e.origin);
    const len = _seg.length();
    if (len < 1e-3) return;
    _seg.divideScalar(len);
    for (const a of agents) {
      if (!a.alive) continue;
      a.chest(_v).sub(e.origin);
      const along = _v.dot(_seg);
      if (along < 0 || along > len + 1) continue;
      const perp = _v.addScaledVector(_seg, -along).length();
      if (perp < 1.6) a.nearMiss(0.18 + 0.3 * (1 - perp / 1.6), e.origin, t);
    }
  }

  function onHit(e) {
    if (!e || e.source !== 'player' || !e.point || e.target) return;
    const t = ctx.time.t;
    for (const a of agents) {
      if (!a.alive) continue;
      const d = a.position.distanceTo(e.point);
      if (d < 2.2) a.nearMiss(0.12 * (1 - d / 2.2), null, t);
    }
  }

  // ------------------------------------------------------------------ shot presets
  function applyShotConfig() {
    const cfg = ctx.shot?.ai;
    if (!cfg) return;
    if (cfg.brain === false) sys.enabled = false;
    for (const s of cfg.spawn || []) {
      const p = s.position;
      const pos = new THREE.Vector3(p[0], 0, p[2]);
      pos.y = p[1] === null || p[1] === undefined ? wq.ground(p[0], p[2], 50, 0) : p[1];
      const a = spawn({ position: pos, yaw: (s.yaw || 0) * DEG, loadout: s.loadout, behavior: s.behavior, variant: s.variant, tint: s.tint });
      if (!a) continue;
      if (s.puppet) setPuppet(a, s.puppet);
      if (s.mode === 'combat') { a.know(ctx.services.player.state.position, ctx.time.t, true); a.enterCombat(ctx.time.t, 'shot'); }
      a.shotKill = s.kill || null;
      a.shotCfg = s;
    }
  }

  function setPuppet(a, P) {
    if (!P) { a.puppet = null; return; }
    const q = { ...P };
    if (q.aimYaw !== undefined) q.aimYaw *= DEG;
    if (q.aimPitch !== undefined) q.aimPitch *= DEG;
    if (q.bodyYaw !== undefined) q.bodyYaw *= DEG;
    a.puppet = q;
    a.aimYaw = q.aimYaw ?? a.aimYaw;
    a.bodyYaw = q.bodyYaw ?? a.aimYaw;
    a.aimPitch = q.aimPitch ?? 0;
    a.crouch = q.crouch ?? 0;
    a.weaponMode = q.weapon ?? 'aim';
    a.anim.in.bodyYaw = a.bodyYaw; a.anim.in.aimYaw = a.aimYaw; a.anim.in.crouch = a.crouch; a.anim.in.weapon = a.weaponMode;
    a.anim.initialized = false;
  }

  function shotKills(t) {
    for (const a of agents) {
      const k = a.shotKill;
      if (!k || !a.alive || t < k.t) continue;
      a.shotKill = null;
      const dir = new THREE.Vector3().fromArray(k.dir || [0, 0, -1]).normalize();
      const point = a.chest(new THREE.Vector3());
      if (k.zone === 'head') a.eye(point);
      if (k.zone === 'legs') point.set(a.position.x, a.position.y + 0.6, a.position.z);
      const info = { source: 'player', kind: k.kind || 'bullet', zone: k.zone === 'legs' ? 'limb' : (k.zone || 'torso'), direction: dir, point, weaponId: 'ar7', amount: k.amount || 40 };
      if (k.kind === 'explosion') { info.origin = new THREE.Vector3().fromArray(k.origin); }
      if (a.damageable) ctx.services.combat.applyDamage(a.damageable, 1e4, info);
      if (a.alive) a.onDeath(info);
    }
  }

  // ------------------------------------------------------------------ per-frame
  function lodPass() {
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    _cam.setFromMatrixPosition(cam.matrixWorld);
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
    const counts = sys.lodCounts || (sys.lodCounts = [0, 0, 0]);
    counts[0] = counts[1] = counts[2] = 0;
    for (const a of agents) {
      const d = a.position.distanceTo(_cam);
      // hysteresis
      const cur = a.lodLevel ?? 0;
      const k = 1.5;
      let l = 0;
      if (d > CFG.lod2 + (cur === 2 ? -k : k)) l = 2;
      else if (d > CFG.lod1 + (cur >= 1 ? -k : k)) l = 1;
      a.lodLevel = l;
      a.body.setLOD(l);
      counts[l]++;
      a.camDist = d;
      _sphere.center.copy(a.position); _sphere.center.y += 1;
      a.onScreen = _frustum.intersectsSphere(_sphere);
      a.body.mesh.castShadow = d < 90;
    }
  }

  function updateCorpses(t) {
    if (ctx.flags.shotMode) return;
    let corpses = 0;
    for (const a of agents) if (!a.alive) corpses++;
    for (const a of agents.slice()) {
      if (a.alive) continue;
      const age = t - a.deathT;
      const tooMany = corpses > CFG.corpseLimit;
      if (age > CFG.corpseTime || (tooMany && age > 4)) {
        if (!a.sinkT) a.sinkT = t;
        const s = t - a.sinkT;
        a.sinkOffset = Math.min(0.9, s * 0.35);
        if (s > 2.6 || (!a.onScreen && s > 0.1)) { removeAgent(a); corpses--; }
      }
    }
  }

  return {
    name: 'ai',
    async init() {
      ctx.settings.registerDefaults?.('ai', { enabled: true, debugHitboxes: false });
      await ctx.assets.track(factory.load(), 'ai:soldiers');
      offs.push(ctx.events.on('weapon:fired', onWeaponFired));
      offs.push(ctx.events.on('combat:shot', onShot));
      offs.push(ctx.events.on('combat:hit', onHit));

      const api = {
        agents,
        spawn,
        getReplayFrames,
        count() { let n = 0; for (const a of agents) if (a.alive) n++; return n; },
        killAll,
        clear,
        setEnabled(b) { sys.enabled = !!b; },
        get enabled() { return sys.enabled; },
        setPuppet,
        stats() {
          let alive = 0, corpses = 0;
          for (const a of agents) { if (a.alive) alive++; else corpses++; }
          return { alive, corpses, shots: sys.stats.shots, kills: sys.stats.kills, spawned: sys.stats.spawned, lod: sys.lodCounts ? sys.lodCounts.slice() : [0, 0, 0], tris: factory.stats.tris, cpuMs: +sys.cpuMs.toFixed(3), cpuMax: +sys.cpuMax.toFixed(2), baked: factory.baked, loadMs: Math.round(factory.stats.loadMs) };
        },
        cover,
        squads,
      };
      ctx.services.provide('ai', api);
      await ctx.services.world.ready;
      cover.ensure();
      applyShotConfig();
    },

    fixedUpdate(dt, t) {
      const c0 = performance.now(); // profiling only (never feeds the simulation)
      recordReplayFrames(t);
      // deferred hitbox removal (never mutate combat's lists inside its own callbacks)
      if (sys.pendingUnregister.length) {
        for (const a of sys.pendingUnregister) if (a.damageable) { a.damageable.unregister(); a.damageable = null; }
        sys.pendingUnregister.length = 0;
      }
      if (ctx.shot?.ai) shotKills(t);
      const brain = sys.enabled && ctx.settings.get('ai.enabled') !== false;
      for (const a of agents) {
        if (!a.alive) continue;
        if (brain && !a.puppet) {
          if (t >= a.perceiveAt) { a.perceiveAt = t + CFG.perceiveEvery; a.perceive(t); }
          if (t >= a.thinkAt) { a.thinkAt = t + CFG.thinkEvery; a.think(t); }
        } else if (!a.puppet) { a.stop(); a.fireMode = 'none'; }
        a.act(dt, t);
      }
      fallbackGrenades?.update(dt);
      sys.cpuFixed += performance.now() - c0;
    },

    update(dt, t) {
      const c0 = performance.now();
      frame++;
      lodPass();
      for (const a of agents) {
        a.animDt += dt;
        // cheaper animation for distant / off-screen soldiers
        let every = 1;
        if (a.alive) {
          if (!a.onScreen) every = a.camDist > 20 ? 4 : 2;
        } else if (a.ragdoll.sleeping) { a.animDt = 0; if (a.sinkOffset) applySink(a); continue; }
        if ((frame + a.id) % every !== 0) continue;
        a.animate(a.animDt, t);
        if (a.sinkOffset) applySink(a);
        a.animDt = 0;
      }
      updateCorpses(t);
      const ms = performance.now() - c0 + sys.cpuFixed;
      sys.cpuFixed = 0;
      sys.cpuMs = sys.cpuMs * 0.95 + ms * 0.05;
      sys.cpuMax = Math.max(sys.cpuMax * 0.995, ms);
    },

    dispose() {
      for (const off of offs) off?.();
      offs.length = 0;
      clear();
      for (const a of free) a.body.dispose();
      free.length = 0;
      fallbackGrenades?.dispose();
      factory.dispose();
      disposeShared();
    },
  };

  function applySink(a) {
    // corpses slide into the ground before being recycled
    a.body.mesh.position.y = -a.sinkOffset;
  }
}

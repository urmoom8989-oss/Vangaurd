import * as THREE from 'three';
import { ROLES, bearingName } from './config.js';

/** Friendly names for world.zones (flank callouts read "from the fuel depot" instead of a bearing). */
const ZONE_NAMES = {
  mainstreet: 'Main Street', stationroad: 'Station Road', courtyard: 'the courtyard', depot: 'the fuel depot',
  alleys: 'the alleys', warehouse: 'the warehouse', market: 'the market', garage: 'the garage',
};

/**
 * gamemode/spawner.js — picks spawn points for Crimson Vanguard squads and asks services.ai to spawn.
 *
 * Selection scores every world.spawnPoints.ai entry:
 *  - hard reject: closer than MIN_DIST to the player (unless nothing else exists)
 *  - out of the player's view cone (+), occluded from the player's eye (+)
 *  - preferred engagement distance band (25–55 m)
 *  - flank squads prefer points BEHIND / beside the player (angle > 100°)
 *  - recently used points are penalised so assaults come from varied lanes
 *  - small seeded jitter (ctx.rng fork) so identical states still vary between waves, deterministically
 * Squad members are placed on a small ring around the chosen point, validated against walls and ground.
 *
 * Allocation note: world.raycast returns new Hit objects; this runs only when a squad spawns (a few
 * times per wave), never per frame.
 */
const MIN_DIST = 16;
const PREF_NEAR = 24;
const PREF_FAR = 55;
const VIEW_COS = Math.cos(THREE.MathUtils.degToRad(62)); // half of a ~124° hfov cone + margin

export function createSpawner(ctx, rng) {
  const _toSpawn = new THREE.Vector3();
  const _eye = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _p = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const lastUsed = new Map(); // index -> sim time
  let squadSeq = 0;

  const fallback = [];
  let fallbackKey = '';
  /** world.spawnPoints.ai, or (world stub / broken) a ring of synthetic points around the plaza. */
  function points() {
    const sp = ctx.services.world.spawnPoints;
    if (sp && Array.isArray(sp.ai) && sp.ai.length) return sp.ai;
    const world = ctx.services.world;
    const b = world.bounds;
    const key = b ? `${b.min.x},${b.min.z},${b.max.x},${b.max.z}` : 'none';
    if (key !== fallbackKey) {
      fallbackKey = key;
      fallback.length = 0;
      const cx = b ? (b.min.x + b.max.x) / 2 : 0;
      const cz = b ? (b.min.z + b.max.z) / 2 : 0;
      const half = b ? Math.min(b.max.x - b.min.x, b.max.z - b.min.z) / 2 : 40;
      const r = Math.max(18, Math.min(36, half - 4));
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const p = new THREE.Vector3(cx + Math.sin(a) * r, 0, cz - Math.cos(a) * r);
        try { world.nav?.nearestWalkable?.(p, p); } catch { /* optional */ }
        try { const y = world.groundHeight(p.x, p.z, 50); if (Number.isFinite(y)) p.y = y; } catch { /* stub */ }
        fallback.push({ position: p, yaw: Math.atan2(p.x - cx, p.z - cz) });
      }
    }
    return fallback;
  }

  function occluded(eye, target) {
    _dir.subVectors(target, eye);
    const dist = _dir.length();
    if (dist < 1e-3) return false;
    _dir.multiplyScalar(1 / dist);
    const hit = ctx.services.world.raycast(eye, _dir, dist);
    return !!hit && hit.distance < dist - 1.0;
  }

  /**
   * @param {{flank:boolean, t:number}} o
   * @returns {{index:number, point:{position,yaw}, flank:boolean, bearing:string, distance:number}|null}
   */
  function pick({ flank, t, visible = false }) {
    const list = points();
    if (!list) return null;
    const ps = ctx.services.player.state;
    _eye.copy(ps.eye);
    if (_eye.lengthSq() === 0) _eye.copy(ps.position).y += 1.6;
    _fwd.copy(ps.forward);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();

    let best = -Infinity;
    let bestI = -1;
    let bestAng = 0;
    let bestDist = 0;
    for (let i = 0; i < list.length; i++) {
      const pos = list[i].position;
      _toSpawn.set(pos.x - ps.position.x, 0, pos.z - ps.position.z);
      const dist = _toSpawn.length();
      if (dist < 1e-3) continue;
      _toSpawn.multiplyScalar(1 / dist);
      const cos = _toSpawn.dot(_fwd);
      const ang = Math.acos(THREE.MathUtils.clamp(cos, -1, 1));
      let s = 0;
      if (dist < MIN_DIST) s -= 100; // only used when nothing else is available
      else if (dist < PREF_NEAR) s += (dist - MIN_DIST) / (PREF_NEAR - MIN_DIST) * 2;
      else if (dist <= PREF_FAR) s += 2;
      else s += Math.max(0, 2 - (dist - PREF_FAR) / 20);
      const inView = cos >= VIEW_COS;
      _p.set(pos.x, pos.y + 1.4, pos.z);
      const occ = occluded(_eye, _p);
      if (visible) {
        // showcase / tutorial: prefer hostiles the player can see coming
        s += inView ? 4 : -2;
        s += occ ? 0 : 1;
      } else {
        if (!inView) s += 3; // outside the view cone
        if (flank) s += ang > 1.75 ? 4 : ang > 1.2 ? 1.5 : -2; // behind / beside
        if (occ) s += 2.5;
      }
      const lu = lastUsed.get(i);
      if (lu !== undefined) s -= Math.max(0, 3 - (t - lu) / 8); // fades out over ~24 s
      s += rng.next() * 1.5;
      if (s > best) { best = s; bestI = i; bestAng = ang; bestDist = dist; }
    }
    if (bestI < 0) return null;
    lastUsed.set(bestI, t);
    const pos = list[bestI].position;
    return {
      index: bestI,
      point: list[bestI],
      flank: flank && bestAng > 1.2,
      bearing: zoneName(pos) || bearingName(pos.x - ps.position.x, pos.z - ps.position.z),
      distance: bestDist,
    };
  }

  function zoneName(pos) {
    const zones = ctx.services.world.zones;
    if (!zones) return null;
    for (const k in zones) {
      if (k === 'plaza') continue;
      const z = zones[k];
      if (z?.isBox3 && z.containsPoint(pos)) return `from ${ZONE_NAMES[k] || k}`;
    }
    return null;
  }

  /** A synthetic pick at an explicit [x, z] (shot scenarios only; not scored, not flanking). */
  function pinned(xz) {
    const world = ctx.services.world;
    const gy = world.groundHeight(xz[0], xz[1], 60);
    const position = new THREE.Vector3(xz[0], Number.isFinite(gy) ? gy : 0, xz[1]);
    const ps = ctx.services.player.state;
    return { index: -1, point: { position, yaw: 0 }, flank: false, bearing: bearingName(xz[0] - ps.position.x, xz[1] - ps.position.z), distance: 0 };
  }

  /** Weighted role pick from a wave mix. */
  function pickRole(mix) {
    let sum = 0;
    for (const k in mix) sum += mix[k];
    let r = rng.next() * sum;
    for (const k in mix) {
      r -= mix[k];
      if (r <= 0) return ROLES[k] || ROLES.rifle;
    }
    return ROLES.rifle;
  }

  const RING = [[0, 0], [1.7, 0.4], [-1.5, 0.9], [0.5, -1.8], [-0.9, -1.6], [2.2, -1.2]];

  /**
   * Spawn a squad at a picked point. Returns the list of {agent, role} actually spawned (may be empty).
   * @param {{pick, size:number, spec, objective:THREE.Vector3, wave:number, onAgent:(agent, meta)=>void}} o
   */
  function spawnSquad({ pick: pk, size, spec, objective, wave, onAgent }) {
    const ai = ctx.services.ai;
    const world = ctx.services.world;
    const base = pk.point.position;
    const squad = ++squadSeq;
    const role0 = pk.flank ? 'flank' : 'assault';
    let spawned = 0;
    let failures = 0;
    for (let m = 0; m < size; m++) {
      const off = RING[m % RING.length];
      const ring = m >= RING.length ? 1.6 : 1;
      _p.set(base.x + off[0] * ring, base.y, base.z + off[1] * ring);
      // Keep members on the same side of any wall as the squad anchor.
      if (m > 0) {
        _dir.set(_p.x - base.x, 0, _p.z - base.z);
        const len = _dir.length();
        if (len > 1e-3) {
          _dir.multiplyScalar(1 / len);
          _toSpawn.set(base.x, base.y + 1.0, base.z);
          const hit = world.raycast(_toSpawn, _dir, len + 0.5);
          if (hit) _p.set(base.x + (rng.next() - 0.5) * 0.6, base.y, base.z + (rng.next() - 0.5) * 0.6);
        }
      }
      const gy = world.groundHeight(_p.x, _p.z, base.y + 3);
      if (Number.isFinite(gy) && Math.abs(gy - base.y) < 2.5) _p.y = gy;
      else _p.y = base.y;
      // face the objective
      const dx = objective.x - _p.x;
      const dz = objective.z - _p.z;
      const yaw = Math.atan2(-dx, -dz);
      const r = pickRole(spec.mix);
      const behavior = {
        role: m === 0 && pk.flank ? 'flank' : (r.loadout === 'shotgun' ? 'rush' : role0),
        aggression: spec.aggression,
        accuracy: spec.accuracy,
        damageScale: spec.damage,
        objective: objective.clone(),
        target: 'player',
        squad,
        wave,
        flank: pk.flank,
      };
      let agent = null;
      try {
        agent = ai.spawn({ position: _p, yaw, loadout: r.loadout, behavior, team: 'enemy' });
      } catch (e) {
        ctx.reportError('gamemode', 'ai.spawn', e);
      }
      if (agent) {
        spawned++;
        onAgent(agent, { role: r, squad, flank: pk.flank, spawnIndex: pk.index });
      } else failures++;
    }
    return { spawned, failures, squad };
  }

  function reset() {
    lastUsed.clear();
    squadSeq = 0;
  }

  /** Player respawn: the player spawn point farthest from living hostiles. */
  function pickPlayerSpawn(agents) {
    const list = ctx.services.world.spawnPoints?.player;
    if (!list || !list.length) return null;
    let best = list[0];
    let bestScore = -Infinity;
    for (const sp of list) {
      let minD = 1e9;
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        if (!a || !a.alive || !a.position) continue;
        const d = Math.hypot(a.position.x - sp.position.x, a.position.z - sp.position.z);
        if (d < minD) minD = d;
      }
      const s = Math.min(minD, 60) + rng.next();
      if (s > bestScore) { bestScore = s; best = sp; }
    }
    return best;
  }

  return { pick, pinned, pickRole, spawnSquad, reset, pickPlayerSpawn };
}

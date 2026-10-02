import * as THREE from 'three';
import {
  SURFACE_BALLISTICS, ballisticSurface, ZONE_MULT, zoneBucket, normalizeZone, PENETRATION_POWER,
  resolveProfile, falloffAt,
} from './tables.js';

/**
 * Hitscan ballistics: world raycast (services.world) + damageable hitboxes + analytic player capsule,
 * material penetration with thickness measurement, per-weapon damage falloff, zone multipliers.
 *
 * Penetration model
 *   Every round carries a penetration "power" (cm of softwood it can pass, from the weapon profile or
 *   the `penetration` option). On a world hit the surface's ballistic class decides:
 *     - impenetrable (concrete, brick, asphalt, tile, dirt, sand, ...) -> the round stops;
 *     - grazing hits under the surface's deflect angle -> ricochet, the round stops;
 *     - otherwise the exit face is found by casting back from entry + dir * maxThickness (maxThickness =
 *       remaining power / costPerCm). No exit inside that length -> too thick, stops. Else the round
 *       loses thickness * costPerCm power and keeps `keep * (1 - 0.45 * cost / powerBefore)` damage.
 *   Bodies cost a fixed amount of power (FLESH_COST) and keep 70% damage.
 */
const FLESH_COST = 8;
const FLESH_KEEP = 0.7;
const MAX_LAYERS = 8;
const EPS = 0.004;
const RESULT_POOL = 24;

export function createBallistics(ctx, reg, profiles, hooks) {
  const rng = ctx.rng.fork('combat:ballistics');
  const raycaster = new THREE.Raycaster();
  raycaster.layers.enableAll();
  const bodyHits = [];
  const hitSet = new Set();

  // temps
  const _dir = new THREE.Vector3();
  const _o = new THREE.Vector3();
  const _p = new THREE.Vector3();
  const _far = new THREE.Vector3();
  const _neg = new THREE.Vector3();
  const _u = new THREE.Vector3();
  const _w = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  const _tracerFrom = new THREE.Vector3();
  const _tracerTo = new THREE.Vector3();
  const _shooterPos = new THREE.Vector3();
  const _closest = new THREE.Vector3();
  const _worldSize = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const _zt = new THREE.Vector3();
  const _camDir = new THREE.Vector3();
  const _rico = new THREE.Vector3();
  const _ricoTo = new THREE.Vector3();
  const sparkParams = { point: new THREE.Vector3(), normal: new THREE.Vector3(), count: 8 };
  const ricoTracer = { from: new THREE.Vector3(), to: new THREE.Vector3(), weaponId: null, source: null, force: true };

  // pooled vfx param objects (vfx copies what it keeps)
  const impactParams = { point: new THREE.Vector3(), normal: new THREE.Vector3(), surface: 'default', exit: false, direction: new THREE.Vector3(), weaponId: null };
  const decalParams = { point: new THREE.Vector3(), normal: new THREE.Vector3(), surface: 'default', object: null, kind: 'bullet', size: undefined, exit: false, direction: new THREE.Vector3() };
  const bloodParams = { point: new THREE.Vector3(), normal: new THREE.Vector3(), direction: new THREE.Vector3(), zone: 'torso', exit: false, killed: false };
  const tracerParams = { from: _tracerFrom, to: _tracerTo, weaponId: null, source: null, speed: undefined };
  // pooled event payloads (consumers copy)
  const hitEvt = {
    point: new THREE.Vector3(), normal: new THREE.Vector3(), surface: 'default', distance: 0, target: null, zone: null, damage: 0,
    source: null, weaponId: null, headshot: false, killed: false, penetrated: 0, exit: false, kind: 'bullet',
    direction: new THREE.Vector3(), origin: new THREE.Vector3(), object: null, isPlayer: false,
  };
  const penEvt = { point: new THREE.Vector3(), entry: new THREE.Vector3(), normal: new THREE.Vector3(), surface: 'default', thickness: 0, source: null, weaponId: null, powerLeft: 0 };
  const ricochetEvt = { point: new THREE.Vector3(), normal: new THREE.Vector3(), direction: new THREE.Vector3(), surface: 'default', source: null, weaponId: null };
  const nearMissEvt = { position: new THREE.Vector3(), distance: 0, source: null, weaponId: null, direction: new THREE.Vector3() };
  const shotEvt = { origin: new THREE.Vector3(), direction: new THREE.Vector3(), end: new THREE.Vector3(), source: null, weaponId: null, hits: 0, penetrations: 0 };

  // result ring buffer (valid until RESULT_POOL further shots)
  const results = [];
  for (let i = 0; i < RESULT_POOL; i++) results.push(makeResult());
  let resultIdx = 0;
  function makeResult() {
    return {
      point: new THREE.Vector3(), normal: new THREE.Vector3(), surface: 'default', distance: 0, target: null, zone: null, damage: 0,
      headshot: false, killed: false, penetrations: 0, end: new THREE.Vector3(), direction: new THREE.Vector3(),
      hits: [], _hitPool: [],
    };
  }
  function hitRecord(res) {
    let h = res._hitPool[res.hits.length];
    if (!h) {
      h = { point: new THREE.Vector3(), normal: new THREE.Vector3(), surface: 'default', distance: 0, target: null, zone: null, damage: 0, kind: 'world', thickness: 0, exitPoint: new THREE.Vector3(), penetrated: false, headshot: false, killed: false, isPlayer: false, object: null, layer: 0 };
      res._hitPool.push(h);
    }
    h.target = null; h.zone = null; h.damage = 0; h.thickness = 0; h.penetrated = false; h.headshot = false; h.killed = false; h.isPlayer = false; h.object = null;
    res.hits.push(h);
    return h;
  }

  const tracerCount = new Map();
  const thinCache = new WeakMap();

  // ------------------------------------------------------------------------------ helpers
  function shooterInfo(source, team) {
    const out = shooterInfoOut;
    out.team = team ?? null;
    out.damageable = null;
    out.object = null;
    out.name = null;
    if (source === 'player') {
      out.team = out.team ?? 'player';
      out.name = ctx.settings.get('combat.playerName', 'You');
      for (const d of reg.damageables) if (d.isPlayer) { out.damageable = d; break; }
      return out;
    }
    if (typeof source === 'string' && source.startsWith('ai:')) {
      const agents = ctx.services.ai.agents || [];
      const id = source.slice(3);
      for (let i = 0; i < agents.length; i++) {
        const ag = agents[i];
        if (String(ag.id) === id) {
          out.object = ag.object || null;
          out.team = out.team ?? ag.team ?? 'enemy';
          out.name = ag.name || ag.callsign || null;
          break;
        }
      }
      out.damageable = reg.findByKey(source) || (out.object ? reg.findByObject(out.object) : null);
      if (!out.team) out.team = out.damageable?.team ?? 'enemy';
      return out;
    }
    const d = reg.findByKey(source);
    if (d) { out.damageable = d; out.team = out.team ?? d.team; out.name = d.name; }
    return out;
  }
  const shooterInfoOut = { team: null, damageable: null, object: null, name: null };

  function friendlyBlocked(shooterTeam, targetTeam) {
    if (ctx.settings.get('combat.friendlyFire', false)) return false;
    return !!shooterTeam && shooterTeam === targetTeam;
  }

  /**
   * `spreadDeg` = cone HALF-angle, i.e. the maximum deviation in degrees (the convention the AI loadouts
   * are tuned against; centre-weighted distribution).
   */
  function applySpread(dir, spreadDeg) {
    if (!(spreadDeg > 0)) return dir;
    const half = (spreadDeg * Math.PI) / 180;
    // uniform on the disc (tan-space), slightly centre weighted like most shooters
    const r = Math.tan(half) * Math.pow(rng.next(), 0.62);
    const a = rng.next() * Math.PI * 2;
    _u.copy(Math.abs(dir.y) > 0.99 ? _a.set(1, 0, 0) : _up).cross(dir).normalize();
    _w.crossVectors(dir, _u);
    dir.addScaledVector(_u, Math.cos(a) * r).addScaledVector(_w, Math.sin(a) * r).normalize();
    return dir;
  }

  function isThin(object) {
    if (!object || !object.geometry) return false;
    let v = thinCache.get(object);
    if (v !== undefined) return v;
    const g = object.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    g.boundingBox.getSize(_worldSize);
    object.updateWorldMatrix(true, false);
    const s = object.matrixWorld.getMaxScaleOnAxis();
    v = Math.min(_worldSize.x, _worldSize.y, _worldSize.z) * s < 0.02;
    thinCache.set(object, v);
    return v;
  }

  /** Find where a round exits the slab it entered at `entry`. Returns thickness (m) or -1. */
  function measureExit(entry, dir, maxLen, entryObject, outPoint, outNormal) {
    const world = ctx.services.world;
    const L = Math.max(0.01, maxLen);
    _far.copy(entry).addScaledVector(dir, L);
    _neg.copy(dir).negate();
    const hits = world.raycastAll(_far, _neg, L - 0.0015) || [];
    // farthest reverse hit = the back face closest to the entry point
    let best = null;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (h.distance > L - 0.0015) continue;
      if (!best || h.distance > best.distance) best = h;
    }
    if (best) {
      outPoint.copy(best.point);
      outNormal.copy(best.normal);
      if (outNormal.dot(dir) < 0) outNormal.negate();
      return Math.max(0.001, L - best.distance);
    }
    // zero-thickness geometry (planes / single-sided panes): treat as ~6 mm sheet
    if (isThin(entryObject)) {
      outPoint.copy(entry).addScaledVector(dir, 0.006);
      outNormal.copy(dir);
      return 0.006;
    }
    return -1;
  }

  // ray vs capsule (iq). returns t or -1
  function rayCapsule(ro, rd, pa, pb, r) {
    const bax = pb.x - pa.x, bay = pb.y - pa.y, baz = pb.z - pa.z;
    const oax = ro.x - pa.x, oay = ro.y - pa.y, oaz = ro.z - pa.z;
    const baba = bax * bax + bay * bay + baz * baz;
    const bard = bax * rd.x + bay * rd.y + baz * rd.z;
    const baoa = bax * oax + bay * oay + baz * oaz;
    const rdoa = rd.x * oax + rd.y * oay + rd.z * oaz;
    const oaoa = oax * oax + oay * oay + oaz * oaz;
    const a = baba - bard * bard;
    let b = baba * rdoa - baoa * bard;
    let c = baba * oaoa - baoa * baoa - r * r * baba;
    let h = b * b - a * c;
    if (h >= 0 && Math.abs(a) > 1e-9) {
      const t = (-b - Math.sqrt(h)) / a;
      const y = baoa + t * bard;
      if (y > 0 && y < baba) return t;
      // caps
      let ocx, ocy, ocz;
      if (y <= 0) { ocx = oax; ocy = oay; ocz = oaz; } else { ocx = ro.x - pb.x; ocy = ro.y - pb.y; ocz = ro.z - pb.z; }
      b = rd.x * ocx + rd.y * ocy + rd.z * ocz;
      c = ocx * ocx + ocy * ocy + ocz * ocz - r * r;
      h = b * b - c;
      if (h > 0) return -b - Math.sqrt(h);
    } else {
      // parallel to axis (or miss) -> sphere tests on both caps
      let best = -1;
      for (let k = 0; k < 2; k++) {
        const p = k === 0 ? pa : pb;
        const ocx = ro.x - p.x, ocy = ro.y - p.y, ocz = ro.z - p.z;
        b = rd.x * ocx + rd.y * ocy + rd.z * ocz;
        c = ocx * ocx + ocy * ocy + ocz * ocz - r * r;
        h = b * b - c;
        if (h > 0) { const t = -b - Math.sqrt(h); if (t > 0 && (best < 0 || t < best)) best = t; }
      }
      return best;
    }
    return -1;
  }

  /** Analytic player hitbox (used when the player system has not registered its own damageable). */
  function playerCapsule(outA, outB) {
    const ps = ctx.services.player.state;
    const h = ps.stance === 'prone' ? 0.55 : ps.stance === 'crouch' ? 1.2 : 1.8;
    const r = ps.stance === 'prone' ? 0.3 : 0.27;
    if (ps.stance === 'prone') {
      // lying along the view direction
      _n.set(ps.forward.x, 0, ps.forward.z);
      if (_n.lengthSq() < 1e-6) _n.set(0, 0, -1);
      _n.normalize();
      outA.copy(ps.position).addScaledVector(_n, -0.75).setY(ps.position.y + r);
      outB.copy(ps.position).addScaledVector(_n, 0.65).setY(ps.position.y + r);
    } else {
      outA.copy(ps.position).setY(ps.position.y + r);
      outB.copy(ps.position).setY(ps.position.y + h - r);
    }
    return r;
  }

  function playerZone(point) {
    const ps = ctx.services.player.state;
    if (ps.stance === 'prone') {
      _n.set(ps.forward.x, 0, ps.forward.z).normalize();
      const along = _zt.copy(point).sub(ps.position).dot(_n);
      return along > 0.38 ? 'head' : along > -0.2 ? 'torso' : 'limb';
    }
    const eyeY = ps.eye?.y ?? ps.position.y + 1.64;
    const y = point.y;
    if (y > eyeY - 0.13) return 'head';
    const h = ps.stance === 'crouch' ? 1.2 : 1.8;
    if (y > ps.position.y + h * 0.48) return 'torso';
    return 'limb';
  }

  function hasPlayerDamageable() {
    for (let i = 0; i < reg.damageables.length; i++) if (reg.damageables[i].isPlayer) return true;
    return false;
  }

  function zoneMultiplier(zone, profile) {
    if (zone === 'head') return profile.head ?? ZONE_MULT.head;
    return ZONE_MULT[zone] ?? 1;
  }

  // ------------------------------------------------------------------------------ fire
  /**
   * fireHitscan({ origin, direction, range?, damage, source, weaponId, spread?, penetration?,
   *               muzzle?: Vector3, tracer?: bool, team?, pellets?, falloff?, headMultiplier?, impactFx? })
   * -> result | null   (pooled: valid until ~24 further shots; copy what you keep)
   *   result = { point, normal, surface, distance, target, zone, damage, headshot, killed, penetrations,
   *              end, direction, hits: [{point, normal, surface, distance, target, zone, damage, kind:'world'|'body'|'player',
   *                                     thickness, exitPoint, penetrated, headshot, killed, layer}] }
   */
  function fireHitscan(opts = {}) {
    if (!opts.origin || !opts.direction) return null;
    const pellets = Math.max(1, opts.pellets | 0);
    if (pellets > 1) {
      let first = null;
      let anyTarget = false, anyKill = false, anyHead = false;
      for (let i = 0; i < pellets; i++) {
        const r = fireOne(opts, i, true);
        if (r && !first) first = r;
        if (r?.target) { anyTarget = true; if (r.killed) anyKill = true; if (r.headshot) anyHead = true; if (!first.target) first = r; }
      }
      if (anyTarget && opts.source === 'player') hooks.hitmarker(anyKill ? 'kill' : anyHead ? 'headshot' : 'hit');
      return first;
    }
    return fireOne(opts, 0, false);
  }

  function fireOne(opts, pelletIndex, suppressMarker) {
    const world = ctx.services.world;
    const source = opts.source ?? 'unknown';
    const weaponId = opts.weaponId ?? null;
    const profile = resolveProfile(profiles, weaponId);
    const maxRange = opts.range ?? profile.range ?? 500;
    const baseDamage = opts.damage ?? 25;
    let power = typeof opts.penetration === 'number' ? opts.penetration
      : opts.penetration === false ? 0
        : typeof opts.penetration === 'string' ? (PENETRATION_POWER[opts.penetration] ?? profile.power)
          : profile.power;
    const falloff = opts.falloff ?? profile.falloff;
    const headMult = opts.headMultiplier ?? profile.head;
    const prof = headMult === profile.head ? profile : { ...profile, head: headMult };
    const fx = opts.impactFx !== false;

    const shooter = shooterInfo(source, opts.team);
    const shooterTeam = shooter.team;
    const shooterDamageable = shooter.damageable;
    const shooterName = shooter.name;
    const shooterObject = shooter.object;

    _dir.copy(opts.direction).normalize();
    applySpread(_dir, effectiveSpread(opts, source, pelletIndex));
    _o.copy(opts.origin);

    const res = results[resultIdx];
    resultIdx = (resultIdx + 1) % RESULT_POOL;
    res.hits.length = 0;
    res.target = null; res.zone = null; res.damage = 0; res.headshot = false; res.killed = false; res.penetrations = 0;
    res.surface = 'default'; res.distance = 0;
    res.direction.copy(_dir);

    hitSet.clear();
    let traveled = 0;
    let dmgScale = 1;
    let first = null;
    let ended = false;
    let playerChecked = false;
    const playerTeam = ctx.services.gamemode.state?.playerTeam || 'player';
    const checkPlayer = source !== 'player' && ctx.services.player.state.alive !== false && !hasPlayerDamageable()
      && !friendlyBlocked(shooterTeam, playerTeam);
    const segStart = _p.copy(_o);
    for (let layer = 0; layer < MAX_LAYERS && !ended; layer++) {
      const remaining = maxRange - traveled;
      if (remaining <= 0.01) break;
      const wh = world.raycast(segStart, _dir, remaining);
      const segFar = wh ? wh.distance : remaining;

      // ---------- damageable hitboxes
      let body = null;
      let bodyDist = Infinity;
      if (reg.hitboxes.length) {
        raycaster.set(segStart, _dir);
        raycaster.near = 0;
        raycaster.far = segFar;
        bodyHits.length = 0;
        raycaster.intersectObjects(reg.hitboxes, false, bodyHits);
        for (let i = 0; i < bodyHits.length; i++) {
          const bh = bodyHits[i];
          const d = bh.object.userData.damageable;
          if (!d || !d.alive || hitSet.has(d)) continue;
          if (d === shooterDamageable) continue;
          if (shooterObject && isDescendant(bh.object, shooterObject)) continue;
          if (friendlyBlocked(shooterTeam, d.team)) continue;
          body = bh;
          bodyDist = bh.distance;
          break;
        }
      }
      // ---------- analytic player capsule
      let playerT = Infinity;
      if (checkPlayer && !playerChecked) {
        const r = playerCapsule(_a, _b);
        const t = rayCapsule(segStart, _dir, _a, _b, r);
        if (t > 0 && t < segFar && t < bodyDist) playerT = t;
      }

      if (playerT < Infinity) {
        playerChecked = true;
        const dist = traveled + playerT;
        const point = _closest.copy(segStart).addScaledVector(_dir, playerT);
        const zone = playerZone(point);
        const dmg = baseDamage * falloffAt(falloff, dist) * zoneMultiplier(zone, prof) * dmgScale * aiDamageScale(source);
        const h = hitRecord(res);
        h.kind = 'player'; h.isPlayer = true; h.layer = layer;
        h.point.copy(point); h.normal.copy(_dir).negate(); h.surface = 'flesh'; h.distance = dist; h.zone = zone; h.damage = dmg; h.headshot = zone === 'head';
        const info = {
          source, weaponId, zone, kind: 'bullet', headshot: zone === 'head', distance: dist,
          point: point.clone(), direction: _dir.clone(), position: _o.clone(), sourcePosition: _o.clone(), attacker: shooterName,
        };
        const wasAlive = ctx.services.player.state.alive !== false;
        ctx.services.player.damage(dmg, info);
        hooks.playerDamaged(dmg, info, wasAlive);
        emitHit(h, source, weaponId, layer > 0);
        if (!first) first = h;
        // rounds do not over-penetrate the player (keeps AI fire readable)
        segStart.copy(point);
        traveled = dist;
        ended = true;
        break;
      }

      if (body) {
        const d = body.object.userData.damageable;
        hitSet.add(d);
        const dist = traveled + bodyDist;
        const zone = normalizeZone(body.object.userData.zone);
        const mult = zoneMultiplier(zone, prof);
        const dmg = baseDamage * falloffAt(falloff, dist) * mult * dmgScale * (d.isPlayer ? aiDamageScale(source) : 1);
        const h = hitRecord(res);
        h.kind = 'body'; h.layer = layer;
        h.point.copy(body.point);
        if (body.face) h.normal.copy(body.face.normal).transformDirection(body.object.matrixWorld);
        else h.normal.copy(_dir).negate();
        if (h.normal.dot(_dir) > 0) h.normal.negate();
        h.surface = d.surface || 'flesh'; h.distance = dist; h.target = d; h.zone = zone; h.object = body.object;
        h.headshot = zone === 'head';
        const info = {
          source, weaponId, zone, bucket: zoneBucket(zone), kind: 'bullet', headshot: h.headshot, distance: dist,
          point: h.point.clone(), normal: h.normal.clone(), direction: _dir.clone(), sourcePosition: _o.clone(),
          impulse: _dir.clone().multiplyScalar(h.headshot ? 3.2 : 2.2), penetrated: layer > 0 ? res.penetrations : 0,
          object: body.object, attacker: shooterName,
        };
        h.damage = reg.applyDamage(d, dmg, info) || dmg;
        h.killed = !d.alive;
        emitHit(h, source, weaponId, layer > 0);
        if (fx) bodyFx(h, _dir, d);
        if (!first) first = h;
        // continue through the body
        traveled = dist;
        segStart.copy(body.point).addScaledVector(_dir, EPS);
        if (power <= FLESH_COST * 0.5) { ended = true; break; }
        power -= FLESH_COST;
        dmgScale *= FLESH_KEEP;
        continue;
      }

      if (!wh) { traveled = maxRange; break; }

      // ---------- world surface
      const dist = traveled + wh.distance;
      const bclass = ballisticSurface(wh.surface, wh.material);
      const spec = SURFACE_BALLISTICS[bclass];
      const h = hitRecord(res);
      h.kind = 'world'; h.layer = layer;
      h.point.copy(wh.point); h.normal.copy(wh.normal);
      if (h.normal.dot(_dir) > 0) h.normal.negate();
      h.surface = wh.surface || 'default'; h.distance = dist; h.object = wh.object || null;
      h.damage = 0;
      if (!first) first = h;
      if (fx) worldFx(h, wh, _dir, false, 1, weaponId);
      emitHit(h, source, weaponId, layer > 0);
      traveled = dist;

      // grazing -> ricochet
      const cosIn = -h.normal.dot(_dir); // 1 = head-on
      const grazeDeg = (Math.asin(Math.min(1, Math.max(0, cosIn))) * 180) / Math.PI;
      if (!spec.pen || power <= 0.5) { ended = true; break; }
      if (grazeDeg < spec.deflect) {
        ricochetEvt.point.copy(h.point); ricochetEvt.normal.copy(h.normal); ricochetEvt.direction.copy(_dir);
        ricochetEvt.surface = h.surface; ricochetEvt.source = source; ricochetEvt.weaponId = weaponId;
        ctx.events.emit('combat:ricochet', ricochetEvt);
        if (fx) ricochetFx(h, bclass, source, weaponId);
        ended = true;
        break;
      }
      // obliquity: effective path grows with 1/cos
      const maxThick = Math.min(1.5, power / spec.costPerCm / 100);
      const thick = measureExit(wh.point, _dir, maxThick, wh.object, h.exitPoint, _n);
      if (thick < 0) { ended = true; break; }
      const cost = thick * 100 * spec.costPerCm;
      if (cost > power) { ended = true; break; }
      const before = power;
      power -= cost;
      dmgScale *= spec.keep * (1 - 0.45 * (cost / Math.max(1e-3, before)));
      h.penetrated = true;
      h.thickness = thick;
      res.penetrations++;
      // exit fx
      if (fx) {
        _neg.copy(_n); // exit normal points along dir (out of the back face)
        exitFx(h, _neg, _dir, weaponId);
      }
      penEvt.point.copy(h.exitPoint); penEvt.entry.copy(h.point); penEvt.normal.copy(_n); penEvt.surface = h.surface;
      penEvt.thickness = thick; penEvt.source = source; penEvt.weaponId = weaponId; penEvt.powerLeft = power;
      ctx.events.emit('combat:penetration', penEvt);
      traveled = dist + thick;
      segStart.copy(h.exitPoint).addScaledVector(_dir, EPS);
      if (dmgScale < 0.05) { ended = true; break; }
    }

    // ---------- end point, tracer, near-miss
    if (res.hits.length) {
      const last = res.hits[res.hits.length - 1];
      res.end.copy(last.point);
    } else {
      res.end.copy(_o).addScaledVector(_dir, Math.min(maxRange, 1500));
    }
    if (ended === false && res.hits.length && res.hits[res.hits.length - 1].penetrated) {
      // passed everything: fly on to range end
      res.end.copy(_o).addScaledVector(_dir, Math.min(maxRange, traveled + 200));
    }

    // tracer
    let wantTracer = opts.tracer;
    if (wantTracer === undefined) {
      const every = profile.tracerEvery ?? 1;
      if (every <= 0) wantTracer = source !== 'player';
      else {
        const c = (tracerCount.get(source) || 0) + 1;
        tracerCount.set(source, c);
        wantTracer = source !== 'player' || c % every === 0;
      }
    }
    if (wantTracer && pelletIndex === 0) {
      if (opts.muzzle) _tracerFrom.copy(opts.muzzle);
      // player rounds start at the eye: vfx recognises them (< 0.5 m from the camera) and snaps the
      // tracer to the viewmodel muzzle; others start just ahead of the shooter
      else if (source === 'player') _tracerFrom.copy(_o);
      else _tracerFrom.copy(_o).addScaledVector(_dir, 0.6);
      _tracerTo.copy(res.end);
      tracerParams.weaponId = weaponId; tracerParams.source = source;
      ctx.services.vfx.spawn('tracer', tracerParams);
    }

    // near-miss (bullet passing close to the player's head)
    if (checkPlayer && !playerChecked) nearMiss(_o, res.end, source, weaponId);

    // ---------- summarize
    if (first) {
      res.point.copy(first.point); res.normal.copy(first.normal); res.surface = first.surface; res.distance = first.distance;
      let bestTarget = null;
      let dmgSum = 0;
      for (const h of res.hits) {
        if (h.target || h.isPlayer) {
          dmgSum += h.damage;
          if (!bestTarget) bestTarget = h;
          if (h.killed) res.killed = true;
          if (h.headshot) res.headshot = true;
        }
      }
      res.target = bestTarget ? bestTarget.target : null;
      res.zone = bestTarget ? bucketOrZone(bestTarget.zone) : null;
      res.damage = dmgSum;
    }

    shotEvt.origin.copy(_o); shotEvt.direction.copy(_dir); shotEvt.end.copy(res.end); shotEvt.source = source; shotEvt.weaponId = weaponId;
    shotEvt.hits = res.hits.length; shotEvt.penetrations = res.penetrations;
    ctx.events.emit('combat:shot', shotEvt);

    if (!suppressMarker && source === 'player' && res.target) hooks.hitmarker(res.killed ? 'kill' : res.headshot ? 'headshot' : 'hit');
    return first ? res : null;
  }

  function bucketOrZone(z) { return z; }

  /**
   * Spread is applied here unless the caller already did it. `spreadApplied: true|false` is explicit;
   * otherwise a player round whose direction already deviates from the camera boresight is taken as
   * pre-spread (the weapons system rolls its own cone and still reports `spread` for bookkeeping),
   * which avoids doubling the cone. Pellets (index > 0) always get their own spread.
   */
  function effectiveSpread(opts, source, pelletIndex) {
    const s = opts.spread ?? 0;
    if (!(s > 0)) return 0;
    if (opts.spreadApplied === true) return 0;
    if (opts.spreadApplied === false || pelletIndex > 0 || source !== 'player') return s;
    ctx.camera.getWorldDirection(_camDir);
    return _camDir.dot(_dir) < 1 - 2e-9 ? 0 : s;
  }

  function aiDamageScale(source) {
    if (source === 'player') return 1;
    const diff = ctx.settings.get('gameplay.difficulty', 'regular');
    return diff === 'recruit' ? 0.5 : diff === 'hardened' ? 1.25 : diff === 'veteran' ? 1.6 : 1;
  }

  function isDescendant(obj, root) {
    let o = obj;
    while (o) { if (o === root) return true; o = o.parent; }
    return false;
  }

  function emitHit(h, source, weaponId, penetrated) {
    const e = hitEvt;
    e.point.copy(h.point); e.normal.copy(h.normal); e.surface = h.surface; e.distance = h.distance;
    e.target = h.target; e.zone = h.zone; e.damage = h.damage; e.source = source; e.weaponId = weaponId;
    e.headshot = h.headshot; e.killed = h.killed; e.penetrated = penetrated ? 1 : 0; e.exit = false; e.kind = h.kind === 'world' ? 'bullet' : 'bullet';
    e.direction.copy(_dir); e.origin.copy(_o); e.object = h.object; e.isPlayer = h.isPlayer;
    ctx.events.emit('combat:hit', e);
  }

  /** Deflected round: sparks on hard surfaces and (sometimes) a short skipping tracer. */
  function ricochetFx(h, bclass, source, weaponId) {
    const hard = bclass === 'metal' || bclass === 'concrete' || bclass === 'brick' || bclass === 'tile' || bclass === 'asphalt';
    if (!hard) return;
    // reflect, lose some of the normal component, scatter a little
    _rico.copy(_dir).addScaledVector(h.normal, -2 * _dir.dot(h.normal));
    _rico.addScaledVector(h.normal, -0.6 * _rico.dot(h.normal));
    _rico.x += (rng.next() - 0.5) * 0.18; _rico.y += (rng.next() - 0.5) * 0.12 + 0.03; _rico.z += (rng.next() - 0.5) * 0.18;
    _rico.normalize();
    if (bclass === 'metal' || rng.next() < 0.5) {
      sparkParams.point.copy(h.point); sparkParams.normal.copy(_rico); sparkParams.count = bclass === 'metal' ? 10 : 5;
      ctx.services.vfx.spawn('sparks', sparkParams);
    }
    if (rng.next() < 0.4) {
      const len = 6 + rng.next() * 18;
      const wh = ctx.services.world.raycast(_ricoTo.copy(h.point).addScaledVector(h.normal, 0.01), _rico, len);
      ricoTracer.from.copy(h.point).addScaledVector(h.normal, 0.01);
      ricoTracer.to.copy(ricoTracer.from).addScaledVector(_rico, wh ? wh.distance : len);
      ricoTracer.weaponId = weaponId; ricoTracer.source = source;
      ctx.services.vfx.spawn('tracer', ricoTracer);
    }
  }

  function worldFx(h, wh, dir, exit, sizeMul, weaponId) {
    const vfx = ctx.services.vfx;
    impactParams.point.copy(h.point); impactParams.normal.copy(h.normal); impactParams.surface = h.surface;
    impactParams.exit = exit; impactParams.direction.copy(dir); impactParams.weaponId = weaponId;
    vfx.spawn('impact', impactParams);
    decalParams.point.copy(h.point); decalParams.normal.copy(h.normal); decalParams.surface = h.surface;
    decalParams.object = wh?.object ?? h.object ?? null; decalParams.kind = 'bullet'; decalParams.size = sizeMul !== 1 ? 0.1 * sizeMul : undefined;
    decalParams.exit = exit; decalParams.direction.copy(dir);
    vfx.decal(decalParams);
  }

  function exitFx(h, exitNormal, dir, weaponId) {
    const vfx = ctx.services.vfx;
    impactParams.point.copy(h.exitPoint); impactParams.normal.copy(exitNormal); impactParams.surface = h.surface;
    impactParams.exit = true; impactParams.direction.copy(dir); impactParams.weaponId = weaponId;
    vfx.spawn('impact', impactParams);
    decalParams.point.copy(h.exitPoint); decalParams.normal.copy(exitNormal); decalParams.surface = h.surface;
    decalParams.object = h.object; decalParams.kind = 'bullet'; decalParams.size = 0.14; decalParams.exit = true; decalParams.direction.copy(dir);
    vfx.decal(decalParams);
  }

  function bodyFx(h, dir, d) {
    const vfx = ctx.services.vfx;
    if (h.surface !== 'flesh') {
      // non-organic damageable (range target, vehicle, barrel): material impact + hole on the hitbox
      worldFx(h, null, dir, false, 1, null);
      return;
    }
    bloodParams.point.copy(h.point); bloodParams.normal.copy(h.normal); bloodParams.direction.copy(dir);
    bloodParams.zone = h.zone; bloodParams.exit = false; bloodParams.killed = h.killed;
    vfx.spawn('blood', bloodParams);
    // back-spatter onto a nearby wall behind the target
    const wh = ctx.services.world.raycast(h.point, dir, 2.6);
    if (wh) {
      decalParams.point.copy(wh.point); decalParams.normal.copy(wh.normal); decalParams.surface = wh.surface || 'default';
      decalParams.object = wh.object || null; decalParams.kind = 'blood';
      decalParams.size = (h.headshot ? 0.75 : 0.5) * (1 - wh.distance / 3.2);
      decalParams.exit = false; decalParams.direction.copy(dir);
      vfx.decal(decalParams);
    }
  }

  function nearMiss(from, to, source, weaponId) {
    const ps = ctx.services.player.state;
    const eye = ps.eye;
    if (!eye) return;
    // closest point on segment to the eye
    _a.copy(to).sub(from);
    const len2 = _a.lengthSq();
    if (len2 < 1e-6) return;
    const t = Math.max(0, Math.min(1, _b.copy(eye).sub(from).dot(_a) / len2));
    _closest.copy(from).addScaledVector(_a, t);
    const dist = _closest.distanceTo(eye);
    if (dist > 1.6 || t >= 0.999) return;
    nearMissEvt.position.copy(_closest); nearMissEvt.distance = dist; nearMissEvt.source = source; nearMissEvt.weaponId = weaponId;
    nearMissEvt.direction.copy(_a).normalize();
    ctx.events.emit('combat:near-miss', nearMissEvt);
    hooks.nearMiss(dist);
  }

  // shooter position helper (exposed for tests / AI)
  function shooterPosition(source, out = _shooterPos) {
    const s = shooterInfo(source);
    if (s.object) return s.object.getWorldPosition(out);
    if (source === 'player') return out.copy(ctx.services.player.state.eye);
    return null;
  }

  return { fireHitscan, measureExit, rayCapsule, shooterPosition, isThin };
}

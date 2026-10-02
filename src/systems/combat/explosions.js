import * as THREE from 'three';
import { EXPLOSIVES, SURFACE_BALLISTICS, ballisticSurface, blastFalloff } from './tables.js';

/**
 * Explosions: radius damage with occlusion checks (several sample points per target, thin penetrable
 * layers transmit part of the blast), eased distance falloff, physics impulses, camera shake /
 * concussion for the player, scorch decal, vfx + events.
 *
 * explode({ position, radius?, damage?, source?, weaponId?, type?: 'frag'|'barrel'|'rocket', innerRadius?,
 *           minFrac?, impulse?, normal?, ignore?: Damageable })
 *   -> { position, radius, results: [{ target, damage, exposure, distance }], player: { damage, exposure } }
 */
export function createExplosions(ctx, reg, hooks) {
  const _pos = new THREE.Vector3();
  const _box = new THREE.Box3();
  const _center = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _sample = new THREE.Vector3();
  const _tmp = new THREE.Vector3();
  const _down = new THREE.Vector3(0, -1, 0);
  const samples = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  const explosionEvt = {
    position: new THREE.Vector3(), radius: 0, damage: 0, source: null, weaponId: null, type: 'default',
    normal: new THREE.Vector3(0, 1, 0), impulse: 0, surface: 'default', grounded: true,
  };
  const impulseEvt = { position: new THREE.Vector3(), radius: 0, strength: 0, source: null };
  const vfxParams = { position: new THREE.Vector3(), radius: 0, normal: new THREE.Vector3(0, 1, 0), surface: 'default', type: 'default', grounded: true };
  const decalParams = { point: new THREE.Vector3(), normal: new THREE.Vector3(), surface: 'default', object: null, kind: 'scorch', size: 1 };
  const pitParams = { point: new THREE.Vector3(), normal: new THREE.Vector3(), surface: 'default', object: null, kind: 'bullet', size: 0.04, exit: false, direction: new THREE.Vector3() };
  const puffParams = { point: new THREE.Vector3(), normal: new THREE.Vector3(), surface: 'default', exit: false, direction: new THREE.Vector3(), weaponId: 'fragment' };
  const fragRng = ctx.rng.fork('combat:fragments');
  const _fd = new THREE.Vector3();
  const _fq = new THREE.Quaternion();
  const _fup = new THREE.Vector3(0, 1, 0);
  const _fc = new THREE.Vector3();
  // fragment fx are queued and flushed a few per frame (vfx decal/impact calls are the expensive part;
  // spreading ~35 of them over 2-3 frames removes a ~2 ms spike and is invisible)
  const FQ = 256;
  const FLUSH_PER_FRAME = 14;
  const fq = [];
  for (let i = 0; i < FQ; i++) fq.push({ point: new THREE.Vector3(), normal: new THREE.Vector3(), dir: new THREE.Vector3(), surface: 'default', object: null, size: 0.05, puff: false });
  let fqHead = 0, fqCount = 0;
  function queueFragment(h, dir, size, puff) {
    if (fqCount >= FQ) return;
    const e = fq[(fqHead + fqCount) % FQ];
    fqCount++;
    e.point.copy(h.point); e.normal.copy(h.normal); e.dir.copy(dir); e.surface = h.surface || 'default';
    e.object = h.object || null; e.size = size; e.puff = puff;
  }
  function flushFragments() {
    if (!fqCount) return;
    const vfx = ctx.services.vfx;
    const n = Math.min(FLUSH_PER_FRAME, fqCount);
    for (let i = 0; i < n; i++) {
      const e = fq[fqHead];
      fqHead = (fqHead + 1) % FQ; fqCount--;
      pitParams.point.copy(e.point); pitParams.normal.copy(e.normal); pitParams.surface = e.surface;
      pitParams.object = e.object; pitParams.direction.copy(e.dir); pitParams.size = e.size;
      vfx.decal(pitParams);
      if (e.puff) {
        puffParams.point.copy(e.point); puffParams.normal.copy(e.normal); puffParams.surface = e.surface;
        puffParams.direction.copy(e.dir);
        vfx.spawn('impact', puffParams);
      }
      e.object = null;
    }
  }
  function clearFragments() { fqHead = 0; fqCount = 0; }

  /**
   * Cosmetic fragmentation: `count` rays in a band around the blast (mostly near-horizontal relative
   * to the surface it went off on, like a real frag's fragment sheet) pepper nearby walls with small
   * pits and a few dust puffs. Deterministic (own rng fork). Damage stays in the radius model.
   */
  function fragmentSpray(center, normal, count, range) {
    if (!(count > 0)) return 0;
    const world = ctx.services.world;
    _fq.setFromUnitVectors(_fup, normal);
    const rot = fragRng.next() * Math.PI * 2;
    let hits = 0, puffs = 0;
    for (let i = 0; i < count; i++) {
      const y = 0.62 - (0.72 * (i + 0.5)) / count; // +0.62 .. -0.10
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const phi = i * 2.399963 + rot + (fragRng.next() - 0.5) * 0.3;
      _fd.set(Math.cos(phi) * r, y + (fragRng.next() - 0.5) * 0.06, Math.sin(phi) * r).normalize().applyQuaternion(_fq);
      const reach = range * (0.45 + 0.55 * fragRng.next());
      const h = world.raycast(_fc.copy(center), _fd, reach);
      if (!h || h.distance < 0.35) continue;
      hits++;
      if (h.normal.dot(_fd) > 0) h.normal.negate();
      const size = (0.06 + 0.075 * fragRng.next()) * (1.15 - 0.55 * (h.distance / range));
      let puff = false;
      if (puffs < 7 && h.distance < range * 0.7 && fragRng.next() < 0.45) { puffs++; puff = true; }
      queueFragment(h, _fd, size, puff);
    }
    return hits;
  }

  /** Fraction (0..1) of the blast reaching `to` from `from` (thin penetrable layers transmit part). */
  function transmission(from, to) {
    const world = ctx.services.world;
    _dir.copy(to).sub(from);
    const len = _dir.length();
    if (len < 1e-4) return 1;
    _dir.multiplyScalar(1 / len);
    const hits = world.raycastAll(from, _dir, len);
    if (!hits || hits.length === 0) return 1;
    let t = 1;
    let layers = 0;
    let lastObj = null;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (h.distance >= len - 0.02) break;
      if (h.object && h.object === lastObj) continue; // entry + exit of the same slab counts once
      lastObj = h.object;
      const b = SURFACE_BALLISTICS[ballisticSurface(h.surface, h.material)];
      t *= b ? b.blast : 0;
      if (t <= 0.02 || ++layers > 3) return 0;
    }
    return t;
  }

  function exposureOf(center, pts, count) {
    let sum = 0;
    let max = 0;
    for (let i = 0; i < count; i++) {
      const e = transmission(center, pts[i]);
      sum += e;
      if (e > max) max = e;
    }
    return 0.5 * max + 0.5 * (sum / count);
  }

  function explode(opts = {}) {
    if (!opts.position) return null;
    const def = EXPLOSIVES[opts.type] || EXPLOSIVES.default;
    const radius = opts.radius ?? def.radius;
    const damage = opts.damage ?? def.damage;
    const inner = opts.innerRadius ?? Math.min(def.innerRadius, radius * 0.4);
    const minFrac = opts.minFrac ?? def.minFrac;
    const impulse = opts.impulse ?? def.impulse;
    const source = opts.source ?? 'unknown';
    const weaponId = opts.weaponId ?? def.weaponId;
    const kindName = opts.type || 'default';
    _pos.copy(opts.position);

    // lift the blast centre slightly off whatever it is resting on, so rays don't start inside geometry
    const world = ctx.services.world;
    const ground = world.raycast(_tmp.copy(_pos).setY(_pos.y + 0.3), _down, 1.0);
    const grounded = !!ground && ground.distance < 0.75;
    const normal = opts.normal ? _center.copy(opts.normal) : grounded ? _center.copy(ground.normal) : _center.set(0, 1, 0);
    const blastCenter = _sample.copy(_pos).addScaledVector(normal, 0.12);
    const bc = new THREE.Vector3().copy(blastCenter); // stable copy (samples below reuse temps)

    const out = { position: _pos.clone(), radius, results: [], player: null };

    // ---------------------------------------------------------------- damageables
    for (let i = 0; i < reg.damageables.length; i++) {
      const d = reg.damageables[i];
      if (!d.alive || d === opts.ignore) continue;
      reg.boundsOf(d, _box);
      // distance to the closest point of the target bounds
      const dist = _box.distanceToPoint(bc);
      if (dist >= radius) continue;
      _box.getCenter(samples[0]);
      samples[1].set(samples[0].x, _box.max.y - 0.12, samples[0].z); // head
      samples[2].set(samples[0].x, _box.min.y + 0.25, samples[0].z); // legs
      _box.clampPoint(bc, samples[3]); // nearest point
      const exposure = exposureOf(bc, samples, 4);
      if (exposure <= 0.01) { out.results.push({ target: d, damage: 0, exposure, distance: dist }); continue; }
      const dmg = damage * blastFalloff(dist, radius, inner, minFrac) * exposure;
      const dirImp = new THREE.Vector3().copy(samples[0]).sub(bc);
      const dl = dirImp.length();
      if (dl > 1e-4) dirImp.multiplyScalar(1 / dl); else dirImp.set(0, 1, 0);
      dirImp.y += 0.55;
      dirImp.normalize().multiplyScalar(impulse * blastFalloff(dist, radius, inner, 0) * exposure);
      const info = {
        source, weaponId, zone: 'torso', kind: 'explosion', headshot: false, distance: dist, point: samples[3].clone(),
        direction: dirImp.clone().normalize(), impulse: dirImp, sourcePosition: bc.clone(), exposure, explosionType: kindName,
        attacker: hooks.nameOf(source),
      };
      const applied = reg.applyDamage(d, dmg, info);
      out.results.push({ target: d, damage: applied, exposure, distance: dist });
      hooks.explosionHit(d, applied, info);
    }

    // ---------------------------------------------------------------- player (analytic)
    const ps = ctx.services.player.state;
    let playerHasDamageable = false;
    for (let i = 0; i < reg.damageables.length; i++) if (reg.damageables[i].isPlayer) { playerHasDamageable = true; break; }
    if (!playerHasDamageable && ps && ps.position) {
      const h = ps.stance === 'prone' ? 0.5 : ps.stance === 'crouch' ? 1.2 : 1.8;
      _box.min.set(ps.position.x - 0.3, ps.position.y, ps.position.z - 0.3);
      _box.max.set(ps.position.x + 0.3, ps.position.y + h, ps.position.z + 0.3);
      const dist = _box.distanceToPoint(bc);
      const shakeRadius = def.shakeRadius ?? radius * 3;
      let exposure = 0;
      if (dist < Math.max(radius, shakeRadius)) {
        _box.getCenter(samples[0]);
        samples[1].copy(ps.eye || samples[0]);
        samples[2].set(samples[0].x, ps.position.y + 0.25, samples[0].z);
        _box.clampPoint(bc, samples[3]);
        exposure = exposureOf(bc, samples, 4);
      }
      if (dist < radius && ps.alive !== false) {
        const friendly = source === 'player' ? ctx.settings.get('combat.selfDamage', true) : true;
        if (friendly && exposure > 0.01) {
          const scale = source === 'player' ? 0.85 : 1; // self damage slightly reduced
          const dmg = damage * blastFalloff(dist, radius, inner, minFrac) * exposure * scale;
          const info = {
            source, weaponId, kind: 'explosion', zone: 'torso', distance: dist, position: bc.clone(), sourcePosition: bc.clone(),
            point: samples[3].clone(), exposure, type: 'explosion', explosionType: kindName, attacker: hooks.nameOf(source),
          };
          const wasAlive = ps.alive !== false;
          ctx.services.player.damage(dmg, info);
          out.player = { damage: dmg, exposure };
          hooks.playerDamaged(dmg, info, wasAlive);
        }
      }
      // feel: shake + concussion, scaled with distance and line of sight (a wall muffles, never cancels)
      if (dist < shakeRadius) {
        const k = 1 - dist / shakeRadius;
        const los = 0.35 + 0.65 * exposure;
        ctx.services.player.addShake(Math.min(1, k * k * 1.25 * los + 0.05), 0.35 + 0.85 * k);
        // (postfx reacts to combat:explosion itself; pulses are max-combined so nothing extra here)
      }
    }

    // ---------------------------------------------------------------- vfx / decal / events
    vfxParams.position.copy(_pos); vfxParams.radius = radius; vfxParams.normal.copy(normal); vfxParams.surface = ground?.surface || 'default';
    vfxParams.type = kindName; vfxParams.grounded = grounded;
    ctx.services.vfx.spawn('explosion', vfxParams);
    if (grounded) {
      decalParams.point.copy(ground.point); decalParams.normal.copy(ground.normal); decalParams.surface = ground.surface || 'default';
      decalParams.object = ground.object || null; decalParams.size = Math.max(1.2, radius * 0.42);
      ctx.services.vfx.decal(decalParams);
    }

    const fragCount = opts.fragments ?? def.fragments ?? 0;
    out.fragmentHits = fragmentSpray(bc, normal, fragCount, opts.fragRange ?? def.fragRange ?? radius * 1.2);

    explosionEvt.position.copy(_pos); explosionEvt.radius = radius; explosionEvt.damage = damage; explosionEvt.source = source;
    explosionEvt.weaponId = weaponId; explosionEvt.type = kindName; explosionEvt.normal.copy(normal); explosionEvt.impulse = impulse;
    explosionEvt.surface = ground?.surface || 'default'; explosionEvt.grounded = grounded;
    ctx.events.emit('combat:explosion', explosionEvt);
    impulseEvt.position.copy(bc); impulseEvt.radius = radius * 1.4; impulseEvt.strength = impulse; impulseEvt.source = source;
    ctx.events.emit('combat:impulse', impulseEvt);
    hooks.afterExplosion(out);
    return out;
  }

  return { explode, transmission, update: flushFragments, clear: clearFragments, get pendingFragments() { return fqCount; } };
}

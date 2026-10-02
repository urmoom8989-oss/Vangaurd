import * as THREE from 'three';
import { normalizeZone } from './tables.js';

/**
 * Damageable registry + damage application.
 *
 * registerDamageable({ object, health, maxHealth?, team?, name?, key?, armor?, onDamage?, onDeath?,
 *                      hitboxes? : Mesh[], invulnerable?, surface? ('flesh' default; e.g. 'metal' for a vehicle) })
 *   object      root Object3D. Hitboxes = meshes under it with userData.zone / userData.hitbox (if any
 *               exist), otherwise every non-skinned mesh under it (zone 'torso' unless userData.zone).
 *   key         optional stable id of the owner, e.g. 'ai:3' (lets fireHitscan skip the shooter's own
 *               hitboxes and resolve teams). If omitted and `object` belongs to an ai agent, it is found.
 *   armor       0..1 fraction of non-head bullet damage absorbed while armorHealth > 0 (optional)
 * -> Damageable { id, key, name, object, health, maxHealth, team, alive, armor, lastInfo, unregister() }
 */
export function createDamageRegistry(ctx, hooks) {
  const damageables = [];
  const hitboxes = []; // flat list of meshes (userData.damageable, userData.zone set)
  let nextId = 1;
  const _box = new THREE.Box3();
  const _tmpBox = new THREE.Box3();

  function collectHitboxes(d, explicit) {
    // remove old
    for (let j = hitboxes.length - 1; j >= 0; j--) if (hitboxes[j].userData.damageable === d) hitboxes.splice(j, 1);
    d.hitboxes.length = 0;
    let list = explicit;
    if (!list) {
      const zoned = [];
      const all = [];
      d.object.traverse((o) => {
        if (!o.isMesh) return;
        if (o.userData.zone || o.userData.hitbox) zoned.push(o);
        else if (!o.isSkinnedMesh) all.push(o);
      });
      list = zoned.length ? zoned : all;
    }
    for (const m of list) {
      m.userData.damageable = d;
      m.userData.zone = normalizeZone(m.userData.zone);
      d.hitboxes.push(m);
      hitboxes.push(m);
    }
  }

  function register(opts = {}) {
    if (!opts.object) throw new Error('registerDamageable: object is required');
    const health = opts.health ?? 100;
    const d = {
      id: nextId++,
      key: opts.key ?? null,
      name: opts.name ?? null,
      object: opts.object,
      health,
      maxHealth: opts.maxHealth ?? health,
      team: opts.team ?? 'enemy',
      alive: health > 0,
      armor: opts.armor ?? 0,
      armorHealth: opts.armorHealth ?? (opts.armor ? 100 : 0),
      invulnerable: !!opts.invulnerable,
      isPlayer: !!opts.isPlayer,
      surface: opts.surface || 'flesh', // what bullets report on hit ('flesh' = blood; e.g. 'cardboard' for range targets)
      onDamage: opts.onDamage,
      onDeath: opts.onDeath,
      hitboxes: [],
      lastInfo: null,
      lastHitTime: -1,
      damageTaken: 0,
      unregister: () => unregister(d),
      refreshHitboxes: (list) => collectHitboxes(d, list),
    };
    collectHitboxes(d, opts.hitboxes || null);
    damageables.push(d);
    return d;
  }

  function unregister(d) {
    if (!d) return;
    const i = damageables.indexOf(d);
    if (i >= 0) damageables.splice(i, 1);
    for (let j = hitboxes.length - 1; j >= 0; j--) {
      if (hitboxes[j].userData.damageable === d) {
        delete hitboxes[j].userData.damageable;
        hitboxes.splice(j, 1);
      }
    }
  }

  /**
   * Apply damage. info: { source, weaponId, zone, point, direction, normal, kind:'bullet'|'explosion'|'melee'|'fall'|'fire',
   *                       headshot, distance, impulse (Vector3), penetrated }
   * Returns the damage actually applied.
   */
  function applyDamage(d, amount, info = {}) {
    if (!d || !d.alive || !(amount > 0)) return 0;
    if (d.invulnerable) return 0;
    let dmg = amount;
    // Armor absorbs part of non-head bullet damage.
    if (d.armor > 0 && d.armorHealth > 0 && info.kind !== 'explosion' && info.zone !== 'head') {
      const absorbed = Math.min(d.armorHealth, dmg * d.armor);
      d.armorHealth -= absorbed;
      dmg -= absorbed;
    }
    const before = d.health;
    d.health = Math.max(0, d.health - dmg);
    const applied = before - d.health;
    d.damageTaken += applied;
    d.lastInfo = info;
    d.lastHitTime = ctx.time.t;
    info.health = d.health;
    info.amount = applied;
    try { d.onDamage?.(applied, info); } catch (e) { ctx.reportError('combat', 'onDamage', e); }
    if (d.health <= 0 && d.alive) {
      d.alive = false;
      info.killed = true;
      try { d.onDeath?.(info); } catch (e) { ctx.reportError('combat', 'onDeath', e); }
      hooks.onKill(d, info);
    }
    return applied;
  }

  /** Revive / heal (gamemode respawns). */
  function heal(d, amount = Infinity) {
    if (!d) return;
    d.health = Math.min(d.maxHealth, d.health + amount);
    if (d.health > 0) d.alive = true;
  }

  /** World-space bounds of a damageable's hitboxes (out Box3). */
  function boundsOf(d, out = _box) {
    out.makeEmpty();
    for (const m of d.hitboxes) {
      if (!m.geometry) continue;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      m.updateWorldMatrix(true, false);
      _tmpBox.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
      out.union(_tmpBox);
    }
    if (out.isEmpty()) {
      d.object.getWorldPosition(_v);
      out.setFromCenterAndSize(_v.setY(_v.y + 0.9), _size.set(0.6, 1.8, 0.6));
    }
    return out;
  }
  const _v = new THREE.Vector3();
  const _size = new THREE.Vector3();

  function findByObject(obj) {
    let o = obj;
    while (o) {
      if (o.userData?.damageable) return o.userData.damageable;
      for (let i = 0; i < damageables.length; i++) if (damageables[i].object === o) return damageables[i];
      o = o.parent;
    }
    return null;
  }

  function findByKey(key) {
    if (!key) return null;
    for (let i = 0; i < damageables.length; i++) if (damageables[i].key === key) return damageables[i];
    return null;
  }

  return { damageables, hitboxes, register, unregister, applyDamage, heal, boundsOf, findByObject, findByKey };
}

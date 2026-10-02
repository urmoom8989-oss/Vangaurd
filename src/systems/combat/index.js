import * as THREE from 'three';
import { createDamageRegistry } from './damage.js';
import { createBallistics } from './ballistics.js';
import { createExplosions } from './explosions.js';
import { createGrenades } from './grenades.js';
import { createDebugDraw } from './debugDraw.js';
import { createDangerIndicator } from './dangerIndicator.js';
import {
  SURFACE_BALLISTICS, ZONE_MULT, EXPLOSIVES, GRENADE, PENETRATION_POWER, WEAPON_PROFILES, DEFAULT_PROFILE,
  resolveProfile, falloffAt, blastFalloff, ballisticSurface,
} from './tables.js';

/**
 * combat — damage model, hitscan ballistics (penetration, falloff, zones), explosions, frag grenades.
 * Owner: combat agent. See README.md in this folder for the full API + event list.
 *
 * services.combat (contract + extensions):
 *   fireHitscan({origin, direction, range?, damage, source, weaponId, spread?, penetration?, muzzle?, tracer?, team?, pellets?})
 *       -> { point, normal, surface, distance, target, zone, damage, headshot, killed, penetrations, end, hits[] } | null
 *   registerDamageable({object, health, maxHealth?, team?, name?, key?, armor?, onDamage?, onDeath?, hitboxes?, isPlayer?}) -> Damageable
 *   unregisterDamageable(d);  applyDamage(d, amount, info);  heal(d, amount);  damageables;  hitboxes
 *   explode({position, radius?, damage?, source?, type?:'frag'|'barrel'|'rocket', innerRadius?, impulse?, normal?}) -> report
 *   melee({origin, direction, range?, damage?, source?, weaponId?}) -> result | null
 *   registerWeaponProfile(id, profile);  getWeaponProfile(id);  damageAt(weaponId, distance, zone, baseDamage)
 *   throwGrenade({origin, velocity, fuse?, source?}) / throwGrenadeAt({from, target, source?, speed?, lob?}) / solveThrow(...)
 *   cookGrenade() / releaseGrenade();  grenade (state);  grenades (live);  setGrenadeInputEnabled(b);  addGrenades(n)
 *   createGrenadeMesh({pin, spoon}) -> Group (shared geometry/material; do not dispose them)
 *   transmission(from, to) -> 0..1 blast transmission;  penetrationOf(surface, material?) -> spec
 *   tables { SURFACE_BALLISTICS, ZONE_MULT, EXPLOSIVES, GRENADE, PENETRATION_POWER, WEAPON_PROFILES }
 *   stats { shots, hits, bodyHits, kills, penetrations, explosions, grenades };  setDebugDraw(bool);  clear()
 */
export default function createSystem(ctx) {
  const { events } = ctx;
  const profiles = { ...WEAPON_PROFILES };
  const stats = { shots: 0, hits: 0, bodyHits: 0, headshots: 0, kills: 0, penetrations: 0, explosions: 0, grenades: 0, playerDamage: 0 };
  const offs = [];
  let pendingMarker = null;

  const killEvt = { target: null, source: null, weaponId: null, zone: null, headshot: false, kind: 'bullet', position: new THREE.Vector3(), info: null, victim: null, killer: null, distance: null };
  const expHitEvt = {
    point: new THREE.Vector3(), normal: new THREE.Vector3(), surface: 'flesh', distance: 0, target: null, zone: 'torso', damage: 0,
    source: null, weaponId: null, headshot: false, killed: false, penetrated: 0, exit: false, kind: 'explosion',
    direction: new THREE.Vector3(), origin: new THREE.Vector3(), object: null, isPlayer: false,
  };
  function feedEntry(killer, victim, info, killerTeam, victimTeam) {
    // The HUD builds its own killfeed from combat:kill; only push directly when asked to (combat.killfeed).
    if (!ctx.settings.get('combat.killfeed', false)) return;
    ctx.services.hud.killfeed({ killer, victim, weapon: weaponName(info.weaponId), headshot: !!info.headshot, kind: info.kind, killerTeam, victimTeam });
  }
  const playerTarget = { id: 'player', key: 'player', name: 'You', team: 'player', isPlayer: true, alive: true, health: 0, maxHealth: 100 };

  function nameOf(source) {
    if (source === 'player') return ctx.settings.get('combat.playerName', 'You');
    if (typeof source === 'string' && source.startsWith('ai:')) {
      const id = source.slice(3);
      const ag = (ctx.services.ai.agents || []).find((a) => String(a.id) === id);
      return ag?.name || ag?.callsign || `Vanguard ${id}`;
    }
    return String(source ?? 'Unknown');
  }

  function weaponName(weaponId) {
    if (!weaponId) return '';
    try {
      const list = ctx.services.weapons.list?.() || [];
      const w = list.find((x) => x.id === weaponId);
      if (w?.name) return w.name;
    } catch { /* ignore */ }
    for (const k of Object.keys(EXPLOSIVES)) if (EXPLOSIVES[k].weaponId === weaponId) return EXPLOSIVES[k].name;
    if (weaponId === 'melee') return 'Melee';
    return resolveProfile(profiles, weaponId).name || String(weaponId);
  }

  function hitmarker(kind) {
    if (ctx.settings.get('gameplay.hitmarkers', true) === false) return;
    ctx.services.hud.hitmarker(kind);
  }

  const hooks = {
    nameOf,
    hitmarker,
    onKill(d, info) {
      stats.kills++;
      killEvt.target = d; killEvt.source = info.source; killEvt.weaponId = info.weaponId; killEvt.zone = info.zone;
      killEvt.headshot = !!info.headshot; killEvt.kind = info.kind || 'bullet'; killEvt.info = info;
      if (info.point) killEvt.position.copy(info.point); else d.object.getWorldPosition(killEvt.position);
      killEvt.victim = d.name || (d.team === 'enemy' ? 'Vanguard' : 'Target');
      killEvt.killer = nameOf(info.source);
      killEvt.distance = info.distance ?? null;
      events.emit('combat:kill', killEvt);
      feedEntry(killEvt.killer, killEvt.victim, info, info.source === 'player' ? 'friendly' : 'enemy', d.team === 'player' ? 'friendly' : d.team);
    },
    playerDamaged(dmg, info, wasAlive) {
      stats.playerDamage += dmg;
      // (the HUD draws the directional indicator from player:damaged -> info.sourcePosition)
      const ps = ctx.services.player.state;
      if (wasAlive && ps.alive === false) {
        playerTarget.alive = false; playerTarget.health = 0;
        playerTarget.team = ctx.services.gamemode.state?.playerTeam || 'player';
        killEvt.target = playerTarget; killEvt.source = info.source; killEvt.weaponId = info.weaponId; killEvt.zone = info.zone;
        killEvt.headshot = !!info.headshot; killEvt.kind = info.kind || 'bullet'; killEvt.info = info;
        killEvt.position.copy(ps.position); killEvt.victim = nameOf('player'); killEvt.killer = nameOf(info.source);
        killEvt.distance = info.distance ?? null;
        events.emit('combat:kill', killEvt);
        feedEntry(killEvt.killer, killEvt.victim, info, 'enemy', 'friendly');
      }
    },
    nearMiss(dist) {
      const k = 1 - dist / 1.6;
      ctx.services.player.addShake(0.05 * k + 0.02, 0.12);
      ctx.services.postfx.pulse('suppression', 0.25 + 0.5 * k, 0.5 + 0.4 * k);
    },
    explosionHit(d, applied, info) {
      // explosion damage is a hit too (hitmarkers, blood, hit sounds listen to combat:hit)
      const e = expHitEvt;
      e.point.copy(info.point); e.normal.copy(info.direction).negate(); e.distance = info.distance; e.target = d; e.damage = applied;
      e.source = info.source; e.weaponId = info.weaponId; e.killed = !d.alive; e.direction.copy(info.direction);
      e.origin.copy(info.sourcePosition); e.object = null;
      if (applied > 0) events.emit('combat:hit', e);
      if (info.source === 'player' && applied > 0) {
        pendingMarker = pendingMarker === 'kill' || !d.alive ? 'kill' : 'hit';
      }
    },
    afterExplosion() {
      if (pendingMarker) { hitmarker(pendingMarker); pendingMarker = null; }
    },
    explode: (opts) => explode(opts),
  };

  const reg = createDamageRegistry(ctx, hooks);
  const ballistics = createBallistics(ctx, reg, profiles, hooks);
  const explosions = createExplosions(ctx, reg, hooks);
  const grenades = createGrenades(ctx, hooks);
  const debug = createDebugDraw(ctx);
  const danger = createDangerIndicator(ctx, {
    getGrenades: () => grenades.grenades,
    dangerRadius: GRENADE.dangerRadius ?? 9.5,
    lethalRadius: EXPLOSIVES.frag.radius,
  });

  // ---------------------------------------------------------------- wrapped API
  function fireHitscan(opts) {
    stats.shots++;
    const res = ballistics.fireHitscan(opts);
    if (res) {
      stats.hits++;
      stats.penetrations += res.penetrations;
      for (const h of res.hits) if (h.kind !== 'world') { stats.bodyHits++; if (h.headshot) stats.headshots++; }
      if (debug.enabled) debug.shot(opts.origin, res);
    }
    return res;
  }

  function explode(opts = {}) {
    stats.explosions++;
    const out = explosions.explode(opts);
    if (out && debug.enabled) {
      debug.ring(out.position, EXPLOSIVES[opts.type]?.innerRadius ?? 1.5, 0xff3010);
      debug.ring(out.position, out.radius, 0xff9020);
    }
    return out;
  }

  const _mo = new THREE.Vector3();
  const _md = new THREE.Vector3();
  const _mr = new THREE.Vector3();
  const _mu = new THREE.Vector3();
  function melee({ origin, direction, range = 1.9, damage = 135, source = 'player', weaponId = 'melee' } = {}) {
    if (!origin || !direction) return null;
    // centre ray, then a small fan (a knife swing is not a laser)
    _md.copy(direction).normalize();
    _mr.crossVectors(_md, _mu.set(0, 1, 0)).normalize();
    _mu.crossVectors(_mr, _md);
    const offs2 = [[0, 0], [0.18, 0], [-0.18, 0], [0, -0.16], [0, 0.12]];
    for (const [x, y] of offs2) {
      _mo.copy(_md).addScaledVector(_mr, x).addScaledVector(_mu, y).normalize();
      const res = ballistics.fireHitscan({ origin, direction: _mo, range, damage, source, weaponId, penetration: false, tracer: false, falloff: [[0, 1]], headMultiplier: 1.0, impactFx: true });
      if (res && res.target) return res;
      if (x === 0 && y === 0 && res && !res.target && res.distance < range * 0.6) return res; // hit a wall first
    }
    return null;
  }

  function damageAt(weaponId, distance, zone = 'torso', baseDamage) {
    const p = resolveProfile(profiles, weaponId);
    const base = baseDamage ?? 30;
    const zm = zone === 'head' ? p.head : ZONE_MULT[zone] ?? 1;
    return base * falloffAt(p.falloff, distance) * zm;
  }

  function registerWeaponProfile(id, profile) {
    profiles[id] = { ...DEFAULT_PROFILE, ...profile };
    return profiles[id];
  }

  function setDebugDraw(on) { debug.setEnabled(on); }

  function clear() { grenades.clear(); explosions.clear(); debug.clear(); }

  // grenade throws are recorded while debug draw is on, so the arc can be drawn
  function throwGrenade(opts) {
    stats.grenades++;
    const g = grenades.throwGrenade({ ...opts, recordPath: opts?.recordPath ?? debug.enabled });
    return g;
  }

  const api = {
    // contract
    fireHitscan,
    registerDamageable: reg.register,
    unregisterDamageable: reg.unregister,
    applyDamage: reg.applyDamage,
    explode,
    damageables: reg.damageables,
    // extensions
    hitboxes: reg.hitboxes,
    heal: reg.heal,
    findDamageable: reg.findByObject,
    melee,
    damageAt,
    registerWeaponProfile,
    getWeaponProfile: (id) => resolveProfile(profiles, id),
    profiles,
    penetrationOf: (surface, material) => SURFACE_BALLISTICS[ballisticSurface(surface, material)],
    transmission: explosions.transmission,
    blastFalloff,
    tables: { SURFACE_BALLISTICS, ZONE_MULT, EXPLOSIVES, GRENADE, PENETRATION_POWER, WEAPON_PROFILES: profiles },
    throwGrenade,
    throwGrenadeAt: (o) => { stats.grenades++; return grenades.throwGrenadeAt(o); },
    solveThrow: grenades.solveThrow,
    cookGrenade: grenades.cookGrenade,
    releaseGrenade: grenades.releaseGrenade,
    cancelGrenade: grenades.cancelGrenade,
    grenade: grenades.state,
    grenades: grenades.grenades,
    /** true = combat owns the grenade key (cook/throw) even if weapons has a lethal; false = never. */
    grenadeInputOwned: () => grenades.inputOwned(),
    setGrenadeInputEnabled(b) { grenades.state.inputEnabled = !!b; if (b) grenades.state.inputMode = 'always'; },
    addGrenades(n = 1) { grenades.state.count = Math.min(grenades.state.max, grenades.state.count + n); },
    createGrenadeMesh: grenades.createGrenadeMesh,
    measureExit: ballistics.measureExit,
    stats,
    setDebugDraw,
    /** grenade danger indicator (FX-layer sprites, drawn over everything) */
    setDangerIndicator: (b) => danger.setEnabled(b),
    debugDraw: debug,
    clear,
  };

  return {
    name: 'combat',
    async init() {
      ctx.settings.registerDefaults('combat', {
        friendlyFire: false,
        selfDamage: true,
        grenadeInput: 'auto', // true | false | 'auto' (off while the weapons system runs its own lethal)
        debugDraw: false,
        playerName: 'You',
        dangerIndicator: true,
      });
      const gi = ctx.settings.get('combat.grenadeInput', 'auto');
      grenades.state.inputEnabled = gi !== false;
      grenades.state.inputMode = gi === 'auto' ? 'auto' : 'always';
      offs.push(events.on('weapons:grenade', () => { grenades.state.weaponsOwnsLethal = true; }));
      grenades.ensureAssets();
      ctx.scene.add(grenades.root);
      debug.setEnabled(!!ctx.settings.get('combat.debugDraw', false));
      danger.setEnabled(ctx.settings.get('combat.dangerIndicator', true) !== false);

      offs.push(events.on('player:died', () => {
        // dropping a cooked grenade when killed
        if (grenades.state.cooking) {
          grenades.state.cooking = false;
          const ps = ctx.services.player.state;
          grenades.throwGrenade({ origin: ps.eye || ps.position, velocity: new THREE.Vector3(0, -0.5, 0), fuse: Math.max(0.1, GRENADE.fuse - grenades.state.cookTime), source: 'player', team: 'player', spoon: true });
        }
      }));
      offs.push(events.on('settings:changed', ({ path, value }) => {
        if (path === 'combat.debugDraw') debug.setEnabled(!!value);
        if (path === 'combat.dangerIndicator') danger.setEnabled(!!value);
        if (path === 'combat.grenadeInput') {
          grenades.state.inputEnabled = value !== false;
          grenades.state.inputMode = value === 'auto' ? 'auto' : 'always';
        }
      }));

      const gui = ctx.debug.gui?.addFolder('combat');
      if (gui) {
        const o = { debugDraw: debug.enabled, frag: () => grenades.cookGrenade() && grenades.releaseGrenade() };
        gui.add(o, 'debugDraw').onChange((v) => debug.setEnabled(v));
        gui.add(o, 'frag');
        gui.add(stats, 'kills').listen();
      }

      ctx.services.provide('combat', api);
    },
    fixedUpdate(dt) {
      grenades.fixedUpdate(dt);
      if (debug.enabled) for (const g of grenades.grenades) if (g.path && g.path.length >= 6) {
        const n = g.path.length;
        debug.seg(_mo.set(g.path[n - 6], g.path[n - 5], g.path[n - 4]), _md.set(g.path[n - 3], g.path[n - 2], g.path[n - 1]), 0x40c0ff);
      }
    },
    update() {
      grenades.handleInput();
      grenades.update();
      explosions.update();
    },
    lateUpdate() {
      danger.update();
      if (debug.enabled) debug.flush();
    },
    dispose() {
      for (const off of offs) off();
      offs.length = 0;
      grenades.dispose();
      danger.dispose();
      debug.dispose();
      reg.damageables.length = 0;
      reg.hitboxes.length = 0;
    },
  };
}

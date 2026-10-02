import * as THREE from 'three';

/**
 * Service registry (core, frozen).
 *
 * ctx.services is a plain object keyed by system name. Before any system loads, core installs a SAFE
 * DEFAULT for every documented service (below), so consumers never crash when a producer is missing,
 * disabled via `only`, or broken. A producer publishes its real API with:
 *
 *     ctx.services.provide('audio', { play(name, opts) {...}, ... });
 *
 * provide() keeps your object (same identity, so later mutations are visible to consumers) and sets the
 * safe default as its prototype, so any documented member you have not implemented yet still resolves
 * to the no-op. (Class instances are stored as-is, without the fallback.)
 *
 * Consumers: always look services up at call time (`ctx.services.audio.play(...)`), do not cache the
 * service object at module load. For APIs not documented in ARCHITECTURE.md use optional chaining:
 * `ctx.services.vfx.spawnFancyThing?.(...)`.
 *
 * ctx.services.isProvided('audio') -> true once a real producer has published.
 */

const noop = () => {};
const nullHandle = Object.freeze({ stop: noop, setPosition: noop, setVolume: noop, setPitch: noop, playing: false });

export function createDefaultServices(ctx) {
  const v3 = () => new THREE.Vector3();

  return {
    // --------------------------------------------------------------------------- materials
    materials: {
      ready: Promise.resolve(),
      get(name) { return fallbackMaterial(name); },
      has() { return false; },
      list() { return []; },
      clone(name) { return fallbackMaterial(name).clone(); },
      surfaceOf() { return 'default'; },
    },

    // --------------------------------------------------------------------------- lighting
    lighting: {
      sun: null,
      getSunDirection(out = v3()) { return out.set(0.4, 0.8, 0.3).normalize(); },
      environment: null,
      setPreset() {},
      presets: [],
      setExposure(v) { if (ctx.renderer) ctx.renderer.toneMappingExposure = v; },
    },

    // --------------------------------------------------------------------------- world
    world: {
      ready: Promise.resolve(),
      root: null,
      bounds: new THREE.Box3(new THREE.Vector3(-50, -1, -50), new THREE.Vector3(50, 20, 50)),
      spawnPoints: { player: [{ position: new THREE.Vector3(0, 0, 0), yaw: 0 }], ai: [] },
      raycast() { return null; },
      raycastAll() { return []; },
      collideCapsule() { return false; },
      groundHeight() { return 0; },
      addCollider() {},
      removeCollider() {},
      colliders: [],
      nav: { findPath(from, to) { return [from.clone(), to.clone()]; }, randomPoint(out = v3()) { return out.set(0, 0, 0); } },
    },

    // --------------------------------------------------------------------------- postfx
    postfx: {
      /** Return true if postfx rendered the frame; false -> core does renderer.render(scene, camera). */
      render() { return false; },
      setADS() {},
      pulse() {},
      setEffect() {},
      setQuality() {},
      composer: null,
    },

    // --------------------------------------------------------------------------- player
    player: {
      state: {
        position: v3(), velocity: v3(), eye: v3(), forward: new THREE.Vector3(0, 0, -1),
        yaw: 0, pitch: 0, roll: 0, stance: 'stand', grounded: true, sprinting: false, sliding: false,
        moving: false, speed: 0, lean: 0, health: 100, maxHealth: 100, alive: true, ads: 0,
      },
      teleport() {},
      setPose() {},
      applyRecoil() {},
      addShake() {},
      setZoom() {},
      setMovementEnabled() {},
      damage() {},
    },

    // --------------------------------------------------------------------------- weapons
    weapons: {
      state: {
        id: null, name: '', ammo: 0, magSize: 0, reserve: 0, fireMode: 'auto', ads: 0,
        reloading: false, reloadProgress: 0, sprinting: false, lastShotTime: -1, spread: 0, action: 'idle',
      },
      viewmodel: null,
      list() { return []; },
      equip() {},
      setPose() {},
    },

    // --------------------------------------------------------------------------- combat
    combat: {
      fireHitscan() { return null; },
      registerDamageable() { return { unregister: noop, id: -1 }; },
      unregisterDamageable() {},
      applyDamage() {},
      explode() {},
      damageables: [],
    },

    // --------------------------------------------------------------------------- vfx
    vfx: {
      spawn() { return null; },
      decal() { return null; },
      types() { return []; },
      clear() {},
    },

    // --------------------------------------------------------------------------- ai
    ai: {
      agents: [],
      spawn() { return null; },
      count() { return 0; },
      killAll() {},
      setEnabled() {},
    },

    // --------------------------------------------------------------------------- audio
    audio: {
      context: null,
      play() { return nullHandle; },
      playAt() { return nullHandle; },
      list() { return []; },
      setVolume() {},
      resume() { return Promise.resolve(); },
      async renderOffline() { throw new Error('audio service not provided'); },
    },

    // --------------------------------------------------------------------------- hud
    hud: {
      root: null,
      setVisible() {},
      hitmarker() {},
      damageIndicator() {},
      notify() {},
      killfeed() {},
      setCrosshairSpread() {},
      setObjective() {},
    },

    // --------------------------------------------------------------------------- gamemode
    gamemode: {
      state: { mode: 'sandbox', phase: 'live', score: {}, timeLeft: Infinity, round: 1 },
      start() {},
      end() {},
      addScore() {},
    },
  };
}

let _fallbackMat = null;
function fallbackMaterial() {
  if (!_fallbackMat) {
    _fallbackMat = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.8, metalness: 0 });
    _fallbackMat.name = 'fallback';
  }
  return _fallbackMat;
}

export function createServiceRegistry(ctx) {
  const defaults = createDefaultServices(ctx);
  const provided = new Set();
  const services = {};
  for (const k of Object.keys(defaults)) services[k] = defaults[k];

  Object.defineProperties(services, {
    provide: {
      enumerable: false,
      value(name, api) {
        const base = defaults[name];
        const proto = Object.getPrototypeOf(api);
        // Plain objects keep their identity; the safe default becomes their prototype so any
        // documented member the producer has not implemented yet falls back to the no-op.
        if (base && base !== api && (proto === Object.prototype || proto === null)) Object.setPrototypeOf(api, base);
        services[name] = api;
        provided.add(name);
        return api;
      },
    },
    isProvided: { enumerable: false, value: (name) => provided.has(name) },
    defaults: { enumerable: false, value: defaults },
    /** Revert a service to its safe default (used by core when a system fails). */
    reset: {
      enumerable: false,
      value(name) {
        if (defaults[name]) services[name] = defaults[name];
        else delete services[name];
        provided.delete(name);
      },
    },
  });
  return services;
}

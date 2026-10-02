import * as THREE from 'three';
import { ParticleBatch } from './ParticleBatch.js';
import { Debris } from './Debris.js';
import { Decals } from './Decals.js';
import { MuzzleFlashes, LightPool, weaponClass, muzzlePreset } from './MuzzleFlash.js';
import { Effects, SURF } from './effects.js';
import { DustMotes } from './Ambient.js';
import { smokeVertex, smokeFragment, glowVertex, glowFragment } from './shaders.js';
import * as G from './geometry.js';

/**
 * vfx — visual effects for Opus of Duty. Owner: vfx agent. See README.md in this folder.
 *
 * services.vfx:
 *   spawn(type, params) -> handle | null      (unknown types ignored)
 *     'muzzle_flash' {weaponId, object?, eject?:bool, scale?}   'shell_eject' {weaponId, object?}
 *     'impact' {point, normal, surface, direction?}              'tracer' {from, to, force?}
 *     'blood' {point, normal, direction}                         'explosion' {position, radius}
 *     'smoke' {position, radius, duration}  -> emitter handle {alive, stop(), setPosition(v)}
 *     'dust' {position, scale?}   'sparks' {point, normal, count?}   'fire' {position, radius, duration}
 *     'embers' {position, radius, duration}   'smoke_column' {position, radius, duration, intensity?}
 *   decal({point, normal, surface, object?, kind:'bullet'|'blood'|'scorch', size?, direction?}) -> handle | null
 *   types(), clear()
 *   extras: getMuzzleWorld(object, weaponId, out) -> Vector3, setAutoEject(bool), setQuality(q), stats()
 * Emits 'vfx:shell_bounce' {position, speed, weaponClass} (pooled payload; copy it).
 */
const TYPES = ['muzzle_flash', 'impact', 'tracer', 'blood', 'explosion', 'smoke', 'shell_eject', 'dust',
  'sparks', 'fire', 'embers', 'smoke_column'];
const ONESHOT = Object.freeze({ type: 'oneshot', alive: false, stop() {}, setPosition() {} });
const QUALITY = { low: 0.25, medium: 0.75, high: 1, ultra: 1.15 };

export default function createSystem(ctx) {
  const { scene, camera, events, layers } = ctx;
  const rng = ctx.rng.fork('vfx');
  const root = new THREE.Group();
  root.name = 'vfx';
  let smoke, glow, debris, decals, lights, flashes, fx, motes;
  const textures = {};
  const disposables = [];
  const listeners = [];
  let ready = false;
  let autoEject = true;
  let frame = 0;

  ctx.settings.registerDefaults?.('vfx', {
    enabled: true,
    decals: true,
    shells: true,
    lights: true,
    motes: true,
    tracerEvery: 3,       // player tracer frequency (1 = every shot)
    wind: [0.8, 0.0, 0.35],
    ambientColumns: false,
  });
  const setting = (k, d) => { try { const v = ctx.settings.get(`vfx.${k}`); return v === undefined ? d : v; } catch { return d; } };

  // --------------------------------------------------------------------------------- scratch
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _mp = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _camPos = new THREE.Vector3();
  const _size = new THREE.Vector2();
  const _sunDir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
  const _sunCol = new THREE.Color(1, 1, 1);
  const _sky = new THREE.Color();
  const _gnd = new THREE.Color();
  const _tmpC = new THREE.Color();
  const _wind = new THREE.Vector3();
  const sortCam = new THREE.Object3D();
  const lastPlayerMuzzle = { pos: new THREE.Vector3(), dir: new THREE.Vector3(), t: -10, frame: -10 };
  const recent = []; // dedupe ring: {frame, x, y, z, kind}
  for (let i = 0; i < 32; i++) recent.push({ frame: -1, x: 0, y: 0, z: 0, kind: '' });
  let recentIdx = 0;
  const tracerQueue = [];
  for (let i = 0; i < 48; i++) tracerQueue.push({ from: new THREE.Vector3(), to: new THREE.Vector3(), force: false });
  let tracerCount = 0;
  let playerTracerN = 0;
  let otherTracerN = 0;
  const ejectFrame = new WeakMap();
  const bounceEvt = { position: new THREE.Vector3(), speed: 0, weaponClass: 'rifle' };
  let lightScanT = -10;
  const hemis = [];
  let lastLightUpdate = -10;

  function dedupe(kind, p, radius = 0.06, frameSlack = 0) {
    for (const r of recent) {
      if (frame - r.frame <= frameSlack && r.kind === kind && Math.abs(r.x - p.x) < radius && Math.abs(r.y - p.y) < radius && Math.abs(r.z - p.z) < radius) return true;
    }
    const r = recent[recentIdx];
    recentIdx = (recentIdx + 1) % recent.length;
    r.frame = frame; r.kind = kind; r.x = p.x; r.y = p.y; r.z = p.z;
    return false;
  }

  function isUnderCamera(o) {
    for (let p = o; p; p = p.parent) if (p === camera) return true;
    return false;
  }

  // --------------------------------------------------------------------------------- textures
  function fallbackTex(rgba) {
    const t = new THREE.DataTexture(new Uint8Array(rgba), 1, 1);
    t.needsUpdate = true;
    disposables.push(t);
    return t;
  }

  async function loadTextures() {
    const base = '/assets/vfx/';
    const load = (name, o, fb) => ctx.assets.texture(base + name, o).catch((e) => {
      ctx.reportError('vfx', 'init', new Error(`texture ${name} failed: ${e?.message || e}`));
      return fallbackTex(fb);
    });
    const [a, b, flash, dc, dn, noise] = await Promise.all([
      load('smoke_a.png', { srgb: false }, [200, 200, 200, 0]),
      load('smoke_b.png', { srgb: false }, [160, 160, 160, 0]),
      load('flash.png', { srgb: false }, [0, 0, 0, 0]),
      load('decal_color.png', { srgb: true }, [0, 0, 0, 0]),
      load('decal_normal.png', { srgb: false }, [128, 128, 255, 255]),
      load('noise.png', { srgb: false, repeat: [1, 1] }, [128, 128, 128, 128]),
    ]);
    Object.assign(textures, { smokeA: a, smokeB: b, flash, decalColor: dc, decalNormal: dn, noise });
    for (const t of [a, b, flash]) { t.anisotropy = 4; }
  }

  // --------------------------------------------------------------------------------- materials
  let fallbackDepth = null;
  function makeSmokeMaterial() {
    if (!fallbackDepth) {
      fallbackDepth = new THREE.DataTexture(new Float32Array([0]), 1, 1, THREE.RedFormat, THREE.FloatType);
      fallbackDepth.needsUpdate = true;
      disposables.push(fallbackDepth);
    }
    const m = new THREE.ShaderMaterial({
      vertexShader: smokeVertex,
      fragmentShader: smokeFragment,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        tA: { value: null }, tB: { value: null }, tNoise: { value: null },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uSkyColor: { value: new THREE.Color(0.3, 0.33, 0.38) },
        uGroundColor: { value: new THREE.Color(0.15, 0.13, 0.11) },
        uTime: { value: 0 },
        uEmissive: { value: 6 },
        uPixelScale: { value: 1000 },
        tSceneDepth: { value: null },
        uHasDepth: { value: 0 },
      }]),
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      fog: true,
    });
    m.uniforms.tA.value = textures.smokeA;
    m.uniforms.tB.value = textures.smokeB;
    m.uniforms.tNoise.value = textures.noise;
    m.name = 'vfx_smoke';
    return m;
  }

  function makeGlowMaterial() {
    const m = new THREE.ShaderMaterial({
      vertexShader: glowVertex,
      fragmentShader: glowFragment,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        tFlash: { value: null },
        uPixelScale: { value: 1000 },
        tSceneDepth: { value: null },
        uHasDepth: { value: 0 },
      }]),
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      fog: true,
    });
    m.uniforms.tFlash.value = textures.flash;
    m.name = 'vfx_glow';
    return m;
  }

  // --------------------------------------------------------------------------------- build
  function build() {
    const smokeMat = makeSmokeMaterial();
    const glowMat = makeGlowMaterial();
    disposables.push(smokeMat, glowMat);
    smoke = new ParticleBatch({ capacity: 3000, material: smokeMat, sorted: true, name: 'vfx_smoke', layer: layers.FX, renderOrder: 10 });
    glow = new ParticleBatch({ capacity: 2000, material: glowMat, sorted: false, name: 'vfx_glow', layer: layers.FX, renderOrder: 11 });
    root.add(smoke.mesh, glow.mesh);

    const brass = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.78, 0.55, 0.26), metalness: 1, roughness: 0.27, envMapIntensity: 1.3 });
    brass.name = 'vfx_brass';
    const rock = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
    rock.name = 'vfx_chip';
    const glassMat = new THREE.MeshStandardMaterial({ color: 0xd8efe8, roughness: 0.04, metalness: 0.1, transparent: true, opacity: 0.55, envMapIntensity: 2.5, side: THREE.DoubleSide });
    glassMat.name = 'vfx_glass_shard';
    const geos = { rifle: G.rifleCasing(), pistol: G.pistolCasing(), chip: G.chip(), clod: G.clod(), splinter: G.splinter(), shard: G.shard() };
    disposables.push(brass, rock, glassMat, ...Object.values(geos));
    const onBounce = (pool, i, speed) => {
      bounceEvt.position.set(pool.pos[i * 3], pool.pos[i * 3 + 1], pool.pos[i * 3 + 2]);
      bounceEvt.speed = speed;
      bounceEvt.weaponClass = pool.meta[i] === 1 ? 'pistol' : 'rifle';
      events.emit('vfx:shell_bounce', bounceEvt);
    };
    const W = layers.WORLD;
    debris = {
      chips: new Debris({ geometry: geos.chip, material: rock, capacity: 400, name: 'vfx_chips', layer: W, radius: 1 }),
      clods: new Debris({ geometry: geos.clod, material: rock, capacity: 300, name: 'vfx_clods', layer: W, radius: 1 }),
      splinters: new Debris({ geometry: geos.splinter, material: rock, capacity: 150, name: 'vfx_splinters', layer: W, radius: 0.35 }),
      shards: new Debris({ geometry: geos.shard, material: glassMat, capacity: 200, name: 'vfx_shards', layer: W, radius: 0.4 }),
      shellsRifle: new Debris({ geometry: geos.rifle, material: brass, capacity: 120, name: 'vfx_shells_rifle', layer: W, radius: 0.02, lieAxis: 'y', restOffset: 0.0048, onBounce }),
      shellsPistol: new Debris({ geometry: geos.pistol, material: brass, capacity: 60, name: 'vfx_shells_pistol', layer: W, radius: 0.009, lieAxis: 'y', restOffset: 0.0049, onBounce }),
    };
    for (const k in debris) root.add(debris[k].mesh);

    decals = new Decals(ctx, textures, rng);
    decals.group.traverse((o) => o.layers.set(layers.WORLD));
    root.add(decals.group);

    lights = new LightPool(root, 3);
    flashes = new MuzzleFlashes(ctx, textures.flash, 8);
    fx = new Effects(ctx, { smoke, glow, debris, decals, lights, flashes }, rng);
    fx.decalDedupe = dedupe;
    motes = new DustMotes(700, rng, layers.FX);
    root.add(motes.mesh);
    scene.add(root);
    applySettings();
  }

  function applySettings() {
    if (!fx) return;
    const q = ctx.settings.get?.('graphics.quality') || 'high';
    fx.quality = QUALITY[q] ?? 1;
    decals.enabled = setting('decals', true) !== false;
    const w = setting('wind', [0.8, 0, 0.35]);
    if (Array.isArray(w)) _wind.set(w[0] || 0, w[1] || 0, w[2] || 0);
  }

  // --------------------------------------------------------------------------------- lighting estimate
  function updateLighting(t) {
    const L = ctx.services.lighting;
    try { L.getSunDirection(_sunDir); } catch { /* keep */ }
    if (_sunDir.lengthSq() < 1e-6) _sunDir.set(0.4, 0.8, 0.3);
    _sunDir.normalize();
    fx.sunDir.copy(_sunDir);
    if (t - lastLightUpdate < 0.25 && t >= lastLightUpdate) return;
    lastLightUpdate = t;
    const sun = L.sun;
    if (sun && sun.isLight) _sunCol.copy(sun.color).multiplyScalar(sun.intensity);
    else _sunCol.setRGB(3, 2.8, 2.5);
    if (t - lightScanT > 2 || t < lightScanT) {
      lightScanT = t;
      hemis.length = 0;
      scene.traverse((o) => { if ((o.isHemisphereLight || o.isAmbientLight) && o.visible) hemis.push(o); });
    }
    _sky.setRGB(0, 0, 0);
    _gnd.setRGB(0, 0, 0);
    for (const h of hemis) {
      if (!h.visible) continue;
      _tmpC.copy(h.color).multiplyScalar(h.intensity);
      _sky.add(_tmpC);
      if (h.isHemisphereLight) { _tmpC.copy(h.groundColor).multiplyScalar(h.intensity); }
      _gnd.add(_tmpC);
    }
    _sky.multiplyScalar(1 / Math.PI);
    _gnd.multiplyScalar(1 / Math.PI);
    if (scene.environment) {
      const ei = scene.environmentIntensity ?? 1;
      if (scene.fog?.color) _tmpC.copy(scene.fog.color);
      else if (scene.background?.isColor) _tmpC.copy(scene.background);
      else _tmpC.setRGB(0.45, 0.5, 0.58);
      // fog colour carries the warm aerial haze; skylight on smoke should read cooler (blue-grey shadows)
      const lum = _tmpC.r * 0.2126 + _tmpC.g * 0.7152 + _tmpC.b * 0.0722;
      _tmpC.r = _tmpC.r * 0.35 + lum * 0.55; _tmpC.g = _tmpC.g * 0.35 + lum * 0.62; _tmpC.b = _tmpC.b * 0.35 + lum * 0.78;
      _sky.r += _tmpC.r * ei; _sky.g += _tmpC.g * ei; _sky.b += _tmpC.b * ei;
      _gnd.r += _tmpC.r * ei * 0.45; _gnd.g += _tmpC.g * ei * 0.42; _gnd.b += _tmpC.b * ei * 0.38;
    }
    if (_sky.r + _sky.g + _sky.b < 0.01) { _sky.setRGB(0.25, 0.28, 0.33); _gnd.setRGB(0.12, 0.1, 0.09); }
    const u = smoke.mesh.material.uniforms;
    u.uSunColor.value.copy(_sunCol).multiplyScalar(1 / Math.PI);
    u.uSkyColor.value.copy(_sky);
    u.uGroundColor.value.copy(_gnd);
  }

  // --------------------------------------------------------------------------------- spawners
  function muzzleFlash(params) {
    const weaponId = params.weaponId || ctx.services.weapons?.state?.id || 'rifle';
    let object = params.object || null;
    const preset = muzzlePreset(weaponId);
    if (!object && params.position) {
      _mp.copy(params.position);
      _dir.copy(params.direction || _v.set(0, 0, -1)).normalize();
      fx.muzzleGlow(_mp, _dir, 1);
      fx.muzzleSmoke(_mp, _dir, 1, 1);
      if (setting('lights', true)) lights.flash(1, _v2.copy(_mp).addScaledVector(_dir, 0.3), 0xffa25a, 5 * preset.light, 6, 0.06);
      return ONESHOT;
    }
    if (!object) object = ctx.services.weapons?.viewmodel || null;
    if (!object) return null;
    const view = isUnderCamera(object);
    const ads = view ? (ctx.services.weapons?.state?.ads || 0) : 0;
    flashes.fire(object, weaponId, rng, view ? layers.VIEWMODEL : layers.FX, ads, (params.scale ?? 1) * (view ? 1.4 - 0.45 * ads : 1));
    flashes.muzzleWorld(object, weaponId, _mp);
    const a = flashes.anchor(object, weaponId);
    a.node.getWorldQuaternion(_q);
    _dir.set(0, 0, -1).applyQuaternion(_q);
    if (setting('lights', true)) {
      _v2.copy(_mp).addScaledVector(_dir, 0.25);
      lights.flash(view ? 0 : 1, _v2, 0xffa058, 7 * preset.light * (1 - 0.3 * ads), 7, 0.055);
    }
    if (weaponClass(weaponId) !== 'suppressed' || rng.next() < 0.5) fx.muzzleSmoke(_mp, _dir, view ? 0.8 : 1, 1);
    if (!view) fx.muzzleGlow(_mp, _dir, weaponClass(weaponId) === 'suppressed' ? 0.2 : 1, frame);
    if (view) {
      lastPlayerMuzzle.pos.copy(_mp);
      lastPlayerMuzzle.dir.copy(_dir);
      lastPlayerMuzzle.t = ctx.time.t;
      lastPlayerMuzzle.frame = frame;
    }
    if (autoEject && params.eject !== false && setting('shells', true) && weaponClass(weaponId) !== 'shotgun') {
      if (ejectFrame.get(a.root) !== frame) { ejectFrame.set(a.root, frame); shellEject(object, weaponId); }
    }
    return ONESHOT;
  }

  function shellEject(object, weaponId) {
    const a = flashes.anchor(object, weaponId);
    a.eject.node.updateWorldMatrix(true, false);
    _v.copy(a.eject.pos).applyMatrix4(a.eject.node.matrixWorld);
    a.root.getWorldQuaternion(_q);
    const view = isUnderCamera(object);
    const pv = view ? ctx.services.player?.state?.velocity : null;
    // viewmodels are scaled toward the eye (image-invariant); start the brass at that scale and grow to 1:1
    let vmScale = 1;
    if (view) { a.root.getWorldScale(_v2); vmScale = Math.min(1, (_v2.x + _v2.y + _v2.z) / 3); }
    fx.shell(_v, _q, weaponClass(weaponId), pv, vmScale);
  }

  function queueTracer(from, to, force) {
    if (tracerCount >= tracerQueue.length) return;
    const e = tracerQueue[tracerCount++];
    e.from.copy(from); e.to.copy(to); e.force = !!force;
  }

  function flushTracers() {
    camera.getWorldPosition(_camPos);
    for (let i = 0; i < tracerCount; i++) {
      const e = tracerQueue[i];
      const fromPlayer = e.from.distanceToSquared(_camPos) < 0.5 * 0.5;
      if (fromPlayer) {
        const every = Math.max(1, setting('tracerEvery', 3) | 0);
        if (!e.force && (playerTracerN++ % every) !== 0) continue;
        if (frame - lastPlayerMuzzle.frame <= 1) e.from.copy(lastPlayerMuzzle.pos);
        fx.tracer(e.from, e.to, 540, 3.4, 2.2, 0.012, 16);
      } else {
        if (!e.force && (otherTracerN++ % 2) !== 0) continue;
        fx.tracer(e.from, e.to, 480, 4.2, 1.0, 0.016, 18);
      }
    }
    tracerCount = 0;
  }

  function spawn(type, params = {}) {
    if (!ready || !params || setting('enabled', true) === false) return null;
    try {
      switch (type) {
        case 'muzzle_flash': return muzzleFlash(params);
        case 'shell_eject': {
          if (!setting('shells', true)) return null;
          const weaponId = params.weaponId || ctx.services.weapons?.state?.id || 'rifle';
          const object = params.object || ctx.services.weapons?.viewmodel;
          if (!object) return null;
          const root = flashes.anchor(object, weaponId).root;
          if (ejectFrame.get(root) === frame) return ONESHOT; // already auto-ejected this frame
          ejectFrame.set(root, frame);
          shellEject(object, weaponId);
          return ONESHOT;
        }
        case 'impact': {
          if (!params.point) return null;
          const surf = params.surface || 'default';
          if (surf === 'flesh') { if (dedupe('blood', params.point)) return ONESHOT; fx.blood(params.point, params.normal || _v.set(0, 1, 0), params.direction); return ONESHOT; }
          if (dedupe('impact', params.point)) return ONESHOT;
          fx.impact(params.point, params.normal || _v.set(0, 1, 0), surf, params.direction);
          return ONESHOT;
        }
        case 'tracer':
          if (!params.from || !params.to) return null;
          queueTracer(params.from, params.to, params.force);
          return ONESHOT;
        case 'blood':
          if (!params.point) return null;
          if (dedupe('blood', params.point)) return ONESHOT;
          fx.blood(params.point, params.normal || _v.set(0, 1, 0), params.direction);
          return ONESHOT;
        case 'explosion':
          if (!params.position) return null;
          if (dedupe('explosion', params.position, 0.6)) return ONESHOT;
          fx.explosion(params.position, params.radius ?? 6, params.surface && params.surface !== 'default' ? params.surface : null);
          return ONESHOT;
        case 'smoke':
          if (!params.position) return null;
          return fx.startEmitter('smoke', params.position, params.radius ?? 5, params.duration ?? 20, 5);
        case 'smoke_column':
          if (!params.position) return null;
          return fx.startEmitter('column', params.position, params.radius ?? 3, params.duration ?? 1e9, 1.4, params.intensity ?? 1);
        case 'fire':
          if (!params.position) return null;
          return fx.startEmitter('fire', params.position, params.radius ?? 0.6, params.duration ?? 1e9, 16);
        case 'embers':
          if (!params.position) return null;
          return fx.startEmitter('embers', params.position, params.radius ?? 1, params.duration ?? 1e9, 6);
        case 'dust':
          if (!params.position) return null;
          fx.dust(params.position, params.scale ?? 1);
          return ONESHOT;
        case 'sparks':
          if (!params.point) return null;
          _v.copy(params.normal || _v2.set(0, 1, 0)).normalize();
          fx._sparks(params.point, _v, _v, fx.groundAt(params.point.x, params.point.y, params.point.z), params.count ?? 12);
          return ONESHOT;
        default: return null;
      }
    } catch (err) {
      ctx.reportError('vfx', `spawn:${type}`, err);
      return null;
    }
  }

  function decal(params) {
    if (!ready || !params || !params.point || !params.normal) return null;
    try {
      const kind = params.kind || 'bullet';
      if (kind === 'bullet') {
        const s = params.surface || 'default';
        if (s === 'flesh' || s === 'water') return null;
        return decals.bullet(params.point, params.normal, s, params.size);
      }
      // effects already place their own blood splatter / scorch in the same frame: don't stack a second one
      if (kind === 'blood') { if (dedupe('decal_blood', params.point, 0.45)) return null; return decals.blood(params.point, params.normal, params.direction || null, params.size ?? 0.7); }
      if (kind === 'scorch') { if (dedupe('decal_scorch', params.point, 1.2)) return null; return decals.scorch(params.point, params.normal, params.size ?? 3, SURF[params.surface]?.kind === 'soft'); }
      return null;
    } catch (err) {
      ctx.reportError('vfx', 'decal', err);
      return null;
    }
  }

  function clear() {
    if (!ready) return;
    smoke.clear(); glow.clear();
    for (const k in debris) debris[k].clear();
    decals.clear(); flashes.clear(); lights.clear(); fx.clearEmitters();
    tracerCount = 0;
  }

  // --------------------------------------------------------------------------------- frame
  function sortCamera() {
    const c = ctx.shot?.camera;
    if (c?.position) {
      sortCam.position.fromArray(c.position);
      if (c.target) sortCam.lookAt(_v.fromArray(c.target));
      // Object3D.lookAt points +Z at the target for non-cameras; flip to camera convention
      sortCam.rotateY(Math.PI);
      sortCam.updateMatrixWorld(true);
      return sortCam;
    }
    return camera;
  }

  /** Soft particles: borrow the postfx pipeline's full-res linear depth when it renders one this frame. */
  function bindSceneDepth() {
    let tex = null;
    try {
      const pf = ctx.services.postfx;
      const c = pf?.composer;
      if (c && c.linFull?.texture && (pf.isEnabled?.() ?? true)) {
        const F = c.flags || {}, q = c.quality || {};
        if ((F.ao && q.ao) || (F.rays && q.rays) || (F.flare && q.flare)) tex = c.linFull.texture;
      }
    } catch { tex = null; }
    for (const m of [smoke.mesh.material, glow.mesh.material]) {
      m.uniforms.tSceneDepth.value = tex || fallbackDepth;
      m.uniforms.uHasDepth.value = tex ? 1 : 0;
    }
  }

  function lateUpdate(dt, t) {
    if (!ready) return;
    frame++;
    fx.beginFrame();
    updateLighting(t);
    flushTracers();
    fx.updateEmitters(dt);
    smoke.wind.copy(_wind);
    glow.wind.copy(_wind);
    const cam = sortCamera();
    smoke.update(dt, t, cam);
    glow.update(dt, t, cam);
    for (const k in debris) debris[k].update(dt);
    decals.update(dt);
    flashes.update(dt);
    lights.update(dt, t);

    ctx.renderer.getDrawingBufferSize(_size);
    const fovRad = (camera.fov * Math.PI) / 180;
    const pixelScale = _size.y / (2 * Math.tan(fovRad / 2));
    const su = smoke.mesh.material.uniforms;
    su.uSunDir.value.copy(_sunDir);
    su.uTime.value = t;
    su.uPixelScale.value = pixelScale;
    glow.mesh.material.uniforms.uPixelScale.value = pixelScale;
    bindSceneDepth();
    const moteStrength = setting('motes', true) && fx.quality >= 0.7 ? 0.35 : 0;
    _tmpC.copy(_sunCol).multiplyScalar(1 / Math.PI);
    motes.update(t, _sunDir, _tmpC, pixelScale, _wind, moteStrength);
  }

  return {
    name: 'vfx',
    async init() {
      await loadTextures();
      build();
      ready = true;
      const on = (ev, fn) => { events.on(ev, fn); listeners.push([ev, fn]); };
      on('combat:hit', (e) => {
        if (!e || !e.target || !e.point) return;
        if (e.surface && e.surface !== 'flesh') return;
        if (dedupe('blood', e.point)) return;
        let dir = null;
        if (e.source === 'player' || !e.source) { camera.getWorldPosition(_camPos); dir = _dir.copy(e.point).sub(_camPos).normalize(); }
        fx.blood(e.point, e.normal || _v.set(0, 1, 0), dir);
      });
      on('combat:explosion', (e) => {
        if (!e?.position || dedupe('explosion', e.position, 0.6)) return;
        fx.explosion(e.position, e.radius ?? 6, e.surface && e.surface !== 'default' ? e.surface : null);
      });
      on('player:land', (e) => { if (e?.position && (e.speed ?? 0) > 5.5) fx.dust(e.position, Math.min(1.5, (e.speed - 4) / 4)); });
      on('settings:changed', (e) => { if (e?.path?.startsWith('vfx') || e?.path?.startsWith('graphics')) applySettings(); });

      if (setting('ambientColumns', false)) {
        const b = ctx.services.world?.bounds;
        if (b && !b.isEmpty()) {
          spawn('smoke_column', { position: _v.set(b.max.x + 60, 0, b.min.z - 90), radius: 4 });
          spawn('smoke_column', { position: _v.set(b.min.x - 110, 0, b.min.z - 40), radius: 3, intensity: 0.8 });
        }
      }

      if (ctx.debug?.gui) {
        const f = ctx.debug.gui.addFolder('vfx');
        const o = { explosion: () => spawn('explosion', { position: _v.copy(ctx.services.player.state.position).add(_v2.set(0, 0, -8)), radius: 6 }),
          smoke: () => spawn('smoke', { position: _v.copy(ctx.services.player.state.position).add(_v2.set(0, 0, -8)), radius: 5, duration: 20 }),
          clear };
        f.add(o, 'explosion'); f.add(o, 'smoke'); f.add(o, 'clear');
      }

      ctx.services.provide('vfx', {
        spawn,
        decal,
        types: () => TYPES.slice(),
        clear,
        getMuzzleWorld(object, weaponId, out = new THREE.Vector3()) { return object ? flashes.muzzleWorld(object, weaponId || 'rifle', out) : null; },
        setAutoEject(b) { autoEject = !!b; },
        setQuality(q) { fx.quality = typeof q === 'number' ? q : QUALITY[q] ?? 1; },
        stats() {
          let deb = 0;
          for (const k in debris) deb += debris[k].count;
          return { smoke: smoke.count, glow: glow.count, debris: deb, decals: decals.count(), emitters: fx.emitters.filter((e) => e.active).length };
        },
      });
    },
    lateUpdate,
    dispose() {
      for (const [ev, fn] of listeners) events.off(ev, fn);
      listeners.length = 0;
      if (!ready) return;
      flashes.dispose();
      lights.dispose();
      smoke.dispose(); glow.dispose();
      for (const k in debris) debris[k].dispose();
      decals.dispose();
      motes.dispose();
      for (const d of disposables) d.dispose?.();
      scene.remove(root);
      ready = false;
    },
  };
}

import * as THREE from 'three';
import { flashVertex, flashFragment } from './shaders.js';

/**
 * Muzzle flash rigs: an 8-quad additive mesh (front star, crossed forward cones, muzzle-brake side flares,
 * camera-facing core glow) parented to the weapon's muzzle so it follows the gun exactly for its ~2 frames of life.
 * Shape variation (frames, rotation, lengths) is hashed in the vertex shader from a per-shot seed, so a shot costs
 * only a few uniform writes. Also resolves muzzle / ejection-port anchors for arbitrary weapon Object3Ds.
 */
const _box = new THREE.Box3();
const _v = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _mw = new THREE.Matrix4();
const MUZZLE_NAMES = ['socket:muzzle', 'muzzle', 'Muzzle', 'muzzle_socket', 'MuzzleSocket', 'muzzleFlash', 'flash_socket'];
const EJECT_NAMES = ['socket:eject', 'ejection', 'Ejection', 'ejectionPort', 'ejection_port', 'eject', 'EjectionPort', 'socket:ejection'];
function hasMesh(o) {
  let found = false;
  o.traverse((c) => { if (c.isMesh && c.name !== 'vfx_muzzle_flash') found = true; });
  return found;
}

function buildRigGeometry() {
  const corners = [];
  const quads = [];
  const idx = [];
  for (let q = 0; q < 8; q++) {
    const b = q * 4;
    corners.push(0, 0, 1, 0, 1, 1, 0, 1);
    quads.push(q, q, q, q);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(32 * 3), 3));
  g.setAttribute('aCorner', new THREE.Float32BufferAttribute(corners, 2));
  g.setAttribute('aQuad', new THREE.Float32BufferAttribute(quads, 1));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  return g;
}

/** Muzzle presets by weapon class. */
export function weaponClass(weaponId = '') {
  const id = String(weaponId).toLowerCase();
  if (/suppress|silenc/.test(id)) return 'suppressed';
  if (/pistol|p9|handgun|sidearm|kestrel/.test(id)) return 'pistol';
  if (/shotgun/.test(id)) return 'shotgun';
  if (/sniper|dmr|marksman/.test(id)) return 'sniper';
  if (/lmg|mg|saw/.test(id)) return 'lmg';
  return 'rifle';
}

const PRESETS = {
  rifle: { star: 0.15, cone: 0.24, flare: 0.15, flares: 1, intensity: 8, light: 1, shell: 'rifle' },
  lmg: { star: 0.18, cone: 0.3, flare: 0.16, flares: 1, intensity: 9, light: 1.2, shell: 'rifle' },
  sniper: { star: 0.22, cone: 0.36, flare: 0.22, flares: 1, intensity: 10, light: 1.5, shell: 'rifle' },
  pistol: { star: 0.1, cone: 0.13, flare: 0.0, flares: 0, intensity: 7, light: 0.7, shell: 'pistol' },
  shotgun: { star: 0.2, cone: 0.34, flare: 0.0, flares: 0, intensity: 9, light: 1.4, shell: 'shotgun' },
  suppressed: { star: 0.035, cone: 0.05, flare: 0.0, flares: 0, intensity: 2.5, light: 0.12, shell: 'rifle' },
};
export function muzzlePreset(weaponId) { return PRESETS[weaponClass(weaponId)]; }

export class MuzzleFlashes {
  constructor(ctx, flashTex, count = 6) {
    this.ctx = ctx;
    this.geometry = buildRigGeometry();
    this.rigs = [];
    for (let i = 0; i < count; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: flashVertex,
        fragmentShader: flashFragment,
        uniforms: {
          tFlash: { value: flashTex },
          uSeed: { value: 0 },
          uScale: { value: new THREE.Vector3(0.15, 0.24, 0.15) },
          uFlares: { value: 1 },
          uAge: { value: 0 },
          uIntensity: { value: 0 },
          uTint: { value: new THREE.Color(1, 1, 1) },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
        side: THREE.DoubleSide,
      });
      mat.name = 'vfx_muzzle_flash';
      const mesh = new THREE.Mesh(this.geometry, mat);
      mesh.name = 'vfx_muzzle_flash';
      mesh.frustumCulled = false;
      mesh.renderOrder = 50;
      mesh.visible = false;
      this.rigs.push({ mesh, mat, age: 0, life: 0.05, active: false, intensity: 0, owner: null });
    }
    this.next = 0;
    this._anchors = new WeakMap();
  }

  /**
   * Resolve the muzzle anchor on a weapon object. Order: object.userData.muzzle (Object3D), a descendant named
   * muzzle/Muzzle/muzzle_socket/MuzzleSocket/flash, else the -Z extreme of the object's mesh bounds.
   * Returns { node, pos: Vector3 (in node space), eject: {node, pos} }. Cached per object+weaponId.
   */
  anchor(object, weaponId) {
    const key = object;
    let a = this._anchors.get(key);
    if (a && a.weaponId === weaponId && !a.empty) return a;
    a = a || { node: object, root: object, pos: new THREE.Vector3(), eject: { node: object, pos: new THREE.Vector3() }, weaponId, empty: false };
    a.weaponId = weaponId;
    a.empty = false;
    // A bare socket (no meshes) was passed: resolve against the weapon root that owns it (its parent), so the
    // muzzle and ejection sockets are found as siblings.
    const nm = String(object.name || '').toLowerCase();
    let root = object;
    if (object.parent && !hasMesh(object) && /socket|muzzle|eject|flash/.test(nm)) root = object.parent;
    a.root = root;
    const ud = root.userData || {};
    let node = /muzzle|flash/.test(nm) && !hasMesh(object) ? object : null;
    if (!node) node = ud.muzzle && ud.muzzle.isObject3D ? ud.muzzle : null;
    if (!node) for (const n of MUZZLE_NAMES) { node = root.getObjectByName(n); if (node) break; }
    let ej = /eject/.test(nm) && !hasMesh(object) ? object : null;
    if (!ej) ej = ud.ejection && ud.ejection.isObject3D ? ud.ejection : null;
    if (!ej) for (const n of EJECT_NAMES) { ej = root.getObjectByName(n); if (ej) break; }
    object = root;

    let bb = null;
    if (!node || !ej) bb = this._localBounds(object);
    if (node) { a.node = node; a.pos.set(0, 0, 0); }
    else {
      a.node = object;
      a.pos.copy(bb.muzzle);
      a.empty = bb.empty;
    }
    if (ej) { a.eject.node = ej; a.eject.pos.set(0, 0, 0); }
    else {
      a.eject.node = object;
      const len = bb.box.max.z - bb.box.min.z;
      a.eject.pos.set(bb.muzzle.x + 0.028, bb.muzzle.y + 0.012, bb.box.min.z + len * 0.58);
      if (weaponClass(weaponId) === 'pistol') a.eject.pos.set(bb.muzzle.x + 0.012, bb.muzzle.y + 0.02, bb.box.min.z + len * 0.55);
    }
    this._anchors.set(key, a);
    if (object !== key) this._anchors.set(object, a);
    return a;
  }

  _localBounds(object) {
    object.updateWorldMatrix(true, true);
    _inv.copy(object.matrixWorld).invert();
    _box.makeEmpty();
    let minZ = Infinity;
    const pts = [];
    object.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position || o.userData?.vfxIgnore || o.name === 'vfx_muzzle_flash') return;
      const pos = o.geometry.attributes.position;
      _mw.multiplyMatrices(_inv, o.matrixWorld);
      const step = Math.max(1, Math.floor(pos.count / 4000));
      for (let i = 0; i < pos.count; i += step) {
        _v.fromBufferAttribute(pos, i).applyMatrix4(_mw);
        _box.expandByPoint(_v);
        pts.push(_v.x, _v.y, _v.z);
        if (_v.z < minZ) minZ = _v.z;
      }
    });
    const muzzle = new THREE.Vector3(0, 0, _box.isEmpty() ? -0.5 : _box.min.z);
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < pts.length; i += 3) if (pts[i + 2] < minZ + 0.015) { sx += pts[i]; sy += pts[i + 1]; n++; }
    if (n) { muzzle.x = sx / n; muzzle.y = sy / n; }
    return { box: _box.clone(), muzzle, empty: _box.isEmpty() };
  }

  /** Muzzle world position of object (or null). */
  muzzleWorld(object, weaponId, out) {
    const a = this.anchor(object, weaponId);
    a.node.updateWorldMatrix(true, false);
    return out.copy(a.pos).applyMatrix4(a.node.matrixWorld);
  }

  fire(object, weaponId, rng, layer, ads = 0, scale = 1) {
    const a = this.anchor(object, weaponId);
    const p = muzzlePreset(weaponId);
    const rig = this.rigs[this.next];
    this.next = (this.next + 1) % this.rigs.length;
    if (rig.mesh.parent !== a.node) a.node.add(rig.mesh);
    rig.mesh.position.copy(a.pos);
    rig.mesh.rotation.set(0, 0, 0);
    rig.mesh.layers.set(layer);
    const big = rng.next() < 0.18 ? 1.3 : 1;
    const s = scale * big * (0.85 + rng.next() * 0.3);
    rig.mat.uniforms.uSeed.value = rng.next() * 100;
    rig.mat.uniforms.uScale.value.set(p.star * s, p.cone * s, p.flare * s);
    rig.mat.uniforms.uFlares.value = p.flares;
    rig.mat.uniforms.uAge.value = 0;
    rig.intensity = p.intensity * (1 - 0.35 * ads) * (0.85 + rng.next() * 0.3);
    rig.mat.uniforms.uIntensity.value = rig.intensity;
    rig.age = 0;
    rig.life = 0.034 + rng.next() * 0.018;
    rig.active = true;
    rig.fresh = true;
    rig.mesh.visible = true;
    return rig;
  }

  update(dt) {
    for (const rig of this.rigs) {
      if (!rig.active) continue;
      if (rig.fresh) { rig.fresh = false; continue; }
      rig.age += dt;
      if (rig.age >= rig.life) { rig.active = false; rig.mesh.visible = false; continue; }
      const t = rig.age / rig.life;
      rig.mat.uniforms.uAge.value = t;
      rig.mat.uniforms.uIntensity.value = rig.intensity * (1 - t) * (1 - t);
    }
  }

  clear() { for (const rig of this.rigs) { rig.active = false; rig.mesh.visible = false; } }

  dispose() {
    for (const rig of this.rigs) { rig.mesh.parent?.remove(rig.mesh); rig.mat.dispose(); }
    this.geometry.dispose();
  }
}

/** Pool of transient point lights that stay in the scene permanently (intensity 0 when idle) so the
 * light count never changes (no shader recompiles). */
export class LightPool {
  constructor(scene, count = 3) {
    this.lights = [];
    this.group = new THREE.Group();
    this.group.name = 'vfx_lights';
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffa050, 0, 8, 2);
      l.castShadow = false;
      l.name = `vfx_light_${i}`;
      this.group.add(l);
      this.lights.push({ light: l, age: 0, life: 0, peak: 0, flicker: 0, active: false, priority: 0 });
    }
    scene.add(this.group);
  }

  /** @param slot fixed slot index (0 player muzzle, 1 other muzzles/sparks, 2 explosions) */
  flash(slot, position, color, intensity, distance, life, flicker = 0) {
    const s = this.lights[slot];
    if (!s) return;
    if (s.active && s.peak * (1 - s.age / s.life) > intensity) return; // keep the stronger one
    s.light.position.copy(position);
    s.light.color.set(color);
    s.light.distance = distance;
    s.peak = intensity;
    s.life = life;
    s.age = 0;
    s.flicker = flicker;
    s.active = true;
    s.light.intensity = intensity;
  }

  update(dt, t) {
    for (const s of this.lights) {
      if (!s.active) continue;
      s.age += dt;
      if (s.age >= s.life) { s.active = false; s.light.intensity = 0; continue; }
      const k = 1 - s.age / s.life;
      const fl = s.flicker > 0 ? 1 - s.flicker * (0.5 + 0.5 * Math.sin(t * 61 + s.age * 37) * Math.sin(t * 23)) : 1;
      s.light.intensity = s.peak * k * k * fl;
    }
  }

  clear() { for (const s of this.lights) { s.active = false; s.light.intensity = 0; } }
  dispose() { this.group.parent?.remove(this.group); }
}

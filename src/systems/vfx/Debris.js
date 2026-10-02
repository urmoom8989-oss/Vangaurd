import * as THREE from 'three';

/**
 * Rigid mesh particles (chips, splinters, glass shards, dirt clods, brass casings) on one InstancedMesh.
 * CPU rigid-body-lite: gravity, air drag, tumbling, bounce + friction against a per-particle ground height and an
 * optional wall plane, settles to rest, shrinks out at end of life. Zero allocations per spawn/update.
 */
const _q = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _axis = new THREE.Vector3();
const _up = new THREE.Vector3();
const _flat = new THREE.Quaternion();
const _c = new THREE.Color();
const K3 = ['pos', 'vel', 'ang', 'scale', 'col'];
const K4 = ['quat', 'plane'];
const K1 = ['age', 'life', 'groundY', 'rest', 'restitution', 'friction', 'resting', 'drag', 'bounces', 'meta', 's0', 'growT'];

export class Debris {
  /**
   * @param {object} o { geometry, material, capacity, name, layer, radius (collision radius at scale 1),
   *   lieAxis: 'y'|null  (local axis that lies flat/horizontal when resting, e.g. casings), onBounce(i, speed) }
   */
  constructor({ geometry, material, capacity, name = 'debris', layer = 2, radius = 0.5, lieAxis = null, onBounce = null, castShadow = false, restOffset = null }) {
    this.restOffset = restOffset;
    this.capacity = capacity;
    this.count = 0;
    this.radius = radius;
    this.lieAxis = lieAxis;
    this.onBounce = onBounce;
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.layers.set(layer);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.mesh = mesh;
    const n = capacity;
    const F = (k = 1) => new Float32Array(n * k);
    this.pos = F(3); this.vel = F(3); this.quat = F(4); this.ang = F(3);
    this.scale = F(3); this.age = F(); this.life = F(); this.groundY = F(); this.rest = F();
    this.restitution = F(); this.friction = F(); this.resting = new Uint8Array(n); this.plane = F(4);
    this.col = F(3); this.drag = F(); this.bounces = new Uint8Array(n); this.meta = F();
    this.s0 = F(); this.growT = F();
    this.sp = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0, qx: 0, qy: 0, qz: 0, qw: 1,
      sx: 1, sy: 1, sz: 1, life: 3, groundY: -1e9, restitution: 0.3, friction: 0.6, r: 1, g: 1, b: 1, drag: 0.1,
      pnx: 0, pny: 0, pnz: 0, pd: 0, meta: 0, s0: 1, growT: 0 };
  }

  begin() {
    const s = this.sp;
    s.vx = s.vy = s.vz = s.ax = s.ay = s.az = 0; s.qx = s.qy = s.qz = 0; s.qw = 1; s.sx = s.sy = s.sz = 1;
    s.life = 3; s.groundY = -1e9; s.restitution = 0.3; s.friction = 0.6; s.r = s.g = s.b = 1; s.drag = 0.1;
    s.pnx = s.pny = s.pnz = s.pd = 0; s.meta = 0; s.s0 = 1; s.growT = 0;
    return s;
  }

  commit() {
    let i;
    if (this.count < this.capacity) i = this.count++;
    else {
      // recycle the oldest
      let best = 0, bt = -1;
      for (let j = 0; j < this.count; j++) { const t = this.age[j] / this.life[j]; if (t > bt) { bt = t; best = j; } }
      i = best;
    }
    const s = this.sp;
    this.pos[i * 3] = s.x; this.pos[i * 3 + 1] = s.y; this.pos[i * 3 + 2] = s.z;
    this.vel[i * 3] = s.vx; this.vel[i * 3 + 1] = s.vy; this.vel[i * 3 + 2] = s.vz;
    this.ang[i * 3] = s.ax; this.ang[i * 3 + 1] = s.ay; this.ang[i * 3 + 2] = s.az;
    _q.set(s.qx, s.qy, s.qz, s.qw).normalize();
    this.quat[i * 4] = _q.x; this.quat[i * 4 + 1] = _q.y; this.quat[i * 4 + 2] = _q.z; this.quat[i * 4 + 3] = _q.w;
    this.scale[i * 3] = s.sx; this.scale[i * 3 + 1] = s.sy; this.scale[i * 3 + 2] = s.sz;
    this.age[i] = 0; this.life[i] = s.life; this.groundY[i] = s.groundY; this.rest[i] = 0;
    this.restitution[i] = s.restitution; this.friction[i] = s.friction; this.resting[i] = 0; this.bounces[i] = 0;
    this.col[i * 3] = s.r; this.col[i * 3 + 1] = s.g; this.col[i * 3 + 2] = s.b; this.drag[i] = s.drag;
    this.plane[i * 4] = s.pnx; this.plane[i * 4 + 1] = s.pny; this.plane[i * 4 + 2] = s.pnz; this.plane[i * 4 + 3] = s.pd;
    this.meta[i] = s.meta; this.s0[i] = s.s0; this.growT[i] = s.growT;
    return i;
  }

  clear() { this.count = 0; this.mesh.count = 0; }

  _copy(dst, src) {
    for (const k of K3) { const a = this[k]; a[dst * 3] = a[src * 3]; a[dst * 3 + 1] = a[src * 3 + 1]; a[dst * 3 + 2] = a[src * 3 + 2]; }
    for (const k of K4) { const a = this[k]; for (let j = 0; j < 4; j++) a[dst * 4 + j] = a[src * 4 + j]; }
    for (const k of K1) this[k][dst] = this[k][src];
  }

  update(dt) {
    const g = -9.81;
    const { pos, vel, quat, ang, age, life } = this;
    for (let i = this.count - 1; i >= 0; i--) {
      age[i] += dt;
      if (age[i] >= life[i]) { const last = --this.count; if (i !== last) this._copy(i, last); continue; }
      if (this.resting[i]) continue;
      const i3 = i * 3, i4 = i * 4;
      const k = Math.exp(-this.drag[i] * dt);
      vel[i3] *= k; vel[i3 + 2] *= k;
      vel[i3 + 1] = vel[i3 + 1] * k + g * dt;
      pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
      // integrate orientation
      const ax = ang[i3], ay = ang[i3 + 1], az = ang[i3 + 2];
      const w = Math.hypot(ax, ay, az);
      if (w > 1e-5) {
        _axis.set(ax / w, ay / w, az / w);
        _qw.setFromAxisAngle(_axis, w * dt);
        _q.set(quat[i4], quat[i4 + 1], quat[i4 + 2], quat[i4 + 3]).premultiply(_qw).normalize();
        quat[i4] = _q.x; quat[i4 + 1] = _q.y; quat[i4 + 2] = _q.z; quat[i4 + 3] = _q.w;
      }
      const sc = Math.max(this.scale[i3], this.scale[i3 + 1], this.scale[i3 + 2]);
      const rad = this.radius * sc;
      // wall plane (the surface the debris came from): keep on the outside
      const pnx = this.plane[i4], pny = this.plane[i4 + 1], pnz = this.plane[i4 + 2];
      if (pnx !== 0 || pny !== 0 || pnz !== 0) {
        const d = pos[i3] * pnx + pos[i3 + 1] * pny + pos[i3 + 2] * pnz - this.plane[i4 + 3] - rad;
        if (d < 0) {
          pos[i3] -= pnx * d; pos[i3 + 1] -= pny * d; pos[i3 + 2] -= pnz * d;
          const vn = vel[i3] * pnx + vel[i3 + 1] * pny + vel[i3 + 2] * pnz;
          if (vn < 0) { const r = 1 + this.restitution[i]; vel[i3] -= pnx * vn * r; vel[i3 + 1] -= pny * vn * r; vel[i3 + 2] -= pnz * vn * r; }
        }
      }
      const gy = this.groundY[i] + rad * 0.55;
      if (pos[i3 + 1] < gy) {
        pos[i3 + 1] = gy;
        const vy = vel[i3 + 1];
        if (vy < 0) {
          const f = this.friction[i];
          vel[i3 + 1] = -vy * this.restitution[i];
          vel[i3] *= f; vel[i3 + 2] *= f;
          // impact spin: random-ish flip based on horizontal speed
          ang[i3] = ang[i3] * 0.5 + vel[i3 + 2] * 18;
          ang[i3 + 2] = ang[i3 + 2] * 0.5 - vel[i3] * 18;
          ang[i3 + 1] *= 0.5;
          if (this.bounces[i] < 255) this.bounces[i]++;
          if (this.onBounce && -vy > 0.6) this.onBounce(this, i, -vy);
          if (-vy < 0.9 && Math.hypot(vel[i3], vel[i3 + 2]) < 0.35) this._settle(i);
        }
      }
    }
    this._write();
  }

  _settle(i) {
    const i3 = i * 3, i4 = i * 4;
    this.resting[i] = 1;
    this.vel[i3] = this.vel[i3 + 1] = this.vel[i3 + 2] = 0;
    this.ang[i3] = this.ang[i3 + 1] = this.ang[i3 + 2] = 0;
    _q.set(this.quat[i4], this.quat[i4 + 1], this.quat[i4 + 2], this.quat[i4 + 3]);
    if (this.lieAxis === 'y') {
      // lay the long (local Y) axis horizontal, keep its heading
      _axis.set(0, 1, 0).applyQuaternion(_q);
      _axis.y = 0;
      if (_axis.lengthSq() < 1e-6) _axis.set(1, 0, 0);
      _axis.normalize();
      _up.set(0, 1, 0);
      _flat.setFromUnitVectors(_up, _axis);
      // random roll around the long axis is irrelevant for a cylinder
      _q.copy(_flat);
    } else {
      // tip onto the flattest face: align the local axis closest to world-up
      let best = 0, bd = -2;
      for (let a = 0; a < 3; a++) {
        _axis.set(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0).applyQuaternion(_q);
        const d = Math.abs(_axis.y);
        if (d > bd) { bd = d; best = a; }
      }
      _axis.set(best === 0 ? 1 : 0, best === 1 ? 1 : 0, best === 2 ? 1 : 0).applyQuaternion(_q);
      if (_axis.y < 0) _axis.negate();
      _up.set(0, 1, 0);
      _flat.setFromUnitVectors(_axis, _up);
      _q.premultiply(_flat);
    }
    this.quat[i4] = _q.x; this.quat[i4 + 1] = _q.y; this.quat[i4 + 2] = _q.z; this.quat[i4 + 3] = _q.w;
    const sc = Math.min(this.scale[i3], this.scale[i3 + 1], this.scale[i3 + 2]);
    this.pos[i3 + 1] = this.groundY[i] + (this.restOffset !== null ? this.restOffset * this.scale[i3] : this.radius * sc * 0.5);
  }

  _write() {
    const arr = this.mesh.instanceMatrix.array;
    const carr = this.mesh.instanceColor.array;
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3, i4 = i * 4;
      const t = this.age[i], L = this.life[i];
      let shrink = Math.min(1, Math.max(0, (L - t) / 0.6));
      const gt = this.growT[i];
      if (gt > 0 && t < gt) { const u = t / gt; shrink *= this.s0[i] + (1 - this.s0[i]) * u * u * (3 - 2 * u); }
      _p.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]);
      _q.set(this.quat[i4], this.quat[i4 + 1], this.quat[i4 + 2], this.quat[i4 + 3]);
      _s.set(this.scale[i3] * shrink, this.scale[i3 + 1] * shrink, this.scale[i3 + 2] * shrink);
      _m.compose(_p, _q, _s);
      _m.toArray(arr, i * 16);
      _c.setRGB(this.col[i3], this.col[i3 + 1], this.col[i3 + 2]);
      carr[i3] = _c.r; carr[i3 + 1] = _c.g; carr[i3 + 2] = _c.b;
    }
    this.mesh.count = this.count;
    if (this.count > 0) {
      this.mesh.instanceMatrix.clearUpdateRanges();
      this.mesh.instanceMatrix.addUpdateRange(0, this.count * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.clearUpdateRanges();
      this.mesh.instanceColor.addUpdateRange(0, this.count * 3);
      this.mesh.instanceColor.needsUpdate = true;
    }
    this.mesh.visible = this.count > 0;
  }

  dispose() { this.mesh.dispose(); }
}

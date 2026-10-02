import * as THREE from 'three';

/**
 * Effect recipes: compose particles (lit smoke batch, additive glow batch), mesh debris, decals and transient
 * lights into impacts, blood, explosions, smoke volumes, tracers, shells, fire and ambient columns.
 * Everything here runs with preallocated scratch objects; no allocations per spawn.
 */

// ------------------------------------------------------------------------------------------------ tables
// Linear albedos (the shaders work in linear space).
const S = (dust, chip, kind, extra = {}) => ({ dust, chip, kind, ...extra });
export const SURF = {
  concrete: S([0.42, 0.41, 0.39], [0.36, 0.35, 0.33], 'hard'),
  asphalt: S([0.24, 0.235, 0.23], [0.07, 0.07, 0.07], 'hard'),
  brick: S([0.42, 0.24, 0.16], [0.36, 0.13, 0.07], 'hard'),
  plaster: S([0.62, 0.6, 0.56], [0.7, 0.68, 0.64], 'hard', { puff: 1.4 }),
  tile: S([0.55, 0.54, 0.5], [0.6, 0.58, 0.55], 'hard'),
  gravel: S([0.33, 0.31, 0.28], [0.26, 0.25, 0.23], 'soft'),
  metal: S([0.26, 0.25, 0.24], [0.3, 0.3, 0.3], 'metal'),
  wood: S([0.38, 0.28, 0.17], [0.42, 0.28, 0.15], 'wood'),
  dirt: S([0.3, 0.23, 0.16], [0.12, 0.085, 0.055], 'soft'),
  sand: S([0.5, 0.42, 0.3], [0.42, 0.34, 0.22], 'soft'),
  grass: S([0.25, 0.22, 0.14], [0.1, 0.08, 0.04], 'soft'),
  glass: S([0.6, 0.62, 0.62], [0.8, 0.9, 0.88], 'glass'),
  fabric: S([0.34, 0.32, 0.27], [0.3, 0.28, 0.24], 'fiber'),
  cardboard: S([0.4, 0.31, 0.2], [0.45, 0.33, 0.2], 'fiber'),
  rubber: S([0.08, 0.08, 0.08], [0.05, 0.05, 0.05], 'fiber'),
  water: S([0.7, 0.72, 0.72], [0.7, 0.72, 0.72], 'water'),
  flesh: S([0.25, 0.01, 0.01], [0.2, 0.01, 0.01], 'flesh'),
  default: S([0.42, 0.41, 0.39], [0.36, 0.35, 0.33], 'hard'),
};

const _up = new THREE.Vector3(0, 1, 0);
const C_METAL_SMOKE = [0.22, 0.215, 0.21];
const C_METAL_CHIP = [0.2, 0.2, 0.2];
const C_WHITE = [1, 1, 1];
const C_WATER = [0.75, 0.77, 0.8];
const C_BLOOD = [0.075, 0.004, 0.0035];
const C_FLASH1 = [1, 0.8, 0.55];
const C_FLASH2 = [1, 0.6, 0.25];
const C_MUZZLE = [1, 0.7, 0.4];
const SOFT_SURF = new Set(['dirt', 'sand', 'grass', 'gravel']);
const _d = new THREE.Vector3();
const _r = new THREE.Vector3();
const _v = new THREE.Vector3();
const _o = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _sun = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _pc = [0, 0, 0];

export class Effects {
  constructor(ctx, { smoke, glow, debris, decals, lights, flashes }, rng) {
    this.ctx = ctx;
    this.smoke = smoke;
    this.glow = glow;
    this.debris = debris;
    this.decals = decals;
    this.lights = lights;
    this.flashes = flashes;
    this.rng = rng;
    this.quality = 1; // particle count multiplier
    this.sunDir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
    this._rayBudget = 8;
    this._lastSunVis = 1;
    this.emitters = [];
    for (let i = 0; i < 24; i++) {
      const em = { id: i, active: false, kind: '', pos: new THREE.Vector3(), radius: 1, duration: 0, age: 0, rate: 0, acc: 0, groundY: 0, sunVis: 1, gen: 0, handle: null, height: 0, intensity: 1 };
      em.handle = { type: '', emitter: em, generation: 0,
        get alive() { return this.emitter.active && this.emitter.gen === this.generation; },
        stop() { if (this.alive) this.emitter.duration = Math.min(this.emitter.duration, this.emitter.age); },
        setPosition(p) { if (this.alive) this.emitter.pos.copy(p); } };
      this.emitters.push(em);
    }
  }

  // ---------------------------------------------------------------------------------------------- helpers
  r(a, b) { return a + (b - a) * this.rng.next(); }
  frame(a, b) { return a + Math.floor(this.rng.next() * (b - a + 1)); }
  /** random unit vector into out */
  sphere(out) { return this.rng.onSphere(out); }
  /** random direction in a cone around axis (unit), half-angle in radians */
  cone(out, axis, half) {
    const cosT = 1 - this.rng.next() * (1 - Math.cos(half));
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = this.rng.next() * Math.PI * 2;
    if (Math.abs(axis.y) < 0.95) _t1.set(0, 1, 0).cross(axis).normalize(); else _t1.set(1, 0, 0).cross(axis).normalize();
    _t2.crossVectors(axis, _t1);
    return out.copy(axis).multiplyScalar(cosT).addScaledVector(_t1, Math.cos(phi) * sinT).addScaledVector(_t2, Math.sin(phi) * sinT);
  }
  n(count) { return Math.max(1, Math.round(count * this.quality)); }

  /** Direct-sun visibility at a point (world raycast towards the sun, budgeted per frame). */
  sunVis(p) {
    const world = this.ctx.services.world;
    if (!this.ctx.services.isProvided?.('world') || this._rayBudget <= 0) return this._lastSunVis;
    this._rayBudget--;
    _o.copy(p).addScaledVector(this.sunDir, 0.15);
    let hit = null;
    try { hit = world.raycast(_o, this.sunDir, 250); } catch { hit = null; }
    this._lastSunVis = hit ? 0 : 1;
    return this._lastSunVis;
  }

  groundAt(x, y, z) {
    try {
      const g = this.ctx.services.world.groundHeight(x, z, y + 0.25);
      return Number.isFinite(g) && g <= y + 0.3 ? g : y - 50;
    } catch { return 0; }
  }

  beginFrame() { this._rayBudget = 8; }

  _plane(p, n, pt) { p.pnx = n.x; p.pny = n.y; p.pnz = n.z; p.pd = n.x * pt.x + n.y * pt.y + n.z * pt.z; }

  // ---------------------------------------------------------------------------------------------- impacts
  /** Bullet impact. dir (optional) = incoming bullet direction. */
  impact(point, normal, surface, dir) {
    const def = SURF[surface] || SURF.default;
    if (def.kind === 'flesh') return this.blood(point, normal, dir);
    _n.copy(normal);
    if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
    _n.normalize();
    // incoming direction guess: the camera ray if the point is (nearly) on it
    if (dir && dir.lengthSq() > 1e-6) _d.copy(dir).normalize();
    else {
      this.ctx.camera.getWorldPosition(_camPos);
      this.ctx.camera.getWorldDirection(_camFwd);
      _d.copy(point).sub(_camPos).normalize();
      if (_d.dot(_camFwd) < 0.99) _d.copy(_n).negate();
    }
    if (_d.dot(_n) > -0.05) _d.addScaledVector(_n, -(_d.dot(_n) + 0.2)).normalize();
    _r.copy(_d).addScaledVector(_n, -2 * _d.dot(_n)).normalize(); // reflected
    const sv = this.sunVis(_p.copy(point).addScaledVector(_n, 0.2));
    const gy = this.groundAt(point.x, point.y + 0.02, point.z);
    const floorHit = _n.y > 0.7;

    switch (def.kind) {
      case 'metal': this._impactMetal(point, _n, _r, def, sv, gy); break;
      case 'wood': this._impactHard(point, _n, _r, def, sv, gy, 0.8, 'splinter'); break;
      case 'soft': this._impactSoft(point, _n, _r, def, sv, gy); break;
      case 'glass': this._impactGlass(point, _n, _r, def, sv, gy); break;
      case 'water': this._impactWater(point, _n, sv); break;
      case 'fiber': this._impactFiber(point, _n, _r, def, sv, gy); break;
      default: this._impactHard(point, _n, _r, def, sv, gy, def.puff || 1, 'chip', floorHit);
    }
  }

  _dustPuff(point, n, r, color, sv, count = 2, speed = 3.5, size = 0.55, life = 1.3, alpha = 0.55, f0 = 12, f1 = 15, up = 0.4, stretch = 0, spread = 0.55, drag = 0, soft = 0.08, e0 = 0) {
    for (let i = 0; i < count; i++) {
      const p = this.smoke.begin();
      p.x = point.x + n.x * 0.04; p.y = point.y + n.y * 0.04; p.z = point.z + n.z * 0.04;
      this.cone(_v, n, spread);
      const sp = speed * this.r(0.6, 1.2);
      p.vx = _v.x * sp + r.x * sp * 0.35; p.vy = _v.y * sp + r.y * sp * 0.35 + up; p.vz = _v.z * sp + r.z * sp * 0.35;
      p.drag = drag > 0 ? drag * this.r(0.85, 1.15) : this.r(4, 6);
      p.grav = -0.25;
      p.size0 = size * 0.12; p.size1 = size * this.r(0.8, 1.25); p.sizePow = 3.5;
      p.life = life * this.r(0.8, 1.25);
      p.alpha = alpha * this.r(0.8, 1.1);
      p.fadeIn = 0.015; p.fadeOut = 0.25;
      p.r = color[0]; p.g = color[1]; p.b = color[2];
      p.frame = this.frame(f0, f1);
      p.rot = this.r(0, 6.28); p.rotVel = this.r(-1.2, 1.2);
      p.erode = 0.85; p.erode0 = e0; p.seed = this.rng.next(); p.stretch = stretch;
      p.sunVis = sv; p.wind = 0.4; p.turb = 0.3;
      this._plane(p, n, point);
      p.soft = soft;
      this.smoke.commit();
    }
  }

  _linger(point, n, color, sv, size = 1.1, alpha = 0.18) {
    const p = this.smoke.begin();
    p.x = point.x + n.x * 0.15; p.y = point.y + n.y * 0.15; p.z = point.z + n.z * 0.15;
    p.vx = n.x * 0.35; p.vy = n.y * 0.35 + 0.06; p.vz = n.z * 0.35;
    p.drag = 2.0; p.grav = -0.03;
    p.size0 = size * 0.3; p.size1 = size * this.r(0.9, 1.3); p.sizePow = 2;
    p.life = this.r(2.4, 3.6);
    p.alpha = alpha; p.fadeIn = 0.1; p.fadeOut = 0.35;
    p.r = color[0] * 1.05; p.g = color[1] * 1.05; p.b = color[2] * 1.05;
    p.frame = this.frame(8, 15); p.rot = this.r(0, 6.28); p.rotVel = this.r(-0.3, 0.3);
    p.erode = 0.85; p.seed = this.rng.next(); p.sunVis = sv; p.wind = 1; p.turb = 0.2;
    this._plane(p, n, point); p.soft = 0.25;
    this.smoke.commit();
  }

  _grains(point, n, r, color, sv, gy, count, speed = 8, spread = 0.6, size = 0.012, stretch = 0.022) {
    for (let i = 0; i < count; i++) {
      const p = this.smoke.begin();
      p.x = point.x + n.x * 0.02; p.y = point.y + n.y * 0.02; p.z = point.z + n.z * 0.02;
      _v.copy(n).multiplyScalar(0.8).addScaledVector(r, 0.5).normalize();
      this.cone(_v, _v, spread);
      const sp = speed * this.r(0.5, 1.3);
      p.vx = _v.x * sp; p.vy = _v.y * sp; p.vz = _v.z * sp;
      p.grav = -9.8; p.drag = 1.2;
      p.size0 = p.size1 = size * this.r(0.7, 1.4);
      p.stretch = stretch;
      p.life = this.r(0.3, 0.6);
      p.alpha = 0.95; p.fadeIn = 0; p.fadeOut = 0.6;
      p.r = color[0] * 0.75; p.g = color[1] * 0.75; p.b = color[2] * 0.75;
      p.frame = -1; p.sunVis = sv; p.groundY = gy; p.fadeNear = 0.1;
      this.smoke.commit();
    }
  }

  _chips(pool, point, n, r, color, gy, count, sMin, sMax, speed = 3.5, life = 4) {
    const D = this.debris[pool];
    for (let i = 0; i < count; i++) {
      const s = D.begin();
      s.x = point.x + n.x * 0.02; s.y = point.y + n.y * 0.02; s.z = point.z + n.z * 0.02;
      _v.copy(n).addScaledVector(r, 0.4).normalize();
      this.cone(_v, _v, 0.8);
      const sp = speed * this.r(0.4, 1.3);
      s.vx = _v.x * sp; s.vy = _v.y * sp + this.r(0.5, 1.5); s.vz = _v.z * sp;
      s.ax = this.r(-40, 40); s.ay = this.r(-40, 40); s.az = this.r(-40, 40);
      this.sphere(_t1);
      _q.setFromAxisAngle(_t1, this.r(0, 6.28));
      s.qx = _q.x; s.qy = _q.y; s.qz = _q.z; s.qw = _q.w;
      const sc = this.r(sMin, sMax);
      s.sx = sc * this.r(0.7, 1.3); s.sy = sc * this.r(0.7, 1.3); s.sz = sc * this.r(0.7, 1.3);
      if (pool === 'splinters') { s.sx = sc * 0.25; s.sz = sc * 0.25; s.sy = sc * this.r(1.5, 3); }
      s.life = life * this.r(0.8, 1.3);
      s.groundY = gy;
      s.restitution = 0.25; s.friction = 0.5; s.drag = 0.3;
      const k = this.r(0.8, 1.15);
      s.r = color[0] * k; s.g = color[1] * k; s.b = color[2] * k;
      s.pnx = n.x; s.pny = n.y; s.pnz = n.z; s.pd = n.dot(point) - 0.01;
      if (n.y > 0.7) { s.pnx = s.pny = s.pnz = 0; }
      D.commit();
    }
  }

  _sparks(point, n, r, gy, count, speedMin = 4, speedMax = 14, spread = 0.9, intensity = 10) {
    for (let i = 0; i < count; i++) {
      const p = this.glow.begin();
      p.x = point.x + n.x * 0.01; p.y = point.y + n.y * 0.01; p.z = point.z + n.z * 0.01;
      _v.copy(r).multiplyScalar(0.65).addScaledVector(n, 0.45).normalize();
      this.cone(_v, _v, spread);
      const sp = this.r(speedMin, speedMax);
      p.vx = _v.x * sp; p.vy = _v.y * sp; p.vz = _v.z * sp;
      p.grav = -9.8; p.drag = this.r(0.8, 2.0);
      p.size0 = p.size1 = this.r(0.005, 0.009);
      p.stretch = this.r(0.018, 0.035);
      p.life = this.r(0.18, 0.6);
      p.r = intensity; p.g = intensity; p.b = intensity; p.alpha = 1;
      p.fadeIn = 0; p.fadeOut = 0.5;
      p.heat = 1; p.heatDecay = this.r(1.5, 3.5);
      p.frame = -2; p.groundY = gy; p.bounce = 0.35; p.fadeNear = 0.05;
      this.glow.commit();
    }
  }

  _glint(point, n, size, intensity, life = 0.05, frame = 12, color = null) {
    const p = this.glow.begin();
    p.x = point.x + n.x * 0.03; p.y = point.y + n.y * 0.03; p.z = point.z + n.z * 0.03;
    p.size0 = size * 0.6; p.size1 = size; p.sizePow = 2;
    p.life = life;
    p.r = intensity * (color ? color[0] : 1); p.g = intensity * (color ? color[1] : 0.72); p.b = intensity * (color ? color[2] : 0.42);
    p.alpha = 1; p.fadeIn = 0; p.fadeOut = 0.0;
    p.frame = frame; p.rot = this.r(0, 6.28); p.fadeNear = 0.05;
    this.glow.commit();
  }

  _impactHard(point, n, r, def, sv, gy, puff, chipPool, floor = false) {
    // fast directional jets of pulverised material (velocity-stretched), a small dense core, faint haze
    // pulverised material is paler than the intact surface
    const pc = _pc;
    pc[0] = Math.min(0.5, def.dust[0] * 1.02 + 0.015); pc[1] = Math.min(0.5, def.dust[1] * 1.02 + 0.015); pc[2] = Math.min(0.5, def.dust[2] * 1.02 + 0.012);
    // fast conical spray (streaked), then a slower billowing body, a small hot core and faint lingering haze
    const fl = floor ? 0.55 : 1; // floor hits: lower, wider fan instead of a vertical column
    // erode0: puffs start already broken up by noise (no solid 'cotton ball' silhouettes in the first frames)
    this._dustPuff(point, n, r, pc, sv, this.n(6), 8.5 * fl, 0.26 * puff, 0.45, 0.5, 8, 11, 0.1, 0.045, floor ? 0.9 : 0.42, 11, 0.22, 0.3);
    this._dustPuff(point, n, r, pc, sv, this.n(3), 2.4 * fl, 0.62 * puff, 1.5, 0.24, 8, 11, 0.12, 0.0, floor ? 1.2 : 0.9, 6, 0.25, 0.42);
    this._dustPuff(point, n, r, pc, sv, 1, 0.9, 0.14 * puff, 0.3, 0.42, 8, 11, 0.05, 0, 0.5, 6, 0.15, 0.25);
    this._linger(point, n, pc, sv, 0.9 * puff, 0.08);
    this._grains(point, n, r, def.chip, sv, gy, this.n(chipPool === 'splinter' ? 5 : 8));
    if (chipPool === 'splinter') this._chips('splinters', point, n, r, def.chip, gy, this.n(this.frame(3, 6)), 0.018, 0.045, 3.5, 5);
    else this._chips(floor ? 'chips' : 'chips', point, n, r, def.chip, gy, this.n(this.frame(3, 6)), 0.004, 0.011, 3.2, 4);
    if (chipPool === 'chip' && this.rng.next() < 0.35) {
      this._sparks(point, n, r, gy, this.frame(1, 3), 4, 10, 0.7, 7);
      this._glint(point, n, 0.07, 5, 0.04);
    }
  }

  _impactMetal(point, n, r, def, sv, gy) {
    this._glint(point, n, 0.28, 14, 0.055);
    this._glint(point, n, 0.12, 8, 0.03, 13);
    this._sparks(point, n, r, gy, this.n(this.frame(10, 18)));
    this._dustPuff(point, n, r, C_METAL_SMOKE, sv, 1, 2.5, 0.3, 0.9, 0.35, 8, 11);
    this._chips('chips', point, n, r, C_METAL_CHIP, gy, this.frame(0, 2), 0.003, 0.006, 3, 2);
    _p.copy(point).addScaledVector(n, 0.15);
    this.lights.flash(1, _p, 0xffb070, 2.2, 3.5, 0.07);
  }

  _impactSoft(point, n, r, def, sv, gy) {
    // dirt kick: heavy puffs thrown up, clods, dark grains
    for (let i = 0; i < this.n(3); i++) {
      const p = this.smoke.begin();
      p.x = point.x + n.x * 0.03; p.y = point.y + n.y * 0.03; p.z = point.z + n.z * 0.03;
      _v.copy(n).addScaledVector(_up, 0.6).addScaledVector(r, 0.4).normalize();
      this.cone(_v, _v, 0.7);
      const sp = this.r(2.5, 5.5);
      p.vx = _v.x * sp; p.vy = _v.y * sp; p.vz = _v.z * sp;
      p.drag = this.r(2.5, 3.5); p.grav = -3.5;
      p.size0 = 0.1; p.size1 = this.r(0.5, 0.8); p.sizePow = 3;
      p.life = this.r(0.9, 1.5);
      p.alpha = this.r(0.4, 0.55); p.fadeIn = 0.02; p.fadeOut = 0.3;
      p.r = def.dust[0] * 0.8; p.g = def.dust[1] * 0.8; p.b = def.dust[2] * 0.8;
      p.r1 = def.dust[0]; p.g1 = def.dust[1]; p.b1 = def.dust[2];
      p.frame = this.frame(8, 11); p.rot = this.r(0, 6.28); p.rotVel = this.r(-1, 1);
      p.erode = 0.8; p.seed = this.rng.next(); p.sunVis = sv; p.wind = 0.3;
      this._plane(p, n, point); p.soft = 0.1;
      this.smoke.commit();
    }
    this._linger(point, n, def.dust, sv, 1.2, 0.2);
    this._grains(point, n, _up, def.chip, sv, gy, this.n(10), 7, 0.5, 0.014, 0.03);
    this._chips('clods', point, n, _up, def.chip, gy, this.n(this.frame(3, 6)), 0.005, 0.012, 3, 3);
  }

  _impactGlass(point, n, r, def, sv, gy) {
    this._chips('shards', point, n, r, C_WHITE, gy, this.n(this.frame(6, 10)), 0.008, 0.028, 2.5, 4);
    // also shards falling out of the back side
    _t2.copy(n).negate();
    this._chips('shards', point, _t2, _d, C_WHITE, gy, this.n(this.frame(3, 5)), 0.008, 0.02, 1.5, 4);
    this._dustPuff(point, n, r, def.dust, sv, 1, 2, 0.25, 0.7, 0.25);
    for (let i = 0; i < 3; i++) {
      _p.copy(point); this.sphere(_v); _p.addScaledVector(_v, 0.04);
      this._glint(_p, n, this.r(0.03, 0.07), 6, this.r(0.04, 0.12), 13, C_WHITE);
    }
  }

  _impactWater(point, n, sv) {
    for (let i = 0; i < this.n(14); i++) {
      const p = this.smoke.begin();
      p.x = point.x; p.y = point.y + 0.01; p.z = point.z;
      this.cone(_v, _up, 0.45);
      const sp = this.r(2, 6);
      p.vx = _v.x * sp; p.vy = _v.y * sp; p.vz = _v.z * sp;
      p.grav = -9.8; p.drag = 0.5;
      p.size0 = p.size1 = this.r(0.008, 0.02); p.stretch = 0.03;
      p.life = this.r(0.35, 0.8); p.alpha = 0.8; p.fadeIn = 0; p.fadeOut = 0.7;
      p.r = 0.75; p.g = 0.78; p.b = 0.8; p.frame = -1; p.sunVis = sv; p.groundY = point.y - 0.05;
      this.smoke.commit();
    }
    this._dustPuff(point, n, n, C_WATER, sv, 1, 1.5, 0.4, 0.8, 0.3, 8, 11);
  }

  _impactFiber(point, n, r, def, sv, gy) {
    this._dustPuff(point, n, r, def.dust, sv, 1, 2.5, 0.3, 0.9, 0.45);
    this._grains(point, n, r, def.chip, sv, gy, this.n(4), 4, 0.8, 0.008, 0.015);
  }

  // ---------------------------------------------------------------------------------------------- blood
  blood(point, normal, direction) {
    _n.copy(normal); if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0); _n.normalize();
    if (direction && direction.lengthSq() > 1e-6) _d.copy(direction).normalize(); else _d.copy(_n).negate();
    const sv = this.sunVis(point);
    const gy = this.groundAt(point.x, point.y, point.z);
    const col = C_BLOOD;
    // mist along the bullet direction (exit spray) + a smaller puff back towards the shooter
    for (let i = 0; i < this.n(4); i++) {
      const back = i === 3;
      const p = this.smoke.begin();
      p.x = point.x; p.y = point.y; p.z = point.z;
      this.cone(_v, _d, 0.45);
      const sp = back ? -this.r(0.8, 1.5) : this.r(1.5, 3.2);
      p.vx = _v.x * sp; p.vy = _v.y * sp + 0.1; p.vz = _v.z * sp;
      p.drag = 6; p.grav = -0.8;
      p.size0 = 0.06; p.size1 = back ? this.r(0.2, 0.3) : this.r(0.4, 0.65); p.sizePow = 4;
      p.life = this.r(0.3, 0.5);
      p.alpha = back ? 0.4 : 0.55; p.fadeIn = 0.01; p.fadeOut = 0.1;
      p.r = col[0] * 1.3; p.g = col[1]; p.b = col[2];
      p.r1 = col[0] * 0.9; p.g1 = col[1] * 0.9; p.b1 = col[2] * 0.9;
      p.frame = this.frame(8, 11); p.rot = this.r(0, 6.28); p.rotVel = this.r(-2, 2);
      p.erode = 0.95; p.seed = this.rng.next(); p.sunVis = sv; p.fadeNear = 0.3;
      this.smoke.commit();
    }
    for (let i = 0; i < this.n(10); i++) {
      const p = this.smoke.begin();
      p.x = point.x; p.y = point.y; p.z = point.z;
      this.cone(_v, _d, 0.6);
      const sp = this.r(1.5, 5);
      p.vx = _v.x * sp; p.vy = _v.y * sp + this.r(0.3, 1.5); p.vz = _v.z * sp;
      p.grav = -9.8; p.drag = 0.8;
      p.size0 = p.size1 = this.r(0.006, 0.014); p.stretch = 0.02;
      p.life = this.r(0.35, 0.7); p.alpha = 1; p.fadeIn = 0; p.fadeOut = 0.7;
      p.r = col[0] * 0.8; p.g = col[1] * 0.6; p.b = col[2] * 0.6; p.frame = -1; p.sunVis = sv; p.groundY = gy; p.fadeNear = 0.1;
      this.smoke.commit();
    }
    // splatter on the surface behind the target
    if (this.decals.enabled && this.rng.next() < 0.85 && this.ctx.services.isProvided?.('world')) {
      _o.copy(point).addScaledVector(_d, 0.05);
      let hit = null;
      try { hit = this.ctx.services.world.raycast(_o, _d, 2.6); } catch { hit = null; }
      if (hit) {
        const size = 0.45 + Math.min(hit.distance, 2.6) * 0.25;
        if (!this.decalDedupe || !this.decalDedupe('decal_blood', hit.point, 0.45)) this.decals.blood(hit.point, hit.normal, _d, size);
      } else if (gy > point.y - 2.2) {
        _p.set(point.x + _d.x * 0.8, gy, point.z + _d.z * 0.8);
        this.decals.blood(_p, _up, _d, 0.5, 5);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------- explosion
  explosion(position, radius = 6, surfaceHint = null) {
    const S = Math.min(2, Math.max(0.5, radius / 6));
    const gy = this.groundAt(position.x, position.y + 0.5, position.z);
    const onGround = position.y - gy < 1.2;
    _o.set(position.x, Math.max(position.y, gy + 0.05), position.z);
    const baseX = _o.x, baseY = _o.y, baseZ = _o.z;
    const sv = this.sunVis(_p.set(baseX, baseY + 2, baseZ));
    // what are we standing on? (dust colour, scorch type)
    let surf = surfaceHint;
    if (!surf && onGround && this.ctx.services.isProvided?.('world')) {
      try {
        _t2.set(baseX, baseY + 0.5, baseZ);
        const hit = this.ctx.services.world.raycast(_t2, _v.set(0, -1, 0), 3);
        if (hit) surf = hit.surface;
      } catch { /* ignore */ }
    }
    const def = SURF[surf] || SURF.concrete;
    const soft = SOFT_SURF.has(surf);
    // dust = pulverised ground mixed with soot; a touch warmer/browner than the raw surface
    const dr = def.dust[0] * 0.8 + 0.03, dg = def.dust[1] * 0.76 + 0.02, db = def.dust[2] * 0.7 + 0.01;
    const E = (p) => { p.pnx = 0; p.pny = 1; p.pnz = 0; p.pd = gy; };

    // ---- 1. flash + light (1-3 frames)
    _p.set(baseX, baseY + 0.7 * S, baseZ);
    this._glint(_p, _up, 3.6 * S, 18, 0.06, 12, C_FLASH1);
    this._glint(_p, _up, 1.5 * S, 34, 0.035, 14, C_WHITE);
    _p.set(baseX, baseY + 1.2 * S, baseZ);
    this.lights.flash(2, _p, 0xff9a4a, 520 * S, 32 * S, 0.5, 0.35);

    // ---- 2. fireball: a violent ground-hugging burst that cools into dark smoke in place
    for (let i = 0; i < this.n(12); i++) {
      const p = this.smoke.begin();
      this.sphere(_v); _v.y = Math.abs(_v.y) * 0.7 + 0.15; _v.normalize();
      p.x = baseX + _v.x * 0.35 * S; p.y = baseY + (0.4 + _v.y * 0.45) * S; p.z = baseZ + _v.z * 0.35 * S;
      const sp = this.r(3, 7.5) * S;
      p.vx = _v.x * sp; p.vy = _v.y * sp; p.vz = _v.z * sp;
      p.drag = this.r(5, 7); p.grav = 0.6;
      p.size0 = 1.2 * S; p.size1 = this.r(2.8, 3.8) * S; p.sizePow = 4;
      p.life = this.r(2.2, 3.4);
      p.alpha = 1; p.fadeIn = 0.003; p.fadeOut = 0.3;
      p.r = 0.045; p.g = 0.042; p.b = 0.04; p.r1 = dr * 0.42; p.g1 = dg * 0.41; p.b1 = db * 0.4;
      p.heat = this.r(1.1, 1.35); p.heatDecay = this.r(1.9, 2.8);
      p.frame = this.frame(0, 7); p.rot = this.r(0, 6.28); p.rotVel = this.r(-0.8, 0.8);
      p.erode = 0.45; p.seed = this.rng.next(); p.sunVis = sv; p.wind = 0.3; p.turb = 0.8;
      if (onGround) E(p);
      p.soft = 0.6 * S; p.fadeNear = 1.0;
      this.smoke.commit();
    }
    // additive fire burst sprites (turbulent fireball frame) for the first ~0.2 s: the searing core
    for (let i = 0; i < this.n(7); i++) {
      const p = this.glow.begin();
      this.sphere(_v); _v.y = Math.abs(_v.y) * 0.6 + 0.2; _v.normalize();
      p.x = baseX + _v.x * 0.35 * S; p.y = baseY + (0.45 + _v.y * 0.4) * S; p.z = baseZ + _v.z * 0.35 * S;
      const sp = this.r(3, 7) * S;
      p.vx = _v.x * sp; p.vy = _v.y * sp; p.vz = _v.z * sp; p.drag = 6;
      p.size0 = 1.2 * S; p.size1 = this.r(2.6, 3.4) * S; p.sizePow = 3;
      p.life = this.r(0.2, 0.34);
      p.r = 7; p.g = 2.9; p.b = 0.8; p.alpha = 1; p.fadeIn = 0; p.fadeOut = 0.25;
      p.frame = 15; p.rot = this.r(0, 6.28); p.rotVel = this.r(-2, 2); p.fadeNear = 1.0;
      if (onGround) E(p);
      p.soft = 0.5 * S;
      this.glow.commit();
    }
    // ---- 3. dirt crown: fast dark jets thrown up and out (velocity-stretched), falling back under gravity
    if (onGround) {
      for (let i = 0; i < this.n(26); i++) {
        const p = this.smoke.begin();
        this.cone(_v, _up, 0.85);
        p.x = baseX + _v.x * 0.2; p.y = baseY + 0.1; p.z = baseZ + _v.z * 0.2;
        const sp = this.r(6, 13) * Math.sqrt(S);
        p.vx = _v.x * sp; p.vy = _v.y * sp; p.vz = _v.z * sp;
        p.grav = -9.8; p.drag = this.r(1.2, 2.0);
        p.size0 = p.size1 = this.r(0.05, 0.14) * S; p.stretch = this.r(0.05, 0.1);
        p.life = this.r(0.8, 1.5); p.alpha = 0.95; p.fadeIn = 0; p.fadeOut = 0.45;
        p.r = def.chip[0] * 0.45; p.g = def.chip[1] * 0.42; p.b = def.chip[2] * 0.4;
        p.frame = -1; p.sunVis = sv; p.groundY = gy; p.fadeNear = 0.3;
        this.smoke.commit();
      }
    }
    // ---- 4. dust column: heavy pulverised ground thrown up in a cone, billowing and slumping back
    for (let i = 0; i < this.n(18); i++) {
      const p = this.smoke.begin();
      this.cone(_v, _up, onGround ? 0.6 : 1.4);
      p.x = baseX + _v.x * 0.4 * S; p.y = baseY + 0.3 * S; p.z = baseZ + _v.z * 0.4 * S;
      const sp = this.r(5, 13) * S;
      p.vx = _v.x * sp; p.vy = _v.y * sp; p.vz = _v.z * sp;
      p.drag = this.r(2.4, 3.4); p.grav = -1.2;
      p.size0 = 0.7 * S; p.size1 = this.r(2.8, 4.2) * S; p.sizePow = 2.6;
      p.life = this.r(4, 6.5); p.delay = this.r(0.01, 0.07);
      p.alpha = this.r(0.7, 0.9); p.fadeIn = 0.02; p.fadeOut = 0.35;
      const k = this.r(0.85, 1.1);
      p.r = dr * 0.55 * k; p.g = dg * 0.55 * k; p.b = db * 0.55 * k; p.r1 = dr * 1.05; p.g1 = dg * 1.05; p.b1 = db * 1.05;
      p.frame = this.frame(12, 15); p.rot = this.r(0, 6.28); p.rotVel = this.r(-0.4, 0.4);
      p.erode = 0.6; p.seed = this.rng.next(); p.sunVis = sv; p.wind = 0.5; p.turb = 0.5;
      if (onGround) E(p);
      p.soft = 0.8 * S; p.fadeNear = 1.0;
      this.smoke.commit();
    }
    // ---- 5. ground surge: dust ring racing out along the ground (reads as the shockwave)
    if (onGround) {
      const ringN = this.n(20);
      for (let i = 0; i < ringN; i++) {
        const a = (i / ringN) * Math.PI * 2 + this.r(-0.12, 0.12);
        const p = this.smoke.begin();
        const cx = Math.cos(a), cz = Math.sin(a);
        p.x = baseX + cx * 0.5 * S; p.y = gy + 0.2 * S; p.z = baseZ + cz * 0.5 * S;
        const sp = this.r(9, 15) * S;
        p.vx = cx * sp; p.vy = this.r(0.3, 1.0); p.vz = cz * sp;
        p.drag = this.r(3.2, 4.2); p.grav = 0.05;
        p.size0 = 0.6 * S; p.size1 = this.r(2.2, 3.2) * S; p.sizePow = 3;
        p.life = this.r(2.8, 4.5); p.alpha = this.r(0.28, 0.4); p.fadeIn = 0.02; p.fadeOut = 0.3;
        p.r = dr * 0.85; p.g = dg * 0.85; p.b = db * 0.85;
        p.frame = this.frame(12, 15); p.rot = this.r(0, 6.28); p.rotVel = this.r(-0.4, 0.4);
        p.erode = 0.7; p.seed = this.rng.next(); p.sunVis = sv; p.wind = 0.7; p.turb = 0.3;
        E(p); p.soft = 0.45 * S; p.fadeNear = 0.8;
        this.smoke.commit();
      }
    }
    // ---- 6. debris: clods / chunks of the surface plus fine grit
    _p.set(baseX, baseY + 0.15, baseZ);
    for (let i = 0; i < this.n(22); i++) {
      const D = this.debris.clods;
      const s = D.begin();
      this.cone(_v, _up, 1.15);
      s.x = _p.x + _v.x * 0.2; s.y = _p.y + 0.1; s.z = _p.z + _v.z * 0.2;
      const sp = this.r(4, 14) * Math.sqrt(S);
      s.vx = _v.x * sp; s.vy = _v.y * sp; s.vz = _v.z * sp;
      s.ax = this.r(-20, 20); s.ay = this.r(-20, 20); s.az = this.r(-20, 20);
      const sc = this.r(0.012, 0.045) * S;
      s.sx = sc; s.sy = sc * this.r(0.6, 1); s.sz = sc * this.r(0.7, 1.2);
      s.life = this.r(6, 10); s.groundY = gy; s.restitution = 0.2; s.friction = 0.45; s.drag = 0.15;
      const k = this.r(0.6, 1.0);
      const c = soft ? def.chip : def.dust;
      s.r = c[0] * k; s.g = c[1] * k; s.b = c[2] * k;
      D.commit();
    }
    this._grains(_p, _up, _up, def.chip, sv, gy, this.n(20), 11, 1.0, 0.018, 0.03);
    // ---- 7. sparks / burning fragments
    for (let i = 0; i < this.n(48); i++) {
      const p = this.glow.begin();
      this.cone(_v, _up, 1.45);
      p.x = baseX; p.y = baseY + 0.35 * S; p.z = baseZ;
      const sp = this.r(12, 38) * Math.sqrt(S);
      p.vx = _v.x * sp; p.vy = _v.y * sp; p.vz = _v.z * sp;
      p.grav = -9.8; p.drag = this.r(1.8, 3.2);
      p.size0 = p.size1 = this.r(0.008, 0.016); p.stretch = this.r(0.02, 0.04);
      p.life = this.r(0.25, 0.9); p.r = p.g = p.b = 14; p.alpha = 1; p.fadeIn = 0; p.fadeOut = 0.4;
      p.heat = 1; p.heatDecay = this.r(1.5, 3); p.frame = -2; p.groundY = gy; p.bounce = 0.3; p.fadeNear = 0.1;
      this.glow.commit();
    }
    for (let i = 0; i < this.n(14); i++) {
      const p = this.glow.begin();
      this.cone(_v, _up, 1.0);
      p.x = baseX + _v.x * 0.6 * S; p.y = baseY + (0.3 + this.r(0, 0.8)) * S; p.z = baseZ + _v.z * 0.6 * S;
      const sp = this.r(2, 6);
      p.vx = _v.x * sp; p.vy = _v.y * sp; p.vz = _v.z * sp;
      p.grav = -1.5; p.drag = 1.4; p.turb = 3; p.seed = this.rng.next(); p.wind = 0.8;
      p.size0 = p.size1 = this.r(0.01, 0.02);
      p.life = this.r(1.2, 2.8); p.r = 9; p.g = 3.2; p.b = 0.7; p.alpha = 1; p.fadeIn = 0.05; p.fadeOut = 0.5;
      p.flicker = 0.6; p.frame = -1; p.groundY = gy;
      this.glow.commit();
    }
    // ---- 8. lingering smoke + dust haze that rises slowly and drifts off with the wind
    for (let i = 0; i < this.n(10); i++) {
      const p = this.smoke.begin();
      this.sphere(_v); _v.y = Math.abs(_v.y);
      p.x = baseX + _v.x * 1.0 * S; p.y = baseY + (0.6 + _v.y * 1.4) * S; p.z = baseZ + _v.z * 1.0 * S;
      p.vx = _v.x * 0.5; p.vy = this.r(0.3, 0.9); p.vz = _v.z * 0.5;
      p.drag = 0.6; p.grav = 0.12;
      p.size0 = 1.6 * S; p.size1 = this.r(3.8, 5.5) * S; p.sizePow = 1.6;
      p.life = this.r(9, 14); p.delay = this.r(0.35, 1.0);
      p.alpha = this.r(0.3, 0.45); p.fadeIn = 0.1; p.fadeOut = 0.4;
      const grey = i % 3 === 0;
      if (grey) { p.r = 0.14; p.g = 0.135; p.b = 0.13; p.r1 = 0.3; p.g1 = 0.29; p.b1 = 0.28; }
      else { p.r = dr * 0.8; p.g = dg * 0.8; p.b = db * 0.8; p.r1 = dr; p.g1 = dg; p.b1 = db; }
      p.frame = this.frame(8, 15); p.rot = this.r(0, 6.28); p.rotVel = this.r(-0.15, 0.15);
      p.erode = 0.7; p.seed = this.rng.next(); p.sunVis = sv; p.wind = 1; p.turb = 0.35; p.fadeNear = 1.5;
      if (onGround) E(p);
      p.soft = 1.0 * S;
      this.smoke.commit();
    }
    // ---- 9. scorch
    if (onGround && this.decals.enabled) {
      _p.set(baseX, gy, baseZ);
      if (!this.decalDedupe || !this.decalDedupe('decal_scorch', _p, 1.2)) this.decals.scorch(_p, _up, 3.0 * S, soft);
    }
  }

  // ---------------------------------------------------------------------------------------------- tracer
  tracer(from, to, speed = 520, length = 3.2, startOffset = 1.6, width = 0.011, intensity = 14) {
    _d.copy(to).sub(from);
    const dist = _d.length();
    if (dist < startOffset + 1) return;
    _d.divideScalar(dist);
    const p = this.glow.begin();
    p.x = from.x + _d.x * startOffset; p.y = from.y + _d.y * startOffset; p.z = from.z + _d.z * startOffset;
    p.vx = _d.x * speed; p.vy = _d.y * speed; p.vz = _d.z * speed;
    p.size0 = p.size1 = width;
    p.stretch = length / speed;
    p.life = (dist - startOffset) / speed;
    p.r = intensity; p.g = intensity * 0.72; p.b = intensity * 0.42; p.alpha = 1; p.fadeIn = 0; p.fadeOut = 1;
    p.frame = -2; p.fadeNear = 0.5;
    this.glow.commit();
  }

  // ---------------------------------------------------------------------------------------------- shells
  shell(anchorWorld, objQuat, weaponClass, playerVel, vmScale = 1) {
    const pool = weaponClass === 'pistol' ? this.debris.shellsPistol : this.debris.shellsRifle;
    _right.set(1, 0, 0).applyQuaternion(objQuat);
    _t1.set(0, 1, 0).applyQuaternion(objQuat);
    _fwd.set(0, 0, -1).applyQuaternion(objQuat);
    const s = pool.begin();
    s.x = anchorWorld.x; s.y = anchorWorld.y; s.z = anchorWorld.z;
    const side = this.r(1.7, 2.6), up = this.r(1.2, 2.0), back = this.r(0.1, 0.6);
    s.vx = _right.x * side + _t1.x * up - _fwd.x * back + (playerVel ? playerVel.x : 0);
    s.vy = _right.y * side + _t1.y * up - _fwd.y * back + (playerVel ? playerVel.y * 0.5 : 0);
    s.vz = _right.z * side + _t1.z * up - _fwd.z * back + (playerVel ? playerVel.z : 0);
    // spin mostly end-over-end around the object's up axis plus some wobble
    const spin = this.r(18, 32);
    s.ax = _t1.x * spin + _fwd.x * this.r(-8, 8); s.ay = _t1.y * spin + _fwd.y * this.r(-8, 8); s.az = _t1.z * spin + _fwd.z * this.r(-8, 8);
    _q2.setFromAxisAngle(_v.set(1, 0, 0), -Math.PI / 2);
    _q.copy(objQuat).multiply(_q2);
    s.qx = _q.x; s.qy = _q.y; s.qz = _q.z; s.qw = _q.w;
    s.sx = s.sy = s.sz = 1;
    if (vmScale < 0.99) { s.s0 = vmScale; s.growT = 0.35; }
    s.life = this.r(9, 12);
    s.groundY = this.groundAt(anchorWorld.x, anchorWorld.y, anchorWorld.z);
    s.restitution = this.r(0.3, 0.42); s.friction = 0.55; s.drag = 0.15;
    s.r = s.g = s.b = 1;
    s.meta = weaponClass === 'pistol' ? 1 : 0;
    pool.commit();
    // wisp of smoke from the port
    const p = this.smoke.begin();
    p.x = anchorWorld.x; p.y = anchorWorld.y; p.z = anchorWorld.z;
    p.vx = _right.x * 0.4; p.vy = 0.35; p.vz = _right.z * 0.4;
    p.drag = 2; p.grav = 0.2; p.size0 = 0.02; p.size1 = 0.12; p.life = 0.7; p.alpha = 0.12;
    p.fadeIn = 0.05; p.fadeOut = 0.3; p.r = p.g = p.b = 0.55; p.frame = this.frame(8, 11); p.rot = this.r(0, 6.28);
    p.erode = 0.8; p.seed = this.rng.next(); p.fadeNear = 0.05; p.wind = 0.2;
    this.smoke.commit();
  }

  /** Smoke from the muzzle after a shot (world space). */
  muzzleSmoke(pos, dir, scale = 1, sv = 1) {
    for (let i = 0; i < 2; i++) {
      const p = this.smoke.begin();
      p.x = pos.x + dir.x * 0.05; p.y = pos.y + dir.y * 0.05; p.z = pos.z + dir.z * 0.05;
      const sp = this.r(0.8, 2.2) * (i === 0 ? 1 : 0.5);
      p.vx = dir.x * sp; p.vy = dir.y * sp + 0.15; p.vz = dir.z * sp;
      p.drag = 3; p.grav = 0.25;
      p.size0 = 0.03 * scale; p.size1 = this.r(0.18, 0.3) * scale; p.sizePow = 2.5;
      p.life = this.r(0.6, 1.1); p.alpha = 0.13; p.fadeIn = 0.05; p.fadeOut = 0.3;
      p.r = p.g = p.b = 0.5;
      p.frame = this.frame(8, 11); p.rot = this.r(0, 6.28); p.rotVel = this.r(-1, 1);
      p.erode = 0.85; p.seed = this.rng.next(); p.sunVis = sv; p.fadeNear = 0.25; p.wind = 0.5;
      this.smoke.commit();
    }
  }

  /** AI / third-person muzzle glow sprites in world space. */
  muzzleGlow(pos, dir, scale = 1) {
    // Camera-facing hot core so distant third-person flashes still read (the rig's planar petals/plumes carry
    // the shape up close). A flower frame only when the shooter faces the camera.
    this.ctx.camera.getWorldPosition(_camPos);
    _t1.copy(_camPos).sub(pos).normalize();
    const facing = _t1.dot(dir);
    _p.copy(pos).addScaledVector(dir, 0.05 * scale);
    this._glint(_p, dir, 0.16 * scale, 9, 0.04, 12, C_MUZZLE);
    if (facing > 0.6) this._glint(_p, dir, 0.32 * scale * facing, 7, 0.035, this.frame(0, 3), C_MUZZLE);
  }

  // ---------------------------------------------------------------------------------------------- dust
  dust(position, scale = 1) {
    const gy = this.groundAt(position.x, position.y + 0.2, position.z);
    const sv = this.sunVis(position);
    for (let i = 0; i < this.n(3); i++) {
      const p = this.smoke.begin();
      this.sphere(_v); _v.y = Math.abs(_v.y) * 0.3;
      p.x = position.x + _v.x * 0.2; p.y = Math.max(gy, position.y) + 0.1; p.z = position.z + _v.z * 0.2;
      p.vx = _v.x * 1.2 * scale; p.vy = this.r(0.1, 0.4); p.vz = _v.z * 1.2 * scale;
      p.drag = 2.5; p.grav = 0;
      p.size0 = 0.15 * scale; p.size1 = this.r(0.6, 0.9) * scale;
      p.life = this.r(1.2, 2); p.alpha = 0.3; p.fadeIn = 0.05; p.fadeOut = 0.3;
      p.r = 0.36; p.g = 0.31; p.b = 0.24;
      p.frame = this.frame(12, 15); p.rot = this.r(0, 6.28); p.erode = 0.8; p.seed = this.rng.next(); p.sunVis = sv; p.wind = 0.6;
      p.pnx = 0; p.pny = 1; p.pnz = 0; p.pd = gy; p.soft = 0.15;
      this.smoke.commit();
    }
  }

  // ---------------------------------------------------------------------------------------------- emitters
  startEmitter(kind, position, radius = 5, duration = 20, rate = 3, intensity = 1, height = 0) {
    let em = null;
    for (const e of this.emitters) if (!e.active) { em = e; break; }
    if (!em) {
      em = this.emitters[0];
      for (const e of this.emitters) if (e.age / Math.max(e.duration, 1e-3) > em.age / Math.max(em.duration, 1e-3)) em = e;
    }
    em.active = true; em.kind = kind; em.pos.copy(position); em.radius = radius; em.duration = duration;
    em.age = 0; em.rate = rate; em.acc = 0; em.height = height; em.intensity = intensity;
    em.groundY = this.groundAt(position.x, position.y + 0.5, position.z);
    em.sunVis = this.sunVis(_p.copy(position).addScaledVector(_up, 1.5));
    em.gen++;
    em.handle.type = kind;
    em.handle.generation = em.gen;
    if (kind === 'smoke') this._smokeBurst(em);
    return em.handle;
  }

  _smokeBurst(em) {
    // the canister pops: a quick dense ground-hugging puff that spreads out, then the plume takes over
    for (let i = 0; i < this.n(8); i++) {
      const p = this.smoke.begin();
      this.cone(_v, _up, 1.2);
      p.x = em.pos.x; p.y = em.groundY + 0.25; p.z = em.pos.z;
      const sp = this.r(2, 4.5);
      p.vx = _v.x * sp; p.vy = _v.y * sp * 0.5; p.vz = _v.z * sp;
      p.drag = 1.6; p.grav = 0.05;
      p.size0 = 0.5; p.size1 = this.r(2.2, 3.2); p.sizePow = 2.5; p.life = this.r(9, 13);
      p.alpha = 0.75; p.fadeIn = 0.03; p.fadeOut = 0.5;
      const k = this.r(0.95, 1.05);
      p.r = 0.64 * k; p.g = 0.64 * k; p.b = 0.63 * k;
      p.frame = this.frame(12, 15); p.rot = this.r(0, 6.28); p.rotVel = this.r(-0.25, 0.25);
      p.erode = 0.45; p.seed = this.rng.next(); p.sunVis = em.sunVis; p.wind = 0.4; p.turb = 0.3;
      p.pnx = 0; p.pny = 1; p.pnz = 0; p.pd = em.groundY; p.soft = 0.8; p.fadeNear = 1.4;
      this.smoke.commit();
    }
  }

  updateEmitters(dt) {
    for (const em of this.emitters) {
      if (!em.active) continue;
      em.age += dt;
      const kind = em.kind;
      const lingering = kind === 'smoke' ? 14 : kind === 'fire' ? 2 : 0;
      if (em.age > em.duration + lingering) { em.active = false; continue; }
      if (em.age > em.duration) continue;
      let rate = em.rate;
      if (kind === 'smoke') rate *= em.age < em.duration * 0.7 ? 1 : 0.35;
      em.acc += dt * rate * this.quality;
      while (em.acc >= 1) {
        em.acc -= 1;
        if (kind === 'smoke') this._emitSmoke(em);
        else if (kind === 'column') this._emitColumn(em);
        else if (kind === 'fire') this._emitFire(em);
        else if (kind === 'embers') this._emitEmber(em, em.pos);
      }
    }
  }

  _emitSmoke(em) {
    // continuous canister output: puffs leave the source with some push, roll outwards along the ground and
    // rise slowly; big soft sprites (dust/wisp frames) with low per-sprite alpha overlap into a dense volume
    const p = this.smoke.begin();
    const R = em.radius;
    this.sphere(_v); _v.y = Math.abs(_v.y) * 0.4;
    const young = Math.min(1, em.age / 6);
    p.x = em.pos.x + _v.x * 0.25; p.y = em.groundY + 0.35; p.z = em.pos.z + _v.z * 0.25;
    const sp = this.r(0.5, 1.1) * R * (0.35 + 0.25 * young);
    p.vx = _v.x * sp; p.vy = this.r(0.25, 0.7); p.vz = _v.z * sp;
    p.drag = this.r(0.35, 0.55); p.grav = this.r(0.0, 0.04);
    p.size0 = 0.9; p.size1 = this.r(0.6, 0.9) * R; p.sizePow = 2.0;
    p.life = this.r(11, 16);
    p.alpha = this.r(0.65, 0.85); p.fadeIn = 0.05; p.fadeOut = 0.55;
    const k = this.r(0.93, 1.05);
    p.r = 0.6 * k; p.g = 0.6 * k; p.b = 0.6 * k;
    p.frame = this.rng.next() < 0.7 ? this.frame(12, 15) : this.frame(8, 11);
    p.rot = this.r(0, 6.28); p.rotVel = this.r(-0.12, 0.12);
    p.erode = 0.4; p.seed = this.rng.next(); p.wind = 0.35; p.turb = 0.3;
    p.sunVis = this.sunVis(_p.set(p.x, p.y + 1.5, p.z));
    p.pnx = 0; p.pny = 1; p.pnz = 0; p.pd = em.groundY; p.soft = 0.9; p.fadeNear = 1.6;
    this.smoke.commit();
  }

  _emitColumn(em) {
    const p = this.smoke.begin();
    const R = em.radius;
    this.sphere(_v);
    p.x = em.pos.x + _v.x * R * 0.3; p.y = em.pos.y + this.r(0, 2); p.z = em.pos.z + _v.z * R * 0.3;
    p.vx = _v.x * 0.5; p.vy = this.r(3, 5) * em.intensity; p.vz = _v.z * 0.5;
    p.drag = 0.12; p.grav = 0.05;
    p.size0 = R * 0.8; p.size1 = R * this.r(5, 8); p.sizePow = 1.3;
    p.life = this.r(22, 30);
    p.alpha = 0.85; p.fadeIn = 0.03; p.fadeOut = 0.45;
    p.r = 0.03; p.g = 0.028; p.b = 0.026; p.r1 = 0.22; p.g1 = 0.21; p.b1 = 0.2;
    p.frame = this.frame(0, 11); p.rot = this.r(0, 6.28); p.rotVel = this.r(-0.05, 0.05);
    p.erode = 0.6; p.seed = this.rng.next(); p.wind = 1.6; p.turb = 0.3; p.sunVis = 1; p.fadeNear = 4;
    p.heat = this.rng.next() < 0.3 ? 0.55 : 0; p.heatDecay = 1.5;
    this.smoke.commit();
  }

  _emitFire(em) {
    const R = em.radius;
    // flame tongue
    {
      const p = this.smoke.begin();
      this.sphere(_v);
      p.x = em.pos.x + _v.x * R * 0.4; p.y = em.pos.y + Math.abs(_v.y) * R * 0.2; p.z = em.pos.z + _v.z * R * 0.4;
      p.vx = _v.x * 0.2; p.vy = this.r(1.2, 2.2); p.vz = _v.z * 0.2;
      p.drag = 1; p.grav = 2.5;
      p.size0 = R * 0.5; p.size1 = R * this.r(0.9, 1.3); p.sizePow = 1.5;
      p.life = this.r(0.5, 0.9); p.alpha = 0.9; p.fadeIn = 0.1; p.fadeOut = 0.5;
      p.r = 0.03; p.g = 0.028; p.b = 0.025;
      p.heat = this.r(0.9, 1.1); p.heatDecay = this.r(1.2, 2.2);
      p.frame = this.frame(0, 11); p.rot = this.r(0, 6.28); p.rotVel = this.r(-1, 1);
      p.erode = 0.7; p.seed = this.rng.next(); p.wind = 0.3; p.sunVis = em.sunVis; p.fadeNear = 0.5;
      p.pnx = 0; p.pny = 1; p.pnz = 0; p.pd = em.groundY; p.soft = 0.2;
      this.smoke.commit();
    }
    if (this.rng.next() < 0.35) {
      const p = this.smoke.begin();
      p.x = em.pos.x; p.y = em.pos.y + R; p.z = em.pos.z;
      p.vx = 0; p.vy = this.r(1.5, 2.5); p.vz = 0; p.drag = 0.3; p.grav = 0.3;
      p.size0 = R; p.size1 = R * this.r(3, 5); p.life = this.r(4, 7); p.alpha = 0.6; p.fadeIn = 0.1; p.fadeOut = 0.4;
      p.r = 0.04; p.g = 0.038; p.b = 0.035; p.r1 = 0.15; p.g1 = 0.145; p.b1 = 0.14;
      p.frame = this.frame(0, 11); p.rot = this.r(0, 6.28); p.erode = 0.7; p.seed = this.rng.next(); p.wind = 1; p.turb = 0.3; p.sunVis = em.sunVis;
      this.smoke.commit();
    }
    if (this.rng.next() < 0.5) this._emitEmber(em, em.pos);
  }

  _emitEmber(em, pos) {
    const p = this.glow.begin();
    this.sphere(_v);
    p.x = pos.x + _v.x * em.radius * 0.5; p.y = pos.y + Math.abs(_v.y) * em.radius * 0.3; p.z = pos.z + _v.z * em.radius * 0.5;
    p.vx = _v.x * 0.4; p.vy = this.r(1, 3); p.vz = _v.z * 0.4;
    p.grav = 0.3; p.drag = 0.8; p.turb = 3; p.seed = this.rng.next(); p.wind = 1;
    p.size0 = p.size1 = this.r(0.01, 0.022);
    p.life = this.r(1.5, 3.5); p.r = 8; p.g = 2.8; p.b = 0.6; p.alpha = 1; p.fadeIn = 0.05; p.fadeOut = 0.4;
    p.flicker = 0.6; p.frame = -1;
    this.glow.commit();
  }

  clearEmitters() { for (const em of this.emitters) em.active = false; }
}

import * as THREE from 'three';

/**
 * CPU-simulated, GPU-instanced particle batch (one draw call). Structure-of-arrays storage, swap-remove,
 * optional back-to-front sort, zero allocations after construction.
 *
 * Spawning: `const p = batch.begin(); p.x = ...; batch.commit();`  (p is a reused scratch object that
 * begin() resets to defaults).
 */
const FIELDS = [
  'x', 'y', 'z', 'vx', 'vy', 'vz', 'age', 'life', 'size0', 'size1', 'sizePow', 'rot', 'rotVel', 'drag',
  'grav', 'r', 'g', 'b', 'r1', 'g1', 'b1', 'alpha', 'fadeIn', 'fadeOut', 'frame', 'heat', 'heatDecay', 'stretch',
  'pnx', 'pny', 'pnz', 'pd', 'sunVis', 'soft', 'erode', 'seed', 'fadeNear', 'groundY', 'bounce', 'wind', 'turb',
  'flicker', 'delay', 'erode0',
];

const DEFAULTS = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, size0: 0.1, size1: 0.1, sizePow: 2, rot: 0, rotVel: 0,
  drag: 0, grav: 0, r: 1, g: 1, b: 1, r1: -1, g1: -1, b1: -1, alpha: 1, fadeIn: 0.05, fadeOut: 0.5, frame: 0,
  heat: 0, heatDecay: 0, stretch: 0, pnx: 0, pny: 0, pnz: 0, pd: 0, sunVis: 1, soft: 0.2, erode: 0, seed: 0,
  fadeNear: 0.4, groundY: -1e9, bounce: 0, wind: 0, turb: 0, flicker: 0, delay: 0, erode0: 0,
};

export class ParticleBatch {
  /**
   * @param {object} o { capacity, material, sorted, name, layer, renderOrder }
   */
  constructor({ capacity, material, sorted = false, name = 'particles', layer = 2, renderOrder = 10 }) {
    this.capacity = capacity;
    this.count = 0;
    this.sorted = sorted;
    this.a = {};
    for (const f of FIELDS) this.a[f] = new Float32Array(capacity);
    this.p = { ...DEFAULTS };
    this.wind = new THREE.Vector3();
    this.time = 0;

    const geo = new THREE.InstancedBufferGeometry();
    const corner = new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]);
    geo.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
    // three needs a position attribute for bounds/raycast bookkeeping
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.attrs = {};
    for (const n of ['iPos', 'iCol', 'iMisc', 'iVel', 'iPlane', 'iExtra']) {
      const arr = new Float32Array(capacity * 4);
      const at = new THREE.InstancedBufferAttribute(arr, 4);
      at.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(n, at);
      this.attrs[n] = at;
    }
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.geometry = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(layer);
    this.mesh.renderOrder = renderOrder;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;

    this._keys = new Float64Array(capacity).fill(Infinity);
    this._lastM = 0;
    this._order = new Uint16Array(capacity);
  }

  /** Reset and return the reusable spawn descriptor. */
  begin() {
    const p = this.p;
    for (const k in DEFAULTS) p[k] = DEFAULTS[k];
    return p;
  }

  /** Commit the descriptor from begin(). Returns index or -1 when full (oldest is replaced). */
  commit() {
    let i = this.count;
    if (i >= this.capacity) {
      // replace the particle closest to death
      let best = 0, bestT = -1;
      const age = this.a.age, life = this.a.life;
      for (let j = 0; j < this.count; j += 7) { const t = age[j] / life[j]; if (t > bestT) { bestT = t; best = j; } }
      i = best;
    } else this.count++;
    const p = this.p, a = this.a;
    for (let k = 0; k < FIELDS.length; k++) { const f = FIELDS[k]; a[f][i] = p[f]; }
    if (p.r1 < 0) { a.r1[i] = p.r; a.g1[i] = p.g; a.b1[i] = p.b; }
    a.age[i] = -p.delay;
    return i;
  }

  clear() { this.count = 0; this.geometry.instanceCount = 0; }

  _remove(i) {
    const last = --this.count;
    if (i !== last) for (let k = 0; k < FIELDS.length; k++) { const arr = this.a[FIELDS[k]]; arr[i] = arr[last]; }
  }

  update(dt, t, camera) {
    this.time = t;
    const a = this.a;
    const { x, y, z, vx, vy, vz, age, life, drag, grav, rot, rotVel, groundY, bounce, wind, turb } = a;
    const wx = this.wind.x, wy = this.wind.y, wz = this.wind.z;
    for (let i = this.count - 1; i >= 0; i--) {
      age[i] += dt;
      if (age[i] >= life[i]) { this._remove(i); continue; }
      if (age[i] < 0) continue;
      const k = Math.exp(-drag[i] * dt);
      // drag relaxes velocity towards the (scaled) wind
      const w = wind[i];
      vx[i] = (vx[i] - wx * w) * k + wx * w;
      vy[i] = (vy[i] - wy * w) * k + wy * w + grav[i] * dt;
      vz[i] = (vz[i] - wz * w) * k + wz * w;
      if (turb[i] > 0) {
        // cheap deterministic curl-ish swirl
        const s = a.seed[i] * 17.0;
        const tt = age[i];
        vx[i] += Math.sin(tt * 1.7 + s + y[i] * 0.9) * turb[i] * dt;
        vz[i] += Math.cos(tt * 1.3 + s * 1.3 + x[i] * 0.8) * turb[i] * dt;
        vy[i] += Math.sin(tt * 1.1 + s * 0.7 + z[i] * 0.7) * turb[i] * 0.5 * dt;
      }
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
      z[i] += vz[i] * dt;
      rot[i] += rotVel[i] * dt;
      rotVel[i] *= Math.exp(-0.4 * dt);
      if (y[i] < groundY[i]) {
        y[i] = groundY[i];
        if (vy[i] < 0) {
          if (bounce[i] > 0) { vy[i] = -vy[i] * bounce[i]; vx[i] *= 0.6; vz[i] *= 0.6; }
          else { vy[i] = 0; vx[i] *= 0.9; vz[i] *= 0.9; }
        }
      }
    }
    this._write(camera);
  }

  _write(camera) {
    const n = this.count;
    const a = this.a;
    const P = this.attrs.iPos.array, C = this.attrs.iCol.array, M = this.attrs.iMisc.array;
    const V = this.attrs.iVel.array, PL = this.attrs.iPlane.array, E = this.attrs.iExtra.array;
    const order = this._order;
    let live = 0;
    if (this.sorted && n > 1) {
      const e = camera.matrixWorld.elements;
      const fx = -e[8], fy = -e[9], fz = -e[10];
      const cx = e[12], cy = e[13], cz = e[14];
      const keys = this._keys;
      let m = 0;
      for (let i = 0; i < n; i++) {
        if (a.age[i] < 0) continue;
        const d = (a.x[i] - cx) * fx + (a.y[i] - cy) * fy + (a.z[i] - cz) * fz;
        // far first -> ascending key of (big - depth)
        const q = Math.max(0, Math.min(1048575, Math.floor((2000 - d) * 256)));
        keys[m++] = q * 4096 + i;
      }
      for (let j = m; j < this._lastM; j++) keys[j] = Infinity;
      this._lastM = m;
      keys.sort();
      for (let j = 0; j < m; j++) order[j] = keys[j] % 4096;
      live = m;
    } else {
      for (let i = 0; i < n; i++) if (a.age[i] >= 0) order[live++] = i;
    }
    for (let j = 0; j < live; j++) {
      const i = order[j];
      const o = j * 4;
      const tl = a.age[i] / a.life[i];
      const size = a.size0[i] + (a.size1[i] - a.size0[i]) * (1 - Math.pow(1 - tl, a.sizePow[i]));
      let al = a.alpha[i];
      const fi = a.fadeIn[i];
      if (fi > 0 && tl < fi) al *= tl / fi;
      const fo = a.fadeOut[i];
      if (tl > fo) { const u = (tl - fo) / (1 - fo); al *= 1 - u * u * (3 - 2 * u); }
      if (a.flicker[i] > 0) al *= 1 - a.flicker[i] * (0.5 + 0.5 * Math.sin(a.age[i] * 40 + a.seed[i] * 50));
      P[o] = a.x[i]; P[o + 1] = a.y[i]; P[o + 2] = a.z[i]; P[o + 3] = size;
      C[o] = a.r[i] + (a.r1[i] - a.r[i]) * tl;
      C[o + 1] = a.g[i] + (a.g1[i] - a.g[i]) * tl;
      C[o + 2] = a.b[i] + (a.b1[i] - a.b[i]) * tl;
      C[o + 3] = al;
      M[o] = a.rot[i]; M[o + 1] = a.frame[i];
      M[o + 2] = a.heat[i] * Math.exp(-a.age[i] * a.heatDecay[i]);
      M[o + 3] = a.sunVis[i];
      V[o] = a.vx[i]; V[o + 1] = a.vy[i]; V[o + 2] = a.vz[i]; V[o + 3] = a.stretch[i];
      PL[o] = a.pnx[i]; PL[o + 1] = a.pny[i]; PL[o + 2] = a.pnz[i]; PL[o + 3] = a.pd[i];
      E[o] = Math.min(1, a.erode0[i] + a.erode[i] * tl); E[o + 1] = a.soft[i] > 0 ? a.soft[i] : size * 0.35; E[o + 2] = a.seed[i]; E[o + 3] = a.fadeNear[i];
    }
    this.geometry.instanceCount = live;
    if (live > 0) {
      for (const k in this.attrs) {
        const at = this.attrs[k];
        at.clearUpdateRanges();
        at.addUpdateRange(0, live * 4);
        at.needsUpdate = true;
      }
    }
    this.mesh.visible = live > 0;
  }

  dispose() {
    this.geometry.dispose();
  }
}

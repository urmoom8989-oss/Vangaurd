import * as THREE from 'three';

/**
 * Animation utilities for the viewmodel: springs, keyframe tracks (cubic Hermite, time-parameterised),
 * pose tracks and rotation-vector helpers. Allocation-free in the per-frame paths.
 */

/** Damped spring on N scalar channels (semi-implicit Euler, sub-stepped for stability). */
export class SpringN {
  constructor(n, stiffness = 200, damping = 0.6) {
    this.n = n;
    this.x = new Float32Array(n);
    this.v = new Float32Array(n);
    this.target = new Float32Array(n);
    this.k = stiffness;
    this.z = damping; // damping ratio
  }
  impulse(i, dv) { this.v[i] += dv; }
  update(dt) {
    if (dt <= 0) return;
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    const k = this.k, c = 2 * this.z * Math.sqrt(k);
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < this.n; i++) {
        const a = -k * (this.x[i] - this.target[i]) - c * this.v[i];
        this.v[i] += a * h;
        this.x[i] += this.v[i] * h;
      }
    }
  }
  reset() { this.x.fill(0); this.v.fill(0); this.target.fill(0); }
}

/** Critically damped exponential approach (frame-rate independent). */
export function damp(cur, target, lambda, dt) {
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}

export const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const smootherstep = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * t * (t * (t * 6 - 15) + 10); };

/**
 * Numeric keyframe track. keys: [[t, v0, v1, ...], ...] sorted by t.
 * Cubic Hermite with Catmull-Rom tangents over non-uniform time; zero tangents at the ends (ease in/out).
 * Keys with a trailing 'hold' flag (v === '!') get zero tangents (a clean stop).
 */
export class Track {
  constructor(keys) {
    this.t = keys.map((k) => k[0]);
    this.dim = keys[0].length - 1;
    this.v = keys.map((k) => k.slice(1).map(Number));
    this.m = this.v.map(() => new Float32Array(this.dim));
    const n = keys.length;
    for (let i = 0; i < n; i++) {
      if (i === 0 || i === n - 1) continue;
      const dt = this.t[i + 1] - this.t[i - 1];
      for (let d = 0; d < this.dim; d++) {
        const a = this.v[i - 1][d], b = this.v[i][d], c = this.v[i + 1][d];
        // monotone-ish: zero tangent at local extrema to avoid overshoot
        if ((b - a) * (c - b) <= 0) { this.m[i][d] = 0; continue; }
        this.m[i][d] = (c - a) / dt;
      }
    }
  }
  sample(time, out) {
    const T = this.t, n = T.length;
    if (time <= T[0]) { for (let d = 0; d < this.dim; d++) out[d] = this.v[0][d]; return out; }
    if (time >= T[n - 1]) { for (let d = 0; d < this.dim; d++) out[d] = this.v[n - 1][d]; return out; }
    let i = 0;
    while (i < n - 2 && time > T[i + 1]) i++;
    const h = T[i + 1] - T[i];
    const s = (time - T[i]) / h;
    const s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    for (let d = 0; d < this.dim; d++) {
      out[d] = h00 * this.v[i][d] + h10 * h * this.m[i][d] + h01 * this.v[i + 1][d] + h11 * h * this.m[i + 1][d];
    }
    return out;
  }
}

/** Step/pose track: keys [[t, name, blendDur]] -> returns {a, b, w} (blend from pose a to b by w). */
export class PoseTrack {
  constructor(keys) { this.keys = keys; this._r = { a: keys[0][1], b: keys[0][1], w: 0 }; }
  sample(time) {
    const K = this.keys;
    let prev = K[0][1];
    const r = this._r;
    r.a = prev; r.b = prev; r.w = 0;
    for (let i = 1; i < K.length; i++) {
      const [t, name, dur = 0.12] = K[i];
      if (time < t) break;
      const w = dur > 0 ? smootherstep((time - t) / dur) : 1;
      if (w >= 1) { prev = name; r.a = name; r.b = name; r.w = 0; } else { r.a = prev; r.b = name; r.w = w; prev = name; }
    }
    return r;
  }
}

// -------------------------------------------------------------------------------- rotation vectors
const _qa = new THREE.Quaternion();
/** log map: quaternion -> rotation vector (axis * angle) */
export function quatToRotVec(q, out) {
  let { x, y, z, w } = q;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s < 1e-8) return out.set(x * 2, y * 2, z * 2);
  const ang = 2 * Math.atan2(s, w);
  return out.set((x / s) * ang, (y / s) * ang, (z / s) * ang);
}
/** exp map */
export function rotVecToQuat(v, out) {
  const ang = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (ang < 1e-8) return out.set(v.x * 0.5, v.y * 0.5, v.z * 0.5, 1).normalize();
  const s = Math.sin(ang / 2) / ang;
  return out.set(v.x * s, v.y * s, v.z * s, Math.cos(ang / 2));
}

/**
 * Hand/transform track: keys [[t, x, y, z, qx, qy, qz, qw]] (already resolved to one space).
 * Rotations are interpolated as rotation vectors relative to `ref` quaternion (Hermite, smooth).
 */
export class XfTrack {
  constructor(keys, ref) {
    this.ref = ref.clone();
    const refInv = ref.clone().invert();
    const rv = new THREE.Vector3();
    const flat = keys.map((k) => {
      _qa.set(k[4], k[5], k[6], k[7]);
      _qa.premultiply(refInv);
      quatToRotVec(_qa, rv);
      return [k[0], k[1], k[2], k[3], rv.x, rv.y, rv.z];
    });
    this.track = new Track(flat);
    this._o = new Float32Array(6);
    this._rv = new THREE.Vector3();
  }
  sample(time, outPos, outQuat) {
    const o = this.track.sample(time, this._o);
    outPos.set(o[0], o[1], o[2]);
    rotVecToQuat(this._rv.set(o[3], o[4], o[5]), outQuat);
    outQuat.premultiply(this.ref);
    return outPos;
  }
}

/** Deterministic smooth 1D noise for idle drift. */
export function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const h = (n) => { const s = Math.sin((n + seed * 131.7) * 12.9898) * 43758.5453; return s - Math.floor(s); };
  const u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}

import * as THREE from 'three';

/**
 * Procedural sculpting toolkit for the soldier mesh.
 *
 * Every shape is produced as a "Part" (positions + uvs + indices) from a parametric surface, then
 * normals are computed (area-weighted, seams/poles welded by position), and finally the part is
 * appended to a SoldierBuilder together with material id, skin weights and wear data.
 */

const _v = new THREE.Vector3();

export class Part {
  constructor() {
    this.p = []; // xyz
    this.uv = [];
    this.idx = [];
    this.n = null;
  }
  get count() { return this.p.length / 3; }
  add(x, y, z, u = 0, v = 0) {
    this.p.push(x, y, z);
    this.uv.push(u, v);
    return this.p.length / 3 - 1;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  /** apply fn(vec3) to all positions in place */
  map(fn) {
    for (let i = 0; i < this.p.length; i += 3) {
      _v.set(this.p[i], this.p[i + 1], this.p[i + 2]);
      fn(_v, i / 3);
      this.p[i] = _v.x; this.p[i + 1] = _v.y; this.p[i + 2] = _v.z;
    }
    return this;
  }
  applyMatrix4(m) { return this.map((v) => v.applyMatrix4(m)); }
  flip() {
    for (let i = 0; i < this.idx.length; i += 3) {
      const t = this.idx[i + 1]; this.idx[i + 1] = this.idx[i + 2]; this.idx[i + 2] = t;
    }
    return this;
  }
  merge(o) {
    const base = this.count;
    for (let i = 0; i < o.p.length; i++) this.p.push(o.p[i]);
    for (let i = 0; i < o.uv.length; i++) this.uv.push(o.uv[i]);
    for (let i = 0; i < o.idx.length; i++) this.idx.push(o.idx[i] + base);
    return this;
  }

  /** Area-weighted smooth normals, welding vertices that share a position (seams, poles). */
  computeNormals() {
    const n = new Float32Array(this.p.length);
    const P = this.p;
    for (let i = 0; i < this.idx.length; i += 3) {
      const a = this.idx[i] * 3, b = this.idx[i + 1] * 3, c = this.idx[i + 2] * 3;
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
      n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
      n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
    }
    // weld
    const map = new Map();
    const q = 1e5;
    for (let i = 0; i < P.length; i += 3) {
      const key = `${Math.round(P[i] * q)},${Math.round(P[i + 1] * q)},${Math.round(P[i + 2] * q)}`;
      let list = map.get(key);
      if (!list) map.set(key, (list = []));
      list.push(i);
    }
    for (const list of map.values()) {
      if (list.length < 2) continue;
      let x = 0, y = 0, z = 0;
      for (const i of list) { x += n[i]; y += n[i + 1]; z += n[i + 2]; }
      for (const i of list) { n[i] = x; n[i + 1] = y; n[i + 2] = z; }
    }
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
      n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
    }
    this.n = n;
    return this;
  }

  /** Flip winding if normals point inwards on average (closed, roughly convex parts). */
  orientOutward() {
    let cx = 0, cy = 0, cz = 0;
    const P = this.p, N = this.count;
    for (let i = 0; i < P.length; i += 3) { cx += P[i]; cy += P[i + 1]; cz += P[i + 2]; }
    cx /= N; cy /= N; cz /= N;
    let s = 0;
    for (let i = 0; i < this.idx.length; i += 3) {
      const a = this.idx[i] * 3, b = this.idx[i + 1] * 3, c = this.idx[i + 2] * 3;
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const mx = (P[a] + P[b] + P[c]) / 3 - cx, my = (P[a + 1] + P[b + 1] + P[c + 1]) / 3 - cy, mz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3 - cz;
      s += nx * mx + ny * my + nz * mz;
    }
    if (s < 0) this.flip();
    return this;
  }
}

/**
 * Parametric grid surface. fn(u, v, out:Vector3) for u in [0,1] (around when wrapU), v in [0,1].
 * UVs are arc lengths in metres (so detail textures tile at a physical scale).
 * capV0/capV1 add a centre fan closing the v=0 / v=1 ring.
 */
export function surface(nu, nv, fn, { wrapU = false, capV0 = false, capV1 = false, uvScale = 1 } = {}) {
  const part = new Part();
  const cols = nu + 1, rows = nv + 1;
  const pts = new Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const u = wrapU && i === nu ? 0 : i / nu;
      const o = new THREE.Vector3();
      fn(u, j / nv, o);
      pts[j * cols + i] = o;
    }
  }
  // arc length uvs
  const U = new Float32Array(cols * rows), V = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    let acc = 0;
    for (let i = 1; i < cols; i++) { acc += pts[j * cols + i].distanceTo(pts[j * cols + i - 1]); U[j * cols + i] = acc; }
  }
  for (let i = 0; i < cols; i++) {
    let acc = 0;
    for (let j = 1; j < rows; j++) { acc += pts[j * cols + i].distanceTo(pts[(j - 1) * cols + i]); V[j * cols + i] = acc; }
  }
  for (let k = 0; k < pts.length; k++) part.add(pts[k].x, pts[k].y, pts[k].z, U[k] * uvScale, V[k] * uvScale);
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols + 1, d = a + cols;
      part.quad(a, b, c, d);
    }
  }
  const cap = (row, reverse) => {
    const c = new THREE.Vector3();
    for (let i = 0; i < nu; i++) c.add(pts[row * cols + i]);
    c.divideScalar(nu);
    const ci = part.add(c.x, c.y, c.z, 0, V[row * cols] * uvScale);
    for (let i = 0; i < nu; i++) {
      const a = row * cols + i, b = a + 1;
      if (reverse) part.tri(ci, b, a); else part.tri(ci, a, b);
    }
  };
  if (capV0) cap(0, true);
  if (capV1) cap(nv, false);
  return part;
}

// ------------------------------------------------------------------ helpers

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
export const sgnPow = (x, e) => Math.sign(x) * Math.pow(Math.abs(x), e);
export const gauss = (x, w) => Math.exp(-(x * x) / (w * w));

/** Catmull-Rom style interpolation of keyed tables: keys = [[t, a, b, ...], ...] sorted by t. */
export function keyed(keys) {
  const n = keys[0].length - 1;
  const out = new Array(n);
  return (t) => {
    if (t <= keys[0][0]) { for (let k = 0; k < n; k++) out[k] = keys[0][k + 1]; return out; }
    const last = keys[keys.length - 1];
    if (t >= last[0]) { for (let k = 0; k < n; k++) out[k] = last[k + 1]; return out; }
    let i = 0;
    while (keys[i + 1][0] < t) i++;
    const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(keys.length - 1, i + 2)];
    const s = (t - k1[0]) / (k2[0] - k1[0]);
    const s2 = s * s, s3 = s2 * s;
    for (let k = 1; k <= n; k++) {
      const p0 = k0[k], p1 = k1[k], p2 = k2[k], p3 = k3[k];
      // centripetal-ish: uniform CR, then clamp overshoot between neighbours
      let v = 0.5 * ((2 * p1) + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s2 + (-p0 + 3 * p1 - 3 * p2 + p3) * s3);
      const lo = Math.min(p1, p2), hi = Math.max(p1, p2), pad = (hi - lo) * 0.15;
      v = clamp(v, lo - pad, hi + pad);
      out[k - 1] = v;
    }
    return out;
  };
}

/**
 * Rounded box via cube-sphere mapping: exact rounded edges with an even vertex distribution.
 * size [w,h,d], radius r, seg per face side. deform(v, nrmHint) optional.
 */
let RB_MAX = 99;
/** Global cap on roundedBox segments (LOD builds use 0 = plain 8-corner boxes). */
export function setRoundedBoxMax(n) { RB_MAX = n; }
export function roundedBox(w, h, d, r, seg = 4) {
  const part = new Part();
  seg = Math.min(seg, RB_MAX);
  const hx = w / 2, hy = h / 2, hz = d / 2;
  r = Math.min(r, hx, hy, hz);
  const ix = hx - r, iy = hy - r, iz = hz - r;
  const faces = [
    // normal axis, u axis, v axis
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  // Use more segments near edges: sample cube with a mapping that concentrates at edges
  const n = seg <= 0 ? 1 : seg * 2 + 2;
  const q = new THREE.Vector3(), inner = new THREE.Vector3();
  for (const [N, U, Vv] of faces) {
    const base = part.count;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        // concentrate samples near the rim so the rounded edge is smooth
        const fu = edgeMap(i / n, r, hx, hy, hz), fv = edgeMap(j / n, r, hx, hy, hz);
        q.set(
          (N[0] + U[0] * fu + Vv[0] * fv) * hx,
          (N[1] + U[1] * fu + Vv[1] * fv) * hy,
          (N[2] + U[2] * fu + Vv[2] * fv) * hz,
        );
        inner.set(clamp(q.x, -ix, ix), clamp(q.y, -iy, iy), clamp(q.z, -iz, iz));
        const dx = q.x - inner.x, dy = q.y - inner.y, dz = q.z - inner.z;
        const l = Math.hypot(dx, dy, dz) || 1;
        const px = inner.x + (dx / l) * r, py = inner.y + (dy / l) * r, pz = inner.z + (dz / l) * r;
        // box-projected uv in metres
        const uu = px * U[0] + py * U[1] + pz * U[2];
        const vv = px * Vv[0] + py * Vv[1] + pz * Vv[2];
        part.add(px, py, pz, uu, vv);
      }
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = base + j * (n + 1) + i, b = a + 1, c = a + n + 2, d = a + n + 1;
      part.quad(a, b, c, d);
    }
  }
  part.orientOutward();
  return part;
}
function edgeMap(t, r, hx, hy, hz) {
  // t in [0,1] -> [-1,1] with extra density near the ends (where the rounding is)
  const x = t * 2 - 1;
  return Math.sign(x) * Math.pow(Math.abs(x), 0.6);
}

/** Ellipsoid / superellipsoid; e1 (vertical) and e2 (horizontal) exponents (1 = ellipsoid, <1 boxier). */
export function ellipsoid(rx, ry, rz, nu = 16, nv = 10, e1 = 1, e2 = 1) {
  return surface(nu, nv, (u, v, o) => {
    const w = u * Math.PI * 2 - Math.PI, eta = Math.PI / 2 - v * Math.PI;
    const ce = Math.cos(eta), se = Math.sin(eta);
    o.set(rx * sgnPow(ce, e1) * sgnPow(Math.sin(w), e2), ry * sgnPow(se, e1), rz * sgnPow(ce, e1) * sgnPow(Math.cos(w), e2));
  }, { wrapU: true }).orientOutward();
}

/**
 * Tube along a smooth path. points: Vector3[] control points (Catmull-Rom through them).
 * radius(s, theta) -> number | [rx, ry]; theta measured from the reference 'side' vector.
 * ref: Vector3 hint for the frame's X axis (lateral).
 */
export function tube(points, radius, { radial = 12, rings = 16, ref = new THREE.Vector3(1, 0, 0), capStart = true, capEnd = true, offset = null } = {}) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);
  const frames = [];
  const T = new THREE.Vector3(), X = new THREE.Vector3(), Y = new THREE.Vector3();
  let prevX = ref.clone();
  for (let j = 0; j <= rings; j++) {
    const s = j / rings;
    const p = curve.getPointAt(s);
    curve.getTangentAt(s, T);
    // parallel transport
    X.copy(prevX).addScaledVector(T, -prevX.dot(T)).normalize();
    Y.crossVectors(T, X).normalize();
    prevX = X.clone();
    frames.push({ p, T: T.clone(), X: X.clone(), Y: Y.clone() });
  }
  const part = surface(radial, rings, (u, v, o) => {
    const j = Math.round(v * rings);
    const f = frames[j];
    const th = u * Math.PI * 2;
    let r = radius(v, th);
    let rx, ry;
    if (Array.isArray(r)) { rx = r[0]; ry = r[1]; } else { rx = ry = r; }
    const c = Math.cos(th), s = Math.sin(th);
    o.copy(f.p).addScaledVector(f.X, c * rx).addScaledVector(f.Y, s * ry);
    if (offset) offset(v, th, o, f);
  }, { wrapU: true, capV0: capStart, capV1: capEnd });
  part.orientOutward();
  return part;
}

/** Build a rotation matrix from basis vectors (columns X, Y, Z) and a position. */
export function basisMatrix(x, y, z, pos) {
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  if (pos) m.setPosition(pos);
  return m;
}

/** Matrix: translate + euler(deg) rotate. */
export function trs(px, py, pz, rx = 0, ry = 0, rz = 0, order = 'XYZ') {
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx * THREE.MathUtils.DEG2RAD, ry * THREE.MathUtils.DEG2RAD, rz * THREE.MathUtils.DEG2RAD, order));
  m.setPosition(px, py, pz);
  return m;
}

/** Cylinder (open or capped) along +Z from z0 to z1, optional polygon sides (for octagonal rails). */
export function cylinderZ(r0, r1, z0, z1, radial = 12, rings = 1, { caps = true, square = 1 } = {}) {
  return surface(radial, rings, (u, v, o) => {
    const th = u * Math.PI * 2;
    const r = lerp(r0, r1, v);
    const c = Math.cos(th), s = Math.sin(th);
    const k = square === 1 ? 1 : 1 / Math.pow(Math.pow(Math.abs(c), 2 / square) + Math.pow(Math.abs(s), 2 / square), square / 2);
    o.set(r * c * k, r * s * k, lerp(z0, z1, v));
  }, { wrapU: true, capV0: caps, capV1: caps }).orientOutward();
}

/** Deterministic value noise (for sculpt detail). */
export function hash3(x, y, z) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function vnoise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  let r = 0;
  for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    const h = hash3(xi + i, yi + j, zi + k);
    r += h * (i ? u : 1 - u) * (j ? v : 1 - v) * (k ? w : 1 - w);
  }
  return r * 2 - 1;
}
export function fbm3(x, y, z, oct = 3) {
  let a = 0.5, f = 1, s = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise3(x * f, y * f, z * f); a *= 0.5; f *= 2.03; }
  return s;
}

/**
 * A smooth limb centreline with parallel-transport frames, used to generate the limb tube and
 * conformal patches (knee pads, pockets, arm bands) that follow the same surface.
 * theta = 0 along frame X (lateral for limbs built on the character's left), PI/2 along frame Y.
 */
export class Limb {
  constructor(points, ref = new THREE.Vector3(1, 0, 0), samples = 96) {
    this.curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);
    this.length = this.curve.getLength();
    this.samples = samples;
    this.P = []; this.T = []; this.X = []; this.Y = [];
    let prevX = ref.clone();
    for (let j = 0; j <= samples; j++) {
      const s = j / samples;
      const p = this.curve.getPointAt(s);
      const T = this.curve.getTangentAt(s);
      const X = prevX.clone().addScaledVector(T, -prevX.dot(T)).normalize();
      const Y = new THREE.Vector3().crossVectors(T, X).normalize();
      prevX = X;
      this.P.push(p); this.T.push(T); this.X.push(X); this.Y.push(Y);
    }
  }
  /** frame at s (linear interpolation of sampled frames) */
  frame(s, out) {
    const f = clamp(s, 0, 1) * this.samples;
    const i = Math.min(this.samples - 1, Math.floor(f)), t = f - i;
    out.p.lerpVectors(this.P[i], this.P[i + 1], t);
    out.X.lerpVectors(this.X[i], this.X[i + 1], t).normalize();
    out.Y.lerpVectors(this.Y[i], this.Y[i + 1], t).normalize();
    out.T.lerpVectors(this.T[i], this.T[i + 1], t).normalize();
    return out;
  }
  /** point on the surface: radius r may be number or [rx, ry] */
  point(s, th, r, out) {
    const f = this.frame(s, _fr);
    let rx, ry;
    if (Array.isArray(r)) { rx = r[0]; ry = r[1]; } else rx = ry = r;
    return out.copy(f.p).addScaledVector(f.X, Math.cos(th) * rx).addScaledVector(f.Y, Math.sin(th) * ry);
  }
  /** full closed tube over s in [s0, s1] */
  tube(radial, rings, radius, { s0 = 0, s1 = 1, capStart = true, capEnd = true } = {}) {
    return surface(radial, rings, (u, v, o) => {
      const s = lerp(s0, s1, v), th = u * Math.PI * 2;
      this.point(s, th, radius(s, th), o);
    }, { wrapU: true, capV0: capStart, capV1: capEnd }).orientOutward();
  }
  /** open patch over s in [s0,s1], theta in [t0,t1]; radius(s, th, eu, ev) with eu/ev in [0,1] */
  patch(nu, nv, s0, s1, t0, t1, radius) {
    const part = surface(nu, nv, (u, v, o) => {
      const s = lerp(s0, s1, v), th = lerp(t0, t1, u);
      this.point(s, th, radius(s, th, u, v), o);
    });
    return part;
  }
}
const _fr = { p: new THREE.Vector3(), X: new THREE.Vector3(), Y: new THREE.Vector3(), T: new THREE.Vector3() };

/** Rounded-rectangle edge factor in [0,1] for a patch parameter (u,v) with border width bw (param units). */
export function edgeFactor(u, v, bu = 0.15, bv = 0.15) {
  const eu = smooth(0, bu, u) * smooth(0, bu, 1 - u);
  const ev = smooth(0, bv, v) * smooth(0, bv, 1 - v);
  return Math.sqrt(eu * ev);
}

/** Simple flat-shaded box (24 verts) centred at origin. */
export function flatBox(w, h, d) {
  const part = new Part();
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const F = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0], hx, hz, hy],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0], hx, hz, hy],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1], hy, hx, hz],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1], hy, hx, hz],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0], hz, hx, hy],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0], hz, hx, hy],
  ];
  const n = [];
  for (const [N, U, V, hn, hu, hv] of F) {
    const b = part.count;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      part.add(N[0] * hn + U[0] * su * hu + V[0] * sv * hv, N[1] * hn + U[1] * su * hu + V[1] * sv * hv, N[2] * hn + U[2] * su * hu + V[2] * sv * hv, su * hu, sv * hv);
      n.push(N[0], N[1], N[2]);
    }
    part.quad(b, b + 1, b + 2, b + 3);
  }
  part.orientOutward();
  part.n = new Float32Array(n);
  return part;
}

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Procedural hard-surface geometry toolkit for the weapons system.
 *
 * Gun-space convention used by every model builder:
 *   x = right, y = up, z = back (muzzle points to -z). Profiles are authored in (u, v) where
 *   u = forward distance (= -z) and v = up (= y). Units are meters.
 *
 * Every primitive returns a NON-INDEXED BufferGeometry with only `position` + `normal` (+ optional `uv`),
 * with bevelled edges and area-weighted smooth normals ("weighted normals") so large flat faces stay flat
 * while bevels shade as soft rounded highlights, i.e. no hard CG edges.
 */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Strip to position/normal(/uv), make non-indexed. Consumes input. */
export function clean(g, keepUV = false) {
  let n = g.index ? g.toNonIndexed() : g;
  if (n !== g) g.dispose();
  for (const k of Object.keys(n.attributes)) {
    if (k === 'position' || k === 'normal' || (keepUV && k === 'uv')) continue;
    n.deleteAttribute(k);
  }
  if (!n.attributes.normal) n.computeVertexNormals();
  if (keepUV && !n.attributes.uv) n.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((n.attributes.position.count) * 2), 2));
  n.clearGroups();
  return n;
}

/**
 * Area-weighted, crease-aware normals for a non-indexed geometry (Blender "Weighted Normal" + auto-smooth).
 * @param {number} creaseDeg faces whose normals differ more than this stay hard
 * @param {number} areaPow   weight = area^areaPow (higher -> big flat faces dominate harder)
 */
export function weightedNormals(g, creaseDeg = 44, areaPow = 1.0) {
  const pos = g.attributes.position.array;
  const count = pos.length / 3;
  const faces = count / 3;
  const fn = new Float32Array(faces * 3);
  const fa = new Float32Array(faces);
  for (let f = 0; f < faces; f++) {
    const i = f * 9;
    const ax = pos[i + 3] - pos[i], ay = pos[i + 4] - pos[i + 1], az = pos[i + 5] - pos[i + 2];
    const bx = pos[i + 6] - pos[i], by = pos[i + 7] - pos[i + 1], bz = pos[i + 8] - pos[i + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz);
    fa[f] = Math.pow(l * 0.5 + 1e-14, areaPow);
    if (l > 0) { nx /= l; ny /= l; nz /= l; }
    fn[f * 3] = nx; fn[f * 3 + 1] = ny; fn[f * 3 + 2] = nz;
  }
  // group corners by quantized position
  const map = new Map();
  const key = new Array(count);
  for (let v = 0; v < count; v++) {
    const k = `${Math.round(pos[v * 3] * 2e5)},${Math.round(pos[v * 3 + 1] * 2e5)},${Math.round(pos[v * 3 + 2] * 2e5)}`;
    key[v] = k;
    let arr = map.get(k);
    if (!arr) { arr = []; map.set(k, arr); }
    arr.push(v);
  }
  const cosC = Math.cos(creaseDeg * Math.PI / 180);
  const nrm = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    const f = (v / 3) | 0;
    const nx = fn[f * 3], ny = fn[f * 3 + 1], nz = fn[f * 3 + 2];
    let sx = 0, sy = 0, sz = 0;
    const arr = map.get(key[v]);
    let lastF = -1;
    for (let j = 0; j < arr.length; j++) {
      const g2 = (arr[j] / 3) | 0;
      if (g2 === lastF) continue;
      lastF = g2;
      const gx = fn[g2 * 3], gy = fn[g2 * 3 + 1], gz = fn[g2 * 3 + 2];
      if (nx * gx + ny * gy + nz * gz < cosC) continue;
      const w = fa[g2];
      sx += gx * w; sy += gy * w; sz += gz * w;
    }
    const l = Math.hypot(sx, sy, sz) || 1;
    nrm[v * 3] = sx / l; nrm[v * 3 + 1] = sy / l; nrm[v * 3 + 2] = sz / l;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

/** Apply a transform: p=[x,y,z], r=[x,y,z] degrees (XYZ), s=number|[x,y,z]. */
export function xf(g, p = null, r = null, s = null) {
  _e.set(r ? r[0] * THREE.MathUtils.DEG2RAD : 0, r ? r[1] * THREE.MathUtils.DEG2RAD : 0, r ? r[2] * THREE.MathUtils.DEG2RAD : 0);
  _q.setFromEuler(_e);
  _v.set(p ? p[0] : 0, p ? p[1] : 0, p ? p[2] : 0);
  if (s == null) _s.set(1, 1, 1);
  else if (typeof s === 'number') _s.set(s, s, s);
  else _s.set(s[0], s[1], s[2]);
  _m.compose(_v, _q, _s);
  g.applyMatrix4(_m);
  if (_s.x * _s.y * _s.z < 0) flipWinding(g);
  return g;
}

export function flipWinding(g) {
  const flip = (attr) => {
    if (!attr) return;
    const a = attr.array, n = attr.itemSize;
    for (let i = 0; i < attr.count; i += 3) {
      for (let k = 0; k < n; k++) {
        const t = a[(i + 1) * n + k];
        a[(i + 1) * n + k] = a[(i + 2) * n + k];
        a[(i + 2) * n + k] = t;
      }
    }
    attr.needsUpdate = true;
  };
  flip(g.attributes.position); flip(g.attributes.normal); flip(g.attributes.uv);
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) flip(g.attributes[k]);
  return g;
}

// ------------------------------------------------------------------------------------------- shapes

/**
 * Polygon with filleted corners. pts: [[x,y],...]; r: number or per-corner array (0 = sharp).
 * Returns array of THREE.Vector2 (CCW preserved from input).
 */
export function fillet(pts, r = 0.002, seg = 4) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const rr = Array.isArray(r) ? r[i] : r;
    const p = pts[i], a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    if (!rr) { out.push(new THREE.Vector2(p[0], p[1])); continue; }
    const d1x = a[0] - p[0], d1y = a[1] - p[1], d2x = b[0] - p[0], d2y = b[1] - p[1];
    const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y);
    const u1x = d1x / l1, u1y = d1y / l1, u2x = d2x / l2, u2y = d2y / l2;
    const cosA = THREE.MathUtils.clamp(u1x * u2x + u1y * u2y, -0.9999, 0.9999);
    const half = Math.acos(cosA) / 2;
    let t = rr / Math.tan(half);
    t = Math.min(t, l1 * 0.49, l2 * 0.49);
    const rad = t * Math.tan(half);
    const s1x = p[0] + u1x * t, s1y = p[1] + u1y * t;
    const s2x = p[0] + u2x * t, s2y = p[1] + u2y * t;
    // center along bisector
    let bx = u1x + u2x, by = u1y + u2y;
    const bl = Math.hypot(bx, by) || 1;
    bx /= bl; by /= bl;
    const cd = rad / Math.sin(half);
    const cx = p[0] + bx * cd, cy = p[1] + by * cd;
    let a0 = Math.atan2(s1y - cy, s1x - cx), a1 = Math.atan2(s2y - cy, s2x - cx);
    let da = a1 - a0;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    for (let k = 0; k <= seg; k++) {
      const aa = a0 + da * (k / seg);
      out.push(new THREE.Vector2(cx + Math.cos(aa) * rad, cy + Math.sin(aa) * rad));
    }
  }
  return out;
}

/** Build a THREE.Shape from outline (array of [x,y] or Vector2) and optional holes. */
export function shape(outline, holes = []) {
  const v2 = (p) => (p.isVector2 ? p : new THREE.Vector2(p[0], p[1]));
  const pts = outline.map(v2);
  if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
  const s = new THREE.Shape(pts);
  for (const h of holes) {
    const hp = h.map(v2);
    if (!THREE.ShapeUtils.isClockWise(hp)) hp.reverse();
    s.holes.push(new THREE.Path(hp));
  }
  return s;
}

/** Rounded rectangle outline centered at (cx, cy). */
export function rrect(cx, cy, w, h, r, seg = 4) {
  return fillet([[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]], r, seg);
}

/** Stadium / slot outline (for M-LOK slots) centered at (cx, cy), long axis along x. */
export function slot(cx, cy, len, wid, seg = 6) {
  return rrect(cx, cy, len, wid, wid / 2 - 1e-5, seg);
}

export function circle(cx, cy, r, seg = 20) {
  const out = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    out.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return out;
}

/** Sample a smooth closed Catmull-Rom curve through control points -> outline. */
export function spline(pts, n = 64, tension = 0.5) {
  const c = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[1], 0)), true, 'centripetal', tension);
  return c.getSpacedPoints(n).slice(0, n).map((p) => new THREE.Vector2(p.x, p.y));
}

// ------------------------------------------------------------------------------------------- extrusions

function extrudeRaw(sh, depth, bevel, bevelSeg, curveSeg) {
  const b = Math.min(bevel, depth * 0.49);
  const g = new THREE.ExtrudeGeometry(sh, {
    depth: Math.max(1e-5, depth - 2 * b),
    bevelEnabled: b > 0,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: -b,
    bevelSegments: b > 0 ? bevelSeg : 0,
    curveSegments: curveSeg,
    steps: 1,
  });
  g.translate(0, 0, b); // now z in [0, depth]
  return g;
}

/**
 * Side-profile extrusion: outline in (u forward, v up), extruded across x, centered on x = cx.
 * opts: { bevel=0.001, seg=3, curveSeg=6, holes=[], crease=44 }
 */
export function sideX(outline, width, opts = {}) {
  const { bevel = 0.001, seg = 3, curveSeg = 6, holes = [], cx = 0, crease = 44, uv = false } = opts;
  const g = extrudeRaw(shape(outline, holes), width, bevel, seg, curveSeg);
  // (su, sv, e) -> (x = e - w/2 + cx, y = sv, z = -su)
  _m.set(
    0, 0, 1, cx - width / 2,
    0, 1, 0, 0,
    -1, 0, 0, 0,
    0, 0, 0, 1,
  );
  g.applyMatrix4(_m);
  return finish(g, crease, uv);
}

/**
 * Front/cross-section extrusion: outline in (x, y), extruded along the bore from u0 to u1 (z = -u).
 */
export function alongZ(outline, u0, u1, opts = {}) {
  const { bevel = 0.001, seg = 3, curveSeg = 6, holes = [], crease = 44, uv = false } = opts;
  const g = extrudeRaw(shape(outline, holes), u1 - u0, bevel, seg, curveSeg);
  // (x, y, e) -> (x, y, z = -(u0 + e)); mirror in z flips winding -> use rotation instead:
  // rotateY(180) maps (x,y,z)->(-x,y,-z); pre-mirror x to compensate winding-safely by rebuilding shape mirrored
  _m.set(
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, -1, -u0,
    0, 0, 0, 1,
  );
  g.applyMatrix4(_m);
  flipWinding(g);
  return finish(g, crease, uv);
}

/** Top-profile extrusion: outline in (x, u), extruded vertically from v0 to v1. */
export function topY(outline, v0, v1, opts = {}) {
  const { bevel = 0.001, seg = 3, curveSeg = 6, holes = [], crease = 44, uv = false } = opts;
  const g = extrudeRaw(shape(outline, holes), v1 - v0, bevel, seg, curveSeg);
  // (x, su, e) -> (x, y = v0 + e, z = -su)
  _m.set(
    1, 0, 0, 0,
    0, 0, 1, v0,
    0, -1, 0, 0,
    0, 0, 0, 1,
  );
  g.applyMatrix4(_m);
  return finish(g, crease, uv);
}

function finish(g, crease, uv) {
  const n = clean(g, uv);
  weightedNormals(n, crease);
  return n;
}

// ------------------------------------------------------------------------------------------- revolved

/**
 * Lathe around the bore-parallel axis. prof: [[r, u], ...] from rear to front (u forward).
 * Returns geometry with axis along -z through origin. seg radial segments. Chamfers: author them in prof.
 */
export function lathe(prof, seg = 24, opts = {}) {
  const { crease = 40, phase = 0 } = opts;
  const pts = prof.map(([r, u]) => new THREE.Vector2(Math.max(0, r), u));
  const g = new THREE.LatheGeometry(pts, seg, phase, Math.PI * 2);
  // Lathe axis is +Y with points (r, y). Map y -> -z (forward), keep winding: rotateX(-90): y->... (x, y, z)->(x, z, -y)
  g.rotateX(-Math.PI / 2);
  // After rotateX(-90): y' = z, z' = -y  => u (=y) maps to z' = -u. Good.
  const n = clean(g);
  weightedNormals(n, crease);
  return n;
}

/** Cylinder-like pin along an axis: r radius, len length, chamfer c. axis: 'x'|'y'|'z'. Centered. */
export function pin(r, len, c = 0.0004, seg = 16, axis = 'x') {
  const h = len / 2;
  const g = lathe([[0, -h], [r - c, -h], [r, -h + c], [r, h - c], [r - c, h], [0, h]], seg, { crease: 50 });
  if (axis === 'x') g.rotateY(Math.PI / 2);
  else if (axis === 'y') g.rotateX(Math.PI / 2);
  return g;
}

/** Rounded box: bevelled cuboid via extrusion (exact bevel radius, weighted normals). */
export function box(w, h, d, r = 0.001, opts = {}) {
  const { seg = 3 } = opts;
  const rr = Math.min(r, w * 0.45, h * 0.45);
  const outline = rrect(0, 0, w, h, Math.max(0, rr * 0.999), 3);
  const g = extrudeRaw(shape(outline), d, Math.min(r, d * 0.45), seg, 4);
  g.translate(0, 0, -d / 2);
  return finish(g, 44, false);
}

// ------------------------------------------------------------------------------------------- lofts

/**
 * Generic loft through rings. rings: array of arrays of Vector3 (same count, closed loops).
 * Returns non-indexed geometry with smooth normals (indexed normals computed before de-indexing).
 */
export function loft(rings, { capStart = false, capEnd = false, closed = true } = {}) {
  const R = rings.length, C = rings[0].length;
  const pos = [];
  for (const ring of rings) for (const p of ring) pos.push(p.x, p.y, p.z);
  const idx = [];
  const cols = closed ? C : C - 1;
  for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < cols; j++) {
      const a = i * C + j, b = i * C + ((j + 1) % C), c = (i + 1) * C + j, d = (i + 1) * C + ((j + 1) % C);
      idx.push(a, c, b, b, c, d);
    }
  }
  let extra = R * C;
  if (capStart) {
    const c0 = new THREE.Vector3();
    for (const p of rings[0]) c0.add(p);
    c0.multiplyScalar(1 / C);
    pos.push(c0.x, c0.y, c0.z);
    for (let j = 0; j < C; j++) idx.push(extra, j, (j + 1) % C);
    extra++;
  }
  if (capEnd) {
    const c1 = new THREE.Vector3();
    for (const p of rings[R - 1]) c1.add(p);
    c1.multiplyScalar(1 / C);
    pos.push(c1.x, c1.y, c1.z);
    const base = (R - 1) * C;
    for (let j = 0; j < C; j++) idx.push(extra, base + ((j + 1) % C), base + j);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------------------------------- assembly

/**
 * Accumulates geometries per material key and merges them into as few meshes as possible.
 */
export class Assembly {
  constructor() { this.lists = new Map(); }
  add(mat, g, p = null, r = null, s = null) {
    if (p || r || s) xf(g, p, r, s);
    let l = this.lists.get(mat);
    if (!l) { l = []; this.lists.set(mat, l); }
    l.push(g);
    return g;
  }
  /** mirror-copy (x -> -x) of a geometry into the same material list */
  addMirrorX(mat, g) {
    const c = g.clone();
    c.scale(-1, 1, 1);
    flipWinding(c);
    return this.add(mat, c);
  }
  /** Merge into a Group of Meshes. mats: key -> Material. layer: render layer. */
  build(mats, layer, name = 'part') {
    const grp = new THREE.Group();
    grp.name = name;
    for (const [key, list] of this.lists) {
      if (!list.length) continue;
      const withUV = list.some((g) => g.attributes.uv);
      const norm = list.map((g) => {
        if (withUV && !g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
        if (!withUV && g.attributes.uv) g.deleteAttribute('uv');
        return g;
      });
      const merged = norm.length === 1 ? norm[0] : mergeGeometries(norm, false);
      if (norm.length > 1) for (const g of norm) g.dispose();
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, mats[key] || mats.default);
      mesh.name = `${name}:${key}`;
      mesh.layers.set(layer);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      grp.add(mesh);
    }
    this.lists.clear();
    return grp;
  }
}

/** Count triangles in an Object3D tree. */
export function triCount(obj) {
  let n = 0;
  obj.traverse((o) => {
    if (o.isMesh && o.geometry) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
  });
  return n;
}

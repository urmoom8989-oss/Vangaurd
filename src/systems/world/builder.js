import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * GeoBuilder — accumulates static level geometry into per-(chunk, material) batches and into the
 * collision streams (ray / move). Everything is emitted in a "frame" (a local coordinate system, e.g.
 * one building) whose matrix transforms to world space. Planar UV projection ('proj') uses the frame's
 * local coordinates so textures run continuously across wall segments (1 UV unit = 1 m).
 *
 * Collision flags per primitive:
 *   ray:  bullets / line of sight / ground queries hit it
 *   move: capsule collision + navigation treats it as solid
 */

const _m = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

// box face definitions: normal, u axis, v axis (local), corners generated from them
const BOX_FACES = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }, // +x
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] }, // -x
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] }, // +y
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] }, // -y
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, // +z
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] }, // -z
];
export const FACE = { PX: 1, NX: 2, PY: 4, NY: 8, PZ: 16, NZ: 32 };

class Batch {
  constructor(key, chunk, mat, shadow) {
    this.key = key;
    this.chunk = chunk;
    this.mat = mat;
    this.shadow = shadow;
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.idx = [];
    this.rayIdx = [];
    this.moveIdx = [];
    this.vcount = 0;
    this.mesh = null;
  }
}

export class GeoBuilder {
  constructor({ chunkSize = 60, mergeBelow = 40000 } = {}) {
    this.chunkSize = chunkSize;
    this.mergeBelow = mergeBelow;
    this.batches = new Map();
    this.frame = new THREE.Matrix4();
    this.frameNormal = new THREE.Matrix3();
    this.frameChunk = null;
    this.uvOff = [0, 0];
    this._stack = [];
    // extra collision-only geometry (no render): { pos: [], idx: [], part }
    this.colOnly = [];
    this.stats = { tris: 0 };
  }

  chunkKey(x, z) {
    const cs = this.chunkSize;
    return `${Math.floor(x / cs)},${Math.floor(z / cs)}`;
  }

  /** Enter a local frame. `matrix` local->world. chunkAt: world x,z used to pick the chunk for everything in the frame. */
  push(matrix, { chunkAt = null, uvOff = null } = {}) {
    this._stack.push({ f: this.frame.clone(), c: this.frameChunk, u: this.uvOff });
    this.frame = this.frame.clone().multiply(matrix);
    this.frameNormal.getNormalMatrix(this.frame);
    if (chunkAt) this.frameChunk = this.chunkKey(chunkAt[0], chunkAt[1]);
    if (uvOff) this.uvOff = uvOff;
    return this;
  }

  pop() {
    const s = this._stack.pop();
    this.frame = s.f;
    this.frameNormal.getNormalMatrix(this.frame);
    this.frameChunk = s.c;
    this.uvOff = s.u;
    return this;
  }

  /** Convenience: push a translation + yaw frame. */
  pushTR(x, y, z, rotY = 0, opts = {}) {
    _m.makeRotationY(rotY).setPosition(x, y, z);
    return this.push(_m, { chunkAt: opts.chunkAt ?? null, uvOff: opts.uvOff ?? null });
  }

  _batch(mat, wx, wz, shadow) {
    const chunk = this.frameChunk ?? this.chunkKey(wx, wz);
    const key = `${chunk}|${mat}|${shadow ? 1 : 0}`;
    let b = this.batches.get(key);
    if (!b) { b = new Batch(key, chunk, mat, shadow); this.batches.set(key, b); }
    return b;
  }

  /**
   * Axis-aligned (in local frame, optionally rotated) box. center (x,y,z), size (sx,sy,sz).
   * opts: rot:[rx,ry,rz] (radians, applied around the box center), skip: FACE bitmask,
   *       uv: 'proj' (default; planar by face normal in frame space) | 'face' (per-face meters from face corner)
   *       uvOff:[u,v], uvScale, ray/move (default true), col (sets both), shadow (default true)
   */
  box(mat, x, y, z, sx, sy, sz, o = {}) {
    const skip = o.skip || 0;
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const local = _m.identity();
    if (o.rot) { _e.set(o.rot[0] || 0, o.rot[1] || 0, o.rot[2] || 0); local.makeRotationFromEuler(_e); }
    local.setPosition(x, y, z);
    const world = new THREE.Matrix4().multiplyMatrices(this.frame, local);
    const nWorld = new THREE.Matrix3().getNormalMatrix(world);
    const frameLocal = local.clone();
    const nFrame = new THREE.Matrix3().getNormalMatrix(frameLocal);
    _v.set(x, y, z).applyMatrix4(this.frame);
    const b = this._batch(mat, _v.x, _v.z, o.shadow !== false);
    const ray = o.col === false ? false : (o.ray ?? o.col ?? true);
    const move = o.col === false ? false : (o.move ?? o.col ?? true);
    const uvMode = o.uv || 'proj';
    const uo = o.uvOff || this.uvOff;
    const us = o.uvScale || 1;
    const dims = [hx, hy, hz];
    const fp = new THREE.Vector3();
    const fpl = new THREE.Vector3();
    for (let f = 0; f < 6; f++) {
      if (skip & (1 << f)) continue;
      const F = BOX_FACES[f];
      const base = b.vcount;
      // face center, u/v half extents
      const ax = F.n[0] !== 0 ? 0 : F.n[1] !== 0 ? 1 : 2;
      const uAx = F.u[0] !== 0 ? 0 : F.u[1] !== 0 ? 1 : 2;
      const vAx = F.v[0] !== 0 ? 0 : F.v[1] !== 0 ? 1 : 2;
      const hu = dims[uAx], hv = dims[vAx];
      _n.set(F.n[0], F.n[1], F.n[2]);
      const wn = _n.clone().applyMatrix3(nWorld).normalize();
      const ln = _n.clone().applyMatrix3(nFrame).normalize();
      for (let c = 0; c < 4; c++) {
        const su = c === 0 || c === 3 ? -1 : 1;
        const sv = c < 2 ? -1 : 1;
        fp.set(
          F.n[0] * dims[0] + F.u[0] * hu * su + F.v[0] * hv * sv,
          F.n[1] * dims[1] + F.u[1] * hu * su + F.v[1] * hv * sv,
          F.n[2] * dims[2] + F.u[2] * hu * su + F.v[2] * hv * sv,
        );
        fpl.copy(fp).applyMatrix4(frameLocal); // frame-space position
        const wp = fp.clone().applyMatrix4(world);
        b.pos.push(wp.x, wp.y, wp.z);
        b.nor.push(wn.x, wn.y, wn.z);
        let u, v;
        if (uvMode === 'face') {
          u = (su + 1) * hu; v = (sv + 1) * hv;
        } else {
          [u, v] = projUV(fpl, ln);
        }
        b.uv.push(u * us + uo[0], v * us + uo[1]);
      }
      b.vcount += 4;
      b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      if (ray) b.rayIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      if (move) b.moveIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      this.stats.tris += 2;
      void ax;
    }
    return this;
  }

  /**
   * Add an arbitrary BufferGeometry (positions in the local frame after `matrix`).
   * opts: uv: 'keep' (use geometry uv, scaled by uvScale) | 'proj' (planar projection), ray, move, shadow
   */
  geometry(mat, geo, matrix = null, o = {}) {
    const g = geo.index ? geo : geo; // indexed or not handled below
    const pos = g.attributes.position;
    let nor = g.attributes.normal;
    if (!nor) { g.computeVertexNormals(); nor = g.attributes.normal; }
    const uvA = g.attributes.uv;
    const local = matrix ? matrix.clone() : new THREE.Matrix4();
    const world = new THREE.Matrix4().multiplyMatrices(this.frame, local);
    const nWorld = new THREE.Matrix3().getNormalMatrix(world);
    const nFrame = new THREE.Matrix3().getNormalMatrix(local);
    // chunk by bounding center
    if (!g.boundingBox) g.computeBoundingBox();
    g.boundingBox.getCenter(_p).applyMatrix4(world);
    const b = this._batch(mat, _p.x, _p.z, o.shadow !== false);
    const ray = o.col === false ? false : (o.ray ?? o.col ?? true);
    const move = o.col === false ? false : (o.move ?? o.col ?? true);
    const uvMode = o.uv || (uvA ? 'keep' : 'proj');
    const uo = o.uvOff || this.uvOff;
    const us = o.uvScale || 1;
    const base = b.vcount;
    const lp = new THREE.Vector3();
    const ln = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i);
      lp.copy(_v).applyMatrix4(local);
      _v.applyMatrix4(world);
      b.pos.push(_v.x, _v.y, _v.z);
      _n.fromBufferAttribute(nor, i);
      ln.copy(_n).applyMatrix3(nFrame).normalize();
      _n.applyMatrix3(nWorld).normalize();
      b.nor.push(_n.x, _n.y, _n.z);
      if (uvMode === 'keep' && uvA) {
        b.uv.push(uvA.getX(i) * (o.uvScaleU ?? us) + uo[0], uvA.getY(i) * (o.uvScaleV ?? us) + uo[1]);
      } else {
        const [u, v] = projUV(lp, ln);
        b.uv.push(u * us + uo[0], v * us + uo[1]);
      }
    }
    b.vcount += pos.count;
    const push = (a, bb, c) => {
      b.idx.push(a, bb, c);
      if (ray) b.rayIdx.push(a, bb, c);
      if (move) b.moveIdx.push(a, bb, c);
    };
    if (g.index) {
      const ix = g.index.array;
      for (let i = 0; i < ix.length; i += 3) push(base + ix[i], base + ix[i + 1], base + ix[i + 2]);
      this.stats.tris += ix.length / 3;
    } else {
      for (let i = 0; i < pos.count; i += 3) push(base + i, base + i + 1, base + i + 2);
      this.stats.tris += pos.count / 3;
    }
    return this;
  }

  /** Quad from 4 frame-space points (counter-clockwise seen from the front). */
  quad(mat, a, b2, c, d, o = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b2, ...c, ...d], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.computeVertexNormals();
    if (o.uvs) g.setAttribute('uv', new THREE.Float32BufferAttribute(o.uvs, 2));
    this.geometry(mat, g, null, { ...o, uv: o.uvs ? 'keep' : 'proj' });
    g.dispose();
    return this;
  }

  /** Cylinder between two frame-space points. */
  cylinder(mat, p0, p1, r0, r1 = r0, seg = 8, o = {}) {
    const a = new THREE.Vector3().fromArray(p0), b = new THREE.Vector3().fromArray(p1);
    const len = a.distanceTo(b);
    if (len < 1e-5) return this;
    const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, !o.caps);
    // UV: u around circumference in meters, v along length in meters
    const uv = g.attributes.uv;
    const circ = Math.PI * 2 * Math.max(r0, r1);
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * len);
    const dir = b.clone().sub(a).normalize();
    _q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), _q, _s.set(1, 1, 1));
    this.geometry(mat, g, m, { ...o, uv: 'keep' });
    g.dispose();
    return this;
  }

  /** Thin tube along a polyline of frame-space points (wires, cables, pipes). */
  tube(mat, points, radius, sides = 4, o = {}) {
    const n = points.length;
    if (n < 2) return this;
    const pos = [], nor = [], uvs = [], idx = [];
    const t = new THREE.Vector3(), up = new THREE.Vector3(), side = new THREE.Vector3(), nn = new THREE.Vector3();
    let len = 0;
    for (let i = 0; i < n; i++) {
      const p = points[i];
      if (i < n - 1) t.subVectors(points[i + 1], p); else t.subVectors(p, points[i - 1]);
      if (i > 0 && i < n - 1) t.subVectors(points[i + 1], points[i - 1]);
      t.normalize();
      up.set(0, 1, 0);
      if (Math.abs(t.y) > 0.95) up.set(1, 0, 0);
      side.crossVectors(t, up).normalize();
      up.crossVectors(side, t).normalize();
      if (i > 0) len += p.distanceTo(points[i - 1]);
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        nn.copy(side).multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a));
        pos.push(p.x + nn.x * radius, p.y + nn.y * radius, p.z + nn.z * radius);
        nor.push(nn.x, nn.y, nn.z);
        uvs.push((s / sides) * radius * 6.28, len);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      for (let s = 0; s < sides; s++) {
        const a = i * (sides + 1) + s, b = a + sides + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    this.geometry(mat, g, null, { col: false, ...o, uv: 'keep' });
    g.dispose();
    return this;
  }

  /**
   * Extrude a 2D profile (array of [a, b] in the plane perpendicular to the extrusion axis) along
   * local X by `length`. profile in (z, y) of the frame, extruded from x0 to x0+length.
   */
  extrudeX(mat, profile, x0, length, matrix = null, o = {}) {
    const shape = new THREE.Shape(profile.map(([zz, yy]) => new THREE.Vector2(zz, yy)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false, steps: 1, curveSegments: 4 });
    // ExtrudeGeometry: shape in XY, depth along +Z. Permute to shape.x -> z, shape.y -> y, depth -> x.
    const m = new THREE.Matrix4().set(
      0, 0, 1, x0,
      0, 1, 0, 0,
      1, 0, 0, 0,
      0, 0, 0, 1,
    );
    g.applyMatrix4(m);
    const ni = g.index ? g.toNonIndexed() : g;
    // the permutation mirrors -> flip winding
    const pa = ni.attributes.position.array;
    for (let i = 0; i < pa.length; i += 9) {
      for (let k = 0; k < 3; k++) { const t = pa[i + 3 + k]; pa[i + 3 + k] = pa[i + 6 + k]; pa[i + 6 + k] = t; }
    }
    ni.deleteAttribute('uv');
    ni.deleteAttribute('normal');
    ni.computeVertexNormals();
    this.geometry(mat, ni, matrix, { ...o, uv: 'proj' });
    g.dispose();
    if (ni !== g) ni.dispose();
    return this;
  }

  /**
   * Bevelled extrusion of a 2D side profile (points [x, y] in the frame's XY plane) across Z, centred on
   * z = 0 with total width `width`. o: bevel (m), bevelSeg, crease (rad), taper(y) -> z scale,
   * zScaleFn(x, y) -> z scale, matrix (applied after), ray/move/col/shadow.
   * Smooth (creased) normals so rounded bevels read as rounded.
   */
  extrudeZ(mat, pts, width, o = {}) {
    const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const bev = Math.min(o.bevel ?? 0.03, width * 0.45);
    const depth = Math.max(0.002, width - 2 * bev);
    const g0 = new THREE.ExtrudeGeometry(shape, {
      depth, bevelEnabled: bev > 0, bevelThickness: bev, bevelSize: bev, bevelOffset: -bev,
      bevelSegments: o.bevelSeg ?? 2, curveSegments: 4, steps: 1,
    });
    g0.translate(0, 0, -depth / 2);
    const p = g0.attributes.position;
    if (o.taper || o.zScaleFn) {
      for (let i = 0; i < p.count; i++) {
        let s = 1;
        if (o.taper) s *= o.taper(p.getY(i));
        if (o.zScaleFn) s *= o.zScaleFn(p.getX(i), p.getY(i));
        p.setZ(i, p.getZ(i) * s);
      }
    }
    g0.deleteAttribute('normal');
    g0.deleteAttribute('uv');
    const g = toCreasedNormals(g0, o.crease ?? 0.6);
    this.geometry(mat, g, o.matrix || null, { ...o, uv: 'proj' });
    if (g !== g0) g.dispose();
    g0.dispose();
    return this;
  }

  /** Collision-only triangles (no render): frame-space box. part: {object, material, surface}. */
  colBox(x, y, z, sx, sy, sz, part, { ray = false, move = true, rotY = 0 } = {}) {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    const m = new THREE.Matrix4().makeRotationY(rotY).setPosition(x, y, z);
    const world = new THREE.Matrix4().multiplyMatrices(this.frame, m);
    g.applyMatrix4(world);
    this.colOnly.push({ geo: g, part, ray, move });
    return this;
  }

  /** Collision-only arbitrary world-space geometry (already transformed). */
  colGeometry(geoWorld, part, { ray = true, move = true } = {}) {
    this.colOnly.push({ geo: geoWorld, part, ray, move });
    return this;
  }

  /**
   * Finalize: create meshes. resolveMaterial(matKey) -> {material, surface}. Returns
   * { meshes, parts, rayGeo, moveGeo } where parts[i] = {object, material, surface} and the collision
   * geometries carry a Uint16/32 `part` lookup per vertex in geo.userData.partOfVertex.
   */
  build(resolveMaterial, parent) {
    const meshes = [];
    const parts = [];
    const ray = { pos: [], idx: [], part: [] };
    const move = { pos: [], idx: [], part: [] };
    // merge chunks of lightly used materials into one batch (draw-call budget); heavy ones stay chunked
    const perMat = new Map();
    for (const b of this.batches.values()) {
      const k = `${b.mat}|${b.shadow ? 1 : 0}`;
      if (!perMat.has(k)) perMat.set(k, []);
      perMat.get(k).push(b);
    }
    for (const [k, list] of perMat) {
      const tris = list.reduce((s, b) => s + b.idx.length / 3, 0);
      if (list.length < 2 || tris > this.mergeBelow) continue;
      const m = new Batch(`all|${k}`, 'all', list[0].mat, list[0].shadow);
      for (const b of list) {
        const off = m.vcount;
        for (let i = 0; i < b.pos.length; i++) m.pos.push(b.pos[i]);
        for (let i = 0; i < b.nor.length; i++) m.nor.push(b.nor[i]);
        for (let i = 0; i < b.uv.length; i++) m.uv.push(b.uv[i]);
        for (const i of b.idx) m.idx.push(i + off);
        for (const i of b.rayIdx) m.rayIdx.push(i + off);
        for (const i of b.moveIdx) m.moveIdx.push(i + off);
        m.vcount += b.vcount;
        this.batches.delete(b.key);
      }
      this.batches.set(m.key, m);
    }
    for (const b of this.batches.values()) {
      if (b.vcount === 0) continue;
      const { material, surface } = resolveMaterial(b.mat);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      geo.setIndex(b.vcount > 65535 ? new THREE.Uint32BufferAttribute(b.idx, 1) : new THREE.Uint16BufferAttribute(b.idx, 1));
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = `world:${b.mat}@${b.chunk}`;
      mesh.castShadow = b.shadow;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.userData.surface = surface;
      mesh.userData.static = true;
      mesh.userData.matKey = b.mat;
      parent.add(mesh);
      meshes.push(mesh);
      const partId = parts.length;
      parts.push({ object: mesh, material, surface });
      appendCol(ray, b.pos, b.rayIdx, partId);
      appendCol(move, b.pos, b.moveIdx, partId);
      b.mesh = mesh;
    }
    for (const c of this.colOnly) {
      const partId = parts.length;
      if (c.part && c.part.matKey && !c.part.object) {
        const hit = meshes.find((m) => m.userData.matKey === c.part.matKey);
        if (hit) { c.part.object = hit; c.part.material = hit.material; }
      }
      parts.push(c.part);
      const pa = c.geo.attributes.position.array;
      const ix = c.geo.index ? Array.from(c.geo.index.array) : [...Array(c.geo.attributes.position.count).keys()];
      if (c.ray) appendCol(ray, pa, ix, partId);
      if (c.move) appendCol(move, pa, ix, partId);
      c.geo.dispose();
    }
    this.batches.clear();
    this.colOnly.length = 0;
    return { meshes, parts, rayGeo: toColGeo(ray), moveGeo: toColGeo(move) };
  }
}

function appendCol(acc, pos, idx, partId) {
  if (!idx.length) return;
  // compact: only the referenced vertices
  const remap = new Map();
  for (let i = 0; i < idx.length; i++) {
    const vi = idx[i];
    let r = remap.get(vi);
    if (r === undefined) {
      r = acc.pos.length / 3;
      remap.set(vi, r);
      acc.pos.push(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
      acc.part.push(partId);
    }
    acc.idx.push(r);
  }
}

function toColGeo(acc) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
  const n = acc.pos.length / 3;
  g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(acc.idx, 1) : new THREE.Uint16BufferAttribute(acc.idx, 1));
  g.userData.partOfVertex = n > 0 ? Uint32Array.from(acc.part) : new Uint32Array(0);
  return g;
}

/** Planar projection by dominant normal axis, meters. */
export function projUV(p, n) {
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  if (ay >= ax && ay >= az) return [p.x, -p.z * Math.sign(n.y || 1)];
  if (ax >= az) return [-p.z * Math.sign(n.x), p.y];
  return [p.x * Math.sign(n.z), p.y];
}

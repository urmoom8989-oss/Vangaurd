import * as THREE from 'three';
import { MeshBVH, ExtendedTriangle } from 'three-mesh-bvh';

/**
 * Collision world backed by three-mesh-bvh.
 *   - rayBVH: static triangles for bullets / LOS / ground queries (world space)
 *   - moveBVH: static triangles for capsule collision + navigation (world space)
 *   - dynamic: Meshes added at runtime via addCollider (per-mesh BVH in local space)
 * Hits map back to their render Object3D through a per-vertex part table.
 */
const _ray = new THREE.Ray();
const _box = new THREE.Box3();
const _seg = new THREE.Line3();
const _tri = new ExtendedTriangle();
const _pTri = new THREE.Vector3();
const _pSeg = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _total = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _mid = new THREE.Vector3();
const MAX_TRIS = 256;
const _wb = new THREE.Box3();
const _lb = new THREE.Box3();

export class CollisionWorld {
  constructor() {
    this.rayBVH = null;
    this.moveBVH = null;
    this.rayGeo = null;
    this.moveGeo = null;
    this.parts = [];
    this.dynamic = []; // { mesh, bvh, ray, move }
    // scratch triangle list for capsule tests (flat xyz * 3 per tri)
    this._triBuf = new Float32Array(MAX_TRIS * 9);
    this._triCount = 0;
    this._capA = new THREE.Vector3();
    this._capB = new THREE.Vector3();
  }

  setStatic({ rayGeo, moveGeo, parts }) {
    this.disposeStatic();
    this.parts = parts;
    this.rayGeo = rayGeo;
    this.moveGeo = moveGeo;
    if (rayGeo.attributes.position.count) this.rayBVH = new MeshBVH(rayGeo, { targetLeafSize: 8 });
    if (moveGeo.attributes.position.count) this.moveBVH = new MeshBVH(moveGeo, { targetLeafSize: 8 });
  }

  disposeStatic() {
    this.rayGeo?.dispose();
    this.moveGeo?.dispose();
    this.rayBVH = this.moveBVH = null;
  }

  addDynamic(mesh, { ray = true, move = true } = {}) {
    if (!mesh.geometry || this.dynamic.some((d) => d.mesh === mesh)) return;
    let bvh = mesh.geometry.boundsTree;
    let owned = false;
    if (!bvh) { bvh = new MeshBVH(mesh.geometry); owned = true; }
    this.dynamic.push({ mesh, bvh, owned, ray, move });
  }

  removeDynamic(mesh) {
    const i = this.dynamic.findIndex((d) => d.mesh === mesh);
    if (i >= 0) this.dynamic.splice(i, 1);
  }

  _partHit(geo, hit, dir, ignore) {
    const pov = geo.userData.partOfVertex;
    const part = this.parts[pov[hit.face.a]];
    if (ignore && part && ignore.includes(part.object)) return null;
    const n = hit.face.normal.clone();
    if (n.dot(dir) > 0) n.negate();
    return {
      point: hit.point.clone(),
      normal: n,
      distance: hit.distance,
      object: part?.object || null,
      material: part?.material || null,
      surface: part?.surface || 'default',
      instanceId: part?.instanceId,
    };
  }

  /** Nearest hit or null. */
  raycast(origin, dir, far = 1000, ignore = null) {
    _ray.origin.copy(origin);
    _ray.direction.copy(dir);
    let best = null;
    if (this.rayBVH) {
      if (!ignore || !ignore.length) {
        const h = this.rayBVH.raycastFirst(_ray, THREE.DoubleSide, 0, far);
        if (h) best = this._partHit(this.rayGeo, h, dir, null);
      } else {
        const hs = this.rayBVH.raycast(_ray, THREE.DoubleSide, 0, far);
        hs.sort((a, b) => a.distance - b.distance);
        for (const h of hs) {
          const r = this._partHit(this.rayGeo, h, dir, ignore);
          if (r) { best = r; break; }
        }
      }
    }
    for (const d of this.dynamic) {
      if (!d.ray || !d.mesh.visible && !d.mesh.userData.collideInvisible) continue;
      if (ignore && ignore.includes(d.mesh)) continue;
      const h = this._rayDynamic(d, origin, dir, best ? best.distance : far);
      if (h && (!best || h.distance < best.distance)) best = h;
    }
    return best;
  }

  _rayDynamic(d, origin, dir, far) {
    const m = d.mesh;
    m.updateWorldMatrix(true, false);
    _inv.copy(m.matrixWorld).invert();
    _ray.origin.copy(origin).applyMatrix4(_inv);
    _ray.direction.copy(dir).transformDirection(_inv);
    const scale = _v.copy(dir).transformDirection(_inv).length() || 1;
    void scale;
    const h = d.bvh.raycastFirst(_ray, THREE.DoubleSide, 0, Infinity);
    if (!h) return null;
    const p = h.point.clone().applyMatrix4(m.matrixWorld);
    const dist = p.distanceTo(origin);
    if (dist > far) return null;
    const n = h.face.normal.clone().transformDirection(m.matrixWorld);
    if (n.dot(dir) > 0) n.negate();
    const material = Array.isArray(m.material) ? m.material[0] : m.material;
    return { point: p, normal: n, distance: dist, object: m, material, surface: m.userData.surface || material?.userData?.surface || 'default' };
  }

  raycastAll(origin, dir, far = 1000) {
    _ray.origin.copy(origin);
    _ray.direction.copy(dir);
    const out = [];
    if (this.rayBVH) {
      for (const h of this.rayBVH.raycast(_ray, THREE.DoubleSide, 0, far)) {
        const r = this._partHit(this.rayGeo, h, dir, null);
        if (r) out.push(r);
      }
    }
    for (const d of this.dynamic) {
      if (!d.ray) continue;
      const h = this._rayDynamic(d, origin, dir, far);
      if (h) out.push(h);
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  }

  /** Cheap boolean line-of-sight test (static geometry only). */
  lineOfSight(a, b) {
    if (!this.rayBVH) return true;
    _v2.subVectors(b, a);
    const len = _v2.length();
    if (len < 1e-4) return true;
    _ray.origin.copy(a);
    _ray.direction.copy(_v2).divideScalar(len);
    return !this.rayBVH.raycastFirst(_ray, THREE.DoubleSide, 0, len);
  }

  /** Ground height below (x, fromY, z) against movement geometry (falls back to ray geometry). */
  groundHeight(x, z, fromY = 100, fallback = 0) {
    const bvh = this.moveBVH || this.rayBVH;
    if (!bvh) return fallback;
    _ray.origin.set(x, fromY, z);
    _ray.direction.set(0, -1, 0);
    const h = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, fromY + 60);
    return h ? h.point.y : fallback;
  }

  _gatherStatic(bvh, box) {
    const buf = this._triBuf;
    const self = this;
    bvh.shapecast({
      intersectsBounds: (b) => b.intersectsBox(box),
      intersectsTriangle: (tri) => {
        if (self._triCount >= MAX_TRIS) return true;
        // quick reject: triangle aabb
        const o = self._triCount * 9;
        buf[o] = tri.a.x; buf[o + 1] = tri.a.y; buf[o + 2] = tri.a.z;
        buf[o + 3] = tri.b.x; buf[o + 4] = tri.b.y; buf[o + 5] = tri.b.z;
        buf[o + 6] = tri.c.x; buf[o + 7] = tri.c.y; buf[o + 8] = tri.c.z;
        self._triCount++;
        return false;
      },
    });
  }

  /**
   * Octree-compatible capsule collision: returns { normal, depth } (translate capsule by normal*depth)
   * or false. The returned object is reused per call: copy what you keep.
   */
  collideCapsule(capsule) {
    const r = capsule.radius;
    const a = this._capA.copy(capsule.start);
    const b = this._capB.copy(capsule.end);
    _box.makeEmpty();
    _box.expandByPoint(a); _box.expandByPoint(b);
    _box.expandByScalar(r + 0.02);
    this._triCount = 0;
    if (this.moveBVH) this._gatherStatic(this.moveBVH, _box);
    // dynamic colliders: transform triangles to world
    for (const d of this.dynamic) {
      if (!d.move) continue;
      const m = d.mesh;
      m.updateWorldMatrix(true, false);
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      _v.copy(m.geometry.boundingBox.min); _v2.copy(m.geometry.boundingBox.max);
      const wb = _wb.set(_v, _v2).applyMatrix4(m.matrixWorld);
      if (!wb.intersectsBox(_box)) continue;
      _inv.copy(m.matrixWorld).invert();
      const lb = _lb.copy(_box).applyMatrix4(_inv);
      const buf = this._triBuf;
      const self = this;
      const mw = m.matrixWorld;
      d.bvh.shapecast({
        intersectsBounds: (bb) => bb.intersectsBox(lb),
        intersectsTriangle: (tri) => {
          if (self._triCount >= MAX_TRIS) return true;
          const o = self._triCount * 9;
          _v.copy(tri.a).applyMatrix4(mw); buf[o] = _v.x; buf[o + 1] = _v.y; buf[o + 2] = _v.z;
          _v.copy(tri.b).applyMatrix4(mw); buf[o + 3] = _v.x; buf[o + 4] = _v.y; buf[o + 5] = _v.z;
          _v.copy(tri.c).applyMatrix4(mw); buf[o + 6] = _v.x; buf[o + 7] = _v.y; buf[o + 8] = _v.z;
          self._triCount++;
          return false;
        },
      });
    }
    if (!this._triCount) return false;
    _total.set(0, 0, 0);
    let hit = false;
    const buf = this._triBuf;
    // two passes for stability (like pushing out of corners)
    for (let pass = 0; pass < 2; pass++) {
      let any = false;
      for (let t = 0; t < this._triCount; t++) {
        const o = t * 9;
        _tri.a.set(buf[o], buf[o + 1], buf[o + 2]);
        _tri.b.set(buf[o + 3], buf[o + 4], buf[o + 5]);
        _tri.c.set(buf[o + 6], buf[o + 7], buf[o + 8]);
        _tri.needsUpdate = true;
        _seg.start.copy(a); _seg.end.copy(b);
        const dist = _tri.closestPointToSegment(_seg, _pTri, _pSeg);
        if (dist >= r) continue;
        _tri.getNormal(_nrm);
        let depth;
        if (dist > 1e-5) {
          _delta.subVectors(_pSeg, _pTri).divideScalar(dist);
          depth = r - dist;
          // if we're behind a one-sided face (inside geometry) favour the face normal
          if (_delta.dot(_nrm) < -0.2) {
            _mid.addVectors(a, b).multiplyScalar(0.5);
            const sd = _v.subVectors(_mid, _tri.a).dot(_nrm);
            if (sd < 0) continue; // fully behind this face: let other faces resolve it
          }
        } else {
          // segment passes through the triangle: push along face normal towards the capsule center
          _mid.addVectors(a, b).multiplyScalar(0.5);
          const sd = _v.subVectors(_mid, _tri.a).dot(_nrm);
          _delta.copy(_nrm);
          if (sd < 0) continue;
          // depth: distance the lower endpoint must move along normal to clear by r
          const da = _v.subVectors(a, _tri.a).dot(_nrm), db = _v2.subVectors(b, _tri.a).dot(_nrm);
          depth = r - Math.min(da, db);
        }
        if (depth <= 1e-5) continue;
        a.addScaledVector(_delta, depth);
        b.addScaledVector(_delta, depth);
        _total.addScaledVector(_delta, depth);
        hit = any = true;
      }
      if (!any) break;
    }
    if (!hit) return false;
    const depth = _total.length();
    if (depth < 1e-6) return false;
    // Reused result object (no per-frame allocation): copy what you keep.
    const res = this._result || (this._result = { normal: new THREE.Vector3(), depth: 0 });
    res.normal.copy(_total).divideScalar(depth);
    res.depth = depth;
    return res;
  }

  /** Is an axis-aligned box free of movement geometry? */
  boxFree(box) {
    if (!this.moveBVH) return true;
    return !this.moveBVH.shapecast({
      intersectsBounds: (b) => b.intersectsBox(box),
      intersectsTriangle: (tri) => triBoxOverlap(tri, box),
    });
  }

  dispose() {
    this.disposeStatic();
    this.dynamic.length = 0;
  }
}

// Triangle / AABB overlap (separating axis test)
const _c = new THREE.Vector3(), _e = new THREE.Vector3();
const _t0 = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3();
const _f0 = new THREE.Vector3(), _f1 = new THREE.Vector3(), _f2 = new THREE.Vector3();
const _ax = new THREE.Vector3(), _tn = new THREE.Vector3();
function axisTest(ax) {
  if (ax.lengthSq() < 1e-12) return true;
  const p0 = _t0.dot(ax), p1 = _t1.dot(ax), p2 = _t2.dot(ax);
  const r = _e.x * Math.abs(ax.x) + _e.y * Math.abs(ax.y) + _e.z * Math.abs(ax.z);
  return !(Math.max(p0, p1, p2) < -r || Math.min(p0, p1, p2) > r);
}
export function triBoxOverlap(tri, box) {
  box.getCenter(_c); box.getSize(_e).multiplyScalar(0.5);
  _t0.subVectors(tri.a, _c); _t1.subVectors(tri.b, _c); _t2.subVectors(tri.c, _c);
  _f0.subVectors(_t1, _t0); _f1.subVectors(_t2, _t1); _f2.subVectors(_t0, _t2);
  const fs = [_f0, _f1, _f2];
  const es = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (const e of es) {
    for (const f of fs) {
      _ax.set(e[1] * f.z - e[2] * f.y, e[2] * f.x - e[0] * f.z, e[0] * f.y - e[1] * f.x);
      if (!axisTest(_ax)) return false;
    }
  }
  if (Math.max(_t0.x, _t1.x, _t2.x) < -_e.x || Math.min(_t0.x, _t1.x, _t2.x) > _e.x) return false;
  if (Math.max(_t0.y, _t1.y, _t2.y) < -_e.y || Math.min(_t0.y, _t1.y, _t2.y) > _e.y) return false;
  if (Math.max(_t0.z, _t1.z, _t2.z) < -_e.z || Math.min(_t0.z, _t1.z, _t2.z) > _e.z) return false;
  _tn.crossVectors(_f0, _f1);
  return axisTest(_tn);
}

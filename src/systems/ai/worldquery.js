import * as THREE from 'three';

/**
 * Thin adapter over services.world for AI queries. Uses the world's cheap extensions when present
 * (lineOfSight, BVH capsule collision, nav extras) and degrades to the documented contract.
 * All methods are allocation-free except where world.raycast itself allocates its Hit.
 */

const _v = new THREE.Vector3();
const _cap = { start: new THREE.Vector3(), end: new THREE.Vector3(), radius: 0.1 };
const DOWN = new THREE.Vector3(0, -1, 0);

export class WorldQuery {
  constructor(ctx) { this.ctx = ctx; }
  get world() { return this.ctx.services.world; }

  /** true when the segment a->b is unobstructed by static geometry */
  los(a, b) {
    const w = this.world;
    if (w.lineOfSight) return w.lineOfSight(a, b);
    _v.subVectors(b, a);
    const d = _v.length();
    if (d < 1e-4) return true;
    _v.divideScalar(d);
    return !w.raycast(a, _v, d - 0.05);
  }

  /** distance of the first hit or -1; optional normal output */
  raycast(origin, dir, far, outN = null, outP = null) {
    const h = this.world.raycast(origin, dir, far);
    if (!h) return -1;
    if (outN) outN.copy(h.normal);
    if (outP) outP.copy(h.point);
    return h.distance;
  }

  ground(x, z, fromY, fallback = 0) {
    const w = this.world;
    const y = w.groundHeight(x, z, fromY);
    return Number.isFinite(y) ? y : fallback;
  }

  /** Foot-plant ground height (same as ground(); separate hook so it can be cached/cheapened). */
  groundFast(x, z, y) { return this.ground(x, z, y + 0.6, y); }

  /** Sphere push-out against the world: returns depth (>0) and writes out.normal */
  sphere(center, radius, out) {
    _cap.start.copy(center);
    _cap.end.copy(center); _cap.end.y += 0.002;
    _cap.radius = radius;
    const r = this.world.collideCapsule(_cap);
    if (!r) return 0;
    out.normal.copy(r.normal);
    return r.depth;
  }

  /** Capsule push-out (feet at p, height h). Moves p in place; returns true if collided. */
  pushCapsule(p, radius, h) {
    let hit = false;
    for (let i = 0; i < 2; i++) {
      _cap.start.set(p.x, p.y + radius + 0.35, p.z);
      _cap.end.set(p.x, p.y + h - radius, p.z);
      _cap.radius = radius;
      const r = this.world.collideCapsule(_cap);
      if (!r) break;
      // horizontal push only (ground height handled separately)
      _v.copy(r.normal); _v.y = 0;
      const l = _v.length();
      if (l < 1e-4) break;
      p.addScaledVector(_v.divideScalar(l), r.depth * Math.min(1, l * 1.2));
      hit = true;
    }
    return hit;
  }

  isWalkable(x, z) { const n = this.world.nav; return n.isWalkable ? n.isWalkable(x, z) : true; }
  nearestWalkable(p, out) { const n = this.world.nav; return n.nearestWalkable ? n.nearestWalkable(p, out) : out.copy(p); }
  findPath(a, b) { return this.world.nav.findPath(a, b); }
  get coverPoints() { return this.world.coverPoints || this.world.nav?.coverPoints || []; }
}

export { DOWN };

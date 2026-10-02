import * as THREE from 'three';

/**
 * Cover database built from services.world.coverPoints ({position, normal (away from cover),
 * height 'low'|'high'}), bucketed on a 4 m grid. Each entry is augmented lazily with peek
 * positions (sides of high cover). Agents claim covers so squadmates spread out.
 *
 * Selection scores protection against the threat (normal vs threat direction + verified line of
 * sight blocked at hide height), ability to fire from the peek position, travel distance, preferred
 * engagement range, squad spacing, and an optional flank bias.
 */

const CELL = 4;
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _tan = new THREE.Vector3();

export class CoverManager {
  constructor(wq) {
    this.wq = wq;
    this.points = [];
    this.grid = new Map();
    this.builtFrom = null;
  }

  rebuild() {
    const src = this.wq.coverPoints;
    this.builtFrom = src;
    this.points = [];
    this.grid.clear();
    for (const c of src) {
      const e = {
        pos: c.position.clone(),
        normal: c.normal.clone().setY(0).normalize(),
        high: c.height === 'high',
        claim: null,
        claimT: 0,
        peek: null, // resolved lazily: [{pos, side}]
      };
      this.points.push(e);
      const k = this.key(e.pos.x, e.pos.z);
      let l = this.grid.get(k);
      if (!l) this.grid.set(k, (l = []));
      l.push(e);
    }
  }

  ensure() { if (this.builtFrom !== this.wq.coverPoints) this.rebuild(); }

  key(x, z) { return `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`; }

  query(center, radius, out) {
    out.length = 0;
    const r = Math.ceil(radius / CELL);
    const cx = Math.floor(center.x / CELL), cz = Math.floor(center.z / CELL);
    const r2 = radius * radius;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const l = this.grid.get(`${cx + dx},${cz + dz}`);
      if (!l) continue;
      for (const e of l) {
        const ddx = e.pos.x - center.x, ddz = e.pos.z - center.z;
        if (ddx * ddx + ddz * ddz <= r2) out.push(e);
      }
    }
    return out;
  }

  /** Peek positions for high cover (step out to the side); low cover peeks by standing up. */
  peeks(e) {
    if (e.peek) return e.peek;
    e.peek = [];
    if (!e.high) { e.peek.push({ pos: e.pos.clone(), side: 0 }); return e.peek; }
    _tan.set(-e.normal.z, 0, e.normal.x);
    for (const side of [1, -1]) {
      for (const off of [0.75, 1.05]) {
        _a.copy(e.pos).addScaledVector(_tan, side * off);
        if (!this.wq.isWalkable(_a.x, _a.z)) continue;
        // the wall must end: a ray from the side position towards the cover direction is free
        _b.copy(_a); _b.y += 1.45;
        _c.copy(e.normal).negate();
        if (this.wq.raycast(_b, _c, 1.3) >= 0) continue;
        e.peek.push({ pos: _a.clone(), side });
        break;
      }
    }
    return e.peek;
  }

  claim(e, agent, t) { if (e) { e.claim = agent; e.claimT = t; } }
  release(e, agent) { if (e && e.claim === agent) e.claim = null; }

  /**
   * Pick the best cover for `agent` against a threat at `threat` (eye position).
   * opts: {maxDist, flankFrom (Vector3 squad centroid) , minRange, maxRange, t, squad}
   */
  select(agent, threat, opts, scratch) {
    this.ensure();
    const from = agent.position;
    const cands = this.query(from, opts.maxDist ?? 22, scratch);
    let best = null, bestS = -Infinity, bestPeek = null;
    const scored = [];
    for (const e of cands) {
      if (e.claim && e.claim !== agent && e.claim.alive) continue;
      _a.subVectors(threat, e.pos); _a.y = 0;
      const dT = _a.length();
      if (dT < (opts.minRange ?? 6) || dT > (opts.maxRange ?? 45)) continue;
      _a.divideScalar(dT);
      // protection: cover must be between us and the threat (normal points away from the cover)
      const prot = -e.normal.dot(_a);
      if (prot < 0.45) continue;
      const dMe = e.pos.distanceTo(from);
      let s = prot * 3 - dMe * 0.12;
      const ideal = opts.idealRange ?? 20;
      s -= Math.abs(dT - ideal) * 0.06;
      if (e.high) s += 0.3;
      // spacing from squadmates' covers / positions
      if (opts.squad) {
        for (const m of opts.squad.members) {
          if (m === agent || !m.alive) continue;
          const mp = m.cover ? m.cover.pos : m.position;
          const d = mp.distanceTo(e.pos);
          if (d < 3) s -= (3 - d) * 1.2;
        }
      }
      if (opts.flankFrom) {
        _b.subVectors(opts.flankFrom, threat); _b.y = 0; _b.normalize();
        const ang = Math.acos(Math.max(-1, Math.min(1, -_a.dot(_b))));
        s += ang * 2.2;
      }
      if (opts.advance) s -= dT * 0.08;
      if (opts.retreat) s += dT * 0.06;
      scored.push([s, e]);
    }
    scored.sort((x, y) => y[0] - x[0]);
    // verify the top few with line-of-sight checks
    let checks = 0;
    for (const [s, e] of scored) {
      if (checks++ > 6) break;
      // hidden when crouched (low) / flush (high)
      _b.copy(e.pos); _b.y += e.high ? 1.5 : 0.85;
      if (this.wq.los(_b, threat)) continue; // not actually protected
      // can fire from a peek position
      const peeks = this.peeks(e);
      let pk = null;
      for (const p of peeks) {
        _c.copy(p.pos); _c.y += 1.45;
        if (this.wq.los(_c, threat)) { pk = p; break; }
      }
      const sc = s + (pk ? 1.2 : -1.5);
      if (sc > bestS) { bestS = sc; best = e; bestPeek = pk; }
      if (pk) break;
    }
    if (!best) return null;
    return { cover: best, peek: bestPeek, score: bestS };
  }
}

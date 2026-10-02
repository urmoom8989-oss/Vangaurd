import * as THREE from 'three';

/**
 * Grid navigation over the movement collision geometry.
 *  - cell size 0.5 m over the playable bounds; each cell stores ground height and walkability
 *    (capsule-sized clearance box free of geometry, slope/step limits to neighbours)
 *  - 8-connected A* with a binary heap, then string-pulling via grid line-of-sight
 *  - cover points: walkable cells next to solid geometry, with the cover normal and a low/high flag
 */
export class NavGrid {
  constructor(col, { min = -70, max = 70, cell = 0.5, radius = 0.4, step = 0.45 } = {}) {
    this.col = col;
    this.min = min;
    this.cell = cell;
    this.n = Math.ceil((max - min) / cell);
    this.radius = radius;
    this.step = step;
    const N = this.n * this.n;
    this.h = new Float32Array(N);
    this.walk = new Uint8Array(N);
    this.region = new Int32Array(N);
    this.coverPoints = [];
    // A* scratch
    this._g = new Float32Array(N);
    this._f = new Float32Array(N);
    this._from = new Int32Array(N);
    this._stamp = new Uint32Array(N);
    this._closed = new Uint32Array(N);
    this._stampId = 1;
    this._heap = new Int32Array(N);
  }

  idx(ix, iz) { return iz * this.n + ix; }
  cx(ix) { return this.min + (ix + 0.5) * this.cell; }
  toI(x) { return Math.floor((x - this.min) / this.cell); }

  build() {
    const { n, col, cell, radius } = this;
    const box = new THREE.Box3();
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = this.idx(ix, iz);
        const x = this.cx(ix), z = this.cx(iz);
        const y = col.groundHeight(x, z, 30, -999);
        this.h[i] = y;
        if (y < -50) { this.walk[i] = 0; continue; }
        box.min.set(x - radius, y + 0.5, z - radius);
        box.max.set(x + radius, y + 1.7, z + radius);
        this.walk[i] = col.boxFree(box) ? 1 : 0;
      }
    }
    // step constraint: a cell is only walkable if some neighbour is within step height (removes rooftops-on-props noise)
    // regions: flood fill connectivity so randomPoint picks the main region
    this.region.fill(-1);
    let best = -1, bestSize = 0, rid = 0;
    const stack = [];
    for (let s = 0; s < n * n; s++) {
      if (!this.walk[s] || this.region[s] >= 0) continue;
      let size = 0;
      stack.push(s);
      this.region[s] = rid;
      while (stack.length) {
        const c = stack.pop();
        size++;
        const cx = c % n, cz = (c / n) | 0;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
          const j = nz * n + nx;
          if (!this.walk[j] || this.region[j] >= 0) continue;
          if (!this._canStep(c, j, dx, dz)) continue;
          this.region[j] = rid;
          stack.push(j);
        }
      }
      if (size > bestSize) { bestSize = size; best = rid; }
      rid++;
    }
    this.mainRegion = best;
    this.walkableCells = [];
    for (let s = 0; s < n * n; s++) if (this.region[s] === best) this.walkableCells.push(s);
    this._buildCover();
  }

  _canStep(a, b, dx, dz) {
    if (Math.abs(this.h[a] - this.h[b]) > this.step) return false;
    if (dx && dz) {
      // no corner cutting
      const n = this.n;
      const ax = a % n, az = (a / n) | 0;
      if (!this.walk[az * n + ax + dx] || !this.walk[(az + dz) * n + ax]) return false;
    }
    return true;
  }

  _buildCover() {
    const { n, col } = this;
    const o = new THREE.Vector3(), dir = new THREE.Vector3();
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let iz = 1; iz < n - 1; iz += 2) {
      for (let ix = 1; ix < n - 1; ix += 2) {
        const i = this.idx(ix, iz);
        if (this.region[i] !== this.mainRegion) continue;
        for (const [dx, dz] of dirs) {
          const j = this.idx(ix + dx * 2, iz + dz * 2);
          if (this.walk[j]) continue;
          const y = this.h[i];
          o.set(this.cx(ix), y + 0.6, this.cx(iz));
          dir.set(dx, 0, dz);
          const low = col.raycast(o, dir, 1.4);
          if (!low) continue;
          o.y = y + 1.45;
          const high = col.raycast(o, dir, 1.4);
          this.coverPoints.push({
            position: new THREE.Vector3(this.cx(ix), y, this.cx(iz)),
            normal: new THREE.Vector3(-dx, 0, -dz), // points away from the cover
            height: high ? 'high' : 'low',
          });
          break;
        }
      }
    }
  }

  cellAt(x, z) {
    const ix = this.toI(x), iz = this.toI(z);
    if (ix < 0 || iz < 0 || ix >= this.n || iz >= this.n) return -1;
    return this.idx(ix, iz);
  }

  isWalkable(x, z) {
    const c = this.cellAt(x, z);
    return c >= 0 && this.region[c] === this.mainRegion;
  }

  /** Nearest walkable (main region) cell to (x,z) within a search radius (cells). */
  nearest(x, z, maxR = 12) {
    const n = this.n;
    let ix = Math.min(n - 1, Math.max(0, this.toI(x))), iz = Math.min(n - 1, Math.max(0, this.toI(z)));
    const c0 = this.idx(ix, iz);
    if (this.region[c0] === this.mainRegion) return c0;
    for (let r = 1; r <= maxR; r++) {
      let best = -1, bd = Infinity;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const nx = ix + dx, nz = iz + dz;
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
        const j = this.idx(nx, nz);
        if (this.region[j] !== this.mainRegion) continue;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = j; }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** Line walk on the grid (for smoothing). */
  _clear(a, b) {
    const n = this.n;
    let x0 = a % n, z0 = (a / n) | 0;
    const x1 = b % n, z1 = (b / n) | 0;
    const dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0);
    const sx = x0 < x1 ? 1 : -1, sz = z0 < z1 ? 1 : -1;
    let err = dx - dz;
    let prev = a;
    for (;;) {
      const c = z0 * n + x0;
      if (this.region[c] !== this.mainRegion) return false;
      if (Math.abs(this.h[c] - this.h[prev]) > this.step) return false;
      prev = c;
      if (x0 === x1 && z0 === z1) return true;
      const e2 = 2 * err;
      if (e2 > -dz && e2 < dx) {
        // diagonal move: require both orthogonal neighbours (thick line)
        if (this.region[z0 * n + x0 + sx] !== this.mainRegion || this.region[(z0 + sz) * n + x0] !== this.mainRegion) return false;
      }
      if (e2 > -dz) { err -= dz; x0 += sx; }
      if (e2 < dx) { err += dx; z0 += sz; }
    }
  }

  findPath(from, to, maxIter = 60000) {
    const n = this.n;
    const s = this.nearest(from.x, from.z), t = this.nearest(to.x, to.z);
    if (s < 0 || t < 0) return [from.clone(), to.clone()];
    if (s === t) return [from.clone(), to.clone()];
    const stamp = ++this._stampId;
    const g = this._g, f = this._f, fromA = this._from, st = this._stamp, closed = this._closed, heap = this._heap;
    let hs = 0;
    const tx = t % n, tz = (t / n) | 0;
    const hfun = (c) => {
      const dx = Math.abs((c % n) - tx), dz = Math.abs(((c / n) | 0) - tz);
      return (dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz));
    };
    const push = (c) => {
      let i = hs++;
      heap[i] = c;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (f[heap[p]] <= f[heap[i]]) break;
        const tmp = heap[p]; heap[p] = heap[i]; heap[i] = tmp; i = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      heap[0] = heap[--hs];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < hs && f[heap[l]] < f[heap[m]]) m = l;
        if (r < hs && f[heap[r]] < f[heap[m]]) m = r;
        if (m === i) break;
        const tmp = heap[m]; heap[m] = heap[i]; heap[i] = tmp; i = m;
      }
      return top;
    };
    st[s] = stamp; g[s] = 0; f[s] = hfun(s); fromA[s] = -1;
    push(s);
    let found = false, iter = 0;
    while (hs > 0 && iter++ < maxIter) {
      const c = pop();
      if (closed[c] === stamp) continue;
      closed[c] = stamp;
      if (c === t) { found = true; break; }
      const cx = c % n, cz = (c / n) | 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
        const j = nz * n + nx;
        if (this.region[j] !== this.mainRegion || closed[j] === stamp) continue;
        if (!this._canStep(c, j, dx, dz)) continue;
        const ng = g[c] + (dx && dz ? Math.SQRT2 : 1);
        if (st[j] !== stamp || ng < g[j]) {
          st[j] = stamp; g[j] = ng; f[j] = ng + hfun(j); fromA[j] = c;
          push(j);
        }
      }
    }
    if (!found) return [from.clone(), to.clone()];
    const cells = [];
    for (let c = t; c !== -1; c = fromA[c]) cells.push(c);
    cells.reverse();
    // string pulling
    const out = [from.clone()];
    let anchor = 0;
    for (let i = 2; i < cells.length; i++) {
      if (!this._clear(cells[anchor], cells[i])) {
        const c = cells[i - 1];
        out.push(new THREE.Vector3(this.cx(c % n), this.h[c], this.cx((c / n) | 0)));
        anchor = i - 1;
      }
    }
    out.push(to.clone());
    return out;
  }

  randomPoint(out, rng) {
    const cells = this.walkableCells;
    if (!cells.length) return out.set(0, 0, 0);
    const c = cells[Math.floor(rng.next() * cells.length)];
    const n = this.n;
    return out.set(this.cx(c % n), this.h[c], this.cx((c / n) | 0));
  }
}

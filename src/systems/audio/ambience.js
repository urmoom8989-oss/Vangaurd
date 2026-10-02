/**
 * audio/ambience.js — AmbienceDirector: runs the ambient bed around the listener.
 *   - loops: wind (2D stereo), distant war bed (2D stereo), fire crackle at world fire emitters (3D)
 *   - spot events scattered in 3D around the listener with seeded timing: distant artillery (with real
 *     speed-of-sound delay, seconds later), distant rifle/MG bursts, birds on rooftops (they go quiet
 *     while the fight is hot), tarp flaps (at world tarp/awning emitters when known), creaking metal,
 *     settling debris.
 * `intensity` (0..1, combat heat) shifts the balance: more distant fighting, fewer birds.
 * Allocation-free per update (positions are preallocated scratch objects).
 */
const TAU = Math.PI * 2;

const SPOTS = [
  // name, [minGap, maxGap] s, [minDist, maxDist] m, height offset range
  { key: 'artillery', names: ['amb_artillery_far'], gap: [10, 26], dist: [700, 2600], h: [0, 40], vol: [0.6, 1] },
  { key: 'gunfire', names: ['amb_gunfire_far', 'amb_gunfire_far', 'amb_mg_far'], gap: [4, 13], dist: [160, 750], h: [0, 15], vol: [0.5, 1] },
  { key: 'birds', names: ['amb_birds'], gap: [7, 20], dist: [14, 60], h: [6, 16], vol: [0.5, 1], calm: true },
  { key: 'tarp', names: ['amb_tarp'], gap: [6, 16], dist: [8, 30], h: [1, 6], vol: [0.6, 1], emitters: 'tarp' },
  { key: 'creak', names: ['amb_metal_creak'], gap: [14, 34], dist: [10, 40], h: [2, 10], vol: [0.5, 1] },
  { key: 'debris', names: ['amb_debris'], gap: [12, 30], dist: [5, 25], h: [0, 6], vol: [0.4, 1] },
];

export class AmbienceDirector {
  constructor(engine, rng) {
    this.eng = engine;
    this.rng = rng;
    this.next = new Float64Array(SPOTS.length);
    this.loops = { wind: null, bed: null };
    this.fires = []; // { pos, handle }
    this.tarps = []; // positions
    this.intensity = 0;
    this.started = false;
    this.enabled = true;
    this._p = { x: 0, y: 0, z: 0 };
    this.level = 1;
  }

  setEmitters({ fires = [], tarps = [] } = {}) {
    for (const f of this.fires) f.handle?.stop(0.5);
    this.fires = fires.slice(0, 8).map((p) => ({ pos: { x: p.x, y: p.y, z: p.z }, handle: null }));
    this.tarps = tarps.slice(0, 16).map((p) => ({ x: p.x, y: p.y, z: p.z }));
  }

  start(t, fade = 4) {
    if (this.started) return;
    this.started = true;
    const e = this.eng;
    this.loops.wind = e.play('amb_wind', { loop: true, at: t, fadeIn: fade, offset: this.rng.next() * 20 });
    this.loops.bed = e.play('amb_bed', { loop: true, at: t, fadeIn: fade * 1.5, offset: this.rng.next() * 25 });
    for (let i = 0; i < SPOTS.length; i++) this.next[i] = t + this.rng.next() * SPOTS[i].gap[0] * 0.8 + 1;
  }

  stop(fade = 1.5) {
    if (!this.started) return;
    this.started = false;
    this.loops.wind?.stop(fade); this.loops.bed?.stop(fade);
    this.loops.wind = this.loops.bed = null;
    for (const f of this.fires) { f.handle?.stop(fade); f.handle = null; }
  }

  /** Pick a point around the listener at a distance range and height range. */
  _around(dist, h) {
    const L = this.eng.listener.pos;
    const a = this.rng.next() * TAU;
    const d = dist[0] + (dist[1] - dist[0]) * Math.pow(this.rng.next(), 0.8);
    const p = this._p;
    p.x = L.x + Math.cos(a) * d; p.z = L.z + Math.sin(a) * d; p.y = L.y + h[0] + (h[1] - h[0]) * this.rng.next();
    return p;
  }

  /** t = engine time (seconds). Call ~every frame (cheap). */
  update(t) {
    if (!this.started || !this.enabled) return;
    const e = this.eng;
    const heat = this.intensity;
    for (let i = 0; i < SPOTS.length; i++) {
      if (t < this.next[i]) continue;
      const S = SPOTS[i];
      let gapScale = 1;
      if (S.key === 'gunfire') gapScale = 1 - 0.5 * heat;
      if (S.calm) gapScale = 1 + 3 * heat;
      this.next[i] = t + (S.gap[0] + (S.gap[1] - S.gap[0]) * this.rng.next()) * gapScale;
      if (S.calm && heat > 0.6) continue; // birds have fled
      let p;
      if (S.emitters === 'tarp' && this.tarps.length && this.rng.next() < 0.8) {
        // nearest-ish tarp emitter within range
        const L = e.listener.pos;
        let best = null, bd = 1e9;
        for (const q of this.tarps) {
          const d = Math.hypot(q.x - L.x, q.z - L.z) * (0.6 + this.rng.next() * 0.8);
          if (d < bd) { bd = d; best = q; }
        }
        if (best && bd < 60) { this._p.x = best.x; this._p.y = best.y; this._p.z = best.z; p = this._p; }
      }
      if (!p) p = this._around(S.dist, S.h);
      const name = S.names[Math.floor(this.rng.next() * S.names.length)];
      const vol = (S.vol[0] + (S.vol[1] - S.vol[0]) * this.rng.next()) * this.level;
      e.play(name, { position: p, at: t, volume: vol });
    }
    // fire emitters: keep loops alive within range
    for (const f of this.fires) {
      const d = e.distanceTo(f.pos);
      if (d < 32 && !f.handle) f.handle = e.play('amb_fire', { position: f.pos, loop: true, at: t, fadeIn: 1.5, offset: this.rng.next() * 8 });
      else if (d > 40 && f.handle) { f.handle.stop(1.5); f.handle = null; }
    }
  }
}

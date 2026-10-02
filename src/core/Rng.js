/**
 * Seeded RNG (sfc32). Use ctx.rng everywhere instead of Math.random so shots are deterministic.
 * Prefer ctx.rng.fork('<system>') per system: each fork is an independent stream derived from the
 * root seed + name, so one system consuming more numbers never changes another system's output.
 */
function hashString(str) {
  // xmur3
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

export class Rng {
  constructor(seed = 1337) {
    this.seed = seed;
    const s = hashString(String(seed));
    this._a = s(); this._b = s(); this._c = s(); this._d = s();
    for (let i = 0; i < 12; i++) this.next();
  }

  /** @returns {number} float in [0, 1) */
  next() {
    let a = this._a, b = this._b, c = this._c, d = this._d;
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    this._a = a; this._b = b; this._c = c; this._d = d;
    return (t >>> 0) / 4294967296;
  }

  /** float in [min, max) */
  range(min, max) { return min + (max - min) * this.next(); }
  /** integer in [min, max] inclusive */
  int(min, max) { return min + Math.floor(this.next() * (max - min + 1)); }
  /** true with probability p */
  chance(p = 0.5) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  /** standard normal via Box-Muller */
  gaussian(mean = 0, std = 1) {
    const u = 1 - this.next(), v = this.next();
    return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** random point on unit sphere written into `out` ({x,y,z}) */
  onSphere(out) {
    const z = this.range(-1, 1), a = this.range(0, Math.PI * 2), r = Math.sqrt(1 - z * z);
    out.x = r * Math.cos(a); out.y = r * Math.sin(a); out.z = z;
    return out;
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }
  /** Independent deterministic sub-stream. */
  fork(name) { return new Rng(`${this.seed}:${name}`); }
}

/** Stateless hash noise helpers (useful for per-instance variation). */
export function hash01(x, y = 0, z = 0) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

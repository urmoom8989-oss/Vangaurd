/**
 * player/springs.js — tiny allocation-free animation helpers (deterministic, dt-stable).
 */

/** Damped harmonic spring on a scalar. x follows `target`; impulses go into v. */
export class Spring {
  constructor(omega = 12, zeta = 0.7, x = 0) {
    this.omega = omega;
    this.zeta = zeta;
    this.x = x;
    this.v = 0;
    this.target = x;
  }
  reset(x = 0) { this.x = x; this.v = 0; this.target = x; }
  impulse(v) { this.v += v; }
  /** Semi-implicit Euler with ≤ 1/240 s substeps: stable for any frame time up to 0.1 s. */
  update(dt) {
    if (dt <= 0) return this.x;
    const n = Math.min(24, Math.ceil(dt * 240));
    const h = dt / n;
    const w = this.omega, z = this.zeta;
    for (let i = 0; i < n; i++) {
      const a = -2 * z * w * this.v - w * w * (this.x - this.target);
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

/** Frame-rate independent exponential approach factor. */
export function damp(rate, dt) { return 1 - Math.exp(-rate * dt); }

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function saturate(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
export function smoothstep(a, b, x) { const t = saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function easeOutCubic(t) { t = saturate(t); const u = 1 - t; return 1 - u * u * u; }
export function easeInOutCubic(t) { t = saturate(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
export function easeOutBack(t, s = 1.4) { t = saturate(t) - 1; return 1 + t * t * ((s + 1) * t + s); }

/**
 * Seeded 1-D gradient noise (smooth, zero-mean, roughly in [-1, 1]). Deterministic: the gradient table
 * comes from a forked Rng, the input is simulation time.
 */
export class Noise1D {
  constructor(rng, size = 256) {
    this.size = size;
    this.g = new Float32Array(size);
    for (let i = 0; i < size; i++) this.g[i] = rng.next() * 2 - 1;
  }
  sample(x) {
    const i0 = Math.floor(x);
    const f = x - i0;
    const m = this.size - 1;
    const a = this.g[i0 & m] * f;
    const b = this.g[(i0 + 1) & m] * (f - 1);
    const u = f * f * f * (f * (f * 6 - 15) + 10);
    return (a + (b - a) * u) * 2.2;
  }
}

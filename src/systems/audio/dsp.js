/**
 * audio/dsp.js — sample-level DSP toolbox used to synthesize (bake) every sound in the game.
 *
 * Pure JS, no DOM / WebAudio / three imports, so it runs identically in the bake Web Worker, on the
 * main thread (renderOffline) and in node. Everything is deterministic: randomness comes only from the
 * seeded RNG below (never Math.random).
 *
 * Conventions: signals are Float32Array, time in seconds, `sr` = sample rate. Helpers that "add" write
 * into an existing destination buffer (mix-in), helpers that "process" filter in place and return it.
 */

// ------------------------------------------------------------------------------------------ RNG
export function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return h >>> 0;
}

/** mulberry32-based deterministic RNG. */
export class Rand {
  constructor(seed) {
    this.s = (typeof seed === 'string' ? hashStr(seed) : seed >>> 0) || 0x9e3779b9;
  }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
  chance(p) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  bi() { return this.next() * 2 - 1; }
  gauss() {
    const u = 1 - this.next(), v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** multiplicative jitter: v * (1 ± amt) */
  jit(v, amt) { return v * (1 + (this.next() * 2 - 1) * amt); }
  fork(tag) { return new Rand(hashStr(`${this.s}:${tag}`)); }
}

// ------------------------------------------------------------------------------------------ buffers
export const samples = (sr, sec) => Math.max(1, Math.ceil(sr * sec));
export const buf = (sr, sec) => new Float32Array(samples(sr, sec));
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(1e-12, g));
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

/** dst[offset + i] += src[i] * gain */
export function mixInto(dst, src, offset = 0, gain = 1) {
  const o = Math.round(offset);
  const n = Math.min(src.length, dst.length - o);
  for (let i = Math.max(0, -o); i < n; i++) dst[o + i] += src[i] * gain;
  return dst;
}

export function scale(x, g) { for (let i = 0; i < x.length; i++) x[i] *= g; return x; }

export function peak(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; }
  return p;
}

export function peakOf(chans) { let p = 0; for (const c of chans) p = Math.max(p, peak(c)); return p; }

export function rms(x, a = 0, b = x.length) {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

/** Normalize a set of channels so the loudest sample hits targetDb (dBFS). */
export function normalize(chans, targetDb = -1) {
  const p = peakOf(chans);
  if (p > 0) { const g = dbToGain(targetDb) / p; for (const c of chans) scale(c, g); }
  return chans;
}

/** Raised-cosine fade-in/out (seconds) */
export function fadeIn(x, sr, sec) {
  const n = Math.min(x.length, samples(sr, sec));
  for (let i = 0; i < n; i++) x[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
  return x;
}
export function fadeOut(x, sr, sec) {
  const n = Math.min(x.length, samples(sr, sec));
  const s = x.length - n;
  for (let i = 0; i < n; i++) x[s + i] *= 0.5 + 0.5 * Math.cos((Math.PI * i) / n);
  return x;
}

/** One-pole DC blocker (in place). */
export function dcBlock(x, sr, fc = 12) {
  const R = Math.exp((-2 * Math.PI * fc) / sr);
  let x1 = 0, y1 = 0;
  for (let i = 0; i < x.length; i++) { const y = x[i] - x1 + R * y1; x1 = x[i]; y1 = y; x[i] = y; }
  return x;
}

/** Trim trailing near-silence (keeps a short fade). Returns new arrays when trimmed. */
export function trimTail(chans, sr, thresholdDb = -72, padSec = 0.02) {
  const th = dbToGain(thresholdDb);
  let last = 0;
  for (const c of chans) for (let i = c.length - 1; i > last; i--) if (Math.abs(c[i]) > th) { last = i; break; }
  const n = Math.min(chans[0].length, last + samples(sr, padSec));
  if (n >= chans[0].length) return chans;
  return chans.map((c) => { const o = c.slice(0, n); fadeOut(o, sr, Math.min(padSec, n / sr)); return o; });
}

// ------------------------------------------------------------------------------------------ noise
export function white(rng, n, amp = 1) {
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = (rng.next() * 2 - 1) * amp;
  return o;
}

/** Paul Kellet's refined pink noise. */
export function pink(rng, n, amp = 1) {
  const o = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rng.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    o[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11 * amp;
    b6 = w * 0.115926;
  }
  return o;
}

/** Brown (red) noise, leaky integrated white noise. */
export function brown(rng, n, amp = 1) {
  const o = new Float32Array(n);
  let l = 0;
  for (let i = 0; i < n; i++) { l = (l + 0.02 * (rng.next() * 2 - 1)) / 1.02; o[i] = l * 3.5 * amp; }
  return o;
}

/**
 * Smooth random control signal (value noise, cubic-interpolated) sampled per audio sample.
 * rate = new random points per second. Output in [-1, 1].
 */
export function wobble(rng, n, sr, rate) {
  const o = new Float32Array(n);
  const step = sr / Math.max(0.001, rate);
  let p0 = rng.bi(), p1 = rng.bi(), p2 = rng.bi(), p3 = rng.bi();
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const t = pos;
    // Catmull-Rom
    const t2 = t * t, t3 = t2 * t;
    o[i] = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
    pos += 1 / step;
    if (pos >= 1) { pos -= 1; p0 = p1; p1 = p2; p2 = p3; p3 = rng.bi(); }
  }
  return o;
}

// ------------------------------------------------------------------------------------------ filters
/**
 * Topology-preserving-transform state variable filter (Simper). Stable under fast modulation.
 * mode: 'lp' | 'hp' | 'bp' (unity peak) | 'notch' | 'ap'
 * fc may be a number or a function (tSec, i) -> Hz, re-evaluated every 16 samples.
 * q may be a number or function. Processes in place, returns x.
 */
export function svf(x, sr, mode, fc, q = 0.707) {
  let ic1 = 0, ic2 = 0, a1 = 0, a2 = 0, a3 = 0, k = 1;
  const fcFn = typeof fc === 'function';
  const qFn = typeof q === 'function';
  const nyq = sr * 0.49;
  const setc = (f, qq) => {
    const g = Math.tan((Math.PI * clamp(f, 5, nyq)) / sr);
    k = 1 / Math.max(0.05, qq);
    a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2;
  };
  setc(fcFn ? fc(0, 0) : fc, qFn ? q(0, 0) : q);
  const m = mode === 'lp' ? 0 : mode === 'hp' ? 1 : mode === 'bp' ? 2 : mode === 'notch' ? 3 : 4;
  const dyn = fcFn || qFn;
  for (let i = 0; i < x.length; i++) {
    if (dyn && (i & 15) === 0 && i > 0) setc(fcFn ? fc(i / sr, i) : fc, qFn ? q(i / sr, i) : q);
    const v0 = x[i];
    const v3 = v0 - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    let y;
    switch (m) {
      case 0: y = v2; break;
      case 1: y = v0 - k * v1 - v2; break;
      case 2: y = k * v1; break;
      case 3: y = v0 - k * v1; break;
      default: y = v0 - 2 * k * v1;
    }
    x[i] = y;
  }
  return x;
}

export const lp = (x, sr, fc, q = 0.707) => svf(x, sr, 'lp', fc, q);
export const hp = (x, sr, fc, q = 0.707) => svf(x, sr, 'hp', fc, q);
export const bp = (x, sr, fc, q = 1) => svf(x, sr, 'bp', fc, q);

/** 4th-order (two cascaded 2nd-order) variants for steeper slopes. */
export const lp4 = (x, sr, fc, q = 0.707) => svf(svf(x, sr, 'lp', fc, q), sr, 'lp', fc, q);
export const hp4 = (x, sr, fc, q = 0.707) => svf(svf(x, sr, 'hp', fc, q), sr, 'hp', fc, q);

/** One-pole lowpass (gentle 6 dB/oct), fc number or fn(t). */
export function onePoleLP(x, sr, fc) {
  const fn = typeof fc === 'function';
  let a = Math.exp((-2 * Math.PI * (fn ? fc(0) : fc)) / sr), y = 0;
  for (let i = 0; i < x.length; i++) {
    if (fn && (i & 31) === 0) a = Math.exp((-2 * Math.PI * clamp(fc(i / sr), 5, sr * 0.49)) / sr);
    y = x[i] * (1 - a) + y * a; x[i] = y;
  }
  return x;
}
export function onePoleHP(x, sr, fc) {
  const a = Math.exp((-2 * Math.PI * fc) / sr);
  let y = 0, x1 = 0;
  for (let i = 0; i < x.length; i++) { y = a * (y + x[i] - x1); x1 = x[i]; x[i] = y; }
  return x;
}

/**
 * RBJ cookbook biquad, fixed coefficients. type: 'peak' | 'lowshelf' | 'highshelf' | 'lp' | 'hp' | 'bp'
 */
export function eq(x, sr, type, f, q = 0.707, gainDb = 0) {
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * clamp(f, 5, sr * 0.49)) / sr;
  const cw = Math.cos(w), sw = Math.sin(w);
  const alpha = sw / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'peak':
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
      a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
      a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; break;
    }
    case 'hp': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'bp': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    default: b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  }
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = b0 * v + z1;
    z1 = b1 * v - a1 * y + z2;
    z2 = b2 * v - a2 * y;
    x[i] = y;
  }
  return x;
}

/** Schroeder allpass (in place), delay in samples. */
export function allpass(x, d, g = 0.6) {
  const line = new Float32Array(d);
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const bufv = line[p];
    const v = x[i] + g * bufv;
    x[i] = bufv - g * v;
    line[p] = v;
    p = p + 1 === d ? 0 : p + 1;
  }
  return x;
}

/** Feedback comb (in place). */
export function comb(x, d, fb = 0.5, damp = 0.2) {
  const line = new Float32Array(d);
  let p = 0, f = 0;
  for (let i = 0; i < x.length; i++) {
    const y = line[p];
    f = y * (1 - damp) + f * damp;
    line[p] = x[i] + f * fb;
    x[i] = x[i] + y;
    p = p + 1 === d ? 0 : p + 1;
  }
  return x;
}

// ------------------------------------------------------------------------------------------ shaping
export function softclip(x, drive = 1) {
  const n = Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive) / n;
  return x;
}

/** Asymmetric saturation (adds even harmonics, like a stressed mic diaphragm / preamp). */
export function asymclip(x, drive = 1.5, bias = 0.2) {
  const off = Math.tanh(bias * drive);
  const n = Math.tanh(drive * (1 + bias)) - off;
  for (let i = 0; i < x.length; i++) x[i] = (Math.tanh((x[i] + bias) * drive) - off) / n;
  return dcBlockInline(x);
}
function dcBlockInline(x) { let x1 = 0, y1 = 0; for (let i = 0; i < x.length; i++) { const y = x[i] - x1 + 0.9995 * y1; x1 = x[i]; y1 = y; x[i] = y; } return x; }

/** Simple feed-forward compressor on a mono buffer (peak detector), for density on transients. */
export function compress(x, sr, { threshDb = -18, ratio = 4, attack = 0.001, release = 0.06, makeupDb = 0 } = {}) {
  const th = dbToGain(threshDb);
  const ca = Math.exp(-1 / (attack * sr)), cr = Math.exp(-1 / (release * sr));
  const mk = dbToGain(makeupDb);
  let env = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    env = a > env ? ca * env + (1 - ca) * a : cr * env + (1 - cr) * a;
    let g = 1;
    if (env > th) g = Math.pow(env / th, 1 / ratio - 1);
    x[i] *= g * mk;
  }
  return x;
}

// ------------------------------------------------------------------------------------------ tone matching
/** Octave band centers used by bandEnergies/toneMatch. */
export const BAND_CENTERS = [40, 85, 175, 350, 700, 1400, 2800, 5600, 11300, 18000];

/** Energy (dB) per octave band over [t0, t1] seconds of a mono signal. */
export function bandEnergies(x, sr, t0 = 0, t1 = 0.3) {
  const a = Math.floor(t0 * sr), b = Math.min(x.length, Math.floor(t1 * sr));
  const seg = x.subarray(a, b);
  return BAND_CENTERS.map((fc) => {
    if (fc > sr * 0.45) return -200;
    const c = seg.slice();
    svf(c, sr, 'bp', fc, 1.41);
    svf(c, sr, 'bp', fc, 1.41);
    let s = 0;
    for (let i = 0; i < c.length; i++) s += c[i] * c[i];
    return 10 * Math.log10(s + 1e-20);
  });
}

/**
 * Nudge a sound's spectral balance toward a target octave curve (dB relative, same length as BAND_CENTERS;
 * null entries are ignored). Measures the mono mix over the analysis window, then applies peaking EQs to
 * every channel. `strength` 0..1, corrections are clamped to ±maxDb. Two passes converge well.
 */
export function toneMatch(chans, sr, target, { t0 = 0, t1 = 0.3, strength = 0.8, maxDb = 12, passes = 2 } = {}) {
  for (let p = 0; p < passes; p++) {
    const mono = new Float32Array(chans[0].length);
    for (const c of chans) for (let i = 0; i < c.length; i++) mono[i] += c[i] / chans.length;
    const e = bandEnergies(mono, sr, t0, t1);
    // align on the mean of valid bands
    let dm = 0, cnt = 0;
    for (let i = 0; i < e.length; i++) if (target[i] != null && e[i] > -150) { dm += e[i] - target[i]; cnt++; }
    dm /= Math.max(1, cnt);
    for (let i = 0; i < e.length; i++) {
      if (target[i] == null || e[i] <= -150) continue;
      const g = clamp((target[i] - (e[i] - dm)) * strength, -maxDb, maxDb);
      if (Math.abs(g) < 0.3) continue;
      const fc = BAND_CENTERS[i];
      for (const c of chans) {
        if (i === 0) eq(c, sr, 'lowshelf', 60, 0.7, g);
        else if (i === BAND_CENTERS.length - 1) eq(c, sr, 'highshelf', 15000, 0.7, g);
        else eq(c, sr, 'peak', fc, 1.3, g);
      }
    }
  }
  return chans;
}

// ------------------------------------------------------------------------------------------ envelopes
/** Fill an envelope: fast raised-cosine attack then one or two exponential decays. */
export function envAD(n, sr, attack, tau, tau2 = 0, mix2 = 0) {
  const e = new Float32Array(n);
  const na = Math.max(1, Math.round(attack * sr));
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const a = i < na ? 0.5 - 0.5 * Math.cos((Math.PI * i) / na) : 1;
    const ta = Math.max(0, t - attack);
    let d = Math.exp(-ta / tau);
    if (tau2 > 0) d = d * (1 - mix2) + Math.exp(-ta / tau2) * mix2;
    e[i] = a * d;
  }
  return e;
}

export function mul(x, e) { const n = Math.min(x.length, e.length); for (let i = 0; i < n; i++) x[i] *= e[i]; for (let i = n; i < x.length; i++) x[i] = 0; return x; }

/** Piecewise-linear envelope from [[t, v], ...] (seconds). */
export function envPts(n, sr, pts) {
  const e = new Float32Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    while (k < pts.length - 2 && t > pts[k + 1][0]) k++;
    const [t0, v0] = pts[k], [t1, v1] = pts[Math.min(k + 1, pts.length - 1)];
    e[i] = t <= t0 ? v0 : t >= t1 ? v1 : v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
  }
  return e;
}

// ------------------------------------------------------------------------------------------ generators
/**
 * Noise burst with attack/decay envelope, optional filters. Mixed into dst at t0.
 * opts: { amp, attack, tau, tau2, mix2, dur, lp, hp, bp:[fc,q], color: 'white'|'pink'|'brown', lpQ }
 * lp/hp may be functions of local time.
 */
export function noiseBurst(dst, sr, t0, rng, o) {
  const dur = o.dur ?? Math.min(2, (o.tau2 || o.tau || 0.05) * 7 + (o.attack || 0));
  const n = samples(sr, dur);
  const src = o.color === 'pink' ? pink(rng, n) : o.color === 'brown' ? brown(rng, n) : white(rng, n);
  if (o.hp) svf(src, sr, 'hp', o.hp, o.hpQ ?? 0.707);
  if (o.lp) svf(src, sr, 'lp', o.lp, o.lpQ ?? 0.707);
  if (o.bp) svf(src, sr, 'bp', o.bp[0], o.bp[1]);
  mul(src, envAD(n, sr, o.attack ?? 0.0005, o.tau ?? 0.02, o.tau2 || 0, o.mix2 || 0));
  fadeOut(src, sr, Math.min(0.01, dur * 0.2));
  mixInto(dst, src, t0 * sr, o.amp ?? 1);
  return src;
}

/**
 * Pitch-swept sine "thump" (kick-drum style) with optional saturation.
 * f(t) = f1 + (f0 - f1) * exp(-t / sweep)
 */
export function thump(dst, sr, t0, o) {
  const dur = o.dur ?? (o.tau ?? 0.1) * 6;
  const n = samples(sr, dur);
  const s = new Float32Array(n);
  let ph = o.phase ?? 0;
  const na = Math.max(1, Math.round((o.attack ?? 0.0015) * sr));
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = o.f1 + (o.f0 - o.f1) * Math.exp(-t / (o.sweep ?? 0.02));
    ph += (2 * Math.PI * f) / sr;
    const a = i < na ? 0.5 - 0.5 * Math.cos((Math.PI * i) / na) : 1;
    s[i] = Math.sin(ph) * a * Math.exp(-t / (o.tau ?? 0.1));
  }
  if (o.drive) softclip(s, o.drive);
  if (o.lp) svf(s, sr, 'lp', o.lp);
  fadeOut(s, sr, Math.min(0.02, dur * 0.2));
  mixInto(dst, s, t0 * sr, o.amp ?? 1);
  return s;
}

/**
 * Bank of 2-pole resonators excited by `exc` (mixed into dst at t0).
 * modes: [{ f, t60, amp }]. Natural struck/rung objects (metal, glass, wood, casing).
 */
export function resonate(dst, sr, t0, exc, modes, gain = 1, dur = 0) {
  let maxT = 0;
  for (const m of modes) maxT = Math.max(maxT, m.t60);
  const n = samples(sr, dur || Math.min(3, maxT * 1.1 + exc.length / sr));
  const out = new Float32Array(n);
  for (const m of modes) {
    if (m.f >= sr * 0.47) continue;
    const r = Math.exp(-6.9078 / (m.t60 * sr));
    const w = (2 * Math.PI * m.f) / sr;
    const c = 2 * r * Math.cos(w), r2 = r * r;
    const g = (m.amp ?? 1) * (1 - r) * 2 * Math.sin(w) * 4;
    let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const xin = i < exc.length ? exc[i] * g : 0;
      const y = c * y1 - r2 * y2 + xin;
      y2 = y1; y1 = y;
      out[i] += y;
    }
  }
  fadeOut(out, sr, Math.min(0.02, n / sr * 0.1));
  mixInto(dst, out, t0 * sr, gain);
  return out;
}

/** Short excitation (a few ms of shaped noise) for resonators. */
export function excite(rng, sr, lenSec = 0.002, hpFc = 0, lpFc = 0) {
  const n = samples(sr, lenSec);
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) e[i] = (rng.next() * 2 - 1) * Math.exp((-5 * i) / n);
  if (hpFc) svf(e, sr, 'hp', hpFc);
  if (lpFc) svf(e, sr, 'lp', lpFc);
  return e;
}

/**
 * Inharmonic metal modes around a base frequency (plates, bolts, receivers, casings).
 * ratios are perturbed per variant. bright: 0..1 raises upper-mode amplitudes.
 */
export function metalModes(rng, base, { n = 7, t60 = 0.08, t60Spread = 0.5, bright = 0.5, ratios } = {}) {
  const R = ratios || [1, 1.47, 2.09, 2.56, 3.39, 4.17, 5.43, 6.3, 7.9, 9.6];
  const out = [];
  for (let i = 0; i < Math.min(n, R.length); i++) {
    const f = base * R[i] * rng.jit(1, 0.03);
    const amp = Math.pow(0.72 + bright * 0.25, i) * rng.range(0.55, 1.0);
    out.push({ f, t60: t60 * rng.jit(1, t60Spread) * Math.pow(0.85, i), amp });
  }
  return out;
}

/**
 * Granular crunch: many tiny filtered noise grains (gravel, debris, dirt, glass shards, crackle).
 * opts: { count, start, spread, density: fn(u)->weight (0..1 over spread), amp, ampVar, grainMs:[a,b],
 *         fc:[a,b], q:[a,b], mode:'bp'|'hp'|'lp', ring: false|{ t60, ...} }
 */
export function grains(dst, sr, t0, rng, o) {
  const cnt = o.count ?? 40;
  const spread = o.spread ?? 0.1;
  const [gmA, gmB] = o.grainMs ?? [1, 6];
  const [fA, fB] = o.fc ?? [1500, 6000];
  const [qA, qB] = o.q ?? [0.8, 3];
  const shape = o.shape ?? 2; // time distribution exponent (higher = more front-loaded)
  for (let g = 0; g < cnt; g++) {
    const u = Math.pow(rng.next(), shape);
    const t = t0 + u * spread;
    const len = rng.range(gmA, gmB) / 1000;
    const n = samples(sr, len);
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = (rng.next() * 2 - 1) * Math.exp((-4 * i) / n);
    // exp-random frequency across range (log-uniform)
    const fc = fA * Math.pow(fB / fA, rng.next());
    const q = rng.range(qA, qB);
    svf(s, sr, o.mode || 'bp', fc, q);
    const decay = o.decay ?? 0; // amplitude falloff over the spread
    const a = (o.amp ?? 0.3) * (1 - (o.ampVar ?? 0.7) * rng.next()) * (decay ? Math.exp(-u * spread / decay) : 1);
    if (o.ring) {
      resonate(dst, sr, t, s, [{ f: fc, t60: o.ring.t60 * rng.jit(1, 0.4), amp: 1 }, { f: fc * rng.range(1.5, 2.7), t60: o.ring.t60 * 0.6, amp: 0.5 }], a * (o.ring.gain ?? 0.5));
    }
    mixInto(dst, s, t * sr, a);
  }
  return dst;
}

/**
 * Friction/scrape: band-passed noise with rough amplitude modulation (mag insertion, cloth, slides).
 * opts: { dur, amp, fc (number|fn), q, rough (0..1), rate (Hz of roughness), attack, release, color }
 */
export function scrape(dst, sr, t0, rng, o) {
  const n = samples(sr, o.dur);
  const s = o.color === 'pink' ? pink(rng, n) : white(rng, n);
  svf(s, sr, 'bp', o.fc, o.q ?? 1.2);
  if (o.lp) svf(s, sr, 'lp', o.lp);
  const w = wobble(rng, n, sr, o.rate ?? 60);
  const rough = o.rough ?? 0.6;
  const ea = o.attack ?? 0.01, er = o.release ?? 0.03;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, t / ea) * Math.min(1, (o.dur - t) / er);
    s[i] *= Math.max(0, env) * (1 - rough + rough * Math.max(0, 0.5 + w[i]));
  }
  mixInto(dst, s, t0 * sr, o.amp ?? 0.3);
  return s;
}

/** Sinusoidal chirp (birds, UI) with amplitude env array or AD. */
export function chirp(dst, sr, t0, o) {
  const n = samples(sr, o.dur);
  const s = new Float32Array(n);
  let ph = 0, ph2 = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const f = typeof o.f === 'function' ? o.f(u) : o.f;
    ph += (2 * Math.PI * f) / sr;
    let v = Math.sin(ph + (o.fm ? o.fmIdx * Math.sin(ph2) : 0));
    if (o.fm) ph2 += (2 * Math.PI * f * o.fm) / sr;
    if (o.h2) v += o.h2 * Math.sin(2 * ph);
    if (o.h3) v += o.h3 * Math.sin(3 * ph);
    const e = typeof o.env === 'function' ? o.env(u) : Math.sin(Math.PI * u);
    s[i] = v * e;
  }
  mixInto(dst, s, t0 * sr, o.amp ?? 0.3);
  return s;
}

// ------------------------------------------------------------------------------------------ space
/** Add a delayed, filtered copy (reflection) of `src` into dst. */
export function reflect(dst, src, sr, delaySec, gain, lpFc = 0, hpFc = 0) {
  const c = src.slice();
  if (lpFc) svf(c, sr, 'lp', lpFc);
  if (hpFc) svf(c, sr, 'hp', hpFc);
  mixInto(dst, c, delaySec * sr, gain);
  return dst;
}

/** Decorrelate a mono signal into a stereo pair (allpass networks with different delays). */
export function decorrelate(mono, sr, amount = 1, seed = 1) {
  const L = mono.slice(), R = mono.slice();
  const r = new Rand(seed);
  const d = (ms) => Math.max(1, Math.round((ms / 1000) * sr));
  allpass(L, d(r.range(2.1, 3.3)), 0.5 * amount); allpass(L, d(r.range(5.1, 7.7)), 0.45 * amount); allpass(L, d(r.range(11, 13)), 0.4 * amount);
  allpass(R, d(r.range(3.4, 4.6)), 0.5 * amount); allpass(R, d(r.range(7.9, 9.7)), 0.45 * amount); allpass(R, d(r.range(13.5, 16)), 0.4 * amount);
  return [L, R];
}

/** Mid/side width blend: w=0 mono, 1 = unchanged. */
export function width(L, R, w) {
  for (let i = 0; i < L.length; i++) {
    const m = (L[i] + R[i]) * 0.5, s = (L[i] - R[i]) * 0.5 * w;
    L[i] = m + s; R[i] = m - s;
  }
}

/** Constant-power pan a mono buffer into [L, R] (adds into given stereo). pan -1..1 */
export function panInto(L, R, src, offset, gain, pan) {
  const a = ((pan + 1) * Math.PI) / 4;
  mixInto(L, src, offset, gain * Math.cos(a));
  mixInto(R, src, offset, gain * Math.sin(a));
}

/** Make a buffer loop seamlessly: crossfade the last `xf` seconds onto the start. Returns shortened copy. */
export function loopify(x, sr, xf) {
  const n = samples(sr, xf);
  const len = x.length - n;
  const o = x.slice(0, len);
  for (let i = 0; i < n; i++) {
    const a = Math.sin((0.5 * Math.PI * i) / n); // equal-power
    const b = Math.cos((0.5 * Math.PI * i) / n);
    o[i] = x[i] * a + x[len + i] * b;
  }
  return o;
}

/** Direct convolution (use for short kernels). Returns a new array of length a + k - 1. */
export function convolve(a, k) {
  const o = new Float32Array(a.length + k.length - 1);
  for (let j = 0; j < k.length; j++) {
    const kj = k[j];
    if (kj === 0) continue;
    for (let i = 0; i < a.length; i++) o[i + j] += a[i] * kj;
  }
  return o;
}

/**
 * Look-ahead brickwall limiter (in place, all channels share gain). Keeps transients musical while
 * letting sounds be mastered hot like shipped game assets.
 */
export function limit(chans, sr, { ceilingDb = -0.8, lookahead = 0.0015, release = 0.045 } = {}) {
  const n = chans[0].length;
  const ceil = dbToGain(ceilingDb);
  const la = Math.max(1, Math.round(lookahead * sr));
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0;
    for (const c of chans) { const v = Math.abs(c[i]); if (v > a) a = v; }
    req[i] = a > ceil ? ceil / a : 1;
  }
  // forward-looking sliding minimum over [i, i+la] (monotonic deque)
  const h = new Float32Array(n);
  const dq = new Int32Array(n + la + 1);
  let head = 0, tail = 0, j = 0;
  for (let i = 0; i < n; i++) {
    while (j < n && j <= i + la) {
      while (tail > head && req[dq[tail - 1]] >= req[j]) tail--;
      dq[tail++] = j++;
    }
    while (dq[head] < i) head++;
    h[i] = req[dq[head]];
  }
  // box average over the previous la samples, then release smoothing
  const rel = Math.exp(-1 / (release * sr));
  // warm start: pretend the signal before t=0 had the same gain need as the first sample
  let sum = h[0] * la, g = h[0];
  for (let i = 0; i < n; i++) {
    sum += h[i] - (i >= la ? h[i - la] : h[0]);
    const avg = sum / la;
    g = avg < g ? avg : avg + (g - avg) * rel;
    for (const c of chans) c[i] *= g;
  }
  return chans;
}

/** Scale channels so the RMS over [t0, t1] hits targetDb. */
export function rmsNormalize(chans, sr, targetDb, t0 = 0, t1 = 0.15) {
  let s = 0, cnt = 0;
  const a = Math.floor(t0 * sr), b = Math.min(chans[0].length, Math.floor(t1 * sr));
  for (const c of chans) for (let i = a; i < b; i++) { s += c[i] * c[i]; cnt++; }
  const r = Math.sqrt(s / Math.max(1, cnt));
  if (r > 0) { const g = dbToGain(targetDb) / r; for (const c of chans) scale(c, g); }
  return chans;
}

/**
 * audio/ir.js — procedural stereo impulse responses for the environment reverb (ConvolverNode).
 *
 * Each preset models a space in Vardanek:
 *   street    3-5 storey facades 8-20 m apart: discrete facade slaps + flutter, long dark outdoor tail
 *   open      plaza / edge of town: sparse distant reflections, rolling low tail, little mid/high
 *   alley     narrow walls (2-4 m): strong short flutter echo, then sky-open tail
 *   room      small interior (apartment/shop): dense early field, short bright-ish decay
 *   hall      large interior (garage / depot / warehouse): long, metallic-ish, strong early slaps
 * The late field is band-split noise with per-band T60 (air absorption makes highs die first outdoors),
 * amplitude-modulated for the "rolling" texture of outdoor gun tails, plus Poisson-scattered discrete
 * reflections that get darker with path length. Deterministic (seeded).
 */
import { Rand, samples, svf, lp, hp, mixInto, wobble, clamp, fadeOut, fadeIn } from './dsp.js';

export const IR_PRESETS = {
  street: {
    len: 3.0, predelay: 0.012, build: 0.06,
    t60: [2.1, 1.5, 0.55], bandGain: [0.8, 0.6, 0.2],
    walls: [[9, 0.55, -0.8], [14, 0.5, 0.8], [23, 0.35, -0.4], [31, 0.3, 0.5]], flutter: 3,
    far: { count: 40, from: 0.12, to: 2.2, gain: 0.35 }, roll: 0.55, level: 1.0,
  },
  open: {
    len: 3.4, predelay: 0.02, build: 0.12,
    t60: [3.0, 1.2, 0.35], bandGain: [1.0, 0.4, 0.1],
    walls: [[40, 0.3, 0.3], [70, 0.25, -0.6]], flutter: 0,
    far: { count: 26, from: 0.2, to: 2.8, gain: 0.3 }, roll: 0.7, level: 0.75,
  },
  alley: {
    len: 2.6, predelay: 0.004, build: 0.03,
    t60: [2.0, 1.3, 0.5], bandGain: [1.0, 0.65, 0.25],
    walls: [[1.6, 0.7, -0.9], [1.9, 0.7, 0.9], [12, 0.4, 0.2]], flutter: 14,
    far: { count: 30, from: 0.1, to: 2.0, gain: 0.3 }, roll: 0.45, level: 1.1,
  },
  room: {
    len: 1.1, predelay: 0.002, build: 0.012,
    t60: [0.7, 0.55, 0.32], bandGain: [1.0, 0.8, 0.4],
    walls: [[1.8, 0.6, -0.7], [2.4, 0.6, 0.7], [1.3, 0.5, 0], [3.2, 0.45, 0.3]], flutter: 6,
    far: { count: 0 }, roll: 0.1, level: 1.25,
  },
  hall: {
    len: 2.6, predelay: 0.006, build: 0.04,
    t60: [2.0, 1.7, 0.8], bandGain: [1.0, 0.75, 0.35],
    walls: [[6, 0.55, -0.7], [9, 0.55, 0.7], [4, 0.4, 0], [14, 0.4, 0.3]], flutter: 8,
    far: { count: 12, from: 0.08, to: 0.8, gain: 0.25 }, roll: 0.2, level: 1.2,
  },
};

const C = 343;

/** Short smeared "reflection" burst (facade roughness, windows, balconies). */
function burst(rng, sr, lenMs, lpFc) {
  const n = samples(sr, lenMs / 1000);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = (rng.next() * 2 - 1) * Math.exp((-4 * i) / n);
  b[0] += 1.5;
  lp(b, sr, lpFc);
  return b;
}

export function makeIR(presetName, sr = 48000, seed = 1) {
  const P = IR_PRESETS[presetName] || IR_PRESETS.street;
  const rng = new Rand(`ir:${presetName}:${seed}`);
  const n = samples(sr, P.len);
  const L = new Float32Array(n), R = new Float32Array(n);

  // --- late diffuse field, 3 bands with their own decay
  const bands = [['lp', 350], ['bp', 1200], ['hp', 3200]];
  for (let ch = 0; ch < 2; ch++) {
    const out = ch ? R : L;
    const roll = wobble(rng, n, sr, 5.5);
    for (let b = 0; b < 3; b++) {
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = rng.next() * 2 - 1;
      const [m, f] = bands[b];
      if (m === 'lp') { lp(x, sr, f); lp(x, sr, f); }
      else if (m === 'hp') { hp(x, sr, f); hp(x, sr, f); }
      else { hp(x, sr, 350); lp(x, sr, 3200); }
      const t60 = P.t60[b];
      const g = P.bandGain[b];
      for (let i = 0; i < n; i++) {
        const t = i / sr - P.predelay;
        if (t <= 0) { x[i] = 0; continue; }
        const onset = Math.min(1, t / P.build);
        const dec = Math.exp((-6.9078 * t) / t60);
        const r = 1 - P.roll * 0.5 + P.roll * 0.5 * roll[i];
        x[i] *= g * onset * onset * dec * r;
      }
      mixInto(out, x, 0, 1);
    }
  }

  // --- early reflections: walls (+ flutter between parallel walls)
  for (const [dist, gain, pan] of P.walls) {
    for (let k = 1; k <= Math.max(1, P.flutter ? Math.min(P.flutter, 20) : 1); k++) {
      const path = 2 * dist * k;
      const t = path / C + rng.range(-0.0015, 0.0015);
      if (t >= P.len - 0.05) break;
      const g = gain * Math.pow(0.72, k - 1) * (10 / (10 + path));
      const b = burst(rng, sr, rng.range(2, 7), clamp(16000 / (1 + path / 40), 900, 16000));
      const p = k % 2 ? pan : -pan * 0.6;
      const a = ((p + 1) * Math.PI) / 4;
      mixInto(L, b, t * sr, g * Math.cos(a) * 1.4);
      mixInto(R, b, t * sr, g * Math.sin(a) * 1.4);
      if (!P.flutter) break;
    }
  }

  // --- far discrete reflections (buildings across the plaza, terrain), Poisson-ish
  if (P.far && P.far.count) {
    for (let k = 0; k < P.far.count; k++) {
      const u = rng.next();
      const t = P.far.from + (P.far.to - P.far.from) * Math.pow(u, 1.3);
      const path = t * C;
      const r = rng.next();
      const g = P.far.gain * Math.exp(-t / (P.t60[0] * 0.35)) * (0.15 + 0.85 * r * r);
      const b = burst(rng, sr, rng.range(6, 25), clamp(9000 / (1 + path / 90), 300, 9000));
      const p = rng.range(-1, 1);
      const a = ((p + 1) * Math.PI) / 4;
      mixInto(L, b, t * sr, g * Math.cos(a));
      mixInto(R, b, t * sr, g * Math.sin(a));
    }
  }

  // --- normalize to unit energy (per-preset level is applied at the send), fade the end
  let e = 0;
  for (let i = 0; i < n; i++) e += L[i] * L[i] + R[i] * R[i];
  const s = (P.level * 0.5) / Math.sqrt(e / 2 + 1e-12);
  for (let i = 0; i < n; i++) { L[i] *= s; R[i] *= s; }
  fadeOut(L, sr, 0.3); fadeOut(R, sr, 0.3);
  fadeIn(L, sr, 0.0005); fadeIn(R, sr, 0.0005);
  return [L, R];
}

export const IR_NAMES = Object.keys(IR_PRESETS);

/**
 * Typical probe results per preset for OFFLINE renders (the live game measures real geometry): 8 horizontal
 * directions clockwise from the front (listener faces -Z, 90 = right) + ceiling. [dist m | null, reflectivity].
 */
export const REFLECT_PRESETS = {
  street: [[38, 0.9], [16, 0.9], [11, 0.85], [15, 0.9], [null], [10, 0.9], [7, 0.85], [10, 0.9], [null]],
  open: [[48, 0.85], [null], [null], [null], [56, 0.85], [null], [null], [null], [null]],
  alley: [[26, 0.9], [2.6, 0.9], [1.9, 0.9], [2.7, 0.9], [18, 0.9], [2.3, 0.85], [1.6, 0.85], [2.2, 0.85], [null]],
  room: [[2.6, 0.9], [2.9, 0.85], [2.1, 0.9], [3.2, 0.8], [3.4, 0.9], [2.7, 0.85], [1.8, 0.9], [2.4, 0.9], [1.4, 0.9]],
  hall: [[14, 1], [11, 0.95], [8, 0.9], [10, 0.95], [16, 1], [12, 0.95], [9, 0.9], [12, 0.95], [6, 1]],
};
export function reflectDir(i) {
  if (i === 8) return { x: 0, y: 1, z: 0 };
  const a = (i / 8) * Math.PI * 2;
  return { x: Math.sin(a), y: 0.08, z: -Math.cos(a) };
}

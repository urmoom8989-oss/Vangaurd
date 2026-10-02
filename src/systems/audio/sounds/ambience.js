/**
 * audio/sounds/ambience.js — ambient bed for Vardanek at golden hour, mid-conflict:
 * wind (loop), distant war rumble bed (loop), fire crackle (loop), and one-shot "spot" events the
 * runtime scatters around the listener: distant artillery, distant gunfire bursts / MG, birds,
 * flapping tarp, creaking metal, settling debris.
 */
import {
  samples, buf, svf, lp, hp, eq, white, pink, brown, mixInto, dcBlock, fadeOut, fadeIn, noiseBurst, thump, grains,
  resonate, excite, metalModes, wobble, chirp, loopify, normalize, clamp, decorrelate, width, scale, rmsNormalize, limit,
} from '../dsp.js';
import { debrisRain, cloth } from './common.js';
import { gunshot, WEAPON_SPECS } from './weapons.js';
import { explosionFar } from './combat.js';

function fin(chans, sr, db) { for (const c of chans) { dcBlock(c, sr, 15); } return normalize(chans, db); }

// ------------------------------------------------------------------------------------------ loops
function wind(rng, sr) {
  const len = 24, xf = 3;
  const n = samples(sr, len + xf);
  const gust = wobble(rng, n, sr, 0.16);
  const gust2 = wobble(rng, n, sr, 0.55);
  const G = new Float32Array(n);
  for (let i = 0; i < n; i++) G[i] = clamp(0.45 + 0.4 * gust[i] + 0.15 * gust2[i], 0.08, 1);
  const out = [];
  for (let ch = 0; ch < 2; ch++) {
    const r = rng.fork('ch' + ch);
    const x = new Float32Array(n);
    // low buffeting
    const lo = brown(r, n); lp(lo, sr, 220); hp(lo, sr, 28);
    // body: swept band
    const mid = pink(r, n);
    svf(mid, sr, 'bp', (t, i) => 260 + 520 * G[Math.min(n - 1, i)], 0.7);
    // high hiss: dust & debris skittering
    const hi = pink(r, n); hp(hi, sr, 2800); lp(hi, sr, 9000);
    // whistle around building edges (only strong gusts)
    const wh = white(r, n);
    const wf = r.range(620, 900);
    svf(wh, sr, 'bp', (t, i) => wf * (0.9 + 0.25 * G[Math.min(n - 1, i)]), 28);
    const flutter = wobble(r, n, sr, 6);
    for (let i = 0; i < n; i++) {
      const g = G[i];
      x[i] = lo[i] * 0.55 * Math.pow(g, 1.4) + mid[i] * 0.9 * g * (0.85 + 0.15 * flutter[i]) + hi[i] * 0.22 * g * g
        + wh[i] * 0.9 * Math.pow(Math.max(0, g - 0.62) / 0.38, 2.5);
    }
    out.push(loopify(x, sr, xf));
  }
  return fin(out, sr, -9);
}

function warBed(rng, sr) {
  // far-off conflict: sub-audible rumble, slow swells, very distant thuds that never resolve
  const len = 30, xf = 3;
  const n = samples(sr, len + xf);
  const sw = wobble(rng, n, sr, 0.08);
  const out = [];
  for (let ch = 0; ch < 2; ch++) {
    const r = rng.fork('bed' + ch);
    const x = brown(r, n);
    lp(x, sr, 110); hp(x, sr, 22);
    for (let i = 0; i < n; i++) x[i] *= 0.42 + 0.58 * Math.max(0, 0.5 + 0.5 * sw[i]) ** 1.5; // slow breathing swells
    const air = pink(r, n); lp(air, sr, 1200); hp(air, sr, 250); // distant town air
    mixInto(x, air, 0, 0.05);
    out.push(x);
  }
  // shared very distant thumps
  for (let k = 0; k < 5; k++) {
    const t = rng.range(0.5, len - 1);
    const e = explosionFar(rng.fork('t' + k), sr, { len: 3, lpF: 240, weight: 0.8 })[0];
    const p = rng.range(-0.8, 0.8);
    mixInto(out[0], e, t * sr, 0.2 * (1 - p * 0.5));
    mixInto(out[1], e, t * sr, 0.2 * (1 + p * 0.5));
  }
  return fin(out.map((c) => loopify(c, sr, xf)), sr, -8);
}

function fireLoop(rng, sr) {
  const len = 10, xf = 2;
  const n = samples(sr, len + xf);
  const x = brown(rng, n);
  lp(x, sr, 380); hp(x, sr, 40);
  const w = wobble(rng, n, sr, 1.5);
  for (let i = 0; i < n; i++) x[i] *= 0.6 + 0.4 * w[i];
  const roar = pink(rng, n); svf(roar, sr, 'bp', 700, 0.6);
  mixInto(x, roar, 0, 0.12);
  // crackles & pops
  grains(x, sr, 0, rng, { count: 900, spread: len + xf, amp: 0.25, fc: [900, 7000], q: [0.8, 3], grainMs: [0.2, 2], shape: 1, ampVar: 0.95 });
  for (let k = 0; k < 40; k++) noiseBurst(x, sr, rng.range(0, len + xf - 0.1), rng, { amp: rng.range(0.1, 0.4), attack: 0.0002, tau: 0.002, bp: [rng.range(1200, 3500), 1], dur: 0.02 });
  return fin([loopify(x, sr, xf)], sr, -6);
}

// ------------------------------------------------------------------------------------------ spot events
function artilleryFar(rng, sr) {
  const x = explosionFar(rng, sr, { len: 7, lpF: rng.range(320, 520), weight: 1.5 });
  return fin(x, sr, -1);
}

function gunfireBurst(rng, sr, cls = 'rifle') {
  const spec = WEAPON_SPECS[cls];
  const shotsA = gunshot(rng.fork('a'), sr, spec, 'far')[0];
  const shotsB = gunshot(rng.fork('b'), sr, spec, 'far')[0];
  const rpm = cls === 'lmg' ? rng.range(650, 800) : rng.range(600, 750);
  const count = cls === 'lmg' ? rng.int(8, 18) : rng.pick([1, 2, 3, 3, 4, 5, 6, 8]);
  const semi = cls !== 'lmg' && rng.chance(0.35);
  const len = count * (semi ? 0.3 : 60 / rpm) + 3.4;
  const x = buf(sr, len);
  let t = 0.01;
  for (let k = 0; k < count; k++) {
    const src = k % 2 ? shotsB : shotsA;
    mixInto(x, src, t * sr, rng.range(0.7, 1) * (1 - 0.15 * (k / count)));
    t += semi ? rng.range(0.18, 0.45) : (60 / rpm) * rng.jit(1, 0.06);
  }
  lp(x, sr, rng.range(1400, 2600));
  return fin([x], sr, -2);
}

function birds(rng, sr) {
  const x = buf(sr, 2.6);
  // sparrow-like chips and a short trill, occasionally a pair calling back and forth
  let t = rng.range(0.02, 0.2);
  const calls = rng.int(2, 6);
  const base = rng.range(3200, 4600);
  for (let c = 0; c < calls && t < 2.2; c++) {
    const kind = rng.next();
    if (kind < 0.55) { // chip
      const f0 = base * rng.jit(1, 0.08), f1 = f0 * rng.range(0.7, 1.25);
      chirp(x, sr, t, { dur: rng.range(0.035, 0.07), f: (u) => f0 + (f1 - f0) * u, amp: 0.25, h2: 0.1, env: (u) => Math.sin(Math.PI * Math.pow(u, 0.7)) });
      t += rng.range(0.08, 0.25);
    } else if (kind < 0.85) { // trill
      const nt = rng.int(4, 9), f0 = base * rng.range(0.9, 1.3);
      for (let k = 0; k < nt; k++) {
        chirp(x, sr, t, { dur: 0.028, f: (u) => f0 * (1.2 - 0.4 * u), amp: 0.18, env: (u) => Math.sin(Math.PI * u) });
        t += rng.range(0.04, 0.055);
      }
      t += rng.range(0.1, 0.3);
    } else { // two-note whistle
      const f0 = base * rng.range(0.6, 0.8);
      chirp(x, sr, t, { dur: 0.12, f: (u) => f0 * (1 + 0.15 * Math.sin(Math.PI * u)), amp: 0.2, env: (u) => Math.sin(Math.PI * u) });
      chirp(x, sr, t + 0.16, { dur: 0.14, f: (u) => f0 * 1.26 * (1 - 0.1 * u), amp: 0.18, env: (u) => Math.sin(Math.PI * u) });
      t += 0.45;
    }
  }
  hp(x, sr, 1500);
  fadeOut(x, sr, 0.1);
  return fin([x], sr, -6);
}

function tarpFlap(rng, sr) {
  const len = rng.range(1.8, 3.2);
  const x = buf(sr, len + 0.3);
  // gusts drive bursts of flaps: flutter rate rises and falls
  let t = 0.02;
  const peak = rng.range(0.3, 0.7) * len;
  while (t < len) {
    const g = Math.exp(-Math.pow((t - peak) / (len * 0.35), 2));
    const rate = 3 + 10 * g;
    const a = 0.25 + 0.75 * g * rng.range(0.6, 1);
    // fabric snap: sharp broadband crack + air whump
    noiseBurst(x, sr, t, rng, { amp: 0.8 * a, attack: 0.0003, tau: rng.range(0.003, 0.008), hp: 500, lp: 7000, dur: 0.04 });
    noiseBurst(x, sr, t, rng, { amp: 0.6 * a, attack: 0.002, tau: 0.02, lp: 450, hp: 60, dur: 0.08, color: 'pink' });
    t += (1 / rate) * rng.jit(1, 0.35);
  }
  cloth(x, sr, 0, rng, { dur: len, amp: 0.3, intensity: 1, peakAt: peak / len, bright: 0.3 });
  // grommet / rope rattle
  for (let k = 0; k < rng.int(1, 4); k++) resonate(x, sr, rng.range(0.1, len), excite(rng, sr, 0.001, 800), metalModes(rng, rng.range(1800, 3200), { n: 4, t60: 0.05 }), 0.08);
  fadeOut(x, sr, 0.2);
  return fin([x], sr, -3);
}

function metalCreak(rng, sr) {
  // hanging sign / loose sheet: stick-slip friction exciting metal modes, then a soft bang
  const len = rng.range(1.2, 2.2);
  const x = buf(sr, len + 0.8);
  const n = samples(sr, len);
  const exc = new Float32Array(n);
  let ph = 0;
  const r0 = rng.range(25, 60), r1 = r0 * rng.range(1.5, 3);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const rate = r0 + (r1 - r0) * Math.sin(Math.PI * u);
    ph += rate / sr;
    if (ph >= 1) { ph -= 1; exc[i] = rng.range(0.4, 1) * Math.sin(Math.PI * u); }
  }
  const base = rng.range(180, 320);
  resonate(x, sr, 0, exc, metalModes(rng, base, { n: 8, t60: 0.25, bright: 0.45 }), 0.3);
  if (rng.chance(0.6)) resonate(x, sr, len + rng.range(0, 0.2), excite(rng, sr, 0.004, 100), metalModes(rng, rng.range(120, 220), { n: 9, t60: 0.6, bright: 0.4 }), 0.5);
  lp(x, sr, 3500);
  fadeOut(x, sr, 0.2);
  return fin([x], sr, -4);
}

function debrisSettle(rng, sr) {
  const x = buf(sr, 1.8);
  debrisRain(x, sr, 0, rng, { dur: rng.range(0.8, 1.5), count: rng.int(20, 50), amp: 0.3, fc: [700, 5000], peak: 0.2, chunks: rng.int(1, 3), chunkAmp: 0.25 });
  noiseBurst(x, sr, 0.05, rng, { amp: 0.05, attack: 0.1, tau: 0.3, bp: [2000, 0.6], dur: 1.2 }); // dust trickle
  fadeOut(x, sr, 0.2);
  return fin([x], sr, -4);
}

// ------------------------------------------------------------------------------------------ catalog
const A = {
  amb_wind: { gen: wind, variants: 1, bus: 'amb', loop: true, group: 'ambloop', maxVoices: 4, priority: 20, vol: 0.32, reverb: 0 },
  amb_bed: { gen: warBed, variants: 1, bus: 'amb', loop: true, group: 'ambloop', maxVoices: 4, priority: 20, vol: 0.2, reverb: 0 },
  amb_fire: { gen: fireLoop, variants: 1, bus: 'amb', loop: true, group: 'ambfire', maxVoices: 3, priority: 15, vol: 0.5, reverb: 0.1, spatial: { ref: 2, max: 30 }, mono: true },
  amb_artillery_far: { gen: artilleryFar, variants: 5, bus: 'amb', group: 'ambspot', maxVoices: 6, priority: 15, vol: 0.7, volVar: 3, pitchVar: 1.5, reverb: 0.15, spatial: { ref: 200, max: 5000 }, mono: true },
  amb_gunfire_far: { gen: (r, sr) => gunfireBurst(r, sr, 'rifle'), variants: 6, bus: 'amb', group: 'ambspot', maxVoices: 6, priority: 15, vol: 0.4, volVar: 3, pitchVar: 1, reverb: 0.1, spatial: { ref: 150, max: 5000 }, mono: true },
  amb_mg_far: { gen: (r, sr) => gunfireBurst(r, sr, 'lmg'), variants: 4, bus: 'amb', group: 'ambspot', maxVoices: 6, priority: 15, vol: 0.4, volVar: 3, pitchVar: 1, reverb: 0.1, spatial: { ref: 150, max: 5000 }, mono: true },
  amb_birds: { gen: birds, variants: 6, bus: 'amb', group: 'ambspot', maxVoices: 6, priority: 10, vol: 0.12, volVar: 3, pitchVar: 1.5, reverb: 0.15, spatial: { ref: 8, max: 120 }, mono: true },
  amb_tarp: { gen: tarpFlap, variants: 5, bus: 'amb', group: 'ambspot', maxVoices: 6, priority: 12, vol: 0.4, volVar: 2, pitchVar: 1, reverb: 0.12, spatial: { ref: 3, max: 60 }, mono: true },
  amb_metal_creak: { gen: metalCreak, variants: 4, bus: 'amb', group: 'ambspot', maxVoices: 6, priority: 10, vol: 0.2, volVar: 3, pitchVar: 1.5, reverb: 0.2, spatial: { ref: 5, max: 80 }, mono: true },
  amb_debris: { gen: debrisSettle, variants: 4, bus: 'amb', group: 'ambspot', maxVoices: 6, priority: 10, vol: 0.18, volVar: 3, pitchVar: 1, reverb: 0.2, spatial: { ref: 4, max: 60 }, mono: true },
};
export default A;

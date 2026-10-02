/**
 * audio/sounds/common.js — reusable sound-design layers built on dsp.js (foley, transients, metal,
 * cloth, debris...). Each layer mixes into a destination buffer at a start time.
 */
import {
  samples, mixInto, svf, white, pink, brown, envAD, mul, fadeOut, resonate, excite, metalModes, grains,
  scrape, wobble, clamp, noiseBurst, thump,
} from '../dsp.js';

/**
 * Friedlander blast pulse p(t) = (1 - t/T) * exp(-b t / T): the pressure signature of a muzzle blast /
 * explosion front. Positive phase T, then a longer negative phase. Broadband by construction.
 */
export function friedlander(dst, sr, t0, { T = 0.0012, b = 1.4, amp = 1, dur = 0, hp = 60, lp = 0 } = {}) {
  const n = samples(sr, dur || T * 7);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    s[i] = (1 - t / T) * Math.exp((-b * t) / T);
  }
  fadeOut(s, sr, (n / sr) * 0.4);
  if (hp) svf(s, sr, 'hp', hp);
  if (lp) svf(s, sr, 'lp', lp);
  mixInto(dst, s, t0 * sr, amp);
  return s;
}

/** Supersonic N-wave (bullet crack). width ~0.2-0.5 ms. */
export function nwave(dst, sr, t0, { width = 0.0004, amp = 1, hp = 900, rise = 0.00003 } = {}) {
  const n = samples(sr, width + 0.004);
  const s = new Float32Array(n);
  const nw = width * sr, nr = Math.max(1, rise * sr);
  for (let i = 0; i < n; i++) {
    let v = 0;
    if (i < nw) v = 1 - (2 * i) / nw;
    if (i < nr) v *= i / nr;
    else if (i >= nw && i < nw + nr) v = -1 + (i - nw) / nr;
    s[i] = v;
  }
  if (hp) svf(s, sr, 'hp', hp, 0.6);
  mixInto(dst, s, t0 * sr, amp);
  return s;
}

/** Small metallic click/tick (detents, triggers, selector). */
export function metalClick(dst, sr, t0, rng, { base = 3200, amp = 0.3, t60 = 0.02, bright = 0.6, n = 5, noise = 0.4 } = {}) {
  const e = excite(rng, sr, 0.0008, 1500);
  resonate(dst, sr, t0, e, metalModes(rng, base, { n, t60, bright }), amp);
  if (noise) noiseBurst(dst, sr, t0, rng, { amp: amp * noise, attack: 0.0001, tau: 0.0012, hp: 2500, dur: 0.01 });
}

/**
 * Heavy metal-on-metal impact (bolt slam, slide slam, mag seat). Modal body + low thud + noise crack.
 */
export function metalSlam(dst, sr, t0, rng, { base = 1400, amp = 0.8, t60 = 0.09, bright = 0.55, low = 160, lowAmp = 0.35, n = 8, crack = 0.5 } = {}) {
  const e = excite(rng, sr, 0.0015, 300);
  resonate(dst, sr, t0, e, metalModes(rng, base, { n, t60, bright }), amp);
  resonate(dst, sr, t0, e, metalModes(rng, base * 2.31, { n: 5, t60: t60 * 0.5, bright: 0.4 }), amp * 0.4);
  if (lowAmp) thump(dst, sr, t0, { f0: low * 1.6, f1: low, sweep: 0.006, tau: 0.018, amp: lowAmp, drive: 1.5 });
  if (crack) noiseBurst(dst, sr, t0, rng, { amp: amp * crack, attack: 0.0001, tau: 0.0018, hp: 1800, dur: 0.012 });
}

/** Polymer / plastic knock (magazine body, grips). */
export function polyKnock(dst, sr, t0, rng, { base = 650, amp = 0.4, t60 = 0.035 } = {}) {
  const e = excite(rng, sr, 0.002, 150, 6000);
  resonate(dst, sr, t0, e, [
    { f: base * rng.jit(1, 0.05), t60, amp: 1 },
    { f: base * 1.62 * rng.jit(1, 0.05), t60: t60 * 0.7, amp: 0.6 },
    { f: base * 2.75 * rng.jit(1, 0.05), t60: t60 * 0.5, amp: 0.35 },
    { f: base * 4.1 * rng.jit(1, 0.05), t60: t60 * 0.35, amp: 0.2 },
  ], amp);
  noiseBurst(dst, sr, t0, rng, { amp: amp * 0.35, attack: 0.0002, tau: 0.003, bp: [2400, 0.9], dur: 0.02 });
}

/**
 * Cloth rustle: fabric friction as dense micro-swishes with a smooth overall gesture.
 * { dur, amp, bright (0..1), intensity (0..1) }
 */
export function cloth(dst, sr, t0, rng, { dur = 0.35, amp = 0.25, bright = 0.5, intensity = 0.6, peakAt = 0.4 } = {}) {
  const n = samples(sr, dur);
  const s = pink(rng, n);
  svf(s, sr, 'hp', 350 + bright * 400);
  svf(s, sr, 'lp', 3200 + bright * 5000);
  const fine = wobble(rng, n, sr, 90 + intensity * 120);
  const mid = wobble(rng, n, sr, 9 + intensity * 10);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const g = u < peakAt ? Math.pow(u / peakAt, 1.3) : Math.pow((1 - u) / (1 - peakAt), 1.8);
    const r = Math.max(0, 0.35 + 0.65 * fine[i]) * Math.max(0.15, 0.6 + 0.5 * mid[i]);
    s[i] *= g * r;
  }
  // occasional crisp creases
  grains(s, sr, 0, rng, { count: Math.round(6 + intensity * 14), spread: dur * 0.9, amp: 0.25, fc: [2500, 7000], q: [0.7, 1.5], grainMs: [0.6, 3], shape: 1 });
  mixInto(dst, s, t0 * sr, amp);
  return s;
}

/** Gear/kit jingle: sling swivels, buckles, magazines in pouches. */
export function gearRattle(dst, sr, t0, rng, { dur = 0.25, amp = 0.25, count = 8, metal = 0.7, poly = 0.5 } = {}) {
  for (let i = 0; i < count; i++) {
    const t = t0 + Math.pow(rng.next(), 1.4) * dur;
    if (rng.next() < metal) {
      metalClick(dst, sr, t, rng, { base: rng.range(2200, 5200), amp: amp * rng.range(0.25, 0.8), t60: rng.range(0.015, 0.05), n: 4, noise: 0.3 });
    }
    if (rng.next() < poly) {
      polyKnock(dst, sr, t + rng.range(0, 0.01), rng, { base: rng.range(400, 900), amp: amp * rng.range(0.2, 0.55), t60: rng.range(0.015, 0.03) });
    }
  }
}

/** Brass casing bouncing on a surface. */
export function casingDrop(dst, sr, t0, rng, surface = 'concrete', { amp = 0.35, size = 1 } = {}) {
  const hard = surface === 'concrete' || surface === 'metal' || surface === 'tile' || surface === 'asphalt' || surface === 'brick' || surface === 'glass';
  const soft = surface === 'dirt' || surface === 'sand' || surface === 'grass' || surface === 'fabric' || surface === 'water';
  let t = t0, a = amp, gap = rng.range(0.07, 0.11);
  const bounces = soft ? 1 : rng.int(3, 5);
  // brass tube modes (roughly free-free tube with a head): bright, long ring on hard floors
  const base = rng.range(3600, 4400) / size;
  for (let b = 0; b < bounces; b++) {
    const e = excite(rng, sr, 0.0006, 1000);
    if (soft) {
      noiseBurst(dst, sr, t, rng, { amp: a * 0.5, attack: 0.0005, tau: 0.008, lp: 1800, hp: 120, dur: 0.05 });
      grains(dst, sr, t, rng, { count: 5, spread: 0.02, amp: a * 0.2, fc: [800, 3000] });
    } else {
      const ring = surface === 'metal' ? 0.5 : surface === 'wood' ? 0.06 : 0.3;
      resonate(dst, sr, t, e, [
        { f: base * rng.jit(1, 0.02), t60: ring, amp: 1 },
        { f: base * 2.02 * rng.jit(1, 0.02), t60: ring * 0.8, amp: 0.7 },
        { f: base * 2.87 * rng.jit(1, 0.02), t60: ring * 0.6, amp: 0.45 },
        { f: base * 4.3 * rng.jit(1, 0.02), t60: ring * 0.5, amp: 0.3 },
      ], a * (hard ? 0.7 : 0.4));
      noiseBurst(dst, sr, t, rng, { amp: a * 0.4, attack: 0.0001, tau: 0.0015, hp: 2000, dur: 0.01 });
      if (surface === 'wood') resonate(dst, sr, t, e, [{ f: rng.range(700, 1100), t60: 0.03, amp: 1 }], a * 0.5);
    }
    t += gap; gap *= rng.range(0.55, 0.7); a *= rng.range(0.4, 0.6);
    // roll: a few tiny ticks at the end
  }
  if (hard) grains(dst, sr, t, rng, { count: 6, spread: 0.12, amp: amp * 0.06, fc: [3500, 8000], q: [3, 8], grainMs: [0.5, 1.5], shape: 1 });
}

/** Debris / rubble rain (explosions, impacts): pebbles falling over time with gravity-like distribution. */
export function debrisRain(dst, sr, t0, rng, { dur = 1.5, count = 120, amp = 0.2, fc = [600, 5000], peak = 0.45, chunks = 6, chunkAmp = 0.35 } = {}) {
  for (let g = 0; g < count; g++) {
    // beta-ish distribution around `peak` fraction of dur
    const u = clamp(peak + (rng.next() + rng.next() + rng.next() - 1.5) * 0.45, 0, 1);
    const t = t0 + u * dur;
    const len = rng.range(0.6, 4) / 1000;
    const n = samples(sr, len);
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = (rng.next() * 2 - 1) * Math.exp((-4 * i) / n);
    const f = fc[0] * Math.pow(fc[1] / fc[0], rng.next());
    svf(s, sr, 'bp', f, rng.range(1, 4));
    const fall = Math.pow(1 - Math.abs(u - peak), 1.5);
    mixInto(dst, s, t * sr, amp * rng.range(0.15, 1) * fall);
  }
  for (let c = 0; c < chunks; c++) {
    const u = clamp(peak + (rng.next() - 0.5) * 0.8, 0, 1);
    const t = t0 + u * dur;
    // chunk of concrete/rock: short dull knock
    noiseBurst(dst, sr, t, rng, { amp: chunkAmp * rng.range(0.4, 1), attack: 0.0003, tau: rng.range(0.006, 0.02), lp: rng.range(900, 2500), hp: 80, dur: 0.08 });
    thump(dst, sr, t, { f0: rng.range(160, 260), f1: rng.range(70, 110), sweep: 0.01, tau: 0.03, amp: chunkAmp * 0.4 });
  }
}

/** Air whoosh (throws, swings, weapon movement). */
export function whoosh(dst, sr, t0, rng, { dur = 0.3, amp = 0.3, f0 = 400, f1 = 1400, q = 1.2, peakAt = 0.5 } = {}) {
  const n = samples(sr, dur);
  const s = pink(rng, n);
  svf(s, sr, 'bp', (t) => {
    const u = t / dur;
    return u < peakAt ? f0 + (f1 - f0) * (u / peakAt) : f1 - (f1 - f0) * 0.6 * ((u - peakAt) / (1 - peakAt));
  }, q);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const g = u < peakAt ? Math.pow(u / peakAt, 2) : Math.pow((1 - u) / (1 - peakAt), 2.2);
    s[i] *= g;
  }
  mixInto(dst, s, t0 * sr, amp);
  return s;
}

/** Soft body/ground thud (lowpassed noise + low sine), for footsteps, bodies, drops. */
export function thud(dst, sr, t0, rng, { amp = 0.5, lp = 600, tau = 0.015, f = 90, sineAmp = 0.5, dur = 0.12 } = {}) {
  noiseBurst(dst, sr, t0, rng, { amp, attack: 0.0006, tau, lp, hp: 40, dur, color: 'pink' });
  if (sineAmp) thump(dst, sr, t0, { f0: f * 1.7, f1: f, sweep: 0.012, tau: tau * 2.2, amp: amp * sineAmp });
}

export { white, pink, brown, envAD, mul };

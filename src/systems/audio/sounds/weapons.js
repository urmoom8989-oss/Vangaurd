/**
 * audio/sounds/weapons.js — gunshots (1P / 3P / distant / suppressed) and weapon mechanical foley.
 *
 * A gunshot is layered like a AAA weapon sound:
 *   blast   Friedlander pressure pulse + broadband noise whose lowpass closes over ~30 ms
 *   crack   supersonic N-wave
 *   punch   pitch-swept, saturated sine (chest thump) + short sub
 *   crackle turbulent gas expansion grains
 *   mech    bolt carrier / slide cycling (modal metal, 1P only)
 *   ground  ground reflection a few ms later (thickens the report)
 * The environment tail comes from the runtime ConvolverNode reverb (procedural IRs, see ../ir.js);
 * "far" versions bake their own rolling multi-echo tail because they come from outside the listener's space.
 */
import {
  samples, buf, svf, lp, hp, eq, white, pink, mixInto, softclip, asymclip, compress, normalize, dcBlock, fadeOut,
  decorrelate, width, noiseBurst, thump, grains, resonate, excite, metalModes, envAD, mul, clamp, reflect, Rand, scrape,
  toneMatch, convolve, scale, limit, rmsNormalize,
} from '../dsp.js';
import { friedlander, nwave, metalClick, metalSlam, polyKnock, cloth, gearRattle, whoosh, thud } from './common.js';

// ------------------------------------------------------------------------------------------ specs
export const WEAPON_SPECS = {
  rifle: {
    len: 0.75,
    blast: { T: 0.0011, amp: 1.0, noiseAmp: 0.85, tau: 0.0045, tau2: 0.028, mix2: 0.3, lp0: 17000, lp1: 2300, lpTau: 0.011, bark: [1350, 1.4, 0.45], chest: [260, 1.0, 4] },
    crack: { width: 0.00035, amp: 0.55 },
    punch: { f0: 210, f1: 58, sweep: 0.014, tau: 0.055, amp: 0.85, drive: 2.4 },
    sub: { f: 44, tau: 0.11, amp: 0.4 },
    crackle: { count: 90, spread: 0.075, amp: 0.22, fc: [1600, 8000] },
    mech: { base: 1850, amp: 0.3, hits: [[0.0, 0.35], [0.009, 0.55], [0.048, 1.0]], spring: 760, springAmp: 0.06, t60: 0.07 },
    ground: { delay: 0.0068, gain: 0.42, lp: 3200 },
    drive: 1.5, peakDb: -0.5,
  },
  pistol: {
    len: 0.6,
    blast: { T: 0.0008, amp: 0.9, noiseAmp: 0.8, tau: 0.0035, tau2: 0.02, mix2: 0.28, lp0: 15000, lp1: 2800, lpTau: 0.008, bark: [900, 1.2, 0.55], chest: [420, 1.1, 3] },
    crack: { width: 0.00025, amp: 0.3 },
    punch: { f0: 260, f1: 85, sweep: 0.01, tau: 0.04, amp: 0.7, drive: 2.0 },
    sub: { f: 55, tau: 0.07, amp: 0.25 },
    crackle: { count: 55, spread: 0.05, amp: 0.2, fc: [1400, 7000] },
    mech: { base: 2300, amp: 0.34, hits: [[0.0, 0.3], [0.012, 0.7], [0.034, 1.0]], spring: 1100, springAmp: 0.03, t60: 0.06 },
    ground: { delay: 0.0062, gain: 0.38, lp: 3000 },
    drive: 1.6, peakDb: -1.0,
  },
  smg: {
    len: 0.6,
    blast: { T: 0.0009, amp: 0.9, noiseAmp: 0.8, tau: 0.0038, tau2: 0.022, mix2: 0.3, lp0: 15500, lp1: 2600, lpTau: 0.009, bark: [1050, 1.3, 0.5], chest: [340, 1.0, 3.5] },
    crack: { width: 0.00025, amp: 0.3 },
    punch: { f0: 230, f1: 72, sweep: 0.011, tau: 0.045, amp: 0.75, drive: 2.2 },
    sub: { f: 50, tau: 0.08, amp: 0.3 },
    crackle: { count: 60, spread: 0.05, amp: 0.2, fc: [1500, 7500] },
    mech: { base: 2050, amp: 0.3, hits: [[0.0, 0.35], [0.007, 0.6], [0.03, 0.9]], spring: 900, springAmp: 0.04, t60: 0.05 },
    ground: { delay: 0.0065, gain: 0.4, lp: 3100 },
    drive: 1.6, peakDb: -1.0,
  },
  lmg: {
    len: 0.85,
    blast: { T: 0.0013, amp: 1.0, noiseAmp: 0.9, tau: 0.005, tau2: 0.034, mix2: 0.33, lp0: 16500, lp1: 2000, lpTau: 0.012, bark: [1150, 1.3, 0.5], chest: [220, 1.0, 4.5] },
    crack: { width: 0.00045, amp: 0.55 },
    punch: { f0: 190, f1: 50, sweep: 0.016, tau: 0.065, amp: 0.95, drive: 2.6 },
    sub: { f: 40, tau: 0.13, amp: 0.5 },
    crackle: { count: 100, spread: 0.085, amp: 0.24, fc: [1400, 7500] },
    mech: { base: 1500, amp: 0.34, hits: [[0.0, 0.35], [0.01, 0.6], [0.058, 1.0]], spring: 620, springAmp: 0.07, t60: 0.085 },
    ground: { delay: 0.0071, gain: 0.45, lp: 3000 },
    drive: 1.6, peakDb: -0.3,
  },
  sniper: {
    len: 1.0,
    blast: { T: 0.0017, amp: 1.0, noiseAmp: 0.95, tau: 0.006, tau2: 0.045, mix2: 0.38, lp0: 16000, lp1: 1700, lpTau: 0.014, bark: [900, 1.2, 0.5], chest: [180, 1.0, 5] },
    crack: { width: 0.0006, amp: 0.7 },
    punch: { f0: 170, f1: 42, sweep: 0.02, tau: 0.085, amp: 1.0, drive: 2.8 },
    sub: { f: 34, tau: 0.18, amp: 0.6 },
    crackle: { count: 130, spread: 0.11, amp: 0.25, fc: [1200, 7000] },
    mech: { base: 1300, amp: 0.2, hits: [[0.0, 0.4]], spring: 0, springAmp: 0, t60: 0.08 },
    ground: { delay: 0.0075, gain: 0.5, lp: 2800 },
    drive: 1.7, peakDb: -0.2,
  },
  shotgun: {
    len: 0.9,
    blast: { T: 0.0019, amp: 1.0, noiseAmp: 1.0, tau: 0.007, tau2: 0.05, mix2: 0.4, lp0: 14000, lp1: 1500, lpTau: 0.016, bark: [700, 1.1, 0.5], chest: [160, 1.0, 5] },
    crack: { width: 0.0002, amp: 0.15 },
    punch: { f0: 160, f1: 45, sweep: 0.022, tau: 0.09, amp: 1.0, drive: 3.0 },
    sub: { f: 36, tau: 0.16, amp: 0.6 },
    crackle: { count: 110, spread: 0.1, amp: 0.25, fc: [1000, 6000] },
    mech: { base: 1100, amp: 0.1, hits: [[0.0, 0.4]], spring: 0, springAmp: 0, t60: 0.05 },
    ground: { delay: 0.0072, gain: 0.5, lp: 2600 },
    drive: 1.8, peakDb: -0.2,
  },
};

/** Weapon id (any naming) -> spec class. */
export function weaponClass(id = '') {
  const s = String(id).toLowerCase();
  if (/pistol|p9|kestrel|handgun|sidearm|glock|revolver/.test(s)) return 'pistol';
  if (/smg|sub|mp\d|vector|uzi/.test(s)) return 'smg';
  if (/lmg|mg\b|saw|machine/.test(s)) return 'lmg';
  if (/sniper|dmr|marksman|bolt|\bsr\b/.test(s)) return 'sniper';
  if (/shotgun|sg\b|pump|12g/.test(s)) return 'shotgun';
  return 'rifle';
}

// ------------------------------------------------------------------------------------------ gunshot core
// Target octave balance (dB, bands 40,85,175,350,700,1.4k,2.8k,5.6k,11k,18k) over the first 300 ms.
const TONE = {
  '1p': [-7, -3, -1, 0, 0, -2, -4, -7, -12, -22],
  '3p': [-13, -8, -4, -1, 0, -1, -3, -6, -12, -24],
  far: [-5, 0, -1, -4, -8, -14, -24, -36, null, null],
  sup: [-12, -6, -2, 0, -1, -3, -5, -8, -13, -24],
};

/**
 * persp: '1p' (shooter), '3p' (someone else, ~5-40 m), 'far' (100 m+, own rolling tail)
 */
function gunshot(rng, sr, spec, persp = '1p', { suppressed = false } = {}) {
  const is1p = persp === '1p', isFar = persp === 'far';
  const len = isFar ? 3.2 : spec.len;
  const n = samples(sr, len);
  const M = new Float32Array(n); // centered body
  const S = new Float32Array(n); // decorrelated/diffuse parts
  const B = spec.blast;

  if (!suppressed) {
    // 1) Friedlander muzzle blast pulse
    friedlander(M, sr, 0, { T: B.T * rng.jit(1, 0.1), b: 1.3, amp: B.amp * (is1p ? 0.7 : 0.55), hp: 45 });
    // 2) blast noise: lowpass closes fast (bright crack -> dark body)
    const lpT = B.lpTau * rng.jit(1, 0.12);
    const lp0 = B.lp0 * (is1p ? 1 : 0.8), lp1 = B.lp1 * rng.jit(1, 0.1) * (is1p ? 1 : 0.85);
    const nb = new Float32Array(samples(sr, 0.4));
    const w = white(rng, nb.length);
    lp(w, sr, (t) => lp1 + (lp0 - lp1) * Math.exp(-t / lpT), 0.6);
    hp(w, sr, 70);
    mul(w, envAD(w.length, sr, 0.00015, B.tau * rng.jit(1, 0.1), B.tau2 * rng.jit(1, 0.12), B.mix2));
    // formant character: bark (mid) and chest (low-mid)
    const bark = w.slice(); svf(bark, sr, 'bp', B.bark[0] * rng.jit(1, 0.06), B.bark[1]);
    const chest = w.slice(); svf(chest, sr, 'bp', B.chest[0] * rng.jit(1, 0.06), B.chest[1]);
    for (let i = 0; i < w.length; i++) nb[i] = w[i] + bark[i] * B.bark[2] * 2 + chest[i] * (B.chest[2] * 0.25);
    mixInto(M, nb, 0, B.noiseAmp);
    // low body: dark noise (no tonal ringing), the "weight" of the report
    const lb = pink(rng, samples(sr, 0.3));
    lp(lb, sr, 320); lp(lb, sr, 420); hp(lb, sr, 38);
    mul(lb, envAD(lb.length, sr, 0.0012, (B.tau2 || 0.03) * 0.9, 0, 0));
    fadeOut(lb, sr, 0.05);
    mixInto(M, lb, 0.0005, 1.6 * (is1p ? 1 : 0.6));

    // 3) supersonic crack (for 1P it is fused with the blast; for 3P it is added by the runtime snap)
    if (is1p) nwave(M, sr, 0.00005, { width: spec.crack.width * rng.jit(1, 0.1), amp: spec.crack.amp * 0.7, hp: 1200 });

    // 4) punch + sub (short: felt, not heard as a tone)
    const P = spec.punch;
    thump(M, sr, 0.0003, { f0: P.f0 * rng.jit(1, 0.06), f1: P.f1 * 1.15 * rng.jit(1, 0.05), sweep: P.sweep, tau: P.tau * 0.55 * rng.jit(1, 0.1), amp: P.amp * 0.42 * (is1p ? 1 : 0.6), drive: P.drive, attack: 0.0008 });
    thump(M, sr, 0.001, { f0: spec.sub.f * 1.4, f1: spec.sub.f, sweep: 0.03, tau: spec.sub.tau * 0.5, amp: spec.sub.amp * 0.35 * (is1p ? 1 : 0.4), attack: 0.004 });

    // 5) turbulent crackle (gas expansion) — diffuse
    const C = spec.crackle;
    grains(S, sr, 0.0015, rng, { count: C.count, spread: C.spread * rng.jit(1, 0.15), amp: C.amp, fc: C.fc, q: [0.7, 2.2], grainMs: [0.3, 2.5], shape: 2.2, ampVar: 0.85 });
    noiseBurst(S, sr, 0.001, rng, { amp: 0.18, attack: 0.002, tau: 0.03, bp: [3200, 0.7], dur: 0.2 });
  } else {
    // SUPPRESSED: blast mostly trapped. Pneumatic "thwap" + can ring + downrange crack (rifle) + louder action.
    const w = white(rng, samples(sr, 0.25));
    lp(w, sr, (t) => 1100 + 5200 * Math.exp(-t / 0.005), 0.8);
    hp(w, sr, 110);
    mul(w, envAD(w.length, sr, 0.0005, 0.005, 0.028, 0.35));
    mixInto(M, w, 0, 0.7);
    const lb = pink(rng, samples(sr, 0.15));
    lp(lb, sr, 380); hp(lb, sr, 50);
    mul(lb, envAD(lb.length, sr, 0.001, 0.018, 0, 0));
    mixInto(M, lb, 0, 1.0);
    thump(M, sr, 0.0005, { f0: 260, f1: 110, sweep: 0.008, tau: 0.014, amp: 0.2, drive: 1.6 });
    noiseBurst(M, sr, 0.001, rng, { amp: 0.25, attack: 0.003, tau: 0.022, bp: [1600, 0.8], dur: 0.15 }); // "pfft"
    // baffle can ring
    resonate(S, sr, 0.0005, excite(rng, sr, 0.002, 800), [
      { f: 2350 * rng.jit(1, 0.03), t60: 0.05, amp: 1 }, { f: 3480 * rng.jit(1, 0.03), t60: 0.035, amp: 0.6 }, { f: 5200 * rng.jit(1, 0.03), t60: 0.02, amp: 0.4 },
    ], 0.1);
    if (spec.crack.amp > 0.4) nwave(M, sr, 0.0002, { width: spec.crack.width, amp: 0.22, hp: 2000 }); // supersonic bullet still cracks
  }

  // 6) mechanical action (bolt carrier / slide) — strongest in 1P and suppressed
  if (is1p || (suppressed && !isFar)) {
    const Me = spec.mech;
    const mAmp = Me.amp * (suppressed ? 1.8 : 1) * (is1p ? 1 : 0.5);
    for (const [t, a] of Me.hits) {
      const e = excite(rng, sr, 0.0012, 600);
      resonate(S, sr, t * rng.jit(1, 0.08), e, metalModes(rng, Me.base * rng.jit(1, 0.04), { n: 8, t60: Me.t60, bright: 0.6 }), mAmp * a);
    }
    if (Me.springAmp) { // buffer spring "sproing"
      resonate(S, sr, Me.hits[1]?.[0] ?? 0.01, excite(rng, sr, 0.004, 200, 3000), [
        { f: Me.spring * rng.jit(1, 0.05), t60: 0.12, amp: 1 }, { f: Me.spring * 2.63, t60: 0.08, amp: 0.4 },
      ], Me.springAmp * (suppressed ? 1.6 : 1));
    }
  }

  // 7) ground reflection (thickens the report)
  const G = spec.ground;
  if (!isFar) reflect(M, M.slice(), sr, G.delay * rng.jit(1, 0.1), G.gain * (suppressed ? 0.7 : 1), G.lp);

  let out;
  if (isFar) {
    out = farProcess(rng, sr, M, S, n);
    toneMatch(out, sr, TONE.far, { t0: 0, t1: 0.25, strength: 0.6 });
  } else {
    // density: saturate & glue
    softclip(M, spec.drive);
    compress(M, sr, { threshDb: -14, ratio: 3, attack: 0.0008, release: 0.05, makeupDb: 2 });
    if (is1p) {
      const [sl, sr2] = decorrelate(S, sr, 1, rng.int(1, 1e6));
      const L = M.slice(), R = M.slice();
      mixInto(L, sl, 0, 1); mixInto(R, sr2, 0, 1);
      // 1P: very slight width on the whole blast so it feels big but anchored
      const [dl, dr] = decorrelate(M, sr, 0.35, rng.int(1, 1e6));
      mixInto(L, dl, 0, 0.12); mixInto(R, dr, 0, 0.12);
      out = [L, R];
    } else {
      mixInto(M, S, 0, 0.8);
      out = [M];
    }
    const base = suppressed ? TONE.sup : TONE[persp];
    toneMatch(out, sr, base.map((v, i) => (v == null ? null : v + (spec.tone?.[i] || 0))), { t0: 0, t1: 0.3, strength: 0.85 });
  }
  for (const c of out) { dcBlock(c, sr, 18); fadeOut(c, sr, 0.03); }
  // master like a shipped asset: loudness-normalize the body, then brickwall the spikes
  const loud = (isFar ? -15 : suppressed ? -14.5 : persp === '3p' ? -13 : -11.5) + (spec.loud || 0);
  rmsNormalize(out, sr, loud, 0, isFar ? 0.3 : 0.12);
  limit(out, sr, { ceilingDb: -0.8, lookahead: 0.0012, release: 0.03 });
  return out;
}

/** Distant gunshot: smeared, dark report + rolling multi-echo tail from buildings/terrain. */
function farProcess(rng, sr, M, S, n) {
  const O = new Float32Array(n);
  const dry = M.slice(0, samples(sr, 0.3));
  mixInto(dry, S.slice(0, dry.length), 0, 0.3);
  fadeOut(dry, sr, 0.08);
  // air absorption
  lp(dry, sr, 2000 * rng.jit(1, 0.15), 0.6);
  lp(dry, sr, 3400);
  hp(dry, sr, 55);
  softclip(dry, 1.3);
  // atmospheric turbulence smears the wavefront: convolve with a short decaying noise kernel
  const kn = samples(sr, 0.03);
  const k = new Float32Array(kn);
  let ke = 0;
  for (let i = 0; i < kn; i++) { k[i] = (rng.next() * 2 - 1) * Math.exp(-i / (sr * 0.006)); ke += k[i] * k[i]; }
  k[0] = Math.sqrt(ke) * 2.5; // keep a coherent leading edge
  scale(k, 1 / Math.sqrt(ke + k[0] * k[0]));
  const sm = convolve(dry, k);
  mixInto(O, dry, 0, 0.55);
  mixInto(O, sm, 0, 0.6);
  // pre-filtered copies of the smeared report for the echo field (darker as paths get longer)
  const e1 = lp(sm.slice(), sr, 1500), e2 = lp(sm.slice(), sr, 800), e3 = lp(sm.slice(), sr, 420);
  // first strong facade slap
  const slapT = rng.range(0.14, 0.42);
  mixInto(O, e1, slapT * sr, rng.range(0.35, 0.5));
  // Poisson echo field, denser early, decaying
  let t = 0.05;
  while (t < 2.8) {
    const mean = 0.035 + 0.1 * Math.min(1, t / 1.6);
    t += -Math.log(1 - rng.next() * 0.999) * mean;
    const r = rng.next();
    const g = 0.55 * Math.exp(-t / 0.65) * (0.12 + 0.88 * r * r * r);
    const src = t < 0.5 ? e1 : t < 1.2 ? e2 : e3;
    mixInto(O, src, t * sr, g);
  }
  // diffuse low rumble bed
  const bed = pink(rng, n);
  lp(bed, sr, 420); hp(bed, sr, 35);
  for (let i = 0; i < n; i++) { const tt = i / sr; bed[i] *= 0.1 * Math.min(1, tt / 0.06) * Math.exp(-tt / 0.9); }
  mixInto(O, bed, 0, 1);
  return [O];
}

// ------------------------------------------------------------------------------------------ foley recipes
function mono(sr, sec) { return [buf(sr, sec)]; }
function fin(chans, sr, db = -3) { for (const c of chans) { dcBlock(c, sr, 20); fadeOut(c, sr, 0.015); } return normalize(chans, db); }
function stereoFoley(sr, M, rng, amt = 0.6) {
  const [L, R] = decorrelate(M, sr, 1, rng.int(1, 1e6));
  width(L, R, amt);
  return [L, R];
}

const FOLEY = {
  mag_out(rng, sr) {
    const [x] = mono(sr, 0.55);
    metalClick(x, sr, 0.0, rng, { base: rng.range(3000, 3800), amp: 0.35, t60: 0.02 }); // release button
    scrape(x, sr, 0.018, rng, { dur: 0.13, amp: 0.3, fc: (t) => 2200 - t * 5000, q: 1.4, rough: 0.8, rate: 140 });
    polyKnock(x, sr, 0.03, rng, { base: rng.range(700, 820), amp: 0.3, t60: 0.03 }); // mag unseats
    polyKnock(x, sr, 0.155, rng, { base: rng.range(520, 640), amp: 0.22, t60: 0.04 }); // clears the well
    metalClick(x, sr, 0.16, rng, { base: rng.range(2600, 3300), amp: 0.14, t60: 0.05 }); // feed lips/rounds rattle
    cloth(x, sr, 0.05, rng, { dur: 0.4, amp: 0.25, intensity: 0.7 });
    return stereoFoley(sr, fin([x], sr)[0], rng);
  },
  mag_in(rng, sr) {
    const [x] = mono(sr, 0.6);
    cloth(x, sr, 0.0, rng, { dur: 0.25, amp: 0.2, intensity: 0.6 });
    scrape(x, sr, 0.09, rng, { dur: 0.08, amp: 0.35, fc: (t) => 1700 + t * 6000, q: 1.5, rough: 0.7, rate: 160 }); // guide into well
    // seat: polymer knock + steel catch + low body
    metalSlam(x, sr, 0.17, rng, { base: rng.range(1050, 1250), amp: 0.65, t60: 0.06, low: 150, lowAmp: 0.45, crack: 0.45 });
    polyKnock(x, sr, 0.171, rng, { base: rng.range(600, 750), amp: 0.5, t60: 0.035 });
    metalClick(x, sr, 0.178, rng, { base: rng.range(3600, 4400), amp: 0.3, t60: 0.025 }); // catch snaps
    // palm tap re-seat
    thud(x, sr, 0.33, rng, { amp: 0.28, lp: 1100, tau: 0.008, f: 140, sineAmp: 0.35 });
    polyKnock(x, sr, 0.331, rng, { base: rng.range(620, 700), amp: 0.2, t60: 0.02 });
    return stereoFoley(sr, fin([x], sr)[0], rng);
  },
  bolt_release(rng, sr) {
    const [x] = mono(sr, 0.5);
    metalClick(x, sr, 0.0, rng, { base: rng.range(2400, 2900), amp: 0.3, t60: 0.02 }); // thumb on catch
    noiseBurst(x, sr, 0.004, rng, { amp: 0.12, attack: 0.004, tau: 0.01, bp: [3800, 1.2], dur: 0.03 }); // carrier travel
    metalSlam(x, sr, 0.022, rng, { base: rng.range(1350, 1600), amp: 1.0, t60: 0.11, bright: 0.6, low: 130, lowAmp: 0.55, crack: 0.6 });
    resonate(x, sr, 0.022, excite(rng, sr, 0.003, 150, 2500), [{ f: rng.range(680, 780), t60: 0.18, amp: 1 }, { f: 1790, t60: 0.1, amp: 0.4 }], 0.07); // spring
    gearRattle(x, sr, 0.03, rng, { dur: 0.12, amp: 0.12, count: 3, poly: 0.2 });
    return stereoFoley(sr, fin([x], sr, -2)[0], rng, 0.5);
  },
  charging_handle(rng, sr) {
    const [x] = mono(sr, 0.75);
    metalClick(x, sr, 0.0, rng, { base: 3200, amp: 0.25, t60: 0.015 }); // latch
    scrape(x, sr, 0.01, rng, { dur: 0.11, amp: 0.45, fc: (t) => 2600 + t * 9000, q: 1.8, rough: 0.9, rate: 220 }); // pull, spring compresses
    noiseBurst(x, sr, 0.03, rng, { amp: 0.12, attack: 0.03, tau: 0.03, bp: [5200, 2], dur: 0.1 });
    metalClick(x, sr, 0.125, rng, { base: 2200, amp: 0.4, t60: 0.04 }); // hits rear stop
    // release -> slam home
    scrape(x, sr, 0.29, rng, { dur: 0.03, amp: 0.25, fc: 3800, q: 1.5, rough: 0.6, rate: 300 });
    metalSlam(x, sr, 0.315, rng, { base: rng.range(1300, 1550), amp: 1.0, t60: 0.12, low: 125, lowAmp: 0.55, crack: 0.6 });
    metalClick(x, sr, 0.33, rng, { base: 2900, amp: 0.3, t60: 0.03 }); // handle latches
    return stereoFoley(sr, fin([x], sr, -2)[0], rng, 0.5);
  },
  fire_select(rng, sr) {
    const [x] = mono(sr, 0.18);
    metalClick(x, sr, 0.0, rng, { base: rng.range(3600, 4500), amp: 0.5, t60: 0.015, noise: 0.5 });
    metalClick(x, sr, rng.range(0.012, 0.02), rng, { base: rng.range(4200, 5200), amp: 0.7, t60: 0.02, noise: 0.6 });
    polyKnock(x, sr, 0.014, rng, { base: 900, amp: 0.15, t60: 0.015 });
    return [fin([x], sr, -4)[0]];
  },
  dry_fire(rng, sr) {
    const [x] = mono(sr, 0.2);
    metalClick(x, sr, 0.0, rng, { base: rng.range(2800, 3300), amp: 0.45, t60: 0.03, noise: 0.5 }); // trigger break
    metalClick(x, sr, 0.004, rng, { base: rng.range(1800, 2100), amp: 0.8, t60: 0.04, bright: 0.7 }); // hammer falls
    thud(x, sr, 0.004, rng, { amp: 0.12, lp: 1500, tau: 0.004, f: 200, sineAmp: 0.2 });
    return [fin([x], sr, -3)[0]];
  },
  weapon_raise(rng, sr) {
    const [x] = mono(sr, 0.6);
    cloth(x, sr, 0.0, rng, { dur: 0.42, amp: 0.45, intensity: 0.8, peakAt: 0.35 });
    whoosh(x, sr, 0.02, rng, { dur: 0.3, amp: 0.2, f0: 300, f1: 900, q: 0.9 });
    gearRattle(x, sr, 0.08, rng, { dur: 0.25, amp: 0.22, count: 6 });
    thud(x, sr, 0.3, rng, { amp: 0.25, lp: 900, tau: 0.01, f: 150, sineAmp: 0.3 }); // hand grabs handguard
    polyKnock(x, sr, 0.302, rng, { base: 560, amp: 0.2, t60: 0.03 });
    metalClick(x, sr, 0.31, rng, { base: 2700, amp: 0.15, t60: 0.05 });
    return stereoFoley(sr, fin([x], sr, -4)[0], rng, 0.7);
  },
  weapon_lower(rng, sr) {
    const [x] = mono(sr, 0.45);
    cloth(x, sr, 0.0, rng, { dur: 0.34, amp: 0.4, intensity: 0.7, peakAt: 0.25 });
    whoosh(x, sr, 0.0, rng, { dur: 0.25, amp: 0.15, f0: 800, f1: 400, q: 0.9, peakAt: 0.3 });
    gearRattle(x, sr, 0.05, rng, { dur: 0.2, amp: 0.2, count: 5 });
    return stereoFoley(sr, fin([x], sr, -6)[0], rng, 0.7);
  },
  ads_in(rng, sr) {
    const [x] = mono(sr, 0.35);
    cloth(x, sr, 0.0, rng, { dur: 0.22, amp: 0.4, intensity: 0.8, peakAt: 0.3, bright: 0.6 });
    gearRattle(x, sr, 0.03, rng, { dur: 0.1, amp: 0.2, count: 3, poly: 0.6 });
    polyKnock(x, sr, 0.12, rng, { base: rng.range(480, 560), amp: 0.2, t60: 0.02 }); // cheek weld / stock
    return stereoFoley(sr, fin([x], sr, -8)[0], rng, 0.6);
  },
  ads_out(rng, sr) {
    const [x] = mono(sr, 0.3);
    cloth(x, sr, 0.0, rng, { dur: 0.2, amp: 0.35, intensity: 0.7, peakAt: 0.25 });
    gearRattle(x, sr, 0.02, rng, { dur: 0.1, amp: 0.15, count: 2, poly: 0.6 });
    return stereoFoley(sr, fin([x], sr, -10)[0], rng, 0.6);
  },
  cloth_rustle(rng, sr) {
    const [x] = mono(sr, 0.6);
    cloth(x, sr, 0.0, rng, { dur: rng.range(0.35, 0.55), amp: 0.5, intensity: rng.range(0.4, 0.9), peakAt: rng.range(0.25, 0.6) });
    return stereoFoley(sr, fin([x], sr, -8)[0], rng, 0.8);
  },
  gear_rattle(rng, sr) {
    const [x] = mono(sr, 0.35);
    gearRattle(x, sr, 0.0, rng, { dur: 0.22, amp: 0.4, count: rng.int(5, 9) });
    cloth(x, sr, 0.0, rng, { dur: 0.25, amp: 0.2, intensity: 0.9 });
    return stereoFoley(sr, fin([x], sr, -9)[0], rng, 0.8);
  },
  pistol_mag_out(rng, sr) {
    const [x] = mono(sr, 0.45);
    metalClick(x, sr, 0.0, rng, { base: rng.range(3400, 4000), amp: 0.4, t60: 0.02 });
    scrape(x, sr, 0.01, rng, { dur: 0.07, amp: 0.3, fc: (t) => 3000 - t * 8000, q: 1.6, rough: 0.7, rate: 200 });
    metalClick(x, sr, 0.075, rng, { base: rng.range(2300, 2700), amp: 0.25, t60: 0.05 });
    cloth(x, sr, 0.05, rng, { dur: 0.3, amp: 0.2 });
    return stereoFoley(sr, fin([x], sr)[0], rng);
  },
  pistol_mag_in(rng, sr) {
    const [x] = mono(sr, 0.45);
    scrape(x, sr, 0.0, rng, { dur: 0.06, amp: 0.3, fc: (t) => 2000 + t * 10000, q: 1.6, rough: 0.7, rate: 200 });
    metalSlam(x, sr, 0.065, rng, { base: rng.range(1500, 1800), amp: 0.7, t60: 0.05, low: 180, lowAmp: 0.35, crack: 0.5 });
    polyKnock(x, sr, 0.066, rng, { base: 800, amp: 0.35, t60: 0.025 });
    thud(x, sr, 0.2, rng, { amp: 0.2, lp: 1200, tau: 0.007, f: 160, sineAmp: 0.3 });
    return stereoFoley(sr, fin([x], sr)[0], rng);
  },
  pistol_slide_release(rng, sr) {
    const [x] = mono(sr, 0.4);
    metalClick(x, sr, 0.0, rng, { base: 3000, amp: 0.3, t60: 0.02 });
    noiseBurst(x, sr, 0.003, rng, { amp: 0.1, attack: 0.003, tau: 0.008, bp: [4500, 1.2], dur: 0.02 });
    metalSlam(x, sr, 0.014, rng, { base: rng.range(1900, 2200), amp: 1, t60: 0.09, bright: 0.7, low: 170, lowAmp: 0.4, crack: 0.6 });
    return stereoFoley(sr, fin([x], sr, -2)[0], rng, 0.5);
  },
  low_ammo_tick(rng, sr) {
    // mechanical "ping" layer that CoD-style games add under the last rounds of a magazine
    const [x] = mono(sr, 0.35);
    resonate(x, sr, 0.0, excite(rng, sr, 0.0008, 1500), metalModes(rng, rng.range(2900, 3200), { n: 5, t60: 0.22, bright: 0.45 }), 0.6);
    metalClick(x, sr, 0.0, rng, { base: 5200, amp: 0.3, t60: 0.01 });
    return [fin([x], sr, -6)[0]];
  },
  grenade_pin(rng, sr) {
    const [x] = mono(sr, 0.75);
    cloth(x, sr, 0.0, rng, { dur: 0.25, amp: 0.2 });
    scrape(x, sr, 0.08, rng, { dur: 0.06, amp: 0.3, fc: 4200, q: 2.2, rough: 0.8, rate: 250 }); // pin slides out
    resonate(x, sr, 0.13, excite(rng, sr, 0.001, 1500), metalModes(rng, 2900, { n: 6, t60: 0.35, bright: 0.6 }), 0.35); // ring tink
    // spoon flies: spring lever snap
    metalClick(x, sr, 0.42, rng, { base: 2200, amp: 0.55, t60: 0.06, noise: 0.5 });
    resonate(x, sr, 0.42, excite(rng, sr, 0.001, 800), metalModes(rng, 1350, { n: 6, t60: 0.2, bright: 0.5 }), 0.25);
    return stereoFoley(sr, fin([x], sr, -4)[0], rng, 0.5);
  },
  grenade_throw(rng, sr) {
    const [x] = mono(sr, 0.6);
    cloth(x, sr, 0.0, rng, { dur: 0.4, amp: 0.4, intensity: 1, peakAt: 0.45 });
    whoosh(x, sr, 0.08, rng, { dur: 0.35, amp: 0.45, f0: 250, f1: 1300, q: 1.1, peakAt: 0.55 });
    gearRattle(x, sr, 0.05, rng, { dur: 0.2, amp: 0.2, count: 4 });
    return stereoFoley(sr, fin([x], sr, -4)[0], rng, 0.7);
  },
  reload_grab(rng, sr) {
    // support hand leaves the handguard and goes for the magazine: glove on polymer, sling shift
    const [x] = mono(sr, 0.45);
    cloth(x, sr, 0.0, rng, { dur: 0.3, amp: 0.4, intensity: 0.7, peakAt: 0.35 });
    polyKnock(x, sr, rng.range(0.02, 0.05), rng, { base: rng.range(520, 640), amp: 0.14, t60: 0.02 });
    gearRattle(x, sr, 0.06, rng, { dur: 0.15, amp: 0.14, count: 3, poly: 0.4 });
    return stereoFoley(sr, fin([x], sr, -9)[0], rng, 0.7);
  },
  mag_pouch(rng, sr) {
    // spent mag stowed in a dump pouch / fresh mag pulled from a kydex pouch
    const [x] = mono(sr, 0.5);
    cloth(x, sr, 0.0, rng, { dur: 0.32, amp: 0.4, intensity: 0.9, peakAt: 0.4, bright: 0.4 });
    scrape(x, sr, 0.04, rng, { dur: 0.09, amp: 0.2, fc: (t) => 1500 + t * 4000, q: 1.2, rough: 0.9, rate: 150 }); // polymer on nylon
    polyKnock(x, sr, 0.14, rng, { base: rng.range(480, 620), amp: 0.32, t60: 0.03 });
    metalClick(x, sr, 0.145, rng, { base: rng.range(2600, 3200), amp: 0.12, t60: 0.04 }); // rounds shift
    return stereoFoley(sr, fin([x], sr, -5)[0], rng, 0.6);
  },
  mag_tap(rng, sr) {
    // palm slap on the magazine base plate (inspect / seat check)
    const [x] = mono(sr, 0.3);
    thud(x, sr, 0.0, rng, { amp: 0.45, lp: 1400, tau: 0.006, f: 170, sineAmp: 0.3 });
    polyKnock(x, sr, 0.0005, rng, { base: rng.range(640, 760), amp: 0.4, t60: 0.028 });
    metalClick(x, sr, 0.003, rng, { base: rng.range(3200, 3800), amp: 0.12, t60: 0.03 });
    return stereoFoley(sr, fin([x], sr, -4)[0], rng, 0.5);
  },
  weapon_rattle(rng, sr) {
    // post-reload settle: rifle shaken back on target, sling swivels + QD + handguard rattle
    const [x] = mono(sr, 0.5);
    cloth(x, sr, 0.0, rng, { dur: 0.28, amp: 0.3, intensity: 0.8, peakAt: 0.3 });
    gearRattle(x, sr, 0.01, rng, { dur: 0.2, amp: 0.3, count: rng.int(5, 8), metal: 0.8, poly: 0.4 });
    polyKnock(x, sr, rng.range(0.1, 0.16), rng, { base: rng.range(500, 600), amp: 0.18, t60: 0.025 });
    return stereoFoley(sr, fin([x], sr, -7)[0], rng, 0.6);
  },
  pistol_rattle(rng, sr) {
    const [x] = mono(sr, 0.35);
    cloth(x, sr, 0.0, rng, { dur: 0.2, amp: 0.25, intensity: 0.7, peakAt: 0.3 });
    metalClick(x, sr, rng.range(0.02, 0.05), rng, { base: rng.range(3000, 3600), amp: 0.14, t60: 0.03 });
    polyKnock(x, sr, rng.range(0.06, 0.1), rng, { base: rng.range(700, 820), amp: 0.14, t60: 0.02 });
    return stereoFoley(sr, fin([x], sr, -9)[0], rng, 0.6);
  },
  weapon_inspect(rng, sr) {
    // rifle rolled over in the hands: long cloth gesture, glove creak on polymer, a few kit ticks
    const [x] = mono(sr, 1.1);
    cloth(x, sr, 0.0, rng, { dur: 0.9, amp: 0.4, intensity: 0.6, peakAt: 0.3 });
    whoosh(x, sr, 0.1, rng, { dur: 0.45, amp: 0.1, f0: 300, f1: 700, q: 0.8 });
    gearRattle(x, sr, 0.15, rng, { dur: 0.6, amp: 0.16, count: 5, metal: 0.7, poly: 0.6 });
    scrape(x, sr, 0.5, rng, { dur: 0.2, amp: 0.06, fc: 900, q: 3, rough: 1, rate: 60 }); // glove creak (stick-slip)
    return stereoFoley(sr, fin([x], sr, -9)[0], rng, 0.7);
  },
  pistol_raise(rng, sr) {
    const [x] = mono(sr, 0.45);
    cloth(x, sr, 0.0, rng, { dur: 0.3, amp: 0.4, intensity: 0.8, peakAt: 0.4 });
    scrape(x, sr, 0.02, rng, { dur: 0.1, amp: 0.12, fc: (t) => 1800 + t * 6000, q: 1.1, rough: 0.8, rate: 120 }); // out of the holster
    polyKnock(x, sr, 0.19, rng, { base: rng.range(700, 820), amp: 0.25, t60: 0.02 });
    metalClick(x, sr, 0.2, rng, { base: rng.range(2900, 3400), amp: 0.14, t60: 0.04 });
    return stereoFoley(sr, fin([x], sr, -5)[0], rng, 0.6);
  },
  grenade_equip(rng, sr) {
    const [x] = mono(sr, 0.4);
    cloth(x, sr, 0.0, rng, { dur: 0.28, amp: 0.4, intensity: 0.8 });
    resonate(x, sr, 0.16, excite(rng, sr, 0.001, 700), metalModes(rng, rng.range(1300, 1600), { n: 6, t60: 0.06, bright: 0.45 }), 0.2);
    return stereoFoley(sr, fin([x], sr, -7)[0], rng, 0.6);
  },
  melee_swing(rng, sr) {
    const [x] = mono(sr, 0.45);
    whoosh(x, sr, 0.0, rng, { dur: 0.3, amp: 0.6, f0: 300, f1: 1800, q: 1.3, peakAt: 0.55 });
    cloth(x, sr, 0.0, rng, { dur: 0.3, amp: 0.3, intensity: 1 });
    gearRattle(x, sr, 0.05, rng, { dur: 0.15, amp: 0.2, count: 4 });
    return stereoFoley(sr, fin([x], sr, -4)[0], rng, 0.7);
  },
  melee_hit(rng, sr) {
    const [x] = mono(sr, 0.4);
    thud(x, sr, 0.0, rng, { amp: 0.9, lp: 900, tau: 0.018, f: 85, sineAmp: 0.7 });
    noiseBurst(x, sr, 0.0, rng, { amp: 0.4, attack: 0.0003, tau: 0.004, bp: [2200, 0.8], dur: 0.03 });
    polyKnock(x, sr, 0.001, rng, { base: 420, amp: 0.4, t60: 0.03 });
    gearRattle(x, sr, 0.02, rng, { dur: 0.15, amp: 0.2, count: 4 });
    return [fin([x], sr, -2)[0]];
  },
};

// ------------------------------------------------------------------------------------------ catalog
const W = {};
for (const cls of Object.keys(WEAPON_SPECS)) {
  const spec = WEAPON_SPECS[cls];
  W[`${cls}_fire`] = { gen: (r, sr) => gunshot(r, sr, spec, '1p'), variants: 6, group: 'gun1p', maxVoices: 10, priority: 100, pitchVar: 0.35, volVar: 0.8, reverb: 0.55, er: 1, duck: true, tags: ['weapon', 'gunshot'] };
  W[`${cls}_fire_3p`] = { gen: (r, sr) => gunshot(r, sr, spec, '3p'), variants: 5, group: 'gun3p', maxVoices: 16, priority: 80, pitchVar: 0.5, volVar: 1, reverb: 0.6, spatial: { ref: 6, max: 600 }, mono: true, tags: ['weapon', 'gunshot'] };
  W[`${cls}_fire_far`] = { gen: (r, sr) => gunshot(r, sr, spec, 'far'), variants: 4, group: 'gunfar', maxVoices: 12, priority: 60, pitchVar: 0.6, volVar: 1.5, reverb: 0.25, spatial: { ref: 40, max: 3000 }, mono: true, tags: ['weapon', 'gunshot'] };
}
for (const cls of ['rifle', 'pistol', 'smg']) {
  const spec = WEAPON_SPECS[cls];
  W[`${cls}_fire_suppressed`] = { gen: (r, sr) => gunshot(r, sr, spec, '1p', { suppressed: true }), variants: 5, group: 'gun1p', maxVoices: 10, priority: 100, pitchVar: 0.35, volVar: 0.8, reverb: 0.3, er: 0.3, tags: ['weapon', 'gunshot'] };
  W[`${cls}_fire_suppressed_3p`] = { gen: (r, sr) => gunshot(r, sr, spec, '3p', { suppressed: true }), variants: 4, group: 'gun3p', maxVoices: 12, priority: 70, pitchVar: 0.5, volVar: 1, reverb: 0.35, spatial: { ref: 3, max: 150 }, mono: true, tags: ['weapon', 'gunshot'] };
}
const FOLEY_META = {
  mag_out: { variants: 4, vol: 0.8 }, mag_in: { variants: 4, vol: 0.9 }, bolt_release: { variants: 3, vol: 0.95 },
  charging_handle: { variants: 3, vol: 0.9 }, fire_select: { variants: 3, vol: 0.6 }, dry_fire: { variants: 3, vol: 0.7 },
  weapon_raise: { variants: 3, vol: 0.55 }, weapon_lower: { variants: 3, vol: 0.45 }, ads_in: { variants: 4, vol: 0.35 },
  ads_out: { variants: 4, vol: 0.28 }, cloth_rustle: { variants: 6, vol: 0.35 }, gear_rattle: { variants: 6, vol: 0.35 },
  pistol_mag_out: { variants: 3, vol: 0.8 }, pistol_mag_in: { variants: 3, vol: 0.9 }, pistol_slide_release: { variants: 3, vol: 0.95 },
  low_ammo_tick: { variants: 3, vol: 0.45 }, grenade_pin: { variants: 3, vol: 0.7 }, grenade_throw: { variants: 3, vol: 0.6 },
  melee_swing: { variants: 3, vol: 0.6 }, melee_hit: { variants: 3, vol: 0.9 },
  reload_grab: { variants: 3, vol: 0.35 }, mag_pouch: { variants: 3, vol: 0.6 }, mag_tap: { variants: 3, vol: 0.6 },
  weapon_rattle: { variants: 4, vol: 0.45 }, pistol_rattle: { variants: 3, vol: 0.4 }, weapon_inspect: { variants: 2, vol: 0.4 },
  pistol_raise: { variants: 3, vol: 0.5 }, grenade_equip: { variants: 2, vol: 0.45 },
};
for (const k of ['grenade_pin', 'grenade_throw', 'weapon_raise', 'pistol_raise', 'weapon_lower']) FOLEY_META[k].minGap = 0.4;
for (const k of Object.keys(FOLEY)) {
  W[k] = { gen: FOLEY[k], group: 'foley1p', maxVoices: 8, priority: 50, pitchVar: 0.4, volVar: 1, reverb: 0.12, tags: ['weapon', 'foley'], ...FOLEY_META[k] };
}

export default W;
export { gunshot };
// used by ambience (distant bursts)
export function farShotInto(dst, sr, t0, rng, cls = 'rifle', gain = 1) {
  const [x] = gunshot(rng, sr, WEAPON_SPECS[cls], 'far');
  mixInto(dst, x, t0 * sr, gain);
}
export { Rand };

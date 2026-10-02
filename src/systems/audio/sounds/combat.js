/**
 * audio/sounds/combat.js — bullet flybys (supersonic snap + whizz), explosions (near / far / debris),
 * hit feedback (hitmarker tick, headshot, kill confirm), player damage, heartbeat, tinnitus.
 */
import {
  samples, buf, svf, lp, hp, eq, white, pink, brown, mixInto, softclip, dcBlock, fadeOut, fadeIn, noiseBurst, thump,
  grains, resonate, excite, metalModes, envAD, mul, limit, rmsNormalize, decorrelate, width, toneMatch, wobble, chirp,
  normalize, panInto, loopify,
} from '../dsp.js';
import { friedlander, nwave, metalClick, polyKnock, cloth, gearRattle, debrisRain, thud } from './common.js';

function master(chans, sr, rmsDb, t1 = 0.1, ceil = -1) {
  for (const c of chans) { dcBlock(c, sr, 20); fadeOut(c, sr, 0.03); }
  rmsNormalize(chans, sr, rmsDb, 0, t1);
  limit(chans, sr, { ceilingDb: ceil, lookahead: 0.0012, release: 0.04 });
  return chans;
}

// ------------------------------------------------------------------------------------------ flybys
/** Supersonic crack passing within a few meters: razor N-wave + ground slap + short air tear. */
function bulletSnap(rng, sr) {
  const x = buf(sr, 0.35);
  nwave(x, sr, 0.0005, { width: rng.range(0.00022, 0.00038), amp: 1, hp: 700, rise: 0.00002 });
  friedlander(x, sr, 0.0005, { T: 0.00025, amp: 0.4, hp: 1500 });
  // ground / wall slaps of the shock cone
  const s1 = rng.range(0.003, 0.009);
  nwave(x, sr, s1, { width: 0.0004, amp: 0.45, hp: 900 });
  noiseBurst(x, sr, s1, rng, { amp: 0.2, attack: 0.0002, tau: 0.004, bp: [3000, 0.7], dur: 0.03 });
  // zip: air tearing behind the round
  noiseBurst(x, sr, 0.001, rng, { amp: 0.3, attack: 0.001, tau: 0.018, bp: [rng.range(3500, 5500), 1.2], dur: 0.1 });
  noiseBurst(x, sr, 0.001, rng, { amp: 0.25, attack: 0.002, tau: 0.03, lp: 1500, hp: 200, dur: 0.14, color: 'pink' });
  return master([x], sr, -13, 0.05, -1);
}

/** Whizz: tearing air with doppler drop, panned across (baked stereo, dir = +1 L->R, -1 R->L). */
function bulletWhizz(rng, sr, dir) {
  const dur = rng.range(0.28, 0.4);
  const n = samples(sr, dur);
  const L = new Float32Array(n), R = new Float32Array(n);
  const pass = rng.range(0.4, 0.55); // closest approach
  const f0 = rng.range(3800, 5200), f1 = f0 * rng.range(0.35, 0.5);
  const s = white(rng, n);
  svf(s, sr, 'bp', (t) => {
    const u = t / dur;
    const k = 1 / (1 + Math.exp(-(u - pass) * 22)); // doppler sigmoid
    return f0 + (f1 - f0) * k;
  }, 2.2);
  const tone = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const k = 1 / (1 + Math.exp(-(u - pass) * 22));
    ph += (2 * Math.PI * (f0 * 0.9 + (f1 * 0.9 - f0 * 0.9) * k)) / sr;
    tone[i] = Math.sin(ph) * 0.12;
  }
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const d = (u - pass) / 0.14;
    const env = 1 / (1 + d * d * 3) * Math.min(1, u * 12) * Math.min(1, (1 - u) * 8);
    const v = (s[i] + tone[i]) * env;
    const p = Math.max(-1, Math.min(1, dir * (u - pass) * 4));
    const a = ((p + 1) * Math.PI) / 4;
    L[i] = v * Math.cos(a); R[i] = v * Math.sin(a);
  }
  return master([L, R], sr, -16, dur, -3);
}

// ------------------------------------------------------------------------------------------ explosions
function explosionNear(rng, sr) {
  const len = 4.5;
  const n = samples(sr, len);
  const M = new Float32Array(n);
  // shock front
  friedlander(M, sr, 0, { T: rng.range(0.003, 0.005), b: 1.2, amp: 1, hp: 25 });
  // fireball blast: bright crack -> dark roar
  const w = white(rng, samples(sr, 1.6));
  lp(w, sr, (t) => 350 + 9000 * Math.exp(-t / 0.03), 0.7);
  hp(w, sr, 30);
  mul(w, envAD(w.length, sr, 0.0008, 0.03, 0.35, 0.45));
  mixInto(M, w, 0, 1.0);
  // low body: roar and pressure
  const lb = brown(rng, samples(sr, 3));
  lp(lb, sr, 180); hp(lb, sr, 22);
  mul(lb, envAD(lb.length, sr, 0.004, 0.25, 1.1, 0.4));
  mixInto(M, lb, 0, 2.2);
  thump(M, sr, 0.0005, { f0: 110, f1: 32, sweep: 0.04, tau: 0.22, amp: 0.8, drive: 2.2, attack: 0.002 });
  thump(M, sr, 0.002, { f0: 55, f1: 26, sweep: 0.1, tau: 0.5, amp: 0.45, attack: 0.01 });
  // sizzling crackle as gases burn off
  const S = new Float32Array(n);
  grains(S, sr, 0.004, rng, { count: 260, spread: 0.5, amp: 0.25, fc: [900, 7000], q: [0.7, 2], grainMs: [0.3, 3], shape: 2.4, ampVar: 0.9 });
  // debris: dirt/stones/metal fragments rain down over ~2.5 s
  debrisRain(S, sr, 0.15, rng, { dur: 2.6, count: 520, amp: 0.14, fc: [500, 6500], peak: 0.33, chunks: 22, chunkAmp: 0.22 });
  for (let k = 0; k < 6; k++) { // metal fragments tinkling
    const t = rng.range(0.4, 2.4);
    resonate(S, sr, t, excite(rng, sr, 0.001, 1000), metalModes(rng, rng.range(1800, 4000), { n: 5, t60: 0.12, bright: 0.5 }), 0.05);
  }
  // near-field ground reflection & first facade slap
  const early = M.slice(0, samples(sr, 0.6));
  fadeOut(early, sr, 0.2);
  mixInto(M, lp(early.slice(), sr, 2000), 0.008 * sr, 0.35);
  softclip(M, 1.8);
  const [SL, SR] = decorrelate(S, sr, 1, rng.int(1, 1e6));
  const [ML, MR] = decorrelate(M, sr, 0.6, rng.int(1, 1e6));
  const L = M.slice(), R = M.slice();
  mixInto(L, ML, 0, 0.25); mixInto(R, MR, 0, 0.25);
  mixInto(L, SL, 0, 1); mixInto(R, SR, 0, 1);
  toneMatch([L, R], sr, [-2, 0, -1, -3, -5, -8, -11, -15, -20, -30], { t1: 0.5, strength: 0.7 });
  return master([L, R], sr, -12, 0.4, -0.8);
}

function explosionFar(rng, sr, { len = 5, lpF = 700, weight = 1 } = {}) {
  const n = samples(sr, len);
  const x = new Float32Array(n);
  const w = pink(rng, samples(sr, 2));
  lp(w, sr, lpF); lp(w, sr, lpF * 1.4); hp(w, sr, 25);
  mul(w, envAD(w.length, sr, 0.012, 0.08, 0.6, 0.5));
  mixInto(x, w, 0, 1);
  thump(x, sr, 0, { f0: 70, f1: 28, sweep: 0.08, tau: 0.35 * weight, amp: 0.7, attack: 0.012 });
  // rolling thunder: long irregular rumble with echo bumps
  const r = brown(rng, n);
  lp(r, sr, 160); hp(r, sr, 20);
  const wob = wobble(rng, n, sr, 3.5);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    r[i] *= (0.5 + 0.5 * Math.max(0, wob[i] + 0.3)) * Math.min(1, t / 0.15) * Math.exp(-t / (1.2 * weight));
  }
  mixInto(x, r, 0, 1.6);
  for (let k = 0; k < 8; k++) {
    const t = rng.range(0.25, len * 0.55);
    const e = w.slice(0, samples(sr, 0.6)); lp(e, sr, 400); fadeOut(e, sr, 0.3);
    mixInto(x, e, t * sr, 0.35 * Math.exp(-t / 1.4) * rng.range(0.3, 1));
  }
  return master([x], sr, -15, 0.8, -1);
}

// ------------------------------------------------------------------------------------------ feedback
function hitmarker(rng, sr, kind) {
  const x = buf(sr, kind === 'kill' ? 0.4 : 0.25);
  // crisp dry tick: tiny noise click + short high modes + a hint of body
  noiseBurst(x, sr, 0, rng, { amp: 0.7, attack: 0.00005, tau: 0.0009, hp: 1800, dur: 0.008 });
  resonate(x, sr, 0, excite(rng, sr, 0.0005, 1200), [
    { f: 3150, t60: 0.018, amp: 1 }, { f: 4620, t60: 0.014, amp: 0.7 }, { f: 6900, t60: 0.01, amp: 0.45 },
  ], 0.6);
  thump(x, sr, 0, { f0: 520, f1: 240, sweep: 0.003, tau: 0.006, amp: 0.25 });
  if (kind === 'headshot') {
    // metallic "dink" layered on the tick
    resonate(x, sr, 0.001, excite(rng, sr, 0.0006, 1500), [
      { f: 2480, t60: 0.14, amp: 1 }, { f: 3710, t60: 0.1, amp: 0.55 }, { f: 5530, t60: 0.07, amp: 0.4 }, { f: 7950, t60: 0.05, amp: 0.25 },
    ], 0.55);
  }
  if (kind === 'kill') {
    // heavier "thwack": body + mid knock + soft low confirm
    thump(x, sr, 0, { f0: 190, f1: 85, sweep: 0.01, tau: 0.03, amp: 0.8, drive: 1.6 });
    noiseBurst(x, sr, 0, rng, { amp: 0.5, attack: 0.0002, tau: 0.006, bp: [1300, 0.9], dur: 0.04 });
    polyKnock(x, sr, 0.0005, rng, { base: 820, amp: 0.4, t60: 0.03 });
    resonate(x, sr, 0.002, excite(rng, sr, 0.0008, 800), [{ f: 1560, t60: 0.1, amp: 1 }, { f: 2340, t60: 0.07, amp: 0.4 }], 0.18);
  }
  const out = [x];
  for (const c of out) dcBlock(c, sr, 30);
  return normalize(out, kind === 'hit' ? -6 : -3);
}

function playerHit(rng, sr) {
  const x = buf(sr, 0.6);
  // felt, not heard: dull body thump + plate/kit knock + a sharp flesh/fabric tick
  thump(x, sr, 0, { f0: 150, f1: 55, sweep: 0.012, tau: 0.06, amp: 1, drive: 2 });
  noiseBurst(x, sr, 0, rng, { amp: 0.6, attack: 0.0005, tau: 0.02, lp: 900, hp: 60, dur: 0.12, color: 'pink' });
  noiseBurst(x, sr, 0, rng, { amp: 0.3, attack: 0.0002, tau: 0.004, bp: [2200, 1], dur: 0.03 });
  polyKnock(x, sr, 0.002, rng, { base: rng.range(380, 520), amp: 0.35, t60: 0.04 });
  gearRattle(x, sr, 0.01, rng, { dur: 0.15, amp: 0.2, count: 4 });
  const out = [x];
  return master(out, sr, -10, 0.1);
}

function heartbeat(rng, sr) {
  // one beat cycle at 72 bpm (0.833 s); runtime playbackRate raises tempo
  const len = 0.8333;
  const x = buf(sr, len + 0.4);
  const beat = (t, a, f) => {
    thump(x, sr, t, { f0: f * 1.6, f1: f, sweep: 0.015, tau: 0.045, amp: a, attack: 0.006 });
    noiseBurst(x, sr, t, rng, { amp: a * 0.3, attack: 0.004, tau: 0.02, lp: 180, dur: 0.12, color: 'brown' });
  };
  beat(0.0, 1, 52);
  beat(0.27, 0.7, 46);
  lp(x, sr, 220);
  // fold the tail back to make the cycle loop seamlessly
  const n = samples(sr, len);
  for (let i = n; i < x.length; i++) x[i - n] += x[i];
  const out = x.slice(0, n);
  return normalize([out], -3);
}

function tinnitus(rng, sr) {
  const len = 4.5;
  const n = samples(sr, len);
  const L = new Float32Array(n), R = new Float32Array(n);
  const f = rng.range(3300, 3900);
  const hiss = white(rng, n);
  svf(hiss, sr, 'bp', f, 5);
  let p1 = 0, p2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.08) * Math.pow(Math.max(0, 1 - t / len), 1.6);
    p1 += (2 * Math.PI * f) / sr; p2 += (2 * Math.PI * (f * 1.0035)) / sr; // slow beating between ears
    L[i] = (Math.sin(p1) * 0.8 + hiss[i] * 0.6) * env;
    R[i] = (Math.sin(p2) * 0.8 + hiss[i] * 0.6) * env;
  }
  return normalize([L, R], -8);
}

function grenadeWarn(rng, sr) {
  // a "cook" tick / fuse hiss for live grenades nearby
  const x = buf(sr, 1.2);
  const n = samples(sr, 1.1);
  const s = white(rng, n);
  svf(s, sr, 'bp', 4200, 1.5);
  const wob = wobble(rng, n, sr, 30);
  for (let i = 0; i < n; i++) s[i] *= (0.6 + 0.4 * wob[i]) * Math.min(1, i / (sr * 0.05));
  mixInto(x, s, 0, 0.2);
  fadeOut(x, sr, 0.1);
  return normalize([x], -14);
}

/** Breath: filtered noise through a few vocal-tract formants (no pitch: unvoiced breathing). */
function breathInto(dst, sr, t0, rng, { dur = 0.5, amp = 0.3, inhale = false, f1 = 700, f2 = 1300, f3 = 2600 } = {}) {
  const n = samples(sr, dur);
  const s = pink(rng, n);
  const a = s.slice(), b = s.slice(), c = s.slice();
  svf(a, sr, 'bp', (t) => f1 * (1 + (inhale ? 0.15 : -0.1) * t / dur), 3);
  svf(b, sr, 'bp', f2, 4);
  svf(c, sr, 'bp', f3, 5);
  hp(s, sr, 900); lp(s, sr, 5500);
  const w = wobble(rng, n, sr, 14);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const env = inhale ? Math.pow(Math.sin(Math.PI * Math.pow(u, 0.8)), 1.5) : Math.pow(Math.min(1, u * 6), 1.2) * Math.pow(1 - u, 1.4);
    s[i] = (a[i] * 0.9 + b[i] * 0.6 + c[i] * 0.35 + s[i] * (inhale ? 0.45 : 0.25)) * env * (0.85 + 0.15 * w[i]);
  }
  mixInto(dst, s, t0 * sr, amp);
}

function breathRecover(rng, sr) {
  // two slowing recovery breaths after taking fire (heard from inside the head)
  const x = buf(sr, 2.6);
  const f1 = rng.range(620, 760), f2 = rng.range(1150, 1350);
  breathInto(x, sr, 0.0, rng, { dur: 0.42, amp: 0.8, inhale: true, f1, f2 });
  breathInto(x, sr, 0.46, rng, { dur: 0.7, amp: 1.0, inhale: false, f1: f1 * 0.9, f2 });
  breathInto(x, sr, 1.25, rng, { dur: 0.5, amp: 0.55, inhale: true, f1, f2 });
  breathInto(x, sr, 1.8, rng, { dur: 0.75, amp: 0.6, inhale: false, f1: f1 * 0.9, f2 });
  const [L, R] = decorrelate(x, sr, 0.4, rng.int(1, 1e6));
  width(L, R, 0.35);
  return normalize([L, R], -6);
}

// ------------------------------------------------------------------------------------------ catalog
const C = {
  bullet_snap: { gen: bulletSnap, variants: 6, group: 'flyby', maxVoices: 6, priority: 85, vol: 0.85, volVar: 2, pitchVar: 0.8, reverb: 0.25, spatial: { ref: 2, max: 30 }, mono: true },
  bullet_whizz_l2r: { gen: (r, sr) => bulletWhizz(r, sr, 1), variants: 4, group: 'flyby', maxVoices: 6, priority: 70, vol: 0.55, volVar: 2, pitchVar: 1, reverb: 0.05 },
  bullet_whizz_r2l: { gen: (r, sr) => bulletWhizz(r, sr, -1), variants: 4, group: 'flyby', maxVoices: 6, priority: 70, vol: 0.55, volVar: 2, pitchVar: 1, reverb: 0.05 },
  explosion_grenade: { gen: explosionNear, variants: 4, group: 'explosion', maxVoices: 4, priority: 110, vol: 1, volVar: 1, pitchVar: 0.8, reverb: 0.7, spatial: { ref: 10, max: 900 }, duck: true },
  explosion_far: { gen: (r, sr) => explosionFar(r, sr), variants: 4, group: 'explosion', maxVoices: 4, priority: 90, vol: 0.9, volVar: 1.5, pitchVar: 1, reverb: 0.3, spatial: { ref: 60, max: 3000 }, mono: true },
  hitmarker: { gen: (r, sr) => hitmarker(r, sr, 'hit'), variants: 1, bus: 'ui', group: 'hitmarker', maxVoices: 3, priority: 95, vol: 0.55, volVar: 0.5, pitchVar: 0.3, reverb: 0 },
  hitmarker_headshot: { gen: (r, sr) => hitmarker(r, sr, 'headshot'), variants: 1, bus: 'ui', group: 'hitmarker', maxVoices: 3, priority: 96, vol: 0.6, volVar: 0.5, pitchVar: 0.2, reverb: 0 },
  hitmarker_kill: { gen: (r, sr) => hitmarker(r, sr, 'kill'), variants: 1, bus: 'ui', group: 'hitmarker', maxVoices: 3, priority: 97, vol: 0.7, volVar: 0.3, pitchVar: 0.2, reverb: 0, tone: [-26, -11, -3, 0, -3, -2, 0, -4, -9, -16], toneWin: [0, 0.2] },
  player_hit: { gen: playerHit, variants: 4, group: 'player', maxVoices: 3, priority: 90, vol: 0.8, volVar: 1, pitchVar: 0.6, reverb: 0.05 },
  heartbeat: { gen: heartbeat, variants: 1, bus: 'sfx', group: 'heartbeat', maxVoices: 1, priority: 99, vol: 0.7, loop: true, reverb: 0 },
  tinnitus: { gen: tinnitus, variants: 2, bus: 'ui', group: 'tinnitus', maxVoices: 1, priority: 99, vol: 0.35, reverb: 0 },
  grenade_fuse: { gen: grenadeWarn, variants: 2, group: 'bounce', maxVoices: 2, priority: 60, vol: 0.4, reverb: 0.05, spatial: { ref: 2, max: 15 }, mono: true },
};
C.kill_confirm = { ...C.hitmarker_kill };
C.breath_recover = { gen: breathRecover, variants: 3, bus: 'voice', group: 'breath', maxVoices: 1, priority: 60, vol: 0.28, volVar: 1, pitchVar: 0.5, reverb: 0, minGap: 3 };

export default C;
export { explosionFar };

/**
 * audio/sounds/ui.js — menu & HUD sounds. Tactile, restrained, "military hardware" rather than arcade:
 * short filtered clicks, soft plucks, subtle whooshes; nothing sings.
 */
import {
  buf, samples, svf, lp, hp, white, pink, mixInto, dcBlock, fadeOut, noiseBurst, thump, resonate, excite, normalize, chirp, decorrelate, width,
} from '../dsp.js';
import { polyKnock, metalClick, whoosh } from './common.js';

/** Soft sine pluck with a quick attack and exponential decay, optional 2nd partial. */
function pluck(dst, sr, t0, f, { amp = 0.3, tau = 0.08, dur = 0.4, h2 = 0.15, h3 = 0.05 } = {}) {
  chirp(dst, sr, t0, { dur, f, amp, h2, h3, env: (u) => Math.min(1, u * dur / 0.003) * Math.exp(-(u * dur) / tau) });
}

function fin(chans, sr, db) { for (const c of chans) { dcBlock(c, sr, 30); fadeOut(c, sr, 0.01); } return normalize(chans, db); }
function st(x, sr, rng, w = 0.5) { const [L, R] = decorrelate(x, sr, 1, rng.int(1, 1e6)); width(L, R, w); return [L, R]; }

const UI = {
  ui_hover(rng, sr) {
    const x = buf(sr, 0.12);
    noiseBurst(x, sr, 0, rng, { amp: 0.4, attack: 0.0002, tau: 0.002, bp: [2600, 1.5], dur: 0.02 });
    pluck(x, sr, 0, 1750, { amp: 0.12, tau: 0.02, dur: 0.1, h2: 0 });
    return [fin([x], sr, -14)[0]];
  },
  ui_click(rng, sr) {
    const x = buf(sr, 0.2);
    polyKnock(x, sr, 0, rng, { base: 900, amp: 0.5, t60: 0.02 });
    metalClick(x, sr, 0.004, rng, { base: 3600, amp: 0.35, t60: 0.015, noise: 0.5 });
    thump(x, sr, 0, { f0: 260, f1: 140, sweep: 0.005, tau: 0.012, amp: 0.3 });
    return [fin([x], sr, -8)[0]];
  },
  ui_confirm(rng, sr) {
    const x = buf(sr, 0.6);
    polyKnock(x, sr, 0, rng, { base: 800, amp: 0.4, t60: 0.02 });
    pluck(x, sr, 0.0, 587.3, { amp: 0.25, tau: 0.12, dur: 0.45 });
    pluck(x, sr, 0.065, 880, { amp: 0.22, tau: 0.16, dur: 0.5 });
    thump(x, sr, 0, { f0: 180, f1: 90, sweep: 0.01, tau: 0.03, amp: 0.35 });
    return st(fin([x], sr, -6)[0], sr, rng, 0.4);
  },
  ui_back(rng, sr) {
    const x = buf(sr, 0.45);
    polyKnock(x, sr, 0, rng, { base: 700, amp: 0.35, t60: 0.02 });
    pluck(x, sr, 0.0, 659.3, { amp: 0.2, tau: 0.08, dur: 0.3 });
    pluck(x, sr, 0.055, 440, { amp: 0.2, tau: 0.1, dur: 0.35 });
    return st(fin([x], sr, -8)[0], sr, rng, 0.4);
  },
  ui_error(rng, sr) {
    const x = buf(sr, 0.4);
    for (const t of [0, 0.11]) chirp(x, sr, t, { dur: 0.09, f: 180, amp: 0.3, h2: 0.4, h3: 0.3, env: (u) => Math.min(1, u * 20) * Math.min(1, (1 - u) * 10) });
    lp(x, sr, 1800);
    return [fin([x], sr, -9)[0]];
  },
  ui_notify(rng, sr) {
    const x = buf(sr, 1.0);
    pluck(x, sr, 0.0, 1046.5, { amp: 0.2, tau: 0.25, dur: 0.9, h2: 0.08 });
    pluck(x, sr, 0.09, 1318.5, { amp: 0.16, tau: 0.3, dur: 0.9, h2: 0.08 });
    noiseBurst(x, sr, 0, rng, { amp: 0.15, attack: 0.0003, tau: 0.003, bp: [4000, 1], dur: 0.02 });
    return st(fin([x], sr, -10)[0], sr, rng, 0.6);
  },
  ui_score(rng, sr) {
    // XP / score popup: a bright small tick-pluck
    const x = buf(sr, 0.35);
    noiseBurst(x, sr, 0, rng, { amp: 0.35, attack: 0.0002, tau: 0.0015, hp: 3000, dur: 0.01 });
    pluck(x, sr, 0.0, 1567.98, { amp: 0.2, tau: 0.05, dur: 0.3, h2: 0.1 });
    pluck(x, sr, 0.0, 2349.3, { amp: 0.08, tau: 0.04, dur: 0.25, h2: 0 });
    return [fin([x], sr, -12)[0]];
  },
  ui_killstreak(rng, sr) {
    const x = buf(sr, 2.2);
    whoosh(x, sr, 0, rng, { dur: 0.45, amp: 0.4, f0: 300, f1: 3000, q: 0.9, peakAt: 0.85 });
    thump(x, sr, 0.42, { f0: 120, f1: 45, sweep: 0.03, tau: 0.25, amp: 0.8, drive: 1.5 });
    noiseBurst(x, sr, 0.42, rng, { amp: 0.4, attack: 0.001, tau: 0.03, tau2: 0.3, mix2: 0.3, lp: 2500, dur: 1.2, color: 'pink' });
    // low minor-ish power chord swell (D5 + A)
    for (const [f, a] of [[73.42, 0.25], [110, 0.18], [146.83, 0.14], [220, 0.06]]) {
      chirp(x, sr, 0.42, { dur: 1.7, f, amp: a, h2: 0.3, h3: 0.2, env: (u) => Math.min(1, u * 60) * Math.exp(-u * 3.2) });
    }
    metalClick(x, sr, 0.42, rng, { base: 2400, amp: 0.3, t60: 0.2 });
    return st(fin([x], sr, -4)[0], sr, rng, 0.8);
  },
  ui_countdown(rng, sr) {
    const x = buf(sr, 0.35);
    chirp(x, sr, 0, { dur: 0.16, f: 988, amp: 0.3, h2: 0.05, env: (u) => Math.min(1, u * 60) * Math.min(1, (1 - u) * 6) });
    noiseBurst(x, sr, 0, rng, { amp: 0.2, attack: 0.0002, tau: 0.002, bp: [3000, 1], dur: 0.01 });
    return [fin([x], sr, -10)[0]];
  },
  ui_countdown_final(rng, sr) {
    const x = buf(sr, 0.8);
    chirp(x, sr, 0, { dur: 0.6, f: 1480, amp: 0.3, h2: 0.05, env: (u) => Math.min(1, u * 100) * Math.exp(-u * 4) });
    noiseBurst(x, sr, 0, rng, { amp: 0.2, attack: 0.0002, tau: 0.002, bp: [3000, 1], dur: 0.01 });
    return [fin([x], sr, -9)[0]];
  },
  ui_deploy(rng, sr) {
    const x = buf(sr, 1.4);
    whoosh(x, sr, 0, rng, { dur: 0.7, amp: 0.5, f0: 200, f1: 1600, q: 0.8, peakAt: 0.7 });
    thump(x, sr, 0.62, { f0: 140, f1: 48, sweep: 0.03, tau: 0.18, amp: 0.8, drive: 1.6 });
    noiseBurst(x, sr, 0.62, rng, { amp: 0.4, attack: 0.001, tau: 0.02, tau2: 0.2, mix2: 0.3, lp: 1800, dur: 0.7, color: 'pink' });
    metalClick(x, sr, 0.62, rng, { base: 1900, amp: 0.3, t60: 0.15 });
    return st(fin([x], sr, -4)[0], sr, rng, 0.8);
  },
  ui_objective(rng, sr) {
    const x = buf(sr, 1.4);
    thump(x, sr, 0, { f0: 110, f1: 55, sweep: 0.02, tau: 0.2, amp: 0.6 });
    for (const [f, t, a] of [[293.66, 0, 0.18], [440, 0.12, 0.14], [587.33, 0.24, 0.12]]) pluck(x, sr, t, f, { amp: a, tau: 0.4, dur: 1.1, h2: 0.2, h3: 0.08 });
    return st(fin([x], sr, -6)[0], sr, rng, 0.7);
  },
};

const C = {};
for (const k of Object.keys(UI)) C[k] = { gen: UI[k], variants: k === 'ui_hover' || k === 'ui_click' ? 3 : 1, bus: 'ui', group: 'ui', maxVoices: 6, priority: 70, vol: 0.6, volVar: 0.5, pitchVar: k === 'ui_hover' ? 0.5 : 0.1, reverb: 0 };
export default C;

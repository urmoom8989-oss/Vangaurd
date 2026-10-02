/**
 * audio/sounds/music.js — tasteful dynamic music stingers (D minor, low strings + taiko-style drums,
 * no melody hooks): wave start, wave cleared, death, victory, low-health tension swell.
 */
import {
  samples, buf, svf, lp, hp, eq, pink, white, brown, mixInto, dcBlock, fadeOut, fadeIn, noiseBurst, thump, normalize,
  decorrelate, width, comb, allpass, chirp, wobble,
} from '../dsp.js';

const NOTE = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** PolyBLEP sawtooth ensemble (detuned voices), lowpassed: a warm low-string / synth-string pad. */
function pad(dst, sr, t0, midi, { dur = 4, amp = 0.2, attack = 1.2, release = 1.5, cutoff = 900, voices = 5, detune = 0.12, rng } = {}) {
  const n = samples(sr, dur);
  const s = new Float32Array(n);
  const f = NOTE(midi);
  for (let v = 0; v < voices; v++) {
    const fv = f * Math.pow(2, ((v - (voices - 1) / 2) * detune) / 12);
    const dt = fv / sr;
    let ph = rng.next();
    const vib = rng.range(4.5, 5.5), vd = rng.range(0.001, 0.003);
    for (let i = 0; i < n; i++) {
      const d = dt * (1 + vd * Math.sin((2 * Math.PI * vib * i) / sr));
      ph += d; if (ph >= 1) ph -= 1;
      let y = 2 * ph - 1;
      if (ph < d) { const x = ph / d; y -= x + x - x * x - 1; } else if (ph > 1 - d) { const x = (ph - 1) / d; y -= x * x + x + x + 1; }
      s[i] += y / voices;
    }
  }
  svf(s, sr, 'lp', (t) => cutoff * (0.5 + 0.5 * Math.min(1, t / attack)), 0.8);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    s[i] *= Math.min(1, Math.pow(t / attack, 1.5)) * Math.min(1, Math.max(0, (dur - t) / release));
  }
  mixInto(dst, s, t0 * sr, amp);
}

/** Taiko-ish drum: pitched skin thump + slap noise + shell. */
function drum(dst, sr, t0, rng, { amp = 0.8, f = 62, big = 1 } = {}) {
  thump(dst, sr, t0, { f0: f * 2.2, f1: f, sweep: 0.025, tau: 0.22 * big, amp, drive: 1.4, attack: 0.002 });
  noiseBurst(dst, sr, t0, rng, { amp: amp * 0.35, attack: 0.0005, tau: 0.02, lp: 1500, hp: 90, dur: 0.2, color: 'pink' });
  noiseBurst(dst, sr, t0, rng, { amp: amp * 0.12, attack: 0.0003, tau: 0.004, bp: [2500, 1], dur: 0.03 });
}

/** Simple stereo "hall" for music: parallel combs + allpasses on a copy. */
function hall(L, R, sr, mix = 0.3, seed = 1) {
  const src = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) src[i] = (L[i] + R[i]) * 0.5;
  const mk = (ds) => {
    const acc = new Float32Array(src.length);
    for (const d of ds) { const c = src.slice(); comb(c, Math.round((d / 1000) * sr), 0.82, 0.35); mixInto(acc, c, 0, 1 / ds.length); }
    allpass(acc, Math.round(0.0051 * sr), 0.6); allpass(acc, Math.round(0.0017 * sr), 0.6);
    lp(acc, sr, 4500); hp(acc, sr, 80);
    return acc;
  };
  const wl = mk([29.7, 37.1, 41.1, 43.7]), wr = mk([30.9, 35.3, 40.3, 44.9]);
  mixInto(L, wl, 0, mix); mixInto(R, wr, 0, mix);
}

function fin(L, R, sr, db) { for (const c of [L, R]) { dcBlock(c, sr, 20); fadeOut(c, sr, 0.3); } return normalize([L, R], db); }

function stereoPad(L, R, sr, t0, midi, o, rng) {
  const m = buf(sr, (o.dur || 4) + 0.1);
  pad(m, sr, 0, midi, { ...o, rng });
  const [a, b] = decorrelate(m, sr, 1, rng.int(1, 1e6));
  mixInto(L, a, t0 * sr, 1); mixInto(R, b, t0 * sr, 1);
}

const M = {
  music_wave_start(rng, sr) {
    const len = 8;
    const L = buf(sr, len), R = buf(sr, len);
    // D minor low strings swelling in, tension cluster on top
    for (const [m, a] of [[38, 0.3], [45, 0.22], [50, 0.16], [53, 0.1]]) stereoPad(L, R, sr, 0, m, { dur: 6.5, amp: a, attack: 2.4, release: 2.5, cutoff: 700 }, rng);
    stereoPad(L, R, sr, 1.6, 64, { dur: 4.5, amp: 0.04, attack: 2.2, release: 2, cutoff: 1800, voices: 3 }, rng); // E: 9th tension
    // drum pattern: gathering hits, then a big downbeat
    const D = buf(sr, len);
    for (const [t, a] of [[0, 0.5], [0.75, 0.35], [1.5, 0.45], [1.875, 0.3], [2.25, 0.55], [2.625, 0.4], [2.8125, 0.45]]) drum(D, sr, t, rng, { amp: a, f: 60 });
    drum(D, sr, 3.0, rng, { amp: 1, f: 48, big: 1.8 });
    noiseBurst(D, sr, 1.2, rng, { amp: 0.12, attack: 1.7, tau: 0.05, bp: [2500, 0.7], dur: 1.85 }); // riser
    mixInto(L, D, 0, 1); mixInto(R, D, 0, 1);
    hall(L, R, sr, 0.35);
    return fin(L, R, sr, -3);
  },
  music_wave_clear(rng, sr) {
    const len = 7;
    const L = buf(sr, len), R = buf(sr, len);
    // Dm -> Bb (lift), soft and brief
    for (const [m, a] of [[38, 0.2], [50, 0.12], [53, 0.1], [57, 0.07]]) stereoPad(L, R, sr, 0, m, { dur: 2.6, amp: a, attack: 0.8, release: 1.2, cutoff: 900 }, rng);
    for (const [m, a] of [[34, 0.2], [46, 0.12], [50, 0.1], [53, 0.08], [58, 0.05]]) stereoPad(L, R, sr, 2.0, m, { dur: 4.8, amp: a, attack: 1.0, release: 2.8, cutoff: 1100 }, rng);
    const D = buf(sr, len);
    drum(D, sr, 2.0, rng, { amp: 0.6, f: 52, big: 1.5 });
    mixInto(L, D, 0, 1); mixInto(R, D, 0, 1);
    hall(L, R, sr, 0.4);
    return fin(L, R, sr, -5);
  },
  music_death(rng, sr) {
    const len = 7;
    const L = buf(sr, len), R = buf(sr, len);
    for (const [m, a] of [[26, 0.3], [33, 0.2], [38, 0.14], [41, 0.1]]) stereoPad(L, R, sr, 0, m, { dur: 6.5, amp: a, attack: 0.6, release: 4, cutoff: 420 }, rng);
    const D = buf(sr, len);
    drum(D, sr, 0.0, rng, { amp: 0.9, f: 42, big: 2.2 });
    mixInto(L, D, 0, 1); mixInto(R, D, 0, 1);
    hall(L, R, sr, 0.45);
    return fin(L, R, sr, -4);
  },
  music_victory(rng, sr) {
    const len = 8;
    const L = buf(sr, len), R = buf(sr, len);
    for (const [m, a] of [[38, 0.24], [45, 0.18], [50, 0.14], [54, 0.1], [57, 0.08]]) stereoPad(L, R, sr, 0.0, m, { dur: 7, amp: a, attack: 1.2, release: 3, cutoff: 1300 }, rng); // D major
    const D = buf(sr, len);
    for (const [t, a] of [[0, 0.8], [0.5, 0.45], [1.0, 0.6], [1.25, 0.4], [1.5, 1]]) drum(D, sr, t, rng, { amp: a, f: 55, big: t === 1.5 ? 1.8 : 1 });
    mixInto(L, D, 0, 1); mixInto(R, D, 0, 1);
    hall(L, R, sr, 0.4);
    return fin(L, R, sr, -3);
  },
  music_tension(rng, sr) {
    // low-health / last-enemy swell: pulsing low D with a dissonant Eb shimmer
    const len = 6;
    const L = buf(sr, len), R = buf(sr, len);
    stereoPad(L, R, sr, 0, 26, { dur: 5.8, amp: 0.3, attack: 1.5, release: 2, cutoff: 300 }, rng);
    stereoPad(L, R, sr, 0.5, 63, { dur: 5, amp: 0.035, attack: 2.5, release: 2, cutoff: 2200, voices: 3, detune: 0.3 }, rng);
    const D = buf(sr, len);
    for (let t = 0; t < 5; t += 0.5) drum(D, sr, t, rng, { amp: 0.18 + t * 0.05, f: 45 });
    mixInto(L, D, 0, 1); mixInto(R, D, 0, 1);
    hall(L, R, sr, 0.3);
    return fin(L, R, sr, -6);
  },
};

const C = {};
for (const k of Object.keys(M)) C[k] = { gen: M[k], variants: 1, bus: 'music', group: 'music', maxVoices: 2, priority: 50, vol: 0.55, reverb: 0 };
export default C;

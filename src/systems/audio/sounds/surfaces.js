/**
 * audio/sounds/surfaces.js — per-surface footsteps, landings, bullet impacts, ricochets, shell casings,
 * grenade bounces, body falls, slides.
 *
 * Footstep anatomy: heel strike (low thud + surface transient) -> roll -> toe/ball (lighter) + scuff,
 * with a surface "texture" layer (gravel grains, metal plate ring, board resonance, glass shards...).
 * Impact anatomy: sharp hit transient + material body (modal/noise) + debris/aftermath.
 */
import {
  samples, buf, svf, lp, hp, eq, white, pink, mixInto, softclip, normalize, dcBlock, fadeOut, noiseBurst, thump,
  grains, resonate, excite, metalModes, envAD, mul, scrape, chirp, limit, rmsNormalize, decorrelate, width, toneMatch,
} from '../dsp.js';
import { friedlander, nwave, metalClick, polyKnock, cloth, gearRattle, casingDrop, debrisRain, thud } from './common.js';

export const FOOT_SURFACES = ['concrete', 'dirt', 'gravel', 'metal', 'wood', 'glass', 'water', 'grass'];
export const IMPACT_SURFACES = ['concrete', 'brick', 'metal', 'wood', 'dirt', 'glass', 'flesh', 'water', 'fabric', 'plaster'];

/** Map any SURFACES vocabulary entry to the baked footstep / impact sets. */
export function footSurface(s) {
  switch (s) {
    case 'asphalt': case 'brick': case 'plaster': case 'tile': case 'concrete': case 'default': case 'rubber': case 'cardboard': return 'concrete';
    case 'sand': case 'dirt': case 'fabric': case 'flesh': return 'dirt';
    case 'grass': return 'grass';
    case 'gravel': return 'gravel';
    case 'metal': return 'metal';
    case 'wood': return 'wood';
    case 'glass': return 'glass';
    case 'water': return 'water';
    default: return 'concrete';
  }
}
export function impactSurface(s) {
  switch (s) {
    case 'asphalt': case 'tile': case 'concrete': case 'default': return 'concrete';
    case 'brick': return 'brick';
    case 'plaster': case 'cardboard': return 'plaster';
    case 'metal': return 'metal';
    case 'wood': return 'wood';
    case 'dirt': case 'sand': case 'grass': case 'gravel': return 'dirt';
    case 'glass': return 'glass';
    case 'flesh': return 'flesh';
    case 'water': return 'water';
    case 'fabric': case 'rubber': return 'fabric';
    default: return 'concrete';
  }
}

function master(chans, sr, rmsDb, t1 = 0.1, ceil = -1) {
  for (const c of chans) { dcBlock(c, sr, 25); fadeOut(c, sr, 0.02); }
  rmsNormalize(chans, sr, rmsDb, 0, t1);
  limit(chans, sr, { ceilingDb: ceil, lookahead: 0.001, release: 0.03 });
  return chans;
}

// ------------------------------------------------------------------------------------------ footsteps
/** intensity: 0 = sneaky crouch, 0.5 = walk, 1 = sprint. */
function footstep(rng, sr, surface, intensity) {
  const x = buf(sr, surface === 'metal' ? 0.7 : 0.5);
  const run = intensity > 0.75;
  const heelToToe = run ? rng.range(0.018, 0.035) : rng.range(0.045, 0.085);
  const heel = 0.6 + intensity * 0.6;
  const toe = heel * rng.range(0.35, 0.6);
  const hard = surface === 'concrete' || surface === 'metal' || surface === 'wood' || surface === 'glass';

  // boot (rubber sole) contact — present on every surface
  thud(x, sr, 0, rng, { amp: 0.5 * heel, lp: hard ? 900 : 600, tau: 0.012 + 0.006 * (1 - intensity), f: rng.range(70, 95), sineAmp: 0.35 });
  thud(x, sr, heelToToe, rng, { amp: 0.28 * toe, lp: hard ? 1300 : 800, tau: 0.008, f: 110, sineAmp: 0.2 });
  // scuff (sole friction)
  if (surface !== 'water') {
    scrape(x, sr, heelToToe * rng.range(0.3, 1), rng, {
      dur: rng.range(0.05, 0.11) * (run ? 1.3 : 1), amp: (hard ? 0.09 : 0.07) * (0.6 + intensity * 0.8), fc: rng.range(1500, 3200), q: 0.7, rough: 0.8, rate: 180, color: 'pink',
    });
  }

  switch (surface) {
    case 'concrete': {
      // grit crunch + sharp sole slap
      noiseBurst(x, sr, 0, rng, { amp: 0.28 * heel, attack: 0.0002, tau: 0.0035, bp: [rng.range(1800, 2600), 0.9], dur: 0.03 });
      noiseBurst(x, sr, heelToToe, rng, { amp: 0.16 * toe, attack: 0.0002, tau: 0.003, bp: [rng.range(2200, 3200), 0.9], dur: 0.03 });
      grains(x, sr, 0.001, rng, { count: rng.int(6, 14), spread: 0.05 + heelToToe, amp: 0.07 * heel, fc: [2500, 9000], q: [1, 4], grainMs: [0.4, 1.5], shape: 1.5 });
      break;
    }
    case 'dirt': {
      noiseBurst(x, sr, 0, rng, { amp: 0.2 * heel, attack: 0.001, tau: 0.02, lp: 1400, hp: 150, dur: 0.1, color: 'pink' });
      grains(x, sr, 0.002, rng, { count: rng.int(15, 30), spread: 0.08 + heelToToe, amp: 0.05 * heel, fc: [700, 3500], q: [0.8, 2], grainMs: [1, 4], shape: 1.3 });
      break;
    }
    case 'grass': {
      noiseBurst(x, sr, 0, rng, { amp: 0.14 * heel, attack: 0.002, tau: 0.02, lp: 1200, hp: 150, dur: 0.1, color: 'pink' });
      cloth(x, sr, 0.0, rng, { dur: 0.16, amp: 0.2 * heel, bright: 0.9, intensity: 1, peakAt: 0.2 }); // blades swish
      break;
    }
    case 'gravel': {
      grains(x, sr, 0.0, rng, { count: rng.int(45, 80), spread: 0.09 + heelToToe * 1.4, amp: 0.13 * heel, fc: [900, 7000], q: [1.2, 4], grainMs: [0.8, 4], shape: 1.2, ampVar: 0.8 });
      grains(x, sr, heelToToe, rng, { count: rng.int(20, 40), spread: 0.08, amp: 0.1 * toe, fc: [1200, 7000], q: [1.2, 4], grainMs: [0.6, 3], shape: 1.4 });
      noiseBurst(x, sr, 0, rng, { amp: 0.12 * heel, attack: 0.002, tau: 0.025, lp: 1800, hp: 200, dur: 0.12, color: 'pink' });
      break;
    }
    case 'metal': {
      // hollow plate: low modes ring
      const base = rng.range(160, 260);
      const e = excite(rng, sr, 0.004, 60, 3500);
      resonate(x, sr, 0, e, [
        { f: base, t60: 0.35, amp: 1 }, { f: base * 1.58, t60: 0.28, amp: 0.7 }, { f: base * 2.31, t60: 0.22, amp: 0.55 },
        { f: base * 3.7, t60: 0.15, amp: 0.4 }, { f: base * 5.9, t60: 0.1, amp: 0.3 }, { f: base * 8.3, t60: 0.08, amp: 0.25 },
      ], 0.45 * heel);
      resonate(x, sr, heelToToe, excite(rng, sr, 0.002, 200, 5000), metalModes(rng, rng.range(900, 1400), { n: 6, t60: 0.12, bright: 0.5 }), 0.18 * toe);
      metalClick(x, sr, 0, rng, { base: rng.range(2200, 3200), amp: 0.14 * heel, t60: 0.05 });
      break;
    }
    case 'wood': {
      const base = rng.range(110, 170);
      resonate(x, sr, 0, excite(rng, sr, 0.004, 50, 2500), [
        { f: base, t60: 0.12, amp: 1 }, { f: base * 2.1, t60: 0.08, amp: 0.7 }, { f: base * 3.4, t60: 0.05, amp: 0.5 }, { f: base * 5.2, t60: 0.035, amp: 0.3 },
      ], 0.55 * heel);
      polyKnock(x, sr, heelToToe, rng, { base: rng.range(420, 600), amp: 0.2 * toe, t60: 0.04 });
      if (rng.chance(0.4)) { // board creak (stick-slip)
        const t0 = heelToToe * 0.5;
        const n = samples(sr, 0.18);
        const exc = new Float32Array(n);
        let ph = 0;
        for (let i = 0; i < n; i++) {
          ph += rng.range(90, 180) / sr;
          if (ph >= 1) { ph -= 1; exc[i] = rng.range(0.5, 1); }
        }
        const f0 = rng.range(350, 700);
        resonate(x, sr, t0, exc, [{ f: f0, t60: 0.04, amp: 1 }, { f: f0 * 2.3, t60: 0.03, amp: 0.5 }, { f: f0 * 3.9, t60: 0.02, amp: 0.25 }], 0.05 * heel);
      }
      break;
    }
    case 'glass': {
      noiseBurst(x, sr, 0, rng, { amp: 0.2 * heel, attack: 0.0002, tau: 0.004, bp: [2400, 0.9], dur: 0.03 });
      grains(x, sr, 0.0, rng, { count: rng.int(25, 45), spread: 0.12 + heelToToe, amp: 0.09 * heel, fc: [2500, 11000], q: [2, 6], grainMs: [0.3, 1.5], shape: 1.3, ring: { t60: 0.06, gain: 0.9 } });
      grains(x, sr, 0.03, rng, { count: rng.int(8, 16), spread: 0.25, amp: 0.04 * heel, fc: [3500, 12000], q: [3, 8], grainMs: [0.3, 1], shape: 1, ring: { t60: 0.1, gain: 0.8 } });
      break;
    }
    case 'water': {
      noiseBurst(x, sr, 0, rng, { amp: 0.3 * heel, attack: 0.003, tau: 0.03, bp: [900, 0.7], dur: 0.15, color: 'pink' });
      noiseBurst(x, sr, 0.004, rng, { amp: 0.14 * heel, attack: 0.004, tau: 0.04, hp: 2000, lp: 7000, dur: 0.2 });
      for (let b = 0; b < rng.int(4, 9); b++) { // droplets / bubbles
        const t = rng.range(0.02, 0.22), f = rng.range(900, 2600);
        chirp(x, sr, t, { dur: rng.range(0.008, 0.02), f: (u) => f * (1 + u * 0.6), amp: 0.05 * heel * rng.range(0.3, 1), env: (u) => Math.sin(Math.PI * u) * (1 - u) });
      }
      break;
    }
    default: break;
  }
  const out = [x];
  // spectral balance per surface (boot foley reference curves): keeps the low "thud" felt, not boomy,
  // and puts the character where the ear reads the material (sole slap / grit / ring)
  const T = FOOT_TONE[surface] || FOOT_TONE.concrete;
  const tilt = (intensity - 0.5) * 2; // run: brighter, crouch: darker
  toneMatch(out, sr, T.map((v, i) => v + (i >= 5 ? tilt * (i - 4) * 1.2 : 0)), { t0: 0, t1: 0.2, strength: 0.75, maxDb: 14 });
  if (intensity < 0.3) lp(x, sr, 3200);
  master(out, sr, -17 + intensity * 4, 0.12, -1);
  return out;
}
// octave targets (dB) at 40, 85, 175, 350, 700, 1.4k, 2.8k, 5.6k, 11k, 18k Hz
const FOOT_TONE = {
  concrete: [-22, -9, -4, -3, -2, 0, -1, -4, -10, -20],
  dirt: [-18, -7, -2, 0, -2, -4, -6, -9, -15, -25],
  grass: [-20, -9, -4, -3, -3, -2, -3, -5, -10, -20],
  gravel: [-20, -10, -6, -5, -4, -1, 0, -1, -6, -16],
  metal: [-16, -6, 0, -2, -3, -4, -6, -9, -14, -22],
  wood: [-16, -6, 0, -1, -3, -5, -8, -11, -17, -26],
  glass: [-22, -12, -8, -6, -4, -1, 0, 0, -4, -12],
  water: [-18, -8, -3, -1, 0, -2, -4, -6, -10, -18],
};

function landing(rng, sr, surface, heavy) {
  const x = buf(sr, 0.7);
  const s = footSurface(surface);
  const a = heavy ? 1 : 0.7;
  thud(x, sr, 0, rng, { amp: 0.9 * a, lp: 700, tau: 0.03, f: 62, sineAmp: 0.6 });
  // both feet, a few ms apart
  const f1 = footstep(rng, sr, s, 1)[0];
  const f2 = footstep(rng, sr, s, 1)[0];
  mixInto(x, f1, 0, 0.7);
  mixInto(x, f2, rng.range(0.012, 0.03) * sr, 0.55);
  gearRattle(x, sr, 0.01, rng, { dur: 0.25, amp: 0.3 * a, count: heavy ? 10 : 6 });
  cloth(x, sr, 0.0, rng, { dur: 0.3, amp: 0.25, intensity: 1, peakAt: 0.1 });
  toneMatch([x], sr, heavy ? [-12, -3, 0, -2, -3, -4, -5, -8, -14, -24] : [-15, -5, -1, -2, -3, -3, -4, -7, -13, -23], { t0: 0, t1: 0.25, strength: 0.7 });
  return master([x], sr, heavy ? -11 : -13, 0.12);
}

// ------------------------------------------------------------------------------------------ bullet impacts
function impact(rng, sr, surface) {
  const x = buf(sr, surface === 'metal' ? 1.2 : surface === 'glass' ? 1.4 : 0.9);
  switch (surface) {
    case 'concrete': case 'brick': case 'plaster': {
      const soft = surface === 'plaster' ? 0.7 : surface === 'brick' ? 0.85 : 1;
      friedlander(x, sr, 0, { T: 0.0003, amp: 0.6 * soft, hp: 700 }); // hard crack
      noiseBurst(x, sr, 0, rng, { amp: 0.7, attack: 0.0001, tau: 0.003, tau2: 0.02, mix2: 0.25, bp: [rng.range(1800, 3000) * soft, 0.8], dur: 0.1 });
      noiseBurst(x, sr, 0, rng, { amp: 0.4, attack: 0.0003, tau: 0.008, lp: 900, hp: 80, dur: 0.06, color: 'pink' });
      thump(x, sr, 0, { f0: 320, f1: 140, sweep: 0.004, tau: 0.01, amp: 0.3 });
      // chips spraying and falling
      grains(x, sr, 0.004, rng, { count: rng.int(30, 60), spread: 0.08, amp: 0.2, fc: [2000, 10000], q: [1, 3], grainMs: [0.3, 1.5], shape: 2 });
      debrisRain(x, sr, 0.05, rng, { dur: rng.range(0.45, 0.8), count: rng.int(30, 60), amp: 0.12, fc: [1500, 8000], peak: 0.35, chunks: rng.int(1, 3), chunkAmp: 0.08 });
      // dust puff hiss
      noiseBurst(x, sr, 0.003, rng, { amp: 0.08, attack: 0.01, tau: 0.08, hp: 2500, lp: 9000, dur: 0.35 });
      if (surface !== 'plaster') toneMatch([x], sr, [-18, -12, -6, -3, -2, 0, 0, -1, -5, -16], { t1: 0.15, strength: 0.6 });
      return master([x], sr, -12, 0.08);
    }
    case 'metal': {
      friedlander(x, sr, 0, { T: 0.0002, amp: 0.5, hp: 1500 });
      metalClick(x, sr, 0, rng, { base: rng.range(3000, 4200), amp: 0.5, t60: 0.03, noise: 0.8 });
      // sheet metal ring (car body, container, sign)
      const base = rng.range(380, 900);
      const e = excite(rng, sr, 0.0015, 300);
      resonate(x, sr, 0, e, metalModes(rng, base, { n: 10, t60: rng.range(0.4, 0.9), bright: 0.55, t60Spread: 0.6 }), 0.9);
      resonate(x, sr, 0, e, metalModes(rng, base * rng.range(2.5, 3.5), { n: 6, t60: 0.25, bright: 0.5 }), 0.4);
      noiseBurst(x, sr, 0, rng, { amp: 0.3, attack: 0.0002, tau: 0.01, lp: 1200, dur: 0.06 }); // body thunk
      return master([x], sr, -13, 0.1);
    }
    case 'wood': {
      noiseBurst(x, sr, 0, rng, { amp: 0.6, attack: 0.0002, tau: 0.004, bp: [rng.range(1500, 2200), 0.9], dur: 0.04 });
      const base = rng.range(220, 380);
      resonate(x, sr, 0, excite(rng, sr, 0.002, 80, 4000), [
        { f: base, t60: 0.09, amp: 1 }, { f: base * 2.2, t60: 0.06, amp: 0.8 }, { f: base * 3.6, t60: 0.04, amp: 0.5 }, { f: base * 5.4, t60: 0.03, amp: 0.3 },
      ], 0.9);
      grains(x, sr, 0.003, rng, { count: rng.int(20, 35), spread: 0.05, amp: 0.2, fc: [1800, 7000], q: [1.5, 4], grainMs: [0.5, 2], shape: 2 }); // splinters
      debrisRain(x, sr, 0.05, rng, { dur: 0.4, count: 15, amp: 0.06, fc: [1000, 5000], peak: 0.3, chunks: 1, chunkAmp: 0.05 });
      return master([x], sr, -12.5, 0.08);
    }
    case 'dirt': {
      noiseBurst(x, sr, 0, rng, { amp: 0.8, attack: 0.0005, tau: 0.012, lp: 900, hp: 60, dur: 0.1, color: 'pink' }); // thup
      thump(x, sr, 0, { f0: 180, f1: 70, sweep: 0.006, tau: 0.02, amp: 0.45 });
      noiseBurst(x, sr, 0, rng, { amp: 0.25, attack: 0.0003, tau: 0.004, bp: [1800, 0.8], dur: 0.03 });
      // dirt clods + sand spray pattering back down
      debrisRain(x, sr, 0.02, rng, { dur: rng.range(0.5, 0.8), count: rng.int(60, 110), amp: 0.09, fc: [600, 4500], peak: 0.4, chunks: rng.int(2, 4), chunkAmp: 0.1 });
      noiseBurst(x, sr, 0.005, rng, { amp: 0.06, attack: 0.02, tau: 0.1, bp: [2500, 0.6], dur: 0.4 });
      return master([x], sr, -13, 0.08);
    }
    case 'glass': {
      friedlander(x, sr, 0, { T: 0.0002, amp: 0.5, hp: 2000 });
      noiseBurst(x, sr, 0, rng, { amp: 0.5, attack: 0.0001, tau: 0.004, hp: 2500, dur: 0.03 });
      grains(x, sr, 0.0, rng, { count: rng.int(40, 70), spread: 0.06, amp: 0.2, fc: [2500, 12000], q: [2, 8], grainMs: [0.3, 1.2], shape: 2, ring: { t60: 0.12, gain: 1 } });
      // falling shards tinkling on the ground
      grains(x, sr, 0.18, rng, { count: rng.int(25, 45), spread: rng.range(0.5, 0.9), amp: 0.1, fc: [3000, 11000], q: [3, 8], grainMs: [0.3, 1], shape: 1.2, decay: 0.5, ring: { t60: 0.08, gain: 1 } });
      return master([x], sr, -14, 0.08);
    }
    case 'flesh': {
      // wet, dull, short: fabric + body cavity + a little squelch
      thump(x, sr, 0, { f0: 210, f1: 80, sweep: 0.008, tau: 0.03, amp: 0.8, drive: 1.5 });
      noiseBurst(x, sr, 0, rng, { amp: 0.7, attack: 0.0005, tau: 0.012, lp: 1100, hp: 90, dur: 0.08, color: 'pink' });
      noiseBurst(x, sr, 0.001, rng, { amp: 0.25, attack: 0.0004, tau: 0.004, bp: [2400, 1.2], dur: 0.03 }); // fabric tear
      scrape(x, sr, 0.004, rng, { dur: 0.06, amp: 0.12, fc: 900, q: 2.5, rough: 1, rate: 350 }); // squelch
      gearRattle(x, sr, 0.01, rng, { dur: 0.08, amp: 0.1, count: 2 });
      return master([x], sr, -11, 0.07);
    }
    case 'water': {
      noiseBurst(x, sr, 0, rng, { amp: 0.6, attack: 0.001, tau: 0.02, bp: [1200, 0.6], dur: 0.12 });
      noiseBurst(x, sr, 0.004, rng, { amp: 0.3, attack: 0.01, tau: 0.08, hp: 1500, lp: 8000, dur: 0.4 }); // spray
      for (let b = 0; b < rng.int(8, 14); b++) {
        const t = rng.range(0.03, 0.5), f = rng.range(700, 2400);
        chirp(x, sr, t, { dur: rng.range(0.01, 0.03), f: (u) => f * (1 + u * 0.8), amp: 0.08 * rng.range(0.3, 1), env: (u) => Math.sin(Math.PI * u) * (1 - u) });
      }
      return master([x], sr, -14, 0.08);
    }
    case 'fabric': default: {
      // sandbags / canvas: dull thump + sand trickle
      noiseBurst(x, sr, 0, rng, { amp: 0.8, attack: 0.0006, tau: 0.012, lp: 1000, hp: 70, dur: 0.1, color: 'pink' });
      thump(x, sr, 0, { f0: 190, f1: 90, sweep: 0.006, tau: 0.018, amp: 0.4 });
      noiseBurst(x, sr, 0, rng, { amp: 0.25, attack: 0.0003, tau: 0.003, bp: [2600, 1], dur: 0.02 });
      grains(x, sr, 0.03, rng, { count: 40, spread: 0.5, amp: 0.04, fc: [1500, 6000], q: [1, 3], grainMs: [0.5, 2], shape: 1.1, decay: 0.3 });
      return master([x], sr, -13, 0.07);
    }
  }
}

function ricochet(rng, sr) {
  const x = buf(sr, 0.9);
  friedlander(x, sr, 0, { T: 0.0002, amp: 0.5, hp: 1500 });
  metalClick(x, sr, 0, rng, { base: rng.range(3200, 4500), amp: 0.35, t60: 0.02 });
  // tumbling bullet whine with doppler: falling pitch + wobble (tumble)
  const f0 = rng.range(2600, 4200), f1 = f0 * rng.range(0.45, 0.65), dur = rng.range(0.35, 0.65);
  const tumble = rng.range(25, 60);
  const n = samples(sr, dur);
  const s = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const f = f0 + (f1 - f0) * Math.pow(u, 0.7);
    ph += (2 * Math.PI * f * (1 + 0.015 * Math.sin((2 * Math.PI * tumble * i) / sr))) / sr;
    const am = 0.65 + 0.35 * Math.sin((2 * Math.PI * tumble * i) / sr);
    s[i] = (Math.sin(ph) + 0.25 * Math.sin(2.02 * ph)) * am * Math.min(1, u * 30) * Math.pow(1 - u, 1.6);
  }
  const air = white(rng, n);
  svf(air, sr, 'bp', (t) => f0 * 1.3 - t * 2000, 3);
  for (let i = 0; i < n; i++) s[i] += air[i] * 0.25 * Math.pow(1 - i / n, 2);
  mixInto(x, s, 0.004 * sr, 0.35);
  return master([x], sr, -17, 0.3);
}

// ------------------------------------------------------------------------------------------ bodies, grenades, slides
function bodyFall(rng, sr) {
  const x = buf(sr, 1.2);
  // knees / torso / arm / head+helmet, then kit settles
  const hits = [[0, 0.7], [rng.range(0.1, 0.16), 1], [rng.range(0.22, 0.3), 0.5]];
  for (const [t, a] of hits) {
    thud(x, sr, t, rng, { amp: 0.9 * a, lp: 650, tau: 0.03, f: rng.range(55, 75), sineAmp: 0.7 });
    noiseBurst(x, sr, t, rng, { amp: 0.25 * a, attack: 0.001, tau: 0.012, bp: [1400, 0.7], dur: 0.06, color: 'pink' });
  }
  gearRattle(x, sr, 0.1, rng, { dur: 0.45, amp: 0.4, count: 12 });
  cloth(x, sr, 0.0, rng, { dur: 0.6, amp: 0.3, intensity: 1, peakAt: 0.3 });
  // dropped rifle clatters
  const tg = rng.range(0.28, 0.4);
  resonate(x, sr, tg, excite(rng, sr, 0.002, 200), metalModes(rng, rng.range(700, 1000), { n: 8, t60: 0.12, bright: 0.5 }), 0.4);
  polyKnock(x, sr, tg + 0.002, rng, { base: 450, amp: 0.35, t60: 0.03 });
  resonate(x, sr, tg + rng.range(0.09, 0.14), excite(rng, sr, 0.002, 200), metalModes(rng, rng.range(900, 1200), { n: 7, t60: 0.08, bright: 0.5 }), 0.2);
  return master([x], sr, -13, 0.4);
}

function grenadeBounce(rng, sr, surface) {
  const x = buf(sr, 0.4);
  const s = footSurface(surface);
  const soft = s === 'dirt' || s === 'grass' || s === 'water';
  if (soft) {
    thud(x, sr, 0, rng, { amp: 0.6, lp: 700, tau: 0.012, f: 110, sineAmp: 0.4 });
    grains(x, sr, 0, rng, { count: 10, spread: 0.05, amp: 0.08, fc: [600, 3000] });
  } else {
    // steel body + fuze assembly: dull clunk with short ring
    const e = excite(rng, sr, 0.0015, 150);
    resonate(x, sr, 0, e, metalModes(rng, rng.range(1100, 1500), { n: 7, t60: 0.06, bright: 0.45 }), 0.55);
    polyKnock(x, sr, 0, rng, { base: rng.range(500, 700), amp: 0.5, t60: 0.03 });
    thud(x, sr, 0, rng, { amp: 0.4, lp: 1200, tau: 0.008, f: 150, sineAmp: 0.3 });
    if (s === 'metal') resonate(x, sr, 0, e, metalModes(rng, rng.range(300, 500), { n: 8, t60: 0.3, bright: 0.5 }), 0.4);
  }
  return master([x], sr, -14, 0.08);
}

function slide(rng, sr) {
  const x = buf(sr, 0.9);
  // body drops + long gritty friction, decelerating
  thud(x, sr, 0, rng, { amp: 0.6, lp: 600, tau: 0.02, f: 70, sineAmp: 0.5 });
  const n = samples(sr, 0.75);
  const s = pink(rng, n);
  svf(s, sr, 'bp', (t) => 1400 - t * 900, 0.8);
  for (let i = 0; i < n; i++) { const u = i / n; s[i] *= Math.min(1, u * 25) * Math.pow(1 - u, 1.4); }
  mixInto(x, s, 0.01 * sr, 0.6);
  grains(x, sr, 0.01, rng, { count: 160, spread: 0.7, amp: 0.1, fc: [1200, 7000], q: [1, 3], grainMs: [0.5, 2.5], shape: 1.3, decay: 0.5 });
  cloth(x, sr, 0.0, rng, { dur: 0.7, amp: 0.3, intensity: 1, peakAt: 0.15 });
  gearRattle(x, sr, 0.02, rng, { dur: 0.3, amp: 0.25, count: 7 });
  return master([x], sr, -15, 0.4);
}

function jump(rng, sr) {
  const x = buf(sr, 0.5);
  scrape(x, sr, 0, rng, { dur: 0.08, amp: 0.2, fc: 2200, q: 0.7, rough: 0.8, rate: 180, color: 'pink' });
  thud(x, sr, 0, rng, { amp: 0.35, lp: 800, tau: 0.012, f: 90, sineAmp: 0.3 });
  cloth(x, sr, 0.0, rng, { dur: 0.35, amp: 0.45, intensity: 1, peakAt: 0.3 });
  gearRattle(x, sr, 0.05, rng, { dur: 0.2, amp: 0.3, count: 6 });
  return master([x], sr, -17, 0.3);
}

function stance(rng, sr, kind) {
  const x = buf(sr, 0.7);
  if (kind === 'prone') {
    cloth(x, sr, 0, rng, { dur: 0.5, amp: 0.5, intensity: 1, peakAt: 0.4 });
    thud(x, sr, 0.22, rng, { amp: 0.8, lp: 600, tau: 0.025, f: 65, sineAmp: 0.5 });
    thud(x, sr, 0.3, rng, { amp: 0.5, lp: 700, tau: 0.02, f: 80, sineAmp: 0.4 });
    gearRattle(x, sr, 0.22, rng, { dur: 0.25, amp: 0.35, count: 9 });
    return master([x], sr, -15, 0.5);
  }
  cloth(x, sr, 0, rng, { dur: kind === 'crouch' ? 0.3 : 0.35, amp: 0.5, intensity: 0.8, peakAt: 0.35 });
  gearRattle(x, sr, 0.05, rng, { dur: 0.18, amp: 0.25, count: 5 });
  if (kind === 'crouch') thud(x, sr, 0.14, rng, { amp: 0.25, lp: 700, tau: 0.012, f: 90, sineAmp: 0.3 });
  return master([x], sr, -20, 0.35);
}

// ------------------------------------------------------------------------------------------ catalog
const C = {};
for (const s of FOOT_SURFACES) {
  C[`footstep_${s}`] = { gen: (r, sr) => footstep(r, sr, s, 0.5), variants: 8, group: 'foot', maxVoices: 6, priority: 30, vol: 0.55, volVar: 1.5, pitchVar: 0.6, reverb: 0.1, spatial: { ref: 2, max: 45 }, mono: true, tags: ['footstep'] };
  C[`footstep_${s}_run`] = { gen: (r, sr) => footstep(r, sr, s, 1), variants: 8, group: 'foot', maxVoices: 6, priority: 32, vol: 0.6, volVar: 1.5, pitchVar: 0.6, reverb: 0.1, spatial: { ref: 2, max: 60 }, mono: true, tags: ['footstep'] };
  C[`footstep_${s}_crouch`] = { gen: (r, sr) => footstep(r, sr, s, 0.1), variants: 5, group: 'foot', maxVoices: 6, priority: 28, vol: 0.4, volVar: 1.5, pitchVar: 0.6, reverb: 0.08, spatial: { ref: 1.5, max: 25 }, mono: true, tags: ['footstep'] };
}
for (const s of ['concrete', 'dirt', 'metal', 'wood', 'gravel']) {
  C[`land_${s}`] = { gen: (r, sr) => landing(r, sr, s, false), variants: 3, group: 'foot', maxVoices: 4, priority: 40, vol: 0.7, volVar: 1, pitchVar: 0.4, reverb: 0.12, mono: true, spatial: { ref: 2, max: 60 } };
  C[`land_${s}_heavy`] = { gen: (r, sr) => landing(r, sr, s, true), variants: 3, group: 'foot', maxVoices: 4, priority: 42, vol: 0.85, volVar: 1, pitchVar: 0.4, reverb: 0.15, mono: true, spatial: { ref: 2, max: 60 } };
}
for (const s of IMPACT_SURFACES) {
  const isMetal = s === 'metal';
  C[`impact_${s}`] = { gen: (r, sr) => impact(r, sr, s), variants: s === 'flesh' ? 6 : 5, group: 'impact', maxVoices: 14, priority: s === 'flesh' ? 65 : 45, vol: s === 'flesh' ? 0.75 : 0.7, volVar: 2, pitchVar: isMetal ? 1.5 : 1, reverb: 0.2, spatial: { ref: 3, max: 120 }, mono: true, tags: ['impact'] };
}
C.ricochet = { gen: ricochet, variants: 6, group: 'impact', maxVoices: 4, priority: 44, vol: 0.5, volVar: 2, pitchVar: 1.5, reverb: 0.3, spatial: { ref: 4, max: 120 }, mono: true };
C.body_fall = { gen: bodyFall, variants: 4, group: 'body', maxVoices: 4, priority: 55, vol: 0.8, volVar: 1, pitchVar: 0.6, reverb: 0.15, spatial: { ref: 3, max: 60 }, mono: true };
for (const s of ['concrete', 'dirt', 'metal']) {
  C[`grenade_bounce_${s}`] = { gen: (r, sr) => grenadeBounce(r, sr, s), variants: 4, group: 'bounce', maxVoices: 4, priority: 60, vol: 0.7, volVar: 1.5, pitchVar: 1, reverb: 0.15, spatial: { ref: 3, max: 50 }, mono: true };
}
for (const s of ['concrete', 'dirt', 'metal', 'wood']) {
  C[`shell_casing_${s}`] = { gen: (r, sr) => { const x = buf(sr, 0.7); casingDrop(x, sr, 0, r, s, { amp: 0.5 }); return master([x], sr, -20, 0.2, -3); }, variants: 6, group: 'casing', maxVoices: 5, priority: 10, vol: 0.28, volVar: 3, pitchVar: 1.2, reverb: 0.06, spatial: { ref: 1.5, max: 15 }, mono: true };
}
/** One brass-on-surface contact (driven by real vfx casing bounces; speed -> volume at runtime). */
function shellTink(rng, sr, surface) {
  const x = buf(sr, 0.5);
  const base = rng.range(3500, 4600);
  if (surface === 'dirt') {
    noiseBurst(x, sr, 0, rng, { amp: 0.5, attack: 0.0004, tau: 0.006, lp: 2200, hp: 150, dur: 0.04 });
    grains(x, sr, 0, rng, { count: 4, spread: 0.015, amp: 0.2, fc: [900, 3500] });
    resonate(x, sr, 0, excite(rng, sr, 0.0005, 1500), [{ f: base, t60: 0.04, amp: 1 }, { f: base * 2.02, t60: 0.03, amp: 0.5 }], 0.12);
    return master([x], sr, -21, 0.05, -3);
  }
  const ring = surface === 'metal' ? rng.range(0.4, 0.6) : surface === 'wood' ? 0.07 : rng.range(0.22, 0.34);
  const e = excite(rng, sr, 0.0005, 1200);
  resonate(x, sr, 0, e, [
    { f: base * rng.jit(1, 0.02), t60: ring, amp: 1 }, { f: base * 2.03 * rng.jit(1, 0.02), t60: ring * 0.8, amp: 0.75 },
    { f: base * 2.86 * rng.jit(1, 0.02), t60: ring * 0.6, amp: 0.45 }, { f: base * 4.35 * rng.jit(1, 0.02), t60: ring * 0.45, amp: 0.3 },
  ], surface === 'wood' ? 0.35 : 0.7);
  noiseBurst(x, sr, 0, rng, { amp: 0.35, attack: 0.0001, tau: 0.0012, hp: 2200, dur: 0.01 });
  if (surface === 'wood') resonate(x, sr, 0, e, [{ f: rng.range(650, 1000), t60: 0.03, amp: 1 }, { f: rng.range(1500, 2100), t60: 0.02, amp: 0.5 }], 0.5);
  if (surface === 'metal') resonate(x, sr, 0, e, metalModes(rng, rng.range(700, 1100), { n: 6, t60: 0.15, bright: 0.4 }), 0.15);
  // a little roll/skitter after the hit
  if (rng.chance(0.5)) grains(x, sr, rng.range(0.03, 0.06), rng, { count: rng.int(3, 7), spread: 0.08, amp: 0.05, fc: [3500, 8000], q: [3, 8], grainMs: [0.4, 1.2], shape: 1 });
  return master([x], sr, -22, 0.05, -3);
}
for (const s of ['concrete', 'dirt', 'metal', 'wood']) {
  C[`shell_tink_${s}`] = { gen: (r, sr) => shellTink(r, sr, s), variants: 6, group: 'casing', maxVoices: 6, priority: 12, vol: 0.3, volVar: 2.5, pitchVar: 1.2, reverb: 0.06, spatial: { ref: 1.5, max: 15 }, mono: true };
}
C.slide = { gen: slide, variants: 3, group: 'foley1p', maxVoices: 2, priority: 45, vol: 0.6, volVar: 1, pitchVar: 0.5, reverb: 0.1 };
C.jump = { gen: jump, variants: 4, group: 'foley1p', maxVoices: 2, priority: 40, vol: 0.5, volVar: 1, pitchVar: 0.5, reverb: 0.08 };
C.stance_crouch = { gen: (r, sr) => stance(r, sr, 'crouch'), variants: 3, group: 'foley1p', maxVoices: 2, priority: 30, vol: 0.45, volVar: 1, pitchVar: 0.5, reverb: 0.05 };
C.stance_stand = { gen: (r, sr) => stance(r, sr, 'stand'), variants: 3, group: 'foley1p', maxVoices: 2, priority: 30, vol: 0.4, volVar: 1, pitchVar: 0.5, reverb: 0.05 };
C.stance_prone = { gen: (r, sr) => stance(r, sr, 'prone'), variants: 3, group: 'foley1p', maxVoices: 2, priority: 35, vol: 0.55, volVar: 1, pitchVar: 0.5, reverb: 0.08 };

export default C;

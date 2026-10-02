/**
 * gamemode/config.js — tuning tables for "Hold Vardanek" (wave survival).
 * Pure data + pure functions (no THREE, no DOM) so tools can import it too.
 */

export const MODE_ID = 'survival';
export const MODE_TITLE = 'Hold Vardanek';
export const OPERATION = 'Vangaurd';
export const OBJECTIVE_TEXT = 'Hold the plaza';
export const TOTAL_WAVES = 10;

/** Difficulty keys match settings `gameplay.difficulty` (core default 'regular'). */
export const DIFFICULTIES = {
  easy: {
    key: 'easy', label: 'Conscript', blurb: 'Fewer hostiles, forgiving fire. Three reinforcements.',
    count: 0.75, aggression: 0.75, accuracy: 0.6, damage: 0.6, flank: 0.6, lives: 3, scoreMult: 0.75,
    warmup: 20, intermission: 25,
  },
  regular: {
    key: 'regular', label: 'Soldier', blurb: 'The intended experience. Two reinforcements.',
    count: 1.0, aggression: 1.0, accuracy: 0.8, damage: 1.0, flank: 1.0, lives: 2, scoreMult: 1.0,
    warmup: 15, intermission: 20,
  },
  hard: {
    key: 'hard', label: 'Specialist', blurb: 'Larger squads that flank hard. One reinforcement.',
    count: 1.25, aggression: 1.15, accuracy: 1.0, damage: 1.3, flank: 1.3, lives: 1, scoreMult: 1.5,
    warmup: 12, intermission: 16,
  },
  extreme: {
    key: 'extreme', label: 'Iron Vigil', blurb: 'No reinforcements. Every mistake is the last.',
    count: 1.5, aggression: 1.3, accuracy: 1.15, damage: 1.6, flank: 1.5, lives: 0, scoreMult: 2.0,
    warmup: 10, intermission: 14,
  },
};
export const DIFFICULTY_ORDER = ['easy', 'regular', 'hard', 'extreme'];
export function difficulty(key) { return DIFFICULTIES[key] || DIFFICULTIES.regular; }

/** Score / XP values (multiplied by difficulty.scoreMult). */
export const SCORE = {
  kill: 100,
  headshot: 50,
  melee: 50,
  explosive: 25,
  longshot: 50,
  longshotDistance: 35,
  multiWindow: 1.75, // seconds between kills to chain a multi-kill
  multi: { 2: 50, 3: 100, 4: 150 }, // 4+ uses 4
  waveClearPerWave: 200,
  flawless: 300,
  friendlyTeam: 'friendly',
  enemyTeam: 'enemy',
};

export const MULTI_NAMES = { 2: 'Double Kill', 3: 'Triple Kill', 4: 'Quad Kill', 5: 'Multi Kill' };

/** Killstreak milestones (original names). */
export const STREAKS = [
  { count: 3, name: 'Steady Hand', bonus: 100 },
  { count: 5, name: 'Iron Nerve', bonus: 200, resupply: true },
  { count: 7, name: 'Plaza Warden', bonus: 300 },
  { count: 10, name: 'Vigilant', bonus: 500, resupply: true },
  { count: 15, name: 'Unbroken Line', bonus: 750 },
  { count: 20, name: 'Last Bastion', bonus: 1000, resupply: true },
  { count: 25, name: 'Legend of Vardanek', bonus: 1500 },
];

export const ROLES = {
  rifle: { loadout: 'rifle', label: 'Rifleman' },
  smg: { loadout: 'smg', label: 'Assaulter' },
  lmg: { loadout: 'lmg', label: 'Gunner' },
  shotgun: { loadout: 'shotgun', label: 'Breacher' },
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Wave specification. Deterministic function of (wave, difficulty).
 * @returns {{wave, total, maxAlive, squadMin, squadMax, spawnInterval, firstDelay, flankChance,
 *            aggression, accuracy, damage, mix: {rifle, smg, lmg, shotgun}, heavy, final, title, subtitle}}
 */
export function waveSpec(wave, diffKey) {
  const d = difficulty(diffKey);
  const heavy = wave % 5 === 0;
  const final = wave === TOTAL_WAVES;
  const base = 4 + wave * 2.1 + (heavy ? 3 : 0) + Math.max(0, wave - TOTAL_WAVES) * 1.5;
  const total = Math.max(3, Math.round(base * d.count));
  const maxAlive = clamp(Math.round((3 + wave * 0.75) * (0.85 + 0.15 * d.count)), 3, 12);
  const mix = {
    rifle: 1,
    smg: wave >= 2 ? 0.25 + wave * 0.04 : 0,
    lmg: wave >= 4 ? 0.12 + wave * 0.02 : 0,
    shotgun: wave >= 6 ? 0.1 + wave * 0.02 : 0,
  };
  let title = 'Crimson Vanguard assault';
  let subtitle = 'Hostiles converging on the plaza';
  if (wave === 1) subtitle = 'Probing attack — hold your ground';
  if (heavy) { title = 'Heavy assault'; subtitle = 'Vanguard gunners inbound'; }
  if (final) { title = 'Final assault'; subtitle = 'Everything they have left — hold the plaza'; }
  if (wave > TOTAL_WAVES) { title = 'Endless assault'; subtitle = 'The relief column is late. Keep holding.'; }
  return {
    wave,
    total,
    maxAlive,
    squadMin: wave < 3 ? 2 : 2,
    squadMax: wave < 3 ? 3 : wave < 7 ? 4 : 5,
    spawnInterval: Math.max(2.2, 7 - wave * 0.5),
    firstDelay: 2.5,
    flankChance: clamp((0.08 + wave * 0.07) * d.flank, 0, 0.7),
    aggression: clamp((0.3 + wave * 0.07) * d.aggression, 0.1, 1),
    accuracy: clamp(d.accuracy * (0.85 + wave * 0.02), 0.2, 1.4),
    damage: d.damage,
    mix,
    heavy,
    final,
    title,
    subtitle,
  };
}

/** Compass words for flank callouts. North = -Z (yaw 0 forward), East = +X. */
export function bearingName(dx, dz) {
  const a = Math.atan2(dx, -dz); // 0 = north, +pi/2 = east
  const idx = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][idx];
}

export const STORAGE_KEY = 'opus-of-duty.gamemode.v1';

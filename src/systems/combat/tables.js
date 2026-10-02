/**
 * combat — data tables: surface ballistics, hit zones, weapon ballistic profiles, explosives.
 *
 * Everything here is plain data + tiny pure helpers so tools/combat/test-ballistics.mjs can assert the
 * same numbers the game uses (services.combat.tables exposes these objects read-only).
 */

/**
 * Surface ballistics.
 *   pen       : can a bullet pass through at all
 *   costPerCm : penetration "power" consumed per centimetre of material (power is in cm-of-softwood)
 *   keep      : base fraction of damage kept after passing through (further scaled by how hard it was)
 *   deflect   : graze angle (deg from surface plane) under which rounds skip instead of penetrating
 *   blast     : fraction of explosive blast transmitted through a (thin) layer of this material
 *   bounce    : grenade restitution (normal) ;  friction : grenade tangential friction at impact
 *   roll      : grenade rolling resistance coefficient (fraction of g) while in contact. A frag is not a
 *               ball (fuse + lever make it lopsided), so hard surfaces use ~0.2 and it stops within 1-3 m.
 */
export const SURFACE_BALLISTICS = Object.freeze({
  wood: { pen: true, costPerCm: 1.0, keep: 0.82, deflect: 8, blast: 0.45, bounce: 0.34, friction: 0.35, roll: 0.18 },
  plaster: { pen: true, costPerCm: 1.5, keep: 0.78, deflect: 6, blast: 0.35, bounce: 0.30, friction: 0.40, roll: 0.18 },
  metal: { pen: true, costPerCm: 26.0, keep: 0.66, deflect: 14, blast: 0.30, bounce: 0.42, friction: 0.22, roll: 0.13 },
  glass: { pen: true, costPerCm: 0.7, keep: 0.94, deflect: 3, blast: 0.85, bounce: 0.30, friction: 0.15, roll: 0.1 },
  fabric: { pen: true, costPerCm: 0.25, keep: 0.96, deflect: 0, blast: 0.9, bounce: 0.12, friction: 0.6, roll: 0.40 },
  cardboard: { pen: true, costPerCm: 0.3, keep: 0.95, deflect: 0, blast: 0.8, bounce: 0.18, friction: 0.5, roll: 0.25 },
  rubber: { pen: true, costPerCm: 1.8, keep: 0.8, deflect: 4, blast: 0.4, bounce: 0.55, friction: 0.8, roll: 0.20 },
  flesh: { pen: true, costPerCm: 0.45, keep: 0.72, deflect: 0, blast: 0.6, bounce: 0.1, friction: 0.7, roll: 0.5 },
  concrete: { pen: false, costPerCm: Infinity, keep: 0, deflect: 12, blast: 0, bounce: 0.36, friction: 0.30, roll: 0.2 },
  brick: { pen: false, costPerCm: Infinity, keep: 0, deflect: 10, blast: 0, bounce: 0.32, friction: 0.35, roll: 0.2 },
  asphalt: { pen: false, costPerCm: Infinity, keep: 0, deflect: 12, blast: 0, bounce: 0.33, friction: 0.35, roll: 0.22 },
  tile: { pen: false, costPerCm: Infinity, keep: 0, deflect: 14, blast: 0, bounce: 0.38, friction: 0.2, roll: 0.15 },
  dirt: { pen: false, costPerCm: Infinity, keep: 0, deflect: 5, blast: 0, bounce: 0.16, friction: 0.55, roll: 0.30 },
  gravel: { pen: false, costPerCm: Infinity, keep: 0, deflect: 6, blast: 0, bounce: 0.2, friction: 0.5, roll: 0.35 },
  sand: { pen: false, costPerCm: Infinity, keep: 0, deflect: 3, blast: 0, bounce: 0.08, friction: 0.7, roll: 0.60 },
  grass: { pen: false, costPerCm: Infinity, keep: 0, deflect: 4, blast: 0, bounce: 0.14, friction: 0.6, roll: 0.40 },
  water: { pen: false, costPerCm: Infinity, keep: 0, deflect: 10, blast: 0, bounce: 0.02, friction: 0.9, roll: 1.0 },
  default: { pen: false, costPerCm: Infinity, keep: 0, deflect: 10, blast: 0, bounce: 0.3, friction: 0.4, roll: 0.2 },
});

/**
 * Some catalog materials report a generic surface but must behave differently ballistically
 * (a sandbag is 'fabric' for footsteps/impacts, but it is a bag of sand for bullets).
 * Matched against material.name (substring, lower-case).
 */
export const MATERIAL_BALLISTIC_OVERRIDES = Object.freeze([
  ['sandbag', 'sand'],
  ['hesco', 'sand'],
  ['rubble', 'concrete'],
  ['jersey', 'concrete'],
  ['drywall', 'plaster'],
  ['plywood', 'wood'],
  ['sheet', 'metal'],
]);

export function ballisticSurface(surface, material) {
  const n = material?.name;
  if (n) {
    const l = n.toLowerCase();
    for (let i = 0; i < MATERIAL_BALLISTIC_OVERRIDES.length; i++) {
      if (l.includes(MATERIAL_BALLISTIC_OVERRIDES[i][0])) return MATERIAL_BALLISTIC_OVERRIDES[i][1];
    }
  }
  const b = material?.userData?.ballistic;
  if (b && SURFACE_BALLISTICS[b]) return b;
  return SURFACE_BALLISTICS[surface] ? surface : 'default';
}

/**
 * Hit zones. Hitbox meshes set userData.zone to one of these (aliases accepted). `head` uses the
 * weapon profile's headshot multiplier; the rest are fixed.
 */
export const ZONE_MULT = Object.freeze({
  head: 1.5, // replaced by profile.head
  neck: 1.2,
  torso: 1.0,
  chest: 1.0,
  stomach: 0.95,
  limb: 0.85,
  arm: 0.85,
  leg: 0.85,
  hand: 0.75,
  foot: 0.75,
});

export const ZONE_ALIASES = Object.freeze({
  helmet: 'head', face: 'head', skull: 'head',
  upper_torso: 'chest', upperTorso: 'chest', lower_torso: 'stomach', lowerTorso: 'stomach', pelvis: 'stomach', body: 'torso',
  upperarm: 'arm', forearm: 'arm', thigh: 'leg', calf: 'leg', shin: 'leg',
});

export function normalizeZone(z) {
  if (!z) return 'torso';
  if (ZONE_MULT[z] !== undefined) return z;
  return ZONE_ALIASES[z] || 'torso';
}

/** Coarse bucket used by the documented contract ('head'|'torso'|'limb'). */
export function zoneBucket(z) {
  if (z === 'head' || z === 'neck') return z === 'head' ? 'head' : 'torso';
  if (z === 'torso' || z === 'chest' || z === 'stomach') return 'torso';
  return 'limb';
}

/** Penetration power presets (cm of softwood a fresh round can pass). */
export const PENETRATION_POWER = Object.freeze({ none: 0, low: 12, medium: 20, high: 30, very_high: 44, extreme: 60 });

/**
 * Weapon ballistic profiles. `falloff` = [[distance m, damage fraction], ...] (piecewise-linear with
 * flat ends). The damage passed to fireHitscan is the point-blank damage; the profile shapes it.
 * `head` = headshot multiplier. `power` = penetration power. Weapons may register their own profiles
 * via services.combat.registerWeaponProfile(id, profile); unknown ids fall back by keyword, then
 * to DEFAULT_PROFILE.
 */
export const WEAPON_PROFILES = {
  // "Warden" AR-7, 5.56 (M4/416 class). 30 -> 24 -> 20 per body shot.
  ar7: { name: 'AR-7 Warden', class: 'rifle', falloff: [[0, 1], [28, 1], [30, 0.8], [52, 0.8], [55, 0.68]], head: 1.4, power: 30, range: 600, tracerEvery: 1 },
  // "Kestrel" P9, 9mm
  p9: { name: 'P9 Kestrel', class: 'pistol', falloff: [[0, 1], [12, 1], [14, 0.8], [26, 0.8], [30, 0.62]], head: 1.35, power: 13, range: 300, tracerEvery: 0 },
  smg: { name: 'SMG', class: 'smg', falloff: [[0, 1], [11, 1], [13, 0.82], [24, 0.82], [28, 0.66]], head: 1.3, power: 15, range: 350, tracerEvery: 2 },
  lmg: { name: 'LMG', class: 'lmg', falloff: [[0, 1], [40, 1], [45, 0.82], [70, 0.82], [75, 0.72]], head: 1.4, power: 42, range: 800, tracerEvery: 1 },
  dmr: { name: 'DMR', class: 'marksman', falloff: [[0, 1], [60, 1], [80, 0.85]], head: 1.6, power: 45, range: 900, tracerEvery: 1 },
  sniper: { name: 'Sniper', class: 'sniper', falloff: [[0, 1], [100, 1]], head: 2.2, power: 58, range: 1200, tracerEvery: 1 },
  shotgun: { name: 'Shotgun', class: 'shotgun', falloff: [[0, 1], [6, 1], [9, 0.55], [16, 0.25], [20, 0.1]], head: 1.15, power: 5, range: 120, tracerEvery: 0 },
  // enemy rifle (Crimson Vanguard contractors) — slightly weaker than the player's for fairness
  ai_rifle: { name: 'VK-74', class: 'rifle', falloff: [[0, 1], [25, 1], [30, 0.8], [50, 0.8], [55, 0.7]], head: 1.4, power: 26, range: 500, tracerEvery: 1 },
};

export const DEFAULT_PROFILE = Object.freeze({ name: 'Rifle', class: 'rifle', falloff: [[0, 1], [25, 1], [30, 0.8], [50, 0.8], [55, 0.7]], head: 1.4, power: 26, range: 500, tracerEvery: 1 });

const KEYWORDS = [
  ['pistol', 'p9'], ['p9', 'p9'], ['kestrel', 'p9'], ['handgun', 'p9'],
  ['smg', 'smg'], ['lmg', 'lmg'], ['dmr', 'dmr'], ['sniper', 'sniper'], ['shotgun', 'shotgun'],
  ['ar7', 'ar7'], ['ar-7', 'ar7'], ['warden', 'ar7'], ['rifle', 'ar7'], ['ai', 'ai_rifle'],
];

export function resolveProfile(profiles, weaponId) {
  if (!weaponId) return DEFAULT_PROFILE;
  const direct = profiles[weaponId];
  if (direct) return direct;
  const l = String(weaponId).toLowerCase();
  for (let i = 0; i < KEYWORDS.length; i++) if (l.includes(KEYWORDS[i][0])) return profiles[KEYWORDS[i][1]] || DEFAULT_PROFILE;
  return DEFAULT_PROFILE;
}

/** Piecewise-linear falloff lookup. */
export function falloffAt(falloff, d) {
  if (!falloff || falloff.length === 0) return 1;
  if (d <= falloff[0][0]) return falloff[0][1];
  for (let i = 1; i < falloff.length; i++) {
    const b = falloff[i];
    if (d <= b[0]) {
      const a = falloff[i - 1];
      const t = (d - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return falloff[falloff.length - 1][1];
}

/** Explosive definitions (explode({type}) fills in missing params from here). */
export const EXPLOSIVES = Object.freeze({
  // fragments = cosmetic fragment rays (pits + puffs on surrounding surfaces), fragRange in metres
  frag: { radius: 7.5, innerRadius: 2.2, damage: 210, minFrac: 0.12, impulse: 34, shakeRadius: 22, weaponId: 'frag', name: 'Frag Grenade', fragments: 96, fragRange: 10 },
  barrel: { radius: 6.5, innerRadius: 1.8, damage: 190, minFrac: 0.1, impulse: 40, shakeRadius: 26, weaponId: 'barrel', name: 'Explosion', fragments: 30, fragRange: 7 },
  rocket: { radius: 5.0, innerRadius: 1.2, damage: 250, minFrac: 0.1, impulse: 45, shakeRadius: 28, weaponId: 'rocket', name: 'Rocket', fragments: 48, fragRange: 8 },
  default: { radius: 6.0, innerRadius: 1.5, damage: 150, minFrac: 0.1, impulse: 30, shakeRadius: 20, weaponId: 'explosive', name: 'Explosion', fragments: 24, fragRange: 8 },
});

/**
 * Explosion falloff: full damage inside innerRadius, then a smooth curve down to minFrac at the edge,
 * zero outside the radius.
 */
export function blastFalloff(dist, radius, inner, minFrac) {
  if (dist >= radius) return 0;
  if (dist <= inner) return 1;
  const t = (dist - inner) / Math.max(1e-6, radius - inner);
  const s = 1 - t;
  // eased curve (roughly inverse-square-ish near the core, linear-ish toward the edge)
  return minFrac + (1 - minFrac) * (s * s * (0.35 + 0.65 * s) + 0.35 * s * t);
}

/** Frag grenade tuning. */
export const GRENADE = Object.freeze({
  fuse: 3.6, // seconds from pin pull (cook start) to detonation
  radius: 0.034, // collision sphere (m)
  visualScale: 1.3, // in-world mesh drawn larger than life for readability (collision unchanged)
  dangerRadius: 9.5, // grenade indicator shows within this distance of the player (m)
  mass: 0.4,
  throwSpeed: 17.5, // m/s at full throw
  lobSpeed: 9.5,
  throwPitchUp: 9, // deg added to aim pitch
  windup: 0.12, // s between release and the grenade leaving the hand
  drag: 0.012, // quadratic drag coefficient (1/m)
  maxCarried: 2,
  sleepSpeed: 0.06,
  tumbleDrag: 0.5, // quadratic ground drag (1/m) while skidding/tumbling fast (> ~1-3 m/s), scaled by surface grip
  impactTangentLoss: 0.32, // share of tangential speed lost when it tumbles on a hard impact
});

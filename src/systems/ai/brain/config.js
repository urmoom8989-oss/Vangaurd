/** AI tunables. Speeds m/s, times s, angles rad. */
export const CFG = {
  walk: 1.45,
  patrolWalk: 1.2,
  run: 3.8,
  sprint: 5.2,
  crouchWalk: 1.15,
  accel: 8,
  decel: 11,
  radius: 0.34,
  height: 1.8,

  sightRange: 80,
  fovFocus: 0.95, // half-angle
  fovPeriph: 1.75,
  hearRange: 90,
  perceiveEvery: 0.12,
  thinkEvery: 0.25,

  aimTurn: 4.2, // max rad/s tracking
  reaction: [0.3, 0.65],

  health: 100,
  corpseLimit: 10,
  corpseTime: 30,
  maxAgents: 24,

  // LOD distances (m)
  lod1: 13,
  lod2: 30,
  animHalfRate: 45,
  animThirdRate: 80,

  grenadeSquadCooldown: 14,
  grenadeGlobalCooldown: 7,
};

// spread in degrees (fireHitscan convention)
export const LOADOUTS = {
  rifle: { weaponId: 'ai_rifle', rpm: 640, mag: 30, damage: 24, burst: [3, 6], pause: [0.3, 0.75], range: 26, ideal: 18, reload: 2.4, spread: 0.35, grenades: 1 },
  smg: { weaponId: 'ai_smg', rpm: 820, mag: 32, damage: 19, burst: [4, 9], pause: [0.25, 0.6], range: 16, ideal: 11, reload: 2.1, spread: 0.6, grenades: 1 },
  lmg: { weaponId: 'ai_lmg', rpm: 700, mag: 100, damage: 24, burst: [7, 15], pause: [0.4, 0.9], range: 34, ideal: 22, reload: 3.6, spread: 0.55, grenades: 0 },
  shotgun: { weaponId: 'ai_shotgun', rpm: 70, mag: 7, damage: 15, pellets: 8, burst: [1, 1], pause: [0.7, 1.1], range: 9, ideal: 5, reload: 3.0, spread: 3.2, grenades: 1 },
};

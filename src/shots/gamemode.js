/**
 * Shot presets owned by the GAMEMODE agent. Names must start with "gamemode-".
 *
 * The gamemode system is inert ('sandbox') in shot mode unless a preset carries a `gamemode` block, which
 * is passed to services.gamemode.scenario() at init:
 *   { scenario: 'menu'|'intro'|'live'|'intermission'|'dead'|'ended'|'pause', difficulty, wave, stats: {...},
 *     stageTime (s into the stage before warmup), bannerTime, spawnNow, preferVisible, victory, final, killer }
 * Warmup frames then advance the flow deterministically (1/60 s each).
 */
const RUN_STATS = {
  score: 6840, kills: 31, headshots: 12, bestStreak: 9, streak: 4, shotsFired: 412, shotsHit: 173, deaths: 1,
  combatTime: 517, medals: { Headshot: 12, 'Steady Hand': 3, 'Iron Nerve': 1, 'Double Kill': 4, 'Plaza Warden': 1, Longshot: 2 },
};

export default {
  'gamemode-menu': {
    description: 'Main menu over the slow establishing orbit of the plaza.',
    gamemode: { scenario: 'menu', stageTime: 1.2 },
    warmup: 60,
  },

  'gamemode-intro': {
    description: 'Mission intro: typed location stamp (bottom-left) + "Hold the plaza" objective card after deploy.',
    gamemode: { scenario: 'intro', stageTime: 5.6, difficulty: 'regular' },
    player: { position: [0, null, 8], yaw: 0, pitch: -2 },
    weapon: { state: 'hip' },
    warmup: 45,
  },

  'gamemode-intro-seq': {
    description: 'Intro timeline for --sequence review (fade-in, typing, objective, countdown).',
    gamemode: { scenario: 'intro', stageTime: 0.0 },
    player: { position: [0, null, 8], yaw: 0, pitch: -2 },
    warmup: 10,
  },

  'gamemode-wave-live': {
    description: 'Wave 3 live: wave banner, tracker, hostiles spawned in view (with a working AI system).',
    gamemode: {
      scenario: 'live', wave: 3, spawnNow: true, preferVisible: true, announceAt: 7.4, invulnerable: true,
      spawnAt: [[-4, -37], [5.5, -43], [0, -52]],
      stats: { score: 1850, kills: 11, headshots: 4, streak: 2, bestStreak: 5, shotsFired: 140, shotsHit: 61 },
    },
    player: { position: [2.5, null, -20], yaw: 3, pitch: 0 },
    weapon: { state: 'hip' },
    warmup: 540,
  },

  'gamemode-intermission': {
    description: 'Between waves: wave-cleared panel with bonuses, resupply and next-wave countdown.',
    gamemode: {
      scenario: 'intermission', wave: 3, flawless: true, stageTime: 2.9, waveTime: 71,
      stats: { score: 3150, kills: 19, headshots: 7, streak: 8, bestStreak: 8, shotsFired: 236, shotsHit: 104, waveKills: 9, waveShots: 92, waveHits: 44, waveHeads: 4 },
    },
    player: { position: [0, null, 8], yaw: 20, pitch: -3 },
    weapon: { state: 'hip' },
    warmup: 45,
  },

  'gamemode-death': {
    description: 'Killed in action with reinforcements remaining (redeploy countdown).',
    gamemode: { scenario: 'dead', wave: 4, stageTime: 0, killer: 'Vanguard Rifleman', distance: 23, stats: { score: 3920, kills: 22, headshots: 8, bestStreak: 8, shotsFired: 280, shotsHit: 119 } },
    player: { position: [0, null, 8], yaw: -15, pitch: -6 },
    warmup: 160,
  },

  'gamemode-pause': {
    description: 'Pause menu over the frozen, blurred battlefield.',
    gamemode: { scenario: 'pause', wave: 5, stats: { score: 4410, kills: 24, headshots: 9, bestStreak: 7, shotsFired: 301, shotsHit: 127, deaths: 1 } },
    player: { position: [0, null, 8], yaw: 10, pitch: -2 },
    weapon: { state: 'hip' },
    warmup: 30,
  },

  'gamemode-gameover': {
    description: 'End-of-game summary after the plaza is overrun on wave 7 (score count-up finished).',
    gamemode: {
      scenario: 'ended', wave: 7, victory: false, stageTime: 2.2, difficulty: 'hard', newBest: true,
      prevBest: { score: 5210, wave: 6, kills: 24 }, stats: { ...RUN_STATS, lives: 0, deaths: 2 },
    },
    warmup: 30,
  },

  'gamemode-victory': {
    description: 'End-of-game summary after surviving all 10 waves.',
    gamemode: {
      scenario: 'ended', wave: 10, victory: true, stageTime: 2.4, difficulty: 'regular', newBest: true,
      prevBest: { score: 9120, wave: 8, kills: 44 },
      stats: { ...RUN_STATS, score: 14650, kills: 83, headshots: 37, bestStreak: 17, shotsFired: 1210, shotsHit: 522, deaths: 1, combatTime: 1133, medals: { ...RUN_STATS.medals, Vigilant: 2, 'Unbroken Line': 1, Flawless: 3 } },
    },
    warmup: 30,
  },

  'gamemode-endcam': {
    description: 'Debug: the end-of-game cinematic camera without UI (framing check).',
    gamemode: { scenario: 'ended', wave: 7, victory: false, stageTime: 2.2, stats: { ...RUN_STATS, lives: 0 } },
    hud: false,
    warmup: 30,
  },

  'gamemode-perf': {
    description: 'Perf: wave 6 live with real spawning + scripted look/fire (use with tools/perf.mjs).',
    gamemode: { scenario: 'live', wave: 6, spawnNow: true, stats: { score: 3000, kills: 20 } },
    player: { position: [0, null, 8], yaw: 0, pitch: 0 },
    input: [
      { frame: 0, look: [40, 0] },
      { frame: 60, look: [-80, 0] },
      { frame: 120, press: 'fire' },
      { frame: 140, release: 'fire' },
      { frame: 150, look: [40, 0] },
    ],
    inputLoop: 180,
    warmup: 60,
  },

  'gamemode-playtest': {
    description: 'Starts at the main menu with the full flow live; driven by tools/gamemode/playtest.mjs.',
    gamemode: { scenario: 'menu', stageTime: 1.0, difficulty: 'regular' },
    warmup: 5,
  },
};

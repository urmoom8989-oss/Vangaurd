/**
 * Core shot presets (owner: lead / core). Schema: see ARCHITECTURE.md "Shot presets".
 */
export default {
  smoke: {
    description: 'Boot everything, stand at spawn looking at the test area with the weapon at hip.',
    player: { position: [0, null, 8], yaw: 0, pitch: -4 },
    weapon: { state: 'hip' },
    warmup: 30,
  },

  'core-overview': {
    description: 'Elevated free camera over the greybox test area (camera override, no HUD).',
    camera: { position: [26, 18, 30], target: [4, 0, -4], hfov: 80 },
    hud: false,
    warmup: 10,
  },

  'core-walk': {
    description: 'Scripted walk + look + fire; use with --sequence to verify input injection & determinism.',
    player: { position: [0, null, 12], yaw: 0, pitch: 0 },
    weapon: { id: 'rifle_placeholder' },
    input: [
      { frame: 0, move: [0, 1] },
      { frame: 0, look: [-40, 0] },
      { frame: 20, press: 'fire' },
      { frame: 32, release: 'fire' },
    ],
    warmup: 40,
  },

  'core-perf': {
    description: 'Perf run: walks/strafes/turns in a loop with all systems (use with tools/perf.mjs).',
    player: { position: [0, null, 10], yaw: 0, pitch: 0 },
    input: [
      { frame: 0, move: [0, 1] },
      { frame: 0, press: 'sprint' },
      { frame: 90, release: 'sprint' },
      { frame: 90, move: [1, 0] },
      { frame: 150, move: [0, -1] },
      { frame: 210, move: [-1, 0] },
      { frame: 0, look: [30, 0] },
      { frame: 60, look: [-60, 5] },
      { frame: 120, look: [80, -5] },
      { frame: 180, look: [-50, 0] },
      { frame: 240, press: 'fire' },
      { frame: 260, release: 'fire' },
    ],
    inputLoop: 280,
    warmup: 30,
  },
};

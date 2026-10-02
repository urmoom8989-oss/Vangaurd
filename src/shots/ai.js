/**
 * Shot presets owned by the AI agent. Names start with "ai-".
 * `ai` block (read by src/systems/ai/index.js):
 *   { brain?: false, spawn: [{ position:[x, y|null, z], yaw (deg), loadout, variant, tint, behavior,
 *       mode?: 'combat', puppet?: { weapon, crouch, aimYaw, aimPitch, bodyYaw, lean, vel:[vx,vz], aimAtPlayer,
 *       fire, fireCycle, fireOn, reloadAt, throwAt }, kill?: { t, zone, dir:[x,y,z], kind } }] }
 */

const P0 = [4.5, null, 9.5];
// sunlit open spot on the west side of the plaza (character review presets)
const PS = [-16, null, -2];

// a 5-man squad entering the south side of the plaza, already aware of the player
const SQ = { squad: 7, aggression: 0.7, accuracy: 0.8, target: 'player' };
const SQUAD = [
  { position: [-3, null, -17], yaw: 180, loadout: 'rifle', behavior: { ...SQ }, mode: 'combat' },
  { position: [2, null, -18], yaw: 180, loadout: 'lmg', behavior: { ...SQ }, mode: 'combat' },
  { position: [5, null, -16], yaw: 180, loadout: 'rifle', behavior: { ...SQ, role: 'flank' }, mode: 'combat' },
  { position: [-6, null, -19], yaw: 180, loadout: 'smg', behavior: { ...SQ }, mode: 'combat' },
  { position: [0, null, -20], yaw: 180, loadout: 'rifle', behavior: { ...SQ }, mode: 'combat' },
];

const STRESS = [];
for (let i = 0; i < 16; i++) {
  const sq = i % 3;
  STRESS.push({ position: [-12 + (i % 6) * 5, null, -16 - Math.floor(i / 6) * 4], yaw: 180, loadout: ['rifle', 'smg', 'lmg', 'rifle'][i % 4],
    behavior: { squad: 20 + sq, aggression: 0.7, accuracy: 0.8, target: 'player' }, mode: 'combat' });
}

export default {
  'ai-soldier-closeup': {
    description: 'Close-up of a Crimson Vanguard contractor shouldering his rifle (camera override).',
    only: ['materials', 'lighting', 'world', 'postfx', 'player', 'combat', 'vfx', 'ai'],
    ai: { brain: false, spawn: [{ position: PS, yaw: 35, variant: 0, tint: 0, puppet: { weapon: 'aim', aimYaw: 35, aimPitch: 1 } }] },
    camera: { position: [-13.05, 1.64, -1.48], target: [-16.0, 1.42, -2.0], hfov: 32 },
    hud: false,
    warmup: 40,
  },
  'ai-soldier-full': {
    description: 'Full body 3/4 view of a soldier at low ready.',
    only: ['materials', 'lighting', 'world', 'postfx', 'player', 'combat', 'vfx', 'ai'],
    ai: { brain: false, spawn: [{ position: PS, yaw: 30, variant: 2, tint: 1, puppet: { weapon: 'low', aimYaw: 30, aimPitch: -4 } }] },
    camera: { position: [-14.3, 1.15, 1.6], target: [-16.0, 0.95, -2.0], hfov: 46 },
    hud: false,
    warmup: 40,
  },
  'ai-debug-top': {
    description: 'debug: top view of the posed soldier',
    only: ['materials', 'lighting', 'world', 'postfx', 'player', 'combat', 'vfx', 'ai'],
    ai: { brain: false, spawn: [{ position: P0, yaw: 200, variant: 0, tint: 0, puppet: { weapon: 'aim', aimYaw: 205, aimPitch: 2 } }] },
    camera: { position: [4.5, 4.5, 9.4], target: [4.5, 1.0, 9.5], hfov: 50 },
    hud: false,
    warmup: 40,
  },
  'ai-run-cycle': {
    description: 'Tracking side view of a soldier running at combat pace (use --sequence 8 --interval 67).',
    only: ['materials', 'lighting', 'world', 'postfx', 'player', 'combat', 'vfx', 'ai'],
    ai: { brain: false, spawn: [{ position: [-16, null, -5.5], yaw: 0, variant: 1, tint: 2, puppet: { weapon: 'low', vel: [0, 3.8], aimPitch: -3 } }] },
    camera: { position: [-20, 1.1, -2], target: [-16, 0.95, -2], hfov: 45 },
    onFrame(ctx) {
      const a = ctx.services.ai.agents[0];
      if (!a) return;
      const z = a.position.z + 3.8 / 60;
      this.camera.position[2] = z; this.camera.target[2] = z;
    },
    hud: false,
    warmup: 60,
  },
  'ai-death-ragdoll': {
    description: 'A soldier is shot in the chest and collapses into a ragdoll (use --sequence 10 --interval 150).',
    only: ['materials', 'lighting', 'world', 'postfx', 'player', 'combat', 'vfx', 'ai'],
    ai: { brain: false, spawn: [{ position: PS, yaw: 10, variant: 0, tint: 3, puppet: { weapon: 'aim', aimYaw: 12, aimPitch: 0 }, kill: { t: 0.45, zone: 'torso', dir: [-0.2, -0.05, -0.98] } }] },
    camera: { position: [-12.6, 1.35, -0.2], target: [-16.2, 0.6, -2.6], hfov: 55 },
    hud: false,
    warmup: 30,
  },
  'ai-squad': {
    description: 'A Crimson Vanguard fire team takes cover in the plaza and engages the player (camera behind the squad).',
    only: ['materials', 'lighting', 'world', 'postfx', 'player', 'weapons', 'combat', 'vfx', 'ai'],
    player: { position: [0, null, 12.5], yaw: 0, pitch: -2 },
    ai: { spawn: SQUAD },
    setup(ctx) { ctx.services.player.setInvulnerable?.(true); },
    camera: { position: [-1, 1.9, -33], target: [0, 1.0, -18], hfov: 60 },
    hud: false,
    warmup: 300,
  },
  'ai-firefight': {
    description: 'Player view of a squad engaging from cover across the plaza (HUD on).',
    player: { position: [0, null, 12.5], yaw: 0, pitch: -1 },
    ai: { spawn: SQUAD },
    setup(ctx) { ctx.services.player.setInvulnerable?.(true); },
    hud: true,
    warmup: 300,
  },
  'ai-perf-baseline': {
    description: 'Perf baseline: same view as ai-firefight with no soldiers.',
    player: { position: [0, null, 12.5], yaw: 0, pitch: -1 },
    ai: { spawn: [] },
    setup(ctx) { ctx.services.player.setInvulnerable?.(true); },
    hud: true,
    warmup: 60,
  },
  'ai-perf-16': {
    description: 'Perf stress: 16 soldiers in three squads engaging the player across the plaza.',
    player: { position: [0, null, 12.5], yaw: 0, pitch: -1 },
    ai: { spawn: STRESS },
    setup(ctx) { ctx.services.player.setInvulnerable?.(true); },
    hud: true,
    warmup: 120,
  },
  'ai-turntable': {
    description: 'Character review: camera orbits a soldier in sunlight (use --sequence 4 --interval 250).',
    only: ['materials', 'lighting', 'world', 'postfx', 'player', 'combat', 'vfx', 'ai'],
    ai: { brain: false, spawn: [{ position: [-16, null, -2], yaw: 0, variant: 0, tint: 0, puppet: { weapon: 'aim', aimYaw: 0, aimPitch: 0 } }] },
    camera: { position: [-16, 1.3, 1.4], target: [-16, 1.0, -2], hfov: 50 },
    onFrame(ctx, f) {
      const a = Math.floor(Math.max(0, f - 33) / 15) * (Math.PI / 2) + 0.5;
      this.camera.position[0] = -16 + Math.sin(a) * 3.4; this.camera.position[2] = -2 + Math.cos(a) * 3.4;
    },
    hud: false,
    warmup: 40,
  },
};

/**
 * Shot presets owned by the WEAPONS agent. Names must start with "weapons-".
 *
 * Custom preset fields read by the weapons system:
 *   weapon: { id: 'rifle'|'pistol', state: 'hip'|'ads'|'sprint'|'tacsprint'|'reload'|'reloadEmpty'|'inspect'|
 *             'melee'|'grenade'|'fireMode'|'fire'|'equip', progress: 0..1 }
 *   weaponsDisplay: { position, rotation(deg), arms: bool }  places the rig in the world for camera-override
 *             close-ups (camera.viewmodel must be true).
 */
const P = { position: [0, null, 8], yaw: 0, pitch: 0 };
const seqNote = ' Use --sequence N --interval ms for motion.';

export default {
  'weapons-hip': {
    description: 'Rifle viewmodel at hip, idle.',
    player: P,
    weapon: { id: 'rifle', state: 'hip' },
    warmup: 30,
  },
  'weapons-ads': {
    description: 'Rifle fully aimed down the holographic sight (reticle must sit exactly at screen center).',
    player: P,
    weapon: { id: 'rifle', state: 'ads' },
    warmup: 30,
  },
  'weapons-sprint': {
    description: 'Rifle sprint pose.',
    player: P,
    weapon: { id: 'rifle', state: 'sprint' },
    warmup: 40,
  },
  'weapons-tacsprint': {
    description: 'Rifle tactical-sprint pose.',
    player: P,
    weapon: { id: 'rifle', state: 'tacsprint' },
    warmup: 40,
  },
  'weapons-reload': {
    description: 'Tactical reload (2.1 s) played live from frame 2; default capture mid-reload.' + seqNote,
    player: P,
    input: [{ frame: 2, tap: 'reload' }],
    setup(ctx) { const s = ctx.services.weapons.state; s.ammo = 12; },
    warmup: 60,
  },
  'weapons-reload-mid': {
    description: 'Tactical reload forced at 50% progress (new mag coming up).',
    player: P,
    weapon: { id: 'rifle', state: 'reload', progress: 0.5 },
    warmup: 30,
  },
  'weapons-reload-empty': {
    description: 'Empty reload (2.6 s: mag drop, new mag, bolt release) played live.' + seqNote,
    player: P,
    input: [{ frame: 2, tap: 'reload' }],
    setup(ctx) { const s = ctx.services.weapons.state; s.ammo = 0; },
    warmup: 60,
  },
  'weapons-fire-burst': {
    description: 'Live full-auto burst from frame 5 (muzzle flash / recoil).' + seqNote,
    player: P,
    input: [{ frame: 5, press: 'fire' }],
    warmup: 12,
  },
  'weapons-inspect': {
    description: 'Weapon inspect forced at 30% (right side presented).',
    player: P,
    weapon: { id: 'rifle', state: 'inspect', progress: 0.3 },
    warmup: 30,
  },
  'weapons-pistol-hip': {
    description: 'Kestrel P9 pistol at hip.',
    player: P,
    weapon: { id: 'pistol', state: 'hip' },
    warmup: 30,
  },
  'weapons-pistol-ads': {
    description: 'Kestrel P9 aimed (iron sights).',
    player: P,
    weapon: { id: 'pistol', state: 'ads' },
    warmup: 30,
  },
  'weapons-closeup': {
    description: 'Camera override: the Warden AR-7 on display (left side) for model/material review.',
    player: P,
    weaponsDisplay: { position: [0, 1.4, 5], rotation: [0, 90, 0], arms: false },
    camera: { position: [-0.2, 1.52, 6.25], target: [-0.15, 1.38, 5.0], hfov: 42, near: 0.01, viewmodel: true },
    hud: false,
    warmup: 20,
  },
  'weapons-closeup-right': {
    description: 'Camera override: rifle right side (ejection port, forward assist).',
    player: P,
    weaponsDisplay: { position: [0, 1.4, 5], rotation: [0, 90, 0], arms: false },
    camera: { position: [-0.1, 1.52, 3.75], target: [-0.15, 1.38, 5.0], hfov: 42, near: 0.01, viewmodel: true },
    hud: false,
    warmup: 20,
  },
  'weapons-closeup-detail': {
    description: 'Camera override: tight 3/4 on the receiver, sight and magwell.',
    player: P,
    weaponsDisplay: { position: [0, 1.4, 5], rotation: [0, 90, 0], arms: false },
    camera: { position: [-0.18, 1.56, 5.42], target: [-0.08, 1.42, 5.0], hfov: 30, near: 0.01, viewmodel: true },
    hud: false,
    warmup: 20,
  },
  'weapons-arms-closeup': {
    description: 'Camera override: full first-person rig (arms + rifle) from outside, left-front 3/4.',
    player: P,
    weaponsDisplay: { position: [0, 1.5, 5], rotation: [0, 0, 0], arms: true },
    weapon: { id: 'rifle', state: 'hip' },
    camera: { position: [-0.55, 1.62, 4.55], target: [0.02, 1.38, 4.8], hfov: 50, near: 0.01, viewmodel: true },
    hud: false,
    warmup: 20,
  },
  'weapons-arms-under': {
    description: 'Camera override: rig from below-right (grip hands, palms, fingers).',
    player: P,
    weaponsDisplay: { position: [0, 1.5, 5], rotation: [0, 0, 0], arms: true },
    weapon: { id: 'rifle', state: 'hip' },
    camera: { position: [0.45, 1.2, 4.55], target: [0.05, 1.4, 4.8], hfov: 50, near: 0.01, viewmodel: true },
    hud: false,
    warmup: 20,
  },
};

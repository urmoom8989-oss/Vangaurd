/**
 * Shot presets owned by the COMBAT agent. Names start with "combat-".
 *
 * They build a small firing range (src/systems/combat/fixtures.js) outside the playable town, looking
 * back toward it, and drive services.combat directly with deterministic shots/throws.
 */
import { buildRange, ensureWorld } from '../systems/combat/fixtures.js';

// Flat open ground just north of the town edge (world bounds end at z=70); looking -Z the town's
// out-of-bounds facades form the backdrop. Camera arrays in these presets are RANGE-LOCAL (converted in setup).
const RANGE_ORIGIN = [0, null, 116];
const S = {}; // per-shot scratch (setup -> onFrame)

function rangeSetup(build) {
  return async (ctx) => {
    ensureWorld(ctx);
    await ctx.services.world.ready;
    const range = buildRange(ctx, { origin: RANGE_ORIGIN, yaw: 0, floorSize: [26, 26] });
    S.range = range;
    const cam = ctx.shot?.camera;
    if (cam && !cam._world) {
      cam._world = true;
      if (cam.position) cam.position = range.toWorld(cam.position).toArray();
      if (cam.target) cam.target = range.toWorld(cam.target).toArray();
    }
    S.ctx = ctx;
    build(range, ctx);
    range.finish();
    // keep AI / gamemode from wandering into the frame
    ctx.services.ai.setEnabled?.(false);
  };
}

/** Fire a deterministic round from local shooter pos toward a local aim point. */
function fireAt(range, ctx, from, to, opts = {}) {
  const o = range.toWorld(from);
  const t = range.toWorld(to);
  const dir = t.sub(o).normalize();
  return ctx.services.combat.fireHitscan({
    origin: o, direction: dir, damage: 30, source: 'player', weaponId: 'ar7', range: 300, tracer: false, ...opts,
  });
}

// ------------------------------------------------------------------------------ impacts wall
const WALLS = [
  { material: 'concrete_wall', t: 0.25, name: 'concrete' },
  { material: 'brick_red', t: 0.24, name: 'brick' },
  { material: 'plaster_painted', t: 0.14, name: 'plaster' },
  { material: 'wood_planks', t: 0.05, name: 'wood' },
  { material: 'corrugated_metal', t: 0.004, name: 'sheet metal' },
  { material: 'sandbags', t: 0.6, name: 'sandbags' },
];
const WALL_W = 1.15;
const WALL_GAP = 0.32;
const wallX = (i) => (i - (WALLS.length - 1) / 2) * (WALL_W + WALL_GAP);
// scatter pattern (local offsets on each wall face), deterministic
const PATTERN = [[0.0, 1.45], [-0.22, 1.2], [0.18, 1.62], [0.05, 0.95], [-0.15, 1.78], [0.28, 1.3], [-0.3, 0.8], [0.12, 1.05]];
const WALL_Z = -5;
const SHOOTER = [0, 1.62, 1.2];

function impactsPreset({ camera, lastVolleyFrame, every = 5 }) {
  return {
    description: 'Series of AR-7 hits into concrete, brick, plaster, wood, sheet metal and sandbags (judge impacts, decals, exit spall).',
    seed: 7,
    warmup: lastVolleyFrame + 4,
    hud: false,
    camera,
    setup: rangeSetup((range) => {
      WALLS.forEach((w, i) => {
        if (w.material === 'sandbags') { range.sandbags({ x: wallX(i), z: WALL_Z - w.t / 2, w: WALL_W + 0.2, rows: 6, depth: w.t }); return; }
        range.panel({ material: w.material, w: WALL_W, h: 2.3, t: w.t, x: wallX(i), z: WALL_Z - w.t / 2, name: `wall_${w.name}` });
        if (w.material === 'corrugated_metal') {
          // posts holding the sheet
          range.panel({ material: 'metal_rusted', w: 0.06, h: 2.4, t: 0.06, x: wallX(i) - WALL_W / 2 + 0.03, z: WALL_Z + 0.04 });
          range.panel({ material: 'metal_rusted', w: 0.06, h: 2.4, t: 0.06, x: wallX(i) + WALL_W / 2 - 0.03, z: WALL_Z + 0.04 });
        }
        if (w.material === 'wood_planks') {
          range.panel({ material: 'wood_planks', w: 0.09, h: 2.3, t: 0.09, x: wallX(i), z: WALL_Z + 0.06 });
        }
      });
      // backstop far behind so penetrating rounds land on something
      range.panel({ material: 'concrete_wall', w: 14, h: 3.2, t: 0.4, x: 0, z: -11 });
    }),
    onFrame(ctx, f) {
      const range = S.range;
      if (!range) return;
      // one round per frame, walking across the walls; the last volley lands just before the capture
      const shotsPerWall = PATTERN.length;
      const total = WALLS.length * shotsPerWall;
      const start = lastVolleyFrame - (total - 1) * every;
      if (f < start || (f - start) % every !== 0) return;
      const k = (f - start) / every;
      if (k >= total) return;
      const wi = k % WALLS.length;
      const pi = Math.floor(k / WALLS.length);
      const [dx, y] = PATTERN[pi];
      const h = WALLS[wi].material === 'sandbags' ? 0.25 + (y - 0.8) * 0.75 : y;
      fireAt(range, ctx, SHOOTER, [wallX(wi) + dx, h, WALL_Z], { tracer: k === total - 1 || k === total - 3 });
    },
  };
}

// ------------------------------------------------------------------------------ penetration
const PEN_LAYOUT = [
  { kind: 'panel', material: 'wood_planks', t: 0.03, z: -3.0, name: 'plywood 3cm' },
  { kind: 'target', z: -5.0 },
  { kind: 'panel', material: 'plaster_painted', t: 0.12, z: -7.0, name: 'plaster 12cm' },
  { kind: 'target', z: -9.0 },
  { kind: 'panel', material: 'corrugated_metal', t: 0.004, z: -11.0, name: 'sheet 4mm' },
  { kind: 'target', z: -13.0 },
  { kind: 'panel', material: 'concrete_wall', t: 0.3, z: -15.5, name: 'concrete 30cm' },
  { kind: 'target', z: -17.5 },
];

function penetrationPreset({ debug, camera, description, warmup = 50 }) {
  return {
    description,
    seed: 11,
    warmup,
    hud: false,
    settings: { combat: { debugDraw: debug } },
    camera,
    setup: rangeSetup((range) => {
      S.targets = [];
      for (const it of PEN_LAYOUT) {
        if (it.kind === 'panel') range.panel({ material: it.material, w: 2.4, h: 2.4, t: it.t, x: 0, z: it.z - it.t / 2, name: it.name });
        else S.targets.push(range.target({ x: 0, z: it.z, health: 1000 }));
      }
    }),
    onFrame(ctx, f) {
      const range = S.range;
      if (!range) return;
      const shots = [
        [10, [0, 1.62, 0.5], [0.02, 1.36, -20], 'ar7'],
        [16, [0, 1.62, 0.5], [-0.1, 1.74, -20], 'ar7'],
        [22, [0.1, 1.62, 0.5], [0.25, 1.15, -20], 'p9'],
        [28, [-0.1, 1.62, 0.5], [-0.3, 1.0, -20], 'lmg'],
        [44, [0, 1.62, 0.5], [0.0, 1.45, -20], 'ar7'],
      ];
      for (const [frame, a, b, w] of shots) if (f === frame) fireAt(range, ctx, a, b, { weaponId: w, tracer: frame === 44 });
    },
  };
}

// ------------------------------------------------------------------------------ grenade arc
function grenadePreset({ description, camera, fuse, debug, warmup = 20, props = true, throwFrame = 0, from, vel, follow = null }) {
  return {
    description,
    seed: 5,
    warmup,
    hud: false,
    settings: { combat: { debugDraw: !!debug } },
    camera,
    setup: rangeSetup((range) => {
      if (props) {
        // a low concrete barrier to bounce off and a crate + sandbags to frame the landing zone
        range.panel({ material: 'concrete_wall', w: 2.6, h: 0.85, t: 0.35, x: 2.35, z: -5.3, ry: Math.PI / 2 - 0.12 });
        range.panel({ material: 'wood_planks', w: 1.0, h: 1.0, t: 1.0, x: -3.6, z: -7.4, ry: 0.35 });
        range.sandbags({ x: 0.6, z: -9.2, w: 2.0, rows: 3, depth: 0.55, ry: -0.2 });
        // a plastered wall section behind the landing zone catches the fragment spray
        range.panel({ material: 'plaster_painted', w: 4.2, h: 2.6, t: 0.2, x: 0.2, z: -7.6 });
      }
    }),
    onFrame(ctx, f) {
      const range = S.range;
      if (!range) return;
      if (f === throwFrame) {
        const o = range.toWorld(from);
        const v = range.dirToWorld(vel).multiplyScalar(Math.hypot(...vel));
        S.grenade = ctx.services.combat.throwGrenade({ origin: o, velocity: v, fuse, source: 'player', recordPath: true });
      }
      // optional follow camera (mutates this preset's camera override, applied after lateUpdate)
      if (follow && S.grenade && ctx.shot?.camera) {
        const p = S.grenade.position;
        ctx.shot.camera.target = [p.x + (follow.aim?.[0] ?? 0), p.y + (follow.aim?.[1] ?? 0), p.z + (follow.aim?.[2] ?? 0)];
        ctx.shot.camera.position = [p.x + follow.offset[0], p.y + follow.offset[1], p.z + follow.offset[2]];
      }
    },
  };
}

// ------------------------------------------------------------------------------ grenade model showcase
function grenadeModelPreset({ camera, description }) {
  return {
    description,
    seed: 3,
    warmup: 4,
    hud: false,
    camera,
    setup: rangeSetup((range, ctx) => {
      // a wooden crate lid as a display surface, one armed grenade standing, one (spoon gone) on its side
      range.panel({ material: 'wood_planks', w: 0.9, h: 0.5, t: 0.6, x: 0.35, z: -3.6 });
      const top = 0.5;
      const a = ctx.services.combat.createGrenadeMesh({ pin: true, spoon: true });
      a.position.copy(range.toWorld([0.28, top + 0.0345, -3.62]));
      a.rotation.set(0, -0.75, 0);
      range.root.parent.add(a);
      const b = ctx.services.combat.createGrenadeMesh({ pin: false, spoon: false });
      b.position.copy(range.toWorld([0.47, top + 0.034, -3.5]));
      b.rotation.set(0.15, -0.6, 1.38);
      range.root.parent.add(b);
      S.showcase = [a, b];
    }),
  };
}

export default {
  // ---------------------------------------------------------------- full-game integration
  'combat-grenade-incoming': {
    description: 'Full game, player view: an enemy frag (throwGrenadeAt, as the AI uses it) arcs in from across the plaza, bounces on the paving, rolls and detonates ~4 m ahead. Use --sequence 14 --interval 150.',
    player: { position: [0, null, 12.5], yaw: 0, pitch: -9 },
    ai: { brain: false, spawn: [] },
    setup(ctx) { ctx.services.player.setInvulnerable?.(true); },
    onFrame(ctx, f) {
      if (f !== 2) return;
      const THREE = window.__GAME__?.THREE;
      if (!THREE) return;
      // thrown from behind the bus stop on the left, lands on the open paving between the player and the fountain
      const W = ctx.services.world;
      const o = new THREE.Vector3(-9.5, W.groundHeight(-9.5, 3.5) + 1.7, 3.5);
      const tgt = new THREE.Vector3(-1.6, W.groundHeight(-1.6, 8.2) + 0.05, 8.2);
      ctx.services.combat.throwGrenadeAt({ from: o, target: tgt, source: 'ai:shot', team: 'enemy', speed: 11, lob: false, fuse: 2.2 });
    },
    hud: true,
    seed: 4,
    warmup: 20,
  },
  'combat-ingame-kill': {
    description: 'Full game in the plaza: the player fires an AR-7 burst (real weapons -> combat path) into a Crimson Vanguard soldier 12 m away: tracers, blood, hitmarkers, kill. Use --sequence 8 --interval 80.',
    player: { position: [0, null, 12.5], yaw: 0, pitch: -1.6 },
    ai: { brain: false, spawn: [{ position: [0, null, 0.5], yaw: 0, variant: 1, tint: 2, puppet: { weapon: 'aim', aimYaw: 0, aimPitch: 0 } }] },
    setup(ctx) { ctx.services.player.setInvulnerable?.(true); },
    input: [{ frame: 0, press: 'ads' }, { frame: 44, press: 'fire' }, { frame: 80, release: 'fire' }],
    hud: true,
    seed: 21,
    warmup: 50,
  },
  'combat-grenade-model': grenadeModelPreset({
    description: 'Frag grenade model close-up: armed (pin, ring, spoon) and thrown (spoon off) on a crate, golden-hour light.',
    camera: { position: [0.62, 0.72, -3.12], target: [0.38, 0.54, -3.58], hfov: 30, near: 0.01 },
  }),
  'combat-test': {
    description: 'Blank harness for tools/combat/test-ballistics.mjs (materials+world+player+combat only).',
    only: ['materials', 'world', 'player', 'combat'],
    seed: 1,
    warmup: 2,
    hud: false,
    camera: { position: [0, 2, 240], target: [0, 1, 220], hfov: 70 },
  },
  'combat-impacts-wall': impactsPreset({
    lastVolleyFrame: 280,
    camera: { position: [0.6, 1.55, 1.6], target: [0.0, 1.2, -5], hfov: 78 },
  }),
  'combat-impacts-close': impactsPreset({
    lastVolleyFrame: 280,
    camera: { position: [-1.1, 1.45, -2.2], target: [-1.9, 1.3, -5], hfov: 60 },
  }),
  'combat-penetration': penetrationPreset({
    debug: true,
    description: 'Ballistic debug view: rounds through plywood / plaster / sheet metal (with targets) stopping at concrete. Amber=flight, red=inside material, green=exit, magenta=body hit.',
    camera: { position: [7.5, 4.8, 0.5], target: [-0.4, 1.0, -9.5], hfov: 64 },
  }),
  'combat-target-hits': penetrationPreset({
    debug: false,
    warmup: 170,
    description: 'Front of the first cardboard target (behind 3 cm plywood) after the volley: through-and-through holes in the figure.',
    camera: { position: [0.9, 1.45, -3.6], target: [0.0, 1.3, -5.0], hfov: 40 },
  }),
  'combat-penetration-exit': penetrationPreset({
    debug: false,
    description: 'Exit side of penetrated plaster (12 cm) and the target behind it, 2 s after the volley (dust settled): exit holes, spall.',
    warmup: 170,
    camera: { position: [1.6, 1.55, -10.4], target: [-0.1, 1.35, -7.2], hfov: 46 },
  }),
  'combat-grenade-arc': grenadePreset({
    description: 'Frag grenade lobbed across the range: flight + tumble, spoon fly-off, bounce off a concrete barrier, roll, detonation with fragment spray. Use --sequence 14 --interval 150.',
    camera: { position: [-1.4, 1.5, 2.6], target: [0.4, 0.8, -5.6], hfov: 58 },
    fuse: 1.62,
    warmup: 3,
    from: [-3.2, 1.55, -4.9],
    vel: [4.6, 3.4, -0.35],
  }),
  'combat-grenade-aftermath': grenadePreset({
    description: 'Same throw, 2.5 s after detonation: scorch, fragment pits on the plaster wall / barrier / crate, settling smoke.',
    camera: { position: [-0.6, 1.45, 1.4], target: [0.9, 0.7, -6.4], hfov: 60 },
    fuse: 1.62,
    warmup: 3 + Math.round((1.62 + 2.5) * 60),
    from: [-3.2, 1.55, -4.9],
    vel: [4.6, 3.4, -0.35],
  }),
  'combat-grenade-arc-debug': grenadePreset({
    description: 'Same throw with the recorded trajectory drawn (debug), captured after it came to rest.',
    camera: { position: [0.4, 1.05, -1.2], target: [0.2, 0.75, -5.2], hfov: 62 },
    fuse: 30,
    debug: true,
    warmup: 150,
    from: [-3.2, 1.55, -4.9],
    vel: [4.6, 3.4, -0.35],
  }),
  'combat-grenade-closeup': grenadePreset({
    description: 'Close-up of a frag grenade that has rolled to rest on the range floor (model/material check).',
    camera: { position: [0.2, 0.3, -3.55], target: [0.42, 0.14, -4.1], hfov: 34, near: 0.01 },
    follow: { offset: [0.2, 0.1, 0.24], aim: [0, 0.004, 0] },
    fuse: 60,
    props: false,
    warmup: 150,
    from: [0.3, 0.3, -3.6],
    vel: [0.35, 0.2, -0.2],
  }),
};

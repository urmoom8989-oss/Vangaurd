/**
 * Shot presets owned by the POSTFX agent. Names must start with "postfx-".
 */
const VIEW = { position: [2, null, 14], yaw: 10, pitch: -2 };

/** Aim the player at the sun (so the sun lands in the upper part of the frame). */
function faceSun(ctx, { yawOffset = 0, pitchBelow = 14, position = [2, null, 14] } = {}) {
  const d = ctx.services.lighting.getSunDirection();
  const yaw = (Math.atan2(-d.x, -d.z) * 180) / Math.PI + yawOffset;
  const elev = (Math.asin(Math.max(-1, Math.min(1, d.y))) * 180) / Math.PI;
  ctx.services.player.setPose({ position, yaw, pitch: Math.max(-10, elev - pitchBelow) });
}

/**
 * Deterministic search for a standing spot with a view of the sun (world raycasts, fixed grid order).
 * mode 'clear': sun disc and a 2.5 deg ring around it unobstructed (lens flare / bloom).
 * mode 'edge' : sun disc visible but part of a 3-7 deg ring blocked by geometry (shafts through an edge).
 */
function findSunSpot(ctx, mode = 'clear') {
  const V = ctx.camera.position.constructor;
  const world = ctx.services.world;
  const sun = ctx.services.lighting.getSunDirection(new V());
  if (!world?.raycast || sun.y <= 0.02) return null;
  const up = new V(0, 1, 0);
  const side = new V().crossVectors(sun, up).normalize();
  const upv = new V().crossVectors(side, sun).normalize();
  const o = new V(), dir = new V();
  const clear = (deg, k, n) => {
    const a = (k / n) * Math.PI * 2, r = Math.tan((deg * Math.PI) / 180);
    dir.copy(sun).addScaledVector(side, Math.cos(a) * r).addScaledVector(upv, Math.sin(a) * r).normalize();
    return !world.raycast(o, dir, 400);
  };
  let best = null, bestScore = -1;
  for (let gz = -60; gz <= 60; gz += 4) {
    for (let gx = -60; gx <= 60; gx += 4) {
      const g = world.groundHeight(gx, gz, 2.5);
      if (!Number.isFinite(g) || g > 1.5 || g < -1) continue;
      o.set(gx, g + 1.62, gz);
      if (world.raycast(o, up, 30)) continue;                       // under a roof / inside
      if (!clear(0, 0, 1)) continue;
      let ring = 0;
      for (let k = 0; k < 12; k++) ring += clear(mode === 'clear' ? 2.5 : 5, k, 12) ? 1 : 0;
      let near = 0;                                                  // some structure in view (not open field)
      dir.set(sun.x, 0, sun.z).normalize();
      const h = world.raycast(o, dir, 60);
      if (h) near = h.distance;
      let score;
      if (mode === 'clear') score = ring === 12 ? 1 + (h ? Math.min(near, 40) / 40 : 0.5) : -1;
      else score = ring >= 3 && ring <= 9 ? 1 + (1 - Math.abs(ring - 6) / 6) : -1;
      if (score > bestScore) { bestScore = score; best = [gx, g, gz]; }
    }
  }
  return best;
}

function sunShot(mode, yawOffset, pitchBelow) {
  return (ctx) => {
    const spot = findSunSpot(ctx, mode) || [2, null, 14];
    faceSun(ctx, { yawOffset, pitchBelow, position: spot });
  };
}

const presets = {
  'postfx-gameplay': {
    description: 'Full gameplay frame (all systems) for judging the final image.',
    player: VIEW,
    weapon: { state: 'hip' },
    warmup: 60,
  },
  'postfx-compare-off': {
    description: 'Same view as postfx-compare-on with the postfx pipeline disabled (plain renderer + AgX).',
    player: VIEW,
    weapon: { state: 'hip' },
    warmup: 60,
    setup(ctx) { ctx.services.postfx.setEnabled?.(false); },
  },
  'postfx-compare-on': {
    description: 'Same view as postfx-compare-off with the full postfx pipeline.',
    player: VIEW,
    weapon: { state: 'hip' },
    warmup: 60,
  },
  'postfx-ads-dof': {
    description: 'Aiming down sights: weapon depth of field + ADS vignette.',
    player: VIEW,
    weapon: { state: 'ads' },
    warmup: 60,
  },
  'postfx-sun-flare': {
    description: 'Looking towards the low sun: sun shafts, lens flare, bloom.',
    player: VIEW,
    weapon: { state: 'hip' },
    warmup: 60,
    setup: sunShot('clear', -16, 8),
  },
  'postfx-sun-shafts': {
    description: 'Low sun peeking past geometry: light shafts through the edge, flare, bloom.',
    player: VIEW,
    weapon: { state: 'hip' },
    warmup: 60,
    setup: sunShot('edge', -6, 6),
  },
  'postfx-sun-flare-off': {
    description: 'postfx-sun-flare with the pipeline disabled (reference).',
    player: VIEW, weapon: { state: 'hip' }, warmup: 60,
    setup(ctx) { sunShot('clear', -16, 8)(ctx); ctx.services.postfx.setEnabled?.(false); },
  },
  'postfx-sun-flare-norays': {
    description: 'postfx-sun-flare without shafts/flare (isolates their contribution).',
    player: VIEW, weapon: { state: 'hip' }, warmup: 60,
    setup(ctx) { sunShot('clear', -16, 8)(ctx); ctx.services.postfx.setEffect('rays', false); ctx.services.postfx.setEffect('flare', false); },
  },
  'postfx-sun-rays-debug': {
    description: 'Shaft buffer only (debug view) at the postfx-sun-shafts view.',
    player: VIEW, weapon: { state: 'hip' }, warmup: 60, hud: false,
    setup(ctx) { sunShot('clear', -16, 8)(ctx); ctx.services.postfx.setDebugView?.('rays'); },
  },
  'postfx-sun-probe': {
    description: 'Diagnostics: logs (console.warn) the sun screen position/visibility at the sun-flare view.',
    player: VIEW, weapon: { state: 'hip' }, warmup: 60, hud: false,
    setup: sunShot('clear', -16, 8),
    input: [{ frame: 58, call: (ctx) => {
      const pf = ctx.services.postfx, pl = pf.composer;
      const buf = new Float32Array(4);
      try { ctx.renderer.readRenderTargetPixels(pl.sunVis, 0, 0, 1, 1, buf); } catch (e) { buf[0] = -1; }
      const lin = new Float32Array(4);
      const [u, v] = pf.stats.sunUV;
      try { ctx.renderer.readRenderTargetPixels(pl.linDepth, Math.floor(u * pl.halfSize.x), Math.floor(v * pl.halfSize.y), 1, 1, lin); } catch (e) { lin[0] = -1; }
      const d = ctx.services.lighting.getSunDirection();
      console.warn('[postfx-probe]', JSON.stringify({ stats: pf.stats, vis: buf[0], sunLum: buf[1], exposure: ctx.renderer.toneMappingExposure, depthAtSun: lin[0], far: ctx.camera.far, sun: d.toArray(), pos: ctx.camera.position.toArray() }));
    } }],
  },
  'postfx-damage-pulse': {
    description: 'Mid damage pulse on a low-health player (blood edges, CA, desaturation).',
    player: VIEW,
    weapon: { state: 'hip' },
    warmup: 60,
    input: [{ frame: 52, call: (ctx) => ctx.services.postfx.pulse('damage', 1, 0.8) }],
    setup(ctx) {
      const s = ctx.services.player.state;
      if (s) s.health = Math.round((s.maxHealth || 100) * 0.3);
    },
  },
  'postfx-damage-heavy': {
    description: 'Heavy hit on a near-dead player: full blood splatter on the lens.',
    player: VIEW,
    weapon: { state: 'hip' },
    warmup: 60,
    input: [{ frame: 56, call: (ctx) => ctx.services.postfx.pulse('damage', 1, 1.2) }],
    setup(ctx) {
      const s = ctx.services.player.state;
      if (s) s.health = Math.round((s.maxHealth || 100) * 0.1);
    },
  },
  'postfx-damage-light': {
    description: 'Light graze at full health (only the outermost splats).',
    player: VIEW,
    weapon: { state: 'hip' },
    warmup: 60,
    input: [{ frame: 50, call: (ctx) => ctx.services.postfx.pulse('damage', 0.45, 0.8) }],
  },
  'postfx-flashbang': {
    description: 'Flashbang ~1.2 s after detonation: fading white-out + burnt-in afterimage.',
    player: VIEW,
    weapon: { state: 'hip' },
    warmup: 90,
    input: [{ frame: 18, call: (ctx) => ctx.services.postfx.pulse('flashbang', 1, 4.5) }],
  },
  'postfx-explosion': {
    description: 'Explosion 8 m ahead: exposure punch, CA, radial blur, concussion double vision.',
    player: VIEW,
    weapon: { state: 'hip' },
    warmup: 60,
    input: [{
      frame: 50,
      call: (ctx) => {
        const p = ctx.camera.getWorldPosition(new ctx.camera.position.constructor());
        ctx.events.emit('combat:explosion', { position: p.set(p.x + 1, p.y - 1.4, p.z - 3), radius: 6 });
      },
    }],
  },
  'postfx-ao-debug': {
    description: 'AO buffer only (debug view) at the gameplay view.',
    player: VIEW,
    weapon: { state: 'hip' },
    warmup: 60,
    hud: false,
    setup(ctx) { ctx.services.postfx.setDebugView?.('ao'); },
  },
  'postfx-motion': {
    description: 'Fast camera turn for motion blur / TAA ghosting checks (use --sequence 6 --interval 33).',
    player: VIEW,
    weapon: { state: 'hip' },
    warmup: 40,
    input: [{ frame: 30, look: [60, 0] }, { frame: 31, look: [60, 0] }, { frame: 32, look: [60, 0] }, { frame: 33, look: [60, 0] },
      { frame: 34, look: [60, 0] }, { frame: 35, look: [60, 0] }, { frame: 36, look: [60, 0] }, { frame: 37, look: [60, 0] },
      { frame: 38, look: [60, 0] }, { frame: 39, look: [60, 0] }, { frame: 40, look: [60, 0] }, { frame: 41, look: [60, 0] },
      { frame: 42, look: [60, 0] }, { frame: 43, look: [60, 0] }, { frame: 44, look: [60, 0] }, { frame: 45, look: [60, 0] }],
  },
  'postfx-motion-nomb': {
    description: 'postfx-motion without motion blur (TAA-only ghosting check).',
    player: VIEW, weapon: { state: 'hip' }, warmup: 40,
    input: Array.from({ length: 16 }, (_, i) => ({ frame: 30 + i, look: [60, 0] })),
    setup(ctx) { ctx.services.postfx.setEffect('motionBlur', false); },
  },
  'postfx-motion-noaa': {
    description: 'postfx-motion without AA and MB (raw frames).',
    player: VIEW, weapon: { state: 'hip' }, warmup: 40,
    input: Array.from({ length: 16 }, (_, i) => ({ frame: 30 + i, look: [60, 0] })),
    setup(ctx) { ctx.services.postfx.setEffect('motionBlur', false); ctx.services.postfx.setEffect('aa', false); },
  },
  'postfx-quality-low': {
    description: 'Gameplay view at the low tier (SMAA, no AO / shafts).',
    player: VIEW,
    weapon: { state: 'hip' },
    warmup: 60,
    settings: { graphics: { quality: 'low' } },
  },
  'postfx-quality-medium': {
    description: 'Gameplay view at the medium tier (SMAA high, AO).',
    player: VIEW,
    weapon: { state: 'hip' },
    warmup: 60,
    settings: { graphics: { quality: 'medium' } },
  },
  'postfx-quality-ultra': {
    description: 'Gameplay view at the ultra tier.',
    player: VIEW,
    weapon: { state: 'hip' },
    warmup: 60,
    settings: { graphics: { quality: 'ultra' } },
  },
};

// ---------------------------------------------------------------- grade experiments (temporary)
const GRADE_VARIANTS = {
  old: { 'look.power': [1.16, 1.16, 1.16], 'look.saturation': 1.12, 'look.slope': [1.0, 0.99, 0.96], 'grade.contrast': 1.03, 'grade.saturation': 0.94 },
  aces: { toneMapper: 'aces', 'grade.saturation': 0.9 },
  ga: { 'grade.gain': [1.12, 1.09, 1.04], 'grade.contrast': 1.04 },
  gb: { exposureBias: 1.2, 'grade.contrast': 1.05 },
  gc: { 'grade.gain': [1.12, 1.09, 1.04], 'grade.contrast': 1.05, 'grade.lift': [0.0, 0.004, 0.008], 'grade.saturation': 1.0 },
};
for (const [k, v] of Object.entries(GRADE_VARIANTS)) {
  presets[`postfx-grade-${k}`] = {
    description: `grade experiment ${k}`, player: VIEW, weapon: { state: 'hip' }, warmup: 60,
    setup(ctx) { for (const [p, val] of Object.entries(v)) ctx.services.postfx.setParam(p, val); },
  };
}

// ---------------------------------------------------------------- perf presets (node tools/perf.mjs <name>)
const PERF_INPUT = [
  { frame: 0, move: [0, 1] }, { frame: 0, press: 'sprint' }, { frame: 90, release: 'sprint' }, { frame: 90, move: [1, 0] },
  { frame: 150, move: [0, -1] }, { frame: 210, move: [-1, 0] }, { frame: 0, look: [30, 0] }, { frame: 60, look: [-60, 5] },
  { frame: 120, look: [80, -5] }, { frame: 180, look: [-50, 0] }, { frame: 240, press: 'fire' }, { frame: 260, release: 'fire' },
];
function perfPreset(description, setup) {
  return { description, player: { position: [0, null, 10], yaw: 0, pitch: 0 }, input: PERF_INPUT, inputLoop: 280, warmup: 30, setup };
}
const perfSetups = {
  'postfx-perf-off': ['postfx disabled (plain renderer)', (ctx) => ctx.services.postfx.setEnabled?.(false)],
  'postfx-perf-on': ['full postfx pipeline (default quality)', null],
  'postfx-perf-noao': ['postfx without AO', (ctx) => ctx.services.postfx.setEffect('ao', false)],
  'postfx-perf-notaa': ['postfx without AA', (ctx) => ctx.services.postfx.setEffect('aa', false)],
  'postfx-perf-nobloom': ['postfx without bloom', (ctx) => ctx.services.postfx.setEffect('bloom', false)],
  'postfx-perf-nosun': ['postfx without shafts/flare', (ctx) => { ctx.services.postfx.setEffect('rays', false); ctx.services.postfx.setEffect('flare', false); }],
  'postfx-perf-min': ['postfx with every optional pass off', (ctx) => {
    for (const k of ['ao', 'aa', 'bloom', 'rays', 'flare', 'dof', 'motionBlur', 'sharpen', 'ca']) ctx.services.postfx.setEffect(k, false);
  }],
  'postfx-perf-ultra': ['postfx at ultra', (ctx) => ctx.services.postfx.setQuality('ultra')],
  'postfx-perf-low': ['postfx at low', (ctx) => ctx.services.postfx.setQuality('low')],
};
for (const [name, [desc, setup]] of Object.entries(perfSetups)) presets[name] = perfPreset(`Perf: ${desc}.`, setup || undefined);

export default presets;

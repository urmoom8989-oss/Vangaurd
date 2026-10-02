import * as THREE from 'three';
import { Pipeline } from './Pipeline.js';
import { QUALITY, QUALITY_LEVELS } from './quality.js';
import { createNoiseTexture } from './grain.js';
import { createBloodTexture } from './blood.js';
import { defaultParams, GRADE_PRESETS } from './params.js';

/**
 * postfx — the render pipeline of Opus of Duty. Owner: postfx agent.
 *
 * services.postfx (contract, see ARCHITECTURE.md §5):
 *   render(dt, t) -> boolean            draws the whole frame (returns true)
 *   setADS(0..1)                         aim blend: weapon DOF + slightly stronger vignette
 *   pulse(kind, intensity=1, duration?)  'damage' | 'flashbang' | 'explosion' | 'hitmarker' | 'concussion'
 *                                        (+ 'suppression', 'heal'); max-combined, never stacks to silly values
 *   setEffect(name, enabled)             see EFFECT_NAMES
 *   setQuality('low'|'medium'|'high'|'ultra')
 *   composer                             the Pipeline instance (not a pmndrs EffectComposer; see Pipeline.js)
 * Extensions (optional-chain them: services.postfx.x?.()):
 *   setEnabled(bool) / isEnabled()       false -> core renders plainly (compare shots)
 *   getQuality(); getEffects() -> {name: bool}
 *   setParam(path, value); getParam(path); params   live tuning ('bloomIntensity', 'grade.saturation', ...)
 *   setGradePreset(name); gradePresets   'vardanek' (default), 'neutral', 'bleach', 'night'
 *   setViewmodelFov(vfovDeg | null)      render the viewmodel with its own FOV (CoD-style), null = camera fov
 *   setDebugView('none'|'ao'|'depth'|'bloom'|'rays'|'coc'|'hdr')
 *   resetHistory()                       call on camera cuts (teleports are auto-detected)
 *   clearPulses()
 *   stats                                {sunFactor, sunUV, motionBlurActive, dofActive, raysActive, aa}
 * Reacts to events: 'player:damaged' (damage pulse), 'combat:explosion' (explosion/concussion by
 * distance), 'player:died' (death fade), 'resize', 'settings:changed' (graphics.quality,
 * graphics.motionBlur, graphics.filmGrain, graphics.toneMapping, postfx.*).
 */

const EFFECT_ALIASES = {
  aa: 'aa', antialiasing: 'aa', taa: 'aa', smaa: 'aa',
  ao: 'ao', ssao: 'ao', gtao: 'ao', n8ao: 'ao',
  bloom: 'bloom',
  godrays: 'rays', godRays: 'rays', rays: 'rays', lightShafts: 'rays',
  flare: 'flare', lensFlare: 'flare',
  dof: 'dof', depthOfField: 'dof',
  motionBlur: 'motionBlur', motionblur: 'motionBlur',
  grain: 'grain', filmGrain: 'grain', noise: 'grain',
  vignette: 'vignette',
  ca: 'ca', chromaticAberration: 'ca',
  sharpen: 'sharpen', cas: 'sharpen',
  grade: 'grade', colorGrading: 'grade', grading: 'grade', lut: 'grade',
};

const PULSE_DEFAULTS = {
  damage: 0.7,
  flashbang: 4.5,
  explosion: 1.4,
  hitmarker: 0.14,
  concussion: 5.0,
  suppression: 1.6,
  heal: 0.8,
};

export default function createSystem(ctx) {
  const { renderer, settings, events } = ctx;
  let pipeline = null;
  let enabled = true;
  let qualityName = 'high';
  let originalToneMapping = renderer.toneMapping;
  const params = defaultParams();
  const userFlags = {};        // effect name -> bool (explicit setEffect overrides)
  let adsValue = 0;
  let adsFrame = -10;
  let frameNo = 0;
  let deathT = 0;
  let lastT = 0;
  const pulses = {};
  for (const k of Object.keys(PULSE_DEFAULTS)) pulses[k] = { start: -1e9, dur: 1, amp: 0 };
  const _camPos = new THREE.Vector3();
  const offs = [];

  // ------------------------------------------------------------------ shader warm-up
  // The scene is drawn into pipeline.sceneRT (linear output), not the canvas (sRGB). three keys programs on the
  // output colour space, so a plain renderer.compileAsync(scene, camera) (ShotController) warmed the WRONG
  // variants and every scene material recompiled synchronously on frame 1 (~70 programs, ~18 s freeze on
  // ANGLE/D3D11). compileAsync is wrapped to compile against sceneRT, plus the postfx pass materials.
  // Outside shot mode nothing precompiles, so the first render() kicks a warm-up and skips frames until done.
  let warm = 'no'; // 'no' | 'pending' | 'done'
  let origCompileAsync = null;
  function passMaterials() {
    const out = new Set();
    const visit = (v, depth) => {
      if (!v || typeof v !== 'object' || depth > 2) return;
      if (v.isShaderMaterial) { out.add(v); return; }
      if (v.isTexture || v.isObject3D || v.isWebGLRenderTarget || v === renderer || v === ctx) return;
      for (const k of Object.keys(v)) visit(v[k], depth + 1);
    };
    if (pipeline) for (const k of Object.keys(pipeline)) visit(pipeline[k], 1);
    return [...out];
  }
  function compileScene(scene, camera, targetScene) {
    const prev = renderer.getRenderTarget();
    const promises = [];
    try {
      renderer.setRenderTarget(pipeline.sceneRT);
      promises.push(origCompileAsync.call(renderer, scene, camera, targetScene));
      // postfx passes: final goes to the canvas, the rest to linear targets
      const group = new THREE.Group();
      const finals = new THREE.Group();
      // same geometry as the runtime quad: attribute layout is part of the program key
      const quadGeo = pipeline.quad?.mesh?.geometry;
      const geo = quadGeo || new THREE.PlaneGeometry(2, 2);
      for (const m of passMaterials()) {
        const mesh = new THREE.Mesh(geo, m);
        mesh.frustumCulled = false;
        (/final/i.test(m.name) ? finals : group).add(mesh);
      }
      promises.push(origCompileAsync.call(renderer, group, pipeline.quad?.camera || camera));
      renderer.setRenderTarget(null);
      promises.push(origCompileAsync.call(renderer, finals, pipeline.quad?.camera || camera));
      if (!quadGeo) Promise.allSettled(promises).then(() => geo.dispose());
    } finally {
      renderer.setRenderTarget(prev);
    }
    const settle = () => { warm = 'done'; };
    return Promise.all(promises).then(settle, (e) => { settle(); throw e; });
  }
  function installCompileHook() {
    if (origCompileAsync) return;
    origCompileAsync = renderer.compileAsync;
    renderer.compileAsync = function (scene, camera, targetScene = null) {
      if (!enabled || !pipeline) return origCompileAsync.call(renderer, scene, camera, targetScene);
      warm = 'pending';
      return compileScene(scene, camera, targetScene);
    };
    offs.push(() => { renderer.compileAsync = origCompileAsync; origCompileAsync = null; });
  }
  function startWarmup(camera) {
    warm = 'pending';
    const done = () => { warm = 'done'; };
    let p;
    try { p = renderer.compileAsync(ctx.scene, camera); } catch (e) { done(); return; }
    const timeout = new Promise((r) => setTimeout(r, 20000));
    ctx.assets.track(Promise.race([p, timeout]).then(done, done), 'postfx:warmup');
  }

  // ------------------------------------------------------------------ pulses
  function envelope(kind, x) {
    // x = normalised age 0..1
    if (x < 0 || x >= 1) return 0;
    switch (kind) {
      case 'damage': return x < 0.06 ? x / 0.06 : Math.pow(1 - (x - 0.06) / 0.94, 1.6);
      case 'flashbang': return x < 0.02 ? x / 0.02 : 1 - x;
      case 'explosion': return x < 0.04 ? x / 0.04 : Math.pow(1 - (x - 0.04) / 0.96, 2.2);
      case 'hitmarker': return 1 - x;
      case 'concussion': return x < 0.05 ? x / 0.05 : Math.pow(1 - (x - 0.05) / 0.95, 1.3);
      case 'suppression': return x < 0.1 ? x / 0.1 : Math.pow(1 - (x - 0.1) / 0.9, 1.5);
      case 'heal': return Math.sin(x * Math.PI);
      default: return 1 - x;
    }
  }
  function pulseValue(kind, t) {
    const p = pulses[kind];
    if (!p || p.amp <= 0) return 0;
    return p.amp * envelope(kind, (t - p.start) / p.dur);
  }
  function pulse(kind, intensity = 1, duration) {
    const k = kind === 'flash' ? 'flashbang' : kind;
    const p = pulses[k];
    if (!p) return;
    const t = ctx.time.t;
    const amp = Math.max(0, Math.min(1.5, Number(intensity) || 0));
    const dur = Math.max(0.03, Number(duration) || PULSE_DEFAULTS[k]);
    const cur = pulseValue(k, t);
    // max-combine: a weaker hit during a strong one never shortens/weakens it
    if (amp < cur * 0.9 && (t - p.start) / p.dur < 0.5) return;
    p.start = t; p.dur = dur; p.amp = amp;
    if (k === 'flashbang' && pipeline) pipeline.captureAfterimage = true;
  }

  function updateState(dt, t) {
    const S = pipeline.state;
    const svc = ctx.services;
    const ads = adsFrame >= frameNo - 1 ? adsValue : (svc.weapons?.state?.ads ?? 0);
    S.ads = Math.max(0, Math.min(1, Number(ads) || 0));

    const dmg = pulseValue('damage', t);
    const flash = pulseValue('flashbang', t);
    const expl = pulseValue('explosion', t);
    const hit = pulseValue('hitmarker', t);
    const conc = pulseValue('concussion', t);
    const supp = pulseValue('suppression', t);
    const heal = pulseValue('heal', t);

    // low health (persistent, heartbeat-modulated), death fade
    const ps = svc.player?.state;
    let low = 0;
    if (ps && ps.maxHealth > 0 && ps.alive !== false) {
      const ratio = ps.health / ps.maxHealth;
      low = Math.max(0, Math.min(1, (0.5 - ratio) / 0.4));
      if (low > 0) {
        const beat = 0.5 + 0.5 * Math.cos(t * 2 * Math.PI * 1.25);
        low *= 0.8 + 0.2 * beat * beat;
      }
    }
    const alive = ps ? ps.alive !== false : true;
    deathT = alive ? Math.max(0, deathT - dt * 2.5) : Math.min(1, deathT + dt / 1.6);

    const flashWhite = flash > 0 ? Math.min(1, Math.pow(Math.max(0, (flash - 0.35) / 0.65), 0.6)) : 0;
    S.damage = Math.min(1, dmg * 0.85);
    S.lowHealth = low * 0.6 * (1 - heal);
    S.flash = flashWhite;
    S.after = flash > 0 ? Math.min(1, flash * 1.2) * (1 - flashWhite * 0.5) : 0;
    S.radial = Math.min(1, expl * 0.6 + conc * 0.35 + flash * 0.25);
    S.double = conc * 0.9;
    S.desat = Math.min(1, dmg * 0.25 + expl * 0.2 + conc * 0.45 + flash * 0.4 + supp * 0.25 + deathT * 0.85 + low * 0.3);
    S.darken = Math.min(0.8, conc * 0.25 + supp * 0.18 + deathT * 0.35);
    S.caExtra = expl * 5 + conc * 3 + hit * 0.6 + supp * 1.5 + dmg * 1.5;
    S.exposureMul = 1 + expl * 0.45 + flash * 0.3;
    S.blackout = 0;
    lastT = t;
  }

  // ------------------------------------------------------------------ settings / quality
  function resolveFlags() {
    if (!pipeline) return;
    const F = pipeline.flags;
    const g = settings.data.graphics || {};
    for (const k of Object.keys(F)) F[k] = true;
    F.motionBlur = g.motionBlur !== false;
    F.grain = g.filmGrain !== false;
    for (const [k, v] of Object.entries(userFlags)) F[k] = v;
  }

  function applyQuality(level) {
    if (!QUALITY[level]) level = 'high';
    qualityName = level;
    pipeline?.setQuality(QUALITY[level]);
  }

  function applySettings() {
    const g = settings.data.graphics || {};
    applyQuality(g.quality || 'high');
    const tm = g.toneMapping;
    if (tm === 'agx' || tm === 'aces' || tm === 'neutral' || tm === 'none') params.toneMapper = tm;
    const own = settings.data.postfx || {};
    if (own.aa) params.aa = own.aa;
    if (typeof own.sharpen === 'number') params.sharpen = own.sharpen;
    if (own.chromaticAberration === false) userFlags.ca = false;
    if (own.weaponDof === false) userFlags.dof = false;
    resolveFlags();
  }

  function setEnabled(on) {
    enabled = !!on;
    if (enabled) {
      renderer.toneMapping = THREE.NoToneMapping;
      pipeline?.resetHistory();
    } else {
      renderer.toneMapping = originalToneMapping;
    }
  }

  function canUseFastRender() {
    if (!enabled || !pipeline || qualityName !== 'low' || Object.keys(userFlags).length > 0 || pipeline.captureAfterimage) return false;
    const s = pipeline.state;
    return !(s.damage > 0.001 || s.lowHealth > 0.001 || s.flash > 0.001 || s.after > 0.001 ||
      s.radial > 0.001 || s.double > 0.001 || s.desat > 0.001 || s.darken > 0.001 || s.caExtra > 0.001 ||
      Math.abs((s.exposureMul ?? 1) - 1) > 0.001);
  }

  function setPath(obj, path, value) {
    const parts = String(path).split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') return false;
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = value;
    return true;
  }
  function getPath(obj, path) {
    let o = obj;
    for (const p of String(path).split('.')) { if (o == null) return undefined; o = o[p]; }
    return o;
  }

  // ------------------------------------------------------------------ events
  function onDamaged(e) {
    const amt = Number(e?.amount) || 10;
    pulse('damage', Math.max(0.3, Math.min(1, amt / 35)), 0.55 + Math.min(0.5, amt / 80));
  }
  function onExplosion(e) {
    if (!e?.position) return;
    ctx.camera.getWorldPosition(_camPos);
    const radius = Math.max(1, Number(e.radius) || 6);
    const d = _camPos.distanceTo(e.position);
    const i = 1 - d / (radius * 3.5);
    if (i <= 0) return;
    pulse('explosion', Math.min(1, i * 1.3), 1.0 + i * 0.8);
    if (d < radius * 0.9) pulse('concussion', Math.min(1, (1 - d / (radius * 0.9)) * 0.9 + 0.2), 2.5 + i * 2.5);
  }
  function onSettings(e) {
    const p = e?.path || '';
    if (p.startsWith('graphics') || p.startsWith('postfx')) applySettings();
  }
  function onResize(e) {
    if (pipeline && e) pipeline.setSize(e.width * e.pixelRatio, e.height * e.pixelRatio);
  }

  // ------------------------------------------------------------------ service
  const api = {
    render(dt, t) {
      frameNo++;
      if (!enabled || !pipeline) return false;
      if (warm !== 'done') {
        if (warm === 'no' && !ctx.flags?.shotMode) startWarmup(ctx.camera);
        // skip drawing while programs compile in parallel (a black / boot-overlay frame instead of a freeze)
        if (warm === 'pending') return true;
      }
      if (renderer.toneMapping !== THREE.NoToneMapping) {
        originalToneMapping = renderer.toneMapping;
        renderer.toneMapping = THREE.NoToneMapping;
      }
      updateState(dt, t);
      if (canUseFastRender()) {
        // Low quality disables optional post passes. Render the combined scene once rather than
        // drawing separate world, viewmodel and effects passes followed by a fullscreen composite.
        renderer.setRenderTarget(null);
        renderer.autoClear = true;
        renderer.toneMapping = originalToneMapping;
        renderer.toneMappingExposure = settings.get('graphics.exposure', 1);
        renderer.render(ctx.scene, ctx.camera);
        api.stats.aa = 'none';
        return true;
      }
      const ok = pipeline.render(dt, t);
      api.stats.aa = pipeline.aaMode;
      return ok;
    },
    setADS(v) {
      adsValue = Math.max(0, Math.min(1, Number(v) || 0));
      adsFrame = frameNo;
    },
    pulse,
    setEffect(name, on) {
      if (name === 'all' || name === 'postfx' || name === 'enabled') { setEnabled(on); return; }
      const k = EFFECT_ALIASES[name] || name;
      if (pipeline && !(k in pipeline.flags)) { console.warn(`[system:postfx] unknown effect "${name}"`); return; }
      userFlags[k] = !!on;
      resolveFlags();
      if (k === 'aa') pipeline?.resetHistory();
    },
    setQuality(level) {
      applyQuality(level);
      resolveFlags();
    },
    composer: null,
    // ---- extensions
    setEnabled,
    isEnabled: () => enabled,
    getQuality: () => qualityName,
    qualityLevels: QUALITY_LEVELS,
    getEffects: () => ({ ...(pipeline?.flags || {}) }),
    isFastRenderMode: canUseFastRender,
    params,
    setParam(path, value) { return setPath(params, path, value); },
    getParam(path) { return getPath(params, path); },
    gradePresets: Object.keys(GRADE_PRESETS),
    setGradePreset(name) {
      const g = GRADE_PRESETS[name];
      if (!g) return false;
      params.look = JSON.parse(JSON.stringify(g.look));
      params.grade = JSON.parse(JSON.stringify(g.grade));
      return true;
    },
    setViewmodelFov(vfov) { if (pipeline) pipeline.viewmodelFov = vfov == null ? null : Number(vfov); },
    setDebugView(name) { params.debugView = name || 'none'; },
    resetHistory() { pipeline?.resetHistory(); },
    clearPulses() { for (const k of Object.keys(pulses)) pulses[k].amp = 0; deathT = 0; },
    stats: { sunFactor: 0, sunUV: [0, 0], motionBlurActive: false, dofActive: false, raysActive: false, aa: 'none' },
  };

  return {
    name: 'postfx',
    async init() {
      settings.registerDefaults('postfx', { aa: 'auto', sharpen: null, chromaticAberration: true, weaponDof: true });
      const noise = createNoiseTexture(ctx.rng.fork('postfx:noise'));
      offs.push(() => noise.dispose());
      const blood = createBloodTexture(ctx.rng.fork('postfx:blood'));
      offs.push(() => blood.dispose());
      pipeline = new Pipeline(ctx, { params, noiseTexture: noise, bloodTexture: blood });
      api.composer = pipeline;
      api.stats = pipeline.stats;
      api.stats.aa = 'none';
      applySettings();
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      pipeline.setSize(size.x, size.y);
      originalToneMapping = renderer.toneMapping;
      renderer.toneMapping = THREE.NoToneMapping;
      installCompileHook();

      const on = (ev, fn) => { events.on(ev, fn); offs.push(() => events.off(ev, fn)); };
      on('player:damaged', onDamaged);
      on('combat:explosion', onExplosion);
      on('settings:changed', onSettings);
      on('resize', onResize);
      // new content (match start, AI spawns, waves): re-warm in the background so fresh materials compile in
      // parallel instead of stalling a frame. Debounced; never skips frames.
      let rewarmTimer = 0;
      const rewarm = () => {
        if (warm !== 'done' || rewarmTimer) return;
        rewarmTimer = setTimeout(() => {
          rewarmTimer = 0;
          if (!pipeline || !enabled || !origCompileAsync) return;
          try { compileScene(ctx.scene, ctx.camera).catch(() => {}); } catch { /* best effort */ }
        }, 250);
      };
      offs.push(() => { clearTimeout(rewarmTimer); rewarmTimer = 0; });
      for (const ev of ['gamemode:start', 'gamemode:wave', 'gamemode:respawn', 'ai:spawn', 'hud:play']) on(ev, rewarm);

      const gui = ctx.debug.gui?.addFolder('postfx');
      if (gui) {
        gui.close();
        gui.add({ enabled: true }, 'enabled').onChange(setEnabled);
        gui.add({ quality: qualityName }, 'quality', QUALITY_LEVELS).onChange((v) => api.setQuality(v));
        gui.add(params, 'aa', ['auto', 'taa', 'smaa', 'none']).onChange(() => pipeline.resetHistory());
        gui.add(params, 'toneMapper', ['agx', 'aces', 'neutral', 'none']);
        gui.add(params, 'debugView', ['none', 'ao', 'depth', 'bloom', 'rays', 'coc', 'hdr']);
        gui.add(params, 'exposureBias', 0.25, 4, 0.01);
        for (const k of ['aoRadius', 'aoPower', 'aoRadiusVM', 'aoPowerVM', 'bloomIntensity', 'bloomThreshold', 'raysIntensity',
          'flareIntensity', 'chromaticAberration', 'vignette', 'grain', 'sharpen', 'motionBlur', 'dofVMCoc']) {
          gui.add(params, k, 0, k.startsWith('ao') && k.includes('Radius') ? 3 : (k === 'dofVMCoc' ? 12 : 3), 0.001);
        }
        const flags = gui.addFolder('effects');
        for (const k of Object.keys(pipeline.flags)) flags.add(pipeline.flags, k).onChange((v) => { userFlags[k] = v; });
        for (const kind of Object.keys(PULSE_DEFAULTS)) gui.add({ [kind]: () => pulse(kind, 1) }, kind);
      }
      ctx.services.provide('postfx', api);
    },
    dispose() {
      for (const off of offs) { try { off(); } catch { /* ignore */ } }
      offs.length = 0;
      pipeline?.dispose();
      pipeline = null;
      api.composer = null;
      renderer.toneMapping = originalToneMapping;
    },
  };
}

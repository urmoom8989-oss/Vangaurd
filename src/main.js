/**
 * Boot (core, FROZEN for subsystem agents). See ARCHITECTURE.md.
 *
 * URL parameters:
 *   ?shot=<preset>   deterministic screenshot mode (see src/shots/*.js)   ?shot=__list__  list presets
 *   ?only=a,b,c      load only these systems             ?seed=N       RNG seed
 *   ?warmup=N        override preset warmup frames        ?w=&h=        fixed render size (shot mode)
 *   ?perf=1          perf mode (real time, loop keeps running)   ?debug=1  lil-gui + diagnostics panel
 *   ?faults=audio:import,vfx:update,hud:init,postfx:render   inject failures (isolation regression tests)
 */
import * as THREE from 'three';
import { EventBus } from './core/EventBus.js';
import { Time } from './core/Time.js';
import { Rng } from './core/Rng.js';
import { Settings } from './core/Settings.js';
import { Input } from './core/Input.js';
import { Assets } from './core/Assets.js';
import { Engine } from './core/Engine.js';
import { Loop } from './core/Loop.js';
import { Perf } from './core/Perf.js';
import { SystemRunner } from './core/SystemRunner.js';
import { ShotController, nextFrame } from './core/ShotController.js';
import { createServiceRegistry } from './core/services.js';
import { createDiagnostics } from './core/diagnostics.js';
import { LAYERS, SURFACES, SYSTEM_ORDER } from './core/constants.js';
import { loadSystems } from './systems/registry.js';
import { findShotPreset, listShotPresets } from './shots/index.js';

const params = new URLSearchParams(location.search);
const intParam = (k) => {
  const v = params.get(k);
  return v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
};

window.__SHOT_READY__ = false;
window.__SHOT_FAILED__ = null;

// Never let the Vite error overlay cover the frame: a broken system is reported via
// [system:<name>] console errors / window.__SYSTEM_ERRORS__ / #core-diag instead.
new MutationObserver((muts) => {
  for (const m of muts) for (const n of m.addedNodes) if (n.nodeName === 'VITE-ERROR-OVERLAY') n.remove();
}).observe(document.documentElement, { childList: true, subtree: true });

function fail(msg, err) {
  console.error(`[core] ${msg}`, err || '');
  window.__SHOT_FAILED__ = msg + (err ? `: ${err?.message || err}` : '');
}

boot().catch((err) => fail('boot failed', err));

async function boot() {
  const shotName = params.get('shot');

  // ------------------------------------------------------------------ special modes
  if (shotName === '__list__') {
    window.__SHOT_LIST__ = await listShotPresets();
    window.__SHOT_READY__ = true;
    return;
  }

  let preset = null;
  let presetFile = null;
  if (shotName === '__audio__') {
    preset = { description: 'audio render harness', only: ['audio'], warmup: 1, hud: false };
  } else if (shotName) {
    const rec = await findShotPreset(shotName);
    if (!rec) {
      const { presets } = await listShotPresets();
      fail(`unknown shot preset "${shotName}". Available: ${presets.map((p) => p.name).join(', ')}`);
      return;
    }
    preset = rec.preset;
    presetFile = rec.file;
  }

  const shotMode = !!preset;
  const perfMode = params.get('perf') === '1';
  const debug = params.get('debug') === '1';
  const width = intParam('w') ?? (shotMode && preset.resolution ? preset.resolution[0] : null);
  const height = intParam('h') ?? (shotMode && preset.resolution ? preset.resolution[1] : null);

  // ------------------------------------------------------------------ core services
  const events = new EventBus();
  const settings = new Settings(events, { persist: !shotMode, overrides: preset?.settings || null });
  const { reportError } = createDiagnostics({ showPanel: !shotMode || debug });
  const engine = new Engine({
    container: document.getElementById('app'),
    settings,
    shotMode,
    width: shotMode ? width : null,
    height: shotMode ? height : null,
  });
  engine.resizeListeners.push((w, h, pixelRatio) => events.emit('resize', { width: w, height: h, pixelRatio }));
  events.on('settings:changed', ({ path }) => {
    if (path === 'graphics.renderScale' || path === 'graphics.maxPixelRatio') engine.resize();
  });

  const time = new Time();
  const rng = new Rng(intParam('seed') ?? preset?.seed ?? 1337);
  const input = new Input({ element: engine.renderer.domElement, events, settings, deterministic: shotMode });
  const assets = new Assets(engine.renderer);
  const perf = new Perf(engine.renderer, engine.rendererString, {
    capacity: perfMode ? 60000 : 600,
    autoPublish: !perfMode,
    measureGpu: perfMode || debug,
  });

  const hudRoot = document.getElementById('hud');
  const uiRoot = document.getElementById('ui');
  const bootOverlay = document.getElementById('boot-overlay');
  let bootOverlayEnabled = !shotMode;

  const ctx = {
    renderer: engine.renderer,
    scene: engine.scene,
    camera: engine.camera,
    events,
    input,
    time,
    settings,
    rng,
    assets,
    shot: preset ? { name: shotName, file: presetFile, ...preset } : null,
    services: null,
    // extras
    engine,
    perf,
    layers: LAYERS,
    surfaces: SURFACES,
    debug: { enabled: debug, gui: null },
    ui: {
      hudRoot,
      uiRoot,
      /** gamemode/hud may take over the "click to deploy" overlay by disabling it. */
      setBootOverlayEnabled(on) {
        bootOverlayEnabled = on;
        bootOverlay.classList.toggle('hidden', !on || input.locked);
      },
      requestPointerLock: () => input.lock(),
    },
    reportError,
    flags: { shotMode, perfMode, debug },
  };
  ctx.services = createServiceRegistry(ctx);

  if (shotMode && preset.hud === false) {
    hudRoot.style.display = 'none';
    uiRoot.style.display = 'none';
  }

  if (debug) {
    try {
      const { default: GUI } = await import('lil-gui');
      ctx.debug.gui = new GUI({ title: 'Opus of Duty (debug)' });
    } catch (e) {
      console.warn('[core] lil-gui unavailable', e);
    }
  }

  // ------------------------------------------------------------------ systems
  const onlyParam = params.get('only');
  const only = onlyParam ? onlyParam.split(',').map((s) => s.trim()).filter(Boolean) : preset?.only ?? null;
  const faults = new Set((params.get('faults') || '').split(',').map((s) => s.trim()).filter(Boolean));
  const records = await loadSystems(ctx, { only, reportError, faults });
  const runner = new SystemRunner(ctx, records, { reportError, initTimeoutMs: intParam('initTimeout') ?? 30000 });

  const shot = shotMode ? new ShotController(ctx, preset, { name: shotName, warmupOverride: intParam('warmup'), perfMode }) : null;
  const loop = new Loop({
    ctx,
    runner,
    perf,
    reportError,
    hooks: shot ? { beforeFrame: () => shot.beforeFrame(), afterLate: () => shot.afterLate() } : {},
  });
  if (shot) shot.configureTime(loop);

  window.__GAME__ = {
    ctx,
    engine,
    loop,
    runner,
    THREE,
    systems: () => runner.status(),
    /** Produce n deterministic frames then wait for presentation. */
    advanceFrames: async (n) => {
      await loop.advance(n);
      await nextFrame();
      await nextFrame();
    },
    /** Advance simulated time by ~ms (rounded to whole fixed steps, min 1 frame). */
    advanceMs: async (ms) => {
      const n = Math.max(1, Math.round(ms / (time.fixedStep * 1000)));
      await window.__GAME__.advanceFrames(n);
      return n;
    },
    pause: () => loop.setPaused(true),
    resume: () => loop.setPaused(false),
    perf: () => perf.publish(),
    resetPerf: () => perf.reset(),
    order: SYSTEM_ORDER,
  };

  // Audio harness hooks (tools/audio.mjs). Contract: see ARCHITECTURE.md.
  window.__listSounds = () => ctx.services.audio.list();
  window.__renderSound = async (name, opts = {}) => {
    const buf = await ctx.services.audio.renderOffline(name, opts);
    const channels = [];
    for (let c = 0; c < buf.numberOfChannels; c++) channels.push(floatsToBase64(buf.getChannelData(c)));
    return { name, sampleRate: buf.sampleRate, length: buf.length, duration: buf.duration, numberOfChannels: buf.numberOfChannels, channels };
  };

  await runner.initAll();
  if (faults.has('postfx:render')) {
    ctx.services.postfx.render = () => { throw new Error('[fault-injection] simulated render failure'); };
  }
  window.__SHOT_INFO__ = {
    name: shotName,
    file: presetFile ? `src/shots/${presetFile}.js` : null,
    only,
    seed: rng.seed,
    systems: runner.status(),
  };
  events.emit('core:ready', ctx);

  if (shot) {
    await shot.run(loop);
    window.__SHOT_INFO__.systems = runner.status();
    window.__SHOT_INFO__.t = time.t;
    window.__SHOT_INFO__.frame = time.frame;
    return;
  }

  // ------------------------------------------------------------------ interactive mode
  // Compile and draw representative map views before exposing the animated main-menu camera.
  // This moves first-use shader compilation and world upload cost off the menu's active frames.
  try { await ctx.services.hud.prepareStartup?.(); }
  catch (e) { console.warn('[core] startup map warmup failed; continuing to menu', e); }
  loop.start();
  bootOverlay.classList.toggle('hidden', !bootOverlayEnabled);
  const deploy = () => {
    input.lock();
    events.emit('core:user-gesture');
    try { ctx.services.audio.resume(); } catch { /* ignore */ }
  };
  bootOverlay.addEventListener('click', deploy);
  engine.renderer.domElement.addEventListener('click', () => { if (!input.locked) deploy(); });
  events.on('input:lock', ({ locked }) => bootOverlay.classList.toggle('hidden', !bootOverlayEnabled || locked));
  window.addEventListener('pagehide', () => { runner.disposeAll(); assets.dispose(); });
}

function floatsToBase64(f32) {
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

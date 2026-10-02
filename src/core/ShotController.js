import * as THREE from 'three';
import { hfovToVfov, settingsFovToVfov, DEG, LAYERS } from './constants.js';

/**
 * ShotController (core, frozen) — applies a shot preset deterministically and signals readiness.
 * See ARCHITECTURE.md "Shot presets" for the schema. Summary:
 *
 *  {
 *    description: string,
 *    only: ['materials','lighting','world'],   // systems to load (default: all)
 *    seed: 1337,
 *    t: number,              // sim time (s) at the captured frame (default: (warmup+1)/60)
 *    freeze: false,          // true => dt = 0 for every frame (fully frozen)
 *    warmup: 30,             // frames simulated before the captured frame
 *    resolution: [1920,1080],
 *    settings: {...},        // deep-merged over DEFAULT_SETTINGS
 *    hud: true,              // false hides #hud and #ui
 *    camera: { position:[x,y,z], target:[x,y,z], vfov?:deg, hfov?:deg(16:9), near?, far?, viewmodel?:false },
 *            // hard override, applied after lateUpdate every frame; hides LAYERS.VIEWMODEL unless viewmodel:true
 *    player: { position:[x,y,z], yaw:deg, pitch:deg, stance:'stand'|'crouch'|'prone' },     // consumed by player system
 *    weapon: { id:'rifle', state:'hip'|'ads'|'sprint'|'reload'|'fire'|'inspect'|'equip', progress:0..1 }, // consumed by weapons
 *    input: [ {frame:0, press:'fire'}, {frame:5, release:'fire'}, {frame:2, tap:'reload'},
 *             {frame:0, look:[dx,dy]}, {frame:0, move:[x,y]} , {frame:0, move:null} ],
 *    inputLoop: 0,           // >0: repeat the input script every N frames (perf runs)
 *    setup: async (ctx) => {},          // after all systems init, before warmup
 *    onFrame: (ctx, frameIndex) => {},  // every frame, before fixedUpdate
 *  }
 */
export class ShotController {
  constructor(ctx, preset, { name, warmupOverride = null, perfMode = false }) {
    this.ctx = ctx;
    this.preset = preset;
    this.name = name;
    this.perfMode = perfMode;
    this.warmup = Math.max(0, warmupOverride ?? preset.warmup ?? 30);
    this.frameIndex = 0;
    this.ready = false;
    this._events = expandInput(preset.input || []);
    this._loop = Math.max(0, preset.inputLoop || 0);
    this._camPos = new THREE.Vector3();
    this._camTarget = new THREE.Vector3();
  }

  /** Configure time before any system runs. */
  configureTime(loop) {
    const { time } = this.ctx;
    if (this.perfMode) {
      time.deterministic = false;
      return;
    }
    time.deterministic = true;
    const step = time.fixedStep;
    const T = this.preset.t ?? (this.warmup + 1) * step;
    if (this.preset.freeze) {
      time.setFrozen(true, T);
    } else {
      loop.setDeterministicStart(T - (this.warmup + 1) * step);
    }
  }

  beforeFrame() {
    const f = this.frameIndex++;
    const local = this._loop > 0 ? f % this._loop : f;
    const input = this.ctx.input;
    for (const e of this._events) {
      if (e.frame !== local) continue;
      if (e.press) input.inject(e.press, true);
      else if (e.release) input.inject(e.release, false);
      else if (e.look) input.injectLook(e.look[0], e.look[1]);
      else if ('move' in e) (e.move ? input.injectMove(e.move[0], e.move[1]) : input.injectMove(null));
      else if (typeof e.call === 'function') e.call(this.ctx, f);
    }
    if (typeof this.preset.onFrame === 'function') this.preset.onFrame(this.ctx, f);
  }

  afterLate() {
    const c = this.preset.camera;
    if (!c) return;
    const cam = this.ctx.camera;
    if (cam.parent && cam.parent !== this.ctx.scene) {
      // camera must be in world space for the override
      this.ctx.scene.attach(cam);
    }
    if (c.viewmodel !== true) cam.layers.disable(LAYERS.VIEWMODEL);
    if (c.position) cam.position.fromArray(c.position);
    if (c.target) cam.lookAt(this._camTarget.fromArray(c.target));
    else if (c.yaw !== undefined || c.pitch !== undefined) cam.rotation.set((c.pitch || 0) * DEG, (c.yaw || 0) * DEG, 0, 'YXZ');
    let dirty = false;
    const vfov = c.vfov ?? (c.hfov !== undefined ? settingsFovToVfov(c.hfov) : undefined);
    if (vfov !== undefined && cam.fov !== vfov) { cam.fov = vfov; dirty = true; }
    if (c.near !== undefined && cam.near !== c.near) { cam.near = c.near; dirty = true; }
    if (c.far !== undefined && cam.far !== c.far) { cam.far = c.far; dirty = true; }
    if (dirty) cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }

  async run(loop) {
    const { ctx } = this;
    if (typeof this.preset.setup === 'function') {
      await ctx.assets.track(Promise.resolve().then(() => this.preset.setup(ctx)), `shot:${this.name}:setup`);
    }
    await ctx.assets.whenIdle();
    // Pre-compile shaders so warmup frames are not spent compiling.
    try {
      this.afterLate();
      await ctx.renderer.compileAsync(ctx.scene, ctx.camera);
    } catch (e) {
      console.warn('[shot] compileAsync failed (continuing):', e);
    }
    await ctx.assets.whenIdle();

    if (this.perfMode) {
      loop.start();
      // let things settle for a moment, then reset stats
      await loop.advance(Math.max(this.warmup, 30));
      ctx.perf.reset();
      this.ready = true;
      window.__SHOT_READY__ = true;
      return;
    }

    loop.setPaused(true);
    loop.start();
    await loop.advance(this.warmup + 1);
    // Anything that became pending during warmup (lazy loads) → wait and redraw the final frame
    // (same simulation state, no time advance).
    if (ctx.assets.pending.size > 0) {
      console.warn('[shot] assets were still loading after warmup; waiting and redrawing (consider more warmup frames)');
      await ctx.assets.whenIdle();
      loop.redraw();
    }
    await nextFrame();
    await nextFrame();
    ctx.perf.publish();
    this.ready = true;
    window.__SHOT_READY__ = true;
  }
}

function expandInput(list) {
  const out = [];
  for (const e of list) {
    if (e.tap) {
      out.push({ frame: e.frame, press: e.tap });
      out.push({ frame: e.frame + (e.hold ?? 1), release: e.tap });
    } else out.push(e);
  }
  return out;
}

export function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

export { hfovToVfov };

/**
 * Loop (core, frozen) — rAF driven frame loop with a fixed-timestep simulation.
 *
 * Per render frame:
 *   perf.begin → hooks.beforeFrame(frameIndex) → fixedUpdate × N (fixed 1/60 steps; exactly one per
 *   frame in deterministic mode, zero when frozen) → update(dt, t) → lateUpdate(dt, t) →
 *   hooks.afterLate() (shot camera override) → render (services.postfx.render(dt) or plain
 *   renderer.render) → input.endFrame() → perf.end
 *
 * Deterministic mode (shots): t = t0 + frame * fixedStep exactly, independent of wall clock.
 * Paused mode: frames are only produced via advance(n) (shot harness sequences) — the canvas keeps
 * showing the last frame so screenshots are stable.
 */
export class Loop {
  constructor({ ctx, runner, perf, reportError, hooks = {} }) {
    this.ctx = ctx;
    this.runner = runner;
    this.perf = perf;
    this.reportError = reportError;
    this.hooks = hooks;
    this.running = false;
    this.paused = false;
    this._budget = 0;
    this._budgetWaiters = [];
    this._acc = 0;
    this._last = -1;
    this._timer = null;
    this._lastTickStart = -1;
    this._t0 = 0;
    this._detFrames = 0;
    this._renderFailed = false;
    this._tick = this._tick.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._schedule();
  }

  stop() {
    this.running = false;
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = null;
  }

  setDeterministicStart(t0) {
    this._t0 = t0;
    this._detFrames = 0;
    this.ctx.time.t = t0;
  }

  /** Pause normal frame production (frames only via advance()). */
  setPaused(p) {
    this.paused = p;
    this._last = -1;
    if (!p) this._schedule();
  }

  /** Produce exactly n frames (even while paused). Resolves after the last one is presented. */
  advance(n) {
    n = Math.max(0, Math.floor(n));
    if (n === 0) return Promise.resolve();
    this._budget += n;
    const promise = new Promise((resolve) => this._budgetWaiters.push({ target: this.ctx.time.frame + this._budget, resolve }));
    this._schedule();
    return promise;
  }

  /** Schedule independently of display refresh; a nonzero fpsCap is an explicit software limit. */
  _schedule() {
    if (!this.running || this._timer !== null || (this.paused && this._budget <= 0)) return;
    const cap = this.paused ? 0 : Math.max(0, Number(this.ctx.settings.get('graphics.fpsCap', 0)) || 0);
    const interval = cap > 0 ? 1000 / cap : 0;
    const elapsed = this._lastTickStart < 0 ? interval : performance.now() - this._lastTickStart;
    const delay = Math.max(0, interval - elapsed);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._tick(performance.now());
    }, delay);
  }

  _tick(now) {
    if (!this.running) return;
    if (this.paused && this._budget <= 0) {
      this._last = -1;
      this._resolveWaiters();
      return;
    }
    this._lastTickStart = now;
    if (this._budget > 0) this._budget--;
    this.frame(now);
    this._schedule();
  }

  _resolveWaiters() {
    if (!this._budgetWaiters.length) return;
    const f = this.ctx.time.frame;
    const keep = [];
    for (const w of this._budgetWaiters) (f >= w.target && this._budget <= 0 ? w.resolve() : keep.push(w));
    this._budgetWaiters = keep;
  }

  /** Run one full frame synchronously. */
  frame(now = performance.now()) {
    const { time, input } = this.ctx;
    this.perf.beginFrame(now);

    // ---- time
    const step = time.fixedStep;
    let dt;
    if (time.frozen) dt = 0;
    else if (time.deterministic) dt = step * time.scale;
    else {
      const raw = this._last < 0 ? step : (now - this._last) / 1000;
      dt = Math.min(Math.max(raw, 0), time.maxDelta) * time.scale;
    }
    this._last = now;
    time.dt = dt;
    time.real = now / 1000;

    try { this.hooks.beforeFrame?.(time.frame); } catch (e) { this.reportError('core', 'beforeFrame', e); }

    // ---- fixed steps
    if (time.deterministic && !time.frozen) {
      this.runner.fixedUpdate(step * time.scale, time.t + dt);
      time.alpha = 0;
    } else if (!time.frozen) {
      this._acc += dt;
      let n = 0;
      let ft = time.t;
      while (this._acc >= step && n < 5) {
        ft += step;
        this.runner.fixedUpdate(step, ft);
        this._acc -= step;
        n++;
      }
      if (n === 5) this._acc = 0; // spiral-of-death guard
      time.alpha = this._acc / step;
    }

    // ---- advance time
    if (time.deterministic && !time.frozen) {
      this._detFrames++;
      time.t = this._t0 + this._detFrames * step * time.scale;
    } else if (!time.frozen) {
      time.t += dt;
    }

    // ---- variable updates
    this.runner.update(dt, time.t);
    this.runner.lateUpdate(dt, time.t);
    try { this.hooks.afterLate?.(time.frame); } catch (e) { this.reportError('core', 'afterLate', e); }

    this.render(dt, time.t);

    input.endFrame();
    time.frame++;
    this.perf.endFrame();
    try { this.hooks.afterFrame?.(time.frame); } catch (e) { this.reportError('core', 'afterFrame', e); }
    this._resolveWaiters();
  }

  /** Render the current state without simulating (used to redraw after late asset loads). */
  redraw() {
    this.render(0, this.ctx.time.t);
  }

  render(dt, t) {
    const { services, renderer, scene, camera } = this.ctx;
    this.perf.beginGpu();
    let rendered = false;
    try {
      rendered = services.postfx.render(dt, t) === true;
    } catch (err) {
      this.reportError('postfx', 'render', err);
      services.reset('postfx');
      this.runner.markFailed?.('postfx', 'render', err);
      renderer.setRenderTarget(null);
    }
    if (!rendered) {
      try {
        renderer.render(scene, camera);
      } catch (err) {
        if (!this._renderFailed) this.reportError('core', 'render', err);
        this._renderFailed = true;
      }
    }
    this.perf.endGpu();
  }
}

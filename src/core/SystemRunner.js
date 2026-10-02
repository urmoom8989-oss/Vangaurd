/**
 * SystemRunner (core, frozen) — runs system lifecycles with strict error isolation.
 *
 *  - init(): sequential in dependency order, each with a timeout. A throwing/timing-out system is
 *    marked failed, its service is reset to the safe default, and the boot continues.
 *  - fixedUpdate/update/lateUpdate: each call is wrapped; the FIRST exception logs
 *    "[system:<name>] <phase> failed" with the stack and disables that system (the rest keep running).
 *    Its published service stays available (it may still be usable, e.g. materials.get()).
 */
export class SystemRunner {
  constructor(ctx, records, { reportError, initTimeoutMs = 30000 }) {
    this.ctx = ctx;
    this.records = records; // [{name, system, status}]
    this.reportError = reportError;
    this.initTimeoutMs = initTimeoutMs;
    this.active = [];
    this._fixed = [];
    this._update = [];
    this._late = [];
  }

  async initAll() {
    for (const r of this.records) {
      if (!r.system) continue;
      const s = r.system;
      const t0 = performance.now();
      try {
        if (typeof s.init === 'function') {
          let timer;
          const timeout = new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error(`init timed out after ${this.initTimeoutMs} ms`)), this.initTimeoutMs);
          });
          try {
            await Promise.race([Promise.resolve().then(() => s.init()), timeout]);
          } finally {
            clearTimeout(timer);
          }
        }
        r.status = 'active';
        r.initMs = Math.round(performance.now() - t0);
        this.active.push(r);
      } catch (err) {
        r.status = 'init-failed';
        r.error = String(err?.message || err);
        this.reportError(r.name, 'init', err);
        this.ctx.services.reset?.(r.name);
        try { s.dispose?.(); } catch { /* ignore */ }
      }
    }
    this._rebuild();
  }

  _rebuild() {
    const live = this.active.filter((r) => r.status === 'active');
    this._fixed = live.filter((r) => typeof r.system.fixedUpdate === 'function');
    this._update = live.filter((r) => typeof r.system.update === 'function');
    this._late = live.filter((r) => typeof r.system.lateUpdate === 'function');
  }

  _fail(r, phase, err) {
    r.status = 'disabled';
    r.error = `${phase}: ${String(err?.message || err)}`;
    this.reportError(r.name, phase, err);
    console.error(`[system:${r.name}] disabled after ${phase} error; other systems keep running.`);
    this._rebuild();
  }

  fixedUpdate(dt, t) {
    const list = this._fixed;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      try { r.system.fixedUpdate(dt, t); } catch (err) { this._fail(r, 'fixedUpdate', err); }
    }
  }

  update(dt, t) {
    const list = this._update;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      try { r.system.update(dt, t); } catch (err) { this._fail(r, 'update', err); }
    }
  }

  lateUpdate(dt, t) {
    const list = this._late;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      try { r.system.lateUpdate(dt, t); } catch (err) { this._fail(r, 'lateUpdate', err); }
    }
  }

  /** Mark a system failed from outside its lifecycle calls (e.g. postfx render). Disables its updates. */
  markFailed(name, phase, err) {
    const r = this.records.find((x) => x.name === name);
    if (!r || r.status !== 'active') return;
    r.status = 'disabled';
    r.error = `${phase}: ${String(err?.message || err)}`;
    this._rebuild();
  }

  status() {
    return this.records.map((r) => ({ name: r.name, status: r.status, initMs: r.initMs ?? null, error: r.error ?? null }));
  }

  get(name) {
    return this.records.find((r) => r.name === name)?.system || null;
  }

  disposeAll() {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (!r.system) continue;
      try { r.system.dispose?.(); } catch (err) { this.reportError(r.name, 'dispose', err); }
    }
  }
}

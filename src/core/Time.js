/**
 * Time — the ONLY clock systems should read. Never use performance.now()/Date.now() for gameplay or
 * animation; shots run in deterministic mode where every frame advances by exactly `fixedStep`.
 *
 *   time.t          simulation time in seconds (affected by scale, frozen in freeze mode)
 *   time.dt         last frame delta (seconds, clamped, scaled). 0 when frozen.
 *   time.frame      rendered frame counter
 *   time.fixedStep  fixed-update step (1/60)
 *   time.alpha      interpolation factor between fixed steps [0,1) for rendering
 *   time.real       wall-clock seconds since boot (debug/perf only)
 *   time.scale      time scale (slow-mo). 1 = normal
 *   time.deterministic  true in shot mode: dt === fixedStep each frame, independent of wall clock
 *   time.frozen     true when a shot preset uses freeze: dt === 0, t constant
 */
export class Time {
  constructor() {
    this.t = 0;
    this.dt = 0;
    this.frame = 0;
    this.fixedStep = 1 / 60;
    this.alpha = 0;
    this.real = 0;
    this.scale = 1;
    this.maxDelta = 0.1;
    this.deterministic = false;
    this.frozen = false;
    this.paused = false;
  }

  /** Enable deterministic stepping (shot mode). */
  setDeterministic(on, startT = 0) {
    this.deterministic = on;
    this.t = startT;
  }

  setFrozen(on, t = this.t) {
    this.frozen = on;
    this.t = t;
    if (on) this.dt = 0;
  }
}

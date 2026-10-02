import { STORAGE_KEY } from './config.js';

/**
 * gamemode/storage.js — persistent personal bests (localStorage, guarded).
 * Disabled in shot mode (determinism) — reads return null, writes are dropped.
 * Shape: { v: 1, best: { [difficulty]: { score, wave, kills } }, runs: n }
 */
export function createStorage(enabled) {
  let data = { v: 1, best: {}, runs: 0 };
  if (enabled) {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && typeof d === 'object' && d.best && typeof d.best === 'object') data = { v: 1, best: d.best, runs: d.runs | 0 };
      }
    } catch { /* storage unavailable or corrupt: start fresh */ }
  }

  function save() {
    if (!enabled) return;
    try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(data)); } catch { /* quota / privacy mode */ }
  }

  return {
    enabled,
    bestFor(diff) {
      const b = data.best[diff];
      return b && Number.isFinite(b.score) ? b : null;
    },
    /** Record a finished run. Returns { newBest, prev }. */
    record(diff, run) {
      const prev = this.bestFor(diff);
      if (!enabled) return { newBest: false, prev };
      data.runs = (data.runs | 0) + 1;
      const newBest = !prev || run.score > prev.score;
      if (newBest) data.best[diff] = { score: run.score, wave: run.wave, kills: run.kills };
      save();
      return { newBest, prev };
    },
  };
}

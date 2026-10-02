/**
 * audio/bake.worker.js — synthesizes the sound bank off the main thread.
 * Message in:  { jobs: [{ kind: 'sound', name, variant } | { kind: 'ir', name }], sr }
 * Messages out: { kind, name, variant?, sr, chans: Float32Array[] } (transferred), then { done: true }.
 * Uses the exact same deterministic generators as renderOffline and tools/audio/render.mjs.
 */
import catalog from './sounds/index.js';
import { Rand, hashStr } from './dsp.js';
import { makeIR } from './ir.js';

self.onmessage = (e) => {
  const { jobs, sr } = e.data || {};
  if (!jobs) return;
  for (const j of jobs) {
    try {
      let chans;
      if (j.kind === 'ir') chans = makeIR(j.name, sr);
      else {
        const def = catalog[j.name];
        if (!def) continue;
        chans = def.gen(new Rand(hashStr(`${j.name}#${j.variant}`)), sr, def.params || {});
      }
      self.postMessage({ kind: j.kind, name: j.name, variant: j.variant, sr, chans }, chans.map((c) => c.buffer));
    } catch (err) {
      self.postMessage({ kind: 'error', name: j.name, variant: j.variant, message: String(err && err.message || err) });
    }
  }
  self.postMessage({ done: true });
};

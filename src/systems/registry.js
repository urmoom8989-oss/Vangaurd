/**
 * System registry (core, FROZEN for subsystem agents).
 *
 * Lists every gameplay/render system in dependency order and loads each one in isolation.
 * Folder names are fixed; each folder's index.js must `export default function createSystem(ctx)`
 * returning { name, init?, fixedUpdate?, update?, lateUpdate?, dispose? }.
 *
 * Isolation guarantees:
 *  - Each module is loaded with its own dynamic import inside try/catch. A syntax error, a missing
 *    import or a throw at module top-level only removes THAT system.
 *  - The factory call is guarded the same way.
 * Per-frame isolation (init timeout, update/lateUpdate try/catch, auto-disable) lives in
 * src/core/SystemRunner.js.
 */
import { SYSTEM_ORDER } from '../core/constants.js';

export const SYSTEMS = SYSTEM_ORDER;

// Lazy loaders — each entry is `() => import('./<name>/index.js')`, resolved independently.
const loaders = import.meta.glob('./*/index.js');

/**
 * @param {object} ctx
 * @param {{ only?: string[] | null, reportError: (name: string, phase: string, err: any) => void, faults?: Set<string> }} opts
 * @returns {Promise<Array<{name: string, system: object | null, status: string, error?: string}>>}
 */
export async function loadSystems(ctx, { only = null, reportError, faults = new Set() }) {
  const wanted = SYSTEMS.filter((n) => !only || only.includes(n));
  // Import all modules in parallel; each promise is individually caught.
  const results = await Promise.all(
    wanted.map(async (name) => {
      const loader = loaders[`./${name}/index.js`];
      if (!loader) {
        reportError(name, 'load', new Error(`src/systems/${name}/index.js not found`));
        return { name, system: null, status: 'missing' };
      }
      try {
        if (faults.has(`${name}:import`)) throw new Error('[fault-injection] simulated import failure');
        const mod = await loader();
        const factory = mod.default;
        if (typeof factory !== 'function') throw new Error('default export is not a factory function');
        return { name, factory, status: 'loaded' };
      } catch (err) {
        // Dynamic-import errors hide the real cause (syntax error etc.); in dev, ask the server.
        if (import.meta.env.DEV) {
          try {
            const res = await fetch(`/src/systems/${name}/index.js`, { cache: 'no-store' });
            if (!res.ok) {
              const body = await res.text();
              let detail = body;
              const m = body.match(/const error = (\{.*\})/);
              try {
                const e = JSON.parse(m ? m[1] : body);
                detail = [e.message, e.loc ? `${e.loc.file}:${e.loc.line}:${e.loc.column}` : e.id, e.frame].filter(Boolean).join(' | ');
              } catch { /* plain text */ }
              err = new Error(`${String(err?.message || err)} | cause: ${detail.slice(0, 600)}`);
            }
          } catch { /* ignore */ }
        }
        reportError(name, 'import', err);
        return { name, system: null, status: 'import-failed', error: String(err?.message || err) };
      }
    }),
  );

  // Create systems sequentially in dependency order (factories may read services published by
  // earlier factories, although publishing in init() is preferred).
  const out = [];
  for (const r of results) {
    if (!r.factory) { out.push(r); continue; }
    try {
      const system = r.factory(ctx);
      if (!system || typeof system !== 'object') throw new Error('factory did not return a system object');
      system.name = system.name || r.name;
      // ?faults=name:phase — deliberate failures for isolation regression tests
      for (const phase of ['init', 'fixedUpdate', 'update', 'lateUpdate']) {
        if (faults.has(`${r.name}:${phase}`)) system[phase] = () => { throw new Error(`[fault-injection] simulated ${phase} failure`); };
      }
      out.push({ name: r.name, system, status: 'created' });
    } catch (err) {
      reportError(r.name, 'create', err);
      ctx.services.reset?.(r.name);
      out.push({ name: r.name, system: null, status: 'create-failed', error: String(err?.message || err) });
    }
  }
  const skipped = SYSTEMS.filter((n) => !wanted.includes(n)).map((name) => ({ name, system: null, status: 'skipped' }));
  return [...out, ...skipped];
}

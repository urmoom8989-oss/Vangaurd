#!/usr/bin/env node
/**
 * tools/postfx/shot.mjs <preset> <name> [extra shot.mjs args...]
 * Runs tools/shot.mjs with --out shots/postfx/<name>.png and prints a compact summary
 * (errors, warnings minus known ANGLE noise, perf).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [preset, name = preset, ...rest] = process.argv.slice(2);
const out = `shots/postfx/${name}.png`;
const r = spawnSync(process.execPath, ['tools/shot.mjs', preset, '--out', out, ...rest], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
let j;
try { j = JSON.parse(r.stdout); } catch { console.log(r.stdout.slice(-3000), r.stderr.slice(-3000)); process.exit(1); }
const noise = /X4122|double precision|GPU stall due to ReadPixels|GL_CLOSE_PATH/;
const uniq = (a) => [...new Set(a || [])];
const warnings = uniq(j.consoleWarnings).filter((w) => !noise.test(w));
const errors = uniq(j.consoleErrors).filter((w) => !noise.test(w));
console.log(JSON.stringify({
  ok: j.ok,
  png: j.png || out,
  sheet: j.contactSheet,
  perf: j.perf && { p95: j.perf.p95, avg: j.perf.avg, gpu: j.perf.gpuAvg, cpu: j.perf.cpuAvg, dc: j.perf.drawCalls, tris: j.perf.triangles },
  systemErrors: (j.systemErrors || []).map((e) => `${e.system}:${e.phase}: ${e.message}`.slice(0, 300)),
  consoleErrors: errors.slice(0, 8).map((s) => s.slice(0, 400)),
  warnings: warnings.slice(0, 8).map((s) => s.slice(0, 300)),
  pageErrors: (j.pageErrors || []).slice(0, 5),
  systems: (j.systems || []).filter((s) => s.status !== 'active').map((s) => `${s.name}:${s.status}`),
}, null, 1));

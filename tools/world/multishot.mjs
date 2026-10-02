// Run several shot presets in parallel and print a compact summary.
// Usage: node tools/world/multishot.mjs <outDir> <preset> [preset ...] [--par 4] [-- extra shot.mjs args]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
const extra = dd >= 0 ? argv.slice(dd + 1) : [];
const args = dd >= 0 ? argv.slice(0, dd) : argv;
let par = 4;
const pi = args.indexOf('--par');
if (pi >= 0) { par = +args[pi + 1]; args.splice(pi, 2); }
const [outDir, ...presets] = args;
fs.mkdirSync(outDir, { recursive: true });

function run(p) {
  return new Promise((resolve) => {
    const out = path.join(outDir, `${p}.png`);
    const cp = spawn(process.execPath, ['tools/shot.mjs', p, '--out', out, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '';
    cp.stdout.on('data', (d) => { so += d; });
    cp.stderr.on('data', () => {});
    cp.on('close', (code) => {
      let j = null;
      try { j = JSON.parse(so); } catch { /* */ }
      resolve({ p, code, j });
    });
  });
}

const queue = presets.slice();
const results = [];
await Promise.all(Array.from({ length: Math.min(par, queue.length) }, async () => {
  while (queue.length) results.push(await run(queue.shift()));
}));
for (const { p, code, j } of results) {
  if (!j) { console.log(`${p}: exit ${code} (no json)`); continue; }
  const errs = [...(j.systemErrors || []).map((e) => JSON.stringify(e).slice(0, 200)), ...(j.consoleErrors || []).map((e) => String(e).slice(0, 200)), ...(j.pageErrors || []).map((e) => String(e).slice(0, 200))];
  const warns = (j.consoleWarnings || []).filter((w) => !/X4122/.test(w)).map((w) => String(w).slice(0, 160));
  console.log(`${p}: ok=${j.ok} ms=${j.durationMs} draws=${j.perf?.drawCalls} tris=${j.perf?.triangles} p95=${j.perf?.p95}`);
  for (const e of errs) console.log(`   ERR ${e}`);
  for (const w of warns.slice(0, 4)) console.log(`   WARN ${w}`);
}

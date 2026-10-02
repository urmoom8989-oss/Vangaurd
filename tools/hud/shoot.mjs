#!/usr/bin/env node
/**
 * HUD shot helper: runs tools/shot.mjs for one or more presets (in parallel, max 3), writes
 * shots/hud/<preset-without-prefix>.png and prints a compact summary (hud-related errors first).
 *   node tools/hud/shoot.mjs hud-gameplay hud-death ...   (no args = all hud-* presets)
 *   extra args after "--" are forwarded to shot.mjs (e.g. -- --sequence 6 --interval 80)
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
const extra = dd >= 0 ? argv.slice(dd + 1) : [];
let presets = dd >= 0 ? argv.slice(0, dd) : argv;
if (!presets.length) presets = ['hud-gameplay', 'hud-ads', 'hud-damage', 'hud-killfeed', 'hud-mainmenu', 'hud-pause-settings', 'hud-death'];

function run(p) {
  return new Promise((resolve) => {
    const out = `shots/hud/${p.replace(/^hud-/, '')}${extra.includes('--sequence') ? '-seq' : ''}.png`;
    const cp = spawn(process.execPath, ['tools/shot.mjs', p, '--out', out, ...extra], { cwd: root });
    let s = '';
    cp.stdout.on('data', (d) => (s += d));
    cp.stderr.on('data', () => {});
    cp.on('close', (code) => {
      try {
        const j = JSON.parse(s);
        const sys = (j.systemErrors || []).filter((e) => e.system === 'hud').map((e) => `${e.phase}: ${String(e.message).slice(0, 200)}`);
        const other = (j.systemErrors || []).filter((e) => e.system !== 'hud').map((e) => e.system + ':' + e.phase);
        const hudCon = (j.consoleErrors || []).filter((e) => /hud/i.test(e)).map((e) => e.slice(0, 300));
        const page = (j.pageErrors || []).map((e) => String(e).slice(0, 300));
        console.log(`${p} ok=${j.ok} exit=${code} p95=${j.perf?.p95} gpu=${j.perf?.gpuAvg} cpu=${j.perf?.cpuAvg} -> ${out}`);
        if (sys.length) console.log('  HUD SYSTEM ERRORS', sys);
        if (hudCon.length) console.log('  HUD CONSOLE', hudCon);
        if (page.length) console.log('  PAGE', page);
        if (other.length) console.log('  others:', [...new Set(other)].join(', ').slice(0, 300));
      } catch {
        console.log(`${p} exit=${code} (unparseable) ${s.slice(0, 300)}`);
      }
      resolve();
    });
  });
}

const queue = presets.slice();
await Promise.all([0, 1, 2].map(async () => {
  while (queue.length) await run(queue.shift());
}));

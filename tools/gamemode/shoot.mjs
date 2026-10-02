#!/usr/bin/env node
/**
 * tools/gamemode/shoot.mjs — run tools/shot.mjs for one or more presets and print a compact summary
 * (errors attributed to gamemode are highlighted; other systems' errors are counted, not dumped).
 *
 *   node tools/gamemode/shoot.mjs gamemode-menu gamemode-intro [--w 1920 --h 1080] [--seq 6 --interval 400]
 *   node tools/gamemode/shoot.mjs all
 * Output PNGs: shots/gamemode/<preset>.png
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALL = ['gamemode-menu', 'gamemode-intro', 'gamemode-wave-live', 'gamemode-intermission', 'gamemode-death', 'gamemode-pause', 'gamemode-gameover', 'gamemode-victory'];

const argv = process.argv.slice(2);
const presets = [];
const extra = [];
let seq = null;
let interval = 400;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--seq') { seq = argv[++i]; continue; }
  if (a === '--interval') { interval = argv[++i]; continue; }
  if (a.startsWith('--')) { extra.push(a); if (argv[i + 1] && !argv[i + 1].startsWith('--')) extra.push(argv[++i]); continue; }
  if (a === 'all') presets.push(...ALL);
  else presets.push(a);
}

function run(preset) {
  return new Promise((resolve) => {
    const out = path.join('shots', 'gamemode', `${preset}${seq ? '-seq' : ''}.png`);
    const args = ['tools/shot.mjs', preset, '--out', out, ...extra];
    if (seq) args.push('--sequence', String(seq), '--interval', String(interval));
    const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '';
    let se = '';
    p.stdout.on('data', (d) => { so += d; });
    p.stderr.on('data', (d) => { se += d; });
    p.on('close', (code) => {
      let j = null;
      try { j = JSON.parse(so); } catch { /* ignore */ }
      if (!j) { console.log(`${preset}: exit ${code} (no JSON)\n${se.split('\n').slice(-8).join('\n')}`); return resolve(); }
      const sysErr = j.systemErrors || [];
      const mine = sysErr.filter((e) => e.system === 'gamemode');
      const others = [...new Set(sysErr.filter((e) => e.system !== 'gamemode').map((e) => `${e.system}:${e.phase}`))];
      const cErr = (j.consoleErrors || []).filter((m) => /gamemode/i.test(m));
      const pErr = j.pageErrors || [];
      console.log(`${preset}: ok=${j.ok} png=${j.png || j.contactSheet || out} ms=${j.durationMs}` +
        (others.length ? ` | other-system errors: ${others.join(', ')}` : '') +
        (mine.length ? `\n  GAMEMODE ERRORS: ${mine.map((e) => `${e.phase}: ${e.message}`).join('\n  ')}` : '') +
        (cErr.length ? `\n  gamemode console: ${cErr.join('\n  ')}` : '') +
        (pErr.length ? `\n  page errors: ${pErr.join('\n  ')}` : '') +
        (j.error ? `\n  error: ${j.error}` : ''));
      resolve();
    });
  });
}

for (const p of presets) await run(p);

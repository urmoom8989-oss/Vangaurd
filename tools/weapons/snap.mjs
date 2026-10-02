#!/usr/bin/env node
/**
 * Convenience wrapper around tools/shot.mjs for the weapons agent: runs one or more presets and prints a
 * compact summary (ok, system/console/page errors, perf, weapons log lines).
 *   node tools/weapons/snap.mjs weapons-hip [weapons-ads ...] [--sequence 8 --interval 50] [--tag x]
 * Output PNGs go to shots/weapons/<preset>[-tag].png
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const presets = [];
const extra = [];
let tag = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tag') { tag = '-' + args[++i]; continue; }
  if (args[i].startsWith('--')) { extra.push(args[i]); if (args[i + 1] && !args[i + 1].startsWith('--')) extra.push(args[++i]); continue; }
  presets.push(args[i]);
}
for (const p of presets) {
  const out = `shots/weapons/${p}${tag}.png`;
  const r = spawnSync(process.execPath, ['tools/shot.mjs', p, '--out', out, ...extra], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { console.log(p, 'NO JSON', r.stdout?.slice(0, 500), r.stderr?.slice(-1500)); continue; }
  const errs = (j.systemErrors || []).map((e) => `${e.system}:${e.phase}: ${String(e.message || e.error || '').slice(0, 200)}`);
  const cons = (j.consoleErrors || []).map((e) => String(e.text || e).slice(0, 300));
  const pages = (j.pageErrors || []).map((e) => String(e.message || e).slice(0, 300));
  const mine = (r.stderr || '').split('\n').filter((l) => /system:weapons/.test(l)).slice(0, 10);
  const pf = j.perf || {};
  console.log(`${p}: ok=${j.ok} png=${out} p95=${pf.p95} gpu=${pf.gpuAvg} dc=${pf.drawCalls} tris=${pf.triangles}`);
  const wErr = errs.filter((e) => e.startsWith('weapons'));
  if (wErr.length) console.log('  WEAPONS ERRORS:', wErr.join('\n   '));
  const other = errs.filter((e) => !e.startsWith('weapons'));
  if (other.length) console.log('  other system errors:', other.map((e) => e.slice(0, 90)).join(' | '));
  const cw = cons.filter((c) => /weapons|wpn|shader|THREE/i.test(c));
  if (cw.length) console.log('  console:', cw.join('\n   '));
  if (pages.length) console.log('  page:', pages.join('\n   '));
  if (mine.length) console.log('  log:', mine.join('\n   '));
}

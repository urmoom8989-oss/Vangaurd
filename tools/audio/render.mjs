#!/usr/bin/env node
/**
 * tools/audio/render.mjs — fast offline render of the DRY baked sounds (pure DSP, no browser), for iteration.
 *   node tools/audio/render.mjs <name|regex> [--variant N | --variants] [--sr 48000] [--out shots/audio/dry]
 * Writes WAVs; pair with tools/audio/spec.py for spectrogram PNGs. The in-browser tools/audio.mjs renders
 * the full runtime graph (reverb, mixing) — use that for final verification.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes('--' + k);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { default: catalog } = await import(pathToFileURL(path.join(root, 'src/systems/audio/sounds/index.js')).href);
const { Rand, hashStr } = await import(pathToFileURL(path.join(root, 'src/systems/audio/dsp.js')).href);

const pat = args[0];
const sr = Number(opt('sr', 48000));
const out = path.resolve(root, opt('out', 'shots/audio/dry'));
fs.mkdirSync(out, { recursive: true });
const names = Object.keys(catalog).filter((n) => (catalog[pat] ? n === pat : new RegExp(pat).test(n)));
if (!names.length) { console.error('no match. names:', Object.keys(catalog).join(' ')); process.exit(1); }

function writeWav(file, chans) {
  const n = chans[0].length, ch = chans.length;
  const b = Buffer.alloc(44 + n * ch * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * ch * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22); b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * ch * 2, 28); b.writeUInt16LE(ch * 2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * ch * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, chans[c][i])); b.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), o); o += 2; }
  fs.writeFileSync(file, b);
}
const res = [];
let total = 0;
for (const name of names) {
  const def = catalog[name];
  const vs = flag('variants') ? [...Array(def.variants || 1).keys()] : [Number(opt('variant', 0))];
  for (const v of vs) {
    const t0 = process.hrtime.bigint();
    const chans = def.gen(new Rand(hashStr(`${name}#${v}`)), sr, def.params || {});
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    total += ms;
    let pk = 0, ss = 0, nan = 0;
    for (const c of chans) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (!(a >= 0)) nan++; if (a > pk) pk = a; ss += c[i] * c[i]; }
    const file = path.join(out, `${name}_v${v}.wav`);
    if (!flag('nowav')) writeWav(file, chans);
    res.push({ name, v, ch: chans.length, dur: +(chans[0].length / sr).toFixed(3), peakDb: +(20 * Math.log10(pk)).toFixed(1), rmsDb: +(10 * Math.log10(ss / (chans[0].length * chans.length))).toFixed(1), nan, bakeMs: +ms.toFixed(1) });
  }
}
if (flag('brief')) {
  for (const r of res) console.log(`${r.name.padEnd(34)} v${r.v} ch${r.ch} ${String(r.dur).padStart(6)}s peak ${String(r.peakDb).padStart(6)} rms ${String(r.rmsDb).padStart(6)} ${r.nan ? 'NaN!' : ''} ${r.bakeMs}ms`);
  console.log('total bake ms', total.toFixed(0));
} else console.log(JSON.stringify(res, null, 1));

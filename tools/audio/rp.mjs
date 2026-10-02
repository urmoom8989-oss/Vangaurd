#!/usr/bin/env node
/**
 * tools/audio/rp.mjs — batch "render in page": renders several sounds/scenes through the REAL runtime graph
 * (services.audio.renderOffline) with custom params, in one browser session, and writes WAVs.
 *
 *   node tools/audio/rp.mjs <name[:jsonParams]> ... [--out shots/audio/rp] [--sr 48000] [--duration s]
 *   e.g. node tools/audio/rp.mjs rifle_fire 'rifle_fire:{"noMaster":true}' 'rifle_fire:{"noReverb":true}'
 * Prints [{name, params, wav, peakDb, rmsDb}] as JSON. Pair with tools/audio/env.py / spec.py / bands.py.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, startServer, launchBrowser, openPage, waitForReady, cleanupAll, buildUrl, printJson, ensureDir, SHOTS_DIR } from '../lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const outDir = ensureDir(path.resolve(String(args.out || path.join(SHOTS_DIR, 'audio', 'rp'))));
const jobs = args._.map((s) => {
  const i = s.indexOf(':');
  return i < 0 ? { name: s, params: {} } : { name: s.slice(0, i), params: JSON.parse(s.slice(i + 1)) };
});

function writeWav(file, chans, sr) {
  const n = chans[0].length, ch = chans.length;
  const b = Buffer.alloc(44 + n * ch * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * ch * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22); b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * ch * 2, 28); b.writeUInt16LE(ch * 2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * ch * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, chans[c][i])); b.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), o); o += 2; }
  fs.writeFileSync(file, b);
}

const out = [];
let code = 0;
try {
  const { url } = await startServer();
  const { browser } = await launchBrowser({ width: 800, height: 600 });
  const { page, diag } = await openPage(browser, { width: 800, height: 600 });
  await page.goto(buildUrl(url, { shot: '__audio__' }), { timeout: 90000 });
  await waitForReady(page, 90000);
  for (const j of jobs) {
    const r = await page.evaluate(({ name, o }) => window.__renderSound(name, o), {
      name: j.name, o: { sampleRate: Number(args.sr || 48000), channels: 2, duration: args.duration ? Number(args.duration) : undefined, params: j.params },
    });
    const chans = r.channels.map((b) => { const buf = Buffer.from(b, 'base64'); return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); });
    const tag = Object.keys(j.params).length ? '_' + Object.entries(j.params).map(([k, v]) => `${k}-${typeof v === 'object' ? 'o' : v}`).join('_') : '';
    const file = path.join(outDir, `${j.name}${tag}.wav`);
    writeWav(file, chans, r.sampleRate);
    let pk = 0, ss = 0;
    for (const c of chans) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > pk) pk = a; ss += c[i] * c[i]; }
    out.push({ name: j.name, params: j.params, wav: file, peakDb: +(20 * Math.log10(pk + 1e-12)).toFixed(1), rmsDb: +(10 * Math.log10(ss / (chans[0].length * chans.length) + 1e-20)).toFixed(1) });
  }
  const errs = await page.evaluate(() => window.__SYSTEM_ERRORS__ || []);
  if (errs.length || diag.pageErrors.length) out.push({ systemErrors: errs, pageErrors: diag.pageErrors, consoleErrors: diag.consoleErrors });
} catch (e) {
  out.push({ error: e.message });
  code = 1;
} finally {
  await cleanupAll();
  printJson(out);
  process.exit(code);
}

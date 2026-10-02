#!/usr/bin/env node
/**
 * tools/audio.mjs — render a game sound offline so non-listening critics can inspect it.
 *
 *   node tools/audio.mjs <soundName|--list|--all> [--duration s] [--sr 48000] [--channels 2] [--out <dir>] [--timeout ms]
 *
 * Page-side contract (implemented in src/main.js, backed by services.audio.renderOffline):
 *   window.__listSounds() -> string[]
 *   window.__renderSound(name, { duration, sampleRate, channels }) ->
 *       { name, sampleRate, length, duration, numberOfChannels, channels: base64(Float32Array)[] }
 * Writes <out>/<name>-<ts>.wav (16-bit PCM) and <name>-<ts>.png (waveform + log-frequency spectrogram)
 * and prints JSON: { ok, sounds: [{ name, wav, png, stats: { duration, peakDb, rmsDb, clippedSamples,
 *   dcOffset, tailSilenceMs, spectralCentroidHz } }] }
 * Default out dir: shots/audio/
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  parseArgs, startServer, launchBrowser, openPage, waitForReady, cleanupAll, buildUrl, printJson, timestamp, ensureDir, SHOTS_DIR, log,
} from './lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const target = args._[0] || (args.list ? '--list' : args.all ? '--all' : null);
if (!target) {
  console.error('usage: node tools/audio.mjs <soundName|--list|--all> [--duration s] [--sr 48000] [--channels 2] [--out dir]');
  process.exit(1);
}
const timeout = Number(args.timeout || 60000);
const outDir = ensureDir(path.resolve(String(args.out || path.join(SHOTS_DIR, 'audio'))));
const result = { ok: false };
let exitCode = 0;

function writeWav(file, channels, sampleRate) {
  const n = channels[0].length;
  const ch = channels.length;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * ch * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * ch * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), o);
      o += 2;
    }
  }
  fs.writeFileSync(file, buf);
}

function stats(channels, sr) {
  let peak = 0, sumSq = 0, clipped = 0, sum = 0, lastLoud = 0;
  const n = channels[0].length;
  for (const d of channels) {
    for (let i = 0; i < n; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      if (a >= 0.999) clipped++;
      if (a > 0.001 && i > lastLoud) lastLoud = i;
      sumSq += d[i] * d[i];
      sum += d[i];
    }
  }
  const total = n * channels.length;
  const db = (x) => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -Infinity);
  return {
    duration: Math.round((n / sr) * 1000) / 1000,
    peakDb: db(peak),
    rmsDb: db(Math.sqrt(sumSq / total)),
    clippedSamples: clipped,
    dcOffset: Math.round((sum / total) * 1e5) / 1e5,
    tailSilenceMs: Math.round(((n - lastLoud) / sr) * 1000),
  };
}

/** Runs in the page: draws waveform + spectrogram, returns {png dataURL, centroid}. */
function drawAnalysis({ chB64, sr, name }) {
  const chans = chB64.map((b) => {
    const s = atob(b);
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return new Float32Array(u.buffer);
  });
  const W = 1600, WAVE_H = 150, SPEC_H = 520, PAD = 40;
  const H = PAD + chans.length * (WAVE_H + 10) + SPEC_H + PAD + 20;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#0d0f12'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#e8e8e8'; g.font = 'bold 18px sans-serif';
  const n = chans[0].length;
  g.fillText(`${name}  —  ${(n / sr).toFixed(3)} s @ ${sr} Hz, ${chans.length} ch`, 12, 26);
  const plotW = W - 80, x0 = 60;
  // waveforms (min/max per column)
  chans.forEach((d, ci) => {
    const y0 = PAD + ci * (WAVE_H + 10);
    g.fillStyle = '#161a20'; g.fillRect(x0, y0, plotW, WAVE_H);
    g.strokeStyle = '#333'; g.beginPath(); g.moveTo(x0, y0 + WAVE_H / 2); g.lineTo(x0 + plotW, y0 + WAVE_H / 2); g.stroke();
    g.fillStyle = '#4fc3f7';
    const spp = n / plotW;
    for (let x = 0; x < plotW; x++) {
      let mn = 1, mx = -1;
      const a = Math.floor(x * spp), b = Math.min(n, Math.floor((x + 1) * spp) + 1);
      for (let i = a; i < b; i++) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      const ya = y0 + WAVE_H / 2 - mx * (WAVE_H / 2), yb = y0 + WAVE_H / 2 - mn * (WAVE_H / 2);
      g.fillRect(x0 + x, ya, 1, Math.max(1, yb - ya));
    }
    g.fillStyle = '#aaa'; g.font = '12px monospace'; g.fillText(`ch${ci}`, 12, y0 + WAVE_H / 2 + 4);
  });
  // spectrogram (mono mix), Hann 2048, log-frequency axis 20 Hz..Nyquist, dB -100..0
  const N = 2048, cols = plotW;
  const mono = new Float32Array(n);
  for (const d of chans) for (let i = 0; i < n; i++) mono[i] += d[i] / chans.length;
  const hop = Math.max(1, (n - N) / cols);
  const re = new Float32Array(N), im = new Float32Array(N), win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const fft = () => {
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < N; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  };
  const sy0 = PAD + chans.length * (WAVE_H + 10) + 10;
  const img = g.createImageData(cols, SPEC_H);
  const fMin = 20, fMax = sr / 2, lMin = Math.log(fMin), lMax = Math.log(fMax);
  const colorMap = (t) => { // magma-ish
    const r = Math.min(255, Math.max(0, 255 * Math.min(1, t * 1.6)));
    const gg = Math.min(255, Math.max(0, 255 * Math.max(0, t * 1.5 - 0.5)));
    const b = Math.min(255, Math.max(0, 255 * (t < 0.4 ? t * 1.8 : Math.max(0, 1.2 - t * 1.3) + Math.max(0, t - 0.85) * 4)));
    return [r, gg, b];
  };
  let centroidNum = 0, centroidDen = 0;
  for (let x = 0; x < cols; x++) {
    const start = Math.floor(x * hop);
    for (let i = 0; i < N; i++) { re[i] = (mono[start + i] || 0) * win[i]; im[i] = 0; }
    fft();
    for (let k = 1; k < N / 2; k++) {
      const m = Math.hypot(re[k], im[k]);
      centroidNum += m * (k * sr / N); centroidDen += m;
    }
    for (let y = 0; y < SPEC_H; y++) {
      const f = Math.exp(lMax - (y / (SPEC_H - 1)) * (lMax - lMin));
      const k = Math.min(N / 2 - 1, Math.max(1, Math.round((f * N) / sr)));
      const mag = Math.hypot(re[k], im[k]) / (N / 4);
      const dbv = 20 * Math.log10(mag + 1e-12);
      const t = Math.min(1, Math.max(0, (dbv + 100) / 100));
      const [r, gg, b] = colorMap(t);
      const o = (y * cols + x) * 4;
      img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, x0, sy0);
  g.fillStyle = '#aaa'; g.font = '12px monospace';
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    if (f > fMax) continue;
    const y = sy0 + ((lMax - Math.log(f)) / (lMax - lMin)) * (SPEC_H - 1);
    g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, 12, y + 4);
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x0, y, plotW, 1); g.fillStyle = '#aaa';
  }
  const dur = n / sr;
  for (let i = 0; i <= 10; i++) {
    const x = x0 + (i / 10) * plotW;
    g.fillText(`${(dur * i / 10).toFixed(2)}s`, x - 14, sy0 + SPEC_H + 16);
  }
  return { png: c.toDataURL('image/png'), centroid: centroidDen > 0 ? Math.round(centroidNum / centroidDen) : 0 };
}

try {
  const { url } = await startServer();
  const { browser } = await launchBrowser({ width: 1600, height: 1000 });
  const { page, diag } = await openPage(browser, { width: 1600, height: 1000 });
  await page.goto(buildUrl(url, { shot: '__audio__' }), { timeout });
  await waitForReady(page, timeout);
  const names = await page.evaluate(() => window.__listSounds());
  if (target === '--list') {
    Object.assign(result, { ok: true, sounds: names });
  } else {
    const list = target === '--all' ? names : [target];
    result.sounds = [];
    for (const name of list) {
      log(`rendering ${name}`);
      const r = await page.evaluate(
        ({ name, o }) => window.__renderSound(name, o),
        { name, o: { duration: args.duration ? Number(args.duration) : undefined, sampleRate: Number(args.sr || 48000), channels: Number(args.channels || 2) } },
      );
      const chans = r.channels.map((b) => {
        const buf = Buffer.from(b, 'base64');
        return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      });
      const base = path.join(outDir, `${name.replace(/[^a-z0-9_.-]+/gi, '_')}-${timestamp()}`);
      writeWav(base + '.wav', chans, r.sampleRate);
      const a = await page.evaluate(drawAnalysis, { chB64: r.channels, sr: r.sampleRate, name });
      fs.writeFileSync(base + '.png', Buffer.from(a.png.split(',')[1], 'base64'));
      result.sounds.push({ name, wav: base + '.wav', png: base + '.png', stats: { ...stats(chans, r.sampleRate), spectralCentroidHz: a.centroid } });
    }
    result.ok = true;
  }
  result.systemErrors = await page.evaluate(() => window.__SYSTEM_ERRORS__ || []);
  Object.assign(result, diag);
} catch (e) {
  result.error = e.message;
  exitCode = /Timeout/i.test(e.message) ? 2 : 1;
  log('error:', e.message);
} finally {
  await cleanupAll();
  printJson(result);
  process.exit(exitCode);
}

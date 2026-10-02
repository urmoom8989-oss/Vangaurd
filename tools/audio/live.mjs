#!/usr/bin/env node
/**
 * tools/audio/live.mjs — boot the REAL game (interactive mode, all systems), start audio, drive some
 * gameplay through scripted input, and record the master output (post-limiter) to a WAV, so the actual
 * in-game mix (events -> engine -> buses) can be inspected. Also reports audio stats and page errors.
 *
 *   node tools/audio/live.mjs [--seconds 12] [--out shots/audio/live] [--script fight|walk|idle] [--headed]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, startServer, launchBrowser, openPage, cleanupAll, printJson, timestamp, ensureDir, SHOTS_DIR, log } from '../lib/harness.mjs';

const args = parseArgs(process.argv.slice(2));
const seconds = Number(args.seconds || 12);
const outDir = ensureDir(path.resolve(String(args.out || path.join(SHOTS_DIR, 'audio', 'live'))));
const script = String(args.script || 'fight');
const result = { ok: false };
let code = 0;

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

try {
  const { url } = await startServer();
  const { browser } = await launchBrowser({ width: 1280, height: 720, headed: !!args.headed });
  const { page, diag } = await openPage(browser, { width: 1280, height: 720 });
  globalThis.__diag = diag;
  await page.goto(url + '/' + (args.only ? `?only=${args.only}` : ''), { timeout: 90000 });
  await page.waitForTimeout(3000);
  // the dev server may force full reloads (boot-time dependency optimisation, lazily imported modules when
  // gameplay starts); boot -> audio -> deploy -> live, and start over if the page navigated meanwhile
  let navs = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) { navs++; log('navigated'); } });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await page.waitForFunction(() => window.__GAME__?.systems && window.__GAME__.systems().every((s) => (s.status || s.state) !== 'created'), null, { timeout: 180000, polling: 500 });
      const n0 = navs;
      await page.waitForTimeout(attempt ? 3000 : 8000);
      if (navs !== n0) continue;
      await page.evaluate(() => { window.__GAME__.ctx.events.emit('core:user-gesture'); return window.__GAME__.ctx.services.audio.resume(); });
      await page.waitForFunction(() => (window.__GAME__.ctx.services.audio.bakeProgress || 0) > 0.6, null, { timeout: 60000 }).catch((e) => log('bake still running', e.message));
      await page.waitForFunction(() => window.__GAME__.ctx.services.audio.context, null, { timeout: 30000 });
      if (!args.menu) {
        await page.evaluate(() => {
          const g = window.__GAME__.ctx;
          try { g.events.emit('hud:play', {}); } catch { /* */ }
          try { g.services.gamemode.start?.(); } catch { /* */ }
        });
        await page.waitForTimeout(1500);
        for (let i = 0; i < 40; i++) {
          const st = await page.evaluate(() => { const g = window.__GAME__.ctx.services.gamemode; const s = g.state?.stage; if (s === 'warmup' || s === 'intermission') g.skipIntermission?.(); return s; });
          if (st === 'live' || st === 'sandbox' || st === undefined) break;
          await page.waitForTimeout(500);
        }
      }
      await page.waitForTimeout(3000 + Number(args.wait || 0));
      if (navs !== n0) continue;
      break;
    } catch (e) { if (!/destroyed|navigation|undefined/i.test(e.message)) throw e; log('retry', e.message.slice(0, 120)); }
  }
  log('game', JSON.stringify(await page.evaluate(() => window.__GAME__.systems().map((s) => s.name + ':' + (s.status || s.state)))));
  log('audio', JSON.stringify(await page.evaluate(() => window.__GAME__.ctx.services.audio.stats())), 'stage', await page.evaluate(() => window.__GAME__.ctx.services.gamemode.state?.stage));
  // tap the master output with an AudioWorklet recorder (ScriptProcessor is throttled in headless)
  await page.evaluate(async (secs) => {
    const a = window.__GAME__.ctx.services.audio;
    const eng = a.engine;
    const ac = a.context;
    const n = Math.ceil(secs * ac.sampleRate);
    const L = new Float32Array(n), R = new Float32Array(n);
    let w = 0;
    const code = `class Rec extends AudioWorkletProcessor { process(inp) { const i = inp[0]; if (i && i.length) this.port.postMessage([i[0].slice(), (i[1] || i[0]).slice()]); return true; } } registerProcessor('rec-tap', Rec);`;
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    await ac.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(ac, 'rec-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
    node.port.onmessage = (e) => {
      const [l, r] = e.data;
      for (let i = 0; i < l.length && w < n; i++, w++) { L[w] = l[i]; R[w] = r[i]; }
      if (w >= n) window.__AUDIO_REC_DONE__ = true;
    };
    eng.limiter.connect(node);
    const mute = ac.createGain(); mute.gain.value = 0; node.connect(mute).connect(ac.destination);
    window.__AUDIO_REC__ = { L, R, sr: ac.sampleRate, get w() { return w; } };
    // event log (seconds into the recording) to correlate the WAV with gameplay
    const t0 = ac.currentTime; const evlog = window.__AUDIO_EVLOG__ = {};
    for (const n of ['weapon:fired', 'combat:shot', 'combat:hit', 'combat:kill', 'combat:near-miss', 'combat:explosion', 'player:footstep', 'player:land', 'player:damaged', 'weapon:reload', 'weapons:cue', 'ai:footstep', 'ai:death', 'ai:alert', 'gamemode:stage']) {
      window.__GAME__.ctx.events.on(n, (e) => { const k = n + (e?.source && typeof e.source === 'string' ? ':' + e.source.split('_')[0] : ''); (evlog[k] ||= []).push(+(ac.currentTime - t0).toFixed(2)); });
    }
  }, seconds);
  // scripted input
  const inj = async (code) => page.evaluate(code);
  if (script === 'fight' || script === 'walk') {
    await inj(() => { const i = window.__GAME__.ctx.input; i.injectMove(0, 1); i.inject('sprint', true); });
    await page.waitForTimeout(1600);
    await inj(() => { const i = window.__GAME__.ctx.input; i.inject('sprint', false); i.injectMove(1, 0); });
    await page.waitForTimeout(900);
    await inj(() => { const i = window.__GAME__.ctx.input; i.injectMove(0, 0); });
  }
  if (script === 'fight') {
    await inj(() => window.__GAME__.ctx.input.inject('ads', true));
    await page.waitForTimeout(400);
    await inj(() => window.__GAME__.ctx.input.inject('fire', true));
    await page.waitForTimeout(700);
    await inj(() => window.__GAME__.ctx.input.inject('fire', false));
    await page.waitForTimeout(600);
    await inj(() => { window.__GAME__.ctx.input.inject('fire', true); });
    await page.waitForTimeout(250);
    await inj(() => { window.__GAME__.ctx.input.inject('fire', false); window.__GAME__.ctx.input.inject('ads', false); });
    await page.waitForTimeout(500);
    await inj(() => window.__GAME__.ctx.input.inject('reload', true));
    await page.waitForTimeout(100);
    await inj(() => window.__GAME__.ctx.input.inject('reload', false));
    // a grenade-like explosion and enemy fire via the service extensions (independent of AI state)
    await page.waitForTimeout(2500);
    await inj(() => {
      const g = window.__GAME__.ctx; const p = g.camera.position;
      g.services.combat.explode?.({ position: { x: p.x + 8, y: p.y - 1.5, z: p.z - 10 }, radius: 6, damage: 0, source: 'test' });
    });
  }
  await page.waitForFunction(() => window.__AUDIO_REC_DONE__ === true, null, { timeout: (seconds + 30) * 1000 }).catch(async (e) => log('recording incomplete', e.message, await page.evaluate(() => window.__AUDIO_REC__?.w)));
  const rec = await page.evaluate(() => {
    const r = window.__AUDIO_REC__;
    const enc = (f) => { const u = new Uint8Array(f.buffer, f.byteOffset, f.byteLength); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
    return { L: enc(r.L.subarray(0, Math.max(1, r.w))), R: enc(r.R.subarray(0, Math.max(1, r.w))), sr: r.sr };
  });
  const dec = (b) => { const buf = Buffer.from(b, 'base64'); return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); };
  const file = path.join(outDir, `live-${script}-${timestamp()}.wav`);
  writeWav(file, [dec(rec.L), dec(rec.R)], rec.sr);
  result.wav = file;
  result.stats = await page.evaluate(() => window.__GAME__.ctx.services.audio.stats());
  result.events = await page.evaluate(() => { const o = {}; for (const [k, v] of Object.entries(window.__AUDIO_EVLOG__ || {})) o[k] = v.length > 12 ? `${v.length}x ${v[0]}..${v[v.length - 1]}` : v.join(' '); return o; });
  result.systemErrors = await page.evaluate(() => window.__SYSTEM_ERRORS__ || []);
  Object.assign(result, diag);
  result.ok = true;
} catch (e) {
  result.error = e.message;
  code = 1;
  try { Object.assign(result, globalThis.__diag || {}); } catch { /* */ }
} finally {
  await cleanupAll();
  printJson(result);
  process.exit(code);
}

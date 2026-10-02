/**
 * audio/engine.js — the runtime audio engine. One class serves BOTH the realtime AudioContext and
 * OfflineAudioContext renders (renderOffline / tools/audio.mjs), so what critics inspect is exactly the
 * graph players hear.
 *
 * Graph:
 *   voice: BufferSource -> gain -> [lowpass (distance air absorption + occlusion)] -> [HRTF panner | stereo panner] -> bus
 *                                        \-> send -> reverb (2 ConvolverNodes, A/B crossfade on env change)
 *   amb  -> ambDuck -> ambVol -> sfxIn
 *   sfxIn (+ reverb return) -> sfxFilter (concussion / death / low-health muffling) -> sfxDuck -> sfxVol -> master
 *   music -> musicDuck -> musicVol -> master;  ui -> uiVol -> master;  voice -> voiceVol -> master
 *   master -> glue compressor -> brickwall limiter -> destination
 *
 * Voice management: per-group limits (steal oldest), global cap (steal lowest priority), variant
 * round-robin without immediate repeats, seeded pitch/volume randomization.
 */
import catalog from './sounds/index.js';
import { Rand, hashStr, clamp } from './dsp.js';
import { makeIR, IR_PRESETS } from './ir.js';
import { weaponClass } from './sounds/weapons.js';
import { footSurface, impactSurface } from './sounds/surfaces.js';

export const C_SOUND = 343; // m/s
export const BULLET_SPEED = 880; // m/s (5.56 class)

const dbToGain = (db) => Math.pow(10, db / 20);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------------------------------ bank
/** Baked sample storage (Float32 channel data) + per-context AudioBuffer cache. */
export class Bank {
  constructor() {
    this.data = new Map(); // name -> [{chans, sr}]
    this.cache = new WeakMap(); // ctx -> Map(name -> AudioBuffer[])
    this.irs = new Map(); // preset -> {chans, sr}
    this.version = 0;
  }
  put(name, variant, chans, sr) {
    let e = this.data.get(name);
    if (!e) this.data.set(name, (e = []));
    e[variant] = { chans, sr };
    this.version++;
  }
  putIR(name, chans, sr) { this.irs.set(name, { chans, sr }); this.version++; }
  has(name) { const e = this.data.get(name); return !!(e && e.length); }
  ready(name) { const d = catalog[name]; const e = this.data.get(name); return !!(d && e && e.filter(Boolean).length >= (d.variants || 1)); }
  /** Synchronously bake every variant of `name` that is missing (renderOffline path). */
  bakeSync(name, sr) {
    const def = catalog[name];
    if (!def) return false;
    for (let v = 0; v < (def.variants || 1); v++) {
      const e = this.data.get(name);
      if (e && e[v] && e[v].sr === sr) continue;
      this.put(name, v, bakeOne(name, v, sr), sr);
    }
    return true;
  }
  bakeIRSync(name, sr) {
    const e = this.irs.get(name);
    if (!e || e.sr !== sr) this.putIR(name, makeIR(name, sr), sr);
  }
  _toBuffer(ctx, { chans, sr }) {
    const b = ctx.createBuffer(chans.length, chans[0].length, sr);
    for (let c = 0; c < chans.length; c++) b.copyToChannel(chans[c], c);
    return b;
  }
  buffers(ctx, name) {
    const e = this.data.get(name);
    if (!e) return null;
    let m = this.cache.get(ctx);
    if (!m) this.cache.set(ctx, (m = new Map()));
    let arr = m.get(name);
    const avail = e.reduce((n, x) => n + (x ? 1 : 0), 0);
    if (!arr || arr.count !== avail) {
      arr = [];
      for (const x of e) if (x) arr.push(this._toBuffer(ctx, x));
      arr.count = avail;
      m.set(name, arr);
    }
    return arr.length ? arr : null;
  }
  irBuffer(ctx, name) {
    const e = this.irs.get(name);
    if (!e) return null;
    let m = this.cache.get(ctx);
    if (!m) this.cache.set(ctx, (m = new Map()));
    const key = 'ir:' + name;
    let b = m.get(key);
    if (!b) { b = this._toBuffer(ctx, e); m.set(key, b); }
    return b;
  }
}

/** Deterministic bake of one variant (same seeds everywhere: worker, main thread, node tools). */
export function bakeOne(name, variant, sr) {
  const def = catalog[name];
  return def.gen(new Rand(hashStr(`${name}#${variant}`)), sr, def.params || {});
}

// ------------------------------------------------------------------------------------------ voices
const NULL_HANDLE = Object.freeze({ stop() {}, setVolume() {}, setPitch() {}, setPosition() {}, playing: false });

class Voice {
  constructor(eng, name, def) {
    this.eng = eng; this.name = name; this.def = def;
    this.group = def.group || name; this.priority = def.priority ?? 50;
    this.src = null; this.gain = null; this.filter = null; this.panner = null; this.send = null; this.out = null;
    this.startAt = 0; this.endAt = Infinity; this.loop = false; this.alive = true;
    this.pos = null; this.tracked = false; this.baseGain = 1; this.userVol = 1; this.distGain = 1; this.baseSend = 0;
    this.occ = 0; this.occTarget = 0;
  }
  get playing() { return this.alive && (this.loop || this.eng.ac.currentTime < this.endAt); }
  stop(fade = 0.04, at = 0) {
    if (!this.alive) return;
    const t = Math.max(this.eng.ac.currentTime, at);
    try {
      const g = this.gain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0, t + fade);
      this.src.stop(t + fade + 0.01);
    } catch { this._cleanup(); }
    this.alive = false;
  }
  setVolume(v) { this.userVol = v; this._applyGain(0.03); }
  setPitch(p) { if (this.src) this.src.playbackRate.setTargetAtTime(p * (this.rate0 || 1), this.eng.ac.currentTime, 0.02); }
  setPosition(p) {
    if (!p) return;
    if (!this.pos) this.pos = { x: 0, y: 0, z: 0 };
    this.pos.x = p.x; this.pos.y = p.y; this.pos.z = p.z;
    this.tracked = true;
    if (this.panner) this.eng._spatialUpdate(this, 0.05);
  }
  _applyGain(tc) {
    if (!this.gain || !this.alive) return;
    const v = this.baseGain * this.userVol * this.distGain;
    this.gain.gain.setTargetAtTime(v, this.eng.ac.currentTime, tc);
  }
  _cleanup() {
    if (this._dead) return;
    this._dead = true;
    this.alive = false;
    for (const n of [this.src, this.gain, this.filter, this.panner, this.send, this.erSend]) { try { n?.disconnect(); } catch { /* ignore */ } }
    this.eng._remove(this);
  }
}

// ------------------------------------------------------------------------------------------ engine
export class AudioEngine {
  /**
   * @param {BaseAudioContext} ac
   * @param {Bank} bank
   * @param {{rng: {next():number}, volumes?: object, hrtf?: boolean, offline?: boolean}} opts
   */
  constructor(ac, bank, { rng, volumes = {}, hrtf = true, offline = false } = {}) {
    this.ac = ac; this.bank = bank; this.rng = rng || new Rand(1); this.offline = offline; this.hrtf = hrtf;
    this.timeBase = 0;
    this.listener = { pos: { x: 0, y: 0, z: 0 }, fwd: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 }, right: { x: 1, y: 0, z: 0 } };
    this.occlude = null; // (pos) -> 0..1, provided by the system (world raycast)
    this.voices = [];
    this.groups = new Map();
    this.maxVoices = 72;
    this.lastVariant = new Map();
    this.env = null; this.envSend = 1; this.envActive = 0;
    this.lowHealth = 0; this.muffled = false; this.concussUntil = 0;
    this.warned = new Set();
    this.stats = { played: 0, stolen: 0, skipped: 0 };
    this.autoCasings = true; // timed casing drops for the player's shots until real vfx casing bounces are seen
    this.lastFlyby = -1;
    this._build(volumes);
  }

  /** Engine time. Every `at` argument is engine time; AudioParam/start calls use context time (= engine - timeBase).
   *  Offline renders use timeBase < 0 as a pre-roll so the master dynamics are settled before t = 0. */
  now() { return this.ac.currentTime + this.timeBase; }

  _build(v) {
    const ac = this.ac;
    const G = (val = 1) => { const g = ac.createGain(); g.gain.value = val; return g; };
    this.master = G(v.master ?? 0.9);
    // NOTE: WebAudio's DynamicsCompressor applies automatic makeup gain (~0.6 x the gain reduction at 0 dBFS).
    // A low threshold therefore flattens gunshots and lifts every reverb tail. Keep the glue gentle (only
    // tames big stacks) and the limiter's threshold near the ceiling so the transients keep their punch.
    this.glue = ac.createDynamicsCompressor();
    this.glue.threshold.value = -6; this.glue.knee.value = 6; this.glue.ratio.value = 1.6;
    this.glue.attack.value = 0.012; this.glue.release.value = 0.25;
    this.limiter = ac.createDynamicsCompressor();
    this.limiter.threshold.value = -1.2; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001; this.limiter.release.value = 0.09;
    this.post = G(0.82); // cancels the glue's automatic makeup (~+1.7 dB)
    this.master.connect(this.glue).connect(this.post).connect(this.limiter).connect(ac.destination);

    this.sfxIn = G(1);
    this.sfxFilter = ac.createBiquadFilter();
    this.sfxFilter.type = 'lowpass'; this.sfxFilter.frequency.value = 20000; this.sfxFilter.Q.value = 0.6;
    this.sfxDuck = G(1);
    this.sfxVol = G(v.sfx ?? 1);
    this.sfxIn.connect(this.sfxFilter).connect(this.sfxDuck).connect(this.sfxVol).connect(this.master);

    this.ambIn = G(1); this.ambDuck = G(1); this.ambVol = G(v.ambience ?? 1);
    // outdoor ambience heard from inside a building is muffled and quieter (set per environment)
    this.ambFilter = ac.createBiquadFilter(); this.ambFilter.type = 'lowpass'; this.ambFilter.frequency.value = 20000; this.ambFilter.Q.value = 0.5;
    this.ambEnv = G(1);
    this.ambIn.connect(this.ambFilter).connect(this.ambEnv).connect(this.ambDuck).connect(this.ambVol).connect(this.sfxIn);

    this.musicIn = G(1); this.musicDuck = G(1); this.musicVol = G(v.music ?? 0.6);
    this.musicIn.connect(this.musicDuck).connect(this.musicVol).connect(this.master);
    this.uiVol = G(v.ui ?? 1); this.uiVol.connect(this.master);
    this.voiceVol = G(v.voice ?? 1); this.voiceVol.connect(this.master);

    // environment reverb: two convolvers for click-free preset crossfades
    this.revIn = G(1);
    this.revOut = G(1);
    this.convA = ac.createConvolver(); this.convA.normalize = false;
    this.convB = ac.createConvolver(); this.convB.normalize = false;
    this.convGA = G(1); this.convGB = G(0);
    this.revPre = ac.createBiquadFilter(); this.revPre.type = 'highpass'; this.revPre.frequency.value = 110;
    this.revIn.connect(this.revPre);
    this.revPre.connect(this.convA).connect(this.convGA).connect(this.revOut);
    this.revPre.connect(this.convB).connect(this.convGB).connect(this.revOut);
    this.revOut.connect(this.sfxIn);
    this._buildER();
    this.busIn = { sfx: this.sfxIn, amb: this.ambIn, music: this.musicIn, ui: this.uiVol, voice: this.voiceVol, master: this.master };
  }

  // ---------------------------------------------------------------------------- early reflections
  /**
   * Geometry-aware early reflections ("slapback"): one tap per environment-probe direction. Each tap is a
   * DelayNode (2d / c), a lowpass (air + surface), a gain (distance + surface reflectivity) and a stereo pan
   * derived from the wall direction relative to the listener (updated every frame as the camera turns).
   * Fed by loud sounds (own weapon, near explosions); the diffuse field stays in the convolver.
   */
  _buildER() {
    const ac = this.ac;
    this.erIn = ac.createGain();
    this.erHP = ac.createBiquadFilter(); this.erHP.type = 'highpass'; this.erHP.frequency.value = 90; this.erHP.Q.value = 0.5;
    this.erIn.connect(this.erHP);
    this.erTaps = [];
    for (let i = 0; i < 9; i++) {
      const d = ac.createDelay(0.6);
      const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 0.4; f.frequency.value = 4000;
      const g = ac.createGain(); g.gain.value = 0;
      const p = ac.createStereoPanner ? ac.createStereoPanner() : null;
      this.erHP.connect(d); d.connect(f); f.connect(g);
      if (p) { g.connect(p); p.connect(this.sfxIn); } else g.connect(this.sfxIn);
      // a little of each reflection feeds the diffuse reverb (reflections excite the space too)
      g.connect(this.revIn);
      this.erTaps.push({ d, f, g, p, dist: 0, gain: 0, fc: 4000, dir: { x: 0, y: 0, z: 0 }, on: false });
    }
  }

  /** i: tap index, dist: meters (null/Infinity = open), refl: 0..1 surface reflectivity, dir: unit world vector. */
  setReflection(i, dist, refl = 0.85, dir = null, tc = 0.08) {
    const T = this.erTaps[i];
    if (!T) return;
    const t = this.ac.currentTime;
    const on = dist != null && isFinite(dist) && dist > 0.6 && dist < 90;
    if (dir) { T.dir.x = dir.x; T.dir.y = dir.y; T.dir.z = dir.z; }
    if (!on) {
      T.on = false; T.gain = 0;
      if (tc > 0) T.g.gain.setTargetAtTime(0, t, tc); else T.g.gain.value = 0;
      return;
    }
    const delay = Math.min(0.58, (2 * dist) / C_SOUND);
    const gain = 0.34 * refl * Math.pow(1 + (2 * dist) / 6, -0.8);
    const fc = clamp(11000 / (1 + (2 * dist) / 45) * (0.45 + 0.55 * refl), 700, 12000);
    T.on = true; T.dist = dist; T.gain = gain; T.fc = fc;
    if (tc > 0) {
      T.d.delayTime.setTargetAtTime(delay, t, tc);
      T.g.gain.setTargetAtTime(gain, t, tc);
    } else { T.d.delayTime.value = delay; T.g.gain.value = gain; }
  }

  /** Per-frame: pan / head-shadow each reflection relative to where the listener faces. */
  _updateER(tc = 0.05) {
    if (!this.erTaps) return;
    const L = this.listener, t = this.ac.currentTime;
    for (const T of this.erTaps) {
      if (!T.on) continue;
      const side = T.dir.x * L.right.x + T.dir.y * L.right.y + T.dir.z * L.right.z;
      const front = T.dir.x * L.fwd.x + T.dir.y * L.fwd.y + T.dir.z * L.fwd.z;
      const fc = T.fc * (front < 0 ? 0.62 + 0.38 * (1 + front) : 1);
      if (tc > 0) {
        if (T.p) T.p.pan.setTargetAtTime(clamp(side * 0.85, -0.85, 0.85), t, tc);
        T.f.frequency.setTargetAtTime(fc, t, tc);
      } else {
        if (T.p) T.p.pan.value = clamp(side * 0.85, -0.85, 0.85);
        T.f.frequency.value = fc;
      }
    }
  }

  /** Bus volume (settings). 'master' | 'sfx' | 'music' | 'voice' | 'ui' | 'ambience' */
  setBusVolume(bus, v) {
    const n = { master: this.master, sfx: this.sfxVol, music: this.musicVol, voice: this.voiceVol, ui: this.uiVol, ambience: this.ambVol, amb: this.ambVol }[bus];
    if (n) n.gain.setTargetAtTime(v, this.ac.currentTime, 0.05);
  }

  // ---------------------------------------------------------------------------- environment
  /** Switch reverb preset with an A/B crossfade. level scales the wet amount (0..1.5). */
  setEnvironment(name, fade = 0.8, level = 1) {
    if (!IR_PRESETS[name]) return;
    const t = this.ac.currentTime;
    this.envSend = level;
    if (name === this.env) return;
    const buf = this.bank.irBuffer(this.ac, name);
    if (!buf) return;
    const useA = this.envActive === 1 || this.env === null;
    const conv = useA ? this.convA : this.convB;
    try { conv.buffer = buf; } catch { return; }
    const gIn = useA ? this.convGA : this.convGB, gOut = useA ? this.convGB : this.convGA;
    if (this.env === null) { gIn.gain.value = 1; gOut.gain.value = 0; }
    else {
      gIn.gain.cancelScheduledValues(t); gOut.gain.cancelScheduledValues(t);
      gIn.gain.setValueAtTime(gIn.gain.value, t); gOut.gain.setValueAtTime(gOut.gain.value, t);
      gIn.gain.linearRampToValueAtTime(1, t + fade); gOut.gain.linearRampToValueAtTime(0, t + fade);
    }
    this.envActive = useA ? 0 : 1;
    this.env = name;
    const AMB = { room: [900, 0.45], hall: [1600, 0.6], alley: [9000, 0.9], street: [20000, 1], open: [20000, 1.1] }[name] || [20000, 1];
    const tc = Math.max(0.01, fade * 0.4);
    this.ambFilter.frequency.setTargetAtTime(AMB[0], t, tc);
    this.ambEnv.gain.setTargetAtTime(AMB[1], t, tc);
  }

  // ---------------------------------------------------------------------------- listener
  setListener(pos, fwd, up) {
    const L = this.listener;
    L.pos.x = pos.x; L.pos.y = pos.y; L.pos.z = pos.z;
    L.fwd.x = fwd.x; L.fwd.y = fwd.y; L.fwd.z = fwd.z;
    L.up.x = up.x; L.up.y = up.y; L.up.z = up.z;
    // right = fwd x up
    L.right.x = fwd.y * up.z - fwd.z * up.y; L.right.y = fwd.z * up.x - fwd.x * up.z; L.right.z = fwd.x * up.y - fwd.y * up.x;
    const al = this.ac.listener;
    if (al.positionX) {
      al.positionX.value = pos.x; al.positionY.value = pos.y; al.positionZ.value = pos.z;
      al.forwardX.value = fwd.x; al.forwardY.value = fwd.y; al.forwardZ.value = fwd.z;
      al.upX.value = up.x; al.upY.value = up.y; al.upZ.value = up.z;
    } else {
      al.setPosition(pos.x, pos.y, pos.z);
      al.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  distanceTo(p) {
    const L = this.listener.pos;
    const dx = p.x - L.x, dy = p.y - L.y, dz = p.z - L.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // ---------------------------------------------------------------------------- core play
  /**
   * opts: volume, pitch, loop, bus, delay, at (absolute ctx time), position {x,y,z}, variant, send,
   *       pan (-1..1, 2D only), lowpass (Hz), propagate (default true for positional one-shots),
   *       distGain (override distance attenuation), priority, offset (s), fadeIn (s)
   */
  play(name, opts = {}) {
    const def = catalog[name];
    if (!def) {
      if (!this.warned.has(name)) { this.warned.add(name); console.warn(`[system:audio] unknown sound "${name}"`); }
      return NULL_HANDLE;
    }
    let bufs = this.bank.buffers(this.ac, name);
    if (!bufs && this.onMissing) { this.onMissing(name); bufs = this.bank.buffers(this.ac, name); }
    if (!bufs) { this.stats.skipped++; return NULL_HANDLE; }
    const ac = this.ac;
    const pos = opts.position || null;
    // stabilize: a non-finite position throws inside AudioParam setters and kills the calling event listener
    if (pos && !Number.isFinite(pos.x + pos.y + pos.z)) { this.stats.skipped++; return NULL_HANDLE; }
    const loop = opts.loop ?? !!def.loop;
    let d = 0;
    if (pos) {
      d = this.distanceTo(pos);
      const max = def.spatial?.max ?? 200;
      if (d > max && !loop) return NULL_HANDLE;
    }
    const priority = opts.priority ?? def.priority ?? 50;
    // timing: explicit time, delay, speed-of-sound propagation for positional one-shots (context time)
    let when = (opts.at != null ? opts.at - this.timeBase : ac.currentTime) + (opts.at != null ? 0 : opts.delay || 0);
    if (pos && !loop && opts.propagate !== false) when += d / C_SOUND;
    when = Math.max(when, ac.currentTime);
    if (!this._admit(def.group || name, def.maxVoices ?? 8, priority, when)) { this.stats.skipped++; return NULL_HANDLE; }

    // variant: no immediate repeat
    let vi = opts.variant ?? 0;
    if (opts.variant == null && bufs.length > 1) {
      const last = this.lastVariant.get(name) ?? -1;
      vi = Math.floor(this.rng.next() * (bufs.length - 1));
      if (vi >= last) vi++;
      vi = Math.min(vi, bufs.length - 1);
    }
    this.lastVariant.set(name, vi);
    const buffer = bufs[vi];

    const v = new Voice(this, name, def);
    v.loop = loop; v.priority = priority;
    const pv = def.pitchVar ?? 0, vv = def.volVar ?? 0;
    const rate = (opts.pitch ?? 1) * Math.pow(2, ((this.rng.next() * 2 - 1) * pv) / 12);
    v.rate0 = rate / (opts.pitch ?? 1);
    v.baseGain = (def.vol ?? 1) * (opts.volume ?? 1) * dbToGain((this.rng.next() * 2 - 1) * vv);

    const src = ac.createBufferSource();
    src.buffer = buffer; src.loop = loop; src.playbackRate.value = rate;
    const g = ac.createGain();
    v.src = src; v.gain = g;
    src.connect(g);
    let tail = g;

    const bus = opts.bus || def.bus || 'sfx';
    const out = this.busIn[bus] || this.sfxIn;
    let sendAmt = (opts.send ?? def.reverb ?? 0) * this.envSend;
    if (bus === 'ui' || bus === 'music') sendAmt = 0;

    if (pos) {
      v.pos = { x: pos.x, y: pos.y, z: pos.z };
      v.tracked = !!loop;
      const f = ac.createBiquadFilter();
      f.type = 'lowpass'; f.Q.value = 0.5;
      const p = ac.createPanner();
      p.panningModel = this.hrtf && d < 45 ? 'HRTF' : 'equalpower';
      p.distanceModel = 'linear'; p.rolloffFactor = 0; p.refDistance = 1; p.maxDistance = 10000;
      if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } else p.setPosition(pos.x, pos.y, pos.z);
      tail.connect(f); f.connect(p); p.connect(out);
      v.filter = f; v.panner = p;
      v.distOverride = opts.distGain;
      v.baseSend = sendAmt;
      if (sendAmt > 0.001) { v.send = ac.createGain(); f.connect(v.send); v.send.connect(this.revIn); }
      if (opts.er > 0.001) { v.erSend = ac.createGain(); v.erSend.gain.value = opts.er; g.connect(v.erSend); v.erSend.connect(this.erIn); }
      this.occlusionFor(v);
      v.occ = v.occTarget;
      this._spatialUpdate(v, 0);
    } else {
      if (opts.lowpass) {
        const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = opts.lowpass; f.Q.value = 0.5;
        tail.connect(f); tail = f; v.filter = f;
      }
      if (opts.pan && ac.createStereoPanner) {
        const sp = ac.createStereoPanner(); sp.pan.value = clamp(opts.pan, -1, 1);
        tail.connect(sp); tail = sp; v.panner = sp;
      }
      tail.connect(out);
      if (sendAmt > 0.001) { v.send = ac.createGain(); v.send.gain.value = sendAmt; tail.connect(v.send); v.send.connect(this.revIn); }
      const er = opts.er ?? def.er ?? 0;
      if (er > 0.001) { v.erSend = ac.createGain(); v.erSend.gain.value = er; tail.connect(v.erSend); v.erSend.connect(this.erIn); }
      v.distGain = 1;
    }

    const gv = v.baseGain * v.userVol * v.distGain;
    if (opts.fadeIn) { g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(gv, when + opts.fadeIn); }
    else g.gain.value = gv;
    const off = (opts.offset || 0) % buffer.duration;
    src.start(when, off);
    v.startAt = when;
    v.endAt = loop ? Infinity : when + (buffer.duration - off) / rate;
    src.onended = () => v._cleanup();
    this.voices.push(v);
    this.groups.set(v.group, (this.groups.get(v.group) || 0) + 1);
    this.stats.played++;
    if (def.duck && !opts.noDuck) this.duck(def.duckDb ?? -6, 0.15, 1.2, when);
    return v;
  }

  playAt(name, position, opts = {}) { return this.play(name, { ...opts, position }); }

  /**
   * Voice limiting on the TIMELINE: voices are counted only if they overlap `when` (so sounds scheduled ahead,
   * e.g. speed-of-sound delays or offline scenes, don't steal each other). Per group: steal the oldest.
   * Globally: steal the lowest priority (then oldest) non-loop voice, or refuse if the newcomer ranks lower.
   */
  _admit(group, max, priority, when) {
    let n = 0, total = 0, old = null, low = null;
    for (const v of this.voices) {
      if (!v.alive || v.startAt > when + 0.002 || v.endAt <= when) continue;
      total++;
      if (v.group === group) { n++; if (!old || v.startAt < old.startAt) old = v; }
      if (!v.loop && (!low || v.priority < low.priority || (v.priority === low.priority && v.startAt < low.startAt))) low = v;
    }
    if (n >= max && old) { this._steal(old, when); if (low === old) low = null; total--; }
    if (total >= this.maxVoices) {
      if (!low || low.priority > priority) return false;
      this._steal(low, when);
    }
    return true;
  }

  _steal(v, when) {
    v.stop(0.03, when);
    v.endAt = Math.min(v.endAt, when + 0.04);
    this.stats.stolen++;
  }

  _remove(v) {
    const i = this.voices.indexOf(v);
    if (i >= 0) {
      this.voices.splice(i, 1);
      this.groups.set(v.group, Math.max(0, (this.groups.get(v.group) || 1) - 1));
    }
  }

  /** Distance attenuation curve for a def at distance d (meters). */
  distGainFor(def, d) {
    const ref = def.spatial?.ref ?? 3;
    const max = def.spatial?.max ?? 200;
    const g = ref / (ref + Math.max(0, d - ref) * (def.spatial?.rolloff ?? 1));
    return g * (1 - smoothstep(max * 0.6, max, d));
  }

  occlusionFor(v) {
    if (!this.occlude || !v.pos) { v.occTarget = 0; return; }
    try { v.occTarget = clamp(this.occlude(v.pos, v) || 0, 0, 1); } catch { v.occTarget = 0; }
  }

  /** Recompute distance gain, air absorption, occlusion filter, send and panner model. */
  _spatialUpdate(v, tc) {
    const d = this.distanceTo(v.pos);
    const t = this.ac.currentTime;
    const occ = v.occ;
    v.distGain = (v.distOverride ?? this.distGainFor(v.def, d)) * (1 - 0.5 * occ);
    // air absorption: gentle, ~8 kHz at 100 m, ~1.3 kHz at 1 km; occlusion pulls toward ~650 Hz
    let fc = Math.min(20000, 21000 / Math.pow(1 + d / 85, 1.1));
    fc *= Math.pow(650 / 20000, occ);
    const pos = v.pos;
    if (tc > 0) {
      v.filter.frequency.setTargetAtTime(fc, t, tc);
      if (v.panner.positionX) { v.panner.positionX.setTargetAtTime(pos.x, t, tc); v.panner.positionY.setTargetAtTime(pos.y, t, tc); v.panner.positionZ.setTargetAtTime(pos.z, t, tc); }
      else v.panner.setPosition(pos.x, pos.y, pos.z);
    } else {
      v.filter.frequency.value = fc;
      if (v.panner.positionX) { v.panner.positionX.value = pos.x; v.panner.positionY.value = pos.y; v.panner.positionZ.value = pos.z; }
    }
    if (v.send) {
      const s = v.baseSend * (0.65 + 0.7 * smoothstep(0, 60, d)) * (1 + 0.8 * occ);
      if (tc > 0) v.send.gain.setTargetAtTime(s, t, tc); else v.send.gain.value = s;
    }
    const want = this.hrtf && d < 45 ? 'HRTF' : 'equalpower';
    if (v.panner.panningModel !== want) v.panner.panningModel = want;
    if (tc > 0) v._applyGain(tc);
  }

  /** Per-frame: move tracked voices, smooth occlusion, reap finished voices. */
  update(occlusionBudget = 2) {
    const t = this.ac.currentTime;
    this._updateER();
    let budget = occlusionBudget;
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (!v.loop && t > v.endAt + 0.5) { v._cleanup(); continue; }
      if (v.pos && v.tracked && v.alive) {
        if (budget > 0 && ((this._occTick = (this._occTick || 0) + 1) % 7 === 0)) { this.occlusionFor(v); budget--; }
        v.occ += (v.occTarget - v.occ) * 0.15;
        this._spatialUpdate(v, 0.06);
      }
    }
  }

  stopAll(fade = 0.1) { for (const v of this.voices.slice()) v.stop(fade); }

  // ---------------------------------------------------------------------------- mix automation
  _auto(param, target, t, tc) {
    param.cancelScheduledValues(t);
    param.setTargetAtTime(target, t, tc);
  }

  /** Duck ambience & music (and a little sfx) for loud events. */
  duck(db = -6, attack = 0.08, hold = 1, at = this.now()) {
    at = Math.max(this.ac.currentTime, at - this.timeBase);
    const g = dbToGain(db);
    for (const n of [this.ambDuck.gain, this.musicDuck.gain]) {
      try {
        if (n.cancelAndHoldAtTime) n.cancelAndHoldAtTime(at); else n.cancelScheduledValues(at);
        n.setTargetAtTime(Math.min(g, n.value), at, attack * 0.3);
        n.setTargetAtTime(1, at + hold, 0.6);
      } catch { /* ignore */ }
    }
  }

  /** Explosion concussion: muffle the world, ring the ears. strength 0..1 */
  concussion(strength = 1, at = this.now()) {
    const s = clamp(strength, 0, 1);
    const at0 = at;
    at = Math.max(this.ac.currentTime, at - this.timeBase);
    this.concussUntil = at + 1.5 + 3 * s;
    const f = this.sfxFilter.frequency;
    try {
      if (f.cancelAndHoldAtTime) f.cancelAndHoldAtTime(at); else f.cancelScheduledValues(at);
      f.setTargetAtTime(Math.max(250, 2200 * (1 - s) + 280 * s), at, 0.02);
      f.setTargetAtTime(this._restFilter(), at + 0.6 + 1.6 * s, 0.9 + 0.8 * s);
      const d = this.sfxDuck.gain;
      d.cancelScheduledValues(at);
      d.setTargetAtTime(dbToGain(-10 * s), at, 0.02);
      d.setTargetAtTime(1, at + 0.5 + s, 0.8);
    } catch { /* ignore */ }
    if (s > 0.25) this.play('tinnitus', { at: at0 + 0.05, volume: 0.4 + 0.6 * s, fadeIn: 0.15 });
  }

  _restFilter() { return this.muffled ? 450 : this.lowHealth > 0 ? 20000 - 13000 * this.lowHealth : 20000; }

  /** 0 = healthy .. 1 = nearly dead: muffles sfx slightly and drives the heartbeat. */
  setLowHealth(k) {
    k = clamp(k, 0, 1);
    if (Math.abs(k - this.lowHealth) < 0.02) return;
    this.lowHealth = k;
    const t = this.ac.currentTime;
    if (t > this.concussUntil) this._auto(this.sfxFilter.frequency, this._restFilter(), t, 0.4);
    if (k > 0.05) {
      if (!this.heart || !this.heart.alive) this.heart = this.play('heartbeat', { loop: true, fadeIn: 0.8 });
      this.heart.setVolume(0.35 + 0.65 * k);
      this.heart.setPitch(1 + 0.45 * k);
    } else if (this.heart) { this.heart.stop(1.2); this.heart = null; }
  }

  /** Death / menu muffle. */
  setMuffled(on) {
    this.muffled = !!on;
    this._auto(this.sfxFilter.frequency, this._restFilter(), this.ac.currentTime, on ? 0.25 : 0.8);
  }

  // ---------------------------------------------------------------------------- game sound logic
  /** Player's own weapon. */
  playerShot({ weaponId = 'rifle', suppressed = false, ammoFrac = 1, surface = 'concrete', feet = null, at } = {}) {
    const cls = weaponClass(weaponId);
    const name = suppressed && catalog[`${cls}_fire_suppressed`] ? `${cls}_fire_suppressed` : `${cls}_fire`;
    const h = this.play(name, { at });
    if (ammoFrac <= 0.2 && ammoFrac > 0) this.play('low_ammo_tick', { at, volume: 0.5 + (0.2 - ammoFrac) * 2.5 });
    this.duck(suppressed ? -3 : -7, 0.02, 0.35, at);
    // brass hits the floor ~0.4-0.7 s later near the feet, to the right
    if (feet && cls !== 'shotgun' && this.autoCasings !== false) {
      const s = footSurface(surface);
      const cs = s === 'metal' ? 'metal' : s === 'wood' ? 'wood' : (s === 'dirt' || s === 'grass' || s === 'gravel' || s === 'water') ? 'dirt' : 'concrete';
      const R = this.listener.right;
      const cp = { x: feet.x + R.x * 0.7 + (this.rng.next() - 0.5) * 0.6, y: feet.y + 0.02, z: feet.z + R.z * 0.7 + (this.rng.next() - 0.5) * 0.6 };
      const base = at ?? this.now();
      this.play(`shell_casing_${cs}`, { position: cp, at: base + 0.42 + this.rng.next() * 0.25, propagate: false });
    }
    return h;
  }

  /**
   * Someone else's shot. Layers 3P (close) and FAR versions by distance, delays by the speed of sound,
   * and, when `dir` is given, adds the supersonic snap + whizz if the round passes near the listener
   * (the snap arrives BEFORE the report, as in reality).
   */
  remoteShot({ origin, dir = null, weaponId = 'rifle', suppressed = false, at, targetsListener = false } = {}) {
    const cls = weaponClass(weaponId);
    const d = this.distanceTo(origin);
    const t0 = at ?? this.now();
    const nearName = suppressed && catalog[`${cls}_fire_suppressed_3p`] ? `${cls}_fire_suppressed_3p` : `${cls}_fire_3p`;
    const farName = `${cls}_fire_far`;
    const nearDef = catalog[nearName], farDef = catalog[farName];
    const gNear = this.distGainFor(nearDef, d) * (1 - smoothstep(35, 180, d));
    const gFar = suppressed ? 0 : 0.8 * smoothstep(12, 80, d) * (40 / (40 + Math.max(0, d - 40) * 0.7));
    if (gNear > 0.003) this.play(nearName, { position: origin, at: t0, distGain: gNear, er: suppressed ? 0 : 0.45 * clamp(1 - d / 30, 0, 1) });
    if (gFar > 0.003) this.play(farName, { position: origin, at: t0, distGain: gFar, noDuck: true });
    if (!suppressed && d < 60) this.duck(-3 * (1 - d / 60), 0.03, 0.3, t0 + d / C_SOUND);
    if (dir || targetsListener) this.flyby(origin, dir, { at: t0, supersonic: cls !== 'pistol' && cls !== 'smg' && !suppressed, forceNear: targetsListener });
  }

  /** Bullet passing the listener: snap (supersonic) + stereo whizz. */
  flyby(origin, dir, { at, supersonic = true, forceNear = false } = {}) {
    const L = this.listener.pos;
    let miss, along, sideSign;
    if (dir) {
      const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
      const dx = dir.x / len, dy = dir.y / len, dz = dir.z / len;
      const ox = L.x - origin.x, oy = L.y - origin.y, oz = L.z - origin.z;
      along = ox * dx + oy * dy + oz * dz;
      if (along < 2) return false; // listener is behind the shooter / too close
      const cx = origin.x + dx * along - L.x, cy = origin.y + dy * along - L.y, cz = origin.z + dz * along - L.z;
      miss = Math.hypot(cx, cy, cz);
      const R = this.listener.right;
      sideSign = cx * R.x + cy * R.y + cz * R.z >= 0 ? 1 : -1;
      // direction of travel across the listener: L->R if the bullet moves along +right
      this._flyDir = dx * R.x + dy * R.y + dz * R.z;
    } else if (forceNear) {
      along = this.distanceTo(origin); miss = 1.2 + this.rng.next() * 2; sideSign = this.rng.next() < 0.5 ? -1 : 1; this._flyDir = sideSign;
    } else return false;
    if (!(miss <= 6) || !Number.isFinite(along)) return false; // also rejects NaN (degenerate listener/dir)
    const t0 = (at ?? this.now()) + along / BULLET_SPEED;
    this.lastFlyby = t0;
    const k = 1 - miss / 6;
    const R = this.listener.right;
    const p = { x: L.x + R.x * sideSign * Math.max(0.6, miss), y: L.y + 0.2, z: L.z + R.z * sideSign * Math.max(0.6, miss) };
    if (supersonic) this.play('bullet_snap', { position: p, at: t0, propagate: false, volume: 0.35 + 0.65 * k, distGain: 1 });
    const whizz = (this._flyDir ?? sideSign) >= 0 ? 'bullet_whizz_l2r' : 'bullet_whizz_r2l';
    this.play(whizz, { at: t0 - 0.12, volume: (supersonic ? 0.55 : 0.9) * k * k + 0.1 });
    return true;
  }

  /** Bullet impact at a point. fromListener=true for the player's own hits (quieter, less tail). */
  impact({ point, surface = 'concrete', flesh = false, at, near = false } = {}) {
    const s = flesh ? 'flesh' : impactSurface(surface);
    const name = `impact_${s}`;
    const d = this.distanceTo(point);
    const h = this.play(name, { position: point, at, volume: near ? 1.4 : 1 });
    if ((s === 'concrete' || s === 'metal' || s === 'brick') && this.rng.next() < (s === 'metal' ? 0.3 : 0.12) && d < 60) {
      this.play('ricochet', { position: point, at: (at ?? this.now()) + 0.005 });
    }
    return h;
  }

  explosion({ position, radius = 6, at } = {}) {
    const d = this.distanceTo(position);
    const t0 = at ?? this.now();
    const nearDef = catalog.explosion_grenade;
    const gNear = this.distGainFor(nearDef, d) * (1 - smoothstep(80, 400, d));
    const gFar = smoothstep(40, 160, d) * (80 / (80 + Math.max(0, d - 80) * 0.6));
    if (gNear > 0.003) this.play('explosion_grenade', { position, at: t0, distGain: Math.min(1.2, gNear * 1.4), er: 0.6 * clamp(1 - d / 80, 0, 1) });
    if (gFar > 0.003) this.play('explosion_far', { position, at: t0, distGain: gFar });
    const arrive = t0 + d / C_SOUND;
    this.duck(-12 * clamp(1 - d / 150, 0.2, 1), 0.02, 1.5, arrive);
    const conc = clamp(1 - d / (radius * 2.6), 0, 1);
    if (conc > 0.05) this.concussion(conc, arrive);
    return d;
  }

  footstep({ surface = 'concrete', position = null, speed = 3, stance = 'stand', own = false, at } = {}) {
    const s = footSurface(surface);
    const kind = stance === 'crouch' || stance === 'prone' ? '_crouch' : speed > 5.2 ? '_run' : '';
    const name = `footstep_${s}${kind}`;
    const vol = own ? 0.75 : 1;
    let h;
    if (own || !position) {
      // own feet: 2D, alternating slight L/R, a touch darker
      this._foot = -(this._foot || 1);
      h = this.play(name, { at, pan: this._foot * 0.12, volume: vol, send: 0.08 });
      if (kind === '_run' && this.rng.next() < 0.5) this.play('gear_rattle', { at, volume: 0.45, pan: this._foot * -0.2 });
    } else {
      h = this.play(name, { position, at, volume: vol * (kind === '_run' ? 1.2 : 1) });
    }
    return h;
  }
}

export { NULL_HANDLE };

#!/usr/bin/env node
/**
 * Offline, deterministic texture generator for the weapons system.
 *   node tools/weapons/gen-textures.mjs
 * Writes RGB PNGs into public/assets/weapons/tex/ (all tileable):
 *   wpn_grunge.png   (linear) R = fbm noise, G = scratches, B = smudges / fingerprints
 *   wpn_detail.png   (linear) R = fabric twill weave height, G = leather/grain cells, B = stipple dots
 *   multicam.png     (sRGB)   original 5-colour multi-terrain camo pattern
 *   wpn_marks.png    (linear) R = engraved receiver markings mask (text/logo, original)
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/assets/weapons/tex');
fs.mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ PNG
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePNG(file, w, h, rgb /* Float32Array 0..1, 3 per px */) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w * 3; x++) {
      const v = rgb[y * w * 3 + x];
      raw[y * (w * 3 + 1) + 1 + x] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path.join(OUT, file), png);
  console.log('wrote', file, (png.length / 1024).toFixed(0) + ' KB');
}

// ------------------------------------------------------------------ RNG / noise
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(x, y, s) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
/** periodic value noise, period P cells, u,v in [0,1) texture space */
function vnoise(u, v, P, seed) {
  const x = u * P, y = v * P;
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = fade(x - xi), fy = fade(y - yi);
  const m = (a) => ((a % P) + P) % P;
  const a = hash2(m(xi), m(yi), seed), b = hash2(m(xi + 1), m(yi), seed);
  const c = hash2(m(xi), m(yi + 1), seed), d = hash2(m(xi + 1), m(yi + 1), seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(u, v, P, oct, seed, gain = 0.5) {
  let s = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < oct; o++) {
    s += amp * vnoise(u, v, P << o, seed + o * 101);
    norm += amp; amp *= gain;
  }
  return s / norm;
}
/** periodic worley F1, returns distance in cell units */
function worley(u, v, P, seed) {
  const x = u * P, y = v * P;
  const xi = Math.floor(x), yi = Math.floor(y);
  let d1 = 9, d2 = 9;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = xi + i, cy = yi + j;
    const mx = ((cx % P) + P) % P, my = ((cy % P) + P) % P;
    const px = cx + hash2(mx, my, seed), py = cy + hash2(mx, my, seed + 7);
    const d = Math.hypot(px - x, py - y);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return [d1, d2];
}
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ wpn_grunge
function grunge() {
  const N = 1024;
  const img = new Float32Array(N * N * 3);
  // R: fbm
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N;
    const n = fbm(u, v, 4, 7, 11, 0.55);
    img[(y * N + x) * 3] = n;
  }
  // G: scratches (anti-aliased line segments, wrapping)
  const scr = new Float32Array(N * N);
  const rnd = mulberry(77);
  const drawLine = (x0, y0, x1, y1, w, a) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.ceil(len * 2);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t;
      const taper = Math.sin(Math.PI * t) ** 0.6;
      const ww = w * taper;
      const r = Math.ceil(ww + 1);
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        const qx = Math.floor(px) + i, qy = Math.floor(py) + j;
        const d = Math.hypot(qx + 0.5 - px, qy + 0.5 - py);
        const c = Math.max(0, 1 - Math.max(0, d - ww * 0.5)) * a * taper;
        if (c <= 0) continue;
        const k = ((qy % N) + N) % N * N + ((qx % N) + N) % N;
        scr[k] = Math.max(scr[k], c);
      }
    }
  };
  // long faint scratches, clustered directions (handling wear) + short sharp nicks
  for (let i = 0; i < 520; i++) {
    const x = rnd() * N, y = rnd() * N;
    const cluster = Math.floor(rnd() * 4);
    const ang = [0.3, 1.9, 2.6, 0.9][cluster] + (rnd() - 0.5) * 0.5;
    const len = 20 + rnd() ** 2 * 260;
    // slightly curved: two segments
    const bend = (rnd() - 0.5) * 0.25;
    const mx = x + Math.cos(ang) * len * 0.5, my = y + Math.sin(ang) * len * 0.5;
    drawLine(x, y, mx, my, 0.6 + rnd() * 0.9, 0.25 + rnd() * 0.6);
    drawLine(mx, my, mx + Math.cos(ang + bend) * len * 0.5, my + Math.sin(ang + bend) * len * 0.5, 0.6 + rnd() * 0.9, 0.25 + rnd() * 0.6);
  }
  for (let i = 0; i < 900; i++) {
    const x = rnd() * N, y = rnd() * N, ang = rnd() * Math.PI * 2, len = 2 + rnd() * 10;
    drawLine(x, y, x + Math.cos(ang) * len, y + Math.sin(ang) * len, 0.8 + rnd(), 0.4 + rnd() * 0.6);
  }
  for (let k = 0; k < N * N; k++) img[k * 3 + 1] = scr[k];
  // B: smudges / fingerprints
  const smu = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N;
    smu[y * N + x] = smooth(0.52, 0.8, fbm(u + 0.37, v + 0.11, 3, 5, 303, 0.5)) * 0.55;
  }
  for (let i = 0; i < 22; i++) {
    // fingerprint: elliptical ridge rings with noisy falloff
    const cx = rnd() * N, cy = rnd() * N, rx = 26 + rnd() * 20, ry = rx * (1.25 + rnd() * 0.3);
    const rot = rnd() * Math.PI, cr = Math.cos(rot), sr = Math.sin(rot);
    const strength = 0.3 + rnd() * 0.35;
    const R = Math.ceil(ry * 1.3);
    for (let j = -R; j <= R; j++) for (let ii = -R; ii <= R; ii++) {
      const qx = ii * cr + j * sr, qy = -ii * sr + j * cr;
      const e = Math.hypot(qx / rx, qy / ry);
      if (e > 1.2) continue;
      const ridge = 0.72 + 0.28 * Math.sin(e * rx * 2.6 + fbm(((cx + ii) / N + 1) % 1, ((cy + j) / N + 1) % 1, 16, 2, 5) * 9);
      const fall = smooth(1.15, 0.55, e) * (0.6 + 0.4 * fbm(((cx + ii) / N + 1) % 1, ((cy + j) / N + 1) % 1, 8, 3, 9));
      const k = (((Math.floor(cy) + j) % N + N) % N) * N + (((Math.floor(cx) + ii) % N + N) % N);
      smu[k] = Math.max(smu[k], ridge * fall * strength);
    }
  }
  for (let k = 0; k < N * N; k++) img[k * 3 + 2] = smu[k];
  writePNG('wpn_grunge.png', N, N, img);
}

// ------------------------------------------------------------------ wpn_detail
function detail() {
  const N = 512;
  const img = new Float32Array(N * N * 3);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N;
    // R: 2/1 twill weave: threads 32 across the tile
    const T = 32;
    const tx = u * T, ty = v * T;
    const ix = Math.floor(tx), iy = Math.floor(ty);
    const fx = tx - ix, fy = ty - iy;
    const warpUp = ((ix + iy) % 3) !== 0; // twill diagonal
    const warp = Math.sin(Math.PI * fx) ** 0.7 * (0.75 + 0.25 * Math.sin(Math.PI * fy));
    const weft = Math.sin(Math.PI * fy) ** 0.7 * (0.75 + 0.25 * Math.sin(Math.PI * fx));
    let h = warpUp ? 0.35 + 0.65 * warp : 0.3 + 0.6 * weft;
    h *= 0.85 + 0.15 * fbm(u, v, 64, 2, 17);
    img[(y * N + x) * 3] = h;
    // G: leather / synthetic grain: worley cells with creases
    const [d1, d2] = worley(u, v, 48, 5);
    const cell = smooth(0.0, 0.12, d2 - d1);
    img[(y * N + x) * 3 + 1] = 0.25 + 0.6 * cell + 0.15 * fbm(u, v, 32, 3, 91);
    // B: stipple texture (random dimples, dense), used on polymer grips
    const [s1] = worley(u, v, 64, 23);
    const [s2] = worley(u + 0.5, v + 0.5, 41, 29);
    img[(y * N + x) * 3 + 2] = 0.5 * smooth(0.55, 0.15, s1) + 0.5 * smooth(0.5, 0.1, s2);
  }
  writePNG('wpn_detail.png', N, N, img);
}

// ------------------------------------------------------------------ multicam (original pattern)
function multicam() {
  const N = 1024;
  const img = new Float32Array(N * N * 3);
  const hex = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
  const base = hex(0xa89a74);
  const layers = [
    { col: hex(0xc2b58f), P: 3, oct: 5, seed: 1, t: 0.60, warp: 0.10 },   // light sand patches
    { col: hex(0x7d7a50), P: 4, oct: 5, seed: 2, t: 0.58, warp: 0.12 },   // khaki green
    { col: hex(0x5d6139), P: 4, oct: 5, seed: 3, t: 0.62, warp: 0.10 },   // olive
    { col: hex(0x6f553a), P: 5, oct: 5, seed: 4, t: 0.64, warp: 0.10 },   // brown
    { col: hex(0x3b3124), P: 7, oct: 4, seed: 5, t: 0.70, warp: 0.08 },   // dark brown specks
    { col: hex(0xd8ceb0), P: 9, oct: 3, seed: 6, t: 0.74, warp: 0.05 },   // cream branches
  ];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N;
    let c = base.slice();
    for (const L of layers) {
      const wu = u + (fbm(u, v, 4, 3, L.seed * 13) - 0.5) * L.warp * 2;
      const wv = v + (fbm(u + 0.3, v + 0.7, 4, 3, L.seed * 17) - 0.5) * L.warp * 2;
      const n = fbm(((wu % 1) + 1) % 1, ((wv % 1) + 1) % 1, L.P, L.oct, L.seed * 31, 0.55);
      const a = smooth(L.t - 0.012, L.t + 0.012, n);
      if (a > 0) for (let k = 0; k < 3; k++) c[k] = c[k] * (1 - a) + L.col[k] * a;
    }
    // printed-fabric irregularity
    const g = 0.92 + 0.08 * fbm(u, v, 128, 2, 999);
    for (let k = 0; k < 3; k++) img[(y * N + x) * 3 + k] = c[k] * g;
  }
  writePNG('multicam.png', N, N, img);
}

run();
function run() {
  const which = process.argv.slice(2);
  const all = { grunge, detail, multicam };
  for (const [k, f] of Object.entries(all)) if (!which.length || which.includes(k)) f();
}

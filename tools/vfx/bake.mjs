#!/usr/bin/env node
// Offline VFX texture baker for Opus of Duty (owner: vfx).
//   node tools/vfx/bake.mjs [smoke|flash|decals|noise|all]
// Writes deterministic PNG atlases into public/assets/vfx/:
//   smoke_a.png / smoke_b.png  4x4 atlas of 256px volumetric smoke sprites, "6-way" light maps
//                              A = (+X, +Y, +Z(front), alpha)   B = (-X, -Y, -Z(back), heat)   (sqrt-encoded)
//   flash.png                  4x4 atlas (grayscale, sqrt-encoded) of muzzle-flash shapes
//   decal_color.png / decal_normal.png   2048 atlas: 16 bullet holes (256px) + 12 large cells (512px)
//   noise.png                  256px tileable RGBA noise (fbm, fbm, worley, fine)
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writePNG } from './png.mjs';
import { bakeFlashAtlas } from './flash.mjs';
import { makeSimplex, makePeriodic, mulberry32, clamp, smoothstep, mix } from './noise.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../../public/assets/vfx');
fs.mkdirSync(OUT, { recursive: true });
const what = process.argv[2] || 'all';

// ------------------------------------------------------------------------------------------ smoke
async function bakeSmoke() {
  const cells = [];
  for (let i = 0; i < 16; i++) {
    const type = i < 8 ? 'billow' : i < 12 ? 'wisp' : 'dust';
    cells.push({ type, seed: 1000 + i * 37 });
  }
  const R = 256, AW = R * 4;
  const A = new Uint8Array(AW * AW * 4), B = new Uint8Array(AW * AW * 4);
  const t0 = Date.now();
  await Promise.all(cells.map((c, i) => new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'smoke-cell.mjs'), { workerData: { ...c, R, RZ: 128 } });
    w.on('message', (res) => {
      const cx = (i % 4) * R, cy = Math.floor(i / 4) * R;
      for (let y = 0; y < R; y++) {
        for (let x = 0; x < R; x++) {
          const s = (y * R + x) * 4, d = ((cy + y) * AW + cx + x) * 4;
          for (let k = 0; k < 4; k++) { A[d + k] = res.A[s + k]; B[d + k] = res.B[s + k]; }
        }
      }
      resolve();
    });
    w.on('error', reject);
  })));
  writePNG(path.join(OUT, 'smoke_a.png'), A, AW, AW, 4);
  writePNG(path.join(OUT, 'smoke_b.png'), B, AW, AW, 4);
  // preview: lit from upper-left-front
  const P = new Uint8Array(AW * AW * 3);
  for (let i = 0; i < AW * AW; i++) {
    const dec = (v) => (v / 255) ** 2;
    const lx = -0.6, ly = 0.6, lz = 0.5;
    const l = 0.2 * dec(A[i * 4 + 1]) + lz * lz * dec(A[i * 4 + 2]) + lx * lx * dec(B[i * 4]) + ly * ly * dec(A[i * 4 + 1]);
    const a = A[i * 4 + 3] / 255;
    const v = clamp(l * 1.2) * a + 0.15 * (1 - a);
    P[i * 3] = P[i * 3 + 1] = P[i * 3 + 2] = Math.round(Math.sqrt(v) * 255);
  }
  writePNG(path.join(__dirname, 'preview_smoke.png'), P, AW, AW, 3);
  console.log(`smoke baked in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ------------------------------------------------------------------------------------------ flash
function bakeFlash() { bakeFlashAtlas(OUT, __dirname); }

// ------------------------------------------------------------------------------------------ decals
function bakeDecals() {
  const AW = 2048;
  const col = new Float32Array(AW * AW * 4);
  const hgt = new Float32Array(AW * AW);
  const nstr = new Float32Array(AW * AW); // normal strength per texel
  const S = makeSimplex(4242);
  const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

  /** fn(u, v) -> [r, g, b, a, h] in sRGB-ish 0..1 */
  function cell(x0, y0, size, strength, fn) {
    const px = [0, 0, 0, 0, 0];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1, v = 1 - ((y + 0.5) / size) * 2;
      px[0] = px[1] = px[2] = px[3] = px[4] = 0;
      fn(u, v, px);
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
      const fadeEdge = clamp(edge / 4);
      const i = (y0 + y) * AW + x0 + x;
      col[i * 4] = px[0]; col[i * 4 + 1] = px[1]; col[i * 4 + 2] = px[2]; col[i * 4 + 3] = clamp(px[3]) * fadeEdge;
      hgt[i] = px[4] * fadeEdge;
      nstr[i] = strength;
    }
  }

  // Common: jagged radius function
  const jag = (th, seed, amp, freq = 3, oct = 3) => 1 + amp * S.fbm2(Math.cos(th) * freq + seed, Math.sin(th) * freq + seed * 0.37, oct, 2.0, 0.42);

  function holeCrater(seed, p) {
    // p: { hole, crater, rim, craterCol:[r,g,b], dust:[r,g,b], haloA, cracks, craterJag }
    const rnd = mulberry32(seed);
    const cracks = [];
    for (let i = 0; i < p.cracks; i++) cracks.push([rnd() * Math.PI * 2, 0.45 + rnd() * 0.45, 0.004 + rnd() * 0.005]);
    return (u, v, o) => {
      const r = Math.hypot(u, v), th = Math.atan2(v, u);
      const holeR = p.hole * jag(th, seed, 0.25, 2);
      const craterR = p.crater * jag(th, seed + 3, p.craterJag, 3.5);
      const speck = S.noise2(u * 60 + seed, v * 60);
      const grain = 0.5 + 0.5 * S.fbm2(u * 14 + seed, v * 14, 4);
      let r0 = 0, g0 = 0, b0 = 0, a = 0, h = 0;
      if (r < craterR) {
        const t = smoothstep(holeR, craterR, r);
        const shade = mix(0.35, 1, Math.pow(t, 0.7));
        r0 = p.craterCol[0] * shade * (0.8 + 0.35 * grain + 0.1 * speck);
        g0 = p.craterCol[1] * shade * (0.8 + 0.35 * grain + 0.1 * speck);
        b0 = p.craterCol[2] * shade * (0.8 + 0.35 * grain + 0.1 * speck);
        a = smoothstep(craterR, craterR - 0.025, r);
        h = -0.7 * Math.pow(1 - t, 1.4) + 0.12 * grain + 0.05 * speck;
      }
      if (r < holeR) {
        const t = r / holeR;
        const d = 0.02 + 0.05 * t * t;
        r0 = mix(d, r0, smoothstep(0.75, 1, t)); g0 = mix(d * 0.95, g0, smoothstep(0.75, 1, t)); b0 = mix(d * 0.9, b0, smoothstep(0.75, 1, t));
        a = 1;
        h = -1;
      }
      // dust halo
      if (r >= craterR * 0.9) {
        const hn = 0.5 + 0.5 * S.fbm2(u * 6 + seed * 0.3, v * 6, 4);
        const halo = p.haloA * Math.pow(clamp(1 - (r - craterR) / (0.92 - craterR)), 1.6) * (0.4 + 0.9 * hn) * (0.7 + 0.3 * speck);
        if (halo > a) {
          const k = a > 0 ? a : 0;
          r0 = mix(p.dust[0], r0, k); g0 = mix(p.dust[1], g0, k); b0 = mix(p.dust[2], b0, k);
          a = Math.max(a, halo);
        }
      }
      // radial cracks
      for (const [ang, len, w] of cracks) {
        if (r < craterR * 0.8 || r > len) continue;
        const a2 = ang + 0.25 * S.noise2(r * 5 + ang * 10, ang);
        const d = Math.abs(angDiff(th, a2)) * r;
        const ww = w * (1 - r / len) + 0.002;
        const c = Math.exp(-((d / ww) ** 2)) * (1 - r / len);
        if (c > 0.02) {
          r0 = mix(r0, 0.05, c * (a > 0 ? 1 : 1)); g0 = mix(g0, 0.05, c); b0 = mix(b0, 0.05, c);
          a = Math.max(a, c * 0.85);
          h -= c * 0.3;
        }
      }
      o[0] = r0; o[1] = g0; o[2] = b0; o[3] = a; o[4] = h;
    };
  }

  function metalHole(seed) {
    const rnd = mulberry32(seed);
    const petals = 5 + Math.floor(rnd() * 4);
    const off = rnd() * 6;
    return (u, v, o) => {
      const r = Math.hypot(u, v), th = Math.atan2(v, u);
      const holeR = 0.12 * (1 + 0.08 * Math.sin(th * petals + off));
      const rimR = holeR + 0.05 + 0.02 * S.noise2(Math.cos(th) * 4 + seed, Math.sin(th) * 4);
      const chipR = 0.3 * jag(th, seed, 0.45, 3);
      const n = 0.5 + 0.5 * S.fbm2(u * 20 + seed, v * 20, 3);
      let c = [0, 0, 0], a = 0, h = 0;
      if (r < chipR) {
        // paint chipped -> bare/primer steel with scratches
        const t = smoothstep(rimR, chipR, r);
        const scratch = Math.pow(Math.abs(S.noise2(th * 8, r * 30 + seed)), 6);
        const base = 0.42 + 0.18 * n + 0.2 * scratch;
        c = [base, base * 0.98, base * 0.95];
        a = smoothstep(chipR, chipR - 0.02, r);
        h = 0.05 * n;
        // soot/lead smear darkening near the rim
        const soot = (1 - t) * 0.65;
        c = c.map((x) => x * (1 - soot));
      }
      if (r < rimR) {
        const t = (r - holeR) / (rimR - holeR);
        const bright = 0.4 + 0.18 * Math.sin(t * Math.PI);
        c = [bright, bright * 0.97, bright * 0.93];
        a = 1;
        h = -0.25 * (1 - t) - 0.1;
      }
      if (r < holeR) { c = [0.015, 0.015, 0.015]; a = 1; h = -1; }
      // outer soot halo
      if (r >= chipR * 0.95) {
        const halo = 0.35 * Math.pow(clamp(1 - (r - chipR) / 0.5), 2) * (0.5 + n);
        if (halo > a) { c = [0.08, 0.075, 0.07]; a = halo; }
      }
      o[0] = c[0]; o[1] = c[1]; o[2] = c[2]; o[3] = a; o[4] = h;
    };
  }

  function woodHole(seed) {
    return (u, v, o) => {
      const e = Math.hypot(u / 0.09, v / 0.14);
      const th = Math.atan2(v, u);
      const fib = 0.5 + 0.5 * S.fbm2(u * 28 + seed, v * 2.5, 4);
      const fib2 = 0.5 + 0.5 * S.fbm2(u * 55 + seed, v * 4, 3);
      const zone = Math.hypot(u / 0.26, v / (0.5 + 0.35 * fib)) * jag(th, seed, 0.3, 3);
      let c = [0, 0, 0], a = 0, h = 0;
      if (zone < 1) {
        const t = zone;
        const w = 0.7 + 0.3 * fib2;
        c = [0.74 * w, 0.58 * w, 0.4 * w];
        c = c.map((x) => x * mix(0.55, 1, t));
        a = smoothstep(1, 0.9, zone) * (fib > 0.35 || zone < 0.6 ? 1 : 0.4);
        h = 0.35 * fib2 * (1 - t) + 0.1 * fib;
      }
      if (e < 1) { const d = 0.03 + 0.05 * e * e; c = [d * 1.1, d * 0.85, d * 0.6]; a = 1; h = -1; }
      // fine splinter strands along grain
      const strand = Math.pow(clamp(S.noise2(u * 70 + seed, v * 3)), 3) * smoothstep(1.6, 0.9, zone);
      if (strand > 0.05 && a < 0.9) { c = [0.8, 0.66, 0.46]; a = Math.max(a, strand); h += strand * 0.3; }
      o[0] = c[0]; o[1] = c[1]; o[2] = c[2]; o[3] = a; o[4] = h;
    };
  }

  function glassCrack(seed) {
    const rnd = mulberry32(seed);
    const radials = [];
    const n = 11 + Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) radials.push([(i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.4, 0.45 + rnd() * 0.5, rnd() * 10]);
    const rings = [0.14 + rnd() * 0.05, 0.25 + rnd() * 0.08, 0.4 + rnd() * 0.1];
    return (u, v, o) => {
      const r = Math.hypot(u, v), th = Math.atan2(v, u);
      let a = 0, h = 0;
      for (const [ang, len, s] of radials) {
        if (r > len) continue;
        const a2 = ang + 0.12 * S.noise2(r * 4 + s, s);
        const d = Math.abs(angDiff(th, a2)) * r;
        const w = 0.006 * (1 - 0.6 * r / len) + 0.0025;
        const c = Math.exp(-((d / w) ** 2)) * smoothstep(len, len * 0.7, r);
        a = Math.max(a, c);
      }
      for (const rr of rings) {
        const rj = rr * (1 + 0.1 * S.noise2(Math.cos(th) * 3 + rr * 9, Math.sin(th) * 3));
        const d = Math.abs(r - rj);
        const seg = S.noise2(th * 3 + rr * 20, rr) > -0.1 ? 1 : 0;
        a = Math.max(a, Math.exp(-((d / 0.005) ** 2)) * seg * 0.85);
      }
      const crush = smoothstep(0.1, 0.05, r * jag(th, seed, 0.3, 4));
      a = Math.max(a, crush * 0.95);
      h = a * 0.5;
      const cc = 0.82 + 0.1 * crush;
      o[0] = cc; o[1] = cc; o[2] = cc * 1.02; o[3] = a * 0.9; o[4] = h;
      if (r < 0.03) { o[0] = o[1] = o[2] = 0.15; o[3] = 1; o[4] = -1; }
    };
  }

  function dirtHole(seed) {
    return (u, v, o) => {
      const r = Math.hypot(u, v), th = Math.atan2(v, u);
      const n = 0.5 + 0.5 * S.fbm2(u * 10 + seed, v * 10, 4);
      const cr = 0.3 * jag(th, seed, 0.35, 3);
      let c = [0.14, 0.11, 0.085], a = 0, h = 0;
      if (r < cr) { const t = r / cr; c = c.map((x) => x * mix(0.35, 1.05, t) * (0.8 + 0.4 * n)); a = smoothstep(1, 0.75, t); h = -0.8 * (1 - t) ** 1.5 + 0.2 * n; }
      // thrown clods / specks
      const sp = S.noise2(u * 35 + seed, v * 35);
      const ring = smoothstep(0.85, 0.3, r);
      if (sp > 0.55 && ring > 0 && r >= cr * 0.8) { const k = smoothstep(0.55, 0.7, sp) * ring; if (k > a) { c = [0.12, 0.095, 0.075]; a = k; h = 0.4 * k; } }
      o[0] = c[0]; o[1] = c[1]; o[2] = c[2]; o[3] = a; o[4] = h;
    };
  }

  // ---- bullet holes: 16 cells of 256 in rows 0..511 (8 cols x 2 rows)
  // Voronoi helper: nearest feature point (returns id hash, f1, f2)
  function vor(x, y, seed) {
    const xi = Math.floor(x), yi = Math.floor(y);
    let f1 = 9, f2 = 9, id = 0, cx = 0, cy = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const gx = xi + i, gy = yi + j;
      let h = Math.imul(gx * 73856093 ^ gy * 19349663 ^ seed * 83492791, 0x27d4eb2d);
      h = (h ^ (h >>> 15)) >>> 0;
      const px = gx + (h % 1000) / 1000, py = gy + ((h >>> 10) % 1000) / 1000;
      const d = Math.hypot(px - x, py - y);
      if (d < f1) { f2 = f1; f1 = d; id = h; cx = px; cy = py; } else if (d < f2) f2 = d;
    }
    return { f1, f2, id, cx, cy };
  }

  /**
   * Spalled bullet hole for brittle materials (concrete, brick, plaster, tile, asphalt).
   * Reads as: a small, deep, dark bore; a funnel-shaped crater of freshly fractured material whose walls are
   * made of angular chips (voronoi facets, each a tilted plane in the height map) with aggregate grains; a thin
   * dark lead/soot smudge on the lip; a faint pale powder halo and a couple of hairline cracks. Colours stay close
   * to the host material (only slightly paler, never paper-white) so the height/normal map carries the shape.
   */
  function spall(seed, p) {
    // p: { hole, crater, col:[r,g,b] fresh material, soot:[r,g,b], sootA, dust:[r,g,b], dustA, cracks, facet }
    const rnd = mulberry32(seed);
    const cracks = [];
    for (let i = 0; i < p.cracks; i++) cracks.push([rnd() * Math.PI * 2, 0.5 + rnd() * 0.35, rnd() * 10]);
    const lobes = [rnd() * 6.28, rnd() * 6.28, 0.1 + rnd() * 0.12, 0.06 + rnd() * 0.1, rnd() * 6.28];
    const ox = (rnd() - 0.5) * 0.04, oy = (rnd() - 0.5) * 0.04;
    return (u, v, o) => {
      const r = Math.hypot(u, v), th = Math.atan2(v, u);
      // irregular crater outline: low-frequency lobes + chipped (voronoi) edge
      const lobe = 1 + lobes[2] * Math.cos(th * 2 + lobes[0]) + lobes[3] * Math.cos(th * 3 + lobes[1]) + 0.05 * Math.cos(th * 5 + lobes[4])
        + 0.12 * S.fbm2(Math.cos(th) * 1.8 + seed, Math.sin(th) * 1.8, 3);
      const cR = p.crater * lobe;
      const vc = vor(u * p.facet, v * p.facet, seed);
      const cellR = Math.hypot(vc.cx / p.facet, vc.cy / p.facet);
      const inChip = cellR < cR * 0.92;
      const hr = Math.hypot(u - ox, v - oy);
      const holeR = p.hole * (1 + 0.25 * S.noise2(Math.cos(th) * 2 + seed * 3, Math.sin(th) * 2));
      const grain = 0.5 + 0.5 * S.fbm2(u * 26 + seed, v * 26, 3);
      const agg = vor(u * 34, v * 34, seed + 7); // aggregate pebbles
      const pebble = smoothstep(0.32, 0.18, agg.f1) * (((agg.id >>> 5) % 100) / 100);
      let c0 = 0, c1 = 0, c2 = 0, a = 0, h = 0;
      if (inChip || r < cR * 0.62) {
        const t = clamp((r - holeR) / Math.max(cR - holeR, 1e-3));
        // facet: each chip is a tilted plane -> strong, crisp normal-map breakup
        const tiltX = (((vc.id >>> 3) % 200) / 100 - 1) * 0.45, tiltY = (((vc.id >>> 11) % 200) / 100 - 1) * 0.45;
        const facet = tiltX * (u * p.facet - vc.cx) + tiltY * (v * p.facet - vc.cy);
        const depth = -1.0 * Math.pow(1 - t, 1.6);
        h = depth + facet * 0.3 + 0.07 * grain + 0.1 * pebble;
        // fractured surface: slightly paler than the weathered skin, darker (in shadow) deeper in the funnel
        const shade = (0.5 + 0.5 * Math.pow(t, 0.6)) * (0.82 + 0.3 * grain) * (1 - 0.18 * pebble) * (0.9 + 0.2 * (((vc.id >>> 17) % 100) / 100));
        c0 = p.col[0] * shade; c1 = p.col[1] * shade; c2 = p.col[2] * shade;
        // chip boundaries read as thin dark fissures
        const edge = smoothstep(0.07, 0.0, vc.f2 - vc.f1) * smoothstep(0.0, 0.3, t);
        c0 *= 1 - edge * 0.35; c1 *= 1 - edge * 0.35; c2 *= 1 - edge * 0.35;
        h -= edge * 0.12;
        // soft outer lip so the crater blends into the host surface
        a = smoothstep(1.0, 0.8, cellR / Math.max(cR, 1e-3)) * 0.4 + 0.6;
        if (!inChip) a = smoothstep(cR * 0.62, cR * 0.5, r);
      }
      // bore: dark, with a charred ring
      if (hr < holeR * 1.8) {
        const t = clamp(hr / (holeR * 1.8));
        const k = smoothstep(0.4, 1.0, t);
        const d = 0.018 + 0.05 * t * t;
        c0 = mix(d, c0 || d, k); c1 = mix(d * 0.95, c1 || d, k); c2 = mix(d * 0.9, c2 || d, k);
        a = Math.max(a, 1 - k * (1 - a)); h = Math.min(h, -1.15 + t * 0.5);
      }
      // outside the crater: lead/soot smudge on the lip, then a faint pale powder halo
      if (a < 0.999) {
        const hn = 0.5 + 0.5 * S.fbm2(u * 6 + seed * 0.3, v * 6, 4);
        const rr = (r - cR * 0.85) / Math.max(0.95 - cR * 0.85, 1e-3);
        const soot = p.sootA * 0.75 * Math.pow(clamp(1 - rr * 3.0), 1.6) * (0.45 + 0.75 * hn);
        const dust = p.dustA * Math.pow(clamp(1 - rr), 1.8) * smoothstep(0.25, 0.75, hn + 0.25 * S.noise2(u * 40 + seed, v * 40));
        const k = Math.max(soot, dust);
        if (k > 0.004) {
          const w = soot >= dust ? 1 : 0;
          const cr = w ? p.soot : p.dust;
          const blend = a;
          c0 = mix(cr[0], c0, blend); c1 = mix(cr[1], c1, blend); c2 = mix(cr[2], c2, blend);
          a = a + (1 - a) * k;
          h += 0.015 * hn * (1 - blend);
        }
      }
      for (const [ang, len, s] of cracks) {
        if (r < cR * 0.8 || r > len) continue;
        const a2 = ang + 0.35 * S.noise2(r * 7 + s, s);
        const d = Math.abs(angDiff(th, a2)) * r;
        const w = 0.004 * (1 - r / len) + 0.0012;
        const c = Math.exp(-((d / w) ** 2)) * (1 - r / len);
        if (c > 0.03) { c0 = mix(c0, 0.05, c * (a > 0.5 ? 0.6 : 1)); c1 = mix(c1, 0.05, c * (a > 0.5 ? 0.6 : 1)); c2 = mix(c2, 0.05, c * (a > 0.5 ? 0.6 : 1)); a = Math.max(a, c * 0.75); h -= c * 0.25; }
      }
      o[0] = c0; o[1] = c1; o[2] = c2; o[3] = a; o[4] = h;
    };
  }

  const BH = [
    spall(11, { hole: 0.065, crater: 0.34, col: [0.66, 0.65, 0.62], soot: [0.11, 0.105, 0.1], sootA: 0.55, dust: [0.8, 0.79, 0.76], dustA: 0.22, cracks: 3, facet: 10 }),
    spall(12, { hole: 0.06, crater: 0.29, col: [0.63, 0.62, 0.59], soot: [0.12, 0.115, 0.11], sootA: 0.5, dust: [0.78, 0.77, 0.74], dustA: 0.2, cracks: 2, facet: 12 }),
    spall(13, { hole: 0.07, crater: 0.4, col: [0.67, 0.66, 0.63], soot: [0.1, 0.1, 0.095], sootA: 0.55, dust: [0.8, 0.79, 0.76], dustA: 0.24, cracks: 4, facet: 9 }),
    spall(14, { hole: 0.065, crater: 0.34, col: [0.7, 0.38, 0.25], soot: [0.16, 0.1, 0.08], sootA: 0.5, dust: [0.72, 0.5, 0.4], dustA: 0.22, cracks: 2, facet: 10 }),
    spall(15, { hole: 0.06, crater: 0.3, col: [0.66, 0.35, 0.23], soot: [0.16, 0.1, 0.08], sootA: 0.45, dust: [0.7, 0.48, 0.38], dustA: 0.2, cracks: 1, facet: 11 }),
    spall(16, { hole: 0.065, crater: 0.42, col: [0.86, 0.85, 0.81], soot: [0.22, 0.21, 0.2], sootA: 0.38, dust: [0.92, 0.91, 0.88], dustA: 0.3, cracks: 2, facet: 8 }),
    spall(17, { hole: 0.065, crater: 0.38, col: [0.84, 0.82, 0.78], soot: [0.22, 0.21, 0.2], sootA: 0.38, dust: [0.92, 0.91, 0.88], dustA: 0.3, cracks: 3, facet: 9 }),
    metalHole(21), metalHole(22), metalHole(23),
    woodHole(31), woodHole(32),
    glassCrack(41), glassCrack(42),
    dirtHole(51),
    spall(18, { hole: 0.065, crater: 0.3, col: [0.3, 0.295, 0.29], soot: [0.1, 0.1, 0.1], sootA: 0.55, dust: [0.55, 0.55, 0.54], dustA: 0.25, cracks: 1, facet: 10 }),
  ];
  BH.forEach((fn, i) => cell((i % 8) * 256, Math.floor(i / 8) * 256, 256, i === 12 || i === 13 ? 2 : 5, fn));

  // ---- large cells 512px: 4 cols x 3 rows from y=512
  /**
   * Back-spatter from a bullet wound on a wall: an irregular (not star-shaped) wet impact blot, a fan of
   * directional droplets that elongate into teardrops away from it, and a fine mist of specks. Thick areas are
   * darker (coffee-ring edge darkening + drying), thin areas are brighter red and more transparent.
   */
  function bloodSplat(seed, spray = 1) {
    const rnd = mulberry32(seed);
    const drops = [];
    const nd = Math.round(55 * spray);
    for (let i = 0; i < nd; i++) {
      const ang = (rnd() - 0.5) * 1.3 * (0.4 + rnd());
      const dist = 0.12 + Math.pow(rnd(), 0.9) * 0.95;
      const rad = (0.045 * (1 - dist * 0.75) + 0.006) * (0.3 + rnd() * 0.9);
      drops.push([-0.5 + Math.cos(ang) * dist, Math.sin(ang) * dist * 0.85, rad, ang + (rnd() - 0.5) * 0.3, 1.5 + dist * 3.5 * rnd()]);
    }
    const mist = [];
    for (let i = 0; i < 260 * spray; i++) {
      const ang = (rnd() - 0.5) * 1.8;
      const dist = 0.1 + Math.pow(rnd(), 0.7) * 1.0;
      mist.push([-0.5 + Math.cos(ang) * dist, Math.sin(ang) * dist * 0.9, 0.0035 + rnd() * 0.006]);
    }
    const mainR = 0.13 + rnd() * 0.07;
    return (u, v, o) => {
      // main blot: fbm-warped disc (smooth, organic outline)
      const wx = S.fbm2(u * 3 + seed, v * 3, 3) * 0.08, wy = S.fbm2(u * 3, v * 3 + seed, 3) * 0.08;
      const bx = u + 0.5 + wx, by = v + wy;
      const rm = Math.hypot(bx * 0.85, by) / mainR;
      let f = clamp(1 - rm) * 1.8;
      for (const [x, y, r, ang, el] of drops) {
        const dx = u - x, dy = v - y;
        if (Math.abs(dx) > r * el + 0.02 || Math.abs(dy) > r * el + 0.02) continue;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const along = dx * ca + dy * sa, across = -dx * sa + dy * ca;
        // teardrop: round head, tail pointing back toward the source
        const tail = along < 0 ? along / el : along * 1.1;
        const d = Math.hypot(tail, across) / r;
        if (d < 1.4) f = Math.max(f, (1 - d) * 1.4);
      }
      let m = 0;
      for (const [x, y, r] of mist) {
        const dx = u - x, dy = v - y;
        if (Math.abs(dx) > r || Math.abs(dy) > r) continue;
        const d = Math.hypot(dx, dy) / r;
        if (d < 1) m = Math.max(m, 1 - d);
      }
      const n = S.fbm2(u * 11 + seed, v * 11, 3);
      const a = Math.max(smoothstep(0.02, 0.09, f + n * 0.02), smoothstep(0.1, 0.5, m) * 0.85);
      const thick = clamp(f * 1.1);
      // coffee-ring: edges of thick areas darker
      const ring = smoothstep(0.05, 0.2, f) * smoothstep(0.45, 0.2, f) * 0.35;
      const dark = mix(0.5, 0.25, thick) * (1 - ring) * (0.92 + 0.12 * n);
      o[0] = 0.66 * dark; o[1] = 0.03 * dark; o[2] = 0.028 * dark;
      o[3] = a * mix(0.9, 1.0, Math.sqrt(thick));
      o[4] = thick * 0.5;
    };
  }
  function bloodPool(seed) {
    return (u, v, o) => {
      const r = Math.hypot(u, v), th = Math.atan2(v, u);
      const wx = S.fbm2(u * 2.5 + seed, v * 2.5, 3) * 0.14, wy = S.fbm2(u * 2.5, v * 2.5 + seed, 3) * 0.14;
      const rr = Math.hypot(u + wx, (v + wy) * 1.15) / 0.66;
      const n = S.fbm2(u * 7 + seed, v * 7, 4);
      const a = smoothstep(1, 0.93, rr + n * 0.05);
      const thick = clamp(1 - rr);
      o[0] = mix(0.34, 0.2, thick); o[1] = 0.015; o[2] = 0.015; o[3] = a * 0.95; o[4] = Math.sqrt(thick) * 0.7;
    };
  }
  function bloodMist(seed) {
    const rnd = mulberry32(seed);
    const drops = [];
    for (let i = 0; i < 380; i++) { const a = rnd() * Math.PI * 2, d = Math.pow(rnd(), 0.6) * 0.85; drops.push([Math.cos(a) * d, Math.sin(a) * d, 0.004 + rnd() * 0.02 * (1 - d)]); }
    return (u, v, o) => {
      let f = 0;
      for (const [x, y, r] of drops) { const d = Math.hypot(u - x, v - y) / r; if (d < 1) f = Math.max(f, 1 - d); }
      const r = Math.hypot(u, v);
      const haze = 0.25 * Math.pow(clamp(1 - r / 0.8), 2) * (0.6 + 0.4 * S.fbm2(u * 8 + seed, v * 8, 3));
      o[0] = 0.4; o[1] = 0.025; o[2] = 0.02; o[3] = Math.max(smoothstep(0.05, 0.3, f), haze); o[4] = f * 0.4;
    };
  }
  function bloodDrip(seed) {
    const rnd = mulberry32(seed);
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push([(rnd() - 0.5) * 0.5, 0.2 + rnd() * 0.75, 0.012 + rnd() * 0.02]);
    return (u, v, o) => {
      const th = Math.atan2(v - 0.45, u);
      const wx2 = S.fbm2(u * 3 + seed, v * 3, 3) * 0.08;
      let f = Math.max(0, 1 - Math.hypot(u + wx2, (v - 0.45) * 1.2) / 0.26) * 1.5;
      for (const [x, len, w] of runs) {
        const t = (0.45 - v) / len;
        if (t < 0 || t > 1.05) continue;
        const ww = w * (1 - 0.5 * t) * (t > 0.95 ? 1.6 : 1);
        const xx = x + 0.02 * S.noise2(v * 6 + x * 10, 1);
        f = Math.max(f, 1 - Math.abs(u - xx) / ww);
      }
      const n = S.fbm2(u * 9 + seed, v * 9, 3);
      const a = smoothstep(0.02, 0.12, f + n * 0.03);
      const thick = clamp(f);
      o[0] = mix(0.46, 0.26, thick); o[1] = 0.025; o[2] = 0.02; o[3] = a * 0.95; o[4] = thick * 0.5;
    };
  }
  /**
   * Blast scorch: a soot-blackened core with a blotchy (fbm) outline, a charred shallow pit, a paler ash/dust
   * annulus, low-contrast radial soot streaks only at the rim and scattered fragment pock marks. On dirt: a
   * real crater (darker, damp-looking soil) with thrown clods around it.
   */
  function scorch(seed, dirt = false) {
    const rnd = mulberry32(seed);
    const ph = rnd() * 10;
    const pocks = [];
    for (let i = 0; i < 70; i++) { const a = rnd() * Math.PI * 2, d = 0.18 + Math.pow(rnd(), 0.7) * 0.72; pocks.push([Math.cos(a) * d, Math.sin(a) * d, 0.004 + rnd() * 0.012]); }
    return (u, v, o) => {
      const r = Math.hypot(u, v), th = Math.atan2(v, u);
      const wx = S.fbm2(u * 2.2 + ph, v * 2.2, 4) * 0.16, wy = S.fbm2(u * 2.2, v * 2.2 + ph, 4) * 0.16;
      const rw = Math.hypot(u + wx, v + wy);
      const n = 0.5 + 0.5 * S.fbm2(u * 9 + seed, v * 9, 5);
      const nf = 0.5 + 0.5 * S.fbm2(u * 28 + seed, v * 28, 3);
      const streak = Math.pow(0.5 + 0.5 * S.fbm2(Math.cos(th) * 7 + ph, Math.sin(th) * 7 + rw * 1.5, 2), 2.5);
      // soot density: dense core, blotchy falloff, streaks extend it at the rim
      let soot = smoothstep(0.62, 0.12, rw) * (0.7 + 0.45 * n);
      soot = Math.max(soot, streak * smoothstep(0.85, 0.35, rw) * 0.75 * (0.6 + 0.4 * n));
      soot = clamp(soot);
      // ash / dust annulus
      const ash = smoothstep(0.35, 0.55, rw) * smoothstep(0.95, 0.6, rw) * (0.25 + 0.5 * nf) * 0.5;
      let c = dirt ? [0.075, 0.06, 0.045] : [0.045, 0.04, 0.036];
      const ashC = dirt ? [0.34, 0.29, 0.23] : [0.46, 0.44, 0.41];
      let a = clamp(soot * 1.1);
      if (ash > soot * 0.6) { const k = clamp(ash / (ash + soot * 0.6 + 1e-3)); c = [mix(c[0], ashC[0], k), mix(c[1], ashC[1], k), mix(c[2], ashC[2], k)]; a = Math.max(a, ash); }
      // centre: slightly lighter, grey pulverised pit
      const pit = smoothstep(0.2, 0.0, rw);
      c = c.map((x, i) => mix(x, (dirt ? [0.1, 0.08, 0.06] : [0.12, 0.115, 0.11])[i], pit * 0.6 * nf));
      let h = dirt ? -0.9 * smoothstep(0.5, 0.0, rw) + 0.25 * n : -0.35 * smoothstep(0.3, 0.0, rw) + 0.12 * n + 0.1 * nf;
      if (dirt) {
        // thrown soil clods on the rim
        const cl = S.noise2(u * 18 + seed, v * 18);
        const rimk = smoothstep(0.35, 0.55, rw) * smoothstep(0.9, 0.6, rw);
        if (cl > 0.45 && rimk > 0) { const k = smoothstep(0.45, 0.7, cl) * rimk; c = [mix(c[0], 0.11, k), mix(c[1], 0.085, k), mix(c[2], 0.06, k)]; a = Math.max(a, k); h += 0.5 * k; }
      }
      for (const [x, y, pr] of pocks) {
        const d = Math.hypot(u - x, v - y) / pr;
        if (d < 1) { const k = 1 - d; c = [mix(c[0], 0.03, k), mix(c[1], 0.03, k), mix(c[2], 0.03, k)]; a = Math.max(a, k * 0.9); h -= k * 0.5; }
      }
      a *= smoothstep(0.99, 0.85, r);
      o[0] = c[0] * (0.85 + 0.3 * nf); o[1] = c[1] * (0.85 + 0.3 * nf); o[2] = c[2] * (0.85 + 0.3 * nf); o[3] = a; o[4] = h;
    };
  }
  function soot(seed) {
    return (u, v, o) => {
      const r = Math.hypot(u, v);
      const n = 0.5 + 0.5 * S.fbm2(u * 5 + seed, v * 5, 5);
      const a = clamp(Math.pow(clamp(1 - r / 0.9), 1.5) * (0.3 + 0.9 * n)) * 0.6;
      o[0] = 0.05; o[1] = 0.045; o[2] = 0.04; o[3] = a; o[4] = 0;
    };
  }
  const LG = [bloodSplat(61), bloodSplat(62), bloodSplat(63, 1.4), bloodSplat(64, 0.6), bloodPool(65), bloodMist(66),
    scorch(71), scorch(72), scorch(73), scorch(74, true), soot(75), bloodDrip(67)];
  LG.forEach((fn, i) => cell((i % 4) * 512, 512 + Math.floor(i / 4) * 512, 512, i >= 6 && i <= 9 ? 2.5 : i < 6 || i === 11 ? 1.5 : 1, fn));

  // encode color (sRGB space values already) + normals
  const C8 = new Uint8Array(AW * AW * 4), N8 = new Uint8Array(AW * AW * 3);
  for (let i = 0; i < AW * AW; i++) {
    C8[i * 4] = Math.round(clamp(col[i * 4]) * 255);
    C8[i * 4 + 1] = Math.round(clamp(col[i * 4 + 1]) * 255);
    C8[i * 4 + 2] = Math.round(clamp(col[i * 4 + 2]) * 255);
    C8[i * 4 + 3] = Math.round(clamp(col[i * 4 + 3]) * 255);
  }
  // dilate color into transparent texels (avoid dark fringes under bilinear/mips)
  for (let pass = 0; pass < 6; pass++) {
    for (let y = 1; y < AW - 1; y++) for (let x = 1; x < AW - 1; x++) {
      const i = y * AW + x;
      if (C8[i * 4 + 3] > 8) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (const j of [i - 1, i + 1, i - AW, i + AW]) if (C8[j * 4 + 3] > 8) { r += C8[j * 4]; g += C8[j * 4 + 1]; b += C8[j * 4 + 2]; n++; }
      if (n) { C8[i * 4] = r / n; C8[i * 4 + 1] = g / n; C8[i * 4 + 2] = b / n; C8[i * 4 + 3] = Math.max(C8[i * 4 + 3], 9 - 1); }
    }
  }
  for (let y = 0; y < AW; y++) for (let x = 0; x < AW; x++) {
    const i = y * AW + x;
    const hl = hgt[y * AW + Math.max(0, x - 1)], hr = hgt[y * AW + Math.min(AW - 1, x + 1)];
    const hu = hgt[Math.max(0, y - 1) * AW + x], hd = hgt[Math.min(AW - 1, y + 1) * AW + x];
    const s = nstr[i];
    let nx = (hl - hr) * s, ny = (hd - hu) * s, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    N8[i * 3] = Math.round((nx * 0.5 + 0.5) * 255);
    N8[i * 3 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    N8[i * 3 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
  }
  writePNG(path.join(OUT, 'decal_color.png'), C8, AW, AW, 4);
  writePNG(path.join(OUT, 'decal_normal.png'), N8, AW, AW, 3);
  // preview composited over grey
  const P = new Uint8Array(AW * AW * 3);
  for (let i = 0; i < AW * AW; i++) {
    const a = C8[i * 4 + 3] / 255;
    for (let k = 0; k < 3; k++) P[i * 3 + k] = Math.round(C8[i * 4 + k] * a + 128 * (1 - a));
  }
  writePNG(path.join(__dirname, 'preview_decals.png'), P, AW, AW, 3);
  console.log('decals baked');
}

// ------------------------------------------------------------------------------------------ noise
function bakeNoise() {
  const R = 256;
  const P1 = makePeriodic(9), P2 = makePeriodic(19), P3 = makePeriodic(29), P4 = makePeriodic(39);
  const img = new Uint8Array(R * R * 4);
  for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
    const u = x / R, v = y / R;
    const i = (y * R + x) * 4;
    img[i] = Math.round(clamp(0.5 + 0.5 * P1.fbm(u * 4, v * 4, 4, 5)) * 255);
    img[i + 1] = Math.round(clamp(0.5 + 0.5 * P2.fbm(u * 8, v * 8, 8, 4)) * 255);
    const [f1] = P3.worley(u * 8, v * 8, 8);
    img[i + 2] = Math.round(clamp(1 - f1 * 1.3) * 255);
    img[i + 3] = Math.round(clamp(0.5 + 0.5 * P4.fbm(u * 16, v * 16, 16, 3)) * 255);
  }
  writePNG(path.join(OUT, 'noise.png'), img, R, R, 4);
  console.log('noise baked');
}

const jobs = { smoke: bakeSmoke, flash: bakeFlash, decals: bakeDecals, noise: bakeNoise };
if (what === 'all') { for (const k of Object.keys(jobs)) await jobs[k](); }
else if (jobs[what]) await jobs[what]();
else { console.error('unknown target', what); process.exit(1); }

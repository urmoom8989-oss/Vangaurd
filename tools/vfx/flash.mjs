// Muzzle-flash atlas baker (4x4 cells of 256 px, grayscale, sqrt-encoded; the shader squares it and maps
// intensity -> blackbody-ish temperature). Shapes are built from domain-warped fbm so every petal / plume has
// turbulent gas structure (hot filaments, broken tips) instead of smooth airbrushed gradients.
//   Row 0  front "flower" (looking down the bore): 3-6 broad turbulent petals + white core
//   Row 1  muzzle-brake side jets (root at left-centre, blast to the right): short, fat, ragged
//   Row 2  forward plume (root at left): expanding flame with shock-diamond pulses breaking into wisps
//   Row 3  12 tight core glow, 13 hot core with faint radial filaments, 14 soft dot, 15 turbulent fireball
import path from 'node:path';
import { writePNG } from './png.mjs';
import { makeSimplex, mulberry32, clamp, smoothstep } from './noise.mjs';

export function bakeFlashAtlas(OUT, previewDir) {
  const R = 256, AW = R * 4;
  const img = new Uint8Array(AW * AW);
  const lin = new Float32Array(AW * AW);
  const S = makeSimplex(177);
  const put = (cell, fn) => {
    const cx = (cell % 4) * R, cy = Math.floor(cell / 4) * R;
    for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
      const u = ((x + 0.5) / R) * 2 - 1, v = 1 - ((y + 0.5) / R) * 2;
      const edge = Math.min(x, y, R - 1 - x, R - 1 - y);
      let val = clamp(fn(u, v));
      val *= clamp((edge - 2) / 6);
      lin[(cy + y) * AW + cx + x] = val;
      img[(cy + y) * AW + cx + x] = Math.round(Math.sqrt(val) * 255);
    }
  };
  const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
  // domain-warped turbulence in [0,1]
  const warp = (x, y, k, amt = 0.6) => {
    const wx = S.fbm2(x * 1.3 + k * 3.1, y * 1.3 - k, 3);
    const wy = S.fbm2(x * 1.3 - 7.7 + k, y * 1.3 + 3.3 * k, 3);
    return 0.5 + 0.5 * S.fbm2(x + wx * amt, y + wy * amt, 3, 2.0, 0.5);
  };

  // ---- Row 0: front flowers
  for (let k = 0; k < 4; k++) {
    const rnd = mulberry32(900 + k * 13);
    const n = 3 + Math.floor(rnd() * 4);
    const base = rnd() * Math.PI * 2;
    const petals = [];
    for (let i = 0; i < n; i++) petals.push({ a: base + (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.7, L: 0.5 + rnd() * 0.45, w: 0.22 + rnd() * 0.22, curl: (rnd() - 0.5) * 0.6 });
    put(k, (u, v) => {
      const r = Math.hypot(u, v), th = Math.atan2(v, u);
      let best = 0;
      for (const p of petals) {
        const a = p.a + p.curl * r * r;
        const d = angDiff(th, a);
        // petal half-width widens then pinches at the tip (tongue)
        const t = r / p.L;
        if (t > 1.25) continue;
        const width = p.w * (0.55 + 1.0 * Math.sqrt(Math.max(t, 0)) * (1 - 0.5 * t));
        const across = d / Math.max(width, 0.02);
        const turb = warp(r * 2.2 + k * 5, d * 3.5 + p.a, k + 0.3 * p.a, 0.7);
        const fil = Math.pow(0.5 + 0.5 * S.noise2(Math.cos(a) * 6 + r * 11 + k, Math.sin(a) * 6 - r * 3), 2);
        const body = Math.exp(-across * across * 2.2) * (0.55 + 0.9 * turb) * (0.8 + 0.4 * fil);
        const tip = smoothstep(1.1, 0.35 + 0.4 * turb, t);
        best = Math.max(best, body * tip * (1 - 0.45 * t));
      }
      const core = Math.exp(-((r / 0.13) ** 2)) * 1.1 + 0.45 * Math.exp(-r / 0.09);
      const hot = best * 0.95;
      return Math.max(core, hot) + 0.25 * core * hot;
    });
  }
  // ---- Row 1: side jets from a muzzle-brake port (root at u=-0.95)
  for (let k = 0; k < 4; k++) {
    const rnd = mulberry32(1100 + k * 7);
    const lenMul = 0.7 + rnd() * 0.3;
    const bend = (rnd() - 0.5) * 0.25;
    put(4 + k, (u, v) => {
      const t = (u + 0.95) / (1.85 * lenMul);
      if (t < -0.08 || t > 1.2) return 0;
      const tt = Math.max(t, 0);
      const vv = v - bend * tt * tt;
      const width = 0.07 + 0.5 * Math.pow(tt, 0.6) * Math.pow(Math.max(1 - tt, 0), 0.7);
      const turb = warp(tt * 1.6 + k * 11, vv * 3.4, k * 1.7, 0.8);
      const edge = width * (0.6 + 0.75 * turb);
      const d = vv / Math.max(edge, 1e-3);
      const body = Math.exp(-d * d * 1.7) * (0.35 + 0.95 * turb) * Math.pow(Math.max(1 - tt, 0), 0.8);
      const tip = smoothstep(1.0, 0.3 + 0.45 * turb, tt);
      const root = Math.exp(-((t / 0.09) ** 2) - (v / 0.1) ** 2) * 1.2;
      return body * tip + root;
    });
  }
  // ---- Row 2: forward plume
  for (let k = 0; k < 4; k++) {
    const rnd = mulberry32(1300 + k * 5);
    const bands = 2 + rnd() * 1.5;
    put(8 + k, (u, v) => {
      const t = (u + 0.96) / 1.9;
      if (t < -0.06 || t > 1.15) return 0;
      const tt = Math.max(t, 0);
      const width = 0.08 + 0.5 * Math.pow(tt, 0.5) * Math.pow(Math.max(1 - tt, 0), 0.9) + 0.06 * tt;
      const turb = warp(tt * 1.8 + k * 9, v * 5, k * 2.3, 0.75);
      const d = v / Math.max(width * (0.6 + 0.7 * turb), 1e-3);
      const diamonds = 0.7 + 0.3 * Math.pow(Math.cos(tt * Math.PI * 2 * bands), 2) * (1 - tt);
      const body = Math.exp(-d * d * 1.8) * Math.pow(Math.max(1 - tt, 0), 1.0) * diamonds * (0.4 + 0.9 * turb);
      const tip = smoothstep(1.0, 0.35 + 0.35 * turb, tt);
      const root = Math.exp(-((t / 0.06) ** 2) - (v / 0.08) ** 2) * 1.2;
      return body * tip + root;
    });
  }
  // ---- Row 3
  put(12, (u, v) => { const r = Math.hypot(u, v); return (Math.exp(-r * r * 14) * 0.85 + Math.exp(-r * 9) * 0.25) * smoothstep(1, 0.6, r); });
  put(13, (u, v) => {
    const r = Math.hypot(u, v), th = Math.atan2(v, u);
    const fil = Math.pow(0.5 + 0.5 * S.noise2(Math.cos(th) * 7, Math.sin(th) * 7), 5) * Math.exp(-r * 3.2);
    return (Math.exp(-r * r * 40) + fil * 0.6) * smoothstep(1, 0.5, r);
  });
  put(14, (u, v) => { const r = Math.hypot(u, v); return Math.exp(-r * r * 9) * smoothstep(1, 0.6, r); });
  put(15, (u, v) => {
    const r = Math.hypot(u, v);
    const n = warp(u * 1.8 + 40, v * 1.8, 5.5, 0.8);
    return Math.pow(clamp(1 - r / (0.45 + 0.45 * n)), 1.3) * (0.35 + 0.9 * n);
  });
  writePNG(path.join(OUT, 'flash.png'), img, AW, AW, 1);
  if (previewDir) {
    // temperature-mapped preview (same mapping as the shader) on black
    const P = new Uint8Array(AW * AW * 3);
    const lerp = (a, b, t) => a + (b - a) * t;
    for (let i = 0; i < AW * AW; i++) {
      const I = lin[i] * 1.4;
      let c = [1, 0.3, 0.05];
      const t1 = smoothstep(0.05, 0.45, I), t2 = smoothstep(0.45, 1.0, I);
      c = [1, lerp(0.3, 0.7, t1), lerp(0.05, 0.3, t1)];
      c = [1, lerp(c[1], 0.95, t2), lerp(c[2], 0.85, t2)];
      for (let j = 0; j < 3; j++) P[i * 3 + j] = Math.round(clamp(1 - Math.exp(-c[j] * I * 2.2)) * 255);
    }
    writePNG(path.join(previewDir, 'preview_flash.png'), P, AW, AW, 3);
  }
  console.log('flash baked');
}

// Volumetric smoke sprite baker: builds a 3D density field, then bakes "6-way" light maps
// (single scattering from +X,-X,+Y,-Y,+Z,-Z via axis-aligned transmittance), alpha and an interior
// "heat" mask used for fire emission. Runs inside a worker thread (see bake.mjs).
import { parentPort, workerData } from 'node:worker_threads';
import { makeSimplex, mulberry32, smoothstep, clamp } from './noise.mjs';

function bakeCell({ type, seed, R = 256, RZ = 128 }) {
  const S = makeSimplex(seed);
  const rnd = mulberry32(seed * 7 + 3);
  const RX = R, RY = R;
  const vol = new Float32Array(RX * RY * RZ);

  // --- shape parameters
  const blobs = [];
  let sigma = 14;
  if (type === 'billow') {
    const n = 7 + Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) {
      const r = 0.3 + rnd() * 0.24;
      const lim = 0.92 - r;
      let x, y, z;
      do { x = (rnd() * 2 - 1); y = (rnd() * 2 - 1); z = (rnd() * 2 - 1); } while (x * x + y * y + z * z > 1);
      blobs.push([x * lim, y * lim * 0.85, z * lim * 0.8, r, 0.8 + rnd() * 0.4]);
    }
    sigma = 7;
  } else if (type === 'wisp') {
    sigma = 6;
  } else {
    const n = 4 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const r = 0.38 + rnd() * 0.2;
      const lim = 0.9 - r;
      blobs.push([(rnd() * 2 - 1) * lim, (rnd() * 2 - 1) * lim * 0.7, (rnd() * 2 - 1) * lim * 0.6, r, 0.8 + rnd() * 0.3]);
    }
    sigma = 5;
  }
  const off = [rnd() * 100, rnd() * 100, rnd() * 100];

  function blobField(x, y, z) {
    let f = 0;
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      const dx = x - b[0], dy = y - b[1], dz = z - b[2];
      const d2 = (dx * dx + dy * dy + dz * dz) / (b[3] * b[3]);
      if (d2 < 1) { const t = 1 - d2; f += b[4] * t * t * t; }
    }
    return f;
  }

  for (let zi = 0; zi < RZ; zi++) {
    const z = 1 - ((zi + 0.5) / RZ) * 2;
    for (let yi = 0; yi < RY; yi++) {
      const y = 1 - ((yi + 0.5) / RY) * 2;
      for (let xi = 0; xi < RX; xi++) {
        const x = ((xi + 0.5) / RX) * 2 - 1;
        const r2 = x * x + y * y + z * z;
        if (r2 > 0.98) continue;
        let rho = 0;
        if (type === 'billow') {
          const f = blobField(x, y, z);
          if (f < 0.02) continue;
          const bn = S.billow3(x * 3.1 + off[0], y * 3.1 + off[1], z * 3.1 + off[2], 4);
          const fine = S.fbm3(x * 9 + off[1], y * 9 + off[2], z * 9 + off[0], 2);
          const shape = f - 0.3 + (bn - 0.62) * 0.7 + fine * 0.16;
          // density ramps in slowly: a soft, semi-transparent rim instead of a hard cauliflower silhouette
          rho = Math.pow(smoothstep(-0.15, 0.65, shape), 1.5);
          rho *= 0.55 + 0.45 * (0.5 + 0.5 * S.fbm3(x * 5 + 11, y * 5, z * 5, 3));
          const skirt = smoothstep(-0.35, 0.05, shape) * 0.08 * (0.5 + 0.5 * fine);
          if (skirt > rho) rho = skirt;
        } else if (type === 'wisp') {
          const wx = S.fbm3(x * 1.7 + off[0], y * 1.7, z * 1.7, 3);
          const wy = S.fbm3(x * 1.7, y * 1.7 + off[1], z * 1.7, 3);
          const wz = S.fbm3(x * 1.7, y * 1.7, z * 1.7 + off[2], 3);
          const qx = x + wx * 0.45, qy = y + wy * 0.45, qz = z + wz * 0.45;
          const e = (qx * qx) / 0.42 + (qy * qy) / 0.32 + (qz * qz) / 0.16;
          if (e > 2.5) continue;
          const base = Math.exp(-e * 1.6);
          const rid = S.ridged3(qx * 2.6 + off[0], qy * 2.6, qz * 2.6, 4);
          rho = smoothstep(0.12, 0.55, base * (0.25 + rid * 1.1)) * 0.8;
        } else {
          // soft dust: warped radial falloff + fine billowing detail, alpha ramps over ~half the radius
          const wx = S.fbm3(x * 1.4 + off[0], y * 1.4, z * 1.4, 3);
          const wy = S.fbm3(x * 1.4, y * 1.4 + off[1], z * 1.4, 3);
          const wz = S.fbm3(x * 1.4, y * 1.4, z * 1.4 + off[2], 3);
          const qx = x + wx * 0.35, qy = y + wy * 0.35, qz = z + wz * 0.35;
          const e2 = (qx * qx + qy * qy * 1.15 + qz * qz * 1.4) / 0.5;
          if (e2 > 3) continue;
          const base = Math.exp(-e2 * 1.3);
          const det = S.billow3(qx * 3.2 + off[1], qy * 3.2 + off[2], qz * 3.2 + off[0], 4);
          rho = Math.pow(clamp((base - 0.18 + (det - 0.6) * 0.5) * 1.6), 1.3) * 0.75;
        }
        rho *= smoothstep(0.98, 0.72, r2);
        vol[(zi * RY + yi) * RX + xi] = rho;
      }
    }
  }

  const dx = 2 / RX, dz = 2 / RZ;
  const sl = sigma * 0.55; // light extinction (fake multi-scatter)
  const N2 = RX * RY;
  const colTotal = new Float32Array(N2);
  for (let zi = 0; zi < RZ; zi++) { const o = zi * N2; for (let i = 0; i < N2; i++) colTotal[i] += vol[o + i]; }
  const front = new Float32Array(N2);
  const Tv = new Float32Array(N2).fill(1);
  const L = [new Float32Array(N2), new Float32Array(N2), new Float32Array(N2), new Float32Array(N2), new Float32Array(N2), new Float32Array(N2)];
  const E = new Float32Array(N2);
  const rowL = new Float32Array(RX), colU = new Float32Array(RY * RX);
  const colD = new Float32Array(RY * RX), rowR = new Float32Array(RX);

  for (let zi = 0; zi < RZ; zi++) {
    const o = zi * N2;
    // up-sums (light from +Y travels down, rows above = smaller yi)
    for (let xi = 0; xi < RX; xi++) {
      let s = 0;
      for (let yi = 0; yi < RY; yi++) { const v = vol[o + yi * RX + xi]; colU[yi * RX + xi] = s + v * 0.5; s += v; }
      s = 0;
      for (let yi = RY - 1; yi >= 0; yi--) { const v = vol[o + yi * RX + xi]; colD[yi * RX + xi] = s + v * 0.5; s += v; }
    }
    for (let yi = 0; yi < RY; yi++) {
      let s = 0;
      for (let xi = 0; xi < RX; xi++) { const v = vol[o + yi * RX + xi]; rowL[xi] = s + v * 0.5; s += v; }
      s = 0;
      for (let xi = RX - 1; xi >= 0; xi--) { const v = vol[o + yi * RX + xi]; rowR[xi] = s + v * 0.5; s += v; }
      for (let xi = 0; xi < RX; xi++) {
        const i = yi * RX + xi;
        const v = vol[o + i];
        if (v <= 0) continue;
        const a = 1 - Math.exp(-sigma * dz * v);
        const w = Tv[i] * a;
        const tPX = Math.exp(-sl * dx * rowR[xi]);
        const tNX = Math.exp(-sl * dx * rowL[xi]);
        const tPY = Math.exp(-sl * dx * colU[i]);
        const tNY = Math.exp(-sl * dx * colD[i]);
        const fs = front[i] + v * 0.5;
        const tPZ = Math.exp(-sl * dz * fs);
        const tNZ = Math.exp(-sl * dz * (colTotal[i] - fs));
        L[0][i] += w * tPX; L[1][i] += w * tPY; L[2][i] += w * tPZ;
        L[3][i] += w * tNX; L[4][i] += w * tNY; L[5][i] += w * tNZ;
        const minT = Math.min(tPX, tNX, tPY, tNY, tPZ, tNZ);
        const heat = 1 - (tPX + tNX + tPY + tNY + tPZ + tNZ) / 6;
        E[i] += w * (heat * 0.7 + (1 - minT) * 0.3);
        Tv[i] *= 1 - a;
        front[i] += v;
      }
    }
  }

  const A = new Uint8Array(N2 * 4), B = new Uint8Array(N2 * 4);
  const enc = (x) => Math.round(Math.sqrt(clamp(x)) * 255);
  for (let i = 0; i < N2; i++) {
    const alpha = 1 - Tv[i];
    const inv = alpha > 1e-4 ? 1 / alpha : 0;
    const avg = alpha > 1e-4 ? 0 : 0.8;
    A[i * 4] = enc(L[0][i] * inv + avg);
    A[i * 4 + 1] = enc(L[1][i] * inv + avg);
    A[i * 4 + 2] = enc(L[2][i] * inv + avg);
    A[i * 4 + 3] = Math.round(clamp(alpha) * 255);
    B[i * 4] = enc(L[3][i] * inv + avg);
    B[i * 4 + 1] = enc(L[4][i] * inv + avg);
    B[i * 4 + 2] = enc(L[5][i] * inv + avg);
    B[i * 4 + 3] = enc(E[i] * inv);
  }
  return { A, B, R };
}

if (parentPort) {
  const res = bakeCell(workerData);
  parentPort.postMessage(res, [res.A.buffer, res.B.buffer]);
}

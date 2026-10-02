import * as THREE from 'three';

/**
 * Deterministic 256x256 RGBA8 noise texture (seeded from ctx.rng):
 *   R: film grain (white noise softened by a tileable 3x3 blur, re-normalised) -> ~1.5 px clumps
 *   G,B: independent uniform noise (G+B-1 = triangular dither)
 *   A: smooth tileable value noise (organic masks, e.g. the damage vignette)
 */
export function createNoiseTexture(rng, size = 256) {
  const n = size * size;
  const white = new Float32Array(n);
  for (let i = 0; i < n; i++) white[i] = rng.next();
  // blur (tileable) for grain clumping
  const soft = new Float32Array(n);
  let mean = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const w = dx === 0 && dy === 0 ? 4 : (dx === 0 || dy === 0 ? 2 : 1);
          s += w * white[((y + dy + size) % size) * size + ((x + dx + size) % size)];
        }
      }
      soft[y * size + x] = s / 16;
      mean += s / 16;
    }
  }
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (soft[i] - mean) ** 2;
  const std = Math.sqrt(variance / n) || 1;
  // low-frequency value noise, 3 octaves, tileable
  const lf = new Float32Array(n);
  const octaves = [[8, 0.6], [16, 0.28], [32, 0.12]];
  for (const [cells, amp] of octaves) {
    const grid = new Float32Array(cells * cells);
    for (let i = 0; i < grid.length; i++) grid[i] = rng.next();
    const scale = cells / size;
    for (let y = 0; y < size; y++) {
      const gy = y * scale;
      const y0 = Math.floor(gy);
      let fy = gy - y0;
      fy = fy * fy * (3 - 2 * fy);
      for (let x = 0; x < size; x++) {
        const gx = x * scale;
        const x0 = Math.floor(gx);
        let fx = gx - x0;
        fx = fx * fx * (3 - 2 * fx);
        const a = grid[(y0 % cells) * cells + (x0 % cells)];
        const b = grid[(y0 % cells) * cells + ((x0 + 1) % cells)];
        const c = grid[((y0 + 1) % cells) * cells + (x0 % cells)];
        const d = grid[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
        lf[y * size + x] += amp * ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy);
      }
    }
  }
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const g = 0.5 + ((soft[i] - mean) / std) * 0.17;
    data[i * 4] = Math.max(0, Math.min(255, Math.round(g * 255)));
    data[i * 4 + 1] = Math.floor(rng.next() * 256) & 255;
    data[i * 4 + 2] = Math.floor(rng.next() * 256) & 255;
    data[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(lf[i] * 255)));
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.name = 'postfx:noise';
  tex.needsUpdate = true;
  return tex;
}

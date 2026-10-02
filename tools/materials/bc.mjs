/**
 * Minimal, dependency-free block-compression encoders (offline bake only).
 *
 *   BC1 (DXT1)  RGB,  8 bytes / 4x4 block   PCA endpoints + 2 least-squares refinement passes
 *   BC4 (RGTC1) R,    8 bytes / 4x4 block   min/max + inset search, 8-value mode
 *   BC5 (RGTC2) RG,  16 bytes / 4x4 block   two BC4 blocks
 *   BC3 (DXT5)  RGBA,16 bytes / 4x4 block   BC4-style alpha + BC1 colour (always 4-colour mode)
 *
 * Input images are Uint8Array RGBA (w*h*4). Output is a Uint8Array of blocks in row-major order.
 * Always emits c0 > c1 so every decoder uses the 4-colour palette (safe for BC1 and BC3).
 */

const W_R = 0.5, W_G = 1.0, W_B = 0.3; // perceptual-ish channel weights for index selection

function to565(r, g, b) {
  const R = Math.max(0, Math.min(31, Math.round((r * 31) / 255)));
  const G = Math.max(0, Math.min(63, Math.round((g * 63) / 255)));
  const B = Math.max(0, Math.min(31, Math.round((b * 31) / 255)));
  return (R << 11) | (G << 5) | B;
}
function from565(c, out, o) {
  const R = (c >> 11) & 31, G = (c >> 5) & 63, B = c & 31;
  out[o] = (R << 3) | (R >> 2);
  out[o + 1] = (G << 2) | (G >> 4);
  out[o + 2] = (B << 3) | (B >> 2);
}

const _pal = new Float32Array(12);
const _px = new Float32Array(48);
const _idx = new Uint8Array(16);
const _tmp = new Uint8Array(3);

function buildPalette(c0, c1) {
  from565(c0, _tmp, 0); _pal[0] = _tmp[0]; _pal[1] = _tmp[1]; _pal[2] = _tmp[2];
  from565(c1, _tmp, 0); _pal[3] = _tmp[0]; _pal[4] = _tmp[1]; _pal[5] = _tmp[2];
  for (let k = 0; k < 3; k++) {
    _pal[6 + k] = (2 * _pal[k] + _pal[3 + k]) / 3;
    _pal[9 + k] = (_pal[k] + 2 * _pal[3 + k]) / 3;
  }
}

function assign() {
  let err = 0;
  for (let i = 0; i < 16; i++) {
    const r = _px[i * 3], g = _px[i * 3 + 1], b = _px[i * 3 + 2];
    let best = 0, bd = Infinity;
    for (let p = 0; p < 4; p++) {
      const dr = r - _pal[p * 3], dg = g - _pal[p * 3 + 1], db = b - _pal[p * 3 + 2];
      const d = W_R * dr * dr + W_G * dg * dg + W_B * db * db;
      if (d < bd) { bd = d; best = p; }
    }
    _idx[i] = best;
    err += bd;
  }
  return err;
}

// palette index -> weight of endpoint 0
const W0 = [1, 0, 2 / 3, 1 / 3];

/** Encode one BC1 colour block from _px (16 RGB floats). Writes 8 bytes. */
function encodeColorBlock(out, o) {
  // mean
  let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < 16; i++) { mr += _px[i * 3]; mg += _px[i * 3 + 1]; mb += _px[i * 3 + 2]; }
  mr /= 16; mg /= 16; mb /= 16;
  // covariance
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < 16; i++) {
    const r = _px[i * 3] - mr, g = _px[i * 3 + 1] - mg, b = _px[i * 3 + 2] - mb;
    xx += r * r; xy += r * g; xz += r * b; yy += g * g; yz += g * b; zz += b * b;
  }
  // power iteration
  let ax = 0.577, ay = 0.577, az = 0.577;
  for (let k = 0; k < 6; k++) {
    const nx = xx * ax + xy * ay + xz * az;
    const ny = xy * ax + yy * ay + yz * az;
    const nz = xz * ax + yz * ay + zz * az;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-8) break;
    ax = nx / l; ay = ny / l; az = nz / l;
  }
  let tmin = Infinity, tmax = -Infinity;
  for (let i = 0; i < 16; i++) {
    const t = (_px[i * 3] - mr) * ax + (_px[i * 3 + 1] - mg) * ay + (_px[i * 3 + 2] - mb) * az;
    if (t < tmin) tmin = t;
    if (t > tmax) tmax = t;
  }
  // slight inset reduces error for noisy blocks
  const inset = (tmax - tmin) / 32;
  tmin += inset; tmax -= inset;
  let e0r = mr + ax * tmax, e0g = mg + ay * tmax, e0b = mb + az * tmax;
  let e1r = mr + ax * tmin, e1g = mg + ay * tmin, e1b = mb + az * tmin;
  let c0 = to565(e0r, e0g, e0b), c1 = to565(e1r, e1g, e1b);
  buildPalette(c0, c1);
  let bestErr = assign();
  let bc0 = c0, bc1 = c1;
  const bestIdx = new Uint8Array(_idx);

  // least-squares refinement
  for (let it = 0; it < 2; it++) {
    let a2 = 0, b2 = 0, ab = 0;
    let axr = 0, axg = 0, axb = 0, bxr = 0, bxg = 0, bxb = 0;
    for (let i = 0; i < 16; i++) {
      const a = W0[_idx[i]], b = 1 - a;
      a2 += a * a; b2 += b * b; ab += a * b;
      axr += a * _px[i * 3]; axg += a * _px[i * 3 + 1]; axb += a * _px[i * 3 + 2];
      bxr += b * _px[i * 3]; bxg += b * _px[i * 3 + 1]; bxb += b * _px[i * 3 + 2];
    }
    const det = a2 * b2 - ab * ab;
    if (Math.abs(det) < 1e-6) break;
    const f = 1 / det;
    e0r = (axr * b2 - bxr * ab) * f; e0g = (axg * b2 - bxg * ab) * f; e0b = (axb * b2 - bxb * ab) * f;
    e1r = (bxr * a2 - axr * ab) * f; e1g = (bxg * a2 - axg * ab) * f; e1b = (bxb * a2 - axb * ab) * f;
    c0 = to565(e0r, e0g, e0b); c1 = to565(e1r, e1g, e1b);
    buildPalette(c0, c1);
    const err = assign();
    if (err < bestErr) { bestErr = err; bc0 = c0; bc1 = c1; bestIdx.set(_idx); } else break;
  }
  c0 = bc0; c1 = bc1;
  const idx = bestIdx;
  // enforce 4-colour mode: c0 > c1
  if (c0 < c1) {
    const t = c0; c0 = c1; c1 = t;
    for (let i = 0; i < 16; i++) idx[i] = [1, 0, 3, 2][idx[i]];
  } else if (c0 === c1) {
    idx.fill(0);
  }
  let bits = 0;
  for (let i = 15; i >= 0; i--) bits = (bits * 4) + idx[i];
  out[o] = c0 & 255; out[o + 1] = c0 >> 8; out[o + 2] = c1 & 255; out[o + 3] = c1 >> 8;
  // bits can exceed 2^31: write via unsigned math
  for (let k = 0; k < 4; k++) { out[o + 4 + k] = bits % 256; bits = Math.floor(bits / 256); }
}

const _a = new Float32Array(16);
/** Encode one BC4 block from _a (16 values 0..255). Writes 8 bytes. */
function encodeAlphaBlock(out, o) {
  let mn = 255, mx = 0;
  for (let i = 0; i < 16; i++) { if (_a[i] < mn) mn = _a[i]; if (_a[i] > mx) mx = _a[i]; }
  let best = null, bestErr = Infinity;
  const cand = [];
  const range = mx - mn;
  for (const inset of [0, 1 / 32, 1 / 16, 1 / 10]) {
    const a0 = Math.round(mx - range * inset), a1 = Math.round(mn + range * inset);
    cand.push([a0, a1]);
  }
  for (const [c0, c1] of cand) {
    let a0 = Math.max(0, Math.min(255, c0)), a1 = Math.max(0, Math.min(255, c1));
    if (a0 <= a1) {
      // flat block: a0 > a1 with index 0 everywhere
      if (a0 === 255) a1 = 254; else a0 = a1 + 1;
    }
    const codes = new Uint8Array(16);
    let err = 0;
    const span = a0 - a1;
    for (let i = 0; i < 16; i++) {
      let s = Math.round(((_a[i] - a1) / span) * 7);
      s = Math.max(0, Math.min(7, s));
      const v = (s * a0 + (7 - s) * a1) / 7;
      err += (v - _a[i]) * (v - _a[i]);
      codes[i] = s === 7 ? 0 : s === 0 ? 1 : 8 - s;
    }
    if (err < bestErr) { bestErr = err; best = [a0, a1, codes]; }
  }
  const [a0, a1, codes] = best;
  out[o] = a0; out[o + 1] = a1;
  // 48 bits of 3-bit codes, pixel 0 first (lowest)
  let lo = 0, hi = 0; // 24 bits each
  for (let i = 0; i < 8; i++) lo |= codes[i] << (3 * i);
  for (let i = 0; i < 8; i++) hi |= codes[8 + i] << (3 * i);
  out[o + 2] = lo & 255; out[o + 3] = (lo >> 8) & 255; out[o + 4] = (lo >> 16) & 255;
  out[o + 5] = hi & 255; out[o + 6] = (hi >> 8) & 255; out[o + 7] = (hi >> 16) & 255;
}

function blockCount(w, h) { return Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)); }

function forBlocks(rgba, w, h, fn) {
  const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4));
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      fn(bx, by, (i, c) => {
        const x = Math.min(w - 1, bx * 4 + (i & 3));
        const y = Math.min(h - 1, by * 4 + (i >> 2));
        return rgba[(y * w + x) * 4 + c];
      }, by * bw + bx);
    }
  }
}

export function encodeBC1(rgba, w, h) {
  const out = new Uint8Array(blockCount(w, h) * 8);
  forBlocks(rgba, w, h, (bx, by, get, b) => {
    for (let i = 0; i < 16; i++) { _px[i * 3] = get(i, 0); _px[i * 3 + 1] = get(i, 1); _px[i * 3 + 2] = get(i, 2); }
    encodeColorBlock(out, b * 8);
  });
  return out;
}

export function encodeBC4(rgba, w, h, channel = 0) {
  const out = new Uint8Array(blockCount(w, h) * 8);
  forBlocks(rgba, w, h, (bx, by, get, b) => {
    for (let i = 0; i < 16; i++) _a[i] = get(i, channel);
    encodeAlphaBlock(out, b * 8);
  });
  return out;
}

export function encodeBC5(rgba, w, h) {
  const out = new Uint8Array(blockCount(w, h) * 16);
  forBlocks(rgba, w, h, (bx, by, get, b) => {
    for (let i = 0; i < 16; i++) _a[i] = get(i, 0);
    encodeAlphaBlock(out, b * 16);
    for (let i = 0; i < 16; i++) _a[i] = get(i, 1);
    encodeAlphaBlock(out, b * 16 + 8);
  });
  return out;
}

export function encodeBC3(rgba, w, h) {
  const out = new Uint8Array(blockCount(w, h) * 16);
  forBlocks(rgba, w, h, (bx, by, get, b) => {
    for (let i = 0; i < 16; i++) _a[i] = get(i, 3);
    encodeAlphaBlock(out, b * 16);
    for (let i = 0; i < 16; i++) { _px[i * 3] = get(i, 0); _px[i * 3 + 1] = get(i, 1); _px[i * 3 + 2] = get(i, 2); }
    encodeColorBlock(out, b * 16 + 8);
  });
  return out;
}

export const BLOCK_BYTES = { bc1: 8, bc4: 8, bc5: 16, bc3: 16 };

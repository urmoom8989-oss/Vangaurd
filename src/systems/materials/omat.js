import * as THREE from 'three';

/**
 * Loader for the baked .omat texture sets (see tools/materials/bake.mjs).
 * Produces THREE.CompressedTexture (BC1 sRGB / BC3 / BC5, full CPU-built mip chains) or DataTexture
 * (rgba8). If the GPU lacks S3TC/RGTC support the blocks are decoded on the CPU as a fallback.
 */

const FORMATS = {
  bc1: THREE.RGB_S3TC_DXT1_Format,
  bc3: THREE.RGBA_S3TC_DXT5_Format,
  bc5: THREE.RED_GREEN_RGTC2_Format,
};

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function parseOmat(buffer) {
  const dv = new DataView(buffer);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'OMAT') throw new Error('not an .omat file');
  const flags = dv.getUint32(8, true);
  const jsonLen = dv.getUint32(12, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 16, jsonLen)));
  let payload = new Uint8Array(buffer, 16 + jsonLen);
  if (flags & 1) payload = await inflate(payload);
  return { meta, payload };
}

// ------------------------------------------------------------------------------ CPU fallback decode
function decodeColorBlock(src, o, out, w, h, bx, by) {
  const c0 = src[o] | (src[o + 1] << 8), c1 = src[o + 2] | (src[o + 3] << 8);
  const pal = new Uint8Array(16);
  const e = (c, p) => {
    const R = (c >> 11) & 31, G = (c >> 5) & 63, B = c & 31;
    pal[p] = (R << 3) | (R >> 2); pal[p + 1] = (G << 2) | (G >> 4); pal[p + 2] = (B << 3) | (B >> 2); pal[p + 3] = 255;
  };
  e(c0, 0); e(c1, 4);
  for (let k = 0; k < 3; k++) {
    pal[8 + k] = (2 * pal[k] + pal[4 + k]) / 3;
    pal[12 + k] = (pal[k] + 2 * pal[4 + k]) / 3;
  }
  pal[11] = pal[15] = 255;
  const bits = src[o + 4] | (src[o + 5] << 8) | (src[o + 6] << 16) | (src[o + 7] << 24);
  for (let i = 0; i < 16; i++) {
    const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
    if (x >= w || y >= h) continue;
    const p = ((bits >>> (2 * i)) & 3) * 4, d = (y * w + x) * 4;
    out[d] = pal[p]; out[d + 1] = pal[p + 1]; out[d + 2] = pal[p + 2];
  }
}
function decodeAlphaBlock(src, o, out, w, h, bx, by, ch) {
  const a0 = src[o], a1 = src[o + 1];
  const pal = [a0, a1];
  if (a0 > a1) for (let i = 1; i < 7; i++) pal.push(((7 - i) * a0 + i * a1) / 7);
  else { for (let i = 1; i < 5; i++) pal.push(((5 - i) * a0 + i * a1) / 5); pal.push(0, 255); }
  const lo = src[o + 2] | (src[o + 3] << 8) | (src[o + 4] << 16);
  const hi = src[o + 5] | (src[o + 6] << 8) | (src[o + 7] << 16);
  for (let i = 0; i < 16; i++) {
    const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
    if (x >= w || y >= h) continue;
    const code = i < 8 ? (lo >> (3 * i)) & 7 : (hi >> (3 * (i - 8))) & 7;
    out[(y * w + x) * 4 + ch] = pal[code];
  }
}
function decodeLevel(fmt, src, w, h) {
  const out = new Uint8Array(w * h * 4).fill(255);
  const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4));
  const bs = fmt === 'bc1' ? 8 : 16;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const o = (by * bw + bx) * bs;
      if (fmt === 'bc1') decodeColorBlock(src, o, out, w, h, bx, by);
      else if (fmt === 'bc3') { decodeAlphaBlock(src, o, out, w, h, bx, by, 3); decodeColorBlock(src, o + 8, out, w, h, bx, by); }
      else if (fmt === 'bc5') { decodeAlphaBlock(src, o, out, w, h, bx, by, 0); decodeAlphaBlock(src, o + 8, out, w, h, bx, by, 1); }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------ texture creation
function configure(tex, anisotropy) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/**
 * @returns {{meta, textures: Record<string, THREE.Texture>, gpuBytes: number}}
 */
export function buildTextures({ meta, payload }, { renderer, anisotropy = 8, skip = 0 }) {
  const ext = renderer?.extensions;
  const hasS3TC = !!ext?.has('WEBGL_compressed_texture_s3tc');
  const hasS3TCsrgb = !!ext?.has('WEBGL_compressed_texture_s3tc_srgb');
  const hasRGTC = !!ext?.has('EXT_texture_compression_rgtc');
  const textures = {};
  let gpuBytes = 0;
  for (const [name, m0] of Object.entries(meta.maps)) {
    // texture quality: drop the top `skip` mips of large maps (keeps >= 256 px)
    let m = m0;
    let k = 0;
    while (k < skip && m0.levels.length - k > 1 && (m0.levels[k][2] >> 1) >= 256) k++;
    if (k) m = { ...m0, width: m0.levels[k][2], height: m0.levels[k][3], levels: m0.levels.slice(k) };
    const view = (l) => new Uint8Array(payload.buffer, payload.byteOffset + l[0], l[1]);
    let tex;
    if (m.fmt === 'rgba8') {
      const l = m.levels[0];
      tex = new THREE.DataTexture(view(l), l[2], l[3], THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.generateMipmaps = true;
      gpuBytes += l[1] * 4 / 3;
    } else {
      const native = (m.fmt === 'bc5' ? hasRGTC : hasS3TC) && (!m.srgb || hasS3TCsrgb);
      if (native) {
        const mipmaps = m.levels.map((l) => ({ data: view(l), width: l[2], height: l[3] }));
        tex = new THREE.CompressedTexture(mipmaps, m.width, m.height, FORMATS[m.fmt], THREE.UnsignedByteType);
        tex.generateMipmaps = false;
        for (const l of m.levels) gpuBytes += l[1];
      } else {
        const l = m.levels[0];
        tex = new THREE.DataTexture(decodeLevel(m.fmt, view(l), l[2], l[3]), l[2], l[3], THREE.RGBAFormat, THREE.UnsignedByteType);
        tex.generateMipmaps = true;
        gpuBytes += l[2] * l[3] * 4 * 4 / 3;
      }
    }
    tex.name = `${meta.id}:${name}`;
    tex.colorSpace = m.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.flipY = false;
    configure(tex, anisotropy);
    textures[name] = tex;
  }
  return { meta, textures, gpuBytes };
}

/** Tiny 1x1 placeholder textures used until the real set has streamed in. */
export function placeholderTextures() {
  const mk = (r, g, b, a, srgb) => {
    const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.needsUpdate = true;
    return t;
  };
  return {
    albedo: mk(188, 188, 188, 255, true),
    normal: mk(128, 128, 255, 255, false),
    mask: mk(0, 204, 255, 128, false),
    noise: mk(128, 128, 128, 0, false),
  };
}

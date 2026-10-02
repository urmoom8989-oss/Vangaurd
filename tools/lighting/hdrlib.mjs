// Offline helpers for the lighting system: Radiance RGBE (.hdr) decoding, PNG encoding, sky analysis.
// Node only (no dependencies). Used by tools/lighting/*.mjs.
import fs from 'node:fs';
import zlib from 'node:zlib';

/** Decode a Radiance .hdr file -> { width, height, data: Float32Array RGB (linear) } */
export function readHDR(file) {
  const buf = fs.readFileSync(file);
  let pos = 0;
  const line = () => {
    let s = '';
    while (pos < buf.length && buf[pos] !== 0x0a) s += String.fromCharCode(buf[pos++]);
    pos++;
    return s;
  };
  const magic = line();
  if (!magic.startsWith('#?')) throw new Error('not a radiance file: ' + file);
  let l;
  while ((l = line()) !== '') { /* header */ }
  const res = line();
  const m = /-Y (\d+) \+X (\d+)/.exec(res);
  if (!m) throw new Error('unsupported resolution line: ' + res);
  const height = +m[1], width = +m[2];
  const data = new Float32Array(width * height * 3);
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    if (buf[pos] === 2 && buf[pos + 1] === 2 && ((buf[pos + 2] << 8) | buf[pos + 3]) === width) {
      pos += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < width) {
          let count = buf[pos++];
          if (count > 128) {
            count -= 128;
            const v = buf[pos++];
            for (let i = 0; i < count; i++) scan[(x++) * 4 + c] = v;
          } else {
            for (let i = 0; i < count; i++) scan[(x++) * 4 + c] = buf[pos++];
          }
        }
      }
    } else {
      for (let x = 0; x < width; x++) { for (let c = 0; c < 4; c++) scan[x * 4 + c] = buf[pos++]; }
    }
    for (let x = 0; x < width; x++) {
      const e = scan[x * 4 + 3];
      const o = (y * width + x) * 3;
      if (e === 0) { data[o] = data[o + 1] = data[o + 2] = 0; continue; }
      const f = Math.pow(2, e - 136);
      data[o] = scan[x * 4] * f;
      data[o + 1] = scan[x * 4 + 1] * f;
      data[o + 2] = scan[x * 4 + 2] * f;
    }
  }
  return { width, height, data };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** Write an 8-bit RGB PNG from a Uint8Array (w*h*3). */
export function writePNG(file, width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}

export const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Find the sun in an equirect HDR: returns {u, v, azimuthDeg, elevationDeg, peak, dir:[x,y,z]} (three.js equirect convention). */
export function findSun(img) {
  const { width, height, data } = img;
  let peak = 0, pi = 0;
  for (let i = 0; i < width * height; i++) {
    const L = lum(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]);
    if (L > peak) { peak = L; pi = i; }
  }
  // centroid of pixels above 50% of peak (circular mean in u)
  let sx = 0, sy = 0, sv = 0, n = 0;
  const thr = peak * 0.5;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    const L = lum(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]);
    if (L < thr) continue;
    const a = (x + 0.5) / width * Math.PI * 2;
    sx += Math.cos(a) * L; sy += Math.sin(a) * L; sv += (y + 0.5) * L; n += L;
  }
  let u = Math.atan2(sy, sx) / (Math.PI * 2); if (u < 0) u += 1;
  const v = sv / n / height; // 0 = top
  const elevation = (0.5 - v) * 180;
  return { u, v, elevationDeg: elevation, peak, peakIndex: pi, dir: equirectUVToDir(u, v) };
}

/** three.js equirect convention (equirectUv): u = atan(dir.z, dir.x) / (2PI) + 0.5, v = asin(dir.y)/PI + 0.5 (v up). Here v is 0 at TOP. */
export function equirectUVToDir(u, vTop) {
  const phi = (u - 0.5) * Math.PI * 2; // atan(z, x)
  const theta = (0.5 - vTop) * Math.PI; // elevation
  return [Math.cos(theta) * Math.cos(phi), Math.sin(theta), Math.cos(theta) * Math.sin(phi)];
}

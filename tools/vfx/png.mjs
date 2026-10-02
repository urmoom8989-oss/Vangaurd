// Minimal PNG encoder (no deps). Supports grayscale (1ch), RGB (3ch), RGBA (4ch) 8-bit.
import zlib from 'node:zlib';
import fs from 'node:fs';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * @param {Uint8Array} pixels row-major, channels interleaved
 * @param {number} w @param {number} h @param {number} ch 1|3|4
 */
export function encodePNG(pixels, w, h, ch) {
  const colorType = ch === 1 ? 0 : ch === 3 ? 2 : ch === 4 ? 6 : 4;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * ch;
  const raw = Buffer.alloc((stride + 1) * h);
  // Paeth filter on every row (good compression for smooth data)
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1);
    raw[o] = 4;
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const a = x >= ch ? pixels[i - ch] : 0;
      const b = y > 0 ? pixels[i - stride] : 0;
      const c = x >= ch && y > 0 ? pixels[i - stride - ch] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      raw[o + 1 + x] = (pixels[i] - pred) & 0xff;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

export function writePNG(path, pixels, w, h, ch) {
  fs.writeFileSync(path, encodePNG(pixels, w, h, ch));
}

// Crop (and optionally upscale) a region of a PNG for close inspection.
// usage: node tools/vfx/crop.mjs in.png out.png x y w h [scale]
import fs from 'node:fs';
import zlib from 'node:zlib';
import { writePNG } from './png.mjs';

const [inp, outp, X, Y, W, H, SC] = process.argv.slice(2);
const buf = fs.readFileSync(inp);
let pos = 8, width = 0, height = 0, ctype = 0;
const idat = [];
while (pos < buf.length) {
  const len = buf.readUInt32BE(pos); const type = buf.toString('ascii', pos + 4, pos + 8);
  const data = buf.subarray(pos + 8, pos + 8 + len);
  if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); ctype = data[9]; }
  else if (type === 'IDAT') idat.push(data);
  pos += 12 + len;
}
const ch = ctype === 6 ? 4 : 3;
const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = width * ch;
const px = Buffer.alloc(height * stride);
for (let y = 0; y < height; y++) {
  const f = raw[y * (stride + 1)];
  const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
  const o = y * stride;
  for (let i = 0; i < stride; i++) {
    const a = i >= ch ? px[o + i - ch] : 0;
    const b = y > 0 ? px[o - stride + i] : 0;
    const c = y > 0 && i >= ch ? px[o - stride + i - ch] : 0;
    let v = src[i];
    if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
    else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
    px[o + i] = v & 255;
  }
}
const x0 = +X, y0 = +Y, w = +W, h = +H, s = +(SC || 1);
const out = Buffer.alloc(w * s * h * s * 3);
for (let y = 0; y < h * s; y++) for (let x = 0; x < w * s; x++) {
  const sx = Math.min(width - 1, x0 + Math.floor(x / s)), sy = Math.min(height - 1, y0 + Math.floor(y / s));
  const i = sy * stride + sx * ch, j = (y * w * s + x) * 3;
  out[j] = px[i]; out[j + 1] = px[i + 1]; out[j + 2] = px[i + 2];
}
writePNG(outp, out, w * s, h * s, 3);
console.log(outp);

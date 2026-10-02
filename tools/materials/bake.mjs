/**
 * Materials bake: Poly Haven sources -> compact GPU-ready .omat files in public/assets/materials/.
 *
 *   node tools/materials/fetch.mjs            # once: download CC0 sources into the cache
 *   node tools/materials/bake.mjs [id ...]    # bake all (or some) sets + the shared procedural set
 *   node tools/materials/bake.mjs --shared    # only the shared noise / detail-normal set
 *
 * Per set it writes <id>.omat containing three block-compressed textures with full mip chains:
 *   albedo  BC1 sRGB, full res       (cavity AO partially baked in, saturation / gain / tint adjusted)
 *   normal  BC5 (X,Y), full res      (Z reconstructed in the shader)
 *   mask    BC3, half res            R = metalness, G = roughness (Toksvig-filtered per mip for specular
 *                                    anti-aliasing), B = ambient occlusion, A = height
 * Mips are built on the CPU (albedo in linear light, normals renormalised, roughness widened by the
 * normal variance lost at each level) so distant surfaces don't sparkle or go glossy.
 * Rows are stored bottom-up so uv (0,0) = image bottom-left, matching three's flipY convention.
 *
 * .omat layout: 'OMAT' | u32 version | u32 flags (1 = payload deflate-raw) | u32 jsonLength | json | payload
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { SETS } from './sets.mjs';
import { CACHE } from './fetch.mjs';
import { encodeBC1, encodeBC3, encodeBC5 } from './bc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'public', 'assets', 'materials');
const log = (...a) => console.error('[materials:bake]', ...a);

// ------------------------------------------------------------------------------------ colour helpers
const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function l2s(v) {
  v = Math.max(0, Math.min(1, v));
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

// ------------------------------------------------------------------------------------ decoding
async function makeDecoder() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent('<html><body></body></html>');
  return {
    async decode(file) {
      const b64 = fs.readFileSync(file).toString('base64');
      const r = await page.evaluate(async (b64) => {
        const bin = atob(b64);
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([u]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
        let s = '';
        const CH = 0x8000;
        for (let i = 0; i < d.length; i += CH) s += String.fromCharCode.apply(null, d.subarray(i, i + CH));
        return { w: bmp.width, h: bmp.height, b64: btoa(s) };
      }, b64);
      return { w: r.w, h: r.h, data: new Uint8Array(Buffer.from(r.b64, 'base64')) };
    },
    /** rgba8 -> PNG file (debug previews) */
    async png(file, w, h, rgba) {
      const b64 = await page.evaluate(async ({ w, h, b64 }) => {
        const bin = atob(b64);
        const u = new Uint8ClampedArray(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        const c = new OffscreenCanvas(w, h);
        c.getContext('2d').putImageData(new ImageData(u, w, h), 0, 0);
        const blob = await c.convertToBlob({ type: 'image/png' });
        const ab = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < ab.length; i += 0x8000) s += String.fromCharCode.apply(null, ab.subarray(i, i + 0x8000));
        return btoa(s);
      }, { w, h, b64: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length).toString('base64') });
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    },
    close: () => browser.close(),
  };
}

// ------------------------------------------------------------------------------------ mip helpers
/** 2x2 box downsample of an n-channel float image. */
function down(src, w, h, ch) {
  const w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1);
  const out = new Float32Array(w2 * h2 * ch);
  for (let y = 0; y < h2; y++) {
    const y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
    for (let x = 0; x < w2; x++) {
      const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1);
      for (let c = 0; c < ch; c++) {
        out[(y * w2 + x) * ch + c] = 0.25 * (src[(y0 * w + x0) * ch + c] + src[(y0 * w + x1) * ch + c] +
          src[(y1 * w + x0) * ch + c] + src[(y1 * w + x1) * ch + c]);
      }
    }
  }
  return out;
}

function chain(level0, w, h, ch) {
  const levels = [{ data: level0, w, h }];
  while (w > 1 || h > 1) {
    const d = down(levels[levels.length - 1].data, w, h, ch);
    w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
    levels.push({ data: d, w, h });
  }
  return levels;
}

/** Surface description arrays -> encoded texture levels. */
function encodeSurface({ N, albedo, nrm, r4, ao, metal, height, paint }) {
  const A = chain(albedo, N, N, 3);
  const NN = chain(nrm, N, N, 3);
  const R4 = chain(r4, N, N, 1);
  const AO = chain(ao, N, N, 1);
  const M = chain(metal, N, N, 1);
  const H = chain(height, N, N, 1);
  const P = paint ? chain(paint, N, N, 1) : null;

  // paint sets: BC3 sRGB albedo, alpha = paint mask (shader re-colours the paint without touching rust/wood/etc.)
  const albedoLevels = A.map(({ data, w, h }, k) => {
    const rgba = new Uint8Array(w * h * 4);
    const pm = P ? P[k].data : null;
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = l2s(data[i * 3]); rgba[i * 4 + 1] = l2s(data[i * 3 + 1]); rgba[i * 4 + 2] = l2s(data[i * 3 + 2]);
      rgba[i * 4 + 3] = pm ? Math.round(Math.max(0, Math.min(1, pm[i])) * 255) : 255;
    }
    return { w, h, bytes: P ? encodeBC3(rgba, w, h) : encodeBC1(rgba, w, h) };
  });
  const normalLevels = NN.map(({ data, w, h }) => {
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      let x = data[i * 3], y = data[i * 3 + 1], z = data[i * 3 + 2];
      const l = Math.hypot(x, y, z) || 1;
      x /= l; y /= l; z /= l;
      rgba[i * 4] = Math.round((x * 0.5 + 0.5) * 255);
      rgba[i * 4 + 1] = Math.round((y * 0.5 + 0.5) * 255);
    }
    return { w, h, bytes: encodeBC5(rgba, w, h) };
  });
  const maskLevels = [];
  for (let k = 1; k < NN.length; k++) {
    const { w, h } = NN[k];
    const n = NN[k].data, r = R4[k].data, a = AO[k].data, m = M[k].data, hh = H[k].data;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const L = Math.min(1, Math.hypot(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]));
      const variance = L > 0.001 ? (1 - L) / L : 1;
      const a2 = Math.min(1, r[i] + Math.min(2 * variance, 0.5));
      const rough = Math.pow(a2, 0.25);
      rgba[i * 4] = Math.round(Math.max(0, Math.min(1, m[i])) * 255);
      rgba[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, rough)) * 255);
      rgba[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, a[i])) * 255);
      rgba[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, hh[i])) * 255);
    }
    maskLevels.push({ w, h, bytes: encodeBC3(rgba, w, h) });
  }
  // the 1x1 normal level has no mask partner: repeat the smallest mask level
  return {
    albedo: { fmt: P ? 'bc3' : 'bc1', srgb: true, levels: albedoLevels },
    normal: { fmt: 'bc5', levels: normalLevels },
    mask: { fmt: 'bc3', levels: maskLevels },
  };
}

// ------------------------------------------------------------------------------------ file writer
function writeOmat(file, meta, maps) {
  const chunks = [];
  let off = 0;
  const jsonMaps = {};
  for (const [name, m] of Object.entries(maps)) {
    const levels = [];
    for (const l of m.levels) {
      const bytes = l.bytes;
      const pad = (4 - (bytes.length % 4)) % 4;
      levels.push([off, bytes.length, l.w, l.h]);
      chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
      if (pad) chunks.push(Buffer.alloc(pad));
      off += bytes.length + pad;
    }
    jsonMaps[name] = { fmt: m.fmt, srgb: !!m.srgb, width: m.levels[0].w, height: m.levels[0].h, levels };
  }
  const payload = Buffer.concat(chunks);
  const z = zlib.deflateRawSync(payload, { level: 9 });
  const useZ = z.length < payload.length * 0.93;
  const json = Buffer.from(JSON.stringify({ ...meta, gpuBytes: payload.length, maps: jsonMaps }));
  const jpad = (4 - (json.length % 4)) % 4;
  const head = Buffer.alloc(16);
  head.write('OMAT', 0, 'ascii');
  head.writeUInt32LE(1, 4);
  head.writeUInt32LE(useZ ? 1 : 0, 8);
  head.writeUInt32LE(json.length + jpad, 12);
  fs.writeFileSync(file, Buffer.concat([head, json, Buffer.alloc(jpad, 32), useZ ? z : payload]));
  return { gpu: payload.length, disk: fs.statSync(file).size };
}

// ------------------------------------------------------------------------------------ Poly Haven sets
async function bakeSet(dec, id, opt) {
  const dir = path.join(CACHE, id);
  const find = (s) => ['jpg', 'png'].map((e) => path.join(dir, `${s}.${e}`)).find((f) => fs.existsSync(f));
  const fDiff = find('diff'), fNor = find('nor'), fArm = find('arm'), fDisp = find('disp');
  if (!fDiff || !fNor) throw new Error(`missing sources for ${id}; run fetch.mjs`);
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'info.json'), 'utf8'));
  const dims = info.dimensions || [opt.size * 1000, opt.size * 1000];
  const size = [dims[0] / 1000, dims[1] / 1000];

  const diff = await dec.decode(fDiff);
  const nor = await dec.decode(fNor);
  const arm = fArm ? await dec.decode(fArm) : null;
  let rough = null, aoS = null;
  if (!arm) { const fr = find('rough'), fa = find('ao'); rough = fr && await dec.decode(fr); aoS = fa && await dec.decode(fa); }
  const disp = fDisp ? await dec.decode(fDisp) : null;
  const SW = diff.w, SH = diff.h;
  const N = opt.res || 1024;
  const fx = SW / N, fy = SH / N;
  const f = Math.max(1, Math.round(Math.max(fx, fy))); // samples per axis
  const n2 = N * N;
  const albedo = new Float32Array(n2 * 3), nrm = new Float32Array(n2 * 3);
  const r4 = new Float32Array(n2), ao = new Float32Array(n2), metal = new Float32Array(n2), height = new Float32Array(n2);
  const ch = (img, x, y, c) => img.data[((y * img.w) + x) * 4 + c];
  const scaleXY = (img, x, y) => [Math.min(img.w - 1, Math.floor(x * img.w / SW)), Math.min(img.h - 1, Math.floor(y * img.h / SH))];
  const al = opt.albedo || {};
  const ro = opt.rough || {};
  let sumA = [0, 0, 0], sumR = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const o = y * N + x;
      let ar = 0, ag = 0, ab = 0, nx = 0, ny = 0, nz = 0, rr = 0, aa = 0, mm = 0, hh = 0;
      for (let sy = 0; sy < f; sy++) {
        // flip: target row y (bottom-up) reads source row from the bottom
        const py = SH - 1 - Math.min(SH - 1, Math.floor((y + (sy + 0.5) / f) * fy));
        for (let sx = 0; sx < f; sx++) {
          const px = Math.min(SW - 1, Math.floor((x + (sx + 0.5) / f) * fx));
          ar += S2L[ch(diff, px, py, 0)]; ag += S2L[ch(diff, px, py, 1)]; ab += S2L[ch(diff, px, py, 2)];
          let [qx, qy] = scaleXY(nor, px, py);
          let vx = ch(nor, qx, qy, 0) / 127.5 - 1, vy = ch(nor, qx, qy, 1) / 127.5 - 1, vz = ch(nor, qx, qy, 2) / 127.5 - 1;
          const l = Math.hypot(vx, vy, vz) || 1;
          nx += vx / l; ny += vy / l; nz += vz / l;
          let r, a, m;
          if (arm) { [qx, qy] = scaleXY(arm, px, py); a = ch(arm, qx, qy, 0) / 255; r = ch(arm, qx, qy, 1) / 255; m = ch(arm, qx, qy, 2) / 255; }
          else {
            r = rough ? ch(rough, ...scaleXY(rough, px, py), 0) / 255 : 0.8;
            a = aoS ? ch(aoS, ...scaleXY(aoS, px, py), 0) / 255 : 1;
            m = 0;
          }
          r = r * (ro.gain ?? 1) + (ro.bias ?? 0);
          r = Math.max(ro.min ?? 0.04, Math.min(ro.max ?? 1, r));
          rr += r * r * r * r; aa += a; mm += opt.metal ? m : 0;
          if (disp) { [qx, qy] = scaleXY(disp, px, py); hh += ch(disp, qx, qy, 0) / 255; } else hh += 0.5;
        }
      }
      const inv = 1 / (f * f);
      ar *= inv; ag *= inv; ab *= inv; aa *= inv; mm *= inv; hh *= inv; rr *= inv;
      // albedo adjustments (linear light)
      const lum = 0.2126 * ar + 0.7152 * ag + 0.0722 * ab;
      const sat = al.sat ?? 1;
      ar = lum + (ar - lum) * sat; ag = lum + (ag - lum) * sat; ab = lum + (ab - lum) * sat;
      const gain = al.gain ?? 1;
      const tint = al.tint || [1, 1, 1];
      const cav = 1 - (al.ao ?? 0.35) * (1 - aa);
      ar *= gain * tint[0] * cav; ag *= gain * tint[1] * cav; ab *= gain * tint[2] * cav;
      if (al.gamma) { ar = Math.pow(ar, al.gamma); ag = Math.pow(ag, al.gamma); ab = Math.pow(ab, al.gamma); }
      // physically plausible range (charcoal ~0.02 .. fresh snow ~0.9)
      const lo = 0.012, hi = 0.88;
      albedo[o * 3] = Math.max(lo, Math.min(hi, ar));
      albedo[o * 3 + 1] = Math.max(lo, Math.min(hi, ag));
      albedo[o * 3 + 2] = Math.max(lo, Math.min(hi, ab));
      nrm[o * 3] = nx * inv; nrm[o * 3 + 1] = ny * inv; nrm[o * 3 + 2] = nz * inv;
      r4[o] = rr; ao[o] = aa; metal[o] = mm; height[o] = hh;
      sumA[0] += albedo[o * 3]; sumA[1] += albedo[o * 3 + 1]; sumA[2] += albedo[o * 3 + 2]; sumR += Math.pow(rr, 0.25);
    }
  }
  // normalise height to 0..1 (robust percentiles) so height blends behave the same for every set
  {
    const hist = new Uint32Array(1024);
    for (let i = 0; i < n2; i++) hist[Math.min(1023, Math.floor(height[i] * 1023))]++;
    let acc = 0, p2 = 0, p98 = 1;
    for (let i = 0; i < 1024; i++) { acc += hist[i]; if (acc < n2 * 0.02) p2 = i / 1023; if (acc < n2 * 0.98) p98 = i / 1023; }
    const span = Math.max(0.02, p98 - p2);
    for (let i = 0; i < n2; i++) height[i] = Math.max(0, Math.min(1, (height[i] - p2) / span));
  }
  const paintInfo = opt.paint ? paintMask(N, albedo, opt.paint) : null;
  if (paintInfo) {
    // recompute the average over the (partly neutralised) albedo
    sumA = [0, 0, 0];
    for (let i = 0; i < n2; i++) { sumA[0] += albedo[i * 3]; sumA[1] += albedo[i * 3 + 1]; sumA[2] += albedo[i * 3 + 2]; }
  }
  if (PREVIEW) {
    const rgba = new Uint8Array(n2 * 4);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = (N - 1 - y) * N + x, o = (y * N + x) * 4;
      const m = paintInfo ? paintInfo.mask[i] : 1;
      rgba[o] = l2s(albedo[i * 3]); rgba[o + 1] = l2s(albedo[i * 3 + 1] * (0.4 + 0.6 * m)); rgba[o + 2] = l2s(albedo[i * 3 + 2]); rgba[o + 3] = 255;
    }
    await dec.png(path.join(PREVIEW, `${id}-paint.png`), N, N, rgba);
    log(`${id}: preview written, paint`, paintInfo && { cover: paintInfo.cover, avgLum: paintInfo.avgLum, ref: paintInfo.ref });
    return { gpu: 0, disk: 0, preview: true };
  }
  const maps = encodeSurface({ N, albedo, nrm, r4, ao, metal, height, paint: paintInfo?.mask });
  const meta = {
    id, source: `https://polyhaven.com/a/${id}`, license: 'CC0', size,
    avgAlbedo: sumA.map((v) => +(v / n2).toFixed(4)), avgRoughness: +(sumR / n2).toFixed(3),
  };
  if (paintInfo) meta.paint = { avgLum: paintInfo.avgLum, ref: paintInfo.ref, cover: paintInfo.cover, base: paintInfo.base };
  return writeOmat(path.join(OUT, `${id}.omat`), meta, maps);
}

/**
 * Paint mask: pixels whose chromaticity is close to the paint's reference colour (or all pixels with
 * {all:true}). Paint pixels are neutralised to their luminance in-place so the shader can re-colour them
 * (catalog `paint` colour / world tints) without re-colouring rust, primer, wood or concrete.
 *   opt: { ref: 0xRRGGBB sRGB, tol, soft, all, minLum, maxLum }
 */
function paintMask(N, albedo, opt) {
  const n2 = N * N;
  let mask = new Float32Array(n2);
  const toLin = (c) => S2L[c];
  let rc;
  if (opt.ref !== undefined) {
    const ref = [toLin((opt.ref >> 16) & 255), toLin((opt.ref >> 8) & 255), toLin(opt.ref & 255)];
    const rs = ref[0] + ref[1] + ref[2];
    rc = [ref[0] / rs, ref[1] / rs, ref[2] / rs];
  } else {
    // auto: the dominant chromaticity (mode of a smoothed 2D r/g chroma histogram) is the paint
    const B = 96, hist = new Float32Array(B * B);
    for (let i = 0; i < n2; i++) {
      const r = albedo[i * 3], g = albedo[i * 3 + 1], b = albedo[i * 3 + 2];
      const s = r + g + b + 1e-5;
      hist[Math.min(B - 1, Math.floor(r / s * B)) * B + Math.min(B - 1, Math.floor(g / s * B))]++;
    }
    let best = -1, bi = 0, bj = 0;
    for (let i = 1; i < B - 1; i++) for (let j = 1; j < B - 1; j++) {
      let v = 0;
      for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) v += hist[(i + a) * B + j + c];
      if (v > best) { best = v; bi = i; bj = j; }
    }
    const cr = (bi + 0.5) / B, cg = (bj + 0.5) / B;
    rc = [cr, cg, 1 - cr - cg];
  }
  const tol = opt.tol ?? 0.04, soft = opt.soft ?? 0.04;
  for (let i = 0; i < n2; i++) {
    if (opt.all) { mask[i] = 1; continue; }
    const r = albedo[i * 3], g = albedo[i * 3 + 1], b = albedo[i * 3 + 2];
    const s = r + g + b + 1e-5;
    const d = Math.hypot(r / s - rc[0], g / s - rc[1], b / s - rc[2]);
    let m = 1 - Math.max(0, Math.min(1, (d - tol) / soft));
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (opt.minLum !== undefined) m *= Math.max(0, Math.min(1, (lum - opt.minLum) / (opt.minLum * 0.5 + 1e-3)));
    if (opt.maxLum !== undefined) m *= Math.max(0, Math.min(1, (opt.maxLum - lum) / (opt.maxLum * 0.2)));
    mask[i] = m;
  }
  // 2x 3x3 box blur (wrapping) so the mask edge is soft and speckle-free
  for (let pass = 0; pass < 2 && !opt.all; pass++) {
    const out = new Float32Array(n2);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let s = 0;
      for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) s += mask[((y + j + N) % N) * N + ((x + k + N) % N)];
      out[y * N + x] = s / 9;
    }
    mask = out;
  }
  let lumSum = 0, wSum = 0;
  const refAcc = [0, 0, 0], baseAcc = [0, 0, 0];
  let baseW = 0;
  for (let i = 0; i < n2; i++) {
    const m = mask[i];
    const r = albedo[i * 3], g = albedo[i * 3 + 1], b = albedo[i * 3 + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    refAcc[0] += r * m; refAcc[1] += g * m; refAcc[2] += b * m;
    baseAcc[0] += r * (1 - m); baseAcc[1] += g * (1 - m); baseAcc[2] += b * (1 - m); baseW += 1 - m;
    albedo[i * 3] = r + (lum - r) * m;
    albedo[i * 3 + 1] = g + (lum - g) * m;
    albedo[i * 3 + 2] = b + (lum - b) * m;
    lumSum += lum * m; wSum += m;
  }
  const w = Math.max(1e-5, wSum);
  return {
    mask,
    cover: +(wSum / n2).toFixed(3),
    avgLum: +(lumSum / w).toFixed(4),
    ref: refAcc.map((v) => +(v / w).toFixed(4)),
    base: baseAcc.map((v) => +(v / Math.max(1e-5, baseW)).toFixed(4)),
  };
}

// ------------------------------------------------------------------------------------ procedural shared set
function hash(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const mod = (a, n) => ((a % n) + n) % n;
function vnoise(x, y, px, py, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash(mod(x0, px), mod(y0, py), seed), b = hash(mod(x0 + 1, px), mod(y0, py), seed);
  const c = hash(mod(x0, px), mod(y0 + 1, py), seed), d = hash(mod(x0 + 1, px), mod(y0 + 1, py), seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
/** periodic fbm over u,v in [0,1) */
function fbm(u, v, px, py, oct, gain, seed) {
  let s = 0, amp = 0.5, tot = 0;
  for (let o = 0; o < oct; o++) {
    s += amp * vnoise(u * px, v * py, px, py, seed + o * 17);
    tot += amp; amp *= gain; px *= 2; py *= 2;
  }
  return s / tot;
}
/** periodic worley F1 (distance in cell units) + cell id hash */
function worley(u, v, cells, seed) {
  const x = u * cells, y = v * cells;
  const cx = Math.floor(x), cy = Math.floor(y);
  let best = 9, id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gy = cy + j;
      const hx = mod(gx, cells), hy = mod(gy, cells);
      const px = gx + hash(hx, hy, seed), py = gy + hash(hx, hy, seed + 1);
      const d = Math.hypot(px - x, py - y);
      if (d < best) { best = d; id = hash(hx, hy, seed + 2); }
    }
  }
  return [best, id];
}
function heightToNormal(hgt, S, strength) {
  const n = new Float32Array(S * S * 3);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const hL = hgt[y * S + mod(x - 1, S)], hR = hgt[y * S + mod(x + 1, S)];
      const hD = hgt[mod(y - 1, S) * S + x], hU = hgt[mod(y + 1, S) * S + x];
      let nx = -(hR - hL) * strength, ny = -(hU - hD) * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      n[(y * S + x) * 3] = nx / l; n[(y * S + x) * 3 + 1] = ny / l; n[(y * S + x) * 3 + 2] = nz / l;
    }
  }
  return n;
}
function normalMaps(nrm, S) {
  const NN = chain(nrm, S, S, 3);
  return {
    fmt: 'bc5',
    levels: NN.map(({ data, w, h }) => {
      const rgba = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const l = Math.hypot(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]) || 1;
        rgba[i * 4] = Math.round((data[i * 3] / l * 0.5 + 0.5) * 255);
        rgba[i * 4 + 1] = Math.round((data[i * 3 + 1] / l * 0.5 + 0.5) * 255);
      }
      return { w, h, bytes: encodeBC5(rgba, w, h) };
    }),
  };
}

function bakeShared() {
  const S = 512;
  // noise RGBA8 (raw, GPU builds mips): R macro fbm, G medium fbm, B blotch fbm, A vertical streaks
  const noise = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S, o = (y * S + x) * 4;
      noise[o] = Math.round(fbm(u, v, 4, 4, 5, 0.5, 11) * 255);
      noise[o + 1] = Math.round(fbm(u, v, 16, 16, 5, 0.55, 23) * 255);
      const bl = fbm(u, v, 8, 8, 6, 0.6, 37);
      noise[o + 2] = Math.round(Math.max(0, Math.min(1, (bl - 0.5) * 2.2 + 0.5)) * 255);
      // streaks: thin vertical runs (elongated along v), a few strong, broken up along their length
      const st = fbm(u, v, 96, 3, 3, 0.5, 51);
      const brk = fbm(u, v, 24, 6, 3, 0.5, 53);
      const s = Math.max(0, Math.min(1, (st - 0.45) * 3.0)) * Math.max(0, Math.min(1, (brk - 0.3) * 2));
      noise[o + 3] = Math.round(s * 255);
    }
  }
  // detail normals
  const hMicro = new Float32Array(S * S), hBrush = new Float32Array(S * S), hStip = new Float32Array(S * S), hPore = new Float32Array(S * S), hWrink = new Float32Array(S * S);
  const scratches = [];
  for (let i = 0; i < 90; i++) scratches.push([hash(i, 1, 901), hash(i, 2, 901), 0.02 + hash(i, 3, 901) * 0.25, (hash(i, 4, 901) - 0.5) * 0.25, 0.3 + hash(i, 5, 901)]);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S, o = y * S + x;
      // micro: grit + fine pitting, isotropic
      const [wd] = worley(u, v, 48, 71);
      hMicro[o] = fbm(u, v, 32, 32, 4, 0.55, 61) * 0.8 + Math.min(1, wd * 2.5) * 0.35 + hash(x, y, 67) * 0.12;
      // brushed / machined: long lines along u + sparse scratches
      let hb = fbm(u, v, 3, 384, 2, 0.5, 81) * 0.7 + fbm(u, v, 12, 128, 2, 0.5, 83) * 0.3;
      for (const [sx, sy, len, slope, depth] of scratches) {
        const du = mod(u - sx + 0.5, 1) - 0.5;
        if (Math.abs(du) > len) continue;
        const lineV = sy + du * slope;
        const dv = Math.abs(mod(v - lineV + 0.5, 1) - 0.5) * S;
        if (dv < 1.5) hb -= depth * (1 - dv / 1.5) * 0.6;
      }
      hBrush[o] = hb;
      // stipple: molded polymer texture, domes of random radius
      const [sd, sid] = worley(u, v, 64, 91);
      const r = 0.35 + sid * 0.25;
      const t = Math.max(0, 1 - sd / r);
      hStip[o] = t * t * (3 - 2 * t) * 0.9 + fbm(u, v, 64, 64, 2, 0.5, 93) * 0.15;
      // pores + fine wrinkles (skin / leather-ish)
      const [pd] = worley(u, v, 40, 111);
      const pit = Math.max(0, 1 - pd / 0.22);
      hPore[o] = -pit * pit * 0.8 + fbm(u, v, 6, 48, 3, 0.5, 113) * 0.35 + fbm(u, v, 48, 6, 3, 0.5, 117) * 0.25;
      // cloth wrinkles / folds (v2): smooth warped sine folds along a few lattice-aligned directions
      // (integer frequencies keep tiling). Crests are narrower than valleys like tensioned fabric; each
      // family is masked to patches so folds come and go. (v1 ridged value noise read as contour lines.)
      const dirs = [[u, 5], [u + v, 4], [u - v, 4], [2 * u + v, 2], [v, 3]];
      let hw = 0;
      dirs.forEach(([a, f], k) => {
        const warp = fbm(u, v, 3, 3, 3, 0.5, 131 + k) * 0.9 + fbm(u, v, 7, 7, 2, 0.5, 171 + k) * 0.25;
        const sn = Math.sin(2 * Math.PI * (a * f + warp));
        const crest = Math.pow(0.5 + 0.5 * sn, 2.5);
        const mask = fbm(u, v, 2, 2, 3, 0.5, 151 + k);
        const mm = Math.max(0, Math.min(1, (mask - 0.42) * 3.0));
        hw += crest * mm * mm * (3 - 2 * mm);
      });
      hWrink[o] = hw * 0.5 + fbm(u, v, 8, 8, 3, 0.5, 161) * 0.12;
    }
  }
  const maps = {
    noise: { fmt: 'rgba8', levels: [{ w: S, h: S, bytes: noise }] },
    dnMicro: normalMaps(heightToNormal(hMicro, S, 5), S),
    dnBrushed: normalMaps(heightToNormal(hBrush, S, 7), S),
    dnStipple: normalMaps(heightToNormal(hStip, S, 5), S),
    dnPores: normalMaps(heightToNormal(hPore, S, 4), S),
    dnWrinkle: normalMaps(heightToNormal(hWrink, S, 9), S),
  };
  return writeOmat(path.join(OUT, 'shared.omat'), { id: 'shared', license: 'original (procedural)' }, maps);
}

// ------------------------------------------------------------------------------------ main
const argv0 = process.argv.slice(2);
const pi = argv0.indexOf('--preview');
const PREVIEW = pi >= 0 ? argv0[pi + 1] : null;
const args = pi >= 0 ? argv0.filter((_, i) => i !== pi + 1) : argv0;
if (PREVIEW) fs.mkdirSync(PREVIEW, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const manifestFile = path.join(OUT, 'manifest.json');
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { sets: {} };
const t0 = Date.now();
if (!PREVIEW && (args.includes('--shared') || args.length === 0)) {
  const r = bakeShared();
  manifest.shared = r;
  log(`shared: gpu ${(r.gpu / 1048576).toFixed(2)} MB, disk ${(r.disk / 1048576).toFixed(2)} MB`);
}
const ids = args.filter((a) => !a.startsWith('--'));
const todo = ids.length === 0 && !args.includes('--shared') ? Object.keys(SETS) : ids;
if (todo.length) {
  const dec = await makeDecoder();
  try {
    for (const id of todo) {
      if (!SETS[id]) { log(`unknown set ${id}`); continue; }
      const t = Date.now();
      const r = await bakeSet(dec, id, SETS[id]);
      if (r.preview) continue;
      manifest.sets[id] = { ...r, res: SETS[id].res };
      log(`${id}: ${SETS[id].res}px gpu ${(r.gpu / 1048576).toFixed(2)} MB disk ${(r.disk / 1048576).toFixed(2)} MB (${Date.now() - t} ms)`);
    }
  } finally { await dec.close(); }
}
for (const id of Object.keys(manifest.sets)) if (!SETS[id]) delete manifest.sets[id];
let gpu = manifest.shared?.gpu || 0, disk = manifest.shared?.disk || 0;
for (const s of Object.values(manifest.sets)) { gpu += s.gpu; disk += s.disk; }
manifest.totalGpuBytes = gpu;
manifest.totalDiskBytes = disk;
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
log(`total gpu ${(gpu / 1048576).toFixed(1)} MB, disk ${(disk / 1048576).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(1)} s`);

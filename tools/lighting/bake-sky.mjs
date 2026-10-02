// Bakes a Poly Haven "puresky" equirect HDR into the runtime sky texture used by src/systems/lighting.
//
//   node tools/lighting/bake-sky.mjs <in.hdr> <outName> [--width 8192] [--height 2048] [--quality 0.93]
//
// Output (public/assets/lighting/):
//   <outName>.jpg   upper hemisphere (+ a few degrees below the horizon), equirect, 8-bit sRGB JPEG with a
//                   reversible HDR encoding:  y = x / (1 + x),  x = L / K   (K = sky normalisation)
//                   decode in the shader:     x = y / (1 - y),  L = x * K    (y = sRGB-decoded texel)
//   <outName>.json  metadata: sun position in texture space, sun/sky irradiance ratio, colours, crop.
//
// JPEG encoding is done by headless Chromium (playwright) so no extra npm packages are needed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { readHDR, lum, writePNG } from './hdrlib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const [inFile, outName] = args;
if (!inFile || !outName) { console.error('usage: bake-sky.mjs <in.hdr> <outName>'); process.exit(1); }
const OUT_W = +opt('width', 8192);
const OUT_H = +opt('height', 2048);
const QUALITY = +opt('quality', 0.93);
const KNEE = +opt('knee', 5);   // x = L/K where highlight compression starts
const XMAX = +opt('xmax', 18);  // asymptote of the compressed highlights
const ELEV_TOP = 90, ELEV_BOTTOM = -6;
const outDir = path.join(ROOT, 'public', 'assets', 'lighting');
fs.mkdirSync(outDir, { recursive: true });

console.error('reading', inFile);
const img = readHDR(inFile);
const { width: W, height: H, data } = img;
console.error(`  ${W}x${H}`);

// ---------------------------------------------------------------- sun
let peak = 0;
for (let i = 0; i < W * H; i++) { const L = lum(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]); if (L > peak) peak = L; }
let cx = 0, cy = 0, cv = 0, cw = 0;
for (let y = 0; y < H / 2 + 4; y++) for (let x = 0; x < W; x++) {
  const i = y * W + x;
  const L = lum(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]);
  if (L < peak * 0.5) continue;
  const a = (x + 0.5) / W * Math.PI * 2;
  cx += Math.cos(a) * L; cy += Math.sin(a) * L; cv += (y + 0.5) * L; cw += L;
}
let sunU = Math.atan2(cy, cx) / (Math.PI * 2); if (sunU < 0) sunU += 1;
const sunVTop = cv / cw / H;
const sunElev = (0.5 - sunVTop) * 180;
console.error(`  sun u=${sunU.toFixed(4)} elev=${sunElev.toFixed(2)} peak=${peak.toFixed(0)}`);

const pxSolid = (y) => (2 * Math.PI / W) * (Math.PI / H) * Math.cos((0.5 - (y + 0.5) / H) * Math.PI);
const dirOf = (x, y) => {
  const phi = ((x + 0.5) / W) * Math.PI * 2, th = (0.5 - (y + 0.5) / H) * Math.PI;
  return [Math.cos(th) * Math.cos(phi), Math.sin(th), Math.cos(th) * Math.sin(phi)];
};
const sd = (() => { const phi = sunU * Math.PI * 2, th = sunElev * Math.PI / 180; return [Math.cos(th) * Math.cos(phi), Math.sin(th), Math.cos(th) * Math.sin(phi)]; })();

// sky luminance statistics (upper hemisphere), local sky level around the sun (ring 4..8 deg)
const lums = [];
let ringSum = [0, 0, 0], ringN = 0;
let skyE = [0, 0, 0];
const SUN_R = 3.0 * Math.PI / 180; // pixels inside this cone are "sun" candidates
for (let y = 0; y < H / 2; y++) {
  const dw = pxSolid(y);
  for (let x = 0; x < W; x += 1) {
    const i = (y * W + x) * 3;
    const d = dirOf(x, y);
    const ang = Math.acos(Math.min(1, d[0] * sd[0] + d[1] * sd[1] + d[2] * sd[2]));
    if ((x & 7) === 0 && (y & 7) === 0) lums.push(lum(data[i], data[i + 1], data[i + 2]));
    if (ang > 4 * Math.PI / 180 && ang < 8 * Math.PI / 180) { ringSum[0] += data[i]; ringSum[1] += data[i + 1]; ringSum[2] += data[i + 2]; ringN++; }
  }
}
lums.sort((a, b) => a - b);
const K = lums[Math.floor(lums.length * 0.5)];
const ring = ringSum.map((v) => v / ringN);
const ringL = lum(...ring);
// sun irradiance (normal incidence) = sum over sun pixels of (L - ring) dw ; sky irradiance on horizontal plane excluding the sun
let sunE = [0, 0, 0];
for (let y = 0; y < H / 2; y++) {
  const dw = pxSolid(y);
  const cosZ = Math.sin((0.5 - (y + 0.5) / H) * Math.PI);
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    const d = dirOf(x, y);
    const ang = Math.acos(Math.min(1, d[0] * sd[0] + d[1] * sd[1] + d[2] * sd[2]));
    const L = lum(data[i], data[i + 1], data[i + 2]);
    if (ang < SUN_R && L > ringL * 8) {
      for (let c = 0; c < 3; c++) sunE[c] += Math.max(0, data[i + c] - ring[c]) * dw;
      for (let c = 0; c < 3; c++) skyE[c] += ring[c] * dw * cosZ;
    } else {
      for (let c = 0; c < 3; c++) skyE[c] += data[i + c] * dw * cosZ;
    }
  }
}
const sunEL = lum(...sunE), skyEL = lum(...skyE);
console.error(`  K=${K.toFixed(4)} sunE=${sunEL.toFixed(3)} (normal)  skyE=${skyEL.toFixed(3)} (horizontal)  ratio=${(sunEL / skyEL).toFixed(2)}`);
const sunColor = sunE.map((v) => v / Math.max(...sunE));

// horizon colour away from the sun and toward the sun (elev 1..6 deg)
function bandAvg(e0, e1, towardSun) {
  const s = [0, 0, 0]; let n = 0;
  for (let y = 0; y < H / 2; y++) {
    const el = (0.5 - (y + 0.5) / H) * 180;
    if (el < e0 || el > e1) continue;
    for (let x = 0; x < W; x += 2) {
      const d = dirOf(x, y);
      const c = d[0] * sd[0] + d[2] * sd[2];
      const hz = Math.hypot(d[0], d[2]) * Math.hypot(sd[0], sd[2]);
      const cosAz = c / hz;
      if (towardSun ? cosAz < 0.7 : cosAz > -0.2) continue;
      const i = (y * W + x) * 3;
      s[0] += data[i]; s[1] += data[i + 1]; s[2] += data[i + 2]; n++;
    }
  }
  return s.map((v) => v / n / K);
}
const horizonAway = bandAvg(1, 6, false);
const horizonToward = bandAvg(1, 6, true);
const zenith = bandAvg(60, 90, false);
// horizon colour per azimuth (12 sectors in texture-u space, elev 0.5..5 deg, gaussian-smoothed) -> fog in-scatter
const HZN = 12;
const horizon = [];
{
  const acc = Array.from({ length: W }, () => [0, 0, 0]);
  let rows = 0;
  for (let y = 0; y < H / 2; y++) {
    const el = (0.5 - (y + 0.5) / H) * 180;
    if (el < 0.5 || el > 5) continue;
    rows++;
    for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; for (let c = 0; c < 3; c++) acc[x][c] += Math.min(data[i + c], 40 * K); }
  }
  for (let k = 0; k < HZN; k++) {
    const s = [0, 0, 0]; let wsum = 0;
    const cu = (k + 0.5) / HZN;
    for (let x = 0; x < W; x += 2) {
      let du = (x + 0.5) / W - cu; du -= Math.round(du);
      const w = Math.exp(-0.5 * (du * HZN / 0.8) ** 2);
      for (let c = 0; c < 3; c++) s[c] += acc[x][c] / rows * w;
      wsum += w;
    }
    horizon.push(s.map((v) => v / wsum / K));
  }
}

// ---------------------------------------------------------------- resample + encode
const out = new Uint8Array(OUT_W * OUT_H * 3);
const toSRGB = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const sample = (fx, fy, c) => {
  fx = ((fx % W) + W) % W;
  fy = Math.max(0, Math.min(H - 1, fy));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = (x0 + 1) % W, y1 = Math.min(H - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const a = data[(y0 * W + x0) * 3 + c], b = data[(y0 * W + x1) * 3 + c];
  const d = data[(y1 * W + x0) * 3 + c], e = data[(y1 * W + x1) * 3 + c];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
};
const sx = W / OUT_W;
for (let r = 0; r < OUT_H; r++) {
  const el = ELEV_TOP - ((r + 0.5) / OUT_H) * (ELEV_TOP - ELEV_BOTTOM);
  const fy = ((90 - el) / 180) * H - 0.5;
  for (let x = 0; x < OUT_W; x++) {
    const fx = (x + 0.5) * sx - 0.5;
    const px = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      // box-filter horizontally when downsampling
      let v = 0;
      if (sx > 1) { for (let k = 0; k < sx; k++) v += sample(fx - (sx - 1) / 2 + k, fy, c); v /= Math.ceil(sx); } else v = sample(fx, fy, c);
      px[c] = v / K;
    }
    // soft-knee highlight compression: the sun and the inner aureole are re-created analytically at runtime.
    // Without this the x/(1+x) code values sit at ~1.0 where one JPEG quantisation step is a huge radiance
    // jump -> blocky / streaky artefacts around the sun (worse once the elevation warp stretches them).
    const lx = lum(px[0], px[1], px[2]);
    if (lx > KNEE) {
      const t = lx - KNEE;
      const nl = KNEE + t / (1 + t / (XMAX - KNEE));
      const sc = nl / lx;
      // desaturate toward the knee's asymptote so hue stays stable in the clipped core
      for (let c = 0; c < 3; c++) px[c] *= sc;
    }
    for (let c = 0; c < 3; c++) {
      const y = px[c] / (1 + px[c]);
      out[(r * OUT_W + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(toSRGB(y) * 255)));
    }
  }
}

const tmpPng = path.join(process.env.TEMP || '/tmp', `sky-bake-${process.pid}.png`);
writePNG(tmpPng, OUT_W, OUT_H, out);
console.error('  png written, encoding jpeg...');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.route('https://bake.local/**', (route) => {
  const url = route.request().url();
  if (url.endsWith('.png')) return route.fulfill({ body: fs.readFileSync(tmpPng), contentType: 'image/png' });
  return route.fulfill({ body: '<html><body></body></html>', contentType: 'text/html' });
});
await page.goto('https://bake.local/index.html');
const b64 = await page.evaluate(async (q) => {
  const im = new Image();
  im.src = '/sky.png';
  await im.decode();
  const c = document.createElement('canvas');
  c.width = im.naturalWidth; c.height = im.naturalHeight;
  c.getContext('2d').drawImage(im, 0, 0);
  const url = c.toDataURL('image/jpeg', q);
  return url.slice(url.indexOf(',') + 1);
}, QUALITY);
await browser.close();
fs.unlinkSync(tmpPng);
const jpgPath = path.join(outDir, `${outName}.jpg`);
fs.writeFileSync(jpgPath, Buffer.from(b64, 'base64'));

const meta = {
  knee: KNEE, xmax: XMAX,
  source: path.basename(inFile),
  license: 'CC0 (Poly Haven)',
  width: OUT_W, height: OUT_H, elevTop: ELEV_TOP, elevBottom: ELEV_BOTTOM,
  K,
  sun: { u: sunU, elevationDeg: sunElev, color: sunColor, irradianceOverK: sunEL / K },
  sky: { irradianceOverK: skyEL / K, horizonAway, horizonToward, zenith, horizon },
  sunToSkyRatio: sunEL / skyEL,
};
fs.writeFileSync(path.join(outDir, `${outName}.json`), JSON.stringify(meta, null, 2));
console.error(`  wrote ${jpgPath} (${(fs.statSync(jpgPath).size / 1e6).toFixed(2)} MB)`);
console.log(JSON.stringify(meta, null, 2));

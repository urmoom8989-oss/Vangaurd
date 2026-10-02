import * as THREE from 'three';
import { drawVehicleAtlas } from './vehicleAtlas.js';

/**
 * Procedural canvas textures owned by the world system (deterministic: seeded rng, no wall clock).
 *  interior   : 4x4 atlas of room back walls (top half) + curtain/blind overlays with alpha (bottom half)
 *  glass      : 2x2 atlas of broken-glass remnants (alpha)
 *  decals     : 8x8 atlas of grime/leak/crack/stain/scorch/litter decals (alpha)
 *  signs      : 4x8 atlas of shop signs with fictional Cyrillic-style text
 *  foliage    : 4x2 atlas of weed / grass / leaf cards (alpha)
 *  hesco      : geotextile + wire mesh (tiling)
 */

function noiseCanvas(rng, w, h, cells, alpha = 1) {
  const c = document.createElement('canvas');
  c.width = cells; c.height = Math.max(1, Math.round(cells * h / w));
  const g = c.getContext('2d');
  const img = g.createImageData(c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = rng.next() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255 * alpha;
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Soft multi-octave noise overlay drawn with the given composite op. */
function drawNoise(g, rng, x, y, w, h, { octaves = 4, base = 4, alpha = 0.25, op = 'overlay' } = {}) {
  g.save();
  g.globalCompositeOperation = op;
  g.imageSmoothingEnabled = true;
  for (let o = 0; o < octaves; o++) {
    const cells = base * (1 << o);
    g.globalAlpha = alpha / (o * 0.6 + 1);
    g.drawImage(noiseCanvas(rng, w, h, cells), x, y, w, h);
  }
  g.restore();
}

const FAKE_WORDS = [
  'ПРОДУКТЫ', 'ХЛЕБ', 'АПТЕКА', 'КАФЕ ВАРДАН', 'ГАСТРОНОМ', 'УНИВЕРМАГ', 'ПОЧТА', 'РЕМОНТ ОБУВИ',
  'МАГАЗИН №7', 'ФОТО', 'ПАРИКМАХЕРСКАЯ', 'ОВОЩИ ФРУКТЫ', 'ШИНОМОНТАЖ', 'ТЕЛЕГРАФ', 'КНИГИ', 'ХОЗТОВАРЫ',
  'СТОЛОВАЯ', 'ВАРДАНЕК', 'БАНК', 'МЯСО', 'ЧАЙХАНА', 'ТАБАК', 'ЭЛЕКТРО', 'ГОСТИНИЦА',
  'АВТОСЕРВИС', 'ТОПЛИВО', 'МЕБЕЛЬ', 'ОБУВЬ', 'ОДЕЖДА', 'ЦВЕТЫ', 'МОЛОКО', 'РЫНОК',
];

export function createTextures(ctx, mats, rng) {
  const A = ctx.assets;
  const out = {};

  // ------------------------------------------------------------------ interior atlas (1024x1024)
  out.interior = mats.track(A.canvasTexture(1024, 1024, (g) => {
    const cell = 256;
    const wallCols = ['#8f8a78', '#7b8a86', '#9c8d74', '#6f7466', '#8a7a6c', '#a19a88', '#6c6a70', '#8c8062',
      '#77806e', '#968676', '#7a7466', '#8b8d82', '#6f6358', '#958a70', '#7e8479', '#9a9080'];
    for (let k = 0; k < 16; k++) {
      const cx = (k % 4) * cell, cy = Math.floor(k / 4) * cell * 0.5;
      const ch = cell * 0.5; // back walls are 256x128 (wide rooms)
      g.fillStyle = wallCols[k];
      g.fillRect(cx, cy, cell, ch);
      // wallpaper pattern
      if (k % 3 !== 0) {
        g.globalAlpha = 0.18;
        g.fillStyle = k % 2 ? '#ffffff' : '#000000';
        for (let x = 0; x < cell; x += 10 + (k % 4) * 3) g.fillRect(cx + x, cy, 3, ch);
        g.globalAlpha = 1;
      }
      // hanging rug (classic)
      if (k % 4 === 1) {
        g.fillStyle = ['#6b2a22', '#5a2b3a', '#7a3a1a'][k % 3];
        const rw = 90, rh = 60, rx = cx + 40 + (k * 13) % 100, ry = cy + 22;
        g.fillRect(rx, ry, rw, rh);
        g.strokeStyle = '#c9a25a'; g.lineWidth = 3; g.strokeRect(rx + 6, ry + 6, rw - 12, rh - 12);
        g.fillStyle = '#20302a'; g.fillRect(rx + 30, ry + 18, 30, 24);
      }
      // wardrobe / shelf silhouettes
      const nFurn = 1 + (k % 3);
      for (let f = 0; f < nFurn; f++) {
        const fx = cx + ((k * 37 + f * 91) % 200), fw = 30 + ((k + f) * 17) % 50, fh = 45 + ((k * 3 + f * 11) % 50);
        g.fillStyle = ['#3a2a1e', '#2a2420', '#4a3a2a', '#262a2c'][(k + f) % 4];
        g.fillRect(fx, cy + ch - fh, fw, fh);
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(fx + fw / 2 - 1, cy + ch - fh + 4, 2, fh - 8);
      }
      // doorway
      if (k % 5 === 2) {
        g.fillStyle = '#141210';
        g.fillRect(cx + 190, cy + 30, 40, ch - 30);
      }
      // picture frames
      if (k % 2 === 0) {
        g.fillStyle = '#2b241c';
        g.fillRect(cx + 30 + (k * 7) % 60, cy + 30, 26, 20);
        g.fillStyle = '#5a6a6a';
        g.fillRect(cx + 33 + (k * 7) % 60, cy + 33, 20, 14);
      }
      // war damage: soot + holes
      if (k % 4 === 3) {
        const grd = g.createRadialGradient(cx + 128, cy + 40, 5, cx + 128, cy + 40, 110);
        grd.addColorStop(0, 'rgba(10,8,6,0.9)'); grd.addColorStop(1, 'rgba(10,8,6,0)');
        g.fillStyle = grd; g.fillRect(cx, cy, cell, ch);
      }
      drawNoise(g, rng, cx, cy, cell, ch, { alpha: 0.35, base: 6 });
      // darken top (ceiling shadow) and bottom (skirting)
      const gr = g.createLinearGradient(0, cy, 0, cy + ch);
      gr.addColorStop(0, 'rgba(0,0,0,0.45)'); gr.addColorStop(0.3, 'rgba(0,0,0,0)'); gr.addColorStop(0.9, 'rgba(0,0,0,0.1)'); gr.addColorStop(1, 'rgba(0,0,0,0.5)');
      g.fillStyle = gr; g.fillRect(cx, cy, cell, ch);
    }
    // curtains (bottom half: 4x2 cells of 256x256) — alpha overlays
    g.clearRect(0, 512, 1024, 512);
    for (let k = 0; k < 8; k++) {
      const cx = (k % 4) * 256, cy = 512 + Math.floor(k / 4) * 256;
      const type = k % 8;
      g.save();
      g.beginPath(); g.rect(cx, cy, 256, 256); g.clip();
      if (type === 0 || type === 4) {
        // lace sheer
        g.fillStyle = 'rgba(235,230,215,0.55)';
        g.fillRect(cx, cy, 256, 256);
        g.fillStyle = 'rgba(255,255,255,0.35)';
        for (let y = 0; y < 256; y += 8) for (let x = (y / 8) % 2 ? 4 : 0; x < 256; x += 8) g.fillRect(cx + x, cy + y, 3, 3);
        if (type === 4) g.clearRect(cx + 100, cy, 70, 256);
      } else if (type === 1 || type === 5) {
        // heavy drapes on both sides with folds
        const col = type === 1 ? [120, 60, 40] : [60, 80, 70];
        for (const side of [0, 1]) {
          const w = 70 + (k * 13) % 30;
          const x0 = side ? cx + 256 - w : cx;
          for (let x = 0; x < w; x++) {
            const s = 0.65 + 0.35 * Math.sin(x * 0.35 + side);
            g.fillStyle = `rgba(${col[0] * s | 0},${col[1] * s | 0},${col[2] * s | 0},0.97)`;
            g.fillRect(x0 + x, cy, 1, 256);
          }
        }
      } else if (type === 2) {
        // venetian blinds, some slats missing
        for (let y = 0; y < 200; y += 9) {
          if ((y * 7) % 5 === 0) continue;
          g.fillStyle = 'rgba(200,196,185,0.95)';
          g.fillRect(cx, cy + y, 256, 6);
          g.fillStyle = 'rgba(0,0,0,0.25)';
          g.fillRect(cx, cy + y + 5, 256, 1);
        }
      } else if (type === 3) {
        // newspaper / cardboard taped
        g.fillStyle = 'rgba(190,178,150,0.98)';
        g.fillRect(cx + 20, cy + 30, 150, 110);
        g.fillStyle = 'rgba(60,55,50,0.6)';
        for (let y = 40; y < 130; y += 7) g.fillRect(cx + 28, cy + y, 130 * (0.5 + ((y * 13) % 10) / 20), 3);
        g.fillStyle = 'rgba(160,120,70,0.98)';
        g.fillRect(cx + 120, cy + 120, 120, 120);
      } else if (type === 6) {
        // half-drawn plain curtain
        g.fillStyle = 'rgba(170,150,110,0.92)';
        g.fillRect(cx, cy, 130, 256);
        for (let x = 0; x < 130; x += 12) { g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(cx + x, cy, 4, 256); }
      }
      // type 7: nothing
      g.restore();
    }
  }, { srgb: true }));
  out.interior.generateMipmaps = true;

  // ------------------------------------------------------------------ broken glass (512x512, 2x2)
  out.glassBroken = mats.track(A.canvasTexture(512, 512, (g) => {
    g.clearRect(0, 0, 512, 512);
    for (let k = 0; k < 4; k++) {
      const cx = (k % 2) * 256, cy = Math.floor(k / 2) * 256;
      g.save();
      g.beginPath(); g.rect(cx, cy, 256, 256); g.clip();
      // shards anchored to the frame edges
      const shards = 7 + k * 2;
      for (let s = 0; s < shards; s++) {
        const edge = s % 4;
        const t = rng.next();
        let ax, ay;
        if (edge === 0) { ax = cx + t * 256; ay = cy; } else if (edge === 1) { ax = cx + 256; ay = cy + t * 256; } else if (edge === 2) { ax = cx + t * 256; ay = cy + 256; } else { ax = cx; ay = cy + t * 256; }
        const len = 30 + rng.next() * (k === 3 ? 60 : 110);
        const ang = Math.atan2(cy + 128 - ay, cx + 128 - ax) + (rng.next() - 0.5) * 0.9;
        const w = 20 + rng.next() * 50;
        g.fillStyle = `rgba(${180 + rng.next() * 30 | 0},${205 + rng.next() * 20 | 0},${210 + rng.next() * 20 | 0},0.55)`;
        g.beginPath();
        g.moveTo(ax - Math.sin(ang) * w, ay + Math.cos(ang) * w);
        g.lineTo(ax + Math.cos(ang) * len, ay + Math.sin(ang) * len);
        g.lineTo(ax + Math.sin(ang) * w, ay - Math.cos(ang) * w);
        g.closePath();
        g.fill();
        g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 1; g.stroke();
      }
      // crack lines on remaining glass for k==0
      g.restore();
    }
  }, { srgb: true }));

  // ------------------------------------------------------------------ decal atlas (2048, 8x8 cells of 256)
  out.decals = mats.track(A.canvasTexture(2048, 2048, (g) => drawDecals(g, rng), { srgb: true }));
  out.decalCell = (i) => [(i % 8) / 8, 1 - (Math.floor(i / 8) + 1) / 8, 1 / 8, 1 / 8];

  // ------------------------------------------------------------------ signs (1024x1024, 2 cols x 16 rows of 512x64)
  out.signs = mats.track(A.canvasTexture(1024, 1024, (g) => drawSigns(g, rng), { srgb: true }));
  out.signCell = (i) => [(i % 2) / 2, 1 - (Math.floor(i / 2) + 1) / 16, 1 / 2, 1 / 16];
  out.signCount = 32;

  // ------------------------------------------------------------------ foliage cards (1024x512, 4x2)
  out.foliage = mats.track(A.canvasTexture(1024, 512, (g) => drawFoliage(g, rng), { srgb: true }));
  out.foliageCell = (i) => [(i % 4) / 4, 1 - (Math.floor(i / 4) + 1) / 2, 1 / 4, 1 / 2];

  // ------------------------------------------------------------------ hesco (tiling 256 = 1.1 m)
  out.hesco = mats.track(A.canvasTexture(512, 512, (g) => {
    g.fillStyle = '#9d8d6e'; g.fillRect(0, 0, 512, 512);
    drawNoise(g, rng, 0, 0, 512, 512, { alpha: 0.5, base: 8 });
    // geotextile weave
    g.globalAlpha = 0.12; g.fillStyle = '#000';
    for (let y = 0; y < 512; y += 4) g.fillRect(0, y, 512, 1);
    g.globalAlpha = 1;
    // bulges: vertical darker bands between wire cells
    for (let x = 0; x < 512; x += 64) {
      const gr = g.createLinearGradient(x, 0, x + 64, 0);
      gr.addColorStop(0, 'rgba(0,0,0,0.35)'); gr.addColorStop(0.5, 'rgba(255,240,210,0.12)'); gr.addColorStop(1, 'rgba(0,0,0,0.35)');
      g.fillStyle = gr; g.fillRect(x, 0, 64, 512);
    }
    // weld mesh wires
    g.strokeStyle = '#5b5850'; g.lineWidth = 5;
    for (let x = 0; x <= 512; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 512); g.stroke(); }
    for (let y = 0; y <= 512; y += 64) { g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke(); }
    g.strokeStyle = 'rgba(140,90,50,0.6)'; g.lineWidth = 2;
    for (let x = 0; x <= 512; x += 64) { g.beginPath(); g.moveTo(x + 2, 0); g.lineTo(x + 2, 512); g.stroke(); }
    // dirt at the bottom
    const gb = g.createLinearGradient(0, 380, 0, 512);
    gb.addColorStop(0, 'rgba(60,45,30,0)'); gb.addColorStop(1, 'rgba(60,45,30,0.7)');
    g.fillStyle = gb; g.fillRect(0, 380, 512, 132);
  }, { srgb: true }));
  out.hesco.wrapS = out.hesco.wrapT = THREE.RepeatWrapping;

  // ------------------------------------------------------------------ chain-link fence (tiling 1 m, alpha)
  out.chainlink = mats.track(A.canvasTexture(256, 256, (g) => {
    g.clearRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(150,150,145,1)';
    g.lineWidth = 3;
    const s = 32;
    for (let k = -8; k < 16; k++) {
      g.beginPath(); g.moveTo(k * s, 0); g.lineTo(k * s + 256, 256); g.stroke();
      g.beginPath(); g.moveTo(k * s + 256, 0); g.lineTo(k * s, 256); g.stroke();
    }
    // rust spots
    g.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 60; i++) {
      g.fillStyle = 'rgba(110,60,30,0.6)';
      g.fillRect(rng.next() * 256, rng.next() * 256, 6 + rng.next() * 20, 4 + rng.next() * 10);
    }
    g.globalCompositeOperation = 'source-over';
  }, { srgb: true }));
  out.chainlink.wrapS = out.chainlink.wrapT = THREE.RepeatWrapping;

  // ------------------------------------------------------------------ tarp stripes (tiling)
  out.tarp = mats.track(A.canvasTexture(256, 256, (g) => {
    g.fillStyle = '#e8e2d4'; g.fillRect(0, 0, 256, 256);
    for (let x = 0; x < 256; x += 64) { g.fillStyle = '#b8b0a0'; g.fillRect(x, 0, 32, 256); }
    drawNoise(g, rng, 0, 0, 256, 256, { alpha: 0.45, base: 4, op: 'multiply' });
  }, { srgb: true }));
  out.tarp.wrapS = out.tarp.wrapT = THREE.RepeatWrapping;

  // ------------------------------------------------------------------ vehicle details atlas (1024x512)
  out.car = mats.track(A.canvasTexture(1024, 512, (g) => drawVehicleAtlas(g, rng, drawNoise), { srgb: true }));
  out.car.anisotropy = 4;
  // pixel rects -> [u0, v0, du, dv] (canvas flipY: top row = v 1)
  const VCELLS = {
    sedanFront: [0, 0, 512, 128], sedanRear: [512, 0, 512, 128], tailL: [520, 12, 156, 92], tailR: [868, 12, 156, 92],
    truckGrille: [0, 128, 256, 256], vanFront: [256, 128, 256, 256],
    plate: [512, 128, 256, 64], tailLamp: [768, 128, 128, 64], headLamp: [896, 128, 128, 128],
    busFront: [512, 192, 256, 64], busSign: [512, 256, 512, 64],
    burntFront: [0, 384, 512, 128], burntRear: [512, 384, 512, 128], grilleMesh: [768, 192, 256, 64],
  };
  out.carCell = (name) => {
    const [x, y, w, h] = VCELLS[name];
    return [x / 1024, 1 - (y + h) / 512, w / 1024, h / 512];
  };

  // ------------------------------------------------------------------ laundry garments (512x256, 4x2 cells, alpha silhouettes)
  out.laundry = mats.track(A.canvasTexture(512, 256, (g) => drawLaundry(g, rng), { srgb: true }));
  out.laundryCell = (i) => [(i % 4) / 4, 1 - (Math.floor(i / 4) + 1) / 2, 1 / 4, 1 / 2];

  // ------------------------------------------------------------------ bark (tiling, 1 m)
  out.bark = mats.track(A.canvasTexture(256, 512, (g) => {
    g.fillStyle = '#4a4037'; g.fillRect(0, 0, 256, 512);
    for (let i = 0; i < 90; i++) {
      const x = rng.next() * 256, w = 2 + rng.next() * 7;
      const sh = 0.5 + rng.next() * 0.5;
      g.fillStyle = 'rgba(' + (20 * sh | 0) + ',' + (17 * sh | 0) + ',' + (14 * sh | 0) + ',0.8)';
      g.beginPath(); g.moveTo(x, 0);
      let cx = x;
      for (let y = 0; y <= 512; y += 32) { cx += (rng.next() - 0.5) * 8; g.lineTo(cx, y); }
      g.lineTo(cx + w, 512); g.lineTo(x + w, 0); g.fill();
    }
    drawNoise(g, rng, 0, 0, 256, 512, { alpha: 0.4, base: 8 });
  }, { srgb: true }));
  out.bark.wrapS = out.bark.wrapT = THREE.RepeatWrapping;

  return out;
}

// ------------------------------------------------------------------ decals
// cells: 0-7 leaks/streaks (vertical, top anchored), 8-11 grime base bands, 12-15 cracks, 16-19 stains/oil,
// 20-23 scorch, 24-27 paper litter, 28-31 puddles(alpha mask), 32-35 spalled plaster (brick reveal), 36-39 dirt patches,
// 40-43 graffiti, 44-47 posters, 48 bullet holes cluster, 49-51 road markings (worn), 52-55 manhole/drain, 56-59 tyre marks
function drawDecals(g, rng) {
  g.clearRect(0, 0, 2048, 2048);
  const C = 256;
  const cell = (i) => [(i % 8) * C, Math.floor(i / 8) * C];
  const soft = (x, y, r, col, a) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${col},${a})`); gr.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  };
  // leaks / water streaks (dark, top anchored, fading down)
  for (let k = 0; k < 8; k++) {
    const [x0, y0] = cell(k);
    const n = 6 + k * 2;
    for (let s = 0; s < n; s++) {
      const x = x0 + 20 + rng.next() * (C - 40);
      const w = 3 + rng.next() * (k < 4 ? 18 : 8);
      const len = C * (0.35 + rng.next() * 0.65);
      const gr = g.createLinearGradient(0, y0, 0, y0 + len);
      const a = 0.25 + rng.next() * 0.35;
      gr.addColorStop(0, `rgba(30,26,20,${a})`); gr.addColorStop(1, 'rgba(30,26,20,0)');
      g.fillStyle = gr;
      g.beginPath();
      g.moveTo(x - w, y0); g.lineTo(x + w, y0);
      g.lineTo(x + w * 0.4 + (rng.next() - 0.5) * 6, y0 + len); g.lineTo(x - w * 0.4, y0 + len);
      g.fill();
    }
    // rust tint for some
    if (k % 3 === 2) { g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(120,60,20,0.35)'; g.fillRect(x0, y0, C, C); g.globalCompositeOperation = 'source-over'; }
  }
  // grime base bands (bottom anchored, dark, noisy top edge)
  for (let k = 8; k < 12; k++) {
    const [x0, y0] = cell(k);
    for (let x = 0; x < C; x += 2) {
      const h = C * (0.3 + 0.25 * Math.sin(x * 0.05 + k) + 0.2 * rng.next());
      const gr = g.createLinearGradient(0, y0 + C - h, 0, y0 + C);
      gr.addColorStop(0, 'rgba(35,30,24,0)'); gr.addColorStop(1, 'rgba(35,30,24,0.75)');
      g.fillStyle = gr; g.fillRect(x0 + x, y0 + C - h, 2, h);
    }
    // splash dots
    for (let s = 0; s < 120; s++) soft(x0 + rng.next() * C, y0 + C - rng.next() * C * 0.5, 1 + rng.next() * 4, '40,34,26', 0.5);
  }
  // cracks (thin dark branching lines)
  for (let k = 12; k < 16; k++) {
    const [x0, y0] = cell(k);
    g.strokeStyle = 'rgba(20,18,15,0.85)';
    const branch = (x, y, ang, len, w, depth) => {
      if (depth > 5 || len < 6) return;
      g.lineWidth = w;
      g.beginPath(); g.moveTo(x, y);
      let cx = x, cy = y;
      const steps = 6;
      for (let i = 0; i < steps; i++) {
        ang += (rng.next() - 0.5) * 0.8;
        cx += Math.cos(ang) * len / steps; cy += Math.sin(ang) * len / steps;
        g.lineTo(cx, cy);
      }
      g.stroke();
      if (rng.next() < 0.7) branch(cx, cy, ang + (rng.next() - 0.5) * 1.6, len * 0.6, w * 0.7, depth + 1);
      if (rng.next() < 0.5) branch(cx, cy, ang - (rng.next()) * 1.2, len * 0.5, w * 0.6, depth + 1);
    };
    for (let s = 0; s < 3; s++) branch(x0 + C / 2, y0 + C / 2, rng.next() * Math.PI * 2, 80 + rng.next() * 40, 2.5, 0);
  }
  // stains / oil
  for (let k = 16; k < 20; k++) {
    const [x0, y0] = cell(k);
    for (let s = 0; s < 14; s++) soft(x0 + C / 2 + (rng.next() - 0.5) * 120, y0 + C / 2 + (rng.next() - 0.5) * 120, 20 + rng.next() * 60, k < 18 ? '15,13,12' : '45,38,28', 0.25);
  }
  // scorch
  for (let k = 20; k < 24; k++) {
    const [x0, y0] = cell(k);
    soft(x0 + C / 2, y0 + C / 2, C * 0.48, '8,7,6', 0.85);
    for (let s = 0; s < 30; s++) {
      const a = rng.next() * Math.PI * 2, r = 30 + rng.next() * 90;
      soft(x0 + C / 2 + Math.cos(a) * r, y0 + C / 2 + Math.sin(a) * r, 8 + rng.next() * 25, '10,9,8', 0.6);
    }
  }
  // litter: newspaper sheets, cardboard, crumpled paper, cans, butts, leaves (desaturated, shaded)
  for (let k = 24; k < 28; k++) {
    const [x0, y0] = cell(k);
    const items = 7 + (k % 2) * 3;
    for (let s = 0; s < items; s++) {
      g.save();
      g.translate(x0 + 28 + rng.next() * (C - 56), y0 + 28 + rng.next() * (C - 56));
      g.rotate(rng.next() * Math.PI * 2);
      const t = (s + k) % 6;
      if (t === 0 || t === 3) {
        const w = 34 + rng.next() * 30, h = 26 + rng.next() * 20;
        const sh = 150 + rng.next() * 40 | 0;
        const gr = g.createLinearGradient(-w / 2, 0, w / 2, 0);
        gr.addColorStop(0, `rgb(${sh},${sh - 4},${sh - 14})`); gr.addColorStop(0.5, `rgb(${sh + 18},${sh + 14},${sh + 2})`); gr.addColorStop(1, `rgb(${sh - 20},${sh - 22},${sh - 30})`);
        g.fillStyle = gr;
        g.beginPath(); g.moveTo(-w / 2, -h / 2); g.lineTo(w / 2, -h / 2 + 2); g.lineTo(w / 2 - 2, h / 2); g.lineTo(-w / 2 + 3, h / 2 - 1); g.closePath(); g.fill();
        g.fillStyle = 'rgba(40,38,35,0.35)';
        for (let c2 = 0; c2 < 3; c2++) for (let l = -h / 2 + 4; l < h / 2 - 3; l += 3) g.fillRect(-w / 2 + 3 + c2 * (w / 3), l, w / 3 - 4, 1);
        g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(-1, -h / 2, 2, h);
        g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(-w / 2 + 1, h / 2 - 1, w - 3, 2);
      } else if (t === 1) {
        const w = 30 + rng.next() * 26, h = 22 + rng.next() * 18;
        g.fillStyle = `rgb(${118 + rng.next() * 20 | 0},${92 + rng.next() * 14 | 0},${62 + rng.next() * 10 | 0})`;
        g.beginPath(); g.moveTo(-w / 2, -h / 2);
        for (let e = 0; e <= 6; e++) g.lineTo(-w / 2 + (w * e) / 6, -h / 2 + (rng.next() - 0.5) * 4);
        g.lineTo(w / 2, h / 2); g.lineTo(-w / 2, h / 2); g.closePath(); g.fill();
        g.fillStyle = 'rgba(60,40,20,0.25)';
        for (let l = -w / 2 + 2; l < w / 2; l += 3) g.fillRect(l, -h / 2 + 2, 1, h - 3);
        g.fillStyle = 'rgba(30,20,10,0.3)'; g.fillRect(-w / 2, h / 2 - 2, w, 2);
      } else if (t === 2) {
        const r = 5 + rng.next() * 6;
        const gr = g.createRadialGradient(-r * 0.3, -r * 0.3, 1, 0, 0, r);
        const c0 = rng.next() < 0.5 ? [196, 190, 176] : [120, 128, 132];
        gr.addColorStop(0, `rgb(${c0[0]},${c0[1]},${c0[2]})`); gr.addColorStop(1, `rgb(${c0[0] * 0.55 | 0},${c0[1] * 0.55 | 0},${c0[2] * 0.55 | 0})`);
        g.fillStyle = gr; g.beginPath();
        for (let e = 0; e < 9; e++) { const a = (e / 9) * Math.PI * 2; const rr = r * (0.75 + rng.next() * 0.35); if (e) g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); else g.moveTo(rr, 0); }
        g.closePath(); g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1; g.beginPath(); g.moveTo(-r * 0.5, 0); g.lineTo(r * 0.3, -r * 0.4); g.stroke();
      } else if (t === 4) {
        const w = 12 + rng.next() * 4, h = 6;
        const hue = [[120, 40, 34], [150, 150, 146], [60, 80, 60]][Math.floor(rng.next() * 3)];
        const gr = g.createLinearGradient(0, -h / 2, 0, h / 2);
        gr.addColorStop(0, `rgb(${hue[0] + 50},${hue[1] + 50},${hue[2] + 50})`); gr.addColorStop(0.5, `rgb(${hue[0]},${hue[1]},${hue[2]})`); gr.addColorStop(1, `rgb(${hue[0] * 0.5 | 0},${hue[1] * 0.5 | 0},${hue[2] * 0.5 | 0})`);
        g.fillStyle = gr; g.fillRect(-w / 2, -h / 2, w, h);
        g.fillStyle = 'rgba(200,200,200,0.8)'; g.fillRect(w / 2 - 2, -h / 2, 2, h);
      } else {
        for (let q = 0; q < 4; q++) {
          g.save(); g.translate((rng.next() - 0.5) * 30, (rng.next() - 0.5) * 30); g.rotate(rng.next() * 6);
          if (q < 3) {
            g.fillStyle = `rgb(${96 + rng.next() * 50 | 0},${70 + rng.next() * 30 | 0},${36 + rng.next() * 14 | 0})`;
            g.beginPath(); g.ellipse(0, 0, 5 + rng.next() * 3, 2.5, 0, 0, Math.PI * 2); g.fill();
            g.strokeStyle = 'rgba(50,30,15,0.5)'; g.lineWidth = 0.7; g.beginPath(); g.moveTo(-6, 0); g.lineTo(6, 0); g.stroke();
          } else {
            g.fillStyle = '#d8d2c4'; g.fillRect(-3, -0.9, 5, 1.8); g.fillStyle = '#b08a52'; g.fillRect(2, -0.9, 2, 1.8);
          }
          g.restore();
        }
      }
      g.restore();
    }
  }
  // puddles (alpha masks; color irrelevant: white)
  for (let k = 28; k < 32; k++) {
    const [x0, y0] = cell(k);
    // soft core + many small satellite blobs so the rim is ragged (seeping into cracks), not a clean cartoon outline
    for (let s = 0; s < 8; s++) soft(x0 + C / 2 + (rng.next() - 0.5) * 90, y0 + C / 2 + (rng.next() - 0.5) * 56, 30 + rng.next() * 38, '255,255,255', 0.85);
    for (let s = 0; s < 46; s++) {
      const a = rng.next() * Math.PI * 2, d = 40 + rng.next() * 62;
      soft(x0 + C / 2 + Math.cos(a) * d, y0 + C / 2 + Math.sin(a) * d * 0.62, 5 + rng.next() * 16, '255,255,255', 0.35 + rng.next() * 0.45);
    }
  }
  // spalled plaster: 32-33 brick reveal, 34-35 grey render / concrete reveal; depth shadow on the upper edge
  for (let k = 32; k < 36; k++) {
    const [x0, y0] = cell(k);
    const brick = k < 34;
    const cx = x0 + C / 2, cy = y0 + C / 2;
    const pts = [];
    const n = 44;
    const ph = rng.next() * 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = C * (0.3 + 0.07 * Math.sin(a * 3 + ph) + 0.05 * Math.sin(a * 7 + ph * 2) + rng.next() * 0.05);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.78]);
    }
    const path = () => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); };
    path(); g.strokeStyle = 'rgba(235,228,212,0.55)'; g.lineWidth = 7; g.stroke();
    g.save(); path(); g.clip();
    if (brick) {
      g.fillStyle = '#7d756a'; g.fillRect(x0, y0, C, C);
      const bh = 15, bw = 34;
      for (let row = 0; row * bh < C; row++) {
        for (let col = -1; col * bw < C; col++) {
          const bx = x0 + col * bw + (row % 2) * (bw / 2), by = y0 + row * bh;
          const v = 0.78 + rng.next() * 0.3;
          const base = rng.next() < 0.12 ? [120, 90, 72] : [128, 66, 48];
          const gr = g.createLinearGradient(0, by, 0, by + bh);
          gr.addColorStop(0, `rgb(${base[0] * v * 1.08 | 0},${base[1] * v * 1.08 | 0},${base[2] * v * 1.08 | 0})`);
          gr.addColorStop(1, `rgb(${base[0] * v * 0.8 | 0},${base[1] * v * 0.8 | 0},${base[2] * v * 0.8 | 0})`);
          g.fillStyle = gr; g.fillRect(bx + 1.5, by + 1.5, bw - 3, bh - 3);
        }
      }
      for (let i = 0; i < 6; i++) { g.fillStyle = `rgba(150,142,128,${0.25 + rng.next() * 0.35})`; g.beginPath(); g.ellipse(x0 + rng.next() * C, y0 + rng.next() * C, 8 + rng.next() * 18, 5 + rng.next() * 10, rng.next() * 3, 0, Math.PI * 2); g.fill(); }
    } else {
      g.fillStyle = '#8b8780'; g.fillRect(x0, y0, C, C);
      drawNoise(g, rng, x0, y0, C, C, { alpha: 0.5, base: 10 });
      g.fillStyle = 'rgba(170,164,152,0.8)';
      g.beginPath(); g.ellipse(cx + 20, cy + 16, C * 0.2, C * 0.12, 0.3, 0, Math.PI * 2); g.fill();
      for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(40,38,34,${0.2 + rng.next() * 0.3})`; g.fillRect(x0 + rng.next() * C, y0 + rng.next() * C, 1 + rng.next() * 3, 1 + rng.next() * 3); }
    }
    g.translate(4, 6); path(); g.translate(-4, -6);
    g.strokeStyle = 'rgba(12,10,8,0.55)'; g.lineWidth = 9; g.stroke();
    drawNoise(g, rng, x0, y0, C, C, { alpha: 0.35, base: 8, op: 'multiply' });
    g.restore();
  }
  // dirt patches
  for (let k = 36; k < 40; k++) {
    const [x0, y0] = cell(k);
    for (let s = 0; s < 40; s++) soft(x0 + C / 2 + (rng.next() - 0.5) * 150, y0 + C / 2 + (rng.next() - 0.5) * 150, 10 + rng.next() * 40, '70,56,40', 0.3);
  }
  // graffiti (original tags; simple letters + arrows)
  const tags = ['ВАРДАНЕК', 'НЕТ ВОЙНЕ', 'IV', '→ 7', 'ЛЮДИ', 'ДЕТИ', 'ОПАСНО', 'МИНЫ'];
  for (let k = 40; k < 44; k++) {
    const [x0, y0] = cell(k);
    g.save();
    g.translate(x0 + C / 2, y0 + C / 2);
    g.rotate((rng.next() - 0.5) * 0.2);
    g.font = `bold ${40 + (k % 2) * 16}px sans-serif`;
    g.textAlign = 'center';
    g.fillStyle = ['rgba(180,30,25,0.85)', 'rgba(20,20,20,0.85)', 'rgba(230,230,220,0.85)', 'rgba(30,60,140,0.8)'][k % 4];
    g.fillText(tags[(k - 40) * 2], 0, -10);
    g.font = 'bold 30px sans-serif';
    g.fillText(tags[(k - 40) * 2 + 1], 0, 40);
    g.restore();
  }
  // posters
  for (let k = 44; k < 48; k++) {
    const [x0, y0] = cell(k);
    const px = x0 + 40, py = y0 + 20, pw = 170, ph = 216;
    g.fillStyle = ['#d8cfb5', '#c9b58d', '#b5c3c2', '#d9c6a0'][k % 4];
    g.fillRect(px, py, pw, ph);
    g.fillStyle = ['#8a1f1a', '#1f2f4a', '#2a2a2a', '#5a3a1a'][k % 4];
    g.fillRect(px + 10, py + 10, pw - 20, 60);
    g.fillStyle = '#eee'; g.font = 'bold 26px sans-serif'; g.textAlign = 'center';
    g.fillText(['ВНИМАНИЕ', 'ВЫБОРЫ', 'ПРИКАЗ', 'ИЩЕМ'][k % 4], px + pw / 2, py + 50);
    g.fillStyle = 'rgba(30,30,30,0.7)';
    for (let l = 0; l < 10; l++) g.fillRect(px + 15, py + 90 + l * 11, (pw - 30) * (0.6 + ((l * 7) % 5) / 12), 4);
    // torn corner
    g.clearRect(px + pw - 40, py + ph - 30, 40, 30);
    drawNoise(g, rng, px, py, pw, ph, { alpha: 0.35, op: 'multiply', base: 5 });
  }
  // bullet hole clusters
  {
    const [x0, y0] = cell(48);
    for (let s = 0; s < 22; s++) {
      const x = x0 + 30 + rng.next() * 196, y = y0 + 30 + rng.next() * 196, r = 3 + rng.next() * 5;
      soft(x, y, r * 3.5, '190,180,165', 0.5);
      soft(x, y, r * 1.2, '10,10,10', 0.95);
    }
  }
  // worn road marking stripes (white paint)
  for (let k = 49; k < 52; k++) {
    const [x0, y0] = cell(k);
    g.fillStyle = 'rgba(225,222,210,0.9)';
    g.fillRect(x0 + 16, y0, C - 32, C);
    g.globalCompositeOperation = 'destination-out';
    for (let s = 0; s < 260; s++) soft(x0 + rng.next() * C, y0 + rng.next() * C, 3 + rng.next() * 14, '0,0,0', 0.8);
    g.globalCompositeOperation = 'source-over';
  }
  // drains / manholes
  for (let k = 52; k < 56; k++) {
    const [x0, y0] = cell(k);
    soft(x0 + C / 2, y0 + C / 2, 125, '20,18,16', 0.5);
    g.fillStyle = '#2a2724'; g.beginPath(); g.arc(x0 + C / 2, y0 + C / 2, 95, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#4a4540'; g.lineWidth = 6;
    for (let r = 20; r < 95; r += 18) { g.beginPath(); g.arc(x0 + C / 2, y0 + C / 2, r, 0, Math.PI * 2); g.stroke(); }
    for (let a = 0; a < 8; a++) { g.beginPath(); g.moveTo(x0 + C / 2, y0 + C / 2); g.lineTo(x0 + C / 2 + Math.cos(a * 0.785) * 95, y0 + C / 2 + Math.sin(a * 0.785) * 95); g.stroke(); }
  }
  // tyre marks
  for (let k = 56; k < 60; k++) {
    const [x0, y0] = cell(k);
    g.fillStyle = 'rgba(12,12,12,0.45)';
    for (const off of [60, 170]) {
      for (let y = 0; y < C; y += 3) g.fillRect(x0 + off + Math.sin(y * 0.02 + k) * 10, y0 + y, 26, 2);
    }
  }
}

function drawSigns(g, rng) {
  const W = 512, H = 64;
  const bgs = ['#1f3a5a', '#6a1f1a', '#e0d8c0', '#2a4a2a', '#c8a030', '#304050', '#d0d0c8', '#5a2a4a'];
  const fgs = ['#e8e0c8', '#f0e0c0', '#8a1f1a', '#e8e8d0', '#1a1a1a', '#e0c070', '#1f3a5a', '#f0e8d0'];
  for (let k = 0; k < 32; k++) {
    const x0 = (k % 2) * W, y0 = Math.floor(k / 2) * H;
    const c = k % 8;
    g.fillStyle = bgs[c];
    g.fillRect(x0, y0, W, H);
    g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 4; g.strokeRect(x0 + 2, y0 + 2, W - 4, H - 4);
    g.fillStyle = fgs[c];
    const word = FAKE_WORDS[k % FAKE_WORDS.length];
    g.font = `bold ${word.length > 10 ? 34 : 42}px "Arial Narrow", Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(word, x0 + W / 2, y0 + H / 2 + 2);
    // missing letters / fading / rust streaks
    drawNoise(g, rng, x0, y0, W, H, { alpha: 0.55, op: 'multiply', base: 16 });
    g.fillStyle = 'rgba(90,60,30,0.35)';
    for (let s = 0; s < 5; s++) g.fillRect(x0 + rng.next() * W, y0 + H * 0.5, 4 + rng.next() * 6, H * 0.5);
    if (k % 5 === 3) { g.fillStyle = bgs[c]; g.fillRect(x0 + W * 0.3 + rng.next() * W * 0.3, y0 + 6, 26, H - 12); }
  }
}

function drawFoliage(g, rng) {
  g.clearRect(0, 0, 1024, 512);
  const C = 256;
  // tapered, curved blade from (bx, by) with height h, lean, base width w, colour gradient base->tip
  const blade = (bx, by, h, lean, w, base, tip, alpha = 1) => {
    const ex = bx + lean, ey = by - h;
    const cx = bx + lean * 0.35, cy = by - h * 0.55;
    const gr = g.createLinearGradient(0, by, 0, ey);
    gr.addColorStop(0, `rgba(${base[0]},${base[1]},${base[2]},${alpha})`);
    gr.addColorStop(1, `rgba(${tip[0]},${tip[1]},${tip[2]},${alpha})`);
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(bx - w / 2, by);
    g.quadraticCurveTo(cx - w * 0.25, cy, ex, ey);
    g.quadraticCurveTo(cx + w * 0.25, cy, bx + w / 2, by);
    g.closePath();
    g.fill();
  };
  // 0-3: grass tufts (0,1 dry straw, 2 mixed, 3 green-ish), fan shaped: tall centre, short sides
  for (let k = 0; k < 4; k++) {
    const x0 = (k % 4) * C, y0 = 0;
    g.save(); g.beginPath(); g.rect(x0, y0, C, C); g.clip();
    const n = 70 + k * 12;
    for (let s = 0; s < n; s++) {
      const t = (rng.next() - 0.5) * 2; // -1..1 across
      const bx = x0 + C / 2 + t * C * 0.16 + (rng.next() - 0.5) * 10;
      const hmax = C * (0.95 - Math.abs(t) * 0.45);
      const h = hmax * (0.45 + rng.next() * 0.55);
      const lean = t * C * (0.18 + rng.next() * 0.2) + (rng.next() - 0.5) * 30;
      const dry = k < 2 ? 0.55 + rng.next() * 0.45 : k === 2 ? rng.next() : rng.next() * 0.35;
      const base = [58 + dry * 30 | 0, 56 + dry * 20 | 0, 34 + dry * 8 | 0];
      const tip = [
        (92 + dry * 95) * (0.85 + rng.next() * 0.25) | 0,
        (100 + dry * 62) * (0.85 + rng.next() * 0.25) | 0,
        (52 + dry * 40) * (0.85 + rng.next() * 0.2) | 0,
      ];
      blade(bx, y0 + C, h, lean, 2.2 + rng.next() * 3.2, base, tip);
    }
    // a few seed heads on the dry ones
    if (k !== 3) {
      for (let s = 0; s < 7; s++) {
        const t = (rng.next() - 0.5) * 1.4;
        const bx = x0 + C / 2 + t * C * 0.2, h = C * (0.75 + rng.next() * 0.2);
        const ex = bx + t * C * 0.25;
        g.strokeStyle = 'rgba(150,132,92,1)'; g.lineWidth = 1.3;
        g.beginPath(); g.moveTo(bx, y0 + C); g.quadraticCurveTo(bx + t * 20, y0 + C - h * 0.6, ex, y0 + C - h); g.stroke();
        g.fillStyle = 'rgba(176,156,110,1)';
        g.beginPath(); g.ellipse(ex, y0 + C - h + 8, 3, 11, t * 0.4, 0, Math.PI * 2); g.fill();
      }
    }
    g.restore();
  }
  // 4: broad-leaf weeds (burdock/dock) — rosette of veined leaves
  {
    const x0 = 0, y0 = C;
    g.save(); g.beginPath(); g.rect(x0, y0, C, C); g.clip();
    for (let s = 0; s < 16; s++) {
      const ang = -Math.PI / 2 + (rng.next() - 0.5) * 2.4;
      const len = 70 + rng.next() * 100;
      const bx = x0 + C / 2 + (rng.next() - 0.5) * 30, by = y0 + C;
      const ex = bx + Math.cos(ang) * len, ey = by + Math.sin(ang) * len;
      const mx = (bx + ex) / 2, my = (by + ey) / 2;
      const nx = -(ey - by) / len, ny = (ex - bx) / len;
      const wv = 14 + rng.next() * 16;
      const sh = 0.7 + rng.next() * 0.45;
      const gr = g.createLinearGradient(bx, by, ex, ey);
      gr.addColorStop(0, `rgb(${46 * sh | 0},${58 * sh | 0},${30 * sh | 0})`);
      gr.addColorStop(1, `rgb(${96 * sh | 0},${110 * sh | 0},${52 * sh | 0})`);
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(bx, by);
      g.quadraticCurveTo(mx + nx * wv, my + ny * wv, ex, ey);
      g.quadraticCurveTo(mx - nx * wv, my - ny * wv, bx, by);
      g.fill();
      g.strokeStyle = 'rgba(160,170,120,0.45)'; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(bx, by); g.lineTo(ex, ey); g.stroke();
      // dry brown edges on some
      if (rng.next() < 0.4) { g.strokeStyle = 'rgba(110,80,40,0.6)'; g.lineWidth = 2; g.beginPath(); g.moveTo(mx + nx * wv * 0.6, my + ny * wv * 0.6); g.quadraticCurveTo(mx + nx * wv, my + ny * wv, ex, ey); g.stroke(); }
    }
    g.restore();
  }
  // 5: dead branches (twiggy, for dead trees)
  {
    const x0 = C, y0 = C;
    g.save(); g.beginPath(); g.rect(x0, y0, C, C); g.clip();
    const br = (x, y, a, l, w, d) => {
      if (d > 7 || l < 4) return;
      const ex = x + Math.cos(a) * l, ey = y + Math.sin(a) * l;
      g.strokeStyle = `rgb(${62 + d * 6},${52 + d * 5},${42 + d * 4})`;
      g.lineWidth = w; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo((x + ex) / 2 + (rng.next() - 0.5) * l * 0.3, (y + ey) / 2, ex, ey); g.stroke();
      br(ex, ey, a - 0.25 - rng.next() * 0.45, l * (0.66 + rng.next() * 0.12), w * 0.68, d + 1);
      br(ex, ey, a + 0.25 + rng.next() * 0.45, l * (0.62 + rng.next() * 0.12), w * 0.68, d + 1);
      if (rng.next() < 0.3) br(ex, ey, a + (rng.next() - 0.5) * 0.4, l * 0.5, w * 0.6, d + 2);
    };
    br(x0 + C / 2, y0 + C, -Math.PI / 2, 64, 6, 0);
    g.restore();
  }
  // 6: leaf cluster (tree canopy card): irregular clumps, shading top-light / bottom-dark, gaps
  {
    const x0 = 2 * C, y0 = C;
    g.save(); g.beginPath(); g.rect(x0, y0, C, C); g.clip();
    const clumps = 9;
    for (let c2 = 0; c2 < clumps; c2++) {
      const a = rng.next() * Math.PI * 2, rr = Math.sqrt(rng.next()) * C * 0.3;
      const cx = x0 + C / 2 + Math.cos(a) * rr, cy = y0 + C / 2 + Math.sin(a) * rr * 0.8;
      const cr = C * (0.1 + rng.next() * 0.08);
      for (let s = 0; s < 70; s++) {
        const la = rng.next() * Math.PI * 2, lr = Math.sqrt(rng.next()) * cr;
        const x = cx + Math.cos(la) * lr, y = cy + Math.sin(la) * lr;
        const light = 0.55 + 0.45 * (1 - (y - (cy - cr)) / (2 * cr)) + (rng.next() - 0.5) * 0.25;
        const hue = rng.next();
        const col = hue < 0.15 ? [128, 118, 58] : hue < 0.25 ? [98, 96, 50] : [72, 92, 44];
        g.fillStyle = `rgb(${col[0] * light | 0},${col[1] * light | 0},${col[2] * light | 0})`;
        g.save(); g.translate(x, y); g.rotate(rng.next() * Math.PI);
        g.beginPath(); g.ellipse(0, 0, 4 + rng.next() * 4, 2 + rng.next() * 1.8, 0, 0, Math.PI * 2); g.fill();
        g.restore();
      }
    }
    // twigs
    g.strokeStyle = 'rgba(60,48,36,1)'; g.lineWidth = 2;
    for (let s = 0; s < 5; s++) { const a = rng.next() * 6.28; g.beginPath(); g.moveTo(x0 + C / 2, y0 + C / 2 + 20); g.lineTo(x0 + C / 2 + Math.cos(a) * 70, y0 + C / 2 + Math.sin(a) * 55); g.stroke(); }
    g.restore();
  }
  // 7: low ivy / creeper patch
  {
    const x0 = 3 * C, y0 = C;
    g.save(); g.beginPath(); g.rect(x0, y0, C, C); g.clip();
    for (let s = 0; s < 420; s++) {
      const x = x0 + rng.next() * C, y = y0 + C - Math.pow(rng.next(), 0.6) * C;
      const sh = 0.6 + rng.next() * 0.5;
      g.fillStyle = `rgb(${62 * sh | 0},${82 * sh | 0},${40 * sh | 0})`;
      g.beginPath(); g.ellipse(x, y, 3 + rng.next() * 4, 2 + rng.next() * 3, rng.next() * 3, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  }
}

// ------------------------------------------------------------------ laundry atlas
function drawLaundry(g, rng) {
  g.clearRect(0, 0, 512, 256);
  const C = 128;
  const cloth = (x, y, w, h, base, pattern) => {
    g.fillStyle = base; g.fillRect(x, y, w, h);
    if (pattern === 'stripe') { g.fillStyle = 'rgba(160,50,40,0.75)'; for (let k = 0; k < h; k += 14) g.fillRect(x, y + k, w, 5); }
    if (pattern === 'check') { g.fillStyle = 'rgba(30,20,20,0.35)'; for (let k = 0; k < w; k += 12) g.fillRect(x + k, y, 4, h); for (let k = 0; k < h; k += 12) g.fillRect(x, y + k, w, 4); }
    if (pattern === 'floral') { for (let k = 0; k < 40; k++) { g.fillStyle = 'rgba(170,70,90,0.6)'; g.beginPath(); g.arc(x + rng.next() * w, y + rng.next() * h, 2 + rng.next() * 2, 0, 6.3); g.fill(); } }
    // weave + creases
    g.fillStyle = 'rgba(0,0,0,0.06)'; for (let k = 0; k < h; k += 2) g.fillRect(x, y + k, w, 1);
    for (let k = 0; k < 6; k++) { const cx = x + rng.next() * w; const gr = g.createLinearGradient(cx - 6, 0, cx + 6, 0); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.5, 'rgba(0,0,0,0.18)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(cx - 6, y, 12, h); }
    const gb = g.createLinearGradient(0, y, 0, y + h); gb.addColorStop(0, 'rgba(0,0,0,0.15)'); gb.addColorStop(0.2, 'rgba(0,0,0,0)'); gb.addColorStop(1, 'rgba(40,30,20,0.12)');
    g.fillStyle = gb; g.fillRect(x, y, w, h);
  };
  const clipShape = (cell, draw) => {
    const x0 = (cell % 4) * C, y0 = Math.floor(cell / 4) * C;
    g.save(); g.translate(x0, y0); g.beginPath(); draw(); g.clip();
    return () => g.restore();
  };
  const shirt = () => { g.moveTo(34, 8); g.lineTo(52, 4); g.quadraticCurveTo(64, 14, 76, 4); g.lineTo(94, 8); g.lineTo(122, 34); g.lineTo(108, 48); g.lineTo(96, 38); g.lineTo(96, 124); g.lineTo(32, 124); g.lineTo(32, 38); g.lineTo(20, 48); g.lineTo(6, 34); g.closePath(); };
  const trousers = () => { g.moveTo(26, 4); g.lineTo(102, 4); g.lineTo(108, 124); g.lineTo(74, 124); g.lineTo(64, 40); g.lineTo(54, 124); g.lineTo(20, 124); g.closePath(); };
  const dress = () => { g.moveTo(44, 4); g.lineTo(84, 4); g.lineTo(90, 40); g.lineTo(118, 124); g.lineTo(10, 124); g.lineTo(38, 40); g.closePath(); };
  const towel = () => { g.rect(6, 4, 116, 120); };
  const specs = [
    [towel, '#c9c4b6', null], [shirt, '#56708e', null], [towel, '#d6d0c0', 'stripe'], [trousers, '#343638', null],
    [shirt, '#9a4a3e', 'check'], [dress, '#b0a080', 'floral'], [towel, '#5e7050', null], [shirt, '#8a8a86', null],
  ];
  specs.forEach(([shape, col, pat], i) => {
    const done = clipShape(i, shape);
    cloth(0, 0, C, C, col, pat);
    done();
    // clothes pegs at the top
    const x0 = (i % 4) * C, y0 = Math.floor(i / 4) * C;
    g.fillStyle = '#c8b890'; g.fillRect(x0 + 30, y0 + 2, 5, 12); g.fillRect(x0 + 92, y0 + 2, 5, 12);
  });
}

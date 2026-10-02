import * as THREE from 'three';

/**
 * Distant skyline: procedural out-of-bounds town (Soviet-era slabs, towers, chimneys, cranes, domes, a
 * water tower), a ground apron under it and a Caucasus-style mountain ridge, all merged into 2 draw calls.
 * Everything is lit by the sun/IBL and hazed by the shared atmosphere (aerial perspective does the
 * "haze cards" layering for free, with correct parallax). Layout uses a fixed private seed so it never
 * changes between runs/shots.
 */
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class GeoBuilder {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.col = []; }
  quad(a, b, c, d, n, uvs, color) {
    // a b c d counter-clockwise seen from the normal side
    const P = [a, b, c, a, c, d];
    const U = [uvs[0], uvs[1], uvs[2], uvs[0], uvs[2], uvs[3]];
    for (let i = 0; i < 6; i++) {
      this.pos.push(P[i].x, P[i].y, P[i].z);
      this.nor.push(n.x, n.y, n.z);
      this.uv.push(U[i][0], U[i][1]);
      this.col.push(color.r, color.g, color.b);
    }
  }
  /** oriented box: centre (x,z), base y0, size w (local x) d (local z) h, yaw; facade UVs in metres / tile */
  box(x, y0, z, w, d, h, yaw, color, tile = 36, roofColor = null, uOff = 0, vOff = 0) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const P = (lx, ly, lz) => new THREE.Vector3(x + lx * c + lz * s, y0 + ly, z - lx * s + lz * c);
    const N = (nx, nz) => new THREE.Vector3(nx * c + nz * s, 0, -nx * s + nz * c);
    const hw = w / 2, hd = d / 2;
    const v0 = vOff - 2 / tile, v1 = vOff + (h - 2) / tile; // base sits 2 m below ground: v = 0 at ground level
    const u0 = uOff;
    // +z face
    this.quad(P(-hw, 0, hd), P(hw, 0, hd), P(hw, h, hd), P(-hw, h, hd), N(0, 1), [[u0, v0], [u0 + w / tile, v0], [u0 + w / tile, v1], [u0, v1]], color);
    // -z face
    this.quad(P(hw, 0, -hd), P(-hw, 0, -hd), P(-hw, h, -hd), P(hw, h, -hd), N(0, -1), [[u0, v0], [u0 + w / tile, v0], [u0 + w / tile, v1], [u0, v1]], color);
    // +x face
    this.quad(P(hw, 0, hd), P(hw, 0, -hd), P(hw, h, -hd), P(hw, h, hd), N(1, 0), [[u0 + 0.37, v0], [u0 + 0.37 + d / tile, v0], [u0 + 0.37 + d / tile, v1], [u0 + 0.37, v1]], color);
    // -x face
    this.quad(P(-hw, 0, -hd), P(-hw, 0, hd), P(-hw, h, hd), P(-hw, h, -hd), N(-1, 0), [[u0 + 0.37, v0], [u0 + 0.37 + d / tile, v0], [u0 + 0.37 + d / tile, v1], [u0 + 0.37, v1]], color);
    // roof (uv in the solid strip of the atlas)
    const r = [0.012, 0.012];
    this.quad(P(-hw, h, hd), P(hw, h, hd), P(hw, h, -hd), P(-hw, h, -hd), new THREE.Vector3(0, 1, 0), [r, r, r, r], roofColor || color);
  }
  cylinder(x, y0, z, r0, r1, h, seg, color) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const p = (a, r, y) => new THREE.Vector3(x + Math.cos(a) * r, y0 + y, z + Math.sin(a) * r);
      const n = new THREE.Vector3(Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2));
      const u = [0.012, 0.012];
      this.quad(p(a1, r0, 0), p(a0, r0, 0), p(a0, r1, h), p(a1, r1, h), n, [u, u, u, u], color);
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

function facadeTexture(ctx, rnd) {
  // 36 m x 36 m tile (12 floors x 12 bays of 3 m). Neutral light base (vertex colour tints the building):
  // precast panels with tone variation and seams, horizontal window bands, stacked loggia/balcony columns
  // with shadowed recesses, dark glass with sky reflection variation, boarded / burnt / blown-out openings,
  // soot plumes above burnt windows, water streaks, darker ground-floor shop band.
  // A solid patch at uv (0..0.03, 0..0.03) serves roofs, chimneys and cylinders.
  return ctx.assets.canvasTexture(1024, 1024, (g, W, H) => {
    const F = 12, B = 12, fh = H / F, bw = W / B;
    const px = W / 36; // pixels per metre
    g.fillStyle = '#c9c4ba';
    g.fillRect(0, 0, W, H);
    // panel tone variation (one panel = 1 bay x 1 floor)
    for (let f = 0; f < F; f++) for (let b = 0; b < B; b++) {
      const v = Math.floor(rnd() * 26) - 13;
      g.fillStyle = `rgba(${v > 0 ? 255 : 40},${v > 0 ? 250 : 38},${v > 0 ? 240 : 34},${Math.abs(v) / 100})`;
      g.fillRect(b * bw, f * fh, bw, fh);
    }
    // stacked loggia columns (bays), consistent per column so they read as vertical balcony stacks
    const loggia = [];
    for (let b = 0; b < B; b++) loggia.push(rnd() < 0.35);
    for (let f = 0; f < F; f++) {
      const y0 = f * fh;
      for (let b = 0; b < B; b++) {
        const x0 = b * bw;
        const r = rnd();
        const ground = f === F - 1;
        if (ground) {
          // ground floor: shop fronts / entrances, darker
          g.fillStyle = `rgba(35,32,30,${0.55 + rnd() * 0.3})`;
          g.fillRect(x0 + bw * 0.08, y0 + fh * 0.25, bw * 0.84, fh * 0.75);
          continue;
        }
        if (loggia[b]) {
          // recessed loggia: deep shadow + parapet front + slab shadow line
          g.fillStyle = '#2a2826';
          g.fillRect(x0 + 2, y0 + fh * 0.05, bw - 4, fh * 0.62);
          const glaz = rnd();
          g.fillStyle = glaz < 0.5 ? `rgb(${60 + rnd() * 30},${64 + rnd() * 30},${70 + rnd() * 30})` : `rgb(${150 + rnd() * 60},${140 + rnd() * 50},${120 + rnd() * 40})`;
          g.fillRect(x0 + 4, y0 + fh * 0.62, bw - 8, fh * 0.34); // parapet (glazed or painted sheet)
          g.fillStyle = 'rgba(0,0,0,0.35)';
          g.fillRect(x0 + 4, y0 + fh * 0.62, bw - 8, 3);
          if (glaz < 0.3) { g.fillStyle = 'rgba(255,255,255,0.18)'; for (let k = 1; k < 4; k++) g.fillRect(x0 + 4 + k * (bw - 8) / 4, y0 + fh * 0.62, 1, fh * 0.34); }
          continue;
        }
        // window (1.5 x 1.4 m)
        const ww = px * (1.3 + rnd() * 0.5), wh = px * 1.4;
        const wx = x0 + (bw - ww) / 2, wy = y0 + fh * 0.22;
        if (r < 0.05) {
          // blown out: soot plume + hole
          const grd = g.createLinearGradient(0, wy + wh, 0, wy - fh * 1.3);
          grd.addColorStop(0, 'rgba(15,13,12,0.85)'); grd.addColorStop(1, 'rgba(15,13,12,0)');
          g.fillStyle = grd;
          g.beginPath(); g.moveTo(wx - ww * 0.3, wy + wh); g.lineTo(wx + ww * 1.3, wy + wh); g.lineTo(wx + ww * 1.8, wy - fh * 1.3); g.lineTo(wx - ww * 0.8, wy - fh * 1.3); g.fill();
          g.fillStyle = '#070606';
          g.fillRect(wx - px * 0.4, wy - px * 0.3, ww + px * 0.8, wh + px * 0.6);
        } else if (r < 0.12) {
          g.fillStyle = `rgb(${100 + rnd() * 30},${82 + rnd() * 20},${60 + rnd() * 15})`; // boarded
          g.fillRect(wx, wy, ww, wh);
        } else {
          const l = 22 + rnd() * 38, sky = rnd() < 0.25 ? 30 : 0;
          g.fillStyle = `rgb(${l},${l + 4 + sky * 0.4},${l + 9 + sky})`;
          g.fillRect(wx, wy, ww, wh);
          if (rnd() < 0.3) { g.fillStyle = `rgba(${170 + rnd() * 60},${150 + rnd() * 50},${110 + rnd() * 40},0.5)`; g.fillRect(wx + 2, wy + 2, ww * (0.3 + rnd() * 0.4), wh - 4); } // curtain
          g.fillStyle = 'rgba(230,225,215,0.55)'; // frame mullion
          g.fillRect(wx + ww * 0.5 - 1, wy, 2, wh);
          g.fillStyle = 'rgba(0,0,0,0.3)';
          g.fillRect(wx, wy, ww, 2);
        }
        g.fillStyle = 'rgba(225,220,210,0.7)'; // sill
        g.fillRect(wx - 2, wy + wh, ww + 4, 3);
      }
      // floor slab seam + drip shadow
      g.fillStyle = 'rgba(45,42,38,0.55)';
      g.fillRect(0, y0 + fh - 2, W, 2);
      g.fillStyle = 'rgba(45,42,38,0.12)';
      g.fillRect(0, y0 + fh, W, 5);
    }
    // vertical panel seams
    for (let b = 0; b <= B; b++) { g.fillStyle = 'rgba(55,50,45,0.35)'; g.fillRect(b * bw - 1, 0, 2, H); }
    // water streaks / rust runs
    for (let i = 0; i < 220; i++) {
      const x = rnd() * W, y = rnd() * H, h = 20 + rnd() * 160;
      const grd = g.createLinearGradient(0, y, 0, y + h);
      grd.addColorStop(0, `rgba(55,48,40,${0.08 + rnd() * 0.16})`); grd.addColorStop(1, 'rgba(55,48,40,0)');
      g.fillStyle = grd;
      g.fillRect(x, y, 1 + rnd() * 4, h);
    }
    // large grime patches
    for (let i = 0; i < 30; i++) {
      const x = rnd() * W, y = rnd() * H, r = 40 + rnd() * 140;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, `rgba(60,55,48,${0.06 + rnd() * 0.08})`); grd.addColorStop(1, 'rgba(60,55,48,0)');
      g.fillStyle = grd;
      g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    // solid strip for roofs / chimneys (uv near 0,0 -> canvas bottom-left)
    g.fillStyle = '#8f8a82';
    g.fillRect(0, H - 32, 32, 32);
  }, { srgb: true, repeat: null });
}

export function createSkyline(ctx) {
  if (ctx.settings.get('lighting.skyline', true) === false) return null;
  const object = new THREE.Group();
  object.name = 'lighting.skyline';
  const rnd = mulberry32(0x5eed1e55);
  let mesh = null, ridge = null, apron = null;
  let tex = null;
  const mats = [];

  function build(center = new THREE.Vector2(0, 0), radius0 = 170) {
    clear();
    tex = facadeTexture(ctx, rnd);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    const b = new GeoBuilder();
    const palette = [
      [0.46, 0.45, 0.43], [0.52, 0.49, 0.44], [0.40, 0.40, 0.40], [0.50, 0.44, 0.36], [0.44, 0.30, 0.24],
      [0.55, 0.52, 0.46], [0.36, 0.36, 0.35], [0.47, 0.40, 0.33], [0.42, 0.46, 0.42], [0.54, 0.47, 0.38],
    ];
    const col = new THREE.Color();
    const pick = () => { const p = palette[Math.floor(rnd() * palette.length)]; const k = 0.85 + rnd() * 0.3; return col.setRGB(p[0] * k, p[1] * k, p[2] * k).clone(); };

    // --- rings of blocks
    const rings = [
      { r0: radius0, r1: radius0 + 150, n: 110, hMin: 9, hMax: 27, wMin: 18, wMax: 70 },
      { r0: radius0 + 150, r1: radius0 + 450, n: 130, hMin: 12, hMax: 45, wMin: 20, wMax: 90 },
    ];
    for (const R of rings) {
      for (let i = 0; i < R.n; i++) {
        const a = rnd() * Math.PI * 2;
        const r = R.r0 + Math.pow(rnd(), 0.8) * (R.r1 - R.r0);
        const x = center.x + Math.cos(a) * r, z = center.y + Math.sin(a) * r;
        const tall = rnd() < 0.07;
        const h = tall ? 33 + Math.floor(rnd() * 8) * 3 : R.hMin + Math.floor(rnd() * ((R.hMax - R.hMin) / 3)) * 3;
        const w = tall ? 16 + rnd() * 10 : R.wMin + rnd() * (R.wMax - R.wMin);
        const d = tall ? 16 + rnd() * 8 : 11 + rnd() * 5;
        const yaw = -a + Math.PI / 2 + (rnd() - 0.5) * 0.6 + (rnd() < 0.3 ? Math.PI / 2 : 0);
        const c = pick();
        b.box(x, -2, z, w, d, h + 2, yaw, c, 36, c.clone().multiplyScalar(0.8), Math.floor(rnd() * 12) / 12, 0);
        // war damage: stepped / collapsed section on some slabs
        if (!tall && rnd() < 0.25) {
          const cut = 0.25 + rnd() * 0.3;
          b.box(x + Math.cos(yaw) * w * (0.5 - cut / 2), -2, z - Math.sin(yaw) * w * (0.5 - cut / 2), w * cut * 0.9, d * 0.9, (h + 2) * (0.35 + rnd() * 0.3), yaw, c.clone().multiplyScalar(0.7));
        }
        // rooftop clutter
        if (rnd() < 0.4) b.box(x, h, z, 3 + rnd() * 4, 3 + rnd() * 3, 2 + rnd() * 2, yaw, c.clone().multiplyScalar(0.85));
      }
    }
    // industrial chimneys + water tower + cranes + church domes
    for (let i = 0; i < 7; i++) {
      const a = rnd() * Math.PI * 2, r = radius0 + 220 + rnd() * 380;
      const x = center.x + Math.cos(a) * r, z = center.y + Math.sin(a) * r;
      const h = 45 + rnd() * 50;
      const c = new THREE.Color(0.5 + rnd() * 0.15, 0.42, 0.38);
      b.cylinder(x, -2, z, 3.2, 2.0, h, 10, c);
      b.cylinder(x, h - 8, z, 2.3, 2.3, 3, 10, new THREE.Color(0.75, 0.72, 0.7));
    }
    {
      const a = 2.2, r = radius0 + 90;
      const x = center.x + Math.cos(a) * r, z = center.y + Math.sin(a) * r;
      for (let k = 0; k < 4; k++) b.box(x + (k % 2 ? 3 : -3), -1, z + (k < 2 ? 3 : -3), 0.6, 0.6, 26, 0, new THREE.Color(0.35, 0.34, 0.33));
      b.cylinder(x, 25, z, 6, 6, 8, 14, new THREE.Color(0.55, 0.52, 0.48));
      b.cylinder(x, 33, z, 6, 0.5, 3, 14, new THREE.Color(0.45, 0.42, 0.4));
    }
    for (let i = 0; i < 4; i++) {
      const a = rnd() * Math.PI * 2, r = radius0 + 120 + rnd() * 300;
      const x = center.x + Math.cos(a) * r, z = center.y + Math.sin(a) * r;
      const h = 40 + rnd() * 20, yaw = rnd() * Math.PI;
      const c = new THREE.Color(0.55, 0.45, 0.25);
      b.box(x, -2, z, 2, 2, h + 2, yaw, c);
      b.box(x + Math.cos(yaw) * 14, h, z - Math.sin(yaw) * 14, 40, 1.6, 1.8, yaw, c);
      b.box(x - Math.cos(yaw) * 9, h - 2, z + Math.sin(yaw) * 9, 5, 3, 3, yaw, new THREE.Color(0.4, 0.4, 0.4));
    }
    for (let i = 0; i < 2; i++) {
      const a = rnd() * Math.PI * 2, r = radius0 + 200 + rnd() * 200;
      const x = center.x + Math.cos(a) * r, z = center.y + Math.sin(a) * r;
      const c = new THREE.Color(0.8, 0.77, 0.7);
      b.box(x, -2, z, 16, 24, 20, rnd(), c);
      b.cylinder(x, 18, z, 4.5, 4.5, 8, 16, c);
      // dome approximated by stacked tapered rings
      let y = 26;
      for (let k = 0; k < 5; k++) {
        const r0 = 4.8 * Math.cos((k / 5) * Math.PI / 2), r1 = 4.8 * Math.cos(((k + 1) / 5) * Math.PI / 2);
        b.cylinder(x, y, z, Math.max(r0, 0.3), Math.max(r1, 0.2), 1.3, 16, new THREE.Color(0.45, 0.5, 0.42));
        y += 1.3;
      }
      b.cylinder(x, y, z, 0.15, 0.1, 4, 6, new THREE.Color(0.6, 0.55, 0.3));
    }
    const geo = b.build();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: tex, roughness: 0.95, metalness: 0, envMapIntensity: 0.8 });
    mat.defines = { LGT_FOG_SCALE: '2.0' }; // reads as further away than it is (keeps the OOB ring compact)
    mat.name = 'lighting.skyline';
    mats.push(mat);
    mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'lighting.skyline.blocks';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.userData.noSkyVis = true;
    object.add(mesh);

    // --- ground apron (below the world's own ground so it never z-fights)
    const ap = new THREE.RingGeometry(radius0 - 40, 1450, 96, 1);
    ap.rotateX(-Math.PI / 2);
    ap.translate(center.x, -0.35, center.y);
    const apMat = new THREE.MeshStandardMaterial({ color: 0x5f5548, roughness: 1, metalness: 0 });
    apMat.name = 'lighting.apron';
    mats.push(apMat);
    apron = new THREE.Mesh(ap, apMat);
    apron.name = 'lighting.skyline.apron';
    apron.matrixAutoUpdate = false;
    apron.receiveShadow = true;
    object.add(apron);

    // --- mountain ridges: dark foothills + distant snow-capped Caucasus peaks (fogged as if ~5-10 km away)
    const rg = new THREE.BufferGeometry();
    {
      const pos = [], idx = [], colr = [];
      const lattice = (n) => { const l = []; for (let i = 0; i < n; i++) l.push(rnd()); return l; };
      const vnoise = (l, x) => { const n = l.length; const i = Math.floor(x); const f = x - i; const t = f * f * (3 - 2 * f); return l[((i % n) + n) % n] * (1 - t) + l[(((i + 1) % n) + n) % n] * t; };
      const layers = [
        { rIn: 980, rOut: 1150, base: 25, amp: 110, oct: [[6, 1], [15, 0.5], [40, 0.22], [90, 0.06]], cLow: [0.045, 0.05, 0.042], cHigh: [0.06, 0.066, 0.056], snow: 1e9 },
        { rIn: 1200, rOut: 1420, base: 60, amp: 330, oct: [[5, 1], [13, 0.55], [31, 0.28], [70, 0.1]], cLow: [0.05, 0.055, 0.06], cHigh: [0.07, 0.075, 0.085], snow: 330 },
      ];
      let v = 0;
      const seg = 720;
      for (const L of layers) {
        const lats = L.oct.map(([f]) => lattice(f));
        for (let i = 0; i <= seg; i++) {
          const t = i / seg, ang = t * Math.PI * 2;
          let n = 0, norm = 0;
          L.oct.forEach(([f, amp], k) => { const r = 1 - Math.abs(vnoise(lats[k], t * f) * 2 - 1); n += amp * r * r; norm += amp; });
          n /= norm;
          const hgt = L.base + Math.pow(n, 1.6) * L.amp;
          const rMid = L.rIn + (L.rOut - L.rIn) * 0.55;
          const pts = [[L.rIn, -6], [rMid, hgt * 0.7], [L.rOut, hgt]];
          for (let k = 0; k < 3; k++) {
            const [r, y] = pts[k];
            pos.push(center.x + Math.cos(ang) * r, y, center.y + Math.sin(ang) * r);
            const snow = y > L.snow - 40 * n ? 1 : 0;
            const c = k === 0 ? L.cLow : L.cHigh;
            if (snow) colr.push(0.3, 0.32, 0.36); else colr.push(c[0], c[1], c[2]);
          }
          if (i < seg) {
            const q = v + i * 3;
            idx.push(q, q + 3, q + 1, q + 1, q + 3, q + 4, q + 1, q + 4, q + 2, q + 2, q + 4, q + 5);
          }
        }
        v += (seg + 1) * 3;
      }
      rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      rg.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
      rg.setIndex(idx);
      rg.computeVertexNormals();
    }
    const rMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: THREE.DoubleSide });
    rMat.defines = { LGT_FOG_SCALE: '0.7' };
    rMat.name = 'lighting.ridge';
    mats.push(rMat);
    ridge = new THREE.Mesh(rg, rMat);
    ridge.name = 'lighting.skyline.ridge';
    ridge.matrixAutoUpdate = false;
    object.add(ridge);
  }

  function clear() {
    for (const m of [mesh, ridge, apron]) if (m) { object.remove(m); m.geometry.dispose(); }
    for (const m of mats) m.dispose();
    mats.length = 0;
    tex?.dispose();
    mesh = ridge = apron = null;
  }

  build();
  ctx.events.on('core:ready', () => {
    const bnd = ctx.services.world?.bounds;
    if (bnd && !bnd.isEmpty() && ctx.services.isProvided?.('world')) {
      const c = new THREE.Vector2((bnd.min.x + bnd.max.x) / 2, (bnd.min.z + bnd.max.z) / 2);
      const r = Math.max(bnd.max.x - bnd.min.x, bnd.max.z - bnd.min.z) * 0.5 * 1.3 + 90;
      build(c, Math.max(150, r));
    }
  });

  return {
    object,
    applyPreset() {},
    dispose() { clear(); },
  };
}

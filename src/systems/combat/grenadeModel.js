import * as THREE from 'three';

/**
 * Procedural frag grenade (original design): welded ovoid steel body in olive drab with a yellow HE
 * band and stencilled lot markings, a threaded fuse collar, the striker fuse head, a stamped safety
 * lever (spoon) that follows the body contour, and a pull ring + split pin.
 *
 * buildGrenadeAssets(ctx) -> { makeGrenade({pin, spoon}) -> Group, makeSpoon() -> Mesh, dispose() }
 * All geometry/material is shared between instances. Units: metres (body Ø ≈ 64 mm).
 */
function mergeGeos(list) {
  // minimal non-indexed merge (position/normal/uv) so the hinge parts cost one draw call
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0;
  for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    o += g.attributes.position.count;
  }
  for (const g of list) g.dispose();
  for (const g of parts) g.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

export function buildGrenadeAssets(ctx) {
  const disposables = [];
  const keep = (x) => { disposables.push(x); return x; };

  // ------------------------------------------------------------------ textures
  const W = 512, H = 256;
  // UV: u = around (0..1), v = along the lathe profile (0 = bottom pole, 1 = neck)
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

  const PROFILE = [
    [0.0, -0.0345], [0.0065, -0.0340], [0.0135, -0.0322], [0.0205, -0.0285], [0.0262, -0.0228],
    [0.0302, -0.0152], [0.0324, -0.0066], [0.0331, -0.0012], [0.0336, -0.0006], [0.0336, 0.0006],
    [0.0331, 0.0012], [0.0324, 0.0068], [0.0300, 0.0160], [0.0262, 0.0238], [0.0212, 0.0298],
    [0.0158, 0.0336], [0.0122, 0.0352], [0.0112, 0.0360],
  ];
  // cumulative arc length -> v, so the texture maps evenly
  const arc = [0];
  for (let i = 1; i < PROFILE.length; i++) {
    const dx = PROFILE[i][0] - PROFILE[i - 1][0], dy = PROFILE[i][1] - PROFILE[i - 1][1];
    arc.push(arc[i - 1] + Math.hypot(dx, dy));
  }
  const total = arc[arc.length - 1];
  const vOfY = (y) => {
    for (let i = 1; i < PROFILE.length; i++) if (y <= PROFILE[i][1]) {
      const t = (y - PROFILE[i - 1][1]) / (PROFILE[i][1] - PROFILE[i - 1][1]);
      return (arc[i - 1] + t * (arc[i] - arc[i - 1])) / total;
    }
    return 1;
  };
  const vSeam = vOfY(0);
  const vBand0 = vOfY(0.0215), vBand1 = vOfY(0.0262);

  const toneGrid = new Float32Array(17 * 9);
  for (let i = 0; i < toneGrid.length; i++) toneGrid[i] = rnd() - 0.5;
  const toneAt = (x, y) => {
    const gx = (x / W) * 16, gy = (y / H) * 8;
    const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
    const at = (i, j) => toneGrid[Math.min(8, j) * 17 + (i % 16)];
    return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
  };
  const wear = new Float32Array(W * H); // 0..1 paint wear mask (shared by albedo & roughness)
  (function buildWear() {
    // value noise
    const G = 32;
    const grid = new Float32Array((G + 1) * (G + 1));
    for (let i = 0; i < grid.length; i++) grid[i] = rnd();
    const smooth = (t) => t * t * (3 - 2 * t);
    const vnoise = (x, y) => {
      const xi = Math.floor(x) % G, yi = Math.floor(y) % G;
      const xf = smooth(x - Math.floor(x)), yf = smooth(y - Math.floor(y));
      const a = grid[yi * (G + 1) + xi], b = grid[yi * (G + 1) + ((xi + 1) % G)];
      const c = grid[((yi + 1) % G) * (G + 1) + xi], d = grid[((yi + 1) % G) * (G + 1) + ((xi + 1) % G)];
      return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
    };
    for (let y = 0; y < H; y++) {
      const v = 1 - y / (H - 1); // canvas row 0 = v 1 (flipY)
      for (let x = 0; x < W; x++) {
        const u = x / W;
        let n = 0.55 * vnoise(u * 8, v * 4) + 0.3 * vnoise(u * 24 + 3, v * 12 + 7) + 0.15 * vnoise(u * 64 + 11, v * 30 + 1);
        // wear concentrates on the equator seam (most exposed) and the bottom pole
        const seam = Math.exp(-Math.pow((v - vSeam) / 0.03, 2));
        // u-noise converges into a star at the poles: fade it out there
        const polar = Math.min(1, v / 0.16, (1 - v) / 0.1);
        const k = (n - 0.74) * polar + seam * 0.3 * polar + (1 - polar) * -0.2;
        wear[y * W + x] = Math.max(0, Math.min(1, k * 4.0));
      }
    }
  })();

  const albedo = keep(ctx.assets.canvasTexture(W, H, (g) => {
    // 1) base paint (olive drab with a low-frequency tone drift, darker grime toward the base)
    const img = g.createImageData(W, H);
    const d = img.data;
    for (let y = 0; y < H; y++) {
      const v = 1 - y / (H - 1); // canvas row 0 = v 1 (flipY)
      const band = v > vBand0 && v < vBand1;
      const bandEdge = band ? Math.min(v - vBand0, vBand1 - v) / (vBand1 - vBand0) : 0;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const tone = toneAt(x, y);
        const mott = (rnd() - 0.5) * 3;
        const grime = 1 - 0.28 * Math.exp(-Math.pow(v / 0.2, 2)) - 0.1 * Math.exp(-Math.pow((1 - v) / 0.08, 2));
        let r = (58 + mott + tone * 9) * grime, gg = (61 + mott + tone * 8) * grime, b = (41 + mott * 0.6 + tone * 4) * grime;
        if (band) { const k = Math.min(1, bandEdge * 6); r += (150 - r) * k * 0.9; gg += (124 - gg) * k * 0.9; b += (52 - b) * k * 0.9; }
        d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    // 2) stencilled markings (original lot code): small, slightly soft ink
    g.save();
    g.fillStyle = 'rgba(184,160,92,0.62)';
    g.font = 'bold 7px "Arial Narrow", Arial, sans-serif';
    g.textBaseline = 'middle';
    for (let k = 0; k < 2; k++) {
      const x0 = 44 + k * 256;
      g.fillText('GREN HAND FRAG DM-41', x0, H * (1 - vOfY(0.0118)));
      g.fillText('LOT VK-17-092 COMP B', x0, H * (1 - vOfY(0.0062)));
    }
    g.restore();
    // 3) wear over everything (paint chipped to dark phosphate, brightest steel on the most exposed spots),
    //    speckle and dust in the lower hemisphere
    const img2 = g.getImageData(0, 0, W, H);
    const e = img2.data;
    for (let y = 0; y < H; y++) {
      const v = 1 - y / (H - 1);
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const w = wear[y * W + x];
        if (w > 0) {
          const steel = w > 0.7 ? 104 : 46;
          e[i] += (steel - e[i]) * w; e[i + 1] += (steel + 1 - e[i + 1]) * w; e[i + 2] += (steel + 4 - e[i + 2]) * w;
        }
        const sp = rnd();
        if (sp > 0.994) { const k = 0.75; e[i] *= k; e[i + 1] *= k; e[i + 2] *= k; }
        const dust = Math.exp(-Math.pow(v / 0.24, 2)) * (0.25 + 0.35 * rnd());
        e[i] += (104 - e[i]) * dust * 0.35; e[i + 1] += (92 - e[i + 1]) * dust * 0.35; e[i + 2] += (72 - e[i + 2]) * dust * 0.35;
      }
    }
    g.putImageData(img2, 0, 0);
    // 4) scuffs: thin scratches, mostly around the equator
    for (let i = 0; i < 90; i++) {
      const x = rnd() * W, y = H * (1 - vSeam) + (rnd() - 0.5) * H * 0.7, len = 3 + rnd() * 14, a = rnd() * Math.PI;
      g.strokeStyle = `rgba(118,118,108,${0.06 + rnd() * 0.16})`;
      g.lineWidth = 0.5 + rnd() * 0.5;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len * 0.35); g.stroke();
    }
  }, { srgb: true }));
  albedo.wrapS = THREE.RepeatWrapping;

  const rough = keep(ctx.assets.canvasTexture(W, H, (g) => {
    const img = g.createImageData(W, H);
    const d = img.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const w = wear[y * W + x];
        // G = roughness, B = metalness (three.js convention)
        const v = 1 - y / (H - 1);
        const dust = Math.exp(-Math.pow(v / 0.24, 2));
        const rr = 0.56 + (rnd() - 0.5) * 0.1 + toneAt(x, y) * 0.12 + dust * 0.2 - w * 0.22;
        const mm = w > 0.4 ? Math.min(1, (w - 0.4) * 1.8) : 0;
        d[i] = 255; d[i + 1] = Math.max(0, Math.min(255, rr * 255)); d[i + 2] = mm * 255; d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }, { srgb: false }));
  rough.wrapS = THREE.RepeatWrapping;


  // normal map from a height field: fine orange-peel paint, the pressed-halves weld bead at the equator
  const NW = 512, NH = 256;
  const height = new Float32Array(NW * NH);
  {
    const G = 64;
    const grid = new Float32Array(G * G);
    for (let i = 0; i < grid.length; i++) grid[i] = rnd();
    const vn = (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      const a = grid[(yi % G) * G + (xi % G)], b = grid[(yi % G) * G + ((xi + 1) % G)];
      const c = grid[((yi + 1) % G) * G + (xi % G)], d = grid[((yi + 1) % G) * G + ((xi + 1) % G)];
      return (a * (1 - xf) + b * xf) * (1 - yf) + (c * (1 - xf) + d * xf) * yf;
    };
    for (let y = 0; y < NH; y++) {
      const v = 1 - y / (NH - 1);
      for (let x = 0; x < NW; x++) {
        const u = x / NW;
        const peel = vn(u * 60, v * 28) * 0.5 + vn(u * 140 + 5, v * 64 + 9) * 0.3;
        const bead = Math.exp(-Math.pow((v - vSeam) / 0.006, 2)) * 5.0;
        const band = v > vBand0 && v < vBand1 ? 0.6 : 0; // paint thickness step of the marking band
        height[y * NW + x] = peel * 0.9 + bead + band;
      }
    }
  }
  const normalTex = keep(ctx.assets.canvasTexture(NW, NH, (g) => {
    const img = g.createImageData(NW, NH);
    const d = img.data;
    const k = 0.9;
    for (let y = 0; y < NH; y++) {
      for (let x = 0; x < NW; x++) {
        const hL = height[y * NW + ((x - 1 + NW) % NW)], hR = height[y * NW + ((x + 1) % NW)];
        const hU = height[Math.max(0, y - 1) * NW + x], hD = height[Math.min(NH - 1, y + 1) * NW + x];
        let nx = (hL - hR) * k, ny = (hD - hU) * k, nz = 1;
        const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
        const i = (y * NW + x) * 4;
        d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }, { srgb: false }));
  normalTex.wrapS = THREE.RepeatWrapping;

  // ------------------------------------------------------------------ materials
  const bodyMat = keep(new THREE.MeshStandardMaterial({
    name: 'combat_grenade_body', map: albedo, roughnessMap: rough, metalnessMap: rough, roughness: 1, metalness: 1,
    normalMap: normalTex, normalScale: new THREE.Vector2(0.35, 0.35), envMapIntensity: 1.0,
  }));
  bodyMat.userData.surface = 'metal';
  const steelMat = keep(new THREE.MeshStandardMaterial({ name: 'combat_grenade_steel', color: 0x8d8e88, roughness: 0.38, metalness: 1.0 }));
  steelMat.userData.surface = 'metal';
  const fuseMat = keep(new THREE.MeshStandardMaterial({ name: 'combat_grenade_fuse', color: 0x50523f, roughness: 0.5, metalness: 0.55 }));
  fuseMat.userData.surface = 'metal';
  const spoonMat = keep(new THREE.MeshStandardMaterial({ name: 'combat_grenade_spoon', color: 0x55583f, roughness: 0.55, metalness: 0.35, side: THREE.DoubleSide }));
  spoonMat.userData.surface = 'metal';

  // ------------------------------------------------------------------ geometry
  const bodyPts = new THREE.SplineCurve(PROFILE.map(([r, y]) => new THREE.Vector2(r, y))).getPoints(56);
  bodyPts[0].x = 0;
  const bodyGeo = keep(new THREE.LatheGeometry(bodyPts, 72));
  // remap v to arc length for even texturing
  {
    const uv = bodyGeo.attributes.uv;
    const pos = bodyGeo.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setY(i, vOfY(pos.getY(i)));
    uv.needsUpdate = true;
  }
  bodyGeo.computeVertexNormals();

  const fusePts = [
    [0.0, 0.0346], [0.0118, 0.0346], [0.0121, 0.0352], [0.0121, 0.0396], [0.0117, 0.0401], [0.0121, 0.0406],
    [0.0121, 0.0422], [0.0102, 0.0426], [0.0096, 0.0432], [0.0096, 0.0548], [0.0090, 0.0566], [0.0074, 0.0580],
    [0.0040, 0.0588], [0.0, 0.0590],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const fuseGeo = keep(new THREE.LatheGeometry(fusePts, 40));

  // striker hinge on the spoon side: two ear plates + hinge pin, merged into one geometry
  const lugGeo = keep(mergeGeos([
    new THREE.BoxGeometry(0.0062, 0.0105, 0.0013).translate(0.0118, 0.0515, 0.0047),
    new THREE.BoxGeometry(0.0062, 0.0105, 0.0013).translate(0.0118, 0.0515, -0.0047),
    new THREE.CylinderGeometry(0.0011, 0.0011, 0.0118, 8).rotateX(Math.PI / 2).translate(0.0138, 0.0548, 0),
    // striker housing bulge between the ears
    new THREE.CylinderGeometry(0.0034, 0.0034, 0.0078, 12).translate(0.0098, 0.0505, 0),
    // base fill plug
    new THREE.CylinderGeometry(0.0062, 0.0066, 0.0016, 20).translate(0, -0.0345, 0),
  ]));

  // spoon: rectangle swept along a curve hugging fuse + body (in the XY plane, +X side)
  const spoonCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.0006, 0.0600, 0), new THREE.Vector3(0.0070, 0.0602, 0), new THREE.Vector3(0.0108, 0.0588, 0),
    new THREE.Vector3(0.0116, 0.0545, 0), new THREE.Vector3(0.0118, 0.0460, 0), new THREE.Vector3(0.0138, 0.0372, 0),
    new THREE.Vector3(0.0205, 0.0310, 0), new THREE.Vector3(0.0272, 0.0236, 0), new THREE.Vector3(0.0318, 0.0145, 0),
    new THREE.Vector3(0.0342, 0.0045, 0), new THREE.Vector3(0.0345, -0.0055, 0), new THREE.Vector3(0.0333, -0.0140, 0),
  ], false, 'catmullrom', 0.3);
  const spoonShape = new THREE.Shape();
  // shape x -> curve normal (thickness), shape y -> binormal (width). Slight taper not possible here;
  // keep a pressed channel profile: flat plate with folded edges.
  const t = 0.0011, wdt = 0.0062;
  spoonShape.moveTo(-t * 0.5, -wdt);
  spoonShape.lineTo(t * 0.5, -wdt);
  spoonShape.lineTo(t * 0.5 + 0.0012, -wdt * 0.92);
  spoonShape.lineTo(t * 0.5 + 0.0012, wdt * 0.92);
  spoonShape.lineTo(t * 0.5, wdt);
  spoonShape.lineTo(-t * 0.5, wdt);
  spoonShape.lineTo(-t * 0.5, -wdt);
  const spoonGeo = keep(new THREE.ExtrudeGeometry(spoonShape, { steps: 40, bevelEnabled: false, extrudePath: spoonCurve }));
  spoonGeo.computeVertexNormals();

  // pull ring + pin (ring hangs on the side opposite the spoon, in the XY plane offset toward -Z)
  // ring: torus hung from its top point (the pin eye), swung out of the fuse's way on the -Z side
  const ringGeo = keep(new THREE.TorusGeometry(0.0112, 0.00105, 8, 40));
  ringGeo.translate(0, -0.0112, 0);
  ringGeo.rotateY(Math.PI / 2); // ring plane = YZ
  ringGeo.rotateZ(-0.55); // swing outward
  ringGeo.rotateY(0.25);
  ringGeo.translate(0.0105, 0.0495, -0.0158);
  const pinGeo = keep(mergeGeos([
    new THREE.CylinderGeometry(0.0008, 0.0008, 0.034, 8).rotateX(Math.PI / 2).translate(0.0105, 0.0495, 0.001),
    // bent-over split end on the far side
    new THREE.CylinderGeometry(0.0007, 0.0007, 0.006, 6).rotateZ(Math.PI / 2 - 0.5).translate(0.0125, 0.0485, 0.0182),
  ]));

  function mesh(geo, mat, name) {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  function makeGrenade({ pin = true, spoon = true } = {}) {
    const g = new THREE.Group();
    g.name = 'frag_grenade';
    g.add(mesh(bodyGeo, bodyMat, 'body'));
    g.add(mesh(fuseGeo, fuseMat, 'fuse'));
    g.add(mesh(lugGeo, fuseMat, 'lug'));
    const s = mesh(spoonGeo, spoonMat, 'spoon');
    s.visible = spoon;
    g.add(s);
    const ring = mesh(ringGeo, steelMat, 'ring');
    const pn = mesh(pinGeo, steelMat, 'pin');
    ring.visible = pn.visible = pin;
    g.add(ring, pn);
    // pivot at the body centre of mass
    return g;
  }

  function makeSpoon() {
    const m = mesh(spoonGeo, spoonMat, 'spoon_debris');
    // recentre around the spoon's middle so it tumbles about its own centre
    return m;
  }

  return {
    makeGrenade,
    makeSpoon,
    materials: { bodyMat, steelMat, fuseMat, spoonMat },
    spoonCenter: new THREE.Vector3(0.026, 0.03, 0),
    dispose() { for (const d of disposables) d.dispose?.(); },
  };
}

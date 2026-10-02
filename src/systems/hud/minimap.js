import * as THREE from 'three';
import { el, setOpacity, clamp } from './util.js';

/**
 * Minimap: the level is baked ONCE from the live world geometry (top-down orthographic height pass on
 * the GPU, read back, then styled on the CPU with a morphological top-hat to separate structures from
 * terrain, edge outlines and roof shading). At runtime a 2D canvas draws the baked image rotated around
 * the player plus the view cone, enemy pings, objective and player arrow. The bake re-runs automatically
 * when the world's collider set changes (lazy-loaded geometry).
 */
const MAP_U = 252; // css size (u)
const VIEW_M = 72; // meters across the minimap

const HEIGHT_VS = /* glsl */ `
#include <common>
#include <batching_pars_vertex>
#include <skinning_pars_vertex>
varying vec3 vWorld;
void main() {
  #include <batching_vertex>
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vec4 wp = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
    wp = batchingMatrix * wp;
  #endif
  #ifdef USE_INSTANCING
    wp = instanceMatrix * wp;
  #endif
  vWorld = (modelMatrix * wp).xyz;
}`;
const HEIGHT_FS = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (n.y < 0.0) n = -n;
  gl_FragColor = vec4(vWorld.y, n.x, n.z, 1.0);
}`;

export function createMinimap(hud) {
  const { ctx } = hud;
  const root = el('div', 'od-minimap', hud.layer);
  el('div', 'frame', root);
  const canvas = el('canvas', '', root);
  for (const c of ['tl', 'tr', 'bl', 'br']) el('div', 'corner ' + c, root);
  const g = canvas.getContext('2d', { alpha: true });

  const bakeCanvas = document.createElement('canvas');
  bakeCanvas.width = bakeCanvas.height = 4;
  const bctx = bakeCanvas.getContext('2d');
  const map = { minX: -80, minZ: -80, ppm: 4, w: 0, h: 0, ready: false, signature: '' };

  let cw = 0;
  let ch = 0;
  let checkTimer = 0;

  function resize() {
    const px = Math.max(64, Math.round(MAP_U * hud.hudU * hud.dpr));
    if (px !== cw) {
      cw = ch = px;
      canvas.width = cw;
      canvas.height = ch;
    }
  }

  // ------------------------------------------------------------------------------------------ bake
  function worldSignature() {
    const w = ctx.services.world;
    const n = w.colliders?.length ?? 0;
    const r = w.root ? w.root.children.length : 0;
    const b = w.bounds;
    return `${n}|${r}|${b ? b.min.x.toFixed(1) + ',' + b.max.x.toFixed(1) + ',' + b.min.z.toFixed(1) + ',' + b.max.z.toFixed(1) : ''}`;
  }

  function bake() {
    const { renderer, scene } = ctx;
    const world = ctx.services.world;
    const b = world.bounds || new THREE.Box3(new THREE.Vector3(-70, 0, -70), new THREE.Vector3(70, 20, 70));
    const pad = 36;
    const minX = b.min.x - pad, maxX = b.max.x + pad;
    const minZ = b.min.z - pad, maxZ = b.max.z + pad;
    const sx = maxX - minX, sz = maxZ - minZ;
    const ppm = Math.min(6, 2048 / Math.max(sx, sz));
    const W = Math.max(8, Math.ceil(sx * ppm));
    const H = Math.max(8, Math.ceil(sz * ppm));
    const top = Math.max(b.max.y, 40) + 60;
    const bottom = Math.min(b.min.y, 0) - 20;

    const cam = new THREE.OrthographicCamera(-sx / 2, sx / 2, sz / 2, -sz / 2, 0.1, top - bottom);
    cam.position.set((minX + maxX) / 2, top, (minZ + maxZ) / 2);
    cam.up.set(0, 0, -1);
    cam.lookAt(cam.position.x, top - 10, cam.position.z);
    cam.updateMatrixWorld(true);
    cam.layers.set(ctx.layers.WORLD);

    const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    const mat = new THREE.ShaderMaterial({ vertexShader: HEIGHT_VS, fragmentShader: HEIGHT_FS, side: THREE.DoubleSide });
    const buf = new Float32Array(W * H * 4);

    // save renderer / scene state
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear;
    const prevBg = scene.background, prevFog = scene.fog, prevOverride = scene.overrideMaterial;
    const sm = renderer.shadowMap;
    const prevSmAuto = sm.autoUpdate, prevSmNeeds = sm.needsUpdate;
    const prevTM = renderer.toneMapping;
    let ok = false;
    try {
      scene.background = null;
      scene.fog = null;
      scene.overrideMaterial = mat;
      sm.autoUpdate = false;
      sm.needsUpdate = false;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.autoClear = true;
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(scene, cam);
      renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
      ok = true;
    } catch (e) {
      ctx.reportError('hud', 'minimap-bake', e);
    } finally {
      scene.background = prevBg;
      scene.fog = prevFog;
      scene.overrideMaterial = prevOverride;
      sm.autoUpdate = prevSmAuto;
      sm.needsUpdate = prevSmNeeds;
      renderer.toneMapping = prevTM;
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.autoClear = prevAuto;
      rt.dispose();
      mat.dispose();
    }
    if (!ok) return;

    const N = W * H;
    const hgt = new Float32Array(N);
    const nx = new Float32Array(N);
    const nz = new Float32Array(N);
    let lo = Infinity;
    for (let y = 0; y < H; y++) {
      // GL rows start at the bottom (south); image rows start at the top (north)
      const src = (H - 1 - y) * W;
      for (let x = 0; x < W; x++) {
        const s = (src + x) * 4;
        const i = y * W + x;
        if (buf[s + 3] > 0.5) {
          hgt[i] = buf[s];
          nx[i] = buf[s + 1];
          nz[i] = buf[s + 2];
          if (buf[s] < lo) lo = buf[s];
        } else hgt[i] = NaN;
      }
    }
    if (!Number.isFinite(lo)) lo = 0;
    for (let i = 0; i < N; i++) if (hgt[i] !== hgt[i]) hgt[i] = lo;

    // morphological opening (erode then dilate) -> terrain estimate; top-hat = structures
    const R = Math.max(2, Math.round(15 * ppm));
    const open = morph(morph(hgt, W, H, R, true), W, H, R, false);
    const rel = new Float32Array(N);
    for (let i = 0; i < N; i++) rel[i] = hgt[i] - open[i];

    const img = bctx.createImageData(W, H);
    const d = img.data;
    const LX = -0.55, LZ = -0.62; // light from north-west for roof shading
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const r = rel[i];
        const o = i * 4;
        if (r < 0.28) {
          // ground: faint terrain relief only
          d[o] = 140; d[o + 1] = 150; d[o + 2] = 156; d[o + 3] = 0;
          continue;
        }
        // edge detection: any neighbor (radius 1..2) noticeably lower
        let edge = 0;
        for (let k = 1; k <= 2 && !edge; k++) {
          const l = x - k >= 0 ? rel[i - k] : 0;
          const rr = x + k < W ? rel[i + k] : 0;
          const u = y - k >= 0 ? rel[i - k * W] : 0;
          const dd = y + k < H ? rel[i + k * W] : 0;
          const m = Math.min(l, rr, u, dd);
          if (r - m > 0.7 || m < 0.28) edge = k;
        }
        const shade = clamp(0.5 + (nx[i] * LX + nz[i] * LZ) * 1.6, 0, 1);
        let cr, cg, cb, ca;
        if (r < 1.3) {
          cr = 120; cg = 128; cb = 132; ca = 90;
        } else if (r < 2.6) {
          cr = 150; cg = 158; cb = 162; ca = 150;
        } else {
          const v = 104 + Math.min(34, r * 1.6) + (shade - 0.5) * 30;
          cr = v; cg = v + 7; cb = v + 11; ca = 175;
        }
        // low props (benches, sandbags, rubble) stay as a soft fill: outlining them is what makes a
        // minimap look noisy. Only real structures (walls, buildings, vehicles) get a crisp edge.
        if (r >= 1.3) {
          if (edge === 1) { cr = 222; cg = 228; cb = 230; ca = 235; }
          else if (edge === 2) { cr = (cr + 210) / 2; cg = (cg + 216) / 2; cb = (cb + 220) / 2; ca = Math.max(ca, 200); }
        } else if (edge === 1) { ca = 135; }
        d[o] = cr; d[o + 1] = cg; d[o + 2] = cb; d[o + 3] = ca;
      }
    }

    bakeCanvas.width = W;
    bakeCanvas.height = H;
    // grid underlay (10 m), then structures on top
    bctx.clearRect(0, 0, W, H);
    const tmp = document.createElement('canvas');
    tmp.width = W;
    tmp.height = H;
    tmp.getContext('2d').putImageData(img, 0, 0);
    bctx.strokeStyle = 'rgba(210,225,230,0.055)';
    bctx.lineWidth = Math.max(1, ppm * 0.18);
    bctx.beginPath();
    const g0x = Math.ceil(minX / 10) * 10, g0z = Math.ceil(minZ / 10) * 10;
    for (let gx = g0x; gx < maxX; gx += 10) { const px = (gx - minX) * ppm; bctx.moveTo(px, 0); bctx.lineTo(px, H); }
    for (let gz = g0z; gz < maxZ; gz += 10) { const pz = (gz - minZ) * ppm; bctx.moveTo(0, pz); bctx.lineTo(W, pz); }
    bctx.stroke();
    bctx.drawImage(tmp, 0, 0);
    tmp.width = tmp.height = 1;

    map.minX = minX;
    map.minZ = minZ;
    map.ppm = ppm;
    map.w = W;
    map.h = H;
    map.ready = true;
    map.signature = worldSignature();
    hud.onMapBaked?.();
  }

  // ---------------------------------------------------------------------------------------- draw
  const tmpV = { x: 0, y: 0 };
  function toMap(dx, dz, cb, sb, s) {
    // world delta -> rotated minimap pixels (map rotates so player forward is up)
    tmpV.x = (dx * cb + dz * sb) * s;
    tmpV.y = (-dx * sb + dz * cb) * s;
    return tmpV;
  }

  /**
   * @param {object} p   {x, z, bearing (rad cw from north), hfov (rad)}
   * @param {Array} blips [{x, z, alpha, kind:'enemy'|'ping'|'obj'|'friend', age}]
   */
  function draw(p, blips, nBlips, uiTime) {
    if (!cw) resize();
    const u = hud.hudU * hud.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cw, ch);
    const cx = cw / 2, cy = ch / 2;
    const s = cw / VIEW_M; // px per meter
    const cb = Math.cos(p.bearing), sb = Math.sin(p.bearing);

    if (map.ready) {
      g.save();
      g.translate(cx, cy);
      g.rotate(-p.bearing);
      const k = s / map.ppm;
      g.scale(k, k);
      g.translate(-(p.x - map.minX) * map.ppm, -(p.z - map.minZ) * map.ppm);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(bakeCanvas, 0, 0);
      g.restore();
    }

    // view cone
    const coneR = cw * 0.62;
    const half = p.hfov / 2;
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, coneR);
    grad.addColorStop(0, 'rgba(235,240,236,0.20)');
    grad.addColorStop(1, 'rgba(235,240,236,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, coneR, -Math.PI / 2 - half, -Math.PI / 2 + half);
    g.closePath();
    g.fill();

    // blips
    for (let i = 0; i < nBlips; i++) {
      const bl = blips[i];
      const v = toMap(bl.x - p.x, bl.z - p.z, cb, sb, s);
      let x = cx + v.x, y = cy + v.y;
      const edge = cw / 2 - 7 * u;
      const out = Math.abs(v.x) > edge || Math.abs(v.y) > edge;
      if (out && bl.kind !== 'obj') continue;
      if (out) {
        const m = edge / Math.max(Math.abs(v.x), Math.abs(v.y));
        x = cx + v.x * m;
        y = cy + v.y * m;
      }
      if (bl.kind === 'enemy') {
        g.globalAlpha = bl.alpha;
        g.fillStyle = 'rgba(255,50,35,0.28)';
        g.beginPath(); g.arc(x, y, 8 * u, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#ff3b2c';
        g.strokeStyle = 'rgba(40,0,0,0.8)';
        g.lineWidth = 1.2 * u;
        g.beginPath(); g.arc(x, y, 4.4 * u, 0, Math.PI * 2); g.fill(); g.stroke();
      } else if (bl.kind === 'ping') {
        const t = bl.age % 1.2;
        g.globalAlpha = bl.alpha * (1 - t / 1.2);
        g.strokeStyle = '#ff3b2c';
        g.lineWidth = 1.5 * u;
        g.beginPath(); g.arc(x, y, (4 + t * 14) * u, 0, Math.PI * 2); g.stroke();
        g.globalAlpha = bl.alpha;
        g.fillStyle = '#ff3b2c';
        g.beginPath(); g.arc(x, y, 3.5 * u, 0, Math.PI * 2); g.fill();
      } else if (bl.kind === 'obj') {
        g.globalAlpha = bl.alpha;
        const r = 7 * u;
        g.fillStyle = '#f0c048';
        g.strokeStyle = 'rgba(20,14,0,0.85)';
        g.lineWidth = 1.5 * u;
        g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); g.fill(); g.stroke();
      } else if (bl.kind === 'friend') {
        g.globalAlpha = bl.alpha;
        g.fillStyle = '#86d2ff';
        g.beginPath(); g.arc(x, y, 4 * u, 0, Math.PI * 2); g.fill();
      }
    }
    g.globalAlpha = 1;

    // player arrow
    const a = 9 * u;
    g.save();
    g.translate(cx, cy);
    g.fillStyle = '#f4f6f2';
    g.strokeStyle = 'rgba(0,0,0,0.75)';
    g.lineWidth = 1.6 * u;
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(0, -a * 1.05);
    g.lineTo(a * 0.78, a * 0.85);
    g.lineTo(0, a * 0.42);
    g.lineTo(-a * 0.78, a * 0.85);
    g.closePath();
    g.stroke();
    g.fill();
    g.restore();

    // north marker on the rim
    const nxv = -sb, nyv = -cb; // north direction after rotation
    const rim = cw / 2 - 12 * u;
    const m = rim / Math.max(Math.abs(nxv), Math.abs(nyv), 1e-4);
    const nxp = cx + nxv * m, nyp = cy + nyv * m;
    g.fillStyle = 'rgba(8,10,12,0.7)';
    g.beginPath(); g.arc(nxp, nyp, 9 * u, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f0c048';
    g.font = `700 ${Math.round(12 * u)}px Bahnschrift, 'Segoe UI', sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', nxp, nyp + 0.5 * u);
  }

  /** Static overview of the whole map into another canvas (menu card). */
  function drawPreview(target, focusX, focusZ, meters) {
    const tg = target.getContext('2d');
    const w = target.width, h = target.height;
    tg.clearRect(0, 0, w, h);
    if (!map.ready) return;
    const s = w / meters;
    const k = s / map.ppm;
    tg.save();
    tg.translate(w / 2, h / 2);
    tg.scale(k, k);
    tg.translate(-(focusX - map.minX) * map.ppm, -(focusZ - map.minZ) * map.ppm);
    tg.imageSmoothingEnabled = true;
    tg.imageSmoothingQuality = 'high';
    tg.drawImage(bakeCanvas, 0, 0);
    tg.restore();
  }

  function maybeRebake(dt) {
    checkTimer -= dt;
    if (checkTimer > 0) return;
    checkTimer = 1.0;
    if (ctx.assets.pending?.size > 0 && map.ready) return; // wait for loads to settle
    const sig = worldSignature();
    if (!map.ready || sig !== map.signature) bake();
  }

  return {
    root,
    map,
    resize,
    bake,
    draw,
    drawPreview,
    maybeRebake,
    setAlpha: (a) => setOpacity(root, a),
    viewMeters: VIEW_M,
    dispose() {
      bakeCanvas.width = bakeCanvas.height = 1;
    },
  };
}

/** Separable van Herk / Gil-Werman min (erode) or max (dilate) filter with window 2R+1. O(N). */
function morph(src, W, H, R, isMin) {
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  const n = Math.max(W, H);
  const line = new Float32Array(n + 2 * R);
  const gB = new Float32Array(n + 2 * R);
  const hB = new Float32Array(n + 2 * R);
  const op = isMin ? Math.min : Math.max;
  const pad = isMin ? Infinity : -Infinity;
  const k = 2 * R + 1;
  const pass = (read, write, len, count, stride, step) => {
    for (let c = 0; c < count; c++) {
      const base = c * stride;
      const L = len + 2 * R;
      for (let i = 0; i < L; i++) {
        const j = i - R;
        line[i] = j < 0 || j >= len ? pad : read[base + j * step];
      }
      for (let i = 0; i < L; i++) gB[i] = i % k === 0 ? line[i] : op(gB[i - 1], line[i]);
      for (let i = L - 1; i >= 0; i--) hB[i] = i % k === k - 1 || i === L - 1 ? line[i] : op(hB[i + 1], line[i]);
      for (let j = 0; j < len; j++) {
        // window [j, j + 2R] in padded coordinates
        write[base + j * step] = op(hB[j], gB[j + 2 * R]);
      }
    }
  };
  pass(src, tmp, W, H, W, 1); // rows
  pass(tmp, out, H, W, 1, W); // columns
  return out;
}

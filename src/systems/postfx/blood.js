import * as THREE from 'three';

/**
 * Deterministic full-screen blood-splatter mask (RGBA8, authored for 16:9, seeded from ctx.rng):
 *   R: blood film thickness 0..1 (flat interior, soft wet rim)
 *   G: reveal threshold 0..1 -- the damage level at which that splat appears. Splats hugging the frame
 *      edges reveal first; heavier damage creeps further toward the centre. The centre stays clear.
 * Built once at init (~30 ms at 960x540), no per-frame work.
 */
export function createBloodTexture(rng, W = 960, H = 540) {
  const n = W * H;
  const thick = new Float32Array(n);
  const thr = new Float32Array(n).fill(1);
  const aspect = W / H;
  const R = () => rng.next();

  // stamp an (optionally elongated, noisy-edged) blob. Coordinates in [0,aspect] x [0,1] (y down).
  function blob(cx, cy, r, reveal, { stretch = 1, angle = 0, rough = 0.25, amp = 1 } = {}) {
    const ph = [R() * 6.28, R() * 6.28, R() * 6.28];
    // higher harmonics = crown/spike edges of a real impact splat (low harmonics read as cartoon 'flowers')
    const fr = [3 + Math.floor(R() * 3), 7 + Math.floor(R() * 4), 14 + Math.floor(R() * 7)];
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const ext = r * Math.max(1, stretch) * (1 + rough) + 2 / H;
    const x0 = Math.max(0, Math.floor((cx - ext) / aspect * W)), x1 = Math.min(W - 1, Math.ceil((cx + ext) / aspect * W));
    const y0 = Math.max(0, Math.floor((cy - ext) * H)), y1 = Math.min(H - 1, Math.ceil((cy + ext) * H));
    for (let y = y0; y <= y1; y++) {
      const py = (y + 0.5) / H - cy;
      for (let x = x0; x <= x1; x++) {
        const px = ((x + 0.5) / W) * aspect - cx;
        // rotate into blob space, squash along the stretch axis
        const u = (px * ca + py * sa) / stretch, v = -px * sa + py * ca;
        const d = Math.hypot(u, v);
        const a = Math.atan2(v, u);
        const rr = r * (1 + rough * (0.4 * Math.sin(a * fr[0] + ph[0]) + 0.3 * Math.sin(a * fr[1] + ph[1]) + 0.3 * Math.abs(Math.sin(a * fr[2] * 0.5 + ph[2]))));
        const k = 1 - d / Math.max(1e-5, rr);
        if (k <= 0) continue;
        // wet rim then pooling toward the core (thicker = darker through the film)
        const t = Math.min(1, k / 0.16) * (0.55 + 0.45 * Math.sqrt(k)) * amp;
        const i = y * W + x;
        if (t > thick[i]) thick[i] = t;
        if (t > 0.05 && reveal < thr[i]) thr[i] = reveal;
      }
    }
  }

  // point on the frame border, pushed inward by `depth` (0 = on the edge)
  function edgePoint(depth) {
    const s = R() * (2 * aspect + 2);
    let x, y;
    if (s < aspect) { x = s; y = depth; }
    else if (s < 2 * aspect) { x = s - aspect; y = 1 - depth; }
    else if (s < 2 * aspect + 1) { x = depth; y = s - 2 * aspect; }
    else { x = aspect - depth; y = s - 2 * aspect - 1; }
    return [x, y];
  }
  const edgeDist = (x, y) => Math.min(x, aspect - x, y, 1 - y);
  // 0 at a frame corner .. 1 at the middle of an edge: corners bleed first, mid-edges (under the compass,
  // behind the crosshair line) only at heavy damage
  const cornerDist = (x, y) => Math.min(1, Math.min(Math.hypot(x, y), Math.hypot(aspect - x, y), Math.hypot(x, 1 - y), Math.hypot(aspect - x, 1 - y)) / 0.9);

  // 1) splatter clusters: a main splat + satellites + streaks thrown toward the centre
  for (let c = 0; c < 30; c++) {
    const depth = Math.pow(R(), 2.0) * 0.06;
    const [cx, cy] = edgePoint(depth);
    const ed = edgeDist(cx, cy);
    const reveal = Math.min(0.95, 0.04 + ed * 5.0 + cornerDist(cx, cy) * 0.35 + R() * 0.3);
    const r = 0.022 + R() * 0.04;
    blob(cx, cy, r, reveal, { rough: 0.14 + R() * 0.12 });
    const toC = Math.atan2(0.5 - cy, aspect / 2 - cx);
    const sat = 5 + Math.floor(R() * 8);
    for (let s = 0; s < sat; s++) {
      const ang = toC + (R() - 0.5) * 2.0;
      const dist = r * (0.9 + Math.pow(R(), 0.8) * 1.5);
      const sx = cx + Math.cos(ang) * dist, sy = cy + Math.sin(ang) * dist;
      const sr = r * (0.05 + Math.pow(R(), 2) * 0.22);
      const streak = R() < 0.3;
      blob(sx, sy, sr, Math.min(0.97, reveal + 0.03 + R() * 0.1), streak
        ? { stretch: 1.6 + R() * 1.6, angle: ang, rough: 0.08 }
        : { rough: 0.12 });
    }
  }
  // 2) drips running down from the top edge and from splats in the upper corners
  for (let d = 0; d < 8; d++) {
    const x = R() < 0.5 ? R() * aspect * 0.22 : aspect - R() * aspect * 0.22;
    const len = 0.04 + R() * 0.12;
    const w = 0.004 + R() * 0.006;
    const reveal = 0.15 + R() * 0.5;
    const y0 = R() * 0.04;
    blob(x, y0 + len / 2, w, reveal, { stretch: len / (2 * w), angle: Math.PI / 2 + (R() - 0.5) * 0.08, rough: 0.05, amp: 0.85 });
    blob(x, y0 + len, w * (1.1 + R() * 0.3), reveal, { rough: 0.05 });
  }
  // 3) fine mist near the edges
  for (let m = 0; m < 350; m++) {
    const [x, y] = edgePoint(Math.pow(R(), 2.2) * 0.16);
    const ed = edgeDist(x, y);
    blob(x, y, 0.003 + R() * 0.005, Math.min(0.97, 0.05 + ed * 4 + R() * 0.3), { rough: 0.1, amp: 0.4 + R() * 0.4 });
  }

  // defocus: blood sits on the lens / at the eye, far inside the near focus -> soft edges.
  // 3x separable box blur ~= gaussian; blurring the threshold too makes splats grow from their cores.
  const tmp = new Float32Array(n);
  // sliding-window box blur (O(1) per pixel, clamp-to-edge), horizontal then vertical
  const blur = (f, rad) => {
    const w = 1 / (2 * rad + 1);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let s = 0;
      for (let k = -rad; k <= rad; k++) s += f[row + Math.min(W - 1, Math.max(0, k))];
      for (let x = 0; x < W; x++) {
        tmp[row + x] = s * w;
        s += f[row + Math.min(W - 1, x + rad + 1)] - f[row + Math.max(0, x - rad)];
      }
    }
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let k = -rad; k <= rad; k++) s += tmp[Math.min(H - 1, Math.max(0, k)) * W + x];
      for (let y = 0; y < H; y++) {
        f[y * W + x] = s * w;
        s += tmp[Math.min(H - 1, y + rad + 1) * W + x] - tmp[Math.max(0, y - rad) * W + x];
      }
    }
  };
  for (let i = 0; i < 3; i++) { blur(thick, 3); blur(thr, 3); }

  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = Math.round(Math.min(1, thick[i]) * 255);
    data[i * 4 + 1] = Math.round(thr[i] * 255);
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.flipY = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.name = 'postfx:blood';
  tex.needsUpdate = true;
  return tex;
}

import * as THREE from 'three';
import { hashRng } from './objects.js';

/**
 * Procedural vehicles (low-poly but shaped): Soviet-era sedan, UAZ-style van, 6x6 military truck (canvas /
 * flatbed / tanker) and a city bus. All are emitted into the GeoBuilder in the current frame at
 * (x, y, z, rotY); local axes: +X = front, +Y up, Z = width. Burnt variants use the catalog
 * `car_paint_burnt` material, lose glass/tyres and sag onto their rims.
 *
 * The detail atlas (grilles, lamps, plates) is `env.tex.car`, cells via `env.tex.carCell(name)`; it is
 * bound to the world-owned material 'w:car_details'. Vehicle glass is 'w:car_glass'.
 */

const M4 = () => new THREE.Matrix4();
const tr = (x, y, z, ry = 0) => M4().makeRotationY(ry).setPosition(x, y, z);
const T = (x, y, z) => M4().makeTranslation(x, y, z);

export const SEDAN_PAINTS = ['car_paint', 'car_paint_white', 'car_paint%7a2c24', 'car_paint%b3a68a', 'car_paint%4f5f48', 'car_paint%607f9c', 'car_paint%2e3032', 'car_paint%8a6a3a'];

let TEX = null;
/** Must be called once before building vehicles (gives access to the atlas cells). */
export function initVehicles(tex) { TEX = tex; }

function cellUV(name) {
  const [u0, v0, du, dv] = TEX.carCell(name);
  return [u0, v0, u0 + du, v0, u0 + du, v0 + dv, u0, v0 + dv];
}

/** Axis-aligned textured quad facing +x / -x / +z / -z (frame space). */
function faceQuad(B, mat, face, c, w, h, cell, o = {}) {
  const [x, y, z] = c;
  const hw = w / 2, hh = h / 2;
  let a, b, cc, d;
  if (face === '+x') { a = [x, y - hh, z + hw]; b = [x, y - hh, z - hw]; cc = [x, y + hh, z - hw]; d = [x, y + hh, z + hw]; }
  else if (face === '-x') { a = [x, y - hh, z - hw]; b = [x, y - hh, z + hw]; cc = [x, y + hh, z + hw]; d = [x, y + hh, z - hw]; }
  else if (face === '+z') { a = [x - hw, y - hh, z]; b = [x + hw, y - hh, z]; cc = [x + hw, y + hh, z]; d = [x - hw, y + hh, z]; }
  else { a = [x + hw, y - hh, z]; b = [x - hw, y - hh, z]; cc = [x - hw, y + hh, z]; d = [x + hw, y + hh, z]; }
  B.quad(mat, a, b, cc, d, { uvs: cell ? cellUV(cell) : undefined, uvOff: [0, 0], col: false, shadow: o.shadow ?? false });
}

/** Quad from 4 frame points with atlas uvs (a b c d counter-clockwise seen from the front). */
function quadCell(B, mat, a, b, c, d, cell, o = {}) {
  B.quad(mat, a, b, c, d, { uvs: cell ? cellUV(cell) : undefined, uvOff: [0, 0], col: false, shadow: o.shadow ?? false, ...o });
}

function arch(pts, cx, cy, r, bottom, n = 7) {
  pts.push([cx - r, bottom]);
  for (let i = 0; i <= n; i++) {
    const a = Math.PI - (i / n) * Math.PI;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  pts.push([cx + r, bottom]);
}

/**
 * Wheel at (x, y, z) with its axle along Z (or X with axis:'x'). R tyre radius, w width.
 * o: rim (radius), noTyre, rimMat, seg, burnt
 */
export function wheel(B, x, y, z, R, w, o = {}) {
  const hw = w / 2, ri = o.rim ?? R * 0.58;
  const s = o.side ?? (Math.sign(z) || 1);
  const axisRot = o.axis === 'x' ? M4().makeRotationY(Math.PI / 2) : M4();
  const base = T(x, y, z).multiply(axisRot);
  if (!o.noTyre) {
    const prof = [[ri * 0.98, -hw * 0.9], [R - 0.06, -hw], [R - 0.012, -hw * 0.75], [R, -hw * 0.35], [R, hw * 0.35], [R - 0.012, hw * 0.75], [R - 0.06, hw], [ri * 0.98, hw * 0.9]]
      .map(([a, b]) => new THREE.Vector2(a, b));
    const g = new THREE.LatheGeometry(prof, o.seg ?? 16);
    g.rotateX(Math.PI / 2);
    B.geometry(o.tyreMat || 'rubber', g, base, { col: false, uv: 'proj' });
    g.dispose();
    if (o.tread) {
      // off-road tread: staggered lug blocks around the crown (two offset rows) so the silhouette isn't a smooth disc
      const n = o.treadN ?? 22, pitch = (Math.PI * 2) / n;
      const lug = new THREE.BoxGeometry(0.05, 2 * Math.PI * R / n * 0.52, w * 0.4);
      for (let i = 0; i < n; i++) {
        for (const row of [-1, 1]) {
          const a = i * pitch + (row > 0 ? pitch * 0.5 : 0);
          const m = base.clone().multiply(M4().makeRotationZ(a)).multiply(T(R + 0.008, 0, row * w * 0.22));
          B.geometry(o.tyreMat || 'rubber', lug, m, { col: false, uv: 'proj', shadow: false });
        }
      }
      lug.dispose();
    }
  }
  // rim: dished disc + hub
  const rimMat = o.rimMat || (o.burnt ? 'car_paint_burnt' : 'metal_galvanized');
  const rg = new THREE.CylinderGeometry(ri, ri, w * 0.62, 12, 1, false);
  rg.rotateX(Math.PI / 2);
  B.geometry(rimMat, rg, base.clone().multiply(T(0, 0, -s * 0.015)), { col: false, uv: 'proj' });
  rg.dispose();
  const hg = new THREE.CylinderGeometry(ri * 0.34, ri * 0.4, w * 0.2, 8, 1, false);
  hg.rotateX(Math.PI / 2);
  B.geometry(o.burnt ? 'car_paint_burnt' : 'metal_steel', hg, base.clone().multiply(T(0, 0, s * w * 0.36)), { col: false, uv: 'proj' });
  hg.dispose();
  if (!o.burnt) {
    // rim lip ring + wheel nuts on the rim face
    const faceZ = s * (w * 0.31 - 0.015);
    const lip = new THREE.TorusGeometry(ri * 0.97, Math.max(0.012, ri * 0.06), 4, 18);
    B.geometry(rimMat, lip, base.clone().multiply(T(0, 0, faceZ)), { col: false, uv: 'proj', shadow: false });
    lip.dispose();
    const nutN = o.nuts ?? (R > 0.45 ? 8 : 5);
    const nut = new THREE.CylinderGeometry(ri * 0.055, ri * 0.055, 0.045, 6, 1, false);
    nut.rotateX(Math.PI / 2);
    for (let i = 0; i < nutN; i++) {
      const a = (i / nutN) * Math.PI * 2;
      B.geometry('metal_steel', nut, base.clone().multiply(T(Math.cos(a) * ri * 0.56, Math.sin(a) * ri * 0.56, faceZ + s * 0.02)), { col: false, uv: 'proj', shadow: false });
    }
    nut.dispose();
  }
}

/** Flat disc (atlas mapped) facing +x at c, radius r. */
function lampDisc(B, c, r, cell, face = '+x') {
  const g = new THREE.CircleGeometry(r, 12);
  const [u0, v0, du, dv] = TEX.carCell(cell);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * du, v0 + uv.getY(i) * dv);
  const rot = face === '+x' ? M4().makeRotationY(Math.PI / 2) : face === '-x' ? M4().makeRotationY(-Math.PI / 2) : M4();
  B.geometry('w:car_details', g, T(c[0], c[1], c[2]).multiply(rot), { col: false, uv: 'keep', shadow: false });
  g.dispose();
}

/** Push the body frame for a vehicle; handles roll-over (on its side) / flipped (roof down). */
function pushBody(B, x, y, z, ry, o, halfW, roofH) {
  const m = tr(x, y, z, ry);
  if (o.flip) m.multiply(T(0, roofH, 0)).multiply(M4().makeRotationX(Math.PI));
  else if (o.roll) {
    const s = Math.sign(o.roll);
    m.multiply(T(0, 0, s * halfW)).multiply(M4().makeRotationX(o.roll)).multiply(T(0, 0, -s * halfW));
  }
  if (o.pitch) m.multiply(M4().makeRotationZ(o.pitch));
  B.push(m);
}

// ================================================================================================ sedan
export function sedan(B, x, y, z, ry, o = {}) {
  const r = hashRng(x * 13 + z * 7 + (o.seed || 0));
  const burnt = !!o.burnt;
  const paint = burnt ? 'car_paint_burnt' : (o.paint || SEDAN_PAINTS[Math.floor(r() * SEDAN_PAINTS.length)]);
  const W = 1.62, hw = W / 2;
  const sag = burnt ? 0.12 : 0;
  pushBody(B, x, y, z, ry, o, hw, 1.44);
  B.push(T(0, -sag, 0));
  const part = { matKey: paint, surface: 'metal' };

  // ---- lower body (side profile with wheel arches), bevelled
  const wb = 1.21, ar = 0.355, acy = 0.3;
  const pts = [[-2.03, 0.27]];
  arch(pts, -wb, acy, ar, 0.27);
  arch(pts, wb, acy, ar, 0.27);
  pts.push([2.02, 0.27], [2.075, 0.36], [2.085, 0.64], [2.045, 0.78], [1.97, 0.83], [0.98, 0.915], [-1.3, 0.935], [-1.99, 0.905], [-2.07, 0.86], [-2.085, 0.4]);
  B.extrudeZ(paint, pts, W, { bevel: 0.055, bevelSeg: 2, crease: 0.9 });
  // wheel-well liners (dark) so arches never show daylight through the body
  for (const ax of [-wb, wb]) B.box('rubber', ax, acy + 0.12, 0, ar * 2 - 0.04, 0.3, W - 0.34, { col: false, shadow: false, skip: 8 });

  // ---- greenhouse
  const gw = W - 0.12;
  const taper = (yy) => 1 - 0.16 * THREE.MathUtils.clamp((yy - 0.9) / 0.5, 0, 1);
  const edge = (yy) => (gw / 2) * taper(yy);
  const gh = [[0.99, 0.9], [0.24, 1.39], [-0.84, 1.41], [-1.34, 0.92]];
  if (!burnt) B.extrudeZ('w:car_glass', gh, gw, { bevel: 0.03, taper, crease: 0.5, shadow: true });
  // roof skin
  B.extrudeZ(paint, [[0.3, 1.36], [0.22, 1.405], [-0.84, 1.425], [-0.9, 1.37]], gw * 0.86 + 0.04, { bevel: 0.02, crease: 0.9, col: true });
  // pillars
  for (const s of [-1, 1]) {
    B.cylinder(paint, [0.97, 0.915, s * (edge(0.92) + 0.004)], [0.26, 1.385, s * (edge(1.38) + 0.004)], 0.035, 0.035, 5, { col: false });
    B.cylinder(paint, [-0.28, 0.93, s * (edge(0.93) + 0.004)], [-0.28, 1.4, s * (edge(1.4) + 0.004)], 0.045, 0.04, 4, { col: false });
    // C-pillar sail
    const zb = s * (edge(0.93) + 0.006), zt = s * (edge(1.4) + 0.006);
    const A = [-1.33, 0.925, zb], Bq = [-0.98, 0.935, zb], C = [-0.8, 1.4, zt], D = [-0.86, 1.4, zt];
    if (s > 0) B.quad(paint, A, Bq, C, D, { col: false }); else B.quad(paint, Bq, A, D, C, { col: false });
    // belt weatherstrip
    B.box('rubber', -0.18, 0.925, s * (edge(0.925) + 0.01), 2.25, 0.025, 0.02, { col: false, shadow: false });
  }

  // ---- interior (seen through glass / burnt shell)
  const seat = burnt ? 'rebar_metal' : 'fabric_charcoal';
  for (const [sx, sw] of [[0.1, 0.55], [-0.72, 1.28]]) {
    for (const zz of sw > 1 ? [0] : [-0.36, 0.36]) {
      if (burnt) {
        B.box(seat, sx, 0.5, zz, 0.5, 0.03, sw, { col: false });
        B.box(seat, sx - 0.25, 0.8, zz, 0.03, 0.55, sw, { rot: [0, 0, -0.18], col: false });
      } else {
        B.box(seat, sx, 0.5, zz, 0.5, 0.14, sw, { col: false, shadow: false });
        B.box(seat, sx - 0.24, 0.8, zz, 0.12, 0.56, sw, { rot: [0, 0, -0.16], col: false, shadow: false });
      }
    }
  }
  B.box(burnt ? 'car_paint_burnt' : 'rubber', 0.72, 0.9, 0, 0.35, 0.18, W - 0.3, { col: false, shadow: false });
  if (!burnt) {
    const tw = new THREE.TorusGeometry(0.18, 0.018, 4, 14);
    B.geometry('rubber', tw, T(0.5, 0.98, -0.36).multiply(M4().makeRotationY(Math.PI / 2)).multiply(M4().makeRotationX(0.45)), { col: false, shadow: false });
    tw.dispose();
  }
  B.box(burnt ? 'scorched_ground' : 'rubber', -0.3, 0.36, 0, 2.3, 0.02, W - 0.2, { col: false, shadow: false });

  // ---- fascias, bumpers, trim
  faceQuad(B, 'w:car_details', '+x', [2.089, 0.585, 0], 1.46, 0.36, burnt ? 'burntFront' : 'sedanFront');
  if (burnt) faceQuad(B, 'w:car_details', '-x', [-2.089, 0.68, 0], 1.46, 0.34, 'burntRear');
  else {
    for (const s of [-1, 1]) faceQuad(B, 'w:car_details', '-x', [-2.089, 0.7, s * 0.52], 0.42, 0.26, s > 0 ? 'tailR' : 'tailL');
    faceQuad(B, 'w:car_details', '-x', [-2.089, 0.58, 0], 0.4, 0.11, 'plate');
  }
  const bump = burnt ? 'car_paint_burnt' : 'metal_steel';
  B.box(bump, 2.12, 0.38, 0, 0.07, 0.1, W + 0.04, { col: false });
  if (burnt && r() < 0.5) B.box(bump, -2.08, 0.2, 0.2, 0.07, 0.1, W + 0.04, { rot: [0.35, 0.15, 0.2], col: false });
  else B.box(bump, -2.12, 0.4, 0, 0.07, 0.1, W + 0.04, { col: false });
  for (const s of [-1, 1]) {
    const zs = s * (hw + 0.002);
    for (const dx of [0.93, -0.3, -1.28]) B.box('rubber', dx, 0.62, zs, 0.005, 0.56, 0.003, { col: false, shadow: false });
    B.box(burnt ? 'car_paint_burnt' : 'rubber', -0.1, 0.6, s * (hw + 0.006), 3.6, 0.022, 0.01, { col: false, shadow: false });
    if (!burnt) {
      for (const dx of [0.36, -0.62]) B.box('metal_steel', dx, 0.83, s * (hw + 0.012), 0.12, 0.025, 0.02, { col: false, shadow: false });
      B.box(paint, 0.86, 1.0, s * (hw + 0.09), 0.05, 0.08, 0.14, { col: false });
      B.box('rubber', 0.9, 0.955, s * (hw + 0.02), 0.03, 0.04, 0.06, { col: false, shadow: false });
    }
  }
  // hood / trunk shut lines
  B.box('rubber', 0.975, 0.918, 0, 0.012, 0.004, W - 0.25, { col: false, shadow: false });
  B.box('rubber', -1.3, 0.936, 0, 0.012, 0.004, W - 0.25, { col: false, shadow: false });
  if (!burnt) {
    // wipers + antenna
    for (const zz of [-0.35, 0.15]) B.box('rubber', 1.02, 0.93, zz, 0.03, 0.015, 0.42, { rot: [0, 0.25, 0], col: false, shadow: false });
    if (r() < 0.5) B.cylinder('metal_steel', [1.6, 0.86, -0.6], [1.45, 1.6, -0.62], 0.004, 0.003, 3, { col: false, shadow: false });
  }
  B.pop();

  // ---- wheels
  for (const ax of [-wb, wb]) {
    for (const s of [-1, 1]) {
      if (burnt) wheel(B, ax, 0.17, s * (hw - 0.14), 0.17, 0.15, { noTyre: true, rim: 0.17, burnt: true, side: s });
      else wheel(B, ax, 0.29, s * (hw - 0.13), 0.29, 0.17, { rim: 0.165, side: s, seg: 14 });
    }
  }
  // cabin movement blocker (burnt shell has no glass)
  if (burnt) B.colBox(-0.2, 1.1, 0, 2.2, 0.5, W - 0.2, part, { ray: false, move: true });
  B.pop();
}

// ================================================================================================ van
export function van(B, x, y, z, ry, o = {}) {
  const burnt = !!o.burnt;
  const paint = burnt ? 'car_paint_burnt' : (o.paint || 'metal_painted');
  const W = 1.94, hw = W / 2;
  const sag = burnt ? 0.16 : 0;
  pushBody(B, x, y, z, ry, o, hw, 2.1);
  B.push(T(0, -sag, 0));
  const fa = 1.25, ra = -1.05, ar = 0.46, acy = 0.4;
  const pts = [[-2.15, 0.4]];
  arch(pts, ra, acy, ar, 0.4);
  arch(pts, fa, acy, ar, 0.4);
  pts.push([2.15, 0.4], [2.2, 0.52], [2.21, 1.06], [2.12, 1.3], [1.78, 1.95], [1.52, 2.08], [-1.92, 2.1], [-2.16, 1.94], [-2.19, 0.5]);
  B.extrudeZ(paint, pts, W, { bevel: 0.11, bevelSeg: 3, crease: 1.1 });
  for (const ax of [ra, fa]) B.box('rubber', ax, acy + 0.15, 0, ar * 2 - 0.04, 0.34, W - 0.4, { col: false, shadow: false, skip: 8 });
  const glass = burnt ? 'rubber' : 'w:car_glass';
  for (const s of [-1, 1]) {
    const zz = s * (hw + 0.004);
    const face = s > 0 ? '+z' : '-z';
    faceQuad(B, glass, face, [1.28, 1.62, zz], 0.5, 0.46, null);
    for (const cx of [0.42, -0.36, -1.14]) faceQuad(B, glass, face, [cx, 1.62, zz], 0.62, 0.4, null);
    for (const cx of [1.6, 0.9, -1.55]) B.box('rubber', cx, 1.1, zz, 0.01, 1.4, 0.006, { col: false, shadow: false });
    if (!burnt) B.box(paint, 1.7, 1.55, s * (hw + 0.14), 0.04, 0.2, 0.12, { col: false });
  }
  // windscreen (two panes on the slope)
  {
    const n = new THREE.Vector3(0.67, 0.34, 0).normalize().multiplyScalar(0.006);
    for (const [z0, z1] of [[0.06, 0.82], [-0.82, -0.06]]) {
      const a = [2.08 + n.x, 1.36 + n.y, z1], b = [2.08 + n.x, 1.36 + n.y, z0], c = [1.8 + n.x, 1.9 + n.y, z0], d = [1.8 + n.x, 1.9 + n.y, z1];
      B.quad(glass, a, b, c, d, { col: false, shadow: false });
    }
  }
  faceQuad(B, 'w:car_details', '+x', [2.216, 0.82, 0], 1.7, 0.56, burnt ? 'burntFront' : 'vanFront');
  faceQuad(B, glass, '-x', [-2.195, 1.62, 0.42], 0.6, 0.4, null);
  faceQuad(B, glass, '-x', [-2.195, 1.62, -0.42], 0.6, 0.4, null);
  B.box(burnt ? 'car_paint_burnt' : 'metal_painted#dark', 2.26, 0.5, 0, 0.08, 0.14, W - 0.1, { col: false });
  B.box(burnt ? 'car_paint_burnt' : 'metal_painted#dark', -2.24, 0.5, 0, 0.08, 0.14, W - 0.1, { col: false });
  B.box(burnt ? 'scorched_ground' : 'rubber', 0, 0.62, 0, 4.0, 0.02, W - 0.2, { col: false, shadow: false });
  B.pop();
  for (const ax of [ra, fa]) {
    for (const s of [-1, 1]) {
      if (burnt) wheel(B, ax, 0.22, s * (hw - 0.17), 0.22, 0.18, { noTyre: true, rim: 0.22, burnt: true, side: s });
      else wheel(B, ax, 0.39, s * (hw - 0.17), 0.39, 0.22, { rim: 0.2, side: s });
    }
  }
  B.pop();
}

// ================================================================================================ truck
/**
 * 6x6 military truck. o: burnt, canvas (default true), tank (fuel tanker body), paint
 */
export function truck(B, x, y, z, ry, o = {}) {
  const burnt = !!o.burnt;
  const paint = burnt ? 'car_paint_burnt' : (o.paint || 'metal_painted');
  const dark = burnt ? 'car_paint_burnt' : 'metal_gun_black';
  const W = 2.5;
  const R = 0.56, rimR = 0.3;
  const sag = burnt ? R - rimR : 0;
  const wz = 1.0;
  pushBody(B, x, y, z, ry, o, W / 2, 3.1);
  B.push(T(0, -sag, 0));
  const part = { matKey: paint, surface: 'metal' };
  // ---- chassis
  for (const s of [-1, 1]) B.box(dark, -0.05, 0.98, s * 0.48, 7.1, 0.24, 0.1);
  for (const cx of [-3.3, -1.85, -0.3, 1.3, 3.1]) B.box(dark, cx, 0.98, 0, 0.1, 0.18, 0.9, { col: false });
  // axles / diffs
  for (const ax of [2.3, -1.15, -2.55]) {
    B.cylinder(dark, [ax, R, -wz + 0.2], [ax, R, wz - 0.2], 0.07, 0.07, 6, { col: false });
    B.box(dark, ax, R, 0, 0.36, 0.3, 0.36, { col: false });
  }
  // ---- front: bumper, hood, grille, fenders, lamps
  B.box(paint, 3.56, 0.98, 0, 0.18, 0.3, 2.34);
  for (const s of [-1, 1]) B.box(dark, 3.68, 0.9, s * 0.7, 0.1, 0.08, 0.16, { col: false });
  B.extrudeZ(paint, [[1.62, 1.22], [3.46, 1.22], [3.5, 1.3], [3.5, 1.92], [3.38, 2.02], [1.62, 2.1]], 1.18, { bevel: 0.05, crease: 0.9 });
  faceQuad(B, 'w:car_details', '+x', [3.506, 1.6, 0], 0.98, 0.56, burnt ? 'burntFront' : 'truckGrille');
  for (const s of [-1, 1]) {
    const fz = s * 0.97;
    {
      const fp = [];
      const ro = R + 0.16, ri2 = R + 0.11, cx = 2.3, cy = R;
      const a0 = 0.28, a1 = Math.PI - 0.05;
      for (let i = 0; i <= 10; i++) { const a = a0 + (a1 - a0) * i / 10; fp.push([cx + Math.cos(a) * ro, cy + Math.sin(a) * ro]); }
      fp.push([1.72, cy + Math.sin(a1) * ro + 0.02], [1.72, cy + Math.sin(a1) * ri2 - 0.02]);
      for (let i = 10; i >= 0; i--) { const a = a0 + (a1 - a0) * i / 10; fp.push([cx + Math.cos(a) * ri2, cy + Math.sin(a) * ri2]); }
      B.extrudeZ(paint, fp, 0.6, { bevel: 0.015, crease: 0.8, matrix: T(0, 0, fz) });
      B.box(paint, 1.9, 1.37, fz, 0.36, 0.05, 0.6);
    }
    // inner fender skirt
    B.box(dark, 2.45, 1.35, s * 0.62, 1.5, 0.5, 0.04, { col: false, shadow: false });
    // headlamp pod on the fender
    B.cylinder(paint, [3.2, 1.78, fz], [3.36, 1.78, fz], 0.13, 0.12, 10, { caps: true, col: false });
    lampDisc(B, [3.365, 1.78, fz], 0.105, burnt ? 'burntFront' : 'headLamp');
  }
  // ---- cab
  B.extrudeZ(paint, [[0.3, 1.22], [1.66, 1.22], [1.68, 2.2], [1.6, 2.86], [1.48, 2.92], [0.36, 2.92], [0.3, 2.82]], 2.32, { bevel: 0.06, crease: 0.9 });
  const glass = burnt ? 'rubber' : 'w:car_glass';
  {
    const n = [0.99, 0.12];
    for (const [z0, z1] of [[0.07, 1.02], [-1.02, -0.07]]) {
      const a = [1.685 + n[0] * 0.006, 2.25, z1], b = [1.685 + n[0] * 0.006, 2.25, z0], c = [1.615 + 0.006, 2.8, z0], d = [1.615 + 0.006, 2.8, z1];
      B.quad(glass, a, b, c, d, { col: false, shadow: false });
    }
  }
  for (const s of [-1, 1]) {
    const face = s > 0 ? '+z' : '-z';
    const zz = s * 1.165;
    faceQuad(B, glass, face, [1.0, 2.5, zz], 0.85, 0.52, null);
    B.box('rubber', 0.45, 1.8, zz, 0.01, 1.1, 0.006, { col: false, shadow: false });
    B.box('rubber', 1.56, 1.8, zz, 0.01, 1.1, 0.006, { col: false, shadow: false });
    B.box('metal_steel', 0.62, 2.05, s * 1.172, 0.14, 0.03, 0.02, { col: false, shadow: false });
    // door skin detail: proud window frame, lower door seam, stamped reinforcement rib, hinges
    const fz2 = s * 1.172;
    B.box(paint, 1.0, 2.79, fz2, 0.95, 0.06, 0.025, { col: false, shadow: false });
    B.box(paint, 1.0, 2.21, fz2, 0.95, 0.06, 0.025, { col: false, shadow: false });
    B.box(paint, 0.545, 2.5, fz2, 0.05, 0.64, 0.025, { col: false, shadow: false });
    B.box(paint, 1.455, 2.5, fz2, 0.05, 0.64, 0.025, { col: false, shadow: false });
    B.box('rubber', 1.0, 1.27, zz, 1.12, 0.012, 0.006, { col: false, shadow: false });
    B.box(paint, 1.0, 1.72, s * 1.176, 0.86, 0.035, 0.03, { col: false, shadow: false });
    for (const hy of [1.55, 2.3]) B.box(dark, 1.535, hy, s * 1.18, 0.05, 0.12, 0.03, { col: false, shadow: false });
    // steps
    B.box(dark, 1.0, 0.82, s * 1.05, 0.5, 0.04, 0.24, { col: false });
    // mirror on arm
    if (!burnt) {
      B.cylinder('metal_galvanized', [1.62, 2.4, zz], [1.75, 2.45, s * 1.45], 0.015, 0.015, 4, { col: false });
      B.box('rubber', 1.76, 2.45, s * 1.47, 0.04, 0.3, 0.18, { col: false });
    }
  }
  B.box(dark, 0.98, 2.95, 0, 0.9, 0.05, 1.9, { col: false });
  // sun visor over the windscreen + roof marker lamps + drip rails
  if (!burnt) {
    B.box(paint, 1.72, 2.9, 0, 0.26, 0.03, 2.2, { rot: [0, 0, -0.18], col: false });
    for (const lz of [-0.6, 0, 0.6]) B.box('metal_painted#yellow', 1.52, 2.97, lz, 0.06, 0.05, 0.1, { col: false, shadow: false });
  }
  for (const s of [-1, 1]) B.box(dark, 0.95, 2.9, s * 1.17, 1.3, 0.025, 0.03, { col: false, shadow: false });
  faceQuad(B, glass, '-x', [0.296, 2.5, 0], 1.1, 0.34, null);
  // ---- behind the cab: spare wheel, fuel tank, battery box
  if (!burnt) wheel(B, 0.05, 2.0, 0, R, 0.4, { axis: 'x', rim: rimR, side: 1, rimMat: paint, tread: true });
  else wheel(B, 0.05, 1.8, 0, rimR, 0.3, { axis: 'x', noTyre: true, rim: rimR, burnt: true, side: 1 });
  B.cylinder(paint, [-0.5, 1.05, 1.0], [0.25, 1.05, 1.0], 0.28, 0.28, 12, { caps: true });
  B.box(dark, -0.1, 1.05, -1.0, 0.6, 0.4, 0.4);

  // ---- rear body
  if (o.tank) {
    const tm = burnt ? 'car_paint_burnt' : (o.tankMat || 'car_paint%8e897c');
    const tg = new THREE.CylinderGeometry(1.0, 1.0, 3.7, 20, 1, false);
    tg.rotateZ(Math.PI / 2);
    tg.scale(1, 0.92, 1.12);
    B.geometry(tm, tg, T(-1.95, 2.35, 0), { uv: 'proj' });
    tg.dispose();
    for (const front of [false, true]) {
      const cap = new THREE.SphereGeometry(1.0, 20, 5, 0, Math.PI * 2, 0, Math.PI / 2);
      cap.scale(1, 0.22, 1);
      cap.rotateZ(front ? -Math.PI / 2 : Math.PI / 2);
      cap.scale(1, 0.92, 1.12);
      B.geometry(tm, cap, T(front ? -0.1 : -3.8, 2.35, 0), { uv: 'proj' });
      cap.dispose();
    }
    // weld seams / bands
    for (const bx of [-3.3, -1.95, -0.6]) {
      const band = new THREE.CylinderGeometry(1.012, 1.012, 0.06, 20, 1, true);
      band.rotateZ(Math.PI / 2); band.scale(1, 0.92, 1.12);
      B.geometry(dark, band, T(bx, 2.35, 0), { uv: 'proj', col: false });
      band.dispose();
    }
    for (const sx of [-3.3, -1.95, -0.6]) B.box(dark, sx, 1.35, 0, 0.18, 0.3, 1.9);
    // walkway, hatch, handrail, ladder, rear valves, hazard plate
    B.box('metal_tread_plate', -1.95, 3.29, 0, 3.0, 0.04, 0.55);
    B.cylinder(tm, [-1.95, 3.2, 0], [-1.95, 3.42, 0], 0.28, 0.28, 12, { caps: true, col: false });
    for (const s of [-1, 1]) {
      B.cylinder('metal_galvanized', [-3.4, 3.62, s * 0.3], [-0.5, 3.62, s * 0.3], 0.02, 0.02, 4, { col: false });
      for (const sx of [-3.4, -2.4, -1.4, -0.5]) B.cylinder('metal_galvanized', [sx, 3.3, s * 0.3], [sx, 3.62, s * 0.3], 0.018, 0.018, 4, { col: false });
    }
    for (let i = 0; i < 8; i++) B.box('metal_galvanized', -4.02, 1.3 + i * 0.3, 0.55, 0.03, 0.03, 0.4, { col: false });
    for (const s of [-1, 1]) B.box('metal_galvanized', -4.02, 2.3, 0.55 + s * 0.2, 0.03, 2.2, 0.03, { col: false });
    B.cylinder('metal_painted#dark', [-4.1, 1.2, -0.5], [-4.1, 1.2, 0.3], 0.07, 0.07, 8, { caps: true, col: false });
    B.box('metal_painted#yellow', -3.9, 1.3, -0.65, 0.05, 0.12, 0.2, { col: false });
  } else {
    const bedMat = burnt ? 'car_paint_burnt' : 'painted_wood';
    for (const s of [-1, 1]) B.box(dark, -1.75, 1.25, s * 0.5, 3.9, 0.3, 0.14);
    for (const sx of [-3.4, -2.5, -1.6, -0.7, 0.1]) B.box(dark, sx, 1.34, 0, 0.1, 0.12, 2.3, { col: false });
    B.box(burnt ? 'car_paint_burnt' : 'wood_planks', -1.75, 1.46, 0, 3.95, 0.1, 2.44);
    const sides = burnt ? [[1, 0.65], [-1, 0.25]] : [[1, 0.65], [-1, 0.65]];
    for (const [s, h] of sides) B.box(bedMat, -1.75, 1.51 + h / 2, s * 1.2, 3.95, h, 0.06, { uv: 'face' });
    B.box(bedMat, -3.7, 1.83, 0, 0.06, 0.65, 2.44, { uv: 'face' });
    B.box(bedMat, 0.2, 1.83, 0, 0.06, 0.65, 2.44, { uv: 'face' });
    // stakes
    for (const sx of [-3.55, -2.3, -1.05, 0.1]) for (const s of [-1, 1]) B.box(dark, sx, 1.84, s * 1.235, 0.06, 0.68, 0.03, { col: false });
    if (o.canvas !== false) canvasCover(B, burnt, part);
  }
  // rear lamps, mud flaps, tow hitch
  for (const s of [-1, 1]) {
    faceQuad(B, 'w:car_details', '-x', [-3.76, 1.05, s * 0.95], 0.26, 0.13, burnt ? 'burntRear' : 'tailLamp');
    B.box('rubber', -3.1, 0.55, s * wz, 0.02, 0.55, 0.42, { col: false });
    B.box('rubber', 1.72, 0.7, s * wz, 0.02, 0.5, 0.42, { col: false });
  }
  faceQuad(B, 'w:car_details', '-x', [-3.76, 1.25, 0], 0.5, 0.13, 'plate');
  B.box(dark, -3.72, 0.9, 0, 0.12, 0.22, 0.3, { col: false });
  B.pop();
  // ---- wheels (dual rear tandem)
  for (const ax of [2.3, -1.15, -2.55]) {
    for (const s of [-1, 1]) {
      if (burnt) wheel(B, ax, rimR, s * wz, rimR, 0.3, { noTyre: true, rim: rimR, burnt: true, side: s });
      else wheel(B, ax, R, s * wz, R, 0.42, { rim: rimR, side: s, seg: 18, rimMat: paint, tread: true });
    }
  }
  B.pop();
}

/** Arched canvas cover over the truck bed with sag between bows; burnt: bare bent bows only. */
function canvasCover(B, burnt, part) {
  const x0 = -3.7, x1 = 0.15, bows = 4;
  const prof = [];
  const hw = 1.23, yb = 2.12, yt = 3.12, rs = 0.34;
  prof.push([-hw, yb]);
  prof.push([-hw, yt - rs]);
  for (let i = 1; i <= 4; i++) { const a = Math.PI - (i / 4) * (Math.PI / 2); prof.push([-hw + rs + Math.cos(a) * rs, yt - rs + Math.sin(a) * rs]); }
  for (let i = 0; i <= 4; i++) { const a = Math.PI / 2 - (i / 4) * (Math.PI / 2); prof.push([hw - rs + Math.cos(a) * rs, yt - rs + Math.sin(a) * rs]); }
  prof.push([hw, yb]);
  if (burnt) {
    for (let b = 0; b <= bows; b++) {
      const bx = x0 + 0.1 + (x1 - x0 - 0.2) * b / bows;
      if (b === 2) continue;
      const pts = prof.map(([zz, yy], k) => new THREE.Vector3(bx + (k > 4 && b === 3 ? 0.15 : 0), yy - (b === 1 && k > 2 && k < 9 ? 0.35 * Math.sin((k - 2) / 6 * Math.PI) : 0), zz));
      B.tube('rebar_metal', pts, 0.025, 4, { col: false });
    }
    return;
  }
  // canvas surface: nx columns along x, profile rows
  const nx = 24;
  const pos = [], idx = [], uv = [];
  const plen = [0];
  for (let k = 1; k < prof.length; k++) plen.push(plen[k - 1] + Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]));
  for (let i = 0; i <= nx; i++) {
    const t = i / nx;
    const xx = x0 + (x1 - x0) * t;
    const between = Math.abs(Math.sin(t * bows * Math.PI));
    for (let k = 0; k < prof.length; k++) {
      const [zz, yy] = prof[k];
      const top = yy > yt - rs - 0.01;
      const sag = (top ? 0.07 : 0.035) * between;
      const inward = top ? 0 : Math.sign(zz) * -sag * 0.6;
      pos.push(xx, yy - (top ? sag : sag * 0.3), zz + inward);
      uv.push(xx, plen[k]);
    }
  }
  const np = prof.length;
  for (let i = 0; i < nx; i++) for (let k = 0; k < np - 1; k++) {
    const a = i * np + k, b = a + np;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  B.geometry('tarp', g, null, { uv: 'keep' });
  g.dispose();
  // front panel (against the cab) and a half-rolled rear flap
  const front = prof.map(([zz, yy]) => [zz, yy]);
  const shape = new THREE.Shape(front.map(([a, b]) => new THREE.Vector2(a, b)));
  const sg = new THREE.ShapeGeometry(shape);
  sg.rotateY(-Math.PI / 2);
  B.geometry('tarp', sg, T(x1, 0, 0), { uv: 'proj' });
  sg.dispose();
  const flap = new THREE.PlaneGeometry(hw * 2 - 0.1, 0.5, 6, 1);
  flap.rotateY(-Math.PI / 2);
  B.geometry('tarp', flap, T(x0 - 0.01, yt - 0.25, 0), { uv: 'proj', col: false });
  flap.dispose();
  B.cylinder('tarp', [x0 - 0.05, yt - 0.52, -hw + 0.1], [x0 - 0.05, yt - 0.52, hw - 0.1], 0.08, 0.08, 8, { caps: true, col: false });
  // tie-down ropes
  for (let s = -1; s <= 1; s += 2) for (let b = 0; b < 6; b++) {
    const bx = x0 + 0.3 + b * 0.62;
    B.cylinder('rope', [bx, yb + 0.02, s * (hw + 0.01)], [bx + 0.02, 1.62, s * 1.24], 0.008, 0.008, 3, { col: false, shadow: false });
  }
  void part;
}

// ================================================================================================ bus
/** City bus (burnt shell by default). */
export function bus(B, x, y, z, ry, o = {}) {
  const burnt = o.burnt !== false;
  const paint = burnt ? 'car_paint_burnt' : (o.paint || 'car_paint%b8902a');
  const L = 7.4, W = 2.44, hw = W / 2;
  const hl = L / 2;
  const sag = burnt ? 0.22 : 0;
  const r = hashRng(x * 3.1 + z * 1.7);
  pushBody(B, x, y, z, ry, o, hw, 3.0);
  B.push(T(0, -sag, 0).multiply(M4().makeRotationX(o.tilt || 0)));
  const part = { matKey: paint, surface: 'metal' };
  const fa = 2.25, ra = -1.45, ar = 0.6, acy = 0.52;
  const pts = [[-hl + 0.05, 0.42]];
  arch(pts, ra, acy, ar, 0.42);
  arch(pts, fa, acy, ar, 0.42);
  pts.push([hl - 0.05, 0.42], [hl + 0.02, 0.55], [hl + 0.02, 1.25], [-hl - 0.02, 1.25], [-hl - 0.02, 0.5]);
  B.extrudeZ(paint, pts, W, { bevel: 0.06, crease: 0.9 });
  // belt rail
  for (const s of [-1, 1]) B.box(paint, 0, 1.28, s * (hw - 0.03), L, 0.08, 0.08);
  B.box(paint, hl - 0.03, 1.28, 0, 0.08, 0.08, W);
  B.box(paint, -hl + 0.03, 1.28, 0, 0.08, 0.08, W);
  // window pillars
  const nWin = 6;
  const glass = burnt ? null : 'w:car_glass';
  for (let i = 0; i <= nWin; i++) {
    const px = -hl + 0.2 + (L - 0.4) * i / nWin;
    for (const s of [-1, 1]) {
      const bent = burnt && r() < 0.15;
      B.box(paint, px, 1.8, s * (hw - 0.04), 0.12, 1.05, 0.07, { rot: bent ? [s * 0.12, 0, 0.1] : [0, 0, 0], col: false });
      if (glass && i < nWin) faceQuad(B, glass, s > 0 ? '+z' : '-z', [px + (L - 0.4) / nWin / 2, 1.8, s * (hw - 0.02)], (L - 0.4) / nWin - 0.14, 0.95, null);
    }
  }
  // front/rear frames
  for (const fx of [hl - 0.03, -hl + 0.03]) {
    for (const zz of [-hw + 0.06, 0, hw - 0.06]) B.box(paint, fx, 1.8, zz, 0.07, 1.05, 0.1, { col: false });
    B.box(paint, fx, 2.3, 0, 0.07, 0.1, W);
  }
  faceQuad(B, 'w:car_details', '+x', [hl + 0.035, 0.85, 0], 2.0, 0.5, burnt ? 'burntFront' : 'sedanFront');
  faceQuad(B, 'w:car_details', '-x', [-hl - 0.035, 0.85, 0], 2.0, 0.5, burnt ? 'burntRear' : 'sedanRear');
  // roof: arched shell in segments; burnt: some panels gone (ribs remain), sag in the middle
  const prof = [[-hw, 2.33], [-hw + 0.08, 2.6], [-hw + 0.45, 2.78], [hw - 0.45, 2.78], [hw - 0.08, 2.6], [hw, 2.33]];
  const nSeg = 7;
  for (let k = 0; k < nSeg; k++) {
    const sx0 = -hl + (L * k) / nSeg, sx1 = -hl + (L * (k + 1)) / nSeg;
    const mid = 1 - Math.abs((k + 0.5) / nSeg - 0.5) * 2;
    const drop = burnt ? 0.18 * mid : 0;
    const gone = burnt && (k === 3 || k === 4 && r() < 0.5 || k === 1 && r() < 0.3);
    if (!gone) {
      const ring = prof.map(([zz, yy]) => [zz, yy - drop * (yy > 2.5 ? 1 : 0.3)]);
      const outer = ring.map(([zz, yy]) => new THREE.Vector2(zz, yy));
      const inner = ring.slice().reverse().map(([zz, yy]) => new THREE.Vector2(zz * 0.97, yy - 0.05));
      B.extrudeX(paint, [...outer, ...inner].map((v) => [v.x, v.y]), sx0, sx1 - sx0 + 0.005, null, { col: k % 2 === 0 });
    } else {
      for (let rb = 0; rb < 3; rb++) {
        const rx = sx0 + (sx1 - sx0) * (rb + 0.5) / 3;
        const pts3 = prof.map(([zz, yy]) => new THREE.Vector3(rx, yy - drop - (rb === 1 ? 0.12 : 0) * (yy > 2.5 ? 1 : 0), zz));
        B.tube('rebar_metal', pts3, 0.03, 4, { col: false });
      }
    }
  }
  // wheel housings + floor + seats
  for (const ax of [ra, fa]) B.box(burnt ? 'car_paint_burnt' : 'rubber', ax, acy + 0.2, 0, ar * 2 - 0.02, 0.5, W - 0.08, { col: false, skip: 8 });
  B.box(burnt ? 'car_paint_burnt' : 'rubber', 0, 0.76, 0, L - 0.2, 0.06, W - 0.16, { col: false });
  for (let i = 0; i < 7; i++) {
    const sx = -hl + 1.0 + i * 0.85;
    if (sx > fa - 0.8 && sx < fa + 0.8) continue;
    for (const s of [-1, 1]) {
      const sm = burnt ? 'rebar_metal' : 'fabric_charcoal';
      B.box(sm, sx, 1.18, s * 0.72, 0.42, 0.04, 0.82, { col: false });
      B.box(sm, sx - 0.2, 1.45, s * 0.72, 0.04, 0.55, 0.82, { rot: [0, 0, -0.12], col: false });
      B.box(sm, sx, 0.95, s * 0.72, 0.05, 0.45, 0.05, { col: false });
    }
  }
  B.box(burnt ? 'car_paint_burnt' : 'metal_steel', hl + 0.08, 0.5, 0, 0.1, 0.2, W - 0.1, { col: false });
  B.box(burnt ? 'car_paint_burnt' : 'metal_steel', -hl - 0.08, 0.5, 0, 0.1, 0.2, W - 0.1, { col: false });
  // movement blocker for the upper shell (open windows would otherwise let players inside)
  B.colBox(0, 1.9, 0, L, 1.2, W, part, { ray: false, move: true });
  B.pop();
  for (const ax of [ra, fa]) {
    for (const s of [-1, 1]) {
      if (burnt) wheel(B, ax, 0.3, s * (hw - 0.22), 0.3, 0.25, { noTyre: true, rim: 0.3, burnt: true, side: s });
      else wheel(B, ax, 0.52, s * (hw - 0.22), 0.52, 0.3, { rim: 0.28, side: s });
    }
  }
  B.pop();
}

/** Legacy name used by the dressing code. */
export const car = sedan;

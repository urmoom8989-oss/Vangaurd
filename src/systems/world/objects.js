import * as THREE from 'three';

/**
 * Procedural set-dressing objects. Each function emits into the GeoBuilder in the CURRENT frame at a
 * local transform (x, y, z, rotY). All objects are built around their base center.
 * Returns ledge descriptors where the object is mantle-able.
 */

const M4 = () => new THREE.Matrix4();
function tr(x, y, z, ry = 0) { return M4().makeRotationY(ry).setPosition(x, y, z); }

export function hashRng(seed) {
  let s = (Math.floor(Math.abs(seed) * 9301 + 49297) % 233280) + 1;
  return () => { s = (s * 16807) % 2147483647; return (s % 100000) / 100000; };
}

// ------------------------------------------------------------------------------------------ barriers
export function jerseyBarrier(B, x, y, z, ry, o = {}) {
  const prof = [[-0.3, 0], [0.3, 0], [0.3, 0.075], [0.19, 0.33], [0.075, 0.81], [-0.075, 0.81], [-0.19, 0.33], [-0.3, 0.075]];
  B.push(tr(x, y, z, ry));
  B.extrudeX(o.mat || 'concrete_wall', prof, -1.5, 3.0, null, { uvOff: [x * 0.37, z * 0.21] });
  // lifting loops
  B.box('metal_rusted', -0.9, 0.84, 0, 0.12, 0.06, 0.03, { col: false });
  B.box('metal_rusted', 0.9, 0.84, 0, 0.12, 0.06, 0.03, { col: false });
  B.pop();
  return { len: 3.0, height: 0.81 + y };
}

export function hescoLine(B, x, y, z, ry, n, o = {}) {
  const s = 1.07;
  B.push(tr(x, y, z, ry));
  const r = hashRng(x * 3 + z);
  for (let i = 0; i < n; i++) {
    const cx = (i - (n - 1) / 2) * s;
    const h = s * (o.double && i % 3 !== 1 ? 2 : 1);
    const slump = r() * 0.06;
    B.box('w:hesco', cx, h / 2 - slump / 2, 0, s - 0.02, h - slump, s - 0.02, { uv: 'face', skip: 8 | 4, uvScale: 1 / 1.07 });
    // fill on top
    B.box('dirt', cx, h - slump - 0.06, 0, s - 0.08, 0.08, s - 0.08, { col: false, skip: 8 });
    // top wire rim
    for (const [dx, dz, sx, sz] of [[0, s / 2 - 0.01, s, 0.02], [0, -s / 2 + 0.01, s, 0.02], [s / 2 - 0.01, 0, 0.02, s], [-s / 2 + 0.01, 0, 0.02, s]]) {
      B.box('metal_galvanized', cx + dx, h - slump + 0.005, dz, sx, 0.02, sz, { col: false, shadow: false });
    }
  }
  B.pop();
}

export function sandbagWall(env, x, y, z, ry, len, rows, o = {}) {
  const { props, B } = env;
  const bag = 0.55, h = 0.125;
  const frame = new THREE.Matrix4().multiplyMatrices(B.frame, tr(x, y, z, ry));
  const r = hashRng(x * 7.1 + z * 3.3);
  const depthRows = o.thick ? 2 : 1;
  for (let row = 0; row < rows; row++) {
    const n = Math.max(1, Math.round(len / bag));
    const off = (row % 2) * bag * 0.5;
    for (let dr = 0; dr < depthRows; dr++) {
      for (let i = 0; i < n; i++) {
        const u = -len / 2 + (i + 0.5) * (len / n) + (row % 2 ? off * 0.5 : 0) - (row % 2 ? bag * 0.25 : 0);
        if (Math.abs(u) > len / 2) continue;
        if (row === rows - 1 && o.ragged && r() < 0.25) continue;
        const zz = (dr - (depthRows - 1) / 2) * 0.32 + (r() - 0.5) * 0.03;
        props.place('sandbag', u, 0.07 + row * h, zz, (r() - 0.5) * 0.12, [len / n / bag * (0.95 + r() * 0.1), 1 + (r() - 0.5) * 0.15, 1], { frame, tilt: [(r() - 0.5) * 0.08, (r() - 0.5) * 0.08] });
      }
    }
  }
  const H = rows * h + 0.04;
  props.colBox('sandbag', new THREE.Matrix4().multiplyMatrices(frame, tr(0, H / 2, 0)), len, H, 0.32 * depthRows + 0.02);
  return H;
}

export function razorWire(B, x, y, z, ry, len, o = {}) {
  B.push(tr(x, y, z, ry));
  const R = o.r || 0.42;
  const pitch = 0.16;
  const loops = Math.floor(len / pitch);
  const pts = [];
  const seg = 10;
  for (let i = 0; i <= loops * seg; i++) {
    const t = i / seg;
    const a = t * Math.PI * 2;
    const wob = 1 + 0.08 * Math.sin(t * 1.7) + 0.05 * Math.sin(t * 5.3);
    pts.push(new THREE.Vector3(-len / 2 + t * pitch + Math.sin(a) * 0.05, R + Math.cos(a) * R * wob * 0.92, Math.sin(a) * R * wob));
  }
  B.tube('metal_galvanized', pts, 0.005, 3, { col: false, shadow: true });
  // pickets
  for (let u = -len / 2 + 0.3; u < len / 2; u += 2.5) {
    B.box('metal_rusted', u, 0.55, 0.0, 0.04, 1.1, 0.04, { col: false });
  }
  B.pop();
}

export function hedgehog(B, x, y, z, ry) {
  B.push(tr(x, y, z, ry));
  const L = 1.9, s = 0.12;
  B.box('metal_rusted', 0, 0.62, 0, L, s, s, { rot: [0, 0, 0.62] });
  B.box('metal_rusted', 0, 0.62, 0, L, s, s, { rot: [0, Math.PI / 2, 0.62] });
  B.box('metal_rusted', 0, 0.62, 0, s, s, L, { rot: [0.62, Math.PI / 4, 0] });
  B.pop();
}

// ------------------------------------------------------------------------------------------ vehicles
const CAR_PAINTS = ['metal_painted#white', 'metal_painted#blue', 'metal_painted#red', 'metal_painted#tan', 'metal_painted#green', 'metal_painted#grey'];

export function car(B, x, y, z, ry, o = {}) {
  const burnt = !!o.burnt;
  const r = hashRng(x * 13 + z * 7 + (o.seed || 0));
  const paint = burnt ? 'metal_burnt' : (o.paint || CAR_PAINTS[Math.floor(r() * CAR_PAINTS.length)]);
  const L = 4.15, W = 1.62;
  const sag = burnt ? 0.14 : 0;
  B.push(tr(x, y, z, ry).multiply(M4().makeRotationZ(o.roll || 0)));
  // lower body: side profile extruded across the width (profile in (x, y) -> use extrudeX along z by rotating)
  const prof = [[-2.07, 0.32], [2.07, 0.3], [2.1, 0.62], [2.02, 0.86], [1.25, 0.92], [-0.8, 0.95], [-2.02, 0.84], [-2.1, 0.6]];
  // extrudeX extrudes along X with profile in (z, y): we want length along X, so rotate frame by 90deg
  B.push(M4().makeRotationY(Math.PI / 2).setPosition(0, -sag, 0));
  B.extrudeX(paint, prof, -W / 2, W, null, { uv: 'proj' });
  B.pop();
  // cabin: pillars + roof (open for burnt cars; glass for intact)
  const yb = 0.93 - sag, yr = 1.38 - sag;
  const roofX0 = -0.28, roofX1 = 0.8;
  B.box(paint, (roofX0 + roofX1) / 2, yr, 0, roofX1 - roofX0 + 0.1, 0.05, W - 0.18);
  for (const s of [-1, 1]) {
    const zz = s * (W / 2 - 0.12);
    // A pillar
    B.cylinder(paint, [-0.82, yb, zz], [roofX0, yr, zz], 0.035, 0.035, 4, { col: false });
    // B pillar
    B.cylinder(paint, [0.25, yb, zz], [0.25, yr, zz], 0.04, 0.04, 4, { col: false });
    // C pillar
    B.box(paint, 1.05, (yb + yr) / 2, zz, 0.12, yr - yb, 0.06, { rot: [0, 0, -0.55] });
  }
  if (!burnt) {
    // glass (dark, reflective-ish)
    B.quad('glass', [-0.8, yb + 0.02, -W / 2 + 0.14], [-0.8, yb + 0.02, W / 2 - 0.14], [roofX0 + 0.02, yr - 0.02, W / 2 - 0.14], [roofX0 + 0.02, yr - 0.02, -W / 2 + 0.14], { ray: true, move: false });
    for (const s of [-1, 1]) {
      const zz = s * (W / 2 - 0.1);
      B.quad('glass', s > 0 ? [-0.75, yb, zz] : [1.0, yb, zz], s > 0 ? [1.0, yb, zz] : [-0.75, yb, zz], s > 0 ? [0.8, yr - 0.03, zz] : [roofX0, yr - 0.03, zz], s > 0 ? [roofX0, yr - 0.03, zz] : [0.8, yr - 0.03, zz], { ray: true, move: false });
    }
  }
  // interior: seats
  const seatMat = burnt ? 'metal_rusted#burnt' : 'fabric_military#dark';
  for (const sx of [-0.1, 0.75]) {
    B.box(seatMat, sx, 0.55 - sag, 0, 0.45, 0.12, W - 0.35, { col: false });
    B.box(seatMat, sx + 0.25, 0.85 - sag, 0, 0.08, 0.55, W - 0.35, { rot: [0, 0, -0.2], col: false });
  }
  // steering wheel
  const tw = new THREE.TorusGeometry(0.19, 0.02, 4, 12);
  B.geometry('rubber', tw, M4().makeTranslation(-0.45, 0.95 - sag, -0.35).multiply(M4().makeRotationY(Math.PI / 2)).multiply(M4().makeRotationX(0.4)), { col: false });
  tw.dispose();
  // wheels
  for (const [wx, wz] of [[-1.3, -W / 2 + 0.12], [-1.3, W / 2 - 0.12], [1.25, -W / 2 + 0.12], [1.25, W / 2 - 0.12]]) {
    const sgn = Math.sign(wz);
    if (burnt) {
      B.cylinder('metal_rusted#burnt', [wx, 0.19, wz - sgn * 0.07], [wx, 0.19, wz + sgn * 0.08], 0.19, 0.19, 10, { caps: true, col: false });
    } else {
      B.cylinder('rubber', [wx, 0.31, wz - sgn * 0.09], [wx, 0.31, wz + sgn * 0.09], 0.31, 0.31, 14, { caps: true, col: false });
      B.cylinder('metal_galvanized', [wx, 0.31, wz + sgn * 0.09], [wx, 0.31, wz + sgn * 0.1], 0.17, 0.17, 10, { caps: true, col: false });
    }
  }
  // bumpers, lights, grille
  const bumper = burnt ? 'metal_rusted#burnt' : 'metal_galvanized';
  B.box(bumper, -2.12, 0.42 - sag, 0, 0.08, 0.12, W + 0.04);
  B.box(bumper, 2.14, 0.42 - sag, 0, 0.08, 0.12, W + 0.04);
  if (!burnt) {
    // headlights / grille / tail lights via the car detail texture
    B.quad('w:car_details', [-2.105, 0.52, W / 2 - 0.05], [-2.105, 0.52, -W / 2 + 0.05], [-2.105, 0.72, -W / 2 + 0.05], [-2.105, 0.72, W / 2 - 0.05],
      { uvs: [0, 0.6, 0.62, 0.6, 0.62, 1, 0, 1], uvOff: [0, 0], col: false });
    B.quad('w:car_details', [2.105, 0.62, -W / 2 + 0.05], [2.105, 0.62, W / 2 - 0.05], [2.105, 0.8, W / 2 - 0.05], [2.105, 0.8, -W / 2 + 0.05],
      { uvs: [0.7, 0.62, 1, 0.62, 1, 0.92, 0.7, 0.92], uvOff: [0, 0], col: false });
    // mirrors
    for (const s of [-1, 1]) B.box(paint, -0.75, 1.02, s * (W / 2 + 0.06), 0.06, 0.08, 0.12, { col: false });
  }
  // door seams
  for (const s of [-1, 1]) {
    for (const dx of [-0.8, 0.25, 1.1]) B.box('rubber', dx, 0.65 - sag, s * (W / 2 + 0.002), 0.012, 0.5, 0.006, { col: false, shadow: false });
  }
  B.pop();
}

export function van(B, x, y, z, ry, o = {}) {
  const burnt = !!o.burnt;
  const paint = burnt ? 'metal_burnt' : (o.paint || 'metal_painted#olive');
  const L = 4.4, W = 1.94, H = 2.05;
  B.push(tr(x, y, z, ry));
  const prof = [[-2.2, 0.38], [2.2, 0.38], [2.2, 2.0], [2.12, 2.07], [-1.75, 2.07], [-2.2, 1.35], [-2.25, 0.7]];
  B.push(M4().makeRotationY(Math.PI / 2));
  B.extrudeX(paint, prof, -W / 2, W, null, {});
  B.pop();
  // window band (dark)
  const winMat = burnt ? 'metal_rusted#burnt' : 'glass';
  for (const s of [-1, 1]) {
    B.box(burnt ? 'rubber' : 'metal_painted#dark', 0.1, 1.62, s * (W / 2 + 0.005), 3.6, 0.5, 0.01, { col: false });
  }
  B.quad(winMat, [-2.0, 1.4, W / 2 - 0.1], [-2.0, 1.4, -W / 2 + 0.1], [-1.72, 1.98, -W / 2 + 0.1], [-1.72, 1.98, W / 2 - 0.1], { col: false });
  for (const [wx, wz] of [[-1.25, -W / 2 + 0.1], [-1.25, W / 2 - 0.1], [1.3, -W / 2 + 0.1], [1.3, W / 2 - 0.1]]) {
    const sgn = Math.sign(wz);
    if (burnt) B.cylinder('metal_rusted#burnt', [wx, 0.22, wz - sgn * 0.08], [wx, 0.22, wz + sgn * 0.08], 0.22, 0.22, 10, { caps: true, col: false });
    else B.cylinder('rubber', [wx, 0.38, wz - sgn * 0.11], [wx, 0.38, wz + sgn * 0.11], 0.38, 0.38, 14, { caps: true, col: false });
  }
  B.box(burnt ? 'metal_rusted#burnt' : 'metal_galvanized', -2.28, 0.5, 0, 0.1, 0.15, W);
  void L; void H;
  B.pop();
}

export function truck(B, x, y, z, ry, o = {}) {
  const burnt = !!o.burnt;
  const paint = burnt ? 'metal_burnt' : 'metal_painted#olive';
  const W = 2.4;
  B.push(tr(x, y, z, ry));
  // chassis
  B.box('metal_gun_black', 0.4, 0.75, 0, 7.0, 0.25, 1.1);
  // cab + hood
  B.box(paint, -2.55, 1.55, 0, 1.6, 1.5, W - 0.2);
  B.box(paint, -3.55, 1.25, 0, 1.3, 0.9, W - 0.6);
  B.box('metal_painted#dark', -4.23, 1.2, 0, 0.06, 0.7, W - 0.8, { col: false });
  if (!burnt) {
    B.quad('glass', [-3.36, 1.75, W / 2 - 0.2], [-3.36, 1.75, -W / 2 + 0.2], [-3.36, 2.2, -W / 2 + 0.2], [-3.36, 2.2, W / 2 - 0.2], { col: false });
  }
  // bed
  B.box(burnt ? 'metal_rusted#burnt' : 'wood_planks', 1.55, 1.05, 0, 4.4, 0.12, W);
  for (const s of [-1, 1]) B.box(burnt ? 'metal_rusted#burnt' : 'wood_planks', 1.55, 1.45, s * (W / 2 - 0.03), 4.4, 0.7, 0.06);
  B.box(burnt ? 'metal_rusted#burnt' : 'wood_planks', 3.72, 1.45, 0, 0.06, 0.7, W);
  if (!burnt && o.canvas !== false) {
    // canvas cover
    B.box('fabric_military', 1.55, 2.4, 0, 4.4, 0.08, W + 0.04);
    for (const s of [-1, 1]) B.box('fabric_military', 1.55, 2.0, s * (W / 2 + 0.01), 4.4, 0.9, 0.04);
  }
  // wheels (6)
  for (const wx of [-3.1, 1.0, 2.4]) {
    for (const s of [-1, 1]) {
      const wz = s * (W / 2 - 0.2);
      if (burnt) B.cylinder('metal_rusted#burnt', [wx, 0.3, wz - s * 0.12], [wx, 0.3, wz + s * 0.14], 0.3, 0.3, 10, { caps: true, col: false });
      else B.cylinder('rubber', [wx, 0.52, wz - s * 0.16], [wx, 0.52, wz + s * 0.18], 0.52, 0.52, 14, { caps: true, col: false });
    }
  }
  B.pop();
}

export function bus(B, x, y, z, ry, o = {}) {
  const burnt = o.burnt !== false;
  const paint = burnt ? 'metal_burnt' : 'metal_painted#yellow';
  const L = 9.2, W = 2.5, H = 2.95;
  B.push(tr(x, y, z, ry).multiply(M4().makeRotationX(o.tilt || 0)));
  const base = burnt ? 0.25 : 0.45;
  // floor + skirt
  B.box(paint, 0, base + 0.5, 0, L, 1.0, W);
  // window band: pillars only
  const n = 8;
  for (let i = 0; i <= n; i++) {
    const px = -L / 2 + 0.15 + (L - 0.3) * i / n;
    for (const s of [-1, 1]) B.box(paint, px, base + 1.0 + 0.55, s * (W / 2 - 0.04), 0.14, 1.1, 0.08);
  }
  // roof (sagging when burnt)
  const g = new THREE.BoxGeometry(L, 0.08, W, 12, 1, 2);
  if (burnt) {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) - 0.12 * Math.sin((p.getX(i) / L + 0.5) * Math.PI) * (1 - Math.abs(p.getZ(i)) / W));
    g.computeVertexNormals();
  }
  B.geometry(paint, g, M4().makeTranslation(0, base + 2.1 + 0.04, 0), { uv: 'proj' });
  g.dispose();
  // front / back walls (upper)
  B.box(paint, -L / 2 + 0.04, base + 1.55, 0, 0.08, 0.4, W, { col: false });
  B.box(paint, L / 2 - 0.04, base + 1.55, 0, 0.08, 1.1, W);
  // seat frames
  for (let i = 0; i < 9; i++) {
    const sx = -L / 2 + 1.6 + i * 0.85;
    for (const s of [-1, 1]) {
      B.box('metal_rusted#burnt', sx, base + 1.25, s * 0.7, 0.05, 0.5, 0.8, { col: false });
      B.box('metal_rusted#burnt', sx + 0.2, base + 1.02, s * 0.7, 0.4, 0.04, 0.8, { col: false });
    }
  }
  for (const wx of [-L / 2 + 1.6, L / 2 - 2.0]) {
    for (const s of [-1, 1]) {
      B.cylinder(burnt ? 'metal_rusted#burnt' : 'rubber', [wx, 0.38, s * (W / 2 - 0.25)], [wx, 0.38, s * (W / 2 - 0.02)], 0.38, 0.38, 12, { caps: true, col: false });
    }
  }
  B.pop();
}

// ------------------------------------------------------------------------------------------ street furniture
export function lampPost(B, x, y, z, ry, o = {}) {
  B.push(tr(x, y, z, ry));
  const h = o.h || 7.5;
  B.cylinder('concrete_wall', [0, 0, 0], [0, 0.6, 0], 0.18, 0.16, 8, { caps: true });
  B.cylinder('metal_painted#grey', [0, 0.6, 0], [0, h, 0], 0.09, 0.06, 8);
  const pts = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    pts.push(new THREE.Vector3(0, h - 0.2 + Math.sin(t * Math.PI * 0.5) * 0.5, t * 1.5));
  }
  B.tube('metal_painted#grey', pts, 0.04, 5, { col: false });
  B.box('metal_painted#dark', 0, h + 0.28, 1.65, 0.32, 0.14, 0.6, { col: false });
  B.box('glass', 0, h + 0.2, 1.65, 0.26, 0.02, 0.5, { col: false, shadow: false });
  if (o.broken) B.box('metal_painted#grey', 0.3, 0.1, 0.8, 0.12, 0.12, 1.6, { rot: [0, 0.5, 0], col: false });
  B.pop();
  return { top: [x, y + h, z] };
}

/** Concrete utility pole; returns attach points (world) for wires [left, center, right] at the crossarm. */
export function powerPole(B, x, y, z, ry, o = {}) {
  const h = o.h || 9.5;
  B.push(tr(x, y, z, ry).multiply(M4().makeRotationZ(o.lean || 0)));
  const g = new THREE.CylinderGeometry(0.1, 0.16, h, 4, 1);
  g.rotateY(Math.PI / 4);
  g.translate(0, h / 2, 0);
  B.geometry('concrete_wall', g, null, { uv: 'proj' });
  g.dispose();
  // crossarm + insulators
  B.box('metal_galvanized', 0, h - 0.5, 0, 0.1, 0.1, 2.0, { col: false });
  const pts = [];
  for (const dz of [-0.85, 0, 0.85]) {
    B.cylinder('glass', [0, h - 0.45, dz], [0, h - 0.25, dz], 0.05, 0.035, 6, { col: false, shadow: false });
    pts.push(new THREE.Vector3(0, h - 0.24, dz).applyMatrix4(B.frame));
  }
  // secondary arm with a transformer on some poles
  if (o.transformer) {
    B.box('metal_painted#grey', 0.45, h - 2.6, 0, 0.6, 1.1, 0.7, { col: false });
    B.box('metal_galvanized', 0.2, h - 2.1, 0, 0.35, 0.08, 0.08, { col: false });
  }
  // lower phone/service arm
  B.box('metal_galvanized', 0, h - 1.6, 0, 0.08, 0.08, 1.0, { col: false });
  pts.push(new THREE.Vector3(0, h - 1.55, 0.45).applyMatrix4(B.frame));
  B.pop();
  return pts;
}

/** Sagging wire between world points a and b. */
export function wire(B, a, b, sag = 0.5, r = 0.011) {
  const n = Math.max(6, Math.round(a.distanceTo(b) / 1.2));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = new THREE.Vector3().lerpVectors(a, b, t);
    p.y -= sag * 4 * t * (1 - t) * (1 + 0.15 * (t - 0.5)); // parabola ~ catenary for small sag
    pts.push(p);
  }
  // wires are authored in world space
  B.push(new THREE.Matrix4().copy(B.frame).invert());
  B.tube('rubber', pts, r, 4, { col: false, shadow: true });
  B.pop();
}

export function bench(B, x, y, z, ry, o = {}) {
  B.push(tr(x, y, z, ry));
  for (const dx of [-0.75, 0.75]) B.box('concrete_wall', dx, 0.22, 0, 0.12, 0.44, 0.45);
  const broken = !!o.broken;
  for (let i = 0; i < 3; i++) {
    if (broken && i === 1) continue;
    B.box('wood_planks', 0, 0.46, -0.15 + i * 0.15, 1.8, 0.04, 0.12, { rot: broken && i === 2 ? [0, 0, 0.2] : [0, 0, 0], uv: 'face' });
  }
  for (let i = 0; i < 2; i++) B.box('wood_planks', 0, 0.62 + i * 0.16, 0.26, 1.8, 0.1, 0.03, { uv: 'face', col: false });
  B.pop();
}

export function kiosk(B, x, y, z, ry) {
  B.push(tr(x, y, z, ry));
  B.box('metal_painted#blue', 0, 1.2, 0, 2.2, 2.4, 1.6);
  B.box('metal_painted#white', 0, 2.5, 0, 2.5, 0.2, 1.9);
  B.box('metal_painted#dark', 0, 1.45, 0.805, 1.6, 0.9, 0.02, { col: false });
  B.box('w:glass_broken', 0, 1.45, 0.82, 1.5, 0.8, 0.01, { col: false });
  B.box('metal_painted#blue', 0, 0.92, 1.0, 1.8, 0.05, 0.35, { col: false });
  B.pop();
}

export function busShelter(B, x, y, z, ry) {
  B.push(tr(x, y, z, ry));
  for (const [dx, dz] of [[-1.8, -0.6], [1.8, -0.6], [-1.8, 0.6], [1.8, 0.6]]) B.box('metal_painted#grey', dx, 1.2, dz, 0.08, 2.4, 0.08);
  B.box('metal_painted#grey', 0, 2.45, 0, 3.9, 0.1, 1.5);
  B.box('w:glass_broken', 0, 1.3, -0.62, 3.5, 1.9, 0.01, { col: false });
  B.box('wood_planks', 0, 0.45, -0.3, 3.0, 0.05, 0.4, { col: false });
  B.pop();
}

export function stall(env, x, y, z, ry, o = {}) {
  const { B, props } = env;
  const r = hashRng(x * 17 + z * 5);
  const w = o.w || 2.6, d = 1.6;
  const tarp = o.tarp || ['w:tarp_blue', 'w:tarp_red', 'w:tarp_green', 'w:tarp_white', 'w:tarp_orange'][Math.floor(r() * 5)];
  B.push(tr(x, y, z, ry));
  // frame posts
  const hF = 2.4, hB = 2.0;
  for (const [dx, dz, h] of [[-w / 2, d / 2, hF], [w / 2, d / 2, hF], [-w / 2, -d / 2, hB], [w / 2, -d / 2, hB]]) {
    B.box('metal_rusted', dx, h / 2, dz, 0.05, h, 0.05, { col: false });
  }
  // sloped tarp roof with sag (+ tear sometimes)
  const g = new THREE.PlaneGeometry(w + 0.4, Math.hypot(d + 0.5, hF - hB), 10, 4);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const px = p.getX(i), py = p.getY(i);
    const sag = 0.1 * Math.sin((px / (w + 0.4) + 0.5) * Math.PI) * Math.sin((py / (d + 0.5) + 0.5) * Math.PI);
    p.setZ(i, -sag + (r() - 0.5) * 0.015);
  }
  g.computeVertexNormals();
  const ang = Math.atan2(hF - hB, d + 0.5);
  B.geometry(tarp, g, M4().makeTranslation(0, (hF + hB) / 2 + 0.03, 0).multiply(M4().makeRotationX(-Math.PI / 2 - ang)), { col: false, uv: 'keep' });
  g.dispose();
  // hanging flap on the front
  if (r() > 0.4) {
    const f = new THREE.PlaneGeometry(w + 0.4, 0.35, 6, 1);
    B.geometry(tarp, f, M4().makeTranslation(0, hF - 0.12, d / 2 + 0.26), { col: false, uv: 'keep' });
    f.dispose();
  }
  // counter table
  B.box('wood_planks', 0, 0.85, d / 2 - 0.35, w - 0.1, 0.05, 0.7, { uv: 'face' });
  B.box('wood_planks', 0, 0.42, d / 2 - 0.35, w - 0.2, 0.8, 0.02, { col: false });
  for (const dx of [-w / 2 + 0.1, w / 2 - 0.1]) B.box('wood_planks', dx, 0.42, d / 2 - 0.35, 0.05, 0.84, 0.6, { col: false });
  // goods: crates & boxes
  const nC = 2 + Math.floor(r() * 3);
  for (let i = 0; i < nC; i++) {
    const cx = -w / 2 + 0.4 + i * (w - 0.8) / Math.max(1, nC - 1);
    const kind = r();
    if (kind < 0.5) B.box('cardboard', cx, 0.98, d / 2 - 0.35, 0.4, 0.22, 0.3, { rot: [0, (r() - 0.5) * 0.4, 0], col: false });
    else B.box('wood_planks', cx, 0.97, d / 2 - 0.35, 0.45, 0.2, 0.32, { rot: [0, (r() - 0.5) * 0.4, 0], col: false, uv: 'face' });
  }
  B.pop();
  // crates stacked beside (models)
  const frame = new THREE.Matrix4().multiplyMatrices(B.frame, tr(x, y, z, ry));
  if (r() > 0.3) props.place(r() > 0.5 ? 'wooden_crate_01' : 'wooden_crate_02', w / 2 + 0.5, 0, 0.1, r() * 0.6, 1, { frame });
  if (r() > 0.5) props.place('plastic_monobloc_chair_01', -w / 2 - 0.4, 0, 0.2, r() * 3, 1, { frame, collide: false });
  return { w, d };
}

// ------------------------------------------------------------------------------------------ industrial
export function container(B, x, y, z, ry, o = {}) {
  const mat = o.mat || ['corrugated_metal#rust', 'corrugated_metal#blue', 'corrugated_metal#green', 'corrugated_metal#red'][Math.floor(hashRng(x + z)() * 4)];
  const L = o.long ? 12.19 : 6.06, W = 2.44, H = 2.59;
  B.push(tr(x, y, z, ry));
  B.box(mat, 0, H / 2, 0, L - 0.1, H - 0.1, W - 0.1);
  // corner posts + rails
  for (const dx of [-L / 2 + 0.08, L / 2 - 0.08]) for (const dz of [-W / 2 + 0.08, W / 2 - 0.08]) B.box('metal_rusted', dx, H / 2, dz, 0.16, H, 0.16, { col: false });
  for (const yy of [0.08, H - 0.08]) for (const dz of [-W / 2 + 0.06, W / 2 - 0.06]) B.box('metal_rusted', 0, yy, dz, L, 0.14, 0.12, { col: false });
  // door end: lock bars
  for (const dz of [-0.8, -0.35, 0.35, 0.8]) B.box('metal_galvanized', L / 2 + 0.02, H / 2, dz, 0.04, H - 0.3, 0.04, { col: false });
  B.pop();
}

export function hTank(B, x, y, z, ry, o = {}) {
  const R = o.r || 1.5, L = o.len || 8;
  B.push(tr(x, y, z, ry));
  B.cylinder(o.mat || 'metal_painted#white', [-L / 2, R + 0.6, 0], [L / 2, R + 0.6, 0], R, R, 20, { caps: true });
  for (const dx of [-L / 3, 0, L / 3]) B.box('concrete_wall', dx, 0.45, 0, 0.5, 0.9, R * 1.7);
  // walkway + ladder
  B.box('metal_galvanized', 0, 2 * R + 0.65, 0, L * 0.5, 0.05, 0.6, { col: false });
  for (let i = 0; i < 8; i++) B.box('metal_galvanized', L / 4 + 0.1, 0.3 + i * 0.35, R + 0.25, 0.4, 0.03, 0.03, { col: false });
  B.box('metal_galvanized', L / 4 - 0.1, (2 * R + 0.6) / 2, R + 0.25, 0.03, 2 * R + 0.6, 0.03, { col: false });
  B.box('metal_galvanized', L / 4 + 0.3, (2 * R + 0.6) / 2, R + 0.25, 0.03, 2 * R + 0.6, 0.03, { col: false });
  // pipe
  B.cylinder('metal_painted#yellow', [L / 2, 0.8, 0], [L / 2 + 2.5, 0.8, 0], 0.08, 0.08, 8, { col: false });
  B.pop();
}

export function vTank(B, x, y, z, o = {}) {
  const R = o.r || 3.2, H = o.h || 7;
  B.push(tr(x, y, z, 0));
  B.cylinder(o.mat || 'metal_painted#white', [0, 0, 0], [0, H, 0], R, R, 28, { caps: false });
  const cone = new THREE.ConeGeometry(R + 0.05, 0.7, 28, 1, true);
  B.geometry(o.mat || 'metal_painted#white', cone, M4().makeTranslation(0, H + 0.35, 0), { uv: 'proj' });
  cone.dispose();
  B.box('concrete_wall', 0, 0.1, 0, R * 2 + 0.6, 0.2, R * 2 + 0.6);
  // ladder
  for (let i = 0; i < 18; i++) B.box('metal_galvanized', 0, 0.3 + i * 0.38, R + 0.2, 0.45, 0.03, 0.03, { col: false });
  for (const dx of [-0.22, 0.22]) B.box('metal_galvanized', dx, H / 2, R + 0.2, 0.03, H, 0.03, { col: false });
  B.pop();
}

/** Fuel dispenser (faces +-x), base center at origin of the current frame + (x,y,z). */
export function fuelPump(B, x, y, z, ry, o = {}) {
  B.push(tr(x, y, z, ry));
  const body = o.mat || 'metal_painted_white';
  const dark = 'metal_painted_dark';
  // skirt, body, side frames, head unit, header band
  B.box(dark, 0, 0.13, 0, 0.62, 0.26, 1.02);
  B.box(body, 0, 0.26 + 0.52, 0, 0.52, 1.04, 0.92);
  for (const dz of [-0.47, 0.47]) B.box('metal_painted_grey', 0, 0.26 + 0.78, dz, 0.6, 1.56, 0.05, { col: false });
  B.box(body, 0, 1.56, 0, 0.5, 0.56, 0.9);
  B.box('metal_painted_red', 0, 1.93, 0, 0.62, 0.18, 1.04);
  B.box(dark, 0, 2.03, 0, 0.5, 0.03, 0.9, { col: false });
  // louvres near the base
  for (let i = 0; i < 4; i++) for (const s of [-1, 1]) B.box(dark, s * 0.262, 0.42 + i * 0.07, 0, 0.012, 0.025, 0.55, { col: false, shadow: false });
  const rr = hashRng(x * 13.7 + z * 5.1);
  for (const s of [-1, 1]) {
    // display bezel + price windows (glass, some cracked) + keypad + brand stripe
    B.box(dark, s * 0.255, 1.6, 0, 0.012, 0.4, 0.74, { col: false });
    B.box(rr() < 0.4 ? 'w:glass_broken' : 'glass', s * 0.263, 1.68, -0.14, 0.004, 0.15, 0.34, { col: false, shadow: false });
    B.box('glass', s * 0.263, 1.5, -0.14, 0.004, 0.09, 0.34, { col: false, shadow: false });
    B.box('metal_painted_grey', s * 0.27, 1.55, 0.2, 0.02, 0.2, 0.16, { col: false });
    B.box('metal_painted_red', s * 0.262, 1.08, 0, 0.006, 0.06, 0.92, { col: false, shadow: false });
    for (const dz of [-0.3, 0.3]) {
      if (o.missing && s > 0 && dz > 0) continue;
      // holster + nozzle
      B.box(dark, s * 0.29, 1.0, dz, 0.06, 0.16, 0.13, { col: false });
      B.cylinder('metal_painted_dark', [s * 0.3, 1.12, dz], [s * 0.36, 0.98, dz], 0.024, 0.02, 6, { col: false });
      B.cylinder('metal_steel', [s * 0.36, 0.98, dz], [s * 0.41, 0.9, dz], 0.012, 0.01, 5, { col: false, shadow: false });
      // hose: from the head, droop in a loop, back up into the holster
      const sag = 0.35 + rr() * 0.25;
      const c = new THREE.CatmullRomCurve3([
        new THREE.Vector3(s * 0.26, 1.78, dz * 1.1),
        new THREE.Vector3(s * 0.42, 1.55, dz * 1.2),
        new THREE.Vector3(s * 0.5, sag, dz * 1.15 + (rr() - 0.5) * 0.1),
        new THREE.Vector3(s * 0.38, sag + 0.05, dz * 1.05),
        new THREE.Vector3(s * 0.3, 1.12, dz),
      ]);
      B.tube('rubber', c.getPoints(14), 0.017, 6, { col: false });
    }
  }
  B.pop();
}

/** Filling-station canopy with fascia, signage, soffit lights, columns and pump islands. */
export function canopy(B, x, y, z, ry, w, d, h) {
  B.push(tr(x, y, z, ry));
  const cols = [];
  for (const dx of [-w / 2 + 1.2, w / 2 - 1.2]) for (const dz of [-d / 2 + 1.1, d / 2 - 1.1]) cols.push([dx, dz]);
  for (const [dx, dz] of cols) {
    B.box('metal_painted_white', dx, h / 2, dz, 0.34, h, 0.34);
    B.box('metal_painted_red', dx, 0.5, dz, 0.36, 0.08, 0.36, { col: false });
    B.box('concrete_barrier', dx, 0.18, dz, 0.55, 0.36, 0.55);
  }
  // roof slab (steel deck) + fascia band all round
  const fh = 0.9, ft = 0.08;
  B.box('metal_galvanized', 0, h + 0.35, 0, w - 0.1, 0.5, d - 0.1, { col: true });
  for (const s of [-1, 1]) {
    B.box('metal_painted_white', 0, h + 0.4, s * (d / 2), w + ft, fh, ft);
    B.box('metal_painted_white', s * (w / 2), h + 0.4, 0, ft, fh, d + ft);
    // red stripe + dark trim
    B.box('metal_painted_red', 0, h + 0.14, s * (d / 2 + 0.045), w + ft + 0.02, 0.2, 0.01, { col: false, shadow: false });
    B.box('metal_painted_red', s * (w / 2 + 0.045), h + 0.14, 0, 0.01, 0.2, d + ft + 0.02, { col: false, shadow: false });
    B.box('metal_painted_dark', 0, h + 0.86, s * (d / 2), w + ft + 0.04, 0.05, ft + 0.04, { col: false });
    B.box('metal_painted_dark', s * (w / 2), h + 0.86, 0, ft + 0.04, 0.05, d + ft + 0.04, { col: false });
    // sign on each long side
    if (B.tex) {
      const [su, sv, du, dv] = B.tex.signCell(25);
      const sw = 4.4, sh = 0.55, zz = s * (d / 2 + 0.046), cy = h + 0.52;
      const L = -sw / 2, R = sw / 2;
      const pts = s > 0
        ? [[L, cy - sh / 2, zz], [R, cy - sh / 2, zz], [R, cy + sh / 2, zz], [L, cy + sh / 2, zz]]
        : [[R, cy - sh / 2, zz], [L, cy - sh / 2, zz], [L, cy + sh / 2, zz], [R, cy + sh / 2, zz]];
      B.quad('w:signs', ...pts, { uvs: [su, sv, su + du, sv, su + du, sv + dv, su, sv + dv], uvOff: [0, 0], col: false });
    }
  }
  // soffit: panel seams + recessed light boxes (a few missing / dangling)
  for (let i = 1; i < 8; i++) B.box('metal_painted_grey', -w / 2 + (i * w) / 8, h + 0.09, 0, 0.04, 0.02, d - 0.2, { col: false, shadow: false });
  const r = hashRng(x + z * 3);
  for (const lx of [-w / 3, 0, w / 3]) for (const lz of [-d / 4, d / 4]) {
    const k = r();
    if (k < 0.15) continue;
    if (k > 0.85) { B.box('metal_painted_white', lx, h - 0.25, lz, 0.9, 0.06, 0.45, { rot: [0.5, 0, 0.9], col: false }); continue; }
    B.box('metal_painted_dark', lx, h + 0.08, lz, 1.0, 0.04, 0.5, { col: false, shadow: false });
    B.box('glass', lx, h + 0.055, lz, 0.9, 0.012, 0.4, { col: false, shadow: false });
  }
  // a torn fascia panel hanging off one corner
  B.box('metal_painted_white', w / 2 - 1.2, h - 0.15, d / 2 + 0.25, 2.0, 0.85, 0.05, { rot: [0.35, 0.1, 0.25], col: false });
  // pump islands: raised kerb with rounded ends, bollards, dispensers, bins
  for (const dx of [-w / 4, w / 4]) {
    B.box('concrete_barrier', dx, 0.1, 0, 1.1, 0.2, 4.4);
    B.box('metal_painted_yellow', dx, 0.205, 0, 1.12, 0.01, 4.42, { col: false, shadow: false, skip: 1 | 2 | 16 | 32 | 8 });
    for (const s of [-1, 1]) {
      B.cylinder('metal_painted_yellow', [dx, 0.2, s * 2.05], [dx, 1.1, s * 2.05], 0.09, 0.09, 10, { caps: true });
      B.box('metal_painted_dark', dx, 0.85, s * 2.05, 0.19, 0.08, 0.19, { col: false, shadow: false });
    }
    fuelPump(B, dx, 0.2, -0.95, 0, { missing: dx > 0 });
    fuelPump(B, dx, 0.2, 0.95, 0, {});
  }
  B.pop();
  return h + 0.85;
}

// ------------------------------------------------------------------------------------------ plaza set pieces
export function fountain(B, x, y, z, o = {}) {
  B.push(tr(x, y, z, 0));
  const R = 5.4, rimH = 0.55, rimT = 0.4;
  const n = 8;
  const side = 2 * R * Math.tan(Math.PI / n);
  for (let i = 0; i < n; i++) {
    if (o.broken === i) continue;
    const a = (i / n) * Math.PI * 2 + Math.PI / n;
    const cx = Math.cos(a) * (R - rimT / 2), cz = Math.sin(a) * (R - rimT / 2);
    B.box('concrete_wall#pale', cx, rimH / 2, cz, rimT, rimH, side + 0.02, { rot: [0, -a, 0] });
    B.box('concrete_floor#pale', Math.cos(a) * (R - rimT / 2 + 0.03), rimH + 0.04, Math.sin(a) * (R - rimT / 2 + 0.03), rimT + 0.12, 0.08, side + 0.1, { rot: [0, -a, 0] });
  }
  // basin floor (dry, a bit lower than rim)
  const floor = new THREE.CylinderGeometry(R - rimT, R - rimT, 0.1, n, 1);
  floor.rotateY(Math.PI / n);
  B.geometry('tile_floor#grey', floor, M4().makeTranslation(0, 0.05, 0), { uv: 'proj' });
  floor.dispose();
  // central column + bowls
  B.cylinder('concrete_wall#pale', [0, 0, 0], [0, 0.4, 0], 1.2, 1.2, 16, { caps: true });
  B.cylinder('concrete_wall#pale', [0, 0.4, 0], [0, 1.9, 0], 0.35, 0.28, 12, { caps: false });
  const bowl = new THREE.LatheGeometry([new THREE.Vector2(0.25, 0), new THREE.Vector2(1.3, 0.35), new THREE.Vector2(1.45, 0.5), new THREE.Vector2(1.35, 0.52), new THREE.Vector2(0.3, 0.2)], 18);
  B.geometry('concrete_wall#pale', bowl, M4().makeTranslation(0, 1.85, 0), { uv: 'proj' });
  bowl.dispose();
  B.cylinder('concrete_wall#pale', [0, 2.3, 0], [0, 3.0, 0], 0.16, 0.1, 10, { caps: true });
  B.cylinder('metal_rusted', [0, 3.0, 0], [0, 3.25, 0], 0.03, 0.03, 6, { col: false });
  B.pop();
  return { R, rimH };
}

export function plinth(B, x, y, z, ry, o = {}) {
  B.push(tr(x, y, z, ry));
  B.box('concrete_floor#pale', 0, 0.2, 0, 5.2, 0.4, 5.2);
  B.box('concrete_wall#pale', 0, 0.6, 0, 4.2, 0.4, 4.2);
  B.box('concrete_wall#grey', 0, 0.8 + 1.3, 0, 2.4, 2.6, 2.4);
  B.box('concrete_wall#pale', 0, 3.5, 0, 2.8, 0.2, 2.8);
  // plaque
  B.box('metal_rusted#green', 0, 2.2, 1.21, 1.2, 0.6, 0.03, { col: false });
  // broken feet of the removed statue + rebar
  B.box('metal_rusted#green', -0.35, 3.8, 0.1, 0.35, 0.4, 0.6, { col: false });
  B.box('metal_rusted#green', 0.35, 3.75, -0.05, 0.35, 0.3, 0.6, { rot: [0, 0.1, 0.1], col: false });
  for (const dx of [-0.2, 0.1, 0.3]) B.cylinder('metal_rusted', [dx, 3.6, 0], [dx + 0.05, 4.3, 0.1], 0.015, 0.015, 4, { col: false });
  B.pop();
  if (o.toppled) {
    // toppled figure lying beside the plinth (abstract bronze worker)
    B.push(tr(x + 3.8, y, z + 1.2, ry + 0.6));
    const br = 'metal_rusted#green';
    B.cylinder(br, [-0.9, 0.35, 0], [0.7, 0.4, 0], 0.38, 0.32, 10, { caps: true });
    B.cylinder(br, [0.7, 0.42, 0], [1.05, 0.42, 0.05], 0.18, 0.18, 10, { caps: true });
    B.cylinder(br, [1.05, 0.42, 0.05], [1.4, 0.4, 0.05], 0.2, 0.2, 10, { caps: true });
    B.cylinder(br, [-0.9, 0.3, 0.2], [-2.2, 0.22, 0.35], 0.16, 0.13, 8, { caps: true });
    B.cylinder(br, [-0.9, 0.3, -0.2], [-2.1, 0.2, -0.5], 0.16, 0.13, 8, { caps: true });
    B.cylinder(br, [0.5, 0.6, 0.3], [0.2, 1.2, 1.1], 0.12, 0.1, 8, { caps: true, col: false });
    B.cylinder(br, [0.5, 0.35, -0.35], [-0.2, 0.2, -0.95], 0.12, 0.1, 8, { caps: true });
    B.pop();
  }
}

// ------------------------------------------------------------------------------------------ vegetation
export function tree(env, x, y, z, o = {}) {
  const { B, props } = env;
  const r = hashRng(x * 31 + z * 17);
  const dead = !!o.dead;
  const s = o.scale || (0.8 + r() * 0.5);
  const bark = 'w:bark';
  const trunkH = (2.2 + r() * 1.2) * s;
  const lean = (r() - 0.5) * 0.25;
  const base = new THREE.Vector3(x, y - 0.1, z);
  const top = new THREE.Vector3(x + lean, y + trunkH, z + (r() - 0.5) * 0.25);
  const trunk = [];
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    trunk.push(new THREE.Vector3().lerpVectors(base, top, t).add(new THREE.Vector3(Math.sin(t * 5 + x) * 0.08, 0, Math.cos(t * 4 + z) * 0.08)));
  }
  B.push(new THREE.Matrix4().copy(B.frame).invert());
  taperTube(B, bark, trunk, 0.2 * s, 0.13 * s);
  const leafPts = [];
  const branch = (p, dir, len, rad, depth) => {
    const pts = [p.clone()];
    const d = dir.clone();
    let q = p.clone();
    for (let i = 0; i < 4; i++) {
      d.x += (r() - 0.5) * 0.35; d.z += (r() - 0.5) * 0.35; d.y += 0.05 - r() * 0.12;
      d.normalize();
      q = q.clone().addScaledVector(d, len / 4);
      pts.push(q);
    }
    taperTube(B, bark, pts, rad, rad * 0.55);
    if (depth < 2) {
      const nb = 2 + Math.floor(r() * 2);
      for (let k = 0; k < nb; k++) {
        const t = 0.45 + r() * 0.5;
        const bp = pts[Math.floor(t * (pts.length - 1))];
        const nd = d.clone().add(new THREE.Vector3((r() - 0.5) * 1.4, r() * 0.6, (r() - 0.5) * 1.4)).normalize();
        branch(bp, nd, len * 0.62, rad * 0.55, depth + 1);
      }
    } else {
      leafPts.push(q);
    }
  };
  const nMain = 3 + Math.floor(r() * 2);
  for (let k = 0; k < nMain; k++) {
    const a = (k / nMain) * Math.PI * 2 + r();
    const dir = new THREE.Vector3(Math.cos(a) * 0.7, 0.8 + r() * 0.4, Math.sin(a) * 0.7).normalize();
    branch(trunk[4 + Math.floor(r() * 2)] || top, dir, (2.2 + r() * 1.5) * s, 0.1 * s, 0);
  }
  B.pop();
  // leaves (instanced foliage cards) or twig cards for dead trees
  for (const p of leafPts) {
    if (dead) {
      if (r() < 0.6) props.place('foliage5', p.x, p.y + 0.1, p.z, r() * 6, 1.1 + r() * 0.8, { collide: false });
    } else {
      const n = 3;
      for (let k = 0; k < n; k++) {
        props.place('foliage6', p.x + (r() - 0.5) * 0.9, p.y + (r() - 0.35) * 0.6, p.z + (r() - 0.5) * 0.9, r() * 6, 1.3 + r() * 0.9, { collide: false, tilt: [(r() - 0.5) * 0.5, (r() - 0.5) * 0.5] });
      }
    }
  }
  // trunk collision
  B.push(new THREE.Matrix4().copy(B.frame).invert());
  B.colBox(x, y + 1.5, z, 0.45 * s, 3, 0.45 * s, { matKey: bark, surface: 'wood' }, { ray: true, move: true });
  B.pop();
}

function taperTube(B, mat, pts, r0, r1) {
  // build as a sequence of cylinders (cheap, keeps UVs sane)
  for (let i = 0; i < pts.length - 1; i++) {
    const t0 = i / (pts.length - 1), t1 = (i + 1) / (pts.length - 1);
    B.cylinder(mat, pts[i].toArray(), pts[i + 1].toArray(), r0 + (r1 - r0) * t0, r0 + (r1 - r0) * t1, 6, { col: false });
  }
}

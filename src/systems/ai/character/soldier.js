import * as THREE from 'three';
import { B, BIND, HAND_BIND } from './rig.js';
import { M } from './ids.js';
import {
  Part, surface, keyed, clamp, lerp, smooth, gauss, sgnPow, roundedBox, ellipsoid, Limb, edgeFactor,
  flatBox, fbm3, cylinderZ, setRoundedBoxMax,
} from './sculpt.js';

/** Detail level flags for the current build (set by buildSoldierGeometry). */
let LO = false;
let MID = false;
import { SoldierBuilder, W, autoWeights } from './builder.js';

/**
 * Procedural Crimson Vanguard soldier: anatomically proportioned body (~1.80 m), layered gear and a
 * rifle, all in ONE skinned geometry with per-vertex material ids (one draw call per soldier).
 *
 * buildSoldierGeometry({ q, variant }) -> BufferGeometry
 *   q: detail multiplier (1 = LOD0), variant: { helmet: 'helmet'|'headset', glasses: bool }
 */

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const J = (name) => V3(...BIND[B[name]]);
const PI = Math.PI;

// ============================================================================ torso
// y, half-width, front depth, back depth, z centre, superellipse n
const TK = keyed([
  [0.785, 0.042, 0.020, 0.046, -0.010, 2.0],
  [0.84, 0.116, 0.046, 0.084, -0.008, 2.2],
  [0.90, 0.164, 0.078, 0.112, -0.004, 2.3],
  [0.97, 0.170, 0.098, 0.109, -0.004, 2.4],
  [1.04, 0.156, 0.099, 0.097, 0.0, 2.4],
  [1.10, 0.150, 0.103, 0.093, 0.0, 2.4],
  [1.18, 0.157, 0.111, 0.097, 0.002, 2.5],
  [1.27, 0.179, 0.124, 0.106, 0.004, 2.6],
  [1.35, 0.191, 0.118, 0.110, 0.0, 2.6],
  [1.41, 0.201, 0.097, 0.106, -0.008, 2.6],
  [1.455, 0.176, 0.078, 0.090, -0.014, 2.4],
  [1.49, 0.108, 0.064, 0.072, -0.018, 2.2],
  [1.525, 0.062, 0.054, 0.058, -0.016, 2.0],
  [1.60, 0.056, 0.052, 0.054, -0.010, 2.0],
]);

export function torsoPoint(y, th, out, extra = 0, nBoost = 0) {
  const k = TK(y);
  const a = k[0] + extra, bF = k[1] + extra, bB = k[2] + extra, zc = k[3], n = k[4] + nBoost;
  const s = Math.sin(th), c = Math.cos(th), e = 2 / n;
  return out.set(a * sgnPow(s, e), y, zc + (c > 0 ? bF : bB) * sgnPow(c, e));
}

const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3();
/** Surface frame on the (offset) torso: p, n (out), t (up), b (lateral, increasing theta). */
function torsoFrame(y, th, extra = 0, nBoost = 0) {
  const f = { p: new THREE.Vector3(), n: new THREE.Vector3(), t: new THREE.Vector3(), b: new THREE.Vector3() };
  torsoPoint(y, th, f.p, extra, nBoost);
  torsoPoint(y, th + 0.01, _t1, extra, nBoost); torsoPoint(y, th - 0.01, _t2, extra, nBoost);
  f.b.subVectors(_t1, _t2).normalize();
  torsoPoint(y + 0.01, th, _t1, extra, nBoost); torsoPoint(y - 0.01, th, _t2, extra, nBoost);
  f.t.subVectors(_t1, _t2).normalize();
  f.n.crossVectors(f.b, f.t).normalize();
  f.t.crossVectors(f.n, f.b).normalize();
  return f;
}

/** Place a part (authored with x=lateral, y=up, z=out) on a frame. */
function onFrame(part, f, standoff = 0, tiltX = 0) {
  const m = new THREE.Matrix4().makeBasis(f.b, f.t, f.n);
  if (tiltX) m.multiply(new THREE.Matrix4().makeRotationX(tiltX));
  m.setPosition(f.p.clone().addScaledVector(f.n, standoff));
  return part.applyMatrix4(m);
}

function hat(y, ys, names) {
  const out = [];
  if (y <= ys[0]) return [[names[0], 1]];
  if (y >= ys[ys.length - 1]) return [[names[names.length - 1], 1]];
  for (let i = 0; i < ys.length - 1; i++) {
    if (y >= ys[i] && y < ys[i + 1]) {
      const t = smooth(ys[i], ys[i + 1], y);
      out.push([names[i], 1 - t], [names[i + 1], t]);
      break;
    }
  }
  return out;
}
const SPINE_Y = [0.95, 1.075, 1.19, 1.31, 1.50, 1.60];
const SPINE_N = ['pelvis', 'spine1', 'spine2', 'chest', 'neck', 'head'];

function torsoWeights(p) {
  const acc = {};
  const add = (n, w) => { acc[n] = (acc[n] || 0) + w; };
  const ax = Math.abs(p.x);
  const side = p.x >= 0 ? 'L' : 'R';
  // thighs (hips / crotch)
  const tw = smooth(0.95, 0.83, p.y) * 0.8 * (1 - 0.35 * smooth(-0.03, -0.09, p.z));
  const tL = tw * smooth(-0.045, 0.045, p.x), tR = tw * smooth(0.045, -0.045, p.x);
  // shoulders
  const armB = smooth(0.12, 0.2, ax) * smooth(1.3, 1.41, p.y) * 0.55;
  const clavB = smooth(0.04, 0.15, ax) * smooth(1.36, 1.47, p.y) * 0.6 * (1 - armB);
  const rest = Math.max(0, 1 - tL - tR - armB - clavB);
  for (const [n, w] of hat(p.y, SPINE_Y, SPINE_N)) add(n, w * rest);
  add('thighL', tL); add('thighR', tR);
  add('upperarm' + side, armB); add('clav' + side, clavB);
  return Object.entries(acc).filter((e) => e[1] > 1e-4).map(([n, w]) => [B[n], w]);
}

/** Vest / belt weights: spine chain only (no arms/thighs) so rigid gear doesn't smear. */
function gearWeights(p) {
  const acc = {};
  const ax = Math.abs(p.x);
  const clav = smooth(1.44, 1.5, p.y) * smooth(0.05, 0.12, ax) * 0.45;
  for (const [n, w] of hat(clamp(p.y, 0.95, 1.46), [0.95, 1.075, 1.19, 1.31], ['pelvis', 'spine1', 'spine2', 'chest'])) acc[n] = w * (1 - clav);
  acc['clav' + (p.x >= 0 ? 'L' : 'R')] = clav;
  return Object.entries(acc).filter((e) => e[1] > 1e-4).map(([n, w]) => [B[n], w]);
}

const dirtBody = (p) => clamp(smooth(0.55, 0.12, p.y) * 0.75 + gauss(p.y - 0.49, 0.06) * 0.35 * smooth(0, 0.06, p.z), 0, 1);

// ============================================================================ utilities
function clonePart(part) {
  const o = new Part();
  o.p = part.p.slice(); o.uv = part.uv.slice(); o.idx = part.idx.slice();
  return o;
}
function mirrorX(part) {
  const o = clonePart(part);
  for (let i = 0; i < o.p.length; i += 3) o.p[i] = -o.p[i];
  o.flip();
  return o;
}
/** Add a left-side part and its mirrored right-side twin. opts(side) -> builder opts */
function addSym(builder, part, opts) {
  builder.add(part, opts('L'));
  builder.add(mirrorX(part), opts('R'));
}
function mat4Basis(x, y, z, p) { return new THREE.Matrix4().makeBasis(x, y, z).setPosition(p); }

// ============================================================================ head
const HEAD_C = V3(0, 1.655, 0.014);
const EYE_Y = 0.021;

/** Head surface (relative to HEAD_C) incl. facial structure. u: azimuth (0.5 = front), v: 0 top .. 1 bottom */
function headBase(u, v, out) {
  const phi = (u - 0.5) * 2 * PI, th = v * PI;
  const sx = Math.sin(th) * Math.sin(phi), sy = Math.cos(th), sz = Math.sin(th) * Math.cos(phi);
  let rx = 0.082, ry = sy > 0 ? 0.121 : 0.115, rz = sz > 0 ? 0.1 : 0.107;
  const low = smooth(-0.1, -0.88, sy);
  rx *= lerp(1, 0.64, low);
  let x = sx * rx, y = sy * ry, z = sz * rz;
  if (sz < 0 && sy < 0) z *= lerp(1, 0.72, smooth(0, -0.75, sy));
  if (sz > 0) z *= lerp(1, 0.93, low * smooth(0.2, 0.9, sz)); // flatter lower face
  const front = smooth(0.35, 0.92, sz);
  const ax = Math.abs(x);
  // nose
  const noseProfile = (0.3 + 0.7 * smooth(0.035, -0.016, y)) * smooth(-0.046, -0.03, y) * gauss(y + 0.005, 0.042);
  z += 0.02 * gauss(x, 0.0115) * noseProfile * front;
  // eye sockets, brow, cheekbones, chin, mouth
  z -= 0.0085 * gauss(ax - 0.032, 0.016) * gauss(y - EYE_Y, 0.012) * front;
  z += 0.005 * gauss(y - 0.042, 0.01) * gauss(x, 0.05) * front;
  z += 0.004 * gauss(ax - 0.043, 0.016) * gauss(y + 0.004, 0.018) * front;
  z += 0.006 * gauss(x, 0.024) * gauss(y + 0.088, 0.016) * front;
  z += 0.0025 * gauss(x, 0.02) * gauss(y + 0.056, 0.008) * front;
  // ears
  x += Math.sign(x) * 0.011 * gauss(Math.abs(phi) - PI / 2, 0.2) * gauss(y - 0.004, 0.03);
  return out.set(x, y, z);
}
function faceOpening(p) {
  // superellipse window around the eyes
  const phi = Math.atan2(p.x, p.z);
  const dx = Math.abs(phi) / 0.74, dy = Math.abs(p.y - EYE_Y) / 0.0215;
  const r = Math.pow(dx ** 4 + dy ** 4, 0.25);
  return smooth(1.1, 0.9, r);
}

function buildHead(b, q, variant) {
  const nu = Math.max(12, Math.round(56 * q)), nv = Math.max(8, Math.round(40 * q));
  const n = new THREE.Vector3();
  // knit balaclava (dips below the skin inside the eye opening -> clean intersection curve)
  const knit = surface(nu, nv, (u, v, o) => {
    headBase(u, v, o);
    const m = faceOpening(o);
    n.copy(o).normalize();
    const off = lerp(0.0048, -0.007, m) + 0.0012 * fbm3(o.x * 90, o.y * 90, o.z * 90, 2) * (1 - m);
    o.addScaledVector(n, off).add(HEAD_C);
  }, { wrapU: true }).orientOutward();
  b.add(knit, { mat: M.KNIT, bones: ['neck', 'head'], k: 6 });

  // exposed skin patch around the eyes
  const skin = surface(Math.max(8, Math.round(26 * q)), Math.max(6, Math.round(14 * q)), (u, v, o) => {
    headBase(lerp(0.5 - 0.16, 0.5 + 0.16, u), lerp(0.33, 0.54, v), o);
    o.add(HEAD_C);
  });
  skin.orientOutward();
  // orientOutward on an open patch uses its own centroid: force outward (towards +z)
  skin.computeNormals();
  if (skin.n[2 + 3 * Math.floor(skin.count / 2)] < 0) { skin.flip(); skin.computeNormals(); }
  b.add(skin, { mat: M.SKIN, bone: 'head' });

  // eyes (almond-shaped: flattened ellipsoids protruding through the socket)
  if (!LO) for (const sx of [1, -1]) {
    const e = ellipsoid(0.0155, 0.0085, 0.012, Math.max(8, Math.round(12 * q)), Math.max(6, Math.round(8 * q)));
    e.map((v) => v.add(V3(sx * 0.0335, EYE_Y + 0.0005, 0.0745).add(HEAD_C)));
    b.add(e, { mat: M.EYE, bone: 'head' });
  }

  if (variant.glasses) {
    const g = surface(Math.max(8, Math.round(24 * q)), Math.max(4, Math.round(6 * q)), (u, v, o) => {
      const uu = lerp(0.5 - 0.145, 0.5 + 0.145, u);
      headBase(uu, lerp(0.345, 0.47, v), o);
      const e = edgeFactor(u, v, 0.08, 0.3);
      n.copy(o).normalize();
      o.addScaledVector(n, 0.004 + 0.012 * Math.sqrt(e));
      o.z += 0.006 * e;
      o.add(HEAD_C);
    });
    g.computeNormals();
    if (g.n[2 + 3 * Math.floor(g.count / 2)] < 0) { g.flip(); g.computeNormals(); }
    b.add(g, { mat: M.LENS, bone: 'head' });
    // temple arms
    if (!LO) for (const sx of [1, -1]) {
      const arm = roundedBox(0.004, 0.008, 0.075, 0.0018, 1);
      arm.map((v) => { v.x += sx * 0.083; v.y += EYE_Y + 0.012; v.z += 0.03; v.add(HEAD_C); });
      b.add(arm, { mat: M.POLYMER, bone: 'head' });
    }
  }

  if (variant.helmet === 'helmet') buildHelmet(b, q);
  else buildHeadset(b, q);
}

// ------------------------------------------------------------------ helmet
const HELM_C = V3(0, 0.009, -0.006);
const HR = { x: 0.113, yT: 0.134, zF: 0.126, zB: 0.131 };
function helmRimY(phi) {
  const a = Math.abs(phi);
  return lerp(0.046, -0.048, (1 - Math.cos(phi)) / 2) + 0.05 * gauss(a - 1.66, 0.36) - 0.004 * gauss(a - 2.5, 0.3);
}
function helmPoint(phi, t, out, extra = 0) {
  // t: 0 top .. 1 rim
  const yr = helmRimY(phi) - HELM_C.y;
  const thRim = Math.acos(clamp(yr / (HR.yT + extra), -0.99, 0.99));
  const th = t * thRim;
  const sx = Math.sin(th) * Math.sin(phi), sy = Math.cos(th), sz = Math.sin(th) * Math.cos(phi);
  const flat = 1 - 0.06 * smooth(0.75, 1, sy); // slightly flatter crown
  out.set(sx * (HR.x + extra), sy * (HR.yT + extra) * flat, sz * ((sz > 0 ? HR.zF : HR.zB) + extra));
  return out.add(HELM_C).add(HEAD_C);
}
function helmFrame(phi, t, extra = 0) {
  const f = { p: new THREE.Vector3(), n: new THREE.Vector3(), t: new THREE.Vector3(), b: new THREE.Vector3() };
  helmPoint(phi, t, f.p, extra);
  helmPoint(phi + 0.01, t, _t1, extra); helmPoint(phi - 0.01, t, _t2, extra);
  f.b.subVectors(_t1, _t2).normalize();
  helmPoint(phi, t - 0.01, _t1, extra); helmPoint(phi, t + 0.01, _t2, extra);
  f.t.subVectors(_t1, _t2).normalize();
  f.n.crossVectors(f.b, f.t).normalize();
  f.t.crossVectors(f.n, f.b).normalize();
  return f;
}

function buildHelmet(b, q) {
  const nu = Math.max(12, Math.round(52 * q)), nv = Math.max(6, Math.round(22 * q));
  const shell = surface(nu, nv, (u, v, o) => {
    const phi = (u - 0.5) * 2 * PI;
    if (v <= 0.86) {
      helmPoint(phi, v / 0.86, o);
      // cover fabric: subtle bunching near the rim + seams
      const rim = smooth(0.55, 1, v / 0.86);
      const d = 0.0016 * Math.sin(phi * 22 + v * 9) * rim + 0.0008 * fbm3(o.x * 60, o.y * 60, o.z * 60, 2);
      _t1.copy(o).sub(HEAD_C).sub(HELM_C).normalize();
      o.addScaledVector(_t1, d);
    } else {
      // rolled rim edge: wrap inward
      const k = (v - 0.86) / 0.14;
      helmPoint(phi, 1, o);
      const c = _t1.set(o.x - HEAD_C.x - HELM_C.x, 0, o.z - HEAD_C.z - HELM_C.z).normalize();
      o.addScaledVector(c, -0.012 * smooth(0, 1, k) + 0.002 * Math.sin(k * PI));
      o.y += 0.012 * k - 0.004 * Math.sin(k * PI);
    }
  }, { wrapU: true });
  shell.computeNormals();
  // make sure the dome faces outward (top vertex normal should point up)
  if (shell.n[1] < 0) { shell.flip(); shell.computeNormals(); }
  b.add(shell, { mat: M.HELMET, bone: 'head' });

  const put = (part, phi, t, standoff, mat, tilt = 0) => {
    const f = helmFrame(phi, t);
    onFrame(part, f, standoff, tilt);
    b.add(part, { mat, bone: 'head' });
  };
  // NVG shroud
  put(roundedBox(0.052, 0.034, 0.016, 0.005, 2), 0, 0.72, 0.006, M.POLYMER);
  put(roundedBox(0.03, 0.016, 0.012, 0.003, 1), 0, 0.6, 0.012, M.HARDWARE);
  // side rails (ARC style)
  if (!LO) for (const s of [1, -1]) {
    for (let k = 0; k < 3; k++) {
      put(roundedBox(0.036, 0.018, 0.011, 0.003, 1), s * (1.35 + k * 0.3), 0.9, 0.004, M.POLYMER);
    }
  }
  // top velcro + rear battery pack + small crimson unit patch on the back
  put(roundedBox(0.075, 0.055, 0.004, 0.002, 1), 0, 0.2, 0.002, M.VEST);
  put(roundedBox(0.074, 0.05, 0.028, 0.008, 2), PI, 0.72, 0.012, M.VEST);
  put(roundedBox(0.05, 0.03, 0.003, 0.0015, 1), PI, 0.5, 0.002, M.CRIMSON);
  // bungee straps across the cover
  if (LO) return;
  const bung = new Limb([0, 0.4, 0.8, 1.2, 1.6, 2.0, 2.4, 2.8, 3.2, 3.6, 4.0, 4.4, 4.8, 5.2, 5.6, 6.0].map((a) => helmPoint(a, 0.8, V3(), 0.004)).concat([helmPoint(0, 0.8, V3(), 0.004)]), V3(0, 1, 0), 64);
  b.add(bung.tube(6, Math.max(24, Math.round(64 * q)), () => 0.0022, { capStart: false, capEnd: false }), { mat: M.WEBBING, bone: 'head' });

  // chin strap (webbing) from the helmet side down under the jaw
  for (const s of [1, -1]) {
    const a = helmPoint(s * 1.5, 0.97, V3(), -0.012);
    const pts = [a, V3(s * 0.078, -0.03, 0.02).add(HEAD_C), V3(s * 0.058, -0.088, 0.045).add(HEAD_C), V3(s * 0.012, -0.112, 0.066).add(HEAD_C), V3(-s * 0.006, -0.113, 0.068).add(HEAD_C)];
    const strap = new Limb(pts, V3(0, 0, 1), 32).tube(6, Math.max(6, Math.round(14 * q)), () => [0.0085, 0.0022]);
    b.add(strap, { mat: M.WEBBING, bone: 'head' });
  }
}

function buildHeadset(b, q) {
  for (const s of [1, -1]) {
    const cup = ellipsoid(0.028, 0.044, 0.038, Math.max(8, Math.round(18 * q)), Math.max(6, Math.round(10 * q)), 0.7, 0.8);
    cup.map((v) => v.add(V3(s * 0.093, 0.0, -0.002).add(HEAD_C)));
    b.add(cup, { mat: M.POLYMER, bone: 'head' });
    const ring = ellipsoid(0.012, 0.047, 0.041, Math.max(8, Math.round(18 * q)), 6);
    ring.map((v) => v.add(V3(s * 0.08, 0.0, -0.002).add(HEAD_C)));
    b.add(ring, { mat: M.RUBBER, bone: 'head' });
  }
  // headband over the crown
  const pts = [];
  for (let i = 0; i <= 10; i++) {
    const a = -PI / 2 + (i / 10) * PI;
    pts.push(V3(Math.sin(a) * 0.098, Math.cos(a) * 0.132 + 0.005, -0.004).add(HEAD_C));
  }
  b.add(new Limb(pts, V3(0, 0, 1), 32).tube(8, Math.max(8, Math.round(24 * q)), () => [0.012, 0.0045]), { mat: M.POLYMER, bone: 'head' });
  // boom mic
  const mic = [V3(-0.1, -0.01, 0.015), V3(-0.09, -0.045, 0.06), V3(-0.05, -0.065, 0.095), V3(-0.02, -0.06, 0.104)].map((v) => v.add(HEAD_C));
  b.add(new Limb(mic, V3(0, 1, 0), 16).tube(6, 10, () => 0.0025), { mat: M.POLYMER, bone: 'head' });
  const cap = ellipsoid(0.034, 0.03, 0.028, 10, 8);
  // watch cap (knit beanie) over the balaclava
  const beanie = surface(Math.max(12, Math.round(44 * q)), Math.max(4, Math.round(10 * q)), (u, v, o) => {
    headBase(u, lerp(0.0, 0.34, v), o);
    const nn = _t1.copy(o).normalize();
    o.addScaledVector(nn, 0.009 + 0.004 * smooth(0.8, 1, v) + 0.001 * Math.sin(u * PI * 2 * 30)).add(HEAD_C);
  }, { wrapU: true });
  beanie.computeNormals();
  if (beanie.n[1] < 0) { beanie.flip(); beanie.computeNormals(); }
  b.add(beanie, { mat: M.KNIT, bone: 'head' });
  void cap;
}

// ============================================================================ arms
const ARM_K = keyed([
  [0.00, 0.020, 0.020],
  [0.03, 0.052, 0.053],
  [0.08, 0.067, 0.068],
  [0.16, 0.069, 0.070],
  [0.28, 0.061, 0.066],
  [0.42, 0.054, 0.060],
  [0.55, 0.052, 0.053],
  [0.64, 0.055, 0.052],
  [0.78, 0.048, 0.044],
  [0.92, 0.040, 0.036],
  [1.00, 0.036, 0.033],
]);
function armLimb() {
  const S = J('upperarmL'), E = J('forearmL'), H = J('handL');
  const fd = H.clone().sub(E).normalize();
  return new Limb([S.clone().add(V3(0.016, 0.052, -0.002)), S, E, H.clone().addScaledVector(fd, 0.012)], V3(1, 0, 0));
}
function sleeveRadius(limb, s, th) {
  const k = ARM_K(s);
  const L = limb.length;
  const elbow = gauss(s - 0.56, 0.085);
  const fold = 0.0038 * Math.sin((s * L) / 0.027 * 2 * PI + 1.9 * Math.sin(th + 0.4)) * elbow * (0.45 + 0.55 * Math.max(0, Math.sin(th)));
  const upper = 0.0016 * Math.sin((s * L) / 0.05 * 2 * PI + 3 * th) * gauss(s - 0.25, 0.1);
  const noise = 0.0012 * fbm3(s * 20, Math.cos(th) * 3, Math.sin(th) * 3, 2);
  const d = fold + upper + noise;
  return [k[0] + d, k[1] + d];
}

function buildArms(b, q) {
  const limb = armLimb();
  const sleeve = limb.tube(Math.max(8, Math.round(22 * q)), Math.max(10, Math.round(46 * q)), (s, th) => sleeveRadius(limb, s, th));
  addSym(b, sleeve, (sd) => ({ mat: M.FATIGUE, bones: ['clav' + sd, 'upperarm' + sd, 'forearm' + sd, 'hand' + sd], k: 6, dirt: 0.12 }));

  // crimson armband (left arm only) with a folded edge
  const band = limb.tube(Math.max(8, Math.round(22 * q)), Math.max(4, Math.round(10 * q)), (s, th) => {
    const r = sleeveRadius(limb, s, th);
    const e = Math.sin(clamp((s - 0.215) / (0.325 - 0.215), 0, 1) * PI);
    const d = 0.0055 * Math.pow(e, 0.35) - 0.0015 + 0.0009 * Math.sin(th * 7 + s * 90);
    return [r[0] + d, r[1] + d];
  }, { s0: 0.215, s1: 0.325, capStart: false, capEnd: false });
  b.add(band, { mat: M.CRIMSON, bones: ['clavL', 'upperarmL', 'forearmL'], k: 6 });
  if (LO) return;
  // velcro shoulder patch (right arm) with a small crimson flash
  const patchR = limb.patch(Math.max(4, Math.round(10 * q)), Math.max(3, Math.round(8 * q)), 0.13, 0.25, -0.75, 0.5, (s, th, u, v) => {
    const r = sleeveRadius(limb, s, th);
    const d = 0.0035 * edgeFactor(u, v, 0.2, 0.2) - 0.001;
    return [r[0] + d, r[1] + d];
  });
  patchR.computeNormals();
  b.add(mirrorX(patchR), { mat: M.VEST, bones: ['clavR', 'upperarmR', 'forearmR'], k: 6 });
  // sleeve pocket flap (left)
  const pocket = limb.patch(Math.max(4, Math.round(10 * q)), Math.max(3, Math.round(8 * q)), 0.1, 0.2, -0.55, 0.65, (s, th, u, v) => {
    const r = sleeveRadius(limb, s, th);
    const d = 0.004 * edgeFactor(u, v, 0.18, 0.25) - 0.001;
    return [r[0] + d, r[1] + d];
  });
  b.add(pocket, { mat: M.FATIGUE, bones: ['clavL', 'upperarmL', 'forearmL'], k: 6 });
}

// ============================================================================ hands (gloved, gripping)
/** Right hand in canonical coords: x = index side (T), y = wrist->knuckles (L), z = palm normal (P). */
export const GRIP_C = V3(0, 0.072, 0.035); // centre of the gripped cylinder (canonical)

function buildHandCanonical(q) {
  const hand = new Part();
  // palm / back of hand
  const palm = roundedBox(0.082, 0.096, 0.03, 0.013, Math.max(1, Math.round(3 * q)));
  palm.map((v) => {
    const t = clamp((v.y + 0.048) / 0.096, 0, 1);
    v.x *= lerp(0.8, 1, smooth(0, 0.6, t));
    v.z *= lerp(0.9, 1.05, t);
    v.y += 0.046;
    v.z -= 0.002;
  });
  hand.merge(palm);
  // fingers wrap around GRIP_C (axis x)
  const R = 0.027;
  const fingers = [[0.029, 0.0098, 2.62], [0.0095, 0.0102, 2.72], [-0.0105, 0.0098, 2.6], [-0.029, 0.0088, 2.35]];
  for (const [fx, fr, end] of fingers) {
    const pts = [];
    const a0 = -1.12;
    for (let i = 0; i <= 8; i++) {
      const a = lerp(a0, end, i / 8);
      pts.push(V3(fx * (1 - 0.08 * i / 8), GRIP_C.y + Math.cos(a) * R, GRIP_C.z + Math.sin(a) * R));
    }
    const f = new Limb(pts, V3(1, 0, 0), 24).tube(Math.max(6, Math.round(10 * q)), Math.max(6, Math.round(14 * q)), (s, th) => {
      const knuckle = 0.0012 * (gauss(s - 0.36, 0.05) + gauss(s - 0.7, 0.05));
      return fr * (1 - 0.12 * smooth(0.75, 1, s)) + knuckle;
    });
    hand.merge(f);
  }
  // thumb: from the base of the palm on the index side, wrapping over the grip
  const thumb = new Limb([V3(0.03, 0.012, 0.004), V3(0.047, 0.04, 0.026), V3(0.042, 0.062, 0.056), V3(0.022, 0.077, 0.068)], V3(0, 0, 1), 24)
    .tube(Math.max(6, Math.round(10 * q)), Math.max(6, Math.round(12 * q)), (s) => lerp(0.0135, 0.0098, s));
  hand.merge(thumb);
  // knuckle armour pad on the back of the hand
  const pad = roundedBox(0.074, 0.024, 0.008, 0.0035, 1);
  pad.map((v) => { v.y += 0.086; v.z -= 0.018; });
  hand.merge(pad);
  return hand;
}

function handMatrix(side) {
  const hb = HAND_BIND[side];
  const L = V3(...hb.L), P = V3(...hb.P);
  const T = new THREE.Vector3().crossVectors(L, P);
  return mat4Basis(T, L, P, J('hand' + side));
}

function buildHands(b, q) {
  const handR = buildHandCanonical(q);
  handR.applyMatrix4(handMatrix('R'));
  b.add(handR, { mat: M.GLOVE, bone: 'handR' });
  const handL = mirrorX(handR);
  b.add(handL, { mat: M.GLOVE, bone: 'handL' });
  // glove cuffs over the sleeve ends
  const limb = armLimb();
  const cuff = limb.tube(Math.max(8, Math.round(16 * q)), Math.max(3, Math.round(6 * q)), (s, th) => {
    const k = ARM_K(s);
    const e = smooth(0.905, 0.925, s);
    const d = 0.0045 * e + 0.001;
    return [k[0] + d, k[1] + d];
  }, { s0: 0.905, s1: 1.0, capStart: false, capEnd: true });
  addSym(b, cuff, (sd) => ({ mat: M.GLOVE, bones: ['forearm' + sd, 'hand' + sd], k: 6 }));
}

// ============================================================================ legs
const LEG_K = keyed([
  [0.00, 0.050, 0.050],
  [0.05, 0.094, 0.096],
  [0.12, 0.103, 0.105],
  [0.25, 0.097, 0.097],
  [0.40, 0.086, 0.086],
  [0.52, 0.075, 0.077],
  [0.58, 0.071, 0.076],
  [0.68, 0.072, 0.078],
  [0.80, 0.067, 0.071],
  [0.88, 0.065, 0.067],
  [0.95, 0.053, 0.055],
  [1.00, 0.040, 0.040],
]);
function legLimb() {
  const H = J('thighL'), K = J('shinL'), A = J('footL');
  return new Limb([H.clone().add(V3(0.01, 0.075, -0.004)), H, K, A.clone().add(V3(0, 0.035, 0.004))], V3(1, 0, 0));
}
function pantsRadius(limb, s, th) {
  const k = LEG_K(s);
  const L = limb.length;
  const back = Math.max(0, -Math.sin(th)), front = Math.max(0, Math.sin(th));
  // creases behind the knee, bunching over the boots, diagonal thigh folds
  const knee = 0.004 * Math.sin((s * L) / 0.03 * 2 * PI + 1.2 * Math.cos(th)) * gauss(s - 0.585, 0.05) * (0.3 + back);
  const blouse = 0.0052 * Math.sin((s * L) / 0.024 * 2 * PI + 2.6 * Math.sin(2 * th + 0.5)) * smooth(0.78, 0.86, s) * smooth(0.97, 0.9, s);
  const thigh = 0.0022 * Math.sin((s * L) / 0.07 * 2 * PI + 2.5 * th) * gauss(s - 0.22, 0.12);
  const noise = 0.0015 * fbm3(s * 16, Math.cos(th) * 2.5, Math.sin(th) * 2.5, 2);
  const knee2 = 0.004 * gauss(s - 0.575, 0.03) * front; // knee bulge
  const d = knee + blouse + thigh + noise + knee2 + 0.004 * smooth(0.84, 0.9, s) * smooth(0.97, 0.9, s);
  return [k[0] + d, k[1] + d];
}

function buildLegs(b, q) {
  const limb = legLimb();
  const legBones = (sd) => ['pelvis', 'thigh' + sd, 'shin' + sd, 'foot' + sd];
  const pants = limb.tube(Math.max(8, Math.round(24 * q)), Math.max(12, Math.round(56 * q)), (s, th) => pantsRadius(limb, s, th));
  addSym(b, pants, (sd) => ({ mat: M.FATIGUE, bones: legBones(sd), k: 6, dirt: dirtBody }));

  // cargo pocket on the outer thigh (+ flap)
  const pocket = limb.patch(Math.max(5, Math.round(12 * q)), Math.max(5, Math.round(12 * q)), 0.25, 0.42, -0.62, 0.42, (s, th, u, v) => {
    const r = pantsRadius(limb, s, th);
    const bulge = 0.013 * edgeFactor(u, v, 0.14, 0.12) + 0.004 * edgeFactor(u, v, 0.4, 0.4) - 0.0012;
    return [r[0] + bulge, r[1] + bulge];
  });
  addSym(b, pocket, (sd) => ({ mat: M.FATIGUE, bones: legBones(sd), k: 6, dirt: dirtBody }));
  const flap = limb.patch(Math.max(5, Math.round(12 * q)), 3, 0.245, 0.29, -0.66, 0.46, (s, th, u, v) => {
    const r = pantsRadius(limb, s, th);
    const d = 0.0175 * edgeFactor(u, v, 0.08, 0.3) + 0.0035 * smooth(0.2, 1, v) - 0.0012;
    return [r[0] + d, r[1] + d];
  });
  addSym(b, flap, (sd) => ({ mat: M.FATIGUE, bones: legBones(sd), k: 6, dirt: dirtBody }));

  // knee pads
  const pad = limb.patch(Math.max(6, Math.round(14 * q)), Math.max(5, Math.round(12 * q)), 0.515, 0.645, PI / 2 - 1.05, PI / 2 + 1.05, (s, th, u, v) => {
    const r = pantsRadius(limb, s, th);
    const e = edgeFactor(u, v, 0.16, 0.18);
    const d = 0.021 * Math.pow(e, 0.5) + 0.004 * gauss(u - 0.5, 0.25) * gauss(v - 0.5, 0.25) - 0.0015;
    return [r[0] + d, r[1] + d];
  });
  addSym(b, pad, (sd) => ({ mat: M.PAD, weightFn: (p) => autoWeights(p, ['thigh' + sd, 'shin' + sd], 3).map((e) => [e[0], e[0] === B['shin' + sd] ? e[1] * 1.6 : e[1]]), dirt: 0.55 }));
  if (!LO) {
  const strap = limb.tube(Math.max(8, Math.round(18 * q)), 3, (s, th) => {
    const r = pantsRadius(limb, s, th);
    const d = 0.0035 * Math.sin(clamp((s - 0.585) / 0.02, 0, 1) * PI) - 0.001;
    return [r[0] + d, r[1] + d];
  }, { s0: 0.585, s1: 0.605, capStart: false, capEnd: false });
  addSym(b, strap, (sd) => ({ mat: M.WEBBING, bones: ['thigh' + sd, 'shin' + sd], k: 6, dirt: 0.4 }));
  }

  buildBoots(b, q);
}

// ------------------------------------------------------------------ boots
const BOOT_K = keyed([
  // z, half width, top height
  [-0.098, 0.018, 0.07],
  [-0.088, 0.036, 0.098],
  [-0.062, 0.044, 0.118],
  [-0.02, 0.046, 0.128],
  [0.03, 0.048, 0.112],
  [0.08, 0.052, 0.086],
  [0.12, 0.053, 0.068],
  [0.16, 0.050, 0.058],
  [0.19, 0.043, 0.050],
  [0.208, 0.028, 0.043],
  [0.216, 0.010, 0.036],
]);
function buildBoots(b, q) {
  const xc = 0.103;
  const bootBones = (sd) => ['shin' + sd, 'foot' + sd, 'toe' + sd];
  const dirtBoot = (p) => 0.55 + 0.35 * smooth(0.12, 0.02, p.y);
  const upper = surface(Math.max(10, Math.round(26 * q)), Math.max(10, Math.round(26 * q)), (u, v, o) => {
    const z = lerp(-0.098, 0.216, v);
    const k = BOOT_K(z);
    const psi = u * 2 * PI;
    const yb = 0.024, top = k[1];
    const mid = (yb + top) / 2, half = (top - yb) / 2;
    const c = Math.cos(psi), s = Math.sin(psi);
    const e = c > 0 ? 0.75 : 0.35;
    o.set(xc + k[0] * sgnPow(s, 0.55), mid + half * sgnPow(c, e), z);
    // toe cap seam ridge
    o.y += 0.0012 * gauss(z - 0.13, 0.004) * Math.max(0, c);
  }, { wrapU: true, capV0: true, capV1: true }).orientOutward();
  addSym(b, upper, (sd) => ({ mat: M.BOOT, bones: bootBones(sd), k: 6, dirt: dirtBoot }));

  // shaft
  const shaft = new Limb([V3(xc, 0.225, -0.024), V3(xc, 0.16, -0.022), V3(xc, 0.1, -0.016)], V3(1, 0, 0), 16)
    .tube(Math.max(10, Math.round(24 * q)), Math.max(4, Math.round(10 * q)), (s, th) => {
      const collar = 0.005 * smooth(0.12, 0.0, s);
      const lace = 0.002 * Math.max(0, Math.sin(th)) ** 8;
      return [0.051 + collar, 0.058 + collar + lace];
    }, { capStart: false, capEnd: true });
  addSym(b, shaft, (sd) => ({ mat: M.BOOT, bones: bootBones(sd), k: 6, dirt: dirtBoot }));
  // padded collar ring
  if (!LO) {
  const collar = new Limb([V3(xc, 0.236, -0.026), V3(xc, 0.214, -0.024)], V3(1, 0, 0), 4)
    .tube(Math.max(10, Math.round(24 * q)), 2, () => [0.0545, 0.0615], { capStart: true, capEnd: false });
  addSym(b, collar, (sd) => ({ mat: M.BOOT, bones: bootBones(sd), k: 6, dirt: 0.4 }));
  }
  // laces: small ridges up the instep
  if (!MID) for (let i = 0; i < 6; i++) {
    const t = i / 5;
    const y = lerp(0.105, 0.205, t), z = lerp(0.045, 0.034, t);
    const lace = roundedBox(0.034, 0.004, 0.006, 0.0018, 1);
    lace.applyMatrix4(new THREE.Matrix4().makeRotationX(-0.35 * (1 - t)).setPosition(xc, y, z));
    addSym(b, lace, (sd) => ({ mat: M.WEBBING, bones: bootBones(sd), k: 6, dirt: 0.5 }));
  }
  // rubber sole following the upper outline
  const sole = roundedBox(0.112, 0.032, 0.322, 0.008, Math.max(1, Math.round(3 * q)));
  sole.map((v) => {
    const z = v.z + 0.059;
    const k = BOOT_K(clamp(z, -0.098, 0.216));
    v.x = xc + v.x * ((k[0] + 0.0055) / 0.056);
    v.y = v.y + 0.016 + (z > 0.17 ? (z - 0.17) * 0.25 : 0); // toe spring
    v.z = z;
  });
  addSym(b, sole, (sd) => ({ mat: M.RUBBER, bones: bootBones(sd), k: 6, dirt: 0.8 }));
}

// ============================================================================ torso, vest, belt
function buildTorso(b, q) {
  const nu = Math.max(12, Math.round(40 * q)), nv = Math.max(10, Math.round(40 * q));
  const shirt = surface(nu, nv, (u, v, o) => {
    const y = lerp(0.80, 1.505, v), th = u * 2 * PI;
    torsoPoint(y, th, o);
    // shirt wrinkles at the waist and around the shoulders
    const w = 0.0018 * Math.sin(y * 150 + 3 * Math.sin(th * 2)) * gauss(y - 1.0, 0.08) + 0.0012 * fbm3(o.x * 25, o.y * 25, o.z * 25, 2);
    o.x += Math.sin(th) * w; o.z += Math.cos(th) * w;
  }, { wrapU: true, capV0: true }).orientOutward();
  b.add(shirt, { mat: M.FATIGUE, weightFn: torsoWeights, dirt: (p) => dirtBody(p) * 0.5 });

  // neck (balaclava continues down to the collar)
  const neck = surface(nu, Math.max(4, Math.round(10 * q)), (u, v, o) => {
    const y = lerp(1.478, 1.62, v), th = u * 2 * PI;
    torsoPoint(y, th, o, 0.011 * smooth(1.62, 1.5, y) + 0.006 * smooth(1.5, 1.478, y) + 0.004);
  }, { wrapU: true }).orientOutward();
  b.add(neck, { mat: M.KNIT, weightFn: torsoWeights });
  // shirt collar (mock neck)
  const collar = surface(nu, 3, (u, v, o) => {
    const y = lerp(1.47, 1.525, v), th = u * 2 * PI;
    torsoPoint(y, th, o, 0.009 * Math.sin(v * PI) + 0.004);
  }, { wrapU: true }).orientOutward();
  b.add(collar, { mat: M.FATIGUE, weightFn: torsoWeights });
}

function vestPanel(nu, nv, th0, th1, y0, yTop, base, thick, bu, bv, nBoost = 0.8, pillow = 0) {
  return surface(nu, nv, (u, v, o) => {
    const th = lerp(th0, th1, u);
    const y1 = typeof yTop === 'function' ? yTop(u) : yTop;
    const y = lerp(y0, y1, v);
    const e = edgeFactor(u, v, bu, bv);
    const pil = pillow * Math.sin(u * PI) * Math.sin(v * PI);
    torsoPoint(y, th, o, base + thick * Math.pow(e, 0.6) + pil, nBoost);
  });
}
function fixPanelFacing(part, outwardHint) {
  part.computeNormals();
  // compare average normal with the hint
  let dx = 0, dz = 0;
  for (let i = 0; i < part.n.length; i += 3) { dx += part.n[i]; dz += part.n[i + 2]; }
  if (dx * outwardHint.x + dz * outwardHint.z < 0) { part.flip(); part.computeNormals(); }
  return part;
}

function buildVest(b, q) {
  const nu = Math.max(8, Math.round(26 * q)), nv = Math.max(6, Math.round(20 * q));
  const vestOpts = { mat: M.VEST, weightFn: gearWeights, dirt: (p) => 0.18 * smooth(1.15, 1.02, p.y) };
  // front plate bag (shoulder-cut top corners)
  const front = vestPanel(nu, nv, -0.98, 0.98, 1.03, (u) => 1.43 - 0.075 * (smooth(0.3, 0.0, u) + smooth(0.7, 1.0, u)), 0.006, 0.043, 0.07, 0.06, 1.0);
  b.add(fixPanelFacing(front, V3(0, 0, 1)), vestOpts);
  // back plate bag
  const back = vestPanel(nu, nv, PI - 0.98, PI + 0.98, 1.03, (u) => 1.445 - 0.06 * (smooth(0.3, 0.0, u) + smooth(0.7, 1.0, u)), 0.006, 0.042, 0.07, 0.06, 1.0);
  b.add(fixPanelFacing(back, V3(0, 0, -1)), vestOpts);
  // cummerbunds (both sides)
  for (const s of [1, -1]) {
    const cb = vestPanel(Math.max(4, Math.round(12 * q)), Math.max(4, Math.round(10 * q)), s > 0 ? 0.72 : -PI + 0.72, s > 0 ? PI - 0.72 : -0.72, 1.045, 1.245, 0.005, 0.017, 0.05, 0.12, 0.6);
    b.add(fixPanelFacing(cb, V3(s, 0, 0)), vestOpts);
  }
  // shoulder straps
  for (const s of [1, -1]) {
    const pF = torsoPoint(1.395, s * 0.5, V3(), 0.032, 1.0);
    const pF2 = torsoPoint(1.46, s * 0.62, V3(), 0.018, 0);
    const pTop = V3(s * 0.098, 1.51, -0.02);
    const pB2 = torsoPoint(1.465, s * (PI - 0.62), V3(), 0.018, 0);
    const pB = torsoPoint(1.415, s * (PI - 0.5), V3(), 0.032, 1.0);
    const strap = new Limb([pF, pF2, pTop, pB2, pB], V3(1, 0, 0), 48).tube(Math.max(6, Math.round(10 * q)), Math.max(8, Math.round(24 * q)), (sv, th) => [0.029, 0.0085 + 0.002 * Math.max(0, Math.sin(th))], { capStart: true, capEnd: true });
    b.add(strap, vestOpts);
  }

  const place = (part, y, th, extra, standoff, mat, opts = {}) => {
    const f = torsoFrame(y, th, extra, 1.0);
    onFrame(part, f, standoff, opts.tilt || 0);
    b.add(part, { mat, weightFn: gearWeights, dirt: opts.dirt ?? 0.1 });
    return f;
  };
  const plate = 0.049;
  // triple rifle-mag pouches with flaps
  for (const th of [-0.36, 0, 0.36]) {
    place(roundedBox(0.074, 0.13, 0.036, 0.009, Math.max(1, Math.round(2 * q))), 1.125, th, plate, 0.016, M.VEST);
    place(roundedBox(0.079, 0.05, 0.012, 0.005, Math.max(1, Math.round(2 * q))), 1.18, th, plate, 0.036, M.VEST, { tilt: -0.12 });
    if (!MID) place(roundedBox(0.022, 0.018, 0.005, 0.002, 1), 1.155, th, plate, 0.043, M.WEBBING);
  }
  // admin pouch + crimson ID patch
  place(roundedBox(0.17, 0.075, 0.026, 0.008, Math.max(1, Math.round(2 * q))), 1.3, 0, plate, 0.011, M.VEST);
  place(roundedBox(0.055, 0.036, 0.003, 0.0012, 1), 1.305, 0.13, plate, 0.025, M.CRIMSON);
  if (!LO) place(roundedBox(0.05, 0.03, 0.004, 0.0015, 1), 1.305, -0.14, plate, 0.025, M.WEBBING);
  // grenade pouch (left) with frag top
  place(roundedBox(0.062, 0.092, 0.056, 0.012, Math.max(1, Math.round(2 * q))), 1.14, 1.42, 0.022, 0.026, M.VEST);
  {
    const g = ellipsoid(0.026, 0.02, 0.026, 10, 6);
    place(g, 1.2, 1.42, 0.022, 0.028, M.POLYMER);
  }
  // pistol mag pouches (right)
  for (const th of [-1.28, -1.52]) place(roundedBox(0.04, 0.095, 0.03, 0.008, 1), 1.13, th, 0.022, 0.014, M.VEST);
  // back: assault panel + radio + drag handle
  place(roundedBox(0.2, 0.25, 0.05, 0.016, Math.max(1, Math.round(3 * q))), 1.24, PI, 0.048, 0.022, M.VEST);
  place(roundedBox(0.16, 0.1, 0.02, 0.008, Math.max(1, Math.round(2 * q))), 1.2, PI, 0.048, 0.055, M.VEST);
  const radioF = place(roundedBox(0.072, 0.16, 0.046, 0.01, Math.max(1, Math.round(2 * q))), 1.3, PI - 0.62, 0.048, 0.024, M.VEST);
  place(roundedBox(0.05, 0.03, 0.036, 0.006, 1), 1.395, PI - 0.62, 0.048, 0.026, M.POLYMER);
  {
    const base = radioF.p.clone().addScaledVector(radioF.n, 0.03).addScaledVector(radioF.t, 0.11);
    const ant = [base, base.clone().add(V3(0.004, 0.12, -0.012)), base.clone().add(V3(0.012, 0.25, -0.04)), base.clone().add(V3(0.02, 0.34, -0.075))];
    b.add(new Limb(ant, V3(1, 0, 0), 24).tube(LO ? 4 : 6, LO ? 4 : 12, (s) => lerp(0.0055, 0.0028, s)), { mat: M.POLYMER, weightFn: gearWeights });
  }
  {
    const top = torsoPoint(1.45, PI, V3(), 0.05, 1.0);
    const handle = new Limb([top.clone().add(V3(0.04, -0.01, 0)), top.clone().add(V3(0.03, 0.025, -0.012)), top.clone().add(V3(-0.03, 0.025, -0.012)), top.clone().add(V3(-0.04, -0.01, 0))], V3(0, 0, 1), 16)
      .tube(6, 12, () => [0.012, 0.004]);
    b.add(handle, { mat: M.WEBBING, weightFn: gearWeights });
  }
  // tourniquet on the left shoulder strap
  if (!LO) {
    const f = torsoFrame(1.43, 0.52, 0.045, 1.0);
    const tq = new Limb([V3(0, -0.035, 0), V3(0, 0.035, 0)], V3(1, 0, 0), 4).tube(10, 4, () => 0.014);
    onFrame(tq, f, 0.01);
    b.add(tq, { mat: M.WEBBING, weightFn: gearWeights });
  }
}

function buildBelt(b, q) {
  const nu = Math.max(12, Math.round(40 * q));
  const belt = surface(nu, 4, (u, v, o) => {
    const th = u * 2 * PI, y = lerp(0.975, 1.04, v);
    const e = Math.sin(v * PI);
    torsoPoint(y, th, o, 0.004 + 0.012 * Math.pow(e, 0.4), 0.3);
  }, { wrapU: true }).orientOutward();
  b.add(belt, { mat: M.WEBBING, weightFn: gearWeights, dirt: 0.2 });
  const place = (part, y, th, extra, standoff, mat) => {
    const f = torsoFrame(y, th, extra, 0.3);
    onFrame(part, f, standoff);
    b.add(part, { mat, weightFn: gearWeights, dirt: 0.25 });
  };
  place(roundedBox(0.06, 0.042, 0.012, 0.004, 1), 1.007, 0, 0.016, 0.004, M.HARDWARE);
  place(roundedBox(0.105, 0.13, 0.05, 0.016, Math.max(1, Math.round(2 * q))), 0.965, -2.35, 0.016, 0.02, M.VEST);
  place(roundedBox(0.12, 0.09, 0.06, 0.014, Math.max(1, Math.round(2 * q))), 0.99, 2.45, 0.016, 0.026, M.VEST);
  place(roundedBox(0.045, 0.1, 0.032, 0.008, 1), 0.975, 1.35, 0.016, 0.015, M.VEST);
}

// ============================================================================ weapon ("Warden"-class carbine, AI issue)
/** Weapon local anchors (+Z forward, +Y up, +X left). */
export const WEAPON = {
  muzzle: V3(0, 0.0, 0.497),
  eject: V3(-0.018, 0.013, -0.02),
  butt: V3(0, -0.028, -0.385),
  // right hand pistol grip: grip centre + axis (index side) + palm normal
  gripR: { c: V3(0, -0.066, -0.098), t: V3(0, Math.cos(0.38), Math.sin(0.38)), p: V3(1, 0, 0) },
  // left hand under the handguard
  gripL: { c: V3(-0.004, -0.006, 0.175), t: V3(0, 0, 1), p: V3(-0.3, 1, 0).normalize() },
  magLocal: V3(0, -0.045, 0.005),
  sight: V3(0, 0.083, 0.01),
};

function buildWeapon(b, q) {
  const W0 = J('weapon');
  const addW = (part, mat, bone = 'weapon', wear = 0.15) => {
    part.map((v) => v.add(W0));
    b.add(part, { mat, bone, wear });
  };
  const rb = (w, h, d, r, x, y, z, rx = 0, seg = 1) => {
    const p = roundedBox(w, h, d, r, Math.max(1, Math.round(seg * q)));
    p.applyMatrix4(new THREE.Matrix4().makeRotationX(rx).setPosition(x, y, z));
    return p;
  };
  // receivers
  addW(rb(0.03, 0.044, 0.195, 0.004, 0, 0.011, -0.03, 0, 2), M.GUNMETAL);
  addW(rb(0.028, 0.044, 0.16, 0.005, 0, -0.026, -0.042, 0, 2), M.GUNMETAL);
  addW(rb(0.033, 0.05, 0.074, 0.005, 0, -0.049, 0.015, -0.05, 1), M.GUNMETAL);
  // top rail with teeth
  addW(rb(0.021, 0.007, 0.19, 0.0015, 0, 0.036, -0.03), M.GUNMETAL);
  if (q > 0.6) for (let i = 0; i < 13; i++) addW(flatBox(0.022, 0.004, 0.0055).applyMatrix4(new THREE.Matrix4().setPosition(0, 0.041, -0.118 + i * 0.0138)), M.GUNMETAL);
  // ejection port cover + forward assist + charging handle + selector
  if (!MID) {
  addW(rb(0.003, 0.02, 0.05, 0.001, -0.0162, 0.012, -0.02), M.GUNMETAL);
  addW(new Limb([V3(-0.012, 0.022, -0.075), V3(-0.024, 0.024, -0.07)], V3(0, 1, 0), 2).tube(8, 1, () => 0.006), M.GUNMETAL);
  addW(rb(0.03, 0.01, 0.018, 0.003, 0, 0.03, -0.132), M.GUNMETAL);
  addW(rb(0.008, 0.006, 0.014, 0.002, 0.016, -0.02, -0.075), M.HARDWARE);
  }
  // pistol grip
  addW(rb(0.029, 0.1, 0.038, 0.009, 0, -0.07, -0.1, -0.38, 2), M.POLYMER);
  // trigger guard + trigger
  addW(rb(0.012, 0.005, 0.064, 0.002, 0, -0.058, -0.052), M.GUNMETAL);
  if (!MID) addW(rb(0.004, 0.018, 0.006, 0.0015, 0, -0.044, -0.058, 0.3), M.GUNMETAL);
  // buffer tube + stock + butt pad + cheek riser
  addW(cylinderZ(0.0145, 0.0145, -0.31, -0.12, Math.max(8, Math.round(14 * q)), 1), M.GUNMETAL);
  {
    const stock = roundedBox(0.042, 0.1, 0.165, 0.012, Math.max(1, Math.round(2 * q)));
    stock.map((v) => {
      const t = clamp((v.z + 0.0825) / 0.165, 0, 1); // 0 rear .. 1 front
      if (v.y < 0) v.y *= lerp(1.12, 0.45, t);
      else v.y *= lerp(1.0, 0.6, t);
      v.z += -0.293; v.y += -0.012;
    });
    addW(stock, M.POLYMER);
  }
  addW(rb(0.044, 0.118, 0.018, 0.006, 0, -0.022, -0.382, 0, 1), M.RUBBER);
  // handguard (octagonal-ish M-LOK tube) + slots + top rail
  addW(cylinderZ(0.0245, 0.0245, 0.066, 0.345, Math.max(8, Math.round(16 * q)), 1, { square: 1.8 }), M.GUNMETAL);
  addW(rb(0.02, 0.006, 0.275, 0.0015, 0, 0.027, 0.205), M.GUNMETAL);
  if (q > 0.6) {
    for (let i = 0; i < 4; i++) {
      const z = 0.11 + i * 0.058;
      for (const s of [1, -1]) addW(flatBox(0.002, 0.009, 0.032).applyMatrix4(new THREE.Matrix4().setPosition(s * 0.0232, -0.002, z)), M.POLYMER);
      addW(flatBox(0.009, 0.002, 0.032).applyMatrix4(new THREE.Matrix4().setPosition(0, -0.0235, z)), M.POLYMER);
    }
  }
  // barrel, gas block, muzzle brake
  addW(cylinderZ(0.0088, 0.0082, 0.34, 0.445, Math.max(6, Math.round(12 * q)), 1), M.GUNMETAL);
  addW(rb(0.02, 0.022, 0.018, 0.003, 0, 0.004, 0.36), M.GUNMETAL);
  addW(cylinderZ(0.0128, 0.0128, 0.44, 0.497, Math.max(6, Math.round(12 * q)), 1), M.GUNMETAL);
  if (q > 0.6) for (let i = 0; i < 3; i++) for (const s of [1, -1]) addW(flatBox(0.002, 0.012, 0.007).applyMatrix4(new THREE.Matrix4().setPosition(s * 0.0122, 0, 0.452 + i * 0.013)), M.POLYMER);
  // angled fore-grip
  addW(rb(0.024, 0.03, 0.06, 0.008, 0, -0.03, 0.29, 0.2), M.POLYMER);
  // holographic sight: base, hood, windows
  addW(rb(0.032, 0.016, 0.078, 0.003, 0, 0.049, 0.008), M.POLYMER);
  for (const s of [1, -1]) addW(rb(0.005, 0.04, 0.062, 0.002, s * 0.0165, 0.074, 0.008), M.POLYMER);
  addW(rb(0.038, 0.005, 0.068, 0.0022, 0, 0.096, 0.008), M.POLYMER);
  addW(flatBox(0.029, 0.034, 0.002).applyMatrix4(new THREE.Matrix4().setPosition(0, 0.076, 0.036)), M.LENS);
  addW(flatBox(0.029, 0.034, 0.002).applyMatrix4(new THREE.Matrix4().setPosition(0, 0.076, -0.02)), M.LENS);
  if (!MID) addW(rb(0.012, 0.012, 0.012, 0.003, -0.02, 0.06, -0.01), M.POLYMER);
  // sling (webbing) from the stock to the handguard front, hanging below
  {
    const pts = [V3(-0.005, -0.06, -0.33), V3(-0.02, -0.16, -0.18), V3(-0.022, -0.17, 0.02), V3(-0.012, -0.1, 0.2), V3(-0.02, -0.02, 0.32)];
    addW(new Limb(pts, V3(1, 0, 0), 48).tube(6, Math.max(10, Math.round(26 * q)), () => [0.0045, 0.013]), M.WEBBING);
  }
  // magazine (curved polymer) on its own bone
  {
    const mag = surface(Math.max(8, Math.round(16 * q)), Math.max(4, Math.round(10 * q)), (u, v, o) => {
      const psi = u * 2 * PI;
      const L = 0.19, bend = 0.28, R = L / bend;
      const a = v * bend;
      const hw = 0.0135, hd = lerp(0.033, 0.036, v);
      const c = Math.cos(psi), sn = Math.sin(psi);
      const lx = hw * sgnPow(sn, 0.3), lz = hd * sgnPow(c, 0.3);
      // centreline curving forward; cross-section follows the curve normal (0, sin a, cos a)
      o.set(lx, -R * Math.sin(a) + Math.sin(a) * lz - 0.03, R * (1 - Math.cos(a)) + Math.cos(a) * lz + 0.013);
    }, { wrapU: true, capV0: true, capV1: true }).orientOutward();
    addW(mag, M.POLYMER, 'mag', 0.1);
    const plateB = roundedBox(0.032, 0.012, 0.078, 0.004, 1);
    plateB.applyMatrix4(new THREE.Matrix4().makeRotationX(-0.28).setPosition(0, -0.221, 0.04));
    addW(plateB, M.POLYMER, 'mag', 0.2);
  }
}

// ============================================================================ assembly
export function buildSoldierGeometry({ q = 1, variant = { helmet: 'helmet', glasses: true } } = {}) {
  LO = q < 0.4; MID = q < 0.8;
  setRoundedBoxMax(LO ? 0 : MID ? 1 : 99);
  const b = new SoldierBuilder();
  buildTorso(b, q);
  buildArms(b, q);
  buildHands(b, q);
  buildLegs(b, q);
  buildVest(b, q);
  buildBelt(b, q);
  buildWeapon(b, q);
  const headStart = b.count; // everything before this is identical across variants
  buildHead(b, q, variant);
  const g = b.toGeometry();
  g.userData.variant = variant;
  g.userData.headStart = headStart;
  setRoundedBoxMax(99);
  return g;
}

export { HEAD_C };

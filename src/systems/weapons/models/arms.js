import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { box, lathe, alongZ, sideX, fillet, rrect, xf, flipWinding } from '../geo.js';

/**
 * First-person arms: gloved hands + multicam sleeves, generated procedurally as SkinnedMeshes.
 *
 * Hand frame (bind pose, right hand): wrist at origin, fingers along -Z, back of hand +Y, palm -Y,
 * thumb on -X (pinky +X). The left hand is the exact mirror (x -> -x). Forearm runs from the wrist to the
 * elbow along +Z, upper arm continues to the shoulder.
 *
 * Bones: upper, fore, hand (flat, children of the rig group, driven by IK every frame) and finger chains
 * (children of hand): f0..f3 x 3 phalanges, thumb x 3.
 */

const DEG = Math.PI / 180;
const FORE_LEN = 0.27;
const UPPER_LEN = 0.30;

export const HAND = {
  fingers: [
    { name: 'index', mcp: [-0.0285, 0.0005, -0.0925], len: [0.0455, 0.0265, 0.0225], r: [0.0101, 0.0094, 0.0087], spread: -3.5 },
    { name: 'middle', mcp: [-0.0092, 0.0022, -0.0965], len: [0.0495, 0.0305, 0.0245], r: [0.0105, 0.0098, 0.0089], spread: -0.5 },
    { name: 'ring', mcp: [0.0102, 0.0008, -0.0935], len: [0.0465, 0.0285, 0.0235], r: [0.0101, 0.0093, 0.0085], spread: 2.5 },
    { name: 'pinky', mcp: [0.0278, -0.0022, -0.0858], len: [0.0365, 0.0215, 0.0205], r: [0.0089, 0.0082, 0.0076], spread: 6 },
  ],
  // thumb metacarpal: CMC joint, rest direction (bone -Z) and nail direction (bone +Y) in hand space (right hand)
  thumb: { cmc: [-0.0205, -0.0105, -0.024], dir: [-0.60, -0.34, -0.72], nail: [-0.72, 0.62, -0.1], len: [0.042, 0.0325, 0.028], r: [0.0146, 0.0122, 0.0112] },
};

/**
 * Named finger poses (right-hand convention). f: [mcp, pip, dip, spread] deg per finger (flex toward the palm);
 * t: [cmcFlex (toward palm), cmcAbd (sideways, + = away from the index), cmcRoll, mcp, ip].
 * Grip poses are "closing targets": the grasp solver stops each chain at first contact with the weapon colliders.
 */
export const POSES = {
  relaxed: { f: [[18, 22, 12, 0], [22, 26, 14, 0], [26, 30, 16, 0], [30, 32, 18, 0]], t: [10, 0, 0, 10, 10] },
  open: { f: [[4, 6, 4, -2], [4, 6, 4, 0], [5, 6, 4, 2], [6, 8, 5, 4]], t: [0, 10, 0, 0, 0] },
  flat: { f: [[2, 2, 0, 0], [2, 2, 0, 0], [2, 2, 0, 0], [2, 2, 0, 0]], t: [0, 5, 0, 0, 0] },
  fist: { f: [[85, 100, 60, 0], [88, 100, 60, 0], [90, 100, 60, 0], [92, 100, 60, 0]], t: [40, -10, 20, 40, 35] },
  // right hand on the pistol grip, trigger finger indexed on the trigger
  gripTrigger: { f: [[40, 55, 30, -6], [95, 100, 70, 0], [95, 100, 70, 2], [95, 100, 70, 6]], t: [40, -10, 25, 30, 25] },
  gripTriggerPull: { f: [[48, 70, 38, -6], [95, 100, 70, 0], [95, 100, 70, 2], [95, 100, 70, 6]], t: [40, -10, 25, 30, 25] },
  // trigger finger straight along the receiver (safe / sprint)
  gripIndexOut: { f: [[8, 10, 5, -2], [95, 100, 70, 0], [95, 100, 70, 2], [95, 100, 70, 6]], t: [40, -10, 25, 30, 25] },
  // left hand around the vertical foregrip
  gripVert: { f: [[95, 100, 70, -2], [95, 100, 70, 0], [95, 100, 70, 2], [95, 100, 70, 5]], t: [45, -10, 25, 35, 30] },
  // around a magazine body
  magGrab: { f: [[80, 90, 60, -2], [85, 90, 60, 0], [88, 90, 60, 2], [90, 90, 60, 4]], t: [40, 0, 25, 30, 25] },
  // thumb pressing (bolt catch / slide release)
  press: { f: [[60, 70, 40, 0], [66, 76, 44, 0], [70, 80, 46, 2], [74, 82, 48, 4]], t: [5, 15, 0, 5, 5] },
  // holding a pistol: support hand wrapping the strong hand
  supportWrap: { f: [[70, 80, 50, -2], [75, 85, 50, 0], [80, 85, 50, 2], [85, 85, 50, 4]], t: [15, 15, 10, 10, 5] },
  // grenade in palm
  grenade: { f: [[60, 70, 45, -4], [65, 75, 45, 0], [70, 75, 45, 3], [72, 75, 45, 6]], t: [35, 0, 25, 25, 20] },
};

// ------------------------------------------------------------------------------------------- helpers

function hash(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
function vnoise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i + seed * 57) * (1 - u) + hash(i + 1 + seed * 57) * u;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Build an indexed tube through rings; ring = { z, rx, ry, cx, cy, s } (s = arc length param for weights).
 * Closes the far end with a rounded cap when capEnd.
 * vfn(ring, angle, p:Vector3) may displace p. Returns { geo, meta: [{ringIndex, angle}] }
 */
function tubeGeo(rings, RS, { capEnd = false, capStart = false, vfn = null } = {}) {
  const pos = [];
  const meta = [];
  const p = new THREE.Vector3();
  rings.forEach((r, ri) => {
    for (let j = 0; j < RS; j++) {
      const a = (j / RS) * Math.PI * 2;
      // superellipse-ish cross-section
      const ca = Math.cos(a), sa = Math.sin(a);
      const e = r.e ?? 2.0;
      const cx = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / e);
      const sy = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / e);
      p.set((r.cx || 0) + cx * r.rx, (r.cy || 0) + sy * (sa > 0 ? r.ry : (r.ryb ?? r.ry)), r.z);
      if (vfn) vfn(r, a, p, ri);
      pos.push(p.x, p.y, p.z);
      meta.push({ ri, a, s: r.s ?? 0 });
    }
  });
  const idx = [];
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < RS; j++) {
      const a = i * RS + j, b = i * RS + ((j + 1) % RS), c = (i + 1) * RS + j, d = (i + 1) * RS + ((j + 1) % RS);
      // rings go toward -z; winding so normals face outward
      idx.push(a, c, b, b, c, d);
    }
  }
  const addCap = (ringIdx, flip) => {
    const r = rings[ringIdx];
    const cIndex = pos.length / 3;
    let sx = 0, sy = 0, sz = 0;
    for (let j = 0; j < RS; j++) { sx += pos[(ringIdx * RS + j) * 3]; sy += pos[(ringIdx * RS + j) * 3 + 1]; sz += pos[(ringIdx * RS + j) * 3 + 2]; }
    pos.push(sx / RS, sy / RS, sz / RS);
    meta.push({ ri: ringIdx, a: 0, s: r.s ?? 0, cap: true });
    for (let j = 0; j < RS; j++) {
      const a = ringIdx * RS + j, b = ringIdx * RS + ((j + 1) % RS);
      if (flip) idx.push(cIndex, b, a); else idx.push(cIndex, a, b);
    }
  };
  if (capEnd) addCap(rings.length - 1, true);
  if (capStart) addCap(0, false);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return { geo, meta };
}

function setSkin(geo, fn) {
  const n = geo.attributes.position.count;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const tmp = [];
  for (let i = 0; i < n; i++) {
    tmp.length = 0;
    fn(i, tmp); // push [boneIndex, weight]
    tmp.sort((a, b) => b[1] - a[1]);
    let tot = 0;
    for (let k = 0; k < 4 && k < tmp.length; k++) tot += tmp[k][1];
    for (let k = 0; k < 4; k++) {
      if (k < tmp.length && tot > 0) { si[i * 4 + k] = tmp[k][0]; sw[i * 4 + k] = tmp[k][1] / tot; }
    }
    if (tot === 0) { si[i * 4] = 0; sw[i * 4] = 1; }
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
}

function setMask(geo, fn) {
  const n = geo.attributes.position.count;
  const m = new Float32Array(n * 4);
  const out = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    out[0] = out[1] = out[2] = out[3] = 0;
    fn(i, out);
    m.set(out, i * 4);
  }
  geo.setAttribute('aMask', new THREE.Float32BufferAttribute(m, 4));
}

function mirrorGeoX(geo) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setX(i, -p.getX(i));
  const nrm = geo.attributes.normal;
  if (nrm) for (let i = 0; i < nrm.count; i++) nrm.setX(i, -nrm.getX(i));
  if (geo.index) {
    const a = geo.index.array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    geo.index.needsUpdate = true;
  } else flipWinding(geo);
}

// ------------------------------------------------------------------------------------------- build

/**
 * @param {1|-1} side  1 = right arm, -1 = left arm (mirror)
 * @returns arm object with bones, meshes and pose/IK helpers
 */
export function buildArm(side, mats, layer, { watch = false } = {}) {
  const S = side;
  const group = new THREE.Group();
  group.name = side > 0 ? 'armR' : 'armL';

  // ---------------------------------------------------------------- skeleton (bind pose)
  const bones = [];
  const mk = (name, parent, pos, quat = null) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(pos[0], pos[1], pos[2]);
    if (quat) b.quaternion.copy(quat);
    (parent || group).add(b);
    bones.push(b);
    return b;
  };
  const upper = mk('upper', null, [0, 0, FORE_LEN + UPPER_LEN]);
  const fore = mk('fore', null, [0, 0, FORE_LEN]);
  const hand = mk('hand', null, [0, 0, 0]);
  const BI = { upper: 0, fore: 1, hand: 2 };
  const fingerBones = [];
  const fingerRest = [];
  HAND.fingers.forEach((F, fi) => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, (F.spread * DEG) * S * -1, 0));
    const b0 = mk(`f${fi}_0`, hand, [F.mcp[0] * S, F.mcp[1], F.mcp[2]], q);
    const b1 = mk(`f${fi}_1`, b0, [0, 0, -F.len[0]]);
    const b2 = mk(`f${fi}_2`, b1, [0, 0, -F.len[1]]);
    fingerBones.push([b0, b1, b2]);
    fingerRest.push(q.clone());
  });
  const TH = HAND.thumb;
  const thumbRestQ = new THREE.Quaternion();
  {
    const d = new THREE.Vector3().fromArray(TH.dir).normalize();
    const zA = d.clone().negate();
    const yA = new THREE.Vector3().fromArray(TH.nail);
    yA.addScaledVector(zA, -yA.dot(zA)).normalize();
    const xA = new THREE.Vector3().crossVectors(yA, zA).normalize();
    thumbRestQ.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xA, yA, zA));
    if (S < 0) thumbRestQ.set(thumbRestQ.x, -thumbRestQ.y, -thumbRestQ.z, thumbRestQ.w);
  }
  const t0 = mk('t0', hand, [TH.cmc[0] * S, TH.cmc[1], TH.cmc[2]], thumbRestQ);
  const t1 = mk('t1', t0, [0, 0, -TH.len[0]]);
  const t2 = mk('t2', t1, [0, 0, -TH.len[1]]);
  const thumbBones = [t0, t1, t2];
  const boneIndex = (b) => bones.indexOf(b);
  group.updateMatrixWorld(true);

  // hand-space bind matrices for chain roots (to place chain-local geometry)
  const handInv = new THREE.Matrix4().copy(hand.matrixWorld).invert();
  const chainMat = (b) => new THREE.Matrix4().multiplyMatrices(handInv, b.matrixWorld);

  // ---------------------------------------------------------------- GLOVE (palm + cuff loft)
  const gloveGeos = [];
  const RS = 28;
  {
    // palm loft from the glove cuff (+z) to the knuckle line (-z). Right-hand coordinates; mirrored at the end.
    const rings = [];
    const prof = [
      // z, half-width, top (dorsal), bottom (palmar), cx
      [0.062, 0.0335, 0.028, 0.030, 0.000],
      [0.050, 0.0330, 0.027, 0.029, 0.000],
      [0.030, 0.0322, 0.024, 0.026, 0.000],
      [0.014, 0.0318, 0.021, 0.0235, 0.000],
      [0.000, 0.0322, 0.0185, 0.0215, -0.0005],
      [-0.014, 0.0350, 0.0175, 0.0225, -0.0015],
      [-0.030, 0.0392, 0.0170, 0.0230, -0.0020],
      [-0.048, 0.0420, 0.0168, 0.0215, -0.0010],
      [-0.064, 0.0432, 0.0165, 0.0190, 0.0000],
      [-0.078, 0.0435, 0.0158, 0.0165, 0.0000],
      [-0.088, 0.0428, 0.0145, 0.0140, 0.0000],
      [-0.095, 0.0405, 0.0120, 0.0108, 0.0000],
      [-0.099, 0.0360, 0.0085, 0.0075, 0.0000],
    ];
    for (const [z, hw, top, bot, cx] of prof) rings.push({ z, rx: hw, ry: top, ryb: bot, cx, cy: 0, e: 2.6, s: z });
    const { geo, meta } = tubeGeo(rings, RS, {
      capEnd: true,
      vfn: (r, a, p) => {
        // knuckle line slants back toward the pinky (+x) and bows forward in the middle
        const zfront = smooth(-0.06, -0.099, r.z);
        p.z += zfront * (p.x * 0.14 + Math.abs(p.x) * 0.05);
        // thenar bulge on the palmar/thumb side near the heel
        const sa = Math.sin(a), ca = Math.cos(a);
        const th = Math.max(0, -sa) * Math.max(0, -ca) * smooth(0.01, -0.02, r.z) * smooth(-0.08, -0.045, r.z);
        p.x -= th * 0.004; p.y -= th * 0.006;
        // hypothenar (pinky-side heel)
        const hy = Math.max(0, -sa) * Math.max(0, ca) * smooth(0.012, -0.015, r.z) * smooth(-0.075, -0.04, r.z);
        p.y -= hy * 0.004;
        // metacarpal ridges on the back of the hand
        if (sa > 0.3) p.y += 0.0008 * Math.sin(p.x * 330) * smooth(-0.02, -0.06, r.z);
        // cuff: slight flare and elastic ribs
        if (r.z > 0.02) {
          const rib = 0.0006 * Math.sin(r.z * 900);
          p.x += Math.sign(p.x) * rib; p.y += Math.sign(p.y) * rib;
        }
      },
    });
    const n = geo.attributes.position.count;
    const pp = geo.attributes.position;
    const nn = geo.attributes.normal;
    setSkin(geo, (i, out) => {
      const z = pp.getZ(i), x = pp.getX(i);
      const wf = smooth(-0.004, 0.034, z);
      out.push([BI.fore, wf], [BI.hand, 1 - wf]);
      // palm front edge follows the proximal phalanges a little
      HAND.fingers.forEach((F, fi) => {
        const w = smooth(F.mcp[2] + 0.022, F.mcp[2] + 0.002, z) * Math.exp(-((x - F.mcp[0]) ** 2) / (2 * 0.0085 ** 2)) * 0.45;
        if (w > 0.01) out.push([boneIndex(fingerBones[fi][0]), w]);
      });
      const wt = smooth(-0.005, -0.03, z) * smooth(-0.075, -0.045, z) * smooth(-0.005, -0.025, x) * smooth(0.004, -0.012, pp.getY(i)) * 0.6;
      if (wt > 0.01) out.push([boneIndex(t0), wt]);
    });
    setMask(geo, (i, m) => {
      const z = pp.getZ(i), ny = nn.getY(i);
      // leather palm (palmar side, not on the cuff)
      m[2] = smooth(-0.15, -0.45, ny) * smooth(0.012, 0.0, z);
      // cuff seam line / elastic
      m[1] = z > 0.018 ? 0.4 : 0;
      m[0] = 0;
    });
    void n; void meta;
    gloveGeos.push(geo);
  }
  // fingers
  HAND.fingers.forEach((F, fi) => {
    const L = F.len, R = F.r;
    const rings = [];
    const total = L[0] + L[1] + L[2];
    const steps = 30;
    for (let k = 0; k <= steps; k++) {
      const s = -0.9 * R[0] + (total + 0.9 * R[0]) * (k / steps) * 0.93;
      const seg = s < L[0] ? 0 : s < L[0] + L[1] ? 1 : 2;
      const s0 = seg === 0 ? 0 : seg === 1 ? L[0] : L[0] + L[1];
      const u = THREE.MathUtils.clamp((s - s0) / L[seg], 0, 1);
      const rA = R[seg], rB = seg < 2 ? R[seg + 1] : R[2] * 0.88;
      let r = rA + (rB - rA) * u;
      // joint bulges (knuckles)
      const jointBulge = (js) => Math.exp(-((s - js) ** 2) / (2 * (0.35 * R[0]) ** 2));
      r *= 1 + 0.07 * jointBulge(L[0]) + 0.06 * jointBulge(L[0] + L[1]);
      // fingertip rounding
      const tipStart = total - R[2] * 1.2;
      let rx = r * 1.04, ry = r * 0.9, ryb = r * 0.98;
      if (s > tipStart) {
        const t = Math.min(1, (s - tipStart) / (total * 0.93 - tipStart + 1e-6));
        const k2 = Math.sqrt(Math.max(0, 1 - t * t * 0.55));
        rx *= k2; ry *= k2; ryb *= k2;
      }
      rings.push({ z: -s, rx, ry, ryb, cy: 0, e: 2.3, s });
    }
    // rounded tip: extra shrinking rings
    const last = rings[rings.length - 1];
    for (let k = 1; k <= 5; k++) {
      const t = k / 5;
      const c = Math.cos(t * Math.PI / 2);
      rings.push({ z: last.z - Math.sin(t * Math.PI / 2) * last.rx * 0.95, rx: last.rx * c, ry: last.ry * c, ryb: last.ryb * c, cy: -0.0015 * t, e: 2.2, s: total + t * 0.005 });
    }
    const { geo } = tubeGeo(rings, 18, { capEnd: true });
    const M = chainMat(fingerBones[fi][0]);
    // right-hand geometry: build unmirrored then place with the unmirrored chain matrix
    const pos = geo.attributes.position;
    const sArr = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) sArr[i] = -pos.getZ(i);
    const ny = new Float32Array(pos.count);
    const nrm = geo.attributes.normal;
    for (let i = 0; i < pos.count; i++) ny[i] = nrm.getY(i);
    const bi = fingerBones[fi].map(boneIndex);
    setSkin(geo, (i, out) => {
      const s = sArr[i];
      const bw = 0.32 * R[0];
      const w0 = smooth(-bw, bw, s);
      const w1 = smooth(L[0] - bw, L[0] + bw, s);
      const w2 = smooth(L[0] + L[1] - bw * 0.9, L[0] + L[1] + bw * 0.9, s);
      out.push([BI.hand, 1 - w0], [bi[0], w0 * (1 - w1)], [bi[1], w1 * (1 - w2)], [bi[2], w2]);
    });
    setMask(geo, (i, m) => {
      const s = sArr[i];
      // leather reinforcement on the palmar side of the finger and the whole fingertip
      m[2] = Math.max(smooth(-0.1, -0.5, ny[i]) * smooth(L[0] * 0.3, L[0] * 0.6, s), smooth(total - 0.013, total - 0.009, s));
      // dorsal wrinkles at the PIP/DIP joints
      const dj = Math.min(Math.abs(s - L[0]), Math.abs(s - L[0] - L[1]));
      m[1] = smooth(0.2, 0.7, ny[i]) * smooth(0.007, 0.0, dj) * (0.5 + 0.5 * Math.sin(s * 1800));
      m[0] = smooth(0.2, 0.7, ny[i]) * smooth(0.005, 0.0, dj) * 0.4;
    });
    // place: chain local -> hand space (mirror handled by using the right-hand matrix before mirroring)
    geo.applyMatrix4(M);
    gloveGeos.push(geo);
  });
  // thumb
  {
    const L = TH.len, R = TH.r;
    const total = L[0] + L[1] + L[2];
    const rings = [];
    const steps = 30;
    for (let k = 0; k <= steps; k++) {
      const s = -0.012 + (total + 0.012) * (k / steps) * 0.93;
      const seg = s < L[0] ? 0 : s < L[0] + L[1] ? 1 : 2;
      const s0 = seg === 0 ? 0 : seg === 1 ? L[0] : L[0] + L[1];
      const u = THREE.MathUtils.clamp((s - s0) / L[seg], 0, 1);
      const rA = R[seg], rB = seg < 2 ? R[seg + 1] : R[2] * 0.9;
      let r = rA + (rB - rA) * u;
      r *= 1 + 0.06 * Math.exp(-((s - L[0] - L[1]) ** 2) / (2 * 0.004 ** 2));
      // metacarpal is fleshy (thenar), flatter
      let rx = r * 1.05, ry = r * 0.92, ryb = r * 1.0;
      if (seg === 0) { rx *= 1.12; ryb *= 1.15; }
      const tipStart = total - R[2] * 1.2;
      if (s > tipStart) {
        const t = Math.min(1, (s - tipStart) / (total * 0.93 - tipStart + 1e-6));
        const k2 = Math.sqrt(Math.max(0, 1 - t * t * 0.55));
        rx *= k2; ry *= k2; ryb *= k2;
      }
      rings.push({ z: -s, rx, ry, ryb, e: 2.2, s });
    }
    const last = rings[rings.length - 1];
    for (let k = 1; k <= 5; k++) {
      const t = k / 5, c = Math.cos(t * Math.PI / 2);
      rings.push({ z: last.z - Math.sin(t * Math.PI / 2) * last.rx * 0.95, rx: last.rx * c, ry: last.ry * c, ryb: last.ryb * c, cy: -0.001 * t, e: 2.2, s: total + t * 0.005 });
    }
    const { geo } = tubeGeo(rings, 18, { capEnd: true, capStart: true });
    const pos = geo.attributes.position, nrm = geo.attributes.normal;
    const sArr = new Float32Array(pos.count), ny = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) { sArr[i] = -pos.getZ(i); ny[i] = nrm.getY(i); }
    const bi = thumbBones.map(boneIndex);
    setSkin(geo, (i, out) => {
      const s = sArr[i];
      const w0 = smooth(-0.014, 0.012, s);
      const w1 = smooth(L[0] - 0.005, L[0] + 0.005, s);
      const w2 = smooth(L[0] + L[1] - 0.0045, L[0] + L[1] + 0.0045, s);
      out.push([BI.hand, 1 - w0], [bi[0], w0 * (1 - w1)], [bi[1], w1 * (1 - w2)], [bi[2], w2]);
    });
    setMask(geo, (i, m) => {
      const s = sArr[i];
      m[2] = Math.max(smooth(-0.1, -0.5, ny[i]) * smooth(0.01, 0.025, s), smooth(total - 0.014, total - 0.009, s));
      const dj = Math.abs(s - L[0] - L[1]);
      m[1] = smooth(0.2, 0.7, ny[i]) * smooth(0.007, 0.0, dj) * (0.5 + 0.5 * Math.sin(s * 1800));
    });
    const M = chainMat(t0);
    geo.applyMatrix4(M);
    gloveGeos.push(geo);
  }
  // mirror palm for left (fingers/thumb were placed with mirrored matrices but their own cross-sections are
  // symmetric in x except winding; fix winding for mirrored chains)
  // (finger/thumb tubes are x-symmetric in their local frame, so placing them with the mirrored bone matrices
  // already yields the mirrored surface with correct winding; only the palm loft needs an explicit mirror)
  if (S < 0) mirrorGeoX(gloveGeos[0]);
  // move glove geometry from hand space to bind (rig) space: hand bone is at origin with identity -> no-op
  const gloveGeo = mergeGeometries(gloveGeos, false);
  for (const g of gloveGeos) g.dispose();
  gloveGeo.computeVertexNormals();

  // ---------------------------------------------------------------- SLEEVE (forearm + upper arm)
  let sleeveGeo;
  {
    const rings = [];
    const zs = [];
    for (let z = 0.028; z <= FORE_LEN + UPPER_LEN; z += (z < 0.1 ? 0.006 : 0.012)) zs.push(z);
    zs.reverse(); // shoulder -> opening (rings must progress toward -z)
    for (const z of zs) {
      const t = z / FORE_LEN;
      let rx, ry;
      if (z <= FORE_LEN) {
        rx = 0.0415 + 0.0095 * smooth(0.0, 1.0, t) + 0.004 * Math.sin(Math.min(1, t) * Math.PI);
        ry = 0.0385 + 0.0085 * smooth(0.0, 1.0, t);
      } else {
        const u = (z - FORE_LEN) / UPPER_LEN;
        rx = 0.055 + 0.006 * u; ry = 0.052 + 0.008 * u;
      }
      // cuff hem band
      const hem = smooth(0.046, 0.036, z) * 0.0022;
      rings.push({ z, rx: rx + hem, ry: ry + hem, cy: 0.001, e: 2.1, s: z });
    }
    // rolled rim at the opening, folding back inside (inner lining faces the axis)
    rings.push({ z: 0.0255, rx: 0.0405, ry: 0.0385, cy: 0.001, e: 2.1, s: -1 });
    rings.push({ z: 0.030, rx: 0.0385, ry: 0.0365, cy: 0.001, e: 2.1, s: -1 });
    rings.push({ z: 0.047, rx: 0.036, ry: 0.034, cy: 0.001, e: 2.1, s: -1 });
    const { geo } = tubeGeo(rings, 36, {
      vfn: (r, a, p) => {
        if (r.s < 0) return;
        const z = r.z;
        // compression folds near the cuff and at the elbow, diagonal twist folds along the forearm
        const f1 = Math.sin(z * 210 + vnoise1(a * 3, 1) * 4) * smooth(0.25, 0.06, z) * smooth(0.04, 0.06, z);
        const f2 = Math.sin(a * 3 + z * 55 + vnoise1(z * 30, 2) * 3) * 0.6;
        const f3 = Math.sin(z * 95 + a * 2 + vnoise1(a * 2 + z * 20, 3) * 5) * smooth(0.18, 0.3, z);
        const d = 0.0021 * f1 + 0.0014 * f2 + 0.0019 * f3 + 0.0008 * (vnoise1(a * 6 + z * 80, 4) - 0.5);
        p.x += Math.cos(a) * d;
        p.y += Math.sin(a) * d;
        r.__d = d;
      },
    });
    const pos = geo.attributes.position;
    // displacement mask recomputed from radius deviation
    setSkin(geo, (i, out) => {
      const z = pos.getZ(i);
      const wu = smooth(FORE_LEN - 0.03, FORE_LEN + 0.04, z);
      const wh = smooth(0.034, 0.0, z) * 0.25; // cuff lip slightly follows the hand
      out.push([BI.upper, wu], [BI.fore, (1 - wu) * (1 - wh)], [BI.hand, (1 - wu) * wh]);
    });
    const nrm = geo.attributes.normal;
    setMask(geo, (i, m) => {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const a = Math.atan2(y - 0.001, x);
      const f1 = Math.sin(z * 210 + vnoise1(a * 3, 1) * 4) * smooth(0.25, 0.06, z) * smooth(0.04, 0.06, z);
      const f3 = Math.sin(z * 95 + a * 2 + vnoise1(a * 2 + z * 20, 3) * 5) * smooth(0.18, 0.3, z);
      const fold = -(0.5 * f1 + 0.5 * f3);
      m[0] = Math.max(0, fold) * 0.8 + smooth(0.034, 0.026, z) * 0.6; // crease darkening + inside of the rim
      m[1] = 0;
      void nrm;
    });
    if (S < 0) mirrorGeoX(geo);
    sleeveGeo = geo;
  }

  // ---------------------------------------------------------------- skinned meshes
  const skeleton = new THREE.Skeleton(bones);
  const mkSkinned = (geo, mat, name) => {
    const m = new THREE.SkinnedMesh(geo, mat);
    m.name = name;
    m.layers.set(layer);
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = true;
    group.add(m);
    m.bind(skeleton, new THREE.Matrix4());
    return m;
  };
  const gloveMesh = mkSkinned(gloveGeo, mats.glove, `${group.name}:glove`);
  const sleeveMesh = mkSkinned(sleeveGeo, mats.sleeve, `${group.name}:sleeve`);

  // ---------------------------------------------------------------- rigid attachments (children of bones)
  const rigid = [];
  const attach = (bone, geo, mat, name) => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.layers.set(layer);
    m.frustumCulled = false;
    m.receiveShadow = true;
    bone.add(m);
    rigid.push(m);
    return m;
  };
  const mir = (g) => { if (S < 0) { g.scale(-1, 1, 1); flipWinding(g); } return g; };
  // knuckle armour: base plate + four domes over MCP joints (hand bone space)
  {
    const parts = [];
    const plate = alongZ(fillet([[-0.040, 0.0095], [0.040, 0.0095], [0.036, 0.0158], [0.0, 0.0182], [-0.036, 0.0158]], [0.004, 0.004, 0.006, 0.01, 0.006], 4), 0.074, 0.098, { bevel: 0.0028, seg: 3 });
    parts.push(plate);
    HAND.fingers.forEach((F) => {
      const d = box(0.0165, 0.0065, 0.018, 0.0028);
      xf(d, [F.mcp[0], F.mcp[1] + 0.0175, F.mcp[2] + 0.009 + (F.mcp[2] + 0.0925) * 0.4], [-8, 0, 0]);
      parts.push(d);
    });
    const g = mergeGeometries(parts.map((p) => p), false);
    // follow the slanted knuckle line
    const pp = g.attributes.position;
    for (let i = 0; i < pp.count; i++) pp.setZ(i, pp.getZ(i) + (pp.getX(i) * 0.14 + Math.abs(pp.getX(i)) * 0.05) * 0.9);
    g.computeVertexNormals();
    mir(g);
    attach(hand, g, mats.tpr, 'knuckles');
  }
  // proximal finger pads
  HAND.fingers.forEach((F, fi) => {
    const g = box(0.0135, 0.0042, F.len[0] * 0.55, 0.0019);
    xf(g, [0, F.r[0] * 0.86 + 0.0012, -F.len[0] * 0.52], [0, 0, 0]);
    mir(g);
    attach(fingerBones[fi][0], g, mats.tpr, `pad${fi}`);
    const g2 = box(0.0115, 0.0032, F.len[1] * 0.5, 0.0015);
    xf(g2, [0, F.r[1] * 0.86 + 0.0008, -F.len[1] * 0.5]);
    mir(g2);
    attach(fingerBones[fi][1], g2, mats.tpr, `pad2${fi}`);
  });
  // wrist strap with pull tab on the back of the hand
  {
    const strap = alongZ(fillet([[-0.034, 0.012], [0.034, 0.012], [0.03, 0.023], [0.0, 0.0255], [-0.03, 0.023]], [0.004, 0.004, 0.008, 0.012, 0.008], 4), -0.034, -0.012, { bevel: 0.0022 });
    mir(strap);
    attach(hand, strap, mats.webbing, 'strap');
    const tab = box(0.018, 0.004, 0.02, 0.0015);
    xf(tab, [0.028 * S, 0.02, 0.028], [0, 0, -30 * S]);
    attach(hand, tab, mats.tpr, 'tab');
  }
  // sleeve cuff velcro tab
  {
    const t = box(0.022, 0.0035, 0.032, 0.0014);
    xf(t, [0.036 * S, 0.028, -FORE_LEN + 0.058], [0, 0, -45 * S]);
    attach(fore, t, mats.sleeve.userData.tabMat || mats.webbing, 'cuffTab');
  }
  // watch
  if (watch) {
    const wg = new THREE.Group();
    wg.name = 'watch';
    const zc = -FORE_LEN + 0.072;
    // strap ring
    const strap = lathe([[0.0476, -0.0095], [0.0491, -0.0092], [0.0494, 0.0092], [0.0476, 0.0095]].map(([r, u]) => [r, u]), 40);
    const strapM = new THREE.Mesh(strap, mats.webbing);
    strapM.scale.set(1.0, 0.96, 1);
    strapM.position.set(0, 0.001, zc);
    wg.add(strapM);
    // case on the back of the wrist, rotated toward the thumb side
    const cs = new THREE.Group();
    const caseG = lathe([[0, -0.0045], [0.0185, -0.0045], [0.0205, -0.0025], [0.0205, 0.0035], [0.018, 0.0055], [0, 0.0055]], 36);
    caseG.rotateX(-Math.PI / 2);
    cs.add(new THREE.Mesh(caseG, mats.watchCase));
    const bezel = lathe([[0.0152, 0.0], [0.0212, 0.0], [0.0212, 0.0022], [0.0165, 0.0036], [0.0152, 0.0036]], 60);
    bezel.rotateX(-Math.PI / 2);
    const bz = new THREE.Mesh(bezel, mats.watchCase);
    bz.position.y = 0.005;
    cs.add(bz);
    const dial = new THREE.Mesh(new THREE.CircleGeometry(0.0154, 40), mats.watchDial);
    dial.rotation.x = -Math.PI / 2;
    dial.position.y = 0.0062;
    cs.add(dial);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const mk2 = new THREE.Mesh(new THREE.BoxGeometry(i % 3 === 0 ? 0.0022 : 0.0012, 0.0004, 0.0036), mats.lume);
      mk2.position.set(Math.sin(a) * 0.0122, 0.0065, -Math.cos(a) * 0.0122);
      mk2.rotation.y = -a;
      cs.add(mk2);
    }
    const hands = [[0.0012, 0.0085, 1.1], [0.0009, 0.0115, 4.2]];
    for (const [w, l, a] of hands) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(w, 0.0004, l), mats.lume);
      h.position.set(Math.sin(a) * l * 0.5, 0.0068, -Math.cos(a) * l * 0.5);
      h.rotation.y = -a;
      cs.add(h);
    }
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.0158, 40), mats.crystal);
    glass.rotation.x = -Math.PI / 2;
    glass.position.y = 0.0074;
    cs.add(glass);
    // crown / buttons
    for (const [ang, len] of [[90, 0.004], [55, 0.003], [125, 0.003]]) {
      const b = new THREE.Mesh(pin(0.0016, len), mats.watchCase);
      const a = ang * DEG;
      b.position.set(Math.cos(a) * 0.021, 0.0005, -Math.sin(a) * 0.021 * 0);
      b.position.set(0.0215, 0.0005, (ang - 90) * -0.00018);
      cs.add(b);
    }
    cs.position.set(0, 0.049, zc);
    cs.rotation.z = -18 * DEG * S;
    wg.add(cs);
    wg.rotation.z = 25 * DEG * S;
    wg.traverse((o) => { if (o.isMesh) { o.layers.set(layer); o.frustumCulled = false; o.receiveShadow = true; rigid.push(o); } });
    fore.add(wg);
  }

  // ---------------------------------------------------------------- pose & IK
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _elbow = new THREE.Vector3();

  /** pose: blended finger pose object (same shape as POSES entries). Sets bones directly (no contacts). */
  function applyFingerPose(pose) {
    for (let ci = 0; ci < 5; ci++) { loadPose(ci, pose); setChain(chains[ci], ang[ci]); }
  }

  // ---------------------------------------------------------------- grasp solver
  // Chains: 4 fingers + thumb. Each chain closes from an open base toward the pose angles along one curl
  // parameter and stops at first contact with the colliders (capsules in rig space); the joints distal to
  // the touching phalanx keep closing so the finger wraps around the object. Pure math on preallocated
  // matrices, no scene-graph updates. Angles per chain: [j0 flex, j1 flex, j2 flex, abd/spread, roll].
  const chains = [];
  HAND.fingers.forEach((F, fi) => chains.push({ thumb: false, bones: fingerBones[fi], len: [F.len[0], F.len[1], F.len[2] * 0.95], r: F.r, bit: 1 << fi, fi }));
  chains.push({ thumb: true, bones: thumbBones, len: [TH.len[0], TH.len[1], TH.len[2] * 0.95], r: TH.r, bit: 16, fi: 4 });
  const mk5 = () => [0, 1, 2, 3, 4].map(() => new Float32Array(5));
  const ang = mk5(), lo = mk5(), hi = mk5();
  const W = new Float32Array(5), W2 = new Float32Array(5);
  const _mh = new THREE.Matrix4(), _mc0 = new THREE.Matrix4(), _mc1 = new THREE.Matrix4(), _mc2 = new THREE.Matrix4();
  const _jp = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const _one = new THREE.Vector3(1, 1, 1);
  const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _tv = new THREE.Vector3(), _ax = new THREE.Vector3(1, 0, 0);
  const _ea = new THREE.Euler();
  let cols = null, ncol = 0;
  const SQUISH = 0.8; // glove padding compresses a little on contact

  function loadPose(ci, pose) {
    const A = ang[ci];
    if (ci === 4) { const t = pose.t; A[0] = t[0]; A[1] = t[3]; A[2] = t[4]; A[3] = t[1]; A[4] = t[2]; }
    else { const f = pose.f[ci]; A[0] = f[0]; A[1] = f[1]; A[2] = f[2]; A[3] = f[3]; A[4] = 0; }
  }
  function chainQuat(ch, j, a, out) {
    if (j > 0) return out.setFromAxisAngle(_ax, -a[j] * DEG);
    if (ch.thumb) { _ea.set(-a[0] * DEG, a[3] * DEG * S, a[4] * DEG * S, 'YXZ'); return out.copy(thumbRestQ).multiply(_qa.setFromEuler(_ea)); }
    _ea.set(-a[0] * DEG, -a[3] * DEG * S, 0);
    return out.copy(fingerRest[ch.fi]).multiply(_qa.setFromEuler(_ea));
  }
  function setChain(ch, a) {
    const b = ch.bones;
    chainQuat(ch, 0, a, b[0].quaternion); chainQuat(ch, 1, a, b[1].quaternion); chainQuat(ch, 2, a, b[2].quaternion);
  }
  function chainFK(ch, a) {
    _mc0.compose(ch.bones[0].position, chainQuat(ch, 0, a, _qb), _one).premultiply(_mh);
    _mc1.compose(_tv.set(0, 0, -ch.len[0]), chainQuat(ch, 1, a, _qb), _one).premultiply(_mc0);
    _mc2.compose(_tv.set(0, 0, -ch.len[1]), chainQuat(ch, 2, a, _qb), _one).premultiply(_mc1);
    _jp[0].setFromMatrixPosition(_mc0); _jp[1].setFromMatrixPosition(_mc1); _jp[2].setFromMatrixPosition(_mc2);
    _jp[3].set(0, 0, -ch.len[2]).applyMatrix4(_mc2);
  }
  let _kmin = 0;
  /** min clearance (m) of segments >= from vs colliders with the chain's bit; sets _kmin (touching segment) */
  function clearance(ch, a, from) {
    chainFK(ch, a);
    let best = 1; _kmin = 2;
    // the first 40% of the proximal phalanx sits inside the palm: palm placement is authored, not solved
    _jp[0].lerp(_jp[1], 0.4);
    for (let k = from; k < 3; k++) {
      const rs = ch.r[k] * SQUISH;
      for (let i = 0; i < ncol; i++) {
        const c = cols[i];
        if (!(c.mask & ch.bit)) continue;
        const d = Math.sqrt(segSegDist2(_jp[k], _jp[k + 1], c.a, c.b)) - c.r - rs;
        if (d < best) { best = d; _kmin = k; }
      }
    }
    return best;
  }
  function curl(out, L, H, from, c) { for (let j = 0; j < 5; j++) out[j] = j >= from && j < 3 ? L[j] + (H[j] - L[j]) * c : H[j]; }

  /**
   * Blend-able grasp: pose angles are closing targets, contacts stop the closure.
   * colliders: [{a: Vector3, b: Vector3, r, mask}] in rig space (arm group space); n = count used.
   */
  function grasp(pose, colliders, n) {
    cols = colliders; ncol = n;
    _mh.compose(hand.position, hand.quaternion, _one);
    for (let ci = 0; ci < 5; ci++) {
      const ch = chains[ci];
      loadPose(ci, pose);
      const A = ang[ci], L = lo[ci], H = hi[ci];
      H.set(A); L.set(A);
      L[0] = Math.min(A[0], ch.thumb ? 0 : 5); L[1] = Math.min(A[1], 5); L[2] = Math.min(A[2], 3);
      if (!n || clearance(ch, H, 0) >= 0) { setChain(ch, H); continue; }
      let from = 0;
      W.set(L);
      for (let pass = 0; pass < 3 && from < 3; pass++) {
        curl(W, L, H, from, 0);
        if (clearance(ch, W, from) < 0) { if (pass === 0) W.set(H); break; } // penetrating even when open: trust the pose
        let c0 = 0, c1 = 1;
        for (let it = 0; it < 10; it++) {
          const cm = (c0 + c1) * 0.5;
          curl(W2, L, H, from, cm);
          if (clearance(ch, W2, from) >= 0) c0 = cm; else c1 = cm;
        }
        curl(W, L, H, from, c0);
        clearance(ch, W, from);
        const k = _kmin;
        for (let j = from; j <= k; j++) { L[j] = W[j]; H[j] = W[j]; }
        from = k + 1;
        if (from >= 3) break;
        for (let j = from; j < 3; j++) L[j] = W[j];
        curl(W2, L, H, from, 1);
        if (clearance(ch, W2, from) >= 0) { W.set(W2); break; }
      }
      setChain(ch, W);
    }
  }

  function segSegDist2(p1, q1, p2, q2) {
    // squared distance between segments p1q1 and p2q2 (Ericson, Real-Time Collision Detection 5.1.9)
    const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
    const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
    const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;
    const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
    let s = 0, t = 0;
    if (a > 1e-12 || e > 1e-12) {
      if (a <= 1e-12) t = Math.min(1, Math.max(0, f / e));
      else {
        const c = d1x * rx + d1y * ry + d1z * rz;
        if (e <= 1e-12) s = Math.min(1, Math.max(0, -c / a));
        else {
          const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
          s = den > 1e-14 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
          t = (b * s + f) / e;
          if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
        }
      }
    }
    const x = rx + d1x * s - d2x * t, y = ry + d1y * s - d2y * t, z = rz + d1z * s - d2z * t;
    return x * x + y * y + z * z;
  }

  /**
   * Place the arm: wrist position/orientation in rig space, shoulder position and an elbow pole direction.
   * The forearm always connects to the wrist; if the target is out of reach the upper arm is stretched.
   */
  function solve(shoulder, wristPos, wristQuat, pole) {
    hand.position.copy(wristPos);
    hand.quaternion.copy(wristQuat);
    const d = _v.subVectors(wristPos, shoulder);
    const dist = d.length();
    const a = UPPER_LEN, b = FORE_LEN;
    const dd = Math.min(dist, a + b - 1e-4);
    // angle at shoulder
    const cosA = THREE.MathUtils.clamp((a * a + dd * dd - b * b) / (2 * a * dd), -1, 1);
    const dirN = d.normalize();
    // pole projected perpendicular to dir
    _w.copy(pole).addScaledVector(dirN, -pole.dot(dirN)).normalize();
    const sinA = Math.sqrt(1 - cosA * cosA);
    _elbow.copy(shoulder).addScaledVector(dirN, a * cosA).addScaledVector(_w, a * sinA);
    if (dist > a + b) _elbow.addScaledVector(dirN, dist - (a + b)); // stretch (upper arm off-screen)
    // forearm: -Z toward wrist, +Y ~ hand dorsal
    _z.subVectors(_elbow, wristPos).normalize(); // +Z points from wrist back to elbow
    _y.set(0, 1, 0).applyQuaternion(wristQuat);
    _x.crossVectors(_y, _z).normalize();
    _y.crossVectors(_z, _x).normalize();
    _m.makeBasis(_x, _y, _z);
    fore.quaternion.setFromRotationMatrix(_m);
    fore.position.copy(wristPos).addScaledVector(_z, FORE_LEN);
    // upper arm: from shoulder to elbow
    _z.subVectors(shoulder, fore.position).normalize();
    _y.copy(_w).negate();
    _x.crossVectors(_y, _z).normalize();
    _y.crossVectors(_z, _x).normalize();
    _m.makeBasis(_x, _y, _z);
    upper.quaternion.setFromRotationMatrix(_m);
    upper.position.copy(fore.position).addScaledVector(_z, UPPER_LEN);
  }

  function dispose() {
    gloveGeo.dispose();
    sleeveGeo.dispose();
    for (const m of rigid) m.geometry.dispose();
    skeleton.dispose();
  }

  return { group, bones: { upper, fore, hand, fingers: fingerBones, thumb: thumbBones }, skeleton, meshes: { glove: gloveMesh, sleeve: sleeveMesh }, applyFingerPose, solve, grasp, dispose, side: S };
}

function mirrorMat(M) {
  const S = new THREE.Matrix4().makeScale(-1, 1, 1);
  return new THREE.Matrix4().multiplyMatrices(S, M).multiply(S);
}

function pin(r, len) {
  const g = new THREE.CylinderGeometry(r, r, len, 12);
  g.rotateZ(Math.PI / 2);
  return g;
}

/** Blend two finger poses into out (allocation-free when out is preallocated via clonePose). */
export function clonePose(p) { return { f: p.f.map((a) => a.slice()), t: p.t.slice() }; }
export function lerpPose(out, a, b, t) {
  for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) out.f[i][k] = a.f[i][k] + (b.f[i][k] - a.f[i][k]) * t;
  for (let k = 0; k < 5; k++) out.t[k] = a.t[k] + (b.t[k] - a.t[k]) * t;
  return out;
}
export function copyPose(out, a) { return lerpPose(out, a, a, 0); }

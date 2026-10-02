/**
 * Soldier rig: bone hierarchy + bind-pose joint positions (character space, metres).
 *
 * Character space: +Y up, forward +Z, the character's LEFT is +X (right hand at -X).
 * Every bone has an IDENTITY bind rotation, so a bone's world quaternion directly rotates its
 * bind-pose geometry. That keeps IK / ragdoll reconstruction simple: world rotations are computed
 * procedurally and converted to parent-relative locals at the end of each frame.
 */

// [name, parent, [x, y, z]]
const L = [
  ['pelvis', null, [0, 0.965, 0.0]],
  ['spine1', 'pelvis', [0, 1.065, -0.012]],
  ['spine2', 'spine1', [0, 1.185, -0.014]],
  ['chest', 'spine2', [0, 1.305, -0.006]],
  ['neck', 'chest', [0, 1.49, -0.022]],
  ['head', 'neck', [0, 1.585, -0.008]],

  ['clavL', 'chest', [0.028, 1.445, 0.004]],
  ['upperarmL', 'clavL', [0.182, 1.425, -0.016]],
  ['forearmL', 'upperarmL', [0.232, 1.145, 0.01]],
  ['handL', 'forearmL', [0.234, 0.915, 0.118]],

  ['clavR', 'chest', [-0.028, 1.445, 0.004]],
  ['upperarmR', 'clavR', [-0.182, 1.425, -0.016]],
  ['forearmR', 'upperarmR', [-0.232, 1.145, 0.01]],
  ['handR', 'forearmR', [-0.234, 0.915, 0.118]],

  ['thighL', 'pelvis', [0.092, 0.905, 0.004]],
  ['shinL', 'thighL', [0.098, 0.487, 0.016]],
  ['footL', 'shinL', [0.102, 0.088, -0.018]],
  ['toeL', 'footL', [0.104, 0.024, 0.118]],

  ['thighR', 'pelvis', [-0.092, 0.905, 0.004]],
  ['shinR', 'thighR', [-0.098, 0.487, 0.016]],
  ['footR', 'shinR', [-0.102, 0.088, -0.018]],
  ['toeR', 'footR', [-0.104, 0.024, 0.118]],

  // rigid props (second root: driven directly in world space)
  ['weapon', null, [0, 1.2, 0.35]],
  ['mag', 'weapon', [0, 1.2 - 0.045, 0.35 + 0.005]],
];

export const BONE_NAMES = L.map((b) => b[0]);
export const B = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i]));
export const PARENT = L.map((b) => (b[1] === null ? -1 : B[b[1]]));
export const BIND = L.map((b) => b[2].slice());
export const NUM_BONES = L.length;

/** Segment end points used for automatic skin weighting (bone origin -> tip). */
export const TIP = BIND.map((p) => p.slice());
function tip(name, p) { TIP[B[name]] = p; }
tip('pelvis', [0, 1.035, -0.01]);
tip('spine1', BIND[B.spine2]);
tip('spine2', BIND[B.chest]);
tip('chest', [0, 1.45, -0.01]);
tip('neck', BIND[B.head]);
tip('head', [0, 1.74, 0.01]);
for (const s of ['L', 'R']) {
  tip('clav' + s, BIND[B['upperarm' + s]]);
  tip('upperarm' + s, BIND[B['forearm' + s]]);
  tip('forearm' + s, BIND[B['hand' + s]]);
  const h = BIND[B['hand' + s]];
  tip('hand' + s, [h[0], h[1] - 0.075, h[2] + 0.03]);
  tip('thigh' + s, BIND[B['shin' + s]]);
  tip('shin' + s, BIND[B['foot' + s]]);
  tip('foot' + s, BIND[B['toe' + s]]);
  const t = BIND[B['toe' + s]];
  tip('toe' + s, [t[0], t[1], t[2] + 0.08]);
}

/** Segment lengths used by IK. */
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
export const LEN = {
  upperarm: dist(BIND[B.upperarmL], BIND[B.forearmL]),
  forearm: dist(BIND[B.forearmL], BIND[B.handL]),
  thigh: dist(BIND[B.thighL], BIND[B.shinL]),
  shin: dist(BIND[B.shinL], BIND[B.footL]),
};

/**
 * Hand frames in bind pose. L = wrist->knuckles, P = palm normal. The right hand's index finger lies
 * along cross(L, P); the left hand is its mirror image (index along -cross(L, P)).
 */
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; }
const foreDirL = norm([BIND[B.handL][0] - BIND[B.forearmL][0], BIND[B.handL][1] - BIND[B.forearmL][1], BIND[B.handL][2] - BIND[B.forearmL][2]]);
export const HAND_BIND = {
  L: { L: foreDirL, P: [-1, 0, 0] },
  R: { L: [-foreDirL[0], foreDirL[1], foreDirL[2]], P: [1, 0, 0] },
};

/** Hitbox capsules: [bone, zone, radius, from(bind), to(bind)] */
export const HITBOXES = [
  ['head', 'head', 0.105, [0, 1.63, 0.015], [0, 1.72, 0.0]],
  ['neck', 'head', 0.06, [0, 1.49, -0.01], [0, 1.57, 0.0]],
  ['chest', 'torso', 0.17, [0, 1.25, 0.0], [0, 1.38, 0.0]],
  ['spine1', 'torso', 0.165, [0, 1.02, -0.005], [0, 1.16, -0.005]],
  ['upperarmL', 'limb', 0.058, BIND[B.upperarmL], BIND[B.forearmL]],
  ['forearmL', 'limb', 0.048, BIND[B.forearmL], BIND[B.handL]],
  ['upperarmR', 'limb', 0.058, BIND[B.upperarmR], BIND[B.forearmR]],
  ['forearmR', 'limb', 0.048, BIND[B.forearmR], BIND[B.handR]],
  ['thighL', 'limb', 0.085, BIND[B.thighL], BIND[B.shinL]],
  ['shinL', 'limb', 0.065, BIND[B.shinL], BIND[B.footL]],
  ['thighR', 'limb', 0.085, BIND[B.thighR], BIND[B.shinR]],
  ['shinR', 'limb', 0.065, BIND[B.shinR], BIND[B.footR]],
];

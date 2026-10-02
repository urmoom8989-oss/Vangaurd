import * as THREE from 'three';

/**
 * IK / orientation helpers. All vectors are world space. Bind rotations are identity, so a bone's
 * world quaternion is "rotation from its bind frame".
 */

const _u = new THREE.Vector3();
const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();

/**
 * Two-bone IK. Writes elbow (mid joint) and the reached end position.
 * pole: world direction the mid joint should bend towards.
 * returns the actual distance ratio (1 = reached)
 */
export function solveTwoBone(root, target, lenA, lenB, pole, outMid, outEnd) {
  _u.subVectors(target, root);
  let d = _u.length();
  if (d < 1e-6) { _u.set(0, -1, 0); d = 1e-6; } else _u.divideScalar(d);
  const reach = d;
  const maxD = lenA + lenB - 1e-4, minD = Math.abs(lenA - lenB) + 1e-3;
  d = Math.min(maxD, Math.max(minD, d));
  const cosA = (lenA * lenA + d * d - lenB * lenB) / (2 * lenA * d);
  const along = lenA * cosA;
  const h = Math.sqrt(Math.max(0, lenA * lenA - along * along));
  _p.copy(pole).addScaledVector(_u, -pole.dot(_u));
  if (_p.lengthSq() < 1e-8) {
    // pole parallel to the chain: pick any perpendicular
    _p.set(0, 1, 0).addScaledVector(_u, -_u.y);
    if (_p.lengthSq() < 1e-8) _p.set(1, 0, 0);
  }
  _p.normalize();
  outMid.copy(root).addScaledVector(_u, along).addScaledVector(_p, h);
  outEnd.copy(root).addScaledVector(_u, d);
  return reach / d;
}

/**
 * Rotation that maps a bind basis (dirB, nrmB) onto a current basis (dir, nrm):
 * q = basis(dir, nrm, dir x nrm) * inverse(basis(dirB, nrmB, dirB x nrmB)).
 * Inputs need not be orthonormal (nrm is orthogonalised against dir).
 */
export function quatFromBases(dirB, nrmB, dir, nrm, out) {
  _a.copy(dir).normalize();
  _b.copy(nrm).addScaledVector(_a, -nrm.dot(_a)).normalize();
  _c.crossVectors(_a, _b);
  _m1.makeBasis(_a, _b, _c);
  _a.copy(dirB).normalize();
  _b.copy(nrmB).addScaledVector(_a, -nrmB.dot(_a)).normalize();
  _c.crossVectors(_a, _b);
  _m2.makeBasis(_a, _b, _c).transpose(); // orthonormal inverse
  _m1.multiply(_m2);
  return out.setFromRotationMatrix(_m1);
}

/** Rotate `q` about world `axis` (unit) by `angle` (pre-multiply). */
const _qa = new THREE.Quaternion();
export function rotateWorld(q, axis, angle) {
  _qa.setFromAxisAngle(axis, angle);
  return q.premultiply(_qa);
}

/** Twist angle of rotation q about unit axis (swing-twist decomposition). */
export function twistAngle(q, axis) {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  return 2 * Math.atan2(d, q.w);
}

export const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));
export function dampAngle(a, b, lambda, dt) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-lambda * dt));
}
export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Critically-damped spring (value + velocity) — Unity SmoothDamp style, frame-rate independent. */
export function spring(state, target, omega, dt) {
  // state: {x, v}
  const x = state.x - target;
  const exp = Math.exp(-omega * dt);
  const tmp = (state.v + omega * x) * dt;
  state.v = (state.v - omega * tmp) * exp;
  state.x = target + (x + tmp) * exp;
  return state.x;
}

/** Vector3 critically-damped spring. */
export function springV(pos, vel, target, omega, dt) {
  const exp = Math.exp(-omega * dt);
  for (const k of ['x', 'y', 'z']) {
    const x = pos[k] - target[k];
    const tmp = (vel[k] + omega * x) * dt;
    vel[k] = (vel[k] - omega * tmp) * exp;
    pos[k] = target[k] + (x + tmp) * exp;
  }
}

export const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;

import * as THREE from 'three';
import { B, NUM_BONES } from '../character/rig.js';
import { BIND_V, Pose } from '../character/body.js';
import { WEAPON } from '../character/soldier.js';
import { quatFromBases } from './ik.js';

/**
 * Position-based (verlet) ragdoll: joint particles + distance constraints (bones), range limits
 * (joint limits / self-collision proxies), knee hinge correction, sphere-vs-world collision with
 * friction, a short "muscle tone" phase after death, and sleeping. Bone rotations are rebuilt from
 * particle frames each step. The rifle drops as its own 3-particle rigid body.
 */

const G = -9.81;
const P = {};
const DEFS = []; // [name, mass, radius]
function def(name, mass, radius) { P[name] = DEFS.length; DEFS.push([name, mass, radius]); }
def('pelvis', 3.0, 0.11);
def('hipL', 2.0, 0.085); def('hipR', 2.0, 0.085);
def('spine', 3.0, 0.12);
def('chestTop', 2.5, 0.1);
def('shL', 1.5, 0.075); def('shR', 1.5, 0.075);
def('head', 1.3, 0.1); def('nose', 0.2, 0.03);
def('elbowL', 0.8, 0.052); def('elbowR', 0.8, 0.052);
def('wristL', 0.5, 0.045); def('wristR', 0.5, 0.045);
def('kneeL', 1.5, 0.065); def('kneeR', 1.5, 0.065);
def('ankleL', 0.8, 0.055); def('ankleR', 0.8, 0.055);
def('toeL', 0.3, 0.035); def('toeR', 0.3, 0.035);
const NP = DEFS.length;
// weapon particles
const WB = { butt: 0, muzzle: 1, top: 2 };
const W_LOCAL = [WEAPON.butt.clone(), WEAPON.muzzle.clone(), new THREE.Vector3(0, 0.09, -0.02)];

// muscle-tone weight per particle: the trunk/head hold together for a moment, arms go limp almost
// at once (otherwise an aiming arm stays raised while the body drops), legs are free to buckle.
const TONE_W = DEFS.map(([n]) => (n === 'pelvis' || /^(knee|ankle|toe)/.test(n) ? 0 : /^(elbow|wrist)/.test(n) ? 0.12 : 1));

const HEAD_OFF = new THREE.Vector3(0, 0.07, 0.02);
const NOSE_OFF = new THREE.Vector3(0, 0.06, 0.125);
const TOE_OFF = new THREE.Vector3(0, 0, 0.075);

/** particle world position from a pose */
function particleFromPose(pose, i, out) {
  switch (DEFS[i][0]) {
    case 'pelvis': return out.copy(pose.p[B.pelvis]);
    case 'hipL': return out.copy(pose.p[B.thighL]);
    case 'hipR': return out.copy(pose.p[B.thighR]);
    case 'spine': return out.copy(pose.p[B.spine2]);
    case 'chestTop': return out.copy(pose.p[B.neck]);
    case 'shL': return out.copy(pose.p[B.upperarmL]);
    case 'shR': return out.copy(pose.p[B.upperarmR]);
    case 'head': return out.copy(HEAD_OFF).applyQuaternion(pose.q[B.head]).add(pose.p[B.head]);
    case 'nose': return out.copy(NOSE_OFF).applyQuaternion(pose.q[B.head]).add(pose.p[B.head]);
    case 'elbowL': return out.copy(pose.p[B.forearmL]);
    case 'elbowR': return out.copy(pose.p[B.forearmR]);
    case 'wristL': return out.copy(pose.p[B.handL]);
    case 'wristR': return out.copy(pose.p[B.handR]);
    case 'kneeL': return out.copy(pose.p[B.shinL]);
    case 'kneeR': return out.copy(pose.p[B.shinR]);
    case 'ankleL': return out.copy(pose.p[B.footL]);
    case 'ankleR': return out.copy(pose.p[B.footR]);
    case 'toeL': return out.copy(TOE_OFF).applyQuaternion(pose.q[B.toeL]).add(pose.p[B.toeL]);
    case 'toeR': return out.copy(TOE_OFF).applyQuaternion(pose.q[B.toeR]).add(pose.p[B.toeR]);
    default: return out;
  }
}

// bind particle positions (pose with identity rotations)
const BIND_POSE = new Pose();
const BIND_P = DEFS.map((_, i) => particleFromPose(BIND_POSE, i, new THREE.Vector3()));
const dist = (a, b) => BIND_P[P[a]].distanceTo(BIND_P[P[b]]);

// constraints: [a, b, min, max, stiffness]
const CON = [];
function rigid(...names) {
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const d = dist(names[i], names[j]);
    CON.push([P[names[i]], P[names[j]], d, d, 1]);
  }
}
function bone(a, b) { const d = dist(a, b); CON.push([P[a], P[b], d, d, 1]); }
function range(a, b, lo, hi, k = 0.6) { const d = dist(a, b); CON.push([P[a], P[b], d * lo, d * hi, k]); }
function minD(a, b, m, k = 0.5) { CON.push([P[a], P[b], m, Infinity, k]); }
rigid('pelvis', 'hipL', 'hipR');
rigid('spine', 'chestTop', 'shL', 'shR');
bone('pelvis', 'spine'); range('hipL', 'spine', 0.9, 1.08, 0.8); range('hipR', 'spine', 0.9, 1.08, 0.8);
range('hipL', 'shL', 0.82, 1.03); range('hipR', 'shR', 0.82, 1.03);
range('hipL', 'shR', 0.86, 1.05); range('hipR', 'shL', 0.86, 1.05);
range('pelvis', 'chestTop', 0.8, 1.02);
// neck / head
bone('chestTop', 'head'); bone('head', 'nose');
range('shL', 'head', 0.82, 1.12); range('shR', 'head', 0.82, 1.12);
range('spine', 'head', 0.9, 1.03); range('chestTop', 'nose', 0.8, 1.15);
// arms
for (const s of ['L', 'R']) {
  bone('sh' + s, 'elbow' + s); bone('elbow' + s, 'wrist' + s);
  minD('sh' + s, 'wrist' + s, 0.15);
  minD('wrist' + s, 'pelvis', 0.14); minD('wrist' + s, 'spine', 0.15); minD('elbow' + s, 'spine', 0.14);
  minD('wrist' + s, 'head', 0.13); minD('elbow' + s, 'hip' + s, 0.12);
  // legs
  bone('hip' + s, 'knee' + s); bone('knee' + s, 'ankle' + s); bone('ankle' + s, 'toe' + s);
  range('knee' + s, 'toe' + s, 0.86, 1.12, 0.8);
  minD('hip' + s, 'ankle' + s, 0.26);
  minD('knee' + s, 'chestTop', 0.42); minD('knee' + s, 'sh' + s, 0.4);
  minD('knee' + s, 'spine', 0.25);
}
minD('kneeL', 'kneeR', 0.13); minD('ankleL', 'ankleR', 0.1); minD('toeL', 'toeR', 0.08);
minD('elbowL', 'elbowR', 0.12); minD('wristL', 'wristR', 0.08);

// weapon constraints
const WCON = [[0, 1], [1, 2], [0, 2]].map(([a, b]) => [a, b, W_LOCAL[a].distanceTo(W_LOCAL[b])]);

// bind frames for reconstruction
const bindDir = (a, b) => new THREE.Vector3().subVectors(BIND_P[P[b]], BIND_P[P[a]]).normalize();
const F = {
  pelvis: { d: bindDir('pelvis', 'spine'), n: bindDir('hipR', 'hipL') },
  chest: { d: bindDir('spine', 'chestTop'), n: bindDir('shR', 'shL') },
  head: { d: bindDir('chestTop', 'head'), n: bindDir('head', 'nose') },
};
const LIMB = {};
for (const s of ['L', 'R']) {
  const ua = bindDir('sh' + s, 'elbow' + s), fa = bindDir('elbow' + s, 'wrist' + s);
  const th = bindDir('hip' + s, 'knee' + s), sh = bindDir('knee' + s, 'ankle' + s);
  LIMB[s] = {
    ua, fa, an: new THREE.Vector3().crossVectors(ua, fa).normalize(),
    th, sh, ln: new THREE.Vector3(1, 0, 0),
    ft: bindDir('ankle' + s, 'toe' + s),
  };
}
const W_DIR_B = new THREE.Vector3().subVectors(W_LOCAL[1], W_LOCAL[0]).normalize();
const W_UP_B = new THREE.Vector3().subVectors(W_LOCAL[2], W_LOCAL[0].clone().add(W_LOCAL[1]).multiplyScalar(0.5)).normalize();

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _n = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _hit = { depth: 0, normal: new THREE.Vector3() };

export class Ragdoll {
  constructor() {
    this.x = Array.from({ length: NP }, () => new THREE.Vector3());
    this.px = Array.from({ length: NP }, () => new THREE.Vector3());
    this.invM = DEFS.map((d) => 1 / d[1]);
    this.r = DEFS.map((d) => d[2]);
    this.tone = Array.from({ length: NP }, () => new THREE.Vector3()); // pelvis-local death pose
    this.w = Array.from({ length: 3 }, () => new THREE.Vector3());
    this.pw = Array.from({ length: 3 }, () => new THREE.Vector3());
    this.handLocal = { L: new THREE.Quaternion(), R: new THREE.Quaternion() };
    this.nPrev = { L: new THREE.Vector3(), R: new THREE.Vector3(), lL: new THREE.Vector3(1, 0, 0), lR: new THREE.Vector3(1, 0, 0) };
    this.active = false;
    this.sleeping = false;
    this.age = 0;
    this.still = 0;
    this.weaponFree = true;
    this.contact = new Uint8Array(NP);
    this.groundY = 0;
  }

  /**
   * Start from the current pose. prevPose: pose one frame earlier (for velocities).
   * impulse: {point, dir, strength, zone}
   */
  start(pose, prevPose, dt, impulse, groundY, rng) {
    this.active = true; this.sleeping = false; this.age = 0; this.still = 0;
    this.groundY = groundY;
    for (let i = 0; i < NP; i++) {
      particleFromPose(pose, i, this.x[i]);
      particleFromPose(prevPose, i, this.px[i]);
      // clamp inherited velocity
      _a.subVectors(this.x[i], this.px[i]);
      if (_a.length() > 0.15) _a.setLength(0.15);
      this.px[i].copy(this.x[i]).sub(_a);
    }
    const sim = 1 / 120;
    const vscale = sim / Math.max(dt, 1e-4); // convert per-frame displacement to per-substep
    for (let i = 0; i < NP; i++) {
      _a.subVectors(this.x[i], this.px[i]).multiplyScalar(vscale);
      this.px[i].copy(this.x[i]).sub(_a);
    }
    // impulse
    if (impulse) {
      const dir = _b.copy(impulse.dir); dir.y = Math.max(dir.y, -0.2); dir.normalize();
      let best = 0, bd = Infinity;
      for (let i = 0; i < NP; i++) { const d = this.x[i].distanceTo(impulse.point); if (d < bd) { bd = d; best = i; } }
      const s = impulse.strength ?? 1;
      for (let i = 0; i < NP; i++) {
        const near = Math.exp(-this.x[i].distanceTo(this.x[best]) / 0.25);
        const v = (0.12 + 0.75 * near) * s;
        this.px[i].addScaledVector(dir, -v * sim);
      }
      // the upper body carries the momentum (topple), the hips lag slightly behind
      for (const k of [P.spine, P.chestTop, P.shL, P.shR, P.head, P.nose]) this.px[k].addScaledVector(dir, -0.55 * s * sim);
      this.px[P.pelvis].addScaledVector(dir, 0.1 * s * sim);
      // knees buckle forward, hips drop: collapse instead of toppling like a plank
      const fwd = _c.subVectors(this.x[P.nose], this.x[P.head]); fwd.y = 0; fwd.normalize();
      const buck = 0.5 + (rng ? rng.next() * 0.6 : 0.3);
      for (const k of [P.kneeL, P.kneeR]) this.px[k].addScaledVector(fwd, -buck * sim);
      // slight random twist so deaths differ
      const tw = rng ? (rng.next() - 0.5) * 1.2 : 0.3;
      _d.set(-fwd.z, 0, fwd.x);
      this.px[P.shL].addScaledVector(_d, tw * sim); this.px[P.shR].addScaledVector(_d, -tw * sim);
    }
    // tone: store pose relative to the pelvis frame
    this.pelvisFrame(_q);
    _q.invert();
    for (let i = 0; i < NP; i++) this.tone[i].subVectors(this.x[i], this.x[P.pelvis]).applyQuaternion(_q);
    // hands keep their grip pose relative to the forearms
    for (const s of ['L', 'R']) {
      _q2.copy(pose.q[B['forearm' + s]]).invert();
      this.handLocal[s].copy(_q2).multiply(pose.q[B['hand' + s]]);
      this.nPrev[s].copy(LIMB[s].an).applyQuaternion(pose.q[B['upperarm' + s]]);
      this.nPrev['l' + s].copy(LIMB[s].ln).applyQuaternion(pose.q[B['thigh' + s]]);
    }
    // weapon: drops free
    const wq = pose.q[B.weapon], wp = pose.p[B.weapon];
    const pwq = prevPose.q[B.weapon], pwp = prevPose.p[B.weapon];
    for (let k = 0; k < 3; k++) {
      this.w[k].copy(W_LOCAL[k]).applyQuaternion(wq).add(wp);
      this.pw[k].copy(W_LOCAL[k]).applyQuaternion(pwq).add(pwp);
      _a.subVectors(this.w[k], this.pw[k]).multiplyScalar(vscale);
      if (_a.length() > 0.02) _a.setLength(0.02);
      this.pw[k].copy(this.w[k]).sub(_a);
    }
    // toss the rifle slightly forward/away
    if (impulse) for (let k = 0; k < 3; k++) this.pw[k].addScaledVector(impulse.dir, -0.6 * sim);
    this.pw[1].y -= 0.8 * sim;
  }

  pelvisFrame(out) {
    _a.subVectors(this.x[P.spine], this.x[P.pelvis]);
    _b.subVectors(this.x[P.hipL], this.x[P.hipR]);
    return quatFromBases(F.pelvis.d, F.pelvis.n, _a, _b, out);
  }

  step(dt, world) {
    if (!this.active || this.sleeping) return;
    this.age += dt;
    const sub = 2;
    const h = 1 / 120;
    let maxMove = 0;
    for (let s = 0; s < sub; s++) {
      // integrate
      for (let i = 0; i < NP; i++) {
        const x = this.x[i], px = this.px[i];
        _a.subVectors(x, px).multiplyScalar(this.contact[i] ? 0.96 : 0.995);
        px.copy(x);
        x.add(_a);
        x.y += G * h * h;
      }
      for (let k = 0; k < 3; k++) {
        _a.subVectors(this.w[k], this.pw[k]).multiplyScalar(0.995);
        this.pw[k].copy(this.w[k]);
        this.w[k].add(_a);
        this.w[k].y += G * h * h;
      }
      // muscle tone (decays quickly)
      const tone = Math.max(0, 1 - this.age / 0.4) * 0.08;
      if (tone > 0) {
        this.pelvisFrame(_q);
        for (let i = 0; i < NP; i++) {
          const tw = TONE_W[i];
          if (tw === 0) continue;
          _b.copy(this.tone[i]).applyQuaternion(_q).add(this.x[P.pelvis]);
          this.x[i].lerp(_b, tone * tw);
        }
      }
      // constraints
      for (let it = 0; it < 6; it++) {
        for (const c of CON) this.solve(c);
        this.kneeHinge('L'); this.kneeHinge('R');
      }
      for (let it = 0; it < 3; it++) for (const c of WCON) this.solveW(c);
      // collisions
      for (let i = 0; i < NP; i++) this.collide(this.x[i], this.px[i], this.r[i], world, i);
      for (let k = 0; k < 3; k++) this.collide(this.w[k], this.pw[k], 0.03, world, -1);
      this.guardEnergy(h);
    }
    for (let i = 0; i < NP; i++) maxMove = Math.max(maxMove, this.x[i].distanceToSquared(this.px[i]));
    for (let k = 0; k < 3; k++) maxMove = Math.max(maxMove, this.w[k].distanceToSquared(this.pw[k]));
    if (maxMove < (0.0006 * 0.0006) && this.age > 0.8) {
      if (++this.still > 40) this.sleeping = true;
    } else this.still = 0;
    if (this.age > 12) this.sleeping = true;
  }

  /**
   * Energy guard. Position-based constraints + contact projection can inject energy when the chain
   * lands in a folded pose (knee hinge / ground push-out / length limits fighting each other), which
   * showed up as corpses launching head-over-heels into the air ~0.3 s after touching down. A falling
   * body never gains net upward momentum after the hit impulse, so: cap the centre-of-mass upward
   * speed, and cap per-particle speed.
   */
  guardEnergy(h) {
    const x = this.x, px = this.px;
    let vy = 0;
    for (let i = 0; i < NP; i++) vy += x[i].y - px[i].y;
    vy /= NP;
    const maxUp = (this.age < 0.2 ? 2.0 : 0.35) * h;
    if (vy > maxUp) { const e = vy - maxUp; for (let i = 0; i < NP; i++) px[i].y += e; }
    const vmax = 7 * h;
    // settle: once the fall is over (~0.8 s), progressively bleed velocity so a folded body comes to
    // rest instead of writhing while its constraints negotiate the pose on the ground.
    const settle = this.age > 0.8 ? Math.max(0.82, 1 - (this.age - 0.8) * 0.12) : 1;
    for (let i = 0; i < NP; i++) {
      _a.subVectors(x[i], px[i]);
      const l = _a.length();
      if (l > vmax) _a.multiplyScalar(vmax / l);
      if (settle < 1 && this.contact[i] + (x[i].y - this.groundY < 0.35 ? 1 : 0) > 0) _a.multiplyScalar(settle);
      px[i].copy(x[i]).sub(_a);
    }
  }

  solve(c) {
    const [ia, ib, lo, hi, k] = c;
    const a = this.x[ia], b = this.x[ib];
    _a.subVectors(b, a);
    const d = _a.length();
    if (d < 1e-7) return;
    let target;
    if (d < lo) target = lo; else if (d > hi) target = hi; else return;
    const wa = this.invM[ia], wb = this.invM[ib];
    const corr = ((d - target) / d / (wa + wb)) * k;
    a.addScaledVector(_a, corr * wa);
    b.addScaledVector(_a, -corr * wb);
  }

  solveW(c) {
    const [ia, ib, rest] = c;
    const a = this.w[ia], b = this.w[ib];
    _a.subVectors(b, a);
    const d = _a.length();
    if (d < 1e-7) return;
    const corr = (d - rest) / d * 0.5;
    a.addScaledVector(_a, corr);
    b.addScaledVector(_a, -corr);
  }

  /** knees only bend forward: keep the knee in front of the hip-ankle line (towards the toes) */
  kneeHinge(s) {
    const hip = this.x[P['hip' + s]], knee = this.x[P['knee' + s]], ankle = this.x[P['ankle' + s]], toe = this.x[P['toe' + s]];
    _a.subVectors(ankle, hip);
    const l2 = _a.lengthSq();
    if (l2 < 1e-6) return;
    const t = _b.subVectors(knee, hip).dot(_a) / l2;
    _c.copy(hip).addScaledVector(_a, t); // closest point on the line
    _d.subVectors(knee, _c);
    // forward reference: foot direction projected off the leg axis
    _n.subVectors(toe, ankle);
    _n.addScaledVector(_a, -_n.dot(_a) / l2);
    if (_n.lengthSq() < 1e-6) return;
    _n.normalize();
    const f = _d.dot(_n);
    if (f < 0.01) {
      const push = 0.01 - f;
      knee.addScaledVector(_n, push * 0.7);
      hip.addScaledVector(_n, -push * 0.15);
      ankle.addScaledVector(_n, -push * 0.15);
    }
  }

  collide(x, px, r, world, i) {
    let hit = false;
    if (world) {
      const depth = world.sphere(x, r, _hit);
      if (depth > 0) {
        x.addScaledVector(_hit.normal, depth);
        hit = true;
        this.friction(x, px, _hit.normal);
      }
    }
    // ground plane fallback
    const gy = this.groundY + r;
    if (x.y < gy) {
      x.y = gy;
      _n.set(0, 1, 0);
      this.friction(x, px, _n);
      hit = true;
    }
    if (i >= 0) this.contact[i] = hit ? 1 : 0;
  }

  friction(x, px, n) {
    _a.subVectors(x, px);
    const vn = _a.dot(n);
    _b.copy(n).multiplyScalar(vn);
    _c.subVectors(_a, _b); // tangential
    const tl = _c.length();
    const mu = tl < 0.0015 ? 1 : 0.55; // static vs kinetic
    _c.multiplyScalar(1 - mu);
    // No restitution, and never keep the outward velocity that the push-out itself created: with
    // verlet, the projection shows up as velocity and constraints re-penetrating every substep would
    // otherwise pump energy into the body (corpses "levitating" / flipping after they settle).
    px.copy(x).sub(_c);
  }

  /** Write bone world rotations into pose. */
  writePose(pose) {
    const x = this.x;
    // pelvis
    this.pelvisFrame(pose.q[B.pelvis]);
    pose.p[B.pelvis].copy(x[P.pelvis]);
    // chest
    _a.subVectors(x[P.chestTop], x[P.spine]);
    _b.subVectors(x[P.shL], x[P.shR]);
    const cq = _q;
    quatFromBases(F.chest.d, F.chest.n, _a, _b, cq);
    pose.q[B.spine1].slerpQuaternions(pose.q[B.pelvis], cq, 0.35); pose.fk(B.spine1);
    pose.q[B.spine2].slerpQuaternions(pose.q[B.pelvis], cq, 0.7); pose.fk(B.spine2);
    pose.q[B.chest].copy(cq); pose.fk(B.chest);
    // head
    _a.subVectors(x[P.head], x[P.chestTop]);
    _b.subVectors(x[P.nose], x[P.head]);
    quatFromBases(F.head.d, F.head.n, _a, _b, _q2);
    pose.fk(B.neck);
    pose.q[B.neck].slerpQuaternions(cq, _q2, 0.5);
    pose.fk(B.head);
    pose.q[B.head].copy(_q2);
    for (const s of ['L', 'R']) {
      const L = LIMB[s];
      pose.q[B['clav' + s]].copy(cq); pose.fk(B['clav' + s]);
      pose.q[B['upperarm' + s]].copy(cq); pose.fk(B['upperarm' + s]);
      // arm
      _a.subVectors(x[P['elbow' + s]], x[P['sh' + s]]);
      _b.subVectors(x[P['wrist' + s]], x[P['elbow' + s]]);
      _n.crossVectors(_a, _b);
      if (_n.lengthSq() > 1e-6) { _n.normalize(); this.nPrev[s].lerp(_n, 0.5).normalize(); }
      quatFromBases(L.ua, L.an, _a, this.nPrev[s], pose.q[B['upperarm' + s]]);
      pose.fk(B['forearm' + s]);
      quatFromBases(L.fa, L.an, _b, this.nPrev[s], pose.q[B['forearm' + s]]);
      pose.fk(B['hand' + s]);
      pose.q[B['hand' + s]].copy(pose.q[B['forearm' + s]]).multiply(this.handLocal[s]);
      // leg
      _a.subVectors(x[P['knee' + s]], x[P['hip' + s]]);
      _b.subVectors(x[P['ankle' + s]], x[P['knee' + s]]);
      _n.crossVectors(_a, _b);
      const ln = this.nPrev['l' + s];
      if (_n.lengthSq() > 1e-6) { _n.normalize(); ln.lerp(_n, 0.5).normalize(); }
      pose.fk(B['thigh' + s]);
      quatFromBases(L.th, L.ln, _a, ln, pose.q[B['thigh' + s]]);
      pose.fk(B['shin' + s]);
      quatFromBases(L.sh, L.ln, _b, ln, pose.q[B['shin' + s]]);
      pose.fk(B['foot' + s]);
      _c.subVectors(x[P['toe' + s]], x[P['ankle' + s]]);
      quatFromBases(L.ft, L.ln, _c, ln, pose.q[B['foot' + s]]);
      pose.fk(B['toe' + s]);
      pose.q[B['toe' + s]].copy(pose.q[B['foot' + s]]);
    }
    // weapon
    _a.subVectors(this.w[1], this.w[0]);
    _b.copy(this.w[0]).add(this.w[1]).multiplyScalar(0.5);
    _c.subVectors(this.w[2], _b);
    quatFromBases(W_DIR_B, W_UP_B, _a, _c, pose.q[B.weapon]);
    pose.p[B.weapon].copy(W_LOCAL[0]).applyQuaternion(pose.q[B.weapon]).negate().add(this.w[0]);
    pose.q[B.mag].copy(pose.q[B.weapon]);
    pose.p[B.mag].copy(BIND_V[B.mag]).sub(BIND_V[B.weapon]).applyQuaternion(pose.q[B.weapon]).add(pose.p[B.weapon]);
  }

  /** centre of mass-ish (pelvis) */
  get position() { return this.x[P.pelvis]; }
}

export const RAGDOLL_PARTICLES = P;
export { NUM_BONES };

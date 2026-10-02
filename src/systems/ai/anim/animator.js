import * as THREE from 'three';
import { B, BIND, LEN, HAND_BIND } from '../character/rig.js';
import { OFFSET, BIND_V } from '../character/body.js';
import { WEAPON, GRIP_C } from '../character/soldier.js';
import { solveTwoBone, quatFromBases, twistAngle, damp, dampAngle, wrapAngle, spring, springV, smoothstep, clamp, lerp } from './ik.js';

/**
 * Procedural full-body animation for one soldier. Everything is computed in world space:
 *
 *   feet   : world-planted foot placement with gait scheduling (walk/run/strafe/backpedal/turn in
 *            place/crouch), swing arcs, heel/toe roll -> no foot sliding.
 *   pelvis : height, bob, lateral weight shift, twist, hip drop, lean.
 *   spine  : distributed twist/bend from the pelvis to the aim-driven chest, breathing, lean.
 *   weapon : per-mode target (aim / low ready / patrol / sprint / reload / throw) blended with springs
 *            in chest space, recoil, sway.
 *   arms   : two-bone IK onto the weapon grips (or reload / throw timelines), forearm twist.
 *   legs   : two-bone IK onto the planted/swinging feet with pole vectors.
 *   reacts : damped angular springs for hit flinches.
 *
 * Inputs are set on `animator.in` by the agent every frame.
 */

const UP = new THREE.Vector3(0, 1, 0);
const tmpV = Array.from({ length: 16 }, () => new THREE.Vector3());
const tmpQ = Array.from({ length: 8 }, () => new THREE.Quaternion());
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _m = new THREE.Matrix4();

// bind directions / normals
const bdir = (a, b) => new THREE.Vector3().subVectors(BIND_V[B[b]], BIND_V[B[a]]).normalize();
const ARM = {};
for (const s of ['L', 'R']) {
  const up = bdir('upperarm' + s, 'forearm' + s), fo = bdir('forearm' + s, 'hand' + s);
  ARM[s] = { upDir: up, foDir: fo, n: new THREE.Vector3().crossVectors(up, fo).normalize() };
}
const LEG = {};
for (const s of ['L', 'R']) {
  const th = bdir('thigh' + s, 'shin' + s), sh = bdir('shin' + s, 'foot' + s);
  LEG[s] = { thDir: th, shDir: sh, n: new THREE.Vector3().crossVectors(th, sh).normalize() };
}
// hand bind frames and canonical grip centre offset (bind space, relative to the wrist)
const HAND = {};
for (const s of ['L', 'R']) {
  const L = new THREE.Vector3(...HAND_BIND[s].L), P = new THREE.Vector3(...HAND_BIND[s].P);
  HAND[s] = { L, P, grip: L.clone().multiplyScalar(GRIP_C.y).addScaledVector(P, GRIP_C.z) };
}
const ANKLE_H = BIND[B.footL][1];
const BALL = new THREE.Vector3(BIND[B.toeL][0] - BIND[B.footL][0], BIND[B.toeL][1] - BIND[B.footL][1], BIND[B.toeL][2] - BIND[B.footL][2]); // ankle->ball (left)
const HEEL = new THREE.Vector3(0, -ANKLE_H + 0.012, -0.07);
const HIP_OFF = { L: OFFSET[B.thighL], R: OFFSET[B.thighR] };

export function yawQuat(yaw, pitch, roll, out) {
  _e.set(-pitch, yaw, roll, 'YXZ');
  return out.setFromEuler(_e);
}
function fwd(yaw, out) { return out.set(Math.sin(yaw), 0, Math.cos(yaw)); }
function leftOf(yaw, out) { return out.set(Math.cos(yaw), 0, -Math.sin(yaw)); }

class Foot {
  constructor(side) {
    this.side = side; // 'L' | 'R'
    this.sign = side === 'L' ? 1 : -1;
    this.pos = new THREE.Vector3(); // ground contact under the ankle
    this.yaw = 0;
    this.planted = true;
    this.t = 0;
    this.dur = 0.35;
    this.from = new THREE.Vector3();
    this.to = new THREE.Vector3();
    this.fromYaw = 0;
    this.toYaw = 0;
    this.lift = 0.08;
    this.pitch = 0;
    this.run = 0;
    this.ankle = new THREE.Vector3();
    this.q = new THREE.Quaternion();
  }
}

export class Animator {
  constructor(body, seed = 0) {
    this.body = body;
    this.seed = seed;
    this.in = {
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      bodyYaw: 0,
      aimYaw: 0,
      aimPitch: 0,
      crouch: 0,
      weapon: 'low', // 'aim' | 'low' | 'patrol' | 'sprint' | 'reload' | 'throw'
      lean: 0,
      headYaw: null, // optional look override (world yaw)
      headPitch: 0,
    };
    this.feet = [new Foot('L'), new Foot('R')];
    this.phase = 0;
    this.speed = 0;
    this.runBlend = 0;
    this.crouch = 0;
    this.lean = 0;
    this.pelvisYaw = 0;
    this.chestYaw = 0;
    this.chestPitch = 0;
    this.aimBlend = 0; // 0 low -> 1 shouldered
    this.pelvisH = { x: 0.935, v: 0 };
    this.bob = 0;
    this.accel = new THREE.Vector3();
    this.prevVel = new THREE.Vector3();
    this.leanFwd = { x: 0, v: 0 };
    this.leanSide = { x: 0, v: 0 };
    // weapon (chest-local)
    this.wPos = new THREE.Vector3(0, 0, 0.3);
    this.wVel = new THREE.Vector3();
    this.wQuat = new THREE.Quaternion();
    this.wPosTarget = new THREE.Vector3();
    this.wQuatTarget = new THREE.Quaternion();
    // recoil
    this.recoil = { back: { x: 0, v: 0 }, pitch: { x: 0, v: 0 }, yaw: { x: 0, v: 0 } };
    // hit reaction (angular spring on the chest, axis-angle vector) + pelvis push
    this.hitAng = new THREE.Vector3();
    this.hitAngV = new THREE.Vector3();
    this.hitPush = new THREE.Vector3();
    this.hitPushV = new THREE.Vector3();
    // action timelines
    this.reloadT = -1; this.reloadDur = 2.4;
    this.throwT = -1; this.throwDur = 1.05; this.onRelease = null; this.released = false;
    this.magHeld = false;
    this.magInHand = new THREE.Matrix4();
    this.initialized = false;
    this.time = 0;
    this.shake = 0;
    this.prevJoint = null;
    this.handTarget = { L: new THREE.Vector3(), R: new THREE.Vector3() };
  }

  /** Snap all state to the current inputs (on spawn / teleport). */
  reset() {
    const I = this.in;
    this.pelvisYaw = I.bodyYaw;
    this.chestYaw = I.aimYaw;
    this.chestPitch = 0;
    this.speed = 0;
    this.crouch = I.crouch;
    this.pelvisH.x = lerp(0.935, 0.6, I.crouch); this.pelvisH.v = 0;
    for (const f of this.feet) {
      this.neutralFoot(f, I.pos, I.bodyYaw, f.pos);
      f.pos.y = I.pos.y;
      f.yaw = I.bodyYaw + f.sign * 0.12;
      f.planted = true; f.t = 0; f.pitch = 0;
    }
    this.reloadT = -1; this.throwT = -1; this.magHeld = false;
    this.aimBlend = I.weapon === 'aim' ? 1 : 0;
    this.initialized = false;
  }

  neutralFoot(f, pos, yaw, out) {
    const c = this.crouch;
    const lat = lerp(0.105, 0.14, c);
    const fore = c * (f.side === 'L' ? 0.14 : -0.12);
    leftOf(yaw, tmpV[14]);
    fwd(yaw, tmpV[15]);
    return out.copy(pos).addScaledVector(tmpV[14], f.sign * lat).addScaledVector(tmpV[15], fore + 0.01);
  }

  startReload() { if (this.reloadT < 0) { this.reloadT = 0; this.magHeld = false; } }
  get reloading() { return this.reloadT >= 0; }
  startThrow(onRelease) { if (this.throwT < 0) { this.throwT = 0; this.onRelease = onRelease; this.released = false; } }
  get throwing() { return this.throwT >= 0; }

  fire(rng) {
    this.recoil.back.v -= 0.9;
    this.recoil.pitch.v += 1.6 + rng.next() * 0.6;
    this.recoil.yaw.v += (rng.next() - 0.5) * 0.9;
  }

  /** Bullet impact reaction. dir: bullet travel direction (world, unit). */
  hit(dir, zone, strength = 1) {
    // bend away from the impact: axis = up x dir
    const ax = tmpV[0].crossVectors(UP, dir).normalize();
    const k = zone === 'head' ? 1.6 : zone === 'limb' ? 0.6 : 1.0;
    this.hitAngV.addScaledVector(ax, 5.5 * strength * k);
    this.hitPushV.addScaledVector(dir, 0.55 * strength);
    if (zone === 'head') this.shake = 1;
  }

  // ------------------------------------------------------------------ main update
  update(dt, t) {
    const I = this.in;
    const pose = this.body.pose;
    this.time = t;
    if (!this.initialized) { this.reset(); this.initialized = true; }
    dt = Math.min(dt, 1 / 20);

    // ---- locomotion parameters
    const hv = tmpV[0].set(I.vel.x, 0, I.vel.z);
    const speedRaw = hv.length();
    this.speed = damp(this.speed, speedRaw, 10, dt);
    const speed = this.speed;
    this.runBlend = damp(this.runBlend, smoothstep(2.6, 4.6, speed), 6, dt);
    this.crouch = damp(this.crouch, I.crouch, 7, dt);
    this.lean = damp(this.lean, I.lean, 6, dt);
    this.accel.subVectors(I.vel, this.prevVel).divideScalar(Math.max(dt, 1e-4));
    this.prevVel.copy(I.vel);
    const aiming = I.weapon === 'aim' ? 1 : 0;
    this.aimBlend = damp(this.aimBlend, aiming, 9, dt);

    // pelvis / body yaw
    this.pelvisYaw = dampAngle(this.pelvisYaw, I.bodyYaw, 8, dt);

    this.updateFeet(dt, speed);

    // ---- pelvis
    const run = this.runBlend;
    const crouch = this.crouch;
    const moving = smoothstep(0.1, 0.8, speed);
    const baseH = lerp(lerp(0.935, 0.875, run), 0.6, crouch);
    spring(this.pelvisH, baseH, 9, dt);
    const ph = this.phase * Math.PI * 2;
    const bobWalk = 0.018 * Math.cos(2 * ph - 2 * Math.PI * 0.38) * (1 - run);
    const bobRun = -0.032 * Math.cos(2 * ph - 2 * Math.PI * 0.19) * run;
    const bob = (bobWalk + bobRun) * moving * (1 - 0.5 * crouch);
    const breath = 0.004 * Math.sin(t * 1.7 + this.seed);
    const idleShift = 0.012 * Math.sin(t * 0.37 + this.seed * 2.1) * (1 - moving);
    const sway = (0.024 * (1 - run) + 0.012 * run) * Math.cos(ph - 2 * Math.PI * 0.19) * moving;

    // lean into acceleration / speed (body frame)
    fwd(this.pelvisYaw, tmpV[1]);
    leftOf(this.pelvisYaw, tmpV[2]);
    const aF = clamp(this.accel.dot(tmpV[1]), -12, 12), aS = clamp(this.accel.dot(tmpV[2]), -12, 12);
    const vF = I.vel.dot(tmpV[1]);
    spring(this.leanFwd, clamp(0.012 * aF + 0.045 * Math.max(0, vF) * (0.35 + run), -0.12, 0.4), 7, dt);
    spring(this.leanSide, clamp(-0.01 * aS, -0.12, 0.12), 7, dt);

    // hit reaction springs (under-damped)
    this.integrateHit(dt);

    const pelvisPos = pose.p[B.pelvis];
    pelvisPos.copy(I.pos);
    pelvisPos.y += this.pelvisH.x + bob + breath * 0.3;
    pelvisPos.addScaledVector(tmpV[2], -sway + idleShift); // sway towards the stance foot (right = -left)
    pelvisPos.add(this.hitPush);
    // lean shifts the hips opposite to the chest
    pelvisPos.addScaledVector(tmpV[2], -this.lean * 0.05);

    const twist = 0.09 * Math.sin(ph) * moving * (1 - 0.4 * run) + 0.14 * Math.sin(ph) * run * moving;
    const hipDrop = 0.05 * Math.sin(ph + Math.PI / 2) * moving * (1 - run);
    const pelvisPitch = this.leanFwd.x * 0.55 + crouch * 0.28 + run * 0.06;
    yawQuat(this.pelvisYaw + twist, -pelvisPitch, hipDrop + this.leanSide.x * 0.5 + this.lean * 0.08, pose.q[B.pelvis]);

    // ---- chest target (aim driven)
    const reloadBlend = this.reloadT >= 0 ? smoothstep(0, 0.2, this.reloadT) * smoothstep(this.reloadDur, this.reloadDur - 0.3, this.reloadT) : 0;
    let throwTwist = 0;
    if (this.throwT >= 0) {
      const tt = this.throwT;
      throwTwist = -0.55 * smoothstep(0.0, 0.35, tt) * (1 - smoothstep(0.35, 0.52, tt)) + 0.45 * smoothstep(0.35, 0.52, tt) * (1 - smoothstep(0.7, 1.05, tt));
    }
    const blade = lerp(-0.2, -0.55, this.aimBlend) * (1 - run * 0.8);
    const chestYawT = I.aimYaw + blade + throwTwist;
    // limit chest twist relative to pelvis
    const rel = clamp(wrapAngle(chestYawT - this.pelvisYaw), -1.2, 1.2);
    this.chestYaw = dampAngle(this.chestYaw, this.pelvisYaw + rel, 14, dt);
    const aimP = I.aimPitch;
    const chestPitchT = aimP * lerp(0.35, 0.6, this.aimBlend) - pelvisPitch * 0.45 - this.leanFwd.x * 0.6 * (1 - 0.5 * this.aimBlend) + crouch * 0.12 - run * 0.1 * (1 - this.aimBlend) - reloadBlend * 0.08 - 0.09 * this.aimBlend;
    this.chestPitch = damp(this.chestPitch, chestPitchT, 12, dt);
    const chestQ = tmpQ[0];
    yawQuat(this.chestYaw, this.chestPitch + breath * 0.8, -this.lean * 0.32 + this.leanSide.x * 0.3, chestQ);
    // add hit flinch (axis-angle)
    const ang = this.hitAng.length();
    if (ang > 1e-5) { tmpQ[1].setFromAxisAngle(tmpV[3].copy(this.hitAng).divideScalar(ang), ang); chestQ.premultiply(tmpQ[1]); }

    // spine distribution
    pose.q[B.spine1].slerpQuaternions(pose.q[B.pelvis], chestQ, 0.3);
    pose.fk(B.spine1);
    pose.q[B.spine2].slerpQuaternions(pose.q[B.pelvis], chestQ, 0.65);
    pose.fk(B.spine2);
    pose.q[B.chest].copy(chestQ);
    pose.fk(B.chest);

    // ---- head / neck
    const headYaw = I.headYaw !== null ? I.headYaw : I.aimYaw;
    const adsTilt = this.aimBlend * (1 - reloadBlend);
    const hRel = clamp(wrapAngle(headYaw - this.chestYaw), -1.1, 1.1);
    const headQ = tmpQ[2];
    const hp = (I.headYaw !== null ? I.headPitch : aimP) * 0.85 - adsTilt * 0.26 + reloadBlend * -0.35;
    yawQuat(this.chestYaw + hRel, hp, adsTilt * 0.2 + (this.shake > 0 ? Math.sin(t * 40) * 0.05 * this.shake : 0), headQ);
    pose.fk(B.neck);
    pose.q[B.neck].slerpQuaternions(chestQ, headQ, 0.45);
    pose.fk(B.head);
    pose.q[B.head].copy(headQ);
    this.shake = Math.max(0, this.shake - dt * 3);

    // clavicles: slight shrug/protraction when shouldering
    for (const s of ['L', 'R']) {
      const ci = B['clav' + s];
      pose.q[ci].copy(chestQ);
      fwd(this.chestYaw, tmpV[4]);
      tmpQ[3].setFromAxisAngle(tmpV[4], (s === 'L' ? 1 : -1) * 0.06 * this.aimBlend);
      pose.q[ci].premultiply(tmpQ[3]);
      pose.fk(ci);
      pose.q[B['upperarm' + s]].copy(pose.q[ci]);
      pose.fk(B['upperarm' + s]);
    }

    // ---- weapon
    this.updateWeapon(dt, t, chestQ);

    // ---- arms
    this.updateArms(dt, chestQ);

    // ---- legs
    for (const f of this.feet) this.solveLeg(f);

    // actions
    if (this.reloadT >= 0) { this.reloadT += dt; if (this.reloadT >= this.reloadDur) { this.reloadT = -1; this.magHeld = false; } }
    if (this.throwT >= 0) {
      const prev = this.throwT;
      this.throwT += dt;
      if (!this.released && prev < 0.46 && this.throwT >= 0.46) { this.released = true; this.onRelease?.(); }
      if (this.throwT >= this.throwDur) this.throwT = -1;
    }
  }

  integrateHit(dt) {
    // angular: x'' = -k x - c x'
    const k = 170, c = 15, kp = 90, cp = 14;
    this.hitAngV.addScaledVector(this.hitAng, -k * dt).multiplyScalar(Math.max(0, 1 - c * dt));
    this.hitAng.addScaledVector(this.hitAngV, dt);
    this.hitPushV.addScaledVector(this.hitPush, -kp * dt).multiplyScalar(Math.max(0, 1 - cp * dt));
    this.hitPush.addScaledVector(this.hitPushV, dt);
    this.hitPush.y = 0;
  }

  // ------------------------------------------------------------------ feet / gait
  updateFeet(dt, speed) {
    const I = this.in;
    const moving = speed > 0.14;
    const run = this.runBlend;
    const stride = clamp(0.8 + 0.38 * speed, 0.8, 2.9) * (1 - 0.3 * this.crouch);
    const f = speed / stride; // cycles per second
    const duty = lerp(0.62, 0.33, smoothstep(2.3, 4.4, speed));
    const swingDur = clamp((1 - duty) / Math.max(f, 0.01), 0.17, 0.42);
    const prevPhase = this.phase;
    if (moving) this.phase = (this.phase + f * dt) % 1;
    else {
      // settle the phase so restarts begin with a sensible foot
      this.phase = (this.phase + dt * 0.0) % 1;
    }
    const crossed = (lift) => {
      if (!moving) return false;
      const a = prevPhase, b = this.phase;
      return a <= b ? (lift > a && lift <= b) : (lift > a || lift <= b);
    };
    const velDir = tmpV[5].set(I.vel.x, 0, I.vel.z);
    const stanceLen = moving ? duty * stride : 0;
    if (velDir.lengthSq() > 1e-6) velDir.normalize();

    for (let i = 0; i < 2; i++) {
      const foot = this.feet[i], other = this.feet[1 - i];
      const liftPhase = i === 0 ? 0.0 : 0.5;
      if (foot.planted) {
        let go = false, dur = swingDur, lift = lerp(lerp(0.09, 0.27, run), 0.07, this.crouch);
        if (moving && crossed(liftPhase)) go = true;
        else if (!moving && other.planted) {
          const n = this.neutralFoot(foot, I.pos, I.bodyYaw, tmpV[6]);
          const err = Math.hypot(n.x - foot.pos.x, n.z - foot.pos.z);
          const yawErr = Math.abs(wrapAngle(I.bodyYaw + foot.sign * 0.12 - foot.yaw));
          const otherN = this.neutralFoot(other, I.pos, I.bodyYaw, tmpV[7]);
          const otherErr = Math.hypot(otherN.x - other.pos.x, otherN.z - other.pos.z);
          if ((err > 0.13 || yawErr > 0.55) && err + yawErr * 0.2 >= otherErr - 1e-4) { go = true; dur = 0.3; lift = 0.06; }
        } else if (moving && other.planted === false && run < 0.5) {
          // walking: never lift both
        }
        if (go) {
          foot.planted = false; foot.t = 0; foot.dur = dur; foot.lift = lift; foot.run = run;
          foot.from.copy(foot.pos); foot.fromYaw = foot.yaw;
        }
      }
      if (!foot.planted) {
        const remain = (1 - foot.t) * foot.dur;
        // predicted landing: neutral at landing time + half a stance ahead
        tmpV[8].copy(I.pos).addScaledVector(I.vel, remain);
        tmpV[8].y = I.pos.y;
        this.neutralFoot(foot, tmpV[8], I.bodyYaw, foot.to);
        foot.to.addScaledVector(velDir, stanceLen * 0.5);
        foot.to.y = this.groundY ? this.groundY(foot.to.x, foot.to.z, I.pos.y) : I.pos.y;
        foot.toYaw = I.bodyYaw + foot.sign * 0.12;
        foot.t += dt / foot.dur;
        if (foot.t >= 1) {
          foot.t = 1; foot.planted = true;
          foot.pos.copy(foot.to); foot.yaw = foot.toYaw; foot.pitch = 0.12 * (1 - this.crouch) * smoothstep(0.3, 1.5, speed);
          this.onFootstep?.(foot, speed);
        } else {
          const tt = foot.t;
          // horizontal progress: running feet trail behind before swinging through
          const e = lerp(smoothstep(0, 1, tt), Math.pow(smoothstep(0.12, 1, tt), 1.6), foot.run);
          foot.pos.lerpVectors(foot.from, foot.to, e);
          const peak = lerp(0.42, 0.3, foot.run);
          const h = tt < peak ? Math.sin((tt / peak) * Math.PI / 2) : Math.cos(((tt - peak) / (1 - peak)) * Math.PI / 2);
          foot.pos.y = lerp(foot.from.y, foot.to.y, e) + foot.lift * h;
          foot.yaw = foot.fromYaw + wrapAngle(foot.toYaw - foot.fromYaw) * e;
          // toe-off -> toe-up before strike
          foot.pitch = lerp(-0.6 * (0.5 + 0.9 * foot.run), 0.2, smoothstep(0.05, 0.85, tt)) * (1 - this.crouch * 0.5);
        }
      } else {
        // heel-strike rolls flat; crouching: rear foot on its toes
        const crouchHeel = foot.side === 'R' ? -0.55 * this.crouch : 0;
        foot.pitch = damp(foot.pitch, crouchHeel, 12, dt);
        // heel rises at the end of the stance while walking/running
        if (moving) {
          const lp = i === 0 ? 0.0 : 0.5;
          let d = lp - this.phase; if (d < 0) d += 1; // phase remaining until lift
          const pre = smoothstep(0.22, 0.0, d) * (0.35 + 0.4 * run);
          foot.pitch = Math.min(foot.pitch, -pre);
        }
      }
    }
  }

  solveLeg(foot) {
    const pose = this.body.pose;
    const s = foot.side;
    const thigh = B['thigh' + s], shin = B['shin' + s], ft = B['foot' + s], toe = B['toe' + s];
    // hip joint
    const hip = pose.fk(thigh);
    // foot orientation (pivot at the ball for heel-raise, at the heel for toe-up)
    yawQuat(foot.yaw, 0, 0, tmpQ[4]);
    yawQuat(foot.yaw, foot.pitch, 0, foot.q);
    const ball = tmpV[9].copy(BALL); ball.x *= foot.sign; // mirror
    const ankle = foot.ankle;
    if (foot.pitch <= 0) {
      // ball stays on the ground
      tmpV[10].copy(ball).applyQuaternion(tmpQ[4]).add(foot.pos).setY(foot.pos.y + BALL.y + ANKLE_H);
      ankle.copy(ball).negate().applyQuaternion(foot.q).add(tmpV[10]);
    } else {
      tmpV[10].copy(HEEL).applyQuaternion(tmpQ[4]).add(foot.pos).setY(foot.pos.y + 0.012);
      ankle.copy(HEEL).negate().applyQuaternion(foot.q).add(tmpV[10]);
    }
    // knee pole: forward of the foot + slightly outward
    fwd(foot.yaw, tmpV[11]);
    leftOf(foot.yaw, tmpV[12]);
    tmpV[11].addScaledVector(tmpV[12], foot.sign * 0.18).add(tmpV[13].set(0, 0.05, 0));
    const knee = tmpV[12];
    const end = tmpV[13];
    solveTwoBone(hip, ankle, LEN.thigh, LEN.shin, tmpV[11], knee, end);
    const L = LEG[s];
    const dThigh = tmpV[14].subVectors(knee, hip);
    const dShin = tmpV[15].subVectors(end, knee);
    const n = tmpV[3].crossVectors(dThigh, dShin);
    if (n.lengthSq() < 1e-6) n.crossVectors(tmpV[11], dThigh.clone ? tmpV[4].copy(dThigh).add(dShin) : dThigh);
    quatFromBases(L.thDir, L.n, dThigh, n, pose.q[thigh]);
    pose.fk(shin);
    quatFromBases(L.shDir, L.n, dShin, n, pose.q[shin]);
    pose.fk(ft);
    pose.q[ft].copy(foot.q);
    pose.fk(toe);
    // toe stays flat when the heel is raised
    if (foot.pitch < 0 && foot.planted) pose.q[toe].copy(tmpQ[4]);
    else pose.q[toe].copy(foot.q);
  }

  // ------------------------------------------------------------------ weapon
  updateWeapon(dt, t, chestQ) {
    const I = this.in;
    const pose = this.body.pose;
    const chestP = pose.p[B.chest];
    const invChest = tmpQ[5].copy(chestQ).invert();
    const mode = this.reloadT >= 0 ? 'reload' : this.throwT >= 0 ? 'throw' : I.weapon;
    const posT = this.wPosTarget, quatT = this.wQuatTarget;
    const sway = 0.006 * Math.sin(t * 1.3 + this.seed) * (1 - this.aimBlend * 0.6);
    const swayP = 0.008 * Math.sin(t * 0.9 + this.seed * 1.7);
    if (mode === 'aim' || mode === 'low' || mode === 'patrol') {
      // world rotation from aim; stock in the shoulder pocket
      const low = mode === 'low' ? 1 : mode === 'patrol' ? 1.25 : 0;
      yawQuat(I.aimYaw + 0.28 * low + sway, I.aimPitch * (1 - 0.3 * low) - 0.62 * low + swayP, -0.12 * low, tmpQ[6]);
      // shoulder pocket (chest-local)
      tmpV[0].set(-0.108 + 0.03 * low, 0.165 - 0.09 * low, 0.1 + 0.06 * low);
      const pocketW = tmpV[1].copy(tmpV[0]).applyQuaternion(chestQ).add(chestP);
      // weapon origin = pocket - R*butt
      const origin = tmpV[2].copy(WEAPON.butt).applyQuaternion(tmpQ[6]).negate().add(pocketW);
      posT.subVectors(origin, chestP).applyQuaternion(invChest);
      quatT.copy(invChest).multiply(tmpQ[6]);
    } else if (mode === 'sprint') {
      yawQuat(0.95, 0.5, -0.35, quatT);
      posT.set(0.02, -0.06, 0.24);
    } else if (mode === 'reload') {
      const tt = this.reloadT;
      const lift = smoothstep(0.1, 0.4, tt) * (1 - smoothstep(this.reloadDur - 0.4, this.reloadDur, tt));
      yawQuat(0.42 * lift, 0.12 * lift - 0.35 * (1 - lift), -0.62 * lift, quatT);
      posT.set(-0.06, -0.02 - 0.06 * (1 - lift), 0.3);
      // tap on the mag insertion
      const seat = Math.exp(-Math.pow((tt - 1.62) / 0.05, 2));
      posT.y += 0.01 * seat;
    } else if (mode === 'throw') {
      yawQuat(0.55, -0.95, 0.2, quatT);
      posT.set(0.14, -0.2, 0.22);
    }
    // spring towards the target in chest space
    const omega = mode === 'aim' ? 16 : 11;
    springV(this.wPos, this.wVel, posT, omega, dt);
    this.wQuat.slerp(quatT, 1 - Math.exp(-omega * 0.9 * dt));

    // recoil springs
    const R = this.recoil;
    for (const k of ['back', 'pitch', 'yaw']) {
      const st = R[k];
      st.v += (-st.x * 900 - st.v * 38) * dt;
      st.x += st.v * dt;
    }
    // world transform
    const wq = pose.q[B.weapon];
    wq.copy(chestQ).multiply(this.wQuat);
    const wp = pose.p[B.weapon];
    wp.copy(this.wPos).applyQuaternion(chestQ).add(chestP);
    // recoil in weapon space: kick back and muzzle climb about the grip
    tmpV[3].set(0, 0, 0.022 * R.back.x).applyQuaternion(wq);
    wp.add(tmpV[3]);
    fwd(0, tmpV[4]);
    tmpQ[7].setFromEuler(_e.set(-0.045 * R.pitch.x, 0.02 * R.yaw.x, 0, 'YXZ'));
    wq.multiply(tmpQ[7]);

    // magazine
    const mi = B.mag;
    if (this.magHeld) {
      const hq = pose.q[B.handL], hp = pose.p[B.handL];
      _m.compose(hp, hq, tmpV[5].set(1, 1, 1)).multiply(this.magInHand);
      _m.decompose(pose.p[mi], pose.q[mi], tmpV[5]);
    } else {
      pose.q[mi].copy(wq);
      pose.p[mi].copy(OFFSET[mi]).applyQuaternion(wq).add(wp);
    }
  }

  /** Weapon-space point to world. */
  weaponToWorld(local, out) {
    const pose = this.body.pose;
    return out.copy(local).applyQuaternion(pose.q[B.weapon]).add(pose.p[B.weapon]);
  }

  /** Hand world rotation from a grip frame (t = index-side axis, p = palm normal), weapon space. */
  gripQuat(side, grip, out) {
    const wq = this.body.pose.q[B.weapon];
    const T = tmpV[6].copy(grip.t).applyQuaternion(wq);
    const P = tmpV[7].copy(grip.p).applyQuaternion(wq);
    // right: T = L x P -> L = P x T ; left (mirrored): L = T x P
    const Lw = side === 'R' ? tmpV[8].crossVectors(P, T) : tmpV[8].crossVectors(T, P);
    return quatFromBases(HAND[side].L, HAND[side].P, Lw, P, out);
  }

  // ------------------------------------------------------------------ arms
  updateArms(dt, chestQ) {
    const pose = this.body.pose;
    const qR = tmpQ[6], qL = tmpQ[7];
    // right hand on the pistol grip
    this.gripQuat('R', WEAPON.gripR, qR);
    const cR = this.weaponToWorld(WEAPON.gripR.c, tmpV[9]);
    const wristR = tmpV[10].copy(HAND.R.grip).applyQuaternion(qR).negate().add(cR);
    // left hand: handguard unless reloading
    this.gripQuat('L', WEAPON.gripL, qL);
    const cL = this.weaponToWorld(WEAPON.gripL.c, tmpV[11]);
    const wristL = tmpV[12].copy(HAND.L.grip).applyQuaternion(qL).negate().add(cL);

    if (this.reloadT >= 0) this.reloadLeftHand(chestQ, wristL, qL);
    if (this.throwT >= 0) this.throwRightHand(chestQ, wristR, qR);

    this.solveArm('R', wristR, qR, chestQ);
    this.solveArm('L', wristL, qL, chestQ);
  }

  reloadLeftHand(chestQ, wristL, qL) {
    const pose = this.body.pose;
    const tt = this.reloadT;
    const chestP = pose.p[B.chest];
    // key positions
    const magW = this.weaponToWorld(tmpV[0].set(0, -0.12, 0.03), tmpV[13]); // mag body
    const pouch = tmpV[14].set(0.02, -0.12, 0.22).applyQuaternion(chestQ).add(chestP); // front mag pouch
    const grab = tmpV[15];
    // hand frame gripping the mag: palm facing the mag's front, fingers wrapping
    const wq = pose.q[B.weapon];
    const T = tmpV[1].set(0, -1, 0.15).normalize().applyQuaternion(wq);
    const P = tmpV[2].set(-0.15, 0, -1).normalize().applyQuaternion(wq);
    const Lw = tmpV[3].crossVectors(T, P);
    const qMag = tmpQ[1];
    quatFromBases(HAND.L.L, HAND.L.P, Lw, P, qMag);
    grab.copy(HAND.L.grip).applyQuaternion(qMag).negate().add(magW);

    let w = 0;
    const kf = (a, b) => smoothstep(a, b, tt);
    if (tt < 0.55) {
      // handguard -> mag
      w = kf(0.15, 0.55);
      wristL.lerp(grab, w); qL.slerp(qMag, w);
    } else if (tt < 1.25) {
      // pull the mag, swing to the pouch and back with the fresh one
      if (!this.magHeld) {
        this.magHeld = true;
        const hp = grab, hq = qMag;
        _m.compose(hp, hq, tmpV[4].set(1, 1, 1)).invert();
        const mag = tmpV[5];
        const mq = tmpQ[2].copy(wq);
        mag.copy(OFFSET[B.mag]).applyQuaternion(wq).add(pose.p[B.weapon]);
        this.magInHand.compose(mag, mq, tmpV[4].set(1, 1, 1)).premultiply(_m);
      }
      const out = kf(0.55, 0.72); // pull down
      const toP = kf(0.72, 0.98); // to the pouch
      const back = kf(1.02, 1.25);
      tmpV[4].copy(grab).addScaledVector(tmpV[6].set(0, -1, 0.1).applyQuaternion(wq), 0.1 * out);
      tmpV[4].lerp(pouch, toP * (1 - back));
      if (back > 0) tmpV[4].lerp(tmpV[5].copy(grab).addScaledVector(tmpV[6].set(0, -1, 0.1).applyQuaternion(wq), 0.1), back);
      wristL.copy(tmpV[4]);
      qL.copy(qMag);
      tmpQ[3].setFromAxisAngle(tmpV[7].set(1, 0, 0).applyQuaternion(chestQ), 0.8 * toP * (1 - back));
      qL.premultiply(tmpQ[3]);
    } else if (tt < 1.7) {
      // insert
      const ins = kf(1.25, 1.6);
      wristL.copy(grab).addScaledVector(tmpV[6].set(0, -1, 0.1).applyQuaternion(wq), 0.1 * (1 - ins));
      qL.copy(qMag);
      if (tt > 1.62 && this.magHeld) this.magHeld = false;
    } else {
      // back to the handguard
      if (this.magHeld) this.magHeld = false;
      const b = kf(1.7, 2.1);
      tmpV[4].copy(grab).lerp(wristL, b);
      wristL.copy(tmpV[4]);
      tmpQ[3].copy(qMag).slerp(qL, b);
      qL.copy(tmpQ[3]);
    }
  }

  throwRightHand(chestQ, wristR, qR) {
    const pose = this.body.pose;
    const tt = this.throwT;
    const chestP = pose.p[B.chest];
    const k = (a, b) => smoothstep(a, b, tt);
    const back = tmpV[13].set(-0.22, 0.3, -0.16).applyQuaternion(chestQ).add(chestP);
    const rel = tmpV[14].set(-0.12, 0.42, 0.34).applyQuaternion(chestQ).add(chestP);
    const follow = tmpV[15].set(0.08, -0.12, 0.38).applyQuaternion(chestQ).add(chestP);
    const pos = tmpV[0].copy(wristR);
    pos.lerp(back, k(0.0, 0.33));
    if (tt > 0.33) pos.copy(back).lerp(rel, k(0.33, 0.47));
    if (tt > 0.47) pos.copy(rel).lerp(follow, k(0.47, 0.72));
    if (tt > 0.72) pos.copy(follow).lerp(wristR, k(0.72, 1.02));
    wristR.copy(pos);
    // palm forward when throwing
    yawQuat(this.chestYaw, 0.4 - 1.4 * k(0.33, 0.6), 0, tmpQ[3]);
    tmpQ[4].setFromAxisAngle(tmpV[1].set(0, 0, 1), -Math.PI / 2);
    tmpQ[3].multiply(tmpQ[4]);
    const w = k(0.0, 0.2) * (1 - k(0.8, 1.02));
    qR.slerp(tmpQ[3], w);
    this.handTarget.R.copy(wristR);
  }

  solveArm(s, wrist, handQ, chestQ) {
    const pose = this.body.pose;
    const ui = B['upperarm' + s], fi = B['forearm' + s], hi = B['hand' + s];
    const sh = pose.p[ui];
    // pole: elbow down/out/back (chest space)
    const pole = tmpV[1].set(s === 'L' ? 0.35 : -0.7, -0.85, -0.25).applyQuaternion(chestQ);
    const elbow = tmpV[2], end = tmpV[3];
    solveTwoBone(sh, wrist, LEN.upperarm, LEN.forearm, pole, elbow, end);
    const A = ARM[s];
    const dU = tmpV[4].subVectors(elbow, sh);
    const dF = tmpV[5].subVectors(end, elbow);
    const n = tmpV[6].crossVectors(dU, dF);
    if (n.lengthSq() < 1e-7) n.crossVectors(pole, tmpV[7].subVectors(end, sh));
    quatFromBases(A.upDir, A.n, dU, n, pose.q[ui]);
    pose.fk(fi);
    const fq = pose.q[fi];
    quatFromBases(A.foDir, A.n, dF, n, fq);
    // forearm twist follows the hand halfway (avoid candy-wrapping at the wrist)
    const rel = tmpQ[3].copy(fq).invert().multiply(handQ);
    const tw = twistAngle(rel, A.foDir);
    tmpQ[4].setFromAxisAngle(A.foDir, tw * 0.55);
    fq.multiply(tmpQ[4]);
    pose.fk(hi);
    pose.q[hi].copy(handQ);
  }
}

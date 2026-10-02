import * as THREE from 'three';
import { Track, PoseTrack, XfTrack } from './anim.js';

/**
 * Keyframed viewmodel clips. Every clip is data:
 *   gun:    Track [[t, x, y, z, rx, ry, rz]] gun offset around the weapon pivot (m / deg, gun space)
 *   lh/rh:  XfTrack hand targets in gun space, authored against anchors:
 *             'grip'  -> the weapon's resting grip  (dpos in gun space, drot deg in hand space)
 *             'mag'   -> hand holding the magazine, magazine at seat + dpos (drot rotates the magazine)
 *             'free'  -> absolute gun-space position dpos, orientation = mag-holding hand * drot
 *             'catch' -> palm on the bolt catch / slide stop
 *   lhW/rhW: Track [[t, w]] blend of the clip target over the resting grip
 *   lhPose/rhPose: PoseTrack [[t, poseName, blendDur]]
 *   events: [[t, name]]  (magGrab, magDrop, magNew, magSeat, boltRelease, meleeHit, grenadeShow, pinPull, grenadeRelease, fireMode, ...)
 */
const DEG = Math.PI / 180;

export function buildClips(id, rec) {
  const _q = new THREE.Quaternion();
  const _m = new THREE.Matrix4();
  const _m2 = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3(1, 1, 1);
  const invMagInHand = rec.magInHand.clone().invert();
  const seat = rec.sockets.magSeat.position;
  const catchPt = rec.sockets.catch?.position || new THREE.Vector3(-0.02, -0.02, -0.078);

  const eul = (r) => _q.setFromEuler(new THREE.Euler((r[0] || 0) * DEG, (r[1] || 0) * DEG, (r[2] || 0) * DEG, 'YXZ'));
  function resolve(side, anchor, dpos = [0, 0, 0], drot = [0, 0, 0]) {
    const grip = side === 'l' ? rec.gripL : rec.gripR;
    const outQ = new THREE.Quaternion();
    const outP = new THREE.Vector3();
    if (anchor === 'grip') {
      outP.copy(grip.pos).add(_p.fromArray(dpos));
      outQ.copy(grip.quat).multiply(eul(drot));
    } else if (anchor === 'mag') {
      _m.compose(_p.copy(seat).add(new THREE.Vector3().fromArray(dpos)), eul(drot).clone(), _s);
      _m2.multiplyMatrices(_m, invMagInHand);
      _m2.decompose(outP, outQ, new THREE.Vector3());
    } else if (anchor === 'free') {
      outP.fromArray(dpos);
      outQ.copy(rec.magHold.quat).multiply(eul(drot));
    } else if (anchor === 'catch') {
      // palm heel onto the catch: hand below/behind, palm facing +x (left hand) or -x (right hand)
      outP.copy(catchPt).add(_p.fromArray(dpos));
      outQ.copy(rec.catchHold || rec.magHold.quat).multiply(eul(drot));
    }
    return outP.toArray().concat(outQ.toArray());
  }
  const xf = (side, keys) => new XfTrack(keys.map(([t, a, p, r]) => [t, ...resolve(side, a, p, r)]), (side === 'l' ? rec.gripL : rec.gripR).quat);
  const tr = (keys) => new Track(keys);
  const pt = (keys) => new PoseTrack(keys);

  if (id === 'rifle') return rifleClips({ xf, tr, pt, rec });
  return pistolClips({ xf, tr, pt, rec });
}

// ============================================================================================ rifle
function rifleClips({ xf, tr, pt, rec }) {
  // hand (left) that holds the magazine at the seat, rotated with the magazine
  rec.catchHold = new THREE.Quaternion().setFromEuler(new THREE.Euler(10 * DEG, 0, 0)).premultiply(rec.gripL.quat.clone());
  const T = 2.1;
  const reload = {
    dur: T,
    allowAds: false,
    gun: tr([
      [0.0, 0, 0, 0, 0, 0, 0],
      [0.26, -0.022, 0.018, 0.028, 11, 7, -27],
      [0.34, -0.024, 0.016, 0.03, 10, 7, -29],
      [0.44, -0.022, 0.022, 0.028, 12, 6, -27], // mag pulled: gun lifts a touch
      [0.9, -0.026, 0.02, 0.03, 10, 8, -30],
      [1.28, -0.026, 0.014, 0.03, 8, 8, -31],
      [1.44, -0.024, 0.008, 0.028, 7, 7, -30],
      [1.5, -0.022, 0.026, 0.024, 12, 6, -26], // seat slap: gun kicks up
      [1.62, -0.022, 0.017, 0.028, 9, 7, -28],
      [1.84, -0.012, 0.01, 0.018, 5, 4, -16],
      [2.1, 0, 0, 0, 0, 0, 0],
    ]),
    lh: xf('l', [
      [0.0, 'grip'],
      [0.08, 'grip', [0.0, -0.01, 0.01], [0, 0, 0]],
      [0.22, 'mag', [-0.012, -0.012, 0.02], [0, 0, -10]],
      [0.3, 'mag', [0, 0, 0]],
      [0.34, 'mag', [0, 0.002, 0]],
      [0.44, 'mag', [0.0, -0.07, 0.004], [4, 0, 0]],
      [0.58, 'mag', [-0.03, -0.17, 0.05], [22, 10, 20]],
      [0.78, 'mag', [-0.09, -0.34, 0.12], [40, 20, 40]],
      [1.0, 'mag', [-0.1, -0.36, 0.12], [40, 20, 40]],
      [1.14, 'mag', [-0.05, -0.2, 0.05], [15, 5, 12]],
      [1.26, 'mag', [-0.006, -0.062, 0.006], [-9, 0, 3]],
      [1.36, 'mag', [0, -0.03, 0.001], [-5, 0, 0]],
      [1.46, 'mag', [0, 0, 0]],
      [1.52, 'mag', [0, -0.004, 0.0], [0, 0, 0]],
      [1.64, 'grip', [-0.012, -0.03, 0.05], [10, 0, -10]],
      [1.82, 'grip', [0, -0.004, 0.004]],
      [1.95, 'grip'],
    ]),
    lhPose: pt([[0, 'gripVert'], [0.08, 'open', 0.14], [0.26, 'magGrab', 0.08], [1.48, 'flat', 0.08], [1.62, 'open', 0.1], [1.78, 'gripVert', 0.12]]),
    events: [[0.05, 'grab_start'], [0.31, 'magGrab'], [1.03, 'magSwap'], [1.46, 'magSeat'], [1.9, 'rattle']],
    pastSeat: false,
  };
  const TE = 2.6;
  const reloadEmpty = {
    dur: TE,
    allowAds: false,
    gun: tr([
      [0.0, 0, 0, 0, 0, 0, 0],
      [0.22, -0.018, 0.02, 0.024, 10, 6, -24],
      [0.3, -0.02, 0.026, 0.024, 12, 6, -25], // mag release: gun jumps as the mag falls away
      [0.7, -0.024, 0.02, 0.028, 10, 8, -30],
      [1.02, -0.026, 0.015, 0.03, 8, 8, -31],
      [1.12, -0.024, 0.009, 0.028, 7, 7, -30],
      [1.18, -0.022, 0.026, 0.024, 12, 6, -26], // seat
      [1.34, -0.028, 0.018, 0.03, 6, 14, -38], // roll more to present the bolt catch
      [1.52, -0.03, 0.016, 0.032, 5, 15, -40],
      [1.58, -0.03, 0.03, 0.022, 8, 13, -36], // bolt slams home
      [1.72, -0.028, 0.02, 0.028, 6, 13, -37],
      [2.1, -0.012, 0.01, 0.016, 3, 5, -15],
      [2.6, 0, 0, 0, 0, 0, 0],
    ]),
    lh: xf('l', [
      [0.0, 'grip'],
      [0.1, 'grip', [-0.01, -0.03, 0.02], [0, 0, -10]],
      [0.34, 'free', [-0.12, -0.26, 0.02], [30, 15, 30]],
      [0.56, 'mag', [-0.1, -0.36, 0.12], [40, 20, 40]],
      [0.66, 'mag', [-0.1, -0.35, 0.12], [40, 20, 40]],
      [0.84, 'mag', [-0.05, -0.2, 0.05], [15, 5, 12]],
      [0.98, 'mag', [-0.006, -0.062, 0.006], [-9, 0, 3]],
      [1.08, 'mag', [0, -0.03, 0.001], [-5, 0, 0]],
      [1.17, 'mag', [0, 0, 0]],
      [1.24, 'mag', [0, -0.004, 0.0]],
      [1.4, 'catch', [-0.035, -0.035, 0.04], [0, 0, 0]],
      [1.52, 'catch', [-0.03, -0.022, 0.016], [0, 0, 0]],
      [1.58, 'catch', [-0.03, -0.016, 0.0], [0, 0, 0]],
      [1.7, 'catch', [-0.04, -0.03, 0.03], [0, 0, 0]],
      [1.95, 'grip', [-0.01, -0.03, 0.04], [10, 0, -10]],
      [2.2, 'grip'],
    ]),
    lhPose: pt([[0, 'gripVert'], [0.1, 'open', 0.14], [0.5, 'magGrab', 0.1], [1.2, 'flat', 0.08], [1.36, 'press', 0.12], [1.66, 'open', 0.12], [2.05, 'gripVert', 0.14]]),
    events: [[0.22, 'magDrop'], [0.6, 'magNew'], [1.17, 'magSeat'], [1.58, 'boltRelease'], [2.2, 'rattle']],
  };
  const inspect = {
    dur: 3.8,
    allowAds: false,
    gun: tr([
      [0.0, 0, 0, 0, 0, 0, 0],
      [0.55, -0.05, 0.03, 0.03, 12, -52, 18],
      [1.5, -0.052, 0.034, 0.028, 10, -58, 20],
      [1.75, -0.052, 0.034, 0.028, 10, -58, 20],
      [2.35, -0.035, 0.03, 0.03, -12, 22, 58],
      [3.1, -0.035, 0.034, 0.028, -10, 26, 60],
      [3.8, 0, 0, 0, 0, 0, 0],
    ]),
    lh: xf('l', [
      [0.0, 'grip'],
      [0.5, 'grip', [0.0, 0.0, -0.02]],
      [2.3, 'grip', [0.0, 0.0, -0.02]],
      [2.62, 'mag', [-0.012, -0.03, 0.02], [0, 0, -8]],
      [2.72, 'mag', [0, -0.006, 0]],
      [2.84, 'mag', [-0.012, -0.03, 0.02], [0, 0, -8]],
      [3.3, 'grip', [0, -0.01, 0.01]],
      [3.6, 'grip'],
    ]),
    lhPose: pt([[0, 'gripVert'], [2.35, 'open', 0.15], [2.6, 'magGrab', 0.1], [2.84, 'open', 0.1], [3.35, 'gripVert', 0.15]]),
    events: [[0.1, 'inspect_start'], [2.72, 'magTap'], [3.5, 'rattle']],
  };
  const melee = {
    dur: 0.66,
    allowAds: false,
    gun: tr([
      [0.0, 0, 0, 0, 0, 0, 0],
      [0.1, 0.035, -0.02, 0.05, 8, -18, -22],
      [0.2, -0.07, 0.035, -0.13, -12, 34, 42],
      [0.27, -0.075, 0.03, -0.12, -10, 36, 44],
      [0.66, 0, 0, 0, 0, 0, 0],
    ]),
    events: [[0.05, 'melee_swing'], [0.2, 'meleeHit']],
  };
  const grenade = {
    dur: 1.1,
    allowAds: false,
    gun: tr([
      [0.0, 0, 0, 0, 0, 0, 0],
      [0.22, 0.05, -0.1, 0.06, -22, -12, -28],
      [0.85, 0.055, -0.11, 0.06, -24, -12, -30],
      [1.1, 0, 0, 0, 0, 0, 0],
    ]),
    lhW: tr([[0, 1]]),
    lh: xf('l', [
      [0.0, 'grip'],
      [0.18, 'grip', [-0.03, -0.18, 0.08], [20, 0, 20]],
      [0.3, 'free', [-0.2, -0.16, 0.12], [-40, -60, 40]],
      [0.46, 'free', [-0.19, 0.02, 0.12], [-60, -70, 50]],
      [0.56, 'free', [-0.18, 0.05, 0.1], [-60, -70, 50]],
      [0.66, 'free', [-0.12, 0.08, -0.12], [-20, -40, 30]],
      [0.8, 'free', [-0.08, -0.12, -0.08], [10, -20, 10]],
      [0.95, 'grip', [0, -0.04, 0.02]],
      [1.08, 'grip'],
    ]),
    lhPose: pt([[0, 'gripVert'], [0.15, 'open', 0.1], [0.3, 'grenade', 0.08], [0.64, 'open', 0.06], [0.95, 'gripVert', 0.12]]),
    events: [[0.3, 'grenadeShow'], [0.44, 'pinPull'], [0.63, 'grenadeRelease']],
  };
  const fireMode = {
    dur: 0.42,
    allowAds: true,
    gun: tr([[0, 0, 0, 0, 0, 0, 0], [0.14, -0.006, 0.004, 0.004, 2, 2, 7], [0.22, -0.006, 0.004, 0.004, 2, 2, 7.5], [0.42, 0, 0, 0, 0, 0, 0]]),
    rhW: tr([[0, 0], [0.08, 1], [0.3, 1], [0.4, 0]]),
    rh: xf('r', [[0, 'grip'], [0.14, 'grip', [0, 0.004, -0.004], [0, 0, 6]], [0.3, 'grip', [0, 0.004, -0.004], [0, 0, 6]], [0.42, 'grip']]),
    events: [[0.2, 'fireMode']],
  };
  return { reload, reloadEmpty, inspect, melee, grenade, fireMode };
}

// ============================================================================================ pistol
function pistolClips({ xf, tr, pt, rec }) {
  rec.catchHold = rec.gripL.quat.clone();
  const reload = {
    dur: 1.55,
    gun: tr([
      [0, 0, 0, 0, 0, 0, 0],
      [0.18, -0.03, 0.03, 0.03, 18, 10, -26],
      [0.3, -0.03, 0.036, 0.03, 20, 10, -24], // mag drops out
      [0.95, -0.03, 0.03, 0.03, 18, 10, -26],
      [1.03, -0.03, 0.045, 0.026, 24, 10, -22], // seat
      [1.18, -0.03, 0.032, 0.03, 18, 10, -25],
      [1.55, 0, 0, 0, 0, 0, 0],
    ]),
    lh: xf('l', [
      [0, 'grip'],
      [0.12, 'grip', [-0.04, -0.06, 0.04], [0, 0, 20]],
      [0.34, 'free', [-0.14, -0.28, 0.12], [30, 15, 30]],
      [0.5, 'mag', [-0.12, -0.33, 0.13], [40, 20, 40]],
      [0.72, 'mag', [-0.04, -0.14, 0.03], [10, 5, 8]],
      [0.86, 'mag', [0, -0.05, 0.004], [-6, 0, 0]],
      [1.0, 'mag', [0, 0, 0]],
      [1.05, 'mag', [0, -0.006, 0]],
      [1.25, 'grip', [-0.03, -0.05, 0.03], [0, 0, 15]],
      [1.45, 'grip'],
    ]),
    lhPose: pt([[0, 'supportWrap'], [0.1, 'open', 0.12], [0.4, 'magGrab', 0.1], [1.02, 'flat', 0.06], [1.2, 'open', 0.1], [1.38, 'supportWrap', 0.12]]),
    events: [[0.26, 'magDrop'], [0.45, 'magNew'], [1.0, 'magSeat']],
  };
  const reloadEmpty = {
    dur: 1.9,
    gun: tr([
      [0, 0, 0, 0, 0, 0, 0],
      [0.18, -0.03, 0.03, 0.03, 18, 10, -26],
      [0.3, -0.03, 0.036, 0.03, 20, 10, -24],
      [0.95, -0.03, 0.03, 0.03, 18, 10, -26],
      [1.03, -0.03, 0.045, 0.026, 24, 10, -22],
      [1.2, -0.03, 0.03, 0.03, 16, 12, -30],
      [1.36, -0.03, 0.05, 0.022, 22, 12, -27], // slide release: slide slams forward
      [1.5, -0.03, 0.035, 0.028, 17, 11, -28],
      [1.9, 0, 0, 0, 0, 0, 0],
    ]),
    lh: xf('l', [
      [0, 'grip'],
      [0.12, 'grip', [-0.04, -0.06, 0.04], [0, 0, 20]],
      [0.34, 'free', [-0.14, -0.28, 0.12], [30, 15, 30]],
      [0.5, 'mag', [-0.12, -0.33, 0.13], [40, 20, 40]],
      [0.72, 'mag', [-0.04, -0.14, 0.03], [10, 5, 8]],
      [0.86, 'mag', [0, -0.05, 0.004], [-6, 0, 0]],
      [1.0, 'mag', [0, 0, 0]],
      [1.05, 'mag', [0, -0.006, 0]],
      [1.3, 'grip', [-0.02, 0.03, 0.02], [0, 0, 10]],
      [1.36, 'grip', [-0.02, 0.02, 0.0], [0, 0, 10]],
      [1.6, 'grip', [-0.02, -0.03, 0.02], [0, 0, 10]],
      [1.8, 'grip'],
    ]),
    lhPose: pt([[0, 'supportWrap'], [0.1, 'open', 0.12], [0.4, 'magGrab', 0.1], [1.02, 'flat', 0.06], [1.2, 'press', 0.08], [1.45, 'open', 0.1], [1.7, 'supportWrap', 0.12]]),
    events: [[0.26, 'magDrop'], [0.45, 'magNew'], [1.0, 'magSeat'], [1.36, 'boltRelease']],
  };
  const inspect = {
    dur: 3.2,
    gun: tr([
      [0, 0, 0, 0, 0, 0, 0],
      [0.5, -0.05, 0.03, 0.02, 10, -60, 15],
      [1.4, -0.05, 0.034, 0.02, 12, -64, 18],
      [2.0, -0.035, 0.03, 0.02, -8, 30, 55],
      [2.7, -0.035, 0.03, 0.02, -8, 32, 58],
      [3.2, 0, 0, 0, 0, 0, 0],
    ]),
    lhW: tr([[0, 0], [0.3, 1], [2.9, 1], [3.2, 0]]),
    lh: xf('l', [[0, 'grip'], [0.4, 'free', [-0.12, -0.25, 0.1], [20, 10, 20]], [2.8, 'free', [-0.12, -0.25, 0.1], [20, 10, 20]], [3.2, 'grip']]),
    lhPose: pt([[0, 'supportWrap'], [0.3, 'relaxed', 0.2], [2.8, 'supportWrap', 0.2]]),
    events: [[0.1, 'inspect_start']],
  };
  const melee = {
    dur: 0.58,
    gun: tr([
      [0, 0, 0, 0, 0, 0, 0],
      [0.09, 0.03, -0.02, 0.05, 6, -14, -18],
      [0.18, -0.06, 0.03, -0.12, -12, 30, 36],
      [0.24, -0.065, 0.03, -0.11, -10, 32, 38],
      [0.58, 0, 0, 0, 0, 0, 0],
    ]),
    lhW: tr([[0, 0], [0.06, 1], [0.45, 1], [0.58, 0]]),
    lh: xf('l', [[0, 'grip'], [0.1, 'free', [-0.12, -0.2, 0.1], [20, 10, 20]], [0.45, 'free', [-0.12, -0.2, 0.1], [20, 10, 20]], [0.58, 'grip']]),
    events: [[0.05, 'melee_swing'], [0.18, 'meleeHit']],
  };
  const grenade = {
    dur: 1.1,
    gun: tr([
      [0.0, 0, 0, 0, 0, 0, 0],
      [0.22, 0.05, -0.1, 0.06, -22, -12, -28],
      [0.85, 0.055, -0.11, 0.06, -24, -12, -30],
      [1.1, 0, 0, 0, 0, 0, 0],
    ]),
    lh: xf('l', [
      [0.0, 'grip'],
      [0.18, 'grip', [-0.03, -0.18, 0.08], [20, 0, 20]],
      [0.3, 'free', [-0.2, -0.16, 0.12], [-40, -60, 40]],
      [0.46, 'free', [-0.19, 0.02, 0.12], [-60, -70, 50]],
      [0.56, 'free', [-0.18, 0.05, 0.1], [-60, -70, 50]],
      [0.66, 'free', [-0.12, 0.08, -0.12], [-20, -40, 30]],
      [0.8, 'free', [-0.08, -0.12, -0.08], [10, -20, 10]],
      [0.95, 'grip', [0, -0.04, 0.02]],
      [1.08, 'grip'],
    ]),
    lhPose: pt([[0, 'supportWrap'], [0.15, 'open', 0.1], [0.3, 'grenade', 0.08], [0.64, 'open', 0.06], [0.95, 'supportWrap', 0.12]]),
    events: [[0.3, 'grenadeShow'], [0.44, 'pinPull'], [0.63, 'grenadeRelease']],
  };
  return { reload, reloadEmpty, inspect, melee, grenade };
}

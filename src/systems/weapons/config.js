/**
 * Weapon tuning tables (gameplay + viewmodel placement). Angles in degrees, distances in meters
 * (viewmodel space before the global viewmodel scale). Gun space: x right, y up, muzzle -z.
 */
export const VM = {
  scale: 0.5,              // uniform viewmodel scale toward the eye (prevents wall clipping, image-invariant)
  fovHip: 72,              // viewmodel horizontal FOV (16:9) at hip (narrow = flatter, CoD-like perspective)
  fovAds: 64,              // viewmodel horizontal FOV while aimed
  shoulderR: [0.2, -0.26, 0.16],
  shoulderL: [-0.2, -0.28, 0.12],
  poleR: [0.55, -1, 0.35],
  poleL: [-0.45, -1, 0.1],
};

export const WEAPONS = {
  rifle: {
    id: 'rifle',
    name: 'WARDEN AR-7',
    kind: 'rifle',
    magSize: 30,
    chamber: 1,
    reserve: 150,
    reserveMax: 270,
    rpm: 750,
    modes: ['auto', 'semi'],
    damage: 31,
    range: 450,
    penetration: 1,
    sound: 'rifle_fire',
    // spread cone (full angle deg)
    spreadHip: 2.6,
    spreadAds: 0.06,
    spreadMove: 1.6,
    bloomPerShot: 0.28,
    bloomMax: 2.2,
    bloomRecover: 5.5,
    // camera recoil (deg per shot) + pattern multipliers (vertical, horizontal) cycling
    camPitch: 0.36,
    camYaw: 0.1,
    camAdsMul: 0.72,
    recoverFrac: 0.45,
    pattern: [
      [1.0, 0.1], [1.05, 0.35], [1.1, -0.2], [1.0, 0.6], [0.95, 0.8], [0.9, 0.3], [0.9, -0.5], [0.85, -0.9],
      [0.85, -0.6], [0.85, 0.2], [0.8, 0.7], [0.8, 1.0], [0.8, 0.4], [0.8, -0.3], [0.8, -0.8], [0.75, -0.4],
    ],
    // visual (viewmodel) recoil impulses: [back m/s, up m/s, pitch rad/s, yaw rad/s, roll rad/s]
    kick: { back: 0.5, up: 0.06, pitch: 0.9, yaw: 0.25, roll: 0.7, adsMul: 0.55 },
    adsTime: 0.24,
    adsZoom: 1.3,
    eyeRelief: 0.1,
    adsSquash: 0.55,        // ADS bore-axis compression (shortens the holo hood tunnel), 0 = off
    // base poses of the gun origin in viewmodel space
    hip: { pos: [0.14, -0.093, -0.29], rot: [-1, 10, -9] },
    sprint: { pos: [0.12, -0.055, -0.32], rot: [-14, 30, 40] },
    tac: { pos: [0.13, -0.06, -0.33], rot: [30, 8, 22] },
    lowered: { pos: [0.1, -0.42, -0.14], rot: [-45, 18, 20] },
    pivot: [0, -0.04, 0.04], // rotation pivot for procedural motion (near the grip / shoulder)
    // hand targets on the gun (gun space): position + hand-frame basis (palm normal, finger direction)
    gripR: { pos: [0.0285, -0.0525, 0.0775], palm: [-0.94, 0.3, 0.0], fingers: [0.02, -0.36, -0.93], roll: 0 },
    gripL: { pos: [-0.030, -0.087, -0.263], palm: [0.97, 0.2, 0.0], fingers: [0.05, 0.2, -0.975], roll: 0 },
    poseR: 'gripTrigger',
    poseL: 'gripVert',
    // grasp colliders (gun space capsules a-b, radius r). mask bits: 1 index, 2 middle, 4 ring, 8 pinky, 16 thumb.
    // part: collider follows that animated part (points given in gun space at rest).
    collidersR: [
      { a: [0, -0.046, 0.004], b: [0, -0.126, 0.025], r: 0.0152, mask: 30 },
      { a: [0, -0.046, 0.012], b: [0, -0.126, 0.033], r: 0.0152, mask: 30 },
      { a: [-0.004, -0.0445, -0.0415], b: [0.004, -0.0445, -0.0415], r: 0.0025, mask: 1, part: 'trigger' },
      { a: [0, -0.013, 0.02], b: [0, -0.013, -0.09], r: 0.0125, mask: 16 },
    ],
    collidersL: [
      { a: [0, -0.037, -0.340], b: [0, -0.108, -0.355], r: 0.0145, mask: 31 },
      { a: [0, -0.003, -0.19], b: [0, -0.003, -0.48], r: 0.0225, mask: 17 },
    ],
    // left hand holding the magazine while it is seated (gun space)
    magHold: { pos: [-0.034, -0.108, -0.083], palm: [0.93, 0.25, 0.15], fingers: [0.1, -0.2, -0.975] },
    reloadTime: 2.1,
    reloadEmptyTime: 2.6,
    equipTime: 0.55,
    holsterTime: 0.32,
  },
  pistol: {
    id: 'pistol',
    name: 'KESTREL P9',
    kind: 'pistol',
    magSize: 15,
    chamber: 1,
    reserve: 60,
    reserveMax: 90,
    rpm: 420,
    modes: ['semi'],
    damage: 34,
    range: 120,
    penetration: 0,
    sound: 'pistol_fire',
    spreadHip: 2.0,
    spreadAds: 0.12,
    spreadMove: 1.2,
    bloomPerShot: 0.6,
    bloomMax: 2.4,
    bloomRecover: 6,
    camPitch: 0.75,
    camYaw: 0.18,
    camAdsMul: 0.8,
    recoverFrac: 0.6,
    pattern: [[1.0, 0.2], [1.0, -0.3], [1.0, 0.5], [1.0, -0.1]],
    kick: { back: 0.45, up: 0.1, pitch: 2.2, yaw: 0.3, roll: 0.5, adsMul: 0.6 },
    adsTime: 0.18,
    adsZoom: 1.15,
    eyeRelief: 0.2,
    hip: { pos: [0.07, -0.075, -0.27], rot: [3, 4, -2] },
    sprint: { pos: [0.08, -0.16, -0.18], rot: [-38, 12, 18] },
    tac: { pos: [0.07, -0.02, -0.18], rot: [55, 0, 10] },
    lowered: { pos: [0.1, -0.4, -0.14], rot: [-45, 18, 20] },
    pivot: [0, -0.06, 0.03],
    gripR: { pos: [0.0215, -0.052, 0.058], palm: [-0.95, 0.28, 0.0], fingers: [0.02, -0.3, -0.955], roll: 0 },
    gripL: { pos: [-0.028, -0.068, 0.038], palm: [0.75, 0.62, -0.1], fingers: [0.3, -0.35, -0.89], roll: 0 },
    poseR: 'gripTrigger',
    poseL: 'supportWrap',
    collidersR: [],
    collidersL: [],
    magHold: { pos: [-0.03, -0.1, 0.06], palm: [0.9, 0.3, 0.2], fingers: [0.1, -0.25, -0.96] },
    reloadTime: 1.55,
    reloadEmptyTime: 1.9,
    equipTime: 0.42,
    holsterTime: 0.28,
  },
};

export const GRENADE = { fuse: 3.2, speed: 17, up: 4.5, radius: 7, damage: 160, count: 2 };

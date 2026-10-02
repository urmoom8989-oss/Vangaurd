/**
 * player/config.js — every movement / camera tunable in one place (units: meters, seconds, radians
 * unless the name says Deg). Values are tuned against modern CoD feel (MWII/MWIII class):
 * snappy ground acceleration, weighty sprint wind-up, a short burst tac-sprint, a momentum slide
 * that decays into a crouch, and a readable-but-subtle camera.
 */
import { PLAYER_DIMENSIONS as DIM } from '../../core/constants.js';

export const DEG = Math.PI / 180;

export const MOVE = Object.freeze({
  // ---- target speeds (m/s)
  walk: 4.2,
  sprint: 6.3,
  tacSprint: 7.5,
  crouch: 2.35,
  prone: 0.9,
  backScale: 0.78, // backpedal multiplier
  strafeScale: 0.9, // pure strafe multiplier
  adsScale: 0.55, // default ADS move multiplier (weapons.state.adsMoveScale overrides)

  // ---- ground acceleration (exponential approach rates, 1/s) + a minimum linear rate (m/s²)
  accel: 10.5, // speeding up towards the wish velocity
  accelSprint: 4.2, // speeding up beyond walk speed (sprint wind-up weight)
  decel: 12.5, // releasing input / slowing down
  turn: 14, // re-directing at constant speed
  minAccel: 7.5,

  // ---- air
  gravity: 20.0, // CoD-ish (≈ 800 in/s²)
  jumpHeight: 0.95,
  airAccel: 2.4, // m/s² of steering in the air
  airDrag: 0.05, // 1/s horizontal drag in the air
  coyoteTime: 0.1,
  jumpBuffer: 0.14,
  maxFall: 42,

  // ---- collision
  walkableCos: Math.cos(48 * DEG), // steeper than this is a wall
  stepHeight: 0.46, // stairs / curbs climbed without jumping
  snapDown: 0.38, // ground-follow distance (stairs going down)
  maxSubstep: 0.11, // max capsule travel per collision substep (<< radius: no tunnelling)
  radius: DIM.radius,

  // ---- sprint / tac-sprint
  sprintMinForward: 0.55, // forward input needed to sprint
  tacDuration: 3.2, // seconds of tac-sprint at full charge
  tacRecharge: 1.25, // charge seconds regained per second (after the delay)
  tacRechargeDelay: 1.0,
  tacMinCharge: 0.6, // need at least this much to start
  doubleTapWindow: 0.32,

  // ---- slide
  slideMinSpeed: 5.4, // need (near) sprint speed to slide
  slideBoost: 1.9, // m/s added on entry
  slideMaxEntry: 9.2,
  slideLinFriction: 1.4, // m/s²
  slideExpFriction: 0.95, // 1/s
  slideEndSpeed: 2.9,
  slideMaxTime: 1.15,
  slideMinTime: 0.35, // before which a cancel is ignored (prevents accidental double-taps)
  slideSteer: 1.1, // rad/s of steering while sliding
  slideSlopeAccel: 0.85, // fraction of gravity along a downhill slope

  // ---- stance
  standToProneTime: 0.62, // movement is heavily restricted while dropping prone
  proneToStandTime: 0.55,

  // ---- mantle
  mantleMin: 0.42,
  mantleMax: 2.05,
  mantleReach: 0.78, // horizontal search distance in front of the capsule surface
  vaultMaxHeight: 1.3, // thin obstacles below this are vaulted over instead of climbed onto
  vaultMaxDepth: 0.75,
});

export const STANCE = Object.freeze({
  stand: { height: DIM.standHeight, eye: DIM.standEye },
  crouch: { height: DIM.crouchHeight, eye: DIM.crouchEye },
  prone: { height: DIM.proneHeight, eye: DIM.proneEye },
  slide: { height: DIM.crouchHeight, eye: 0.8 },
});

export const CAM = Object.freeze({
  // eye-height spring (ω rad/s, ζ damping)
  eyeOmega: 15,
  eyeZeta: 0.82,
  eyeOmegaProne: 7.5,
  stepSmoothRate: 14, // stair/curb camera smoothing (1/s)

  // landing
  landOffsetGain: 0.021, // m/s of dip velocity per m/s of impact
  landOffsetMax: 0.34,
  landPitchGain: 0.0045, // rad/s of pitch velocity per m/s of impact
  landOmega: 11,
  landZeta: 0.5,

  // head bob amplitudes (camera; the viewmodel adds its own on top)
  bob: {
    walk: { y: 0.011, x: 0.007, roll: 0.22 * DEG, pitch: 0.18 * DEG },
    sprint: { y: 0.024, x: 0.016, roll: 0.55 * DEG, pitch: 0.35 * DEG },
    tac: { y: 0.03, x: 0.022, roll: 0.85 * DEG, pitch: 0.45 * DEG },
    crouch: { y: 0.008, x: 0.009, roll: 0.3 * DEG, pitch: 0.12 * DEG },
    prone: { y: 0.012, x: 0.03, roll: 1.3 * DEG, pitch: 0.3 * DEG },
  },
  bobAdsScale: 0.25,
  strafeRoll: 0.55 * DEG, // tilt when strafing at walk speed

  // FOV kicks (horizontal degrees added to the settings FOV)
  fovSprint: 3,
  fovTac: 7,
  fovSlide: 8,
  fovRate: 5.5,

  // slide camera
  slideRoll: 7.5 * DEG,

  // lean
  leanOffset: 0.34,
  leanRoll: 9 * DEG,

  // recoil
  recoilApplyRate: 38, // 1/s — kick reaches the view in ~40 ms (smooth, not a snap)
  recoilRecoverDelay: 0.11,
  recoilRecoverRate: 6.5,
  recoilRecoverable: 0.62, // fraction of vertical kick that recovers by itself
  recoilRecoverableYaw: 0.5,
  viewPunch: 0.55, // extra visual punch (springs back) as a fraction of the kick
  punchOmega: 34,
  punchZeta: 0.55,

  // shake (trauma model)
  shakePitch: 2.6 * DEG,
  shakeYaw: 2.2 * DEG,
  shakeRoll: 3.2 * DEG,
  shakePos: 0.035,
  shakeFreq: 17,
});

export const HEALTH = Object.freeze({
  max: 100,
  regenDelay: 4.0,
  regenRate: 42, // hp/s once regeneration starts
  fallSafeHeight: 4.2, // meters of free fall before damage
  fallLethalHeight: 12.5,
  deathTime: 1.1,
});

export const SETTINGS_DEFAULTS = Object.freeze({
  sprintMode: 'toggle', // 'toggle' (tap to sprint, stops when you stop) | 'hold'
  tacSprint: 'doubleTap', // 'doubleTap' | 'auto' (always tac-sprint when charged) | 'off'
  slideOnCrouch: true,
  headBob: 1.0, // camera bob scale (0..1.5)
  fovEffects: true, // sprint / slide FOV kick
  leanMode: 'hold', // 'hold' | 'toggle'
  damageFlinch: 1.0,
});

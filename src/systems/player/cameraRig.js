import * as THREE from 'three';
import { settingsFovToVfov } from '../../core/constants.js';
import { CAM, MOVE, STANCE, HEALTH, DEG } from './config.js';
import { Spring, Noise1D, damp, clamp, saturate, smoothstep, lerp, easeOutCubic } from './springs.js';

/**
 * player/cameraRig.js — everything between "the motor says where the feet are" and ctx.camera:
 * eye-height spring (stance), stair smoothing, landing spring (position + pitch), gait head-bob, strafe
 * tilt, slide / mantle camera, lean with wall probe, recoil application + recovery + visual punch,
 * trauma-based shake, damage flinch, death camera, FOV (settings + sprint/tac/slide kick + ADS zoom).
 * Runs in lateUpdate every render frame; allocation-free.
 */
export class CameraRig {
  constructor(ctx, state, motor) {
    this.ctx = ctx;
    this.state = state;
    this.motor = motor;

    this.eye = new Spring(CAM.eyeOmega, CAM.eyeZeta, STANCE.stand.eye);
    this.landY = new Spring(CAM.landOmega, CAM.landZeta, 0);
    this.landPitch = new Spring(CAM.landOmega * 0.9, CAM.landZeta, 0);
    this.punchPitch = new Spring(CAM.punchOmega, CAM.punchZeta, 0);
    this.punchYaw = new Spring(CAM.punchOmega, CAM.punchZeta, 0);
    this.punchRoll = new Spring(CAM.punchOmega * 0.7, CAM.punchZeta, 0);
    this.lean = new Spring(11, 0.9, 0);
    this.slideRoll = new Spring(14, 0.8, 0);
    this.mantlePitch = new Spring(12, 0.75, 0);
    this.mantleRoll = new Spring(10, 0.7, 0);
    this.strafeRoll = new Spring(8, 0.9, 0);

    this.stepOffset = 0;
    this.bobWeight = 0;
    this.bobAmp = { y: 0, x: 0, roll: 0, pitch: 0 };
    this.fovKick = 0;
    this.zoom = 1;
    this.leanInput = 0;
    this.leanToggle = 0;

    // recoil: pending (not yet applied), recoverable accumulators, time since last kick
    this.recoil = { pp: 0, py: 0, accP: 0, accY: 0, since: 10 };

    // shake (trauma)
    this.trauma = 0;
    this.traumaDecay = 1;
    const rng = ctx.rng.fork('player-camera');
    this.nPitch = new Noise1D(rng);
    this.nYaw = new Noise1D(rng);
    this.nRoll = new Noise1D(rng);
    this.nX = new Noise1D(rng);
    this.nY = new Noise1D(rng);
    this.nSlide = new Noise1D(rng);

    this.deathT = 0;
    this.deathSide = 1;
    this.lastStance = state.stance;
    this.prevStanceLock = 0;

    this.renderFeet = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._o = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.hfov = 90;
    this._mantlePlantU = 0;
  }

  reset() {
    const st = this.state;
    this.eye.reset(STANCE[st.stance].eye);
    this.landY.reset(0); this.landPitch.reset(0);
    this.punchPitch.reset(0); this.punchYaw.reset(0); this.punchRoll.reset(0);
    this.lean.reset(0); this.slideRoll.reset(0); this.mantlePitch.reset(0); this.mantleRoll.reset(0); this.strafeRoll.reset(0);
    this.stepOffset = 0;
    this.trauma = 0;
    this.deathT = 0;
    this.fovKick = 0;
    this.lastStance = st.stance;
    const r = this.recoil; r.pp = r.py = r.accP = r.accY = 0; r.since = 10;
  }

  // ------------------------------------------------------------------ external inputs
  applyRecoil(p, y) {
    const r = this.recoil;
    if (p < 0 && Math.abs(y) <= Math.abs(p) * 0.5) {
      // A pull-down is the caller's own recovery: apply it smoothly, let it consume our recoverable
      // accumulator (so both recoveries never stack) and never punch / restart the recovery timer.
      r.pp += p; r.py += y;
      r.accP = Math.max(0, r.accP + p);
      return;
    }
    r.pp += p; r.py += y;
    r.since = 0;
    // visual punch: a quick extra kick that springs back (the "thump" of the shot)
    this.punchPitch.impulse(p * CAM.viewPunch * CAM.punchOmega * 0.9);
    this.punchYaw.impulse(y * CAM.viewPunch * CAM.punchOmega * 0.6);
    this.punchRoll.impulse(-y * 1.8 * CAM.punchOmega * 0.35);
  }

  addShake(intensity, duration) {
    const i = clamp(intensity, 0, 1);
    const d = Math.max(0.05, duration || 0.3);
    if (i >= this.trauma) {
      this.trauma = i;
      this.traumaDecay = i / d;
    } else {
      // stack a little so repeated hits feel cumulative
      this.trauma = Math.min(1, this.trauma + i * 0.35);
    }
  }

  flinch(amount, dirX = 0, dirZ = 0) {
    const scale = this.ctx.settings.data.player?.damageFlinch ?? 1;
    const k = clamp(amount / 40, 0.15, 1.2) * scale;
    // damage direction relative to view: from the right → roll left, etc.
    const st = this.state;
    const sy = Math.sin(st.yaw), cy = Math.cos(st.yaw);
    const side = dirX * cy - dirZ * sy; // + = source on the right
    this.punchPitch.impulse(1.6 * DEG * k * CAM.punchOmega * 0.5);
    this.punchRoll.impulse(-Math.sign(side || 1) * 2.4 * DEG * k * CAM.punchOmega * 0.3);
    this.punchYaw.impulse(-side * 0.8 * DEG * k * CAM.punchOmega * 0.4);
    this.addShake(0.12 + 0.18 * k, 0.35);
  }

  /** Per-render-frame look + recoil integration (mutates state.yaw/pitch = the aim). */
  updateAim(dt, lookDx, lookDy) {
    const st = this.state;
    const s = this.ctx.settings.data.controls;
    const zoom = this.zoom;
    const adsK = st.ads > 0.5 ? (s.adsSensitivity ?? 1) / zoom : 1;
    const sens = 0.022 * s.sensitivity * DEG * adsK;
    const inv = s.invertY ? -1 : 1;
    const dPitch = -lookDy * sens * inv;
    st.yaw -= lookDx * sens;
    st.pitch += dPitch;

    // recoil: feed the pending kick in quickly (smooth, not a 1-frame snap)
    const r = this.recoil;
    r.since += dt;
    if (r.pp !== 0 || r.py !== 0) {
      const k = damp(CAM.recoilApplyRate, dt);
      const ap = r.pp * k, ay = r.py * k;
      st.pitch += ap; st.yaw += ay;
      r.pp -= ap; r.py -= ay;
      if (Math.abs(r.pp) < 1e-6) r.pp = 0;
      if (Math.abs(r.py) < 1e-6) r.py = 0;
      if (ap > 0) r.accP += ap * CAM.recoilRecoverable;
      if (ap >= 0) r.accY += ay * CAM.recoilRecoverableYaw;
    }
    // the player pulling down against the kick consumes the recoverable part
    if (dPitch < 0 && r.accP > 0) r.accP = Math.max(0, r.accP + dPitch);
    if (r.accY !== 0 && lookDx !== 0) {
      const dy = -lookDx * sens;
      if (Math.sign(dy) !== Math.sign(r.accY)) r.accY = Math.abs(dy) >= Math.abs(r.accY) ? 0 : r.accY + dy;
    }
    // recovery towards the pre-spray aim once the kicks stop
    if (r.since > CAM.recoilRecoverDelay && (r.accP !== 0 || r.accY !== 0)) {
      const k = damp(CAM.recoilRecoverRate, dt);
      const rp = r.accP * k, ry = r.accY * k;
      st.pitch -= rp; st.yaw -= ry;
      r.accP -= rp; r.accY -= ry;
      if (Math.abs(r.accP) < 1e-5) r.accP = 0;
      if (Math.abs(r.accY) < 1e-5) r.accY = 0;
    }

    let minP = -89 * DEG, maxP = 89 * DEG;
    if (st.stance === 'prone') { minP = -38 * DEG; maxP = 60 * DEG; }
    st.pitch = clamp(st.pitch, minP, maxP);
    // keep yaw bounded for float precision
    if (st.yaw > Math.PI * 64 || st.yaw < -Math.PI * 64) st.yaw %= Math.PI * 2;
  }

  /** Apply physical mouse look between simulation/render-loop ticks without waiting for update(). */
  applyImmediateLook(lookDx, lookDy) {
    const st = this.state;
    const oldYaw = st.yaw;
    const oldPitch = st.pitch;
    this.updateAim(0, lookDx, lookDy);
    const cam = this.ctx.camera;
    cam.rotation.x += st.pitch - oldPitch;
    cam.rotation.y += st.yaw - oldYaw;
    cam.updateMatrixWorld(true);
    st.forward.set(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
  }

  // ------------------------------------------------------------------ main
  apply(dt, t, alpha) {
    const ctx = this.ctx;
    const st = this.state;
    const m = this.motor;
    const cam = ctx.camera;
    const ps = ctx.settings.data.player || {};
    const fb = m.fb;

    // ---- consume motor feedback
    if (fb.landSpeed > 0) {
      const v = fb.landSpeed;
      const dip = Math.min(CAM.landOffsetMax * CAM.landOmega, v * CAM.landOffsetGain * CAM.landOmega);
      this.landY.impulse(-dip);
      this.landPitch.impulse(-Math.min(0.16, v * CAM.landPitchGain) * CAM.landOmega);
      if (v > 9) this.addShake(clamp((v - 9) / 14, 0.1, 0.55), 0.35);
      fb.landSpeed = 0;
    }
    if (fb.jump > 0) {
      this.landY.impulse(-0.35); // knees load before the push
      this.landPitch.impulse(0.9 * DEG * CAM.landOmega * 0.3);
      fb.jump = 0;
    }
    if (fb.stepDelta !== 0) {
      this.stepOffset += fb.stepDelta;
      this.stepOffset = clamp(this.stepOffset, -0.6, 0.6);
      fb.stepDelta = 0;
    }
    if (fb.slideStart > 0) {
      this.landY.impulse(-0.8);
      this.landPitch.impulse(-1.2 * DEG * CAM.landOmega * 0.5);
      this.addShake(0.16, 0.25);
      fb.slideStart = 0;
    }
    if (fb.mantleStart > 0) {
      this.mantlePitch.impulse(-0.12);
      fb.mantleStart = 0;
    }

    // ---- stance change accents (crouch dip, prone drop onto the hands, getting up)
    if (st.stance !== this.lastStance) {
      const down = STANCE[st.stance].eye < STANCE[this.lastStance || 'stand'].eye;
      if (m.mode !== 'slide') this.landPitch.impulse((down ? -0.5 : 0.35) * DEG * CAM.landOmega);
      this.lastStance = st.stance;
    }
    let stanceP = 0, stanceR = 0;
    if (m.stanceLock > 0) {
      const tp = 1 - m.stanceLock / m.stanceLockDur;
      const k = Math.sin(Math.PI * tp);
      stanceP = (st.stance === 'prone' ? -4.5 : 3) * DEG * k;
      stanceR = 2.2 * DEG * k;
    } else if (this.prevStanceLock > 0 && st.stance === 'prone') {
      this.landY.impulse(-0.45); // chest hits the ground
    }
    this.prevStanceLock = m.stanceLock;

    // ---- eye height (stance / slide / mantle / death)
    let eyeTarget = STANCE[st.stance].eye;
    let omega = CAM.eyeOmega;
    if (m.mode === 'slide') { eyeTarget = STANCE.slide.eye; omega = 19; }
    if (st.stance === 'prone' || m.stanceLock > 0) omega = CAM.eyeOmegaProne;
    let mantleK = 0;
    if (m.mode === 'mantle') {
      const u = saturate(m.mantle.t);
      mantleK = Math.sin(Math.PI * u);
      // the body folds over the lip: the eye sinks relative to the feet mid-mantle
      eyeTarget -= (m.mantle.vault ? 0.32 : 0.42) * mantleK;
      omega = 20;
    }
    if (!st.alive) {
      this.deathT = Math.min(1, this.deathT + dt / HEALTH.deathTime);
      eyeTarget = 0.32;
      omega = 6;
    }
    this.eye.omega = omega;
    this.eye.target = eyeTarget;
    this.eye.update(dt);
    this.landY.update(dt);
    this.landPitch.update(dt);
    this.stepOffset *= 1 - damp(CAM.stepSmoothRate, dt);

    // ---- gait bob
    const hs = st.speed;
    const bobScale = (ps.headBob ?? 1) * lerp(1, CAM.bobAdsScale, saturate(st.ads));
    const B = CAM.bob;
    let prof = B.walk;
    let prof2 = B.walk, mix = 0;
    if (st.stance === 'prone') { prof = prof2 = B.prone; }
    else if (st.stance === 'crouch') { prof = prof2 = B.crouch; }
    else if (hs > MOVE.sprint) { prof = B.sprint; prof2 = B.tac; mix = saturate((hs - MOVE.sprint) / (MOVE.tacSprint - MOVE.sprint)); }
    else if (hs > MOVE.walk) { prof = B.walk; prof2 = B.sprint; mix = saturate((hs - MOVE.walk) / (MOVE.sprint - MOVE.walk)); }
    else { prof = prof2 = B.walk; }
    const speedK = st.stance === 'prone' ? saturate(hs / MOVE.prone) : st.stance === 'crouch' ? saturate(hs / MOVE.crouch) : saturate(hs / MOVE.walk);
    const targetW = m.gaitWeight * speedK * bobScale;
    this.bobWeight += (targetW - this.bobWeight) * damp(10, dt);
    const bw = this.bobWeight;
    const amp = this.bobAmp;
    amp.y = lerp(prof.y, prof2.y, mix) * bw;
    amp.x = lerp(prof.x, prof2.x, mix) * bw;
    amp.roll = lerp(prof.roll, prof2.roll, mix) * bw;
    amp.pitch = lerp(prof.pitch, prof2.pitch, mix) * bw;
    const phase = lerp(m.prevGait, m.gait, alpha);
    // vertical: lowest at each foot plant (φ = kπ), with a slightly sharper plant (|sin| blend)
    const s1 = Math.sin(phase);
    const plant = Math.abs(s1);
    const bobY = amp.y * (0.55 * (-Math.cos(2 * phase)) + 0.45 * (plant * 2 - 1.27));
    const bobX = amp.x * s1;
    const bobRoll = amp.roll * Math.sin(phase - 0.35);
    const bobPitch = amp.pitch * Math.cos(2 * phase + 0.4);
    st.bobPhase = phase;
    st.bobWeight = bw;

    // ---- strafe tilt
    const sy = Math.sin(st.yaw), cy = Math.cos(st.yaw);
    const vRight = st.velocity.x * cy - st.velocity.z * sy;
    this.strafeRoll.target = st.grounded ? -clamp(vRight / MOVE.walk, -1.2, 1.2) * CAM.strafeRoll * (1 - 0.6 * saturate(st.ads)) : 0;
    this.strafeRoll.update(dt);

    // ---- slide camera
    const sliding = m.mode === 'slide';
    this.slideRoll.target = sliding ? m.slideRollSign * CAM.slideRoll * smoothstep(0, 0.12, m.slideTime) * (0.55 + 0.45 * saturate(m.slideSpeed / 7)) : 0;
    this.slideRoll.update(dt);
    let slideJitterP = 0, slideJitterR = 0;
    if (sliding) {
      const k = saturate(m.slideSpeed / 8) * 0.35 * DEG;
      slideJitterP = this.nSlide.sample(t * 22) * k;
      slideJitterR = this.nSlide.sample(t * 19 + 40) * k;
    }

    // ---- mantle camera
    if (m.mode === 'mantle') {
      const u = saturate(m.mantle.t);
      const hk = clamp(m.mantle.height / 1.6, 0.4, 1.2);
      // look down at the hands on the lip while pulling, then back up as the body rolls over
      const pk = m.mantle.vault ? Math.sin(Math.PI * Math.min(1, u * 1.15)) : Math.sin(Math.PI * saturate((u - 0.02) / 0.8));
      this.mantlePitch.target = -pk * (m.mantle.vault ? 8 : 12) * DEG * hk;
      this.mantleRoll.target = Math.sin(Math.PI * u) * 3.2 * DEG * hk * (m.mantle.vault ? -1 : 1);
      // hand plant on the lip: a small weighted jolt
      if (!m.mantle.vault && this._mantlePlantU < 0.3 && u >= 0.3) {
        this.landY.impulse(-0.22 * hk);
        this.landPitch.impulse(-0.6 * DEG * CAM.landOmega * hk);
      }
      this._mantlePlantU = u;
    } else {
      this.mantlePitch.target = 0;
      this.mantleRoll.target = 0;
      this._mantlePlantU = 0;
    }
    this.mantlePitch.update(dt);
    this.mantleRoll.update(dt);

    // ---- lean (hold or toggle), blocked by walls
    let leanTarget = 0;
    const input = ctx.input;
    const canLean = st.alive && !sliding && m.mode !== 'mantle' && !m.sprinting && st.stance !== 'prone' && m.enabled;
    if (canLean) {
      if ((ps.leanMode || 'hold') === 'toggle') {
        if (input.pressed('leanLeft')) this.leanToggle = this.leanToggle === -1 ? 0 : -1;
        if (input.pressed('leanRight')) this.leanToggle = this.leanToggle === 1 ? 0 : 1;
        leanTarget = this.leanToggle;
      } else {
        leanTarget = (input.isDown('leanRight') ? 1 : 0) - (input.isDown('leanLeft') ? 1 : 0);
      }
    } else this.leanToggle = 0;
    if (typeof st.leanOverride === 'number') leanTarget = st.leanOverride;
    if (leanTarget !== 0) {
      // wall probe from the head sideways
      this._right.set(cy, 0, -sy);
      const dirSign = Math.sign(leanTarget);
      this._dir.copy(this._right).multiplyScalar(dirSign);
      this._o.set(st.position.x, st.position.y + this.eye.x, st.position.z);
      const hit = ctx.services.world.raycast(this._o, this._dir, CAM.leanOffset + 0.3);
      if (hit) leanTarget *= clamp((hit.distance - 0.28) / CAM.leanOffset, 0, 1);
    }
    this.lean.target = leanTarget;
    this.lean.update(dt);
    st.lean = this.lean.x;

    // ---- recoil punch + shake
    this.punchPitch.update(dt);
    this.punchYaw.update(dt);
    this.punchRoll.update(dt);
    if (this.trauma > 0) this.trauma = Math.max(0, this.trauma - this.traumaDecay * dt);
    const sh = this.trauma * this.trauma;
    let shP = 0, shY = 0, shR = 0, shX = 0, shYp = 0;
    if (sh > 0) {
      const f = t * CAM.shakeFreq;
      shP = CAM.shakePitch * sh * this.nPitch.sample(f);
      shY = CAM.shakeYaw * sh * this.nYaw.sample(f + 17.3);
      shR = CAM.shakeRoll * sh * this.nRoll.sample(f * 0.8 + 41.7);
      shX = CAM.shakePos * sh * this.nX.sample(f + 73.1);
      shYp = CAM.shakePos * sh * this.nY.sample(f + 91.9);
    }

    // ---- death
    let deathRoll = 0, deathPitch = 0;
    if (!st.alive) {
      const d = easeOutCubic(this.deathT);
      deathRoll = this.deathSide * 38 * DEG * d;
      deathPitch = 12 * DEG * d;
    }

    // ---- compose position
    const feet = this.renderFeet.lerpVectors(m.prevPos, m.pos, alpha);
    this._right.set(cy, 0, -sy);
    const leanX = this.lean.x * CAM.leanOffset;
    cam.position.set(feet.x, feet.y + this.eye.x + this.stepOffset + this.landY.x + bobY + shYp - Math.abs(this.lean.x) * 0.05, feet.z);
    cam.position.addScaledVector(this._right, leanX + bobX + shX);

    // ---- compose rotation
    const pitch = st.pitch + stanceP + this.landPitch.x + this.punchPitch.x + this.mantlePitch.x + bobPitch + shP + slideJitterP + deathPitch;
    const yaw = st.yaw + this.punchYaw.x + shY;
    const roll = stanceR - this.lean.x * CAM.leanRoll + this.slideRoll.x + this.strafeRoll.x + this.mantleRoll.x + bobRoll + this.punchRoll.x + shR + slideJitterR + deathRoll;
    st.roll = roll;
    cam.rotation.set(clamp(pitch, -89.5 * DEG, 89.5 * DEG), yaw, roll, 'YXZ');

    // ---- FOV
    let kick = 0;
    if (ps.fovEffects !== false) {
      if (sliding) kick = CAM.fovSlide * saturate(m.slideSpeed / 7);
      else if (m.sprinting && m.mode !== 'mantle') kick = m.tac ? CAM.fovTac : CAM.fovSprint;
      kick *= saturate(hs / MOVE.walk) * (1 - saturate(st.ads));
    }
    this.fovKick += (kick - this.fovKick) * damp(CAM.fovRate, dt);
    const hfov = ctx.settings.data.graphics.fov + this.fovKick;
    this.hfov = hfov;
    const vfovBase = settingsFovToVfov(hfov) * DEG;
    const vfov = (2 * Math.atan(Math.tan(vfovBase / 2) / this.zoom)) / DEG;
    if (Math.abs(cam.fov - vfov) > 1e-4) {
      cam.fov = vfov;
      cam.updateProjectionMatrix();
    }
    cam.updateWorldMatrix(true, false); // self (+parents) only: the viewmodel children update at render

    st.eye.copy(cam.position);
    cam.getWorldDirection(st.forward);
    st.fov = hfov;
    st.eyeHeight = this.eye.x;
  }
}

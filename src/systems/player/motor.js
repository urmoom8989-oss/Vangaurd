import * as THREE from 'three';
import { Capsule } from 'three/examples/jsm/math/Capsule.js';
import { MOVE, STANCE, HEALTH } from './config.js';
import { clamp, saturate, easeOutCubic, easeInOutCubic, smoothstep, lerp } from './springs.js';

/**
 * player/motor.js — kinematic character motor (fixed 60 Hz).
 *
 * Collision is a capsule resolved against services.world.collideCapsule (three.js Octree semantics:
 * the returned vector is the combined push-out). Robustness measures:
 *   - movement is split into substeps of ≤ MOVE.maxSubstep (< capsule radius) → no tunnelling,
 *   - walkable contacts are resolved *vertically* (no creeping down slopes while standing still),
 *   - walls clip only the horizontal velocity while grounded (no climbing walls),
 *   - stairs/curbs ≤ stepHeight are climbed with an up/over/down trial move,
 *   - a ground-snap sweep keeps the capsule glued to stairs and slopes when walking down,
 *   - teleport/spawn inside geometry is resolved with extra push-out iterations.
 * All discrete vertical corrections (steps, snaps) are reported to the camera for smoothing.
 */

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

export class Motor {
  constructor(ctx, state) {
    this.ctx = ctx;
    this.state = state;
    this.pos = state.position; // feet (shared identity with the service state)
    this.vel = state.velocity;
    this.prevPos = new THREE.Vector3();
    this.capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), MOVE.radius);
    this._testCap = new Capsule(new THREE.Vector3(), new THREE.Vector3(), MOVE.radius);

    this.mode = 'ground'; // 'ground' | 'air' | 'slide' | 'mantle'
    this.grounded = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.height = STANCE.stand.height;
    this.airTime = 0;
    this.sinceGrounded = 0;
    this.jumpLock = 0; // no ground snap right after a jump
    this.jumped = false;
    this.maxFallSpeed = 0; // for landing impact / fall damage
    this.fallStartY = 0;

    // intent written by the system's update() (edges are only valid there)
    this.intent = { jump: 0, crouch: false, crouchRelease: false, prone: false, sprint: false, fire: false, ads: false };
    this.moveInput = { x: 0, y: 0 };
    this.enabled = true;

    // sprint / tac
    this.sprintLatched = false;
    this.sprinting = false;
    this.tac = false;
    this.tacCharge = MOVE.tacDuration;
    this.tacIdle = 10;
    this.lastSprintPress = -10;
    this.sprintBlend = 0; // 0..1 smoothed for animation
    this.stuckTime = 0;

    // stance
    this.stanceLock = 0; // prone transitions
    this.stanceLockDur = 1;

    // slide
    this.slideTime = 0;
    this.slideSpeed = 0;
    this.slideDir = new THREE.Vector3();
    this.slideRollSign = 1;

    // mantle
    this.mantle = {
      t: 0, dur: 1, height: 0, vault: false, stance: 'stand', exitSpeed: 0, s0: 1, s1: 1,
      p0: new THREE.Vector3(), p2: new THREE.Vector3(), topY: 0, fwd: new THREE.Vector3(), wallDist: 0,
    };
    this.mantleCheckCooldown = 0;
    this.wallContact = 0; // frames since a wall contact

    // gait (footsteps + bob)
    this.gait = 0; // phase in half-steps*π
    this.prevGait = 0;
    this.foot = 0;
    this.gaitWeight = 0;

    // camera feedback accumulators (consumed by the camera rig each render frame)
    this.fb = { landSpeed: 0, stepDelta: 0, jump: 0, slideStart: 0, mantleStart: 0 };

    // scratch
    this._info = makeInfo();
    this._info2 = makeInfo();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._wish = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._start = new THREE.Vector3();
    this._resA = new THREE.Vector3();
    this._o = new THREE.Vector3();

    // pooled event payloads (consumers copy)
    this._evFoot = { surface: 'default', position: new THREE.Vector3(), speed: 0, stance: 'stand', foot: 'left', sprinting: false, tacSprinting: false, volume: 1 };
    this._evJump = { position: new THREE.Vector3(), speed: 0 };
    this._evLand = { speed: 0, position: new THREE.Vector3(), surface: 'default', height: 0 };
    this._evStance = { stance: 'stand', previous: 'stand' };
    this._evSlide = { phase: 'start', position: new THREE.Vector3(), speed: 0, surface: 'default' };
    this._evMantle = { phase: 'start', position: new THREE.Vector3(), height: 0, vault: false, duration: 0 };
    this._evTac = { active: false, charge: 1 };
  }

  get world() { return this.ctx.services.world; }

  // ------------------------------------------------------------------ capsule helpers
  syncCapsule() {
    const r = MOVE.radius;
    const h = Math.max(this.height, 2 * r + 0.02);
    this.capsule.start.set(this.pos.x, this.pos.y + r, this.pos.z);
    this.capsule.end.set(this.pos.x, this.pos.y + h - r, this.pos.z);
  }
  _readCapsule() {
    this.pos.set(this.capsule.start.x, this.capsule.start.y - MOVE.radius, this.capsule.start.z);
  }
  _translate(x, y, z) {
    const c = this.capsule;
    c.start.x += x; c.start.y += y; c.start.z += z;
    c.end.x += x; c.end.y += y; c.end.z += z;
  }
  _setCapsuleAt(p, height, cap = this.capsule) {
    const r = MOVE.radius;
    const h = Math.max(height, 2 * r + 0.02);
    cap.start.set(p.x, p.y + r, p.z);
    cap.end.set(p.x, p.y + h - r, p.z);
    return cap;
  }

  /** Resolve penetrations of the current capsule. `vertGround`: push walkable contacts straight up. */
  _resolve(info, vertGround, clipVel, iterations = 4) {
    const world = this.world;
    const vel = this.vel;
    for (let i = 0; i < iterations; i++) {
      const r = world.collideCapsule(this.capsule);
      if (!r || !(r.depth > 1e-6)) break;
      const n = r.normal;
      const d = Math.min(r.depth, 1.5);
      if (n.y >= MOVE.walkableCos) {
        info.ground = true;
        info.groundNormal.copy(n);
        if (vertGround) this._translate(0, d / n.y, 0);
        else this._translate(n.x * d, n.y * d, n.z * d);
        if (clipVel && vel.y < 0) vel.y = 0;
      } else if (n.y <= -0.35) {
        info.ceiling = true;
        this._translate(n.x * d, n.y * d, n.z * d);
        if (clipVel && vel.y > 0) vel.y = 0;
      } else {
        info.wall = true;
        info.wallNormal.copy(n);
        // push out horizontally when grounded so walls never lift or sink the capsule
        const hl = Math.hypot(n.x, n.z);
        if (vertGround && hl > 0.35) {
          // horizontal push that removes the same penetration along the flattened normal
          const m = d / hl / hl;
          this._translate(n.x * m, 0, n.z * m);
        } else {
          this._translate(n.x * d, n.y * d, n.z * d);
        }
        if (clipVel) {
          if (this.mode === 'air' && Math.abs(n.y) > 0.05) {
            const vn = vel.x * n.x + vel.y * n.y + vel.z * n.z;
            if (vn < 0) { vel.x -= n.x * vn; vel.y -= n.y * vn; vel.z -= n.z * vn; }
          } else if (hl > 1e-4) {
            const nx = n.x / hl, nz = n.z / hl;
            const vn = vel.x * nx + vel.z * nz;
            if (vn < 0) { vel.x -= nx * vn; vel.z -= nz * vn; }
          }
        }
      }
    }
  }

  /** Move the capsule by (dx,dy,dz) in substeps, resolving collisions after each. */
  _move(dx, dy, dz, info, vertGround, clipVel) {
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const n = Math.max(1, Math.ceil(len / MOVE.maxSubstep));
    const sx = dx / n, sy = dy / n, sz = dz / n;
    for (let i = 0; i < n; i++) {
      this._translate(sx, sy, sz);
      this._resolve(info, vertGround, clipVel);
    }
  }

  /** True if a capsule of `height` at feet `p` is free of (non-floor) penetration. */
  fits(p, height, tolerance = 0.015) {
    const cap = this._setCapsuleAt(this._o.copy(p).setY(p.y + 0.02), height, this._testCap);
    const r = this.world.collideCapsule(cap);
    return !r || !(r.depth > tolerance);
  }

  // ------------------------------------------------------------------ stance
  setStance(s, force = false) {
    const st = this.state;
    if (s === st.stance) return true;
    const h = STANCE[s].height;
    if (!force && h > this.height + 1e-3 && !this.fits(this.pos, h)) return false;
    const prev = st.stance;
    st.stance = s;
    if (this.mode !== 'slide') this.height = h;
    if (s === 'prone' || prev === 'prone') {
      this.stanceLockDur = s === 'prone' ? (prev === 'stand' ? MOVE.standToProneTime : MOVE.standToProneTime * 0.7) : MOVE.proneToStandTime;
      this.stanceLock = this.stanceLockDur;
    }
    if (s !== 'stand') this._stopSprint();
    this.syncCapsule();
    this._evStance.stance = s;
    this._evStance.previous = prev;
    this.ctx.events.emit('player:stance', this._evStance);
    return true;
  }

  // ------------------------------------------------------------------ sprint
  _stopSprint() {
    this.sprintLatched = false;
    if (this.tac) this._setTac(false);
  }
  _setTac(on) {
    if (this.tac === on) return;
    this.tac = on;
    if (!on) this.tacIdle = 0;
    this._evTac.active = on;
    this._evTac.charge = this.tacCharge / MOVE.tacDuration;
    this.ctx.events.emit('player:tacsprint', this._evTac);
  }

  // ------------------------------------------------------------------ teleport / reset
  teleport(p) {
    this.pos.copy(p);
    this.jumped = false;
    this.vel.set(0, 0, 0);
    this.mode = 'ground';
    this.slideTime = 0;
    this.stanceLock = 0;
    this.sprintLatched = false;
    this.tac = false;
    this.height = STANCE[this.state.stance === 'slide' ? 'crouch' : this.state.stance].height;
    this.syncCapsule();
    // de-penetrate (spawned inside a prop) and settle onto the ground
    const info = this._info; resetInfo(info);
    this._resolve(info, true, false, 10);
    this._readCapsule();
    this._groundProbe(0.6);
    this.prevPos.copy(this.pos);
    this.maxFallSpeed = 0;
    this.fallStartY = this.pos.y;
  }

  /** Snap down to ground within `dist`. Returns true (and sets grounded) if ground was found. */
  _groundProbe(dist) {
    const info = this._info2; resetInfo(info);
    const y0 = this.capsule.start.y, x0 = this.capsule.start.x, z0 = this.capsule.start.z;
    // a tiny first probe catches resting contacts (edges) before a big step slides past them
    let moved = 0;
    let s = Math.min(0.025, dist);
    while (moved < dist - 1e-6) {
      s = Math.min(s, dist - moved);
      this._translate(0, -s, 0);
      moved += s;
      this._resolve(info, true, false);
      if (info.ground) break;
      s = MOVE.maxSubstep * 0.8;
    }
    if (info.ground) {
      this._readCapsule();
      this.grounded = true;
      this.groundNormal.copy(info.groundNormal);
      return true;
    }
    // restore
    this._translate(x0 - this.capsule.start.x, y0 - this.capsule.start.y, z0 - this.capsule.start.z);
    return false;
  }

  // ------------------------------------------------------------------ main step
  step(dt, t) {
    const st = this.state;
    const it = this.intent;
    this.prevPos.copy(this.pos);
    this.prevGait = this.gait;
    const alive = st.alive;
    const canAct = this.enabled && alive;

    // ---- input
    const mv = this.moveInput;
    let mx = 0, my = 0;
    if (canAct) { mx = mv.x; my = mv.y; }
    const inMag = Math.min(1, Math.hypot(mx, my));

    const sy = Math.sin(st.yaw), cy = Math.cos(st.yaw);
    this._fwd.set(-sy, 0, -cy);
    this._right.set(cy, 0, -sy);

    if (this.stanceLock > 0) this.stanceLock = Math.max(0, this.stanceLock - dt);
    if (this.mantleCheckCooldown > 0) this.mantleCheckCooldown--;
    if (this.jumpLock > 0) this.jumpLock -= dt;
    this.wallContact++;

    // ---- mantle is fully kinematic
    if (this.mode === 'mantle') {
      this._stepMantle(dt);
      this._consumeIntent(dt);
      this._post(dt, t);
      return;
    }

    const ads = st.ads;
    const settings = this.ctx.settings.data.player || {};

    // ---- intents: stance
    if (canAct) this._handleStanceIntents(settings, inMag, my);

    // ---- sprint / tac-sprint
    this._updateSprint(dt, t, canAct, my, inMag, ads, settings);

    // ---- jump / mantle
    const wantJump = canAct && it.jump > 0;
    const canGroundJump = this.grounded || (this.mode === 'air' && this.sinceGrounded < MOVE.coyoteTime && this.vel.y <= 0.5);
    if (wantJump && this.mode !== 'mantle') {
      if (this.mode === 'slide') {
        // slide-cancel jump: stand up (if possible) and hop with the slide momentum
        this._endSlide(true);
        if (st.stance === 'stand' && canGroundJump) this._jump();
        it.jump = 0;
      } else if (st.stance === 'prone') {
        if (!this.setStance('stand')) this.setStance('crouch');
        it.jump = 0;
      } else if (st.stance === 'crouch' && this.grounded) {
        if (!this._tryMantle(true)) this.setStance('stand');
        it.jump = 0;
      } else if (this._tryMantle(true)) {
        it.jump = 0;
      } else if (canGroundJump && st.stance === 'stand') {
        this._jump();
        it.jump = 0;
      }
    }
    if (this.mode === 'mantle') { this._consumeIntent(dt); this._post(dt, t); return; }

    // airborne auto-mantle: pushing forward into a ledge mid-jump
    if (canAct && this.mode === 'air' && my > 0.5 && this.mantleCheckCooldown <= 0 && this.vel.y < 5.5) {
      this.mantleCheckCooldown = this.wallContact <= 2 ? 1 : 3;
      if (this._tryMantle(false)) { this._consumeIntent(dt); this._post(dt, t); return; }
    }

    // ---- target speed
    let target = this._targetSpeed(my, mx, inMag, ads);
    if (this.stanceLock > 0) target *= 0.15;
    const wish = this._wish.set(0, 0, 0).addScaledVector(this._fwd, my).addScaledVector(this._right, mx);
    if (inMag > 1e-4) wish.multiplyScalar(1 / Math.max(1e-4, Math.hypot(mx, my)));

    const vel = this.vel;
    if (this.mode === 'slide') {
      this._stepSlideVelocity(dt, wish, inMag);
    } else if (this.grounded) {
      this._groundAccel(dt, wish, target * inMag);
    } else {
      this._airAccel(dt, wish, inMag);
    }

    // vertical
    if (this.grounded && this.jumpLock <= 0) {
      // follow the ground plane: horizontal speed is preserved on slopes. The plane comes from a ray
      // (a face normal) — capsule contact normals on stair edges are slanted and would launch us.
      const n = this._slopeNormal();
      vel.y = n.y > 0.2 ? -(n.x * vel.x + n.z * vel.z) / n.y : 0;
    } else {
      vel.y = Math.max(-MOVE.maxFall, vel.y - MOVE.gravity * dt);
    }

    // ---- collide & move
    const wasGrounded = this.grounded;
    const preVy = vel.y;
    const info = this._info; resetInfo(info);
    this.syncCapsule();
    this._start.copy(this.pos);
    const hx = vel.x * dt, hz = vel.z * dt;
    const pvx = vel.x, pvz = vel.z;
    this._move(hx, vel.y * dt, hz, info, wasGrounded || vel.y <= 0, true);
    this._readCapsule();
    if (info.wall) this.wallContact = 0;
    // no world (failed to load / excluded via `only`): stand on the y = 0 plane instead of falling forever
    if (this.ctx.services.isProvided && !this.ctx.services.isProvided('world') && this.pos.y <= 0) {
      this.pos.y = 0;
      info.ground = true;
      info.groundNormal.set(0, 1, 0);
      if (vel.y < 0) vel.y = 0;
      this.syncCapsule();
    }

    // stairs / curbs
    const stepped = wasGrounded && info.wall && this.jumpLock <= 0 && this._tryStepUp(hx, hz, pvx, pvz);

    // ground detection / snapping
    this.grounded = false;
    if (stepped) {
      this.grounded = true;
    } else if (wasGrounded && this.jumpLock <= 0) {
      const beforeY = this.pos.y;
      if (info.ground || this._groundProbe(MOVE.snapDown + Math.hypot(hx, hz) * 0.9)) {
        if (info.ground && !this.grounded) { this.grounded = true; this.groundNormal.copy(info.groundNormal); }
        const drop = beforeY - this.pos.y;
        if (drop > 0.035) this.fb.stepDelta += drop; // stairs down: camera eases
      }
    } else if (info.ground && preVy <= 0.01) {
      this.grounded = true;
      this.groundNormal.copy(info.groundNormal);
    } else if (vel.y <= 0 && this.mode === 'air') {
      // tiny probe so resting on the ground registers even without penetration
      if (this._groundProbe(0.02)) this.grounded = true;
    }
    if (this.grounded && this.groundNormal.y < MOVE.walkableCos) this.grounded = false;

    // ---- mode transitions
    if (this.grounded) {
      if (this.mode === 'air') this._land(preVy);
      if (this.mode !== 'slide') this.mode = 'ground';
      this.sinceGrounded = 0;
      this.airTime = 0;
      if (vel.y < 0 && !wasGrounded) vel.y = 0;
    } else {
      if (this.mode === 'slide') this._endSlide(false);
      if (this.mode !== 'air') {
        this.mode = 'air';
        this.maxFallSpeed = 0;
        this.fallStartY = this.pos.y;
      }
      this.sinceGrounded += dt;
      this.airTime += dt;
      if (vel.y < 0) this.maxFallSpeed = Math.max(this.maxFallSpeed, -vel.y);
    }

    // slide ends
    if (this.mode === 'slide') {
      this.slideSpeed = Math.hypot(vel.x, vel.z);
      this.slideTime += dt;
      if (this.slideSpeed < MOVE.slideEndSpeed || this.slideTime > MOVE.slideMaxTime) this._endSlide(false);
    }

    // stuck against a wall while sprinting → drop the sprint
    if (this.sprintLatched && this.grounded && Math.hypot(vel.x, vel.z) < 1.2) {
      this.stuckTime += dt;
      if (this.stuckTime > 0.3) this._stopSprint();
    } else this.stuckTime = 0;

    this._consumeIntent(dt);
    this._post(dt, t);
  }

  _consumeIntent(dt) {
    const it = this.intent;
    if (it.jump > 0) it.jump = Math.max(0, it.jump - dt);
    it.crouch = false; it.crouchRelease = false; it.prone = false; it.sprint = false; it.fire = false; it.ads = false;
  }

  _handleStanceIntents(settings, inMag, my) {
    const st = this.state;
    const it = this.intent;
    const toggleCrouch = this.ctx.settings.data.controls.toggleCrouch !== false;
    if (it.crouch) {
      if (this.mode === 'slide') {
        if (this.slideTime > MOVE.slideMinTime) this._endSlide(true);
      } else if (this.mode === 'ground' && this.sprinting && settings.slideOnCrouch !== false &&
                 Math.hypot(this.vel.x, this.vel.z) >= MOVE.slideMinSpeed && this.stanceLock <= 0) {
        this._startSlide();
      } else if (st.stance === 'crouch') {
        if (toggleCrouch) this.setStance('stand');
      } else {
        this.setStance('crouch');
      }
    } else if (it.crouchRelease && !toggleCrouch && st.stance === 'crouch' && this.mode !== 'slide') {
      this.setStance('stand');
    }
    if (it.prone && this.mode !== 'slide') {
      if (st.stance === 'prone') { if (!this.setStance('stand')) this.setStance('crouch'); }
      else if (this.grounded) this.setStance('prone');
    }
  }

  _updateSprint(dt, t, canAct, my, inMag, ads, settings) {
    const st = this.state;
    const it = this.intent;
    const mode = settings.sprintMode || 'toggle';
    const tacMode = settings.tacSprint || 'doubleTap';
    const forwardOk = my >= MOVE.sprintMinForward && inMag > 0.5;

    if (canAct && it.sprint) {
      const dbl = t - this.lastSprintPress < MOVE.doubleTapWindow;
      this.lastSprintPress = t;
      if (this.mode === 'slide') {
        if (this.slideTime > MOVE.slideMinTime * 0.6) { this._endSlide(true); this.sprintLatched = st.stance === 'stand'; }
      } else if (st.stance !== 'stand') {
        if (this.stanceLock <= 0 && this.setStance('stand')) this.sprintLatched = true;
      } else if (this.sprinting && tacMode !== 'off' && this.tacCharge >= MOVE.tacMinCharge) {
        this._setTac(true);
      } else {
        this.sprintLatched = true;
        if (dbl && tacMode !== 'off' && this.tacCharge >= MOVE.tacMinCharge) this._setTac(true);
      }
    }
    if (mode === 'hold' && !this.ctx.input.isDown('sprint')) this.sprintLatched = false;
    if (!canAct || !forwardOk || it.fire || it.ads || ads > 0.35 || (st.stance !== 'stand' && this.mode !== 'slide')) {
      if (this.mode !== 'slide') this._stopSprint();
    }
    if (tacMode === 'auto' && this.sprintLatched && !this.tac && this.tacCharge >= MOVE.tacDuration * 0.5) this._setTac(true);

    this.sprinting = this.sprintLatched && forwardOk && this.mode !== 'slide';

    // tac charge
    if (this.tac && this.sprinting && this.mode !== 'air') {
      this.tacCharge -= dt;
      if (this.tacCharge <= 0) { this.tacCharge = 0; this._setTac(false); }
    } else if (this.tac && !this.sprinting && this.mode !== 'slide') {
      this._setTac(false);
    }
    if (!this.tac) {
      this.tacIdle += dt;
      if (this.tacIdle > MOVE.tacRechargeDelay) this.tacCharge = Math.min(MOVE.tacDuration, this.tacCharge + MOVE.tacRecharge * dt);
    }
    const sb = this._sprintVisible() ? (this.tac ? 1 : 0.75) : 0;
    this.sprintBlend += (sb - this.sprintBlend) * (1 - Math.exp(-7 * dt));
  }

  _sprintVisible() {
    if (!this.sprinting) return false;
    if (this.mode === 'mantle') return false;
    if (this.mode === 'air' && (this.jumped || this.airTime > 0.14)) return false;
    return true;
  }

  _targetSpeed(my, mx, inMag, ads) {
    const st = this.state;
    let speed;
    if (st.stance === 'prone') speed = MOVE.prone;
    else if (st.stance === 'crouch') speed = MOVE.crouch;
    else if (this.sprinting) speed = this.tac ? MOVE.tacSprint : MOVE.sprint;
    else speed = MOVE.walk;
    if (!this.sprinting && inMag > 1e-3) {
      // direction scaling: backpedal / strafe slower
      const f = my / Math.max(1e-4, Math.hypot(mx, my));
      const dirScale = f >= 0 ? lerp(MOVE.strafeScale, 1, f) : lerp(MOVE.strafeScale, MOVE.backScale, -f);
      speed *= dirScale;
    }
    const w = this.ctx.services.weapons?.state;
    const adsScale = (w && typeof w.adsMoveScale === 'number') ? w.adsMoveScale : MOVE.adsScale;
    speed *= lerp(1, adsScale, saturate(ads));
    if (w && typeof w.moveScale === 'number') speed *= w.moveScale; // heavy-weapon mobility (optional)
    return speed;
  }

  _groundAccel(dt, wish, targetSpeed) {
    const vel = this.vel;
    const tx = wish.x * targetSpeed, tz = wish.z * targetSpeed;
    const dvx = tx - vel.x, dvz = tz - vel.z;
    const dl = Math.hypot(dvx, dvz);
    if (dl < 1e-5) return;
    const cur = Math.hypot(vel.x, vel.z);
    let rate;
    if (targetSpeed < 0.05) rate = MOVE.decel;
    else if (targetSpeed > cur + 0.05) rate = cur > MOVE.walk * 0.97 ? MOVE.accelSprint : MOVE.accel;
    else if (targetSpeed < cur - 0.05) rate = MOVE.decel;
    else rate = MOVE.turn;
    let k = 1 - Math.exp(-rate * dt);
    // minimum linear rate so the approach actually finishes
    const minStep = MOVE.minAccel * dt;
    if (dl * k < minStep) k = Math.min(1, minStep / dl);
    vel.x += dvx * k;
    vel.z += dvz * k;
  }

  _airAccel(dt, wish, inMag) {
    const vel = this.vel;
    const before = Math.hypot(vel.x, vel.z);
    const drag = 1 - MOVE.airDrag * dt;
    vel.x *= drag; vel.z *= drag;
    if (inMag > 1e-3) {
      vel.x += wish.x * MOVE.airAccel * inMag * dt;
      vel.z += wish.z * MOVE.airAccel * inMag * dt;
      const cap = Math.max(before, MOVE.walk * 0.9);
      const after = Math.hypot(vel.x, vel.z);
      if (after > cap) { const s = cap / after; vel.x *= s; vel.z *= s; }
    }
  }

  _jump() {
    const st = this.state;
    const v = Math.sqrt(2 * MOVE.gravity * MOVE.jumpHeight);
    this.vel.y = v;
    // small horizontal commitment: sprint jumps keep momentum, standing jumps get none
    this.grounded = false;
    this.mode = 'air';
    this.jumpLock = 0.12;
    this.sinceGrounded = 1;
    this.maxFallSpeed = 0;
    this.fallStartY = this.pos.y;
    this.fb.jump += 1;
    this.jumped = true;
    const e = this._evJump;
    e.position.copy(this.pos);
    e.speed = Math.hypot(this.vel.x, this.vel.z);
    this.ctx.events.emit('player:jump', e);
    void st;
  }

  _land(preVy) {
    this.jumped = false;
    const impact = Math.max(this.maxFallSpeed, -preVy);
    this.maxFallSpeed = 0;
    const st = this.state;
    if (impact > 1.5) {
      this.fb.landSpeed = Math.max(this.fb.landSpeed, impact);
      const e = this._evLand;
      e.speed = impact;
      e.position.copy(this.pos);
      e.surface = this._surfaceBelow();
      e.height = Math.max(0, this.fallStartY - this.pos.y);
      this.ctx.events.emit('player:land', e);
      // heavy landings bleed horizontal speed
      if (impact > 7.5) {
        const k = clamp(1 - (impact - 7.5) * 0.05, 0.55, 1);
        this.vel.x *= k; this.vel.z *= k;
      }
      // fall damage (from the equivalent free-fall height)
      const h = (impact * impact) / (2 * MOVE.gravity);
      if (h > HEALTH.fallSafeHeight && st.alive) {
        const dmg = ((h - HEALTH.fallSafeHeight) / (HEALTH.fallLethalHeight - HEALTH.fallSafeHeight)) * HEALTH.max;
        this.onFallDamage?.(Math.min(HEALTH.max * 2, dmg), h);
      }
    }
    // reset gait so the first footstep after landing lands on the next half-step
    this.gait = Math.floor(this.gait / Math.PI) * Math.PI + Math.PI * 0.35;
    this.prevGait = this.gait;
  }

  // ------------------------------------------------------------------ stairs
  _tryStepUp(hx, hz, pvx, pvz) {
    const dl = Math.hypot(hx, hz);
    if (dl < 1e-4) return false;
    const dirx = hx / dl, dirz = hz / dl;
    const progA = (this.pos.x - this._start.x) * dirx + (this.pos.z - this._start.z) * dirz;
    if (progA >= dl * 0.92) return false;
    this._resA.copy(this.pos);
    const velAy = this.vel.y, velAx = this.vel.x, velAz = this.vel.z;

    const info = this._info2; resetInfo(info);
    this._setCapsuleAt(this._start, this.height);
    // up
    this._move(0, MOVE.stepHeight, 0, info, false, false);
    const raised = this.capsule.start.y - (this._start.y + MOVE.radius);
    let ok = raised > 0.06;
    if (ok) {
      // over (full intended horizontal travel, at least a few cm so thin step edges are cleared)
      const minAdvance = Math.max(dl, 0.06);
      resetInfo(info);
      this._move(dirx * minAdvance, 0, dirz * minAdvance, info, true, false);
      // down: small steps; any upward-facing contact (face or step edge) supports the capsule.
      // Edge perches (normal.y below walkable) are fine here: the next frames roll over the lip.
      resetInfo(info);
      const total = raised + 0.06;
      let moved = 0;
      ok = false;
      const world = this.world;
      while (moved < total - 1e-6) {
        const s = Math.min(0.05, total - moved);
        this._translate(0, -s, 0);
        moved += s;
        const r = world.collideCapsule(this.capsule);
        if (!r || !(r.depth > 1e-6)) continue;
        const n = r.normal;
        if (n.y > 0.3) {
          this._translate(0, r.depth / n.y, 0);
          ok = true;
          info.groundNormal.copy(n);
          if (n.y < MOVE.walkableCos) info.groundNormal.set(0, 1, 0);
          break;
        }
        this._translate(n.x * r.depth, n.y * r.depth, n.z * r.depth);
      }
    }
    if (ok) {
      const nx = this.capsule.start.x, nz = this.capsule.start.z;
      const ny = this.capsule.start.y - MOVE.radius;
      const progB = (nx - this._start.x) * dirx + (nz - this._start.z) * dirz;
      const rise = ny - this._start.y;
      if (progB > progA + 0.01 && rise > 0.015 && rise <= MOVE.stepHeight + 0.02) {
        this._readCapsule();
        this.vel.x = pvx; this.vel.z = pvz; // we did not really hit the wall
        this.vel.y = 0;
        this.groundNormal.copy(info.groundNormal);
        this.grounded = true;
        this.fb.stepDelta -= rise - (this._resA.y - this._start.y);
        return true;
      }
    }
    // revert to the plain move result
    this.pos.copy(this._resA);
    this.vel.set(velAx, velAy, velAz);
    this.syncCapsule();
    return false;
  }

  // ------------------------------------------------------------------ slide
  _startSlide() {
    const vel = this.vel;
    const sp = Math.hypot(vel.x, vel.z);
    this.slideDir.set(vel.x / sp, 0, vel.z / sp);
    const entry = Math.min(MOVE.slideMaxEntry, sp + MOVE.slideBoost);
    this.slideSpeed = entry;
    vel.x = this.slideDir.x * entry;
    vel.z = this.slideDir.z * entry;
    this.slideTime = 0;
    this.mode = 'slide';
    this.height = STANCE.slide.height;
    // camera banks into the slide: a diagonal / strafing slide rolls towards its side, a straight one
    // always drops the right shoulder (consistent, reads as a committed hip-first slide)
    {
      const yaw = this.state.yaw;
      const lat = this.slideDir.x * Math.cos(yaw) - this.slideDir.z * Math.sin(yaw); // + = to the view's right
      this.slideRollSign = lat < -0.3 ? 1 : -1;
    }
    const prevTac = this.tac;
    this.sprintLatched = false;
    if (prevTac) this._setTac(false);
    this.sprinting = false;
    const st = this.state;
    if (st.stance !== 'crouch') {
      const prev = st.stance;
      st.stance = 'crouch';
      this._evStance.stance = 'crouch';
      this._evStance.previous = prev;
      this.ctx.events.emit('player:stance', this._evStance);
    }
    st.sliding = true;
    this.fb.slideStart += 1;
    const e = this._evSlide;
    e.phase = 'start'; e.position.copy(this.pos); e.speed = entry; e.surface = this._surfaceBelow();
    this.ctx.events.emit('player:slide', e);
  }

  _stepSlideVelocity(dt, wish, inMag) {
    const vel = this.vel;
    let sp = this.slideSpeed;
    // friction: low early (momentum), stronger at the end
    const tt = this.slideTime;
    const lin = MOVE.slideLinFriction * (0.6 + 0.9 * smoothstep(0.15, 0.8, tt));
    sp -= (lin + MOVE.slideExpFriction * sp) * dt;
    // slopes: accelerate downhill, brake uphill
    const n = this.groundNormal;
    if (n.y < 0.999) {
      const along = -(n.x * this.slideDir.x + n.z * this.slideDir.z); // >0 when facing uphill
      sp -= along * MOVE.gravity * MOVE.slideSlopeAccel * dt;
    }
    sp = Math.max(0, sp);
    // limited steering towards the input direction
    if (inMag > 0.2) {
      const cross = this.slideDir.x * wish.z - this.slideDir.z * wish.x;
      const dot = this.slideDir.x * wish.x + this.slideDir.z * wish.z;
      if (dot > -0.2) {
        const ang = clamp(Math.atan2(cross, dot), -MOVE.slideSteer * dt, MOVE.slideSteer * dt);
        const c = Math.cos(ang), s = Math.sin(ang);
        const x = this.slideDir.x * c - this.slideDir.z * s;
        const z = this.slideDir.x * s + this.slideDir.z * c;
        this.slideDir.set(x, 0, z);
      }
    }
    this.slideSpeed = sp;
    vel.x = this.slideDir.x * sp;
    vel.z = this.slideDir.z * sp;
  }

  /** @param stand true: cancel into standing (jump/sprint/crouch press). */
  _endSlide(stand) {
    if (this.mode !== 'slide') return;
    const st = this.state;
    this.mode = this.grounded ? 'ground' : 'air';
    st.sliding = false;
    this.height = STANCE.crouch.height;
    if (stand) this.setStance('stand');
    const e = this._evSlide;
    e.phase = 'end'; e.position.copy(this.pos); e.speed = Math.hypot(this.vel.x, this.vel.z); e.surface = 'default';
    this.ctx.events.emit('player:slide', e);
    this.syncCapsule();
  }

  // ------------------------------------------------------------------ mantle
  /** Detect a ledge in front and start a mantle/vault. */
  _tryMantle(fromJump) {
    const res = this._mres || (this._mres = { height: 0, vault: false, stance: 'stand', topY: 0, wallDist: 0, target: new THREE.Vector3() });
    if (!this.probeMantle(this.pos, this._fwd, res)) return false;
    this._startMantle(res);
    void fromJump;
    return true;
  }

  /**
   * Pure ledge query (no state change): can a capsule standing at feet `p` facing the horizontal unit
   * vector `fwd` mantle / vault? Fills `out` {height, vault, stance, topY, wallDist, target} and returns
   * true when it can. Also used by shot presets to find real ledges in the level.
   */
  probeMantle(p, fwd, out) {
    const world = this.world;
    if (!world.raycast) return false;
    const r = MOVE.radius;
    const reach = r + MOVE.mantleReach;
    const o = this._o;

    // 1) front wall distance (probe several heights)
    let wallDist = Infinity;
    const probeH = [0.5, 0.95, 1.4, 1.85];
    for (let i = 0; i < probeH.length; i++) {
      o.set(p.x, p.y + probeH[i], p.z);
      const h = world.raycast(o, fwd, reach);
      if (h && Math.abs(h.normal.y) < 0.6 && h.distance < wallDist) wallDist = h.distance;
    }
    if (!(wallDist < reach)) return false;

    // 2) ledge top: cast down just past the wall face
    const topSearch = MOVE.mantleMax + 0.3;
    const inset = 0.22;
    o.set(p.x + fwd.x * (wallDist + inset), p.y + topSearch, p.z + fwd.z * (wallDist + inset));
    const top = world.raycast(o, DOWN, topSearch - MOVE.mantleMin + 0.05);
    if (!top || top.normal.y < 0.7) return false;
    const topY = top.point.y;
    const height = topY - p.y;
    if (height < MOVE.mantleMin || height > MOVE.mantleMax) return false;
    // the ledge must be the obstacle we touch (not something behind it)
    // and the space right above the lip must be open
    o.set(p.x, topY + 0.25, p.z);
    const above = world.raycast(o, fwd, wallDist + 0.5);
    if (above) return false;
    o.set(p.x, topY + 1.0, p.z);
    const above2 = world.raycast(o, fwd, wallDist + 0.5);

    // 3) thickness → vault over thin obstacles. Probe the top surface with down-rays from open air
    //    (robust with double-sided ray queries, unlike a back-ray that may start inside geometry).
    let vault = false;
    let depth = Infinity;
    {
      const step = 0.15;
      for (let k = 1; k <= 6; k++) {
        const along = wallDist + inset + k * step;
        o.set(p.x + fwd.x * along, topY + 0.3, p.z + fwd.z * along);
        const h = world.raycast(o, DOWN, 0.6);
        if (!h || h.point.y < topY - 0.25) { depth = inset + (k - 0.5) * step; break; }
      }
      if (height <= MOVE.vaultMaxHeight && depth < MOVE.vaultMaxDepth) vault = true;
    }

    const target = this._v2;
    let stance = 'stand';
    if (vault) {
      const land = wallDist + depth + r + 0.3;
      o.set(p.x + fwd.x * land, topY + 0.4, p.z + fwd.z * land);
      const g = world.raycast(o, DOWN, 3.5);
      if (!g || g.normal.y < MOVE.walkableCos || topY - g.point.y > 2.6) {
        vault = false;
      } else {
        target.set(o.x, g.point.y, o.z);
        if (!this.fits(target, STANCE.stand.height)) {
          if (this.fits(target, STANCE.crouch.height)) stance = 'crouch';
          else vault = false;
        }
      }
    }
    if (!vault) {
      if (depth < 2 * r + 0.05 && depth !== Infinity) return false; // too thin to stand on
      const onto = wallDist + r + 0.12;
      target.set(p.x + fwd.x * onto, topY, p.z + fwd.z * onto);
      if (!this.fits(target, STANCE.stand.height) || (above2 && height > 1.2)) {
        if (this.fits(target, STANCE.crouch.height)) stance = 'crouch';
        else return false;
      }
      // headroom for the vertical pull at the wall
      const pull = this._o.set(p.x + fwd.x * Math.max(0, wallDist - 0.02), topY + 0.03, p.z + fwd.z * Math.max(0, wallDist - 0.02));
      if (!this.fits(pull, STANCE.crouch.height, 0.05)) return false;
    }

    out.height = height;
    out.vault = vault;
    out.stance = stance;
    out.topY = topY;
    out.wallDist = wallDist;
    out.target.copy(target);
    return true;
  }

  _startMantle(res) {
    const st = this.state;
    const m = this.mantle;
    const p = this.pos;
    const height = res.height, vault = res.vault;
    m.t = 0;
    m.height = height;
    m.vault = vault;
    m.stance = res.stance;
    m.topY = res.topY;
    m.wallDist = res.wallDist;
    m.p0.copy(p);
    m.p2.copy(res.target);
    m.fwd.copy(this._fwd);
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const quick = this.sprinting ? 0.86 : 1;
    m.exitSpeed = vault ? Math.max(hs * 0.8, 3.2) : (this.sprinting ? 3.4 : Math.min(hs, 2.0));
    if (vault) {
      // the hop takes about as long as covering the distance at (most of) the run-in speed
      const D = Math.max(0.5, Math.hypot(m.p2.x - p.x, m.p2.z - p.z));
      m.dur = clamp(D / Math.max(3.2, 0.85 * hs), 0.34, 0.6) + 0.06 * height;
      // Hermite end slopes (normalised): enter with the run-in speed, leave with the exit speed
      m.s0 = clamp((Math.max(hs, 2.5) * m.dur) / D, 0.3, 1.8);
      m.s1 = clamp((m.exitSpeed * m.dur) / D, 0.3, 1.8);
    } else {
      m.dur = (0.4 + 0.24 * height) * quick;
    }
    m.keepSprint = this.sprintLatched;
    if (this.tac) this._setTac(false);
    this.mode = 'mantle';
    st.mantling = true;
    this.grounded = false;
    if (vault) this.vel.set(this._fwd.x * hs, 0, this._fwd.z * hs); else this.vel.set(0, 0, 0);
    this.fb.mantleStart += 1;
    this.jumped = false;
    const e = this._evMantle;
    e.phase = 'start'; e.position.copy(p); e.height = height; e.vault = vault; e.duration = m.dur;
    this.ctx.events.emit('player:mantle', e);
  }

  _stepMantle(dt) {
    const m = this.mantle;
    const st = this.state;
    m.t += dt / m.dur;
    const u = saturate(m.t);
    const p = this.pos;
    const p0 = m.p0, p2 = m.p2;
    if (m.vault) {
      // one fluid hop: momentum carries through (near-constant forward speed), the feet arc up to
      // clear the lip by the time the body reaches the wall, float over and drop on the far side
      const peak = m.topY + 0.14;
      let y;
      if (u < 0.44) y = lerp(p0.y, peak, Math.sin((Math.PI / 2) * (u / 0.44)));
      else if (u < 0.56) y = peak - 0.02 * smoothstep(0.44, 0.56, u);
      else { const k = (u - 0.56) / 0.44; y = lerp(peak - 0.02, p2.y, k * k); }
      const u2 = u * u, u3 = u2 * u;
      const s = (u3 - 2 * u2 + u) * m.s0 + (-2 * u3 + 3 * u2) + (u3 - u2) * m.s1;
      p.set(lerp(p0.x, p2.x, s), y, lerp(p0.z, p2.z, s));
    } else {
      // hands reach the lip, a short load, then a strong pull (fastest mid-climb, easing into the
      // top) and finally the roll over the lip. The rise is deliberately not front-loaded: the
      // ledge edge should visibly travel down the screen instead of popping out of view.
      const k = saturate((u - 0.05) / 0.67);
      const lift = 0.62 * k * k * (3 - 2 * k) + 0.38 * (1 - (1 - k) * (1 - k));
      const y = lerp(p0.y, p2.y, lift) + Math.sin(Math.PI * saturate((u - 0.3) / 0.6)) * 0.06;
      // approach the wall early, move over only once we are nearly up
      const touch = Math.max(0, m.wallDist - MOVE.radius - 0.03);
      const total = Math.hypot(p2.x - p0.x, p2.z - p0.z);
      const a = easeOutCubic(saturate(u / 0.28)) * Math.min(touch, total);
      const b = easeInOutCubic(saturate((u - 0.45) / 0.55)) * (total - Math.min(touch, total));
      const d = a + b;
      p.set(p0.x + m.fwd.x * d, y, p0.z + m.fwd.z * d);
    }
    // velocity for consumers
    this.vel.set((p.x - this.prevPos.x) / dt, (p.y - this.prevPos.y) / dt, (p.z - this.prevPos.z) / dt);
    this.syncCapsule();
    if (m.t >= 1) {
      p.copy(p2);
      this.mode = 'ground';
      st.mantling = false;
      this.height = STANCE[st.stance].height;
      if (m.stance === 'crouch' && st.stance === 'stand') this.setStance('crouch', true);
      this.syncCapsule();
      const info = this._info; resetInfo(info);
      this._resolve(info, true, false, 6);
      this._readCapsule();
      this.grounded = this._groundProbe(0.3);
      if (!this.grounded) { this.mode = 'air'; this.maxFallSpeed = 0; this.fallStartY = p.y; }
      this.vel.set(m.fwd.x * m.exitSpeed, 0, m.fwd.z * m.exitSpeed);
      this.sprintLatched = !!m.keepSprint && st.stance === 'stand';
      if (m.vault) this.fb.landSpeed = Math.max(this.fb.landSpeed, 3.5 + m.height * 1.5);
      const e = this._evMantle;
      e.phase = 'end'; e.position.copy(p); e.height = m.height; e.vault = m.vault; e.duration = m.dur;
      this.ctx.events.emit('player:mantle', e);
    }
  }

  // ------------------------------------------------------------------ post: gait, safety
  _post(dt, t) {
    const st = this.state;
    const vel = this.vel;
    const hs = Math.hypot(vel.x, vel.z);
    st.speed = hs;
    st.moving = hs > 0.3;
    st.grounded = this.grounded;
    // published sprint: the weapon comes up to 'ready' in a real jump / mantle (the sprint latch is kept
    // and resumes on landing); internal speed logic keeps using this.sprinting
    const vis = this._sprintVisible();
    st.sprinting = vis;
    st.tacSprinting = this.tac && vis;
    st.sprintHeld = this.sprinting;
    st.sliding = this.mode === 'slide';
    st.mantling = this.mode === 'mantle';

    // footsteps: phase advances with distance; one step per half cycle
    const walking = this.grounded && this.mode === 'ground';
    const gw = walking && hs > 0.25 ? 1 : 0;
    this.gaitWeight += (gw - this.gaitWeight) * (1 - Math.exp(-8 * dt));
    if (walking && hs > 0.25) {
      const stepLen = this._stepLength(hs);
      const before = Math.floor(this.gait / Math.PI);
      this.gait += (Math.PI * hs * dt) / stepLen;
      const after = Math.floor(this.gait / Math.PI);
      if (after !== before) this._footstep(hs);
    } else if (!walking && this.mode !== 'mantle') {
      // settle the phase towards the nearest plant so the bob fades cleanly
    }
    if (this.gait > 1e6) { this.gait -= 1e6 - (1e6 % (2 * Math.PI)); this.prevGait = this.gait; }

    // out of the world → respawn
    const b = this.world.bounds;
    if (b && this.pos.y < b.min.y - 25) this.onOutOfWorld?.();
    void t;
  }

  _stepLength(hs) {
    const st = this.state;
    if (st.stance === 'prone') return 0.62;
    if (st.stance === 'crouch') return lerp(0.95, 1.25, saturate(hs / MOVE.crouch));
    // continuous: 1.55 m at walk → 2.05 m at sprint → 2.35 m at tac
    if (hs <= MOVE.walk) return lerp(1.1, 1.62, saturate(hs / MOVE.walk));
    if (hs <= MOVE.sprint) return lerp(1.62, 2.08, (hs - MOVE.walk) / (MOVE.sprint - MOVE.walk));
    return lerp(2.08, 2.38, saturate((hs - MOVE.sprint) / (MOVE.tacSprint - MOVE.sprint)));
  }

  _footstep(hs) {
    const st = this.state;
    const e = this._evFoot;
    this.foot ^= 1;
    e.surface = this._surfaceBelow();
    e.position.copy(this.pos);
    e.speed = hs;
    e.stance = st.stance;
    e.foot = this.foot ? 'right' : 'left';
    e.sprinting = this.sprinting;
    e.tacSprinting = this.tac && this.sprinting;
    e.volume = st.stance === 'prone' ? 0.25 : st.stance === 'crouch' ? 0.45 : this.sprinting ? 1 : 0.75;
    this.ctx.events.emit('player:footstep', e);
  }

  /** Face normal of the ground under the capsule centre (up if none / not walkable). */
  _slopeNormal() {
    const o = this._o.set(this.pos.x, this.pos.y + 0.4, this.pos.z);
    const hit = this.world.raycast(o, DOWN, 0.75);
    const n = this._slopeN || (this._slopeN = new THREE.Vector3());
    if (hit && hit.normal && hit.normal.y >= MOVE.walkableCos) n.copy(hit.normal);
    else n.set(0, 1, 0);
    return n;
  }

  _surfaceBelow() {
    const o = this._o.set(this.pos.x, this.pos.y + 0.3, this.pos.z);
    const hit = this.world.raycast(o, DOWN, 1.2);
    return (hit && hit.surface) || 'default';
  }
}

function makeInfo() {
  return { ground: false, wall: false, ceiling: false, groundNormal: new THREE.Vector3(0, 1, 0), wallNormal: new THREE.Vector3() };
}
function resetInfo(i) { i.ground = false; i.wall = false; i.ceiling = false; }

export { UP, DOWN };

import * as THREE from 'three';
import { DEG } from '../../core/constants.js';
import { MOVE, STANCE, HEALTH, SETTINGS_DEFAULTS } from './config.js';
import { Motor } from './motor.js';
import { CameraRig } from './cameraRig.js';

/**
 * player — movement, collision, camera and health. Owner: player agent. See README.md in this folder.
 *
 * services.player (contract in ARCHITECTURE.md; extended fields are additive):
 *   state: { position (feet), velocity, eye, forward (unit view dir), yaw, pitch, roll,
 *            stance 'stand'|'crouch'|'prone', grounded, sprinting, sliding, moving, speed, lean, health,
 *            maxHealth, alive, ads,
 *            + tacSprinting, mantling, mantleProgress, mantleHeight, sprintBlend (0..1), slideTime,
 *              bobPhase (rad, foot plant at kπ), bobWeight, airTime, fov (current hfov), eyeHeight,
 *              forwardFlat, lastDamageTime, regenerating, tacCharge (0..1), stanceTransition (0..1),
 *              landImpact (0..1, decays), invulnerable }
 *   teleport(position, yaw?, pitch?)        radians
 *   setPose({position:[x,y|null,z], yaw, pitch, stance})   degrees
 *   applyRecoil(pitchRad, yawRad)           kick with smooth application + partial recovery
 *   addShake(intensity 0..1, duration s)    trauma-based noise shake
 *   setZoom(multiplier)                     ADS zoom (1 = none)
 *   setMovementEnabled(bool);  damage(amount, info)
 *   + respawn(position?, yaw?)  heal(amount)  kill(info)  setInvulnerable(bool)  setStance(stance)
 *   + flinch(amount, sourcePosition?)       camera flinch without damage
 * Events: player:footstep {surface, position, speed, stance, foot, sprinting, tacSprinting, volume}
 *         player:jump {position, speed}   player:land {speed, position, surface, height}
 *         player:stance {stance, previous}   player:damaged {amount, health, info}   player:died {info}
 *         player:slide {phase 'start'|'end', position, speed, surface}
 *         player:mantle {phase 'start'|'end', position, height, vault, duration}
 *         player:tacsprint {active, charge}   player:regen {phase 'start'|'end', health}
 *         player:respawn {position}
 */
export default function createSystem(ctx) {
  const { camera, input, events } = ctx;

  const state = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    eye: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 0, -1),
    forwardFlat: new THREE.Vector3(0, 0, -1),
    yaw: 0,
    pitch: 0,
    roll: 0,
    stance: 'stand',
    grounded: false,
    sprinting: false,
    tacSprinting: false,
    sliding: false,
    mantling: false,
    mantleProgress: 0,
    mantleHeight: 0,
    moving: false,
    speed: 0,
    lean: 0,
    health: HEALTH.max,
    maxHealth: HEALTH.max,
    alive: true,
    ads: 0,
    sprintBlend: 0,
    slideTime: 0,
    bobPhase: 0,
    bobWeight: 0,
    airTime: 0,
    fov: 90,
    eyeHeight: STANCE.stand.eye,
    lastDamageTime: -100,
    regenerating: false,
    tacCharge: 1,
    stanceTransition: 0,
    landImpact: 0,
    invulnerable: false,
  };

  let motor = null;
  let rig = null;
  const move = { x: 0, y: 0 };
  const evDamaged = { amount: 0, health: 0, info: null };
  const evDied = { info: null };
  const evRegen = { phase: 'start', health: 0 };
  const evRespawn = { position: new THREE.Vector3() };
  const tmpV = new THREE.Vector3();
  let regenActive = false;
  let lastT = 0;

  function spawnPoint() {
    const sp = ctx.services.world.spawnPoints?.player?.[0];
    return sp || { position: new THREE.Vector3(), yaw: 0 };
  }

  function teleport(pos, yaw = state.yaw, pitch = state.pitch) {
    state.yaw = yaw;
    state.pitch = pitch;
    if (motor) motor.teleport(pos);
    else state.position.copy(pos);
    rig?.reset();
    syncCameraNow();
  }

  function setPose(p = {}) {
    const pos = tmpV.copy(state.position);
    if (p.position) {
      pos.set(p.position[0], p.position[1] ?? 0, p.position[2]);
      if (p.position[1] === undefined || p.position[1] === null) pos.y = ctx.services.world.groundHeight(pos.x, pos.z);
    }
    if (p.stance && STANCE[p.stance]) state.stance = p.stance;
    teleport(pos, p.yaw !== undefined ? p.yaw * DEG : state.yaw, p.pitch !== undefined ? p.pitch * DEG : state.pitch);
  }

  function syncCameraNow() {
    if (!rig) return;
    rig.apply(0, ctx.time.t, 1);
  }

  function die(info) {
    if (!state.alive) return;
    state.health = 0;
    state.alive = false;
    motor._stopSprint();
    if (motor.mode === 'slide') motor._endSlide(false);
    rig.deathT = 0;
    rig.deathSide = (info && info.position && ((info.position.x - state.position.x) * Math.cos(state.yaw) - (info.position.z - state.position.z) * Math.sin(state.yaw)) > 0) ? -1 : 1;
    evDied.info = info;
    events.emit('player:died', evDied);
  }

  function damage(amount, info = {}) {
    if (!state.alive || !(amount > 0)) return;
    if (state.invulnerable) return;
    state.health = Math.max(0, state.health - amount);
    state.lastDamageTime = ctx.time.t;
    if (regenActive) { regenActive = false; state.regenerating = false; }
    // flinch towards the source when known
    let dx = 0, dz = 0;
    const src = info && (info.position || info.origin);
    if (src && typeof src.x === 'number') { dx = src.x - state.position.x; dz = src.z - state.position.z; }
    else if (info && info.direction && typeof info.direction.x === 'number') { dx = -info.direction.x; dz = -info.direction.z; }
    const l = Math.hypot(dx, dz);
    if (l > 1e-4) { dx /= l; dz /= l; }
    if (info?.type !== 'fall') rig.flinch(amount, dx, dz);
    else rig.addShake(Math.min(0.6, amount / 80), 0.4);
    evDamaged.amount = amount;
    evDamaged.health = state.health;
    evDamaged.info = info;
    events.emit('player:damaged', evDamaged);
    if (state.health <= 0) die(info);
  }

  function respawn(position, yaw) {
    const sp = spawnPoint();
    state.health = state.maxHealth;
    state.alive = true;
    state.regenerating = false;
    regenActive = false;
    state.lastDamageTime = -100;
    state.stance = 'stand';
    motor.height = STANCE.stand.height;
    teleport(position || sp.position, yaw ?? sp.yaw ?? 0, 0);
    evRespawn.position.copy(state.position);
    events.emit('player:respawn', evRespawn);
  }

  const api = {
    state,
    teleport,
    setPose,
    applyRecoil(p, y) { rig?.applyRecoil(p || 0, y || 0); },
    addShake(intensity, duration) { rig?.addShake(intensity || 0, duration || 0.3); },
    setZoom(m) { if (rig) rig.zoom = Math.max(0.1, m || 1); },
    setMovementEnabled(b) { if (motor) motor.enabled = !!b; },
    damage,
    // ---- extensions
    respawn,
    heal(amount) { if (state.alive) state.health = Math.min(state.maxHealth, state.health + Math.max(0, amount)); },
    kill(info = {}) { if (!state.invulnerable) damage(state.health + 1, info); },
    setInvulnerable(b) { state.invulnerable = !!b; },
    setStance(s) { return motor ? motor.setStance(s) : false; },
    flinch(amount = 20, sourcePosition = null) {
      let dx = 0, dz = 0;
      if (sourcePosition) { dx = sourcePosition.x - state.position.x; dz = sourcePosition.z - state.position.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; }
      rig?.flinch(amount, dx, dz);
    },
    /**
     * Ledge query without side effects: could the player standing at `position` (feet) facing `yaw`
     * (radians) mantle / vault? -> null | {height, vault, stance, topY, wallDist, target: Vector3} (new).
     */
    probeMantle(position, yaw) {
      if (!motor) return null;
      const out = { height: 0, vault: false, stance: 'stand', topY: 0, wallDist: 0, target: new THREE.Vector3() };
      const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      return motor.probeMantle(position.clone(), fwd, out) ? out : null;
    },
    get motor() { return motor; },
  };

  function fixedUpdate(dt, t) {
    input.getMove(move);
    motor.moveInput.x = move.x;
    motor.moveInput.y = move.y;
    motor.step(dt, t);

    // health regeneration (CoD-style: nothing for 4 s, then a quick refill)
    if (state.alive && state.health < state.maxHealth) {
      if (t - state.lastDamageTime >= HEALTH.regenDelay) {
        if (!regenActive) {
          regenActive = true;
          state.regenerating = true;
          evRegen.phase = 'start'; evRegen.health = state.health;
          events.emit('player:regen', evRegen);
        }
        state.health = Math.min(state.maxHealth, state.health + HEALTH.regenRate * dt);
        if (state.health >= state.maxHealth) {
          regenActive = false;
          state.regenerating = false;
          evRegen.phase = 'end'; evRegen.health = state.health;
          events.emit('player:regen', evRegen);
        }
      }
    }
    lastT = t;
  }

  function update(dt) {
    // edges → motor intents (consumed by the next fixed step)
    const it = motor.intent;
    if (input.pressed('jump')) it.jump = MOVE.jumpBuffer;
    if (input.pressed('crouch')) it.crouch = true;
    if (input.released('crouch')) it.crouchRelease = true;
    if (input.pressed('prone')) it.prone = true;
    if (input.pressed('sprint')) it.sprint = true;
    if (input.pressed('fire')) it.fire = true;
    if (input.pressed('ads')) it.ads = true;

    state.ads = ctx.services.weapons?.state?.ads ?? 0;

    // look (per render frame for responsiveness) + recoil integration
    const lookOk = state.alive;
    rig.updateAim(dt, lookOk ? input.look.dx : 0, lookOk ? input.look.dy : 0);

    // mirrored animation fields
    state.sprintBlend = motor.sprintBlend;
    state.slideTime = motor.mode === 'slide' ? motor.slideTime : 0;
    state.mantleProgress = motor.mode === 'mantle' ? Math.min(1, motor.mantle.t) : 0;
    state.mantleHeight = motor.mantle.height;
    state.airTime = motor.airTime;
    state.tacCharge = motor.tacCharge / MOVE.tacDuration;
    state.stanceTransition = motor.stanceLock > 0 ? 1 - motor.stanceLock / motor.stanceLockDur : 0;
    state.landImpact = Math.max(0, Math.min(1, -rig.landY.x / 0.15));
    const sy = Math.sin(state.yaw), cy = Math.cos(state.yaw);
    state.forwardFlat.set(-sy, 0, -cy);
  }

  function lateUpdate(dt, t) {
    rig.apply(dt, t, ctx.time.deterministic ? 1 : ctx.time.alpha);
  }

  return {
    name: 'player',
    async init() {
      ctx.settings.registerDefaults('player', { ...SETTINGS_DEFAULTS });
      await ctx.services.world.ready;
      motor = new Motor(ctx, state);
      rig = new CameraRig(ctx, state, motor);
      input.setLookHandler((dx, dy) => {
        if (state.alive && rig) rig.applyImmediateLook(dx, dy);
      });
      motor.onFallDamage = (dmg, h) => damage(dmg, { type: 'fall', source: 'fall', height: h, position: null });
      motor.onOutOfWorld = () => respawn();

      const sp = spawnPoint();
      const p = sp.position.clone();
      p.y = ctx.services.world.groundHeight(p.x, p.z);
      state.yaw = sp.yaw || 0;
      if (ctx.shot?.player) {
        ctx.services.provide('player', api);
        setPose(ctx.shot.player);
      } else {
        teleport(p, state.yaw, 0);
        ctx.services.provide('player', api);
      }
      rig.apply(0, ctx.time.t, 1);
      ctx.debug?.gui && buildDebug(ctx.debug.gui);
    },
    fixedUpdate,
    update,
    lateUpdate,
    dispose() { input.setLookHandler(null); },
  };

  function buildDebug(gui) {
    const f = gui.addFolder('player');
    const s = ctx.settings.data.player;
    f.add(s, 'sprintMode', ['toggle', 'hold']);
    f.add(s, 'tacSprint', ['doubleTap', 'auto', 'off']);
    f.add(s, 'headBob', 0, 1.5, 0.05);
    f.add(s, 'fovEffects');
    f.add(state, 'invulnerable');
    f.add({ shake: () => rig.addShake(0.7, 0.8) }, 'shake');
    f.add({ hurt: () => damage(35, { type: 'debug' }) }, 'hurt');
    f.add({ respawn: () => respawn() }, 'respawn');
    f.close();
  }
}

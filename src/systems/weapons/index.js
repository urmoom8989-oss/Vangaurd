import * as THREE from 'three';
import { DEG, LAYERS, settingsFovToVfov } from '../../core/constants.js';
import { createMaterials, disposeMaterials } from './materials.js';
import { buildRifle, buildMagAssembly } from './models/rifle.js';
import { buildPistol, buildPistolMagAssembly } from './models/pistol.js';
import { buildGrenade } from './models/grenade.js';
import { buildArm, POSES, clonePose, lerpPose, copyPose } from './models/arms.js';
import { SpringN, damp, smootherstep, noise1 } from './anim.js';
import { VM, WEAPONS, GRENADE } from './config.js';
import { getSelectedGrenade, getWeaponProgression, getGrenadeTypes, setSelectedGrenade, getWeaponLoadout } from '../gamemode/progression.js';
import { buildClips } from './clips.js';
import { triCount } from './geo.js';

/**
 * weapons — viewmodel (arms + weapons), weapon logic, recoil, reloads, grenades.
 * See README.md in this folder for the API, events and shot hooks.
 */
export default function createSystem(ctx) {
  const { camera, input, events, time } = ctx;
  const LAYER = LAYERS.VIEWMODEL;
  const rng = ctx.rng.fork('weapons');
  let mats = null;
  const textures = [];
  const disposables = [];

  // ------------------------------------------------------------------ rig
  const vmRoot = new THREE.Group(); // child of camera (or of a display anchor)
  vmRoot.name = 'viewmodel';
  const gunPivot = new THREE.Group(); // weapon transform in viewmodel space
  gunPivot.name = 'gun';
  vmRoot.add(gunPivot);
  let armR = null, armL = null;
  const models = {}; // id -> { root, parts, sockets, cfg, clips, handMag, dropMags }
  let cur = null; // current weapon model record
  let pendingId = null;
  let display = null;
  let grenadeModel = null;
  const grenades = []; // world grenade pool

  // ------------------------------------------------------------------ public state
  const state = {
    id: 'rifle', name: WEAPONS.rifle.name, ammo: WEAPONS.rifle.magSize, magSize: WEAPONS.rifle.magSize,
    reserve: WEAPONS.rifle.reserve, fireMode: 'auto', ads: 0, reloading: false, reloadProgress: 0,
    sprinting: false, lastShotTime: -1, spread: 0, action: 'equip',
    // extensions
    lethal: GRENADE.count, tactical: 0, grenadeType: getSelectedGrenade(), tacSprint: false, inspecting: false, reloadType: null, shotsFired: 0,
  };
  const ammoStore = {}; // per weapon {ammo, reserve, fireMode}

  // ------------------------------------------------------------------ timers / flags
  let cooldown = 0;
  let adsT = 0;
  let burstCount = 0;
  let lastFireT = -10;
  let bloom = 0;
  let sprintW = 0, tacW = 0, lowerW = 1;
  let sprintOutT = 0;
  let lastSprintPress = -10;
  let tacLatched = false;
  let clip = null; // { name, t, dur, data, onEvent }
  let clipT = 0;
  let clipEventsFired = 0;
  let equipT = 0, holsterT = -1;
  let triggerPull = 0;
  let boltBack = 0; // 0 home, 1 fully back (for port view)
  let boltLocked = false;
  let slideT = 1; // pistol slide cycle
  let inspectHold = 0;
  let forced = null; // { state, progress }
  let fmSwitchT = -1;
  let bobPhase = 0, bobAmt = 0;
  let prevYaw = 0, prevPitch = 0, firstFrame = true;
  let landImpulse = 0;
  let fireHeldPrev = false;

  // procedural springs
  const sway = new SpringN(5, 120, 0.72);     // px, py, rotX, rotY, rotZ from look
  const kick = new SpringN(6, 420, 0.42);     // back, up, pitch, yaw, roll, side
  const kickSlow = new SpringN(3, 90, 0.8);   // slow drift of the gun during sustained fire (pitch, yaw, back)
  const bump = new SpringN(3, 160, 0.5);      // landing / stance bumps: py, rotX, rotZ

  // ------------------------------------------------------------------ scratch (no per-frame alloc)
  const _m0 = new THREE.Matrix4(), _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
  const _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
  const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
  const _e0 = new THREE.Euler();
  const _s1 = new THREE.Vector3(1, 1, 1);
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const camFwd = new THREE.Vector3(), camRight = new THREE.Vector3(), camUp = new THREE.Vector3();
  const firedEvt = { weaponId: '', origin, direction: dir, time: 0 };
  const reloadEvt = { weaponId: '', phase: 'start', type: 'tactical' };
  const equipEvt = { weaponId: '' };
  const emptyEvt = { weaponId: '' };
  const cueEvt = { weaponId: '', cue: '' };
  const hitscanReq = { origin, direction: dir, range: 400, damage: 30, source: 'player', weaponId: '', spread: 0, penetration: 0, spreadApplied: true };
  const vfxReq = { weaponId: '', object: null, ads: 0 };
  const shoulderR = new THREE.Vector3().fromArray(VM.shoulderR), shoulderL = new THREE.Vector3().fromArray(VM.shoulderL);
  const poleR = new THREE.Vector3().fromArray(VM.poleR).normalize(), poleL = new THREE.Vector3().fromArray(VM.poleL).normalize();
  const poseR = clonePose(POSES.gripTrigger), poseL = clonePose(POSES.gripVert), poseTmp = clonePose(POSES.relaxed);
  const handPosR = new THREE.Vector3(), handPosL = new THREE.Vector3();
  const handQR = new THREE.Quaternion(), handQL = new THREE.Quaternion();
  const clipOut = new Float32Array(8);
  const clipPos = new THREE.Vector3(), clipQ = new THREE.Quaternion();
  const gunMat = new THREE.Matrix4();

  // dev hook (bench tool / debugging): live-tunable tables + orbit camera
  const dev = { orbit: null, WEAPONS, VM, noGrasp: false, poseR: null, poseL: null, POSES, get: () => ({ cur, armR, armL, models, mats, vmRoot, gunPivot }) };

  // ------------------------------------------------------------------ helpers
  const basisQuat = (palm, fingers, out) => {
    // hand frame: Y = -palm normal, Z = -finger direction, X = Y x Z
    _v1.fromArray(palm).normalize().negate();
    _v2.fromArray(fingers).normalize().negate();
    _v2.addScaledVector(_v1, -_v2.dot(_v1)).normalize();
    _v0.crossVectors(_v1, _v2).normalize();
    _m3.makeBasis(_v0, _v1, _v2);
    return out.setFromRotationMatrix(_m3);
  };
  const eulerDeg = (arr, out) => out.setFromEuler(_e0.set(arr[0] * DEG, arr[1] * DEG, arr[2] * DEG, 'YXZ'));

  function cfg() { return cur.cfg; }

  // ------------------------------------------------------------------ build
  async function loadTextures() {
    const base = '/assets/weapons/tex/';
    const [grunge, detail, multicam] = await Promise.all([
      ctx.assets.texture(base + 'wpn_grunge.png', { srgb: false, repeat: [1, 1] }),
      ctx.assets.texture(base + 'wpn_detail.png', { srgb: false, repeat: [1, 1] }),
      ctx.assets.texture(base + 'multicam.png', { srgb: true, repeat: [1, 1] }),
    ]);
    textures.push(grunge, detail, multicam);
    return { grunge, detail, multicam };
  }

  function makeMagInstance(asmFactory, name) {
    const g = asmFactory().build(mats, LAYER, name);
    const grp = new THREE.Group();
    grp.name = name;
    grp.add(...g.children);
    grp.traverse((o) => { if (o.isMesh) disposables.push(o.geometry); });
    return grp;
  }

  function setupModel(id, built) {
    const c = WEAPONS[id];
    const rec = { id, cfg: c, ...built };
    rec.root.visible = false;
    gunPivot.add(rec.root);
    rec.root.traverse((o) => { if (o.isMesh) disposables.push(o.geometry); });
    // hand targets in gun space
    rec.gripR = { pos: new THREE.Vector3().fromArray(c.gripR.pos), quat: basisQuat(c.gripR.palm, c.gripR.fingers, new THREE.Quaternion()) };
    rec.gripL = { pos: new THREE.Vector3().fromArray(c.gripL.pos), quat: basisQuat(c.gripL.palm, c.gripL.fingers, new THREE.Quaternion()) };
    rec.magHold = { pos: new THREE.Vector3().fromArray(c.magHold.pos), quat: basisQuat(c.magHold.palm, c.magHold.fingers, new THREE.Quaternion()) };
    // mag-in-hand offset: inverse(hand at magHold) * seat
    const seat = rec.sockets.magSeat;
    _m0.compose(rec.magHold.pos, rec.magHold.quat, _s1).invert();
    _m1.compose(seat.position, _q0.identity(), _s1);
    rec.magInHand = new THREE.Matrix4().multiplyMatrices(_m0, _m1);
    // spare magazine carried by the left hand + dropped mags
    const fac = id === 'pistol' ? buildPistolMagAssembly : buildMagAssembly;
    rec.handMag = makeMagInstance(fac, `${id}:handMag`);
    rec.handMag.visible = false;
    armL.bones.hand.add(rec.handMag);
    rec.handMag.matrixAutoUpdate = false;
    rec.handMag.matrix.copy(rec.magInHand);
    rec.dropMags = [];
    for (let i = 0; i < 3; i++) {
      const dm = makeMagInstance(fac, `${id}:dropMag${i}`);
      dm.visible = false;
      rec.dropMags.push({ obj: dm, phase: 0, t: 0, vel: new THREE.Vector3(), ang: new THREE.Vector3(), world: false });
    }
    rec.dropIdx = 0;
    const defs = (list) => (list || []).map((d) => ({ a: new THREE.Vector3().fromArray(d.a), b: new THREE.Vector3().fromArray(d.b), r: d.r, mask: d.mask, part: d.part || null }));
    rec.colR = defs(c.collidersR);
    rec.colL = defs(c.collidersL);
    rec.clips = buildClips(id, rec);
    models[id] = rec;
    ammoStore[id] = { ammo: c.magSize + (c.chamber || 0) * 0, reserve: c.reserve, fireMode: c.modes[0] };
    return rec;
  }

  function build() {
    armR = buildArm(1, mats, LAYER, { watch: false });
    armL = buildArm(-1, mats, LAYER, { watch: true });
    vmRoot.add(armR.group, armL.group);
    setupModel('rifle', buildRifle(mats, LAYER));
    try {
      setupModel('pistol', buildPistol(mats, LAYER));
    } catch (e) {
      ctx.reportError('weapons', 'build-pistol', e);
    }
    grenadeModel = buildGrenade(mats, LAYER);
    grenadeModel.root.visible = false;
    armL.bones.hand.add(grenadeModel.root);
    grenadeModel.root.traverse((o) => { if (o.isMesh) disposables.push(o.geometry); });
    // world grenade pool
    for (let i = 0; i < 3; i++) {
      const g = buildGrenade(mats, LAYERS.WORLD);
      g.root.visible = false;
      g.root.traverse((o) => { if (o.isMesh) { o.castShadow = true; disposables.push(o.geometry); } });
      ctx.scene.add(g.root);
      grenades.push({ obj: g.root, alive: false, t: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), spin: new THREE.Vector3(), rest: false });
    }
    // dropped mags live in the scene (world) or vmRoot (just after release)
    for (const id of Object.keys(models)) for (const d of models[id].dropMags) vmRoot.add(d.obj);
    let tris = triCount(vmRoot);
    console.log(`[system:weapons] viewmodel built: ${Math.round(tris)} tris`);
  }

  function selectModel(id) {
    if (!models[id]) id = 'rifle';
    if (cur) {
      ammoStore[cur.id].ammo = state.ammo;
      ammoStore[cur.id].reserve = state.reserve;
      ammoStore[cur.id].fireMode = state.fireMode;
      cur.root.visible = false;
    }
    cur = models[id];
    cur.root.visible = true;
    const c = cur.cfg;
    const st = ammoStore[id];
    state.id = id;
    state.name = c.name;
    state.magSize = c.magSize;
    state.ammo = st.ammo;
    state.reserve = st.reserve;
    state.fireMode = st.fireMode;
    boltLocked = state.ammo === 0;
    applyFireModeVisual(true);
  }

  // ------------------------------------------------------------------ clips
  function playClip(name, onDone) {
    const c = cur.clips[name];
    if (!c) { onDone?.(); return false; }
    clip = { name, data: c, onDone };
    clipT = 0;
    clipEventsFired = 0;
    return true;
  }
  function stopClip() {
    if (!clip) return;
    // clean up any mag state the clip was in the middle of
    if (cur.parts.mag) cur.parts.mag.visible = true;
    cur.handMag.visible = false;
    grenadeModel.root.visible = false;
    clip = null;
  }

  function clipEvent(ev) {
    cueEvt.weaponId = state.id;
    cueEvt.cue = ev;
    events.emit('weapons:cue', cueEvt);
    const au = ctx.services.audio;
    switch (ev) {
      case 'magGrab':
        cur.parts.mag.visible = false;
        cur.handMag.visible = true;
        au.play(`${cur.cfg.kind}_mag_out`, { bus: 'sfx' });
        break;
      case 'magDrop': dropMag(); au.play(`${cur.cfg.kind}_mag_out`, { bus: 'sfx' }); break;
      case 'magNew': cur.handMag.visible = true; break;
      case 'magSeat':
        cur.handMag.visible = false;
        cur.parts.mag.visible = true;
        finishReloadAmmo();
        au.play(`${cur.cfg.kind}_mag_in`, { bus: 'sfx' });
        break;
      case 'boltRelease':
        boltLocked = false;
        au.play(`${cur.cfg.kind}_bolt_release`, { bus: 'sfx' });
        break;
      case 'meleeHit': meleeHit(); break;
      case 'pinPull': au.play('grenade_pin', { bus: 'sfx' }); break;
      case 'grenadeShow': grenadeModel.root.visible = true; break;
      case 'grenadeRelease': throwGrenade(); break;
      case 'fireMode': cycleFireMode(); break;
      default: au.play(`${cur.cfg.kind}_${ev}`, { bus: 'sfx' });
    }
  }

  function updateClip(dt) {
    if (!clip) return;
    clipT += dt;
    const evs = clip.data.events;
    while (clipEventsFired < evs.length && clipT >= evs[clipEventsFired][0]) {
      clipEvent(evs[clipEventsFired][1]);
      clipEventsFired++;
    }
    if (state.reloading) state.reloadProgress = Math.min(1, clipT / clip.data.dur);
    if (clipT >= clip.data.dur) {
      const done = clip.onDone;
      clip = null;
      done?.();
    }
  }

  // ------------------------------------------------------------------ actions
  function canAct() { return !clip && holsterT < 0 && equipT <= 0 && !pendingId; }

  function startReload() {
    const c = cur.cfg;
    const full = state.ammo >= c.magSize + (c.chamber || 0);
    if (state.reloading || state.reserve <= 0 || state.ammo >= c.magSize + (state.ammo > 0 ? c.chamber : 0) || full) return false;
    const empty = state.ammo === 0;
    state.reloading = true;
    state.reloadProgress = 0;
    state.reloadType = empty ? 'empty' : 'tactical';
    state.action = 'reload';
    reloadEvt.weaponId = state.id; reloadEvt.phase = 'start'; reloadEvt.type = state.reloadType;
    events.emit('weapon:reload', reloadEvt);
    playClip(empty ? 'reloadEmpty' : 'reload', () => {
      state.reloading = false;
      state.reloadProgress = 0;
      state.action = 'idle';
      reloadEvt.weaponId = state.id; reloadEvt.phase = 'end'; reloadEvt.type = state.reloadType;
      events.emit('weapon:reload', reloadEvt);
    });
    return true;
  }
  function finishReloadAmmo() {
    const c = cur.cfg;
    const chamber = state.ammo > 0 ? (c.chamber || 0) : 0; // round still in the chamber on a tactical reload
    const want = c.magSize + chamber - state.ammo;
    const take = Math.min(want, state.reserve);
    state.ammo += take;
    state.reserve -= take;
  }
  // stabilize: a fresh life / restarted match starts with full mags (was carrying an empty mag across respawns)
  function refillLoadout() {
    try {
      cancelReload();
      for (const id in ammoStore) {
        const c = models[id]?.cfg;
        if (!c) continue;
        const loadout = getWeaponLoadout(id);
        const fieldKit = loadout.barrel === 'precision';
        ammoStore[id].ammo = c.magSize;
        ammoStore[id].reserve = Math.max(ammoStore[id].reserve || 0, Math.round((c.reserve || 0) * (fieldKit ? 1.2 : 1)));
      }
      if (cur) {
        const loadout = getWeaponLoadout(cur.id);
        const fieldKit = loadout.barrel === 'precision';
        state.ammo = cur.cfg.magSize;
        state.reserve = Math.max(state.reserve || 0, Math.round((cur.cfg.reserve || 0) * (fieldKit ? 1.2 : 1)));
        boltLocked = false;
      }
      if (Number.isFinite(state.lethal) && state.lethal < GRENADE.count) state.lethal = GRENADE.count;
    } catch (e) { ctx.reportError('weapons', 'refillLoadout', e); }
  }
  function cancelReload() {
    if (!state.reloading) return;
    stopClip();
    state.reloading = false;
    state.reloadProgress = 0;
    state.action = 'idle';
  }

  function dropMag() {
    cur.parts.mag.visible = false;
    const d = cur.dropMags[cur.dropIdx];
    cur.dropIdx = (cur.dropIdx + 1) % cur.dropMags.length;
    // start in viewmodel space at the magazine's current transform
    if (d.obj.parent !== vmRoot) vmRoot.add(d.obj);
    cur.parts.mag.updateWorldMatrix(true, false);
    _m0.copy(vmRoot.matrixWorld).invert().multiply(cur.parts.mag.matrixWorld);
    _m0.decompose(d.obj.position, d.obj.quaternion, d.obj.scale);
    d.obj.visible = true;
    d.phase = 1; d.t = 0; d.world = false;
    d.vel.set(0.05, -0.6, 0.05);
    d.ang.set(1.5, 0.4, -2.0);
  }

  function updateDropMags(dt) {
    for (const id in models) for (const d of models[id].dropMags) {
      if (!d.phase) continue;
      d.t += dt;
      if (!d.world) {
        d.vel.y -= 9.8 * dt;
        d.obj.position.addScaledVector(d.vel, dt);
        _e0.set(d.ang.x * dt, d.ang.y * dt, d.ang.z * dt);
        d.obj.quaternion.multiply(_q0.setFromEuler(_e0));
        if (d.t > 0.45) {
          // hand over to the world at real scale near the player's feet (out of view by now)
          const p = ctx.services.player.state;
          d.world = true;
          ctx.scene.add(d.obj);
          d.obj.layers.set(LAYERS.WORLD);
          d.obj.traverse((o) => o.layers.set(LAYERS.WORLD));
          d.obj.scale.set(1, 1, 1);
          const yaw = p.yaw;
          d.obj.position.set(p.position.x - Math.sin(yaw) * 0.35 + Math.cos(yaw) * 0.12, p.position.y + 0.6, p.position.z - Math.cos(yaw) * 0.35 - Math.sin(yaw) * 0.12);
          d.vel.set(0, -1.5, 0);
        }
      } else {
        const g = ctx.services.world.groundHeight(d.obj.position.x, d.obj.position.z, d.obj.position.y + 0.5);
        if (d.phase === 1) {
          d.vel.y -= 9.8 * dt;
          d.obj.position.addScaledVector(d.vel, dt);
          _e0.set(d.ang.x * dt, d.ang.y * dt, d.ang.z * dt);
          d.obj.quaternion.multiply(_q0.setFromEuler(_e0));
          if (d.obj.position.y <= g + 0.012) {
            d.obj.position.y = g + 0.012;
            d.phase = 2;
            // lie flat on its side
            d.obj.quaternion.setFromEuler(_e0.set(0, d.t * 3.1, Math.PI / 2));
          }
        }
        if (d.t > 25) { d.phase = 0; d.obj.visible = false; }
      }
    }
  }

  function meleeHit() {
    camera.getWorldPosition(origin);
    camera.getWorldDirection(dir);
    hitscanReq.range = 2.2; hitscanReq.damage = 135; hitscanReq.weaponId = 'melee'; hitscanReq.spread = 0; hitscanReq.penetration = 0;
    const r = ctx.services.combat.fireHitscan(hitscanReq);
    ctx.services.audio.play(r ? 'melee_hit' : 'melee_swing', { bus: 'sfx' });
    if (r) ctx.services.player.addShake(0.25, 0.12);
  }

  function throwGrenade() {
    grenadeModel.root.visible = false;
    const g = grenades.find((x) => !x.alive) || grenades[0];
    camera.getWorldPosition(origin);
    camera.getWorldDirection(dir);
    camRight.set(1, 0, 0).applyQuaternion(camera.getWorldQuaternion(_q0));
    g.pos.copy(origin).addScaledVector(dir, 0.4).addScaledVector(camRight, -0.15);
    g.pos.y -= 0.1;
    g.vel.copy(dir).multiplyScalar(GRENADE.speed);
    g.vel.y += GRENADE.up;
    g.spin.set(9, 2, 4);
    g.alive = true; g.t = 0; g.rest = false; g.type = state.grenadeType;
    g.obj.visible = true;
    g.obj.position.copy(g.pos);
    events.emit('weapons:grenade', { phase: 'thrown', type: g.type, position: g.pos });
    ctx.services.audio.play('grenade_throw', { bus: 'sfx' });
  }

  function detonateGrenade(g) {
    g.alive = false;
    g.obj.visible = false;
    if (g.type === 'smoke') {
      ctx.services.vfx.spawn('smoke', { position: g.pos, radius: 7, duration: 12 });
    } else if (g.type === 'flash') {
      const distance = ctx.services.player.state.position.distanceTo(g.pos);
      if (distance < 18) ctx.services.postfx.pulse('flashbang', Math.max(0.15, 1 - distance / 18), 2.2);
    } else {
      const proximity = g.type === 'proximity';
      ctx.services.combat.explode({ position: g.pos, radius: proximity ? 5.5 : GRENADE.radius, damage: proximity ? 115 : GRENADE.damage, source: 'player', weaponId: proximity ? 'proximity_grenade' : 'frag_grenade' });
    }
    events.emit('weapons:grenade', { phase: 'exploded', type: g.type, position: g.pos });
  }

  const _gHitDir = new THREE.Vector3();
  function updateGrenades(dt) {
    for (const g of grenades) {
      if (!g.alive) continue;
      g.t += dt;
      if (g.type === 'proximity' && g.t >= 0.8) {
        const target = (ctx.services.ai?.agents || []).find((agent) => agent.alive && agent.team === 'enemy' && agent.position.distanceToSquared(g.pos) <= 16);
        if (target || g.t >= 15) { detonateGrenade(g); continue; }
      } else if (g.t >= GRENADE.fuse) {
        detonateGrenade(g);
        continue;
      }
      if (g.rest) continue;
      g.vel.y -= 9.8 * dt;
      const step = g.vel.length() * dt;
      if (step > 1e-5) {
        _gHitDir.copy(g.vel).normalize();
        const hit = ctx.services.world.raycast(g.pos, _gHitDir, step + 0.04);
        if (hit) {
          g.pos.copy(hit.point).addScaledVector(hit.normal, 0.04);
          const vn = g.vel.dot(hit.normal);
          g.vel.addScaledVector(hit.normal, -1.45 * vn).multiplyScalar(0.55);
          g.spin.multiplyScalar(0.6);
          if (g.vel.lengthSq() < 0.3 && hit.normal.y > 0.6) { g.rest = true; g.vel.set(0, 0, 0); }
          if (Math.abs(vn) > 2) ctx.services.audio.playAt?.('grenade_bounce', g.pos, { bus: 'sfx' });
        } else g.pos.addScaledVector(g.vel, dt);
      }
      const gh = ctx.services.world.groundHeight(g.pos.x, g.pos.z, g.pos.y + 0.3);
      if (g.pos.y < gh + 0.04) { g.pos.y = gh + 0.04; if (g.vel.y < 0) g.vel.y *= -0.35; g.vel.x *= 0.7; g.vel.z *= 0.7; if (g.vel.lengthSq() < 0.2) g.rest = true; }
      g.obj.position.copy(g.pos);
      _e0.set(g.spin.x * dt, g.spin.y * dt, g.spin.z * dt);
      g.obj.quaternion.multiply(_q0.setFromEuler(_e0));
    }
  }

  function cycleFireMode() {
    const modes = cur.cfg.modes;
    const i = modes.indexOf(state.fireMode);
    state.fireMode = modes[(i + 1) % modes.length];
    applyFireModeVisual(false);
    events.emit('weapons:firemode', { weaponId: state.id, mode: state.fireMode });
    ctx.services.audio.play('fire_mode', { bus: 'sfx' });
  }
  function applyFireModeVisual() {
    const sel = cur?.parts.selector;
    if (!sel) return;
    sel.userData.target = state.fireMode === 'auto' ? -Math.PI : state.fireMode === 'semi' ? -Math.PI / 2 : 0;
  }

  function requestEquip(id) {
    if (!models[id] || (cur && cur.id === id && !pendingId)) return;
    if (state.reloading) cancelReload();
    stopClip();
    pendingId = id;
    holsterT = 0;
    state.action = 'equip';
  }

  // ------------------------------------------------------------------ firing
  function fire() {
    const c = cur.cfg;
    const loadout = getWeaponLoadout(state.id);
    const hasGrip = loadout.grip && loadout.grip !== 'none';
    state.ammo--;
    state.shotsFired++;
    state.lastShotTime = time.t;
    state.action = 'fire';
    cooldown += 60 / c.rpm;
    lastFireT = time.t;
    burstCount++;

    camera.getWorldPosition(origin);
    camera.getWorldDirection(dir);
    camera.getWorldQuaternion(_q0);
    camRight.set(1, 0, 0).applyQuaternion(_q0);
    camUp.set(0, 1, 0).applyQuaternion(_q0);
    // spread cone
    const sp = state.spread * 0.5 * DEG;
    const a = rng.next() * Math.PI * 2, r = Math.sqrt(rng.next()) * Math.tan(sp);
    dir.addScaledVector(camRight, Math.cos(a) * r).addScaledVector(camUp, Math.sin(a) * r).normalize();

    hitscanReq.range = c.range; hitscanReq.damage = c.damage; hitscanReq.weaponId = state.id;
    hitscanReq.team = ctx.services.gamemode.state?.playerTeam || 'player';
    hitscanReq.spread = state.spread; hitscanReq.penetration = c.penetration;
    ctx.services.combat.fireHitscan(hitscanReq);

    vfxReq.weaponId = state.id; vfxReq.object = cur.sockets.muzzle; vfxReq.ads = state.ads;
    ctx.services.vfx.spawn('muzzle_flash', vfxReq);
    vfxReq.object = cur.sockets.eject;
    ctx.services.vfx.spawn('shell_eject', vfxReq);
    ctx.services.audio.play(c.sound, { bus: 'sfx', pitch: 1 + (rng.next() - 0.5) * 0.04 });

    // camera recoil pattern
    const pat = c.pattern[(burstCount - 1) % c.pattern.length];
    const am = 1 - state.ads * (1 - c.camAdsMul);
    const recoilScale = hasGrip ? 0.82 : 1;
    const pitch = c.camPitch * pat[0] * am * recoilScale * DEG * (1 + (rng.next() - 0.5) * 0.15);
    const yaw = c.camYaw * pat[1] * am * recoilScale * DEG + (rng.next() - 0.5) * c.camYaw * recoilScale * 0.4 * DEG;
    ctx.services.player.applyRecoil(pitch, yaw); // player's camera rig owns the partial recovery

    // visual recoil
    const k = c.kick, km = 1 - state.ads * (1 - k.adsMul);
    kick.impulse(0, k.back * km * (0.9 + rng.next() * 0.2));
    kick.impulse(1, k.up * km);
    kick.impulse(2, k.pitch * km * (0.85 + rng.next() * 0.3));
    kick.impulse(3, k.yaw * km * (rng.next() - 0.5) * 2);
    kick.impulse(4, k.roll * km * ((rng.next() - 0.5) * 2 * 0.7 + pat[1] * 0.3));
    kick.impulse(5, (rng.next() - 0.5) * 0.06 * km);
    kickSlow.impulse(0, 0.12 * km);
    kickSlow.impulse(1, pat[1] * 0.04 * km);
    kickSlow.impulse(2, 0.03 * km);
    bloom = Math.min(c.bloomMax, bloom + c.bloomPerShot);
    boltBack = 1;
    slideT = 0;

    firedEvt.weaponId = state.id;
    firedEvt.time = time.t;
    events.emit('weapon:fired', firedEvt);
    if (state.ammo === 0) {
      boltLocked = true;
    }
  }

  // ------------------------------------------------------------------ update (logic)
  function update(dt) {
    if (!cur) return;
    const p = ctx.services.player.state;
    const c = cur.cfg;
    if (forced) { applyForced(dt); return; }

    // ---- sprint / tac sprint
    if (input.pressed('sprint')) {
      if (time.t - lastSprintPress < 0.3) tacLatched = true;
      lastSprintPress = time.t;
    }
    const sprinting = !!p.sprinting && !state.reloading;
    if (!p.sprinting) tacLatched = false;
    state.sprinting = !!p.sprinting;
    state.tacSprint = sprinting && tacLatched;
    if (p.sprinting && state.reloading && !clip?.data.pastSeat) cancelReload();
    if (sprinting) sprintOutT = 0.14; else sprintOutT = Math.max(0, sprintOutT - dt);

    // ---- weapon switching
    if (holsterT >= 0) {
      holsterT += dt;
      if (holsterT >= c.holsterTime) {
        holsterT = -1;
        selectModel(pendingId);
        pendingId = null;
        equipT = cur.cfg.equipTime;
        equipEvt.weaponId = state.id;
        events.emit('weapon:equip', equipEvt);
        ctx.services.audio.play(`${cur.cfg.kind}_equip`, { bus: 'sfx' });
      }
    } else if (equipT > 0) {
      equipT -= dt;
      if (equipT <= 0) { equipT = 0; state.action = 'idle'; }
    }
    if (canAct() || state.reloading || clip?.name === 'inspect') {
      const other = state.id === 'rifle' ? 'pistol' : 'rifle';
      if (input.pressed('swapWeapon') || input.pressed('weaponNext') || input.pressed('weaponPrev')) requestEquip(other);
      else if (input.pressed('weapon1') && state.id !== 'rifle') requestEquip('rifle');
      else if (input.pressed('weapon2') && state.id !== 'pistol') requestEquip('pistol');
    }

    // ---- ADS
    const toggle = ctx.settings.data.controls.toggleAds;
    let wantAds = toggle ? (input.pressed('ads') ? !(adsT > 0.5) : adsT > 0.5 && state.ads > 0) : input.isDown('ads');
    const blocked = sprinting || sprintOutT > 0.07 || (clip && !clip.data.allowAds) || holsterT >= 0 || equipT > cur.cfg.equipTime * 0.5;
    if (blocked) wantAds = false;
    adsT = Math.min(1, Math.max(0, adsT + (wantAds ? 1 : -1) * dt / c.adsTime));
    state.ads = smootherstep(adsT);

    // ---- inspect / fire mode (tap = fire mode, hold = inspect)
    if (input.isDown('inspect')) {
      inspectHold += dt;
      if (inspectHold > 0.32 && canAct() && !sprinting) { state.action = 'inspect'; state.inspecting = true; playClip('inspect', () => { state.inspecting = false; state.action = 'idle'; }); inspectHold = -99; }
    } else {
      if (inspectHold > 0 && inspectHold <= 0.32 && canAct() && cur.cfg.modes.length > 1) playClip('fireMode');
      inspectHold = 0;
    }

    // ---- reload
    if (input.pressed('reload') && (canAct() || clip?.name === 'inspect') && !sprinting) { stopClip(); state.inspecting = false; startReload(); }

    // ---- melee
    if (input.pressed('melee') && (canAct() || clip?.name === 'inspect' || state.reloading)) {
      if (state.reloading) cancelReload();
      stopClip();
      state.inspecting = false;
      state.action = 'melee';
      playClip('melee', () => { state.action = 'idle'; });
    }
    // ---- experimental grenade selector
    if (input.pressed('tactical')) {
      const grenadeTypes = getGrenadeTypes();
      const nextType = grenadeTypes[(grenadeTypes.indexOf(state.grenadeType) + 1) % grenadeTypes.length];
      state.grenadeType = setSelectedGrenade(nextType);
      events.emit('weapons:grenade', { phase: 'selected', type: state.grenadeType });
      ctx.services.hud.notify?.(`Experimental grenade: ${state.grenadeType}`, { kind: 'info', duration: 1.2 });
    }
    // ---- grenade
    // stabilize: a grenade press interrupts a reload (was silently swallowed while the reload clip played)
    if (input.pressed('grenade') && state.lethal > 0 && (canAct() || clip?.name === 'inspect' || (state.reloading && !clip?.data?.pastSeat))) {
      if (state.reloading) cancelReload();
      stopClip();
      state.lethal--;
      state.action = 'grenade';
      playClip('grenade', () => { state.action = 'idle'; });
    }

    // ---- fire
    cooldown = Math.max(cooldown - dt, -dt);
    const fireDown = input.isDown('fire');
    const firePressed = input.pressed('fire');
    const canFire = !sprinting && sprintOutT <= 0 && !state.reloading && (!clip || clip.name === 'inspect' || clip.name === 'fireMode') && holsterT < 0 && equipT <= cur.cfg.equipTime * 0.25;
    if (canFire && (fireDown || firePressed)) {
      if (clip && (clip.name === 'inspect' || clip.name === 'fireMode') && firePressed) { stopClip(); state.inspecting = false; }
      const auto = state.fireMode === 'auto';
      if ((auto ? fireDown : firePressed) && cooldown <= 0 && !clip) {
        if (state.ammo > 0) {
          if (cooldown < -dt) cooldown = 0;
          fire();
        } else if (firePressed) {
          emptyEvt.weaponId = state.id;
          events.emit('weapon:empty', emptyEvt);
          ctx.services.audio.play('dry_fire', { bus: 'sfx' });
          if (state.reserve > 0) startReload();
        }
      }
    }
    if (!fireDown) burstCount = 0;
    if (state.action === 'fire' && time.t - lastFireT > 0.12) state.action = 'idle';
    if (!clip && !state.reloading && holsterT < 0 && equipT <= 0 && state.action !== 'fire') state.action = sprinting ? 'sprint' : 'idle';
    if (state.ammo === 0 && state.reserve > 0 && !state.reloading && canAct() && time.t - lastFireT > 0.25 && !sprinting && fireHeldPrev && !fireDown) startReload();
    fireHeldPrev = fireDown;

    // ---- spread
    const moveF = Math.min(1, p.speed / 4.4);
    bloom = Math.max(0, bloom - c.bloomRecover * dt * (time.t - lastFireT > 0.1 ? 1 : 0.2));
    const base = c.spreadHip + (c.spreadAds - c.spreadHip) * state.ads;
    const loadout = getWeaponLoadout(state.id);
    const hasOptic = loadout.optic && loadout.optic !== 'none';
    const opticScale = hasOptic ? 0.85 : 1;
    state.spread = (base + c.spreadMove * moveF * (1 - state.ads * 0.8) + bloom * (1 - state.ads * 0.75) + (p.grounded ? 0 : 2.5)) * (1 - state.ads * (1 - opticScale));
    ctx.services.hud.setCrosshairSpread?.(state.spread);

    updateClip(dt);
    updateDropMags(dt);
    updateGrenades(dt);

    // services
    const zoom = 1 + (c.adsZoom - 1) * state.ads;
    ctx.services.player.setZoom(zoom);
    ctx.services.postfx.setADS(state.ads);
  }

  // ------------------------------------------------------------------ forced shot poses
  function applyForced(dt) {
    const s = forced.state;
    const pr = forced.progress ?? 0;
    state.sprinting = s === 'sprint' || s === 'tacsprint';
    state.tacSprint = s === 'tacsprint';
    adsT = s === 'ads' ? 1 : 0;
    state.ads = adsT;
    state.reloading = s === 'reload' || s === 'reloadEmpty';
    state.action = s === 'hip' || s === 'ads' ? 'idle' : s;
    const clipName = { reload: 'reload', reloadEmpty: 'reloadEmpty', inspect: 'inspect', melee: 'melee', grenade: 'grenade', fireMode: 'fireMode', equip: null }[s];
    if (clipName && cur.clips[clipName]) {
      if (!clip || clip.name !== clipName) { playClip(clipName); }
      // replay events up to the progress point deterministically
      const target = pr * clip.data.dur;
      if (clipT > target + 1e-6) { stopClip(); playClip(clipName); }
      updateClip(Math.max(0, target - clipT));
      if (clip) clipT = target;
      state.reloadProgress = state.reloading ? pr : 0;
    }
    if (s === 'equip') equipT = cur.cfg.equipTime * (1 - pr);
    if (s === 'fire') {
      // steady fire at the weapon's cadence
      cooldown -= dt;
      if (cooldown <= 0 && state.ammo > 0) fire();
    }
    ctx.services.player.setZoom(1 + (cur.cfg.adsZoom - 1) * state.ads);
    ctx.services.postfx.setADS(state.ads);
  }

  // ------------------------------------------------------------------ lateUpdate (pose)
  const P = { pos: new THREE.Vector3(), rot: new THREE.Vector3() }; // accumulated offsets (m, rad)
  const basePos = new THREE.Vector3(), baseRot = new THREE.Vector3();
  const tmpPos = new THREE.Vector3(), tmpRot = new THREE.Vector3();
  const adsPos = new THREE.Vector3();
  const pivot = new THREE.Vector3();

  function lerpPoseTo(outPos, outRot, pose, w) {
    if (w <= 0) return;
    outPos.x += (pose.pos[0] - outPos.x) * w; outPos.y += (pose.pos[1] - outPos.y) * w; outPos.z += (pose.pos[2] - outPos.z) * w;
    outRot.x += (pose.rot[0] * DEG - outRot.x) * w; outRot.y += (pose.rot[1] * DEG - outRot.y) * w; outRot.z += (pose.rot[2] * DEG - outRot.z) * w;
  }

  function lateUpdate(dt) {
    if (!cur) return;
    const c = cur.cfg;
    const p = ctx.services.player.state;
    const t = time.t;

    // ---------------- viewmodel FOV / scale
    // Preferred: postfx renders the viewmodel pass with its own projection (true perspective at the
    // viewmodel FOV). Fallback (postfx down): squash the rig in x/y so it projects as if at that FOV.
    const vmH = VM.fovHip + (VM.fovAds - VM.fovHip) * state.ads;
    const vmVdeg = settingsFovToVfov(vmH);
    const pfx = ctx.services.postfx;
    const s = display || dev.orbit ? 1 : VM.scale;
    if (display || dev.orbit) {
      vmRoot.scale.set(s, s, s);
      pfx.setViewmodelFov?.(null);
    } else if (pfx.isFastRenderMode?.()) {
      // The single-pass renderer uses the player camera FOV, so scale the rig to preserve its
      // authored hip/ADS viewmodel FOV without a dedicated viewmodel render pass.
      const k = Math.tan(camera.fov * DEG / 2) / Math.tan(vmVdeg * DEG / 2);
      pfx.setViewmodelFov?.(null);
      vmRoot.scale.set(s * k, s * k, s * k);
    } else if (typeof pfx.setViewmodelFov === 'function') {
      pfx.setViewmodelFov(vmVdeg);
      vmRoot.scale.set(s, s, s);
    } else {
      const k = Math.tan(camera.fov * DEG / 2) / Math.tan(vmVdeg * DEG / 2);
      vmRoot.scale.set(s * k, s * k, s);
    }

    // ---------------- weights
    const sprintTarget = state.sprinting && !state.reloading && !clip ? 1 : 0;
    sprintW = damp(sprintW, sprintTarget, sprintTarget ? 9 : 12, dt);
    tacW = damp(tacW, state.tacSprint && sprintTarget ? 1 : 0, 8, dt);
    let lowT = 0;
    if (holsterT >= 0) lowT = smootherstep(holsterT / c.holsterTime);
    else if (equipT > 0) lowT = 1 - smootherstep(1 - equipT / c.equipTime);
    lowerW = lowT;

    // ---------------- base pose (hip -> ads -> sprint -> lowered)
    basePos.fromArray(c.hip.pos);
    baseRot.set(c.hip.rot[0] * DEG, c.hip.rot[1] * DEG, c.hip.rot[2] * DEG);
    // ADS: sight rear window centered on the camera axis at eye relief
    const sc = cur.sockets.sight.position;
    adsPos.set(-sc.x, -sc.y, -c.eyeRelief - sc.z);
    // ADS path: come in along a slight arc (drop a bit mid-way) for weight
    const a = state.ads;
    basePos.lerp(adsPos, a);
    basePos.y -= Math.sin(a * Math.PI) * 0.012;
    baseRot.multiplyScalar(1 - a);
    baseRot.z += Math.sin(a * Math.PI) * -4 * DEG;
    lerpPoseTo(basePos, baseRot, c.sprint, sprintW * (1 - tacW));
    lerpPoseTo(basePos, baseRot, c.tac, sprintW * tacW);
    lerpPoseTo(basePos, baseRot, c.lowered, lowerW);

    // ---------------- procedural: look sway
    const lookDx = forced ? 0 : input.look.dx, lookDy = forced ? 0 : input.look.dy;
    let dYaw = 0, dPitch = 0;
    if (!firstFrame) { dYaw = p.yaw - prevYaw; dPitch = p.pitch - prevPitch; }
    firstFrame = false;
    prevYaw = p.yaw; prevPitch = p.pitch;
    void lookDx; void lookDy;
    const invDt = dt > 0 ? 1 / dt : 0;
    const yawVel = THREE.MathUtils.clamp(dYaw * invDt, -8, 8), pitchVel = THREE.MathUtils.clamp(dPitch * invDt, -8, 8);
    const swayMul = 1 - state.ads * 0.75;
    sway.target[0] = -yawVel * -0.0045 * swayMul;   // lag: turning left (yaw+) -> gun drifts right
    sway.target[1] = -pitchVel * 0.0035 * swayMul;
    sway.target[2] = -pitchVel * 0.03 * swayMul;
    sway.target[3] = yawVel * 0.035 * swayMul;
    sway.target[4] = yawVel * 0.05 * swayMul;
    sway.update(dt);

    // ---------------- movement bob / inertia
    const moving = p.grounded && p.speed > 0.3;
    const spd = Math.min(1.6, p.speed / 4.4);
    bobAmt = damp(bobAmt, moving ? spd : 0, 8, dt);
    const freq = state.sprinting ? 1.45 : 1.0;
    bobPhase += dt * (p.speed / 2.0) * Math.PI * freq;
    const bm = bobAmt * (1 - state.ads * 0.82) * (1 + sprintW * 0.8);
    const bx = Math.sin(bobPhase) * 0.0085 * bm;
    const by = -Math.abs(Math.cos(bobPhase)) * 0.0085 * bm + 0.004 * bm;
    const brz = Math.sin(bobPhase) * 1.8 * DEG * bm;
    const brx = Math.cos(bobPhase * 2) * 0.8 * DEG * bm;
    // idle breathing + slow drift
    const idleM = (1 - bobAmt * 0.6) * (1 - state.ads * 0.7);
    const bry = Math.sin(t * 1.15) * 0.0012 * idleM + (noise1(t * 0.35, 1) - 0.5) * 0.002 * idleM;
    const brxI = Math.sin(t * 1.15 + 0.6) * 0.35 * DEG * idleM + (noise1(t * 0.3, 2) - 0.5) * 0.6 * DEG * idleM;
    const bryI = (noise1(t * 0.25, 3) - 0.5) * 0.8 * DEG * idleM;
    // strafe/forward inertia (camera-relative player velocity)
    const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
    const vRight = p.velocity.x * cy - p.velocity.z * sy;
    const vFwd = -p.velocity.x * sy - p.velocity.z * cy;
    const strafe = THREE.MathUtils.clamp(vRight / 4.4, -1.5, 1.5) * (1 - state.ads * 0.7);
    const fwd = THREE.MathUtils.clamp(vFwd / 4.4, -1.5, 1.5) * (1 - state.ads * 0.7);
    // air / landing
    bump.target[0] = p.grounded ? 0 : THREE.MathUtils.clamp(-p.velocity.y * 0.004, -0.012, 0.012);
    bump.target[1] = p.grounded ? 0 : THREE.MathUtils.clamp(-p.velocity.y * 0.6 * DEG, -3 * DEG, 3 * DEG);
    if (landImpulse) { bump.impulse(0, -landImpulse * 0.06); bump.impulse(1, -landImpulse * 0.5); landImpulse = 0; }
    bump.update(dt);

    kick.update(dt);
    kickSlow.target[0] = 0; kickSlow.update(dt);

    // ---------------- total procedural offsets (around the pivot, gun space)
    P.pos.set(
      sway.x[0] + bx - strafe * 0.006 + kick.x[5],
      sway.x[1] + by + bry + bump.x[0] + kick.x[1] - Math.abs(fwd) * 0.002,
      kick.x[0] + kickSlow.x[2] + fwd * 0.004,
    );
    P.rot.set(
      sway.x[2] + brx + brxI + bump.x[1] + kick.x[2] + kickSlow.x[0],
      sway.x[3] + bryI + kick.x[3] + kickSlow.x[1] - strafe * 1.2 * DEG,
      sway.x[4] + brz + kick.x[4] - strafe * 3.5 * DEG,
    );

    // ---------------- compose gun matrix: base * pivot * proc * clip * -pivot
    pivot.fromArray(c.pivot);
    _m0.compose(basePos, _q0.setFromEuler(_e0.set(baseRot.x, baseRot.y, baseRot.z, 'YXZ')), _s1);
    _m1.makeTranslation(pivot.x, pivot.y, pivot.z);
    _m0.multiply(_m1);
    _m2.compose(P.pos, _q1.setFromEuler(_e0.set(P.rot.x, P.rot.y, P.rot.z, 'YXZ')), _s1);
    _m0.multiply(_m2);
    // clip offset (gun keyframes)
    let lhW = 0, rhW = 0;
    if (clip) {
      const cd = clip.data;
      if (cd.gun) {
        cd.gun.sample(clipT, clipOut);
        _m2.compose(_v0.set(clipOut[0], clipOut[1], clipOut[2]), _q1.setFromEuler(_e0.set(clipOut[3] * DEG, clipOut[4] * DEG, clipOut[5] * DEG, 'YXZ')), _s1);
        _m0.multiply(_m2);
      }
    }
    _m1.makeTranslation(-pivot.x, -pivot.y, -pivot.z);
    _m0.multiply(_m1);
    gunMat.copy(_m0);
    gunMat.decompose(gunPivot.position, gunPivot.quaternion, gunPivot.scale);
    // ADS depth squash (viewmodel trick): compress the gun along its bore axis around the rear sight window
    // while aimed, so the holo hood reads as a short open window instead of a long tunnel. Looking straight
    // down the axis the silhouette is unchanged; hand targets are squashed identically (handTarget).
    squashZ = display || dev.orbit ? 1 : 1 - (c.adsSquash || 0) * smootherstep(state.ads);
    squashZ0 = cur.sockets.sight.position.z;
    if (squashZ < 1) {
      gunPivot.scale.z = squashZ;
      _v0.set(0, 0, squashZ0 * (1 - squashZ)).applyQuaternion(gunPivot.quaternion);
      gunPivot.position.add(_v0);
    }

    // ---------------- moving parts
    updateParts(dt);

    // ---------------- hands
    // right hand: grip (gun space) -> viewmodel space
    handTarget(cur.gripR, handPosR, handQR);
    // left hand: grip, or clip-driven target (gun space)
    handTarget(cur.gripL, handPosL, handQL);
    if (clip && clip.data.lh) {
      lhW = clip.data.lhW ? clip.data.lhW.sample(clipT, clipOut)[0] : 1;
      if (lhW > 0) {
        clip.data.lh.sample(clipT, clipPos, clipQ);
        _v0.copy(clipPos).applyMatrix4(gunMat);
        _q2.setFromRotationMatrix(gunMat).multiply(clipQ);
        handPosL.lerp(_v0, lhW);
        handQL.slerp(_q2, lhW);
      }
    }
    if (clip && clip.data.rh) {
      rhW = clip.data.rhW ? clip.data.rhW.sample(clipT, clipOut)[0] : 1;
      if (rhW > 0) {
        clip.data.rh.sample(clipT, clipPos, clipQ);
        _v0.copy(clipPos).applyMatrix4(gunMat);
        _q2.setFromRotationMatrix(gunMat).multiply(clipQ);
        handPosR.lerp(_v0, rhW);
        handQR.slerp(_q2, rhW);
      }
    }
    // finger poses
    const trig = state.action === 'fire' || (forced?.state === 'fire') ? 1 : 0;
    triggerPull = damp(triggerPull, trig, 30, dt);
    const safeW = Math.max(sprintW, lowerW, state.reloading ? 1 : 0, clip && clip.name !== 'fireMode' ? 0.8 : 0);
    const rBase = POSES[c.poseR] || POSES.gripTrigger;
    lerpPose(poseR, rBase, POSES.gripTriggerPull, triggerPull * (1 - safeW));
    lerpPose(poseR, poseR, POSES.gripIndexOut, safeW * 0.9);
    copyPose(poseL, POSES[c.poseL] || POSES.gripVert);
    if (clip) {
      if (clip.data.lhPose) {
        const r = clip.data.lhPose.sample(clipT);
        lerpPose(poseTmp, POSES[r.a], POSES[r.b], r.w);
        copyPose(poseL, poseTmp);
      }
      if (clip.data.rhPose) {
        const r = clip.data.rhPose.sample(clipT);
        lerpPose(poseTmp, POSES[r.a], POSES[r.b], r.w);
        copyPose(poseR, poseTmp);
      }
    }
    if (dev.poseR) copyPose(poseR, dev.poseR);
    if (dev.poseL) copyPose(poseL, dev.poseL);
    armR.solve(shoulderR, handPosR, handQR, poleR);
    armL.solve(shoulderL, handPosL, handQL, poleL);
    // fingers: close toward the pose targets, stopping on the weapon's grasp colliders
    armR.grasp(poseR, colBufR, fillColliders(cur.colR, colBufR, dev.noGrasp ? 0 : 1 - rhW * 0.0));
    armL.grasp(poseL, colBufL, fillColliders(cur.colL, colBufL, dev.noGrasp ? 0 : 1));

    // ---------------- dev orbit camera (bench tool): look at the rig from outside
    if (dev.backdrop && !backdrop) {
      backdrop = new THREE.Mesh(new THREE.SphereGeometry(4, 32, 16), new THREE.MeshStandardMaterial({ color: 0x5a5c5e, roughness: 0.9, side: THREE.BackSide }));
      backdrop.layers.set(LAYER); backdrop.frustumCulled = false; camera.add(backdrop);
    }
    if (backdrop) backdrop.visible = !!dev.backdrop;
    if (dev.orbit) applyOrbit();
    else if (!vmRoot.matrixAutoUpdate) vmRoot.matrixAutoUpdate = true;

    // ---------------- reticle basis (view space) for the parallax-free holo reticle
    updateReticle();
  }

  const _up = new THREE.Vector3(0, 1, 0);
  let backdrop = null;
  function applyOrbit() {
    const o = dev.orbit;
    camera.updateMatrixWorld(true);
    _m0.copy(camera.matrixWorld);
    const tgt = _v0.fromArray(o.target || [0.05, -0.06, -0.2]);
    const yaw = (o.yaw || 0) * DEG, pitch = (o.pitch || 0) * DEG;
    const eye = _v1.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(o.dist ?? 0.5).add(tgt);
    _m1.lookAt(eye, tgt, _up).setPosition(eye);
    _m2.multiplyMatrices(_m0, _m1);
    _m2.decompose(camera.position, camera.quaternion, _v2);
    vmRoot.updateMatrix();
    _m3.copy(_m1).invert().multiply(vmRoot.matrix);
    vmRoot.matrixAutoUpdate = false;
    vmRoot.matrix.copy(_m3);
    const vf = settingsFovToVfov(o.hfov || 50);
    if (camera.fov !== vf || camera.near !== 0.01) { camera.fov = vf; camera.near = 0.01; camera.updateProjectionMatrix(); }
    camera.updateMatrixWorld(true);
  }

  const colBufR = [], colBufL = [];
  for (let i = 0; i < 12; i++) { colBufR.push({ a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0, mask: 0 }); colBufL.push({ a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0, mask: 0 }); }
  /** gun-space collider defs -> rig (viewmodel) space capsules. Returns the count. */
  function fillColliders(defs, out, on) {
    if (!on) return 0;
    let n = 0;
    for (const d of defs) {
      if (n >= out.length) break;
      const o = out[n++];
      o.r = d.r; o.mask = d.mask;
      o.a.copy(d.a); o.b.copy(d.b);
      const part = d.part ? cur.parts[d.part] : null;
      if (part) {
        part.updateMatrix();
        o.a.sub(part.position).applyMatrix4(part.matrix);
        o.b.sub(part.position).applyMatrix4(part.matrix);
      }
      o.a.applyMatrix4(gunMat); o.b.applyMatrix4(gunMat);
    }
    return n;
  }

  let squashZ = 1, squashZ0 = 0;
  function handTarget(grip, outPos, outQ) {
    outPos.copy(grip.pos);
    if (squashZ < 1) outPos.z = squashZ0 + (outPos.z - squashZ0) * squashZ;
    outPos.applyMatrix4(gunMat);
    outQ.setFromRotationMatrix(gunMat).multiply(grip.quat);
  }

  const _axis = new THREE.Vector3();
  function updateReticle() {
    const pane = cur.parts.reticlePane;
    if (!pane) return;
    const u = pane.material.userData.wpnUniforms;
    if (!u) return;
    // gun axes in view space: modelView of the gun root
    cur.root.updateWorldMatrix(true, false);
    const cam = display ? camera : camera;
    _m0.multiplyMatrices(cam.matrixWorldInverse, cur.root.matrixWorld);
    u.uAxis.value.set(0, 0, -1).transformDirection(_m0);
    u.uRight.value.set(1, 0, 0).transformDirection(_m0);
    u.uUp.value.set(0, 1, 0).transformDirection(_m0);
    void _axis;
  }

  function updateParts(dt) {
    const parts = cur.parts;
    // trigger
    if (parts.trigger) parts.trigger.rotation.x = -triggerPull * 12 * DEG;
    // selector
    if (parts.selector) {
      const tgt = parts.selector.userData.target ?? 0;
      parts.selector.rotation.x = damp(parts.selector.rotation.x, tgt, 25, dt);
    }
    // bolt carrier cycles back and returns
    boltBack = Math.max(0, boltBack - dt / 0.045);
    if (parts.bolt) parts.bolt.position.z = boltLocked ? 0.072 : Math.sin(Math.min(1, boltBack) * Math.PI * 0.5) * 0.072;
    if (parts.boltCatch) parts.boltCatch.rotation.x = boltLocked ? 6 * DEG : 0;
    if (parts.charge) parts.charge.position.z = parts.charge.userData.home ?? parts.charge.position.z;
    // pistol slide
    if (parts.slide) {
      slideT = Math.min(1, slideT + dt / 0.07);
      const back = boltLocked ? 1 : Math.sin(slideT * Math.PI);
      parts.slide.position.z = (parts.slide.userData.homeZ ?? 0) + back * 0.028;
    }
  }

  // ------------------------------------------------------------------ system
  function onLand(e) { landImpulse = Math.min(1.5, (e?.speed || 4) / 6); }

  const api = {
    state,
    viewmodel: vmRoot,
    list: () => Object.keys(models).map((id) => ({ id, name: models[id].cfg.name })),
    equip(id) { requestEquip(id); },
    setPose(s, progress = 0) { forced = s ? { state: s, progress } : null; if (!s) stopClip(); },
    // extensions (optional-chain from other systems)
    sockets: () => cur?.sockets || null,
    getMuzzleWorldPosition(out = new THREE.Vector3()) { return cur ? cur.sockets.muzzle.getWorldPosition(out) : out; },
    getEjectWorldPosition(out = new THREE.Vector3()) { return cur ? cur.sockets.eject.getWorldPosition(out) : out; },
    cycleFireMode: () => cycleFireMode(),
    reload: () => startReload(),
    addAmmo(n) { state.reserve = Math.min(cur.cfg.reserveMax, state.reserve + n); },
    addGrenades(n = 1) { state.lethal = Math.min(4, state.lethal + n); },
    _dev: dev,
  };

  return {
    name: 'weapons',
    async init() {
      await ctx.services.materials.ready;
      const tex = await loadTextures();
      mats = createMaterials(tex, ctx.services);
      build();
      const sw = ctx.shot?.weapon;
      const startId = sw?.id && models[sw.id] ? sw.id : 'rifle';
      selectModel(startId);
      equipT = 0;
      state.action = 'idle';
      if (sw?.state) forced = { state: sw.state, progress: sw.progress ?? 0 };
      const d = ctx.shot?.weaponsDisplay;
      if (d) {
        display = new THREE.Group();
        display.name = 'weaponsDisplay';
        display.position.fromArray(d.position || [0, 1.5, 0]);
        if (d.rotation) display.rotation.set(d.rotation[0] * DEG, d.rotation[1] * DEG, d.rotation[2] * DEG);
        ctx.scene.add(display);
        if (d.arms === false) {
          // show only the weapon at the display origin
          display.add(cur.root);
          cur.root.position.set(0, 0, 0);
          armR.group.visible = false; armL.group.visible = false;
          display.userData.gunOnly = true;
        } else {
          display.add(vmRoot);
        }
      } else {
        camera.add(vmRoot);
      }
      events.on('player:land', onLand);
      events.on('gamemode:start', refillLoadout);
      events.on('gamemode:respawn', refillLoadout);
      ctx.services.provide('weapons', api);
      equipEvt.weaponId = state.id;
      events.emit('weapon:equip', equipEvt);
    },
    update(dt) {
      update(dt);
    },
    lateUpdate(dt) {
      if (display?.userData.gunOnly) { updateParts(dt); updateReticle(); return; }
      lateUpdate(dt);
    },
    dispose() {
      events.off('player:land', onLand);
      events.off('gamemode:start', refillLoadout);
      events.off('gamemode:respawn', refillLoadout);
      vmRoot.removeFromParent();
      display?.removeFromParent();
      for (const g of grenades) g.obj.removeFromParent();
      for (const id in models) for (const d of models[id].dropMags) d.obj.removeFromParent();
      for (const g of disposables) g.dispose?.();
      armR?.dispose(); armL?.dispose();
      if (mats) disposeMaterials(mats);
    },
  };
}

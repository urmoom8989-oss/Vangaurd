import * as THREE from 'three';
import { Capsule } from 'three/examples/jsm/math/Capsule.js';
import { GRENADE, SURFACE_BALLISTICS, ballisticSurface } from './tables.js';
import { buildGrenadeAssets } from './grenadeModel.js';

/**
 * Frag grenades: cook/throw input, deterministic rigid-sphere integrator against world colliders
 * (swept ray + capsule depenetration via services.world), per-surface restitution/friction/rolling
 * resistance, spin, safety-lever (spoon) fly-off, fuse -> explosion.
 *
 * API (merged into services.combat):
 *   throwGrenade({ origin, velocity, fuse?, source?, team?, type?, spin? }) -> Grenade
 *   throwGrenadeAt({ from, target, source?, speed?, lob? }) -> Grenade | null  (ballistic solve, for AI)
 *   solveThrow(from, target, speed, lob?, out) -> Vector3 | null
 *   cookGrenade() / releaseGrenade() / cancelGrenade()
 *   grenades: live Grenade[] ({ id, position, velocity, fuseLeft, source, resting, object })
 *   grenade: { count, max, cooking, cookTime, fuse, lastThrow, inputEnabled }
 *   setGrenadeInputEnabled(bool), addGrenades(n), createGrenadeMesh({pin, spoon}) -> Object3D (caller owns the Group)
 */
const G = 9.81;
const SPOON_POOL = 6;
const VIS = GRENADE.visualScale ?? 1;

export function createGrenades(ctx, hooks) {
  const assets = { current: null };
  const grenades = [];
  const pool = [];
  const spoons = [];
  let nextId = 1;
  const root = new THREE.Group();
  root.name = 'combat_grenades';

  const state = { count: GRENADE.maxCarried, max: GRENADE.maxCarried, cooking: false, cookTime: 0, fuse: GRENADE.fuse, lastThrow: -1, inputEnabled: true, pendingThrow: -1, inputMode: 'auto', weaponsOwnsLethal: false };
  let cookStart = 0;
  let throwAt = -1;
  let throwFuse = GRENADE.fuse;
  let inputCook = false;

  // temps
  const _v = new THREE.Vector3();
  const _d = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const _t = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _axis = new THREE.Vector3();
  const _down = new THREE.Vector3(0, -1, 0);
  const _o = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const _fwd = new THREE.Vector3();
  const capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(), GRENADE.radius);
  const bounceEvt = { position: new THREE.Vector3(), normal: new THREE.Vector3(), surface: 'default', speed: 0, grenade: null };
  const dustParams = { position: new THREE.Vector3(), normal: new THREE.Vector3(), surface: 'default', scale: 0.5 };
  const grenEvt = { phase: 'cook', grenade: null, cookTime: 0, fuse: 0, source: null, position: new THREE.Vector3() };

  function ensureAssets() {
    if (!assets.current) assets.current = buildGrenadeAssets(ctx);
    return assets.current;
  }

  function acquire() {
    let g = pool.pop();
    if (!g) {
      const a = ensureAssets();
      g = {
        id: 0, active: false, object: a.makeGrenade({ pin: false, spoon: false }),
        position: new THREE.Vector3(), prev: new THREE.Vector3(), velocity: new THREE.Vector3(),
        quat: new THREE.Quaternion(), prevQuat: new THREE.Quaternion(), spin: new THREE.Vector3(),
        fuseLeft: 0, age: 0, source: 'unknown', team: null, type: 'frag', resting: false, grounded: false,
        groundNormal: new THREE.Vector3(0, 1, 0), surface: 'default', bounces: 0, lastBounce: -1, wobble: 0,
        path: null,
      };
      // readability: in-world frags are drawn a little larger than life (the collision sphere is not)
      g.object.scale.setScalar(VIS);
    }
    return g;
  }

  // ---------------------------------------------------------------- spawning
  function throwGrenade(opts = {}) {
    if (!opts.origin) return null;
    const g = acquire();
    g.id = nextId++;
    g.active = true;
    g.position.copy(opts.origin);
    g.prev.copy(opts.origin);
    g.velocity.copy(opts.velocity || _v.set(0, 0, 0));
    g.fuseLeft = opts.fuse ?? GRENADE.fuse;
    g.age = 0;
    g.source = opts.source ?? 'unknown';
    g.team = opts.team ?? null;
    g.type = opts.type ?? 'frag';
    g.resting = false;
    g.grounded = false;
    g.bounces = 0;
    g.lastBounce = -1;
    g.surface = 'default';
    g.path = opts.recordPath ? [] : null;
    // initial orientation: fuse up-ish, tilted forward; tumble end-over-end about the throw's right axis
    _fwd.copy(g.velocity);
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    _right.crossVectors(_fwd, _up);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    g.quat.setFromAxisAngle(_right, -0.6);
    g.prevQuat.copy(g.quat);
    if (opts.spin) g.spin.copy(opts.spin);
    else g.spin.copy(_right).multiplyScalar(-(opts.spinRate ?? 11)).addScaledVector(_fwd, 1.6);
    g.wobble = 0;
    g.object.position.copy(g.position);
    g.object.quaternion.copy(g.quat);
    g.object.visible = true;
    root.add(g.object);
    grenades.push(g);
    if (opts.spoon !== false) spawnSpoon(g);
    grenEvt.phase = 'thrown'; grenEvt.grenade = g; grenEvt.cookTime = (opts.cookTime ?? 0); grenEvt.fuse = g.fuseLeft;
    grenEvt.source = g.source; grenEvt.position.copy(g.position);
    ctx.events.emit('combat:grenade', grenEvt);
    return g;
  }

  /** Ballistic launch velocity (no drag) from `from` to hit `target` with speed `speed`. lob=true picks the high arc. */
  function solveThrow(from, target, speed = GRENADE.throwSpeed, lob = false, out = new THREE.Vector3()) {
    _d.copy(target).sub(from);
    const y = _d.y;
    const xz = Math.hypot(_d.x, _d.z);
    const v2 = speed * speed;
    const disc = v2 * v2 - G * (G * xz * xz + 2 * y * v2);
    if (disc < 0 || xz < 1e-4) return null;
    const root2 = Math.sqrt(disc);
    const ang = Math.atan((v2 + (lob ? root2 : -root2)) / (G * xz));
    const c = Math.cos(ang);
    out.set((_d.x / xz) * speed * c, speed * Math.sin(ang), (_d.z / xz) * speed * c);
    return out;
  }

  function throwGrenadeAt({ from, target, source = 'unknown', speed = 13, lob = false, fuse, team } = {}) {
    if (!from || !target) return null;
    const vel = solveThrow(from, target, speed, lob, new THREE.Vector3());
    if (!vel) return null;
    // compensate a little for drag over long throws
    vel.multiplyScalar(1 + Math.min(0.08, from.distanceTo(target) * 0.0022));
    return throwGrenade({ origin: from, velocity: vel, source, fuse, team });
  }

  // ---------------------------------------------------------------- spoon debris (visual only)
  function spawnSpoon(g) {
    const a = ensureAssets();
    let s = null;
    for (const sp of spoons) if (!sp.active) { s = sp; break; }
    if (!s) {
      if (spoons.length >= SPOON_POOL) s = spoons.reduce((o, x) => (x.age > o.age ? x : o), spoons[0]);
      else {
        s = { active: false, object: a.makeSpoon(), pos: new THREE.Vector3(), vel: new THREE.Vector3(), quat: new THREE.Quaternion(), spin: new THREE.Vector3(), age: 0, resting: false };
        spoons.push(s);
      }
    }
    s.active = true;
    s.age = 0;
    s.resting = false;
    s.pos.copy(g.position).add(_t.set(0, 0.03, 0));
    // pops off sideways + up relative to the throw
    _fwd.copy(g.velocity).normalize();
    _right.crossVectors(_fwd, _up).normalize();
    s.vel.copy(g.velocity).multiplyScalar(0.55).addScaledVector(_right, 2.4).addScaledVector(_up, 2.2);
    s.quat.copy(g.quat);
    s.spin.set(24, 9, -15);
    s.object.position.copy(s.pos);
    s.object.quaternion.copy(s.quat);
    s.object.visible = true;
    root.add(s.object);
  }

  function stepSpoons(dt) {
    const world = ctx.services.world;
    for (const s of spoons) {
      if (!s.active) continue;
      s.age += dt;
      if (s.age > 8) { s.active = false; s.object.visible = false; root.remove(s.object); continue; }
      if (s.resting) continue;
      s.vel.y -= G * dt;
      s.vel.multiplyScalar(1 / (1 + 0.9 * dt)); // flat plate: lots of drag
      const len = s.vel.length() * dt;
      if (len > 1e-5) {
        _d.copy(s.vel).normalize();
        const h = world.raycast(s.pos, _d, len + 0.004);
        if (h) {
          s.pos.copy(h.point).addScaledVector(h.normal, 0.003);
          const vn = s.vel.dot(h.normal);
          s.vel.addScaledVector(h.normal, -1.35 * vn).multiplyScalar(0.45);
          s.spin.multiplyScalar(0.5);
          if (s.vel.length() < 0.35 && h.normal.y > 0.6) {
            s.resting = true;
            // settle flat on the ground plane
            _q.setFromUnitVectors(_up, h.normal);
            s.quat.setFromAxisAngle(_up, s.age * 3.1).premultiply(_q);
            s.quat.multiply(_q.setFromAxisAngle(_t.set(0, 0, 1), Math.PI / 2));
          }
        } else s.pos.addScaledVector(s.vel, dt);
      }
      if (!s.resting) {
        const w = s.spin.length();
        if (w > 1e-4) { _q.setFromAxisAngle(_axis.copy(s.spin).multiplyScalar(1 / w), w * dt); s.quat.premultiply(_q); }
      }
      s.object.position.copy(s.pos);
      s.object.quaternion.copy(s.quat);
    }
  }

  // ---------------------------------------------------------------- physics
  function surfaceSpec(hit) {
    return SURFACE_BALLISTICS[ballisticSurface(hit.surface, hit.material)] || SURFACE_BALLISTICS.default;
  }

  function contact(g, hit, normal) {
    const spec = surfaceSpec(hit);
    const vn = g.velocity.dot(normal);
    if (vn >= 0) return;
    const speedN = -vn;
    // soft impacts bounce less (plastic deformation of dirt, damping of the body)
    const e = spec.bounce * smooth01((speedN - 0.25) / 2.2);
    _t.copy(g.velocity).addScaledVector(normal, -vn); // tangential
    const vt = _t.length();
    // Coulomb friction, but a frag is not a ball: on a real impact the fuse/lever catch and it tumbles,
    // shedding a fixed share of its tangential speed (keeps throws landing near where they were aimed)
    const tumble = speedN > 0.8 ? GRENADE.impactTangentLoss * (0.6 + 0.4 * spec.friction / 0.35) : 0;
    const jt = Math.min(vt, Math.max(spec.friction * (1 + e) * speedN, vt * tumble));
    if (vt > 1e-6) _t.multiplyScalar((vt - jt) / vt);
    g.velocity.copy(_t).addScaledVector(normal, e * speedN);
    // spin: rolling contact wants w = n x v / r ; blend toward it on impact
    _axis.crossVectors(normal, _t).multiplyScalar(1 / GRENADE.radius);
    g.spin.lerp(_axis, 0.55);
    g.surface = hit.surface || 'default';
    g.bounces++;
    if (speedN > 0.6 && g.age - g.lastBounce > 0.05) {
      g.lastBounce = g.age;
      bounceEvt.position.copy(g.position); bounceEvt.normal.copy(normal); bounceEvt.surface = g.surface;
      bounceEvt.speed = speedN; bounceEvt.grenade = g;
      ctx.events.emit('combat:grenade-bounce', bounceEvt);
      dustParams.position.copy(g.position); dustParams.normal.copy(normal); dustParams.surface = g.surface;
      dustParams.scale = 0.25 + Math.min(0.5, speedN / 14);
      ctx.services.vfx.spawn('dust', dustParams);
    }
  }

  function smooth01(x) { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); }

  function stepGrenade(g, dt) {
    const world = ctx.services.world;
    const r = GRENADE.radius;
    g.prev.copy(g.position);
    g.prevQuat.copy(g.quat);
    g.age += dt;
    g.fuseLeft -= dt;

    if (!g.resting) {
      g.velocity.y -= G * dt;
      const sp = g.velocity.length();
      if (!g.grounded && sp > 0) g.velocity.multiplyScalar(1 / (1 + GRENADE.drag * sp * dt));

      // swept motion (up to 3 contacts per step)
      let remaining = dt;
      for (let it = 0; it < 3 && remaining > 1e-6; it++) {
        const speed = g.velocity.length();
        const len = speed * remaining;
        if (len < 1e-7) break;
        _d.copy(g.velocity).multiplyScalar(1 / speed);
        const hit = world.raycast(g.position, _d, len + r);
        if (!hit) { g.position.addScaledVector(_d, len); remaining = 0; break; }
        _n.copy(hit.normal);
        if (_n.dot(_d) > 0) _n.negate();
        const cosI = Math.max(0.2, -_n.dot(_d));
        const s = Math.max(0, hit.distance - r / cosI);
        if (s >= len) { g.position.addScaledVector(_d, len); remaining = 0; break; }
        g.position.addScaledVector(_d, s);
        remaining *= 1 - s / len;
        contact(g, hit, _n);
      }

      // depenetration against the world (catches edge/grazing contacts the centre ray misses)
      for (let it = 0; it < 3; it++) {
        capsule.start.copy(g.position).y -= 0.0005;
        capsule.end.copy(g.position).y += 0.0005;
        capsule.radius = r;
        const c = world.collideCapsule(capsule);
        if (!c || !(c.depth > 1e-5)) break;
        g.position.addScaledVector(c.normal, c.depth + 1e-4);
        const vn = g.velocity.dot(c.normal);
        if (vn < 0) {
          if (vn < -0.8) contact(g, { surface: g.surface, material: null }, c.normal);
          else g.velocity.addScaledVector(c.normal, -vn);
        }
        if (c.normal.y > 0.55) { g.grounded = true; g.groundNormal.copy(c.normal); }
      }

      // ground probe
      const gh = world.raycast(g.position, _down, r + 0.03);
      if (gh && gh.normal.y > 0.35) {
        g.grounded = true;
        g.groundNormal.copy(gh.normal);
        if (gh.normal.y < 0) g.groundNormal.negate();
        g.surface = gh.surface || g.surface;
        // keep on the surface
        const gap = gh.distance - r;
        if (gap < 0) g.position.y -= gap;
        const vn = g.velocity.dot(g.groundNormal);
        if (vn < 0 && vn > -0.9) g.velocity.addScaledVector(g.groundNormal, -vn); // settle
        // rolling resistance
        const spec = surfaceSpec(gh);
        _t.copy(g.velocity).addScaledVector(g.groundNormal, -g.velocity.dot(g.groundNormal));
        const vt = _t.length();
        if (vt > 1e-6) {
          // Two regimes. Fast (a flat throw skidding in): the lopsided body cannot roll cleanly, it
          // tumbles end over end and bleeds speed roughly with v^2 (implicit, stable at any dt). Slow:
          // plain rolling resistance, raised by the fuse/lever wobble. Keeps a frag within a few metres
          // of where it first lands instead of skating across a plaza.
          const grip = 0.6 + 0.4 * Math.min(2, spec.friction / 0.35);
          const k = GRENADE.tumbleDrag * grip * smooth01((vt - 0.8) / 2.2);
          const dec = spec.roll * G * g.groundNormal.y * dt * (1 + 1.3 * g.wobble);
          const nv = Math.max(0, vt / (1 + k * vt * dt) - dec);
          g.velocity.addScaledVector(_t, (nv - vt) / vt);
        }
        // rolling without slip: spin follows velocity
        _t.copy(g.velocity).addScaledVector(g.groundNormal, -g.velocity.dot(g.groundNormal));
        _axis.crossVectors(g.groundNormal, _t).multiplyScalar(1 / r);
        g.spin.lerp(_axis, 0.25);
        // the fuse + lever make it lopsided: it wobbles and stops sooner than a ball
        g.wobble = Math.min(1, g.wobble + dt * 1.6);
        const slope = g.groundNormal.y;
        if (g.velocity.length() < GRENADE.sleepSpeed && slope > 0.94) {
          g.resting = true;
          g.velocity.set(0, 0, 0);
          g.spin.set(0, 0, 0);
          settleOrientation(g);
        }
      } else {
        g.grounded = false;
        g.spin.multiplyScalar(1 - 0.05 * dt);
      }

      // integrate orientation
      const w = g.spin.length();
      if (w > 1e-5) {
        _q.setFromAxisAngle(_axis.copy(g.spin).multiplyScalar(1 / w), w * dt);
        g.quat.premultiply(_q).normalize();
      }
    } else if (g.fuseLeft > 0.05) {
      // resting: make sure support did not vanish (e.g. destructible cover)
      const gh = world.raycast(g.position, _down, r + 0.05);
      if (!gh) g.resting = false;
    }

    if (g.path) g.path.push(g.position.x, g.position.y, g.position.z);

    // out of the world -> discard
    if (g.position.y < -50) g.fuseLeft = Math.min(g.fuseLeft, 0.0001);
  }

  /** Tip the resting grenade onto its side (a real frag lies on its body/lever, never on the fuse). */
  function settleOrientation(g) {
    // current up axis of the grenade
    _t.set(0, 1, 0).applyQuaternion(g.quat);
    // rotate so its up axis lies nearly in the ground plane (lying on the side), tilted 12deg up
    _axis.crossVectors(_t, g.groundNormal);
    if (_axis.lengthSq() < 1e-6) _axis.set(1, 0, 0);
    _axis.normalize();
    const cur = Math.acos(Math.max(-1, Math.min(1, _t.dot(g.groundNormal))));
    const target = Math.PI / 2 - 0.2;
    _q.setFromAxisAngle(_axis, cur - target);
    g.quat.premultiply(_q);
    // body centre sits one radius above the ground
  }

  function fixedUpdate(dt) {
    if (dt <= 0) return;
    for (let i = grenades.length - 1; i >= 0; i--) {
      const g = grenades[i];
      stepGrenade(g, dt);
      if (g.fuseLeft <= 0) detonate(g, i);
    }
    stepSpoons(dt);
    // cooking in hand
    if (state.cooking) {
      state.cookTime = ctx.time.t - cookStart;
      if (state.cookTime >= GRENADE.fuse) {
        // held too long: goes off in hand
        state.cooking = false;
        throwAt = -1;
        const ps = ctx.services.player.state;
        _o.copy(ps.eye).addScaledVector(ps.forward, 0.3).y -= 0.25;
        hooks.explode({ position: _o, type: 'frag', source: 'player', weaponId: 'frag' });
        grenEvt.phase = 'cooked-off'; grenEvt.grenade = null; grenEvt.cookTime = state.cookTime; grenEvt.source = 'player'; grenEvt.position.copy(_o);
        ctx.events.emit('combat:grenade', grenEvt);
      }
    }
    if (throwAt >= 0 && ctx.time.t + 1e-6 >= throwAt) {
      throwAt = -1;
      // the fuse kept burning during the throw animation
      throwFuse = Math.max(0.05, GRENADE.fuse - (ctx.time.t + dt - cookStart));
      launchPlayerGrenade();
    }
  }

  function detonate(g, i) {
    grenades.splice(i, 1);
    g.active = false;
    g.object.visible = false;
    root.remove(g.object);
    pool.push(g);
    hooks.explode({ position: g.position, type: g.type, source: g.source, weaponId: g.type === 'frag' ? 'frag' : g.type, team: g.team });
  }

  /** Render interpolation between fixed steps. */
  function update() {
    const a = ctx.time.alpha || 0;
    for (const g of grenades) {
      g.object.position.lerpVectors(g.prev, g.position, a);
      g.object.quaternion.slerpQuaternions(g.prevQuat, g.quat, a);
      // keep the enlarged body resting ON the surface instead of sunk into it
      if (VIS !== 1 && g.grounded) g.object.position.addScaledVector(g.groundNormal, GRENADE.radius * (VIS - 1));
    }
  }

  // ---------------------------------------------------------------- player input (cook & throw)
  function cookGrenade() {
    if (state.cooking || throwAt >= 0) return false;
    if (state.count <= 0) { ctx.events.emit('combat:grenade', { phase: 'empty', grenade: null, cookTime: 0, fuse: 0, source: 'player', position: ctx.services.player.state.eye }); return false; }
    if (ctx.services.player.state.alive === false) return false;
    state.cooking = true;
    state.cookTime = 0;
    cookStart = ctx.time.t;
    grenEvt.phase = 'cook'; grenEvt.grenade = null; grenEvt.cookTime = 0; grenEvt.fuse = GRENADE.fuse; grenEvt.source = 'player';
    grenEvt.position.copy(ctx.services.player.state.eye);
    ctx.events.emit('combat:grenade', grenEvt);
    return true;
  }

  function releaseGrenade() {
    if (!state.cooking) return false;
    state.cooking = false;
    state.count--;
    throwFuse = Math.max(0.05, GRENADE.fuse - (ctx.time.t - cookStart));
    throwAt = ctx.time.t + GRENADE.windup;
    state.pendingThrow = throwAt;
    grenEvt.phase = 'release'; grenEvt.grenade = null; grenEvt.cookTime = ctx.time.t - cookStart; grenEvt.fuse = throwFuse; grenEvt.source = 'player';
    grenEvt.position.copy(ctx.services.player.state.eye);
    ctx.events.emit('combat:grenade', grenEvt);
    return true;
  }

  function cancelGrenade() {
    if (!state.cooking) return;
    // not possible to put the pin back in CoD either: treat as a short lob at feet
    releaseGrenade();
  }

  function launchPlayerGrenade() {
    const ps = ctx.services.player.state;
    const cam = ctx.camera;
    cam.getWorldDirection(_fwd);
    _right.crossVectors(_fwd, _up).normalize();
    const eye = ps.eye && ps.eye.lengthSq() > 0 ? ps.eye : cam.getWorldPosition(_t);
    _o.copy(eye).addScaledVector(_right, 0.16).addScaledVector(_up, -0.1).addScaledVector(_fwd, 0.28);
    // never spawn inside a wall right in front of the player
    _d.copy(_o).sub(eye);
    const dl = _d.length();
    _d.multiplyScalar(1 / dl);
    const block = ctx.services.world.raycast(eye, _d, dl + GRENADE.radius);
    if (block) _o.copy(eye).addScaledVector(_d, Math.max(0, block.distance - GRENADE.radius * 2));
    // aim: pitch up a bit, speed depends on stance (prone lobs)
    const pitchUp = (GRENADE.throwPitchUp * Math.PI) / 180;
    _v.copy(_fwd).applyAxisAngle(_right, pitchUp).normalize();
    const speed = ps.stance === 'prone' ? GRENADE.lobSpeed : GRENADE.throwSpeed;
    _v.multiplyScalar(speed);
    if (ps.velocity) _v.addScaledVector(ps.velocity, 0.7);
    state.lastThrow = ctx.time.t;
    state.pendingThrow = -1;
    return throwGrenade({ origin: _o, velocity: _v, fuse: throwFuse, source: 'player', team: 'player', cookTime: GRENADE.fuse - throwFuse });
  }

  /**
   * Input ownership. The weapons system may run its own lethal (viewmodel clip + throw); then combat
   * must not ALSO cook/throw on the same key. settings combat.grenadeInput: true (always), false
   * (never), 'auto' (default: only while weapons does not manage lethals, i.e. has no
   * state.lethal counter and never emitted 'weapons:grenade').
   */
  function inputOwned() {
    if (!state.inputEnabled) return false;
    if (state.inputMode !== 'auto') return true;
    if (state.weaponsOwnsLethal) return false;
    const ws = ctx.services.weapons.state;
    return !(ws && typeof ws.lethal === 'number');
  }

  function handleInput() {
    if (!inputOwned()) { if (!state.cooking) inputCook = false; return; }
    const input = ctx.input;
    if (input.pressed('grenade') && cookGrenade()) inputCook = true;
    if (state.cooking && inputCook && !input.isDown('grenade')) { inputCook = false; releaseGrenade(); }
    if (!state.cooking) inputCook = false;
  }

  function createGrenadeMesh(opts) { return ensureAssets().makeGrenade(opts); }

  function clear() {
    for (let i = grenades.length - 1; i >= 0; i--) {
      const g = grenades[i];
      g.active = false; g.object.visible = false; root.remove(g.object); pool.push(g);
    }
    grenades.length = 0;
    for (const s of spoons) { s.active = false; s.object.visible = false; root.remove(s.object); }
  }

  function dispose() {
    clear();
    root.removeFromParent();
    assets.current?.dispose();
    assets.current = null;
  }

  return {
    root, grenades, state, inputOwned, fixedUpdate, update, handleInput, throwGrenade, throwGrenadeAt, solveThrow,
    cookGrenade, releaseGrenade, cancelGrenade, createGrenadeMesh, ensureAssets, clear, dispose,
  };
}

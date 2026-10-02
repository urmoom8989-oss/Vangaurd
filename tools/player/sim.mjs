#!/usr/bin/env node
/**
 * tools/player/sim.mjs — headless regression suite for the player motor (runs in Node, no browser).
 *
 *   node tools/player/sim.mjs [scenario ...] [--verbose]
 *
 * Builds a private Octree test world (floor, stairs, walls, corner, slopes, thin slab, dock, low wall,
 * low ceiling) that mirrors the services.world contract (collideCapsule / raycast / groundHeight),
 * drives src/systems/player/motor.js with scripted input at a fixed 60 Hz and checks invariants:
 * no tunnelling, stairs climbed, no drift on slopes, no corner jitter, mantle / vault heights,
 * slide distance, crouch headroom, fall damage, coyote jumps. Independent of the (concurrently
 * edited) level, so movement can be validated at any time.
 */
import * as THREE from 'three';
import { Octree } from 'three/examples/jsm/math/Octree.js';
import { Motor } from '../../src/systems/player/motor.js';
import { SETTINGS_DEFAULTS, MOVE } from '../../src/systems/player/config.js';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const only = args.filter((a) => !a.startsWith('--'));

// ------------------------------------------------------------------------------------------ world
function makeWorld() {
  const scene = new THREE.Group();
  const meshes = [];
  const mat = new THREE.MeshBasicMaterial();
  function box(w, h, d, x, y, z, { rx = 0, ry = 0, surface = 'concrete' } = {}) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y + h / 2, z);
    m.rotation.set(rx, ry, 0, 'YXZ');
    m.userData.surface = surface;
    m.updateMatrixWorld(true);
    scene.add(m);
    meshes.push(m);
    return m;
  }
  // floor (thick slab so nothing can fall through)
  box(400, 1, 400, 0, -1, 0, { surface: 'asphalt' });
  // lane A (x = 0): stairs 7 × 0.17 m starting at z = -3, going -Z, landing, then drop
  for (let i = 0; i < 7; i++) box(2.4, 0.17 * (i + 1), 0.3, 0, 0, -3 - 0.15 - 0.3 * i);
  box(2.4, 1.19, 3, 0, 0, -3 - 2.1 - 1.5);
  // lane B (x = 10): a wall at z = -5 (0.25 thick)
  box(6, 3, 0.25, 10, 0, -5);
  // lane C (x = 20): corner made of two walls
  box(4, 3, 0.25, 20, 0, -5);
  box(0.25, 3, 4, 21.9, 0, -3);
  // lane D (x = 30): 30° ramp up (-Z), then a 60° wall-slope further on
  box(3, 0.3, 12, 30, -1.2, -8, { rx: 30 * Math.PI / 180 });
  box(3, 0.3, 8, 36, -1.2, -6, { rx: 60 * Math.PI / 180 });
  // lane E (x = 40): thin slab 0.1 m at y = 2 (tunnelling test)
  box(6, 0.1, 6, 40, 2, 0);
  // lane F (x = 50): docks: 1.0 m, 1.45 m, 2.0 m tall (3 m deep) at z = -3 in separate lanes
  box(3, 1.0, 3, 50, 0, -4.5);
  box(3, 1.45, 3, 55, 0, -4.5);
  box(3, 2.0, 3, 60, 0, -4.5);
  box(3, 2.4, 3, 65, 0, -4.5); // needs a jump first
  box(3, 3.4, 3, 75, 0, -4.5); // too tall
  // lane G (x = 70): thin low wall 1.0 m × 0.3 m (vault)
  box(3, 1.0, 0.3, 70, 0, -3);
  // lane H (x = 80): low ceiling (1.4 m clearance) tunnel from z = -2 to -8
  box(3, 0.3, 6, 80, 1.4, -5);
  box(0.3, 1.4, 6, 78.6, 0, -5);
  box(0.3, 1.4, 6, 81.4, 0, -5);
  // lane I (x = 90): 8 m tall tower (fall damage / ledge walk-off)
  box(4, 8, 4, 90, 0, 0);
  // lane J (x = 100): curb 0.15 m and a 0.45 m step
  box(6, 0.15, 3, 100, 0, -3);
  box(6, 0.45, 3, 100, 0, -7);

  const octree = new Octree();
  octree.fromGraphNode(scene);
  const raycaster = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const o = new THREE.Vector3();
  let calls = 0;
  const world = {
    bounds: new THREE.Box3(new THREE.Vector3(-200, -10, -200), new THREE.Vector3(200, 50, 200)),
    spawnPoints: { player: [{ position: new THREE.Vector3(), yaw: 0 }] },
    collideCapsule(c) { calls++; return octree.capsuleIntersect(c); },
    raycast(origin, dir, far = 1000) {
      raycaster.set(origin, dir);
      raycaster.near = 0; raycaster.far = far;
      const h = raycaster.intersectObjects(meshes, false)[0];
      if (!h) return null;
      const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
      if (n.dot(dir) > 0) n.negate(); // BVH world returns ray-facing normals
      return { point: h.point.clone(), normal: n, distance: h.distance, object: h.object, surface: h.object.userData.surface };
    },
    groundHeight(x, z, fromY = 100) { const h = world.raycast(o.set(x, fromY, z), down, fromY + 50); return h ? h.point.y : 0; },
    get calls() { return calls; },
  };
  return world;
}

// ------------------------------------------------------------------------------------------ harness
function makeSim(world) {
  const events = [];
  const held = new Set();
  const ctx = {
    services: { world, weapons: { state: { ads: 0 } }, isProvided: () => true },
    events: { emit(n, e) { events.push({ n, e: { ...e, position: e.position?.clone?.() } }); } },
    settings: { data: { player: { ...SETTINGS_DEFAULTS }, controls: { toggleCrouch: true } } },
    input: { isDown: (a) => held.has(a) },
  };
  const state = {
    position: new THREE.Vector3(), velocity: new THREE.Vector3(), yaw: 0, pitch: 0, stance: 'stand',
    alive: true, ads: 0, health: 100,
  };
  const motor = new Motor(ctx, state);
  let damage = 0;
  motor.onFallDamage = (d) => { damage += d; };
  const sim = {
    ctx, state, motor, events, t: 0, frame: 0,
    get damage() { return damage; },
    at(x, y, z, yaw = 0) { state.yaw = yaw; motor.teleport(new THREE.Vector3(x, y, z)); return sim; },
    move(x, y) { motor.moveInput.x = x; motor.moveInput.y = y; return sim; },
    press(a) {
      const it = motor.intent;
      if (a === 'jump') it.jump = MOVE.jumpBuffer; else it[a] = true;
      return sim;
    },
    run(frames, fn) {
      for (let i = 0; i < frames; i++) {
        sim.frame++;
        sim.t += 1 / 60;
        motor.step(1 / 60, sim.t);
        fn?.(sim, i);
      }
      return sim;
    },
    count(name) { return events.filter((e) => e.n === name).length; },
  };
  return sim;
}

// ------------------------------------------------------------------------------------------ scenarios
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
}

const scenarios = {
  flat(world) {
    const s = makeSim(world).at(0, 0, 20).move(0, 1);
    let t90 = -1;
    s.run(60, (s, i) => { if (t90 < 0 && s.state.speed >= MOVE.walk * 0.9) t90 = i + 1; });
    check('walk: reaches 90% of 4.2 m/s', t90 > 0 && t90 <= 16, `${t90} frames (${(t90 / 60).toFixed(2)} s)`);
    check('walk: steady speed', Math.abs(s.state.speed - MOVE.walk) < 0.02, s.state.speed.toFixed(3));
    check('walk: stays on the floor', Math.abs(s.state.position.y) < 0.005, s.state.position.y.toFixed(4));
    s.move(0, 0);
    let stop = -1;
    s.run(40, (s, i) => { if (stop < 0 && s.state.speed < 0.05) stop = i + 1; });
    check('walk: stops within 0.25 s', stop > 0 && stop <= 15, `${stop} frames`);
    // sprint + tac
    const s2 = makeSim(world).at(0, 0, 40).move(0, 1).press('sprint');
    s2.run(60);
    check('sprint: 6.3 m/s', Math.abs(s2.state.speed - MOVE.sprint) < 0.05, s2.state.speed.toFixed(2));
    s2.press('sprint').run(60);
    check('tac-sprint: 7.5 m/s', Math.abs(s2.state.speed - MOVE.tacSprint) < 0.05, s2.state.speed.toFixed(2));
    s2.run(200);
    check('tac-sprint: expires to sprint', !s2.motor.tac && Math.abs(s2.state.speed - MOVE.sprint) < 0.05, `tac=${s2.motor.tac} ${s2.state.speed.toFixed(2)}`);
    const steps = s2.count('player:footstep');
    check('footsteps emitted while sprinting', steps >= 10, `${steps} steps in 5.3 s`);
  },

  stairs(world) {
    const s = makeSim(world).at(0, 0, -1).move(0, 1);
    let minSpeed = 99, maxVy = 0, maxY = 0;
    s.run(150, (s, i) => {
      maxY = Math.max(maxY, s.state.position.y);
      if (i > 20 && s.state.position.z > -5.2) minSpeed = Math.min(minSpeed, s.state.speed);
      maxVy = Math.max(maxVy, s.state.velocity.y);
    });
    check('stairs: climbed to the landing (1.19 m)', Math.abs(maxY - 1.19) < 0.01, `max y=${maxY.toFixed(3)}`);
    check('stairs: no stalls while climbing', minSpeed > 3.0, `min speed ${minSpeed.toFixed(2)}`);
    check('stairs: no launch', maxVy < 3.5, `max vy ${maxVy.toFixed(2)}`);
    // walk back down
    const d = makeSim(world).at(0, 1.19, -6, Math.PI).move(0, 1);
    let airFrames = 0;
    d.run(90, (s) => { if (!s.state.grounded) airFrames++; });
    check('stairs down: stays grounded', airFrames <= 2, `${airFrames} air frames, y=${d.state.position.y.toFixed(3)}`);
    check('stairs down: reached the bottom', d.state.position.y < 0.01, d.state.position.y.toFixed(3));
    // curb + step
    const c = makeSim(world).at(100, 0, 0).move(0, 1);
    let curbY = 0, minSpd = 99;
    c.run(90, (s) => {
      if (s.state.position.z < -2.2 && s.state.position.z > -4.2) curbY = Math.max(curbY, s.state.position.y);
      if (s.state.position.z < -1.0 && s.state.position.z > -7.0) minSpd = Math.min(minSpd, s.state.speed);
    });
    check('curb 0.15 m: stepped up', Math.abs(curbY - 0.15) < 0.01, `y=${curbY.toFixed(3)}`);
    check('0.45 m step: stepped up', Math.abs(c.state.position.y - 0.45) < 0.01 && c.state.position.z < -5.8, `y=${c.state.position.y.toFixed(3)} z=${c.state.position.z.toFixed(2)}`);
    check('curb/step: speed kept', minSpd > 2.5, `min speed ${minSpd.toFixed(2)}`);
  },

  walls(world) {
    const s = makeSim(world).at(10, 0, 0).move(0, 1).press('sprint');
    let pen = 0;
    s.run(120, (s) => { pen = Math.max(pen, s.state.position.z - 0 < -4.875 + MOVE.radius - 0.01 ? (-4.875 + MOVE.radius) - s.state.position.z : 0); });
    check('wall: no penetration at sprint', pen < 0.005 && s.state.position.z >= -4.875 + MOVE.radius - 0.005, `z=${s.state.position.z.toFixed(4)} pen=${pen.toFixed(4)}`);
    check('wall: sprint dropped when blocked', !s.motor.sprinting, `sprinting=${s.motor.sprinting}`);
    // diagonal slide along the wall keeps tangential speed
    const d = makeSim(world).at(9, 0, -4.4, -Math.PI / 4).move(0, 1);
    d.run(40);
    check('wall: slides along at an angle', d.state.speed > 2.5, `speed ${d.state.speed.toFixed(2)}`);
    // corner jitter
    const c = makeSim(world).at(20, 0, -2, -Math.PI / 4).move(0, 1);
    c.run(60);
    const p0 = c.state.position.clone();
    let maxDev = 0;
    c.run(120, (s) => { maxDev = Math.max(maxDev, s.state.position.distanceTo(p0)); });
    check('corner: no jitter', maxDev < 0.003, `max deviation ${(maxDev * 1000).toFixed(2)} mm`);
  },

  slopes(world) {
    // ramp surface: y(z) = -0.877 + (-8 - z) * tan30: starts at z ≈ -9.5, top end (y ≈ 2.1) at z ≈ -13.2
    const s = makeSim(world).at(30, 0, 0.5).move(0, 1);
    let air = 0, maxY = 0;
    s.run(235, (s, i) => {
      maxY = Math.max(maxY, s.state.position.y);
      if (i > 5 && !s.state.grounded && s.state.position.z > -12.8) air++;
      if (verbose && i % 5 === 0) console.log('ramp', i, s.state.position.toArray().map((v) => v.toFixed(3)).join(' '), s.state.speed.toFixed(2), s.state.velocity.y.toFixed(2), s.motor.mode);
    });
    check('30° ramp: walked up to the top', maxY > 1.95, `max y=${maxY.toFixed(2)}`);
    check('30° ramp: stays grounded', air <= 1, `${air} air frames`);
    // stand still on the ramp: no drift
    const p = makeSim(world).at(30, 1.2, -11).run(30);
    const p0 = p.state.position.clone();
    p.run(180);
    check('30° ramp: no drift standing', p.state.position.distanceTo(p0) < 0.002 && p.state.position.y > 0.5, `${(p.state.position.distanceTo(p0) * 1000).toFixed(2)} mm (y=${p0.y.toFixed(2)})`);
    // walk down the ramp at sprint: stays glued
    const d = makeSim(world).at(30, 2.2, -12.8, Math.PI).move(0, 1).press('sprint');
    let dAir = 0;
    d.run(60, (s, i) => { if (i > 3 && !s.state.grounded && s.state.position.y > 0.05) dAir++; });
    check('30° ramp: sprint down stays grounded', dAir <= 1, `${dAir} air frames, end y=${d.state.position.y.toFixed(2)}`);
    // 60°: cannot walk up
    const w = makeSim(world).at(36, 0, 0).move(0, 1);
    w.run(180);
    check('60° slope: not climbable', w.state.position.y < 0.8, `y=${w.state.position.y.toFixed(2)}`);
  },

  tunnel(world) {
    const s = makeSim(world).at(40, 30, 0);
    s.motor.vel.y = -40;
    s.run(90);
    check('fast fall: lands on a 0.1 m slab', Math.abs(s.state.position.y - 2.1) < 0.02, `y=${s.state.position.y.toFixed(3)}`);
    check('fast fall: fall damage applied', s.damage > 0, `damage=${s.damage.toFixed(1)}`);
  },

  mantle(world) {
    for (const [x, h] of [[50, 1.0], [55, 1.45], [60, 2.0]]) {
      const s = makeSim(world).at(x, 0, -1.9).move(0, 1);
      s.run(4).press('jump');
      let frames = 0;
      s.run(90, (s) => { if (s.motor.mode === 'mantle') frames++; else if (frames) s.move(0, 0); });
      const ev = s.events.filter((e) => e.n === 'player:mantle').map((e) => `${e.e.phase}:${e.e.height.toFixed(2)}${e.e.vault ? 'V' : ''}`).join(',');
      check(`mantle ${h} m: on top`, Math.abs(s.state.position.y - h) < 0.02, `y=${s.state.position.y.toFixed(3)} frames=${frames} (${(frames / 60).toFixed(2)} s) ${ev}`);
    }
    const j = makeSim(world).at(65, 0, -1.9).move(0, 1);
    j.run(4).press('jump').run(80, (s) => { if (s.motor.mode === 'ground' && s.state.position.y > 1) s.move(0, 0); });
    check('jump-mantle 2.4 m (jump, then climb)', Math.abs(j.state.position.y - 2.4) < 0.02, `y=${j.state.position.y.toFixed(2)}`);
    const t = makeSim(world).at(75, 0, -1.9).move(0, 1);
    t.run(4).press('jump').run(80);
    check('3.4 m wall: no mantle', t.state.position.y < 0.5, `y=${t.state.position.y.toFixed(2)}`);
    // air mantle: jump early, hold forward
    const a = makeSim(world).at(55, 0, 0.5).move(0, 1);
    a.run(10).press('jump').run(90, (s) => { if (s.motor.mode === 'ground' && s.state.position.y > 1) s.move(0, 0); });
    check('air mantle onto 1.45 m', Math.abs(a.state.position.y - 1.45) < 0.02, `y=${a.state.position.y.toFixed(3)}`);
    // vault
    const v = makeSim(world).at(70, 0, -1.2).move(0, 1);
    v.run(4).press('jump').run(80);
    check('vault 1.0 m thin wall: landed beyond', v.state.position.z < -3.3 && v.state.position.y < 0.02, `z=${v.state.position.z.toFixed(2)} y=${v.state.position.y.toFixed(2)} vaults=${v.events.filter((e) => e.n === 'player:mantle' && e.e.vault).length}`);
  },

  crouch(world) {
    const s = makeSim(world).at(80, 0, 0).move(0, 1);
    s.press('crouch').run(150);
    check('crouch: fits under 1.4 m ceiling', s.state.position.z < -4, `z=${s.state.position.z.toFixed(2)}`);
    s.move(0, 0).run(10).press('crouch').run(10);
    check('crouch: cannot stand under ceiling', s.state.stance === 'crouch', s.state.stance);
    s.press('sprint').run(5);
    check('crouch: sprint cannot stand up under ceiling', s.state.stance === 'crouch', s.state.stance);
    // standing walks into the tunnel lip
    const b = makeSim(world).at(80, 0, 0).move(0, 1).run(90);
    check('stand: blocked by 1.4 m ceiling', b.state.position.z > -2.1, `z=${b.state.position.z.toFixed(2)}`);
  },

  slide(world) {
    const s = makeSim(world).at(0, 0, 60).move(0, 1).press('sprint').run(60);
    const z0 = s.state.position.z;
    s.press('crouch');
    let frames = 0;
    s.run(120, (s) => { if (s.motor.mode === 'slide') frames++; });
    const slideEnd = s.events.find((e) => e.n === 'player:slide' && e.e.phase === 'end');
    const dist = slideEnd ? z0 - slideEnd.e.position.z : 0;
    check('slide: 3.8–5.5 m', dist > 3.8 && dist < 5.5, `${dist.toFixed(2)} m in ${(frames / 60).toFixed(2)} s`);
    check('slide: ends crouched', s.state.stance === 'crouch', s.state.stance);
    // slide cancel with jump
    const c = makeSim(world).at(0, 0, 90).move(0, 1).press('sprint').run(60).press('crouch').run(20).press('jump').run(2);
    check('slide-cancel jump', c.state.stance === 'stand' && c.motor.mode === 'air' && c.state.speed > 5, `stance=${c.state.stance} mode=${c.motor.mode} speed=${c.state.speed.toFixed(2)}`);
  },

  ledge(world) {
    // walk off the 8 m tower: fall damage, coyote jump
    const s = makeSim(world).at(90, 8, 1.2).move(0, 1).press('sprint');
    s.run(10);
    let firstAir = -1;
    s.run(30, (s, i) => { if (firstAir < 0 && s.motor.mode === 'air') { firstAir = i; s.press('jump'); } });
    const jumped = s.count('player:jump');
    check('coyote jump after walking off a ledge', jumped === 1, `jumps=${jumped}`);
    s.run(120);
    check('8 m fall: damage', s.damage > 20 && s.damage < 100, `damage=${s.damage.toFixed(1)}`);
  },

  perf(world) {
    const s = makeSim(world).at(0, 0, -1).move(0, 1);
    const c0 = world.calls;
    const t0 = process.hrtime.bigint();
    s.run(600, (s, i) => { if (i % 90 === 0) s.state.yaw += 0.7; });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    check('perf: motor step cost', ms / 600 < 0.25, `${(ms / 600).toFixed(3)} ms/step, ${((world.calls - c0) / 600).toFixed(1)} collide calls/step`);
  },
};

const world = makeWorld();
for (const [name, fn] of Object.entries(scenarios)) {
  if (only.length && !only.includes(name)) continue;
  try { fn(world); } catch (e) { results.push({ name: `${name}: threw`, ok: false, detail: e.stack }); }
}
let fails = 0;
for (const r of results) {
  if (!r.ok) fails++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail !== undefined ? '  — ' + r.detail : ''}`);
}
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
void verbose;

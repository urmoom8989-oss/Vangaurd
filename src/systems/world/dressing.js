import * as THREE from 'three';
import { ROADS, PLAZA, PLAY } from './town.js';
import {
  jerseyBarrier, hescoLine, sandbagWall, razorWire, hedgehog, lampPost, powerPole, wire,
  bench, kiosk, busShelter, stall, container, hTank, vTank, canopy, fountain, plinth, tree, hashRng,
} from './objects.js';
import { car, van, truck, bus } from './vehicles.js';

/**
 * Town dressing: plaza set pieces, barricades, vehicles, stalls, street furniture, utility poles and
 * wires, rubble, vegetation, ground decals. Hand-authored per area with seeded jitter.
 */

/** Ground height from the layout (before collision exists). */
export function groundAt(x, z) {
  if (x >= PLAZA.x0 && x <= PLAZA.x1 && z >= PLAZA.z0 && z <= PLAZA.z1) return 0.15;
  for (const r of ROADS) {
    if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) return 0.0;
    if (r.axis === 'z' && z >= r.z0 && z <= r.z1 && ((x >= r.x0 - 3 && x < r.x0) || (x > r.x1 && x <= r.x1 + 3))) return 0.15;
    if (r.axis === 'x' && x >= r.x0 && x <= r.x1 && ((z >= r.z0 - 3 && z < r.z0) || (z > r.z1 && z <= r.z1 + 3))) return 0.15;
  }
  const lots = [[-64, -38, -55, -40], [28, 67, -67, -24], [23, 36, 22, 58], [36, 66, 22, 52], [-64, -38, -36, -22]];
  for (const [x0, x1, z0, z1] of lots) if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return 0.024;
  return 0;
}

export function dressTown(env) {
  env.rubblePile = rubblePile;
  const { B, rng } = env;
  const R = rng.fork('dressing');
  const ledge = (x0, z0, x1, z1, h) => env.ledges.push({ a: new THREE.Vector3(x0, h, z0), b: new THREE.Vector3(x1, h, z1), height: h });
  const ledgeAlong = (x, z, ry, len, h) => {
    const dx = Math.cos(ry) * len / 2, dz = -Math.sin(ry) * len / 2;
    ledge(x - dx, z - dz, x + dx, z + dz, h);
  };
  const G = groundAt;
  const J = (x, z, ry) => { jerseyBarrier(B, x, G(x, z), z, ry); ledgeAlong(x, z, ry, 3, G(x, z) + 0.81); };
  const SB = (x, z, ry, len, rows = 6, o = {}) => { const h = sandbagWall(env, x, G(x, z), z, ry, len, rows, o); ledgeAlong(x, z, ry, len, G(x, z) + h); };
  const HL = (x, z, ry, n, o = {}) => { hescoLine(B, x, G(x, z), z, ry, n, o); if (!o.double) ledgeAlong(x, z, ry, n * 1.07, G(x, z) + 1.07); };
  const P = (type, x, z, ry = 0, s = 1, o = {}) => env.props.place(type, x, (o.y ?? G(x, z)), z, ry, s, o);
  const D = (cell, x, z, w, h, rot = 0, mat) => env.decals.add(cell, x, G(x, z) + 0.01, z, w, h, 'y', { rot, mat });

  // ======================================================================== PLAZA
  fountain(B, 0, 0.15, -2, { broken: 5 });
  rubblePile(B, Math.cos(5 * Math.PI / 4 + Math.PI / 8) * 5.4, 0.15, -2 + Math.sin(5 * Math.PI / 4 + Math.PI / 8) * 5.4, 1.2, 0.4, 'concrete_wall');
  ledge(-5, -2, 5, -2, 0.7);
  for (let i = 0; i < 14; i++) D(24 + (i % 4), R.range(-3.8, 3.8), -2 + R.range(-3.8, 3.8), R.range(0.8, 1.6), R.range(0.8, 1.6), R.range(0, 6));
  D(12, 1.5, -1, 3.5, 3.5, 1);
  plinth(B, 0, 0.15, -15.5, 0, { toppled: true });
  // planter trees + benches + lamps around the inner square
  for (const [x, z] of [[-12, -11], [12, -11], [-12, 9], [12, 9]]) {
    B.box('concrete_wall#pale', x, 0.15 + 0.25, z, 1.6, 0.5, 1.6, { skip: 8 });
    B.box('dirt', x, 0.15 + 0.46, z, 1.3, 0.05, 1.3, { col: false, skip: 8 });
    tree(env, x, 0.61, z, { dead: x > 0 && z > 0 });
    for (let k = 0; k < 3; k++) P(`foliage${k}`, x + R.range(-0.5, 0.5), z + R.range(-0.5, 0.5), R.range(0, 6), R.range(0.4, 0.7), { y: 0.62, collide: false });
  }
  bench(B, -6.8, 0.15, -2, Math.PI / 2);
  bench(B, 6.8, 0.15, -2, -Math.PI / 2, { broken: true });
  bench(B, -4.5, 0.15, 6.2, Math.PI);
  bench(B, 4, 0.15, -9.5, 0);
  for (const [x, z] of [[-8.5, 12.5], [8.5, 12.5], [-8.5, -13], [8.5, -13], [-18, 18], [18, 18], [-18, -18]]) lampPost(B, x, 0.15, z, Math.atan2(-x, -z) + Math.PI, { broken: x === 18 && z === 18 });
  // vehicles as cover
  bus(B, -14.5, 0.15, -8.5, 0.35, { burnt: true });
  D(20, -14.5, -8.5, 11, 5, 0.35);
  car(B, 11.5, 0.15, 6.5, -0.65, { burnt: true });
  D(21, 11.5, 6.5, 6, 4, -0.65);
  car(B, -9.5, 0.15, 15.5, 1.9, { paint: 'metal_painted#white', seed: 3 });
  car(B, 16.5, 0.15, -4.5, 1.45, { burnt: true, seed: 7 });
  // defensive positions
  SB(-6.2, 8.2, 0, 3.6, 7, { thick: true });
  SB(-8.1, 9.6, Math.PI / 2, 2.4, 7, { thick: true });
  SB(-4.3, 9.6, Math.PI / 2, 2.4, 6, { thick: true, ragged: true });
  SB(8.5, -8.6, 0.3, 3.4, 7, { thick: true });
  SB(10.3, -10.2, 0.3 + Math.PI / 2, 2.2, 7, { thick: true });
  SB(-3.2, -10.3, -0.15, 2.8, 5, { ragged: true });
  SB(15.2, 12.2, 0.9, 2.6, 5);
  HL(10.5, -19.3, 0, 6, { double: true });
  HL(-14.5, -19.5, 0.05, 4);
  HL(-20.3, 12.5, Math.PI / 2, 4);
  // street entrances: jersey chicanes + hedgehogs
  J(-1.6, 22.8, 0.08); J(2.6, 25.6, -0.12); J(-4.7, 26.8, 0.3);
  J(-2.2, -23.2, -0.1); J(2.0, -26.4, 0.15);
  J(24.2, -1.8, Math.PI / 2 + 0.1); J(27.2, 1.6, Math.PI / 2 - 0.1);
  J(-24.2, 1.8, Math.PI / 2 - 0.05); J(-27.4, -1.4, Math.PI / 2 + 0.12);
  hedgehog(B, 30, 0, -2.2, 0.3); hedgehog(B, 31.5, 0, 1.8, 1.1);
  // kiosk, bus shelter, utility, trash
  kiosk(B, 16.5, 0.15, -15.8, -0.6);
  busShelter(B, 20.2, 0.15, -13.5, -Math.PI / 2);
  P('utility_box_01', -20.8, -19.8, 0.8, 1); P('utility_box_02', 20.9, 19.6, -0.8, 1);
  P('metal_trash_can', -16, 19.5, 0.1, 1); P('metal_trash_can', 18.5, -19.4, 3.0, 1);
  // market stalls spill into the SE corner
  stall(env, 13, 0.15, 16.2, Math.PI, {}); stall(env, 16.6, 0.15, 17.2, Math.PI + 0.25, {}); stall(env, 19.6, 0.15, 13.8, -Math.PI / 2, {});
  // ammo / crates / barrels at the emplacements
  P('ammo_box', -6.5, 9.4, 0.2, 1); P('ammo_box', -6.0, 9.6, 1.5, 1);
  P('wooden_crate_02', 9.2, -10.2, 0.3, 1); P('old_military_crate', -5.2, 10.3, 1.4, 1);
  P('Barrel_01', 14.8, -18.2, 0.4, 1); P('Barrel_02', 15.6, -18.6, 2.2, 1); P('barrel_03', 15.2, -17.5, 1, 1);
  P('cement_bag', -2.6, -9.2, 0.4, 1, { collide: false }); P('trashbag', 20, 18.3, 1.1, 1);
  // craters, scorch, litter, puddles, cracks
  for (const [x, z, s] of [[5.5, 10.5, 3.2], [-12.5, 2.5, 2.6], [14.5, -3.5, 2.8], [-17, 16, 2.4], [6, -17, 2.2]]) {
    D(20 + Math.floor(R.next() * 4), x, z, s * 1.4, s * 1.4, R.range(0, 6));
    rubbleRing(B, x, 0.15, z, s * 0.45, R);
  }
  scatterDecals(env, R, PLAZA.x0 + 1, PLAZA.x1 - 1, PLAZA.z0 + 1, PLAZA.z1 - 1, { litter: 110, cracks: 40, stains: 44, puddles: 8, dirt: 90 });
  plazaClutter(env, R, P, D);

  // ======================================================================== MAIN STREET (south)
  for (const [z, ry] of [[27, Math.PI / 2], [31.4, Math.PI / 2], [44, Math.PI / 2], [48.3, Math.PI / 2 + 0.1]]) stall(env, -4.9, 0.15, z, ry, {});
  stall(env, -1.9, 0, 36.5, Math.PI / 2 + 0.3, {});
  car(B, 1.2, 0, 41, 0.28, { burnt: true, seed: 11 });
  D(22, 1.2, 41, 6, 4.5, 0.28);
  van(B, 2.1, 0, 53, Math.PI - 0.05, { paint: 'metal_painted#olive' });
  car(B, -1.4, 0.2, 61, -0.5, { burnt: true, roll: 1.55, seed: 13 });
  truck(B, 2.3, 0, 30, Math.PI + 0.06, { canvas: true });
  // map edge barricade
  for (const x of [-5, -2, 1, 4]) J(x, 67.2, (x * 0.37) % 0.3);
  razorWire(B, 0, 0, 68.6, 0, 13);
  SB(-5.3, 65.3, 0.2, 2.6, 7);
  bus(B, 0.5, 0, 74.5, 0.18, { burnt: true, tilt: 0.03 });
  container(B, -3.5, 0, 79, 0.1, { long: true });
  scatterDecals(env, R, -3.3, 3.3, 22, 70, { litter: 30, cracks: 20, stains: 14, puddles: 6, dirt: 8, tyres: 5, potholes: 6 });
  scatterDecals(env, R, -6.4, -3.6, 22, 70, { litter: 22, cracks: 6, dirt: 8 });
  scatterDecals(env, R, 3.6, 6.4, 22, 70, { litter: 18, cracks: 6, dirt: 8 });
  roadMarkings(env, 'z', 0, 24, 70);

  // ======================================================================== STATION ROAD (north)
  HL(-4.5, -41, 0, 4, { double: false });
  HL(4.6, -45, 0, 4, {});
  J(-0.4, -48.2, 0.2); J(0.6, -38.5, -0.15);
  SB(5.0, -37.6, 0, 2.8, 8, { thick: true }); SB(6.2, -38.9, Math.PI / 2, 2, 8, { thick: true });
  razorWire(B, -1.6, 0, -43.5, 0.05, 5);
  truck(B, -1.4, 0, -55.5, Math.PI / 2 + 0.12, { burnt: true });
  D(20, -1.4, -55.5, 9, 5, 0.1);
  car(B, 2.6, 0, -61, -0.1, { seed: 5 });
  for (const x of [-5.5, -2.5]) container(B, x, 0, -68.5, Math.PI / 2 + (x > -3 ? 0.08 : -0.05));
  container(B, 3.5, 0, -69, 0.05);
  razorWire(B, 0, 0, -66.8, 0, 12);
  scatterDecals(env, R, -3.3, 3.3, -70, -22, { litter: 26, cracks: 18, stains: 10, puddles: 5, dirt: 8, tyres: 4, potholes: 5 });
  scatterDecals(env, R, -6.4, -3.6, -70, -22, { litter: 16, cracks: 5, dirt: 6 });
  scatterDecals(env, R, 3.6, 6.4, -70, -22, { litter: 16, cracks: 5, dirt: 6 });
  roadMarkings(env, 'z', 0, -70, -24);

  // ======================================================================== WEST STREET
  car(B, -33, 0.15, 1.8, 0.1, { roll: -1.6, burnt: false, seed: 17, paint: 'metal_painted#blue' });
  SB(-44, -1.2, Math.PI / 2 + 0.2, 3.2, 6, { ragged: true });
  car(B, -52, 0, -2.2, -0.05, { burnt: true, seed: 19 });
  for (const z of [-5, -2, 1, 4]) J(-66.8, z, Math.PI / 2 + (z * 0.13) % 0.2);
  container(B, -71, 0, 0.2, Math.PI / 2 + 0.05, { long: true });
  razorWire(B, -65.5, 0, 0, Math.PI / 2, 12);
  scatterDecals(env, R, -68, -23, -3.3, 3.3, { litter: 25, cracks: 16, stains: 8, puddles: 5, dirt: 8, potholes: 4 });
  scatterDecals(env, R, -68, -23, -6.4, -3.6, { litter: 12, dirt: 6 });
  scatterDecals(env, R, -68, -23, 3.6, 6.4, { litter: 12, dirt: 6 });
  roadMarkings(env, 'x', 0, -68, -24);

  // ======================================================================== EAST STREET
  for (const [x, z, r] of [[48, -2.2, 0.2], [50.2, 1.6, 1.2], [52.5, -0.6, 2.2], [54.4, 2.3, 0.7]]) hedgehog(B, x, 0, z, r);
  car(B, 35, 0, 2, 0.15, { burnt: true, seed: 23 });
  van(B, 60, 0, -2.4, 0.05, { burnt: true });
  for (const z of [-5, -2, 1, 4]) J(66.8, z, Math.PI / 2 - (z * 0.11) % 0.2);
  bus(B, 73, 0, 0.5, Math.PI / 2 + 0.25, { burnt: true });
  razorWire(B, 65.4, 0, 0, Math.PI / 2, 12);
  scatterDecals(env, R, 23, 68, -3.3, 3.3, { litter: 25, cracks: 16, stains: 8, puddles: 5, dirt: 8, potholes: 4 });
  scatterDecals(env, R, 23, 68, -6.4, -3.6, { litter: 12, dirt: 6 });
  scatterDecals(env, R, 23, 68, 3.6, 6.4, { litter: 12, dirt: 6 });
  roadMarkings(env, 'x', 0, 24, 68);

  // ======================================================================== COURTYARD (NW)
  const wallH = 2.8;
  const cwall = (x0, z0, x1, z1, gaps = []) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const ry = -Math.atan2(z1 - z0, x1 - x0);
    B.pushTR(x0, 0, z0, ry);
    const openings = gaps.map(([a, b, top = 0]) => ({ u0: a, u1: b, v0: top, v1: wallH + 1 }));
    // wall with gaps; jagged tops where a gap has top>0 (breach)
    const xs = [0, len];
    for (const o of openings) { xs.push(o.u0, o.u1); }
    xs.sort((a, b) => a - b);
    for (let i = 0; i < xs.length - 1; i++) {
      const a = xs[i], b = xs[i + 1];
      if (b - a < 0.01) continue;
      const mid = (a + b) / 2;
      const gap = openings.find((o) => mid > o.u0 && mid < o.u1);
      const top = gap ? gap.v0 : wallH;
      if (top <= 0.01) continue;
      B.box('brick_red', mid, top / 2, 0, b - a, top, 0.36, { uvOff: [x0, 0] });
      if (!gap) B.box('concrete_wall#pale', mid, top + 0.05, 0, b - a + 0.04, 0.1, 0.46);
    }
    B.pop();
  };
  cwall(-55, -40, -38, -40, [[6.5, 9.5, 0.6]]);
  cwall(-38, -40, -38, -55, [[4.2, 8.2]]);
  // breach rubble + broken gate
  rubblePile(B, -47, 0.02, -40, 1.8, 0.7, 'brick_red');
  B.pushTR(-38, 0.02, -48.8, -1.2);
  for (let i = 0; i < 9; i++) B.box('metal_rusted', 0.1 + i * 0.22, 1.1, 0, 0.04, 2.1, 0.04, { col: false });
  B.box('metal_rusted', 1.0, 0.2, 0, 2.0, 0.06, 0.05, { col: false });
  B.box('metal_rusted', 1.0, 2.05, 0, 2.0, 0.06, 0.05, { col: false });
  B.pop();
  // well
  B.cylinder('concrete_wall#grey', [-47, 0, -48], [-47, 0.8, -48], 1.0, 1.0, 12, { caps: false });
  B.cylinder('concrete_wall#grey', [-47, 0, -48], [-47, 0.8, -48], 0.8, 0.8, 12, { caps: false });
  B.box('concrete_wall#grey', -47, 0.82, -48, 2.1, 0.05, 0.3, { col: false });
  for (const dx of [-0.9, 0.9]) B.box('wood_planks', -47 + dx, 1.4, -48, 0.1, 2.8, 0.1, { col: false });
  B.box('corrugated_metal#rust', -47, 2.85, -48, 2.4, 0.05, 1.6, { rot: [0.15, 0, 0], col: false });
  ledge(-48, -47, -46, -47, 0.8);
  tree(env, -42, 0.02, -52.5, {});
  tree(env, -52.5, 0.02, -43.2, { scale: 1.1 });
  truck(B, -46.5, 0.02, -52.5, 0.02, { canvas: true });
  SB(-41, -42.2, 0.5, 2.8, 7, { thick: true }); SB(-42.5, -43.6, 0.5 + Math.PI / 2, 1.8, 7, { thick: true });
  for (let i = 0; i < 4; i++) B.box('wood_planks', -53.2 + (i % 2) * 0.1, 0.12 + i * 0.22, -46 + i * 0.05, 0.25, 0.22, 2.2, { rot: [0, 0.05 * i, 0], col: i === 0 });
  laundry(B, [-54.8, 2.8, -52], [-49, 2.6, -53.5], R);
  laundry(B, [-54.8, 3.1, -45], [-50.5, 3.3, -41.5], R);
  P('Barrel_02', -39.5, -51, 0.2); P('Barrel_01', -40, -52, 1.1); P('wooden_crate_01', -40.2, -45.5, 0.1); P('wooden_crate_02', -40.3, -46.5, 0.5, 1, { y: 0.02 + 0.47 });
  P('portable_generator', -44, -41.5, 0.8); P('propane_tank', -53.5, -50.2, 0);
  scatterDecals(env, R, -55, -38.5, -55, -40.5, { litter: 20, stains: 6, puddles: 3, dirt: 14 });
  // vacant lot ruin
  ruin(B, -51, -29, 11, 8, R);
  rubblePile(B, -58, 0.02, -25, 2.4, 1.0, 'brick_red');
  rubblePile(B, -43, 0.02, -33, 1.8, 0.7);
  tree(env, -60, 0.02, -33, { dead: true });
  tree(env, -41, 0.02, -24.5, { dead: true, scale: 1.2 });
  scatterDecals(env, R, -63, -39, -35, -23, { litter: 16, dirt: 10 });

  // ======================================================================== FUEL DEPOT (NE)
  fence(B, 28, -66, 66, -66, 2.4, true);
  fence(B, 66, -66, 66, -24, 2.4, true);
  fence(B, 28, -66, 28, -41, 2.4, true);
  // south concrete wall with gate gap
  B.box('concrete_wall', 33.5, 1.2, -24.2, 11, 2.4, 0.3);
  B.box('concrete_wall', 57.5, 1.2, -24.2, 17, 2.4, 0.3);
  hTank(B, 37.5, 0.024, -61, 0, {});
  hTank(B, 37.5, 0.024, -55.5, 0, { mat: 'metal_painted#green' });
  vTank(B, 58.5, 0.024, -58.5, {});
  canopy(B, 43, 0.024, -34, 0, 12, 7, 4.6);
  truck(B, 45.5, 0.024, -47, 0.15, { tank: true });
  container(B, 31.5, 0.024, -46.5, Math.PI / 2, { mat: 'corrugated_metal#blue' });
  container(B, 31.5, 0.024 + 2.59, -46.7, Math.PI / 2 + 0.03, { mat: 'corrugated_metal#rust' });
  container(B, 31.5, 0.024, -53.5, Math.PI / 2, { mat: 'corrugated_metal#green' });
  for (let i = 0; i < 9; i++) P(['Barrel_01', 'Barrel_02', 'barrel_03'][i % 3], 49.5 + (i % 3) * 0.7 + R.range(-0.1, 0.1), -61.5 + Math.floor(i / 3) * 0.7, R.range(0, 6));
  for (let i = 0; i < 6; i++) P(['Barrel_01', 'barrel_03'][i % 2], 55.5 + (i % 2) * 0.72, -35.5 + Math.floor(i / 2) * 0.72, R.range(0, 6));
  P('Barrel_02', 51.3, -58.4, 0, 1, { tilt: [Math.PI / 2, 0] , y: 0.3});
  for (let i = 0; i < 5; i++) P('old_tyre', 36, -40.5 + (i < 3 ? 0 : 0.8), R.range(0, 6), 1, { y: 0.024 + (i % 3) * 0.17, tilt: [0, 0] });
  P('small_lpg_tank', 50.5, -40, 0.2); P('propane_tank', 51.1, -40.2, 1.2); P('portable_generator', 47, -27, 2.8);
  P('utility_box_02', 64.8, -30, -Math.PI / 2);
  for (let i = 0; i < 4; i++) B.box('wood_planks', 34 + i * 1.3, 0.1, -29, 1.2, 0.14, 1.0, { uv: 'face', col: i < 2 });
  scatterDecals(env, R, 29, 65, -65, -25, { litter: 25, stains: 30, puddles: 8, cracks: 12, dirt: 10, tyres: 6 });
  SB(34, -28.5, 0, 3.2, 7, { thick: true });

  // ======================================================================== SE: car lot + warehouse apron
  const lotCars = [[26.5, 25, 0.2, true], [30.5, 27, -0.4, false], [27, 33, 1.4, true], [33, 36, 1.7, false], [26, 42, 0.1, true], [31, 47, -1.3, true], [26.8, 53, 0.4, false]];
  for (const [x, z, r, b] of lotCars) car(B, x, 0.024, z, r, { burnt: b, seed: x * z });
  container(B, 32, 0.024, 55, 0.3, { long: false, mat: 'corrugated_metal#red' });
  truck(B, 37, 0.024, 24.5, Math.PI / 2 + 0.2, { burnt: true });
  for (let i = 0; i < 6; i++) B.box('wood_planks', 37.2, 0.07 + i * 0.14, 38 + (i % 2) * 0.05, 1.2, 0.13, 1.0, { uv: 'face' });
  for (let i = 0; i < 4; i++) P(i % 2 ? 'wooden_crate_01' : 'wooden_crate_02', 36.8, 42 + i * 0.9, R.range(-0.2, 0.2));
  P('old_military_crate', 36.6, 34.2, 0.1);
  scatterDecals(env, R, 23.5, 36, 22.5, 57.5, { litter: 14, stains: 14, dirt: 12, tyres: 6 });
  scatterDecals(env, R, 36, 66, 22.5, 51.5, { litter: 12, stains: 16, puddles: 5, cracks: 10 });
  tree(env, 22.5, 0, 59, { scale: 1.2 });
  tree(env, 64, 0, 53, { dead: true });

  // ======================================================================== SW alleys
  gardenWall(B, -45, 42.5, -36.5, 42.5, 2.0, [[3.5, 5.0]]);
  gardenWall(B, -45, 24.5, -45, 28.2, 1.9, []);
  gardenWall(B, -22.5, 36.5, -22.5, 40.5, 2.1, [[1.2, 2.6]]);
  shed(B, -40.2, 45.5, 0.1, R); shed(B, -24.6, 57.5, Math.PI, R);
  for (const [x, z] of [[-38.2, 27], [-37.3, 33], [-39, 39], [-22.2, 37.2], [-43.5, 46.5], [-35, 57], [-25.5, 21.5]]) {
    const n = 2 + Math.floor(R.next() * 3);
    for (let i = 0; i < n; i++) P('trashbag', x + R.range(-0.6, 0.6), z + R.range(-0.6, 0.6), R.range(0, 6), R.range(0.8, 1.1), { collide: false });
  }
  for (const [x, z, r] of [[-38.6, 30.5, 0.1], [-21.8, 45, Math.PI / 2], [-44, 25.5, 0.4]]) dumpster(B, x, 0, z, r);
  laundry(B, [-36, 5.2, 30], [-41, 5.6, 30.5], R);
  laundry(B, [-33, 4.5, 38], [-33, 4.2, 41], R);
  laundry(B, [-45, 6.0, 44], [-45, 6.2, 48], R);
  car(B, -39.5, 0, 51.5, 1.62, { seed: 29, paint: 'metal_painted#red' });
  tree(env, -39, 0, 36.8, { scale: 0.9 });
  tree(env, -46.8, 0, 26, { scale: 1.0 });
  tree(env, -20.5, 0, 55.5, { dead: true });
  tree(env, -67, 0, 26, {});
  rubblePile(B, -44.5, 0, 38, 1.2, 0.5, 'brick_red');
  scatterDecals(env, R, -45, -35.5, 22.5, 58, { litter: 30, stains: 8, puddles: 6, dirt: 16, cracks: 6 });
  scatterDecals(env, R, -22, -19.5, 36, 56, { litter: 8, dirt: 6 });

  // ======================================================================== utility poles + wires
  const poleLines = [
    { pts: [[4.1, 26], [4.1, 46], [4.1, 66], [4.1, 86]], ry: Math.PI / 2 },
    { pts: [[-4.1, -26], [-4.1, -46], [-4.1, -66], [-4.1, -86]], ry: Math.PI / 2 },
    { pts: [[-28, -4.1], [-48, -4.1], [-68, -4.1], [-88, -4.1]], ry: 0 },
    { pts: [[28, 4.1], [48, 4.1], [68, 4.1], [88, 4.1]], ry: 0 },
  ];
  const attach = [];
  for (const line of poleLines) {
    let prev = null;
    line.pts.forEach(([x, z], i) => {
      const pts = powerPole(B, x, G(x, z), z, line.ry, { transformer: i === 1, lean: (i === 2 ? 0.04 : 0) });
      if (prev) for (let k = 0; k < 4; k++) wire(B, prev[k], pts[k], k === 3 ? 0.9 : 0.55 + (k * 0.07));
      prev = pts;
      attach.push(pts);
      B.colBox(x, G(x, z) + 4.5, z, 0.3, 9, 0.3, { matKey: 'concrete_wall', surface: 'concrete' }, { ray: true, move: true });
    });
  }
  // service drops from poles to facades + cables across streets
  const drops = [
    [0, [6.5, 7.2, 30]], [0, [6.5, 6.8, 44]], [1, [-6.5, 6.8, -30]], [1, [-6.5, 7.5, -48]], [5, [-6.5, 8.0, 44]],
    [4, [4.5, 7.0, -29]], [8, [-30, 6.5, -7]], [9, [-45, 6.6, -7]], [12, [30, 6.8, 7]], [13, [46, 5.5, 8]],
  ];
  for (const [ai, p] of drops) {
    const a = attach[ai]?.[3];
    if (a) wire(B, a, new THREE.Vector3(...p), 0.6, 0.009);
  }
  const across = [
    [[-6.5, 8.4, 40], [6.5, 8.0, 43]], [[-6.5, 7.4, 58], [6.5, 7.9, 60]], [[-6.5, 9.5, -30], [6.5, 8.8, -33]],
    [[-6.5, 10.5, -50], [6.5, 9.6, -52]], [[-23, 7.0, -10], [-22, 8.2, 10]], [[-40, 7.5, -7], [-41, 6.5, 9]],
    [[23, 8.8, -10], [23, 6.6, 9]], [[45, 6.2, -8], [44, 3.4, 8]], [[-21, 10.5, -22], [-37, 9.5, -20]],
  ];
  for (const [a, b] of across) {
    wire(B, new THREE.Vector3(...a), new THREE.Vector3(...b), 0.7, 0.01);
    wire(B, new THREE.Vector3(a[0], a[1] - 0.35, a[2] + 0.3), new THREE.Vector3(b[0], b[1] - 0.3, b[2] + 0.3), 0.9, 0.008);
  }

  // street lamps
  for (const z of [30, 50]) lampPost(B, -4.2, 0.15, z, Math.PI / 2);
  for (const z of [-32, -52]) lampPost(B, 4.2, 0.15, z, -Math.PI / 2);
  for (const x of [-36, -58]) lampPost(B, x, 0.15, 4.2, Math.PI);
  for (const x of [38, 58]) lampPost(B, x, 0.15, -4.2, 0);

  // ======================================================================== vegetation scatter
  scatterWeeds(env, R);

  // ======================================================================== invisible play-area limits
  const L = PLAY.max - 0.8;
  for (const [x, z, sx, sz] of [[0, -L, 2 * L, 0.4], [0, L, 2 * L, 0.4], [-L, 0, 0.4, 2 * L], [L, 0, 0.4, 2 * L]]) {
    B.colBox(x, 8, z, sx, 30, sz, { object: null, material: null, surface: 'default' }, { ray: false, move: true });
  }
}

// ------------------------------------------------------------------------------------------ helpers
/** Rubble mound + chunks at (x, y, z) in the current frame. */
export function rubblePile(B, x, y, z, radius, height, mat = 'rubble') {
  const rnd = hashRng(x * 12.9898 + z * 78.233);
  const g = new THREE.SphereGeometry(1, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
    const a = Math.atan2(vz, vx);
    const n = 1 + 0.25 * Math.sin(a * 3 + x) + 0.15 * Math.sin(a * 7 + z);
    p.setXYZ(i, vx * radius * n, vy * height * (0.8 + 0.3 * Math.sin(a * 5 + x * z)), vz * radius * 0.8 * n);
  }
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  B.geometry('rubble', g, new THREE.Matrix4().makeTranslation(x, y - 0.05, z), { uv: 'proj' });
  g.dispose();
  const n = Math.round(radius * 10);
  for (let k = 0; k < n; k++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * radius * 1.15;
    const cx = x + Math.cos(a) * r, cz = z + Math.sin(a) * r * 0.8;
    const hh = height * Math.max(0, 1 - (r / radius) ** 2);
    const sz = 0.12 + rnd() * 0.45;
    B.box(rnd() < 0.55 ? mat : 'concrete_wall', cx, y + hh * 0.85 + sz * 0.15, cz, sz * (0.8 + rnd()), sz * (0.4 + rnd() * 0.5), sz * (0.8 + rnd()),
      { rot: [rnd() * 0.8, rnd() * 3, rnd() * 0.8], col: false });
  }
  // a couple of rebar sticks
  for (let k = 0; k < 3; k++) {
    const a = rnd() * 6.28;
    B.cylinder('metal_rusted', [x + Math.cos(a) * radius * 0.4, y + height * 0.5, z + Math.sin(a) * radius * 0.3],
      [x + Math.cos(a) * radius * 0.9, y + height * (0.6 + rnd() * 0.6), z + Math.sin(a) * radius * 0.7], 0.009, 0.009, 4, { col: false });
  }
}

function rubbleRing(B, x, y, z, r, R) {
  for (let k = 0; k < 14; k++) {
    const a = R.range(0, Math.PI * 2), d = r * R.range(0.8, 1.5);
    const s = R.range(0.06, 0.22);
    B.box(R.chance(0.6) ? 'concrete_wall' : 'paving_stones', x + Math.cos(a) * d, y + s * 0.3, z + Math.sin(a) * d, s * 1.4, s * 0.6, s, { rot: [R.range(-0.3, 0.3), R.range(0, 3), R.range(-0.3, 0.3)], col: false });
  }
}

function scatterDecals(env, R, x0, x1, z0, z1, n) {
  const D = (cell, x, z, w, h, rot, mat) => env.decals.add(cell, x, groundAt(x, z) + 0.01, z, w, h, 'y', { rot, mat });
  const rx = () => R.range(x0, x1), rz = () => R.range(z0, z1);
  for (let i = 0; i < (n.litter || 0); i++) { const s = R.range(0.6, 1.5); D(24 + R.int(0, 3), rx(), rz(), s, s, R.range(0, 6)); }
  for (let i = 0; i < (n.cracks || 0); i++) { const s = R.range(1.5, 4); D(12 + R.int(0, 3), rx(), rz(), s, s, R.range(0, 6)); }
  for (let i = 0; i < (n.stains || 0); i++) { const s = R.range(0.8, 2.6); D(16 + R.int(0, 3), rx(), rz(), s, s * R.range(0.6, 1), R.range(0, 6)); }
  for (let i = 0; i < (n.dirt || 0); i++) { const s = R.range(1.5, 4); D(36 + R.int(0, 3), rx(), rz(), s, s, R.range(0, 6)); }
  for (let i = 0; i < (n.puddles || 0); i++) {
    // wet, darkened ground halo under the standing water so the puddle edge reads as soaked, not painted
    const x = rx(), z = rz(), s = R.range(1.2, 3.2), sh = s * R.range(0.5, 0.9), rot = R.range(0, 6);
    D(16 + R.int(0, 3), x, z, s * 1.45, sh * 1.5, rot + R.range(-0.3, 0.3));
    D(28 + R.int(0, 3), x, z, s, sh, rot, 'w:puddle');
  }
  for (let i = 0; i < (n.tyres || 0); i++) { const s = R.range(2, 4); D(56 + R.int(0, 3), rx(), rz(), 2.2, s, R.range(-0.4, 0.4)); }
  for (let i = 0; i < (n.potholes || 0); i++) {
    const x = rx(), z = rz(), s = R.range(0.5, 1.1);
    D(17, x, z, s * 1.6, s * 1.4, R.range(0, 6));
    D(28 + R.int(0, 3), x, z, s, s * 0.8, R.range(0, 6), 'w:puddle');
    for (let k = 0; k < 5; k++) env.B.box('asphalt', x + R.range(-s, s) * 0.7, 0.02, z + R.range(-s, s) * 0.7, R.range(0.05, 0.14), 0.04, R.range(0.05, 0.12), { rot: [0, R.range(0, 3), 0], col: false });
  }
}

function roadMarkings(env, axis, c, a, b) {
  // worn paint (catalog 'road_markings' decal material, world-space wear): centre dashes, edge lines, crosswalk, stop line
  const B = env.B;
  const skip = 63 & ~4; // only the +Y face
  const M = (x, z, w, l, mat = 'road_markings') => {
    if (axis === 'z') B.box(mat, x, 0.013, z, w, 0.004, l, { col: false, shadow: false, skip });
    else B.box(mat, z, 0.013, x, l, 0.004, w, { col: false, shadow: false, skip });
  };
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const end = Math.abs(a) < Math.abs(b) ? a : b;
  const dir = end === a ? 1 : -1;
  const xw = end + dir * 4.2;
  for (let t = lo + 1.5; t < hi - 1.5; t += 7) {
    if ((dir > 0 && t < xw + 1.5) || (dir < 0 && t > xw - 1.5)) continue;
    M(c, t + 1.5, 0.12, 3.0);
  }
  for (const s of [-1, 1]) for (let t = lo + 2; t < hi - 2; t += 12) M(c + s * 3.2, t + 3, 0.1, 6);
  for (let k = -3; k <= 3; k++) M(c + k * 0.95, end + dir * 2.2, 0.5, 3.0);
  M(c + 1.75, end + dir * 4.6, 3.3, 0.3);
  for (let t = a + 9; t < b; t += 17) {
    if (axis === 'z') env.props.place('water_manhole_cover', c + 1.6, 0.0, t, t, 1, { collide: false });
    else env.props.place('water_manhole_cover', t, 0.0, c - 1.6, t, 1, { collide: false });
  }
}

function fence(B, x0, z0, x1, z1, h, wireTop) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const ry = -Math.atan2(z1 - z0, x1 - x0);
  B.pushTR(x0, 0, z0, ry);
  const n = Math.ceil(len / 3);
  for (let i = 0; i <= n; i++) B.cylinder('metal_galvanized', [i * len / n, 0, 0], [i * len / n, h + 0.1, 0], 0.035, 0.035, 6, { col: false });
  B.cylinder('metal_galvanized', [0, h, 0], [len, h, 0], 0.02, 0.02, 5, { col: false });
  B.quad('w:chainlink', [0, 0.05, 0], [len, 0.05, 0], [len, h, 0], [0, h, 0], { uvs: [0, 0, len, 0, len, h, 0, h], uvOff: [0, 0], ray: false, move: true, shadow: true });
  if (wireTop) {
    for (let i = 0; i <= n; i++) B.box('metal_galvanized', i * len / n, h + 0.2, -0.12, 0.03, 0.4, 0.03, { rot: [0.6, 0, 0], col: false });
    for (let k = 0; k < 3; k++) B.cylinder('metal_galvanized', [0, h + 0.1 + k * 0.12, -0.05 - k * 0.08], [len, h + 0.1 + k * 0.12, -0.05 - k * 0.08], 0.004, 0.004, 3, { col: false });
  }
  B.pop();
}

function gardenWall(B, x0, z0, x1, z1, h, gaps) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const ry = -Math.atan2(z1 - z0, x1 - x0);
  B.pushTR(x0, 0, z0, ry);
  const xs = [0, len, ...gaps.flat()].sort((a, b) => a - b);
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i], b = xs[i + 1];
    const mid = (a + b) / 2;
    if (gaps.some(([g0, g1]) => mid > g0 && mid < g1) || b - a < 0.05) continue;
    B.box('brick_red', mid, h / 2, 0, b - a, h, 0.25, { uvOff: [x0, z0] });
    B.box('concrete_wall', mid, h + 0.04, 0, b - a + 0.04, 0.08, 0.32, { col: false });
  }
  B.pop();
}

function shed(B, x, z, ry, R) {
  B.pushTR(x, 0, z, ry);
  const w = 3.2, d = 2.4, h = 2.3;
  B.box('wood_planks', 0, h / 2, -d / 2, w, h, 0.06, { uv: 'face' });
  B.box('wood_planks', -w / 2, h / 2, 0, 0.06, h, d, { uv: 'face' });
  B.box('wood_planks', w / 2, h / 2, 0, 0.06, h, d, { uv: 'face' });
  B.box('wood_planks', -w / 4, h / 2, d / 2, w / 2, h, 0.06, { uv: 'face' });
  B.box('corrugated_metal#rust', 0, h + 0.15, 0, w + 0.4, 0.04, d + 0.5, { rot: [0.12, 0, 0] });
  B.box('wood_planks', w / 4 + 0.2, h / 2 - 0.05, d / 2 + 0.3, 0.9, h - 0.1, 0.04, { rot: [0, 0.8, 0], col: false });
  void R;
  B.pop();
}

function dumpster(B, x, y, z, ry) {
  B.pushTR(x, y, z, ry);
  B.box('metal_painted#green', 0, 0.62, 0, 1.9, 1.05, 1.1);
  B.box('metal_painted#dark', 0, 1.2, -0.2, 1.95, 0.05, 0.75, { rot: [0.5, 0, 0], col: false });
  for (const dx of [-0.8, 0.8]) for (const dz of [-0.45, 0.45]) B.cylinder('rubber', [dx, 0.05, dz], [dx, 0.1, dz], 0.06, 0.06, 6, { col: false });
  B.pop();
}

export function laundry(B, a, b, R) {
  const A = new THREE.Vector3(...a), Bv = new THREE.Vector3(...b);
  wire(B, A, Bv, 0.25, 0.006);
  const len = A.distanceTo(Bv);
  const n = Math.floor(len / 0.62);
  const ry = -Math.atan2(Bv.z - A.z, Bv.x - A.x);
  const tex = B.tex;
  for (let i = 1; i < n; i++) {
    if (R.chance(0.3)) continue;
    const t = i / n;
    const p = new THREE.Vector3().lerpVectors(A, Bv, t);
    p.y -= 0.25 * 4 * t * (1 - t);
    const cell = R.int(0, 7);
    const w = R.range(0.42, 0.62), h = cell === 3 || cell === 5 ? R.range(0.8, 1.0) : R.range(0.5, 0.75);
    const g = new THREE.PlaneGeometry(w, h, 3, 4);
    const pos = g.attributes.position, uv = g.attributes.uv;
    const [u0, v0, du, dv] = tex.laundryCell(cell);
    const ph = R.range(0, 6);
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k), y = pos.getY(k);
      const down = 0.5 - y / h; // 0 at top, 1 at bottom
      pos.setZ(k, Math.sin(x / w * 6 + ph) * 0.025 + down * down * 0.06 * Math.sin(ph));
      pos.setY(k, y - h / 2);
      uv.setXY(k, u0 + uv.getX(k) * du, v0 + uv.getY(k) * dv);
    }
    g.computeVertexNormals();
    B.geometry('w:laundry', g, new THREE.Matrix4().makeRotationY(ry + R.range(-0.12, 0.12)).setPosition(p.x, p.y, p.z), { col: false, uv: 'keep' });
    g.dispose();
  }
}

function ruin(B, cx, cz, w, d, R) {
  // low broken walls of a destroyed house (mantle-able cover), stepped jagged tops
  const segs = [
    [cx - w / 2, cz - d / 2, cx + w / 2, cz - d / 2], [cx + w / 2, cz - d / 2, cx + w / 2, cz + d / 2],
    [cx + w / 2, cz + d / 2, cx - w / 2, cz + d / 2], [cx - w / 2, cz + d / 2, cx - w / 2, cz - d / 2],
    [cx - w / 2, cz, cx, cz],
  ];
  for (const [x0, z0, x1, z1] of segs) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const ry = -Math.atan2(z1 - z0, x1 - x0);
    B.pushTR(x0, 0.02, z0, ry);
    let u = 0;
    while (u < len) {
      const sw = Math.min(len - u, R.range(0.5, 1.6));
      const gap = R.chance(0.18);
      if (!gap) {
        const h = R.range(0.3, 2.4);
        B.box('brick_red', u + sw / 2, h / 2, 0, sw, h, 0.38, { uvOff: [x0, 0] });
        if (R.chance(0.5)) B.box('plaster_painted#pale', u + sw / 2, Math.min(h, 1.2) / 2, 0.2, sw, Math.min(h, 1.2), 0.03, { col: false });
      }
      u += sw;
    }
    B.pop();
  }
  // floor slab remains + debris
  B.box('concrete_floor', cx, 0.1, cz, w - 0.5, 0.18, d - 0.5, { skip: 8 });
  rubblePile(B, cx + w * 0.2, 0.2, cz + d * 0.15, 2.2, 0.9, 'brick_red');
}

/**
 * Plaza clutter pass: weeds in the paving joints, fallen facade slabs, knocked-over market leftovers,
 * dirt drifts against edges. Only small instanced props + a few static slabs (cheap in draw calls).
 */
function plazaClutter(env, R, P, D) {
  const { B } = env;
  const y0 = 0.15;
  const W = (cell, x, z, s) => env.props.place(`foliage${cell}`, x, y0, z, R.range(0, 6.28), s, { collide: false });
  // weeds along the granite border strip + around planters and the fountain rim
  for (let i = 0; i < 90; i++) {
    const t = R.range(-1, 1), side = R.int(0, 3);
    const x = side < 2 ? t * 15.2 : (side === 2 ? -15.2 : 15.2) + R.range(-0.25, 0.25);
    const z = side < 2 ? (side === 0 ? -14.2 : 14.2) + R.range(-0.25, 0.25) : t * 14.2;
    if (Math.abs(x) < 4 && Math.abs(Math.abs(z) - 14.2) < 0.5) continue; // keep the walkways clear-ish
    W(R.int(0, 3), x, z, R.range(0.2, 0.45));
  }
  for (let i = 0; i < 40; i++) {
    const a = R.range(0, Math.PI * 2), r = R.range(5.45, 5.8);
    W(R.int(0, 3), Math.cos(a) * r, -2 + Math.sin(a) * r, R.range(0.2, 0.42));
  }
  // grass clumps in random paving cracks
  for (let i = 0; i < 70; i++) W(R.int(0, 3), R.range(-20, 20), R.range(-19, 19), R.range(0.15, 0.32));
  // fallen facade / pavement slabs (reinforced concrete with rebar), some leaning on cover
  const slabs = [[-18.6, -12.5, 0.3, 0.35], [19, 3.5, 1.2, 0.2], [-19.2, 6.5, 2.0, 0.5], [7.2, 17.8, 0.6, 0.15], [-9.5, -17.8, 2.6, 0.25]];
  for (const [x, z, ry, tilt] of slabs) {
    B.box('concrete_damaged', x, y0 + 0.35, z, 2.2, 0.18, 1.3, { rot: [tilt, ry, tilt * 0.6], col: false });
    B.box('concrete_damaged', x + 0.9, y0 + 0.08, z - 0.5, 1.1, 0.14, 0.8, { rot: [0.05, ry + 0.7, 0.08] });
    for (let k = 0; k < 4; k++) {
      const a = ry + R.range(-0.4, 0.4);
      B.cylinder('rebar_metal', [x + Math.cos(a) * 0.9, y0 + 0.4, z - Math.sin(a) * 0.9], [x + Math.cos(a) * 1.5, y0 + 0.2 + R.range(0.1, 0.7), z - Math.sin(a) * 1.5 + R.range(-0.3, 0.3)], 0.008, 0.008, 4, { col: false, shadow: false });
    }
    rubbleRing(B, x, y0, z, 0.9, R);
    D(36 + R.int(0, 3), x, z, 3.2, 3.2, R.range(0, 6));
  }
  // market leftovers spilling from the SE stalls: toppled chairs, crates, cardboard, trash
  P('plastic_monobloc_chair_01', 11.2, 13.4, 0.7, 1, { tilt: [Math.PI / 2, 0], y: y0 + 0.28, collide: false });
  P('plastic_monobloc_chair_01', 14.6, 12.2, 2.1, 1, { collide: false });
  P('plastic_monobloc_chair_01', 9.8, 15.6, 4.2, 1, { tilt: [0, Math.PI / 2], y: y0 + 0.25, collide: false });
  P('wooden_crate_01', 12.2, 11.8, 0.4, 1); P('wooden_crate_02', 12.4, 12.6, 1.1, 0.8, { tilt: [0.25, 0], collide: false });
  P('wooden_crate_02', 17.8, 11.4, 0.2, 1); P('wooden_crate_01', 17.9, 11.4, 0.5, 0.9, { y: y0 + 0.62, collide: false });
  for (const [x, z] of [[10.5, 12.4], [18.4, 15.2], [-19.4, 17.2], [-20.2, -16.5], [20.1, -9.8]]) {
    const n = 2 + R.int(0, 2);
    for (let k = 0; k < n; k++) P('trashbag', x + R.range(-0.6, 0.6), z + R.range(-0.6, 0.6), R.range(0, 6), R.range(0.8, 1.1), { collide: false });
  }
  for (const [x, z, r] of [[-11.8, -6.5, 0.4], [3.2, 12.2, 1.6], [-16.8, 3.6, 2.4]]) P('old_tyre', x, z, r, 1, { y: y0, collide: false });
  // dirt drifts / windblown grit against the plaza edges and cover
  for (let i = 0; i < 26; i++) {
    const side = R.int(0, 3), t = R.range(-19, 19);
    const x = side === 0 ? -20.6 : side === 1 ? 20.6 : t;
    const z = side === 2 ? -19.6 : side === 3 ? 19.6 : t;
    D(36 + R.int(0, 3), x, z, R.range(2, 4), R.range(1.2, 2.2), side < 2 ? Math.PI / 2 : 0);
  }
}

function scatterWeeds(env, R) {
  const P = (cell, x, z, s) => env.props.place(`foliage${cell}`, x, groundAt(x, z), z, R.range(0, 6.28), s, { collide: false });
  // along the footprint edges of buildings
  for (const info of env.buildings) {
    const { spec } = info;
    if (spec.oob) continue;
    const c = Math.cos(spec.rotY), s = Math.sin(spec.rotY);
    const hw = spec.w / 2 + 0.25, hd = spec.d / 2 + 0.25;
    const per = 2 * (spec.w + spec.d);
    const n = Math.floor(per / 3.5);
    for (let i = 0; i < n; i++) {
      const t = R.next() * per;
      let lx, lz;
      if (t < spec.w) { lx = -hw + t; lz = hd; } else if (t < spec.w + spec.d) { lx = hw; lz = hd - (t - spec.w); } else if (t < 2 * spec.w + spec.d) { lx = hw - (t - spec.w - spec.d); lz = -hd; } else { lx = -hw; lz = -hd + (t - 2 * spec.w - spec.d); }
      const x = spec.x + lx * c + lz * s, z = spec.z - lx * s + lz * c;
      if (x > PLAZA.x0 && x < PLAZA.x1 && z > PLAZA.z0 && z < PLAZA.z1) continue;
      P(R.int(0, 4), x, z, R.range(0.35, 0.8));
    }
  }
  // along curbs
  for (const r of ROADS) {
    const len = r.axis === 'z' ? r.z1 - r.z0 : r.x1 - r.x0;
    const n = Math.floor(Math.min(len, 60) / 2.5);
    for (let i = 0; i < n; i++) {
      const t = R.next();
      const side = R.chance(0.5) ? 0 : 1;
      let x, z;
      if (r.axis === 'z') { x = side ? r.x1 - 0.08 : r.x0 + 0.08; z = r.z0 + t * (r.z1 - r.z0); if (Math.abs(z) > 72) continue; } else { z = side ? r.z1 - 0.08 : r.z0 + 0.08; x = r.x0 + t * (r.x1 - r.x0); if (Math.abs(x) > 72) continue; }
      P(R.int(0, 3), x, z, R.range(0.25, 0.5));
    }
  }
  // lots / yards / vacant ground patches
  const patches = [[-63, -39, -35, -23, 160], [-55, -39, -54, -41, 60], [23.5, 36, 22.5, 58, 70], [29, 65, -65, -25, 90], [-66, -46, 42, 66, 70], [-45, -36, 22, 58, 60], [36, 66, 50, 54, 30], [-20, -8, 35.5, 38.5, 14]];
  for (const [x0, x1, z0, z1, n] of patches) {
    for (let i = 0; i < n; i++) {
      const x = R.range(x0, x1), z = R.range(z0, z1);
      P(R.chance(0.15) ? 4 : R.int(0, 3), x, z, R.range(0.35, 0.9));
    }
  }
  // outside the town: denser dry grass fields
  for (let i = 0; i < 700; i++) {
    const a = R.range(0, Math.PI * 2), d = R.range(76, 110);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (Math.abs(x) < 7 || Math.abs(z) < 7) continue;
    P(R.int(0, 3), x, z, R.range(0.6, 1.3));
  }
}

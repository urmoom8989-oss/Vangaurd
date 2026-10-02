import * as THREE from 'three';
import { ROADS, PLAZA, SIDEWALK_Y } from './town.js';

/**
 * Ground: base terrain, roads, sidewalks + curbs, plaza paving, yards.
 * Ground level is y = 0 (roads, dirt). Sidewalks / plaza are raised SIDEWALK_Y with curb stones.
 */
export function buildGround(env) {
  const { B, rng } = env;
  const sy = SIDEWALK_Y;

  // Base terrain: a large gently undulating dirt ground outside the town core (collision too).
  const size = 600, seg = 120;
  const g = new THREE.PlaneGeometry(size, size, seg, seg);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const r = Math.max(Math.abs(x), Math.abs(z));
    // flat inside the town, rolling hills far outside
    const k = THREE.MathUtils.smoothstep(r, 110, 260);
    const h = k * (6 * Math.sin(x * 0.013 + 1.3) * Math.cos(z * 0.011) + 4 * Math.sin(x * 0.031 + z * 0.02) + 5);
    p.setY(i, h - 0.03);
  }
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  B.geometry('dirt', g, null, { uv: 'proj', shadow: false });
  g.dispose();

  // Roads (asphalt surface slightly above y=0)
  for (const r of ROADS) {
    B.box('asphalt', (r.x0 + r.x1) / 2, -0.05 + 0.005, (r.z0 + r.z1) / 2, r.x1 - r.x0, 0.1, r.z1 - r.z0, { skip: 8 | 1 | 2 | 16 | 32, shadow: false });
  }

  // Sidewalks along roads (outside the plaza), with curbs
  const W = 3.0;
  for (const r of ROADS) {
    if (r.axis === 'z') {
      for (const s of [-1, 1]) {
        const x0 = s < 0 ? r.x0 - W : r.x1, x1 = s < 0 ? r.x0 : r.x1 + W;
        sidewalk(B, x0, x1, r.z0, r.z1, sy, s < 0 ? 'E' : 'W');
      }
    } else {
      for (const s of [-1, 1]) {
        const z0 = s < 0 ? r.z0 - W : r.z1, z1 = s < 0 ? r.z0 : r.z1 + W;
        sidewalk(B, r.x0, r.x1, z0, z1, sy, s < 0 ? 'S' : 'N');
      }
    }
  }

  // Plaza: raised paving with curbs where roads meet it
  const P = PLAZA;
  // large worn concrete slabs (~0.5 m) across the whole plaza; paver texture authored ~8 slabs/m -> scale UVs down
  B.box('paving_stones', (P.x0 + P.x1) / 2, sy / 2 - 0.05, (P.z0 + P.z1) / 2, P.x1 - P.x0, sy + 0.1, P.z1 - P.z0, { skip: 8, uvScale: PLAZA_SLAB_UV, uvOff: [0.37, 0.61], shadow: false });
  // curb stones along the plaza edge where roads enter (only the carriageway width)
  curbX(B, -3.5, 3.5, P.z0, sy, -1);
  curbX(B, -3.5, 3.5, P.z1, sy, 1);
  curbZ(B, P.x0, -3.5, 3.5, sy, -1);
  curbZ(B, P.x1, -3.5, 3.5, sy, 1);
  // a slightly darker inner paved square (older granite setts) for visual structure
  // (catalog 'cobblestone' renders near-black in shade -> smaller, darker concrete setts instead)
  B.box('paving_stones#grey', 0, sy + 0.003, 0, 30, 0.006, 28, { col: false, shadow: false, skip: 1 | 2 | 8 | 16 | 32, uvScale: SETT_UV, uvOff: [0.13, 0.29] });
  // granite border strip around the setts
  for (const s of [-1, 1]) {
    B.box('curb_stone', 0, sy + 0.006, s * 14.2, 30.8, 0.012, 0.4, { col: false, shadow: false, skip: 8 });
    B.box('curb_stone', s * 15.2, sy + 0.006, 0, 0.4, 0.012, 28.8, { col: false, shadow: false, skip: 8 });
  }

  // Yard / lot surfaces (gravel / broken concrete), just above terrain
  const lots = [
    { x0: -64, x1: -38, z0: -55, z1: -40, mat: 'gravel' }, // courtyard
    { x0: 28, x1: 67, z0: -67, z1: -24, mat: 'concrete_floor' }, // fuel depot slab (concrete_pavement/cobblestone render black in shade: AO issue, see PROGRESS)
    { x0: 23, x1: 36, z0: 22, z1: 58, mat: 'gravel' }, // car lot
    { x0: 36, x1: 66, z0: 22, z1: 52, mat: 'concrete_floor' }, // warehouse apron
    { x0: -64, x1: -38, z0: -36, z1: -22, mat: 'gravel' }, // vacant lot
  ];
  for (const l of lots) {
    B.box(l.mat, (l.x0 + l.x1) / 2, 0.012, (l.z0 + l.z1) / 2, l.x1 - l.x0, 0.024, l.z1 - l.z0, { skip: 8, uvOff: [rng.range(0, 9), rng.range(0, 9)], shadow: false });
  }
}

// UV scales (texture sets are authored ~1 repeat/m; the paver set packs many tiny slabs per repeat)
const PLAZA_SLAB_UV = 0.32;
const WALK_SLAB_UV = 0.4;
const SETT_UV = 0.24;

function sidewalk(B, x0, x1, z0, z1, sy, curbSide) {
  B.box('paving_stones', (x0 + x1) / 2, sy / 2 - 0.05, (z0 + z1) / 2, x1 - x0, sy + 0.1, z1 - z0, { skip: 8, shadow: false, uvScale: WALK_SLAB_UV });
  // curb along the road-facing edge
  const cw = 0.22, ch = sy + 0.02;
  if (curbSide === 'E') B.box('curb_stone', x1 - cw / 2, ch / 2 - 0.02, (z0 + z1) / 2, cw, ch + 0.04, z1 - z0, { skip: 8, uv: 'proj' });
  if (curbSide === 'W') B.box('curb_stone', x0 + cw / 2, ch / 2 - 0.02, (z0 + z1) / 2, cw, ch + 0.04, z1 - z0, { skip: 8 });
  if (curbSide === 'S') B.box('curb_stone', (x0 + x1) / 2, ch / 2 - 0.02, z1 - cw / 2, x1 - x0, ch + 0.04, cw, { skip: 8 });
  if (curbSide === 'N') B.box('curb_stone', (x0 + x1) / 2, ch / 2 - 0.02, z0 + cw / 2, x1 - x0, ch + 0.04, cw, { skip: 8 });
}

function curbX(B, x0, x1, z, sy, s) {
  B.box('curb_stone', (x0 + x1) / 2, sy / 2, z - s * 0.11, x1 - x0, sy + 0.02, 0.22, { skip: 8 });
}
function curbZ(B, x, z0, z1, sy, s) {
  B.box('curb_stone', x - s * 0.11, sy / 2, (z0 + z1) / 2, 0.22, sy + 0.02, z1 - z0, { skip: 8 });
}

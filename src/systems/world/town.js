/**
 * Vardanek town layout (data). World axes: +X east, -Z north. Playable ~[-70, 70]^2.
 *
 *            N (−Z)
 *   courtyard | station road (N) | fuel depot
 *   ----------+------PLAZA-------+-----------
 *   alleys    | main street (S)  | warehouse/lot
 *            S (+Z)
 *
 * Buildings are given by world rectangle + the world direction their FRONT faces, faces keyed by world
 * direction. They are converted to the generator's local convention in toSpec().
 */

export const PLAY = { min: -70, max: 70 };
export const PLAZA = { x0: -22, x1: 22, z0: -21, z1: 21, y: 0.15 };
export const SIDEWALK_Y = 0.15;

// Carriageways (asphalt, y = 0). Sidewalks are 3 m on each side.
export const ROADS = [
  { x0: -3.5, x1: 3.5, z0: -140, z1: PLAZA.z0, axis: 'z', name: 'station' },
  { x0: -3.5, x1: 3.5, z0: PLAZA.z1, z1: 140, axis: 'z', name: 'main' },
  { x0: -140, x1: PLAZA.x0, z0: -3.5, z1: 3.5, axis: 'x', name: 'west' },
  { x0: PLAZA.x1, x1: 140, z0: -3.5, z1: 3.5, axis: 'x', name: 'east' },
];

const DIRS = { S: 0, E: Math.PI / 2, N: Math.PI, W: -Math.PI / 2 };
// local face key for each world dir, given the front dir
const FACEMAP = {
  S: { S: 'front', N: 'back', E: 'right', W: 'left' },
  E: { E: 'front', W: 'back', N: 'right', S: 'left' },
  N: { N: 'front', S: 'back', W: 'right', E: 'left' },
  W: { W: 'front', E: 'back', S: 'right', N: 'left' },
};

export function toSpec(b, i) {
  const [x0, x1] = b.x, [z0, z1] = b.z;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const ns = b.front === 'S' || b.front === 'N';
  const w = ns ? x1 - x0 : z1 - z0;
  const d = ns ? z1 - z0 : x1 - x0;
  const fm = FACEMAP[b.front];
  const faces = {};
  for (const [dir, kind] of Object.entries(b.faces || {})) faces[fm[dir]] = kind;
  const damage = (b.damage || []).map((dm) => ({ ...dm, face: fm[dm.dir] }));
  return {
    ...b,
    id: b.id,
    x: cx, z: cz, w, d, rotY: DIRS[b.front],
    faces, damage, seed: b.seed ?? (i * 7919 + 17),
  };
}

// style: panel | plaster | brick | house | industrial
export const BUILDINGS = [
  // ---------------------------------------------------------------- plaza ring
  { id: 'N1', x: [-21, -6.5], z: [-36, -22], front: 'S', floors: 4, style: 'plaster', tint: 'ochre', faces: { S: 'street', E: 'street', N: 'windows', W: 'windows' }, balconies: true,
    damage: [{ dir: 'S', type: 'hole', u: 0.72, v: 7.6, r: 1.1 }] },
  { id: 'N2', x: [6.5, 22], z: [-36, -22], front: 'S', floors: 3, style: 'brick', faces: { S: 'street', W: 'street', N: 'windows', E: 'windows' },
    damage: [{ dir: 'S', type: 'collapse', side: 'end', extent: 0.36, bottom: 4.2 }, { dir: 'E', type: 'collapse', side: 'start', extent: 0.4, bottom: 4.2 }] },
  { id: 'S1', x: [-21, -6.5], z: [22, 35], front: 'E', floors: 2, style: 'brick', faces: { E: 'arcade', N: 'street', S: 'windows', W: 'windows' }, groundH: 4.0 },
  { id: 'S2', x: [6.5, 21], z: [22, 35], front: 'W', floors: 3, style: 'plaster', tint: 'mint', faces: { W: 'street', N: 'street', S: 'windows', E: 'windows' },
    damage: [{ dir: 'N', type: 'hole', u: 0.3, v: 5.4, r: 1.3 }] },
  { id: 'W1', x: [-37, -23], z: [-20, -7], front: 'E', floors: 3, style: 'plaster', tint: 'salmon', faces: { E: 'street', S: 'street', N: 'windows', W: 'windows' }, balconies: true },
  { id: 'W2', x: [-37, -23], z: [7, 20], front: 'E', floors: 2, style: 'brick', faces: { E: 'street', N: 'street', S: 'windows', W: 'windows' }, roof: 'gable' },
  { id: 'E1', x: [23, 38], z: [-20, -7], front: 'W', floors: 5, style: 'panel', faces: { W: 'windows', S: 'windows', N: 'windows', E: 'windows' }, balconies: true,
    damage: [{ dir: 'W', type: 'hole', u: 0.25, v: 9.5, r: 1.4 }, { dir: 'S', type: 'hole', u: 0.6, v: 3.9, r: 1.0 }] },
  { id: 'E2', x: [23, 36], z: [7, 20], front: 'W', floors: 2, style: 'plaster', tint: 'cream', faces: { W: 'street', N: 'street', S: 'windows', E: 'windows' } },

  // ---------------------------------------------------------------- north (station road)
  { id: 'NW1', x: [-22, -6.5], z: [-64, -42], front: 'E', floors: 5, style: 'panel', faces: { E: 'windows', S: 'windows', N: 'windows', W: 'windows' }, balconies: true,
    damage: [{ dir: 'S', type: 'collapse', side: 'start', extent: 0.35, bottom: 6.2 }] },
  { id: 'NE1', x: [6.5, 21], z: [-64, -42], front: 'W', floors: 4, style: 'plaster', tint: 'sky', faces: { W: 'street', S: 'windows', N: 'windows', E: 'windows' }, balconies: true },
  { id: 'NW2', x: [-36, -26], z: [-36, -25], front: 'S', floors: 2, style: 'house', tint: 'cream', faces: { S: 'windows', E: 'windows', N: 'windows', W: 'windows' }, roof: 'gable' },

  // ---------------------------------------------------------------- courtyard compound (NW)
  { id: 'C1', x: [-64, -38], z: [-64, -55], front: 'S', floors: 2, style: 'brick', faces: { S: 'windows', E: 'windows', N: 'blank', W: 'blank' }, roof: 'gable', roofMat: 'corrugated_metal#rust' },
  { id: 'C2', x: [-64, -55], z: [-55, -40], front: 'E', floors: 2, style: 'plaster', tint: 'pale', faces: { E: 'windows', S: 'windows', N: 'party', W: 'blank' },
    damage: [{ dir: 'E', type: 'hole', u: 0.55, v: 1.6, r: 1.0 }] },
  { id: 'W3', x: [-60, -41], z: [-20, -7], front: 'S', floors: 3, style: 'plaster', tint: 'grey', faces: { S: 'street', E: 'windows', N: 'windows', W: 'windows' } },

  // ---------------------------------------------------------------- south-west (market / alleys)
  { id: 'SW1', x: [-19, -6.5], z: [39, 53], front: 'E', floors: 3, style: 'plaster', tint: 'ochre', faces: { E: 'arcade', N: 'windows', S: 'windows', W: 'windows' }, groundH: 4.0 },
  { id: 'SW2', x: [-19, -6.5], z: [57, 69], front: 'E', floors: 2, style: 'brick', faces: { E: 'street', N: 'windows', S: 'windows', W: 'windows' }, roof: 'gable' },
  { id: 'SW3', x: [-36, -24], z: [24, 36], front: 'N', floors: 2, style: 'house', tint: 'salmon', faces: { N: 'windows', E: 'windows', S: 'windows', W: 'windows' }, roof: 'gable' },
  { id: 'SW4', x: [-33, -23], z: [41, 55], front: 'E', floors: 2, style: 'plaster', tint: 'mint', faces: { E: 'windows', N: 'windows', S: 'windows', W: 'windows' } },
  { id: 'SW5', x: [-52, -41], z: [9, 22], front: 'E', floors: 2, style: 'house', tint: 'white', faces: { E: 'windows', N: 'street', S: 'windows', W: 'windows' }, roof: 'gable' },
  { id: 'SW6', x: [-62, -45], z: [29, 41], front: 'N', floors: 3, style: 'panel', faces: { N: 'windows', E: 'windows', S: 'windows', W: 'windows' },
    damage: [{ dir: 'E', type: 'hole', u: 0.4, v: 4.6, r: 1.2 }] },
  { id: 'SW7', x: [-66, -48], z: [48, 64], front: 'E', floors: 2, style: 'brick', faces: { E: 'windows', N: 'windows', S: 'windows', W: 'blank' } },
  { id: 'SW8', x: [-42, -28], z: [59, 69], front: 'N', floors: 1, style: 'house', tint: 'grey', faces: { N: 'garage', E: 'blank', S: 'blank', W: 'blank' }, groundH: 3.4 },

  // ---------------------------------------------------------------- south-east (market, warehouse)
  { id: 'SE1', x: [6.5, 18], z: [39, 54], front: 'W', floors: 3, style: 'plaster', tint: 'cream', faces: { W: 'street', N: 'windows', S: 'windows', E: 'windows' }, balconies: true },
  { id: 'SE2', x: [6.5, 20], z: [58, 69], front: 'W', floors: 2, style: 'plaster', tint: 'salmon', faces: { W: 'street', N: 'windows', S: 'windows', E: 'windows' } },
  { id: 'WH1', x: [38, 62], z: [28, 48], front: 'W', floors: 1, style: 'industrial', faces: { W: 'garage', N: 'sparse', S: 'sparse', E: 'blank' }, groundH: 6.5, wallMat: 'corrugated_metal#grey' },
  { id: 'SE3', x: [42, 64], z: [8, 19], front: 'N', floors: 1, style: 'house', tint: 'grey', faces: { N: 'garage', E: 'blank', S: 'blank', W: 'windows' }, groundH: 3.6 },
  { id: 'SE4', x: [40, 62], z: [55, 67], front: 'N', floors: 2, style: 'brick', faces: { N: 'windows', E: 'windows', S: 'windows', W: 'windows' },
    damage: [{ dir: 'N', type: 'collapse', side: 'end', extent: 0.3, bottom: 3.8 }] },

  // ---------------------------------------------------------------- north-east (depot + east street)
  { id: 'E3', x: [42, 62], z: [-20, -8], front: 'S', floors: 2, style: 'plaster', tint: 'grey', faces: { S: 'street', W: 'windows', N: 'windows', E: 'windows' } },
  { id: 'D1', x: [52, 66], z: [-50, -38], front: 'W', floors: 1, style: 'industrial', faces: { W: 'garage', N: 'sparse', S: 'sparse', E: 'blank' }, groundH: 5.0, wallMat: 'corrugated_metal#rust' },
];

// Buildings outside the playable area (dressing only; simpler interiors, no enterable spaces).
export const OOB_BUILDINGS = [
  { x: [-24, -7], z: [-94, -70], front: 'E', floors: 5, style: 'panel' },
  { x: [7, 24], z: [-92, -72], front: 'W', floors: 4, style: 'plaster', tint: 'cream' },
  { x: [-24, -7], z: [72, 92], front: 'E', floors: 3, style: 'plaster', tint: 'mint' },
  { x: [7, 22], z: [72, 90], front: 'W', floors: 4, style: 'panel' },
  { x: [-95, -72], z: [-24, -7], front: 'S', floors: 4, style: 'plaster', tint: 'ochre' },
  { x: [-94, -72], z: [7, 24], front: 'N', floors: 3, style: 'brick' },
  { x: [72, 94], z: [-24, -7], front: 'S', floors: 5, style: 'panel' },
  { x: [72, 92], z: [7, 24], front: 'N', floors: 3, style: 'plaster', tint: 'salmon' },
  { x: [-96, -72], z: [-70, -40], front: 'E', floors: 5, style: 'panel' },
  { x: [-96, -74], z: [36, 66], front: 'E', floors: 4, style: 'plaster', tint: 'grey' },
  { x: [74, 98], z: [-66, -36], front: 'W', floors: 3, style: 'brick' },
  { x: [74, 96], z: [34, 64], front: 'W', floors: 5, style: 'panel' },
  { x: [-60, -30], z: [-96, -74], front: 'S', floors: 5, style: 'panel' },
  { x: [30, 62], z: [-98, -76], front: 'S', floors: 3, style: 'plaster', tint: 'sky' },
  { x: [-60, -32], z: [74, 96], front: 'N', floors: 4, style: 'plaster', tint: 'cream' },
  { x: [30, 60], z: [74, 94], front: 'N', floors: 5, style: 'panel' },
];

/** Player spawn candidates (plaza — the position the player defends). yaw radians (0 = facing -Z). */
export const PLAYER_SPAWNS = [
  { p: [0, 12.5], yaw: 0 },
  { p: [-8, 14], yaw: 0.25 },
  { p: [8, 14], yaw: -0.25 },
  { p: [-14, 4], yaw: -1.1 },
  { p: [14, -4], yaw: 1.2 },
];

/** AI spawn points on the map edges (waves assault the plaza from here). yaw faces the plaza. */
export const AI_SPAWNS = [
  { p: [0, -66], yaw: 0 }, { p: [-3, -60], yaw: 0 }, { p: [3, -58], yaw: 0 },
  { p: [-50, -48], yaw: -0.8 }, { p: [-44, -44], yaw: -0.8 },
  { p: [46, -44], yaw: 0.8 }, { p: [40, -54], yaw: 0.8 },
  { p: [66, 0], yaw: Math.PI / 2 }, { p: [62, 2], yaw: Math.PI / 2 },
  { p: [-66, 0], yaw: -Math.PI / 2 }, { p: [-62, -2], yaw: -Math.PI / 2 },
  { p: [0, 66], yaw: Math.PI }, { p: [2, 60], yaw: Math.PI },
  { p: [30, 60], yaw: 2.6 }, { p: [-38, 48], yaw: -2.5 },
];

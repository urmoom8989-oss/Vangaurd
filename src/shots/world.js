/**
 * Shot presets owned by the WORLD agent. Names must start with "world-".
 * All use a free camera (no player/weapon) unless noted; lighting/postfx included for the real look.
 */
const ENV = ['materials', 'lighting', 'world', 'postfx'];

export default {
  'world-overview': {
    description: 'High aerial over Vardanek looking north-west across the plaza.',
    only: ENV,
    hud: false,
    camera: { position: [95, 95, 110], target: [-5, 0, -5], hfov: 70, far: 1500 },
    warmup: 6,
  },
  'world-plaza': {
    description: 'Plaza from the south-east corner at elevated eye height: fountain, plinth, emplacements.',
    only: ENV,
    hud: false,
    camera: { position: [17, 3.2, 17], target: [-4, 1.2, -6], hfov: 85 },
    warmup: 6,
  },
  'world-mainstreet': {
    description: 'Main street market arcade looking south from the plaza edge.',
    only: ENV,
    hud: false,
    camera: { position: [1.5, 1.7, 22], target: [-1.5, 1.8, 60], hfov: 85 },
    warmup: 6,
  },
  'world-alley': {
    description: 'Narrow alley in the south-west quarter.',
    only: ENV,
    hud: false,
    camera: { position: [-38.5, 1.7, 23.5], target: [-38.5, 2.0, 52], hfov: 85 },
    warmup: 6,
  },
  'world-courtyard': {
    description: 'Walled courtyard compound (north-west).',
    only: ENV,
    hud: false,
    camera: { position: [-40, 2.2, -42], target: [-55, 1.5, -52], hfov: 85 },
    warmup: 6,
  },
  'world-depot': {
    description: 'Fuel depot / garage on the north-east edge.',
    only: ENV,
    hud: false,
    camera: { position: [30, 2.4, -27], target: [48, 2, -50], hfov: 85 },
    warmup: 6,
  },
  'world-player-eye': {
    description: 'Player at the plaza spawn, eye height, looking north (full game stack).',
    player: { position: [0, null, 12.5], yaw: 0, pitch: -2 },
    weapon: { state: 'hip' },
    warmup: 30,
  },
  // ---- dev close-ups (iteration aids)
  'world-dev-car': { description: 'Close-up: intact sedan in the plaza.', only: ENV, hud: false, camera: { position: [-5.8, 1.6, 18.6], target: [-9.5, 0.7, 15.5], hfov: 70 }, warmup: 6 },
  'world-dev-truck': { description: 'Close-up: canvas military truck on main street.', only: ENV, hud: false, camera: { position: [6.2, 1.9, 24.5], target: [2.3, 1.5, 30], hfov: 75 }, warmup: 6 },
  'world-dev-burnt': { description: 'Close-up: burnt sedan on main street.', only: ENV, hud: false, camera: { position: [4.2, 1.7, 37.2], target: [1.2, 0.6, 41], hfov: 70 }, warmup: 6 },
  'world-dev-bus': { description: 'Close-up: burnt bus in the plaza.', only: ENV, hud: false, camera: { position: [-8.5, 2.2, -2.8], target: [-14.5, 1.3, -8.5], hfov: 75 }, warmup: 6 },
  'world-dev-truckfront': { description: 'Close-up: military truck front quarter.', only: ENV, hud: false, camera: { position: [-4.8, 1.7, 25.6], target: [-0.8, 1.5, 30], hfov: 75 }, warmup: 6 },
  'world-dev-tanker': { description: 'Close-up: fuel tanker in the depot.', only: ENV, hud: false, camera: { position: [39.5, 2.0, -41.5], target: [45.5, 1.6, -47], hfov: 75 }, warmup: 6 },
  'world-dev-pumps': { description: 'Close-up: fuel pumps under the depot canopy.', only: ENV, hud: false, camera: { position: [36.5, 1.7, -28.5], target: [43, 1.4, -34], hfov: 75 }, warmup: 6 },
  'world-street': {
    description: 'Eye-level view down the station road towards the north edge.',
    only: ENV,
    hud: false,
    camera: { position: [1.5, 1.64, -24], target: [-0.5, 2.5, -70], hfov: 85 },
    warmup: 6,
  },
};

// Hip framing candidates v2 (less yaw, gun further right/down, hands visible).
const hip = (pos, rot, fov) => ({
  fn: (a) => { const d = __GAME__.ctx.services.weapons._dev; d.orbit = null; d.WEAPONS.rifle.hip.pos = a.pos; d.WEAPONS.rifle.hip.rot = a.rot; d.VM.fovHip = a.fov; },
  arg: { pos, rot, fov }, frames: 20,
});
const C0 = [
  [[0.074, -0.112, -0.29], [3.5, 19, -6], 58],
  [[0.11, -0.13, -0.30], [2, 6, -4], 62],
  [[0.12, -0.135, -0.32], [2, 4, -3], 66],
  [[0.105, -0.125, -0.28], [3, 8, -5], 66],
  [[0.13, -0.14, -0.30], [1.5, 3, -2], 70],
  [[0.115, -0.13, -0.26], [2.5, 5, -4], 72],
];
const C = [
  [[0.145, -0.10, -0.31], [-1.5, 11, -5], 70],
  [[0.13, -0.095, -0.28], [-2, 9, -8], 68],
  [[0.15, -0.105, -0.30], [-2.5, 13, -4], 66],
  [[0.14, -0.09, -0.29], [-1, 10, -10], 72],
  [[0.16, -0.11, -0.33], [-2, 14, -6], 70],
  [[0.135, -0.10, -0.27], [-3, 12, -7], 64],
];
export default {
  preset: 'weapons-hip',
  only: 'materials,lighting,world,postfx,player,weapons,vfx,hud',
  cols: 3,
  steps: C.map((c, i) => ({ name: `hip${i}`, ...hip(c[0], c[1], c[2]) })),
};

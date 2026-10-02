// Hip framing candidates (live-edits WEAPONS.rifle.hip through the dev hook).
const hip = (pos, rot, fov = 78) => ({
  fn: (a) => { const d = __GAME__.ctx.services.weapons._dev; d.orbit = null; d.WEAPONS.rifle.hip.pos = a.pos; d.WEAPONS.rifle.hip.rot = a.rot; d.VM.fovHip = a.fov; },
  arg: { pos, rot, fov }, frames: 20,
});
const C = [
  [[0.075, -0.12, -0.29], [4, 20, -4], 58],
  [[0.08, -0.125, -0.31], [4, 24, -5], 55],
  [[0.07, -0.115, -0.28], [3, 18, -8], 60],
  [[0.09, -0.13, -0.30], [5, 28, -6], 55],
  [[0.10, -0.13, -0.34], [4, 22, -4], 52],
  [[0.085, -0.12, -0.33], [3, 30, -3], 55],
];
export default {
  preset: 'weapons-hip',
  only: 'materials,lighting,world,postfx,player,weapons,vfx,hud',
  steps: C.map((c, i) => ({ name: `hip${i}`, ...hip(c[0], c[1], c[2]) })),
};

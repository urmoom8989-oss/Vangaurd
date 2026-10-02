// Session 4: pistol hip framing (hands must be visible).
const set = (a) => {
  const g = __GAME__.ctx; const d = g.services.weapons._dev; d.orbit = null;
  g.services.weapons.setPose(a.state, 0);
  if (a.hip) d.WEAPONS.pistol.hip = { pos: a.hip[0], rot: a.hip[1] };
};
const H = [
  [[0.07, -0.075, -0.27], [3, 4, -2]],
  [[0.06, -0.065, -0.28], [4, 6, -4]],
  [[0.08, -0.085, -0.30], [2, 5, -3]],
];
export default {
  preset: 'weapons-pistol-hip',
  only: 'materials,lighting,world,postfx,player,weapons,vfx,hud',
  cols: 2,
  steps: [
    ...H.map((h, i) => ({ name: `phip${i}`, fn: set, arg: { state: 'hip', hip: h }, frames: 30 })),
    { name: 'pads', fn: set, arg: { state: 'ads' }, frames: 30 },
  ],
};

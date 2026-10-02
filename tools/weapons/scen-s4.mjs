// Session 4: glass fix check, ADS eye relief, sprint + tac-sprint pose candidates.
const set = (a) => {
  const g = __GAME__.ctx; const d = g.services.weapons._dev; d.orbit = null;
  g.services.weapons.setPose(a.state, 0);
  const r = d.WEAPONS.rifle;
  if (a.er) r.eyeRelief = a.er;
  if (a.sprint) r.sprint = { pos: a.sprint[0], rot: a.sprint[1] };
  if (a.tac) r.tac = { pos: a.tac[0], rot: a.tac[1] };
};
const S = [
  [[0.10, -0.035, -0.30], [-18, 35, 30]],
  [[0.07, -0.02, -0.28], [-22, 45, 25]],
  [[0.12, -0.045, -0.32], [-12, 30, 40]],
];
const T = [
  [[0.13, -0.06, -0.33], [30, 8, 22]],
  [[0.12, -0.07, -0.32], [40, 10, 35]],
  [[0.10, -0.05, -0.34], [34, 14, 28]],
];
export default {
  preset: 'weapons-hip',
  only: 'materials,lighting,world,postfx,player,weapons,vfx,hud',
  cols: 3,
  steps: [
    
    { name: 'ads-er10', fn: set, arg: { state: 'ads', er: 0.1 }, frames: 30, clip: [660, 300, 600, 480] },
    //...S.map((s, i) => ({ name: `spr${i}`, fn: set, arg: { state: 'sprint', sprint: s }, frames: 40 })),
    ...T.map((s, i) => ({ name: `tac${i}`, fn: set, arg: { state: 'tacsprint', tac: s }, frames: 40 })),
  ],
};

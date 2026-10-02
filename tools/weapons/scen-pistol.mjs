// Pistol rig audit: first person + orbit views on a neutral backdrop.
const orbit = (o) => ({ fn: (a) => { const d = __GAME__.ctx.services.weapons._dev; d.backdrop = true; d.orbit = a; }, arg: o, frames: 2 });
const T = [0.07, -0.1, -0.25];
export default {
  preset: 'weapons-pistol-hip',
  only: 'materials,lighting,world,postfx,player,weapons',
  cols: 3,
  steps: [
    { name: 'p-fp', frames: 2 },
    { name: 'p-side', ...orbit({ yaw: 90, pitch: 5, dist: 0.6, target: T, hfov: 45 }) },
    { name: 'p-left', ...orbit({ yaw: -90, pitch: 5, dist: 0.6, target: T, hfov: 45 }) },
    { name: 'p-top', ...orbit({ yaw: 10, pitch: 70, dist: 0.6, target: T, hfov: 45 }) },
    { name: 'p-front', ...orbit({ yaw: 160, pitch: 10, dist: 0.6, target: T, hfov: 45 }) },
    { name: 'p-back', ...orbit({ yaw: 0, pitch: 15, dist: 0.7, target: T, hfov: 60 }) },
  ],
};

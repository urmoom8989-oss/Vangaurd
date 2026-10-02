// Arms/hands audit: orbit the hip rig from several angles, then first-person views of main states.
const orbit = (o) => ({ fn: (a) => { __GAME__.ctx.services.weapons._dev.orbit = a; }, arg: o, frames: 2 });
const pose = (st, pr = 0) => ({ fn: (a) => { const w = __GAME__.ctx.services.weapons; w._dev.orbit = null; w.setPose(a.st, a.pr); }, arg: { st, pr }, frames: 30 });
export default {
  preset: 'weapons-hip',
  only: 'materials,lighting,world,postfx,player,weapons,vfx',
  steps: [
    { name: 'o-left', ...orbit({ yaw: -80, pitch: 5, dist: 0.55, target: [0.06, -0.1, -0.3], hfov: 60 }) },
    { name: 'o-right', ...orbit({ yaw: 80, pitch: 5, dist: 0.55, target: [0.06, -0.1, -0.3], hfov: 60 }) },
    { name: 'o-below', ...orbit({ yaw: 30, pitch: -60, dist: 0.5, target: [0.06, -0.1, -0.3], hfov: 60 }) },
    { name: 'o-front', ...orbit({ yaw: 160, pitch: 10, dist: 0.6, target: [0.06, -0.1, -0.3], hfov: 60 }) },
    { name: 'o-rhand', ...orbit({ yaw: 70, pitch: -15, dist: 0.22, target: [0.1, -0.16, -0.24], hfov: 50 }) },
    { name: 'o-lhand', ...orbit({ yaw: -70, pitch: -15, dist: 0.25, target: [0.07, -0.16, -0.43], hfov: 50 }) },
    { name: 'fp-hip', ...pose('hip') },
  ],
};

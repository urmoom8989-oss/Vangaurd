// Hands close-up audit (hip pose): right hand + left hand from several sides, neutral backdrop.
const orbit = (o) => ({ fn: (a) => { const d = __GAME__.ctx.services.weapons._dev; d.backdrop = true; d.orbit = a; }, arg: o, frames: 2 });
// gun space -> rig space depends on the hip pose; targets given in rig space
const RH = [0.075, -0.2, -0.3], LH = [0.0, -0.2, -0.58];
export default {
  preset: 'weapons-hip',
  only: 'materials,lighting,world,postfx,player,weapons',
  steps: [
    { name: 'rh-right', ...orbit({ yaw: 90, pitch: 0, dist: 0.45, target: RH, hfov: 45 }) },
    { name: 'rh-left', ...orbit({ yaw: -90, pitch: 0, dist: 0.45, target: RH, hfov: 45 }) },
    { name: 'rh-top', ...orbit({ yaw: 20, pitch: 60, dist: 0.45, target: RH, hfov: 45 }) },
    { name: 'rh-front', ...orbit({ yaw: 150, pitch: -10, dist: 0.45, target: RH, hfov: 45 }) },
    { name: 'lh-left', ...orbit({ yaw: -90, pitch: 0, dist: 0.45, target: LH, hfov: 45 }) },
    { name: 'lh-right', ...orbit({ yaw: 90, pitch: 0, dist: 0.45, target: LH, hfov: 45 }) },
    { name: 'lh-top', ...orbit({ yaw: -20, pitch: 60, dist: 0.45, target: LH, hfov: 45 }) },
    { name: 'lh-front', ...orbit({ yaw: -150, pitch: -10, dist: 0.45, target: LH, hfov: 45 }) },
    { name: 'fp', fn: () => { const d = __GAME__.ctx.services.weapons._dev; d.orbit = null; d.backdrop = false; }, frames: 2 },
  ],
};

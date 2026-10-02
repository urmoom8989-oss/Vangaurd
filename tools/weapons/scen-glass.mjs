const crop = [900, 560, 700, 420];
const m = (f) => ({ fn: f, frames: 2, clip: crop });
export default {
  preset: 'weapons-hip',
  only: 'materials,lighting,world,postfx,player,weapons',
  steps: [
    { name: 'g-on', ...m(() => {}) },
    { name: 'g-op0', ...m(() => { const g = __GAME__.ctx.services.weapons._dev.get(); g.cur.parts.reticlePane.material.opacity = 0.0; }) },
    { name: 'g-irid0', ...m(() => { const g = __GAME__.ctx.services.weapons._dev.get(); const mt = g.cur.parts.reticlePane.material; mt.iridescence = 0; mt.opacity = 0.12; mt.needsUpdate = true; }) },
    { name: 'g-ret0', ...m(() => { const g = __GAME__.ctx.services.weapons._dev.get(); const mt = g.cur.parts.reticlePane.material; mt.userData.wpnUniforms.uReticleOn.value = 0; }) },
  ],
};

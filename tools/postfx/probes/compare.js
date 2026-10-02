// Same-run A/B: postfx off vs on (and the plain AgX look), identical simulation state.
const pf = G.ctx.services.postfx;
await __probeShot('ab-on');
pf.setEnabled(false);
await G.advanceFrames(1);
await __probeShot('ab-off');
pf.setEnabled(true);
await G.advanceFrames(24);
await __probeShot('ab-on2');
return pf.stats;

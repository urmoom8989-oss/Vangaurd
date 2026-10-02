// Sample real-time frame durations for 5 s and report long frames with the postfx stats at that time.
const pf = G.ctx.services.postfx;
const times = [];
let last = performance.now();
const t0 = last;
const long = [];
await new Promise((resolve) => {
  function tick() {
    const now = performance.now();
    const d = now - last;
    last = now;
    times.push(d);
    if (d > 50) long.push({ at: Math.round(now - t0), ms: Math.round(d), stats: JSON.parse(JSON.stringify(pf.stats || {})), programs: G.ctx.renderer.info.programs.length });
    if (now - t0 < 5000) requestAnimationFrame(tick); else resolve();
  }
  requestAnimationFrame(tick);
});
times.sort((a, b) => a - b);
return { n: times.length, p50: times[times.length >> 1], p95: times[Math.floor(times.length * 0.95)], long: long.slice(0, 20) };

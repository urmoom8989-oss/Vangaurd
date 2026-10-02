// Per-mesh triangle breakdown of the world root. Usage: node tools/world/probe.mjs world-overview tools/world/stats.js
const root = world.root;
const rows = [];
let total = 0, shadowTotal = 0, draws = 0;
root.traverse((o) => {
  if (!o.isMesh) return;
  const g = o.geometry;
  const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
  const inst = o.isInstancedMesh ? o.count : 1;
  const t = tris * inst;
  total += t; draws++;
  if (o.castShadow) shadowTotal += t;
  rows.push({ name: o.name, tris: Math.round(tris), inst, total: Math.round(t), shadow: o.castShadow, mat: (o.material && o.material.name) || '' });
});
rows.sort((a, b) => b.total - a.total);
return { total: Math.round(total), shadowTotal: Math.round(shadowTotal), draws, top: rows.slice(0, 45), stats: window.__WORLD_STATS__ && window.__WORLD_STATS__.meshes };

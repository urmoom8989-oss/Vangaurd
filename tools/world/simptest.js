const { SimplifyModifier } = await import('/node_modules/three/examples/jsm/modifiers/SimplifyModifier.js');
const out = [];
for (const name of ['world:prop:trashbag', 'world:prop:water_manhole_cover', 'world:prop:wooden_crate_02', 'world:prop:Barrel_01']) {
  const m = world.root.getObjectByName(name);
  if (!m) { out.push({ name, missing: true }); continue; }
  const g = m.geometry;
  const tris = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
  const t0 = performance.now();
  let s; try { s = await new SimplifyModifier().modify(g, Math.floor(g.attributes.position.count * 0.75)); } catch (e) { out.push({ name, err: String(e), attrs: Object.keys(g.attributes) }); continue; }
  if (!s.attributes.position) { out.push({ name, noPos: true, keys: Object.keys(s.attributes), gk: Object.keys(g.attributes) }); continue; }
  const dt = performance.now() - t0;
  out.push({ name, tris, verts: g.attributes.position.count, after: s.index ? s.index.count / 3 : s.attributes.position.count / 3, ms: Math.round(dt), attrs: Object.keys(s.attributes) });
}
return out;

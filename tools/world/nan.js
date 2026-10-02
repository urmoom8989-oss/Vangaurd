// Scan world meshes for NaN/Infinity in position/normal/uv.
const bad = [];
world.root.traverse((o) => {
  if (!o.isMesh) return;
  for (const k of ['position', 'normal', 'uv']) {
    const a = o.geometry.attributes[k];
    if (!a) continue;
    let n = 0, first = -1;
    for (let i = 0; i < a.array.length; i++) if (!Number.isFinite(a.array[i])) { n++; if (first < 0) first = i; }
    if (n) bad.push({ name: o.name, attr: k, n, first, count: a.count });
  }
});
return bad;

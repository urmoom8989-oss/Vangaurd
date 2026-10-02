// Downloads CC0 Poly Haven models (gltf, 1k textures) into public/assets/world/models/<id>/
// Usage: node tools/world/fetch-polyhaven.mjs [id ...]
import fs from 'node:fs';
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, 'public/assets/world/models');
const DEFAULT = [
  'Barrel_01', 'Barrel_02', 'barrel_03', 'metal_jerrycan_green', 'metal_trash_can', 'old_tyre',
  'utility_box_01', 'utility_box_02', 'wooden_crate_01', 'wooden_crate_02', 'old_military_crate',
  'trashbag', 'cement_bag', 'propane_tank', 'portable_generator', 'rollershutter_door',
  'rollershutter_window_01', 'rollershutter_window_02', 'weed_plant_02', 'dry_branches_medium_01',
  'security_light', 'plastic_monobloc_chair_01', 'ammo_box', 'small_lpg_tank', 'water_manhole_cover',
];
const RES = process.env.RES || '1k';
const ids = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;

async function get(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { if (i === 3) throw e; await new Promise((r) => setTimeout(r, 1000 * (i + 1))); }
  }
}

for (const id of ids) {
  const dir = path.join(OUT, id);
  if (fs.existsSync(path.join(dir, `${id}.gltf`))) { console.log('skip', id); continue; }
  const files = JSON.parse((await get(`https://api.polyhaven.com/files/${id}`)).toString());
  const g = files.gltf?.[RES]?.gltf || files.gltf?.['1k']?.gltf;
  if (!g) { console.log('no gltf', id); continue; }
  fs.mkdirSync(dir, { recursive: true });
  let total = 0;
  for (const [rel, f] of Object.entries(g.include || {})) {
    const buf = await get(f.url);
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf); total += buf.length;
  }
  const gl = await get(g.url);
  fs.writeFileSync(path.join(dir, `${id}.gltf`), gl);
  total += gl.length;
  console.log('ok', id, (total / 1e6).toFixed(2), 'MB');
}

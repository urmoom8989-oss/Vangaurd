#!/usr/bin/env node
/**
 * Offline soldier geometry baker (owner: ai).
 *   node tools/ai/bake.mjs
 * Builds every soldier variant x LOD with the runtime sculpt code, bakes per-vertex AO on LOD0 (BVH
 * hemisphere rays), transfers it to the lower LODs, and writes the packed container to
 * public/assets/ai/soldiers.bin (loaded by src/systems/ai/character/factory.js).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const { buildSoldierGeometry } = await imp('src/systems/ai/character/soldier.js');
const { bakeAO, transferAO } = await imp('src/systems/ai/character/ao.js');
const { packArrays, writeContainer } = await imp('src/systems/ai/character/pack.js');
const { VARIANTS, LOD_Q } = await imp('src/systems/ai/character/factory.js');

const entries = [];
for (const v of VARIANTS) {
  const t0 = Date.now();
  const lods = LOD_Q.map((q) => buildSoldierGeometry({ q, variant: v }));
  bakeAO(lods[0], { rays: 24, maxDist: 0.2 });
  for (let l = 1; l < lods.length; l++) transferAO(lods[0], lods[l]);
  lods.forEach((g, l) => entries.push([`${v.name}:${l}`, packArrays(g)]));
  console.log(`${v.name}: ${lods.map((g) => g.index.count / 3).join(' / ')} tris, ${Date.now() - t0} ms`);
}
const out = writeContainer(entries);
const file = path.join(ROOT, 'public/assets/ai/soldiers.bin');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, out);
console.log(`wrote ${file} (${(out.byteLength / 1048576).toFixed(2)} MB)`);

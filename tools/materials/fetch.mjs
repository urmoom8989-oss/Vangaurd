/**
 * Download the CC0 Poly Haven source textures used by the materials bake.
 *
 *   node tools/materials/fetch.mjs [id ...]
 *
 * Sources (2k JPG: diffuse, GL normal, ARM, displacement) go to a cache OUTSIDE the repo
 * (env MATERIALS_CACHE, default <os tmp>/opus-of-duty-materials-src) so only the compact baked
 * .omat files end up in public/assets/materials/. The neutral gallery HDRI goes to
 * public/assets/materials/hdri/.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SETS, HDRIS } from './sets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE = process.env.MATERIALS_CACHE || path.join(os.tmpdir(), 'opus-of-duty-materials-src');
const API = 'https://api.polyhaven.com';

async function getJson(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'opus-of-duty-materials-bake' } });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      if (i === 3) throw e;
      await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }
  }
}

async function download(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return false;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'opus-of-duty-materials-bake' } });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.part', buf);
      fs.renameSync(file + '.part', file);
      return true;
    } catch (e) {
      if (i === 3) throw e;
      await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
    }
  }
}

const MAPS = [
  ['Diffuse', 'diff'],
  ['nor_gl', 'nor'],
  ['arm', 'arm'],
  ['Rough', 'rough'],
  ['AO', 'ao'],
  ['Metal', 'metal'],
  ['Displacement', 'disp'],
];

export async function fetchSet(id) {
  const dir = path.join(CACHE, id);
  fs.mkdirSync(dir, { recursive: true });
  const infoFile = path.join(dir, 'info.json');
  if (!fs.existsSync(infoFile)) {
    const info = await getJson(`${API}/info/${id}`);
    fs.writeFileSync(infoFile, JSON.stringify(info, null, 1));
  }
  const filesFile = path.join(dir, 'files.json');
  let files;
  if (fs.existsSync(filesFile)) files = JSON.parse(fs.readFileSync(filesFile, 'utf8'));
  else {
    files = await getJson(`${API}/files/${id}`);
    fs.writeFileSync(filesFile, JSON.stringify(files));
  }
  const got = [];
  for (const [key, short] of MAPS) {
    const e = files[key]?.['2k']?.jpg || files[key]?.['2k']?.png;
    if (!e) continue;
    // arm covers rough/ao/metal: only fetch the separate maps when arm is missing
    if (['rough', 'ao', 'metal'].includes(short) && files.arm?.['2k']) continue;
    const ext = e.url.endsWith('.png') ? 'png' : 'jpg';
    const file = path.join(dir, `${short}.${ext}`);
    const fresh = await download(e.url, file);
    got.push(short + (fresh ? '*' : ''));
  }
  return got;
}

export async function fetchHdri(id, res = '1k') {
  const outDir = path.join(ROOT, 'public', 'assets', 'materials', 'hdri');
  const files = await getJson(`${API}/files/${id}`);
  const e = files.hdri?.[res]?.hdr;
  if (!e) throw new Error(`no ${res} hdr for ${id}`);
  await download(e.url, path.join(outDir, `${id}_${res}.hdr`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const only = process.argv.slice(2);
  const ids = only.length ? only : Object.keys(SETS);
  console.error(`[materials:fetch] cache ${CACHE}`);
  let n = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (n < ids.length) {
      const id = ids[n++];
      try {
        const got = await fetchSet(id);
        console.error(`[materials:fetch] ${id}: ${got.join(' ')}`);
      } catch (e) {
        console.error(`[materials:fetch] ${id} FAILED: ${e.message}`);
      }
    }
  }));
  if (!only.length) for (const [id, o] of Object.entries(HDRIS)) await fetchHdri(id, o.res);
  console.error('[materials:fetch] done');
}

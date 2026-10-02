import * as THREE from 'three';
import { buildSoldierGeometry } from './soldier.js';
import { packArrays, geometryFromPacked, readContainer } from './pack.js';
import { createSoldierMaterial, disposeDetailTexture } from './material.js';
import { M } from './ids.js';

/**
 * Soldier asset factory: geometry variants x LODs (baked offline by tools/ai/bake.mjs into
 * /assets/ai/soldiers.bin, runtime-built as a fallback) and a handful of tinted uber-materials.
 */

export const VARIANTS = [
  { name: 'helmet_glasses', helmet: 'helmet', glasses: true },
  { name: 'helmet', helmet: 'helmet', glasses: false },
  { name: 'headset', helmet: 'headset', glasses: true },
];
export const LOD_Q = [1, 0.5, 0.25];
export const BAKE_URL = '/assets/ai/soldiers.bin';

// per-soldier colour variation (fatigues / vest / helmet cover) — all dark, desaturated
const TINTS = [
  { [M.FATIGUE]: 0x4a4b3e, [M.VEST]: 0x2d3024, [M.HELMET]: 0x373a2e },
  { [M.FATIGUE]: 0x3f403c, [M.VEST]: 0x3b3a2c, [M.HELMET]: 0x30312d },
  { [M.FATIGUE]: 0x4d4a3c, [M.VEST]: 0x25271f, [M.HELMET]: 0x3a3a30, [M.KNIT]: 0x1b1b19 },
  { [M.FATIGUE]: 0x434638, [M.VEST]: 0x44402f, [M.HELMET]: 0x34372b },
];

export class SoldierFactory {
  constructor(ctx) {
    this.ctx = ctx;
    this.geometries = []; // [variant][lod]
    this.materials = [];
    this.baked = false;
    this.stats = { tris: [], loadMs: 0 };
  }

  async load() {
    const t0 = performance.now();
    let map = null;
    try {
      const buf = await this.ctx.assets.arrayBuffer(BAKE_URL);
      map = readContainer(buf);
    } catch { map = null; }
    this.baked = !!map;
    for (let v = 0; v < VARIANTS.length; v++) {
      const lods = [];
      for (let l = 0; l < LOD_Q.length; l++) {
        const key = `${VARIANTS[v].name}:${l}`;
        let packed = map?.get(key);
        if (!packed) {
          const g = buildSoldierGeometry({ q: LOD_Q[l], variant: VARIANTS[v] });
          packed = packArrays(g);
          g.dispose();
          // yield so the page stays responsive during the fallback build
          await new Promise((r) => setTimeout(r, 0));
        }
        lods.push(geometryFromPacked(packed));
      }
      this.geometries.push(lods);
    }
    this.stats.tris = this.geometries[0].map((g) => g.index.count / 3);
    for (const tints of TINTS) this.materials.push(createSoldierMaterial({ tints }));
    this.stats.loadMs = performance.now() - t0;
    return this;
  }

  dispose() {
    for (const lods of this.geometries) for (const g of lods) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    disposeDetailTexture();
  }
}

export { THREE };

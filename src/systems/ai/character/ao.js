import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { B } from './rig.js';

/**
 * Per-vertex ambient occlusion baked on the bind pose with a BVH (hemisphere rays).
 * Vertices are split into groups (body / arms / weapon) that only occlude themselves, because
 * in the bind pose the arms hang beside the torso and the rifle floats in front of the chest.
 * Writes aData.y.
 */

const ARM_BONES = new Set(['upperarmL', 'forearmL', 'handL', 'upperarmR', 'forearmR', 'handR'].map((n) => B[n]));
const WEAPON_BONES = new Set([B.weapon, B.mag]);

function groupOf(si, sw, i) {
  // dominant bone
  let best = 0, bw = -1;
  for (let k = 0; k < 4; k++) if (sw[i * 4 + k] > bw) { bw = sw[i * 4 + k]; best = si[i * 4 + k]; }
  if (WEAPON_BONES.has(best)) return 2;
  if (ARM_BONES.has(best)) return 1;
  return 0;
}

// cosine-weighted hemisphere directions (Fibonacci)
function hemiDirs(n) {
  const out = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    const r = Math.sqrt(u);
    const a = i * ga;
    out.push([r * Math.cos(a), r * Math.sin(a), Math.sqrt(1 - u)]);
  }
  return out;
}

export function bakeAO(geometry, { rays = 14, maxDist = 0.16, startVertex = 0, strength = 1 } = {}) {
  const pos = geometry.attributes.position.array;
  const nrm = geometry.attributes.normal.array;
  const si = geometry.attributes.skinIndex.array;
  const sw = geometry.attributes.skinWeight.array;
  const data = geometry.attributes.aData.array;
  const index = geometry.index.array;
  const vcount = pos.length / 3;
  const group = new Uint8Array(vcount);
  for (let i = 0; i < vcount; i++) group[i] = groupOf(si, sw, i);

  // one BVH per group
  const bvhs = [];
  for (let g = 0; g < 3; g++) {
    const idx = [];
    for (let t = 0; t < index.length; t += 3) {
      const a = index[t], b = index[t + 1], c = index[t + 2];
      if (group[a] === g || group[b] === g || group[c] === g) idx.push(a, b, c);
    }
    if (!idx.length) { bvhs.push(null); continue; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    bvhs.push({ bvh: new MeshBVH(geo, { targetLeafSize: 8 }), geo });
  }

  const dirs = hemiDirs(rays);
  const ray = new THREE.Ray();
  const n = new THREE.Vector3(), t = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
  for (let i = startVertex; i < vcount; i++) {
    const entry = bvhs[group[i]];
    if (!entry) continue;
    n.set(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]);
    // tangent frame with a per-vertex rotation to decorrelate the pattern
    if (Math.abs(n.y) < 0.9) t.set(0, 1, 0); else t.set(1, 0, 0);
    b.crossVectors(n, t).normalize();
    t.crossVectors(b, n).normalize();
    const rot = ((i * 2654435761) >>> 0) / 4294967296 * Math.PI * 2;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    let occ = 0, wsum = 0;
    for (const [x0, y0, z0] of dirs) {
      const x = x0 * cr - y0 * sr, y = x0 * sr + y0 * cr;
      d.set(0, 0, 0).addScaledVector(t, x).addScaledVector(b, y).addScaledVector(n, z0).normalize();
      ray.origin.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).addScaledVector(n, 0.0015);
      ray.direction.copy(d);
      const hit = entry.bvh.raycastFirst(ray, THREE.DoubleSide, 0, maxDist);
      const w = 1;
      wsum += w;
      if (hit) occ += w * (1 - hit.distance / maxDist) ** 0.5;
    }
    const ao = 1 - (occ / wsum) * strength;
    data[i * 4 + 1] = Math.max(0.15, Math.min(1, ao));
  }
  for (const e of bvhs) e?.geo.dispose();
  geometry.attributes.aData.needsUpdate = true;
}

/** Copy AO from a detailed geometry to a lower LOD by nearest vertex (spatial hash). */
export function transferAO(src, dst) {
  const sp = src.attributes.position.array, sd = src.attributes.aData.array;
  const dp = dst.attributes.position.array, dd = dst.attributes.aData.array;
  const cell = 0.02;
  const grid = new Map();
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < sp.length / 3; i++) {
    const k = key(sp[i * 3], sp[i * 3 + 1], sp[i * 3 + 2]);
    let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(i);
  }
  for (let i = 0; i < dp.length / 3; i++) {
    const x = dp[i * 3], y = dp[i * 3 + 1], z = dp[i * 3 + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let best = -1, bd = Infinity;
    for (let r = 0; r <= 2 && best < 0; r++) {
      for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) for (let c = -r; c <= r; c++) {
        const l = grid.get(`${cx + a},${cy + b},${cz + c}`);
        if (!l) continue;
        for (const j of l) {
          // only match same material to avoid bleeding across layers
          if (Math.round(sd[j * 4]) !== Math.round(dd[i * 4])) continue;
          const dx = sp[j * 3] - x, dy = sp[j * 3 + 1] - y, dz = sp[j * 3 + 2] - z;
          const dist = dx * dx + dy * dy + dz * dz;
          if (dist < bd) { bd = dist; best = j; }
        }
      }
    }
    if (best >= 0) dd[i * 4 + 1] = sd[best * 4 + 1];
  }
  dst.attributes.aData.needsUpdate = true;
}

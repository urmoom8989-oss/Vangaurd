import * as THREE from 'three';

/**
 * Compact vertex format shared by the offline baker (tools/ai/bake.mjs) and the runtime fallback:
 *   position f32x3 | normal i8x3 (normalized) | uv f32x2 | skinIndex u8x4 | skinWeight u8x4 (normalized)
 *   aData u8x4 (normalized): x = materialId / 255, y = AO, z = dirt, w = wear
 * Index: u16 (or u32 when > 65535 vertices).
 */

export const PACK_VERSION = 3;

/** Convert a float builder geometry into packed typed arrays. */
export function packArrays(g) {
  const n = g.attributes.position.count;
  const pos = new Float32Array(g.attributes.position.array);
  const nrmSrc = g.attributes.normal.array;
  const nrm = new Int8Array(n * 3);
  for (let i = 0; i < n * 3; i++) nrm[i] = Math.max(-127, Math.min(127, Math.round(nrmSrc[i] * 127)));
  const uv = new Float32Array(g.attributes.uv.array);
  const siSrc = g.attributes.skinIndex.array, swSrc = g.attributes.skinWeight.array;
  const si = new Uint8Array(n * 4), sw = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    // quantize weights so they still sum to 255
    let acc = 0, maxK = 0;
    for (let k = 0; k < 4; k++) {
      si[i * 4 + k] = siSrc[i * 4 + k];
      const w = Math.round(swSrc[i * 4 + k] * 255);
      sw[i * 4 + k] = w; acc += w;
      if (swSrc[i * 4 + k] > swSrc[i * 4 + maxK]) maxK = k;
    }
    sw[i * 4 + maxK] = Math.max(0, Math.min(255, sw[i * 4 + maxK] + (255 - acc)));
  }
  const dSrc = g.attributes.aData.array;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = Math.round(dSrc[i * 4]);
    for (let k = 1; k < 4; k++) data[i * 4 + k] = Math.round(Math.max(0, Math.min(1, dSrc[i * 4 + k])) * 255);
  }
  const idxSrc = g.index.array;
  const index = n > 65535 ? new Uint32Array(idxSrc) : new Uint16Array(idxSrc);
  return { count: n, pos, nrm, uv, si, sw, data, index, headStart: g.userData.headStart | 0 };
}

/** Build a BufferGeometry from packed arrays. */
export function geometryFromPacked(p) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(p.nrm, 3, true));
  g.setAttribute('uv', new THREE.BufferAttribute(p.uv, 2));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(p.si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(p.sw, 4, true));
  g.setAttribute('aData', new THREE.BufferAttribute(p.data, 4, true));
  g.setIndex(new THREE.BufferAttribute(p.index, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 1.35);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
  g.userData.headStart = p.headStart;
  return g;
}

// ------------------------------------------------------------------ binary container
// [u32 magic 'SLDR'] [u32 version] [u32 jsonBytes] [json] [pad to 4] [blobs...]
// json: { entries: [{ key, count, icount, i32:bool, headStart, off: {pos,nrm,uv,si,sw,data,index} }] }

const MAGIC = 0x52444c53;
const align4 = (n) => (n + 3) & ~3;

export function writeContainer(entries) {
  const meta = { entries: [] };
  const blobs = [];
  let off = 0;
  const put = (arr) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    const o = off;
    blobs.push([o, bytes]);
    off = align4(off + bytes.byteLength);
    return o;
  };
  for (const [key, p] of entries) {
    meta.entries.push({
      key, count: p.count, icount: p.index.length, i32: p.index instanceof Uint32Array, headStart: p.headStart,
      off: { pos: put(p.pos), nrm: put(p.nrm), uv: put(p.uv), si: put(p.si), sw: put(p.sw), data: put(p.data), index: put(p.index) },
    });
  }
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const head = align4(12 + json.byteLength);
  const out = new Uint8Array(head + off);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, PACK_VERSION, true); dv.setUint32(8, json.byteLength, true);
  out.set(json, 12);
  for (const [o, bytes] of blobs) out.set(bytes, head + o);
  return out;
}

/** Parse a container -> Map(key -> packed arrays). Returns null on version mismatch. */
export function readContainer(buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== PACK_VERSION) return null;
  const jl = dv.getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, jl)));
  const head = align4(12 + jl);
  const out = new Map();
  for (const e of meta.entries) {
    const n = e.count, o = e.off;
    out.set(e.key, {
      count: n,
      headStart: e.headStart,
      pos: new Float32Array(buffer, head + o.pos, n * 3),
      nrm: new Int8Array(buffer, head + o.nrm, n * 3),
      uv: new Float32Array(buffer, head + o.uv, n * 2),
      si: new Uint8Array(buffer, head + o.si, n * 4),
      sw: new Uint8Array(buffer, head + o.sw, n * 4),
      data: new Uint8Array(buffer, head + o.data, n * 4),
      index: e.i32 ? new Uint32Array(buffer, head + o.index, e.icount) : new Uint16Array(buffer, head + o.index, e.icount),
    });
  }
  return out;
}

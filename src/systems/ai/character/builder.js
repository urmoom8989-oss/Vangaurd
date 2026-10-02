import * as THREE from 'three';
import { B, BIND, TIP, NUM_BONES } from './rig.js';

/**
 * Accumulates sculpted Parts into one skinned BufferGeometry with:
 *   position, normal, uv (metres), skinIndex, skinWeight, aData = (materialId, ao, dirt, wear)
 */

const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

const SEG_A = BIND.map((p) => new THREE.Vector3(...p));
const SEG_B = TIP.map((p) => new THREE.Vector3(...p));

export function segDist(p, bone) {
  const a = SEG_A[bone], b = SEG_B[bone];
  _a.subVectors(b, a);
  const l2 = _a.lengthSq();
  let t = l2 > 0 ? _b.subVectors(p, a).dot(_a) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return _b.copy(a).addScaledVector(_a, t).distanceTo(p);
}

/** Auto weights from bone-segment distances (inverse power), returns Map-like array of [bone, w]. */
export function autoWeights(p, bones, k = 5) {
  const out = [];
  let sum = 0;
  for (const bn of bones) {
    const bi = typeof bn === 'number' ? bn : B[bn];
    const d = segDist(p, bi) + 0.004;
    const w = 1 / Math.pow(d, k);
    out.push([bi, w]);
    sum += w;
  }
  for (const o of out) o[1] /= sum;
  return out;
}

export class SoldierBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.si = [];
    this.sw = [];
    this.data = [];
    this.idx = [];
  }
  get count() { return this.pos.length / 3; }

  /**
   * opts: mat (id) | matFn(p, i) ; bone (name) | bones (names, auto) | weightFn(p) -> [[bone,w],...]
   *       k (auto exponent), dirt number | fn(p), wear number | fn(p)
   */
  add(part, opts) {
    if (!part.n) part.computeNormals();
    const base = this.count;
    const P = part.p, N = part.n, UV = part.uv;
    const fixedBone = opts.bone !== undefined ? B[opts.bone] : -1;
    for (let i = 0; i < part.count; i++) {
      _p.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      this.pos.push(_p.x, _p.y, _p.z);
      this.nrm.push(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
      this.uv.push(UV[i * 2], UV[i * 2 + 1]);
      let w;
      if (fixedBone >= 0) w = [[fixedBone, 1]];
      else if (opts.weightFn) w = opts.weightFn(_p);
      else w = autoWeights(_p, opts.bones, opts.k ?? 5);
      pushWeights(this, w);
      const mat = opts.matFn ? opts.matFn(_p, i) : opts.mat;
      const dirt = typeof opts.dirt === 'function' ? opts.dirt(_p) : (opts.dirt ?? 0);
      const wear = typeof opts.wear === 'function' ? opts.wear(_p) : (opts.wear ?? 0);
      this.data.push(mat, 1, dirt, wear);
    }
    for (let i = 0; i < part.idx.length; i++) this.idx.push(part.idx[i] + base);
    return this;
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setAttribute('aData', new THREE.Float32BufferAttribute(this.data, 4));
    const count = this.count;
    g.setIndex(count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    return g;
  }
}

function pushWeights(builder, w) {
  // keep top 4
  if (w.length > 4) {
    w.sort((x, y) => y[1] - x[1]);
    w.length = 4;
  }
  let s = 0;
  for (const e of w) s += e[1];
  for (let k = 0; k < 4; k++) {
    if (k < w.length && w[k][1] > 1e-4) {
      builder.si.push(Math.min(NUM_BONES - 1, w[k][0]));
      builder.sw.push(w[k][1] / s);
    } else {
      builder.si.push(0);
      builder.sw.push(0);
    }
  }
}

/** Mix helper for hand-authored weights: list of [boneName, w] (w may be 0). */
export function W(...pairs) {
  const out = [];
  let s = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    const w = pairs[i + 1];
    if (w > 1e-5) { out.push([B[pairs[i]], w]); s += w; }
  }
  if (s === 0) return [[B.pelvis, 1]];
  for (const o of out) o[1] /= s;
  return out;
}

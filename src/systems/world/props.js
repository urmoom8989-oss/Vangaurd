import * as THREE from 'three';
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js';

/**
 * Instanced props: CC0 Poly Haven models (public/assets/world/models/<id>/<id>.gltf) and a few
 * procedural meshes (sandbags, grass cards...). Placements are collected during generation and turned
 * into one InstancedMesh per (type, sub-mesh). Collision uses box proxies baked into the static BVH.
 */

const MODEL_BASE = '/assets/world/models';
export const MODELS = {
  Barrel_01: { surface: 'metal', col: 'box' },
  Barrel_02: { surface: 'metal', col: 'box' },
  barrel_03: { surface: 'metal', col: 'box' },
  metal_jerrycan_green: { surface: 'metal', col: null },
  metal_trash_can: { surface: 'metal', col: 'box' },
  old_tyre: { surface: 'rubber', col: null },
  utility_box_01: { surface: 'metal', col: 'box' },
  utility_box_02: { surface: 'metal', col: 'box' },
  wooden_crate_01: { surface: 'wood', col: 'box' },
  wooden_crate_02: { surface: 'wood', col: 'box' },
  old_military_crate: { surface: 'wood', col: 'box' },
  // small ground-hugging props: contact darkening comes from AO; skipping CSM casting saves ~4x their tris
  trashbag: { surface: 'fabric', col: null, noShadowCast: true },
  cement_bag: { surface: 'fabric', col: null, noShadowCast: true },
  propane_tank: { surface: 'metal', col: 'box' },
  portable_generator: { surface: 'metal', col: 'box' },
  rollershutter_door: { surface: 'metal', col: null, noShadowCast: false, lod: 0 },
  rollershutter_window_01: { surface: 'metal', col: null, noShadowCast: true },
  rollershutter_window_02: { surface: 'metal', col: null, noShadowCast: true },
  weed_plant_02: { surface: 'grass', col: null, noShadowCast: true, lod: 0 },
  dry_branches_medium_01: { surface: 'wood', col: null, lod: 0.5 },
  security_light: { surface: 'metal', col: null },
  plastic_monobloc_chair_01: { surface: 'rubber', col: null },
  ammo_box: { surface: 'metal', col: null },
  small_lpg_tank: { surface: 'metal', col: 'box' },
  water_manhole_cover: { surface: 'metal', col: null, noShadowCast: true, lod: 0.8 },
};

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _e = new THREE.Euler();

export class PropSystem {
  constructor(ctx, mats) {
    this.ctx = ctx;
    this.mats = mats;
    this.types = new Map(); // type -> { parts: [{geometry, material}], bbox, def }
    this.placements = new Map(); // type -> [{matrix, collide}]
    this.colBoxes = []; // deferred {type, matrix(world), size, center}
    this.meshes = [];
    this.owned = [];
    this._defineProcedural();
  }

  async loadModels() {
    const ids = Object.keys(MODELS);
    await Promise.all(ids.map(async (id) => {
      try {
        const gltf = await this.ctx.assets.gltf(`${MODEL_BASE}/${id}/${id}.gltf`);
        const parts = [];
        gltf.scene.updateMatrixWorld(true);
        const bbox = new THREE.Box3();
        gltf.scene.traverse((o) => {
          if (!o.isMesh) return;
          const g = o.geometry.clone();
          g.applyMatrix4(o.matrixWorld);
          g.computeBoundingBox();
          bbox.union(g.boundingBox);
          parts.push({ geometry: g, material: o.material });
        });
        // normalize: bottom-center at origin
        const c = bbox.getCenter(new THREE.Vector3());
        const off = new THREE.Matrix4().makeTranslation(-c.x, -bbox.min.y, -c.z);
        const strength = MODELS[id].lod ?? 0.7;
        for (const p of parts) {
          const tris = (p.geometry.index ? p.geometry.index.count : p.geometry.attributes.position.count) / 3;
          if (strength > 0 && tris > 700) {
            const verts = p.geometry.attributes.position.count;
            const frac = tris > 8000 ? Math.max(strength, 0.85) : tris > 1500 ? strength : strength * 0.7;
            try {
              const simp = await new SimplifyModifier().modify(p.geometry, Math.floor(verts * frac));
              if (simp && simp.attributes.position && simp.attributes.position.count > 8) { p.geometry.dispose(); p.geometry = simp; }
            } catch (err) { /* keep the original */ }
          }
          p.geometry.applyMatrix4(off);
          p.geometry.computeBoundingSphere();
          p.material.userData.surface = MODELS[id].surface;
          this.owned.push(p.geometry, p.material);
          for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) if (p.material[k]) this.owned.push(p.material[k]);
        }
        bbox.applyMatrix4(off);
        this.types.set(id, { parts, bbox, def: MODELS[id] });
      } catch (err) {
        this.ctx.reportError('world', 'model', err);
      }
    }));
  }

  has(type) { return this.types.has(type); }

  bbox(type) { return this.types.get(type)?.bbox; }

  _defineProcedural() {
    // sandbag: pillow shape ~0.55 x 0.14 x 0.32
    const g = new THREE.SphereGeometry(1, 9, 6);
    const p = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      // flatten into a pillow
      const k = 1 - Math.pow(Math.abs(y), 3) * 0.2;
      x = Math.sign(x) * Math.pow(Math.abs(x), 0.55) * k;
      z = Math.sign(z) * Math.pow(Math.abs(z), 0.7) * k;
      y = Math.sign(y) * Math.min(Math.abs(y), 0.72);
      const n = Math.sin(x * 9.1 + z * 5.7) * 0.03 + Math.sin(z * 13.3) * 0.02;
      p.setXYZ(i, x * 0.28, y * 0.085 + n * 0.02, z * 0.16);
      uv.setXY(i, uv.getX(i) * 1.1, uv.getY(i) * 0.5);
    }
    g.computeVertexNormals();
    g.computeBoundingBox();
    this._addProc('sandbag', g, 'sandbags', 'fabric');

    // grass tuft: 4 fan cards leaning outward (narrow base, wide top) so clumps never read as boxes;
    // normals bent upward for soft card lighting. uv into the foliage atlas cell per placement type.
    for (let cell = 0; cell < 8; cell++) {
      const geos = [];
      const nCards = cell === 6 ? 3 : 4;
      for (let k = 0; k < nCards; k++) {
        const q = new THREE.PlaneGeometry(1, 1, 2, 2);
        const p2 = q.attributes.position;
        const tree = cell === 5 || cell === 6;
        for (let i = 0; i < p2.count; i++) {
          const x = p2.getX(i), y = p2.getY(i) + 0.5;
          const spread = tree ? 1 : 0.55 + 0.45 * y; // narrow at the base
          p2.setXYZ(i, x * spread, y, tree ? 0 : -y * y * 0.18);
        }
        q.rotateY((k / nCards) * Math.PI + (cell * 0.37));
        if (tree) q.translate(0, -0.5, 0);
        const quv = q.attributes.uv;
        const u0 = (cell % 4) / 4, v0 = 1 - (Math.floor(cell / 4) + 1) / 2;
        for (let i = 0; i < quv.count; i++) quv.setXY(i, u0 + quv.getX(i) / 4, v0 + quv.getY(i) / 2);
        q.computeVertexNormals();
        const nn = q.attributes.normal;
        for (let i = 0; i < nn.count; i++) {
          const v = new THREE.Vector3(nn.getX(i) * 0.35, 1, nn.getZ(i) * 0.35).normalize();
          nn.setXYZ(i, v.x, v.y, v.z);
        }
        geos.push(q);
      }
      const merged = mergeSimple(geos);
      geos.forEach((q) => q.dispose());
      this._addProc(`foliage${cell}`, merged, 'w:foliage', 'grass', { noShadowCast: cell !== 5 && cell !== 6 });
    }
  }

  _addProc(type, geometry, matKey, surface, opts = {}) {
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    this.owned.push(geometry);
    this.types.set(type, { parts: [{ geometry, matKey }], bbox: geometry.boundingBox.clone(), def: { surface, col: null, ...opts } });
  }

  /**
   * Place an instance. (x,y,z) in the given frame (Matrix4, default world), rotY radians,
   * scale number|[sx,sy,sz], o: { frame, collide (bool|'box'), tilt:[rx,rz] }
   */
  place(type, x, y, z, rotY = 0, scale = 1, o = {}) {
    if (!this.types.has(type)) return;
    _e.set(o.tilt?.[0] || 0, rotY, o.tilt?.[1] || 0, 'YXZ');
    _q.setFromEuler(_e);
    if (Array.isArray(scale)) _s.set(scale[0], scale[1], scale[2]); else _s.setScalar(scale);
    _p.set(x, y, z);
    const m = new THREE.Matrix4().compose(_p, _q, _s);
    if (o.frame) m.premultiply(o.frame);
    let list = this.placements.get(type);
    if (!list) { list = []; this.placements.set(type, list); }
    const def = this.types.get(type).def;
    list.push({ matrix: m, collide: o.collide ?? !!def.col });
  }

  /** Deferred collision box attributed to a prop type (e.g. a whole sandbag wall). matrix: world. */
  colBox(type, matrix, sx, sy, sz, { ray = true, move = true } = {}) {
    this.colBoxes.push({ type, matrix: matrix.clone(), sx, sy, sz, ray, move });
  }

  instantiate(root, B) {
    const CH0 = 60;
    const byType = new Map();
    const _pp = new THREE.Vector3();
    for (const [type, list] of this.placements) {
      if (!list.length) continue;
      const T = this.types.get(type);
      // spatial buckets so the main camera and every shadow cascade can cull per chunk
      // light types (small total tris) go in one bucket: draw calls cost more than the extra unculled tris
      const partTris = T.parts.reduce((s, p) => s + (p.geometry.index ? p.geometry.index.count : p.geometry.attributes.position.count) / 3, 0);
      const CH = partTris * list.length < 60000 ? 1e6 : CH0;
      const buckets = new Map();
      list.forEach((pl, i) => {
        _pp.setFromMatrixPosition(pl.matrix);
        const k = `${Math.floor(_pp.x / CH)},${Math.floor(_pp.z / CH)}`;
        let bk = buckets.get(k);
        if (!bk) { bk = []; buckets.set(k, bk); }
        bk.push(i);
      });
      const meshes = [];
      const instOwner = new Array(list.length);
      for (const [key, idxs] of buckets) {
        const partMeshes = [];
        for (const part of T.parts) {
          const material = part.material || this.mats.material(part.matKey);
          const im = new THREE.InstancedMesh(part.geometry, material, idxs.length);
          im.name = `world:prop:${type}`;
          im.userData.chunk = key;
          idxs.forEach((li, j) => im.setMatrixAt(j, list[li].matrix));
          im.instanceMatrix.needsUpdate = true;
          im.castShadow = !T.def.noShadowCast;
          im.receiveShadow = true;
          im.userData.surface = T.def.surface;
          im.matrixAutoUpdate = false;
          im.computeBoundingSphere();
          im.computeBoundingBox?.();
          root.add(im);
          partMeshes.push(im);
          meshes.push(im);
          this.meshes.push(im);
        }
        idxs.forEach((li, j) => { instOwner[li] = { mesh: partMeshes[0], id: j }; });
      }
      byType.set(type, meshes);
      // collision proxies
      const bb = T.bbox;
      const size = bb.getSize(new THREE.Vector3());
      const center = bb.getCenter(new THREE.Vector3());
      list.forEach((pl, i) => {
        if (!pl.collide) return;
        const g = new THREE.BoxGeometry(size.x, size.y, size.z);
        g.translate(center.x, center.y, center.z);
        g.applyMatrix4(pl.matrix);
        const own = instOwner[i];
        B.colGeometry(g, { object: own.mesh, material: own.mesh.material, surface: T.def.surface, instanceId: own.id }, { ray: true, move: true });
      });
    }
    for (const cb of this.colBoxes) {
      const meshes = byType.get(cb.type);
      if (!meshes) continue;
      const g = new THREE.BoxGeometry(cb.sx, cb.sy, cb.sz);
      g.applyMatrix4(cb.matrix);
      B.colGeometry(g, { object: meshes[0], material: meshes[0].material, surface: this.types.get(cb.type).def.surface }, { ray: cb.ray, move: cb.move });
    }
    this.placements.clear();
    this.colBoxes.length = 0;
  }

  dispose() {
    for (const m of this.meshes) m.dispose?.();
    for (const o of this.owned) o.dispose?.();
    this.meshes.length = 0;
  }
}

function mergeSimple(geos) {
  let n = 0, ni = 0;
  for (const g of geos) { n += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), idx = new Uint32Array(ni);
  let o = 0, oi = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    uv.set(g.attributes.uv.array, o * 2);
    const ix = g.index.array;
    for (let i = 0; i < ix.length; i++) idx[oi + i] = ix[i] + o;
    o += g.attributes.position.count;
    oi += ix.length;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  m.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  m.setIndex(new THREE.BufferAttribute(idx, 1));
  return m;
}

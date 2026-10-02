import * as THREE from 'three';

/**
 * Instanced, lit, normal-mapped decals (bullet holes per surface, blood, scorch).
 * Two ring-buffered InstancedMeshes (small bullet holes / large splats) sharing one MeshStandardMaterial that is
 * patched to read a per-instance atlas rect + opacity/roughness/metalness/emissive-heat. They receive shadows and
 * scene lighting like the surface under them. Oldest decals are recycled when the cap is reached.
 */
const ATLAS = 2048;
const bulletRect = (i) => [((i % 8) * 256) / ATLAS, 1 - (Math.floor(i / 8) * 256 + 256) / ATLAS, 256 / ATLAS, 256 / ATLAS];
const largeRect = (j) => [((j % 4) * 512) / ATLAS, 1 - (512 + Math.floor(j / 4) * 512 + 512) / ATLAS, 512 / ATLAS, 512 / ATLAS];

// surface -> { cells, size (m), rough, metal }
const BULLET = {
  concrete: { cells: [0, 1, 2], size: 0.2, rough: 0.95, metal: 0 },
  asphalt: { cells: [15], size: 0.18, rough: 0.9, metal: 0 },
  brick: { cells: [3, 4], size: 0.2, rough: 0.95, metal: 0 },
  plaster: { cells: [5, 6], size: 0.2, rough: 0.95, metal: 0 },
  tile: { cells: [5, 6], size: 0.17, rough: 0.6, metal: 0 },
  metal: { cells: [7, 8, 9], size: 0.12, rough: 0.5, metal: 0.4 },
  wood: { cells: [10, 11], size: 0.17, rough: 0.9, metal: 0 },
  glass: { cells: [12, 13], size: 0.34, rough: 0.2, metal: 0 },
  dirt: { cells: [14], size: 0.2, rough: 1, metal: 0 },
  sand: { cells: [14], size: 0.2, rough: 1, metal: 0 },
  gravel: { cells: [14], size: 0.18, rough: 1, metal: 0 },
  grass: { cells: [14], size: 0.18, rough: 1, metal: 0 },
  fabric: { cells: [15], size: 0.08, rough: 1, metal: 0 },
  cardboard: { cells: [15], size: 0.09, rough: 1, metal: 0 },
  rubber: { cells: [15], size: 0.08, rough: 0.9, metal: 0 },
  default: { cells: [0, 1, 2, 15], size: 0.19, rough: 0.95, metal: 0 },
};

const _m = new THREE.Matrix4();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

class DecalRing {
  constructor(material, capacity, name, renderOrder) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.rect = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.rect.setUsage(THREE.DynamicDrawUsage);
    this.params.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aRect', this.rect);
    geo.setAttribute('aDecal', this.params);
    this.geometry = geo;
    const mesh = new THREE.InstancedMesh(geo, material, capacity);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.renderOrder = renderOrder;
    mesh.matrixAutoUpdate = false;
    this.mesh = mesh;
    this.capacity = capacity;
    this.next = 0;
    this.used = 0;
    this.heat = new Float32Array(capacity);    // emissive heat that cools down (scorch)
    this.heatDecay = new Float32Array(capacity);
    this.hot = 0;
    this.gen = new Uint32Array(capacity);
    this.handles = [];
    for (let i = 0; i < capacity; i++) {
      const ring = this;
      this.handles.push({ index: i, generation: 0, get alive() { return ring.gen[this.index] === this.generation; }, remove() { ring.remove(this); } });
    }
  }

  add(matrix, rect, opacity, rough, metal, heat = 0, heatDecay = 0) {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.used = Math.min(this.capacity, this.used + 1);
    matrix.toArray(this.mesh.instanceMatrix.array, i * 16);
    const r = this.rect.array, p = this.params.array;
    r[i * 4] = rect[0]; r[i * 4 + 1] = rect[1]; r[i * 4 + 2] = rect[2]; r[i * 4 + 3] = rect[3];
    p[i * 4] = opacity; p[i * 4 + 1] = rough; p[i * 4 + 2] = metal; p[i * 4 + 3] = heat;
    this.heat[i] = heat; this.heatDecay[i] = heatDecay;
    if (heat > 0) this.hot++;
    this.mesh.count = this.used;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.rect.needsUpdate = true;
    this.params.needsUpdate = true;
    this.gen[i]++;
    const h = this.handles[i];
    h.generation = this.gen[i];
    return h;
  }

  remove(h) {
    if (this.gen[h.index] !== h.generation) return;
    _zero.toArray(this.mesh.instanceMatrix.array, h.index * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.gen[h.index]++;
  }

  update(dt) {
    if (this.hot <= 0) return;
    let hot = 0;
    const p = this.params.array;
    for (let i = 0; i < this.used; i++) {
      if (this.heat[i] <= 0) continue;
      this.heat[i] = Math.max(0, this.heat[i] - this.heatDecay[i] * dt);
      p[i * 4 + 3] = this.heat[i] * this.heat[i];
      if (this.heat[i] > 0) hot++;
    }
    this.hot = hot;
    this.params.needsUpdate = true;
  }

  clear() { this.used = 0; this.next = 0; this.mesh.count = 0; this.hot = 0; this.heat.fill(0); }
}

export class Decals {
  constructor(ctx, textures, rng) {
    this.ctx = ctx;
    this.rng = rng;
    const mat = new THREE.MeshStandardMaterial({
      map: textures.decalColor,
      normalMap: textures.decalNormal,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      roughness: 0.9,
      metalness: 0,
      emissive: 0xffffff,
    });
    mat.name = 'vfx_decal';
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aRect;\nattribute vec4 aDecal;\nvarying vec4 vDecal;\nvarying vec2 vLocalUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vMapUv = uv * aRect.zw + aRect.xy;\n  vNormalMapUv = vMapUv;\n  vDecal = aDecal;\n  vLocalUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec4 vDecal;\nvarying vec2 vLocalUv;')
        .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.a *= vDecal.x;')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = vDecal.y;')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = vDecal.z;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance = vec3(1.0, 0.3, 0.05) * vDecal.w * 3.0 * pow(clamp(diffuseColor.a, 0.0, 1.0), 4.0) * clamp(1.0 - diffuseColor.r * 8.0, 0.0, 1.0) * smoothstep(0.32, 0.05, length(vLocalUv - 0.5));');
    };
    mat.customProgramCacheKey = () => 'vfx_decal_v2';
    this.material = mat;
    this.large = new DecalRing(mat, 96, 'vfx_decals_large', 1);
    this.small = new DecalRing(mat, 400, 'vfx_decals_small', 2);
    this.group = new THREE.Group();
    this.group.name = 'vfx_decals';
    this.group.add(this.large.mesh, this.small.mesh);
    this.enabled = true;
  }

  /** Build the decal transform. dir (optional) orients the texture +U axis. */
  _matrix(point, normal, size, sizeY, dir, offset) {
    _n.copy(normal).normalize();
    if (dir && dir.lengthSq() > 1e-8) {
      _t.copy(dir).addScaledVector(_n, -dir.dot(_n));
    } else _t.set(0, 0, 0);
    if (_t.lengthSq() < 1e-6) {
      // random rotation around the normal
      if (Math.abs(_n.y) < 0.9) _t.set(0, 1, 0).cross(_n); else _t.set(1, 0, 0).cross(_n);
      _t.normalize();
      _b.crossVectors(_n, _t);
      const a = this.rng.next() * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      _p.copy(_t).multiplyScalar(c).addScaledVector(_b, s);
      _t.copy(_p);
    }
    _t.normalize();
    _b.crossVectors(_n, _t);
    _m.makeBasis(_t.multiplyScalar(size), _b.multiplyScalar(sizeY), _n);
    _p.copy(point).addScaledVector(normal, offset);
    _m.setPosition(_p);
    return _m;
  }

  bullet(point, normal, surface, size) {
    if (!this.enabled) return null;
    const def = BULLET[surface] || BULLET.default;
    const cell = def.cells[Math.floor(this.rng.next() * def.cells.length)];
    const s = (size ?? def.size) * (0.85 + this.rng.next() * 0.3);
    const m = this._matrix(point, normal, s, s, null, 0.0015);
    return this.small.add(m, bulletRect(cell), 1, def.rough, def.metal);
  }

  blood(point, normal, dir, size = 0.7, variant = -1) {
    if (!this.enabled) return null;
    const cell = variant >= 0 ? variant : Math.floor(this.rng.next() * 4);
    const s = size * (0.8 + this.rng.next() * 0.4);
    const m = this._matrix(point, normal, s, s * (0.8 + this.rng.next() * 0.3), dir, 0.002);
    return this.large.add(m, largeRect(cell), 1.0, 0.42, 0);
  }

  scorch(point, normal, size = 3, dirt = false) {
    if (!this.enabled) return null;
    const cell = dirt ? 9 : 6 + Math.floor(this.rng.next() * 3);
    const m = this._matrix(point, normal, size, size, null, 0.003);
    return this.large.add(m, largeRect(cell), 0.95, 1, 0, 1, 2.5);
  }

  generic(point, normal, cell, size, rough = 0.9, dir = null) {
    const m = this._matrix(point, normal, size, size, dir, 0.002);
    return this.large.add(m, largeRect(cell), 0.9, rough, 0);
  }

  update(dt) { this.large.update(dt); this.small.update(dt); }
  clear() { this.large.clear(); this.small.clear(); }
  count() { return this.large.used + this.small.used; }
  dispose() { this.large.geometry.dispose(); this.small.geometry.dispose(); this.material.dispose(); this.large.mesh.dispose(); this.small.mesh.dispose(); }
}

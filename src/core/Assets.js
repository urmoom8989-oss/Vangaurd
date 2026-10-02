import * as THREE from 'three';

/**
 * Assets — cached loader helpers + a pending-work tracker that gates shot readiness.
 *
 * Everything async that affects the image (texture loads, GLTF loads, procedural texture bakes,
 * shader warmups…) MUST go through these helpers or `assets.track(promise, label)` so the shot
 * harness waits for it before capturing.
 *
 *   await assets.texture('/assets/materials/concrete_albedo.jpg', { srgb: true, repeat: [4, 4] })
 *   await assets.gltf('/assets/weapons/rifle.glb')          -> GLTF result (cached; clone scene yourself)
 *   await assets.hdr('/assets/lighting/sky.hdr')            -> DataTexture (EquirectangularReflectionMapping)
 *   await assets.exr(url), assets.ktx2(url)
 *   await assets.arrayBuffer(url), assets.json(url)
 *   assets.track(promise, 'label')                          -> promise (counts toward readiness)
 *   await assets.whenIdle()                                 -> resolves when nothing is pending
 *   assets.canvasTexture(w, h, (ctx2d, w, h) => {...}, { srgb }) -> CanvasTexture (sync)
 *
 * Put files under public/assets/<system>/ (served at /assets/<system>/...). Only the owning system
 * writes into its folder.
 */
export class Assets {
  constructor(renderer) {
    this.renderer = renderer;
    this.cache = new Map();
    this.pending = new Set();
    this.failed = [];
    this._idleWaiters = [];
    this.maxAnisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;
    this._texLoader = new THREE.TextureLoader();
    if (!THREE.TextureLoader.prototype.__opusStandaloneMapped) {
      const originalLoad = THREE.TextureLoader.prototype.load;
      THREE.TextureLoader.prototype.load = function (url, ...args) {
        const mapped = globalThis.__resolveStandaloneAsset?.(url);
        return originalLoad.call(this, mapped || url, ...args);
      };
      Object.defineProperty(THREE.TextureLoader.prototype, '__opusStandaloneMapped', { value: true });
    }
    this._fileLoader = new THREE.FileLoader();
    this._gltfLoader = null;
    this._ktx2Loader = null;
  }

  /** Track any async work so shot readiness waits for it. */
  track(promise, label = 'task') {
    const entry = { promise, label };
    this.pending.add(entry);
    const done = () => {
      this.pending.delete(entry);
      if (this.pending.size === 0) {
        const w = this._idleWaiters;
        this._idleWaiters = [];
        for (const r of w) r();
      }
    };
    promise.then(done, (err) => {
      this.failed.push({ label, error: String(err?.message || err) });
      console.error(`[assets] failed: ${label}`, err);
      done();
    });
    return promise;
  }

  whenIdle() {
    if (this.pending.size === 0) return Promise.resolve();
    return new Promise((r) => this._idleWaiters.push(r));
  }

  _cached(key, factory) {
    if (this.cache.has(key)) return this.cache.get(key);
    const p = this.track(factory(), key);
    this.cache.set(key, p);
    p.catch(() => this.cache.delete(key));
    return p;
  }

  /**
   * @param {string} url
   * @param {{srgb?: boolean, repeat?: [number, number], anisotropy?: number, flipY?: boolean, mipmaps?: boolean}} [o]
   * NOTE: cached by url+options. Textures are shared; clone() if you need a different repeat/offset.
   */
  texture(url, o = {}) {
    const key = `tex:${url}:${JSON.stringify(o)}`;
    return this._cached(key, () => this._texLoader.loadAsync(url).then((tex) => {
      tex.colorSpace = o.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.anisotropy = o.anisotropy ?? this.maxAnisotropy;
      if (o.flipY !== undefined) tex.flipY = o.flipY;
      if (o.repeat) {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(o.repeat[0], o.repeat[1]);
      }
      if (o.mipmaps === false) {
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
      }
      tex.needsUpdate = true;
      return tex;
    }));
  }

  async _getGLTFLoader() {
    if (this._gltfLoader) return this._gltfLoader;
    const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
      import('three/examples/jsm/loaders/GLTFLoader.js'),
      import('three/examples/jsm/libs/meshopt_decoder.module.js'),
    ]);
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const ktx2 = await this._getKTX2Loader();
    if (ktx2) loader.setKTX2Loader(ktx2);
    this._gltfLoader = loader;
    return loader;
  }

  async _getKTX2Loader() {
    if (this._ktx2Loader !== null) return this._ktx2Loader || null;
    try {
      const { KTX2Loader } = await import('three/examples/jsm/loaders/KTX2Loader.js');
      const l = new KTX2Loader();
      // Transcoder files must be copied to public/assets/basis/ to use KTX2 (not shipped by default).
      l.setTranscoderPath('/assets/basis/');
      if (this.renderer) l.detectSupport(this.renderer);
      this._ktx2Loader = l;
    } catch {
      this._ktx2Loader = false;
    }
    return this._ktx2Loader || null;
  }

  /** GLTF/GLB (meshopt supported). Returns the cached gltf object; clone gltf.scene per instance
   * (use SkeletonUtils.clone for skinned meshes). */
  gltf(url) {
    return this._cached(`gltf:${url}`, async () => (await this._getGLTFLoader()).loadAsync(url));
  }

  hdr(url) {
    return this._cached(`hdr:${url}`, async () => {
      const { HDRLoader } = await import('three/examples/jsm/loaders/HDRLoader.js');
      const tex = await new HDRLoader().loadAsync(url);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      return tex;
    });
  }

  exr(url) {
    return this._cached(`exr:${url}`, async () => {
      const { EXRLoader } = await import('three/examples/jsm/loaders/EXRLoader.js');
      const tex = await new EXRLoader().loadAsync(url);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      return tex;
    });
  }

  ktx2(url) {
    return this._cached(`ktx2:${url}`, async () => {
      const l = await this._getKTX2Loader();
      if (!l) throw new Error('KTX2Loader unavailable');
      return l.loadAsync(url);
    });
  }

  arrayBuffer(url) {
    return this._cached(`ab:${url}`, () => fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.arrayBuffer();
    }));
  }

  json(url) {
    return this._cached(`json:${url}`, () => fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.json();
    }));
  }

  /** Synchronous procedural texture from a 2D canvas draw callback. */
  canvasTexture(w, h, draw, { srgb = true, repeat = null } = {}) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    draw(g, w, h);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = this.maxAnisotropy;
    if (repeat) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(repeat[0], repeat[1]);
    }
    return tex;
  }

  dispose() {
    for (const p of this.cache.values()) {
      p.then((v) => { if (v && v.isTexture) v.dispose(); }).catch(() => {});
    }
    this.cache.clear();
    this._ktx2Loader?.dispose?.();
  }
}

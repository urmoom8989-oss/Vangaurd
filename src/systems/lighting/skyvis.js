import * as THREE from 'three';
import { skyVisTexture, SKYVIS_RES, atmoData } from './chunks.js';

/**
 * Sky-visibility bake ("cheap GI"): renders a top-down orthographic height field of the static level once
 * (and on demand), then box-filters it at two radii. The patched lights chunk (chunks.js) turns
 *   R = top surface height at (x,z)       -> "under a roof / overhang" occlusion
 *   G = mean height within ~4 m            -> near horizon (walls, alleys)
 *   B = mean height within ~12 m           -> street-canyon horizon
 * into a sky-light (IBL) visibility factor per fragment. One texture fetch per lit fragment.
 */
export function createSkyVisBaker(ctx) {
  const { renderer, scene } = ctx;
  const res = SKYVIS_RES;
  let rt = null;
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  cam.layers.set(ctx.layers.WORLD);
  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking, side: THREE.DoubleSide });
  let pixels = null;
  const info = { center: new THREE.Vector2(), size: 0, baked: false };

  function boxBlur(src, dst, tmp, r) {
    // separable box filter with clamped edges
    for (let y = 0; y < res; y++) {
      let acc = 0;
      const row = y * res;
      for (let x = -r; x <= r; x++) acc += src[row + Math.min(res - 1, Math.max(0, x))];
      for (let x = 0; x < res; x++) {
        tmp[row + x] = acc / (2 * r + 1);
        acc += src[row + Math.min(res - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < res; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(res - 1, Math.max(0, y)) * res + x];
      for (let y = 0; y < res; y++) {
        dst[y * res + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(res - 1, y + r + 1) * res + x] - tmp[Math.max(0, y - r) * res + x];
      }
    }
  }

  function minFilter(src, dst, tmp, r) {
    for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
      let m = Infinity;
      for (let k = -r; k <= r; k++) { const v = src[y * res + Math.min(res - 1, Math.max(0, x + k))]; if (v < m) m = v; }
      tmp[y * res + x] = m;
    }
    for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
      let m = Infinity;
      for (let k = -r; k <= r; k++) { const v = tmp[Math.min(res - 1, Math.max(0, y + k)) * res + x]; if (v < m) m = v; }
      dst[y * res + x] = m;
    }
  }

  /**
   * @param {{center?: THREE.Vector2, size?: number, exclude?: THREE.Object3D[]}} opts
   */
  function bake({ center = null, size = null, exclude = [], strength = 1, roof = 0.85, specular = 0.85 } = {}) {
    const bounds = ctx.services.world?.bounds;
    const c = new THREE.Vector2(), box = new THREE.Box3();
    let sz = size;
    if (center) c.copy(center);
    else if (bounds && !bounds.isEmpty()) c.set((bounds.min.x + bounds.max.x) / 2, (bounds.min.z + bounds.max.z) / 2);
    if (!sz) sz = bounds && !bounds.isEmpty() ? Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) + 80 : 256;
    sz = THREE.MathUtils.clamp(sz, 64, 400);
    // vertical extent from the scene
    scene.updateMatrixWorld();
    box.setFromObject(ctx.services.world?.root || scene, true);
    const top = Math.min(Number.isFinite(box.max.y) ? box.max.y : 60, 300) + 5;
    const bottom = Math.max(Number.isFinite(box.min.y) ? box.min.y : -10, -50) - 5;

    if (!rt) rt = new THREE.WebGLRenderTarget(res, res, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    cam.left = -sz / 2; cam.right = sz / 2; cam.top = sz / 2; cam.bottom = -sz / 2;
    cam.near = 0.1; cam.far = top - bottom;
    cam.position.set(c.x, top, c.y);
    cam.up.set(0, 0, -1);
    cam.lookAt(c.x, bottom, c.y);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    const hidden = [];
    for (const o of exclude) if (o && o.visible) { o.visible = false; hidden.push(o); }
    const prevOverride = scene.overrideMaterial;
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.shadowMap.autoUpdate, prevNeeds = renderer.shadowMap.needsUpdate;
    const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    const prevFog = scene.fog, prevBg = scene.background;
    renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = false;
    scene.overrideMaterial = depthMat;
    scene.fog = null; scene.background = null;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
    if (!pixels) pixels = new Float32Array(res * res * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, res, res, pixels);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    scene.overrideMaterial = prevOverride;
    scene.fog = prevFog; scene.background = prevBg;
    renderer.shadowMap.autoUpdate = prevAuto; renderer.shadowMap.needsUpdate = prevNeeds;
    for (const o of hidden) o.visible = true;

    // decode heights (row r from the bottom of the framebuffer == +Z side with up = -Z)
    const range = top - bottom;
    const h = new Float32Array(res * res);
    let minH = Infinity;
    for (let r = 0; r < res; r++) {
      const j = res - 1 - r; // texture row j <-> z = z0 + (j + .5) / res * sz
      for (let x = 0; x < res; x++) {
        const d = pixels[(r * res + x) * 4]; // 1 - fragCoordZ
        const v = d > 0 ? top - (1 - d) * range - 0.1 : -Infinity;
        h[j * res + x] = v;
        if (v > -Infinity && v < minH) minH = v;
      }
    }
    if (!Number.isFinite(minH)) minH = 0;
    for (let i = 0; i < h.length; i++) if (h[i] === -Infinity) h[i] = minH;
    const texel = sz / res;
    const g = new Float32Array(res * res), b = new Float32Array(res * res), tmp = new Float32Array(res * res);
    boxBlur(h, g, tmp, Math.max(1, Math.round(4 / texel)));
    boxBlur(h, b, tmp, Math.max(2, Math.round(12 / texel)));
    // roof channel: erode (thin beams / cables / poles do not count as cover), then soften the edges
    const he = new Float32Array(res * res), hs = new Float32Array(res * res);
    minFilter(h, he, tmp, Math.max(1, Math.round(0.9 / texel)));
    boxBlur(he, hs, tmp, 1);

    const data = skyVisTexture.image.data;
    const toHalf = THREE.DataUtils.toHalfFloat;
    for (let i = 0; i < res * res; i++) {
      data[i * 4] = toHalf(hs[i]);
      data[i * 4 + 1] = toHalf(g[i]);
      data[i * 4 + 2] = toHalf(b[i]);
      data[i * 4 + 3] = toHalf(1);
    }
    skyVisTexture.needsUpdate = true;
    renderer.initTexture(skyVisTexture);

    const x0 = c.x - sz / 2, z0 = c.y - sz / 2;
    atmoData[80] = x0; atmoData[81] = z0; atmoData[82] = 1 / sz; atmoData[83] = strength;
    atmoData[84] = 1 / 6; atmoData[85] = 1 / 10; atmoData[86] = roof; atmoData[87] = specular;
    info.center.copy(c); info.size = sz; info.baked = true;
    return info;
  }

  /** CPU query of the baked visibility (for debugging / other systems). */
  function sample(x, y, z) {
    if (!info.baked) return 1;
    const data = skyVisTexture.image.data;
    const u = (x - (info.center.x - info.size / 2)) / info.size, v = (z - (info.center.y - info.size / 2)) / info.size;
    if (u < 0 || v < 0 || u > 1 || v > 1) return 1;
    const i = (Math.min(res - 1, Math.floor(v * res)) * res + Math.min(res - 1, Math.floor(u * res))) * 4;
    const f = THREE.DataUtils.fromHalfFloat;
    const top = f(data[i]), m1 = f(data[i + 1]), m2 = f(data[i + 2]);
    const cov = THREE.MathUtils.smoothstep(top - y, 0.35, 1.6);
    const t = Math.max(Math.max(m1 - y, 0) * atmoData[84], Math.max(m2 - y, 0) * atmoData[85]);
    return (1 / (1 + t * t)) * (1 - cov * atmoData[86]);
  }

  return {
    bake,
    sample,
    info,
    dispose() { rt?.dispose(); depthMat.dispose(); },
  };
}

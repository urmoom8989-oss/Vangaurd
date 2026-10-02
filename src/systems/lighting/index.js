import * as THREE from 'three';
import { SunLight } from 'three/examples/jsm/lights/SunLight.js';
import { installChunks, atmoData } from './chunks.js';
import { CascadedSunShadow } from './CascadedSunShadow.js';
import { createSkyMaterial, createSkyDome } from './sky.js';
import { PRESETS, PRESET_NAMES } from './presets.js';
import { createSkyline } from './skyline.js';
import { createSmokeColumns } from './smoke.js';
import { createSkyVisBaker } from './skyvis.js';

/**
 * LIGHTING & ATMOSPHERE (services.lighting). See README.md in this folder.
 *
 * Owns scene.background (null: a photographic sky dome is drawn instead), scene.environment (PMREM of the
 * sky + lit ground + urban horizon), scene.fog (a THREE.Fog whose shader chunks are replaced by physically
 * based height fog / aerial perspective / sun in-scattering with volumetric shadowing), the sun (three's
 * SunLight with 4 stable cascades), and distant set dressing that belongs to the atmosphere (skyline haze
 * cards, smoke columns).
 */
const QUALITY = {
  low: { cascadeSize: 1024, steps: 0 },
  medium: { cascadeSize: 1536, steps: 8 },
  high: { cascadeSize: 2048, steps: 12 },
  ultra: { cascadeSize: 3072, steps: 16 },
};

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const DEG = Math.PI / 180;

export default function createSystem(ctx) {
  const { scene, renderer } = ctx;
  const group = new THREE.Group();
  group.name = 'lighting';

  let sun = null;
  let sunTarget = null;
  let skyMat = null, envMat = null, dome = null, envDome = null;
  const envScene = new THREE.Scene();
  let pmrem = null;
  let envRT = null;
  let skyline = null;
  let smoke = null;
  let skyVis = null;
  let presetName = 'golden_hour';
  let preset = PRESETS.golden_hour;
  let applied = null; // {meta, tex}
  let presetToken = 0;
  let cascadeCount = 4;
  const skyCache = new Map(); // name -> Promise<{meta, tex}>
  const sunDir = new THREE.Vector3(0.4, 0.4, 0.3).normalize();
  const sunColor = new THREE.Color(1, 0.9, 0.7);
  let sunIrradiance = 1;
  const state = { exposure: 1, steps: 12, quality: 'high', baseExposure: 1, adapt: 1, adaptInit: false };

  function loadSky(name) {
    if (skyCache.has(name)) return skyCache.get(name);
    const p = Promise.all([
      ctx.assets.json(`/assets/lighting/${name}.json`),
      ctx.assets.texture(`/assets/lighting/${name}.jpg`, { srgb: true }),
    ]).then(([meta, tex]) => {
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      tex.needsUpdate = true;
      return { meta, tex };
    });
    skyCache.set(name, p);
    return p;
  }

  function computeSunDir(p, out) {
    const az = p.sunAzimuth * DEG, el = p.sunElevation * DEG;
    return out.set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)).normalize();
  }

  /** Push all preset-derived values into lights, uniforms and materials. */
  function applyPreset(p, sky) {
    const { meta } = sky;
    const I = p.intensity;
    computeSunDir(p, sunDir);
    const el = p.sunElevation * DEG;

    // sun: measured irradiance ratio from the HDRI, coloured by the measured sun colour
    const skyE = meta.sky.irradianceOverK * I; // horizontal sky irradiance
    let sunE = meta.sun.irradianceOverK * I * p.sunScale;
    if (p.minSunRatio) sunE = Math.max(sunE, p.minSunRatio * skyE);
    sunIrradiance = sunE;
    const sc = meta.sun.color;
    sunColor.setRGB(sc[0] * p.sunTint[0], sc[1] * p.sunTint[1], sc[2] * p.sunTint[2]);
    const m = Math.max(sunColor.r, sunColor.g, sunColor.b);
    sunColor.multiplyScalar(1 / m);
    sun.color.copy(sunColor);
    sun.intensity = sunE;
    sun.position.copy(sunDir).multiplyScalar(100);
    sun.updateMatrixWorld();
    sun.shadow.radius = p.shadow.penumbra;
    sun.shadow.intensity = p.shadow.intensity;

    // sky mapping: rotate the photo so its sun sits at the preset azimuth, warp elevation to match
    const phiSun = Math.atan2(sunDir.z, sunDir.x);
    const uOff = meta.sun.u - phiSun / (2 * Math.PI);
    const elT = meta.sun.elevationDeg * DEG;
    const A = Math.abs(Math.sin(2 * el)) > 1e-3 ? (el - elT) / Math.sin(2 * el) : 0;
    for (const mat of [skyMat, envMat]) {
      const u = mat.uniforms;
      u.skyTex.value = sky.tex;
      u.skyMap.value.set(uOff, THREE.MathUtils.clamp(A, -0.3, 0.3), meta.elevTop * DEG, (meta.elevTop - meta.elevBottom) * DEG);
      u.skyParams.value.x = I * (mat === skyMat ? (p.skyBoost ?? 1) : 1);
      u.sunColor.value.copy(sunColor);
      u.envParams.value.w = mat === skyMat ? (p.skySaturation ?? 1) : (p.envSaturation ?? 1);
    }
    // sun disc radiance: E / solid angle would be ~1e5x the sky; clamp to something bloom-friendly
    skyMat.uniforms.skyParams.value.y = p.sunDisc * I;
    // analytic aureole replacing the knee-compressed photographed one (see tools/lighting/bake-sky.mjs)
    const au = p.aureole || { inner: 0, outer: 0, blur: 0, width: 0.03 };
    envMat.uniforms.envCap.value = (p.envCap ?? 0) * I;
    skyMat.uniforms.aureole.value.set(au.inner * I, au.outer * I, au.blur ?? 24, au.width ?? 0.03);

    // environment lower hemisphere / urban horizon (cheap bounce GI)
    const gA = p.groundAlbedo, fA = p.facadeAlbedo;
    const eGround = sunE * Math.max(0, Math.sin(el)) * 0.6 + skyE;
    envMat.uniforms.groundRadiance.value.setRGB(gA[0] * eGround / Math.PI * sunColorMix(0), gA[1] * eGround / Math.PI * sunColorMix(1), gA[2] * eGround / Math.PI * sunColorMix(2));
    const eFacade = sunE * Math.cos(el) * p.facadeSunFraction * 0.5 + skyE * 0.5 + eGround * 0.25;
    envMat.uniforms.facadeRadiance.value.setRGB(fA[0] * eFacade / Math.PI, fA[1] * eFacade / Math.PI, fA[2] * eFacade / Math.PI);
    envMat.uniforms.envParams.value.x = p.horizonOcclusion.elevation * DEG;
    envMat.uniforms.envParams.value.y = p.horizonOcclusion.strength;

    // atmosphere (layout: atmosphere.glsl.js)
    const h = p.haze;
    const a = atmoData;
    a[0] = sunDir.x; a[1] = sunDir.y; a[2] = sunDir.z; a[3] = 1;
    const sunScat = (sunE / (4 * Math.PI)) * h.sunScatter;
    a[4] = sunColor.r * sunScat; a[5] = sunColor.g * sunScat; a[6] = sunColor.b * sunScat; a[7] = h.mieG;
    a[8] = h.ambientTint[0] * h.ambientScale; a[9] = h.ambientTint[1] * h.ambientScale; a[10] = h.ambientTint[2] * h.ambientScale; a[11] = h.falloff;
    a[12] = h.density * h.hazeTint[0]; a[13] = h.density * h.hazeTint[1]; a[14] = h.density * h.hazeTint[2]; a[15] = h.base;
    a[16] = h.air * h.airTint[0]; a[17] = h.air * h.airTint[1]; a[18] = h.air * h.airTint[2]; a[19] = h.mieWeight;
    a[20] = h.skyHaze; a[21] = h.skySoftness; a[22] = h.sunFraction; a[23] = h.maxOpacity;
    a[24] = state.steps; a[25] = p.volumetric.maxDist; a[26] = ctx.settings.get('lighting.volumetrics', true) ? p.volumetric.strength : 0; a[27] = p.volumetric.densityBoost;
    a[28] = I; a[29] = p.sunDisc * I; a[31] = uOff;
    const dust = p.dust || { density: 0 };
    const dS = (sunE / (4 * Math.PI)) * (dust.scale ?? 1);
    a[88] = sunColor.r * dS; a[89] = sunColor.g * dS; a[90] = sunColor.b * dS; a[91] = dust.density || 0;
    a[92] = dust.g ?? 0.6; a[93] = dust.height ?? 6; a[94] = h.start ?? 0; a[95] = dust.shaftGain ?? 0;
    const bf = p.bounceFill || [0, 0, 0];
    a[96] = bf[0]; a[97] = bf[1]; a[98] = bf[2];
    const hz = meta.sky.horizon;
    const avgH = [0, 0, 0];
    for (let k = 0; k < 12; k++) {
      const c = hz ? hz[k] : meta.sky.horizonAway;
      for (let j = 0; j < 3; j++) avgH[j] += c[j] * I / 12;
    }
    // flatten the azimuthal variation a little (the photographed sun glow at the horizon is very hot)
    const flat = h.horizonFlatten ?? 0;
    for (let k = 0; k < 12; k++) {
      const c = hz ? hz[k] : meta.sky.horizonAway;
      for (let j = 0; j < 3; j++) a[32 + k * 4 + j] = c[j] * I * (1 - flat) + avgH[j] * flat;
      const hs = h.saturation ?? 1;
      const hl = 0.2126 * a[32 + k * 4] + 0.7152 * a[33 + k * 4] + 0.0722 * a[34 + k * 4];
      for (let j = 0; j < 3; j++) a[32 + k * 4 + j] = Math.max(0, hl + (a[32 + k * 4 + j] - hl) * hs);
      a[32 + k * 4 + 3] = 0;
    }

    // classic fog fallback for custom shaders without the shared uniform
    if (!(scene.fog && scene.fog.isFog)) scene.fog = new THREE.Fog(0xffffff, 40, 700);
    scene.fog.color.setRGB(avgH[0] * a[8], avgH[1] * a[9], avgH[2] * a[10]);
    scene.background = null;

    scene.environmentIntensity = p.envScale;
    state.exposure = p.exposure;
    state.baseExposure = ctx.settings.get('graphics.exposure', 1) * p.exposure;
    renderer.toneMappingExposure = state.baseExposure * state.adapt;

    skyline?.applyPreset(p, { sunDir, sunColor, sunE, skyE });
    smoke?.applyPreset(p, { sunDir, sunColor, sunE, skyE });

    function sunColorMix(i) { return 0.65 + 0.35 * [sunColor.r, sunColor.g, sunColor.b][i]; }
  }

  function rebuildEnvironment() {
    if (!pmrem) pmrem = new THREE.PMREMGenerator(renderer);
    const prevAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    const rt = pmrem.fromScene(envScene, 0, 0.1, 1000, { size: 256, position: new THREE.Vector3(0, 1.7, 0) });
    renderer.shadowMap.autoUpdate = prevAuto;
    envRT?.dispose();
    envRT = rt;
    scene.environment = envRT.texture;
  }

  async function setPreset(name) {
    const p = PRESETS[name];
    if (!p) { console.warn(`[system:lighting] unknown preset "${name}". Available: ${PRESET_NAMES.join(', ')}`); return false; }
    const token = ++presetToken;
    const work = (async () => {
      const sky = await loadSky(p.sky);
      if (token !== presetToken) return false;
      presetName = name;
      preset = p;
      applied = sky;
      applyPreset(p, sky);
      rebuildEnvironment();
      ctx.events.emit('lighting:preset', { name });
      return true;
    })();
    return ctx.assets.track(work, `lighting:preset:${name}`);
  }

  function applyQuality() {
    const q = ctx.settings.get('graphics.quality', 'high');
    const Q = QUALITY[q] || QUALITY.high;
    state.quality = q;
    const atlas = ctx.settings.get('graphics.shadowMapSize', 4096);
    // graphics.shadowMapSize is the atlas budget (2x2 cascades); quality picks the per-cascade size under it
    const size = Math.min(Q.cascadeSize, Math.max(512, Math.floor(atlas / 2) * (q === 'ultra' ? 1.5 : 1)));
    if (sun && sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    state.steps = Q.steps;
    atmoData[24] = state.steps;
    renderer.shadowMap.enabled = ctx.settings.get('graphics.shadows', true);
    if (sun) sun.castShadow = renderer.shadowMap.enabled;
  }

  const api = {
    get sun() { return sun; },
    getSunDirection(out = new THREE.Vector3()) { return out.copy(sunDir); },
    get environment() { return envRT?.texture || null; },
    presets: PRESET_NAMES.slice(),
    setPreset,
    get preset() { return presetName; },
    setExposure(v) {
      // explicit base exposure (the view adaptation multiplier is applied on top every frame)
      state.baseExposure = v;
      renderer.toneMappingExposure = v * state.adapt;
    },
    // ---- extensions (use ?.() from other systems)
    /** linear sun colour (max component 1) */
    getSunColor(out = new THREE.Color()) { return out.copy(sunColor); },
    /** sun irradiance (SunLight.intensity) */
    getSunIntensity() { return sunIrradiance; },
    /** shared atmosphere uniform: add `lgtAtmo: lighting.atmosphereUniform` to a ShaderMaterial with fog:true */
    atmosphereUniform: { value: atmoData },
    /** true fog/haze colour & transmittance toward a world position from the camera (CPU mirror of the shader) */
    fogTransmittance(from, to) { return cpuTransmittance(from, to); },
    /** exposure multiplier the current preset wants (postfx may combine it with its own auto-exposure) */
    getPresetExposure() { return state.exposure; },
    /** shadow cascade info for effects that want to sample the sun shadow map (postfx god rays etc.) */
    getShadowCascades() {
      if (!sun?.shadow) return null;
      return { map: sun.shadow.map, count: cascadeCount, matrices: sun.shadow._matrices, cascades: sun.shadow._cascadeData };
    },
    /** screen-space sun position (NDC -1..1, z<1 when in front). Returns out Vector3. */
    getSunScreenPosition(camera = ctx.camera, out = new THREE.Vector3()) {
      out.copy(sunDir).multiplyScalar(1000).add(camera.getWorldPosition(_tmpV));
      return out.project(camera);
    },
    ready: null,
    /** Re-bake the sky-visibility height field (call after large static geometry changes). opts: {center: Vector2, size} */
    rebakeSkyVisibility(opts = {}) {
      if (!skyVis) return null;
      return skyVis.bake({ exclude: [dome, skyline?.object, smoke?.object], ...opts });
    },
    /**
     * Live-tune the active preset: deep-merges `patch` (same shape as a PRESETS entry) into a private copy of
     * the current preset and re-applies it (debug panels, shot A/B tests, gamemode mood changes).
     */
    tweak(patch) {
      if (!applied || !patch) return false;
      const merge = (dst, src) => {
        for (const k of Object.keys(src)) {
          const v = src[k];
          if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') merge(dst[k], v);
          else dst[k] = Array.isArray(v) ? v.slice() : v;
        }
        return dst;
      };
      if (preset === PRESETS[presetName]) preset = structuredClone(preset);
      merge(preset, patch);
      applyPreset(preset, applied);
      rebuildEnvironment();
      return true;
    },
    /** CPU estimate of sky visibility (0..1) at a world position */
    skyVisibilityAt(p) { return skyVis ? skyVis.sample(p.x, p.y, p.z) : 1; },
  };
  const _tmpV = new THREE.Vector3();
  const _adFwd = new THREE.Vector3(), _adPos = new THREE.Vector3();

  const _cv = new THREE.Vector3();
  function cpuTransmittance(from, to) {
    const a = atmoData;
    _cv.subVectors(to, from);
    const full = _cv.length();
    const dy = full > 1e-4 ? _cv.y / full : 0;
    const s0 = Math.min(a[94] || 0, full); // haze start distance (mirrors lgtOpticalDepthFrom)
    const dist = full - s0;
    const y0 = from.y + dy * s0;
    const b = Math.max(a[11], 1e-4);
    const k = Math.max(b * dy * dist, -30);
    const f = Math.abs(k) > 1e-3 ? (1 - Math.exp(-k)) / k : 1 - 0.5 * k;
    const od = Math.exp(Math.min(30, Math.max(-30, -b * (y0 - a[15])))) * dist * f;
    const tau = (a[12] + a[13] + a[14]) / 3 * od + (a[16] + a[17] + a[18]) / 3 * dist;
    return Math.max(Math.exp(-tau), 1 - a[23]);
  }

  return {
    name: 'lighting',
    async init() {
      const { cascades } = installChunks();
      cascadeCount = cascades;
      ctx.settings.registerDefaults?.('lighting', { preset: 'golden_hour', volumetrics: false, skyline: true, smoke: true, adaptiveExposure: true });

      sun = new SunLight(0xffffff, 5);
      sun.name = 'sun';
      sun.shadow = new CascadedSunShadow({ cascades, getCamera: () => ctx.camera });
      sun.shadow.bias = -0.00012;
      sun.shadow.normalBias = 1.4; // in texels (scaled per cascade by the patched shader)
      sun.castShadow = true;
      // DirectionalLight-compatible extras for consumers expecting the contract's "DirectionalLight"
      sunTarget = new THREE.Object3D();
      sunTarget.name = 'sunTarget';
      sun.target = sunTarget;
      group.add(sun);
      group.add(sunTarget);

      skyMat = createSkyMaterial({ env: false });
      envMat = createSkyMaterial({ env: true });
      dome = createSkyDome(skyMat);
      envDome = createSkyDome(envMat);
      envScene.add(envDome);
      group.add(dome);

      skyline = createSkyline(ctx);
      if (skyline) group.add(skyline.object);
      smoke = createSmokeColumns(ctx);
      if (smoke) group.add(smoke.object);

      scene.add(group);
      skyVis = createSkyVisBaker(ctx);
      ctx.events.on('core:ready', () => {
        const worldReady = ctx.services.world?.ready || Promise.resolve();
        ctx.assets.track(Promise.resolve(worldReady).then(() => api.rebakeSkyVisibility()), 'lighting:skyvis');
      });
      applyQuality();
      renderer.shadowMap.autoUpdate = false; // updated once per frame in lateUpdate (postfx may render the scene several times)
      renderer.shadowMap.needsUpdate = true;

      const wanted = ctx.settings.get('lighting.preset', 'golden_hour');
      api.ready = setPreset(PRESETS[wanted] ? wanted : 'golden_hour');
      ctx.services.provide('lighting', api);
      await api.ready;

      ctx.events.on('settings:changed', ({ path, value }) => {
        if (path === 'lighting.preset') setPreset(value);
        else if (path.startsWith('graphics.quality') || path.startsWith('graphics.shadow')) applyQuality();
        else if (path === 'lighting.volumetrics' && applied) applyPreset(preset, applied);
        else if (path === 'graphics.exposure') { state.baseExposure = value * state.exposure; renderer.toneMappingExposure = state.baseExposure * state.adapt; }
      });

      if (ctx.debug.gui) {
        const f = ctx.debug.gui.addFolder('lighting');
        const o = { preset: presetName, az: preset.sunAzimuth, el: preset.sunElevation };
        f.add(o, 'preset', PRESET_NAMES).onChange((v) => setPreset(v));
        f.add(o, 'az', 0, 360, 1).onChange((v) => { preset.sunAzimuth = v; applyPreset(preset, applied); rebuildEnvironment(); });
        f.add(o, 'el', -2, 60, 0.5).onChange((v) => { preset.sunElevation = v; applyPreset(preset, applied); rebuildEnvironment(); });
      }
    },
    update(dt, t) {
      atmoData[30] = t;
      smoke?.update(dt, t);
      skyline?.update?.(dt, t);
    },
    lateUpdate(dt) {
      // cheap eye adaptation: stop down when looking into the low sun, open up in covered / canyon spots
      if (ctx.settings.get('lighting.adaptiveExposure', true) !== false) {
        const cam = ctx.camera;
        _adFwd.set(0, 0, -1).transformDirection(cam.matrixWorld);
        cam.getWorldPosition(_adPos);
        const facing = _adFwd.dot(sunDir);
        const f = THREE.MathUtils.smoothstep(facing, 0.25, 0.95) * Math.min(1, Math.max(0, sunDir.y * 8));
        const sv = skyVis ? skyVis.sample(_adPos.x, _adPos.y, _adPos.z) : 1;
        // indoor / covered spaces hold more suspended dust: stronger shafts through windows and holes
        atmoData[91] = (preset.dust?.density || 0) * (1 + (preset.dust?.indoorBoost ?? 6) * (1 - sv));
        // shafts: modest gain on partly shadowed rays outdoors (alleys), strong gain indoors (windows, holes)
        atmoData[95] = (preset.dust?.shaftGain ?? 0) + (preset.dust?.indoorShaftGain ?? 0) * (1 - sv);
        const ev = -0.55 * f + 0.9 * (1 - sv) * (1 - f);
        const target = Math.pow(2, ev);
        if (!state.adaptInit || ctx.flags?.shotMode) { state.adapt = target; state.adaptInit = true; } // shots: converged
        else state.adapt += (target - state.adapt) * (1 - Math.exp(-Math.min(dt, 0.1) * 2.5));
        renderer.toneMappingExposure = state.baseExposure * state.adapt;
      }
      renderer.shadowMap.needsUpdate = true;
    },
    dispose() {
      scene.remove(group);
      sun?.shadow?.dispose();
      envRT?.dispose();
      pmrem?.dispose();
      dome?.geometry.dispose();
      envDome?.geometry.dispose();
      skyMat?.dispose();
      envMat?.dispose();
      skyline?.dispose();
      smoke?.dispose();
      skyVis?.dispose();
      for (const p of skyCache.values()) p.then((s) => s.tex.dispose()).catch(() => {});
      if (scene.environment === envRT?.texture) scene.environment = null;
      atmoData[3] = 0;
      renderer.shadowMap.autoUpdate = true;
    },
  };
}

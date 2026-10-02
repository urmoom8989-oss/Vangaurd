import * as THREE from 'three';
import { EffectPass, SMAAEffect, EdgeDetectionMode } from 'postprocessing';
import { FullscreenQuad, passMaterial, makeTarget } from './fullscreen.js';
import { DEPTH_LINEARIZE_FRAG, DEPTH_DOWNSAMPLE_FRAG, GTAO_FRAG, AO_DENOISE_FRAG, AO_APPLY_FRAG } from './shaders/ao.js';
import { TAA_FRAG } from './shaders/taa.js';
import { BLOOM_DOWN_FRAG, BLOOM_UP_FRAG } from './shaders/bloom.js';
import { RAYS_MASK_FRAG, RAYS_BLUR_FRAG, SUN_VIS_FRAG } from './shaders/godrays.js';
import { DOF_COC_FRAG, DOF_GATHER_FRAG } from './shaders/dof.js';
import { FINAL_FRAG, AFTERIMAGE_FRAG, COPY_FRAG } from './shaders/final.js';

/**
 * Opus of Duty render pipeline (owned by the postfx system).
 *
 * Frame graph (high tier):
 *   1. world pass      layers WORLD (+ anything not VIEWMODEL/FX) -> sceneRT (RGBA16F + float depth), TAA-jittered
 *   2. viewmodel pass  layers VIEWMODEL, own projection (near 0.01) with depth compressed into [0, VM_K]
 *                      -> the gun can never clip into walls and every later pass can tell it apart
 *   3. GTAO            half-res, world + viewmodel radii, depth-aware denoise, multiplied into sceneRT
 *   4. FX pass         layers FX (particles / tracers) after AO, depth-tested against 1+2
 *   5. TAA             Halton jitter, depth + viewmodel-transform reprojection, variance clipping
 *   6. bloom           Karis/soft-knee prefilter, 13-tap down chain, tent up chain
 *   7. sun shafts      sky mask + 2 radial blurs, 1x1 sun visibility probe (lens flare)
 *   8. ADS DOF         half-res CoC + scatter-as-gather
 *   9. final uber pass motion blur / CAS / CA / DOF / bloom / flare / tonemap / grade / pulses / grain
 *  10. SMAA           (low/medium tiers instead of TAA) pmndrs SMAAEffect on the LDR result
 */

export const VM_K = 0.004;
export const VM_NEAR = 0.01;
export const VM_FAR = 12;
const LAYER_VM = 1;
const LAYER_FX = 2;

function halton(i, b) {
  let f = 1, r = 0;
  while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
  return r;
}
const JITTER = [];
for (let i = 1; i <= 16; i++) JITTER.push([halton(i, 2) - 0.5, halton(i, 3) - 0.5]);

const TONEMAPPERS = { agx: 0, aces: 1, neutral: 2, none: 3, linear: 3 };
const DEBUG_VIEWS = { none: 0, hdr: 1, rays: 2, coc: 3, ao: 10, depth: 11, bloom: 12 };

export class Pipeline {
  constructor(ctx, { params, noiseTexture, bloodTexture = null }) {
    this.ctx = ctx;
    this.renderer = ctx.renderer;
    this.scene = ctx.scene;
    this.camera = ctx.camera;
    this.params = params;
    this.noise = noiseTexture;
    this.blood = bloodTexture;
    this.quad = new FullscreenQuad();
    this.width = 0;
    this.height = 0;
    this.frame = 0;
    this.historyValid = false;
    this.flags = {
      aa: true, ao: true, bloom: true, rays: true, flare: true, dof: true, motionBlur: true,
      grain: true, vignette: true, ca: true, sharpen: true, grade: true,
    };
    this.quality = null;
    this.state = {
      ads: 0, damage: 0, lowHealth: 0, flash: 0, after: 0, radial: 0, double: 0, desat: 0, darken: 0,
      blackout: 0, caExtra: 0, exposureMul: 1,
    };
    this.captureAfterimage = false;
    this.viewmodelFov = null;
    this.stats = { sunFactor: 0, sunUV: [0, 0], motionBlurActive: false, dofActive: false, raysActive: false };

    // matrices / scratch (no per-frame allocation)
    this._projU = new THREE.Matrix4();
    this._projJ = new THREE.Matrix4();
    this._vmCam = new THREE.PerspectiveCamera(50, 1, VM_NEAR, VM_FAR);
    this._vmProjU = new THREE.Matrix4();
    this._vmProjZ = new THREE.Matrix4();
    this._view = new THREE.Matrix4();
    this._viewProj = new THREE.Matrix4();
    this._invViewProj = new THREE.Matrix4();
    this._prevViewProj = new THREE.Matrix4();
    this._reproj = new THREE.Matrix4();
    this._vmRel = new THREE.Matrix4();
    this._prevVmRel = new THREE.Matrix4();
    this._prevVmProj = new THREE.Matrix4();
    this._reprojVM = new THREE.Matrix4();
    this._m0 = new THREE.Matrix4();
    this._m1 = new THREE.Matrix4();
    this._camPos = new THREE.Vector3();
    this._prevCamPos = new THREE.Vector3();
    this._prevFov = 0;
    this._sunDir = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._v4 = new THREE.Vector4();
    this._size = new THREE.Vector2();
    this._lightScanFrame = -1000;
    this._lightScanChildren = -1;
    this._patchLight = (o) => { if (o.isLight) o.layers.mask |= (1 << LAYER_VM) | (1 << LAYER_FX); };

    this.depthParams = new THREE.Vector4();
    this.uDepthParams = { value: this.depthParams };
    this.uVmK = { value: VM_K };
    this.fullSize = new THREE.Vector2(1, 1);
    this.halfSize = new THREE.Vector2(1, 1);
    this.quarterSize = new THREE.Vector2(1, 1);

    this.targets = [];
    this._createMaterials();
    this.smaaEffect = null;
    this.smaaPass = null;
  }

  // ------------------------------------------------------------------------------------ setup
  _createMaterials() {
    const U = (v) => ({ value: v });
    const dp = this.uDepthParams;
    const vk = this.uVmK;

    this.mDepthLin = passMaterial({ name: 'depthLinearize', uniforms: { tDepth: U(null), uDepthParams: dp, uVmK: vk }, fragmentShader: DEPTH_LINEARIZE_FRAG });
    this.mDepthDown = passMaterial({ name: 'depthDown', uniforms: { tLin: U(null) }, fragmentShader: DEPTH_DOWNSAMPLE_FRAG });
    this.mGtao = passMaterial({
      name: 'gtao',
      defines: { SLICES: 3, STEPS: 6 },
      uniforms: {
        tLinDepth: U(null), uHalfSize: U(this.halfSize), uFullSize: U(this.fullSize),
        uProj: U(new THREE.Vector4()), uProjVM: U(new THREE.Vector4()), uP00: U(new THREE.Vector2()),
        uRadius: U(new THREE.Vector2(1, 0.05)), uMaxRadiusPx: U(64), uFar: U(1500), uNoiseOffset: U(0),
        uFalloffRatio: U(0.615),
      },
      fragmentShader: GTAO_FRAG,
    });
    this.mAoDenoise = passMaterial({
      name: 'aoDenoise',
      uniforms: { tAO: U(null), tLinDepth: U(null), uHalfSize: U(this.halfSize), uDir: U(new THREE.Vector2(1, 0)) },
      fragmentShader: AO_DENOISE_FRAG,
    });
    // uDir is an ivec2 in GLSL; three uploads Vector2 as uniform2iv only for Int32Array -> use array
    this.mAoDenoise.uniforms.uDir.value = new Int32Array([1, 0]);
    this.mAoApply = passMaterial({
      name: 'aoApply',
      uniforms: {
        tAO: U(null), tLinDepth: U(null), tLinFull: U(null), uHalfSize: U(this.halfSize),
        uPower: U(new THREE.Vector2(1.5, 1.3)), uFade: U(new THREE.Vector2(60, 140)), uDebug: U(0),
        uDepthParams: dp, uVmK: vk,
      },
      fragmentShader: AO_APPLY_FRAG,
      blending: THREE.CustomBlending,
      extra: {
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.ZeroFactor,
        blendDst: THREE.SrcColorFactor,
        blendEquationAlpha: THREE.AddEquation,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
      },
    });
    this.mTaa = passMaterial({
      name: 'taa',
      uniforms: {
        tColor: U(null), tDepth: U(null), tHistory: U(null), uSize: U(this.fullSize),
        uReproj: U(this._reproj), uReprojVM: U(this._reprojVM), uVmK: vk, uReset: U(1),
        uAlpha: U(new THREE.Vector2(0.1, 0.14)), uGamma: U(new THREE.Vector2(1.0, 0.85)),
      },
      fragmentShader: TAA_FRAG,
    });
    this.mBloomDown = passMaterial({
      name: 'bloomDown',
      uniforms: { tSrc: U(null), uTexel: U(new THREE.Vector2()), uFirst: U(0), uThreshold: U(new THREE.Vector4(1, 0.5, 1, 2000)) },
      fragmentShader: BLOOM_DOWN_FRAG,
    });
    this.mBloomUp = passMaterial({
      name: 'bloomUp',
      uniforms: { tLow: U(null), tHigh: U(null), uTexel: U(new THREE.Vector2()), uRadius: U(1), uWeight: U(1) },
      fragmentShader: BLOOM_UP_FRAG,
    });
    this.mRaysMask = passMaterial({
      name: 'raysMask',
      uniforms: {
        tColor: U(null), tLinDepth: U(null), uHalfSize: U(this.halfSize), uSun: U(new THREE.Vector2()),
        uAspect: U(1), uSkyDist: U(1000), uExposure: U(1), uFalloff: U(new THREE.Vector2(14, 260)),
      },
      fragmentShader: RAYS_MASK_FRAG,
    });
    this.mRaysBlur = passMaterial({
      name: 'raysBlur',
      defines: { SAMPLES: 24 },
      uniforms: { tSrc: U(null), uSun: U(new THREE.Vector2()), uLength: U(0.85), uDecay: U(0.96), uNoise: U(0) },
      fragmentShader: RAYS_BLUR_FRAG,
    });
    this.mSunVis = passMaterial({
      name: 'sunVis',
      uniforms: {
        tLinDepth: U(null), tColor: U(null), uHalfSize: U(this.halfSize), uSun: U(new THREE.Vector2()), uAspect: U(1),
        uSkyDist: U(1000), uRadius: U(0.012), uExposure: U(1),
      },
      fragmentShader: SUN_VIS_FRAG,
    });
    this.mDofCoc = passMaterial({
      name: 'dofCoc',
      uniforms: {
        tColor: U(null), tDepth: U(null), uFullSize: U(this.fullSize), uAspect: U(1),
        uVM: U(new THREE.Vector4()), uWorld: U(new THREE.Vector4()), uDepthParams: dp, uVmK: vk,
      },
      fragmentShader: DOF_COC_FRAG,
    });
    this.mDofGather = passMaterial({
      name: 'dofGather',
      defines: { RINGS: 3 },
      uniforms: { tCoc: U(null), uHalfSize: U(this.halfSize), uMaxCoc: U(4) },
      fragmentShader: DOF_GATHER_FRAG,
    });
    this.mAfter = passMaterial({ name: 'afterimage', uniforms: { tColor: U(null), uExposure: U(1) }, fragmentShader: AFTERIMAGE_FRAG });
    this.mCopy = passMaterial({ name: 'copy', uniforms: { tSrc: U(null), uScaleBias: U(new THREE.Vector4(1, 0, 0, 0)), uMode: U(0) }, fragmentShader: COPY_FRAG });

    this.mFinal = passMaterial({
      name: 'final',
      uniforms: {
        tColor: U(null), tDepth: U(null), tBloom: U(null), tRays: U(null), tSunVis: U(null), tDof: U(null),
        tAfter: U(null), tGrain: U(this.noise), tBlood: U(this.blood), uBloodOn: U(this.blood ? 1 : 0),
        uDepthParams: dp, uVmK: vk,
        uSize: U(this.fullSize), uAspect: U(1), uFrame: U(0), uTime: U(0), uToScreen: U(1), uToneMapper: U(0),
        uExposure: U(1), uSharpen: U(0.3), uCA: U(new THREE.Vector2(1, 0)), uBloom: U(0.08),
        uRaysColor: U(new THREE.Vector3(1, 0.85, 0.65)), uRays: U(0), uSunUV: U(new THREE.Vector2()),
        uSunFactor: U(0), uFlare: U(0), uDofOn: U(0),
        uMBOn: U(0), uMBReproj: U(this._reproj), uMBScale: U(0.5), uMBMaxPx: U(28),
        uLookSlope: U(new THREE.Vector3(1, 1, 1)), uLookOffset: U(new THREE.Vector3()), uLookPower: U(new THREE.Vector3(1, 1, 1)),
        uLookSat: U(1), uLift: U(new THREE.Vector3()), uGammaG: U(new THREE.Vector3(1, 1, 1)), uGain: U(new THREE.Vector3(1, 1, 1)),
        uShadowTint: U(new THREE.Vector3()), uHighTint: U(new THREE.Vector3()), uSaturation: U(1), uContrast: U(1),
        uVignette: U(new THREE.Vector2(0.25, 0.5)), uGrain: U(new THREE.Vector2(0.03, 1.4)),
        uDamage: U(0), uLowHealth: U(0), uFlash: U(0), uAfter: U(0), uRadial: U(0), uDouble: U(0), uDesat: U(0),
        uDarken: U(0), uBlackout: U(0), uDebug: U(0),
      },
      fragmentShader: FINAL_FRAG,
    });
    this.materials = [this.mDepthLin, this.mDepthDown, this.mGtao, this.mAoDenoise, this.mAoApply, this.mTaa, this.mBloomDown, this.mBloomUp,
      this.mRaysMask, this.mRaysBlur, this.mSunVis, this.mDofCoc, this.mDofGather, this.mAfter, this.mCopy, this.mFinal];

    // 1x1 black fallback so the final shader never samples an unbound texture
    const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    black.needsUpdate = true;
    this.blackTex = black;
  }

  /** Apply a quality tier (object from quality.js). */
  setQuality(q) {
    const prev = this.quality;
    this.quality = q;
    const setDefine = (m, k, v) => { if (m.defines[k] !== v) { m.defines[k] = v; m.needsUpdate = true; } };
    setDefine(this.mGtao, 'SLICES', q.aoSlices);
    setDefine(this.mGtao, 'STEPS', q.aoSteps);
    setDefine(this.mRaysBlur, 'SAMPLES', q.raySamples);
    setDefine(this.mDofGather, 'RINGS', q.dofRings);
    if (!prev || prev.bloomLevels !== q.bloomLevels) this._allocBloom();
    this.historyValid = false;
  }

  _ensureSmaa(preset) {
    if (this.smaaEffect && this._smaaPreset === preset && this.ldrRT) return;
    this._smaaPreset = preset;
    if (!this.smaaEffect) {
      this.smaaEffect = new SMAAEffect({ preset, edgeDetectionMode: EdgeDetectionMode.COLOR });
      const ready = new Promise((resolve) => {
        this.smaaEffect.addEventListener('load', () => resolve());
        setTimeout(resolve, 5000); // never block readiness forever
      });
      this.ctx.assets.track(ready, 'postfx:smaa-textures');
      this.smaaPass = new EffectPass(this.camera, this.smaaEffect);
      this.smaaPass.initialize(this.renderer, false, THREE.UnsignedByteType);
      this.smaaPass.renderToScreen = true;
      if (this.width > 0) this.smaaPass.setSize(this.width, this.height);
    } else {
      this.smaaEffect.applyPreset(preset);
    }
    if (!this.ldrRT && this.width > 0) this.ldrRT = this._target(this.width, this.height, { type: THREE.UnsignedByteType, name: 'ldr', colorSpace: THREE.SRGBColorSpace });
  }

  _target(w, h, opts) {
    const t = makeTarget(w, h, opts);
    this.targets.push(t);
    return t;
  }

  _allocBloom() {
    for (const t of this.bloomDown || []) { t.dispose(); this.targets.splice(this.targets.indexOf(t), 1); }
    for (const t of this.bloomUp || []) { t.dispose(); this.targets.splice(this.targets.indexOf(t), 1); }
    this.bloomDown = [];
    this.bloomUp = [];
    const levels = this.quality?.bloomLevels ?? 6;
    let w = Math.max(1, this.width >> 1), h = Math.max(1, this.height >> 1);
    for (let i = 0; i < levels; i++) {
      this.bloomDown.push(this._target(w, h, { name: `bloomDown${i}` }));
      if (i < levels - 1) this.bloomUp.push(this._target(w, h, { name: `bloomUp${i}` }));
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
  }

  setSize(width, height) {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    for (const t of this.targets) t.dispose();
    this.targets.length = 0;
    this.bloomDown = [];
    this.bloomUp = [];
    this.ldrRT = null;
    const hw = Math.max(1, width >> 1), hh = Math.max(1, height >> 1);
    const qw = Math.max(1, width >> 2), qh = Math.max(1, height >> 2);
    this.fullSize.set(width, height);
    this.halfSize.set(hw, hh);
    this.quarterSize.set(qw, qh);

    this.sceneRT = this._target(width, height, { name: 'scene', depth: true });
    const dt = new THREE.DepthTexture(width, height, THREE.FloatType);
    dt.format = THREE.DepthFormat;
    dt.minFilter = THREE.NearestFilter;
    dt.magFilter = THREE.NearestFilter;
    this.sceneRT.depthTexture = dt;
    this.linFull = this._target(width, height, { name: 'linDepthFull', type: THREE.FloatType, format: THREE.RedFormat, filter: THREE.NearestFilter });
    this.linDepth = this._target(hw, hh, { name: 'linDepth', type: THREE.FloatType, format: THREE.RedFormat, filter: THREE.NearestFilter });
    this.aoA = this._target(hw, hh, { name: 'aoA', format: THREE.RedFormat, filter: THREE.NearestFilter });
    this.aoB = this._target(hw, hh, { name: 'aoB', format: THREE.RedFormat, filter: THREE.NearestFilter });
    this.histA = this._target(width, height, { name: 'historyA' });
    this.histB = this._target(width, height, { name: 'historyB' });
    this.raysMask = this._target(qw, qh, { name: 'raysMask', format: THREE.RedFormat });
    this.raysA = this._target(qw, qh, { name: 'raysA', format: THREE.RedFormat });
    this.raysB = this._target(qw, qh, { name: 'raysB', format: THREE.RedFormat });
    this.sunVis = this._target(1, 1, { name: 'sunVis', type: THREE.FloatType, filter: THREE.NearestFilter });
    this.dofCoc = this._target(hw, hh, { name: 'dofCoc' });
    this.dofBlur = this._target(hw, hh, { name: 'dofBlur' });
    this.afterRT = this._target(hw, hh, { name: 'afterimage', type: THREE.UnsignedByteType });
    this._allocBloom();
    if (this.smaaPass) {
      this.smaaPass.setSize(width, height);
      this.ldrRT = this._target(width, height, { type: THREE.UnsignedByteType, name: 'ldr', colorSpace: THREE.SRGBColorSpace });
    }
    this.historyValid = false;
    this._clearTargets = true;
  }

  // ------------------------------------------------------------------------------------ helpers
  _draw(material, target) { this.quad.draw(this.renderer, material, target); }

  _patchLights(frame) {
    const n = this.scene.children.length;
    if (frame - this._lightScanFrame < 20 && n === this._lightScanChildren) return;
    this._lightScanFrame = frame;
    this._lightScanChildren = n;
    this.scene.traverse(this._patchLight);
  }

  _compressDepth(src, dst) {
    dst.copy(src);
    const e = dst.elements, k = VM_K;
    for (let c = 0; c < 4; c++) e[c * 4 + 2] = k * e[c * 4 + 2] + (k - 1) * e[c * 4 + 3];
    return dst;
  }

  _projInfo(m, out) {
    const e = m.elements;
    return out.set(1 / e[0], 1 / e[5], e[8], e[9]);
  }

  // ------------------------------------------------------------------------------------ frame
  render(dt, t) {
    const r = this.renderer;
    const cam = this.camera;
    const scene = this.scene;
    const P = this.params;
    const F = this.flags;
    const q = this.quality;
    r.getDrawingBufferSize(this._size);
    this.setSize(this._size.x, this._size.y);
    const W = this.width, H = this.height;
    this.frame++;

    const aaMode = !F.aa ? 'none' : (P.aa && P.aa !== 'auto' ? P.aa : q.aa);
    if (aaMode === 'smaa') this._ensureSmaa(q.smaaPreset);
    const useTaa = aaMode === 'taa';
    const useSmaa = aaMode === 'smaa' && !!this.smaaPass;
    this.aaMode = aaMode;
    const useAo = F.ao && q.ao;

    // ---------------------------------------------------------------- saved renderer state
    const savedAutoClear = r.autoClear;
    const savedShadowAuto = r.shadowMap.autoUpdate;
    const savedBackground = scene.background;
    const savedMWAU = scene.matrixWorldAutoUpdate;
    const savedMask = cam.layers.mask;
    this._projU.copy(cam.projectionMatrix);

    try {
      if (this._clearTargets) {
        this._clearTargets = false;
        r.setClearColor(0x000000, 0);
        for (const tg of [this.aoA, this.aoB, this.raysA, this.raysB, this.raysMask, this.sunVis, this.afterRT, this.dofBlur]) {
          r.setRenderTarget(tg);
          r.clear(true, false, false);
        }
      }
      // ---------------------------------------------------------------- 1. world
      const jit = useTaa ? JITTER[this.frame % JITTER.length] : null;
      this._projJ.copy(this._projU);
      if (jit) {
        this._projJ.elements[8] -= (jit[0] * 2) / W;
        this._projJ.elements[9] -= (jit[1] * 2) / H;
      }
      cam.projectionMatrix.copy(this._projJ);
      const vmBit = 1 << LAYER_VM, fxBit = 1 << LAYER_FX;
      const hasVM = (savedMask & vmBit) !== 0;
      const hasFX = (savedMask & fxBit) !== 0;
      cam.layers.mask = savedMask & ~(vmBit | fxBit);
      r.autoClear = true;
      r.setRenderTarget(this.sceneRT);
      r.render(scene, cam);

      // camera matrices are now current (scene.updateMatrixWorld ran inside render)
      this._view.copy(cam.matrixWorldInverse);
      this._camPos.setFromMatrixPosition(cam.matrixWorld);
      this._viewProj.multiplyMatrices(this._projU, this._view);
      this._invViewProj.copy(this._viewProj).invert();
      const cut = this._camPos.distanceToSquared(this._prevCamPos) > 9 || Math.abs(cam.fov - this._prevFov) > 8;
      if (cut) this.historyValid = false;
      this._reproj.multiplyMatrices(this.historyValid ? this._prevViewProj : this._viewProj, this._invViewProj);

      // viewmodel projection
      const vmc = this._vmCam;
      const vfov = this.viewmodelFov ?? cam.fov;
      if (vmc.fov !== vfov || vmc.aspect !== cam.aspect || vmc.zoom !== cam.zoom) {
        vmc.fov = vfov; vmc.aspect = cam.aspect; vmc.zoom = cam.zoom;
        vmc.updateProjectionMatrix();
      }
      this._vmProjU.copy(vmc.projectionMatrix);
      const vmRoot = this.ctx.services.weapons?.viewmodel;
      if (vmRoot && vmRoot.isObject3D) this._vmRel.multiplyMatrices(this._view, vmRoot.matrixWorld);
      else this._vmRel.identity();
      // reprojVM = prevVmProj * prevVmRel * inv(vmRel) * inv(vmProj)
      this._m0.copy(this._vmRel).invert();
      this._m1.copy(this._vmProjU).invert();
      this._reprojVM.multiplyMatrices(this.historyValid ? this._prevVmProj : this._vmProjU, this.historyValid ? this._prevVmRel : this._vmRel)
        .multiply(this._m0).multiply(this._m1);

      this.depthParams.set(cam.near, cam.far, VM_NEAR, VM_FAR);

      // ---------------------------------------------------------------- 2. viewmodel
      r.autoClear = false;
      scene.background = null;
      r.shadowMap.autoUpdate = false;
      scene.matrixWorldAutoUpdate = false;
      if (hasVM) {
        this._patchLights(this.frame);
        this._m0.copy(this._vmProjU);
        if (jit) {
          this._m0.elements[8] -= (jit[0] * 2) / W;
          this._m0.elements[9] -= (jit[1] * 2) / H;
        }
        cam.projectionMatrix.copy(this._compressDepth(this._m0, this._vmProjZ));
        cam.layers.mask = vmBit;
        r.render(scene, cam);
      }

      // ---------------------------------------------------------------- 3. AO
      const needLin = useAo || (F.rays && q.rays) || (F.flare && q.flare);
      if (needLin) {
        this.mDepthLin.uniforms.tDepth.value = this.sceneRT.depthTexture;
        this._draw(this.mDepthLin, this.linFull);
        this.mDepthDown.uniforms.tLin.value = this.linFull.texture;
        this._draw(this.mDepthDown, this.linDepth);
      }
      if (useAo) this._renderAO(cam);

      // ---------------------------------------------------------------- 4. FX
      if (hasFX) {
        if (!hasVM) this._patchLights(this.frame);
        cam.projectionMatrix.copy(this._projJ);
        cam.layers.mask = fxBit;
        r.render(scene, cam);
      }
    } finally {
      cam.projectionMatrix.copy(this._projU);
      cam.layers.mask = savedMask;
      scene.background = savedBackground;
      scene.matrixWorldAutoUpdate = savedMWAU;
      r.shadowMap.autoUpdate = savedShadowAuto;
      r.autoClear = savedAutoClear;
    }

    r.autoClear = false;
    try {
      this._post(dt, t, useTaa, useSmaa);
    } finally {
      r.autoClear = savedAutoClear;
      r.setRenderTarget(null);
    }

    this._prevViewProj.copy(this._viewProj);
    this._prevVmRel.copy(this._vmRel);
    this._prevVmProj.copy(this._vmProjU);
    this._prevCamPos.copy(this._camPos);
    this._prevFov = cam.fov;
    return true;
  }

  _renderAO(cam) {
    const P = this.params;
    const g = this.mGtao.uniforms;
    g.tLinDepth.value = this.linDepth.texture;
    this._projInfo(this._projU, g.uProj.value);
    this._projInfo(this._vmProjU, g.uProjVM.value);
    g.uP00.value.set(this._projU.elements[0], this._vmProjU.elements[0]);
    g.uRadius.value.set(P.aoRadius, P.aoRadiusVM);
    g.uMaxRadiusPx.value = P.aoMaxRadiusPx * (this.height / 1080);
    g.uFar.value = cam.far;
    g.uFalloffRatio.value = P.aoFalloff;
    g.uNoiseOffset.value = this.aaMode === 'taa' ? (this.frame % 8) * 5.588238 : 0;
    this._draw(this.mGtao, this.aoA);
    const d = this.mAoDenoise.uniforms;
    d.tLinDepth.value = this.linDepth.texture;
    d.tAO.value = this.aoA.texture;
    d.uDir.value[0] = 1; d.uDir.value[1] = 0;
    this._draw(this.mAoDenoise, this.aoB);
    d.tAO.value = this.aoB.texture;
    d.uDir.value[0] = 0; d.uDir.value[1] = 1;
    this._draw(this.mAoDenoise, this.aoA);
    const a = this.mAoApply.uniforms;
    a.tAO.value = this.aoA.texture;
    a.tLinDepth.value = this.linDepth.texture;
    a.tLinFull.value = this.linFull.texture;
    a.uPower.value.set(P.aoPower, P.aoPowerVM);
    a.uFade.value.set(P.aoFadeStart, P.aoFadeEnd);
    if (P.debugView !== 'ao') this._draw(this.mAoApply, this.sceneRT);
  }

  _post(dt, t, useTaa, useSmaa) {
    const r = this.renderer;
    const cam = this.camera;
    const P = this.params;
    const F = this.flags;
    const q = this.quality;
    const S = this.state;
    const W = this.width, H = this.height;
    const aspect = W / H;
    const exposure = r.toneMappingExposure * P.exposureBias * S.exposureMul;

    // ---------------------------------------------------------------- 5. TAA
    let color = this.sceneRT.texture;
    if (useTaa) {
      const cur = (this.frame & 1) ? this.histA : this.histB;
      const prev = (this.frame & 1) ? this.histB : this.histA;
      const u = this.mTaa.uniforms;
      u.tColor.value = this.sceneRT.texture;
      u.tDepth.value = this.sceneRT.depthTexture;
      u.tHistory.value = prev.texture;
      u.uReset.value = this.historyValid ? 0 : 1;
      u.uAlpha.value.set(P.taaAlpha, P.taaAlphaVM);
      u.uGamma.value.set(P.taaGamma, P.taaGammaVM);
      this._draw(this.mTaa, cur);
      this.historyValid = true;
      color = cur.texture;
    } else {
      this.historyValid = false;
    }

    if (this.captureAfterimage) {
      this.captureAfterimage = false;
      this.mAfter.uniforms.tColor.value = color;
      this.mAfter.uniforms.uExposure.value = exposure;
      this._draw(this.mAfter, this.afterRT);
    }

    // ---------------------------------------------------------------- 6. bloom
    const bloomOn = F.bloom && q.bloom && P.bloomIntensity > 0;
    if (bloomOn) this._renderBloom(color, exposure);

    // ---------------------------------------------------------------- 7. sun
    const sun = this._sunScreen(aspect);
    const raysOn = F.rays && q.rays && sun > 0.001 && P.raysIntensity > 0;
    const flareOn = F.flare && q.flare && sun > 0.001 && P.flareIntensity > 0;
    const skyDist = cam.far * P.skyDistanceFrac;
    if (flareOn || raysOn) {
      const v = this.mSunVis.uniforms;
      v.tLinDepth.value = this.linDepth.texture;
      v.uSun.value.set(this.stats.sunUV[0], this.stats.sunUV[1]);
      v.uAspect.value = aspect;
      v.uSkyDist.value = skyDist;
      v.tColor.value = color;
      v.uExposure.value = exposure;
      this._draw(this.mSunVis, this.sunVis);
    }
    if (raysOn) {
      const m = this.mRaysMask.uniforms;
      m.tColor.value = color;
      m.tLinDepth.value = this.linDepth.texture;
      m.uSun.value.set(this.stats.sunUV[0], this.stats.sunUV[1]);
      m.uAspect.value = aspect;
      m.uSkyDist.value = skyDist;
      m.uExposure.value = exposure;
      m.uFalloff.value.set(P.raysFalloff, P.raysCore);
      this._draw(this.mRaysMask, this.raysMask);
      const b = this.mRaysBlur.uniforms;
      b.uSun.value.copy(m.uSun.value);
      b.tSrc.value = this.raysMask.texture;
      b.uLength.value = P.raysLength;
      b.uDecay.value = P.raysDecay;
      b.uNoise.value = (this.frame % 16) * 3.7;
      this._draw(this.mRaysBlur, this.raysA);
      b.tSrc.value = this.raysA.texture;
      b.uLength.value = P.raysLength * 0.25;
      b.uDecay.value = 0.99;
      b.uNoise.value = (this.frame % 16) * 3.7 + 17.0;
      this._draw(this.mRaysBlur, this.raysB);
    }
    this.stats.raysActive = raysOn;

    // ---------------------------------------------------------------- 8. DOF
    const vmScale = H / 1080;
    const worldDof = P.dofWorldCoc > 0;
    const dofOn = F.dof && q.dof && (S.ads > 0.01 || worldDof) && (P.dofVMCoc > 0 || worldDof);
    if (dofOn) {
      const c = this.mDofCoc.uniforms;
      c.tColor.value = color;
      c.tDepth.value = this.sceneRT.depthTexture;
      c.uAspect.value = aspect;
      const adsE = S.ads * S.ads * (3 - 2 * S.ads);
      c.uVM.value.set(P.dofVMCoc * vmScale * adsE, P.dofRadialStart, P.dofRadialEnd, P.dofNearZ);
      c.uWorld.value.set(P.dofWorldCoc * vmScale, P.dofWorldStart, P.dofWorldRange, P.dofWorldNear);
      this._draw(this.mDofCoc, this.dofCoc);
      const gth = this.mDofGather.uniforms;
      gth.tCoc.value = this.dofCoc.texture;
      gth.uMaxCoc.value = Math.max(P.dofVMCoc, P.dofWorldCoc) * vmScale;
      this._draw(this.mDofGather, this.dofBlur);
    }
    this.stats.dofActive = dofOn;

    // ---------------------------------------------------------------- motion blur decision (CPU)
    let mbOn = false;
    if (F.motionBlur && q.motionBlur && P.motionBlur > 0) {
      mbOn = this._cameraMotionPx(W, H) * P.motionBlur > 0.75;
    }
    this.stats.motionBlurActive = mbOn;

    // ---------------------------------------------------------------- 9. final
    const f = this.mFinal.uniforms;
    f.tColor.value = color;
    f.tDepth.value = this.sceneRT.depthTexture;
    f.tBloom.value = bloomOn ? this.bloomUp[0]?.texture ?? this.bloomDown[0].texture : this.blackTex;
    f.uBloom.value = bloomOn ? P.bloomIntensity : 0;
    f.tRays.value = this.raysB.texture;
    f.uRays.value = raysOn ? P.raysIntensity * sun : 0;
    f.uRaysColor.value.set(P.raysColor[0], P.raysColor[1], P.raysColor[2]);
    f.tSunVis.value = this.sunVis.texture;
    f.uFlare.value = flareOn ? P.flareIntensity * sun : 0;
    f.uSunUV.value.set(this.stats.sunUV[0], this.stats.sunUV[1]);
    f.uSunFactor.value = sun;
    f.tDof.value = this.dofBlur.texture;
    f.uDofOn.value = dofOn ? 1 : 0;
    f.tAfter.value = this.afterRT.texture;
    f.uAspect.value = aspect;
    f.uFrame.value = this.frame % 4096;
    f.uTime.value = t;
    f.uToScreen.value = useSmaa ? 0 : 1;
    f.uToneMapper.value = TONEMAPPERS[P.toneMapper] ?? 0;
    f.uExposure.value = exposure;
    f.uSharpen.value = F.sharpen ? (P.sharpen ?? q.sharpen) * (useTaa ? 1 : 0.6) : 0;
    f.uCA.value.set(F.ca ? P.chromaticAberration * vmScale : 0, S.caExtra * vmScale);
    f.uMBOn.value = mbOn ? 1 : 0;
    f.uMBScale.value = P.motionBlur;
    f.uMBMaxPx.value = P.motionBlurMaxPx * vmScale;
    const L = P.look, G = P.grade;
    if (F.grade) {
      f.uLookSlope.value.fromArray(L.slope); f.uLookOffset.value.fromArray(L.offset); f.uLookPower.value.fromArray(L.power);
      f.uLookSat.value = L.saturation;
      f.uLift.value.fromArray(G.lift); f.uGammaG.value.fromArray(G.gamma); f.uGain.value.fromArray(G.gain);
      f.uShadowTint.value.fromArray(G.shadowTint); f.uHighTint.value.fromArray(G.highlightTint);
      f.uSaturation.value = G.saturation; f.uContrast.value = G.contrast;
    } else {
      f.uLookSlope.value.set(1, 1, 1); f.uLookOffset.value.set(0, 0, 0); f.uLookPower.value.set(1, 1, 1); f.uLookSat.value = 1;
      f.uLift.value.set(0, 0, 0); f.uGammaG.value.set(1, 1, 1); f.uGain.value.set(1, 1, 1);
      f.uShadowTint.value.set(0, 0, 0); f.uHighTint.value.set(0, 0, 0); f.uSaturation.value = 1; f.uContrast.value = 1;
    }
    f.uVignette.value.set(F.vignette ? P.vignette + P.vignetteADS * S.ads : 0, P.vignetteRoundness);
    f.uGrain.value.set(F.grain ? P.grain : 0, P.grainScale * vmScale);
    f.uDamage.value = S.damage;
    f.uLowHealth.value = S.lowHealth;
    f.uFlash.value = S.flash;
    f.uAfter.value = S.after;
    f.uRadial.value = S.radial;
    f.uDouble.value = S.double;
    f.uDesat.value = Math.min(1, S.desat);
    f.uDarken.value = Math.min(1, S.darken);
    f.uBlackout.value = Math.min(1, S.blackout);
    const dbg = DEBUG_VIEWS[P.debugView] ?? 0;
    f.uDebug.value = dbg < 10 ? dbg : 0;

    if (dbg >= 10) {
      const c = this.mCopy.uniforms;
      if (dbg === 10) { c.tSrc.value = this.aoA.texture; c.uMode.value = 1; }
      else if (dbg === 11) { c.tSrc.value = this.linDepth.texture; c.uMode.value = 2; }
      else { c.tSrc.value = bloomOn ? this.bloomUp[0].texture : this.blackTex; c.uMode.value = 0; }
      c.uScaleBias.value.set(dbg === 12 ? P.bloomIntensity * 4 : 1, 0, 0, 0);
      this._draw(this.mCopy, null);
      return;
    }

    if (useSmaa) {
      this._draw(this.mFinal, this.ldrRT);
      this.smaaPass.setDepthTexture?.(this.sceneRT.depthTexture);
      this.smaaPass.render(r, this.ldrRT, null, dt);
    } else {
      this._draw(this.mFinal, null);
    }
  }

  _renderBloom(color, exposure) {
    const P = this.params;
    const down = this.bloomDown, up = this.bloomUp;
    const d = this.mBloomDown.uniforms;
    let src = color, sw = this.width, sh = this.height;
    for (let i = 0; i < down.length; i++) {
      d.tSrc.value = src;
      d.uTexel.value.set(1 / sw, 1 / sh);
      d.uFirst.value = i === 0 ? 1 : 0;
      d.uThreshold.value.set(P.bloomThreshold, P.bloomKnee, exposure, 3000);
      this._draw(this.mBloomDown, down[i]);
      src = down[i].texture;
      sw = down[i].width; sh = down[i].height;
    }
    const u = this.mBloomUp.uniforms;
    let low = down[down.length - 1];
    for (let i = up.length - 1; i >= 0; i--) {
      u.tLow.value = low.texture;
      u.tHigh.value = down[i].texture;
      u.uTexel.value.set(1 / low.width, 1 / low.height);
      u.uRadius.value = P.bloomRadius;
      u.uWeight.value = P.bloomScatter;
      this._draw(this.mBloomUp, up[i]);
      low = up[i];
    }
  }

  /** Sun screen position + visibility factor (0 when behind / far off-screen). */
  _sunScreen(aspect) {
    const lighting = this.ctx.services.lighting;
    let dir = null;
    try { dir = lighting.getSunDirection(this._sunDir); } catch { dir = null; }
    if (!dir || !lighting.sun && !this.ctx.services.isProvided('lighting')) { this.stats.sunFactor = 0; return 0; }
    const v = this._v4.set(this._camPos.x + dir.x * 1000, this._camPos.y + dir.y * 1000, this._camPos.z + dir.z * 1000, 1).applyMatrix4(this._viewProj);
    this._fwd.set(0, 0, -1).transformDirection(this.camera.matrixWorld);
    const facing = this._fwd.dot(dir);
    if (v.w <= 0 || facing <= 0) { this.stats.sunFactor = 0; return 0; }
    const u = v.x / v.w * 0.5 + 0.5, w = v.y / v.w * 0.5 + 0.5;
    this.stats.sunUV[0] = u; this.stats.sunUV[1] = w;
    const ox = Math.max(0, -u, u - 1) * aspect, oy = Math.max(0, -w, w - 1);
    const out = Math.sqrt(ox * ox + oy * oy);
    const onScreen = 1 - smooth(0.0, 0.45, out);
    const f = onScreen * smooth(0.05, 0.3, facing) * Math.max(0, Math.min(1, dir.y * 6 + 0.3));
    this.stats.sunFactor = f;
    return f;
  }

  /** Max screen-space displacement (px) of a few far points between frames (camera-only motion). */
  _cameraMotionPx(W, H) {
    let maxPx = 0;
    const m = this._reproj;
    for (let i = 0; i < 5; i++) {
      const x = i === 0 ? 0 : (i & 1 ? -0.8 : 0.8);
      const y = i === 0 ? 0 : (i < 3 ? -0.8 : 0.8);
      this._v4.set(x, y, 0.995, 1).applyMatrix4(m);
      const dx = (this._v4.x / this._v4.w - x) * 0.5 * W;
      const dy = (this._v4.y / this._v4.w - y) * 0.5 * H;
      maxPx = Math.max(maxPx, Math.sqrt(dx * dx + dy * dy));
    }
    return maxPx;
  }

  resetHistory() { this.historyValid = false; }

  dispose() {
    for (const t of this.targets) t.dispose();
    this.targets.length = 0;
    this.sceneRT?.depthTexture?.dispose();
    for (const m of this.materials) m.dispose();
    this.blackTex.dispose();
    this.quad.dispose();
    this.smaaPass?.dispose();
    this.smaaEffect?.dispose();
  }
}

function smooth(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

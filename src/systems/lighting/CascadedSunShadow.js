import * as THREE from 'three';

const _lightRot = new THREE.Matrix4();
const _lightRotInv = new THREE.Matrix4();
const _sunDir = new THREE.Vector3();
const _center = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _scale = new THREE.Vector3();

/**
 * Per-cascade caster filter. The far cascade (55-150 m) spans most of the town, so it re-rendered every small
 * instanced prop (sandbags, debris, litter ...) whose shadows there are 1-2 texels wide. It now keeps only
 * casters whose single-piece world radius is >= minCasterRadius (merged batches / buildings / vehicles stay).
 */
class CascadeFrustum extends THREE.Frustum {
  constructor(minCasterRadius = 0) {
    super();
    this.minCasterRadius = minCasterRadius;
  }

  intersectsObject(object) {
    if (this.minCasterRadius > 0 && object.isMesh) {
      let r = object.userData._shadowPieceRadius;
      if (r === undefined) {
        const g = object.geometry;
        if (g && !g.boundingSphere) g.computeBoundingSphere();
        object.getWorldScale(_scale);
        r = (g?.boundingSphere?.radius ?? 1e9) * Math.max(Math.abs(_scale.x), Math.abs(_scale.y), Math.abs(_scale.z));
        object.userData._shadowPieceRadius = r; // static props: world scale does not change
      }
      if (r < this.minCasterRadius) return false;
    }
    return super.intersectsObject(object);
  }
}

/**
 * Stable cascaded shadow maps for three's SunLight (r186 WebGLRenderer natively supports `isSunLightShadow`
 * with an atlas + per-cascade matrices). Differences from three's SunLightShadow:
 *   - N cascades (default 4) in a 2x2 atlas; the matching `SUN_LIGHT_CASCADES` define is patched in chunks.js
 *   - explicit split distances tuned for a first-person shooter (very dense first cascade)
 *   - bounding-sphere fit computed analytically from the camera fov (rotation invariant) and snapped to the
 *     shadow texel grid -> no shimmering while turning/moving
 *   - always fitted to the provided `viewCamera` getter (the player camera), whatever camera triggered the
 *     shadow render (PMREM cube cameras, postfx passes ...)
 *   - cascadeData.w carries the world-space texel size, used by the patched getSunShadow() for texel-aware
 *     normal offset and a constant world-space penumbra across cascades.
 */
export class CascadedSunShadow extends THREE.LightShadow {
  constructor({ cascades = 4, getCamera = null } = {}) {
    super(new THREE.OrthographicCamera(-5, 5, 5, -5, 0.5, 500));
    this.isSunLightShadow = true;
    this.cascades = cascades;
    this.getViewCamera = getCamera;
    this.mapSize.set(2048, 2048);
    this.splits = [0.05, 6, 20, 55, 150];
    this.casterExtension = 250; // metres towards the sun that still cast into the cascades
    this.radiusQuantum = 0.5; // m, keeps the sphere radius (and therefore texel size) stable while zooming
    this._cameras = [];
    this._matrices = [];
    this._frustums = [];
    this._cascadeData = [];
    this._texel = [];
    this._viewportCount = cascades;
    const cols = cascades > 2 ? 2 : cascades;
    const rows = Math.ceil(cascades / cols);
    this._cols = cols;
    this._frameExtents.set(cols, rows);
    for (let i = 0; i < cascades; i++) {
      this._cameras.push(new THREE.OrthographicCamera());
      this._matrices.push(new THREE.Matrix4());
      // last cascade (far field) skips small casters; nearer cascades keep everything
      this._frustums.push(new CascadeFrustum(i === cascades - 1 && cascades > 2 ? 0.75 : 0));
      this._cascadeData.push(new THREE.Vector4());
      this._texel.push(0.01);
    }
    while (this._viewports.length < cascades) this._viewports.push(new THREE.Vector4());
    this.insetTexels = 8;
  }

  getCamera(i = 0) { return this._cameras[i]; }
  getMatrix(i = 0) { return this._matrices[i]; }
  getFrustum(i = 0) { return this._frustums[i]; }

  updateMatrices(light, viewCameraArg) {
    const viewCamera = (this.getViewCamera && this.getViewCamera()) || viewCameraArg;
    if (!viewCamera) return;
    const n = this.cascades;
    const inset = Math.min(0.25, this.insetTexels / this.mapSize.x);
    for (let i = 0; i < n; i++) {
      const cx = i % this._cols, cy = Math.floor(i / this._cols);
      this._viewports[i].set(cx + inset, cy + inset, 1 - 2 * inset, 1 - 2 * inset);
    }
    const resolution = this.mapSize.x * (1 - 2 * inset);

    // light orientation: looks from the sun towards -sunDir
    _sunDir.setFromMatrixPosition(light.matrixWorld).normalize();
    _up.set(0, 1, 0);
    if (Math.abs(_up.dot(_sunDir)) > 0.99) _up.set(0, 0, 1);
    _lightRot.lookAt(_sunDir, _zero, _up); // rotation whose -Z axis points along the light travel direction
    _lightRotInv.copy(_lightRot).transpose();

    viewCamera.updateMatrixWorld();
    const camPos = _camPos.setFromMatrixPosition(viewCamera.matrixWorld);
    _camFwd.set(0, 0, -1).transformDirection(viewCamera.matrixWorld);

    const persp = viewCamera.isPerspectiveCamera;
    const tanV = persp ? Math.tan(THREE.MathUtils.degToRad(viewCamera.fov * 0.5)) / (viewCamera.zoom || 1) : 1;
    const tanH = tanV * (viewCamera.aspect || 1);
    const diag = Math.sqrt(1 + tanV * tanV + tanH * tanH); // |corner| per unit depth incl. depth axis
    const lat = Math.sqrt(tanV * tanV + tanH * tanH); // lateral half-diagonal per unit depth

    const near0 = Math.max(viewCamera.near || 0.05, 0.01);
    const splits = this.splits;
    const fadeFrac = 0.12;

    for (let i = 0; i < n; i++) {
      const sNear = i === 0 ? near0 : splits[i];
      const sFar = splits[i + 1];
      // previous cascade's fade start is where this one must begin (so both can be sampled while blending)
      const prevFar = splits[i];
      const cascadeNear = i === 0 ? sNear : prevFar - fadeFrac * (prevFar - (i === 1 ? near0 : splits[i - 1]));
      const fadeStart = sFar - fadeFrac * (sFar - sNear);
      // minimal sphere enclosing the frustum slice [cascadeNear, sFar]
      const rn = cascadeNear * lat, rf = sFar * lat;
      let zc = (sFar * sFar - cascadeNear * cascadeNear + rf * rf - rn * rn) / (2 * (sFar - cascadeNear));
      zc = Math.min(Math.max(zc, cascadeNear), sFar);
      let radius = Math.sqrt(Math.max((zc - cascadeNear) ** 2 + rn * rn, (sFar - zc) ** 2 + rf * rf));
      radius = Math.ceil(radius / this.radiusQuantum) * this.radiusQuantum;
      radius /= 1 - 2 / resolution; // pad for snapping
      const texel = (2 * radius) / resolution;
      this._texel[i] = texel;

      // sphere centre in world, then in light space
      const c = _center.copy(camPos).addScaledVector(_camFwd, zc);
      c.applyMatrix4(_lightRotInv); // world -> light space (rotation only)
      c.x = Math.round(c.x / texel) * texel;
      c.y = Math.round(c.y / texel) * texel;
      // pull the camera towards the sun so casters outside the slice still render
      const back = radius + this.casterExtension;
      c.z += back;
      c.applyMatrix4(_lightRot);

      const cam = this._cameras[i];
      cam.position.copy(c);
      cam.quaternion.setFromRotationMatrix(_lightRot);
      cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
      cam.near = 0.5;
      cam.far = back + radius + 0.5;
      cam.coordinateSystem = this.camera.coordinateSystem;
      cam._reversedDepth = this.camera.reversedDepth;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      this._updateMatrix(cam, this._matrices[i], this._frustums[i], this._viewports[i]);
      this._cascadeData[i].set(i === 0 ? -1e10 : cascadeNear, i === n - 1 ? sFar : sFar, fadeStart, texel);
    }
    // last cascade fades out to "no shadow" over its fade band (handled by the shader: shadow=1 beyond)
    void diag;
  }

  /** world-space texel size of cascade i (m) */
  texelSize(i) { return this._texel[i]; }

  copy(source) {
    super.copy(source);
    this.splits = source.splits.slice();
    return this;
  }
}

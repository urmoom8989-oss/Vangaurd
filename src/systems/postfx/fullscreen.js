import * as THREE from 'three';

/**
 * Fullscreen-triangle helpers shared by every postfx pass.
 * One geometry + one orthographic camera; each pass owns its ShaderMaterial.
 */

export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

let _geo = null;
let _geoUsers = 0;

function sharedGeometry() {
  if (!_geo) {
    _geo = new THREE.BufferGeometry();
    _geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    _geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    _geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  }
  _geoUsers++;
  return _geo;
}

function releaseGeometry() {
  _geoUsers--;
  if (_geoUsers <= 0 && _geo) {
    _geo.dispose();
    _geo = null;
    _geoUsers = 0;
  }
}

export class FullscreenQuad {
  constructor() {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.mesh = new THREE.Mesh(sharedGeometry(), null);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrixWorldAutoUpdate = false;
  }

  /** Draw `material` into `target` (null = canvas). Never clears. */
  draw(renderer, material, target) {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.mesh, this.camera);
  }

  dispose() {
    releaseGeometry();
    this.mesh.material = null;
  }
}

/** ShaderMaterial preset for fullscreen passes (GLSL ES 3.0 via three's default prefix). */
export function passMaterial({ name, uniforms, fragmentShader, defines = {}, blending = THREE.NoBlending, extra = {} }) {
  const m = new THREE.ShaderMaterial({
    name: `postfx:${name}`,
    uniforms,
    defines,
    vertexShader: FS_VERT,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    blending,
    toneMapped: false,
    ...extra,
  });
  return m;
}

export function makeTarget(w, h, {
  type = THREE.HalfFloatType,
  format = THREE.RGBAFormat,
  filter = THREE.LinearFilter,
  depth = false,
  name = '',
  colorSpace = THREE.NoColorSpace,
} = {}) {
  const t = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type,
    format,
    minFilter: filter,
    magFilter: filter,
    depthBuffer: depth,
    stencilBuffer: false,
    generateMipmaps: false,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    colorSpace,
  });
  t.texture.name = `postfx:${name}`;
  return t;
}

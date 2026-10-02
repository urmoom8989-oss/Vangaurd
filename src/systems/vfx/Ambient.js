import * as THREE from 'three';
import { motesVertex, motesFragment } from './shaders.js';

/**
 * Floating dust motes around the camera: fully GPU-animated (wrapping box around the camera, wind drift,
 * forward-scattering glint towards the sun). One draw call, zero CPU cost per frame besides uniforms.
 */
export class DustMotes {
  constructor(count, rng, layer) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]), 2));
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count * 4; i++) seeds[i] = rng.next();
    geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = count;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.material = new THREE.ShaderMaterial({
      vertexShader: motesVertex,
      fragmentShader: motesFragment,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uTime: { value: 0 },
        uBox: { value: new THREE.Vector3(14, 7, 14) },
        uWind: { value: new THREE.Vector3(0.3, 0.02, 0.15) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uPixelScale: { value: 1000 },
        uColor: { value: new THREE.Color(1, 0.9, 0.75) },
      }]),
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      fog: true,
    });
    this.material.name = 'vfx_dust_motes';
    this.geometry = geo;
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'vfx_dust_motes';
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(layer);
    this.mesh.renderOrder = 12;
    this.mesh.matrixAutoUpdate = false;
  }

  update(t, sunDir, sunColor, pixelScale, wind, strength) {
    const u = this.material.uniforms;
    u.uTime.value = t;
    u.uSunDir.value.copy(sunDir);
    u.uPixelScale.value = pixelScale;
    u.uWind.value.copy(wind);
    u.uColor.value.copy(sunColor).multiplyScalar(strength);
    this.mesh.visible = strength > 0;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

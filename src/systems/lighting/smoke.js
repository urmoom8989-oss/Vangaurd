import * as THREE from 'three';
import { ATMO_DECL, ATMO_FUNCS } from './atmosphere.glsl.js';
import { atmoData } from './chunks.js';

/**
 * Distant smoke columns (burning buildings / fuel on the edge of town).
 *
 * One instanced draw call of soft "puff" sprites. Every puff loops along its column's life cycle
 * (rise with buoyancy that decays, grow, shear downwind, dissipate), so the plumes billow and drift
 * continuously and deterministically from ctx.time. Puffs use a baked cauliflower-billow atlas
 * (density + normal + thickness, generated once at init) and are lit with a wrapped sun term,
 * a column self-shadow (the far side of the plume from the sun is dark), sky ambient from above,
 * forward-scattered sun on thin edges when backlit, fire glow at the base, and the shared aerial
 * perspective so they sit at the right depth in the haze.
 */

const VERT = /* glsl */ `
attribute vec4 aBase;    // column base xyz, column seed
attribute vec4 aCol;     // height H, base radius, top radius, wind lean
attribute vec4 aPuff;    // phase offset, rand, rand, rand
attribute vec4 aMisc;    // life (s), albedo, fire, variant (0..3)
uniform float uTime;
uniform vec3 uWind;
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vR;
varying vec3 vU;
varying vec3 vF;
varying float vFade;
varying float vShade;
varying float vAlbedo;
varying float vFire;
varying float vAge;
${ATMO_DECL}
void main() {
	float life = aMisc.x;
	float a = fract( aPuff.x + uTime / life );
	float H = aCol.x;
	float h = H * pow( a, 0.78 );
	float r = mix( aCol.y, aCol.z, pow( a, 0.6 ) );
	vec3 side = normalize( cross( uWind, vec3( 0.0, 1.0, 0.0 ) ) );
	vec3 axis = aBase.xyz + vec3( 0.0, h, 0.0 ) + uWind * ( aCol.w * H * pow( a, 1.8 ) );
	// slow meander of the whole column
	axis += side * sin( h * 0.018 + aBase.w * 6.2831 + uTime * 0.04 ) * r * 0.45;
	vec3 off = side * ( aPuff.y - 0.5 ) * r * 1.1 + uWind * ( aPuff.z - 0.5 ) * r * 0.8 + vec3( 0.0, ( aPuff.w - 0.5 ) * r * 0.6, 0.0 );
	vec3 c = axis + off;

	// billboard basis (screen aligned), rotated per puff
	vec3 R = vec3( viewMatrix[ 0 ][ 0 ], viewMatrix[ 1 ][ 0 ], viewMatrix[ 2 ][ 0 ] );
	vec3 U = vec3( viewMatrix[ 0 ][ 1 ], viewMatrix[ 1 ][ 1 ], viewMatrix[ 2 ][ 1 ] );
	float ang = aPuff.y * 6.2831 + uTime * ( aPuff.z - 0.5 ) * 0.03;
	float cs = cos( ang ), sn = sin( ang );
	vec3 R2 = R * cs + U * sn;
	vec3 U2 = -R * sn + U * cs;
	float size = r * ( 0.8 + 0.3 * aPuff.w );
	vec3 p = c + ( R2 * position.x + U2 * position.y ) * size;
	vWorld = p;
	vR = R2; vU = U2; vF = normalize( cameraPosition - c );
	int v = int( aMisc.w );
	vUv = ( uv + vec2( float( v - ( v / 2 ) * 2 ), float( v / 2 ) ) ) * 0.5;
	vFade = smoothstep( 0.0, 0.03, a ) * ( 1.0 - smoothstep( 0.3, 1.0, a ) );
	// column self-shadow: puffs on the lee side of the column (away from the sun) sit in its shadow
	vec3 L = lgtAtmo[ 0 ].xyz;
	vec2 Lh = normalize( L.xz + vec2( 1e-4 ) );
	vec2 dh = off.xz / max( r, 1e-3 );
	float lee = clamp( 0.5 - 0.5 * dot( dh, Lh ) * 1.6, 0.0, 1.0 );
	float thick = mix( 2.2, 0.7, smoothstep( 0.0, 0.6, a ) );
	vShade = exp( -lee * thick * 1.6 ) * mix( 0.55, 1.0, smoothstep( 0.0, 0.35, a ) );
	vAlbedo = aMisc.y * mix( 1.0, 2.6, smoothstep( 0.05, 0.8, a ) );
	vFire = aMisc.z * ( 1.0 - smoothstep( 0.0, 0.07, a ) );
	vAge = a;
	gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
}
`;

const FRAG = /* glsl */ `
${ATMO_DECL}
${ATMO_FUNCS}
uniform sampler2D tMap;
uniform vec3 uSun;       // sun radiance-ish (colour * irradiance / pi)
uniform vec3 uSky;       // sky ambient from above
uniform vec3 uBounce;    // ground bounce from below
uniform vec3 uGlow;
uniform float uOpacity;
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vR;
varying vec3 vU;
varying vec3 vF;
varying float vFade;
varying float vShade;
varying float vAlbedo;
varying float vFire;
varying float vAge;

void main() {
	vec4 tx = texture2D( tMap, vUv );
	float alpha = tx.a * vFade * uOpacity * mix( 0.85, 0.35, smoothstep( 0.1, 0.8, vAge ) );
	if ( alpha < 0.003 ) discard;
	vec2 nxy = tx.rg * 2.0 - 1.0;
	float nz = sqrt( max( 0.0, 1.0 - dot( nxy, nxy ) ) );
	vec3 n = normalize( vR * nxy.x + vU * nxy.y + vF * nz );
	vec3 L = lgtAtmo[ 0 ].xyz;
	float ndl = dot( n, L );
	float wrap = pow( clamp( ndl * 0.6 + 0.4, 0.0, 1.0 ), 1.5 );
	float thin = 1.0 - tx.b;
	vec3 V = normalize( vWorld - cameraPosition );
	float cosT = dot( V, L );
	float g = 0.55;
	float hg = ( 1.0 - g * g ) / pow( max( 1.0 + g * g - 2.0 * g * cosT, 1e-3 ), 1.5 ) * 0.08;
	vec3 amb = mix( uBounce, uSky, n.y * 0.5 + 0.5 );
	vec3 col = vAlbedo * ( amb * mix( 0.55, 1.0, tx.b ) + uSun * ( wrap * vShade ) );
	col += uSun * hg * thin * vShade * 0.6;
	// fire glow: embers light the underside of the lowest puffs
	col += uGlow * vFire * ( 0.4 + 0.6 * clamp( -n.y * 0.5 + 0.5, 0.0, 1.0 ) ) * ( 0.5 + 0.5 * tx.b );
	col = lgtApplyAtmosphere( col, cameraPosition, vWorld, 1.0 );
	gl_FragColor = vec4( col * alpha, alpha );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 2x2 atlas of billowy puffs: RG = normal xy, B = thickness, A = density. */
function bakePuffAtlas(rnd) {
  const S = 256, W = S * 2;
  const data = new Uint8Array(W * W * 4);
  // value noise lattice
  const P = 64;
  const lat = new Float32Array(P * P);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const vn = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const i00 = lat[((yi % P + P) % P) * P + ((xi % P + P) % P)];
    const i10 = lat[((yi % P + P) % P) * P + (((xi + 1) % P + P) % P)];
    const i01 = lat[(((yi + 1) % P + P) % P) * P + ((xi % P + P) % P)];
    const i11 = lat[(((yi + 1) % P + P) % P) * P + (((xi + 1) % P + P) % P)];
    return (i00 * (1 - sx) + i10 * sx) * (1 - sy) + (i01 * (1 - sx) + i11 * sx) * sy;
  };
  const fbm = (x, y) => { let s = 0, a = 0.5; for (let o = 0; o < 5; o++) { s += a * vn(x, y); x = x * 2.03 + 7.1; y = y * 2.03 + 3.3; a *= 0.5; } return s; };
  const Hf = new Float32Array(S * S);
  for (let v = 0; v < 4; v++) {
    const ox = (v % 2) * S, oy = Math.floor(v / 2) * S;
    // cauliflower: overlapping sphere caps
    const blobs = [];
    const nb = 7 + Math.floor(rnd() * 4);
    for (let k = 0; k < nb; k++) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * 0.38;
      blobs.push([Math.cos(a) * d, Math.sin(a) * d * 0.9, 0.22 + rnd() * 0.24]);
    }
    blobs.push([0, 0, 0.5]);
    const nOff = rnd() * 40;
    let maxH = 0;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const px = (x + 0.5) / S * 2 - 1, py = (y + 0.5) / S * 2 - 1;
      let h = 0;
      for (const [cx, cy, r] of blobs) {
        const dx = px - cx, dy = py - cy;
        const q = r * r - dx * dx - dy * dy;
        if (q > 0) h = Math.max(h, Math.sqrt(q));
      }
      const n = fbm(px * 5 + nOff, py * 5 + nOff);
      const n2 = fbm(px * 14 + nOff * 2, py * 14 + 5);
      h = h + (n - 0.5) * 0.16 + (n2 - 0.5) * 0.05;
      h *= 1 - Math.max(0, Math.hypot(px, py) - 0.78) * 4; // keep inside the quad
      Hf[y * S + x] = Math.max(0, h);
      if (h > maxH) maxH = h;
    }
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const h = Hf[y * S + x];
      const hx = Hf[y * S + Math.min(S - 1, x + 1)] - Hf[y * S + Math.max(0, x - 1)];
      const hy = Hf[Math.min(S - 1, y + 1) * S + x] - Hf[Math.max(0, y - 1) * S + x];
      // height field normal (surface z = h), gradient in texels -> scale
      let nx = -hx * S * 0.12, ny = -hy * S * 0.12, nz = 1;
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l;
      const dens = Math.min(1, Math.max(0, (h - 0.01) / 0.32));
      const i = ((oy + y) * W + ox + x) * 4;
      data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round(Math.min(1, h / maxH) * 255);
      data[i + 3] = Math.round(dens * dens * (3 - 2 * dens) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, W, W, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.name = 'lighting.smokePuffs';
  tex.needsUpdate = true;
  return tex;
}

export function createSmokeColumns(ctx) {
  if (ctx.settings.get('lighting.smoke', true) === false) return null;
  const object = new THREE.Group();
  object.name = 'lighting.smoke';
  const rnd = mulberry32(0x5a0c3e);

  // az: deg (0 = -Z north, 90 = +X east). dist m. H: rise height before dissipating. r0/r1 base/top radius.
  // lean: downwind drift per metre of rise at the top. albedo: 0.05 oily black .. 0.14 grey-brown.
  const columns = [
    { az: 108, dist: 640, H: 260, r0: 9, r1: 46, lean: 1.3, albedo: 0.05, fire: 1.0, life: 100, n: 150 },
    { az: 352, dist: 470, H: 210, r0: 7, r1: 38, lean: 1.5, albedo: 0.08, fire: 0.6, life: 90, n: 130 },
    { az: 44, dist: 860, H: 300, r0: 12, r1: 55, lean: 1.2, albedo: 0.045, fire: 0.8, life: 115, n: 150 },
    { az: 255, dist: 560, H: 180, r0: 6, r1: 32, lean: 1.6, albedo: 0.1, fire: 0.4, life: 85, n: 110 },
    { az: 196, dist: 760, H: 230, r0: 8, r1: 42, lean: 1.3, albedo: 0.07, fire: 0.7, life: 100, n: 130 },
  ];
  let total = 0;
  for (const c of columns) total += c.n;
  const base = new Float32Array(total * 4), col = new Float32Array(total * 4), puff = new Float32Array(total * 4), misc = new Float32Array(total * 4);
  let k = 0;
  columns.forEach((c, ci) => {
    const a = (c.az * Math.PI) / 180;
    const x = Math.sin(a) * c.dist, z = -Math.cos(a) * c.dist;
    const seed = rnd();
    for (let i = 0; i < c.n; i++, k++) {
      base.set([x, -3, z, seed], k * 4);
      col.set([c.H, c.r0, c.r1, c.lean], k * 4);
      // stratified phases with jitter so the column is continuous
      puff.set([(i + rnd() * 0.8) / c.n, rnd(), rnd(), rnd()], k * 4);
      misc.set([c.life * (0.9 + rnd() * 0.2), c.albedo * (0.8 + rnd() * 0.4), c.fire, Math.floor(rnd() * 4)], k * 4);
    }
    void ci;
  });

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(base, 4));
  geo.setAttribute('aCol', new THREE.InstancedBufferAttribute(col, 4));
  geo.setAttribute('aPuff', new THREE.InstancedBufferAttribute(puff, 4));
  geo.setAttribute('aMisc', new THREE.InstancedBufferAttribute(misc, 4));
  geo.instanceCount = total;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3000);

  const tex = bakePuffAtlas(mulberry32(0x9e3779b9));
  const mat = new THREE.ShaderMaterial({
    name: 'lighting.smoke',
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      lgtAtmo: { value: atmoData },
      tMap: { value: tex },
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector3(0.86, 0, -0.5).normalize() },
      uSun: { value: new THREE.Color(1, 0.9, 0.7) },
      uSky: { value: new THREE.Color(0.3, 0.32, 0.36) },
      uBounce: { value: new THREE.Color(0.2, 0.18, 0.16) },
      uGlow: { value: new THREE.Color(3.0, 1.2, 0.3) },
      uOpacity: { value: 1.0 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'lighting.smokeColumns';
  mesh.frustumCulled = false;
  mesh.renderOrder = -10; // before other transparents (it is always far away)
  mesh.matrixAutoUpdate = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  object.add(mesh);

  return {
    object,
    applyPreset(p, { sunColor, sunE, skyE }) {
      const k = p.smoke ?? 1;
      mesh.visible = k > 0;
      mat.uniforms.uOpacity.value = Math.min(1, k);
      mat.uniforms.uSun.value.copy(sunColor).multiplyScalar(sunE / Math.PI);
      mat.uniforms.uSky.value.setRGB(0.45, 0.6, 0.95).multiplyScalar(skyE / Math.PI * 1.6);
      mat.uniforms.uBounce.value.setRGB(0.55, 0.47, 0.38).multiplyScalar((sunE * 0.3 + skyE) / Math.PI * 0.35);
      mat.uniforms.uGlow.value.setRGB(4.0, 1.3, 0.28).multiplyScalar(p.intensity * 3.0);
    },
    update(dt, t) { mat.uniforms.uTime.value = t; },
    dispose() { geo.dispose(); mat.dispose(); tex.dispose(); },
  };
}

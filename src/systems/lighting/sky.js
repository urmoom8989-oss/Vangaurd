import * as THREE from 'three';
import { ATMO_DECL, ATMO_FUNCS } from './atmosphere.glsl.js';
import { atmoData } from './chunks.js';

/**
 * Photographic sky (Poly Haven CC0 "puresky" HDRI baked by tools/lighting/bake-sky.mjs into an HDR-encoded
 * JPEG) rendered on a camera-centred dome at the far plane, with:
 *   - azimuth rotation so the photographed sun matches the SunLight direction,
 *   - a smooth elevation warp so the photographed sun can be raised/lowered to the preset elevation,
 *   - an analytic sun disc (limb darkened) + the shared height-haze / in-scattering (matches the fog on geometry),
 *   - an "env" variant used to build the PMREM environment: no sun disc (the SunLight is the sun), a lit ground
 *     hemisphere and an urban horizon (building facades occlude the low sky) -> cheap GI / bounce.
 */
const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
	vDir = position;
	vec4 p = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
	gl_Position = vec4( p.xy, p.w * 0.999995, p.w ); // at the far plane
}
`;

const FRAG = /* glsl */ `
${ATMO_DECL}
${ATMO_FUNCS}
uniform sampler2D skyTex;
uniform vec4 skyMap;      // x: u offset, y: warp A (rad), z: top elevation (rad), w: elevation range (rad)
uniform vec4 skyParams;   // x: radiance scale, y: sun disc radiance, z: env mode, w: sun angular radius (rad)
uniform vec3 sunColor;
uniform vec3 groundRadiance;
uniform vec3 facadeRadiance;
uniform vec4 envParams;   // x: facade occlusion top elevation (rad), y: occlusion strength, z: dither, w: saturation
uniform float envCap;     // env mode: soft luminance cap (the SunLight already carries the circumsolar energy)
uniform vec4 aureole;     // x: inner lobe radiance, y: outer lobe radiance, z: near-sun blur (mip scale), w: inner width (rad)
varying vec3 vDir;

float lgtIGN( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }

vec3 sampleSky( vec3 dir, float sunAng ) {
	float elev = asin( clamp( dir.y, -1.0, 1.0 ) );
	float te = elev - skyMap.y * sin( 2.0 * elev );
	float u = atan( dir.z, dir.x ) * 0.15915494309 + skyMap.x;
	float v = 1.0 - ( skyMap.z - te ) / skyMap.w;
	vec2 uv = vec2( u, v );
	vec2 dx = dFdx( uv ), dy = dFdy( uv );
	dx.x -= floor( dx.x + 0.5 );
	dy.x -= floor( dy.x + 0.5 );
	// the baked texture carries a knee-compressed (flat, JPEG-noisy) circumsolar core: sample it from a
	// much blurrier mip near the sun and let the analytic aureole restore the hot glow
	float nb = 1.0 + aureole.z * ( 1.0 - smoothstep( 0.02, 0.26, sunAng ) );
	dx *= nb; dy *= nb;
	vec3 y = textureGrad( skyTex, uv, dx, dy ).rgb;
	// dither before decoding hides 8-bit banding in smooth gradients
	y += ( lgtIGN( gl_FragCoord.xy ) - 0.5 ) * envParams.z * ( 1.0 / 255.0 );
	y = clamp( y, 0.0, 0.992 );
	vec3 L = y / ( 1.0 - y ) * skyParams.x;
	// art-directed saturation (the display transform downstream desaturates blues strongly)
	float l = dot( L, vec3( 0.2126, 0.7152, 0.0722 ) );
	return max( vec3( 0.0 ), mix( vec3( l ), L, envParams.w ) );
}

void main() {
	vec3 dir = normalize( vDir );
	vec3 sd = lgtAtmo[ 0 ].xyz;
	vec3 col;
	float envMode = skyParams.z;
	if ( envMode > 0.5 && dir.y < 0.0 ) {
		// ground hemisphere for the environment: lit ground seen from eye height, hazed toward the horizon
		float dist = min( 1.7 / max( -dir.y, 1e-3 ), 3000.0 );
		col = lgtApplyAtmosphere( groundRadiance, cameraPosition, cameraPosition + dir * dist, 1.0 );
	} else {
		float cosA = dot( dir, sd );
		col = sampleSky( dir, acos( clamp( cosA, -1.0, 1.0 ) ) );
		if ( envMode < 0.5 ) {
			// analytic sun disc with limb darkening
			float ang = acos( clamp( cosA, -1.0, 1.0 ) );
			float r = skyParams.w;
			float aa = max( fwidth( ang ), 1e-5 );
			float disc = 1.0 - smoothstep( r - aa, r + aa, ang );
			float mu = sqrt( max( 1.0 - ( ang * ang ) / ( r * r ), 0.0 ) );
			float limb = 0.4 + 0.6 * mu;
			col += sunColor * skyParams.y * disc * limb;
			// circumsolar aureole (forward Mie scattering aloft), two lobes
			col += sunColor * ( aureole.x * exp( -ang / aureole.w ) + aureole.y * exp( -ang / ( aureole.w * 5.0 ) ) );
		}
		vec3 T = exp( -lgtSkyOpticalDepth( cameraPosition, dir ) );
		vec3 lin = ( 1.0 - T ) * ( lgtAmbientScatter( dir ) + lgtAtmo[ 1 ].rgb * lgtPhase( cosA ) );
		col = col * T + lin;
		if ( envMode > 0.5 ) {
			// urban horizon: facades occlude the low sky around the player
			float e = asin( clamp( dir.y, 0.0, 1.0 ) );
			float occ = ( 1.0 - smoothstep( 0.0, envParams.x, e ) ) * envParams.y;
			col = mix( col, facadeRadiance, occ );
			// soft cap: the circumsolar sky + sun-side haze glow is otherwise double counted by the
			// directional light and paints a milky specular sheen over every surface facing the sun
			float el = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
			if ( envCap > 0.0 && el > envCap ) {
				float ex = el - envCap;
				col *= ( envCap + ex / ( 1.0 + ex / envCap ) ) / el;
			}
		}
	}
	gl_FragColor = vec4( col, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

export function createSkyMaterial({ env = false } = {}) {
  const mat = new THREE.ShaderMaterial({
    name: env ? 'lighting.skyEnv' : 'lighting.sky',
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      lgtAtmo: { value: atmoData },
      skyTex: { value: null },
      skyMap: { value: new THREE.Vector4(0, 0, Math.PI / 2, (96 * Math.PI) / 180) },
      skyParams: { value: new THREE.Vector4(1, 500, env ? 1 : 0, 0.0052) },
      sunColor: { value: new THREE.Color(1, 0.9, 0.7) },
      groundRadiance: { value: new THREE.Color(0.1, 0.09, 0.08) },
      facadeRadiance: { value: new THREE.Color(0.1, 0.1, 0.1) },
      envParams: { value: new THREE.Vector4(0.25, 0.6, env ? 0 : 1, 1) },
      envCap: { value: 0 },
      aureole: { value: new THREE.Vector4(0, 0, env ? 0 : 24, 0.03) },
    },
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: true,
  });
  return mat;
}

/** Camera-centred dome. Follows whichever camera renders it (player, PMREM cube camera, postfx passes). */
export function createSkyDome(material) {
  const geo = new THREE.SphereGeometry(1, 96, 48);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'lighting.skyDome';
  mesh.frustumCulled = false;
  mesh.renderOrder = 1e6; // after opaques: early-z rejects covered pixels
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.matrixWorldAutoUpdate = false;
  mesh.userData.isSky = true;
  mesh.onBeforeRender = (renderer, scene, camera) => {
    const e = mesh.matrixWorld.elements;
    const r = Math.max(10, (camera.near || 0.1) * 100);
    camera.getWorldPosition(_camPos);
    e[0] = r; e[1] = 0; e[2] = 0; e[3] = 0;
    e[4] = 0; e[5] = r; e[6] = 0; e[7] = 0;
    e[8] = 0; e[9] = 0; e[10] = r; e[11] = 0;
    e[12] = _camPos.x; e[13] = _camPos.y; e[14] = _camPos.z; e[15] = 1;
    mesh.modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
    mesh.normalMatrix.getNormalMatrix(mesh.modelViewMatrix);
  };
  return mesh;
}
const _camPos = new THREE.Vector3();

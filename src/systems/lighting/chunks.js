import * as THREE from 'three';
import { ATMO_DECL, ATMO_FUNCS, ATMO_SIZE } from './atmosphere.glsl.js';

/**
 * Global shader-chunk patches owned by the lighting system (it owns scene.fog and the shadow setup):
 *
 *  1. fog_*            -> physically based height fog + aerial perspective + sun in-scattering, optionally
 *                         shadowed by the sun cascades (volumetric light shafts) for opaque lit materials.
 *                         Falls back to three's classic linear fog for materials without the shared uniform.
 *  2. shadowmap_pars_fragment -> 4 sun cascades (three's SunLight ships 2) with a custom getSunShadow():
 *                         texel-aware normal offset + slope bias, world-space penumbra, rotated Vogel PCF,
 *                         cascade cross-fade.
 *
 * All parameters are shared through ONE uniform (`lgtAtmo`, a Float32Array) that is injected by reference
 * into every built-in ShaderLib entry and into UniformsLib.fog, so every material sees live values without
 * per-material setup, onBeforeCompile hooks or recompiles.
 */

export const SUN_CASCADES = 4;
export const SKYVIS_RES = 512;
export const atmoData = new Float32Array(ATMO_SIZE * 4);

let patched = false;
let cascadesPatched = false;

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorldPos;
#endif
`;

const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogWorldPos = ( ( vec4( mvPosition.xyz, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorldPos;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
	${ATMO_DECL}
	${ATMO_FUNCS}
#endif
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	if ( lgtAtmo[ 0 ].w > 0.5 ) {
		float lgtVis = 1.0;
		float lgtLit = 0.0;
		#if defined( LGT_SUN_VOLUMETRIC ) && defined( OPAQUE )
			lgtVis = lgtVolumetricSunVis( cameraPosition, vFogWorldPos, vFogDepth, lgtLit );
		#endif
		vec3 lgtT; vec3 lgtLin;
		#ifdef LGT_FOG_SCALE
			lgtAtmosphereTerms( cameraPosition, cameraPosition + ( vFogWorldPos - cameraPosition ) * LGT_FOG_SCALE, lgtVis, lgtT, lgtLin );
		#else
			lgtAtmosphereTerms( cameraPosition, vFogWorldPos, lgtVis, lgtT, lgtLin );
		#endif
		if ( lgtLit > 0.0 ) {
			// low-lying dust lit by the sun, shadowed by the cascades: visible light shafts in streets/alleys
			float lgtCos = dot( normalize( vFogWorldPos - cameraPosition ), lgtAtmo[ 0 ].xyz );
			float lgtG = lgtAtmo[ 23 ].x;
			float lgtHG = ( 1.0 - lgtG * lgtG ) / pow( max( 1.0 + lgtG * lgtG - 2.0 * lgtG * lgtCos, 1e-4 ), 1.5 );
			lgtLin += lgtAtmo[ 22 ].rgb * ( mix( 1.0, lgtHG, 0.85 ) * lgtLit * lgtAtmo[ 22 ].w );
		}
		#ifdef TONE_MAPPING
			// rendering straight to the canvas: fog is applied after in-material tone mapping, so tone map the fog colour too
			vec3 lgtOpacity = 1.0 - lgtT;
			vec3 lgtFogC = lgtLin / max( lgtOpacity, vec3( 1e-4 ) );
			lgtFogC = linearToOutputTexel( vec4( toneMapping( lgtFogC ), 1.0 ) ).rgb;
			gl_FragColor.rgb = mix( gl_FragColor.rgb, lgtFogC, lgtOpacity );
		#else
			gl_FragColor.rgb = gl_FragColor.rgb * lgtT + lgtLin;
		#endif
	} else {
		#ifdef FOG_EXP2
			float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
		#else
			float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
		#endif
		gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
	}
#endif
`;

// Replaces three's getSunShadow() (inside `#if NUM_SUN_LIGHT_SHADOWS > 0`).
const SUN_SHADOW_FUNCS = /* glsl */ `
	#if NUM_SUN_LIGHT_SHADOWS > 0

		${ATMO_DECL}

		#if defined( SHADOWMAP_TYPE_PCF )

		float lgtSunPCF( sampler2DShadow shadowMap, vec3 sc, float r ) {
			float phi = ( interleavedGradientNoise( gl_FragCoord.xy ) + lgtAtmo[ 7 ].z * 37.0820393 ) * PI2;
			float s = 0.0;
			for ( int k = 0; k < 10; k ++ ) {
				s += texture( shadowMap, vec3( sc.xy + vogelDiskSample( k, 10, phi ) * r, sc.z ) );
			}
			return s * 0.1;
		}

		#endif

		float getSunShadow(
			#if defined( SHADOWMAP_TYPE_PCF )
				sampler2DShadow shadowMap,
			#else
				sampler2D shadowMap,
			#endif
			SunLightShadow sunLightShadow,
			int shadowIndex
		) {

			vec3 N = vSunShadowWorldNormal;
			float nLen = length( N );
			N = nLen > 1e-5 ? N / nLen : vec3( 0.0 );
			float NdotL = dot( N, lgtAtmo[ 0 ].xyz );
			float slope = clamp( 1.0 - abs( NdotL ), 0.0, 1.0 );
			float viewDepth = vSunShadowWorldPosition.w;
			int cascadeOffset = shadowIndex * SUN_LIGHT_CASCADES;
			float shadow = 1.0;

			for ( int i = SUN_LIGHT_CASCADES - 1; i >= 0; i -- ) {

				vec4 cascade = sunShadowCascade[ cascadeOffset + i ];

				if ( viewDepth >= cascade.x && viewDepth < cascade.y ) {

					float texel = max( cascade.w, 1e-4 );
					vec3 wp = vSunShadowWorldPosition.xyz + N * texel * sunLightShadow.shadowNormalBias * ( 1.0 + 2.0 * slope );
					vec4 sc = sunShadowMatrix[ cascadeOffset + i ] * vec4( wp, 1.0 );
					sc.xyz /= sc.w;
					sc.z += sunLightShadow.shadowBias;

					float cs = 1.0;
					if ( sc.z <= 1.0 ) {
						#if defined( SHADOWMAP_TYPE_PCF )
							// shadowRadius = world-space penumbra in centimetres (clamped to the atlas inset)
							float radTexels = clamp( sunLightShadow.shadowRadius * 0.01 / texel, 0.75, 6.0 );
							cs = lgtSunPCF( shadowMap, sc.xyz, radTexels / sunLightShadow.shadowMapSize.x );
						#else
							cs = step( sc.z, texture2D( shadowMap, sc.xy ).r );
						#endif
					}
					cs = mix( 1.0, cs, sunLightShadow.shadowIntensity );
					shadow = mix( cs, shadow, smoothstep( cascade.z, cascade.y, viewDepth ) );

				}

			}

			return shadow;

		}

		#if defined( USE_FOG ) && defined( SHADOWMAP_TYPE_PCF )

		#define LGT_SUN_VOLUMETRIC 1

		// Average sun visibility along the camera ray (shadowed in-scattering = light shafts).
		float lgtVolumetricSunVis( vec3 camPos, vec3 wpos, float viewDepth, out float litLen ) {
			litLen = 0.0;
			float steps = lgtAtmo[ 6 ].x;
			if ( steps < 0.5 || lgtAtmo[ 6 ].z <= 0.0 ) return 1.0;
			float dustH = max( lgtAtmo[ 23 ].y, 0.1 );
			vec3 v = wpos - camPos;
			float dist = length( v );
			vec3 dir = v / max( dist, 1e-4 );
			float L = min( dist, lgtAtmo[ 6 ].y );
			// adaptive step count: short rays (most near-field pixels) need far fewer shadow taps
			steps = max( 3.0, ceil( steps * clamp( L / lgtAtmo[ 6 ].y, 0.3, 1.0 ) ) );
			float depthPerMeter = viewDepth / max( dist, 1e-4 );
			float jitter = fract( interleavedGradientNoise( gl_FragCoord.xy + 17.0 ) + lgtAtmo[ 7 ].z * 37.0820393 ); // golden-ratio per frame (TAA resolves it)
			float b = max( lgtAtmo[ 2 ].w, 1e-4 );
			float h0 = lgtAtmo[ 3 ].w;
			float acc = 0.0;
			float wsum = 0.0;
			float litRaw = 0.0;
			for ( int i = 0; i < 32; i ++ ) {
				if ( float( i ) >= steps ) break;
				float s = ( float( i ) + jitter ) / steps;
				float t = s * s * L;
				vec3 p = camPos + dir * t;
				float d = t * depthPerMeter;
				int c = SUN_LIGHT_CASCADES - 1;
				for ( int j = SUN_LIGHT_CASCADES - 1; j >= 0; j -- ) {
					if ( d < sunShadowCascade[ j ].y ) c = j;
				}
				vec4 sc = sunShadowMatrix[ c ] * vec4( p, 1.0 );
				float vis = texture( sunShadowMap[ 0 ], vec3( sc.xy, sc.z - 0.0005 ) );
				float w = s * exp( clamp( -b * ( p.y - h0 ), -20.0, 20.0 ) * lgtAtmo[ 6 ].w );
				acc += vis * w;
				wsum += w;
				// dust: dt = d(s^2 L) = 2 s L / steps, density falls off with height above the base
				litLen += vis * ( 2.0 * s * L / steps ) * exp( -max( p.y - h0, 0.0 ) / dustH );
				litRaw += vis * s;
			}
			// shaft mask: rays that cross BOTH shadow and sunlight (shafts through gaps, windows, holes) get the
			// art-directed dust gain; fully lit open-air rays keep the plain (weak) dust so plazas are not veiled
			float litFrac = litRaw / max( 0.5 * steps, 1e-4 );
			float shaftMask = smoothstep( 0.02, 0.2, litFrac ) * ( 1.0 - smoothstep( 0.45, 0.95, litFrac ) );
			litLen *= lgtAtmo[ 6 ].z * ( 1.0 + lgtAtmo[ 23 ].w * shaftMask );
			float avgVis = acc / max( wsum, 1e-5 );
			// portion of the path that was not marched is treated as lit
			float marched = L / max( dist, 1e-4 );
			float vis = mix( 1.0, avgVis, marched );
			return mix( 1.0, vis, lgtAtmo[ 6 ].z );
		}

		#endif

	#endif
`;

function patchShadowChunk() {
  let src = THREE.ShaderChunk.shadowmap_pars_fragment;
  if (!src.includes('#define SUN_LIGHT_CASCADES 2')) return false;
  const fnStart = src.indexOf('float getSunShadow(');
  if (fnStart < 0) return false;
  const blockStart = src.lastIndexOf('#if NUM_SUN_LIGHT_SHADOWS > 0', fnStart);
  const blockEnd = src.indexOf('#if NUM_POINT_LIGHT_SHADOWS > 0', fnStart);
  if (blockStart < 0 || blockEnd < 0) return false;
  // the block's own #endif is the last one before blockEnd
  const endifIdx = src.lastIndexOf('#endif', blockEnd);
  if (endifIdx < fnStart) return false;
  src = src.slice(0, blockStart) + SUN_SHADOW_FUNCS + '\n\t' + src.slice(endifIdx + '#endif'.length);
  src = src.replace('#define SUN_LIGHT_CASCADES 2', `#define SUN_LIGHT_CASCADES ${SUN_CASCADES}`);
  THREE.ShaderChunk.shadowmap_pars_fragment = src;
  return true;
}

const ATMO_TERMS = /* glsl */ `
void lgtAtmosphereTerms( vec3 camPos, vec3 wpos, float sunVis, out vec3 T, out vec3 lin ) {
	vec3 v = wpos - camPos;
	float dist = length( v );
	vec3 dir = v / max( dist, 1e-4 );
	T = exp( -lgtOpticalDepthFrom( camPos, dir, dist ) );
	T = max( T, vec3( 1.0 - lgtAtmo[ 5 ].w ) );
	float cosT = dot( dir, lgtAtmo[ 0 ].xyz );
	lin = ( 1.0 - T ) * ( lgtAmbientScatter( dir ) * mix( 1.0 - lgtAtmo[ 5 ].z, 1.0, sunVis ) + lgtAtmo[ 1 ].rgb * ( lgtPhase( cosT ) * sunVis ) );
}
`;

// Sky visibility ("cheap GI"): a top-down height field of the level (see skyvis.js) occludes the sky light
// (IBL diffuse + specular) under roofs/overhangs and in deep streets/alleys.
const SKYVIS_PARS = /* glsl */ `
#ifndef LGT_SKYVIS
#define LGT_SKYVIS 1
${ATMO_DECL}
uniform sampler2D lgtSkyVisMap;
float lgtSkyVisibility( vec3 viewPos, vec3 viewNormal ) {
	vec4 m = lgtAtmo[ 20 ];
	if ( m.w <= 0.0 ) return 1.0;
	vec3 wp = ( ( vec4( viewPos, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
	vec3 wn = ( vec4( viewNormal, 0.0 ) * viewMatrix ).xyz;
	vec2 uv = ( wp.xz + wn.xz * 0.9 - m.xy ) * m.z;
	if ( uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 ) return 1.0;
	vec4 h = texture2D( lgtSkyVisMap, uv );
	float y = wp.y + 0.05;
	float covered = smoothstep( 0.35, 1.6, h.r - y );
	float t = max( max( h.g - y, 0.0 ) * lgtAtmo[ 21 ].x, max( h.b - y, 0.0 ) * lgtAtmo[ 21 ].y );
	float v = ( 1.0 / ( 1.0 + t * t ) ) * ( 1.0 - covered * lgtAtmo[ 21 ].z );
	return mix( 1.0, v, m.w );
}
#endif
`;

const SKYVIS_APPLY = /* glsl */ `
#if defined( LGT_SKYVIS )
	{
		float lgtSV = lgtSkyVisibility( - vViewPosition, geometryNormal );
		#if defined( RE_IndirectDiffuse )
			// cheap bounce GI: covered spaces keep a warm fraction of the sky irradiance (sunlit ground/walls bouncing in)
			iblIrradiance *= lgtSV + ( 1.0 - lgtSV ) * lgtAtmo[ 24 ].rgb;
		#endif
		#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
			radiance *= mix( 1.0, lgtSV, lgtAtmo[ 21 ].w );
		#endif
	}
#endif
`;

export const skyVisTexture = (() => {
  const t = new THREE.DataTexture(new Uint16Array(SKYVIS_RES * SKYVIS_RES * 4), SKYVIS_RES, SKYVIS_RES, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.name = 'lighting.skyVisibility';
  t.needsUpdate = true;
  return t;
})();

/** Install the global chunk patches + shared uniform. Idempotent. Returns {cascades}. */
export function installChunks() {
  if (patched) return { cascades: cascadesPatched ? SUN_CASCADES : 2 };
  patched = true;
  THREE.ShaderChunk.fog_pars_vertex = FOG_PARS_VERTEX;
  THREE.ShaderChunk.fog_vertex = FOG_VERTEX;
  THREE.ShaderChunk.fog_pars_fragment = FOG_PARS_FRAGMENT.replace(ATMO_FUNCS, ATMO_FUNCS + ATMO_TERMS);
  THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT;
  cascadesPatched = patchShadowChunk();
  if (!cascadesPatched) console.warn('[system:lighting] could not patch sun cascade chunk; using 2 cascades');

  THREE.ShaderChunk.lights_pars_begin = THREE.ShaderChunk.lights_pars_begin + SKYVIS_PARS;
  THREE.ShaderChunk.lights_fragment_maps = THREE.ShaderChunk.lights_fragment_maps + SKYVIS_APPLY;

  const uni = () => ({ value: atmoData });
  for (const key of Object.keys(THREE.ShaderLib)) {
    const u = THREE.ShaderLib[key].uniforms;
    if (u && ('fogColor' in u || 'ambientLightColor' in u)) u.lgtAtmo = uni();
    if (u && 'ambientLightColor' in u) u.lgtSkyVisMap = { value: skyVisTexture };
  }
  THREE.UniformsLib.lights.lgtSkyVisMap = { value: skyVisTexture };
  THREE.UniformsLib.fog.lgtAtmo = uni();
  THREE.UniformsLib.lights.lgtAtmo = uni();
  return { cascades: cascadesPatched ? SUN_CASCADES : 2 };
}

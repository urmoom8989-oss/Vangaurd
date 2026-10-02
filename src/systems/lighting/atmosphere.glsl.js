/**
 * Shared atmosphere GLSL (height fog + aerial perspective + sun in-scattering).
 *
 * All parameters live in ONE shared uniform array `lgtAtmo[20]` (a Float32Array owned by the lighting
 * system and shared by reference with every built-in material, see chunks.js). Layout:
 *   [0]  sunDir.xyz (unit, towards the sun, world)            , enabled (1 = lighting atmosphere active)
 *   [1]  sunScatter.rgb (forward-scatter sun radiance)        , mie g
 *   [2]  ambient tint.rgb (multiplies the horizon colour)     , height falloff b (1/m)
 *   [3]  hazeExt.rgb (height-fog extinction /m at base)        , base height h0 (m)
 *   [4]  airExt.rgb (uniform extinction /m, aerial persp.)     , mie weight (0..1)
 *   [5]  x: sky haze scale, y: sky haze horizon softness, z: sun fraction of the haze brightness (shadowable), w: max haze opacity
 *   [6]  volumetric: steps, maxDist (m), strength, density boost near ground
 *   [7]  sky: radiance scale, sun disc radiance, time (s), sky u offset
 *   [8..19] horizon radiance.rgb for 12 azimuth sectors (texture-u space) = fog in-scatter asymptote
 *   [20] sky-visibility map: origin x, origin z, 1/size, strength (0 = off)
 *   [21] sky-visibility: 1/r1, 1/r2, roof occlusion, specular occlusion
 *   [22] dust: sun radiance.rgb * scale (lit dust in-scatter colour), density /m
 *   [23] dust: HG g, height scale (m), haze start distance (m, keeps the near field crisp), shaft gain (dust boost on partly shadowed rays)
 *   [24] bounce fill.rgb: fraction of the open-sky irradiance kept under cover (cheap interior GI), -
 * When enabled == 0 (a custom ShaderMaterial without the shared uniform) the chunks fall back to
 * three's classic linear fog.
 */
export const ATMO_SIZE = 25;

export const ATMO_DECL = /* glsl */ `
#ifndef LGT_ATMO_DECL
#define LGT_ATMO_DECL
uniform vec4 lgtAtmo[ 25 ];
#endif
`;

export const ATMO_FUNCS = /* glsl */ `
#ifndef LGT_ATMO_FUNCS
#define LGT_ATMO_FUNCS

float lgtHeightIntegral( vec3 camPos, vec3 dir, float dist ) {
	float b = max( lgtAtmo[ 2 ].w, 1e-4 );
	float h = camPos.y - lgtAtmo[ 3 ].w;
	float k = max( b * dir.y * dist, -30.0 );
	float f = abs( k ) > 1e-3 ? ( 1.0 - exp( -k ) ) / k : 1.0 - 0.5 * k;
	return exp( clamp( -b * h, -30.0, 30.0 ) ) * dist * f;
}

// optical depth (per channel) along camPos + dir * [0, dist]
vec3 lgtOpticalDepth( vec3 camPos, vec3 dir, float dist ) {
	return lgtAtmo[ 3 ].rgb * lgtHeightIntegral( camPos, dir, dist ) + lgtAtmo[ 4 ].rgb * dist;
}

// optical depth from the haze start distance on (UE-style "fog start"): the first metres stay crisp so shadowed
// near-field surfaces are not veiled by the (bright) horizon in-scatter, while the far field keeps its depth
vec3 lgtOpticalDepthFrom( vec3 camPos, vec3 dir, float dist ) {
	float s0 = min( lgtAtmo[ 23 ].z, dist );
	return lgtOpticalDepth( camPos + dir * s0, dir, dist - s0 );
}

// haze over the photographed sky: only the low band blends into the fog colour
vec3 lgtSkyOpticalDepth( vec3 camPos, vec3 dir ) {
	float s = max( dir.y, 0.0 ) * lgtAtmo[ 5 ].y + 0.004;
	float od = lgtAtmo[ 5 ].x * 0.08 / s;
	return vec3( od );
}

// phase function normalised so that an isotropic phase == 1
float lgtPhase( float cosT ) {
	float g = lgtAtmo[ 1 ].w;
	float g2 = g * g;
	float hg = ( 1.0 - g2 ) / pow( max( 1.0 + g2 - 2.0 * g * cosT, 1e-4 ), 1.5 );
	// mie lobe blended with an isotropic (multiple-scattering) floor
	return mix( 1.0, hg, lgtAtmo[ 4 ].w );
}

// fog asymptote: photographed horizon colour at the view azimuth (12 sectors, smooth interpolation)
vec3 lgtAmbientScatter( vec3 dir ) {
	float u = atan( dir.z, dir.x ) * 0.15915494309 + lgtAtmo[ 7 ].w;
	float x = fract( u ) * 12.0 - 0.5;
	float i0 = floor( x );
	float t = x - i0;
	t = t * t * ( 3.0 - 2.0 * t );
	int a = int( mod( i0, 12.0 ) );
	int b = int( mod( i0 + 1.0, 12.0 ) );
	vec3 c = mix( lgtAtmo[ 8 + a ].rgb, lgtAtmo[ 8 + b ].rgb, t );
	return c * lgtAtmo[ 2 ].rgb;
}

// col = col * T + Lin.  sunVis in [0,1] scales the sun forward-scatter (volumetric shadowing)
vec3 lgtApplyAtmosphere( vec3 col, vec3 camPos, vec3 wpos, float sunVis ) {
	vec3 v = wpos - camPos;
	float dist = length( v );
	vec3 dir = v / max( dist, 1e-4 );
	vec3 T = exp( -lgtOpticalDepthFrom( camPos, dir, dist ) );
	T = max( T, vec3( 1.0 - lgtAtmo[ 5 ].w ) );
	float cosT = dot( dir, lgtAtmo[ 0 ].xyz );
	vec3 lin = ( 1.0 - T ) * ( lgtAmbientScatter( dir ) * mix( 1.0 - lgtAtmo[ 5 ].z, 1.0, sunVis ) + lgtAtmo[ 1 ].rgb * ( lgtPhase( cosT ) * sunVis ) );
	return col * T + lin;
}

#endif
`;

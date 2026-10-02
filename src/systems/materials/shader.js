import * as THREE from 'three';

/**
 * "OM" surface shader — injected into three's MeshStandardMaterial / MeshPhysicalMaterial through
 * onBeforeCompile, so every material keeps three's lighting, shadows, fog, env and tone mapping and
 * only the surface inputs (albedo / normal / roughness / metalness / AO) are replaced.
 *
 * Feature defines (set per material, part of the program cache key; identical feature sets share
 * one program):
 *   OM_MAPS        baked albedo(BC1) / normal(BC5) / mask(BC3: metal, rough, ao, height) set
 *   OM_ANTITILE    stochastic 2-sample tiling (height-blended) to hide repetition
 *   OM_TRI_WORLD   world-space triplanar (for meshes with bad / no UVs: rubble, terrain, imported)
 *   OM_TRI_OBJECT  object-space triplanar (moving props, weapons: detail sticks to the object)
 *   OM_DETAIL      micro detail normal (shared procedural sets), fades with distance
 *   OM_GRIME       world-space weathering: dust on up-facing, dirt at wall bases, rain streaks, blotches
 *   OM_WEAR        edge wear from screen-space curvature (+ optional `wear` vertex attribute)
 *   OM_BURN        soot / char conversion
 *   OM_CAMO        procedural 4-colour disruptive pattern
 *   OM_HESCO       galvanised weld-mesh grid over the fabric
 *   OM_GLASS       dirty glass: premultiplied output, reflections kept at full strength
 *   OM_DECAL       worn paint decal (alpha from wear), e.g. road markings
 *   OM_PAINT       set has a paint mask in albedo alpha: paint colour is re-targeted (omPaint / material.color)
 */

// --------------------------------------------------------------------------------- shared globals
export const GLOBAL_UNIFORMS = {
  omNoise: { value: null },
  omDetailMicro: { value: null },
  // x groundY, y wetness 0..1, z dust multiplier, w grime multiplier
  omGlobal: { value: new THREE.Vector4(0, 0, 1, 1) },
  omDustColor: { value: new THREE.Color(0.36, 0.32, 0.27) },
  // debug view: 0 off, 1 albedo, 2 roughness, 3 metal, 4 ao, 5 height, 6 base dirt, 7 dust, 8 streaks, 9 world normal
  omDebug: { value: 0 },
  omDirtColor: { value: new THREE.Color(0.085, 0.068, 0.05) },
};

export function createMaterialUniforms() {
  return {
    omA: { value: null },
    omN: { value: null },
    omM: { value: null },
    omD: { value: null },
    omTint: { value: new THREE.Color(1, 1, 1) },
    // x,y: uv scale (1 / tile size in m), z: normal strength, w: ao strength
    omP0: { value: new THREE.Vector4(1, 1, 1, 1) },
    // rough mul, rough add, metal mul, metal add
    omP1: { value: new THREE.Vector4(1, 0, 1, 0) },
    // anti-tile strength, porosity, repair-patch amount, base-dirt height (m)
    omP2: { value: new THREE.Vector4(1, 0.5, 0, 0.7) },
    // albedo amp, rough amp, freq (1/m), hue amp
    omMacro: { value: new THREE.Vector4(0.1, 0.06, 0.15, 0.3) },
    // detail: repeats / m, strength, fade distance (m), rough jitter
    omDetail: { value: new THREE.Vector4(4, 0.3, 10, 0) },
    // dust, base dirt, streaks, blotches
    omGrime: { value: new THREE.Vector4(0.5, 0.5, 0.5, 0.5) },
    // amount, curvature lo, curvature hi (1/m), worn roughness
    omWear: { value: new THREE.Vector4(0, 120, 700, 0.3) },
    omWearColor: { value: new THREE.Color(0.5, 0.5, 0.5) },
    // amount, scale, (unused), (unused)
    omBurn: { value: new THREE.Vector4(0, 1, 0, 0) },
    omCamo0: { value: new THREE.Color() },
    omCamo1: { value: new THREE.Color() },
    omCamo2: { value: new THREE.Color() },
    omCamo3: { value: new THREE.Color() },
    // glass: base transmittance, smudge amount, dirt amount, (unused)
    omGlass: { value: new THREE.Vector4(0.85, 0.5, 0.35, 0) },
    // paint sets: linear paint colour multiplier (target / baked paint luminance), neutral paint luminance for tints
    omPaint: { value: new THREE.Color(1, 1, 1) },
    omPaintN: { value: 0.4 },
    // second blended set (OM_LAYER): textures, (uv scale x, y, amount 0..1, mask freq 1/m),
    // (edge sharpness, height influence, normal strength, macro-dark amount), albedo ratio vs the base tint
    omA2: { value: null },
    omN2: { value: null },
    omM2: { value: null },
    omL0: { value: new THREE.Vector4(1, 1, 0.3, 0.15) },
    omL1: { value: new THREE.Vector4(6, 1.5, 1, 0) },
    omLTint: { value: new THREE.Color(1, 1, 1) },
  };
}

// --------------------------------------------------------------------------------- GLSL
const VERT_PARS = /* glsl */`
varying vec3 vOmWPos;
#ifdef OM_TRI_OBJECT
varying vec3 vOmOPos;
varying vec3 vOmONrm;
varying vec3 vOmAxX;
varying vec3 vOmAxY;
varying vec3 vOmAxZ;
#endif
#ifdef OM_WEAR
attribute float wear;
varying float vOmWearAttr;
#endif
`;

const VERT_MAIN = /* glsl */`
{
  vec4 omW = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    omW = batchingMatrix * omW;
  #endif
  #ifdef USE_INSTANCING
    omW = instanceMatrix * omW;
  #endif
  omW = modelMatrix * omW;
  vOmWPos = omW.xyz;
  #ifdef OM_TRI_OBJECT
    vOmOPos = position;
    vOmONrm = normal;
    mat3 omIM = mat3( 1.0 );
    #ifdef USE_BATCHING
      omIM = mat3( batchingMatrix );
    #endif
    #ifdef USE_INSTANCING
      omIM = mat3( instanceMatrix ) * omIM;
    #endif
    vOmAxX = normalMatrix * ( omIM * vec3( 1.0, 0.0, 0.0 ) );
    vOmAxY = normalMatrix * ( omIM * vec3( 0.0, 1.0, 0.0 ) );
    vOmAxZ = normalMatrix * ( omIM * vec3( 0.0, 0.0, 1.0 ) );
  #endif
  #ifdef OM_WEAR
    vOmWearAttr = wear;
  #endif
}
`;

const FRAG_PARS = /* glsl */`
#if defined( OM_LITE_AT )
  #undef OM_ANTITILE
#endif
#if defined( OM_LITE_DET )
  #undef OM_DETAIL
#endif
#if defined( OM_LITE_GRIME )
  #undef OM_GRIME
#endif
uniform sampler2D omNoise;
uniform vec4 omGlobal;
uniform float omDebug;
uniform vec3 omDustColor;
uniform vec3 omDirtColor;
uniform vec3 omTint;
uniform vec4 omP0;
uniform vec4 omP1;
uniform vec4 omP2;
uniform vec4 omMacro;
uniform vec4 omGrime;
varying vec3 vOmWPos;
#ifdef OM_MAPS
uniform sampler2D omA;
uniform sampler2D omN;
uniform sampler2D omM;
#endif
#ifdef OM_LAYER
uniform sampler2D omA2;
uniform sampler2D omN2;
uniform sampler2D omM2;
uniform vec4 omL0;
uniform vec4 omL1;
uniform vec3 omLTint;
#endif
#ifdef OM_PAINT
uniform vec3 omPaint;
uniform float omPaintN;
#endif
#ifdef OM_DETAIL
uniform sampler2D omD;
uniform vec4 omDetail;
#endif
#ifdef OM_WEAR
uniform vec4 omWear;
uniform vec3 omWearColor;
varying float vOmWearAttr;
#endif
#ifdef OM_BURN
uniform vec4 omBurn;
#endif
#ifdef OM_CAMO
uniform vec3 omCamo0;
uniform vec3 omCamo1;
uniform vec3 omCamo2;
uniform vec3 omCamo3;
#endif
#if defined( OM_GLASS )
uniform vec4 omGlass;
#endif
#ifdef OM_TRI_OBJECT
varying vec3 vOmOPos;
varying vec3 vOmONrm;
varying vec3 vOmAxX;
varying vec3 vOmAxY;
varying vec3 vOmAxZ;
#endif

float omSat( float x ) { return clamp( x, 0.0, 1.0 ); }

vec3 omUnpackN( vec2 rg ) {
  vec2 xy = rg * 2.0 - 1.0;
  return vec3( xy, sqrt( omSat( 1.0 - dot( xy, xy ) ) ) );
}

mat3 omTangentFrame( vec3 eye_pos, vec3 surf_norm, vec2 uv ) {
  vec3 q0 = dFdx( eye_pos.xyz );
  vec3 q1 = dFdy( eye_pos.xyz );
  vec2 st0 = dFdx( uv.st );
  vec2 st1 = dFdy( uv.st );
  vec3 N = surf_norm;
  vec3 q1perp = cross( q1, N );
  vec3 q0perp = cross( N, q0 );
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max( dot( T, T ), dot( B, B ) );
  float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
  return mat3( T * scale, B * scale, N );
}

// Whiteout-blended triplanar normal (Golus). p/n in the same space; returns a normal in that space.
vec3 omTriNormal( sampler2D t, vec3 p, vec3 n, vec3 bw, float s, float strength ) {
  vec3 sg = sign( n + 1e-6 );
  vec2 uvX = p.zy * s; vec2 uvY = p.xz * s; vec2 uvZ = p.xy * s;
  uvX.x *= sg.x; uvY.x *= sg.y; uvZ.x *= -sg.z;
  vec3 tX = omUnpackN( texture2D( t, uvX ).rg );
  vec3 tY = omUnpackN( texture2D( t, uvY ).rg );
  vec3 tZ = omUnpackN( texture2D( t, uvZ ).rg );
  tX.xy *= strength; tY.xy *= strength; tZ.xy *= strength;
  tX.x *= sg.x; tY.x *= sg.y; tZ.x *= -sg.z;
  tX = vec3( tX.xy + n.zy, abs( tX.z ) * n.x );
  tY = vec3( tY.xy + n.xz, abs( tY.z ) * n.y );
  tZ = vec3( tZ.xy + n.xy, abs( tZ.z ) * n.z );
  return normalize( tX.zyx * bw.x + tY.xzy * bw.y + tZ.xyz * bw.z );
}

vec4 omTriSample( sampler2D t, vec3 p, vec3 n, vec3 bw, float s ) {
  vec3 sg = sign( n + 1e-6 );
  vec2 uvX = p.zy * s; vec2 uvY = p.xz * s; vec2 uvZ = p.xy * s;
  uvX.x *= sg.x; uvY.x *= sg.y; uvZ.x *= -sg.z;
  return texture2D( t, uvX ) * bw.x + texture2D( t, uvY ) * bw.y + texture2D( t, uvZ ) * bw.z;
}
`;

/** Surface evaluation, replaces <map_fragment>. Produces omAlb, omRough, omMetal, omAO, omNv (view). */
const FRAG_SURFACE = /* glsl */`
  float omFace = gl_FrontFacing ? 1.0 : -1.0;
  vec3 omGN = normalize( vNormal );
  #ifdef DOUBLE_SIDED
    omGN *= omFace;
  #endif
  vec3 omGNw = normalize( ( vec4( omGN, 0.0 ) * viewMatrix ).xyz );
  vec3 omP = vOmWPos;
  float omDist = length( vViewPosition );

  vec3 omAlb = omTint;
  float omRough = omP1.y;
  float omMetal = omP1.w;
  float omAO = 1.0;
  float omH = 0.5;
  vec3 omNv = omGN;
  vec4 omDbg = vec4( 0.0 ); // x base dirt, y dust, z streak

  // dominant-axis world projection for macro / grime noise lookups
  vec3 omAbsN = abs( omGNw );
  vec2 omWUV = omAbsN.y > 0.6 ? omP.xz : ( omAbsN.x > omAbsN.z ? omP.zy : omP.xy );
  vec4 omNzM = texture2D( omNoise, omWUV * omMacro.z );
  vec4 omNzF = texture2D( omNoise, omWUV * omMacro.z * 4.37 + 0.31 );

  #if defined( OM_TRI_WORLD ) || defined( OM_TRI_OBJECT )
    #ifdef OM_TRI_OBJECT
      vec3 omTP = vOmOPos;
      vec3 omTN = normalize( vOmONrm );
    #else
      vec3 omTP = omP;
      vec3 omTN = omGNw;
    #endif
    vec3 omBW = pow( abs( omTN ), vec3( 4.0 ) );
    omBW /= ( omBW.x + omBW.y + omBW.z );
    vec3 omNt = omTN; // perturbed normal in triplanar space
    #ifdef OM_MAPS
      vec4 omMs = omTriSample( omM, omTP, omTN, omBW, omP0.x );
      vec4 omAs = omTriSample( omA, omTP, omTN, omBW, omP0.x );
      omNt = omTriNormal( omN, omTP, omTN, omBW, omP0.x, omP0.z );
    #endif
    #ifdef OM_DETAIL
      float omDFade = 1.0 - smoothstep( omDetail.z * 0.4, omDetail.z, omDist );
      if ( omDFade > 0.0 ) {
        vec3 omDn = omTriNormal( omD, omTP, omNt, omBW, omDetail.x, omDetail.y * omDFade );
        omNt = omDn;
      }
    #endif
    #ifdef OM_TRI_OBJECT
      omNv = normalize( vOmAxX * omNt.x + vOmAxY * omNt.y + vOmAxZ * omNt.z );
    #else
      omNv = normalize( ( viewMatrix * vec4( omNt, 0.0 ) ).xyz );
    #endif
    #ifdef DOUBLE_SIDED
      omNv *= omFace;
    #endif
  #else
    // ---------------------------------------------------------------- UV path (UVs in meters)
    vec2 omUV = vUv * omP0.xy;
    mat3 omTBN = omTangentFrame( - vViewPosition, omGN, omUV );
    #ifdef DOUBLE_SIDED
      omTBN[0] *= omFace;
      omTBN[1] *= omFace;
    #endif
    vec3 omTn = vec3( 0.0, 0.0, 1.0 );
    #ifdef OM_MAPS
      #ifdef OM_ANTITILE
        vec2 omDX = dFdx( omUV ), omDY = dFdy( omUV );
        float omK = texture2D( omNoise, omUV * 0.093 ).r;
        float omL = omK * 7.0;
        float omI = floor( omL );
        float omF = fract( omL );
        vec2 omOffA = sin( vec2( 3.0, 7.0 ) * omI ) * 0.5 + 0.5;
        vec2 omOffB = sin( vec2( 3.0, 7.0 ) * ( omI + 1.0 ) ) * 0.5 + 0.5;
        vec4 omMa = textureGrad( omM, omUV + omOffA, omDX, omDY );
        vec4 omMb = textureGrad( omM, omUV + omOffB, omDX, omDY );
        // v2: broader, gentler height blend. The old steep one cut jagged "mountain range" silhouettes
        // wherever the two offsets sampled texture regions of different tone (painted plaster).
        float omBl = omSat( ( omF - 0.5 ) * 2.0 + ( omMb.a - omMa.a ) * 0.8 + 0.5 );
        omBl = omBl * omBl * ( 3.0 - 2.0 * omBl );
        omBl = mix( step( 0.5, omF ), omBl, omP2.x );
        vec4 omMs = mix( omMa, omMb, omBl );
        vec4 omAs = mix( textureGrad( omA, omUV + omOffA, omDX, omDY ), textureGrad( omA, omUV + omOffB, omDX, omDY ), omBl );
        vec2 omNr = mix( textureGrad( omN, omUV + omOffA, omDX, omDY ).rg, textureGrad( omN, omUV + omOffB, omDX, omDY ).rg, omBl );
      #else
        vec4 omMs = texture2D( omM, omUV );
        vec4 omAs = texture2D( omA, omUV );
        vec2 omNr = texture2D( omN, omUV ).rg;
      #endif
      omTn = omUnpackN( omNr );
      omTn.xy *= omP0.z;
      #ifdef OM_LAYER
      {
        // second material in world-space noise patches, height-blended (gravel settles in dirt hollows,
        // dirt fills between stones). Rotated UVs so the two tilings never align.
        vec2 uv2 = mat2( 0.8, -0.6, 0.6, 0.8 ) * ( vUv * omL0.xy ) + 0.37;
        vec4 a2 = texture2D( omA2, uv2 );
        vec4 m2 = texture2D( omM2, uv2 );
        vec3 n2 = omUnpackN( texture2D( omN2, uv2 ).rg );
        n2.xy *= omL1.z;
        float lm = texture2D( omNoise, omWUV * omL0.w + 0.17 ).r * 0.7 + texture2D( omNoise, omWUV * omL0.w * 3.3 + 0.61 ).g * 0.45 - 0.15;
        float lb = omSat( ( lm - ( 1.0 - omL0.z ) ) * omL1.x + ( m2.a - omMs.a ) * omL1.y + 0.5 );
        lb = smoothstep( 0.0, 1.0, lb );
        omAs = mix( omAs, vec4( a2.rgb * omLTint, a2.a ), lb );
        omMs = mix( omMs, m2, lb );
        omTn = normalize( mix( omTn, n2, lb ) );
        // compacted / damp dark patches (tracks, spills) independent of the layer
        float dk = smoothstep( 0.55, 0.85, texture2D( omNoise, omWUV * omL0.w * 1.9 + 0.43 ).b ) * omL1.w;
        omAs.rgb *= 1.0 - 0.35 * dk;
        omMs.g = mix( omMs.g, omMs.g * 0.8, dk );
      }
      #endif
    #endif
    #ifdef OM_DETAIL
      float omDFade = 1.0 - smoothstep( omDetail.z * 0.4, omDetail.z, omDist );
      if ( omDFade > 0.0 ) {
        vec3 omDn = omUnpackN( texture2D( omD, vUv * omDetail.x ).rg );
        omTn = vec3( omTn.xy + omDn.xy * omDetail.y * omDFade, omTn.z * omDn.z );
      }
    #endif
    omNv = normalize( omTBN * normalize( omTn ) );
  #endif

  #ifdef OM_MAPS
    #ifdef OM_PAINT
      // paint mask in albedo alpha: recolour only the paint. A non-white material.color (world tints,
      // e.g. 'metal_painted#yellow') becomes the paint colour over a light neutral base.
      float omCustom = step( 0.004, 3.0 - ( diffuse.r + diffuse.g + diffuse.b ) );
      vec3 omPC = mix( omPaint, diffuse * omPaintN, omCustom );
      // aged paint: sun-chalked / washed-out patches (desaturated, lighter) and patchy darker repaint,
      // in world space so neighbouring walls and tiles never match. Scaled by the macro hue amount.
      {
        float omPF = smoothstep( 0.38, 0.78, omNzM.g * 0.65 + omNzF.b * 0.45 );
        float omPR = smoothstep( 0.62, 0.8, omNzM.a * 0.6 + omNzF.r * 0.5 );
        float omPL = dot( omPC, vec3( 0.299, 0.587, 0.114 ) );
        float omPA = omMacro.w * 1.6;
        omPC = mix( omPC, vec3( omPL ) * vec3( 1.2, 1.17, 1.1 ), omSat( omPF * 0.55 * omPA ) );
        omPC *= 1.0 - 0.14 * omPR * omPA;
      }
      omAlb = omAs.rgb * mix( omTint, omPC, omAs.a );
    #else
      omAlb = omAs.rgb * omTint;
    #endif
    omMetal = omMs.r * omP1.z + omP1.w;
    omRough = omMs.g * omP1.x + omP1.y;
    omAO = mix( 1.0, omMs.b, omP0.w );
    omH = omMs.a;
  #endif

  // ---------------------------------------------------------------- macro variation (breaks tiling)
  omAlb *= 1.0 + ( omNzM.r - 0.5 ) * 2.0 * omMacro.x;
  omAlb *= mix( vec3( 1.0 ), vec3( 1.07, 1.0, 0.9 ), ( omNzM.b - 0.5 ) * 2.0 * omMacro.w );
  omRough += ( omNzF.g - 0.5 ) * omMacro.y;

  #ifdef OM_CAMO
  {
    #if defined( OM_TRI_WORLD ) || defined( OM_TRI_OBJECT )
      float c1 = omTriSample( omNoise, omTP + 3.1, omTN, omBW, 1.6 ).r;
      float c2 = omTriSample( omNoise, omTP + 7.7, omTN, omBW, 2.3 ).g;
      float c3 = omTriSample( omNoise, omTP + 1.3, omTN, omBW, 3.1 ).b;
    #else
      float c1 = texture2D( omNoise, vUv * 1.6 + 0.31 ).r;
      float c2 = texture2D( omNoise, vUv * 2.3 + 0.77 ).g;
      float c3 = texture2D( omNoise, vUv * 3.1 + 0.13 ).b;
    #endif
    vec3 cc = omCamo0;
    cc = mix( cc, omCamo1, smoothstep( 0.49, 0.53, c1 ) );
    cc = mix( cc, omCamo2, smoothstep( 0.55, 0.59, c2 ) );
    cc = mix( cc, omCamo3, smoothstep( 0.62, 0.66, c3 ) * 0.9 );
    omAlb *= cc;
  }
  #endif

  #if defined( OM_HESCO ) && !defined( OM_TRI_WORLD ) && !defined( OM_TRI_OBJECT )
  {
    // 76 mm galvanised weld mesh (4 mm wire) over geotextile that bulges between the wires
    vec2 cell = fract( vUv * 13.1 ) - 0.5;
    vec2 g = abs( cell ) * 2.0;
    float m = max( g.x, g.y );
    float fw = ( fwidth( vUv.x ) + fwidth( vUv.y ) ) * 13.1;
    float wire = smoothstep( 0.9 - fw, 0.92 + fw, m );
    float wpos = omSat( ( m - 0.92 ) / 0.08 ) * 2.0 - 1.0;
    vec2 wn = g.x > g.y ? vec2( sign( cell.x ) * wpos, 0.0 ) : vec2( 0.0, sign( cell.y ) * wpos );
    // geotextile: flat in the cell centre, pulled in only near the wires (cubic), plus slow panel sag
    vec2 bn = ( cell * 0.5 + sign( cell ) * pow( abs( cell ) * 2.0, vec2( 3.0 ) ) * 0.22 ) * ( 1.0 - wire ) + ( omNzM.rg - 0.5 ) * 0.35;
    // the mesh stands ~1 cm proud of the fabric: thin cast shadow next to the wires (down / one side)
    float wsh = max( smoothstep( 0.3, 0.4, cell.y ) * smoothstep( 0.47, 0.44, cell.y ), smoothstep( 0.3, 0.4, - cell.x ) * smoothstep( 0.47, 0.44, - cell.x ) * 0.7 );
    float rustW = smoothstep( 0.6, 0.85, texture2D( omNoise, vUv * 0.9 ).b ) * 0.55;
    vec3 wireCol = mix( vec3( 0.36, 0.37, 0.36 ), vec3( 0.16, 0.1, 0.07 ), rustW ) * ( 0.8 + 0.4 * omNzF.g );
    omAlb = mix( omAlb, wireCol, wire );
    omMetal = mix( omMetal, 0.75 * ( 1.0 - rustW ), wire );
    omRough = mix( omRough, 0.5 + 0.3 * rustW, wire );
    omAO *= mix( 1.0, 0.7, smoothstep( 0.72, 0.92, m ) * ( 1.0 - wire ) );
    omAlb *= mix( 1.0, 0.86, smoothstep( 0.75, 0.92, m ) * ( 1.0 - wire ) );
    omAlb *= 1.0 - 0.35 * wsh * ( 1.0 - wire );
    omNv = normalize( omNv + omTBN * vec3( bn + wn * wire * 0.9, 0.0 ) );
  }
  #endif

  // ---------------------------------------------------------------- world-space weathering
  vec3 omNw = normalize( ( vec4( omNv, 0.0 ) * viewMatrix ).xyz );
  #ifdef OM_GRIME
  {
    float up = smoothstep( 0.35, 0.92, omNw.y );
    float vert = 1.0 - smoothstep( 0.35, 0.75, abs( omGNw.y ) );
    float gw = omGlobal.w;
    // along-wall coordinate (horizontal, perpendicular to the wall normal)
    vec2 omTg = normalize( vec2( - omGNw.z, omGNw.x ) + 1e-5 );
    float omU = dot( omP.xz, omTg );
    // blotchy soot / grime patches
    float blot = smoothstep( 0.42, 0.9, omNzM.b * 0.75 + omNzF.r * 0.45 ) * omGrime.w * gw;
    omAlb *= 1.0 - 0.34 * blot;
    omRough += 0.08 * blot;
    // repaired / re-rendered patches: axis-aligned blocks of slightly different tone (walls only)
    if ( omP2.z > 0.0 && vert > 0.01 ) {
      vec2 pc = vec2( omU, omP.y ) / vec2( 2.3, 1.7 );
      vec2 pci = floor( pc );
      vec4 pr = texture2D( omNoise, ( pci + 0.5 ) * 0.137 );
      vec2 pf = fract( pc );
      vec2 lo = 0.08 + pr.xy * 0.3, hi = lo + 0.35 + pr.yz * 0.3;
      float fw2 = 0.02 + 0.03 * omNzF.g;
      float inPatch = smoothstep( lo.x - fw2, lo.x + fw2, pf.x ) * smoothstep( hi.x + fw2, hi.x - fw2, pf.x )
                    * smoothstep( lo.y - fw2, lo.y + fw2, pf.y ) * smoothstep( hi.y + fw2, hi.y - fw2, pf.y );
      inPatch *= step( 0.52, pr.w ) * vert * omP2.z;
      float tone = ( pr.z - 0.5 ) * 0.5;
      omAlb *= 1.0 + tone * inPatch;
      omAlb = mix( omAlb, omAlb * vec3( 1.02, 1.0, 0.95 ), inPatch * pr.x );
      omRough += 0.04 * inPatch * sign( tone );
    }
    // rain / water staining. Runs hang from storey lines (sills / slab edges every ~3.1 m, offset in
    // wall regions), keep a near-constant width, fade in intensity over a per-run length and wobble a
    // little; a broad soft wash sits under the sources. (v2: no tapering "flame" spikes)
    float colOff = texture2D( omNoise, vec2( omU * 0.043, 0.37 ) ).g * 3.1 + texture2D( omNoise, vec2( omU * 0.9, 0.71 ) ).b * 0.05;
    float ph = fract( ( omP.y + colOff ) / 3.1 );
    float dn = ( 1.0 - ph ) * 3.1;                                                        // m below the source line
    float src = smoothstep( 0.0, 0.06, dn );                                              // soft start under the ledge
    float wob = ( texture2D( omNoise, vec2( 0.23, omP.y * 0.21 ) ).g - 0.5 ) * 0.035;
    float colA = texture2D( omNoise, vec2( ( omU + wob ) * 0.11, 0.37 ) ).a;             // thin runs (column profile)
    float colB = texture2D( omNoise, vec2( ( omU + wob ) * 0.047 + 0.5, 0.81 ) ).a;      // wider, fewer runs
    float runL = 0.35 + 2.6 * smoothstep( 0.3, 0.8, texture2D( omNoise, vec2( omU * 0.61, 0.29 ) ).g );
    float fadeT = 1.0 - smoothstep( 0.0, runL, dn );
    float fadeB = 1.0 - smoothstep( 0.0, runL * 0.6 + 0.4, dn );
    float brkS = 0.55 + 0.9 * texture2D( omNoise, vec2( omU * 0.11, omP.y * 0.09 ) ).g;  // broken along the run
    float stW = smoothstep( 0.3, 0.7, texture2D( omNoise, vec2( omU * 0.061, 0.19 ) ).r ); // which wall regions run
    float wash = smoothstep( 0.4, 0.85, texture2D( omNoise, vec2( omU * 0.021, 0.61 ) ).b ) * ( 1.0 - smoothstep( 0.0, 1.8, dn ) ) * smoothstep( 0.0, 0.45, dn );
    float streak = ( colA * fadeT * 2.2 + colB * fadeB * 1.6 ) * brkS * ( 0.35 + 0.9 * stW ) + wash * 0.55;
    streak = omSat( streak * src ) * vert * omGrime.z * gw;
    omDbg.z = streak;
    omAlb *= 1.0 - 0.4 * streak;
    omAlb *= mix( vec3( 1.0 ), vec3( 0.96, 0.96, 0.9 ), streak );
    omRough += 0.05 * streak;
    // rising damp + splash dirt at wall bases (height above ground level)
    float hgt = omP.y - omGlobal.x;
    float nL = texture2D( omNoise, vec2( omU * 0.071, 0.53 ) ).r;              // slow change along the wall
    float nM = texture2D( omNoise, vec2( omU * 0.63, hgt * 0.35 + 0.2 ) ).g;
    float nF = texture2D( omNoise, vec2( omU * 3.7, hgt * 3.1 ) ).g;
    // v2: long, gently undulating damp line (no "mountain range" peaks), soft upward fade
    float lineH = omP2.w * ( 0.45 + 0.85 * nL + 0.18 * nM ) + ( nF - 0.5 ) * 0.025;
    float damp = 1.0 - smoothstep( lineH - 0.5, lineH + 0.04, hgt + ( omH - 0.5 ) * 0.06 );
    damp *= damp * ( 3.0 - 2.0 * damp );
    float tide = omSat( 1.0 - abs( hgt - lineH + 0.03 ) / 0.05 ) * ( 0.25 + 0.5 * nF ) * nM;   // faint brown tide mark
    float lowG = 1.0 - smoothstep( 0.0, 0.55 * max( lineH, 0.2 ), hgt );                  // dirt gradient towards the ground
    float splash = step( 0.74, texture2D( omNoise, vec2( omU * 9.1, hgt * 6.7 ) ).g ) * ( 1.0 - smoothstep( 0.05, 0.5, hgt ) );
    float contact = 1.0 - smoothstep( 0.0, 0.1 + 0.08 * nF, hgt );
    float bw = vert * omGrime.y * gw;
    float base = omSat( damp * 0.55 + lowG * 0.45 + splash * 0.4 + contact * 0.35 ) * bw;
    omDbg.x = base;
    omAlb *= 1.0 - 0.24 * damp * bw;                                                      // moisture darkening
    omAlb = mix( omAlb, omDirtColor * ( 0.8 + 0.5 * nF ), omSat( lowG * 0.55 + splash * 0.5 + contact * 0.3 ) * bw );
    omAlb = mix( omAlb, omAlb * vec3( 0.72, 0.66, 0.58 ), tide * damp * bw );
    omRough = mix( omRough, 0.95, base * 0.5 );
    omAO *= 1.0 - 0.35 * contact * bw;
    // dust accumulation on up-facing surfaces, heavier in crevices (low height)
    float dust = up * smoothstep( 0.3, 0.72, omNzF.g * 0.8 + ( 0.55 - omH ) * 0.9 + omNzM.r * 0.3 ) * omGrime.x * omGlobal.z;
    dust = omSat( dust );
    omDbg.y = dust;
    omAlb = mix( omAlb, omDustColor, dust * 0.85 );
    omRough = mix( omRough, 0.97, dust );
    omMetal *= 1.0 - dust;
    omNv = normalize( mix( omNv, omGN, dust * 0.6 ) );
  }
  #endif

  #ifdef OM_BURN
  {
    // fire damage: soot coverage grows with amount; heat-oxidised rust breaks through, pale ash on top
    float bn = omNzM.b * 0.6 + omNzF.g * 0.4;
    float b = omSat( omBurn.x * 1.25 - 0.3 + ( bn - 0.5 ) * 1.1 );
    b = smoothstep( 0.0, 0.7, b ) * step( 0.001, omBurn.x );
    float ash = smoothstep( 0.55, 0.85, omNzF.r * 0.7 + omNw.y * 0.35 ) * b;
    float heat = smoothstep( 0.62, 0.9, omNzF.b * 0.7 + omNzM.g * 0.4 ) * b * ( 1.0 - ash );
    vec3 soot = vec3( 0.016, 0.015, 0.014 ) * ( 0.6 + 0.9 * omNzF.g );
    soot = mix( soot, vec3( 0.048, 0.026, 0.015 ), heat * 0.85 );
    soot = mix( soot, vec3( 0.2, 0.19, 0.18 ), ash * 0.7 );
    float rim = omSat( 1.0 - abs( b - 0.3 ) * 5.0 ) * omBurn.x;
    omAlb = mix( omAlb, soot, b );
    omAlb = mix( omAlb, omAlb * vec3( 1.25, 0.8, 0.5 ), rim * 0.5 );
    omRough = mix( omRough, 0.9 - 0.2 * heat, b );
    omMetal *= 1.0 - b * 0.85;
  }
  #endif

  #ifdef OM_WEAR
  {
    // signed curvature from screen-space derivatives: > 0 convex (edges), < 0 concave (creases)
    vec3 pdx = dFdx( - vViewPosition ), pdy = dFdy( - vViewPosition );
    vec3 ndx = dFdx( omGN ), ndy = dFdy( omGN );
    float kden = max( dot( pdx, pdx ) + dot( pdy, pdy ), 1e-10 );
    float curv = ( dot( ndx, pdx ) + dot( ndy, pdy ) ) / kden;
    float edge = smoothstep( omWear.y, omWear.z, curv );
    float crease = smoothstep( omWear.y, omWear.z, - curv );
    edge = max( edge, vOmWearAttr );
    #ifdef OM_TRI_OBJECT
      float brk = omTriSample( omNoise, vOmOPos, omTN, omBW, 9.0 ).g;
      float brk2 = omTriSample( omNoise, vOmOPos, omTN, omBW, 41.0 ).b;
      float smudge = omTriSample( omNoise, vOmOPos, omTN, omBW, 7.1 ).b;
    #else
      float brk = omNzF.g;
      float brk2 = omNzM.g;
      float smudge = omNzM.b;
    #endif
    // handling: oily smudges lower roughness in patches, fine grit raises it elsewhere
    omRough -= ( smoothstep( 0.4, 0.8, smudge ) - 0.3 ) * 0.035 * omWear.x;
    float wm = omSat( edge * 1.3 - 0.35 + ( brk - 0.5 ) * 0.9 + ( brk2 - 0.5 ) * 0.8 ) * omWear.x;
    wm = smoothstep( 0.2, 0.55, wm );
    omAlb = mix( omAlb, omWearColor, wm );
    omMetal = mix( omMetal, 1.0, wm * step( 0.2, max( omWearColor.r, omWearColor.g ) ) );
    omRough = mix( omRough, omWear.w, wm );
    // packed grime / carbon in creases
    omAlb *= 1.0 - 0.45 * crease * omWear.x;
    omRough = mix( omRough, 0.8, crease * 0.5 * omWear.x );
    omAO *= 1.0 - 0.4 * crease;
  }
  #endif

  // ---------------------------------------------------------------- wetness (global)
  if ( omGlobal.y > 0.001 ) {
    float wet = omGlobal.y;
    float upG = smoothstep( 0.75, 0.97, omGNw.y );
    float puddle = upG * smoothstep( 0.5, 0.62, omNzM.r * 0.65 + ( 1.0 - omH ) * 0.45 + wet * 0.2 - 0.12 ) * smoothstep( 0.2, 0.7, wet );
    float damp = wet * mix( 0.55, 1.0, upG );
    omAlb *= 1.0 - omP2.y * 0.55 * damp;
    omRough = mix( omRough, omRough * 0.45, damp * 0.8 );
    omRough = mix( omRough, 0.04, puddle );
    omNv = normalize( mix( omNv, omGN, puddle ) );
  }

  omRough = clamp( omRough, 0.035, 1.0 );
  omMetal = omSat( omMetal );
  if ( omDebug > 0.5 ) {
    int dm = int( omDebug + 0.5 );
    vec3 dv = dm == 1 ? omAlb : dm == 2 ? vec3( omRough ) : dm == 3 ? vec3( omMetal ) : dm == 4 ? vec3( omAO ) : dm == 5 ? vec3( omH ) : dm == 6 ? vec3( omDbg.x ) : dm == 7 ? vec3( omDbg.y ) : dm == 8 ? vec3( omDbg.z ) : omNw * 0.5 + 0.5;
    omAlb = vec3( 0.0 ); omRough = 1.0; omMetal = 0.0; totalEmissiveRadiance = dv;
  }
  #if defined( OM_PAINT ) && defined( OM_MAPS )
    diffuseColor.rgb = omAlb;
  #else
    diffuseColor.rgb *= omAlb; // honours material.color (tinted clones)
  #endif
`;

const FRAG_AO = /* glsl */`
{
  float ambientOcclusion = omAO;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_SHEEN )
    sheenSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNVom = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNVom, ambientOcclusion, material.roughness );
  #endif
}
#include <aomap_fragment>
`;

const FRAG_GLASS_OUT = /* glsl */`
#ifdef OM_GLASS
{
  // coverage = dirt / smudge film that scatters light; the rest transmits minus Fresnel reflection
  float grit = texture2D( omNoise, omWUV * 5.3 ).g;
  float cover = omSat( omGlass.z * ( 0.1 + smoothstep( 0.35, 0.9, omNzF.b ) * 1.6 + smoothstep( 0.7, 0.95, grit ) * 0.8 ) );
  float nv = saturate( dot( normal, normalize( vViewPosition ) ) );
  float fr = 0.04 + 0.96 * pow( 1.0 - nv, 5.0 );
  float trans = ( 1.0 - cover ) * ( 1.0 - fr ) * omGlass.x;
  gl_FragColor = vec4( totalDiffuse * cover + totalSpecular + totalEmissiveRadiance, 1.0 - trans );
}
#else
#include <opaque_fragment>
#endif
`;

const FRAG_DECAL = /* glsl */`
#ifdef OM_DECAL
{
  // v2 worn road paint: an intact film overall; broad traffic-worn zones go thin (partial alpha) and
  // grimy, aggregate peaks poke through as fine speckle, and flaked chips cluster in the worn zones.
  float traffic = texture2D( omNoise, omWUV * 0.37 + 0.11 ).r * 0.65 + omNzM.r * 0.35;
  float thin = smoothstep( 0.42, 0.78, traffic );
  float chip = texture2D( omNoise, omWUV * 2.1 ).g * 0.6 + texture2D( omNoise, omWUV * 9.3 ).b * 0.4;
  float grit = texture2D( omNoise, omWUV * 27.0 + 0.5 ).g * 0.7 + texture2D( omNoise, omWUV * 61.0 + 0.2 ).b * 0.3;
  float omDecA = 0.95 - 0.45 * thin;
  // aggregate peaks: a fine sparse speckle on intact paint, dense where traffic has thinned it
  omDecA *= 1.0 - 0.9 * smoothstep( 0.6 - 0.16 * thin, 0.66 - 0.14 * thin, grit );
  // flaked chips (ragged, clustered in the worn zones)
  omDecA *= smoothstep( 0.34, 0.4, chip + 0.06 - 0.3 * thin + ( grit - 0.5 ) * 0.25 );
  diffuseColor.a = omDecA;
  diffuseColor.rgb *= ( 0.9 + 0.2 * grit ) * mix( vec3( 1.0 ), vec3( 0.74, 0.71, 0.66 ), omSat( thin * 0.85 + 0.25 * omNzF.g ) );
}
#endif
`;

function patchVertex(src) {
  return src
    .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_MAIN}`);
}

function patchFragment(src) {
  return src
    .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
    .replace('#include <map_fragment>', FRAG_SURFACE)
    .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>\n${FRAG_DECAL}`)
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = omRough;')
    .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = omMetal;')
    .replace('#include <normal_fragment_maps>', 'normal = omNv;')
    .replace('#include <aomap_fragment>', FRAG_AO)
    .replace('#include <opaque_fragment>', FRAG_GLASS_OUT)
    .replace('#include <premultiplied_alpha_fragment>', '#ifndef OM_GLASS\n#include <premultiplied_alpha_fragment>\n#endif');
}

// --------------------------------------------------------------------------------- material classes
const PROGRAM_VERSION = 'om-6';

function omOnBeforeCompile(shader) {
  const om = this._om;
  if (!om) return;
  Object.assign(shader.uniforms, om.uniforms, GLOBAL_UNIFORMS);
  shader.vertexShader = patchVertex(shader.vertexShader);
  shader.fragmentShader = patchFragment(shader.fragmentShader);
}

function cloneUniforms(u) {
  const out = {};
  for (const k of Object.keys(u)) {
    const v = u[k].value;
    out[k] = { value: v && typeof v.clone === 'function' && !v.isTexture ? v.clone() : v };
  }
  return out;
}

function mixin(Base) {
  return class extends Base {
    constructor(params) {
      super(params);
      this._om = null;
      this.onBeforeCompile = omOnBeforeCompile;
    }
    customProgramCacheKey() { return PROGRAM_VERSION; }
    copy(source) {
      super.copy(source);
      if (source._om) {
        this._om = { key: source._om.key, uniforms: cloneUniforms(source._om.uniforms) };
        this.defines = { ...(source.defines || {}) };
      }
      this.onBeforeCompile = omOnBeforeCompile;
      return this;
    }
  };
}

export const OMStandardMaterial = mixin(THREE.MeshStandardMaterial);
export const OMPhysicalMaterial = mixin(THREE.MeshPhysicalMaterial);

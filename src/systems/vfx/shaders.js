/**
 * GLSL for the vfx particle batches (WebGL2 / ANGLE-D3D11 safe).
 *
 * Instanced quad attributes (per particle):
 *   iPos   (x, y, z, size)            world position, quad size (m)
 *   iCol   (r, g, b, a)               albedo (smoke) or HDR color (glow), alpha / intensity
 *   iMisc  (rot, frame, heat, sunVis) rotation (rad), atlas frame (-1 = procedural), emission heat, sun visibility
 *   iVel   (vx, vy, vz, stretch)      velocity for streak stretching (m/s), stretch seconds (0 = billboard)
 *   iPlane (nx, ny, nz, d)            soft-intersection plane (world). n = 0 disables
 *   iExtra (erode, soft, seed, fadeNear)
 */

const COMMON_VERT = /* glsl */ `
  attribute vec2 corner;
  attribute vec4 iPos;
  attribute vec4 iCol;
  attribute vec4 iMisc;
  attribute vec4 iVel;
  attribute vec4 iPlane;
  attribute vec4 iExtra;
  uniform float uPixelScale;   // viewport height / (2 tan(fov/2))
  varying vec2 vCorner;
  varying vec4 vCol;
  varying vec3 vWorld;
  varying vec4 vPlane;
  varying float vViewZ;
  varying vec4 vExtra;
  varying float vThin;

  // Builds the quad corner in world space. Returns world position; writes the sprite basis.
  vec3 buildQuad(out vec3 R, out vec3 U, out vec3 F) {
    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 center = iPos.xyz;
    vec3 toCam = normalize(cameraPosition - center);
    F = toCam;
    float size = iPos.w;
    vThin = 1.0;
    vec3 wp;
    if (iVel.w > 0.0) {
      // velocity-stretched streak: long axis along the projected velocity
      vec3 vel = iVel.xyz;
      float speed = length(vel);
      vec3 dir = speed > 1e-4 ? vel / speed : camUp;
      vec3 side = cross(dir, toCam);
      float sl = length(side);
      side = sl > 1e-4 ? side / sl : camRight;
      float len = size + speed * iVel.w;
      float dist = max(dot(center - cameraPosition, -toCam) * -1.0, 0.05);
      dist = max(length(center - cameraPosition), 0.05);
      // keep a minimum on-screen width of ~1.3px, trading width for intensity (AA thin lines)
      float px = size * uPixelScale / dist;
      float minPx = 1.3;
      float w = size;
      if (px < minPx) { w = size * minPx / max(px, 1e-4); vThin = px / minPx; }
      // corner.y in [-0.5,0.5] along length: head at +0.5 (current position), tail behind
      wp = center + dir * ((corner.y - 0.5) * len) + side * (corner.x * w);
      R = side; U = dir;
    } else {
      float c = cos(iMisc.x), s = sin(iMisc.x);
      R = camRight * c + camUp * s;
      U = -camRight * s + camUp * c;
      wp = center + (R * corner.x + U * corner.y) * size;
    }
    return wp;
  }
`;

// Soft particles: scene linear depth (metres, from the postfx pipeline; <= 0 means viewmodel / no data).
const SOFT_DEPTH = /* glsl */ `
  uniform highp sampler2D tSceneDepth;
  uniform float uHasDepth;
  float softDepth(float viewZ, float dist) {
    if (uHasDepth < 0.5) return 1.0;
    float sd = texelFetch(tSceneDepth, ivec2(gl_FragCoord.xy), 0).r;
    if (sd <= 0.0) return 1.0;
    return clamp((sd - viewZ) / max(dist, 0.005), 0.0, 1.0);
  }
`;

// ------------------------------------------------------------------------------------ lit smoke
export const smokeVertex = /* glsl */ `
  ${COMMON_VERT}
  uniform vec3 uSunDir;
  varying vec3 vLightLocal;
  varying vec2 vUv;
  varying vec3 vMisc;   // heat, sunVis, frame
  #include <fog_pars_vertex>

  void main() {
    vec3 R, U, F;
    vec3 wp = buildQuad(R, U, F);
    vWorld = wp;
    vCorner = corner;
    vCol = iCol;
    vPlane = iPlane;
    vExtra = iExtra;
    vMisc = vec3(iMisc.z, iMisc.w, iMisc.y);
    vLightLocal = vec3(dot(uSunDir, R), dot(uSunDir, U), dot(uSunDir, F));
    float f = iMisc.y;
    float cx = mod(f, 4.0), cy = floor(f / 4.0);
    vUv = vec2((cx + corner.x + 0.5) * 0.25, (3.0 - cy + corner.y + 0.5) * 0.25);
    vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
    vViewZ = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

export const smokeFragment = /* glsl */ `
  uniform sampler2D tA;
  uniform sampler2D tB;
  uniform sampler2D tNoise;
  uniform vec3 uSunColor;     // linear radiance scale (color * intensity / PI)
  uniform vec3 uSkyColor;     // ambient from above
  uniform vec3 uGroundColor;  // ambient from below
  uniform float uTime;
  uniform float uEmissive;
  varying vec3 vLightLocal;
  varying vec2 vUv;
  varying vec3 vMisc;
  varying vec2 vCorner;
  varying vec4 vCol;
  varying vec3 vWorld;
  varying vec4 vPlane;
  varying float vViewZ;
  varying vec4 vExtra;
  varying float vThin;
  #include <common>
  #include <fog_pars_fragment>
  ${SOFT_DEPTH}

  vec3 blackbody(float t) {
    // t 0..1 -> deep red .. orange .. yellow-white (linear, HDR-ready)
    vec3 c = mix(vec3(0.6, 0.05, 0.0), vec3(1.0, 0.32, 0.03), smoothstep(0.0, 0.45, t));
    c = mix(c, vec3(1.0, 0.72, 0.28), smoothstep(0.4, 0.8, t));
    c = mix(c, vec3(1.0, 0.93, 0.78), smoothstep(0.8, 1.0, t));
    return c;
  }

  void main() {
    vec4 A, B;
    if (vMisc.z < 0.0) {
      // procedural soft round (droplets, grains, streaks)
      float r = length(vCorner * 2.0);
      float a = smoothstep(1.0, 0.25, r);
      A = vec4(0.7, 0.85, 0.8, a); B = vec4(0.55, 0.35, 0.6, a * 0.5);
    } else {
      A = texture2D(tA, vUv);
      B = texture2D(tB, vUv);
    }
    float alpha = A.a;
    // round tile mask: atlas puffs never show square/straight quad edges (matters for stretched streaks)
    alpha *= 1.0 - smoothstep(0.34, 0.5, length(vCorner));
    // erosion: dissolve thin parts as the puff ages (breaks up the silhouette)
    float erode = vExtra.x;
    if (erode > 0.0 && vMisc.z >= 0.0) {
      float n = texture2D(tNoise, vUv * 3.0 + vExtra.z).r;
      alpha = clamp((alpha - erode * (1.0 - n) * 0.9) / max(1.0 - erode * 0.6, 0.05), 0.0, 1.0);
    }
    alpha *= vCol.a * vThin;
    // soft intersection with the spawn surface / ground plane
    if (dot(vPlane.xyz, vPlane.xyz) > 0.5) {
      float d = dot(vWorld, vPlane.xyz) - vPlane.w;
      alpha *= clamp(d / max(vExtra.y, 0.01), 0.0, 1.0);
    }
    // camera-near fade
    alpha *= clamp((vViewZ - 0.12) / max(vExtra.w, 0.05), 0.0, 1.0);
    if (alpha < 0.002) discard;
    alpha *= softDepth(vViewZ, vExtra.y);
    if (alpha < 0.002) discard;

    vec3 P = A.rgb * A.rgb;
    vec3 N = B.rgb * B.rgb;
    vec3 l = normalize(vLightLocal);
    vec3 lp = max(l, 0.0); lp *= lp;
    vec3 ln = max(-l, 0.0); ln *= ln;
    float sunTerm = dot(lp, P) + dot(ln, N);
    // forward scattering boost when looking towards the sun through thin smoke
    float fwd = pow(max(-l.z, 0.0), 4.0) * (1.0 - A.a) * 0.8;
    float sky = P.g * 0.75 + (P.r + N.r + P.b + N.b) * 0.08 + 0.1;
    float grd = N.g * 0.5 + 0.1;
    vec3 albedo = vCol.rgb;
    vec3 col = albedo * (uSunColor * (sunTerm + fwd) * vMisc.y * 1.1 + uSkyColor * sky + uGroundColor * grd);

    // fire emission: hot turbulent filaments inside the interior "heat" mask, sooty gaps between them
    float heat = vMisc.x;
    if (heat > 0.001) {
      float core = B.a;
      float n1 = texture2D(tNoise, vUv * 1.6 + vec2(uTime * 0.09, -uTime * 0.23) + vExtra.z).r;
      float n2 = texture2D(tNoise, vUv * 4.1 - vec2(uTime * 0.17, uTime * 0.37) + vExtra.z * 1.7).g;
      float fil = n1 * 0.62 + n2 * 0.38;
      float temp = heat * (core * 0.95 + (fil - 0.5) * 1.3) - (1.0 - min(heat, 1.0)) * 0.25;
      temp = clamp(temp, 0.0, 1.25);
      float m = smoothstep(0.12, 0.55, temp);
      col *= 1.0 - 0.7 * m;
      col += blackbody(min(temp, 1.0)) * m * uEmissive * (0.25 + 2.6 * temp * temp * temp);
    }

    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
      #else
        float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
      #endif
      col = mix(col, fogColor, fogFactor);
    #endif
    gl_FragColor = vec4(col * alpha, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ------------------------------------------------------------------------------------ additive glow
export const glowVertex = /* glsl */ `
  ${COMMON_VERT}
  varying vec2 vUv;
  varying float vFrame;
  varying float vHeat;
  #include <fog_pars_vertex>
  void main() {
    vec3 R, U, F;
    vec3 wp = buildQuad(R, U, F);
    vWorld = wp;
    vCorner = corner;
    vCol = iCol;
    vPlane = iPlane;
    vExtra = iExtra;
    vFrame = iMisc.y;
    vHeat = iMisc.z;
    float f = max(iMisc.y, 0.0);
    float cx = mod(f, 4.0), cy = floor(f / 4.0);
    vUv = vec2((cx + corner.x + 0.5) * 0.25, (3.0 - cy + corner.y + 0.5) * 0.25);
    vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
    vViewZ = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

export const glowFragment = /* glsl */ `
  uniform sampler2D tFlash;
  varying vec2 vUv;
  varying float vFrame;
  varying float vHeat;
  varying vec2 vCorner;
  varying vec4 vCol;
  varying vec3 vWorld;
  varying vec4 vPlane;
  varying float vViewZ;
  varying vec4 vExtra;
  varying float vThin;
  #include <common>
  #include <fog_pars_fragment>
  ${SOFT_DEPTH}
  vec3 hotColor(float t) {
    vec3 c = mix(vec3(1.0, 0.18, 0.02), vec3(1.0, 0.55, 0.12), smoothstep(0.0, 0.5, t));
    return mix(c, vec3(1.0, 0.92, 0.75), smoothstep(0.5, 1.0, t));
  }
  void main() {
    float I;
    if (vFrame < -1.5) {
      // streak: gaussian across, bright head, fading tail
      float across = vCorner.x * 2.0;
      float along = vCorner.y + 0.5;         // 0 tail .. 1 head
      I = exp(-across * across * 3.5) * pow(along, 1.4) * smoothstep(1.0, 0.92, along);
    } else if (vFrame < -0.5) {
      float r = length(vCorner * 2.0);
      I = exp(-r * r * 4.0) * smoothstep(1.0, 0.7, r);
    } else {
      float s = texture2D(tFlash, vUv).r;
      I = s * s;
    }
    I *= vCol.a * vThin;
    // camera-near fade
    I *= clamp((vViewZ - 0.05) / max(vExtra.w, 0.02), 0.0, 1.0);
    if (dot(vPlane.xyz, vPlane.xyz) > 0.5) {
      float d = dot(vWorld, vPlane.xyz) - vPlane.w;
      I *= clamp(d / max(vExtra.y, 0.005), 0.0, 1.0);
    }
    if (I < 0.0005) discard;
    I *= softDepth(vViewZ, max(vExtra.y * 0.5, 0.02));
    if (I < 0.0005) discard;
    vec3 col = vCol.rgb;
    if (vHeat > 0.0) col *= hotColor(clamp(vHeat * (0.6 + 0.4 * I), 0.0, 1.0));
    col *= I;
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
      #else
        float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
      #endif
      col *= 1.0 - fogFactor * 0.85;
    #endif
    gl_FragColor = vec4(col, 0.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ------------------------------------------------------------------------------------ muzzle flash rig
// One mesh with 8 quads. aQuad: 0 star (XY plane, faces +Z / back to shooter), 1-2 cone (XZ, YZ planes along -Z),
// 3-4 right flares (+X), 5-6 left flares (-X), 7 camera-facing core glow.
export const flashVertex = /* glsl */ `
  attribute vec2 aCorner;
  attribute float aQuad;
  uniform float uSeed;
  uniform vec3 uScale;     // star size, cone length, flare length (m)
  uniform float uFlares;   // 0/1 side flares (muzzle brake)
  uniform float uAge;      // 0..1 life fraction
  varying vec2 vUv;
  varying float vI;
  varying float vRootDist;
  float h1(float n) { return fract(sin(n * 91.345 + uSeed * 47.13) * 43758.5453); }
  vec2 cellUv(float f, vec2 c) {
    float cx = mod(f, 4.0), cy = floor(f / 4.0);
    return vec2((cx + c.x) * 0.25, (3.0 - cy + c.y) * 0.25);
  }
  void main() {
    vec3 p;
    float q = aQuad;
    vec2 c = aCorner;               // 0..1
    float grow = 0.75 + 0.45 * uAge;
    float I = 1.0;
    float frame;
    if (q < 0.5) {
      float a = h1(1.0) * 6.2831;
      float s = uScale.x * (0.75 + 0.5 * h1(2.0)) * grow;
      vec2 d = (c - 0.5) * s;
      float ca = cos(a), sa = sin(a);
      p = vec3(d.x * ca - d.y * sa, d.x * sa + d.y * ca, -0.012);
      frame = floor(h1(3.0) * 3.99);
      I = 1.0;
      vUv = cellUv(frame, c);
    } else if (q < 2.5) {
      float L = uScale.y * (0.6 + 0.6 * h1(4.0)) * grow;
      float W = L * 0.46;
      float along = c.x * L;
      float across = (c.y - 0.5) * W;
      p = q < 1.5 ? vec3(across, 0.0, -along) : vec3(0.0, across, -along);
      frame = 8.0 + floor(h1(5.0 + q) * 3.99);
      I = 1.35;
      vUv = cellUv(frame, c);
    } else if (q < 6.5) {
      float side = q < 4.5 ? 1.0 : -1.0;
      float L = uScale.z * (0.6 + 0.7 * h1(6.0 + q)) * grow;
      float W = L * 0.55;
      float along = c.x * L;
      float across = (c.y - 0.5) * W;
      bool horiz = mod(q, 2.0) > 0.5;
      p = horiz ? vec3(side * along, 0.0, across - 0.012) : vec3(side * along, across, -0.012);
      // brake ports sit slightly behind the muzzle face
      p.z += 0.018;
      frame = 4.0 + floor(h1(9.0 + q) * 3.99);
      I = 0.8 * uFlares;
      vUv = cellUv(frame, c);
    } else {
      // camera-facing glow in view space
      vec4 mv = modelViewMatrix * vec4(0.0, 0.0, -0.01, 1.0);
      float s = uScale.x * 0.55;
      mv.xy += (c - 0.5) * s;
      vUv = cellUv(12.0, c);
      vI = 0.32;
      vRootDist = 0.0;
      gl_Position = projectionMatrix * mv;
      return;
    }
    vI = I;
    vRootDist = 0.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

export const flashFragment = /* glsl */ `
  uniform sampler2D tFlash;
  uniform float uIntensity;
  uniform vec3 uTint;
  varying vec2 vUv;
  varying float vI;
  #include <common>
  void main() {
    float s = texture2D(tFlash, vUv).r;
    // cubic falloff + gain: crisp flame tongues with a hot core instead of a wide soft orange haze
    float I = s * s * s * 1.55 * vI;
    if (I < 0.002) discard;
    // temperature: thin gas at the edges is deep orange, the dense core goes yellow -> white
    vec3 c = mix(vec3(1.0, 0.16, 0.02), vec3(1.0, 0.45, 0.08), smoothstep(0.02, 0.25, I));
    c = mix(c, vec3(1.0, 0.72, 0.3), smoothstep(0.25, 0.6, I));
    c = mix(c, vec3(1.0, 0.95, 0.82), smoothstep(0.75, 1.1, I));
    I *= 0.45 + 1.1 * I;
    gl_FragColor = vec4(c * uTint * I * uIntensity, 0.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ------------------------------------------------------------------------------------ ambient dust motes
export const motesVertex = /* glsl */ `
  attribute vec2 corner;
  attribute vec4 iSeed;     // xyz in [0,1), w random
  uniform float uTime;
  uniform vec3 uBox;        // box size
  uniform vec3 uWind;
  uniform vec3 uSunDir;
  uniform float uPixelScale;
  varying vec2 vCorner;
  varying float vI;
  #include <fog_pars_vertex>
  void main() {
    vec3 drift = uWind * uTime + vec3(sin(uTime * 0.3 + iSeed.w * 30.0), sin(uTime * 0.23 + iSeed.w * 17.0) * 0.6, cos(uTime * 0.27 + iSeed.w * 11.0)) * 0.25;
    vec3 rel = iSeed.xyz * uBox + drift - cameraPosition;
    rel = mod(rel, uBox) - uBox * 0.5;         // wrap around the camera
    vec3 center = cameraPosition + rel;
    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    float dist = length(rel);
    float size = 0.0035 + iSeed.w * 0.004;
    float px = size * uPixelScale / max(dist, 0.1);
    float thin = 1.0;
    if (px < 1.5) { size *= 1.5 / max(px, 1e-3); thin = px / 1.5; }
    vec3 wp = center + (camRight * corner.x + camUp * corner.y) * size;
    vec3 v = normalize(center - cameraPosition);
    float phase = 0.25 + 1.6 * pow(max(dot(v, uSunDir), 0.0), 6.0);
    float edge = smoothstep(0.5, 0.35, length(rel / uBox)) * smoothstep(0.3, 1.2, dist);
    float twinkle = 0.6 + 0.4 * sin(uTime * (1.0 + iSeed.w * 2.0) + iSeed.w * 40.0);
    vI = phase * edge * twinkle * thin;
    vCorner = corner;
    vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

export const motesFragment = /* glsl */ `
  uniform vec3 uColor;
  varying vec2 vCorner;
  varying float vI;
  #include <common>
  #include <fog_pars_fragment>
  void main() {
    float r = length(vCorner * 2.0);
    float I = exp(-r * r * 4.0) * vI;
    if (I < 0.003) discard;
    gl_FragColor = vec4(uColor * I, 0.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

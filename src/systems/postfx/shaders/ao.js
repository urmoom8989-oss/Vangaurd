import { COMMON, DEPTH_DECODE } from './common.js';

/**
 * Ground-truth ambient occlusion (GTAO, Jimenez et al. 2016, following Intel XeGTAO's formulation),
 * computed at half resolution from a signed linear depth buffer. Viewmodel pixels (negative depth) use
 * their own projection and a much smaller radius, so the gun gets crisp contact AO and never halos onto
 * the world (and vice versa: the world/viewmodel depth gap is far outside both falloff ranges).
 */

/** Full-res hardware depth -> full-res signed linear depth (R32F). */
export const DEPTH_LINEARIZE_FRAG = /* glsl */ `
precision highp float;
${COMMON}
${DEPTH_DECODE}
uniform highp sampler2D tDepth;
void main() {
  float d = texelFetch(tDepth, ivec2(gl_FragCoord.xy), 0).r;
  gl_FragColor = vec4(signedLinearDepth(d), 0.0, 0.0, 1.0);
}`;

/** Full-res linear depth -> half-res (top-left texel of each 2x2 quad, matches nearest upsampling). */
export const DEPTH_DOWNSAMPLE_FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D tLin;
void main() {
  gl_FragColor = vec4(texelFetch(tLin, ivec2(gl_FragCoord.xy) * 2, 0).r, 0.0, 0.0, 1.0);
}`;

export const GTAO_FRAG = /* glsl */ `
precision highp float;
${COMMON}
uniform highp sampler2D tLinDepth;   // half-res signed linear depth
uniform vec2 uHalfSize;
uniform vec2 uFullSize;
uniform vec4 uProj;     // world: 1/P00, 1/P11, P20, P21
uniform vec4 uProjVM;   // viewmodel projection, same layout
uniform vec2 uP00;      // world P00, viewmodel P00
uniform vec2 uRadius;   // world radius (m), viewmodel radius (m)
uniform float uMaxRadiusPx;
uniform float uFar;
uniform float uNoiseOffset;
uniform float uFalloffRatio;

#ifndef SLICES
#define SLICES 3
#endif
#ifndef STEPS
#define STEPS 6
#endif

vec3 viewPos(ivec2 ip, float zs) {
  bool vm = zs < 0.0;
  float z = abs(zs);
  vec4 pi = vm ? uProjVM : uProj;
  vec2 uvF = (vec2(ip) * 2.0 + 0.5) / uFullSize;
  vec2 ndc = uvF * 2.0 - 1.0;
  return vec3((ndc + pi.zw) * z * pi.xy, -z);
}
vec3 fetchPos(ivec2 ip) {
  ip = clamp(ip, ivec2(0), ivec2(uHalfSize) - 1);
  return viewPos(ip, texelFetch(tLinDepth, ip, 0).r);
}
float fastAcos(float x) {
  float ax = abs(x);
  float res = -0.156583 * ax + HALF_PI;
  res *= sqrt(max(0.0, 1.0 - ax));
  return x >= 0.0 ? res : PI - res;
}

void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  float zs = texelFetch(tLinDepth, ip, 0).r;
  bool vm = zs < 0.0;
  if (!vm && zs >= uFar * 0.98) { gl_FragColor = vec4(1.0); return; }
  vec3 P = viewPos(ip, zs);

  // normal from depth: pick the neighbour pair with the smaller discontinuity on each axis
  vec3 L = fetchPos(ip - ivec2(1, 0));
  vec3 R = fetchPos(ip + ivec2(1, 0));
  vec3 B = fetchPos(ip - ivec2(0, 1));
  vec3 T = fetchPos(ip + ivec2(0, 1));
  vec3 dx = abs(P.z - L.z) < abs(R.z - P.z) ? P - L : R - P;
  vec3 dy = abs(P.z - B.z) < abs(T.z - P.z) ? P - B : T - P;
  vec3 N = normalize(cross(dx, dy));
  vec3 V = normalize(-P);
  if (dot(N, V) < 0.0) N = -N;

  float radius = vm ? uRadius.y : uRadius.x;
  float p00 = vm ? uP00.y : uP00.x;
  float z = abs(zs);
  float pxPerM = p00 / z * uHalfSize.x * 0.5;
  float radiusPx = radius * pxPerM;
  if (radiusPx > uMaxRadiusPx) { radiusPx = uMaxRadiusPx; radius = radiusPx / pxPerM; }
  if (radiusPx < 1.0) { gl_FragColor = vec4(1.0); return; }

  float falloffRange = uFalloffRatio * radius;
  float falloffFrom = radius * (1.0 - uFalloffRatio);
  float falloffMul = -1.0 / falloffRange;
  float falloffAdd = falloffFrom / falloffRange + 1.0;

  float n0 = ign(gl_FragCoord.xy + uNoiseOffset);
  float n1 = fract(n0 * 7.31 + ign(gl_FragCoord.yx * 1.37 + 11.0 + uNoiseOffset * 1.7) * 0.61803);
  float minS = 1.3 / radiusPx;

  float visibility = 0.0;
  for (int s = 0; s < SLICES; s++) {
    float phi = (float(s) + n0) * (PI / float(SLICES));
    vec2 omega = vec2(cos(phi), sin(phi));
    vec3 dirV = vec3(omega, 0.0);
    vec3 orthoDir = dirV - dot(dirV, V) * V;
    vec3 axis = normalize(cross(orthoDir, V));
    vec3 projN = N - axis * dot(N, axis);
    float projNLen = length(projN);
    float sgnN = sign(dot(orthoDir, projN));
    float cosN = sat(dot(projN, V) / max(projNLen, 1e-5));
    float n = sgnN * fastAcos(cosN);
    float low0 = cos(n + HALF_PI);
    float low1 = cos(n - HALF_PI);
    float hc0 = low0;
    float hc1 = low1;
    for (int j = 0; j < STEPS; j++) {
      float st = (float(j) + n1) / float(STEPS);
      st = st * st;
      st += minS;
      vec2 off = omega * (st * radiusPx);
      vec3 S0 = fetchPos(ivec2(floor(gl_FragCoord.xy + off)));
      vec3 S1 = fetchPos(ivec2(floor(gl_FragCoord.xy - off)));
      vec3 d0 = S0 - P;
      vec3 d1 = S1 - P;
      float l0 = length(d0);
      float l1 = length(d1);
      float w0 = sat(l0 * falloffMul + falloffAdd);
      float w1 = sat(l1 * falloffMul + falloffAdd);
      float c0 = dot(d0, V) / max(l0, 1e-6);
      float c1 = dot(d1, V) / max(l1, 1e-6);
      hc0 = max(hc0, mix(low0, c0, w0));
      hc1 = max(hc1, mix(low1, c1, w1));
    }
    projNLen = mix(projNLen, 1.0, 0.05);
    float h0 = -fastAcos(hc1);
    float h1 = fastAcos(hc0);
    h0 = n + clamp(h0 - n, -HALF_PI, HALF_PI);
    h1 = n + clamp(h1 - n, -HALF_PI, HALF_PI);
    float sinN = sin(n);
    float iarc0 = (cosN + 2.0 * h0 * sinN - cos(2.0 * h0 - n)) * 0.25;
    float iarc1 = (cosN + 2.0 * h1 * sinN - cos(2.0 * h1 - n)) * 0.25;
    visibility += projNLen * (iarc0 + iarc1);
  }
  visibility /= float(SLICES);
  gl_FragColor = vec4(sat(visibility), 0.0, 0.0, 1.0);
}`;

/** Separable depth-aware blur on the half-res AO. */
export const AO_DENOISE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tAO;
uniform highp sampler2D tLinDepth;
uniform vec2 uHalfSize;
uniform ivec2 uDir;
void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  ivec2 maxP = ivec2(uHalfSize) - 1;
  float zc = texelFetch(tLinDepth, ip, 0).r;
  float ac = texelFetch(tAO, ip, 0).r;
  float sum = ac;
  float wsum = 1.0;
  float tol = abs(zc) * 0.04 + 0.01;
  for (int i = 1; i <= 3; i++) {
    float g = i == 1 ? 0.85 : (i == 2 ? 0.55 : 0.28);
    ivec2 pa = clamp(ip + uDir * i, ivec2(0), maxP);
    ivec2 pb = clamp(ip - uDir * i, ivec2(0), maxP);
    float za = texelFetch(tLinDepth, pa, 0).r;
    float zb = texelFetch(tLinDepth, pb, 0).r;
    float wa = g * max(0.0, 1.0 - abs(za - zc) / tol) * float(sign(za) == sign(zc));
    float wb = g * max(0.0, 1.0 - abs(zb - zc) / tol) * float(sign(zb) == sign(zc));
    sum += texelFetch(tAO, pa, 0).r * wa + texelFetch(tAO, pb, 0).r * wb;
    wsum += wa + wb;
  }
  gl_FragColor = vec4(sum / wsum, 0.0, 0.0, 1.0);
}`;

/**
 * Full-res AO application: depth-aware (joint bilateral) upsample of the half-res AO and a multiply
 * blend into the HDR scene buffer (dst *= ao). Runs BEFORE transparent FX are drawn.
 */
export const AO_APPLY_FRAG = /* glsl */ `
precision highp float;
${COMMON}
${DEPTH_DECODE}
uniform sampler2D tAO;
uniform highp sampler2D tLinDepth;
uniform highp sampler2D tLinFull;
uniform vec2 uHalfSize;
uniform vec2 uPower;      // world, viewmodel exponent (intensity)
uniform vec2 uFade;       // world distance fade start, end (m)
uniform float uDebug;
void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  float zc = texelFetch(tLinFull, ip, 0).r;
  if (zc >= uDepthParams.y * 0.999) { gl_FragColor = vec4(1.0); return; }
  vec2 hp = vec2(ip) * 0.5;   // half-res texel i sits on full-res pixel 2i
  ivec2 i0 = ivec2(floor(hp));
  vec2 f = hp - vec2(i0);
  ivec2 maxP = ivec2(uHalfSize) - 1;
  float tol = abs(zc) * 0.03 + 0.005;
  float sum = 0.0, wsum = 0.0, nearestAo = 1.0, nearestErr = 1e9;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    ivec2 p = clamp(i0 + o, ivec2(0), maxP);
    float z = texelFetch(tLinDepth, p, 0).r;
    float a = texelFetch(tAO, p, 0).r;
    float bw = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
    float err = abs(z - zc);
    float w = bw * max(0.0, 1.0 - err / tol) * float(sign(z) == sign(zc)) + 1e-5 * bw;
    sum += a * w; wsum += w;
    if (err < nearestErr) { nearestErr = err; nearestAo = a; }
  }
  float ao = wsum > 2e-4 ? sum / wsum : nearestAo;
  bool vm = zc < 0.0;
  ao = pow(max(ao, 0.0), vm ? uPower.y : uPower.x);
  if (!vm) ao = mix(ao, 1.0, smoothstep(uFade.x, uFade.y, zc));
  gl_FragColor = vec4(vec3(ao), 1.0);
}`;

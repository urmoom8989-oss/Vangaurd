import { COMMON } from './common.js';

/**
 * Temporal anti-aliasing resolve.
 *  - Halton(2,3) sub-pixel jitter is applied to the projection by Pipeline.js.
 *  - Reprojection: world pixels via depth + camera matrices (closest depth in 3x3 = velocity dilation);
 *    viewmodel pixels via the viewmodel ROOT transform delta in camera space (sway/bob/recoil are
 *    reprojected exactly, so the gun does not smear).
 *  - History: 5-tap Catmull-Rom, clipped against a YCoCg variance AABB of the 3x3 neighbourhood
 *    in a reversible tonemapped space (Karis), blended in that space to suppress fireflies.
 */
export const TAA_FRAG = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tColor;
uniform highp sampler2D tDepth;
uniform sampler2D tHistory;
uniform vec2 uSize;
uniform mat4 uReproj;      // prevViewProj * inverse(currViewProj)       (unjittered)
uniform mat4 uReprojVM;    // prevVMProj * prevVMrel * inv(currVMrel) * inv(currVMProj)
uniform float uVmK;
uniform float uReset;
uniform vec2 uAlpha;       // current-frame weight: world, viewmodel
uniform vec2 uGamma;       // variance clip width: world, viewmodel

vec3 sanitize(vec3 c) {
  if (badVec3(c)) return vec3(0.0);
  return min(max(c, 0.0), vec3(65000.0));
}
vec3 tm(vec3 c) { return c / (1.0 + max(max(c.r, c.g), c.b)); }
vec3 itm(vec3 c) { return c / max(1e-5, 1.0 - max(max(c.r, c.g), c.b)); }
vec3 toYCoCg(vec3 c) {
  return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
vec3 fromYCoCg(vec3 c) {
  return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}
vec3 historyCR(vec2 uv) {
  vec2 samplePos = uv * uSize;
  vec2 tp1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - tp1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 tp12 = (tp1 + w2 / w12) / uSize;
  vec2 tp0 = (tp1 - 1.0) / uSize;
  vec2 tp3 = (tp1 + 2.0) / uSize;
  vec3 r = vec3(0.0);
  r += textureLod(tHistory, vec2(tp12.x, tp0.y), 0.0).rgb * (w12.x * w0.y);
  r += textureLod(tHistory, vec2(tp0.x, tp12.y), 0.0).rgb * (w0.x * w12.y);
  r += textureLod(tHistory, vec2(tp12.x, tp12.y), 0.0).rgb * (w12.x * w12.y);
  r += textureLod(tHistory, vec2(tp3.x, tp12.y), 0.0).rgb * (w3.x * w12.y);
  r += textureLod(tHistory, vec2(tp12.x, tp3.y), 0.0).rgb * (w12.x * w3.y);
  float ws = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / ws, 0.0);
}
vec3 clipAABB(vec3 mn, vec3 mx, vec3 q) {
  vec3 c = 0.5 * (mx + mn);
  vec3 e = 0.5 * (mx - mn) + 1e-5;
  vec3 v = q - c;
  vec3 a = abs(v / e);
  float m = max(a.x, max(a.y, a.z));
  return m > 1.0 ? c + v / m : q;
}

void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  ivec2 maxP = ivec2(uSize) - 1;
  vec2 uv = gl_FragCoord.xy / uSize;

  vec3 m1 = vec3(0.0), m2 = vec3(0.0), mn = vec3(1e9), mx = vec3(-1e9);
  vec3 center = vec3(0.0);
  float closest = 2.0;
  ivec2 closestP = ip;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      ivec2 p = clamp(ip + ivec2(x, y), ivec2(0), maxP);
      vec3 c = sanitize(texelFetch(tColor, p, 0).rgb);
      vec3 t = toYCoCg(tm(c));
      if (x == 0 && y == 0) center = t;
      m1 += t; m2 += t * t;
      mn = min(mn, t); mx = max(mx, t);
      float d = texelFetch(tDepth, p, 0).r;
      if (d < closest) { closest = d; closestP = p; }
    }
  }
  if (uReset > 0.5) {
    gl_FragColor = vec4(itm(fromYCoCg(center)), 1.0);
    return;
  }
  float dCenter = texelFetch(tDepth, ip, 0).r;
  bool vm = dCenter < uVmK || closest < uVmK;
  vec2 prevUV;
  if (vm) {
    float dd = (dCenter < uVmK ? dCenter : closest) / uVmK;
    vec4 q = uReprojVM * vec4(uv * 2.0 - 1.0, dd * 2.0 - 1.0, 1.0);
    prevUV = q.xy / q.w * 0.5 + 0.5;
  } else {
    vec2 cuv = (vec2(closestP) + 0.5) / uSize;
    vec4 q = uReproj * vec4(cuv * 2.0 - 1.0, closest * 2.0 - 1.0, 1.0);
    prevUV = uv - (cuv - (q.xy / q.w * 0.5 + 0.5));
  }
  vec3 cur = center;
  if (any(lessThan(prevUV, vec2(0.0))) || any(greaterThan(prevUV, vec2(1.0)))) {
    gl_FragColor = vec4(itm(fromYCoCg(cur)), 1.0);
    return;
  }
  vec3 hist = toYCoCg(tm(sanitize(historyCR(prevUV))));
  vec3 mu = m1 / 9.0;
  vec3 sigma = sqrt(abs(m2 / 9.0 - mu * mu));
  float g = vm ? uGamma.y : uGamma.x;
  vec3 bmn = max(mn, mu - g * sigma);
  vec3 bmx = min(mx, mu + g * sigma);
  hist = clipAABB(bmn, bmx, hist);

  float alpha = vm ? uAlpha.y : uAlpha.x;
  // more responsive under motion (sub-pixel velocity keeps full history weight)
  vec2 vel = (uv - prevUV) * uSize;
  alpha = mix(alpha, min(1.0, alpha * 2.5), sat(length(vel) / 24.0));
  // anti-flicker: when history and current agree, trust history more
  float lc = cur.x, lh = hist.x;
  float diff = abs(lc - lh) / max(lc, max(lh, 0.2));
  alpha *= mix(0.7, 1.0, sat(diff * 4.0));
  vec3 res = mix(hist, cur, alpha);
  gl_FragColor = vec4(max(itm(fromYCoCg(res)), 0.0), 1.0);
}`;

import { COMMON } from './common.js';

/**
 * Physically-motivated bloom: 13-tap "dual filter" downsample chain (Jimenez, CoD:AW) with a Karis
 * average on the first level (kills specular fireflies), soft-knee threshold applied in EXPOSED units
 * (so only real light sources / hot speculars bloom), 3x3 tent upsample accumulation.
 */
export const BLOOM_DOWN_FRAG = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tSrc;
uniform vec2 uTexel;          // source texel size
uniform float uFirst;         // 1 = first level (Karis + threshold)
uniform vec4 uThreshold;      // threshold, knee, exposure, clamp
varying vec2 vUv;

vec3 tap(vec2 o) { return textureLod(tSrc, vUv + o * uTexel, 0.0).rgb; }
float kw(vec3 c) { return 1.0 / (1.0 + luma(c) * uThreshold.z); }

void main() {
  vec3 a = tap(vec2(-2.0, 2.0)), b = tap(vec2(0.0, 2.0)), c = tap(vec2(2.0, 2.0));
  vec3 d = tap(vec2(-2.0, 0.0)), e = tap(vec2(0.0, 0.0)), f = tap(vec2(2.0, 0.0));
  vec3 g = tap(vec2(-2.0, -2.0)), h = tap(vec2(0.0, -2.0)), i = tap(vec2(2.0, -2.0));
  vec3 j = tap(vec2(-1.0, 1.0)), k = tap(vec2(1.0, 1.0));
  vec3 l = tap(vec2(-1.0, -1.0)), m = tap(vec2(1.0, -1.0));
  vec3 col;
  if (uFirst > 0.5) {
    vec3 g0 = (j + k + l + m) * 0.25;
    vec3 g1 = (a + b + d + e) * 0.25;
    vec3 g2 = (b + c + e + f) * 0.25;
    vec3 g3 = (d + e + g + h) * 0.25;
    vec3 g4 = (e + f + h + i) * 0.25;
    float w0 = kw(g0) * 0.5, w1 = kw(g1) * 0.125, w2 = kw(g2) * 0.125, w3 = kw(g3) * 0.125, w4 = kw(g4) * 0.125;
    col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    col = min(col, vec3(uThreshold.w));
    if (badVec3(col)) col = vec3(0.0);
    // soft-knee threshold on exposed brightness
    float br = max(col.r, max(col.g, col.b)) * uThreshold.z;
    float knee = uThreshold.y;
    float soft = clamp(br - uThreshold.x + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    float contrib = max(soft, br - uThreshold.x) / max(br, 1e-4);
    col *= contrib;
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export const BLOOM_UP_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tLow;       // coarser level (upsampled)
uniform sampler2D tHigh;      // this level's downsample
uniform vec2 uTexel;          // texel of tLow
uniform float uRadius;
uniform float uWeight;        // weight of the coarser level
varying vec2 vUv;
void main() {
  vec2 o = uTexel * uRadius;
  vec3 s = textureLod(tLow, vUv + vec2(-o.x, o.y), 0.0).rgb
         + textureLod(tLow, vUv + vec2(0.0, o.y), 0.0).rgb * 2.0
         + textureLod(tLow, vUv + vec2(o.x, o.y), 0.0).rgb
         + textureLod(tLow, vUv + vec2(-o.x, 0.0), 0.0).rgb * 2.0
         + textureLod(tLow, vUv, 0.0).rgb * 4.0
         + textureLod(tLow, vUv + vec2(o.x, 0.0), 0.0).rgb * 2.0
         + textureLod(tLow, vUv + vec2(-o.x, -o.y), 0.0).rgb
         + textureLod(tLow, vUv + vec2(0.0, -o.y), 0.0).rgb * 2.0
         + textureLod(tLow, vUv + vec2(o.x, -o.y), 0.0).rgb;
  s *= 1.0 / 16.0;
  gl_FragColor = vec4(textureLod(tHigh, vUv, 0.0).rgb + s * uWeight, 1.0);
}`;

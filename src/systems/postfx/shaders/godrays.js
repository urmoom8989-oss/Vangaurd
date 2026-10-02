import { COMMON } from './common.js';

/**
 * Screen-space sun shafts. Occlusion mask = sky pixels (from depth) weighted by their HDR luminance and
 * a falloff around the sun, then two radial-blur passes towards the sun (long reach + smoothing).
 * Also a 1x1 sun-visibility probe for the lens flare.
 */
export const RAYS_MASK_FRAG = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tColor;
uniform highp sampler2D tLinDepth;
uniform vec2 uHalfSize;
uniform vec2 uSun;        // sun uv (may be off-screen)
uniform float uAspect;
uniform float uSkyDist;
uniform float uExposure;
uniform vec2 uFalloff;    // x: glow falloff (1/r^2), y: core falloff
varying vec2 vUv;
void main() {
  // 2x2 depth taps so thin occluders (poles, wires, leaves) still cut the mask at quarter res
  vec2 hs = vUv * uHalfSize;
  ivec2 hp = clamp(ivec2(hs - 0.5), ivec2(0), ivec2(uHalfSize) - 2);
  float z0 = texelFetch(tLinDepth, hp, 0).r;
  float z1 = texelFetch(tLinDepth, hp + ivec2(1, 0), 0).r;
  float z2 = texelFetch(tLinDepth, hp + ivec2(0, 1), 0).r;
  float z3 = texelFetch(tLinDepth, hp + ivec2(1, 1), 0).r;
  float sky = 0.25 * (step(uSkyDist, z0) + step(uSkyDist, z1) + step(uSkyDist, z2) + step(uSkyDist, z3));
  vec3 c = textureLod(tColor, vUv, 0.0).rgb * uExposure;
  float l = luma(c);
  vec2 d = (vUv - uSun) * vec2(uAspect, 1.0);
  float r2 = dot(d, d);
  // light only radiates from around the sun: a tight core plus a soft glow, brightness-weighted so
  // bright cloud edges near the sun scatter more than dim sky
  float glow = exp(-r2 * uFalloff.x) * (0.3 + 0.7 * sat(l / 6.0));
  float core = exp(-r2 * uFalloff.y);
  gl_FragColor = vec4(sky * (glow + core * 1.5), 0.0, 0.0, 1.0);
}`;

export const RAYS_BLUR_FRAG = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tSrc;
uniform vec2 uSun;
uniform float uLength;     // fraction of the way to the sun covered
uniform float uDecay;
uniform float uNoise;
#ifndef SAMPLES
#define SAMPLES 24
#endif
varying vec2 vUv;
void main() {
  vec2 delta = (uSun - vUv) * (uLength / float(SAMPLES));
  float jitter = ign(gl_FragCoord.xy + uNoise);
  vec2 p = vUv + delta * jitter;
  float illum = 1.0, sum = 0.0, wsum = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
    sum += textureLod(tSrc, p, 0.0).r * illum;
    wsum += illum;
    illum *= uDecay;
    p += delta;
  }
  gl_FragColor = vec4(sum / wsum, 0.0, 0.0, 1.0);
}`;

export const SUN_VIS_FRAG = /* glsl */ `
precision highp float;
${COMMON}
uniform highp sampler2D tLinDepth;
uniform sampler2D tColor;
uniform vec2 uHalfSize;
uniform vec2 uSun;
uniform float uAspect;
uniform float uSkyDist;
uniform float uRadius;
uniform float uExposure;
// R: fraction of the sun disc neighbourhood that is open sky (occlusion by geometry)
// G: mean exposed luminance of the visible sky around the sun (drives flare/glare brightness)
void main() {
  float vis = 0.0, lum = 0.0;
  for (int y = -3; y <= 3; y++) {
    for (int x = -3; x <= 3; x++) {
      vec2 uv = uSun + vec2(float(x) / uAspect, float(y)) * (uRadius / 3.0);
      float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
      ivec2 hp = clamp(ivec2(uv * uHalfSize), ivec2(0), ivec2(uHalfSize) - 1);
      float z = texelFetch(tLinDepth, hp, 0).r;
      float s = step(uSkyDist, z) * inside;
      vis += s;
      lum += s * min(luma(textureLod(tColor, clamp(uv, 0.0, 1.0), 0.0).rgb) * uExposure, 200.0);
    }
  }
  gl_FragColor = vec4(vis / 49.0, lum / max(vis, 1.0), 0.0, 1.0);
}`;

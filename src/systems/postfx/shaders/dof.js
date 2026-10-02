import { COMMON, DEPTH_DECODE } from './common.js';

/**
 * ADS depth of field. The viewmodel's circle of confusion comes from its true (decoded) depth and a
 * screen-radial mask (the optic stays crisp, the receiver / handguard / hands soften, like modern CoD
 * weapon DOF). An optional far-field world blur exists (off by default). Gather is scatter-as-gather
 * (a sample contributes if its own CoC reaches this pixel), so the blurred foreground correctly bleeds
 * over the sharp background without background bleeding into the foreground.
 */
export const DOF_COC_FRAG = /* glsl */ `
precision highp float;
${COMMON}
${DEPTH_DECODE}
uniform sampler2D tColor;
uniform highp sampler2D tDepth;
uniform vec2 uFullSize;
uniform float uAspect;
uniform vec4 uVM;        // maxCoc(half px), radial start, radial end, near-z boost distance
uniform vec4 uWorld;     // maxCoc(half px), far start (m), far range (m), near-world blur distance (m)
varying vec2 vUv;

float coc(ivec2 p) {
  float d = texelFetch(tDepth, p, 0).r;
  float z = signedLinearDepth(d);
  vec2 uv = (vec2(p) + 0.5) / uFullSize;
  if (z < 0.0) {
    float r = length((uv - 0.5) * vec2(uAspect, 1.0));
    float radial = smoothstep(uVM.y, uVM.z, r);
    float nearBoost = 1.0 - smoothstep(uVM.w * 0.5, uVM.w, -z);
    return uVM.x * sat(max(radial, nearBoost * 0.85));
  }
  float farC = smoothstep(uWorld.y, uWorld.y + uWorld.z, z);
  float nearC = uWorld.w > 0.0 ? 1.0 - smoothstep(uWorld.w * 0.5, uWorld.w, z) : 0.0;
  return uWorld.x * max(farC, nearC);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  float c0 = coc(p), c1 = coc(p + ivec2(1, 0)), c2 = coc(p + ivec2(0, 1)), c3 = coc(p + ivec2(1, 1));
  vec3 col = textureLod(tColor, vUv, 0.0).rgb;   // bilinear = 2x2 average
  col = min(col, vec3(64.0));
  gl_FragColor = vec4(col, max(max(c0, c1), max(c2, c3)));
}`;

export const DOF_GATHER_FRAG = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tCoc;
uniform vec2 uHalfSize;
uniform float uMaxCoc;
#ifndef RINGS
#define RINGS 3
#endif
varying vec2 vUv;
void main() {
  vec4 c = textureLod(tCoc, vUv, 0.0);
  vec3 sum = c.rgb;
  float wsum = 1.0;
  float cover = 0.0;
  float count = 0.0;
  float ringStep = uMaxCoc / float(RINGS);
  for (int r = 1; r <= RINGS; r++) {
    int n = r * 8;
    float rad = float(r) * ringStep;
    for (int k = 0; k < 32; k++) {
      if (k >= n) break;
      float a = (float(k) + (r % 2 == 0 ? 0.5 : 0.0)) * (2.0 * PI / float(n));
      vec2 o = vec2(cos(a), sin(a)) * rad;
      vec4 s = textureLod(tCoc, vUv + o / uHalfSize, 0.0);
      float w = sat(s.a - rad + 1.0);
      sum += s.rgb * w;
      wsum += w;
      cover += w * step(0.75, s.a);
      count += 1.0;
    }
  }
  float alpha = max(smoothstep(0.35, 1.25, c.a), sat(cover / count * 2.2));
  gl_FragColor = vec4(sum / wsum, alpha);
}`;

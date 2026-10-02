/**
 * Shared GLSL snippets. All fullscreen shaders are GLSL ES 3.00 (three.js prefix), so texelFetch,
 * textureLod, isnan etc. are available.
 *
 * Depth convention of the postfx scene buffer (see Pipeline.js):
 *   world pixels      : standard perspective depth in (vmK, 1]
 *   viewmodel pixels  : depth compressed into [0, vmK] (glDepthRange-style projection trick), rendered
 *                       with its own near/far (uDepthParams.zw) so it never clips into walls.
 * signedLinearDepth() returns +z (metres) for world, -z for the viewmodel and +far for the sky.
 */
export const COMMON = /* glsl */ `
#define PI 3.14159265359
#define HALF_PI 1.57079632679
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
float luma(vec3 c) { return dot(c, LUMA); }
float sat(float x) { return clamp(x, 0.0, 1.0); }
vec3 sat3(vec3 x) { return clamp(x, 0.0, 1.0); }

// Interleaved gradient noise (Jimenez 2014)
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// NaN/Inf test on the raw bits: ANGLE/D3D's compiler assumes IEEE-finite math and strips isnan()/isinf().
bool badFloat(float x) { return (floatBitsToUint(x) & 0x7fffffffu) >= 0x7f800000u; }
bool badVec3(vec3 v) { return badFloat(v.x) || badFloat(v.y) || badFloat(v.z); }

float linearizeDepth(float d, float n, float f) { return n * f / (f - d * (f - n)); }
`;

export const DEPTH_DECODE = /* glsl */ `
uniform vec4 uDepthParams; // near, far, vmNear, vmFar
uniform float uVmK;
float signedLinearDepth(float d) {
  if (d >= 1.0) return uDepthParams.y;
  if (d < uVmK) return -linearizeDepth(d / uVmK, uDepthParams.z, uDepthParams.w);
  return linearizeDepth(d, uDepthParams.x, uDepthParams.y);
}
bool isViewmodelDepth(float d) { return d < uVmK; }
`;

/** sRGB transfer helpers. */
export const SRGB = /* glsl */ `
vec3 linearToSRGB(vec3 c) {
  c = max(c, 0.0);
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.0031308))));
}
vec3 sRGBToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.04045))));
}
`;

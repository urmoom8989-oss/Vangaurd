import { COMMON, DEPTH_DECODE, SRGB } from './common.js';

/**
 * Final "uber" pass: camera motion blur, CAS sharpening, edge-only chromatic aberration, ADS DOF
 * composite, bloom, sun shafts, procedural sun lens flare, exposure, AgX (with CDL look) / ACES /
 * Neutral tone mapping, display grade (lift/gamma/gain, split toning, saturation), vignette,
 * gameplay pulses (damage / flashbang / explosion / concussion / low health / death), sRGB encode,
 * film grain and dithering.
 */
export const FINAL_FRAG = /* glsl */ `
precision highp float;
${COMMON}
${DEPTH_DECODE}
${SRGB}

uniform sampler2D tColor;
uniform highp sampler2D tDepth;
uniform sampler2D tBloom;
uniform sampler2D tRays;
uniform sampler2D tSunVis;
uniform sampler2D tDof;
uniform sampler2D tAfter;
uniform sampler2D tGrain;
uniform sampler2D tBlood;          // R thickness, G reveal threshold (see blood.js)
uniform float uBloodOn;

uniform vec2 uSize;
uniform float uAspect;
uniform float uFrame;
uniform float uTime;
uniform float uToScreen;
uniform int uToneMapper;          // 0 agx, 1 aces, 2 neutral, 3 linear clamp
uniform float uExposure;

uniform float uSharpen;
uniform vec2 uCA;                 // px at the corner (base), extra (pulses)
uniform float uBloom;
uniform vec3 uRaysColor;
uniform float uRays;
uniform vec2 uSunUV;
uniform float uSunFactor;
uniform float uFlare;
uniform float uDofOn;

uniform float uMBOn;
uniform mat4 uMBReproj;
uniform float uMBScale;
uniform float uMBMaxPx;

// look / grade
uniform vec3 uLookSlope;
uniform vec3 uLookOffset;
uniform vec3 uLookPower;
uniform float uLookSat;
uniform vec3 uLift;
uniform vec3 uGammaG;
uniform vec3 uGain;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform float uSaturation;
uniform float uContrast;
uniform vec2 uVignette;           // strength, roundness/extent
uniform vec2 uGrain;              // amount, scale

// pulses
uniform float uDamage;
uniform float uLowHealth;
uniform float uFlash;
uniform float uAfter;
uniform float uRadial;
uniform float uDouble;
uniform float uDesat;
uniform float uDarken;
uniform float uBlackout;
uniform int uDebug;

varying vec2 vUv;

// ------------------------------------------------------------------------------ tone mapping
const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
  vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x; vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 color) {
  const mat3 inset = mat3(
    vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(
    vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float minEv = -12.47393;
  const float maxEv = 4.026069;
  color = LINEAR_SRGB_TO_LINEAR_REC2020 * color;
  color = inset * color;
  color = max(color, 1e-10);
  color = log2(color);
  color = (color - minEv) / (maxEv - minEv);
  color = clamp(color, 0.0, 1.0);
  color = agxContrast(color);
  // ASC-CDL "look" in AgX's sigmoid space (Blender's Punchy/Golden style)
  float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = pow(max(color * uLookSlope + uLookOffset, 0.0), uLookPower);
  float l2 = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = l2 + uLookSat * (color - l2);
  color = outset * color;
  color = pow(max(vec3(0.0), color), vec3(2.2));
  color = LINEAR_REC2020_TO_LINEAR_SRGB * color;
  return clamp(color, 0.0, 1.0);
}
vec3 rrtOdt(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 color) {
  const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color = inM * (color / 0.6);
  color = rrtOdt(color);
  return clamp(outM * color, 0.0, 1.0);
}
vec3 neutral(vec3 color) {
  const float startC = 0.8 - 0.04;
  const float desat = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float off = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= off;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startC) return color;
  float d = 1.0 - startC;
  float newPeak = 1.0 - d * d / (peak + d - startC);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desat * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}

// ------------------------------------------------------------------------------ sampling helpers
vec3 tmw(vec3 c) { return c / (1.0 + luma(c)); }
vec3 itmw(vec3 c) { return c / max(1e-4, 1.0 - luma(c)); }

vec3 casSample(vec2 uv, float sharp) {
  vec3 c = textureLod(tColor, uv, 0.0).rgb;
  if (sharp <= 0.001) return c;
  vec2 t = 1.0 / uSize;
  vec3 n = tmw(textureLod(tColor, uv + vec2(0.0, t.y), 0.0).rgb);
  vec3 s = tmw(textureLod(tColor, uv - vec2(0.0, t.y), 0.0).rgb);
  vec3 e = tmw(textureLod(tColor, uv + vec2(t.x, 0.0), 0.0).rgb);
  vec3 w = tmw(textureLod(tColor, uv - vec2(t.x, 0.0), 0.0).rgb);
  vec3 cc = tmw(c);
  vec3 mn = min(cc, min(min(n, s), min(e, w)));
  vec3 mx = max(cc, max(max(n, s), max(e, w)));
  vec3 amp = sqrt(sat3(min(mn, 1.0 - mx) / max(mx, 1e-4)));
  vec3 wgt = -amp / mix(8.0, 5.0, sharp);
  vec3 r = (cc + (n + s + e + w) * wgt) / (1.0 + 4.0 * wgt);
  return itmw(sat3(r));
}

float hexDist(vec2 p) {
  p = abs(p);
  return max(dot(p, vec2(0.8660254, 0.5)), p.y);
}
// Procedural sun lens flare. Returns display-relative light (added before tone mapping).
// gain = brightness of the sun (exposed) -> ghosts scale with the source like real lens reflections.
vec3 lensFlare(vec2 uv, float gain) {
  vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
  vec2 s = (uSunUV - 0.5) * vec2(uAspect, 1.0);
  vec3 c = vec3(0.0);
  vec2 d = p - s;
  float r = length(d);
  float ang = atan(d.y, d.x);
  // diffraction starburst (6-blade aperture -> 6 main spikes + fine secondary spikes)
  float rot = s.x * 0.6;
  float spikes = pow(abs(cos(ang * 3.0 + rot)), 180.0) + 0.45 * pow(abs(cos(ang * 3.0 + rot + 0.5236)), 260.0)
               + 0.18 * pow(abs(sin(ang * 11.0 + 1.3)), 40.0);
  c += vec3(1.0, 0.88, 0.7) * spikes * exp(-r * 9.0) * 0.7;
  // glare core (the disc itself is saturated anyway; this adds the soft veiling around it)
  c += vec3(1.0, 0.82, 0.6) * (exp(-r * 45.0) * 2.0 + exp(-r * 9.0) * 0.12);
  // faint horizontal streak
  c += vec3(0.85, 0.72, 0.6) * exp(-abs(d.y) * 220.0) * exp(-abs(d.x) * 6.0) * 0.1;
  // ghosts on the optical axis (sun -> centre -> beyond): hexagonal apertures, per-channel scale = lateral colour
  float gpos[7] = float[7](-0.22, -0.45, -0.7, -1.05, -1.4, 0.3, 0.55);
  float gsize[7] = float[7](0.025, 0.055, 0.09, 0.04, 0.16, 0.018, 0.035);
  vec3 gcol[7] = vec3[7](vec3(0.5, 0.75, 1.0), vec3(0.45, 1.0, 0.65), vec3(1.0, 0.62, 0.35),
                         vec3(0.75, 0.5, 1.0), vec3(0.4, 0.7, 1.0), vec3(1.0, 0.85, 0.6), vec3(0.5, 0.85, 1.0));
  float fadeCenter = sat(length(s) * 1.4 + 0.25);
  vec3 ghosts = vec3(0.0);
  for (int i = 0; i < 7; i++) {
    vec2 gp = s * gpos[i];
    vec2 q = p - gp;
    float sz = gsize[i];
    vec3 disc;
    disc.r = smoothstep(sz * 1.03, sz * 0.8, hexDist(q));
    disc.g = smoothstep(sz * 1.0, sz * 0.77, hexDist(q));
    disc.b = smoothstep(sz * 0.97, sz * 0.74, hexDist(q));
    float rim = 0.55 + 0.45 * smoothstep(sz * 0.4, sz, hexDist(q));
    ghosts += disc * rim * gcol[i] * (i == 4 ? 0.25 : 1.0);
  }
  // wide faint rainbow halo centred on the frame, radius depends on sun offset
  float hr = length(p + s * 0.35);
  float hb = hr - 0.52;
  vec3 halo = vec3(exp(-pow((hb - 0.012) * 55.0, 2.0)), exp(-pow(hb * 55.0, 2.0)), exp(-pow((hb + 0.012) * 55.0, 2.0)));
  ghosts += halo * vec3(1.0, 0.9, 1.0) * 0.35;
  c += ghosts * fadeCenter * 0.045 * clamp(gain / 12.0, 0.15, 4.0);
  return c * clamp(gain / 20.0, 0.25, 2.5);
}

void main() {
  vec2 uv = vUv;
  ivec2 ip = ivec2(gl_FragCoord.xy);
  float d = texelFetch(tDepth, ip, 0).r;
  bool vm = isViewmodelDepth(d);

  // ---- concussion double vision / radial pulse distortion
  vec2 duv = uv;
  vec3 col;
  // ---- chromatic aberration offset, edges only (quadratic falloff from centre)
  vec2 cdir = uv - 0.5;
  float r2 = dot(cdir * vec2(uAspect, 1.0), cdir * vec2(uAspect, 1.0));
  float caPx = (uCA.x * smoothstep(0.12, 0.9, r2) + uCA.y * (0.3 + r2));
  bool caOn = caPx > 0.2;
  vec2 off = caOn ? normalize(cdir + 1e-6) * caPx / uSize : vec2(0.0);

  // ---- camera motion blur (world only; CA folded into every tap so channels blur together)
  bool mbDone = false;
  if (uMBOn > 0.5 && !vm) {
    vec4 q = uMBReproj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec2 prev = q.xy / q.w * 0.5 + 0.5;
    vec2 v = (uv - prev) * uMBScale;
    float vpx = length(v * uSize);
    if (vpx > 0.75) {
      if (vpx > uMBMaxPx) v *= uMBMaxPx / vpx;
      float j = ign(gl_FragCoord.xy + uFrame * 5.588238) - 0.5;
      vec3 acc = vec3(0.0);
      float wacc = 0.0;
      for (int i = 0; i < 10; i++) {
        float t = (float(i) + 0.5 + j) / 10.0 - 0.5;
        vec2 suv = uv + v * t;
        float sd = textureLod(tDepth, suv, 0.0).r;
        float w = isViewmodelDepth(sd) ? 0.0 : 1.0;
        vec3 sc = textureLod(tColor, suv, 0.0).rgb;
        if (caOn) {
          sc.r = mix(sc.r, textureLod(tColor, suv - off, 0.0).r, 0.85);
          sc.b = mix(sc.b, textureLod(tColor, suv + off, 0.0).b, 0.85);
        }
        acc += sc * w;
        wacc += w;
      }
      if (wacc > 0.0) { col = acc / wacc; mbDone = true; }
    }
  }
  if (!mbDone) {
    col = casSample(uv, uSharpen);
    if (caOn) {
      col.r = mix(col.r, textureLod(tColor, uv - off, 0.0).r, 0.85);
      col.b = mix(col.b, textureLod(tColor, uv + off, 0.0).b, 0.85);
    }
  }

  // ---- DOF composite
  if (uDofOn > 0.5) {
    vec4 dof = textureLod(tDof, uv, 0.0);
    col = mix(col, dof.rgb, sat(dof.a));
  }

  // ---- pulse distortions: radial zoom blur + double vision
  if (uRadial > 0.002) {
    // radial zoom blur toward the centre: 16 jittered taps (no visible ghost copies)
    float jr = ign(gl_FragCoord.xy + uFrame * 3.1);
    vec3 acc = col;
    for (int i = 1; i < 16; i++) {
      float k = (float(i) - 0.5 + jr) / 15.0 * uRadial * 0.05;
      acc += textureLod(tColor, uv + (0.5 - uv) * k, 0.0).rgb;
    }
    col = acc / 16.0;
  }
  if (uDouble > 0.002) {
    vec2 o = vec2(sin(uTime * 1.7), cos(uTime * 1.3)) * 0.012 * uDouble;
    col = mix(col, textureLod(tColor, uv + o, 0.0).rgb, 0.45 * sat(uDouble * 2.0));
  }

  // ---- additive lens/atmosphere light (scene-referred)
  col += textureLod(tBloom, uv, 0.0).rgb * uBloom;
  // shafts + flare are authored in EXPOSED (display-relative) units so they read the same whatever
  // exposure the lighting preset uses
  float invExp = 1.0 / max(uExposure, 1e-4);
  // shafts are in-scattering in the air between the eye and the world: the viewmodel sits ~0.5 m from the
  // eye with no air in front of it, so it only receives a trace (lens veiling stays via the flare term)
  if (uRays > 0.0) col += textureLod(tRays, uv, 0.0).r * uRaysColor * uRays * invExp * (vm ? 0.1 : 1.0);
  if (uFlare > 0.0) {
    vec2 sv = textureLod(tSunVis, vec2(0.5), 0.0).rg;
    if (sv.x > 0.001) col += lensFlare(uv, sv.y) * uFlare * sv.x * invExp;
  }

  if (uDebug == 1) { gl_FragColor = vec4(linearToSRGB(col * uExposure / (1.0 + col * uExposure)), 1.0); return; }

  // ---- exposure + tonemap
  col *= uExposure;
  if (uToneMapper == 0) col = agx(col);
  else if (uToneMapper == 1) col = aces(col);
  else if (uToneMapper == 2) col = neutral(col);
  else col = sat3(col);

  // ---- grade in a perceptual (gamma 2.2) space
  vec3 g = pow(max(col, 0.0), vec3(1.0 / 2.2));
  g = uGain * (g + uLift * (1.0 - g));
  g = pow(max(g, 0.0), 1.0 / max(uGammaG, vec3(0.01)));
  float L = luma(g);
  g += uShadowTint * (1.0 - smoothstep(0.0, 0.55, L)) + uHighTint * smoothstep(0.35, 1.0, L);
  g = (g - 0.45) * uContrast + 0.45;
  L = luma(g);
  float satAmt = uSaturation * (1.0 - uDesat);
  g = mix(vec3(L), g, satAmt);
  col = pow(max(g, 0.0), vec3(2.2));

  // ---- vignette (+ gameplay darkening)
  vec2 vc = (uv - 0.5) * vec2(mix(1.0, uAspect, uVignette.y), 1.0);
  float vr = length(vc) * 1.42;
  float vig = 1.0 - uVignette.x * smoothstep(0.35, 1.25, vr);
  col *= vig * (1.0 - uDarken);

  // ---- damage / low health: blood-tinted edges with an organic mask
  float dmg = max(uDamage, uLowHealth);
  if (dmg > 0.001) {
    float n = textureLod(tGrain, uv * vec2(uAspect, 1.0) * 0.35, 0.0).a;
    float edge = smoothstep(0.6, 1.4, vr + (n - 0.5) * 0.35);
    // soft haemorrhage vignette underneath (darkened, blood-tinted edges)
    float m = sat(edge * (0.5 + dmg * 1.1)) * dmg;
    // exponential (Beer-Lambert) red filter + darkening: a linear mix toward red over bright sky reads pink
    // (desaturate FIRST: desaturating an already red-filtered bright pixel is what turns it salmon/pink)
    col = mix(col, vec3(luma(col)), dmg * 0.25);
    float mm = sat(m * 0.9);
    col = col * pow(vec3(0.6, 0.075, 0.06), vec3(mm * 1.3)) * (1.0 - 0.55 * mm) + vec3(0.008, 0.0, 0.0) * mm;
    // wet blood splatter on the lens: splats reveal from the frame edges inward as damage rises
    if (uBloodOn > 0.5) {
      vec2 buv = vec2(uv.x, 1.0 - uv.y);
      vec2 b = textureLod(tBlood, buv, 0.0).rg;
      float show = smoothstep(b.g - 0.02, b.g + 0.12, dmg * 1.08);
      float th = b.r * show;
      if (th > 0.002) {
        vec2 bt = 1.0 / vec2(textureSize(tBlood, 0));
        float gx = textureLod(tBlood, buv + vec2(bt.x, 0.0), 0.0).r - textureLod(tBlood, buv - vec2(bt.x, 0.0), 0.0).r;
        float gy = textureLod(tBlood, buv + vec2(0.0, bt.y), 0.0).r - textureLod(tBlood, buv - vec2(0.0, bt.y), 0.0).r;
        // blood on the lens is a subtractive FILTER (Beer-Lambert), never a mix toward a flat colour: mixing
        // bright sky with dark red is what reads as pink. Thin film = translucent crimson, thick = near-black.
        float cover = smoothstep(0.015, 0.2, th);
        vec3 absorb = exp(-vec3(1.1, 4.8, 5.4) * (0.32 + 1.2 * th));
        vec3 through = col * absorb + vec3(0.02, 0.0012, 0.001) * th;
        // wet meniscus highlight on the upper-left rim of each splat + a faint sheen across the film
        float gl = length(vec2(gx, gy));
        float spec = pow(sat(dot(normalize(vec2(-gx, gy) + 1e-5), normalize(vec2(-0.6, 0.8)))), 6.0) * sat(gl * 5.0);
        through += vec3(0.09, 0.03, 0.025) * spec * show + vec3(0.012, 0.002, 0.0015) * sat(gl * 3.0) * show;
        col = mix(col, through, cover * mix(0.72, 0.92, sat(th * 1.6)));
      }
    }
  }

  // ---- flashbang: white-out + burnt-in afterimage
  if (uAfter > 0.001) {
    vec3 a = textureLod(tAfter, uv, 0.0).rgb * uAfter;
    col = 1.0 - (1.0 - col) * (1.0 - a);
  }
  col = mix(col, vec3(1.0), sat(uFlash));
  col *= 1.0 - uBlackout;

  // ---- encode, grain, dither
  vec3 srgb = linearToSRGB(col);
  vec2 gp = gl_FragCoord.xy / (256.0 * uGrain.y);
  vec2 go = vec2(hash12(vec2(uFrame, 7.0)), hash12(vec2(13.0, uFrame)));
  vec4 gn = textureLod(tGrain, gp + go, 0.0);
  float gL = luma(srgb);
  float grain = (gn.r - 0.5) * uGrain.x * mix(1.0, 0.35, gL) * (0.6 + 0.4 * sat(gL * 6.0));
  srgb += grain;
  srgb += (gn.g + gn.b - 1.0) / 255.0;
  srgb = sat3(srgb);
  if (uDebug == 2) srgb = vec3(textureLod(tRays, uv, 0.0).r);
  if (uDebug == 3) srgb = vec3(textureLod(tDof, uv, 0.0).a);
  gl_FragColor = vec4(uToScreen > 0.5 ? srgb : sRGBToLinear(srgb), 1.0);
}`;

/** Afterimage capture (half res, display-ish LDR). */
export const AFTERIMAGE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform float uExposure;
varying vec2 vUv;
void main() {
  vec3 c = textureLod(tColor, vUv, 0.0).rgb * uExposure;
  c = c / (1.0 + c);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(mix(vec3(l), c, 0.5) * vec3(1.0, 0.97, 0.9), 1.0);
}`;

/** Debug / utility copy. */
export const COPY_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec4 uScaleBias;
uniform int uMode;
varying vec2 vUv;
void main() {
  vec4 c = textureLod(tSrc, vUv, 0.0);
  if (uMode == 1) c = vec4(vec3(c.r), 1.0);
  if (uMode == 2) c = vec4(vec3(abs(c.r) / (abs(c.r) + 10.0)), 1.0);
  gl_FragColor = vec4(c.rgb * uScaleBias.x + uScaleBias.y, 1.0);
}`;

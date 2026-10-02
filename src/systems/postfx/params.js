/**
 * Tunable postfx parameters (live-editable through services.postfx.setParam / the debug GUI).
 * Pixel quantities are authored at 1080p and scaled with the drawing-buffer height.
 */

export const GRADE_PRESETS = {
  // Art bible: filmic, slightly desaturated, warm highlights, cool neutral-teal shadows,
  // deep-but-not-crushed blacks. AgX "look" (CDL in sigmoid space) + display-space split toning.
  vardanek: {
    look: { slope: [1.01, 1.0, 0.975], offset: [0, 0, 0], power: [1.3, 1.29, 1.28], saturation: 1.12 },
    grade: {
      // gain > 1 lifts the display white point: AgX + the look power otherwise tops out at ~0.78 sRGB
      lift: [0.001, 0.006, 0.011],
      gamma: [1.0, 1.0, 1.0],
      gain: [1.11, 1.085, 1.035],
      // skylight-cool shadows (art bible): a touch more teal/blue below mid-grey, warm sun highlights
      shadowTint: [-0.022, 0.002, 0.021],
      highlightTint: [0.02, 0.007, -0.017],
      saturation: 0.97,
      contrast: 1.065,
    },
  },
  neutral: {
    look: { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1 },
    grade: { lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1], shadowTint: [0, 0, 0], highlightTint: [0, 0, 0], saturation: 1, contrast: 1 },
  },
  bleach: {
    look: { slope: [1, 1, 1], offset: [0, 0, 0], power: [1.3, 1.3, 1.3], saturation: 0.9 },
    grade: { lift: [0.01, 0.012, 0.014], gamma: [1, 1, 1], gain: [1.02, 1.01, 0.99], shadowTint: [-0.01, 0, 0.01], highlightTint: [0.01, 0.005, -0.005], saturation: 0.7, contrast: 1.08 },
  },
  night: {
    look: { slope: [0.92, 0.98, 1.06], offset: [0, 0, 0], power: [1.1, 1.1, 1.1], saturation: 0.95 },
    grade: { lift: [0.0, 0.008, 0.02], gamma: [1, 1, 1], gain: [0.96, 1.0, 1.06], shadowTint: [-0.01, 0.004, 0.02], highlightTint: [0, 0.004, 0.01], saturation: 0.8, contrast: 1.05 },
  },
};

export function defaultParams() {
  const g = GRADE_PRESETS.vardanek;
  return {
    aa: 'auto',               // 'auto' (per quality) | 'taa' | 'smaa' | 'none'
    toneMapper: 'agx',        // 'agx' | 'aces' | 'neutral' | 'none'
    exposureBias: 1.0,        // multiplies renderer.toneMappingExposure (owned by lighting)
    debugView: 'none',

    // ambient occlusion (GTAO)
    aoRadius: 1.1,            // metres, world
    aoRadiusVM: 0.06,         // metres, viewmodel
    aoPower: 1.5,
    aoPowerVM: 1.25,
    aoFalloff: 0.615,
    aoMaxRadiusPx: 56,        // half-res px @1080p
    aoFadeStart: 70,
    aoFadeEnd: 160,

    // TAA
    taaAlpha: 0.1,
    taaAlphaVM: 0.14,
    taaGamma: 1.0,
    taaGammaVM: 0.9,
    sharpen: null,            // null = per-quality default

    // bloom
    bloomIntensity: 0.05,
    bloomThreshold: 1.1,      // exposed (post-exposure) brightness
    bloomKnee: 0.6,
    bloomRadius: 1.0,
    bloomScatter: 0.85,

    // sun
    raysIntensity: 0.45,
    raysLength: 0.9,
    raysDecay: 0.965,
    raysColor: [1.0, 0.82, 0.6],
    raysFalloff: 14,          // 1/r^2 of the glow the shafts radiate from (screen heights)
    raysCore: 260,            // 1/r^2 of the hot core around the sun disc
    flareIntensity: 0.55,
    skyDistanceFrac: 0.6,     // linear depth > far * frac counts as sky

    // lens
    chromaticAberration: 1.1, // px at the frame corners @1080p
    vignette: 0.22,
    vignetteADS: 0.12,
    vignetteRoundness: 0.55,
    grain: 0.028,
    grainScale: 1.35,

    // motion blur (camera only)
    motionBlur: 0.45,         // shutter fraction
    motionBlurMaxPx: 30,

    // weapon DOF while aiming
    dofVMCoc: 5.0,            // max CoC, half-res px @1080p
    dofRadialStart: 0.09,
    dofRadialEnd: 0.42,
    dofNearZ: 0.14,           // viewmodel parts closer than this (m) blur regardless of screen position
    dofWorldCoc: 0,           // optional far-field world blur (off)
    dofWorldStart: 80,
    dofWorldRange: 150,
    dofWorldNear: 0,

    look: JSON.parse(JSON.stringify(g.look)),
    grade: JSON.parse(JSON.stringify(g.grade)),
  };
}

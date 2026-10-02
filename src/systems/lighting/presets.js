/**
 * Lighting presets (time of day / mood). Units: everything is expressed relative to the photographed sky
 * (sky median radiance == `intensity`), so sun/sky ratios stay physically consistent with the HDRI.
 *
 *  sky            baked sky asset in /assets/lighting/<sky>.jpg|json
 *  sunAzimuth     deg, 0 = towards -Z (map "north"), 90 = towards +X
 *  sunElevation   deg, world sun elevation (the photographed sun is warped to match)
 *  intensity      global radiance scale (sky median radiance)
 *  sunScale       multiplier on the measured sun/sky ratio
 *  sunTint        multiplied into the measured sun colour
 *  envScale       multiplier on the IBL (scene.environmentIntensity)
 *  haze           { density /m at base, falloff 1/m, base height, air /m, start (m, haze-free near field), colours, mie g, mie weight, maxOpacity }
 *  shadow         { penumbra cm, intensity }
 *  volumetric     { strength, maxDist, densityBoost }
 *  bounceFill     rgb fraction of open-sky irradiance kept under roofs (cheap bounce GI)
 *  ground / facade albedo for the environment's lower hemisphere & urban horizon occlusion
 */
export const PRESETS = {
  golden_hour: {
    sky: 'sky_golden_hour_3',
    sunAzimuth: 128,
    sunElevation: 19,
    intensity: 0.3,
    exposure: 0.95,
    sunScale: 2.1,
    skyBoost: 1.2,
    sunTint: [1.0, 1.0, 1.1],
    skySaturation: 1.45,
    envSaturation: 1.25,
    sunDisc: 320,
    aureole: { inner: 26, outer: 3.5, blur: 24, width: 0.028 },
    envScale: 0.55,
    envCap: 2.2, // x median sky radiance
    haze: {
      density: 0.0017, falloff: 1 / 38, base: 0, air: 0.00032, start: 22,
      hazeTint: [0.92, 0.97, 1.08], airTint: [0.55, 0.78, 1.3],
      ambientTint: [0.92, 0.97, 1.08], ambientScale: 1.0, skyHaze: 0.12, skySoftness: 1.0, sunFraction: 0.5,
      sunScatter: 0.11, mieG: 0.72, mieWeight: 0.7, maxOpacity: 0.97, horizonFlatten: 0.75, saturation: 1.3,
    },
    shadow: { penumbra: 2.2, intensity: 1.0 },
    volumetric: { strength: 1.0, maxDist: 60, densityBoost: 1.0 },
    dust: { density: 0.0006, height: 8, g: 0.62, scale: 1.0, shaftGain: 2, indoorShaftGain: 150, indoorBoost: 6 },
    groundAlbedo: [0.30, 0.27, 0.23],
    facadeAlbedo: [0.33, 0.29, 0.25],
    facadeSunFraction: 0.35,
    bounceFill: [0.24, 0.18, 0.13],
    horizonOcclusion: { elevation: 16, strength: 0.55 },
    smoke: 1.0,
  },
  overcast: {
    sky: 'sky_overcast',
    sunAzimuth: 128,
    sunElevation: 14,
    intensity: 0.28,
    exposure: 1.0,
    sunScale: 1.0,
    minSunRatio: 0.9, // overcast HDRI has almost no direct sun; keep a faint directional term for form
    sunTint: [0.95, 0.97, 1.0],
    sunDisc: 0,
    envScale: 1.0,
    haze: {
      density: 0.0038, falloff: 1 / 55, base: 0, air: 0.0006, start: 6,
      hazeTint: [1.0, 1.0, 1.02], airTint: [0.8, 0.9, 1.1],
      ambientTint: [1, 1, 1], ambientScale: 1.0, skyHaze: 0.3, skySoftness: 1.0, sunFraction: 0.5,
      sunScatter: 0.15, mieG: 0.5, mieWeight: 0.7, maxOpacity: 0.985,
    },
    shadow: { penumbra: 30, intensity: 0.75 },
    volumetric: { strength: 0.0, maxDist: 50, densityBoost: 1.0 },
    groundAlbedo: [0.26, 0.25, 0.24],
    facadeAlbedo: [0.28, 0.27, 0.26],
    facadeSunFraction: 0.0,
    bounceFill: [0.12, 0.12, 0.12],
    horizonOcclusion: { elevation: 14, strength: 0.45 },
    smoke: 0.8,
  },
  dusk: {
    sky: 'sky_dusk',
    sunAzimuth: 128,
    sunElevation: 4.5,
    intensity: 0.5,
    exposure: 1.15,
    sunScale: 1.6,
    sunTint: [1.0, 0.8, 0.6],
    sunDisc: 90,
    aureole: { inner: 14, outer: 3, blur: 24, width: 0.035 },
    envScale: 1.0,
    haze: {
      density: 0.003, falloff: 1 / 45, base: 0, air: 0.0005, start: 14,
      hazeTint: [0.95, 0.98, 1.05], airTint: [0.6, 0.8, 1.25],
      ambientTint: [1, 1, 1], ambientScale: 1.0, skyHaze: 0.3, skySoftness: 1.0, sunFraction: 0.5,
      sunScatter: 0.8, mieG: 0.7, mieWeight: 0.85, maxOpacity: 0.97,
    },
    shadow: { penumbra: 5, intensity: 1.0 },
    volumetric: { strength: 1.0, maxDist: 60, densityBoost: 1.0 },
    dust: { density: 0.0018, height: 10, g: 0.55, scale: 1.0, shaftGain: 3, indoorShaftGain: 80, indoorBoost: 5 },
    groundAlbedo: [0.28, 0.25, 0.22],
    facadeAlbedo: [0.3, 0.27, 0.24],
    facadeSunFraction: 0.2,
    bounceFill: [0.16, 0.12, 0.09],
    horizonOcclusion: { elevation: 12, strength: 0.5 },
    smoke: 1.0,
  },
};

export const PRESET_NAMES = Object.keys(PRESETS);

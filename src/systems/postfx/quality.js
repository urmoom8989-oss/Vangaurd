/**
 * Quality tiers. Every tier keeps the same LOOK (grade, tonemap, grain, vignette); tiers only trade
 * sample counts / optional passes. Default game setting is 'low' for high-refresh performance.
 */
export const QUALITY = {
  low: {
    aa: 'none', smaaPreset: 1,
    ao: false, aoSlices: 2, aoSteps: 4,
    bloom: false, bloomLevels: 3,
    rays: false, raySamples: 16,
    flare: false,
    dof: false, dofRings: 2,
    motionBlur: false,
    sharpen: 0.0,
  },
  medium: {
    aa: 'smaa', smaaPreset: 2,
    ao: true, aoSlices: 2, aoSteps: 5,
    bloom: true, bloomLevels: 6,
    rays: true, raySamples: 16,
    flare: true,
    dof: true, dofRings: 2,
    motionBlur: false,
    sharpen: 0.15,
  },
  high: {
    aa: 'taa', smaaPreset: 3,
    ao: true, aoSlices: 3, aoSteps: 6,
    bloom: true, bloomLevels: 6,
    rays: true, raySamples: 24,
    flare: true,
    dof: true, dofRings: 3,
    motionBlur: true,
    sharpen: 0.35,
  },
  ultra: {
    aa: 'taa', smaaPreset: 3,
    ao: true, aoSlices: 4, aoSteps: 8,
    bloom: true, bloomLevels: 7,
    rays: true, raySamples: 32,
    flare: true,
    dof: true, dofRings: 4,
    motionBlur: true,
    sharpen: 0.4,
  },
};

export const QUALITY_LEVELS = Object.keys(QUALITY);

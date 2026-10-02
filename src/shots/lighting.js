/**
 * Shot presets owned by the LIGHTING agent. Names start with "lighting-".
 */
import * as THREE from 'three';
import { buildLab } from '../systems/lighting/lab.js';
import { atmoData } from '../systems/lighting/chunks.js';

const ONLY = ['materials', 'lighting', 'world', 'postfx'];
const LAB = ['materials', 'lighting', 'postfx'];
const lab = (camera, extra = {}) => ({
  only: LAB,
  hud: false,
  warmup: 10,
  camera,
  async setup(ctx) {
    await ctx.services.materials.ready;
    buildLab(ctx);
    ctx.services.lighting.rebakeSkyVisibility?.({ center: new THREE.Vector2(0, -30), size: 300 });
  },
  ...extra,
});

const abSun = (patch) => ({
  description: 'A/B: street-sun with a lighting.tweak patch', only: ONLY, hud: false, warmup: 10,
  camera: { position: [-12, 1.7, -6], target: [60, 8, 30], hfov: 90 },
  async setup(ctx) { await ctx.services.lighting.ready; ctx.services.lighting.tweak?.(patch); },
});

// ---- perf variants (tools/perf.mjs lighting-perf[-noshadow|-novol|-nolighting])
const PERF_INPUT = [
  { frame: 0, move: [0, 1] }, { frame: 0, press: 'sprint' }, { frame: 90, release: 'sprint' },
  { frame: 90, move: [1, 0] }, { frame: 150, move: [0, -1] }, { frame: 210, move: [-1, 0] },
  { frame: 0, look: [30, 0] }, { frame: 60, look: [-60, 5] }, { frame: 120, look: [80, -5] },
  { frame: 180, look: [-50, 0] }, { frame: 240, press: 'fire' }, { frame: 260, release: 'fire' },
];
const perf = (settings = {}, extra = {}) => ({
  description: 'lighting perf variant of core-perf',
  player: { position: [0, null, 10], yaw: 0, pitch: 0 },
  input: PERF_INPUT, inputLoop: 280, warmup: 30, settings, ...extra,
});
export const PERF_PRESETS = {
  'lighting-perf': perf(),
  'lighting-perf-noshadow': perf({ graphics: { shadows: false } }),
  'lighting-perf-novol': perf({ lighting: { volumetrics: false } }),
  'lighting-perf-low': perf({ graphics: { quality: 'low' } }),
};

export default {
  ...PERF_PRESETS,
  'lighting-dbg-nobloom': { description: 'debug: cand-a without bloom', only: ONLY, hud: false, warmup: 30, camera: { position: [26, 1.7, -4], target: [60, 5, 14], hfov: 85 }, onFrame(ctx) { ctx.services.postfx.setEffect?.('bloom', false); } },
  'lighting-dbg-nofog': { description: 'debug: cand-a without bloom and atmosphere', only: ONLY, hud: false, warmup: 30, camera: { position: [26, 1.7, -4], target: [60, 5, 14], hfov: 85 }, onFrame(ctx) { ctx.services.postfx.setEffect?.('bloom', false); atmoData[3] = 0; atmoData[91] = 0; if (ctx.scene.fog) { ctx.scene.fog.near = 1e5; ctx.scene.fog.far = 2e5; } } },
  'lighting-dbg-sun-nodust': { description: 'debug: street-sun without dust in-scatter', only: ONLY, hud: false, warmup: 10, camera: { position: [-12, 1.7, -6], target: [60, 8, 30], hfov: 90 }, onFrame() { atmoData[91] = 0; } },
  'lighting-dbg-sun-nobloom': { description: 'debug: street-sun without bloom', only: ONLY, hud: false, warmup: 10, camera: { position: [-12, 1.7, -6], target: [60, 8, 30], hfov: 90 }, onFrame(ctx) { ctx.services.postfx.setEffect?.('bloom', false); } },
  'lighting-dbg-sun-nofog': { description: 'debug: street-sun without atmosphere', only: ONLY, hud: false, warmup: 10, camera: { position: [-12, 1.7, -6], target: [60, 8, 30], hfov: 90 }, onFrame() { atmoData[3] = 0; atmoData[91] = 0; } },
  // A/B tuning variants (lighting.tweak)
  'lighting-ab-sun-a': abSun({ haze: { mieG: 0.8, mieWeight: 0.6, sunScatter: 0.07, density: 0.0012 } }),
  'lighting-ab-sun-b': abSun({ haze: { mieG: 0.8, mieWeight: 0.6, sunScatter: 0.07, density: 0.0012 }, dust: { density: 0.0 } }),
  'lighting-ab-sun-c': abSun({ haze: { mieG: 0.8, mieWeight: 0.6, sunScatter: 0.07, density: 0.0012 }, aureole: { outer: 1.5, blur: 16 }, envScale: 0.4 }),
  'lighting-ab-alley-dust': { ...abSun({ dust: { density: 0.004 } }), camera: { position: [-38.5, 1.7, 23.5], target: [-33, 2.4, 52], hfov: 85 } },
  'lighting-ab-interior-dust': { ...abSun({ dust: { density: 0.05 } }), camera: { position: [-12, 1.6, 50], target: [-5, 1.6, 42], hfov: 85 } },
  'lighting-ab-alley-dust2': { ...abSun({ dust: { density: 0.05 } }), camera: { position: [-38.5, 1.7, 23.5], target: [-33, 2.4, 52], hfov: 85 } },
  'lighting-cand-a': { description: 'cand', only: ONLY, hud: false, warmup: 30, camera: { position: [26, 1.7, -4], target: [60, 5, 14], hfov: 85 } },
  'lighting-hall-shafts': { description: 'Dark ground-floor hallway with a sun beam through a doorway (bounce fill + indoor dust).', only: ONLY, hud: false, warmup: 10, camera: { position: [-20, 1.7, -30], target: [5, 4, -12], hfov: 85 } },
  'lighting-interior-shafts': { description: 'Inside a ground-floor shop (SW1) toward the sunlit windows: dust shafts, sun patches, dark interior.', only: ONLY, hud: false, warmup: 30, camera: { position: [-12, 1.6, 50], target: [-5, 1.6, 42], hfov: 85 } },
  'lighting-cand-c': { description: 'cand', only: ONLY, hud: false, warmup: 30, camera: { position: [-38.5, 1.7, 20], target: [-35, 2.5, 45], hfov: 85 } },

  'lighting-dbg-ridge': { description: 'debug: ridge black', only: ONLY, hud: false, warmup: 10, camera: { position: [0, 14, 30], target: [-16, 110, -440], hfov: 55 },
    onFrame(ctx) { const r = ctx.scene.getObjectByName('lighting.skyline.ridge'); if (r) { r.material.vertexColors = false; r.material.color.set(0); r.material.envMapIntensity = 0; r.material.needsUpdate = true; } } },

  'lighting-smoke': { description: 'Distant smoke column close view (north, 470 m).', only: ONLY, hud: false, warmup: 10, camera: { position: [0, 14, 30], target: [-16, 110, -440], hfov: 55 } },
  'lighting-smoke-sun': { description: 'Smoke column toward the sun (backlit).', only: ONLY, hud: false, warmup: 10, camera: { position: [0, 14, 0], target: [608, 90, 197], hfov: 55 } },

  // ---- sky-only debug views
  'lighting-sky-sun': { description: 'Sky only, toward the sun.', only: ['lighting', 'postfx'], hud: false, warmup: 4, camera: { position: [0, 1.7, 0], target: [79, 22, 62], hfov: 100 } },
  'lighting-sky-away': { description: 'Sky only, away from the sun.', only: ['lighting', 'postfx'], hud: false, warmup: 4, camera: { position: [0, 1.7, 0], target: [-79, 20, -62], hfov: 100 } },
  'lighting-sky-side': { description: 'Sky only, 90 deg from the sun.', only: ['lighting', 'postfx'], hud: false, warmup: 4, camera: { position: [0, 1.7, 0], target: [-62, 20, 79], hfov: 100 } },

  'lighting-street-wide': {
    description: 'Main street looking north to the plaza: golden-hour sun behind-right, long shadows, aerial perspective, sky.',
    only: ONLY,
    hud: false,
    camera: { position: [2.2, 1.7, 62], target: [-1.5, 4, 10], hfov: 90 },
    warmup: 10,
  },
  'lighting-street-sun': {
    description: 'East road looking toward the low sun: backlit haze, sun glow in the fog, rim light, shadows toward camera.',
    only: ONLY,
    hud: false,
    camera: { position: [-12, 1.7, -6], target: [60, 8, 30], hfov: 90 },
    warmup: 10,
  },
  'lighting-alley-shafts': {
    description: 'South-west backyard alley toward the sun: a shaft through the gap between houses, cool shadowed alley.',
    only: ONLY,
    hud: false,
    camera: { position: [-45, 1.7, 30], target: [-25, 4.5, 45], hfov: 85 },
    warmup: 10,
  },
  'lighting-skyline': {
    description: 'Elevated view over the plaza toward the north horizon: skyline, smoke columns, haze layering.',
    only: ONLY,
    hud: false,
    camera: { position: [0, 14, 36], target: [0, 8, -60], hfov: 80 },
    warmup: 10,
  },
  'lighting-skyline-sun': {
    description: 'Elevated view toward the sun: backlit skyline silhouettes, smoke, sun glow.',
    only: ONLY,
    hud: false,
    camera: { position: [-20, 16, -20], target: [60, 12, 40], hfov: 80 },
    warmup: 10,
  },
  'lighting-shadow-closeup': {
    description: 'Close-up of contact shadows on props: cascade 0 resolution, penumbra, acne/peter-panning.',
    only: ONLY,
    hud: false,
    camera: { position: [-1.5, 1.5, -2.5], target: [-4.5, 0.4, -6.5], hfov: 70 },
    warmup: 10,
  },
  'lighting-overcast': {
    description: 'Street-wide under the overcast preset.',
    only: ONLY, hud: false, warmup: 10,
    settings: { lighting: { preset: 'overcast' } },
    camera: { position: [2.2, 1.7, 62], target: [-1.5, 4, 10], hfov: 90 },
  },
  'lighting-dusk': {
    description: 'Street toward the sun under the dusk preset.',
    only: ONLY, hud: false, warmup: 10,
    settings: { lighting: { preset: 'dusk' } },
    camera: { position: [-12, 1.7, -6], target: [60, 8, 30], hfov: 90 },
  },

  // ---- lab variants (self-contained test block, independent of the world system)
  'lighting-lab-street': lab({ position: [0, 1.7, 22], target: [-1, 3, -20], hfov: 90 }, { description: 'Lab street, golden hour.' }),
  'lighting-lab-sun': lab({ position: [-4, 1.7, -30], target: [30, 8, 0], hfov: 90 }, { description: 'Lab: looking toward the sun.' }),
  'lighting-lab-alley': lab({ position: [9, 1.6, -20], target: [40, 3.5, -16], hfov: 85 }, { description: 'Lab alley toward the sun: shafts.' }),
  'lighting-lab-props': lab({ position: [-1.2, 1.6, -1.8], target: [-4.5, 0.5, -6.5], hfov: 70 }, { description: 'Lab props: contact shadows close up.' }),
  'lighting-lab-high': lab({ position: [0, 16, 40], target: [0, 6, -80], hfov: 80 }, { description: 'Lab elevated: skyline & haze.' }),
  'lighting-lab-smoke': lab({ position: [0, 6, 20], target: [400, 120, -37], hfov: 70 }, { description: 'Lab: distant smoke column + skyline + ridge.' }),
  'lighting-lab-away': lab({ position: [2, 1.7, -60], target: [-10, 3, 20], hfov: 90 }, { description: 'Lab: looking away from the sun (cool shadow side).' }),
};

import * as THREE from 'three';

/**
 * Weapon/arms materials. All are MeshStandard/MeshPhysical materials extended via onBeforeCompile with:
 *  - triplanar sampling (object space; bind pose for skinned meshes) of tileable grunge/detail maps,
 *    so procedural geometry needs no UVs and never shows stretching/seams;
 *  - curvature-based edge wear: curvature = |fwidth(N_obj)| / |fwidth(P_obj)| (1/m). Bevels (radius few mm)
 *    light up, large flat faces (weighted normals) stay clean -> anodizing worn off only on real edges;
 *  - fingerprint / smudge roughness variation, scratches, dust on up-facing surfaces;
 *  - derivative-based micro bump (stipple, weave, leather grain) without tangents.
 */

const COMMON_PARS = /* glsl */`
varying vec3 vObjPos;
varying vec3 vObjN;
uniform sampler2D uGrunge;
uniform sampler2D uDetail;
uniform float uTriScale;
uniform float uDetScale;
uniform vec3 uWearColor;
uniform float uWear;
uniform float uWearMetal;
uniform float uWearRough;
uniform float uRoughVar;
uniform float uSmudge;
uniform float uScratch;
uniform float uDust;
uniform vec3 uDustColor;
uniform float uColorVar;
uniform vec3 uDetMix;      // weights of detail R (weave), G (grain), B (stipple) in the bump height
uniform float uBump;       // bump strength (meters of height)
uniform float uCurvLo;
uniform float uCurvHi;
vec3 wpnTriW(vec3 n) { vec3 w = pow(abs(n), vec3(4.0)); return w / (w.x + w.y + w.z + 1e-5); }
vec3 wpnTri(sampler2D t, vec3 p, vec3 w) {
  return texture2D(t, p.zy).rgb * w.x + texture2D(t, p.xz).rgb * w.y + texture2D(t, p.xy).rgb * w.z;
}
vec3 wpnBump(vec3 surf_pos, vec3 surf_norm, float h, float fd) {
  vec3 sx = dFdx(surf_pos); vec3 sy = dFdy(surf_pos);
  vec3 r1 = cross(sy, surf_norm); vec3 r2 = cross(surf_norm, sx);
  float det = dot(sx, r1) * fd;
  vec2 dh = vec2(dFdx(h), dFdy(h));
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * surf_norm - grad);
}
`;

function inject(material, uniforms, { extraVertPars = '', extraVert = '', extraFragPars = '', colorCode = '', roughCode = '', metalCode = '', normalCode = '', emissiveCode = '', defines = {} } = {}) {
  material.userData.wpnUniforms = uniforms;
  material.defines = Object.assign(material.defines || {}, defines);
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjN;\n${extraVertPars}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvObjPos = position;\nvObjN = normal;\n${extraVert}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${COMMON_PARS}\n${extraFragPars}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 wN = normalize(vObjN);
        vec3 tw = wpnTriW(wN);
        vec3 tp = vObjPos * uTriScale;
        vec3 G = wpnTri(uGrunge, tp, tw);
        vec3 G2 = wpnTri(uGrunge, tp * 3.7 + 0.31, tw);
        float curv = length(fwidth(vObjN)) / max(length(fwidth(vObjPos)), 1e-6);
        float edge = smoothstep(uCurvLo, uCurvHi, curv);
        float breakup = G.r * 0.6 + G2.r * 0.55 + G2.g * 0.4;
        float wear = clamp(edge * smoothstep(0.58, 0.86, breakup) * 1.3 + smoothstep(0.45, 0.98, G2.g) * uScratch * 0.8, 0.0, 1.0) * uWear;
        float dust = uDust * smoothstep(0.25, 0.9, wN.y) * smoothstep(0.45, 0.75, G.r + G2.r * 0.3) ;
        diffuseColor.rgb *= 1.0 + (G.r - 0.5) * uColorVar + (G2.r - 0.5) * uColorVar * 0.6;
        ${colorCode}
        diffuseColor.rgb = mix(diffuseColor.rgb, uWearColor, wear);
        diffuseColor.rgb = mix(diffuseColor.rgb, uDustColor, dust * 0.55);
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor *= 1.0 + (G.r - 0.5) * uRoughVar + (G2.r - 0.5) * uRoughVar * 0.5;
        roughnessFactor -= G.b * uSmudge;
        roughnessFactor = mix(roughnessFactor, uWearRough, wear);
        roughnessFactor = mix(roughnessFactor, 0.95, dust * 0.6);
        ${roughCode}
        roughnessFactor = clamp(roughnessFactor, 0.04, 1.0);
      `)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, uWearMetal, wear);
        metalnessFactor *= 1.0 - dust * 0.8;
        ${metalCode}
      `)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 D = wpnTri(uDetail, vObjPos * uDetScale, tw);
          float h = dot(D, uDetMix) + (G2.r - 0.5) * 0.15 - G2.g * 0.35 * uScratch;
          ${normalCode}
          normal = wpnBump(-vViewPosition, normal, h * uBump, faceDirection);
        }
      `)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${emissiveCode}`);
  };
  material.customProgramCacheKey = () => `wpn:${material.name}:${JSON.stringify(material.defines)}`;
  return material;
}

function col(hex) { return new THREE.Color(hex); }

/**
 * Create the full material set. tex: { grunge, detail, multicam } (Textures, RepeatWrapping).
 * Returns { key: Material } plus a dispose() helper.
 */
export function createMaterials(tex, services) {
  const mats = {};
  const baseU = () => ({
    uGrunge: { value: tex.grunge },
    uDetail: { value: tex.detail },
    uTriScale: { value: 3.0 },
    uDetScale: { value: 12.0 },
    uWearColor: { value: col(0x9a9a98) },
    uWear: { value: 1.0 },
    uWearMetal: { value: 1.0 },
    uWearRough: { value: 0.32 },
    uRoughVar: { value: 0.35 },
    uSmudge: { value: 0.18 },
    uScratch: { value: 0.35 },
    uDust: { value: 0.35 },
    uDustColor: { value: col(0x7d705c) },
    uColorVar: { value: 0.25 },
    uDetMix: { value: new THREE.Vector3(0, 0, 0) },
    uBump: { value: 0.0 },
    uCurvLo: { value: 180 },
    uCurvHi: { value: 700 },
  });
  const gun = (name, params, uni = {}, code = {}) => {
    const m = new THREE.MeshStandardMaterial(params);
    m.name = name;
    const u = baseU();
    for (const k of Object.keys(uni)) {
      if (u[k].value?.isColor) u[k].value = col(uni[k]);
      else if (u[k].value?.isVector3) u[k].value = new THREE.Vector3(...uni[k]);
      else u[k].value = uni[k];
    }
    inject(m, u, code);
    mats[name] = m;
    return m;
  };

  // Black hard-anodized 7075 aluminium: receiver, handguard, rail, sight body.
  gun('anod', { color: 0x2a2b2e, metalness: 0.55, roughness: 0.46, envMapIntensity: 1.2 }, {
    uWearColor: 0x8e8e8b, uWearRough: 0.3, uScratch: 0.22, uSmudge: 0.16, uRoughVar: 0.4, uColorVar: 0.18, uDust: 0.4,
    uDetMix: [0, 0.4, 0], uBump: 0.00006, uTriScale: 2.2, uDetScale: 20,
  });
  mats.anod.userData.surface = 'metal';
  // Nitride / parkerized steel: barrel, muzzle device, pins, bolt carrier.
  gun('steel', { color: 0x252525, metalness: 0.8, roughness: 0.5, envMapIntensity: 1.2 }, {
    uWearColor: 0x8d8a86, uWearRough: 0.25, uScratch: 0.2, uSmudge: 0.14, uRoughVar: 0.45, uColorVar: 0.22,
    uDetMix: [0, 0.6, 0], uBump: 0.00005, uTriScale: 3.0, uDetScale: 26,
  });
  // Bare / polished steel parts (bolt face, springs, fire-control pins show through)
  gun('bright', { color: 0x8c8c8a, metalness: 1.0, roughness: 0.28, envMapIntensity: 1.3 }, {
    uWear: 0, uSmudge: 0.08, uRoughVar: 0.5, uColorVar: 0.3,
  });
  // Glass-filled polymer, coyote/FDE: stock, pistol grip, vertical grip.
  gun('polyTan', { color: 0x6a5a45, metalness: 0.0, roughness: 0.62 }, {
    uWearColor: 0x8a7a62, uWearMetal: 0.0, uWearRough: 0.5, uScratch: 0.1, uSmudge: 0.2, uColorVar: 0.14, uDust: 0.35,
    uDetMix: [0, 0.3, 0.0], uBump: 0.00008, uTriScale: 2.5, uDetScale: 22, uCurvLo: 150, uCurvHi: 600,
  });
  // Stippled polymer (grip panels)
  gun('polyTanStip', { color: 0x66573f, metalness: 0.0, roughness: 0.72 }, {
    uWearColor: 0x857559, uWearMetal: 0.0, uWearRough: 0.55, uScratch: 0.05, uSmudge: 0.15, uColorVar: 0.14,
    uDetMix: [0, 0.2, 1.0], uBump: 0.0005, uTriScale: 2.5, uDetScale: 55, uCurvLo: 150, uCurvHi: 600,
  });
  // Black polymer: magazine, butt pad frame, buttons
  gun('polyBlack', { color: 0x1d1e1f, metalness: 0.0, roughness: 0.58 }, {
    uWearColor: 0x3c3d3e, uWearMetal: 0.0, uWearRough: 0.42, uScratch: 0.15, uSmudge: 0.18, uColorVar: 0.2, uDust: 0.45,
    uDetMix: [0, 0.35, 0], uBump: 0.00008, uTriScale: 2.5, uDetScale: 24, uCurvLo: 150, uCurvHi: 600,
  });
  gun('polyBlackStip', { color: 0x1c1d1e, metalness: 0.0, roughness: 0.7 }, {
    uWearColor: 0x333436, uWearMetal: 0.0, uWearRough: 0.5, uScratch: 0.05, uSmudge: 0.12, uColorVar: 0.15,
    uDetMix: [0, 0.2, 1.0], uBump: 0.00045, uTriScale: 2.5, uDetScale: 60, uCurvLo: 150, uCurvHi: 600,
  });
  gun('rubber', { color: 0x161616, metalness: 0.0, roughness: 0.85 }, {
    uWear: 0.3, uWearColor: 0x2a2a2a, uWearMetal: 0, uWearRough: 0.8, uScratch: 0, uSmudge: 0.1, uColorVar: 0.15,
    uDetMix: [0, 0.8, 0.2], uBump: 0.0002, uDetScale: 40,
  });
  gun('brass', { color: 0xb88a45, metalness: 1.0, roughness: 0.3, envMapIntensity: 1.3 }, {
    uWear: 0.2, uWearColor: 0xd9b36a, uWearRough: 0.2, uScratch: 0.1, uSmudge: 0.15, uColorVar: 0.3, uRoughVar: 0.6, uDust: 0.1,
  });
  gun('copper', { color: 0xb06a45, metalness: 1.0, roughness: 0.33 }, {
    uWear: 0.1, uWearColor: 0xd08a60, uScratch: 0.05, uColorVar: 0.3, uDust: 0.1,
  });
  // Dark interior cavities (slots, ports, bores, magwell opening)
  const cav = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9, metalness: 0.2 });
  cav.name = 'cavity';
  mats.cavity = cav;

  // Holographic sight glass with parallax-free (infinity projected) reticle.
  mats.glass = createHoloGlass();

  // Rubber button / small red detail
  gun('paintOD', { color: 0x4b4d36, metalness: 0.1, roughness: 0.62 }, { uWearColor: 0x6d6a62, uWearMetal: 0.9, uWearRough: 0.35, uScratch: 0.3, uSmudge: 0.15, uColorVar: 0.2 });
  gun('paintYellow', { color: 0xa88a28, metalness: 0.0, roughness: 0.6 }, { uWear: 0.5, uWearColor: 0x555555, uWearMetal: 0.5 });
  gun('paintRed', { color: 0x7a1510, metalness: 0.0, roughness: 0.55 }, { uWear: 0.6, uWearColor: 0x333333, uWearMetal: 0.5 });
  gun('paintWhite', { color: 0xb8b4a8, metalness: 0.0, roughness: 0.6 }, { uWear: 0.6, uWearColor: 0x333333, uWearMetal: 0.5, uScratch: 0.3 });

  // ------------------------------------------------------------------------------ arms
  const fabricPars = /* glsl */`
    attribute vec4 aMask;
  `;
  // Multicam sleeves: albedo from camo map (sRGB) via triplanar in bind-pose space; twill weave bump.
  const sleeve = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, sheen: 0.6, sheenRoughness: 0.7, sheenColor: new THREE.Color(0x8a8068) });
  sleeve.name = 'sleeve';
  const su = baseU();
  su.uWear.value = 0; su.uSmudge.value = 0; su.uScratch.value = 0; su.uColorVar.value = 0.3; su.uRoughVar.value = 0.1;
  su.uDust.value = 0.25; su.uDustColor.value = col(0x9a8a70);
  su.uDetMix.value.set(1, 0, 0); su.uBump.value = 0.00035; su.uDetScale.value = 9; su.uTriScale.value = 2;
  su.uCamo = { value: tex.multicam };
  su.uCamoScale = { value: 3.2 };
  inject(sleeve, su, {
    extraVertPars: 'attribute vec4 aMask; varying vec4 vMask;',
    extraVert: 'vMask = aMask;',
    extraFragPars: 'uniform sampler2D uCamo; uniform float uCamoScale; varying vec4 vMask;',
    colorCode: `
      vec3 camo = wpnTri(uCamo, vObjPos * uCamoScale, tw);
      diffuseColor.rgb *= camo; // map is sRGB-decoded by the sampler
      diffuseColor.rgb *= 1.0 - vMask.x * 0.45; // fold shading (cavity darkening from wrinkle mask)
    `,
    normalCode: 'h += vMask.y * 0.8;',
  });
  mats.sleeve = sleeve;

  // Glove shell: synthetic coyote fabric, leather palm/fingertips selected by aMask.z, rubber-ish by aMask.w
  const glove = new THREE.MeshPhysicalMaterial({ color: 0x6b5a44, roughness: 0.82, metalness: 0, sheen: 0.4, sheenRoughness: 0.6, sheenColor: new THREE.Color(0x6e604c) });
  glove.name = 'glove';
  const gu = baseU();
  gu.uWear.value = 0.35; gu.uWearColor.value = col(0x8a7760); gu.uWearMetal.value = 0; gu.uWearRough.value = 0.9;
  gu.uScratch.value = 0; gu.uSmudge.value = 0.05; gu.uColorVar.value = 0.25; gu.uRoughVar.value = 0.15;
  gu.uDust.value = 0.3; gu.uDustColor.value = col(0x8f806a);
  gu.uDetMix.value.set(0.7, 0.0, 0); gu.uBump.value = 0.00022; gu.uDetScale.value = 16; gu.uTriScale.value = 3; gu.uCurvLo.value = 250; gu.uCurvHi.value = 900;
  gu.uLeather = { value: col(0x3e342a) };
  inject(glove, gu, {
    extraVertPars: 'attribute vec4 aMask; varying vec4 vMask;',
    extraVert: 'vMask = aMask;',
    extraFragPars: 'uniform vec3 uLeather; varying vec4 vMask;',
    colorCode: `
      float lth = smoothstep(0.4, 0.6, vMask.z);
      diffuseColor.rgb = mix(diffuseColor.rgb, uLeather * (0.85 + G.r * 0.3), lth);
      diffuseColor.rgb *= 1.0 - vMask.x * 0.35;
    `,
    roughCode: 'roughnessFactor = mix(roughnessFactor, 0.62 - G.b * 0.1, smoothstep(0.4, 0.6, vMask.z));',
    normalCode: `
      float lthN = smoothstep(0.4, 0.6, vMask.z);
      h = mix(h, D.g * 0.9, lthN) + vMask.y * 0.6;
      // stitch line along the leather border
      h -= (1.0 - smoothstep(0.0, 0.08, abs(vMask.z - 0.5))) * 0.6;
    `,
  });
  mats.glove = glove;

  // TPR knuckle armour / rubber pads
  gun('tpr', { color: 0x262522, metalness: 0.0, roughness: 0.62 }, {
    uWear: 0.5, uWearColor: 0x4a4740, uWearMetal: 0, uWearRough: 0.75, uScratch: 0.1, uSmudge: 0.1, uColorVar: 0.2, uDust: 0.35,
    uDetMix: [0, 0.6, 0.2], uBump: 0.00012, uDetScale: 30,
  });
  // Nylon webbing (watch strap, velcro tabs)
  gun('webbing', { color: 0x3f3a2e, metalness: 0.0, roughness: 0.9 }, {
    uWear: 0.2, uWearColor: 0x5a5244, uWearMetal: 0, uWearRough: 0.9, uScratch: 0, uSmudge: 0, uColorVar: 0.2,
    uDetMix: [1.0, 0, 0], uBump: 0.00025, uDetScale: 24,
  });
  gun('watchCase', { color: 0x1b1c1d, metalness: 0.2, roughness: 0.45 }, {
    uWearColor: 0x5a5a5a, uWearMetal: 0.8, uScratch: 0.3, uSmudge: 0.2,
  });
  // Watch dial: dark with lume markers (emissive)
  const dial = new THREE.MeshStandardMaterial({ color: 0x0c0d0d, roughness: 0.35, metalness: 0.1, emissive: 0x9fe8a0, emissiveIntensity: 0.0 });
  dial.name = 'watchDial';
  mats.watchDial = dial;
  const lume = new THREE.MeshStandardMaterial({ color: 0xcfe8c8, roughness: 0.5, metalness: 0, emissive: 0x7cf08a, emissiveIntensity: 0.35 });
  lume.name = 'lume';
  mats.lume = lume;
  const crystal = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.03, metalness: 0, transparent: true, opacity: 0.18, depthWrite: false, envMapIntensity: 1.6 });
  crystal.name = 'crystal';
  mats.crystal = crystal;

  for (const m of Object.values(mats)) if (!m.userData.surface) m.userData.surface = 'metal';
  mats.default = mats.anod;
  return mats;
}

/**
 * Holographic sight window: faint coated glass + a reticle projected at infinity.
 * Uniforms uAxis/uRight/uUp are view-space basis vectors of the sight (set per frame by the system), so the
 * reticle lands exactly where the bore/sight axis points at infinity, independent of eye position (no parallax).
 */
export function createHoloGlass() {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0x9fb4c0, roughness: 0.04, metalness: 0.0, transparent: true, opacity: 0.12, depthWrite: false,
    envMapIntensity: 1.8, side: THREE.DoubleSide, iridescence: 0.35, iridescenceIOR: 1.6, iridescenceThicknessRange: [220, 420],
  });
  m.name = 'holoGlass';
  const u = {
    uAxis: { value: new THREE.Vector3(0, 0, -1) },
    uRight: { value: new THREE.Vector3(1, 0, 0) },
    uUp: { value: new THREE.Vector3(0, 1, 0) },
    uReticleColor: { value: new THREE.Color(1.0, 0.12, 0.06) },
    uReticleIntensity: { value: 6.0 },
    uReticleOn: { value: 1.0 },
  };
  m.userData.wpnUniforms = u;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uAxis; uniform vec3 uRight; uniform vec3 uUp; uniform vec3 uReticleColor; uniform float uReticleIntensity; uniform float uReticleOn;
        float ringMask(float r, float R, float w, float px) { return 1.0 - smoothstep(w * 0.5 - px, w * 0.5 + px, abs(r - R)); }
      `)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        {
          vec3 d = normalize(-vViewPosition);
          float fz = dot(d, uAxis);
          vec2 a = vec2(dot(d, uRight), dot(d, uUp)) / max(fz, 1e-3); // tangent of angle
          // angles in milliradians
          vec2 m = a * 1000.0;
          float px = max(fwidth(m.x), fwidth(m.y)) * 0.75;
          float r = length(m);
          float ret = 0.0;
          ret = max(ret, 1.0 - smoothstep(0.55 - px, 0.55 + px, r));                   // centre dot (game-readable, ~2 MOA)
          ret = max(ret, ringMask(r, 13.0, 0.8, px));                                  // ring (exaggerated vs real 65 MOA for readability)
          // four short ticks on the ring (N/E/S/W)
          float tick = 0.0;
          tick = max(tick, (1.0 - smoothstep(0.38 - px, 0.38 + px, abs(m.x))) * step(13.0, abs(m.y)) * step(abs(m.y), 16.5));
          tick = max(tick, (1.0 - smoothstep(0.38 - px, 0.38 + px, abs(m.y))) * step(13.0, abs(m.x)) * step(abs(m.x), 16.5) * step(0.0, 1.0));
          ret = max(ret, tick);
          ret *= uReticleOn * step(0.0, fz);
          // soft holographic bloom halo + speckle-free
          float halo = (exp(-r * r / 3.0) * 0.10 + exp(-(r - 13.0) * (r - 13.0) / 2.0) * 0.05) * uReticleOn;
          vec3 rc = uReticleColor * uReticleIntensity;
          // Controlled coated-glass look (the stock PBR output + env at grazing angles blew the pane out to an
          // opaque pale grey): faint blue-green AR-coating tint, Fresnel sheen toward the edges, a soft diagonal
          // sky streak, and a subtle amber/magenta coating shift. Mostly see-through at normal incidence.
          vec3 nG = normalize(vNormal);
          float ndv = abs(dot(nG, d));
          float fres = pow(1.0 - ndv, 4.0);
          vec2 uvG = vec2(dot(d, uRight), dot(d, uUp)) / max(abs(fz), 1e-3);
          float streak = smoothstep(0.10, 0.0, abs(uvG.x * 0.8 + uvG.y - 0.05)) * 0.35;
          vec3 coat = mix(vec3(0.05, 0.09, 0.085), vec3(0.20, 0.10, 0.16), clamp(fres * 2.0, 0.0, 1.0));
          vec3 gcol = coat + vec3(0.55, 0.62, 0.66) * (fres * 0.9 + streak * 0.25);
          float ga = clamp(0.07 + fres * 0.55 + streak * 0.08, 0.0, 0.8);
          gl_FragColor = vec4(gcol * (1.0 - ret) + rc * (ret + halo), max(ga, clamp(ret + halo, 0.0, 1.0)));
        }
      `);
  };
  m.customProgramCacheKey = () => 'wpn:holoGlass';
  return m;
}

export function disposeMaterials(mats) {
  const seen = new Set();
  for (const m of Object.values(mats)) {
    if (!m || seen.has(m) || !m.isMaterial) continue;
    seen.add(m);
    m.dispose();
  }
}

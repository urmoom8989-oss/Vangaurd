import * as THREE from 'three';
import { M, MAT_COUNT, LAYER, LAYER_COUNT } from './ids.js';

/**
 * Soldier material: MeshStandardMaterial patched so ONE material renders every part of the soldier.
 * Per-vertex aData.x selects a palette entry (albedo, roughness, metalness, detail layer, tiling,
 * normal strength); a procedural DataArrayTexture provides tiling micro detail (ripstop twill,
 * cordura with MOLLE webbing, knit, leather grain, tread, pores, stipple): RG = normal, B = albedo
 * modulation, A = roughness modulation. aData.y = baked AO, aData.z = dirt, aData.w = edge wear.
 */

const SIZE = 256;

// ------------------------------------------------------------------ tileable noise helpers
function hash2(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function tnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const m = (a) => ((a % period) + period) % period;
  const a = hash2(m(xi), m(yi), seed), b = hash2(m(xi + 1), m(yi), seed);
  const c = hash2(m(xi), m(yi + 1), seed), d = hash2(m(xi + 1), m(yi + 1), seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
/** fbm over [0,1)^2 tile, base frequency f (integer), octaves */
function tfbm(x, y, f, oct, seed) {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * tnoise(x * f, y * f, f, seed + i * 17);
    n += a; a *= 0.5; f *= 2;
  }
  return s / n;
}
/** tileable cellular (F1) noise with n cells per tile */
function tcell(x, y, n, seed) {
  const X = x * n, Y = y * n;
  const xi = Math.floor(X), yi = Math.floor(Y);
  let best = 9, best2 = 9;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = xi + i, cy = yi + j;
    const mx = ((cx % n) + n) % n, my = ((cy % n) + n) % n;
    const px = cx + hash2(mx, my, seed), py = cy + hash2(mx, my, seed + 7);
    const d = Math.hypot(px - X, py - Y);
    if (d < best) { best2 = best; best = d; } else if (d < best2) best2 = d;
  }
  return [best, best2];
}
const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ layer definitions: (u,v) -> [height, albedoMod, roughMod]
const LAYERS = [];
LAYERS[LAYER.TWILL] = (u, v) => {
  // ripstop grid (8 per tile) over fine diagonal twill + slubs
  const gx = Math.abs(((u * 8) % 1) - 0.5), gy = Math.abs(((v * 8) % 1) - 0.5);
  const grid = Math.max(sstep(0.44, 0.49, gx), sstep(0.44, 0.49, gy));
  const tw = 0.5 + 0.5 * Math.sin((u + v) * 2 * Math.PI * 48);
  const slub = tfbm(u, v, 8, 3, 11);
  const h = 0.22 * tw + 0.12 * grid + 0.3 * slub;
  const alb = 0.5 + 0.08 * (slub - 0.5) * 2 + 0.015 * grid - 0.015 * tw + 0.05 * (tfbm(u, v, 4, 2, 5) - 0.5);
  return [h, alb, 0.5 + 0.1 * (slub - 0.5)];
};
LAYERS[LAYER.CORDURA] = (u, v) => {
  // 1000D nylon basket weave + MOLLE webbing rows (2 rows per tile, bartacks)
  const wx = Math.sin(u * 2 * Math.PI * 40), wy = Math.sin(v * 2 * Math.PI * 40);
  const weave = 0.5 + 0.25 * (wx * (wy > 0 ? 1 : -1));
  const rv = (v * 2) % 1; // row phase
  const strip = sstep(0.12, 0.16, rv) * sstep(0.8, 0.76, rv); // webbing band
  const edge = Math.abs(rv - 0.14) < 0.02 || Math.abs(rv - 0.78) < 0.02 ? 1 : 0;
  const tack = strip * sstep(0.47, 0.49, Math.abs(((u * 2) % 1) - 0.5)); // gaps between channels
  const rib = strip * (0.5 + 0.5 * Math.sin(v * 2 * Math.PI * 70));
  const n = tfbm(u, v, 8, 3, 23);
  const h = 0.18 * weave + 0.4 * strip - 0.14 * tack + 0.06 * rib + 0.25 * n - 0.06 * edge;
  const alb = 0.5 + 0.05 * (n - 0.5) * 2 - 0.08 * tack + 0.03 * strip + 0.03 * (weave - 0.5);
  return [h, alb, 0.5 - 0.06 * strip + 0.1 * (n - 0.5)];
};
LAYERS[LAYER.WEBBING] = (u, v) => {
  const rib = 0.5 + 0.5 * Math.sin(u * 2 * Math.PI * 24);
  const x = 0.5 + 0.5 * Math.sin(v * 2 * Math.PI * 64);
  const n = tfbm(u, v, 8, 2, 31);
  return [0.6 * rib + 0.2 * x + 0.2 * n, 0.5 + 0.06 * (rib - 0.5) + 0.05 * (n - 0.5), 0.5];
};
LAYERS[LAYER.KNIT] = (u, v) => {
  // stockinette: columns of V-shaped loops
  const cols = 14, rows = 18;
  const cu = u * cols, cv = v * rows;
  const fu = cu - Math.floor(cu) - 0.5, fv = cv - Math.floor(cv) - 0.5;
  const side = fu < 0 ? -1 : 1;
  const lx = Math.abs(fu) - 0.25, ly = fv - side * 0.0;
  const tilt = lx * 0.8 + ly * 0.6 * side;
  const d = Math.hypot(lx * 1.9, (ly - lx * side * 0.9) * 1.1);
  const loop = sat(1 - d * 2.2);
  const n = tfbm(u, v, 8, 2, 41);
  void tilt;
  return [loop * 0.8 + 0.2 * n, 0.5 + 0.12 * (loop - 0.5) + 0.05 * (n - 0.5), 0.5 + 0.05 * (n - 0.5)];
};
LAYERS[LAYER.LEATHER] = (u, v) => {
  const [c1, c2] = tcell(u, v, 22, 51);
  const pebble = sat((c2 - c1) * 3.0);
  const crease = Math.pow(1 - Math.abs(tfbm(u, v, 4, 3, 57) * 2 - 1), 12);
  const n = tfbm(u, v, 16, 2, 53);
  return [0.55 * pebble - 0.35 * crease + 0.15 * n, 0.5 + 0.06 * (pebble - 0.5) - 0.06 * crease, 0.5 - 0.08 * (pebble - 0.5) + 0.1 * crease];
};
LAYERS[LAYER.RUBBER] = (u, v) => {
  const [c1, c2] = tcell(u, v, 6, 61);
  const lug = sstep(0.04, 0.1, c2 - c1);
  const n = tfbm(u, v, 16, 2, 63);
  return [0.8 * lug + 0.2 * n, 0.5 + 0.08 * (lug - 0.5), 0.5 + 0.05 * (n - 0.5)];
};
LAYERS[LAYER.SKIN] = (u, v) => {
  const [c1] = tcell(u, v, 40, 71);
  const pore = sstep(0.25, 0.0, c1);
  const n = tfbm(u, v, 8, 3, 73);
  return [0.6 * n - 0.35 * pore, 0.5 + 0.1 * (n - 0.5) - 0.04 * pore, 0.5 + 0.08 * pore];
};
LAYERS[LAYER.STIPPLE] = (u, v) => {
  const n = tfbm(u, v, 32, 2, 81);
  const m = tfbm(u, v, 4, 3, 83);
  return [0.8 * n + 0.2 * m, 0.5 + 0.06 * (m - 0.5), 0.5 + 0.2 * (m - 0.5)];
};

LAYERS[LAYER.WRINKLE] = (u, v) => {
  // macro cloth folds: wandering ridges mostly across v (around limbs / torso), clustered by a mask,
  // plus a few diagonal drag folds. B = large-scale fading / grime mottling.
  const w1 = tfbm(u, v, 2, 3, 91), w2 = tfbm(u, v, 4, 2, 93);
  const ridge = (x) => { const r = 1 - Math.abs(Math.sin(x * Math.PI)); return r * r * (3 - 2 * r); };
  const a = ridge(3 * v + 1.2 * (w1 - 0.5) + 0.35 * Math.sin(u * 2 * Math.PI));
  const b = ridge(5 * v + 1 * u + 1.6 * (w2 - 0.5));
  const c = ridge(2 * v - 2 * u + 0.8 * (w1 - 0.5));
  const mask = sstep(0.35, 0.7, tfbm(u, v, 2, 2, 97));
  const h = 0.55 * a * (0.4 + 0.6 * mask) + 0.3 * b * mask + 0.25 * c * (1 - mask) + 0.15 * w2;
  const mott = tfbm(u, v, 3, 4, 99);
  return [h, 0.5 + 0.22 * (mott - 0.5) - 0.06 * (1 - h), 0.5 + 0.12 * (mott - 0.5)];
};

function buildDetailArray() {
  const data = new Uint8Array(SIZE * SIZE * 4 * LAYER_COUNT);
  const H = new Float32Array(SIZE * SIZE);
  const strength = [2.2, 2.0, 2.0, 2.4, 2.2, 3.0, 1.2, 1.0, 1.4];
  for (let l = 0; l < LAYER_COUNT; l++) {
    const fn = LAYERS[l];
    const alb = new Float32Array(SIZE * SIZE), rgh = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const r = fn(x / SIZE, y / SIZE);
        const i = y * SIZE + x;
        H[i] = r[0]; alb[i] = r[1]; rgh[i] = r[2];
      }
    }
    const k = strength[l] * (SIZE / 256) * 4;
    const off = l * SIZE * SIZE * 4;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = y * SIZE + x;
        const xl = y * SIZE + ((x + SIZE - 1) % SIZE), xr = y * SIZE + ((x + 1) % SIZE);
        const yd = ((y + SIZE - 1) % SIZE) * SIZE + x, yu = ((y + 1) % SIZE) * SIZE + x;
        let nx = -(H[xr] - H[xl]) * k, ny = -(H[yu] - H[yd]) * k;
        const nz = 1;
        const len = Math.hypot(nx, ny, nz);
        nx /= len; ny /= len;
        data[off + i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
        data[off + i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        data[off + i * 4 + 2] = Math.round(sat(alb[i]) * 255);
        data[off + i * 4 + 3] = Math.round(sat(rgh[i]) * 255);
      }
    }
  }
  const tex = new THREE.DataArrayTexture(data, SIZE, SIZE, LAYER_COUNT);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------ palette
// [hex sRGB albedo, roughness, metalness, layer, tiles per metre, normal strength]
export const PALETTE = [];
PALETTE[M.FATIGUE] = [0x4a4b3e, 0.9, 0, LAYER.TWILL, 20, 0.55];
PALETTE[M.VEST] = [0x2d3024, 0.84, 0, LAYER.CORDURA, 13.2, 0.8];
PALETTE[M.WEBBING] = [0x22241d, 0.8, 0, LAYER.WEBBING, 30, 0.7];
PALETTE[M.KNIT] = [0x151514, 0.97, 0, LAYER.KNIT, 22, 0.8];
PALETTE[M.SKIN] = [0x9a6a52, 0.52, 0, LAYER.SKIN, 30, 0.35];
PALETTE[M.GLOVE] = [0x191917, 0.62, 0, LAYER.LEATHER, 16, 0.6];
PALETTE[M.BOOT] = [0x2a221a, 0.6, 0, LAYER.LEATHER, 12, 0.7];
PALETTE[M.RUBBER] = [0x121212, 0.88, 0, LAYER.RUBBER, 25, 1.0];
PALETTE[M.GUNMETAL] = [0x1c1d1f, 0.42, 0.65, LAYER.STIPPLE, 20, 0.2];
PALETTE[M.POLYMER] = [0x1f201f, 0.62, 0, LAYER.STIPPLE, 30, 0.45];
PALETTE[M.CRIMSON] = [0x7c1519, 0.86, 0, LAYER.TWILL, 20, 0.6];
PALETTE[M.HELMET] = [0x373a2e, 0.86, 0, LAYER.TWILL, 18, 0.6];
PALETTE[M.LENS] = [0x0b0d10, 0.06, 0.55, LAYER.STIPPLE, 1, 0.0];
PALETTE[M.EYE] = [0x1c1310, 0.18, 0, LAYER.SKIN, 1, 0.0];
PALETTE[M.HARDWARE] = [0x2c2c2a, 0.5, 0.55, LAYER.STIPPLE, 20, 0.3];
PALETTE[M.PAD] = [0x1b1c19, 0.55, 0, LAYER.STIPPLE, 12, 0.5];

// Scene calibration: the world's albedos/exposure put linear ~0.2 near display white in sun, so palette
// entries (authored as "real-world" sRGB swatches) are scaled in linear space to sit at the same level as
// the environment. Per-id overrides keep the crimson ID marker and skin readable.
export const ALBEDO_SCALE = 0.42;
const ALBEDO_SCALE_ID = { [M.CRIMSON]: 0.62, [M.SKIN]: 0.6, [M.LENS]: 1, [M.EYE]: 1, [M.GUNMETAL]: 0.8, [M.HARDWARE]: 0.8, [M.POLYMER]: 0.8 };

// macro wrinkle strength, grime mottling amount
export const PALETTE_C = [];
for (let i = 0; i < MAT_COUNT; i++) PALETTE_C[i] = [0, 0.3];
PALETTE_C[M.FATIGUE] = [1.7, 1.0];
PALETTE_C[M.CRIMSON] = [1.2, 0.8];
PALETTE_C[M.KNIT] = [0.35, 0.5];
PALETTE_C[M.HELMET] = [0.45, 0.8];
PALETTE_C[M.VEST] = [0.3, 0.9];
PALETTE_C[M.GLOVE] = [0.5, 0.6];
PALETTE_C[M.BOOT] = [0.45, 0.8];
PALETTE_C[M.WEBBING] = [0.15, 0.7];
PALETTE_C[M.PAD] = [0.1, 0.8];

// specular (F0/F90) scale: woven fabrics scatter most of their sheen away (fibre self-shadowing), so a
// plain 4% dielectric makes cloth read as grey clay under a bright sky. Leather/rubber/metal keep more.
export const SPEC = new Array(MAT_COUNT).fill(0.6);
SPEC[M.FATIGUE] = 0.28; SPEC[M.VEST] = 0.3; SPEC[M.WEBBING] = 0.35; SPEC[M.KNIT] = 0.2; SPEC[M.CRIMSON] = 0.28;
SPEC[M.HELMET] = 0.4; SPEC[M.SKIN] = 0.7; SPEC[M.GLOVE] = 0.55; SPEC[M.BOOT] = 0.6; SPEC[M.PAD] = 0.55;
SPEC[M.GUNMETAL] = 1; SPEC[M.POLYMER] = 0.8; SPEC[M.LENS] = 1; SPEC[M.EYE] = 1; SPEC[M.HARDWARE] = 1;

let detailTex = null;
export function getDetailTexture() {
  if (!detailTex) detailTex = buildDetailArray();
  return detailTex;
}
export function disposeDetailTexture() { detailTex?.dispose(); detailTex = null; }

const VERT_PARS = /* glsl */`
attribute vec4 aData;
varying vec4 vData;
varying vec2 vDUv;
`;
const FRAG_PARS = /* glsl */`
uniform highp sampler2DArray uDetail;
uniform vec4 uMatA[${MAT_COUNT}];
uniform vec4 uMatB[${MAT_COUNT}];
uniform vec2 uMatC[${MAT_COUNT}];
uniform float uSpec[${MAT_COUNT}];
float sSpec;
vec4 sWr;
vec2 sMatC;
uniform vec3 uDirtColor;
uniform float uDirt;
varying vec4 vData;
varying vec2 vDUv;
vec4 sDet;
vec4 sMatA;
vec4 sMatB;
float sDirt;
vec3 perturbDetail( vec3 eye_pos, vec3 surf_norm, vec3 mapN, vec2 uv, float faceDir ) {
  vec3 q0 = dFdx( eye_pos ); vec3 q1 = dFdy( eye_pos );
  vec2 st0 = dFdx( uv ); vec2 st1 = dFdy( uv );
  vec3 N = surf_norm;
  vec3 q1perp = cross( q1, N ); vec3 q0perp = cross( N, q0 );
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max( dot( T, T ), dot( B, B ) );
  float scale = ( det == 0.0 ) ? 0.0 : faceDir * inversesqrt( det );
  return normalize( T * ( mapN.x * scale ) + B * ( mapN.y * scale ) + N * mapN.z );
}
`;

/**
 * Create a soldier material. `tints` optionally overrides palette entries (per-soldier variation):
 * { [matId]: hexColor }.
 */
export function createSoldierMaterial({ tints = null, dirt = 1, envMapIntensity = 1 } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.name = 'ai_soldier';
  mat.userData.surface = 'flesh';
  mat.envMapIntensity = envMapIntensity;
  const A = [], Bv = [], Cv = [];
  const c = new THREE.Color();
  for (let i = 0; i < MAT_COUNT; i++) {
    const p = PALETTE[i];
    c.setHex(tints && tints[i] !== undefined ? tints[i] : p[0]);
    c.multiplyScalar(ALBEDO_SCALE_ID[i] ?? ALBEDO_SCALE);
    A.push(new THREE.Vector4(c.r, c.g, c.b, p[1]));
    Bv.push(new THREE.Vector4(p[2], p[3], p[4], p[5]));
    Cv.push(new THREE.Vector2(PALETTE_C[i][0], PALETTE_C[i][1]));
  }
  const uniforms = {
    uDetail: { value: getDetailTexture() },
    uMatA: { value: A },
    uMatB: { value: Bv },
    uMatC: { value: Cv },
    uSpec: { value: SPEC.slice() },
    uDirtColor: { value: new THREE.Color(0x4a3f31).multiplyScalar(0.55) },
    uDirt: { value: dirt },
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vData = aData;\n  vDUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <map_fragment>', /* glsl */`
  {
    int mid = int( vData.x * 255.0 + 0.5 );
    sMatA = uMatA[ mid ];
    sMatB = uMatB[ mid ];
    sMatC = uMatC[ mid ];
    sSpec = uSpec[ mid ];
    sDet = texture( uDetail, vec3( vDUv * sMatB.z, sMatB.y ) );
    sWr = texture( uDetail, vec3( vDUv * 2.3 + vec2( 0.37, 0.11 ), float( ${LAYER.WRINKLE} ) ) );
    vec3 base = sMatA.rgb * ( 0.55 + 0.9 * sDet.b );
    base *= 1.0 + ( sWr.b - 0.5 ) * 1.6 * sMatC.y;
    sDirt = clamp( vData.z * uDirt * ( 0.35 + 1.3 * sWr.b ) * ( 0.7 + 0.6 * sDet.b ) - 0.08, 0.0, 1.0 );
    base = mix( base, uDirtColor * ( 0.8 + 0.4 * sDet.b ), sDirt * 0.38 );
    // edge wear: lighter, worn finish
    base = mix( base, base * 1.7, clamp( vData.w * ( sDet.a - 0.35 ) * 1.5, 0.0, 1.0 ) * 0.35 );
    // cavity darkening from the baked AO (subtle, also affects direct light)
    base *= mix( 1.0, vData.y, 0.5 );
    diffuseColor.rgb = base;
  }
`)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
  float roughnessFactor = clamp( sMatA.a + ( sDet.a - 0.5 ) * 0.35 + sDirt * 0.12, 0.04, 1.0 );
`)
      .replace('#include <metalnessmap_fragment>', /* glsl */`
  float metalnessFactor = sMatB.x * ( 1.0 - sDirt * 0.6 );
`)
      .replace('#include <normal_fragment_maps>', /* glsl */`
  {
    vec3 dn = vec3( ( sDet.rg * 2.0 - 1.0 ) * sMatB.w + ( sWr.rg * 2.0 - 1.0 ) * sMatC.x * 0.55, 0.0 );
    dn.z = sqrt( max( 1.0 - dot( dn.xy, dn.xy ), 0.0 ) );
    normal = perturbDetail( - vViewPosition, normal, dn, vDUv * sMatB.z, faceDirection );
  }
`)
      .replace('#include <lights_physical_fragment>', /* glsl */`#include <lights_physical_fragment>
  {
    float ks = mix( sSpec, 1.0, metalnessFactor ) * ( 1.0 - sDirt * 0.5 );
    material.specularColor *= ks;
    material.specularColorBlended *= ks;
    material.specularF90 *= ks;
  }
`)
      .replace('#include <aomap_fragment>', /* glsl */`
  {
    float ambientOcclusion = vData.y;
    reflectedLight.indirectDiffuse *= ambientOcclusion;
    reflectedLight.indirectSpecular *= ambientOcclusion * ambientOcclusion;
  }
`);
  };
  mat.customProgramCacheKey = () => 'ai_soldier_v4';
  return mat;
}

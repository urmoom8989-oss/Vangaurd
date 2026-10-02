import * as THREE from 'three';
import { CATALOG, ALIASES, CONTRACT, PAINT_SETS } from './catalog.js';
import { OMStandardMaterial, OMPhysicalMaterial, GLOBAL_UNIFORMS, createMaterialUniforms } from './shader.js';
import { parseOmat, buildTextures, placeholderTextures } from './omat.js';

/**
 * materials — PBR material library. Owner: materials agent. See README.md in this folder.
 *
 * services.materials (contract + extensions):
 *   ready: Promise                 resolves when every texture set is loaded and uploaded
 *   get(name) -> Material          SHARED instance (never mutate / dispose). Unknown -> magenta + warning.
 *                                  Variants: 'name@tri' (world triplanar), 'name@obj' (object triplanar),
 *                                  'name@clean' (no weathering), 'name@burnt' (soot / char)
 *   has(name) / list() / clone(name) / surfaceOf(nameOrMaterial)
 *   info(name) -> {name, surface, desc, set, size}         catalog() -> info[]
 *   setWetness(0..1), setWeathering({dust, grime}), setGroundLevel(y)
 *   stats() -> {textureBytes, textureMB, sets, setsRequested, materials, loaded, textureSkip, perSet}
 *   preload(names[]) -> Promise     start + await the texture sets of these materials
 *   Texture sets are streamed LAZILY: a set is loaded the first time a material using it is requested
 *   (tracked by ctx.assets, so shots wait). `ready` = shared set + the contract materials' sets.
 *   Paint sets (albedo alpha = paint mask): catalog `color` is the PAINT colour; a non-white
 *   material.color on a clone (world tints) repaints only the paint, over a light neutral base.
 *   noise: Texture (shared tiling RGBA noise), detailNormal(kind) -> Texture
 */

/** Legacy flat view of the catalog (name -> {surface, color, roughness, metalness}). */
export const MATERIAL_CATALOG = Object.fromEntries(Object.entries(CATALOG).map(([k, d]) => [k, {
  surface: d.surface, color: d.color ?? 0x808080, roughness: d.rough ? d.rough[1] + (d.set ? 0.8 * d.rough[0] : 0) : 0.8,
  metalness: d.metal ? d.metal[1] : 0,
}]));

const BASE = '/assets/materials/';
const PLACEHOLDER_AVG = 0.5029; // linear value of the 188/255 placeholder albedo
const VARIANTS = ['tri', 'obj', 'clean', 'burnt'];

export default function createSystem(ctx) {
  const cache = new Map();       // name (incl. variant) -> material
  const setData = new Map();     // set id -> {meta, textures, gpuBytes}
  const users = new Map();       // set id -> Set<material> waiting for / using this set
  const warned = new Set();
  let placeholders = null;
  let started = false;
  let shared = null;
  let errorMat = null;
  let loaded = false;
  const setLoads = new Map();   // set id -> Promise (started loads)
  let texSkip = 0;              // top mip levels dropped (texture quality)
  let textureBytes = 0;
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  const _c = new THREE.Color();

  // ------------------------------------------------------------------------------ definitions
  function parseName(name) {
    if (typeof name !== 'string') return null;
    const [base0, ...flags] = name.split('@');
    const base = CATALOG[base0] ? base0 : ALIASES[base0];
    if (!base || !CATALOG[base]) return null;
    if (flags.some((f) => !VARIANTS.includes(f))) return null;
    return { base, flags, key: flags.length ? `${base}@${flags.join('@')}` : base };
  }

  function resolveDef(base, flags) {
    const d = { ...CATALOG[base] };
    if (flags.includes('tri')) d.triplanar = 'world';
    if (flags.includes('obj')) d.triplanar = 'object';
    if (flags.includes('clean')) { d.grime = [0, 0, 0, 0]; d.burn = 0; }
    if (flags.includes('burnt')) d.burn = Math.max(d.burn || 0, 0.8);
    return d;
  }

  function linColor(hex, out) {
    return out.setHex(hex, THREE.SRGBColorSpace); // Color stores linear-sRGB working space
  }

  function applyTint(m) {
    const { def } = m._omMeta;
    const u = m._om.uniforms;
    const meta = def.set ? setData.get(def.set)?.meta : null;
    if (m.defines.OM_PAINT !== undefined) {
      // paint set: colour = paint colour, base (rust / wood / concrete) keeps its own albedo (x def.tint)
      linColor(def.paint ?? def.color ?? 0xb0b0b0, u.omPaint.value);
      const avgLum = meta?.paint?.avgLum || PLACEHOLDER_AVG;
      u.omPaint.value.multiplyScalar(1 / Math.max(0.01, avgLum));
      u.omTint.value.setRGB(1, 1, 1);
      if (def.baseColor !== undefined && meta?.paint?.base) {
        linColor(def.baseColor, u.omTint.value);
        const b = meta.paint.base;
        u.omTint.value.setRGB(u.omTint.value.r / Math.max(0.01, b[0]), u.omTint.value.g / Math.max(0.01, b[1]), u.omTint.value.b / Math.max(0.01, b[2]));
      }
      if (def.tint) u.omTint.value.multiply(_c.setRGB(def.tint[0], def.tint[1], def.tint[2]));
      // neutral paint luminance used when a clone sets material.color (world tints)
      const pl = linColor(def.paint ?? def.color ?? 0xb0b0b0, _c);
      const lum = 0.2126 * pl.r + 0.7152 * pl.g + 0.0722 * pl.b;
      u.omPaintN.value = Math.max(0.4, lum) / Math.max(0.01, avgLum);
      return;
    }
    linColor(def.color ?? 0xffffff, u.omTint.value);
    if (def.set) {
      const avg = setData.get(def.set)?.meta.avgAlbedo;
      if (avg) u.omTint.value.setRGB(u.omTint.value.r / Math.max(0.01, avg[0]), u.omTint.value.g / Math.max(0.01, avg[1]), u.omTint.value.b / Math.max(0.01, avg[2]));
      else u.omTint.value.multiplyScalar(1 / PLACEHOLDER_AVG);
    }
    if (def.tint) u.omTint.value.multiply(_c.setRGB(def.tint[0], def.tint[1], def.tint[2]));
    if (def.layer && m.defines.OM_LAYER !== undefined) {
      // layer albedo ratio: (target colour / layer set average) / base tint -> after x omTint = target
      const L = def.layer;
      const avg2 = setData.get(L.set)?.meta.avgAlbedo;
      const t = u.omLTint.value;
      if (L.color !== undefined) linColor(L.color, t); else if (avg2) t.setRGB(avg2[0], avg2[1], avg2[2]); else t.setRGB(PLACEHOLDER_AVG, PLACEHOLDER_AVG, PLACEHOLDER_AVG);
      const a = avg2 || [PLACEHOLDER_AVG, PLACEHOLDER_AVG, PLACEHOLDER_AVG];
      const b = u.omTint.value;
      t.setRGB(t.r / Math.max(0.01, a[0]) / Math.max(0.01, b.r), t.g / Math.max(0.01, a[1]) / Math.max(0.01, b.g), t.b / Math.max(0.01, a[2]) / Math.max(0.01, b.b));
    }
  }

  function bindSet(m) {
    const { def } = m._omMeta;
    const u = m._om.uniforms;
    const sd = def.set && setData.get(def.set);
    if (def.set) {
      const paint = !!(sd ? sd.meta.paint : PAINT_SETS.has(def.set));
      if (paint !== (m.defines.OM_PAINT !== undefined)) {
        if (paint) m.defines.OM_PAINT = ''; else delete m.defines.OM_PAINT;
        m.needsUpdate = true;
      }
      u.omA.value = sd?.textures.albedo || placeholders.albedo;
      u.omN.value = sd?.textures.normal || placeholders.normal;
      u.omM.value = sd?.textures.mask || placeholders.mask;
      const size = def.size ? [def.size, def.size] : sd?.meta.size || [1, 1];
      u.omP0.value.x = 1 / size[0];
      u.omP0.value.y = 1 / size[1];
    }
    if (def.layer && m.defines.OM_LAYER !== undefined) {
      const sd2 = setData.get(def.layer.set);
      u.omA2.value = sd2?.textures.albedo || placeholders.albedo;
      u.omN2.value = sd2?.textures.normal || placeholders.normal;
      u.omM2.value = sd2?.textures.mask || placeholders.mask;
      const s2 = def.layer.size ? [def.layer.size, def.layer.size] : sd2?.meta.size || [1, 1];
      u.omL0.value.x = 1 / s2[0];
      u.omL0.value.y = 1 / s2[1];
    }
    if (def.detail) u.omD.value = shared?.textures[DETAIL_MAPS[def.detail.map] || 'dnMicro'] || placeholders.normal;
    applyTint(m);
  }

  const DETAIL_MAPS = { micro: 'dnMicro', brushed: 'dnBrushed', stipple: 'dnStipple', pores: 'dnPores', wrinkle: 'dnWrinkle' };

  function build(name, def) {
    const phys = def.physical;
    const Cls = phys ? OMPhysicalMaterial : OMStandardMaterial;
    const params = {
      color: 0xffffff, roughness: 1, metalness: 0,
      side: def.side === 'double' ? THREE.DoubleSide : THREE.FrontSide,
    };
    if (phys) {
      if (phys.sheen) Object.assign(params, { sheen: phys.sheen, sheenRoughness: phys.sheenRoughness ?? 0.5, sheenColor: new THREE.Color().setHex(phys.sheenColor ?? 0x808080, THREE.SRGBColorSpace) });
      if (phys.clearcoat) Object.assign(params, { clearcoat: phys.clearcoat, clearcoatRoughness: phys.clearcoatRoughness ?? 0.3 });
    }
    if (def.glass) Object.assign(params, { transparent: true, premultipliedAlpha: true, depthWrite: false });
    if (def.decal) Object.assign(params, { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const m = new Cls(params);
    m.name = name;
    m.userData.surface = def.surface || 'default';
    m.userData.materialName = name;

    const u = createMaterialUniforms();
    const defines = { USE_UV: '' };
    const tri = def.triplanar === 'world' ? 'OM_TRI_WORLD' : def.triplanar === 'object' ? 'OM_TRI_OBJECT' : null;
    if (tri) defines[tri] = '';
    if (def.set) {
      defines.OM_MAPS = '';
      if (PAINT_SETS.has(def.set)) defines.OM_PAINT = '';
      if (!tri && (def.antiTile ?? 0) > 0) defines.OM_ANTITILE = '';
    }
    const rough = def.rough || (def.set ? [1, 0] : [0, 0.8]);
    const metal = def.metal || (def.set ? [1, 0] : [0, 0]);
    u.omP0.value.set(1, 1, def.normal ?? 1, def.ao ?? 1);
    u.omP1.value.set(rough[0], rough[1], metal[0], metal[1]);
    const patches = def.patches ?? (def.grime ? ({ plaster: 1, concrete: 0.8, brick: 0.45 }[def.surface] ?? 0) : 0);
    u.omP2.value.set(def.antiTile ?? 0, def.porosity ?? 0.5, patches, def.baseH ?? 0.6);
    const mac = def.macro || [0, 0, 0.2, 0];
    u.omMacro.value.set(mac[0], mac[1], mac[2], mac[3]);
    if (def.detail) {
      defines.OM_DETAIL = '';
      u.omDetail.value.set(def.detail.scale ?? 4, def.detail.strength ?? 0.3, def.detail.fade ?? 8, 0);
    }
    const g = def.grime || [0, 0, 0, 0];
    if (g.some((x) => x > 0)) defines.OM_GRIME = '';
    u.omGrime.value.set(g[0], g[1], g[2], g[3]);
    if (def.wear) {
      defines.OM_WEAR = '';
      const w = def.wear;
      u.omWear.value.set(w.amount ?? 1, w.lo ?? 150, w.hi ?? 800, w.rough ?? 0.3);
      linColor(w.color ?? 0x808080, u.omWearColor.value);
    }
    if (def.burn > 0) { defines.OM_BURN = ''; u.omBurn.value.set(def.burn, 1, 0, 0); }
    if (def.camo) {
      defines.OM_CAMO = '';
      // pattern colours are relative to the fabric's own average colour
      const base = linColor(def.color, new THREE.Color());
      ['omCamo0', 'omCamo1', 'omCamo2', 'omCamo3'].forEach((k, i) => {
        linColor(def.camo[i], u[k].value);
        u[k].value.setRGB(u[k].value.r / base.r, u[k].value.g / base.g, u[k].value.b / base.b);
      });
    }
    if (def.hesco) defines.OM_HESCO = '';
    if (def.glass) {
      defines.OM_GLASS = '';
      u.omGlass.value.set(def.glass.trans ?? 0.85, def.glass.smudge ?? 0.5, def.glass.dirt ?? 0.3, 0);
    }
    if (def.decal) defines.OM_DECAL = '';
    if (def.layer && def.set && !tri && !PAINT_SETS.has(def.set)) {
      // layer: {set, amount 0..1, freq 1/m, sharp, height, normal, color, size, dark}
      const L = def.layer;
      defines.OM_LAYER = '';
      u.omL0.value.set(1, 1, L.amount ?? 0.35, L.freq ?? 0.15);
      u.omL1.value.set(L.sharp ?? 5, L.height ?? 1.5, L.normal ?? 1, L.dark ?? 0);
    }

    setLiteDefines(defines);
    m.defines = defines;
    m._om = { uniforms: u };
    m._omMeta = { def };
    bindSet(m);
    for (const sid of [def.set, defines.OM_LAYER !== undefined ? def.layer.set : null]) {
      if (!sid) continue;
      if (!users.has(sid)) users.set(sid, new Set());
      users.get(sid).add(m);
      if (started) requestSet(sid);
    }
    return m;
  }

  function errorMaterial() {
    if (!errorMat) {
      errorMat = new THREE.MeshStandardMaterial({ color: 0xff00ff, roughness: 0.5, emissive: 0x330033 });
      errorMat.name = 'missing_material';
      errorMat.userData.surface = 'default';
    }
    return errorMat;
  }

  // ------------------------------------------------------------------------------ loading
  function requestSet(id) {
    let p = setLoads.get(id);
    if (p) return p;
    p = ctx.assets.track((async () => {
      try {
        const r = await loadSet(id);
        setData.set(id, r);
        textureBytes += r.gpuBytes;
        for (const m of users.get(id) || []) bindSet(m);
      } catch (e) {
        ctx.reportError('materials', `load ${id}`, e);
      }
    })(), `materials:${id}`);
    setLoads.set(id, p);
    return p;
  }

  async function loadSet(id) {
    const buf = await ctx.assets.arrayBuffer(`${BASE}${id}.omat`);
    const parsed = await parseOmat(buf);
    const r = buildTextures(parsed, { renderer: ctx.renderer, anisotropy: Math.min(16, ctx.assets.maxAnisotropy || 8), skip: id === 'shared' ? 0 : texSkip });
    for (const t of Object.values(r.textures)) {
      try { ctx.renderer.initTexture(t); } catch { /* uploaded on first use instead */ }
    }
    return r;
  }

  async function loadInitial() {
    const sharedP = loadSet('shared').then((r) => {
      shared = r;
      textureBytes += r.gpuBytes;
      GLOBAL_UNIFORMS.omNoise.value = r.textures.noise;
      GLOBAL_UNIFORMS.omDetailMicro.value = r.textures.dnMicro;
      for (const m of new Set(cache.values())) if (m._omMeta) bindSet(m);
    }).catch((e) => ctx.reportError('materials', 'load shared', e));
    await Promise.all([sharedP, ...[...setLoads.values()]]);
    loaded = true;
    console.info(`[system:materials] ready: ${setData.size} texture sets, ${new Set(cache.values()).size} materials, ${(textureBytes / 1048576).toFixed(1)} MB texture memory (sets stream lazily)`);
  }

  // ------------------------------------------------------------------------------ settings
  let lite = 0;
  function setLiteDefines(d) {
    for (const [bit, k] of [[1, 'OM_LITE_AT'], [2, 'OM_LITE_DET'], [4, 'OM_LITE_GRIME']]) {
      if (lite & bit) d[k] = ''; else delete d[k];
    }
  }
  function applySettings() {
    const s = ctx.settings.data.materials || {};
    // lite: single-sample tiling, no detail normals, no world-space weathering (perf A/B + low-end fallback)
    // lite: true = all, or bitmask 1 anti-tile, 2 detail normals, 4 weathering
    const l = s.lite === true ? 7 : (s.lite | 0);
    if (l !== lite) {
      lite = l;
      for (const m of new Set(cache.values())) if (m._omMeta) { setLiteDefines(m.defines); m.needsUpdate = true; }
    }
    GLOBAL_UNIFORMS.omGlobal.value.y = THREE.MathUtils.clamp(s.wetness ?? 0, 0, 1);
    GLOBAL_UNIFORMS.omGlobal.value.z = s.dust ?? 1;
    GLOBAL_UNIFORMS.omGlobal.value.w = s.grime ?? 1;
    GLOBAL_UNIFORMS.omGlobal.value.x = s.groundLevel ?? 0;
  }
  const onSettings = ({ path }) => { if (path && path.startsWith('materials')) applySettings(); };

  // ------------------------------------------------------------------------------ API
  const api = {
    ready,
    get(name) {
      let m = cache.get(name);
      if (m) return m;
      const p = parseName(name);
      if (!p) {
        if (!warned.has(name)) { warned.add(name); console.warn(`[system:materials] unknown material "${name}"`); }
        return errorMaterial();
      }
      m = cache.get(p.key);
      if (!m) {
        m = build(p.key, resolveDef(p.base, p.flags));
        cache.set(p.key, m);
      }
      if (name !== p.key) {
        if (!warned.has(name) && !p.flags.length && ALIASES[name]) { warned.add(name); console.info(`[system:materials] "${name}" -> "${p.base}" (alias)`); }
        cache.set(name, m);
      }
      return m;
    },
    has: (name) => !!parseName(name),
    list: () => Object.keys(CATALOG),
    variants: () => VARIANTS.slice(),
    clone(name) {
      const p = parseName(name);
      if (!p) return api.get(name).clone();
      return build(p.key, resolveDef(p.base, p.flags));
    },
    surfaceOf(x) {
      if (!x) return 'default';
      if (typeof x === 'string') {
        const p = parseName(x);
        return p ? CATALOG[p.base].surface || 'default' : 'default';
      }
      if (Array.isArray(x)) x = x[0];
      return x.userData?.surface || (parseName(x.name) ? CATALOG[parseName(x.name).base].surface : 'default');
    },
    info(name) {
      const p = parseName(name);
      if (!p) return null;
      const d = CATALOG[p.base];
      return { name: p.base, surface: d.surface, desc: d.desc || '', set: d.set || null, size: d.set ? (d.size ? [d.size, d.size] : setData.get(d.set)?.meta.size || null) : null, procedural: !d.set };
    },
    catalog: () => Object.keys(CATALOG).map((n) => api.info(n)),
    setWetness(v) { ctx.settings.set('materials.wetness', THREE.MathUtils.clamp(v, 0, 1)); applySettings(); },
    setWeathering({ dust, grime } = {}) {
      if (dust !== undefined) ctx.settings.set('materials.dust', dust);
      if (grime !== undefined) ctx.settings.set('materials.grime', grime);
      applySettings();
    },
    setGroundLevel(y) { ctx.settings.set('materials.groundLevel', y); applySettings(); },
    stats() {
      const perSet = {};
      for (const [id, r] of setData) perSet[id] = +(r.gpuBytes / 1048576).toFixed(2);
      return {
        textureBytes: Math.round(textureBytes), textureMB: +(textureBytes / 1048576).toFixed(1), sets: setData.size,
        setsRequested: setLoads.size, materials: new Set(cache.values()).size, loaded, textureSkip: texSkip, perSet,
      };
    },
    preload(names = []) {
      const ps = [];
      for (const n of names) {
        const p = parseName(n);
        const set = p && CATALOG[p.base].set;
        if (set) { api.get(n); ps.push(requestSet(set)); }
      }
      return Promise.all(ps).then(() => undefined);
    },
    get noise() { return GLOBAL_UNIFORMS.omNoise.value; },
    /** Debug view: 'off'|'albedo'|'roughness'|'metalness'|'ao'|'height'|'basedirt'|'dust'|'streaks'|'normal' */
    setDebugView(mode = 'off') {
      const i = ['off', 'albedo', 'roughness', 'metalness', 'ao', 'height', 'basedirt', 'dust', 'streaks', 'normal'].indexOf(mode);
      GLOBAL_UNIFORMS.omDebug.value = Math.max(0, i);
    },
    detailNormal(kind = 'micro') { return shared?.textures[DETAIL_MAPS[kind]] || null; },
  };

  return {
    name: 'materials',
    async init() {
      ctx.settings.registerDefaults('materials', { wetness: 0, dust: 1, grime: 1, groundLevel: 0, lite: false });
      applySettings();
      ctx.events.on('settings:changed', onSettings);
      placeholders = placeholderTextures();
      GLOBAL_UNIFORMS.omNoise.value = placeholders.noise;
      // texture quality: 'low' drops the top mip of every set (1/4 memory)
      texSkip = ctx.settings.data.graphics?.quality === 'low' ? 1 : 0;
      started = true;
      for (const n of CONTRACT) api.get(n);
      ctx.services.provide('materials', api);
      const load = ctx.assets.track(loadInitial(), 'materials:textures');
      load.finally(() => resolveReady());
      // don't let a stalled download stall boot: materials already work with placeholders
      await Promise.race([load, new Promise((r) => setTimeout(r, 20000))]);
    },
    dispose() {
      ctx.events.off?.('settings:changed', onSettings);
      for (const m of new Set(cache.values())) m.dispose();
      cache.clear();
      errorMat?.dispose();
      for (const r of setData.values()) for (const t of Object.values(r.textures)) t.dispose();
      if (shared) for (const t of Object.values(shared.textures)) t.dispose();
      if (placeholders) for (const t of Object.values(placeholders)) t.dispose();
      setData.clear();
    },
  };
}

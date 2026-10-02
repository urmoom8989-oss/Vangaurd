import * as THREE from 'three';

/**
 * World material resolver.
 *  - catalog names ('concrete_wall') -> services.materials.get() (shared, never mutated)
 *  - wished-for catalog names that may not exist yet -> fallback catalog name (+ optional tint clone)
 *  - tinted variants 'plaster_painted#ochre' -> caller-owned clone with color tint
 *  - world-owned materials 'w:<name>' registered with define()
 */

export const TINTS = {
  // facade paints (multiplied over the catalog albedo, keep near 1 so the texture detail survives)
  cream: [1.0, 0.95, 0.84],
  ochre: [1.0, 0.86, 0.62],
  salmon: [1.0, 0.8, 0.72],
  mint: [0.84, 0.95, 0.86],
  sky: [0.84, 0.9, 0.98],
  white: [1.0, 1.0, 0.98],
  grey: [0.82, 0.82, 0.82],
  dark: [0.55, 0.55, 0.55],
  sooty: [0.35, 0.33, 0.31],
  pale: [0.95, 0.95, 0.93],
  // metals / paints
  yellow: [1.0, 0.78, 0.2],
  green: [0.55, 0.7, 0.55],
  blue: [0.45, 0.6, 0.85],
  red: [0.85, 0.35, 0.3],
  rust: [0.8, 0.55, 0.4],
  olive: [0.6, 0.62, 0.45],
  burnt: [0.2, 0.17, 0.15],
  tan: [1.0, 0.88, 0.7],
  beige: [1.0, 0.92, 0.78],
  // fabrics
  tarp_blue: [0.35, 0.55, 0.9],
  tarp_orange: [1.0, 0.55, 0.3],
  tarp_green: [0.55, 0.75, 0.5],
  tarp_red: [0.9, 0.35, 0.3],
  tarp_white: [1.25, 1.2, 1.1],
  stripe: [1.1, 1.05, 0.95],
};

// Requested (not yet guaranteed) catalog names -> fallback "base#tint"
export const WISHLIST = {
  roofing_tar: 'asphalt#grey',
  concrete_panel: 'concrete_wall',
  paving_stones: 'concrete_floor',
  roof_tiles: 'brick_red#dark',
  wood_painted: 'wood_planks#pale',
  plaster_white: 'plaster_painted#white',
  metal_galvanized: 'corrugated_metal',
  rubble: 'concrete_floor#grey',
  car_paint: 'metal_painted',
  metal_burnt: 'metal_rusted#burnt',
  hesco: 'fabric_military#tan',
  tarp: 'fabric_military#tarp_blue',
  cinder_block: 'concrete_wall#grey',
  curb_stone: 'concrete_floor#pale',
  rope: 'tarp#tan',
  car_paint_white: 'metal_painted#white',
  car_paint_burnt: 'metal_rusted#burnt',
  rebar_metal: 'metal_rusted',
  scorched_ground: 'dirt#burnt',
  painted_wood: 'wood_planks#green',
  metal_tread_plate: 'metal_galvanized',
  fabric_charcoal: 'fabric_military#dark',
  metal_steel: 'metal_galvanized',
  plaster_ochre: 'plaster_painted#ochre',
  plaster_blue: 'plaster_painted#sky',
  plaster_green: 'plaster_painted#mint',
  plaster_pink: 'plaster_painted#salmon',
  plaster_damaged: 'plaster_painted#grey',
  brick_dark: 'brick_red#dark',
  roof_asbestos: 'corrugated_metal#grey',
  cobblestone: 'concrete_floor#grey',
  concrete_pavement: 'concrete_floor',
  concrete_barrier: 'concrete_wall',
  container_metal: 'corrugated_metal#green',
  container_metal_blue: 'corrugated_metal#blue',
  container_metal_red: 'corrugated_metal#red',
  hesco_fabric: 'fabric_military#tan',
  osb_board: 'wood_planks#tan',
  corrugated_metal_rusted: 'corrugated_metal#rust',
  asphalt_damaged: 'asphalt#dark',
  dirt_rocky: 'dirt',
  road_markings: 'concrete_floor#white',
};

export class WorldMaterials {
  constructor(ctx) {
    this.ctx = ctx;
    this.owned = new Map(); // key -> material (disposed by us)
    this.defs = new Map(); // 'w:name' -> material
    this.textures = [];
  }

  get cat() { return this.ctx.services.materials; }

  define(name, material, surface = 'default') {
    material.userData.surface = material.userData.surface || surface;
    this.defs.set(name, material);
    return material;
  }

  _tinted(base, tint) {
    const key = `${base}#${tint}`;
    let m = this.owned.get(key);
    if (m) return m;
    const src = this.cat.get(base);
    m = this.cat.clone ? this.cat.clone(base) : src.clone();
    // clone() may drop onBeforeCompile hooks; copy them when present so catalog shader tweaks survive
    if (src.onBeforeCompile && m.onBeforeCompile !== src.onBeforeCompile) {
      m.onBeforeCompile = src.onBeforeCompile;
      m.customProgramCacheKey = src.customProgramCacheKey;
    }
    const t = TINTS[tint];
    if (t && m.color) m.color.multiply(new THREE.Color(t[0], t[1], t[2]));
    m.name = key;
    m.userData.surface = src.userData?.surface || this.cat.surfaceOf(base);
    this.owned.set(key, m);
    return m;
  }

  /** 'base%rrggbb': caller-owned clone with its albedo REPLACED (sRGB hex). */
  _recolored(base, hex) {
    const key = `${base}%${hex}`;
    let m = this.owned.get(key);
    if (m) return m;
    const src = this.cat.get(base);
    m = this.cat.clone ? this.cat.clone(base) : src.clone();
    if (src.onBeforeCompile && m.onBeforeCompile !== src.onBeforeCompile) {
      m.onBeforeCompile = src.onBeforeCompile;
      m.customProgramCacheKey = src.customProgramCacheKey;
    }
    if (m.color) m.color.set(`#${hex}`);
    m.name = key;
    m.userData.surface = src.userData?.surface || this.cat.surfaceOf(base);
    this.owned.set(key, m);
    return m;
  }

  /** Resolve a key to { material, surface }. */
  resolve(key) {
    if (this.defs.has(key)) {
      const m = this.defs.get(key);
      return { material: m, surface: m.userData.surface || 'default' };
    }
    if (key.includes('%')) {
      let [base, hex] = key.split('%');
      if (!this.cat.has(base) && WISHLIST[base]) base = WISHLIST[base].split('#')[0];
      const material = this._recolored(base, hex);
      return { material, surface: material.userData.surface };
    }
    let [base, tint] = key.split('#');
    if (!this.cat.has(base) && WISHLIST[base]) {
      const [fb, ft] = WISHLIST[base].split('#');
      base = fb;
      tint = tint || ft;
    }
    const material = tint ? this._tinted(base, tint) : this.cat.get(base);
    return { material, surface: material.userData?.surface || this.cat.surfaceOf(base) };
  }

  material(key) { return this.resolve(key).material; }

  track(tex) { this.textures.push(tex); return tex; }

  dispose() {
    for (const m of this.owned.values()) m.dispose();
    for (const m of this.defs.values()) m.dispose();
    for (const t of this.textures) t.dispose();
    this.owned.clear();
    this.defs.clear();
    this.textures.length = 0;
  }
}

/**
 * Material catalog: name -> definition. NAMES ARE A CONTRACT (add freely, never rename / remove).
 *
 * Definition fields (all optional except surface):
 *   set        baked texture set id (public/assets/materials/<set>.omat); omitted = procedural surface
 *   size       tile size in meters override (default: the set's physical size from Poly Haven)
 *   color      sRGB hex. With a set: TARGET average albedo (tint = color / set average).
 *              With a PAINT set (see PAINT_SETS): the paint colour (rust / wood / concrete untouched).
 *              Without a set: the base albedo.
 *   paint      paint sets only: explicit paint colour (overrides color)
 *   baseColor  paint sets only: target average colour of the unpainted parts
 *   tint       extra linear RGB multiplier
 *   rough      [mul, add]   roughness = mask.g * mul + add   (procedural: add = roughness)
 *   metal      [mul, add]
 *   normal     normal-map strength (1 = as authored)
 *   ao         cavity AO strength on indirect light (0..1)
 *   macro      [albedoAmp, roughAmp, freq 1/m, hueAmp]   world-space macro variation
 *   detail     {map:'micro'|'brushed'|'stipple'|'pores', scale repeats/m, strength, fade m}
 *   grime      [dust, baseDirt, streaks, blotch]   world-space weathering
 *   antiTile   0..1 stochastic tiling
 *   porosity   0..1 darkening when wet
 *   baseH      wall-base dirt / rising-damp height (m)
 *   patches    0..1 repaired-render patches on walls (default by surface: plaster 1, concrete 0.8, brick 0.45)
 *   triplanar  'world' | 'object'
 *   wear       {amount, lo, hi, rough, color}   edge wear (curvature, 1/m thresholds)
 *   burn       0..1 soot conversion
 *   camo       [c0, c1, c2, c3] sRGB hex pattern colours (multiplied with the fabric albedo)
 *   hesco      true: weld-mesh overlay
 *   glass      {trans, smudge, dirt}
 *   decal      true: worn paint decal (alpha), polygonOffset
 *   physical   {sheen, sheenRoughness, sheenColor, clearcoat, clearcoatRoughness}
 *   layer      {set, amount, freq, sharp, height, normal, color, size, dark}  second set blended in world-space
 *              noise patches with height blending (ground mixes), `dark` = compacted / damp patches
 *   side       'double'
 *   surface    SURFACES entry for impacts / footsteps
 *   desc       short description (shown in the gallery / docs)
 */

const WALL = {
  macro: [0.1, 0.06, 0.12, 0.35], detail: { map: 'micro', scale: 3, strength: 0.35, fade: 9 },
  grime: [0.7, 1.0, 0.85, 0.55], antiTile: 1, porosity: 0.6, baseH: 0.75, ao: 1,
};
const FLOOR = {
  macro: [0.12, 0.08, 0.09, 0.4], detail: { map: 'micro', scale: 2.5, strength: 0.3, fade: 8 },
  grime: [0.25, 0, 0, 0.6], antiTile: 1, porosity: 0.5, ao: 1,
};
const GROUND = {
  macro: [0.16, 0.08, 0.07, 0.5], detail: { map: 'micro', scale: 2, strength: 0.25, fade: 7 },
  grime: [0, 0, 0, 0.3], antiTile: 1, porosity: 0.75, ao: 1,
};
const METAL = {
  macro: [0.08, 0.06, 0.2, 0.2], detail: { map: 'micro', scale: 6, strength: 0.15, fade: 5 },
  grime: [0.55, 0.6, 0.45, 0.4], antiTile: 0, porosity: 0.1, baseH: 0.5, ao: 1,
};
const FABRIC = {
  macro: [0.1, 0.05, 0.6, 0.3], grime: [0.35, 0.5, 0, 0.35], antiTile: 0, porosity: 0.8, baseH: 0.35, ao: 1,
  detail: { map: 'wrinkle', scale: 2.5, strength: 0.45, fade: 20 },
};

/** The 20 names every system can rely on (ARCHITECTURE.md). */
export const CONTRACT = ['concrete_wall', 'concrete_floor', 'asphalt', 'brick_red', 'plaster_painted', 'metal_painted',
  'metal_rusted', 'metal_gun_black', 'polymer_gun', 'wood_planks', 'sandbags', 'dirt', 'gravel', 'glass',
  'fabric_military', 'skin', 'rubber', 'cardboard', 'corrugated_metal', 'tile_floor'];

/** Baked sets whose albedo alpha carries a paint mask (keep in sync with tools/materials/sets.mjs `paint`). */
export const PAINT_SETS = new Set(['painted_plaster_wall', 'green_metal_rust', 'green_rough_planks', 'container_side',
  'distressed_painted_planks', 'rebar_reinforced_concrete', 'rusty_metal_shutter', 'peeling_painted_wall', 'painted_metal_shutter']);

export const CATALOG = {
  // ---------------------------------------------------------------- contract names
  concrete_wall: { ...WALL, set: 'concrete_wall_007', color: 0x9a9892, rough: [1, 0.02], surface: 'concrete', desc: 'Weathered cast concrete with formwork lines' },
  concrete_floor: { ...FLOOR, set: 'concrete_floor_02', color: 0x7d7b76, surface: 'concrete', desc: 'Grimy worn concrete slab' },
  asphalt: { ...FLOOR, set: 'asphalt_02', color: 0x55534f, rough: [1, 0.03], macro: [0.07, 0.08, 0.09, 0.3], grime: [0.15, 0, 0, 0.22], porosity: 0.45, surface: 'asphalt', desc: 'Cracked aged asphalt' },
  brick_red: { ...WALL, set: 'red_brick_03', color: 0x7e4a3c, antiTile: 0, macro: [0.1, 0.05, 0.25, 0.5], grime: [0.7, 1.0, 0.7, 0.3], surface: 'brick', desc: 'Old red brick, recessed mortar' },
  plaster_painted: { ...WALL, set: 'painted_plaster_wall', color: 0xc2b89f, surface: 'plaster', desc: 'Painted render, beige' },
  metal_painted: { ...METAL, set: 'green_metal_rust', color: 0x4f6450, surface: 'metal', desc: 'Olive painted steel, chipped with rust' },
  metal_rusted: { ...METAL, set: 'rust_coarse_01', color: 0x6e4630, antiTile: 1, grime: [0.5, 0.4, 0.3, 0.3], surface: 'metal', desc: 'Heavy coarse rust' },
  metal_gun_black: {
    color: 0x2e3032, rough: [0, 0.38], metal: [0, 0.7], triplanar: 'object', surface: 'metal',
    detail: { map: 'micro', scale: 40, strength: 0.14, fade: 2.0 }, macro: [0.05, 0.1, 9, 0.0],
    wear: { amount: 1, lo: 60, hi: 200, rough: 0.22, color: 0x8a8a88 }, desc: 'Weapon steel, black oxide / cerakote, edge wear',
  },
  polymer_gun: {
    color: 0x2c2d2c, rough: [0, 0.62], metal: [0, 0], triplanar: 'object', surface: 'rubber',
    detail: { map: 'stipple', scale: 14, strength: 0.3, fade: 1.8 }, macro: [0.05, 0.08, 7, 0.0],
    wear: { amount: 0.55, lo: 70, hi: 230, rough: 0.42, color: 0x4a4a48 }, desc: 'Glass-filled polymer, stippled',
  },
  wood_planks: { ...WALL, set: 'weathered_planks', color: 0x6b5540, antiTile: 0, grime: [0.6, 0.6, 0.4, 0.4], porosity: 0.8, surface: 'wood', desc: 'Weathered dark planks' },
  sandbags: { ...FABRIC, set: 'hessian_380', color: 0x978769, size: 0.22, rough: [0.9, 0.08], normal: 1.8, macro: [0.16, 0.06, 1.2, 0.4], detail: { map: 'wrinkle', scale: 1.6, strength: 0.55, fade: 25 }, grime: [0.7, 0.9, 0, 0.8], surface: 'fabric', desc: 'Woven sack cloth, sand filled' },
  rope: { ...FABRIC, set: 'hessian_380', color: 0x8a7a5c, size: 0.12, normal: 1.8, rough: [0.8, 0.15], grime: [0.3, 0, 0, 0.4], detail: undefined, surface: 'fabric', desc: 'Hemp / sisal rope and cord' },
  dirt: { ...GROUND, set: 'dirt', color: 0x5b4c3b, macro: [0.2, 0.1, 0.07, 0.5], layer: { set: 'gravel_stones', color: 0x68635a, amount: 0.34, freq: 0.13, dark: 0.9 }, surface: 'dirt', desc: 'Dry packed earth with gravel patches and damp tracks' },
  gravel: { ...GROUND, set: 'gravel_stones', color: 0x6f6a62, layer: { set: 'dirt', color: 0x5b4c3b, amount: 0.3, freq: 0.11, dark: 0.5 }, surface: 'gravel', desc: 'Loose crushed stone' },
  glass: {
    color: 0x6a7470, rough: [0, 0.06], metal: [0, 0], glass: { trans: 0.86, smudge: 0.5, dirt: 0.1 },
    macro: [0, 0.08, 0.9, 0], side: 'double', surface: 'glass', desc: 'Dirty window glass',
  },
  fabric_military: { ...FABRIC, set: 'stretch_poplin', color: 0x4b5138, surface: 'fabric', physical: { sheen: 0.6, sheenRoughness: 0.6, sheenColor: 0x6a705a }, desc: 'Olive drab uniform cloth' },
  skin: {
    color: 0xb07e62, rough: [0, 0.52], metal: [0, 0], triplanar: 'object', surface: 'flesh',
    detail: { map: 'pores', scale: 55, strength: 0.25, fade: 1.5 }, macro: [0.06, 0.08, 6, 0.4],
    physical: { sheen: 0.25, sheenRoughness: 0.45, sheenColor: 0x8a5a4a }, desc: 'Skin',
  },
  rubber: {
    color: 0x1e1e1e, rough: [0, 0.82], metal: [0, 0], surface: 'rubber', triplanar: 'object',
    detail: { map: 'micro', scale: 25, strength: 0.25, fade: 2.5 }, macro: [0.08, 0.08, 3, 0],
    wear: { amount: 0.4, lo: 250, hi: 1200, rough: 0.6, color: 0x2e2e2c }, desc: 'Black rubber',
  },
  cardboard: {
    color: 0x9c7c52, rough: [0, 0.9], metal: [0, 0], surface: 'cardboard', macro: [0.12, 0.05, 1.4, 0.4],
    detail: { map: 'micro', scale: 7, strength: 0.25, fade: 4 }, grime: [0.5, 0.8, 0.2, 0.7], baseH: 0.2, porosity: 0.9,
    desc: 'Kraft corrugated cardboard',
  },
  corrugated_metal: { ...METAL, set: 'worn_corrugated_iron', color: 0x7f8488, surface: 'metal', desc: 'Weathered galvanised corrugated sheet' },
  tile_floor: { ...FLOOR, set: 'floor_tiles_08', color: 0xb4a996, antiTile: 0, grime: [0.25, 0, 0, 0.55], porosity: 0.15, surface: 'tile', desc: 'Worn ceramic floor tiles' },

  // ---------------------------------------------------------------- walls / facades
  concrete_dirty: { ...WALL, set: 'dirty_concrete', color: 0x8a867d, surface: 'concrete', desc: 'Stained, weathered concrete (barriers, slabs)' },
  concrete_barrier: { ...WALL, set: 'dirty_concrete', color: 0x9b978e, grime: [0.8, 1.0, 0.6, 0.7], baseH: 0.35, surface: 'concrete', desc: 'Jersey / T-wall barrier concrete' },
  concrete_panel: { ...WALL, set: 'concrete_wall_007', color: 0x8c8a84, tint: [1, 1, 1.02], surface: 'concrete', desc: 'Soviet prefab panel concrete (cooler)' },
  plaster_damaged: { ...WALL, set: 'damaged_plaster', color: 0xb3a998, antiTile: 0, surface: 'plaster', desc: 'Cracked render with exposed brick' },
  plaster_ochre: { ...WALL, set: 'painted_plaster_wall', color: 0xb99a66, surface: 'plaster', desc: 'Ochre painted render' },
  plaster_blue: { ...WALL, set: 'painted_plaster_wall', color: 0x7f97a0, surface: 'plaster', desc: 'Faded blue painted render' },
  plaster_green: { ...WALL, set: 'painted_plaster_wall', color: 0x8c9a80, surface: 'plaster', desc: 'Faded green painted render' },
  plaster_pink: { ...WALL, set: 'painted_plaster_wall', color: 0xb99486, surface: 'plaster', desc: 'Faded salmon painted render' },
  plaster_white: { ...WALL, set: 'painted_plaster_wall', color: 0xcdc8bd, surface: 'plaster', desc: 'Off-white painted render' },
  brick_dark: { ...WALL, set: 'red_brick_03', color: 0x5a3d33, antiTile: 0, macro: [0.14, 0.05, 0.25, 0.4], surface: 'brick', desc: 'Soot-darkened brick' },
  painted_wood: { ...WALL, set: 'green_rough_planks', color: 0x55675a, antiTile: 0, porosity: 0.7, grime: [0.6, 0.7, 0.5, 0.4], surface: 'wood', desc: 'Green painted planks, peeling' },
  wood_weathered: { ...WALL, set: 'weathered_planks', color: 0x7d7468, tint: [0.95, 1, 1.05], antiTile: 0, surface: 'wood', desc: 'Sun-greyed planks' },
  osb_board: { ...WALL, set: 'oriented_strand_board', color: 0x9a7c55, antiTile: 0, grime: [0.5, 0.8, 0.6, 0.4], baseH: 0.4, surface: 'wood', desc: 'OSB board (boarded windows)' },
  roof_tiles: { ...WALL, set: 'roof_tiles_14', color: 0x6a4a3c, antiTile: 0, grime: [0.6, 0, 0.3, 0.6], surface: 'tile', desc: 'Weathered clay roof tiles' },
  cinder_block: { ...WALL, set: 'concrete_block_wall', color: 0x8c8983, antiTile: 0, surface: 'concrete', desc: 'Grey cinder / breeze block wall' },
  concrete_damaged: { ...WALL, set: 'rebar_reinforced_concrete', color: 0xb3aa98, antiTile: 0, surface: 'concrete', desc: 'Painted render blown off, exposed concrete + rebar' },
  plaster_peeling: { ...WALL, set: 'peeling_painted_wall', color: 0xbcb09a, surface: 'plaster', desc: 'Cracked, peeling painted render' },
  plaster_peeling_blue: { ...WALL, set: 'peeling_painted_wall', color: 0x7f97a0, surface: 'plaster', desc: 'Cracked, peeling faded-blue render' },
  wood_painted: { ...WALL, set: 'distressed_painted_planks', color: 0x8a9384, antiTile: 0, porosity: 0.7, grime: [0.6, 0.7, 0.5, 0.4], surface: 'wood', desc: 'Grey-green painted planks, paint worn to bare wood' },
  metal_shutter: { ...METAL, set: 'rusty_metal_shutter', color: 0x8e8b82, antiTile: 0, surface: 'metal', desc: 'Roller shutter, faded paint, rust runs (shopfronts)' },
  metal_shutter_painted: { ...METAL, set: 'painted_metal_shutter', color: 0x6f8590, antiTile: 0, surface: 'metal', desc: 'Painted roller shutter / garage door' },
  roof_asbestos: { ...WALL, set: 'asbestos_sheet_02', color: 0x8d8b85, antiTile: 0, grime: [0.6, 0, 0.8, 0.7], surface: 'concrete', desc: 'Corrugated fibre-cement roofing' },

  // ---------------------------------------------------------------- ground
  concrete_pavement: { ...FLOOR, set: 'concrete_pavement', color: 0x8a867e, antiTile: 0, surface: 'concrete', desc: 'Concrete paving slabs (sidewalk)' },
  pavement: { ...FLOOR, set: 'concrete_pavement', color: 0x8a867e, antiTile: 0, surface: 'concrete', desc: 'Alias of concrete_pavement' },
  curb_stone: { ...FLOOR, set: 'granular_concrete', color: 0x9a978f, grime: [0.4, 0.9, 0.3, 0.7], baseH: 0.15, surface: 'concrete', desc: 'Kerb / curb stone' },
  cobblestone: { ...FLOOR, set: 'cobblestone_floor_001', color: 0x74716b, antiTile: 0, porosity: 0.4, surface: 'concrete', desc: 'Worn granite setts' },
  dirt_rocky: { ...GROUND, set: 'rocky_trail', color: 0x6b5e4d, layer: { set: 'dirt', color: 0x5b4c3b, amount: 0.25, freq: 0.12, dark: 0.6 }, surface: 'dirt', desc: 'Stony dirt path' },
  rubble: { ...GROUND, set: 'rubble', color: 0x7a746b, layer: { set: 'dirt', color: 0x5f5244, amount: 0.3, freq: 0.14, dark: 0.4 }, surface: 'gravel', desc: 'Broken concrete / masonry rubble' },
  scorched_ground: { ...GROUND, set: 'burned_ground_01', color: 0x2e2a26, layer: { set: 'rubble', color: 0x3c3834, amount: 0.25, freq: 0.16, dark: 0.3 }, surface: 'dirt', desc: 'Burnt earth (shell craters)' },
  paving_stones: { ...FLOOR, set: 'square_concrete_pavers', color: 0x8d8981, antiTile: 0, surface: 'concrete', desc: 'Square concrete paving slabs (plaza)' },
  roofing_tar: { ...FLOOR, set: 'tarred_gravel', color: 0x403e3b, grime: [0.5, 0, 0, 0.6], porosity: 0.3, surface: 'asphalt', desc: 'Flat roof: tar with embedded gravel' },
  sand: { ...GROUND, set: 'dense_sand', color: 0xa38d6c, porosity: 0.9, layer: { set: 'gravel_stones', color: 0x8a7f6e, amount: 0.14, freq: 0.1, dark: 0.3 }, surface: 'sand', desc: 'Packed sand (sandbag fill, hesco tops, lots)' },
  asphalt_damaged: { ...FLOOR, set: 'asphalt_02', color: 0x46433f, rough: [1, 0.03], burn: 0.35, grime: [0.3, 0, 0, 0.8], surface: 'asphalt', desc: 'Scorched, stained asphalt' },

  // ---------------------------------------------------------------- metals
  corrugated_metal_rusted: { ...METAL, set: 'rusty_corrugated_iron', color: 0x6a3e2a, surface: 'metal', desc: 'Rusted corrugated sheet' },
  metal_plate: { ...METAL, set: 'metal_plate_02', color: 0x4a4a48, surface: 'metal', desc: 'Worn riveted steel plates' },
  metal_tread_plate: { ...METAL, set: 'metal_plate', color: 0x6a6a68, grime: [0.6, 0.3, 0, 0.5], surface: 'metal', desc: 'Diamond tread plate' },
  container_metal: { ...METAL, set: 'container_side', color: 0x4f6a52, surface: 'metal', desc: 'Shipping container, green' },
  container_metal_blue: { ...METAL, set: 'container_side', color: 0x3f5a78, surface: 'metal', desc: 'Shipping container, blue' },
  container_metal_red: { ...METAL, set: 'container_side', color: 0x7a3a2e, surface: 'metal', desc: 'Shipping container, red' },
  metal_painted_white: { ...METAL, set: 'green_metal_rust', color: 0xb5b2a8, surface: 'metal', desc: 'Off-white painted steel, rust spots' },
  metal_painted_yellow: { ...METAL, set: 'green_metal_rust', color: 0xb58f2e, surface: 'metal', desc: 'Safety-yellow painted steel' },
  metal_painted_red: { ...METAL, set: 'green_metal_rust', color: 0x7a2a22, surface: 'metal', desc: 'Red painted steel' },
  metal_painted_blue: { ...METAL, set: 'green_metal_rust', color: 0x36526c, surface: 'metal', desc: 'Blue painted steel' },
  metal_painted_grey: { ...METAL, set: 'green_metal_rust', color: 0x6c6e6b, surface: 'metal', desc: 'Grey painted steel' },
  metal_painted_dark: { ...METAL, set: 'green_metal_rust', color: 0x2f312f, surface: 'metal', desc: 'Near-black painted steel' },
  metal_painted_rusty: { ...METAL, set: 'rusty_painted_metal', color: 0x6e3a2c, antiTile: 0, surface: 'metal', desc: 'Red painted sheet, heavy rust runs (dumpsters, vehicles)' },
  metal_burnt: { ...METAL, set: 'rusty_metal_04', color: 0x3e2c22, burn: 0.95, grime: [0.6, 0.3, 0.3, 0.5], surface: 'metal', desc: 'Fire-gutted steel (burnt vehicles / wrecks)' },
  car_paint_burnt: { ...METAL, set: 'rusty_metal_04', color: 0x4a3226, burn: 0.85, grime: [0.6, 0.3, 0.3, 0.5], surface: 'metal', desc: 'Burnt-out vehicle shell' },
  rebar_metal: { ...METAL, set: 'rust_coarse_01', color: 0x5a3a28, size: 0.6, rough: [1, 0.05], grime: [0.3, 0, 0, 0.3], surface: 'metal', desc: 'Rusted reinforcing bar' },
  car_paint: {
    color: 0x3b4a5a, rough: [0, 0.38], metal: [0, 0.0], surface: 'metal', macro: [0.05, 0.12, 0.6, 0.1],
    detail: { map: 'micro', scale: 4, strength: 0.05, fade: 6 }, grime: [0.9, 0.9, 0.7, 0.6], baseH: 0.45, porosity: 0.05,
    physical: { clearcoat: 0.6, clearcoatRoughness: 0.35 }, desc: 'Faded, dusty vehicle paint',
  },
  car_paint_white: {
    color: 0xb9b6ae, rough: [0, 0.4], metal: [0, 0.0], surface: 'metal', macro: [0.05, 0.12, 0.6, 0.1],
    detail: { map: 'micro', scale: 4, strength: 0.05, fade: 6 }, grime: [0.9, 1.0, 0.8, 0.7], baseH: 0.45, porosity: 0.05,
    physical: { clearcoat: 0.5, clearcoatRoughness: 0.4 }, desc: 'Faded white vehicle paint',
  },
  metal_galvanized: {
    color: 0x9a9d9e, rough: [0, 0.42], metal: [0, 1], surface: 'metal', macro: [0.12, 0.2, 2.5, 0.05],
    detail: { map: 'micro', scale: 8, strength: 0.12, fade: 4 }, grime: [0.5, 0.6, 0.5, 0.5], desc: 'Galvanised steel (poles, wire, fittings)',
  },
  metal_steel: {
    color: 0x8c8e90, rough: [0, 0.3], metal: [0, 1], surface: 'metal', triplanar: 'object', macro: [0.06, 0.12, 6, 0],
    detail: { map: 'brushed', scale: 5, strength: 0.25, fade: 3 }, desc: 'Bare machined steel',
  },
  brass: {
    color: 0xc9a060, rough: [0, 0.28], metal: [0, 1], surface: 'metal', triplanar: 'object', macro: [0.08, 0.12, 20, 0.15],
    detail: { map: 'brushed', scale: 40, strength: 0.15, fade: 1.5 }, desc: 'Cartridge brass',
  },

  // ---------------------------------------------------------------- weapons
  metal_gun_fde: {
    color: 0x7a6a52, rough: [0, 0.48], metal: [0, 0.0], triplanar: 'object', surface: 'metal',
    detail: { map: 'micro', scale: 22, strength: 0.18, fade: 2 }, macro: [0.05, 0.08, 9, 0.1],
    wear: { amount: 0.9, lo: 60, hi: 200, rough: 0.25, color: 0x8a8a88 }, desc: 'Flat dark earth cerakote over steel',
  },
  polymer_gun_tan: {
    color: 0x6e604c, rough: [0, 0.64], metal: [0, 0], triplanar: 'object', surface: 'rubber',
    detail: { map: 'stipple', scale: 14, strength: 0.3, fade: 1.8 }, macro: [0.05, 0.08, 7, 0.0],
    wear: { amount: 0.55, lo: 70, hi: 230, rough: 0.45, color: 0x857760 }, desc: 'Tan polymer, stippled',
  },
  metal_anodized: {
    color: 0x232426, rough: [0, 0.34], metal: [0, 0.9], triplanar: 'object', surface: 'metal',
    detail: { map: 'micro', scale: 30, strength: 0.12, fade: 2 }, macro: [0.04, 0.06, 9, 0],
    wear: { amount: 0.6, lo: 70, hi: 240, rough: 0.2, color: 0x9a9a9a }, desc: 'Black hard-anodised aluminium (rails, handguards)',
  },

  // ---------------------------------------------------------------- fabrics / gear
  hesco_fabric: { ...FABRIC, set: 'hessian_380', color: 0x8c8470, size: 0.22, normal: 0.9, hesco: true, macro: [0.3, 0.08, 0.35, 0.5], detail: { map: 'micro', scale: 6, strength: 0.25, fade: 8 }, grime: [0.9, 1.0, 0.9, 0.9], baseH: 0.5, surface: 'sand', desc: 'Filled blast-barrier geotextile with weld mesh' },
  tarp: { ...FABRIC, set: 'rough_linen', color: 0x4d5140, rough: [0.9, 0.1], detail: { map: 'wrinkle', scale: 1.3, strength: 0.8, fade: 25 }, grime: [0.6, 0.5, 0.3, 0.5], surface: 'fabric', side: 'double', desc: 'Olive canvas tarp' },
  tarp_blue: { ...FABRIC, set: 'rough_linen', color: 0x3a5577, rough: [0.8, 0.1], detail: { map: 'wrinkle', scale: 1.3, strength: 0.8, fade: 25 }, grime: [0.6, 0.5, 0.3, 0.5], surface: 'fabric', side: 'double', desc: 'Blue polyethylene-look tarp' },
  fabric_camo: {
    ...FABRIC, set: 'stretch_poplin', color: 0x8a8062, camo: [0xb3a07a, 0x6f5a3e, 0x6b7350, 0x3a3228],
    physical: { sheen: 0.5, sheenRoughness: 0.6, sheenColor: 0x807860 }, surface: 'fabric', desc: 'Multi-terrain camouflage cloth',
  },
  fabric_charcoal: { ...FABRIC, set: 'stretch_poplin', color: 0x34362f, physical: { sheen: 0.5, sheenRoughness: 0.6, sheenColor: 0x50524a }, surface: 'fabric', desc: 'Charcoal / dark olive fatigues' },
  fabric_crimson: { ...FABRIC, set: 'stretch_poplin', color: 0x6e1616, physical: { sheen: 0.6, sheenRoughness: 0.5, sheenColor: 0x8a3030 }, surface: 'fabric', desc: 'Crimson armband cloth' },
  fabric_black: { ...FABRIC, set: 'stretch_poplin', color: 0x1f1f1e, physical: { sheen: 0.5, sheenRoughness: 0.55, sheenColor: 0x3a3a38 }, surface: 'fabric', desc: 'Black knit / balaclava' },
  nylon_webbing: { ...FABRIC, set: 'rough_linen', color: 0x4a4c3c, size: 0.12, rough: [0.7, 0.2], physical: { sheen: 0.7, sheenRoughness: 0.4, sheenColor: 0x606452 }, surface: 'fabric', desc: 'Cordura / nylon webbing (plate carriers, rigs)' },
  leather: { ...FABRIC, set: 'brown_leather', color: 0x4a3222, rough: [0.8, 0.05], surface: 'fabric', desc: 'Worn brown leather' },

  // ---------------------------------------------------------------- misc
  plastic: {
    color: 0x5a5d58, rough: [0, 0.5], metal: [0, 0], surface: 'rubber', macro: [0.06, 0.1, 2, 0.1],
    detail: { map: 'micro', scale: 12, strength: 0.12, fade: 3 }, grime: [0.6, 0.8, 0.4, 0.5], baseH: 0.3, desc: 'Generic moulded plastic (crates, jerrycans)',
  },
  road_markings: {
    color: 0xc4c2b8, rough: [0, 0.62], metal: [0, 0], decal: true, surface: 'asphalt', macro: [0.08, 0.05, 0.4, 0],
    detail: { map: 'micro', scale: 3, strength: 0.3, fade: 8 }, grime: [0.3, 0, 0, 0.8], desc: 'Worn white road paint (decal: place 1-2 cm above road)',
  },
  road_markings_yellow: {
    color: 0xc9a23c, rough: [0, 0.62], metal: [0, 0], decal: true, surface: 'asphalt', macro: [0.08, 0.05, 0.4, 0],
    detail: { map: 'micro', scale: 3, strength: 0.3, fade: 8 }, grime: [0.3, 0, 0, 0.8], desc: 'Worn yellow road paint (decal)',
  },
};

/** Loose aliases so near-miss names from other systems still resolve to a sensible material. */
export const ALIASES = {
  concrete: 'concrete_wall', brick: 'brick_red', plaster: 'plaster_painted', metal: 'metal_painted',
  rust: 'metal_rusted', wood: 'wood_planks', fabric: 'fabric_military', sand: 'sandbags', mud: 'dirt',
  ground: 'dirt', stone: 'cobblestone', tile: 'tile_floor', tiles: 'tile_floor', roof: 'roof_tiles',
  sidewalk: 'concrete_pavement', kerb: 'curb_stone', curb: 'curb_stone', hesco: 'hesco_fabric',
  steel: 'metal_steel', aluminium: 'metal_anodized', aluminum: 'metal_anodized', plywood: 'osb_board',
  camo: 'fabric_camo', canvas: 'tarp', window: 'glass', glass_dirty: 'glass',
  sandbag: 'sandbags', sandbag_full: 'sandbags', cinderblock: 'cinder_block', breeze_block: 'cinder_block',
  pavers: 'paving_stones', paving: 'paving_stones', roof_tar: 'roofing_tar', roofing_felt: 'roofing_tar',
  shutter: 'metal_shutter', metal_trash_can: 'metal_galvanized', scorch: 'scorched_ground', burnt_metal: 'metal_burnt',
  concrete_rebar: 'concrete_damaged', plaster_cracked: 'plaster_peeling', dumpster: 'metal_painted_rusty',
};

/**
 * Source texture sets for the materials bake (tools/materials/bake.mjs).
 *
 * Every Poly Haven set here is CC0 (https://polyhaven.com/license). `id` is the Poly Haven asset id.
 * `res` is the BAKED base resolution (sources are always fetched at 2k and filtered down).
 * `size` = physical size of one texture tile in meters (from the Poly Haven API "dimensions").
 *
 * Bake options (all optional):
 *   albedo: { gain, sat, tint:[r,g,b] (linear multiply), ao (0..1 cavity baked into albedo), gamma,
 *             lift (linear add) }
 *   rough:  { gain, bias, min, max }      applied to the source roughness (perceptual 0..1)
 *   metal:  false -> metal channel forced 0 (most sets); true -> keep source metal map
 *   char:   { amount }                    burn/soot conversion (car_paint_burnt)
 */
export const SETS = {
  concrete_wall_007: { res: 2048, size: 2.2, albedo: { ao: 0.35, sat: 0.85 } },
  concrete_floor_02: { res: 2048, size: 2.0, albedo: { ao: 0.35, sat: 0.85 } },
  dirty_concrete: { res: 1024, size: 3.0, albedo: { ao: 0.3, sat: 0.8 } },
  asphalt_02: { res: 2048, size: 3.0, albedo: { ao: 0.3, gain: 0.95 } },
  red_brick_03: { res: 1024, size: 1.0, albedo: { ao: 0.45 } },
  painted_plaster_wall: { res: 2048, size: 2.0, albedo: { ao: 0.3 }, paint: { all: true } },
  damaged_plaster: { res: 2048, size: 1.9, albedo: { ao: 0.4 } },
  green_metal_rust: { res: 1024, size: 1.0, albedo: { ao: 0.3 }, metal: true, paint: { tol: 0.05, soft: 0.05 } },
  rust_coarse_01: { res: 1024, size: 2.2, albedo: { ao: 0.35 }, metal: true },
  worn_corrugated_iron: { res: 1024, size: 1.8, albedo: { ao: 0.4 }, metal: true },
  rusty_corrugated_iron: { res: 1024, size: 2.0, albedo: { ao: 0.4 }, metal: true },
  weathered_planks: { res: 2048, size: 2.0, albedo: { ao: 0.4 } },
  green_rough_planks: { res: 1024, size: 1.5, albedo: { ao: 0.4 }, paint: { tol: 0.035, soft: 0.04 } },
  dirt: { res: 1024, size: 2.0, albedo: { ao: 0.4 } },
  rocky_trail: { res: 1024, size: 2.0, albedo: { ao: 0.45 } },
  gravel_stones: { res: 1024, size: 2.0, albedo: { ao: 0.5, gain: 1.35, sat: 0.8 } },
  rubble: { res: 1024, size: 2.0, albedo: { ao: 0.45 } },
  cobblestone_floor_001: { res: 1024, size: 2.4, albedo: { ao: 0.45 } },
  roof_tiles_14: { res: 1024, size: 1.5, albedo: { ao: 0.45 } },
  asbestos_sheet_02: { res: 1024, size: 1.8, albedo: { ao: 0.4 } },
  floor_tiles_08: { res: 1024, size: 1.5, albedo: { ao: 0.35, sat: 0.8 } },
  concrete_pavement: { res: 2048, size: 1.8, albedo: { ao: 0.4 } },
  granular_concrete: { res: 1024, size: 2.4, albedo: { ao: 0.3 } },
  hessian_380: { res: 1024, size: 0.3, albedo: { ao: 0.4, sat: 0.0 } },   // greyscale: tinted per material
  stretch_poplin: { res: 1024, size: 0.3, albedo: { ao: 0.3, sat: 0.0 } },
  rough_linen: { res: 1024, size: 0.3, albedo: { ao: 0.3, sat: 0.0 } },
  metal_plate: { res: 1024, size: 0.5, albedo: { ao: 0.3 }, metal: true },
  metal_plate_02: { res: 1024, size: 2.0, albedo: { ao: 0.3 }, metal: true },
  rusty_metal_04: { res: 1024, size: 2.0, albedo: { ao: 0.35 }, metal: true },
  burned_ground_01: { res: 1024, size: 1.0, albedo: { ao: 0.4 } },
  oriented_strand_board: { res: 1024, size: 2.5, albedo: { ao: 0.25 } },
  brown_leather: { res: 1024, size: 0.4, albedo: { ao: 0.3 } },
  container_side: { res: 1024, size: 1.9, albedo: { ao: 0.35 }, metal: true, paint: { tol: 0.05, soft: 0.05 } },
  // ---- session 2 additions (all CC0 Poly Haven)
  concrete_block_wall: { res: 1024, size: 2.0, albedo: { ao: 0.45, sat: 0.6 } },
  square_concrete_pavers: { res: 1024, size: 1.8, albedo: { ao: 0.4, sat: 0.35 } },
  tarred_gravel: { res: 1024, size: 2.2, albedo: { ao: 0.35 } },
  distressed_painted_planks: { res: 1024, size: 1.6, albedo: { ao: 0.35 }, paint: { tol: 0.025, soft: 0.03 } },
  rebar_reinforced_concrete: { res: 1024, size: 2.0, albedo: { ao: 0.4 }, metal: true, paint: { tol: 0.05, soft: 0.05 } },
  rusty_metal_shutter: { res: 1024, size: 1.9, albedo: { ao: 0.4 }, metal: true, paint: { tol: 0.02, soft: 0.03 } },
  peeling_painted_wall: { res: 1024, size: 1.8, albedo: { ao: 0.35 }, paint: { tol: 0.03, soft: 0.04 } },
  dense_sand: { res: 1024, size: 1.8, albedo: { ao: 0.4 } },
  rusty_painted_metal: { res: 1024, size: 2.2, albedo: { ao: 0.35 }, metal: true },
  painted_metal_shutter: { res: 1024, size: 2.0, albedo: { ao: 0.4 }, metal: true, paint: { all: true } },
};

/** Neutral HDRI used only by the materials gallery presets when the lighting service is absent. */
export const HDRIS = {
  kloofendal_48d_partly_cloudy_puresky: { res: '1k' },
};

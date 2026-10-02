# materials — PROGRESS (resumable checkpoint)

## Architecture (what exists)
- `index.js` service (`services.materials`): get/has/list/clone/surfaceOf + info/catalog/setWetness/
  setWeathering/setGroundLevel/stats/setDebugView/detailNormal/noise. Variants `name@tri|obj|clean|burnt`.
- `catalog.js` all definitions (contract names + ~50 extras) + ALIASES.
- `shader.js` "OM" onBeforeCompile injection into MeshStandard/Physical: baked set sampling (albedo BC1 sRGB,
  normal BC5, mask BC3 = metal/rough/ao/height), stochastic anti-tile, triplanar world/object, detail normals,
  macro variation, world-space grime (dust up-facing, base dirt, rain streaks, blotches), edge wear from
  screen-space curvature, burn, camo, hesco mesh, dirty glass, decal paint, global wetness/puddles, debug views.
- `omat.js` loader for baked `.omat` (compressed textures with CPU mip chains, CPU BC decode fallback).
- `tools/materials/`: fetch.mjs (Poly Haven CC0 -> cache outside repo), bake.mjs (-> .omat), sets.mjs (set
  list + bake options), bc.mjs (BC1/3/5 encoders), shoot.sh (batch shots).
- Shots `src/shots/materials.js`: materials-gallery, -gallery-extra, -gallery-neutral, -swatches, -walls,
  -ground, -weapon, -weapon-close, -glass, -wet, -debug-<channel>, -closeup-<name> (every catalog name).

## Session 2 (resumed) — audit findings
- All presets render clean (no system errors).
- BUG: shader overwrote diffuseColor -> world's tinted clones (`metal_painted#yellow`, `plaster#ochre`...) lost tint.
- World WISHLIST names missing in catalog: roofing_tar, paving_stones, wood_painted, cinder_block, metal_burnt.
- All 33 sets loaded eagerly (~171 MB GPU) even if unused.
- Gallery labels partially blank; glass lacks reflection; weapon metal looks leathery.

## Done this session
- FIX: shader now multiplies material.color (tinted clones work). Paint sets use it as paint colour instead.
- PAINT MASKS: bake.mjs `paint` option (auto dominant-chroma detection) -> albedo BC3 with alpha = paint mask,
  paint pixels neutralised; shader OM_PAINT recolours only paint (catalog `color` = paint colour). Sets:
  painted_plaster_wall, green_metal_rust, green_rough_planks, container_side + new ones. `--preview <dir>` writes masks.
- New Poly Haven sets (1k): concrete_block_wall, square_concrete_pavers, tarred_gravel, distressed_painted_planks,
  rebar_reinforced_concrete, rusty_metal_shutter, peeling_painted_wall, dense_sand, rusty_painted_metal, painted_metal_shutter.
  Downsized to 1k: dirty_concrete, rust_coarse_01, worn_corrugated_iron, dirt, rubble, cobblestone_floor_001. Disk 134 MB.
- New names: cinder_block, concrete_damaged, plaster_peeling(_blue), wood_painted, metal_shutter(_painted), paving_stones,
  roofing_tar, sand, metal_painted_{white,yellow,red,blue,grey,dark,rusty}, metal_burnt + aliases (sandbag, pavers...).
- LAZY set streaming (requestSet on first get/clone, tracked by ctx.assets); ready = shared + contract sets.
  preload(names). stats() has perSet MB. graphics.quality 'low' drops top mip (omat buildTextures skip).

## Next steps / known issues
- (session 2 left this empty; see session 3 below)

## Session 3 (resumed after usage-limit cut) — done
Audit: gallery / walls / weapon-close / world-mainstreet / world-alley all clean (no system/console errors).
Fixed the most visible in-game material problems:
- ROAD MARKINGS (shader OM_DECAL v2): the old hard noise threshold made crosswalks look like a dalmatian pattern
  (black blotches everywhere). Now: an intact paint film, broad traffic-worn zones that go thin (partial alpha)
  and grimy, sparse aggregate speckle (denser where worn), and ragged flaked chips clustered in worn zones. Albedo
  lowered 0xd8d6cc -> 0xc4c2b8 (weathered paint, not print white). Verified: materials-closeup-road_markings, world-mainstreet.
- WALL "MOUNTAIN RANGE" ARTIFACT: tinted painted-plaster walls (ochre / blue...) showed a jagged dark silhouette
  mid-wall. Cause: the rain-streak wash hung from a storey source line jittered by a fast noise (0.25 m @ 0.9/m).
  Jitter cut to 0.05 m and the wash now fades in softly below the source. Also rising-damp line v2 (long gentle
  undulation, soft upward fade, 0.24 darkening). Anti-tile height blend softened (x2.0 + h*0.8, smoothstep).
- AGED PAINT (OM_PAINT sets): world-space sun-chalked patches (desaturated, lighter) plus patchy darker repaint,
  scaled by macro hue amount (walls strong, metal lighter). Facades no longer read as flat CG colour.
- ASPHALT ALBEDO: 0x3f3e3d (fresh, ~0.05 linear) -> 0x55534f (~0.09, aged / dusty); asphalt_damaged 0x383634 -> 0x46433f.
  Roads now read grey with visible cracks instead of navy-black in shade.
- PROGRAM_VERSION om-6. tools/materials/qs.sh = quick shot + one-line error summary (`sh tools/materials/qs.sh <tag> <preset>...`).
Perf (tools/perf.mjs core-perf, other agents running concurrently): p95 12.4 ms / GPU avg 8.6 ms / 1181 draws /
4.5 M tris (a first run under contention hit 18.7 ms p95). Shader changes are a few ALU + 3 noise taps in decals only.

## Next steps (prioritized)
1. Alley ground (world-alley) renders near-black and featureless: not asphalt (unchanged by the albedo fix); find
   which catalog name/tint world uses there (world/mats.js WISHLIST or a 'w:' material) and give it a proper
   ground albedo (~0.1-0.15) / layer mix; coordinate via services only.
2. Glass: panes over brick are nearly invisible (materials-glass). Add edge/frame grime (needs pane-space UV
   convention from world), slightly lower transmittance (~0.78) and a greenish-grey film; keep premultiplied path.
3. Weapon edge wear on metal_gun_black shows blocky square chips at close range (tri-sampled noise at 41/m);
   switch to a smoother two-octave threshold. Low in-game impact (weapons system uses its own materials).
4. painted_wood (green_rough_planks) paint mask reads as white speckle at distance on the truck bed; darken the
   bare-wood chips or re-bake with a softer paint tolerance.
5. Texture memory report + lazy streaming are in place (stats().perSet); re-check totals once world settles.

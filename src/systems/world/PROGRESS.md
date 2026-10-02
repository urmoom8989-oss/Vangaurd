# world — progress log

## Architecture (as found, 2026-09-23 resume)
- `index.js` system + service API (contract + extensions: lineOfSight, coverPoints, ledges, findLedge, zones, zoneAt, playBounds, nav.isWalkable/nearestWalkable).
- `builder.js` GeoBuilder: all static geometry is emitted into per-(chunk, material) batches with meter UVs; also builds ray/move collision streams (three-mesh-bvh in `collision.js`).
- `town.js` layout data (buildings, OOB buildings, roads, spawns). `buildings.js` modular facades (walls with real thickness, openings, damage holes/collapse). `details.js` world-owned materials (interior mapping, broken glass, decal atlas, signs), shopfronts, damage dressing, facade extras, roof clutter. `dressing.js` hand-placed set dressing per area. `objects.js` procedural objects (barriers, vehicles, furniture, trees...). `props.js` instanced Poly Haven models + procedural instanced props (sandbags, foliage cards). `textures.js` canvas textures. `ground.js` terrain/roads/sidewalks. `nav.js` 0.5 m grid nav + cover points.
- Tools: `tools/world/probe.mjs <preset> <script.js>` evaluates code in page; `tools/world/stats.js` = per-mesh triangle breakdown. `tools/world/fetch-polyhaven.mjs` downloads models.

## Audit (resume)
- World: ~1.43M tris (1.32M shadow casters), 174 draws. 4 CSM cascades => ~5-7M tris rendered in ENV-only shots. Budget pressure.
- Weak visuals: crude trucks/cars/bus (boxes, octagonal wheels), blotchy crosswalk decals, flat red "spalled plaster" wall decals, boxy grass cards, fuel pumps as boxes, no real balconies (balcony doors only), mostly cream facades (little color variety), flat plaza paving.

## Plan / status
- [x] Vehicles rebuilt (sedan, burnt car, van, military truck, tanker, bus) — vehicles.js + vehicleAtlas.js (earlier session)
- [ ] Decals: road markings / crosswalk, spalled plaster, cracks
- [ ] Foliage: grass tuft cards + texture, trees
- [ ] Facade variety (catalog plaster_* / brick_dark / roof materials), balconies
- [ ] Plaza paving (cobblestone), fuel depot detail (pumps, canopy fascia)
- [ ] Perf: cut shadow-caster tris (sandbag LOD, heavy Poly Haven props, ground not casting)

## Session 2026-09-23 (resume #2)
Done (verified with world-plaza / world-mainstreet / world-alley / world-player-eye / world-dev-truck / world-dev-truckfront shots):
1. **Plaza + sidewalk paving scale** (ground.js): catalog `paving_stones` (square_concrete_pavers) packs ~8 slabs/m at 1 repeat/m,
   which read as bathroom mosaic. Now UV-scaled: plaza field `PLAZA_SLAB_UV=0.32` (~0.4 m slabs), inner square
   `paving_stones#grey` at `SETT_UV=0.24` (bigger, darker slabs for structure), sidewalks `WALK_SLAB_UV=0.4`.
   Tried catalog `cobblestone` for the inner square: looks great in sun but renders near-black in shade (materials-side AO/albedo
   issue, reported) -> not used.
2. **Puddles** (details.js/dressing.js/textures.js): were opaque pale-blue "paint blobs". Root cause: three ignores
   `material.envMapIntensity` when IBL comes from `scene.environment` (uses scene.environmentIntensity). Puddle mesh now binds
   `scene.environment` as its own envMap in onBeforeRender (no alloc) so its intensity (0.16) applies; darker, 0.86 opacity;
   alpha masks get ragged rims (46 satellite blobs); each puddle gets a darker wet stain halo decal underneath.
3. **Truck wheels / cab** (vehicles.js): `wheel()` gained `tread` (staggered off-road lug blocks, shadow-less), a rim lip ring
   and wheel nuts on all intact wheels. Truck cab doors got proud window frames, lower seam, stamped rib, hinges, drip rails, a
   sun visor and roof marker lamps.
4. **Plaza grime**: more dirt/stain decals (dirt 90, stains 44).
5. **Shadow budget**: trashbag / cement_bag / rollershutter windows no longer cast CSM shadows (world shadow-caster tris 977k -> 924k).

Perf (tools/perf.mjs core-perf, full game): p95 15.6 ms (pass, but tight), GPU avg 9.0 ms, CPU avg 8.6 ms, 1178 draws, 4.56M tris.
World root: 1.19M tris, 322 meshes.

## Next steps (prioritized)
1. Paving still a perfectly regular grout grid: add a world-owned slab-variation decal layer (random slab tint / missing slabs /
   broken slabs with rubble) or ask materials for a less contrasty paver set with per-slab tint variation.
2. Sedan: rear wheel pokes out of the body at odd angle (see world-dev-car); car greenhouse reads as wireframe (thin pillars,
   near-invisible glass). Truck cab is still a single extruded slab — add cab back window frame, door recess, bumper detail.
3. Crosswalk / road markings: high-contrast black speckle wear reads noisy (catalog `road_markings` material; ask materials
   for softer wear, or overlay dirt decals on the stripes).
4. Litter decals near jersey barriers can show over the barrier face (slope-scaled polygonOffset at grazing angles?) —
   reduce polygonOffsetFactor for ground decals or reject decals within 0.5 m of barrier footprints.
5. Perf: p95 close to 16.6 ms; biggest world lever is shadow casters (sandbag instances ~104k tris x cascades; metal_rusted
   and galvanized batches). Consider per-cascade layer masks with lighting, or a sandbag shadow proxy (1 box per wall run).
6. Clothes-line garments are flat cards (alley) — add slight cloth curvature/doubling.
7. Depot canopy fascia sign (objects.js canopy(), ~line 538) reads mirrored in world-depot. Flipping U alone made it render
   upside-down (so the quad/atlas orientation is off in both axes, or the visible sign is a different face) — reverted;
   debug with a close-up preset before changing.

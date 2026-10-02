# combat — progress log

## State at resume (audit, session 2)
Existing and working (previous owner):
- `tables.js` surface ballistics / zones / weapon profiles / explosives / grenade tuning
- `ballistics.js` hitscan: world raycast + hitboxes + analytic player capsule, penetration with exit
  measurement, ricochet, falloff, zone multipliers, pooled results/events, near-miss
- `damage.js` registry (registerDamageable, armor, heal, boundsOf)
- `explosions.js` radius damage w/ multi-sample occlusion (thin layers transmit), impulse event, scorch
- `grenades.js` own deterministic integrator (swept ray + capsule depenetration), cook/throw, spoon
- `grenadeModel.js` procedural frag model; `fixtures.js` test range; `debugDraw.js`
- `tools/combat/test-ballistics.mjs` 54/55 passing at audit (grenade rest test failed: world terrain
  now extends to z=260 and pokes through the test range floor)

Audit findings (integration):
- weapons applies its own spread AND passes `spread` -> double spread. Fix in combat: detect a
  pre-spread direction (player source, direction != camera forward) / honour `spreadApplied`.
- weapons has its OWN grenade (pressed 'grenade' -> clip -> own integrator) -> combat's input
  cook/throw doubled the grenade. Fix: combat grenade input 'auto' = off while weapons handles lethals.
- ai is being rewritten (no registerDamageable yet); its hitboxes (userData.zone head/torso/limb) are compatible.

## Work log
(see below, newest last)

### Session 2 — done
- ballistics: spread = cone HALF-angle (max deviation, AI loadouts are tuned on it); skipped when the caller pre-spread (player dir != camera
  boresight) or `spreadApplied: true`. Player tracers start at the eye so vfx snaps them to the muzzle.
  Ricochet fx on hard surfaces (sparks + occasional skipping tracer).
- grenades: `combat.grenadeInput` 'auto' (default) yields the key to weapons when it manages lethals
  (weapons.state.lethal is a number or 'weapons:grenade' seen). `grenadeInputOwned()` added.
  Bounce dust uses vfx `scale`.
- explosions: cosmetic fragment spray (EXPLOSIVES[type].fragments / fragRange): deterministic rays,
  pits (bullet decals 6-13 cm) + a few impact puffs on nearby surfaces; report.fragmentHits.
- grenade model: splined 72-seg lathe, normal map (orange peel + weld bead), worn stencil, tone drift,
  tighter spoon, ring/pin re-rigged. New preset combat-grenade-model.
- fixtures: extruded cardboard silhouette targets (printed zones, stakes, steel foot, invisible zoned
  hitboxes), running-bond pillow sandbag walls.
- presets: combat-grenade-arc restaged (fuse 1.62, detonation in frame; --sequence 14 --interval 150),
  new combat-grenade-aftermath.
- tests: range lifted to y=25 (terrain); new spread / fragment / input-ownership tests. 60/60.
- ai (rewritten) registers its own damageables (key 'ai:<id>', capsule hitboxes) and throws its grenades
  through combat.throwGrenadeAt -> combat grenade physics/model ARE in game via the AI.
- explosions: fragment vfx queued, flushed 14/frame (explode() 2.2 ms -> ~0.55 ms).
- fixtures: fixed silhouette head arc (asin of out-of-range value -> NaN shape).

# Lighting — progress log (keep current; another agent may resume from here)

## State at hand-over #2 start (inherited)
- index.js: service (sun = three SunLight + CascadedSunShadow 4 cascades in 2x2 atlas, texel-snapped),
  photographic sky dome (Poly Haven HDRIs baked by tools/lighting/bake-sky.mjs to HDR-encoded JPEG),
  PMREM env from an env-dome (sky + lit ground + urban horizon), presets golden_hour/overcast/dusk.
- chunks.js: global ShaderChunk patches: height fog + aerial perspective + sun in-scattering + optional
  volumetric shadowed in-scatter (ray-marched sun cascades inside every lit material's fog chunk);
  4-cascade getSunShadow with vogel PCF; sky-visibility (skyvis.js height-field bake) occluding IBL.
- skyline.js (procedural OOB town ring + ridges), smoke.js (distant smoke ribbons), lab.js (test block).

## Work log (this session)
- audit: shot cameras did not match the current world layout; smoke columns read as tornadoes; skyline
  read as white placeholder boxes; haze too milky / whiteout toward the sun.
- DONE shot presets re-targeted to the real town (see src/shots/lighting.js): street-wide, street-sun,
  alley-shafts, skyline, skyline-sun, shadow-closeup, overcast, dusk, smoke, smoke-sun, sky-* debug,
  lighting-perf* (perf variants of core-perf).
- DONE golden_hour sky -> Poly Haven table_mountain_2_puresky (baked sky_golden_hour_2.jpg/json);
  sky/env/fog-horizon saturation controls (postfx AgX desaturates blues heavily).
- DONE phase function = mix(isotropic, HG, weight); sunScatter 0.3->0.14, density/air reduced,
  skyHaze 0.3->0.12, horizonFlatten 0.75, cooler ambient haze tint.
- DONE smoke.js rewritten: instanced billow-puff sprites (baked atlas w/ normals), buoyant rise, wind
  shear, self-shadow, fire glow, 1 draw call, 670 instances.
- DONE skyline facade texture rewritten (36 m tile, panel seams, loggias, soot, streaks), darker
  palette, fewer towers, dark ridges with ridge fog scale 0.7.

- (between sessions) golden_hour sky -> sky_golden_hour_3 (baked), sunAzimuth 128 / elevation 19, adaptive
  eye exposure (stop down toward the sun, open up in covered spots), indoor dust boost from sky visibility.

## Session #3 (this hand-over)
- DONE `lighting.tweak(patch)` service extension: deep-merges a partial preset into a private copy of the
  active preset and re-applies (debug, shot A/B, gamemode mood). Shot helper `abSun(patch)` in shots/lighting.js.
- DONE haze start distance (`haze.start`, atmo slot [23].z, GLSL `lgtOpticalDepthFrom`, CPU mirror in
  fogTransmittance): golden 22 m / overcast 6 m / dusk 14 m. Near-field shadowed surfaces were veiled by the
  bright horizon in-scatter (the shadow side of a facade is only ~0.3x sky median, so even 7 % haze washed it
  out). Diagnosis: with haze param tweaks (density/mieG/sunScatter) the look barely changed; the ambient
  horizon term dominated.
- DONE art-directed light shafts: shaft mask in lgtVolumetricSunVis (rays crossing BOTH shadow and sun get
  `1 + gain` x dust; fully lit open-air rays keep the weak dust so plazas are not veiled). Gain = slot [23].w,
  set per frame = dust.shaftGain + dust.indoorShaftGain * (1 - skyVis at camera). golden: 2 / 150.
  (outdoor gain 40 whitewashed backlit facades in street-sun: do not raise outdoor gain much above ~4.)
- DONE cheap bounce GI: covered spaces keep `bounceFill` (rgb fraction, slot [24], ATMO_SIZE 24->25) of the
  sky irradiance instead of ~4 % (interiors were crushed black; now readable with a warm fill).
- DONE perf: adaptive volumetric step count (steps * clamp(L/maxDist, 0.3, 1), min 3). Volumetrics were the
  dominant lighting GPU cost (lighting-perf gpu avg ~17.6 ms vs ~6 ms with -novol in one noisy run; after the
  change 6-8 ms avg / ~11 ms p95 — machine shared with other agents, numbers are noisy).
- DONE lighting-alley-shafts re-framed to a backyard where a real shaft reads (-45,1.7,30 -> -25,4.5,45);
  new lighting-hall-shafts (dark hallway + doorway beam). Debug: lighting-dbg-sun-*, lighting-ab-*.

## Known issues / next steps (priority order)
1. street-sun: facades 35-60 m toward the sun are still fairly milky (sun-side horizon asymptote). Try a
   separate, lower in-scatter asymptote for the ambient term toward the sun sector, or raise horizonFlatten.
2. Volumetric cost is still the biggest lighting GPU item: consider marching only cascades 0-2, dropping the
   per-step exp(), or quality 'high' steps 12 -> 10. Measure with lighting-perf vs lighting-perf-novol
   (run 2-3 times; other agents make timings noisy).
3. Interior exposure (+0.9 EV in covered spots) + bounce fill may be a touch bright/flat in lighting-interior-shafts;
   tune bounceFill (0.24,0.18,0.13) or the covered EV together.
4. Skyline towers: window grid reads as light cells in haze at distance; make distant windows darker than walls.
5. Fine dither grain from the volumetric jitter is visible on flat facades inside shafts without TAA.


## Session 2026-09-23 (perf-fixer)
- CascadedSunShadow: per-cascade caster filter (`CascadeFrustum`). The far cascade (55-150 m) skips casters whose single-piece
  world radius < 0.75 m (sandbag instances, crates, debris: 1-2 texel shadows there). Nearer cascades unchanged. Smoke shot
  4.68M -> 4.39M tris, 1266 -> 1159 draws; no visible change in smoke / world shots.

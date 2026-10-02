# postfx — progress log

Owner: postfx agent. Custom render graph in `Pipeline.js` (pmndrs `postprocessing` only for SMAA on low/medium).

## Done (inherited from previous owner, audited 2026-09-23)
- World pass (HDR half-float + float depth) -> viewmodel pass with compressed depth range [0, VM_K] (own near plane,
  never clips) -> half-res GTAO (world + viewmodel radii) with bilateral denoise/upsample, multiplied into HDR
  -> FX layer pass -> TAA (Halton, depth reprojection, viewmodel-transform reprojection, YCoCg variance clip)
  -> bloom (13-tap Karis/soft-knee chain) -> sun shafts (sky mask + radial blur) + 1x1 sun visibility probe
  -> ADS weapon DOF (half-res CoC + gather) -> final uber pass (camera MB, CAS, edge CA, DOF comp, bloom, rays,
  procedural flare, AgX+CDL look / ACES / neutral, lift-gamma-gain + split tone, vignette, pulses, grain, dither).
- Pulses: damage, flashbang (afterimage), explosion, concussion, hitmarker, suppression, heal; low-health + death.
- Quality tiers low/medium/high/ultra; settings hooks; debug views; shot + perf presets in src/shots/postfx.js.
- Measured cost (audit): ~0.7 ms GPU avg at 1080p on the RTX 5070 (postfx-perf-on vs -off).

## In progress (this session)
- see "Session log" below.

## Known issues / next steps
- see "Session log".

## Session log
- audit: all presets run clean (no system/console errors). Issues found: sun-flare preset does not show the sun
  (hidden behind a building); explosion radial blur shows discrete ghost copies; grade is a bit flat / sky reads
  grey-beige; damage pulse tints the whole frame pink; world contact AO is weak.

## Tools
- `tools/postfx/shots.sh <prefix> preset...` runs presets into shots/postfx/<prefix>_<preset>.png and prints errors.

## Session 2026-09-23 (perf-fixer: load time)
- **Shader warm-up fix (index.js)**: the scene renders into `pipeline.sceneRT` (linear output), but ShotController's
  `renderer.compileAsync(scene, camera)` ran with the canvas bound (sRGB output), so it warmed the wrong program variants and
  ~70 scene programs + all pass programs compiled synchronously on frame 1 (~18 s freeze on ANGLE/D3D11; the real game had no
  precompile at all). postfx now wraps `renderer.compileAsync` to compile against sceneRT, plus every pass ShaderMaterial
  (with the runtime quad geometry + ortho camera; `final` against the canvas). Outside shot mode the first `render()` starts
  the warm-up (tracked via `ctx.assets`) and skips drawing until it resolves (20 s safety timeout). Background re-warm
  (debounced, never skips frames) on gamemode:start/wave/respawn, ai:spawn, hud:play. Restored in dispose().
- Result: core-perf ready 25.4 s -> ~7 s; smoke shot ~31 s -> 8 s; frame-1 sync compiles 71 -> 4 (shadow depth only).
- Remaining: shadow-depth programs (4) still compile on frame 1 (~0.5 s); `vfx_muzzle_flash` compiles on first shot (vfx owner:
  keep a hidden instance in the scene so compileAsync sees it).

# audio — progress log (resume point for any agent)

## State at resume (2nd owner, 2026-09-23)
Inherited a large, working procedural audio system:
- `dsp.js` sample DSP toolbox (SVF, biquads, modal resonators, grains, limiter, tone-match, decorrelation).
- `sounds/*.js` ~150 synthesized sounds, all deterministic (seeded `Rand`), baked in a Web Worker at boot
  (`bake.worker.js`, priority-ordered: guns/hitmarkers first).
- `engine.js` runtime graph: voices -> lowpass (air absorption + occlusion) -> HRTF panner -> buses; A/B
  convolver reverb with procedural IRs (`ir.js`: street/open/alley/room/hall); glue comp + limiter; duck;
  concussion; low-health heartbeat/muffle; speed-of-sound delay; supersonic snap before report; flybys.
- `ambience.js` AmbienceDirector (wind, war bed, artillery, distant fire, birds, tarps, creaks, fires).
- `scenes.js` offline mix scenes for `tools/audio.mjs scene_*`.
- `index.js` service + event wiring + env probing (9 world rays -> reverb preset) + occlusion raycasts.

## Done this session
- Tools: live.mjs/probe.mjs wait for all systems and survive the dev server's boot-time reload; AudioWorklet
  recorder. NEW rp.mjs (batch render through the runtime graph with params, e.g. noMaster/noReverb/env),
  peval.mjs (eval in the ?shot=__audio__ page), env.py (short-time envelope table).
- FIX (big): master dynamics. WebAudio DynamicsCompressor applies auto makeup gain; old glue (-18 dB, 2.5:1)
  flattened gunshots and lifted every tail. Now glue -6 dB/1.6:1/12 ms attack + limiter -1.2 dB.
- FIX (big): offline renders started while the compressors' gain was still ramping from 0 (first ~100 ms
  ~8 dB quiet). Engine now separates engine time from context time (`timeBase`); renderOffline pre-rolls
  0.3 s and trims it. All earlier critic renders were affected.
- FIX: voice limiting is now timeline-aware (counts voices overlapping the new start time): offline scenes
  (and speed-of-sound-delayed sounds) no longer steal each other; footsteps scene was nearly silent.
- NEW: geometry-aware early reflections (engine `_buildER/setReflection/_updateER`): 9 taps (8 horizontal
  probe rays + ceiling) with delay 2d/c, surface reflectivity gain, air/surface lowpass, stereo pan relative
  to the camera (per frame). Fed by own weapon (def.er), near 3P shots and near explosions. Offline renders
  use `REFLECT_PRESETS` (ir.js) per environment (or params.walls).
- NEW: aliases for names weapons calls directly (rifle_mag_out, rifle_bolt_release, fire_mode, grenade_bounce
  (+surface ray), rifle_equip, rifle_rattle, rifle_magSwap, rifle_magTap, rifle_inspect_start...) and new
  sounds: reload_grab, mag_pouch, mag_tap, weapon_rattle, pistol_rattle, weapon_inspect, pistol_raise,
  grenade_equip, shell_tink_* (per real vfx casing bounce), breath_recover (player:regen).
- NEW: 2D cue de-dupe (same name within `minGap`, default 90 ms) — several systems report the same cue.
- NEW events: weapons:cue (stops progress-derived reload choreography), weapons:firemode, vfx:shell_bounce,
  combat:near-miss (guaranteed flyby), ai:grenade, player:regen.
- Tone balance: catalog `tone` field (octave target curve, auto tone-match after synthesis). Footsteps per
  surface, landings, gun mechanics (bolt/charging/mag seat were dominated by a 150 Hz "kick"), soft impacts,
  bodies, grenade clunks, kill hitmarker.
- Ambience: war bed quieter (vol .45 -> .2) with slow swells; outdoor ambience lowpassed/attenuated indoors.

## Next
- Live in-game capture (tools/audio/live.mjs) once other systems are stable; verify event wiring end-to-end.
- Perf check with tools/perf.mjs (audio work is mostly on the audio thread; main thread: probes/occlusion).
- Music stingers quality review; distant/3P gunshot review; explosion review.

## Known issues
- The dev server reloads the page once shortly after boot (not audio; happens with audio excluded).
- Another agent's temporary breakage can make live.mjs fail; rerun.

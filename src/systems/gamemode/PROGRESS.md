# gamemode — progress log (resume point for the next owner)

## Layout
- `index.js` flow state machine + service (`services.gamemode`), scoring, streaks, waves, death/redeploy, pause, scenario() for shots.
- `config.js` pure tuning tables (difficulties, score values, streak names, waveSpec()).
- `spawner.js` spawn-point scoring (out of view / occluded / flank behind player / lane variety) + squad placement via
  `services.ai.spawn`. Falls back to a synthetic ring of points around the map centre if `world.spawnPoints.ai` is empty.
- `cinematic.js` slow crane orbit (12.5 m high, framing offset so the plaza sits right of frame) behind the end-of-game
  summary (and the fallback main menu). Uses `world.cameras.menu` if the world ever publishes it.
- `storage.js` localStorage personal bests (disabled in shot mode).
- `ui.js` + `styles.js` DOM overlays in #ui: intro stamp, objective card, countdowns, wave-cleared card, fallback tracker,
  fallback death screen, summary; fallback main/pause/settings menus when the hud does not publish `openMenu`.
- `src/shots/gamemode.js` presets; `tools/gamemode/{shoot,playtest,inspect}.mjs`.

## HUD coexistence
The hud publishes `openMenu/closeMenu/menu`, `banner`, `scorePopup`, `setMatchInfo`, `stats`. When present, gamemode
yields main/pause/settings/death screens to the hud (hud emits `hud:play`, `hud:pause`, calls `gamemode.start/end('quit')/respawn`),
and routes wave banners / XP / medals through `hud.notify`. Gamemode keeps: intro stamp, objective card, countdowns,
wave-cleared card, end-of-game summary. Gamemode drives the hud match panel via `hud.setMatchInfo` (only on change):
warmup hides the wave row + shows "Assault in m:ss"; intermission shows "Next wave in m:ss"; live clears overrides.
NOTE: changing the wave number shown by the hud triggers its auto wave banner unless gamemode already sent a
`notify(kind:'wave')` — keep that in mind before overriding `wave`.

## Status
- Playtest (`node tools/gamemode/playtest.mjs --minutes 3 --shots`): 20/20 checks PASS with the REAL ai system
  (waves spawn via ai.spawn, kills/headshots scored, resupply, skip, pause, death→redeploy, overrun→summary, restart).
- All presets render clean (no gamemode errors): menu (hud-owned), intro, wave-live, intermission, death (hud-owned),
  pause (hud-owned), gameover, victory, endcam (debug), perf, playtest.

## Session 2 work (done)
- Resupply uses `weapons.addAmmo(9999)` (clamped by weapons) + `addGrenades` top-up to 2 lethals.
- `hud.setObjective(text, {position: objective})` so compass/minimap show the plaza marker.
- hud match-panel sync (see above), zero per-frame string work (only on second change).
- Wave-cleared card redesign: 4-stat strip (eliminated / headshots / accuracy / wave time), staggered bonus rows with
  count-up, wave-bonus total, resupply row, next-wave row with timer. Per-wave shots/hits/headshots tracked.
- Scenario: `quiet` waves (no banner) for intermission/dead/ended/pause captures; `announceAt` (delayed banner);
  `invulnerable`; `waveTime`, `stats.waveShots/waveHits/waveHeads`; scenario stats also mirrored into `hud.stats`.
- wave-live preset now at the station-road barricade looking north with real AI squads advancing (warmup 540 frames).
- Summary: lighter backdrop so the crane shot reads, per-kind medal glyphs, wider wave chart bars.
- Cinematic: crane orbit above canopies (old 4.6 m orbit sat inside tree canopies).

## Known issues / next steps
- hud names killers "VANGUARD 1" (hud/ai naming, not gamemode).
- Shot harness occasionally reports "Execution context was destroyed" or a black frame when other agents' edits
  trigger reloads; rerun.
- Ideas: per-wave spawn telegraph (compass ping for the first squad), overrun cinematic with live AI, endless mode tuning.

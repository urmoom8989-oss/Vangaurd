# HUD — progress log

## State at resume (audit, session 2)
Files: index.js (service, event wiring, per-frame), style.js (all CSS, `--u` = 1px@1080p), compass.js,
minimap.js (GPU height bake of world -> styled 2D canvas), center.js (crosshair, hitmarker, damage arcs),
panels.js (ammo, vitals, match panel, prompts, blood overlay), feed.js (killfeed, XP, medals, banners,
toasts), menus.js (main w/ fly-through cam, pause, settings, death, resume gate), icons.js (inline SVG),
util.js (cached DOM writers). Tools: tools/hud/shoot.mjs (batch shots), probe.mjs (eval in page),
crop.py (zoom crops for inspection).

All 7 required presets render with no hud errors. Existing quality already decent.

## Work plan (this session)
- [x] Low-health: .od-blood is now a backdrop-filter red grade (acts like multiply over the live
      frame) masked to an irregular edge band + a dark rim texture (clots/capillaries). Flash wash reduced.
- [x] Compass readability over bright sky (radial backing, stronger labels/ticks).
- [x] Minimap: low props no longer outlined (less clutter).
- [x] Crosshair enemy highlight (analytic aim test vs agents + throttled occlusion ray). api.debugAgents
      = shot/test hook for pseudo-agents (AI system currently spawns no agents).
- [x] Headshot killfeed icon redrawn (bust + reticle).
- [x] Death screen: damage arcs leaked through hidden HUD (visibility:'visible' on children) -> fixed.
      Viewmodel layer hidden while death screen shows. Lives only when gamemode reports max>0.
- [x] Extra presets: hud-prompts (low ammo, reload, hold-to-interact ring, red crosshair), hud-banner.
- [x] Interaction prompt: HOLD + key cap inside circular progress ring, soft backing.
- [x] Banner/medal: soft dark backing for legibility, medal moved below banner.
- [x] setMatchInfo accepts score/streak/kills/headshots overrides (shots).
- [x] Settings: optional rows for other systems' registered settings (postfx CA / weapon DOF,
      lighting volumetrics, vfx decals/shells/lights, player sprint/tac-sprint/lean/bob/FOV/flinch,
      audio ui/ambience/hrtf/hitmarkers). A row appears only if settings.get(path) !== undefined.
      Scroll fade on the row list.
- [x] Main menu: street-level dolly shots first (interleaved with lower cranes), backdrop contrast
      grade + vignette on the scrim.
- [x] Pause preset shows filled stats (accuracy / time) via hud.stats + setMatchInfo overrides.
- [~] Perf: machine shared with 11 agents -> perf.mjs numbers are noise (0-frame runs, 17 s stalls).
      HUD adds no draw calls/triangles (minimap bake is one-off). backdrop-filter is used only in
      menus (blur) and at low health (colour-only filter, masked) -> no cost in normal gameplay.

## Presets
hud-gameplay, hud-ads, hud-damage, hud-killfeed, hud-mainmenu, hud-pause-settings, hud-death,
hud-pause, hud-prompts, hud-banner. Batch: node tools/hud/shoot.mjs [presets] [-- --timeout 300000]

## Known issues / next steps
- AI system currently exposes no agents -> minimap enemy dots/compass markers only via ping();
  crosshair enemy tint verified via api.debugAgents. Re-verify once ai.agents is populated.
- Hitmarker sequence could be re-checked zoomed (contact sheet too small to judge detail).
- Possible: killcam-style death (needs player/camera cooperation), scoreboard (input 'scoreboard').

# Opus of Duty — Art & Design Bible (lead-owned, read-only for subsystem agents)

**North star:** a player who glances at a screenshot or a 10-second clip should mistake it for a current-gen
military shooter (MWII/MWIII-class). Realism over stylization, restraint over spectacle, and heavy detail density.
All content is original. No Activision names, logos, maps, weapon skins, UI art or sounds.

## Setting: "Operation Iron Vigil", in the fictional town of **Vardanek**
- A war-damaged Caucasus/Eastern-European border town. Soviet-era 3–5 story concrete and plastered-brick
  apartment blocks, older 2-story brick shopfronts with faded signage in fictional/Cyrillic-looking text,
  a central **plaza** with a dry fountain and a statue plinth, a **main street** with a market arcade,
  narrow **alleys**, a walled **courtyard**, and a **fuel depot / garage** on the edge of town.
- Battle damage: shell holes, collapsed wall sections, rebar, rubble piles, scorch marks, burnt-out cars,
  shattered windows, hanging cables, sandbag emplacements, HESCO barriers, jersey barriers, razor wire,
  abandoned market stalls, debris, paper litter, puddles.
- Playable space is compact (~140×140 m), with dense cover every 5–10 m and 3 main lanes plus flanks.
  CoD-style readable combat lanes. Out-of-bounds areas are dressed with building facades and distant skyline.
- Time of day: **late afternoon golden hour**. A low warm sun (~20–25° elevation) with long shadows and a
  hazy, dusty atmosphere with aerial perspective. There are distant smoke columns. The sky has broken
  cumulus. Shadows are cool and slightly blue from skylight. There is subtle volumetric light shafting in alleys.

## Color & grade
- A filmic, slightly desaturated grade with warm highlights, cool neutral-teal shadows and deep but not crushed
  blacks. A subtle vignette, fine film grain and restrained bloom (only light sources and hot specular).
- Materials are physically plausible. Nothing is plastic-looking. Everything carries grime, edge wear,
  dust accumulation on up-facing surfaces, water staining down walls, and ambient occlusion in creases.

## Factions
- **Player:** a Task Force "IRON VIGIL" operator. Arms are in multicam-style gloves and sleeves, with a
  watch or tourniquet detail.
- **Enemy:** "Crimson Vanguard" private military contractors. Dark olive/charcoal fatigues with a
  crimson armband, plate carriers, helmets or balaclavas, chest rigs. They must read instantly
  against the environment (silhouette plus the armband), and they must not glow.

## Weapons (original designs, realistic engineering)
- **"Warden" AR-7** 5.56 assault rifle (primary): an M4/HK416-class platform with M-LOK handguard,
  suppressor-ready muzzle brake, a holographic sight, a vertical grip, a 30-round polymer magazine, a
  fire-mode selector and a charging handle.
- **"Kestrel" P9** 9mm pistol (secondary). Frag grenade.
- Gunplay feel: punchy, readable recoil (vertical plus a slight horizontal pattern) with fast recovery.
  Viewmodel inertia/sway, ADS in about 0.25 s, tac-sprint, a slide, and a mag-drop reload with a tactical
  vs empty distinction.

## HUD
- Minimal, modern, clean sans-serif. Compass strip at top center with a minimap in the top left. Ammo
  and weapon name at bottom right, with a lethal/tactical count. Killfeed at top right. Hitmarkers are white
  and red on a kill, with a headshot variant. Directional damage indicators. Brief XP/score popups.
  No clutter, and every element fades when idle.

## Game loop
- Single-player "Hold Vardanek": waves of Crimson Vanguard assault the plaza with escalating counts and
  flanking. Score, killstreak callouts, death, a respawn/game-over screen, a main menu, a pause menu and
  settings (sensitivity, FOV, graphics quality, volume).

## Quality bar checklist (every critic uses this)
Silhouette and detail density · PBR material correctness (roughness variation, micro-normal, AO) ·
lighting (shadows, contact shadows, GI/bounce feel, atmospheric depth) · anti-aliasing / no shimmering ·
animation weight and inertia · sound layering · readability · performance (60 fps+ at 1080p on RTX 5070) ·
no placeholder look · no z-fighting, popping, stretched textures, floating objects or light leaks.

# Vangaurd

An original first-person shooter built with Three.js and Vite. You hold a city plaza against waves of
enemy soldiers. It runs in a desktop browser with WebGL2 (Chrome or Edge recommended) and needs a mouse
and keyboard.

## Beta 1.21 downloads

The current game (Beta 1.21: dive to prone from mid-air, an indoor firing range (Practice), one-handed tactical sprint, killcams and final killcam, party ready check, challenge camos, news and bug reports, animated level-ups, named bots, "Eliminated" call-outs, email-verified accounts with sign-in codes and password reset, moderation with bans and player reports, cloud saves that follow your account, friends and parties, accounts, loadouts with perks and camos, levels, six maps with a map vote, online
Team Deathmatch, controller support) is kept ready-built in `prebuilt/`, and GitHub Actions turns it into downloads on
every push to `main` (or when you run the **Build Vangaurd** workflow by hand). Every run gets a new build number; the
finished files are attached to the **Vangaurd Beta 1.21** release on the repository's Releases page:

| File | What it is |
| --- | --- |
| `Vangaurd-Beta-1.21-arm64.dmg` / `Vangaurd-Beta-1.21-x64.dmg` | Mac app for Apple Silicon / Intel Macs |
| `Vangaurd-Beta-1.21-Setup.exe` / `Vangaurd-Beta-1.21-win.zip` | Windows installer / portable Windows app |
| `Vangaurd-Beta-1.21.html` | The whole game in one HTML file (open in Chrome or Edge) |
| `version.json` | Newest build number, read by the desktop apps (auto-update) and the server (only the newest build plays online) |

To build the same files locally: `node tools/build-release.mjs --standalone Vangaurd-Beta-1.21.html` for the HTML
(no dependencies needed), and `npm install && npm run desktop:mac` or `npm run desktop:win` for the apps.

The Vite sources under `src/` are an older version of the game; `prebuilt/game-module.js` is the current one.

## Run

```bash
npm install
npm run dev        # dev server at http://localhost:8080
npm run build      # production build -> dist/
npm run preview    # serve the production build (http://localhost:8080)
npm run build:standalone # bundle the original game and assets into one HTML file
```

`npm run build:standalone` creates `Vangaurd-standalone.html` beside this README. It bundles the
original game's JavaScript, worker, and all files under `public/assets/` into one self-contained HTML
file (roughly 280 MB). Open that HTML directly in a modern browser to play; it unpacks its embedded
assets locally at startup and does not need a server or sibling asset folder. The normal `index.html`
remains unchanged.

## Desktop packages (Windows and macOS)

The Electron wrapper packages the regular production build and serves its assets from a private
loopback HTTP server. This avoids decoding the entire standalone archive in memory at launch. Install
dependencies with `npm install`, then run the command for the platform you want to build:

```bash
npm run desktop:mac  # macOS Apple Silicon + Intel: DMG and ZIP
npm run desktop:win  # Windows x64: installer + ZIP containing the runnable app
npm run desktop:all  # build both platforms (best run on macOS or Linux)
```

Artifacts are written to `release/`. Windows users can run the NSIS installer, or unzip the Windows archive and launch `Vangaurd.exe`;
macOS users open the DMG and drag the app to Applications. macOS Gatekeeper may warn on unsigned builds;
public distribution requires signing/notarization. Windows signing is also recommended before public release.
The Windows executable is unsigned, so Windows SmartScreen may require **More info → Run anyway**.
If startup fails, confirm Windows 10 is fully updated, install the latest graphics driver, and check that
the GPU supports WebGL 2. The app writes startup details to `%APPDATA%\Vangaurd\launch.log`.

On startup, the desktop app prepares the world and warms map shaders from wide and street-level
views before showing the deployment menu; this can make the initial splash take longer, but avoids
compilation spikes while browsing the menu. Choose Singleplayer and the game loads the match and
captures the mouse automatically. Railway multiplayer setup is described in [server/README.md](server/README.md). Online TDM synchronizes player poses, remote hitboxes, hit/health/death/respawn events, and team scores through the Railway room relay. This is a prototype: hit tests run on clients and are not cheat-resistant or production-authoritative.

`dist/` loads its assets from absolute `/assets/...` paths, so host it at the root of a domain, not in a
sub-folder.

## Game mode: Hold the Plaza (wave survival, solo)

- 10 waves of enemy squads. They take cover, flank and shoot back. Between waves there is a short
  intermission that resupplies your ammo and grenades.
- Kills, headshots and kill streaks add to your score. You get reinforcements (extra lives) depending on
  difficulty: Conscript 3, Soldier 2 (default), Specialist 1, Iron Vigil 0.
- When you die, the KILLED IN ACTION screen counts down, then you redeploy with a full loadout. When
  no reinforcements are left, the mission ends with a summary screen where you can restart or go back
  to the main menu.
- Difficulty is under Settings > Gameplay and takes effect on the next deployment.

## Controls (rebind them in Settings > Keybinds)

| Action | Key |
|---|---|
| Move | W A S D (or arrow keys) |
| Look | Mouse |
| Fire / Aim down sights | Left / Right mouse button |
| Sprint | Left Shift (hold while moving forward) |
| Jump | Space |
| Crouch / Prone | C / Z |
| Reload | R |
| Melee | V (or mouse button 5) |
| Frag grenade / Tactical | G / T |
| Interact | F |
| Primary / Secondary / Swap weapon | 1 / 2 / 3, or the mouse wheel |
| Lean left / right | Q / E |
| Inspect weapon | I |
| Scoreboard | Tab |
| Pause menu | Esc or P |

## Graphics settings (Settings > Graphics)

- **Quality preset**: LOW (performance default), MEDIUM, HIGH or ULTRA. It scales shadows, ambient occlusion,
  post-processing and effect density together. ULTRA costs noticeably more GPU time.
- **Field of view**: 60 to 120 degrees horizontal (default 90).
- **Render resolution**: 35 to 100 % (default 35 %), with device-pixel ratio capped at 1.0. Increase it for a sharper image; lower scales can improve GPU frame rate.
- **Frame rate limit**: unlimited, 60, 120, 144 or 240. The game loop runs independently of monitor refresh; unlimited mode is not refresh-synchronized.
- **Toggles**: shadows, motion blur, film grain, lens aberration, weapon depth of field, volumetric
  lighting, impact decals, shell casings and dynamic effect lights.

Mouse, audio and interface (crosshair, hitmarkers) options are in the same Settings menu. Settings are
saved in the browser's local storage.

## Verification harness (development)

See **ARCHITECTURE.md** for the engine layout, the system and service contracts, and the harness.

```bash
node tools/shot.mjs --list                       # all shot presets
node tools/shot.mjs smoke                        # PNG -> shots/, JSON summary on stdout
node tools/perf.mjs core-perf --duration 10      # frame-time percentiles at 1080p
node tools/audio.mjs test_tone                   # WAV + waveform/spectrogram PNG
node shots/stabilize/playtest.mjs --preview      # scripted full playtest of the built dist/
node shots/release/release.mjs                   # production-build release check (+ final.png)
```

Debug URL flags: `?debug=1` (lil-gui and diagnostics), `?only=materials,lighting,world`,
`?shot=<preset>`, `?faults=audio:import,vfx:update` (error-isolation test).

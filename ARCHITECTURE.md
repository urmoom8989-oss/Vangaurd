# Opus of Duty — Architecture & Contracts

An **original** first-person shooter in Three.js aiming at the look and feel of modern military shooters
(MW2019 / MWII / MWIII class). **Nothing from Activision may be used:** no names, logos, weapon skins,
maps, UI art, sounds or other assets. All content is original or procedurally generated.

This document is the contract between the ~11 subsystem owners who work **in parallel**. If something
you need is not covered here, do not edit core. Add an optional-chained call (`services.x.newThing?.()`)
and ask the lead to extend the contract.

---

## 1. Stack

| Package | Why |
|---|---|
| `three` 0.186 | renderer (WebGL2) |
| `postprocessing` (pmndrs) | postfx composer/effects (postfx owner) |
| `n8ao` | high-quality SSAO (postfx owner) |
| `three-mesh-bvh` | fast raycasts / BVH collision (world, combat, ai) |
| `@dimforge/rapier3d-compat` | rigid bodies: ragdolls, debris, grenades (combat, vfx, ai), optional |
| `lil-gui` | debug panels only (`?debug=1`) |
| `vite` (dev), `playwright` 1.62.0 (dev, pinned to the cached chromium-1234) | dev server + harness |

Plain JS ES modules. No TypeScript, no framework. **Do not `npm install` anything yourself:** concurrent
installs corrupt `node_modules`. Ask the lead.

Vite dependency pre-bundling is **disabled** (`optimizeDeps.noDiscovery`). Deps are served as raw ESM, which
keeps one `three` instance and avoids reloads mid-capture. Import three addons as
`three/examples/jsm/...` (or `three/addons/...`).

---

## 2. Layout & file ownership

```
index.html                      core (FROZEN)  #app canvas, #hud, #ui, #boot-overlay, #core-diag
vite.config.js, package.json    core (FROZEN)
src/main.js                     core (FROZEN)  boot, URL params, window.__GAME__/__PERF__ hooks
src/core/*                      core (FROZEN)  Engine, Loop, Input, Time, Rng, Settings, Assets, EventBus,
                                               Perf, SystemRunner, ShotController, services, constants, diagnostics
src/systems/registry.js         core (FROZEN)  system list + isolated loader
src/systems/<name>/**           OWNED by the <name> agent (any number of files/sub-folders)
src/shots/index.js              core (FROZEN)  auto-aggregates every other file in src/shots/
src/shots/<name>.js             OWNED by the <name> agent (their shot presets)
src/shots/core.js               core
public/assets/<name>/**         OWNED by the <name> agent (served at /assets/<name>/...)
tools/shot.mjs, perf.mjs, audio.mjs, tools/lib/*   core (FROZEN)
tools/<name>/**                 OWNED by the <name> agent (offline generators, bakers, analysis scripts)
shots/                          output folder (PNG/WAV). Prefer --out shots/<name>/... to keep it tidy.
```

System folder names are fixed: **materials, lighting, world, postfx, player, weapons, combat, vfx, ai,
audio, hud, gamemode** (in dependency/init/update order, see `SYSTEM_ORDER` in `src/core/constants.js`).

Rules:
- Never edit another system's folder or shot file. Never import another system's modules directly
  (`import '../weapons/x.js'` is forbidden). A syntax error there would then break you too. Talk through
  `ctx.services` and `ctx.events` only.
- Shared code you want others to use goes into **your** service API.
- Frozen core files change only through the lead. The extension points are: your service, your events,
  `settings.registerDefaults('<name>', {...})`, your shot file, your `public/assets/<name>/`, your `tools/<name>/`.

---

## 3. System interface

`src/systems/<name>/index.js`:

```js
export default function createSystem(ctx) {
  // allocate nothing heavy here; do real work in init()
  return {
    name: '<name>',
    async init() { /* build, load (via ctx.assets), then ctx.services.provide('<name>', api) */ },
    fixedUpdate(dt, t) {},   // optional, fixed 1/60 s steps (physics, movement)
    update(dt, t) {},        // optional, once per rendered frame
    lateUpdate(dt, t) {},    // optional, after all updates (camera, viewmodel, attachments)
    dispose() {},            // free GPU resources, listeners, DOM
  };
}
```

Frame order: `input → [shot beforeFrame] → fixedUpdate×N (all systems, in order) → update (in order) →
lateUpdate (in order) → [shot camera override] → render → input.endFrame()`.

**Error isolation.** Each system is imported through its own dynamic `import()` in try/catch. `init` has a
timeout (30 s; `?initTimeout=ms`). Every lifecycle call is wrapped. Any failure:
- logs `[system:<name>] <phase> failed: <message>` plus the stack (for import failures in dev, the Vite
  compile error is fetched and included),
- is appended to `window.__SYSTEM_ERRORS__` (the harness reports these as `systemErrors`),
- for import/create/init failures, resets that system's service to the safe default,
- for update failures, disables that system's updates (its service stays up). All other systems keep
  running, and the frame keeps rendering. The Vite error overlay is suppressed so it can't cover the frame.

To test isolation without editing anyone's files: `?faults=audio:import,vfx:update,hud:init,postfx:render`
(or `node tools/shot.mjs smoke --faults ...`).

---

## 4. `ctx`: shared by all systems

| field | type | notes |
|---|---|---|
| `renderer` | `THREE.WebGLRenderer` | WebGL2, `antialias:false`, sRGB output, AgX tone mapping (default), `shadowMap.enabled`, `PCFShadowMap`, `info.autoReset=false` (core resets per frame) |
| `scene` | `THREE.Scene` | main scene |
| `camera` | `THREE.PerspectiveCamera` | the player view. Added to the scene (children render). near 0.03, far 1500. Layers WORLD+VIEWMODEL+FX enabled |
| `events` | `EventBus` | `on/once/off/emit`; listener exceptions are isolated |
| `input` | `Input` | see §6 |
| `time` | `Time` | `t, dt, frame, fixedStep, alpha, scale, deterministic, frozen, real` |
| `settings` | `Settings` | `get(path)`, `set(path,v)`, `data` (hot-path reads), `registerDefaults(ns, obj)` |
| `rng` | `Rng` | seeded. **Use `ctx.rng.fork('<name>')`** for your own stream. Never `Math.random()` |
| `assets` | `Assets` | loaders + readiness tracking, see §7 |
| `shot` | object or `null` | the active shot preset (plus `name`, `file`) |
| `services` | registry | see §5 |
| `engine` | `Engine` | `width`, `height`, `pixelRatio`, `resizeListeners`, `rendererString` |
| `perf` | `Perf` | frame stats |
| `layers` | `LAYERS` | `{WORLD:0, VIEWMODEL:1, FX:2, DEBUG:7}` |
| `surfaces` | `SURFACES` | surface-type vocabulary |
| `ui` | `{hudRoot, uiRoot, setBootOverlayEnabled(b), requestPointerLock()}` | DOM roots |
| `debug` | `{enabled, gui}` | `gui` is a lil-gui instance only with `?debug=1`. Always use `ctx.debug.gui?.addFolder(...)` |
| `flags` | `{shotMode, perfMode, debug}` | |
| `reportError(system, phase, err)` | fn | report a non-fatal error in the standard format |

Units: **1 unit = 1 meter**, +Y up, player forward at yaw 0 is −Z. Runtime angles are radians. Shot
presets use degrees. Light intensities are physical (three r155+). Settings FOV is **horizontal
degrees at 16:9** (CoD-style); `settingsFovToVfov()` in constants converts.

---

## 5. Services: API contracts

Core pre-installs a **safe default** for every service (`src/core/services.js`), so consumers work
before the producers are done and keep working when a producer breaks. Producers publish with
`ctx.services.provide('<name>', api)`. The object keeps its identity, and the default becomes its
prototype, so unimplemented documented members fall back to the no-op.
Consumers: look services up **at call time** (`ctx.services.audio.play(...)`), never cache them at module
load. For members not listed here, use `?.()`.

Vectors passed **into** a service may be reused by the caller: copy them if you keep them. Returned
objects documented as "new" are yours.

### materials
```
ready: Promise
get(name) -> THREE.Material            SHARED instance: never mutate/dispose. Unknown -> magenta + warning
has(name) -> bool;  list() -> string[]
clone(name) -> Material                caller-owned copy
surfaceOf(nameOrMaterial) -> surface   (material.userData.surface is always set)
```
Catalog names are a contract (you may add names, never rename or remove): `concrete_wall, concrete_floor,
asphalt, brick_red, plaster_painted, metal_painted, metal_rusted, metal_gun_black, polymer_gun,
wood_planks, sandbags, dirt, gravel, glass, fabric_military, skin, rubber, cardboard, corrugated_metal,
tile_floor`. Tiling convention: textures authored at about 1 repeat per meter. **World geometry UVs are
in meters** (see `boxWorldUV` in the world stub), so meshes never set `repeat`.

### lighting
```
sun: DirectionalLight | null           main shadow caster
getSunDirection(out) -> Vector3        unit vector towards the sun
environment: Texture | null            PMREM env (also scene.environment)
presets: string[];  setPreset(name)    time-of-day / mood
setExposure(v)
```
Owns `scene.background`, `scene.environment`, `scene.fog`, all persistent lights, and the shadow
configuration (CSM etc.). Transient lights (muzzle flash, explosions) belong to vfx.

### world
```
ready: Promise;  root: Object3D;  bounds: Box3
spawnPoints: { player: [{position: Vector3, yaw}], ai: [{position, yaw}] }
raycast(origin, dir, far=1000, {ignore?: Object3D[]}) -> Hit | null
   Hit = { point: Vector3, normal: Vector3 (world), distance, object, material, surface }   (new objects)
raycastAll(origin, dir, far) -> Hit[]  (sorted; for penetration)
collideCapsule({start, end, radius}) -> { normal: Vector3, depth } | false
   (three.js Octree semantics: translate capsule by normal*depth, iterate up to ~3 times)
groundHeight(x, z, fromY=100) -> number
addCollider(object3d) / removeCollider(object3d)
colliders: Mesh[]
nav: { findPath(from, to) -> Vector3[], randomPoint(out) -> Vector3 }
```
The implementation may switch to three-mesh-bvh; the signatures must stay.

### postfx
```
render(dt, t) -> boolean      called ONCE per frame instead of renderer.render(). true = you drew the frame
setADS(0..1)                   aim blend (DOF/vignette)
pulse(kind, intensity, duration)   'damage' | 'flashbang' | 'explosion' | 'hitmarker' | 'concussion'
setEffect(name, enabled);  setQuality('low'|'medium'|'high'|'ultra');  composer
```
If `render` throws, core logs it, resets postfx to the default, and renders plainly from then on. Postfx
owns AA (renderer has `antialias:false`) and, when active, tone mapping (`renderer.toneMapping =
NoToneMapping` while using its own). Listen to the `resize` event for render targets. Draw calls and
triangles from all passes are counted automatically.

### player
```
state: { position (feet), velocity, eye, forward, yaw, pitch, roll, stance 'stand'|'crouch'|'prone',
         grounded, sprinting, sliding, moving, speed, lean (-1..1), health, maxHealth, alive, ads }
teleport(position, yaw?, pitch?)            radians
setPose({position:[x,y|null,z], yaw, pitch, stance})   degrees; y null -> ground height
applyRecoil(pitchRad, yawRad)               positive pitch = up
addShake(intensity 0..1, duration s)
setZoom(multiplier)                         ADS fov zoom, 1 = none
setMovementEnabled(bool);  damage(amount, info)
```
Owns `ctx.camera` position/rotation/fov. Reads `ctx.shot.player` for the initial pose.

### weapons
```
state: { id, name, ammo, magSize, reserve, fireMode, ads 0..1, reloading, reloadProgress 0..1,
         sprinting, lastShotTime, spread (deg), action 'idle'|'fire'|'reload'|'sprint'|'equip'|'inspect'|'melee' }
viewmodel: Object3D          child of ctx.camera, meshes on LAYERS.VIEWMODEL
list() -> [{id, name}];  equip(id);  setPose(state|null, progress)
```
Reads `ctx.shot.weapon = {id, state, progress}` to force poses in shots. Viewmodel meshes: `castShadow=false`,
`frustumCulled=false` near the camera.

### combat
```
fireHitscan({origin, direction, range, damage, source, weaponId, spread?, penetration?})
   -> { point, normal, surface, distance, target: Damageable|null, zone, damage } | null
registerDamageable({object, health, maxHealth?, team?, onDamage?(amt, info), onDeath?(info)}) -> Damageable
   Damageable = { id, health, maxHealth, team, alive, unregister() }.  Hitbox meshes: userData.zone = 'head'|'torso'|'limb'
unregisterDamageable(d);  applyDamage(d, amount, info);  explode({position, radius, damage, source});  damageables
```

### vfx
```
spawn(type, params) -> handle | null      unknown types are ignored
   'muzzle_flash' {weaponId, object?}   'impact' {point, normal, surface}   'tracer' {from, to}
   'blood' {point, normal, direction}   'explosion' {position, radius}   'smoke' {position, radius, duration}
   'shell_eject' {weaponId, object?}    'dust' {position}
decal({point, normal, surface, object?, kind:'bullet'|'blood'|'scorch', size?}) -> handle | null
types() -> string[];  clear()
```
Pooled, with zero allocations per spawn in steady state. Particles go on `LAYERS.FX`.

### ai
```
agents: Agent[]   Agent = { id, object: Object3D, position: Vector3, alive, state, team }
spawn({position?, yaw?, loadout?, behavior?}) -> Agent | null
count();  killAll();  setEnabled(bool)
```

### audio
```
context: AudioContext | null      lazily created, resumed on 'core:user-gesture'
play(name, {volume?, pitch?, loop?, bus?, delay?}) -> Handle {stop(), setVolume(), setPitch(), setPosition(), playing}
playAt(name, position, opts) -> Handle
list() -> string[];  setVolume(bus, v);  resume()
renderOffline(name, {duration?, sampleRate?, channels?, params?}) -> Promise<AudioBuffer>   REQUIRED (tools/audio.mjs)
```
Buses: `master, sfx, music, voice, ui`. Shots are silent (`play` is a no-op in shot mode). Prefer
reacting to events (`weapon:fired`, `player:footstep`, `combat:hit`...) over other systems calling you.

### hud
```
root: HTMLElement;  setVisible(bool);  hitmarker('hit'|'headshot'|'kill');  damageIndicator(sourcePos)
notify(text, {kind?, duration?});  killfeed({killer, victim, weapon, headshot});  setCrosshairSpread(deg);  setObjective(text)
```
DOM goes into `ctx.ui.hudRoot` (#hud). Menus go into `ctx.ui.uiRoot` (#ui). Only write to the DOM when a value changes.

### gamemode
```
state: { mode, phase 'warmup'|'live'|'ended', score: {team: n}, timeLeft, round }
start(mode?);  end(reason?);  addScore(team, points)
```
May take over the "click to deploy" overlay: `ctx.ui.setBootOverlayEnabled(false)`.

### Event catalog (`ctx.events`)
| event | payload | emitter |
|---|---|---|
| `core:ready` | ctx | core |
| `core:user-gesture` | – | core (first click; resume audio here) |
| `resize` | {width, height, pixelRatio} | core |
| `settings:changed` | {path, value} | core |
| `input:lock` | {locked} | core |
| `input:rebind` | {action, codes} | core |
| `player:footstep` | {surface, position, speed, stance} | player |
| `player:jump` / `player:land` | {position} / {speed, position} | player |
| `player:stance` | {stance} | player |
| `player:damaged` / `player:died` | {amount, health, info} / {info} | player |
| `weapon:fired` | {weaponId, origin, direction, time} (pooled, so copy it) | weapons |
| `weapon:reload` | {weaponId, phase:'start'\|'end'} | weapons |
| `weapon:equip` / `weapon:empty` | {weaponId} | weapons |
| `combat:hit` | {point, normal, surface, distance, target, zone, damage, source, weaponId} | combat |
| `combat:kill` | {target, source, weaponId, zone} | combat |
| `combat:explosion` | {position, radius} | combat |
| `ai:spawn` / `ai:death` / `ai:alert` | {agent, info?} | ai |
| `gamemode:phase` / `gamemode:score` | {phase} / {team, score} | gamemode |

New events: prefix them with your system name, and document them in your folder's README or ask the lead to add them here.

---

## 6. Input

Actions: `moveForward moveBack moveLeft moveRight sprint crouch prone jump fire ads reload melee grenade
tactical interact swapWeapon weapon1 weapon2 weaponNext weaponPrev leanLeft leanRight inspect scoreboard pause`.

```
input.isDown(a) / pressed(a) / released(a)    edges valid for the whole render frame
input.getMove(out) -> {x strafe, y forward}    normalized
input.look -> {dx, dy}                          raw mouse counts this frame (+dy = down)
input.bind(action, codes[]) / resetBindings()   codes: KeyboardEvent.code, 'Mouse0'..'Mouse4', 'WheelUp', 'WheelDown'
input.inject(action, down) / injectLook(dx, dy) / injectMove(x, y | null)   scripted input
```
Sensitivity convention: degrees per count = `0.022 * settings.controls.sensitivity`. In shot mode
physical devices are ignored, and only the preset's scripted input applies. Read edge flags
(`pressed`) in `update()`, not `fixedUpdate()`.

## 7. Assets & readiness

`ctx.assets.texture(url, {srgb, repeat, anisotropy, flipY, mipmaps})`, `.gltf(url)` (meshopt-ready;
KTX2 needs transcoder files in `public/assets/basis/`), `.hdr(url)`, `.exr(url)`, `.ktx2(url)`,
`.arrayBuffer(url)`, `.json(url)`, `.canvasTexture(w, h, draw, {srgb, repeat})`, plus
**`.track(promise, label)`** for any other async work (procedural bakes, worker jobs, PMREM
generation...). The shot harness waits for `assets.whenIdle()` before warmup and again after it, so
**untracked async work = flaky screenshots.**

---

## 8. Shot presets (visual verification)

Define presets in **your** file `src/shots/<name>.js`. It is auto-discovered, so there is no index to edit:

```js
export default {
  'weapons-ads-rifle': {                // globally unique: prefix with your system name
    description: 'ADS on the rifle at noon',
    only: ['materials', 'lighting', 'world', 'postfx', 'player', 'weapons'],  // optional subset
    seed: 1337,
    t: 12.0,                  // sim time (s) at the captured frame. default (warmup+1)/60
    freeze: false,            // true: dt = 0 for every frame (fully frozen time)
    warmup: 30,               // frames simulated before the capture (deterministic 1/60 steps)
    resolution: [1920, 1080], // default; CLI --w/--h override
    settings: { graphics: { quality: 'ultra' } },
    hud: true,                // false hides #hud and #ui
    camera: { position: [x, y, z], target: [x, y, z], hfov: 80 /* or vfov */, near, far, viewmodel: false },
                              // hard camera override after lateUpdate; hides the viewmodel unless viewmodel:true
    player: { position: [x, null, z], yaw: 0, pitch: -3, stance: 'stand' },   // degrees; null y = ground
    weapon: { id: 'rifle', state: 'ads', progress: 0 },   // hip|ads|sprint|reload|fire|inspect|equip
    input: [ { frame: 0, move: [0, 1] }, { frame: 10, press: 'fire' }, { frame: 20, release: 'fire' },
             { frame: 5, tap: 'reload' }, { frame: 0, look: [dx, dy] }, { frame: 3, call: (ctx) => {} } ],
    inputLoop: 0,             // >0 repeats the input script every N frames (perf runs)
    async setup(ctx) {},      // after all systems init, before warmup (tracked by assets)
    onFrame(ctx, i) {},       // every frame before fixedUpdate
  },
};
```

Determinism: in shot mode `time.dt === 1/60` exactly and `t = t0 + frame/60`. Settings come from
defaults plus `preset.settings` (no localStorage), and the RNG is seeded. Same preset means the
**bit-identical PNG** (verified). Keep it that way: no `Math.random()`, `Date.now()`,
`performance.now()` or wall-clock timers in simulation or animation code.

Page globals: `window.__SHOT_READY__` (true when the capture frame is presented), `__SHOT_FAILED__`,
`__SHOT_INFO__`, `__SYSTEM_ERRORS__`, `__PERF__` (`avg/p50/p95/p99 frame ms, cpuAvg, gpuAvg (timer
query), drawCalls, triangles, programs, textures, renderer`), `__GAME__` (`ctx, runner, loop,
systems(), advanceFrames(n), advanceMs(ms), pause(), resume(), perf(), THREE`).

URL params: `?shot=<name>` (`__list__` lists presets), `only=a,b`, `seed`, `warmup`, `w`, `h`, `perf=1`,
`debug=1`, `faults=sys:phase,...`, `initTimeout=ms`.

## 9. Harness tools

All tools start their **own** Vite server on a free port with no file watching, a per-process cache dir,
and the error overlay off. They launch Playwright Chromium (headless, ANGLE D3D11, GPU flags), check that
the WebGL renderer is hardware (the RTX 5070 reports
`ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 (0x00002F04) Direct3D11 vs_5_0 ps_5_0, D3D11)`), and fall back to
a headed off-screen window if headless ever returns SwiftShader. They always clean up, and they print
JSON to stdout (logs go to stderr). Many agents can run them concurrently. A shot takes about 2–3 s.

```
node tools/shot.mjs --list
node tools/shot.mjs <preset> [--out shots/<sys>/x.png] [--w 1920 --h 1080] [--frames N(warmup)]
                             [--sequence 8 --interval 50] [--seed N] [--only a,b] [--faults ...]
                             [--timeout 90000] [--debug] [--headed] [--strict] [--allow-software]
  -> {ok, preset, png, frames?, contactSheet?, renderer, gpuHardware, browserMode, perf, systems,
      systemErrors, consoleErrors, consoleWarnings, pageErrors, networkErrors, readyMs, durationMs}
  exit 0 ok | 1 error | 2 timeout (also saves *-TIMEOUT.png) | 3 software GPU | 4 --strict with errors

  --sequence N --interval ms: after the ready frame, captures N frames spaced by `interval` ms of
  SIMULATED time (deterministic), writes <out>-frames/frame-XX.png, and writes a labelled contact
  sheet to <out> (default shots/<preset>-<ts>-sheet.png), so a critic can judge motion from one image.

node tools/perf.mjs [preset=core-perf] [--duration 10] [--w 1920 --h 1080] [--vsync] [--out r.json]
  real-time run with vsync/frame cap disabled; frame ms avg/p50/p95/p99/max, fps, CPU ms, GPU ms
  (EXT_disjoint_timer_query), draw calls/triangles (last + max). exit 5 when p95 > 16.6 ms.

node tools/audio.mjs <sound|--list|--all> [--duration s] [--sr 48000] [--channels 2] [--out dir]
  renders services.audio.renderOffline(name) in an OfflineAudioContext in the page, writes a 16-bit WAV
  plus a PNG (per-channel waveform + log-frequency spectrogram), and prints stats
  {duration, peakDb, rmsDb, clippedSamples, dcOffset, tailSilenceMs, spectralCentroidHz}.
  Page contract: window.__listSounds(), window.__renderSound(name, opts) -> {sampleRate, length,
  duration, numberOfChannels, channels: base64 Float32[]}.
```

The npm aliases are `npm run shot -- <preset> ...`, `npm run perf -- ...` and `npm run audio -- ...`.

Known harmless console warning: `X4122 ... cannot be represented accurately in double precision`
(D3D shader-compiler noise from ANGLE).

## 10. Performance budget

**p95 frame time ≤ 16.6 ms (60 fps+) at 1920×1080 on the RTX 5070**, measured by `tools/perf.mjs` with
all systems enabled. Targets for the full game are about ≤ 1500 draw calls/frame including shadow
passes, ≤ 6 M triangles, GPU ≤ 12 ms. Each owner should check that their feature fits by running perf with
and without it.

## 11. Coding conventions

- **No per-frame allocations** in update/render paths: preallocate `Vector3`/`Matrix4`/arrays at module
  or closure scope, and reuse event payload objects (consumers copy).
- **Instancing/merging for props** (`InstancedMesh`, `BatchedMesh`, `mergeGeometries`). One material per
  surface type, shared from `services.materials`.
- **Dispose GPU resources** you create (geometries, materials you own, textures, render targets) in
  `dispose()`. Never dispose shared catalog materials.
- Everything async goes through `ctx.assets` (§7). Everything random goes through `ctx.rng.fork(name)`.
  Everything temporal goes through `ctx.time`.
- Use `ctx.layers` for viewmodel/FX separation. Shadows: static geometry casts and receives, and the
  viewmodel only receives.
- DOM: only the hud/gamemode systems touch the DOM (inside `#hud` / `#ui`).
- Log with the prefix `[system:<name>]`. Use `ctx.reportError(name, phase, err)` for handled failures.
- Keep shaders compatible with WebGL2 / ANGLE-D3D11. Test with the harness, never assume.
- Original content only: no trademarked names or likenesses from existing franchises.

# player — progress log

## State at resume (session 2)
Done by the previous owner (audited, all working):
- motor.js: kinematic capsule motor (walk/sprint/tac/crouch/prone, jump w/ coyote + buffer, air control,
  slide, mantle/vault, step-up, ground snap, slopes, fall damage, footsteps w/ surface raycast).
- cameraRig.js: eye spring, stair smoothing, landing spring, bob, strafe tilt, slide/mantle camera, lean,
  recoil + recovery + punch, trauma shake, flinch, death cam, FOV kicks + ADS zoom.
- index.js: service API (contract + extensions), health regen (4 s delay), death/respawn events.
- tools/player/sim.mjs: 44 headless motor regression tests (all pass). tools/player/telemetry.mjs.

## Session 2 (done)
- recoil: negative-pitch applyRecoil calls (= weapons' own recovery) no longer punch / reset the
  recovery timer and consume our recoverable accumulator → recoveries never stack.
- mantle climb re-shaped: hands-on-lip load, strong mid pull, roll over; not front-loaded any more
  (the ledge edge now travels down the screen). Duration 0.40 + 0.24·h s. Camera looks down at the lip
  (−12°·k), hand-plant jolt at u = 0.3.
- vault: Hermite horizontal profile (enters with run-in speed, exits with exit speed; no stall), sin
  arc up, float, drop. Duration from distance / run-in speed. Velocity kept on the start frame.
- motor.probeMantle(p, fwd, out) (pure query) + services.player.probeMantle(position, yaw).
- published `state.sprinting` is false during a real jump (after 0.14 s airborne / jumped) and mantles,
  so the weapon comes up to ready mid-air; the sprint latch is kept (`state.sprintHeld`) and resumes on
  landing. FOV kick follows the latch (no FOV pump in sprint jumps).
- camera rig: `updateWorldMatrix(true,false)` instead of updateMatrixWorld() (was re-walking the whole
  viewmodel subtree): lateUpdate 0.106 → 0.036 ms.
- shots: player-mantle now finds a REAL ledge in the level (car roof / wall, deterministic ring search
  via probeMantle) with a fixed run-up and auto-jumps at contact; fallback = clean concrete dock.
  New player-vault (sprint-vault over a real sandbag line / low wall). Placeholder cardboard/sandbag
  boxes removed from the fallback dock.
- tools/player/probe.mjs: evaluate JS in a loaded preset (debugging / measuring).

## Perf (player-sprint, deterministic, per frame)
fixed 0.15 ms (mostly world.collideCapsule / raycast), update 0.015 ms, late 0.036 ms. No draw calls
except shot-preset test structures.

## Known issues (other systems)
- weapons: regular (non-tac) sprint pose puts the gun completely off-screen (config sprint.rot
  [-20, 42, 26]); visible in player-slide / player-vault sequences.
- weapons: no mantle/vault viewmodel reaction (could read state.mantling / mantleProgress).
- Harness page occasionally navigates mid-evaluate (another agent's file edits) → just retry.

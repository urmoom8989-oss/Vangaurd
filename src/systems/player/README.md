# player — movement, collision, camera, health

Files
- `index.js` — system glue, `services.player` API, health / regeneration / death / respawn.
- `motor.js` — fixed-step (60 Hz) kinematic capsule motor: walk / sprint / tac-sprint / crouch / prone,
  jump (coyote time + jump buffer), air control, slide, mantle / vault, stairs step-up, ground snap,
  slopes, fall damage, footsteps.
- `cameraRig.js` — per-render-frame camera: eye-height spring, stair smoothing, landing spring, gait
  head-bob, strafe tilt, slide / mantle / stance-change camera, lean (wall-probed), recoil application
  with recovery + visual punch, trauma shake, damage flinch, death camera, FOV kicks + ADS zoom.
- `config.js` — every tunable (speeds, accelerations, camera amplitudes, health numbers).
- `springs.js` — damped springs, easing, seeded 1-D gradient noise (deterministic).

## Service extensions (additive to ARCHITECTURE.md §5)

`state` extra fields (read-only for consumers):

| field | meaning |
|---|---|
| `tacSprinting` | tactical sprint active (double-tap sprint, ~3.2 s charge that recharges) |
| `sprintBlend` | 0..1 smoothed (0.75 sprint, 1 tac) — drive viewmodel sprint poses with it |
| `mantling`, `mantleProgress` (0..1), `mantleHeight` (m) | mantle / vault animation state |
| `slideTime` | seconds into the current slide (0 when not sliding) |
| `bobPhase` (rad), `bobWeight` (0..1) | gait phase; a foot plants at every multiple of π. Sync viewmodel bob to it |
| `airTime`, `landImpact` (0..1 decaying) | air / landing feedback for the viewmodel |
| `stanceTransition` (0..1) | progress of a prone transition (movement is restricted meanwhile) |
| `fov` | current horizontal FOV (settings + kicks, before ADS zoom) |
| `eyeHeight` | current eye height above the feet |
| `forward` | full 3-D view direction (unit). `forwardFlat` is the horizontal heading |
| `lastDamageTime`, `regenerating`, `tacCharge` (0..1), `invulnerable` | health / sprint meters |

Methods: `respawn(position?, yaw?)`, `heal(amount)`, `kill(info)`, `setInvulnerable(bool)`,
`setStance(stance) -> bool` (headroom-checked), `flinch(amount, sourcePosition?)`.

`damage(amount, info)`: `info.position` (attacker / source position) or `info.direction` (travel
direction of the hit) orients the flinch. `info.type === 'fall'` is used for fall damage.

## Events

| event | payload |
|---|---|
| `player:footstep` | `{surface, position, speed, stance, foot 'left'\|'right', sprinting, tacSprinting, volume 0..1}` |
| `player:jump` | `{position, speed}` |
| `player:land` | `{speed (impact m/s), position, surface, height (m fallen)}` |
| `player:stance` | `{stance, previous}` |
| `player:slide` | `{phase 'start'\|'end', position, speed, surface}` |
| `player:mantle` | `{phase 'start'\|'end', position, height, vault, duration}` |
| `player:tacsprint` | `{active, charge}` |
| `player:damaged` / `player:died` | `{amount, health, info}` / `{info}` |
| `player:regen` | `{phase 'start'\|'end', health}` |
| `player:respawn` | `{position}` |

All payloads are pooled: copy what you keep.

## Settings (`settings.player.*`)
`sprintMode` 'toggle'|'hold', `tacSprint` 'doubleTap'|'auto'|'off', `slideOnCrouch`, `headBob` (0..1.5),
`fovEffects`, `leanMode` 'hold'|'toggle', `damageFlinch` (0..1+).

## Controls
Sprint (tap = sprint, tap again while sprinting = tac-sprint), crouch while sprinting = slide (jump,
sprint or crouch cancels it), jump near a 0.4–2 m ledge = mantle (thin obstacles ≤ 1.3 m are vaulted;
holding forward in the air also mantles), jump while crouched/prone stands up, Q/E lean.

## Tools
`node tools/player/telemetry.mjs <preset> --frames 120 --every 2` prints per-frame state and every
`player:*` event for a shot preset (tuning without screenshots).

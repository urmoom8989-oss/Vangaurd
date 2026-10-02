/**
 * Shared constants (core, frozen). Propose additions to the lead; do not edit from a subsystem.
 */

/** Render layers. The player camera has WORLD + VIEWMODEL + FX enabled. */
export const LAYERS = Object.freeze({
  WORLD: 0,
  VIEWMODEL: 1, // first-person arms/weapon (postfx may exclude from AO/motion blur/DOF)
  FX: 2, // particles / sprites / tracers (postfx may render separately)
  DEBUG: 7, // debug helpers, never enabled on the player camera in shot mode
});

/** Physical surface types. world.raycast hits and materials report one of these. */
export const SURFACES = Object.freeze([
  'concrete', 'asphalt', 'brick', 'plaster', 'metal', 'wood', 'dirt', 'gravel', 'sand',
  'glass', 'fabric', 'flesh', 'rubber', 'cardboard', 'tile', 'water', 'grass', 'default',
]);

/** Fixed system folder names in dependency (init/update) order. */
export const SYSTEM_ORDER = Object.freeze([
  'materials', 'lighting', 'world', 'postfx', 'player', 'weapons',
  'combat', 'vfx', 'ai', 'network', 'audio', 'hud', 'gamemode',
]);

/** Units: 1 world unit = 1 meter. +Y up. Player forward at yaw 0 is -Z. Angles in radians at runtime. */
export const PLAYER_DIMENSIONS = Object.freeze({
  radius: 0.35,
  standHeight: 1.8,
  crouchHeight: 1.2,
  proneHeight: 0.6,
  standEye: 1.64,
  crouchEye: 1.1,
  proneEye: 0.4,
});

export const DEG = Math.PI / 180;

/** Convert horizontal FOV (deg) to vertical FOV (deg) for an aspect ratio. */
export function hfovToVfov(hfovDeg, aspect) {
  return (2 * Math.atan(Math.tan((hfovDeg * DEG) / 2) / aspect)) / DEG;
}

/** Settings FOV is defined at 16:9 (CoD-style "horizontal at 16:9"); returns vertical fov in degrees. */
export function settingsFovToVfov(hfovDeg) {
  return hfovToVfov(hfovDeg, 16 / 9);
}

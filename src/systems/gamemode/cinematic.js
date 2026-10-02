import * as THREE from 'three';

/**
 * gamemode/cinematic.js — slow establishing-shot camera behind the main menu / end-of-game summary.
 *
 * Runs in gamemode.lateUpdate (after player.lateUpdate) ONLY while a full-screen menu is up, so the
 * player keeps owning the camera during gameplay. The viewmodel layer is hidden while it is active.
 *
 * Path: a slow orbit around the objective (the plaza). Radii are pre-validated with world raycasts when the
 * cinematic starts (never per frame), so the camera doesn't sit inside a building on the final map.
 * A world may publish `world.cameras.menu = [{position:[x,y,z], target:[x,y,z]}, ...]` (optional
 * extension); those shots are then used instead (slow dolly between consecutive pairs).
 */
const SAMPLES = 48;
const LATERAL = 7.5; // m: framing offset of the look target (positive = subject moves right in frame)

export function createCinematic(ctx) {
  const cam = ctx.camera;
  const center = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const look = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const o = new THREE.Vector3();
  const radii = new Float32Array(SAMPLES);
  let active = false;
  let height = 5;
  let baseRadius = 16;
  let custom = null;
  let savedVM = true;
  let angle0 = 0.35;

  function prepare(objective) {
    center.copy(objective);
    const world = ctx.services.world;
    const shots = world.cameras?.menu;
    custom = Array.isArray(shots) && shots.length ? shots : null;
    if (custom) return;
    const b = world.bounds;
    const span = b ? Math.min(b.max.x - b.min.x, b.max.z - b.min.z) : 60;
    baseRadius = THREE.MathUtils.clamp(span * 0.2, 12, 24);
    height = 12.5; // crane height: above the plaza tree canopies, below the roof lines
    for (let i = 0; i < SAMPLES; i++) {
      const a = (i / SAMPLES) * Math.PI * 2;
      dir.set(Math.cos(a), -0.12, Math.sin(a)).normalize();
      o.set(center.x, center.y + height + 1.5, center.z);
      let r = baseRadius;
      try {
        const hit = world.raycast(o, dir, baseRadius + 2);
        if (hit) r = Math.max(4, Math.min(baseRadius, hit.distance - 1.6));
      } catch { /* world may be a stub */ }
      radii[i] = r;
    }
    // smooth so the dolly never pops
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < SAMPLES; i++) {
        const a = radii[(i + SAMPLES - 1) % SAMPLES];
        const c = radii[(i + 1) % SAMPLES];
        radii[i] = Math.min(radii[i], (a + radii[i] + c) / 3);
      }
    }
  }

  function radiusAt(a) {
    const f = ((a / (Math.PI * 2)) % 1 + 1) % 1 * SAMPLES;
    const i = Math.floor(f);
    const t = f - i;
    return radii[i % SAMPLES] * (1 - t) + radii[(i + 1) % SAMPLES] * t;
  }

  function start(objective, phase = 0) {
    prepare(objective);
    angle0 = 0.35 + phase;
    if (!active) {
      savedVM = cam.layers.isEnabled(ctx.layers.VIEWMODEL);
      cam.layers.disable(ctx.layers.VIEWMODEL);
    }
    active = true;
  }

  function stop() {
    if (!active) return;
    active = false;
    if (savedVM) cam.layers.enable(ctx.layers.VIEWMODEL);
  }

  /** @param t seconds (ui clock) */
  function apply(t) {
    if (!active) return;
    if (custom) {
      const n = custom.length;
      const seg = 14; // seconds per shot
      const k = Math.floor(t / seg) % n;
      const u = (t % seg) / seg;
      const s = custom[k];
      pos.fromArray(s.position);
      look.fromArray(s.target);
      // slow push-in along the view direction
      dir.subVectors(look, pos).normalize();
      pos.addScaledVector(dir, u * 3);
    } else {
      const a = angle0 + t * 0.028;
      const r = radiusAt(a);
      pos.set(center.x + Math.cos(a) * r, center.y + height + Math.sin(t * 0.21) * 0.35, center.z + Math.sin(a) * r);
      // look past the plaza centre and slightly to the left of it, so the fountain sits right of frame
      // (the summary text column covers the left ~55% of the screen)
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      look.set(center.x - ca * 3 - sa * LATERAL, center.y + 0.8, center.z - sa * 3 + ca * LATERAL);
    }
    cam.position.copy(pos);
    cam.lookAt(look);
    const vfov = 42;
    if (Math.abs(cam.fov - vfov) > 1e-4) { cam.fov = vfov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
  }

  return { start, stop, apply, get active() { return active; } };
}

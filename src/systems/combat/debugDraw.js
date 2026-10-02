import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

/**
 * Ballistics debug overlay (settings combat.debugDraw or services.combat.setDebugDraw(true)).
 * Draws the last N shots as screen-space fat lines: flight (amber), inside material (red), exit
 * markers (green), body hits (magenta), explosion radii (orange), grenade paths (cyan).
 * Ring buffer; geometry is re-uploaded at most once per frame (flush()) and only while enabled.
 */
const MAX_SEGS = 2048;

export function createDebugDraw(ctx) {
  const positions = new Float32Array(MAX_SEGS * 6);
  const colors = new Float32Array(MAX_SEGS * 6);
  let geo = new LineSegmentsGeometry();
  const mat = new LineMaterial({ vertexColors: true, linewidth: 3, transparent: true, opacity: 0.95, depthTest: false, toneMapped: false, worldUnits: false });
  mat.resolution.set(ctx.engine?.width || 1920, ctx.engine?.height || 1080);
  const lines = new LineSegments2(geo, mat);
  lines.name = 'combat_debug';
  lines.frustumCulled = false;
  lines.renderOrder = 999;
  lines.layers.set(ctx.layers.FX);
  let head = 0;
  let count = 0;
  let enabled = false;
  let dirty = false;
  const c = new THREE.Color();

  function seg(a, b, hex) {
    const i = head * 6;
    positions[i] = a.x; positions[i + 1] = a.y; positions[i + 2] = a.z;
    positions[i + 3] = b.x; positions[i + 4] = b.y; positions[i + 5] = b.z;
    c.setHex(hex);
    colors[i] = colors[i + 3] = c.r; colors[i + 1] = colors[i + 4] = c.g; colors[i + 2] = colors[i + 5] = c.b;
    head = (head + 1) % MAX_SEGS;
    count = Math.min(MAX_SEGS, count + 1);
    dirty = true;
  }

  function flush() {
    if (!enabled || !dirty) return;
    dirty = false;
    // LineSegmentsGeometry allocates its instanced buffers per setPositions: debug-only path.
    const n = count * 6;
    geo.dispose();
    geo = new LineSegmentsGeometry();
    geo.setPositions(positions.subarray(0, n));
    geo.setColors(colors.subarray(0, n));
    lines.geometry = geo;
    mat.resolution.set(ctx.engine?.width || 1920, ctx.engine?.height || 1080);
  }

  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  function cross(p, size, hex) {
    seg(_a.copy(p).setX(p.x - size), _b.copy(p).setX(p.x + size), hex);
    seg(_a.copy(p).setY(p.y - size), _b.copy(p).setY(p.y + size), hex);
    seg(_a.copy(p).setZ(p.z - size), _b.copy(p).setZ(p.z + size), hex);
  }

  function shot(origin, res) {
    if (!enabled) return;
    let from = origin;
    for (const h of res.hits) {
      seg(from, h.point, 0xffb020);
      cross(h.point, 0.05, h.kind === 'world' ? 0xffffff : 0xff30ff);
      if (h.penetrated) { seg(h.point, h.exitPoint, 0xff1010); cross(h.exitPoint, 0.045, 0x30ff60); from = h.exitPoint; } else from = h.point;
    }
    seg(from, res.end, 0xffb020);
  }

  function ring(center, radius, hex) {
    if (!enabled) return;
    const N = 48;
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
      _a.set(center.x + Math.cos(a0) * radius, center.y + 0.05, center.z + Math.sin(a0) * radius);
      _b.set(center.x + Math.cos(a1) * radius, center.y + 0.05, center.z + Math.sin(a1) * radius);
      seg(_a, _b, hex);
    }
  }

  function setEnabled(on) {
    enabled = !!on;
    if (enabled && !lines.parent) ctx.scene.add(lines);
    if (!enabled && lines.parent) lines.parent.remove(lines);
    if (enabled) dirty = true;
  }

  function clear() { head = 0; count = 0; dirty = true; }

  function dispose() { setEnabled(false); geo.dispose(); mat.dispose(); }

  return { shot, ring, seg, cross, flush, setEnabled, get enabled() { return enabled; }, clear, dispose };
}

import * as THREE from 'three';

/** Procedural meshes for mesh particles. All built once at init. */

function jitter(geo, amount, seed, scale = [1, 1, 1]) {
  // deterministic per-vertex jitter keyed on position so shared vertices move together
  const pos = geo.attributes.position;
  const h = (x, y, z, k) => {
    const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + k * 19.19 + seed * 3.3) * 43758.5453;
    return s - Math.floor(s) - 0.5;
  };
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const r = 1 + h(x, y, z, 1) * amount;
    pos.setXYZ(i, x * r * scale[0], y * r * scale[1], z * r * scale[2]);
  }
  pos.needsUpdate = true;
  return geo;
}

function flat(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  if (g !== geo) geo.dispose();
  return g;
}

/** 5.56-style bottleneck casing, local +Y = mouth, centered on its middle. Length 45 mm. */
export function rifleCasing() {
  const P = (r, y) => new THREE.Vector2(r, y);
  const pts = [
    P(0.0, 0.0), P(0.0038, 0.0), P(0.0047, 0.0004), P(0.0048, 0.0012), P(0.0041, 0.0016), P(0.0040, 0.0028),
    P(0.0047, 0.0034), P(0.0048, 0.0060), P(0.00455, 0.0355), P(0.0032, 0.0392), P(0.0031, 0.0450),
    P(0.0027, 0.0450), P(0.0027, 0.0420), P(0.0, 0.0420),
  ];
  const g = new THREE.LatheGeometry(pts, 14);
  g.translate(0, -0.0225, 0);
  g.computeVertexNormals();
  return g;
}

/** 9 mm straight casing, 19 mm. */
export function pistolCasing() {
  const P = (r, y) => new THREE.Vector2(r, y);
  const pts = [
    P(0.0, 0.0), P(0.0042, 0.0), P(0.0049, 0.0004), P(0.0049, 0.0012), P(0.0044, 0.0016), P(0.0044, 0.0024),
    P(0.00495, 0.003), P(0.0048, 0.019), P(0.0044, 0.019), P(0.0044, 0.016), P(0.0, 0.016),
  ];
  const g = new THREE.LatheGeometry(pts, 14);
  g.translate(0, -0.0095, 0);
  g.computeVertexNormals();
  return g;
}

/** Faceted rock / concrete chip, radius ~1. */
export function chip() {
  return flat(jitter(new THREE.IcosahedronGeometry(1, 0), 0.55, 1, [1, 0.6, 0.85]));
}

/** Lumpy dirt clod / rubble, radius ~1. */
export function clod() {
  return flat(jitter(new THREE.IcosahedronGeometry(1, 1), 0.5, 7, [1, 0.75, 0.9]));
}

/** Wood splinter: long thin tapered sliver along Y, length 1. */
export function splinter() {
  const g = new THREE.BoxGeometry(0.14, 1, 0.07, 1, 3, 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = 1 - Math.abs(y) * 1.7;
    pos.setX(i, pos.getX(i) * Math.max(0.12, t) + Math.sin(y * 9) * 0.02);
    pos.setZ(i, pos.getZ(i) * Math.max(0.2, t));
  }
  return flat(g);
}

/** Glass shard: thin irregular triangle, size ~1. */
export function shard() {
  const s = new THREE.Shape();
  s.moveTo(-0.5, -0.4);
  s.lineTo(0.55, -0.3);
  s.lineTo(0.05, 0.6);
  s.lineTo(-0.2, 0.25);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.04, bevelEnabled: false });
  g.translate(0, 0, -0.02);
  return flat(g);
}

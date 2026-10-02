import * as THREE from 'three';

/**
 * Lighting lab: a self-contained test block (street, alley, props) used by the lighting-lab-* shots so the
 * lighting system can be judged independently of the world system's progress. Everything here is owned by
 * the lighting agent and only exists inside lab shots.
 */
function worldUV(geo, w, h, d) {
  const uv = geo.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) {
    const i = f * 4 + v;
    uv.setXY(i, uv.getX(i) * dims[f][0], uv.getY(i) * dims[f][1]);
  }
  return geo;
}

export function buildLab(ctx) {
  const root = new THREE.Group();
  root.name = 'lighting-lab';
  const M = (n) => ctx.services.materials.get(n);
  const box = (w, h, d, x, y, z, mat, ry = 0, rx = 0, rz = 0) => {
    const m = new THREE.Mesh(worldUV(new THREE.BoxGeometry(w, h, d), w, h, d), typeof mat === 'string' ? M(mat) : mat);
    m.position.set(x, y + h / 2, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    m.receiveShadow = true;
    root.add(m);
    return m;
  };
  const cyl = (r, h, x, y, z, mat, seg = 16) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), M(mat));
    m.position.set(x, y + h / 2, z);
    m.castShadow = m.receiveShadow = true;
    root.add(m);
    return m;
  };

  // ground
  const g = new THREE.PlaneGeometry(900, 900, 1, 1).rotateX(-Math.PI / 2);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 900, uv.getY(i) * 900);
  const ground = new THREE.Mesh(g, M('dirt'));
  ground.receiveShadow = true;
  root.add(ground);
  box(12, 0.03, 160, 0, 0, -30, 'asphalt');
  box(3, 0.15, 160, -7.5, 0, -30, 'concrete_floor');
  box(3, 0.15, 160, 7.5, 0, -30, 'concrete_floor');

  // west block: apartment slabs with gaps
  const west = [[-40, 22, 15, 'concrete_wall'], [-58, 12, 12, 'plaster_painted'], [-20, 14, 10, 'brick_red'], [4, 18, 13, 'concrete_wall'], [22, 10, 9, 'plaster_painted']];
  for (const [z, len, hgt, mat] of west) box(12, hgt, len, -15, 0, z, mat);
  // east block, with an east-west alley at z = -20 (3 m wide)
  box(12, 13, 20, 15, 0, -8, 'brick_red');
  box(12, 16, 22, 15, 0, -32.5, 'concrete_wall');
  box(12, 9, 14, 15, 0, 14, 'plaster_painted');
  box(12, 11, 18, 15, 0, -58, 'plaster_painted');
  // alley continues east between two more buildings
  box(14, 12, 10, 28, 0, -13.5, 'plaster_painted');
  box(14, 14, 10, 28, 0, -26.5, 'brick_red');
  // overhead clutter in the alley (beams / walkway / cables) for light shafts
  for (let i = 0; i < 6; i++) box(0.25, 0.25, 3.4, 12 + i * 3.2, 7 + (i % 2) * 1.5, -20, 'metal_rusted');
  box(2.2, 0.2, 3.4, 26, 9, -20, 'corrugated_metal');
  box(0.12, 2.2, 3.2, 31, 4, -20, 'wood_planks');
  // balconies / slabs on the west facade (street side)
  for (let i = 0; i < 4; i++) box(1.2, 0.18, 3, -8.4, 3.2 + i * 3, -38 + i * 0.5, 'concrete_floor');
  // roof parapets & water tanks
  box(12, 1.0, 0.3, -15, 15, -29.2, 'concrete_wall');
  cyl(1.2, 2.5, -12, 15, -45, 'metal_rusted');

  // street furniture / cover props near the camera
  box(1.2, 1.2, 1.2, -4, 0, -6, 'wood_planks');
  box(1.2, 1.2, 1.2, -5.3, 0, -6.3, 'wood_planks', 0.3);
  box(1.2, 1.2, 1.2, -4.6, 1.2, -6.1, 'wood_planks', -0.2);
  box(3, 0.9, 0.7, 2.5, 0, -4, 'sandbags');
  box(0.7, 0.9, 2.2, 4.3, 0, -2.8, 'sandbags');
  // jersey barriers
  for (let i = 0; i < 3; i++) box(3.6, 0.8, 0.6, -2 + i * 3.8, 0, -14 - i * 0.2, 'concrete_wall', 0.05 * i);
  // burnt car stand-in
  box(1.8, 0.7, 4.3, 3.2, 0.25, -24, 'metal_painted', 0.2);
  box(1.6, 0.6, 2.2, 3.1, 0.95, -24.3, 'metal_painted', 0.2);
  // lamp posts & a sign pole (thin casters)
  for (let i = 0; i < 5; i++) {
    cyl(0.08, 6, 6.2, 0.15, 10 - i * 18, 'metal_painted', 10);
    box(1.2, 0.08, 0.12, 5.7, 6.1, 10 - i * 18, 'metal_painted');
  }
  // chain of posts with wire (very thin casters)
  for (let i = 0; i < 6; i++) cyl(0.04, 1.4, -6 + i * 1.6, 0, 2, 'metal_rusted', 8);
  box(8, 0.02, 0.02, -2, 1.3, 2, 'metal_rusted');
  // container
  box(2.4, 2.6, 6, -3.5, 0, -40, 'corrugated_metal', 0.1);

  // a distant block row (checks aerial perspective at 100-300 m)
  for (let i = 0; i < 12; i++) {
    const x = -140 + i * 26;
    box(18, 12 + (i * 7) % 15, 14, x, 0, -170 - (i % 3) * 25, i % 2 ? 'plaster_painted' : 'concrete_wall');
  }
  ctx.scene.add(root);
  return root;
}

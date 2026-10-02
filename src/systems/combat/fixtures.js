import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * Combat test-range fixtures (used by src/shots/combat.js and tools/combat/test-ballistics.mjs).
 * Builds wall sections of catalog materials and zoned silhouette targets, registers them as world
 * colliders / damageables, and returns handles + a dispose().
 *
 *   const range = buildRange(ctx, { origin: [x, y|null, z], yaw: deg });
 *   range.panel({ name, material, w, h, t, x, z, y?, ry? })   -> Mesh (world collider)
 *   range.target({ x, z, ry?, health?, name? })               -> { group, damageable }
 *   range.toWorld([x, y, z]) -> Vector3 ;  range.finish() (commit colliders) ;  range.dispose()
 *
 * Local frame: +X right, +Y up, -Z away from the shooter (like the camera at yaw 0).
 */
/**
 * When the world system is missing (disabled via `only`, or broken mid-edit by its owner), install a
 * minimal Raycaster world over whatever colliders get added, so combat shots/tests still function.
 * Returns 'real' or 'fallback'. Never used by the game itself.
 */
export function ensureWorld(ctx) {
  if (ctx.services.isProvided('world')) return 'real';
  const colliders = [];
  const rc = new THREE.Raycaster();
  const toHit = (i) => ({
    point: i.point.clone(), normal: i.face.normal.clone().transformDirection(i.object.matrixWorld), distance: i.distance,
    object: i.object, material: i.object.material, surface: i.object.userData.surface || i.object.material?.userData?.surface || 'default',
  });
  ctx.services.provide('world', {
    ready: Promise.resolve(),
    colliders,
    raycast(o, d, far = 1000) { rc.set(o, d); rc.far = far; const h = rc.intersectObjects(colliders, false); return h.length ? toHit(h[0]) : null; },
    raycastAll(o, d, far = 1000) { rc.set(o, d); rc.far = far; return rc.intersectObjects(colliders, false).map(toHit); },
    collideCapsule() { return false; },
    addCollider(obj) { obj.updateMatrixWorld(true); obj.traverse((m) => { if (m.isMesh) colliders.push(m); }); },
    removeCollider(obj) { obj.traverse((m) => { const i = colliders.indexOf(m); if (i >= 0) colliders.splice(i, 1); }); },
    groundHeight() { return 0; },
  });
  console.warn('[system:combat] world service missing: using the combat fixture fallback world');
  return 'fallback';
}

export function buildRange(ctx, { origin = [0, null, 230], yaw = 0, floor = true, floorSize = [30, 34] } = {}) {
  const world = ctx.services.world;
  const mats = ctx.services.materials;
  const root = new THREE.Group();
  root.name = 'combat_range';
  const geos = [];
  const colliders = [];
  const damageables = [];
  const ownedMats = [];

  const ox = origin[0], oz = origin[2];
  let oy = origin[1];
  if (oy == null) {
    const gh = world.raycast(new THREE.Vector3(ox, 200, oz), new THREE.Vector3(0, -1, 0), 400);
    oy = gh ? gh.point.y : 0;
  }
  root.position.set(ox, oy, oz);
  root.rotation.y = (yaw * Math.PI) / 180;
  ctx.scene.add(root);
  const solid = new THREE.Group();
  solid.name = 'combat_range_solid';
  root.add(solid);

  function uvBox(geo, w, h, d) {
    const uv = geo.attributes.uv;
    const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * dims[f][0], uv.getY(i) * dims[f][1]);
    }
    uv.needsUpdate = true;
    return geo;
  }

  function box(w, h, d, material, x, y, z, ry = 0, { collide = true } = {}) {
    const g = uvBox(new THREE.BoxGeometry(w, h, d), w, h, d);
    geos.push(g);
    const m = new THREE.Mesh(g, typeof material === 'string' ? mats.get(material) : material);
    m.position.set(x, y + h / 2, z);
    m.rotation.y = ry;
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.surface = typeof material === 'string' ? mats.surfaceOf(material) : material.userData?.surface || 'default';
    if (collide) { solid.add(m); colliders.push(m); } else root.add(m);
    return m;
  }

  let floorTop = 0;
  if (floor) {
    box(floorSize[0], 0.12, floorSize[1], 'concrete_floor', 0, 0, -floorSize[1] / 2 + 6);
    floorTop = 0.12;
  }

  function panel({ material, w = 1.2, h = 2.2, t = 0.2, x = 0, z = -5, y = 0, ry = 0, name } = {}) {
    const m = box(w, h, t, material, x, floorTop + y, z, ry);
    m.name = name || `panel_${material}`;
    return m;
  }

  /**
   * Sandbag wall: running-bond courses of pillow-shaped bags (each course offset by half a bag),
   * `lines` bags deep, compressed a little under the weight above. World colliders ('sandbags').
   */
  function sandbags({ x = 0, z = -5, w = 1.4, rows = 4, depth = 0.6, ry = 0 } = {}) {
    const bagL = 0.6, bagH = 0.2, bagW = 0.34;
    const geo = new RoundedBoxGeometry(bagL, bagH, bagW, 4, 0.085);
    geos.push(geo);
    // bulge the top/bottom faces (a filled bag is pillow-shaped, not a box)
    {
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
        const fx = 1 - Math.pow(Math.abs(px) / (bagL / 2), 2), fz = 1 - Math.pow(Math.abs(pz) / (bagW / 2), 2);
        pos.setY(i, py * (1 + 0.28 * Math.max(0, fx) * Math.max(0, fz)));
        // tied end: pinch one short end
        if (px > bagL * 0.38) { const k = (px - bagL * 0.38) / (bagL * 0.12); pos.setY(i, pos.getY(i) * (1 - 0.35 * k)); pos.setZ(i, pz * (1 - 0.3 * k)); }
      }
      geo.computeVertexNormals();
      // RoundedBox UVs are 0..1 per face; scale to ~metres so the catalog texture tiles like the world
      const uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * bagL, uv.getY(i) * bagW * 1.6);
    }
    const mat = mats.get('sandbags');
    const grp = new THREE.Group();
    grp.position.set(x, floorTop, z);
    grp.rotation.y = ry;
    solid.add(grp);
    const lines = Math.max(1, Math.round(depth / bagW));
    const courseH = bagH * 0.86;
    let k = 0;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * bagL * 0.5;
      const n = Math.ceil(w / bagL) + 1;
      for (let l = 0; l < lines; l++) {
        const lz = (l - (lines - 1) / 2) * bagW * 0.96;
        for (let i = 0; i < n; i++) {
          let bx = -w / 2 + bagL / 2 + i * bagL * 0.97 - off;
          if (bx + bagL / 2 < -w / 2 + 0.1 || bx - bagL / 2 > w / 2 - 0.1) continue;
          bx = Math.max(-w / 2 + bagL * 0.45, Math.min(w / 2 - bagL * 0.45, bx));
          const m = new THREE.Mesh(geo, mat);
          const j = Math.sin((k + 1) * 12.9898) * 43758.5453; const jr = j - Math.floor(j);
          const j2 = Math.sin((k + 1) * 78.233) * 12345.678; const jr2 = j2 - Math.floor(j2);
          m.position.set(bx + (jr - 0.5) * 0.03, bagH * 0.5 + r * courseH, lz + (jr2 - 0.5) * 0.03);
          m.rotation.set((jr2 - 0.5) * 0.06, (jr - 0.5) * 0.14 + ((k % 2) ? Math.PI : 0), (jr - 0.5) * 0.05);
          m.scale.set(0.96 + jr2 * 0.08, 0.9 + jr * 0.14, 1);
          m.castShadow = true; m.receiveShadow = true;
          m.userData.surface = mats.surfaceOf('sandbags');
          grp.add(m);
          colliders.push(m);
          k++;
        }
      }
    }
    return grp;
  }

  // ---------------------------------------------------------------- silhouette target
  // One extruded cardboard figure (head, shoulders, arms) with a printed scoring overlay, stapled to two
  // wooden stakes in a steel foot. The zones are invisible hitboxes in the figure's plane.
  const SIL = [ // right half outline (x >= 0), bottom -> head; mirrored for the left
    [0.0, 0.92], [0.2, 0.92], [0.222, 1.3], [0.255, 1.02], [0.372, 1.02], [0.392, 1.4], [0.35, 1.5],
    [0.3, 1.535], [0.09, 1.565], [0.066, 1.6],
  ];
  const HEAD = { cx: 0, cy: 1.74, r: 0.118 };
  let silGeo = null, overlayGeo = null, overlayMat = null, hitMat = null;
  const tgtMat = mats.clone('cardboard');
  tgtMat.color.multiplyScalar(0.92);
  ownedMats.push(tgtMat);
  function silhouetteShape() {
    const sh = new THREE.Shape();
    sh.moveTo(-SIL[0][0], SIL[0][1]);
    for (let i = 1; i < SIL.length; i++) sh.lineTo(SIL[i][0], SIL[i][1]);
    // the neck meets the head circle where x = neck half-width (below the centre)
    const nx = SIL[SIL.length - 1][0];
    const a0 = Math.atan2(-Math.sqrt(HEAD.r * HEAD.r - nx * nx), nx);
    sh.lineTo(nx, HEAD.cy + HEAD.r * Math.sin(a0));
    sh.absarc(HEAD.cx, HEAD.cy, HEAD.r, a0, Math.PI - a0, false);
    for (let i = SIL.length - 1; i >= 0; i--) sh.lineTo(-SIL[i][0], SIL[i][1]);
    return sh;
  }
  function buildTargetAssets() {
    if (silGeo) return;
    const sh = silhouetteShape();
    silGeo = new THREE.ExtrudeGeometry(sh, { depth: 0.008, bevelEnabled: false, curveSegments: 20 });
    geos.push(silGeo);
    overlayGeo = new THREE.ShapeGeometry(sh, 20);
    const pos = overlayGeo.attributes.position, uv = overlayGeo.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + 0.4) / 0.8, (pos.getY(i) - 0.9) / 1.0);
    overlayGeo.translate(0, 0, 0.0088);
    geos.push(overlayGeo);
    // printed scoring zones (original layout): thin brown perforation lines + zone numerals
    const tex = ctx.assets.canvasTexture(256, 320, (g, W, H) => {
      g.clearRect(0, 0, W, H);
      const X = (x) => ((x + 0.4) / 0.8) * W, Y = (y) => (1 - (y - 0.9) / 1.0) * H;
      g.strokeStyle = 'rgba(58,40,24,0.55)';
      g.lineWidth = 1.6;
      g.setLineDash([4, 3]);
      const rr = (x0, y0, x1, y1, r) => { g.beginPath(); g.roundRect(X(x0), Y(y1), X(x1) - X(x0), Y(y0) - Y(y1), r); g.stroke(); };
      rr(-0.1, 1.2, 0.1, 1.5, 6); // chest A
      rr(-0.17, 1.02, 0.17, 1.54, 10); // C
      rr(-0.055, 1.68, 0.055, 1.8, 4); // head A
      g.setLineDash([]);
      g.fillStyle = 'rgba(58,40,24,0.5)';
      g.font = 'bold 13px Arial, sans-serif';
      g.textAlign = 'center';
      g.fillText('A', X(0), Y(1.33));
      g.fillText('C', X(0.13), Y(1.1));
      g.fillText('D', X(0.3), Y(1.1));
      g.font = '9px Arial, sans-serif';
      g.fillText('RANGE 7 / OV-3', X(0), Y(0.95));
    }, { srgb: true });
    overlayMat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.9, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    overlayMat.userData.ownedMap = tex;
    ownedMats.push(overlayMat);
    hitMat = new THREE.MeshBasicMaterial({ visible: false });
    ownedMats.push(hitMat);
  }
  function target({ x = 0, z = -8, ry = 0, health = 100, name = 'Target', team = 'enemy' } = {}) {
    buildTargetAssets();
    const g = new THREE.Group();
    g.position.set(x, floorTop, z);
    g.rotation.y = ry;
    root.add(g);
    // stand: steel foot + two wooden stakes behind the figure
    const stakeGeo = new THREE.BoxGeometry(0.04, 1.3, 0.035); geos.push(stakeGeo);
    const footGeo = new THREE.BoxGeometry(0.62, 0.04, 0.34); geos.push(footGeo);
    const sockGeo = new THREE.BoxGeometry(0.07, 0.16, 0.07); geos.push(sockGeo);
    const wood = mats.get('wood_planks');
    const steel = mats.get(mats.has('metal_rusted') ? 'metal_rusted' : 'metal_painted');
    const add = (geo, mat, px, py, pz, cast = true) => {
      const m = new THREE.Mesh(geo, mat); m.position.set(px, py, pz); m.castShadow = cast; m.receiveShadow = true; g.add(m); return m;
    };
    add(footGeo, steel, 0, 0.02, -0.03);
    for (const sx of [-0.16, 0.16]) { add(sockGeo, steel, sx, 0.12, -0.03); add(stakeGeo, wood, sx, 0.65, -0.03); }
    // figure
    const fig = add(silGeo, tgtMat, 0, 0, 0);
    fig.name = `${name}_figure`;
    add(overlayGeo, overlayMat, 0, 0, 0, false);
    // hitboxes (invisible, same plane as the figure)
    const hit = new THREE.Group();
    g.add(hit);
    const box = (w, h, px, py, zone) => {
      const geo = new THREE.BoxGeometry(w, h, 0.03); geos.push(geo);
      const m = new THREE.Mesh(geo, hitMat); m.position.set(px, py, 0.004); m.userData.zone = zone; hit.add(m); return m;
    };
    box(0.42, 0.42, 0, 1.13, 'stomach');
    box(0.44, 0.08, 0, 1.38, 'chest');
    box(0.78, 0.15, 0, 1.495, 'chest');
    box(0.13, 0.05, 0, 1.595, 'neck');
    box(0.135, 0.4, -0.315, 1.22, 'arm');
    box(0.135, 0.4, 0.315, 1.22, 'arm');
    const headGeo = new THREE.CylinderGeometry(HEAD.r, HEAD.r, 0.03, 24).rotateX(Math.PI / 2); geos.push(headGeo);
    const head = new THREE.Mesh(headGeo, hitMat); head.position.set(0, HEAD.cy, 0.004); head.userData.zone = 'head'; hit.add(head);
    const d = ctx.services.combat.registerDamageable({ object: hit, health, name, team, surface: 'cardboard' });
    damageables.push(d);
    return { group: g, hit, figure: fig, damageable: d };
  }

  function toWorld(p, out = new THREE.Vector3()) {
    out.set(p[0], p[1] + floorTop, p[2]);
    root.updateMatrixWorld(true);
    return out.applyMatrix4(root.matrixWorld);
  }

  function dirToWorld(d, out = new THREE.Vector3()) {
    return out.set(d[0], d[1], d[2]).applyAxisAngle(new THREE.Vector3(0, 1, 0), root.rotation.y).normalize();
  }

  function finish() {
    root.updateMatrixWorld(true);
    if (colliders.length) world.addCollider(solid);
  }

  function dispose() {
    if (colliders.length) world.removeCollider(solid);
    for (const d of damageables) d.unregister();
    root.removeFromParent();
    for (const g of geos) g.dispose();
    for (const m of ownedMats) { m.userData.ownedMap?.dispose(); m.dispose(); }
  }

  return { root, panel, target, box, sandbags, toWorld, dirToWorld, finish, dispose, get floorTop() { return floorTop; }, origin: new THREE.Vector3(ox, oy, oz), yaw };
}

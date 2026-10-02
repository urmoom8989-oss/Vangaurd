import * as THREE from 'three';

/**
 * Shot presets owned by the VFX agent. Names start with "vfx-".
 *
 * Most presets build a small, self-contained "VFX range" far from the level (so level edits by the world owner
 * never change these shots): a concrete slab, a dirt patch and a row of wall panels (concrete, brick, plaster,
 * painted metal, wood, glass). Panels register as world colliders when the world service is up, so raycasts
 * (blood splatter, sun visibility, ground height) work exactly like in game.
 */
const X0 = 300, Z0 = 300;
const RANGE_SYSTEMS = ['materials', 'lighting', 'world', 'postfx', 'player', 'vfx'];
const PANELS = ['concrete_wall', 'brick_red', 'plaster_painted', 'metal_painted', 'wood_planks', 'glass'];
const PANEL_W = 1.4;

function worldUV(geo, w, h, d) {
  const uv = geo.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) { const i = f * 4 + v; uv.setXY(i, uv.getX(i) * dims[f][0], uv.getY(i) * dims[f][1]); }
  uv.needsUpdate = true;
  return geo;
}

function box(ctx, group, w, h, d, x, y, z, mat, rotY = 0) {
  const g = worldUV(new THREE.BoxGeometry(w, h, d), w, h, d);
  const m = new THREE.Mesh(g, ctx.services.materials.get(mat));
  m.position.set(x, y, z);
  m.rotation.y = rotY;
  m.castShadow = true;
  m.receiveShadow = true;
  m.userData.surface = ctx.services.materials.surfaceOf(mat);
  group.add(m);
  return m;
}

/** Builds the range once per page. Returns panel centers. */
function buildRange(ctx) {
  if (ctx.__vfxRange) return ctx.__vfxRange;
  const g = new THREE.Group();
  g.name = 'vfx_range';
  const meshes = [];
  meshes.push(box(ctx, g, 16, 0.2, 16, X0, -0.1, Z0, 'concrete_floor'));
  meshes.push(box(ctx, g, 4, 0.2, 3, X0 + 3.5, 0.0, Z0 + 1.2, 'dirt'));
  const panels = [];
  const total = PANELS.length * PANEL_W;
  PANELS.forEach((mat, i) => {
    const x = X0 - total / 2 + PANEL_W * (i + 0.5);
    const thick = mat === 'glass' ? 0.02 : 0.3;
    const m = box(ctx, g, PANEL_W - 0.04, 2.6, thick, x, 1.3, Z0 - 3, mat);
    if (mat === 'glass') m.castShadow = false;
    meshes.push(m);
    panels.push({ mat, x, z: Z0 - 3 + thick / 2, surface: ctx.services.materials.surfaceOf(mat) });
  });
  // back wall behind the panels (for glass) and a side wall
  meshes.push(box(ctx, g, 10, 3.2, 0.3, X0, 1.6, Z0 - 4.6, 'concrete_wall'));
  meshes.push(box(ctx, g, 0.3, 3.2, 6, X0 - 5.2, 1.6, Z0 - 1.5, 'brick_red'));
  ctx.scene.add(g);
  g.updateMatrixWorld(true);
  const world = ctx.services.world;
  if (ctx.services.isProvided?.('world')) for (const m of meshes) { try { world.addCollider(m); } catch { /* ignore */ } }
  ctx.__vfxRange = { group: g, panels };
  return ctx.__vfxRange;
}

/** A stand-in rifle (receiver, handguard, barrel, muzzle brake with a 'muzzle' socket, 'ejection' socket). */
function dummyRifle(ctx, pos, yaw) {
  const grp = new THREE.Group();
  grp.name = 'vfx_dummy_rifle';
  const mat = ctx.services.materials.get('metal_gun_black');
  const poly = ctx.services.materials.get('polymer_gun');
  const add = (geo, m, x, y, z, rx = 0) => { const me = new THREE.Mesh(geo, m); me.position.set(x, y, z); me.rotation.x = rx; me.castShadow = true; me.receiveShadow = true; grp.add(me); return me; };
  add(new THREE.BoxGeometry(0.05, 0.075, 0.36), mat, 0, 0, 0);
  add(new THREE.BoxGeometry(0.056, 0.06, 0.3), poly, 0, 0.005, -0.33);
  add(new THREE.CylinderGeometry(0.0095, 0.0095, 0.2, 16), mat, 0, 0.012, -0.55, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.0125, 0.0125, 0.055, 16), mat, 0, 0.012, -0.675, Math.PI / 2);
  add(new THREE.BoxGeometry(0.04, 0.13, 0.055), poly, 0, -0.1, -0.02);
  add(new THREE.BoxGeometry(0.035, 0.1, 0.045), poly, 0, -0.08, 0.14);
  add(new THREE.BoxGeometry(0.045, 0.075, 0.22), poly, 0, -0.01, 0.3);
  const muzzle = new THREE.Object3D(); muzzle.name = 'muzzle'; muzzle.position.set(0, 0.012, -0.705); grp.add(muzzle);
  const ej = new THREE.Object3D(); ej.name = 'ejection'; ej.position.set(0.03, 0.015, -0.02); grp.add(ej);
  grp.position.copy(pos);
  grp.rotation.y = yaw;
  ctx.scene.add(grp);
  grp.updateMatrixWorld(true);
  return grp;
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);

const PRESETS = {
  'vfx-muzzle-flash': {
    description: 'First-person rifle muzzle flash on the frame the shot fires (full game, close view).',
    player: { position: [0, null, 8], yaw: 0, pitch: 2 },
    weapon: { id: 'rifle' },
    input: [{ frame: 40, press: 'fire' }],
    warmup: 40,
  },

  'vfx-muzzle-flash-side': {
    description: 'Close third-person look at the rifle muzzle flash (brake side flares, cone, core) on the VFX range.',
    only: RANGE_SYSTEMS,
    player: { position: [X0, 0, Z0 + 3], yaw: 0 },
    camera: { position: [X0 - 0.5, 1.47, Z0 + 0.8], target: [X0 - 0.65, 1.41, Z0], hfov: 55 },
    hud: false,
    warmup: 20,
    setup(ctx) { buildRange(ctx); ctx.__vfxGun = dummyRifle(ctx, V(X0 + 0.15, 1.4, Z0), Math.PI / 2); },
    onFrame(ctx, i) { if (i === 20) ctx.services.vfx.spawn('muzzle_flash', { weaponId: 'rifle', object: ctx.__vfxGun, eject: false }); },
  },

  'vfx-impacts-gallery': {
    description: 'Bullet impacts + decals on concrete, brick, plaster, metal, wood, glass, concrete floor and dirt. Older hits show decals and lingering dust; fresh hits land 0.1 s before capture.',
    only: RANGE_SYSTEMS,
    player: { position: [X0, 0, Z0 + 4], yaw: 0 },
    camera: { position: [X0 + 0.2, 1.55, Z0 + 2.6], target: [X0, 1.05, Z0 - 3], hfov: 82 },
    hud: false,
    warmup: 150,
    setup(ctx) { buildRange(ctx); },
    onFrame(ctx, i) {
      const r = ctx.__vfxRange;
      const vfx = ctx.services.vfx;
      const hit = (p, n, surf) => { vfx.spawn('impact', { point: p, normal: n, surface: surf }); vfx.decal({ point: p, normal: n, surface: surf, kind: 'bullet' }); };
      const nZ = V(0, 0, 1);
      r.panels.forEach((pn, k) => {
        const olds = [[-0.35, 1.9], [0.3, 1.55], [-0.15, 0.7], [0.4, 0.95], [-0.4, 1.25]];
        olds.forEach(([dx, y], j) => { if (i === 5 + j * 11 + k * 3) hit(V(pn.x + dx, y, pn.z), nZ, pn.surface); });
        if (i === 144 - k) hit(V(pn.x + 0.02, 1.35, pn.z), nZ, pn.surface);
      });
      const nY = V(0, 1, 0);
      if (i === 60) hit(V(X0 - 1.5, 0, Z0 - 0.8), nY, 'concrete');
      if (i === 142) hit(V(X0 - 0.6, 0, Z0 - 1.2), nY, 'concrete');
      if (i === 70) hit(V(X0 + 2.6, 0.1, Z0 + 0.3), nY, 'dirt');
      if (i === 143) hit(V(X0 + 1.9, 0.1, Z0 + 0.1), nY, 'dirt');
    },
  },

  'vfx-impacts-close': {
    description: 'Close-up of fresh concrete and metal impacts (0.12 s old) with their decals.',
    only: RANGE_SYSTEMS,
    player: { position: [X0, 0, Z0 + 4], yaw: 0 },
    camera: { position: [X0 - 2.8, 1.5, Z0 - 1.5], target: [X0 - 2.8, 1.38, Z0 - 2.85], hfov: 55 },
    hud: false,
    warmup: 90,
    setup(ctx) { buildRange(ctx); },
    onFrame(ctx, i) {
      const r = ctx.__vfxRange;
      const vfx = ctx.services.vfx;
      const hit = (p, n, surf) => { vfx.spawn('impact', { point: p, normal: n, surface: surf }); vfx.decal({ point: p, normal: n, surface: surf, kind: 'bullet' }); };
      const c = r.panels[0], m = r.panels[3], b = r.panels[1];
      const n = V(0, 0, 1);
      if (i === 10) { hit(V(c.x + 0.3, 1.62, c.z), n, c.surface); hit(V(c.x + 0.45, 1.15, c.z), n, c.surface); hit(V(b.x - 0.35, 1.7, b.z), n, b.surface); }
      if (i === 83) hit(V(c.x + 0.4, 1.4, c.z), n, c.surface);
      if (i === 86) hit(V(b.x - 0.45, 1.25, b.z), n, b.surface);
    },
  },

  'vfx-explosion': {
    description: 'Frag grenade explosion on the concrete slab. Use --sequence 10 --interval 180 to see fireball -> smoke evolution.',
    only: RANGE_SYSTEMS,
    player: { position: [X0, 0, Z0 + 12], yaw: 0 },
    camera: { position: [X0 + 3, 2.2, Z0 + 11], target: [X0, 1.6, Z0 - 0.5], hfov: 75 },
    hud: false,
    warmup: 12,
    setup(ctx) { buildRange(ctx); },
    onFrame(ctx, i) { if (i === 8) ctx.services.vfx.spawn('explosion', { position: V(X0 + 0.5, 0.05, Z0 - 0.5), radius: 6 }); },
  },

  'vfx-smoke': {
    description: 'Smoke grenade 7 s after popping on the range: dense, sun-lit, soft against the ground.',
    only: RANGE_SYSTEMS,
    player: { position: [X0, 0, Z0 + 14], yaw: 0 },
    camera: { position: [X0 + 4, 1.8, Z0 + 12], target: [X0, 1.6, Z0 - 1], hfov: 75 },
    hud: false,
    warmup: 420,
    setup(ctx) { buildRange(ctx); },
    onFrame(ctx, i) {
      if (i === 0) ctx.services.vfx.spawn('smoke', { position: V(X0 + 1, 0.05, Z0 - 0.5), radius: 5, duration: 20 });
      if (i === 400) { const m = ctx.scene.getObjectByName('vfx_smoke').material.uniforms; console.warn('DBGU', JSON.stringify({ sun: m.uSunColor.value, sky: m.uSkyColor.value, gnd: m.uGroundColor.value, dir: m.uSunDir.value, depth: m.uHasDepth.value })); }
    },
  },

  'vfx-shells': {
    description: 'Full-auto brass ejection from a stand-in rifle; use --sequence 8 --interval 80 to see tumbling, bounce and rest.',
    only: RANGE_SYSTEMS,
    player: { position: [X0, 0, Z0 + 4], yaw: 0 },
    camera: { position: [X0 + 1.6, 1.4, Z0 + 2.2], target: [X0 + 0.8, 0.8, Z0 - 0.2], hfov: 60 },
    hud: false,
    warmup: 70,
    setup(ctx) { buildRange(ctx); ctx.__vfxGun = dummyRifle(ctx, V(X0, 1.35, Z0), 0.25); },
    onFrame(ctx, i) {
      if (i >= 10 && i % 5 === 0 && i <= 100) ctx.services.vfx.spawn('muzzle_flash', { weaponId: 'rifle', object: ctx.__vfxGun });
    },
  },

  'vfx-blood': {
    description: 'Bullet hits on a (virtual) target 1 m in front of a concrete wall: exit mist, droplets, back-spatter decals. Last hit lands 4 frames before capture; --sequence 6 --interval 60 shows the mist evolving.',
    only: RANGE_SYSTEMS,
    player: { position: [X0, 0, Z0 + 4], yaw: 0 },
    camera: { position: [X0 - 2.2, 1.6, Z0 + 0.3], target: [X0 - 3.45, 1.4, Z0 - 2.1], hfov: 60 },
    hud: false,
    warmup: 60,
    setup(ctx) { buildRange(ctx); },
    onFrame(ctx, i) {
      const vfx = ctx.services.vfx;
      const x = ctx.__vfxRange.panels[0].x;
      const d = V(0.12, -0.05, -1).normalize();
      if (i === 8) vfx.spawn('blood', { point: V(x + 0.3, 1.55, Z0 - 1.8), normal: V(0, 0, 1), direction: d });
      if (i === 30) vfx.spawn('blood', { point: V(x - 0.35, 1.25, Z0 - 1.9), normal: V(0, 0, 1), direction: d });
      if (i === 56) vfx.spawn('blood', { point: V(x + 0.05, 1.45, Z0 - 1.85), normal: V(-0.2, 0, 1).normalize(), direction: d });
    },
  },

  'vfx-tracers': {
    description: 'Incoming enemy tracer fire and outgoing tracers across the range at dusk-like angle.',
    only: RANGE_SYSTEMS,
    player: { position: [X0, 0, Z0 + 4], yaw: 0 },
    camera: { position: [X0 + 4, 1.6, Z0 + 4], target: [X0 - 2, 1.4, Z0 - 3], hfov: 80 },
    hud: false,
    warmup: 40,
    setup(ctx) { buildRange(ctx); },
    onFrame(ctx, i) {
      const vfx = ctx.services.vfx;
      if (i >= 20 && i % 3 === 0) {
        const k = i * 0.37;
        vfx.spawn('tracer', { from: V(X0 - 60, 1.4 + Math.sin(k) * 0.3, Z0 + 20), to: V(X0 + 30, 1.2 + Math.cos(k) * 0.5, Z0 - 10), force: true });
      }
    },
  },

  'vfx-decals-floor': {
    description: 'Decals on the floor seen from standing height: scorch (concrete + dirt), bullet holes, blood.',
    only: RANGE_SYSTEMS,
    player: { position: [X0, 0, Z0 + 6], yaw: 0 },
    camera: { position: [X0 + 0.5, 1.7, Z0 + 3.2], target: [X0 + 0.5, 0, Z0 + 0.2], hfov: 70 },
    hud: false,
    warmup: 30,
    setup(ctx) { buildRange(ctx); },
    onFrame(ctx, i) {
      if (i !== 2) return;
      const vfx = ctx.services.vfx;
      const up = V(0, 1, 0);
      vfx.decal({ point: V(X0 - 0.6, 0, Z0 + 0.4), normal: up, surface: 'concrete', kind: 'scorch', size: 2.4 });
      vfx.decal({ point: V(X0 + 2.6, 0.1, Z0 + 0.6), normal: up, surface: 'dirt', kind: 'scorch', size: 2.0 });
      vfx.decal({ point: V(X0 + 0.9, 0, Z0 + 1.6), normal: up, kind: 'blood', size: 0.8, direction: V(1, 0, 0) });
      for (let k = 0; k < 6; k++) vfx.decal({ point: V(X0 - 0.4 + k * 0.3, 0, Z0 + 1.1 + (k % 2) * 0.25), normal: up, surface: 'concrete', kind: 'bullet' });
      for (let k = 0; k < 3; k++) vfx.decal({ point: V(X0 + 1.8 + k * 0.3, 0.1, Z0 + 0.7), normal: up, surface: 'dirt', kind: 'bullet' });
    },
  },

  'vfx-firefight': {
    description: 'Full game, first person: a 0.4 s burst at the level (flash, tracers, impacts, shells, decals).',
    player: { position: [0, null, 8], yaw: 0, pitch: -2 },
    weapon: { id: 'rifle' },
    input: [{ frame: 30, press: 'fire' }, { frame: 58, release: 'fire' }],
    warmup: 56,
  },
};

// TEMP debug presets (removed later)
for (const hide of ['vfx_dust_motes', 'vfx_smoke', 'vfx_glow', 'vfx_decals', 'none']) {
  PRESETS[`vfx-dbg-${hide}`] = {
    only: RANGE_SYSTEMS, player: { position: [X0, 0, Z0 + 4], yaw: 0 },
    camera: { position: [X0 + 0.2, 1.55, Z0 + 2.6], target: [X0, 1.05, Z0 - 3], hfov: 82 }, hud: false, warmup: 30,
    setup(ctx) { buildRange(ctx); },
    onFrame(ctx, i) {
      const o = ctx.scene.getObjectByName(hide); if (o) o.visible = false;
      if (i === 25) { const p = ctx.__vfxRange.panels[0]; ctx.services.vfx.spawn('impact', { point: V(p.x, 1.3, p.z), normal: V(0, 0, 1), surface: 'concrete' }); }
    },
  };
}
export default PRESETS;

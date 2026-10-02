/**
 * Shot presets owned by the MATERIALS agent. Names start with "materials-".
 *
 *   materials-gallery            every contract material on a ball + label (lighting service)
 *   materials-gallery-extra      every additional catalog material
 *   materials-gallery-neutral    contract balls under the neutral fallback HDRI (lighting excluded)
 *   materials-swatches           legacy: all catalog balls in a grid
 *   materials-walls              2.4 m wall swatches on a street: base dirt, streaks, ledge dust
 *   materials-ground             ground materials side by side, low grazing view
 *   materials-weapon             gun materials on a bevelled receiver mock-up (edge wear, machining)
 *   materials-glass              dirty glass panes in front of brick and sky
 *   materials-wet                walls + ground with wetness 0.8
 *   materials-closeup-<name>     one per catalog name: 1-2 m inspection of that surface
 */
import { CATALOG } from '../systems/materials/catalog.js';

const CONTRACT = ['concrete_wall', 'concrete_floor', 'asphalt', 'brick_red', 'plaster_painted', 'metal_painted',
  'metal_rusted', 'metal_gun_black', 'polymer_gun', 'wood_planks', 'sandbags', 'dirt', 'gravel', 'glass',
  'fabric_military', 'skin', 'rubber', 'cardboard', 'corrugated_metal', 'tile_floor'];

const WEAPON = new Set(['metal_gun_black', 'polymer_gun', 'metal_gun_fde', 'polymer_gun_tan', 'metal_anodized', 'metal_steel', 'brass', 'rubber']);
const GROUND = new Set(['concrete_floor', 'asphalt', 'dirt', 'gravel', 'tile_floor', 'concrete_pavement', 'pavement', 'curb_stone',
  'cobblestone', 'dirt_rocky', 'rubble', 'scorched_ground', 'asphalt_damaged', 'metal_tread_plate', 'road_markings', 'road_markings_yellow']);
const FABRIC = new Set(['sandbags', 'fabric_military', 'fabric_camo', 'fabric_charcoal', 'fabric_crimson', 'fabric_black', 'nylon_webbing',
  'leather', 'tarp', 'tarp_blue', 'skin', 'cardboard', 'hesco_fabric']);

const EXTRA = Object.keys(CATALOG).filter((n) => !CONTRACT.includes(n) && n !== 'pavement');
const PAGE = 18;

let RoundedBox = null;

// ------------------------------------------------------------------------------------------ helpers
function T() { return window.__GAME__.THREE; }

/** BoxGeometry with UVs in meters on every face (same convention as world geometry). */
function worldBox(w, h, d) {
  const THREE = T();
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) {
    const i = f * 4 + v;
    uv.setXY(i, uv.getX(i) * dims[f][0], uv.getY(i) * dims[f][1]);
  }
  return g;
}

function worldPlane(w, h) {
  const THREE = T();
  const g = new THREE.PlaneGeometry(w, h);
  g.rotateX(-Math.PI / 2);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * h);
  return g;
}

function ballGeo(r) {
  const THREE = T();
  const g = new THREE.SphereGeometry(r, 96, 64);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2 * Math.PI * r, uv.getY(i) * Math.PI * r);
  return g;
}

function label(text, { size = 0.09, color = '#f4f4f0' } = {}) {
  const THREE = T();
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgb(18,18,20)';
  g.fillRect(0, 0, 1024, 128);
  g.font = '700 64px Segoe UI, Arial, sans-serif';
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 512, 66, 1000);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, toneMapped: false, depthWrite: false, depthTest: false, fog: false }));
  s.renderOrder = 10;
  s.scale.set(size * 8, size, 1);
  return s;
}

function mesh(geo, mat, { cast = true, receive = true } = {}) {
  const THREE = T();
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

/** Neutral HDRI + sun when the lighting system is not running (or has no environment yet). */
async function ensureLighting(ctx, { force = false } = {}) {
  const THREE = T();
  if (!force && ctx.services.isProvided('lighting') && ctx.scene.environment) return;
  const tex = await ctx.assets.hdr('/assets/materials/hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr');
  const pmrem = new THREE.PMREMGenerator(ctx.renderer);
  const rt = pmrem.fromEquirectangular(tex);
  pmrem.dispose();
  ctx.scene.environment = rt.texture;
  ctx.scene.background = tex;
  ctx.scene.environmentIntensity = 1.0;
  ctx.scene.backgroundIntensity = 1.0;
  const sun = new THREE.DirectionalLight(0xfff0dc, 3.2);
  sun.position.set(-6, 7, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const c = sun.shadow.camera;
  c.left = -12; c.right = 12; c.top = 12; c.bottom = -12; c.near = 0.5; c.far = 40;
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.02;
  ctx.scene.add(sun);
}

function mats(ctx) { return ctx.services.materials; }

// ------------------------------------------------------------------------------------------ scenes
function ballGrid(ctx, names, { cols = 10, spacing = 1.05, r = 0.42, rowGap = 1.35, y0 = 0.6, labels = true } = {}) {
  const THREE = T();
  const group = new THREE.Group();
  const geo = ballGeo(r);
  const rows = Math.ceil(names.length / cols);
  names.forEach((n, i) => {
    const row = Math.floor(i / cols), col = i % cols;
    const inRow = Math.min(cols, names.length - row * cols);
    const x = (col - (inRow - 1) / 2) * spacing;
    const y = y0 + (rows - 1 - row) * rowGap;
    const b = mesh(geo, mats(ctx).get(n));
    b.position.set(x, y, 0);
    b.rotation.y = -0.4;
    group.add(b);
    if (labels) {
      const l = label(n, { size: Math.min(0.12, spacing * 0.105) });
      l.position.set(x, y - r - 0.12, 0.3);
      group.add(l);
    }
  });
  const floor = mesh(worldPlane(60, 30), mats(ctx).get('concrete_floor'), { cast: false });
  floor.position.z = -5;
  group.add(floor);
  const back = mesh(worldBox(40, 12, 0.3), mats(ctx).get('plaster_white@clean'));
  back.position.set(0, 6, -3);
  group.add(back);
  ctx.scene.add(group);
  return { rows };
}

function wallStreet(ctx, names, { width = 2.4, height = 3.4, gap = 0.12 } = {}) {
  const THREE = T();
  const group = new THREE.Group();
  const total = names.length * (width + gap);
  names.forEach((n, i) => {
    const x = -total / 2 + i * (width + gap) + width / 2;
    const w = mesh(worldBox(width, height, 0.4), mats(ctx).get(n));
    w.position.set(x, height / 2, 0);
    group.add(w);
    // window-sill style ledge to catch dust + drip streaks
    const ledge = mesh(worldBox(width * 0.5, 0.08, 0.28), mats(ctx).get(n));
    ledge.position.set(x, 2.1, 0.32);
    group.add(ledge);
    const l = label(n, { size: 0.12 });
    l.position.set(x, height + 0.15, 0.3);
    group.add(l);
  });
  const road = mesh(worldPlane(total + 20, 8), mats(ctx).get('asphalt'), { cast: false });
  road.position.set(0, 0, 5);
  group.add(road);
  const walk = mesh(worldBox(total + 20, 0.14, 2.2), mats(ctx).get('concrete_pavement'));
  walk.position.set(0, 0.07, 1.3);
  group.add(walk);
  const curb = mesh(worldBox(total + 20, 0.16, 0.25), mats(ctx).get('curb_stone'));
  curb.position.set(0, 0.08, 2.5);
  group.add(curb);
  ctx.scene.add(group);
  return group;
}

function weaponMock(ctx, mat, { x = 0, y = 1.2, z = 0, scale = 1 } = {}) {
  const THREE = T();
  const group = new THREE.Group();
  const add = (geo, m, px, py, pz, rx = 0, ry = 0, rz = 0) => {
    const o = mesh(geo, mats(ctx).get(m));
    o.position.set(px, py, pz);
    o.rotation.set(rx, ry, rz);
    group.add(o);
    return o;
  };
  const RB = RoundedBox;
  // upper receiver + rail + handguard + barrel + mag + grip + stock
  add(new RB(0.26, 0.07, 0.05, 4, 0.006), mat, 0, 0, 0);
  add(new RB(0.2, 0.045, 0.058, 4, 0.004), mat === 'metal_gun_black' ? 'metal_anodized' : mat, 0.23, 0.005, 0);
  for (let i = 0; i < 12; i++) add(new RB(0.008, 0.008, 0.03, 2, 0.0015), 'metal_anodized', -0.1 + i * 0.019, 0.042, 0);
  add(new THREE.CylinderGeometry(0.009, 0.009, 0.28, 32), 'metal_gun_black', 0.45, 0.005, 0, 0, 0, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.014, 0.014, 0.06, 32), 'metal_gun_black', 0.6, 0.005, 0, 0, 0, Math.PI / 2);
  add(new RB(0.05, 0.16, 0.026, 4, 0.006), 'polymer_gun', 0.02, -0.11, 0, 0, 0, -0.18);
  add(new RB(0.04, 0.12, 0.03, 4, 0.008), 'polymer_gun', -0.12, -0.08, 0, 0, 0, 0.35);
  add(new RB(0.2, 0.06, 0.035, 4, 0.01), 'polymer_gun', -0.26, -0.01, 0);
  add(new THREE.CylinderGeometry(0.004, 0.004, 0.02, 16), 'brass', 0.08, 0.02, 0.03, Math.PI / 2, 0, 0);
  group.position.set(x, y, z);
  group.scale.setScalar(scale);
  ctx.scene.add(group);
  return group;
}

async function loadRoundedBox(ctx) {
  const mod = await import('three/examples/jsm/geometries/RoundedBoxGeometry.js');
  RoundedBox = mod.RoundedBoxGeometry;
}

function fabricProps(ctx, name, x = 0, z = 0) {
  const THREE = T();
  const group = new THREE.Group();
  const m = mats(ctx).get(name);
  if (name === 'sandbags' || name === 'hesco_fabric') {
    if (name === 'hesco_fabric') {
      for (let i = 0; i < 3; i++) {
        const b = mesh(worldBox(1.0, 1.35, 1.0), m);
        b.position.set(x - 1.05 + i * 1.05, 0.675, z);
        group.add(b);
      }
    } else {
      const g = ballGeo(0.5);
      g.scale(0.62, 0.2, 0.34);
      for (let row = 0; row < 4; row++) for (let i = 0; i < 4 - (row % 2); i++) {
        const b = mesh(g, m);
        b.position.set(x - 0.95 + i * 0.64 + (row % 2) * 0.32, 0.09 + row * 0.19, z);
        b.rotation.y = (i * 37 + row * 13) % 7 * 0.02;
        group.add(b);
      }
    }
  } else {
    // soft draped block + ball
    const g = new RoundedBox(1.2, 0.6, 0.8, 6, 0.18);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 1.2, uv.getY(i) * 0.8);
    const b = mesh(g, m);
    b.position.set(x - 0.5, 0.3, z);
    group.add(b);
    const s = mesh(ballGeo(0.35), m);
    s.position.set(x + 0.55, 0.35, z + 0.1);
    group.add(s);
  }
  ctx.scene.add(group);
}

// ------------------------------------------------------------------------------------------ presets
const presets = {
  'materials-gallery': {
    description: 'All contract catalog materials on balls with labels, lit by the lighting service.',
    only: ['materials', 'lighting', 'postfx'],
    hud: false,
    camera: { position: [0, 1.75, 6.4], target: [0, 1.25, 0], hfov: 72 },
    warmup: 6,
    async setup(ctx) {
      await ensureLighting(ctx);
      ballGrid(ctx, CONTRACT, { cols: 7, spacing: 1.2, r: 0.46, rowGap: 1.3, y0: 0.62 });
    },
  },
  'materials-gallery-extra': {
    description: 'Overview: every non-contract catalog material on a ball (no labels; see materials-gallery-p<N>).',
    only: ['materials', 'lighting', 'postfx'],
    hud: false,
    camera: { position: [0, 3.4, 12.8], target: [0, 3.0, 0], hfov: 80 },
    warmup: 6,
    async setup(ctx) {
      await ensureLighting(ctx);
      ballGrid(ctx, EXTRA, { cols: 12, spacing: 1.0, r: 0.4, rowGap: 1.0, y0: 0.5, labels: false });
    },
  },
  'materials-gallery-neutral': {
    description: 'Contract materials under the neutral fallback HDRI + sun (no lighting system).',
    only: ['materials'],
    hud: false,
    camera: { position: [0, 1.75, 6.4], target: [0, 1.25, 0], hfov: 72 },
    warmup: 6,
    async setup(ctx) {
      await ensureLighting(ctx, { force: true });
      ballGrid(ctx, CONTRACT, { cols: 7, spacing: 1.2, r: 0.46, rowGap: 1.3, y0: 0.62 });
    },
  },
  'materials-swatches': {
    description: 'Every catalog material on a sphere, lit by the lighting system (legacy name).',
    only: ['materials', 'lighting'],
    hud: false,
    camera: { position: [0, 3.0, 11.5], target: [0, 2.4, 0], hfov: 80 },
    warmup: 5,
    async setup(ctx) {
      await ensureLighting(ctx);
      ballGrid(ctx, Object.keys(CATALOG), { cols: 11, spacing: 1.0, r: 0.38, rowGap: 1.05, y0: 0.5, labels: false });
    },
  },
  'materials-walls': {
    description: 'Wall materials as 2.4 m panels on a street: base dirt, streaks, ledge dust, macro variation.',
    only: ['materials', 'lighting', 'postfx'],
    hud: false,
    camera: { position: [0, 1.7, 9.5], target: [0, 1.6, 0], hfov: 90 },
    warmup: 6,
    async setup(ctx) {
      await ensureLighting(ctx);
      wallStreet(ctx, ['concrete_wall', 'concrete_panel', 'brick_red', 'plaster_painted', 'plaster_damaged', 'plaster_ochre', 'plaster_blue', 'wood_planks', 'painted_wood', 'corrugated_metal', 'concrete_dirty']);
    },
  },
  'materials-ground': {
    description: 'Ground materials in 3 m strips, grazing view (tiling, anti-tile, macro variation).',
    only: ['materials', 'lighting', 'postfx'],
    hud: false,
    camera: { position: [0, 1.65, 6], target: [0, 0, -6], hfov: 90 },
    warmup: 6,
    async setup(ctx) {
      await ensureLighting(ctx);
      const names = ['asphalt', 'concrete_floor', 'cobblestone', 'dirt', 'gravel', 'rubble', 'dirt_rocky', 'concrete_pavement', 'tile_floor', 'scorched_ground'];
      const w = 3;
      names.forEach((n, i) => {
        const p = mesh(worldPlane(w, 40), mats(ctx).get(n), { cast: false });
        p.position.set((i - (names.length - 1) / 2) * w, 0, -14);
        ctx.scene.add(p);
        const l = label(n, { size: 0.14 });
        l.position.set((i - (names.length - 1) / 2) * w, 0.25, 3);
        ctx.scene.add(l);
      });
    },
  },
  'materials-weapon': {
    description: 'Gun materials on a bevelled receiver mock-up at viewmodel distance (edge wear, machining, stipple).',
    only: ['materials', 'lighting', 'postfx'],
    hud: false,
    camera: { position: [0.1, 1.28, 0.62], target: [0.12, 1.19, 0], hfov: 55 },
    warmup: 6,
    async setup(ctx) {
      await ensureLighting(ctx);
      await loadRoundedBox(ctx);
      weaponMock(ctx, 'metal_gun_black', { x: -0.05, y: 1.25, z: 0 });
      weaponMock(ctx, 'metal_gun_fde', { x: 0.2, y: 1.05, z: -0.15 });
      const table = mesh(worldBox(3, 0.05, 2), mats(ctx).get('wood_planks'));
      table.position.set(0, 0.85, -0.2);
      ctx.scene.add(table);
    },
  },
  'materials-weapon-close': {
    description: 'Viewmodel-distance oblique view of the receiver: edge wear, bead-blast micro, stipple.',
    only: ['materials', 'lighting', 'postfx'],
    hud: false,
    camera: { position: [-0.16, 1.36, 0.3], target: [0.02, 1.22, 0], hfov: 60 },
    warmup: 6,
    async setup(ctx) {
      await ensureLighting(ctx);
      await loadRoundedBox(ctx);
      weaponMock(ctx, 'metal_gun_black', { x: 0, y: 1.25, z: 0 });
      const table = mesh(worldBox(3, 0.05, 2), mats(ctx).get('wood_planks'));
      table.position.set(0, 0.85, -0.2);
      ctx.scene.add(table);
    },
  },
  'materials-glass': {
    description: 'Dirty glass panes over brick / plaster and sky, grazing and frontal.',
    only: ['materials', 'lighting', 'postfx'],
    hud: false,
    camera: { position: [1.2, 1.6, 3.2], target: [0, 1.5, 0], hfov: 70 },
    warmup: 6,
    async setup(ctx) {
      await ensureLighting(ctx);
      const wall = mesh(worldBox(6, 3.2, 0.3), mats(ctx).get('brick_red'));
      wall.position.set(0, 1.6, -1.2);
      ctx.scene.add(wall);
      for (let i = 0; i < 3; i++) {
        const pane = mesh(worldBox(1.1, 1.5, 0.01), mats(ctx).get('glass'), { cast: false });
        pane.position.set(-1.3 + i * 1.3, 1.6, 0);
        pane.rotation.y = (i - 1) * 0.35;
        ctx.scene.add(pane);
        const frame = mesh(worldBox(1.2, 0.06, 0.08), mats(ctx).get('painted_wood'));
        frame.position.set(-1.3 + i * 1.3, 0.83, 0);
        frame.rotation.y = pane.rotation.y;
        ctx.scene.add(frame);
      }
      const floor = mesh(worldPlane(20, 20), mats(ctx).get('concrete_floor'), { cast: false });
      ctx.scene.add(floor);
    },
  },
  'materials-wet': {
    description: 'Street walls + ground with global wetness 0.8 (puddles, darkening, glossy).',
    only: ['materials', 'lighting', 'postfx'],
    hud: false,
    camera: { position: [0, 1.7, 9.5], target: [0, 1.0, 0], hfov: 90 },
    warmup: 6,
    async setup(ctx) {
      await ensureLighting(ctx);
      mats(ctx).setWetness(0.8);
      wallStreet(ctx, ['concrete_wall', 'brick_red', 'plaster_painted', 'plaster_damaged', 'wood_planks', 'corrugated_metal', 'concrete_dirty']);
    },
  },
};

// labelled gallery pages of the extra materials, 18 per page
for (let p = 0; p * PAGE < EXTRA.length; p++) {
  const names = EXTRA.slice(p * PAGE, (p + 1) * PAGE);
  presets[`materials-gallery-p${p + 1}`] = {
    description: `Extra catalog materials page ${p + 1}: ${names.join(', ')}`,
    only: ['materials', 'lighting', 'postfx'],
    hud: false,
    camera: { position: [0, 1.75, 6.4], target: [0, 1.25, 0], hfov: 72 },
    warmup: 6,
    async setup(ctx) {
      await ensureLighting(ctx);
      ballGrid(ctx, names, { cols: 6, spacing: 1.35, r: 0.46, rowGap: 1.3, y0: 0.62 });
    },
  };
}

// perf A/B: same scripted loop as core-perf, full vs lite material shading (node tools/perf.mjs materials-perf-lite)
const PERF_INPUT = [
  { frame: 0, move: [0, 1] }, { frame: 0, press: 'sprint' }, { frame: 90, release: 'sprint' }, { frame: 90, move: [1, 0] },
  { frame: 150, move: [0, -1] }, { frame: 210, move: [-1, 0] }, { frame: 0, look: [30, 0] }, { frame: 60, look: [-60, 5] },
  { frame: 120, look: [80, -5] }, { frame: 180, look: [-50, 0] }, { frame: 240, press: 'fire' }, { frame: 260, release: 'fire' },
];
for (const [k, lite] of [['full', 0], ['lite', 7], ['noat', 1], ['nodet', 2], ['nogrime', 4]]) {
  presets[`materials-perf-${k}`] = {
    description: `Perf run (core-perf loop) with ${k} material shading.`,
    player: { position: [0, null, 10], yaw: 0, pitch: 0 },
    settings: { materials: { lite } },
    input: PERF_INPUT,
    inputLoop: 280,
    warmup: 30,
  };
}

// debug views of the wall street (G-buffer style channels)
for (const mode of ['albedo', 'roughness', 'metalness', 'ao', 'height', 'basedirt', 'dust', 'streaks', 'normal']) {
  presets[`materials-debug-${mode}`] = {
    description: `Wall street, material debug view: ${mode}.`,
    only: ['materials', 'lighting'],
    hud: false,
    camera: { position: [0, 1.7, 9.5], target: [0, 1.6, 0], hfov: 90 },
    warmup: 4,
    async setup(ctx) {
      await ensureLighting(ctx);
      mats(ctx).setDebugView?.(mode);
      wallStreet(ctx, ['concrete_wall', 'brick_red', 'plaster_painted', 'plaster_damaged', 'wood_planks', 'corrugated_metal', 'concrete_dirty']);
    },
  };
}

// one inspection preset per catalog name
for (const name of Object.keys(CATALOG)) {
  const kind = WEAPON.has(name) ? 'weapon' : GROUND.has(name) ? 'ground' : name === 'glass' ? 'glass' : FABRIC.has(name) ? 'fabric' : 'wall';
  const cam = {
    wall: { position: [1.1, 1.55, 2.3], target: [-0.2, 1.2, 0], hfov: 75 },
    ground: { position: [0, 1.6, 2.2], target: [0, 0, -1.2], hfov: 80 },
    weapon: { position: [0.08, 1.3, 0.55], target: [0.1, 1.2, 0], hfov: 55 },
    fabric: { position: [0.3, 1.3, 2.4], target: [0, 0.4, 0], hfov: 60 },
    glass: { position: [0.8, 1.55, 2.0], target: [0, 1.5, 0], hfov: 70 },
  }[kind];
  presets[`materials-closeup-${name}`] = {
    description: `Close inspection of "${name}" (${kind}).`,
    only: ['materials', 'lighting', 'postfx'],
    hud: false,
    camera: cam,
    warmup: 6,
    async setup(ctx) {
      await ensureLighting(ctx);
      const THREE = T();
      const M = mats(ctx);
      if (kind === 'wall') {
        const w = mesh(worldBox(4, 3.2, 0.4), M.get(name));
        w.position.set(0, 1.6, -0.2);
        ctx.scene.add(w);
        const side = mesh(worldBox(0.4, 3.2, 3), M.get(name));
        side.position.set(-2.2, 1.6, 1.1);
        ctx.scene.add(side);
        const ledge = mesh(worldBox(1.4, 0.08, 0.3), M.get(name));
        ledge.position.set(0.4, 1.9, 0.14);
        ctx.scene.add(ledge);
        const ball = mesh(ballGeo(0.3), M.get(name));
        ball.position.set(0.9, 0.3, 0.9);
        ctx.scene.add(ball);
        const floor = mesh(worldPlane(20, 20), M.get('concrete_pavement'), { cast: false });
        ctx.scene.add(floor);
      } else if (kind === 'ground') {
        const floor = mesh(worldPlane(30, 30), M.get(name === 'road_markings' || name === 'road_markings_yellow' ? 'asphalt' : name), { cast: false });
        ctx.scene.add(floor);
        if (name.startsWith('road_markings')) {
          const strip = mesh(worldPlane(0.15, 30), M.get(name), { cast: false });
          strip.position.set(0, 0.005, 0);
          ctx.scene.add(strip);
          const strip2 = mesh(worldPlane(2.5, 0.4), M.get(name), { cast: false });
          strip2.position.set(0.8, 0.005, -1.2);
          ctx.scene.add(strip2);
        }
        const wall = mesh(worldBox(8, 2, 0.3), M.get('concrete_wall'));
        wall.position.set(0, 1, -4);
        ctx.scene.add(wall);
        const ball = mesh(ballGeo(0.25), M.get(name.startsWith('road') ? 'asphalt' : name));
        ball.position.set(0.8, 0.25, -0.6);
        ctx.scene.add(ball);
      } else if (kind === 'weapon') {
        await loadRoundedBox(ctx);
        weaponMock(ctx, name, { x: 0, y: 1.2, z: 0 });
        const ball = mesh(ballGeo(0.05), M.get(name));
        ball.position.set(0.3, 1.14, -0.05);
        ctx.scene.add(ball);
        const table = mesh(worldBox(2, 0.05, 2), M.get('wood_planks'));
        table.position.set(0, 1.05, -0.2);
        ctx.scene.add(table);
      } else if (kind === 'fabric') {
        await loadRoundedBox(ctx);
        fabricProps(ctx, name, 0, 0);
        const floor = mesh(worldPlane(20, 20), M.get('concrete_floor'), { cast: false });
        ctx.scene.add(floor);
        const wall = mesh(worldBox(8, 3, 0.3), M.get('plaster_white'));
        wall.position.set(0, 1.5, -1.5);
        ctx.scene.add(wall);
      } else if (kind === 'glass') {
        const wall = mesh(worldBox(6, 3.2, 0.3), M.get('plaster_damaged'));
        wall.position.set(0, 1.6, -1.0);
        ctx.scene.add(wall);
        const pane = mesh(worldBox(1.4, 1.6, 0.01), M.get('glass'), { cast: false });
        pane.position.set(0, 1.5, 0);
        pane.rotation.y = 0.25;
        ctx.scene.add(pane);
        ctx.scene.add(mesh(worldPlane(20, 20), M.get('concrete_floor'), { cast: false }));
      }
      void THREE;
    },
  };
}

export default presets;

// ---------------------------------------------------------------------------------------------- in-world context
// Real town views owned by materials (same cameras as the world presets, full env stack) + a probe that
// reports which catalog material sits under a few screen points (console.warn "[materials-probe] ...").
const ENV_CTX = ['materials', 'lighting', 'world', 'postfx'];
const CTX_VIEWS = {
  alley: { position: [-38.5, 1.7, 23.5], target: [-38.5, 2.0, 52], hfov: 85 },
  street: { position: [0, 1.7, 30], target: [0, 1.6, 60], hfov: 80 },
  ground: { position: [-41, 1.3, 25], target: [-41, 0.0, 29], hfov: 75 },
};
for (const [k, cam] of Object.entries(CTX_VIEWS)) {
  presets[`materials-ctx-${k}`] = {
    description: `In-world material check: ${k}. Warns the material names under a 3x3 grid of screen points.`,
    only: ENV_CTX,
    hud: false,
    camera: cam,
    warmup: 6,
    onFrame(ctx, i) {
      if (i !== 4) return;
      const w = ctx.services.world;
      if (!w?.raycast) return;
      const cam3 = ctx.camera;
      const V = new cam3.position.constructor();
      const out = [];
      for (const sy of [0.3, 0.6, 0.9]) {
        for (const sx of [0.2, 0.5, 0.8]) {
          V.set(sx * 2 - 1, -(sy * 2 - 1), 0.5).unproject(cam3).sub(cam3.position).normalize();
          const h = w.raycast(cam3.position, V, 300);
          const m = h?.material;
          out.push(`${sx},${sy}:${(Array.isArray(m) ? m[0] : m)?.name || '-'}`);
        }
      }
      console.warn(`[materials-probe] ${k} ${out.join(' | ')}`);
    },
  };
}

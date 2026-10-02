import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { Rng } from '../../core/Rng.js';
import { GeoBuilder } from './builder.js';
import { CollisionWorld } from './collision.js';
import { NavGrid } from './nav.js';
import { WorldMaterials } from './mats.js';
import { buildGround } from './ground.js';
import { buildBuilding } from './buildings.js';
import { BUILDINGS, OOB_BUILDINGS, PLAYER_SPAWNS, AI_SPAWNS, PLAY, toSpec } from './town.js';
import { createDetails } from './details.js';
import { createTextures } from './textures.js';
import { PropSystem } from './props.js';
import { dressTown, laundry } from './dressing.js';
import { initVehicles } from './vehicles.js';

/**
 * world — the town of Vardanek. Owner: world agent.
 *
 * services.world (contract in ARCHITECTURE.md; extensions marked +):
 *   ready, root, bounds, spawnPoints, colliders
 *   raycast(origin, dir, far, {ignore}) -> Hit|null     Hit = {point, normal, distance, object, material, surface, +instanceId}
 *   raycastAll(origin, dir, far) -> Hit[]
 *   collideCapsule({start, end, radius}) -> {normal, depth} | false     (result object reused: copy it)
 *   groundHeight(x, z, fromY=100)
 *   addCollider(obj) / removeCollider(obj)
 *   nav: { findPath(from, to), randomPoint(out), +isWalkable(x,z), +nearestWalkable(p, out), +coverPoints }
 *   + lineOfSight(a, b) -> bool               static geometry only, cheap
 *   + coverPoints: [{position, normal (away from cover), height:'low'|'high'}]
 *   + ledges: [{a, b, normal, height}]         mantle-able top edges (low walls, sandbags, barriers)
 *   + findLedge(pos, forward, {reach=1.0, maxHeight=2.1}) -> {point, height, normal} | null
 *   + zones: {name: Box3};  zoneAt(x, z) -> name|null
 *   + playBounds: Box3 (walkable limits; invisible walls sit on it)
 * Emits: 'world:ready' {root}
 */

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

const DEPLOYMENT_MAP = { id: 'plaza', name: 'Plaza District', center: [0, 0] };

export default function createSystem(ctx) {
  const { scene } = ctx;
  const root = new THREE.Group();
  root.name = 'world';
  const col = new CollisionWorld();
  const colliders = [];
  const disposables = [];
  let mats = null;
  let nav = null;
  let props = null;
  const navRng = ctx.rng.fork('world-nav');
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });

  const bounds = new THREE.Box3(new THREE.Vector3(PLAY.min, -1, PLAY.min), new THREE.Vector3(PLAY.max, 40, PLAY.max));
  const spawnPoints = { player: [], ai: [] };
  const ledges = [];
  const zones = {
    plaza: new THREE.Box3(new THREE.Vector3(-22, -1, -21), new THREE.Vector3(22, 30, 21)),
    mainstreet: new THREE.Box3(new THREE.Vector3(-7, -1, 21), new THREE.Vector3(7, 30, 70)),
    stationroad: new THREE.Box3(new THREE.Vector3(-7, -1, -70), new THREE.Vector3(7, 30, -21)),
    courtyard: new THREE.Box3(new THREE.Vector3(-65, -1, -65), new THREE.Vector3(-37, 30, -39)),
    depot: new THREE.Box3(new THREE.Vector3(27, -1, -67), new THREE.Vector3(67, 30, -23)),
    alleys: new THREE.Box3(new THREE.Vector3(-67, -1, 7), new THREE.Vector3(-20, 30, 70)),
    warehouse: new THREE.Box3(new THREE.Vector3(22, -1, 21), new THREE.Vector3(67, 30, 70)),
  };

  function yawToward(x, z, tx, tz) { return Math.atan2(-(tx - x), -(tz - z)); }

  async function build() {
    await ctx.services.materials.ready;
    mats = new WorldMaterials(ctx);
    const rng = new Rng('vardanek');
    const B = new GeoBuilder({ chunkSize: 60, mergeBelow: 30000 });
    const tex = createTextures(ctx, mats, rng.fork('tex'));
    initVehicles(tex);
    B.tex = tex;
    props = new PropSystem(ctx, mats);
    await ctx.assets.track(props.loadModels(), 'world:models');
    const env = { ctx, B, rng, mats, tex, props, ledges, col };
    Object.assign(env, createDetails(env));
    const laundryRng = rng.fork('laundry');
    env.laundry = (b, a, c) => laundry(b, a, c, laundryRng);

    buildGround(env);
    const infos = [];
    BUILDINGS.forEach((b, i) => infos.push(buildBuilding(env, toSpec(b, i))));
    OOB_BUILDINGS.forEach((b, i) => {
      const s = toSpec({ ...b, id: `oob${i}`, faces: b.faces || { N: 'windows', S: 'windows', E: 'windows', W: 'windows' } }, 1000 + i);
      s.oob = true;
      s.noRoofClutter = false;
      infos.push(buildBuilding(env, s));
    });
    env.buildings = infos;
    dressTown(env);

    // instanced props (need their meshes before collision parts are registered)
    props.instantiate(root, B);
    const res = B.build((k) => mats.resolve(k), root);
    col.setStatic(res);
    env.decals.build(root, col);
    for (const m of res.meshes) {
      disposables.push(m.geometry);
      if (res.parts.find((p) => p.object === m)) {
        // lazily-built per-mesh BVH so third-party Raycaster users stay fast
        m.raycast = lazyBVHRaycast;
        colliders.push(m);
      }
    }
    for (const m of props.meshes) colliders.push(m);

    scene.add(root);
    root.updateMatrixWorld(true);

    // navigation
    const t0 = performance.now();
    nav = new NavGrid(col, { min: PLAY.min, max: PLAY.max, cell: 0.5, radius: 0.35 });
    nav.build();
    window.__WORLD_STATS__ = { meshes: res.meshes.length, mats: [...new Set(res.meshes.map((m) => m.material.name))] };
    console.info(`[system:world] nav built in ${(performance.now() - t0).toFixed(0)} ms, ${nav.walkableCells.length} cells, ${nav.coverPoints.length} cover points; static tris ${B.stats.tris}, meshes ${res.meshes.length}, mats ${new Set(res.meshes.map((m) => m.material.name)).size}`);

    // spawns (snap to ground / nearest walkable)
    for (const s of PLAYER_SPAWNS) {
      const y = col.groundHeight(s.p[0], s.p[1], 3);
      spawnPoints.player.push({ position: new THREE.Vector3(s.p[0], y, s.p[1]), yaw: s.yaw });
    }
    for (const s of AI_SPAWNS) {
      const c = nav.nearest(s.p[0], s.p[1], 20);
      const x = c >= 0 ? nav.cx(c % nav.n) : s.p[0];
      const z = c >= 0 ? nav.cx((c / nav.n) | 0) : s.p[1];
      spawnPoints.ai.push({ position: new THREE.Vector3(x, col.groundHeight(x, z, 3), z), yaw: yawToward(x, z, 0, 0) });
    }
  }

  function lazyBVHRaycast(raycaster, intersects) {
    if (!this.geometry.boundsTree) this.geometry.boundsTree = new MeshBVH(this.geometry);
    return acceleratedRaycast.call(this, raycaster, intersects);
  }

  const api = {
    ready,
    root,
    bounds,
    playBounds: bounds,
    colliders,
    spawnPoints,
    get map() { return { ...DEPLOYMENT_MAP, center: [...DEPLOYMENT_MAP.center] }; },
    ledges,
    zones,
    get coverPoints() { return nav ? nav.coverPoints : []; },
    raycast(origin, dir, far = 1000, opts = {}) {
      return col.raycast(origin, dir, far, opts && opts.ignore);
    },
    raycastAll(origin, dir, far = 1000) {
      return col.raycastAll(origin, dir, far);
    },
    lineOfSight(a, b) { return col.lineOfSight(a, b); },
    collideCapsule(capsule) {
      return col.collideCapsule(capsule);
    },
    groundHeight(x, z, fromY = 100) {
      return col.groundHeight(x, z, fromY, 0);
    },
    addCollider(obj, opts = {}) {
      obj.updateMatrixWorld(true);
      obj.traverse((o) => {
        if (!o.isMesh || o.isInstancedMesh) return;
        col.addDynamic(o, opts);
        if (!colliders.includes(o)) colliders.push(o);
      });
    },
    removeCollider(obj) {
      obj.traverse((o) => {
        col.removeDynamic(o);
        const i = colliders.indexOf(o);
        if (i >= 0) colliders.splice(i, 1);
      });
    },
    zoneAt(x, z) {
      for (const [k, b] of Object.entries(zones)) if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) return k;
      return null;
    },
    findLedge(pos, forward, { reach = 1.0, maxHeight = 2.1, minHeight = 0.5 } = {}) {
      // chest ray forward to find a wall, then a down ray from above to find its top
      _d.set(forward.x, 0, forward.z);
      if (_d.lengthSq() < 1e-6) return null;
      _d.normalize();
      _o.set(pos.x, pos.y + minHeight + 0.05, pos.z);
      const hit = col.raycast(_o, _d, reach + 0.4);
      if (!hit) return null;
      const top = new THREE.Vector3().copy(hit.point).addScaledVector(_d, 0.3);
      top.y = pos.y + maxHeight + 0.3;
      const down = col.raycast(top, new THREE.Vector3(0, -1, 0), maxHeight + 0.3);
      if (!down || down.normal.y < 0.7) return null;
      const h = down.point.y - pos.y;
      if (h < minHeight || h > maxHeight) return null;
      // headroom on top
      const box = new THREE.Box3(
        new THREE.Vector3(down.point.x - 0.25, down.point.y + 0.1, down.point.z - 0.25),
        new THREE.Vector3(down.point.x + 0.25, down.point.y + 1.0, down.point.z + 0.25),
      );
      if (!col.boxFree(box)) return null;
      return { point: down.point, height: h, normal: hit.normal };
    },
    nav: {
      findPath(from, to) { return nav ? nav.findPath(from, to) : [from.clone(), to.clone()]; },
      randomPoint(out = new THREE.Vector3()) { return nav ? nav.randomPoint(out, navRng) : out.set(0, 0, 0); },
      isWalkable(x, z) { return nav ? nav.isWalkable(x, z) : true; },
      nearestWalkable(p, out = new THREE.Vector3()) {
        if (!nav) return out.copy(p);
        const c = nav.nearest(p.x, p.z, 24);
        if (c < 0) return out.copy(p);
        return out.set(nav.cx(c % nav.n), nav.h[c], nav.cx((c / nav.n) | 0));
      },
      get coverPoints() { return nav ? nav.coverPoints : []; },
      get grid() { return nav; },
    },
  };

  return {
    name: 'world',
    async init() {
      await ctx.assets.track(build(), 'world:build');
      ctx.services.provide('world', api);
      resolveReady();
      ctx.events.emit('world:ready', { root });
    },
    update(dt, t) {
      props?.update?.(dt, t);
    },
    dispose() {
      scene.remove(root);
      for (const g of disposables) g.dispose();
      root.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
      props?.dispose();
      mats?.dispose();
      col.dispose();
    },
  };
}

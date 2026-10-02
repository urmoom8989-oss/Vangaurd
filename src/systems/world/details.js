import * as THREE from 'three';
import { wallWithOpenings } from './buildings.js';

/**
 * Facade / building detail hooks used by the building generator, plus the world-owned materials they
 * need (interior-mapped windows, broken glass, decals, signs).
 */

// window size classes for the interior shader: [width, height, sill]
const WIN_CLASSES = [
  [1.45, 1.45, 0.85], [1.25, 1.6, 0.9], [1.2, 1.7, 0.9], [1.1, 1.4, 0.9],
  [0.9, 2.2, 0.05], [3.0, 1.0, 1.8], [3.0, 2.6, 0.2], [1.1, 1.0, 1.2],
];
function winClass(w, h) {
  let best = 0, bd = Infinity;
  WIN_CLASSES.forEach(([cw, ch], i) => { const d = Math.abs(cw - w) + Math.abs(ch - h); if (d < bd) { bd = d; best = i; } });
  return best;
}

function interiorMaterial(tex) {
  const m = new THREE.MeshBasicMaterial({ map: tex.interior, color: 0xffffff });
  m.name = 'world_interior';
  m.userData.surface = 'plaster';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uBright = { value: 0.42 };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTanView;
        varying vec2 vRoomUV;
        varying vec2 vIds;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        {
          vec4 iwp = modelMatrix * vec4(transformed, 1.0);
          vec3 iN = normalize(mat3(modelMatrix) * normal);
          vec3 iT = normalize(cross(vec3(0.0, 1.0, 0.0), iN));
          vec3 V = iwp.xyz - cameraPosition;
          vTanView = vec3(dot(V, iT), V.y, -dot(V, iN));
          vRoomUV = vec2(fract(uv.x * 0.5) * 2.0, fract(uv.y * 0.5) * 2.0);
          vIds = vec2(floor(uv.x * 0.5 + 0.001), floor(uv.y * 0.5 + 0.001));
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTanView;
        varying vec2 vRoomUV;
        varying vec2 vIds;
        uniform float uBright;
        vec3 winTable(float c) {
          ${WIN_CLASSES.map((w, i) => `if (c < ${i}.5) return vec3(${w[0].toFixed(3)}, ${w[1].toFixed(3)}, ${w[2].toFixed(3)});`).join('\n          ')}
          return vec3(1.2, 1.5, 0.9);
        }
        float ihash(float n) { return fract(sin(n) * 43758.5453); }`)
      .replace('#include <map_fragment>', `
        {
          float variant = vIds.x;
          vec3 win = winTable(vIds.y);
          float W = max(3.4, win.x * 2.3);
          float Hh = max(2.7, win.z + win.y + 0.35);
          float D = 3.2 + mod(variant, 3.0) * 0.7;
          vec2 ruv = clamp(vRoomUV, 0.0, 1.0);
          vec3 p = vec3((ruv.x - 0.5) * win.x + (ihash(variant * 7.1) - 0.5) * 0.6, win.z + ruv.y * win.y, 0.0);
          vec3 rd = normalize(vTanView);
          rd.z = max(rd.z, 0.02);
          vec3 invd = 1.0 / rd;
          float tx = ((rd.x > 0.0 ? W * 0.5 : -W * 0.5) - p.x) * invd.x;
          float ty = ((rd.y > 0.0 ? Hh : 0.0) - p.y) * invd.y;
          float tz = (D - p.z) * invd.z;
          float t = min(min(tx, ty), tz);
          vec3 h = p + rd * t;
          float cellX = mod(variant, 4.0), cellY = floor(variant / 4.0);
          vec2 wallUVc = vec2((cellX + 0.08) * 0.25, 1.0 - (cellY + 0.5) * 0.125);
          vec3 wallCol = texture2D(map, wallUVc).rgb;
          vec3 col;
          vec2 gscale = vec2(0.25, 0.125);
          if (t == tz) {
            vec2 b = vec2(h.x / W + 0.5, h.y / Hh);
            vec2 auv = vec2((cellX + b.x) * 0.25, 1.0 - (cellY + 1.0 - b.y) * 0.125);
            col = textureGrad(map, auv, dFdx(ruv) * gscale, dFdy(ruv) * gscale).rgb;
          } else if (t == ty) {
            if (rd.y < 0.0) {
              float plank = step(0.5, fract(h.x * 3.0 + ihash(variant) * 3.0));
              col = mix(vec3(0.20, 0.14, 0.10), vec3(0.24, 0.17, 0.11), plank);
              if (mod(variant, 5.0) < 1.5) col = vec3(0.30, 0.27, 0.22) * (0.8 + 0.2 * step(0.5, fract(h.x * 2.0) + fract(h.z * 2.0) - 0.5));
              col *= mix(1.25, 0.7, clamp(h.z / D, 0.0, 1.0));
            } else {
              col = vec3(0.5, 0.49, 0.46) * mix(0.9, 0.45, clamp(h.z / D, 0.0, 1.0));
            }
          } else {
            col = wallCol * mix(1.0, 0.55, clamp(h.z / D, 0.0, 1.0));
            col *= 0.85 + 0.15 * h.y / Hh;
          }
          // depth darkening + corner AO
          col *= exp(-t * 0.09);
          float edge = min(min(abs(h.x) - W * 0.5, 0.0) * -1.0, 1.0);
          col *= 0.8 + 0.2 * smoothstep(0.0, 0.5, W * 0.5 - abs(h.x)) * smoothstep(0.0, 0.4, h.y) * smoothstep(0.0, 0.4, Hh - h.y);
          // curtains / blinds overlay at the glass plane
          float cv = mod(variant * 3.0 + 1.0, 8.0);
          vec2 cuv = vec2((mod(cv, 4.0) + ruv.x) * 0.25, 0.5 - (floor(cv / 4.0) + 1.0 - ruv.y) * 0.25);
          vec4 cur = textureGrad(map, cuv, dFdx(ruv) * 0.25, dFdy(ruv) * 0.25);
          col = mix(col, cur.rgb * 0.75, cur.a);
          diffuseColor.rgb *= col * uBright * 2.0;
        }`);
  };
  m.customProgramCacheKey = () => 'world_interior_v1';
  return m;
}

export function createDetails(env) {
  const { ctx, B, mats, tex, rng, props } = env;

  // ---------------------------------------------------------------- world-owned materials
  mats.define('w:interior', interiorMaterial(tex), 'plaster');
  const brokenGlass = new THREE.MeshStandardMaterial({
    map: tex.glassBroken, transparent: true, roughness: 0.08, metalness: 0.0, depthWrite: false, side: THREE.DoubleSide,
    envMapIntensity: 1.2,
  });
  brokenGlass.name = 'world_glass_broken';
  mats.define('w:glass_broken', brokenGlass, 'glass');

  const decalMat = new THREE.MeshStandardMaterial({
    map: tex.decals, transparent: true, depthWrite: false, roughness: 0.95, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  decalMat.name = 'world_decal';
  mats.define('w:decal', decalMat, 'default');
  const puddleMat = new THREE.MeshStandardMaterial({
    color: 0x090807, alphaMap: tex.decals, transparent: true, opacity: 0.86, depthWrite: false, roughness: 0.06, metalness: 0.0,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6, envMapIntensity: 0.16,
  });
  puddleMat.name = 'world_puddle';
  mats.define('w:puddle', puddleMat, 'water');
  const signMat = new THREE.MeshStandardMaterial({ map: tex.signs, roughness: 0.7, metalness: 0.1 });
  signMat.name = 'world_signs';
  mats.define('w:signs', signMat, 'metal');
  const carMat = new THREE.MeshStandardMaterial({ map: tex.car, roughness: 0.45, metalness: 0.2, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  carMat.name = 'world_car_details';
  mats.define('w:car_details', carMat, 'metal');
  const carGlass = new THREE.MeshStandardMaterial({ color: 0x0b1013, roughness: 0.06, metalness: 0.0, transparent: true, opacity: 0.86, envMapIntensity: 2.2, depthWrite: false });
  carGlass.name = 'world_car_glass';
  mats.define('w:car_glass', carGlass, 'glass');
  const hescoMat = new THREE.MeshStandardMaterial({ map: tex.hesco, roughness: 0.95, metalness: 0 });
  hescoMat.name = 'world_hesco';
  mats.define('w:hesco', hescoMat, 'sand');
  const tarpBase = (tint) => {
    const m = new THREE.MeshStandardMaterial({ map: tex.tarp, color: tint, roughness: 0.9, side: THREE.DoubleSide });
    m.name = 'world_tarp';
    return m;
  };
  mats.define('w:tarp_blue', tarpBase(0x6d8fc0), 'fabric');
  mats.define('w:tarp_red', tarpBase(0xb85a48), 'fabric');
  mats.define('w:tarp_green', tarpBase(0x7a9068), 'fabric');
  mats.define('w:tarp_white', tarpBase(0xe0dccc), 'fabric');
  mats.define('w:tarp_orange', tarpBase(0xd08040), 'fabric');
  const laundryMat = new THREE.MeshStandardMaterial({ map: tex.laundry, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.95 });
  laundryMat.name = 'world_laundry';
  mats.define('w:laundry', laundryMat, 'fabric');
  const foliageMat = new THREE.MeshStandardMaterial({ map: tex.foliage, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9 });
  foliageMat.name = 'world_foliage';
  mats.define('w:foliage', foliageMat, 'grass');
  const chainMat = new THREE.MeshStandardMaterial({ map: tex.chainlink, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.6 });
  chainMat.name = 'world_chainlink';
  mats.define('w:chainlink', chainMat, 'metal');
  const barkMat = new THREE.MeshStandardMaterial({ map: tex.bark, roughness: 0.95 });
  barkMat.name = 'world_bark';
  mats.define('w:bark', barkMat, 'wood');

  // ---------------------------------------------------------------- decals
  const decals = {
    list: [], // {mat, pos(12), n(3), uv(8)}
    /** Quad in the builder's current frame. plane 'z': facing +z (wall), 'y': facing +y (ground). */
    add(cell, cx, cy, cz, w, h, plane = 'z', o = {}) {
      const [u0, v0, du, dv] = tex.decalCell(cell);
      const rot = o.rot || 0;
      const c = Math.cos(rot), s = Math.sin(rot);
      const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
      const pts = [];
      const fm = B.frame;
      for (const [a, b] of corners) {
        let x = a * w, y = b * h;
        const xr = x * c - y * s, yr = x * s + y * c;
        const p = plane === 'z' ? new THREE.Vector3(cx + xr, cy + yr, cz) : new THREE.Vector3(cx + xr, cy, cz - yr);
        p.applyMatrix4(fm);
        pts.push(p);
      }
      const n = plane === 'z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
      n.applyMatrix3(new THREE.Matrix3().getNormalMatrix(fm)).normalize();
      const flipU = o.flipU ? 1 : 0;
      const uv = [u0, v0, u0 + du, v0, u0 + du, v0 + dv, u0, v0 + dv];
      if (flipU) { [uv[0], uv[2]] = [uv[2], uv[0]]; [uv[4], uv[6]] = [uv[6], uv[4]]; }
      this.list.push({ mat: o.mat || 'w:decal', pts, n, uv, ground: plane === 'y' && o.ground !== false });
    },
    build(root, col) {
      const byMat = new Map();
      const c = new THREE.Vector3();
      for (const d of this.list) {
        if (d.ground && col) {
          c.set(0, 0, 0); for (const p of d.pts) c.add(p); c.multiplyScalar(0.25);
          const y = col.groundHeight(c.x, c.z, c.y + 0.9, c.y);
          for (const p of d.pts) p.y = y + 0.012;
        }
        if (!byMat.has(d.mat)) byMat.set(d.mat, []);
        byMat.get(d.mat).push(d);
      }
      for (const [key, arr] of byMat) {
        const pos = new Float32Array(arr.length * 12), nor = new Float32Array(arr.length * 12), uv = new Float32Array(arr.length * 8);
        const idx = new Uint32Array(arr.length * 6);
        arr.forEach((d, i) => {
          d.pts.forEach((p, k) => { pos.set([p.x, p.y, p.z], i * 12 + k * 3); nor.set([d.n.x, d.n.y, d.n.z], i * 12 + k * 3); });
          uv.set(d.uv, i * 8);
          idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
        });
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        g.setIndex(new THREE.BufferAttribute(idx, 1));
        g.computeBoundingSphere();
        const mesh = new THREE.Mesh(g, mats.material(key));
        mesh.name = `world:decals:${key}`;
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        mesh.renderOrder = key === 'w:puddle' ? 2 : 1;
        if (key === 'w:puddle') {
          // three ignores material.envMapIntensity when lighting comes from scene.environment (it uses
          // scene.environmentIntensity). Bind the scene env explicitly so the puddle's own intensity applies.
          const pm = mesh.material;
          mesh.onBeforeRender = (_r, scene) => {
            if (pm.envMap !== scene.environment) { pm.envMap = scene.environment; pm.needsUpdate = true; }
          };
        }
        mesh.matrixAutoUpdate = false;
        root.add(mesh);
      }
      this.list.length = 0;
    },
  };

  // ---------------------------------------------------------------- interiors & glass
  const interiors = {
    add(Bb, cu, cv, z, w, h, r, fd, info) {
      const variant = Math.floor(r * 16) % 16;
      const cls = winClass(w, h);
      const u0 = 2 * variant, v0 = 2 * cls;
      Bb.quad('w:interior',
        [cu - w / 2, cv - h / 2, z], [cu + w / 2, cv - h / 2, z], [cu + w / 2, cv + h / 2, z], [cu - w / 2, cv + h / 2, z],
        { uvs: [u0, v0, u0 + 1, v0, u0 + 1, v0 + 1, u0, v0 + 1], uvOff: [0, 0], ray: true, move: true, shadow: false });
    },
  };
  const glass = {
    add(Bb, cu, cv, z, w, h, r, broken) {
      if (!broken) {
        Bb.quad('glass', [cu - w / 2, cv - h / 2, z], [cu + w / 2, cv - h / 2, z], [cu + w / 2, cv + h / 2, z], [cu - w / 2, cv + h / 2, z],
          { ray: true, move: false, shadow: false });
      } else {
        const k = Math.floor(r * 97) % 4;
        const u0 = (k % 2) * 0.5, v0 = 0.5 - Math.floor(k / 2) * 0.5;
        Bb.quad('w:glass_broken', [cu - w / 2, cv - h / 2, z], [cu + w / 2, cv - h / 2, z], [cu + w / 2, cv + h / 2, z], [cu - w / 2, cv + h / 2, z],
          { uvs: [u0, v0, u0 + 0.5, v0, u0 + 0.5, v0 + 0.5, u0, v0 + 0.5], uvOff: [0, 0], col: false, shadow: false });
      }
    },
  };

  // ---------------------------------------------------------------- shopfronts / doors / garages
  function shopfront(e, info, fd, op, r) {
    const ow = op.u1 - op.u0, oh = op.v1 - op.v0;
    const cu = (op.u0 + op.u1) / 2;
    const t = info.t;
    const style = info.spec.style;
    if (op.type === 'door') {
      // door frame + leaf (some ajar / missing), step
      const leafMat = r < 0.5 ? 'wood_painted' : 'metal_painted#green';
      B.box('metal_painted#dark', op.u0 + 0.04, oh / 2, -0.1, 0.08, oh, 0.12, { col: false });
      B.box('metal_painted#dark', op.u1 - 0.04, oh / 2, -0.1, 0.08, oh, 0.12, { col: false });
      B.box('metal_painted#dark', cu, oh - 0.04, -0.1, ow, 0.08, 0.12, { col: false });
      if (r > 0.3) {
        const open = r > 0.7 ? 1.2 : 0;
        // hinge at u0 side
        const lw = ow - 0.12;
        const ang = -open;
        B.push(new THREE.Matrix4().makeTranslation(op.u0 + 0.06, 0, -t + 0.1).multiply(new THREE.Matrix4().makeRotationY(ang)));
        B.box(leafMat, lw / 2, oh / 2 - 0.02, 0, lw, oh - 0.1, 0.05, { col: open === 0 });
        B.box('metal_galvanized', lw - 0.12, 1.0, 0.04, 0.03, 0.15, 0.03, { col: false });
        B.pop();
      }
      room(info, fd, op, 3.2, true);
      // step
      B.box('concrete_wall', cu, -0.05, 0.25, ow + 0.5, 0.2, 0.5, { skip: 8 });
      return;
    }
    if (op.type === 'garage') {
      const state = r < 0.45 ? 'closed' : r < 0.7 ? 'half' : 'open';
      if (state !== 'open') {
        const hFrac = state === 'closed' ? 1 : 0.35;
        const sh = oh * hFrac;
        props.place('rollershutter_door', cu, op.v1 - sh, -t * 0.35, 0, [ow / 3.08, sh / 2.4, 1], { frame: B.frame, collide: state === 'closed', surface: 'metal' });
        // shutter box at top
        B.box('metal_galvanized', cu, op.v1 + 0.15, -0.05, ow + 0.1, 0.32, 0.3, { col: false });
      }
      room(info, fd, op, Math.min(info.d - 1, 8), true, state === 'closed');
      return;
    }
    // shop display
    const state = op.state || (r < 0.35 ? 'shutter' : r < 0.5 ? 'half' : r < 0.9 ? 'open' : 'boarded');
    const sill = 0.5;
    if (state === 'shutter' || state === 'half') {
      const sh = state === 'shutter' ? oh : oh * 0.4;
      props.place('rollershutter_door', cu, op.v1 - sh, -0.16, 0, [ow / 3.08, sh / 2.4, 1], { frame: B.frame, collide: state === 'shutter', surface: 'metal' });
      B.box('metal_galvanized', cu, op.v1 + 0.16, -0.05, ow + 0.12, 0.32, 0.3, { col: false });
      if (state === 'half') {
        B.box(info.trimMat, cu, sill / 2, -t / 2, ow, sill, t * 0.8);
        room(info, fd, op, 4.0, false);
      }
    } else if (state === 'boarded') {
      for (let k = 0; k < 7; k++) {
        B.box('wood_planks', cu + (k - 3) * ow / 7, oh / 2 + op.v0, -0.02, ow / 7 - 0.02, oh * (0.85 + ((k * 5) % 3) * 0.05), 0.03, { rot: [0, 0, ((k * 13) % 5 - 2) * 0.02], uv: 'face', uvOff: [k * 0.37, 0] });
      }
      B.box('wood_planks', cu, op.v0 + oh * 0.3, 0.02, ow + 0.2, 0.12, 0.03, { col: false });
      B.box('wood_planks', cu, op.v0 + oh * 0.75, 0.02, ow + 0.2, 0.12, 0.03, { col: false });
    } else {
      // open, glass smashed: low sill wall only on some; frame remains
      const walkIn = r > 0.62;
      if (!walkIn) B.box(info.trimMat, cu, sill / 2, -t / 2, ow, sill, t * 0.8);
      const fz = -0.12;
      B.box('metal_painted#dark', op.u0 + 0.04, oh / 2 + op.v0, fz, 0.07, oh, 0.08, { col: false });
      B.box('metal_painted#dark', op.u1 - 0.04, oh / 2 + op.v0, fz, 0.07, oh, 0.08, { col: false });
      B.box('metal_painted#dark', cu, op.v1 - 0.04, fz, ow, 0.07, 0.08, { col: false });
      if (!walkIn) B.box('metal_painted#dark', cu, sill + 0.03, fz, ow, 0.06, 0.08, { col: false });
      if (!walkIn && r > 0.7) env.glass.add(B, cu, (op.v1 + sill) / 2, fz, ow - 0.1, op.v1 - sill - 0.1, r, true);
      room(info, fd, op, 4.2, walkIn);
      // glass shards on the ground outside
      decals.add(24 + (Math.floor(r * 10) % 4), cu, 0.012 - (info.spec.baseY ?? 0.15) + 0.15, 0.9, ow * 0.9, 1.3, 'y', { rot: r * 3 });
    }
    // signboard above
    if (!op.noSign && (op.bayIndex % 2 === 0 || r > 0.6)) {
      const sw = Math.min(ow + 0.6, 4.2), sh2 = 0.62;
      const sv = op.v1 + 0.45;
      B.box('metal_painted#dark', cu, sv, 0.05, sw + 0.1, sh2 + 0.1, 0.1, { col: false });
      const k = Math.floor(r * 1000) % 32;
      const [su, svv, du, dv] = tex.signCell(k);
      B.quad('w:signs', [cu - sw / 2, sv - sh2 / 2, 0.105], [cu + sw / 2, sv - sh2 / 2, 0.105], [cu + sw / 2, sv + sh2 / 2, 0.105], [cu - sw / 2, sv + sh2 / 2, 0.105],
        { uvs: [su, svv, su + du, svv, su + du, svv + dv, su, svv + dv], uvOff: [0, 0], col: false });
      // leak streak from the sign
      decals.add(Math.floor(r * 8) % 8, cu + (r - 0.5) * sw * 0.6, sv - sh2 / 2 - 0.6, 0.012, 1.2, 1.2, 'z');
    }
    // awning (fabric) sometimes
    if (r > 0.55 && r < 0.8) {
      const tint = ['w:tarp_red', 'w:tarp_green', 'w:tarp_blue', 'w:tarp_white'][Math.floor(r * 40) % 4];
      const aw = ow + 0.3, depth = 1.3, drop = 0.55;
      const top = op.v1 + 0.05;
      const g = new THREE.PlaneGeometry(aw, Math.hypot(depth, drop), 8, 3);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i);
        const sag = Math.sin((x / aw + 0.5) * Math.PI) * 0.0 + (r > 0.7 ? Math.max(0, x / aw) * 0.3 * (0.5 - y / Math.hypot(depth, drop)) : 0);
        p.setZ(i, -sag * 0.2);
      }
      const ang = Math.atan2(drop, depth);
      const m = new THREE.Matrix4().makeTranslation(cu, top - drop / 2, depth / 2).multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2 + ang));
      B.geometry(tint, g, m, { col: false, uv: 'keep', uvScale: 1 });
      g.dispose();
      // arms
      B.cylinder('metal_painted#dark', [cu - aw / 2, top - drop, depth], [cu - aw / 2, top - 0.3, 0], 0.015, 0.015, 5, { col: false });
      B.cylinder('metal_painted#dark', [cu + aw / 2, top - drop, depth], [cu + aw / 2, top - 0.3, 0], 0.015, 0.015, 5, { col: false });
    }
  }

  /** A shallow room behind an opening (facade frame). walk: floor reachable. */
  function room(info, fd, op, depth, walk, closed = false) {
    const t = info.t;
    const ow = op.u1 - op.u0;
    const w = Math.min(ow + 2.4, (op.u1 - op.u0) + 3.0);
    const cu = (op.u0 + op.u1) / 2;
    const h = info.heights[0][1] - 0.25;
    const z0 = -t, z1 = -t - depth;
    const wallMat = closed ? 'concrete_wall#dark' : (info.spec.style === 'industrial' ? 'concrete_wall' : 'plaster_painted#pale');
    // back + sides + ceiling (inner faces visible)
    B.box(wallMat, cu, h / 2, z1 - 0.1, w + 0.4, h, 0.2);
    B.box(wallMat, cu - w / 2 - 0.1, h / 2, (z0 + z1) / 2, 0.2, h, depth);
    B.box(wallMat, cu + w / 2 + 0.1, h / 2, (z0 + z1) / 2, 0.2, h, depth);
    B.box('concrete_floor', cu, h + 0.1, (z0 + z1) / 2, w + 0.4, 0.2, depth + 0.1);
    if (!closed) {
      B.box('tile_floor', cu, 0.18, (z0 + z1) / 2, w, 0.02, depth, { skip: 8 });
      // counter / shelves / debris
      const r = ((cu * 13.7 + depth * 3.1) % 1 + 1) % 1;
      B.box('wood_planks', cu - w * 0.2, 0.19 + 0.5, z1 + 0.35, w * 0.5, 1.0, 0.6);
      B.box('metal_painted#grey', cu + w * 0.3, 0.19 + 0.9, z1 + 0.25, 0.9, 1.8, 0.4);
      if (r > 0.5) B.box('wood_planks', cu + w * 0.1, 0.19 + 0.45, (z0 + z1) / 2, 1.6, 0.9, 0.7, { rot: [0, 0.4, 0] });
      else B.box('cardboard', cu - w * 0.1, 0.19 + 0.2, (z0 + z1) / 2 + 0.4, 0.5, 0.4, 0.5, { rot: [0, 0.6, 0] });
      decals.add(24 + Math.floor(r * 4), cu, 0.2, (z0 + z1) / 2, w * 0.8, depth * 0.8, 'y');
      decals.add(36 + Math.floor(r * 4), cu, 0.205, (z0 + z1) / 2, w, depth, 'y');
    }
    void walk;
  }

  function sandbagWindow(e, info, fd, op) {
    const cu = (op.u0 + op.u1) / 2;
    const ow = op.u1 - op.u0;
    const rows = Math.max(2, Math.round((op.v1 - op.v0) * 0.45 / 0.13));
    for (let r = 0; r < rows; r++) {
      const n = Math.max(2, Math.round(ow / 0.55));
      for (let k = 0; k < n; k++) {
        props.place('sandbag', op.u0 + (k + 0.5 + (r % 2) * 0.3) * ow / (n + 0.3), op.v0 + 0.07 + r * 0.13, -0.2, (r % 2) * 0.2 + (k % 3) * 0.05, [ow / n / 0.55, 1, 1], { frame: B.frame });
      }
    }
    interiors.add(B, cu, (op.v0 + op.v1) / 2, -info.t + 0.02, ow, op.v1 - op.v0, 0.77, fd, info);
  }

  // ---------------------------------------------------------------- damage
  const damage = {
    dressHole(e, info, fd, h) {
      const isConcrete = info.spec.style === 'panel';
      const wallMat = info.wallMat;
      const t = info.t;
      if (h.collapse) {
        dressCollapse(info, fd, h);
        return;
      }
      // jagged chunks around the perimeter of the union of rects
      const { cu, cv, r } = h;
      const n = 26;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + rng.range(-0.1, 0.1);
        const rr = r * rng.range(0.75, 1.15);
        const x = cu + Math.cos(a) * rr, y = cv + Math.sin(a) * rr * 0.85;
        if (y < 0.3) continue;
        const s = rng.range(0.15, 0.45);
        B.box(isConcrete ? wallMat : (rng.chance(0.6) ? 'brick_red' : wallMat), x, y, -t / 2 + rng.range(-0.05, 0.05), s, s * rng.range(0.6, 1.3), t * rng.range(0.6, 0.95),
          { rot: [rng.range(-0.4, 0.4), rng.range(-0.4, 0.4), rng.range(0, 3)], col: false });
      }
      // rebar
      if (isConcrete || info.spec.style === 'plaster') {
        for (let k = 0; k < 9; k++) {
          const a = rng.range(0, Math.PI * 2);
          const x0 = cu + Math.cos(a) * r * 1.05, y0 = cv + Math.sin(a) * r * 0.9;
          const x1 = cu + Math.cos(a) * r * rng.range(0.3, 0.7), y1 = cv + Math.sin(a) * r * rng.range(0.25, 0.6) - rng.range(0, 0.4);
          B.cylinder('metal_rusted', [x0, y0, -t / 2], [x1, y1, rng.range(-0.3, 0.25)], 0.008, 0.008, 4, { col: false });
        }
      }
      // scorch around the hole + a room behind
      decals.add(20 + Math.floor(rng.next() * 4), cu, cv, 0.015, r * 3.6, r * 3.2, 'z');
      decals.add(Math.floor(rng.next() * 4), cu, cv - r * 1.6, 0.014, r * 2, r * 2.5, 'z');
      const f = info.heights.findIndex(([a, b]) => cv >= a && cv < b);
      const [fy0, fy1] = info.heights[Math.max(0, f)];
      const depth = 3.0;
      const w = r * 2 + 2.4;
      const z1 = -t - depth;
      B.box('plaster_painted#pale', cu, (fy0 + fy1) / 2, z1 - 0.1, w, fy1 - fy0, 0.2);
      B.box('plaster_painted#pale', cu - w / 2, (fy0 + fy1) / 2, -t - depth / 2, 0.2, fy1 - fy0, depth);
      B.box('plaster_painted#pale', cu + w / 2, (fy0 + fy1) / 2, -t - depth / 2, 0.2, fy1 - fy0, depth);
      B.box('concrete_floor', cu, fy0 + 0.05, -t - depth / 2, w, 0.3, depth);
      B.box('concrete_floor', cu, fy1 - 0.1, -t - depth / 2, w, 0.2, depth);
      // debris inside + rubble below outside
      for (let k = 0; k < 6; k++) B.box(isConcrete ? 'rubble' : 'brick_red', cu + rng.range(-w / 3, w / 3), fy0 + 0.25, -t - rng.range(0.3, depth - 0.3), rng.range(0.2, 0.5), rng.range(0.1, 0.3), rng.range(0.2, 0.5), { rot: [rng.range(-0.3, 0.3), rng.range(0, 3), rng.range(-0.3, 0.3)], col: false });
      env.rubblePile?.(B, cu, -(info.spec.baseY ?? 0.15) + 0.05, 1.4, r * 1.3, 0.35 + r * 0.25, isConcrete ? 'rubble' : 'brick_red');
    },
  };

  function dressCollapse(info, fd, h) {
    const { dm, fromU, widthU } = h;
    const t = info.t;
    const isConcrete = info.spec.style === 'panel';
    const dir = dm.side === 'start' ? 1 : -1;
    const edgeU = fromU + dir * widthU;
    // jagged broken wall edge along the collapse line
    for (let k = 0; k < 18; k++) {
      const y = dm.bottom + rng.range(-0.3, info.H - dm.bottom);
      const x = edgeU - dir * rng.range(0, 0.5) + dir * rng.range(-0.2, 0.9) * (1 - (y - dm.bottom) / (info.H - dm.bottom + 0.01));
      const s = rng.range(0.2, 0.55);
      B.box(isConcrete ? info.wallMat : 'brick_red', x, y, -t / 2, s, s * rng.range(0.5, 1.2), t * 0.9, { rot: [rng.range(-0.3, 0.3), rng.range(-0.3, 0.3), rng.range(0, 3)], col: false });
    }
    // exposed slab edges with rebar
    for (let f = 1; f < info.heights.length + 1; f++) {
      const v = f < info.heights.length ? info.heights[f][0] : info.H;
      if (v < dm.bottom) continue;
      for (let k = 0; k < 7; k++) {
        const u = edgeU + dir * rng.range(-0.5, 1.5);
        B.cylinder('metal_rusted', [u, v - 0.1, -rng.range(0.2, 3)], [u + dir * rng.range(0.4, 1.4), v - rng.range(0.2, 1.4), rng.range(-0.8, 0.2)], 0.009, 0.009, 4, { col: false });
      }
    }
    // big rubble mound at the base
    const mu = fromU + dir * widthU * 0.5;
    env.rubblePile?.(B, mu, -(info.spec.baseY ?? 0.15) + 0.05, 1.6, Math.min(widthU * 0.7, 5), 1.2 + (info.H - dm.bottom) * 0.12, isConcrete ? 'rubble' : 'brick_red');
    // soot
    decals.add(20 + Math.floor(rng.next() * 4), edgeU, dm.bottom + 1, 0.015, 4, 4, 'z');
  }

  // ---------------------------------------------------------------- facade extras
  function facadeExtras(e, info, fd, kind, windows, holes) {
    const { S, H, parapet, t, spec } = info;
    const u0 = fd.a, u1 = fd.b, len = u1 - u0;
    const baseY = spec.baseY ?? 0.15;
    const r0 = hash3(spec.seed, fd.key.length, 3);
    const collapse = holes.find((h) => h.collapse);
    const inCollapse = (u) => collapse && (collapse.dm.side === 'start' ? u < collapse.fromU + collapse.widthU + 0.5 : u > collapse.fromU - collapse.widthU - 0.5);

    // grime band along the base and roof drip streaks
    if (kind !== 'party') {
      for (let u = u0 + 1; u < u1 - 0.5; u += 2.4) {
        decals.add(8 + Math.floor(hash3(spec.seed, u * 10, 1) * 4), u, 0.55, 0.012, 2.6, 1.1, 'z', { flipU: hash3(u, 2, 3) > 0.5 });
      }
      const top = H + parapet;
      for (let u = u0 + 0.8; u < u1 - 0.8; u += rngStep(spec.seed, u)) {
        if (inCollapse(u)) continue;
        const hh = 1.6 + hash3(spec.seed, u, 5) * 3.5;
        decals.add(Math.floor(hash3(spec.seed, u, 9) * 8), u, top - hh / 2 - 0.1, 0.013, 0.8 + hash3(u, 1, 1) * 1.5, hh, 'z');
      }
      // leaks under windows
      for (const w of windows) {
        if (w.type !== 'window' || hash3(w.u0, w.v0, 7) > 0.55) continue;
        const cu = (w.u0 + w.u1) / 2;
        const hh = 0.9 + hash3(w.u0, w.v0, 3) * 1.6;
        decals.add(Math.floor(hash3(w.u0, 3, w.v0) * 8), cu, w.v0 - 0.08 - hh / 2, 0.012, (w.u1 - w.u0) * 0.9, hh, 'z');
      }
      // spalled plaster patches
      if (spec.style === 'plaster' || spec.style === 'house') {
        const n = 1 + Math.floor(r0 * 3);
        for (let k = 0; k < n; k++) {
          const u = u0 + hash3(spec.seed, k, 11) * len;
          const v = 0.8 + hash3(spec.seed, k, 12) * (H - 1.5);
          if (inCollapse(u)) continue;
          if (windows.some((w) => u > w.u0 - 0.4 && u < w.u1 + 0.4 && v > w.v0 - 0.4 && v < w.v1 + 0.4)) continue;
          const s = 0.45 + hash3(k, spec.seed, 13) * 0.8;
          const cellK = (spec.style === 'brick' || hash3(k, spec.seed, 14) < 0.45) ? 32 + (k % 2) : 34 + (k % 2);
          decals.add(cellK, u, v, 0.014, s * 1.3, s, 'z', { rot: (hash3(k, 1, spec.seed) - 0.5) * 0.6 });
        }
      }
      // posters / graffiti at street level
      if (kind === 'street' || kind === 'arcade' || kind === 'windows' || kind === 'blank') {
        const n = kind === 'blank' ? 2 : 1;
        for (let k = 0; k < n; k++) {
          if (hash3(spec.seed, k, 21) > 0.6) continue;
          const u = u0 + 0.8 + hash3(spec.seed, k, 22) * (len - 1.6);
          const blocked = windows.some((w) => w.floor === 0 && u > w.u0 - 0.9 && u < w.u1 + 0.9);
          if (blocked) continue;
          const g = hash3(spec.seed, k, 23) > 0.5;
          decals.add(g ? 40 + (k + spec.seed) % 4 : 44 + (k + spec.seed) % 4, u, g ? 1.4 : 1.7, 0.016, g ? 2.2 : 0.8, g ? 1.1 : 1.0, 'z');
        }
      }
      // bullet hole clusters
      if (hash3(spec.seed, fd.key.length, 31) > 0.45) {
        const u = u0 + hash3(spec.seed, 3, 32) * len;
        decals.add(48, u, 1.2 + hash3(spec.seed, 4, 33) * 4, 0.017, 1.6, 1.6, 'z', { rot: hash3(u, 1, 1) * 6 });
      }
    }

    // drainpipes at both ends of the facade (+ one in the middle for long facades)
    if (kind !== 'party' && spec.roof !== 'gable' || (spec.roof === 'gable' && (fd.key === 'front' || fd.key === 'back'))) {
      const us = [u0 + 0.25, u1 - 0.25];
      if (len > 18) us.push((u0 + u1) / 2 + 0.6);
      for (const u of us) {
        if (hash3(u, spec.seed, 41) > 0.8 || inCollapse(u)) continue;
        drainpipe(u, H + (spec.roof === 'gable' ? 0 : parapet * 0.3), hash3(u, spec.seed, 42));
      }
    }

    // AC units / satellite dishes under upper floor windows
    for (const w of windows) {
      if (w.floor < 1 || w.type !== 'window') continue;
      const hsh = hash3(w.u0 * 3.1, w.v0, spec.seed);
      const cu = (w.u0 + w.u1) / 2;
      if (hsh < 0.16) {
        // split AC outdoor unit on brackets
        const ay = w.v0 - 0.55;
        B.box('metal_painted#white', cu, ay, 0.2, 0.8, 0.52, 0.28, { col: false });
        B.box('metal_painted#grey', cu - 0.14, ay, 0.345, 0.42, 0.42, 0.01, { col: false });
        B.box('metal_galvanized', cu - 0.3, ay - 0.3, 0.17, 0.04, 0.04, 0.36, { col: false });
        B.box('metal_galvanized', cu + 0.3, ay - 0.3, 0.17, 0.04, 0.04, 0.36, { col: false });
        B.cylinder('rubber', [cu + 0.3, ay + 0.1, 0.06], [cu + 0.45, ay + 0.4, 0.01], 0.012, 0.012, 4, { col: false });
        decals.add(Math.floor(hsh * 50) % 8, cu, ay - 1.1, 0.012, 0.5, 1.5, 'z');
      } else if (hsh < 0.22) {
        satellite(cu + (w.u1 - w.u0) * 0.7, w.v0 + 0.4, hsh);
      }
    }

    // gas pipe (yellow) along ground floor of residential facades
    if ((spec.style === 'plaster' || spec.style === 'house' || spec.style === 'panel') && kind !== 'party' && r0 > 0.35) {
      const y = 2.45 + (r0 > 0.7 ? 0.35 : 0);
      const a = u0 + 0.4, b = u1 - 0.4;
      B.cylinder('metal_painted#yellow', [a, y, 0.12], [b, y, 0.12], 0.028, 0.028, 6, { col: false });
      for (let u = a + 0.5; u < b; u += 2.2) B.box('metal_galvanized', u, y, 0.06, 0.04, 0.08, 0.12, { col: false });
      // risers into the building
      const nR = 1 + Math.floor(r0 * 3);
      for (let k = 0; k < nR; k++) {
        const u = a + (k + 0.5) * (b - a) / nR;
        B.cylinder('metal_painted#yellow', [u, y, 0.12], [u, y, 0.0], 0.028, 0.028, 6, { col: false });
        B.cylinder('metal_painted#yellow', [u + 0.3, 0.2, 0.12], [u + 0.3, y, 0.12], 0.022, 0.022, 6, { col: false });
        B.box('metal_painted#yellow', u + 0.3, 0.9, 0.16, 0.12, 0.22, 0.1, { col: false });
      }
    }

    // facade cables (droopy, between random anchors)
    if (kind !== 'party' && r0 > 0.25) {
      const y = 3.2 + r0 * (H - 4);
      const pts = [];
      const n = 16;
      for (let i = 0; i <= n; i++) {
        const u = u0 + 0.3 + (len - 0.6) * i / n;
        const sag = Math.sin((i / n) * Math.PI * 3) * 0.08 + 0.12 * Math.sin(i / n * Math.PI);
        pts.push(new THREE.Vector3(u, y - Math.abs(sag), 0.06));
      }
      B.tube('rubber', pts, 0.012, 4, { shadow: true });
    }
    void S; void baseY; void t;
  }

  function drainpipe(u, top, h) {
    const r = 0.055;
    const mat = h > 0.5 ? 'metal_galvanized' : 'metal_rusted';
    // gutter funnel
    B.box(mat, u, top - 0.1, 0.16, 0.28, 0.24, 0.24, { col: false });
    B.cylinder(mat, [u, top - 0.22, 0.16], [u, 0.45, 0.16], r, r, 8, { col: false });
    // elbow + outlet
    B.cylinder(mat, [u, 0.45, 0.16], [u, 0.25, 0.32], r, r, 8, { col: false });
    // brackets
    for (let y = 1.2; y < top - 0.5; y += 1.8) B.box('metal_galvanized', u, y, 0.08, 0.14, 0.04, 0.16, { col: false });
    // missing segment sometimes
    if (h > 0.85) B.cylinder(mat, [u + 0.4, 0.12, 0.6], [u + 1.4, 0.12, 0.9], r, r, 8, { col: false });
    // stain under outlet
    decals.add(36 + Math.floor(h * 4), u, 0.02 - 0.15, 0.6, 1.0, 1.0, 'y');
  }

  function satellite(u, v, h) {
    const g = new THREE.SphereGeometry(0.34, 12, 4, 0, Math.PI * 2, 0, 0.55);
    const m = new THREE.Matrix4().makeTranslation(u, v, 0.35).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2 - 0.4 + h)).multiply(new THREE.Matrix4().makeScale(1, 0.4, 1));
    B.geometry('metal_painted#white', g, m, { col: false });
    g.dispose();
    B.cylinder('metal_galvanized', [u, v, 0.02], [u, v, 0.35], 0.02, 0.02, 5, { col: false });
    B.cylinder('metal_galvanized', [u, v, 0.35], [u, v + 0.05, 0.62], 0.012, 0.012, 4, { col: false });
    B.box('metal_painted#dark', u, v + 0.06, 0.64, 0.06, 0.06, 0.08, { col: false });
  }

  // ---------------------------------------------------------------- balconies (facade frame)
  function balcony(e, info, fd, op) {
    const { u0, u1, v, top, floorH } = op.balc;
    const w = u1 - u0, cu = (u0 + u1) / 2;
    const D = 1.1;
    const seed = info.spec.seed || 1;
    const r = hash3(seed, cu * 3.1, v * 1.7);
    const r2 = hash3(v, cu, seed * 0.37);
    const style = info.spec.style;
    // Soviet blocks: mostly solid parapets and glazed-in loggias; older plaster houses: iron railings
    const kind = style === 'panel' ? (r < 0.45 ? 'glazed' : r < 0.85 ? 'panel' : 'rail') : (r < 0.25 ? 'glazed' : r < 0.45 ? 'panel' : 'rail');
    const slabMat = style === 'panel' ? 'concrete_panel' : 'concrete_wall';
    // slab with a drip edge
    B.box(slabMat, cu, v - 0.08, D / 2, w, 0.16, D);
    B.box(slabMat, cu, v - 0.17, D - 0.03, w, 0.04, 0.06, { col: false });
    decals.add(Math.floor(r2 * 8), cu + (r - 0.5) * w * 0.5, v - 0.9, 0.012, 1.2, 1.4, 'z');
    const H = 1.02;
    const panelMat = style === 'panel'
      ? (r2 < 0.5 ? 'concrete_panel' : 'corrugated_metal#grey')
      : (r2 < 0.4 ? info.wallMat : r2 < 0.7 ? 'corrugated_metal#rust' : 'painted_wood');
    if (kind === 'panel' || kind === 'glazed') {
      B.box(panelMat, cu, v + H / 2, D - 0.03, w, H, 0.06, { uv: 'face' });
      B.box(panelMat, u0 + 0.03, v + H / 2, D / 2, 0.06, H, D - 0.12, { uv: 'face' });
      B.box(panelMat, u1 - 0.03, v + H / 2, D / 2, 0.06, H, D - 0.12, { uv: 'face' });
      B.box('metal_galvanized', cu, v + H + 0.02, D - 0.03, w + 0.04, 0.04, 0.1, { col: false });
    } else {
      const rail = r2 < 0.5 ? 'metal_painted#dark' : 'metal_rusted';
      B.box(rail, cu, v + H, D - 0.03, w, 0.045, 0.045);
      B.box(rail, cu, v + 0.12, D - 0.03, w, 0.03, 0.03, { col: false });
      for (const uu of [u0 + 0.03, u1 - 0.03]) {
        B.box(rail, uu, v + H, D / 2, 0.045, 0.045, D - 0.06, { col: false });
        B.box(rail, uu, v + H / 2, D - 0.03, 0.045, H, 0.045, { col: false });
        for (let z = 0.2; z < D - 0.1; z += 0.14) B.box(rail, uu, v + H / 2, z, 0.016, H - 0.05, 0.016, { col: false, shadow: false });
      }
      for (let uu = u0 + 0.15; uu < u1 - 0.1; uu += 0.13) B.box(rail, uu, v + H / 2 + 0.05, D - 0.03, 0.016, H - 0.1, 0.016, { col: false });
      B.colBox(cu, v + H / 2, D - 0.03, w, H, 0.05, { matKey: rail, surface: 'metal' }, { ray: false, move: true });
    }
    if (kind === 'glazed') {
      const gTop = v + floorH - 0.2;
      const fm = r2 < 0.5 ? 'wood_painted' : 'metal_painted#white';
      const gh = gTop - (v + H + 0.04);
      const gy = v + H + 0.04 + gh / 2;
      const zf = D - 0.04;
      B.box(fm, cu, v + H + 0.06, zf, w, 0.06, 0.08, { col: false });
      B.box(fm, cu, gTop - 0.03, zf, w, 0.06, 0.08, { col: false });
      const nP = Math.max(3, Math.round(w / 0.68));
      for (let k = 0; k <= nP; k++) B.box(fm, u0 + (w * k) / nP, gy, zf, 0.06, gh, 0.08, { col: false });
      for (const uu of [u0 + 0.03, u1 - 0.03]) B.box(fm, uu, gy, D / 2, 0.06, gh, D - 0.1, { col: false, uv: 'face' });
      for (let k = 0; k < nP; k++) {
        const pr = hash3(seed, k, v * cu);
        const pc = u0 + (w * (k + 0.5)) / nP;
        if (pr < 0.22) continue; // pane open / missing
        glass.add(B, pc, gy, zf - 0.005, w / nP - 0.08, gh - 0.1, pr, pr < 0.45);
      }
      interiors.add(B, cu, gy, 0.05, w - 0.2, gh, r2, fd, info);
      if (top) B.box('corrugated_metal#rust', cu, gTop + 0.08, D / 2, w + 0.1, 0.05, D + 0.12, { rot: [0.08, 0, 0] });
      else B.box(slabMat, cu, gTop + 0.06, D / 2, w, 0.12, D, { col: false });
    }
    // clutter (seen above the parapet / through rails)
    const nC = Math.floor(r2 * 3);
    for (let k = 0; k < nC; k++) {
      const cx = u0 + 0.35 + hash3(k, seed, v) * (w - 0.7);
      const kk = hash3(v, k, cu);
      if (kk < 0.35) B.box('cardboard', cx, v + 0.2, 0.35 + kk, 0.45, 0.4, 0.35, { rot: [0, kk * 2, 0], col: false });
      else if (kk < 0.6) B.cylinder('metal_galvanized', [cx, v, 0.4], [cx, v + 0.32, 0.4], 0.14, 0.16, 8, { caps: true, col: false });
      else if (kk < 0.8) B.box('wood_planks', cx, v + 0.6, 0.15, 0.08, 1.2, 0.5, { rot: [0.25, 0, 0], col: false, uv: 'face' });
      else B.box('rubber', cx, v + 0.12, 0.5, 0.5, 0.25, 0.4, { col: false });
    }
    if (r2 > 0.55 && kind !== 'glazed') {
      // laundry line between hooks across the balcony
      const a = new THREE.Vector3(u0 + 0.15, v + 1.7, 0.75).applyMatrix4(B.frame);
      const b = new THREE.Vector3(u1 - 0.15, v + 1.65, 0.75).applyMatrix4(B.frame);
      env.laundry?.(B, a.toArray(), b.toArray());
    }
    if (r > 0.9) satellite(u1 - 0.4, v + H + 0.4, r);
  }

  // ---------------------------------------------------------------- window security grille (facade frame)
  function grille(e, info, op) {
    const ow = op.u1 - op.u0, oh = op.v1 - op.v0;
    const cu = (op.u0 + op.u1) / 2, cv = (op.v0 + op.v1) / 2;
    const m = hash3(op.u0, op.v0, 5) < 0.5 ? 'metal_painted#dark' : 'metal_rusted';
    const z = 0.05;
    const fw = ow + 0.12, fh = oh + 0.12;
    B.box(m, cu, op.v1 + 0.04, z, fw, 0.035, 0.03, { col: false });
    B.box(m, cu, op.v0 - 0.04, z, fw, 0.035, 0.03, { col: false });
    B.box(m, op.u0 - 0.04, cv, z, 0.035, fh, 0.03, { col: false });
    B.box(m, op.u1 + 0.04, cv, z, 0.035, fh, 0.03, { col: false });
    for (let u = op.u0 + 0.11; u < op.u1 - 0.05; u += 0.13) B.box(m, u, cv, z, 0.014, oh + 0.06, 0.014, { col: false, shadow: false });
    for (const f of [0.33, 0.66]) B.box(m, cu, op.v0 + oh * f, z + 0.005, ow + 0.06, 0.018, 0.012, { col: false, shadow: false });
    // half-sun ornament on some
    if (hash3(op.u0, 3, op.v0) < 0.35) {
      for (let k = 0; k < 5; k++) {
        const a = Math.PI * (0.15 + 0.7 * k / 4);
        B.cylinder(m, [cu, op.v0 + 0.02, z + 0.01], [cu + Math.cos(a) * ow * 0.42, op.v0 + 0.02 + Math.sin(a) * oh * 0.28, z + 0.01], 0.008, 0.008, 3, { col: false, shadow: false });
      }
    }
    void info;
  }

  // ---------------------------------------------------------------- roof clutter
  function roofClutter(e, info) {
    const { H, w, d, spec, t } = info;
    const iw = w - 2 * t - 1, id = d - 2 * t - 1;
    const k = hash3(spec.seed, 1, 1);
    const collapse = (info.damage || []).find((dm) => dm.type === 'collapse');
    const ok = (x, z) => {
      if (!collapse) return true;
      // keep clutter away from the collapsed side (approx: stay near the center)
      return Math.abs(x) < iw * 0.25 && Math.abs(z) < id * 0.25;
    };
    // stair / lift housing on taller buildings
    if (spec.floors >= 4 && ok(iw * 0.2, 0)) {
      const hx = iw * 0.2, hz = -id * 0.15;
      B.box(info.style === 'panel' ? 'concrete_panel' : info.wallMat, hx, H + 1.3, hz, 3.2, 2.6, 2.8);
      B.box('roofing_tar', hx, H + 2.65, hz, 3.5, 0.12, 3.1);
      B.box('metal_painted#dark', hx - 0.4, H + 1.1, hz + 1.41, 0.9, 2.0, 0.05, { col: false });
    }
    // vents / chimneys
    const nv = 2 + Math.floor(k * 4);
    for (let i = 0; i < nv; i++) {
      const x = (hash3(spec.seed, i, 2) - 0.5) * iw, z = (hash3(spec.seed, i, 3) - 0.5) * id;
      if (!ok(x, z)) continue;
      const hh = 0.6 + hash3(i, spec.seed, 4) * 1.0;
      B.box(spec.style === 'brick' ? 'brick_red' : 'concrete_wall', x, H + hh / 2, z, 0.7, hh, 0.5);
      B.box('concrete_wall', x, H + hh + 0.04, z, 0.85, 0.08, 0.65, { col: false });
    }
    // antennas
    const na = Math.floor(k * 3);
    for (let i = 0; i < na; i++) {
      const x = (hash3(spec.seed, i, 7) - 0.5) * iw * 0.8, z = (hash3(spec.seed, i, 8) - 0.5) * id * 0.8;
      if (!ok(x, z)) continue;
      const hh = 2 + hash3(i, 3, spec.seed) * 2.5;
      B.cylinder('metal_galvanized', [x, H, z], [x, H + hh, z], 0.025, 0.02, 5, { col: false });
      for (let j = 0; j < 4; j++) B.cylinder('metal_galvanized', [x - 0.5, H + hh - j * 0.3, z], [x + 0.5, H + hh - j * 0.3, z], 0.008, 0.008, 3, { col: false });
    }
    // water tank
    if (k > 0.6 && ok(-iw * 0.25, id * 0.2)) {
      const x = -iw * 0.25, z = id * 0.2;
      B.cylinder('metal_rusted', [x, H + 0.6, z], [x, H + 2.4, z], 0.8, 0.8, 14, { caps: true });
      for (const [dx, dz] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) B.box('metal_rusted', x + dx, H + 0.3, z + dz, 0.1, 0.6, 0.1);
    }
    // roof AC units
    const nac = Math.floor(hash3(spec.seed, 9, 9) * 3);
    for (let i = 0; i < nac; i++) {
      const x = (hash3(spec.seed, i, 12) - 0.5) * iw * 0.7, z = (hash3(spec.seed, i, 13) - 0.5) * id * 0.7;
      if (!ok(x, z)) continue;
      B.box('metal_painted#white', x, H + 0.45, z, 1.0, 0.9, 0.8);
      B.cylinder('metal_painted#grey', [x, H + 0.91, z], [x, H + 0.93, z], 0.35, 0.35, 12, { col: false, caps: true });
    }
    // tar patches on the roof
    for (let i = 0; i < 3; i++) {
      decals.add(16 + i, (hash3(spec.seed, i, 21) - 0.5) * iw, H + 0.01, (hash3(spec.seed, i, 22) - 0.5) * id, 3, 3, 'y');
    }
  }

  return {
    decals, interiors, glass, shopfront, sandbagWindow, damage, facadeExtras, roofClutter, drainpipe, satellite, balcony, grille,
  };
}

function hash3(a, b, c) {
  let h = (Math.floor(a * 1000) * 374761393 + Math.floor(b * 1000) * 668265263 + Math.floor(c * 1000) * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function rngStep(seed, u) { return 1.2 + hash3(seed, u, 77) * 2.4; }

export { hash3 };

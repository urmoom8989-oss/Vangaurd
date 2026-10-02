import * as THREE from 'three';

/**
 * Modular building generator. Buildings are authored in a local frame: footprint centered at the origin,
 * width w along X, depth d along Z, FRONT facade facing +Z. Each facade is built in its own facade frame
 * (u along the facade, v up, +z out of the wall; the wall occupies z in [-t, 0]).
 *
 * Walls are real boxes with thickness; openings are cut by decomposing the facade rectangle into
 * solid columns, so reveals/sills/lintels have real depth and cast shadows.
 */

const STYLE = {
  panel: { floorH: 2.9, groundH: 3.1, t: 0.38, wall: 'concrete_panel', trim: 'concrete_wall', base: 'concrete_wall', bay: 3.0, winW: 1.45, winH: 1.45, sill: 0.85, frame: 'wood_painted', seams: true, parapet: 0.7, cornice: false },
  plaster: { floorH: 3.2, groundH: 3.6, t: 0.42, wall: 'plaster_painted', trim: 'plaster_white', base: 'concrete_wall', bay: 3.3, winW: 1.25, winH: 1.6, sill: 0.9, frame: 'wood_painted', seams: false, parapet: 0.8, cornice: true },
  brick: { floorH: 3.3, groundH: 3.8, t: 0.45, wall: 'brick_red', trim: 'plaster_white', base: 'concrete_wall', bay: 3.2, winW: 1.2, winH: 1.7, sill: 0.9, frame: 'wood_painted', seams: false, parapet: 0.9, cornice: true },
  house: { floorH: 3.0, groundH: 3.2, t: 0.4, wall: 'plaster_painted', trim: 'plaster_white', base: 'concrete_wall', bay: 3.0, winW: 1.1, winH: 1.4, sill: 0.9, frame: 'wood_painted', seams: false, parapet: 0, cornice: false },
  industrial: { floorH: 6.0, groundH: 6.0, t: 0.3, wall: 'corrugated_metal', trim: 'metal_painted', base: 'concrete_wall', bay: 5.0, winW: 3.0, winH: 1.0, sill: 4.2, frame: 'metal_painted', seams: false, parapet: 0.3, cornice: false },
};

export function styleOf(name) { return STYLE[name] || STYLE.plaster; }

/** Merge sorted intervals. */
function mergeIntervals(iv) {
  iv.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of iv) {
    if (out.length && a <= out[out.length - 1][1] + 1e-4) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Emit a wall rectangle [u0,u1]x[v0,v1] (facade frame, depth [-t,0]) minus rectangular openings.
 * openings: [{u0,u1,v0,v1}] ; emits boxes via B.box in the current frame.
 */
export function wallWithOpenings(B, mat, u0, u1, v0, v1, t, openings, o = {}) {
  const xs = new Set([u0, u1]);
  for (const op of openings) {
    if (op.u1 <= u0 || op.u0 >= u1) continue;
    xs.add(Math.max(u0, op.u0)); xs.add(Math.min(u1, op.u1));
  }
  const X = [...xs].sort((a, b) => a - b);
  let prevKey = null, runStart = 0, prevSolid = null;
  const flush = (xa, xb, solid) => {
    for (const [a, b] of solid) {
      if (b - a < 1e-3 || xb - xa < 1e-3) continue;
      B.box(mat, (xa + xb) / 2, (a + b) / 2, -t / 2 + (o.zOff || 0), xb - xa, b - a, t, o.box || {});
    }
  };
  for (let i = 0; i < X.length - 1; i++) {
    const xa = X[i], xb = X[i + 1];
    if (xb - xa < 1e-4) continue;
    const mid = (xa + xb) / 2;
    const holes = [];
    for (const op of openings) if (op.u0 < mid && op.u1 > mid) holes.push([Math.max(v0, op.v0), Math.min(v1, op.v1)]);
    const merged = mergeIntervals(holes.filter(([a, b]) => b > a));
    const solid = [];
    let cur = v0;
    for (const [a, b] of merged) { if (a > cur) solid.push([cur, a]); cur = Math.max(cur, b); }
    if (cur < v1) solid.push([cur, v1]);
    const key = solid.map((s) => s.join(',')).join('|');
    if (prevKey === null) { prevKey = key; runStart = xa; prevSolid = solid; continue; }
    if (key !== prevKey) { flush(runStart, xa, prevSolid); prevKey = key; runStart = xa; prevSolid = solid; }
  }
  if (prevSolid) flush(runStart, X[X.length - 1], prevSolid);
}

/**
 * Build one building.
 * spec: { x, z, w, d, rotY, floors, style, tint, faces: {front, back, left, right}: 'street'|'windows'|'blank'|'arcade'|'party',
 *         roof: 'flat'|'gable', damage: [...], seed, shopFaces, balconies, enterable }
 * env: { B, rng, mats, props, decals, signs, interiors }
 */
export function buildBuilding(env, spec) {
  const { B, rng } = env;
  const S = { ...styleOf(spec.style), ...(spec.styleOverride || {}) };
  const floors = spec.floors;
  const PLASTER = { ochre: 'plaster_ochre', mint: 'plaster_green', salmon: 'plaster_pink', sky: 'plaster_blue', white: 'plaster_white', pale: 'plaster_white', cream: 'plaster_painted', damaged: 'plaster_damaged' };
  const cat = env.mats.cat;
  let wallMat = spec.wallMat;
  if (!wallMat && spec.tint && S.wall === 'plaster_painted' && PLASTER[spec.tint] && cat.has(PLASTER[spec.tint])) wallMat = PLASTER[spec.tint];
  if (!wallMat) wallMat = spec.tint ? `${S.wall}#${spec.tint}` : S.wall;
  const trimMat = spec.trimMat || S.trim;
  const baseY = spec.baseY ?? 0.15;
  const heights = [];
  let y = 0;
  for (let f = 0; f < floors; f++) {
    const h = f === 0 ? (spec.groundH ?? S.groundH) : S.floorH;
    heights.push([y, y + h]);
    y += h;
  }
  const H = y; // top of last floor (roof slab top)
  const parapet = spec.roof === 'gable' ? 0 : (spec.parapet ?? S.parapet);
  const t = S.t;
  const w = spec.w, d = spec.d;
  const uvOff = [rng.range(0, 7), rng.range(0, 7)];
  B.pushTR(spec.x, baseY, spec.z, spec.rotY || 0, { chunkAt: [spec.x, spec.z], uvOff });

  const info = { spec, S, heights, H, parapet, t, w, d, wallMat, trimMat, openingsByFace: {}, damage: spec.damage || [] };

  // plinth under the whole footprint (hides ground seams, gives weight)
  const plinthH = spec.style === 'industrial' ? 1.2 : 0.55;
  const baseMat = spec.baseMat || S.base;
  B.box(baseMat, 0, -0.3 + (plinthH + 0.3) / 2, 0, w + 0.08, plinthH + 0.3, d + 0.08, { skip: 8 });

  // ground floor slab (walkable if enterable)
  B.box('concrete_floor', 0, 0.02, 0, w - 0.2, 0.3, d - 0.2, { skip: 8 });

  const faces = spec.faces || {};
  const faceDefs = [
    { key: 'front', len: w, off: d / 2, rot: 0, a: -w / 2, b: w / 2 },
    { key: 'back', len: w, off: d / 2, rot: Math.PI, a: -w / 2, b: w / 2 },
    { key: 'right', len: d, off: w / 2, rot: Math.PI / 2, a: -d / 2 + t, b: d / 2 - t },
    { key: 'left', len: d, off: w / 2, rot: -Math.PI / 2, a: -d / 2 + t, b: d / 2 - t },
  ];
  for (const fd of faceDefs) {
    const kind = faces[fd.key] || 'windows';
    const m = new THREE.Matrix4().makeRotationY(fd.rot).multiply(new THREE.Matrix4().makeTranslation(0, 0, fd.off));
    B.push(m);
    buildFacade(env, info, fd, kind);
    B.pop();
  }

  // interior floor slabs visible through collapse/holes + ceilings; a roof slab
  buildRoof(env, info);

  B.pop();
  return info;
}

function hash(a, b, c = 0) {
  let h = (a * 374761393 + b * 668265263 + c * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function buildFacade(env, info, fd, kind) {
  const { B, rng } = env;
  const { S, heights, H, parapet, t, spec } = info;
  const u0 = fd.a, u1 = fd.b, len = u1 - u0;
  const openings = [];
  const windows = [];
  const damage = (info.damage || []).filter((dm) => dm.face === fd.key);
  const topV = H + parapet;

  if (kind === 'party' || kind === 'blank') {
    // blank wall (maybe a few small vents)
  } else {
    // bays
    const nb = Math.max(1, Math.floor((len - 1.0) / S.bay));
    const bay = (len - 0.0) / nb;
    for (let f = 0; f < heights.length; f++) {
      const [fy0, fy1] = heights[f];
      for (let i = 0; i < nb; i++) {
        const cu = u0 + bay * (i + 0.5);
        const r = hash(spec.seed || 1, f * 31 + i, fd.key.length);
        if (f === 0 && (kind === 'street' || kind === 'arcade')) {
          // shopfront / door bays
          const sw = Math.min(bay - 0.7, 3.2);
          const isDoor = r < 0.25;
          const ow = isDoor ? 1.2 : sw;
          const oh = isDoor ? 2.3 : Math.min(fy1 - fy0 - 0.7, 2.9);
          const op = { u0: cu - ow / 2, u1: cu + ow / 2, v0: isDoor ? 0.0 : 0.35, v1: (isDoor ? 0 : 0) + oh + (isDoor ? 0 : 0.0), floor: f, type: isDoor ? 'door' : 'shop', bayIndex: i };
          if (!isDoor) op.v1 = 0.35 + oh - 0.35;
          openings.push(op);
          windows.push(op);
        } else if (f === 0 && kind === 'garage') {
          const ow = Math.min(bay - 0.8, 3.6);
          const op = { u0: cu - ow / 2, u1: cu + ow / 2, v0: 0, v1: 3.0, floor: f, type: 'garage', bayIndex: i };
          openings.push(op); windows.push(op);
        } else {
          if (kind === 'sparse' && r < 0.45) continue;
          const balcony = spec.balconies && f > 0 && (i % 2 === 1) && (fd.key === 'front' || (fd.key === 'back' && spec.style === 'panel')) && bay > 2.6;
          const ww = balcony ? 0.9 : S.winW, wh = balcony ? 2.2 : S.winH;
          const sill = balcony ? 0.05 : (f === 0 ? S.sill + 0.25 : S.sill);
          const bu = balcony ? cu - 0.55 : cu;
          const op = { u0: bu - ww / 2, u1: bu + ww / 2, v0: fy0 + sill, v1: fy0 + sill + wh, floor: f, type: balcony ? 'balcony_door' : 'window', bayIndex: i, balcony };
          openings.push(op); windows.push(op);
          if (balcony) {
            const op2 = { u0: cu + 0.25, u1: cu + 0.25 + 1.1, v0: fy0 + S.sill, v1: fy0 + S.sill + S.winH, floor: f, type: 'window', bayIndex: i, onBalcony: true };
            openings.push(op2); windows.push(op2);
            op.balc = { u0: bu - ww / 2 - 0.3, u1: cu + 0.25 + 1.1 + 0.3, v: fy0, f, top: f === heights.length - 1, floorH: fy1 - fy0 };
          }
        }
      }
    }
  }
  // damage holes (irregular: several overlapping rects)
  const holes = [];
  for (const dm of damage) {
    if (dm.type === 'hole') {
      const cu = u0 + len * dm.u, cv = dm.v;
      const r = dm.r || 1.2;
      const rects = [];
      for (let k = 0; k < 5; k++) {
        const hw = r * rng.range(0.45, 1.0), hh = r * rng.range(0.4, 0.9);
        const du = rng.range(-r * 0.4, r * 0.4), dv = rng.range(-r * 0.35, r * 0.35);
        rects.push({ u0: cu + du - hw, u1: cu + du + hw, v0: Math.max(0.3, cv + dv - hh), v1: cv + dv + hh });
      }
      for (const rc of rects) openings.push(rc);
      holes.push({ cu, cv, r, rects, dm });
      // remove windows overlapped by the hole
      for (let wi = windows.length - 1; wi >= 0; wi--) {
        const wn = windows[wi];
        if (rects.some((rc) => rc.u0 < wn.u1 && rc.u1 > wn.u0 && rc.v0 < wn.v1 && rc.v1 > wn.v0)) {
          windows.splice(wi, 1);
        }
      }
    } else if (dm.type === 'collapse') {
      // stepped collapse from one end: remove wall above a jagged line
      const fromU = dm.side === 'start' ? u0 : u1;
      const widthU = len * dm.extent;
      const steps = 7;
      for (let k = 0; k < steps; k++) {
        const a = k / steps, b = (k + 1) / steps;
        const ua = dm.side === 'start' ? fromU + widthU * a : fromU - widthU * b;
        const ub = dm.side === 'start' ? fromU + widthU * b : fromU - widthU * a;
        const falloff = dm.side === 'start' ? 1 - a : 1 - a;
        const cut = dm.bottom + (topV - dm.bottom) * (1 - falloff) * rng.range(0.7, 1.1) + rng.range(-0.4, 0.4);
        openings.push({ u0: ua - 0.01, u1: ub + 0.01, v0: Math.max(dm.bottom * 0.6, cut), v1: topV + 1 });
      }
      for (let wi = windows.length - 1; wi >= 0; wi--) {
        const wn = windows[wi];
        const inRange = dm.side === 'start' ? wn.u0 < fromU + widthU : wn.u1 > fromU - widthU;
        if (inRange && wn.v1 > dm.bottom) windows.splice(wi, 1);
      }
      holes.push({ collapse: true, dm, fromU, widthU });
    }
  }
  info.openingsByFace[fd.key] = { openings, windows, u0, u1 };

  // wall body: main wall from 0 to top of parapet
  wallWithOpenings(B, info.wallMat, u0, u1, 0, topV, t, openings);

  // interior backing for ground-floor shops (a shallow room so the opening reads as a space)
  // + window assemblies
  for (const op of windows) emitOpening(env, info, fd, op);

  // floor bands / cornice / base band (trim) — skip where collapsed
  const collapse = holes.find((h) => h.collapse);
  const bandSpan = (v) => {
    if (!collapse) return [[u0, u1]];
    const { dm, fromU, widthU } = collapse;
    if (v < dm.bottom) return [[u0, u1]];
    return dm.side === 'start' ? [[fromU + widthU, u1]] : [[u0, fromU - widthU]];
  };
  if (S.cornice && kind !== 'party') {
    for (let f = 1; f < heights.length; f++) {
      const v = heights[f][0];
      for (const [a, b] of bandSpan(v)) {
        B.box(info.trimMat, (a + b) / 2, v - 0.05, 0.05, b - a + 0.1, 0.22, 0.1);
      }
    }
    // cornice at roof line
    for (const [a, b] of bandSpan(H)) {
      B.box(info.trimMat, (a + b) / 2, H - 0.25, 0.08, b - a + 0.16, 0.35, 0.16);
      B.box(info.trimMat, (a + b) / 2, H + 0.02, 0.14, b - a + 0.28, 0.18, 0.28);
    }
  }
  if (S.seams && kind !== 'party') {
    // dark sealant joints between precast panels
    for (let f = 1; f < heights.length; f++) {
      const v = heights[f][0];
      for (const [a, b] of bandSpan(v)) B.box('rubber', (a + b) / 2, v, 0.006, b - a, 0.045, 0.012, { col: false, shadow: false });
    }
    const nb = Math.max(1, Math.floor((len - 1.0) / S.bay));
    const bay = len / nb;
    for (let i = 1; i < nb; i++) {
      const u = u0 + bay * i;
      let top = H;
      if (collapse) {
        const { dm, fromU, widthU } = collapse;
        if ((dm.side === 'start' && u < fromU + widthU) || (dm.side === 'end' && u > fromU - widthU)) top = dm.bottom;
      }
      B.box('rubber', u, top / 2, 0.006, 0.045, top, 0.012, { col: false, shadow: false });
    }
  }
  // parapet coping
  if (parapet > 0) {
    for (const [a, b] of bandSpan(topV)) {
      B.box(spec.style === 'panel' ? 'metal_galvanized' : info.trimMat, (a + b) / 2, topV + 0.04, -t / 2 + 0.03, b - a + 0.06, 0.08, t + 0.14);
    }
  }
  // base band trim
  if (kind !== 'party') {
    B.box(info.spec.baseMat || S.base, (u0 + u1) / 2, 0.3, 0.035, len + 0.02, 0.6, 0.07, { skip: 8 });
  }

  // damage dressing (jagged edges, rebar, rubble)
  for (const h of holes) env.damage?.dressHole(env, info, fd, h);

  // facade extras: drainpipes, cables, AC units, gas pipes, signs
  env.facadeExtras?.(env, info, fd, kind, windows, holes);
}

function emitOpening(env, info, fd, op) {
  const { B, rng } = env;
  const { S, t } = info;
  const ow = op.u1 - op.u0, oh = op.v1 - op.v0;
  const cu = (op.u0 + op.u1) / 2, cv = (op.v0 + op.v1) / 2;
  const r = hash(info.spec.seed || 7, Math.round(cu * 10), Math.round(op.v0 * 10) + fd.key.length);

  if (op.type === 'shop' || op.type === 'door' || op.type === 'garage') {
    env.shopfront?.(env, info, fd, op, r);
    return;
  }
  if (op.balc) env.balcony?.(env, info, fd, op);
  const inset = S.style === 'panel' ? 0.12 : 0.16;
  // sill
  const sillMat = r < 0.5 ? 'metal_galvanized' : info.trimMat;
  if (!op.balcony) B.box(sillMat, cu, op.v0 - 0.03, 0.04, ow + 0.14, 0.06, 0.16);
  // window surround trim for older styles
  if ((info.spec.style === 'plaster' || info.spec.style === 'brick') && !op.noTrim) {
    const tw = 0.13, tm = info.trimMat;
    B.box(tm, op.u0 - tw / 2, cv, 0.018, tw, oh + 0.02, 0.036, { col: false });
    B.box(tm, op.u1 + tw / 2, cv, 0.018, tw, oh + 0.02, 0.036, { col: false });
    B.box(tm, cu, op.v1 + tw / 2 + 0.005, 0.025, ow + tw * 2 + 0.06, tw + 0.01, 0.05, { col: false });
    if (info.spec.style === 'brick' && r > 0.3) {
      // keystone-ish lintel hood
      B.box(tm, cu, op.v1 + 0.24, 0.05, ow + 0.5, 0.1, 0.1, { col: false });
    }
  }
  // window state
  let state;
  const damaged = info.spec.damageLevel ?? 0.5;
  if (r < 0.08 * (1 + damaged)) state = 'boarded';
  else if (r < 0.12 * (1 + damaged)) state = 'bricked';
  else if (r < 0.45 * (0.6 + damaged)) state = 'broken';
  else if (r < 0.56 * (0.6 + damaged)) state = 'empty';
  else state = 'glass';
  if (op.floor === 0 && r > 0.9) state = 'sandbag';
  if (op.forceState) state = op.forceState;

  const fz = -inset;
  const frameMat = r > 0.6 ? 'metal_painted#white' : S.frame;
  if (state !== 'bricked' && state !== 'empty') {
    const ft = 0.065, fdp = 0.08;
    B.box(frameMat, op.u0 + ft / 2, cv, fz, ft, oh, fdp, { col: false });
    B.box(frameMat, op.u1 - ft / 2, cv, fz, ft, oh, fdp, { col: false });
    B.box(frameMat, cu, op.v1 - ft / 2, fz, ow - ft * 2, ft, fdp, { col: false });
    B.box(frameMat, cu, op.v0 + ft / 2, fz, ow - ft * 2, ft, fdp, { col: false });
    if (ow > 0.95) B.box(frameMat, cu, cv, fz, 0.05, oh - ft * 2, fdp * 0.9, { col: false });
    if (oh > 1.3 && op.type !== 'balcony_door') B.box(frameMat, cu, op.v0 + oh * 0.72, fz, ow - ft * 2, 0.045, fdp * 0.9, { col: false });
  }
  // fake interior (interior-mapped plane) at the inner face of the wall
  if (state !== 'bricked' && state !== 'sandbag_full') {
    env.interiors?.add(B, cu, cv, -t + 0.02, ow, oh, r, fd, info);
  }
  if (op.floor === 0 && !op.onBalcony && (state === 'glass' || state === 'broken' || state === 'empty') && hash(info.spec.seed || 3, Math.round(cu * 7), 11) < 0.6) {
    env.grille?.(env, info, op);
  }
  if (state === 'glass') {
    env.glass?.add(B, cu, cv, fz - 0.01, ow - 0.1, oh - 0.1, r, false);
  } else if (state === 'broken') {
    env.glass?.add(B, cu, cv, fz - 0.01, ow - 0.1, oh - 0.1, r, true);
  } else if (state === 'boarded') {
    // planks nailed across the opening, slightly proud of the wall
    const n = Math.max(3, Math.round(oh / 0.22));
    for (let k = 0; k < n; k++) {
      if (rng.chance(0.18)) continue;
      const vv = op.v0 + (k + 0.5) * (oh / n);
      const tilt = rng.range(-0.06, 0.06);
      B.box('wood_planks', cu, vv, 0.03, ow + 0.3, oh / n - 0.025, 0.025, { rot: [0, 0, tilt], col: false, uv: 'face', uvOff: [rng.range(0, 5), rng.range(0, 5)] });
    }
    B.box('wood_planks', cu - ow * 0.3, cv, 0.055, 0.1, oh + 0.2, 0.025, { col: false });
    B.box('wood_planks', cu + ow * 0.3, cv, 0.055, 0.1, oh + 0.2, 0.025, { col: false });
  } else if (state === 'bricked') {
    B.box('cinder_block', cu, cv, -t * 0.55, ow, oh, t * 0.5, { uvOff: [0.3, 0.1] });
  } else if (state === 'sandbag') {
    env.sandbagWindow?.(env, info, fd, op);
  }
}

function buildRoof(env, info) {
  const { B, rng } = env;
  const { spec, H, t, w, d, S } = info;
  const collapse = (info.damage || []).find((dm) => dm.type === 'collapse');
  const iw = w - 2 * t, id = d - 2 * t;
  // intermediate floor slabs (only a ring near the facade, so interiors are closed off visually)
  const heights = info.heights;
  for (let f = 1; f < heights.length; f++) {
    const v = heights[f][0];
    slabWithCollapse(B, 'concrete_floor', 0, v - 0.1, 0, iw, 0.22, id, collapse, info, v, false);
  }
  if (spec.roof === 'gable') {
    gableRoof(env, info);
  } else {
    // roof slab
    const rk = hash(spec.seed || 5, 77, 3);
    const roofMat = spec.flatRoofMat || (rk < 0.4 ? 'roofing_tar' : rk < 0.7 ? 'gravel' : 'concrete_floor');
    slabWithCollapse(B, roofMat, 0, H - 0.12, 0, iw, 0.24, id, collapse, info, H, true);
    // roof clutter
    if (!spec.noRoofClutter) env.roofClutter?.(env, info);
  }
  void rng; void S;
}

/** Slab (floor or roof) with the collapsed region removed + broken slab edge. */
function slabWithCollapse(B, mat, x, y, z, sw, sh, sd, collapse, info, level, isRoof) {
  if (!collapse || level < collapse.bottom) {
    B.box(mat, x, y, z, sw, sh, sd, { skip: isRoof ? 0 : 0 });
    return;
  }
  // collapse applies on one face, from one end: approximate as removing a portion along that facade's axis
  const dm = collapse;
  const frontBack = dm.face === 'front' || dm.face === 'back';
  const along = frontBack ? sw : sd;
  let cutLen = along * dm.extent * (1 - (level - dm.bottom) / Math.max(1, info.H - dm.bottom) * 0.35);
  cutLen = Math.min(along * 0.95, cutLen);
  // which end in building local coords
  const facadeSign = { front: 1, back: -1, right: -1, left: 1 }[dm.face];
  const endSign = (dm.side === 'start' ? -1 : 1) * facadeSign;
  const keep = along - cutLen;
  if (keep > 0.2) {
    const c = -endSign * (along / 2 - keep / 2);
    if (frontBack) B.box(mat, c, y, z, keep, sh, sd);
    else B.box(mat, x, y, c, sw, sh, keep);
    // broken jagged slab edge (hanging pieces)
    const edge = -endSign * (along / 2 - keep);
    const n = 4;
    for (let k = 0; k < n; k++) {
      const a = (k + 0.5) / n;
      const lenP = 0.6 + (k % 2) * 0.5;
      const tilt = 0.25 + 0.3 * ((k * 7) % 3) / 2;
      if (frontBack) {
        B.box(mat, edge + endSign * lenP * 0.4, y - Math.sin(tilt) * lenP * 0.4, z - sd / 2 + sd * a, lenP, sh * 0.8, sd / n - 0.05, { rot: [0, 0, -endSign * tilt] });
      } else {
        B.box(mat, x - sw / 2 + sw * a, y - Math.sin(tilt) * lenP * 0.4, edge + endSign * lenP * 0.4, sw / n - 0.05, sh * 0.8, lenP, { rot: [endSign * tilt, 0, 0] });
      }
    }
  }
}

function gableRoof(env, info) {
  const { B } = env;
  const { H, w, d, spec } = info;
  const over = 0.45;
  const ridgeAlongX = w >= d;
  const span = ridgeAlongX ? d : w;
  const len = ridgeAlongX ? w : d;
  const rise = span * 0.32;
  const slope = Math.atan2(rise, span / 2);
  const slabLen = Math.hypot(span / 2 + over, rise + over * Math.tan(slope));
  const mat = spec.roofMat || 'roof_tiles';
  // attic gable walls (triangles) on the two ends
  const prof = [[-span / 2, 0], [span / 2, 0], [0, rise]];
  if (ridgeAlongX) {
    // gable walls at x = ±w/2 : profile in (z, y), extruded along x
    const g = new THREE.Matrix4().makeTranslation(0, H, 0);
    B.extrudeX(info.wallMat, prof, -w / 2, info.t, g);
    B.extrudeX(info.wallMat, prof, w / 2 - info.t, info.t, g);
    // attic floor/ceiling
    B.box('concrete_floor', 0, H - 0.1, 0, w - 0.2, 0.2, d - 0.2);
    for (const s of [-1, 1]) {
      const cz = s * (span / 2 + over) / 2;
      const cy = H + (rise - over * Math.tan(slope)) / 2 + 0.05 / Math.cos(slope);
      B.box(mat, 0, cy, cz, len + over * 2, 0.08, slabLen, { rot: [s * slope, 0, 0] });
      // underside/fascia board
      B.box('wood_planks', 0, H - Math.tan(slope) * over + 0.05, s * (span / 2 + over - 0.03), len + over * 2, 0.18, 0.04, { col: false });
    }
    // ridge cap
    B.box('metal_galvanized', 0, H + rise + 0.07, 0, len + over * 2, 0.08, 0.3, { col: false });
  } else {
    const m = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    B.push(m);
    const g = new THREE.Matrix4().makeTranslation(0, H, 0);
    B.extrudeX(info.wallMat, prof, -d / 2, info.t, g);
    B.extrudeX(info.wallMat, prof, d / 2 - info.t, info.t, g);
    B.box('concrete_floor', 0, H - 0.1, 0, d - 0.2, 0.2, w - 0.2);
    for (const s of [-1, 1]) {
      const cz = s * (span / 2 + over) / 2;
      const cy = H + (rise - over * Math.tan(slope)) / 2 + 0.05 / Math.cos(slope);
      B.box(mat, 0, cy, cz, len + over * 2, 0.08, slabLen, { rot: [s * slope, 0, 0] });
      B.box('wood_planks', 0, H - Math.tan(slope) * over + 0.05, s * (span / 2 + over - 0.03), len + over * 2, 0.18, 0.04, { col: false });
    }
    B.box('metal_galvanized', 0, H + rise + 0.07, 0, len + over * 2, 0.08, 0.3, { col: false });
    B.pop();
  }
  // chimneys
  const nC = 1 + ((spec.seed || 0) % 2);
  for (let k = 0; k < nC; k++) {
    const cx = (k === 0 ? -0.25 : 0.3) * (ridgeAlongX ? w : d);
    const ch = rise + 1.0;
    if (ridgeAlongX) B.box('brick_red', cx, H + ch / 2, span * 0.12, 0.6, ch, 0.6);
    else B.box('brick_red', span * 0.12, H + ch / 2, cx, 0.6, ch, 0.6);
  }
}

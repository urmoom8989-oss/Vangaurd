import * as THREE from 'three';

/**
 * Shot presets owned by the PLAYER agent. Names start with "player-".
 *
 * The level is being built concurrently, so presets that need specific geometry (a ledge, a drop,
 * stairs) find a clear, flat lane near the player spawn at setup time and place a small, realistic
 * test structure there (added to world collision through services.world.addCollider). Everything is
 * deterministic: the search order is fixed and the input scripts are frame-indexed.
 *
 * Suggested captures:
 *   node tools/shot.mjs player-sprint      --sequence 8 --interval 100
 *   node tools/shot.mjs player-slide       --sequence 8 --interval 90
 *   node tools/shot.mjs player-mantle      --sequence 8 --interval 90
 *   node tools/shot.mjs player-jump-land   --sequence 8 --interval 80
 *   node tools/shot.mjs player-crouch-prone --sequence 8 --interval 180
 */
const DEG = Math.PI / 180;

// ------------------------------------------------------------------------------------------ helpers
function boxUV(geo, w, h, d) {
  const uv = geo.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * dims[f][0], uv.getY(i) * dims[f][1]);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

/** Axis frame of a lane: origin (feet), yaw, forward & right vectors. */
function laneFrame(origin, yaw) {
  const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const r = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  return {
    origin: origin.clone(), yaw, f, r,
    /** world point at `along` meters forward, `side` meters right, `up` above the lane floor */
    at(along, side = 0, up = 0, out = new THREE.Vector3()) {
      return out.copy(origin).addScaledVector(f, along).addScaledVector(r, side).setY(origin.y + up);
    },
  };
}

/**
 * Deterministic search for a clear, flat, open lane of `length` × `width` m near the spawn.
 * Returns a lane frame (origin at the start, looking along the lane) or a fallback at the spawn.
 */
function findLane(ctx, length, width, { preferYaw = null, maxRing = 10, ringStep = 3.5 } = {}) {
  const world = ctx.services.world;
  const sp = world.spawnPoints?.player?.[0] || { position: new THREE.Vector3(), yaw: 0 };
  const base = sp.position.clone();
  base.y = world.groundHeight(base.x, base.z, base.y + 3);
  const cap = { start: new THREE.Vector3(), end: new THREE.Vector3(), radius: 0.4 };
  const up = new THREE.Vector3(0, 1, 0);
  const o = new THREE.Vector3();
  const yaw0 = preferYaw ?? sp.yaw ?? 0;
  const yaws = [0, 1, -1, 2, -2, 3, -3, 4].map((k) => yaw0 + k * 45 * DEG);

  function clear(start, yaw) {
    const L = laneFrame(start, yaw);
    const g0 = start.y;
    for (let a = 0; a <= length; a += 1.25) {
      for (const s of [-width / 2, 0, width / 2]) {
        L.at(a, s, 0, o);
        const gy = world.groundHeight(o.x, o.z, g0 + 2.5);
        if (Math.abs(gy - g0) > 0.12) return false;
        cap.start.set(o.x, g0 + 0.5, o.z);
        cap.end.set(o.x, g0 + 2.6, o.z);
        const hit = world.collideCapsule(cap);
        if (hit && hit.depth > 0.01) return false;
      }
      // open sky over the centre line (keeps the light readable)
      L.at(a, 0, 2.7, o);
      if (world.raycast(o, up, 5)) return false;
    }
    return true;
  }

  for (let ring = 0; ring <= maxRing; ring++) {
    const n = ring === 0 ? 1 : ring * 6;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const p = base.clone();
      p.x += Math.cos(ang) * ring * ringStep;
      p.z += Math.sin(ang) * ring * ringStep;
      p.y = world.groundHeight(p.x, p.z, base.y + 2.5);
      if (Math.abs(p.y - base.y) > 1.0) continue;
      for (const yaw of yaws) if (clear(p, yaw)) return laneFrame(p, yaw);
    }
  }
  console.warn('[shots:player] no clear lane found; using the spawn');
  return laneFrame(base, sp.yaw || 0);
}

/**
 * Build simple but believable test structures in lane space.
 * Each part: [material, w, h, d, along, side, up, rotY?]; `along`/`side` are the box centre, `up` its base.
 */
function buildStructure(ctx, lane, parts, name) {
  const mats = ctx.services.materials;
  const group = new THREE.Group();
  group.name = name;
  for (const [mat, w, h, d, along, side, upY, rotY = 0, rotX = 0] of parts) {
    const geo = boxUV(new THREE.BoxGeometry(w, h, d), w, h, d);
    const mesh = new THREE.Mesh(geo, mats.get(mat));
    lane.at(along, side, upY + h / 2, mesh.position);
    mesh.rotation.set(rotX, lane.yaw + rotY, 0, 'YXZ');
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.surface = mats.surfaceOf(mat);
    group.add(mesh);
  }
  ctx.scene.add(group);
  group.updateMatrixWorld(true);
  ctx.services.world.addCollider(group);
  return group;
}

/** Concrete loading dock with a steel edge angle and rubber bumper plates (fallback when the level has no ledge). */
function ledgeParts(dist, height) {
  const D = 3.2;
  const c = dist + D / 2;
  return [
    ['concrete_wall', 4.2, height, D, c, 0, 0],
    ['metal_painted', 4.2, 0.06, 0.1, dist + 0.05, 0, height - 0.03], // steel edge angle
    ['metal_rusted', 0.12, 0.28, 0.02, dist - 0.01, -1.3, height - 0.5], // bumper plates
    ['metal_rusted', 0.12, 0.28, 0.02, dist - 0.01, 1.3, height - 0.5],
  ];
}

/** A flight of concrete steps (rise 0.17 m, run 0.3 m) up to a landing, then a ramp back down. */
function stairsParts(start, steps = 7, rise = 0.17, run = 0.3) {
  const parts = [];
  for (let i = 0; i < steps; i++) parts.push(['concrete_floor', 2.4, rise * (i + 1), run, start + run * (i + 0.5), 0, 0]);
  const top = rise * steps;
  const landing = start + run * steps;
  parts.push(['concrete_floor', 2.4, top, 2.2, landing + 1.1, 0, 0]);
  parts.push(['metal_painted', 0.06, 0.9, run * steps + 2.2, landing - run * steps / 2 + 1.1 - 0.02, 1.25, top]);
  // ramp down on the far side (≈ 17°)
  const len = top / Math.sin(17 * Math.PI / 180);
  const hor = top / Math.tan(17 * Math.PI / 180);
  parts.push(['concrete_floor', 2.4, 0.2, len, landing + 2.2 + hor / 2, 0, top / 2 - 0.1 - 0.06, 0, -17 * Math.PI / 180]);
  return parts;
}

/**
 * Deterministic search for a REAL ledge in the level (car roof, wall, sandbag line...) that the motor
 * can mantle (vault=false) or vault (vault=true), with a clear, flat run-up of `runup` meters.
 * Returns {start (feet), yaw, height, vault} where `start` is placed so that the wall is exactly
 * `contact + runup` meters ahead (→ the frame at which the ledge comes into reach is independent of
 * where the ledge is), or null.
 */
function findLedge(ctx, { vault = false, minH = 1.0, maxH = 1.8, runup = 2.4, contact = 0.95, maxR = 42, avoid = null, maxCands = 48 } = {}) {
  const cands = [];
  const world = ctx.services.world;
  const player = ctx.services.player;
  if (!player.probeMantle) return null;
  const sp = world.spawnPoints?.player?.[0] || { position: new THREE.Vector3() };
  const base = sp.position;
  const cap = { start: new THREE.Vector3(), end: new THREE.Vector3(), radius: 0.42 };
  const o = new THREE.Vector3();
  const f = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  function free(x, y, z) {
    cap.start.set(x, y + 0.47, z);
    cap.end.set(x, y + 1.4, z);
    const c = world.collideCapsule(cap);
    return !c || !(c.depth > 0.01);
  }
  for (let r = 0; r <= maxR; r += 1.5) {
    const n = Math.max(1, Math.round((r * 2 * Math.PI) / 1.5));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = base.x + Math.cos(a) * r, z = base.z + Math.sin(a) * r;
      const y = world.groundHeight(x, z, base.y + 3);
      if (Math.abs(y - base.y) > 1.2 || !free(x, y, z)) continue;
      for (let k = 0; k < 16; k++) {
        const yaw = (k * Math.PI) / 8;
        f.set(-Math.sin(yaw), 0, -Math.cos(yaw));
        o.set(x, y + 0.7, z);
        const h0 = world.raycast(o, f, 1.4);
        if (!h0 || Math.abs(h0.normal.y) > 0.3 || -(h0.normal.x * f.x + h0.normal.z * f.z) < 0.9) continue; // face-on only
        const m = player.probeMantle(o.set(x, y, z), yaw);
        if (!m || m.vault !== vault || m.height < minH || m.height > maxH || m.stance !== 'stand') continue;
        // start so the wall is (contact + runup) ahead; the run-up must be flat, free and open to the sky
        const back = contact + runup - m.wallDist;
        const sx = x - f.x * back, sz = z - f.z * back;
        if (avoid && Math.hypot(sx - avoid.x, sz - avoid.z) < 6) continue;
        let ok = true;
        for (let s = 0; s <= back + 1e-6 && ok; s += 0.5) {
          const px = sx + f.x * s, pz = sz + f.z * s;
          const gy = world.groundHeight(px, pz, y + 1.5);
          if (Math.abs(gy - y) > 0.06 || !free(px, y, pz)) ok = false;
        }
        if (!ok) continue;
        o.set(sx, y + 2.2, sz);
        if (world.raycast(o, up, 6)) continue; // keep it outdoors (readable light)
        const cand = { start: new THREE.Vector3(sx, y, sz), yaw, height: m.height, vault: m.vault, surface: h0.surface, score: 0 };
        cand.score = scoreLedge(x, y, z, f, m, r);
        cands.push(cand);
        if (cands.length >= maxCands) return pickBest();
      }
    }
  }
  return pickBest();

  function pickBest() {
    findLedge.last = cands;
    let best = null;
    for (const c of cands) if (!best || c.score > best.score + 1e-6) best = c;
    return best;
  }

  /**
   * Readability score of a ledge for a first-person capture: a sunlit lip, a sunlit approach, a WIDE
   * obstacle (a wall / barrier, not a post or a car corner) and an open view over the top (the payoff
   * of the climb). Pure queries, fixed order → deterministic.
   */
  function scoreLedge(x, y, z, fw, m, r) {
    let s = -r * 0.03;
    const sun = ctx.services.lighting?.getSunDirection?.(sunDir);
    const lipX = x + fw.x * (m.wallDist + 0.3), lipZ = z + fw.z * (m.wallDist + 0.3), lipY = y + m.height;
    if (sun && sun.y > 0.02) {
      o.set(lipX, lipY + 0.08, lipZ);
      if (!world.raycast(o, sun, 120)) s += 3;
      o.set(x - fw.x * 1.5, y + 1.2, z - fw.z * 1.5);
      if (!world.raycast(o, sun, 120)) s += 1.5;
    }
    // width: the same lip 0.7 m to either side
    side.set(-fw.z, 0, fw.x);
    let wide = 0;
    for (const k of [-0.7, 0.7]) {
      const q = probeTmp.set(x + side.x * k, y, z + side.z * k);
      const mm = player.probeMantle(q, Math.atan2(-fw.x, -fw.z));
      if (mm && Math.abs(mm.height - m.height) < 0.12) wide++;
    }
    s += wide * 1.2;
    // view over the top from the standing eye on the ledge
    o.set(lipX + fw.x * 0.5, lipY + 1.6, lipZ + fw.z * 0.5);
    const v = world.raycast(o, fw, 40);
    s += v ? Math.min(v.distance, 30) / 10 : 3;
    return s;
  }
}
const sunDir = new THREE.Vector3();
const side = new THREE.Vector3();
const probeTmp = new THREE.Vector3();

/** onFrame helper: tap jump once the motor sees a mantleable ledge within  (state object per preset). */
const mantleJump = { phase: 0, frame: 0 };
const vaultJump = { phase: 0, frame: 0 };
const damageShot = { src: null };

function autoJumpAtLedge(ctx, js, dist = 0.95) {
  const p = ctx.services.player;
  const st = p.state;
  const input = ctx.input;
  if (js.phase === 1) { input.inject('jump', false); js.phase = 2; return; }
  if (js.phase || !st.grounded || st.mantling) return;
  const m = p.probeMantle(st.position, st.yaw);
  if (m && m.wallDist <= dist) { input.inject('jump', true); js.phase = 1; js.frame = ctx.time.frame; }
}

function setPlayer(ctx, lane, along = 0, up = 0, pitchDeg = 0, stance = 'stand') {
  const p = lane.at(along, 0, up);
  const player = ctx.services.player;
  player.setStance?.(stance);
  player.teleport(p, lane.yaw, pitchDeg * DEG);
}

// ------------------------------------------------------------------------------------------ presets
export default {
  'player-sprint': {
    description: 'Double-tap tac-sprint down a clear lane (gait bob, FOV kick). Use --sequence 8 --interval 100.',
    player: { position: [0, null, 12], yaw: 0, pitch: 0 },
    async setup(ctx) {
      const lane = findLane(ctx, 26, 3);
      setPlayer(ctx, lane, 0, 0, -1);
    },
    input: [
      { frame: 0, move: [0, 1] },
      { frame: 2, tap: 'sprint' },
      { frame: 10, tap: 'sprint' }, // second tap within the window → tactical sprint
    ],
    warmup: 52,
  },

  'player-slide': {
    description: 'Sprint then slide (momentum, low camera, roll). Capture mid-slide; --sequence 8 --interval 90.',
    player: { position: [0, null, 12], yaw: 0, pitch: 0 },
    async setup(ctx) {
      const lane = findLane(ctx, 22, 3);
      setPlayer(ctx, lane, 0, 0, -2);
    },
    input: [
      { frame: 0, move: [0, 1] },
      { frame: 1, tap: 'sprint' },
      { frame: 50, tap: 'crouch' },
    ],
    warmup: 62,
  },

  'player-mantle': {
    description: 'Walk up to a real chest-high ledge in the level (fallback: a concrete dock) and mantle onto it. Capture mid-climb; --sequence 8 --interval 90.',
    player: { position: [0, null, 12], yaw: 0, pitch: 0 },
    async setup(ctx) {
      mantleJump.phase = 0;
      const L = findLedge(ctx, { vault: false, minH: 1.15, maxH: 1.75, runup: 2.2, maxR: 75, maxCands: 400 });
      // only a real ledge that reads (sunlit lip + open view); otherwise the clean dock in an open lane
      if (L && L.score >= 6) {
        ctx.services.player.teleport(L.start, L.yaw, -7 * DEG);
      } else {
        const lane = findLane(ctx, 9, 4.5);
        buildStructure(ctx, lane, ledgeParts(3.15, 1.45), 'player-shot-dock');
        setPlayer(ctx, lane, 0, 0, -7);
      }
    },
    input: [{ frame: 0, move: [0, 1] }],
    onFrame(ctx) { autoJumpAtLedge(ctx, mantleJump, 0.95); },
    warmup: 58,
  },

  'player-vault': {
    description: 'Sprint into a real waist-high obstacle (sandbags / low wall) and vault it. --sequence 8 --interval 70.',
    player: { position: [0, null, 12], yaw: 0, pitch: 0 },
    async setup(ctx) {
      vaultJump.phase = 0;
      const L = findLedge(ctx, { vault: true, minH: 0.7, maxH: 1.15, runup: 4.5, contact: 1.05, maxR: 75, maxCands: 400 });
      if (L) {
        ctx.services.player.teleport(L.start, L.yaw, -6 * DEG);
      } else {
        const lane = findLane(ctx, 12, 4.5);
        buildStructure(ctx, lane, [
          ['concrete_wall', 3.6, 0.95, 0.35, 6.2, 0, 0],
          ['concrete_wall', 3.8, 0.08, 0.45, 6.2, 0, 0.95],
        ], 'player-shot-lowwall');
        setPlayer(ctx, lane, 0, 0, -6);
      }
    },
    input: [
      { frame: 0, move: [0, 1] },
      { frame: 1, tap: 'sprint' },
    ],
    onFrame(ctx) { autoJumpAtLedge(ctx, vaultJump, 1.05); },
    warmup: 60,
  },

  'player-jump-land': {
    description: 'Jump off a 3 m dock; capture mid-air, sequence covers touchdown + landing dip. --sequence 8 --interval 100.',
    player: { position: [0, null, 12], yaw: 0, pitch: 0 },
    async setup(ctx) {
      const lane = findLane(ctx, 16, 4.5);
      // dock behind the start: the player starts on top, at its front edge
      buildStructure(ctx, lane, [
        ['concrete_wall', 4.2, 3.0, 4.0, 1.5, 0, 0],
        ['metal_painted', 4.2, 0.06, 0.1, 3.45, 0, 2.97],
      ], 'player-shot-drop');
      setPlayer(ctx, lane, 0.2, 3.0, -8);
    },
    // Walk-jump (not sprint) so the weapon stays framed; the capture frame is mid-air over the drop and
    // a --sequence 8 --interval 100 run covers the descent, the touchdown (~seq frame 4) and the dip.
    input: [
      { frame: 0, move: [0, 1] },
      { frame: 34, tap: 'jump' },
    ],
    warmup: 66,
  },

  'player-crouch-prone': {
    description: 'Stand → crouch → prone transitions (eye-height spring). --sequence 8 --interval 100.',
    player: { position: [0, null, 12], yaw: 0, pitch: 0 },
    async setup(ctx) {
      const lane = findLane(ctx, 8, 3);
      setPlayer(ctx, lane, 0, 0, -2);
    },
    // Capture frame = standing; a --sequence 8 --interval 100 run shows stand → crouch (seq 1–2) →
    // drop to prone (seq 3–7) with the eye-height spring and the prone roll / dip.
    input: [
      { frame: 11, tap: 'crouch' },
      { frame: 30, tap: 'prone' },
    ],
    warmup: 10,
  },

  'player-stairs': {
    description: 'Walk up a flight of steps and down a ramp (step-up + camera smoothing). --sequence 8 --interval 250.',
    player: { position: [0, null, 12], yaw: 0, pitch: 0 },
    async setup(ctx) {
      const lane = findLane(ctx, 12, 3);
      buildStructure(ctx, lane, stairsParts(1.5), 'player-shot-stairs');
      setPlayer(ctx, lane, 0, 0, -12);
    },
    input: [{ frame: 0, move: [0, 1] }],
    warmup: 40,
  },

  'player-damage': {
    description: 'Taking fire from the right: two hits (flinch towards the source, damage pulse, HUD indicator), capture on the second hit at low health. --sequence 8 --interval 100 shows the flinch settle.',
    player: { position: [0, null, 12], yaw: 0, pitch: 0 },
    async setup(ctx) {
      const lane = findLane(ctx, 10, 3);
      setPlayer(ctx, lane, 0, 0, -2);
      damageShot.src = lane.at(6, 9, 1.5);
    },
    input: [{ frame: 0, move: [0, 0.6] }],
    onFrame(ctx, i) {
      const p = ctx.services.player;
      if (i === 30 || i === 44) p.damage(i === 30 ? 38 : 34, { type: 'bullet', source: 'shot', position: damageShot.src });
    },
    warmup: 46,
  },

  'player-lean': {
    description: 'Hold lean-right while walking (camera offset + roll, wall-probed). --sequence 8 --interval 100.',
    player: { position: [0, null, 12], yaw: 0, pitch: 0 },
    async setup(ctx) {
      const lane = findLane(ctx, 10, 3);
      setPlayer(ctx, lane, 0, 0, -2);
    },
    input: [
      { frame: 0, move: [0, 0.5] },
      { frame: 20, press: 'leanRight' },
    ],
    warmup: 40,
  },

  'player-crouch-walk': {
    description: 'Crouched walk forward; use --sequence to judge view bob / stance transitions.',
    player: { position: [0, null, 12], yaw: 0, pitch: 0, stance: 'crouch' },
    input: [{ frame: 0, move: [0, 1] }],
    warmup: 20,
  },
};

export { findLane, buildStructure, laneFrame, findLedge };

// Release 1.0 anti-cheat: line of sight on the server.
// los-maps.json holds, for every map, the walls as 0.5 m voxels (floors, roofs and the ground are left out). It is
// made from the game's own collision geometry by tools_los_export.mjs. A hit whose shooter could not have seen the
// target from anywhere near where the server last saw them (eye height, or leaning either side, to the target's
// head, chest or hips) is a "no line of sight" hit. Bullets do go through thin walls in the game, so one of these
// proves nothing; a player who lands many of them gets reported to the moderators automatically.
import fs from 'node:fs';
import zlib from 'node:zlib';

export function loadLos(file) {
  const maps = new Map();
  let error = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [id, m] of Object.entries(j.maps || {})) {
      const bits = zlib.gunzipSync(Buffer.from(m.bits, 'base64'));
      if (bits.length * 8 < m.dims[0] * m.dims[1] * m.dims[2]) continue;
      maps.set(id, { min: m.min, res: m.res, dims: m.dims, bits });
    }
  } catch (e) {
    error = e.message;
  }
  function solid(M, x, y, z) {
    const [nx, ny, nz] = M.dims, i = Math.floor((x - M.min[0]) / M.res), j = Math.floor((y - M.min[1]) / M.res), k = Math.floor((z - M.min[2]) / M.res);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return false;
    const n = (j * nz + k) * nx + i;
    return (M.bits[n >> 3] & (1 << (n & 7))) !== 0;
  }
  // Is the straight line from a to b blocked by a wall? Walls within `skip` metres of either end don't count (the
  // shooter or the target may be leaning out from behind them, and positions are a tenth of a second old).
  function blocked(id, a, b, skip = 1.3) {
    const M = maps.get(id);
    if (!M) return null;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, L = Math.hypot(dx, dy, dz);
    if (!(L > skip * 2 + 0.5)) return false;
    const step = M.res * 0.5, n = Math.ceil(L / step);
    let run = 0;
    for (let s = 1; s < n; s++) {
      const d = (s / n) * L;
      if (d < skip || L - d < skip) { run = 0; continue; }
      const t = s / n;
      if (solid(M, a.x + dx * t, a.y + dy * t, a.z + dz * t)) { if (++run >= 2) return true; } else run = 0;
    }
    return false;
  }
  const EYE = { prone: 0.4, crouch: 1.1, slide: 1.0, stand: 1.62 };
  const BODY = { prone: [0.25, 0.4], crouch: [0.55, 0.9, 1.15], slide: [0.5, 0.9], stand: [0.75, 1.2, 1.62] };
  // Could the shooter (at sp, looking along yaw) see any part of the target (at tp)? null when the map isn't known.
  function canSee(id, sp, sStance, yaw, tp, tStance) {
    if (!maps.has(id) || !sp || !tp) return null;
    const ey = EYE[sStance] ?? EYE.stand, rx = Math.cos(yaw || 0), rz = -Math.sin(yaw || 0);
    const eyes = [0, 0.5, -0.5].map((o) => ({ x: sp.x + rx * o, y: sp.y + ey, z: sp.z + rz * o }));
    const parts = (BODY[tStance] || BODY.stand).map((h) => ({ x: tp.x, y: tp.y + h, z: tp.z }));
    for (const e of eyes) for (const p of parts) if (!blocked(id, e, p)) return true;
    return false;
  }
  // a top-down picture of the walls at about chest height (for the console's replay viewer)
  function plan(id) {
    const M = maps.get(id);
    if (!M) return null;
    const [nx, ny, nz] = M.dims, out = Buffer.alloc(nx * nz);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      let c = 0;
      for (const h of [0.6, 1.2, 1.8]) {
        const j = Math.floor((h - M.min[1] + 0) / M.res);
        // the ground is not at the same height everywhere: look a few cells up from the map's floor
        for (let jj = Math.max(0, j - 2); jj <= Math.min(ny - 1, j + 2); jj++) {
          const n = (jj * nz + k) * nx + i;
          if (M.bits[n >> 3] & (1 << (n & 7))) { c++; break; }
        }
      }
      out[k * nx + i] = c;
    }
    return { min: M.min, res: M.res, w: nx, h: nz, cells: out.toString('base64') };
  }
  return { maps, error, has: (id) => maps.has(id), blocked, canSee, plan };
}

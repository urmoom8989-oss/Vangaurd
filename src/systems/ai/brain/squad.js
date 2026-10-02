import * as THREE from 'three';

/**
 * Squad blackboard: shared target knowledge, bounding-overwatch movement tokens, flank / suppress
 * role assignment and grenade cooldown. Members are Agents.
 */
export class Squad {
  constructor(id) {
    this.id = id;
    this.members = [];
    this.knowPos = new THREE.Vector3();
    this.knowT = -1e9; // last time anyone had fresh info on the target
    this.seenT = -1e9; // last time anyone actually SAW the target
    this.alerted = false;
    this.grenadeT = -1e9;
    this.flanker = null;
    this.suppressor = null;
    this.intelT = 0;
    this._c = new THREE.Vector3();
  }

  add(a) { if (!this.members.includes(a)) this.members.push(a); a.squad = this; }
  remove(a) {
    const i = this.members.indexOf(a);
    if (i >= 0) this.members.splice(i, 1);
    if (this.flanker === a) this.flanker = null;
    if (this.suppressor === a) this.suppressor = null;
  }
  get alive() { let n = 0; for (const m of this.members) if (m.alive) n++; return n; }

  /** Share target knowledge. seen = direct visual (vs heard/estimated). */
  report(pos, t, seen) {
    if (t >= this.knowT) { this.knowPos.copy(pos); this.knowT = t; }
    if (seen) this.seenT = Math.max(this.seenT, t);
  }

  centroid(out = this._c) {
    out.set(0, 0, 0);
    let n = 0;
    for (const m of this.members) if (m.alive) { out.add(m.position); n++; }
    return n ? out.divideScalar(n) : out;
  }

  /** How many members are currently relocating between covers. */
  moving() {
    let n = 0;
    for (const m of this.members) if (m.alive && m.relocating) n++;
    return n;
  }

  /** Bounding overwatch: at most half of the squad (min 1) relocates while the rest cover them. */
  mayMove(agent) {
    if (agent.relocating) return true;
    const alive = this.alive;
    return this.moving() < Math.max(1, Math.ceil(alive / 2));
  }

  assignRoles(rng) {
    const alive = this.members.filter((m) => m.alive);
    if (!this.flanker?.alive) this.flanker = null;
    if (!this.suppressor?.alive) this.suppressor = null;
    if (alive.length >= 3 && !this.flanker) {
      // prefer an agent spawned with the flank role, else the smg/shotgun, else random
      this.flanker = alive.find((m) => m.role === 'flank') || alive.find((m) => m.loadoutName === 'smg') || alive[Math.floor(rng.next() * alive.length)];
    }
    if (alive.length >= 2 && !this.suppressor) {
      this.suppressor = alive.find((m) => m.loadoutName === 'lmg' && m !== this.flanker) || alive.find((m) => m !== this.flanker) || null;
    }
  }
}

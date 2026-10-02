import * as THREE from 'three';
import { CFG, LOADOUTS } from './config.js';
import { B } from '../character/rig.js';
import { Pose } from '../character/body.js';
import { WEAPON } from '../character/soldier.js';
import { Animator } from '../anim/animator.js';
import { Ragdoll } from '../anim/ragdoll.js';
import { wrapAngle, clamp, lerp, smoothstep } from '../anim/ik.js';

/**
 * One Crimson Vanguard contractor.
 *
 * Contract fields: id, object, position (feet), alive, state, team.
 * Extras: key ('ai:<id>'), name, loadoutName, weaponId, health, maxHealth, squad, role, velocity.
 *
 * Brain layers (all deterministic, driven by ctx.time):
 *   perceive()  vision cone + LOS with an awareness meter, shared squad knowledge, hearing (via system events)
 *   think()     mode (relaxed / alert / combat) and tactical state machine:
 *               patrol | investigate | advance | moveCover | cover(hide/peek/fire) | standFire | rush | search
 *   act()       path following + collision, stance, body/aim yaw with turn-rate limit, human aim error,
 *               burst fire, reloads, grenade throws
 *   animate()   procedural animator -> skinned pose, hitboxes, muzzle anchors; ragdoll when dead
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _aimPt = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fireOpts = {
  origin: new THREE.Vector3(), direction: new THREE.Vector3(), range: 400, damage: 20, source: '', weaponId: '',
  spread: 0, muzzle: new THREE.Vector3(), team: 'enemy', pellets: 1,
};
const _flashParams = { weaponId: 'ai_rifle', object: null };
const _fireEvt = { source: '', weaponId: '' };
const _stepEvt = { surface: 'concrete', position: new THREE.Vector3(), speed: 0, stance: 'stand', agent: null };
const _alertEvt = { agent: null, target: 'player', position: new THREE.Vector3() };
const _scratch = [];

const TAC_FIRE = new Set(['standFire', 'rush', 'advance', 'moveCover', 'cover', 'search']);

function yawTo(from, to) { return Math.atan2(to.x - from.x, to.z - from.z); }
function approachAngle(a, b, maxStep) {
  const d = wrapAngle(b - a);
  return a + clamp(d, -maxStep, maxStep);
}
/** smooth pseudo-noise in [-1, 1] */
function wobble(t, p) { return 0.55 * Math.sin(t * 1.37 + p) + 0.3 * Math.sin(t * 2.91 + p * 1.7) + 0.15 * Math.sin(t * 5.3 + p * 2.3); }

export class Agent {
  constructor(sys, id, body) {
    this.sys = sys;
    this.ctx = sys.ctx;
    this.id = id;
    this.key = `ai:${id}`;
    this.name = `Vanguard ${id}`;
    this.team = 'enemy';
    this.targetAgent = null;
    this.targetIsPlayer = false;
    this.body = body;
    this.object = body.group;
    this.object.userData.agent = this;
    this.object.userData.muzzle = body.muzzle;
    this.object.userData.ejection = body.eject;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.prevPos = new THREE.Vector3();
    this.alive = false;
    this.active = false;
    this.state = 'idle';
    this.anim = new Animator(body, id * 1.618);
    this.anim.groundY = (x, z, y) => sys.wq.groundFast(x, z, y);
    this.anim.onFootstep = (foot, speed) => this.footstep(foot, speed);
    this.prevPose = new Pose();
    this.ragdoll = new Ragdoll();
    this.damageable = null;

    // movement
    this.goal = new THREE.Vector3();
    this.hasGoal = false;
    this.path = null;
    this.pathI = 0;
    this.repath = false;
    this.moveSpeed = 0;
    this.stuckT = 0;
    this.stuckRef = new THREE.Vector3();
    this.stuckCount = 0;
    this.relocating = false;

    // posture / aim
    this.bodyYaw = 0;
    this.aimYaw = 0;
    this.aimPitch = 0;
    this.crouch = 0;
    this.lean = 0;
    this.weaponMode = 'patrol';
    this.lookPos = new THREE.Vector3();
    this.hasLook = false;

    // knowledge
    this.mode = 'relaxed';
    this.tac = 'idle';
    this.awareness = 0;
    this.tgtVisible = false;
    this.visTime = 0;
    this.knowPos = new THREE.Vector3();
    this.knowT = -1e9;
    this.seenT = -1e9;
    this.reactT = 0;
    this.heardPos = new THREE.Vector3();
    this.heardT = -1e9;
    this.suppression = 0;
    this.lastDamageT = -1e9;

    // cover
    this.cover = null;
    this.peek = null;
    this.phase = 'hide';
    this.phaseT = 0;
    this.coverSince = 0;
    this.coverCheckT = 0;
    this.strafeT = 0;

    // weapon
    this.ammo = 30;
    this.burstLeft = 0;
    this.nextShotT = 0;
    this.pauseUntil = 0;
    this.reloadEndT = -1;
    this.grenades = 1;
    this.fireMode = 'none';
    this.lastShotT = -1e9;
    this.shots = 0;

    // timers
    this.perceiveAt = 0;
    this.thinkAt = 0;
    this.deathT = 0;
    this.lodFrame = 0;
    this.animDt = 0;
    this.puppet = null;
    this.phase0 = 0;
  }

  // ------------------------------------------------------------------ lifecycle
  spawn({ position, yaw = 0, loadout = 'rifle', behavior = {}, team = 'enemy', t = 0 }) {
    const S = this.sys;
    this.rng = this.ctx.rng.fork(`ai-agent-${this.id}`);
    this.active = true;
    this.alive = true;
    this.state = 'idle';
    this.team = team;
    this.targetAgent = null;
    this.targetIsPlayer = false;
    this.loadoutName = LOADOUTS[loadout] ? loadout : 'rifle';
    this.loadout = LOADOUTS[this.loadoutName];
    this.weaponId = this.loadout.weaponId;
    this.behavior = behavior || {};
    this.role = this.behavior.role || (this.loadoutName === 'shotgun' ? 'rush' : 'assault');
    this.accuracy = clamp(this.behavior.accuracy ?? 0.8, 0.2, 1.5);
    this.aggression = clamp(this.behavior.aggression ?? 0.6, 0.05, 1.3);
    this.objective = this.behavior.objective ? new THREE.Vector3().copy(this.behavior.objective) : null;
    this.maxHealth = this.behavior.health ?? CFG.health;
    this.health = this.maxHealth;
    this.position.copy(position);
    this.position.y = S.wq.ground(position.x, position.z, position.y + 1.5, position.y);
    this.prevPos.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.bodyYaw = this.aimYaw = yaw;
    this.aimPitch = 0;
    this.crouch = 0;
    this.lean = 0;
    this.weaponMode = 'patrol';
    this.mode = 'relaxed';
    this.tac = 'idle';
    this.awareness = 0;
    this.tgtVisible = false;
    this.visTime = 0;
    this.knowT = this.seenT = this.heardT = this.lastDamageT = -1e9;
    this.suppression = 0;
    this.cover = null; this.peek = null;
    this.hasGoal = false; this.path = null; this.relocating = false;
    this.ammo = this.loadout.mag;
    this.burstLeft = 0; this.pauseUntil = 0; this.nextShotT = 0; this.reloadEndT = -1;
    this.grenades = this.loadout.grenades;
    this.fireMode = 'none';
    this.shots = 0;
    this.phase0 = this.rng.next() * 100;
    this.perceiveAt = t + this.rng.next() * CFG.perceiveEvery;
    this.thinkAt = t + this.rng.next() * CFG.thinkEvery;
    this.patrolT = t + 1 + this.rng.next() * 3;
    this.hasLook = false;
    this.puppet = null;
    this.ragdoll.active = false;
    this.body.mesh.visible = true;
    this.body.mesh.position.set(0, 0, 0);
    this.sinkOffset = 0; this.sinkT = 0;
    this.body.group.visible = true;
    this.body.group.position.copy(this.position);
    this.name = this.behavior.name || `Vanguard ${this.id}`;

    const I = this.anim.in;
    I.pos.copy(this.position); I.vel.set(0, 0, 0);
    I.bodyYaw = yaw; I.aimYaw = yaw; I.aimPitch = 0; I.crouch = 0; I.weapon = 'patrol'; I.lean = 0; I.headYaw = null;
    this.anim.initialized = false;
    this.anim.reloadT = -1; this.anim.throwT = -1;
    // warm the pose so hitboxes/ragdoll start valid
    this.anim.update(1 / 60, t);
    this.prevPose.copy(this.body.pose);
    this.syncBody();

    this.damageable = this.ctx.services.combat.registerDamageable({
      object: this.object,
      health: this.health,
      maxHealth: this.maxHealth,
      team: this.team,
      name: this.name,
      key: this.key,
      hitboxes: this.body.hitboxes,
      onDamage: (amt, info) => this.onDamage(amt, info),
      onDeath: (info) => this.onDeath(info),
    });
  }

  despawn() {
    this.releaseCover();
    this.squad?.remove(this);
    this.squad = null;
    if (this.damageable) { try { this.damageable.unregister(); } catch { /* ignore */ } this.damageable = null; }
    this.active = false;
    this.alive = false;
    this.state = 'removed';
    this.body.group.visible = false;
    this.body.group.removeFromParent();
  }

  // ------------------------------------------------------------------ helpers
  eye(out) {
    const p = this.body.pose.p[B.head];
    return out.set(p.x, p.y + 0.075, p.z);
  }
  chest(out) {
    const p = this.body.pose.p[B.chest];
    return out.set(p.x, p.y + 0.08, p.z);
  }
  get playerState() { return this.ctx.services.player.state; }
  /** point on the player to aim at (upper chest / head, stance aware) */
  playerAimPoint(out) {
    const ps = this.playerState;
    const e = ps.eye || ps.position;
    out.copy(e);
    out.y -= ps.stance === 'prone' ? 0.1 : 0.32;
    return out;
  }

  setMove(goal, speed) {
    if (!goal) { this.hasGoal = false; this.moveSpeed = 0; return; }
    if (!this.hasGoal || goal.distanceToSquared(this.goal) > 0.3) {
      this.goal.copy(goal);
      this.hasGoal = true;
      this.repath = true;
      this.stuckT = 0; this.stuckCount = 0;
      this.stuckRef.copy(this.position);
    }
    this.moveSpeed = speed;
  }
  stop() { this.hasGoal = false; this.moveSpeed = 0; }
  get arrived() { return !this.hasGoal; }

  releaseCover() {
    if (this.cover) this.sys.cover.release(this.cover, this);
    this.cover = null; this.peek = null;
  }

  know(pos, t, seen) {
    this.knowPos.copy(pos);
    this.knowT = t;
    if (seen) this.seenT = t;
    this.squad?.report(pos, t, seen);
  }

  enterCombat(t, why) {
    if (this.mode === 'combat') return;
    const first = this.mode !== 'combat';
    this.mode = 'combat';
    this.state = 'combat';
    this.awareness = 1;
    this.tac = 'engage';
    this.thinkAt = Math.min(this.thinkAt, t + 0.05);
    this.reactT = Math.max(this.reactT, t + lerp(CFG.reaction[0], CFG.reaction[1], this.rng.next()) * (why === 'damage' ? 0.6 : 1));
    if (first && this.squad && !this.squad.alerted) {
      this.squad.alerted = true;
      _alertEvt.agent = this; _alertEvt.position.copy(this.knowPos);
      this.ctx.events.emit('ai:alert', _alertEvt);
      // wake the squad
      for (const m of this.squad.members) if (m !== this && m.alive && m.mode !== 'combat') {
        m.knowPos.copy(this.knowPos); m.knowT = t;
        m.reactT = t + 0.4 + m.rng.next() * 0.5;
        m.enterCombat(t, 'squad');
      }
    }
  }

  // ------------------------------------------------------------------ perception
  perceive(t) {
    const dtp = CFG.perceiveEvery;
    const ps = this.playerState;
    this.suppression = Math.max(0, this.suppression - dtp * 0.35);
    if (this.behavior.target === 'match') { this.perceiveMatch(t, dtp); return; }
    if (!ps.alive || !ps.eye) { this.tgtVisible = false; this.visTime = 0; return; }
    this.eye(_eye);
    const pe = ps.eye;
    _dir.subVectors(pe, _eye);
    const d = _dir.length();
    let fov = 0;
    if (d < CFG.sightRange) {
      _dir.divideScalar(d);
      // head facing = aim yaw (the head follows aim / look)
      const facing = this.hasLook && this.mode !== 'combat' ? yawTo(this.position, this.lookPos) : this.aimYaw;
      const ang = Math.abs(wrapAngle(Math.atan2(_dir.x, _dir.z) - facing));
      if (ang < CFG.fovFocus) fov = 1;
      else if (ang < CFG.fovPeriph) fov = 0.3;
      else if (d < 3.5) fov = 0.25; // "feel" someone right behind you
      if (this.mode === 'combat' && fov < 0.6) fov = Math.max(fov, 0.6); // alert soldiers scan
    }
    let visible = false;
    if (fov > 0) {
      visible = this.sys.wq.los(_eye, pe);
      if (!visible) { this.playerAimPoint(_tgt); _tgt.y -= 0.35; visible = this.sys.wq.los(_eye, _tgt); }
    }
    if (visible) {
      const stance = ps.stance === 'prone' ? 0.35 : ps.stance === 'crouch' ? 0.65 : 1;
      const moveK = (ps.speed || 0) > 1 ? 1.35 : 1;
      const fireK = t - (this.sys.playerFiredT ?? -1e9) < 1.0 ? 3 : 1;
      const distK = d < 8 ? 4 : d < 20 ? 1.8 : d < 40 ? 1.0 : 0.55;
      const rate = this.mode === 'combat' ? 10 : fov * distK * stance * moveK * fireK * (this.mode === 'alert' ? 1.6 : 1);
      this.awareness = Math.min(1.2, this.awareness + rate * dtp);
      if (this.awareness >= 1) {
        if (!this.tgtVisible) this.visTime = 0;
        this.tgtVisible = true;
        this.visTime += dtp;
        this.know(ps.position, t, true);
        if (this.mode !== 'combat') this.enterCombat(t, 'sight');
      } else if (this.awareness > 0.35 && this.mode === 'relaxed') {
        // something moved over there
        this.mode = 'alert';
        this.heardPos.copy(ps.position); this.heardT = t;
      }
    } else {
      this.tgtVisible = false;
      this.visTime = 0;
      if (this.mode !== 'combat') this.awareness = Math.max(0, this.awareness - dtp * 0.25);
    }
    // squad knowledge
    const sq = this.squad;
    if (sq && sq.knowT > this.knowT + 0.05) {
      this.knowPos.copy(sq.knowPos); this.knowT = sq.knowT;
      if (this.mode !== 'combat' && t - sq.knowT < 3 && sq.alerted) this.enterCombat(t, 'squad');
    }
  }

  perceiveMatch(t, dtp) {
    const ps = this.playerState;
    const gm = this.ctx.services.gamemode.state;
    const agents = this.sys.agents;
    let best = Infinity;
    let target = null;
    let playerTarget = false;
    let targetPos = null;
    let targetEye = null;
    if (ps.alive && ps.eye && this.team !== gm.playerTeam) {
      best = this.position.distanceTo(ps.position);
      if (best < CFG.sightRange) { playerTarget = true; targetPos = ps.position; targetEye = ps.eye; }
    }
    for (const other of agents) {
      if (!other || other === this || !other.alive || !other.active || other.team === this.team) continue;
      const d = this.position.distanceTo(other.position);
      if (d >= best || d > CFG.sightRange) continue;
      best = d;
      target = other;
      playerTarget = false;
      targetPos = other.position;
    }
    if (!targetPos) {
      this.targetAgent = null;
      this.targetIsPlayer = false;
      this.tgtVisible = false;
      this.visTime = 0;
      if (this.mode === 'combat' && t - this.knowT > 3) { this.mode = 'relaxed'; this.state = 'idle'; this.tac = 'idle'; this.releaseCover(); }
      return;
    }
    this.targetAgent = target;
    this.targetIsPlayer = playerTarget;
    this.knowPos.copy(targetPos);
    this.knowT = t;
    this.awareness = 1;
    if (target) target.eye(_tgt);
    this.eye(_eye);
    const visible = this.sys.wq.los(_eye, target ? _tgt : targetEye);
    if (visible) {
      if (!this.tgtVisible) this.visTime = 0;
      this.tgtVisible = true;
      this.visTime += dtp;
      if (this.mode !== 'combat') this.enterCombat(t, 'match');
    } else {
      this.tgtVisible = false;
      this.visTime = 0;
      if (this.mode !== 'combat') this.enterCombat(t, 'match');
    }
  }

  combatAimPoint(out) {
    if (this.targetAgent?.alive) return this.targetAgent.chest(out);
    if (this.behavior.target === 'match' && !this.targetIsPlayer) return out.copy(this.knowPos).y += 1.1;
    return this.playerAimPoint(out);
  }

  /** Called by the system for player gunfire (heard). */
  hear(pos, t, loud) {
    if (!this.alive) return;
    const d = this.position.distanceTo(pos);
    if (d > CFG.hearRange * loud) return;
    // positional uncertainty grows with distance
    const err = d * 0.08;
    _v.set((this.rng.next() - 0.5) * 2 * err, 0, (this.rng.next() - 0.5) * 2 * err).add(pos);
    if (this.mode === 'combat') {
      if (!this.tgtVisible && t - this.knowT > 0.8) this.know(_v, t, false);
    } else {
      this.heardPos.copy(_v); this.heardT = t;
      if (d < 35 || this.mode === 'alert') { this.know(_v, t, false); this.enterCombat(t, 'heard'); } else this.mode = 'alert';
    }
  }

  /** A player round passed close by / impacted near us. */
  nearMiss(amount, shooterPos, t) {
    if (!this.alive) return;
    this.suppression = Math.min(1, this.suppression + amount);
    if (shooterPos && (this.mode !== 'combat' || (!this.tgtVisible && t - this.knowT > 1))) this.know(shooterPos, t, false);
    if (this.mode !== 'combat') this.enterCombat(t, 'suppressed');
    if (this.phase === 'fire' && this.suppression > 0.75 && this.rng.next() < 0.6) this.setPhase('hide', t, 0.8 + this.rng.next());
  }

  // ------------------------------------------------------------------ decisions
  think(t) {
    const ps = this.playerState;
    if (this.behavior.target === 'match' && this.mode === 'combat' && this.targetAgent && !this.targetAgent.alive) {
      this.targetAgent = null;
      this.tgtVisible = false;
      this.knowT = -1e9;
      this.mode = 'relaxed'; this.state = 'idle'; this.tac = 'idle'; this.releaseCover();
    }
    if (this.mode === 'combat' && !ps.alive) {
      // target down: relax after a moment
      if (t - this.knowT > 2) { this.mode = 'relaxed'; this.state = 'idle'; this.tac = 'idle'; this.releaseCover(); this.fireMode = 'none'; }
    }
    if (this.mode === 'combat') this.tactical(t);
    else if (this.mode === 'alert') this.investigate(t);
    else this.relaxed(t);
    this.state = this.mode === 'combat' ? this.tac : this.mode === 'alert' ? 'investigate' : this.tac;
  }

  relaxed(t) {
    this.fireMode = 'none';
    this.weaponMode = 'patrol';
    this.crouch = 0;
    this.lean = 0;
    const sq = this.squad;
    // hunting intel (assault waves know roughly where the defenders are)
    if (this.objective && this.behavior.target === 'player' && sq && t - sq.intelT > 9 && this.playerState.alive) {
      sq.intelT = t;
      const pp = this.playerState.position;
      const err = 6;
      _v.set(pp.x + (this.rng.next() - 0.5) * 2 * err, pp.y, pp.z + (this.rng.next() - 0.5) * 2 * err);
      sq.report(_v, t, false);
    }
    if (this.objective) {
      // assault: advance on the objective at a tactical walk / jog
      const tgt = sq && t - sq.knowT < 20 ? sq.knowPos : this.objective;
      this.tac = 'advance';
      if (this.position.distanceTo(tgt) > 6) {
        this.setMove(this.formationGoal(tgt, _v2), this.aggression > 0.6 ? CFG.run * 0.85 : CFG.walk * 1.3);
        this.weaponMode = 'low';
      } else { this.stop(); this.weaponMode = 'low'; }
      this.hasLook = false;
      return;
    }
    // patrol around the spawn area
    this.tac = 'patrol';
    if (this.arrived && t > this.patrolT) {
      const nav = this.sys.wq;
      for (let i = 0; i < 6; i++) {
        _v.set(this.position.x + (this.rng.next() - 0.5) * 16, this.position.y, this.position.z + (this.rng.next() - 0.5) * 16);
        if (nav.isWalkable(_v.x, _v.z)) { this.setMove(_v, CFG.patrolWalk); break; }
      }
      this.patrolT = t + 4 + this.rng.next() * 5;
    }
    this.hasLook = false;
  }

  /** squad members spread out around a shared destination */
  formationGoal(tgt, out) {
    const sq = this.squad;
    const i = sq ? sq.members.indexOf(this) : 0;
    const ang = i * 2.1 + (sq ? sq.id : 0);
    const r = i === 0 ? 0 : 2.2 + (i % 2) * 1.2;
    out.set(tgt.x + Math.cos(ang) * r, tgt.y, tgt.z + Math.sin(ang) * r);
    return this.sys.wq.nearestWalkable(out, out);
  }

  investigate(t) {
    this.fireMode = 'none';
    this.weaponMode = 'low';
    this.tac = 'investigate';
    this.lookPos.copy(this.heardPos); this.hasLook = true;
    if (t - this.heardT > 18) { this.mode = 'relaxed'; this.hasLook = false; return; }
    if (this.position.distanceTo(this.heardPos) > 3) this.setMove(this.heardPos, CFG.walk);
    else { this.stop(); if (t - this.heardT > 8) { this.mode = 'relaxed'; this.hasLook = false; } }
  }

  setPhase(p, t, dur) { this.phase = p; this.phaseT = t + dur; }

  pickCover(t, opts) {
    const eyeT = _v3.copy(this.knowPos); eyeT.y += 1.5;
    const sel = this.sys.cover.select(this, eyeT, {
      maxDist: opts.maxDist ?? 20,
      idealRange: this.loadout.ideal,
      minRange: opts.minRange ?? 3.5,
      maxRange: Math.max(this.loadout.range * 1.8, 20),
      squad: this.squad,
      flankFrom: opts.flank ? this.squad?.centroid() : null,
      advance: !!opts.advance,
      t,
    }, _scratch);
    if (!sel) return false;
    if (sel.cover === this.cover) return false;
    this.releaseCover();
    this.cover = sel.cover;
    this.peek = sel.peek;
    this.sys.cover.claim(sel.cover, this, t);
    this.tac = 'moveCover';
    this.relocating = true;
    const far = this.position.distanceTo(sel.cover.pos);
    this.setMove(sel.cover.pos, far > 9 && !this.tgtVisible ? CFG.sprint : CFG.run);
    this.coverSince = t;
    return true;
  }

  tactical(t) {
    const sq = this.squad;
    const since = t - this.knowT;
    const visible = this.tgtVisible;
    const dist = Math.hypot(this.knowPos.x - this.position.x, this.knowPos.z - this.position.z);
    this.lookPos.copy(this.knowPos); this.lookPos.y += 1.4; this.hasLook = true;
    if (sq && (t - (sq.rolesT || 0) > 2)) { sq.assignRoles(this.rng); sq.rolesT = t; }
    const flanker = sq && sq.flanker === this;
    const rush = this.role === 'rush' || (this.aggression > 1.0 && dist < 10);

    // lost contact for long -> search the last known position
    if (since > 12 && this.tac !== 'search') {
      this.releaseCover(); this.relocating = false;
      this.tac = 'search';
    }
    if (this.tac === 'search') {
      this.fireMode = 'none';
      this.weaponMode = 'aim';
      this.crouch = 0;
      if (visible || since < 1) { this.tac = 'engage'; return; }
      if (this.position.distanceTo(this.knowPos) > 3) this.setMove(this.knowPos, CFG.walk);
      else { this.stop(); if (since > 30) { this.mode = 'relaxed'; this.tac = 'idle'; } }
      return;
    }

    if (rush) {
      this.tac = 'rush';
      this.releaseCover(); this.relocating = false;
      this.fireMode = visible && dist < this.loadout.range * 1.3 ? 'target' : 'none';
      this.weaponMode = 'aim';
      this.crouch = 0; this.lean = 0;
      if (dist > 3.5) this.setMove(this.knowPos, visible && dist < 12 ? CFG.walk * 1.3 : CFG.run);
      else this.stop();
      return;
    }

    if (this.tac === 'moveCover') {
      this.crouch = 0; this.lean = 0;
      const near = this.cover && this.position.distanceTo(this.cover.pos) < 0.6;
      if (!this.cover) { this.tac = 'engage'; this.relocating = false; }
      else if (near || this.arrived) {
        this.tac = 'cover';
        this.relocating = false;
        this.stop();
        this.coverSince = t;
        this.coverCheckT = t + 2;
        this.setPhase('hide', t, 0.4 + this.rng.next() * 0.9);
      } else {
        // shoot on the move when close and we can see them
        this.fireMode = visible && dist < 22 && this.moveSpeed < CFG.sprint ? 'target' : 'none';
        this.weaponMode = this.moveSpeed >= CFG.sprint ? 'sprint' : this.fireMode === 'target' ? 'aim' : 'low';
      }
      return;
    }

    if (this.tac === 'cover') { this.coverLogic(t, visible, dist, since, flanker); return; }

    // engage / standFire / advance: try to get into cover first
    if (!this.cover || this.tac === 'engage') {
      const may = !sq || sq.mayMove(this);
      if (may && this.pickCover(t, { flank: flanker, maxDist: flanker ? 30 : 20, advance: !visible && this.aggression > 0.5 })) return;
    }
    if (visible) {
      this.tac = 'standFire';
      this.fireMode = 'target';
      this.weaponMode = 'aim';
      // strafe a little / crouch while trading shots in the open
      if (t > this.strafeT) {
        this.strafeT = t + 1.4 + this.rng.next() * 1.8;
        this.crouch = this.rng.next() < 0.35 ? 1 : 0;
        const side = this.rng.next() < 0.5 ? -1 : 1;
        _v.subVectors(this.knowPos, this.position).setY(0).normalize();
        _side.set(-_v.z, 0, _v.x).multiplyScalar(side * (1 + this.rng.next() * 1.5));
        _v2.copy(this.position).add(_side);
        if (dist > this.loadout.range) _v2.addScaledVector(_v, 1.5);
        if (this.sys.wq.isWalkable(_v2.x, _v2.z) && this.sys.wq.los(_v3.copy(this.position).setY(this.position.y + 1), _v2.setY(this.position.y + 1))) {
          _v2.y = this.position.y;
          this.setMove(_v2, this.crouch ? CFG.crouchWalk : CFG.walk);
        }
      }
      if (t > this.coverCheckT) { this.coverCheckT = t + 1.5; this.tac = 'engage'; }
    } else {
      this.tac = 'advance';
      this.crouch = 0;
      this.fireMode = since < 3 && this.rng.next() < 0.5 ? 'suppress' : 'none';
      this.weaponMode = 'aim';
      if (this.position.distanceTo(this.knowPos) > 5) this.setMove(this.formationGoal(this.knowPos, _v2), this.aggression > 0.7 ? CFG.run * 0.8 : CFG.walk * 1.2);
      else this.stop();
      if (t > this.coverCheckT) { this.coverCheckT = t + 2; this.tac = 'engage'; }
    }
  }

  coverLogic(t, visible, dist, since, flanker) {
    const c = this.cover;
    if (!c) { this.tac = 'engage'; return; }
    const sq = this.squad;
    // periodic re-evaluation: flanked / exposed / too far
    if (t > this.coverCheckT) {
      this.coverCheckT = t + 2.2 + this.rng.next();
      _v.copy(c.pos); _v.y += c.high ? 1.45 : 0.9;
      _v3.copy(this.knowPos); _v3.y += 1.5;
      const exposed = this.phase === 'hide' && this.sys.wq.los(_v3, _v);
      const tooFar = dist > this.loadout.range * 1.7;
      const bored = t - this.coverSince > 10 + (1.3 - this.aggression) * 10 && since > 4;
      if ((exposed || tooFar || bored) && (!sq || sq.mayMove(this))) {
        if (this.pickCover(t, { advance: tooFar || bored, flank: flanker, maxDist: 24 })) return;
        if (exposed) { this.releaseCover(); this.tac = 'engage'; return; }
      }
    }

    const reloading = this.reloadEndT > 0;
    if (this.phase === 'hide') {
      this.fireMode = 'none';
      this.weaponMode = 'low';
      this.crouch = c.high ? (this.rng.next() < 0.02 ? 1 - this.crouch : this.crouch) : 1;
      if (!c.high) this.crouch = 1;
      this.lean = 0;
      this.setMove(c.pos, CFG.walk);
      if (this.ammo < this.loadout.mag * 0.35 && !reloading) this.startReload(t);
      // grenade: target known to be near, recently seen but not visible
      if (!reloading && this.canThrow(t, dist, since)) { this.throwGrenade(t); this.setPhase('hide', t, 1.4); return; }
      if (t > this.phaseT && !reloading && !this.anim.throwing) {
        this.setPhase('peek', t, 1.2);
        if (this.peek && this.peek.side) this.setMove(this.peek.pos, CFG.walk * 1.2);
      }
      return;
    }
    if (this.phase === 'peek' || this.phase === 'fire') {
      this.crouch = 0;
      this.weaponMode = 'aim';
      if (this.peek && this.peek.side) {
        this.lean = this.peek.side * 0.6;
        this.setMove(this.peek.pos, CFG.walk * 1.2);
      } else { this.lean = 0; this.setMove(c.pos, CFG.walk); }
      const inPos = !this.hasGoal || this.position.distanceTo(this.goal) < 0.35;
      if (this.phase === 'peek' && inPos) this.setPhase('fire', t, 1.4 + this.rng.next() * 2.2);
      if (this.phase === 'fire') {
        const suppressor = sq && sq.suppressor === this;
        if (visible) this.fireMode = 'target';
        else if (since < 5 && (suppressor || this.rng.next() < 0.25)) this.fireMode = 'suppress';
        else this.fireMode = 'none';
      } else this.fireMode = visible ? 'target' : 'none';
      const suppressed = this.suppression > 0.7 && this.rng.next() < 0.5;
      if ((t > this.phaseT && this.burstLeft <= 0) || this.ammo <= 0 || suppressed) {
        this.setPhase('hide', t, (0.9 + this.rng.next() * 1.8) * (1 + this.suppression * 1.5));
      }
    }
  }

  canThrow(t, dist, since) {
    if (this.grenades <= 0 || this.anim.throwing) return false;
    if (dist < 8 || dist > 26 || since > 8 || since < 0.8) return false;
    const S = this.sys;
    if (t - S.lastGrenadeT < CFG.grenadeGlobalCooldown) return false;
    if (this.squad && t - this.squad.grenadeT < CFG.grenadeSquadCooldown) return false;
    return this.rng.next() < 0.1 * (0.5 + this.aggression);
  }

  throwGrenade(t) {
    const S = this.sys;
    this.grenades--;
    S.lastGrenadeT = t;
    if (this.squad) this.squad.grenadeT = t;
    // aim a little short / off target
    const err = 1.2 + this.rng.next() * 2.5;
    const a = this.rng.next() * Math.PI * 2;
    const target = new THREE.Vector3(this.knowPos.x + Math.cos(a) * err, this.knowPos.y + 0.2, this.knowPos.z + Math.sin(a) * err);
    this.aimYaw = yawTo(this.position, target);
    this.anim.startThrow(() => {
      if (!this.alive) return;
      const from = new THREE.Vector3().copy(this.body.pose.p[B.handR]);
      from.y += 0.1;
      const combat = this.ctx.services.combat;
      if (combat.throwGrenadeAt) combat.throwGrenadeAt({ from, target, source: this.key, team: this.team, lob: true, speed: 14 });
      else S.grenadeFallback?.(from, target, this);
    });
  }

  startReload(t) {
    if (this.reloadEndT > 0) return;
    this.reloadEndT = t + this.loadout.reload;
    this.anim.reloadDur = this.loadout.reload;
    this.anim.startReload();
    this.burstLeft = 0;
  }

  // ------------------------------------------------------------------ action (fixed step)
  act(dt, t) {
    const S = this.sys;
    const P = this.puppet;
    if (P) return this.actPuppet(dt, t, P);

    // reload completion
    if (this.reloadEndT > 0 && t >= this.reloadEndT) { this.reloadEndT = -1; this.ammo = this.loadout.mag; }

    // ---------------- movement
    this.move(dt, t);

    // ---------------- aim target
    let haveAim = false;
    if (this.mode === 'combat') {
      if (this.tgtVisible) { this.combatAimPoint(_aimPt); haveAim = true; }
      else { _aimPt.copy(this.knowPos); _aimPt.y += 1.25; haveAim = true; }
    } else if (this.hasLook) { _aimPt.copy(this.lookPos); haveAim = true; }

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const moveYaw = Math.atan2(this.velocity.x, this.velocity.z);
    this.chest(_eye);
    let desYaw = this.aimYaw, desPitch = 0;
    if (haveAim) {
      desYaw = yawTo(_eye, _aimPt);
      desPitch = Math.atan2(_aimPt.y - _eye.y, Math.hypot(_aimPt.x - _eye.x, _aimPt.z - _eye.z));
    } else if (speed > 0.3) desYaw = moveYaw;
    // sprinting / running without shooting: look where we go
    const running = speed > CFG.run * 0.8 && this.fireMode === 'none';
    if (running) { desYaw = moveYaw; desPitch = -0.05; }
    const turn = CFG.aimTurn * (this.mode === 'combat' ? 1 : 0.5) * dt;
    this.aimYaw = approachAngle(this.aimYaw, desYaw, turn * (1 + Math.abs(wrapAngle(desYaw - this.aimYaw))));
    this.aimPitch += clamp(desPitch - this.aimPitch, -turn, turn);
    this.aimPitch = clamp(this.aimPitch, -0.9, 0.9);

    // body yaw: face the aim unless running somewhere else
    if (speed > 0.5 && (running || Math.abs(wrapAngle(moveYaw - this.aimYaw)) < 0.35)) this.bodyYaw = approachAngle(this.bodyYaw, moveYaw, 6 * dt);
    else if (speed > 0.5) {
      // strafe / backpedal: hips between travel and aim, never more than ~60 deg off the aim
      const rel = wrapAngle(moveYaw - this.aimYaw);
      const hips = Math.abs(rel) > 2.2 ? this.aimYaw : this.aimYaw + clamp(rel * 0.35, -0.6, 0.6);
      this.bodyYaw = approachAngle(this.bodyYaw, hips, 5 * dt);
    } else {
      // standing: turn the feet when the aim twists too far
      const rel = wrapAngle(this.aimYaw - this.bodyYaw);
      if (Math.abs(rel) > 0.55) this.bodyYaw = approachAngle(this.bodyYaw, this.aimYaw - Math.sign(rel) * 0.25, 4 * dt);
    }

    // ---------------- fire
    this.updateFire(dt, t, desYaw, desPitch);
  }

  move(dt, t) {
    const S = this.sys;
    const wq = S.wq;
    const p = this.position;
    let tx = 0, tz = 0;
    if (this.hasGoal) {
      if (this.repath || !this.path) {
        this.path = wq.findPath(p, this.goal);
        this.pathI = 1;
        this.repath = false;
      }
      const path = this.path;
      const last = path.length - 1;
      let wp = path[Math.min(this.pathI, last)];
      while (this.pathI < last && Math.hypot(wp.x - p.x, wp.z - p.z) < 0.5) { this.pathI++; wp = path[this.pathI]; }
      const dx = wp.x - p.x, dz = wp.z - p.z;
      const d = Math.hypot(dx, dz);
      const final = this.pathI >= last;
      if (final && d < 0.12) { this.hasGoal = false; }
      else {
        let sp = this.moveSpeed;
        if (final) sp *= clamp(d / 0.9, 0.2, 1);
        tx = (dx / d) * sp; tz = (dz / d) * sp;
      }
      // stuck detection
      this.stuckT += dt;
      if (this.stuckT > 1.2) {
        const prog = this.stuckRef.distanceTo(p);
        if (prog < 0.25 && this.moveSpeed > 0.5) {
          this.stuckCount++;
          this.repath = true;
          if (this.stuckCount > 2) { this.hasGoal = false; this.stuckCount = 0; if (this.tac === 'moveCover') { this.releaseCover(); this.tac = 'engage'; this.relocating = false; } }
        }
        this.stuckT = 0; this.stuckRef.copy(p);
      }
    }
    // separation
    for (const o of S.agents) {
      if (o === this || !o.alive) continue;
      const dx = p.x - o.position.x, dz = p.z - o.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 0.72 && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const k = (0.85 - d) * 3.5;
        tx += (dx / d) * k; tz += (dz / d) * k;
      }
    }
    // accelerate towards the desired horizontal velocity
    const vx = this.velocity.x, vz = this.velocity.z;
    const ddx = tx - vx, ddz = tz - vz;
    const dl = Math.hypot(ddx, ddz);
    const acc = (tx * tx + tz * tz > vx * vx + vz * vz ? CFG.accel : CFG.decel) * dt;
    if (dl > acc) { this.velocity.x += (ddx / dl) * acc; this.velocity.z += (ddz / dl) * acc; }
    else { this.velocity.x = tx; this.velocity.z = tz; }
    this.prevPos.copy(p);
    p.x += this.velocity.x * dt;
    p.z += this.velocity.z * dt;
    if (this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z > 1e-4) wq.pushCapsule(p, CFG.radius, CFG.height);
    const gy = wq.ground(p.x, p.z, p.y + 0.7, p.y);
    p.y = gy > p.y ? Math.min(gy, p.y + 6 * dt + 0.05) : Math.max(gy, p.y - 9 * dt);
    // actual velocity after collision
    this.velocity.x = (p.x - this.prevPos.x) / dt;
    this.velocity.z = (p.z - this.prevPos.z) / dt;
  }

  actPuppet(dt, t, P) {
    if (P.vel) {
      this.prevPos.copy(this.position);
      this.velocity.set(P.vel[0], 0, P.vel[1]);
      this.position.x += P.vel[0] * dt; this.position.z += P.vel[1] * dt;
      this.position.y = this.sys.wq.ground(this.position.x, this.position.z, this.position.y + 0.7, this.position.y);
    } else this.velocity.set(0, 0, 0);
    if (P.aimYaw !== undefined) this.aimYaw = P.aimYaw;
    if (P.aimPitch !== undefined) this.aimPitch = P.aimPitch;
    if (P.aimAtPlayer) {
      this.chest(_eye); this.playerAimPoint(_aimPt);
      this.aimYaw = yawTo(_eye, _aimPt);
      this.aimPitch = Math.atan2(_aimPt.y - _eye.y, Math.hypot(_aimPt.x - _eye.x, _aimPt.z - _eye.z));
    }
    this.bodyYaw = P.bodyYaw !== undefined ? P.bodyYaw : (P.vel && !P.strafe ? Math.atan2(P.vel[0], P.vel[1]) : this.aimYaw);
    this.crouch = P.crouch ?? 0;
    this.lean = P.lean ?? 0;
    this.weaponMode = P.weapon ?? 'aim';
    if (P.reloadAt !== undefined && Math.abs(t - P.reloadAt) < dt * 0.5) this.anim.startReload();
    if (P.throwAt !== undefined && Math.abs(t - P.throwAt) < dt * 0.5) this.anim.startThrow(null);
    if (P.fire && this.alive) {
      if (t >= this.nextShotT) {
        this.nextShotT = t + 60 / this.loadout.rpm;
        const cyc = (t - (P.fireFrom ?? 0)) % (P.fireCycle ?? 1.2);
        if (cyc < (P.fireOn ?? 0.45)) this.shoot(t, true);
      }
    }
  }

  updateFire(dt, t, desYaw, desPitch) {
    if (this.fireMode === 'none' || this.reloadEndT > 0 || this.anim.throwing || !this.sys.enabled) {
      if (this.fireMode === 'none') this.burstLeft = 0;
      return;
    }
    if (this.ammo <= 0) { this.startReload(t); return; }
    if (t < this.reactT) return;
    if (this.fireMode === 'target' && !this.tgtVisible) return;
    // must be roughly on target and not mid-turn
    if (Math.abs(wrapAngle(desYaw - this.aimYaw)) > 0.12 || Math.abs(desPitch - this.aimPitch) > 0.12) return;
    if (this.weaponMode !== 'aim' && this.weaponMode !== 'low') return;
    if (this.anim.aimBlend < 0.6) return;
    if (this.burstLeft <= 0) {
      if (t < this.pauseUntil) return;
      const [a, b] = this.loadout.burst;
      this.burstLeft = a + Math.floor(this.rng.next() * (b - a + 1));
      if (this.fireMode === 'suppress') this.burstLeft = Math.ceil(this.burstLeft * 0.7);
    }
    if (t < this.nextShotT) return;
    this.shoot(t, false);
    this.burstLeft--;
    this.nextShotT = t + (60 / this.loadout.rpm) * (1 + this.rng.next() * 0.15);
    if (this.burstLeft <= 0) {
      const [pa, pb] = this.loadout.pause;
      this.pauseUntil = t + (pa + this.rng.next() * (pb - pa)) * (this.fireMode === 'suppress' ? 1.6 : 1) * (1 + this.suppression);
    }
  }

  /** Fire one round: hitscan through combat, muzzle flash, recoil. */
  shoot(t, puppet) {
    const ctx = this.ctx;
    const L = this.loadout;
    const muzzle = this.anim.weaponToWorld(WEAPON.muzzle, _fireOpts.muzzle);
    // aim point with human error
    if (puppet) { _tgt.copy(muzzle).addScaledVector(_dir.set(Math.sin(this.aimYaw) * Math.cos(this.aimPitch), Math.sin(this.aimPitch), Math.cos(this.aimYaw) * Math.cos(this.aimPitch)), 30); }
    else if (this.fireMode === 'target') this.combatAimPoint(_tgt);
    else { _tgt.copy(this.knowPos); _tgt.y += 0.9; }
    const dist = muzzle.distanceTo(_tgt);
    const ps = this.playerState;
    const track = smoothstep(0, 1.6, this.visTime);
    const ownMove = Math.min(1, Math.hypot(this.velocity.x, this.velocity.z) / 3);
    const targetSpeed = this.targetAgent?.velocity ? Math.hypot(this.targetAgent.velocity.x, this.targetAgent.velocity.z) : (ps.speed || 0);
    const tgtMove = Math.min(1.5, targetSpeed / 4);
    let sigma = (0.25 + 0.022 * dist) * (1.75 - this.accuracy * 0.85) * (1 + ownMove * 1.2) * (1 + tgtMove * 0.6) * (1 + this.suppression * 1.5) * lerp(2.2, 1, track);
    if (this.fireMode === 'suppress') sigma = 0.8 + 0.05 * dist;
    if (puppet) sigma = 0;
    const ph = this.phase0;
    _dir.subVectors(_tgt, muzzle).normalize();
    _side.crossVectors(_dir, _up).normalize();
    _v.crossVectors(_side, _dir);
    _aimPt.copy(_tgt)
      .addScaledVector(_side, sigma * wobble(t * 1.1, ph))
      .addScaledVector(_v, sigma * 0.75 * wobble(t * 0.9, ph + 11) + sigma * 0.15 * (this.shots % 7 === 0 ? 1 : 0));
    const o = _fireOpts;
    o.origin.copy(muzzle).addScaledVector(_dir, -0.25); // start just behind the muzzle so walls in contact still stop it
    o.direction.subVectors(_aimPt, o.origin).normalize();
    o.damage = L.damage;
    o.source = this.key;
    o.weaponId = this.weaponId;
    o.spread = L.spread;
    o.team = this.team;
    o.pellets = L.pellets || 1;
    o.range = 400;
    ctx.services.combat.fireHitscan(o);
    _flashParams.weaponId = this.weaponId;
    _flashParams.object = this.object;
    ctx.services.vfx.spawn('muzzle_flash', _flashParams);
    this.anim.fire(this.rng);
    this.ammo--;
    this.shots++;
    this.lastShotT = t;
    this.sys.stats.shots++;
    _fireEvt.source = this.key; _fireEvt.weaponId = this.weaponId;
    ctx.events.emit('ai:fire', _fireEvt); // HUD minimap reveal (no position: audio already plays combat:shot)
  }

  // ------------------------------------------------------------------ damage
  onDamage(amount, info) {
    const t = this.ctx.time.t;
    this.health = this.damageable ? this.damageable.health : this.health - amount;
    this.lastDamageT = t;
    const dir = info.direction || _v.subVectors(this.position, info.origin || this.ctx.services.player.state.position).setY(0).normalize();
    this.anim.hit(dir, info.zone || 'torso', clamp(amount / 25, 0.4, 1.6));
    this.suppression = Math.min(1, this.suppression + 0.35);
    this.pauseUntil = Math.max(this.pauseUntil, t + 0.25 + this.rng.next() * 0.2);
    if (this.burstLeft > 2) this.burstLeft = 1;
    if (info.source === 'player') {
      this.know(this.playerState.position, t, false);
      this.enterCombat(t, 'damage');
      if (this.phase === 'fire' && this.rng.next() < 0.5) this.setPhase('hide', t, 1 + this.rng.next());
    } else if (this.behavior.target === 'match' && typeof info.source === 'string' && info.source.startsWith('ai:')) {
      const attacker = this.sys.agents.find((a) => a.key === info.source && a.alive && a.team !== this.team);
      if (attacker) {
        this.targetAgent = attacker;
        this.targetIsPlayer = false;
        attacker.chest(this.knowPos);
        this.knowT = t;
        this.tgtVisible = false;
        this.enterCombat(t, 'damage');
      }
    }
  }

  onDeath(info) {
    const t = this.ctx.time.t;
    this.alive = false;
    this.state = 'dead';
    this.deathT = t;
    this.health = 0;
    this.releaseCover();
    this.relocating = false;
    this.hasGoal = false;
    this.fireMode = 'none';
    this.sys.pendingUnregister.push(this);
    // ragdoll impulse
    const imp = this.sys.impulse;
    imp.point.copy(info.point || this.chest(_v));
    if (info.kind === 'explosion') {
      const o = info.origin || info.position || this.position;
      imp.dir.subVectors(this.position, o).setY(0);
      if (imp.dir.lengthSq() < 1e-4) imp.dir.set(0, 0, 1);
      imp.dir.normalize().setY(0.6).normalize();
      imp.strength = 3.2;
      imp.point.copy(this.position).setY(this.position.y + 0.9);
    } else {
      imp.dir.copy(info.direction || _v2.subVectors(this.position, this.playerState.position).setY(0).normalize());
      imp.strength = info.zone === 'head' ? 1.0 : 0.8 + Math.min(0.5, (info.amount || 20) / 80);
    }
    imp.zone = info.zone;
    const gy = this.sys.wq.ground(this.position.x, this.position.z, this.position.y + 1, this.position.y);
    this.ragdoll.start(this.body.pose, this.prevPose, 1 / 60, imp, gy, this.rng);
    this.anim.reloadT = -1; this.anim.throwT = -1; this.anim.magHeld = false;
    this.sys.onAgentDeath(this, info);
  }

  footstep(foot, speed) {
    if (!this.alive || this.lodLevel > 1) return;
    const e = _stepEvt;
    e.position.copy(foot.pos);
    e.speed = speed;
    e.stance = this.crouch > 0.5 ? 'crouch' : 'stand';
    e.surface = 'concrete';
    e.agent = this;
    this.ctx.events.emit('ai:footstep', e);
  }

  // ------------------------------------------------------------------ animation (per frame)
  animate(dt, t) {
    if (!this.alive) {
      this.ragdoll.step(dt, this.sys.wq);
      this.ragdoll.writePose(this.body.pose);
      this.position.copy(this.ragdoll.position).setY(this.position.y);
      this.syncBody();
      return;
    }
    const I = this.anim.in;
    I.pos.copy(this.position);
    I.vel.copy(this.velocity);
    I.bodyYaw = this.bodyYaw;
    I.aimYaw = this.aimYaw;
    I.aimPitch = this.aimPitch;
    I.crouch = this.crouch;
    I.lean = this.lean;
    I.weapon = this.weaponMode;
    if (this.mode !== 'combat' && this.hasLook) {
      I.headYaw = yawTo(this.position, this.lookPos);
      I.headPitch = 0;
    } else I.headYaw = null;
    this.prevPose.copy(this.body.pose);
    this.anim.update(dt, t);
    this.syncBody();
  }

  syncBody() {
    const b = this.body;
    b.group.position.copy(this.position);
    b.group.rotation.set(0, 0, 0);
    b.applyPose();
    b.updateHitboxes();
    b.updateAnchors(WEAPON.muzzle, WEAPON.eject);
  }
}

export { TAC_FIRE };

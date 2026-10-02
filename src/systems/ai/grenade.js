import * as THREE from 'three';
import { roundedBox, ellipsoid, cylinderZ, Part } from './character/sculpt.js';

/**
 * Enemy frag grenades: pooled meshes, ballistic flight with bounces against the world (raycast
 * along the motion segment), rolling friction, fuse -> services.combat.explode().
 * Emits 'ai:grenade' {position, agent, fuse} on throw so HUD/audio can warn the player.
 */

const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();

function grenadeGeometry() {
  const body = ellipsoid(0.031, 0.038, 0.031, 14, 10);
  body.map((v) => { v.y += 0.0; });
  const top = cylinderZ(0.012, 0.012, 0, 0.02, 10, 1);
  top.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(0, 0.034, 0));
  const spoon = roundedBox(0.012, 0.06, 0.006, 0.002, 1);
  spoon.applyMatrix4(new THREE.Matrix4().makeRotationZ(0.08).setPosition(0.012, 0.018, 0.03));
  const all = new Part();
  all.merge(body); all.merge(top); all.merge(spoon);
  all.computeNormals();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(all.p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(all.n, 3));
  g.setIndex(all.idx);
  return g;
}

export class GrenadeSystem {
  constructor(ctx, wq, max = 6) {
    this.ctx = ctx;
    this.wq = wq;
    this.geo = grenadeGeometry();
    this.mat = new THREE.MeshStandardMaterial({ color: 0x3a3f2c, roughness: 0.55, metalness: 0.2 });
    this.pool = [];
    for (let i = 0; i < max; i++) {
      const m = new THREE.Mesh(this.geo, this.mat);
      m.castShadow = true;
      m.visible = false;
      m.name = 'ai_grenade';
      ctx.scene.add(m);
      this.pool.push({ mesh: m, active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), spin: new THREE.Vector3(), fuse: 0, owner: null, rest: false });
    }
    this.payload = { position: new THREE.Vector3(), agent: null, fuse: 0, velocity: new THREE.Vector3() };
  }

  throw(from, vel, owner, fuse = 3.0) {
    const g = this.pool.find((x) => !x.active);
    if (!g) return null;
    g.active = true; g.rest = false;
    g.pos.copy(from); g.vel.copy(vel);
    g.spin.set(8 + Math.abs(vel.x), 3, 5);
    g.fuse = fuse; g.owner = owner;
    g.mesh.visible = true;
    g.mesh.position.copy(from);
    const P = this.payload;
    P.position.copy(from); P.velocity.copy(vel); P.agent = owner; P.fuse = fuse;
    this.ctx.events.emit('ai:grenade', P);
    return g;
  }

  /** Solve launch velocity for a lob to `target` (angle in radians), capped speed. */
  static solve(from, target, angle, out, maxSpeed = 17) {
    _d.subVectors(target, from);
    const dy = _d.y;
    _d.y = 0;
    const R = _d.length();
    if (R < 0.5) return out.set(0, 3, 0);
    _d.divideScalar(R);
    const g = 9.81;
    const c = Math.cos(angle), t = Math.tan(angle);
    const denom = 2 * c * c * (R * t - dy);
    let v = denom > 0 ? Math.sqrt((g * R * R) / denom) : maxSpeed;
    v = Math.min(v, maxSpeed);
    return out.copy(_d).multiplyScalar(v * c).setY(v * Math.sin(angle));
  }

  update(dt) {
    for (const g of this.pool) {
      if (!g.active) continue;
      g.fuse -= dt;
      if (!g.rest) {
        g.vel.y -= 9.81 * dt;
        _d.copy(g.vel).multiplyScalar(dt);
        const len = _d.length();
        if (len > 1e-6) {
          _p.copy(_d).divideScalar(len);
          const hit = this.wq.raycast(g.pos, _p, len + 0.04, _n);
          if (hit >= 0) {
            g.pos.addScaledVector(_p, Math.max(0, hit - 0.035));
            // reflect with restitution + friction
            const vn = g.vel.dot(_n);
            g.vel.addScaledVector(_n, -vn * 1.35);
            g.vel.multiplyScalar(0.55);
            g.spin.multiplyScalar(0.6);
            if (g.vel.length() < 0.6 && _n.y > 0.6) { g.rest = true; g.vel.set(0, 0, 0); }
          } else g.pos.add(_d);
        }
        const k = Math.min(1, dt * 1.0);
        _q.setFromAxisAngle(_n.copy(g.spin).normalize(), g.spin.length() * dt);
        g.mesh.quaternion.premultiply(_q);
        g.spin.multiplyScalar(1 - k * 0.3);
      }
      g.mesh.position.copy(g.pos);
      if (g.fuse <= 0) {
        g.active = false;
        g.mesh.visible = false;
        _p.copy(g.pos); _p.y += 0.05;
        const src = g.owner ? `ai:${g.owner.id}` : 'ai';
        this.ctx.services.combat.explode({ position: _p, radius: 7, damage: 115, source: src, weaponId: 'ai_frag' });
      }
    }
  }

  clear() { for (const g of this.pool) { g.active = false; g.mesh.visible = false; } }

  dispose() {
    for (const g of this.pool) g.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}

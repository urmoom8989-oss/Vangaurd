import * as THREE from 'three';
import { BONE_NAMES, PARENT, BIND, NUM_BONES, HITBOXES, B } from './rig.js';

/**
 * One soldier instance: Group (at the feet, yawed) -> SkinnedMesh + bones + hitboxes + anchors.
 *
 * Animation code writes a WORLD-space pose into `pose.p[]` / `pose.q[]` (joint positions and bone
 * world rotations; bind rotations are identity) and calls `applyPose()` which converts to local
 * bone transforms. Hitboxes (invisible capsules, userData.zone) follow their bones.
 */

export const OFFSET = BIND.map((p, i) => {
  const par = PARENT[i];
  if (par < 0) return new THREE.Vector3(...p);
  return new THREE.Vector3(p[0] - BIND[par][0], p[1] - BIND[par][1], p[2] - BIND[par][2]);
});
export const BIND_V = BIND.map((p) => new THREE.Vector3(...p));

const _m = new THREE.Matrix4();
const _mi = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _qa = new THREE.Quaternion();
// vfx anchors look down -Z; the rifle points down +Z
const FLIP_Y = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

let hitboxGeo = null;
let hitboxMat = null;

export class Pose {
  constructor() {
    this.p = Array.from({ length: NUM_BONES }, (_, i) => BIND_V[i].clone());
    this.q = Array.from({ length: NUM_BONES }, () => new THREE.Quaternion());
  }
  copy(o) {
    for (let i = 0; i < NUM_BONES; i++) { this.p[i].copy(o.p[i]); this.q[i].copy(o.q[i]); }
    return this;
  }
  /** joint i position from its parent's transform (forward kinematics) */
  fk(i) {
    const par = PARENT[i];
    this.p[i].copy(OFFSET[i]).applyQuaternion(this.q[par]).add(this.p[par]);
    return this.p[i];
  }
}

export class SoldierBody {
  constructor({ geometries, material, name = 'soldier' }) {
    this.group = new THREE.Group();
    this.group.name = name;
    this.geometries = geometries; // [lod0, lod1, lod2]
    this.lod = 0;
    this.material = material;

    // bones
    this.bones = BONE_NAMES.map((n) => { const b = new THREE.Bone(); b.name = n; return b; });
    for (let i = 0; i < NUM_BONES; i++) {
      const par = PARENT[i];
      this.bones[i].position.copy(OFFSET[i]);
      if (par >= 0) this.bones[par].add(this.bones[i]);
    }
    // bone world matrices in the bind pose (roots at the origin) -> inverse bind matrices
    this.bones[B.pelvis].updateMatrixWorld(true);
    this.bones[B.weapon].updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(this.bones);
    const mesh = new THREE.SkinnedMesh(geometries[0], material);
    mesh.name = name + '_mesh';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.add(this.bones[B.pelvis]);
    mesh.add(this.bones[B.weapon]);
    mesh.bind(this.skeleton, new THREE.Matrix4());
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 1.35);
    mesh.boundingBox = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
    this.mesh = mesh;
    this.group.add(mesh);

    // hitboxes: separate root so combat only sees capsules
    if (!hitboxGeo) {
      hitboxGeo = new THREE.CapsuleGeometry(1, 1, 2, 6); // unit; scaled per hitbox
      hitboxMat = new THREE.MeshBasicMaterial({ visible: false });
    }
    this.hitRoot = new THREE.Group();
    this.hitRoot.name = name + '_hitboxes';
    this.hitRoot.position.set(0, 1.0, 0);
    this.hitRoot.visible = false;
    this.group.add(this.hitRoot);
    this.hitboxes = HITBOXES.map(([bone, zone, r, a, b]) => {
      const m = new THREE.Mesh(hitboxGeo, hitboxMat);
      m.matrixAutoUpdate = false;
      m.userData.zone = zone;
      m.userData.bone = B[bone];
      m.userData.surface = 'flesh';
      // local transform relative to the bone (bind rotation identity)
      const A = new THREE.Vector3(...a), Bb = new THREE.Vector3(...b);
      const mid = A.clone().add(Bb).multiplyScalar(0.5).sub(BIND_V[B[bone]]);
      const dir = Bb.clone().sub(A);
      const len = dir.length();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      // unit capsule spans y in [-1.5, 1.5] (half-length 0.5 + radius 1); want half-span len/2 + r
      const sy = (len / 2 + r) / 1.5;
      m.userData.local = new THREE.Matrix4().compose(mid, q, new THREE.Vector3(r, sy, r));
      m.name = `${name}_hb_${bone}`;
      this.hitRoot.add(m);
      return m;
    });

    // anchors (muzzle / ejection port) for vfx; updated from the weapon bone each frame
    this.muzzle = new THREE.Object3D(); this.muzzle.name = name + '_muzzle';
    this.eject = new THREE.Object3D(); this.eject.name = name + '_eject';
    this.group.add(this.muzzle, this.eject);

    this.pose = new Pose();
  }

  setLOD(l) {
    if (l === this.lod) return;
    this.lod = l;
    this.mesh.geometry = this.geometries[Math.min(l, this.geometries.length - 1)];
  }

  /**
   * Convert the world-space pose to local bone transforms. The group transform (feet position, yaw)
   * must be current (updateMatrixWorld called by the caller).
   */
  applyPose() {
    const g = this.group;
    g.updateMatrix();
    g.matrixWorld.copy(g.matrix); // group is a direct child of the scene
    _mi.copy(g.matrixWorld).invert();
    g.getWorldQuaternion(_qi); // group world rotation
    _qi.invert();
    const pose = this.pose;
    for (let i = 0; i < NUM_BONES; i++) {
      const bone = this.bones[i];
      const par = PARENT[i];
      if (par < 0) {
        bone.position.copy(pose.p[i]).applyMatrix4(_mi);
        bone.quaternion.copy(_qi).multiply(pose.q[i]);
      } else {
        _q.copy(pose.q[par]).invert();
        bone.quaternion.copy(_q).multiply(pose.q[i]);
        if (i === B.mag) {
          // magazine may be detached from the weapon during reloads
          bone.position.copy(pose.p[i]).sub(pose.p[par]).applyQuaternion(_q);
        }
      }
    }
    // bounding sphere follows the pelvis (mesh local == group local)
    this.mesh.boundingSphere.center.copy(pose.p[B.pelvis]).applyMatrix4(_mi);
  }

  /** Update hitbox matrices from the (world) pose. Call after applyPose. */
  updateHitboxes() {
    const pose = this.pose;
    this.hitRoot.updateMatrixWorld(true);
    _mi.copy(this.hitRoot.matrixWorld).invert();
    for (const hb of this.hitboxes) {
      const bi = hb.userData.bone;
      _m.compose(pose.p[bi], pose.q[bi], _s);
      hb.matrixWorld.multiplyMatrices(_m, hb.userData.local);
      hb.matrix.multiplyMatrices(_mi, hb.matrixWorld);
    }
  }

  /** Muzzle / ejection anchors in world space (as children of the group). */
  updateAnchors(muzzleLocal, ejectLocal) {
    const pose = this.pose;
    const wi = B.weapon;
    _mi.copy(this.group.matrixWorld).invert();
    _v.copy(muzzleLocal).applyQuaternion(pose.q[wi]).add(pose.p[wi]);
    this.muzzle.matrixAutoUpdate = false;
    _qa.copy(pose.q[wi]).multiply(FLIP_Y);
    _m.compose(_v, _qa, _s);
    this.muzzle.matrix.multiplyMatrices(_mi, _m);
    this.muzzle.matrixWorld.copy(_m);
    _v.copy(ejectLocal).applyQuaternion(pose.q[wi]).add(pose.p[wi]);
    this.eject.matrixAutoUpdate = false;
    _m.compose(_v, _qa, _s);
    this.eject.matrix.multiplyMatrices(_mi, _m);
    this.eject.matrixWorld.copy(_m);
  }

  dispose() {
    this.skeleton.dispose();
    this.group.removeFromParent();
  }
}

export function disposeShared() {
  hitboxGeo?.dispose(); hitboxGeo = null;
  hitboxMat?.dispose(); hitboxMat = null;
}

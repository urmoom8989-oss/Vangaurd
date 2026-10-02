import * as THREE from 'three';
import { Assembly, lathe, box, sideX, fillet, xf } from '../geo.js';

/**
 * Fragmentation grenade (original design): smooth steel body in olive paint with a fuse assembly,
 * safety lever ("spoon") and pull ring. Local frame: origin at the body center, fuse up (+y).
 * Attached to the left hand bone in first person (offset in the palm) and pooled in the world when thrown.
 */
export function buildGrenade(mats, layer) {
  const A = new Assembly();
  // egg-shaped body (lathe along -z, then stood up)
  const prof = [];
  for (let i = 0; i <= 20; i++) {
    const a = (i / 20) * Math.PI;
    const r = Math.sin(a) * 0.0315 * (1 - 0.08 * Math.cos(a));
    const u = -Math.cos(a) * 0.036;
    prof.push([Math.max(r, 0.0001), u]);
  }
  const body = lathe(prof, 32);
  body.rotateX(Math.PI / 2); // axis -> +y
  A.add('paintOD', body);
  // seam band + yellow marking ring
  const band = lathe([[0.0318, -0.002], [0.0322, -0.0015], [0.0322, 0.0015], [0.0318, 0.002]], 40);
  band.rotateX(Math.PI / 2);
  A.add('steel', band);
  const mark = lathe([[0.0292, 0.012], [0.0296, 0.0124], [0.0296, 0.0156], [0.029, 0.016]], 40);
  mark.rotateX(Math.PI / 2);
  A.add('paintYellow', mark);
  // fuse body
  const fuse = lathe([[0, 0.0], [0.0125, 0.0], [0.0125, 0.012], [0.0105, 0.014], [0.0105, 0.021], [0.0085, 0.023], [0, 0.023]], 24);
  fuse.rotateX(-Math.PI / 2);
  fuse.translate(0, 0.031, 0);
  A.add('steel', fuse);
  // spoon: bent strip from the fuse top down the side
  const spoon = sideX(fillet([[-0.006, 0.052], [0.004, 0.052], [0.006, 0.046], [0.034, 0.012], [0.036, -0.012], [0.031, -0.012], [0.029, 0.01], [0.002, 0.045], [-0.006, 0.047]], 0.0015, 2), 0.011, { bevel: 0.0006 });
  // sideX profile is in (u, v) -> rotate so the spoon lies along +x side of the body
  spoon.rotateY(Math.PI / 2);
  A.add('steel', spoon);
  // pull ring (torus) + pin
  const ring = new THREE.TorusGeometry(0.0115, 0.0014, 8, 28);
  ring.rotateY(Math.PI / 2);
  ring.translate(-0.012, 0.043, 0.0);
  A.add('bright', ring);
  const pinG = new THREE.CylinderGeometry(0.0009, 0.0009, 0.03, 8);
  pinG.rotateZ(Math.PI / 2);
  pinG.translate(-0.001, 0.043, 0);
  A.add('bright', pinG);
  const g = A.build(mats, layer, 'grenade');
  const root = new THREE.Group();
  root.name = 'grenade';
  root.add(...g.children);
  // palm offset (left hand bone space): in the palm, fuse toward the thumb
  root.position.set(0.004, -0.04, -0.07);
  root.rotation.set(0.2, 0, 1.2);
  return { root };
}

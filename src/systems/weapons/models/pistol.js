import * as THREE from 'three';
import { Assembly, sideX, alongZ, lathe, pin, box, fillet, rrect, circle, spline, xf } from '../geo.js';

/**
 * "Kestrel" P9 — 9mm striker-fired pistol. Gun space: origin on the bore axis at the rear face of the slide,
 * muzzle at -z. Profiles in (u forward, v up).
 * Parts: slide (reciprocates), trigger, slideStop, mag (own frame at the magwell seat, tilted with the grip).
 */
export const PISTOL_DIMS = {
  muzzle: new THREE.Vector3(0, 0, -0.189),
  eject: new THREE.Vector3(0.008, 0.012, -0.098),
  sight: new THREE.Vector3(0, 0.0205, -0.012), // rear notch (sight line through front post)
  magSeat: new THREE.Vector3(0, -0.1215, -0.004),
  gripAngle: 18,
};

const GA = PISTOL_DIMS.gripAngle * Math.PI / 180;

export function buildPistolMagAssembly() {
  const A = new Assembly();
  // magazine body in the grip direction: local frame at the seat (bottom of grip), axis tilted forward/up by GA
  const H = 0.118, D = 0.031, W = 0.0215;
  const body = [];
  // outline in (u, v) along the tilted axis: points (along, across) -> rotate
  const rot = ([a, b]) => [b * Math.cos(GA) + a * Math.sin(GA), a * Math.cos(GA) - b * Math.sin(GA)];
  const pts = [[0.006, -D / 2], [0.006, D / 2], [H, D / 2 - 0.001], [H + 0.004, D / 2 - 0.007], [H + 0.004, -D / 2 + 0.004], [H, -D / 2]].map(rot);
  const holes = [];
  for (let i = 0; i < 5; i++) holes.push(circle(...rot([0.03 + i * 0.016, -D / 2 + 0.0045]), 0.0016, 12));
  A.add('steel', sideX(fillet(pts, [0.001, 0.001, 0.003, 0.002, 0.002, 0.003], 2), W, { bevel: 0.0012, holes }));
  // brass stack visible through the witness holes
  for (let i = 0; i < 5; i++) {
    const [u, v] = rot([0.03 + i * 0.016, -D / 2 + 0.006]);
    A.add('brass', box(0.012, 0.012, 0.01, 0.003), [0, v, -u]);
  }
  // base plate (polymer), extended with a finger lip
  const bp = [[-0.006, -D / 2 - 0.004], [-0.006, D / 2 + 0.006], [0.0035, D / 2 + 0.006], [0.0085, D / 2 + 0.002], [0.0085, -D / 2 - 0.003], [0.004, -D / 2 - 0.005]].map(rot);
  A.add('polyBlack', sideX(fillet(bp, 0.0022, 3), W + 0.004, { bevel: 0.0022 }));
  // top round
  const [tu, tv] = rot([H + 0.006, -0.002]);
  const cs = lathe([[0, -0.0095], [0.0048, -0.0095], [0.0048, 0.009], [0, 0.009]], 18);
  const bl = lathe([[0.0045, 0.009], [0.0045, 0.013], [0.0032, 0.0175], [0.001, 0.0195], [0, 0.0197]], 18);
  xf(cs, [0.002, tv, -tu], [4, 0, 0]); xf(bl, [0.002, tv, -tu], [4, 0, 0]);
  A.add('brass', cs); A.add('copper', bl);
  return A;
}

export function buildPistol(mats, layer) {
  const A = new Assembly();
  const root = new THREE.Group();
  root.name = 'pistol';
  const parts = {};
  const sockets = {};
  const part = (name, asm, pivot) => {
    const g = asm.build(mats, layer, name);
    for (const m of g.children) m.geometry.translate(-pivot.x, -pivot.y, -pivot.z);
    const pv = new THREE.Group();
    pv.name = name;
    pv.position.copy(pivot);
    pv.add(...g.children);
    root.add(pv);
    parts[name] = pv;
    return pv;
  };

  // ================================================================ SLIDE (part)
  {
    const S = new Assembly();
    const W = 0.01225;
    const full = fillet([[-W, -0.0105], [W, -0.0105], [W, 0.0105], [0.0085, 0.0165], [-0.0085, 0.0165], [-W, 0.0105]], [0.0012, 0.0012, 0.0012, 0.0015, 0.0015, 0.0012], 2);
    const ported = fillet([[-W, -0.0105], [W, -0.0105], [W, 0.0005], [-0.0035, 0.0005], [-0.0035, 0.0165], [-0.0085, 0.0165], [-W, 0.0105]], [0.0012, 0.0012, 0.0008, 0.0006, 0.0006, 0.0015, 0.0012], 2);
    S.add('steel', alongZ(full, 0.0, 0.0705, { bevel: 0.0014 }));
    S.add('steel', alongZ(ported, 0.069, 0.126, { bevel: 0.0008 }));
    S.add('steel', alongZ(full, 0.1245, 0.1875, { bevel: 0.0022 }));
    // barrel hood in the port + chamber
    S.add('bright', box(0.0152, 0.0145, 0.056, 0.001), [0.0039, 0.0082, -0.097]);
    S.add('cavity', box(0.0154, 0.0006, 0.022, 0.0002), [0.0039, 0.0156, -0.08]);
    // rear + front serrations (raised ridges both sides)
    for (const s of [-1, 1]) {
      for (let i = 0; i < 8; i++) S.add('steel', box(0.0008, 0.0175, 0.0016, 0.0003), [s * (W + 0.0002), 0.0012, -(0.007 + i * 0.0042)], [0, 0, 0]);
      for (let i = 0; i < 5; i++) S.add('steel', box(0.0008, 0.0165, 0.0016, 0.0003), [s * (W + 0.0002), 0.0008, -(0.148 + i * 0.0042)]);
    }
    // rear sight with U-notch + tritium dots
    const rs = fillet([[-0.0112, 0.0158], [0.0112, 0.0158], [0.0105, 0.0222], [0.0022, 0.0222], [0.0022, 0.0196], [-0.0022, 0.0196], [-0.0022, 0.0222], [-0.0105, 0.0222]], [0.0006, 0.0006, 0.0008, 0.0004, 0.0008, 0.0008, 0.0004, 0.0008], 2);
    S.add('steel', alongZ(rs, 0.0035, 0.0165, { bevel: 0.0006 }));
    S.add('lume', pin(0.0009, 0.0006, 0.0001, 10, 'z'), [0.0055, 0.0205, -0.0033]);
    S.add('lume', pin(0.0009, 0.0006, 0.0001, 10, 'z'), [-0.0055, 0.0205, -0.0033]);
    // front sight post + dot
    S.add('steel', box(0.0036, 0.0065, 0.0075, 0.0007), [0, 0.0192, -0.177]);
    S.add('lume', pin(0.001, 0.0006, 0.0001, 10, 'z'), [0, 0.0205, -0.1731]);
    // extractor (right side)
    S.add('steel', box(0.0012, 0.0035, 0.022, 0.0005), [W + 0.0003, 0.004, -0.058]);
    // striker channel cover (rear face)
    S.add('polyBlack', box(0.011, 0.012, 0.001, 0.0008), [0, 0.001, 0.0006]);
    const sl = part('slide', S, new THREE.Vector3(0, 0, 0));
    sl.userData.homeZ = 0;
  }
  // barrel crown + bore, guide rod
  A.add('steel', lathe([[0.0066, 0.180], [0.0066, 0.1885], [0.0056, 0.189], [0.0046, 0.189]], 22));
  A.add('cavity', lathe([[0.0046, 0.17], [0.0046, 0.1889], [0, 0.1889]], 16));
  A.add('steel', lathe([[0, 0.17], [0.0042, 0.17], [0.0042, 0.1865], [0.0034, 0.1872], [0, 0.1872]], 18), [0, -0.0178, 0]);
  A.add('cavity', box(0.0132, 0.0118, 0.0006, 0.0004), [0, -0.0178, -0.1835]);

  // ================================================================ FRAME (polymer)
  const frame = fillet([
    [0.0, -0.0105], [0.183, -0.0105], [0.183, -0.0262], [0.178, -0.0282], [0.113, -0.0282], [0.109, -0.034], [0.106, -0.048],
    [0.098, -0.0572], [0.072, -0.0588], [0.058, -0.053], [0.05, -0.03], [0.0, -0.024],
  ], [0.001, 0.001, 0.002, 0.002, 0.004, 0.004, 0.006, 0.006, 0.006, 0.004, 0.004, 0.002], 3);
  const tgHole = fillet([[0.061, -0.0292], [0.1015, -0.0292], [0.0998, -0.0452], [0.0935, -0.0515], [0.0725, -0.0522], [0.0645, -0.0472]], [0.002, 0.003, 0.005, 0.005, 0.004, 0.003], 3);
  A.add('polyBlack', sideX(frame, 0.0248, { bevel: 0.0016, holes: [tgHole] }));
  // accessory rail slots under the dust cover
  for (let i = 0; i < 3; i++) A.add('cavity', box(0.019, 0.0008, 0.0032, 0.0003), [0, -0.0284, -(0.13 + i * 0.012)]);
  // grip (stippled)
  const grip = spline([
    [0.055, -0.029], [0.049, -0.048], [0.046, -0.06], [0.0415, -0.074], [0.037, -0.09], [0.032, -0.108], [0.028, -0.119],
    [0.018, -0.1245], [-0.012, -0.1235], [-0.027, -0.119], [-0.028, -0.108], [-0.021, -0.08], [-0.013, -0.052],
    [-0.012, -0.036], [-0.019, -0.025], [-0.022, -0.017], [-0.012, -0.0125], [0.02, -0.0125],
  ], 64, 0.5);
  A.add('polyBlackStip', sideX(grip, 0.0298, { bevel: 0.0068, seg: 4, curveSeg: 8 }));
  // frame "palm swell" plates (smooth) on the grip top sides
  for (const s of [-1, 1]) A.add('polyBlack', sideX(fillet([[0.0, -0.022], [0.045, -0.022], [0.04, -0.04], [-0.008, -0.04]], 0.004, 3), 0.002, { cx: s * 0.0146, bevel: 0.0008 }));
  // slide stop lever (left) + takedown lever
  {
    const K = new Assembly();
    K.add('steel', sideX(fillet([[0.052, -0.0122], [0.086, -0.0118], [0.089, -0.0152], [0.075, -0.0178], [0.058, -0.017]], 0.0012, 2), 0.0018, { cx: -0.0133, bevel: 0.0006 }));
    for (let i = 0; i < 3; i++) K.add('steel', box(0.0006, 0.004, 0.0008, 0.0002), [-0.0145, -0.0148, -(0.078 + i * 0.0025)]);
    part('slideStop', K, new THREE.Vector3(-0.0133, -0.014, -0.086));
  }
  A.add('steel', sideX(fillet([[0.092, -0.0135], [0.104, -0.0135], [0.104, -0.018], [0.092, -0.018]], 0.001, 2), 0.0014, { cx: -0.0131, bevel: 0.0004 }));
  A.add('steel', pin(0.0022, 0.0262, 0.0003, 12, 'x'), [0, -0.0165, -0.098]);
  A.add('steel', pin(0.0018, 0.0262, 0.0003, 12, 'x'), [0, -0.0205, -0.074]);
  A.add('steel', pin(0.0016, 0.0262, 0.0003, 12, 'x'), [0, -0.017, -0.006]);
  // mag release (left)
  A.add('polyBlack', box(0.0024, 0.0062, 0.0055, 0.0009), [-0.0128, -0.032, -0.052]);

  // ================================================================ TRIGGER (part) with safety blade
  {
    const T = new Assembly();
    const tr = spline([[0.0735, -0.0265], [0.0795, -0.0265], [0.0808, -0.033], [0.0795, -0.041], [0.0768, -0.0462], [0.0742, -0.0462], [0.0758, -0.041], [0.0765, -0.034], [0.0748, -0.029]], 36);
    T.add('polyBlack', sideX(tr, 0.0058, { bevel: 0.0012 }));
    T.add('steel', sideX(fillet([[0.0762, -0.033], [0.0792, -0.033], [0.0788, -0.0415], [0.0772, -0.0418]], 0.0006, 2), 0.0018, { bevel: 0.0004 }));
    part('trigger', T, new THREE.Vector3(0, -0.026, -0.078));
  }

  // ================================================================ MAGAZINE (part)
  {
    const g = buildPistolMagAssembly().build(mats, layer, 'mag');
    const mag = new THREE.Group();
    mag.name = 'mag';
    mag.add(...g.children);
    mag.position.copy(PISTOL_DIMS.magSeat);
    root.add(mag);
    parts.mag = mag;
  }

  const body = A.build(mats, layer, 'pistolBody');
  root.add(...body.children);
  const sock = (name, p) => {
    const o = new THREE.Object3D();
    o.name = `socket:${name}`;
    o.position.copy(p);
    root.add(o);
    sockets[name] = o;
    return o;
  };
  sock('muzzle', PISTOL_DIMS.muzzle);
  sock('eject', PISTOL_DIMS.eject);
  sock('sight', PISTOL_DIMS.sight);
  sock('magSeat', PISTOL_DIMS.magSeat);
  sock('catch', new THREE.Vector3(-0.014, -0.014, -0.075));
  return { root, parts, sockets, dims: PISTOL_DIMS };
}

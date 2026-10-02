import * as THREE from 'three';
import { Assembly, sideX, alongZ, topY, lathe, pin, box, fillet, rrect, slot, circle, spline, xf } from '../geo.js';

/**
 * "Warden" AR-7 — 5.56 carbine, fully procedural hard-surface model.
 * Gun space: origin on the bore axis at the rear face of the upper receiver. x right, y up, muzzle at -z.
 * Profiles use (u = forward = -z, v = up). All dimensions in meters, real-world scale.
 *
 * Returns { root, parts, sockets, mag, dims } where parts are animated sub-groups with pivots:
 *   trigger, selector, boltCatch, charge (charging handle), bolt (carrier, seen through the port),
 *   dustCover, magRelease, mag (magazine assembly, own local frame at the magwell seat)
 */
export const RIFLE_DIMS = {
  sightCenter: new THREE.Vector3(0, 0.0665, -0.060), // rear window center (sight axis passes through it)
  muzzle: new THREE.Vector3(0, 0, -0.603),
  eject: new THREE.Vector3(0.014, 0.003, -0.096),
  magSeat: new THREE.Vector3(0, -0.0745, -0.121),
  stockRear: -0.298,
};

// shared magazine geometry (for the in-gun mag, the spare mag in hand and dropped world mags)
export function buildMagAssembly() {
  const A = new Assembly();
  const R = 0.27;
  const f = (v) => (v < -0.008 ? R - Math.sqrt(R * R - (v + 0.008) * (v + 0.008)) : 0);
  const top = 0.046, bot = -0.138;
  const rear = [], front = [];
  const N = 22;
  for (let i = 0; i <= N; i++) {
    const v = top + (bot - top) * (i / N);
    const grow = v < -0.02 ? Math.min(1, (-0.02 - v) / 0.05) * 0.0015 : 0;
    rear.push([-0.0306 - grow + f(v), v]);
    front.push([0.0306 + grow * 0.5 + f(v), v]);
  }
  const outline = [...rear, ...front.reverse()];
  // witness holes near the rear spine (show the brass column inside)
  const holes = [];
  const witness = [-0.032, -0.062, -0.092];
  for (const v of witness) holes.push(circle(-0.0232 + f(v), v, 0.0021, 14));
  const body = sideX(fillet(outline, outline.map((_, i) => (i === 0 || i === N || i === N + 1 || i === outline.length - 1 ? 0.0025 : 0)), 3), 0.0232, { bevel: 0.0018, seg: 3, holes });
  A.add('polyBlack', body);
  // brass column seen through the witness holes
  for (const v of witness) A.add('brass', box(0.0125, 0.012, 0.012, 0.003), [0, v, -(-0.0215 + f(v))]);
  // raised grip ribs (both sides), follow the curve
  for (let i = 0; i < 5; i++) {
    const v = -0.03 - i * 0.0085;
    const u0 = -0.012 + f(v), u1 = 0.026 + f(v);
    const rib = sideX(rrect((u0 + u1) / 2, v, u1 - u0, 0.0032, 0.0014), 0.0014, { bevel: 0.0005, seg: 2 });
    A.add('polyBlack', rib.clone(), [0.0116 + 0.0003, 0, 0], [0, 0, 0]);
    A.add('polyBlack', rib, [-0.0116 - 0.0003, 0, 0], [0, 0, 0]);
  }
  // front spine ridges
  for (let i = 0; i < 6; i++) {
    const v = -0.02 - i * 0.017;
    A.add('polyBlack', box(0.016, 0.0025, 0.004, 0.001), [0, v, -(0.0306 + f(v) + 0.0005)]);
  }
  // floorplate with front pull lip
  const fb = bot;
  const fp = sideX(fillet([[-0.0335 + f(fb), fb - 0.001], [0.036 + f(fb), fb - 0.001], [0.0405 + f(fb), fb + 0.006], [0.034 + f(fb), fb + 0.011], [-0.0325 + f(fb), fb + 0.011]], [0.002, 0.002, 0.002, 0.002, 0.002], 3), 0.0262, { bevel: 0.0022 });
  A.add('polyBlack', fp);
  // feed lips
  for (const s of [-1, 1]) {
    A.add('polyBlack', sideX(fillet([[-0.0305, top - 0.002], [0.012, top - 0.002], [0.016, top + 0.004], [-0.0305, top + 0.005]], 0.0012, 2), 0.004, { bevel: 0.0008, cx: s * 0.0088 }));
  }
  // top cartridges (staggered)
  const round = (x, y, tilt) => {
    const cs = lathe([[0, -0.029], [0.0043, -0.029], [0.0048, -0.0283], [0.0048, -0.0265], [0.0041, -0.0258], [0.0041, -0.0248], [0.0048, -0.0243], [0.00475, 0.0075], [0.0034, 0.0105], [0.0031, 0.0155], [0.0031, 0.0165]], 20);
    const bl = lathe([[0.0029, 0.0155], [0.0029, 0.022], [0.0025, 0.030], [0.0015, 0.0365], [0.0004, 0.0395], [0, 0.0397]], 20);
    xf(cs, [x, y, 0], [tilt, 0, 0]); xf(bl, [x, y, 0], [tilt, 0, 0]);
    A.add('brass', cs); A.add('copper', bl);
  };
  round(0.0036, top + 0.0045, 3);
  round(-0.0036, top - 0.0015, 3);
  return A;
}

export function buildRifle(mats, layer) {
  const A = new Assembly();
  const root = new THREE.Group();
  root.name = 'rifle';
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

  // ============================================================== UPPER RECEIVER
  const upOut = fillet([[0, -0.013], [0.183, -0.013], [0.183, 0.0212], [0, 0.0212]], [0.0015, 0.0012, 0.0008, 0.0008], 3);
  A.add('anod', sideX(upOut, 0.0165, { cx: -0.0125 + 0.0165 / 2, bevel: 0.0012 }));
  // right wall with the ejection port
  const port = rrect(0.096, 0.0018, 0.066, 0.0185, 0.0028);
  A.add('anod', sideX(upOut, 0.0085, { cx: 0.004 + 0.0085 / 2, bevel: 0.0012, holes: [port] }));
  // port interior darkness + bolt carrier behind it
  A.add('cavity', box(0.0006, 0.0185, 0.066, 0.0002), [0.0045, 0.0018, -0.096]);
  // front "barrel nut" boss
  A.add('anod', lathe([[0.0, 0.176], [0.0150, 0.176], [0.0165, 0.1775], [0.0165, 0.1895], [0.015, 0.191], [0, 0.191]], 28));
  // upper receiver rear "hump" (charging-handle channel sides)
  A.add('anod', sideX(fillet([[0.0, 0.010], [0.012, 0.010], [0.012, 0.0214], [0.0, 0.0214]], 0.001, 2), 0.0255, { bevel: 0.0009 }));
  // brass deflector (right, behind the port)
  A.add('anod', sideX(fillet([[0.042, -0.006], [0.059, -0.006], [0.060, 0.016], [0.051, 0.018], [0.044, 0.010]], 0.002, 3), 0.0062, { cx: 0.0125 + 0.0024, bevel: 0.0014 }));
  // forward assist housing + plunger (right rear, angled back-out)
  {
    const fa = lathe([[0, 0], [0.0078, 0], [0.0078, 0.018], [0.0072, 0.019], [0.0072, 0.021], [0.0078, 0.022], [0.0078, 0.024], [0.0072, 0.0248], [0, 0.0248]], 26);
    xf(fa, [0.0105, 0.0055, -0.061], [0, -150, 0]);
    A.add('anod', fa);
    const btn = lathe([[0, 0.022], [0.0058, 0.022], [0.0058, 0.030], [0.0055, 0.0315], [0.0045, 0.0322], [0, 0.0325]], 24);
    xf(btn, [0.0105, 0.0055, -0.061], [0, -150, 0]);
    A.add('anod', btn);
    // grip grooves on the button
    for (let i = 0; i < 3; i++) {
      const gr = lathe([[0.0059, 0.0235 + i * 0.002], [0.0061, 0.0240 + i * 0.002], [0.0059, 0.0245 + i * 0.002]], 24);
      xf(gr, [0.0105, 0.0055, -0.061], [0, -150, 0]);
      A.add('anod', gr);
    }
  }
  // dust cover hinge rod
  A.add('steel', pin(0.0012, 0.078, 0.0003, 10, 'z'), [0.0133, -0.0092, -0.098]);

  // ============================================================== TOP RAIL (monolithic, receiver + handguard)
  const y0 = 0.0211;
  const railBase = [[-0.0082, y0], [0.0082, y0], [0.0082, y0 + 0.0019], [0.0106, y0 + 0.0043], [0.0106, y0 + 0.0047], [0.0089, y0 + 0.0064], [-0.0089, y0 + 0.0064], [-0.0106, y0 + 0.0047], [-0.0106, y0 + 0.0043], [-0.0082, y0 + 0.0019]];
  A.add('anod', alongZ(railBase.map((p) => new THREE.Vector2(p[0], p[1])), 0.004, 0.484, { bevel: 0.0005, seg: 2 }));
  const toothOutline = fillet([[-0.0089, y0 + 0.0060], [0.0089, y0 + 0.0060], [0.0080, y0 + 0.0073], [0.0080, y0 + 0.0094], [-0.0080, y0 + 0.0094], [-0.0080, y0 + 0.0073]], [0, 0, 0, 0.0004, 0.0004, 0], 2);
  const tooth = alongZ(toothOutline, 0, 0.00477, { bevel: 0.00055, seg: 2 });
  for (let u = 0.0068; u + 0.0048 < 0.482; u += 0.01) {
    const t = tooth.clone();
    t.translate(0, 0, -u);
    A.add('anod', t);
  }
  tooth.dispose();

  // ============================================================== CHARGING HANDLE (part)
  {
    const C = new Assembly();
    const ch = fillet([[-0.0056, 0.03], [-0.0056, -0.0035], [-0.0175, -0.0055], [-0.0215, -0.0105], [-0.018, -0.0175], [0.018, -0.0175], [0.0215, -0.0105], [0.0175, -0.0055], [0.0056, -0.0035], [0.0056, 0.03]], [0, 0.0012, 0.003, 0.003, 0.0025, 0.0025, 0.003, 0.003, 0.0012, 0], 3);
    C.add('anod', topY(ch, 0.0152, 0.0228, { bevel: 0.0011 }));
    // latch grip serrations
    for (const s of [-1, 1]) for (let i = 0; i < 4; i++) {
      C.add('anod', box(0.0012, 0.0012, 0.009, 0.0004), [s * (0.0105 + i * 0.0022), 0.0233, 0.0115]);
    }
    part('charge', C, new THREE.Vector3(0, 0.019, 0.01));
  }

  // ============================================================== BOLT CARRIER (part, visible through port)
  {
    const B = new Assembly();
    B.add('steel', lathe([[0.0, 0.056], [0.0075, 0.056], [0.0079, 0.057], [0.0079, 0.084], [0.0074, 0.0845], [0.0074, 0.0865], [0.0079, 0.087], [0.0079, 0.121], [0.0075, 0.122], [0.0, 0.122]], 28));
    // cam-pin window flat & gas key hint: a raised block on top
    B.add('steel', box(0.006, 0.004, 0.03, 0.0008), [0, 0.0085, -0.075]);
    // bolt head with lugs + extractor
    B.add('bright', lathe([[0, 0.121], [0.0062, 0.121], [0.0062, 0.131], [0.0058, 0.1325], [0, 0.1325]], 24));
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.3;
      B.add('bright', box(0.0026, 0.0024, 0.004, 0.0006), [Math.cos(a) * 0.0057, Math.sin(a) * 0.0057 + 0.0, -0.1345], [0, 0, (a * 180) / Math.PI]);
    }
    B.add('steel', box(0.0028, 0.0036, 0.016, 0.0007), [0.0064, 0.0015, -0.124]);
    part('bolt', B, new THREE.Vector3(0, 0, 0));
  }

  // ============================================================== DUST COVER (part, hinged, open)
  {
    const D = new Assembly();
    const dc = sideX(fillet([[0.063, -0.0092], [0.129, -0.0092], [0.129, 0.0105], [0.063, 0.0105]], [0.0015, 0.0015, 0.003, 0.003], 3), 0.0011, { cx: 0.0133, bevel: 0.0004, seg: 2 });
    D.add('anod', dc);
    D.add('anod', box(0.0016, 0.0035, 0.008, 0.0005), [0.0142, 0.0065, -0.12]); // latch bump
    const p = part('dustCover', D, new THREE.Vector3(0.0133, -0.0092, -0.096));
    p.rotation.z = -2.8; // swung open, hanging against the lower
  }

  // ============================================================== LOWER RECEIVER
  const lowOut = fillet([
    [-0.026, 0.0150], [-0.026, -0.030], [-0.016, -0.0385], [0.004, -0.0385], [0.170, -0.0385],
    [0.174, -0.030], [0.176, -0.0165], [0.168, -0.0128], [-0.002, -0.0128], [-0.002, 0.0150],
  ], [0.004, 0.006, 0.004, 0, 0, 0.003, 0.003, 0.001, 0.001, 0.002], 3);
  A.add('anod', sideX(lowOut, 0.0236, { bevel: 0.0014 }));
  // magwell (wider) with flare
  const mw = fillet([[0.0845, -0.030], [0.0845, -0.0675], [0.0805, -0.0745], [0.1625, -0.0745], [0.1605, -0.0675], [0.1605, -0.036], [0.1685, -0.030]], [0, 0.003, 0.0015, 0.0015, 0.003, 0.004, 0], 3);
  A.add('anod', sideX(mw, 0.0305, { bevel: 0.0017 }));
  // magwell side scallops / front grip ridges
  for (let i = 0; i < 4; i++) {
    A.add('anod', box(0.0318, 0.0022, 0.0035, 0.0008), [0, -0.046 - i * 0.0055, -(0.1618)]);
  }
  // magwell opening (dark)
  A.add('cavity', box(0.0236, 0.0008, 0.0634, 0.0002), [0, -0.0748, -0.121]);
  // bolt-catch boss & mag-release fence (right)
  A.add('anod', sideX(fillet([[0.071, -0.038], [0.082, -0.038], [0.0845, -0.030], [0.0845, -0.019], [0.074, -0.019]], 0.002, 2), 0.028, { bevel: 0.0012 }));
  A.add('anod', sideX(fillet([[0.074, -0.0395], [0.092, -0.0395], [0.092, -0.0375], [0.074, -0.0375]], 0.0006, 1), 0.0265, { bevel: 0.0005 }));
  // rear takedown / sling plate / buffer tower ring
  A.add('anod', lathe([[0, -0.026], [0.0158, -0.026], [0.0172, -0.0275], [0.0172, -0.0345], [0.0158, -0.036], [0, -0.036]], 30)); // castle nut
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
    A.add('cavity', box(0.003, 0.0028, 0.0034, 0.0003), [Math.cos(a) * 0.0165, Math.sin(a) * 0.0165, 0.031], [0, 0, (a * 180) / Math.PI]);
  }
  A.add('steel', sideX(fillet([[-0.0262, -0.024], [-0.0232, -0.024], [-0.0232, 0.0165], [-0.0262, 0.0165]], 0.001, 2), 0.030, { bevel: 0.0006 })); // end plate
  // QD socket on the end plate (left)
  {
    const qd = lathe([[0.0, 0.0], [0.0055, 0.0], [0.0058, 0.0006], [0.0058, 0.0045], [0.0052, 0.005], [0.0032, 0.005], [0.0032, 0.004], [0, 0.004]], 20);
    xf(qd, [-0.0165, -0.012, 0.0247], [0, -90, 0]);
    A.add('steel', qd);
  }

  // pins (both sides): rear takedown, front pivot, trigger, hammer, bolt catch roll pin
  const pins = [[-0.010, -0.004, 0.0032], [0.1665, -0.0215, 0.0032], [0.041, -0.0305, 0.0024], [0.0615, -0.0265, 0.0024]];
  for (const [u, v, r] of pins) A.add('steel', pin(r, 0.0252, 0.0005, 18, 'x'), [0, v, -u]);
  A.add('steel', pin(0.0012, 0.0295, 0.0003, 10, 'x'), [0, -0.0205, -0.0775]);

  // ============================================================== TRIGGER GUARD
  {
    const outer = fillet([[0.004, -0.0365], [0.004, -0.046], [0.012, -0.0585], [0.074, -0.0585], [0.0845, -0.050], [0.0845, -0.0365]], [0, 0.004, 0.006, 0.006, 0.004, 0], 3);
    const hole = fillet([[0.0095, -0.0392], [0.0095, -0.046], [0.0155, -0.0528], [0.0715, -0.0528], [0.0785, -0.047], [0.0785, -0.0392]], 0.003, 3);
    A.add('anod', sideX(outer, 0.0102, { bevel: 0.0016, holes: [hole] }));
  }

  // ============================================================== TRIGGER (part)
  {
    const T = new Assembly();
    const tr = spline([[0.0375, -0.0355], [0.0445, -0.0355], [0.0455, -0.0415], [0.0438, -0.0475], [0.0405, -0.0515], [0.0378, -0.0513], [0.0395, -0.0475], [0.0405, -0.0420], [0.0393, -0.0375]], 40);
    T.add('steel', sideX(tr, 0.0048, { bevel: 0.0011, seg: 3 }));
    part('trigger', T, new THREE.Vector3(0, -0.0305, -0.041));
  }

  // ============================================================== SELECTOR (part, left side)
  {
    const S = new Assembly();
    S.add('steel', lathe([[0, 0], [0.0048, 0], [0.0052, 0.0006], [0.0052, 0.0022], [0.0046, 0.0028], [0, 0.0028]], 22), null, null);
    S.lists.get('steel')[0].rotateY(Math.PI / 2);
    S.lists.get('steel')[0].translate(-0.0118 - 0.0028, -0.0245, -0.0105);
    const lever = fillet([[0.0105, -0.0272], [0.027, -0.0262], [0.0285, -0.0245], [0.027, -0.0228], [0.0105, -0.0218]], [0.001, 0.0008, 0.0012, 0.0008, 0.001], 3);
    S.add('steel', sideX(lever, 0.0022, { cx: -0.0118 - 0.0036, bevel: 0.0006, seg: 2 }));
    for (let i = 0; i < 3; i++) S.add('steel', box(0.0012, 0.0045, 0.0007, 0.0003), [-0.0158 - 0.0006, -0.0245, -(0.022 + i * 0.0018)]);
    part('selector', S, new THREE.Vector3(-0.013, -0.0245, -0.0105));
  }
  // ambidextrous short lever (right)
  A.add('steel', sideX(fillet([[0.0065, -0.0265], [0.0145, -0.0258], [0.0155, -0.0245], [0.0145, -0.0232], [0.0065, -0.0225]], 0.0008, 2), 0.002, { cx: 0.0118 + 0.0014, bevel: 0.0005 }));
  // selector markings (paint dots)
  A.add('paintWhite', pin(0.0009, 0.0006, 0.0001, 10, 'x'), [-0.0121, -0.0145, -0.0105]);
  A.add('paintRed', pin(0.0009, 0.0006, 0.0001, 10, 'x'), [-0.0121, -0.0245, 0.0015]);
  A.add('paintWhite', pin(0.0009, 0.0006, 0.0001, 10, 'x'), [-0.0121, -0.0245, -0.0235]);

  // ============================================================== BOLT CATCH (part, left)
  {
    const K = new Assembly();
    const bc = fillet([[0.0715, -0.0165], [0.0835, -0.0155], [0.0865, -0.0215], [0.0855, -0.0295], [0.0805, -0.0305], [0.0785, -0.024], [0.0725, -0.021]], [0.0015, 0.002, 0.0015, 0.0015, 0.0015, 0.0015, 0.0015], 3);
    K.add('steel', sideX(bc, 0.0034, { cx: -0.0118 - 0.0017 - 0.0012, bevel: 0.0009 }));
    for (let i = 0; i < 4; i++) K.add('steel', box(0.0008, 0.0065, 0.0009, 0.0003), [-0.0172, -0.0235, -(0.0795 + i * 0.0017)]);
    part('boltCatch', K, new THREE.Vector3(-0.015, -0.0205, -0.0775));
  }

  // ============================================================== MAG RELEASE (part, right)
  {
    const M = new Assembly();
    const mr = lathe([[0, 0], [0.0046, 0], [0.0048, 0.0004], [0.0048, 0.0032], [0.0042, 0.0038], [0, 0.0039]], 22);
    mr.rotateY(-Math.PI / 2);
    M.add('steel', mr, [0.0118 + 0.0038, -0.0285, -0.084]);
    part('magRelease', M, new THREE.Vector3(0.0156, -0.0285, -0.084));
  }

  // ============================================================== PISTOL GRIP
  {
    const gp = spline([
      [0.021, -0.0335], [0.016, -0.046], [0.0065, -0.066], [0.0045, -0.0785], [-0.001, -0.090], [-0.008, -0.108],
      [-0.0125, -0.126], [-0.020, -0.1375], [-0.034, -0.140], [-0.0465, -0.1355], [-0.0465, -0.121], [-0.037, -0.090],
      [-0.030, -0.065], [-0.0295, -0.050], [-0.0355, -0.0415], [-0.034, -0.0355], [-0.022, -0.0335],
    ], 72, 0.5);
    A.add('polyTanStip', sideX(gp, 0.0300, { bevel: 0.0078, seg: 4, curveSeg: 8 }));
    // grip bottom cap (storage door)
    A.add('polyTan', sideX(spline([[-0.0135, -0.1285], [-0.019, -0.1395], [-0.034, -0.1425], [-0.047, -0.138], [-0.0485, -0.1335], [-0.034, -0.137], [-0.021, -0.135]], 32), 0.0255, { bevel: 0.002 }));
  }

  // ============================================================== BUFFER TUBE + STOCK
  A.add('anod', lathe([[0, -0.216], [0.0118, -0.216], [0.0146, -0.2135], [0.0146, -0.036], [0, -0.036]], 30));
  A.add('anod', alongZ(fillet([[-0.0035, -0.0180], [0.0035, -0.0180], [0.0035, -0.0128], [-0.0035, -0.0128]], 0.0008, 2), -0.21, -0.04, { bevel: 0.0006 }));
  {
    const st = spline([
      [-0.098, 0.0255], [-0.097, 0.0], [-0.099, -0.024], [-0.118, -0.030], [-0.170, -0.034], [-0.215, -0.042], [-0.252, -0.056],
      [-0.2775, -0.0655], [-0.2862, -0.0615], [-0.2865, -0.035], [-0.2865, 0.0], [-0.2862, 0.029], [-0.278, 0.0345],
      [-0.235, 0.0335], [-0.180, 0.0305], [-0.125, 0.0290], [-0.104, 0.0290],
    ], 80, 0.5);
    const lighten = fillet([[-0.160, -0.018], [-0.232, -0.023], [-0.255, -0.046], [-0.2, -0.033]], [0.005, 0.005, 0.004, 0.006], 4);
    A.add('polyTan', sideX(st, 0.0405, { bevel: 0.0072, seg: 4, curveSeg: 8, holes: [lighten] }));
    // butt pad (rubber)
    A.add('rubber', sideX(fillet([[-0.2855, -0.0655], [-0.2985, -0.0665], [-0.2995, 0.0335], [-0.2855, 0.0345]], [0.003, 0.004, 0.004, 0.003], 3), 0.0425, { bevel: 0.0042, seg: 3 }));
    // stock adjustment lever underneath the front
    A.add('polyBlack', sideX(fillet([[-0.103, -0.022], [-0.137, -0.024], [-0.137, -0.030], [-0.103, -0.029]], 0.0015, 2), 0.013, { bevel: 0.002 }));
    // QD sockets on the stock sides
    for (const s of [-1, 1]) {
      const q = lathe([[0.0, 0.0], [0.0068, 0.0], [0.0072, 0.0006], [0.0072, 0.003], [0.0066, 0.0036], [0.0036, 0.0036], [0.0036, 0.0028], [0, 0.0028]], 22);
      q.rotateY(s > 0 ? -Math.PI / 2 : Math.PI / 2);
      A.add('steel', q, [s * (0.0198), -0.006, 0.128]);
    }
  }

  // ============================================================== HANDGUARD (octagonal, M-LOK)
  {
    const U0 = 0.186, U1 = 0.4835, T = 0.0026;
    const slotsSide = [], slotsBottom = [], slotsCh = [];
    for (let i = 0; i < 7; i++) {
      const uc = 0.2155 + i * 0.0405;
      slotsSide.push(slot(uc, 0, 0.032, 0.0072, 5));
      slotsBottom.push(slot(uc, 0, 0.032, 0.0072, 5));
    }
    for (let i = 0; i < 3; i++) slotsCh.push(slot(0.3815 + i * 0.0405, 0, 0.032, 0.0066, 5));
    // panel: plate spanning (u0..u1) x (-w/2..w/2) in its own (u, v) plane, normal +x before roll
    const plate = (w, holes, rollDeg, cx, cy) => {
      const g = sideX(fillet([[U0, -w / 2], [U1, -w / 2], [U1, w / 2], [U0, w / 2]], [0.0008, 0.0008, 0.0008, 0.0008], 2), T, { bevel: 0.0008, seg: 2, holes });
      g.translate(-T / 2, 0, 0);
      const r = (rollDeg * Math.PI) / 180;
      g.rotateZ(r);
      g.translate(cx, cy, 0);
      return g;
    };
    const cy = -0.0025;
    A.add('anod', plate(0.0310, slotsSide, 0, 0.0215, cy));
    A.add('anod', plate(0.0310, slotsSide, 180, -0.0215, cy));
    A.add('anod', plate(0.0265, slotsBottom, -90, 0.0, -0.0265));
    A.add('anod', plate(0.0145, [], 45, 0.0170, 0.0170));
    A.add('anod', plate(0.0145, [], 135, -0.0170, 0.0170));
    A.add('anod', plate(0.0145, slotsCh, -45, 0.0170, -0.0220));
    A.add('anod', plate(0.0145, slotsCh, -135, -0.0170, -0.0220));
    A.add('anod', plate(0.0272, [], 90, 0.0, 0.0212));
    // interior liner (dark) so slots read as deep holes
    const inner = [[0.0102, 0.0187], [0.0187, 0.0102], [0.0187, -0.0147], [0.0102, -0.0237], [-0.0102, -0.0237], [-0.0187, -0.0147], [-0.0187, 0.0102], [-0.0102, 0.0187]];
    A.add('cavity', alongZ(inner.map((p) => new THREE.Vector2(p[0], p[1])), U0 + 0.004, U1 - 0.0015, { bevel: 0 }));
    // end rings
    const oct = (s) => [[0.0125, 0.0215], [0.0215, 0.0125], [0.0215, -0.0175], [0.0125, -0.0265], [-0.0125, -0.0265], [-0.0215, -0.0175], [-0.0215, 0.0125], [-0.0125, 0.0215]].map((p) => new THREE.Vector2(p[0] * s, cy + (p[1] - cy) * s));
    const ring = (u0, u1, s0, bevel) => alongZ(fillet(oct(s0).map((p) => [p.x, p.y]), 0.002, 2), u0, u1, { bevel, holes: [inner.map((p) => new THREE.Vector2(p[0], p[1] + 0.0))] });
    A.add('anod', ring(U1 - 0.006, U1 + 0.0012, 1.02, 0.0014));
    A.add('anod', ring(U0 - 0.004, U0 + 0.014, 1.035, 0.0016));
    // clamp screws on the rear ring (bottom) + M-LOK cap screws
    for (const s of [-1, 1]) {
      const sc = lathe([[0, 0], [0.0026, 0], [0.0028, 0.0004], [0.0028, 0.0022], [0.0024, 0.0026], [0, 0.0026]], 16);
      sc.rotateX(Math.PI / 2);
      A.add('steel', sc, [s * 0.007, -0.0275 - 0.0012, -(U0 + 0.005)]);
      A.add('cavity', box(0.0022, 0.0006, 0.0022, 0.0002), [s * 0.007, -0.0281 - 0.0022, -(U0 + 0.005)], [0, 45, 0]);
    }
    // QD socket on the handguard (left, front)
    const q = lathe([[0.0, 0.0], [0.0068, 0.0], [0.0072, 0.0006], [0.0072, 0.0034], [0.0066, 0.004], [0.0036, 0.004], [0.0036, 0.003], [0, 0.003]], 22);
    q.rotateY(Math.PI / 2);
    A.add('steel', q, [-0.0215 - 0.004, -0.0025, -0.468]);
    // barricade/hand stop, bottom front
    A.add('anod', sideX(fillet([[0.452, -0.0262], [0.472, -0.0262], [0.471, -0.034], [0.462, -0.036], [0.454, -0.0335]], 0.002, 3), 0.016, { bevel: 0.002 }));
  }

  // ============================================================== BARREL + MUZZLE BRAKE
  A.add('steel', lathe([[0.0079, 0.47], [0.0079, 0.537], [0, 0.537]], 28));
  A.add('steel', lathe([[0, 0.535], [0.0098, 0.535], [0.0106, 0.536], [0.0106, 0.542], [0.0098, 0.543], [0, 0.543]], 28)); // crush washer
  {
    const u0 = 0.543, u1 = 0.603;
    const wins = [rrect(0.5585, 0.0, 0.0085, 0.0118, 0.0018, 3), rrect(0.5755, 0.0, 0.0085, 0.0118, 0.0018, 3)];
    A.add('steel', sideX(fillet([[u0, -0.0112], [u1, -0.0112], [u1, 0.0112], [u0, 0.0112]], [0.001, 0.003, 0.003, 0.001], 3), 0.0206, { bevel: 0.0021, seg: 3, holes: wins }));
    // rounded top/bottom caps (make cross-section more cylindrical)
    for (const s of [-1, 1]) {
      A.add('steel', alongZ(fillet([[-0.0078, 0], [0.0078, 0], [0.0068, 0.0028], [0.0, 0.0038], [-0.0068, 0.0028]].map((p) => [p[0], p[1] * s]), 0.0006, 2), u0 + 0.0005, u1 - 0.004, { bevel: 0.0008 }), [0, s * 0.0106, 0]);
    }
    // top ports (compensator)
    for (let i = 0; i < 3; i++) A.add('cavity', box(0.0026, 0.0012, 0.0055, 0.0005), [0, 0.0148, -(0.581 + i * 0.0068)]);
    // bore & inner baffles (dark)
    A.add('cavity', lathe([[0.0058, u0 + 0.004], [0.0058, u1 + 0.0002], [0, u1 + 0.0002]], 20));
    // crown
    A.add('steel', lathe([[0.0068, u1 - 0.0005], [0.0082, u1 + 0.0004], [0.0058, u1 + 0.0004]], 24));
  }

  // ============================================================== VERTICAL GRIP
  {
    const vg = lathe([
      [0, 0], [0.0125, 0], [0.0135, 0.004], [0.0138, 0.012], [0.0142, 0.022], [0.0136, 0.028], [0.0145, 0.036], [0.0137, 0.043],
      [0.0147, 0.051], [0.0139, 0.058], [0.0149, 0.066], [0.0152, 0.076], [0.0156, 0.0815], [0.0148, 0.0855], [0.0105, 0.0875], [0, 0.0878],
    ], 30);
    xf(vg, [0, -0.0282, -0.338], [-78, 0, 0]);
    A.add('polyTanStip', vg);
    // M-LOK mount base
    A.add('polyTan', box(0.0205, 0.0055, 0.036, 0.0018), [0, -0.0285, -0.3365]);
    for (const s of [-0.012, 0.012]) A.add('steel', pin(0.0022, 0.0012, 0.0003, 12, 'y'), [0, -0.0314, -0.3365 + s]);
  }

  // ============================================================== HOLOGRAPHIC SIGHT ("HS-1")
  {
    const top = y0 + 0.0094; // rail top
    // base / mount
    A.add('anod', box(0.030, 0.0105, 0.100, 0.0022), [0, top + 0.0052, -0.096]);
    for (const s of [-1, 1]) A.add('anod', sideX(fillet([[0.052, top - 0.0085], [0.138, top - 0.0085], [0.140, top + 0.004], [0.050, top + 0.004]], 0.0015, 2), 0.004, { cx: s * 0.0128, bevel: 0.0011 }));
    // cross-bolt knurled knob (left)
    const knob = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const r = i % 2 === 0 ? 0.0078 : 0.0071;
      knob.push([0.118 + Math.cos(a) * r, top - 0.0015 + Math.sin(a) * r]);
    }
    A.add('anod', sideX(knob, 0.0065, { cx: -0.0175, bevel: 0.0007, seg: 2, crease: 30 }));
    A.add('anod', sideX(circle(0.118, top - 0.0015, 0.0045, 24), 0.0022, { cx: -0.0217, bevel: 0.0007 }));
    // electronics body
    A.add('anod', box(0.036, 0.0085, 0.094, 0.0028), [0, top + 0.0145, -0.098]);
    // hood
    const hc = 0.0665;
    const hoodOut = fillet([[-0.0225, hc - 0.020], [0.0225, hc - 0.020], [0.0225, hc + 0.013], [0.012, hc + 0.0215], [-0.012, hc + 0.0215], [-0.0225, hc + 0.013]], [0.003, 0.003, 0.006, 0.004, 0.004, 0.006], 4);
    const win = rrect(0, hc - 0.0005, 0.037, 0.028, 0.0032, 4); // wide window, thin hood walls (open sight picture)
    A.add('anod', alongZ(hoodOut, 0.054, 0.142, { bevel: 0.0018, seg: 3, holes: [win] }));
    // hood interior darker ring near the front (lens housing)
    A.add('cavity', alongZ(rrect(0, hc - 0.0005, 0.0375, 0.0285, 0.0032, 4), 0.131, 0.1335, { bevel: 0, holes: [rrect(0, hc - 0.0005, 0.034, 0.025, 0.003, 4)] }));
    // rear buttons (rubber) on the body
    for (const s of [-1, 1]) A.add('rubber', box(0.007, 0.0045, 0.003, 0.0014), [s * 0.0075, top + 0.0135, -0.0495]);
    A.add('rubber', box(0.005, 0.004, 0.003, 0.0013), [0, top + 0.0135, -0.0495]);
    // windage / elevation turrets (right side)
    {
      const tu = lathe([[0, 0], [0.0042, 0], [0.0044, 0.0005], [0.0044, 0.0028], [0.0038, 0.0034], [0, 0.0034]], 18);
      tu.rotateY(-Math.PI / 2);
      A.add('anod', tu, [0.0225, hc - 0.009, -0.118]);
    }
    const tu2 = lathe([[0, 0], [0.0042, 0], [0.0044, 0.0005], [0.0044, 0.0028], [0.0038, 0.0034], [0, 0.0034]], 18);
    tu2.rotateX(-Math.PI / 2);
    A.add('anod', tu2, [0, hc + 0.0215, -0.126]);
    // battery cap (left side of body)
    const bc = lathe([[0, 0], [0.0062, 0], [0.0066, 0.0006], [0.0066, 0.004], [0.006, 0.0046], [0, 0.0046]], 24);
    bc.rotateY(Math.PI / 2);
    A.add('anod', bc, [-0.018 - 0.0046, top + 0.0135, -0.085]);
    // glass panes: rear carries the infinity reticle, front is plain coated glass
    const pane = (u) => {
      const g = new THREE.PlaneGeometry(0.0377, 0.0287);
      g.translate(0, hc - 0.0005, -u);
      return g;
    };
    const rearPane = new THREE.Mesh(pane(0.064), mats.glass);
    rearPane.name = 'holo:reticle';
    rearPane.layers.set(layer);
    rearPane.frustumCulled = false;
    rearPane.renderOrder = 2;
    root.add(rearPane);
    parts.reticlePane = rearPane;
    const frontPane = new THREE.Mesh(pane(0.1325), mats.lens || mats.glass);
    frontPane.name = 'holo:front';
    frontPane.layers.set(layer);
    frontPane.frustumCulled = false;
    frontPane.renderOrder = 1;
    frontPane.visible = !!mats.lens;
    root.add(frontPane);
  }

  // ============================================================== MAGAZINE (part)
  {
    const M = buildMagAssembly();
    const g = M.build(mats, layer, 'mag');
    const mag = new THREE.Group();
    mag.name = 'mag';
    mag.add(...g.children);
    mag.position.copy(RIFLE_DIMS.magSeat);
    root.add(mag);
    parts.mag = mag;
  }

  // static body
  const body = A.build(mats, layer, 'rifleBody');
  root.add(...body.children);

  // sockets
  const sock = (name, p) => {
    const o = new THREE.Object3D();
    o.name = `socket:${name}`;
    o.position.copy(p);
    root.add(o);
    sockets[name] = o;
    return o;
  };
  sock('muzzle', RIFLE_DIMS.muzzle);
  sock('eject', RIFLE_DIMS.eject);
  sock('sight', RIFLE_DIMS.sightCenter);
  sock('magSeat', RIFLE_DIMS.magSeat);

  return { root, parts, sockets, dims: RIFLE_DIMS };
}

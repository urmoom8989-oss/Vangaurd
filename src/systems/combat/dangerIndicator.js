import * as THREE from 'three';

/**
 * Grenade danger indicator (modern-military-shooter style): for every live grenade within
 * `range` of the player, a small grenade glyph in a dark disc, drawn on top of everything (FX layer,
 * no depth test). On screen it hovers just above the grenade with a chevron pointing down at it;
 * off screen (or behind the player) it sits on a ring around the crosshair at the grenade's bearing
 * with a chevron pointing outward. It tints white -> red and pulses faster as the player gets closer
 * to the lethal radius and as the fuse runs out.
 *
 * The sprites are children of the camera (camera-space placement), so shot camera overrides move
 * them too. Zero allocations per frame; 4 pooled indicators.
 */
const MAX = 4;
const ICON_H = 0.052; // fraction of screen height
const ARROW_H = 0.026;
const RING = 0.15; // ring radius around the crosshair, fraction of screen height
const DEPTH = 1; // camera-space depth of the sprites (m)

function drawIcon(c) {
  const g = c.getContext('2d');
  const S = c.width;
  g.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2;
  // dark disc + thin rim
  g.fillStyle = 'rgba(8,9,10,0.55)';
  g.beginPath(); g.arc(cx, cy, S * 0.46, 0, Math.PI * 2); g.fill();
  g.lineWidth = S * 0.035;
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.beginPath(); g.arc(cx, cy, S * 0.43, 0, Math.PI * 2); g.stroke();
  // frag silhouette (white; tinted by the material colour)
  g.fillStyle = '#fff';
  const bw = S * 0.2, bh = S * 0.25, by = cy + S * 0.07;
  g.beginPath(); g.ellipse(cx, by, bw, bh, 0, 0, Math.PI * 2); g.fill();
  // fuse head
  g.fillRect(cx - S * 0.085, by - bh - S * 0.1, S * 0.17, S * 0.12);
  // lever (spoon) down the right side
  g.beginPath();
  g.moveTo(cx + S * 0.07, by - bh - S * 0.07);
  g.lineTo(cx + S * 0.2, by - bh - S * 0.02);
  g.quadraticCurveTo(cx + bw + S * 0.06, by - S * 0.05, cx + bw + S * 0.02, by + bh * 0.55);
  g.lineTo(cx + bw - S * 0.03, by + bh * 0.5);
  g.quadraticCurveTo(cx + bw, by - S * 0.06, cx + S * 0.12, by - bh + S * 0.02);
  g.closePath(); g.fill();
  // pull ring
  g.lineWidth = S * 0.028;
  g.strokeStyle = '#fff';
  g.beginPath(); g.arc(cx - S * 0.13, by - bh - S * 0.06, S * 0.06, 0, Math.PI * 2); g.stroke();
  // segmented body grooves (cut back out so it reads as a frag, not an egg)
  g.globalCompositeOperation = 'destination-out';
  g.lineWidth = S * 0.022;
  g.beginPath(); g.moveTo(cx - bw, by); g.lineTo(cx + bw, by); g.stroke();
  g.beginPath(); g.moveTo(cx, by - bh * 0.82); g.lineTo(cx, by + bh); g.stroke();
  g.globalCompositeOperation = 'source-over';
}

function drawArrow(c) {
  const g = c.getContext('2d');
  const S = c.width;
  g.clearRect(0, 0, S, S);
  // chevron pointing +Y (up in texture space = sprite "up"; rotated per indicator)
  g.fillStyle = '#fff';
  g.beginPath();
  g.moveTo(S * 0.5, S * 0.12);
  g.lineTo(S * 0.92, S * 0.78);
  g.lineTo(S * 0.5, S * 0.58);
  g.lineTo(S * 0.08, S * 0.78);
  g.closePath();
  g.fill();
}

function canvasTex(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

export function createDangerIndicator(ctx, { getGrenades, dangerRadius, lethalRadius }) {
  const root = new THREE.Group();
  root.name = 'combat_danger_indicator';
  const iconTex = canvasTex(128, drawIcon);
  const arrowTex = canvasTex(64, drawArrow);
  const items = [];
  const fx = ctx.layers?.FX ?? 2;
  for (let i = 0; i < MAX; i++) {
    const mk = (tex) => {
      const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, toneMapped: false, fog: false });
      const s = new THREE.Sprite(m);
      s.layers.set(fx);
      s.renderOrder = 10000;
      s.frustumCulled = false;
      s.visible = false;
      root.add(s);
      return s;
    };
    items.push({ icon: mk(iconTex), arrow: mk(arrowTex) });
  }
  let attached = false;
  let enabled = true;

  const _p = new THREE.Vector3();
  const _inv = new THREE.Matrix4();
  const _white = new THREE.Color(1, 1, 1);
  const _red = new THREE.Color(1.0, 0.16, 0.1);

  function hideFrom(k) { for (let i = k; i < MAX; i++) { items[i].icon.visible = false; items[i].arrow.visible = false; } }

  function update() {
    const cam = ctx.camera;
    if (!attached) { cam.add(root); attached = true; }
    const list = getGrenades();
    const ps = ctx.services.player.state;
    const eye = ps?.eye;
    if (!enabled || !eye || ps.alive === false || !list.length) { hideFrom(0); return; }
    cam.updateMatrixWorld();
    _inv.copy(cam.matrixWorld).invert();
    const tanV = Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
    const tanH = tanV * cam.aspect;
    const scrH = 2 * tanV * DEPTH; // screen height in camera units at DEPTH
    const t = ctx.time.t;
    let k = 0;
    for (let gi = 0; gi < list.length && k < MAX; gi++) {
      const g = list[gi];
      if (g.source === 'player' && g.age < 0.6) continue; // your own throw leaving your hand
      const dist = g.position.distanceTo(eye);
      if (dist > dangerRadius) continue;
      const it = items[k++];
      // urgency: proximity to the lethal radius and fuse left
      const prox = THREE.MathUtils.clamp(1 - (dist - lethalRadius * 0.45) / (dangerRadius - lethalRadius * 0.45), 0, 1);
      const fuse = THREE.MathUtils.clamp(1 - g.fuseLeft / 2.5, 0, 1);
      const urg = Math.max(prox, fuse * 0.8);
      const rate = 3 + urg * 9;
      const pulse = 0.5 + 0.5 * Math.cos(t * rate * Math.PI * 2);
      const fadeIn = THREE.MathUtils.clamp((dangerRadius - dist) / 1.2, 0, 1);
      // camera-space direction
      _p.copy(g.position).applyMatrix4(_inv);
      const inFront = _p.z < -0.2;
      let sx = 0, sy = 0; // normalized screen coords (-1..1)
      if (inFront) { sx = _p.x / (-_p.z * tanH); sy = _p.y / (-_p.z * tanV); }
      const onScreen = inFront && Math.abs(sx) < 0.86 && Math.abs(sy) < 0.8;
      let ix, iy, ax, ay, rot;
      if (onScreen) {
        // hover over the grenade, chevron pointing down at it
        ix = sx * tanH * DEPTH; iy = sy * tanV * DEPTH + scrH * (ICON_H * 0.5 + ARROW_H * 1.1);
        ax = sx * tanH * DEPTH; ay = sy * tanV * DEPTH + scrH * ARROW_H * 0.6;
        rot = Math.PI;
      } else if (inFront) {
        // ahead but outside the frame: pin to the frame edge, chevron pointing at the grenade
        const k = Math.min(0.74 / Math.max(1e-4, Math.abs(sx)), (sy < 0 ? 0.58 : 0.7) / Math.max(1e-4, Math.abs(sy)));
        const ex = sx * k * tanH * DEPTH, ey = sy * k * tanV * DEPTH;
        let bx = sx * tanH, by = sy * tanV;
        const bl = Math.hypot(bx, by) || 1;
        bx /= bl; by /= bl;
        const off = scrH * (ICON_H * 0.5 + ARROW_H * 0.55);
        ix = ex; iy = ey;
        ax = ex + bx * off; ay = ey + by * off;
        rot = Math.atan2(-bx, by);
      } else {
        // bearing in the horizontal plane (up on screen = in front of the player)
        let bx = _p.x, by = -_p.z;
        const bl = Math.hypot(bx, by) || 1;
        bx /= bl; by /= bl;
        const r = RING * scrH;
        ix = bx * r; iy = by * r;
        ax = bx * (r + scrH * (ICON_H * 0.5 + ARROW_H * 0.55)); ay = by * (r + scrH * (ICON_H * 0.5 + ARROW_H * 0.55));
        rot = Math.atan2(-bx, by);
      }
      it.icon.position.set(ix, iy, -DEPTH);
      it.arrow.position.set(ax, ay, -DEPTH);
      it.icon.scale.setScalar(scrH * ICON_H * (1 + 0.06 * pulse * urg));
      it.arrow.scale.setScalar(scrH * ARROW_H);
      it.arrow.material.rotation = rot;
      const im = it.icon.material, am = it.arrow.material;
      im.color.copy(_white).lerp(_red, Math.min(1, urg * 0.75 + pulse * urg * 0.35));
      am.color.copy(im.color);
      im.opacity = fadeIn * (0.82 + 0.18 * pulse);
      am.opacity = fadeIn * (0.7 + 0.3 * pulse);
      it.icon.visible = true;
      it.arrow.visible = true;
    }
    hideFrom(k);
  }

  function setEnabled(b) { enabled = !!b; if (!enabled) hideFrom(0); }

  function dispose() {
    root.removeFromParent();
    for (const it of items) { it.icon.material.dispose(); it.arrow.material.dispose(); }
    iconTex.dispose(); arrowTex.dispose();
  }

  return { root, update, setEnabled, dispose };
}

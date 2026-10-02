import { el, setText, setStyle, setOpacity, setClass, wrap360 } from './util.js';
import { DIAMOND } from './icons.js';

/**
 * Top-center compass strip. Bearing convention: 0 = north = -Z (player yaw 0), clockwise positive
 * (east = +X). The strip holds ticks for [-180, 540) degrees so any bearing can be centered without
 * wrapping seams; it is moved with a single transform per frame.
 */
const WIDTH_U = 640;
const SPAN_DEG = 100; // visible degrees across the window
const PPD_U = WIDTH_U / SPAN_DEG; // units per degree
const CARD = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
const MARKERS = 10;

export function createCompass(hud) {
  const root = el('div', 'od-compass', hud.layer);
  const win = el('div', 'win', root);
  el('div', 'baseline', win);
  const strip = el('div', 'strip', win);
  const markLayer = el('div', 'strip', win);
  el('div', 'caret', root);
  const brg = el('div', 'brg', root);

  // ticks / labels (static, positioned in u units via calc so they scale with CSS)
  let html = '';
  for (let d = -180; d < 540; d += 5) {
    const x = (d + 180) * PPD_U;
    const w = wrap360(d);
    const pos = `left:calc(var(--u) * ${x.toFixed(2)})`;
    if (CARD[w] !== undefined) {
      html += `<div class="tk m" style="${pos}"></div><div class="lb ${w % 90 === 0 ? 'c' : 'i'}" style="${pos}">${CARD[w]}</div>`;
    } else if (w % 15 === 0) {
      html += `<div class="tk m" style="${pos}"></div><div class="lb" style="${pos}">${w}</div>`;
    } else {
      html += `<div class="tk" style="${pos}"></div>`;
    }
  }
  strip.innerHTML = html;

  // marker pool: {el, kind, bearing, until, fadeFrom}
  const pool = [];
  for (let i = 0; i < MARKERS; i++) {
    const m = el('div', 'mk', markLayer);
    setOpacity(m, 0);
    pool.push({ el: m, kind: '', bearing: 0, alpha: 0, active: false, clampEdge: false });
  }

  let lastBrg = -1;

  /** Assign markers for this frame. items: [{kind, bearing(deg), alpha, clampEdge}] */
  function update(bearingDeg, items, itemCount) {
    const u = hud.hudU;
    const b = wrap360(bearingDeg);
    const tx = (WIDTH_U / 2 - (b + 180) * PPD_U) * u;
    setStyle(strip, 'transform', `translate3d(${Math.round(tx * 2) / 2}px,0,0)`);
    const rb = Math.round(b) % 360;
    if (rb !== lastBrg) {
      lastBrg = rb;
      setText(brg, String(rb).padStart(3, '0'));
    }

    // markers (positioned relative to the window, not the strip)
    const half = SPAN_DEG / 2 - 4;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      if (i >= itemCount) {
        setOpacity(p.el, 0);
        continue;
      }
      const it = items[i];
      let delta = wrap360(it.bearing - b + 180) - 180;
      let a = it.alpha;
      if (Math.abs(delta) > half) {
        if (!it.clampEdge) {
          setOpacity(p.el, 0);
          continue;
        }
        delta = Math.sign(delta) * half;
        a *= 0.65;
      }
      if (p.kind !== it.kind) {
        p.kind = it.kind;
        p.el.className = 'mk ' + it.kind;
        p.el.innerHTML = it.kind === 'obj' ? DIAMOND : '';
      }
      const x = (WIDTH_U / 2 + delta * PPD_U) * u;
      setStyle(p.el, 'transform', `translate3d(${x.toFixed(1)}px,0,0)`);
      // edge fade like the ticks
      const edge = 1 - Math.max(0, (Math.abs(delta) - half * 0.7) / (half * 0.3)) * 0.6;
      setOpacity(p.el, a * edge);
    }
  }

  function setAlpha(a) {
    setOpacity(root, a);
  }

  return { root, update, setAlpha, setClass: (c, on) => setClass(root, c, on) };
}

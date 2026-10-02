/**
 * hud/util.js — tiny DOM helpers with write-caching (only touch the DOM when a value changes).
 */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach. */
export const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp01(t), 3);
export const easeOutBack = (t) => {
  t = clamp01(t);
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
/** wrap angle (rad) to [-PI, PI] */
export const wrapPi = (a) => {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
};
/** wrap degrees to [0, 360) */
export const wrap360 = (d) => ((d % 360) + 360) % 360;

/** Create an element: el('div', 'cls a b', parent?, html?) */
export function el(tag, cls, parent, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  if (parent) parent.appendChild(n);
  return n;
}

/** Cached style/text writers: every node gets a small cache object. */
function cache(node) {
  return node.__odc || (node.__odc = Object.create(null));
}
export function setText(node, text) {
  const c = cache(node);
  if (c.text !== text) {
    c.text = text;
    node.textContent = text;
  }
}
export function setHTML(node, html) {
  const c = cache(node);
  if (c.html !== html) {
    c.html = html;
    node.innerHTML = html;
  }
}
export function setStyle(node, prop, value) {
  const c = cache(node);
  if (c[prop] !== value) {
    c[prop] = value;
    node.style[prop] = value;
  }
}
/** Opacity rounded to 1/200 to avoid needless style writes. */
export function setOpacity(node, v) {
  const q = Math.round(clamp01(v) * 200) / 200;
  const c = cache(node);
  if (c.opacity !== q) {
    c.opacity = q;
    node.style.opacity = String(q);
    // fully transparent -> skip paint/compositing entirely
    const vis = q <= 0 ? 'hidden' : '';
    if (c.visibility !== vis) {
      c.visibility = vis;
      node.style.visibility = vis;
    }
  }
}
export function setClass(node, cls, on) {
  const c = cache(node);
  const key = 'cls:' + cls;
  if (c[key] !== on) {
    c[key] = on;
    node.classList.toggle(cls, on);
  }
}
export function setAttr(node, name, value) {
  const c = cache(node);
  const key = 'attr:' + name;
  if (c[key] !== value) {
    c[key] = value;
    node.setAttribute(name, value);
  }
}
/** transform with rounding to 1/100 px/deg/scale */
export function setTransform(node, value) {
  setStyle(node, 'transform', value);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function formatInt(n) {
  n = Math.round(n || 0);
  const s = String(Math.abs(n));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return (n < 0 ? '-' : '') + out;
}

/** Pretty key label for a KeyboardEvent.code / Mouse code. */
export function keyLabel(code) {
  if (!code) return '—';
  const map = {
    Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', Mouse3: 'MB4', Mouse4: 'MB5',
    WheelUp: 'WHEEL ▲', WheelDown: 'WHEEL ▼', Space: 'SPACE', ShiftLeft: 'L-SHIFT', ShiftRight: 'R-SHIFT',
    ControlLeft: 'L-CTRL', ControlRight: 'R-CTRL', AltLeft: 'L-ALT', AltRight: 'R-ALT', Tab: 'TAB',
    Escape: 'ESC', Enter: 'ENTER', Backspace: 'BKSP', CapsLock: 'CAPS', ArrowUp: '↑', ArrowDown: '↓',
    ArrowLeft: '←', ArrowRight: '→', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[',
    BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  };
  if (map[code]) return map[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'NUM ' + code.slice(6);
  return code.toUpperCase();
}

/** Deterministic string hash -> 0..1 */
export function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

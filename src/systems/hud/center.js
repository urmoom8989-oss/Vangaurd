import { el, setOpacity, setStyle, setClass, clamp, clamp01, damp } from './util.js';

/**
 * Center cluster: fixed crosshair (constant screen-space layout), hitmarkers (hit / headshot / kill, with a punchy tick animation
 * driven by the UI clock) and the damage-direction arcs.
 */
const DEG = Math.PI / 180;

export function createCenter(hud) {
  const { ctx } = hud;
  const center = el('div', 'od-center', hud.layer);

  // ------------------------------------------------------------ damage arcs (below crosshair)
  const dmgWrap = el('div', 'od-dmg', center);
  dmgWrap.style.left = '0';
  dmgWrap.style.top = '0';
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '-500 -500 1000 1000');
  svg.innerHTML = `<defs>
    <linearGradient id="odDmgG" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#ff2a18" stop-opacity="0"/>
      <stop offset=".55" stop-color="#ff3a22" stop-opacity=".78"/>
      <stop offset="1" stop-color="#ff6a4a" stop-opacity=".95"/>
    </linearGradient></defs>`;
  dmgWrap.appendChild(svg);
  const arcs = [];
  const R0 = 176, R1 = 194, SPAN = 24; // radii (u) and half-span (deg)
  const arcPath = (() => {
    const p = (r, a) => `${(Math.sin(a * DEG) * r).toFixed(2)} ${(-Math.cos(a * DEG) * r).toFixed(2)}`;
    const tip = SPAN + 7;
    return `M ${p(R0, -SPAN)} A ${R0} ${R0} 0 0 1 ${p(R0, SPAN)} L ${p((R0 + R1) / 2, tip)} ` +
      `Q ${p(R1 + 6, SPAN * 0.5)} ${p(R1 + 4, 0)} Q ${p(R1 + 6, -SPAN * 0.5)} ${p((R0 + R1) / 2, -tip)} Z`;
  })();
  for (let i = 0; i < 6; i++) {
    const gEl = document.createElementNS(NS, 'g');
    gEl.innerHTML = `<path d="${arcPath}" fill="url(#odDmgG)"/><path d="M ${-4} ${-(R1 + 10)} L 4 ${-(R1 + 10)} L 0 ${-(R1 + 20)} Z" fill="#ff5238" opacity=".9"/>`;
    gEl.style.opacity = '0';
    gEl.style.visibility = 'hidden';
    svg.appendChild(gEl);
    arcs.push({ el: gEl, x: 0, z: 0, hasPos: false, angle: 0, age: 99, life: 2.4, strength: 1 });
  }

  // ------------------------------------------------------------ crosshair
  const xh = el('div', 'od-xh', center);
  const lines = {
    t: el('div', 'ln v', xh),
    b: el('div', 'ln v', xh),
    l: el('div', 'ln h', xh),
    r: el('div', 'ln h', xh),
  };
  const dot = el('div', 'dot', xh);

  // ------------------------------------------------------------ hitmarker
  const hm = el('div', 'od-hm', center);
  const ticks = [];
  for (let i = 0; i < 4; i++) {
    const t = el('div', 't', hm);
    const t2 = el('div', 't t2', hm);
    ticks.push({ t, t2, a: 45 + i * 90 });
  }
  setOpacity(hm, 0);

  const st = {
    spread: 0,
    gap: 0,
    alpha: 1,
    spreadOverride: null,
    overrideUntil: -1,
    hmAge: 99,
    hmKind: 'hit',
    hmLife: 0.22,
    hmScale: 1,
    kick: 0,
  };

  function hitmarker(kind) {
    if (ctx.settings.data.gameplay?.hitmarkers === false) return;
    const k = kind === 'kill' ? 'kill' : kind === 'headshot' ? 'headshot' : kind === 'headshot_kill' || kind === 'killhs' ? 'killhs' : 'hit';
    // a kill after a headshot in the same frame keeps the headshot flavour
    if (st.hmAge < 0.02 && st.hmKind === 'headshot' && k === 'kill') st.hmKind = 'killhs';
    else st.hmKind = k;
    st.hmAge = 0;
    st.hmLife = k === 'hit' ? 0.24 : k === 'headshot' ? 0.32 : 0.46;
    setClass(hm, 'kill', st.hmKind === 'kill' || st.hmKind === 'killhs');
    setClass(hm, 'hs', st.hmKind === 'headshot' || st.hmKind === 'killhs');
  }

  function damage(sourcePos, strength = 1) {
    // reuse the arc already pointing roughly the same way, else the oldest
    let best = null;
    let bestScore = -1;
    const p = ctx.services.player.state;
    let ang = 0;
    if (sourcePos) {
      const dx = sourcePos.x - p.position.x;
      const dz = sourcePos.z - p.position.z;
      ang = Math.atan2(dx, -dz);
    }
    for (const a of arcs) {
      let score = a.age;
      if (sourcePos && a.hasPos && a.age < a.life) {
        const d = Math.abs(Math.atan2(Math.sin(a.angle - ang), Math.cos(a.angle - ang)));
        if (d < 0.35) score = 1000;
      }
      if (score > bestScore) { bestScore = score; best = a; }
    }
    best.age = 0;
    best.life = 2.2 + strength * 0.6;
    best.strength = clamp(0.55 + strength * 0.6, 0.55, 1.15);
    if (sourcePos) {
      best.x = sourcePos.x;
      best.z = sourcePos.z;
      best.hasPos = true;
      best.angle = ang;
    } else best.hasPos = false;
  }

  /**
   * @param dt UI dt
   * @param info {spreadDeg, vfovDeg, ads, sprinting, reloading, visible, playerBearing(rad), px, pz}
   */
  function update(dt, info) {
    const u = hud.hudU;
    // ---------------- fixed, screen-space crosshair; weapon spread never changes its layout
    const g = 9 * u;
    if (g !== st.gap) {
      st.gap = g;
      const len = 11 * u;
      setStyle(lines.t, 'transform', `translate3d(0,${(-g - len).toFixed(1)}px,0)`);
      setStyle(lines.b, 'transform', `translate3d(0,${g.toFixed(1)}px,0)`);
      setStyle(lines.l, 'transform', `translate3d(${(-g - len).toFixed(1)}px,0,0)`);
      setStyle(lines.r, 'transform', `translate3d(${g.toFixed(1)}px,0,0)`);
    }
    // Keep the reticle completely steady and visible during ADS, sprint, and reload transitions.
    const want = info.visible && ctx.settings.data.gameplay?.crosshair !== false ? 1 : 0;
    st.alpha = damp(st.alpha, want, want < st.alpha ? 28 : 14, dt);
    setOpacity(xh, st.alpha);
    setOpacity(dot, st.alpha > 0.2 ? 0.9 : 0);
    setClass(xh, 'enemy', !!info.overEnemy);

    // ---------------- hitmarker
    if (st.hmAge < st.hmLife + 0.05) {
      st.hmAge += dt;
      const t = st.hmAge;
      const kill = st.hmKind === 'kill' || st.hmKind === 'killhs';
      // punch: fast expand then settle, ticks slide outward slightly as they fade
      const punch = t < 0.05 ? 1 + (kill ? 0.6 : 0.4) * (1 - t / 0.05) : 1;
      const fade = clamp01(1 - (t - st.hmLife * 0.55) / (st.hmLife * 0.45));
      const base = (kill ? 13 : 10) * u;
      const slide = (kill ? 7 : 4) * u * clamp01(t / st.hmLife);
      const off = base * punch + slide;
      for (const tk of ticks) {
        const a = tk.a * DEG;
        const x = Math.sin(a) * off;
        const y = -Math.cos(a) * off;
        const sc = kill ? 1.25 : 1;
        setStyle(tk.t, 'transform', `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) rotate(${(tk.a - 90).toFixed(0)}deg) scale(${(sc * (0.9 + 0.1 * punch)).toFixed(3)},1)`);
        if (st.hmKind === 'headshot' || st.hmKind === 'killhs') {
          const off2 = off + 13 * u;
          setStyle(tk.t2, 'transform', `translate3d(${(Math.sin(a) * off2).toFixed(1)}px,${(-Math.cos(a) * off2).toFixed(1)}px,0) rotate(${(tk.a - 90).toFixed(0)}deg)`);
        }
      }
      setOpacity(hm, fade);
    } else setOpacity(hm, 0);

    // ---------------- damage arcs
    for (const a of arcs) {
      if (a.age >= a.life) {
        if (a.visible) {
          a.visible = false;
          a.el.style.opacity = '0';
          a.el.style.visibility = 'hidden';
        }
        continue;
      }
      a.age += dt;
      const t = a.age / a.life;
      const alpha = clamp01(a.age < 0.06 ? a.age / 0.06 : 1 - Math.pow(t, 1.6)) * a.strength;
      let rel = 0;
      if (a.hasPos) {
        const dx = a.x - info.px, dz = a.z - info.pz;
        rel = Math.atan2(dx, -dz) - info.playerBearing;
      }
      const grow = 1 + 0.08 * (1 - clamp01(a.age / 0.15));
      a.visible = true;
      a.el.style.visibility = '';
      a.el.style.opacity = alpha.toFixed(3);
      a.el.setAttribute('transform', `rotate(${(rel / DEG).toFixed(1)}) scale(${grow.toFixed(3)})`);
    }
  }

  return {
    hitmarker,
    damage,
    update,
    setSpread(deg, holdSeconds = 0.25) {
      st.spreadOverride = deg;
      st.overrideUntil = hud.uiTime + holdSeconds;
    },
  };
}

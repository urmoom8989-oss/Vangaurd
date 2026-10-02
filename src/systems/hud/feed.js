import { el, setOpacity, setStyle, setText, setHTML, escapeHtml, clamp01, easeOutCubic, easeOutBack, formatInt } from './util.js';
import { weaponIcon, HEADSHOT, medalSvg } from './icons.js';

/**
 * Killfeed (top right), score/XP popups (below crosshair), medals (top center), banners (wave
 * announcements under the compass) and short toasts. All timing is on the HUD's UI clock.
 */
const FEED_MAX = 5;
const FEED_LIFE = 6.0;

export function createFeed(hud) {
  // ------------------------------------------------------------------------------ killfeed
  const feedRoot = el('div', 'od-feed', hud.layer);
  const rows = []; // {el, age}

  function killfeed({ killer = '', victim = '', weapon = '', headshot = false, killerTeam, victimTeam, kind } = {}) {
    const k = String(killer || '');
    const v = String(victim || '');
    const isMeK = hud.isPlayerName(k);
    const isMeV = hud.isPlayerName(v);
    const kCls = isMeK ? 'me' : (killerTeam || (hud.isEnemyName(k) ? 'enemy' : 'friendly')) === 'enemy' ? 'e' : 'f';
    const vCls = isMeV ? 'me' : (victimTeam || (hud.isEnemyName(v) ? 'enemy' : 'friendly')) === 'enemy' ? 'e' : 'f';
    const icon = weaponIcon(weapon, kind);
    const icls = /od-ico-(\w+)/.exec(icon)?.[1] || 'rifle';
    const row = el('div', 'row' + (isMeK || isMeV ? ' me' : ''));
    row.innerHTML =
      (k ? `<span class="nm ${kCls}">${escapeHtml(k)}</span>` : '') +
      `<span class="w ${icls}">${icon}</span>` +
      (headshot ? `<span class="hs">${HEADSHOT}</span>` : '') +
      `<span class="nm ${vCls}">${escapeHtml(v)}</span>`;
    feedRoot.insertBefore(row, feedRoot.firstChild);
    rows.unshift({ el: row, age: 0 });
    while (rows.length > FEED_MAX + 1) rows.pop().el.remove();
    setOpacity(row, 0);
  }

  // ------------------------------------------------------------------------------ xp popups
  const xpRoot = el('div', 'od-xp', hud.layer);
  const xpTot = el('div', 'tot', xpRoot);
  const xpLines = el('div', 'lines', xpRoot);
  const xpLinePool = [];
  for (let i = 0; i < 4; i++) {
    const ln = el('div', 'ln', xpLines);
    xpLinePool.push({ el: ln, text: '', pts: 0, age: 99 });
  }
  const xp = { total: 0, shown: 0, age: 99, pop: 99, lines: [] };
  setOpacity(xpRoot, 0);

  function scorePopup(points, label = '') {
    points = Math.round(points || 0);
    if (xp.age > 2.4) {
      xp.total = 0;
      xp.shown = 0;
      xp.lines.length = 0;
    }
    xp.total += points;
    xp.age = 0;
    xp.pop = 0;
    if (label) {
      const exist = xp.lines.find((l) => l.text === label);
      if (exist) {
        exist.pts += points;
        exist.count++;
        exist.age = 0;
      } else {
        xp.lines.unshift({ text: label, pts: points, age: 0, count: 1 });
        if (xp.lines.length > 4) xp.lines.pop();
      }
    }
  }

  // ------------------------------------------------------------------------------ medals
  const medalRoot = el('div', 'od-medal', hud.layer);
  const medalIc = el('div', 'ic', medalRoot);
  const medalTt = el('div', 'tt', medalRoot);
  const medalSb = el('div', 'sb', medalRoot);
  setOpacity(medalRoot, 0);
  const medalQueue = [];
  let medal = null; // {title, sub, kind, tier, age, life}

  function pushMedal(m) {
    // replace a queued medal of the same kind (multi-kill escalation) instead of stacking
    const i = medalQueue.findIndex((q) => q.kind === m.kind && m.kind === 'multi');
    if (i >= 0) medalQueue.splice(i, 1);
    if (medal && medal.kind === 'multi' && m.kind === 'multi' && medal.age < medal.life * 0.8) {
      medal = { ...m, age: 0, life: m.life || 2.3 };
      showMedal();
      return;
    }
    medalQueue.push({ ...m, life: m.life || 2.3 });
    if (medalQueue.length > 4) medalQueue.shift();
  }
  function showMedal() {
    medalIc.innerHTML = medalSvg(medal.kind, medal.tier ?? 1, medal.count ?? 0);
    setText(medalTt, medal.title || '');
    setText(medalSb, medal.sub || '');
  }

  // ------------------------------------------------------------------------------ banner
  const banner = el('div', 'od-banner', hud.layer);
  const banKk = el('div', 'kk', banner);
  const banTt = el('div', 'tt', banner);
  const banRule = el('div', 'rule', banner);
  const banSb = el('div', 'sb', banner);
  setOpacity(banner, 0);
  let ban = null; // {age, life}
  const banQueue = [];

  function pushBanner(title, { sub = '', kicker = '', warn = false, duration = 3.2 } = {}) {
    banQueue.push({ title, sub, kicker, warn, life: duration });
    if (banQueue.length > 3) banQueue.shift();
  }

  // ------------------------------------------------------------------------------ toast
  const toast = el('div', 'od-toast', hud.layer);
  setOpacity(toast, 0);
  let toastT = { age: 99, life: 1.6 };
  function pushToast(text, { warn = false, duration = 1.8 } = {}) {
    setText(toast, text);
    toast.classList.toggle('warn', warn);
    toastT = { age: 0, life: duration };
  }

  // ------------------------------------------------------------------------------ update
  function update(dt) {
    const u = hud.hudU;
    // killfeed
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      r.age += dt;
      const inT = clamp01(r.age / 0.16);
      const over = i >= FEED_MAX;
      const life = over ? Math.min(r.age, 0.2) : r.age;
      let a = easeOutCubic(inT) * clamp01((FEED_LIFE - life) / 0.6);
      if (over) a = Math.min(a, 0);
      setOpacity(r.el, a);
      setStyle(r.el, 'transform', `translate3d(${((1 - easeOutCubic(inT)) * 40 * u).toFixed(1)}px,0,0)`);
    }
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].age > FEED_LIFE || i >= FEED_MAX + 1) {
        rows[i].el.remove();
        rows.splice(i, 1);
      }
    }

    // xp
    if (xp.age < 3) {
      xp.age += dt;
      xp.pop += dt;
      xp.shown += (xp.total - xp.shown) * (1 - Math.exp(-22 * dt));
      if (Math.abs(xp.total - xp.shown) < 0.5) xp.shown = xp.total;
      setText(xpTot, `+${formatInt(Math.round(xp.shown))}`);
      const pop = xp.pop < 0.12 ? 1 + 0.28 * (1 - xp.pop / 0.12) : 1;
      setStyle(xpTot, 'transform', `scale(${pop.toFixed(3)})`);
      setOpacity(xpRoot, clamp01(xp.age / 0.06) * clamp01((2.2 - xp.age) / 0.5));
      for (let i = 0; i < xpLinePool.length; i++) {
        const p = xpLinePool[i];
        const l = xp.lines[i];
        if (!l) { setOpacity(p.el, 0); continue; }
        l.age += dt;
        const txt = `${l.text}${l.count > 1 ? ' ×' + l.count : ''}`;
        setHTML(p.el, `${escapeHtml(txt)}${l.pts ? `<b>+${formatInt(l.pts)}</b>` : ''}`);
        const inT = clamp01(l.age / 0.14);
        setOpacity(p.el, easeOutCubic(inT) * (1 - i * 0.12));
        setStyle(p.el, 'transform', `translate3d(0,${((1 - easeOutCubic(inT)) * 8 * u).toFixed(1)}px,0)`);
      }
    } else setOpacity(xpRoot, 0);

    // medals
    if (!medal && medalQueue.length) {
      medal = medalQueue.shift();
      medal.age = 0;
      showMedal();
    }
    if (medal) {
      medal.age += dt;
      const t = medal.age;
      const inT = clamp01(t / 0.28);
      const s = 0.55 + 0.45 * easeOutBack(inT);
      const out = clamp01((medal.life - t) / 0.35);
      setOpacity(medalRoot, clamp01(t / 0.1) * out);
      setStyle(medalIc, 'transform', `scale(${(s * (1 + (1 - out) * 0.1)).toFixed(3)})`);
      setStyle(medalRoot, 'transform', `translate3d(0,${((1 - out) * -10 * u).toFixed(1)}px,0)`);
      if (t >= medal.life) {
        medal = null;
        setOpacity(medalRoot, 0);
      }
    }

    // banner
    if (!ban && banQueue.length) {
      ban = banQueue.shift();
      ban.age = 0;
      setText(banTt, ban.title);
      setText(banSb, ban.sub);
      setText(banKk, ban.kicker);
      banTt.classList.toggle('warn', !!ban.warn);
      banKk.style.display = ban.kicker ? '' : 'none';
      banSb.style.display = ban.sub ? '' : 'none';
    }
    if (ban) {
      ban.age += dt;
      const t = ban.age;
      const inT = easeOutCubic(clamp01(t / 0.5));
      const out = clamp01((ban.life - t) / 0.5);
      setOpacity(banner, clamp01(t / 0.2) * out);
      setStyle(banTt, 'letterSpacing', `${(0.22 + (1 - inT) * 0.3).toFixed(3)}em`);
      setStyle(banRule, 'transform', `scaleX(${inT.toFixed(3)})`);
      if (t >= ban.life) {
        ban = null;
        setOpacity(banner, 0);
      }
    }

    // toast
    if (toastT.age < toastT.life) {
      toastT.age += dt;
      setOpacity(toast, clamp01(toastT.age / 0.1) * clamp01((toastT.life - toastT.age) / 0.4));
    } else setOpacity(toast, 0);
  }

  return { killfeed, scorePopup, pushMedal, pushBanner, pushToast, update, get medalActive() { return !!medal; } };
}

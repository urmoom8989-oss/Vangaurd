import { el, setOpacity, setStyle, setText, setHTML, setClass, clamp01, damp, formatInt, keyLabel, escapeHtml, smooth } from './util.js';
import { FRAG, STUN, FIREMODE_AUTO, FIREMODE_BURST, FIREMODE_SEMI, DIAMOND } from './icons.js';

/**
 * Bottom-right ammo cluster, bottom-left vitals (score / health / lives), top-left match panel
 * (objective, wave, hostiles), center prompts (reload / interaction) and the blood-edge overlay.
 */
export function createPanels(hud) {
  const { ctx } = hud;

  // ================================================================= blood overlay (under everything)
  const blood = el('div', 'od-blood', hud.layer);
  const flash = el('div', 'od-flash', hud.layer);
  hud.layer.insertBefore(flash, hud.layer.firstChild);
  hud.layer.insertBefore(blood, hud.layer.firstChild);
  setOpacity(blood, 0);
  setOpacity(flash, 0);
  // two layers: a backdrop-filter red grade (acts like a multiply over the live frame, masked to the
  // screen edges) and a colour rim with clots/veins on top. See .od-blood / .od-blood-rim in style.js.
  const bloodTex = makeBloodTexture(ctx.rng.fork('hud-blood'));
  const bloodRim = el('div', 'od-blood-rim', blood);
  bloodRim.style.backgroundImage = `url(${bloodTex.color})`;
  blood.style.webkitMaskImage = blood.style.maskImage = `url(${bloodTex.mask})`;

  // ================================================================= ammo
  const ammo = el('div', 'od-ammo', hud.layer);
  const wname = el('div', 'wname', ammo);
  const wnameText = el('span', '', wname);
  const fm = el('span', 'fm', wname);
  const fmIco = el('span', 'i', fm);
  const fmText = el('span', '', fm);
  const row = el('div', 'row', ammo);
  const magEl = el('div', 'mag', row);
  el('div', 'sep', row);
  const resEl = el('div', 'res', row);
  const bar = el('div', 'bar', ammo);
  el('div', 'tr', bar);
  const barFill = el('div', 'fl', bar);
  const barReload = el('div', 'rl', bar);
  const barGaps = el('div', 'gaps', bar);
  const equip = el('div', 'equip', ammo);
  const eqL = el('div', 'eq', equip);
  const eqLIco = el('span', 'i', eqL, FRAG);
  const eqLN = el('span', 'n', eqL);
  const eqLK = el('span', 'k', eqL);
  const eqT = el('div', 'eq', equip);
  const eqTIco = el('span', 'i', eqT, STUN);
  const eqTN = el('span', 'n', eqT);
  const eqTK = el('span', 'k', eqT);
  void eqLIco; void eqTIco;

  // ================================================================= vitals
  const vit = el('div', 'od-vitals', hud.layer);
  const score = el('div', 'score', vit);
  el('span', 'k', score).textContent = 'SCORE';
  const scoreV = el('span', 'v', score);
  const streakV = el('span', 's', score);
  const hp = el('div', 'hp', vit);
  const hpLag = el('div', 'l', hp);
  const hpFill = el('div', 'f', hp);
  el('div', 'seg', hp);
  const lives = el('div', 'lives', vit);

  // ================================================================= match panel
  const match = el('div', 'od-match', hud.layer);
  const obj = el('div', 'obj', match);
  el('span', 'd', obj, DIAMOND);
  const objText = el('span', '', obj);
  const wave = el('div', 'wave', match);
  const waveK = el('span', 'k', wave);
  waveK.textContent = 'WAVE';
  const waveN = el('span', 'n', wave);
  const waveH = el('span', 'h', wave);
  const timer = el('div', 'timer', match);

  // ================================================================= prompts
  const reload = el('div', 'od-prompt reload', hud.layer);
  const interact = el('div', 'od-prompt interact', hud.layer);
  setOpacity(reload, 0);
  setOpacity(interact, 0);

  const st = {
    weaponId: null, weaponName: '', lastAmmo: -1, lastRes: -1, activity: 0, magSize: 0,
    ammoAlpha: 1, vitAlpha: 1, hpShown: 1, hpLag: 1, hpAge: 99, lastHp: -1,
    matchAlpha: 1, interaction: null, interactAge: 99, reloadAlpha: 0, bloodA: 0, flashA: 0,
    fmode: '', lastScore: -1,
  };

  function bindLabel(action) {
    return keyLabel(ctx.input?.bindings?.[action]?.[0]);
  }

  function damageFlash(amount) {
    st.flashA = Math.min(1, st.flashA + 0.35 + amount / 45);
  }

  function setInteraction(text, opts = {}) {
    if (!text) {
      st.interaction = null;
      return;
    }
    st.interaction = { text: String(text), key: opts.key || bindLabel(opts.action || 'interact'), progress: opts.progress ?? null };
    st.interactAge = 0;
  }

  // ----------------------------------------------------------------------------------- update
  function update(dt, info) {
    const u = hud.hudU;
    const ws = info.weapon;
    const ps = info.player;

    // ---------------- ammo
    const hasWeapon = !!ws.id;
    if (ws.id !== st.weaponId || ws.name !== st.weaponName) {
      st.weaponId = ws.id;
      st.weaponName = ws.name;
      setText(wnameText, (ws.name || '').toUpperCase());
      st.activity = 0;
    }
    const mode = String(ws.fireMode || 'auto').toLowerCase();
    if (mode !== st.fmode) {
      st.fmode = mode;
      setHTML(fmIco, mode.startsWith('semi') || mode === 'single' ? FIREMODE_SEMI : mode.startsWith('burst') ? FIREMODE_BURST : FIREMODE_AUTO);
      setText(fmText, mode.startsWith('semi') || mode === 'single' ? 'SEMI' : mode.startsWith('burst') ? 'BURST' : 'AUTO');
    }
    const magSize = ws.magSize || 0;
    const ammoN = Math.max(0, ws.ammo | 0);
    const resN = Math.max(0, ws.reserve | 0);
    if (ammoN !== st.lastAmmo || resN !== st.lastRes) {
      st.lastAmmo = ammoN;
      st.lastRes = resN;
      st.activity = 0;
      setText(magEl, String(ammoN));
      setText(resEl, String(resN));
    }
    const lowFrac = magSize ? ammoN / magSize : 1;
    const low = magSize > 0 && lowFrac <= 0.3;
    setClass(magEl, 'low', low && ammoN > 0);
    setClass(magEl, 'empty', ammoN === 0 && magSize > 0);
    setClass(resEl, 'low', magSize > 0 && resN <= magSize);
    if (magSize !== st.magSize) {
      st.magSize = magSize;
      if (magSize > 0 && magSize <= 60) {
        const seg = (200 / magSize).toFixed(3);
        barGaps.style.background = `repeating-linear-gradient(90deg, transparent 0, transparent calc(var(--u) * ${seg} - var(--u) * 1.4), rgba(0,0,0,.7) calc(var(--u) * ${seg} - var(--u) * 1.4), rgba(0,0,0,.7) calc(var(--u) * ${seg}))`;
      } else barGaps.style.background = 'none';
    }
    setStyle(barFill, 'width', `${(clamp01(lowFrac) * 100).toFixed(2)}%`);
    setClass(barFill, 'low', low);
    const rp = ws.reloading ? clamp01(ws.reloadProgress || 0) : 0;
    setStyle(barReload, 'width', `${(rp * 100).toFixed(1)}%`);
    setOpacity(barReload, ws.reloading ? 0.9 : 0);

    const lethal = countOf(ws.lethal ?? ws.grenades ?? ws.equipment?.lethal, 1);
    const tactical = countOf(ws.tactical ?? ws.equipment?.tactical, 1);
    setText(eqLN, String(lethal));
    setText(eqTN, ws.grenadeType ? String(ws.grenadeType).toUpperCase() : String(tactical));
    setText(eqLK, bindLabel('grenade'));
    setText(eqTK, ws.grenadeType ? `${bindLabel('tactical')} CHANGE` : bindLabel('tactical'));
    setClass(eqL, 'zero', lethal === 0);
    setClass(eqT, 'zero', tactical === 0);

    st.activity += dt;
    if (ws.action === 'fire' || ws.reloading || ws.ads > 0.5) st.activity = 0;
    const ammoTarget = !hasWeapon ? 0 : st.activity < 4 || low ? 1 : 0.6;
    st.ammoAlpha = damp(st.ammoAlpha, ammoTarget * info.visible, 6, dt);
    setOpacity(ammo, st.ammoAlpha);

    // ---------------- vitals
    const maxHp = ps.maxHealth || 100;
    const frac = clamp01((ps.health ?? maxHp) / maxHp);
    if (ps.health !== st.lastHp) {
      if (st.lastHp >= 0 && ps.health < st.lastHp) st.hpAge = 0;
      st.lastHp = ps.health;
    }
    st.hpAge += dt;
    st.hpShown = damp(st.hpShown, frac, 18, dt);
    st.hpLag = st.hpAge < 0.6 ? Math.max(st.hpLag, st.hpShown) : damp(st.hpLag, st.hpShown, 4, dt);
    if (st.hpLag < st.hpShown) st.hpLag = st.hpShown;
    setStyle(hpFill, 'transform', `scaleX(${st.hpShown.toFixed(4)})`);
    setStyle(hpLag, 'transform', `scaleX(${st.hpLag.toFixed(4)})`);
    setClass(hpFill, 'low', frac < 0.35);
    const hpVis = frac < 0.999 || st.hpAge < 3 ? 1 : 0;
    setOpacity(hp, damp(parseFloat(hp.__odc?.opacity ?? 1), hpVis, 5, dt));

    const sc = info.score;
    if (sc !== st.lastScore) {
      st.lastScore = sc;
      setText(scoreV, formatInt(sc));
    }
    setText(streakV, info.streak >= 2 ? `STREAK ${info.streak}` : '');
    const lv = info.lives;
    if (lv && lv.max > 0) {
      let h = '';
      for (let i = 0; i < lv.max; i++) h += `<i class="${i < lv.left ? '' : 'x'}"></i>`;
      h += `<span class="k">REINFORCEMENTS</span>`;
      setHTML(lives, h);
      setStyle(lives, 'display', '');
    } else setStyle(lives, 'display', 'none');
    st.vitAlpha = damp(st.vitAlpha, info.visible * (info.combatIdle > 6 && frac > 0.999 ? 0.7 : 1), 4, dt);
    setOpacity(vit, st.vitAlpha);

    // ---------------- match
    const m = info.match;
    setText(objText, m.objective || '');
    setStyle(obj, 'display', m.objective ? '' : 'none');
    if (m.wave != null) {
      setStyle(wave, 'display', '');
      setText(waveN, String(m.wave).padStart(2, '0'));
      setHTML(waveH, m.hostiles != null ? `<b>${m.hostiles}</b> HOSTILES` : '');
    } else setStyle(wave, 'display', 'none');
    setText(timer, m.timer || '');
    st.matchAlpha = damp(st.matchAlpha, info.visible * (info.combatIdle > 8 ? 0.75 : 1), 4, dt);
    setOpacity(match, st.matchAlpha);

    // ---------------- reload / ammo prompt
    let rText = '';
    let rCls = '';
    if (hasWeapon && info.alive && !ws.reloading && magSize > 0) {
      if (ammoN === 0 && resN === 0) { rText = 'NO AMMO'; rCls = 'none'; }
      else if (ammoN === 0 || lowFrac <= 0.25) { rText = resN > 0 ? 'RELOAD' : 'LOW AMMO'; rCls = ammoN === 0 ? 'none' : 'low'; }
    }
    if (rText) {
      const key = rText === 'RELOAD' ? `<span class="od-key">${escapeHtml(bindLabel('reload'))}</span>` : '';
      setHTML(reload, `${key}<span>${rText}</span>`);
      setClass(reload, 'low', rCls === 'low');
      setClass(reload, 'none', rCls === 'none');
    }
    // subtle blink for empty mag, steady otherwise
    const blink = rCls === 'none' ? 0.65 + 0.35 * Math.abs(Math.cos(hud.uiTime * Math.PI * 1.6)) : 1;
    st.reloadAlpha = damp(st.reloadAlpha, rText && info.visible ? 1 : 0, 14, dt);
    setOpacity(reload, st.reloadAlpha * blink * (1 - clamp01(ws.ads * 1.5) * 0.5));

    // ---------------- interaction prompt
    if (st.interaction) {
      st.interactAge += dt;
      const it = st.interaction;
      const key = `<span class="od-key">${escapeHtml(it.key)}</span>`;
      let keyHtml = key;
      if (it.progress != null) {
        // hold-to-use: circular progress wrapped around the key cap
        const p = clamp01(it.progress);
        const c = 2 * Math.PI * 18;
        keyHtml = `<span class="kr"><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" fill="rgba(8,10,12,.45)" stroke="rgba(236,240,234,.22)" stroke-width="3"/>` +
          `<circle cx="22" cy="22" r="18" fill="none" stroke="#f0c048" stroke-width="3" stroke-linecap="butt" stroke-dasharray="${(c * p).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 22 22)"/></svg>${key}</span>`;
      }
      const verb = it.progress != null ? '<span class="vb">Hold</span>' : '';
      setHTML(interact, `${verb}${keyHtml}<span>${escapeHtml(it.text)}</span>`);
      setOpacity(interact, clamp01(st.interactAge / 0.12) * info.visible);
    } else setOpacity(interact, 0);

    // ---------------- blood / flash
    const lowHp = ps.alive === false ? 0 : smooth(0.55, 0.15, frac);
    const beatRate = 1.1 + (1 - frac) * 1.1; // beats per second
    const ph = (hud.uiTime * beatRate) % 1;
    const beat = Math.pow(Math.max(0, Math.sin(ph * Math.PI * 2)), 6) * 0.22 + Math.pow(Math.max(0, Math.sin((ph - 0.18) * Math.PI * 2)), 8) * 0.12;
    st.bloodA = damp(st.bloodA, lowHp, lowHp > st.bloodA ? 6 : 1.5, dt);
    setOpacity(blood, Math.min(1, st.bloodA * (0.82 + beat)));
    st.flashA = Math.max(0, st.flashA - dt * 2.4);
    setOpacity(flash, st.flashA * 0.45);
    void u;
  }

  return { update, damageFlash, setInteraction, get interaction() { return st.interaction; } };
}

function countOf(v, dflt) {
  if (v == null) return dflt;
  if (typeof v === 'number') return Math.max(0, v | 0);
  if (typeof v === 'object') return Math.max(0, (v.count ?? v.amount ?? dflt) | 0);
  return dflt;
}

/**
 * Procedural blood-edge texture: a tight, irregular band hugging the frame (domain-warped fbm edge),
 * ridged-noise capillary veins reaching inward, clotted darker patches and fine splatter specks.
 * Colours stay deep crimson / near-black so it reads as blood over any scene, never a pink wash.
 */
function makeBloodTexture(rng) {
  const W = 960, H = 540;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  const img = g.createImageData(W, H);
  const d = img.data;
  const mimg = g.createImageData(W, H);
  const md = mimg.data;
  // value-noise lattice
  const S = 64;
  const lat = new Float32Array(S * S);
  for (let i = 0; i < lat.length; i++) lat[i] = rng.next();
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
    const i00 = ((yi & 63) * S) + (xi & 63), i10 = ((yi & 63) * S) + ((xi + 1) & 63);
    const i01 = (((yi + 1) & 63) * S) + (xi & 63), i11 = (((yi + 1) & 63) * S) + ((xi + 1) & 63);
    const a = lat[i00] + (lat[i10] - lat[i00]) * sx;
    const b = lat[i01] + (lat[i11] - lat[i01]) * sx;
    return a + (b - a) * sy;
  };
  const fbm = (x, y, oct) => {
    let v = 0, amp = 0.5, f = 1;
    for (let o = 0; o < oct; o++) { v += noise(x * f, y * f) * amp; f *= 2.03; amp *= 0.5; }
    return v;
  };
  const aspect = W / H;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = x / W, ny = y / H;
      const o = (y * W + x) * 4;
      // distance to nearest edge in "height" units, corners pulled in
      const ex = Math.min(nx, 1 - nx) * aspect;
      const ey = Math.min(ny, 1 - ny);
      let e = Math.min(ex * 1.05, ey * 1.1);
      e = Math.min(e, Math.hypot(ex, ey) * 0.7);
      if (e > 0.46) { d[o + 3] = 0; md[o + 3] = 0; continue; } // clean center
      const px = nx * aspect, py = ny;
      const wx = fbm(px * 3 + 3.1, py * 3 + 7.7, 3);
      const wy = fbm(px * 3 + 11.3, py * 3 + 1.9, 3);
      const n = fbm(px * 4 + wx * 2.4, py * 4 + wy * 2.4, 5);
      const fine = fbm(px * 34 + 5, py * 34 + 2, 3);
      // soft, irregular edge field: band ~ 0..0.2 of screen height
      const ee = e + (n - 0.5) * 0.19 - (fine - 0.5) * 0.03;
      const band = Math.pow(smooth(0.19, 0.0, ee), 1.25);
      // capillary streaks: ridged noise, thin dark-red lines just inside the band
      const vr = 1 - Math.abs(2 * fbm(px * 6 + wx * 1.6 + 21, py * 6 + wy * 1.6 + 4, 4) - 1);
      const vein = Math.pow(vr, 22) * smooth(0.24, 0.08, ee);
      // clots: darker blotches inside the band
      const clot = smooth(0.5, 0.7, fbm(px * 9 + 13, py * 9 + 31, 3)) * band;
      // splatter specks just inside the band
      const speck = smooth(0.68, 0.8, fbm(px * 70 + 9, py * 70 + 4, 2)) * smooth(0.24, 0.1, ee) * (1 - band);
      let a = band * 0.95 + vein * 0.35 + speck * 0.45;
      a = Math.min(0.97, a);
      // colour: near-black crimson at the frame, deep red mid-band; never bright (no pink wash)
      const outer = smooth(0.11, 0.0, ee);
      const r = (92 + 22 * fine) * (1 - 0.62 * outer) * (1 - 0.35 * clot) * (1 - 0.25 * vein);
      d[o] = r;
      d[o + 1] = 3 + 4 * fine * (1 - outer);
      d[o + 2] = 2 + 3 * fine * (1 - outer);
      d[o + 3] = Math.round(a * 255);
      // mask for the backdrop red grade: wider, softer than the rim, same irregular boundary
      const m = Math.min(1, Math.pow(smooth(0.3, 0.01, ee + (n - 0.5) * 0.05), 1.5) + vein * 0.3);
      md[o] = md[o + 1] = md[o + 2] = 255;
      md[o + 3] = Math.round(m * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const color = cv.toDataURL('image/png');
  g.putImageData(mimg, 0, 0);
  const mask = cv.toDataURL('image/png');
  cv.width = cv.height = 1;
  return { color, mask };
}

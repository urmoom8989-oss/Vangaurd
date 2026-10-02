import { CSS } from './styles.js';
import { DIFFICULTIES, DIFFICULTY_ORDER, MODE_TITLE, OPERATION, OBJECTIVE_TEXT, TOTAL_WAVES, difficulty } from './config.js';

/**
 * gamemode/ui.js — every menu and game-flow overlay (inside ctx.ui.uiRoot / #ui).
 *
 *  Screens (interactive, pointer-events on): main menu, pause, settings sheet, controls sheet, confirm dialog,
 *  end-of-game summary. In-game overlays (pointer-events off): mission-intro stamp, objective card,
 *  warmup / intermission countdowns, wave banner, wave-cleared panel, wave tracker, death screen,
 *  Tab scoreboard and (only when the hud lacks notify) fallback XP toasts.
 *
 *  Rendering contract: `update(G)` is called once per frame by the system with its flow model. All
 *  animation is a pure function of G's clocks (stage time / ui time), so shot captures are deterministic.
 *  DOM writes go through tiny caches (set* helpers): an element is only touched when its value changes.
 */

// ---------------------------------------------------------------------------------------- icons
const INSIGNIA = `<svg viewBox="0 0 58 64" aria-hidden="true">
<path d="M29 2.5 L55 11 V32 C55 47 44 57.5 29 61.5 C14 57.5 3 47 3 32 V11 Z" fill="rgba(10,12,11,0.35)" stroke="#eceee8" stroke-width="2.4"/>
<path d="M29 11 L46.5 17 V31.5 C46.5 42 39 49.5 29 52.5 C19 49.5 11.5 42 11.5 31.5 V17 Z" fill="rgba(242,178,58,0.12)" stroke="#f2b23a" stroke-width="1.4"/>
<path d="M18 30.5 L29 22.5 L40 30.5" stroke="#eceee8" stroke-width="3.2" fill="none" stroke-linejoin="miter"/>
<path d="M18 39 L29 31 L40 39" stroke="#eceee8" stroke-width="3.2" fill="none" stroke-linejoin="miter"/>
<circle cx="29" cy="45.5" r="2.3" fill="#f2b23a"/></svg>`;
const OBJ_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.8 L22.2 12 L12 22.2 L1.8 12 Z" fill="rgba(0,0,0,0.25)" stroke="#f2b23a" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="#f2b23a"/></svg>`;
/** Commendation glyphs by kind (24×24, amber on a thin ring). */
const MEDAL_GLYPH = {
  headshot: '<circle cx="12" cy="12" r="4.2" fill="none" stroke="#f2b23a" stroke-width="1.6"/><path d="M12 4.6v3.6M12 15.8v3.6M4.6 12h3.6M15.8 12h3.6" stroke="#f2b23a" stroke-width="1.6"/><circle cx="12" cy="12" r="1.3" fill="#f2b23a"/>',
  longshot: '<path d="M5 15.5 L19 8.5" stroke="#f2b23a" stroke-width="1.6"/><circle cx="17.2" cy="9.4" r="2.2" fill="none" stroke="#f2b23a" stroke-width="1.4"/><path d="M5 18h6" stroke="#f2b23a" stroke-width="1.2" stroke-dasharray="1.5 1.5"/>',
  multi: '<path d="M6 16.5 L9.5 7.5 L11.4 7.5 L7.9 16.5Z M10.4 16.5 L13.9 7.5 L15.8 7.5 L12.3 16.5Z M14.8 16.5 L18.3 7.5 L20.2 7.5 L16.7 16.5Z" fill="#f2b23a"/>',
  streak: '<path d="M7 11.4 L12 7.6 L17 11.4" fill="none" stroke="#f2b23a" stroke-width="1.8"/><path d="M7 15.4 L12 11.6 L17 15.4" fill="none" stroke="#f2b23a" stroke-width="1.8"/><path d="M8.5 18.6 L12 16 L15.5 18.6" fill="none" stroke="#f2b23a" stroke-width="1.4" opacity="0.6"/>',
  flawless: '<path d="M12 5.2 L17.6 7.3 V11.6 C17.6 15 15.2 17.6 12 18.8 C8.8 17.6 6.4 15 6.4 11.6 V7.3 Z" fill="none" stroke="#f2b23a" stroke-width="1.5"/><path d="M9.4 12 L11.3 13.9 L14.8 10.2" fill="none" stroke="#f2b23a" stroke-width="1.6"/>',
  star: '<path d="M12 5.4l1.95 4.15 4.5.45-3.4 3.05 1 4.45L12 15.2l-4.05 2.3 1-4.45-3.4-3.05 4.5-.45z" fill="#f2b23a"/>',
};
function medalKind(name) {
  const s = String(name).toLowerCase();
  if (/head/.test(s)) return 'headshot';
  if (/long/.test(s)) return 'longshot';
  if (/double|triple|quad|multi/.test(s)) return 'multi';
  if (/flawless/.test(s)) return 'flawless';
  if (/hand|nerve|warden|vigilant|line|bastion|legend/.test(s)) return 'streak';
  return 'star';
}
function medalIcon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.8" fill="rgba(242,178,58,0.1)" stroke="rgba(242,178,58,0.75)" stroke-width="1.1"/>${MEDAL_GLYPH[medalKind(name)]}</svg>`;
}
const MEDAL_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.2" fill="none" stroke="#f2b23a" stroke-width="1.4"/><path d="M12 5.4l1.95 4.15 4.5.45-3.4 3.05 1 4.45L12 15.2l-4.05 2.3 1-4.45-3.4-3.05 4.5-.45z" fill="#f2b23a"/></svg>`;
const AMMO_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9.5 L6.6 5 L8.2 9.5 V19 H5 Z M10.4 9.5 L12 5 L13.6 9.5 V19 H10.4 Z M15.8 9.5 L17.4 5 L19 9.5 V19 H15.8 Z" fill="#9fe0a8"/><path d="M4 20.5 H20" stroke="#9fe0a8" stroke-width="1.6"/></svg>`;
const RING = `<svg class="ring" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="10.5" fill="none" stroke="rgba(236,238,232,0.25)" stroke-width="2.4"/><circle data-r="ring" cx="13" cy="13" r="10.5" fill="none" stroke="#f2b23a" stroke-width="2.4" stroke-dasharray="66 66" stroke-dashoffset="66" transform="rotate(-90 13 13)"/></svg>`;

// ---------------------------------------------------------------------------------------- helpers
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v) => { v = clamp01(v); return v * v * (3 - 2 * v); };
/** 0 before a, fades in over fi, 1 until b, fades out over fo. */
function env(t, a, fi, b, fo) {
  if (t < a) return 0;
  if (t < a + fi) return smooth((t - a) / fi);
  if (t < b) return 1;
  if (t < b + fo) return 1 - smooth((t - b) / fo);
  return 0;
}
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
function fmtClock(s) {
  s = Math.max(0, Math.ceil(s - 1e-6));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}
function fmtDuration(s) {
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}
const pad2 = (n) => (n < 10 ? '0' + n : String(n));

function setText(el, v) {
  if (el._t !== v) { el._t = v; el.textContent = v; }
}
function setHTML(el, v) {
  if (el._h !== v) { el._h = v; el.innerHTML = v; }
}
function setShown(el, on) {
  if (el._s !== on) { el._s = on; el.classList.toggle('hide', !on); }
}
function setOpacity(el, v) {
  v = Math.round(clamp01(v) * 100) / 100;
  if (el._o !== v) { el._o = v; el.style.opacity = String(v); }
  setShown(el, v > 0);
}
/** Opacity only (keeps layout stable: staggered rows must not pop the card's height). */
function setFade(el, v) {
  v = Math.round(clamp01(v) * 100) / 100;
  if (el._o !== v) { el._o = v; el.style.opacity = String(v); }
}
function setStyle(el, prop, v) {
  const k = '_st_' + prop;
  if (el[k] !== v) { el[k] = v; el.style[prop] = v; }
}
function setClass(el, cls, on) {
  const k = '_c_' + cls;
  if (el[k] !== on) { el[k] = on; el.classList.toggle(cls, on); }
}

function keyLabel(code) {
  if (!code) return '';
  const map = {
    Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', Mouse3: 'M4', Mouse4: 'M5', WheelUp: 'Wheel ↑', WheelDown: 'Wheel ↓',
    ShiftLeft: 'Shift', ShiftRight: 'R-Shift', ControlLeft: 'Ctrl', Space: 'Space', Tab: 'Tab', Escape: 'Esc',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: 'Enter', Backquote: '`',
  };
  if (map[code]) return map[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}
const ACTION_LABELS = [
  ['moveForward', 'Move forward'], ['moveBack', 'Move back'], ['moveLeft', 'Strafe left'], ['moveRight', 'Strafe right'],
  ['sprint', 'Sprint / tactical sprint'], ['jump', 'Jump / mantle'], ['crouch', 'Crouch / slide'], ['prone', 'Prone'],
  ['fire', 'Fire'], ['ads', 'Aim down sights'], ['reload', 'Reload'], ['melee', 'Melee'], ['grenade', 'Lethal'],
  ['tactical', 'Tactical'], ['interact', 'Interact / skip intermission'], ['weapon1', 'Primary'], ['weapon2', 'Secondary'],
  ['leanLeft', 'Lean left'], ['leanRight', 'Lean right'], ['inspect', 'Inspect weapon'], ['scoreboard', 'Mission stats'],
  ['pause', 'Pause'],
];

const SETTINGS_DEF = [
  { group: 'Controls' },
  { path: 'controls.sensitivity', label: 'Mouse sensitivity', type: 'range', min: 0.5, max: 10, step: 0.1, fmt: (v) => v.toFixed(1) },
  { path: 'controls.adsSensitivity', label: 'ADS sensitivity', type: 'range', min: 0.3, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
  { path: 'controls.invertY', label: 'Invert look', type: 'toggle' },
  { path: 'controls.toggleCrouch', label: 'Toggle crouch', type: 'toggle' },
  { group: 'Video' },
  { path: 'graphics.fov', label: 'Field of view', type: 'range', min: 60, max: 120, step: 1, fmt: (v) => String(Math.round(v)) },
  { path: 'graphics.quality', label: 'Graphics quality', type: 'seg', options: ['low', 'medium', 'high', 'ultra'] },
  { path: 'graphics.motionBlur', label: 'Motion blur', type: 'toggle' },
  { path: 'graphics.filmGrain', label: 'Film grain', type: 'toggle' },
  { group: 'Audio' },
  { path: 'audio.master', label: 'Master volume', type: 'range', min: 0, max: 1, step: 0.01, fmt: (v) => String(Math.round(v * 100)) },
  { path: 'audio.sfx', label: 'Effects volume', type: 'range', min: 0, max: 1, step: 0.01, fmt: (v) => String(Math.round(v * 100)) },
  { path: 'audio.music', label: 'Music volume', type: 'range', min: 0, max: 1, step: 0.01, fmt: (v) => String(Math.round(v * 100)) },
  { path: 'audio.voice', label: 'Voice volume', type: 'range', min: 0, max: 1, step: 0.01, fmt: (v) => String(Math.round(v * 100)) },
  { group: 'Interface' },
  { path: 'gameplay.crosshair', label: 'Crosshair', type: 'toggle' },
  { path: 'gameplay.hitmarkers', label: 'Hitmarkers', type: 'toggle' },
];

/** Deterministic film-grain tile (hash noise) as a data URL. */
function grainURL() {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const img = g.createImageData(128, 128);
    let h = 2166136261;
    for (let i = 0; i < 128 * 128; i++) {
      h ^= i; h = Math.imul(h, 16777619); h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
      const v = (h >>> 0) & 255;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  } catch { return ''; }
}

// ---------------------------------------------------------------------------------------- view
/**
 * @param ctx  system ctx
 * @param H    handlers: {deploy, resume, restart, quitToMenu, setDifficulty(key), setSetting(path, v),
 *                        redeploy, continueEndless, uiSound(name)}
 */
export function createView(ctx, H) {
  const root = document.createElement('div');
  root.className = 'gmx';
  root.setAttribute('data-system', 'gamemode');
  const style = document.createElement('style');
  style.textContent = CSS;
  const grain = grainURL();

  root.innerHTML = `
  <div class="layer death hide" data-r="death">
    <div class="c">
      <div class="kicker center">Killed in action</div>
      <div class="head" data-r="dHead">You are down</div>
      <div class="by" data-r="dBy"></div>
      <div class="stats">
        <div><b class="num" data-r="dWave">1</b><span>Wave</span></div>
        <div><b class="num" data-r="dKills">0</b><span>Kills</span></div>
        <div><b class="num" data-r="dScore">0</b><span>Score</span></div>
      </div>
      <div class="reinf" data-r="dReinf"></div>
      <div class="redeploy" data-r="dRedeploy"><span class="kbd">Space</span><span data-r="dRedeployTxt">Redeploy</span></div>
      <div class="prog" data-r="dProgWrap"><i data-r="dProg"></i></div>
    </div>
  </div>

  <div class="layer" data-r="ingame">
    <div class="stamp hide" data-r="stamp">
      <div class="t" data-r="st0"></div>
      <div class="l" data-r="st1"></div>
      <div class="l" data-r="st2"></div>
      <div class="l dim" data-r="st3"></div>
      <div class="l dim" data-r="st4"></div>
    </div>
    <div class="objcard hide" data-r="objcard">
      <div class="kicker center">New objective</div>
      <div class="main">${OBJ_ICON}<span>${OBJECTIVE_TEXT}</span></div>
      <div class="sub" data-r="objSub"></div>
      <div class="bar"></div>
    </div>
    <div class="countdown hide" data-r="cd">
      <div class="kicker center" data-r="cdLbl">Assault begins in</div>
      <div class="n num" data-r="cdN">0:15</div>
      <div class="sub" data-r="cdSub"></div>
      <div class="skip" data-r="cdSkip">${RING}<span class="kbd" data-r="cdKey">F</span><span>Hold to begin now</span></div>
    </div>
    <div class="banner hide" data-r="banner">
      <div class="kicker center" data-r="bKick">Wave</div>
      <div class="wv num" data-r="bWave">01</div>
      <div class="title" data-r="bTitle"></div>
      <div class="sub" data-r="bSub"></div>
      <div class="flank hide" data-r="bFlank"></div>
      <div class="rule"></div>
    </div>
    <div class="cleared hide" data-r="cleared">
      <div class="kicker center" data-r="cKick">Wave survived</div>
      <div class="head" data-r="cHeadWrap">Wave <b class="num" data-r="cHead">01</b> <span>cleared</span></div>
      <div class="card" data-r="cCard">
        <div class="strip" data-r="cStrip"></div>
        <div class="lines" data-r="cLines"></div>
        <div class="total" data-r="cTotalRow"><span>Wave bonus</span><b class="num" data-r="cTotal">+0</b></div>
        <div class="resup" data-r="cResup">${AMMO_ICON}<span>Ammunition restocked</span><i></i><span data-r="cResupSub">Lethals topped up</span></div>
        <div class="next" data-r="cNext"><span class="lbl">Next</span><span class="what" data-r="cNextWhat"></span><b class="num" data-r="cN">0:20</b></div>
      </div>
    </div>
    <div class="tracker hide" data-r="tracker">
      <div class="top"><span class="lbl">Wave</span><span class="w num" data-r="tWave">1</span><span class="of num" data-r="tOf">/ 10</span></div>
      <div class="pips" data-r="tPips"></div>
      <div class="row2"><span>Hostiles <b class="num" data-r="tHost">0</b></span><span data-r="tStreakWrap">Streak <b class="num hot" data-r="tStreak">0</b></span></div>
      <div class="row3"><span>Score <b class="num" data-r="tScore">0</b></span><span class="lives" data-r="tLives"></span></div>
    </div>
    <div class="toasts" data-r="toasts"></div>
    <div class="board hide" data-r="board">
      <div class="kicker">Mission status</div>
      <h2 data-r="bdTitle">Hold Vardanek</h2>
      <div class="statgrid" data-r="bdGrid"></div>
    </div>
  </div>

  <div class="layer menu interactive hide" data-r="menu">
    <div class="grain" style="background-image:url(${grain})"></div>
    <div class="vignette"></div>
    <div class="brand">${INSIGNIA}<div class="wm"><b>VANGAURD</b></div></div>
    <div class="intel"><div><span class="live"></span><b>Vardanek</b> · Plaza district</div><div>Local time 17:42 · Wind NW 6 km/h</div><div>Threat level <b data-r="mThreat">Elevated</b></div></div>
    <div class="menu-main">
      <div class="kicker">Survival · Single player</div>
      <div class="mode-title">${MODE_TITLE}</div>
      <div class="mode-sub">${TOTAL_WAVES} waves · <em data-r="mDiffSub">Soldier</em> · Crimson Vanguard</div>
      <div class="btnlist" data-r="mList">
        <button class="btn primary" data-a="deploy">Deploy <span class="tag">Enter</span></button>
        <button class="btn" data-a="difficulty">Difficulty <span class="val"><i>‹</i><span data-r="mDiff">Soldier</span><i>›</i></span></button>
        <button class="btn" data-a="settings">Settings</button>
      </div>
      <div class="hint" data-r="mHint"></div>
    </div>
    <div class="brief">
      <div class="kicker">Mission briefing</div>
      <h3>Hold the plaza</h3>
      <p>Crimson Vanguard contractors are pushing into Vardanek's plaza district from every approach. Hold the square against escalating assault waves until the relief column arrives. Expect flanking squads.</p>
      <dl class="kv">
        <dt>Location</dt><dd>Vardanek · Plaza district</dd>
        <dt>Hostiles</dt><dd>Crimson Vanguard PMC</dd>
        <dt>Waves</dt><dd class="num">${TOTAL_WAVES}</dd>
        <dt>Reinforcements</dt><dd class="num" data-r="mLives">2</dd>
        <dt>Personal best</dt><dd class="acc num" data-r="mBest">—</dd>
      </dl>
    </div>
    <div class="footer"><div class="keys"><span><span class="kbd">↑</span><span class="kbd">↓</span>Navigate</span><span><span class="kbd">←</span><span class="kbd">→</span>Adjust</span><span><span class="kbd">Enter</span>Select</span></div><div>Vangaurd · Original content · Build 0.5</div></div>
  </div>

  <div class="layer pause interactive hide" data-r="pause">
    <div class="pause-main">
      <div class="kicker">${OPERATION}</div>
      <div class="pause-title">Paused</div>
      <div class="pause-sub" data-r="pSub">Hold Vardanek · Wave 1</div>
      <div class="btnlist" data-r="pList">
        <button class="btn primary" data-a="resume">Resume</button>
        <button class="btn" data-a="settings">Settings</button>
        <button class="btn danger" data-a="restart">Restart mission</button>
        <button class="btn danger" data-a="quit">Quit to main menu</button>
      </div>
      <div class="hint" data-r="pHint"></div>
    </div>
    <div class="status">
      <div class="kicker">Mission status</div>
      <div class="big"><b class="num" data-r="pScore">0</b><span>Score</span></div>
      <div class="statgrid" data-r="pGrid"></div>
      <div class="obj">${OBJ_ICON}<span>${OBJECTIVE_TEXT}</span></div>
    </div>
  </div>

  <div class="layer summary interactive hide" data-r="summary">
    <div class="grain" style="background-image:url(${grain})"></div>
    <div class="sum-main" data-r="sMain">
      <div class="kicker" data-r="sKick">Match complete</div>
      <div class="sum-head" data-r="sHead">Final result</div>
      <div class="sum-sub" data-r="sSub"></div>
      <div class="sum-grid">
        <div class="scorebox" data-r="sBox">
          <div class="kicker">Final score</div>
          <div class="s num" data-r="sScore">0</div>
          <div class="pb hide" data-r="sPB">New personal best</div>
          <div class="best" data-r="sBest"></div>
          <div class="rank"><span>Operator rating</span><b data-r="sRank">—</b></div>
        </div>
        <div>
          <div class="statgrid" data-r="sGrid"></div>
          <div class="medals" data-r="sMedals"></div>
          <div class="wchart" data-r="sChart">
            <div class="hd"><span>Wave performance · hostiles eliminated</span><span class="legend"><span><i style="background:rgba(236,238,232,0.5)"></i>Cleared</span><span><i style="background:#f2b23a"></i>Flawless</span><span><i style="background:#e5483b"></i>Overrun</span></span></div>
            <div class="bars" data-r="sBars"></div>
            <div class="lbl" data-r="sBarLbl"></div>
          </div>
        </div>
      </div>
    </div>
    <div class="sum-actions" data-r="sList">
      <button class="btn primary" data-a="restart">Restart mission</button>
      <button class="btn hide" data-a="endless">Continue · Endless</button>
      <button class="btn" data-a="menu">Main menu</button>
    </div>
    <div class="footer"><div class="keys"><span><span class="kbd">←</span><span class="kbd">→</span>Navigate</span><span><span class="kbd">Enter</span>Select</span></div><div data-r="sFoot">Hold Vardanek</div></div>
  </div>

  <div class="layer interactive hide" data-r="sheetLayer" style="background:rgba(0,0,0,0.35)">
    <div class="sheet hide" data-r="settings">
      <div class="kicker">Options</div>
      <h2>Settings</h2>
      <div class="scroll" data-r="setRows"></div>
      <button class="btn back sel" data-a="back">Back <span class="tag">Esc</span></button>
    </div>
    <div class="sheet hide" data-r="controls">
      <div class="kicker">Options</div>
      <h2>Controls</h2>
      <div class="scroll"><div class="binds" data-r="bindRows"></div></div>
      <button class="btn back sel" data-a="back">Back <span class="tag">Esc</span></button>
    </div>
    <div class="confirm hide" data-r="confirm">
      <div class="kicker">Confirm</div>
      <h2 data-r="cfTitle">Restart mission?</h2>
      <p data-r="cfText">All progress in this deployment will be lost.</p>
      <div class="btnlist" data-r="cfList">
        <button class="btn danger" data-a="yes">Confirm</button>
        <button class="btn" data-a="no">Cancel</button>
      </div>
    </div>
  </div>

  <div class="fade" data-r="fade"></div>`;

  const R = {};
  root.querySelectorAll('[data-r]').forEach((el) => { R[el.getAttribute('data-r')] = el; });
  const ring = root.querySelector('[data-r="ring"]');

  // ------------------------------------------------------------------ interactive lists
  let screen = null; // 'menu' | 'pause' | 'summary' | null
  const stack = []; // sub panels: 'settings' | 'controls' | 'confirm'
  let confirmAction = null;
  const lists = {
    menu: { el: R.mList, sel: 0 },
    pause: { el: R.pList, sel: 0 },
    summary: { el: R.sList, sel: 0 },
    confirm: { el: R.cfList, sel: 1 },
  };
  const HINTS = {
    deploy: 'Insert into the Vardanek plaza district. The first assault wave begins after a short warmup.',
    settings: 'Mouse sensitivity, field of view, graphics quality and audio levels.',
    controls: 'Review key bindings.',
    resume: 'Return to the fight.',
    restart: 'Abandon this deployment and start again from wave 1.',
    quit: 'Abandon this deployment and return to the main menu.',
  };

  function buttons(list) { return Array.from(list.el.querySelectorAll('button.btn:not(.hide)')); }
  function refreshSel(name) {
    const list = lists[name];
    const bs = buttons(list);
    if (!bs.length) return;
    list.sel = ((list.sel % bs.length) + bs.length) % bs.length;
    bs.forEach((b, i) => setClass(b, 'sel', i === list.sel));
    const a = bs[list.sel].getAttribute('data-a');
    if (name === 'menu') setText(R.mHint, a === 'difficulty' ? difficulty(currentDiff()).blurb : HINTS[a] || '');
    if (name === 'pause') setText(R.pHint, HINTS[a] || '');
  }
  function activeListName() {
    const top = stack[stack.length - 1];
    if (top === 'confirm') return 'confirm';
    if (top) return null;
    return screen;
  }
  function currentDiff() { return ctx.settings.get('gameplay.difficulty', 'regular'); }

  function onAction(listName, a) {
    H.uiSound?.('select');
    if (listName === 'menu') {
      if (a === 'deploy') H.deploy();
      else if (a === 'difficulty') cycleDifficulty(1);
      else if (a === 'settings') openSheet('settings');
      else if (a === 'controls') openSheet('controls');
    } else if (listName === 'pause') {
      if (a === 'resume') H.resume();
      else if (a === 'settings') openSheet('settings');
      else if (a === 'controls') openSheet('controls');
      else if (a === 'restart') openConfirm('Restart mission?', 'All progress in this deployment will be lost.', () => H.restart());
      else if (a === 'quit') openConfirm('Quit to main menu?', 'All progress in this deployment will be lost.', () => H.quitToMenu());
    } else if (listName === 'summary') {
      if (a === 'restart') H.restart();
      else if (a === 'menu') H.quitToMenu();
      else if (a === 'endless') H.continueEndless();
    } else if (listName === 'confirm') {
      const fn = confirmAction;
      closeTop();
      if (a === 'yes' && fn) fn();
    }
  }

  function cycleDifficulty(dir) {
    const i = DIFFICULTY_ORDER.indexOf(currentDiff());
    const next = DIFFICULTY_ORDER[(Math.max(0, i) + dir + DIFFICULTY_ORDER.length) % DIFFICULTY_ORDER.length];
    H.setDifficulty(next);
    refreshSel('menu');
  }

  for (const name of Object.keys(lists)) {
    const list = lists[name];
    list.el.addEventListener('mousemove', (e) => {
      const b = e.target.closest('button.btn');
      if (!b) return;
      const i = buttons(list).indexOf(b);
      if (i >= 0 && i !== list.sel) { list.sel = i; refreshSel(name); H.uiSound?.('hover'); }
    });
    list.el.addEventListener('click', (e) => {
      const b = e.target.closest('button.btn');
      if (!b) return;
      if (name === 'menu' && b.getAttribute('data-a') === 'difficulty') {
        cycleDifficulty(1);
        H.uiSound?.('select');
        return;
      }
      onAction(name, b.getAttribute('data-a'));
    });
  }
  root.querySelectorAll('.sheet .back').forEach((b) => b.addEventListener('click', () => { H.uiSound?.('back'); closeTop(); }));

  function openSheet(which) {
    if (which === 'settings') buildSettings();
    if (which === 'controls') buildControls();
    stack.push(which);
    syncPanels();
  }
  function openConfirm(title, text, fn) {
    setText(R.cfTitle, title);
    setText(R.cfText, text);
    confirmAction = fn;
    lists.confirm.sel = 1;
    stack.push('confirm');
    syncPanels();
    refreshSel('confirm');
  }
  function closeTop() {
    stack.pop();
    if (!stack.length) confirmAction = null;
    syncPanels();
  }
  function syncPanels() {
    const top = stack[stack.length - 1] || null;
    setShown(R.sheetLayer, !!top);
    setShown(R.settings, top === 'settings');
    setShown(R.controls, top === 'controls');
    setShown(R.confirm, top === 'confirm');
  }

  function buildSettings() {
    const rows = [];
    for (const d of SETTINGS_DEF) {
      if (d.group) { rows.push(`<div class="group">${d.group}</div>`); continue; }
      const v = ctx.settings.get(d.path);
      if (d.type === 'range') {
        const p = ((Number(v) - d.min) / (d.max - d.min)) * 100;
        rows.push(`<label class="row"><span>${d.label}</span><span class="ctl"><input type="range" data-p="${d.path}" min="${d.min}" max="${d.max}" step="${d.step}" value="${v}" style="--p:${p}%"><output>${d.fmt(Number(v))}</output></span></label>`);
      } else if (d.type === 'toggle') {
        rows.push(`<div class="row"><span>${d.label}</span><span class="ctl"><span class="seg" data-p="${d.path}" data-t="toggle"><button class="${v ? '' : 'on'}" data-v="false">Off</button><button class="${v ? 'on' : ''}" data-v="true">On</button></span></span></div>`);
      } else if (d.type === 'seg') {
        rows.push(`<div class="row"><span>${d.label}</span><span class="ctl"><span class="seg" data-p="${d.path}">${d.options.map((o) => `<button class="${o === v ? 'on' : ''}" data-v="${o}">${o}</button>`).join('')}</span></span></div>`);
      }
    }
    R.setRows.innerHTML = rows.join('');
  }
  R.setRows.addEventListener('input', (e) => {
    const inp = e.target;
    if (!inp.matches('input[type=range]')) return;
    const d = SETTINGS_DEF.find((x) => x.path === inp.getAttribute('data-p'));
    const v = Number(inp.value);
    inp.style.setProperty('--p', `${((v - d.min) / (d.max - d.min)) * 100}%`);
    inp.nextElementSibling.textContent = d.fmt(v);
    H.setSetting(d.path, v);
  });
  R.setRows.addEventListener('click', (e) => {
    const b = e.target.closest('.seg button');
    if (!b) return;
    const seg = b.parentElement;
    const path = seg.getAttribute('data-p');
    const raw = b.getAttribute('data-v');
    const v = seg.getAttribute('data-t') === 'toggle' ? raw === 'true' : raw;
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    H.uiSound?.('select');
    H.setSetting(path, v);
  });

  function buildControls() {
    const b = ctx.input.bindings || {};
    const rows = [];
    for (const [a, label] of ACTION_LABELS) {
      const codes = b[a] || [];
      rows.push(`<div>${label}</div><div class="k">${codes.map((c) => `<span class="kbd">${keyLabel(c)}</span>`).join('') || '<span class="kbd">—</span>'}</div>`);
    }
    rows.push('<div>Pause menu</div><div class="k"><span class="kbd">Esc</span></div>');
    R.bindRows.innerHTML = rows.join('');
  }

  // keyboard navigation for menus (DOM events; game input is disabled while a screen is open)
  function onKey(e) {
    if (!screen && !stack.length) return;
    const top = stack[stack.length - 1];
    if (e.code === 'Escape' || e.code === 'Backspace') {
      if (top) { e.preventDefault(); H.uiSound?.('back'); closeTop(); return; }
      if (screen === 'pause' && e.code === 'Backspace') { H.resume(); }
      return;
    }
    if (top === 'settings' || top === 'controls') return;
    const name = activeListName();
    if (!name) return;
    const list = lists[name];
    const horizontal = name === 'summary';
    const prev = horizontal ? ['ArrowLeft', 'KeyA'] : ['ArrowUp', 'KeyW'];
    const next = horizontal ? ['ArrowRight', 'KeyD'] : ['ArrowDown', 'KeyS'];
    if (prev.includes(e.code)) { list.sel--; refreshSel(name); H.uiSound?.('hover'); e.preventDefault(); }
    else if (next.includes(e.code)) { list.sel++; refreshSel(name); H.uiSound?.('hover'); e.preventDefault(); }
    else if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') {
      const bs = buttons(list);
      if (bs[list.sel]) onAction(name, bs[list.sel].getAttribute('data-a'));
      e.preventDefault();
    } else if (name === 'menu' && (e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'KeyA' || e.code === 'KeyD')) {
      const bs = buttons(list);
      if (bs[list.sel]?.getAttribute('data-a') === 'difficulty') { cycleDifficulty(e.code === 'ArrowLeft' || e.code === 'KeyA' ? -1 : 1); H.uiSound?.('hover'); }
    } else if (name === 'pause' && e.code === 'KeyP') {
      H.resume();
    }
  }
  window.addEventListener('keydown', onKey);

  /** Show a top-level interactive screen (or null). Resets sub panels. */
  function setScreen(name) {
    if (screen === name) return;
    screen = name;
    stack.length = 0;
    syncPanels();
    setShown(R.menu, name === 'menu');
    setShown(R.pause, name === 'pause');
    setShown(R.summary, name === 'summary');
    if (name && lists[name]) {
      lists[name].sel = 0;
      refreshSel(name);
    }
  }

  // ------------------------------------------------------------------ fallback toasts
  const toastEls = [];
  const toastData = [];
  for (let i = 0; i < 4; i++) {
    const t = document.createElement('div');
    t.className = 'toast hide';
    R.toasts.appendChild(t);
    toastEls.push(t);
    toastData.push({ text: '', kind: '', t: 99, dur: 1 });
  }
  let toastHead = 0;
  function toast(text, kind, dur) {
    const d = toastData[toastHead];
    d.text = text; d.kind = kind || 'xp'; d.t = 0; d.dur = dur || 1.6;
    toastHead = (toastHead + 1) % toastData.length;
  }

  // ------------------------------------------------------------------ per-frame update
  let lastPips = '';
  let lastLives = '';
  let lastLines = '';
  let lastMedals = '';
  let lastGrid = '';
  let lastPGrid = '';
  let lastBGrid = '';
  let lastWaves = '';
  let barEls = [];

  let clStats = [];
  let clRows = [];
  /** (Re)build the wave-cleared card from G.bonusLines: stat strip, bonus rows (count up), resupply pill. */
  function buildCleared(G) {
    lastLines = G.bonusKey;
    const stats = [];
    const pts = [];
    G.bonusResupply = null;
    for (const l of G.bonusLines) {
      if (l.resupply) G.bonusResupply = l;
      else if (l.stat) stats.push(l);
      else pts.push(l);
    }
    R.cStrip.innerHTML = stats.map((l) => `<div><b class="num">${escapeHTML(l.value)}</b><span>${escapeHTML(l.label)}</span></div>`).join('');
    setShown(R.cStrip, stats.length > 0);
    R.cLines.innerHTML = pts.map((l) => `<div class="ln${l.accent ? ' acc' : ''}"><span>${escapeHTML(l.label)}</span><b class="num">+0</b></div>`).join('');
    clStats = Array.from(R.cStrip.children);
    clRows = Array.from(R.cLines.children).map((el, i) => ({ el, num: el.querySelector('b'), points: pts[i].points || 0 }));
    setShown(R.cTotalRow, pts.length > 0);
    const ns = G.nextSpec;
    setText(R.cNextWhat, ns ? `Wave ${pad2(ns.wave)} · ${ns.final ? 'Final assault' : ns.heavy ? 'Heavy assault' : ns.title}` : 'Relief column');
    if (G.bonusResupply) setText(R.cResupSub, G.bonusResupply.value || '');
  }

  function statGridHTML(s, rows) {
    return rows.map(([k, v]) => `<div><b class="num">${v}</b><span>${k}</span></div>`).join('');
  }

  function update(G, uiDt) {
    const s = G.state;
    const stage = G.stage;
    const st = G.stageT;

    // ---- fade
    setOpacity(R.fade, G.fade);

    // ---- in-game layer visibility
    const inGame = stage === 'warmup' || stage === 'live' || stage === 'intermission';
    setShown(R.ingame, stage !== 'menu' && stage !== 'boot' && stage !== 'ended');

    // ---- intro stamp (warmup)
    if (stage === 'warmup') {
      const a = env(st, 1.1, 0.25, G.introEnd, 0.8);
      setOpacity(R.stamp, a);
      if (a > 0) {
        const lines = G.introLines;
        let t0 = 1.35;
        const cps = 30;
        let cursorOn = false;
        for (let i = 0; i < lines.length; i++) {
          const el = R['st' + i];
          const n = Math.max(0, Math.min(lines[i].length, Math.floor((st - t0) * cps)));
          const typing = n > 0 && n < lines[i].length;
          const last = i === lines.length - 1 && n === lines[i].length && st < G.introEnd;
          const blink = (Math.floor(st * 2.2) & 1) === 0;
          const cur = typing || (last && blink);
          if (cur) cursorOn = true;
          const html = n > 0 ? escapeHTML(lines[i].slice(0, n)) + (cur ? '<span class="cur"></span>' : '') : '';
          setHTML(el, html);
          t0 += lines[i].length / cps + 0.22;
        }
        void cursorOn;
      }
      setOpacity(R.objcard, env(st, G.objStart, 0.45, G.objEnd, 0.6));
      setText(R.objSub, `Survive ${G.endless ? 'the assault' : TOTAL_WAVES + ' waves'} · ${difficulty(G.diffKey).label}`);
      // warmup countdown
      const cdA = G.countdown > 0 ? env(st, G.cdStart, 0.4, 1e9, 0) : 0;
      setOpacity(R.cd, cdA);
      if (cdA > 0) {
        setText(R.cdLbl, 'Assault begins in');
        setText(R.cdN, fmtClock(G.countdown));
        setText(R.cdSub, 'Fortify the plaza · Check your sectors');
        setStyle(R.cdN, 'color', G.countdown <= 3.0 ? '#f2b23a' : '');
        setShown(R.cdSkip, true);
        updateSkip(G);
      }
    } else {
      setOpacity(R.stamp, 0);
      setOpacity(R.objcard, 0);
    }

    // ---- intermission: wave-cleared card (staggered reveal, count-up bonuses), then the next-wave countdown
    if (stage === 'intermission') {
      const a = env(st, 0.15, 0.4, G.clearedHold, 0.6);
      setOpacity(R.cleared, a);
      if (a > 0) {
        setText(R.cKick, G.lastWaveFinal ? 'Final wave survived' : G.endless && G.bonusKey === 'endless' ? 'Relief column delayed' : 'Wave survived');
        setText(R.cHead, pad2(G.lastWave));
        if (G.bonusKey !== lastLines) buildCleared(G);
        const lift = (1 - smooth((st - 0.15) / 0.5)) * 10;
        setStyle(R.cHeadWrap, 'transform', `translateY(${lift.toFixed(1)}px)`);
        setOpacity(R.cCard, env(st, 0.35, 0.35, 1e9, 0));
        for (let i = 0; i < clStats.length; i++) setFade(clStats[i], env(st, 0.45 + i * 0.08, 0.3, 1e9, 0));
        let total = 0;
        let tEnd = 0.9;
        for (let i = 0; i < clRows.length; i++) {
          const r = clRows[i];
          const t0 = 0.9 + i * 0.3;
          const k = smooth((st - t0) / 0.28);
          setFade(r.el, k);
          setStyle(r.el, 'transform', `translateX(${((1 - k) * -14).toFixed(1)}px)`);
          const c = smooth((st - t0 - 0.08) / 0.45);
          const v = Math.round(r.points * c);
          if (r.el._v !== v) { r.el._v = v; r.num.textContent = '+' + fmtInt(v); }
          total += v;
          tEnd = t0 + 0.3;
        }
        const tk = env(st, tEnd, 0.3, 1e9, 0);
        setFade(R.cTotalRow, tk);
        if (R.cTotal._v !== total) { R.cTotal._v = total; R.cTotal.textContent = '+' + fmtInt(total); }
        setClass(R.cTotalRow, 'done', st > tEnd + 0.6);
        setFade(R.cNext, env(st, tEnd + 0.55, 0.3, 1e9, 0));
        setText(R.cN, fmtClock(G.countdown));
        setShown(R.cResup, !!G.bonusResupply);
        const rk = smooth((st - tEnd - 0.3) / 0.3);
        setFade(R.cResup, rk);
        setStyle(R.cResup, 'transform', `translateX(${((1 - rk) * -14).toFixed(1)}px)`);
      }
      const cdA = G.lastWaveFinal ? 0 : env(st, G.clearedHold + 0.5, 0.4, 1e9, 0);
      setOpacity(R.cd, cdA);
      if (cdA > 0) {
        const ns = G.nextSpec;
        setText(R.cdLbl, ns?.final ? 'Final wave in' : ns?.heavy ? 'Heavy wave in' : 'Next wave in');
        setText(R.cdN, fmtClock(G.countdown));
        setStyle(R.cdN, 'color', G.countdown <= 3.0 ? '#f2b23a' : '');
        setText(R.cdSub, ns ? `Wave ${pad2(ns.wave)} · ${ns.total} hostiles · ${ns.subtitle}` : '');
        setShown(R.cdSkip, true);
        updateSkip(G);
      }
    } else {
      setOpacity(R.cleared, 0);
      if (stage !== 'warmup') setOpacity(R.cd, 0);
    }

    // ---- wave banner (live)
    if (stage === 'live' && G.spec && !G.hudBanner) {
      const a = env(G.bannerT, 0.05, 0.35, 3.7, 0.6);
      setOpacity(R.banner, a);
      if (a > 0) {
        const sp = G.spec;
        setClass(R.banner, 'final', !!sp.final);
        setText(R.bKick, sp.final ? 'Final wave' : sp.heavy ? 'Heavy wave' : 'Wave');
        setText(R.bWave, pad2(sp.wave));
        setText(R.bTitle, sp.title);
        setText(R.bSub, `${sp.total} hostiles · ${sp.subtitle}`);
        const fl = G.flankBearing;
        setShown(R.bFlank, !!fl && G.bannerT > 0.9);
        if (fl) setText(R.bFlank, `Flanking movement · ${fl}`);
        // subtle scale-in of the numeral
        const k = 1 + 0.06 * (1 - smooth(G.bannerT / 0.5));
        setStyle(R.bWave, 'transform', `scale(${k.toFixed(3)})`);
      }
    } else setOpacity(R.banner, 0);

    // ---- tracker
    const trackerOn = (stage === 'live' || stage === 'intermission' || (stage === 'warmup' && st > G.introEnd - 0.5)) && !G.paused;
    const trA = trackerOn ? (stage === 'warmup' ? smooth((st - (G.introEnd - 0.5)) / 0.6) : 1) : 0;
    setOpacity(R.tracker, trA * (G.hideTracker || G.hudBanner || G.ext ? 0 : 1));
    if (trA > 0) {
      setText(R.tWave, String(Math.max(1, stage === 'warmup' ? 1 : s.wave)));
      setText(R.tOf, G.endless ? '/ ∞' : `/ ${TOTAL_WAVES}`);
      const total = stage === 'live' ? s.enemiesTotal : 0;
      const rem = stage === 'live' ? s.enemiesRemaining : 0;
      setText(R.tHost, String(rem));
      // pips: one per hostile (max 30); on = alive/pending, done = killed
      const n = Math.min(30, total);
      const onN = Math.min(n, rem);
      const pk = n + ':' + onN;
      if (pk !== lastPips) {
        lastPips = pk;
        let h = '';
        for (let i = 0; i < n; i++) h += i < onN ? '<i class="on"></i>' : '<i class="done"></i>';
        if (!n) h = '<i></i>';
        R.tPips.innerHTML = h;
      }
      setText(R.tStreak, String(s.streak));
      setText(R.tScore, fmtInt(s.score.friendly || 0));
      const lk = s.lives + '/' + G.livesMax;
      if (lk !== lastLives) {
        lastLives = lk;
        let h = '';
        for (let i = 0; i < G.livesMax; i++) h += i < s.lives ? '<i class="on"></i>' : '<i></i>';
        R.tLives.innerHTML = h;
      }
    }

    // ---- scoreboard (Tab)
    const boardOn = G.scoreboard && inGame && !G.paused;
    setShown(R.board, boardOn);
    if (boardOn) {
      setText(R.bdTitle, `Hold Vardanek · Wave ${Math.max(1, s.wave)}`);
      const gk = statKey(s, G);
      if (gk !== lastBGrid) { lastBGrid = gk; R.bdGrid.innerHTML = statGridHTML(s, statRows(s, G)); }
    }

    // ---- fallback toasts
    for (let i = 0; i < toastData.length; i++) {
      const d = toastData[i];
      const el = toastEls[i];
      if (d.t < d.dur + 0.4) {
        d.t += uiDt;
        const a = env(d.t, 0, 0.12, d.dur, 0.35);
        setText(el, d.text);
        el.className = `toast ${d.kind}${a > 0 ? '' : ' hide'}`;
        el._s = a > 0;
        setOpacity(el, a);
      } else setOpacity(el, 0);
    }

    // ---- death
    if (stage === 'dead' && !G.ext) {
      const a = env(st, 0, 0.6, 1e9, 0);
      setOpacity(R.death, a);
      const D = G.death;
      setText(R.dHead, D.final ? 'Plaza overrun' : 'You are down');
      setHTML(R.dBy, D.killer ? `Killed by <b>${escapeHTML(D.killer)}</b>${D.distance ? ` · ${Math.round(D.distance)} m` : ''}` : 'Killed in the line of duty');
      setText(R.dWave, String(Math.max(1, s.wave)));
      setText(R.dKills, String(s.kills));
      setText(R.dScore, fmtInt(s.score.friendly || 0));
      setClass(R.dReinf, 'none', D.final);
      setText(R.dReinf, D.final ? 'No reinforcements remaining' : `Reinforcements remaining · ${s.lives}`);
      setShown(R.dRedeploy, !D.final && st > 1.2);
      setText(R.dRedeployTxt, `Redeploy · ${Math.max(0, Math.ceil(D.redeployIn))}`);
      setShown(R.dProgWrap, true);
      const p = D.final ? clamp01(st / D.redeployTotal) : clamp01(1 - D.redeployIn / D.redeployTotal);
      setStyle(R.dProg, 'width', `${(p * 100).toFixed(1)}%`);
      setStyle(R.dProg, 'background', D.final ? 'var(--red)' : 'var(--fg)');
    } else setOpacity(R.death, 0);

    // ---- screens
    const scr = stage === 'ended' ? 'summary' : G.ext ? null : stage === 'menu' || stage === 'deploying' ? 'menu' : G.paused ? 'pause' : null;
    setScreen(scr);
    if (scr === 'menu') {
      const d = difficulty(currentDiff());
      setText(R.mDiff, d.label);
      setText(R.mDiffSub, d.label);
      setText(R.mLives, String(d.lives));
      setText(R.mThreat, ['Moderate', 'Elevated', 'High', 'Severe'][DIFFICULTY_ORDER.indexOf(d.key)] || 'Elevated');
      const b = G.bestFor(d.key);
      setText(R.mBest, b ? `${fmtInt(b.score)} · Wave ${b.wave}` : '—');
      const a = env(G.menuT, 0.1, 0.9, 1e9, 0);
      setOpacity(R.menu, Math.max(0.001, a));
    }
    if (scr === 'pause') {
      setText(R.pSub, `Hold Vardanek · Wave ${Math.max(1, s.wave)} · ${difficulty(G.diffKey).label}`);
      setText(R.pScore, fmtInt(s.score.friendly || 0));
      const gk = statKey(s, G);
      if (gk !== lastPGrid) { lastPGrid = gk; R.pGrid.innerHTML = statGridHTML(s, statRows(s, G, undefined, true)); }
    }
    if (scr === 'summary') {
      const S = G.summary;
      const a = env(st, 0, 0.8, 1e9, 0);
      setOpacity(R.summary, Math.max(0.001, a));
      setStyle(R.sMain, 'transform', `translateY(${((1 - smooth(st / 0.9)) * 14).toFixed(1)}px)`);
      setClass(R.sKick, 'red', !S.victory);
      const teamMatch = s.matchType === 'tdm';
      setText(R.sKick, teamMatch ? (S.victory ? 'Victory' : 'Defeat') : S.victory ? (G.endless ? 'Endless assault ended' : 'Mission successful') : 'Mission failed');
      setText(R.sHead, teamMatch ? `${s.winner || 'Winning team'} wins` : S.victory ? 'Vardanek secured' : 'Plaza overrun');
      setHTML(R.sSub, teamMatch
        ? `Team Deathmatch · <em>Final score: Blue ${s.score.blue || 0} — Red ${s.score.red || 0}</em>`
        : `${OPERATION} · <em>${difficulty(G.diffKey).label}</em> · ${S.victory && !G.endless ? `All ${TOTAL_WAVES} waves survived` : `Reached wave ${Math.max(1, s.wave)}`}`);
      // count-up of the final score
      const sc = s.score.friendly || 0;
      const k = smooth((st - 0.4) / 1.4);
      setText(R.sScore, fmtInt(teamMatch ? sc : sc * k));
      setShown(R.sPB, !teamMatch && S.newBest && st > 1.6);
      setHTML(R.sBest, teamMatch ? 'Team Deathmatch result' : S.prevBest ? `Previous best <b>${fmtInt(S.prevBest.score)}</b> · Wave ${S.prevBest.wave}` : (S.persisted ? 'First recorded deployment' : 'Best scores are not saved in capture mode'));
      setText(R.sRank, teamMatch ? '—' : S.rank);
      const gk = statKey(s, G) + S.time.toFixed(0);
      if (gk !== lastGrid) {
        lastGrid = gk;
        const rows = teamMatch
          ? [['Blue team', String(s.score.blue || 0)], ['Red team', String(s.score.red || 0)], ['Eliminations', String(s.kills)],
            ['Headshots', String(s.headshots)], ['Accuracy', s.shotsFired > 0 ? Math.round((100 * s.shotsHit) / s.shotsFired) + '%' : '—'], ['Match time', fmtDuration(S.time)]]
          : statRows(s, G, S.time);
        R.sGrid.innerHTML = statGridHTML(s, rows);
      }
      const mk = S.medalKey;
      if (mk !== lastMedals) {
        lastMedals = mk;
        R.sMedals.innerHTML = S.medals.length
          ? S.medals.map((m) => `<span class="medal">${medalIcon(m.name)}${escapeHTML(m.name)}${m.count > 1 ? ` <b>×${m.count}</b>` : ''}</span>`).join('')
          : '<span class="none">No commendations earned</span>';
      }
      setText(R.sFoot, `Hold Vardanek · ${difficulty(G.diffKey).label}`);
      if (S.wavesKey !== lastWaves) {
        lastWaves = S.wavesKey;
        const ws = S.waves.slice(-14);
        let mx = 1;
        for (const w of ws) mx = Math.max(mx, w.kills);
        // unreached waves of a finite run are shown as empty ghost slots so the chart reads as "how far you got"
        const lastW = ws.length ? ws[ws.length - 1].wave : 0;
        const ghosts = G.endless ? 0 : Math.max(0, Math.min(14 - ws.length, TOTAL_WAVES - lastW));
        let bars = ws.map((w) => `<div class="col${w.failed ? ' fail' : w.flawless ? ' flaw' : ''}"><b>${w.kills}</b><i data-h="${Math.max(3, (w.kills / mx) * 92)}"></i></div>`).join('');
        let lbls = ws.map((w) => `<span>W${w.wave}</span>`).join('');
        for (let g = 1; g <= ghosts; g++) { bars += '<div class="col ghost"><b>–</b><u></u></div>'; lbls += `<span class="ghost">W${lastW + g}</span>`; }
        R.sBars.innerHTML = bars;
        R.sBarLbl.innerHTML = lbls;
        barEls = Array.from(R.sBars.querySelectorAll('i'));
      }
      setShown(R.sChart, !teamMatch && S.waves.length > 0);
      for (let i = 0; i < barEls.length; i++) {
        const b = barEls[i];
        const k = smooth((st - 0.5 - i * 0.07) / 0.5);
        setStyle(b, 'height', `${(Number(b.getAttribute('data-h')) * k).toFixed(1)}px`);
      }
      const endlessBtn = R.sList.querySelector('[data-a="endless"]');
      setShown(endlessBtn, !teamMatch && S.victory && !G.endless);
    }
  }

  /** --u = one 1080p pixel at the current viewport size (see styles.js). */
  function applyScale() {
    const w = window.innerWidth || 1920;
    const h = window.innerHeight || 1080;
    const u = Math.max(0.35, Math.min(w / 1920, h / 1080));
    root.style.setProperty('--u', `${u.toFixed(5)}px`);
  }

  function updateSkip(G) {
    const off = 66 * (1 - clamp01(G.skipHold));
    const v = off.toFixed(1);
    if (ring._o !== v) { ring._o = v; ring.setAttribute('stroke-dashoffset', v); }
    const code = ctx.input.bindings?.interact?.[0];
    setText(R.cdKey, keyLabel(code) || 'F');
  }

  function statKey(s, G) {
    return `${s.wave}|${s.kills}|${s.headshots}|${s.bestStreak}|${s.shotsFired}|${s.shotsHit}|${s.deaths}|${G.wavesSurvived}`;
  }
  function statRows(s, G, time, short) {
    const acc = s.shotsFired > 0 ? Math.round((100 * s.shotsHit) / s.shotsFired) + '%' : '—';
    if (short) {
      return [['Waves', String(G.wavesSurvived)], ['Kills', String(s.kills)], ['Headshots', String(s.headshots)],
        ['Accuracy', acc], ['Streak', String(s.bestStreak)], ['Deaths', String(s.deaths)]];
    }
    const rows = [
      ['Waves survived', String(G.wavesSurvived)],
      ['Hostiles eliminated', String(s.kills)],
      ['Headshots', String(s.headshots)],
      ['Accuracy', acc],
      ['Best streak', String(s.bestStreak)],
      ['Deaths', String(s.deaths)],
    ];
    if (time !== undefined) rows[5] = ['Time in combat', fmtDuration(time)];
    return rows;
  }

  return {
    root,
    style,
    mount() {
      document.head.appendChild(style);
      ctx.ui.uiRoot.appendChild(root);
      applyScale();
      window.addEventListener('resize', applyScale);
      ctx.events.on('resize', applyScale);
    },
    update,
    toast,
    setScreen,
    isSubPanelOpen: () => stack.length > 0,
    dispose() {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', applyScale);
      ctx.events.off('resize', applyScale);
      root.remove();
      style.remove();
    },
  };
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export { DIFFICULTIES };

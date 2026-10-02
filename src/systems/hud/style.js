/**
 * hud/style.js — all HUD + menu CSS. Every dimension is expressed in `--u` (1 unit = 1 px at 1080p),
 * so the whole interface scales with the viewport (and the HUD scale setting).
 *
 * IMPORTANT: no CSS animations/transitions drive gameplay HUD elements (they would run on the wall
 * clock and break bit-identical shots). HUD motion is driven from JS by the sim/UI clock. Menus use
 * CSS transitions only for pointer hover feedback.
 */
export const FONT_STACK = `'Bahnschrift', 'DIN Alternate', 'DIN Next', 'Segoe UI', 'Roboto Condensed', 'Arial Narrow', system-ui, sans-serif`;

export const CSS = /* css */ `
.od-layer {
  --u: 1px;
  --fg: #eef1ec;
  --fg2: rgba(236, 240, 234, .66);
  --fg3: rgba(236, 240, 234, .38);
  --accent: #f0c048;
  --accent2: #e39a2f;
  --enemy: #ff4a3a;
  --enemy2: #c22a1f;
  --friend: #86d2ff;
  --warn: #ffb341;
  --panel: rgba(9, 12, 14, .52);
  --line: rgba(236, 240, 234, .22);
  --ts: 0 0 calc(var(--u) * 3) rgba(0,0,0,.55), 0 calc(var(--u) * 1) calc(var(--u) * 1.5) rgba(0,0,0,.8), 0 0 calc(var(--u) * 14) rgba(0,0,0,.3);
  --ds: drop-shadow(0 calc(var(--u) * 1) calc(var(--u) * 1.5) rgba(0,0,0,.75)) drop-shadow(0 0 calc(var(--u) * 5) rgba(0,0,0,.35));
  position: absolute; inset: 0; overflow: hidden; pointer-events: none;
  font-family: ${FONT_STACK};
  color: var(--fg);
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
  line-height: 1.15;
  contain: strict;
}
.od-layer *, .od-layer *::before, .od-layer *::after { box-sizing: border-box; }
.od-ico { display: block; width: 100%; height: 100%; overflow: visible; }
.od-abs { position: absolute; }
.od-ts { text-shadow: var(--ts); }
.od-cond { font-stretch: 80%; font-variation-settings: 'wdth' 80; }
.od-hidden { display: none !important; }

/* =================================================================== compass */
.od-compass { position: absolute; left: 50%; top: calc(var(--u) * 16); width: calc(var(--u) * 640); height: calc(var(--u) * 64);
  margin-left: calc(var(--u) * -320); }
.od-compass::before { content: ''; position: absolute; left: calc(var(--u) * 40); right: calc(var(--u) * 40); top: calc(var(--u) * -14); height: calc(var(--u) * 84);
  background: radial-gradient(ellipse 50% 50% at 50% 50%, rgba(4,6,8,.34), rgba(4,6,8,.16) 55%, rgba(4,6,8,0) 100%); }
.od-compass .win { position: absolute; left: 0; right: 0; top: 0; height: calc(var(--u) * 40); overflow: hidden;
  -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 16%, #000 84%, transparent 100%);
          mask-image: linear-gradient(90deg, transparent 0, #000 16%, #000 84%, transparent 100%); }
.od-compass .baseline { position: absolute; left: 0; right: 0; top: calc(var(--u) * 27); height: calc(var(--u) * 1);
  background: linear-gradient(90deg, transparent, rgba(236,240,234,.5) 20%, rgba(236,240,234,.5) 80%, transparent); box-shadow: 0 calc(var(--u) * 1) calc(var(--u) * 2) rgba(0,0,0,.35); }
.od-compass .strip { position: absolute; left: 0; top: 0; height: 100%; width: 1px; will-change: transform; }
.od-compass .tk { position: absolute; bottom: calc(var(--u) * 13); width: calc(var(--u) * 1.5); height: calc(var(--u) * 5);
  margin-left: calc(var(--u) * -0.75); background: rgba(236,240,234,.7); box-shadow: 0 0 calc(var(--u)*2) rgba(0,0,0,.7); }
.od-compass .tk.m { height: calc(var(--u) * 9); background: rgba(236,240,234,.85); width: calc(var(--u) * 2); margin-left: calc(var(--u) * -1); }
.od-compass .lb { position: absolute; top: calc(var(--u) * 1); width: calc(var(--u) * 60); margin-left: calc(var(--u) * -30); text-align: center;
  font-size: calc(var(--u) * 13); font-weight: 600; letter-spacing: .04em; color: rgba(236,240,234,.82); text-shadow: var(--ts); }
.od-compass .lb.c { font-size: calc(var(--u) * 19); font-weight: 700; color: var(--fg); top: calc(var(--u) * -2); }
.od-compass .lb.i { font-size: calc(var(--u) * 14); font-weight: 600; color: rgba(236,240,234,.8); }
.od-compass .caret { position: absolute; left: 50%; top: calc(var(--u) * 29); width: 0; height: 0; margin-left: calc(var(--u) * -6);
  border-left: calc(var(--u) * 6) solid transparent; border-right: calc(var(--u) * 6) solid transparent;
  border-bottom: calc(var(--u) * 7) solid var(--fg); filter: var(--ds); }
.od-compass .brg { position: absolute; left: 50%; top: calc(var(--u) * 38); width: calc(var(--u) * 80); margin-left: calc(var(--u) * -40);
  text-align: center; font-size: calc(var(--u) * 15); font-weight: 700; letter-spacing: .08em; text-shadow: var(--ts); }
.od-compass .mk { position: absolute; top: calc(var(--u) * 20); width: calc(var(--u) * 12); height: calc(var(--u) * 12); margin-left: calc(var(--u) * -6);
  will-change: transform, opacity; filter: var(--ds); left: 0; }
.od-compass .mk.enemy::before { content: ''; position: absolute; left: 0; top: 0; width: 0; height: 0;
  border-left: calc(var(--u) * 6) solid transparent; border-right: calc(var(--u) * 6) solid transparent; border-top: calc(var(--u) * 9) solid var(--enemy); }
.od-compass .mk.dmg::before { content: ''; position: absolute; left: calc(var(--u) * -4); top: calc(var(--u) * -18); width: calc(var(--u) * 20); height: calc(var(--u) * 26);
  background: linear-gradient(180deg, rgba(255,60,40,0), rgba(255,60,40,.85) 55%, rgba(255,60,40,0)); }
.od-compass .mk.obj { color: var(--accent); width: calc(var(--u) * 16); height: calc(var(--u) * 16); margin-left: calc(var(--u) * -8); top: calc(var(--u) * 14); }

/* =================================================================== minimap */
.od-minimap { position: absolute; left: calc(var(--u) * 28); top: calc(var(--u) * 28); width: calc(var(--u) * 252); height: calc(var(--u) * 252); }
.od-minimap .frame { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 55%, rgba(26,32,36,.86), rgba(9,12,14,.92));
  border: calc(var(--u) * 1) solid rgba(236,240,234,.16); box-shadow: 0 0 calc(var(--u) * 18) rgba(0,0,0,.35), inset 0 0 calc(var(--u)*24) rgba(0,0,0,.45); }
.od-minimap canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.od-minimap .corner { position: absolute; width: calc(var(--u) * 14); height: calc(var(--u) * 14); border-color: rgba(236,240,234,.85); border-style: solid; border-width: 0; filter: var(--ds); }
.od-minimap .corner.tl { left: calc(var(--u) * -3); top: calc(var(--u) * -3); border-left-width: calc(var(--u) * 2); border-top-width: calc(var(--u) * 2); }
.od-minimap .corner.tr { right: calc(var(--u) * -3); top: calc(var(--u) * -3); border-right-width: calc(var(--u) * 2); border-top-width: calc(var(--u) * 2); }
.od-minimap .corner.bl { left: calc(var(--u) * -3); bottom: calc(var(--u) * -3); border-left-width: calc(var(--u) * 2); border-bottom-width: calc(var(--u) * 2); }
.od-minimap .corner.br { right: calc(var(--u) * -3); bottom: calc(var(--u) * -3); border-right-width: calc(var(--u) * 2); border-bottom-width: calc(var(--u) * 2); }
.od-minimap .grid-label { position: absolute; right: calc(var(--u) * 6); bottom: calc(var(--u) * 4); font-size: calc(var(--u) * 11); font-weight: 600;
  color: var(--fg3); letter-spacing: .1em; }

/* ============================================================ match panel (under minimap) */
.od-match { position: absolute; left: calc(var(--u) * 28); top: calc(var(--u) * 292); width: calc(var(--u) * 330); padding: calc(var(--u) * 8) calc(var(--u) * 10) calc(var(--u) * 10);
  margin-left: calc(var(--u) * -10); background: linear-gradient(90deg, rgba(6,8,10,.42), rgba(6,8,10,.18) 60%, rgba(6,8,10,0)); }
.od-match .obj { display: flex; align-items: center; gap: calc(var(--u) * 9); font-size: calc(var(--u) * 17); font-weight: 600;
  letter-spacing: .06em; text-transform: uppercase; text-shadow: var(--ts); }
.od-match .obj .d { width: calc(var(--u) * 16); height: calc(var(--u) * 16); color: var(--accent); filter: var(--ds); flex: none; }
.od-match .wave { display: flex; align-items: baseline; gap: calc(var(--u) * 10); margin-top: calc(var(--u) * 8); text-shadow: var(--ts); }
.od-match .wave .k { font-size: calc(var(--u) * 13); font-weight: 600; letter-spacing: .18em; color: var(--fg2); }
.od-match .wave .n { font-size: calc(var(--u) * 30); font-weight: 700; letter-spacing: .02em; color: var(--fg); line-height: 1; }
.od-match .wave .h { font-size: calc(var(--u) * 14); font-weight: 600; letter-spacing: .08em; color: var(--enemy); margin-left: calc(var(--u) * 6); }
.od-match .wave .h b { font-weight: 700; color: #ff7466; }
.od-match .timer { margin-top: calc(var(--u) * 4); font-size: calc(var(--u) * 14); font-weight: 600; letter-spacing: .1em; color: var(--accent); text-shadow: var(--ts); }

/* =================================================================== killfeed */
.od-feed { position: absolute; right: calc(var(--u) * 30); top: calc(var(--u) * 26); width: calc(var(--u) * 560); display: flex; flex-direction: column; align-items: flex-end; gap: calc(var(--u) * 4); }
.od-feed .row { display: flex; align-items: center; gap: calc(var(--u) * 10); height: calc(var(--u) * 30); padding: 0 calc(var(--u) * 12) 0 calc(var(--u) * 28);
  background: linear-gradient(90deg, rgba(8,10,12,0), rgba(8,10,12,.5) 22%, rgba(8,10,12,.6));
  font-size: calc(var(--u) * 16); font-weight: 600; letter-spacing: .04em; white-space: nowrap; text-shadow: var(--ts); will-change: transform, opacity; }
.od-feed .row.me { background: linear-gradient(90deg, rgba(240,192,72,0), rgba(60,46,14,.55) 22%, rgba(70,54,16,.62)); }
.od-feed .row .nm.f { color: var(--friend); }
.od-feed .row .nm.e { color: #ff6b5c; }
.od-feed .row .nm.me { color: var(--accent); }
.od-feed .row .w { height: calc(var(--u) * 20); width: calc(var(--u) * 66); color: var(--fg); filter: var(--ds); }
.od-feed .row .w.pistol { width: calc(var(--u) * 38); }
.od-feed .row .w.frag, .od-feed .row .w.skull, .od-feed .row .w.explosion { width: calc(var(--u) * 20); }
.od-feed .row .w.knife { width: calc(var(--u) * 44); }
.od-feed .row .hs { width: calc(var(--u) * 20); height: calc(var(--u) * 20); color: var(--fg); filter: var(--ds); }

/* ================================================================= crosshair */
.od-center { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.od-xh { position: absolute; left: 0; top: 0; will-change: opacity; }
.od-xh .ln { position: absolute; background: rgba(250,252,250,.94); box-shadow: 0 0 0 calc(var(--u) * 1) rgba(0,0,0,.42), 0 0 calc(var(--u) * 3) rgba(0,0,0,.35); will-change: transform; }
.od-xh .ln.h { width: calc(var(--u) * 11); height: calc(var(--u) * 2); margin: calc(var(--u) * -1) 0 0 0; }
.od-xh .ln.v { width: calc(var(--u) * 2); height: calc(var(--u) * 11); margin: 0 0 0 calc(var(--u) * -1); }
.od-xh .dot { position: absolute; width: calc(var(--u) * 2); height: calc(var(--u) * 2); margin: calc(var(--u) * -1) 0 0 calc(var(--u) * -1);
  background: rgba(250,252,250,.9); box-shadow: 0 0 0 calc(var(--u) * 1) rgba(0,0,0,.35); border-radius: 50%; }
.od-xh.enemy .ln, .od-xh.enemy .dot { background: #ff5a4a; }

/* ================================================================= hitmarker */
.od-hm { position: absolute; left: 0; top: 0; width: 0; height: 0; will-change: transform, opacity; }
.od-hm .t { position: absolute; left: 0; top: 0; width: calc(var(--u) * 12); height: calc(var(--u) * 2.4); margin: calc(var(--u) * -1.2) 0 0 calc(var(--u) * -6);
  background: #fff; box-shadow: 0 0 0 calc(var(--u) * .8) rgba(0,0,0,.55), 0 0 calc(var(--u) * 4) rgba(0,0,0,.4); }
.od-hm.kill .t { background: #ff3b2e; box-shadow: 0 0 0 calc(var(--u) * .8) rgba(40,0,0,.6), 0 0 calc(var(--u) * 6) rgba(255,40,20,.45); }
.od-hm.hs .t { width: calc(var(--u) * 14); height: calc(var(--u) * 3); margin: calc(var(--u) * -1.5) 0 0 calc(var(--u) * -7); }
.od-hm.hs.kill .t { background: #ff3b2e; }
.od-hm .t2 { display: none; }
.od-hm.hs .t2 { display: block; width: calc(var(--u) * 7); height: calc(var(--u) * 1.8); margin: calc(var(--u) * -0.9) 0 0 calc(var(--u) * -3.5); background: #ffd76a; box-shadow: 0 0 0 calc(var(--u) * .8) rgba(0,0,0,.5); }

/* ========================================================= damage indicators */
.od-dmg { position: absolute; left: 50%; top: 50%; width: calc(var(--u) * 1000); height: calc(var(--u) * 1000); margin: calc(var(--u) * -500) 0 0 calc(var(--u) * -500); }
.od-dmg svg { width: 100%; height: 100%; overflow: visible; filter: drop-shadow(0 0 calc(var(--u) * 6) rgba(255,30,10,.45)); }
.od-blood { position: absolute; inset: 0; will-change: opacity; -webkit-mask-size: 100% 100%; mask-size: 100% 100%; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
  background: rgba(70, 0, 0, .18);
  -webkit-backdrop-filter: brightness(.6) sepia(1) saturate(6) hue-rotate(-38deg) contrast(1.08);
          backdrop-filter: brightness(.6) sepia(1) saturate(6) hue-rotate(-38deg) contrast(1.08); }
.od-blood-rim { position: absolute; inset: 0; background-size: 100% 100%; background-repeat: no-repeat; }
.od-flash { position: absolute; inset: 0; will-change: opacity;
  background: radial-gradient(ellipse 78% 74% at 50% 50%, rgba(90,0,0,0) 58%, rgba(96,4,2,.42) 82%, rgba(70,0,0,.7) 100%); }

/* ================================================================== prompts */
.od-prompt { position: absolute; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: calc(var(--u) * 10);
  white-space: nowrap; font-size: calc(var(--u) * 17); font-weight: 600; letter-spacing: .12em; text-transform: uppercase; text-shadow: var(--ts); }
.od-prompt.reload { top: calc(50% + var(--u) * 64); font-size: calc(var(--u) * 18); }
.od-prompt.reload.low { color: var(--warn); }
.od-prompt.reload.none { color: var(--enemy); }
.od-prompt.interact { top: calc(50% + var(--u) * 150); font-size: calc(var(--u) * 19); letter-spacing: .04em; text-transform: none; }
.od-key { display: inline-flex; align-items: center; justify-content: center; min-width: calc(var(--u) * 26); height: calc(var(--u) * 26); padding: 0 calc(var(--u) * 7);
  border: calc(var(--u) * 1.5) solid rgba(236,240,234,.9); border-radius: calc(var(--u) * 3); background: rgba(10,12,14,.55);
  font-size: calc(var(--u) * 14); font-weight: 700; letter-spacing: .04em; color: var(--fg); text-shadow: none;
  box-shadow: 0 calc(var(--u) * 2) 0 rgba(236,240,234,.25), 0 0 calc(var(--u) * 6) rgba(0,0,0,.4); }
.od-prompt .kr { position: relative; display: inline-flex; align-items: center; justify-content: center; width: calc(var(--u) * 44); height: calc(var(--u) * 44); }
.od-prompt .kr svg { position: absolute; inset: 0; width: 100%; height: 100%; filter: var(--ds); }
.od-prompt .kr .od-key { position: relative; border-color: transparent; background: transparent; box-shadow: none; min-width: 0; }
.od-prompt .vb { color: var(--fg2); font-size: .82em; letter-spacing: .14em; text-transform: uppercase; }
.od-prompt.interact { padding: calc(var(--u) * 6) calc(var(--u) * 18) calc(var(--u) * 6) calc(var(--u) * 12);
  background: linear-gradient(90deg, rgba(8,10,12,0), rgba(8,10,12,.42) 18%, rgba(8,10,12,.42) 82%, rgba(8,10,12,0)); }

/* ===================================================================== ammo */
.od-ammo { position: absolute; right: calc(var(--u) * 44); bottom: calc(var(--u) * 34); width: calc(var(--u) * 420); text-align: right; will-change: opacity; }
.od-ammo .wname { font-size: calc(var(--u) * 16); font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--fg); text-shadow: var(--ts);
  display: flex; justify-content: flex-end; align-items: center; gap: calc(var(--u) * 10); }
.od-ammo .wname .fm { display: flex; align-items: center; gap: calc(var(--u) * 5); color: var(--fg2); font-size: calc(var(--u) * 13); letter-spacing: .12em; }
.od-ammo .wname .fm .i { width: calc(var(--u) * 17); height: calc(var(--u) * 17); color: var(--fg2); filter: var(--ds); }
.od-ammo .row { display: flex; justify-content: flex-end; align-items: flex-end; gap: calc(var(--u) * 12); margin-top: calc(var(--u) * 2); }
.od-ammo .mag { font-size: calc(var(--u) * 62); font-weight: 700; line-height: .9; letter-spacing: .01em; text-shadow: var(--ts); min-width: calc(var(--u) * 76); }
.od-ammo .mag.low { color: var(--warn); }
.od-ammo .mag.empty { color: var(--enemy); }
.od-ammo .sep { width: calc(var(--u) * 2); height: calc(var(--u) * 44); background: rgba(236,240,234,.55); transform: skewX(-14deg); margin-bottom: calc(var(--u) * 2); box-shadow: 0 0 calc(var(--u)*3) rgba(0,0,0,.5); }
.od-ammo .res { font-size: calc(var(--u) * 30); font-weight: 600; color: var(--fg2); line-height: 1; margin-bottom: calc(var(--u) * 2); text-shadow: var(--ts); min-width: calc(var(--u) * 58); text-align: left; }
.od-ammo .res.low { color: var(--warn); }
.od-ammo .bar { position: relative; height: calc(var(--u) * 5); margin-top: calc(var(--u) * 8); margin-left: auto; width: calc(var(--u) * 200); }
.od-ammo .bar .tr, .od-ammo .bar .fl { position: absolute; top: 0; bottom: 0; right: 0; }
.od-ammo .bar .tr { left: 0; background: rgba(236,240,234,.16); }
.od-ammo .bar .fl { background: rgba(240,243,238,.92); box-shadow: 0 0 calc(var(--u) * 4) rgba(0,0,0,.4); }
.od-ammo .bar .fl.low { background: var(--warn); }
.od-ammo .bar .gaps { position: absolute; inset: 0; }
.od-ammo .bar .rl { position: absolute; top: 0; bottom: 0; right: 0; background: var(--accent); opacity: .9; }
.od-ammo .equip { display: flex; justify-content: flex-end; gap: calc(var(--u) * 22); margin-top: calc(var(--u) * 12); }
.od-ammo .eq { display: flex; align-items: center; gap: calc(var(--u) * 7); font-size: calc(var(--u) * 17); font-weight: 700; text-shadow: var(--ts); }
.od-ammo .eq .i { width: calc(var(--u) * 22); height: calc(var(--u) * 25); filter: var(--ds); }
.od-ammo .eq .k { font-size: calc(var(--u) * 11); color: var(--fg3); font-weight: 600; letter-spacing: .08em; }
.od-ammo .eq.zero { opacity: .35; }

/* ============================================================ vitals (bottom-left) */
.od-vitals { position: absolute; left: calc(var(--u) * 44); bottom: calc(var(--u) * 40); width: calc(var(--u) * 300); will-change: opacity; }
.od-vitals .score { display: flex; align-items: baseline; gap: calc(var(--u) * 10); text-shadow: var(--ts); }
.od-vitals .score .k { font-size: calc(var(--u) * 12); font-weight: 600; letter-spacing: .2em; color: var(--fg2); }
.od-vitals .score .v { font-size: calc(var(--u) * 26); font-weight: 700; letter-spacing: .02em; }
.od-vitals .score .s { font-size: calc(var(--u) * 13); font-weight: 600; letter-spacing: .1em; color: var(--accent); margin-left: calc(var(--u) * 8); }
.od-vitals .hp { position: relative; margin-top: calc(var(--u) * 9); height: calc(var(--u) * 6); width: calc(var(--u) * 240); background: rgba(236,240,234,.14); will-change: opacity;
  box-shadow: 0 0 calc(var(--u) * 6) rgba(0,0,0,.35); }
.od-vitals .hp .f { position: absolute; left: 0; top: 0; bottom: 0; background: rgba(240,243,238,.92); transform-origin: 0 50%; will-change: transform; width: 100%; }
.od-vitals .hp .l { position: absolute; left: 0; top: 0; bottom: 0; background: rgba(255,80,60,.75); transform-origin: 0 50%; will-change: transform; width: 100%; }
.od-vitals .hp .f.low { background: #ff5a48; }
.od-vitals .hp .seg { position: absolute; inset: 0; background: repeating-linear-gradient(90deg, transparent 0, transparent calc(var(--u) * 58), rgba(0,0,0,.65) calc(var(--u) * 58), rgba(0,0,0,.65) calc(var(--u) * 60)); }
.od-vitals .lives { display: flex; gap: calc(var(--u) * 5); margin-top: calc(var(--u) * 8); }
.od-vitals .lives i { width: calc(var(--u) * 14); height: calc(var(--u) * 4); background: var(--friend); opacity: .9; box-shadow: 0 0 calc(var(--u) * 4) rgba(0,0,0,.4); }
.od-vitals .lives i.x { background: rgba(236,240,234,.2); }
.od-vitals .lives .k { font-size: calc(var(--u) * 11); font-weight: 600; letter-spacing: .16em; color: var(--fg3); margin-left: calc(var(--u) * 6); margin-top: calc(var(--u) * -4); }

/* =================================================================== popups */
.od-xp { position: absolute; left: 50%; top: calc(50% + var(--u) * 92); width: calc(var(--u) * 400); margin-left: calc(var(--u) * -200); text-align: center; will-change: opacity; }
.od-xp .tot { font-size: calc(var(--u) * 28); font-weight: 700; color: var(--accent); letter-spacing: .02em; text-shadow: var(--ts); display: inline-block; will-change: transform; }
.od-xp .lines { margin-top: calc(var(--u) * 3); }
.od-xp .ln { font-size: calc(var(--u) * 14); font-weight: 600; letter-spacing: .14em; text-transform: uppercase; color: var(--fg); text-shadow: var(--ts); height: calc(var(--u) * 19); will-change: opacity, transform; }
.od-xp .ln b { color: var(--accent); font-weight: 700; margin-left: calc(var(--u) * 8); }

.od-medal { position: absolute; left: 50%; top: calc(var(--u) * 262); width: calc(var(--u) * 500); margin-left: calc(var(--u) * -250); text-align: center; will-change: opacity, transform; }
.od-medal::before { content: ''; position: absolute; left: 10%; right: 10%; top: calc(var(--u) * 40); bottom: calc(var(--u) * -12); z-index: -1;
  background: radial-gradient(ellipse 50% 50% at 50% 60%, rgba(4,6,8,.42), rgba(4,6,8,.16) 60%, rgba(4,6,8,0) 100%); }
.od-medal .ic { width: calc(var(--u) * 78); height: calc(var(--u) * 78); margin: 0 auto; filter: drop-shadow(0 calc(var(--u) * 2) calc(var(--u) * 6) rgba(0,0,0,.7)); will-change: transform; }
.od-medal .tt { margin-top: calc(var(--u) * 8); font-size: calc(var(--u) * 24); font-weight: 700; letter-spacing: .16em; text-transform: uppercase; text-shadow: var(--ts); }
.od-medal .sb { margin-top: calc(var(--u) * 3); font-size: calc(var(--u) * 14); font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #ffd166; text-shadow: var(--ts); }

.od-banner { position: absolute; left: 50%; top: calc(var(--u) * 104); width: calc(var(--u) * 900); margin-left: calc(var(--u) * -450); text-align: center; will-change: opacity; padding: calc(var(--u) * 12) 0 calc(var(--u) * 14); }
.od-banner::before { content: ''; position: absolute; inset: 0; z-index: -1;
  background: radial-gradient(ellipse 46% 60% at 50% 50%, rgba(4,6,8,.5), rgba(4,6,8,.22) 60%, rgba(4,6,8,0) 100%); }
.od-banner .tt { display: inline-block; font-size: calc(var(--u) * 40); font-weight: 700; letter-spacing: .22em; text-transform: uppercase; text-shadow: var(--ts); will-change: letter-spacing; padding-left: .22em; }
.od-banner .tt.warn { color: var(--enemy); }
.od-banner .rule { height: calc(var(--u) * 1); width: calc(var(--u) * 460); margin: calc(var(--u) * 7) auto; background: linear-gradient(90deg, transparent, rgba(240,192,72,.9), transparent); will-change: transform; }
.od-banner .sb { font-size: calc(var(--u) * 16); font-weight: 600; letter-spacing: .16em; text-transform: uppercase; color: rgba(236,240,234,.86); text-shadow: var(--ts); }
.od-banner .kk { font-size: calc(var(--u) * 13); font-weight: 600; letter-spacing: .3em; color: var(--accent); text-transform: uppercase; text-shadow: var(--ts); margin-bottom: calc(var(--u) * 4); }

.od-toast { position: absolute; left: 50%; top: calc(50% - var(--u) * 150); transform: translateX(-50%); white-space: nowrap; font-size: calc(var(--u) * 16); font-weight: 600;
  letter-spacing: .12em; text-transform: uppercase; text-shadow: var(--ts); will-change: opacity; }
.od-toast.warn { color: var(--warn); }

/* ===================================================================== menus */
.od-ui { pointer-events: none; contain: none; }
.od-screen { position: absolute; inset: 0; pointer-events: auto; opacity: 0; visibility: hidden; }
.od-screen.on { opacity: 1; visibility: visible; }
.od-loading { z-index: 40; display: grid; place-items: center; background: rgba(3,5,7,.68); }
.od-loading-card { position: relative; width: min(calc(var(--u) * 620), calc(100vw - var(--u) * 40)); padding: calc(var(--u) * 44) calc(var(--u) * 48); background: linear-gradient(145deg, rgba(20,25,26,.98), rgba(8,11,12,.98)); border: 1px solid rgba(236,240,234,.2); border-left: calc(var(--u) * 3) solid var(--accent); box-shadow: 0 calc(var(--u) * 24) calc(var(--u) * 80) rgba(0,0,0,.65); text-align: center; }
.od-loading-brand { color: var(--accent); font-size: calc(var(--u) * 12); font-weight: 700; letter-spacing: .38em; }
.od-loading-card h2 { margin: calc(var(--u) * 14) 0 0; font-size: calc(var(--u) * 34); font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.od-loading-status { min-height: calc(var(--u) * 42); margin-top: calc(var(--u) * 12); color: var(--fg2); font-size: calc(var(--u) * 14); line-height: 1.5; letter-spacing: .08em; }
.od-loading-bar { position: relative; height: calc(var(--u) * 3); margin: calc(var(--u) * 20) 0 calc(var(--u) * 24); overflow: hidden; background: rgba(236,240,234,.14); }
.od-loading-bar i { position: absolute; inset: 0 auto 0 -35%; width: 35%; background: var(--accent); animation: od-loading-sweep 1.25s ease-in-out infinite; }
@keyframes od-loading-sweep { to { transform: translateX(390%); } }
.od-loading-continue { min-width: calc(var(--u) * 240); }
.od-scrim { position: absolute; inset: 0; background:
  linear-gradient(90deg, rgba(4,6,8,.86) 0, rgba(4,6,8,.62) 34%, rgba(4,6,8,.12) 62%, rgba(4,6,8,0) 100%),
  linear-gradient(0deg, rgba(4,6,8,.7) 0, rgba(4,6,8,0) 26%),
  linear-gradient(180deg, rgba(4,6,8,.55) 0, rgba(4,6,8,0) 18%); }
.od-main .od-scrim { -webkit-backdrop-filter: contrast(1.14) saturate(1.08) brightness(.9); backdrop-filter: contrast(1.14) saturate(1.08) brightness(.9); }
.od-main .od-scrim::after { content: ''; position: absolute; inset: 0;
  background: radial-gradient(ellipse 75% 70% at 62% 45%, rgba(4,6,8,0) 45%, rgba(4,6,8,.38) 85%, rgba(4,6,8,.62) 100%); }
.od-scrim.dark { background: rgba(5,7,9,.5); backdrop-filter: blur(calc(var(--u) * 16)) saturate(.6) brightness(.8); -webkit-backdrop-filter: blur(calc(var(--u) * 16)) saturate(.6) brightness(.8); }
.od-scrim.dark::after { content: ''; position: absolute; inset: 0; background: linear-gradient(90deg, rgba(4,6,8,.75) 0, rgba(4,6,8,.3) 45%, rgba(4,6,8,.1) 100%); }
.od-grain { position: absolute; inset: 0; background-size: calc(var(--u) * 256) calc(var(--u) * 256); }
.od-fadeblack { position: absolute; inset: 0; background: #000; pointer-events: none; }
.od-scan { position: absolute; inset: 0; background: repeating-linear-gradient(0deg, rgba(255,255,255,.018) 0, rgba(255,255,255,.018) 1px, transparent 1px, transparent 3px); pointer-events: none; }

.od-title { position: absolute; left: calc(var(--u) * 120); top: calc(var(--u) * 132); }
.od-title .op { display: flex; align-items: center; gap: calc(var(--u) * 14); font-size: calc(var(--u) * 15); font-weight: 600; letter-spacing: .42em; color: var(--accent); text-transform: uppercase; }
.od-title .op::before { content: ''; width: calc(var(--u) * 46); height: calc(var(--u) * 2); background: var(--accent); }
.od-title h1 { display: flex; align-items: center; font-family: 'Bahnschrift Condensed', 'Bahnschrift SemiCondensed', ${FONT_STACK}; margin: calc(var(--u) * 10) 0 0; font-size: calc(var(--u) * 112); line-height: .86; font-weight: 700; letter-spacing: .02em; text-transform: uppercase;
  color: #f4f2ea; text-shadow: 0 calc(var(--u) * 4) calc(var(--u) * 30) rgba(0,0,0,.55); font-stretch: 75%; font-variation-settings: 'wdth' 75, 'wght' 700; }
.od-title h1 .of { display: inline-flex; flex-direction: column; align-items: center; justify-content: center; font-size: .3em; letter-spacing: .12em; line-height: 1;
  margin: calc(var(--u) * -6) calc(var(--u) * 18) 0 calc(var(--u) * 16); color: var(--accent); font-weight: 700; }
.od-title h1 .of::before, .od-title h1 .of::after { content: ''; width: calc(var(--u) * 22); height: calc(var(--u) * 2); background: var(--accent); margin: calc(var(--u) * 6) 0; opacity: .8; }
.od-title .sub { margin-top: calc(var(--u) * 18); font-size: calc(var(--u) * 15); letter-spacing: .3em; color: var(--fg2); text-transform: uppercase; font-weight: 600; }
.od-title .emb { position: absolute; left: calc(var(--u) * -86); top: calc(var(--u) * 26); width: calc(var(--u) * 64); height: calc(var(--u) * 64); opacity: .9; }
.od-killcam { position: absolute; left: calc(var(--u) * 120); top: calc(var(--u) * 46); color: #ff4a4a; font-size: calc(var(--u) * 14); font-weight: 800; letter-spacing: .2em; text-shadow: 0 2px 12px #000; }
.od-killcam-skip { position: absolute; left: calc(var(--u) * 120); top: calc(var(--u) * 78); padding: calc(var(--u) * 7) calc(var(--u) * 12); border: 1px solid rgba(255,255,255,.45); background: rgba(5,7,9,.78); color: var(--fg); font: inherit; font-size: calc(var(--u) * 11); font-weight: 700; letter-spacing: .14em; text-transform: uppercase; cursor: pointer; }
.od-killcam-skip:hover { color: #111; background: var(--fg); }
.od-killcam-vignette { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(90deg, rgba(5,7,9,.46), transparent 58%), linear-gradient(0deg, rgba(5,7,9,.48), transparent 34%), radial-gradient(ellipse at center, transparent 48%, rgba(5,7,9,.38)); }
.od-killcam-bar { position: absolute; left: calc(var(--u) * 120); right: calc(var(--u) * 120); bottom: calc(var(--u) * 52); height: calc(var(--u) * 3); background: rgba(236,240,234,.28); }
.od-killcam-bar i { display: block; width: 100%; height: 100%; transform: scaleX(0); transform-origin: left; background: #ff4a4a; box-shadow: 0 0 calc(var(--u) * 10) rgba(255,74,74,.65); }

.od-menu { position: absolute; left: calc(var(--u) * 120); top: calc(var(--u) * 440); width: calc(var(--u) * 520); }
.od-menu.pause { top: calc(var(--u) * 300); }
.od-entry-menu { top: calc(var(--u) * 455); }
.od-entry .od-title .sub { margin-top: calc(var(--u) * 24); }
.od-mp-status { position: absolute; left: calc(var(--u) * 120); top: calc(var(--u) * 700); width: calc(var(--u) * 520); padding: calc(var(--u) * 14) calc(var(--u) * 18);
  border-left: calc(var(--u) * 3) solid var(--accent); background: rgba(8,10,12,.82); color: var(--fg2); font-size: calc(var(--u) * 13); line-height: 1.5; letter-spacing: .08em; text-transform: uppercase; }
.od-mp-server-label { display: flex; flex-direction: column; gap: calc(var(--u) * 5); margin-top: calc(var(--u) * 10); color: var(--fg3); font-size: calc(var(--u) * 10); font-weight: 700; letter-spacing: .16em; }
.od-mp-server-input { box-sizing: border-box; width: 100%; padding: calc(var(--u) * 8) calc(var(--u) * 10); border: 1px solid rgba(236,240,234,.25); outline: none; background: rgba(0,0,0,.38); color: var(--fg); font: inherit; font-size: calc(var(--u) * 12); letter-spacing: .04em; text-transform: none; }
.od-mp-server-input:focus { border-color: var(--accent); }
.od-mp-actions { display: flex; gap: calc(var(--u) * 8); flex-wrap: wrap; margin-top: calc(var(--u) * 8); }
.od-mp-actions .od-btn { margin-top: 0; }
.od-item { position: relative; display: block; width: 100%; text-align: left; border: 0; margin: 0 0 calc(var(--u) * 6); padding: calc(var(--u) * 13) calc(var(--u) * 22) calc(var(--u) * 13) calc(var(--u) * 26);
  font: inherit; color: var(--fg2); background: transparent; cursor: pointer; outline: none;
  font-size: calc(var(--u) * 30); font-weight: 700; letter-spacing: .1em; text-transform: uppercase; font-stretch: 85%; font-variation-settings: 'wdth' 85;
  transition: color .12s, background .15s, padding-left .15s; }
.od-item::before { content: ''; position: absolute; left: 0; top: calc(var(--u) * 10); bottom: calc(var(--u) * 10); width: calc(var(--u) * 4); background: var(--accent); transform: scaleY(0); transition: transform .15s; }
.od-item .d { display: block; max-height: 0; overflow: hidden; font-size: calc(var(--u) * 14); font-weight: 600; letter-spacing: .1em; color: var(--fg2); font-stretch: 100%; font-variation-settings: 'wdth' 100; transition: max-height .18s, margin .18s; }
.od-item.sel { color: #fff; background: linear-gradient(90deg, rgba(240,192,72,.2), rgba(240,192,72,.06) 60%, rgba(240,192,72,0)); padding-left: calc(var(--u) * 32); }
.od-item.sel::before { transform: scaleY(1); }
.od-item.sel .d { max-height: calc(var(--u) * 40); margin-top: calc(var(--u) * 5); }
.od-item.dim { opacity: .5; }
.od-item .tag { position: absolute; right: calc(var(--u) * 18); top: 50%; transform: translateY(-50%); font-size: calc(var(--u) * 12); letter-spacing: .2em; color: var(--accent); font-weight: 600; }

.od-foot { position: absolute; left: calc(var(--u) * 120); right: calc(var(--u) * 120); bottom: calc(var(--u) * 44); display: flex; align-items: center; gap: calc(var(--u) * 28);
  font-size: calc(var(--u) * 14); font-weight: 600; letter-spacing: .14em; color: var(--fg2); text-transform: uppercase; }
.od-foot .sp { flex: 1; }
.od-foot .hint { display: flex; align-items: center; gap: calc(var(--u) * 9); }
.od-foot .ver { color: var(--fg3); letter-spacing: .2em; }

.od-card { position: absolute; right: calc(var(--u) * 120); bottom: calc(var(--u) * 120); width: calc(var(--u) * 430); padding: calc(var(--u) * 24) calc(var(--u) * 26);
  background: linear-gradient(180deg, rgba(10,13,15,.72), rgba(10,13,15,.58)); border: calc(var(--u) * 1) solid rgba(236,240,234,.14); backdrop-filter: blur(calc(var(--u) * 4)); -webkit-backdrop-filter: blur(calc(var(--u) * 4)); }
.od-card::before { content: ''; position: absolute; left: 0; top: 0; width: calc(var(--u) * 60); height: calc(var(--u) * 3); background: var(--accent); }
.od-card-head { display: flex; align-items: center; justify-content: space-between; gap: calc(var(--u) * 12); }
.od-card .k { font-size: calc(var(--u) * 12); letter-spacing: .3em; color: var(--accent); font-weight: 600; text-transform: uppercase; }
.od-card .t { margin-top: calc(var(--u) * 6); font-size: calc(var(--u) * 32); font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.od-card .p { margin-top: calc(var(--u) * 8); font-size: calc(var(--u) * 15); line-height: 1.45; color: var(--fg2); letter-spacing: .02em; }
.od-card .map { position: relative; margin-top: calc(var(--u) * 16); height: calc(var(--u) * 170); background: rgba(0,0,0,.35); border: calc(var(--u) * 1) solid rgba(236,240,234,.12); overflow: hidden; }
.od-card .map canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.od-card .stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: calc(var(--u) * 10); margin-top: calc(var(--u) * 16); }
.od-card .stats div { font-size: calc(var(--u) * 11); letter-spacing: .2em; color: var(--fg3); font-weight: 600; text-transform: uppercase; }
.od-card .stats b { display: block; margin-top: calc(var(--u) * 3); font-size: calc(var(--u) * 17); letter-spacing: .06em; color: var(--fg); font-weight: 700; }

.od-mode-popup { position: absolute; z-index: 30; inset: 0; display: grid; place-items: center; opacity: 0; visibility: hidden; pointer-events: none; transition: opacity .18s, visibility .18s; }
.od-mode-popup.on { opacity: 1; visibility: visible; pointer-events: auto; }
.od-mode-backdrop { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: rgba(3,5,7,.78); backdrop-filter: blur(calc(var(--u) * 8)); -webkit-backdrop-filter: blur(calc(var(--u) * 8)); cursor: default; }
.od-mode-dialog { position: relative; width: min(calc(var(--u) * 1020), calc(100vw - var(--u) * 48)); padding: calc(var(--u) * 34); background: linear-gradient(145deg, rgba(20,25,26,.98), rgba(8,11,12,.98)); border: 1px solid rgba(236,240,234,.2); box-shadow: 0 calc(var(--u) * 24) calc(var(--u) * 80) rgba(0,0,0,.65); }
.od-mode-dialog::before { content: ''; position: absolute; left: 0; top: 0; width: calc(var(--u) * 110); height: calc(var(--u) * 3); background: var(--accent); }
.od-mode-dialog-head { display: flex; align-items: center; justify-content: space-between; }
.od-mode-dialog-title { font-size: calc(var(--u) * 28); font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
.od-mode-close { width: calc(var(--u) * 38); height: calc(var(--u) * 38); border: 1px solid rgba(236,240,234,.2); background: rgba(236,240,234,.05); color: var(--fg); font: inherit; font-size: calc(var(--u) * 27); line-height: 1; cursor: pointer; }
.od-mode-close:hover, .od-mode-close:focus-visible { color: #111; background: var(--accent); outline: none; }
.od-mode-dialog-sub { margin-top: calc(var(--u) * 5); color: var(--fg2); font-size: calc(var(--u) * 13); letter-spacing: .16em; text-transform: uppercase; }
.od-mode-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: calc(var(--u) * 14); margin-top: calc(var(--u) * 24); }
.od-mode-option { min-width: 0; padding: 0; overflow: hidden; text-align: left; border: 1px solid rgba(236,240,234,.16); background: rgba(236,240,234,.045); color: var(--fg); font: inherit; cursor: pointer; transition: border-color .15s, background .15s, transform .15s, box-shadow .15s; }
.od-mode-option:hover, .od-mode-option:focus-visible { transform: translateY(calc(var(--u) * -3)); border-color: rgba(240,192,72,.72); outline: none; }
.od-mode-option.sel { border-color: var(--accent); background: rgba(240,192,72,.09); box-shadow: 0 0 0 1px rgba(240,192,72,.25), 0 calc(var(--u) * 8) calc(var(--u) * 24) rgba(0,0,0,.25); }
.od-mode-thumb { position: relative; display: block; height: calc(var(--u) * 150); overflow: hidden; background: #161b1a; }
.od-mode-thumb canvas { display: block; width: 100%; height: 100%; object-fit: cover; }
.od-mode-mark { position: absolute; left: calc(var(--u) * 12); bottom: calc(var(--u) * 10); color: #fff; font-size: calc(var(--u) * 10); font-weight: 700; letter-spacing: .2em; text-shadow: 0 1px 6px #000; }
.od-mode-info { display: block; padding: calc(var(--u) * 14) calc(var(--u) * 15) calc(var(--u) * 16); }
.od-mode-name { display: block; font-size: calc(var(--u) * 16); font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.od-mode-desc { display: block; margin-top: calc(var(--u) * 5); color: var(--fg2); font-size: calc(var(--u) * 11); letter-spacing: .06em; }

.od-hdr { position: absolute; left: calc(var(--u) * 120); top: calc(var(--u) * 96); }
.od-hdr .k { font-size: calc(var(--u) * 14); letter-spacing: .38em; color: var(--accent); font-weight: 600; text-transform: uppercase; display: flex; align-items: center; gap: calc(var(--u) * 12); }
.od-hdr .k::before { content: ''; width: calc(var(--u) * 36); height: calc(var(--u) * 2); background: var(--accent); }
.od-hdr h2 { margin: calc(var(--u) * 8) 0 0; font-size: calc(var(--u) * 64); font-weight: 700; letter-spacing: .06em; text-transform: uppercase; line-height: .95; font-stretch: 80%; font-variation-settings: 'wdth' 80; }

/* settings */
.od-set { position: absolute; left: calc(var(--u) * 120); top: calc(var(--u) * 250); right: calc(var(--u) * 120); bottom: calc(var(--u) * 110); display: flex; gap: calc(var(--u) * 40); }
.od-armory-content { position: absolute; left: calc(var(--u) * 120); top: calc(var(--u) * 215); right: calc(var(--u) * 120); bottom: calc(var(--u) * 105); overflow: auto; color: var(--fg2); font-size: calc(var(--u) * 15); line-height: 1.5; }
.od-armory-grid { display: grid; grid-template-columns: 1fr 1fr; gap: calc(var(--u) * 24); margin-bottom: calc(var(--u) * 20); }
.od-armory-grid section { padding: calc(var(--u) * 18) calc(var(--u) * 22); background: rgba(10,13,15,.72); border-left: calc(var(--u) * 3) solid var(--accent); }
.od-armory-grid h3 { margin: 0 0 calc(var(--u) * 8); color: var(--fg); font-size: calc(var(--u) * 19); letter-spacing: .1em; text-transform: uppercase; }
.od-armory-grid p { margin: calc(var(--u) * 6) 0 calc(var(--u) * 12); }
.od-armory-rank { color: var(--accent); font-size: calc(var(--u) * 30); font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
.od-armory-bar { height: calc(var(--u) * 5); background: rgba(236,240,234,.15); overflow: hidden; }
.od-armory-bar i { display: block; width: 100%; height: 100%; transform-origin: left; background: var(--accent); }
.od-armory-unlock { display: flex; gap: calc(var(--u) * 12); padding: calc(var(--u) * 5) 0; border-top: 1px solid rgba(236,240,234,.08); font-size: calc(var(--u) * 12); }
.od-armory-unlock b { min-width: calc(var(--u) * 145); color: var(--fg3); letter-spacing: .08em; }
.od-armory-unlock.on b { color: var(--accent); }
.od-armory-grenades { display: flex; flex-wrap: wrap; gap: calc(var(--u) * 8); margin: calc(var(--u) * 12) 0; }
.od-armory-weapons section { min-width: 0; }
.od-armory-note { color: var(--accent); letter-spacing: .04em; }
.od-tabs { display: flex; gap: calc(var(--u) * 6); position: absolute; left: calc(var(--u) * 120); top: calc(var(--u) * 196); }
.od-tab { border: 0; font: inherit; cursor: pointer; background: rgba(236,240,234,.06); color: var(--fg2); padding: calc(var(--u) * 10) calc(var(--u) * 22);
  font-size: calc(var(--u) * 16); font-weight: 700; letter-spacing: .16em; text-transform: uppercase; border-bottom: calc(var(--u) * 2) solid transparent; transition: background .12s, color .12s; }
.od-tab:hover { background: rgba(236,240,234,.12); color: var(--fg); }
.od-tab.sel { color: #111; background: var(--fg); border-bottom-color: var(--accent); }
.od-rows { width: calc(var(--u) * 860); overflow-y: auto; overflow-x: hidden; padding-right: calc(var(--u) * 8); padding-bottom: calc(var(--u) * 36);
  -webkit-mask-image: linear-gradient(180deg, #000 calc(100% - var(--u) * 48), transparent); mask-image: linear-gradient(180deg, #000 calc(100% - var(--u) * 48), transparent); }
.od-rows::-webkit-scrollbar { width: calc(var(--u) * 4); } .od-rows::-webkit-scrollbar-thumb { background: rgba(236,240,234,.25); }
.od-sec { margin: calc(var(--u) * 18) 0 calc(var(--u) * 8); font-size: calc(var(--u) * 12); font-weight: 600; letter-spacing: .32em; color: var(--accent); text-transform: uppercase; }
.od-sec:first-child { margin-top: 0; }
.od-row { display: flex; align-items: center; height: calc(var(--u) * 48); padding: 0 calc(var(--u) * 18); margin-bottom: calc(var(--u) * 3);
  background: linear-gradient(90deg, rgba(236,240,234,.07), rgba(236,240,234,.03)); cursor: pointer; transition: background .12s; }
.od-row:hover, .od-row.sel { background: linear-gradient(90deg, rgba(240,192,72,.2), rgba(240,192,72,.05)); }
.od-row .lb { flex: 1; font-size: calc(var(--u) * 17); font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.od-row .ctl { width: calc(var(--u) * 360); display: flex; align-items: center; justify-content: flex-end; gap: calc(var(--u) * 12); }
.od-row .val { min-width: calc(var(--u) * 58); text-align: right; font-size: calc(var(--u) * 17); font-weight: 700; }
.od-sl { position: relative; width: calc(var(--u) * 250); height: calc(var(--u) * 20); cursor: ew-resize; }
.od-sl .tr { position: absolute; left: 0; right: 0; top: 50%; height: calc(var(--u) * 4); margin-top: calc(var(--u) * -2); background: rgba(236,240,234,.18); }
.od-sl .fl { position: absolute; left: 0; top: 50%; height: calc(var(--u) * 4); margin-top: calc(var(--u) * -2); background: var(--fg); }
.od-sl .kn { position: absolute; top: 50%; width: calc(var(--u) * 6); height: calc(var(--u) * 18); margin: calc(var(--u) * -9) 0 0 calc(var(--u) * -3); background: var(--accent); box-shadow: 0 0 calc(var(--u) * 6) rgba(0,0,0,.5); }
.od-cyc { display: flex; align-items: center; gap: calc(var(--u) * 10); font-size: calc(var(--u) * 17); font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.od-cyc .a { width: calc(var(--u) * 10); height: calc(var(--u) * 16); color: var(--fg2); cursor: pointer; }
.od-cyc .a:hover { color: var(--accent); }
.od-cyc .v { min-width: calc(var(--u) * 150); text-align: center; }
.od-cyc .pips { display: flex; gap: calc(var(--u) * 4); justify-content: center; margin-top: calc(var(--u) * 5); }
.od-cyc .pips i { width: calc(var(--u) * 16); height: calc(var(--u) * 3); background: rgba(236,240,234,.2); }
.od-cyc .pips i.on { background: var(--accent); }
.od-desc { flex: 1; max-width: calc(var(--u) * 520); padding: calc(var(--u) * 26) calc(var(--u) * 28); background: rgba(10,13,15,.55); border-left: calc(var(--u) * 3) solid var(--accent); align-self: flex-start; }
.od-account-panel { display: none; flex: 1; min-height: calc(var(--u) * 300); padding: calc(var(--u) * 38); background: linear-gradient(135deg, rgba(20,25,26,.92), rgba(8,11,12,.86)); border-left: calc(var(--u) * 3) solid var(--accent); color: var(--fg2); }
.od-account-kicker { color: var(--accent); font-size: calc(var(--u) * 12); font-weight: 700; letter-spacing: .28em; text-transform: uppercase; }
.od-account-panel h3 { margin: calc(var(--u) * 10) 0; color: var(--fg); font-size: calc(var(--u) * 32); letter-spacing: .08em; text-transform: uppercase; }
.od-account-copy { max-width: calc(var(--u) * 600); font-size: calc(var(--u) * 15); line-height: 1.6; }
.od-account-field { display: flex; flex-direction: column; gap: calc(var(--u) * 8); max-width: calc(var(--u) * 500); margin: calc(var(--u) * 30) 0 calc(var(--u) * 18); color: var(--fg); font-size: calc(var(--u) * 12); font-weight: 700; letter-spacing: .2em; text-transform: uppercase; }
.od-account-input { width: 100%; box-sizing: border-box; padding: calc(var(--u) * 14) calc(var(--u) * 16); border: 1px solid rgba(236,240,234,.3); outline: none; background: rgba(0,0,0,.35); color: var(--fg); font: inherit; font-size: calc(var(--u) * 20); letter-spacing: .05em; }
.od-account-input:focus { border-color: var(--accent); box-shadow: 0 0 calc(var(--u) * 16) rgba(240,192,72,.16); }
.od-account-actions { display: flex; align-items: center; gap: calc(var(--u) * 18); flex-wrap: wrap; }
.od-account-status { color: var(--accent); font-size: calc(var(--u) * 13); }
.od-account-status.error { color: #ff7770; }
.od-desc .t { font-size: calc(var(--u) * 26); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.od-desc .p { margin-top: calc(var(--u) * 12); font-size: calc(var(--u) * 16); line-height: 1.5; color: var(--fg2); }
.od-desc .dflt { margin-top: calc(var(--u) * 18); font-size: calc(var(--u) * 12); letter-spacing: .2em; color: var(--fg3); text-transform: uppercase; font-weight: 600; }
.od-row.bind .ctl { gap: calc(var(--u) * 8); }
.od-row.bind .od-key { min-width: calc(var(--u) * 34); height: calc(var(--u) * 30); font-size: calc(var(--u) * 14); }
.od-row.bind.listen .od-key { border-color: var(--accent); color: var(--accent); }
.od-btn { border: calc(var(--u) * 1.5) solid rgba(236,240,234,.5); background: rgba(10,13,15,.5); color: var(--fg); font: inherit; cursor: pointer;
  padding: calc(var(--u) * 10) calc(var(--u) * 22); font-size: calc(var(--u) * 15); font-weight: 700; letter-spacing: .16em; text-transform: uppercase; transition: background .12s, color .12s, border-color .12s; }
.od-btn:hover, .od-btn.sel { background: var(--fg); color: #111; border-color: var(--fg); }
.od-btn.pri { background: var(--accent); border-color: var(--accent); color: #151208; }
.od-btn.pri:hover { background: #ffd978; }

/* pause stats */
.od-pstats { position: absolute; right: calc(var(--u) * 120); top: calc(var(--u) * 300); width: calc(var(--u) * 420); }
.od-pstats .row { display: flex; justify-content: space-between; align-items: baseline; padding: calc(var(--u) * 12) 0; border-bottom: calc(var(--u) * 1) solid rgba(236,240,234,.1); }
.od-pstats .row .k { font-size: calc(var(--u) * 13); font-weight: 600; letter-spacing: .24em; color: var(--fg2); text-transform: uppercase; }
.od-pstats .row .v { font-size: calc(var(--u) * 26); font-weight: 700; letter-spacing: .04em; }
.od-pstats .ttl { font-size: calc(var(--u) * 13); letter-spacing: .32em; color: var(--accent); font-weight: 600; text-transform: uppercase; margin-bottom: calc(var(--u) * 6); }

/* death */
.od-death .tint { position: absolute; inset: 0; background: radial-gradient(ellipse 70% 65% at 50% 45%, rgba(60,0,0,.15), rgba(40,0,0,.72) 75%, rgba(12,0,0,.92)); }
.od-death .kia { position: absolute; left: 0; right: 0; top: calc(var(--u) * 170); text-align: center; }
.od-death .kia .k { font-size: calc(var(--u) * 15); letter-spacing: .5em; color: #ff8a7a; font-weight: 600; text-transform: uppercase; padding-left: .5em; }
.od-death .kia h2 { margin: calc(var(--u) * 10) 0 0; font-size: calc(var(--u) * 92); font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #fff4f0;
  text-shadow: 0 0 calc(var(--u) * 40) rgba(255,40,20,.35), 0 calc(var(--u) * 3) calc(var(--u) * 12) rgba(0,0,0,.6); font-stretch: 78%; font-variation-settings: 'wdth' 78; padding-left: .12em; will-change: letter-spacing, opacity; }
.od-death .kia .rule { width: calc(var(--u) * 620); height: calc(var(--u) * 2); margin: calc(var(--u) * 14) auto 0; background: linear-gradient(90deg, transparent, rgba(255,90,70,.9), transparent); }
.od-killer { position: absolute; left: 50%; top: calc(var(--u) * 400); width: calc(var(--u) * 660); margin-left: calc(var(--u) * -330); display: flex; align-items: center; gap: calc(var(--u) * 24);
  padding: calc(var(--u) * 20) calc(var(--u) * 28); background: linear-gradient(90deg, rgba(20,6,6,.72), rgba(20,8,8,.5)); border-left: calc(var(--u) * 4) solid var(--enemy); }
.od-killer .who { flex: 1; }
.od-killer .who .k { font-size: calc(var(--u) * 12); letter-spacing: .3em; color: var(--fg2); font-weight: 600; text-transform: uppercase; }
.od-killer .who .n { margin-top: calc(var(--u) * 5); font-size: calc(var(--u) * 30); font-weight: 700; letter-spacing: .06em; color: #ff6b5c; text-transform: uppercase; }
.od-killer .who .f { margin-top: calc(var(--u) * 3); font-size: calc(var(--u) * 13); letter-spacing: .16em; color: var(--fg3); font-weight: 600; text-transform: uppercase; }
.od-killer .wp { text-align: right; }
.od-killer .wp .i { width: calc(var(--u) * 120); height: calc(var(--u) * 36); margin-left: auto; color: var(--fg); filter: var(--ds); }
.od-killer .wp .t { margin-top: calc(var(--u) * 6); font-size: calc(var(--u) * 13); letter-spacing: .16em; color: var(--fg2); font-weight: 600; text-transform: uppercase; }
.od-dstats { position: absolute; left: 50%; top: calc(var(--u) * 540); width: calc(var(--u) * 660); margin-left: calc(var(--u) * -330); display: grid; grid-template-columns: repeat(4, 1fr); gap: calc(var(--u) * 4); }
.od-dstats div { padding: calc(var(--u) * 14) calc(var(--u) * 16); background: rgba(10,6,6,.55); font-size: calc(var(--u) * 11); letter-spacing: .24em; color: var(--fg2); font-weight: 600; text-transform: uppercase; }
.od-dstats b { display: block; margin-top: calc(var(--u) * 6); font-size: calc(var(--u) * 28); letter-spacing: .02em; color: var(--fg); font-weight: 700; }
.od-redeploy { position: absolute; left: 50%; top: calc(var(--u) * 700); width: calc(var(--u) * 660); margin-left: calc(var(--u) * -330); text-align: center; }
.od-redeploy .t { display: flex; justify-content: center; align-items: center; gap: calc(var(--u) * 12); font-size: calc(var(--u) * 17); font-weight: 700; letter-spacing: .24em; text-transform: uppercase; }
.od-redeploy .bar { margin-top: calc(var(--u) * 14); height: calc(var(--u) * 4); background: rgba(236,240,234,.15); position: relative; }
.od-redeploy .bar i { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; background: var(--fg); transform-origin: 0 50%; }
.od-redeploy .btns { display: flex; justify-content: center; gap: calc(var(--u) * 12); margin-top: calc(var(--u) * 22); }
.od-redeploy .lv { margin-top: calc(var(--u) * 12); font-size: calc(var(--u) * 13); letter-spacing: .2em; color: var(--fg2); font-weight: 600; text-transform: uppercase; }

.od-resume { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: calc(var(--u) * 12); background: rgba(4,6,8,.45); cursor: pointer; }
.od-resume .t { font-size: calc(var(--u) * 30); font-weight: 700; letter-spacing: .3em; text-transform: uppercase; padding-left: .3em; }
.od-resume .s { font-size: calc(var(--u) * 14); letter-spacing: .24em; color: var(--fg2); text-transform: uppercase; font-weight: 600; }
`;

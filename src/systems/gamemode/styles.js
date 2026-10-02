/**
 * gamemode/styles.js — CSS for menus + game-flow overlays (scoped under .gmx).
 *
 * All ENTRANCE/EXIT animation is driven from JS with the simulation/UI clock (deterministic in shot mode);
 * CSS transitions are only used for pointer hover feedback, which never appears in captures.
 */
const RAW = String.raw`
.gmx {
  --fg: #eceee8;
  --fg-2: rgba(236, 238, 232, 0.72);
  --fg-3: rgba(236, 238, 232, 0.46);
  --fg-4: rgba(236, 238, 232, 0.22);
  --line: rgba(236, 238, 232, 0.16);
  --accent: #f2b23a;
  --accent-2: #ffd27c;
  --accent-dim: rgba(242, 178, 58, 0.16);
  --red: #e5483b;
  --red-dim: rgba(229, 72, 59, 0.2);
  --panel: rgba(10, 12, 11, 0.66);
  --panel-2: rgba(16, 19, 18, 0.82);
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.85), 0 0 18px rgba(0, 0, 0, 0.35);
  --font: "Bahnschrift", "DIN Alternate", "DIN Next", "Roboto Condensed", "Segoe UI", system-ui, sans-serif;
  --font-cond: "Bahnschrift SemiCondensed", "Bahnschrift Condensed", "Bahnschrift", "Roboto Condensed", "Arial Narrow", sans-serif;
  --font-mono: "Cascadia Mono", "Consolas", "Lucida Console", ui-monospace, monospace;
  position: absolute; inset: 0; pointer-events: none; color: var(--fg);
  font-family: var(--font); font-weight: 400; letter-spacing: 0.02em;
  -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision;
}
.gmx * { box-sizing: border-box; }
.gmx .hide { display: none !important; }
.gmx .num { font-variant-numeric: tabular-nums; }
.gmx .layer { position: absolute; inset: 0; }
.gmx .interactive { pointer-events: auto; }

/* ------------------------------------------------------------------ shared bits */
.gmx .kicker { display: flex; align-items: center; gap: 12px; font-size: 13px; font-weight: 600;
  letter-spacing: 0.34em; text-transform: uppercase; color: var(--accent); }
.gmx .kicker::before { content: ""; width: 26px; height: 2px; background: currentColor; }
.gmx .kicker.red { color: var(--red); }
.gmx .kicker.center::after { content: ""; width: 26px; height: 2px; background: currentColor; }
.gmx .kbd { display: inline-flex; align-items: center; justify-content: center; min-width: 26px; height: 24px; padding: 0 7px;
  border: 1px solid rgba(236,238,232,0.45); border-radius: 3px; font-size: 12px; font-weight: 600; letter-spacing: 0.06em;
  color: var(--fg); background: rgba(0,0,0,0.35); margin-right: 8px; }
.gmx .grain { position: absolute; inset: -50%; opacity: 0.075; mix-blend-mode: overlay; pointer-events: none;
  background-size: 192px 192px; }
.gmx .vignette { position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(ellipse 85% 75% at 50% 48%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.55) 100%); }
.gmx .fade { position: absolute; inset: 0; background: #000; opacity: 0; pointer-events: none; }

/* ------------------------------------------------------------------ buttons / lists */
.gmx .btnlist { display: flex; flex-direction: column; gap: 4px; width: 460px; }
.gmx .btn { position: relative; display: flex; align-items: center; justify-content: space-between; width: 100%;
  height: 54px; padding: 0 22px 0 26px; border: 0; background: transparent; color: var(--fg-2);
  font-family: var(--font-cond); font-size: 25px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase;
  text-align: left; cursor: pointer; outline: none; transition: color 90ms linear, background 90ms linear; }
.gmx .btn::before { content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; background: var(--accent);
  transform: scaleY(0); transform-origin: center; transition: transform 120ms ease-out; }
.gmx .btn.sel { color: #fff; background: linear-gradient(90deg, rgba(236,238,232,0.13), rgba(236,238,232,0.035) 70%, rgba(236,238,232,0)); }
.gmx .btn.sel::before { transform: scaleY(1); }
.gmx .btn.primary { color: #fff; }
.gmx .btn.primary.sel { background: linear-gradient(90deg, rgba(242,178,58,0.30), rgba(242,178,58,0.07) 70%, rgba(242,178,58,0)); }
.gmx .btn .val { display: flex; align-items: center; gap: 12px; font-size: 18px; letter-spacing: 0.16em; color: var(--accent); }
.gmx .btn .val i { font-style: normal; color: var(--fg-3); font-size: 16px; }
.gmx .btn .tag { font-size: 12px; letter-spacing: 0.24em; color: var(--fg-3); }
.gmx .btn.danger.sel { background: linear-gradient(90deg, rgba(229,72,59,0.26), rgba(229,72,59,0.05) 70%, rgba(229,72,59,0)); }
.gmx .btn.danger::before { background: var(--red); }
.gmx .hint { margin-top: 18px; padding-left: 26px; min-height: 40px; max-width: 460px; font-size: 15px; line-height: 1.45;
  color: var(--fg-3); letter-spacing: 0.03em; }

/* ------------------------------------------------------------------ main menu */
.gmx .menu { background:
    linear-gradient(90deg, rgba(4,6,5,0.9) 0%, rgba(4,6,5,0.72) 26%, rgba(4,6,5,0.28) 50%, rgba(4,6,5,0) 66%),
    linear-gradient(0deg, rgba(4,6,5,0.82) 0%, rgba(4,6,5,0) 26%),
    linear-gradient(180deg, rgba(4,6,5,0.55) 0%, rgba(4,6,5,0) 22%); }
.gmx .brand { position: absolute; left: 6.2vw; top: 6.5vh; display: flex; align-items: center; gap: 18px; }
.gmx .brand svg { width: 58px; height: 64px; flex: none; }
.gmx .brand .wm { display: flex; flex-direction: column; gap: 3px; }
.gmx .brand .wm b { font-family: var(--font-cond); font-size: 34px; font-weight: 700; letter-spacing: 0.26em; line-height: 1; color: #fff; }
.gmx .brand .wm span { font-size: 12px; font-weight: 600; letter-spacing: 0.42em; color: var(--fg-3); text-transform: uppercase; }
.gmx .menu-main { position: absolute; left: 6.2vw; top: 24vh; }
.gmx .mode-title { margin: 14px 0 6px; font-family: var(--font-cond); font-size: 86px; font-weight: 700; line-height: 0.92;
  letter-spacing: 0.02em; text-transform: uppercase; color: #fff; text-shadow: 0 2px 24px rgba(0,0,0,0.5); }
.gmx .mode-sub { margin: 0 0 38px; font-size: 16px; letter-spacing: 0.24em; text-transform: uppercase; color: var(--fg-2); }
.gmx .mode-sub em { font-style: normal; color: var(--accent); }

.gmx .brief { position: absolute; right: 5.2vw; bottom: 13vh; width: 440px; padding: 26px 28px 22px;
  background: linear-gradient(180deg, rgba(12,14,13,0.78), rgba(12,14,13,0.62)); border-top: 2px solid var(--accent);
  backdrop-filter: blur(8px); box-shadow: 0 24px 60px rgba(0,0,0,0.45); }
.gmx .brief h3 { margin: 14px 0 10px; font-family: var(--font-cond); font-size: 30px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
.gmx .brief p { margin: 0 0 18px; font-size: 15px; line-height: 1.55; color: var(--fg-2); }
.gmx .kv { display: grid; grid-template-columns: auto 1fr; column-gap: 18px; row-gap: 9px; padding-top: 16px; border-top: 1px solid var(--line); }
.gmx .kv dt { font-size: 12px; font-weight: 600; letter-spacing: 0.26em; color: var(--fg-3); text-transform: uppercase; padding-top: 2px; }
.gmx .kv dd { margin: 0; font-size: 15px; letter-spacing: 0.06em; text-align: right; color: var(--fg); }
.gmx .kv dd.acc { color: var(--accent); }
.gmx .intel { position: absolute; right: 5.2vw; top: 7vh; text-align: right; font-size: 12px; letter-spacing: 0.3em;
  text-transform: uppercase; color: var(--fg-3); line-height: 1.9; }
.gmx .intel b { color: var(--fg-2); font-weight: 600; }
.gmx .intel .live { display: inline-block; width: 7px; height: 7px; margin-right: 8px; border-radius: 50%; background: var(--red);
  box-shadow: 0 0 10px var(--red); vertical-align: 1px; }

.gmx .footer { position: absolute; left: 0; right: 0; bottom: 0; height: 64px; display: flex; align-items: center;
  justify-content: space-between; padding: 0 5.2vw 0 6.2vw; border-top: 1px solid rgba(236,238,232,0.08);
  background: linear-gradient(0deg, rgba(0,0,0,0.5), rgba(0,0,0,0.15)); font-size: 13px; letter-spacing: 0.16em;
  text-transform: uppercase; color: var(--fg-3); }
.gmx .footer .keys { display: flex; gap: 26px; align-items: center; }
.gmx .footer .keys span { display: inline-flex; align-items: center; }

/* ------------------------------------------------------------------ pause */
.gmx .pause { background: rgba(6,8,7,0.42); backdrop-filter: blur(7px) saturate(0.55) brightness(0.72); }
.gmx .pause::before { content: ""; position: absolute; inset: 0;
  background: linear-gradient(90deg, rgba(4,6,5,0.85) 0%, rgba(4,6,5,0.5) 36%, rgba(4,6,5,0) 62%); }
.gmx .pause-main { position: absolute; left: 6.2vw; top: 21vh; }
.gmx .pause-title { margin: 12px 0 4px; font-family: var(--font-cond); font-size: 72px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
.gmx .pause-sub { margin: 0 0 34px; font-size: 15px; letter-spacing: 0.24em; color: var(--fg-2); text-transform: uppercase; }
.gmx .status { position: absolute; right: 5.2vw; top: 21vh; width: 400px; padding: 24px 26px;
  background: var(--panel); border-top: 2px solid var(--accent); }
.gmx .status .big { display: flex; align-items: baseline; gap: 12px; margin: 14px 0 18px; }
.gmx .status .big b { font-family: var(--font-cond); font-size: 64px; font-weight: 700; line-height: 1; }
.gmx .status .big span { font-size: 16px; letter-spacing: 0.2em; color: var(--fg-3); text-transform: uppercase; }
.gmx .status .statgrid b { font-size: 38px; }
.gmx .status .statgrid div { padding: 14px 10px 12px 0; }
.gmx .status .statgrid span { letter-spacing: 0.24em; }
.gmx .status .obj { display: flex; gap: 12px; align-items: center; margin-top: 18px;
  font-size: 15px; letter-spacing: 0.08em; text-transform: uppercase; }
.gmx .status .obj svg { width: 18px; height: 18px; flex: none; }

/* ------------------------------------------------------------------ sheets: settings / controls / confirm */
.gmx .sheet { position: absolute; left: 6.2vw; top: 14vh; bottom: 12vh; width: 660px; display: flex; flex-direction: column;
  padding: 30px 34px 26px; background: linear-gradient(180deg, rgba(10,12,11,0.92), rgba(10,12,11,0.86));
  border-top: 2px solid var(--accent); box-shadow: 0 30px 80px rgba(0,0,0,0.55); backdrop-filter: blur(10px); }
.gmx .sheet h2 { margin: 12px 0 18px; font-family: var(--font-cond); font-size: 44px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
.gmx .sheet .scroll { flex: 1; overflow-y: auto; margin-right: -14px; padding-right: 14px; }
.gmx .sheet .group { margin: 20px 0 6px; font-size: 12px; font-weight: 600; letter-spacing: 0.34em; color: var(--fg-3); text-transform: uppercase; }
.gmx .row { display: grid; grid-template-columns: 1fr 300px; align-items: center; min-height: 48px; padding: 0 14px;
  border-bottom: 1px solid rgba(236,238,232,0.06); font-size: 17px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-2); }
.gmx .row:hover { background: rgba(236,238,232,0.05); color: #fff; }
.gmx .row .ctl { display: flex; align-items: center; justify-content: flex-end; gap: 14px; }
.gmx .row .ctl output { width: 52px; text-align: right; color: var(--accent); font-size: 16px; font-variant-numeric: tabular-nums; }
.gmx .row input[type=range] { -webkit-appearance: none; appearance: none; width: 210px; height: 22px; background: transparent; cursor: pointer; }
.gmx .row input[type=range]::-webkit-slider-runnable-track { height: 3px; background: linear-gradient(90deg, var(--accent) var(--p, 50%), rgba(236,238,232,0.22) var(--p, 50%)); }
.gmx .row input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 18px; margin-top: -7.5px; background: #fff; border: 0; border-radius: 1px; box-shadow: 0 0 0 3px rgba(0,0,0,0.35); }
.gmx .seg { display: flex; gap: 2px; }
.gmx .seg button { height: 32px; padding: 0 12px; border: 0; background: rgba(236,238,232,0.08); color: var(--fg-3);
  font-family: var(--font); font-size: 13px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; cursor: pointer; }
.gmx .seg button:hover { color: #fff; }
.gmx .seg button.on { background: var(--accent); color: #111; }
.gmx .binds { display: grid; grid-template-columns: 1fr auto; }
.gmx .binds div { min-height: 40px; display: flex; align-items: center; padding: 0 14px; border-bottom: 1px solid rgba(236,238,232,0.06);
  font-size: 16px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--fg-2); }
.gmx .binds div.k { justify-content: flex-end; gap: 6px; }
.gmx .binds div.k .kbd { margin: 0; }
.gmx .sheet .back { margin-top: 18px; width: 240px; }
.gmx .confirm { position: absolute; left: 50%; top: 50%; width: 560px; transform: translate(-50%, -50%); padding: 30px 34px;
  background: var(--panel-2); border-top: 2px solid var(--red); box-shadow: 0 30px 80px rgba(0,0,0,0.6); }
.gmx .confirm h2 { margin: 12px 0 10px; font-family: var(--font-cond); font-size: 40px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
.gmx .confirm p { margin: 0 0 24px; font-size: 16px; line-height: 1.5; color: var(--fg-2); }
.gmx .confirm .btnlist { width: 100%; }
.gmx .confirm .kicker { color: var(--red); }

/* ------------------------------------------------------------------ in-game: intro stamp + objective */
.gmx .stamp { position: absolute; left: 5.4vw; bottom: 17vh; font-family: var(--font-mono); font-size: 17px; line-height: 1.62;
  letter-spacing: 0.06em; color: var(--fg); text-shadow: var(--shadow); white-space: nowrap; }
.gmx .stamp::before { content: ""; position: absolute; left: -60px; right: -120px; top: -40px; bottom: -40px; z-index: -1;
  background: radial-gradient(ellipse 58% 58% at 32% 52%, rgba(4,6,5,0.4), rgba(4,6,5,0.14) 50%, rgba(4,6,5,0) 70%); }
.gmx .stamp .t { font-family: var(--font-cond); font-size: 34px; font-weight: 700; letter-spacing: 0.22em; margin-bottom: 6px; text-transform: uppercase; }
.gmx .stamp .l { min-height: 1.62em; }
.gmx .stamp .l.dim { color: var(--fg-2); }
.gmx .stamp .cur { display: inline-block; width: 0.6em; height: 1.05em; margin-left: 2px; vertical-align: -0.16em; background: var(--accent); }
.gmx .objcard { position: absolute; left: 50%; top: 15.5vh; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center;
  text-align: center; text-shadow: var(--shadow); }
.gmx .objcard .kicker { justify-content: center; }
.gmx .objcard::before, .gmx .banner::before, .gmx .countdown::before, .gmx .cleared::before, .gmx .death .c::before {
  content: ""; position: absolute; left: -40%; right: -40%; top: -45%; bottom: -45%; z-index: -1; pointer-events: none;
  background: radial-gradient(ellipse 50% 50% at 50% 50%, rgba(0,0,0,0.2), rgba(0,0,0,0.08) 50%, rgba(0,0,0,0) 72%); }
.gmx .cleared .countdown::before { display: none; }
.gmx .objcard .main { display: flex; align-items: center; gap: 16px; margin-top: 10px; font-family: var(--font-cond); font-size: 44px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
.gmx .objcard .main svg { width: 34px; height: 34px; filter: drop-shadow(0 1px 3px rgba(0,0,0,0.8)); }
.gmx .objcard .sub { margin-top: 6px; font-size: 16px; font-weight: 600; letter-spacing: 0.16em; color: var(--fg); text-transform: uppercase; }
.gmx .objcard::before { background: radial-gradient(ellipse 50% 50% at 50% 50%, rgba(0,0,0,0.38), rgba(0,0,0,0.14) 55%, rgba(0,0,0,0) 74%); }
.gmx .objcard .kicker, .gmx .cleared .kicker, .gmx .countdown .kicker { text-shadow: 0 1px 2px #000, 0 0 12px rgba(0,0,0,0.85); color: #ffc24f; }
.gmx .objcard .bar { width: 520px; height: 1px; margin-top: 14px; background: linear-gradient(90deg, rgba(242,178,58,0), rgba(242,178,58,0.9), rgba(242,178,58,0)); }

/* ------------------------------------------------------------------ in-game: banners */
.gmx .banner { position: absolute; left: 50%; top: 17vh; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center;
  text-align: center; text-shadow: var(--shadow); white-space: nowrap; }
.gmx .banner .wv { font-family: var(--font-cond); font-size: 104px; font-weight: 700; line-height: 0.95; letter-spacing: 0.02em; margin-top: 4px; }
.gmx .banner .title { margin-top: 8px; font-family: var(--font-cond); font-size: 30px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; }
.gmx .banner .sub { margin-top: 8px; font-size: 16px; letter-spacing: 0.18em; color: var(--fg-2); text-transform: uppercase; }
.gmx .banner .rule { width: 460px; height: 1px; margin-top: 16px; background: linear-gradient(90deg, rgba(236,238,232,0), rgba(236,238,232,0.7), rgba(236,238,232,0)); }
.gmx .banner.final .kicker, .gmx .banner.final .wv { color: var(--red); }
.gmx .banner .flank { display: inline-flex; align-items: center; gap: 10px; margin-top: 12px; padding: 6px 14px 6px 12px; background: var(--red-dim);
  border-left: 3px solid var(--red); font-size: 14px; font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase; }
.gmx .countdown { position: absolute; left: 50%; top: 15.5vh; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center;
  text-shadow: var(--shadow); white-space: nowrap; }
.gmx .countdown .n { margin-top: 6px; font-family: var(--font-cond); font-size: 64px; font-weight: 700; line-height: 1; letter-spacing: 0.04em; }
.gmx .countdown .sub { margin-top: 6px; font-size: 14px; letter-spacing: 0.22em; color: var(--fg-2); text-transform: uppercase; }
.gmx .countdown .skip { display: flex; align-items: center; margin-top: 12px; font-size: 13px; letter-spacing: 0.2em; color: var(--fg-3); text-transform: uppercase; }
.gmx .countdown .skip .ring { width: 26px; height: 26px; margin-right: 8px; }

.gmx .cleared { position: absolute; left: 50%; top: 9vh; transform: translateX(-50%); width: 560px; display: flex; flex-direction: column; align-items: center;
  text-shadow: 0 1px 2px rgba(0,0,0,0.9), 0 0 24px rgba(0,0,0,0.55); }
.gmx .cleared::before { top: -12%; bottom: 35%; left: -20%; right: -20%;
  background: radial-gradient(ellipse 50% 50% at 50% 50%, rgba(0,0,0,0.42), rgba(0,0,0,0.16) 55%, rgba(0,0,0,0) 75%); }
.gmx .cleared .head { display: flex; align-items: baseline; gap: 16px; margin-top: 8px; font-family: var(--font-cond); font-size: 38px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; line-height: 1; color: var(--fg); }
.gmx .cleared .head b { font-size: 72px; font-weight: 700; letter-spacing: 0.02em; color: #fff; }
.gmx .cleared .card { position: relative; width: 520px; margin-top: 16px; text-shadow: none;
  background: linear-gradient(180deg, rgba(9,11,10,0.78), rgba(9,11,10,0.66)); border-top: 2px solid var(--accent);
  backdrop-filter: blur(10px) saturate(0.8); box-shadow: 0 18px 50px rgba(0,0,0,0.35); }
.gmx .cleared .strip { display: grid; grid-template-columns: repeat(4, 1fr); border-bottom: 1px solid var(--line); }
.gmx .cleared .strip div { display: flex; flex-direction: column; align-items: center; padding: 12px 4px 10px; }
.gmx .cleared .strip div + div { border-left: 1px solid rgba(236,238,232,0.08); }
.gmx .cleared .strip b { font-family: var(--font-cond); font-size: 28px; font-weight: 700; line-height: 1.05; color: #fff; }
.gmx .cleared .strip span { margin-top: 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.26em; color: var(--fg-3); text-transform: uppercase; }
.gmx .cleared .lines { padding: 6px 22px 2px; }
.gmx .cleared .ln { display: flex; justify-content: space-between; align-items: baseline; padding: 6px 0; font-size: 15px; font-weight: 600;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--fg-2); opacity: 0; }
.gmx .cleared .ln + .ln { border-top: 1px solid rgba(236,238,232,0.06); }
.gmx .cleared .ln b { font-family: var(--font-cond); font-size: 24px; font-weight: 700; color: var(--fg); letter-spacing: 0.04em; }
.gmx .cleared .ln.acc span { color: var(--accent-2); }
.gmx .cleared .ln.acc b { color: var(--accent); }
.gmx .cleared .total { display: flex; justify-content: space-between; align-items: center; margin: 2px 22px 0; padding: 8px 0 10px;
  border-top: 1px solid rgba(242,178,58,0.35); font-size: 13px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--accent); opacity: 0; }
.gmx .cleared .total b { font-family: var(--font-cond); font-size: 36px; font-weight: 700; letter-spacing: 0.02em; color: var(--accent); }
.gmx .cleared .total.done b { color: #ffd27c; }
.gmx .cleared .resup { display: flex; align-items: center; gap: 10px; margin: 0 22px 12px; padding: 7px 14px 7px 10px;
  background: rgba(40,80,48,0.32); border-left: 3px solid #9fe0a8; font-size: 12px; font-weight: 600; letter-spacing: 0.22em;
  text-transform: uppercase; color: #cfeed3; opacity: 0; }
.gmx .cleared .resup svg { width: 18px; height: 18px; flex: none; }
.gmx .cleared .resup i { width: 1px; height: 13px; background: rgba(207,238,211,0.35); }
.gmx .cleared .resup span:last-child { color: rgba(207,238,211,0.66); }
.gmx .cleared .next { display: flex; align-items: center; gap: 14px; padding: 9px 22px 10px; background: rgba(236,238,232,0.05);
  border-top: 1px solid rgba(236,238,232,0.07); font-size: 13px; font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase; color: var(--fg-2); opacity: 0; }
.gmx .cleared .next .lbl { color: var(--fg-3); }
.gmx .cleared .next .what { flex: 1; }
.gmx .cleared .next b { font-family: var(--font-cond); font-size: 24px; font-weight: 700; letter-spacing: 0.04em; color: #fff; }

/* ------------------------------------------------------------------ in-game: wave tracker */
.gmx .tracker { position: absolute; left: 40px; bottom: 208px; width: 250px; text-shadow: var(--shadow); }
.gmx .tracker .top { display: flex; align-items: baseline; gap: 10px; }
.gmx .tracker .lbl { font-size: 12px; font-weight: 600; letter-spacing: 0.32em; color: var(--fg-3); text-transform: uppercase; }
.gmx .tracker .w { font-family: var(--font-cond); font-size: 46px; font-weight: 700; line-height: 1; }
.gmx .tracker .of { font-size: 16px; color: var(--fg-3); letter-spacing: 0.1em; }
.gmx .tracker .pips { display: flex; gap: 3px; margin: 8px 0 7px; }
.gmx .tracker .pips i { flex: 1; height: 4px; background: rgba(236,238,232,0.2); }
.gmx .tracker .pips i.on { background: var(--red); box-shadow: 0 0 6px rgba(229,72,59,0.55); }
.gmx .tracker .pips i.done { background: rgba(236,238,232,0.08); }
.gmx .tracker .row2 { display: flex; justify-content: space-between; font-size: 13px; font-weight: 600; letter-spacing: 0.2em; text-transform: uppercase; color: var(--fg-2); }
.gmx .tracker .row2 b { color: var(--fg); font-weight: 700; }
.gmx .tracker .row2 .hot { color: var(--accent); }
.gmx .tracker .row3 { display: flex; justify-content: space-between; margin-top: 5px; font-size: 13px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--fg-3); }
.gmx .tracker .row3 b { color: var(--fg); font-weight: 600; }
.gmx .tracker .lives { display: flex; gap: 5px; align-items: center; }
.gmx .tracker .lives i { width: 8px; height: 12px; border: 1px solid rgba(236,238,232,0.55); transform: skewX(-12deg); }
.gmx .tracker .lives i.on { background: var(--fg); border-color: var(--fg); }

/* ------------------------------------------------------------------ fallback toasts (only when hud.notify is missing) */
.gmx .toasts { position: absolute; left: 50%; top: 58%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 4px; text-shadow: var(--shadow); }
.gmx .toast { font-family: var(--font-cond); font-size: 22px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
.gmx .toast.xp { color: var(--accent-2); font-size: 20px; }
.gmx .toast.medal { color: #fff; font-size: 26px; }

/* ------------------------------------------------------------------ death */
.gmx .death { backdrop-filter: grayscale(0.85) contrast(1.08) brightness(0.62) blur(1.5px); }
.gmx .death::before { content: ""; position: absolute; inset: 0;
  background: radial-gradient(ellipse 75% 70% at 50% 50%, rgba(80,0,0,0.0) 30%, rgba(90,6,4,0.55) 100%), linear-gradient(0deg, rgba(0,0,0,0.6), rgba(0,0,0,0) 45%); }
.gmx .death .c { position: absolute; left: 50%; top: 30vh; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; text-shadow: var(--shadow); white-space: nowrap; }
.gmx .death .kicker { color: var(--red); }
.gmx .death .head { margin-top: 12px; font-family: var(--font-cond); font-size: 84px; font-weight: 700; letter-spacing: 0.06em; line-height: 1; text-transform: uppercase; }
.gmx .death .by { margin-top: 12px; font-size: 18px; letter-spacing: 0.18em; color: var(--fg-2); text-transform: uppercase; }
.gmx .death .by b { color: var(--red); font-weight: 600; }
.gmx .death .stats { display: flex; margin-top: 30px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.gmx .death .stats div { display: flex; flex-direction: column; align-items: center; min-width: 150px; padding: 14px 20px; }
.gmx .death .stats div + div { border-left: 1px solid var(--line); }
.gmx .death .stats b { font-family: var(--font-cond); font-size: 36px; font-weight: 700; line-height: 1.1; }
.gmx .death .stats span { font-size: 12px; font-weight: 600; letter-spacing: 0.3em; color: var(--fg-3); text-transform: uppercase; margin-top: 4px; }
.gmx .death .reinf { margin-top: 28px; font-size: 15px; font-weight: 600; letter-spacing: 0.26em; text-transform: uppercase; }
.gmx .death .reinf.none { color: var(--red); }
.gmx .death .redeploy { display: flex; align-items: center; gap: 14px; margin-top: 18px; font-size: 14px; letter-spacing: 0.22em; color: var(--fg-2); text-transform: uppercase; }
.gmx .death .prog { width: 320px; height: 3px; margin-top: 12px; background: rgba(236,238,232,0.15); }
.gmx .death .prog i { display: block; height: 100%; width: 0; background: var(--fg); }

/* ------------------------------------------------------------------ summary */
.gmx .summary { background: rgba(4,6,5,0.18); backdrop-filter: blur(3px) saturate(0.62) brightness(0.8); }
.gmx .summary::before { content: ""; position: absolute; inset: 0;
  background: linear-gradient(90deg, rgba(4,6,5,0.9) 0%, rgba(4,6,5,0.72) 38%, rgba(4,6,5,0.3) 72%, rgba(4,6,5,0.12) 100%),
    linear-gradient(0deg, rgba(4,6,5,0.8), rgba(4,6,5,0) 34%), linear-gradient(180deg, rgba(4,6,5,0.5), rgba(4,6,5,0) 22%); }
.gmx .sum-main { position: absolute; left: 6.2vw; top: 12vh; right: 6.2vw; }
.gmx .sum-main .kicker.red { color: var(--red); }
.gmx .sum-head { margin: 14px 0 6px; font-family: var(--font-cond); font-size: 104px; font-weight: 700; line-height: 0.92; letter-spacing: 0.02em; text-transform: uppercase; }
.gmx .sum-head.red { color: #fff; }
.gmx .sum-sub { font-size: 16px; letter-spacing: 0.24em; color: var(--fg-2); text-transform: uppercase; }
.gmx .sum-sub em { font-style: normal; color: var(--accent); }
.gmx .sum-grid { display: grid; grid-template-columns: 420px 1fr; gap: 56px; margin-top: 44px; }
.gmx .scorebox { align-self: start; padding: 22px 26px 24px; background: var(--panel); border-top: 2px solid var(--accent); }
.gmx .scorebox .s { margin-top: 12px; font-family: var(--font-cond); font-size: 88px; font-weight: 700; line-height: 1; letter-spacing: 0.01em; }
.gmx .scorebox .pb { display: inline-flex; align-items: center; gap: 8px; margin-top: 12px; padding: 6px 12px; background: var(--accent); color: #141414;
  font-size: 13px; font-weight: 700; letter-spacing: 0.26em; text-transform: uppercase; }
.gmx .scorebox .best { margin-top: 12px; font-size: 14px; letter-spacing: 0.2em; color: var(--fg-3); text-transform: uppercase; }
.gmx .scorebox .best b { color: var(--fg); font-weight: 600; }
.gmx .scorebox .rank { display: flex; justify-content: space-between; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line);
  font-size: 13px; font-weight: 600; letter-spacing: 0.26em; color: var(--fg-3); text-transform: uppercase; }
.gmx .scorebox .rank b { color: var(--accent); }
.gmx .statgrid { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--line); }
.gmx .statgrid div { padding: 18px 20px 16px 0; border-bottom: 1px solid var(--line); }
.gmx .statgrid b { display: block; font-family: var(--font-cond); font-size: 46px; font-weight: 700; line-height: 1.05; }
.gmx .statgrid span { font-size: 12px; font-weight: 600; letter-spacing: 0.3em; color: var(--fg-3); text-transform: uppercase; }
.gmx .medals { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 22px; min-height: 44px; }
.gmx .medal { display: inline-flex; align-items: center; gap: 10px; height: 40px; padding: 0 14px 0 8px; background: rgba(16,19,18,0.62); border-bottom: 1px solid rgba(242,178,58,0.22);
  font-size: 13px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; color: var(--fg-2); }
.gmx .medal svg { width: 26px; height: 26px; }
.gmx .medal b { color: var(--accent); font-weight: 700; }
.gmx .medals .none { font-size: 14px; letter-spacing: 0.18em; color: var(--fg-4); text-transform: uppercase; align-self: center; }
.gmx .sum-actions { position: absolute; left: 6.2vw; bottom: 12vh; display: flex; gap: 12px; }
.gmx .sum-actions .btn { width: 320px; background: rgba(236,238,232,0.06); }
.gmx .sum-actions .btn.sel { background: linear-gradient(90deg, rgba(242,178,58,0.32), rgba(242,178,58,0.08)); }

/* wave performance chart */
.gmx .wchart { margin-top: 30px; }
.gmx .wchart .hd { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; }
.gmx .wchart .hd span { font-size: 12px; font-weight: 600; letter-spacing: 0.3em; color: var(--fg-3); text-transform: uppercase; }
.gmx .wchart .bars { display: flex; align-items: flex-end; gap: 6px; height: 120px; padding-bottom: 1px; border-bottom: 1px solid var(--line); }
.gmx .wchart .col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; max-width: 124px; }
.gmx .wchart .col b { font-size: 13px; font-weight: 600; letter-spacing: 0.06em; color: var(--fg-2); margin-bottom: 5px; font-variant-numeric: tabular-nums; }
.gmx .wchart .col i { display: block; width: 100%; background: linear-gradient(180deg, rgba(236,238,232,0.55), rgba(236,238,232,0.22)); transform-origin: bottom; }
.gmx .wchart .col.flaw i { background: linear-gradient(180deg, rgba(242,178,58,0.95), rgba(242,178,58,0.35)); }
.gmx .wchart .col.fail i { background: linear-gradient(180deg, rgba(229,72,59,0.9), rgba(229,72,59,0.3)); }
.gmx .wchart .col.ghost b { color: var(--fg-3); opacity: 0.5; }
.gmx .wchart .col.ghost u { display: block; width: 100%; height: 92px; box-sizing: border-box; border: 1px dashed rgba(236,238,232,0.16); border-bottom: 0;
  background: repeating-linear-gradient(135deg, rgba(236,238,232,0.035) 0 6px, rgba(236,238,232,0) 6px 12px); }
.gmx .wchart .lbl span.ghost { opacity: 0.45; }
.gmx .wchart .lbl { display: flex; gap: 6px; margin-top: 7px; }
.gmx .wchart .lbl span { flex: 1; max-width: 124px; text-align: center; font-size: 12px; font-weight: 600; letter-spacing: 0.1em; color: var(--fg-3); font-variant-numeric: tabular-nums; }
.gmx .wchart .legend { display: flex; gap: 18px; font-size: 11px; font-weight: 600; letter-spacing: 0.22em; color: var(--fg-3); text-transform: uppercase; }
.gmx .wchart .legend i { display: inline-block; width: 10px; height: 10px; margin-right: 7px; vertical-align: -1px; }

/* ------------------------------------------------------------------ scoreboard (Tab) */
.gmx .board { position: absolute; left: 50%; top: 22vh; width: 640px; transform: translateX(-50%); padding: 24px 28px;
  background: rgba(10,12,11,0.8); border-top: 2px solid var(--accent); backdrop-filter: blur(6px); }
.gmx .board h2 { margin: 10px 0 14px; font-family: var(--font-cond); font-size: 36px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.gmx .board .statgrid b { font-size: 36px; }
`;

/**
 * Resolution independence: every px length is authored at 1920×1080 and rewritten to calc(var(--u) * N),
 * where --u (set by the view on resize) = min(width / 1920, height / 1080) px — the same convention as the hud.
 * Hairlines (≤ 1px) stay 1px so rules never vanish at small sizes.
 */
export const CSS = RAW.replace(/(-?\d*\.?\d+)px/g, (m, n) => (Math.abs(Number(n)) <= 1 ? m : `calc(var(--u, 1px) * ${n})`));

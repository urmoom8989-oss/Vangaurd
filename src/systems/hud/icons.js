/**
 * hud/icons.js — original inline SVG icons (fill = currentColor unless noted). All authored by hand.
 */

const svg = (vb, body, cls = '') =>
  `<svg class="od-ico ${cls}" viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;

/** Side silhouette of the AR-class rifle (faces right). */
export const RIFLE = svg(
  '0 0 100 30',
  `<path fill="currentColor" d="
    M3 10.2 L15 8.6 L19.5 8.6 L19.5 16.2 L15.5 16.6 L6.5 20.5 L3.6 20.2 Z
    M19.5 9.6 H23 V8.4 H52.5 V9.6 H23 V15.2 H19.5 Z
    M23 8.4 H56 V15.2 H23 Z
    M33 3.2 H46.5 V4.4 H45 V8.4 H34.5 V4.4 H33 Z
    M36.2 4.8 H43.4 V7.4 H36.2 Z
    M56 8.2 H81 V9 H56 Z M56 9 H81 V15 H56 Z
    M81 10.4 H90 V12.6 H81 Z
    M89.2 9.4 H96.2 V13.6 H89.2 Z
    M25 15.2 H54 L53 17.4 H26 Z
    M29.2 17 H34.6 L33.4 25.8 L28.3 25.4 Z
    M44.2 15.2 H50.8 L50.2 18 L48.4 26.4 L42.6 25.3 L44.6 18 Z
    M35 17.4 H42.4 L41.8 19.6 H36 Z
    M65 15 H69.4 L69.2 22.8 H65.3 Z
  "/>
  <path fill="rgba(0,0,0,.35)" d="M58 10.5 H79 V11.2 H58 Z M58 12.6 H79 V13.3 H58 Z M24 10.6 H52 V11.1 H24 Z"/>`,
  'od-ico-rifle',
);

/** Compact pistol silhouette. */
export const PISTOL = svg(
  '0 0 56 30',
  `<path fill="currentColor" d="
    M6 6.5 H48.5 L50 8 V13.5 H6 Z
    M47 7.4 H52.5 V11 H47 Z
    M6 13.5 H40 V16.6 H23.5 C22 16.6 21.2 17.8 20.7 19.4 L18.6 27.4 H9.8 L12.4 16.6 H6 Z
    M22 16.6 H30.5 C30.5 20.4 28 21.8 24.6 21.8 H21.2 L22.2 19.9 H24.4 C26.2 19.9 27.4 19 27.6 17.8 H22 Z
  "/>
  <path fill="rgba(0,0,0,.35)" d="M9 8.6 H13.5 V11.6 H9 Z M14.5 8.6 H15.5 V11.6 H14.5 Z M16.5 8.6 H17.5 V11.6 H16.5 Z"/>`,
  'od-ico-pistol',
);

/** Frag grenade (lethal). */
export const FRAG = svg(
  '0 0 28 32',
  `<path fill="currentColor" d="
    M11 5.5 H17 V8.5 H11 Z
    M9.2 3 H17.6 C19.2 3 20.4 3.8 21.2 5 L24.2 10.5 L22.6 11.3 L19.8 6.6 C19.4 6 18.8 5.6 18 5.6 H9.2 Z
    M14 8.4 C19.6 8.4 23 12.6 23 18.6 C23 24.6 19.2 29 14 29 C8.8 29 5 24.6 5 18.6 C5 12.6 8.4 8.4 14 8.4 Z
  "/>
  <path fill="rgba(0,0,0,.42)" d="M5.4 16.6 H22.6 V17.8 H5.4 Z M5.8 21.6 H22.2 V22.8 H5.8 Z M13.3 9 H14.7 V28.6 H13.3 Z M8.6 10.6 H9.8 V27.2 H8.6 Z M18.2 10.6 H19.4 V27.2 H18.2 Z"/>
  <circle cx="7.6" cy="4.2" r="2.6" fill="none" stroke="currentColor" stroke-width="1.5"/>`,
  'od-ico-frag',
);

/** Stun / flash canister (tactical). */
export const STUN = svg(
  '0 0 28 32',
  `<path fill="currentColor" d="
    M10.5 2.6 H17.5 V6 H10.5 Z
    M17 3.4 H20 L23 9 L21.6 9.8 L19 5 H17 Z
    M8 6.4 H20 C21.2 6.4 22 7.2 22 8.4 V27.4 C22 28.6 21.2 29.4 20 29.4 H8 C6.8 29.4 6 28.6 6 27.4 V8.4 C6 7.2 6.8 6.4 8 6.4 Z
  "/>
  <path fill="rgba(0,0,0,.45)" d="M6 11 H22 V13.4 H6 Z M6 23.4 H22 V25.8 H6 Z M8.4 15.6 H10 V21.4 H8.4 Z M12.4 15.6 H14 V21.4 H12.4 Z M16.4 15.6 H18 V21.4 H16.4 Z"/>`,
  'od-ico-stun',
);

export const KNIFE = svg(
  '0 0 64 22',
  `<path fill="currentColor" d="M3 9 H22 V14 H3 C1.8 14 1 13.2 1 12 V11 C1 9.8 1.8 9 3 9 Z M22 6.5 H25 V16.5 H22 Z M25 8.6 H52 C56 8.6 60 10 63 12.2 C58 14 53 14.4 48 14.4 H25 Z"/>
   <path fill="rgba(0,0,0,.35)" d="M5 10.6 H20 V12.4 H5 Z"/>`,
  'od-ico-knife',
);

export const EXPLOSION = svg(
  '0 0 32 32',
  `<path fill="currentColor" d="M16 1.5 L19 10 L27.5 5.5 L23 13.4 L31 16 L23 18.6 L27.5 26.5 L19 22 L16 30.5 L13 22 L4.5 26.5 L9 18.6 L1 16 L9 13.4 L4.5 5.5 L13 10 Z"/>
   <circle cx="16" cy="16" r="4.2" fill="rgba(0,0,0,.45)"/>`,
  'od-ico-explosion',
);

/** Headshot: head-and-shoulders bust with a reticle on the head (reads at 18-20 px). */
export const HEADSHOT = svg(
  '0 0 28 28',
  `<circle cx="14" cy="9.6" r="6.6" fill="currentColor"/>
   <path fill="currentColor" d="M3.2 27.2 C3.2 20.6 7.6 17.6 14 17.6 C20.4 17.6 24.8 20.6 24.8 27.2 Z"/>
   <circle cx="14" cy="9.6" r="3.3" fill="none" stroke="rgba(12,12,12,.9)" stroke-width="1.6"/>
   <circle cx="14" cy="9.6" r="1" fill="rgba(12,12,12,.9)"/>
   <path stroke="currentColor" stroke-width="1.6" d="M14 0.2 V2.2 M4.6 9.6 H2.6 M23.4 9.6 H25.4"/>`,
  'od-ico-hs',
);

export const SKULL = svg(
  '0 0 28 28',
  `<path fill="currentColor" fill-rule="evenodd" d="M14 3 C20 3 24 7 24 12.6 C24 15.6 22.8 17.6 21 19 V23 C21 24 20.2 25 19 25 H9 C7.8 25 7 24 7 23 V19 C5.2 17.6 4 15.6 4 12.6 C4 7 8 3 14 3 Z
     M9.8 11 C8.4 11 7.6 12.2 7.6 13.4 C7.6 14.8 8.6 15.8 10 15.8 C11.4 15.8 12.2 14.6 12.2 13.4 C12.2 12 11.2 11 9.8 11 Z
     M18.2 11 C16.8 11 15.8 12 15.8 13.4 C15.8 14.6 16.6 15.8 18 15.8 C19.4 15.8 20.4 14.8 20.4 13.4 C20.4 12.2 19.6 11 18.2 11 Z
     M14 16.4 L12.6 19.2 H15.4 Z M10.6 21 V23.4 H11.8 V21 Z M13.4 21 V23.4 H14.6 V21 Z M16.2 21 V23.4 H17.4 V21 Z"/>`,
  'od-ico-skull',
);

const bullet = (x) => `<path fill="currentColor" d="M${x} 11 C${x} 6.4 ${x + 1.6} 3.4 ${x + 3} 2.2 C${x + 4.4} 3.4 ${x + 6} 6.4 ${x + 6} 11 V25 H${x} Z"/><path fill="currentColor" d="M${x - 0.4} 26.2 H${x + 6.4} V29 H${x - 0.4} Z"/>`;
export const FIREMODE_AUTO = svg('0 0 30 30', bullet(1.5) + bullet(12) + bullet(22.5), 'od-ico-fm');
export const FIREMODE_BURST = svg('0 0 30 30', bullet(1.5) + bullet(12) + bullet(22.5) + '<path fill="currentColor" d="M1 13 H29 V15 H1 Z" opacity=".0"/>', 'od-ico-fm');
export const FIREMODE_SEMI = svg('0 0 30 30', bullet(12), 'od-ico-fm');

export const DIAMOND = svg('0 0 20 20', '<path fill="currentColor" d="M10 1 L19 10 L10 19 L1 10 Z"/><path fill="rgba(0,0,0,.45)" d="M10 5.5 L14.5 10 L10 14.5 L5.5 10 Z"/>', 'od-ico-diamond');

export const CHEVRON_RIGHT = svg('0 0 12 20', '<path fill="none" stroke="currentColor" stroke-width="2.4" d="M2.5 2.5 L9.5 10 L2.5 17.5"/>');
export const CHEVRON_LEFT = svg('0 0 12 20', '<path fill="none" stroke="currentColor" stroke-width="2.4" d="M9.5 2.5 L2.5 10 L9.5 17.5"/>');

/** Original emblem mark: a stylised shield with an inset chevron and vigil "eye" bar. */
export const EMBLEM = svg(
  '0 0 120 120',
  `<defs><linearGradient id="odEmG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3efe4"/><stop offset="1" stop-color="#b9b1a0"/></linearGradient></defs>
   <path fill="none" stroke="url(#odEmG)" stroke-width="5" d="M60 6 L108 22 V58 C108 86 88 104 60 114 C32 104 12 86 12 58 V22 Z"/>
   <path fill="url(#odEmG)" d="M60 30 L90 48 V60 L60 42 L30 60 V48 Z"/>
   <path fill="url(#odEmG)" d="M60 56 L90 74 V86 L60 68 L30 86 V74 Z" opacity=".75"/>
   <path fill="#e2a33b" d="M44 20 H76 V25 H44 Z"/>`,
  'od-emblem',
);

/**
 * Medal emblems. kind: 'multi' | 'streak' | 'headshot' | 'longshot' | 'first' | 'melee' | 'wave' | 'default'
 * tier: 1..4 (color ramp: steel, bronze, silver, gold)
 */
const TIER = [
  ['#cfd6db', '#6b7780'],
  ['#e8b06a', '#8a5a23'],
  ['#eef2f4', '#8e9aa3'],
  ['#ffe08a', '#b07a12'],
  ['#ff8f6e', '#9c2a17'],
];
let medalSeq = 0;
export function medalSvg(kind = 'default', tier = 1, count = 0) {
  const [hi, lo] = TIER[Math.max(0, Math.min(TIER.length - 1, tier))];
  const id = 'odM' + (medalSeq++ % 64);
  const grad = `<defs>
    <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hi}"/><stop offset="1" stop-color="${lo}"/></linearGradient>
    <radialGradient id="${id}r" cx=".5" cy=".38" r=".62"><stop offset="0" stop-color="#2b3238"/><stop offset="1" stop-color="#0e1114"/></radialGradient>
  </defs>`;
  let frame;
  let inner;
  switch (kind) {
    case 'multi': {
      frame = `<path d="M50 4 L90 27 V73 L50 96 L10 73 V27 Z" fill="url(#${id}r)" stroke="url(#${id}g)" stroke-width="5"/>
               <path d="M50 13 L82 31.5 V68.5 L50 87 L18 68.5 V31.5 Z" fill="none" stroke="url(#${id}g)" stroke-width="1.4" opacity=".6"/>`;
      const n = Math.max(2, Math.min(4, count || 2));
      inner = '';
      const h = 11, gap = 5;
      const total = n * h + (n - 1) * gap;
      for (let i = 0; i < n; i++) {
        const y = 50 - total / 2 + i * (h + gap);
        inner += `<path d="M28 ${y + h} L50 ${y} L72 ${y + h} L72 ${y + h + 5} L50 ${y + 5} L28 ${y + h + 5} Z" fill="url(#${id}g)"/>`;
      }
      break;
    }
    case 'streak':
      frame = `<path d="M50 4 L88 16 V50 C88 74 72 88 50 96 C28 88 12 74 12 50 V16 Z" fill="url(#${id}r)" stroke="url(#${id}g)" stroke-width="5"/>`;
      inner = `<path d="M50 24 L56.5 41 L74 41.5 L60 52 L65 69.5 L50 59 L35 69.5 L40 52 L26 41.5 L43.5 41 Z" fill="url(#${id}g)"/>
               <path d="M30 78 H70" stroke="url(#${id}g)" stroke-width="3"/>`;
      break;
    case 'headshot':
      frame = `<circle cx="50" cy="50" r="44" fill="url(#${id}r)" stroke="url(#${id}g)" stroke-width="5"/>`;
      inner = `<circle cx="50" cy="50" r="22" fill="none" stroke="url(#${id}g)" stroke-width="4"/>
               <path d="M50 16 V36 M50 64 V84 M16 50 H36 M64 50 H84" stroke="url(#${id}g)" stroke-width="4"/>
               <circle cx="50" cy="50" r="5" fill="#ff5a44"/>`;
      break;
    case 'longshot':
      frame = `<path d="M50 3 L97 50 L50 97 L3 50 Z" fill="url(#${id}r)" stroke="url(#${id}g)" stroke-width="5"/>`;
      inner = `<path d="M24 62 L64 36" stroke="url(#${id}g)" stroke-width="5"/><path d="M58 28 L78 30 L70 48 Z" fill="url(#${id}g)"/>
               <circle cx="26" cy="61" r="4" fill="url(#${id}g)"/>`;
      break;
    case 'first':
      frame = `<path d="M50 4 L90 27 V73 L50 96 L10 73 V27 Z" fill="url(#${id}r)" stroke="url(#${id}g)" stroke-width="5"/>`;
      inner = `<path d="M50 22 C60 36 68 46 68 58 C68 69 60 77 50 77 C40 77 32 69 32 58 C32 46 40 36 50 22 Z" fill="#c8322a" stroke="url(#${id}g)" stroke-width="3"/>`;
      break;
    case 'melee':
      frame = `<path d="M50 4 L88 16 V50 C88 74 72 88 50 96 C28 88 12 74 12 50 V16 Z" fill="url(#${id}r)" stroke="url(#${id}g)" stroke-width="5"/>`;
      inner = `<path d="M30 72 L66 30 L74 26 L70 34 L34 76 Z" fill="url(#${id}g)"/><path d="M28 64 L40 76" stroke="url(#${id}g)" stroke-width="5"/>`;
      break;
    case 'wave':
      frame = `<rect x="8" y="8" width="84" height="84" rx="6" transform="rotate(45 50 50)" fill="url(#${id}r)" stroke="url(#${id}g)" stroke-width="5"/>`;
      inner = `<path d="M30 58 L50 38 L70 58" fill="none" stroke="url(#${id}g)" stroke-width="7"/><path d="M34 70 H66" stroke="url(#${id}g)" stroke-width="4"/>`;
      break;
    default:
      frame = `<circle cx="50" cy="50" r="44" fill="url(#${id}r)" stroke="url(#${id}g)" stroke-width="5"/>`;
      inner = `<path d="M50 24 L60 44 L50 76 L40 44 Z" fill="url(#${id}g)"/>`;
  }
  return svg('0 0 100 100', grad + frame + inner, 'od-medal-svg');
}

export function weaponIcon(weaponId = '', kind = '') {
  const w = String(weaponId || '').toLowerCase();
  const k = String(kind || '').toLowerCase();
  if (k === 'explosion' || /frag|grenade|explo|rocket/.test(w)) return FRAG;
  if (k === 'melee' || /knife|melee/.test(w)) return KNIFE;
  if (/pistol|p9|kestrel|sidearm|handgun/.test(w)) return PISTOL;
  if (k === 'fall' || k === 'fire') return SKULL;
  return RIFLE;
}

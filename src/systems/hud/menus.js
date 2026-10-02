import * as THREE from 'three';
import { el, setOpacity, setStyle, setText, setHTML, setClass, clamp, clamp01, easeOutCubic, escapeHtml, keyLabel, formatInt, lerp } from './util.js';
import { EMBLEM, CHEVRON_LEFT, CHEVRON_RIGHT, weaponIcon } from './icons.js';
import { getProgression, getWeaponProgression, getGrenadeTypes, getSelectedGrenade, setSelectedGrenade, recordProgressionKill, recordProgressionDeath, getAttachmentSlots, getWeaponLoadout, setWeaponAttachment } from '../gamemode/progression.js';
import { getPlayerName, setPlayerName } from './account.js';

/**
 * Menus (in #ui): main menu with a live fly-through of the level, pause menu, settings (graphics /
 * mouse / audio / interface / keybinds), death + game-over screen, and the "click to resume" gate
 * required by pointer lock. Menu input is handled by DOM listeners on window (keyboard + mouse).
 */
const DEG = Math.PI / 180;
const KILLCAM_DURATION = 3.5;
const DEFAULT_MULTIPLAYER_URL = import.meta.env?.VITE_MULTIPLAYER_URL || '';

const QUALITY = ['low', 'medium', 'high', 'ultra'];
const DIFF = [
  ['easy', 'Conscript'],
  ['regular', 'Soldier'],
  ['hard', 'Specialist'],
  ['extreme', 'Iron Vigil'],
];

const ACTION_LABELS = [
  ['moveForward', 'Move forward'], ['moveBack', 'Move back'], ['moveLeft', 'Strafe left'], ['moveRight', 'Strafe right'],
  ['sprint', 'Sprint / tactical sprint'], ['jump', 'Jump / mantle'], ['crouch', 'Crouch / slide'], ['prone', 'Prone'],
  ['fire', 'Fire weapon'], ['ads', 'Aim down sight'], ['reload', 'Reload / interact'], ['melee', 'Melee'],
  ['grenade', 'Lethal equipment'], ['tactical', 'Tactical equipment'], ['interact', 'Use / pick up'],
  ['swapWeapon', 'Switch weapon'], ['weapon1', 'Primary weapon'], ['weapon2', 'Secondary weapon'],
  ['leanLeft', 'Lean left'], ['leanRight', 'Lean right'], ['inspect', 'Inspect weapon'], ['scoreboard', 'Scoreboard'], ['pause', 'Pause'],
];

function settingDefs(hud) {
  const S = (path) => hud.ctx.settings.get(path);
  return {
    graphics: [
      { sec: 'Display' },
      { path: 'graphics.quality', label: 'Quality preset', type: 'cycle', options: QUALITY.map((q) => [q, q.toUpperCase()]), desc: 'Overall graphics quality. Adjusts shadows, ambient occlusion, post-processing and effects density together.' },
      { path: 'graphics.showFps', label: 'FPS counter', type: 'toggle', desc: 'Shows the live rendered frame rate in the top-right corner.' },
      { path: 'graphics.fov', label: 'Field of view', type: 'slider', min: 60, max: 120, step: 1, fmt: (v) => v.toFixed(0), desc: 'Horizontal field of view at 16:9. Higher values show more of the battlefield at the cost of target size.' },
      { path: 'graphics.renderScale', label: 'Render resolution', type: 'slider', min: 0.35, max: 1, step: 0.05, fmt: (v) => Math.round(v * 100) + '%', desc: 'Internal render resolution as a percentage of the display. Lower values improve performance.' },
      { path: 'graphics.fpsCap', label: 'Frame rate limit', type: 'cycle', options: [[0, 'UNLIMITED'], [60, '60'], [120, '120'], [144, '144'], [240, '240']], desc: 'Caps frame production in software. Unlimited mode is not synchronized to monitor refresh.' },
      { sec: 'Post processing' },
      { path: 'graphics.shadows', label: 'Shadows', type: 'toggle', desc: 'Dynamic sun shadows. Disabling them makes enemies harder to spot in cover.' },
      { path: 'graphics.motionBlur', label: 'Motion blur', type: 'toggle', desc: 'Camera and object motion blur for a cinematic feel.' },
      { path: 'graphics.filmGrain', label: 'Film grain', type: 'toggle', desc: 'Subtle photographic grain applied to the final image.' },
      { path: 'postfx.chromaticAberration', label: 'Lens aberration', type: 'toggle', opt: true, desc: 'Subtle colour fringing towards the screen edges, like a real lens.' },
      { path: 'postfx.weaponDof', label: 'Weapon depth of field', type: 'toggle', opt: true, desc: 'Softens the weapon while aiming down sights so the target stays in focus.' },
      { sec: 'World & effects' },
      { path: 'lighting.volumetrics', label: 'Volumetric lighting', type: 'toggle', opt: true, desc: 'Light shafts through dust and smoke. Moderate performance cost.' },
      { path: 'vfx.decals', label: 'Impact decals', type: 'toggle', opt: true, desc: 'Bullet holes, scorch marks and blood left on surfaces.' },
      { path: 'vfx.shells', label: 'Ejected shell casings', type: 'toggle', opt: true, desc: 'Physically simulated brass ejected from weapons.' },
      { path: 'vfx.lights', label: 'Dynamic effect lights', type: 'toggle', opt: true, desc: 'Muzzle flashes and explosions light up their surroundings.' },
    ],
    mouse: [
      { sec: 'Mouse' },
      { path: 'controls.sensitivity', label: 'Mouse sensitivity', type: 'slider', min: 0.25, max: 12, step: 0.05, fmt: (v) => v.toFixed(2), desc: 'Hip-fire look speed. 0.022° per count × sensitivity, matching common shooter conventions.' },
      { path: 'controls.adsSensitivity', label: 'ADS sensitivity multiplier', type: 'slider', min: 0.3, max: 2, step: 0.05, fmt: (v) => v.toFixed(2), desc: 'Look speed multiplier while aiming down sights, applied on top of zoom scaling.' },
      { path: 'controls.invertY', label: 'Invert vertical look', type: 'toggle', desc: 'Inverts the vertical mouse axis.' },
      { sec: 'Behavior' },
      { path: 'controls.toggleAds', label: 'Aim down sight', type: 'cycle', options: [[false, 'HOLD'], [true, 'TOGGLE']], desc: 'Hold the aim button to aim, or press once to toggle.' },
      { path: 'controls.toggleCrouch', label: 'Crouch', type: 'cycle', options: [[true, 'TOGGLE'], [false, 'HOLD']], desc: 'Toggle crouch with a single press, or hold to stay crouched.' },
      { path: 'player.sprintMode', label: 'Sprint', type: 'cycle', opt: true, options: [['toggle', 'TOGGLE'], ['hold', 'HOLD']], desc: 'Tap to sprint until you stop moving, or hold the sprint key.' },
      { path: 'player.tacSprint', label: 'Tactical sprint', type: 'cycle', opt: true, options: [['doubleTap', 'DOUBLE TAP'], ['auto', 'AUTOMATIC'], ['off', 'OFF']], desc: 'How the faster, weapon-up tactical sprint is triggered.' },
      { path: 'player.leanMode', label: 'Lean', type: 'cycle', opt: true, options: [['hold', 'HOLD'], ['toggle', 'TOGGLE']], desc: 'Hold or toggle the lean keys to peek around cover.' },
      { sec: 'Camera' },
      { path: 'player.headBob', label: 'Camera bob', type: 'slider', opt: true, min: 0, max: 1.5, step: 0.05, fmt: (v) => Math.round(v * 100) + '%', desc: 'Amount of camera movement while walking and sprinting.' },
      { path: 'player.fovEffects', label: 'FOV effects', type: 'toggle', opt: true, desc: 'Field of view kick while sprinting and sliding.' },
      { path: 'player.damageFlinch', label: 'Damage flinch', type: 'slider', opt: true, min: 0, max: 1, step: 0.05, fmt: (v) => Math.round(v * 100) + '%', desc: 'How much the view jolts when you take damage.' },
    ],
    audio: [
      { sec: 'Volume' },
      { path: 'audio.master', label: 'Master volume', type: 'slider', min: 0, max: 1, step: 0.01, fmt: (v) => Math.round(v * 100), bus: 'master', desc: 'Overall output level.' },
      { path: 'audio.sfx', label: 'Effects volume', type: 'slider', min: 0, max: 1, step: 0.01, fmt: (v) => Math.round(v * 100), bus: 'sfx', desc: 'Weapons, impacts, footsteps and the world.' },
      { path: 'audio.music', label: 'Music volume', type: 'slider', min: 0, max: 1, step: 0.01, fmt: (v) => Math.round(v * 100), bus: 'music', desc: 'Menu and combat music.' },
      { path: 'audio.voice', label: 'Dialogue volume', type: 'slider', min: 0, max: 1, step: 0.01, fmt: (v) => Math.round(v * 100), bus: 'voice', desc: 'Radio chatter and enemy callouts.' },
      { path: 'audio.ui', label: 'Interface volume', type: 'slider', opt: true, min: 0, max: 1, step: 0.01, fmt: (v) => Math.round(v * 100), bus: 'ui', desc: 'Menu sounds, hitmarkers and notifications.' },
      { path: 'audio.ambience', label: 'Ambience volume', type: 'slider', opt: true, min: 0, max: 1, step: 0.01, fmt: (v) => Math.round(v * 100), desc: 'Wind, distant combat and the town around you.' },
      { sec: 'Mix' },
      { path: 'audio.hrtf', label: '3D headphone audio', type: 'toggle', opt: true, desc: 'Binaural positioning for headphones. Makes footsteps and gunfire easier to locate.' },
      { path: 'audio.hitmarkers', label: 'Hitmarker sounds', type: 'toggle', opt: true, desc: 'Audible confirmation when your shots connect.' },
    ],
    interface: [
      { sec: 'Gameplay' },
      { path: 'gameplay.difficulty', label: 'Difficulty', type: 'cycle', options: DIFF, desc: 'Enemy count, accuracy and damage. Takes effect on the next deployment.' },
      { sec: 'HUD' },
      { path: 'gameplay.crosshair', label: 'Crosshair', type: 'toggle', desc: 'Shows a fixed center-screen crosshair that never changes size with spread. It hides while aiming down sights.' },
      { path: 'gameplay.hitmarkers', label: 'Hitmarkers', type: 'toggle', desc: 'Shows hit confirmation on the crosshair. Kills flash red.' },
      { path: 'hud.scale', label: 'HUD scale', type: 'slider', min: 0.75, max: 1.25, step: 0.05, fmt: (v) => Math.round(v * 100) + '%', desc: 'Scales every HUD element.' },
      { path: 'hud.minimapRotate', label: 'Minimap', type: 'cycle', options: [[true, 'ROTATE'], [false, 'NORTH UP']], desc: 'Rotate the minimap with your view, or keep north fixed at the top.' },
      { path: 'hud.compass', label: 'Compass', type: 'toggle', desc: 'Shows the bearing compass at the top of the screen.' },
    ],
    keybinds: 'keybinds',
    _S: S,
  };
}

const TABS = [
  ['graphics', 'Graphics'],
  ['mouse', 'Mouse'],
  ['audio', 'Audio'],
  ['interface', 'Interface'],
  ['keybinds', 'Keybinds'],
  ['account', 'Account'],
];

export function createMenus(hud) {
  const { ctx } = hud;
  const layer = hud.uiLayer;
  const defs = settingDefs(hud);

  // ------------------------------------------------------------------ shared decor
  const screens = {};
  const mk = (name, cls = '') => (screens[name] = el('div', 'od-screen ' + cls, layer));

  // ================================================================ ENTRY / PRE-MENU
  const entry = mk('entry', 'od-main od-entry');
  el('div', 'od-scrim', entry);
  el('div', 'od-scan', entry);
  const entryTitle = el('div', 'od-title', entry);
  el('div', 'emb', entryTitle, EMBLEM);
  el('div', 'op', entryTitle).textContent = 'Vangaurd';
  el('h1', '', entryTitle, '<span>VANGAURD</span>');
  el('div', 'sub', entryTitle).textContent = 'Choose your deployment';
  const entryMenu = el('div', 'od-menu od-entry-menu', entry);
  const entryItems = [
    item(entryMenu, 'Singleplayer', 'Play immediately against AI', startSingleplayer),
    item(entryMenu, 'Multiplayer', 'Ready up and wait for other players', startMultiplayer),
  ];
  const entryFoot = el('div', 'od-foot', entry);
  entryFoot.innerHTML = `<span class="hint"><span class="od-key">↑↓</span>Navigate</span><span class="hint"><span class="od-key">ENTER</span>Select</span><span class="sp"></span><span class="ver">Vangaurd · Build 0.7</span>`;

  // =================================================================== PRE-MATCH LOADING
  const loading = mk('loading', 'od-loading');
  el('div', 'od-scrim dark', loading);
  const loadingCard = el('section', 'od-loading-card', loading);
  loadingCard.setAttribute('aria-labelledby', 'od-loading-title');
  el('div', 'od-loading-brand', loadingCard).textContent = 'VANGAURD';
  const loadingTitle = el('h2', '', loadingCard);
  loadingTitle.id = 'od-loading-title';
  loadingTitle.textContent = 'Preparing match';
  const loadingStatus = el('div', 'od-loading-status', loadingCard);
  loadingStatus.setAttribute('role', 'status');
  loadingStatus.setAttribute('aria-live', 'polite');
  el('div', 'od-loading-bar', loadingCard, '<i></i>');
  // =================================================================== MAIN
  const main = mk('main', 'od-main');
  el('div', 'od-scrim', main);
  el('div', 'od-scan', main);
  const title = el('div', 'od-title', main);
  el('div', 'emb', title, EMBLEM);
  el('div', 'op', title).textContent = 'Vangaurd';
  el('h1', '', title, '<span>VANGAURD</span>');
  el('div', 'sub', title).textContent = '';
  const mainMenu = el('div', 'od-menu', main);
  const modes = [
    ['tdm', 'Team Deathmatch', '5 vs 5 · First team to 30'],
    ['protection', 'Protection', 'Hold Vardanek · Wave survival'],
  ];
  let modeIndex = Math.max(0, modes.findIndex(([key]) => key === ctx.services.gamemode.state?.matchType));
  const mainItems = [
    item(mainMenu, 'Game mode', 'Select an operation', () => openModePopup()),
    item(mainMenu, 'Singleplayer', 'Start immediately against AI', () => { if (st.sessionType === 'multiplayer') toggleMultiplayerReady(); else play(); }),
    item(mainMenu, 'Progression & armory', 'Experimental local profile, weapon unlocks, and equipment', () => { refreshArmory(); open('armory'); }),
    item(mainMenu, 'Settings', 'Graphics, mouse, audio and interface', () => openSettings('graphics')),
    item(mainMenu, 'Back', 'Return to deployment selection', () => open('entry')),
  ];
  const card = el('div', 'od-card', main);
  const cardHead = el('div', 'od-card-head', card);
  const cardK = el('div', 'k', cardHead);
  const cardT = el('div', 't', card);
  const cardP = el('div', 'p', card);
  const cardMap = el('div', 'map', card);
  const cardCanvas = el('canvas', '', cardMap);
  const cardStats = el('div', 'stats', card);
  const multiplayerStatus = el('div', 'od-mp-status', main);
  multiplayerStatus.setAttribute('role', 'status');
  multiplayerStatus.setAttribute('aria-live', 'polite');
  const multiplayerStatusText = el('div', '', multiplayerStatus);
  const multiplayerServerLabel = el('label', 'od-mp-server-label', multiplayerStatus);
  multiplayerServerLabel.textContent = 'Railway server URL';
  const multiplayerServerInput = el('input', 'od-mp-server-input', multiplayerServerLabel);
  multiplayerServerInput.type = 'url';
  multiplayerServerInput.placeholder = 'https://your-service.up.railway.app';
  multiplayerServerInput.autocomplete = 'url';
  const multiplayerActions = el('div', 'od-mp-actions', multiplayerStatus);
  const multiplayerServerSave = el('button', 'od-btn', multiplayerActions);
  multiplayerServerSave.type = 'button';
  multiplayerServerSave.textContent = 'Save server';
  const multiplayerLeave = el('button', 'od-btn', multiplayerActions);
  multiplayerLeave.type = 'button';
  multiplayerLeave.textContent = 'Leave room';
  multiplayerLeave.hidden = true;
  const modePopup = el('div', 'od-mode-popup', main);
  modePopup.setAttribute('aria-hidden', 'true');
  const modeBackdrop = el('button', 'od-mode-backdrop', modePopup);
  modeBackdrop.type = 'button';
  modeBackdrop.setAttribute('aria-label', 'Close game mode selector');
  const modeDialog = el('section', 'od-mode-dialog', modePopup);
  modeDialog.setAttribute('role', 'dialog');
  modeDialog.setAttribute('aria-modal', 'true');
  modeDialog.setAttribute('aria-labelledby', 'od-mode-title');
  const modeDialogHead = el('div', 'od-mode-dialog-head', modeDialog);
  const modeDialogTitle = el('div', 'od-mode-dialog-title', modeDialogHead);
  modeDialogTitle.id = 'od-mode-title';
  modeDialogTitle.textContent = 'Choose operation';
  const modeClose = el('button', 'od-mode-close', modeDialogHead);
  modeClose.type = 'button';
  modeClose.textContent = '×';
  modeClose.setAttribute('aria-label', 'Close game mode selector');
  el('div', 'od-mode-dialog-sub', modeDialog).textContent = 'Select a game mode to deploy';
  const modeGrid = el('div', 'od-mode-grid', modeDialog);
  const modeCards = modes.map(([key, label, sub]) => {
    const button = el('button', 'od-mode-option', modeGrid);
    button.type = 'button';
    button.dataset.mode = key;
    button.setAttribute('aria-pressed', 'false');
    const thumb = el('span', 'od-mode-thumb', button);
    const canvas = el('canvas', '', thumb);
    const mark = el('span', 'od-mode-mark', thumb);
    mark.textContent = key === 'tdm' ? '05 / 05' : 'HOLD THE LINE';
    const info = el('span', 'od-mode-info', button);
    el('span', 'od-mode-name', info).textContent = label;
    el('span', 'od-mode-desc', info).textContent = sub;
    button.addEventListener('click', () => {
      const selected = modes.findIndex(([candidate]) => candidate === key);
      if (selected >= 0) modeIndex = selected;
      ctx.services.gamemode.setMode?.(key);
      displayMode(key);
      closeModePopup();
    });
    return { key, button, canvas };
  });
  mainItems[0].setAttribute('aria-haspopup', 'dialog');
  mainItems[0].setAttribute('aria-expanded', 'false');
  modeBackdrop.addEventListener('click', closeModePopup);
  modeClose.addEventListener('click', closeModePopup);
  modeDialog.addEventListener('click', (event) => event.stopPropagation());
  const foot = el('div', 'od-foot', main);
  foot.innerHTML = `<span class="hint"><span class="od-key">↑↓</span>Navigate</span><span class="hint"><span class="od-key">ENTER</span>Select</span><span class="sp"></span><span class="ver">Vangaurd · Build 0.7</span>`;

  // ============================================================ EXPERIMENTAL PROGRESSION / ARMORY
  const armory = mk('armory', 'od-main');
  el('div', 'od-scrim dark', armory);
  const armoryHead = el('div', 'od-hdr', armory);
  el('div', 'k', armoryHead).textContent = 'Experimental · Local profile';
  el('h2', '', armoryHead).textContent = 'Progression & armory';
  const armoryTabs = el('div', 'od-tabs', armory);
  const armoryTabEls = {};
  for (const [id, label] of [['level', 'Level'], ['attachments', 'Weapon attachments']]) {
    const button = el('button', 'od-tab', armoryTabs);
    button.textContent = label;
    button.addEventListener('click', () => {
      st.armoryPage = id;
      refreshArmory();
    });
    armoryTabEls[id] = button;
  }
  const armoryContent = el('div', 'od-armory-content', armory);
  const armoryFoot = el('div', 'od-foot', armory);
  armoryFoot.innerHTML = `<span class="hint"><span class="od-key">ESC</span>Back</span><span class="sp"></span><span class="ver">Experimental · Local save only</span>`;
  function refreshArmory() {
    const profile = getProgression();
    for (const [id] of [['level', 'Level'], ['attachments', 'Weapon attachments']]) {
      setClass(armoryTabEls[id], 'sel', st.armoryPage === id);
    }
    if (st.armoryPage === 'attachments') {
      const weaponOptions = ['rifle', 'pistol'].map((id) => `<button class="od-btn ${id === st.armoryWeaponId ? 'pri' : ''}" type="button" data-weapon-id="${id}">${id === 'rifle' ? 'WARDEN AR-7' : 'KESTREL P9'}</button>`).join('');
      const slots = getAttachmentSlots();
      const weaponProgression = getWeaponProgression(st.armoryWeaponId);
      const loadout = getWeaponLoadout(st.armoryWeaponId);
      const slotMarkup = Object.entries(slots).map(([slot, config]) => {
        const row = config.options.map((option) => {
          const unlocked = weaponProgression.kills >= option.unlockKills;
          const active = loadout[slot] === option.id;
          return `<button class="od-btn ${active ? 'pri' : ''}" type="button" data-attachment-slot="${slot}" data-attachment-id="${option.id}" ${unlocked ? '' : 'disabled'}>${option.name}${option.id === 'none' ? '' : ` · ${option.unlockKills}K`}</button>`;
        }).join('');
        return `<section><h3>${config.label}</h3><p>${config.options.find((option) => option.id === loadout[slot])?.effect || 'No modification selected.'}</p><div class="od-armory-grenades">${row}</div></section>`;
      }).join('');
      armoryContent.innerHTML = `<div class="od-armory-grid"><section><h3>Weapon loadout</h3><p>${st.armoryWeaponId === 'rifle' ? 'WARDEN AR-7' : 'KESTREL P9'} · Level ${weaponProgression.level} · ${weaponProgression.kills} eliminations</p><div class="od-armory-grenades">${weaponOptions}</div></section><section><h3>Attachment rules</h3><p>Choose a slot and pick an unlock that matches your current weapon rank. Progression is saved locally on this device.</p></section></div><div class="od-armory-grid od-armory-weapons">${slotMarkup}</div><p class="od-armory-note">Attachment unlocks are gated by each weapon's elimination count and persist in your local profile.</p>`;
    } else {
      const weapons = ['rifle', 'pistol'].map((id) => {
        const prog = getWeaponProgression(id);
        return `<section><h3>${id === 'rifle' ? 'WARDEN AR-7' : 'KESTREL P9'} · Level ${prog.level}</h3><p>${prog.kills} eliminations · ${prog.nextUnlockKills ? `${prog.nextUnlockKills - prog.kills} until next unlock` : 'All experimental unlocks earned'}</p>${prog.attachments.map((attachment) => `<div class="od-armory-unlock ${attachment.unlocked ? 'on' : ''}"><b>${attachment.unlocked ? 'UNLOCKED' : `LOCKED · ${attachment.unlockKills} KILLS`}</b><span>${attachment.name} — ${attachment.effect}</span></div>`).join('')}</section>`;
      }).join('');
      const grenade = getSelectedGrenade();
      armoryContent.innerHTML = `<div class="od-armory-grid"><section><h3>Operator progression</h3><p class="od-armory-rank">${profile.rank}</p><p>${profile.xp} XP · ${profile.kills} eliminations · ${profile.headshots} headshots · ${profile.deaths} deaths</p><div class="od-armory-bar"><i style="transform:scaleX(${profile.rankProgress.toFixed(3)})"></i></div><p>${profile.nextRank ? `${profile.nextRankXp - profile.xp} XP to ${profile.nextRank}` : 'Maximum experimental rank'}</p><h3>Challenges</h3><p>${profile.kills >= 10 ? 'Complete' : `${profile.kills}/10`} eliminations · ${profile.headshots >= 5 ? 'Complete' : `${profile.headshots}/5`} headshots</p><h3>Cosmetic unlocks</h3><p>${profile.rankIndex >= 3 ? 'Veteran rank insignia unlocked (experimental profile cosmetic).' : 'Earn Veteran rank to unlock the insignia.'}</p></section><section><h3>Equipment · Select with G</h3><p>Chosen: <strong>${grenade.toUpperCase()}</strong> · Press T during play to cycle.</p><div class="od-armory-grenades">${getGrenadeTypes().map((type) => `<button class="od-btn ${type === grenade ? 'pri' : ''}" data-grenade="${type}">${type}</button>`).join('')}</div><p>Frag: damage · Smoke: obscuring emitter · Flash: disorienting pulse · Proximity: armed area trigger.</p></section></div><div class="od-armory-grid od-armory-weapons">${weapons}</div><p class="od-armory-note">Progress and unlocks are experimental and saved locally on this device. Online server browser and parties need a multiplayer backend and are not connected in this build.</p>`;
    }
    armoryContent.querySelectorAll('[data-grenade]').forEach((button) => button.addEventListener('click', () => {
      const selected = setSelectedGrenade(button.dataset.grenade);
      if (ctx.services.weapons?.state) ctx.services.weapons.state.grenadeType = selected;
      ctx.events.emit('weapons:grenade', { phase: 'selected', type: selected });
      refreshArmory();
    }));
    armoryContent.querySelectorAll('[data-attachment-slot]').forEach((button) => button.addEventListener('click', () => {
      const slot = button.dataset.attachmentSlot;
      const optionId = button.dataset.attachmentId;
      setWeaponAttachment(st.armoryWeaponId, slot, optionId);
      refreshArmory();
    }));
    armoryContent.querySelectorAll('[data-weapon-id]').forEach((button) => button.addEventListener('click', () => {
      st.armoryWeaponId = button.dataset.weaponId;
      refreshArmory();
    }));
  }
  armoryContent.addEventListener('click', (event) => event.stopPropagation());
  const profileListeners = [];
  const onProfileKill = (event) => {
    if (event?.source !== 'player' || event.target?.team === 'player' || event.target?.team === 'friendly') return;
    recordProgressionKill(event.weaponId, event.zone === 'head');
    if (st.screen === 'armory') refreshArmory();
  };
  const onProfileDeath = () => {
    recordProgressionDeath();
    if (st.screen === 'armory') refreshArmory();
  };
  ctx.events.on('combat:kill', onProfileKill);
  ctx.events.on('player:died', onProfileDeath);
  profileListeners.push(['combat:kill', onProfileKill], ['player:died', onProfileDeath]);

  // =================================================================== PAUSE
  const pause = mk('pause', 'od-pause');
  el('div', 'od-scrim dark', pause);
  const pHdr = el('div', 'od-hdr', pause);
  el('div', 'k', pHdr).textContent = 'Hold Vardanek';
  el('h2', '', pHdr).textContent = 'Paused';
  const pauseMenu = el('div', 'od-menu pause', pause);
  const pauseItems = [
    item(pauseMenu, 'Resume', 'Return to the fight', () => resume()),
    item(pauseMenu, 'Settings', 'Graphics, mouse, audio and interface', () => openSettings('graphics')),
    item(pauseMenu, 'Restart', 'Restart the operation from wave 1', () => restart()),
    item(pauseMenu, 'Quit to main menu', 'Abandon the current operation', () => quitToMenu()),
  ];
  const pStats = el('div', 'od-pstats', pause);
  const pFoot = el('div', 'od-foot', pause);
  pFoot.innerHTML = `<span class="hint"><span class="od-key">ESC</span>Resume</span><span class="hint"><span class="od-key">ENTER</span>Select</span><span class="sp"></span><span class="ver">Vangaurd</span>`;

  // =================================================================== SETTINGS
  const settings = mk('settings', 'od-settings');
  el('div', 'od-scrim dark', settings);
  const sHdr = el('div', 'od-hdr', settings);
  el('div', 'k', sHdr).textContent = 'Options';
  el('h2', '', sHdr).textContent = 'Settings';
  const tabs = el('div', 'od-tabs', settings);
  const tabEls = {};
  for (const [id, label] of TABS) {
    const b = el('button', 'od-tab', tabs);
    b.textContent = label;
    b.addEventListener('click', () => openSettings(id, true));
    tabEls[id] = b;
  }
  const set = el('div', 'od-set', settings);
  const rowsEl = el('div', 'od-rows', set);
  const desc = el('div', 'od-desc', set);
  const descT = el('div', 't', desc);
  const descP = el('div', 'p', desc);
  const descD = el('div', 'dflt', desc);
  const accountPanel = el('section', 'od-account-panel', set);
  el('div', 'od-account-kicker', accountPanel).textContent = 'Local profile';
  el('h3', '', accountPanel).textContent = 'Player name';
  el('p', 'od-account-copy', accountPanel).textContent = 'Choose the name shown for you in killfeeds and HUD callouts. This is saved on this device.';
  const accountField = el('label', 'od-account-field', accountPanel);
  el('span', '', accountField).textContent = 'Username';
  const accountInput = el('input', 'od-account-input', accountField);
  accountInput.type = 'text';
  accountInput.autocomplete = 'nickname';
  accountInput.maxLength = 20;
  accountInput.placeholder = 'Enter username';
  const accountActions = el('div', 'od-account-actions', accountPanel);
  const accountSave = el('button', 'od-btn pri', accountActions);
  accountSave.type = 'button';
  accountSave.textContent = 'Save username';
  const accountStatus = el('span', 'od-account-status', accountActions);
  const saveAccountName = () => {
    const result = setPlayerName(accountInput.value);
    accountInput.value = result.name;
    accountStatus.textContent = result.ok ? 'Saved on this device.' : result.reason;
    accountStatus.classList.toggle('error', !result.ok);
  };
  accountInput.value = getPlayerName();
  accountSave.addEventListener('click', saveAccountName);
  accountInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { saveAccountName(); event.preventDefault(); }
  });
  const sFoot = el('div', 'od-foot', settings);
  sFoot.innerHTML = `<span class="hint"><span class="od-key">ESC</span>Back</span><span class="hint"><span class="od-key">Q</span><span class="od-key">E</span>Tabs</span><span class="hint"><span class="od-key">←→</span>Adjust</span><span class="sp"></span>`;
  const resetBtn = el('button', 'od-btn', sFoot);
  resetBtn.textContent = 'Reset keybinds';
  resetBtn.addEventListener('click', () => { ctx.input.resetBindings?.(); buildRows(); });

  // =================================================================== DEATH
  const death = mk('death', 'od-death');
  el('div', 'tint', death);
  const kia = el('div', 'kia', death);
  const kiaK = el('div', 'k', kia);
  const kiaH = el('h2', '', kia);
  const replay = mk('replay', 'od-killcam-screen');
  el('div', 'od-killcam-vignette', replay);
  const killcamLabel = el('div', 'od-killcam', replay);
  const replayBar = el('div', 'od-killcam-bar', replay);
  const replayProgress = el('i', '', replayBar);
  const killcamSkip = el('button', 'od-killcam-skip', replay);
  killcamSkip.type = 'button';
  killcamSkip.textContent = 'Skip replay · K';
  killcamSkip.addEventListener('click', finishKillReplay);
  el('div', 'rule', kia);
  const killer = el('div', 'od-killer', death);
  const kWho = el('div', 'who', killer);
  el('div', 'k', kWho).textContent = 'Killed by';
  const kName = el('div', 'n', kWho);
  const kFaction = el('div', 'f', kWho);
  const kWp = el('div', 'wp', killer);
  const kWpI = el('div', 'i', kWp);
  const kWpT = el('div', 't', kWp);
  const dStats = el('div', 'od-dstats', death);
  const redeploy = el('div', 'od-redeploy', death);
  const rdT = el('div', 't', redeploy);
  const rdBar = el('div', 'bar', redeploy);
  const rdFill = el('i', '', rdBar);
  const rdLives = el('div', 'lv', redeploy);
  const rdBtns = el('div', 'btns', redeploy);
  const btnRetry = el('button', 'od-btn pri', rdBtns);
  btnRetry.textContent = 'Redeploy';
  btnRetry.addEventListener('click', () => restart());
  const btnMenu = el('button', 'od-btn', rdBtns);
  btnMenu.textContent = 'Main menu';
  btnMenu.addEventListener('click', () => quitToMenu());

  // =================================================================== RESUME GATE
  const resumeGate = mk('resume', '');
  const rg = el('div', 'od-resume', resumeGate);
  el('div', 't', rg).textContent = 'Click to resume';
  el('div', 's', rg).textContent = 'Mouse capture is required to play';
  rg.addEventListener('click', () => ctx.ui.requestPointerLock());

  // =================================================================== fade + grain
  const grain = el('div', 'od-grain', layer);
  grain.style.backgroundImage = `url(${makeGrain(ctx.rng.fork('hud-grain'))})`;
  setOpacity(grain, 0);
  const fadeBlack = el('div', 'od-fadeblack', layer);
  setOpacity(fadeBlack, 0);

  // ------------------------------------------------------------------ state
  const st = {
    screen: 'none',
    stack: [],
    sel: { entry: 0, main: 0, pause: 0, settings: 0 },
    sessionType: null,
    waitingForPlayers: false,
    tab: 'graphics',
    armoryPage: 'level',
    armoryWeaponId: 'rifle',
    multiplayerSocket: null,
    multiplayerMatch: null,
    multiplayerPlayerId: null,
    rows: [], // settings rows [{def, el, ...}]
    listening: null, // keybind capture {action, row}
    deathAge: 0,
    replayAge: 0,
    killReplaySkipped: false,
    gameOver: false,
    camActive: false,
    camT: 0,
    shots: null,
    vmDisabled: false,
    timeScaleSaved: null,
    screenAge: 0,
    death: null,
  };

  function displayMode(modeKey) {
    const selected = modes.findIndex(([candidate]) => candidate === modeKey);
    if (selected >= 0) modeIndex = selected;
    const [key, label, sub] = modes[modeIndex];
    mainItems[1].querySelector('.d').textContent = st.sessionType === 'multiplayer'
      ? 'Ready up to join the player queue'
      : 'Start immediately against AI';
    modeCards.forEach(({ key: cardKey, button }) => {
      const active = cardKey === key;
      button.classList.toggle('sel', active);
      button.setAttribute('aria-pressed', String(active));
    });
    cardK.textContent = key === 'protection' ? 'Mission · Protection' : `Match · ${label}`;
    cardT.textContent = key === 'protection' ? 'Hold Vardanek' : '5 vs 5 · First to 30';
    cardP.textContent = key === 'protection'
      ? 'Crimson Vanguard contractors are pushing into the old town. Hold the plaza against escalating waves until the relief column arrives.'
      : 'Join the defending squad. Four AI teammates face five Crimson Vanguard soldiers. The first side to 30 eliminations wins.';
    refreshCard();
  }
  function drawModeThumbnails() {
    const width = Math.round(460 * hud.u * hud.dpr);
    const height = Math.round(150 * hud.u * hud.dpr);
    const sp = ctx.services.world.spawnPoints?.player?.[0]?.position;
    const bounds = ctx.services.world.bounds;
    const cx = bounds ? (bounds.min.x + bounds.max.x) / 2 : sp?.x || 0;
    const cz = bounds ? (bounds.min.z + bounds.max.z) / 2 : sp?.z || 0;
    const span = bounds ? Math.max(bounds.max.x - bounds.min.x, (bounds.max.z - bounds.min.z) * (width / height)) * 1.05 : 120;
    const tints = { protection: [0.12, 0.2, 0.09], tdm: [0.08, 0.16, 0.22] };
    for (const { key, canvas } of modeCards) {
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      hud.minimap.drawPreview(canvas, cx, cz, span);
      const g = canvas.getContext('2d');
      const [r, green, b] = tints[key];
      g.fillStyle = `rgba(${Math.round(r * 255)},${Math.round(green * 255)},${Math.round(b * 255)},.48)`;
      g.fillRect(0, 0, width, height);
      const gradient = g.createLinearGradient(0, height * 0.25, 0, height);
      gradient.addColorStop(0, 'rgba(5,8,10,0)');
      gradient.addColorStop(1, 'rgba(5,8,10,.82)');
      g.fillStyle = gradient;
      g.fillRect(0, 0, width, height);
      if (sp && bounds) {
        const scale = width / span;
        const x = width / 2 + (sp.x - cx) * scale;
        const y = height / 2 + (sp.z - cz) * scale;
        g.fillStyle = '#f0c048';
        g.beginPath(); g.arc(x, y, 3.5 * hud.u * hud.dpr, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(240,192,72,.8)';
        g.lineWidth = 1.2 * hud.u * hud.dpr;
        g.beginPath(); g.arc(x, y, 13 * hud.u * hud.dpr, 0, Math.PI * 2); g.stroke();
      }
    }
  }
  function openModePopup() {
    if (st.screen !== 'main') return;
    modePopup.classList.add('on');
    modePopup.setAttribute('aria-hidden', 'false');
    mainItems[0].setAttribute('aria-expanded', 'true');
    const selected = modes.findIndex(([key]) => key === ctx.services.gamemode.state?.matchType);
    modeIndex = selected >= 0 ? selected : modeIndex;
    if (st.sessionType === 'multiplayer' && modes[modeIndex]?.[0] === 'protection') modeIndex = 0;
    drawModeThumbnails();
    modeCards[modeIndex]?.button.focus();
  }
  function closeModePopup() {
    if (!modePopup.classList.contains('on')) return;
    modePopup.classList.remove('on');
    modePopup.setAttribute('aria-hidden', 'true');
    mainItems[0].setAttribute('aria-expanded', 'false');
    mainItems[0].focus();
  }
  function moveModeSelection(direction) {
    modeIndex = (modeIndex + direction + modes.length) % modes.length;
    modeCards[modeIndex]?.button.focus();
  }
  const onGameMode = ({ mode } = {}) => { if (mode) displayMode(mode); };
  ctx.events.on('gamemode:mode', onGameMode);
  displayMode(modes[modeIndex][0]);

  function updateSessionUI() {
    const multiplayer = st.sessionType === 'multiplayer';
    const selectedMode = modes[modeIndex]?.[0];
    if (multiplayer && selectedMode === 'protection') {
      modeIndex = 0;
      ctx.services.gamemode.setMode?.('tdm');
    }
    mainItems[1].firstChild.nodeValue = st.waitingForPlayers ? 'Cancel Queue' : st.multiplayerMatch ? 'Deploy Online Match' : multiplayer ? 'Quick Join' : 'Start Game';
    mainItems[1].querySelector('.d').textContent = st.waitingForPlayers
      ? 'Cancel your current matchmaking request'
      : st.multiplayerMatch ? 'Deploy into the reserved online TDM room'
      : multiplayer ? 'Ready up to join the player queue' : 'Start immediately against AI';
    modeCards.forEach(({ key, button }) => { button.hidden = multiplayer && key === 'protection'; });
    multiplayerStatus.hidden = !multiplayer;
    multiplayerLeave.hidden = !st.multiplayerMatch;
    if (multiplayer && !multiplayerStatusText.textContent) {
      multiplayerStatusText.textContent = st.waitingForPlayers ? 'Connecting to the matchmaking queue…' : 'Save your Railway server URL, then Quick Join.';
    }
    displayMode(modes[modeIndex][0]);
  }

  const MULTIPLAYER_URL_KEY = 'vangaurd.multiplayer.url.v1';
  try { multiplayerServerInput.value = globalThis.localStorage?.getItem(MULTIPLAYER_URL_KEY) || DEFAULT_MULTIPLAYER_URL; }
  catch { multiplayerServerInput.value = DEFAULT_MULTIPLAYER_URL; }

  function normalizeMatchmakingUrl(value) {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) throw new Error('Use an HTTP(S) Railway service URL.');
    const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
    parsed.protocol = secure ? 'wss:' : 'ws:';
    parsed.pathname = '/ws';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  }

  function saveMultiplayerServer() {
    try {
      const wsUrl = normalizeMatchmakingUrl(multiplayerServerInput.value);
      const saved = wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/ws$/, '');
      globalThis.localStorage?.setItem(MULTIPLAYER_URL_KEY, saved);
      multiplayerServerInput.value = saved;
      multiplayerStatusText.textContent = 'Server address saved on this device.';
      return wsUrl;
    } catch (error) {
      multiplayerStatusText.textContent = error.message || 'Enter a valid Railway service URL.';
      return null;
    }
  }

  function connectMatchmaking() {
    if (st.multiplayerSocket?.readyState === WebSocket.OPEN) return Promise.resolve(st.multiplayerSocket);
    if (st.multiplayerSocket?.readyState === WebSocket.CONNECTING) {
      return new Promise((resolve, reject) => {
        st.multiplayerSocket.addEventListener('open', () => resolve(st.multiplayerSocket), { once: true });
        st.multiplayerSocket.addEventListener('error', () => reject(new Error('Could not connect to the Railway matchmaking service.')), { once: true });
      });
    }
    const url = saveMultiplayerServer();
    if (!url) return Promise.reject(new Error(multiplayerStatusText.textContent));
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      st.multiplayerSocket = socket;
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) { settled = true; socket.close(); reject(new Error('Matchmaking connection timed out.')); }
      }, 8000);
      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        settled = true;
        multiplayerStatusText.textContent = 'Connected to Railway matchmaking.';
        resolve(socket);
      }, { once: true });
      socket.addEventListener('message', (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        ctx.events.emit('network:message', message);
        if (message.type === 'connected') {
          st.multiplayerPlayerId = message.playerId;
        } else if (message.type === 'queue_status') {
          st.waitingForPlayers = true;
          multiplayerStatusText.textContent = `Searching Team Deathmatch · ${message.queued}/${message.required} players queued.`;
          updateSessionUI();
        } else if (message.type === 'queue_cancelled') {
          st.waitingForPlayers = false;
          multiplayerStatusText.textContent = 'Matchmaking queue cancelled.';
          updateSessionUI();
        } else if (message.type === 'match_found') {
          st.waitingForPlayers = false;
          st.multiplayerMatch = message;
          ctx.events.emit('network:session', { ...message, playerId: st.multiplayerPlayerId });
          const names = message.roster.map((member) => member.name).join(', ');
          multiplayerStatusText.textContent = `Room ${message.matchId.slice(0, 8)} ready · ${message.roster.length} players: ${names}. Deploy to see teammates move in real time.`;
          updateSessionUI();
        } else if (message.type === 'match_left') {
          st.multiplayerMatch = null;
          ctx.events.emit('network:clear');
          multiplayerStatusText.textContent = 'Left matchmaking room.';
          updateSessionUI();
        } else if (message.type === 'player_left') {
          multiplayerStatusText.textContent = 'A player left the reserved room.';
        } else if (message.type === 'error') {
          multiplayerStatusText.textContent = message.message || 'Matchmaking service error.';
        }
      });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        if (!settled) { settled = true; reject(new Error('Could not connect. Check the Railway URL and service deployment.')); }
        multiplayerStatusText.textContent = 'Connection failed. Check the Railway URL and service deployment.';
      });
      socket.addEventListener('close', () => {
        clearTimeout(timeout);
        st.waitingForPlayers = false;
        st.multiplayerMatch = null;
        st.multiplayerPlayerId = null;
        ctx.events.emit('network:clear');
        if (st.sessionType === 'multiplayer') {
          multiplayerStatusText.textContent = 'Disconnected from matchmaking. Quick Join to reconnect.';
          updateSessionUI();
        }
      });
    });
  }

  multiplayerServerSave.addEventListener('click', saveMultiplayerServer);
  multiplayerServerInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { saveMultiplayerServer(); event.preventDefault(); }
  });
  const onNetworkSend = (message) => {
    const socket = st.multiplayerSocket;
    if (socket?.readyState === WebSocket.OPEN && st.multiplayerMatch) socket.send(JSON.stringify(message));
  };
  ctx.events.on('network:send', onNetworkSend);
  multiplayerLeave.addEventListener('click', () => {
    if (st.multiplayerSocket?.readyState === WebSocket.OPEN) st.multiplayerSocket.send(JSON.stringify({ type: 'leave_match' }));
    st.multiplayerMatch = null;
    ctx.events.emit('network:clear');
    multiplayerStatusText.textContent = 'Leaving matchmaking room…';
    updateSessionUI();
  });

  function startSingleplayer() {
    if (st.multiplayerMatch && st.multiplayerSocket?.readyState === WebSocket.OPEN) st.multiplayerSocket.send(JSON.stringify({ type: 'leave_match' }));
    ctx.events.emit('network:clear');
    st.sessionType = 'singleplayer';
    st.waitingForPlayers = false;
    st.multiplayerMatch = null;
    open('main');
  }
  function startMultiplayer() {
    st.sessionType = 'multiplayer';
    st.waitingForPlayers = false;
    st.multiplayerMatch = null;
    multiplayerStatusText.textContent = 'Save your Railway server URL, then Quick Join.';
    if (modes[modeIndex]?.[0] === 'protection') modeIndex = 0;
    ctx.services.gamemode.setMode?.(modes[modeIndex][0]);
    open('main');
  }
  async function toggleMultiplayerReady() {
    if (st.sessionType !== 'multiplayer') return play();
    if (st.multiplayerMatch) {
      play();
      return;
    }
    if (st.waitingForPlayers) {
      st.multiplayerSocket?.send(JSON.stringify({ type: 'cancel_queue' }));
      st.waitingForPlayers = false;
      multiplayerStatusText.textContent = 'Cancelling matchmaking request…';
      updateSessionUI();
      return;
    }
    try {
      const socket = await connectMatchmaking();
      if (socket.readyState !== WebSocket.OPEN) throw new Error('Matchmaking connection closed before joining.');
      socket.send(JSON.stringify({ type: 'join_queue', mode: 'tdm', name: getPlayerName() }));
      st.waitingForPlayers = true;
      multiplayerStatusText.textContent = 'Joining Team Deathmatch queue…';
    } catch (error) {
      multiplayerStatusText.textContent = error.message || 'Unable to join matchmaking.';
    }
    updateSessionUI();
  }

  function item(parent, label, sub, onClick, tag) {
    const b = el('button', 'od-item', parent);
    b.innerHTML = `${escapeHtml(label)}<span class="d">${escapeHtml(sub)}</span>${tag ? `<span class="tag">${tag}</span>` : ''}`;
    b.addEventListener('click', onClick);
    b.addEventListener('mouseenter', () => {
      const list = parent === mainMenu ? mainItems : parent === entryMenu ? entryItems : pauseItems;
      const i = list.indexOf(b);
      if (i >= 0) selectItem(parent === mainMenu ? 'main' : parent === entryMenu ? 'entry' : 'pause', i);
    });
    return b;
  }
  function menuItems(which) {
    if (which === 'entry') return entryItems;
    return which === 'main' ? mainItems : pauseItems;
  }
  function selectItem(which, i) {
    const list = menuItems(which);
    st.sel[which] = (i + list.length) % list.length;
    list.forEach((b, j) => setClass(b, 'sel', j === st.sel[which]));
  }
  selectItem('entry', 0);
  selectItem('main', 0);
  selectItem('pause', 0);

  // ------------------------------------------------------------------ screen switching
  function show(name) {
    for (const k in screens) setClass(screens[k], 'on', k === name);
    st.screen = name;
    st.screenAge = 0;
    hud.onMenuChanged?.(name);
    ctx.events.emit('hud:menu', { screen: name, open: name !== 'none' });
  }
  function openLoading(message = 'Loading match assets…') {
    loadingStatus.textContent = message;
    open('loading');
  }
  function setLoadingMessage(message) {
    loadingStatus.textContent = message;
  }
  function open(name) {
    if (name === 'settings' || name === 'controls') {
      openSettings(name === 'controls' ? 'keybinds' : st.tab);
      return;
    }
    st.stack.length = 0;
    if (name === 'entry') {
      st.sessionType = null;
      st.waitingForPlayers = false;
      selectItem('entry', 0);
    }
    if (name === 'main' || name === 'entry') {
      st.camActive = true;
      st.camT = 0;
    }
    if (name === 'main') {
      modeIndex = Math.max(0, modes.findIndex(([key]) => key === ctx.services.gamemode.state?.matchType));
      displayMode(modes[modeIndex][0]);
      updateSessionUI();
      selectItem('main', 0);
    }
    if (name === 'entry') selectItem('entry', 0);
    if (name === 'pause') {
      selectItem('pause', 0);
      refreshPauseStats();
    }
    if (name === 'death') {
      st.deathAge = 0;
      refreshDeath();
    }
    if (name === 'replay') {
      st.replayAge = 0;
      st.killReplaySkipped = false;
      refreshReplay();
    }
    if (name !== 'main' && name !== 'entry' && name !== 'settings') st.camActive = false;
    show(name);
    hud.applyPause();
  }
  function close() {
    st.stack.length = 0;
    st.camActive = false;
    st.listening = null;
    show('none');
    hud.applyPause();
  }
  function openSettings(tab, keepStack) {
    if (!keepStack && st.screen !== 'settings') st.stack.push(st.screen);
    st.tab = tab;
    for (const [id] of TABS) setClass(tabEls[id], 'sel', id === tab);
    setStyle(resetBtn, 'display', tab === 'keybinds' ? '' : 'none');
    setStyle(accountPanel, 'display', tab === 'account' ? '' : 'none');
    setStyle(rowsEl, 'display', tab === 'account' ? 'none' : '');
    setStyle(desc, 'display', tab === 'account' ? 'none' : '');
    buildRows();
    if (st.screen !== 'settings') show('settings');
  }
  function back() {
    if (st.listening) {
      st.listening = null;
      buildRows();
      return;
    }
    if (st.screen === 'settings') {
      const prev = st.stack.pop() || (hud.mode === 'boot' ? 'main' : 'pause');
      show(prev);
      if (prev === 'pause') refreshPauseStats();
      return;
    }
    if (st.screen === 'pause') resume();
  }

  // ------------------------------------------------------------------ actions
  function play() {
    hud.requestPlay();
  }
  function resume() {
    hud.requestResume();
  }
  function restart() {
    hud.requestRestart();
  }
  function quitToMenu() {
    hud.requestQuit();
  }

  // ------------------------------------------------------------------ settings rows
  function valueOf(def) {
    return ctx.settings.get(def.path);
  }
  function applySetting(def, v) {
    if (def.type === 'slider') {
      v = clamp(Math.round(v / def.step) * def.step, def.min, def.max);
      v = Number(v.toFixed(4));
    }
    ctx.settings.set(def.path, v);
    // direct side effects for systems that might only read settings at init
    try {
      if (def.path === 'graphics.quality') ctx.services.postfx.setQuality?.(v);
      if (def.bus) ctx.services.audio.setVolume?.(def.bus, v);
      if (def.path === 'hud.scale') hud.onResize();
    } catch (e) {
      ctx.reportError('hud', 'settings', e);
    }
    refreshRow(st.rows.find((r) => r.def === def));
  }

  function buildRows() {
    rowsEl.innerHTML = '';
    st.rows = [];
    const tab = st.tab;
    if (tab === 'account') {
      accountInput.value = getPlayerName();
      accountStatus.textContent = '';
      accountStatus.classList.remove('error');
      st.sel.settings = 0;
      return;
    }
    if (tab === 'keybinds') {
      el('div', 'od-sec', rowsEl).textContent = 'Keyboard & mouse';
      for (const [action, label] of ACTION_LABELS) {
        const r = el('div', 'od-row bind', rowsEl);
        el('div', 'lb', r).textContent = label;
        const ctl = el('div', 'ctl', r);
        const row = { def: { type: 'bind', action, label, desc: `Rebind "${label}". Click, then press a key or mouse button. ESC cancels.` }, el: r, ctl };
        r.addEventListener('click', () => {
          st.listening = { action, row, t: 0 };
          refreshRow(row);
        });
        r.addEventListener('mouseenter', () => selectRow(st.rows.indexOf(row)));
        st.rows.push(row);
        refreshRow(row);
      }
    } else {
      const list = defs[tab].filter((d) => d.sec || !d.opt || ctx.settings.get(d.path) !== undefined);
      for (let di = 0; di < list.length; di++) {
        const def = list[di];
        if (def.sec) {
          if (list[di + 1] && !list[di + 1].sec) el('div', 'od-sec', rowsEl).textContent = def.sec;
          continue;
        }
        const r = el('div', 'od-row', rowsEl);
        el('div', 'lb', r).textContent = def.label;
        const ctl = el('div', 'ctl', r);
        const row = { def, el: r, ctl };
        if (def.type === 'slider') {
          const sl = el('div', 'od-sl', ctl);
          el('div', 'tr', sl);
          row.fill = el('div', 'fl', sl);
          row.knob = el('div', 'kn', sl);
          row.val = el('div', 'val', ctl);
          const setFromX = (clientX) => {
            const rc = sl.getBoundingClientRect();
            const f = clamp01((clientX - rc.left) / rc.width);
            applySetting(def, def.min + f * (def.max - def.min));
          };
          sl.addEventListener('mousedown', (e) => {
            e.preventDefault();
            setFromX(e.clientX);
            const mv = (ev) => setFromX(ev.clientX);
            const up = () => {
              window.removeEventListener('mousemove', mv);
              window.removeEventListener('mouseup', up);
            };
            window.addEventListener('mousemove', mv);
            window.addEventListener('mouseup', up);
          });
        } else {
          const cyc = el('div', 'od-cyc', ctl);
          const la = el('span', 'a', cyc, CHEVRON_LEFT);
          const mid = el('div', '', cyc);
          row.val = el('div', 'v', mid);
          row.pips = el('div', 'pips', mid);
          const ra = el('span', 'a', cyc, CHEVRON_RIGHT);
          la.addEventListener('click', (e) => { e.stopPropagation(); cycle(row, -1); });
          ra.addEventListener('click', (e) => { e.stopPropagation(); cycle(row, 1); });
          r.addEventListener('click', () => cycle(row, 1));
        }
        r.addEventListener('mouseenter', () => selectRow(st.rows.indexOf(row)));
        st.rows.push(row);
        refreshRow(row);
      }
    }
    selectRow(Math.min(st.sel.settings, st.rows.length - 1));
  }

  function options(def) {
    if (def.type === 'toggle') return [[true, 'ON'], [false, 'OFF']];
    return def.options;
  }
  function cycle(row, dir) {
    const def = row.def;
    if (def.type === 'slider') {
      applySetting(def, valueOf(def) + dir * def.step * (def.max - def.min > 5 ? 1 : 1));
      return;
    }
    if (def.type === 'bind') return;
    const opts = options(def);
    const cur = valueOf(def);
    let i = opts.findIndex((o) => o[0] === cur);
    i = (i + dir + opts.length) % opts.length;
    applySetting(def, opts[i][0]);
  }
  function refreshRow(row) {
    if (!row) return;
    const def = row.def;
    if (def.type === 'bind') {
      const codes = ctx.input.bindings?.[def.action] || [];
      const listening = st.listening && st.listening.row === row;
      setClass(row.el, 'listen', !!listening);
      row.ctl.innerHTML = listening
        ? `<span class="od-key">PRESS A KEY</span>`
        : codes.length ? codes.map((c) => `<span class="od-key">${escapeHtml(keyLabel(c))}</span>`).join('') : '<span class="od-key">—</span>';
      return;
    }
    const v = valueOf(def);
    if (def.type === 'slider') {
      const f = clamp01((v - def.min) / (def.max - def.min));
      row.fill.style.width = `${(f * 100).toFixed(2)}%`;
      row.knob.style.left = `${(f * 100).toFixed(2)}%`;
      row.val.textContent = def.fmt ? def.fmt(v) : String(v);
    } else {
      const opts = options(def);
      const i = opts.findIndex((o) => o[0] === v);
      row.val.textContent = i >= 0 ? opts[i][1] : String(v).toUpperCase();
      row.pips.innerHTML = opts.map((_, j) => `<i class="${j === i ? 'on' : ''}"></i>`).join('');
    }
  }
  function selectRow(i) {
    if (!st.rows.length) return;
    i = (i + st.rows.length) % st.rows.length;
    st.sel.settings = i;
    st.rows.forEach((r, j) => setClass(r.el, 'sel', j === i));
    const def = st.rows[i].def;
    setText(descT, def.label);
    setText(descP, def.desc || '');
    if (def.type === 'bind') setText(descD, 'Default: ' + (hud.defaultBinding(def.action) || []).map(keyLabel).join(' / '));
    else setText(descD, '');
    st.rows[i].el.scrollIntoView?.({ block: 'nearest' });
  }

  // ------------------------------------------------------------------ dynamic content
  function refreshCard() {
    const diff = ctx.settings.get('gameplay.difficulty') || 'regular';
    const dl = (DIFF.find((d) => d[0] === diff) || DIFF[1])[1];
    const best = hud.stats.best || 0;
    cardStats.innerHTML = `<div>Difficulty<b>${escapeHtml(dl)}</b></div><div>Time<b>17:40</b></div><div>Best<b>${best ? 'Wave ' + best : '—'}</b></div>`;
    drawCardMap();
  }
  function drawCardMap() {
    const w = Math.round(378 * hud.u * hud.dpr);
    const h = Math.round(170 * hud.u * hud.dpr);
    if (cardCanvas.width !== w || cardCanvas.height !== h) {
      cardCanvas.width = w;
      cardCanvas.height = h;
    }
    const sp = ctx.services.world.spawnPoints?.player?.[0]?.position;
    const b = ctx.services.world.bounds;
    const cx = b ? (b.min.x + b.max.x) / 2 : sp?.x || 0;
    const cz = b ? (b.min.z + b.max.z) / 2 : sp?.z || 0;
    const span = b ? Math.max(b.max.x - b.min.x, (b.max.z - b.min.z) * (w / h)) * 1.05 : 120;
    hud.minimap.drawPreview(cardCanvas, cx, cz, span);
    const g = cardCanvas.getContext('2d');
    if (sp && b) {
      const s = w / span;
      const x = w / 2 + (sp.x - cx) * s, y = h / 2 + (sp.z - cz) * s;
      g.fillStyle = '#f0c048';
      g.beginPath(); g.arc(x, y, 4 * hud.u * hud.dpr, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(240,192,72,0.5)';
      g.lineWidth = 1.2 * hud.u * hud.dpr;
      g.beginPath(); g.arc(x, y, 18 * hud.u * hud.dpr, 0, Math.PI * 2); g.stroke();
    }
  }
  function refreshPauseStats() {
    const s = hud.matchSnapshot();
    const gm = ctx.services.gamemode.state || {};
    if (gm.matchType === 'tdm') {
      pStats.innerHTML = `<div class="ttl">Team Deathmatch · first to 30</div>` +
        [['Blue team', gm.score?.blue || 0], ['Red team', gm.score?.red || 0], ['Your eliminations', s.kills], ['Headshots', s.headshots], ['Accuracy', s.accuracy], ['Time in match', `${Math.floor((gm.matchTime || 0) / 60)}:${String(Math.floor(gm.matchTime || 0) % 60).padStart(2, '0')}`]]
          .map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${escapeHtml(String(v))}</span></div>`).join('');
      return;
    }
    pStats.innerHTML = `<div class="ttl">Operation status</div>` +
      [['Wave', s.wave ?? '—'], ['Hostiles remaining', s.hostiles ?? '—'], ['Kills', s.kills], ['Headshots', s.headshots], ['Score', formatInt(s.score)], ['Accuracy', s.accuracy], ['Time in combat', s.time]]
        .map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${escapeHtml(String(v))}</span></div>`).join('');
  }
  function refreshDeath() {
    const d = hud.deathInfo;
    const over = hud.isGameOver();
    st.gameOver = over;
    setText(kiaK, over ? 'Operation failed' : 'Vangaurd');
    setText(kiaH, over ? 'Vardanek has fallen' : 'Killed in action');
    setText(kName, d.killer || 'Unknown');
    setText(kFaction, d.faction || 'Crimson Vanguard');
    setHTML(kWpI, weaponIcon(d.weaponId, d.kind));
    setText(kWpT, [d.weaponName || '', d.distance != null ? `${Math.round(d.distance)} m` : ''].filter(Boolean).join(' · '));
    const s = hud.matchSnapshot();
    dStats.innerHTML = [['Wave', s.wave ?? '—'], ['Kills', s.kills], ['Headshots', s.headshots], ['Score', formatInt(s.score)]]
      .map(([k, v]) => `<div>${k}<b>${escapeHtml(String(v))}</b></div>`).join('');
    setStyle(rdBtns, 'display', over ? '' : 'none');
    setStyle(rdBar, 'display', over ? 'none' : '');
  }
  function refreshReplay() {
    setText(killcamLabel, `KILLCAM · ELIMINATOR POV · ${hud.deathInfo.killer || 'UNKNOWN'}`);
    setText(killcamSkip, 'Skip replay · K');
    setStyle(replayProgress, 'transform', 'scaleX(0)');
  }
  function finishKillReplay() {
    if (st.screen !== 'replay') return;
    st.killReplaySkipped = true;
    if (ctx.services.player.state.alive === false) open('death');
    else {
      hud.mode = 'play';
      close();
      if (!ctx.input.locked) hud.requestResume();
    }
  }

  // ------------------------------------------------------------------ keyboard / mouse
  const onKey = (e) => {
    if (st.screen === 'none' || ctx.flags.shotMode) return;
    if (st.screen === 'main' && modePopup.classList.contains('on')) {
      const code = e.code;
      if (code === 'Escape') { closeModePopup(); e.preventDefault(); e.stopPropagation(); }
      else if (code === 'ArrowRight' || code === 'ArrowDown') { moveModeSelection(1); e.preventDefault(); e.stopPropagation(); }
      else if (code === 'ArrowLeft' || code === 'ArrowUp') { moveModeSelection(-1); e.preventDefault(); e.stopPropagation(); }
      else if (code === 'Enter' || code === 'Space') { modeCards[modeIndex]?.button.click(); e.preventDefault(); e.stopPropagation(); }
      else if (code === 'Tab') {
        const focusables = Array.from(modeDialog.querySelectorAll('button'));
        const current = focusables.indexOf(document.activeElement);
        const next = (current + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
        focusables[next]?.focus();
        e.preventDefault(); e.stopPropagation();
      }
      return;
    }
    if (st.listening) {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== 'Escape') bindCode(e.code);
      st.listening = null;
      buildRows();
      return;
    }
    const code = e.code;
    if (st.screen === 'entry' || st.screen === 'main' || st.screen === 'pause') {
      const which = st.screen;
      const list = menuItems(which);
      if (code === 'ArrowDown' || code === 'KeyS') { selectItem(which, st.sel[which] + 1); e.preventDefault(); }
      else if (code === 'ArrowUp' || code === 'KeyW') { selectItem(which, st.sel[which] - 1); e.preventDefault(); }
      else if (code === 'Enter' || code === 'Space') { list[st.sel[which]].click(); e.preventDefault(); }
      else if (code === 'Escape' && which === 'pause') { resume(); e.preventDefault(); }
    } else if (st.screen === 'armory') {
      if (code === 'Escape' || code === 'Backspace') { open('main'); e.preventDefault(); }
    } else if (st.screen === 'replay' && code === 'KeyK') {
      finishKillReplay();
      e.preventDefault();
    } else if (st.screen === 'settings') {
      const row = st.rows[st.sel.settings];
      if (code === 'ArrowDown') { selectRow(st.sel.settings + 1); e.preventDefault(); }
      else if (code === 'ArrowUp') { selectRow(st.sel.settings - 1); e.preventDefault(); }
      else if (code === 'ArrowLeft' || code === 'KeyA') { if (row) cycle(row, -1); e.preventDefault(); }
      else if (code === 'ArrowRight' || code === 'KeyD') { if (row) cycle(row, 1); e.preventDefault(); }
      else if (code === 'Enter') { row?.el.click(); e.preventDefault(); }
      else if (code === 'Escape' || code === 'Backspace') { back(); e.preventDefault(); }
      else if (code === 'KeyQ' || code === 'KeyE') {
        const i = TABS.findIndex((t) => t[0] === st.tab);
        const n = TABS[(i + (code === 'KeyE' ? 1 : -1) + TABS.length) % TABS.length][0];
        st.sel.settings = 0;
        openSettings(n, true);
      }
    } else if (st.screen === 'death') {
      if ((code === 'Space' || code === 'Enter') && st.deathAge > 1.2) {
        if (st.gameOver) restart();
        else hud.requestRespawn();
      }
    }
  };
  const onMouse = (e) => {
    if (!st.listening) return;
    e.preventDefault();
    e.stopPropagation();
    bindCode('Mouse' + e.button);
    st.listening = null;
    setTimeout(buildRows, 0);
  };
  function bindCode(code) {
    const a = st.listening.action;
    const old = ctx.input.bindings?.[a] || [];
    ctx.input.bind?.(a, [code, ...old.slice(1).filter((c) => c !== code)]);
  }
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('mousedown', onMouse, true);

  // ------------------------------------------------------------------ menu camera fly-through
  const camA = new THREE.Vector3();
  const camB = new THREE.Vector3();
  const tgtA = new THREE.Vector3();
  const tgtB = new THREE.Vector3();
  const tmpP = new THREE.Vector3();
  const tmpT = new THREE.Vector3();
  const SHOT_LEN = 11;

  function buildShots() {
    const w = ctx.services.world;
    const b = w.bounds || new THREE.Box3(new THREE.Vector3(-40, 0, -40), new THREE.Vector3(40, 20, 40));
    const c = new THREE.Vector3();
    b.getCenter(c);
    const sp = w.spawnPoints?.player?.[0]?.position;
    const focus = sp ? new THREE.Vector3(lerp(c.x, sp.x, 0.35), 0, lerp(c.z, sp.z, 0.35)) : c.clone();
    const gy = (x, z) => {
      try { return w.groundHeight(x, z); } catch { return 0; }
    };
    focus.y = gy(focus.x, focus.z);
    const size = Math.min(b.max.x - b.min.x, b.max.z - b.min.z);
    const shots = [];
    const dir = new THREE.Vector3();
    const clear = (from, to) => {
      dir.subVectors(to, from);
      const len = dir.length();
      if (len < 0.01) return true;
      dir.normalize();
      try {
        const h = w.raycast(from, dir, len);
        return !h || h.distance > len * 0.8;
      } catch { return true; }
    };
    const push = (p0, p1, t0, t1, kind) => {
      if (clear(p0, t0) && clear(p1, t1) && clear(p0, p1)) shots.push({ p0, p1, t0, t1, kind });
    };
    // 1. slow crane around the plaza
    const R = size * 0.34;
    for (let k = 0; k < 4; k++) {
      const a0 = (k * 97 + 25) * DEG;
      const a1 = a0 + 18 * DEG;
      const h = 6 + (k % 2) * 4;
      const p0 = new THREE.Vector3(focus.x + Math.sin(a0) * R, 0, focus.z + Math.cos(a0) * R);
      p0.y = gy(p0.x, p0.z) + h;
      const p1 = new THREE.Vector3(focus.x + Math.sin(a1) * R * 0.92, 0, focus.z + Math.cos(a1) * R * 0.92);
      p1.y = gy(p1.x, p1.z) + h - 1.5;
      push(p0, p1, focus.clone().setY(focus.y + 1.5), focus.clone().setY(focus.y + 2.2), 'crane');
    }
    // 2. low dolly from each AI spawn toward the plaza
    for (const s of (w.spawnPoints?.ai || []).slice(0, 3)) {
      const p0 = s.position.clone();
      p0.y = gy(p0.x, p0.z) + 1.9;
      const to = focus.clone().sub(p0).setY(0).normalize();
      const p1 = p0.clone().addScaledVector(to, 3.5);
      p1.y = gy(p1.x, p1.z) + 2.3;
      push(p0, p1, p0.clone().addScaledVector(to, 20).setY(p0.y + 0.4), p1.clone().addScaledVector(to, 20).setY(p1.y), 'dolly');
    }
    // 3. high establishing shot (always valid)
    const hi = Math.max(b.max.y, 20) + 14;
    shots.push({
      p0: new THREE.Vector3(focus.x - size * 0.45, hi, focus.z + size * 0.5),
      p1: new THREE.Vector3(focus.x - size * 0.3, hi - 4, focus.z + size * 0.42),
      t0: focus.clone(),
      t1: focus.clone().setY(focus.y + 2),
    });
    // interleave: street-level dolly first (most cinematic), then crane, dolly, crane ... establishing last
    const cranes = shots.filter((x) => x.kind === 'crane');
    const dollies = shots.filter((x) => x.kind === 'dolly');
    const rest = shots.filter((x) => !x.kind);
    const out = [];
    for (let i = 0; i < Math.max(cranes.length, dollies.length); i++) {
      if (dollies[i]) out.push(dollies[i]);
      if (cranes[i]) out.push(cranes[i]);
    }
    return out.concat(rest);
  }

  async function prewarmMenuScene() {
    if (ctx.flags.shotMode) return;
    setLoadingMessage('Preparing Vardanek · warming map shaders…');
    const shots = buildShots();
    const cam = ctx.camera;
    const saved = {
      position: cam.position.clone(),
      quaternion: cam.quaternion.clone(),
      fov: cam.fov,
      near: cam.near,
      far: cam.far,
    };
    const views = [];
    for (const shot of shots) {
      views.push([shot.p0, shot.t0]);
      views.push([tmpP.copy(shot.p0).lerp(shot.p1, 0.5).clone(), tmpT.copy(shot.t0).lerp(shot.t1, 0.5).clone()]);
    }
    const mapCenter = ctx.services.world.map?.center || [0, 0];
    const mapTop = ctx.services.world.bounds?.max.y || 40;
    const mapOverview = new THREE.Vector3(mapCenter[0], mapTop + 180, mapCenter[1] + 85);
    const overviewTarget = new THREE.Vector3(mapCenter[0], 0, mapCenter[1]);
    views.unshift([mapOverview, overviewTarget]);
    // Include a close street-level and elevated view so shaders for near/far map surfaces are
    // compiled before the cinematic menu begins moving across the level.
    const playerSpawn = ctx.services.world.spawnPoints?.player?.[0]?.position;
    if (playerSpawn) {
      views.push([new THREE.Vector3(playerSpawn.x + 8, playerSpawn.y + 2.3, playerSpawn.z + 7), playerSpawn.clone().add(new THREE.Vector3(0, 1.3, 0))]);
    }
    const renderer = ctx.renderer;
    const postfx = ctx.services.postfx;
    try {
      const total = views.length;
      for (let i = 0; i < total; i++) {
        const [position, target] = views[i];
        cam.position.copy(position);
        cam.lookAt(target);
        cam.updateMatrixWorld(true);
        await renderer.compileAsync(ctx.scene, cam);
        // Submit one representative frame at each camera. This also fills GPU caches for the
        // actual world/viewmodel/postfx render sequence that the interactive menu will use.
        postfx.render(0, ctx.time.t);
        if (i % 3 === 2) {
          setLoadingMessage(`Preparing Vardanek · warming map shaders ${Math.round(((i + 1) / total) * 100)}%`);
          await new Promise(requestAnimationFrame);
        }
      }
      setLoadingMessage('Map ready · opening deployment menu…');
    } finally {
      cam.position.copy(saved.position);
      cam.quaternion.copy(saved.quaternion);
      cam.fov = saved.fov;
      cam.near = saved.near;
      cam.far = saved.far;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
    }
  }

  function lateUpdate(dt) {
    if (st.screen === 'replay') {
      const elapsed = Math.min(st.replayAge, replayDuration());
      applyKillReplay(elapsed);
      setStyle(replayProgress, 'transform', `scaleX(${clamp01(elapsed / replayDuration()).toFixed(3)})`);
      if (st.replayAge >= replayDuration()) finishKillReplay();
      if (ctx.camera.layers.isEnabled(ctx.layers.VIEWMODEL)) ctx.camera.layers.disable(ctx.layers.VIEWMODEL);
      st.vmDisabled = true;
      return;
    }
    // no floating weapon over the death screen (the death cam is tilted / on the ground)
    if (st.screen === 'death' && st.deathAge > 0.35 && !ctx.shot?.camera) {
      if (ctx.camera.layers.isEnabled(ctx.layers.VIEWMODEL)) {
        ctx.camera.layers.disable(ctx.layers.VIEWMODEL);
        st.vmDisabled = true;
      }
      return;
    }
    if (!st.camActive || !(st.screen === 'main' || st.screen === 'entry' || (st.screen === 'settings' && hud.mode === 'boot'))) {
      if (st.vmDisabled) {
        ctx.camera.layers.enable(ctx.layers.VIEWMODEL);
        st.vmDisabled = false;
      }
      setOpacity(fadeBlack, st.screen === 'main' || st.screen === 'entry' ? 1 : 0);
      if (st.screen !== 'main' && st.screen !== 'entry') setOpacity(fadeBlack, 0);
      return;
    }
    if (!st.shots) st.shots = buildShots();
    const shots = st.shots;
    st.camT += dt;
    const idx = Math.floor(st.camT / SHOT_LEN) % shots.length;
    const lt = (st.camT % SHOT_LEN) / SHOT_LEN;
    const s = shots[idx];
    const e = lt * lt * (3 - 2 * lt) * 0.6 + lt * 0.4; // gentle ease
    tmpP.lerpVectors(s.p0, s.p1, e);
    tmpT.lerpVectors(s.t0, s.t1, e);
    // subtle handheld drift
    const tt = hud.uiTime;
    tmpP.x += Math.sin(tt * 0.37) * 0.06;
    tmpP.y += Math.sin(tt * 0.51 + 1.3) * 0.05;
    const cam = ctx.camera;
    if (cam.parent && cam.parent !== ctx.scene && !cam.parent.isScene) {
      // camera parented under a rig: we only touch it when it is in world space
    }
    cam.position.copy(tmpP);
    cam.lookAt(tmpT);
    const vfov = 2 * Math.atan(Math.tan((62 * DEG) / 2) / (16 / 9)) / DEG;
    if (Math.abs(cam.fov - vfov) > 1e-3) {
      cam.fov = vfov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld(true);
    if (!ctx.shot?.camera && cam.layers.isEnabled(ctx.layers.VIEWMODEL)) {
      cam.layers.disable(ctx.layers.VIEWMODEL);
      st.vmDisabled = true;
    }
    // fade through black between shots (and on first open)
    const edge = Math.min(lt * SHOT_LEN, (1 - lt) * SHOT_LEN);
    let fb = clamp01(1 - edge / 0.7);
    if (st.camT < 1.2) fb = Math.max(fb, 1 - st.camT / 1.2);
    setOpacity(fadeBlack, fb * 0.95);
    void camA; void camB; void tgtA; void tgtB;
  }

  const replayPosition = new THREE.Vector3();
  const replayLocalPosition = new THREE.Vector3();
  const replayTarget = new THREE.Vector3();
  const replayForward = new THREE.Vector3();
  const replaySide = new THREE.Vector3();
  const replayUp = new THREE.Vector3(0, 1, 0);
  function replayDuration() {
    return KILLCAM_DURATION;
  }
  function sampleKillReplayPose(elapsed, outPos = replayPosition, outTarget = replayTarget) {
    const frames = hud.deathInfo.killReplay;
    if (!frames || frames.length < 2) return false;
    const first = frames[0], last = frames[frames.length - 1];
    const progress = clamp01(elapsed / KILLCAM_DURATION);
    const t = first.t + (last.t - first.t) * progress;
    let next = 1;
    while (next < frames.length - 1 && frames[next].t < t) next++;
    const a = frames[next - 1], b = frames[next];
    const f = b.t > a.t ? clamp01((t - a.t) / (b.t - a.t)) : 0;
    const lerpAngle = (x, y, k) => x + Math.atan2(Math.sin(y - x), Math.cos(y - x)) * k;
    const ax = a.cx ?? a.x, ay = a.cy ?? a.y, az = a.cz ?? a.z;
    const bx = b.cx ?? b.x, by = b.cy ?? b.y, bz = b.cz ?? b.z;
    const camX = ax + (bx - ax) * f;
    const camY = ay + (by - ay) * f;
    const camZ = az + (bz - az) * f;
    const yaw = lerpAngle(a.yaw, b.yaw, f), pitch = a.pitch + (b.pitch - a.pitch) * f;
    replayForward.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    replaySide.set(Math.cos(yaw), 0, -Math.sin(yaw));
    outPos.set(camX, camY, camZ)
      .addScaledVector(replayForward, -0.12)
      .addScaledVector(replaySide, 0.08)
      .addScaledVector(replayUp, 0.34);
    outTarget.copy(outPos).addScaledVector(replayForward, 18);
    return true;
  }
  function applyKillReplay(elapsed) {
    if (!sampleKillReplayPose(elapsed, replayPosition, replayTarget)) return;
    const cam = ctx.camera;
    if (cam.parent) {
      cam.parent.updateWorldMatrix(true, false);
      cam.position.copy(cam.parent.worldToLocal(replayLocalPosition.copy(replayPosition)));
    } else cam.position.copy(replayPosition);
    cam.lookAt(replayTarget);
    cam.layers.disable(ctx.layers.VIEWMODEL);
    st.vmDisabled = true;
    cam.updateMatrixWorld(true);
    setText(killcamLabel, `KILLCAM · ELIMINATOR POV · ${hud.deathInfo.killer}`);
    setText(killcamSkip, 'Skip replay · K');
  }
  function getKillReplayCameraPosition(out = replayPosition) {
    if (st.screen !== 'replay' || st.killReplaySkipped) return null;
    const frames = hud.deathInfo.killReplay;
    if (!frames || frames.length < 2) return null;
    const elapsed = Math.max(0, Math.min(replayDuration(), st.replayAge));
    sampleKillReplayPose(elapsed, out, replayTarget);
    return out;
  }

  // ------------------------------------------------------------------ per-frame UI
  function update(dt) {
    st.screenAge += dt;
    setOpacity(grain, st.screen === 'none' || st.screen === 'resume' ? 0 : 0.035);
    if (st.screen === 'replay') {
      st.replayAge += dt;
      const progress = clamp01(st.replayAge / replayDuration());
      setStyle(replayProgress, 'transform', `scaleX(${progress.toFixed(3)})`);
      if (st.replayAge >= replayDuration()) finishKillReplay();
    } else if (st.screen === 'death') {
      st.deathAge += dt;
      const t = st.deathAge;
      setOpacity(death, clamp01(t / 0.6));
      const hIn = easeOutCubic(clamp01((t - 0.2) / 0.9));
      setStyle(kiaH, 'letterSpacing', `${(0.12 + (1 - hIn) * 0.25).toFixed(3)}em`);
      setOpacity(kiaH, hIn);
      setOpacity(killer, easeOutCubic(clamp01((t - 0.6) / 0.5)));
      setOpacity(dStats, easeOutCubic(clamp01((t - 0.8) / 0.5)));
      setOpacity(redeploy, easeOutCubic(clamp01((t - 1.0) / 0.5)));
      const r = hud.respawnStatus();
      if (st.gameOver) {
        setHTML(rdT, 'Operation over');
        setText(rdLives, '');
      } else if (r.progress != null) {
        setHTML(rdT, `Redeploying <span style="color:var(--accent)">${Math.ceil(r.remaining)}</span>`);
        setStyle(rdFill, 'transform', `scaleX(${clamp01(r.progress).toFixed(3)})`);
        setText(rdLives, r.lives != null ? `${r.lives} reinforcement${r.lives === 1 ? '' : 's'} remaining` : '');
      } else {
        setHTML(rdT, `Press <span class="od-key">SPACE</span> to redeploy`);
        setStyle(rdFill, 'transform', `scaleX(${clamp01(t / 3).toFixed(3)})`);
        setText(rdLives, r.lives != null ? `${r.lives} reinforcement${r.lives === 1 ? '' : 's'} remaining` : '');
      }
      if (hud.isGameOver() !== st.gameOver) refreshDeath();
    } else if (st.screen === 'main') {
      if (st.screenAge < 0.1 || (hud.minimap.map.ready && !st.cardDrawn)) {
        drawCardMap();
        st.cardDrawn = hud.minimap.map.ready;
      }
    }
  }

  function dispose() {
    ctx.events.off('gamemode:mode', onGameMode);
    ctx.events.off('network:send', onNetworkSend);
    st.multiplayerSocket?.close();
    for (const [name, fn] of profileListeners) ctx.events.off(name, fn);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('mousedown', onMouse, true);
    if (st.vmDisabled) ctx.camera.layers.enable(ctx.layers.VIEWMODEL);
    layer.remove();
  }

  return {
    open,
    close,
    back,
    update,
    lateUpdate,
    dispose,
    openSettings,
    openLoading,
    setLoadingMessage,
    prewarmMenuScene,
    refreshDeath,
    refreshPauseStats,
    getKillReplayCameraPosition,
    get screen() { return st.screen; },
    get camActive() { return st.camActive; },
    onMapBaked() { st.cardDrawn = false; },
  };
}

function makeGrain(rng) {
  const N = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d');
  const img = g.createImageData(N, N);
  for (let i = 0; i < N * N; i++) {
    const v = Math.floor(rng.next() * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const url = cv.toDataURL('image/png');
  cv.width = cv.height = 1;
  return url;
}

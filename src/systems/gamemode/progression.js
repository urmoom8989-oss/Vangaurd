const STORAGE_KEY = 'vangaurd.progression.experimental.v1';
const XP_PER_KILL = 100;
const WEAPON_LEVELS = [0, 5, 15, 35, 70];
const RANKS = [
  { name: 'Recruit', xp: 0 },
  { name: 'Rifleman', xp: 500 },
  { name: 'Veteran', xp: 1500 },
  { name: 'Operative', xp: 3500 },
  { name: 'Vanguard', xp: 7000 },
];
const GRENADE_TYPES = ['frag', 'smoke', 'flash', 'proximity'];
const ATTACHMENT_SLOTS = {
  optic: {
    label: 'Optic',
    options: [
      { id: 'none', name: 'No optic', unlockKills: 0, effect: 'Default iron sights.' },
      { id: 'reflex', name: 'Reflex sight', unlockKills: 5, effect: 'Stable close-range sight picture.' },
      { id: 'scope', name: 'Combat scope', unlockKills: 18, effect: 'Improved ADS precision and magnification.' },
      { id: 'night', name: 'Night optic', unlockKills: 35, effect: 'Sharper target acquisition in dim light.' },
    ],
  },
  grip: {
    label: 'Handle',
    options: [
      { id: 'none', name: 'Standard grip', unlockKills: 0, effect: 'Default handling.' },
      { id: 'tactical', name: 'Tactical grip', unlockKills: 12, effect: 'Better recoil control and steadiness.' },
      { id: 'heavy', name: 'Heavy handle', unlockKills: 28, effect: 'Strong recoil mitigation and control.' },
    ],
  },
  suppressor: {
    label: 'Suppressor',
    options: [
      { id: 'none', name: 'No suppressor', unlockKills: 0, effect: 'Standard muzzle report.' },
      { id: 'muzzle', name: 'Muzzle can', unlockKills: 10, effect: 'Reduced muzzle flash and noise.' },
      { id: 'heavy', name: 'Heavy suppressor', unlockKills: 26, effect: 'Lower noise and softer muzzle signature.' },
    ],
  },
  barrel: {
    label: 'Barrel',
    options: [
      { id: 'none', name: 'Standard barrel', unlockKills: 0, effect: 'Balanced handling.' },
      { id: 'extended', name: 'Extended barrel', unlockKills: 16, effect: 'Smoother recoil path and longer sight line.' },
      { id: 'precision', name: 'Precision barrel', unlockKills: 32, effect: 'Tighter weapon control and steadier shots.' },
    ],
  },
};

function freshProfile() {
  return { version: 1, xp: 0, kills: 0, headshots: 0, deaths: 0, weapons: {}, grenadeType: 'frag' };
}

function loadProfile() {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || 'null');
    if (!saved || saved.version !== 1) return freshProfile();
    const profile = { ...freshProfile(), ...saved, weapons: saved.weapons && typeof saved.weapons === 'object' ? saved.weapons : {} };
    if (!GRENADE_TYPES.includes(profile.grenadeType)) profile.grenadeType = 'frag';
    for (const weaponId of ['rifle', 'pistol']) {
      profile.weapons[weaponId] ||= { kills: 0, attachments: {} };
      profile.weapons[weaponId].attachments ||= {};
      for (const slot of Object.keys(ATTACHMENT_SLOTS)) {
        const current = profile.weapons[weaponId].attachments[slot];
        const valid = ATTACHMENT_SLOTS[slot].options.some((opt) => opt.id === current);
        if (!valid) profile.weapons[weaponId].attachments[slot] = 'none';
      }
    }
    return profile;
  } catch {
    return freshProfile();
  }
}

let profile = loadProfile();

function save() {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(profile)); } catch { /* storage can be disabled */ }
}

export function getProgression() {
  const rankIndex = RANKS.reduce((index, rank, i) => profile.xp >= rank.xp ? i : index, 0);
  const rank = RANKS[rankIndex];
  const nextRank = RANKS[rankIndex + 1] || null;
  return {
    ...profile,
    weapons: Object.fromEntries(Object.entries(profile.weapons).map(([id, value]) => [id, { ...value }])),
    rank: rank.name,
    rankIndex: rankIndex + 1,
    nextRank: nextRank?.name || null,
    nextRankXp: nextRank?.xp ?? null,
    rankProgress: nextRank ? (profile.xp - rank.xp) / (nextRank.xp - rank.xp) : 1,
  };
}

export function recordProgressionKill(weaponId, headshot = false) {
  profile.xp += XP_PER_KILL + (headshot ? 50 : 0);
  profile.kills++;
  if (headshot) profile.headshots++;
  const id = ['rifle', 'pistol'].includes(weaponId) ? weaponId : 'rifle';
  profile.weapons[id] ||= { kills: 0 };
  profile.weapons[id].kills++;
  save();
  return getProgression();
}

export function recordProgressionDeath() {
  profile.deaths++;
  save();
}

export function getWeaponProgression(id) {
  const kills = profile.weapons[id]?.kills || 0;
  let level = 1;
  for (let i = 1; i < WEAPON_LEVELS.length; i++) if (kills >= WEAPON_LEVELS[i]) level = i + 1;
  const unlocks = [];
  for (const [slot, config] of Object.entries(ATTACHMENT_SLOTS)) {
    for (const option of config.options) {
      unlocks.push({
        id: `${slot}:${option.id}`,
        slot,
        option: option.id,
        name: option.name,
        unlockKills: option.unlockKills,
        unlocked: kills >= option.unlockKills,
        effect: option.effect,
      });
    }
  }
  const selected = getWeaponLoadout(id);
  return {
    kills,
    level,
    nextUnlockKills: WEAPON_LEVELS[level] ?? null,
    attachments: unlocks,
    loadout: selected,
  };
}

export function getWeaponLoadout(id) {
  const current = profile.weapons[id] || { attachments: {} };
  const out = {};
  for (const slot of Object.keys(ATTACHMENT_SLOTS)) {
    const selected = current.attachments?.[slot] || 'none';
    const valid = ATTACHMENT_SLOTS[slot].options.some((option) => option.id === selected);
    out[slot] = valid ? selected : 'none';
  }
  return out;
}

export function setWeaponAttachment(weaponId, slot, attachmentId) {
  if (!['rifle', 'pistol'].includes(weaponId)) return getWeaponLoadout(weaponId);
  if (!ATTACHMENT_SLOTS[slot]) return getWeaponLoadout(weaponId);
  const options = ATTACHMENT_SLOTS[slot].options;
  const choice = options.some((option) => option.id === attachmentId) ? attachmentId : 'none';
  const weapon = profile.weapons[weaponId] || { kills: 0, attachments: {} };
  weapon.attachments ||= {};
  const kills = weapon.kills || 0;
  const selected = options.find((option) => option.id === choice);
  if (!selected || kills < selected.unlockKills) {
    weapon.attachments[slot] = 'none';
  } else {
    weapon.attachments[slot] = choice;
  }
  profile.weapons[weaponId] = weapon;
  save();
  return getWeaponLoadout(weaponId);
}

export function getGrenadeTypes() { return GRENADE_TYPES.slice(); }
export function getSelectedGrenade() { return profile.grenadeType; }
export function setSelectedGrenade(type) {
  if (!GRENADE_TYPES.includes(type)) return profile.grenadeType;
  profile.grenadeType = type;
  save();
  return type;
}
export function getAttachmentSlots() {
  return Object.fromEntries(Object.entries(ATTACHMENT_SLOTS).map(([slot, config]) => [slot, { ...config, options: config.options.map((option) => ({ ...option })) }]));
}

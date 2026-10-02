const STORAGE_KEY = 'vangaurd.account.username.v1';
const DEFAULT_USERNAME = 'Vigil-1';

export function getPlayerName() {
  try {
    const name = globalThis.localStorage?.getItem(STORAGE_KEY)?.trim();
    return name || DEFAULT_USERNAME;
  } catch {
    return DEFAULT_USERNAME;
  }
}

export function setPlayerName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 20);
  if (!name) return { ok: false, name: getPlayerName(), reason: 'Enter a username first.' };
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, name);
  } catch {
    return { ok: false, name: getPlayerName(), reason: 'Could not save the username on this device.' };
  }
  return { ok: true, name };
}

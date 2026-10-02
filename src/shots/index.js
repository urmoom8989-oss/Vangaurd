/**
 * Shot preset aggregator (core, FROZEN). Do not edit — add presets in src/shots/<your-system>.js.
 *
 * Every *.js file in this folder (except this one) is auto-imported via import.meta.glob. Each file
 * default-exports an object of presets keyed by name:
 *
 *   export default {
 *     'weapons-ads-rifle': { description: '...', player: {...}, weapon: {...}, warmup: 60 },
 *   };
 *
 * Names must be globally unique — prefix them with your system name. A preset can also be addressed
 * as "<file>:<name>" (e.g. "core:smoke"). A broken shot file is reported and skipped; it can never
 * break other files' presets.
 */
const files = import.meta.glob(['./*.js', '!./index.js']);

let _cache = null;

export async function loadShotPresets() {
  if (_cache) return _cache;
  const presets = new Map(); // name -> {name, file, preset}
  const errors = [];
  const duplicates = [];
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  await Promise.all(entries.map(async ([path, loader]) => {
    const file = path.replace(/^\.\//, '').replace(/\.js$/, '');
    try {
      const mod = await loader();
      const obj = mod.default || mod.presets || {};
      return { file, obj };
    } catch (err) {
      errors.push({ file, error: String(err?.message || err) });
      console.error(`[shots] failed to load src/shots/${file}.js:`, err);
      return null;
    }
  })).then((loaded) => {
    for (const l of loaded) {
      if (!l) continue;
      for (const [name, preset] of Object.entries(l.obj)) {
        if (!preset || typeof preset !== 'object') continue;
        const rec = { name, file: l.file, preset };
        presets.set(`${l.file}:${name}`, rec);
        if (presets.has(name) && presets.get(name).file !== l.file) {
          duplicates.push({ name, files: [presets.get(name).file, l.file] });
          console.warn(`[shots] duplicate preset name "${name}" in ${presets.get(name).file}.js and ${l.file}.js — use "<file>:<name>"`);
          continue;
        }
        presets.set(name, rec);
      }
    }
  });
  _cache = { presets, errors, duplicates };
  return _cache;
}

export async function findShotPreset(name) {
  const { presets } = await loadShotPresets();
  return presets.get(name) || null;
}

export async function listShotPresets() {
  const { presets, errors, duplicates } = await loadShotPresets();
  const list = [];
  for (const [key, rec] of presets) {
    if (key.includes(':')) continue;
    list.push({
      name: rec.name,
      file: `src/shots/${rec.file}.js`,
      description: rec.preset.description || '',
      only: rec.preset.only || null,
      resolution: rec.preset.resolution || null,
    });
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { presets: list, errors, duplicates };
}

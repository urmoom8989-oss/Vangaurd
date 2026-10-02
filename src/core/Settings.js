/**
 * Settings — user-tunable options with dotted-path access. Persisted to localStorage in normal play;
 * in shot mode it is ALWAYS defaults + preset.settings (never storage) for determinism.
 *
 *   settings.get('graphics.quality')           -> 'high'
 *   settings.set('audio.master', 0.5)          -> emits 'settings:changed' {path, value}
 *   settings.data.controls.sensitivity         -> direct read (hot paths)
 *
 * Extension point: systems may add their own namespace at init with settings.registerDefaults(
 * 'weapons', {...}). Keys under a system's namespace belong to that system.
 */
export const DEFAULT_SETTINGS = {
  graphics: {
    quality: 'low',           // performance-first default; 'medium' | 'high' | 'ultra' add effects
    fov: 90,                  // HORIZONTAL fov in degrees at 16:9 (CoD-style). Player converts to vertical.
    renderScale: 0.35,        // performance-first internal resolution for older integrated GPUs
    maxPixelRatio: 1.0,        // avoid supersampling above native display resolution
    shadows: false,
    shadowMapSize: 2048,
    toneMapping: 'agx',       // 'aces' | 'agx' | 'neutral' | 'none' (postfx may take over tonemapping)
    exposure: 1.0,
    motionBlur: false,
    filmGrain: false,
    showFps: false,
    fpsCap: 0,                // 0 = uncapped (vsync)
  },
  controls: {
    sensitivity: 3.0,         // Source/CoD-like: degrees per mouse count = 0.022 * sensitivity
    adsSensitivity: 1.0,      // multiplier while aiming (scaled further by zoom)
    invertY: false,
    toggleAds: false,
    toggleCrouch: true,
  },
  audio: {
    master: 0.9,
    sfx: 1.0,
    music: 0.6,
    voice: 1.0,
  },
  gameplay: {
    difficulty: 'regular',
    crosshair: true,
    hitmarkers: true,
  },
};

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

function deepMerge(target, src) {
  if (!src || typeof src !== 'object') return target;
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

const STORAGE_KEY = 'opus-of-duty.settings.v1';

export class Settings {
  constructor(events, { persist = true, overrides = null } = {}) {
    this.events = events;
    this.persist = persist;
    this.data = deepClone(DEFAULT_SETTINGS);
    if (persist) {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) deepMerge(this.data, JSON.parse(raw));
      } catch { /* storage unavailable */ }
    }
    if (overrides) deepMerge(this.data, overrides);
  }

  get(path, fallback) {
    let o = this.data;
    for (const p of path.split('.')) {
      if (o == null) return fallback;
      o = o[p];
    }
    return o === undefined ? fallback : o;
  }

  set(path, value) {
    const parts = path.split('.');
    let o = this.data;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] ??= {};
    o[parts[parts.length - 1]] = value;
    this.save();
    this.events?.emit('settings:changed', { path, value });
  }

  /** Add defaults for a namespace without overwriting user values. */
  registerDefaults(namespace, defaults) {
    const existing = this.data[namespace] || {};
    this.data[namespace] = deepMerge(deepClone(defaults), existing);
  }

  save() {
    if (!this.persist) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data)); } catch { /* ignore */ }
  }
}

export { deepMerge };

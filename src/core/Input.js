/**
 * Input — keyboard/mouse with a rebindable ACTION map, pointer lock, and a scripted-injection API
 * used by shot presets and automated tests.
 *
 * Query API (call from update(); edge flags are valid for the whole render frame and are cleared
 * after lateUpdate):
 *   input.isDown('fire')            level: held this frame
 *   input.pressed('reload')         edge: went down this frame
 *   input.released('ads')           edge: went up this frame
 *   input.getMove(out)              {x: strafe right+, y: forward+} normalized to length <= 1
 *   input.look                      {dx, dy} raw mouse counts accumulated this frame (+dx = right, +dy = down)
 *   input.locked                    pointer lock state
 *
 * Bindings: codes are KeyboardEvent.code values, 'Mouse0'..'Mouse4', 'WheelUp', 'WheelDown'.
 *   input.bind('melee', ['KeyV', 'Mouse4']);   input.resetBindings();
 *
 * Injection (shots/tests/demos). In deterministic shot mode physical devices are ignored:
 *   input.inject('fire', true|false); input.injectLook(dx, dy); input.injectMove(x, y) (null to clear)
 */
export const ACTIONS = [
  'moveForward', 'moveBack', 'moveLeft', 'moveRight',
  'sprint', 'crouch', 'prone', 'jump',
  'fire', 'ads', 'reload', 'melee', 'grenade', 'tactical', 'interact',
  'swapWeapon', 'weapon1', 'weapon2', 'weaponNext', 'weaponPrev',
  'leanLeft', 'leanRight', 'inspect', 'scoreboard', 'pause',
];

export const DEFAULT_BINDINGS = {
  moveForward: ['KeyW', 'ArrowUp'],
  moveBack: ['KeyS', 'ArrowDown'],
  moveLeft: ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft'],
  crouch: ['KeyC'], // Ctrl is avoided on purpose: Ctrl+W closes the browser tab.
  prone: ['KeyZ'],
  jump: ['Space'],
  fire: ['Mouse0'],
  ads: ['Mouse2'],
  reload: ['KeyR'],
  melee: ['KeyV', 'Mouse4'],
  grenade: ['KeyG'],
  tactical: ['KeyT'],
  interact: ['KeyF'],
  swapWeapon: ['Digit3'],
  weapon1: ['Digit1'],
  weapon2: ['Digit2'],
  weaponNext: ['WheelDown'],
  weaponPrev: ['WheelUp'],
  leanLeft: ['KeyQ'],
  leanRight: ['KeyE'],
  inspect: ['KeyI'],
  scoreboard: ['Tab'],
  pause: ['KeyP'],
};

const PREVENT_DEFAULT_CODES = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyF', 'KeyG', 'KeyT']);

export class Input {
  constructor({ element, events, settings, deterministic = false }) {
    this.element = element;
    this.events = events;
    this.settings = settings;
    this.deterministic = deterministic;
    this.locked = false;
    this.enabled = true;
    this.look = { dx: 0, dy: 0 };
    this._lookHandler = null;

    this.bindings = {};
    this._codeToActions = new Map();
    const stored = settings?.get('controls.bindings');
    this._applyBindings({ ...DEFAULT_BINDINGS, ...(stored && !deterministic ? stored : {}) });

    this._codesDown = new Set();
    this._actionDown = Object.create(null); // physical hold count
    this._injectedDown = Object.create(null);
    this._pressed = Object.create(null);
    this._released = Object.create(null);
    this._injectedMove = null;
    for (const a of ACTIONS) {
      this._actionDown[a] = 0;
      this._injectedDown[a] = false;
      this._pressed[a] = false;
      this._released[a] = false;
    }

    this._listeners = [];
    if (element && typeof window !== 'undefined') this._attach();
  }

  // ---------------------------------------------------------------- bindings
  _applyBindings(map) {
    this.bindings = {};
    this._codeToActions.clear();
    for (const a of ACTIONS) {
      const codes = map[a] || [];
      this.bindings[a] = codes.slice();
      for (const c of codes) {
        if (!this._codeToActions.has(c)) this._codeToActions.set(c, []);
        this._codeToActions.get(c).push(a);
      }
    }
  }

  bind(action, codes) {
    if (!ACTIONS.includes(action)) {
      console.warn(`[input] unknown action "${action}"`);
      return;
    }
    this.releaseAll();
    const next = { ...this.bindings, [action]: codes.slice() };
    this._applyBindings(next);
    const custom = {};
    for (const a of ACTIONS) if (JSON.stringify(next[a]) !== JSON.stringify(DEFAULT_BINDINGS[a])) custom[a] = next[a];
    this.settings?.set('controls.bindings', custom);
    this.events?.emit('input:rebind', { action, codes });
  }

  resetBindings() {
    this.releaseAll();
    this._applyBindings(DEFAULT_BINDINGS);
    this.settings?.set('controls.bindings', {});
  }

  // ---------------------------------------------------------------- queries
  isDown(action) {
    return this._actionDown[action] > 0 || this._injectedDown[action] === true;
  }
  pressed(action) {
    return this._pressed[action] === true;
  }
  released(action) {
    return this._released[action] === true;
  }

  /** Install an immediate raw-look consumer; scripted look input remains frame-queued. */
  setLookHandler(handler) {
    this._lookHandler = typeof handler === 'function' ? handler : null;
  }

  getMove(out = { x: 0, y: 0 }) {
    if (this._injectedMove) {
      out.x = this._injectedMove.x;
      out.y = this._injectedMove.y;
    } else {
      out.x = (this.isDown('moveRight') ? 1 : 0) - (this.isDown('moveLeft') ? 1 : 0);
      out.y = (this.isDown('moveForward') ? 1 : 0) - (this.isDown('moveBack') ? 1 : 0);
    }
    const l = Math.hypot(out.x, out.y);
    if (l > 1) {
      out.x /= l;
      out.y /= l;
    }
    return out;
  }

  // ---------------------------------------------------------------- injection
  inject(action, down) {
    const was = this.isDown(action);
    this._injectedDown[action] = !!down;
    const now = this.isDown(action);
    if (!was && now) this._pressed[action] = true;
    if (was && !now) this._released[action] = true;
  }
  injectLook(dx, dy) {
    this.look.dx += dx;
    this.look.dy += dy;
  }
  injectMove(x, y) {
    this._injectedMove = x == null ? null : { x, y };
  }

  // ---------------------------------------------------------------- pointer lock
  lock() {
    if (this.deterministic || !this.element) return;
    const el = this.element;
    try {
      const p = el.requestPointerLock?.({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => { try { el.requestPointerLock(); } catch { /* ignore */ } });
    } catch {
      try { el.requestPointerLock(); } catch { /* ignore */ }
    }
  }
  unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Called by the loop after lateUpdate every render frame. */
  endFrame() {
    this.look.dx = 0;
    this.look.dy = 0;
    for (let i = 0; i < ACTIONS.length; i++) {
      const a = ACTIONS[i];
      this._pressed[a] = false;
      this._released[a] = false;
    }
  }

  // ---------------------------------------------------------------- DOM
  _codeDown(code) {
    if (this._codesDown.has(code)) return;
    this._codesDown.add(code);
    const acts = this._codeToActions.get(code);
    if (!acts) return;
    for (const a of acts) {
      if (!this.isDown(a)) this._pressed[a] = true;
      this._actionDown[a]++;
    }
  }
  _codeUp(code) {
    if (!this._codesDown.has(code)) return;
    this._codesDown.delete(code);
    const acts = this._codeToActions.get(code);
    if (!acts) return;
    for (const a of acts) {
      this._actionDown[a] = Math.max(0, this._actionDown[a] - 1);
      if (!this.isDown(a)) this._released[a] = true;
    }
  }
  _tap(code) {
    const acts = this._codeToActions.get(code);
    if (!acts) return;
    for (const a of acts) {
      this._pressed[a] = true;
      this._released[a] = true;
    }
  }
  releaseAll() {
    for (const c of Array.from(this._codesDown)) this._codeUp(c);
  }

  _on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._listeners.push([target, type, fn, opts]);
  }

  _attach() {
    const el = this.element;
    const live = () => this.enabled && !this.deterministic;
    const isTyping = (e) => {
      const t = e.target;
      return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    };

    this._on(window, 'keydown', (e) => {
      if (!live() || isTyping(e)) return;
      if (this.locked && PREVENT_DEFAULT_CODES.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this._codeDown(e.code);
    });
    this._on(window, 'keyup', (e) => {
      if (!live()) return;
      this._codeUp(e.code);
    });
    this._on(el, 'mousedown', (e) => {
      if (!live() || !this.locked) return; // the click that acquires pointer lock is not a game input
      this._codeDown('Mouse' + e.button);
    });
    this._on(window, 'mouseup', (e) => {
      if (!live()) return;
      this._codeUp('Mouse' + e.button);
    });
    this._on(window, 'mousemove', (e) => {
      if (!live() || !this.locked) return;
      const dx = e.movementX || 0;
      const dy = e.movementY || 0;
      if (this._lookHandler) this._lookHandler(dx, dy);
      else {
        this.look.dx += dx;
        this.look.dy += dy;
      }
    });
    this._on(window, 'wheel', (e) => {
      if (!live() || !this.locked) return;
      this._tap(e.deltaY > 0 ? 'WheelDown' : 'WheelUp');
    }, { passive: true });
    this._on(el, 'contextmenu', (e) => e.preventDefault());
    this._on(window, 'blur', () => this.releaseAll());
    this._on(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === el;
      if (!this.locked) this.releaseAll();
      this.events?.emit('input:lock', { locked: this.locked });
    });
  }

  dispose() {
    for (const [t, type, fn, opts] of this._listeners) t.removeEventListener(type, fn, opts);
    this._listeners.length = 0;
  }
}

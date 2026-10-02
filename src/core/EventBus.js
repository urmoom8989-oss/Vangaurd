/**
 * EventBus — tiny synchronous pub/sub. Listener exceptions are isolated and logged so a broken
 * subscriber in one system can never break the emitter (another system).
 *
 *   const off = events.on('weapon:fired', (e) => {...});   off();
 *   events.once('player:died', fn);
 *   events.emit('combat:hit', payload);
 *
 * Payload objects may be pooled/reused by emitters: copy what you need, do not retain them.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Array<{fn: Function, once: boolean}>>} */
    this._map = new Map();
    this._warned = new Set();
  }

  on(type, fn) {
    let list = this._map.get(type);
    if (!list) this._map.set(type, (list = []));
    list.push({ fn, once: false });
    return () => this.off(type, fn);
  }

  once(type, fn) {
    let list = this._map.get(type);
    if (!list) this._map.set(type, (list = []));
    list.push({ fn, once: true });
    return () => this.off(type, fn);
  }

  off(type, fn) {
    const list = this._map.get(type);
    if (!list) return;
    const i = list.findIndex((l) => l.fn === fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(type, payload) {
    const list = this._map.get(type);
    if (!list || list.length === 0) return;
    // Iterate over a snapshot only when a once-listener exists (avoid per-emit allocation otherwise).
    let hasOnce = false;
    for (let i = 0; i < list.length; i++) if (list[i].once) { hasOnce = true; break; }
    const arr = hasOnce ? list.slice() : list;
    for (let i = 0; i < arr.length; i++) {
      const l = arr[i];
      if (l.once) this.off(type, l.fn);
      try {
        l.fn(payload);
      } catch (err) {
        const key = type + '|' + (l.fn.name || i);
        if (!this._warned.has(key)) {
          this._warned.add(key);
          console.error(`[events] listener for "${type}" threw:`, err);
        }
      }
    }
  }

  clear(type) {
    if (type) this._map.delete(type);
    else this._map.clear();
  }
}

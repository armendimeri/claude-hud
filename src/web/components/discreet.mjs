const KEY = 'hud.discreet';

/**
 * The tab-scoped "discreet display" preference (local screen privacy). One controller serves the whole page, so the
 * dashboard, the cockpit, the inspector, speech and notifications read the same flag. It lives in sessionStorage
 * because it is meant to follow this tab through route changes and a reload, never to other tabs or devices.
 * `storage` can be replaced by tests; any storage failure just leaves the flag in memory.
 */
export function createDiscreet({ storage } = {}) {
  let store = storage;
  if (store === undefined) { try { store = globalThis.sessionStorage; } catch { store = null; } }
  let on = false;
  try { on = store?.getItem(KEY) === '1'; } catch { on = false; }
  const listeners = new Set();
  return {
    get: () => on,
    set(next) {
      next = !!next;
      if (next === on) return;
      on = next;
      try { if (on) store?.setItem(KEY, '1'); else store?.removeItem(KEY); } catch { /* memory only */ }
      for (const listener of [...listeners]) listener(on);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

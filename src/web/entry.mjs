import { createAwayRefresh } from './data/away.mjs';
import { createHudStore } from './data/store.mjs';
import { createBrowserTransport } from './data/transport.mjs';
import { hudClient } from './legacy-hud.mjs';

// The page owns the stream. View and project changes only affect the renderer.
function pageMain(H, store, transport) {
  const query = new URLSearchParams(location.search), kiosk = query.has('kiosk');
  document.documentElement.classList.toggle('kiosk', kiosk);
  if (kiosk) {
    let lock = null, acquiring = false;
    async function keepAwake() {
      if (!navigator.wakeLock || document.hidden || acquiring || (lock && !lock.released)) return;
      acquiring = true;
      try { lock = await navigator.wakeLock.request('screen'); } catch {}
      finally { acquiring = false; }
    }
    document.addEventListener('visibilitychange', keepAwake);
    void keepAwake();
  }
  const hud = H.createHud(document.body, {
    reconnect: store.reconnect,
    kiosk, project: query.get('project'),
    onProject(name) {
      const url = new URL(location.href);
      if (name) url.searchParams.set('project', name);
      else url.searchParams.delete('project');
      history.replaceState(history.state, '', url);
    },
  });
  H.boot(hud);
  const away = createAwayRefresh({ transport, isHidden: () => document.hidden, onSummary: hud.showAway });
  document.addEventListener('visibilitychange', away.visibilityChanged);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hud.clearProject(); });

  function showConnection() {
    const { status, lastAt } = store.getConnection();
    hud.setConn(status, { lastAt });
  }
  const unsubscribe = store.subscribe(update => {
    if (update.type === 'connection') {
      showConnection();
      if (update.resumedSince !== undefined) void away.resumed(update.resumedSince);
    } else if (update.type === 'feed') {
      hud.feed(update.line, store.getSnapshot().feed);
    } else {
      hud.render(store.getSnapshot());
    }
  });
  showConnection();
  store.reconnect();
  addEventListener('pagehide', event => {
    if (event.persisted) return;
    unsubscribe();
    away.close();
    store.close();
  });
}

const transport = createBrowserTransport();
const store = createHudStore({ transport });
const H = hudClient({ now: store.getServerTime });
// Preserve the global client binding used by the browser smoke checks.
Object.defineProperty(globalThis, 'H', { value: H });
pageMain(H, store, transport);

import { createAwayRefresh } from './data/away.mjs';
import { createHudStore } from './data/store.mjs';
import { createBrowserTransport } from './data/transport.mjs';
import { hudClient } from './legacy-hud.mjs';
import { createViewRegistry } from './view-registry.mjs';

const CONNECTION_LABELS = {
  connecting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting', down: 'Down',
};

function pageMain(H, store, transport) {
  const query = new URLSearchParams(location.search);
  const kiosk = query.has('kiosk');
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

  let project = query.get('project') || null;
  const projectListeners = new Set();
  let clearProject = () => actions.setProject(null);
  let cleanupView = null;
  const views = createViewRegistry(mountDashboard);
  const requested = views.get(kiosk ? 'network' : query.get('view'));
  const dashboard = views.get('cards');
  const ui = { h: H.h, statusTag: H.statusTag, feedTags: H.FEED_TAGS, connectionLabels: CONNECTION_LABELS };
  const actions = {
    getProject: () => project,
    setProject(name) {
      if (name === project) return;
      project = name;
      const url = new URL(location.href);
      if (name) url.searchParams.set('project', name);
      else url.searchParams.delete('project');
      history.replaceState(history.state, '', url);
      for (const notify of projectListeners) notify();
    },
    subscribeProject(notify) {
      projectListeners.add(notify);
      return () => projectListeners.delete(notify);
    },
    dashboardUrl() {
      const url = new URL(location.href);
      url.searchParams.delete('view');
      return url.href;
    },
    leaveView() {
      history.replaceState(history.state, '', actions.dashboardUrl());
      mount(dashboard);
      stylesheet?.remove();
      window.scrollTo(0, 0);
      document.querySelector('.p-sess .seg [aria-pressed="true"]')?.focus({ preventScroll: true });
    },
  };

  function mountDashboard(element) {
    const hud = H.createHud(element, {
      reconnect: store.reconnect, kiosk, project: actions.getProject(), onProject: actions.setProject,
    });
    clearProject = hud.clearProject;
    H.boot(hud);
    const away = createAwayRefresh({ transport, isHidden: () => document.hidden, onSummary: hud.showAway });
    document.addEventListener('visibilitychange', away.visibilityChanged);

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
      } else if (hud.state !== store.getSnapshot()) {
        hud.render(store.getSnapshot());
      }
    });
    showConnection();
    hud.render(store.getSnapshot());
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', away.visibilityChanged);
      away.close();
    };
  }

  function mount(view) {
    cleanupView?.();
    cleanupView = view.mount(document.body, { store, actions, ui });
  }

  const pageView = requested?.outlet === 'page' ? requested : null;
  const stylesheet = pageView?.stylesheet && H.h('link', { rel: 'stylesheet', href: pageView.stylesheet });
  if (stylesheet) document.head.append(stylesheet);
  const label = H.h('span', { class: 'label' });
  const stream = H.h('div', { class: 'stream', role: 'status' }, H.h('span', { class: 'stream-dot' }), label);
  const retry = H.h('button', { type: 'button', text: 'Retry now', hidden: true });
  const waiting = H.h('div', { class: 'top', style: 'margin:0; justify-content:center; gap:12px' }, stream, retry);
  document.body.append(waiting);
  retry.onclick = store.reconnect;

  function showWaiting() {
    const status = store.getConnection().status;
    // EventSource can open before its first full frame.
    const waitingStatus = status === 'live' ? 'connecting' : status;
    stream.dataset.s = waitingStatus;
    label.textContent = CONNECTION_LABELS[waitingStatus];
    retry.hidden = waitingStatus !== 'down';
  }
  const stopWaiting = store.subscribe(update => {
    if (update.type !== 'snapshot') {
      showWaiting();
      return;
    }
    stopWaiting();
    const eligible = requested && (!pageView?.demoOnly || store.getSnapshot().demo !== false);
    waiting.remove();
    if (!eligible) stylesheet?.remove();
    mount(eligible ? requested : dashboard);
  });
  showWaiting();
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) clearProject();
  });
  store.reconnect();
  addEventListener('pagehide', event => {
    if (event.persisted) return;
    stopWaiting();
    cleanupView?.();
    store.close();
  });
}

const transport = createBrowserTransport();
const store = createHudStore({ transport });
const H = hudClient({ now: store.getServerTime });
// Preserve the global client binding used by the browser smoke checks.
Object.defineProperty(globalThis, 'H', { value: H });
pageMain(H, store, transport);

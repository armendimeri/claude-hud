import { CONNECTION_LABELS } from './controls.mjs';
import { h } from './dom.mjs';
import { createLifetime } from './lifetime.mjs';
import { createMotion } from './preferences.mjs';
import { mountDashboard } from '../legacy-hud.mjs';
import { viewRegistry } from '../view-registry.mjs';

/** Mount the selected outlet over one stream. Closing the page also closes its store. */
export function mountHudPage(element, { store, transport }) {
  const lifetime = createLifetime();
  const motion = createMotion(lifetime);
  const query = new URLSearchParams(location.search);
  const kiosk = query.has('kiosk');
  const root = document.documentElement;
  root.classList.toggle('kiosk', kiosk);
  lifetime.onClose(() => root.classList.remove('kiosk'));
  if (kiosk) keepScreenAwake(lifetime);

  let project = query.get('project') || null;
  const projectListeners = new Set();
  let mounted = null;
  const requested = viewRegistry.get(kiosk ? 'network' : query.get('view'));
  const pageView = requested?.outlet === 'page' ? requested : null;
  const stylesheet = pageView?.stylesheet && h('link', { rel: 'stylesheet', href: pageView.stylesheet });
  if (stylesheet) document.head.append(stylesheet);

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
      showDashboard(null);
      window.scrollTo(0, 0);
      mounted.focusView();
    },
  };

  function showDashboard(sessionView) {
    mounted?.close();
    stylesheet?.remove();
    mounted = mountDashboard(element, { store, transport, actions, motion, kiosk,
      requested: sessionView?.key, views: viewRegistry });
  }
  const label = h('span', { class: 'label' });
  const stream = h('div', { class: 'stream', role: 'status' }, h('span', { class: 'stream-dot' }), label);
  const retry = h('button', { type: 'button', text: 'Retry now', hidden: true });
  const waiting = h('div', { class: 'top', style: 'margin:0; justify-content:center; gap:12px' }, stream, retry);
  element.append(waiting);
  lifetime.listen(retry, 'click', store.reconnect);

  function showWaiting() {
    const status = store.getConnection().status;
    // EventSource can open before its first full frame.
    const waitingStatus = status === 'live' ? 'connecting' : status;
    stream.dataset.s = waitingStatus;
    label.textContent = CONNECTION_LABELS[waitingStatus];
    retry.hidden = waitingStatus !== 'down';
  }
  let stopWaiting = store.subscribe(update => {
    if (update.type !== 'snapshot') {
      showWaiting();
      return;
    }
    stopWaiting();
    stopWaiting = null;
    waiting.remove();
    if (pageView && (!pageView.demoOnly || store.getSnapshot().demo !== false)) {
      mounted = { close: pageView.mount(element, { store, actions }) };
    } else {
      showDashboard(requested?.outlet === 'sessions' ? requested : null);
    }
  });
  showWaiting();
  lifetime.listen(document, 'keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      if (mounted?.clearProject) mounted.clearProject();
      else actions.setProject(null);
    }
  });
  lifetime.listen(window, 'pagehide', event => { if (!event.persisted) lifetime.close(); });
  lifetime.onClose(() => {
    stopWaiting?.();
    mounted?.close();
    projectListeners.clear();
    waiting.remove();
    stylesheet?.remove();
    store.close();
  });
  store.reconnect();
  return lifetime.close;
}

function keepScreenAwake(lifetime) {
  let lock = null, acquiring = false;
  async function release(wakeLock) {
    try { await wakeLock?.release?.(); } catch {}
  }
  async function keepAwake() {
    if (!navigator.wakeLock || document.hidden || acquiring || (lock && !lock.released)) return;
    acquiring = true;
    try {
      const next = await navigator.wakeLock.request('screen');
      if (lifetime.signal.aborted) await release(next);
      else lock = next;
    } catch {} finally {
      acquiring = false;
    }
  }
  lifetime.listen(document, 'visibilitychange', keepAwake);
  lifetime.onClose(() => { void release(lock); });
  void keepAwake();
}

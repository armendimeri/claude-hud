import { CONNECTION_LABELS } from './controls.mjs';
import { createDiscreet } from './discreet.mjs';
import { h } from './dom.mjs';
import { entityKey, findEntityElement } from './entity-key.mjs';
import { createLifetime } from './lifetime.mjs';
import { createPageEffects } from './page-effects.mjs';
import { createMotion } from './preferences.mjs';
import { cockpitHref, dashboardHref, resolveRoute, routeTarget } from './route.mjs';
import { mountDashboard } from '../legacy-hud.mjs';
import { viewRegistry } from '../view-registry.mjs';

/**
 * Mount the page over one store and one stream. Closing the page also closes its store.
 *
 * The surface on screen is decided from the location: the dashboard (Cards or Network), a page view such as Activity,
 * or the Cockpit. Entering the cockpit pushes one history entry and leaving it goes Back, so the browser's own Back
 * and Forward move between the same surfaces and nothing is pushed while rendering a popstate. Everything that must
 * survive a view change (the store, the notification and away effects, the discreet flag, the project and the shared
 * inspector) belongs to this one page lifetime.
 */
export function mountHudPage(element, { store, transport }) {
  const lifetime = createLifetime();
  const motion = createMotion(lifetime);
  const discreet = createDiscreet();
  const effects = createPageEffects({ store, transport, lifetime, discreet });
  const root = document.documentElement;

  let route = resolveRoute(location.search, viewRegistry);
  const kiosk = route.kiosk;
  root.classList.toggle('kiosk', kiosk);
  lifetime.onClose(() => root.classList.remove('kiosk'));
  if (kiosk) keepScreenAwake(lifetime);

  // While discreet, the project is kept in memory only: the URL does not show it and a reload does not read it.
  let project = discreet.get() ? null : route.project;
  const projectListeners = new Set();
  const writeProjectToUrl = () => {
    const url = new URL(location.href);
    if (project && !discreet.get()) url.searchParams.set('project', project);
    else url.searchParams.delete('project');
    if (url.href !== location.href) history.replaceState(history.state, '', url);
  };
  if (discreet.get()) writeProjectToUrl();
  lifetime.onClose(discreet.subscribe(() => writeProjectToUrl()));

  let mounted = null, surface = null, stopWaiting = null, started = false;
  let entryId = history.state?.hudEntry ?? null, entrySeq = 0, navigating = false;
  const origins = new Map();          // history entry id -> where the operator came from (memory only)
  let inspectorHost = null;

  // The inspector slot is imported on the first inspect, so a dashboard that never inspects never requests it.
  let slot = null, slotLoad = null;
  const loadSlot = () => slotLoad ??= import('./inspector-slot.mjs').then(module => {
    if (lifetime.signal.aborted) return null;
    return slot = module.createInspectorSlot({ store, discreet, signal: lifetime.signal });
  });

  const actions = {
    getProject: () => project,
    setProject(name) {
      if (name === project) return;
      project = name;
      const origin = origins.get(entryId);
      if (origin) origin.cockpitProject = name;
      writeProjectToUrl();
      for (const notify of projectListeners) notify();
    },
    subscribeProject(notify) {
      projectListeners.add(notify);
      return () => projectListeners.delete(notify);
    },
    dashboardUrl: () => dashboardHref(location.href),
    discreet,
    effects,
    /** Open the cockpit from the dashboard. A second call while one is in progress does nothing. */
    openCockpit(opener = null) {
      if (kiosk || navigating || surface?.id === 'cockpit') return;
      navigating = true;
      const row = opener?.closest?.('[data-entity-key]') || document.activeElement?.closest?.('[data-entity-key]');
      const id = ++entrySeq;
      origins.set(id, {
        project, cockpitProject: project, rowKey: row?.dataset.entityKey ?? null, hadToolbarOpener: !row,
        scrollY: window.scrollY, panelScroll: document.querySelector('.p-sess .pc')?.scrollTop ?? 0,
      });
      history.pushState({ hudEntry: id }, '', cockpitHref(location.href));
      entryId = id;
      render();
    },
    /** Leave the current page view: Back when the app created the entry, otherwise replace it with the dashboard URL. */
    leaveView() {
      if (entryId && origins.has(entryId)) {
        history.back();
        return;
      }
      history.replaceState(history.state?.hudEntry ? null : history.state, '', actions.dashboardUrl());
      entryId = null;
      render();
      window.scrollTo(0, 0);
      mounted?.focusView?.();
    },
    /** Open the shared inspector for a session or a subagent. The dashboard hosts it; the cockpit passes its own host. */
    async inspect(selection, { opener = null, host = null, onClose, focusFallback } = {}) {
      if (discreet.get()) return;
      opener = opener || document.activeElement;
      const target = host || dashboardInspectorHost();
      const ready = await loadSlot();
      if (!ready || !target.isConnected) return;
      return ready.open(selection, {
        host: target, opener,
        onClose: info => { onClose?.(info); if (!host) removeDashboardInspectorHost(); },
        focusFallback: focusFallback || (() => mounted?.focusView?.() ?? null),
      });
    },
    closeInspector: () => { slot?.close(); removeDashboardInspectorHost(); },
    getInspected: () => slot?.selection() ?? null,
    inspectorOpen: () => !!slot?.isOpen(),
  };

  function dashboardInspectorHost() {
    if (!inspectorHost) {
      inspectorHost = h('aside', { class: 'insp-host', 'aria-label': 'Session inspector' });
      element.append(inspectorHost);
    }
    return inspectorHost;
  }
  function removeDashboardInspectorHost() {
    inspectorHost?.remove();
    inspectorHost = null;
  }

  // ---- surfaces -----------------------------------------------------------------------------------------------------
  function closeSurface() {
    actions.closeInspector();
    mounted?.close();
    mounted = null;
    surface?.stylesheet?.remove();
    surface = null;
  }

  function showDashboard(requested) {
    mounted = mountDashboard(element, { store, transport, actions, motion, kiosk, effects,
      requested: requested?.key, views: viewRegistry });
  }

  /** A masked shell while discreet: no dashboard DOM, announcements or names until the operator chooses. */
  function showMasked(origin) {
    const reveal = h('button', { class: 'btn', type: 'button', text: 'Return to dashboard and reveal details' });
    const stay = h('button', { class: 'btn', type: 'button', text: 'Stay discreet' });
    const card = h('main', { class: 'masked', 'aria-labelledby': 'masked-h' },
      h('h1', { id: 'masked-h', text: 'Discreet display is on' }),
      h('p', { text: 'Names, paths and conversation are hidden. Choose how to continue.' }),
      h('div', { class: 'masked-actions' }, reveal, stay));
    element.append(card);
    reveal.addEventListener('click', () => {
      discreet.set(false);
      render(true);
      restoreOrigin(origin);
    });
    // Back from here returns to this masked shell, so staying discreet is a normal navigation forward, never a rewrite.
    stay.addEventListener('click', () => {
      const id = ++entrySeq;
      origins.set(id, { project, cockpitProject: project, rowKey: null, hadToolbarOpener: true, scrollY: 0, panelScroll: 0 });
      history.pushState({ hudEntry: id }, '', cockpitHref(location.href));
      entryId = id;
      render();
    });
    reveal.focus({ preventScroll: true });
    mounted = { close: () => card.remove() };
  }

  /** Put the operator back where the cockpit was entered from: scroll, then the row they came from. */
  function restoreOrigin(origin) {
    if (!origin) return;
    window.scrollTo(0, origin.scrollY);
    const panel = document.querySelector('.p-sess .pc');
    if (panel) panel.scrollTop = origin.panelScroll;
    const row = origin.rowKey && findEntityElement(origin.rowKey);
    if (row) row.focus({ preventScroll: true });
    else if (origin.hadToolbarOpener) document.querySelector('[data-cockpit-open]')?.focus({ preventScroll: true });
    else mounted?.focusView?.();
  }

  /** Render the surface the location names. Nothing is pushed here; popstate only renders. */
  function render(force = false) {
    if (!started) return;
    const previousSurface = surface?.id ?? null;
    const previousEntry = surface?.entry ?? null;
    route = resolveRoute(location.search, viewRegistry);
    if (route.kiosk !== kiosk) { location.reload(); return; }
    const target = routeTarget(route, store.getSnapshot());
    const cockpit = target.id === 'cockpit';
    const origin = !cockpit && previousSurface === 'cockpit' ? origins.get(previousEntry) : null;
    const masked = discreet.get();
    let nextProject = route.project;
    if (origin) nextProject = origin.project;
    else if (masked) {
      const destination = cockpit && origins.get(entryId);
      nextProject = destination ? destination.cockpitProject : project;
    }
    if (nextProject !== project) {
      project = nextProject;
      for (const notify of projectListeners) notify();
    }
    if (masked || origin) writeProjectToUrl();
    const id = masked && !cockpit ? 'masked' : target.id;
    navigating = false;
    const requestedKey = target.requested?.key ?? null;
    if (!force && id === previousSurface && requestedKey === surface?.requested) return;
    closeSurface();
    const stylesheet = target.view?.stylesheet && h('link', { rel: 'stylesheet', href: target.view.stylesheet });
    if (stylesheet) document.head.append(stylesheet);
    surface = { id, entry: entryId, stylesheet, requested: requestedKey };
    if (id === 'masked') showMasked(origin);
    else if (target.kind === 'page') {
      const close = target.view.mount(element, { store, transport, actions, motion, discreet, effects, signal: lifetime.signal });
      mounted = { close, clearProject: close.clearProject, focusView: close.focusView };
    } else showDashboard(target.requested);
    if (id === 'dashboard') restoreOrigin(origin);
  }

  // ---- first frame gate ------------------------------------------------------------------------------------------
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
  stopWaiting = store.subscribe(update => {
    if (update.type !== 'snapshot') {
      showWaiting();
      return;
    }
    stopWaiting();
    stopWaiting = null;
    waiting.remove();
    started = true;
    render();
  });
  showWaiting();

  // Escape clears the project unless an inner surface (the inspector, a drawer) already used the key.
  lifetime.listen(document, 'keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      if (mounted?.clearProject) mounted.clearProject();
      else actions.setProject(null);
    }
  });
  lifetime.listen(window, 'popstate', () => {
    entryId = history.state?.hudEntry ?? null;
    render();
  });
  lifetime.listen(window, 'pagehide', event => { if (!event.persisted) lifetime.close(); });
  lifetime.onClose(() => {
    stopWaiting?.();
    closeSurface();
    projectListeners.clear();
    waiting.remove();
    origins.clear();
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

import { createAlertComponents } from '../components/alerts.mjs';
import { createDisplayEffects } from '../components/animation.mjs';
import { CONNECTION_LABELS, backgroundLayer, panel } from '../components/controls.mjs';
import { h, setAttr, show, txt } from '../components/dom.mjs';
import { fmtClock } from '../components/format.mjs';
import { createLifetime } from '../components/lifetime.mjs';
import { createPlanPanel } from '../components/plan-panel.mjs';
import { createSessionList } from '../components/sessions.mjs';
import { glyph, icon } from '../components/status.mjs';
import { createTiming } from '../components/timing.mjs';
import { createTooltip } from '../components/tooltip.mjs';
import { createVitalsComponents, externals } from '../components/vitals.mjs';
import { selectLastFinish, selectProject } from '../data/selectors.mjs';

const SCENE_URL = '../cockpit/scene.mjs';
const SCENE_CSS = new URL('../cockpit/scene.css', import.meta.url).href;
const NARROW = '(max-width: 599px)';
const INSPECTOR_WIDTH = 400;
const MAP_MIN_BESIDE = 640;
const THREE = () => import('../vendor/three/three.module.min.js');

/**
 * The Cockpit page, imported lazily by the view registry. It composes:
 *   - the fixed HTML strip (exit, project scope, counts, connection, Plans, Vitals, discreet display),
 *   - the attention row and warnings (the dashboard's banner component) and the while-away summary,
 *   - the 3D scene (../cockpit/scene.mjs, imported here on demand), or its list when 3D is unavailable or the
 *     viewport is narrow,
 *   - the shared inspector, hosted at the right of the scene (side), over it (overlay) or as a sheet (narrow),
 *   - the bottom strip with the last completion, and drawers for the feed, plans and vitals.
 * It reads the page's one store and the page's effects; it opens no stream and no private request.
 */
export function mountCockpitPage(element, { store, actions, motion, discreet, effects, signal }) {
  const lifetime = createLifetime();
  const now = store.getServerTime;
  const timing = createTiming(now);
  const display = createDisplayEffects(lifetime, motion);
  const narrow = matchMedia(NARROW);
  actions.closeInspector();

  const sceneStyle = h('link', { rel: 'stylesheet', href: SCENE_CSS });
  document.head.append(sceneStyle);
  lifetime.onClose(() => sceneStyle.remove());

  // ---- selection (one tuple, shared by the scene, the attention row and the inspector) -----------------------------
  let selection = null;
  const selectionListeners = new Set();
  function setSelection(next) {
    selection = next ? { sessionId: next.sessionId, agentId: next.agentId ?? null } : null;
    for (const listener of [...selectionListeners]) listener(selection);
    layoutInspector();
  }
  function inspect(next, opener) {
    if (!next || discreet.get()) return;
    setSelection(next);
    const target = selection;
    if (!actions.inspectorOpen()) {
      inspHost.replaceChildren(h('p', { class: 'cp-insp-loading label', role: 'status', text: 'Opening the inspector…' }));
    }
    const pending = actions.inspect(target, {
      host: inspHost, opener: opener || document.activeElement, focusFallback: focusScene,
      onClose: () => { setSelection(null); inspHost.replaceChildren(); },
    });
    Promise.resolve(pending).then(() => {
      if (selection === target && !actions.inspectorOpen() && !discreet.get()) {
        inspHost.replaceChildren(h('div', { class: 'cp-insp-failed' }, h('p', { text: 'The inspector could not be loaded.' }),
          h('button', { class: 'btn', type: 'button', text: 'Close', on: { click: () => { setSelection(null); inspHost.replaceChildren(); } } })));
      }
    });
  }
  function selectEntity(sessionId, agentId = null) {
    inspect({ sessionId, agentId }, document.activeElement);
  }
  function focusScene() {
    const target = scene?.root?.querySelector('.cs-list') || fallback?.el.querySelector('button');
    target?.focus({ preventScroll: true });
    return true;
  }

  // ---- DOM ---------------------------------------------------------------------------------------------------------
  const heading = h('h1', { class: 'cp-title label', tabindex: '-1', text: 'Cockpit' });
  const exit = h('button', { class: 'btn cp-exit', type: 'button', 'aria-label': 'Return to dashboard' }, icon('back'), h('span', { text: 'Dashboard' }));
  const scope = h('select', { class: 'cp-scope', id: 'cp-scope', 'aria-label': 'Project scope' });
  const counts = h('div', { class: 'cp-counts', role: 'group', 'aria-label': 'Counts' });
  const connection = h('span', { class: 'cp-conn label', role: 'status' }, h('span', { class: 'stream-dot' }), h('span', { class: 'cp-conn-w' }));
  const plansButton = h('button', { class: 'btn cp-tool', type: 'button', 'data-drawer': 'plans', 'aria-label': 'Plans', 'aria-expanded': 'false', 'aria-controls': 'cp-drawer' }, icon('plan'), h('span', { text: 'Plans' }));
  const vitalsButton = h('button', { class: 'btn cp-tool', type: 'button', 'data-drawer': 'vitals', 'aria-label': 'Vitals', 'aria-expanded': 'false', 'aria-controls': 'cp-drawer' }, icon('effects'), h('span', { text: 'Vitals' }));
  const discreetButton = h('button', { class: 'btn cp-tool cp-discreet', type: 'button', 'aria-label': 'Discreet display', 'aria-pressed': 'false' }, icon('eye'), h('span', { text: 'Discreet' }));
  const bar = h('header', { class: 'cp-bar' }, exit, heading, scope, counts, connection, plansButton, vitalsButton, discreetButton);

  const reconnectText = h('span', { class: 'cp-recon-t' });
  const reconnectRetry = h('button', { class: 'btn', type: 'button', text: 'Retry now', hidden: true, on: { click: () => store.reconnect() } });
  const reconnect = h('div', { class: 'cp-recon', role: 'status', hidden: true }, icon('alert'), reconnectText, reconnectRetry);

  const attention = h('div', { class: 'cp-attn' });
  const awayHost = h('div', { class: 'cp-away' });
  const narrowNote = h('p', { class: 'cp-narrow-note label', hidden: true, text: 'List view at this width' });
  const stage = h('div', { class: 'cp-stage' }, narrowNote);
  const sceneHost = h('div', { class: 'cp-scene' });
  stage.prepend(sceneHost);
  const inspHost = h('aside', { class: 'cp-insp', 'aria-label': 'Session inspector' });
  const drawer = h('section', { class: 'cp-drawer', id: 'cp-drawer', hidden: true });
  const main = h('div', { class: 'cp-main', 'data-insp': 'none' }, stage, inspHost, drawer);

  const lastTag = h('span', { class: 'cp-last-tag label', text: 'Last done' });
  const lastText = h('span', { class: 'cp-last-text trunc', text: 'Nothing has finished yet' });
  const lastAge = h('span', { class: 'cp-last-age mono' });
  const feedButton = h('button', { class: 'btn cp-tool', type: 'button', 'data-drawer': 'feed', 'aria-expanded': 'false', 'aria-controls': 'cp-drawer' }, icon('file'), h('span', { text: 'Activity' }));
  const strip = h('footer', { class: 'cp-strip' }, h('p', { class: 'cp-last' }, lastTag, lastText, lastAge), feedButton);

  const exitSheet = h('div', { class: 'cp-exit-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cp-exit-h', hidden: true });
  const root = h('div', { class: 'cockpit', 'data-discreet': 'off', 'data-connection': 'live', 'data-narrow': 'false' },
    backgroundLayer(), bar, reconnect, attention, awayHost, main, strip, exitSheet);
  element.append(root);
  // A read-only handle for tests and the console: the scene's stats and controls. Nothing in the page uses it.
  Object.defineProperty(root, 'hudScene', { get: () => scene });
  lifetime.onClose(() => root.remove());
  heading.focus({ preventScroll: true });

  // ---- the scene, or its list ---------------------------------------------------------------------------------------
  let scene = null, fallback = null, closed = false;
  const loadThree = () => (narrow.matches ? Promise.reject(new Error('list view at narrow widths')) : THREE());
  const sceneActions = {
    select: next => inspect(next, document.activeElement),
    getSelection: () => selection,
    subscribeSelection(listener) { selectionListeners.add(listener); return () => selectionListeners.delete(listener); },
    getProject: actions.getProject,
    subscribeProject: actions.subscribeProject,
    getDiscreet: discreet.get,
    subscribeDiscreet: discreet.subscribe,
  };
  import(SCENE_URL).then(module => {
    // The import can finish after the operator left (or left and came back): the lifetime says whether this mount is current.
    if (closed || lifetime.signal.aborted || !sceneHost.isConnected) return;
    scene = module.mountScene(sceneHost, { store, actions: sceneActions, motion, signal: lifetime.signal, loadThree });
    lifetime.onClose(scene);
  }, () => {
    if (closed) return;
    narrowNote.hidden = false;
    txt(narrowNote, 'The 3D view could not be loaded · showing the list');
    fallback = createSessionList({ store, actions, onSelect: inspect });
    sceneHost.append(fallback.el);
    lifetime.onClose(() => fallback.close());
  });
  function applyNarrow() {
    root.dataset.narrow = String(narrow.matches);
    show(narrowNote, narrow.matches && !fallback);
    // Crossing to a wide viewport while only the list is showing: start the 3D view for the first time.
    if (!narrow.matches && scene?.getMode?.() === 'fallback') scene.retry();
    layoutInspector();
  }
  lifetime.listen(narrow, 'change', applyNarrow);

  // ---- counts, scope, connection -------------------------------------------------------------------------------------
  const countCells = new Map();
  for (const [key, label] of [['sessions', 'Sessions'], ['working', 'Working'], ['needs', 'Needs you'], ['agents', 'Subagents']]) {
    const value = h('b', { class: 'mono' });
    counts.append(h('span', { class: 'cp-count', 'data-k': key }, value, h('span', { class: 'label', text: label })));
    countCells.set(key, value);
  }
  let scopeSignature = '';
  function drawScope() {
    const snapshot = store.getSnapshot();
    const project = actions.getProject();
    if (discreet.get()) {
      const signature = 'discreet:' + (project ? 1 : 0);
      if (signature !== scopeSignature) {
        scopeSignature = signature;
        scope.replaceChildren(h('option', { value: '', text: project ? 'Scoped to one project' : 'All projects' }));
      }
      scope.disabled = true;
      scope.value = '';
      return;
    }
    scope.disabled = false;
    const names = new Set();
    for (const entry of snapshot?.projects || []) if (entry.project) names.add(entry.project);
    for (const session of snapshot?.sessions || []) if (session.project) names.add(session.project);
    if (project) names.add(project);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    const signature = JSON.stringify(sorted);
    if (signature !== scopeSignature) {
      scopeSignature = signature;
      scope.replaceChildren(h('option', { value: '', text: 'All projects' }), ...sorted.map(name => h('option', { value: name, text: name })));
    }
    scope.value = project || '';
  }
  lifetime.listen(scope, 'change', () => actions.setProject(scope.value || null));

  function drawCounts(snapshot) {
    if (!snapshot) return;
    const sessions = selectProject(snapshot.sessions, actions.getProject()).filter(session => session.status !== 'ended');
    const running = sessions.reduce((total, session) => total + (session.subagents || []).filter(agent => agent.state === 'running').length, 0);
    txt(countCells.get('sessions'), sessions.length);
    txt(countCells.get('working'), sessions.filter(session => session.status === 'busy').length);
    txt(countCells.get('needs'), sessions.filter(session => session.status === 'needs-you').length);
    txt(countCells.get('agents'), running);
  }
  let lastAt = null;
  function drawConnection() {
    const { status, lastAt: receivedAt } = store.getConnection();
    const live = status === 'live';
    root.dataset.connection = live ? 'live' : 'reconnecting';
    connection.dataset.s = status;
    txt(connection.lastElementChild, CONNECTION_LABELS[status] || status);
    show(reconnect, !live);
    show(reconnectRetry, status === 'down');
    lastAt = receivedAt;
    tickConnection();
  }
  function tickConnection() {
    if (reconnect.hidden) return;
    const age = lastAt === null ? '' : ' · last update ' + Math.max(0, Math.round((Date.now() - lastAt) / 1000)) + 's ago';
    txt(reconnectText, (store.getConnection().status === 'down' ? 'HUD server not answering' : 'Reconnecting') + age + ' · showing last known state · live actions paused');
  }

  // ---- attention row, warnings, away summary ---------------------------------------------------------------------------
  const { banners, awaySummary } = createAlertComponents({ motion, timing, effects: display });
  let alerts = null, discreetAttention = null, away = null;
  function buildAttention() {
    attention.replaceChildren();
    alerts = null; discreetAttention = null;
    if (discreet.get()) {
      const text = h('span', { class: 'cp-attn-d-t' });
      const button = h('button', { class: 'btn', type: 'button', text: 'Inspect oldest', on: { click: () => {
        const oldest = oldestWaiting(store.getSnapshot());
        if (oldest) selectEntity(oldest.id);
      } } });
      const el = h('div', { class: 'cp-attn-d', role: 'status', hidden: true }, glyph('needs'), text, button);
      discreetAttention = { el, text };
      attention.append(el);
    } else {
      alerts = banners({ jump: (id, agentId) => selectEntity(id, agentId ?? null) });
      attention.append(alerts.el);
    }
  }
  function oldestWaiting(snapshot) {
    return (snapshot?.sessions || []).filter(session => session.status === 'needs-you' && session.needsYou)
      .sort((a, b) => a.needsYou.since - b.needsYou.since)[0] || null;
  }
  function drawAttention(snapshot) {
    if (!snapshot) return;
    const scoped = selectProject(snapshot.sessions, actions.getProject());
    if (alerts) alerts.update(scoped, selectProject(snapshot.alerts || [], actions.getProject()));
    if (discreetAttention) {
      const waiting = scoped.filter(session => session.status === 'needs-you' && session.needsYou).length;
      show(discreetAttention.el, waiting > 0);
      txt(discreetAttention.text, waiting === 1 ? '1 session needs you' : waiting + ' sessions need you');
    }
  }
  function buildAway() {
    awayHost.replaceChildren();
    away = awaySummary();
    awayHost.append(away.el);
  }
  // The summary arrives from the page's effects. While discreet it carries counts only.
  buildAway();
  lifetime.onClose(effects.onAway((feed, since) => {
    away.update(discreet.get() ? feed.map(({ at, kind, action }) => ({ at, kind, action, text: '', project: null })) : feed, since);
  }));

  // ---- bottom strip and drawers ---------------------------------------------------------------------------------------
  function drawLast(snapshot) {
    if (!snapshot) return;
    const project = actions.getProject();
    const finished = selectLastFinish(snapshot, project);
    const fed = selectProject(snapshot.feed || [], project).find(line => line.kind === 'done');
    const latest = [finished, fed].filter(Boolean).sort((a, b) => b.at - a.at)[0];
    if (!latest) { txt(lastText, 'Nothing has finished yet'); timing.age(lastAge, null); return; }
    txt(lastText, discreet.get() ? 'A task finished' : (latest.project ? latest.project + ' · ' : '') + latest.text);
    timing.age(lastAge, latest.at, '', ' ago');
  }

  let drawerKind = null, drawerOpener = null;
  const tip = createTooltip(lifetime);
  let plans = null, vitals = null;
  const planApi = {
    jump: (id, agentId) => selectEntity(id, agentId ?? null),
    project: name => { if (name) actions.setProject(actions.getProject() === name ? null : name); },
    focused: () => actions.getProject(),
  };
  function ensureVitals() {
    if (vitals) return vitals;
    const { reactor, vitals: vitalsComponent } = createVitalsComponents({ now, odo: display.odo });
    const totals = panel('p-reactor', null, { label: 'Agents and totals' });
    const react = reactor(), vit = vitalsComponent();
    totals.content.append(react.el, vit.el);
    const outside = panel('p-ext', 'Outside Claude Code');
    outside.el.hidden = true;
    const outsideList = externals(display.reconcile);
    outside.content.append(outsideList.el);
    vitals = { el: h('div', { class: 'cp-vitals' }, totals.el, outside.el), react, vit, outside, outsideList };
    return vitals;
  }
  function drawVitals(snapshot) {
    if (!vitals || !snapshot) return;
    vitals.react.update(snapshot.sessions, snapshot.totals, { boot: false });
    vitals.vit.update(snapshot, { boot: false });
    const has = !discreet.get() && !!(snapshot.external?.length || snapshot.externalError);
    show(vitals.outside.el, has);
    if (has) vitals.outsideList.update(snapshot.external, snapshot.externalError);
  }
  function drawFeed(snapshot) {
    if (drawerKind !== 'feed' || !snapshot) return;
    const lines = selectProject(snapshot.feed || [], actions.getProject()).slice(0, 100);
    const list = drawer.querySelector('.cp-feed-list');
    list.replaceChildren(...lines.map(line => {
      const known = line.sessionId && snapshot.sessions.some(session => session.id === line.sessionId);
      const body = [h('time', { class: 'mono', text: fmtClock(line.at) }), h('span', { class: 'label', text: line.project || line.kind }), h('span', { class: 'cp-feed-t', text: line.text })];
      return h('li', {}, known
        ? h('button', { type: 'button', class: 'cp-feed-row', 'aria-label': `Show the session: ${line.text}`, on: { click: () => selectEntity(line.sessionId) } }, ...body)
        : h('div', { class: 'cp-feed-row' }, ...body));
    }));
    show(drawer.querySelector('.cp-feed-empty'), lines.length === 0);
  }
  function drawDrawer(snapshot = store.getSnapshot()) {
    if (drawerKind === 'plans' && plans && snapshot) plans.update(snapshot, actions.getProject(), false);
    else if (drawerKind === 'vitals') drawVitals(snapshot);
    else if (drawerKind === 'feed') drawFeed(snapshot);
  }
  const buttonFor = { plans: plansButton, vitals: vitalsButton, feed: feedButton };
  function closeDrawer({ focus = true } = {}) {
    if (!drawerKind) return false;
    const button = buttonFor[drawerKind];
    drawerKind = null;
    drawer.hidden = true;
    drawer.replaceChildren();
    tip.close();
    for (const control of Object.values(buttonFor)) control.setAttribute('aria-expanded', 'false');
    if (focus) (drawerOpener?.isConnected ? drawerOpener : button).focus({ preventScroll: true });
    drawerOpener = null;
    layoutInspector();
    return true;
  }
  function openDrawer(kind, opener) {
    if (drawerKind === kind) { closeDrawer(); return; }
    closeDrawer({ focus: false });
    if (discreet.get() && kind !== 'vitals') return;
    drawerKind = kind;
    drawerOpener = opener;
    const titles = { plans: 'Plans and work queue', vitals: 'Vitals', feed: 'Recent activity' };
    const close = h('button', { class: 'btn cp-drawer-close', type: 'button', 'aria-label': 'Close ' + titles[kind], on: { click: () => closeDrawer() } }, icon('close'));
    const head = h('header', { class: 'cp-drawer-head' }, h('h2', { class: 'label', text: titles[kind] }), close);
    let body;
    if (kind === 'plans') {
      plans = plans || createPlanPanel({ lifetime, motion, tip, reconcile: display.reconcile, api: planApi });
      body = h('div', { class: 'cp-drawer-body' }, plans.el);
    } else if (kind === 'vitals') {
      body = h('div', { class: 'cp-drawer-body' }, ensureVitals().el);
    } else {
      body = h('div', { class: 'cp-drawer-body' }, h('p', { class: 'cp-feed-empty', hidden: true, text: 'No recent events in this scope.' }), h('ol', { class: 'cp-feed-list' }));
    }
    setAttr(drawer, 'aria-label', titles[kind]);
    drawer.replaceChildren(head, body);
    drawer.hidden = false;
    for (const [name, control] of Object.entries(buttonFor)) control.setAttribute('aria-expanded', String(name === kind));
    drawDrawer();
    close.focus({ preventScroll: true });
    layoutInspector();
  }
  lifetime.listen(plansButton, 'click', () => openDrawer('plans', plansButton));
  lifetime.listen(vitalsButton, 'click', () => openDrawer('vitals', vitalsButton));
  lifetime.listen(feedButton, 'click', () => openDrawer('feed', feedButton));

  // ---- inspector placement --------------------------------------------------------------------------------------------
  function layoutInspector() {
    const width = main.clientWidth || window.innerWidth;
    let mode = 'none';
    if (selection) mode = narrow.matches ? 'sheet' : width - INSPECTOR_WIDTH - 16 >= MAP_MIN_BESIDE ? 'side' : 'overlay';
    if (main.dataset.insp !== mode) main.dataset.insp = mode;
    main.dataset.drawer = drawerKind || 'none';
  }
  lifetime.observeResize(main, layoutInspector);

  // ---- exit ----------------------------------------------------------------------------------------------------------
  function leave() {
    if (!discreet.get()) { actions.leaveView(); return; }
    openExitSheet();
  }
  function openExitSheet() {
    const reveal = h('button', { class: 'btn', type: 'button', text: 'Return to dashboard and reveal details', on: { click: () => { discreet.set(false); closeExitSheet(false); actions.leaveView(); } } });
    const stay = h('button', { class: 'btn', type: 'button', text: 'Stay discreet', on: { click: () => closeExitSheet(true) } });
    exitSheet.replaceChildren(h('h2', { id: 'cp-exit-h', class: 'label', text: 'Discreet display is on' }),
      h('p', { text: 'The dashboard shows project names, titles and conversation.' }), h('div', { class: 'cp-exit-actions' }, reveal, stay));
    exitSheet.hidden = false;
    stay.focus({ preventScroll: true });
  }
  function closeExitSheet(focus) {
    if (exitSheet.hidden) return false;
    exitSheet.hidden = true;
    exitSheet.replaceChildren();
    if (focus) exit.focus({ preventScroll: true });
    return true;
  }
  lifetime.listen(exit, 'click', leave);

  // ---- discreet display -----------------------------------------------------------------------------------------------
  function applyDiscreet() {
    const on = discreet.get();
    root.dataset.discreet = on ? 'on' : 'off';
    discreetButton.setAttribute('aria-pressed', String(on));
    discreetButton.querySelector('.ic').replaceWith(icon(on ? 'eye-off' : 'eye'));
    if (on) {
      closeDrawer({ focus: false });
      plans?.el.remove(); plans = null;
      vitals?.outside.el.remove();
      actions.closeInspector();
      inspHost.replaceChildren();
      setSelection(null);
    } else if (vitals) {
      vitals.el.append(vitals.outside.el);
    }
    show(plansButton, !on); show(feedButton, !on);
    buildAttention();
    buildAway();
    drawScope();
    drawAll();
  }
  lifetime.listen(discreetButton, 'click', () => discreet.set(!discreet.get()));
  lifetime.onClose(discreet.subscribe(applyDiscreet));

  // ---- updates ------------------------------------------------------------------------------------------------------
  function drawAll() {
    const snapshot = store.getSnapshot();
    drawScope(); drawCounts(snapshot); drawAttention(snapshot); drawLast(snapshot); drawDrawer(snapshot);
  }
  lifetime.onClose(store.subscribe(update => {
    if (update.type === 'connection') drawConnection();
    else if (update.type === 'snapshot') drawAll();
    else if (update.type === 'feed') { drawLast(store.getSnapshot()); drawFeed(store.getSnapshot()); }
  }));
  lifetime.onClose(actions.subscribeProject(drawAll));
  lifetime.repeat(() => { timing.tickTimers(root); tickConnection(); }, 1000);

  // Back from the background or the back/forward cache: revalidate from the store, never from stale local state.
  lifetime.listen(document, 'visibilitychange', () => { if (!document.hidden) { drawAll(); scene?.refresh(); } });
  lifetime.listen(window, 'pageshow', () => { drawAll(); scene?.refresh(); });

  // ---- Escape and close -----------------------------------------------------------------------------------------------
  /** Escape after the inspector has had its turn: the innermost remaining surface first, then the project. */
  function clearProject() {
    if (closeExitSheet(true)) return;
    if (closeDrawer()) return;
    actions.setProject(null);
  }
  lifetime.listen(exitSheet, 'keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeExitSheet(true); }
  });

  applyDiscreet();
  applyNarrow();
  drawConnection();
  drawAll();
  if (signal) {
    if (signal.aborted) lifetime.close();
    else signal.addEventListener('abort', () => lifetime.close(), { once: true });
  }

  function close() {
    if (closed) return;
    closed = true;
    lifetime.close();
  }
  return { close, clearProject, focusView: () => exit.focus({ preventScroll: true }) };
}

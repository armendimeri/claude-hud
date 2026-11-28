import { createAlertComponents } from './components/alerts.mjs';
import { createDisplayEffects } from './components/animation.mjs';
import { backgroundLayer, moreBelow, panel, topBar } from './components/controls.mjs';
import { h, setData, show, txt } from './components/dom.mjs';
import { ticker } from './components/feed.mjs';
import { fmtAge } from './components/format.mjs';
import { createLifetime } from './components/lifetime.mjs';
import { createPlanPanel } from './components/plan-panel.mjs';
import { createSessionPanel } from './components/session-panel.mjs';
import { createTiming } from './components/timing.mjs';
import { createTooltip } from './components/tooltip.mjs';
import { createVitalsComponents, externals } from './components/vitals.mjs';
import { selectLastFinish } from './data/selectors.mjs';

/** Compose the dashboard panels and own cross-panel focus and notifications. */
export function mountDashboard(mount, { store, actions, motion, kiosk, effects, requested, views }) {
  const lifetime = createLifetime();
  const now = store.getServerTime;
  const timing = createTiming(now);
  const display = createDisplayEffects(lifetime, motion);
  const { odo, reconcile } = display;
  const tip = createTooltip(lifetime);
  const { reactor, vitals } = createVitalsComponents({ now, odo });
  const { banners, awaySummary } = createAlertComponents({ motion, timing, effects: display });
  const { audio, voice } = effects;
  let project = actions.getProject(), state = null, booted = false, exHidden = null, lastAt = null;

  const api = {
    jump, setProject,
    showCard: kiosk ? null : id => { sessions.setView('cards'); jump(id); },
    open: id => jump(id),
    project: name => { if (name) setProject(project === name ? null : name); },
    focused: () => project,
    /** Open the shared inspector for a card, row, pinned card or subagent row. */
    inspect: kiosk ? null : (selection, opener) => actions.inspect(selection, { opener }),
  };
  const away = awaySummary(() => alerts.visibility());
  const top = topBar({ now, motion, reactor, odo, audio, voice,
    openCockpit: kiosk ? null : opener => actions.openCockpit(opener) });
  const alerts = banners(api, away.el);
  const conn = h('div', { class: 'conn', hidden: true, role: 'status' },
    h('span', { class: 'label conn-w' }), h('span', { class: 'mono conn-m' }));
  const connRetry = h('button', { type: 'button', text: 'Retry now' });
  conn.append(connRetry);
  lifetime.listen(connRetry, 'click', store.reconnect);

  const totalsPanel = panel('p-reactor', null, { label: 'Agents and totals' });
  const react = reactor(), vit = vitals();
  totalsPanel.content.append(react.el, vit.el);
  const externalPanel = panel('p-ext', 'Outside Claude Code');
  externalPanel.el.hidden = true;
  const exb = externals(reconcile);
  externalPanel.content.append(exb.el);
  const sessions = createSessionPanel({ store, lifetime, motion, timing, kiosk, requested, views, actions: api });
  const plans = createPlanPanel({ lifetime, motion, tip, reconcile, api });
  const feedPanel = panel('p-tick', 'Feed', { label: 'Live feed' });
  const tick = ticker(feedPanel.el, feedPanel.head, { lifetime, motion, now, timing }, api);
  feedPanel.content.replaceWith(tick.el);

  const left = h('div', { class: 'col-l' }, totalsPanel.el, externalPanel.el);
  const more = moreBelow(lifetime, motion, left, left,
    elements => elements.map(el => h('span', { text: el.getAttribute('aria-label') })));
  left.append(more.el);
  const app = h('div', { class: 'app' }, top.el, alerts.el,
    h('main', { class: 'main' }, left, sessions.el, plans.el), feedPanel.el);
  const layers = [backgroundLayer(), app, conn, h('div', { class: 'scanlines', 'aria-hidden': 'true' })];
  mount.append(...layers);
  lifetime.onClose(() => layers.forEach(el => el.remove()));

  function showFocus() {
    tick.focus(project);
    sessions.showFocus(project);
  }
  function setProject(name) {
    if (project === name) return;
    const active = document.activeElement;
    project = name;
    tip.close();
    showFocus();
    if (state) {
      sessions.update(false);
      plans.update(state, project, false);
      tick.done(selectLastFinish(state, project));
    }
    if ((active === sessions.clearFocus && !project) || (active && !active.isConnected)) {
      if (project) sessions.clearFocus.focus({ preventScroll: true });
      else sessions.focusSelection();
    }
    actions.setProject(project);
  }
  function jump(id, agentId) {
    const target = state?.sessions.find(session => session.id === id);
    if (target && project && target.project !== project) setProject(null);
    sessions.jump(id, agentId);
  }
  showFocus();

  function render(snapshot) {
    state = snapshot;
    const boot = !booted && document.documentElement.classList.contains('booting');
    top.update(state);
    alerts.update(state.sessions, state.alerts);
    totalsPanel.guard(() => {
      react.update(state.sessions, state.totals, { boot });
      vit.update(state, { boot });
    }, () => render(state));
    externalPanel.guard(() => {
      const hasExternal = !!(state.external.length || state.externalError);
      externalPanel.el.hidden = !hasExternal;
      if (hasExternal) exb.update(state.external, state.externalError);
    }, () => render(state));
    if (externalPanel.el.hidden !== exHidden) {
      exHidden = externalPanel.el.hidden;
      more.refresh();
    }
    sessions.update(booted);
    plans.update(state, project, booted);
    tick.sync(state.feed);
    tick.done(selectLastFinish(state, project));
    booted = true;
  }
  function tickConnectionAge() {
    if (!conn.hidden) txt(conn.querySelector('.conn-m'), lastAt === null ? '' : 'last update ' + fmtAge(Date.now() - lastAt) + ' ago');
  }
  function showConnection() {
    const { status, lastAt: receivedAt } = store.getConnection();
    top.setStream(status);
    const bad = status === 'reconnecting' || status === 'down';
    show(conn, bad);
    setData(conn, 's', status);
    app.classList.toggle('stale', bad);
    txt(conn.querySelector('.conn-w'), status === 'down' ? 'HUD server not answering' : 'Connection lost · reconnecting');
    lastAt = receivedAt;
    tickConnectionAge();
  }

  if (motion.ambient) bootDashboard(lifetime, tick);
  // Notifications and the away summary are page effects: the page decides what changed and hands the summary here.
  lifetime.onClose(effects.onAway(away.update));
  lifetime.onClose(store.subscribe(update => {
    if (update.type === 'connection') {
      showConnection();
    } else if (update.type === 'feed') {
      tick.add(update.line, store.getSnapshot().feed);
    } else if (state !== store.getSnapshot()) {
      render(store.getSnapshot());
    }
  }));
  showConnection();
  if (store.getSnapshot()) render(store.getSnapshot());
  lifetime.repeat(() => { top.tick(); timing.tickTimers(app); tickConnectionAge(); }, 1000);
  top.tick();
  return { close: lifetime.close, clearProject: () => setProject(null), focusView: sessions.focusSelection };
}

function bootDashboard(lifetime, ticker) {
  const root = document.documentElement;
  const skip = new AbortController();
  function end() {
    root.classList.remove('booting');
    skip.abort();
  }
  root.classList.add('booting');
  window.addEventListener('pointerdown', end, { capture: true, signal: skip.signal });
  window.addEventListener('keydown', end, { capture: true, signal: skip.signal });
  lifetime.delay(() => ticker.type('SYSTEMS ONLINE'), 900);
  lifetime.delay(end, 1600);
  lifetime.onClose(end);
}

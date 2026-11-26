import { moreBelow, panel, stateCounts } from './controls.mjs';
import { h, setAttr, show, txt } from './dom.mjs';
import { prefs } from './preferences.mjs';
import { icon } from './status.mjs';
import { selectProject } from '../data/selectors.mjs';

export function createSessionPanel({ store, lifetime, motion, timing, kiosk, requested, views, actions }) {
  const sessionsPanel = panel('p-sess', 'Sessions');
  const summary = h('span', { class: 'ps trunc' });
  const focusName = h('span', { class: 'trunc' });
  const clearFocus = h('button', {
    class: 'chip focus-clear', type: 'button', 'data-tip': 'Clear project focus (Escape)', hidden: true,
    on: { click: () => actions.setProject(null) },
  }, focusName, icon('close'));
  const buttons = new Map([
    ['cards', h('button', { type: 'button', 'aria-pressed': 'true' }, icon('cards'), 'Cards')],
    ['network', h('button', { type: 'button', 'aria-pressed': 'false' }, icon('network'), 'Network')],
  ]);
  sessionsPanel.head.append(summary, clearFocus,
    h('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, [...buttons.values()]));

  const mounted = new Map();
  let view = null, autoNetwork = false, urlView = requested;
  for (const [key, button] of buttons) {
    const descriptor = views.get(key);
    const connect = component => {
      mounted.set(key, component);
      return () => mounted.delete(key);
    };
    lifetime.onClose(descriptor.mount(sessionsPanel.content, {
      store, motion, timing, kiosk, actions: { ...actions, connect },
    }));
    lifetime.listen(button, 'click', () => setView(key));
  }
  const more = moreBelow(lifetime, motion, sessionsPanel.content, mounted.get('cards').list, stateCounts);
  sessionsPanel.content.append(more.el);

  function preferredView(sessions, live) {
    if (kiosk) return 'network';
    if (urlView) return urlView;
    const saved = prefs.get('view', null);
    if (buttons.has(saved)) return saved;
    if (!autoNetwork && sessions.some(x => x.status !== 'ended' && x.subagents?.length)) autoNetwork = true;
    const crowdedNarrow = innerWidth < 600 && live.length > 8;
    return autoNetwork && !crowdedNarrow ? 'network' : 'cards';
  }
  function setView(key) {
    prefs.set('view', key);
    urlView = null;
    update();
  }
  function update(animate = true) {
    const snapshot = store.getSnapshot();
    if (!snapshot) return;
    sessionsPanel.guard(() => {
      const project = actions.focused();
      const sessions = selectProject(snapshot.sessions, project);
      const live = sessions.filter(session => session.status !== 'ended');
      const busy = live.filter(session => session.status === 'busy').length;
      const needs = live.filter(session => session.status === 'needs-you').length;
      txt(summary, [live.length + ' open', busy ? busy + ' busy' : null, needs ? needs + ' need you' : null].filter(Boolean).join(' · '));
      view = preferredView(sessions, live);
      for (const [key, button] of buttons) {
        setAttr(button, 'aria-pressed', String(key === view));
        show(mounted.get(key).el, key === view);
      }
      mounted.get(view).update({ sessions, live, project, animate });
      more.refresh();
    }, () => update(animate));
  }
  function showFocus(project) {
    show(clearFocus, !!project);
    txt(focusName, project);
    setAttr(clearFocus, 'aria-label', project ? 'Clear project focus: ' + project : null);
  }
  function focusSelection() {
    buttons.get(view || 'cards').focus({ preventScroll: true });
  }
  return {
    el: sessionsPanel.el, clearFocus, update, setView, showFocus, focusSelection,
    jump(id, agentId) { mounted.get(view)?.jump(id, agentId); },
  };
}

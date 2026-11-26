import { createDisplayEffects } from '../components/animation.mjs';
import { h, show } from '../components/dom.mjs';
import { createLifetime } from '../components/lifetime.mjs';
import { createSessionComponents } from '../components/sessions.mjs';
import { selectSessionContext } from '../data/selectors.mjs';

const RANK = { 'needs-you': 0, busy: 1, idle: 2, ended: 3 };

export const cards = {
  key: 'cards',
  outlet: 'sessions',

  mount(element, { store, actions, motion, timing }) {
    const lifetime = createLifetime();
    const effects = createDisplayEffects(lifetime, motion);
    const { sessionCard, compactRow } = createSessionComponents({
      lifetime, motion, now: store.getServerTime, timing, effects,
    });
    const list = h('div', { class: 'cards' });
    const empty = h('div', { class: 'cards-empty', hidden: true },
      h('span', { class: 'label', text: 'No active sessions' }), ' · systems nominal');
    const el = h('div', { hidden: true }, empty, list);
    const rows = new Map();
    let compact = false;

    element.append(el);
    const disconnect = actions.connect({
      el, list,
      update({ sessions, live, project, animate }) {
        show(empty, live.length === 0);
        const dense = live.length > 8;
        if (dense !== compact) {
          compact = dense;
          list.classList.toggle('compact', compact);
          list.replaceChildren();
          rows.clear();
        }
        const context = selectSessionContext(store.getSnapshot(), live, project);
        const sorted = sessions.toSorted((a, b) => RANK[a.status] - RANK[b.status] || (a.startedAt || 0) - (b.startedAt || 0));
        const make = compact ? compactRow : sessionCard;
        effects.reconcile(list, rows, sorted, session => session.id, () => make(actions),
          (row, session) => row.update(session, context), animate);
      },
      jump(id, agentId) {
        const row = rows.get(id);
        if (!row) return;
        const target = (agentId && row.el.querySelector('.sub[data-id="' + CSS.escape(agentId) + '"]')) || row.el;
        target.scrollIntoView({ behavior: motion.rm ? 'auto' : 'smooth', block: 'center' });
        target.classList.add('flash');
        lifetime.delay(() => target.classList.remove('flash'), 900);
        target.focus({ preventScroll: true });
      },
    });
    return () => {
      lifetime.close();
      disconnect();
      el.remove();
    };
  },
};

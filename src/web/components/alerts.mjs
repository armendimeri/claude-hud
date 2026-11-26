import { h, setAttr, setData, show, txt } from './dom.mjs';
import { shortReason } from './format.mjs';
import { glyph, icon } from './status.mjs';

export function createAlertComponents({ motion, timing, effects }) {
  const { since } = timing;
  const { reconcile } = effects;

  function banners(api = {}, summary = null) {
    const list = h('div', { style: 'display:contents' });
    const more = h('button', { class: 'ban-more label', type: 'button', hidden: true });
    const warnings = h('div', { class: 'warnings', role: 'group', 'aria-label': 'Warnings', hidden: true });
    const el = h('div', { class: 'banners', role: 'region', 'aria-label': 'HUD alerts', 'aria-live': 'polite', hidden: true }, list, more, warnings, summary);
    const rows = new Map(), dismissed = new Set();
    const warningRows = new Map(), dismissedWarnings = new Set();
    let expanded = false, last = [], latestWarnings = [], hasWaiting = false;
    const visibility = () => show(el, hasWaiting || !warnings.hidden || (summary && !summary.hidden));
    more.addEventListener('click', e => { e.stopPropagation(); expanded = !expanded; updateWaiting(last); });
    function row(x) {
      const rl = h('span', { class: 'ban-rl' }), rs = h('span', { class: 'ban-rs' });   // the reason, and its short form for narrow screens
      const p = h('span', { class: 'ban-p label' }), t = h('span', { class: 'ban-t trunc' }), r = h('span', { class: 'ban-r' }, rl, rs), tm = h('span', { class: 'ban-tm' });
      const x1 = h('button', { class: 'ban-x', type: 'button', 'aria-label': 'Dismiss', 'data-tip': 'Dismiss until it asks again' }, icon('close'));
      const e = h('div', { class: 'ban cutbox', role: 'button', tabindex: '0' }, h('span', { class: 'ban-w label' }, glyph('needs'), h('span', { text: 'Needs you' })), p, t, r, tm, x1);
      let cur = x;
      x1.addEventListener('click', ev => { ev.stopPropagation(); dismissed.add(cur.id + ':' + cur.needsYou.since); updateWaiting(last); });
      const go = () => api.jump?.(cur.id);
      e.addEventListener('click', go);
      e.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
      return { el: e, set(y) { cur = y; txt(p, y.project || ''); setData(p, 'tip', y.project || null); p.dataset.tipIf = 'trunc'; txt(t, y.title || y.name || 'Untitled session'); t.dataset.tip = y.title || y.name || ''; t.dataset.tipIf = 'trunc'; txt(rl, y.needsYou.reason); txt(rs, shortReason(y.needsYou.reason)); since(tm, y.needsYou.since); setAttr(e, 'aria-label', `${y.project}: ${y.needsYou.reason}. Go to the session.`); } };
    }
    function updateWaiting(sessions) {
      last = sessions;
      const waiting = sessions.filter(x => x.status === 'needs-you' && x.needsYou && !dismissed.has(x.id + ':' + x.needsYou.since)).sort((a, b) => a.needsYou.since - b.needsYou.since);
      const shown = expanded ? waiting : waiting.slice(0, 1);
      reconcile(list, rows, shown, x => x.id, row, (r, x) => r.set(x), !motion.rm);
      hasWaiting = waiting.length > 0;
      visibility();
      show(more, waiting.length > 1);
      txt(more, expanded ? 'Fewer' : `+${waiting.length - 1} more`);
      setAttr(more, 'aria-label', expanded ? 'Show only the longest-waiting session' : `Show all ${waiting.length} waiting sessions`);
      const first = list.firstElementChild;
      if (first && more.parentElement !== first) first.querySelector('.ban-tm').before(more);
      if (!first && more.parentElement !== el) warnings.before(more);
    }
    function warningRow(alert) {
      let current = alert;
      const project = h('span', { class: 'warning-project label trunc', 'data-tip-if': 'trunc' });
      const reason = alert.sessionId && api.jump
        ? h('button', { class: 'warning-text', type: 'button', on: { click: () => api.jump(current.sessionId, current.agentId) } })
        : h('span', { class: 'warning-text' });
      const close = h('button', { class: 'ban-x', type: 'button', on: { click: () => {
        dismissedWarnings.add(current.id);
        updateWarnings(latestWarnings);
      } } }, icon('close'));
      const row = h('div', { class: 'warning', 'data-kind': alert.kind, 'data-alert-id': alert.id },
        h('span', { class: 'warning-label label' }, icon('alert'), h('span', { text: 'Warning' })), project, reason, close);
      return { el: row, set(next) {
        current = next;
        const name = next.project || (next.sessionId ? 'Session' : 'Claude account');
        txt(project, name); setData(project, 'tip', name);
        txt(reason, next.text);
        setAttr(close, 'aria-label', 'Dismiss warning: ' + next.text);
      } };
    }
    function updateWarnings(alerts) {
      latestWarnings = alerts;
      const ids = new Set(alerts.map(a => a.id));
      for (const id of dismissedWarnings) if (!ids.has(id)) dismissedWarnings.delete(id);
      const visible = alerts.filter(a => !dismissedWarnings.has(a.id));
      reconcile(warnings, warningRows, visible, a => a.id, warningRow, (row, a) => row.set(a));
      show(warnings, visible.length > 0);
      visibility();
    }
    return { el, visibility, update(sessions, alerts = []) { updateWaiting(sessions); updateWarnings(alerts); } };
  }

  function awaySummary(onChange = () => {}) {
    const metrics = [['turn-finished', 'turn finished', 'turns finished'], ['agent-done', 'agent done', 'agents done'],
      ['item-changed', 'item changed', 'items changed'], ['needs-you', 'needs-you event', 'needs-you events']];
    const counts = h('ul', { class: 'away-counts' }), needs = h('ul', { class: 'away-needs', 'aria-label': 'Needs-you events while away' });
    const title = h('h2', { class: 'label', text: 'While you were away' });
    const close = h('button', { class: 'ban-x', type: 'button', 'aria-label': 'Dismiss away summary',
      on: { click: () => { show(el, false); onChange(); } } }, icon('close'));
    const el = h('section', { class: 'away-summary', hidden: true }, h('div', { class: 'away-head' }, title, close), counts, needs);
    return { el, update(feed, since) {
      const totals = new Map(metrics.map(([key]) => [key, 0])), waiting = [];
      for (const f of feed) {
        if (f.at < since) continue;
        const key = f.kind === 'needs-you' ? f.kind : f.action;
        if (totals.has(key)) totals.set(key, totals.get(key) + 1);
        if (key === 'needs-you') waiting.push(h('li', {}, f.project ? h('b', { text: f.project + ' · ' }) : null, f.text));
      }
      counts.replaceChildren(...metrics.map(([key, one, many]) => {
        const n = totals.get(key);
        return h('li', {}, h('b', { 'data-action': key, text: n }), ' ' + (n === 1 ? one : many));
      }));
      needs.replaceChildren(...waiting);
      show(needs, waiting.length > 0);
      show(el, true); onChange();
    } };
  }

  return { banners, awaySummary };
}

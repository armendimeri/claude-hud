import { h, setAttr, setData, show, txt } from './dom.mjs';
import { BOARD_MARKS, activeAgents } from './plans.mjs';

const QUEUE_LABELS = { need: 'Needs you', flight: 'In flight', ready: 'Ready', accept: 'To accept', drift: 'Drift' };
const QUEUE_EMPTY = { need: 'No owner inputs waiting', flight: 'No items in flight', ready: 'No items ready to start',
  accept: 'No items waiting for acceptance', drift: 'No board drift' };
export function queueRows(st, plans, labelOf) {
  const board = st.board || {}, rows = { need: [], flight: [], ready: [], accept: [], drift: [] };
  const roots = new Map((st.projects || []).map(p => [p.project, p.root]));
  const nodes = new Map();
  for (const [key, p] of plans) {
    const folder = p.path?.split(/[\\/]docs[\\/]plans[\\/]/i)[0];
    const root = folder && folder !== p.path ? folder : roots.get(p.project);
    for (const n of [...(p.phases || []), ...(p.runs || [])]) {
      nodes.set(`${key}#${n.id}`, { id: n.id, project: p.project, plan: p.title || p.slug, slug: p.slug, title: n.name,
        model: [n.model, n.effort].filter(Boolean).join(' / '), folder: root });
    }
  }
  for (const [key, entries] of [['need', board.ownerInputs], ['ready', board.ready], ['accept', board.awaiting]]) {
    for (const entry of entries || []) {
      const row = nodes.get(`${entry.plan}#${entry.id}`);
      if (row) rows[key].push({ ...row, note: entry.unlocks?.length ? 'Unlocks ' + entry.unlocks.join(', ') : null });
    }
  }
  for (const [key, item] of Object.entries(board.items || {})) {
    const row = nodes.get(key);
    if (!row) continue;
    const agents = activeAgents(item);
    if (agents.length) rows.flight.push({ ...row, agents: agents.map(a => ({ ...a, label: labelOf(a) })) });
    const flags = (item.flags || []).filter(flag => BOARD_MARKS[flag]);
    if (flags.length) rows.drift.push({ ...row, note: flags.map(flag => BOARD_MARKS[flag][0]).join(' · ') });
  }
  return rows;
}

let queueId = 0;
export function workQueue(api = {}) {
  const id = 'work-queue-' + ++queueId;
  const list = h('div', { id, class: 'wq-list', role: 'region', hidden: true });
  const counts = h('div', { class: 'wq-counts' });
  const el = h('section', { class: 'work-queue', 'aria-label': 'Work queue' }, counts, list);
  const buttons = new Map();
  let current = null, rows = {}, listSig = '';
  for (const [key, label] of Object.entries(QUEUE_LABELS)) {
    const total = h('b', { text: 0 });
    const button = h('button', { class: 'wq-count', type: 'button', 'data-queue': key,
      'aria-controls': id, 'aria-expanded': 'false' }, total, h('span', { class: 'label', text: label }));
    button.addEventListener('click', () => { current = current === key ? null : key; draw(); api.layout?.(); });
    buttons.set(key, { button, total }); counts.append(button);
  }
  function copyAction(row) {
    const prompt = `Do ${row.slug}/${row.id}. Follow the workflow-run skill.`;
    const button = h('button', { class: 'btn wq-button', type: 'button', 'aria-label': 'Copy kickoff for ' + row.id, text: 'Copy' });
    const input = h('input', { type: 'text', readonly: true, value: prompt, 'aria-label': 'Kickoff prompt', hidden: true });
    const status = h('span', { role: 'status', class: 'wq-copy-status' });
    button.addEventListener('click', async () => {
      txt(status, '');
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(prompt);
          show(input, false); txt(status, 'Copied'); return;
        }
      } catch {} // Plain HTTP, denied permission, or unavailable clipboard.
      show(input, true); input.focus(); input.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch {}
      if (copied) { button.focus(); show(input, false); }
      txt(status, copied ? 'Copied' : 'Press Ctrl+C');
      api.layout?.();
    });
    return { button, details: h('div', { class: 'wq-copy' }, input, status) };
  }
  function entry(row) {
    const copy = current === 'ready' ? copyAction(row) : null;
    return h('li', { class: 'wq-row' },
      h('div', { class: 'wq-row-main' },
        h('div', { class: 'wq-meta', text: row.project + ' · ' + row.plan }),
        h('div', {}, h('b', { text: row.id }), row.title ? ' · ' + row.title : ''),
        row.model ? h('div', { class: 'wq-meta', text: row.model }) : null,
        row.note ? h('div', { class: current === 'drift' ? 'wq-meta c-amber' : 'wq-meta', text: row.note }) : null,
        copy && row.folder ? h('div', { class: 'wq-folder mono', text: row.folder }) : null),
      copy?.button,
      row.agents?.length ? h('div', { class: 'wq-actions' }, row.agents.map(a =>
        h('button', { type: 'button', class: 'btn plan-agent wq-button', text: a.label, on: { click: () => api.jump?.(a.sessionId, a.agentId) } }))) : null,
      copy?.details);
  }
  function draw() {
    for (const [key, { button, total }] of buttons) {
      const count = rows[key]?.length || 0;
      txt(total, count); setData(button, 'live', count ? key : null);
      setAttr(button, 'aria-expanded', String(current === key));
    }
    show(list, !!current);
    const entries = rows[current] || [], sig = JSON.stringify([current, entries]);
    if (listSig === sig) return;
    listSig = sig;
    setAttr(list, 'aria-label', QUEUE_LABELS[current]);
    if (current) list.replaceChildren(entries.length ? h('ul', { class: 'wq-rows' }, entries.map(entry)) :
      h('p', { class: 'wq-empty', text: QUEUE_EMPTY[current] }));
    else list.replaceChildren();
  }
  return { el, update(next, open = current) { rows = next; current = open; draw(); } };
}

export function quietBoards(toggle) {
  const list = h('div', { class: 'plans', hidden: true });
  const button = h('button', { class: 'quiet-toggle label', type: 'button', 'aria-expanded': 'false',
    on: { click: () => toggle() } });
  const el = h('div', { class: 'quiet-boards', hidden: true }, button, list);
  return { el, list, update(count, expanded) {
    show(el, count > 0); show(list, expanded && count > 0);
    txt(button, `${expanded ? '−' : '+'}${count} quiet ${count === 1 ? 'board' : 'boards'}`);
    setAttr(button, 'aria-expanded', String(expanded && count > 0));
  } };
}

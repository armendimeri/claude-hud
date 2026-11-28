import { h, setAttr, setData, show, txt } from './dom.mjs';
import { ctxLevel, fmtInt, fmtPct, fmtTok, plural, provLetter, provName, shortModel, shortReason, toolIcon } from './format.mjs';
import { headline } from '../data/selectors.mjs';
import { entityKey } from './entity-key.mjs';
import { glyph, icon, provBadge, statusTag } from './status.mjs';

// Sessions the network draws and the vitals count: open ones, plus ended ones for 15 minutes (or while a session
// they launched is still open).
// hud-0-3 D6: an idle session with a running subagent is not waiting for you. The page shows it as "Agents working"
// (a display state only: the API keeps its four statuses and adds `agentsRunning`).
export const viewStatus = x => x.status === 'idle' && x.agentsRunning > 0 ? 'agents' : x.status;
export function shownSessions(sessions, now) {
  const t = now, live = sessions.filter(x => x.status !== 'ended');
  return sessions.filter(x => x.status !== 'ended' || live.some(l => l.startedBy === x.id) || (x.endedAt && t - x.endedAt < 15 * 60_000));
}

/** List the public sessions and running agents in scope, with stable aliases while discreet. */
export function createSessionList({ store, actions, onSelect }) {
  const list = h('ul', { class: 'cp-pre-list', 'aria-label': 'Live sessions and running subagents' });
  const aliases = { Session: new Map(), Agent: new Map() };
  function row(selection, state, project, title, agent = false) {
    const key = entityKey(selection.sessionId, selection.agentId);
    const masked = actions.discreet.get();
    if (masked) {
      const kind = agent ? 'Agent' : 'Session';
      const numbers = aliases[kind];
      if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
      project = '';
      title = `${kind} ${numbers.get(key)}`;
    }
    const tag = statusTag();
    tag.set(state);
    const select = h('button', { type: 'button', class: 'cp-pre-row', 'aria-label': `${project} ${title}`.trim(),
      'data-entity-key': masked ? null : key, on: { click: () => onSelect(selection, select) } },
    tag.el, h('span', { class: 'label', text: project }), h('span', { class: 'cp-pre-title', text: title }));
    return h('li', { class: agent ? 'cp-pre-sub' : null }, select);
  }
  function draw() {
    const project = actions.getProject();
    const sessions = store.getSnapshot()?.sessions ?? [];
    const live = sessions.filter(session => session.status !== 'ended' && (!project || session.project === project));
    const rows = [];
    for (const session of live) {
      rows.push(row({ sessionId: session.id, agentId: null }, viewStatus(session),
        session.project || '', session.title || session.name || 'Untitled session'));
      for (const agent of (session.subagents || []).filter(a => a.state === 'running')) {
        rows.push(row({ sessionId: session.id, agentId: agent.id }, 'running', '', agent.description || agent.type || 'Subagent', true));
      }
    }
    list.replaceChildren(...rows);
    show(list, rows.length > 0);
  }
  const stop = store.subscribe(event => { if (event.type === 'snapshot') draw(); });
  const stopProject = actions.subscribeProject(draw);
  const stopDiscreet = actions.discreet.subscribe(draw);
  draw();
  return { el: list, close() { stop(); stopProject(); stopDiscreet(); list.remove(); } };
}

function contextMeter(label = 'Context') {
  const fill = h('span', { class: 'bar-f' });
  const bar = h('span', { class: 'bar bar-ctx' }, fill, h('span', { class: 'bar-m m70' }), h('span', { class: 'bar-m m90' }));
  const val = h('span', { class: 'mv mono' }), note = h('span', { class: 'mn mono' });
  const el = h('div', { class: 'meter m-ctx' }, h('span', { class: 'ml label', text: label }), bar, val, note);
  return {
    el,
    set(c) {
      const p = c ? c.pct : null;
      setData(el, 'lvl', ctxLevel(p));
      fill.style.transform = `scaleX(${p == null ? 0 : Math.min(1, p / 100)})`;
      txt(val, fmtPct(p));
      txt(note, c ? `${fmtTok(c.used)} of ${fmtTok(c.window)}` : 'window unknown');
    },
  };
}
function tokenMeter() {
  const fo = h('span', { class: 'bar-f seg-out' }), fw = h('span', { class: 'bar-f seg-cw' }), fi = h('span', { class: 'bar-f seg-in' });
  const val = h('span', { class: 'mv mono' }), note = h('span', { class: 'mn mono', 'data-tip-if': 'trunc' }), split = h('span', { class: 'msplit mono', 'data-tip-if': 'trunc' });
  const el = h('div', { class: 'meter m-tok' }, h('span', { class: 'ml label', text: 'Tokens' }), h('span', { class: 'bar bar-tok' }, fo, fw, fi), val, note, h('span'), split);
  return {
    el,
    set(t, tree, max) {
      t = t || {}; const tot = headline(t), k = max > 0 ? Math.min(1, tot / max) : 0;
      const o = tot ? (t.output || 0) / tot * k : 0, w = tot ? (t.cacheWrite || 0) / tot * k : 0, i = tot ? (t.input || 0) / tot * k : 0;
      fo.style.transform = `scaleX(${o})`;
      fw.style.transform = `translateX(${o * 100}%) scaleX(${w})`;
      fi.style.transform = `translateX(${(o + w) * 100}%) scaleX(${i})`;
      txt(val, fmtTok(tot));
      const tt = headline(tree);
      txt(note, tree && tt > tot ? `incl. subagents ${fmtTok(tt)}` : '');
      txt(split, `in ${fmtTok(t.input)} · out ${fmtTok(t.output)} · cache write ${fmtTok(t.cacheWrite)}`); split.dataset.tip = split.textContent; note.dataset.tip = note.textContent;
    },
  };
}
function cacheMeter() {
  const f = h('span', { class: 'bar-f' }), val = h('span', { class: 'mv mono' });
  const el = h('div', { class: 'meter m-cr' }, h('span', { class: 'ml label', text: 'Cache read' }), h('span', { class: 'bar bar-cr' }, f), val, h('span', { class: 'mn mono', text: 'context re-read, shown apart', 'data-tip': 'Cache reads re-count the same context on every turn, so they are kept out of the token total', 'data-tip-if': 'trunc' }));
  return { el, set(n, max) { f.style.transform = `scaleX(${max > 0 ? Math.min(1, n / max) : 0})`; txt(val, fmtTok(n)); } };
}

export function workText(work, plans) {
  return (work?.items || []).map(item => {
    const key = item.plan || work.plan;
    const plan = plans?.get(key);
    return `On ${item.id} · ${plan?.title || plan?.slug || key.slice(key.indexOf('|') + 1)}`;
  }).join(' · ');
}
function workLabel(cls = '') {
  const el = h('span', { class: 'work-label trunc ' + cls, hidden: true, 'data-tip-if': 'trunc' });
  return { el, set(work, plans) {
    const text = workText(work, plans);
    txt(el, text); show(el, !!text); setData(el, 'tip', text);
    return !!text;
  } };
}
export function projectLabel(api, cls, fallback = '—') {
  const el = api.project ? h('button', { class: cls + ' project-button', type: 'button' }) : h('span', { class: cls });
  if (api.project) el.addEventListener('click', e => { e.stopPropagation(); api.project(el.dataset.project); });
  return { el, set(name) {
    txt(el, name || fallback);
    setData(el, 'project', name);
    setData(el, 'tip', name);
    if (api.project) {
      el.disabled = !name;
      setAttr(el, 'aria-pressed', String(!!name && api.focused?.() === name));
    }
  } };
}
function windowLink(compact = false) {
  const label = 'Open in VS Code';
  const el = h('a', { class: 'window-link chip', hidden: true, 'aria-label': label, 'data-tip': label },
    icon('window'), compact ? null : label);
  el.addEventListener('click', e => e.stopPropagation());
  return { el, set(session) {
    let href = null;
    if (['localhost', '127.0.0.1'].includes(location.hostname) && /vscode/i.test(session.entrypoint || '') && session.cwd) {
      const path = session.cwd.replace(/\\/g, '/');
      const parts = path.split('/');
      const encoded = parts.map((part, i) => i === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part)).join('/');
      href = 'vscode://file' + (path.startsWith('/') ? '' : '/') + encoded;
    }
    setAttr(el, 'href', href);
    show(el, !!href);
  } };
}
/** The "Inspect" control of a card or row: opens the shared inspector for this session. Null when the page has none. */
function inspectButton(api, compact = false) {
  if (!api.inspect) return { el: null, set() {} };
  let current = null;
  const el = h('button', { class: 'chip inspect-btn', type: 'button' }, icon('search'), compact ? null : h('span', { text: 'Inspect' }));
  el.addEventListener('click', e => { e.stopPropagation(); if (current) api.inspect({ sessionId: current.id, agentId: null }, el); });
  return { el, set(x) {
    current = x;
    const name = x.title || x.name || 'Untitled session';
    setAttr(el, 'aria-label', 'Inspect ' + name);
    setAttr(el, 'data-tip', 'Inspect');
  } };
}
export function createSessionComponents({ lifetime, motion, now, timing, effects }) {
  const { since, age, activityLine } = timing;
  const { glitch, reconcile } = effects;

  function nowLine() {
    const ic = h('span', { style: 'display:flex' }), name = h('span', { class: 'now-n' });
    const sum = h('span', { class: 'now-s trunc', 'data-tip-if': 'trunc' }), tm = h('span', { class: 'now-t mono' });
    const el = h('div', { class: 'now' }, ic, name, sum, tm);
    let icName = null;
    const setIcon = n => { if (n !== icName) { icName = n; ic.replaceChildren(icon(n)); } };
    return {
      el,
      set(x) {
        const tool = x.currentTool, t = now();
        let k, n, ss = '';
        since(tm, null); age(tm, null);
        if (x.status === 'needs-you') {
          k = 'needs'; setIcon('alert'); n = x.needsYou?.reason || 'Needs you';
          ss = tool ? `${tool.name}${tool.summary ? ' · ' + tool.summary : ''}` : '';
          since(tm, x.needsYou?.since);
        } else if (x.status === 'busy' && tool) {
          k = 'tool'; setIcon(toolIcon(tool.name)); n = tool.name; ss = tool.summary || ''; since(tm, tool.since);
        } else if (x.status === 'busy') {
          k = 'think'; setIcon('clock'); n = 'Working'; ss = 'between tools';
        } else if (viewStatus(x) === 'agents') {
          k = 'agents'; setIcon('agent'); n = 'Agents working'; ss = plural(x.agentsRunning, 'subagent running', 'subagents running');
        } else if (x.status === 'idle') {
          const fresh = x.lastActivityAt && t - x.lastActivityAt < 90_000;
          k = fresh ? 'fresh' : 'idle'; setIcon(fresh ? 'check' : 'clock'); n = fresh ? 'Just finished' : 'Idle';
          age(tm, x.lastActivityAt, fresh ? '' : 'for ', fresh ? ' ago' : '');
        } else {
          k = 'ended'; setIcon('close'); n = 'Ended'; age(tm, x.endedAt || x.lastActivityAt, '', ' ago');
        }
        setData(el, 'k', k); txt(name, n); txt(sum, ss); setData(sum, 'tip', ss || null);
      },
    };
  }

  function subRow() {
    const g = h('span', { class: 'sub-g' }), typ = h('b'), desc = h('span');
    const name = h('span', { class: 'sub-n trunc', 'data-tip-if': 'trunc' }, typ, desc);
    const work = workLabel();
    const model = h('span', { class: 'sub-m trunc' }), k = h('span', { class: 'sub-k' }), c = h('span', { class: 'sub-c' });
    const sw = h('span'), st = h('span', { class: 'mono', style: 'margin-left:8px;letter-spacing:0' });
    const el = h('div', { class: 'sub', tabindex: '-1' }, g, h('span', { class: 'sub-label' }, name, work.el), model, k, c, h('span', { class: 'sub-s label' }, sw, st));
    let prev = null;
    return {
      el,
      set(a, d, plans) {
        setData(el, 's', a.state); setData(el, 'd', d); el.style.setProperty('--d', d);
        setData(el, 'id', a.id); setData(el, 'work', work.set(a.work, plans) ? '1' : null);
        if (prev !== a.state) {
          g.replaceChildren(glyph(a.state === 'done' ? 'done' : 'running'));
          if (prev === 'running' && a.state === 'done') { el.classList.remove('just-done'); void el.offsetWidth; el.classList.add('just-done'); lifetime.delay(() => el.classList.remove('just-done'), 1600); }
          prev = a.state;
        }
        txt(typ, a.type || 'agent'); txt(desc, a.description || '');
        name.dataset.tip = `${a.type || 'agent'} · ${a.description || ''}`;
        txt(model, shortModel(a.model)); setData(model, 'tip', a.modelRaw ? `${a.modelRaw} · ${provName(a.provider)}` : null);
        txt(k, fmtTok(headline(a.tokens)));
        txt(c, a.context ? fmtPct(a.context.pct) : '—'); setData(c, 'lvl', ctxLevel(a.context?.pct));
        if (a.state === 'running') { txt(sw, 'Running'); since(st, a.startedAt); } else { txt(sw, 'Done'); since(st, null); }
      },
    };
  }
  // A session's subagents in tree order; deeper than 3 levels, and old finished ones beyond 4, fold into one line.
  function subTree(subs, rootId) {
    const ids = new Set(subs.map(a => a.id)), kids = new Map();
    for (const a of subs) { const p = ids.has(a.parentId) ? a.parentId : rootId; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(a); }
    const out = [];
    const walk = (p, d) => { for (const a of (kids.get(p) || []).sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0))) { out.push([a, d]); walk(a.id, d + 1); } };
    walk(rootId, 1);
    return { list: out, kids };
  }
  function subList() {
    const rowsEl = h('div'), more = h('div', { class: 'sub-more label', hidden: true });
    const el = h('div', { class: 'subs', hidden: true }, rowsEl, more);
    const rows = new Map();
    return {
      el,
      update(subs, rootId, plans) {
        show(el, subs.length > 0);
        const { list, kids } = subTree(subs, rootId);
        const keepUp = new Set();
        const runningBelow = id => (kids.get(id) || []).some(k => k.state === 'running' || runningBelow(k.id));
        for (const [a] of list) if (a.state === 'done' && runningBelow(a.id)) keepUp.add(a.id);
        let deeper = 0;
        let vis = list.filter(([, d]) => d <= 3 || (deeper++, false));
        const done = vis.filter(([a]) => a.state === 'done' && !keepUp.has(a.id)).sort((x, y) => (y[0].endedAt || 0) - (x[0].endedAt || 0));
        const hide = new Set(done.slice(4).map(([a]) => a.id));
        vis = vis.filter(([a]) => !hide.has(a.id));
        reconcile(rowsEl, rows, vis, ([a]) => a.id, () => subRow(), (r, [a, d]) => r.set(a, d, plans));
        const bits = [];
        if (hide.size) bits.push(`+${hide.size} earlier finished`);
        if (deeper) bits.push(`+${deeper} more, deeper`);
        txt(more, bits.join(' · ')); show(more, bits.length > 0);
      },
    };
  }

  function sessionCard(api = {}) {
    const proj = projectLabel(api, 'label trunc', 'Unknown project'), tag = statusTag(), openWindow = windowLink();
    const title = h('h3', { class: 'card-title trunc', 'data-tip-if': 'trunc' });
    const mChip = h('span', { class: 'chip' });
    const bName = h('span', { class: 'trunc' }), bChip = h('span', { class: 'card-br mono', 'data-tip-if': 'trunc' }, icon('branch'), bName);
    const prov = provBadge(), inspect = inspectButton(api);
    const sbyName = h('span', { class: 'trunc' });
    const sby = h('button', { class: 'chip', type: 'button', hidden: true }, icon('agent'), h('span', { text: 'Started by' }), sbyName);
    const ageEl = h('span'), toolsEl = h('span');
    const nowRow = nowLine(), tok = tokenMeter(), cr = cacheMeter(), ctx = contextMeter(), subs = subList();
    const sumEl = h('div', { class: 'card-sum' }), work = workLabel('card-work'), activity = activityLine();
    const el = h('article', { class: 'card cutbox', tabindex: '-1' },
      h('div', { class: 'card-scan', 'aria-hidden': 'true' }), h('div', { class: 'card-glow', 'aria-hidden': 'true' }),
      h('header', { class: 'card-h' }, h('div', { class: 'card-proj' }, proj.el, bChip), h('span', { class: 'card-meta mono' }, ageEl, ' · ', toolsEl), tag.el),
      h('div', { class: 'card-tr' }, title, h('div', { class: 'card-chips' }, mChip, prov.el, sby, openWindow.el, inspect.el)),
      sumEl, work.el, nowRow.el, h('div', { class: 'meters' }, tok.el, cr.el, ctx.el), activity.el, subs.el);
    let st = null, sbyId = null;
    sby.addEventListener('click', e => { e.stopPropagation(); if (sbyId) api.jump?.(sbyId); });
    return {
      el,
      update(x, c = {}) {
        const vs = viewStatus(x);
        if (st && st !== vs) glitch(el);
        st = vs; setData(el, 's', st); setData(el, 'id', x.id); setData(el, 'entityKey', entityKey(x.id));
        proj.set(x.project); setData(el, 'project', x.project);
        openWindow.set(x); inspect.set(x);
        tag.set(vs);
        const t = x.title || x.name || 'Untitled session';
        txt(title, t); title.dataset.tip = t;
        txt(mChip, [x.agent === 'codex' ? 'Codex' : 'Claude Code', shortModel(x.model) || 'model unknown', x.effort].filter(Boolean).join(' · '));
        setData(mChip, 'tip', x.modelRaw ? 'Model id: ' + x.modelRaw : null);
        show(bChip, !!x.branch); txt(bName, x.branch || ''); setData(bChip, 'tip', x.branch ? 'Branch ' + x.branch : null);
        prov.set(x.provider, x.modelRaw);
        sbyId = x.startedBy || null; show(sby, !!sbyId);
        if (sbyId) {
          const p = c.byId && c.byId.get(sbyId);
          const who = p ? (p.title || p.name || p.project) : 'session ' + sbyId.slice(0, 8);
          txt(sbyName, who); setData(sby, 'tip', `Launched from the shell of “${who}”. Click to go to it.`);
        }
        age(ageEl, x.startedAt); txt(toolsEl, plural(x.tools || 0, 'tool', 'tools'));
        nowRow.set(x);
        tok.set(x.tokens, x.tokensTree, c.maxTok);
        cr.set(x.tokens?.cacheRead || 0, c.maxCache);
        ctx.set(x.context);
        activity.set(x.pulse, x.turn);
        work.set(x.work, c.plans);
        subs.update(x.subagents || [], x.id, c.plans);
        if (st === 'ended') txt(sumEl, [shortModel(x.model), provName(x.provider), `${fmtTok(headline(x.tokens))} tokens`, plural(x.tools || 0, 'tool', 'tools'), (x.subagents || []).length ? plural(x.subagents.length, 'subagent', 'subagents') : null].filter(Boolean).join(' · '));
      },
    };
  }
  function compactRow(api = {}) {
    const tag = statusTag();
    const p = projectLabel(api, 'cr-p label trunc'), t = h('span', { class: 'cr-t trunc', 'data-tip-if': 'trunc' });
    const openWindow = windowLink(true), inspect = inspectButton(api, true);
    const m = h('span', { class: 'cr-m trunc' }), v = h('span', { class: 'cr-v' });
    const wIc = h('span', { style: 'display:flex' }), wT = h('span', { class: 'trunc', 'data-tip-if': 'trunc' }), wTm = h('span', { class: 'mono' });
    const k = h('span', { class: 'cr-k' }), c = h('span', { class: 'cr-c' }), n = h('span', { class: 'cr-n' });
    const work = workLabel();
    const el = h('div', { class: 'crow', tabindex: '-1' }, tag.el, p.el,
      h('span', { class: 'cr-title' }, h('span', { class: 'cr-title-line' }, openWindow.el, inspect.el, t), work.el),
      m, v, h('span', { class: 'cr-w' }, wIc, wT, wTm), k, c, n);
    let icName = null, st = null;
    el.addEventListener('click', () => api.open?.(el.dataset.id));
    return {
      el,
      update(x, cxt = {}) {
        const vs = viewStatus(x);
        if (st && st !== vs) glitch(el);
        st = vs; setData(el, 's', vs); setData(el, 'id', x.id); setData(el, 'entityKey', entityKey(x.id));
        tag.set(vs);
        p.set(x.project); setData(el, 'project', x.project);
        openWindow.set(x); inspect.set(x);
        const title = x.title || x.name || 'Untitled session'; txt(t, title); t.dataset.tip = title;
        setData(el, 'work', work.set(x.work, cxt.plans) ? '1' : null);
        txt(m, (x.agent === 'codex' ? 'Codex · ' : '') + shortModel(x.model)); setData(m, 'tip', x.modelRaw);
        txt(v, provLetter(x.provider)); setData(v, 'p', x.provider); setData(v, 'tip', 'Runs on ' + provName(x.provider));
        let ic = 'clock', w = '';
        since(wTm, null); age(wTm, null);
        let tipW = '';
        if (x.status === 'needs-you') { ic = 'alert'; tipW = x.needsYou?.reason || 'Needs you'; w = shortReason(tipW); since(wTm, x.needsYou?.since); }
        else if (x.currentTool) { ic = toolIcon(x.currentTool.name); w = `${x.currentTool.name} · ${x.currentTool.summary || ''}`; }
        else if (vs === 'agents') { ic = 'agent'; w = plural(x.agentsRunning, 'subagent running', 'subagents running'); }
        else if (x.status === 'idle') age(wTm, x.lastActivityAt, 'for ');   // the status tag already says idle / ended
        else if (x.status === 'ended') { ic = 'close'; age(wTm, x.endedAt, '', ' ago'); }
        if (ic !== icName) { icName = ic; wIc.replaceChildren(icon(ic)); }
        txt(wT, w); wT.dataset.tip = tipW || w;
        txt(k, fmtTok(headline(x.tokens))); setData(k, 'tip', `${fmtInt(headline(x.tokens))} tokens · cache read ${fmtTok(x.tokens?.cacheRead)}`);
        txt(c, x.context ? fmtPct(x.context.pct) : '—'); setData(c, 'lvl', ctxLevel(x.context?.pct));
        const running = (x.subagents || []).filter(a => a.state === 'running').length;
        txt(n, running ? '+' + running : ''); setData(n, 'tip', running ? plural(running, 'subagent running', 'subagents running') : null);
      },
    };
  }


  return { contextMeter, tokenMeter, cacheMeter, sessionCard, compactRow, subList };
}

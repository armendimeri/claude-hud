import { h, s, setAttr, setData, show, txt } from './dom.mjs';
import { pad2, plural } from './format.mjs';
import { hexPts, placeFlow } from './geometry.mjs';
import { projectLabel } from './sessions.mjs';
import { STATUS, glyph, icon, statusTag } from './status.mjs';
import { boardPlanKey } from '../data/selectors.mjs';

export const DONE_STATES = new Set(['accepted', 'done', 'handed-off']);
export const BOARD_MARKS = { unclaimed: ['Board not updated', '!'], stalled: ['Stalled', 'Ⅱ'], early: ['Started early', '↑'] };
export const activeAgents = item => (item?.agents || []).filter(a => a.active);
let planDetailId = 0;

export function createPlanComponents(tip) {
  function planLayout(nodes, horizontal) {
    const ids = new Set(nodes.map(n => n.id));
    const deps = new Map(nodes.map(n => [n.id, (n.waitsFor || []).filter(d => ids.has(d) && d !== n.id)]));
    const layer = new Map();
    const lay = (id, stack) => {
      if (layer.has(id)) return layer.get(id);
      if (stack.has(id)) return 0;
      stack.add(id); let l = 0; for (const d of deps.get(id)) l = Math.max(l, lay(d, stack) + 1); stack.delete(id);
      layer.set(id, l); return l;
    };
    nodes.forEach(n => lay(n.id, new Set()));
    const L = [];
    for (const n of nodes) { const l = layer.get(n.id); (L[l] = L[l] || []).push(n); }
    const idx = new Map();
    L.forEach((list = [], li) => {
      if (li > 0) list.sort((a, b) => bary(a) - bary(b));
      list.forEach((n, k) => idx.set(n.id, k));
    });
    function bary(n) { const ds = deps.get(n.id); return ds.length ? ds.reduce((t, d) => t + (idx.get(d) ?? 0), 0) / ds.length : 99; }
    const per = Math.max(1, ...L.map(l => (l || []).length));
    const step = horizontal ? 80 : 84, cross = horizontal ? 60 : 64, pad = 26;
    const pos = new Map();
    L.forEach((list = [], li) => list.forEach((n, k) => {
      const c = pad + (k + (per - list.length) / 2) * cross, m = pad + li * step;
      pos.set(n.id, horizontal ? { x: m, y: c } : { x: c, y: m });
    }));
    const along = pad * 2 + Math.max(0, L.length - 1) * step, across = pad * 2 + (per - 1) * cross + 18;
    return { pos, deps, w: horizontal ? along : across, h: horizontal ? across : along + 18, horizontal };
  }
  function planNodeCard(n, info = {}, jump) {
    const tag = statusTag(); tag.set(STATUS[n.state] ? n.state : 'unknown', null, n.stateRaw && n.stateRaw !== n.state ? n.stateRaw : null);
    const agentRows = (info.agents || []).map(({ label, sessionId, active }) => {
      const text = label + (active ? ' · active' : ' · idle');
      return jump ? h('button', { type: 'button', class: 'btn plan-agent', text, on: { click: () => jump(sessionId) } }) : h('span', { text });
    });
    return h('div', { class: 'tc' },
      h('div', { class: 'tc-h' }, tag.el, n.group && n.group !== 'Board' ? h('span', { class: 'label c-ink2 trunc', text: n.group }) : null),
      h('div', { class: 'tc-t', text: `${n.id} · ${n.name || ''}` }),
      h('div', { class: 'tc-r' }, n.agent ? h('span', {}, 'agent ', h('b', { text: n.agent })) : null, n.model ? h('span', { text: [n.model, n.effort].filter(Boolean).join(' / ') }) : null, n.since ? h('span', { text: 'since ' + n.since }) : null),
      (n.waitsFor?.length || n.waitsForOther?.length) ? h('div', { class: 'tc-r', text: 'waits for ' + [...(n.waitsFor || []), ...(n.waitsForOther || [])].join(', ') }) : null,
      n.notes ? h('div', { class: 'tc-n', text: n.notes }) : null,
      agentRows.length ? h('div', { class: 'tc-r plan-agents', 'aria-label': 'Linked agents' }, agentRows) : null,
      info.flags?.length ? h('div', { class: 'tc-r plan-flags', text: info.flags.map(flag => BOARD_MARKS[flag][0]).join(' · ') }) : null,
      info.history?.length ? h('div', { class: 'tc-r plan-history', 'aria-label': 'Recent changes' }, info.history.map(entry => {
        const time = new Date(entry.at);
        const state = entry.to === 'in-progress' && entry.label ? `claimed by ${entry.label}` :
          `${entry.from} → ${entry.to}${entry.label ? ' by ' + entry.label : ''}`;
        return h('div', {}, h('time', { class: 'mono', datetime: time.toISOString(), text: pad2(time.getHours()) + ':' + pad2(time.getMinutes()) }), ' · ', state);
      })) : null);
  }
  // Circuit-style elbow from a to b; returns the SVG path and its straight segments (for the flow strips).
  function elbow(a, b, horizontal) {
    const segs = [];
    if (horizontal) {
      const mx = Math.round((a.x + b.x) / 2), dy = b.y - a.y, sg = Math.sign(dy), rr = Math.min(6, Math.abs(dy) / 2, (b.x - a.x) / 4);
      if (Math.abs(dy) < 1) return { d: `M${a.x} ${a.y}H${b.x}`, segs: [[a, b]] };
      segs.push([a, { x: mx, y: a.y }], [{ x: mx, y: a.y }, { x: mx, y: b.y }], [{ x: mx, y: b.y }, b]);
      return { d: `M${a.x} ${a.y}H${mx - rr}Q${mx} ${a.y} ${mx} ${a.y + sg * rr}V${b.y - sg * rr}Q${mx} ${b.y} ${mx + rr} ${b.y}H${b.x}`, segs };
    }
    const my = Math.round((a.y + b.y) / 2), dx = b.x - a.x, sg = Math.sign(dx), rr = Math.min(6, Math.abs(dx) / 2, (b.y - a.y) / 4);
    if (Math.abs(dx) < 1) return { d: `M${a.x} ${a.y}V${b.y}`, segs: [[a, b]] };
    segs.push([a, { x: a.x, y: my }], [{ x: a.x, y: my }, { x: b.x, y: my }], [{ x: b.x, y: my }, b]);
    return { d: `M${a.x} ${a.y}V${my - rr}Q${a.x} ${my} ${a.x + sg * rr} ${my}H${b.x - sg * rr}Q${b.x} ${my} ${b.x} ${my + rr}V${b.y}`, segs };
  }
  function planGraph(detailId, open, preview) {
    const svg = s('svg', { role: 'group' });
    const fx = h('div', { class: 'pg-fx', 'aria-hidden': 'true' });
    const box = h('div', { class: 'pg-box' }, svg, fx);
    const wrap = h('div', { class: 'plan-g' }, box);
    let sig = '';
    function mark(n, x, y, R) {
      const bx = x + R * 0.72, by = y - R * 0.72, st = n.state;
      const d = st === 'accepted' || st === 'done' ? `M${bx - 3} ${by + 0.2}l2 2 4-4.2` : st === 'handed-off' ? `M${bx - 3.5} ${by}h6M${bx + 0.5} ${by - 2.5}l2.5 2.5-2.5 2.5`
        : st === 'blocked' ? `M${bx} ${by - 3.5}v3.8M${bx} ${by + 2.8}v.3` : st === 'bounced' ? `M${bx + 3} ${by - 2}h-4a2 2 0 0 0 0 4h1M${bx - 2.5} ${by - 4}l-2 2 2 2`
        : st === 'partial' ? `M${bx - 1.75} ${by - 3}v6M${bx + 1.75} ${by - 3}v6` : null;   // partial: paused part-way
      return d ? [s('circle', { class: 'pn-badge', cx: bx, cy: by, r: 7 }), s('path', { class: 'pn-mark', d })] : [];
    }
    return {
      el: wrap,
      select(id) {
        for (const g of svg.querySelectorAll('.pn')) setAttr(g, 'aria-expanded', String(g.dataset.id === id));
      },
      focus(id) { [...svg.querySelectorAll('.pn')].find(g => g.dataset.id === id)?.focus(); },
      update(nodes, items, key, selected) {
        const width = wrap.clientWidth || 300;
        const views = new Map(nodes.map(n => {
          const item = items[`${key}#${n.id}`];
          return [n.id, { count: activeAgents(item).length, flags: (item?.flags || []).filter(flag => BOARD_MARKS[flag]) }];
        }));
        const sigNow = JSON.stringify([width, nodes.map(n => [n.id, n.name, n.state, n.agent, n.kind, n.waitsFor, views.get(n.id)])]);
        if (sigNow === sig) return; sig = sigNow;
        const focused = svg.contains(document.activeElement) ? document.activeElement.dataset.id : null;
        if (svg.contains(tip.anchor)) tip.close();
        let G = planLayout(nodes, true);
        if (G.w > width) { const V = planLayout(nodes, false); if (V.w <= width) G = V; }
        setAttr(svg, 'width', G.w); setAttr(svg, 'height', G.h); setAttr(svg, 'viewBox', `0 0 ${G.w} ${G.h}`);
        box.style.width = G.w + 'px'; box.style.height = G.h + 'px';
        const byId = new Map(nodes.map(n => [n.id, n])), out = [], fxKids = [];
        for (const n of nodes) for (const d of G.deps.get(n.id)) {
          const a = G.pos.get(d), b = G.pos.get(n.id), from = byId.get(d);
          const count = views.get(n.id).count, flowing = n.state === 'in-progress' || count > 0;
          const cls = flowing ? 'pe flow' : n.state === 'blocked' || n.state === 'bounced' ? 'pe alert' : DONE_STATES.has(from.state) ? 'pe done' : 'pe';
          const E = G.horizontal ? elbow({ x: a.x + 20, y: a.y }, { x: b.x - 20, y: b.y }, true) : elbow({ x: a.x, y: a.y + 40 }, { x: b.x, y: b.y - 22 }, false);
          out.push(s('path', { class: cls, d: E.d }));
          if (flowing) for (const [p, q] of E.segs) {
            if (Math.hypot(q.x - p.x, q.y - p.y) < 2) continue;
            const f = h('div', { class: 'eflow plan', 'data-active': count ? '1' : null }, h('i')); placeFlow(f, p, q); fxKids.push(f);
          }
        }
        for (const n of nodes) {
          const p = G.pos.get(n.id), st = STATUS[n.state] ? n.state : 'unknown', input = n.kind === 'input';
          const { count, flags } = views.get(n.id);
          const R = n.id.length > 4 ? 21 : 18, D = R + 2;   // a long id ("UX-10") gets a bigger shape, so it never touches the outline
          const shape = input ? `${p.x},${p.y - D} ${p.x + D},${p.y} ${p.x},${p.y + D} ${p.x - D},${p.y}` : hexPts(R).split(' ').map(q => { const [x, y] = q.split(',').map(Number); return (x + p.x).toFixed(2) + ',' + (y + p.y).toFixed(2); }).join(' ');
          const label = [`${n.id} ${n.name || ''}: ${(STATUS[st] || STATUS.unknown)[1]}`, n.agent && 'agent ' + n.agent,
            count && plural(count, 'active agent', 'active agents'), ...flags.map(flag => BOARD_MARKS[flag][0])].filter(Boolean).join(', ');
          const badge = (x, y, circle, text, word, r = 7) => [
            s('circle', { class: circle, cx: x, cy: y, r }), s('text', { class: text, x, y }, word),
          ];
          const g = s('g', { class: 'pn', 'data-id': n.id, 'data-s': st, 'data-active': count || null, tabindex: '0', role: 'button',
            'aria-label': label, 'aria-controls': detailId, 'aria-expanded': String(selected === n.id) },
            s('circle', { class: 'pn-focus', cx: p.x, cy: p.y, r: R + 6 }),
            s('polygon', { class: 'pn-hex', points: shape }),
            s('text', { class: 'pn-id', x: p.x, y: p.y + 0.5, style: n.id.length > 4 ? 'letter-spacing:0' : null }, n.id),
            mark(n, p.x, p.y, R),
            count ? badge(p.x - R * .72, p.y - R * .72, 'pn-active', 'pn-count', count > 99 ? '99+' : count, 8) : null,
            flags.map((flag, i) => s('g', { 'data-flag': flag },
              badge(p.x + (i - (flags.length - 1) / 2) * 13, p.y + R - 1, 'pn-drift', 'pn-flag', BOARD_MARKS[flag][1], 6))),
            n.agent || input ? s('text', { class: 'pn-ag', x: p.x, y: p.y + R + 16 }, (input ? 'you' : n.agent).slice(0, 12)) : null);
          const peek = () => { if (g.getAttribute('aria-expanded') === 'false') tip.open(g, preview(n.id)); };
          const close = () => tip.close(g);
          g.addEventListener('pointerenter', peek); g.addEventListener('pointerleave', close);
          g.addEventListener('focus', peek); g.addEventListener('blur', close);
          g.addEventListener('click', () => { close(); open(n.id); });
          g.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); close(); open(n.id); }
          });
          out.push(g);
          if (count || st === 'in-progress') fxKids.push(h('div', { class: 'pg-pulse', 'data-active': count ? '1' : null, 'data-id': n.id,
            style: `left:${p.x}px;top:${p.y}px` }, s('svg', { viewBox: '-22 -22 44 44' }, s('polygon', { points: input ? '0,-20 20,0 0,20 -20,0' : hexPts(Math.min(R, 21)) }))));
        }
        svg.replaceChildren(...out);
        fx.replaceChildren(...fxKids);
        if (focused) this.focus(focused);
      },
    };
  }
  function planCard(api = {}) {
    const proj = projectLabel(api, 'plan-p label trunc', '');
    const need = h('span', { class: 'chip', style: 'color:var(--alert);border-color:rgba(255,77,94,.5)', hidden: true }, icon('alert'), 'Needs you');
    const live = h('span', { class: 'chip', style: 'color:var(--arc);border-color:rgba(41,230,255,.5)', hidden: true }, 'Working');
    const stChip = h('span', { class: 'chip plan-state', hidden: true }), count = h('span', { class: 'plan-c' });
    const title = h('h3', { class: 'plan-t trunc', 'data-tip-if': 'trunc' });
    const detailId = 'plan-detail-' + ++planDetailId;
    const detailBody = h('div');
    const close = h('button', { type: 'button', class: 'tgl plan-detail-close', 'aria-label': 'Close item details',
      on: { click: closeDetail } }, icon('close'));
    const detail = h('div', { id: detailId, class: 'plan-detail', tabindex: '-1', hidden: true }, close, detailBody);
    const graph = planGraph(detailId, select, id => planNodeCard(nodes.get(id), infoFor(id)));
    const needs = h('div'), runs = h('div', { class: 'plan-runs', hidden: true }), log = h('p', { class: 'plan-log', hidden: true });
    const el = h('article', { class: 'plan' }, h('header', { class: 'plan-h' }, proj.el, live, need, stChip, count), title, graph.el, needs, runs, detail, log);
    let needSig = null, runSig = null;   // the need rows and run chips are rebuilt only when their text changed
    let plan, items = {}, labelOf = () => 'Agent', nodes = new Map(), selected = null, detailSig = '';
    function infoFor(id) {
      const item = items[`${boardPlanKey(plan)}#${id}`];
      return {
        agents: (item?.agents || []).map(a => ({ ...a, label: labelOf(a) })),
        flags: (item?.flags || []).filter(flag => BOARD_MARKS[flag]),
        history: (plan.history || []).filter(entry => entry.id === id).slice(-3).reverse().map(entry => ({
          ...entry, label: entry.sessionId ? labelOf(entry) : null,
        })),
      };
    }
    function drawDetail() {
      const node = nodes.get(selected);
      show(detail, !!node);
      if (!node) {
        if (detailSig) { detailSig = ''; detailBody.replaceChildren(); }
        return;
      }
      const info = infoFor(selected);
      const sig = JSON.stringify([node, info]);
      if (sig === detailSig) return;
      detailSig = sig;
      detailBody.replaceChildren(planNodeCard(node, info, api.jump));
    }
    function select(id) {
      selected = selected === id ? null : id;
      tip.close();
      graph.select(selected);
      for (const button of runs.children) setAttr(button, 'aria-expanded', String(button.dataset.id === selected));
      drawDetail();
      if (selected) detail.focus();
      api.layout?.();
    }
    function closeDetail() {
      const id = selected;
      select(id);
      const run = [...runs.children].find(button => button.dataset.id === id);
      if (run) run.focus(); else graph.focus(id);
    }
    detail.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetail(); });
    return {
      el,
      update(p, board = {}, nameOf = labelOf) {
        plan = p; items = board.items || {}; labelOf = nameOf;
        const all = p.phases || [], key = boardPlanKey(p), working = board.plans?.[key]?.active || 0;
        nodes = new Map([...all, ...(p.runs || [])].map(n => [n.id, n]));
        if (!nodes.has(selected)) selected = null;
        proj.set(p.project); setData(proj.el, 'tip', p.path ? 'From ' + p.path : null);
        txt(title, p.title || p.slug); title.dataset.tip = p.title || p.slug;
        show(live, working > 0); txt(live, 'Working ' + working);
        setData(live, 'tip', working ? plural(working, 'active agent', 'active agents') + ' linked to this board' : null);
        show(stChip, !!p.state); txt(stChip, p.state ? p.state + (p.stateDate ? ' ' + p.stateDate : '') : '');
        const done = all.filter(n => DONE_STATES.has(n.state)).length;
        txt(count, `${done}/${all.length}`); setData(count, 'tip', `${done} of ${all.length} done, handed off or accepted`);
        const stuck = all.filter(n => n.state === 'blocked' || n.state === 'bounced');
        show(need, (p.needsYou && p.needsYou.length > 0) || stuck.length > 0);
        setData(el, 'project', p.project || ''); setData(el, 'need', need.hidden ? null : '1');
        graph.update(all, items, key, selected);
        const rows = [
          // the id is in the label already, so a text that starts with it ("D2 A changed booking …") drops it
          ...(p.needsYou || []).map(q => [`${q.kind === 'decision' ? 'Decision' : 'Question'} ${q.id}${q.item ? ' · ' + q.item : ''}`, String(q.text || '').replace(new RegExp('^\\**' + String(q.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b\\**[\\s:·.–-]*'), '')]),
          ...stuck.map(n => [`${n.state === 'blocked' ? 'Blocked' : 'Bounced'} ${n.id}`, n.notes || n.name || '']),
        ];
        const ns = JSON.stringify(rows);
        if (ns !== needSig) { needSig = ns; needs.replaceChildren(...rows.map(([b, t]) => h('div', { class: 'plan-need' }, icon('alert'), h('div', { class: 'plan-need-t', 'data-tip': t }, h('b', { text: b }), t)))); }
        const rs = (p.runs || []).map(r => {
          const item = items[`${key}#${r.id}`];
          return [r.id, r.state, [`Run ${r.id}: ${r.name || ''}`, r.lane && 'lane ' + r.lane,
            r.chunks?.length && 'chunks ' + r.chunks.join(', '), r.startWhen && 'starts when ' + r.startWhen].filter(Boolean).join(' · '),
          activeAgents(item).length, (item?.flags || []).filter(flag => BOARD_MARKS[flag])];
        });
        show(runs, rs.length > 0);
        const rsig = JSON.stringify(rs);
        if (rsig !== runSig) {
          runSig = rsig;
          runs.replaceChildren(...rs.map(([id, state, summary, active, flags]) => {
            const tag = h('button', { type: 'button', class: 'chip', 'data-tip': summary, 'data-id': id,
              'aria-controls': detailId, 'aria-expanded': String(selected === id), on: { click: () => select(id) } });
            const [gl, wd, c] = STATUS[state] || STATUS.unknown;
            tag.append(h('span', { class: 'c-' + (c === 'dim' ? 'dim' : c), style: 'display:flex' }, glyph(gl)), `${id} · ${wd}`);
            if (active) tag.append(h('span', { class: 'c-arc', text: active + ' active' }));
            for (const flag of flags) tag.append(h('span', { class: 'c-amber', 'aria-label': BOARD_MARKS[flag][0], text: BOARD_MARKS[flag][1] }));
            return tag;
          }));
        }
        drawDetail();
        const last = (p.lastLog || []).filter(l => /^\d{4}-\d\d-\d\d/.test(l)).pop() || (p.lastLog || []).slice(-1)[0];
        show(log, !!last); txt(log, last || ''); setData(log, 'tip', last || null);
      },
    };
  }
  return { planCard, planNodeCard };
}

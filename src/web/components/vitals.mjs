import { h, s, setData, show, txt } from './dom.mjs';
import { fmtAge, fmtClock, fmtInt, fmtPct, fmtTok, plural, shortModel } from './format.mjs';
import { headline } from '../data/selectors.mjs';
import { arcD } from './geometry.mjs';
import { shownSessions, viewStatus } from './sessions.mjs';
import { provBadge } from './status.mjs';

export function createVitalsComponents({ now, odo }) {
  function reactor(opts = {}) {
    const S = opts.size || 232, C = S / 2, mini = !!opts.mini;
    const rSeg = mini ? C - 3 : C - 10, rTrack = mini ? C - 3 : C - 2, rTick = C - 26, rArc = C - 18, rSlot = C - 40, rIn = C - 47;
    const vb = `0 0 ${S} ${S}`;
    const svg = (...k) => s('svg', { class: 'r-svg', viewBox: vb, 'aria-hidden': 'true' }, ...k);
    const base = svg(s('circle', { class: 'r-track', cx: C, cy: C, r: rTrack, 'stroke-width': 1 }));
    if (!mini) base.append(s('circle', { class: 'r-track', cx: C, cy: C, r: rIn, 'stroke-width': 1 }));
    const segs = s('g');
    const mid = svg();
    if (!mini) {
      for (let a = 0; a < 360; a += 5) {
        const long = a % 30 === 0, t = (a - 90) * Math.PI / 180, r0 = rTick - (long ? 5 : 2), r1 = rTick + (long ? 5 : 2);
        mid.append(s('line', { class: 'r-tick', x1: C + r0 * Math.cos(t), y1: C + r0 * Math.sin(t), x2: C + r1 * Math.cos(t), y2: C + r1 * Math.sin(t), 'stroke-width': long ? 1.5 : 1 }));
      }
      for (const a of [20, 140, 260]) mid.append(s('path', { class: 'r-arc', d: arcD(C, C, rArc, a, a + 50), 'stroke-width': 1.5 }));
    }
    const slots = [];
    const inner = svg();
    if (!mini) for (let i = 0; i < 12; i++) { const p = s('path', { class: 'r-slot', d: arcD(C, C, rSlot, i * 30 + 4, i * 30 + 26), 'stroke-width': 4 }); inner.append(p); slots.push(p); }
    const num = odo('r-odo');
    const el = h('div', { class: 'reactor' + (mini ? ' mini' : ''), style: `width:${S}px;height:${S}px`, role: 'img', 'data-mode': 'idle' },
      h('div', { class: 'r-glow' }), h('div', { class: 'r-l' }, base), h('div', { class: 'r-l r-outer' }, svg(segs)), h('div', { class: 'r-l r-mid' }, mid),
      h('div', { class: 'r-l r-inner' }, inner), mini ? null : h('div', { class: 'r-core' }),
      h('div', { class: 'r-num' }, num.el, h('div', { class: 'r-lbl label', text: 'Agents working' })));
    let sig = null;
    return {
      el,
      update(sessions, totals, o = {}) {
        const live = sessions.filter(x => x.status !== 'ended');
        const running = totals.agentsRunning || 0;
        const mode = totals.needsYou > 0 ? 'alert' : running > 0 ? 'live' : live.length ? 'calm' : 'idle';
        setData(el, 'mode', mode);
        const rank = { 'needs-you': 0, busy: 1, idle: 2 };
        const list = live.map(x => viewStatus(x) === 'agents' ? 'busy' : x.status).sort((a, b) => rank[a] - rank[b]);   // a waiting parent counts with busy (D6)
        if (list.join() !== sig) {
          sig = list.join();
          const n = list.length, gap = n > 1 ? Math.min(6, 90 / n) : 0, seg = n ? (360 - n * gap) / n : 0;
          segs.replaceChildren(...list.map((st, i) => {
            const a0 = n === 1 ? 0 : i * (seg + gap) + gap / 2, a1 = n === 1 ? 359.9 : a0 + seg;
            return s('path', { class: 'r-seg', 'data-s': st, d: arcD(C, C, rSeg, a0, a1), 'stroke-width': mini ? 3 : 6 });
          }));
        }
        slots.forEach((p, i) => p.classList.toggle('on', i < (totals.subagentsRunning || 0)));
        num.set(String(running), o.boot ? { from: 0 } : undefined);
        el.style.setProperty('--beat', (mode === 'idle' ? 8 : Math.max(4, 7 - 0.4 * running)).toFixed(2) + 's');
        el.setAttribute('aria-label', `${plural(running, 'agent', 'agents')} running, ${totals.needsYou || 0} waiting for you`);
      },
    };
  }

  // ---- vitals and account usage ----------------------------------------------------------------------------------------
  function vitals() {
    const mk = (label, wide) => {
      const n = odo(), sub = h('div', { class: 'vital-s', 'data-tip-if': 'trunc' }), num = h('div', { class: 'vital-n' }, n.el);
      return { el: h('div', { class: 'vital' + (wide ? ' wide' : '') }, h('div', { class: 'vital-l label', text: label }), num, sub), n, sub, num };
    };
    const S = mk('Sessions'), A = mk('Subagents'), T = mk('Tokens today', true), N = mk('Need you'), P = mk('Plans');
    const sub2 = h('div', { class: 'vital-s', 'data-tip-if': 'trunc' }); T.el.append(sub2);
    const acctRows = h('div', { class: 'acct' });
    const acct = h('div', { class: 'vital wide acct-v', hidden: true }, h('div', { class: 'vital-l label', text: 'Claude account limits' }), acctRows);
    const meter = label => {
      const f = h('span', { class: 'bar-f' }), v = h('span', { class: 'mv mono' }), note = h('span', { class: 'mn mono' });
      const row = [h('span', { class: 'ml label', text: label }), h('span', { class: 'bar bar-acct' }, f), v, note];
      return { row, set(w) { const p = w && w.pct; f.style.transform = `scaleX(${p == null ? 0 : Math.min(1, p / 100)})`; txt(v, fmtPct(p)); f.style.backgroundColor = p >= 70 ? 'var(--amber)' : ''; setData(note, 'pre', 'resets in '); setData(note, 'until', w && w.resetsAt); txt(note, w && w.resetsAt ? 'resets in ' + fmtAge(w.resetsAt - now()) : ''); } };
    };
    const five = meter('5-hour'), week = meter('Weekly');
    acctRows.append(...five.row, ...week.row);
    const el = h('div', { class: 'vitals' }, N.el, S.el, A.el, P.el, T.el, acct);
    return {
      el,
      update(st, o = {}) {
        const t = st.totals || {}, from = o.boot ? { from: 0 } : undefined;
        const live = (st.sessions || []).filter(x => x.status !== 'ended');
        const idle = live.filter(x => viewStatus(x) === 'idle').length, waiting = live.filter(x => viewStatus(x) === 'agents').length;
        S.n.set(String(t.sessions || 0), from);
        txt(S.sub, `${(t.busy || 0) + waiting} busy · ${idle} idle`);   // a parent waiting on its subagents counts with busy (D6)
        const doneSubs = shownSessions(st.sessions || [], now()).reduce((n, x) => n + (x.subagents || []).filter(a => a.state === 'done').length, 0);   // the same sessions the network draws
        A.n.set(String(t.subagentsRunning || 0), from);
        txt(A.sub, `running · ${doneSubs} finished`);
        const tt = t.tokensToday || {};
        T.n.set(fmtTok(headline(tt)), from);
        txt(T.sub, `in ${fmtTok(tt.input)} · out ${fmtTok(tt.output)} · write ${fmtTok(tt.cacheWrite)}`);
        txt(sub2, `cache read ${fmtTok(tt.cacheRead)}, counted apart`);
        N.n.set(String(t.needsYou || 0), from);
        N.num.classList.toggle('alert', (t.needsYou || 0) > 0);
        txt(N.sub, t.plansNeedingYou ? `sessions + ${plural(t.plansNeedingYou, 'plan', 'plans')}` : 'sessions');
        P.n.set(String(t.plansInProgress || 0), from);
        txt(P.sub, `in progress of ${(st.plans || []).length}`);
        for (const e of [S.sub, A.sub, T.sub, N.sub, P.sub, sub2]) e.dataset.tip = e.textContent;
        const a = st.account;
        show(acct, !!(a && (a.fiveHour || a.sevenDay)));
        if (a) { five.set(a.fiveHour); week.set(a.sevenDay); }
      },
    };
  }

  return { reactor, vitals };
}

// ---- usage from outside Claude Code (D12) --------------------------------------------------------------------------
export function externals(reconcile) {
  const list = h('div'), err = h('div', { class: 'ext-err', hidden: true });
  const el = h('div', {}, list, err);
  const rows = new Map();
  const row = () => {
    const prov = provBadge(), name = h('span', { class: 'ext-n trunc', 'data-tip-if': 'trunc' }), k = h('span', { class: 'ext-k' });
    const src = h('span', { class: 'label' }), model = h('span'), win = h('span'), delayed = h('span', { class: 'chip warn', text: 'Delayed', hidden: true });
    const e = h('div', { class: 'ext-row' }, prov.el, name, k, h('div', { class: 'ext-d' }, src, model, win, delayed));
    return {
      el: e,
      set(x) {
        prov.set(x.provider, x.modelRaw);
        const n = x.app || shortModel(x.model) || x.model || 'unknown'; txt(name, n); name.dataset.tip = n;
        txt(k, fmtTok(headline(x.tokens))); setData(k, 'tip', `in ${fmtInt(x.tokens?.input)} · out ${fmtInt(x.tokens?.output)} · cache read ${fmtInt(x.tokens?.cacheRead)}`);
        txt(src, x.source === 'cloudwatch' ? 'CloudWatch' : 'Ingest'); txt(model, x.app ? shortModel(x.model) : '');
        txt(win, x.windowEnd ? 'to ' + fmtClock(x.windowEnd).slice(0, 5) : ''); show(delayed, !!x.delayed);
        setData(delayed, 'tip', x.delayed ? 'CloudWatch publishes a few minutes late, and per model, not per app' : null);
      },
    };
  };
  return {
    el,
    update(ext, error) {
      reconcile(list, rows, ext || [], x => x.source + '|' + (x.app || '') + '|' + x.model, row, (r, x) => r.set(x), false);
      txt(err, error || ''); show(err, !!error);
    },
  };
}

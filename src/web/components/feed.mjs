import { EASE } from './animation.mjs';
import { h, show, txt } from './dom.mjs';
import { fmtClock } from './format.mjs';
import { prefs } from './preferences.mjs';
import { projectLabel } from './sessions.mjs';
import { icon } from './status.mjs';
import { selectProject } from '../data/selectors.mjs';

export const FEED_TAGS = { tool: 'Tool', agent: 'Agent', 'needs-you': 'Needs you', done: 'Done', plan: 'Plan', session: 'Session' };
export function ticker(panelEl, header, { lifetime, motion, now, timing }, api = {}) {
  const { age } = timing;
  const list = h('ol', { class: 'tk-list-in' });
  const clip = h('div', { class: 'tk-list', 'aria-live': 'polite', 'aria-relevant': 'additions' }, list);
  const newest = h('span', { class: 'tk-new trunc' }), paused = h('span', { class: 'chip warn', hidden: true });
  const ldText = h('span', { class: 'trunc', text: 'Nothing has finished yet', 'data-tip': 'Nothing has finished yet', 'data-tip-if': 'trunc' }), ldAgo = h('span', { class: 'mono' });
  const lastDone = h('span', { class: 'tk-last' }, h('span', { class: 'tk-tag', 'data-k': 'done', style: 'padding:0 8px', text: 'Last done' }), ldText, ldAgo);
  let doneAt = -1;
  const btn = h('button', { class: 'tgl tk-collapse', type: 'button', 'aria-expanded': 'true', 'aria-label': 'Collapse the feed', 'data-tip': 'Collapse the feed' }, icon('chevron'));
  header.append(newest, lastDone, paused, btn);
  let hovered = false, queue = [], project = null, lastFinish = null;
  let history = [];
  const matches = f => f && (!project || f.project === project);
  let collapsed = prefs.get('tickerCollapsed', false);
  function setCollapsed(v) {
    collapsed = v; prefs.set('tickerCollapsed', v); panelEl.classList.toggle('collapsed', v);
    btn.setAttribute('aria-expanded', String(!v)); const l = v ? 'Expand the feed' : 'Collapse the feed'; btn.setAttribute('aria-label', l); btn.dataset.tip = l;
  }
  setCollapsed(collapsed);
  btn.addEventListener('click', () => setCollapsed(!collapsed));
  clip.addEventListener('pointerenter', () => { hovered = true; });
  clip.addEventListener('pointerleave', () => { hovered = false; const q = queue; queue = []; show(paused, false); q.forEach(f => insert(f, false)); });
  function line(f) {
    const k = FEED_TAGS[f.kind] ? f.kind : 'session';
    const proj = projectLabel(api, 'tk-proj trunc');
    proj.set(f.project);
    const li = h('li', { class: 'tk', 'data-project': f.project }, h('span', { class: 'tk-time', text: fmtClock(f.at) }),
      h('span', { class: 'tk-tag', 'data-k': k, text: FEED_TAGS[k] }), h('span', { class: 'tk-project' }, proj.el),
      h('span', { class: 'tk-text trunc', text: f.text, 'data-tip': f.text, 'data-tip-if': 'trunc' }));
    li._f = f;
    return li;
  }
  function setNewest(f) {
    if (!f) { txt(newest, 'No feed events'); return; }
    const proj = projectLabel(api, 'tk-proj trunc');
    proj.set(f.project); show(proj.el, !!f.project);
    newest.replaceChildren(h('span', { class: 'tk-tag', 'data-k': FEED_TAGS[f.kind] ? f.kind : 'session', style: 'padding:0 8px', text: FEED_TAGS[f.kind] || 'Session' }),
      proj.el, h('span', { class: 'trunc', text: f.text }));
  }
  function noteDone(f) {   // the newest finish stays in the header, so "what just finished" survives a busy feed
    if (!matches(f) || f.kind !== 'done' || f.at <= doneAt) return;
    doneAt = f.at;
    const t = `${f.project || ''} · ${f.text}`; txt(ldText, t); ldText.dataset.tip = t;
    age(ldAgo, f.at, '', ' ago');
  }
  function insert(f, animate = true) {
    noteDone(f);
    const top = list.firstElementChild;
    if (f.kind === 'tool' && top?._f?.kind === 'tool' && top._f.sessionId && top._f.sessionId === f.sessionId && top._f.project === f.project) {
      top._n = (top._n || 1) + 1; top._f = f;   // the same session's next tool: update the line, count it
      top.querySelector('.tk-time').textContent = fmtClock(f.at);
      const tx = top.querySelector('.tk-text'); tx.textContent = f.text; tx.dataset.tip = f.text;
      let n = top.querySelector('.tk-n'); if (!n) { n = h('span', { class: 'tk-n' }); top.querySelector('.tk-project').append(n); }
      n.textContent = '×' + top._n;
      setNewest(f);
      return;
    }
    const li = line(f);
    list.prepend(li);
    while (list.children.length > 40) list.lastElementChild.remove();
    setNewest(f);
    if (animate && !motion.rm && !collapsed) { lifetime.animate(list, [{ transform: 'translateY(-24px)' }, { transform: 'none' }], { duration: 300, easing: EASE }); lifetime.animate(li, [{ opacity: 0 }, { opacity: 1 }], { duration: 300 }); }
  }
  function redraw() {
    const visible = selectProject(history, project);
    queue = []; show(paused, false); hovered = false;
    list.replaceChildren(...visible.slice(0, 40).map(line));
    setNewest(visible[0]);
    doneAt = -1;
    txt(ldText, 'Nothing has finished yet'); ldText.dataset.tip = ldText.textContent;
    age(ldAgo, null);
    noteDone(visible.find(f => f.kind === 'done'));
    noteDone(lastFinish);
  }
  return {
    el: clip,
    focus(name) { if (project !== name) { project = name; redraw(); } },
    add(f, feed = history) {
      history = feed;
      if (!matches(f)) return;
      if (hovered) { queue.push(f); show(paused, true); txt(paused, `Paused · ${queue.length} new`); return; }
      insert(f);
    },
    sync(feed) { if (feed !== history) { history = feed; redraw(); } },
    done(f) { lastFinish = f; noteDone(f); },   // a completion known from the state, even after it leaves the feed
    type(text) {   // "SYSTEMS ONLINE" types into the ticker during boot
      if (project) return;
      const tx = h('span', { class: 'tk-text' });
      const li = h('li', { class: 'tk type' }, h('span', { class: 'tk-time', text: fmtClock(now()) }), h('span', { class: 'tk-tag', 'data-k': 'session', text: 'HUD' }), h('span', { class: 'tk-proj', text: 'Claude HUD' }), tx);
      list.prepend(li);
      let i = 0; const tm = lifetime.repeat(() => { txt(tx, text.slice(0, ++i)); if (i >= text.length) lifetime.cancelRepeat(tm); }, 40);
    },
  };
}

import { h, s, setAttr, setData, show, txt } from './dom.mjs';
import { fmtAge, fmtClock, fmtDate } from './format.mjs';
import { prefs } from './preferences.mjs';
import { STATUS, icon } from './status.mjs';

export const CONNECTION_LABELS = { live: 'Live', reconnecting: 'Reconnecting', down: 'Down', connecting: 'Connecting' };

export function backgroundLayer() {
  return h('div', { class: 'bg', 'aria-hidden': 'true' }, h('div', { class: 'bg-grid' }), h('div', { class: 'bg-dots' }), h('div', { class: 'bg-dots d2' }), h('div', { class: 'bg-shim' }), h('div', { class: 'bg-vig' }));
}

export function panel(cls, title, opts = {}) {
  const head = h('header', { class: 'ph' }, title ? h('h2', { class: 'pt', text: title }) : null);
  const content = h('div', { class: 'pc' });
  const pb = h('div', { class: 'pb cutbox' }, head, content);
  const el = h('section', { class: 'panel ' + cls, 'aria-label': opts.label || title || null }, pb);
  let err = null;
  return {
    el, head, content, pb,
    guard(fn, retry) {
      try { fn(); if (err) { err.remove(); err = null; } }
      catch (e) {
        console.error(e);
        if (!err) {
          const b = h('button', { class: 'btn', type: 'button' }, 'Retry');
          err = h('div', { class: 'perr', role: 'alert' }, icon('alert'), h('div', { class: 'perr-t', text: 'This panel could not be drawn' }), h('div', { class: 'perr-m trunc', text: String(e && e.message || e).slice(0, 160), 'data-tip': String(e && e.message || e).slice(0, 300), 'data-tip-if': 'trunc' }), b);
          b.addEventListener('click', () => retry && retry());
          pb.append(err);
        }
      }
    },
  };
}
// ---- "more below": a panel that scrolls says what is out of sight, and a click brings it up ------------------------
// describe(hidden elements) returns the summary: states, names. Nothing runs at rest: it repaints (in one animation
// frame) on scroll, on resize and when the owner calls refresh() after a render.
export function moreBelow(lifetime, motion, scroller, list, describe) {
  const n = h('span', { class: 'label' }), d = h('span', { class: 'more-d', 'data-tip-if': 'trunc' });
  const el = h('button', { class: 'more', type: 'button', hidden: true }, icon('chevron'), n, d);
  let queued = 0, hidden = [];
  function paint() {
    queued = 0;
    const end = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    const bottom = scroller.getBoundingClientRect().bottom - 32;
    // out of sight: less than about 48 px of it shows above the bar (half, for something smaller)
    hidden = end ? [] : [...list.children].filter(e => {
      if (e === el || e.hidden || e.classList.contains('leave')) return false;
      const r = e.getBoundingClientRect();
      return r.height > 0 && bottom - r.top < Math.min(48, r.height / 2);
    });
    show(el, hidden.length > 0);
    if (!hidden.length) return;
    txt(n, `${hidden.length} more below`);
    d.replaceChildren(...describe(hidden).filter(Boolean).flatMap((p, i) => i ? [' · ', p] : [p])); d.dataset.tip = d.textContent;
    setAttr(el, 'aria-label', `${hidden.length} more below${d.textContent ? ': ' + d.textContent : ''}. Show them.`);
  }
  const later = () => { if (!queued) queued = lifetime.frame(paint); };
  lifetime.listen(scroller, 'scroll', later, { passive: true });
  lifetime.observeResize(scroller, later);
  el.addEventListener('click', () => {
    const first = hidden.find(e => e.isConnected);
    if (first) scroller.scrollBy({ top: first.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8, behavior: motion.rm ? 'auto' : 'smooth' });
  });
  return { el, refresh: later };
}
// Hidden cards or rows, counted by state ("1 busy · 2 idle"): a word and its colour.
const COUNT_C = { 'needs-you': 'alert', busy: 'amber', agents: 'agent', idle: 'arc', ended: 'ink2' };
export function stateCounts(els) {
  const c = {}; for (const e of els) c[e.dataset.s] = (c[e.dataset.s] || 0) + 1;
  return Object.keys(COUNT_C).filter(k => c[k]).map(k => h('span', { class: 'c-' + COUNT_C[k], text: `${c[k]} ${STATUS[k][1].toLowerCase()}` }));
}
export function toggle(name, label, on, onChange) {
  const b = h('button', { class: 'tgl', type: 'button', 'aria-label': label }, icon(name), icon('slash', 'slash'));
  const set = v => { b.setAttribute('aria-pressed', String(!!v)); b.dataset.tip = `${label}: ${v ? 'on' : 'off'}`; };
  set(on);
  b.addEventListener('click', () => onChange(b.getAttribute('aria-pressed') !== 'true', set));
  return { el: b, set };
}
function brandMark() {
  return s('svg', { class: 'brand-mark', viewBox: '0 0 28 28', 'aria-hidden': 'true' },
    s('circle', { class: 'bm-o', cx: 14, cy: 14, r: 12.5, 'stroke-width': 1.5, 'stroke-dasharray': '14 5.6' }),
    s('circle', { cx: 14, cy: 14, r: 7, 'stroke-width': 1, opacity: .6 }),
    s('circle', { cx: 14, cy: 14, r: 3, fill: 'var(--arc)', stroke: 'none' }));
}
export function topBar({ now, motion, reactor, odo, audio, voice }) {
  const sub = h('span', { class: 'brand-sub label' });
  const mini = reactor({ size: 36, mini: true }), miniN = odo();
  const clockT = h('span', { class: 'clock-t mono' }), clockD = h('span', { class: 'clock-d label' }), clockU = h('span', { class: 'clock-u label' });
  const demo = h('span', { class: 'chip demo', hidden: true, 'data-tip': 'Simulated sessions (node hud.mjs --demo)' }, 'Demo');
  const hooks = h('span', { class: 'chip warn', hidden: true, 'data-tip': 'Hooks are missing in a watched Claude Code folder: tool calls arrive late from transcripts, and “needs you” cannot be seen. Restart the HUD, or run node hud.mjs install.' }, 'Hooks off');
  const streamW = h('span', { class: 'label' }), stream = h('div', { class: 'stream', 'data-s': 'connecting', role: 'status' }, h('span', { class: 'stream-dot' }), streamW);
  const fx = toggle('effects', 'Effects', motion.fx, (v, set) => { motion.setFx(v); set(v); });
  const vo = toggle('voice', 'Voice', prefs.get('voice', false), (v, set) => { prefs.set('voice', v); set(v); if (v) voice.say('Voice announcements on'); });
  const so = toggle('sound', 'Sound', prefs.get('sound', false), (v, set) => { prefs.set('sound', v); set(v); if (v) { audio.ensure(); audio.play('done'); } });
  const no = toggle('bell', 'Notifications', prefs.get('notify', false) && 'Notification' in window && Notification.permission === 'granted', async (v, set) => {
    if (!v) { prefs.set('notify', false); set(false); return; }
    if (!('Notification' in window)) { set(false); return; }
    const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    prefs.set('notify', perm === 'granted'); set(perm === 'granted');
    if (perm === 'denied') no.el.dataset.tip = 'Notifications: blocked in the browser settings';
  });
  const el = h('header', { class: 'top' },
    h('div', { class: 'brand' }, brandMark(), h('span', { class: 'wordmark', text: 'HUD' }), sub),
    h('div', { class: 'mini', 'aria-hidden': 'true' }, mini.el, miniN.el),
    h('div', { class: 'clock' }, clockT, clockD, clockU),
    h('div', { class: 'top-chips' }, demo, hooks),
    h('div', { class: 'top-r' }, stream, fx.el, vo.el, so.el, no.el));
  let started = null;
  return {
    el,
    tick() { const t = now(); txt(clockT, fmtClock(t)); txt(clockD, fmtDate(t)); if (started) txt(clockU, 'up ' + fmtAge(t - started)); },
    update(st) {
      txt(sub, 'Claude + Codex · ' + (st.host || 'this PC')); started = st.now - st.uptime;
      show(demo, !!st.demo); show(hooks, !st.demo && st.hooksInstalled === false);
      mini.update(st.sessions || [], st.totals || {}); miniN.set(String(st.totals?.agentsRunning || 0));
      this.tick();
    },
    setStream(sv) { setData(stream, 's', sv); txt(streamW, CONNECTION_LABELS[sv] || sv); },
    toggles: { fx, vo, so, no },
  };
}

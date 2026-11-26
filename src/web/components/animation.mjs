import { h, txt } from './dom.mjs';

export const EASE = 'cubic-bezier(.2, .8, .2, 1)';
export const easeOut = k => 1 - Math.pow(1 - k, 3);

export function createDisplayEffects(lifetime, motion) {
  // Ambient glitch on entry and on a status change (layer 1: EFFECTS only).
  function glitch(el) {
    if (!motion.ambient || !el.animate) return;
    lifetime.animate(el, [
      { transform: 'translateX(0)', filter: 'none', opacity: 1 },
      { transform: 'translateX(-3px)', filter: 'brightness(1.7) hue-rotate(-25deg)', opacity: .75, offset: .2 },
      { transform: 'translateX(2px)', filter: 'brightness(1.3) hue-rotate(20deg)', opacity: 1, offset: .45 },
      { transform: 'translateX(-1px)', filter: 'none', opacity: .85, offset: .7 },
      { transform: 'translateX(0)', filter: 'none', opacity: 1 },
    ], { duration: 260, easing: 'steps(6, end)' });
  }

  // ---- odometer: digits roll (layer 2), widths never change ----------------------------------------------------------
  function odo(cls) {
    const sr = h('span', { class: 'sr' });
    const el = h('span', { class: 'odo' + (cls ? ' ' + cls : '') }, sr);
    let cur = null;
    const isD = ch => ch >= '0' && ch <= '9';
    function slot(ch) {
      if (!isD(ch)) { const sl = h('span', { class: 'odo-s', 'aria-hidden': 'true', text: ch }); sl._ch = ch; return sl; }
      const strip = h('span', { class: 'odo-strip' });
      for (let d = 0; d < 10; d++) strip.append(h('span', { text: String(d) }));
      const sl = h('span', { class: 'odo-s odo-d', 'aria-hidden': 'true' }, strip);
      sl._strip = strip; digit(sl, ch);
      return sl;
    }
    function digit(sl, ch) { sl._ch = ch; sl._strip.style.transform = `translateY(${-Number(ch)}em)`; }
    let lastAt = 0, pending = null, timer = 0;
    function set(v, opts = {}) {
      const str = String(v);
      if (str === cur && opts.from == null) { pending = null; return; }
      const wait = cur == null || opts.from != null ? 0 : lastAt + 1500 - Date.now();
      if (wait > 0) { pending = str; if (!timer) timer = lifetime.delay(() => { timer = 0; const p = pending; pending = null; if (p != null) set(p); }, wait); return; }
      lastAt = Date.now();
      txt(sr, str);
      const slots = [...el.children].slice(1);
      const same = cur != null && cur.length === str.length && slots.every((sl, i) => !!sl._strip === isD(str[i]));
      if (!same || opts.from != null) {
        const from = opts.from != null ? String(opts.from) : null;
        const kids = [...str].map(ch => slot(from != null && isD(ch) ? '0' : ch));
        el.replaceChildren(sr, ...kids);
        if (from != null) { void el.offsetWidth; kids.forEach((k, i) => { if (k._strip) digit(k, str[i]); }); }
      } else {
        slots.forEach((sl, i) => { if (sl._ch !== str[i]) { if (sl._strip) digit(sl, str[i]); else { sl.textContent = str[i]; sl._ch = str[i]; } } });
      }
      cur = str;
    }
    return { el, set, get value() { return cur; } };
  }

  // ---- keyed lists: enter, leave, and FLIP reordering -----------------------------------------------------------------
  function enterEl(el) {
    el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter');
    lifetime.delay(() => el.classList.remove('enter'), 260);
    glitch(el);
  }
  function leaveEl(el) { el.classList.add('leave'); lifetime.delay(() => el.remove(), 200); }
  function reconcile(container, map, items, keyOf, make, update, animate = true) {
    const want = [], seen = new Set();
    for (const it of items) {
      const k = keyOf(it); seen.add(k);
      let c = map.get(k); const fresh = !c;
      if (fresh) { c = make(it); map.set(k, c); }
      update(c, it);
      want.push([c, fresh]);
    }
    for (const [k, c] of map) if (!seen.has(k)) { map.delete(k); if (animate) leaveEl(c.el); else c.el.remove(); }
    const cur = [...container.children].filter(e => !e.classList.contains('leave'));
    const changed = cur.length !== want.length || want.some(([c], i) => cur[i] !== c.el);
    if (!changed) return;
    const before = new Map();
    if (animate) for (const [c, fresh] of want) if (!fresh && c.el.isConnected) before.set(c.el, c.el.getBoundingClientRect().top);
    let prev = null;
    for (const [c] of want) {
      const el = c.el;
      if (prev ? prev.nextElementSibling !== el : container.firstElementChild !== el) { if (prev) prev.after(el); else container.prepend(el); }
      prev = el;
    }
    if (!animate) return;
    for (const [c, fresh] of want) {
      if (fresh) { enterEl(c.el); continue; }
      const top = before.get(c.el); if (top == null) continue;
      const dy = top - c.el.getBoundingClientRect().top;
      if (Math.abs(dy) > 1 && !motion.rm) lifetime.animate(c.el, [{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 300, easing: EASE });
    }
  }

  return { glitch, odo, reconcile };
}

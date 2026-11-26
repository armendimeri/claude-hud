import { h } from './dom.mjs';

export function createTooltip(lifetime, doc = document) {
  const body = h('div', { class: 'tip-b cutbox' });
  const box = h('div', { class: 'tip', role: 'tooltip', id: 'hud-tip' }, body);
  let anchor = null, pending = null, timer = 0;
  function place(target) {
    const r = target.getBoundingClientRect(), bw = box.offsetWidth, bh = box.offsetHeight;
    let x = Math.max(8, Math.min(window.innerWidth - bw - 8, r.left + r.width / 2 - bw / 2));
    let y = r.top - bh - 10;
    if (y < 64) y = r.bottom + 10;
    if (y + bh > window.innerHeight - 8) y = Math.max(8, innerHeight - bh - 8);
    box.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
  function open(target, content) {
    if (!box.isConnected) doc.body.append(box);
    body.replaceChildren(typeof content === 'string' ? h('div', { class: 'tip-t', text: content }) : content);
    anchor = target; box.classList.add('on'); place(target);
  }
  let targetEvents = null;
  function close(target) {
    if (target && target !== anchor && target !== pending) return;
    lifetime.cancelDelay(timer);
    targetEvents?.abort();
    targetEvents = null;
    pending = null;
    anchor = null;
    box.classList.remove('on');
  }
  function maybe(event) {
    const target = event.target.closest?.('[data-tip]');
    if (!target || target === anchor || target === pending) return;
    if (target.dataset.tipIf === 'trunc' && target.scrollWidth <= target.clientWidth + 1) return;
    lifetime.cancelDelay(timer);
    targetEvents?.abort();
    targetEvents = new AbortController();
    pending = target;
    timer = lifetime.delay(() => {
      pending = null;
      if (target.isConnected) open(target, target.dataset.tip);
    }, event.type === 'focusin' ? 0 : 350);
    const leave = () => close(target);
    target.addEventListener('pointerleave', leave, { signal: targetEvents.signal });
    target.addEventListener('focusout', leave, { signal: targetEvents.signal });
  }
  lifetime.listen(doc, 'pointerover', maybe);
  lifetime.listen(doc, 'focusin', maybe);
  lifetime.listen(window, 'scroll', () => close(), { capture: true });
  lifetime.onClose(() => { close(); box.remove(); });
  return { open, close, get anchor() { return anchor; } };
}

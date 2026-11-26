import { h, s, setAttr, setData, show, txt } from './dom.mjs';
import { fmtAge, fmtDur, fmtInt } from './format.mjs';

export function createTiming(now = Date.now) {
  function tickTimers(scope) {
    const t = now();
    for (const el of scope.querySelectorAll('[data-since]')) txt(el, fmtDur(t - Number(el.dataset.since)));
    for (const el of scope.querySelectorAll('[data-age]')) txt(el, (el.dataset.pre || '') + fmtAge(t - Number(el.dataset.age)) + (el.dataset.post || ''));
    for (const el of scope.querySelectorAll('[data-until]')) txt(el, (el.dataset.pre || '') + fmtAge(Number(el.dataset.until) - t));
    const minute = Math.floor(t / 60000);
    for (const chart of scope.querySelectorAll('[data-pulse]')) {
      const state = activityData.get(chart);
      if (state && state.minute !== minute) drawActivity(chart, minute, state.pulse);
    }
  }
  function since(el, ts) { if (ts) { setData(el, 'since', ts); txt(el, fmtDur(now() - ts)); } else { setData(el, 'since', null); txt(el, ''); } }
  function age(el, ts, pre = '', post = '') {
    setData(el, 'pre', pre); setData(el, 'post', post);
    if (ts) { setData(el, 'age', ts); txt(el, pre + fmtAge(now() - ts) + post); } else { setData(el, 'age', null); txt(el, ''); }
  }


  // Pad and age the stream's sparse series on the page, even when the HUD has nothing to push.
  const activityData = new WeakMap();
  function drawActivity(chart, minute, pulse) {
    activityData.set(chart, { minute, pulse });
    const offset = minute - 29 - Math.floor((pulse?.start || 0) / 60000);
    const values = Array.from({ length: 30 }, (_, i) => pulse?.perMin[offset + i] || 0);
    const peak = Math.max(...values);
    const points = peak ? values.map((n, i) => `${i * 3 + 2},${(16 - 14 * n / peak).toFixed(1)}`).join(' ') : '';
    setAttr(chart.lastElementChild, 'points', points);
    const label = peak ? `Output over the last 30 minutes. Peak ${fmtInt(peak)} tokens per minute.` : 'No output tokens in the last 30 minutes';
    setAttr(chart, 'aria-label', label);
    setData(chart, 'tip', label);
  }
  function activityLine() {
    const chart = s('svg', { class: 'activity-chart', 'data-pulse': '', viewBox: '0 0 91 18', role: 'img' },
      s('path', { class: 'activity-base', d: 'M2 16H89' }), s('polyline', { class: 'activity-path' }));
    const turn = h('span', { hidden: true });
    const el = h('div', { class: 'activity' }, chart, turn);
    return { el, set(pulse, timing) {
      drawActivity(chart, Math.floor(now() / 60000), pulse);
      const lastMs = timing?.lastMs;
      show(turn, lastMs != null);
      txt(turn, lastMs == null ? '' : 'Last turn ' + fmtDur(lastMs));
    } };
  }

  return { tickTimers, since, age, activityLine };
}

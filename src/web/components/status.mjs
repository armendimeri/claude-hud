import { h, s, setData, show, txt } from './dom.mjs';
import { provName } from './format.mjs';

export const ICONS = {
  terminal: [['rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2 }], ['path', { d: 'M7 9.5l3 2.5-3 2.5M12.5 15H17' }]],
  file: [['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }], ['path', { d: 'M14 3v5h5M9 13h6M9 17h4' }]],
  edit: [['path', { d: 'M4 20h4L19 9l-4-4L4 16z' }], ['path', { d: 'M13.5 6.5l4 4' }]],
  search: [['circle', { cx: 11, cy: 11, r: 6 }], ['path', { d: 'M20 20l-4.6-4.6' }]],
  web: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z' }]],
  agent: [['circle', { cx: 12, cy: 6.5, r: 2.5 }], ['circle', { cx: 6, cy: 17.5, r: 2.5 }], ['circle', { cx: 18, cy: 17.5, r: 2.5 }], ['path', { d: 'M10.7 8.7l-3.4 6.6M13.3 8.7l3.4 6.6' }]],
  plan: [['path', { d: 'M12 3l3 1.7v3.6L12 10l-3-1.7V4.7z' }], ['path', { d: 'M6 14l3 1.7v3.6L6 21l-3-1.7v-3.6z' }], ['path', { d: 'M18 14l3 1.7v3.6L18 21l-3-1.7v-3.6z' }], ['path', { d: 'M10.5 9.5L7.5 14M13.5 9.5l3 4.5' }]],
  bell: [['path', { d: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z' }], ['path', { d: 'M10 20.5a2 2 0 0 0 4 0' }]],
  voice: [['rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }], ['path', { d: 'M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6' }]],
  sound: [['path', { d: 'M4 9.5h3.5L12 6v12l-4.5-3.5H4z' }], ['path', { d: 'M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11' }]],
  effects: [['path', { d: 'M11 3.5l1.6 4.4 4.4 1.6-4.4 1.6L11 15.5l-1.6-4.4L5 9.5l4.4-1.6z' }], ['path', { d: 'M18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z' }]],
  tool: [['path', { d: 'M14.7 6.3a4 4 0 0 0-5.4 5.1L4 16.7 7.3 20l5.3-5.3a4 4 0 0 0 5.1-5.4l-2.4 2.4-2.6-.7-.7-2.6z' }]],
  network: [['circle', { cx: 12, cy: 12, r: 2.5 }], ['circle', { cx: 5, cy: 5, r: 1.8 }], ['circle', { cx: 19, cy: 5, r: 1.8 }], ['circle', { cx: 5, cy: 19, r: 1.8 }], ['circle', { cx: 19, cy: 19, r: 1.8 }], ['path', { d: 'M10.2 10.2L6.3 6.3M13.8 10.2l3.9-3.9M10.2 13.8l-3.9 3.9M13.8 13.8l3.9 3.9' }]],
  cards: [['rect', { x: 4, y: 4.5, width: 16, height: 6, rx: 1 }], ['rect', { x: 4, y: 13.5, width: 16, height: 6, rx: 1 }]],
  window: [['path', { d: 'M11 5H5v14h14v-6M13 5h6v6M19 5l-8 8' }]],
  branch: [['circle', { cx: 7, cy: 6, r: 2 }], ['circle', { cx: 7, cy: 18, r: 2 }], ['circle', { cx: 17, cy: 8, r: 2 }], ['path', { d: 'M7 8v8M17 10a5 5 0 0 1-5 5H9' }]],
  check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
  alert: [['path', { d: 'M12 4l9 15.5H3z' }], ['path', { d: 'M12 10v4.5M12 17.3v.2' }]],
  close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
  pin: [['path', { d: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v7' }]],
  chevron: [['path', { d: 'M7 10l5 5 5-5' }]],
  clock: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 7.5V12l3 2' }]],
  slash: [['path', { d: 'M5 5l14 14' }]],
};
export function icon(name, cls) {
  const svg = s('svg', { class: 'ic' + (cls ? ' ' + cls : ''), viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
  for (const [t, a] of ICONS[name] || ICONS.tool) svg.append(s(t, a));
  return svg;
}
const HEX16 = 'M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z';
export const GLYPHS = {
  busy: [['path', { d: 'M8 2.5a5.5 5.5 0 1 1-5.5 5.5' }], ['circle', { cx: 8, cy: 8, r: 1.6, class: 'gf' }]],
  needs: [['path', { d: 'M8 2l6.5 11.5h-13z' }], ['path', { d: 'M8 6.5v3M8 11.6v.1' }]],
  idle: [['circle', { cx: 8, cy: 8, r: 5 }]],
  ended: [['rect', { x: 3.5, y: 3.5, width: 9, height: 9 }], ['path', { d: 'M6 8h4' }]],
  running: [['circle', { cx: 8, cy: 8, r: 5.5, 'stroke-dasharray': '7 4.5' }]],
  done: [['circle', { cx: 8, cy: 8, r: 6 }], ['path', { d: 'M5.2 8.2l1.9 1.9 3.8-4' }]],
  todo: [['path', { d: HEX16, 'stroke-dasharray': '2 2' }]],
  inprog: [['path', { d: HEX16 }], ['circle', { cx: 8, cy: 8, r: 1.8, class: 'gf' }]],
  handoff: [['circle', { cx: 8, cy: 8, r: 6 }], ['path', { d: 'M5.5 8h5M8.6 5.8L10.8 8l-2.2 2.2' }]],
  bounced: [['path', { d: 'M5 6h5a3 3 0 0 1 0 6H6' }], ['path', { d: 'M7 3.5L4.5 6 7 8.5' }]],
  partial: [['circle', { cx: 8, cy: 8, r: 5.5 }], ['path', { d: 'M8 2.5a5.5 5.5 0 0 1 0 11z', class: 'gf' }]],
  unknown: [['circle', { cx: 8, cy: 8, r: 5.5, 'stroke-dasharray': '1.5 2.5' }]],
};
export function glyph(name) {
  const svg = s('svg', { class: 'gl' + (name === 'running' ? ' spin' : ''), viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' });
  for (const [t, a] of GLYPHS[name] || GLYPHS.unknown) svg.append(s(t, a));
  return svg;
}
// state -> [glyph, word, colour]: status is always a word, a shape and a colour.
export const STATUS = {
  'needs-you': ['needs', 'Needs you', 'alert'], busy: ['busy', 'Busy', 'amber'], idle: ['idle', 'Idle', 'arc'], ended: ['ended', 'Ended', 'dim'],
  agents: ['running', 'Agents working', 'agent'], running: ['running', 'Running', 'agent'], done: ['done', 'Done', 'ok'],
  todo: ['todo', 'Todo', 'dim'], 'in-progress': ['inprog', 'In progress', 'arc'], 'handed-off': ['handoff', 'Handed off', 'ok'], accepted: ['done', 'Accepted', 'ok'],
  blocked: ['needs', 'Blocked', 'alert'], bounced: ['bounced', 'Bounced', 'alert'], partial: ['partial', 'Partial', 'amber'], unknown: ['unknown', 'Unknown', 'dim'],
};
export function statusTag() {
  const g = h('span', { style: 'display:flex' }), w = h('span'), x = h('span', { class: 'stag-x mono', hidden: true });
  const el = h('span', { class: 'stag label' }, g, w, x);
  let cur = null;
  return {
    el,
    set(state, extra, word) {
      const [gl, wd, c] = STATUS[state] || STATUS.unknown;
      if (cur !== state) { cur = state; el.dataset.c = c; g.replaceChildren(glyph(gl)); }
      txt(w, word || wd); txt(x, extra || ''); show(x, !!extra);
    },
  };
}
export function provBadge() {
  const el = h('span', { class: 'chip prov' });
  return { el, set(p, raw) { setData(el, 'p', p || 'unknown'); txt(el, provName(p)); setData(el, 'tip', 'Runs on ' + provName(p) + (raw ? ' · model id ' + raw : '')); } };
}

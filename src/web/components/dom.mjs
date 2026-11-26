const NS = 'http://www.w3.org/2000/svg';

function apply(el, p, isSvg) {
  for (const k in p) {
    const v = p[k];
    if (v == null || v === false) continue;
    if (k === 'class') { if (isSvg) el.setAttribute('class', v); else el.className = v; }
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') { if (typeof v === 'string') el.setAttribute('style', v); else Object.assign(el.style, v); }
    else if (k === 'on') { for (const e in v) el.addEventListener(e, v[e]); }
    else if (k === 'data') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}
function add(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) add(el, k);
    else el.append(typeof k === 'object' ? k : document.createTextNode(String(k)));
  }
  return el;
}
export function h(tag, p, ...kids) { const el = document.createElement(tag); if (p) apply(el, p, false); return add(el, kids); }
export function s(tag, p, ...kids) { const el = document.createElementNS(NS, tag); if (p) apply(el, p, true); return add(el, kids); }
export function txt(el, t) { t = t == null ? '' : String(t); if (el.textContent !== t) el.textContent = t; }
export function setAttr(el, k, v) {
  if (v == null || v === false) { if (el.hasAttribute(k)) el.removeAttribute(k); return; }
  v = String(v); if (el.getAttribute(k) !== v) el.setAttribute(k, v);
}
export function setData(el, k, v) {
  if (v == null || v === '') { if (k in el.dataset) delete el.dataset[k]; return; }
  v = String(v); if (el.dataset[k] !== v) el.dataset[k] = v;
}
export function show(el, on) { if (el.hidden === !!on) el.hidden = !on; }

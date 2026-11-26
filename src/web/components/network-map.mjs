import { EASE, easeOut } from './animation.mjs';
import { h, s, setAttr, setData, show, txt } from './dom.mjs';
import { ctxLevel, fmtAge, fmtPct, fmtTok, plural, provLetter, provName, shortModel, toolIcon } from './format.mjs';
import { headline } from '../data/selectors.mjs';
import { arcD, ellArc, hexPts, placeFlow } from './geometry.mjs';
import { projectLabel, shownSessions, viewStatus, workText } from './sessions.mjs';
import { GLYPHS, STATUS, icon, statusTag } from './status.mjs';

const SWEEP_MS = 8000;
let netSeq = 0;
export function createNetworkMap({ lifetime, motion, now, sessionCard, activityLine }, api = {}) {
  const uid = 'net' + (++netSeq);
  const sweepIn = h('i'), sweep = h('div', { class: 'net-sweep', 'aria-hidden': 'true' }, sweepIn);
  const gR = s('g', { class: 'net-rings', 'aria-hidden': 'true' }), gG = s('g');
  const gE = s('g', { 'aria-hidden': 'true' }), gP = s('g', { 'aria-hidden': 'true' });
  const svg = s('svg', { class: 'net-svg', 'aria-hidden': api.project ? null : 'true' }, gR, gG, gE, gP);
  const hubProject = projectLabel(api, '', ''), hubHost = h('span');
  const hubLabel = h('span', { class: 'hub-label label trunc' }, hubHost, hubProject.el);
  const hub = h('div', { class: 'net-hub' }, h('span', { class: 'hub-ring' }), h('span', { class: 'hub-core' }), hubLabel);
  const layer = h('div', { class: 'net-nodes', role: 'group', 'aria-label': 'Agent network: who started whom. Arrow keys move between agents, Enter pins one, Escape unpins.' });
  const empty = h('div', { class: 'net-empty', hidden: true }, h('span', { class: 'label', text: 'No active sessions' }), h('span', { text: ' · systems nominal' }));
  const legend = h('div', { class: 'net-legend label', 'aria-hidden': 'true', hidden: true },
    h('span', {}, h('i', { class: 'dash' }), 'Running'), h('span', {}, h('i', { class: 'dbl' }), 'Launched by'),
    h('span', { text: 'Size = tokens' }), h('span', { text: 'Ring = context' }), h('span', { text: 'A / B / O = Anthropic / Bedrock / OpenAI' }));
  const readout = h('div', { class: 'net-readout', hidden: true }), readBox = h('div', { class: 'tip-b cutbox' });
  readout.append(readBox);
  const pinBox = h('div', { class: 'net-pin', hidden: true });
  const flowLayer = h('div', { class: 'net-flows', 'aria-hidden': 'true' });
  const el = h('div', { class: 'net' }, sweep, svg, flowLayer, hub, layer, empty, legend, readout, pinBox);
  const nodes = new Map(), edges = new Map(), expanded = new Set();
  let W = 0, H = 0, data = null, cx = {}, hubXY = { x: 0, y: 0 }, drawn = false, tween = 0, sweepAnim = null;
  let pinnedId = null, pinFor = null, pinCard = null, autoPin = null, hoverId = null, rovingId = null, groupSig = '', ringSig = '';

  lifetime.observeResize(el, () => {
    const w = el.clientWidth, hh = el.clientHeight;
    if (Math.abs(w - W) < 1 && Math.abs(hh - H) < 1) return;
    W = w; H = hh; if (data) render();
  });
  lifetime.onClose(motion.on(() => retime(true)));

  // Items: sessions (depth 0) and their subagents. A parent keeps its 3 newest finished subagents in view and folds
  // older ones into a numbered satellite, so its tree stays close to it; above 40 nodes every finished one folds.
  function graph(sessions) {
    const shown = shownSessions(sessions, now());
    if (!shown.some(x => x.status !== 'ended')) return [];
    let items = [];
    for (const x of shown) {
      items.push({ id: x.id, kind: 'session', parent: null, depth: 0, x, state: viewStatus(x), tokens: headline(x.tokens), project: x.project || 'Unknown', startedAt: x.startedAt || 0 });
      const ids = new Set((x.subagents || []).map(a => a.id));
      for (const a of x.subagents || []) items.push({ id: a.id, kind: 'sub', parent: ids.has(a.parentId) ? a.parentId : x.id, session: x.id, depth: 1, x: a, state: a.state === 'done' ? 'done' : 'running', tokens: headline(a.tokens), startedAt: a.startedAt || 0 });
    }
    const byId = new Map(items.map(i => [i.id, i]));
    for (const i of items) { let d = 0, p = i, g = 0; while (p && p.kind === 'sub' && g++ < 10) { d++; p = byId.get(p.parent); } i.depth = d; }
    const kids = new Map();
    for (const i of items) if (i.parent) { if (!kids.has(i.parent)) kids.set(i.parent, []); kids.get(i.parent).push(i); }
    const allDone = id => (kids.get(id) || []).every(k => k.state === 'done' && allDone(k.id));
    const keep = items.length > 40 ? 0 : 3, drop = new Set(), sats = [];
    for (const p of items) {
      if (expanded.has(p.id)) continue;
      const done = (kids.get(p.id) || []).filter(k => k.kind === 'sub' && k.state === 'done' && allDone(k.id)).sort((a, b) => (b.x.endedAt || 0) - (a.x.endedAt || 0));
      const fold = done.slice(keep);
      if (fold.length < 2) continue;
      let count = 0;
      const mark = k => { drop.add(k.id); count++; for (const kk of kids.get(k.id) || []) mark(kk); };
      fold.forEach(mark);
      sats.push({ id: 'sat:' + p.id, kind: 'sat', parent: p.id, session: p.session || p.id, depth: p.depth + 1, state: 'sat', count, tokens: 0, startedAt: Infinity, x: null });
    }
    if (drop.size) items = items.filter(i => !drop.has(i.id)).concat(sats.filter(t => !drop.has(t.parent)));   // a satellite folded into its parent's goes too
    return items;
  }

  // Radial tree: sessions on the inner ring grouped by project, one ring per depth, fitted into the panel.
  function layout(items) {
    const kids = new Map();
    for (const i of items) { const p = i.parent || 'hub'; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(i); }
    for (const l of kids.values()) l.sort((a, b) => a.startedAt - b.startedAt);
    // A subtree's share of the circle: its leaves, a finished (small, dim) leaf counting half.
    const wt = new Map();
    const weigh = i => { let n = 0; for (const k of kids.get(i.id) || []) n += weigh(k); const v = Math.max(i.kind === 'session' || i.state === 'running' ? 1 : 0.5, n); wt.set(i.id, v); return v; };
    // Order never depends on state, so a node doesn't swap places when its session starts or stops working.
    const sessions = (kids.get('hub') || []).slice().sort((a, b) => a.project.localeCompare(b.project) || a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
    sessions.forEach(weigh);
    const groups = new Map();
    for (const x of sessions) { if (!groups.has(x.project)) groups.set(x.project, []); groups.get(x.project).push(x); }
    const G = [...groups].map(([name, list]) => ({ name, list, w: list.reduce((n, x) => n + wt.get(x.id), 0) }));
    const total = G.reduce((n, g) => n + g.w, 0) || 1;
    const gap = G.length > 1 ? Math.min(14, 60 / G.length) : 0, avail = 360 - gap * G.length;
    const maxDepth = items.reduce((m, i) => Math.max(m, i.depth), 0);
    const S0 = Math.max(80, Math.min(W - 160, H - 128) / 2);
    const R0 = maxDepth === 0 ? 1 : Math.min(0.6, Math.max(0.46, sessions.length * 40 / (2 * Math.PI * S0)));
    const ring = d => maxDepth === 0 ? 1 : R0 + d * ((1 - R0) / maxDepth);
    // Children fan out only as far as they need (about 64 px of their ring per leaf), so a tree stays next to its parent.
    const place = (i, a0, a1) => {
      i.theta = (a0 + a1) / 2; i.ring = ring(i.depth);
      const ks = kids.get(i.id) || []; if (!ks.length) return;
      const perLeaf = 64 / (S0 * ring(i.depth + 1)) * 180 / Math.PI, tot = ks.reduce((n, k) => n + wt.get(k.id), 0);
      const spread = Math.min(a1 - a0, Math.max(1, tot) * perLeaf, i.depth === 0 ? 140 : 100);
      let c = i.theta - spread / 2;
      for (const k of ks) { const sp = spread * wt.get(k.id) / tot; place(k, c, c + sp); c += sp; }
    };
    let a = sessions.length === 1 ? 90 - avail / 2 : -gap / 2;
    for (const g of G) {
      const span = avail * g.w / total; g.a0 = a; g.a1 = a + span;
      let b = a; for (const x of g.list) { const sp = span * wt.get(x.id) / g.w; place(x, b, b + sp); b += sp; }
      a += span + gap;
    }
    // A crowded session ring: every other session (and its subtree) steps outwards, so neighbours don't overlap.
    const per = 2 * Math.PI * S0 * ring(0) * (avail / 360) / Math.max(1, sessions.length);
    if (sessions.length > 6 && per < 48) {
      const bump = (i, b) => { i.ring += b; for (const k of kids.get(i.id) || []) bump(k, b); };
      sessions.slice().sort((p, q) => p.theta - q.theta).forEach((x, k) => { if (k % 2) bump(x, maxDepth ? 0.11 : 0.16); });
    }
    for (const i of items) { const t = i.theta * Math.PI / 180; i.ux = Math.sin(t) * i.ring; i.uy = -Math.cos(t) * i.ring; }
    let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
    for (const i of items) { x0 = Math.min(x0, i.ux); x1 = Math.max(x1, i.ux); y0 = Math.min(y0, i.uy); y1 = Math.max(y1, i.uy); }
    const padX = W < 520 ? 56 : 96, padY = H < 300 ? 48 : 76, bottom = W >= 560 ? 24 : 0;
    let sx = (W - 2 * padX) / Math.max(x1 - x0, 0.5), sy = (H - 2 * padY - bottom) / Math.max(y1 - y0, 0.5);
    const sMin = Math.min(sx, sy), sMax = maxDepth === 0 ? Math.max(120, Math.min(220, Math.min(W, H) * 0.4)) : Math.min(W, H) * 0.8;
    sx = Math.min(sx, sMin * 1.7, sMax * 1.7); sy = Math.min(sy, sMin * 1.7, sMax);
    const ox = W / 2 - (x0 + x1) / 2 * sx, oy = (H - bottom) / 2 - (y0 + y1) / 2 * sy;
    for (const i of items) { i.px = ox + i.ux * sx; i.py = oy + i.uy * sy; }
    hubXY = { x: ox, y: oy };
    let dmin = Infinity;
    for (let p = 0; p < items.length; p++) {
      const A = items[p]; dmin = Math.min(dmin, Math.hypot(A.px - ox, A.py - oy));
      for (let q = p + 1; q < items.length; q++) dmin = Math.min(dmin, Math.hypot(A.px - items[q].px, A.py - items[q].py));
    }
    // Size = tokens: a square-root scale over a 3× range, so every token counts and the busiest agent is the biggest.
    const rMax = Math.max(14, Math.min(34, dmin * 0.4)), rMin = Math.max(7, rMax / 3);
    const tMax = Math.max(1, ...items.map(i => i.tokens));
    for (const i of items) {
      i.r = i.kind === 'sat' ? rMin + 3 : rMin + (rMax - rMin) * Math.sqrt(Math.min(1, i.tokens / tMax));
      if (i.state === 'needs-you') i.r = Math.max(i.r, rMin + 0.6 * (rMax - rMin));   // what needs you is never the smallest thing
    }
    return { G, sx, sy, ring, maxDepth, rMax, crowded: items.length > 12 || dmin < 70 };
  }

  // Labels: the title (or subagent type) and "model · context · tokens", on the side away from the hub when there is
  // room; shorter when crowded, but the numbers next to the ring are always there.
  const CHAR = { body: 6.1, mono: 6.7, label: 6.9 };
  function labelText(i, mode) {
    const x = i.x;
    if (i.kind === 'sat') return ['', 'finished'];
    const pct = x.context ? fmtPct(x.context.pct) : 'ctx —', tok = fmtTok(headline(x.tokens));
    if (mode === 'min') return ['', pct];
    const name = i.kind === 'session' ? (x.title || x.name || 'Untitled') : (x.type || 'agent');
    if (mode === 'short') return [name.length > 18 ? name.slice(0, 17).trimEnd() + '…' : name, `${pct} · ${tok}`];
    const meta = `${x.agent === 'codex' ? 'Codex · ' : ''}${shortModel(x.model) || 'model ?'} · ${pct} · ${tok}`;
    if (mode === 'meta') return ['', meta];
    return [name, meta];
  }
  function labelBox(i, side, l1, l2) {
    const w = Math.max(l1 ? Math.min(180, l1.length * (i.kind === 'session' ? CHAR.body : CHAR.label)) : 0, Math.min(180, l2.length * CHAR.mono)) + 6;
    const hgt = (l1 ? 16 : 0) + 16, R = i.r + 14;
    if (side === 'b') return { x0: i.px - w / 2, x1: i.px + w / 2, y0: i.py + R, y1: i.py + R + hgt };
    if (side === 't') return { x0: i.px - w / 2, x1: i.px + w / 2, y0: i.py - R - hgt, y1: i.py - R };
    if (side === 'r') return { x0: i.px + R, x1: i.px + R + w, y0: i.py - hgt / 2, y1: i.py + hgt / 2 };
    return { x0: i.px - R - w, x1: i.px - R, y0: i.py - hgt / 2, y1: i.py + hgt / 2 };
  }
  const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  function placeLabels(items, L) {
    const placed = [];
    const hw = hubLabel.textContent.length * CHAR.label / 2 + 6;
    placed.push({ x0: hubXY.x - hw, x1: hubXY.x + hw, y0: hubXY.y + 26, y1: hubXY.y + 44 }, { x0: hubXY.x - 24, x1: hubXY.x + 24, y0: hubXY.y - 24, y1: hubXY.y + 24 });
    const discs = items.map(i => ({ id: i.id, x0: i.px - i.r - 9, x1: i.px + i.r + 9, y0: i.py - i.r - 9, y1: i.py + i.r + 9 }));
    const prio = i => i.state === 'needs-you' ? 0 : i.kind === 'session' ? (i.state === 'busy' || i.state === 'agents' ? 1 : i.state === 'idle' ? 2 : 6) : i.kind === 'sub' ? (i.state === 'running' ? 3 : 4) : 5;
    const inPanel = b => b.x0 >= 2 && b.x1 <= W - 2 && b.y0 >= 2 && b.y1 <= H - (W >= 560 ? 26 : 2);
    for (const i of items.slice().sort((a, b) => prio(a) - prio(b) || b.r - a.r)) {
      const r = nodes.get(i.id), outward = i.py < hubXY.y - 4 ? 't' : 'b', other = outward === 't' ? 'b' : 't';
      const horiz = i.px < hubXY.x ? ['l', 'r'] : ['r', 'l'];
      // a name says what is running, so it comes before the model line; crowded nodes get a short name or just the number
      const modes = i.kind === 'sat' ? ['meta'] : !L.crowded || i.state === 'needs-you' ? ['full', 'short', 'meta', 'min'] : i.kind === 'session' || i.state === 'running' ? ['short', 'min'] : ['min'];
      const sides = [outward, ...horiz, other];
      const prev = r && r.lbl ? [[r.lbl.mode, r.lbl.side]] : [];
      let pick = null;
      const tryIt = (mode, side) => {
        if (!modes.includes(mode)) return false;
        const [l1, l2] = labelText(i, mode), b = labelBox(i, side, l1, l2);
        if (!inPanel(b) || placed.some(p => overlaps(p, b)) || discs.some(d => d.id !== i.id && overlaps(d, b))) return false;
        pick = { mode, side, l1, l2, b }; return true;
      };
      for (const [m, sd] of prev) if (tryIt(m, sd)) break;   // stable: keep last frame's placement while it still fits
      if (!pick) outer: for (const m of modes) for (const sd of sides) if (tryIt(m, sd)) break outer;
      if (!pick && i.state === 'needs-you') { const [l1, l2] = labelText(i, 'min'); pick = { mode: 'min', side: outward, l1, l2, b: labelBox(i, outward, l1, l2) }; }
      if (!pick) { i.lbl = { mode: 'none', side: outward, l1: '', l2: '' }; continue; }   // no room: no label, and no ring without its number
      placed.push(pick.b);
      i.lbl = pick;
    }
  }

  function makeNode(i) {
    const glowE = h('span', { class: 'nf-glow' }), ping = h('span', { class: 'nf-ping' }), spk = h('span', { class: 'nf-spark' });
    const spin = h('span', { class: 'nf-spin', hidden: true }), face = s('svg', { class: 'nf-svg', 'aria-hidden': 'true' });
    const btn = h('button', { class: 'nn', type: 'button', tabindex: '-1' }, glowE, ping, face, spin, spk);
    const l1 = h('span', { class: 'nl1 trunc' }), l2 = h('span', { class: 'nl2' }), lab = h('div', { class: 'nl side-b', 'aria-hidden': 'true' }, l1, l2);
    const nf = h('div', { class: 'nf', style: `--fd:${(7 + Math.random() * 4).toFixed(1)}s;--fdl:${(-Math.random() * 9).toFixed(1)}s` }, btn, lab);
    const r = { id: i.id, el: h('div', { class: 'na' }, nf), btn, face, spin, glowE, ping, spk, l1, l2, lab, x: null, y: null, tx: 0, ty: 0, rad: 0, sig: '', item: i, state: null, lbl: null };
    btn.addEventListener('pointerenter', () => hover(r, true));
    btn.addEventListener('pointerleave', () => hover(r, false));
    btn.addEventListener('focus', () => { rovingId = r.id; roving(); hover(r, true); });
    btn.addEventListener('blur', () => hover(r, false));
    btn.addEventListener('click', () => { if (r.item.kind === 'sat') { expanded.add(r.item.parent); render(); } else togglePin(r.id); });
    return r;
  }
  const FACE_GLYPH = { 'needs-you': 'needs', busy: 'busy', idle: 'idle', ended: 'ended', agents: 'running', running: 'running', done: 'done' };
  function drawFace(r, i) {
    const R = Math.round(i.r * 2) / 2, x = i.x, prov = x ? x.provider : null, ringOn = !i.lbl || i.lbl.mode !== 'none';
    const pct = x && x.context && ringOn ? x.context.pct : null;
    const sig = [R, i.state, i.kind, pct == null ? '-' : Math.round(pct), prov, i.count || 0, ringOn].join('|');
    if (sig === r.sig) return;
    const oldR = r.rad; r.sig = sig; r.rad = R;
    const pad = 18, S = 2 * (R + pad), half = R + 6;
    Object.assign(r.btn.style, { left: -half + 'px', top: -half + 'px', width: 2 * half + 'px', height: 2 * half + 'px' });
    setAttr(r.face, 'width', S); setAttr(r.face, 'height', S); setAttr(r.face, 'viewBox', `${-R - pad} ${-R - pad} ${S} ${S}`);
    r.face.style.left = r.face.style.top = (half - R - pad) + 'px';
    const box = (e, rr) => Object.assign(e.style, { left: (half - rr) + 'px', top: (half - rr) + 'px', width: 2 * rr + 'px', height: 2 * rr + 'px' });
    box(r.glowE, R * 2); box(r.ping, R + 8); box(r.spk, R + 2); box(r.spin, R + 11);
    r.lab.style.setProperty('--R', (R + 14) + 'px');
    const k = [];
    if (i.kind !== 'sat' && ringOn) {
      k.push(s('circle', { class: 'nf-ctx-t', r: R + 6 }));
      if (pct != null) k.push(s('path', { class: 'nf-ctx', 'data-lvl': ctxLevel(pct), d: arcD(0, 0, R + 6, 0, Math.max(2, Math.min(359.5, pct * 3.6))) }));
    }
    k.push(s('polygon', { class: 'nf-hex', points: hexPts(R) }));
    if (i.kind === 'session' && R >= 18) k.push(s('polygon', { class: 'nf-inner', points: hexPts(R * 0.72) }));
    if (i.kind === 'sat') k.push(s('text', { class: 'nf-letter', y: 1 }, '+' + i.count));
    else {
      // the status shape sits in the centre, the same glyph as on the cards
      const gs = Math.max(9, Math.min(18, R * 0.9)), g = s('g', { class: 'nf-glyph', transform: `translate(${-gs / 2} ${-gs / 2}) scale(${gs / 16})` });
      for (const [t, a] of GLYPHS[FACE_GLYPH[i.state] || 'idle']) g.append(s(t, Object.assign({ 'vector-effect': 'non-scaling-stroke' }, a)));
      k.push(g);
      // provider: a one-letter tag on the rim
      const tx = R * 0.74 + 4, ty = -R * 0.74 - 4;
      k.push(s('rect', { class: 'nf-tag', x: tx - 7, y: ty - 6.5, width: 14, height: 13 }), s('text', { class: 'nf-tag-t', x: tx, y: ty + 0.5 }, provLetter(prov)));
    }
    k.push(s('circle', { class: 'nf-focus', r: R + 13 }));
    r.face.replaceChildren(...k);
    if (oldR && Math.abs(oldR - R) >= 1 && !motion.rm) lifetime.animate(r.face, [{ transform: `scale(${(oldR / R).toFixed(3)})` }, { transform: 'none' }], { duration: 400, easing: EASE });
  }
  function setSpinner(r, i) {
    const on = i.state === 'busy' || i.state === 'running';
    show(r.spin, on);
    if (on && r.spinR !== r.rad) {
      r.spinR = r.rad; const c = r.rad + 11;
      r.spin.replaceChildren(s('svg', { viewBox: `0 0 ${2 * c} ${2 * c}` }, ...[0, 120, 240].map(a => s('path', { d: arcD(c, c, c - 1, a, a + 46) }))));
    }
  }
  function setLabel(r, i) {
    const L = i.lbl || { mode: 'min', side: 'b', l1: '', l2: '' };
    if (r.lbl && r.lbl.side !== L.side) r.lab.classList.remove('side-' + r.lbl.side);
    r.lab.classList.add('side-' + L.side);
    r.lbl = { mode: L.mode, side: L.side };
    r.l1.classList.toggle('is-type', i.kind !== 'session');
    txt(r.l1, L.l1); show(r.l1, !!L.l1); txt(r.l2, L.l2); show(r.l2, !!L.l2);
  }
  function nodeLabel(i) {
    const x = i.x;
    if (i.kind === 'sat') return `${plural(i.count, 'finished subagent', 'finished subagents')}, folded. Enter expands them.`;
    const who = i.kind === 'session' ? `Session in ${x.project || 'an unknown project'}: ${x.title || x.name || 'untitled'}` : `Subagent ${x.type || ''}: ${x.description || ''}`;
    return `${who}. ${x.agent === 'codex' ? 'Codex' : 'Claude Code'}. ${(STATUS[i.state] || STATUS.unknown)[1]}. ${shortModel(x.model) || 'Model unknown'} on ${provName(x.provider)}. ${fmtTok(headline(x.tokens))} tokens. Context ${x.context ? fmtPct(x.context.pct) : 'unknown'}.`;
  }
  function nodeCard(i) {
    const x = i.x;
    if (i.kind === 'sat') return h('div', { class: 'tc' }, h('div', { class: 'tc-t', text: plural(i.count, 'finished subagent', 'finished subagents') }), h('div', { class: 'tc-n', text: 'Folded to keep the network readable. Click to expand.' }));
    const tag = statusTag(); tag.set(i.state);
    const t = x.tokens || {}, tool = x.currentTool, end = x.endedAt || null, work = workText(x.work, cx.plans);
    const activity = activityLine(); activity.set(x.pulse, x.turn);
    return h('div', { class: 'tc' },
      h('div', { class: 'tc-h' }, tag.el, h('span', { class: 'label c-ink2 trunc', text: i.kind === 'session' ? (x.project || '') : `Subagent · level ${i.depth}` })),
      h('div', { class: 'tc-t', text: i.kind === 'session' ? (x.title || x.name || 'Untitled session') : `${x.type || 'agent'}: ${x.description || ''}` }),
      work ? h('div', { class: 'tc-r work-label', text: work }) : null,
      h('div', { class: 'tc-r' }, h('b', { text: shortModel(x.model) || 'model unknown' }), x.effort ? h('span', { text: x.effort }) : null,
        h('span', { text: '· ' + (x.agent === 'codex' ? 'Codex / ' : '') + provName(x.provider) }), h('span', { text: '· ' + (end ? 'ran ' + fmtAge(end - (x.startedAt || end)) : 'running ' + fmtAge(now() - (x.startedAt || now()))) })),
      x.needsYou ? h('div', { class: 'tc-r c-alert' }, icon('alert'), h('span', { text: x.needsYou.reason })) : null,
      tool ? h('div', { class: 'tc-r' }, icon(toolIcon(tool.name)), h('b', { text: tool.name }), h('span', { class: 'trunc', style: 'max-width:240px', text: tool.summary || '' })) : null,
      h('div', { class: 'tc-r' }, h('span', { text: 'Tokens' }), h('b', { text: fmtTok(headline(t)) }), h('span', { text: `in ${fmtTok(t.input)} · out ${fmtTok(t.output)} · write ${fmtTok(t.cacheWrite)}` })),
      h('div', { class: 'tc-r' }, h('span', { text: 'Cache read' }), h('b', { text: fmtTok(t.cacheRead) }),
        i.kind === 'session' && headline(x.tokensTree) > headline(t) ? h('span', { text: `· with subagents ${fmtTok(headline(x.tokensTree))}` }) : null),
      h('div', { class: 'tc-r' }, h('span', { text: 'Context' }), h('b', { text: x.context ? fmtPct(x.context.pct) : '—' }), h('span', { text: x.context ? `${fmtTok(x.context.used)} of ${fmtTok(x.context.window)}` : 'window unknown' })),
      activity.el);
  }

  // A tool call: the node ripples, and a packet runs down the edge from whoever started it.
  function spark(r) {
    if (motion.rm || !r.spk.animate) return;
    lifetime.animate(r.spk, [{ opacity: .9, transform: 'scale(.85)' }, { opacity: 0, transform: 'scale(1.75)' }], { duration: 650, easing: 'ease-out' });
    const p = pos(r.item.parent), q = { x: r.tx, y: r.ty };
    if (Math.hypot(q.x - p.x, q.y - p.y) < 12) return;
    const dot = h('span', { class: 'pkt' + (r.item.kind === 'sub' ? ' sub' : '') });
    flowLayer.append(dot);
    const a = lifetime.animate(dot, [
      { transform: `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) scale(.5)`, opacity: 0 },
      { transform: `translate(${((p.x + q.x) / 2).toFixed(1)}px, ${((p.y + q.y) / 2).toFixed(1)}px) scale(1)`, opacity: 1, offset: .5 },
      { transform: `translate(${q.x.toFixed(1)}px, ${q.y.toFixed(1)}px) scale(.5)`, opacity: 0 }], { duration: 600, easing: 'cubic-bezier(.4, 0, .2, 1)' });
    a.onfinish = a.oncancel = () => dot.remove();
  }
  const toolSig = i => i.x && i.x.currentTool ? i.x.currentTool.name + '@' + i.x.currentTool.since : null;
  const pos = id => { if (id == null) return hubXY; const r = nodes.get(id); return r && r.x != null ? { x: r.x, y: r.y } : hubXY; };

  function syncEdges(items) {
    const ids = new Set(items.map(i => i.id)), want = [];
    for (const i of items) {
      if (i.kind === 'session') {
        want.push({ key: 'h' + i.id, kind: 'spoke', a: null, b: i.id, st: i.state });
        const sb = i.x.startedBy; if (sb && ids.has(sb)) want.push({ key: 's' + i.id, kind: 'sby', a: sb, b: i.id });
      } else want.push({ key: 't' + i.id, kind: i.state === 'running' ? 'run' : 'done', a: i.parent, b: i.id, at: i.startedAt });
    }
    const flowing = new Set(want.filter(e => e.kind === 'run').sort((p, q) => (q.at || 0) - (p.at || 0)).slice(0, 3).map(e => e.key));
    const seen = new Set();
    for (const e of want) {
      seen.add(e.key);
      let rec = edges.get(e.key);
      if (!rec) {
        rec = { key: e.key, base: s('path', { class: 'e' }) }; gE.append(rec.base);
        if (e.kind === 'sby') { rec.inner = s('path', { class: 'e e-sby-i' }); gE.append(rec.inner); }
        edges.set(e.key, rec);
      }
      Object.assign(rec, { kind: e.kind, a: e.a, b: e.b });
      rec.base.classList.remove('e-spoke', 'e-sby-o', 'e-run', 'e-done');
      rec.base.classList.add(e.kind === 'spoke' ? 'e-spoke' : e.kind === 'sby' ? 'e-sby-o' : e.kind === 'run' ? 'e-run' : 'e-done');
      if (e.kind === 'spoke') setData(rec.base, 's', e.st);
      const fl = flowing.has(e.key);
      if (fl && !rec.flow) { rec.flow = h('div', { class: 'eflow' }, h('i')); flowLayer.append(rec.flow); }
      if (!fl && rec.flow) { rec.flow.remove(); rec.flow = null; }
    }
    for (const [k, rec] of edges) if (!seen.has(k)) { rec.base.remove(); rec.inner?.remove(); rec.flow?.remove(); edges.delete(k); }
  }
  function edgeD(rec) {
    const p = pos(rec.a), q = pos(rec.b), f = n => n.toFixed(1);
    if (rec.kind === 'sby') {
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2, c = { x: mx + (hubXY.x - mx) * 0.45, y: my + (hubXY.y - my) * 0.45 };
      return `M${f(p.x)} ${f(p.y)}Q${f(c.x)} ${f(c.y)} ${f(q.x)} ${f(q.y)}`;
    }
    return `M${f(p.x)} ${f(p.y)}L${f(q.x)} ${f(q.y)}`;
  }
  function drawEdges() { for (const rec of edges.values()) { const d = edgeD(rec); setAttr(rec.base, 'd', d); if (rec.inner) setAttr(rec.inner, 'd', d); if (rec.flow) placeFlow(rec.flow, pos(rec.a), pos(rec.b)); } }
  // Depth rings with tick marks: the radar scope the tree sits on (one ring per level).
  function drawRings(L, any) {
    const sig = [W, H, hubXY.x, hubXY.y, L.sx, L.sy, L.maxDepth, any].join('|');
    if (sig === ringSig) return; ringSig = sig;
    if (!any) { gR.replaceChildren(); return; }
    const out = [];
    for (let d = 0; d <= L.maxDepth; d++) out.push(s('ellipse', { class: 'n-ring' + (d === L.maxDepth ? ' outer' : ''), cx: hubXY.x, cy: hubXY.y, rx: L.ring(d) * L.sx, ry: L.ring(d) * L.sy }));
    const rx = L.ring(L.maxDepth) * L.sx + 14, ry = L.ring(L.maxDepth) * L.sy + 14;
    for (let a = 0; a < 360; a += 10) {
      const t = (a - 90) * Math.PI / 180, long = a % 30 === 0, c = Math.cos(t), sn = Math.sin(t), k = long ? 6 : 3;
      out.push(s('line', { class: 'n-tick' + (long ? ' long' : ''), x1: hubXY.x + rx * c, y1: hubXY.y + ry * sn, x2: hubXY.x + (rx + k) * c, y2: hubXY.y + (ry + k) * sn }));
    }
    gR.replaceChildren(...out);
    // the radar: a circle turning about the hub, seen through an ellipse fitted to the rings that fades at its rim
    const ew = 2 * (rx + 28), eh = 2 * (ry + 28), dd = 2 * Math.max(rx, ry) + 60;
    Object.assign(sweep.style, { width: ew + 'px', height: eh + 'px', left: (hubXY.x - ew / 2) + 'px', top: (hubXY.y - eh / 2) + 'px' });
    Object.assign(sweepIn.style, { width: dd + 'px', height: dd + 'px', left: (ew - dd) / 2 + 'px', top: (eh - dd) / 2 + 'px' });
  }
  // Project names run along the inner arc, after the node labels are placed: a node's name and numbers come first, and
  // a project name that finds no free stretch of arc is left to the node cards.
  function drawGroups(L, items) {
    const R0 = L.ring(0), rx = R0 * L.sx, ry = R0 * L.sy, band = Math.round(L.rMax * 2 + 4);
    const lbls = items.filter(i => i.lbl && i.lbl.b).map(i => i.lbl.b);
    const sig = [W, H, hubXY.x, hubXY.y, rx, ry, band, ...L.G.map(g => g.name + g.a0.toFixed(1) + g.a1.toFixed(1)), ...items.map(i => i.r.toFixed(0)), ...lbls.map(b => [b.x0, b.y0, b.x1].map(v => Math.round(v / 4)).join(','))].join('|');
    if (sig === groupSig) return; groupSig = sig;
    const out = [];
    if (L.G.length < 2) { gG.replaceChildren(); return; }   // one project: its name sits under the hub instead
    const discs = items.map(i => ({ x: i.px, y: i.py, r: i.r + 18 }));   // + the glyphs, which sit up to 9 px off the path
    const free = p => !discs.some(d => Math.hypot(d.x - p.x, d.y - p.y) < d.r) && !lbls.some(b => p.x > b.x0 - 6 && p.x < b.x1 + 6 && p.y > b.y0 - 10 && p.y < b.y1 + 10);
    L.G.forEach((g, gi) => {
      const full = g.a1 - g.a0 >= 359, a0 = full ? 0 : g.a0 + 1.5, a1 = full ? 359.9 : g.a1 - 1.5;
      const ar = (r0, a) => { const t = (a - 90) * Math.PI / 180; return [hubXY.x + (rx + r0) * Math.cos(t), hubXY.y + (ry + r0) * Math.sin(t)]; };
      if (a1 > a0) {
        out.push(s('path', { class: 'g-arc', d: ellArc(hubXY.x, hubXY.y, rx - band / 2, ry - band / 2, a0, a1) }));
        if (!full) for (const a of [a0, a1]) { const [x0, y0] = ar(-band / 2 - 4, a), [x1, y1] = ar(-band / 2 + 4, a); out.push(s('line', { class: 'g-tick', x1: x0, y1: y0, x2: x1, y2: y1 })); }
      }
      const lrx = rx - band / 2 - 10, lry = ry - band / 2 - 10;
      if (lrx < 36 || lry < 36) return;
      const chars = g.name.length, need = chars * 8.4 + 8;                          // the label's arc length, in px
      const deg = need / (((lrx + lry) / 2) * Math.PI / 180);
      const pt = a => { const t = (a - 90) * Math.PI / 180; return { x: hubXY.x + lrx * Math.cos(t), y: hubXY.y + lry * Math.sin(t) }; };
      const clear = a => { for (let k = 0; k <= 8; k++) if (!free(pt(a - deg / 2 + k * deg / 8))) return false; return true; };
      let mid = (g.a0 + g.a1) / 2, best = null;
      for (const off of [0, -8, 8, -16, 16, -24, 24, -36, 36]) { const m = mid + off; if ((full || (m - deg / 2 >= g.a0 - 4 && m + deg / 2 <= g.a1 + 4)) && clear(m)) { best = m; break; } }
      if (best == null) return;   // no free stretch of arc: the project shows in the node's card instead
      mid = best;
      const b0 = mid - deg / 2 - 2, b1 = mid + deg / 2 + 2;
      const m = ((mid % 360) + 360) % 360, lower = m > 90 && m < 270, id = `${uid}-g${gi}`;
      out.push(s('path', { id, d: lower ? ellArc(hubXY.x, hubXY.y, lrx, lry, b1, b0, true) : ellArc(hubXY.x, hubXY.y, lrx, lry, b0, b1), fill: 'none' }));
      const label = s('text', { class: 'g-lbl', dy: lower ? 10 : -2 }, s('textPath', { href: '#' + id, startOffset: '50%', 'text-anchor': 'middle' }, g.name));
      if (api.project) {
        setAttr(label, 'role', 'button');
        setAttr(label, 'tabindex', '0');
        setAttr(label, 'aria-label', g.name);
        setData(label, 'project', g.name);
        label.addEventListener('click', () => api.project(g.name));
        label.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); api.project(g.name); }
        });
      }
      out.push(label);
    });
    gG.replaceChildren(...out);
  }

  function placeNode(r) { r.el.style.transform = `translate3d(${r.x.toFixed(1)}px, ${r.y.toFixed(1)}px, 0)`; }
  function moveAll() {
    const list = [...nodes.values()];
    lifetime.cancelFrame(tween); tween = 0;
    const moving = list.some(r => Math.abs(r.x - r.tx) > 0.5 || Math.abs(r.y - r.ty) > 0.5);
    if (!moving || motion.rm) { for (const r of list) { r.x = r.tx; r.y = r.ty; placeNode(r); } drawEdges(); settle(moving); return; }
    const from = list.map(r => [r, r.x, r.y]), t0 = performance.now();
    const step = t => {
      const k = Math.min(1, (t - t0) / 450), e = easeOut(k);
      for (const [r, fx, fy] of from) { r.x = fx + (r.tx - fx) * e; r.y = fy + (r.ty - fy) * e; placeNode(r); }
      drawEdges();
      if (k < 1) tween = lifetime.frame(step); else { tween = 0; settle(true); }
    };
    tween = lifetime.frame(step);
  }
  function settle(moved) { for (const r of nodes.values()) if (r.pulse) { r.pulse = false; returnPulse(r); } if (moved) retime(false); }
  // "Handed the result back": a bright pulse travels from the finished child to its parent, then the edge dims.
  function returnPulse(r) {
    r.el.classList.remove('just-done'); void r.el.offsetWidth; r.el.classList.add('just-done');
    lifetime.delay(() => r.el.classList.remove('just-done'), 1600);
    const rec = edges.get('t' + r.id), p = pos(r.item.parent), q = { x: r.x, y: r.y };
    if (motion.rm) { if (rec) { rec.base.classList.add('flash'); lifetime.delay(() => rec.base.classList.remove('flash'), 400); } return; }
    const len = Math.hypot(p.x - q.x, p.y - q.y); if (len < 4) return;
    const path = s('path', { class: 'e e-pulse', d: `M${q.x.toFixed(1)} ${q.y.toFixed(1)}L${p.x.toFixed(1)} ${p.y.toFixed(1)}`, 'stroke-dasharray': `14 ${Math.ceil(len + 28)}` });
    gP.append(path);
    const an = lifetime.animate(path, [{ strokeDashoffset: 14 }, { strokeDashoffset: -len }], { duration: Math.min(900, 380 + len * 1.6), easing: 'cubic-bezier(.4, 0, .2, 1)' });
    an.onfinish = an.oncancel = () => path.remove();
  }
  // Radar sweep (ambient): every node pings when the sweep passes it, on the shared document timeline.
  function retime(force) {
    if (!motion.ambient) {
      if (sweepAnim) { sweepAnim.cancel(); sweepAnim = null; }
      for (const r of nodes.values()) if (r.pingAnim) { r.pingAnim.cancel(); r.pingAnim = null; r.pingAng = null; }
      return;
    }
    if (!sweepAnim) { sweepAnim = lifetime.animate(sweepIn, [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: SWEEP_MS, iterations: Infinity }); sweepAnim.startTime = 0; }
    for (const r of nodes.values()) {
      const ang = (Math.atan2(r.tx - hubXY.x, -(r.ty - hubXY.y)) * 180 / Math.PI + 360) % 360;
      if (!force && r.pingAnim && Math.abs(ang - r.pingAng) < 1) continue;
      if (r.pingAnim) r.pingAnim.cancel();
      r.pingAng = ang;
      r.pingAnim = lifetime.animate(r.ping, [{ opacity: 0, transform: 'scale(.9)' }, { opacity: .9, transform: 'scale(1)', offset: .004 }, { opacity: 0, transform: 'scale(1.45)', offset: .1 }, { opacity: 0, transform: 'scale(1.45)' }],
        { duration: SWEEP_MS, iterations: Infinity, delay: ang / 360 * SWEEP_MS - SWEEP_MS });
      r.pingAnim.startTime = 0;
    }
  }

  function chain(id) { const out = new Set(); let cur = nodes.get(id), g = 0; while (cur && g++ < 12) { out.add(cur.id); cur = cur.item.parent ? nodes.get(cur.item.parent) : null; } return out; }
  function highlight() {
    const id = hoverId || pinnedId, on = id && nodes.has(id) ? chain(id) : new Set();
    el.classList.toggle('hl-on', on.size > 0);
    for (const r of nodes.values()) { r.el.classList.toggle('hl', on.has(r.id)); r.el.classList.toggle('pinned', r.id === pinnedId); }
    for (const rec of edges.values()) {
      const lit = rec.kind !== 'sby' && on.has(rec.b) && (rec.a == null || on.has(rec.a));
      rec.base.classList.toggle('hl', lit); if (rec.flow) rec.flow.classList.toggle('hl', lit); if (rec.inner) rec.inner.classList.toggle('hl', lit);
    }
  }
  // Floating cards dock in a corner that covers neither the node they describe nor anything that needs you: the top
  // corner away from the node first, so the lit path to the hub stays in view.
  function dock(r, w, hh, spots) {
    const avoid = [...nodes.values()].filter(n => n === r || n.state === 'needs-you').map(n => ({ x0: n.tx - n.rad - 12, x1: n.tx + n.rad + 12, y0: n.ty - n.rad - 12, y1: n.ty + n.rad + 12 }));
    const away = r.tx > W / 2 ? 'left' : 'right', near = away === 'left' ? 'right' : 'left', bottom = W >= 560 ? 28 : 0;
    const box = ([sx, sy]) => { const x0 = sx === 'left' ? 0 : W - w, y0 = sy === 'top' ? 0 : H - bottom - hh; return { x0, x1: x0 + w, y0, y1: y0 + hh }; };
    const hits = sp => avoid.filter(a => overlaps(a, box(sp))).length;
    return spots.map(([a, y]) => [a === 'away' ? away : near, y]).reduce((b, sp) => hits(sp) < hits(b) ? sp : b);
  }
  function showReadout(r) {
    readBox.replaceChildren(nodeCard(r.item));
    show(readout, true);
    const [x, y] = dock(r, readout.offsetWidth, readout.offsetHeight, [['away', 'top'], ['near', 'top'], ['away', 'bottom'], ['near', 'bottom']]);
    readout.classList.toggle('left', x === 'left'); readout.classList.toggle('right', x === 'right'); readout.classList.toggle('bottom', y === 'bottom');
  }
  function hover(r, on) {
    if (on) { hoverId = r.id; if (r.id !== pinnedId) showReadout(r); }
    else if (hoverId === r.id) { hoverId = null; show(readout, false); }
    highlight();
  }
  function togglePin(id) { if (pinnedId === id) unpin(); else { pinnedId = id; show(readout, false); fillPin(); highlight(); } }
  function unpin() { pinnedId = null; pinFor = null; pinCard = null; pinBox.replaceChildren(); show(pinBox, false); show(legend, W >= 560 && nodes.size > 0); highlight(); }
  function fillPin() {
    const r = nodes.get(pinnedId); if (!r) { unpin(); return; }
    const i = r.item; show(pinBox, true); show(legend, false);
    if (pinFor !== pinnedId) {
      pinFor = pinnedId;
      const close = h('button', { class: 'btn', type: 'button' }, icon('close'), 'Unpin');
      close.addEventListener('click', () => { const b = r.btn; unpin(); b.focus(); });
      const toCards = api.showCard && h('button', { class: 'btn', type: 'button',
        on: { click: () => api.showCard(i.kind === 'session' ? i.id : i.session) } }, icon('cards'), 'Show in cards');
      if (i.kind === 'session') pinCard = sessionCard(api);
      else { const box = h('div', { class: 'card cutbox' }); pinCard = { el: box, update: ii => box.replaceChildren(nodeCard(ii)) }; }
      pinBox.replaceChildren(pinCard.el, h('div', { class: 'pin-bar' }, toCards, close));
    }
    if (i.kind === 'session') pinCard.update(i.x, cx); else pinCard.update(i);
    const [x] = dock(r, pinBox.offsetWidth, pinBox.offsetHeight, [['away', 'bottom'], ['near', 'bottom']]);
    pinBox.classList.toggle('left', x === 'left');
  }
  function roving() {
    if (!rovingId || !nodes.has(rovingId)) { const f = [...nodes.values()].find(r => r.item.kind === 'session') || nodes.values().next().value; rovingId = f ? f.id : null; }
    for (const r of nodes.values()) setAttr(r.btn, 'tabindex', r.id === rovingId ? '0' : '-1');
  }
  layer.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (pinnedId) { e.preventDefault(); unpin(); } return; }
    const cur = nodes.get(rovingId);
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[e.key];
    if (!cur || !dir) return;
    e.preventDefault();
    let best = null, bs = Infinity;
    for (const r of nodes.values()) {
      if (r === cur) continue;
      const vx = r.tx - cur.tx, vy = r.ty - cur.ty, along = vx * dir[0] + vy * dir[1];
      if (along <= 4) continue;
      const score = along + 2 * Math.abs(vx * dir[1] - vy * dir[0]);
      if (score < bs) { bs = score; best = r; }
    }
    if (best) { rovingId = best.id; roving(); best.btn.focus(); }
  });

  function render() {
    if (!data || !W || !H) return;
    const items = graph(data), L = layout(items);
    const singleProject = L.G.length === 1 ? L.G[0].name : null;
    txt(hubHost, (cx.host || 'This PC') + (singleProject ? ' · ' : ''));
    hubProject.set(singleProject); show(hubProject.el, !!singleProject);
    show(empty, items.length === 0); show(legend, items.length > 0 && W >= 560 && !pinnedId);
    hub.style.transform = `translate(${hubXY.x.toFixed(1)}px, ${hubXY.y.toFixed(1)}px)`;
    empty.style.top = Math.round(hubXY.y + 52) + 'px';
    drawRings(L, items.length > 0);
    placeLabels(items, L);
    drawGroups(L, items);
    const seen = new Set();
    for (const i of items) {
      let r = nodes.get(i.id);
      const fresh = !r;
      if (fresh) { r = makeNode(i); nodes.set(i.id, r); layer.append(r.el); }
      seen.add(i.id); r.item = i; r.tx = i.px; r.ty = i.py;
      if (fresh) {
        const p = i.parent ? nodes.get(i.parent) : null, o = drawn ? (p && p.x != null ? p : hubXY) : { x: i.px, y: i.py };
        r.x = o.x; r.y = o.y; placeNode(r); r.toolSig = toolSig(i);
        if (drawn && !motion.rm) lifetime.animate(r.btn, [{ opacity: 0, transform: 'scale(.3)' }, { opacity: 1, transform: 'none' }], { duration: 450, easing: EASE });
      }
      if (r.state === 'running' && i.state === 'done') r.pulse = true;
      r.state = i.state; setData(r.el, 's', i.state); setData(r.el, 'project', i.project || cx.byId?.get(i.session)?.project);
      drawFace(r, i); setSpinner(r, i); setLabel(r, i);
      const ts = toolSig(i); if (!fresh && ts && ts !== r.toolSig) spark(r); r.toolSig = ts;
      setAttr(r.btn, 'aria-label', nodeLabel(i));
    }
    for (const [id, r] of nodes) if (!seen.has(id)) {
      nodes.delete(id); r.pingAnim?.cancel();
      if (cx.project) r.el.remove();
      else { r.el.inert = true; r.el.style.opacity = '0'; lifetime.delay(() => r.el.remove(), 300); }
    }
    syncEdges(items);
    moveAll();
    if (!drawn) retime(true);
    // A changed TV target updates the pin after the nodes exist, without taking keyboard focus.
    const nextPin = cx.autoPin ?? null;
    if (nextPin !== autoPin) {
      if (nextPin) { pinnedId = nextPin; show(readout, false); }
      else if (pinnedId === autoPin) unpin();
      autoPin = nextPin;
    }
    if (pinnedId) fillPin();
    if (hoverId && nodes.has(hoverId)) { if (!readout.hidden) showReadout(nodes.get(hoverId)); } else if (hoverId) { hoverId = null; show(readout, false); }
    highlight(); roving();
    drawn = true;
  }
  return {
    el, nodeCard,
    update(sessions, c) { data = sessions; cx = c || {}; render(); },
    pin(id) {
      const r = nodes.get(id);
      if (!r) return false;
      if (pinnedId !== id) togglePin(id);
      rovingId = id; roving(); r.btn.focus({ preventScroll: true });
      return true;
    },
    hoverDemo(id) { const r = nodes.get(id); if (r) hover(r, true); },   // the gallery shows a lit path without a mouse
  };
}

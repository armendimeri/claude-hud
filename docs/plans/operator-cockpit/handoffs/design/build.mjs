// P1-01 layout study generator. Reads the frozen P1 fixtures unchanged and writes frames/*.html and layout.json.
// Run from the repository root: node docs/plans/operator-cockpit/handoffs/design/build.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../../../..');
const { snapshots, times } = await import(pathToFileURL(join(root, 'tests/fixtures/cockpit/public.mjs')).href);

// ---------- vocabulary ----------
const WORD = { 'needs-you': 'NEEDS YOU', working: 'WORKING', agents: 'AGENTS WORKING', done: 'DONE', idle: 'IDLE', sub: 'WORKING', 'sub-done': 'DONE', sat: 'IDLE', ended: 'ENDED' };
const PROV = { anthropic: 'A', bedrock: 'B', openai: 'O' };
const PROV_NAME = { anthropic: 'ANTHROPIC', bedrock: 'BEDROCK', openai: 'OPENAI' };
const LONG_TITLE = 'Reconcile the quarterly invoice export totals against the ledger before the audit review on Friday';
const QUESTION = 'Which date should the export use?';

const ICON = {
  back: 'M15 5l-7 7 7 7', close: 'M6 6l12 12M18 6L6 18', chevup: 'M6 15l6-6 6 6', chevdown: 'M6 9l6 6 6-6', chevright: 'M9 6l6 6-6 6',
  alert: 'M12 4l9 16H3zM12 10v4M12 17.2v.01', check: 'M5 12.5l4.5 4.5L19 7', spin: 'M12 3a9 9 0 1 0 9 9',
  agent: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM9 12h6', idle: 'M12 8a4 4 0 1 0 .01 0',
  eyeoff: 'M3 12s3.5-6 9-6c1.7 0 3.2.5 4.4 1.2M21 12s-3.5 6-9 6c-1.7 0-3.2-.5-4.4-1.2M4 4l16 16M10 10a3 3 0 0 0 4 4',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01', tool: 'M4 6l6 6-6 6M12 18h8', send: 'M4 12l16-8-6 16-3-7z', refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  scope: 'M4 5h16l-6 8v6l-4-2v-4z', dot: 'M12 12h.01', clock: 'M12 4a8 8 0 1 0 .01 0M12 8v4l3 2', cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
};
const ic = (name, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[name]}"/></svg>`;
const GLYPH = { 'needs-you': 'alert', working: 'spin', agents: 'agent', done: 'check', idle: 'idle', sub: 'spin', 'sub-done': 'check', ended: 'dot' };
const COLOR = { 'needs-you': 'alert', working: 'amber', agents: 'agent', done: 'ok', idle: 'arc', sub: 'agent', 'sub-done': 'ok' };
const stag = (s, extra = '', cls = '') => `<span class="stag ${cls}" data-c="${COLOR[s] || 'dim'}">${ic(GLYPH[s], 'gl' + (s === 'working' || s === 'sub' ? ' spin' : ''))}<span class="label">${WORD[s]}</span>${extra ? `<span class="stag-x mono">${extra}</span>` : ''}</span>`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// node glyph in the 40-unit hexagon box
const HEX = 'M20 2L36 11V29L20 38L4 29V11Z';
const HEX2 = 'M20 -0.5L38.2 10V30L20 40.5L1.8 30V10Z';
const NG = {
  'needs-you': '<path class="gl" d="M20 11.5L29.5 28H10.5ZM20 18v5M20 25.3v.01" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  working: '<path class="gl" d="M20 12a8 8 0 1 1-8 8" stroke-width="2.2" stroke-linecap="round"/>',
  sub: '<path class="gl" d="M20 12a8 8 0 1 1-8 8" stroke-width="2.2" stroke-linecap="round"/>',
  agents: '<path class="gl" d="M20 11.5L27.5 16V24L20 28.5L12.5 24V16ZM17 20h6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  done: '<path class="gl" d="M12.5 20.5L18 26L27.5 14.5" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  'sub-done': '<path class="gl" d="M12.5 20.5L18 26L27.5 14.5" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  idle: '<circle class="gl" cx="20" cy="20" r="4.5" stroke-width="2.2"/>',
  ended: '<path class="gl" d="M14 20h12" stroke-width="2.2" stroke-linecap="round"/>',
  sat: '<circle class="gl sat" cx="20" cy="31" r="1.6" stroke-width="1.5"/>',
  group: '<circle class="gl sat" cx="20" cy="32" r="1.6" stroke-width="1.5"/>',
};

// ---------- composed scenes from the frozen fixtures ----------
const fmt = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const sess = snap => Object.fromEntries(snap.sessions.map(s => [s.id, s]));
const sparse = snapshots.sparse, dense = snapshots.dense;
const A = sess(sparse)['claude:export/α'], B = sess(sparse)['codex:export/β'], C = sess(sparse)['claude-bedrock'];
const CHILD = A.subagents[0];
const now = sparse.now;
const waitSince = A.needsYou.since;
const waitTimer = '0:42';          // synthetic: the fixture clock is fixed, the displayed timer is an example string

function sparseModel() {
  const nodes = [
    { id: A.id, project: 'Ledger', title: A.title, s: 'needs-you', prov: PROV[A.provider], timer: waitTimer, prio: 1, size: 44, tool: null, model: 'OPUS 5.5', providerName: 'ANTHROPIC', kind: 'question' },
    { id: CHILD.id, project: 'Ledger', title: CHILD.description, s: 'sub', prov: 'A', timer: '', prio: 4, size: 32, parent: A.id, tool: 'Read · export.mjs' },
    { id: C.id, project: 'Ledger', title: C.title, s: 'done', prov: 'B', timer: '0:30', prio: 3, size: 44, tool: null, model: 'OPUS 5.5', providerName: 'BEDROCK' },
    { id: B.id, project: 'Reports', title: B.title, s: 'working', prov: 'O', timer: '', prio: 2, size: 44, tool: 'Read · export.mjs', model: 'GPT TEST CODEX', providerName: 'OPENAI' },
  ];
  return {
    nodes, projects: ['Ledger', 'Reports'], counts: { sessions: 3, working: 1, needs: 1, sub: 1 },
    strip: { done: 'Check totals finished', doneProject: 'Ledger', doneAge: '0:30', act: 'Read · export.mjs', actProject: 'Reports' },
    clusters: p => ({ Ledger: { members: [A.id, C.id], collapsed: false }, Reports: { members: [B.id], collapsed: false } })[p],
    selectedDefault: A.id,
  };
}
function denseModel() {
  const all = dense.sessions;
  const byP = {};
  const nodes = [];
  const label = s => (s.id === 'dense-1' ? LONG_TITLE : s.title);
  const status = s => (s.status === 'needs-you' ? 'needs-you' : s.status === 'busy' ? 'working' : 'idle');
  for (const s of all) (byP[s.project] ||= []).push(s);
  const make = s => ({ id: s.id, project: s.project, title: label(s), s: status(s), prov: PROV[s.provider], timer: s.status === 'needs-you' ? waitTimer : '',
    prio: s.id === 'dense-1' ? 0 : s.status === 'needs-you' ? 1 : s.status === 'busy' ? 3 : 5, size: 36, tool: s.status === 'busy' ? 'Read · export.mjs' : null,
    model: 'OPUS 5.5', providerName: PROV_NAME[s.provider] });
  const clusters = {};
  for (const p of ['Ledger', 'Reports', 'Imports', 'Invoices']) {
    const list = byP[p], expanded = p === 'Ledger';
    const shown = expanded ? list : list.filter(s => s.status !== 'idle');
    const idle = expanded ? [] : list.filter(s => s.status === 'idle');
    shown.forEach(s => nodes.push(make(s)));
    if (expanded) nodes.push({ id: 'child', project: p, title: CHILD.description, s: 'sub', prov: 'A', timer: '', prio: 4, size: 26, parent: A.id, tool: 'Read · export.mjs' });
    if (idle.length) nodes.push({ id: 'sat-' + p, project: p, title: `${idle.length} idle sessions`, s: 'sat', count: idle.length, prov: '', prio: 9, size: 30 });
    clusters[p] = { members: [...shown.map(s => s.id), ...(idle.length ? ['sat-' + p] : [])], collapsed: !expanded, total: list.length, idle: idle.length,
      working: list.filter(s => s.status === 'busy').length, needs: list.filter(s => s.status === 'needs-you').length };
  }
  // Ledger ring order is start order: the parent first, then its siblings
  return {
    nodes, projects: ['Ledger', 'Reports', 'Imports', 'Invoices'], counts: { sessions: 24, working: dense.totals.busy, needs: dense.totals.needsYou, sub: dense.totals.subagentsRunning },
    strip: { act: 'Read · export.mjs', actProject: 'Reports', compact: true },
    clusters: p => clusters[p], selectedDefault: 'dense-1',
  };
}

// ---------- layout in scene-rectangle units ----------
// Stable keyed slots: cluster centre and ring slot are functions of the rectangle only, so a width change moves nothing relative to it.
function layout(model, mode, W, H) {
  const pos = {};
  const clusterGeo = {};
  const ang = (deg, rx, ry) => [Math.cos(deg * Math.PI / 180) * rx, Math.sin(deg * Math.PI / 180) * ry];
  const defs = {
    sparse: { Ledger: [0.30, 0.52, 0.19, [200, 20]], Reports: [0.76, 0.5, 0.0, [0]] },
    dense: { Ledger: [0.30, 0.56, 0.175, null], Reports: [0.76, 0.19, 0.085, [200, 340, 90]], Imports: [0.76, 0.50, 0.085, [200, 340]], Invoices: [0.76, 0.81, 0.085, [200, 340]] },
  }[mode];
  for (const p of model.projects) {
    const [u, v, rf, slots] = defs[p];
    const cx = u * W, cy = v * H;
    const rx = Math.min(rf * W, mode === 'sparse' ? 210 : 175), ry = rx * 0.5;
    const cl = model.clusters(p);
    const members = cl.members;
    members.forEach((id, i) => {
      let dx, dy;
      if (slots && slots[i] !== undefined) [dx, dy] = ang(slots[i], rx, ry);
      else { const n = members.length, start = mode === 'dense' ? 100 : -72; [dx, dy] = ang(start + (360 / n) * i, rx, ry); }
      pos[id] = { x: cx + dx, y: cy + dy };
    });
    clusterGeo[p] = { cx, cy, rx, ry, collapsed: cl.collapsed, cl };
  }
  for (const n of model.nodes) if (n.parent) { const pp = pos[n.parent]; pos[n.id] = { x: pp.x - 10, y: pp.y + (mode === 'sparse' ? 76 : 64) }; }
  return { pos, clusterGeo };
}

// ---------- labels ----------
function labelBox(n) {
  const t = Math.min(176, trunc(n.title, 26).length * 7.6);
  const s = 18 + WORD[n.s].length * 9.2 + (n.timer ? 8 + n.timer.length * 6.6 : 0);
  return { w: Math.ceil(Math.max(t, s)) + 10, h: 38 };
}
function placeLabels(nodes, pos, bounds, obstacles, selId) {
  const out = {}, boxes = [...obstacles];
  const circ = n => { const r = (n.id === selId ? 32 : n.size / 2 + 5); const p = pos[n.id]; return { l: p.x - r, t: p.y - r, r: p.x + r, b: p.y + r }; };
  const hit = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
  const vis = nodes.filter(n => n.s !== 'sat' && n.s !== 'group' && pos[n.id].x > bounds.l && pos[n.id].x < bounds.r && pos[n.id].y > bounds.t && pos[n.id].y < bounds.b);
  const circles = nodes.map(circ);
  const order = [...vis].sort((a, b) => a.prio - b.prio);
  const suppressed = [];
  for (const n of order) {
    const { w, h } = labelBox(n), p = pos[n.id], r = n.id === selId ? 34 : n.size / 2 + 6;
    const cands = [[p.x + r + 4, p.y - h / 2], [p.x - r - 4 - w, p.y - h / 2], [p.x - w / 2, p.y + r + 2], [p.x - w / 2, p.y - r - 2 - h],
      [p.x + r - 6, p.y - r - h + 4], [p.x - r + 6 - w, p.y - r - h + 4], [p.x + r - 6, p.y + r - 4], [p.x - r + 6 - w, p.y + r - 4],
      [p.x + r + 30, p.y - h / 2], [p.x - r - 30 - w, p.y - h / 2], [p.x - w / 2, p.y + r + 30], [p.x - w / 2, p.y - r - 30 - h]];
    let done = false;
    for (const [x, y] of cands) {
      const b = { l: x, t: y, r: x + w, b: y + h };
      if (b.l < bounds.l + 6 || b.r > bounds.r - 6 || b.t < bounds.t + 6 || b.b > bounds.b - 6) continue;
      if (boxes.some(o => hit(b, o))) continue;
      if (circles.some((c, i) => nodes[i].id !== n.id && hit(b, c))) continue;
      out[n.id] = { x: x - p.x, y: y - p.y, w, h }; boxes.push(b); done = true; break;
    }
    if (!done) suppressed.push(n);
  }
  const waiting = nodes.filter(n => n.s === 'needs-you' && vis.includes(n) && !out[n.id]);
  if (waiting.length) throw new Error('A waiting session lost its label: ' + waiting.map(n => n.id).join(', '));
  return { out, suppressed };
}

// ---------- frame pieces ----------
function nodeHtml(n, p, lab, selected, disc, alias, opts = {}) {
  const size = n.size, half = size / 2;
  const word = WORD[n.s];
  const ariaName = disc ? `${alias.project(n)}, ${alias.session(n)}, ${word.toLowerCase()}` :
    n.s === 'sat' ? `${n.project}, ${n.count} idle sessions` : `${n.project}, ${n.title}, ${word.toLowerCase()}${n.kind === 'question' ? ', waiting for answer' : ''}`;
  const glyph = NG[n.s === 'sat' ? 'sat' : n.s];
  const ring2 = n.s === 'needs-you' ? `<path class="ring2" d="${HEX2}"/>` : '';
  const sat = n.s === 'sat' ? `<span class="sat-n" style="left:${-half}px;top:${-half - 2}px;width:${size}px;height:${size}px">+${n.count}</span>` : '';
  const prov = n.prov && !disc ? `<span class="prov" data-p="${n.prov}" style="left:${half - 8}px;top:${-half - 4}px">${n.prov}</span>` : '';
  let label = '';
  if (lab) {
    const t = disc ? alias.session(n) : trunc(n.title, 26);
    const x = disc ? '' : n.timer;
    label = `<span class="nlabel" style="left:${lab.x}px;top:${lab.y}px"><span class="t" ${disc ? '' : `title="${esc(n.title)}"`}>${esc(t)}</span><span class="s">${ic(GLYPH[n.s], 'gl')}<span>${word}</span>${x ? `<span class="x">${x}</span>` : ''}</span></span>`;
  }
  return `<button type="button" class="node" data-s="${n.s}" data-word="${word}" ${selected ? 'data-sel' : ''} aria-label="${esc(ariaName)}" style="left:${p.x.toFixed(1)}px;top:${p.y.toFixed(1)}px">` +
    `<span class="hit" data-primary></span>${selected ? '<span class="selring"></span>' : ''}` +
    `<svg class="hex" width="${size}" height="${size}" viewBox="0 0 40 40" style="left:${-half}px;top:${-half}px">${ring2}<path class="body" d="${HEX}"/>${glyph}</svg>${sat}${prov}${label}</button>`;
}

function platformSvg(W, H, geo, pos, model, disc, alias) {
  let s = `<svg class="plat" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">`;
  for (const p of model.projects) {
    const g = geo[p];
    const dash = g.collapsed ? ' stroke-dasharray="4 4"' : '';
    s += `<ellipse cx="${g.cx}" cy="${g.cy}" rx="${g.rx + 54}" ry="${g.ry + 40}" fill="rgba(41,230,255,.04)" stroke="rgba(41,230,255,.22)" stroke-width="1"${dash}/>`;
    s += `<ellipse cx="${g.cx}" cy="${g.cy}" rx="${g.rx}" ry="${g.ry}" fill="none" stroke="rgba(41,230,255,.10)" stroke-width="1"/>`;
  }
  for (const n of model.nodes) if (n.parent) s += `<line x1="${pos[n.parent].x}" y1="${pos[n.parent].y}" x2="${pos[n.id].x}" y2="${pos[n.id].y}" stroke="#b28cff" stroke-opacity=".7" stroke-width="1"/>`;
  return s + '</svg>';
}

function clusterLabels(model, geo, disc, alias, boundsShift = 0) {
  return model.projects.map((p, i) => {
    const g = geo[p], cl = g.cl;
    const name = disc ? alias.projectName(i) : p;
    const parts = [];
    if (cl.needs !== undefined) {
      parts.push(`${cl.total} sessions`);
      if (cl.needs) parts.push(`${cl.needs} needs you`);
      if (cl.working) parts.push(`${cl.working} working`);
    } else parts.push(`${cl.members.length} ${cl.members.length === 1 ? 'session' : 'sessions'}`);
    const y = g.cy - (g.ry + 40) - 36;
    return { x: g.cx + boundsShift, y, name, html: `<div class="cl" ${i === 0 ? 'data-annot="8"' : ''} style="left:${g.cx.toFixed(1)}px;top:${y.toFixed(1)}px"><div class="n">${esc(name)}</div><div class="m">${esc(parts.join(' · '))}</div></div>`, w: Math.max(name.length * 9.6, parts.join(' · ').length * 6.9) + 12 };
  });
}

// ---------- geometry of a frame ----------
function geometry(spec) {
  const { w, h } = spec;
  const padX = w >= 1440 ? 24 : w >= 1024 ? 16 : 12, padY = w >= 1024 ? 16 : 12;
  const narrow = w < 600;
  let y = padY;
  const g = { padX, padY, narrow };
  g.top = { x: padX, y, w: w - 2 * padX, h: 56 }; y += 56 + 8;
  if (narrow) { g.sum = { x: padX, y, w: w - 2 * padX, h: 28 }; y += 28 + 8; }
  if (spec.recon) { g.recon = { x: padX, y, w: w - 2 * padX, h: 48 }; y += 48 + 8; }
  const attnH = narrow ? 72 : 48;
  g.attn = { x: padX, y, w: w - 2 * padX, h: attnH }; y += attnH + 8;
  g.strip = { x: padX, y: h - padY - 44, w: w - 2 * padX, h: 44 };
  const sceneH = g.strip.y - 8 - y;
  const full = w - 2 * padX;
  let mode = 'none', insW = 0;
  if (spec.inspector) {
    insW = spec.inspW || 400;
    if (narrow) mode = 'sheet';
    else if (full - insW - 16 >= 640) mode = 'side';
    else { mode = 'overlay'; insW = Math.min(insW, 440); }
  }
  g.mode = mode; g.insW = insW;
  g.sceneFull = { x: padX, y, w: full, h: sceneH };
  g.scene = { x: padX, y, w: mode === 'side' ? full - insW - 16 : full, h: sceneH };
  g.insp = mode === 'side' ? { x: padX + full - insW, y, w: insW, h: sceneH } : mode === 'overlay' ? { x: padX + full - insW, y, w: insW, h: sceneH } : mode === 'sheet' ? { x: padX, y: y + 112, w: full, h: sceneH - 112 } : null;
  return g;
}
const box = r => `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;

// ---------- chrome ----------
function topbar(spec, g, alias) {
  const c = spec.model.counts, disc = spec.discreet;
  const proj = disc ? 'All projects' : 'All projects';
  const exit = `<button type="button" class="act" data-primary data-role="exit" data-annot="1" aria-label="Return to dashboard" ${spec.exitPressed ? 'style="box-shadow:0 0 0 2px var(--arc)"' : ''}>${ic('back')}<span>${g.narrow ? 'Exit' : 'Dashboard'}</span></button>`;
  const field = `<button type="button" class="field" data-primary data-annot="2" aria-label="Project scope: all projects"><span class="k label">${g.narrow ? '' : 'Project'}</span><span class="trunc" title="All projects">${g.narrow ? 'All' : proj}</span>${ic('chevdown')}</button>`;
  const live = spec.recon ? `<span class="live amber" data-annot="6">${ic('alert', 'gl')}<span class="label">Reconnecting</span></span>` : `<span class="live" data-annot="6"><i></i><span class="label">Live</span></span>`;
  const dis = `<button type="button" class="act ${disc ? 'pressed' : ''}" data-primary data-annot="4" aria-pressed="${disc}" aria-label="Discreet display ${disc ? 'on' : 'off'}">${ic('eyeoff')}${g.narrow ? '' : '<span>Discreet</span>'}</button>`;
  const lab = narrowLabels => ({ sessions: 'Sessions', working: 'Working', needs: 'Needs you', sub: 'Subagents' });
  const cnt = (k, cc) => `<div class="cnt" ${cc ? `data-c="${cc}"` : ''}><b>${c[k]}</b><span class="label">${lab()[k]}</span></div>`;
  const counts = `<div class="counts" data-annot="3">${cnt('sessions')}${cnt('working', 'amber')}${cnt('needs', 'alert')}${cnt('sub', 'agent')}</div>`;
  const wm = g.narrow || spec.w < 1280 ? '' : '<span class="wm">Cockpit</span>';
  if (g.narrow) {
    return `<div class="abs tbar" style="${box(g.top)}">${exit}${field}<span style="flex:1"></span>${live}${dis}</div>` +
      `<div class="abs tsum" style="${box(g.sum)}" data-annot="3"><b>${c.sessions}</b><span>sessions</span><b class="c-amber">${c.working}</b><span>working</span><b class="c-alert">${c.needs}</b><span>needs you</span><b class="c-agent">${c.sub}</b><span>subagents</span></div>`;
  }
  return `<div class="abs tbar" style="${box(g.top)}">${exit}${wm}${field}${counts}${live}${dis}</div>`;
}

function attention(spec, g, alias) {
  const disc = spec.discreet, dis = spec.recon;
  const inspect = `<button type="button" class="act alertc ${dis ? 'off' : ''}" data-primary data-role="inspect" ${dis ? 'disabled' : ''} aria-label="Inspect the waiting session">${g.narrow ? 'Inspect' : 'Inspect'}${ic('chevright')}</button>`;
  const proj = disc ? alias.projectName(0) : 'Ledger', ttl = disc ? alias.sessionName(0) : spec.model === undefined ? '' : 'Export';
  const why = disc ? 'Waiting for you' : `Question · ${QUESTION}`;
  const tm = '0:42';
  const head = `<span class="stag" data-c="alert">${ic('alert', 'gl')}<span class="label-13 label">Needs you</span></span>`;
  if (g.narrow) {
    return `<div data-role="attention" data-annot="5" class="abs attn narrow cutbox" style="${box(g.attn)}"><div class="top">${head}<span class="tm">${tm}</span><span style="flex:1"></span>${inspect}</div>` +
      `<div class="who"><span class="proj">${esc(proj)}</span><span class="ttl trunc" ${disc ? '' : `title="${esc(ttl)}"`}>${esc(ttl)}</span><span class="why trunc" ${disc ? '' : `title="${esc(why)}"`}>${esc(trunc(why, 60))}</span></div></div>`;
  }
  return `<div data-role="attention" data-annot="5" class="abs attn cutbox" style="${box(g.attn)}">${head}<div class="who"><span class="proj">${esc(proj)}</span><span class="ttl trunc" ${disc ? '' : `title="${esc(ttl)}"`}>${esc(ttl)}</span><span class="why trunc" ${disc ? '' : `title="${esc(why)}"`}>${esc(why)}</span></div><span class="tm">${tm}</span>${inspect}</div>`;
}

function strip(spec, g, alias) {
  const s = spec.model.strip, disc = spec.discreet;
  const parts = [];
  if (s.done) parts.push(`<span class="it" data-annot="13">${stag('done')}<span class="trunc" ${disc ? '' : `title="${esc(s.done)}"`}>${disc ? '1 finished' : esc(s.done)}</span><span class="x mono">${disc ? '' : esc(s.doneProject) + ' · '}${s.doneAge} ago</span></span>`);
  const showAct = !s.done || (!disc && !g.narrow);
  if (showAct) parts.push(`<span class="it" ${s.done ? '' : 'data-annot="13"'}>${ic('tool', 'gl c-dim')}${disc ? '<span class="label c-ink2">Latest activity</span>' : `<span class="trunc mono" style="font-size:11px" title="${esc(s.act)}">${esc(s.act)}</span><span class="x mono" style="font-size:11px">${esc(s.actProject)}</span>`}</span>`);
  const btn = `<button type="button" class="act" data-primary aria-expanded="false" aria-label="Open activity feed">${g.narrow ? '' : '<span>Activity</span>'}${ic('chevup')}</button>`;
  return `<div class="strip cutbox" style="${box(g.strip)}" data-role="strip">${parts.join('')}<span class="sp"></span>${btn}</div>`;
}

// ---------- inspector ----------
function chips(n, disc) {
  if (disc) return `<span class="chip">Provider</span>`;
  return `<span class="chip prov" data-p="${n.providerName === 'BEDROCK' ? 'bedrock' : 'anthropic'}">${n.providerName}</span><span class="chip">${n.model}</span><span class="chip"><span class="trunc">${esc(n.project)}</span></span>`;
}
function closeBtn(g) {
  return g.mode === 'sheet'
    ? `<button type="button" class="act" data-primary data-role="close" data-annot="17" aria-label="Back to the map">${ic('back')}<span>Back to map</span></button>`
    : `<button type="button" class="act icon-only" data-primary data-role="close" data-annot="17" aria-label="Close inspector">${ic('close')}</button>`;
}
function inspector(spec, g, n) {
  const kind = spec.inspector;
  const narrow = g.narrow;
  const long = n.title.length > 40;
  const dim = kind === 'unavailable' ? 'dim50' : '';
  const hd = `<div class="hd"><div class="r1">${g.mode === 'sheet' ? closeBtn(g) : ''}${g.mode === 'sheet' ? '' : chips(n)}<span class="sp"></span>${g.mode === 'sheet' ? '' : closeBtn(g)}</div>` +
    (g.mode === 'sheet' ? `<div class="r1" style="gap:8px">${chips(n)}</div>` : '') +
    `<h2 class="ttl" ${long ? `title="${esc(n.title)}"` : ''}>${esc(n.title)}</h2>` +
    `<div class="r3 ${dim}">${stag(n.s, n.s === 'needs-you' ? '0:42' : '')}<span class="trunc">${kind === 'unavailable' ? 'Last known 12s ago' : n.tool ? esc(n.tool) + ' · 2.0s' : 'Running 0:30'}</span></div></div>`;
  let bd = '', composer = '';
  const conv = rows => `<div class="sec conv"><span class="label c-dim">Conversation</span>${rows}</div>`;
  const row = (who, text, cls = '') => `<div class="msg ${cls}"><span class="who label">${who}</span><span class="tx">${esc(text)}</span></div>`;
  if (kind === 'question') {
    bd = `<div class="sec"><span class="label">Activity</span><div class="kv">${narrow ? '' : `<span class="k label">Current tool</span><span class="v mono" style="font-size:13px">None · waiting</span>`}<span class="k label">Latest step</span><span class="v mono" style="font-size:13px">Read · export.mjs · 2s ago</span>${narrow ? '' : `<span class="k label">Subagent</span><span class="v">${stag('sub')}<span class="c-ink2"> Explore · Review export</span></span>`}</div></div>` +
      `<div class="qcard" data-annot="15"><span class="label c-alert">Question · needs you · 0:42</span><span class="qt">${esc(QUESTION)}</span><div class="choices"><button type="button" class="choice" aria-pressed="false" data-primary>Today</button><button type="button" class="choice" aria-pressed="true" data-primary>${ic('check')}Month end</button></div><button type="button" class="act" data-primary style="align-self:flex-start">${ic('send')}<span>Send answer</span></button></div>` +
      conv(row('You', 'Check the invoice export.') + row('Tool', '▸ 1 tool step · Read · export.mjs', 'tool') + row('Agent', QUESTION, 'assistant'));
  } else if (kind === 'observed') {
    bd = `<div class="sec"><span class="label">Activity</span><div class="kv"><span class="k label">Current tool</span><span class="v mono" style="font-size:13px">Read · export.mjs · 2.0s</span><span class="k label">Started</span><span class="v mono" style="font-size:13px">0:30 ago</span><span class="k label">Latest step</span><span class="v mono" style="font-size:13px">Edit · export.mjs · 14s ago</span></div></div>` +
      conv(row('You', 'Reconcile the totals and flag any invoice that changed after export.') + row('Tool', '▸ 3 tool steps · Read · export.mjs', 'tool') + row('Agent', 'Totals match except one invoice dated after the export cut-off.', 'assistant') + row('Tool', '▸ 1 tool step · Edit · export.mjs', 'tool'));
    composer = `<div class="composer" data-annot="16"><div class="ta" style="color:var(--ink-3)">Follow-up unavailable · observed only</div><div class="col"><button type="button" class="act off" data-primary disabled>${ic('send')}<span>Send</span></button></div></div>`;
  } else if (kind === 'unavailable') {
    bd = `<div class="qcard dim50"><span class="label c-alert">Question · needs you · paused</span><span class="qt">${esc(QUESTION)}</span><div class="choices"><button type="button" class="choice" aria-pressed="false" data-primary disabled>Today</button><button type="button" class="choice" aria-pressed="false" data-primary disabled>Month end</button></div></div>` +
      `<div class="unavail">${ic('alert')}<div><b>History unavailable</b>Source disconnected · showing last known state from 12s ago. This is not an empty conversation. <span class="c-amber">Reconnecting…</span></div></div>`;
  }
  const bodyHtml = `<div class="bd">${bd}</div>${composer}`;
  return `<section class="abs insp panel cutbox" data-annot="14" style="${box(g.insp)};${g.mode === 'overlay' ? 'z-index:20' : ''}" aria-label="Session inspector"><div class="pb" style="background-color:${g.mode === 'side' ? 'rgba(8,17,28,.97)' : '#08111c'}">${hd}${bodyHtml}</div></section>`;
}

// ---------- fallback list ----------
function fallbackList(g) {
  const row = (s, title, tool, prov, extra = '', sel = false, indent = 0) => `<div class="frow" data-primary ${sel ? 'data-sel' : ''} tabindex="0"><span style="padding-left:${indent}px">${stag(s, extra)}</span><span class="trunc" title="${esc(title)}"><b>${esc(title)}</b>${tool ? ` <span class="c-ink2 mono" style="font-size:11px">${esc(tool)}</span>` : ''}</span><span class="c-ink2 trunc">${prov}</span>${ic('chevright')}</div>`;
  return `<div class="flist"><div class="banner" data-annot="7">${ic('alert')}<span style="flex:1;min-width:0"><b>3D view unavailable</b> <span class="c-ink2">· Showing the project list. Selecting, inspecting and exiting still work.</span></span><button type="button" class="act" data-primary style="margin-right:4px">${ic('refresh')}<span>Retry 3D</span></button></div>` +
    `<div class="dim50"><div class="grp"><div class="label"><span class="c-ink">Ledger</span><span>3 sessions · 1 needs you</span></div>` +
    row('needs-you', 'Export', 'Waiting for answer', 'Anthropic · Opus 5.5', '0:42', true) + row('sub', 'Review export', 'Read · export.mjs', 'Subagent · Explore', '', false, 24) + row('done', 'Check totals', 'Finished 0:30 ago', 'Bedrock · Opus 5.5') + `</div>` +
    `<div class="grp" style="margin-top:12px"><div class="label"><span class="c-ink">Reports</span><span>1 session · 1 working</span></div>` + row('working', 'Export', 'Read · export.mjs', 'OpenAI · GPT test codex') + `</div></div></div>`;
}

// ---------- discreet exit sheet ----------
function exitSheet(g, spec) {
  const sh = { x: g.padX, y: spec.h - g.padY - 300, w: g.top.w, h: 300 };
  return `<div class="scrim" style="left:0;top:0;width:${spec.w}px;height:${spec.h}px"></div><section class="sheet panel cutbox" role="dialog" aria-label="Leave discreet display" style="${box(sh)};background-color:rgba(8,17,28,.97);z-index:30" data-annot="17"><div class="big">Leaving the cockpit</div>` +
    `<p class="c-ink2">Discreet display is on. The dashboard shows names and details.</p>` +
    `<button type="button" class="act wrap" data-primary style="width:100%">Return to dashboard and reveal details</button>` +
    `<button type="button" class="act pressed" data-primary style="width:100%;justify-content:center">Stay discreet</button></section>`;
}

// ---------- aliases for discreet display ----------
function makeAlias(model) {
  const pIdx = Object.fromEntries(model.projects.map((p, i) => [p, i]));
  const sIdx = Object.fromEntries(model.nodes.map((n, i) => [n.id, i + 1]));
  return { project: n => `Project ${pIdx[n.project] + 1}`, session: n => (n.s === 'sub' ? 'Agent ' : 'Session ') + sIdx[n.id], projectName: i => `Project ${i + 1}`, sessionName: i => `Session ${i + 1}` };
}

// ---------- compose a frame ----------
function compose(spec) {
  const g = geometry(spec);
  const model = spec.model;
  const disc = !!spec.discreet;
  const alias = makeAlias(model);
  const mode = spec.layout;
  const W = g.scene.w, H = g.scene.h;
  const lay = layout(model, mode, W, H);
  const selId = spec.selected === undefined ? model.selectedDefault : spec.selected;
  const showSel = spec.selected !== null && !!spec.inspector || spec.forceSelection;
  const sel = showSel ? selId : null;
  // overlay mode pans the scene so the selected node stays in the uncovered area
  let panX = 0;
  const bounds = { l: 0, t: 0, r: W, b: H };
  if (g.mode === 'overlay') {
    bounds.r = W - g.insW;
    const p = lay.pos[sel];
    if (p && p.x > bounds.r - 60) panX = bounds.r / 2 - p.x;
  }
  const clGeo = JSON.parse(JSON.stringify(lay.clusterGeo)); // cluster members references survive via clusters()
  for (const p of model.projects) { clGeo[p].cl = lay.clusterGeo[p].cl; clGeo[p].cx += panX; }
  const pos = {};
  for (const n of model.nodes) pos[n.id] = { x: lay.pos[n.id].x + panX, y: lay.pos[n.id].y };
  const cls = clusterLabels(model, clGeo, disc, alias);
  // project names are placed first and act as obstacles for node labels
  const obstacles = cls.map(c => ({ l: c.x - c.w / 2, t: c.y - 2, r: c.x + c.w / 2, b: c.y + 34 }));
  const { out: labs, suppressed } = disc && spec.noLabels ? { out: {}, suppressed: [] } : placeLabels(model.nodes, pos, bounds, obstacles, sel);
  const nodesHtml = model.nodes.map(n => nodeHtml(n, pos[n.id], labs[n.id], n.id === sel, disc, alias)).join('');
  const hiddenCount = suppressed.length;
  const fallback = spec.fallback;
  const note = fallback ? '' : `<div class="hint-supp label">${hiddenCount ? `<span data-annot="11">${ic('list', 'gl')}</span><span>${hiddenCount} labels hidden · names in the list and on focus</span>` : ''}</div>`;
  const legend = g.narrow ? '' : `<div class="legend label" style="right:${g.mode === 'overlay' ? g.insW + 12 : 12}px">${['needs-you', 'working', 'agents', 'done', 'idle'].map(s => `<span>${ic(GLYPH[s], 'gl')}${WORD[s]}</span>`).join('')}</div>`;
  const stageInner = fallback ? fallbackList(g) : `${platformSvg(W, H, clGeo, pos, { ...model, nodes: model.nodes }, disc, alias)}${cls.map(c => c.html).join('')}${nodesHtml}${note}${legend}`;
  const forbid = disc ? ['Ledger', 'Reports', 'Imports', 'Invoices', 'Export', 'Check totals', 'export.mjs', 'Which date', 'Review export', 'Synthetic', 'Reconcile'] : [];
  const needsAttr = model.counts.needs ? 'some' : 'none';

  let body = `<div class="stage-bg"></div>` + topbar(spec, g, alias);
  if (g.recon) body += `<div class="bar-recon abs" style="${box(g.recon)}" role="status">${ic('alert', 'gl')}<span class="label-13 label">Reconnecting</span><span>Last update 12s ago · showing last known state · live actions paused</span><span style="flex:1"></span><button type="button" class="act" data-primary >Retry now</button></div>`;
  body += attention(spec, g, alias);
  body += `<section class="scene panel cutbox" data-annot="${g.narrow ? '7' : '7'}" style="${box(g.scene)}" aria-label="Project map"><div class="pb"><div class="stage" data-w="${W}">${stageInner}</div></div></section>`;
  if (spec.inspector && spec.inspector !== 'none') body += inspector(spec, g, model.nodes.find(n => n.id === selId));
  body += strip(spec, g, alias);
  if (spec.exitSheet) body += exitSheet(g, spec);
  const title = `P1-01 ${spec.name}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=${spec.w}"><title>${title}</title>` +
    `<link rel="stylesheet" href="../../../../../../src/web/styles/foundation.css"><link rel="stylesheet" href="../design.css"></head>` +
    `<body data-frame="${spec.name}" data-inspector="${g.mode}" data-needs="${needsAttr}" data-forbid='${JSON.stringify(forbid)}' style="width:${spec.w}px;height:${spec.h}px">${body}<pre id="audit" hidden></pre><script src="../audit.js"></script></body></html>`;
  const labelled = Object.keys(labs).length;
  const meta = {
    name: spec.name, viewport: [spec.w, spec.h], inspectorMode: g.mode, rects: { topbar: g.top, attention: g.attn, scene: g.scene, sceneFull: g.sceneFull, inspector: g.insp, strip: g.strip, summary: g.sum || null, reconnect: g.recon || null },
    pan: panX, nodes: model.nodes.length, labelled, suppressed: suppressed.map(n => n.id), positions: Object.fromEntries(model.nodes.map(n => [n.id, { x: +pos[n.id].x.toFixed(1), y: +pos[n.id].y.toFixed(1), u: +(pos[n.id].x / W).toFixed(4), v: +(pos[n.id].y / H).toFixed(4) }])),
  };
  return { html, meta };
}

// ---------- narrow composition: collapsed project nodes ----------
function composeNarrow(spec) {
  const g = geometry(spec);
  const disc = !!spec.discreet;
  const dm = spec.model;
  const alias = makeAlias(dm);
  const W = g.scene.w, H = g.scene.h;
  // fixed slots in rectangle fractions
  const groups = [
    { p: 'Ledger', total: 8, working: 3, needs: 1, u: 0.30, v: 0.30 },
    { p: 'Reports', total: 6, working: 2, needs: 0, u: 0.74, v: 0.24 },
    { p: 'Imports', total: 5, working: 1, needs: 0, u: 0.74, v: 0.60 },
    { p: 'Invoices', total: 5, working: 1, needs: 0, u: 0.28, v: 0.78 },
  ];
  const a = dm.nodes.find(n => n.id === A.id);
  const waiting = { ...a, size: 40, prio: 1 };
  const waitPos = { x: 0.34 * W, y: 0.50 * H };
  const sel = spec.selected === null ? null : A.id;
  const els = [];
  let svg = `<svg class="plat" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">`;
  groups.forEach(gr => { svg += `<ellipse cx="${gr.u * W}" cy="${gr.v * H}" rx="82" ry="52" fill="rgba(41,230,255,.04)" stroke="rgba(41,230,255,.22)" stroke-dasharray="4 4"/>`; });
  svg += `<line x1="${0.30 * W}" y1="${0.30 * H + 26}" x2="${waitPos.x}" y2="${waitPos.y - 22}" stroke="#b28cff" stroke-opacity=".5"/></svg>`;
  els.push(svg);
  const obstacles = [];
  groups.forEach((gr, i) => {
    const name = disc ? alias.projectName(i) : gr.p;
    const meta = `${gr.total} · ${gr.needs ? gr.needs + ' needs you · ' : ''}${gr.working} working`;
    const x = gr.u * W, y = gr.v * H;
    const w = Math.max(name.length * 9.6, meta.length * 6.9) + 12;
    els.push(`<div class="cl" ${i === 0 ? 'data-annot="8"' : ''} style="left:${x}px;top:${y + 34}px"><div class="n">${esc(name)}</div><div class="m">${esc(meta)}</div></div>`);
    obstacles.push({ l: x - w / 2, t: y + 32, r: x + w / 2, b: y + 68 });
    const st = gr.needs ? 'needs-you' : 'working';
    const word = WORD[st];
    els.push(`<button type="button" class="node" data-s="${st}" data-word="${word}" aria-label="${esc(`${name}, ${gr.total} sessions, ${word.toLowerCase()}, collapsed project`)}" style="left:${x}px;top:${y}px"><span class="hit" data-primary></span><svg class="hex" width="52" height="52" viewBox="0 0 40 40" style="left:-26px;top:-26px"><path class="body" d="${HEX}"/>${NG.group}</svg><span class="sat-n" style="left:-26px;top:-28px;width:52px;height:52px;font-size:13px">${gr.total}</span></button>`);
  });
  // the waiting session stays individually visible and labelled
  const pos = { [A.id]: waitPos };
  const lab = { x: 30, y: -19, w: 160, h: 38 };
  els.push(nodeHtml({ ...waiting }, waitPos, lab, sel === A.id, disc, alias));
  const forbid = disc ? ['Ledger', 'Reports', 'Imports', 'Invoices', 'Export', 'Check totals', 'export.mjs', 'Which date', 'Review export', 'Synthetic'] : [];
  let body = `<div class="stage-bg"></div>` + topbar(spec, g, alias) + attention(spec, g, alias);
  body += `<section class="scene panel cutbox" data-annot="7" style="${box(g.sceneFull)}" aria-label="Project map"><div class="pb"><div class="stage"><div class="hint-supp label"><span data-annot="11">${ic('list', 'gl')}</span><span>Tap a project to expand it</span></div><div style="position:absolute;inset:0;transform:translateY(${spec.inspector ? 56 - waitPos.y : 0}px)">${els.join('')}</div></div></div></section>`;
  if (spec.inspector) body += inspector(spec, g, { ...waiting, project: 'Ledger', model: 'OPUS 5.5', providerName: 'ANTHROPIC' });
  body += strip(spec, g, alias);
  if (spec.exitSheet) body += exitSheet(g, spec);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=${spec.w}"><title>P1-01 ${spec.name}</title>` +
    `<link rel="stylesheet" href="../../../../../../src/web/styles/foundation.css"><link rel="stylesheet" href="../design.css"></head>` +
    `<body data-frame="${spec.name}" data-inspector="${g.mode}" data-needs="some" data-forbid='${JSON.stringify(forbid)}' style="width:${spec.w}px;height:${spec.h}px">${body}<pre id="audit" hidden></pre><script src="../audit.js"></script></body></html>`;
  return { html, meta: { name: spec.name, viewport: [spec.w, spec.h], inspectorMode: g.mode, rects: { topbar: g.top, summary: g.sum, attention: g.attn, scene: g.scene, inspector: g.insp, strip: g.strip } } };
}

// ---------- frame list ----------
const sm = sparseModel(), dm = denseModel();
const frames = [
  { name: 'sparse-1440', w: 1440, h: 900, layout: 'sparse', model: sm, inspector: null, selected: null },
  { name: 'sparse-1440-inspector', w: 1440, h: 900, layout: 'sparse', model: sm, inspector: 'question' },
  { name: 'dense-1440', w: 1440, h: 900, layout: 'dense', model: dm, inspector: 'observed', inspW: 480 },
  { name: 'sparse-1024', w: 1024, h: 768, layout: 'sparse', model: sm, inspector: 'question' },
  { name: 'dense-1024', w: 1024, h: 768, layout: 'dense', model: dm, inspector: 'observed', inspW: 440 },
  { name: 'discreet-1440', w: 1440, h: 900, layout: 'sparse', model: sm, inspector: null, selected: null, discreet: true },
  { name: 'fallback-1440', w: 1440, h: 900, layout: 'sparse', model: sm, inspector: 'unavailable', fallback: true, recon: true, forceSelection: true },
  { name: 'narrow-1-waiting', w: 390, h: 844, narrow: true, model: dm, inspector: null, selected: null },
  { name: 'narrow-2-inspect', w: 390, h: 844, narrow: true, model: dm, inspector: 'question' },
  { name: 'narrow-3-exit', w: 390, h: 844, narrow: true, model: dm, inspector: null, selected: null, discreet: true, exitSheet: true, exitPressed: true },
];

mkdirSync(join(here, 'frames'), { recursive: true });
const layoutJson = { generatedFrom: 'tests/fixtures/cockpit/public.mjs (snapshots.sparse, snapshots.dense, unchanged)', fixtureTimes: { T0: times[0] }, frames: {} };
for (const spec of frames) {
  const { html, meta } = spec.narrow ? composeNarrow(spec) : compose(spec);
  writeFileSync(join(here, 'frames', spec.name + '.html'), html);
  layoutJson.frames[spec.name] = meta;
}
writeFileSync(join(here, 'layout.json'), JSON.stringify(layoutJson, null, 2) + '\n');

// ---------- contrast of the status colours on the panel base (documented in SPEC.md) ----------
const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mix = (fg, bg, a) => fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
const deep = hex('#08111c'), ink = hex('#d6f3ff');
const contrast = {
  panelBase: '#08111c',
  ink: +ratio(ink, deep).toFixed(2), ink2: +ratio(mix(ink, deep, .68), deep).toFixed(2), ink3: +ratio(mix(ink, deep, .42), deep).toFixed(2),
  alert: +ratio(hex('#ff4d5e'), deep).toFixed(2), amber: +ratio(hex('#ffb547'), deep).toFixed(2), ok: +ratio(hex('#4dffa6'), deep).toFixed(2), agent: +ratio(hex('#b28cff'), deep).toFixed(2), arc: +ratio(hex('#29e6ff'), deep).toFixed(2),
  alertOnAlertTint: +ratio(hex('#ff4d5e'), mix(hex('#ff4d5e'), deep, .08)).toFixed(2),
};
layoutJson.contrast = contrast;
writeFileSync(join(here, 'layout.json'), JSON.stringify(layoutJson, null, 2) + '\n');
console.log('frames', frames.length, 'contrast', JSON.stringify(contrast));
for (const [k, v] of Object.entries(layoutJson.frames)) console.log(k, v.inspectorMode, 'nodes', v.nodes ?? '-', 'labelled', v.labelled ?? '-', 'suppressed', (v.suppressed || []).length);

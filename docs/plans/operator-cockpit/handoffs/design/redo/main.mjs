// P2-01 look study: page wiring. Data (fixture or a live HUD), the unchanged projection and layout from src/, the
// cockpit chrome (top bar, attention row, inspector, activity strip) and the hologram scene from holo.mjs.
//
// URL parameters
//   ?data=sparse|dense            synthetic fixture (default sparse)
//   ?api=http://127.0.0.1:7790    live /api/state of a HUD (through serve.mjs's proxy when cross-origin)
//   ?select=waiting|first|<n>     select a node at start (n = index in reading order)
//   ?discreet=1  ?effects=0  ?opening=0|<seconds to freeze at>  ?sim=0  ?quality=auto|0|1|2|3
import { createLayout } from '../../../../../../src/web/cockpit/layout.mjs';
import { STATE, accessibleName, diffModels, projectSnapshot } from '../../../../../../src/web/cockpit/projection.mjs';
import { fmtDur, provName } from '../../../../../../src/web/components/format.mjs';
import { glyph } from '../../../../../../src/web/components/status.mjs';
import { createHolo } from './holo.mjs';
import { dense, sparse, tick } from './fixtures.mjs';

const params = new URLSearchParams(location.search);
const $ = sel => document.querySelector(sel);
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const motion = { rm: reduced.matches };
const state = {
  source: params.get('api') ? 'live' : (params.get('data') || 'sparse'),
  api: params.get('api'),
  discreet: params.get('discreet') === '1',
  effects: params.get('effects') !== '0',
  selected: null,          // entity key
  snapshot: null, model: null, world: null,
  localAt: Date.now(), error: null,
};
document.documentElement.classList.toggle('rm', motion.rm);

// ---- discreet aliases (same rules as src/web/cockpit/scene.mjs) ---------------------------------------------------
const aliases = { session: new Map(), agent: new Map(), project: new Map() };
const alias = (kind, key, prefix) => { const m = aliases[kind]; if (!m.has(key)) m.set(key, m.size + 1); return `${prefix} ${m.get(key)}`; };
function textFor(e) {
  if (e.kind === 'group') return { group: state.discreet ? alias('project', e.groupKey, 'Project') : e.groupKey };
  if (!state.discreet) return { title: e.title, tool: e.tool, reason: e.reason, group: e.project, name: accessibleName(e) };
  const group = alias('project', e.groupKey, 'Project');
  const entity = e.kind === 'sat' ? `${e.count} ${e.folds === 'idle' ? 'idle sessions' : 'finished subagents'}` : e.kind === 'sub' ? alias('agent', e.key, 'Agent') : alias('session', e.key, 'Session');
  return { title: entity, tool: null, reason: e.state === 'needs-you' ? 'Waiting for you' : null, group, name: accessibleName(e, { group, entity }) };
}
const serverNow = () => (state.snapshot?.now ?? Date.now()) + (Date.now() - state.localAt);
function timerOf(e) {
  const from = e.state === 'done' || e.state === 'sub-done' ? e.endedAt : e.since;
  return from ? fmtDur(Math.max(0, serverNow() - from)) : '';
}

// ---- scene ----------------------------------------------------------------------------------------------------------
const stage = $('#stage');
const holo = createHolo({
  host: stage, labels: $('#labels'), overlay: $('#leaders'), textFor, motion,
  onPick: key => select(key),
});
holo.setTimeFormatter(timerOf);
holo.setEffects(state.effects);
holo.setDiscreet(state.discreet);
if (params.get('quality')) holo.setQualityMode(params.get('quality'));
const layout = createLayout();
const expanded = new Set();

function frameRect() {
  const f = $('#frame').getBoundingClientRect(), s = stage.getBoundingClientRect();
  return { x: f.left - s.left, y: f.top - s.top + 28, w: f.width, h: f.height - 28 - 30 };
}
new ResizeObserver(() => holo.setRect(frameRect())).observe($('#frame'));
addEventListener('resize', () => holo.setRect(frameRect()));

// ---- data -----------------------------------------------------------------------------------------------------------
let simStep = 0;
function apply(snapshot) {
  const prev = state.model;
  state.snapshot = snapshot;
  state.localAt = Date.now();
  const next = projectSnapshot(snapshot, { expanded, project: null, now: snapshot.now });
  const diff = diffModels(prev, next);
  if (diff.layout || !state.world) state.world = layout.update({ groups: next.groups.map(({ key }) => ({ key })), entities: next.entities });
  state.model = next;
  holo.setModel(next, state.world);
  // Events for the scene: finishes (the green pulse) and tool calls (a ripple).
  if (prev) for (const e of next.entities) {
    const old = prev.byKey.get(e.key);
    if (!old) continue;
    const finished = (old.state === 'sub' && e.state === 'sub-done') || ((old.state === 'working' || old.state === 'agents') && (e.state === 'done' || e.state === 'idle'));
    if (finished) { holo.pulse(e.key); feed('DONE', e, e.kind === 'sub' ? 'finished' : 'finished its turn'); }
    else if (e.tool && e.tool !== old.tool) { holo.packet(e.key); feed('TOOL', e, e.tool); }
    if (e.state === 'needs-you' && old.state !== 'needs-you') feed('NEEDS YOU', e, e.reason || 'waiting');
  }
  if (!state.selected && params.get('select') && !state.autoSelected) {
    state.autoSelected = true;
    const want = params.get('select');
    const pickKey = want === 'waiting' ? next.visible.find(k => next.byKey.get(k).state === 'needs-you')
      : want === 'first' ? next.visible.find(k => next.byKey.get(k).kind === 'session') : next.visible[Number(want)];
    if (pickKey) select(pickKey, false);
  }
  if (state.selected && !next.byKey.has(state.selected)) select(null);
  renderChrome();
}

async function loadLive() {
  const target = state.api.replace(/\/+$/, '');
  const sameOrigin = new URL(target, location.href).origin === location.origin;
  const tries = sameOrigin ? [target + '/api/state'] : ['/api/state?target=' + encodeURIComponent(target), target + '/api/state'];
  for (const url of tries) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status + ' ' + (await res.text()).slice(0, 120));
      state.error = null;
      state.via = url.startsWith('/api/state?') ? 'proxy :' + location.port : 'direct';
      return await res.json();
    } catch (error) { state.error = String(error.message || error); }
  }
  return null;
}
async function start() {
  if (state.source === 'live') {
    const first = await loadLive();
    apply(first || sparse());
    if (!first) $('#live-err').textContent = 'Live HUD not readable (' + state.error + ') · showing the sparse fixture';
    setInterval(async () => { if (document.hidden) return; const s = await loadLive(); if (s) apply(s); renderChrome(); }, 2000);
  } else {
    let snap = state.source === 'dense' ? dense() : sparse();
    apply(snap);
    if (params.get('sim') !== '0') setInterval(() => { if (document.hidden) return; snap = tick(snap, Date.now(), simStep++); apply(snap); }, 2600);
  }
  const op = params.get('opening');
  if (op === '0' || motion.rm || !state.effects) { holo.skipOpening(); document.body.classList.remove('booting'); feedLine('SYSTEM', 'COCKPIT ONLINE', summaryLine()); }
  else if (op && !Number.isNaN(Number(op))) { holo.playOpening(); holo.setOpeningTime(Number(op)); bootChrome(Number(op), true); }
  else { holo.playOpening(); bootChrome(0, false); }
  setInterval(renderClockish, 1000);
  holo.setRect(frameRect());
}

// ---- opening (chrome side) ----------------------------------------------------------------------------------------
let bootTimer = 0;
function bootChrome(at, frozen) {
  document.body.classList.add('booting');
  document.body.style.setProperty('--boot-at', `-${at}s`);
  if (frozen) document.body.classList.add('boot-frozen');
  const online = $('#online');
  online.hidden = false;
  holo.onFrame(({ opening, t }) => {
    const k = Math.max(0, Math.min(1, (t - 1.7) / 0.4));
    const word = 'COCKPIT ONLINE';
    online.querySelector('span').textContent = word.slice(0, Math.ceil(word.length * k));
    online.style.opacity = t < 1.6 ? 0 : t > 2.2 ? Math.max(0, 1 - (t - 2.2) / 0.25) : 1;
    if (!opening) { online.hidden = true; document.body.classList.remove('booting'); holo.onFrame(null); feedLine('SYSTEM', 'COCKPIT ONLINE', summaryLine()); }
  });
  if (!frozen) {
    const skip = () => { holo.skipOpening(); removeEventListener('pointerdown', skip, true); removeEventListener('keydown', skip, true); };
    addEventListener('pointerdown', skip, true);
    addEventListener('keydown', skip, true);
  }
}
function replay() {
  if (motion.rm || !state.effects) return;
  holo.releaseOpening();
  holo.playOpening();
  document.body.classList.remove('boot-frozen');
  document.body.style.setProperty('--boot-at', '0s');
  // Restart CSS animations.
  document.body.classList.remove('booting'); void document.body.offsetWidth;
  bootChrome(0, false);
}

// ---- selection --------------------------------------------------------------------------------------------------
function select(key, toggle = true) {
  if (toggle && key && key === state.selected) key = null;
  const e = key && state.model?.byKey.get(key);
  if (e && e.kind === 'sat') {
    const satKey = e.folds === 'idle' ? 'project:' + e.groupKey : e.key;
    expanded.has(satKey) ? expanded.delete(satKey) : expanded.add(satKey);
    apply(state.snapshot);
    return;
  }
  state.selected = e ? key : null;
  holo.setSelected(state.selected, e?.groupKey || null);
  document.body.classList.toggle('has-inspector', !!e);
  renderInspector();
  requestAnimationFrame(() => holo.setRect(frameRect()));
}

// ---- chrome ---------------------------------------------------------------------------------------------------
function renderChrome() {
  const m = state.model, s = state.snapshot;
  if (!m) return;
  const sessions = m.entities.filter(e => e.kind === 'session').length + m.groups.reduce((n, g) => n + g.idleFolded, 0);
  const working = m.entities.filter(e => e.state === 'working' || e.state === 'agents').length;
  const waiting = m.entities.filter(e => e.state === 'needs-you');
  const subs = m.entities.filter(e => e.state === 'sub').length;
  setText('#n-sessions', sessions); setText('#n-working', working); setText('#n-waiting', waiting.length); setText('#n-subs', subs);
  $('#c-waiting').dataset.on = waiting.length ? '1' : '';
  $('#live').dataset.mode = state.source === 'live' ? (state.error ? 'down' : 'live') : 'fixture';
  setText('#live-word', state.source === 'live' ? (state.error ? 'DOWN' : 'LIVE') : state.source === 'dense' ? 'FIXTURE · DENSE' : 'FIXTURE · SPARSE');
  $('#discreet').setAttribute('aria-pressed', String(state.discreet));
  $('#effects').setAttribute('aria-pressed', String(state.effects));
  for (const b of document.querySelectorAll('[data-src]')) b.setAttribute('aria-pressed', String(b.dataset.src === state.source));
  // Attention row: the oldest waiting session.
  const att = $('#attention');
  const oldest = waiting.slice().sort((a, b) => (a.since ?? 0) - (b.since ?? 0))[0];
  att.hidden = !oldest;
  document.body.classList.toggle('has-attention', !!oldest);
  if (oldest) {
    const t = textFor(oldest);
    setText('#att-project', state.discreet ? t.group : oldest.project);
    setText('#att-title', t.title);
    setText('#att-reason', (oldest.askKind === 'question' ? 'Question · ' : '') + (t.reason || 'Waiting for you'));
    setText('#att-time', timerOf(oldest));
    att.dataset.key = oldest.key;
    setText('#att-more', waiting.length > 1 ? `+${waiting.length - 1} more` : '');
  }
  setText('#frame-count', `${sessions} ${sessions === 1 ? 'SESSION' : 'SESSIONS'} · ${m.groups.length} ${m.groups.length === 1 ? 'PROJECT' : 'PROJECTS'}${s?.host ? ' · ' + (state.discreet ? 'HOST' : s.host) : ''}`);
  renderInspector();
  requestAnimationFrame(() => holo.setRect(frameRect()));
}
function renderClockish() {
  const st = holo.viewInfo();
  setText('#readout', `AZ ${fmt(st.view.az)}° · EL ${fmt(st.view.elev)}° · ZOOM ${st.view.zoom.toFixed(2)}`);
  if (params.get('perf') === '1') setText('#perf', `${st.interval.p95 ? (1000 / Math.max(1, st.interval.p50)).toFixed(0) : '--'} FPS · P95 ${st.interval.p95.toFixed(1)} MS · Q${st.quality}`);
  if (state.model) {
    const oldest = state.model.entities.find(e => e.key === $('#attention').dataset.key);
    if (oldest) setText('#att-time', timerOf(oldest));
    renderInspectorTimes();
  }
}
const fmt = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1).padStart(4, '0');
function setText(sel, v) { const el = typeof sel === 'string' ? $(sel) : sel; const t = String(v); if (el && el.textContent !== t) el.textContent = t; }

function renderInspector() {
  const box = $('#inspector');
  const e = state.selected && state.model?.byKey.get(state.selected);
  box.hidden = !e;
  if (!e) return;
  const t = textFor(e), st = STATE[e.state] || STATE.idle;
  const raw = state.snapshot.sessions.find(x => x.id === e.sessionId);
  const agent = e.agentId && raw?.subagents?.find(a => a.id === e.agentId);
  const chips = state.discreet ? [e.kind === 'sub' ? 'SUBAGENT' : 'SESSION'] : [provName(raw?.provider), agent?.model || raw?.model, e.project].filter(Boolean).map(x => String(x).toUpperCase());
  $('#i-chips').replaceChildren(...chips.map(c => Object.assign(document.createElement('span'), { className: 'chip', textContent: c })));
  setText('#i-title', t.title);
  const stateEl = $('#i-state');
  stateEl.dataset.c = st.color;
  stateEl.replaceChildren(glyph(st.glyph), Object.assign(document.createElement('span'), { className: 'w', textContent: st.word }),
    Object.assign(document.createElement('span'), { className: 'd', textContent: e.state === 'needs-you' ? (t.reason || '') : (t.tool || '') }));
  const rows = [];
  if (e.state === 'needs-you') rows.push(['WAITING', t.reason || 'Waiting for you', 'alert'], ['FOR', timerOf(e), 'time']);
  else if (t.tool) rows.push(['CURRENT TOOL', t.tool, ''], ['FOR', timerOf(e), 'time']);
  rows.push(['STARTED', raw ? fmtDur(serverNow() - (agent?.startedAt || raw.startedAt)) + ' ago' : '—', '']);
  if (!state.discreet && raw && !agent) rows.push(['BRANCH', raw.branch || '—', ''], ['EFFORT', raw.effort || '—', '']);
  const subs = e.kind === 'session' ? (raw?.subagents || []) : [];
  if (subs.length) rows.push(['SUBAGENTS', `${subs.filter(a => a.state === 'running').length} running · ${subs.filter(a => a.state === 'done').length} done`, '']);
  $('#i-rows').replaceChildren(...rows.map(([k, v, c]) => {
    const row = document.createElement('div'); row.className = 'irow'; row.dataset.c = c;
    row.append(Object.assign(document.createElement('span'), { className: 'k', textContent: k }), Object.assign(document.createElement('span'), { className: 'v', textContent: v }));
    return row;
  }));
  $('#i-conv').hidden = state.discreet;
}
function renderInspectorTimes() {
  const e = state.selected && state.model?.byKey.get(state.selected);
  if (!e) return;
  const t = [...document.querySelectorAll('#i-rows .irow[data-c=time] .v')];
  for (const el of t) setText(el, timerOf(e));
}

// ---- activity strip (ticker) ------------------------------------------------------------------------------------
const lines = [];
function feed(tag, e, text) {
  const t = textFor(e);
  feedLine(tag, state.discreet ? t.group : e.project, state.discreet ? (tag === 'TOOL' ? 'tool call' : t.title) : `${t.title} · ${text}`);
}
function feedLine(tag, project, text) {
  lines.unshift({ tag, project, text, at: Date.now() });
  lines.length = Math.min(lines.length, 4);
  const box = $('#ticker');
  box.replaceChildren(...lines.slice(0, 1).map(l => {
    const row = document.createElement('div'); row.className = 'tline'; row.dataset.tag = l.tag;
    row.append(Object.assign(document.createElement('span'), { className: 'tt', textContent: new Date(l.at).toTimeString().slice(0, 8) }),
      Object.assign(document.createElement('span'), { className: 'tg', textContent: l.tag }),
      Object.assign(document.createElement('span'), { className: 'tp', textContent: l.project }),
      Object.assign(document.createElement('span'), { className: 'tx', textContent: l.text }));
    return row;
  }));
}
function summaryLine() {
  const m = state.model; if (!m) return '';
  const w = m.entities.filter(e => e.state === 'needs-you').length;
  return `${m.entities.filter(e => e.kind === 'session').length} sessions in view${w ? ` · ${w} needs you` : ''}`;
}

// ---- controls ---------------------------------------------------------------------------------------------------
$('#discreet').addEventListener('click', () => { state.discreet = !state.discreet; holo.setDiscreet(state.discreet); renderChrome(); });
$('#effects').addEventListener('click', () => { state.effects = !state.effects; holo.setEffects(state.effects); renderChrome(); });
$('#reset').addEventListener('click', () => holo.reset());
$('#replay').addEventListener('click', ev => { ev.stopPropagation(); setTimeout(replay, 0); });
$('#i-close').addEventListener('click', () => select(null));
$('#att-inspect').addEventListener('click', () => select($('#attention').dataset.key, false));
for (const b of document.querySelectorAll('[data-src]')) b.addEventListener('click', () => {
  const u = new URL(location.href);
  u.searchParams.delete('api'); u.searchParams.delete('data');
  if (b.dataset.src === 'live') u.searchParams.set('api', state.api || 'http://127.0.0.1:7790'); else u.searchParams.set('data', b.dataset.src);
  location.href = u.toString();
});
addEventListener('keydown', ev => {
  if (ev.target.closest?.('input,textarea')) return;
  const k = ev.key;
  if (k === 'Escape') select(null);
  else if (k === '0') holo.reset();
  else if (k === 'ArrowLeft') holo.orbitBy(-6, 0);
  else if (k === 'ArrowRight') holo.orbitBy(6, 0);
  else if (k === 'ArrowUp') holo.orbitBy(0, 4);
  else if (k === 'ArrowDown') holo.orbitBy(0, -4);
  else if (k === '+' || k === '=') holo.zoomBy(1.15);
  else if (k === '-') holo.zoomBy(1 / 1.15);
  else if (k === 'd' || k === 'D') $('#discreet').click();
  else if (k === 'r' || k === 'R') setTimeout(replay, 0);
});
reduced.addEventListener?.('change', () => { motion.rm = reduced.matches; document.documentElement.classList.toggle('rm', motion.rm); if (motion.rm) holo.skipOpening(); });

// For capture scripts and reviewers.
window.proto = { holo, state, select, replay, keys: () => state.model?.visible.map(k => ({ key: k, state: state.model.byKey.get(k).state, kind: state.model.byKey.get(k).kind })),
  pulseAny() { const k = state.model.visible.find(x => state.model.byKey.get(x).kind === 'sub'); if (k) holo.pulse(k); return k; }, ready: false };
start().then(() => { window.proto.ready = true; });

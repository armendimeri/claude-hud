// Cockpit 3D scene (P2). `mountScene(host, {store, actions, motion, signal}) => close`, lazy-loaded by the shell.
//
// - The store projection (projection.mjs) and the keyed layout (layout.mjs) are pure; this module only draws them.
// - Three.js is imported on demand from ../vendor/three/, never statically, so a missing or broken vendor file leaves
//   the HTML list, selection and exit working (fallback mode with an explicit Retry).
// - Labels, the list and the status banner are HTML text nodes. The canvas is aria-hidden; the list is the keyboard
//   and screen reader path and calls the same selection callback as a pointer pick.
// - Nothing renders unless something changed: one pending animation frame at most, none while the tab is hidden, and a
//   snapshot that differs only in its clock never schedules a frame.
// - Every GPU resource and callback goes on a disposal stack, so closing (or losing the context, or a failed start)
//   releases exactly what was created.
import { h, setAttr, txt } from '../components/dom.mjs';
import { fmtDur } from '../components/format.mjs';
import { glyph } from '../components/status.mjs';
import { LABEL, createLayout, estimateLabelWidth, placeLabels } from './layout.mjs';
import { STATE, accessibleName, diffModels, entityKey, projectSnapshot } from './projection.mjs';

export const VENDOR_URL = '../vendor/three/three.module.min.js';
const defaultLoader = () => import('../vendor/three/three.module.min.js');

const COLOR = { alert: 0xff4d5e, amber: 0xffb547, ok: 0x4dffa6, agent: 0xb28cff, arc: 0x29e6ff, dim: 0x66788a };
const MAX_DPR = 1.5;
const DRAG_PX = 6, DRAG_TOUCH_PX = 10, HIT_RADIUS = 22;
const ELEV = { min: 20, max: 80, home: 52 }, AZ_LIMIT = 80, ZOOM = { min: 0.55, max: 3.2 };
const FOV = 40;
const MAX_LABELS = 80;

/** LIFO stack of cleanups. `run()` is safe to call twice and keeps going when one cleanup throws. */
export function createDisposer() {
  const stack = [];
  let ran = false;
  return {
    add(fn) { if (ran) { try { fn(); } catch { /* already closed */ } return fn; } stack.push(fn); return fn; },
    run() {
      ran = true;
      const errors = [];
      while (stack.length) { try { stack.pop()(); } catch (error) { errors.push(error); } }
      return errors;
    },
    get size() { return stack.length; },
    get done() { return ran; },
  };
}

function summarize(list) {
  if (!list.length) return null;
  const sorted = list.slice().sort((a, b) => a - b), at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, p50: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), max: +sorted[sorted.length - 1].toFixed(2) };
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rad = deg => deg * Math.PI / 180;
let sceneSeq = 0;

export function mountScene(host, options = {}) {
  const { store, actions = {}, motion = null, signal = null, loadThree = defaultLoader } = options;
  const uid = 'cs' + (++sceneSeq);
  const life = createDisposer();
  let gfx = createDisposer();
  let closed = false;

  // ---- state ----------------------------------------------------------------------------------------------------
  let mode = 'loading';            // loading | 3d | fallback
  let generation = 0;              // bumped by every graphics start attempt, close and retry
  const expanded = new Set();
  const layout = createLayout();
  let model = null, world = null;
  let project = null;
  let selected = null;             // {sessionId, agentId} | null (kept when the entity expires)
  let focusKey = null;
  let discreet = false;
  let width = 0, height = 0;
  let pending = 0, staleHidden = false;
  let localAtSnapshot = Date.now();
  let lastOrderSig = '', lastProjectSig = '';
  const stats = { frames: 0, requested: 0, hiddenSkips: 0, starts: 0, failures: 0, contextLoss: 0, selects: 0, dataEvents: 0, quietEvents: 0 };
  let lastGfx = null;              // numbers captured when the graphics side was disposed
  const aliases = { session: new Map(), agent: new Map(), project: new Map() };

  // ---- DOM ------------------------------------------------------------------------------------------------------
  const canvasHost = h('div', { class: 'cs-canvas', 'aria-hidden': 'true' });
  const labelLayer = h('div', { class: 'cs-labels', 'aria-hidden': 'true' });
  const status = h('div', { class: 'cs-status', role: 'status' });
  const statusText = h('span', { class: 'cs-status-text' });
  const retryButton = h('button', { class: 'cs-btn', type: 'button', hidden: true, text: 'Retry 3D' });
  status.append(statusText, retryButton);
  const resetButton = h('button', { class: 'cs-btn cs-reset', type: 'button', text: 'Reset view', hidden: true, 'aria-label': 'Reset the view' });
  const note = h('div', { class: 'cs-note label', hidden: true, 'aria-hidden': 'true' });
  const empty = h('div', { class: 'cs-empty', hidden: true }, h('span', { class: 'label', text: 'No active sessions' }), h('span', { text: ' · systems nominal' }));
  const list = h('div', { class: 'cs-list', role: 'listbox', tabindex: '0', 'aria-label': 'Sessions and subagents. Arrow keys move, Enter selects, Home and End jump.' });
  const root = h('div', { class: 'cockpit-scene', 'data-mode': 'loading', 'data-connection': 'live' },
    canvasHost, labelLayer, empty, note, resetButton, status, list);
  host.append(root);
  life.add(() => root.remove());

  const rows = new Map();          // key -> row record
  const labels = new Map();        // key -> label record
  const groupLabels = new Map();   // group key -> {el, name, counts}

  function setMode(next, message = '') {
    mode = next;
    root.dataset.mode = next;
    txt(statusText, message);
    status.hidden = !message;
    retryButton.hidden = next !== 'fallback';
    resetButton.hidden = next !== '3d';
  }

  // ---- text helpers ---------------------------------------------------------------------------------------------
  function alias(kind, key, prefix) {
    const map = aliases[kind];
    if (!map.has(key)) map.set(key, map.size + 1);
    return `${prefix} ${map.get(key)}`;
  }
  function textFor(e) {
    if (!discreet) return { title: e.title, tool: e.tool, reason: e.reason, group: e.project, name: accessibleName(e) };
    const group = alias('project', e.groupKey, 'Project');
    const entity = e.kind === 'sat' ? `${e.count} ${e.folds === 'idle' ? 'idle sessions' : 'finished subagents'}`
      : e.kind === 'sub' ? alias('agent', e.key, 'Agent') : alias('session', e.key, 'Session');
    return { title: entity, tool: null, reason: e.state === 'needs-you' ? 'Waiting for you' : null, group,
      name: e.kind === 'sat' ? `${group}, ${entity}, folded. Press Enter to expand` : accessibleName(e, { group, entity }) };
  }
  const serverNow = () => (store?.getServerTime?.() ?? Date.now()) + (Date.now() - localAtSnapshot);
  function timerOf(e) {
    const from = e.state === 'done' || e.state === 'sub-done' ? e.endedAt : e.since;
    return from ? fmtDur(Math.max(0, serverNow() - from)) : '';
  }

  // ---- list rows (keyboard, screen reader and the visible fallback) ---------------------------------------------
  function buildRow(e) {
    const el = h('div', { class: 'cs-row', role: 'option', id: `${uid}-${rows.size}-${Math.random().toString(36).slice(2, 7)}`, 'aria-selected': 'false' });
    const rec = { el, glyphName: null, state: h('span', { class: 'label cs-row-state' }), title: h('span', { class: 'cs-row-title trunc' }),
      tool: h('span', { class: 'cs-row-tool mono trunc' }), time: h('span', { class: 'cs-row-time mono' }), icon: h('span', { class: 'cs-row-icon' }) };
    el.append(rec.icon, rec.state, rec.title, rec.tool, rec.time);
    el.addEventListener('click', () => { focusKey = e.key; activate(e.key); });
    return rec;
  }
  function updateRow(rec, e) {
    const t = textFor(e), st = STATE[e.state] || STATE.idle;
    if (rec.glyphName !== st.glyph) { rec.glyphName = st.glyph; rec.icon.replaceChildren(glyph(st.glyph)); }
    rec.el.dataset.s = e.state;
    rec.el.dataset.c = st.color;
    rec.el.dataset.kind = e.kind;
    txt(rec.state, e.kind === 'sat' ? `+${e.count}` : st.word);
    txt(rec.title, t.title);
    txt(rec.tool, e.kind === 'sat' ? 'expand' : t.reason && e.state === 'needs-you' ? t.reason : t.tool || '');
    txt(rec.time, timerOf(e));
    setAttr(rec.el, 'aria-label', t.name);
    if (discreet) rec.el.removeAttribute('title'); else rec.el.title = t.title;
    rec.el.style.paddingLeft = e.kind === 'sub' ? '28px' : '';
  }
  function syncList() {
    const keep = new Set(model.visible);
    for (const [key, rec] of rows) if (!keep.has(key)) { rec.el.remove(); rows.delete(key); }
    const wanted = [];
    let currentGroup = null;
    for (const key of model.visible) {
      const e = model.byKey.get(key);
      if (!rows.has(key)) rows.set(key, buildRow(e));
      updateRow(rows.get(key), e);
      if (e.groupKey !== currentGroup) {
        currentGroup = e.groupKey;
        const header = headerFor(e);
        wanted.push(header);
      }
      wanted.push(rows.get(key).el);
    }
    const sig = wanted.map(el => el.id || el.dataset.h).join('|');
    if (sig !== lastOrderSig) { list.replaceChildren(...wanted); lastOrderSig = sig; }
    refreshSelectionState();
  }
  const headers = new Map();
  function headerFor(e) {
    let el = headers.get(e.groupKey);
    if (!el) { el = h('div', { class: 'cs-row-head label', role: 'presentation', 'aria-hidden': 'true' }); el.dataset.h = 'h' + headers.size; headers.set(e.groupKey, el); }
    const g = model.groups.find(x => x.key === e.groupKey);
    const name = discreet ? alias('project', e.groupKey, 'Project') : e.groupKey;
    txt(el, g ? `${name} · ${g.sessions} ${g.sessions === 1 ? 'session' : 'sessions'}${g.waiting ? ` · ${g.waiting} needs you` : ''}` : name);
    return el;
  }

  // ---- selection and focus --------------------------------------------------------------------------------------
  const selectedKey = () => selected ? entityKey(selected.sessionId, selected.agentId) : null;
  function refreshSelectionState() {
    const key = selectedKey();
    for (const [k, rec] of rows) {
      setAttr(rec.el, 'aria-selected', String(k === key));
      rec.el.classList.toggle('is-selected', k === key);
      rec.el.classList.toggle('is-focus', k === focusKey && document.activeElement === list);
    }
    for (const [k, rec] of labels) {
      rec.el.classList.toggle('is-selected', k === key);
      rec.el.classList.toggle('is-focus', k === focusKey && document.activeElement === list);
    }
    const row = focusKey && rows.get(focusKey);
    if (row) { list.setAttribute('aria-activedescendant', row.el.id); if (mode === 'fallback') row.el.scrollIntoView?.({ block: 'nearest' }); }
    else list.removeAttribute('aria-activedescendant');
  }
  function setSelectionValue(next) {
    const same = (selected?.sessionId ?? null) === (next?.sessionId ?? null) && (selected?.agentId ?? null) === (next?.agentId ?? null);
    selected = next ? { sessionId: next.sessionId, agentId: next.agentId ?? null } : null;
    if (same) return;
    if (selected) focusKey = selectedKey();
    refreshSelectionState();
    gfxApi.selectionChanged();
  }
  function activate(key) {
    const e = model?.byKey.get(key);
    if (!e) return;
    if (e.kind === 'sat') {
      const satKey = e.folds === 'idle' ? 'project:' + e.groupKey : e.key;
      expanded.has(satKey) ? expanded.delete(satKey) : expanded.add(satKey);
      refresh(true);
      return;
    }
    stats.selects++;
    if (!actions.getSelection) setSelectionValue(e.selection);
    actions.select?.({ sessionId: e.selection.sessionId, agentId: e.selection.agentId });
  }
  function moveFocus(step, to = null) {
    const keys = model?.visible || [];
    if (!keys.length) return;
    let index = to != null ? to : keys.indexOf(focusKey) + step;
    if (to == null && keys.indexOf(focusKey) < 0) index = step > 0 ? 0 : keys.length - 1;
    focusKey = keys[clamp(index, 0, keys.length - 1)];
    refreshSelectionState();
    gfxApi.selectionChanged();
  }
  list.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (event.key in keys) { event.preventDefault(); moveFocus(keys[event.key]); }
    else if (event.key === 'Home') { event.preventDefault(); moveFocus(0, 0); }
    else if (event.key === 'End') { event.preventDefault(); moveFocus(0, (model?.visible.length || 1) - 1); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (focusKey) activate(focusKey); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); gfxApi.zoomBy(1.2); }
    else if (event.key === '-') { event.preventDefault(); gfxApi.zoomBy(1 / 1.2); }
    else if (event.key === '0') { event.preventDefault(); gfxApi.reset(); }
  });
  list.addEventListener('focus', () => { if (!focusKey || !model?.byKey.has(focusKey)) focusKey = selectedKey() && model?.byKey.has(selectedKey()) ? selectedKey() : model?.visible[0] || null; refreshSelectionState(); gfxApi.selectionChanged(); });
  list.addEventListener('blur', () => { refreshSelectionState(); gfxApi.selectionChanged(); });

  // ---- data -----------------------------------------------------------------------------------------------------
  function readProject() { return actions.getProject?.() || null; }
  function readDiscreet() { return !!actions.getDiscreet?.(); }
  /** Rebuild the projection; schedule a draw only when something meaningful changed. */
  function refresh(force = false) {
    if (closed) return;
    const snapshot = store?.getSnapshot?.() || null;
    const nextProject = readProject();
    const nextDiscreet = readDiscreet();
    const projectChanged = nextProject !== project, discreetChanged = nextDiscreet !== discreet;
    project = nextProject;
    discreet = nextDiscreet;
    const next = projectSnapshot(snapshot, { expanded, project, now: store?.getServerTime?.() ?? snapshot?.now ?? 0 });
    const diff = diffModels(model, next);
    if (!force && !projectChanged && !discreetChanged && model && !diff.changed) { stats.quietEvents++; return; }
    stats.dataEvents++;
    if (diff.layout || !world) world = layout.update({ groups: next.groups.map(({ key }) => ({ key })), entities: next.entities });
    model = next;
    if (!selected && actions.getSelection) selected = actions.getSelection() || null;
    if (focusKey && !model.byKey.has(focusKey)) focusKey = null;
    syncList();
    empty.hidden = model.entities.length > 0;
    root.dataset.empty = String(!model.entities.length);
    gfxApi.dataChanged({ layout: diff.layout || projectChanged || force, project: projectChanged });
  }
  const onStoreEvent = event => {
    if (event?.type === 'connection') { updateConnection(); return; }
    if (event?.type === 'snapshot') { localAtSnapshot = Date.now(); refresh(); }
  };
  function updateConnection() {
    const state = store?.getConnection?.()?.status === 'live' || !store?.getConnection ? 'live' : 'reconnecting';
    if (root.dataset.connection !== state) root.dataset.connection = state;
  }

  // ---- graphics side --------------------------------------------------------------------------------------------
  // `gfxApi` is a stable facade; its methods do nothing until graphics are up, so the HTML side never checks.
  let gfxApi = makeIdleGfx();
  function makeIdleGfx() {
    return { dataChanged() {}, selectionChanged() {}, zoomBy() {}, reset() {}, screenOf: () => null };
  }

  function invalidate() {
    if (closed || mode !== '3d') return;
    stats.requested++;
    if (document.hidden) { staleHidden = true; stats.hiddenSkips++; return; }
    if (!pending) gfxApi.schedule?.();
  }

  async function startGraphics() {
    const mine = ++generation;
    stats.starts++;
    setMode('loading', 'Loading 3D view…');
    let THREE;
    try {
      THREE = await loadThree();
    } catch (error) {
      if (mine === generation && !closed) failGraphics('3D view unavailable · Showing the project list. Selecting, inspecting and exiting still work.', error);
      return;
    }
    // The import can resolve after the page left, after another start, or with the host detached.
    if (closed || mine !== generation || signal?.aborted || !host.isConnected) return;
    const local = createDisposer();
    try {
      gfx = local;
      gfxApi = buildGraphics(THREE, local, mine);
      setMode('3d');
      gfxApi.dataChanged({ layout: true, project: true });
      updateConnection();
    } catch (error) {
      // A partially constructed renderer: release whatever was created, then show the list.
      local.run();
      gfx = createDisposer();
      gfxApi = makeIdleGfx();
      failGraphics('3D view unavailable · Showing the project list. Selecting, inspecting and exiting still work.', error);
    }
  }
  function failGraphics(message, error) {
    stats.failures++;
    lastError = error ? String(error.message || error).slice(0, 160) : null;
    teardownGraphics();
    setMode('fallback', message);
    refreshSelectionState();
  }
  let lastError = null;
  function teardownGraphics() {
    generation++;
    pending = 0;
    staleHidden = false;
    gfxApi.beforeDispose?.();
    const errors = gfx.run();
    if (errors.length) lastError = String(errors[0].message || errors[0]).slice(0, 160);
    gfx = createDisposer();
    gfxApi = makeIdleGfx();
    for (const rec of labels.values()) rec.el.remove();
    labels.clear();
    for (const rec of groupLabels.values()) rec.el.remove();
    groupLabels.clear();
    note.hidden = true;
  }
  retryButton.addEventListener('click', () => { if (mode === 'fallback') { teardownGraphics(); startGraphics(); } });
  resetButton.addEventListener('click', () => gfxApi.reset());

  function buildGraphics(THREE, disposer, mine) {
    let renderer = null, canvas = null;
    let frameCounter = 0;
    const own = resource => { disposer.add(() => resource.dispose()); return resource; };

    const record = { before: null, afterResources: null, afterRenderer: null };
    const counts = () => renderer ? { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, programs: renderer.info.programs?.length ?? 0 } : null;
    // Registered first so it runs last, once the renderer is disposed and its context released.
    disposer.add(() => {
      let contextLost = null;
      try { contextLost = renderer.getContext().isContextLost(); } catch { /* no context */ }
      lastGfx = { ...record, afterRenderer: { ...counts(), contextLost } };
    });
    canvas = document.createElement('canvas');
    canvas.className = 'cs-gl';
    disposer.add(() => canvas.remove());
    // A failed context is released through the extension, because the renderer never finished constructing.
    disposer.add(() => { if (renderer) return; try { const gl = canvas.getContext('webgl2') || canvas.getContext('webgl'); gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* nothing to lose */ } });
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'default' });
    disposer.add(() => { try { if (!renderer.getContext().isContextLost()) renderer.forceContextLoss(); } catch { /* already lost */ } });
    disposer.add(() => renderer.dispose());
    // LIFO: this runs after every resource added below is disposed and before the renderer itself is.
    disposer.add(() => { record.afterResources = counts(); });
    renderer.setClearColor(0x000000, 0);
    canvasHost.append(canvas);

    const ac = new AbortController();
    disposer.add(() => ac.abort());
    const listen = (target, type, fn, opts) => target.addEventListener(type, fn, { ...opts, signal: ac.signal });
    listen(canvas, 'webglcontextlost', event => { event.preventDefault(); stats.contextLoss++; failGraphics('3D view lost its graphics context · Showing the project list. Retry to draw it again.', null); });

    // ---- shared geometry and materials ----
    const sceneGraph = new THREE.Scene();
    disposer.add(() => sceneGraph.clear());
    const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 2000);
    const hexGeo = own(new THREE.CylinderGeometry(1, 1, 1, 6));
    hexGeo.translate(0, 0.5, 0);
    const discGeo = own(new THREE.CircleGeometry(1, 48));
    const platRingGeo = own(new THREE.RingGeometry(0.975, 1, 64));
    const outlineGeo = own(new THREE.RingGeometry(1.18, 1.34, 6));
    const shape = points => { const s = new THREE.Shape(); points.forEach(([x, y], i) => i ? s.lineTo(x, y) : s.moveTo(x, y)); s.closePath(); return s; };
    const marks = {
      needs: own(new THREE.ShapeGeometry(shape([[0, 0.62], [0.58, -0.4], [-0.58, -0.4]]))),
      busy: own(new THREE.RingGeometry(0.34, 0.5, 24, 1, 0, Math.PI * 1.5)),
      running: own(new THREE.CircleGeometry(0.42, 6)),
      done: own(new THREE.ShapeGeometry(shape([[-0.5, 0.02], [-0.34, -0.14], [-0.12, 0.1], [0.34, -0.42], [0.5, -0.26], [-0.12, 0.42]]))),
      idle: own(new THREE.RingGeometry(0.22, 0.32, 24)),
      ended: own(new THREE.PlaneGeometry(0.7, 0.14)),
      sat: own(new THREE.ShapeGeometry(shape([[-0.12, 0.45], [0.12, 0.45], [0.12, 0.12], [0.45, 0.12], [0.45, -0.12], [0.12, -0.12], [0.12, -0.45], [-0.12, -0.45], [-0.12, -0.12], [-0.45, -0.12], [-0.45, 0.12], [-0.12, 0.12]]))),
    };
    const bodyMats = {}, markMats = {}, outlineMats = {};
    for (const [state, info] of Object.entries(STATE)) {
      const color = COLOR[info.color];
      bodyMats[state] = own(new THREE.MeshStandardMaterial({ color: 0x0b1a28, emissive: color, emissiveIntensity: state === 'needs-you' ? 0.7 : state === 'ended' ? 0.08 : 0.34, roughness: 0.55, metalness: 0.15, flatShading: true }));
      markMats[state] = own(new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      outlineMats[state] = markMats[state];
    }
    const platRingMat = own(new THREE.MeshBasicMaterial({ color: COLOR.arc, transparent: true, opacity: 0.4, depthWrite: false }));
    const platDiscMat = own(new THREE.MeshBasicMaterial({ color: COLOR.arc, transparent: true, opacity: 0.045, depthWrite: false }));
    const delegationMat = own(new THREE.LineBasicMaterial({ color: COLOR.agent, transparent: true, opacity: 0.9 }));
    const shellMat = own(new THREE.LineDashedMaterial({ color: COLOR.arc, dashSize: 0.8, gapSize: 0.5, transparent: true, opacity: 0.8 }));
    // Selection: four corner brackets drawn as thin quads on the ground plane.
    const brackets = (() => {
      const t = 0.2, a = 0.6, verts = [];
      const quad = (x0, z0, x1, z1) => verts.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z0, x1, 0, z1, x0, 0, z1);
      for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const x = sx, z = sz;
        const [xa, xb] = [Math.min(x, x - sx * t), Math.max(x, x - sx * t)];
        const [za, zb] = [Math.min(z, z - sz * t), Math.max(z, z - sz * t)];
        quad(Math.min(x, x - sx * a), za, Math.max(x, x - sx * a), zb);
        quad(xa, Math.min(z, z - sz * a), xb, Math.max(z, z - sz * a));
      }
      const g = own(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      return g;
    })();
    const bracketMat = own(new THREE.MeshBasicMaterial({ color: COLOR.arc, side: THREE.DoubleSide, depthTest: false, transparent: true }));
    const selection = new THREE.Mesh(brackets, bracketMat);
    selection.renderOrder = 10;
    selection.visible = false;
    sceneGraph.add(selection);
    const focusRing = new THREE.Mesh(own(new THREE.RingGeometry(1.5, 1.62, 6)), own(new THREE.MeshBasicMaterial({ color: COLOR.arc, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.8 })));
    focusRing.rotation.x = -Math.PI / 2;
    focusRing.renderOrder = 9;
    focusRing.visible = false;
    sceneGraph.add(focusRing);
    sceneGraph.add(new THREE.AmbientLight(0x7fa6c4, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(-14, 28, 18);
    sceneGraph.add(sun);

    // ---- scene objects, reconciled from the projection ----
    const nodeObjs = new Map(), platforms = new Map();
    let linkSolid = null, linkDashed = null, linkSig = '';
    const sizeOf = e => e.kind === 'sat' ? 1.25 : e.kind === 'sub' ? 1.25 : e.state === 'needs-you' ? 2 : 1.7;
    const heightOf = e => e.kind === 'session' ? 0.7 : 0.5;
    function makeNode(e) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(hexGeo, bodyMats[e.state]);
      const mark = new THREE.Mesh(marks.idle, markMats[e.state]);
      mark.rotation.x = -Math.PI / 2;
      const outline = new THREE.Mesh(outlineGeo, outlineMats[e.state]);
      outline.rotation.x = -Math.PI / 2;
      group.add(body, mark, outline);
      sceneGraph.add(group);
      return { group, body, mark, outline };
    }
    function styleNode(obj, e) {
      const size = sizeOf(e), tall = heightOf(e);
      const info = STATE[e.state] || STATE.idle;
      obj.body.material = bodyMats[e.state];
      obj.body.scale.set(size, tall, size);
      obj.mark.geometry = marks[e.kind === 'sat' ? 'sat' : info.glyph];
      obj.mark.material = markMats[e.state];
      obj.mark.scale.setScalar(size * 0.9);
      obj.mark.position.y = tall + 0.03;
      obj.outline.visible = e.state === 'needs-you' || e.kind === 'sat';
      obj.outline.scale.setScalar(size);
      obj.outline.position.y = 0.03;
      obj.outline.material = outlineMats[e.state];
      obj.group.userData = { size, tall };
    }
    function syncObjects() {
      const visibleKeys = new Set(model.visible);
      for (const [key, obj] of nodeObjs) if (!visibleKeys.has(key)) { sceneGraph.remove(obj.group); nodeObjs.delete(key); }
      const shownGroups = new Set();
      for (const key of model.visible) {
        const e = model.byKey.get(key), place = world.nodes.get(key);
        if (!place) continue;
        shownGroups.add(e.groupKey);
        let obj = nodeObjs.get(key);
        if (!obj) { obj = makeNode(e); nodeObjs.set(key, obj); }
        styleNode(obj, e);
        obj.group.position.set(place.x, 0, place.z);
      }
      for (const [key, plat] of platforms) if (!shownGroups.has(key)) { sceneGraph.remove(plat.group); platforms.delete(key); }
      for (const key of shownGroups) {
        const place = world.groups.get(key);
        if (!place) continue;
        let plat = platforms.get(key);
        if (!plat) {
          const group = new THREE.Group();
          const disc = new THREE.Mesh(discGeo, platDiscMat), ring = new THREE.Mesh(platRingGeo, platRingMat);
          disc.rotation.x = ring.rotation.x = -Math.PI / 2;
          ring.position.y = 0.01; disc.position.y = 0.005;
          group.add(disc, ring);
          sceneGraph.add(group);
          plat = { group };
          platforms.set(key, plat);
        }
        plat.group.position.set(place.x, 0, place.z);
        plat.group.scale.set(place.radius, 1, place.radius * 0.82);
      }
      // Links: rebuilt only when the relationships or positions changed.
      const sig = model.links.map(l => l.key + l.from).join('|') + '#' + model.visible.map(k => { const p = world.nodes.get(k); return p ? p.x.toFixed(2) + p.z.toFixed(2) : ''; }).join(',');
      if (sig !== linkSig) {
        linkSig = sig;
        const solid = [], dashed = [];
        for (const link of model.links) {
          const a = world.nodes.get(link.from), b = world.nodes.get(link.to);
          if (!a || !b || !nodeObjs.has(link.from) || !nodeObjs.has(link.to)) continue;
          (link.kind === 'shell' ? dashed : solid).push(new THREE.Vector3(a.x, 0.35, a.z), new THREE.Vector3(b.x, 0.35, b.z));
        }
        const rebuild = (line, points, material, dashedLine) => {
          if (line) { sceneGraph.remove(line); line.geometry.dispose(); }
          if (!points.length) return null;
          const geometry = new THREE.BufferGeometry().setFromPoints(points);
          const next = new THREE.LineSegments(geometry, material);
          if (dashedLine) next.computeLineDistances();
          sceneGraph.add(next);
          return next;
        };
        linkSolid = rebuild(linkSolid, solid, delegationMat, false);
        linkDashed = rebuild(linkDashed, dashed, shellMat, true);
      }
    }
    disposer.add(() => { linkSolid?.geometry.dispose(); linkDashed?.geometry.dispose(); });

    // ---- camera ----
    const view = { az: 0, elev: ELEV.home, zoom: 1, cx: 0, cz: 0, fit: 80 };
    let userMoved = false, fitBounds = null, needsFit = true, refitDistance = false, tween = null;
    const v3 = new THREE.Vector3();
    function applyCamera(distance) {
      const e = rad(view.elev), a = rad(view.az);
      camera.position.set(view.cx + distance * Math.cos(e) * Math.sin(a), distance * Math.sin(e), view.cz + distance * Math.cos(e) * Math.cos(a));
      camera.lookAt(view.cx, 0, view.cz);
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
    }
    function worldBounds() {
      const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
      const grow = (x, z, rx, rz) => { b.minX = Math.min(b.minX, x - rx); b.maxX = Math.max(b.maxX, x + rx); b.minZ = Math.min(b.minZ, z - rz); b.maxZ = Math.max(b.maxZ, z + rz); };
      for (const [key, plat] of platforms) { const g = world.groups.get(key); grow(g.x, g.z, g.radius, g.radius * 0.82); }
      for (const [key] of nodeObjs) { const n = world.nodes.get(key); grow(n.x, n.z, 2.2, 2.2); }
      return isFinite(b.minX) ? b : { minX: -20, maxX: 20, minZ: -12, maxZ: 12 };
    }
    /** Smallest distance at which the world rectangle fits the view with the margins below, at the home angles. */
    function fitDistance(b) {
      const save = { az: view.az, elev: view.elev, cx: view.cx, cz: view.cz };
      view.az = 0; view.elev = ELEV.home; view.cx = (b.minX + b.maxX) / 2; view.cz = (b.minZ + b.maxZ) / 2;
      const pts = [];
      for (const x of [b.minX, b.maxX, view.cx]) for (const z of [b.minZ, b.maxZ, view.cz]) for (const y of [0, 1.8]) pts.push([x, y, z]);
      const fits = d => {
        applyCamera(d);
        for (const [x, y, z] of pts) {
          v3.set(x, y, z).project(camera);
          if (Math.abs(v3.x) > 0.86 || v3.y > 0.78 || v3.y < -0.84) return false;
        }
        return true;
      };
      let lo = 6, hi = 1200;
      if (fits(lo)) hi = lo;
      for (let i = 0; i < 28 && hi - lo > 0.05; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
      Object.assign(view, save);
      return hi;
    }
    function refit(animate) {
      if (!width || !height) { needsFit = true; return; }
      fitBounds = worldBounds();
      const target = { cx: (fitBounds.minX + fitBounds.maxX) / 2, cz: (fitBounds.minZ + fitBounds.maxZ) / 2, az: 0, elev: ELEV.home, zoom: 1 };
      view.fit = fitDistance(fitBounds);
      needsFit = false;
      if (animate && !motion?.rm) startTween(target); else Object.assign(view, target);
    }
    function updateFitDistance() { if (fitBounds && width && height) view.fit = fitDistance(fitBounds); }
    function startTween(to) { tween = { from: { cx: view.cx, cz: view.cz, az: view.az, elev: view.elev, zoom: view.zoom }, to, t0: performance.now(), dur: 320 }; }
    function stepTween(now) {
      if (!tween) return false;
      const k = clamp((now - tween.t0) / tween.dur, 0, 1), e = 1 - (1 - k) ** 3;
      for (const key of ['cx', 'cz', 'az', 'elev', 'zoom']) view[key] = tween.from[key] + (tween.to[key] - tween.from[key]) * e;
      if (k >= 1) { Object.assign(view, tween.to); tween = null; return false; }
      return true;
    }

    // ---- screen projection, labels ----
    const screen = new Map();
    function computeScreen() {
      applyCamera(view.fit / view.zoom);
      const right = v3.setFromMatrixColumn(camera.matrixWorld, 0).clone();
      const p = new THREE.Vector3(), q = new THREE.Vector3();
      screen.clear();
      for (const [key, obj] of nodeObjs) {
        const { size, tall } = obj.group.userData;
        p.set(obj.group.position.x, tall * 0.5, obj.group.position.z);
        q.copy(p).addScaledVector(right, size).project(camera);
        p.project(camera);
        const x = (p.x + 1) / 2 * width, y = (1 - p.y) / 2 * height;
        const r = Math.hypot((q.x - p.x) / 2 * width, (q.y - p.y) / 2 * height);
        screen.set(key, { x, y, r: Math.max(6, r), depth: p.z });
      }
    }
    function labelFor(key) {
      let rec = labels.get(key);
      if (rec) return rec;
      const el = h('div', { class: 'cs-label' });
      rec = { el, title: h('span', { class: 'cs-label-title trunc' }), stateEl: h('span', { class: 'label cs-label-state' }), time: h('span', { class: 'mono cs-label-time' }), icon: h('span', { class: 'cs-label-icon' }), glyphName: null, last: '' };
      el.append(rec.title, h('span', { class: 'cs-label-row' }, rec.icon, rec.stateEl, rec.time));
      labelLayer.append(el);
      labels.set(key, rec);
      return rec;
    }
    function fillLabel(rec, e) {
      const t = textFor(e), st = STATE[e.state] || STATE.idle;
      rec.el.dataset.c = st.color;
      rec.el.dataset.s = e.state;
      if (rec.glyphName !== st.glyph) { rec.glyphName = st.glyph; rec.icon.replaceChildren(glyph(st.glyph)); }
      txt(rec.title, t.title);
      txt(rec.stateEl, st.word);
      txt(rec.time, timerOf(e));
      if (discreet) rec.el.removeAttribute('title'); else rec.el.title = e.title;
      rec.text = `${t.title}|${st.word}`;
    }
    function groupLabelFor(key) {
      let rec = groupLabels.get(key);
      if (!rec) {
        rec = { el: h('div', { class: 'cs-group label' }), name: h('span', { class: 'cs-group-name trunc' }), counts: h('span', { class: 'cs-group-counts mono' }) };
        rec.el.append(rec.name, rec.counts);
        labelLayer.append(rec.el);
        groupLabels.set(key, rec);
      }
      return rec;
    }
    const badges = new Map();
    function placeAllLabels() {
      // Group (project) labels first: they are never covered by node labels.
      const blocks = [];
      const wanted = new Set();
      for (const [key, plat] of platforms) {
        wanted.add(key);
        const g = world.groups.get(key), meta = model.groups.find(x => x.key === key);
        const rec = groupLabelFor(key);
        const name = discreet ? alias('project', key, 'Project') : key;
        txt(rec.name, name);
        txt(rec.counts, meta ? `${meta.sessions}${meta.waiting ? ` · ${meta.waiting}!` : ''}` : '');
        v3.set(g.x, 0, g.z + g.radius * 0.82).project(camera);
        const w = Math.min(260, name.length * 9.6 + 56), x = (v3.x + 1) / 2 * width, y = (1 - v3.y) / 2 * height + 4;
        const rect = { x: clamp(x - w / 2, 4, Math.max(4, width - w - 4)), y: clamp(y, 4, Math.max(4, height - 22)), w, h: 18 };
        blocks.push(rect);
        const t = `translate(${rect.x.toFixed(1)}px,${rect.y.toFixed(1)}px)`;
        if (rec.last !== t) { rec.el.style.transform = t; rec.last = t; }
        rec.el.style.width = w + 'px';
      }
      for (const [key, rec] of groupLabels) if (!wanted.has(key)) { rec.el.remove(); groupLabels.delete(key); }

      const items = [];
      for (const key of model.visible) {
        const s = screen.get(key), e = model.byKey.get(key);
        if (!s) continue;
        const prio = key === selectedKey() ? 0 : e.tool && e.state === 'working' ? 2 : STATE[e.state]?.prio ?? 6;
        items.push({ key, x: s.x, y: s.y, r: s.r, w: estimateLabelWidth(textFor(e).title, e.state), prio,
          must: e.state === 'needs-you', selected: key === selectedKey(), label: e.kind !== 'sat' });
      }
      // Above MAX_LABELS only the highest priority nodes are even tried; the rest count as hidden.
      const ranked = items.filter(i => i.label).sort((x, y) => x.prio - y.prio);
      for (const item of ranked.slice(MAX_LABELS)) item.label = false;
      const result = placeLabels(items, { w: width, h: height }, blocks);
      const hiddenCount = result.hidden.length + Math.max(0, ranked.length - MAX_LABELS);
      const keepLabels = new Set(result.placed.keys());
      for (const [key, rec] of labels) if (!keepLabels.has(key)) { rec.el.hidden = true; }
      for (const [key, box] of result.placed) {
        const e = model.byKey.get(key);
        const rec = labelFor(key);
        if (rec.text === undefined || textDirty.has(key) || rec.discreet !== discreet) { fillLabel(rec, e); rec.discreet = discreet; textDirty.delete(key); }
        rec.el.hidden = false;
        const t = `translate(${box.x.toFixed(1)}px,${box.y.toFixed(1)}px)`;
        if (rec.last !== t) { rec.el.style.transform = t; rec.last = t; }
        rec.el.dataset.side = box.side;
        rec.el.style.width = box.w + 'px';
      }
      for (const key of [...labels.keys()]) if (!model.byKey.has(key) || !nodeObjs.has(key)) { labels.get(key).el.remove(); labels.delete(key); }
      // Count badges for folded groups sit on the node itself.
      const sats = new Set();
      for (const key of model.visible) {
        const e = model.byKey.get(key), s = screen.get(key);
        if (e.kind !== 'sat' || !s) continue;
        sats.add(key);
        let el = badges.get(key);
        if (!el) { el = h('div', { class: 'cs-badge mono' }); labelLayer.append(el); badges.set(key, el); }
        txt(el, `+${e.count}`);
        el.style.transform = `translate(${s.x.toFixed(1)}px,${s.y.toFixed(1)}px) translate(-50%,-50%)`;
      }
      for (const [key, el] of badges) if (!sats.has(key)) { el.remove(); badges.delete(key); }
      lastLayout = { placed: result.placed.size, hidden: hiddenCount, forced: result.forced.length };
      note.hidden = hiddenCount === 0;
      if (hiddenCount) txt(note, `${hiddenCount} ${hiddenCount === 1 ? 'label' : 'labels'} hidden`);
    }
    disposer.add(() => { for (const el of badges.values()) el.remove(); badges.clear(); });
    let lastLayout = { placed: 0, hidden: 0, forced: 0 };
    const textDirty = new Set();

    // ---- size, DPR ----
    function resize() {
      const rect = host.getBoundingClientRect();
      const w = Math.round(rect.width), hh = Math.round(rect.height);
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      if (w === width && hh === height && dpr === renderer.getPixelRatio()) return false;
      width = w; height = hh;
      renderer.setPixelRatio(dpr);
      if (w && hh) renderer.setSize(w, hh, false);
      canvas.style.width = w + 'px';
      canvas.style.height = hh + 'px';
      return true;
    }
    const observer = new ResizeObserver(() => { if (resize()) { if (userMoved) refitDistance = true; else needsFit = true; invalidate(); } });
    observer.observe(host);
    disposer.add(() => observer.disconnect());

    // ---- frame scheduling: one pending animation frame, none while hidden ----
    let rafId = 0, needSync = true, closedGfx = false, lastFrameAt = 0;
    const samples = { draw: [], interval: [] };
    disposer.add(() => { closedGfx = true; if (rafId) cancelAnimationFrame(rafId); rafId = 0; pending = 0; });
    function schedule() { if (!rafId && !closedGfx) { pending = 1; rafId = requestAnimationFrame(draw); } }
    function draw(time) {
      rafId = 0; pending = 0;
      if (closedGfx || closed || document.hidden || mine !== generation) return;
      const started = performance.now();
      resize();
      if (!width || !height) return;
      if (needSync) { syncObjects(); needSync = false; }
      if (needsFit && (!userMoved || fitBounds === null)) refit(fitBounds !== null);
      else if (refitDistance) updateFitDistance();
      refitDistance = false;
      const moving = stepTween(time);
      computeScreen();
      // New content outside the view refits, unless the operator moved the camera.
      if (!userMoved && !tween) {
        for (const s of screen.values()) if (s.x < 8 || s.x > width - 8 || s.y < 8 || s.y > height - 8) { refit(true); computeScreen(); break; }
      }
      positionSelection();
      renderer.render(sceneGraph, camera);
      frameCounter++; stats.frames++;
      placeAllLabels();
      refreshSelectionState();
      samples.draw.push(performance.now() - started);
      if (lastFrameAt) samples.interval.push(time - lastFrameAt);
      lastFrameAt = time;
      for (const list of Object.values(samples)) if (list.length > 240) list.shift();
      if (tween || moving) invalidate();
    }
    function positionSelection() {
      const key = selectedKey(), obj = key && nodeObjs.get(key);
      selection.visible = !!obj;
      if (obj) { selection.position.set(obj.group.position.x, 0.9, obj.group.position.z); selection.scale.setScalar(obj.group.userData.size * 1.55); }
      const fk = focusKey && document.activeElement === list ? nodeObjs.get(focusKey) : null;
      focusRing.visible = !!fk;
      if (fk) { focusRing.position.set(fk.group.position.x, 0.05, fk.group.position.z); focusRing.scale.setScalar(fk.group.userData.size); }
    }

    // ---- pointer: orbit with threshold, nearest-node pick within 44 px, wheel and pinch zoom ----
    const pointers = new Map();
    let drag = null, pinch = null, hover = null;
    const local = event => { const r = canvasHost.getBoundingClientRect(); return { x: event.clientX - r.left, y: event.clientY - r.top }; };
    function pick(x, y) {
      let best = null, bestD = Infinity;
      for (const [key, s] of screen) {
        const d = Math.hypot(s.x - x, s.y - y);
        // A 44 px circle at least; nearest wins, so two close circles are cut at their midpoint.
        if (d <= Math.max(HIT_RADIUS, s.r) && d < bestD) { best = key; bestD = d; }
      }
      return best;
    }
    listen(root, 'pointerdown', event => {
      if (mode !== '3d' || event.button > 0 || event.target.closest('button')) return;
      pointers.set(event.pointerId, { ...local(event), t: event.pointerType });
      try { root.setPointerCapture(event.pointerId); } catch { /* capture is optional */ }
      if (pointers.size === 1) drag = { id: event.pointerId, sx: event.clientX, sy: event.clientY, lx: event.clientX, ly: event.clientY, moved: false, touch: event.pointerType !== 'mouse' };
      else if (pointers.size === 2) { drag = null; const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: view.zoom }; }
    });
    listen(root, 'pointermove', event => {
      if (mode !== '3d') return;
      if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { ...local(event), t: event.pointerType });
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        setZoom(pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.d));
        return;
      }
      if (drag && drag.id === event.pointerId) {
        const dx = event.clientX - drag.lx, dy = event.clientY - drag.ly;
        if (!drag.moved && Math.hypot(event.clientX - drag.sx, event.clientY - drag.sy) >= (drag.touch ? DRAG_TOUCH_PX : DRAG_PX)) drag.moved = true;
        if (drag.moved) {
          tween = null; userMoved = true;
          view.az = clamp(view.az - dx * 0.35, -AZ_LIMIT, AZ_LIMIT);
          view.elev = clamp(view.elev + dy * 0.3, ELEV.min, ELEV.max);
          invalidate();
        }
        drag.lx = event.clientX; drag.ly = event.clientY;
      } else if (event.pointerType === 'mouse' && !event.buttons) {
        const l = local(event), key = pick(l.x, l.y);
        if (key !== hover) { hover = key; root.dataset.hover = key ? '1' : ''; for (const [k, rec] of labels) rec.el.classList.toggle('is-hover', k === key); }
      }
    });
    function endPointer(event, cancelled) {
      if (!pointers.has(event.pointerId)) return;
      const was = drag && drag.id === event.pointerId ? drag : null;
      pointers.delete(event.pointerId);
      try { root.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      if (pointers.size < 2) pinch = null;
      if (was) {
        drag = null;
        if (!was.moved && !cancelled) {
          const l = local(event), key = pick(l.x, l.y);
          if (key) { focusKey = key; activate(key); list.focus({ preventScroll: true }); }
        }
      }
    }
    listen(root, 'pointerup', event => endPointer(event, false));
    listen(root, 'pointercancel', event => endPointer(event, true));
    listen(root, 'lostpointercapture', event => endPointer(event, true));
    listen(root, 'wheel', event => {
      if (mode !== '3d') return;
      event.preventDefault();
      setZoom(view.zoom * Math.exp(-event.deltaY * 0.0015));
    }, { passive: false });
    function setZoom(zoom) { const next = clamp(zoom, ZOOM.min, ZOOM.max); if (next === view.zoom) return; tween = null; userMoved = true; view.zoom = next; invalidate(); }

    // ---- visibility: nothing is drawn while hidden, one frame on return ----
    listen(document, 'visibilitychange', () => {
      if (document.hidden) { if (rafId) cancelAnimationFrame(rafId); rafId = 0; pending = 0; return; }
      localAtSnapshot = Date.now();
      refresh(true);
      needSync = true;
      staleHidden = false;
      invalidate();
    });
    listen(window, 'pageshow', event => { if (event.persisted) { refresh(true); needSync = true; invalidate(); } });

    // ---- the facade used by the HTML side ----
    resize();
    return {
      schedule,
      dataChanged({ project: projectChanged }) {
        needSync = true;
        if (projectChanged) { userMoved = false; needsFit = true; }
        for (const e of model.entities) textDirty.add(e.key);
        invalidate();
      },
      selectionChanged() { invalidate(); },
      zoomBy(factor) { setZoom(view.zoom * factor); },
      reset() { userMoved = false; tween = null; needsFit = true; if (fitBounds) refit(true); invalidate(); },
      screenOf: key => screen.get(key) || null,
      stage: () => ({ width, height }),
      info: () => ({ frames: frameCounter, rendererFrames: renderer.info.render.frame, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
        geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, programs: renderer.info.programs?.length ?? 0,
        dpr: renderer.getPixelRatio(), objects: sceneGraph.children.length, canvases: canvasHost.querySelectorAll('canvas').length,
        label: lastLayout, view: { ...view }, glRenderer: glRendererName(), tween: !!tween, drawMs: summarize(samples.draw), intervalMs: summarize(samples.interval) }),
      beforeDispose() { record.before = counts(); },
      motionChanged() { if (motion?.rm) tween = null; },
    };
    function glRendererName() {
      try {
        const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      } catch { return null; }
    }
  }

  // ---- mount ----------------------------------------------------------------------------------------------------
  function close() {
    if (closed) return;
    closed = true;
    generation++;
    pending = 0;
    gfxApi.beforeDispose?.();
    const errors = [...gfx.run(), ...life.run()];
    lastGfx = { ...(lastGfx || {}), errors: errors.length };
    gfxApi = makeIdleGfx();
    rows.clear(); labels.clear(); groupLabels.clear(); headers.clear();
  }
  const detach = () => close();
  if (signal) {
    if (signal.aborted) { close(); return close; }
    signal.addEventListener('abort', detach, { once: true });
    life.add(() => signal.removeEventListener('abort', detach));
  }
  // Register cleanup before subscribing, then read the current state.
  const unsubscribers = [];
  life.add(() => { for (const off of unsubscribers.splice(0)) off(); });
  unsubscribers.push(store?.subscribe?.(onStoreEvent) || (() => {}));
  unsubscribers.push(actions.subscribeProject?.(() => refresh(true)) || (() => {}));
  unsubscribers.push(actions.subscribeDiscreet?.(() => refresh(true)) || (() => {}));
  unsubscribers.push(actions.subscribeSelection?.(next => setSelectionValue(next ?? actions.getSelection?.() ?? null)) || (() => {}));
  if (motion?.on) unsubscribers.push(motion.on(() => gfxApi.motionChanged?.()));
  updateConnection();
  refresh(true);
  if (actions.getSelection) setSelectionValue(actions.getSelection() || null);
  // Elapsed times are text only: once a second, never while hidden. No frame is drawn for them.
  const timer = setInterval(() => {
    if (document.hidden || !model) return;
    if (mode !== '3d') for (const [key, rec] of rows) txt(rec.time, timerOf(model.byKey.get(key)));
    else for (const [key, rec] of labels) if (!rec.el.hidden) txt(rec.time, timerOf(model.byKey.get(key)));
  }, 1000);
  life.add(() => clearInterval(timer));
  startGraphics();

  function api() {
    return {
      /** Set the selection outline (an optional alternative to `actions.getSelection`). */
      setSelection: next => { if (!closed) setSelectionValue(next); },
      reset: () => gfxApi.reset(),
      retry: () => { if (!closed && mode === 'fallback') { teardownGraphics(); startGraphics(); } },
      /** Re-read the project, discreet flag and store, for callers that cannot subscribe. */
      refresh: () => refresh(true),
      screenOf: key => gfxApi.screenOf(key),
      worldOf: key => { const n = world?.nodes.get(key); return n ? { x: n.x, z: n.z } : null; },
      keyOf: entityKey,
      stats: () => ({ ...stats, mode, closed, nodes: model?.entities.length ?? 0, rows: rows.size, pendingFrame: !!pending, hidden: document.hidden,
        lastError, gfx: gfxApi.info?.() || null, finalGfx: lastGfx, listeners: { disposer: gfx.size } }),
      getMode: () => mode,
      root,
    };
  }
  return Object.assign(close, api());
}

export default mountScene;

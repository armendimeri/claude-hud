// Scene harness (P2). Mounts the scene against the frozen P1 fixtures and exposes controls on `window.harness`.
// It exists so the scene can be proved in isolation; P7 wires the real store, actions and route.
import { mountScene } from '/src/web/cockpit/scene.mjs';
import { child, createFixtureStore, parent, sibling, snapshots, timeline, times } from '/tests/fixtures/cockpit/public.mjs';

const host = document.getElementById('host');
const projectListeners = new Set(), discreetListeners = new Set();
const state = { project: null, discreet: false, selections: [] };
const frame = (snapshot, status = 'live') => ({ snapshot, selection: parent, connection: { status, lastAt: snapshot.now } });
let store = createFixtureStore(frame(snapshots.sparse));
let motion = { rm: false, listeners: new Set(), on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); } };
let abort = null, handle = null;

const actions = {
  select(selection) { state.selections.push(selection); },
  getProject: () => state.project,
  subscribeProject(fn) { projectListeners.add(fn); return () => projectListeners.delete(fn); },
  getDiscreet: () => state.discreet,
  subscribeDiscreet(fn) { discreetListeners.add(fn); return () => discreetListeners.delete(fn); },
};

window.harness = {
  fixtures: { snapshots, timeline, times, parent, child, sibling },
  state,
  frame,
  get store() { return store; },
  get handle() { return handle; },
  /** Replace the store (a fresh page lifetime). */
  useSnapshot(snapshot, status = 'live') { store = createFixtureStore(frame(snapshot, status)); return store; },
  set(snapshot, status = 'live') { store.setFrame(frame(snapshot, status)); },
  mount(options = {}) {
    abort = new AbortController();
    handle = mountScene(host, { store, actions, motion, signal: abort.signal, ...options });
    return handle;
  },
  close() { handle?.(); handle = null; },
  abortOuter() { abort?.abort(); },
  setSize(w, h) { host.style.width = w + 'px'; host.style.height = h + 'px'; },
  setProject(name) { state.project = name; for (const fn of [...projectListeners]) fn(); },
  setDiscreet(on) { state.discreet = !!on; for (const fn of [...discreetListeners]) fn(); },
  setReducedMotion(on) { motion.rm = !!on; for (const fn of [...motion.listeners]) fn(); },
  listeners: () => ({ project: projectListeners.size, discreet: discreetListeners.size, motion: motion.listeners.size }),
  hostRect() { const r = host.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; },
  probe: () => ({ contexts: window.__probe.contexts.length, raf: { ...window.__probe.raf },
    lost: window.__probe.contexts.filter(c => c.gl.isContextLost()).length, canvases: document.querySelectorAll('canvas').length }),
  loseContext() { const c = window.__probe.contexts.filter(x => !x.gl.isContextLost()).pop(); c?.gl.getExtension('WEBGL_lose_context')?.loseContext(); return !!c; },
  ready: true,
};

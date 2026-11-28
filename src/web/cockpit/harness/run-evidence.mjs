// P2 evidence runner. Serves the repository on an OS-assigned loopback port, opens the isolated scene harness in a
// throwaway Edge profile and runs the scenarios below. It never touches the owner's HUD (port 7777), tasks or hooks.
//
//   node src/web/cockpit/harness/run-evidence.mjs [--only=name,name] [--native] [--out=<dir>]
//
// Default flags ask Edge for software WebGL (SwiftShader), so the run works on a machine without a GPU and says so in
// its report. `--native` leaves the GPU choice to Edge and reports whatever renderer it picked: use it on the owner's
// laptop for the native-GPU checks, and read `glRenderer` in the report.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const outDir = path.resolve(args.out || path.join(repo, 'docs/plans/operator-cockpit/handoffs/P2'));
const only = args.only ? String(args.only).split(',') : null;
const native = !!args.native;
mkdirSync(outDir, { recursive: true });

const edge = process.env.EDGE || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!edge) { console.error('Edge not found; set EDGE'); process.exit(2); }

// ---- static server (repository root, loopback, dotfiles and anything outside the root refused) -------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
const requests = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const rel = decodeURIComponent(url.pathname);
  const file = path.resolve(repo, '.' + rel);
  requests.push({ path: rel, at: Date.now() });
  const inside = path.relative(repo, file);
  if (inside.startsWith('..') || path.isAbsolute(inside) || inside.split(path.sep).some(p => p.startsWith('.')) || !existsSync(file)) { res.writeHead(404).end('not found'); requests[requests.length - 1].status = 404; return; }
  try {
    const body = readFileSync(file);
    requests[requests.length - 1].status = 200;
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- Edge over the DevTools protocol ----------------------------------------------------------------------------------
const profile = mkdtempSync(path.join(tmpdir(), 'p2-edge-'));
const flags = ['--headless=new', '--hide-scrollbars', '--no-first-run', '--disable-extensions', '--disable-sync', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--ignore-gpu-blocklist',
  ...(native ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']), 'about:blank'];
const proc = spawn(edge, flags, { stdio: 'ignore', windowsHide: true });
let port;
for (let i = 0; i < 150 && !port; i++) {
  try { port = Number(readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await pause(100); }
}
if (!port) { console.error('Edge debugging endpoint did not start'); process.exit(2); }
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 0; const waiting = new Map(); const consoleLines = []; let loadResolve = null;
ws.onmessage = event => {
  const m = JSON.parse(event.data);
  if (m.method === 'Page.loadEventFired' && loadResolve) loadResolve();
  if (m.method === 'Runtime.consoleAPICalled') consoleLines.push(`${m.params.type}: ${m.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`.slice(0, 300));
  if (m.method === 'Runtime.exceptionThrown') consoleLines.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300));
  const p = waiting.get(m.id);
  if (p) { waiting.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
};
const call = (method, params = {}) => new Promise((res, rej) => { const id = ++nextId; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
await call('Page.enable'); await call('Runtime.enable');

/** Evaluate a function in the page with JSON arguments and return its JSON result. */
async function ev(fn, ...fnArgs) {
  const expression = `(${fn.toString()})(...${JSON.stringify(fnArgs)})`;
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0]);
  return r.result.value;
}
async function open(width, height, query = '') {
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const loaded = new Promise(r => { loadResolve = r; });
  await call('Page.navigate', { url: `${base}/src/web/cockpit/harness/index.html${query}` });
  await Promise.race([loaded, pause(15000)]);
  for (let i = 0; i < 100; i++) { if (await ev(() => !!window.harness?.ready)) return; await pause(100); }
  throw new Error('harness did not load');
}
const shot = async name => { writeFileSync(path.join(outDir, name), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64')); return name; };
const mouse = (type, x, y, extra = {}) => call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
const click = async (x, y) => { await mouse('mouseMoved', x, y, { buttons: 0 }); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); };
const key = async (k, code, vk) => { await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk }); await call('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); };
const waitFor = async (fn, ms = 10000, ...a) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(fn, ...a)) return true; await pause(50); } return false; };
const stats = () => ev(() => window.harness.handle?.stats() ?? null);
const mountAndWait = async (options = null) => {
  await ev(o => { window.harness.mount(o ? Object.assign({}, o) : {}); }, options);
  return waitFor(() => window.harness.handle?.stats().mode === '3d', 15000);
};

// ---- checks ------------------------------------------------------------------------------------------------------
const checks = [];
let scenario = '';
const check = (name, pass, detail = '') => { checks.push({ scenario, name, pass: !!pass, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) }); console.log(`${pass ? 'PASS' : 'FAIL'}  [${scenario}] ${name}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); };
const evidence = {};
const LEAKS = ['Ledger', 'Reports', 'Imports', 'Invoices', 'Export', 'Check totals', 'export.mjs', 'Review export', 'Synthetic', 'Which date', 'claude:', 'codex:', 'toolu_'];

const scenarios = {
  async cold() {
    await open(1440, 900);
    const before = requests.filter(r => /\/vendor\/three\//.test(r.path)).length;
    check('no Three.js request before the scene mounts', before === 0, `${before} requests`);
    const ok = await mountAndWait();
    check('scene reaches 3d mode', ok);
    const s = await stats();
    const modules = requests.filter(r => /\/vendor\/three\//.test(r.path));
    check('Three.js modules were requested on mount and served', modules.length >= 2 && modules.every(r => r.status === 200), modules.map(r => `${path.basename(r.path)}:${r.status}`));
    check('exactly one canvas and one WebGL context', s.gfx.canvases === 1 && (await ev(() => window.harness.probe().contexts)) === 1);
    check('a frame was drawn', s.frames >= 1 && s.gfx.rendererFrames >= 1, { frames: s.frames, rendererFrames: s.gfx.rendererFrames, calls: s.gfx.calls });
    check('no waiting label was forced into a conflict', s.gfx.label.forced === 0, s.gfx.label);
    evidence.renderer = s.gfx.glRenderer;
    evidence.dpr = s.gfx.dpr;
    check('DPR capped at 1.5', s.gfx.dpr <= 1.5, s.gfx.dpr);
    await pause(400);
    await shot('sparse-1440.png');
    await ev(() => window.harness.close());
  },

  async idle() {
    await open(1440, 900);
    await mountAndWait();
    await pause(1500);
    const a = await ev(() => ({ s: window.harness.handle.stats(), p: window.harness.probe() }));
    await pause(5000);
    const b = await ev(() => ({ s: window.harness.handle.stats(), p: window.harness.probe() }));
    check('no frame drawn over 5 s of quiet (scene counter)', b.s.frames === a.s.frames, `${a.s.frames} -> ${b.s.frames}`);
    check('no frame drawn over 5 s of quiet (renderer.info.render.frame)', b.s.gfx.rendererFrames === a.s.gfx.rendererFrames, `${a.s.gfx.rendererFrames} -> ${b.s.gfx.rendererFrames}`);
    check('no animation frame requested over 5 s of quiet (page counter)', b.p.raf.requested === a.p.raf.requested, `${a.p.raf.requested} -> ${b.p.raf.requested}`);
    evidence.quiet = { seconds: 5, sceneFrames: b.s.frames - a.s.frames, rendererFrames: b.s.gfx.rendererFrames - a.s.gfx.rendererFrames, rafRequests: b.p.raf.requested - a.p.raf.requested };

    // A snapshot that differs only in its clock schedules nothing.
    await ev(() => { const { snapshots } = window.harness.fixtures; window.harness.set({ ...snapshots.sparse, now: snapshots.sparse.now + 5000, uptime: snapshots.sparse.uptime + 5000 }); });
    await pause(600);
    const c = await stats();
    check('a clock-only snapshot draws no frame', c.frames === b.s.frames, `${b.s.frames} -> ${c.frames}`);
    check('a clock-only snapshot is counted as a quiet event', c.quietEvents === b.s.quietEvents + 1, `${b.s.quietEvents} -> ${c.quietEvents}`);

    // A real change after the scene went idle draws.
    await ev(() => { const { snapshots } = window.harness.fixtures; const first = snapshots.sparse.sessions[0];
      window.harness.set({ ...snapshots.sparse, now: snapshots.sparse.now + 6000, sessions: [{ ...first, status: 'idle', needsYou: null }, ...snapshots.sparse.sessions.slice(1)] }); });
    await pause(700);
    const d = await stats();
    check('an event after idle draws a frame', d.frames > c.frames && d.frames - c.frames <= 3, `${c.frames} -> ${d.frames}`);
    await pause(1500);
    const e = await stats();
    check('and the scene goes idle again', e.frames === d.frames, `${d.frames} -> ${e.frames}`);
    evidence.wake = { framesForOneEvent: d.frames - c.frames };

    // Hidden tab: nothing is requested, one frame on return.
    await ev(() => { window.__hide = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hide }); document.dispatchEvent(new Event('visibilitychange')); });
    const h0 = await ev(() => ({ s: window.harness.handle.stats(), p: window.harness.probe() }));
    await ev(() => { const { snapshots } = window.harness.fixtures; window.harness.set({ ...snapshots.sparse, now: snapshots.sparse.now + 7000 }); });
    await pause(600);
    const h1 = await ev(() => ({ s: window.harness.handle.stats(), p: window.harness.probe() }));
    check('a change while hidden requests no animation frame', h1.p.raf.requested === h0.p.raf.requested && h1.s.frames === h0.s.frames, `rAF ${h0.p.raf.requested} -> ${h1.p.raf.requested}`);
    check('the hidden change is recorded, not drawn', h1.s.hiddenSkips > h0.s.hiddenSkips, `hiddenSkips ${h0.s.hiddenSkips} -> ${h1.s.hiddenSkips}`);
    await ev(() => { window.__hide = false; document.dispatchEvent(new Event('visibilitychange')); });
    await pause(700);
    const h2 = await stats();
    check('returning to visible draws exactly one revalidating frame', h2.frames - h1.s.frames === 1, `${h1.s.frames} -> ${h2.frames}`);
    await ev(() => window.harness.close());
  },

  async anchoring() {
    await open(1440, 900);
    await mountAndWait();
    await pause(500);
    const sample = () => ev(() => { const h = window.harness, s = h.handle.stats(); const { width, height } = h.hostRect();
      const out = {}; for (const e of h.handle.root.querySelectorAll('[role=option]')) { /* keys are opaque, use fixtures */ }
      const { parent, sibling } = h.fixtures; const keys = { Ledger: h.handle.keyOf(parent.sessionId), Reports: h.handle.keyOf(sibling.sessionId) };
      for (const [name, key] of Object.entries(keys)) { const p = h.handle.screenOf(key); out[name] = p && { u: p.x / width, v: p.y / height, x: p.x, y: p.y }; }
      return { width, height, out, fit: s.gfx.view.fit }; });
    const wide = await sample();
    await ev(() => window.harness.setSize(976, 696));
    await pause(700);
    const narrow = await sample();
    await shot('sparse-1440-inspector-width.png');
    const du = Object.fromEntries(Object.keys(wide.out).map(k => [k, +Math.abs(wide.out[k].u - narrow.out[k].u).toFixed(4)]));
    check('node fractions stay put when the scene rectangle goes from 1392 to 976 wide', Object.values(du).every(v => v < 0.02), { wide, narrow, du });
    evidence.anchoring = { before: { width: wide.width, ...Object.fromEntries(Object.entries(wide.out).map(([k, v]) => [k, +v.u.toFixed(4)])) }, after: { width: narrow.width, ...Object.fromEntries(Object.entries(narrow.out).map(([k, v]) => [k, +v.u.toFixed(4)])) }, deltaU: du };
    await ev(() => window.harness.close());
  },

  async insertion() {
    // Pure layout: before and after an unrelated insertion (dense fixture).
    const { createLayout } = await import(pathToFileURL(path.join(repo, 'src/web/cockpit/layout.mjs')).href);
    const { projectSnapshot } = await import(pathToFileURL(path.join(repo, 'src/web/cockpit/projection.mjs')).href);
    const { snapshots } = await import(pathToFileURL(path.join(repo, 'tests/fixtures/cockpit/public.mjs')).href);
    const model = projectSnapshot(snapshots.dense, { expanded: new Set(['project:Ledger']) });
    const input = m => ({ groups: m.groups.map(({ key }) => ({ key })), entities: m.entities });
    const layout = createLayout();
    const before = layout.update(input(model));
    const extra = input(model);
    extra.groups.push({ key: 'Aardvark' });
    extra.entities.push({ key: 'new-session-1', groupKey: 'Aardvark', parentKey: null, sortKey: 1, kind: 'session' }, { key: 'new-agent-1', groupKey: 'Aardvark', parentKey: 'new-session-1', sortKey: 2, kind: 'sub' }, { key: 'new-session-2', groupKey: 'Ledger', parentKey: null, sortKey: -1, kind: 'session' });
    const after = layout.update(extra);
    const rows = [...before.nodes].map(([key, n]) => { const m = after.nodes.get(key); const e = model.byKey.get(key); return { entity: e.kind === 'sat' ? e.groupKey + ' +' + e.count : e.project + ' / ' + e.title, before: [+n.x.toFixed(3), +n.z.toFixed(3)], after: [+m.x.toFixed(3), +m.z.toFixed(3)], same: n.x === m.x && n.z === m.z }; });
    check('layout: every surviving node keeps its exact world position after an unrelated insertion', rows.every(r => r.same), { nodes: rows.length, moved: rows.filter(r => !r.same).length });
    evidence.insertion = { inserted: ['Aardvark/new-session-1 (+1 subagent, new project)', 'Ledger/new-session-2 (new member of an existing project)'], rows };
    writeFileSync(path.join(outDir, 'layout-insertion.json'), JSON.stringify(evidence.insertion, null, 2) + '\n');

    // In the page: the same insertion on screen, with the camera untouched by the operator and after an orbit.
    await open(1440, 900);
    await ev(() => window.harness.useSnapshot(window.harness.fixtures.snapshots.dense));
    await mountAndWait();
    await pause(500);
    const grab = () => ev(() => { const { snapshots } = window.harness.fixtures, h = window.harness; const keys = snapshots.dense.sessions.map(s => h.handle.keyOf(s.id)); const out = {};
      keys.forEach((k, i) => { const w = h.handle.worldOf(k), sc = h.handle.screenOf(k); if (w && sc) out[i] = { w: [w.x, w.z], s: [Math.round(sc.x * 10) / 10, Math.round(sc.y * 10) / 10] }; }); return out; });
    const withNew = () => ev(() => { const { snapshots } = window.harness.fixtures; const base = snapshots.dense.sessions[3];
      window.harness.set({ ...snapshots.dense, now: snapshots.dense.now + 1000, sessions: [...snapshots.dense.sessions, { ...base, id: 'aardvark-1', project: 'Aardvark', title: 'Inserted work', status: 'busy', subagents: [], agentsRunning: 0 }] }); });
    const a = await grab(); await withNew(); await pause(900); const b = await grab();
    const worldSame = Object.keys(a).every(k => JSON.stringify(a[k].w) === JSON.stringify(b[k]?.w));
    const screenMoved = Object.keys(a).filter(k => JSON.stringify(a[k].s) !== JSON.stringify(b[k]?.s)).length;
    check('browser: world positions are identical after the insertion', worldSame, { nodes: Object.keys(a).length });
    evidence.insertionScreen = { cameraUntouched: { nodes: Object.keys(a).length, screenMoved, note: 'the camera refits when new content would fall outside the view, so screen positions may shift while world positions do not' } };
    await ev(() => window.harness.close());
    await ev(() => window.harness.useSnapshot(window.harness.fixtures.snapshots.dense));
    await mountAndWait(); await pause(400);
    const { x: hx, y: hy } = await ev(() => window.harness.hostRect());
    await mouse('mouseMoved', hx + 12, hy + 12, { buttons: 0 }); await mouse('mousePressed', hx + 12, hy + 12);
    for (let i = 1; i <= 8; i++) await mouse('mouseMoved', hx + 12 + i * 8, hy + 12 + i * 3);
    await mouse('mouseReleased', hx + 76, hy + 36); await pause(300);
    const c = await grab(); await withNew(); await pause(900); const d = await grab();
    const moved2 = Object.keys(c).filter(k => JSON.stringify(c[k].s) !== JSON.stringify(d[k]?.s)).length;
    check('browser: after the operator moved the camera an insertion changes no node on screen', moved2 === 0, { nodes: Object.keys(c).length, moved: moved2 });
    evidence.insertionScreen.afterOrbit = { nodes: Object.keys(c).length, screenMoved: moved2 };
    await ev(() => window.harness.close());
  },

  async interaction() {
    await open(1440, 900);
    await ev(() => window.harness.useSnapshot(window.harness.fixtures.snapshots.dense));
    await mountAndWait();
    await pause(600);
    const { x: hx, y: hy } = await ev(() => window.harness.hostRect());
    const pos = key => ev(k => window.harness.handle.screenOf(k), key);
    const keyOf = (id, agent = null) => ev((i, a) => window.harness.handle.keyOf(i, a), id, agent);
    const waitingKey = await keyOf('claude:export/α');
    const wp = await pos(waitingKey);
    await click(hx + wp.x, hy + wp.y);
    await pause(150);
    let state = await ev(() => ({ sel: window.harness.state.selections.slice(), stats: window.harness.handle.stats() }));
    check('a click on a node selects it through the shared callback', state.sel.length === 1 && state.sel[0].sessionId === 'claude:export/α' && state.sel[0].agentId === null, state.sel);
    check('the callback is the only channel: a click sends no action', await ev(() => !('submit' in window.harness.state) && Object.keys(window.harness.state).join() === 'project,discreet,selections'));
    check('the selection is mirrored in the accessible list', await ev(() => !!window.harness.handle.root.querySelector('[role=option][aria-selected=true]')));
    await pause(300);
    await shot('dense-1440-selected.png');

    // A drag past the threshold orbits and never selects.
    const before = await ev(() => ({ ...window.harness.handle.stats().gfx.view, sel: window.harness.state.selections.length }));
    const sx = hx + 12, sy = hy + 12;
    await mouse('mouseMoved', sx, sy, { buttons: 0 }); await mouse('mousePressed', sx, sy);
    for (let i = 1; i <= 12; i++) await mouse('mouseMoved', sx + i * 10, sy + i * 4);
    await mouse('mouseReleased', sx + 120, sy + 48);
    await pause(200);
    const after = await ev(() => ({ ...window.harness.handle.stats().gfx.view, sel: window.harness.state.selections.length }));
    check('a drag orbits the camera', Math.abs(after.az - before.az) > 5 && after.elev !== before.elev, { before: [before.az, before.elev], after: [after.az, after.elev] });
    check('a drag selects nothing', after.sel === before.sel);
    // A small movement is a click, not a drag.
    const tiny = await pos(waitingKey);
    await mouse('mouseMoved', hx + tiny.x, hy + tiny.y, { buttons: 0 }); await mouse('mousePressed', hx + tiny.x, hy + tiny.y);
    await mouse('mouseMoved', hx + tiny.x + 2, hy + tiny.y + 1); await mouse('mouseReleased', hx + tiny.x + 2, hy + tiny.y + 1);
    await pause(150);
    check('a 2 px wobble is still a click', await ev(() => window.harness.state.selections.length) === before.sel + 1);

    // Limits.
    for (let i = 0; i < 40; i++) await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: hx + 600, y: hy + 300, deltaX: 0, deltaY: -400 });
    await pause(200);
    const zin = (await ev(() => window.harness.handle.stats().gfx.view));
    for (let i = 0; i < 80; i++) await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: hx + 600, y: hy + 300, deltaX: 0, deltaY: 400 });
    await pause(200);
    const zout = (await ev(() => window.harness.handle.stats().gfx.view));
    check('zoom is limited at both ends', zin.zoom <= 3.2 + 1e-9 && zout.zoom >= 0.55 - 1e-9 && zin.zoom > 3 && zout.zoom < 0.6, { max: zin.zoom, min: zout.zoom });
    await mouse('mouseMoved', sx, sy, { buttons: 0 }); await mouse('mousePressed', sx, sy);
    for (let i = 1; i <= 30; i++) await mouse('mouseMoved', sx + i * 10, sy - i * 40);
    await mouse('mouseReleased', sx + 300, sy - 1200);
    await pause(200);
    const tilt = await ev(() => window.harness.handle.stats().gfx.view);
    check('tilt and azimuth are limited', tilt.elev >= 20 && tilt.elev <= 80 && Math.abs(tilt.az) <= 80, { elev: tilt.elev, az: tilt.az });
    // Reset.
    await ev(() => window.harness.handle.root.querySelector('.cs-reset').click());
    await pause(900);
    const reset = await ev(() => window.harness.handle.stats().gfx.view);
    check('Reset view restores the home camera', reset.zoom === 1 && reset.az === 0 && Math.abs(reset.elev - 52) < 1e-6, { zoom: reset.zoom, az: reset.az, elev: reset.elev });

    // Nearest node wins between two close circles.
    const near = await ev(() => { const h = window.harness, ids = h.handle.root.querySelectorAll('[role=option]').length; const keys = [];
      for (const e of h.fixtures.snapshots.dense.sessions) keys.push(h.handle.keyOf(e.id));
      for (const e of h.fixtures.snapshots.dense.sessions) for (const a of e.subagents || []) keys.push(h.handle.keyOf(e.id, a.id));
      let best = null; for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) { const a = h.handle.screenOf(keys[i]), b = h.handle.screenOf(keys[j]); if (!a || !b) continue; const d = Math.hypot(a.x - b.x, a.y - b.y); if (!best || d < best.d) best = { d, a: keys[i], b: keys[j], pa: a, pb: b }; }
      return best; });
    evidence.closestPair = { distancePx: +near.d.toFixed(1) };
    if (near.d < 44) {
      const at = f => ({ x: hx + near.pa.x + (near.pb.x - near.pa.x) * f, y: hy + near.pa.y + (near.pb.y - near.pa.y) * f });
      const pickKey = async f => { const p = at(f); const n = (await ev(() => window.harness.state.selections.length)); await click(p.x, p.y); await pause(120); return ev(m => { const s = window.harness.state.selections; return s.length > m ? s[s.length - 1] : null; }, n); };
      const nearA = await pickKey(0.3), nearB = await pickKey(0.7);
      check('between two circles closer than 44 px the nearer node wins', !!nearA && !!nearB && JSON.stringify(nearA) !== JSON.stringify(nearB), { distance: near.d.toFixed(1) });
    } else {
      check('closest node pair in the dense scene is at least 44 px apart (clipping not exercised)', true, `${near.d.toFixed(1)} px`);
    }

    // Keyboard through the list.
    await ev(() => { window.harness.state.selections.length = 0; window.harness.handle.root.querySelector('.cs-list').focus(); });
    await key('ArrowRight', 'ArrowRight', 39); await key('ArrowRight', 'ArrowRight', 39); await key('Enter', 'Enter', 13);
    await pause(150);
    const kb = await ev(() => ({ sel: window.harness.state.selections.slice(), order: [...window.harness.handle.root.querySelectorAll('[role=option]')].map(e => e.getAttribute('aria-label')), active: document.querySelector('.cs-list').getAttribute('aria-activedescendant') }));
    check('arrow keys and Enter select through the same callback', kb.sel.length === 1, kb.sel);
    check('the list exposes aria-activedescendant', !!kb.active);
    await key('End', 'End', 35); await key('Enter', 'Enter', 13); await pause(120);
    const last = await ev(() => window.harness.state.selections.slice(-1)[0]);
    await key('Home', 'Home', 36); await key('Enter', 'Enter', 13); await pause(120);
    const first = await ev(() => window.harness.state.selections.slice(-1)[0]);
    check('Home and End jump to the first and last node', JSON.stringify(first) !== JSON.stringify(last), { first, last });
    await ev(() => window.harness.close());
  },

  async lifecycle() {
    await open(1440, 900);
    await ev(() => window.harness.useSnapshot(window.harness.fixtures.snapshots.dense));
    const cycles = [];
    const heap = async () => { await call('HeapProfiler.collectGarbage'); return (await call('Runtime.getHeapUsage')).usedSize; };
    for (let i = 0; i < 12; i++) {
      await ev(() => window.harness.mount());
      await waitFor(() => window.harness.handle?.stats().mode === '3d', 15000);
      await pause(150);
      const live = await stats();
      await ev(() => window.harness.close());
      const done = await ev(() => { const probe = window.harness.probe(); return { probe, listeners: window.harness.listeners(), sceneNodes: document.querySelectorAll('.cockpit-scene').length, labels: document.querySelectorAll('.cs-label, .cs-group, .cs-badge').length }; });
      cycles.push({ before: live.gfx && { geometries: live.gfx.geometries, textures: live.gfx.textures, programs: live.gfx.programs, objects: live.gfx.objects }, done });
    }
    const final = await ev(() => { const closed = window.harness.handle; return { probe: window.harness.probe() }; });
    // Per-cycle disposal numbers come from the handle's closing record.
    const records = [];
    for (let i = 0; i < 3; i++) {
      await ev(() => window.harness.mount());
      await waitFor(() => window.harness.handle?.stats().mode === '3d', 15000);
      await pause(120);
      const h = await ev(() => { const handle = window.harness.handle; handle(); return handle.stats().finalGfx; });
      records.push(h);
    }
    await pause(300);
    const probe = await ev(() => window.harness.probe());
    check('every WebGL context created was released (context lost) after 15 mount/close cycles', probe.contexts === probe.lost && probe.contexts >= 15, probe);
    check('no canvas, scene root, label or listener is left in the page', probe.canvases === 0 && cycles.every(c => c.done.sceneNodes === 0 && c.done.labels === 0 && Object.values(c.done.listeners).every(n => n === 0)), cycles[cycles.length - 1].done);
    check('every animation frame the scenes requested has fired or was never left pending after close', probe.raf.requested === probe.raf.fired, probe.raf);
    check('renderer.info.memory returns to zero geometries, textures and programs once owned resources are disposed', records.every(r => r.afterResources && r.afterResources.geometries === 0 && r.afterResources.textures === 0 && r.afterResources.programs === 0), records);
    check('the context is lost after the renderer is disposed', records.every(r => r.afterRenderer?.contextLost === true), records.map(r => r.afterRenderer));
    check('disposal raised no error', records.every(r => r.errors === 0));
    const geo = cycles.map(c => c.before.geometries), obj = cycles.map(c => c.before.objects);
    check('live GPU object counts are identical on every cycle (no growth after warm-up)', new Set(geo).size === 1 && new Set(obj).size === 1 && cycles.every(c => c.before.textures === 0), { geometries: geo[0], objects: obj[0], textures: cycles[0].before.textures, programs: cycles.map(c => c.before.programs) });
    // JS heap after warm-up: 3 warm-up cycles, then 10 more.
    await ev(() => window.harness.mount()); await waitFor(() => window.harness.handle?.stats().mode === '3d', 15000); await ev(() => window.harness.close());
    const h0 = await heap();
    for (let i = 0; i < 10; i++) { await ev(() => window.harness.mount()); await waitFor(() => window.harness.handle?.stats().mode === '3d', 15000); await pause(100); await ev(() => window.harness.close()); }
    const h1 = await heap();
    check('JS heap after ten more cycles stays within 4 MB of the warm baseline', h1 - h0 < 4 * 1024 * 1024, `${((h1 - h0) / 1024).toFixed(0)} KiB growth (${(h0 / 1048576).toFixed(1)} -> ${(h1 / 1048576).toFixed(1)} MiB)`);
    evidence.lifecycle = { cycles: 25, contexts: probe.contexts, lost: probe.lost, disposal: records[0], liveObjects: { geometries: geo[0], objects: obj[0] }, heapKiB: Math.round((h1 - h0) / 1024) };
  },

  async races() {
    await open(1440, 900);
    const probe = () => ev(() => window.harness.probe());
    // Leave before the import resolves.
    await ev(() => { const h = window.harness; h.gate = []; const loader = () => new Promise((resolve, reject) => h.gate.push({ resolve, reject })).then(() => import('/src/web/vendor/three/three.module.min.js')); h.mount({ loadThree: loader }); });
    const closeFirst = await ev(() => { window.harness.close(); window.harness.gate[0].resolve(); return true; });
    await pause(600);
    let p = await probe();
    check('closing before the import resolves creates no renderer and no canvas', closeFirst && p.contexts === 0 && p.canvases === 0, p);
    // Enter, leave, enter before either import resolves: only the last mounts.
    await ev(() => { const h = window.harness; h.gate = []; const loader = () => new Promise(resolve => h.gate.push({ resolve })).then(() => import('/src/web/vendor/three/three.module.min.js'));
      h.mount({ loadThree: loader }); h.close(); h.mount({ loadThree: loader }); h.gate[1].resolve(); h.gate[0].resolve(); });
    await waitFor(() => window.harness.handle?.stats().mode === '3d', 15000);
    await pause(300);
    p = await probe();
    check('enter, leave, enter before the import resolves mounts only the last scene', p.contexts === 1 && p.canvases === 1 && (await stats()).gfx.canvases === 1, p);
    await ev(() => window.harness.close());
    // The outer lifetime aborting closes synchronously, and closing twice is safe.
    await ev(() => { window.harness.mount(); window.harness.abortOuter(); });
    const twice = await ev(() => { const h = window.harness.handle; const r = []; try { h(); h(); r.push('ok'); } catch (e) { r.push(String(e)); } return { r, closed: h.stats().closed, scenes: document.querySelectorAll('.cockpit-scene').length }; });
    check('an aborted outer signal closes the scene and close() is safe twice', twice.closed && twice.scenes === 0 && twice.r[0] === 'ok', twice);
    await pause(400);
    p = await probe();
    check('no context or canvas survives an abort during loading', p.canvases === 0 && p.contexts === p.lost, p);
  },

  async fallback() {
    await open(1440, 900);
    await ev(() => window.harness.useSnapshot(window.harness.fixtures.snapshots.sparse));
    // Module failure.
    await ev(() => { const h = window.harness; h.flaky = { fail: true }; h.mount({ loadThree: () => h.flaky.fail ? Promise.reject(new Error('module missing')) : import('/src/web/vendor/three/three.module.min.js') }); });
    check('a rejected module import shows the fallback list', await waitFor(() => window.harness.handle?.stats().mode === 'fallback', 5000));
    let s = await ev(() => { const r = window.harness.handle.root; const list = r.querySelector('.cs-list'); const b = list.getBoundingClientRect(); return { rows: r.querySelectorAll('[role=option]').length, listH: b.height, status: r.querySelector('.cs-status-text').textContent, retry: !r.querySelector('.cs-btn:not(.cs-reset)').hidden, canvases: document.querySelectorAll('canvas').length }; });
    check('the list is visible with a banner and an explicit Retry', s.rows === 4 && s.listH > 100 && /unavailable/.test(s.status) && s.retry && s.canvases === 0, s);
    await shot('fallback-1440.png');
    const { x: hx, y: hy } = await ev(() => window.harness.hostRect());
    const rowAt = await ev(() => { const r = [...window.harness.handle.root.querySelectorAll('[role=option]')].find(e => /Needs you/i.test(e.textContent)).getBoundingClientRect(); return { x: r.left + 120, y: r.top + 20 }; });
    await click(rowAt.x, rowAt.y);
    await pause(120);
    check('selecting a list row calls the same selection callback', (await ev(() => window.harness.state.selections.slice(-1)[0]))?.sessionId === 'claude:export/α');
    // Fix the module and press Retry: one canvas, selection kept.
    await ev(() => { window.harness.flaky.fail = false; window.harness.handle.root.querySelector('.cs-btn:not(.cs-reset)').click(); });
    const fixed = await waitFor(() => window.harness.handle?.stats().mode === '3d', 15000);
    await pause(300);
    const retried = await ev(() => ({ canvases: document.querySelectorAll('canvas').length, selected: !!window.harness.handle.root.querySelector('[role=option][aria-selected=true]'), contexts: window.harness.probe().contexts }));
    check('Retry after the module recovers mounts one canvas and keeps the selection', fixed && retried.canvases === 1 && retried.selected && retried.contexts === 1, retried);
    await ev(() => window.harness.close());
    // Renderer creation fails.
    await ev(() => { window.harness.mount({ loadThree: async () => { const T = await import('/src/web/vendor/three/three.module.min.js'); return { ...T, WebGLRenderer: class { constructor() { throw new Error('WebGL unavailable'); } } }; } }); });
    check('a renderer that cannot be created falls back and leaves no canvas', await waitFor(() => window.harness.handle?.stats().mode === 'fallback', 5000) && (await ev(() => document.querySelectorAll('canvas').length)) === 0);
    await ev(() => window.harness.close());
    // A renderer that gets a context and then throws is cleaned up.
    const before = await ev(() => window.harness.probe());
    await ev(() => { window.harness.mount({ loadThree: async () => { const T = await import('/src/web/vendor/three/three.module.min.js'); return { ...T, WebGLRenderer: class { constructor({ canvas }) { canvas.getContext('webgl2'); throw new Error('half built'); } } }; } }); });
    await waitFor(() => window.harness.handle?.stats().mode === 'fallback', 5000);
    await pause(200);
    const half = await ev(() => window.harness.probe());
    check('a partly constructed renderer releases its context and canvas', half.contexts === before.contexts + 1 && half.lost === before.lost + 1 && half.canvases === 0, { before, half });
    await ev(() => window.harness.close());

    // Context loss, selection kept, explicit retry with one canvas.
    await ev(() => window.harness.mount());
    await waitFor(() => window.harness.handle?.stats().mode === '3d', 15000);
    const wk = await ev(() => window.harness.handle.keyOf('claude:export/α'));
    const wp = await ev(k => window.harness.handle.screenOf(k), wk);
    await click(hx + wp.x, hy + wp.y);
    await pause(200);
    const lostCtx = await ev(() => window.harness.loseContext());
    check('the context loss was injected', lostCtx);
    await waitFor(() => window.harness.handle?.stats().mode === 'fallback', 5000);
    s = await ev(() => { const r = window.harness.handle.root; return { mode: window.harness.handle.stats().mode, selected: !!r.querySelector('[role=option][aria-selected=true]'), canvases: document.querySelectorAll('canvas').length, status: r.querySelector('.cs-status-text').textContent, contextLoss: window.harness.handle.stats().contextLoss }; });
    check('context loss shows the fallback, keeps the HTML selection and removes the canvas', s.mode === 'fallback' && s.selected && s.canvases === 0 && /context/.test(s.status) && s.contextLoss === 1, s);
    await ev(() => window.harness.handle.root.querySelector('.cs-btn:not(.cs-reset)').click());
    const back = await waitFor(() => window.harness.handle?.stats().mode === '3d', 15000);
    await pause(300);
    const afterRetry = await ev(() => ({ canvases: document.querySelectorAll('canvas').length, probe: window.harness.probe(), selected: !!window.harness.handle.root.querySelector('[role=option][aria-selected=true]'), frames: window.harness.handle.stats().frames }));
    check('Retry draws again with exactly one canvas and the selection intact', back && afterRetry.canvases === 1 && afterRetry.selected && afterRetry.frames >= 1 && afterRetry.probe.contexts - afterRetry.probe.lost === 1, afterRetry);
    await shot('after-retry-1440.png');
    await ev(() => window.harness.close());
  },

  async discreet() {
    await open(1440, 900);
    await ev(() => window.harness.useSnapshot(window.harness.fixtures.snapshots.dense));
    await mountAndWait();
    await pause(400);
    const probe = () => ev(leaks => { const r = window.harness.handle.root; const html = r.outerHTML + ' ' + document.title; return leaks.filter(l => html.includes(l)); }, LEAKS);
    const named = await probe();
    check('control: the normal display does contain project and session names', named.length > 3, named);
    await ev(() => window.harness.setDiscreet(true));
    await pause(600);
    const hidden = await probe();
    const aliasRows = await ev(() => [...window.harness.handle.root.querySelectorAll('[role=option]')].slice(0, 3).map(e => e.getAttribute('aria-label')));
    check('discreet display removes names, tools and identifiers from text, attributes and accessible names', hidden.length === 0, { leaks: hidden, sample: aliasRows });
    await shot('discreet-1440.png');
    await ev(() => window.harness.setDiscreet(false));
    await pause(400);
    check('opting out restores the names', (await probe()).length > 3);
    await ev(() => window.harness.close());
  },

  async motion() {
    await open(1440, 900);
    await mountAndWait();
    await pause(600);
    const drive = async rm => {
      await ev(v => window.harness.setReducedMotion(v), rm);
      await ev(() => window.harness.handle.root.querySelector('.cs-canvas').dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true, cancelable: true })));
      await pause(300);
      const a = await stats();
      await ev(() => window.harness.handle.root.querySelector('.cs-reset').click());
      await pause(900);
      const b = await stats();
      return b.frames - a.frames;
    };
    const normal = await drive(false);
    const reduced = await drive(true);
    check('the reset animation takes several frames normally and a single frame with reduced motion', normal > 4 && reduced <= 2, { normal, reduced });
    evidence.motion = { resetFramesNormal: normal, resetFramesReduced: reduced };
    await ev(() => window.harness.close());
  },

  async dense() {
    await open(1440, 900);
    await ev(() => window.harness.useSnapshot(window.harness.fixtures.snapshots.dense));
    await mountAndWait();
    await pause(500);
    const s0 = await stats();
    check('dense scene: waiting label kept, others suppressed by priority', s0.gfx.label.forced === 0 && s0.gfx.label.placed > 0, s0.gfx.label);
    evidence.denseLabels = s0.gfx.label;
    // Orbit for ~2 s and sample draw cost and frame interval.
    const { x: hx, y: hy } = await ev(() => window.harness.hostRect());
    const sx = hx + 700, sy = hy + 300;
    await mouse('mouseMoved', sx, sy, { buttons: 0 }); await mouse('mousePressed', sx, sy);
    for (let i = 1; i <= 120; i++) { await mouse('mouseMoved', sx + 160 * Math.sin(i / 12), sy + 90 * Math.cos(i / 9)); await pause(16); }
    await mouse('mouseReleased', sx, sy);
    await pause(300);
    const s1 = await stats();
    evidence.orbit = { drawMs: s1.gfx.drawMs, intervalMs: s1.gfx.intervalMs, renderer: s1.gfx.glRenderer, note: 'software rendering unless --native was used' };
    check('orbit samples were captured (timing reported, not gated on software rendering)', !!s1.gfx.drawMs && s1.gfx.drawMs.n > 20, s1.gfx.drawMs);
    await shot('dense-1440-orbit.png');
    await ev(() => window.harness.close());
  },

  async sustained() {
    // Orbit the dense scene for 3 s with one synthetic pointer move per animation frame; frame intervals come from the
    // scene's own rAF timestamps, so they include presentation back-pressure.
    await open(1440, 900);
    await ev(() => window.harness.useSnapshot(window.harness.fixtures.snapshots.dense));
    await mountAndWait();
    await pause(500);
    const r = await ev(() => new Promise(resolve => {
      const h = window.harness, root = h.handle.root, rect = root.getBoundingClientRect();
      const fire = (type, x, y, buttons) => root.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true, clientX: rect.left + x, clientY: rect.top + y, buttons, button: 0 }));
      const frames0 = h.handle.stats().frames, t0 = performance.now();
      fire('pointerdown', 700, 300, 1);
      const tick = () => {
        const t = performance.now() - t0;
        fire('pointermove', 700 + 220 * Math.sin(t / 700), 300 + 120 * Math.sin(t / 530), 1);
        if (t < 3000) requestAnimationFrame(tick); else { fire('pointerup', 700, 300, 0); setTimeout(() => resolve({ frames: h.handle.stats().frames - frames0, seconds: (performance.now() - t0) / 1000, stats: h.handle.stats().gfx }), 200); }
      };
      requestAnimationFrame(tick);
    }));
    evidence.sustainedOrbit = { renderer: r.stats.glRenderer, seconds: +r.seconds.toFixed(2), frames: r.frames, fps: +(r.frames / r.seconds).toFixed(1), intervalMs: r.stats.intervalMs, drawMs: r.stats.drawMs };
    check('a sustained orbit of the dense scene drew a frame per animation frame', r.frames > 30, evidence.sustainedOrbit);
    await ev(() => window.harness.close());
  },

  async sizes() {
    for (const [name, vw, vh, box] of [['sparse-1024.png', 1024, 768, [16, 136, 992, 564]], ['narrow-390.png', 390, 844, [12, 192, 366, 588]]]) {
      await open(vw, vh);
      await ev(b => { const host = document.getElementById('host'); Object.assign(host.style, { left: b[0] + 'px', top: b[1] + 'px', width: b[2] + 'px', height: b[3] + 'px' }); }, box);
      await ev(() => window.harness.useSnapshot(window.harness.fixtures.snapshots.dense));
      await mountAndWait();
      await pause(500);
      const s = await stats();
      check(`${name}: the waiting label stays placed at ${vw}x${vh}`, s.gfx.label.forced === 0, s.gfx.label);
      await shot(name);
      await ev(() => window.harness.close());
    }
  },
};

let failed = false;
try {
  for (const [name, run] of Object.entries(scenarios)) {
    if (only && !only.includes(name)) continue;
    scenario = name;
    console.log(`\n== ${name}`);
    try { await run(); } catch (error) { check('scenario ran to the end', false, String(error.message || error).slice(0, 300)); }
  }
} finally {
  try { await Promise.race([call('Browser.close'), pause(3000)]); } catch { /* closing */ }
  ws.close();
  server.close();
  await pause(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold the profile briefly */ }
}
const failures = checks.filter(c => !c.pass);
const report = { mode: native ? 'native (Edge chose the GPU)' : 'software WebGL (SwiftShader)', renderer: evidence.renderer ?? null, edge: 'headless', evidence, checks, consoleLines: consoleLines.slice(0, 40),
  requestsServed: requests.length, vendorRequests: requests.filter(r => /\/vendor\/three\//.test(r.path)).length };
writeFileSync(path.join(outDir, only ? `results-${only.join('+')}.json` : 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\n${checks.length - failures.length}/${checks.length} checks passed (${report.mode}; renderer: ${report.renderer})`);
if (consoleLines.length) console.log('page console/exceptions:\n  ' + consoleLines.slice(0, 15).join('\n  '));
process.exit(failures.length ? 1 : 0);

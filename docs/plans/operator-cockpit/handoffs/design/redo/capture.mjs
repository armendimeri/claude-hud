// P2-01 look study: stills and frame timing through Edge's DevTools protocol.
//
//   node docs/plans/operator-cockpit/handoffs/design/redo/capture.mjs <stills|bench|check> [--base=http://127.0.0.1:7791]
//        [--mode=d3d11|window|swiftshader] [--out=<dir>] [--url=<query>] [--dsf=1]
//
// Needs serve.mjs running (it does not start one). Uses a throwaway Edge profile. `--mode=d3d11` (default) is headless
// Edge on ANGLE/Direct3D 11, i.e. the laptop's own GPU; `window` opens a real Edge window; `swiftshader` is software.
// Every run prints the WebGL renderer string it actually got.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [cmd = 'check', ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.map(a => { const b = a.replace(/^--/, ''), i = b.indexOf('='); return i < 0 ? [b, true] : [b.slice(0, i), b.slice(i + 1)]; }));
const base = String(args.base || 'http://127.0.0.1:7791') + '/docs/plans/operator-cockpit/handoffs/design/redo/index.html';
const mode = String(args.mode || 'd3d11');
const outDir = path.resolve(String(args.out || path.join(here, 'stills')));
const dsf = Number(args.dsf || 1);
mkdirSync(outDir, { recursive: true });

const edge = process.env.EDGE || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!edge) { console.error('Edge not found; set EDGE'); process.exit(2); }
const profile = mkdtempSync(path.join(tmpdir(), 'p2-01-edge-'));
const gpuFlags = mode === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
const flags = [...(mode === 'window' ? ['--window-size=1456,1000', '--window-position=40,20'] : ['--headless=new']), '--hide-scrollbars', '--no-first-run', '--disable-extensions', '--disable-sync',
  '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, ...gpuFlags, 'about:blank'];
const proc = spawn(edge, flags, { stdio: 'ignore', windowsHide: mode !== 'window' });
let port;
for (let i = 0; i < 150 && !port; i++) { try { port = Number(readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await pause(100); } }
if (!port) { console.error('Edge debugging endpoint did not start'); process.exit(2); }
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 0; const waiting = new Map(); const logs = []; let loadResolve = null;
ws.onmessage = event => {
  const m = JSON.parse(event.data);
  if (m.method === 'Page.loadEventFired' && loadResolve) loadResolve();
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(`${m.params.type}: ${m.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`.slice(0, 400));
  if (m.method === 'Runtime.exceptionThrown') logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 400));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('log: ' + m.params.entry.text.slice(0, 300) + ' ' + (m.params.entry.url || ''));
  const p = waiting.get(m.id);
  if (p) { waiting.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
};
const call = (method, params = {}) => new Promise((res, rej) => { const id = ++nextId; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
await call('Page.enable'); await call('Runtime.enable'); await call('Log.enable');
async function ev(fn, ...a) {
  const r = await call('Runtime.evaluate', { expression: `(${fn.toString()})(...${JSON.stringify(a)})`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0]);
  return r.result.value;
}
async function open(query, { w = 1440, h = 900, reduced = false } = {}) {
  await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dsf, mobile: false });
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
  const loaded = new Promise(r => { loadResolve = r; });
  await call('Page.navigate', { url: base + query });
  await Promise.race([loaded, pause(15000)]);
  for (let i = 0; i < 150; i++) { if (await ev(() => !!window.proto?.ready)) break; await pause(100); }
  await ev(() => document.fonts.ready.then(() => true));
}
const shot = async name => { const file = path.join(outDir, name); writeFileSync(file, Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64')); console.log('wrote', path.relative(process.cwd(), file)); return file; };
const stats = () => ev(() => window.proto.holo.stats());
const mouse = (type, x, y, buttons = 0) => call('Input.dispatchMouseEvent', { type, x, y, button: buttons ? 'left' : 'none', buttons, clickCount: 1 });

const report = { mode, dsf, at: new Date().toISOString(), runs: {} };
try {
  if (cmd === 'check') {
    await open(String(args.url || '?data=sparse&opening=0'), { w: Number(args.w || 1440), h: Number(args.h || 900) });
    await pause(Number(args.wait || 1500));
    const s = await stats();
    console.log(JSON.stringify({ renderer: s.renderer, dpr: s.dpr, calls: s.calls, nodes: s.nodes, quality: s.quality, interval: s.interval, cpu: s.cpu, seg: s.seg, hidden: s.hiddenLabels }));
    await shot(String(args.name || 'check.png'));
  }
  if (cmd === 'profile') {
    await open(String(args.url || '?data=dense&opening=0&sim=0&quality=0'));
    await pause(2000);
    await call('Profiler.enable'); await call('Profiler.setSamplingInterval', { interval: 200 }); await call('Profiler.start');
    await pause(4000);
    const { profile } = await call('Profiler.stop');
    const self = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n]));
    const dt = new Map(); profile.samples.forEach((id, i) => dt.set(id, (dt.get(id) || 0) + (profile.timeDeltas[i] || 0)));
    for (const [id, t] of dt) { const n = byId.get(id); const k = (n.callFrame.functionName || '(anon)') + ' ' + n.callFrame.url.split('/').pop() + ':' + n.callFrame.lineNumber; self.set(k, (self.get(k) || 0) + t); }
    const total = [...self.values()].reduce((a, b) => a + b, 0);
    for (const [k, t] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log((t / 1000).toFixed(0).padStart(6) + ' ms  ' + (100 * t / total).toFixed(1).padStart(5) + '%  ' + k);
  }
  if (cmd === 'gates') {
    const out = {};
    await open('?data=dense&sim=0');
    const t0 = Date.now();
    out.openingAtLoad = await ev(() => window.proto.holo.opening());
    while (await ev(() => window.proto.holo.opening()) && Date.now() - t0 < 6000) await pause(50);
    out.openingEndedAfterMs = Date.now() - t0;
    await open('?data=dense&sim=0');
    await pause(400);
    out.beforeKey = await ev(() => window.proto.holo.opening());
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'x', code: 'KeyX' }); await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'x', code: 'KeyX' });
    await pause(100);
    out.afterKey = await ev(() => window.proto.holo.opening());
    await open('?data=dense&sim=0'); await pause(300);
    await mouse('mousePressed', 700, 400, 1); await mouse('mouseReleased', 700, 400);
    await pause(100);
    out.afterClick = await ev(() => window.proto.holo.opening());
    await open('?data=dense&sim=0', { reduced: true }); await pause(300);
    out.reducedMotionOpening = await ev(() => window.proto.holo.opening());
    await open('?data=dense&sim=0&effects=0'); await pause(300);
    out.effectsOffOpening = await ev(() => window.proto.holo.opening());
    await open('?data=dense&sim=0&opening=0&discreet=1'); await pause(1500);
    const text = await ev(() => document.body.innerText + ' ' + [...document.querySelectorAll('[title],[aria-label]')].map(e => (e.title || '') + (e.getAttribute('aria-label') || '')).join(' '));
    const names = ['Ledger', 'Reports', 'Imports', 'Invoices', 'Atlas', 'STUDIO', 'export', 'Reconcile', 'Weekly', 'Churn', 'Explore', 'Plan the', 'Which date'];
    out.discreetLeaks = names.filter(n => text.toLowerCase().includes(n.toLowerCase()));
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    console.log(JSON.stringify(out, null, 1));
    report.runs.gates = out;
    writeFileSync(path.join(outDir, 'gates.json'), JSON.stringify(report, null, 2));
  }
  if (cmd === 'stills') {
    const live = String(args.live || 'http://127.0.0.1:7790');
    const list = [
      ['sparse-live-1440.png', `?api=${encodeURIComponent(live)}&opening=0&quality=0`, 2600],
      ['sparse-fixture-1440.png', '?data=sparse&opening=0&sim=0&quality=0', 1800],
      ['dense-1440.png', '?data=dense&opening=0&sim=0&quality=0', 1800],
      ['selected-inspector-1440.png', '?data=dense&opening=0&sim=0&quality=0&select=first', 2200],
      ['waiting-inspector-1440.png', '?data=sparse&opening=0&sim=0&quality=0&select=waiting', 2000],
      ['discreet-1440.png', '?data=dense&opening=0&sim=0&quality=0&discreet=1', 1800],
      ['opening-0.5s.png', '?data=dense&sim=0&quality=0&opening=0.5', 1200],
      ['opening-1.0s.png', '?data=dense&sim=0&quality=0&opening=1.0', 1200],
      ['opening-1.45s.png', '?data=dense&sim=0&quality=0&opening=1.45', 1200],
      ['opening-2.0s.png', '?data=dense&sim=0&quality=0&opening=2.0', 1200],
    ];
    const only = args.only ? String(args.only).split(',') : null;
    for (const [name, q, wait] of list) {
      if (only && !only.some(o => name.startsWith(o))) continue;
      await open(q);
      await pause(wait);
      if (name.startsWith('sparse-fixture')) { await ev(() => window.proto.pulseAny()); await pause(350); }
      await shot(name);
      report.runs[name] = { query: q, renderer: (await stats()).renderer };
    }
  }
  if (cmd === 'bench') {
    // 1) programmatic orbit of the dense scene, 2) a real pointer drag through CDP, 3) idle ambient.
    const BW = Number(args.w || 1440), BH = Number(args.h || 900);
    for (const d of String(args.dsfs || '1,1.5').split(',').map(Number)) {
      await call('Emulation.setDeviceMetricsOverride', { width: BW, height: BH, deviceScaleFactor: d, mobile: false });
      await open(`?data=dense&opening=0&quality=${args.quality ?? 0}${args.extra || ""}`, { w: BW, h: BH });
      await call('Emulation.setDeviceMetricsOverride', { width: BW, height: BH, deviceScaleFactor: d, mobile: false });
      await pause(2500);
      const orbit = await ev(() => window.proto.holo.benchOrbit(8));
      await ev(() => window.proto.holo.startRecording());
      const cx = 600, cy = 480;
      await mouse('mouseMoved', cx, cy); await mouse('mousePressed', cx, cy, 1);
      for (let i = 0; i < 240; i++) { const a = i / 240 * Math.PI * 4; await mouse('mouseMoved', cx + Math.sin(a) * 260, cy + Math.sin(a * 0.7) * 120, 1); await pause(16); }
      await mouse('mouseReleased', cx, cy);
      const drag = await ev(() => window.proto.holo.stopRecording());
      await ev(() => window.proto.holo.reset());
      await pause(800);
      await ev(() => window.proto.holo.startRecording());
      await pause(5000);
      const idle = await ev(() => window.proto.holo.stopRecording());
      const s = await stats();
      report.runs[`${BW}x${BH}@${d}`] = { renderer: s.renderer, dpr: s.dpr, canvas: s.size, post: s.post, quality: s.quality, calls: s.calls, triangles: s.triangles, programs: s.programs, nodes: s.nodes, orbit, drag, idle };
      console.log(JSON.stringify(report.runs[`${BW}x${BH}@${d}`], null, 1));
    }
    writeFileSync(path.join(outDir, `bench-${mode}-${BW}x${BH}.json`), JSON.stringify(report, null, 2));
  }
  if (logs.length) { console.log('--- console errors/warnings ---'); for (const l of [...new Set(logs)]) console.log(l); }
} finally {
  // Close the whole browser (proc.kill alone leaves the GPU and renderer children running).
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const b = new WebSocket(webSocketDebuggerUrl);
    await new Promise((res, rej) => { b.onopen = res; b.onerror = rej; });
    b.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  } catch { /* fall through to taskkill */ }
  ws.close();
  await pause(800);
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); else proc.kill();
  await pause(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Edge may still hold files */ }
}

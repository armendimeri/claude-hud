// P3 evidence runner. Serves the repository on an OS-assigned loopback port, opens the isolated inspector harness in a
// throwaway Edge profile and runs the DOM scenarios. It never touches the owner's HUD (port 7777), tasks or hooks.
//
//   node src/web/inspector/harness/run.mjs [--only=name,name] [--shots=<dir>] [--json]
//
// Exit 0: every check passed. Exit 2: Edge is unavailable (the check was not run). Exit 1: a check failed.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const only = args.only ? String(args.only).split(',') : null;
const shotsDir = args.shots ? path.resolve(String(args.shots)) : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const quiet = !!args.json;
const log = (...a) => { if (!quiet) console.log(...a); };

const edge = process.env.EDGE || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!edge) { console.error('Edge not found; set EDGE'); process.exit(2); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const server = createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  const file = path.resolve(repo, '.' + rel), inside = path.relative(repo, file);
  if (inside.startsWith('..') || path.isAbsolute(inside) || inside.split(path.sep).some(p => p.startsWith('.')) || !existsSync(file)) { res.writeHead(404).end('not found'); return; }
  try { res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(readFileSync(file)); } catch { res.writeHead(404).end('not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(path.join(tmpdir(), 'p3-edge-'));
const proc = spawn(edge, ['--headless=new', '--hide-scrollbars', '--no-first-run', '--disable-extensions', '--disable-sync', '--no-default-browser-check',
  '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let port;
for (let i = 0; i < 150 && !port; i++) { try { port = Number(readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await pause(100); } }
if (!port) { console.error('Edge debugging endpoint did not start'); proc.kill(); process.exit(2); }
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 0; const waiting = new Map(); const consoleLines = []; let loadResolve = null;
ws.onmessage = event => {
  const m = JSON.parse(event.data);
  if (m.method === 'Page.loadEventFired' && loadResolve) loadResolve();
  if (m.method === 'Runtime.exceptionThrown') consoleLines.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300));
  const p = waiting.get(m.id);
  if (p) { waiting.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
};
const call = (method, params = {}) => new Promise((res, rej) => { const id = ++nextId; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
await call('Page.enable'); await call('Runtime.enable');

async function ev(fn, ...fnArgs) {
  const r = await call('Runtime.evaluate', { expression: `(${fn.toString()})(...${JSON.stringify(fnArgs)})`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).split('\n')[0]);
  return r.result.value;
}
async function open(width, height) {
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const loaded = new Promise(r => { loadResolve = r; });
  await call('Page.navigate', { url: `${base}/src/web/inspector/harness/index.html` });
  await Promise.race([loaded, pause(15000)]);
  for (let i = 0; i < 100; i++) { if (await ev(() => !!window.harness?.ready)) return; await pause(100); }
  throw new Error('harness did not load');
}
const shot = async name => { if (shotsDir) writeFileSync(path.join(shotsDir, name), Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64')); };
const key = (type, k, code, vk, extra = {}) => call('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, ...extra });

const results = [];
const check = (scenario, name, pass, detail = '') => { results.push({ scenario, name, pass: !!pass, detail }); log(`${pass ? 'PASS' : 'FAIL'}  [${scenario}] ${name}${!pass && detail ? '  ' + detail : ''}`); };

try {
  // ---- scenarios in the page, desktop width ---------------------------------------------------------------------
  await open(1440, 900);
  const names = await ev(() => window.harness.names);
  for (const name of names) {
    if (only && !only.includes(name)) continue;
    if (name === 'sheet') continue;
    for (const c of await ev(n => window.harness.run(n), name)) check(name, c.name, c.pass, c.detail);
  }

  // ---- real key events ------------------------------------------------------------------------------------------
  if (!only || only.includes('keys')) {
    await ev(() => { window.harness.shell.escapes = 0; window.harness.rows(); [...document.querySelectorAll('#scene button')][0].focus(); window.harness.mount({ selection: { sessionId: 'claude:export/\u03b1', agentId: null }, onClose: () => window.harness.rows() }); return true; });
    await pause(150);
    const before = await ev(() => ({ inspector: !!document.querySelector('.insp'), active: document.activeElement.className }));
    await key('rawKeyDown', 'Escape', 'Escape', 27); await key('keyUp', 'Escape', 'Escape', 27);
    await pause(150);
    const after = await ev(() => ({ inspector: !!document.querySelector('.insp'), shellEscapes: window.harness.shell.escapes, closes: window.harness.shell.closes.slice(), focus: document.activeElement.dataset?.entityKey || document.activeElement.tagName }));
    check('keys', 'real Escape closes the inspector', before.inspector && !after.inspector && after.closes.at(-1) === 'escape', JSON.stringify({ before, after }));
    check('keys', 'the shell Escape listener did not also run', after.shellEscapes === 0, String(after.shellEscapes));
    check('keys', 'focus returned to the compact row by entity key', after.focus === JSON.stringify(['claude:export/\u03b1', null]), after.focus);

  }
  if (!only || only.includes('realComposer')) {
    const sent = await ev(async () => {
      const { capabilities } = await import('/tests/fixtures/cockpit/private.mjs');
      window.__sent = [];
      const m = window.harness.mount({ overrides: { getCapabilities: async () => capabilities.idle,
        submit: async (sel, c) => { window.__sent.push(c); return { actionId: c.actionId, status: 'acknowledged', at: 1 }; } } });
      document.querySelector('.insp-open').click();
      await window.harness.settle();
      document.querySelector('.insp-compose').focus();
      return true;
    });
    await call('Input.insertText', { text: 'line one' });
    await key('keyDown', 'Enter', 'Enter', 13, { text: '\r' }); await key('keyUp', 'Enter', 'Enter', 13);
    await call('Input.insertText', { text: 'line two' });
    await key('rawKeyDown', 'Enter', 'Enter', 13, { modifiers: 2, text: '\r' }); await key('keyUp', 'Enter', 'Enter', 13, { modifiers: 2 });
    await pause(200);
    const r = await ev(() => ({ sent: window.__sent.map(c => c.payload.text), kinds: window.__sent.map(c => c.kind) }));
    check('realComposer', 'Enter inserted a newline and Ctrl+Enter sent one message', r.sent.length === 1 && r.sent[0] === 'line one\nline two' && r.kinds[0] === 'prompt', JSON.stringify(r));
    await ev(() => window.harness.close());
  }

  // ---- narrow sheet at 390 x 844 --------------------------------------------------------------------------------
  if (!only || only.includes('sheet')) {
    await open(390, 844);
    for (const c of await ev(() => window.harness.run('sheet')).catch(() => [])) check('sheet', c.name, c.pass, c.detail);
    await ev(() => { window.harness.mount({}); return true; });
    check('sheet', 'no horizontal page scroll at 390', await ev(() => document.documentElement.scrollWidth <= innerWidth), '');
    await ev(() => window.harness.close());
  }

  // ---- screenshots at the P1-01 sizes -----------------------------------------------------------------------------
  if (shotsDir) {
    for (const [w, h, name, kind] of [[1440, 900, 'inspector-1440-question', 'question'], [1440, 900, 'inspector-1440-observed', 'observed'], [1024, 768, 'inspector-1024-permission', 'permission'], [1440, 900, 'inspector-1440-composer', 'idle'], [390, 844, 'inspector-390-sheet', 'question']]) {
      await open(w, h);
      await ev(k => window.harness.show(k), kind);
      await pause(200);
      await shot(name + '.png');
      await ev(() => window.harness.close());
    }
  }
} finally {
  try { await call('Browser.close'); } catch {}
  ws.close();
  await pause(300);
  try { proc.kill(); } catch {}
  server.close();
  await pause(500);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}

const failed = results.filter(r => !r.pass);
if (consoleLines.length) log('page exceptions:\n  ' + consoleLines.join('\n  '));
if (args.json) console.log(JSON.stringify({ total: results.length, failed: failed.length, results, exceptions: consoleLines }));
else log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length || consoleLines.length ? 1 : 0);

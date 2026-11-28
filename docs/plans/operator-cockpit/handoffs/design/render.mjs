// P1-01 renderer and auditor. Needs Microsoft Edge (or set EDGE). Uses a throwaway profile, never the owner's browser or HUD.
// Run from the repository root after build.mjs: node docs/plans/operator-cockpit/handoffs/design/render.mjs [frame ...]
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const edge = process.env.EDGE || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!edge) { console.error('Edge not found; set EDGE'); process.exit(2); }
const layout = JSON.parse(readFileSync(join(here, 'layout.json'), 'utf8'));
const only = process.argv.slice(2);
const names = Object.keys(layout.frames).filter(n => !only.length || only.includes(n));
mkdirSync(join(here, 'images'), { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'p101-edge-'));
const proc = spawn(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--disable-extensions', '--disable-sync',
  '--no-default-browser-check', '--remote-debugging-port=0', '--allow-file-access-from-files', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let port;
for (let i = 0; i < 100 && !port; i++) {
  try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await pause(100); }
}
if (!port) { console.error('Edge debugging endpoint did not start'); process.exit(2); }
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let next = 0; const pending = new Map(); let loadResolve = null;
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Page.loadEventFired' && loadResolve) loadResolve();
  const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
};
const call = (method, params = {}) => new Promise((res, rej) => { const id = ++next; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
await call('Page.enable');
const open = async (url, w, h) => {
  await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  const loaded = new Promise(r => { loadResolve = r; });
  await call('Page.navigate', { url });
  await Promise.race([loaded, pause(15000)]);
  await pause(500);
};
const shot = async (file) => writeFileSync(file, Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
const png = f => { const b = readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

const results = {};
for (const name of names) {
  const [w, h] = layout.frames[name].viewport;
  const url = pathToFileURL(join(here, 'frames', name + '.html')).href;
  const row = { images: {}, sizeOk: true };
  await open(url, w, h);
  const raw = (await call('Runtime.evaluate', { expression: "document.getElementById('audit').textContent", returnByValue: true })).result.value;
  try { row.audit = JSON.parse(raw); } catch { row.audit = { pass: false, fails: [{ rule: 'audit-not-produced', detail: String(raw).slice(0, 120) }] }; }
  for (const [variant, q, file] of [['plain', '', name + '.png'], ['annotated', '?annot', name + '.annotated.png'], ['gray', '?gray', name + '.gray.png']]) {
    if (q) await open(url + q, w, h);
    const out = join(here, 'images', file);
    await shot(out);
    const [pw, ph] = png(out);
    row.images[variant] = `${pw}x${ph}`;
    if (pw !== w || ph !== h) row.sizeOk = false;
  }
  results[name] = row;
  console.log(name.padEnd(24), row.images.plain, row.sizeOk ? 'size-ok' : 'SIZE-MISMATCH', row.audit.pass ? 'AUDIT PASS' : 'AUDIT FAIL', `labelled ${row.audit.info?.labelled ?? '-'}/${row.audit.info?.nodes ?? '-'}`, `targets ${row.audit.info?.primaryTargets}`);
  for (const f of row.audit.fails || []) console.log('   -', f.rule, typeof f.detail === 'string' ? f.detail : JSON.stringify(f.detail));
}
try { await Promise.race([call('Browser.close'), pause(3000)]); } catch { /* closing */ }
ws.close();
await pause(500);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold the profile briefly */ }
writeFileSync(join(here, 'audit.json'), JSON.stringify({ edge: 'headless, software rendering, fonts fall back to system faces', frames: results }, null, 2) + '\n');
const bad = Object.values(results).filter(r => !r.audit.pass || !r.sizeOk).length;
console.log(bad ? `${bad} frame(s) need attention` : 'all frames pass');
process.exit(bad ? 1 : 0);

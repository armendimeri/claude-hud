// Windows browser check: node tests/browser-smoke.mjs
// Starts its own `--demo` HUD on a free port (over temp folders, tests/helpers.mjs), opens /?view=network,
// /?view=cards and /design at 1440x900, 1024x768 and 390x844 in headless Edge with an isolated profile, and fails on
// a runtime exception or a horizontal page scroll. The 9 screenshots stay in the ignored .hud-tmp/ folder.
// HUD_TEST_BROWSER picks another Chromium-based browser. Node built-ins only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startHud, pause } from './helpers.mjs';

const SIZES = [[1440, 900], [1024, 768], [390, 844]];
const ROUTES = [['network', '/?view=network'], ['cards', '/?view=cards'], ['design', '/design']];

const dir = fileURLToPath(new URL('../.hud-tmp/', import.meta.url));
await fs.mkdir(dir, { recursive: true });
const hud = await startHud({ demo: true });
const profile = await fs.mkdtemp(path.join(dir, 'edge-profile-'));
const edge = process.env.HUD_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let ws;
const shots = [];
try {
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await pause(100); }
  }
  assert.ok(port, 'Edge debugging endpoint started');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 0;
  const pending = new Map(), errors = [];
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(`${d.text} ${d.exception?.description || ''} (${d.url || ''}:${d.lineNumber})`);
    }
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(msg.error) : p.resolve(msg.result); }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => (await call('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  await call('Runtime.enable'); await call('Page.enable');
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  for (const [name, route] of ROUTES) {
    for (const [width, height] of SIZES) {
      const where = `${name} at ${width}x${height}`;
      const before = errors.length;
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
      await call('Page.navigate', { url: hud.base + route });
      if (name === 'design') {
        let ready = false;
        for (let i = 0; i < 100 && !ready; i++) { ready = await evaluate(`document.readyState === 'complete' && document.body.innerText.length > 200`); if (!ready) await pause(100); }
        assert.ok(ready, `${where} renders`);
      } else {
        let text = '';
        for (let i = 0; i < 100; i++) {
          // Dense network layouts shorten visible labels; full agent/model details remain in accessible labels.
          text = await evaluate(`document.body.innerText + Array.from(document.querySelectorAll('[aria-label]'), el => el.getAttribute('aria-label')).join(' ')`) || '';
          if (/Codex|gpt-/i.test(text) && /LIVE/i.test(text)) break;
          await pause(100);
        }
        assert.ok(/Codex|gpt-/i.test(text), `${where} renders the demo's Codex session: ${text.slice(0, 300)}`);
        assert.ok(/LIVE/i.test(text), `${where} connects to SSE`);
      }
      await pause(1500); // Let initial layout and boot transitions finish before inspecting the rendered view.
      if (name !== 'design') {
        const visible = await evaluate(`Array.from(document.querySelectorAll('${name === 'cards' ? '.card, .crow' : '.nf button'}')).some(el => { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 10; })`);
        assert.ok(visible, `${where} has visible session geometry`);
      }
      const overflow = await evaluate('document.documentElement.scrollWidth - innerWidth');
      assert.ok(overflow <= 0, `${where} has no horizontal page scroll (scrollWidth exceeds the window by ${overflow}px)`);
      assert.deepEqual(errors.slice(before), [], `${where} has no runtime exception`);
      const file = path.join(dir, `smoke-${name}-${width}x${height}.png`);
      await fs.writeFile(file, Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      shots.push(file);
      console.log(`pass ${where}: no runtime exception, no horizontal page scroll`);
    }
  }
  assert.deepEqual(errors, [], 'no browser runtime exceptions');
  console.log(`pass browser runtime; ${shots.length} screenshots:\n${shots.map(f => '  ' + f).join('\n')}`);
  await call('Browser.close').catch(() => {});
} finally {
  ws?.close();
  if (browser.exitCode === null) {
    const exited = once(browser, 'exit'); browser.kill(); await exited;
  }
  await hud.close();
  // The profile can briefly remain locked by Edge crash reporting; screenshots are kept for review.
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

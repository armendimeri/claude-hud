// Optional Windows browser check: node tests/browser-smoke.mjs http://127.0.0.1:7778
// Uses an isolated Edge profile and Node built-ins. Screenshots stay in ignored .hud-tmp/.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const base = process.argv[2] || 'http://127.0.0.1:7778';
const dir = path.resolve('.hud-tmp');
await fs.mkdir(dir, { recursive: true });
const profile = await fs.mkdtemp(path.join(dir, 'edge-profile-'));
const edge = process.env.HUD_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(r => setTimeout(r, ms));
let ws;
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
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(msg.error) : p.resolve(msg.result); }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  await call('Runtime.enable'); await call('Page.enable');
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  for (const view of ['network', 'cards']) {
    await call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${base}/?view=${view}` });
    let text = '';
    for (let i = 0; i < 100; i++) {
      // Dense network layouts shorten visible labels; full agent/model details remain in accessible labels.
      text = (await call('Runtime.evaluate', { expression: `document.body.innerText + Array.from(document.querySelectorAll('[aria-label]'), el => el.getAttribute('aria-label')).join(' ')`, returnByValue: true })).result.value || '';
      if (text.includes('Codex') && /LIVE/i.test(text) && /gpt-/i.test(text)) break;
      await pause(100);
    }
    assert.ok(text.includes('Codex') && /gpt-/i.test(text), `${view} renders a Codex session`);
    assert.ok(/LIVE/i.test(text), `${view} connects to SSE`);
    await pause(1500); // Let initial layout and boot transitions finish before inspecting the rendered view.
    const visible = (await call('Runtime.evaluate', { expression: `Array.from(document.querySelectorAll('${view === 'cards' ? '.card, .crow' : '.nf button'}')).some(el => { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 10; })`, returnByValue: true })).result.value;
    assert.ok(visible, `${view} has visible session geometry`);
    const overflow = (await call('Runtime.evaluate', { expression: 'document.documentElement.scrollWidth > innerWidth', returnByValue: true })).result.value;
    assert.equal(overflow, false, `${view} has no horizontal page overflow`);
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(dir, `codex-${view}.png`), Buffer.from(shot.data, 'base64'));
    console.log(`pass ${view}: Codex visible, live stream, no horizontal page overflow`);
  }
  assert.deepEqual(errors, [], 'no browser runtime exceptions');
  console.log('pass browser runtime');
  await call('Browser.close').catch(() => {});
} finally {
  ws?.close();
  if (browser.exitCode === null) {
    const exited = once(browser, 'exit'); browser.kill(); await exited;
  }
  // The profile can briefly remain locked by Edge crash reporting; screenshots are kept for review.
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

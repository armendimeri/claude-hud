// Windows browser check: node tests/browser-smoke.mjs
// Starts its own `--demo` HUD on a free port (over temp folders, tests/helpers.mjs), opens /?view=network,
// /?view=cards and /design at 1440x900, 1024x768 and 390x844 in headless Edge with an isolated profile, and fails on
// a runtime exception or a horizontal page scroll. It also exercises Plans and captures its states in .hud-tmp/.
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
  const evaluate = async (expression, options = {}) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, ...options });
    assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description || result.exceptionDetails?.text);
    return result.result.value;
  };
  async function until(expression, message) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await pause(100);
    }
    assert.fail(message);
  }
  async function capture(name, width, height) {
    const file = path.join(dir, `smoke-${name}-${width}x${height}.png`);
    await fs.writeFile(file, Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    shots.push(file);
  }
  const queue = '.p-plans .work-queue';
  const tour = '.p-plans .plan[data-project="TourCMS"]';
  const ready = queue + ' [data-queue="ready"]';
  const quiet = '.p-plans .quiet-toggle';
  const p4 = tour + ' .pn[data-id="P4"]';
  const work = 'On P4 · Booking changes';
  const copy = queue + ' button[aria-label="Copy kickoff for P2"]';
  const prompt = 'Do booking-changes/P2. Follow the workflow-run skill.';
  const click = (selector, options) => evaluate(`{
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el.click) el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }`, options);

  async function checkBoardInteractions() {
    const flags = await evaluate(`[...new Set([...document.querySelectorAll('.p-plans .pn [data-flag]')].map(el => el.dataset.flag))].sort()`);
    assert.deepEqual(flags, ['early', 'stalled', 'unclaimed'], 'the demo renders all three drift marks');
    assert.equal(await evaluate(`document.querySelector('${p4} .pn-count').textContent`), '1', 'the in-flight todo item has one active agent');
    const pulse = tour + ' .pg-pulse[data-active][data-id="P4"]';
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('${pulse}')).display`), 'none', 'reduced motion hides the live pulse');
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await until(`getComputedStyle(document.querySelector('${pulse}')).animationName === 'pnpulse'`, 'the in-flight todo item pulses with effects enabled');
    await click('.top button[aria-label="Effects"]');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('${pulse}')).display`), 'none', 'Effects off hides the live pulse');
    await click('.top button[aria-label="Effects"]');
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    for (const selector of ['.card > .work-label', '.sub .work-label']) {
      assert.ok(await evaluate(`[...document.querySelectorAll('${selector}')].some(el => el.textContent.includes(${JSON.stringify(work)}) && !el.hidden)`), `${selector} shows the linked item and plan`);
    }
    assert.equal(await evaluate(`document.querySelector('${tour} .plan-h .chip:not([hidden])').textContent`), 'Working 1',
      'Working counts only linked active agents');
    await evaluate(`{
      const item = document.querySelector('${p4}');
      item.focus();
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }`);
    assert.equal(await evaluate(`document.querySelector('${tour} .plan-detail').hidden`), false, 'Enter opens item details');
    assert.match(await evaluate(`document.querySelector('${tour} .plan-flags').textContent`), /Board not updated/);
    const history = await evaluate(`[...document.querySelectorAll('${tour} .plan-history > div')].map(el => el.textContent)`);
    assert.equal(history.length, 3, 'the item shows its three most recent changes');
    assert.match(history[2], /^\d\d:\d\d · claimed by P4 price check/, 'the claim shows its actor and local time');
    await click(tour + ' .plan-detail .plan-agent');
    assert.ok(await evaluate(`document.activeElement.matches('.card[data-s="agents"]')`), 'a detail link jumps to the session card');
    await click(p4);
    await click(queue + ' [data-queue="flight"]');
    assert.ok(await evaluate(`[...document.querySelectorAll('${queue} .wq-actions button')].some(button => {
      if (!button.textContent.startsWith('P4 price check')) return false;
      button.click();
      return document.activeElement.matches('.sub') && document.activeElement.textContent.includes(${JSON.stringify(work)});
    })`), 'an In flight action jumps to the linked subagent');
    await click(queue + ' [data-queue="flight"]');

    await click(ready);
    assert.equal(await evaluate(`document.querySelector('${ready}').getAttribute('aria-expanded')`), 'true', 'Ready opens its list');
    const readyText = await evaluate(`document.querySelector('${queue} .wq-list').innerText`);
    assert.match(readyText, /TourCMS · Booking changes[\s\S]*P2 · Change people[\s\S]*Sonnet 5.5 \/ high[\s\S]*source\\repos\\TourCMS/);
    await call('Browser.grantPermissions', { origin: hud.base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await evaluate('navigator.clipboard.writeText("before copy")', { awaitPromise: true, userGesture: true });
    await click(copy, { userGesture: true });
    await until(`document.querySelector('${queue} [role="status"]').textContent === 'Copied'`, 'Copy reports success');
    assert.equal(await evaluate('navigator.clipboard.readText()', { awaitPromise: true, userGesture: true }), prompt, 'Copy writes the exact kickoff prompt');

    await evaluate(`{
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      const originalCopy = document.execCommand;
      document.execCommand = command => { window.testCopyCommand = command; return false; };
      document.querySelector('${copy}').click();
      document.execCommand = originalCopy;
      delete navigator.clipboard;
    }`);
    const fallback = await evaluate(`(() => {
      const field = document.querySelector('${queue} input[readonly]');
      return { command: window.testCopyCommand, value: field.value, visible: !field.hidden,
        selected: document.activeElement === field ? field.value.slice(field.selectionStart, field.selectionEnd) : '',
        hint: document.querySelector('${queue} [role="status"]').textContent };
    })()`);
    assert.deepEqual(fallback, { command: 'copy', value: prompt, visible: true, selected: prompt, hint: 'Press Ctrl+C' },
      'without the clipboard API or legacy copy, the read-only field stays selected');
    await click(ready);

    assert.equal(await evaluate(`document.querySelector('${quiet}').textContent`), '+2 quiet boards');
    await click(quiet);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.p-plans .quiet-boards .plan-t')].map(el => el.textContent)`),
      ['Currency display', 'Archived booking notes'], 'the completed and old inactive demo boards unfold');
    const navigation = await evaluate('performance.timeOrigin');
    await call('Page.reload');
    await until(`performance.timeOrigin !== ${navigation} && document.querySelector('${quiet}')?.getAttribute('aria-expanded') === 'true' &&
      document.querySelectorAll('.p-plans .quiet-boards .plan').length === 2`, 'quiet boards remain open after a reload');
    await click(quiet);
    await evaluate('scrollTo(0, 0)');
    console.log('pass board details, session and subagent jumps, live pulse, clipboard and quiet-board persistence');
  }

  async function checkBoardUpdates() {
    const result = await evaluate(`(async () => {
      const st = await (await fetch('/api/state')).json();
      const mount = document.createElement('div');
      mount.hidden = true; document.body.append(mount);
      const preview = H.createHud(mount);
      const item = 'TourCMS|booking-changes#P4';
      const first = { ...st, board: { ...st.board, items: {} } };
      preview.render(first);
      const graphNode = () => mount.querySelector('${p4}');
      const oldNode = graphNode();
      preview.render({ ...first });
      const stable = graphNode() === oldNode;
      const next = { ...st, board: { ...st.board, items: { [item]: st.board.items[item] } } };
      preview.render(next);
      const rebuilt = graphNode() !== oldNode && graphNode().querySelector('.pn-count')?.textContent === '1' &&
        !!graphNode().querySelector('[data-flag="unclaimed"]');
      const events = (previous, next) => H.happenings(previous, next).filter(e => e.type === 'board-mark').map(e => e.text);
      preview.render({ ...st, plans: [], board: {} });
      const noBoards = !mount.querySelector('.plans-empty').hidden && mount.querySelector('.work-queue').hidden;
      mount.remove();
      return { stable, rebuilt, marks: events(first, next), steady: events(next, next), noBoards };
    })()`, { awaitPromise: true });
    assert.deepEqual(result, { stable: true, rebuilt: true, marks: ['Booking changes: P4 board not updated'], steady: [], noBoards: true },
      'steady graph nodes, live count/mark rebuild, new-mark announcement and no-board state');
    console.log('pass graph signature updates, new-mark announcements and no-board state');
  }
  await call('Runtime.enable'); await call('Page.enable');
  await call('Page.bringToFront');
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });
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
        const metrics = await evaluate(`(() => {
          const buttons = [...document.querySelectorAll('${queue} .wq-count')];
          const rect = document.querySelector('.p-plans .plan-t').getBoundingClientRect();
          return { labels: buttons.map(el => el.querySelector('.label').textContent),
            counts: buttons.map(el => Number(el.querySelector('b').textContent)),
            lines: new Set(buttons.map(el => el.getBoundingClientRect().top)).size,
            boardTop: rect.top, boardBottom: rect.bottom, viewport: innerHeight };
        })()`);
        assert.deepEqual(metrics.labels, ['Needs you', 'In flight', 'Ready', 'To accept', 'Drift'], `${where} shows the five queue counts`);
        assert.ok(metrics.counts.every(n => n > 0), `${where} has live rows in every queue list`);
        assert.equal(metrics.lines, 1, `${where} keeps the queue on one row`);
        if (width === 1024) assert.ok(metrics.boardTop >= 0 && metrics.boardBottom < metrics.viewport,
          `${where} has the first plan title above the fold (title ends at ${metrics.boardBottom}px, viewport ${metrics.viewport}px)`);
        if (name === 'network' && width === 1440) {
          await click('.nf button[aria-label*="P4 price check"]');
          assert.equal(await evaluate("document.querySelector('.net-pin .work-label').textContent"), work, 'the network card shows the linked item and plan');
          await click('.net-pin button:last-child');
        }
        if (name === 'cards' && width === 1440) {
          await checkBoardInteractions();
          await checkBoardUpdates();
        }
      } else {
        assert.ok(await evaluate(`document.querySelector('.gal-sec .pn[data-active] .pn-count') && ['unclaimed', 'stalled', 'early'].every(flag =>
          document.querySelector('.gal-sec .pn [data-flag="' + flag + '"]'))`), `${where} has an in-flight specimen and every drift mark`);
        assert.ok(await evaluate(`[...document.querySelectorAll('.gal-sec .work-queue')].some(el =>
          el.querySelector('.wq-empty') && [...el.querySelectorAll('.wq-count b')].every(count => count.textContent === '0')) &&
          document.querySelector('.gal-sec .work-queue .wq-row') && document.querySelector('.gal-sec .quiet-toggle[aria-expanded="false"]')`),
        `${where} has full and empty queues and folded quiet boards`);
      }
      const overflow = await evaluate('document.documentElement.scrollWidth - innerWidth');
      assert.ok(overflow <= 0, `${where} has no horizontal page scroll (scrollWidth exceeds the window by ${overflow}px)`);
      assert.deepEqual(errors.slice(before), [], `${where} has no runtime exception`);
      await capture(name, width, height);
      if (name === 'cards') {
        await evaluate("document.querySelector('.p-plans').scrollIntoView()");
        await capture('plans', width, height);
        if (width === 390) {
          await click(ready);
          assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'opening Ready adds no mobile page overflow');
          await capture('plans-ready', width, height);
        }
      }
      if (name === 'design' && width === 1024) {
        await evaluate("document.querySelector('.gal-sec .pn[data-active]').closest('.gal-sec').scrollIntoView()");
        await capture('design-board', width, height);
        await evaluate("document.querySelector('.gal-sec .work-queue').closest('.gal-sec').scrollIntoView()");
        await capture('design-queue', width, height);
      }
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

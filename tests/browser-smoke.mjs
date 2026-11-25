// Windows browser check: node tests/browser-smoke.mjs
// Starts its own `--demo` HUD on a free port (over temp folders, tests/helpers.mjs), opens /?view=network,
// /?view=cards and /design at 1440x900, 1024x768 and 390x844 in headless Edge with an isolated profile, and fails on
// a runtime exception or a horizontal page scroll. It also exercises Plans, warnings and page extras, with captures in .hud-tmp/.
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

  async function checkWarnings(width, height) {
    const amber = '.app > .banners .warning[data-kind="context"]';
    const red = '.app > .banners .ban';
    const chart = '.p-sess .card[data-s="busy"] .activity-chart';
    const before = await evaluate(`(() => {
      const warning = document.querySelector('${amber}'), needs = document.querySelector('${red}');
      return {
        below: warning.getBoundingClientRect().top >= needs.getBoundingClientRect().bottom,
        amber: getComputedStyle(warning).borderLeftColor === getComputedStyle(warning.querySelector('.warning-label')).color &&
          getComputedStyle(warning).borderLeftColor !== getComputedStyle(needs, '::before').backgroundColor,
        text: warning.querySelector('.warning-text').textContent,
      };
    })()`);
    assert.deepEqual(before, { below: true, amber: true, text: 'Context reached 80%' });
    await capture('warning', width, height);
    await click(amber + ' .ban-x');
    const peak = await evaluate(`document.querySelector('${chart}').getAttribute('aria-label')`);
    await until(`document.querySelector('${chart}').getAttribute('aria-label') !== ${JSON.stringify(peak)}`, 'real SSE changed the plotted output');
    assert.ok(await evaluate(`!document.querySelector('${amber}') && !!document.querySelector('${red}')`),
      'the warning stays dismissed after a state push and the red banner stays visible');

    const transitions = await evaluate(`(() => {
      const banner = H.banners();
      const low = { id: 'context:session:80', kind: 'context', text: 'Context reached 80%' };
      const high = { id: 'context:session:90', kind: 'context', text: 'Context reached 90%' };
      const emit = (from, to) => H.happenings({ sessions: [], alerts: from }, { sessions: [], alerts: to })
        .filter(e => e.type === 'warning').map(e => e.alert.id);
      banner.update([], [low]);
      banner.el.querySelector('.ban-x').click();
      banner.update([], [low, high]);
      const escalation = banner.el.querySelector('.warning [aria-label]').getAttribute('aria-label');
      banner.update([], []);
      banner.update([], [low]);
      return {
        escalation, rearmed: !!banner.el.querySelector('[data-alert-id="context:session:80"]'),
        first: emit([], [low]), steady: emit([low], [low]), high: emit([low], [low, high]),
      };
    })()`);
    assert.deepEqual(transitions, {
      escalation: 'Dismiss warning: Context reached 90%', rearmed: true,
      first: ['context:session:80'], steady: [], high: ['context:session:90'],
    });
    console.log('pass amber warning order, dismissal after SSE, warning rearm and one announcement per active id');
  }

  async function checkActivity() {
    const result = await evaluate(`(() => {
      const line = H.activityLine();
      const mount = document.createElement('div');
      mount.append(line.el);
      const start = Math.floor(H.now() / 60000) * 60000;
      line.set({ start, perMin: [20] }, { lastMs: 62_000 });
      const path = mount.querySelector('.activity-path');
      const full = path.getAttribute('points');
      const turn = line.el.querySelector('span').textContent;
      H.syncClock(start + 60000);
      H.tickTimers(mount);
      const padded = path.getAttribute('points')?.endsWith('89,16.0');
      H.syncClock(start + 30 * 60000);
      H.tickTimers(mount);
      const aged = !path.getAttribute('points');
      H.syncClock(Date.now());
      return { plotted: full?.endsWith('89,2.0'), turn, padded, aged };
    })()`);
    assert.deepEqual(result, { plotted: true, turn: 'Last turn 1:02', padded: true, aged: true });
    console.log('pass activity view pads missing minutes and ages out output without a state push');
  }

  async function openHud(route) {
    const previous = await evaluate('performance.timeOrigin');
    await call('Page.navigate', { url: hud.base + route });
    await until(`performance.timeOrigin !== ${previous} && document.querySelector('.stream[data-s="live"]') &&
      document.querySelector('.p-plans .plan')`, `${route} renders the live HUD`);
  }
  async function checkProjectFocus() {
    const expression = `(() => {
      const projects = selector => [...new Set([...document.querySelectorAll(selector)].map(el => el.dataset.project))].sort();
      return { sessions: projects('.p-sess .card[data-project], .p-sess .crow[data-project]'),
        plans: projects('.p-plans .plan[data-project]'), feed: projects('.p-tick .tk[data-project]') };
    })()`;
    const focused = { sessions: ['TourCMS'], plans: ['TourCMS'], feed: ['TourCMS'] };
    const clear = () => evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    const dismiss = '.p-sess .focus-clear';
    await openHud('/?view=cards&project=TourCMS');
    assert.deepEqual(await evaluate(expression), focused, 'the URL focuses sessions, plans and feed');
    assert.equal(await evaluate("document.querySelector('.p-sess .ps').textContent"), '1 open', 'session totals are scoped');
    assert.equal(await evaluate("document.querySelector('.p-plans .ps').textContent"), '3', 'plan totals include the focused project’s quiet boards');
    assert.match(await evaluate("document.querySelector('.tk-last').textContent"), /TourCMS · Turn finished/);
    await capture('project-focus', 1440, 900);
    await clear();
    const restored = await evaluate(expression);
    for (const projects of Object.values(restored)) assert.ok(projects.length > 1, 'Escape restores the other projects in each panel');
    assert.equal(await evaluate("new URLSearchParams(location.search).has('project')"), false);

    await click(tour + ' button.plan-p');
    assert.deepEqual(await evaluate(expression), focused, 'a plan label focuses all three panels');
    await click(tour + ' button.plan-p');
    assert.deepEqual(await evaluate(expression), restored, 'the same project label clears focus');
    await click('.p-tick .tk button[data-project="TourCMS"]');
    assert.deepEqual(await evaluate(expression), focused, 'a feed label focuses all three panels');
    await click(dismiss);

    await openHud('/?view=network');
    const arc = '.net .g-lbl[role="button"]';
    await until(`document.querySelector('${arc}')`, 'the demo draws an interactive network group label');
    const arcProject = await evaluate(`document.querySelector('${arc}').dataset.project`);
    await evaluate(`{
      const label = document.querySelector('${arc}');
      label.focus(); label.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }`);
    const networkProjects = "[...new Set([...document.querySelectorAll('.net .na[data-project]:not([inert])')].map(el => el.dataset.project))]";
    assert.deepEqual(await evaluate(networkProjects), [arcProject], 'network project focus filters before drawing');
    assert.equal(await evaluate('document.activeElement.matches(".focus-clear")'), true, 'focus follows a group label removed by the filter');
    await click('.net .hub-label button');
    assert.ok((await evaluate(networkProjects)).length > 1, 'the focused network hub label clears focus');
    for (const [width, height] of SIZES.slice(1)) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
      await openHud('/?view=cards&project=TourCMS');
      assert.deepEqual(await evaluate(expression), focused, `all three panels stay focused at ${width}x${height}`);
      assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'project focus adds no page overflow');
      if (width === 390) {
        await evaluate("document.querySelector('.p-sess').scrollIntoView()");
        await capture('project-focus', width, height);
        await evaluate("document.querySelector('.p-tick').scrollIntoView()");
        await capture('project-feed', width, height);
      }
    }
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    console.log('pass URL, plan, feed and network project focus, scoped counts and Escape restore');
  }

  async function checkWindowLinks() {
    await openHud('/?view=cards&project=FidiaCRM');
    const state = await hud.state();
    const ide = state.sessions.find(s => s.entrypoint === 'claude-vscode' && s.project === 'FidiaCRM');
    const cli = state.sessions.find(s => s.entrypoint === 'cli');
    const href = 'vscode://file/C:/Users/demo/source/repos/Fidia%20CRM';
    function link(session) { return `.card[data-id="${session.id}"] .window-link`; }
    assert.equal(await evaluate(`document.querySelector('${link(ide)}:not([hidden])').getAttribute('href')`), href);
    assert.equal(await evaluate(`document.querySelector('${link(cli)}').hasAttribute('href')`), false);
    await click('.p-sess .seg button:last-child');
    const ideNode = '.net button[aria-label*="R14 quotation screens"]';
    await until(`document.querySelector('${ideNode}')`, 'the network lays out the VS Code session');
    await click(ideNode);
    assert.equal(await evaluate("document.querySelector('.net-pin .window-link:not([hidden])').getAttribute('href')"), href,
      'the pinned network card exposes the same link');
    console.log('pass local VS Code window link encodes a Windows space, including on the pinned card; CLI has no link');
  }

  async function recordAwayFetch() {
    await evaluate(`{
      const realFetch = window.fetch;
      window.awayFetches = [];
      window.awayRequests = 0;
      window.fetch = async (url, ...args) => {
        if (url === '/api/state') window.awayRequests++;
        const res = await realFetch(url, ...args);
        if (url === '/api/state' && res.ok) window.awayFetches.push(await res.clone().json());
        return res;
      };
    }`);
  }
  const summary = '.away-summary:not([hidden])';
  async function checkAwayCounts(since) {
    await until(`document.querySelector('${summary}') && window.awayFetches.length === 1`, 'a fresh snapshot produces one visible summary');
    const actual = await evaluate(`(() => {
      const el = document.querySelector('${summary}');
      return { counts: Object.fromEntries([...el.querySelectorAll('[data-action]')].map(n => [n.dataset.action, Number(n.textContent)])),
        needs: [...el.querySelectorAll('.away-needs li')].map(n => n.textContent), cards: document.querySelectorAll('.app .away-summary').length };
    })()`);
    const snapshotFeed = await evaluate('window.awayFetches[0].feed');
    assert.ok(snapshotFeed.some(f => f.at < since && f.action === 'turn-finished'), 'the snapshot includes a completion before the absence');
    const feed = snapshotFeed.filter(f => f.at >= since);
    const counts = {
      'turn-finished': feed.filter(f => f.kind === 'done' && /^(Turn finished|Codex turn complete)$/.test(f.text)).length,
      'agent-done': feed.filter(f => f.kind === 'done' && f.text.startsWith('Agent done')).length,
      'item-changed': feed.filter(f => f.kind === 'plan' && (f.text.includes(' → ') || f.text.includes(' claimed by '))).length,
      'needs-you': feed.filter(f => f.kind === 'needs-you').length,
    };
    const needs = feed.filter(f => f.kind === 'needs-you').map(f => (f.project ? f.project + ' · ' : '') + f.text);
    assert.ok(Object.values(counts).every(n => n > 0) && feed.some(f => f.kind === 'plan' && !f.action),
      'the demo includes all four categories and a drift mark outside the counts');
    assert.deepEqual(actual, { counts, needs, cards: 1 }, 'the summary counts only the matching demo feed events');
    return counts;
  }
  async function checkAwaySummary() {
    await openHud('/?view=cards');
    await recordAwayFetch();
    const state = await hud.state(), since = state.now - state.uptime - 1000;
    const fetchedBeforeReturn = await evaluate(`(() => {
      const realNow = Date.now;
      const visibility = hidden => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
        document.dispatchEvent(new Event('visibilitychange'));
      };
      visibility(true); visibility(false);   // a short absence makes no request
      const short = window.awayRequests;
      try {
        Date.now = () => ${since}; visibility(true);
        Date.now = () => ${since} + 300001; visibility(false);
      } finally { Date.now = realNow; delete document.hidden; }
      return short;
    })()`);
    assert.equal(fetchedBeforeReturn, 0);
    const counts = await checkAwayCounts(since);
    await capture('away-summary', 1440, 900);
    await click(summary + ' button');
    await pause(1250);
    assert.equal(await evaluate(`document.querySelector('${summary}') === null`), true, 'dismissal persists across a live push');
    console.log('pass hidden-tab away summary and dismissal', counts);

    await openHud('/?view=cards');
    await recordAwayFetch();
    await evaluate(`{ window.realNow = Date.now; Date.now = () => window.realNow() - 301000; }`);
    await hud.stop();
    await until("document.querySelector('.stream[data-s=reconnecting]')", 'the isolated HUD disconnects');
    await evaluate('Date.now = window.realNow');
    const outageSince = Date.now() - 301_000;
    await hud.restart();
    const reconnected = await checkAwayCounts(outageSince);
    assert.ok(await evaluate("document.querySelector('.stream[data-s=live]')"));
    console.log('pass SSE reconnect fetches and summarizes the new snapshot', reconnected);
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
          assert.ok(await evaluate("document.querySelector('.net-pin .activity-chart[aria-label^=Output]')"), 'the network subagent card plots recent output');
          await click('.net-pin button:last-child');
        }
        if (name === 'cards' && width === 1440) {
          await checkWarnings(width, height);
          await checkActivity();
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
        const specimens = await evaluate(`(() => {
          const warnings = [...document.querySelectorAll('.gal-sec .warning')].map(el => el.dataset.kind);
          const section = [...document.querySelectorAll('.gal-sec')].find(el => el.querySelector('h2')?.textContent === 'Session activity');
          const lines = [...section.querySelectorAll('.activity-path')]
            .map(el => (el.getAttribute('points') || '').split(' ').filter(point => point && !point.endsWith(',16.0')).length);
          return { warnings, lines };
        })()`);
        assert.deepEqual(specimens.warnings, ['context', 'context', 'tool', 'subagent', 'usage', 'usage'], `${where} shows every warning`);
        const [empty, steady, burst] = specimens.lines;
        assert.ok(empty === 0 && steady >= 29 && burst === 1, `${where} shows empty, steady and burst activity specimens`);
        assert.ok(await evaluate(`document.querySelector('.gal-sec .away-summary:not([hidden]) .away-needs li') &&
          document.querySelector('.gal-sec .focus-clear[aria-pressed=true]') &&
          document.querySelector('.gal-sec .window-link[href$="Customer%20Tools"]')`), `${where} shows all page extras`);
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
        await evaluate("document.querySelector('.gal-sec .warning').closest('.gal-sec').scrollIntoView()");
        await capture('design-warnings', width, height);
        await evaluate("document.querySelector('.gal-sec .away-summary').closest('.gal-sec').scrollIntoView()");
        await capture('design-page-extras', width, height);
      }
      console.log(`pass ${where}: no runtime exception, no horizontal page scroll`);
    }
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await checkProjectFocus();
  await checkWindowLinks();
  await checkAwaySummary();
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

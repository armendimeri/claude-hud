// Windows browser check: node tests/browser-smoke.mjs
// Starts its own `--demo` HUD on a free port (over temp folders, tests/helpers.mjs), opens /?view=network,
// /?view=cards and /design at 1440x900, 1024x768 and 390x844 in headless Edge with an isolated profile, and fails on
// a runtime exception or a horizontal page scroll. It also exercises Plans, warnings and page extras, with captures in .hud-tmp/.
// HUD_TEST_BROWSER picks another Chromium-based browser. HUD_TEST_SCREENSHOTS overrides the capture directory.
// HUD_TEST_GPU=1 drops --disable-gpu so the cockpit's real scene frame is drawn on the machine's graphics device (the
// renderer Edge chose is printed). HUD_TEST_ONLY=cockpit runs only the cockpit checks.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startHud, pause } from './helpers.mjs';

const SIZES = [[1440, 900], [1024, 768], [390, 844]];
const ROUTES = [['network', '/?view=network'], ['cards', '/?view=cards'], ['design', '/design']];

const dir = process.env.HUD_TEST_SCREENSHOTS ? path.resolve(process.env.HUD_TEST_SCREENSHOTS)
  : fileURLToPath(new URL('../.hud-tmp/', import.meta.url));
await fs.mkdir(dir, { recursive: true });
const hud = await startHud({ demo: true });
const profile = await fs.mkdtemp(path.join(dir, 'edge-profile-'));
const edge = process.env.HUD_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = spawn(edge, ['--headless=new', ...(process.env.HUD_TEST_GPU ? [] : ['--disable-gpu']), '--no-first-run', '--no-default-browser-check',
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
  const pending = new Map(), errors = [], requests = [], heldRequests = { hold: null, list: null, fail: false };
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Network.requestWillBeSent') requests.push({ url: msg.params.request.url, type: msg.params.type });
    if (msg.method === 'Fetch.requestPaused') {
      const { requestId } = msg.params;
      if (heldRequests.fail) void call('Fetch.fulfillRequest', { requestId, responseCode: 404, body: '' }).catch(() => {});
      else if (heldRequests.hold) heldRequests.list.push(requestId);
      else void call('Fetch.continueRequest', { requestId }).catch(() => {});
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && msg.params.entry.url?.includes('/assets/')) {
      const { text, url } = msg.params.entry;
      errors.push(text + ' (' + url + ')');
    }
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
      const { createPlanPanel } = await import('/assets/components/plan-panel.mjs');
      const { createLifetime } = await import('/assets/components/lifetime.mjs');
      const { createDisplayEffects } = await import('/assets/components/animation.mjs');
      const { createTooltip } = await import('/assets/components/tooltip.mjs');
      const { happenings } = await import('/assets/components/notifications.mjs');
      const lifetime = createLifetime();
      const motion = { rm: true };
      const tip = createTooltip(lifetime);
      const { reconcile } = createDisplayEffects(lifetime, motion);
      const preview = createPlanPanel({ lifetime, motion, tip, reconcile, api: {} });
      mount.append(preview.el);
      const item = 'TourCMS|booking-changes#P4';
      const first = { ...st, board: { ...st.board, items: {} } };
      preview.update(first);
      const graphNode = () => mount.querySelector('${p4}');
      const oldNode = graphNode();
      preview.update({ ...first });
      const stable = graphNode() === oldNode;
      const next = { ...st, board: { ...st.board, items: { [item]: st.board.items[item] } } };
      preview.update(next);
      const rebuilt = graphNode() !== oldNode && graphNode().querySelector('.pn-count')?.textContent === '1' &&
        !!graphNode().querySelector('[data-flag="unclaimed"]');
      const events = (previous, next) => happenings(previous, next).filter(e => e.type === 'board-mark').map(e => e.text);
      preview.update({ ...st, plans: [], board: {} });
      const noBoards = !mount.querySelector('.plans-empty').hidden && mount.querySelector('.work-queue').hidden;
      lifetime.close();
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

    const transitions = await evaluate(`(async () => {
      const { createAlertComponents } = await import('/assets/components/alerts.mjs');
      const { createDisplayEffects } = await import('/assets/components/animation.mjs');
      const { createLifetime } = await import('/assets/components/lifetime.mjs');
      const { happenings } = await import('/assets/components/notifications.mjs');
      const { createTiming } = await import('/assets/components/timing.mjs');
      const lifetime = createLifetime();
      const motion = { rm: true };
      const effects = createDisplayEffects(lifetime, motion);
      const banner = createAlertComponents({ motion, effects, timing: createTiming() }).banners();
      const low = { id: 'context:session:80', kind: 'context', text: 'Context reached 80%' };
      const high = { id: 'context:session:90', kind: 'context', text: 'Context reached 90%' };
      const emit = (from, to) => happenings({ sessions: [], alerts: from }, { sessions: [], alerts: to })
        .filter(e => e.type === 'warning').map(e => e.alert.id);
      banner.update([], [low]);
      banner.el.querySelector('.ban-x').click();
      banner.update([], [low, high]);
      const escalation = banner.el.querySelector('.warning [aria-label]').getAttribute('aria-label');
      banner.update([], []);
      const session = { id: 'waiting', status: 'needs-you', project: 'Fixture', needsYou: { since: Date.now(), reason: 'Question' } };
      banner.update([session], [low]);
      banner.el.querySelector('.ban .ban-x').click();
      banner.update([session], [low]);
      const needsDismissed = !banner.el.querySelector('.ban');
      lifetime.close();
      return {
        needsDismissed,
        escalation, rearmed: !!banner.el.querySelector('[data-alert-id="context:session:80"]'),
        first: emit([], [low]), steady: emit([low], [low]), high: emit([low], [low, high]),
      };
    })()`, { awaitPromise: true });
    assert.deepEqual(transitions, {
      needsDismissed: true,
      escalation: 'Dismiss warning: Context reached 90%', rearmed: true,
      first: ['context:session:80'], steady: [], high: ['context:session:90'],
    });
    console.log('pass amber warning order, dismissal after SSE, warning rearm and one announcement per active id');
  }

  async function checkActivity() {
    const result = await evaluate(`(async () => {
      const { createTiming } = await import('/assets/components/timing.mjs');
      let now = Date.now();
      const { activityLine, tickTimers } = createTiming(() => now);
      const line = activityLine();
      const mount = document.createElement('div');
      mount.append(line.el);
      const start = Math.floor(now / 60000) * 60000;
      line.set({ start, perMin: [20] }, { lastMs: 62_000 });
      const path = mount.querySelector('.activity-path');
      const full = path.getAttribute('points');
      const turn = line.el.querySelector('span').textContent;
      now = start + 60000;
      tickTimers(mount);
      const padded = path.getAttribute('points')?.endsWith('89,16.0');
      now = start + 30 * 60000;
      tickTimers(mount);
      return { plotted: full?.endsWith('89,2.0'), turn, padded, aged: !path.getAttribute('points') };
    })()`, { awaitPromise: true });
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

  async function checkStreamAndFeed() {
    const { identifier } = await call('Page.addScriptToEvaluateOnNewDocument', { source: `{
      window.streams = [];
      window.EventSource = class extends EventSource {
        constructor(url) {
          super(url);
          window.streams.push({ source: this, indicator: document.querySelector('.stream').dataset.s });
          // Real state and plans still flow. Use controlled live feed lines for grouping assertions.
          this.addEventListener('event', event => { if (event.isTrusted) event.stopImmediatePropagation(); });
        }
      };
    }` });
    try {
      await openHud('/?view=cards');
    } finally {
      await call('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    }
    assert.deepEqual(await evaluate('window.streams.map(stream => stream.indicator)'), ['connecting']);
    const first = 'Fixture command one', second = 'Fixture command two';
    const firstRow = '.p-tick .tk-list-in .tk:first-child';
    await evaluate(`{
      window.emitFeed = (text, step, kind = 'tool') => {
        const line = { at: window.feedStart + step, kind, sessionId: 'store-smoke', project: 'TourCMS', text };
        window.streams.at(-1).source.dispatchEvent(new MessageEvent('event', { data: JSON.stringify(line) }));
      };
      window.feedStart = Date.now();
      window.emitFeed('Fixture session', 0, 'session');
      window.emitFeed(${JSON.stringify(first)}, 1);
      document.querySelector('.p-tick .tk-list').dispatchEvent(new Event('pointerenter'));
      window.emitFeed(${JSON.stringify(second)}, 2);
      window.emitFeed(${JSON.stringify(second)}, 2);
    }`);
    assert.equal(await evaluate(`document.querySelector('${firstRow} .tk-text').textContent`), first);
    assert.equal(await evaluate("document.querySelector('.p-tick .chip.warn:not([hidden])').textContent"), 'Paused · 1 new');
    await evaluate("document.querySelector('.p-tick .tk-list').dispatchEvent(new Event('pointerleave'))");
    assert.equal(await evaluate(`document.querySelector('${firstRow} .tk-text').textContent`), second);
    assert.equal(await evaluate(`document.querySelector('${firstRow} .tk-n').textContent`), '×2');

    await click('.p-sess .seg button:last-child');
    await click(`${firstRow} button[data-project="TourCMS"]`);
    assert.equal(await evaluate("new URLSearchParams(location.search).get('project')"), 'TourCMS');
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.p-tick .tk-text')].slice(0, 2).map(el => el.textContent)`), [second, first]);
    await click('.p-sess .focus-clear');
    assert.equal(await evaluate('window.streams.length'), 1, 'view and project changes reuse the stream');

    await evaluate("window.streams[0].source.dispatchEvent(new Event('error'))");
    await until("document.querySelector('.stream[data-s=reconnecting]') && document.querySelector('.conn:not([hidden])')", 'an interrupted stream shows Reconnecting');
    await until("document.querySelector('.stream[data-s=down]') && document.querySelector('.conn[data-s=down]:not([hidden])')", 'a prolonged interruption shows Down');
    await click('.conn:not([hidden]) button');
    await until("window.streams.length === 2 && window.streams[0].source.readyState === EventSource.CLOSED && document.querySelector('.stream[data-s=live]')",
      'Retry now closes the old source and connects a new one');
    await until(`[...document.querySelectorAll('.p-tick .tk-text')].filter(el => el.textContent === ${JSON.stringify(second)}).length === 1`,
      'reconnection retains the delivered feed without a duplicate');
    assert.equal(await evaluate("document.querySelector('.conn').hidden"), true);
    console.log('pass one stream across view and project changes, feed deduplication and hover grouping, connection indicators and manual retry');
  }

  async function checkActivityLayouts() {
    const dense = await startHud({ demo: 'dense' });
    try {
      for (const [name, base] of [['activity', hud.base], ['activity-dense', dense.base]]) {
        for (const [width, height] of [SIZES[0], SIZES[2]]) {
          const previous = await evaluate('performance.timeOrigin');
          await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
          await call('Page.navigate', { url: base + '/?view=activity' });
          await until(`performance.timeOrigin !== ${previous} && document.querySelector('.activity-connection[data-status=live]')
            && document.styleSheets.length >= 2 && document.querySelector('.activity-sessions li')`, `${name} renders at ${width}×${height}`);
          const actual = await evaluate(`(() => {
            const column = document.querySelector('.activity-columns');
            return {
              sessions: document.querySelectorAll('.activity-sessions li').length,
              feed: document.querySelectorAll('.activity-feed li').length,
              columns: getComputedStyle(column).gridTemplateColumns.split(' ').length,
              display: getComputedStyle(column).display,
              overflow: document.documentElement.scrollWidth - innerWidth,
              dashboard: Boolean(document.querySelector('.app')),
              work: document.querySelector('.activity-work')?.textContent,
              attention: [...document.querySelectorAll('.activity-page .stag')].some(el => el.textContent === 'Needs you'),
            };
          })()`);
          assert.ok(actual.sessions >= (name === 'activity-dense' ? 12 : 4), 'preview renders the demo sessions');
          assert.ok(actual.feed > 0, 'preview renders the recent feed');
          assert.equal(actual.display, 'grid', 'preview stylesheet loads');
          assert.equal(actual.columns, width < 600 ? 1 : 2, 'preview layout responds to width');
          assert.ok(actual.overflow <= 0, 'preview has no horizontal page overflow');
          assert.equal(actual.dashboard, false, 'only the page outlet mounts');
          if (name === 'activity') {
            assert.match(actual.work, /Booking changes|Implementation|Customer change history/);
            assert.ok(actual.attention, 'demo preview shows attention status');
          }
          await capture(name, width, height);
          console.log(`pass ${name} at ${width}x${height}: ${actual.sessions} sessions, ${actual.feed} recent events, ${actual.columns} columns`);
        }
      }
      await dense.stop();
      await until("document.querySelector('.activity-connection[data-status=reconnecting]')",
        'the Activity preview detects the dense demo server stopping');
      const page = await evaluate(`window.activityBeforeRestart = document.querySelector('.activity-sessions li');
        performance.timeOrigin`);
      await dense.restart();
      await until(`performance.timeOrigin === ${page} && document.querySelector('.activity-connection[data-status=live]')
        && document.querySelector('.activity-sessions li') && !window.activityBeforeRestart.isConnected`,
        'the Activity preview renders a fresh full frame after the dense demo server restarts');
      await evaluate('delete window.activityBeforeRestart');
      console.log('pass Activity reconnects to the real dense demo stream without navigation');
    } finally {
      await dense.close();
    }
  }

  async function openGatedActivity(base, storedView) {
    const previous = await evaluate('performance.timeOrigin');
    const { identifier } = await call('Page.addScriptToEvaluateOnNewDocument', { source: `{
      localStorage.setItem('hud.view', JSON.stringify(${JSON.stringify(storedView)}));
      window.activityStreams = [];
      window.EventSource = class extends EventSource {
        constructor(url) {
          super(url);
          window.activityStreams.push(this);
          this.addEventListener('state', event => {
            if (event.isTrusted) {
              const state = JSON.parse(event.data);
              if (state.full) window.activityFirstState = state;
              event.stopImmediatePropagation();
            }
          });
          for (const type of ['plans', 'event']) {
            this.addEventListener(type, event => { if (event.isTrusted) event.stopImmediatePropagation(); });
          }
        }
      };
      window.activityFrame = (type, value) => window.activityStreams[0].dispatchEvent(
        new MessageEvent(type, { data: JSON.stringify(value) }));
    }` });
    try {
      await call('Page.navigate', { url: base + '/?view=activity' });
      await until(`performance.timeOrigin !== ${previous} && window.activityFirstState`, 'the browser receives a real first full frame');
    } finally {
      await call('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    }
    assert.deepEqual(await evaluate(`({
      text: document.querySelector('.stream').textContent,
      dashboard: Boolean(document.querySelector('.app')),
      preview: Boolean(document.querySelector('.activity-page')),
      streams: window.activityStreams.length,
      connected: window.activityStreams[0].readyState === EventSource.OPEN,
    })`), { text: 'Connecting', dashboard: false, preview: false, streams: 1, connected: true });
  }

  async function checkActivityFrames() {
    await openGatedActivity(hud.base, 'network');
    await evaluate(`{
      const full = window.activityFirstState;
      const project = 'Fixture project';
      const plan = { project, slug: 'fixture', title: 'Fixture plan', phases: [{ id: 'P4', name: 'First item' }] };
      const session = { ...full.sessions[0], id: 'activity-fixture', project, status: 'busy', title: 'Fixture session',
        needsYou: null, work: { plan: project + '|fixture', items: [{ id: 'P4' }] } };
      window.activityFixture = { ...full, sessions: [session], projects: [{ project }], plans: [plan], feed: [] };
      window.activityFrame('state', window.activityFixture);
    }`);
    assert.equal(await evaluate("document.querySelector('.activity-session-head h3').textContent"), 'Fixture session');
    assert.equal(await evaluate("document.querySelector('.activity-work').textContent"), 'P4 · Fixture plan · First item');
    assert.ok(await evaluate("document.querySelector('.activity-feed + p:not([hidden])')"));
    assert.equal(await evaluate("JSON.parse(localStorage.getItem('hud.view'))"), 'network');

    await evaluate(`{
      const { full, plans, feed, ...partial } = window.activityFixture;
      const session = { ...partial.sessions[0], title: 'Updated session', status: 'needs-you', needsYou: { reason: 'Review the changes' } };
      window.activityFrame('state', { ...partial, sessions: [session] });
      const plan = { ...plans[0], phases: [{ id: 'P4', name: 'Updated item' }] };
      window.activityFrame('plans', { plans: [plan] });
      window.activityFrame('event', { kind: 'tool', at: Date.now(), sessionId: session.id,
        project: session.project, text: '<b>Fixture output</b>' });
    }`);
    assert.equal(await evaluate("document.querySelector('.activity-session-head h3').textContent"), 'Updated session');
    assert.equal(await evaluate("document.querySelector('.activity-page .stag').textContent"), 'Needs you');
    assert.equal(await evaluate("document.querySelector('.activity-attention').textContent"), 'Review the changes');
    assert.equal(await evaluate("document.querySelector('.activity-work').textContent"), 'P4 · Fixture plan · Updated item');
    assert.equal(await evaluate("document.querySelector('.activity-feed li p').textContent"), '<b>Fixture output</b>');
    assert.equal(await evaluate("document.querySelector('.activity-feed b') === null"), true, 'feed text stays text');

    await evaluate(`{
      const selector = document.querySelector('#activity-project');
      selector.value = 'Fixture project';
      selector.dispatchEvent(new Event('change', { bubbles: true }));
      window.activityFrame('state', { ...window.activityFixture, sessions: [], projects: [] });
    }`);
    assert.equal(await evaluate("new URL(location.href).searchParams.get('project')"), 'Fixture project');
    assert.equal(await evaluate("document.querySelector('#activity-project').value"), 'Fixture project');
    assert.ok(await evaluate("document.querySelector('.activity-sessions + p:not([hidden])')"));
    assert.equal(await evaluate('window.activityStreams.length'), 1, 'project focus shares the page stream');

    await evaluate("window.activityStreams[0].dispatchEvent(new Event('error'))");
    assert.ok(await evaluate("document.querySelector('.activity-connection[data-status=reconnecting]')"));
    assert.ok(await evaluate("document.querySelector('.activity-retry:not([hidden])')"));
    await evaluate(`{
      window.activityStreams[0].dispatchEvent(new Event('open'));
      window.activityFrame('state', window.activityFixture);
    }`);
    assert.ok(await evaluate("document.querySelector('.activity-connection[data-status=live]')"));
    assert.ok(await evaluate("document.querySelector('.activity-retry[hidden]')"));
    assert.equal(await evaluate("document.querySelector('.activity-session-head h3').textContent"), 'Fixture session');

    const disconnected = await evaluate(`(() => {
      const root = document.querySelector('.activity-page');
      const select = root.querySelector('select');
      const before = root.textContent;
      root.querySelector('.activity-back').click();
      window.activityFrame('state', { ...window.activityFixture, sessions: [] });
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        mounted: root.isConnected,
        frozen: before === root.textContent,
        network: document.querySelector('.p-sess .seg button:last-child').getAttribute('aria-pressed'),
        view: new URL(location.href).searchParams.get('view'),
        project: new URL(location.href).searchParams.get('project'),
        streams: window.activityStreams.length,
        stored: JSON.parse(localStorage.getItem('hud.view')),
      };
    })()`);
    assert.deepEqual(disconnected, { mounted: false, frozen: true, network: 'true',
      view: null, project: 'Fixture project', streams: 1, stored: 'network' },
    'leaving cleans up the view and its listeners while preserving project, preference and stream');
    console.log('pass Activity trace: one stream, first-frame gate, project focus, session/plan/feed updates, disconnect/resume and cleanup on return');
  }

  async function checkMountCycles() {
    await openHud('/?view=cards');
    const result = await evaluate(`(async () => {
      const listenersFor = getEventListeners;
      const { mountHudPage } = await import('/assets/components/page.mjs');
      const { createHudStore } = await import('/assets/data/store.mjs');
      const snapshot = await (await fetch('/api/state')).json();
      dispatchEvent(new PageTransitionEvent('pagehide'));
      const root = document.createElement('div');
      document.body.append(root);
      const resources = { subscriptions: 0, streams: 0 };
      const observers = new Set(), intervals = new Set();
      const NativeObserver = ResizeObserver, startInterval = setInterval, stopInterval = clearInterval;
      const originalUrl = location.href;
      window.ResizeObserver = class extends NativeObserver {
        observe(target) { observers.add(this); super.observe(target); }
        disconnect() { observers.delete(this); super.disconnect(); }
      };
      window.setInterval = (...args) => {
        const id = startInterval(...args);
        intervals.add(id);
        return id;
      };
      window.clearInterval = id => { intervals.delete(id); stopInterval(id); };
      const listenerCounts = () => [
        ...['keydown', 'visibilitychange', 'pointerover', 'focusin'].map(type => listenersFor(document)[type]?.length || 0),
        ...['scroll', 'pagehide'].map(type => listenersFor(window)[type]?.length || 0),
      ];
      const initial = listenerCounts();
      const active = () => ({
        ...resources, observers: observers.size, intervals: intervals.size,
        listeners: listenerCounts().map((count, index) => count - initial[index]),
      });
      const trace = [];
      try {
        for (const view of ['cards', 'network', 'activity', 'cards', 'network', 'activity']) {
          history.replaceState(history.state, '', '/?view=' + view);
          let receiver;
          const transport = {
            connect(handlers) {
              receiver = handlers;
              resources.streams++;
              return () => { resources.streams--; };
            },
            fetchSnapshot: async () => snapshot,
          };
          const base = createHudStore({ transport });
          const listeners = new Set();
          const store = { ...base, subscribe(listener) {
            listeners.add(listener);
            resources.subscriptions = listeners.size;
            const stop = base.subscribe(listener);
            return () => {
              listeners.delete(listener);
              resources.subscriptions = listeners.size;
              stop();
            };
          } };
          const close = mountHudPage(root, { store, transport });
          receiver.open();
          receiver.frame('state', JSON.stringify({ ...snapshot, full: true }));
          const target = view === 'activity' ? '.activity-page' : view === 'network' ? '.net:not([hidden])' : '.p-sess div:not([hidden]) > .cards';
          const before = { ...active(), selected: !!root.querySelector(target) };
          close();
          close();
          receiver.frame('state', JSON.stringify({ ...snapshot, full: true }));
          trace.push({ view, before, after: { ...active(), children: root.children.length } });
        }
        return trace;
      } finally {
        root.remove();
        history.replaceState(history.state, '', originalUrl);
        window.ResizeObserver = NativeObserver;
        window.setInterval = startInterval;
        window.clearInterval = stopInterval;
      }
    })()`, { awaitPromise: true, includeCommandLineAPI: true });
    for (const { view, before, after } of result) {
      const activity = view === 'activity';
      assert.deepEqual(before, {
        subscriptions: 2, streams: 1, observers: activity ? 0 : 4, intervals: activity ? 0 : 1,
        // keydown, visibilitychange, pointerover, focusin, scroll, pagehide. The page itself holds the visibility listener now.
        listeners: activity ? [1, 1, 0, 0, 0, 1] : [1, 1, 1, 1, 1, 1], selected: true,
      }, view + ' has one set of active resources');
      assert.deepEqual(after, {
        subscriptions: 0, streams: 0, observers: 0, intervals: 0, listeners: [0, 0, 0, 0, 0, 0], children: 0,
      }, view + ' released its mounted resources');
    }
    console.log('pass six mount/unmount cycles: one stream, the page-effects subscriber plus one view subscriber and one set of global listeners while mounted');
  }


  async function checkActivityLiveFallback() {
    const live = await startHud();
    try {
      await openGatedActivity(live.base, 'network');
      assert.equal(await evaluate('window.activityFirstState.demo'), false);
      await evaluate("window.activityFrame('state', window.activityFirstState)");
      assert.ok(await evaluate("document.querySelector('.p-sess .seg button:last-child[aria-pressed=true]')"));
      assert.equal(await evaluate("document.querySelector('.activity-page')"), null);
      assert.equal(await evaluate("JSON.parse(localStorage.getItem('hud.view'))"), 'network');

      const previous = await evaluate('performance.timeOrigin');
      await call('Page.navigate', { url: live.base + '/?view=not-registered' });
      await until(`performance.timeOrigin !== ${previous} && document.querySelector('.p-sess .seg button:last-child[aria-pressed=true]')`,
        'an unknown view uses the stored dashboard preference');
      assert.equal(await evaluate("JSON.parse(localStorage.getItem('hud.view'))"), 'network');
      console.log('pass Activity on isolated live HUD and unknown-view fallback with stored Network preference');
    } finally {
      await live.close();
    }
  }

  async function checkKiosk() {
    const { identifier } = await call('Page.addScriptToEvaluateOnNewDocument', { source: `{
      window.kioskWakeRequests = [];
      Object.defineProperty(navigator, 'wakeLock', { value: { request: async kind => {
        window.kioskWakeRequests.push(kind);
        if (window.kioskWakeRequests.length === 1) throw new DOMException('Wake lock refused', 'NotAllowedError');
        return window.kioskLock = { released: false };
      } } });
    }` });
    for (const [width, height] of [[1920, 1080], [390, 844]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
      await openHud('/?kiosk&view=cards');
      await until("document.querySelector('.net-pin:not([hidden]) .card[data-s=needs-you]')", 'kiosk pins the waiting demo session');
      const state = await hud.state();
      const first = state.sessions.filter(x => x.status === 'needs-you').sort((a, b) => a.needsYou.since - b.needsYou.since)[0];
      const actual = await evaluate(`(() => {
        const visible = selector => [...document.querySelectorAll(selector)].some(el => el.getClientRects().length > 0);
        const root = document.documentElement;
        return { kiosk: root.classList.contains('kiosk'), size: parseFloat(getComputedStyle(document.body).fontSize),
          toggles: visible('.top .tgl, .p-sess .seg, .tk-collapse'),
          width: Math.max(root.scrollWidth, document.body.scrollWidth), height: Math.max(root.scrollHeight, document.body.scrollHeight),
          pinned: document.querySelector('.net-pin:not([hidden]) .card').dataset.id };
      })()`);
      assert.equal(actual.kiosk, true);
      assert.ok(actual.size >= 18, 'kiosk body type is at least 18 px');
      assert.equal(actual.toggles, false, 'kiosk hides toggles and the view switch');
      assert.equal(actual.pinned, first.id, 'kiosk chooses the longest-waiting session');
      assert.ok(actual.width <= width, 'kiosk has no horizontal page scroll');
      if (width === 1920) assert.ok(actual.height <= height, 'the TV view fits the screen without page scroll');
      assert.deepEqual(await evaluate('window.kioskWakeRequests'), ['screen'], 'the page loads despite an initial wake-lock refusal');
      await evaluate("document.dispatchEvent(new Event('visibilitychange'))");
      await until('window.kioskLock', 'kiosk requests a wake lock again when visible');
      await evaluate("window.kioskLock.released = true; document.dispatchEvent(new Event('visibilitychange'))");
      assert.deepEqual(await evaluate('window.kioskWakeRequests'), ['screen', 'screen', 'screen']);
      await capture('kiosk', width, height);
      console.log(`pass kiosk at ${width}x${height}: ${actual.size}px body, display controls hidden, waiting session pinned, wake lock best effort`);
    }
    await call('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }


  // ---- operator cockpit P7: route, lazy loading, fallback and navigation ------------------------------------------------
  // Everything below runs against the demo HUD above. `requests` is the CDP network log, cleared per scenario.
  const COCKPIT_ASSETS = /\/assets\/(views\/cockpit|cockpit\/|inspector\/|vendor\/|styles\/cockpit|components\/inspector-slot)|\/api\/operator/;
  const WEBGL_PROBE = `{
    window.__contexts = [];
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const context = getContext.call(this, type, ...rest);
      if (/webgl/.test(String(type)) && context) window.__contexts.push(context);
      else if (/webgl/.test(String(type))) window.__contexts.attempts = (window.__contexts.attempts || 0) + 1;
      return context;
    };
  }`;
  const NO_WEBGL = `{
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      return /webgl/.test(String(type)) ? null : getContext.call(this, type, ...rest);
    };
  }`;
  const demoProject = async () => {
    const state = await hud.state();
    return state.sessions.find(session => session.project && session.status !== 'ended').project;
  };
  const cockpitReady = `document.querySelector('.cockpit .cp-bar .cp-scope') && document.querySelector('.cockpit-scene')`;
  const sceneMode = () => evaluate(`document.querySelector('.cockpit')?.hudScene?.getMode?.() ?? null`);
  async function openFresh(route, { wait = `document.querySelector('.stream[data-s="live"]') && (document.querySelector('.p-plans .plan') || document.querySelector('.cockpit'))` } = {}) {
    const previous = await evaluate('performance.timeOrigin');
    requests.length = 0;
    await call('Page.navigate', { url: hud.base + route });
    await until(`performance.timeOrigin !== ${previous} && ${wait}`, `${route} renders`);
  }
  async function keyPress(key, code, keyCode) {
    for (const type of ['keyDown', 'keyUp']) {
      await call('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
        ...(key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) });
    }
  }
  const streams = () => requests.filter(request => /\/api\/stream/.test(request.url)).length;

  async function checkCockpitColdEntry() {
    const probe = await call('Page.addScriptToEvaluateOnNewDocument', { source: WEBGL_PROBE });
    const rows = [];
    for (const route of ['/?view=cards', '/?view=network', '/', '/?view=activity', '/?kiosk', '/?kiosk&view=cockpit']) {
      await openFresh(route, { wait: route.includes('activity') ? `document.querySelector('.activity-connection[data-status="live"]')`
        : `document.querySelector('.stream[data-s="live"]') && document.querySelector('.p-plans .plan')` });
      await pause(1500);
      const heavy = requests.filter(request => COCKPIT_ASSETS.test(request.url)).map(request => request.url.replace(hud.base, ''));
      const contexts = await evaluate('window.__contexts.length + (window.__contexts.attempts || 0)');
      const bytes = requests.filter(request => request.url.startsWith(hud.base + '/assets/')).length;
      assert.deepEqual(heavy, [], `${route}: a cold entry requests no cockpit, inspector, vendor or private asset`);
      assert.equal(contexts, 0, `${route}: a cold entry creates no WebGL context`);
      assert.equal(streams(), 1, `${route}: a cold entry opens exactly one public stream`);
      assert.equal(await evaluate(`!!document.querySelector('.cockpit')`), false, `${route}: no cockpit on a cold entry`);
      rows.push(`${route} -> ${bytes} local assets, ${heavy.length} cockpit/inspector/vendor/private, 0 WebGL contexts, ${streams()} stream`);
    }
    assert.ok(await evaluate(`!!document.querySelector('.net')`), 'kiosk with view=cockpit shows Network, not the cockpit');
    assert.equal(await evaluate(`!!document.querySelector('.cockpit-open')`), false, 'kiosk has no cockpit entry');
    await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: probe.identifier });
    console.log('pass cold entry (' + rows.join('; ') + ')');
  }

  async function checkCockpitNavigation() {
    const project = await demoProject();
    const encoded = encodeURIComponent(project);
    await openFresh(`/?view=network&project=${encoded}`);
    const length = await evaluate('history.length');
    // A double click is one navigation.
    const immediate = await evaluate(`(() => {
      const button = document.querySelector('.cockpit-open');
      button.click(); button.click();
      // Same task as the click: the loading shell, its list and the exit control are already on screen.
      return { exit: !!document.querySelector('.cockpit.cp-pre .cp-exit'), list: document.querySelectorAll('.cp-pre-row').length,
        status: !!document.querySelector('.cp-pre [role=status]'), dashboard: !!document.querySelector('.app') };
    })()`);
    assert.ok(immediate.exit && immediate.list > 0 && immediate.status && !immediate.dashboard, 'the exit, a status and the session list are mounted synchronously: ' + JSON.stringify(immediate));
    assert.equal(await evaluate('history.length'), length + 1, 'a double click pushes one history entry');
    assert.deepEqual(await evaluate(`({ view: new URL(location.href).searchParams.get('view'), project: new URL(location.href).searchParams.get('project'), state: history.state })`),
      { view: 'cockpit', project, state: { hudEntry: 1 } });
    await until(cockpitReady, 'the cockpit page replaces the loading shell');
    await until(`document.querySelector('.cockpit').hudScene?.getMode() !== 'loading'`, 'the scene settles');
    assert.equal(await evaluate(`document.querySelectorAll('.cockpit').length`), 1);
    assert.equal(await evaluate(`document.activeElement === document.querySelector('.cockpit .cp-title')`), true, 'focus lands on the cockpit heading');

    // Pick another project inside the cockpit, then leave: the originating project returns.
    const other = await evaluate(`[...document.querySelector('.cp-scope').options].map(option => option.value).find(value => value && value !== ${JSON.stringify(project)})`);
    await evaluate(`{ const select = document.querySelector('.cp-scope'); select.value = ${JSON.stringify(other)}; select.dispatchEvent(new Event('change', { bubbles: true })); }`);
    assert.equal(await evaluate(`new URL(location.href).searchParams.get('project')`), other);
    assert.equal(await evaluate('history.length'), length + 1, 'choosing a project replaces rather than pushes');
    await click('.cockpit .cp-exit');
    await until(`document.querySelector('.p-sess .seg button:last-child[aria-pressed=true]') && !document.querySelector('.cockpit')`, 'Exit returns to Network');
    assert.deepEqual(await evaluate(`({ view: new URL(location.href).searchParams.get('view'), project: new URL(location.href).searchParams.get('project'), focus: document.activeElement.matches('[data-cockpit-open]') })`),
      { view: 'network', project, focus: true }, 'Exit restores the originating view and project and focuses the opener');
    assert.equal(await evaluate('history.length'), length + 1, 'Exit is Back: no extra entry');
    await evaluate('history.forward()');
    await until(cockpitReady, 'Forward re-enters the cockpit');
    assert.equal(await evaluate(`new URL(location.href).searchParams.get('project')`), other, 'the cockpit entry keeps the project chosen there');
    await evaluate('history.back()');
    await until(`document.querySelector('.p-sess .seg button:last-child[aria-pressed=true]') && !document.querySelector('.cockpit')`, 'browser Back returns to Network');
    assert.equal(await evaluate(`new URL(location.href).searchParams.get('project')`), project, 'browser Back restores the originating project');
    assert.equal(streams(), 1, 'one stream through enter, exit, forward and back');

    // An explicit view and a stored preference survive the round trip.
    await evaluate(`localStorage.setItem('hud.view', JSON.stringify('network'))`);
    await openFresh('/?view=cards');
    await click('.cockpit-open');
    await until(cockpitReady, 'the cockpit opens from Cards');
    await click('.cockpit .cp-exit');
    await until(`document.querySelector('.p-sess .seg button:first-child[aria-pressed=true]') && !document.querySelector('.cockpit')`, 'Exit returns to Cards');
    assert.deepEqual(await evaluate(`({ view: new URL(location.href).searchParams.get('view'), stored: JSON.parse(localStorage.getItem('hud.view')) })`),
      { view: 'cards', stored: 'network' }, 'explicit ?view=cards and the saved Network preference both survive');

    // A direct link has an explicit way back, with the project kept and no extra history entry.
    await openFresh(`/?view=cockpit&project=${encoded}`, { wait: cockpitReady });
    const direct = await evaluate('history.length');
    assert.equal(await evaluate('history.state?.hudEntry ?? null'), null);
    await click('.cockpit .cp-exit');
    await until(`document.querySelector('.p-sess') && !document.querySelector('.cockpit')`, 'a direct link exits to the dashboard');
    assert.deepEqual(await evaluate(`({ view: new URL(location.href).searchParams.get('view'), project: new URL(location.href).searchParams.get('project'), length: history.length })`),
      { view: null, project, length: direct }, 'a direct entry exits by replacing the URL and keeps the project');

    // Direct refresh of the cockpit URL.
    await openFresh(`/?view=cockpit&project=${encoded}`, { wait: cockpitReady });
    assert.equal(streams(), 1, 'a direct refresh opens one stream');
    console.log('pass cockpit navigation: enter once, project restore, Back/Forward, explicit view and preference, direct link and refresh');
  }

  async function checkCockpitRapidCycles() {
    const probe = await call('Page.addScriptToEvaluateOnNewDocument', { source: WEBGL_PROBE });
    await openFresh('/?view=cards');
    const baseline = await evaluate(`(() => { const get = getEventListeners; return ['keydown', 'visibilitychange', 'popstate', 'pageshow'].map(type => (get(document)[type]?.length || 0) + (get(window)[type]?.length || 0)); })()`, { includeCommandLineAPI: true });
    // One short evaluation per cycle keeps every CDP call far below its timeout on a busy machine.
    for (let i = 0; i < 10; i++) {
      await evaluate(`(async () => {
        const settle = () => new Promise(resolve => setTimeout(resolve, 0));
        document.querySelector('.cockpit-open').click();
        // Leave at once on even rounds, after the page has had a moment on odd rounds.
        if (${i} % 2) await new Promise(resolve => setTimeout(resolve, 120)); else await settle();
        const back = new Promise(resolve => addEventListener('popstate', resolve, { once: true }));
        document.querySelector('.cockpit .cp-exit').click();
        await back;
        await settle();
      })()`, { awaitPromise: true });
    }
    await pause(800);
    const result = await evaluate(`({ cockpits: document.querySelectorAll('.cockpit').length, canvases: document.querySelectorAll('canvas').length,
      live: window.__contexts.filter(context => !context.isContextLost()).length, created: window.__contexts.length,
      entries: history.length, view: new URL(location.href).searchParams.get('view'), dashboard: !!document.querySelector('.p-sess'),
      scenes: document.querySelectorAll('.cockpit-scene').length })`);
    assert.equal(result.cockpits + result.canvases + result.live + result.scenes, 0, 'ten rapid entry/exit cycles leave no cockpit, canvas, scene or live WebGL context: ' + JSON.stringify(result));
    assert.ok(result.dashboard && result.view === 'cards', 'back on the original dashboard URL: ' + JSON.stringify(result));
    assert.ok(result.created <= 10, 'at most one context per cycle: ' + result.created);
    const after = await evaluate(`(() => { const get = getEventListeners; return ['keydown', 'visibilitychange', 'popstate', 'pageshow'].map(type => (get(document)[type]?.length || 0) + (get(window)[type]?.length || 0)); })()`, { includeCommandLineAPI: true });
    assert.deepEqual(after, baseline, 'global listeners return to the dashboard baseline');
    assert.equal(streams(), 1, 'one stream through ten cycles');
    await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: probe.identifier });
    console.log(`pass ten rapid cockpit cycles: ${result.created} contexts created, 0 left, no canvas, one stream, listeners at baseline`);
  }

  // A module request held open and answered after the operator has already left (and come back).
  async function holdRequests(pattern) {
    const held = [];
    heldRequests.hold = pattern;
    heldRequests.list = held;
    await call('Fetch.enable', { patterns: [{ urlPattern: pattern, requestStage: 'Request' }] });
    return {
      held,
      async release() {
        heldRequests.hold = null;
        for (const id of held.splice(0)) await call('Fetch.continueRequest', { requestId: id });
        await call('Fetch.disable');
      },
    };
  }
  async function checkCockpitLateImports() {
    for (const [pattern, label] of [['*/assets/views/cockpit-page.mjs*', 'the cockpit page'], ['*/assets/cockpit/scene.mjs*', 'the scene']]) {
      const probe = await call('Page.addScriptToEvaluateOnNewDocument', { source: WEBGL_PROBE });
      await openFresh('/?view=cards');
      const hold = await holdRequests(pattern);
      await click('.cockpit-open');
      await pause(300);
      await click('.cockpit .cp-exit');
      await until(`!document.querySelector('.cockpit') && document.querySelector('.p-sess')`, 'left before the import resolved');
      await click('.cockpit-open');
      await pause(300);
      assert.ok(hold.held.length >= 1, `${label} request is being held`);
      await hold.release();
      await until(`document.querySelector('.cockpit-scene')`, `the held ${label} resolves`);
      await until(`document.querySelector('.cockpit').hudScene?.getMode() !== 'loading'`, 'the last scene settles');
      assert.equal(await evaluate(`document.querySelectorAll('.cockpit').length`), 1, `enter, leave, enter before ${label} resolves mounts one cockpit`);
      const mode = await sceneMode();
      assert.equal(await evaluate(`document.querySelectorAll('canvas').length`), mode === '3d' ? 1 : 0);
      assert.equal(await evaluate(`window.__contexts.filter(context => !context.isContextLost()).length`), mode === '3d' ? 1 : 0, 'one live context');
      // Leaving while an import is pending also leaves nothing behind.
      await click('.cockpit .cp-exit');
      await until(`!document.querySelector('.cockpit') && document.querySelector('.p-sess')`, 'left');
      await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: probe.identifier });
    }
    await openFresh('/?view=cockpit', { wait: cockpitReady });
    const panel = await holdRequests('*/assets/inspector/panel.mjs*');
    await click('.cp-attn .ban');
    for (let i = 0; i < 100 && !panel.held.length; i++) await pause(50);
    assert.ok(panel.held.length > 0, 'the inspector module is being held');
    await click('.cp-exit');
    await until(`document.querySelector('.p-sess') && !document.querySelector('.cockpit')`, 'left before the inspector loaded');
    await panel.release();
    await click('.cockpit-open');
    await until(cockpitReady, 'cockpit opens again');
    assert.equal(await evaluate(`document.querySelectorAll('.insp').length`), 0, 'the earlier inspector never appears in the new view');
    await click('.cp-attn .ban');
    await until(`document.querySelector('.cp-insp .insp')`, 'a fresh selection opens the inspector');
    assert.deepEqual(requests.filter(request => request.url.includes('/api/operator/')), [], 'the preview makes no private requests even when inspecting');
    console.log('pass late module responses: only the current scene and inspector mounts survive navigation');
  }

  async function checkCockpitFallback() {
    const before = errors.length;
    const exercise = async (name, prepare, expectation) => {
      const cleanup = await prepare();
      await openFresh('/?view=cards');
      await click('.cockpit-open');
      await until(expectation.ready, `${name}: ${expectation.what}`);
      assert.ok(await evaluate(`!!document.querySelector('.cp-exit')`), `${name}: the exit control stays`);
      const rows = await evaluate(`document.querySelectorAll('.cs-row, .cp-pre-row').length`);
      assert.ok(rows > 0, `${name}: the list has rows`);
      const row = await evaluate(`(() => { const r = document.querySelector('.cs-row, .cp-pre-row').getBoundingClientRect(); return r.height; })()`);
      assert.ok(row >= 44, `${name}: rows are at least 44 px tall (${row})`);
      await click(`.cs-row, .cp-pre-row`);
      await until(`document.querySelector('.cp-insp .insp, .insp-host .insp')`, `${name}: selecting a row opens the inspector`);
      await click('.cockpit .cp-exit');
      await until(`!document.querySelector('.cockpit') && document.querySelector('.p-sess')`, `${name}: Exit works`);
      assert.equal(await evaluate(`!!document.querySelector('.insp-host, .cp-insp .insp')`), false, `${name}: leaving closed the inspector`);
      await cleanup?.();
      return rows;
    };
    const failRequests = async patterns => {
      await call('Fetch.enable', { patterns: patterns.map(urlPattern => ({ urlPattern, requestStage: 'Request' })) });
      heldRequests.fail = true;
      return async () => { heldRequests.fail = false; await call('Fetch.disable'); };
    };
    const noGl = await call('Page.addScriptToEvaluateOnNewDocument', { source: NO_WEBGL });
    const a = await exercise('WebGL unavailable', async () => async () => {},
      { ready: `document.querySelector('.cockpit')?.hudScene?.getMode() === 'fallback' && document.querySelector('.cockpit-scene[data-mode="fallback"] .cs-row')`, what: 'the scene shows its list' });
    await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: noGl.identifier });
    const b = await exercise('vendor file missing', () => failRequests(['*/assets/vendor/three/*']),
      { ready: `document.querySelector('.cockpit')?.hudScene?.getMode() === 'fallback' && document.querySelector('.cs-row')`, what: 'the scene shows its list' });
    const c = await exercise('scene module missing', () => failRequests(['*/assets/cockpit/scene.mjs*']),
      { ready: `document.querySelector('.cockpit .cp-scene .cp-pre-row')`, what: 'the page falls back to the plain list' });
    const d = await exercise('cockpit page module missing', () => failRequests(['*/assets/views/cockpit-page.mjs*']),
      { ready: `document.querySelector('.cp-pre[data-phase="failed"] .cp-pre-row')`, what: 'the loading shell stays with its list' });
    errors.length = before;
    console.log(`pass fallback: no WebGL (${a} rows), vendor missing (${b}), scene missing (${c}), page missing (${d}); list, inspector and exit work in each`);
  }


  async function checkCockpitNarrow() {
    const probe = await call('Page.addScriptToEvaluateOnNewDocument', { source: WEBGL_PROBE });
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await openFresh('/?view=cards');
    requests.length = 0;
    await click('.cockpit-open');
    await until(cockpitReady, 'the cockpit opens at 390 px');
    await until(`document.querySelector('.cockpit').hudScene?.getMode() === 'fallback'`, 'narrow widths mount the list');
    await pause(500);
    assert.deepEqual(requests.filter(request => /\/vendor\/|three/.test(request.url)).map(request => request.url), [], 'a narrow cockpit never downloads Three.js');
    assert.equal(await evaluate('window.__contexts.length + (window.__contexts.attempts || 0)'), 0, 'a narrow cockpit never asks for a WebGL context');
    const layout = await evaluate(`(() => {
      const visible = selector => { const el = document.querySelector(selector); return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'; };
      const row = document.querySelector('.cs-row').getBoundingClientRect();
      return { status: visible('.cs-status'), retry: visible('.cs-btn'), list: visible('.cs-list'), note: document.querySelector('.cp-narrow-note')?.textContent,
        row: row.height, exit: document.querySelector('.cp-exit').getBoundingClientRect().height,
        scroll: document.documentElement.scrollWidth - innerWidth, narrow: document.querySelector('.cockpit').dataset.narrow };
    })()`);
    assert.deepEqual({ ...layout, row: undefined, exit: undefined }, { status: false, retry: false, list: true, note: 'List view at this width', row: undefined, exit: undefined, scroll: 0, narrow: 'true' });
    assert.ok(layout.row >= 44 && layout.exit >= 44, `list rows and the exit control are at least 44 px (${layout.row}, ${layout.exit})`);
    await capture('cockpit-narrow-list', 390, 844);
    await click('.cs-row');
    await until(`document.querySelector('.cp-main[data-insp="sheet"] .insp[data-mode="sheet"] .insp-back')`, 'the inspector opens as a sheet');
    const sheet = await evaluate(`(() => { const back = document.querySelector('.insp-back').getBoundingClientRect(); const sheet = document.querySelector('.cp-insp').getBoundingClientRect();
      return { back: back.height, width: sheet.width, scroll: document.documentElement.scrollWidth - innerWidth, vw: innerWidth }; })()`);
    assert.ok(sheet.back >= 44 && sheet.width >= sheet.vw - 28, `the sheet spans the width and Back to map is a 44 px target (${JSON.stringify(sheet)})`);
    assert.equal(sheet.scroll, 0);
    await capture('cockpit-narrow-sheet', 390, 844);
    await click('.insp-back');
    await until(`!document.querySelector('.cp-insp .insp')`, 'Back to map closes the sheet');
    assert.equal(await evaluate(`document.activeElement?.classList.contains('cs-list')`), true, 'focus returns to the list');
    // Widening tries WebGL for the first time, with the list still available on a GPU-less browser.
    await call('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    await until(`document.querySelector('.cockpit').dataset.narrow === 'false' &&
      (window.__contexts.length || window.__contexts.attempts) && document.querySelector('.cockpit').hudScene?.getMode() !== 'loading'`,
    'widening attempts WebGL and the scene settles');
    const wideMode = await sceneMode();
    assert.ok(wideMode === '3d' || wideMode === 'fallback' && await evaluate(`!!document.querySelector('.cs-row')`),
      'the wide view has a scene or a usable fallback');
    assert.ok(requests.some(request => /three\.module/.test(request.url)), 'Three.js is requested once the viewport is wide');
    await click('.cockpit .cp-exit');
    await until(`!document.querySelector('.cockpit')`, 'exit');
    await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: probe.identifier });
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    console.log(`pass narrow cockpit: list-only (no Three.js, no WebGL), 44 px rows, sheet with Back to map, ${wideMode} after widening`);
  }

  async function checkCockpitEscapeAndFocus() {
    const project = await demoProject();
    const encoded = encodeURIComponent(project);
    // Dashboard: the inspector takes Escape first; the project follows.
    await openFresh(`/?view=cards&project=${encoded}`);
    await evaluate(`document.querySelector('.card .inspect-btn').focus()`);
    await keyPress('Enter', 'Enter', 13);
    await until(`document.querySelector('.insp-host .insp')`, 'Enter on Inspect opens the inspector');
    assert.equal(await evaluate(`document.activeElement === document.querySelector('.insp-title')`), true, 'focus moves to the inspector heading');
    await keyPress('Escape', 'Escape', 27);
    await until(`!document.querySelector('.insp-host')`, 'Escape closes the inspector');
    assert.equal(await evaluate(`new URL(location.href).searchParams.get('project')`), project, 'the first Escape does not clear the project');
    assert.equal(await evaluate(`document.activeElement?.classList.contains('inspect-btn')`), true, 'focus returns to the Inspect control');
    await keyPress('Escape', 'Escape', 27);
    await until(`new URL(location.href).searchParams.get('project') === null`, 'a second Escape clears the project');

    // Cockpit: inspector, then drawer, then project.
    await openFresh(`/?view=cockpit&project=${encoded}`, { wait: cockpitReady });
    await until(`document.querySelector('.cockpit').hudScene?.getMode() !== 'loading'`, 'scene settles');
    await click('[data-drawer=plans]');
    await until(`!document.querySelector('.cp-drawer').hidden`, 'the Plans drawer opens');
    await evaluate(`document.querySelector('.cp-attn .ban').focus()`);
    await keyPress('Enter', 'Enter', 13);
    await until(`document.querySelector('.cp-insp .insp')`, 'the attention row opens the inspector');
    assert.equal(await evaluate(`document.querySelector('.cp-main').dataset.insp !== 'none'`), true);
    await keyPress('Escape', 'Escape', 27);
    await until(`!document.querySelector('.cp-insp .insp')`, 'Escape closes the inspector first');
    assert.equal(await evaluate(`!document.querySelector('.cp-drawer').hidden`), true, 'the drawer is still open');
    assert.equal(await evaluate(`new URL(location.href).searchParams.get('project')`), project);
    assert.equal(await evaluate(`document.activeElement?.classList.contains('ban')`), true, 'focus returns to the attention row that opened the inspector');
    await keyPress('Escape', 'Escape', 27);
    await until(`document.querySelector('.cp-drawer').hidden`, 'the second Escape closes the drawer');
    assert.equal(await evaluate(`new URL(location.href).searchParams.get('project')`), project, 'closing the drawer keeps the project');
    assert.equal(await evaluate(`document.activeElement === document.querySelector('[data-drawer=plans]')`), true, 'focus returns to the drawer button');
    await keyPress('Escape', 'Escape', 27);
    await until(`new URL(location.href).searchParams.get('project') === null`, 'the third Escape clears the project');
    await click('.cs-row[data-kind="session"]');
    await until(`document.querySelector('.cp-insp .insp[data-entity-key]')`, 'a scene row opens the inspector');
    const first = await evaluate(`document.querySelector('.cp-insp .insp').dataset.entityKey`);
    await click('.cs-row[data-kind="session"][aria-selected="false"]');
    await until(`document.querySelector('.cp-insp .insp')?.dataset.entityKey && document.querySelector('.cp-insp .insp').dataset.entityKey !== ${JSON.stringify(first)}`,
      'selecting another session keeps the inspector mounted and updates its identity');
    assert.equal(await evaluate(`document.querySelectorAll('.cp-insp .insp').length`), 1);
    console.log('pass Escape order and focus return: inspector, then drawer, then project, in Cards and in the cockpit');
  }

  async function checkCockpitDiscreet() {
    const state = await hud.state();
    const secrets = new Set();
    for (const session of state.sessions) {
      for (const value of [session.project, session.title, session.name, session.branch, session.needsYou?.reason, session.cwd]) if (value && value.length >= 5) secrets.add(value);
      for (const agent of session.subagents || []) for (const value of [agent.description, agent.type]) if (value && value.length >= 5) secrets.add(value);
    }
    for (const alert of state.alerts || []) if (alert.text) secrets.add(alert.text);
    for (const line of state.feed || []) if (line.text && line.text.length >= 8) secrets.add(line.text);
    assert.ok(secrets.size > 10, 'the demo gives enough identifying strings to scan for');
    const project = await demoProject();
    const encoded = encodeURIComponent(project);
    const scan = `(() => {
      const secrets = ${JSON.stringify([...secrets])};
      const pieces = [document.title, location.href];
      for (const el of document.querySelectorAll('.cockpit, .cockpit *, .masked, .masked *, .insp-host, .insp-host *')) {
        pieces.push(el.textContent && el.children.length === 0 ? el.textContent : '');
        for (const attribute of el.attributes) if (!['class', 'style', 'id', 'for', 'role', 'type'].includes(attribute.name)) pieces.push(attribute.value);
      }
      const text = pieces.join('\\n');
      return secrets.filter(secret => text.includes(secret));
    })()`;
    const normal = await (async () => {
      await openFresh(`/?view=cockpit&project=${encoded}`, { wait: cockpitReady });
      await until(`document.querySelector('.cockpit').hudScene?.getMode() !== 'loading'`, 'scene settles');
      return (await evaluate(scan)).length;
    })();
    assert.ok(normal > 3, 'control: the normal display does contain identifying strings (' + normal + ')');

    await click('.cp-attn .ban');
    await until(`document.querySelector('.cp-insp .insp')`, 'inspector opens before discreet');
    await click('.cp-discreet');
    await until(`!document.querySelector('.cp-insp .insp') && document.querySelector('.cockpit').dataset.discreet === 'on'`, 'discreet closes the inspector');
    assert.equal(await evaluate(`document.querySelector('.cp-discreet').getAttribute('aria-pressed')`), 'true');
    assert.deepEqual(await evaluate(`({ project: new URL(location.href).searchParams.get('project'), stored: sessionStorage.getItem('hud.discreet') })`),
      { project: null, stored: '1' }, 'the URL hides the project and the flag is tab-scoped');
    await pause(500);
    assert.deepEqual(await evaluate(scan), [], 'discreet: no identifying text, attribute, title or URL in the cockpit');
    await click('[data-drawer=vitals]');
    await until(`document.querySelector('.cp-drawer[aria-label="Vitals"]:not([hidden]) .vitals, .cp-drawer:not([hidden]) .vitals')`, 'the vitals drawer opens while discreet');
    assert.deepEqual(await evaluate(scan), [], 'discreet vitals drawer shows no names');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-drawer=plans]')).display`), 'none', 'Plans is not offered while discreet');
    await capture('cockpit-discreet', 1440, 900);
    // New events keep arriving while discreet: scan again after the demo has moved.
    await pause(4000);
    assert.deepEqual(await evaluate(scan), [], 'discreet: later updates do not reintroduce names');
    assert.equal(await evaluate(`document.querySelector('.cp-attn-d') ? document.querySelector('.cp-attn-d').textContent.length > 0 : true`), true);

    // Exit while discreet asks first.
    await click('.cockpit .cp-exit');
    await until(`!document.querySelector('.cp-exit-sheet').hidden`, 'Exit asks while discreet');
    assert.equal(await evaluate(`document.activeElement.textContent`), 'Stay discreet');
    await keyPress('Escape', 'Escape', 27);
    await until(`document.querySelector('.cp-exit-sheet').hidden`, 'Escape closes the exit sheet');
    assert.ok(await evaluate(`document.querySelector('.cockpit .cp-exit') === document.activeElement && new URL(location.href).searchParams.get('project') === null`), 'Escape kept the cockpit and the project stayed hidden');
    await click('.cockpit .cp-exit');
    await click('.cp-exit-sheet .btn:last-child');
    assert.ok(await evaluate(`document.querySelector('.cp-exit-sheet').hidden && !!document.querySelector('.cockpit')`), 'Stay discreet stays');
    await click('.cockpit .cp-exit');
    await click('.cp-exit-sheet .btn:first-child');
    await until(`!document.querySelector('.cockpit') && document.querySelector('.p-sess')`, 'reveal returns to the dashboard');
    assert.deepEqual(await evaluate(`({ stored: sessionStorage.getItem('hud.discreet'), project: new URL(location.href).searchParams.get('project') })`), { stored: null, project },
      'revealing clears the flag and restores the project');

    // Back from a discreet cockpit lands on a masked shell before any dashboard DOM exists.
    await openFresh(`/?view=cards&project=${encoded}`);
    await click('.cockpit-open');
    await until(cockpitReady, 'cockpit from the dashboard');
    await evaluate(`(() => {
      const scope = document.querySelector('.cp-scope');
      scope.value = '';
      scope.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await click('.cp-discreet');
    await evaluate('history.back()');
    await until(`document.querySelector('.masked')`, 'Back while discreet shows the masked shell');
    assert.equal(await evaluate(`!!document.querySelector('.app') || !!document.querySelector('.card')`), false, 'no dashboard DOM behind the masked shell');
    assert.deepEqual(await evaluate(scan), [], 'the masked shell shows no names');
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.masked .btn')].map(button => button.textContent)`), ['Return to dashboard and reveal details', 'Stay discreet']);
    await click('.masked .btn:last-child');
    await until(`document.querySelector('.cockpit')?.dataset.discreet === 'on'`, 'Stay discreet opens the cockpit');
    await evaluate('history.back()');
    await until(`document.querySelector('.masked')`, 'masked again');
    await click('.masked .btn:first-child');
    await until(`document.querySelector('.p-sess .card, .p-sess .crow') && !document.querySelector('.masked')`, 'reveal shows the dashboard');
    assert.equal(await evaluate(`new URL(location.href).searchParams.get('project')`), project, 'reveal restores the originating dashboard project');

    // A masked reload ignores the identifying query parameter before first paint.
    await openFresh(`/?view=cards&project=${encoded}`);
    await click('.cockpit-open');
    await until(cockpitReady, 'cockpit again');
    await click('.cp-discreet');
    const loading = await holdRequests('*/assets/views/cockpit-page.mjs*');
    await openFresh(`/?view=cockpit&project=${encoded}`, { wait: `document.querySelector('.cp-pre .cp-pre-row')` });
    assert.ok(loading.held.length > 0, 'the page module is held while checking the initial list');
    assert.deepEqual(await evaluate(`({ discreet: document.querySelector('.cp-pre').dataset.discreet, project: new URL(location.href).searchParams.get('project') })`), { discreet: 'on', project: null });
    assert.deepEqual(await evaluate(scan), [], 'a masked reload shows no names even while the cockpit module is still loading');
    await click('.cp-pre-row');
    assert.equal(await evaluate(`!!document.querySelector('.insp-host')`), false, 'the masked list cannot open the inspector');
    await loading.release();
    await until(cockpitReady, 'the discreet cockpit opens after the import');
    assert.deepEqual(await evaluate(scan), [], 'the loaded discreet cockpit shows no names');
    await click('.cp-discreet');
    await evaluate(`sessionStorage.removeItem('hud.discreet')`);

    // Speech and notifications: nothing identifying leaves the page while discreet.
    const outputs = await evaluate(`(async () => {
      const { createNotifications } = await import('/assets/components/notifications.mjs');
      const { createLifetime } = await import('/assets/components/lifetime.mjs');
      localStorage.setItem('hud.voice', 'true'); localStorage.setItem('hud.notify', 'true');
      const spoken = [], shown = [];
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speaking: false, speak: u => spoken.push(u.text), cancel() { spoken.push('[cancel]'); }, getVoices: () => [], addEventListener() {} } });
      Object.defineProperty(window, 'Notification', { configurable: true, value: class { static permission = 'granted'; constructor(title, options) { shown.push(title + ' ' + options.body); } } });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      let discreet = false;
      const lifetime = createLifetime();
      const notifications = createNotifications(lifetime, { discreet: () => discreet });
      const event = { type: 'needs-you', x: { id: 's1', project: 'SecretProject', title: 'Secret title', needsYou: { reason: 'Permission: Bash' } } };
      const snapshot = { totals: { agentsRunning: 1 } };
      notifications.announce([event], snapshot);
      const normal = { spoken: spoken.splice(0), shown: shown.splice(0) };
      discreet = true;
      notifications.silence();
      notifications.announce([event, { type: 'warning', alert: { id: 'a', project: 'SecretProject', text: 'Context reached 80%' } }], snapshot);
      const hidden = { spoken: spoken.splice(0), shown: shown.splice(0) };
      lifetime.close();
      delete document.hidden;
      localStorage.removeItem('hud.voice'); localStorage.removeItem('hud.notify');
      return { normal, hidden };
    })()`, { awaitPromise: true });
    assert.deepEqual(outputs.normal.spoken, ['SecretProject needs you']);
    assert.equal(outputs.normal.shown.length, 1);
    assert.ok(/SecretProject/.test(outputs.normal.shown[0]), 'control: the normal notification names the project');
    assert.deepEqual(outputs.hidden.shown, [], 'discreet: no browser notification');
    assert.ok(!outputs.hidden.spoken.some(text => /Secret|Context|Bash/.test(text)), 'discreet: speech names nothing: ' + JSON.stringify(outputs.hidden.spoken));
    console.log('pass discreet display: no identifying text in cockpit, drawer, masked shell, URL or title; exit choices; masked Back and reload; no names spoken or notified');
  }


  // ---- the same frozen snapshot in the dashboard and in the cockpit -----------------------------------------------------
  // The page is mounted in-page over a fake transport that replays one /api/state snapshot, so both surfaces read
  // identical data and nothing moves under the comparison.
  const MOUNT_FROZEN = (view, prelude = '') => `(async () => {
    ${prelude}
    const { mountHudPage } = await import('/assets/components/page.mjs');
    const { createHudStore } = await import('/assets/data/store.mjs');
    dispatchEvent(new PageTransitionEvent('pagehide'));
    document.body.replaceChildren();
    const snapshot = window.__snapshot ||= await (await fetch('/api/state')).json();
    history.replaceState(null, '', '/?view=${view}');
    let receiver;
    const transport = { connect(handlers) { receiver = handlers; return () => {}; }, fetchSnapshot: async () => snapshot };
    const store = createHudStore({ transport });
    const close = mountHudPage(document.body, { store, transport });
    receiver.open();
    receiver.frame('state', JSON.stringify({ ...snapshot, full: true }));
    window.__frozen = { receiver, close, snapshot, frame: next => receiver.frame('state', JSON.stringify({ ...next, full: true })) };
    return true;
  })()`;
  const DASHBOARD_FACTS = `(() => {
    const text = (root, selector) => root.querySelector(selector)?.textContent ?? null;
    const sessions = [...document.querySelectorAll('.p-sess .card, .p-sess .crow')];
    return {
      needs: [...document.querySelectorAll('.banners .ban')].map(row => text(row, '.ban-p') + '|' + text(row, '.ban-rl')),
      warnings: [...document.querySelectorAll('.warnings .warning-text')].map(el => el.textContent),
      summary: document.querySelector('.p-sess .ps')?.textContent ?? null,
      titles: sessions.map(el => text(el, '.card-title, .cr-t')).sort(),
      queue: [...document.querySelectorAll('.p-plans .wq-count')].map(el => el.querySelector('.label').textContent + ' ' + el.querySelector('b').textContent),
      lastDone: text(document, '.tk-last .trunc'),
      lastFeed: text(document, '.tk-list-in li .tk-text'),
      subagents: document.querySelectorAll('.p-sess .sub[data-s="running"]').length,
      connection: !document.querySelector('.conn')?.hidden,
    };
  })()`;
  const COCKPIT_FACTS = `(() => {
    const text = (root, selector) => root.querySelector(selector)?.textContent ?? null;
    return {
      needs: [...document.querySelectorAll('.cp-attn .ban')].map(row => text(row, '.ban-p') + '|' + text(row, '.ban-rl')),
      warnings: [...document.querySelectorAll('.cp-attn .warning-text')].map(el => el.textContent),
      counts: Object.fromEntries([...document.querySelectorAll('.cp-count')].map(el => [el.dataset.k, Number(el.querySelector('b').textContent)])),
      titles: [...document.querySelectorAll('.cs-row[data-s]:not([data-kind="sub"]) .cs-row-title')].map(el => el.textContent).sort(),
      lastDone: text(document, '.cp-last-text'),
      connection: !document.querySelector('.cp-recon')?.hidden,
    };
  })()`;

  async function checkCockpitCoverage() {
    const rows = [];
    const frozen = JSON.stringify(await hud.state());
    for (const [width, height] of SIZES) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
      await openFresh('/?view=cards');
      await evaluate(MOUNT_FROZEN('cards', `window.__snapshot = ${frozen};`), { awaitPromise: true });
      await until(`document.querySelector('.p-sess .card, .p-sess .crow')`, 'the dashboard renders the frozen snapshot');
      await pause(1700);
      const dash = await evaluate(DASHBOARD_FACTS);
      await capture('coverage-dashboard', width, height);
      // Inspect the waiting session from its card, to compare its vitals with the cockpit inspector.
      const waitingId = await evaluate(`window.__frozen.snapshot.sessions.filter(s => s.status === 'needs-you').sort((a, b) => a.needsYou.since - b.needsYou.since)[0]?.id`);
      const cardVitals = await evaluate(`(() => { const id = ${JSON.stringify(waitingId)}; const card = [...document.querySelectorAll('.card, .crow')].find(el => el.dataset.id === id);
        return card ? { ctx: card.querySelector('.m-ctx .mv')?.textContent ?? null, tok: card.querySelector('.m-tok .mv')?.textContent ?? null } : null; })()`);
      await click('.cockpit-open');
      await until(cockpitReady, 'the cockpit renders the frozen snapshot');
      await until(`document.querySelector('.cockpit').hudScene?.getMode() !== 'loading'`, 'scene settles');
      await pause(300);
      const cockpit = await evaluate(COCKPIT_FACTS);
      const [open, busy, needs] = (dash.summary.match(/(\d+) open(?: · (\d+) busy)?(?: · (\d+) need)?/) || []).slice(1).map(n => Number(n || 0));
      assert.deepEqual(cockpit.needs, dash.needs, `${width}px: the attention row names the same waiting sessions and reasons as the dashboard banner`);
      assert.deepEqual(cockpit.warnings, dash.warnings, `${width}px: the same warnings`);
      assert.deepEqual([cockpit.counts.sessions, cockpit.counts.working, cockpit.counts.needs], [open, busy, needs], `${width}px: the counts match the dashboard summary (${dash.summary})`);
      assert.equal(cockpit.counts.agents, dash.subagents, `${width}px: running subagents match`);
      assert.deepEqual(cockpit.titles, dash.titles, `${width}px: the same live sessions, distinct by position even with equal titles`);
      assert.equal(cockpit.lastDone, dash.lastDone === 'Nothing has finished yet' ? 'Nothing has finished yet' : dash.lastDone, `${width}px: the last completion matches`);
      // Inspector header from the attention row against the card.
      await click('.cp-attn .ban');
      await until(`document.querySelector('.cp-insp .insp-vitals')`, 'inspector header');
      const vitals = await evaluate(`document.querySelector('.cp-insp .insp-vitals').textContent`);
      if (cardVitals?.ctx) assert.ok(vitals.includes('Context ' + cardVitals.ctx) && vitals.includes('Tokens ' + cardVitals.tok), `${width}px: inspector vitals (${vitals}) match the card (${JSON.stringify(cardVitals)})`);
      assert.ok(await evaluate(`document.querySelector('.cp-insp .insp-now')?.textContent.includes(window.__frozen.snapshot.sessions.find(s => s.id === ${JSON.stringify(waitingId)}).needsYou.reason)`), `${width}px: the inspector shows the question reason`);
      await capture('coverage-cockpit-inspector', width, height);
      await keyPress('Escape', 'Escape', 27);
      // Plans and the work queue.
      await click('[data-drawer=plans]');
      await until(`document.querySelector('.cp-drawer .wq-count')`, 'plans drawer');
      const queue = await evaluate(`[...document.querySelectorAll('.cp-drawer .wq-count')].map(el => el.querySelector('.label').textContent + ' ' + el.querySelector('b').textContent)`);
      assert.deepEqual(queue, dash.queue, `${width}px: the plan queue counts match the dashboard`);
      await capture('coverage-cockpit-plans', width, height);
      await keyPress('Escape', 'Escape', 27);
      // Recent activity: the newest event.
      await click('[data-drawer=feed]');
      await until(`document.querySelector('.cp-feed-row')`, 'feed drawer');
      const lastFeed = await evaluate(`document.querySelector('.cp-feed-t').textContent`);
      assert.equal(lastFeed, dash.lastFeed, `${width}px: the newest event matches the dashboard feed`);
      await keyPress('Escape', 'Escape', 27);
      // Vitals drawer.
      await click('[data-drawer=vitals]');
      await until(`document.querySelector('.cp-drawer .vitals')`, 'vitals drawer');
      await capture('coverage-cockpit-vitals', width, height);
      await keyPress('Escape', 'Escape', 27);
      await capture('coverage-cockpit', width, height);
      // Connection: last-known state and an explicit reconnect state, in both surfaces.
      await evaluate(`window.__frozen.receiver.error(false)`);
      await until(`document.querySelector('.cockpit')?.dataset.connection === 'reconnecting'`, 'the cockpit shows the dropped stream');
      const dropped = await evaluate(`({ text: document.querySelector('.cp-recon').textContent, scene: document.querySelector('.cockpit-scene')?.dataset.connection, titles: document.querySelectorAll('.cs-row').length })`);
      assert.match(dropped.text, /Reconnecting.*last update \d+s ago.*showing last known state.*live actions paused/, `${width}px: ${dropped.text}`);
      assert.equal(dropped.scene, 'reconnecting');
      assert.ok(dropped.titles > 0, 'the last known sessions stay on screen');
      await capture('coverage-cockpit-reconnecting', width, height);
      await evaluate(`{ window.__frozen.receiver.open(); window.__frozen.frame(window.__frozen.snapshot); }`);
      await until(`document.querySelector('.cockpit')?.dataset.connection === 'live'`, 'the cockpit returns to live');
      await click('.cockpit .cp-exit');
      await until(`document.querySelector('.p-sess') && !document.querySelector('.cockpit')`, 'back on the dashboard');
      rows.push(`${width}px: ${dash.needs.length} waiting, ${dash.titles.length} sessions, queue ${queue.join('/')}`);
    }
    console.log('pass coverage against one frozen snapshot (' + rows.join('; ') + ')');
  }

  async function checkCockpitPageEffects() {
    await openFresh('/?view=cards');
    await evaluate(MOUNT_FROZEN('cards', `
      window.__shown = [];
      localStorage.setItem('hud.notify', 'true');
      Object.defineProperty(window, 'Notification', { configurable: true, value: class { static permission = 'granted'; constructor(title, options) { window.__shown.push(title + ' | ' + options.body); } } });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    `), { awaitPromise: true });
    await until(`document.querySelector('.p-sess .card, .p-sess .crow')`, 'the dashboard renders');
    // Frame n has the first n live sessions waiting, with fixed timestamps: only a real new request is an event.
    const frame = waiting => evaluate(`(() => {
      const base = window.__frozen.snapshot, s = structuredClone(base);
      s.now = base.now + (window.__tick = (window.__tick || 0) + 1) * 1000;
      s.alerts = [];
      let n = 0;
      for (const x of s.sessions) {
        if (x.status === 'ended') continue;
        if (n < ${waiting}) { x.status = 'needs-you'; x.needsYou = { since: base.now + n, reason: 'Permission: Bash', kind: 'permission' }; n++; }
        else if (x.status === 'needs-you') { x.status = 'busy'; x.needsYou = null; }
      }
      window.__frozen.frame(s);
      return window.__shown.length;
    })()`);
    assert.equal(await frame(0), 0, 'reseeding and clearing requests announces nothing');
    assert.equal(await frame(1), 1, 'one new request, one notification');
    await click('.cockpit-open');
    await until(cockpitReady, 'the cockpit opens');
    assert.equal(await frame(1), 1, 'entering the cockpit does not repeat the notification');
    assert.equal(await frame(2), 2, 'a request that arrives inside the cockpit is announced once');
    await click('.cockpit .cp-exit');
    await until(`document.querySelector('.p-sess') && !document.querySelector('.cockpit')`, 'back on the dashboard');
    assert.equal(await frame(2), 2, 'returning to the dashboard does not repeat it');
    await click('.cockpit-open');
    await until(cockpitReady, 'the cockpit opens again');
    await click('.cp-discreet');
    assert.equal(await frame(3), 2, 'while discreet a new request raises no system notification');
    const shown = await evaluate('window.__shown');
    assert.ok(shown.every(text => /needs you/.test(text)), 'the notifications that were shown are the needs-you ones: ' + JSON.stringify(shown));
    await click('.cp-discreet');
    await evaluate(`delete document.hidden; localStorage.removeItem('hud.notify')`);
    // Away summary: delivered once, to the first view that listens.
    const delivery = await evaluate(`(async () => {
      const { createPageEffects } = await import('/assets/components/page-effects.mjs');
      const { createLifetime } = await import('/assets/components/lifetime.mjs');
      const { createDiscreet } = await import('/assets/components/discreet.mjs');
      const listeners = new Set();
      const store = { subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, getSnapshot: () => null };
      const feed = [{ at: Date.now(), kind: 'done', action: 'turn-finished', text: 'x', project: 'p' }];
      const transport = { fetchSnapshot: async () => ({ now: Date.now(), feed }) };
      const lifetime = createLifetime();
      const effects = createPageEffects({ store, transport, lifetime, discreet: createDiscreet({ storage: null }) });
      listeners.forEach(fn => fn({ type: 'connection', resumedSince: Date.now() - 10 * 60_000 }));
      await new Promise(resolve => setTimeout(resolve, 100));
      const log = [];
      const stopA = effects.onAway(() => log.push('first view'));
      const stopB = effects.onAway(() => log.push('second view'));
      stopA(); stopB(); lifetime.close();
      return log;
    })()`, { awaitPromise: true });
    assert.deepEqual(delivery, ['first view'], 'a summary that arrives with no view listening is delivered once, to the first view');
    console.log('pass page effects: one notification per request across Cards, cockpit and back; none while discreet; the away summary is delivered once');
  }


  async function checkCockpitSceneFrame() {
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await openFresh('/?view=cards');
    await evaluate(MOUNT_FROZEN('cards'), { awaitPromise: true });
    await click('.cockpit-open');
    await until(cockpitReady, 'the cockpit opens');
    await until(`document.querySelector('.cockpit').hudScene?.getMode() !== 'loading'`, 'the scene settles');
    const mode = await sceneMode();
    if (mode !== '3d') {
      console.log(`pass scene frame: skipped, WebGL unavailable here (scene mode ${mode}); the fallback list is checked above`);
      await click('.cockpit .cp-exit');
      return;
    }
    await pause(600);
    const info = await evaluate(`(() => { const stats = document.querySelector('.cockpit').hudScene.stats(); return { frames: stats.gfx.frames, canvases: stats.gfx.canvases,
      renderer: stats.gfx.glRenderer, nodes: stats.nodes, calls: stats.gfx.calls }; })()`);
    assert.ok(info.frames > 0 && info.calls > 0 && info.canvases === 1 && info.nodes > 0, 'a real scene frame was drawn: ' + JSON.stringify(info));
    // The scene is idle when nothing happens.
    const idleBefore = await evaluate(`document.querySelector('.cockpit').hudScene.stats().gfx.frames`);
    await pause(1500);
    const idleAfter = await evaluate(`document.querySelector('.cockpit').hudScene.stats().gfx.frames`);
    assert.ok(idleAfter - idleBefore <= 1, `an idle scene draws no frames (${idleAfter - idleBefore})`);
    // A real pointer click on a drawn node opens the inspector for that entity.
    const picked = await evaluate(`(() => {
      const scene = document.querySelector('.cockpit').hudScene;
      const snapshot = window.__frozen.snapshot;
      const live = snapshot.sessions.filter(s => s.status === 'needs-you')[0] || snapshot.sessions.find(s => s.status !== 'ended');
      const key = scene.keyOf(live.id, null);
      const point = scene.screenOf(key);
      const rect = document.querySelector('.cs-canvas').getBoundingClientRect();
      return point ? { key, x: rect.left + point.x, y: rect.top + point.y } : null;
    })()`);
    assert.ok(picked, 'the scene reports a screen position for a live session');
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await call('Input.dispatchMouseEvent', { type, x: picked.x, y: picked.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
    await until(`document.querySelector('.cp-insp .insp')`, 'clicking a node opens the inspector');
    assert.equal(await evaluate(`document.querySelector('.cp-insp .insp').dataset.entityKey`), picked.key, 'the click selected the entity it hit');
    assert.equal(await evaluate(`document.querySelectorAll('canvas').length`), 1);
    await capture('cockpit-scene', 1440, 900);
    realScene = `${info.renderer || 'unnamed renderer'}; frames ${info.frames}, draw calls ${info.calls}, idle frames ${idleAfter - idleBefore}`;
    await keyPress('Escape', 'Escape', 27);
    await click('.cockpit .cp-exit');
    await until(`!document.querySelector('.cockpit')`, 'exit');
    const left = await evaluate(`document.querySelectorAll('canvas').length`);
    assert.equal(left, 0, 'leaving removes the canvas');
    console.log('pass real scene frame (' + realScene + '), click selection and canvas cleanup');
  }

  await call('Runtime.enable');
  await call('Network.enable');
  await call('Log.enable');
  await call('Page.enable');
  await call('Page.bringToFront');
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  let realScene = '';
  const only = process.env.HUD_TEST_ONLY || '';   // 'cockpit' runs just the cockpit checks, for quick iteration
  for (const [name, route] of only ? [] : ROUTES) {
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
          text = await evaluate(`(document.body?.innerText || '') + Array.from(document.querySelectorAll('[aria-label]'), el => el.getAttribute('aria-label')).join(' ')`) || '';
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
        assert.ok(await evaluate(`document.querySelector('.gal-sec .kiosk .net-pin:not([hidden]) .card[data-s=needs-you]') &&
          document.querySelector('.gal-sec a[href="/?kiosk"]')`), `${where} shows the kiosk pin and links to the TV view`);
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
  if (!only) {
    await checkProjectFocus();
    await checkWindowLinks();
    await checkAwaySummary();
    await checkStreamAndFeed();
    await checkKiosk();
    await checkActivityLayouts();
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await checkActivityFrames();
    await checkActivityLiveFallback();
    await checkMountCycles();
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await checkCockpitColdEntry();
  await checkCockpitNavigation();
  await checkCockpitRapidCycles();
  await checkCockpitLateImports();
  await checkCockpitFallback();
  await checkCockpitNarrow();
  await checkCockpitEscapeAndFocus();
  await checkCockpitDiscreet();
  await checkCockpitCoverage();
  await checkCockpitPageEffects();
  await checkCockpitSceneFrame();
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

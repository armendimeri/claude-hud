// node tests/tools/cockpit-baseline.mjs [--baseline-dir=PATH | --baseline-url=URL]
//   [--candidate-dir=PATH | --candidate-url=URL] [--loads=20] [--idle-ms=30000]
//   [--baseline-revision=SHA] [--candidate-revision=SHA] [--output=PATH] [--gpu]
import assert from 'node:assert/strict';
import { spawn, fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { pause, script } from '../helpers.mjs';
import { snapshots } from '../fixtures/cockpit/public.mjs';

const baseDir = path.dirname(script);
const host = '127.0.0.1';
const viewport = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const fontBlocklist = ['*://fonts.googleapis.com/*', '*://fonts.gstatic.com/*'];
const fixtureDigest = createHash('sha256').update(JSON.stringify(snapshots.dense)).digest('hex');
const browserDefault = process.platform === 'win32'
  ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : 'chromium';

// Use the selected build's actual HTTP shell, public asset allowlist and SSE implementation.
async function serve(directory) {
  const moduleUrl = pathToFileURL(path.join(directory, 'src/http/server.mjs'));
  const { createHttpServer } = await import(moduleUrl);
  const server = createHttpServer({
    config: { host, hostname: host, port: 0, lan: false },
    source: { readSnapshot: () => snapshots.dense, subscribeUpdates: () => () => {} },
    writer: {},
  });
  const { port } = await server.start();
  const stop = () => { void server.close(); };
  process.on('disconnect', stop);
  process.on('message', message => {
    if (message === 'cpu') process.send(process.cpuUsage());
  });
  process.send({ url: 'http://' + host + ':' + port });
}

// Report the checkout's own HEAD. An extracted archive inside another checkout has no revision of its own,
// so Git's repository root must equal the selected directory, or the caller must pass it explicitly.
function directoryRevision(cwd, explicit) {
  if (explicit) {
    assert.match(explicit, /^[0-9a-f]{7,64}$/i, 'Revision must be a hex commit id');
    return explicit.toLowerCase();
  }
  const git = args => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    if (path.resolve(git(['rev-parse', '--show-toplevel'])) !== cwd) return null;
    return git(['rev-parse', 'HEAD']);
  } catch { return null; }
}

async function buildTarget(label, directory, url, cleanup, explicitRevision) {
  assert.ok(!(directory && url), 'Choose a directory or URL for ' + label);
  if (url) {
    const parsed = new URL(url);
    assert.ok(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password);
    return { label, url: parsed.href, source: 'url', revision: explicitRevision ?? null };
  }
  const cwd = path.resolve(directory ?? baseDir);
  const revision = directoryRevision(cwd, explicitRevision);
  const child = fork(fileURLToPath(import.meta.url), ['--fixture-server', cwd], {
    silent: true, windowsHide: true, env: { ...process.env, HUD_NO_AUTOINSTALL: '1' },
  });
  child.stdout.resume();
  child.stderr.pipe(process.stderr);
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      if (child.connected) child.disconnect();
      await exited;
    }
  });
  const [ready] = await childMessage(child);
  return { label, url: ready.url, source: 'fixed fixture', revision, directory: cwd, child };
}

function childMessage(child, request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Fixture server did not respond')), 10_000);
    function finish(error, ...result) {
      clearTimeout(timer);
      child.off('message', receive);
      child.off('exit', exit);
      child.off('error', finish);
      if (error) reject(error);
      else resolve(result);
    }
    const receive = message => finish(null, message);
    const exit = code => finish(new Error('Fixture server exited with ' + code));
    child.once('message', receive);
    child.once('exit', exit);
    child.once('error', finish);
    if (request) child.send(request, error => { if (error) finish(error); });
  });
}

async function connect(url, onEvent = () => {}) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let lastId = 0;
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method) onEvent(message.method, message.params);
    const respond = pending.get(message.id);
    if (respond) respond(message.error && new Error(message.error.message), message.result);
  });
  socket.addEventListener('close', () => {
    for (const respond of pending.values()) respond(new Error('DevTools socket closed'));
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error('DevTools socket did not open')); }, 10_000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('DevTools connection failed')); }, { once: true });
  });
  return {
    close: () => socket.close(),
    call(method, params = {}) {
      const id = ++lastId;
      return new Promise((resolve, reject) => {
        const respond = (error, result) => {
          clearTimeout(timer);
          pending.delete(id);
          if (error) reject(new Error(method + ': ' + error.message, { cause: error }));
          else resolve(result);
        };
        const timer = setTimeout(() => respond(new Error('DevTools timed out: ' + method)), 15_000);
        pending.set(id, respond);
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch (error) { respond(error); }
      });
    },
  };
}

// Inject before the app runs. Measure after visible Cards rows and both buttons survive a paint.
const readinessProbe = `{
  window.cockpitBaselineWebGlCalls = 0;
  for (const canvas of [window.HTMLCanvasElement, window.OffscreenCanvas].filter(Boolean)) {
    const original = canvas.prototype.getContext;
    canvas.prototype.getContext = function (kind, ...args) {
      if (/webgl/i.test(kind)) window.cockpitBaselineWebGlCalls++;
      return original.call(this, kind, ...args);
    };
  }
  const measure = () => {
    const cards = document.querySelector('.cards');
    const buttons = [...document.querySelectorAll('.p-sess [aria-label="View"] button')];
    if (cards?.getClientRects().length && cards.querySelector('[data-id]') &&
        buttons.filter(button => !button.disabled && button.getClientRects().length).length >= 2) {
      requestAnimationFrame(() => { window.cockpitBaselineUsableMs = performance.now(); });
    } else requestAnimationFrame(measure);
  };
  requestAnimationFrame(measure);
}`;

function traceNetwork() {
  let requests, frames, runtimeErrors, origin;
  const begin = url => {
    origin = new URL(url).origin;
    requests = new Map();
    frames = [];
    runtimeErrors = [];
  };
  function onEvent(event, details) {
    if (!requests) return;
    const { requestId } = details;
    if (event === 'Network.requestWillBeSent' && /^https?:/.test(details.request.url)) {
      requests.set(requestId, { url: details.request.url, type: details.type, transferredBytes: null });
    }
    const request = requests.get(requestId);
    if (event === 'Network.loadingFinished' && request) request.transferredBytes = details.encodedDataLength;
    if (event === 'Network.responseReceived' && request) request.status = details.response.status;
    if (event === 'Network.loadingFailed' && request) request.error = details.blockedReason || details.errorText;
    if (event === 'Network.eventSourceMessageReceived' && request && new URL(request.url).origin === origin) {
      const { eventName, data } = details;
      frames.push({ event: eventName, full: eventName === 'state' && JSON.parse(data).full === true,
        bytes: Buffer.byteLength('event: ' + eventName + '\ndata: ' + data + '\n\n') });
    }
    if (event === 'Runtime.exceptionThrown') runtimeErrors.push(details.exceptionDetails.text);
  }
  function report() {
    const local = [], fonts = [], other = [];
    for (const request of requests.values()) {
      const url = new URL(request.url);
      const group = url.origin === origin ? local : /^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname) ? fonts : other;
      group.push({ ...request, url: group === local ? url.pathname : url.origin + url.pathname });
    }
    const assets = local.filter(request => request.url.startsWith('/assets/'));
    return { local, fonts, other, frames: [...frames], runtimeErrors: [...runtimeErrors],
      assetRequests: assets.length, assetTransferredBytes: assets.reduce((sum, request) => sum + (request.transferredBytes ?? 0), 0) };
  }
  return { begin, onEvent, report };
}

async function targetPage(browser, port, url, action) {
  // Close the measured tab before the next run to reset its document and EventSource.
  const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank' });
  let page;
  let failure;
  try {
    const tabs = await (await fetch('http://' + host + ':' + port + '/json/list')).json();
    const tab = tabs.find(tab => tab.id === targetId);
    const trace = traceNetwork();
    page = await connect(tab.webSocketDebuggerUrl, trace.onEvent);
    const { call } = page;
    await Promise.all([call('Page.enable'), call('Runtime.enable'), call('Network.enable'),
      call('Emulation.setDeviceMetricsOverride', viewport),
      call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })]);
    await call('Network.setCacheDisabled', { cacheDisabled: true });
    await call('Network.setBypassServiceWorker', { bypass: true });
    await call('Network.setBlockedURLs', { urls: fontBlocklist });
    await call('Page.addScriptToEvaluateOnNewDocument', { source: readinessProbe });
    trace.begin(url);
    assert.equal((await call('Page.navigate', { url })).errorText, undefined);
    const evaluate = async expression => {
      const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.ok(!response.exceptionDetails, response.exceptionDetails?.text);
      return response.result.value;
    };
    let usableMs;
    for (let attempt = 0; attempt < 200 && usableMs === undefined; attempt++) {
      try { usableMs = await evaluate('window.cockpitBaselineUsableMs'); }
      catch (error) {
        if (!/execution context/i.test(error.message)) throw error;
      }
      if (usableMs === undefined) await pause(25);
    }
    assert.ok(Number.isFinite(usableMs), 'Dashboard reached visible rows and view buttons at ' + url);
    return await action({ evaluate, trace, usableMs });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    page?.close();
    try { await browser.call('Target.closeTarget', { targetId }); }
    catch (error) { if (!failure) throw error; }
  }
}

function validate(report) {
  assert.deepEqual(report.runtimeErrors, []);
  assert.equal(report.local.filter(request => request.url === '/api/stream').length, 1);
  assert.equal(report.frames.filter(frame => frame.full).length, 1);
  assert.deepEqual(report.local.filter(({ url }) => /\/api\/operator\b|\/assets\/.*(?:cockpit|inspector|three|webgl)/i.test(url)), []);
  assert.deepEqual(report.local.filter(request => request.status >= 400 || request.error), []);
}

const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
function summarize(samples) {
  const times = samples.map(sample => sample.usableMs).sort((a, b) => a - b);
  return { medianMs: (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2,
    p95Ms: percentile(times, 0.95), assetRequests: [...new Set(samples.map(sample => sample.assetRequests))],
    assetTransferredBytes: [...new Set(samples.map(sample => sample.assetTransferredBytes))] };
}

async function benchmark(options) {
  const loads = Number(options.loads ?? 20);
  const idleMs = Number(options['idle-ms'] ?? 30_000);
  assert.ok(Number.isSafeInteger(loads) && loads > 0 && Number.isSafeInteger(idleMs) && idleMs > 0);
  const cleanup = [];
  try {
    const baseline = await buildTarget('baseline', options['baseline-dir'], options['baseline-url'], cleanup, options['baseline-revision']);
    const candidate = await buildTarget('candidate', options['candidate-dir'], options['candidate-url'], cleanup, options['candidate-revision']);
    const targets = [baseline, candidate];
    const executable = process.env.HUD_TEST_BROWSER || browserDefault;
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hud-cockpit-baseline-'));
    cleanup.push(() => fs.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }));
    const browserProcess = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=0', '--disable-background-networking', ...(!options.gpu ? ['--disable-gpu'] : []),
      '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
    let browserError;
    browserProcess.on('error', error => { browserError = error; });
    cleanup.push(async () => {
      if (browserProcess.pid && browserProcess.exitCode === null && browserProcess.signalCode === null) {
        const exited = once(browserProcess, 'exit');
        browserProcess.kill();
        await exited;
      }
    });
    let port;
    for (let i = 0; i < 100 && !port; i++) {
      if (browserError) throw browserError;
      // Some Edge builds exit the launcher with code 0 once the real browser is detached, so a clean exit is
      // only an error when no debugging endpoint appeared.
      try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch {
        if (browserProcess.exitCode) throw new Error('Browser exited with ' + browserProcess.exitCode);
        await pause(100);
      }
    }
    assert.ok(port, 'Chromium debugging endpoint started');
    const version = await (await fetch('http://' + host + ':' + port + '/json/version')).json();
    const browser = await connect(version.webSocketDebuggerUrl);
    cleanup.push(async () => {
      // A detached browser outlives the launcher process, so ask it to quit before the profile is removed.
      try { await Promise.race([browser.call('Browser.close'), pause(3000)]); } catch {}
      browser.close();
    });
    const device = await browser.call('SystemInfo.getInfo');
    await browser.call('Target.createTarget', { url: 'about:blank' });
    const sample = (target, action) => {
      const url = new URL(target.url);
      url.searchParams.set('view', 'cards');
      return targetPage(browser, port, url.href, action);
    };
    const startup = async ({ evaluate, trace, usableMs }) => {
      const report = trace.report();
      validate(report);
      const operable = await evaluate(`(async () => {
        const button = [...document.querySelectorAll('.p-sess [aria-label="View"] button')]
          .find(button => button.textContent.trim() === 'Network');
        button?.click();
        for (let i = 0; i < 10 && !document.querySelector('.net-nodes button'); i++) {
          await new Promise(requestAnimationFrame);
        }
        return button?.getAttribute('aria-pressed') === 'true' &&
          !!document.querySelector('.net-nodes button')?.getClientRects().length;
      })()`);
      assert.ok(operable, 'Network view switch responded after the measured milestone');
      assert.equal(await evaluate('window.cockpitBaselineWebGlCalls'), 0, 'ordinary entry did not initialize WebGL');
      validate(trace.report());
      return { usableMs, ...report };
    };
    const output = { fixture: { seed: 'cockpit-public-v1', sha256: fixtureDigest, now: snapshots.dense.now, sessions: 24 },
      browser: { executable, version: version.Browser, gpuEnabled: Boolean(options.gpu), graphics: device.gpu.devices,
        renderer: device.gpu.auxAttributes?.glRenderer ?? null },
      platform: { node: process.version, os: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model,
        powerScheme: process.platform === 'win32' ? execFileSync('powercfg', ['/getactivescheme'], { encoding: 'utf8' }).trim() : null },
      conditions: { viewport, idleMs, loads, fontBlocklist, cacheDisabled: true, reducedMotion: true }, order: [], builds: {} };
    for (const target of targets) {
      const { child, ...identity } = target;
      output.builds[target.label] = { ...identity, warmup: await sample(target, startup), samples: [] };
    }
    for (let index = 0; index < loads; index++) {
      const order = index % 2 === 0 ? targets : [candidate, baseline];
      for (const target of order) {
        output.order.push(target.label);
        output.builds[target.label].samples.push(await sample(target, startup));
      }
    }
    for (const target of targets) {
      const build = output.builds[target.label];
      build.startup = summarize(build.samples);
      build.idle = await sample(target, async ({ trace, evaluate }) => {
        const before = target.child ? (await childMessage(target.child, 'cpu'))[0] : null;
        const startedAt = performance.now();
        const first = trace.report().frames.length;
        await pause(idleMs);
        const after = target.child ? (await childMessage(target.child, 'cpu'))[0] : null;
        const elapsedMs = performance.now() - startedAt;
        const report = trace.report();
        validate(report);
        assert.equal(await evaluate('window.cockpitBaselineWebGlCalls'), 0);
        const frames = report.frames.slice(first);
        return { elapsedMs, clientFrames: frames.length, sseBytes: frames.reduce((sum, frame) => sum + frame.bytes, 0),
          serverCpuPercentOfOneCore: before ? (after.user + after.system - before.user - before.system) / (elapsedMs * 10) : null };
      });
    }
    const json = JSON.stringify(output, null, 2) + '\n';
    if (options.output) {
      await fs.writeFile(options.output, json);
      for (const [label, build] of Object.entries(output.builds)) {
        console.log(label, build.startup, build.idle);
      }
    } else process.stdout.write(json);
  } finally {
    while (cleanup.length) {
      try { await cleanup.pop()(); }
      catch (error) { console.error('Baseline cleanup:', error.message); process.exitCode = 1; }
    }
  }
}

if (process.argv[2] === '--fixture-server') {
  await serve(process.argv[3]);
} else {
  const { values } = parseArgs({ options: {
    'baseline-dir': { type: 'string' }, 'baseline-url': { type: 'string' },
    'candidate-dir': { type: 'string' }, 'candidate-url': { type: 'string' },
    'baseline-revision': { type: 'string' }, 'candidate-revision': { type: 'string' },
    loads: { type: 'string' }, 'idle-ms': { type: 'string' }, output: { type: 'string' }, gpu: { type: 'boolean' },
  } });
  await benchmark(values);
}

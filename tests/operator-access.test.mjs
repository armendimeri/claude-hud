// operator-cockpit P8: local pairing, authorized private history routes and private source resolution.
// Every profile, ticket folder and transcript here is synthetic and lives under the OS temp folder. Every HUD gets an
// OS-assigned port and HUD_NO_AUTOINSTALL=1. No test reads a real profile or the owner's operator folder.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLiveRuntime } from '../src/app/live.mjs';
import { createDemoRuntime } from '../src/demo/runtime.mjs';
import { readConfig } from '../src/config.mjs';
import { createHttpServer } from '../src/http/server.mjs';
import { PAIR_TTL_MS, operatorCommand, ticketPath, writeTicket } from '../src/operator/access.mjs';
import { createLiveResolver } from '../src/operator/resolver.mjs';
import { decodeKey, encodeKey } from '../src/operator/routes.mjs';
import { canaries, capabilities as fixtureCapabilities, createFixtureAdapter } from './fixtures/cockpit/private.mjs';
import { child as fixtureChild, parent as fixtureParent, selectionKey, sibling as fixtureSibling } from './fixtures/cockpit/public.mjs';
import { freePort, script, startHud } from './helpers.mjs';

const KID = 'PRIVATE_FIXTURE_CODEX_KID_61';
const MARKERS = [canaries.parent, canaries.child, canaries.sibling, KID];
const IDS = { parent: 'p8-parent', conflict: 'p8-conflict', agent: 'a8review01', toolUse: 'toolu_p8review', noFile: 'a8nofile01',
  root: 'codex:p8-root', kid: 'codex:p8-kid' };
const sel = (sessionId, agentId = null) => ({ sessionId, agentId });
const historyPath = (selection, query = '') => `/api/operator/sessions/${encodeKey(selection)}/history${query}`;
const capsPath = selection => `/api/operator/sessions/${encodeKey(selection)}/capabilities`;
const actionsPath = (selection, id = '') => `/api/operator/sessions/${encodeKey(selection)}/actions${id ? '/' + id : ''}`;
const ACTION_ID = '00c0ffee-0000-4000-8000-000000000008';

// ---------------------------------------------------------------------------------------------------------------------
// HTTP helpers with full header control (fetch cannot set Host)

function request(port, pathname, { method = 'GET', headers = {}, body, address = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: address, port, path: pathname, method, agent: false,
      headers: Object.fromEntries(Object.entries({ ...(data && { 'content-length': data.length }), ...headers }).filter(([, v]) => v !== undefined)) }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

/** A same-origin browser tab on this PC, as the HUD page will behave. */
function tab(port, { address = '127.0.0.1', origin = `http://127.0.0.1:${port}` } = {}) {
  const state = { cookie: null, token: null, epoch: null };
  const base = () => ({ 'sec-fetch-site': 'same-origin', ...(state.cookie && { cookie: state.cookie }) });
  return {
    state, port, origin,
    async pair(code, headers = {}) {
      const res = await request(port, '/api/operator/pair', { method: 'POST', address, body: { code },
        headers: { ...base(), 'content-type': 'application/json', origin, 'x-hud-operator': '1', ...headers } });
      if (res.status === 200) state.cookie = /^([^;]+)/.exec(res.headers['set-cookie'][0])[1];
      return res;
    },
    async bootstrap(headers = {}) {
      const res = await request(port, '/api/operator/bootstrap', { address, headers: { ...base(), 'x-hud-operator': '1', ...headers } });
      if (res.status === 200) Object.assign(state, { token: res.json.token, epoch: res.json.epoch });
      return res;
    },
    get(pathname, headers = {}) {
      return request(port, pathname, { address, headers: { ...base(), 'x-hud-operator': state.token || '1', ...headers } });
    },
    post(pathname, body, headers = {}) {
      return request(port, pathname, { method: 'POST', address, body,
        headers: { ...base(), 'content-type': 'application/json', origin, 'x-hud-operator': state.token || '1', ...headers } });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Synthetic profile and an in-process HUD (runtime + HTTP server on an OS-assigned port)

async function tempDir(t, prefix = 'hud-operator-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return dir;
}

const jl = value => JSON.stringify(value) + '\n';
const now = () => new Date().toISOString();

async function profile(t, { fixtures = true } = {}) {
  const dir = await tempDir(t);
  const p = { dir, claude: path.join(dir, 'claude'), claude2: path.join(dir, 'claude-two'), codex: path.join(dir, 'codex'),
    operator: path.join(dir, 'operator') };
  for (const d of [path.join(p.claude, 'sessions'), path.join(p.claude, 'projects'), path.join(p.claude2, 'sessions'),
    path.join(p.claude2, 'projects'), path.join(p.codex, 'sessions')]) await fs.mkdir(d, { recursive: true });
  if (!fixtures) return p;
  const slug = dir.replace(/[^A-Za-z0-9]/g, '-');
  const project = path.join(p.claude, 'projects', slug);
  const subagents = path.join(project, IDS.parent, 'subagents');
  await fs.mkdir(subagents, { recursive: true });
  p.parentFile = path.join(project, IDS.parent + '.jsonl');
  await fs.writeFile(p.parentFile, [
    // Markers sit in assistant text: the public projection already uses some prompt text (titles), by its own policy.
    jl({ type: 'user', uuid: 'u1', sessionId: IDS.parent, cwd: dir, timestamp: now(), message: { role: 'user', content: 'Check the export.' } }),
    jl({ type: 'assistant', uuid: 'a1', sessionId: IDS.parent, cwd: dir, timestamp: now(),
      message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: canaries.parent + ' Reading the export.' }] } }),
    jl({ type: 'assistant', uuid: 'a2', sessionId: IDS.parent, cwd: dir, timestamp: now(),
      message: { id: 'msg_2', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: IDS.toolUse, name: 'Agent',
        input: { subagent_type: 'Explore', description: 'Review export', prompt: 'Review it.' } }] } }),
  ].join(''));
  await fs.writeFile(path.join(subagents, `agent-${IDS.agent}.meta.json`), JSON.stringify({ toolUseId: IDS.toolUse, agentType: 'Explore', description: 'Review export', spawnDepth: 1 }));
  await fs.writeFile(path.join(subagents, `agent-${IDS.agent}.jsonl`), [
    jl({ type: 'user', uuid: 'c1', isSidechain: true, agentId: IDS.agent, sessionId: IDS.parent, timestamp: now(), message: { role: 'user', content: 'Review it.' } }),
    jl({ type: 'assistant', uuid: 'c2', isSidechain: true, agentId: IDS.agent, sessionId: IDS.parent, timestamp: now(),
      message: { id: 'msg_c', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: canaries.child + ' Child review done.' }] } }),
  ].join(''));
  await fs.writeFile(path.join(subagents, `agent-${IDS.noFile}.meta.json`), JSON.stringify({ toolUseId: 'toolu_p8nofile', agentType: 'Explore', description: 'No transcript', spawnDepth: 1 }));
  // The same Claude session claimed by two profiles.
  for (const root of [p.claude, p.claude2]) {
    await fs.mkdir(path.join(root, 'projects', slug), { recursive: true });
    await fs.writeFile(path.join(root, 'projects', slug, IDS.conflict + '.jsonl'),
      jl({ type: 'user', uuid: 'x1', sessionId: IDS.conflict, cwd: dir, timestamp: now(), message: { role: 'user', content: 'Two profiles.' } }));
  }
  await fs.writeFile(path.join(p.claude, 'sessions', '1.json'), JSON.stringify({ sessionId: IDS.parent, pid: process.pid, cwd: dir, status: 'idle' }));
  await fs.writeFile(path.join(p.claude, 'sessions', '2.json'), JSON.stringify({ sessionId: IDS.conflict, pid: process.pid, cwd: dir, status: 'idle' }));
  const day = path.join(p.codex, 'sessions', '2026', '11', '27');
  await fs.mkdir(day, { recursive: true });
  const record = (type, payload) => jl({ timestamp: now(), type, payload });
  await fs.writeFile(path.join(day, 'rollout-p8-root.jsonl'), record('session_meta', { id: 'p8-root', timestamp: now(), cwd: dir, source: 'cli', model_provider: 'openai' })
    + record('event_msg', { type: 'user_message', message: 'Plan the export.' })
    + record('event_msg', { type: 'agent_message', message: canaries.sibling + ' Root reply.' }));
  await fs.writeFile(path.join(day, 'rollout-p8-kid.jsonl'), record('session_meta', { id: 'p8-kid', timestamp: now(), cwd: dir, model_provider: 'openai',
    source: { subagent: { thread_spawn: { parent_thread_id: 'p8-root', agent_role: 'explorer' } } } })
    + record('event_msg', { type: 'user_message', message: 'Explore.' })
    + record('event_msg', { type: 'agent_message', message: KID + ' Explored.' }));
  return p;
}

function countingOpen(counts, { onFirstRead } = {}) {
  return async (file, flags) => {
    const handle = await fs.open(file, flags);
    counts.opens++;
    const close = handle.close.bind(handle);
    let closed = false;
    handle.close = async () => {
      if (closed) counts.doubleCloses++;
      else counts.closes++;
      closed = true;
      return close();
    };
    if (onFirstRead) {
      const read = handle.read.bind(handle);
      let first = true;
      handle.read = async (...args) => {
        if (first) { first = false; await onFirstRead(); }
        return read(...args);
      };
    }
    return handle;
  };
}

function hudConfig(p, { lan = false } = {}) {
  const config = readConfig({ home: p.dir, hostname: 'fixture-host', argv: lan ? ['--lan'] : [], env: {
    CLAUDE_CONFIG_DIR: p.claude, CODEX_HOME: p.codex, HUD_CLAUDE_DIRS: p.claude2, HUD_NO_AUTOINSTALL: '1', HUD_OPERATOR_DIR: p.operator,
  } });
  return { ...config, port: 0 };
}

async function serve(t, p, { lan = false, demo = false, operator = {}, onFirstRead } = {}) {
  const config = hudConfig(p, { lan });
  const counts = { opens: 0, closes: 0, doubleCloses: 0 };
  const options = { operator: { open: countingOpen(counts, { onFirstRead }), ...operator } };
  const runtime = demo ? createDemoRuntime(config, 'demo', options) : createLiveRuntime(config, options);
  const server = createHttpServer({ config, source: runtime.source, writer: runtime.writer, operator: runtime.operator });
  const { port } = await server.start();
  runtime.start();
  t.after(() => Promise.all([server.close(), runtime.close()]));
  return { config, runtime, server, port, counts };
}

/** The CLI's second invocation, in-process: instance nonce from the loopback route, then a ticket. */
async function issue(hud) {
  const res = await request(hud.port, '/api/operator/instance', { headers: { 'x-hud-operator': '1' } });
  assert.equal(res.status, 200);
  return (await writeTicket(hud.config.operatorDir, { port: hud.port, instance: res.json.instance })).code;
}

async function pairedTab(hud) {
  const browser = tab(hud.port);
  assert.equal((await browser.pair(await issue(hud))).status, 200);
  assert.equal((await browser.bootstrap()).status, 200);
  return browser;
}

async function until(predicate, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) assert.fail('condition not reached');
    await new Promise(r => setTimeout(r, 50));
  }
}

const fixturesPublished = hud => until(() => {
  const { sessions } = hud.runtime.source.readSnapshot();
  const find = id => sessions.find(s => s.id === id);
  const agents = id => (find(id)?.subagents || []).map(a => a.id);
  return find(IDS.conflict) && agents(IDS.parent).includes(IDS.agent) && agents(IDS.parent).includes(IDS.noFile)
    && agents(IDS.root).includes(IDS.kid);
});

/** Captures console output so a test can prove no secret reached a log. */
function captureLogs(t) {
  const lines = [];
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const name of Object.keys(saved)) console[name] = (...args) => { lines.push(args.map(String).join(' ')); };
  t.after(() => Object.assign(console, saved));
  return lines;
}

function lanAddress() {
  return Object.values(os.networkInterfaces()).flat()
    .find(a => a?.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))?.address ?? null;
}

function runCli(env, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}
const codeFrom = stdout => /^ {2}([A-Za-z0-9_-]{43})$/m.exec(stdout)?.[1];

// ---------------------------------------------------------------------------------------------------------------------

test('the CLI pairs a browser once, for one port and one runtime instance', { timeout: 90000 }, async t => {
  const a = await startHud({ env: dir => ({ HUD_OPERATOR_DIR: path.join(dir, 'operator') }) });
  t.after(() => a.close());
  const operatorDir = path.join(a.dir, 'operator');
  let hudOutput = '';
  a.child.stdout.on('data', b => { hudOutput += b; });
  const env = (extra = {}) => ({ ...process.env, HOME: a.dir, USERPROFILE: a.dir, CLAUDE_CONFIG_DIR: a.claude, CODEX_HOME: a.codex,
    HUD_NO_AUTOINSTALL: '1', HUD_LAN: '0', HUD_PORT: String(a.port), HUD_OPERATOR_DIR: operatorDir, ...extra });
  const secrets = [];

  // A second CLI invocation (as with the background task) prints the code only in its own terminal.
  const first = await runCli(env(), ['operator', 'pair']);
  assert.equal(first.code, 0, first.stderr);
  const code = codeFrom(first.stdout);
  assert.ok(code, 'the CLI prints a 256-bit code');
  secrets.push(code);
  const ticketText = await fs.readFile(ticketPath(operatorDir, a.port), 'utf8');
  assert.ok(!ticketText.includes(code), 'the ticket stores only a digest');
  assert.deepEqual(Object.keys(JSON.parse(ticketText)).sort(), ['digest', 'expires', 'instance', 'port', 'v']);

  const browser = tab(a.port);
  const paired = await browser.pair(code);
  assert.equal(paired.status, 200);
  const cookie = paired.headers['set-cookie'][0];
  assert.match(cookie, new RegExp(`^hud_operator_${a.port}=[A-Za-z0-9_-]{43}; Path=/api/operator; HttpOnly; SameSite=Strict; Max-Age=\\d+$`));
  assert.ok(!/domain=/i.test(cookie), 'host-only cookie');
  await assert.rejects(fs.stat(ticketPath(operatorDir, a.port)), { code: 'ENOENT' }, 'the ticket is consumed');
  assert.equal((await browser.bootstrap()).status, 200);
  secrets.push(browser.state.cookie, browser.state.token);
  const epochA = browser.state.epoch;
  // Authorized: an unknown session is 404 (not 401 or 403).
  assert.equal((await browser.get(capsPath(sel('nobody')))).status, 404);

  // Duplicate credential exchange.
  const again = await tab(a.port).pair(code);
  assert.deepEqual([again.status, again.json.code], [401, 'pairing_failed']);

  // Wrong port: a ticket for A is useless on B, and A's cookie means nothing to B.
  const b = await startHud({ env: { HUD_OPERATOR_DIR: operatorDir } });
  t.after(() => b.close());
  const forA = codeFrom((await runCli(env(), ['operator', 'pair'])).stdout);
  secrets.push(forA);
  assert.equal((await tab(b.port).pair(forA)).status, 401);
  const crossCookie = await request(b.port, '/api/operator/bootstrap', { headers: { cookie: browser.state.cookie, 'x-hud-operator': '1' } });
  assert.equal(crossCookie.status, 401);
  assert.equal((await tab(a.port).pair(forA)).status, 200, 'B did not consume A\'s ticket');
  // --port selects another HUD from the same terminal.
  const forB = await runCli(env(), ['operator', 'pair', `--port=${b.port}`]);
  assert.equal(forB.code, 0, forB.stderr);
  secrets.push(codeFrom(forB.stdout));
  assert.equal((await tab(b.port).pair(codeFrom(forB.stdout))).status, 200);

  // The CLI explains instead of writing a ticket when no HUD answers or the folders disagree.
  const none = await runCli(env(), ['operator', 'pair', `--port=${await freePort()}`]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /No HUD answered/);
  const otherDir = await runCli(env({ HUD_OPERATOR_DIR: path.join(a.dir, 'elsewhere') }), ['operator', 'pair']);
  assert.equal(otherDir.code, 1);
  assert.match(otherDir.stderr, /different folder/);

  // Restart: a new epoch. The old cookie and an unused ticket from the earlier instance are both refused.
  const stale = codeFrom((await runCli(env(), ['operator', 'pair'])).stdout);
  secrets.push(stale);
  await a.restart();
  a.child.stdout.on('data', chunk => { hudOutput += chunk; });
  assert.equal((await browser.bootstrap()).status, 401);
  assert.equal((await tab(a.port).pair(stale)).status, 401);
  const fresh = tab(a.port);
  const freshCode = codeFrom((await runCli(env(), ['operator', 'pair'])).stdout);
  secrets.push(freshCode);
  assert.equal((await fresh.pair(freshCode)).status, 200);
  assert.equal((await fresh.bootstrap()).status, 200);
  assert.notEqual(fresh.state.epoch, epochA);

  // No secret in the HUD's own output or in public startup text.
  const logs = hudOutput + a.stderr() + b.stderr();
  for (const secret of [...secrets, fresh.state.cookie, fresh.state.token]) assert.ok(secret && !logs.includes(secret), 'a secret reached HUD output');
});

test('private history reads only published, verified sources and closes every handle once', { timeout: 60000 }, async t => {
  const p = await profile(t);
  const hud = await serve(t, p);
  await fixturesPublished(hud);
  // Public use never loads the operator modules.
  for (const route of ['/', '/api/state', '/api/health']) assert.equal((await request(hud.port, route)).status, 200);
  assert.equal(hud.runtime.operator.loaded, false);

  const browser = await pairedTab(hud);
  const texts = page => page.entries.map(e => e.text).join('\n');
  const only = (page, marker) => {
    const text = texts(page);
    assert.ok(text.includes(marker), 'missing ' + marker);
    for (const other of MARKERS.filter(m => m !== marker)) assert.ok(!text.includes(other), 'leaked ' + other);
  };

  const parentRes = await browser.get(historyPath(sel(IDS.parent)));
  assert.equal(parentRes.status, 200);
  assert.equal(parentRes.headers['cache-control'], 'no-store');
  assert.equal(parentRes.headers['access-control-allow-origin'], undefined);
  only(parentRes.json, canaries.parent);
  assert.deepEqual(parentRes.json.entries.map(e => e.kind), ['user', 'assistant', 'tool']);

  const childRes = await browser.get(historyPath(sel(IDS.parent, IDS.agent)));
  assert.equal(childRes.status, 200);
  only(childRes.json, canaries.child);
  // The Agent tool-use id is a known alias of the same subagent on the same parent.
  const alias = await browser.get(historyPath(sel(IDS.parent, IDS.toolUse)));
  assert.deepEqual(alias.json.entries.map(e => e.text), childRes.json.entries.map(e => e.text));

  const rootRes = await browser.get(historyPath(sel(IDS.root)));
  only(rootRes.json, canaries.sibling);
  const kidRes = await browser.get(historyPath(sel(IDS.root, IDS.kid)));
  only(kidRes.json, KID);

  const opensBefore = hud.counts.opens;
  for (const [selection, why] of [
    [sel(IDS.parent, IDS.noFile), 'a subagent without its own transcript never falls back to the parent'],
    [sel(IDS.kid), 'a folded Codex child is not a top-level session'],
    [sel(IDS.conflict), 'two profiles claim one session'],
    [sel('nobody'), 'unknown session'],
    [sel(IDS.parent, 'a-not-published'), 'unknown agent'],
    [sel(IDS.root, IDS.parent), 'a Claude session is not a Codex child'],
  ]) {
    const res = await browser.get(historyPath(selection));
    assert.deepEqual([res.status, res.json], [404, { code: 'unavailable', message: 'This conversation is unavailable.' }], why);
  }
  assert.equal(hud.counts.opens, opensBefore, 'only the conflict check reached the opener, which refused before opening');

  // Cursors: bad shape, both, tampered, another entity.
  assert.equal((await browser.get(`/api/operator/sessions/${encodeKey(sel(IDS.parent))}=/history`)).status, 400);
  assert.equal((await browser.get('/api/operator/sessions/W10/history')).status, 400);   // "[]"
  const both = await browser.get(historyPath(sel(IDS.parent), `?before=${parentRes.json.before || 'x'}&after=${parentRes.json.after}`));
  assert.equal(both.status, 400);
  assert.equal((await browser.get(historyPath(sel(IDS.parent), '?after=' + parentRes.json.after.slice(0, -2) + 'AA'))).json.code, 'invalid_cursor');
  assert.equal((await browser.get(historyPath(sel(IDS.parent), '?after=' + childRes.json.after))).json.code, 'invalid_cursor');

  // Catch-up after a late append.
  await fs.appendFile(p.parentFile, jl({ type: 'assistant', uuid: 'a3', sessionId: IDS.parent, timestamp: now(),
    message: { id: 'msg_3', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Late reply.' }] } }));
  const newer = await browser.get(historyPath(sel(IDS.parent), '?after=' + encodeURIComponent(parentRes.json.after)));
  assert.equal(newer.status, 200);
  assert.deepEqual(newer.json.entries.map(e => e.text), ['Late reply.']);
  assert.equal(newer.json.before, null);

  // Observed-only capabilities and unavailable actions until P11 registers a dispatcher.
  const caps = await browser.get(capsPath(sel(IDS.parent)));
  assert.deepEqual(caps.json, { epoch: browser.state.epoch, revision: 'observed', actionWindow: null, available: ['history'],
    activeTurnId: null, pending: [], reason: 'observed_only' });
  const submit = await browser.post(actionsPath(sel(IDS.parent)), { actionId: ACTION_ID, kind: 'prompt', payload: { text: 'hi' } });
  assert.deepEqual([submit.status, submit.json.code], [503, 'actions_unavailable']);
  assert.deepEqual([(await browser.get(actionsPath(sel(IDS.parent), ACTION_ID))).status], [503]);

  assert.ok(hud.counts.opens >= 6);
  assert.equal(hud.counts.closes, hud.counts.opens);
  assert.equal(hud.counts.doubleCloses, 0);

  // Nothing private reached the public snapshot.
  const state = (await request(hud.port, '/api/state')).text;
  for (const marker of MARKERS) assert.ok(!state.includes(marker), 'public snapshot leaked ' + marker);
});

test('the resolver proves aliases, ancestry and ownership before naming a file', () => {
  const tailFor = (file, session, agentId = null) => ({ file, owner: { session, agentId } });
  const claudeSession = (id, provider = 'anthropic') => ({ id, agent: 'claude', cwd: '/fixture', subs: new Set(), byAgent: new Map(), byToolUse: new Map(), provider });
  const sub = (s, agentId, toolUseId, file = `/fixture/${s.id}/subagents/agent-${agentId}.jsonl`) => {
    const value = { agentId, toolUseId, tail: null };
    value.tail = file ? tailFor(file, s, agentId) : null;
    s.subs.add(value);
    if (agentId) s.byAgent.set(agentId, value);
    if (toolUseId) s.byToolUse.set(toolUseId, value);
    return value;
  };
  const a = claudeSession('A'), bed = claudeSession('BED');
  a.tail = tailFor('/fixture/A.jsonl', a);
  bed.tail = tailFor('/fixture/BED.jsonl', bed);
  const good = sub(a, 'agent-1', 'toolu-1');
  sub(a, 'agent-2', 'toolu-2', '/fixture/A/subagents/agent-other.jsonl');   // names another agent's file
  const stolen = sub(a, 'agent-3', 'toolu-3');
  stolen.tail.owner = { session: bed, agentId: 'agent-3' };
  const conflictA = sub(a, 'dup', null), conflictB = sub(a, null, 'dup-tool');
  a.byToolUse.set('dup', conflictB);   // one alias claimed by two different subagents
  void conflictA;
  sub(a, 'agent-hidden', 'toolu-hidden');
  const codex = (id, parent, extra = {}) => ({ id, agent: 'codex', codexParent: parent, cwd: '/fixture', ...extra });
  const root = codex('codex:root', null), mid = codex('codex:mid', 'codex:root'), leaf = codex('codex:leaf', 'codex:mid');
  const orphan = codex('codex:orphan', 'codex:missing'), loopA = codex('codex:loop-a', 'codex:loop-b'), loopB = codex('codex:loop-b', 'codex:loop-a');
  const internal = codex('codex:internal', 'codex:root', { codexInternal: true }), other = codex('codex:other-root', null);
  const stranger = codex('codex:stranger', 'codex:other-root');
  for (const s of [root, mid, leaf, orphan, loopA, loopB, internal, other, stranger]) s.tail = tailFor(`/fixture/rollout-${s.id.slice(6)}.jsonl`, s);
  const all = new Map([a, bed, root, mid, leaf, orphan, loopA, loopB, internal, other, stranger].map(s => [s.id, s]));
  const published = ['agent-1', 'agent-2', 'agent-3', 'dup', 'dup-tool'];
  const snapshot = { sessions: [
    { id: 'A', provider: 'anthropic', subagents: published.map(id => ({ id })) },
    { id: 'BED', provider: 'bedrock', subagents: [] },
    { id: 'codex:root', provider: 'openai', subagents: ['codex:mid', 'codex:leaf', 'codex:orphan', 'codex:loop-a', 'codex:internal', 'codex:stranger'].map(id => ({ id })) },
  ] };
  const { resolve } = createLiveResolver({ findSession: id => all.get(id), readSnapshot: () => snapshot, claudeProjects: [] });

  assert.deepEqual(resolve(sel('A')).record, { provider: 'claude', files: ['/fixture/A.jsonl'], native: { sessionId: 'A', agentId: null }, cwd: '/fixture' });
  for (const alias of ['agent-1', 'toolu-1']) {
    const { record, target } = resolve(sel('A', alias));
    assert.deepEqual(record.files, [good.tail.file]);
    assert.equal(record.native.agentId, 'agent-1', 'the verified agent id, whichever alias was selected');
    assert.equal(target.nativeAgentId, 'agent-1');
  }
  for (const [selection, why] of [
    [sel('A', 'agent-2'), 'file of another agent'], [sel('A', 'agent-3'), 'tail owned by another session'],
    [sel('A', 'dup'), 'alias conflict'], [sel('A', 'agent-hidden'), 'not published'], [sel('A', 'nobody'), 'unknown'],
    [sel('codex:root', 'codex:orphan'), 'broken ancestor chain'], [sel('codex:root', 'codex:loop-a'), 'ancestor cycle'],
    [sel('codex:root', 'codex:internal'), 'internal Codex thread'], [sel('codex:root', 'codex:stranger'), 'child of another root'],
    [sel('codex:root', 'codex:other-root'), 'not published under this root'], [sel('codex:leaf'), 'folded child is not top-level'],
    [{ sessionId: 'A' }, 'missing agentId'], [{ sessionId: '', agentId: null }, 'empty id'], [sel('A', ''), 'empty agent'], [null, 'no selection'],
  ]) assert.equal(resolve(selection), null, why);

  const deep = resolve(sel('codex:root', 'codex:leaf'));
  assert.deepEqual(deep.record.files, ['/fixture/rollout-leaf.jsonl']);
  assert.deepEqual(deep.target, { selection: sel('codex:root', 'codex:leaf'), provider: 'openai', nativeSessionId: 'leaf', connectionGeneration: null });
  const bedrock = resolve(sel('BED'));
  assert.deepEqual([bedrock.target.provider, bedrock.record.provider], ['bedrock', 'claude']);

  // Opaque keys match the frozen P1 encoding and reject non-canonical or oversized input.
  for (const selection of [fixtureParent, fixtureChild, fixtureSibling]) {
    assert.equal(encodeKey(selection), selectionKey(selection));
    assert.deepEqual(decodeKey(selectionKey(selection)), selection);
  }
  for (const bad of [encodeKey(fixtureParent) + '=', 'W10', 'x'.repeat(2049), Buffer.from('{"a":1}').toString('base64url'),
    Buffer.from('["s",""]').toString('base64url'), Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x2c, 0x6e, 0x75, 0x6c, 0x6c, 0x5d]).toString('base64url')]) {
    assert.equal(decodeKey(bad), null, bad.slice(0, 20));
  }
});

test('private routes refuse foreign origins, proxies, missing markers and HEAD; hooks keep working', { timeout: 60000 }, async t => {
  const logs = captureLogs(t);
  const p = await profile(t, { fixtures: false });
  const hud = await serve(t, p);
  const { port } = hud;
  const code = await issue(hud);
  const hostile = tab(port, { origin: 'http://evil.test' });
  assert.equal((await hostile.pair(code)).status, 403, 'hostile Origin');
  assert.equal((await tab(port, { origin: `http://127.0.0.1:${port + 1}` }).pair(code)).status, 403, 'wrong port in Origin');
  const noOrigin = await request(port, '/api/operator/pair', { method: 'POST', body: { code },
    headers: { 'content-type': 'application/json', 'x-hud-operator': '1' } });
  assert.equal(noOrigin.status, 403, 'missing Origin on a state-changing request');
  assert.equal((await tab(port).pair(code, { 'x-forwarded-for': '10.0.0.9' })).status, 403, 'forwarded header');
  assert.equal((await tab(port).pair(code, { 'sec-fetch-site': 'cross-site' })).status, 403, 'cross-site fetch');
  assert.equal((await tab(port).pair(code, { 'content-type': 'text/plain' })).status, 415);
  const browser = tab(port);
  assert.equal((await browser.pair(code)).status, 200, 'none of the refused requests consumed the ticket');
  assert.equal((await browser.bootstrap()).status, 200);
  const { cookie, token } = browser.state;
  const target = capsPath(sel('nobody'));

  const cases = [
    ['no cookie', { 'x-hud-operator': token }, 401],
    ['cookie for another port', { cookie: cookie.replace(`hud_operator_${port}=`, `hud_operator_${port + 1}=`), 'x-hud-operator': token }, 401],
    ['no marker', { cookie }, 403],
    ['wrong token', { cookie, 'x-hud-operator': token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A') }, 403],
    ['hostile Origin on a read', { cookie, 'x-hud-operator': token, origin: 'http://evil.test' }, 403],
    ['Origin on another loopback name', { cookie, 'x-hud-operator': token, origin: `http://localhost:${port}` }, 403],
    ['Forwarded', { cookie, 'x-hud-operator': token, forwarded: 'for=10.0.0.9' }, 403],
    ['X-Real-IP', { cookie, 'x-hud-operator': token, 'x-real-ip': '10.0.0.9' }, 403],
    ['cross-site fetch', { cookie, 'x-hud-operator': token, 'sec-fetch-site': 'cross-site' }, 403],
    ['authorized', { cookie, 'x-hud-operator': token }, 404],
  ];
  for (const [name, headers, status] of cases) {
    const res = await request(port, target, { headers });
    assert.equal(res.status, status, name);
    assert.equal(res.headers['cache-control'], 'no-store', name);
    assert.equal(res.headers.location, undefined, name);
    assert.equal(typeof res.json?.code, 'string', name);
  }
  // A DNS-rebinding Host is refused before any private route; a localhost Host with a 127.0.0.1 cookie is not paired.
  assert.equal((await request(port, target, { headers: { host: `evil.test:${port}`, cookie, 'x-hud-operator': token } })).status, 403);
  assert.equal((await request(port, target, { headers: { host: `localhost:${port}`, cookie, 'x-hud-operator': token } })).status, 404);

  const head = await request(port, historyPath(sel('nobody')), { method: 'HEAD', headers: { cookie, 'x-hud-operator': token } });
  assert.deepEqual([head.status, head.text], [405, '']);
  const preflight = await request(port, actionsPath(sel('nobody')), { method: 'OPTIONS',
    headers: { origin: 'http://evil.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-hud-operator' } });
  assert.equal(preflight.status, 405);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
  assert.equal((await browser.post(actionsPath(sel('nobody')), { actionId: ACTION_ID, kind: 'prompt' }, { origin: undefined })).status, 403);
  const big = await browser.post(actionsPath(sel('nobody')), { actionId: ACTION_ID, kind: 'prompt', payload: { text: 'x'.repeat(17 << 10) } });
  assert.deepEqual([big.status, big.json?.code], [413, 'too_large']);
  assert.equal((await browser.get('/api/operator/elsewhere')).status, 404);

  // The separate local hook endpoint keeps its own rules: no Origin is fine, a foreign Origin is refused.
  const hook = { session_id: 'hook-session', cwd: p.dir, hook_event_name: 'UserPromptSubmit' };
  assert.equal((await request(port, '/event', { method: 'POST', body: hook, headers: { 'content-type': 'application/json' } })).status, 204);
  assert.equal((await request(port, '/event', { method: 'POST', body: hook, headers: { 'content-type': 'application/json', origin: 'http://evil.test' } })).status, 403);

  for (const secret of [code, cookie, token]) assert.ok(!logs.some(line => line.includes(secret)), 'a secret reached a log');
});

test('LAN peers cannot pair, read or write, even with a valid code or session', { timeout: 60000 }, async t => {
  const lan = lanAddress();
  if (!lan) return t.skip('this PC has no non-internal IPv4 address; run the manual LAN check in handoffs/P8.md');
  const p = await profile(t);
  const hud = await serve(t, p, { lan: true });
  await fixturesPublished(hud);
  const { port } = hud;

  // The public view stays readable from the network, as before.
  assert.equal((await request(port, '/api/state', { address: lan })).status, 200);
  assert.equal((await request(port, '/api/operator/instance', { address: lan, headers: { 'x-hud-operator': '1' } })).status, 403);
  const code = await issue(hud);
  const remote = tab(port, { address: lan, origin: `http://${lan}:${port}` });
  assert.equal((await remote.pair(code)).status, 403, 'LAN pairing with a valid code');
  // A loopback peer that names the LAN host is refused too.
  assert.equal((await request(port, '/api/operator/pair', { method: 'POST', body: { code },
    headers: { host: `${lan}:${port}`, origin: `http://${lan}:${port}`, 'content-type': 'application/json', 'x-hud-operator': '1' } })).status, 403);
  const local = tab(port);
  assert.equal((await local.pair(code)).status, 200, 'the refused LAN attempts did not consume the ticket');
  assert.equal((await local.bootstrap()).status, 200);

  const stolen = { cookie: local.state.cookie, 'x-hud-operator': local.state.token };
  for (const [method, route, headers] of [
    ['GET', historyPath(sel(IDS.parent)), {}],
    ['GET', capsPath(sel(IDS.parent)), {}],
    ['GET', '/api/operator/bootstrap', {}],
    ['POST', actionsPath(sel(IDS.parent)), { origin: `http://${lan}:${port}`, 'content-type': 'application/json' }],
  ]) {
    const res = await request(port, route, { method, address: lan, headers: { ...stolen, ...headers },
      ...(method === 'POST' && { body: { actionId: ACTION_ID, kind: 'prompt', payload: { text: 'x' } } }) });
    assert.equal(res.status, 403, `${method} ${route.split('/').pop()} from the LAN`);
    for (const marker of MARKERS) assert.ok(!res.text.includes(marker));
  }
  assert.equal((await request(port, '/event', { method: 'POST', address: lan, body: {}, headers: { 'content-type': 'application/json' } })).status, 403);
  assert.equal((await local.get(historyPath(sel(IDS.parent)))).status, 200, 'the same session works from this PC');
});

test('tickets: one concurrent winner, replacement, expiry, bounded attempts and a private folder', { timeout: 90000 }, async t => {
  const logs = captureLogs(t);
  const p = await profile(t, { fixtures: false });
  const hud = await serve(t, p);
  const { port } = hud;
  const dir = hud.config.operatorDir;
  const secrets = [];

  const code = await issue(hud);
  secrets.push(code);
  const raced = await Promise.all([tab(port).pair(code), tab(port).pair(code)]);
  assert.deepEqual(raced.map(r => r.status).sort(), [200, 401], 'exactly one of two concurrent exchanges wins');

  const replaced = await issue(hud), replacement = await issue(hud);
  secrets.push(replaced, replacement);
  assert.equal((await tab(port).pair(replaced)).status, 401, 'a replaced ticket is refused');
  assert.equal((await tab(port).pair(replacement)).status, 200);

  const instance = (await request(port, '/api/operator/instance', { headers: { 'x-hud-operator': '1' } })).json.instance;
  const foreign = await writeTicket(dir, { port, instance: 'another-instance' });
  assert.equal((await tab(port).pair(foreign.code)).status, 401, 'a ticket for another runtime instance');
  const expired = await writeTicket(dir, { port, instance, clock: () => Date.now() - PAIR_TTL_MS - 1000 });
  assert.equal((await tab(port).pair(expired.code)).status, 401, 'an expired ticket');
  await assert.rejects(fs.stat(ticketPath(dir, port)), { code: 'ENOENT' }, 'the expired ticket was removed');

  const guarded = await issue(hud);
  secrets.push(guarded);
  for (let i = 0; i < 5; i++) assert.equal((await tab(port).pair('A'.repeat(42) + String.fromCharCode(66 + i))).status, 401);
  assert.equal((await tab(port).pair(guarded)).status, 401, 'five wrong codes expire the ticket');

  // Folder permissions: another account with access turns pairing off; the public HUD keeps running.
  if (process.platform === 'win32') execFileSync('icacls', [dir, '/grant', '*S-1-1-0:(OI)(CI)R'], { windowsHide: true, stdio: 'ignore' });
  else await fs.chmod(dir, 0o777);
  const refused = await tab(port).pair(code);
  assert.deepEqual([refused.status, refused.json.code], [503, 'pairing_unavailable']);
  assert.equal((await request(port, '/api/state')).status, 200);
  const errors = [];
  assert.equal(await operatorCommand(['pair', `--port=${port}`], { port, operatorDir: dir }, { log: () => assert.fail('printed a code'), error: m => errors.push(m) }), 1);
  assert.match(errors.join('\n'), /private pairing folder/);

  // Attempts are bounded per minute.
  let limited = null;
  for (let i = 0; i < 25 && !limited; i++) {
    const res = await tab(port).pair('B'.repeat(43));
    if (res.status === 429) limited = res;
  }
  assert.equal(limited?.json.code, 'too_many_attempts');
  for (const secret of secrets) assert.ok(!logs.some(line => line.includes(secret)), 'a secret reached a log');
});

test('shutdown aborts a pending read, closes its handle once, removes the ticket and refuses old sessions', { timeout: 60000 }, async t => {
  let reached, release;
  const atRead = new Promise(r => { reached = r; }), gate = new Promise(r => { release = r; });
  const p = await profile(t);
  const hud = await serve(t, p, { onFirstRead: async () => { reached(); await gate; } });
  await fixturesPublished(hud);
  const browser = await pairedTab(hud);
  await issue(hud);   // an unused ticket that names this instance
  assert.ok(await fs.stat(ticketPath(hud.config.operatorDir, hud.port)));

  const pending = browser.get(historyPath(sel(IDS.parent)));
  await atRead;
  const closed = hud.runtime.close();
  release();
  await closed;
  const res = await pending;
  assert.deepEqual([res.status, res.json?.code], [503, 'closing']);
  assert.deepEqual([hud.counts.opens, hud.counts.closes, hud.counts.doubleCloses], [1, 1, 0]);
  await assert.rejects(fs.stat(ticketPath(hud.config.operatorDir, hud.port)), { code: 'ENOENT' });
  assert.equal((await browser.bootstrap()).status, 503);
  assert.equal((await browser.get(historyPath(sel(IDS.parent)))).status, 503);
  assert.equal(hud.counts.opens, 1, 'no read after shutdown');
});

test('demo history is synthetic even when real-looking profile folders exist', { timeout: 60000 }, async t => {
  const p = await profile(t);   // transcripts and rollouts with private markers exist in this profile
  let dispatcherMade = false;
  const hud = await serve(t, p, { demo: true, operator: {
    resolveAdapter: () => createFixtureAdapter(), createDispatcher: () => { dispatcherMade = true; return {}; },
  } });
  const snapshot = await until(() => hud.runtime.source.readSnapshot().sessions.find(s => s.subagents.length) && hud.runtime.source.readSnapshot());
  const session = snapshot.sessions.find(s => s.subagents.length);
  const browser = await pairedTab(hud);
  for (const selection of [sel(session.id), sel(session.id, session.subagents[0].id)]) {
    const res = await browser.get(historyPath(selection));
    assert.equal(res.status, 200);
    assert.match(res.json.entries.at(-1).text, /simulated demo history/);
    for (const marker of MARKERS) assert.ok(!res.text.includes(marker));
    assert.equal((await browser.get(historyPath(selection, '?after=' + res.json.after))).json.entries.length, 0);
  }
  assert.equal((await browser.get(capsPath(sel(session.id)))).json.reason, 'observed_only');
  assert.equal((await browser.post(actionsPath(sel(session.id)), { actionId: ACTION_ID, kind: 'prompt', payload: { text: 'x' } })).status, 503);
  assert.equal((await browser.get(historyPath(sel(IDS.parent)))).status, 404, 'a real session id is not a demo session');
  assert.equal(hud.counts.opens, 0, 'demo mode never opens a file');
  assert.equal(dispatcherMade, false, 'demo mode never builds a dispatcher');
});

test('capabilities and actions go through injected adapter and dispatcher slots', { timeout: 60000 }, async t => {
  const adapter = createFixtureAdapter({ getCapabilities: () => fixtureCapabilities.question });
  const calls = [];
  let closes = 0, deps = null, failing = false;
  const p = await profile(t);
  const hud = await serve(t, p, { operator: {
    resolveAdapter: target => target.provider === 'anthropic' ? (failing ? { capabilities: async () => { throw new Error('PRIVATE provider text'); } } : adapter) : null,
    createDispatcher(value) {
      deps = value;
      return {
        async submit(target, command) {
          calls.push({ target, command });
          if (command.actionId !== ACTION_ID) throw Object.assign(new Error('This question has closed.'), { code: 'stale_request', status: 409 });
          return { actionId: command.actionId, status: 'pending', at: 1 };
        },
        async receipt(target, actionId) { return actionId === ACTION_ID ? { actionId, status: 'acknowledged', at: 2 } : null; },
        close() { closes++; },
      };
    },
  } });
  await fixturesPublished(hud);
  const browser = await pairedTab(hud);

  const caps = (await browser.get(capsPath(sel(IDS.parent)))).json;
  assert.equal(caps.epoch, browser.state.epoch, 'the server owns the epoch');
  assert.equal(deps.epoch, browser.state.epoch);
  assert.deepEqual(caps.available, ['history', 'answer']);
  assert.deepEqual(caps.pending, fixtureCapabilities.question.pending);
  assert.equal(caps.actionWindow, fixtureCapabilities.question.actionWindow);
  // A provider without an adapter (disabled) stays observed-only.
  assert.equal((await browser.get(capsPath(sel(IDS.root)))).json.reason, 'observed_only');

  const command = { actionId: ACTION_ID, epoch: caps.epoch, revision: caps.revision, actionWindow: caps.actionWindow, kind: 'answer',
    turnId: caps.activeTurnId, requestId: 'request-1', payload: { answers: [{ questionId: 'question-date', choiceIds: ['today'] }] } };
  const submitted = await browser.post(actionsPath(sel(IDS.parent, IDS.agent)), command);
  assert.deepEqual(submitted.json, { actionId: ACTION_ID, status: 'pending', at: 1 });
  assert.deepEqual(calls[0].target, { selection: sel(IDS.parent, IDS.agent), provider: 'anthropic', nativeSessionId: IDS.parent,
    nativeAgentId: IDS.agent, connectionGeneration: null });
  const stale = await browser.post(actionsPath(sel(IDS.parent)), { ...command, actionId: '00c0ffee-0000-4000-8000-000000000009' });
  assert.deepEqual([stale.status, stale.json], [409, { code: 'stale_request', message: 'This question has closed.' }]);
  assert.equal((await browser.post(actionsPath(sel(IDS.parent)), { ...command, actionId: 'not-a-uuid' })).status, 400);
  assert.equal((await browser.post(actionsPath(sel('nobody')), command)).status, 404, 'an unknown target never reaches the dispatcher');
  assert.equal(calls.length, 2);
  assert.equal((await browser.get(actionsPath(sel(IDS.parent), ACTION_ID))).json.status, 'acknowledged');
  assert.equal((await browser.get(actionsPath(sel(IDS.parent), '00c0ffee-0000-4000-8000-00000000000a'))).status, 404);
  assert.equal(adapter.calls.length, 0, 'the routes never call adapter.dispatch themselves');

  // A disconnected provider fails only capabilities; local history stays readable.
  failing = true;
  const down = await browser.get(capsPath(sel(IDS.parent)));
  assert.deepEqual([down.status, down.json.code], [503, 'provider_unavailable']);
  assert.ok(!down.text.includes('PRIVATE'));
  assert.equal((await browser.get(historyPath(sel(IDS.parent)))).status, 200);
  await hud.runtime.close();
  assert.equal(closes, 1, 'shutdown closes the dispatcher');
});

test('a server without the operator service answers 404 on private paths', async t => {
  const server = createHttpServer({ config: { host: '127.0.0.1', hostname: '127.0.0.1', port: 0, lan: false },
    source: { readSnapshot: () => ({ uptime: 0, totals: { sessions: 0 }, version: 'test' }), subscribeUpdates: () => () => {} }, writer: {} });
  const { port } = await server.start();
  t.after(() => server.close());
  assert.equal((await request(port, '/api/operator/instance', { headers: { 'x-hud-operator': '1' } })).status, 404);
  assert.equal((await request(port, '/api/health')).status, 200);
});

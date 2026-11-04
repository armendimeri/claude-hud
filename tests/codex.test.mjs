import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Script } from 'node:vm';

const script = path.resolve('hud.mjs');
const pause = ms => new Promise(r => setTimeout(r, ms));
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

test('Claude and Codex coexist, update incrementally, and survive restart', { timeout: 60000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hud-codex-test-'));
  const codex = path.join(dir, 'codex'), claude = path.join(dir, 'claude');
  const logs = path.join(codex, 'sessions', '2026', '11', '04');
  await fs.mkdir(logs, { recursive: true });
  await fs.mkdir(path.join(claude, 'sessions'), { recursive: true });
  await fs.mkdir(path.join(claude, 'projects'), { recursive: true });
  const extraCodex = path.join(dir, 'extra-codex');
  await fs.mkdir(path.join(extraCodex, 'sessions'), { recursive: true });
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  await new Promise(r => server.close(r));
  const base = `http://127.0.0.1:${port}`;
  let child, errors = '';
  const start = () => {
    child = spawn(process.execPath, [script], { windowsHide: true, env: { ...process.env,
      HOME: dir, USERPROFILE: dir, CODEX_HOME: codex, HUD_CODEX_DIRS: extraCodex,
      CLAUDE_CONFIG_DIR: claude, HUD_CLAUDE_DIRS: '', HUD_NO_AUTOINSTALL: '1',
      HUD_PORT: String(port), HUD_LAN: '0', HUD_BEDROCK_REGION: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.on('data', b => { errors += b; });
  };
  const stop = async () => {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  };
  t.after(async () => { await stop(); await fs.rm(dir, { recursive: true, force: true }); });
  const state = async () => (await fetch(base + '/api/state')).json();
  const until = async predicate => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try { const s = await state(); if (predicate(s)) return s; } catch {}
      await pause(100);
    }
    assert.fail('State did not converge: ' + errors);
  };
  const stamp = () => new Date().toISOString();
  const record = (type, payload, timestamp = stamp()) => JSON.stringify({ timestamp, type, payload }) + '\n';
  const meta = (id, source = 'vscode', timestamp = stamp()) => record('session_meta', {
    id, timestamp, cwd: dir, source, cli_version: 'test', model_provider: 'openai', git: { branch: 'feature/codex' },
    base_instructions: { text: 'PRIVATE_INSTRUCTIONS' },
  }, timestamp);
  const context = record('turn_context', { model: 'gpt-test-codex', effort: 'high', cwd: dir });
  const usage = { input_tokens: 1000, cached_input_tokens: 700, output_tokens: 100, reasoning_output_tokens: 30, total_tokens: 1100 };
  const token = record('event_msg', { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage, model_context_window: 10000 } });
  const main = path.join(logs, 'rollout-parent.jsonl');
  const stale = path.join(logs, 'rollout-stale.jsonl');
  const oldTime = new Date(Date.now() - 20 * 60000).toISOString();
  await fs.writeFile(main, meta('shared-id') + context + record('event_msg', { type: 'user_message', message: 'Fix bug api_key=secret-title' }) +
    record('event_msg', { type: 'task_started' }) + record('token_usage_record', { thread_token_usage: usage, usage }) + token + token +
    record('response_item', { type: 'reasoning', encrypted_content: 'PRIVATE_REASONING' }) +
    record('response_item', { type: 'function_call', call_id: 'call1', name: 'functions.exec_command', arguments: JSON.stringify({ cmd: 'echo --token secret-tool' }) }) +
    '{broken json}\n');
  await fs.writeFile(stale, meta('stale', 'cli', oldTime) + record('event_msg', { type: 'task_complete' }, oldTime));
  await fs.writeFile(path.join(logs, 'rollout-child.jsonl'), meta('child', { subagent: { thread_spawn: { parent_thread_id: 'shared-id', agent_role: 'explorer' } } }) + context + token + record('event_msg', { type: 'task_started' }));
  await fs.writeFile(path.join(logs, 'rollout-grandchild.jsonl'), meta('grandchild', { subagent: { thread_spawn: { parent_thread_id: 'child' } } }) + token + record('event_msg', { type: 'task_complete' }));
  await fs.writeFile(path.join(logs, 'rollout-internal.jsonl'), meta('internal', { subagent: { other: 'guardian' } }) + token);
  await fs.writeFile(path.join(extraCodex, 'sessions', 'rollout-extra.jsonl'), meta('extra') + record('event_msg', { type: 'task_complete' }));
  await fs.writeFile(path.join(claude, 'sessions', `${process.pid}.json`), JSON.stringify({ sessionId: 'shared-id', pid: process.pid, cwd: dir, status: 'idle' }));
  start();
  let s = await until(s => s.sessions.some(x => x.id === 'codex:shared-id' && x.subagents.length === 2) && s.sessions.some(x => x.id === 'shared-id') && s.sessions.some(x => x.id === 'codex:extra'));

  await t.test('source identity, parent tree, cumulative tokens and privacy', () => {
    const parent = s.sessions.find(x => x.id === 'codex:shared-id');
    assert.equal(parent.agent, 'codex'); assert.equal(parent.provider, 'openai');
    assert.equal(parent.model, 'gpt-test-codex'); assert.equal(parent.effort, 'high');
    assert.equal(parent.branch, 'feature/codex'); assert.equal(parent.status, 'busy');
    assert.equal(parent.tools, 1); assert.equal(parent.currentTool.name, 'exec_command');
    assert.deepEqual(parent.tokens, { input: 300, output: 100, cacheRead: 700, cacheWrite: 0 });
    assert.deepEqual(parent.context, { used: 1100, window: 10000, pct: 11 });
    assert.deepEqual(parent.tokensTree, { input: 900, output: 300, cacheRead: 2100, cacheWrite: 0 });
    assert.deepEqual(s.totals.tokensToday, { input: 1200, output: 400, cacheRead: 2800, cacheWrite: 0 });
    assert.equal(parent.subagents.find(x => x.id === 'codex:grandchild').depth, 2);
    assert.equal(parent.subagents.find(x => x.id === 'codex:grandchild').parentId, 'codex:child');
    assert.equal(s.sessions.some(x => ['codex:child', 'codex:grandchild', 'codex:internal'].includes(x.id)), false);
    assert.equal(s.sessions.find(x => x.id === 'codex:stale').status, 'ended');
    for (const secret of ['PRIVATE_INSTRUCTIONS', 'PRIVATE_REASONING', 'secret-title', 'secret-tool']) assert.ok(!JSON.stringify(s).includes(secret), secret);
  });
  await t.test('HTTP, SSE and generated browser scripts', async () => {
    assert.equal((await (await fetch(base + '/api/health')).json()).version, '0.2.0');
    for (const route of ['/', '/design']) {
      const html = await (await fetch(base + route)).text();
      for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Script(match[1]);
      assert.ok(html.includes('Codex')); assert.ok(html.includes('OpenAI'));
    }
    const ac = new AbortController();
    try {
      const res = await fetch(base + '/api/stream', { signal: ac.signal });
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      const { value } = await res.body.getReader().read();
      assert.match(Buffer.from(value).toString(), /event: state/);
    } finally { ac.abort(); }
  });
  await t.test('split UTF-8 lines, tool output discard, questions and turn completion', async () => {
    const rec = Buffer.from(record('response_item', { type: 'function_call', call_id: 'call2', name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo café' }) }));
    const split = rec.indexOf(Buffer.from('é')) + 1;
    await fs.appendFile(main, rec.subarray(0, split)); await pause(300);
    assert.equal((await state()).sessions.find(x => x.id === 'codex:shared-id').tools, 1);
    await fs.appendFile(main, rec.subarray(split));
    s = await until(s => s.sessions.find(x => x.id === 'codex:shared-id')?.tools === 2);
    assert.equal(s.sessions.find(x => x.id === 'codex:shared-id').currentTool.summary, 'echo café');
    await fs.appendFile(main, record('response_item', { type: 'function_call', call_id: 'ask', name: 'request_user_input', arguments: '{}' }));
    await until(s => s.sessions.find(x => x.id === 'codex:shared-id')?.status === 'needs-you');
    await fs.appendFile(main, record('response_item', { type: 'function_call_output', call_id: 'ask', output: 'PRIVATE_OUTPUT' }) + record('event_msg', { type: 'task_complete' }));
    s = await until(s => s.sessions.find(x => x.id === 'codex:shared-id')?.status === 'idle');
    assert.equal(s.sessions.find(x => x.id === 'codex:shared-id').currentTool, null);
    assert.ok(!JSON.stringify(s).includes('PRIVATE_OUTPUT'));
  });
  await t.test('expired session resumes and a newly created rollout is discovered', async () => {
    await fs.appendFile(stale, record('event_msg', { type: 'task_started' }));
    await until(s => s.sessions.find(x => x.id === 'codex:stale')?.status === 'busy');
    await fs.writeFile(path.join(logs, 'rollout-new.jsonl'), meta('new') + record('event_msg', { type: 'task_started' }));
    s = await until(s => s.sessions.some(x => x.id === 'codex:new'));
    assert.deepEqual(s.sessions.find(x => x.id === 'codex:new').tokens, zero);
    assert.equal(s.sessions.find(x => x.id === 'codex:new').context, null);
  });
  await t.test('usage survives a server restart without duplication', async () => {
    const before = (await state()).totals.tokensToday;
    await stop(); start();
    s = await until(s => s.sessions.find(x => x.id === 'codex:shared-id')?.subagents.length === 2 && s.sessions.find(x => x.id === 'codex:stale')?.status === 'busy');
    assert.deepEqual(s.totals.tokensToday, before);
    assert.equal(s.sessions.find(x => x.id === 'codex:shared-id').status, 'idle');
    assert.equal(errors, '');
  });
  await t.test('truncated rollouts reset usage and model without losing attachment', async () => {
    await fs.writeFile(main, meta('shared-id') + record('turn_context', { model: 'replacement-model' }) +
      record('event_msg', { type: 'task_started' }) + record('response_item', { type: 'custom_tool_call', call_id: 'patch', name: 'apply_patch', input: 'PRIVATE_PATCH' }));
    s = await until(s => s.sessions.find(x => x.id === 'codex:shared-id')?.model === 'replacement-model');
    const parent = s.sessions.find(x => x.id === 'codex:shared-id');
    assert.deepEqual(parent.tokens, zero); assert.equal(parent.context, null);
    assert.equal(parent.tools, 1); assert.equal(parent.currentTool.summary, 'Apply file changes');
    assert.ok(!JSON.stringify(s).includes('PRIVATE_PATCH'));
  });
});

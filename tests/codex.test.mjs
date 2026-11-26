import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startHud, pause, said as saidLine } from './helpers.mjs';

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

test('Claude and Codex coexist, update incrementally, and survive restart', { timeout: 60000 }, async t => {
  const hud = await startHud({ start: false });
  t.after(() => hud.close());
  const { dir, codex, claude, extraCodex, base, state, until } = hud;
  const logs = path.join(codex, 'sessions', '2026', '11', '04');
  await fs.mkdir(logs, { recursive: true });
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
  // Old conversations reopened by the editor: the process and the transcript's mtime are new, the dated lines are not.
  const longAgo = new Date(Date.now() - 10 * 86400000), deadPid = 4194303;
  const convo = path.join(claude, 'projects', 'p');
  const said = (id, at, extra = {}) => saidLine(id, at, { cwd: dir, ...extra });
  const agent = async (id, agentId, mtime) => {
    const sub = path.join(convo, id, 'subagents');
    await fs.mkdir(sub, { recursive: true });
    const metaFile = path.join(sub, `agent-${agentId}.meta.json`);
    await fs.writeFile(metaFile, JSON.stringify({ toolUseId: `tu-${agentId}`, agentType: 'general-purpose', description: agentId, spawnDepth: 1, finished: true }));
    await fs.utimes(metaFile, mtime, mtime);
  };
  await fs.mkdir(convo, { recursive: true });
  await fs.writeFile(path.join(convo, 'old-closed.jsonl'), said('old-closed', longAgo) + '{"type":"cost-state"}\n');
  await fs.writeFile(path.join(convo, 'old-open.jsonl'), said('old-open', longAgo) + '{"type":"cost-state"}\n');
  await fs.writeFile(path.join(convo, 'recent-closed.jsonl'), JSON.stringify({ type: 'user', sessionId: 'recent-closed', timestamp: stamp(), message: { content: 'hi' } }) + '\n');
  await agent('old-open', 'last-week', longAgo);
  await fs.writeFile(path.join(convo, 'old-open', 'subagents', 'agent-last-week.jsonl'), said('old-open', longAgo, { agentId: 'last-week' }));
  await agent('old-open', 'this-run', new Date());
  await fs.writeFile(path.join(claude, 'sessions', '2.json'), JSON.stringify({ sessionId: 'old-open', pid: process.pid, cwd: dir, status: 'idle', startedAt: Date.now() }));
  await fs.writeFile(path.join(claude, 'sessions', '3.json'), JSON.stringify({ sessionId: 'old-closed', pid: deadPid, cwd: dir, status: 'idle', startedAt: Date.now() }));
  await fs.writeFile(path.join(claude, 'sessions', '4.json'), JSON.stringify({ sessionId: 'recent-closed', pid: deadPid, cwd: dir, status: 'idle', startedAt: Date.now() }));
  await fs.writeFile(path.join(claude, 'sessions', '5.json'), JSON.stringify({ sessionId: 'never-worked', pid: deadPid, cwd: dir, status: 'idle', startedAt: Date.now() }));
  await hud.restart();
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
  await t.test('conversations and subagents from long ago are not shown as just ended', async () => {
    s = await until(s => s.sessions.find(x => x.id === 'recent-closed')?.status === 'ended' && s.sessions.find(x => x.id === 'old-open')?.subagents.length);
    assert.equal(s.sessions.some(x => x.id === 'old-closed'), false, 'last worked 10 days ago, process closed just now');
    assert.equal(s.sessions.some(x => x.id === 'never-worked'), false, 'no transcript and no work');
    const open = s.sessions.find(x => x.id === 'old-open');
    assert.equal(open.status, 'idle');
    assert.deepEqual(open.subagents.map(a => a.id), ['this-run'], 'the subagent of an earlier run is not listed');
    assert.deepEqual(open.tokensTree, { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 }, 'its tokens still count');
  });
  await t.test('HTTP health and SSE', async () => {
    assert.equal((await (await fetch(base + '/api/health')).json()).version, '0.3.0');
    const stream = await hud.stream();
    try {
      assert.match(stream.headers.get('content-type'), /text\/event-stream/);
      const first = await stream.next();
      assert.equal(first.event, 'state');
      assert.ok(Array.isArray(first.data.sessions));
    } finally { stream.close(); }
  });
  await t.test('large records split across reads, UTF-8, tool output discard, questions and turn completion', async () => {
    const rec = Buffer.from(record('response_item', {
      type: 'function_call', call_id: 'call2', name: 'exec_command',
      arguments: JSON.stringify({ padding: 'x'.repeat(384 * 1024), cmd: 'echo café' }),
    }));
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
    await hud.restart();
    s = await until(s => s.sessions.find(x => x.id === 'codex:shared-id')?.subagents.length === 2 && s.sessions.find(x => x.id === 'codex:stale')?.status === 'busy');
    assert.deepEqual(s.totals.tokensToday, before);
    assert.equal(s.sessions.find(x => x.id === 'codex:shared-id').status, 'idle');
    assert.equal(hud.stderr(), '');
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

// Hook replay: posts hook events, as `node hud.mjs hook` sends them, to a HUD over temp folders and checks the state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startHud, pause } from './helpers.mjs';

let n = 0;
const sid = () => `hook-test-${process.pid}-${++n}`;

test('hook events drive the session state', { timeout: 60000 }, async t => {
  const hud = await startHud();
  t.after(() => hud.close());
  const ev = (session_id, hook_event_name, extra = {}) =>
    hud.post({ session_id, hook_event_name, cwd: hud.dir, hud_at: Date.now(), ...extra });
  const find = (s, id) => s.sessions.find(x => x.id === id);

  await t.test('a PreToolUse sets the current tool', async () => {
    const id = sid();
    assert.equal(await ev(id, 'UserPromptSubmit'), 204);
    assert.equal(await ev(id, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu-bash-1', tool_input: { command: 'npm test' } }), 204);
    const s = await hud.until(s => find(s, id)?.currentTool);
    const session = find(s, id);
    assert.equal(session.status, 'busy');
    assert.equal(session.currentTool.name, 'Bash');
    assert.equal(session.tools, 1);
  });

  await t.test('Stop clears the current tool', async () => {
    const id = sid();
    await ev(id, 'UserPromptSubmit');
    await ev(id, 'PreToolUse', { tool_name: 'Read', tool_use_id: 'tu-read-1', tool_input: { file_path: path.join(hud.dir, 'a.txt') } });
    await hud.until(s => find(s, id)?.currentTool?.name === 'Read');
    await ev(id, 'Stop');
    const s = await hud.until(s => find(s, id)?.status === 'idle');
    assert.equal(find(s, id).currentTool, null);
    assert.ok(s.feed.some(l => l.sessionId === id && l.kind === 'done' && l.text === 'Turn finished'));
  });

  await t.test('a Notification with permission_prompt gives needs-you', async () => {
    const id = sid();
    await ev(id, 'UserPromptSubmit');
    await ev(id, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu-bash-2', tool_input: { command: 'git status' } });
    await ev(id, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    const s = await hud.until(s => find(s, id)?.status === 'needs-you');
    assert.deepEqual({ kind: find(s, id).needsYou.kind, reason: find(s, id).needsYou.reason }, { kind: 'permission', reason: 'Permission: Bash' });
    assert.equal(s.totals.needsYou, 1);
    await ev(id, 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu-bash-2' });
    await hud.until(s => find(s, id)?.status === 'busy');
  });

  await t.test('an Agent call with SubagentStart and SubagentStop gives one finished subagent', async () => {
    const id = sid();
    await ev(id, 'UserPromptSubmit');
    await ev(id, 'PreToolUse', { tool_name: 'Agent', tool_use_id: 'tu-agent-1',
      tool_input: { description: 'P1 test harness', subagent_type: 'general-purpose' } });
    await ev(id, 'SubagentStart', { agent_id: 'a1b2c3d4e5f6a7b8c', agent_type: 'general-purpose' });
    let s = await hud.until(s => find(s, id)?.subagents.length === 1);
    assert.equal(find(s, id).subagents[0].state, 'running');
    await ev(id, 'PreToolUse', { agent_id: 'a1b2c3d4e5f6a7b8c', agent_type: 'general-purpose', tool_name: 'Grep', tool_use_id: 'tu-grep-1', tool_input: { pattern: 'onHook' } });
    await ev(id, 'PostToolUse', { agent_id: 'a1b2c3d4e5f6a7b8c', agent_type: 'general-purpose', tool_name: 'Grep', tool_use_id: 'tu-grep-1' });
    await ev(id, 'SubagentStop', { agent_id: 'a1b2c3d4e5f6a7b8c', agent_type: 'general-purpose' });
    await ev(id, 'PostToolUse', { tool_name: 'Agent', tool_use_id: 'tu-agent-1', tool_response: { agentId: 'a1b2c3d4e5f6a7b8c', status: 'completed' } });
    s = await hud.until(s => find(s, id)?.subagents[0]?.state === 'done');
    const subs = find(s, id).subagents;
    assert.equal(subs.length, 1);
    assert.deepEqual({ id: subs[0].id, description: subs[0].description, type: subs[0].type, parentId: subs[0].parentId },
      { id: 'a1b2c3d4e5f6a7b8c', description: 'P1 test harness', type: 'general-purpose', parentId: id });
    assert.ok(subs[0].endedAt);
    assert.equal(s.feed.filter(l => l.sessionId === id && l.text.startsWith('Agent done')).length, 1);
  });

  assert.equal(hud.stderr(), '');
});

test('HUD_RECORD writes each accepted event, redacted, and nothing when unset', { timeout: 60000 }, async t => {
  const recorded = await startHud({ env: dir => ({ HUD_RECORD: path.join(dir, 'events.jsonl') }) });
  const plain = await startHud();
  t.after(async () => { await recorded.close(); await plain.close(); });
  const event = { session_id: 'record-1', hook_event_name: 'PreToolUse', cwd: recorded.dir, tool_name: 'Bash', tool_use_id: 'tu-1',
    tool_input: { command: 'curl -H "Authorization: Bearer madeUpBearer123" --password hunter2-made-up https://example.test' } };
  assert.equal(await recorded.post(event), 204);
  assert.equal(await recorded.post('not an object'), 204);   // accepted JSON is recorded as it came, redacted
  assert.equal(await plain.post({ ...event, session_id: 'record-2', cwd: plain.dir }), 204);
  await recorded.until(s => s.sessions.some(x => x.id === 'record-1'));
  await plain.until(s => s.sessions.some(x => x.id === 'record-2'));

  const readLines = async () => (await fs.readFile(path.join(recorded.dir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean);
  const lines = await readLines();
  assert.equal(lines.length, 2);
  const got = JSON.parse(lines[0]);
  assert.equal(got.session_id, 'record-1');
  assert.equal(got.hook_event_name, 'PreToolUse');
  assert.ok(!lines[0].includes('madeUpBearer123') && !lines[0].includes('hunter2-made-up'), lines[0]);
  assert.match(got.tool_input.command, /Bearer •••/);
  assert.match(got.tool_input.command, /--password •••/);

  // A bad body is refused, not recorded.
  const bad = await fetch(recorded.base + '/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' });
  assert.equal(bad.status, 400);
  await pause(100);
  assert.equal((await readLines()).length, 2);

  // Unset: no file anywhere in the HUD's folders.
  const all = await fs.readdir(plain.dir, { recursive: true });
  assert.deepEqual(all.filter(f => f.endsWith('.jsonl')), []);
  assert.equal(recorded.stderr() + plain.stderr(), '');
});

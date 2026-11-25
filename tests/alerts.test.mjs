import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startHud, transcript } from './helpers.mjs';

const MINUTE = 60_000;
const currentMinute = () => Math.floor(Date.now() / MINUTE) * MINUTE;
const session = (state, id) => state.sessions.find(s => s.id === id);
const warning = (state, kind, id) => state.alerts.find(a => a.kind === kind && a.sessionId === id);
const contextSteps = (state, id) => state.alerts.filter(a => a.kind === 'context' && a.sessionId === id).map(a => Number(a.id.split(':').at(-1)));
const usageWindows = state => state.alerts.filter(a => a.kind === 'usage').map(a => a.id.split(':').at(-1));
const hook = async (hud, id, event, fields = {}) => {
  assert.equal(await hud.post({ session_id: id, hook_event_name: event, cwd: hud.dir, ...fields }), 204);
};
const assistant = (sessionId, id, at, { input = 0, output = 0, content } = {}) => ({
  type: 'assistant', sessionId, timestamp: new Date(at).toISOString(),
  message: { id, model: 'claude-opus-5-5', usage: { input_tokens: input, output_tokens: output }, content },
});

test('context warnings latch at 80% and 90%, and clear below 75% and 85%', async t => {
  const hud = await startHud();
  t.after(() => hud.close());
  const id = 'context-test';
  const file = await transcript(hud, id, [assistant(id, 'ctx', Date.now(), { input: 799_000 })]);
  await hook(hud, id, 'UserPromptSubmit', { transcript_path: file });
  assert.deepEqual(contextSteps(await hud.until(s => session(s, id)?.context?.pct === 79.9), id), []);
  const readPct = async pct => {
    await transcript(hud, id, [assistant(id, 'ctx', Date.now(), { input: Math.round(pct * 10_000) })]);
    return hud.until(s => session(s, id)?.context?.pct === pct);
  };
  const first = warning(await readPct(80), 'context', id);
  assert.ok(first.id.endsWith(':80'));
  assert.deepEqual(contextSteps(await readPct(89.9), id), [80]);
  assert.deepEqual(contextSteps(await readPct(90), id), [80, 90]);
  assert.deepEqual(contextSteps(await readPct(85), id), [80, 90]);
  assert.deepEqual(contextSteps(await readPct(84.9), id), [80]);
  const held = await readPct(75);
  assert.deepEqual(warning(held, 'context', id), first, 'the first warning keeps its id and timestamp');
  assert.deepEqual(contextSteps(await readPct(74.9), id), []);
  assert.deepEqual(contextSteps(await readPct(79.9), id), []);
  const back = warning(await readPct(80), 'context', id);
  assert.equal(back.id, first.id);
  assert.ok(back.since > first.since, 'a new warning starts after the condition clears');
  await hook(hud, id, 'SessionEnd');
  assert.deepEqual(contextSteps(await hud.state(), id), []);
});

test('only a busy session with a foreground tool warns at 10 minutes', { timeout: 15000 }, async t => {
  const hud = await startHud();
  t.after(() => hud.close());
  const stream = await hud.stream();
  t.after(() => stream.close());
  const id = 'tool-test';
  const began = Date.now() - 10 * MINUTE + 3000;
  const tool = { tool_name: 'Bash', tool_use_id: 'foreground', tool_input: { command: 'long test' } };
  await hook(hud, id, 'PreToolUse', { ...tool, hud_at: began });
  await hook(hud, id, 'Notification');
  const before = await hud.state();
  assert.equal(session(before, id).status, 'busy');
  assert.equal(warning(before, 'tool', id), undefined);
  const raised = await stream.next(e => e.event === 'state' && warning(e.data, 'tool', id));
  assert.equal(warning(raised.data, 'tool', id).since, began + 10 * MINUTE);
  await hook(hud, id, 'Notification', { notification_type: 'permission_prompt', message: 'Permission to use Bash' });
  const waiting = await hud.state();
  assert.equal(session(waiting, id).status, 'needs-you');
  assert.equal(warning(waiting, 'tool', id), undefined);
  await hook(hud, id, 'PostToolUse', tool);
  assert.equal(warning(await hud.state(), 'tool', id), undefined);

  const stale = Date.now() - 11 * MINUTE;
  const skipped = [
    ['agent-tool', 'Agent', {}],
    ['task-tool', 'Task', {}],
    ['background-tool', 'Bash', { run_in_background: 'true' }],
  ];
  for (const [sessionId, name, input] of skipped) {
    await hook(hud, sessionId, 'PreToolUse', { tool_name: name, tool_use_id: sessionId, tool_input: input, hud_at: stale });
    await hook(hud, sessionId, 'Notification');
  }
  const idle = 'interrupted-tool';
  const call = { type: 'tool_use', id: 'missing-result', name: 'Bash', input: { command: 'interrupted test' } };
  const file = await transcript(hud, idle, [assistant(idle, 'call', stale, { content: [call] })]);
  await hook(hud, idle, 'PreToolUse', { ...tool, transcript_path: file, hud_at: stale });
  await hook(hud, idle, 'Stop');
  const stopped = await hud.until(s => session(s, idle)?.tools === 2 && session(s, idle).status === 'idle');
  assert.equal(warning(stopped, 'tool', idle), undefined);
  await hook(hud, idle, 'UserPromptSubmit');
  const resumed = await hud.state();
  assert.equal(session(resumed, idle).currentTool, null, 'the new turn cannot inherit the interrupted tool');
  for (const [sessionId] of skipped) assert.equal(session(resumed, sessionId).status, 'busy');
  assert.deepEqual(resumed.alerts.filter(a => a.kind === 'tool'), []);

  const bgTranscript = 'background-transcript';
  const bgCall = { ...call, id: 'background-call', input: { run_in_background: true } };
  const bgFile = await transcript(hud, bgTranscript, [assistant(bgTranscript, 'bg', stale, { content: [bgCall] })]);
  await hook(hud, bgTranscript, 'UserPromptSubmit', { transcript_path: bgFile, hud_at: stale });
  await hook(hud, bgTranscript, 'Notification');
  const bg = await hud.until(s => session(s, bgTranscript)?.currentTool?.name === 'Bash');
  assert.equal(warning(bg, 'tool', bgTranscript), undefined);
});

test('a running subagent can warn at five minutes while its parent waits, and activity clears it', { timeout: 15000 }, async t => {
  const hud = await startHud();
  t.after(() => hud.close());
  const id = 'silent-agent-test';
  const worker = { agent_id: 'reviewer', agent_type: 'Explore' };
  const began = Date.now() - 5 * MINUTE + 3000;
  await hook(hud, id, 'SubagentStart', { ...worker, hud_at: began });
  await hook(hud, id, 'Stop');
  const before = await hud.state();
  assert.equal(session(before, id).status, 'idle');
  assert.equal(session(before, id).agentsRunning, 1);
  assert.equal(warning(before, 'subagent', id), undefined);
  const quiet = await hud.until(s => warning(s, 'subagent', id));
  assert.equal(warning(quiet, 'subagent', id).agentId, worker.agent_id);
  assert.equal(warning(quiet, 'subagent', id).since, began + 5 * MINUTE);
  await hook(hud, id, 'PostToolUse', { ...worker, tool_name: 'Read' });
  assert.equal(warning(await hud.state(), 'subagent', id), undefined);
  await hook(hud, id, 'SubagentStop', worker);
  const done = await hud.until(s => session(s, id).subagents[0].state === 'done');
  assert.equal(warning(done, 'subagent', id), undefined);
});

test('5-hour and weekly account warnings start at 90%, clear below it and respect resets', { timeout: 25000 }, async t => {
  const hud = await startHud({ start: false });
  t.after(() => hud.close());
  const file = path.join(hud.claude, '.claude.json');
  const write = (fetchedAtMs, hour, week, resetsAt) => fs.writeFile(file, JSON.stringify({ cachedUsageUtilization: {
    fetchedAtMs, utilization: { five_hour: { utilization: hour }, seven_day: { utilization: week, resets_at: resetsAt } },
  } }));
  await write(1, 90, 89.9);
  await hud.restart();
  assert.deepEqual(usageWindows(await hud.until(s => s.account?.fetchedAt === 1)), ['fiveHour']);
  await write(2, 89.9, 90, new Date(Date.now() + 15_000).toISOString());
  assert.deepEqual(usageWindows(await hud.until(s => s.account?.fetchedAt === 2)), ['sevenDay']);
  const reset = await hud.until(s => s.account?.fetchedAt === 2 && s.alerts.every(a => a.kind !== 'usage'));
  assert.equal(reset.account.sevenDay.pct, 90, 'the warning expires even if the cached percentage stays high');
});

test('Claude pulse counts repeated usage once, drops old minutes and retains the last completed turn', async t => {
  const hud = await startHud();
  t.after(() => hud.close());
  const id = 'pulse-test', now = currentMinute();
  const old = now - 31 * MINUTE, earlier = now - 5 * MINUTE, latest = now - 3 * MINUTE;
  const file = await transcript(hud, id, [
    assistant(id, 'expired', old, { output: 330 }),
    assistant(id, 'separate', earlier, { output: 5 }),
    assistant(id, 'repeated', latest - 5, { output: 12 }),
    assistant(id, 'repeated', latest, { output: 82 }),
    assistant(id, 'repeated', latest + 100, { output: 82 }),
  ]);
  await hook(hud, id, 'UserPromptSubmit', { transcript_path: file, hud_at: earlier });
  const s = session(await hud.until(s => session(s, id)?.tokens.output === 417), id);
  assert.deepEqual(s.pulse, { start: earlier, perMin: [5, 0, 82] });
  assert.deepEqual(s.turn, { startedAt: earlier, lastMs: null });
  await hook(hud, id, 'Stop', { hud_at: latest });
  await hook(hud, id, 'Stop', { hud_at: latest + 1000 });
  assert.deepEqual(session(await hud.state(), id).turn, { startedAt: null, lastMs: 2 * MINUTE });

  const worker = { agent_id: 'pulse-worker', agent_type: 'Explore' };
  const childFile = await transcript(hud, 'child-pulse-file', [assistant(id, 'child-use', latest, { output: 13 })]);
  await hook(hud, id, 'SubagentStart', worker);
  await hook(hud, id, 'SubagentStop', { ...worker, agent_transcript_path: childFile });
  const tree = await hud.until(s => session(s, id)?.subagents[0]?.tokens.output === 13);
  assert.deepEqual(session(tree, id).subagents[0].pulse, { start: latest, perMin: [13] });
  assert.deepEqual(session(tree, id).pulse, s.pulse);
});

test('Codex pulse uses cumulative deltas and task events time the turn', async t => {
  const hud = await startHud({ start: false });
  t.after(() => hud.close());
  const dir = path.join(hud.codex, 'sessions');
  await fs.mkdir(dir);
  const file = path.join(dir, 'rollout-pulse.jsonl');
  const id = 'codex-pulse', key = 'codex:' + id, minute = currentMinute() - MINUTE;
  const start = minute + 2000, finish = minute + 24_000;
  const line = (type, payload, at) => JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload }) + '\n';
  const count = (tokens, at) => line('event_msg', { type: 'token_count', info: { total_token_usage: { output_tokens: tokens } } }, at);
  await fs.writeFile(file, line('session_meta', { id, cwd: hud.dir, model_provider: 'openai' }, start) +
    line('event_msg', { type: 'task_started' }, start) + count(9, start + 1000) + count(9, start + 1100) + count(14, start + 1200));
  await hud.restart();
  const running = session(await hud.until(s => session(s, key)?.tokens.output === 14), key);
  assert.deepEqual(running.pulse, { start: minute, perMin: [14] });
  assert.deepEqual(running.turn, { startedAt: start, lastMs: null });
  await fs.appendFile(file, line('event_msg', { type: 'task_complete' }, finish));
  const idle = session(await hud.until(s => session(s, key)?.status === 'idle'), key);
  assert.deepEqual(idle.turn, { startedAt: null, lastMs: finish - start });
});

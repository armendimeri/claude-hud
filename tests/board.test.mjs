import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { board, registry, script, startHud, transcript } from './helpers.mjs';

const standard = (...rows) => `# Test plan: status

## Board

| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |
|---|---|---|---|---|---|---|---|---|
${rows.map(([id, state = 'todo', deps = '', agent = 'worker']) =>
    `| ${id} | Item ${id} | ${agent} | ${deps} | | ${state} | | | |`).join('\n')}
`;
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const agentCall = (id, description, prompt) => tool(id, 'Agent', { description, prompt, subagent_type: 'general-purpose' });
const user = content => ({ type: 'user', message: { content } });
const assistant = (...content) => ({ type: 'assistant', gitBranch: 'main', message: { model: 'claude-opus-5-5', content } });
const title = customTitle => ({ type: 'custom-title', customTitle });
const session = (state, id) => state.sessions.find(s => s.id === id);
const plan = (state, key) => state.plans.find(p => `${p.project}|${p.slug}` === key);
const workItem = (plan, id, via) => ({ plan, id, via });
const has = (rows, plan, id) => rows.some(row => row.plan === plan && row.id === id);
const flags = (state, plan, id) => state.board.items[`${plan}#${id}`]?.flags || [];

async function fixture(t, options) {
  const hud = await startHud({ start: false, ...options });
  t.after(() => hud.close());
  return hud;
}

async function project(hud, name) {
  const dir = path.join(hud.dir, name);
  await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fs.mkdir(path.join(dir, '.git'));
  return dir;
}

function append(hud, cwd, sessionId, ...lines) {
  return transcript(hud, sessionId, lines.map(line => ({ cwd, sessionId, timestamp: new Date().toISOString(), ...line })),
    { project: cwd.replace(/[^A-Za-z0-9]/g, '-') });
}

async function live(hud, cwd, id, file = '93001.json') {
  await registry(hud, id, { pid: process.pid, file, cwd, status: 'busy' });
}

function hook(cwd, session_id, hook_event_name, extra = {}) {
  return { cwd, session_id, hook_event_name, hud_at: Date.now(), ...extra };
}

async function post(hud, ...args) {
  assert.equal(await hud.post(hook(...args)), 204);
}

function linkProjection(state, cwd, id) {
  const s = session(state, id), prefix = `${path.basename(cwd)}|`;
  const items = Object.fromEntries(Object.entries(state.board.items)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, { agents, flags }]) => [key, { agents, flags }]));
  return JSON.parse(JSON.stringify({ work: s.work, subagents: s.subagents.map(a => a.work), items })
    .replaceAll(prefix, 'project|').replaceAll(id, 'session'));
}

test('board links are independent of whether the board or the transcript appears first', async t => {
  const hud = await fixture(t);
  const first = await project(hud, 'board-first'), second = await project(hud, 'transcript-first');
  const contents = standard(['P1', 'in-progress'], ['P2', 'in-progress']);
  const evidence = [title('Implement fixtures'), user('Do arrival/P1.'), assistant(agentCall('tu-arrival', 'Second worker', 'Do arrival/P2.'))];
  await board({ dir: first }, 'arrival', contents);
  await append(hud, first, 'run-first', ...evidence);
  await live(hud, first, 'run-first');
  await hud.restart();
  const before = await hud.until(s => session(s, 'run-first')?.subagents[0]?.work?.items[0]?.id === 'P2');

  await append(hud, second, 'run-second', ...evidence);
  await live(hud, second, 'run-second', '93002.json');
  const unlinked = await hud.until(s => session(s, 'run-second')?.subagents.length === 1);
  assert.equal(session(unlinked, 'run-second').work, null);
  assert.equal(session(unlinked, 'run-second').subagents[0].work, null);
  await board({ dir: second }, 'arrival', contents);
  const after = await hud.until(s => session(s, 'run-second')?.subagents[0]?.work?.items[0]?.id === 'P2');
  assert.deepEqual(linkProjection(before, first, 'run-first'), linkProjection(after, second, 'run-second'));
  assert.deepEqual(session(after, 'run-second').work, {
    plan: 'transcript-first|arrival', items: [workItem('transcript-first|arrival', 'P1', 'ref')], role: 'coordinator',
  });
});

test('restart rebuilds transcript links and starts with fresh history and mark clocks', async t => {
  const hud = await fixture(t, { env: { HUD_UNCLAIMED_MS: '1700' } });
  const cwd = await project(hud, 'restart-project'), id = 'restart-session';
  const home = 'restart-project|restart', other = 'restart-project|secondary';
  await board({ dir: cwd }, 'restart', standard(['P1']));
  const target = await board({ dir: cwd }, 'secondary', standard(['P2', 'handed-off']));
  const file = await append(hud, cwd, id, title('Fixture session'), user('Do restart/P1.'),
    assistant(agentCall('tu-restart', 'P2 second task', 'Take the second task.')));
  const subdir = path.join(path.dirname(file), id, 'subagents');
  await fs.mkdir(subdir, { recursive: true });
  await fs.writeFile(path.join(subdir, 'agent-board-worker.meta.json'),
    JSON.stringify({ toolUseId: 'tu-restart', agentType: 'general-purpose', description: 'P2 second task' }));
  await fs.writeFile(path.join(subdir, 'agent-board-worker.jsonl'),
    JSON.stringify({ ...assistant(tool('tu-board-write', 'Edit', { file_path: target })), sessionId: id, timestamp: new Date().toISOString() }) + '\n');
  await live(hud, cwd, id);
  await hud.restart();

  await hud.until(s => session(s, id)?.subagents[0]?.work?.plan === other && flags(s, home, 'P1').includes('unclaimed'));
  await board({ dir: cwd }, 'secondary', standard(['P2', 'in-progress']));
  const before = await hud.until(s => plan(s, other)?.history.length === 1);
  assert.deepEqual(session(before, id).subagents[0].work.items, [workItem(other, 'P2', 'name')]);
  assert.ok(before.board.items[other + '#P2'].agents.some(agent => agent.agentId === 'board-worker' && agent.active));
  assert.deepEqual(plan(before, other).history[0], {
    at: plan(before, other).history[0].at, id: 'P2', from: 'handed-off', to: 'in-progress', sessionId: id, agentId: 'board-worker',
  });
  assert.ok(before.feed.some(line => line.kind === 'plan' && line.text === 'Test plan: P2 claimed by P2 second task'));
  await hud.restart();
  const after = await hud.until(s => session(s, id)?.subagents[0]?.work?.plan === other);
  assert.deepEqual(session(after, id).work, session(before, id).work);
  assert.deepEqual(session(after, id).subagents[0].work, session(before, id).subagents[0].work);
  for (const key of [`${home}#P1`, `${other}#P2`]) assert.deepEqual(after.board.items[key].agents, before.board.items[key].agents);
  assert.deepEqual(plan(after, other).history, []);
  assert.ok(after.board.items[`${home}#P1`].since > before.board.items[`${home}#P1`].since);
  assert.deepEqual(flags(after, home, 'P1'), []);
});

test('repeated IDs need a plan and an explicit reference overrides a file touch', async t => {
  const hud = await fixture(t);
  const cwd = await project(hud, 'payments'), id = 'payments-session';
  await board({ dir: cwd }, 'pay-a', standard(['P6-02']));
  const target = await board({ dir: cwd }, 'pay-b', standard(['P6-02']));
  await append(hud, cwd, id, title('P6-02 partial payments'), user('Review P6-02.'));
  await live(hud, cwd, id);
  await hud.restart();
  const ambiguous = await hud.until(s => s.plans.length === 2 && session(s, id)?.title === 'P6-02 partial payments');
  assert.equal(session(ambiguous, id).work, null);
  await append(hud, cwd, id, assistant(tool('tu-pay-read', 'Read', { file_path: target })));
  const byFile = await hud.until(s => session(s, id)?.work?.plan === 'payments|pay-b');
  assert.deepEqual(session(byFile, id).work.items, [workItem('payments|pay-b', 'P6-02', 'name')]);
  await append(hud, cwd, id, user([{ type: 'text', text: 'Do pay-a/P6-02.' }]));
  const byRef = await hud.until(s => session(s, id)?.work?.plan === 'payments|pay-a');
  assert.deepEqual(session(byRef, id).work.items, [workItem('payments|pay-a', 'P6-02', 'ref')]);
});

test('a transcript prompt listing six bare IDs assigns no work', async t => {
  const hud = await fixture(t);
  const cwd = await project(hud, 'mentions'), id = 'mention-session';
  const ids = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
  await board({ dir: cwd }, 'all-ids', standard(...ids.map(x => [x])));
  await append(hud, cwd, id, user(`Review ${ids.join(', ')}.`), title('Review the board'));
  await live(hud, cwd, id);
  await hud.restart();
  const state = await hud.until(s => s.plans.length === 1 && session(s, id)?.title === 'Review the board');
  assert.equal(session(state, id).work, null);
  assert.deepEqual(state.board.items, {});
});

test('older chunk and phase boards can have links and marks without queue entries', async t => {
  const hud = await fixture(t, { env: { HUD_UNCLAIMED_MS: '300', HUD_STALLED_MS: '600' } });
  const cwd = await project(hud, 'legacy'), id = 'legacy-session';
  const docs = path.join(cwd, 'docs');
  await fs.writeFile(path.join(docs, 'STATUS.md'), `# Old chunks

| Chunk | Title | Status |
|---|---|---|
| UX-10 | Forms | todo |
| UX-11 | Review | in progress (2026-10-29) |
| UX-12 | Build | handed off |
| UX-13 | Later | todo |
`);
  await fs.mkdir(path.join(docs, 'other'));
  await fs.writeFile(path.join(docs, 'other', 'STATUS.md'), `# Old phases

| Phase | State |
|---|---|
| P1 Data | In progress (2026-10-29) |
| P2 Review | todo |
`);
  await append(hud, cwd, id, title('UX-10 Forms'));
  await live(hud, cwd, id);
  await hud.restart();
  const a = 'legacy|docs/STATUS', b = 'legacy|docs/other/STATUS';
  const state = await hud.until(s => flags(s, a, 'UX-10').includes('unclaimed') &&
    flags(s, a, 'UX-11').includes('stalled') && flags(s, b, 'P1').includes('stalled'));
  assert.deepEqual(session(state, id).work.items, [workItem(a, 'UX-10', 'name')]);
  assert.deepEqual(state.plans.map(p => p.format), ['legacy', 'legacy']);
  assert.deepEqual([state.board.ready, state.board.awaiting, state.board.ownerInputs], [[], [], []]);
});

test('board touches handle Windows case and slash variants and worktrees share the main plan', async t => {
  const hud = await fixture(t);
  const main = await project(hud, 'main'), wt = path.join(hud.dir, 'worktree'), id = 'worktree-session';
  await fs.mkdir(path.join(wt, 'docs', 'plans', 'pay-b'), { recursive: true });
  await fs.writeFile(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'worktree')}\n`);
  await board({ dir: main }, 'pay-a', standard(['P6-02']));
  const mainBoard = await board({ dir: main }, 'pay-b', standard(['P6-02']));
  const wtBoard = path.join(wt, 'docs', 'plans', 'pay-b', 'STATUS.md');
  const input = process.platform === 'win32' ? wtBoard.toUpperCase().replaceAll('\\', '/') : wtBoard;
  await append(hud, wt, id, title('P6-02 partial payments'));
  await live(hud, wt, id);
  await hud.restart();
  const before = await hud.until(s => s.plans.length === 2 && session(s, id)?.title === 'P6-02 partial payments');
  assert.equal(session(before, id).work, null);
  await post(hud, wt, id, 'PreToolUse', { tool_name: 'Edit', tool_use_id: 'tu-wt-edit', tool_input: { file_path: input } });
  const key = 'main|pay-b';
  const after = await hud.until(s => session(s, id)?.work?.plan === key);
  assert.equal(plan(after, key).path, mainBoard);
  assert.deepEqual(session(after, id).work.items, [workItem(key, 'P6-02', 'name')]);
});

test('prompt text stays out of state and hook recordings while transcript references link', async t => {
  const file = 'record.jsonl';
  const hud = await fixture(t, { env: dir => ({ HUD_RECORD: path.join(dir, file) }) });
  const cwd = await project(hud, 'privacy'), id = 'privacy-session';
  const marker = 'private-fixture-marker';
  const prompt = `${marker} Do privacy-plan/P1.`, subPrompt = `${marker} Do privacy-plan/P2.`;
  await board({ dir: cwd }, 'privacy-plan', standard(['P1'], ['P2']));
  const transcript_path = await append(hud, cwd, id, title('Fixture session'), user(prompt),
    assistant(agentCall('tu-privacy', 'Worker', subPrompt)));
  await live(hud, cwd, id);
  await hud.restart();
  const userEvent = hook(cwd, id, 'UserPromptSubmit', { transcript_path, prompt });
  const agentEvent = hook(cwd, id, 'PreToolUse', {
    transcript_path, tool_name: 'Agent', tool_use_id: 'tu-privacy',
    tool_input: { description: 'Worker', subagent_type: 'general-purpose', prompt: subPrompt },
  });
  for (const event of [userEvent, agentEvent]) {
    const child = spawn(process.execPath, [script, 'hook'], {
      env: { ...process.env, HUD_PORT: String(hud.port) }, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.stdin.end(JSON.stringify(event));
    assert.deepEqual(await once(child, 'exit'), [0, null]);
    assert.equal(await hud.post(event), 204); // also cover callers posting a full payload directly
  }
  const state = await hud.until(s => session(s, id)?.subagents[0]?.work?.items[0]?.id === 'P2');
  const s = session(state, id), key = 'privacy|privacy-plan';
  assert.deepEqual(s.work.items, [workItem(key, 'P1', 'ref')]);
  assert.deepEqual(s.subagents[0].work.items, [workItem(key, 'P2', 'ref')]);
  const recorded = await fs.readFile(path.join(hud.dir, file), 'utf8');
  assert.equal(recorded.includes(marker) || JSON.stringify(state).includes(marker), false);
  const events = recorded.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.length, 4);
  assert.ok(events.every(e => !('prompt' in e) && !Object.hasOwn(e.tool_input || {}, 'prompt')));
});

test('all marks and queue lists turn on and off, with one feed event per mark', async t => {
  const hud = await fixture(t, { env: { HUD_UNCLAIMED_MS: '1000', HUD_STALLED_MS: '3000' } });
  const cwd = await project(hud, 'queue'), id = 'queue-session', key = 'queue|marks';
  const contents = ({ p1 = 'handed-off', p2 = 'todo', p4 = 'todo', input = 'todo' } = {}) =>
    standard(['P1', p1], ['P2', p2, 'P1'], ['P3', 'todo', 'O-1'], ['P4', p4, 'P2'], ['O-1', input, '', 'owner']);
  await board({ dir: cwd }, 'marks', contents());
  await live(hud, cwd, id);
  await hud.restart();
  const initial = await hud.until(s => s.uptime >= 5100 && !!plan(s, key));
  assert.deepEqual(initial.board.ready, [{ plan: key, id: 'P2', run: false }]);
  assert.deepEqual(initial.board.awaiting, [{ plan: key, id: 'P1' }]);
  assert.deepEqual(initial.board.ownerInputs, [{ plan: key, id: 'O-1', unlocks: ['P3'] }]);
  assert.deepEqual(initial.board.items, {});

  await post(hud, cwd, id, 'PreToolUse', { tool_name: 'Agent', tool_use_id: 'tu-marks', tool_input: { description: 'P2 second item' } });
  const active = await hud.until(s => s.board.items[`${key}#P2`]?.agents.some(a => a.active));
  assert.ok(!has(active.board.ready, key, 'P2'));
  assert.deepEqual(flags(active, key, 'P2'), []);
  await board({ dir: cwd }, 'marks', contents({ p1: 'accepted', p4: 'in-progress' }));
  const early = await hud.until(s => flags(s, key, 'P4').includes('early') && flags(s, key, 'P2').includes('unclaimed'));
  assert.deepEqual(flags(early, key, 'P4'), ['early']);
  assert.deepEqual(early.board.awaiting, []);
  await hud.until(s => flags(s, key, 'P4').includes('stalled'));

  await board({ dir: cwd }, 'marks', contents({ p1: 'accepted', p2: 'accepted', p4: 'in-progress', input: 'accepted' }));
  const clear = await hud.until(s => has(s.board.ready, key, 'P3'));
  assert.deepEqual(flags(clear, key, 'P2'), []);
  assert.deepEqual(flags(clear, key, 'P4'), []);
  assert.deepEqual(clear.board.ownerInputs, []);
  assert.deepEqual(clear.board.ready, [{ plan: key, id: 'P3', run: false }]);

  await board({ dir: cwd }, 'marks', contents({ p1: 'accepted', p4: 'in-progress' }));
  const again = await hud.until(s => flags(s, key, 'P4').includes('stalled') &&
    flags(s, key, 'P4').includes('early') && flags(s, key, 'P2').includes('unclaimed'));
  for (const message of ['P2 board not updated', 'P4 stalled', 'P4 started early']) {
    assert.equal(again.feed.filter(line => line.kind === 'plan' && line.text === `Test plan: ${message}`).length, 1);
  }
});

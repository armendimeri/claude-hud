// The lighter stream (PLAN hud-0-3 §4.4, P3): the first `state` of a connection is full, later ones carry neither
// plans nor feed, and a board edit gives one `plans` event. A HUD over temp folders (tests/helpers.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHud, pause, registry, board, transcript } from './helpers.mjs';

const BOARD = p1 => `# Stream test plan: status

## Board

| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |
|---|---|---|---|---|---|---|---|---|
| P1 | First item | first | — | — | ${p1} | | | |
| P2 | Second item | second | P1 | — | todo | | | |
`;
const p1State = plans => plans.find(p => p.slug.includes('stream-plan'))?.phases.find(n => n.id === 'P1')?.state;

test('the stream sends plans and feed only when they change', { timeout: 60000 }, async t => {
  const hud = await startHud({ start: false });
  t.after(() => hud.close());
  const id = `stream-test-${process.pid}`;
  // A live registry entry (this test's own process) whose cwd is the HUD's folder: the HUD finds the board there at
  // every start, so the plans survive restart().
  await board(hud, 'stream-plan', BOARD('todo'));
  await registry(hud, id, { pid: process.pid, file: '92001.json' });
  await hud.restart();
  const ev = (hook_event_name, extra = {}) => hud.post({ session_id: id, hook_event_name, cwd: hud.dir, hud_at: Date.now(), ...extra });
  const ready = await hud.until(s => s.sessions.some(x => x.id === id) && p1State(s.plans) === 'todo');
  assert.ok(Array.isArray(ready.feed), '/api/state has the feed');
  assert.ok(ready.plans.every(p => !('working' in p)), 'plans no longer carry working (the page counts it)');

  await t.test('the first state has plans and feed; later ones have neither; a board edit gives one plans event', async () => {
    const s = await hud.stream();
    t.after(() => s.close());
    const first = await s.next(e => e.event === 'state');
    assert.equal(s.events[0], first, 'the state is the first message');
    assert.equal(first.data.full, true, 'the first state is marked full');
    assert.ok(Array.isArray(first.data.plans) && first.data.plans.length === 1, 'the first state has the plans');
    assert.ok(Array.isArray(first.data.feed), 'the first state has the feed');

    // Session changes give later states.
    await ev('UserPromptSubmit');
    await ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu-stream-1', tool_input: { command: 'npm test' } });
    await s.next(e => e !== first && e.event === 'state' && e.data.sessions.find(x => x.id === id)?.currentTool?.name === 'Bash');
    await ev('Stop');
    await s.next(e => e !== first && e.event === 'state' && e.data.sessions.find(x => x.id === id)?.status === 'idle');
    assert.equal(s.events.filter(e => e.event === 'plans').length, 0, 'no plans event while no board changed');

    await board(hud, 'stream-plan', BOARD('in-progress'));
    const plans = await s.next(e => e.event === 'plans');
    assert.equal(p1State(plans.data.plans), 'in-progress', 'the plans event has the new board');
    await s.next(e => e.event === 'event' && /P1 todo → in-progress/.test(e.data.text));   // the feed line comes as an event
    await ev('UserPromptSubmit');   // one more state after the edit
    await s.next(e => e.event === 'state' && s.events.indexOf(e) > s.events.indexOf(plans));
    await pause(1500);   // more scans of the same edit must not send it again

    const later = s.events.filter(e => e.event === 'state' && e !== first);
    assert.ok(later.length >= 3, `later states arrived (${later.length})`);
    for (const e of later) {
      assert.ok(!('plans' in e.data) && !('feed' in e.data), 'a later state carries neither plans nor feed');
      assert.ok(!e.data.full, 'a later state is not marked full');
    }
    assert.equal(s.events.filter(e => e.event === 'plans').length, 1, 'one board edit gives one plans event');
    assert.ok(Array.isArray((await hud.state()).feed), '/api/state still returns everything');
    s.close();
  });

  await t.test('after restart(), the first message of a new connection is complete again', async () => {
    const before = await hud.stream();
    await before.next(e => e.event === 'state');
    await hud.restart();
    before.close();
    await hud.until(s => s.sessions.some(x => x.id === id) && p1State(s.plans) === 'in-progress');
    const s = await hud.stream();
    t.after(() => s.close());
    const first = await s.next(e => e.event === 'state');
    assert.equal(s.events[0], first, 'the state is the first message');
    assert.equal(first.data.full, true);
    assert.equal(p1State(first.data.plans), 'in-progress', 'the first state after the restart has the plans');
    assert.ok(Array.isArray(first.data.feed), 'and the feed');
    assert.ok(first.data.sessions.some(x => x.id === id), 'and the sessions');
    s.close();
  });
});

test('seeded subscribers see a single redacted tool event in either arrival order', { timeout: 25000 }, async t => {
  const hud = await startHud();
  t.after(() => hud.close());
  const sessionId = 'runtime-order';
  const tool = (id, command) => ({ type: 'tool_use', id, name: 'Bash', input: { command } });
  const post = (hook_event_name, extra = {}) => hud.post({ session_id: sessionId, cwd: hud.dir, hook_event_name, ...extra });
  async function append(call, output) {
    return transcript(hud, sessionId, [{
      type: 'assistant', sessionId, timestamp: new Date().toISOString(),
      message: { id: 'message-' + call.id, content: [call], usage: { output_tokens: output } },
    }]);
  }
  const path = await transcript(hud, sessionId, [{ type: 'custom-title', customTitle: 'Order fixture' }]);
  assert.equal(await post('UserPromptSubmit', { transcript_path: path }), 204);
  await hud.until(s => s.sessions.some(session => session.title === 'Order fixture'));
  const open = async () => {
    const stream = await hud.stream();
    t.after(() => stream.close());
    return { stream, first: await stream.next() };
  };
  const a = await open();

  const fixtureSecret = 'synthetic-token-value';
  const fromFile = tool('from-file', 'first --token ' + fixtureSecret);
  const fromHook = tool('from-hook', 'second');
  const message = 'Bash · first --token •••';
  const toolLine = text => frame => frame.event === 'event' && frame.data.text === text;
  const matching = snapshot => snapshot.feed.filter(line => line.text === message);
  const hook = call => post('PreToolUse', { tool_use_id: call.id, tool_name: call.name, tool_input: call.input });
  await append(fromFile, 2);
  await a.stream.next(toolLine(message));
  const b = await open();
  assert.equal(matching(b.first.data).length, 1);

  assert.equal(await hook(fromFile), 204);
  assert.equal(await hook(fromHook), 204);
  await append(fromHook, 3);
  const settled = await hud.until(s => s.sessions.some(session => session.id === sessionId && session.tokens.output === 5));
  const health = await Promise.all(Array.from({ length: 6 }, () => fetch(hud.base + '/api/health').then(response => response.json())));
  assert.ok(health.every(result => result.ok && result.sessions === 1));
  for (const { stream, first } of [a, b]) {
    await stream.next(toolLine('Bash · second'));
    await stream.next(frame => frame !== first && frame.event === 'state' && frame.data.sessions[0]?.tokens.output === 5);
    assert.equal(stream.events.filter(toolLine('Bash · second')).length, 1);
    assert.ok(!JSON.stringify(stream.events).includes(fixtureSecret));
  }
  assert.equal(a.stream.events.filter(toolLine(message)).length, 1);
  assert.equal(b.stream.events.filter(toolLine(message)).length, 0, 'the full seed already carried the first event');
  assert.equal(matching(settled).length, 1);
  assert.ok(!JSON.stringify(settled).includes(fixtureSecret));
});

test('an idle stream sends the initial retry directive and a keepalive', { timeout: 22000 }, async t => {
  const hud = await startHud();
  t.after(() => hud.close());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(hud.base + '/api/stream', { signal: controller.signal });
  const decoder = new TextDecoder();
  let wire = '';
  for await (const chunk of response.body) {
    wire += decoder.decode(chunk, { stream: true });
    if (wire.includes(': keep-alive\n\n')) break;
  }
  assert.match(wire, /^retry: 2000\n\nevent: state\ndata: /);
  assert.match(wire, /: keep-alive\n\n/);
});

test('state, health and new streams read the same mark without producing another announcement', { timeout: 25000 }, async t => {
  const hud = await startHud({ start: false, env: { HUD_UNCLAIMED_MS: '5500' } });
  t.after(() => hud.close());
  const id = 'mark-order';
  const title = 'Stream test plan: P1 board not updated';
  const mark = line => line.kind === 'plan' && line.text === title;
  const markEvent = frame => frame.event === 'event' && mark(frame.data);
  await board(hud, 'stream-plan', BOARD('todo'));
  await registry(hud, id, { pid: process.pid, status: 'busy' });
  await transcript(hud, id, [{
    type: 'user', message: { content: 'Do stream-plan/P1.' },
    cwd: hud.dir, sessionId: id, timestamp: new Date().toISOString(),
  }], { project: hud.dir.replace(/[^A-Za-z0-9]/g, '-') });
  await hud.restart();

  const existing = await hud.stream();
  t.after(() => existing.close());
  const first = await existing.next();
  assert.equal(first.data.feed.filter(mark).length, 0);
  await hud.until(snapshot => Object.values(snapshot.board.items).some(item => item.agents.some(agent => agent.active)));
  const announcement = await existing.next(markEvent);
  // These calls and the new connection all happen after publication of the same transition.
  const [health, state, second] = await Promise.all([
    fetch(hud.base + '/api/health').then(response => response.json()),
    hud.state(),
    hud.stream(),
  ]);
  t.after(() => second.close());
  assert.equal(health.sessions, 1);
  assert.deepEqual(state.feed.filter(mark), [announcement.data]);
  assert.deepEqual((await second.next()).data.feed.filter(mark), [announcement.data]);

  assert.equal(await hud.post({ session_id: id, cwd: hud.dir, hook_event_name: 'Stop' }), 204);
  for (const stream of [existing, second]) {
    await stream.next(frame => frame.event === 'state' && !frame.data.full && frame.data.sessions[0]?.status === 'idle');
  }
  assert.equal(existing.events.filter(markEvent).length, 1);
  assert.equal(second.events.filter(markEvent).length, 0);
});

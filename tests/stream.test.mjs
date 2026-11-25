// The lighter stream (PLAN hud-0-3 §4.4, P3): the first `state` of a connection is full, later ones carry neither
// plans nor feed, and a board edit gives one `plans` event. A HUD over temp folders (tests/helpers.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHud, pause, registry, board } from './helpers.mjs';

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

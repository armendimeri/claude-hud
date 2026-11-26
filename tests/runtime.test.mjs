import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createHudRuntime } from '../hud.mjs';
import { readConfig } from '../src/config.mjs';
import { board, registry, startHud, transcript } from './helpers.mjs';

function nextUpdate(source, predicate) {
  return new Promise((resolve, reject) => {
    const stop = source.subscribeUpdates(update => {
      if (!predicate(update)) return;
      clearTimeout(timer);
      stop();
      resolve(update);
    });
    const timer = setTimeout(() => {
      stop();
      reject(new Error('No matching runtime update'));
    }, 12000);
  });
}

const activeResources = () => process.getActiveResourcesInfo()
  .filter(name => ['Timeout', 'FSEventWrap', 'StatWatcher', 'ProcessWrap'].includes(name)).sort();

test('two runtimes isolate profiles, writes and timers and release their resources', { timeout: 18000 }, async t => {
  const [left, right] = await Promise.all([startHud({ start: false }), startHud({ start: false })]);
  const config = (profile, hostname, usage) => readConfig({
    home: profile.dir, hostname, argv: [],
    env: {
      CLAUDE_CONFIG_DIR: profile.claude, CODEX_HOME: profile.codex, HUD_NO_AUTOINSTALL: '1',
      HUD_UNCLAIMED_MS: '5500', HUD_ACCEPT_USAGE: usage ? '1' : '0',
    },
  });
  const a = createHudRuntime(config(left, 'fixture-one', true));
  const b = createHudRuntime(config(right, 'fixture-two', false));
  t.after(async () => {
    await Promise.all([a.close(), b.close()]);
    await Promise.all([left.close(), right.close()]);
  });

  await board(left, 'background', `# Background plan: status

| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |
|---|---|---|---|---|---|---|---|---|
| P1 | Work | worker | | | todo | | | |
`);
  await registry(left, 'left-session', { pid: process.pid, status: 'busy' });
  await transcript(left, 'left-session', [{
    type: 'user', message: { content: 'Do background/P1.' },
    cwd: left.dir, sessionId: 'left-session', timestamp: new Date().toISOString(),
  }], { project: left.dir.replace(/[^A-Za-z0-9]/g, '-') });
  const baseline = activeResources();
  a.start();
  b.start();

  const mark = 'Background plan: P1 board not updated';
  const marked = nextUpdate(a.source, ({ lines }) => lines.some(line => line.text === mark));
  const usage = { app: 'fixture', model: 'fixture-model', input: 5 };
  const batched = nextUpdate(a.source, ({ snapshot }) => snapshot.external.some(row => row.tokens.input > 0));
  assert.deepEqual(await Promise.all([
    a.writer.reportUsage(usage),
    a.writer.reportUsage(usage),
    b.writer.ingestHook({ session_id: 'right-session', cwd: right.dir, hook_event_name: 'UserPromptSubmit' }),
  ]), [[204, ''], [204, ''], [204, '']]);
  assert.equal((await batched).snapshot.external[0].tokens.input, 10);
  assert.equal(b.writer.reportUsage, undefined);
  assert.deepEqual(b.source.readSnapshot().sessions.map(session => session.id), ['right-session']);
  assert.deepEqual(b.source.readSnapshot().external, []);

  // There were no reads of A to drive a timer transition or mark announcement.
  const { snapshot, lines } = await marked;
  assert.deepEqual(snapshot.sessions.map(session => session.id), ['left-session']);
  assert.equal(lines.filter(line => line.text === mark).length, 1);
  assert.deepEqual([snapshot.host, b.source.readSnapshot().host], ['fixture-one', 'fixture-two']);
  assert.deepEqual(snapshot.codex.directories, [left.codex]);
  assert.deepEqual(b.source.readSnapshot().codex.directories, [right.codex]);
  for (let i = 0; i < 4; i++) assert.equal(a.source.readSnapshot().feed.filter(line => line.text === mark).length, 1);

  await a.source.close();
  assert.deepEqual(await a.writer.reportUsage(usage), [503, 'HUD is closing']);
  assert.deepEqual(await b.writer.ingestHook({ session_id: 'right-session', hook_event_name: 'Stop' }), [204, '']);
  assert.equal(b.source.readSnapshot().sessions[0].status, 'idle');
  await b.close();
  for (let i = 0; i < 20 && JSON.stringify(activeResources()) !== JSON.stringify(baseline); i++) await delay(25);
  assert.deepEqual(activeResources(), baseline);
});

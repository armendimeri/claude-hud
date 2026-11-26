import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createAwayRefresh } from '../src/web/data/away.mjs';
import { plansByKey, selectActivityRows, selectProject, sessionsById } from '../src/web/data/selectors.mjs';
import { createHudStore } from '../src/web/data/store.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/contract/snapshot.json', import.meta.url)));
const { liveSession: session, livePlan: plan, liveFeed: line } = fixture;
const source = {
  ...fixture.live, now: line.at, uptime: 120_000, version: '0.3.0', host: 'fixture',
  sessions: [session], projects: [], plans: [plan], board: {}, feed: [line], totals: {},
  codex: { directories: [] },
};
const { plans: initialPlans, feed: initialFeed, ...state } = source;

function fixtureClock() {
  let now = source.now - 25_000;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = Symbol();
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
    },
  };
}

function fixtureTransport() {
  const streams = [];
  return {
    streams,
    connect(callbacks) {
      const stream = {
        ...callbacks,
        closed: false,
        send(type, value) { callbacks.frame(type, JSON.stringify(value)); },
      };
      streams.push(stream);
      return () => { stream.closed = true; };
    },
  };
}

test('the browser store publishes complete snapshots and ignores malformed wire frames', () => {
  const transport = fixtureTransport(), clock = fixtureClock();
  const store = createHudStore({ transport, clock });
  const updates = [];
  const unsubscribe = store.subscribe(update => updates.push(update.type));
  store.reconnect();
  const [stream] = transport.streams;
  assert.deepEqual(store.getConnection(), { status: 'connecting', lastAt: null });
  stream.open();
  stream.send('state', state);
  stream.send('plans', { plans: initialPlans });
  stream.send('event', line);
  assert.equal(store.getSnapshot(), null, 'a connection needs a valid full frame first');
  stream.send('state', { ...source, full: true });
  assert.deepEqual(store.getSnapshot(), source);
  assert.equal(store.getServerTime(), source.now);
  const initial = store.getSnapshot();
  assert.deepEqual(store.getConnection(), { status: 'live', lastAt: clock.now() });

  const nextLine = { ...line, at: line.at + 10, text: 'Bash · node --test' };
  stream.send('event', nextLine);
  const withFeed = store.getSnapshot();
  stream.send('event', { ...nextLine, action: 'different metadata' });
  assert.equal(store.getSnapshot(), withFeed);
  assert.deepEqual(withFeed.feed, [nextLine, line]);
  assert.deepEqual(initial.feed, initialFeed);
  assert.equal(withFeed.sessions, initial.sessions);

  clock.advance(100);
  stream.send('plans', { plans: [] });
  const onlyPlans = store.getSnapshot();
  assert.deepEqual(onlyPlans.plans, []);
  assert.equal(onlyPlans.now, initial.now + 100);
  assert.equal(onlyPlans.uptime, initial.uptime + 100);
  assert.equal(onlyPlans.feed, withFeed.feed);
  assert.equal(onlyPlans.sessions, initial.sessions);
  assert.equal(store.getConnection().lastAt, clock.now() - 100);

  stream.send('state', { ...state, now: source.now + 100, sessions: [] });
  const partial = store.getSnapshot();
  assert.deepEqual(partial.sessions, []);
  assert.equal(partial.plans, onlyPlans.plans, 'the empty plan replacement stays in effect');
  assert.equal(partial.feed, withFeed.feed);
  stream.frame('state', '{');
  stream.send('state', null);
  stream.send('state', { ...state, sessions: null });
  stream.send('state', { ...state, full: true });
  stream.send('plans', { plans: {} });
  stream.send('plans', { plans: [null] });
  stream.send('event', { ...nextLine, at: 'not a timestamp' });
  stream.send('unknown', line);
  assert.equal(store.getSnapshot(), partial);
  assert.deepEqual(updates, ['connection', 'connection', 'snapshot', 'feed', 'snapshot', 'connection', 'snapshot']);
  unsubscribe();
  stream.send('plans', { plans: initialPlans });
  assert.equal(updates.length, 7);
  store.close();
  assert.equal(stream.closed, true);
});

test('a reconnect replaces state, reconciles feed and discards callbacks from retired streams', () => {
  const transport = fixtureTransport(), clock = fixtureClock();
  const store = createHudStore({ transport, clock });
  const resumes = [];
  store.subscribe(update => {
    if (Number.isFinite(update.resumedSince)) resumes.push(update.resumedSince);
  });
  store.reconnect();
  const [first] = transport.streams;
  first.open();
  first.send('state', { ...source, full: true });
  const liveLine = { ...line, at: line.at + 100 };
  first.send('event', liveLine);
  const beforeOutage = store.getSnapshot();
  const lostAt = clock.now();
  first.error(false);
  first.send('plans', { plans: [] });
  assert.equal(store.getConnection().status, 'reconnecting');
  assert.equal(store.getSnapshot(), beforeOutage);
  clock.advance(10_000);
  assert.equal(store.getConnection().status, 'down');
  assert.equal(transport.streams.length, 1, 'the native stream retries a transient error');

  store.reconnect();
  const replacement = transport.streams[1];
  assert.equal(first.closed, true);
  first.open();
  first.error(true);
  first.send('state', { ...source, full: true, sessions: [] });
  assert.equal(store.getConnection().status, 'down');
  assert.equal(store.getSnapshot(), beforeOutage);
  replacement.open();
  replacement.send('state', state);
  assert.equal(store.getSnapshot(), beforeOutage, 'even a manual retry awaits its full frame');
  const recoveredLine = { ...line, at: line.at + 200, text: 'During the outage' };
  const { codex, ...demo } = source;
  replacement.send('state', { ...demo, full: true, demo: true, sessions: [], plans: [], feed: [recoveredLine, line, line] });
  assert.deepEqual(store.getSnapshot().sessions, []);
  assert.deepEqual(store.getSnapshot().plans, []);
  assert.equal('codex' in store.getSnapshot(), false, 'full frames replace fields from the previous server');
  assert.deepEqual(store.getSnapshot().feed, [recoveredLine, liveLine, line]);
  assert.deepEqual(resumes, [lostAt]);

  const reconciled = store.getSnapshot().feed;
  replacement.error(false);
  replacement.open();
  replacement.send('state', { ...source, full: true, feed: [line] });
  assert.equal(store.getSnapshot().feed, reconciled, 'the same native stream can reopen without redrawing known feed');
  replacement.error(true);
  replacement.error(true);
  clock.advance(2999);
  assert.equal(transport.streams.length, 2);
  clock.advance(1);
  assert.equal(transport.streams.length, 3, 'one terminal-error timer replaces the source');
  const terminalRetry = transport.streams[2];
  terminalRetry.error(true);
  store.close();
  terminalRetry.open();
  clock.advance(10_000);
  assert.equal(terminalRetry.closed, true);
  assert.equal(transport.streams.length, 3, 'closing cancels timers and ignores queued callbacks');
});

test('recent feed is bounded and live lines retain delivery order', () => {
  const transport = fixtureTransport(), store = createHudStore({ transport, clock: fixtureClock() });
  store.reconnect();
  const [stream] = transport.streams;
  stream.send('state', { ...source, full: true, feed: Array.from({ length: 201 }, (_, i) => ({
    ...line, at: line.at + 200 - i,
  })) });
  assert.equal(store.getSnapshot().feed.length, 200);
  assert.equal(store.getSnapshot().feed.at(-1).at, line.at + 1);
  stream.send('event', line);
  stream.send('event', line);
  assert.equal(store.getSnapshot().feed.length, 200);
  assert.deepEqual(store.getSnapshot().feed[0], line, 'a backdated live line is still the newest delivery');
  assert.equal(store.getSnapshot().feed.at(-1).at, line.at + 2);
  store.close();
});

test('away refresh uses server time and retries pending summaries on stream open', async () => {
  const clock = fixtureClock();
  let hidden = false, reject, resolve;
  const requests = [], summaries = [];
  const away = createAwayRefresh({
    isHidden: () => hidden, clock,
    transport: { fetchSnapshot({ signal }) {
      requests.push(signal);
      return new Promise((yes, no) => { resolve = yes; reject = no; });
    } },
    onSummary: (feed, since) => summaries.push({ feed, since }),
  });
  hidden = true;
  await away.visibilityChanged();
  clock.advance(1000);
  hidden = false;
  await away.visibilityChanged();
  assert.equal(requests.length, 0);
  hidden = true;
  await away.visibilityChanged();
  const since = clock.now();
  clock.advance(300_000);
  hidden = false;
  const unsuccessful = away.visibilityChanged();
  await away.resumed(since);
  assert.equal(requests.length, 1, 'visibility and stream open share one pending fetch');
  reject(new Error('offline'));
  await unsuccessful;
  const retry = away.resumed(null);
  clock.advance(35);
  resolve({ now: clock.now() + 25_000, feed: initialFeed });
  await retry;
  assert.deepEqual(summaries, [{ feed: initialFeed, since: since + 25_000 }]);
  await away.resumed(since);
  assert.equal(requests.length, 2, 'a completed summary is not fetched again');
  const outage = clock.now();
  clock.advance(300_000);
  const cancelled = away.resumed(outage);
  assert.equal(requests.length, 3, 'a long outage also requests a summary while the tab is visible');
  away.close();
  assert.equal(requests.at(-1).aborted, true);
  resolve(source);
  await cancelled;
  assert.equal(summaries.length, 1);
});

test('selectors preserve source order and resolve activity work through existing keys', () => {
  const key = 'fixture|contract-plan';
  const item = { id: 'P1' };
  const linked = Object.freeze({ ...session, work: { plan: key, items: [item] } });
  const sessions = Object.freeze([linked, Object.freeze({ ...session, id: 'other', project: 'other' })]);
  const snapshot = Object.freeze({ ...source, sessions });
  assert.equal(sessionsById(snapshot).get(session.id), linked);
  assert.equal(plansByKey(snapshot).get(key), plan);
  assert.equal(selectProject(sessions, null), sessions);
  assert.deepEqual(selectActivityRows(snapshot, 'fixture'), [{
    session: linked, work: [{ planKey: key, plan, item, node: plan.phases[0] }],
  }]);
  assert.equal(selectActivityRows(snapshot, null)[1].session, sessions[1]);
});

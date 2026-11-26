const HISTORY_LIMIT = 200;
const RETRY_MS = 3000;
const DOWN_MS = 10_000;

const browserClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer),
};

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const records = items => Array.isArray(items) && items.every(record);
const plans = items => records(items) &&
  items.every(plan => typeof plan.project === 'string' && typeof plan.slug === 'string');
const nullableString = value => value === null || typeof value === 'string';

function isFeedLine(line) {
  return record(line) && Number.isFinite(line.at) && typeof line.kind === 'string' &&
    typeof line.text === 'string' && nullableString(line.project) && nullableString(line.sessionId);
}

function feedKey({ at, sessionId, project, kind, text }) {
  return JSON.stringify([at, sessionId, project, kind, text]);
}

function isState(state) {
  return record(state) && Number.isFinite(state.now) && Number.isFinite(state.uptime) &&
    [true, false, 'dense'].includes(state.demo) && records(state.sessions) &&
    state.sessions.every(session => typeof session.id === 'string') &&
    records(state.projects) && records(state.alerts) && records(state.external) &&
    record(state.board) && record(state.totals) &&
    (state.full === undefined || state.full === true) &&
    (state.full !== true && state.plans === undefined || plans(state.plans)) &&
    (state.full !== true && state.feed === undefined || Array.isArray(state.feed) && state.feed.every(isFeedLine));
}

/**
 * A transport opens a stream through connect({ open, error, frame }) and returns its cleanup.
 * error receives whether the stream has closed permanently. frame receives a wire event name and JSON text.
 * Subscribers can read the latest snapshot (null until a full state) and connection on every update.
 */
export function createHudStore({ transport, clock = browserClock }) {
  const listeners = new Set();
  let snapshot = null, stateTime = null, offset = 0;
  let connection = { status: 'connecting', lastAt: null };
  let active = null, closed = false, lostAt = null, downTimer = null, retryTimer = null;
  let feed = [], feedKeys = new Set();

  function publish(update) {
    for (const listener of listeners) listener(update);
  }

  function setConnection(status, lastAt = connection.lastAt, resumedSince) {
    if (connection.status === status && connection.lastAt === lastAt && resumedSince === undefined) return;
    connection = { status, lastAt };
    publish({ type: 'connection', resumedSince });
  }

  function mergeHistory(incoming) {
    if (incoming.every(line => feedKeys.has(feedKey(line)))) return;
    const merged = new Map();
    for (const line of [...incoming, ...feed]) {
      const key = feedKey(line);
      if (!merged.has(key)) merged.set(key, line);
    }
    feed = [...merged.values()].sort((a, b) => b.at - a.at).slice(0, HISTORY_LIMIT);
    feedKeys = new Set(feed.map(feedKey));
  }

  function receive(attempt, type, data) {
    if (active !== attempt) return;
    let value;
    try { value = JSON.parse(data); } catch { return; }
    if (type === 'state') {
      if (!isState(value) || (!attempt.seeded && !value.full)) return;
      const { full, feed: history, ...state } = value;
      if (history) mergeHistory(history);
      snapshot = { ...state, plans: state.plans ?? snapshot.plans, feed };
      stateTime = { now: state.now, uptime: state.uptime };
      const receivedAt = clock.now();
      const nextOffset = state.now - receivedAt;
      if (Math.abs(nextOffset - offset) > 250) offset = nextOffset;
      attempt.seeded = true;
      endOutage();
      setConnection('live', receivedAt);
      publish({ type: 'snapshot' });
    } else if (attempt.seeded && type === 'plans' && plans(value?.plans)) {
      const elapsed = clock.now() - connection.lastAt;
      snapshot = { ...snapshot, plans: value.plans, now: stateTime.now + elapsed, uptime: stateTime.uptime + elapsed };
      publish({ type: 'snapshot' });
    } else if (attempt.seeded && type === 'event' && isFeedLine(value)) {
      const key = feedKey(value);
      if (feedKeys.has(key)) return;
      if (feed.length === HISTORY_LIMIT) feedKeys.delete(feedKey(feed.at(-1)));
      feedKeys.add(key);
      feed = [value, ...feed].slice(0, HISTORY_LIMIT);
      snapshot = { ...snapshot, feed };
      publish({ type: 'feed', line: value });
    }
  }

  function endOutage() {
    const since = lostAt;
    lostAt = null;
    clock.clearTimeout(downTimer);
    clock.clearTimeout(retryTimer);
    downTimer = null;
    retryTimer = null;
    return since;
  }

  function reconnect() {
    if (closed) return;
    const previous = active;
    const attempt = { seeded: false, stop: null };
    active = attempt;
    previous?.stop?.();
    clock.clearTimeout(retryTimer);
    retryTimer = null;
    const stop = transport.connect({
      open() {
        if (active !== attempt) return;
        setConnection('live', connection.lastAt, endOutage());
      },
      error(permanent) {
        if (active !== attempt) return;
        attempt.seeded = false;
        if (lostAt === null) {
          lostAt = clock.now();
          downTimer = clock.setTimeout(() => {
            if (lostAt !== null) setConnection('down');
          }, DOWN_MS);
          setConnection(snapshot ? 'reconnecting' : 'connecting');
        }
        if (active === attempt && permanent && retryTimer === null) {
          retryTimer = clock.setTimeout(reconnect, RETRY_MS);
        }
      },
      frame: (type, data) => receive(attempt, type, data),
    });
    if (active === attempt) attempt.stop = stop;
    else stop();
  }

  return {
    getSnapshot: () => snapshot,
    getConnection: () => connection,
    getServerTime: () => clock.now() + offset,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reconnect,
    close() {
      closed = true;
      const previous = active;
      active = null;
      previous?.stop?.();
      endOutage();
      listeners.clear();
    },
  };
}

import published from '../contract/snapshot.json' with { type: 'json' };

export const T0 = 1795688700000;
export const times = Array.from({ length: 6 }, (_, index) => T0 + index * 1000);
export const selection = (sessionId, agentId = null) => ({ sessionId, agentId });
export function selectionKey({ sessionId, agentId }) {
  const bytes = new TextEncoder().encode(JSON.stringify([sessionId, agentId]));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export const parent = selection('claude:export/α');
export const child = selection(parent.sessionId, 'toolu_export:review/1');
export const sibling = selection('codex:export/β');
export const bedrock = selection('claude-bedrock');

export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

const tokens = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const tool = { name: 'Read', summary: 'export.mjs', since: T0 - 2000 };
const worker = {
  id: child.agentId, parentId: parent.sessionId, depth: 1, type: 'Explore', description: 'Review export',
  model: 'claude-opus-5-5', modelRaw: 'claude-opus-5-5', provider: 'anthropic', state: 'running',
  background: true, startedAt: T0 - 5000, endedAt: null, lastActivityAt: T0 - 2000,
  tokens, pulse: null, context: null, currentTool: tool,
};
function session(id, project, status, fields = {}) {
  return { ...published.liveSession, id, project, cwd: '/fixture/' + project, pid: null,
    status, currentTool: status === 'busy' ? tool : null, startedAt: T0 - 30_000,
    lastActivityAt: T0 - 2000, pulse: null, ...fields };
}
const a = session(parent.sessionId, 'Ledger', 'idle', {
  title: 'Export', subagents: [worker], agentsRunning: 1,
  tokensTree: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 },
});
const b = session(sibling.sessionId, 'Reports', 'busy', {
  title: 'Export', agent: 'codex', provider: 'openai', model: 'gpt-test-codex', modelRaw: 'gpt-test-codex',
  context: null,
});
const c = session(bedrock.sessionId, 'Ledger', 'busy', {
  title: 'Check totals', provider: 'bedrock', modelRaw: 'anthropic.claude-opus-5-5',
});
const wait = now => ({ ...a, status: 'needs-you', needsYou: { since: now, kind: 'question', reason: 'Waiting for answer' } });
const completed = { ...a, status: 'ended', endedAt: times[5], agentsRunning: 0,
  subagents: [{ ...worker, state: 'done', endedAt: times[5], currentTool: null }] };
const activity = { at: T0 - 2000, sessionId: b.id, project: b.project, kind: 'tool', text: 'Read · export.mjs' };
const finish = { at: times[5], sessionId: a.id, project: a.project, kind: 'done', text: 'Export finished' };
const plan = { ...published.livePlan, project: 'Ledger', path: '/fixture/Ledger/docs/plans/contract-plan/STATUS.md', touchedAt: T0 };

function snapshot(sessions, now = T0, { dense = false, feed = sessions.length ? [activity] : [] } = {}) {
  const live = sessions.filter(session => session.status !== 'ended');
  const busy = live.filter(session => session.status === 'busy').length;
  const needsYou = live.filter(session => session.status === 'needs-you').length;
  const subagentsRunning = live.reduce((count, session) => count + session.agentsRunning, 0);
  const projects = [...new Set(sessions.map(session => session.project))].map(project =>
    ({ project, root: '/fixture/' + project, headline: null, standard: false, git: null }));
  return freeze({
    now, uptime: now - T0 + 60_000, demo: dense ? 'dense' : true, version: 'fixture-v1', host: 'FIXTURE',
    hooksInstalled: true, sessions, projects, plans: sessions.length ? [plan] : [], board: {}, alerts: [], feed,
    account: null, totals: { sessions: live.length, needsYou, busy, subagentsRunning,
      agentsRunning: busy + needsYou + subagentsRunning, tokensToday: tokens, plansInProgress: 0, plansNeedingYou: 0 },
    external: [], externalError: null, push: { enabled: false, lastError: null },
  });
}

const story = [
  snapshot([b, a], times[0]), snapshot([wait(times[1]), b], times[1]),
  snapshot([wait(times[1]), b], times[2]), snapshot([b, a], times[3]),
  snapshot([wait(times[4]), b], times[4]), snapshot([b, { ...a, status: 'busy', currentTool: tool }], times[5]),
];
export const snapshots = freeze({
  empty: snapshot([]),
  sparse: snapshot([wait(times[1]), b, c], times[1]),
  dense: snapshot([wait(times[1]), b, c, ...Array.from({ length: 21 }, (_, index) =>
    session('dense-' + (index + 1), ['Ledger', 'Reports', 'Imports', 'Invoices'][index % 4],
      index < 5 ? 'busy' : 'idle', { title: 'Synthetic work ' + (index + 1) }))], times[1], { dense: true }),
  sameTitle: story[0],
  idleParent: story[0],
  toolIdOnly: story[0],
  ended: snapshot([b, completed], times[5], { feed: [finish, activity] }),
});

export const timeline = freeze(story.map((snapshot, index) => ({
  snapshot,
  selection: index === 2 ? sibling : parent,
  connection: { status: index === 4 ? 'reconnecting' : 'live', lastAt: times[index === 4 ? 3 : index] },
})));

export const expected = freeze({
  counts: { empty: [0, 0, 0, 0], sparse: [3, 2, 1, 1], dense: [24, 7, 1, 1], ended: [1, 1, 0, 0] },
  selectedKeys: [
    'WyJjbGF1ZGU6ZXhwb3J0L86xIixudWxsXQ', 'WyJjbGF1ZGU6ZXhwb3J0L86xIiwidG9vbHVfZXhwb3J0OnJldmlldy8xIl0',
    'WyJjb2RleDpleHBvcnQvzrIiLG51bGxd',
  ],
  parentVisibleStatus: ['agents', 'needs-you', 'needs-you', 'agents', 'needs-you', 'busy'],
});

/** Shared store seam. `setFrame` is a fixture-only control. */
export function createFixtureStore(initial = timeline[0]) {
  let frame = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => frame.snapshot,
    getServerTime: () => frame.snapshot.now,
    getConnection: () => frame.connection,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setFrame(next) {
      const connectionChanged = frame.connection.status !== next.connection.status ||
        frame.connection.lastAt !== next.connection.lastAt;
      const snapshotChanged = frame.snapshot !== next.snapshot;
      frame = next;
      if (connectionChanged) for (const listen of listeners) listen({ type: 'connection' });
      if (snapshotChanged) for (const listen of listeners) listen({ type: 'snapshot' });
    },
    close() { listeners.clear(); },
  };
}

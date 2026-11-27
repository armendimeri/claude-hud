import assert from 'node:assert/strict';
import test from 'node:test';
import { createHudStore } from '../src/web/data/store.mjs';
import { viewStatus } from '../src/web/components/sessions.mjs';
import { bedrock, child, createFixtureStore, expected, parent, selection, selectionKey, sibling, snapshots, timeline, times } from './fixtures/cockpit/public.mjs';
import { canaries, capabilities, commands, createFixtureAdapter, createFixtureClient, deliveryCases,
  errors, histories, historyPages, receipts, targets } from './fixtures/cockpit/private.mjs';

test('frozen public snapshots seed the live browser store and exclude every private canary', () => {
  let connection;
  const store = createHudStore({ transport: { connect(callbacks) { connection = callbacks; return () => {}; } } });
  try {
    store.reconnect();
    for (const [name, snapshot] of Object.entries(snapshots)) {
      const wire = JSON.stringify({ ...snapshot, full: true });
      for (const marker of Object.values(canaries)) assert.ok(!wire.includes(marker), name);
      connection.frame('state', wire);
      assert.deepEqual(store.getSnapshot(), snapshot, name);
      assert.ok(Object.isFrozen(snapshot.sessions));
      if (expected.counts[name]) {
        const { sessions, busy, needsYou, subagentsRunning } = snapshot.totals;
        assert.deepEqual([sessions, busy, needsYou, subagentsRunning], expected.counts[name]);
      }
    }
    assert.deepEqual(snapshots.sameTitle.sessions.map(({ title }) => title), ['Export', 'Export']);
    assert.equal(snapshots.toolIdOnly.sessions[1].subagents[0].id, child.agentId);
    assert.deepEqual(snapshots.sparse.sessions.map(({ provider }) => provider), ['anthropic', 'openai', 'bedrock']);
    assert.equal(snapshots.ended.sessions.find(({ id }) => id === parent.sessionId).status, 'ended');
    assert.deepEqual(timeline.map(frame => viewStatus(frame.snapshot.sessions.find(({ id }) => id === parent.sessionId))),
      expected.parentVisibleStatus);
    for (const marker of Object.values(canaries)) assert.ok(!JSON.stringify(timeline).includes(marker));
  } finally {
    store.close();
  }
});

test('selection stays a UTF-8 tuple and reconnect keeps last-known state', () => {
  const entities = [parent, child, sibling];
  assert.deepEqual(entities.map(selectionKey), expected.selectedKeys);
  for (const identity of entities) {
    const tuple = JSON.parse(Buffer.from(selectionKey(identity), 'base64url').toString('utf8'));
    assert.deepEqual(tuple, [identity.sessionId, identity.agentId]);
  }
  const store = createFixtureStore(timeline[3]);
  const updates = [];
  const unsubscribe = store.subscribe(({ type }) => updates.push(type));
  store.setFrame({ ...timeline[4], snapshot: timeline[3].snapshot });
  assert.deepEqual(store.getConnection(), { status: 'reconnecting', lastAt: times[3] });
  assert.equal(store.getSnapshot(), timeline[3].snapshot);
  store.setFrame(timeline[5]);
  assert.deepEqual(updates, ['connection', 'connection', 'snapshot']);
  unsubscribe();
  store.close();
});

test('private history is keyed by the entire selection and can arrive after another selection', async () => {
  const defaults = createFixtureClient();
  const entities = [[parent, canaries.parent], [child, canaries.child], [sibling, canaries.sibling]];
  for (const [identity, marker] of entities) {
    const page = await defaults.history(identity);
    assert.deepEqual(page.entries.map(({ kind }) => kind), ['user', 'tool', 'assistant']);
    assert.equal(page.entries[0].at, page.entries[1].at);
    assert.equal(page.entries[0].text, marker);
    for (const [, other] of entities.filter(([, text]) => text !== marker)) assert.ok(!JSON.stringify(page).includes(other));
  }
  assert.equal(new Set(Object.values(histories).flatMap(page => page.entries.map(({ id }) => id))).size, 9);
  const pages = [historyPages.older, historyPages.latest, historyPages.newer];
  const eventTimes = pages.flatMap(page => page.entries.map(entry => entry.at));
  assert.deepEqual(eventTimes, [...eventTimes].sort((a, b) => a - b));
  assert.deepEqual(historyPages.empty.entries, []);
  assert.ok(historyPages.latest.before && historyPages.latest.after);
  await assert.rejects(defaults.history(selection(sibling.sessionId, child.agentId)), errors.unavailable);
  assert.deepEqual(await defaults.capabilities(sibling), capabilities.observed);
  assert.deepEqual(await defaults.capabilities(bedrock), capabilities.unsupported);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const client = createFixtureClient({
    history: (identity, options) => selectionKey(identity) === selectionKey(parent) ? pending : defaults.history(identity, options),
  });
  const controller = new AbortController();
  const late = client.history(parent, { signal: controller.signal });
  controller.abort();
  assert.equal((await client.history(sibling)).entries[0].text, canaries.sibling);
  release(histories[selectionKey(parent)]);
  assert.equal((await late).entries[0].text, canaries.parent);
  await assert.rejects(defaults.history(parent, { signal: controller.signal }), { name: 'AbortError' });
});

test('action examples bind choices and permissions to the intended turn and request', async () => {
  const pending = capabilities.multiple.pending.find(request => request.id === commands.answer.requestId);
  assert.equal(pending.turnId, commands.answer.turnId);
  assert.equal(capabilities.multiple.pending.length, 2);
  assert.deepEqual(pending.questions.map(({ id }) => id), commands.answer.payload.answers.map(({ questionId }) => questionId));
  assert.ok(!capabilities.withdrawn.pending.some(request => request.id === commands.stale.requestId));
  assert.notEqual(commands.stale.revision, capabilities.withdrawn.revision);
  assert.deepEqual(commands.duplicate, commands.answer);
  assert.notEqual(commands.duplicate, commands.answer);
  assert.equal(commands.conflictingReuse.actionId, commands.answer.actionId);
  assert.notDeepEqual(commands.conflictingReuse.payload, commands.answer.payload);
  for (const command of [commands.allow, commands.deny]) {
    assert.equal(command.requestId, capabilities.permission.pending[0].id);
    assert.equal(command.kind, command.payload.decision);
  }
  assert.equal(commands.prompt.turnId, null);
  assert.equal(commands.steer.turnId, capabilities.active.activeTurnId);
  assert.equal(commands.steer.requestId, null);
  assert.equal(deliveryCases.stale.dispatchCount, 0);
  assert.deepEqual(deliveryCases.reconnect.receiptOrder.map(receipt => receipt.status), ['pending', 'delivery-unknown', 'acknowledged']);
  assert.equal(deliveryCases.reconnect.dispatchCount, 1);
  const adapter = createFixtureAdapter();
  assert.deepEqual(await adapter.dispatch(targets.parent, commands.answer), receipts.unknown);
  assert.deepEqual(await adapter.reconcile(targets.parent, receipts.unknown), receipts.acknowledged);
  assert.deepEqual(adapter.calls, [{ target: targets.parent, command: commands.answer }]);
  assert.equal(receipts.immediate.at, timeline[4].snapshot.now);
  assert.equal(timeline[4].snapshot.sessions.find(({ id }) => id === parent.sessionId).status, 'needs-you');
  assert.equal(timeline[5].snapshot.sessions.find(({ id }) => id === parent.sessionId).status, 'busy');
});

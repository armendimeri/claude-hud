import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createInspectorController, draftKey, historyStatus, keyOf, mergeRows, questionComplete, reasonText } from '../src/web/inspector/state.mjs';
import { child, parent, selectionKey, sibling } from './fixtures/cockpit/public.mjs';
import { canaries, capabilities, commands, createFixtureClient, errors, histories, historyPages, receipts } from './fixtures/cockpit/private.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function controllerWith(overrides) {
  const calls = [];
  const base = createFixtureClient(overrides);
  const client = {
    history: (s, o) => { calls.push({ m: 'history', k: keyOf(s), o }); return base.history(s, o); },
    capabilities: (s, o) => { calls.push({ m: 'capabilities', k: keyOf(s), o }); return base.capabilities(s, o); },
    submit: (s, c, o) => { calls.push({ m: 'submit', k: keyOf(s), c, o }); return base.submit(s, c, o); },
    receipt: (s, id, o) => { calls.push({ m: 'receipt', k: keyOf(s), id, o }); return base.receipt(s, id, o); },
  };
  const lifetime = new AbortController();
  return { calls, lifetime, c: createInspectorController({ client, signal: lifetime.signal }) };
}

test('selection keys are tuples: identical titles and punctuation never collide', () => {
  assert.notEqual(keyOf(parent), keyOf(child));
  assert.notEqual(keyOf(parent), keyOf(sibling));
  assert.equal(keyOf({ sessionId: 'a', agentId: undefined }), keyOf({ sessionId: 'a', agentId: null }));
  assert.notEqual(keyOf({ sessionId: 'a,b', agentId: 'c' }), keyOf({ sessionId: 'a', agentId: 'b,c' }));
  assert.notEqual(draftKey(parent, 't1', 'r1', 'answer'), draftKey(parent, 't2', 'r1', 'answer'));
  assert.notEqual(draftKey(parent, 't1', 'r1', 'answer'), draftKey(sibling, 't1', 'r1', 'answer'));
  assert.ok(selectionKey(parent));
});

test('selecting reads nothing private until access is explicit', async () => {
  const { c, calls } = controllerWith();
  c.select(parent);
  c.select(sibling);
  await tick();
  assert.deepEqual(calls, []);
  await c.open();
  assert.deepEqual(calls.map(({ m }) => m).sort(), ['capabilities', 'history']);
  assert.equal(c.history().status, 'ready');
});

test('a held response for A cannot land after switching to B, in either order', async () => {
  const a = deferred(), b = deferred();
  const { c, calls } = controllerWith({ history: async s => (s.agentId === null && s.sessionId === parent.sessionId ? a.promise : b.promise) });
  c.select(parent); const opened = c.open();
  const generationA = c.generation;
  c.select(sibling);
  assert.equal(c.generation, generationA + 1);
  assert.equal(calls.find(x => x.m === 'history' && x.k === keyOf(parent)).o.signal.aborted, true, 'A aborted by the switch');
  b.resolve(histories[selectionKey(sibling)]); await tick();
  assert.deepEqual(c.history().rows.map(r => r.text), [canaries.sibling, 'Read · export.mjs', 'Export is ready to review.']);
  a.resolve(histories[selectionKey(parent)]); await tick(); await opened;
  assert.ok(!JSON.stringify(c.history()).includes(canaries.parent));
  assert.equal(c.key, keyOf(sibling));
  // Reverse order: B is current, an even older A answers last and again changes nothing.
  c.select(parent); c.select(sibling);
  assert.ok(!JSON.stringify(c.history()).includes(canaries.parent));
});

test('history states: empty, error, partial and ready are explicit', async () => {
  let mode = 'empty';
  const { c } = controllerWith({ history: async () => {
    if (mode === 'error') throw Object.assign(new Error('x'), errors.unavailable);
    if (mode === 'partial') return { ...histories[selectionKey(parent)], gap: { records: 2, reasons: { malformed: 2 } } };
    return mode === 'empty' ? historyPages.empty : histories[selectionKey(parent)];
  } });
  c.select(parent);
  await c.open(); assert.equal(c.history().status, 'empty');
  mode = 'error'; await c.reload(); assert.equal(c.history().status, 'error'); assert.equal(c.history().error.code, 'unavailable');
  mode = 'partial'; await c.reload(); assert.equal(c.history().status, 'partial'); assert.equal(c.history().rows.length, 3);
  mode = 'ready'; await c.reload(); assert.equal(c.history().status, 'ready');
  assert.equal(historyStatus([], { records: 1 }), 'partial');
  assert.equal(historyStatus([], null), 'empty');
});

test('rows merge by entry ID: older prepends once, newer appends once, repeats are dropped', () => {
  const row = id => ({ id, at: 0, kind: 'user', text: id });
  let rows = mergeRows([], { entries: [row('3'), row('4'), row('4')] }, 'replace');
  assert.deepEqual(rows.map(r => r.id), ['3', '4']);
  rows = mergeRows(rows, { entries: [row('1'), row('2'), row('3')] }, 'older');
  assert.deepEqual(rows.map(r => r.id), ['1', '2', '3', '4']);
  rows = mergeRows(rows, { entries: [row('4'), row('5')] }, 'newer');
  assert.deepEqual(rows.map(r => r.id), ['1', '2', '3', '4', '5']);
  assert.equal(mergeRows(rows, { entries: [row('5')] }, 'newer'), rows);
  assert.deepEqual(mergeRows(rows, { entries: [{ nope: 1 }, null] }, 'newer'), rows);
});

test('older and newer pages use the right cursors and a stale cursor becomes a visible gap', async () => {
  const seen = [];
  const { c } = controllerWith({ history: async (s, o) => {
    seen.push({ before: o.before, after: o.after });
    if (o.before) return historyPages.older;
    if (o.after === 'fixture-after-parent:11') throw Object.assign(new Error('gone'), { code: 'stale_cursor', message: 'moved' });
    return { ...historyPages.latest, after: 'fixture-after-parent:11' };
  } });
  c.select(parent); await c.open();
  await c.loadOlder();
  assert.deepEqual(seen[1], { before: 'fixture-before-parent:11', after: undefined });
  assert.equal(c.history().rows[0].id, 'parent:3');
  assert.equal(c.history().before, null, 'start reached');
  await c.loadOlder(); assert.equal(seen.length, 2, 'no request without a before cursor');
  await c.loadNewer();
  assert.equal(c.history().status, 'partial'); assert.equal(c.history().gap.stale, true);
});

test('catch-up is coalesced into one request in flight', async () => {
  const hold = deferred(); let n = 0;
  const { c } = controllerWith({ history: async (s, o) => { if (o.after) { n++; await hold.promise; return historyPages.newer; } return historyPages.latest; } });
  c.select(parent); await c.open();
  const first = c.loadNewer(); c.loadNewer(); c.loadNewer();
  assert.equal(n, 1);
  hold.resolve(); await first;
  assert.equal(c.history().rows.at(-1).id, 'parent:112');
});

test('drafts are scoped to selection, turn, request and kind; they survive switches and die with close', async () => {
  const { c } = controllerWith({ getCapabilities: async () => capabilities.multiple });
  c.select(parent); await c.open();
  c.setDraft('fixture-turn-1', 'request-2', 'answer', { 'question-date': { choiceIds: ['today'] } });
  c.setDraft(null, null, 'prompt', canaries.draft);
  c.select(sibling);
  assert.equal(c.getDraft('fixture-turn-1', 'request-2', 'answer'), undefined, 'not visible for B');
  assert.equal(c.getDraft(null, null, 'prompt'), undefined);
  c.select(parent);
  assert.deepEqual(c.getDraft('fixture-turn-1', 'request-2', 'answer'), { 'question-date': { choiceIds: ['today'] } });
  assert.equal(c.getDraft('fixture-turn-2', 'request-2', 'answer'), undefined, 'another turn is another draft');
  c.setDraft(null, null, 'prompt', '');
  assert.equal(c.getDraft(null, null, 'prompt'), undefined, 'emptying removes it');
  c.close();
  assert.equal(c.drafts.size, 0);
});

test('a request closed elsewhere discards its draft once with a notice; a surviving request keeps it', async () => {
  let caps = capabilities.multiple;
  const { c } = controllerWith({ getCapabilities: async () => caps });
  c.select(parent); await c.open();
  c.setDraft('fixture-turn-1', 'request-2', 'answer', { x: { choiceIds: ['a'] } });
  c.setDraft('fixture-turn-1', 'request-3', 'answer', { x: { choiceIds: ['b'] } });
  caps = { ...capabilities.multiple, revision: 'r9', pending: capabilities.multiple.pending.filter(p => p.id === 'request-3') };
  await c.loadCapabilities();
  assert.equal(c.getDraft('fixture-turn-1', 'request-2', 'answer'), undefined);
  assert.ok(c.getDraft('fixture-turn-1', 'request-3', 'answer'));
  assert.equal(c.takeNotices().length, 1);
  assert.equal(c.takeNotices().length, 0);
});

test('a finished-turn steer draft is discarded, not silently retargeted', async () => {
  let caps = capabilities.active;
  const { c } = controllerWith({ getCapabilities: async () => caps });
  c.select(parent); await c.open();
  c.setDraft('fixture-turn-2', null, 'steer', 'tell it more');
  caps = capabilities.idle;
  await c.loadCapabilities();
  assert.equal(c.getDraft('fixture-turn-2', null, 'steer'), undefined);
  assert.match(c.takeNotices()[0].text, /turn finished/);
});

test('submit: receipts stay with the entity they were sent from and are never resubmitted', async () => {
  const gate = deferred();
  const { c, calls } = controllerWith({
    getCapabilities: async () => capabilities.multiple,
    submit: async (s, command) => { await gate.promise; return { ...receipts.acknowledged, actionId: command.actionId }; },
  });
  c.select(parent); await c.open();
  const sending = c.submit(commands.answer, { label: 'Answer' });
  assert.equal(c.deliveries()[0].status, 'pending');
  c.select(sibling);
  assert.deepEqual(c.deliveries(), [], 'B shows no delivery from A');
  assert.equal(calls.find(x => x.m === 'submit').o.signal.aborted, false, 'a delivery is not cancelled by a switch');
  gate.resolve(); await sending;
  assert.deepEqual(c.deliveries(), []);
  c.select(parent);
  assert.equal(c.deliveries()[0].status, 'acknowledged');
  assert.equal(calls.filter(x => x.m === 'submit').length, 1);
});

test('delivery outcomes: stale is rejected, transport loss is unknown until the receipt endpoint says otherwise', async () => {
  let mode = 'stale';
  const { c, calls } = controllerWith({
    getCapabilities: async () => capabilities.question,
    submit: async () => { throw mode === 'stale' ? Object.assign(new Error(errors.stale.message), errors.stale) : new TypeError('socket closed'); },
    receipt: async (s, id) => ({ ...receipts.acknowledged, actionId: id }),
  });
  c.select(parent); await c.open();
  const stale = await c.submit(commands.stale);
  assert.equal(stale.status, 'rejected'); assert.equal(stale.message, 'This question has closed.');
  mode = 'down';
  const unknown = await c.submit(commands.answer);
  assert.equal(unknown.status, 'delivery-unknown');
  assert.match(unknown.message, /Check the native session/);
  await c.check(unknown.actionId);
  assert.equal(unknown.status, 'acknowledged');
  assert.equal(calls.find(x => x.m === 'receipt').id, commands.answer.actionId);
  assert.equal(calls.filter(x => x.m === 'submit').length, 2, 'no automatic retry');
});

test('close aborts reads and drops every private row, draft and receipt; late responses are ignored', async () => {
  const hold = deferred();
  const { c, calls } = controllerWith({ history: () => hold.promise, getCapabilities: async () => capabilities.idle });
  c.select(parent); const opening = c.open();
  c.setDraft(null, null, 'prompt', canaries.draft);
  await tick();
  c.close();
  assert.equal(calls.find(x => x.m === 'history').o.signal.aborted, true);
  hold.resolve(histories[selectionKey(parent)]); await opening;
  const dump = JSON.stringify({ h: c.history(), caps: c.caps(), d: [...c.drafts], del: c.deliveries() });
  for (const marker of Object.values(canaries)) assert.ok(!dump.includes(marker));
  c.select(sibling); await c.open();
  assert.equal(c.selection, null, 'a closed controller stays closed');
});

test('question completeness honours min and max choices and free text', () => {
  const q = { minChoices: 1, maxChoices: 1, allowText: false };
  assert.equal(questionComplete(q, undefined), false);
  assert.equal(questionComplete(q, { choiceIds: ['a'] }), true);
  assert.equal(questionComplete(q, { choiceIds: ['a', 'b'] }), false);
  assert.equal(questionComplete({ ...q, allowText: true }, { choiceIds: [], text: '  ' }), false);
  assert.equal(questionComplete({ ...q, allowText: true }, { choiceIds: [], text: 'mine' }), true);
  assert.equal(questionComplete({ minChoices: 2, maxChoices: 3, allowText: false }, { choiceIds: ['a'] }), false);
  assert.equal(questionComplete({ minChoices: 2, maxChoices: 3, allowText: false }, { choiceIds: ['a', 'b'] }), true);
  assert.match(reasonText('observed_only'), /observed only/);
  assert.match(reasonText(null), /observed only/);
});

// The DOM behaviour (rendering, focus, scroll, keyboard, sheet) runs in headless Edge against the same fixtures.
const runner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/web/inspector/harness/run.mjs');
const hasEdge = process.env.EDGE ? existsSync(process.env.EDGE)
  : ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].some(existsSync);
test('inspector DOM scenarios pass in headless Edge', { skip: hasEdge ? false : 'Edge not found: run src/web/inspector/harness/run.mjs where Edge exists', timeout: 240_000 }, () => {
  const run = spawnSync(process.execPath, [runner, '--json'], { encoding: 'utf8', timeout: 220_000, maxBuffer: 16 * 1024 * 1024 });
  const report = JSON.parse(run.stdout.trim().split('\n').at(-1));
  const failed = report.results.filter(r => !r.pass);
  assert.deepEqual(failed.map(r => `${r.scenario}: ${r.name} ${r.detail}`), []);
  assert.deepEqual(report.exceptions, []);
  assert.ok(report.total >= 90, `ran ${report.total} checks`);
});

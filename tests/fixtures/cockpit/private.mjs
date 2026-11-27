import { bedrock, child, freeze, parent, selectionKey, sibling, times } from './public.mjs';

export const canaries = freeze({
  parent: 'PRIVATE_FIXTURE_PARENT_91', child: 'PRIVATE_FIXTURE_CHILD_27', sibling: 'PRIVATE_FIXTURE_SIBLING_53',
  question: 'PRIVATE_FIXTURE_QUESTION_48', permission: 'PRIVATE_FIXTURE_PERMISSION_39', draft: 'PRIVATE_FIXTURE_DRAFT_72',
});

const page = (text, source) => ({
  entries: [
    { id: source + ':11', at: times[0] - 500, kind: 'user', text },
    { id: source + ':32', at: times[0] - 500, kind: 'tool', text: 'Read · export.mjs' },
    { id: source + ':80', at: times[1], kind: 'assistant', text: 'Export is ready to review.' },
  ],
  before: null, after: 'fixture-after-' + source, gap: null,
});
export const histories = freeze({
  [selectionKey(parent)]: page(canaries.parent, 'parent'),
  [selectionKey(child)]: page(canaries.child, 'child'),
  [selectionKey(sibling)]: page(canaries.sibling, 'sibling'),
});
export const historyPages = freeze({
  older: { entries: [{ id: 'parent:3', at: times[0] - 1000, kind: 'user', text: 'Prepare a synthetic export.' }],
    before: null, after: 'fixture-after-parent:3', gap: null },
  latest: { ...histories[selectionKey(parent)], before: 'fixture-before-parent:11' },
  newer: { entries: [{ id: 'parent:112', at: times[5], kind: 'assistant', text: 'The export uses today.' }],
    before: null, after: 'fixture-after-parent:112', gap: null },
  empty: { entries: [], before: null, after: 'fixture-after-empty', gap: null },
});

const epoch = 'fixture-instance-1';
const turnId = 'fixture-turn-1';
const followUpQuestion = {
  id: 'question-format', label: 'Choose a format', choices: [{ id: 'csv', label: 'CSV' }, { id: 'json', label: 'JSON' }],
  minChoices: 1, maxChoices: 1, allowText: false,
};
const question = {
  id: 'request-1', turnId, kind: 'question', text: canaries.question + ' Which date should the export use?',
  questions: [{ id: 'question-date', label: 'Choose a date', choices: [{ id: 'today', label: 'Today' }, { id: 'month', label: 'Month end' }],
    minChoices: 1, maxChoices: 1, allowText: false }],
};
const permission = {
  id: 'permission-1', turnId, kind: 'permission', operation: canaries.permission + ' Write export.mjs',
  scope: 'export.mjs in the current project', decisions: ['allow-once', 'deny'],
};
function capability(revision, available, { activeTurnId = null, pending = [], reason = null } = {}) {
  return { epoch, revision, actionWindow: available.some(kind => kind !== 'history') ? 'fixture-window-' + revision : null,
    available, activeTurnId, pending, reason };
}
export const capabilities = freeze({
  observed: capability('observed', ['history'], { reason: 'observed_only' }),
  unsupported: capability('unsupported', [], { reason: 'unsupported_surface' }),
  question: capability('r1', ['history', 'answer'], { activeTurnId: turnId, pending: [question] }),
  withdrawn: capability('r2', ['history'], { activeTurnId: turnId }),
  multiple: capability('r3', ['history', 'answer'], { activeTurnId: turnId, pending: [
    { ...question, id: 'request-2', questions: [...question.questions, followUpQuestion] },
    { ...question, id: 'request-3' },
  ] }),
  permission: capability('r4', ['history', 'allow-once', 'deny'], { activeTurnId: turnId, pending: [permission] }),
  idle: capability('r5', ['history', 'prompt']),
  active: capability('r6', ['history', 'steer'], { activeTurnId: 'fixture-turn-2' }),
});
function command(index, caps, kind, payload, requestId = null) {
  return { actionId: '00c0ffee-0000-4000-8000-' + String(index).padStart(12, '0'), epoch: caps.epoch,
    revision: caps.revision, actionWindow: caps.actionWindow, kind, turnId: caps.activeTurnId, requestId, payload };
}
const date = { questionId: 'question-date', choiceIds: ['today'] };
const answer = command(2, capabilities.multiple, 'answer',
  { answers: [date, { questionId: 'question-format', choiceIds: ['csv'] }] }, 'request-2');
export const commands = freeze({
  stale: command(1, capabilities.question, 'answer', { answers: [date] }, question.id),
  answer,
  duplicate: structuredClone(answer),
  conflictingReuse: { ...answer, payload: { answers: [date, { questionId: 'question-format', choiceIds: ['json'] }] } },
  allow: command(3, capabilities.permission, 'allow-once', { decision: 'allow-once' }, permission.id),
  deny: command(4, capabilities.permission, 'deny', { decision: 'deny' }, permission.id),
  prompt: command(5, capabilities.idle, 'prompt', { text: canaries.draft }),
  steer: command(6, capabilities.active, 'steer', { text: canaries.draft }),
});
export const receipts = freeze({
  pending: { actionId: answer.actionId, status: 'pending', at: times[4] },
  unknown: { actionId: answer.actionId, status: 'delivery-unknown', at: times[4] },
  acknowledged: { actionId: answer.actionId, status: 'acknowledged', at: times[5] },
  immediate: { actionId: answer.actionId, status: 'acknowledged', at: times[4] },
});
export const errors = freeze({
  stale: { code: 'stale_request', message: 'This question has closed.' },
  unavailable: { code: 'unavailable', message: 'This conversation is unavailable.' },
  conflict: { code: 'action_id_conflict', message: 'This action ID has already been used.' },
});
export const targets = freeze({
  parent: { selection: parent, provider: 'anthropic', nativeSessionId: 'session-fixture-A', connectionGeneration: 'connection-1' },
  child: { selection: child, provider: 'anthropic', nativeSessionId: 'session-fixture-child', connectionGeneration: null },
  sibling: { selection: sibling, provider: 'openai', nativeSessionId: 'thread-fixture-B', connectionGeneration: null },
  bedrock: { selection: bedrock, provider: 'bedrock', nativeSessionId: 'session-fixture-C', connectionGeneration: null },
});
export const deliveryCases = freeze({
  stale: { target: targets.parent, command: commands.stale, capabilities: capabilities.withdrawn,
    error: errors.stale, dispatchCount: 0 },
  reconnect: { target: targets.parent, command: commands.answer, retry: commands.duplicate,
    mutation: commands.conflictingReuse, capabilities: capabilities.multiple, receiptOrder: [
      receipts.pending, receipts.unknown, receipts.acknowledged,
    ], reuseError: errors.conflict, dispatchCount: 1 },
  immediate: { target: targets.parent, command: commands.answer, capabilities: capabilities.multiple,
    receiptOrder: [receipts.immediate], dispatchCount: 1 },
});

function reject(dto) {
  throw Object.assign(new Error(dto.message), dto);
}

/** Scripted browser client. Inject async overrides to hold a response across a selection change. */
export function createFixtureClient({ history, getCapabilities, submit, receipt } = {}) {
  return {
    async history(selection, options) {
      options?.signal?.throwIfAborted();
      if (history) return history(selection, options);
      return histories[selectionKey(selection)] ?? reject(errors.unavailable);
    },
    async capabilities(selection, options) {
      options?.signal?.throwIfAborted();
      if (getCapabilities) return getCapabilities(selection, options);
      return histories[selectionKey(selection)] ? capabilities.observed : capabilities.unsupported;
    },
    async submit(selection, command, options) {
      options?.signal?.throwIfAborted();
      return submit ? submit(selection, command, options) : reject(errors.unavailable);
    },
    async receipt(selection, actionId, options) {
      options?.signal?.throwIfAborted();
      return receipt ? receipt(selection, actionId, options) : reject(errors.unavailable);
    },
  };
}

/** Scripted provider with a call trace. The dispatcher owns deduplication and target authorization. */
export function createFixtureAdapter({ getCapabilities = () => capabilities.observed,
  dispatch = () => receipts.unknown, reconcile = () => receipts.acknowledged } = {}) {
  const calls = [];
  return {
    calls,
    async capabilities(target) { return getCapabilities(target); },
    async dispatch(target, command) {
      calls.push({ target, command });
      return dispatch(target, command);
    },
    async reconcile(target, receipt) { return reconcile(target, receipt); },
    close() {},
  };
}

// operator-cockpit P4: bounded private history readers for Claude transcripts and Codex rollouts.
// Every file here is synthetic and lives under the OS temp folder. No test reads a real profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHistoryReader, createHistoryService, HistoryError, LIMITS, openHistorySource } from '../src/sources/history/index.mjs';
import { createToolSummary } from '../src/domain/tools.mjs';
import { createRedactor } from '../src/app/publish.mjs';
import { child, parent, selection, sibling, T0 } from './fixtures/cockpit/public.mjs';
import { canaries } from './fixtures/cockpit/private.mjs';

const summarizeTool = createToolSummary(createRedactor().redact);
const reader = createHistoryReader({ summarizeTool });
const KiB = 1024;

// Local markers for content that must stay hidden. The shared canaries come from the frozen P1 fixture.
const hidden = {
  meta: 'PRIVATE_FIXTURE_META_11', reasoning: 'PRIVATE_FIXTURE_REASONING_64', toolOutput: 'PRIVATE_FIXTURE_TOOL_OUTPUT_22',
  reminder: 'PRIVATE_FIXTURE_REMINDER_08', summary: 'PRIVATE_FIXTURE_SUMMARY_76', partial: 'PRIVATE_FIXTURE_PARTIAL_05',
  system: 'PRIVATE_FIXTURE_SYSTEM_33', context: 'PRIVATE_FIXTURE_CONTEXT_17', patch: 'PRIVATE_FIXTURE_PATCH_90',
  foreign: 'PRIVATE_FIXTURE_FOREIGN_81', codexChild: 'PRIVATE_FIXTURE_CODEX_CHILD_44', oversized: 'PRIVATE_FIXTURE_OVERSIZED_66',
};
const markers = { parent: canaries.parent, child: canaries.child, sibling: canaries.sibling, ...hidden };
const iso = ms => new Date(ms).toISOString();
const jl = (record, eol = '\n') => JSON.stringify(record) + eol;
const claudeUser = (uuid, content, at = T0, extra = {}) => ({ type: 'user', uuid, timestamp: iso(at), sessionId: 'session-fixture-A',
  message: { role: 'user', content }, ...extra });
const claudeAssistant = (uuid, id, content, at = T0, extra = {}) => ({ type: 'assistant', uuid, timestamp: iso(at),
  sessionId: 'session-fixture-A', message: { id, role: 'assistant', model: 'claude-opus-5-5', content }, ...extra });
const codex = (type, payload, at = T0) => ({ timestamp: iso(at), type, payload });
const codexChildSelection = selection(sibling.sessionId, 'codex:thread-fixture-B-child');
const childNative = { sessionId: 'session-fixture-A', agentId: 'a-review-1' };

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hud-history-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Real-shaped JSONL for a Claude parent with a separate child and a Codex sibling with its own child. */
async function writeFixtures(dir) {
  const claudeRoot = path.join(dir, 'claude', 'projects');
  const project = path.join(claudeRoot, '-fixture-Ledger');
  const parentFile = path.join(project, 'session-fixture-A.jsonl');
  const childFile = path.join(project, 'session-fixture-A', 'subagents', 'agent-a-review-1.jsonl');
  const codexRoot = path.join(dir, 'codex', 'sessions');
  const day = path.join(codexRoot, '2026', '11', '27');
  const siblingFile = path.join(day, 'rollout-2026-11-27T10-00-00-thread-fixture-B.jsonl');
  const codexChildFile = path.join(day, 'rollout-2026-11-27T10-00-05-thread-fixture-B-child.jsonl');
  await fs.mkdir(path.dirname(childFile), { recursive: true });
  await fs.mkdir(day, { recursive: true });
  const cwd = '/fixture/Ledger';
  await fs.writeFile(parentFile, [
    jl({ type: 'summary', summary: 'Export work', leafUuid: 'u0' }),
    jl(claudeUser('u1', `<local-command-caveat>${hidden.meta}</local-command-caveat>`, T0, { isMeta: true })),
    jl(claudeUser('u2', `${canaries.parent} Check the invoice export — 請 🧾`, T0, { cwd }), '\r\n'),
    jl(claudeAssistant('a1', 'msg_1', [{ type: 'thinking', thinking: hidden.reasoning, signature: 'sig' }], T0 + 1)),
    jl(claudeAssistant('a2', 'msg_1', [{ type: 'text', text: 'Reading the export.' }], T0 + 1)),
    jl(claudeAssistant('a3', 'msg_1', [{ type: 'text', text: 'Reading the export.' }], T0 + 1)),   // repeated block line
    jl(claudeAssistant('a4', 'msg_1', [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: cwd + '/src/export.mjs' } }], T0 + 1, { cwd })),
    jl(claudeUser('u3', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: hidden.toolOutput }], T0 + 2, { toolUseResult: { content: hidden.toolOutput } })),
    jl(claudeAssistant('a5', 'msg_2', [{ type: 'tool_use', id: child.agentId, name: 'Agent',
      input: { subagent_type: 'Explore', description: 'Review export', prompt: canaries.child } }], T0 + 3)),
    jl(claudeUser('u4', canaries.child, T0 + 3, { isSidechain: true, agentId: 'a-review-1' })),   // older in-file sidechain shape
    jl(claudeUser('u5', [{ type: 'tool_result', tool_use_id: child.agentId, content: [{ type: 'text', text: canaries.child }] }], T0 + 4,
      { toolUseResult: { agentId: 'a-review-1', status: 'completed', content: [{ type: 'text', text: canaries.child }] } })),
    jl(claudeUser('u6', [{ type: 'text', text: `<system-reminder>${hidden.reminder}</system-reminder>` },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'text', text: 'Use today’s date.' }], T0 + 5), '\r\n'),
    jl(claudeUser('u7', '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>', T0 + 6)),
    jl({ type: 'system', subtype: 'compact_boundary', uuid: 's1', timestamp: iso(T0 + 6), content: 'Conversation compacted' }),
    jl(claudeUser('u8', hidden.summary, T0 + 6, { isCompactSummary: true })),
    jl(claudeAssistant('a6', 'msg_3', [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'curl --token abc123 https://x.test' } }], T0 + 7)),
    jl(claudeAssistant('a7', 'msg_3', [{ type: 'text', text: 'Which date should the export use?' }], T0 + 7)),
    jl({ type: 'file-history-snapshot', messageId: 'a7', snapshot: { files: hidden.toolOutput.repeat(50) } }),
    `{"type":"user","uuid":"u9","message":{"role":"user","content":"${hidden.partial}`,   // partial last line
  ].join(''));
  await fs.writeFile(childFile, [
    jl(claudeUser('c1', `${canaries.child} Review the export`, T0 + 3, { isSidechain: true, agentId: 'a-review-1' })),
    jl(claudeAssistant('c2', 'msg_c1', [{ type: 'text', text: 'Review done.' }], T0 + 4, { isSidechain: true, agentId: 'a-review-1' })),
    jl(claudeUser('c3', hidden.foreign, T0 + 4, { isSidechain: true, agentId: 'a-other' })),
  ].join(''));
  const meta = (id, source) => codex('session_meta', { id, timestamp: iso(T0), cwd: '/fixture/Reports', originator: 'codex_cli_rs',
    cli_version: '0.171.0', source, model_provider: 'openai', base_instructions: { text: hidden.system } });
  await fs.writeFile(siblingFile, [
    jl(meta('thread-fixture-B', 'cli')),
    jl(codex('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: hidden.system }] })),
    jl(codex('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context>${hidden.context}</environment_context>` }] })),
    jl(codex('turn_context', { cwd: '/fixture/Reports', model: 'gpt-test-codex', effort: 'high' })),
    jl(codex('event_msg', { type: 'user_message', message: `${canaries.sibling} Summarise the report — ü 🚀`, images: [] }, T0 + 1), '\r\n'),
    jl(codex('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${canaries.sibling} Summarise the report — ü 🚀` }] }, T0 + 1)),
    jl(codex('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: hidden.reasoning }], encrypted_content: 'enc' }, T0 + 2)),
    jl(codex('event_msg', { type: 'agent_reasoning', text: hidden.reasoning }, T0 + 2)),
    jl(codex('response_item', { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: JSON.stringify({ cmd: 'npm test -- --token abc123' }) }, T0 + 3)),
    jl(codex('response_item', { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: JSON.stringify({ cmd: 'npm test -- --token abc123' }) }, T0 + 3)),
    jl(codex('response_item', { type: 'function_call_output', call_id: 'call_1', output: hidden.toolOutput }, T0 + 4)),
    jl(codex('response_item', { type: 'function_call', name: 'collaboration.spawn_agent', call_id: 'call_2',
      arguments: JSON.stringify({ task_name: 'review', message: hidden.codexChild }) }, T0 + 4)),
    jl(codex('event_msg', { type: 'collab_agent_spawn_end', prompt: hidden.codexChild }, T0 + 4)),
    jl(codex('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_3', input: hidden.patch }, T0 + 5)),
    jl(codex('response_item', { type: 'custom_tool_call_output', call_id: 'call_3', output: hidden.toolOutput }, T0 + 5)),
    jl(codex('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 5, output_tokens: 2 } } }, T0 + 5)),
    jl(codex('event_msg', { type: 'agent_message', message: 'Report summarised.' }, T0 + 6)),
    jl(codex('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Report summarised.' }] }, T0 + 6)),
    jl(codex('event_msg', { type: 'user_message', message: 'ok' }, T0 + 7)),
    jl(codex('event_msg', { type: 'user_message', message: 'ok' }, T0 + 7)),   // a legitimate repeat stays distinct
    `{"timestamp":"${iso(T0 + 8)}","type":"event_msg","payload":{"type":"agent_message","message":"${hidden.partial}`,
  ].join(''));
  await fs.writeFile(codexChildFile, [
    jl(meta('thread-fixture-B-child', { subagent: { thread_spawn: { parent_thread_id: 'thread-fixture-B', agent_role: 'explorer' } } })),
    jl(codex('event_msg', { type: 'user_message', message: `${hidden.codexChild} Review the report` }, T0 + 4)),
    jl(codex('event_msg', { type: 'agent_message', message: 'Child review done.' }, T0 + 5)),
  ].join(''));
  return { claudeRoot, codexRoot, parentFile, childFile, siblingFile, codexChildFile };
}

function spyHandle(handle) {
  const spy = {
    bytes: 0, reads: 0, closes: 0,
    async read(buffer, offset, length, position) {
      spy.reads++;
      const result = await handle.read(buffer, offset, length, position);
      spy.bytes += result.bytesRead;
      return result;
    },
    stat: options => handle.stat(options),
    async close() { spy.closes++; },
  };
  return spy;
}

/** One request against `file` through the trusted opener, with a read counter on the borrowed handle. */
async function request(file, provider, entity, options = {}, { native, roots, reader: use = reader } = {}) {
  const opened = await openHistorySource({ provider, files: [file], native }, { roots: roots ?? [path.dirname(file)] });
  const spy = spyHandle(opened.source.handle);
  try {
    const page = await use.readHistory({ source: { ...opened.source, handle: spy }, selection: entity, ...options });
    return { page, bytes: spy.bytes, closes: spy.closes };
  } finally { await opened.close(); }
}

/** Initial page, then older pages until the start of the file. Entries come back in ascending order. */
async function walkBackward(file, provider, entity, extra) {
  const pages = [];
  let options = {};
  for (let guard = 0; guard < 100; guard++) {
    const result = await request(file, provider, entity, options, extra);
    pages.push(result);
    if (!result.page.before) break;
    options = { before: result.page.before };
  }
  return { pages, entries: pages.toReversed().flatMap(({ page }) => page.entries) };
}

const shape = page => page.entries.map(({ kind, text }) => [kind, text]);
function assertOnly(page, allowed) {
  const wire = JSON.stringify(page);
  for (const [name, marker] of Object.entries(markers)) {
    if (!allowed.includes(name)) assert.ok(!wire.includes(marker), `${name} marker leaked`);
  }
}

test('Claude parent and child pages show exactly the visible allowlist', async t => {
  const f = await writeFixtures(await tempDir(t));
  const { page } = await request(f.parentFile, 'claude', parent);
  assert.deepEqual(shape(page), [
    ['user', `${canaries.parent} Check the invoice export — 請 🧾`],
    ['assistant', 'Reading the export.'],
    ['tool', 'Read · src/export.mjs'],
    ['tool', 'Agent · Explore: Review export'],
    ['user', 'Use today’s date.'],
    ['user', '/compact'],
    ['tool', 'Bash · curl --token ••• https://x.test'],
    ['assistant', 'Which date should the export use?'],
  ]);
  assert.deepEqual(page.gap, { records: 1, reasons: { compacted: 1 } });
  assert.equal(page.before, null);
  assert.ok(page.after);
  assert.equal(page.entries[0].at, T0);
  assertOnly(page, ['parent']);

  const childPage = (await request(f.childFile, 'claude', child, {}, { native: childNative })).page;
  assert.deepEqual(shape(childPage), [['user', `${canaries.child} Review the export`], ['assistant', 'Review done.']]);
  assert.equal(childPage.gap, null);
  assertOnly(childPage, ['child']);
});

test('Codex sibling and child rollouts show only the canonical event family and redacted tools', async t => {
  const f = await writeFixtures(await tempDir(t));
  const { page } = await request(f.siblingFile, 'codex', sibling);
  assert.deepEqual(shape(page), [
    ['user', `${canaries.sibling} Summarise the report — ü 🚀`],
    ['tool', 'exec_command · npm test -- --token •••'],
    ['tool', 'spawn_agent · review'],
    ['tool', 'apply_patch · Apply file changes'],
    ['assistant', 'Report summarised.'],
    ['user', 'ok'],
    ['user', 'ok'],
  ]);
  assert.equal(page.gap, null);
  assert.notEqual(page.entries[5].id, page.entries[6].id);
  assertOnly(page, ['sibling']);
  const childPage = (await request(f.codexChildFile, 'codex', codexChildSelection)).page;
  assert.deepEqual(shape(childPage), [['user', `${hidden.codexChild} Review the report`], ['assistant', 'Child review done.']]);
  assertOnly(childPage, ['codexChild']);
});

test('pages walk backwards in 40-entry steps with stable ids, equal timestamps and distinct identical messages', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'paged.jsonl');
  const lines = [];
  for (let i = 0; i < 100; i++) {
    const text = i === 50 || i === 51 ? 'same text' : `message ${i}`;
    lines.push(jl(claudeUser('p' + i, text, T0)));   // every record has the same timestamp
  }
  await fs.writeFile(file, lines.join(''));
  const { pages, entries } = await walkBackward(file, 'claude', parent);
  assert.deepEqual(pages.map(({ page }) => page.entries.length), [40, 40, 20]);
  assert.deepEqual(entries.map(e => e.text), Array.from({ length: 100 }, (_, i) => i === 50 || i === 51 ? 'same text' : `message ${i}`));
  assert.equal(new Set(entries.map(e => e.id)).size, 100);
  assert.ok(entries.every(e => e.at === T0));
  const again = await walkBackward(file, 'claude', parent);
  assert.deepEqual(again.entries.map(e => e.id), entries.map(e => e.id));
  for (const { bytes } of pages) assert.ok(bytes <= LIMITS.scanBytes);
});

test('a repeated assistant block split across a page boundary is shown once', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'fold.jsonl');
  const small = createHistoryReader({ summarizeTool, limits: { entries: 2 } });
  await fs.writeFile(file, [
    jl(claudeUser('f1', 'first')),
    jl(claudeAssistant('f2', 'msg_f', [{ type: 'text', text: 'shared block' }])),
    jl(claudeAssistant('f3', 'msg_f', [{ type: 'text', text: 'shared block' }])),
    jl(claudeUser('f4', 'third')),
  ].join(''));
  // Pages of two: the newest page holds f3 and f4, so the repeat's first copy (f2) sits on the older page.
  const { pages, entries } = await walkBackward(file, 'claude', parent, { reader: small });
  assert.deepEqual(pages.map(({ page }) => page.entries.map(e => e.text)), [['shared block', 'third'], ['first']]);
  assert.deepEqual(entries.map(e => e.text), ['first', 'shared block', 'third']);
  // Within one page the first occurrence in source order wins.
  const together = await request(file, 'claude', parent);
  assert.deepEqual(together.page.entries.map(e => e.text), ['first', 'shared block', 'third']);
  assert.equal(together.page.entries[1].id.split(':')[1], String(Buffer.byteLength(jl(claudeUser('f1', 'first')))));
  // Forward: the boundary entry's block is repeated by the next appended line (how Claude Code repeats block lines).
  const growing = path.join(dir, 'fold-forward.jsonl');
  await fs.writeFile(growing, jl(claudeUser('g1', 'first')) + jl(claudeAssistant('g2', 'msg_g', [{ type: 'text', text: 'streamed block' }])));
  const first = await request(growing, 'claude', parent, {}, { reader: small });
  assert.deepEqual(first.page.entries.map(e => e.text), ['first', 'streamed block']);
  await fs.appendFile(growing, jl(claudeAssistant('g3', 'msg_g', [{ type: 'text', text: 'streamed block' }])) + jl(claudeUser('g4', 'fourth')));
  const forward = await request(growing, 'claude', parent, { after: first.page.after }, { reader: small });
  assert.deepEqual(forward.page.entries.map(e => e.text), ['fourth']);
});

test('a late append during pagination reaches only the forward cursor', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'append.jsonl');
  await fs.writeFile(file, Array.from({ length: 60 }, (_, i) => jl(claudeUser('l' + i, `old ${i}`))).join(''));
  const first = (await request(file, 'claude', parent)).page;
  await fs.appendFile(file, ['new 0', 'new 1', 'new 2'].map((text, i) => jl(claudeUser('n' + i, text))).join(''));
  const older = (await request(file, 'claude', parent, { before: first.before })).page;
  assert.deepEqual(older.entries.map(e => e.text), Array.from({ length: 20 }, (_, i) => `old ${i}`));
  assert.equal(older.before, null);
  assert.equal(older.after, null);
  const newer = (await request(file, 'claude', parent, { after: first.after })).page;
  assert.deepEqual(newer.entries.map(e => e.text), ['new 0', 'new 1', 'new 2']);
  assert.equal(newer.before, null);
  const ids = [...older.entries, ...first.entries, ...newer.entries].map(e => e.id);
  assert.equal(new Set(ids).size, 63);
  const idle = (await request(file, 'claude', parent, { after: newer.after })).page;
  assert.deepEqual(idle.entries, []);
});

test('a partial UTF-8 final record is retried intact once its line completes', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'unicode.jsonl');
  const record = Buffer.from(jl(claudeUser('z1', 'emoji 🧾 and 請')));
  const cut = record.indexOf(Buffer.from('🧾')) + 2;   // inside the four-byte emoji
  await fs.writeFile(file, Buffer.concat([Buffer.from(jl(claudeUser('z0', 'before'))), record.subarray(0, cut)]));
  const first = (await request(file, 'claude', parent)).page;
  assert.deepEqual(first.entries.map(e => e.text), ['before']);
  const waiting = (await request(file, 'claude', parent, { after: first.after })).page;
  assert.deepEqual(waiting.entries, []);
  await fs.appendFile(file, record.subarray(cut));
  const done = (await request(file, 'claude', parent, { after: waiting.after })).page;
  assert.deepEqual(done.entries.map(e => e.text), ['emoji 🧾 and 請']);
  assert.equal(done.gap, null);
});

test('rotation and in-place truncation make old cursors stale (409) and a fresh page works', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'rotate.jsonl');
  await fs.writeFile(file, Array.from({ length: 50 }, (_, i) => jl(claudeUser('r' + i, `gen1 ${i}`))).join(''));
  const first = (await request(file, 'claude', parent)).page;
  const replacement = path.join(dir, 'rotate.next');
  await fs.writeFile(replacement, Array.from({ length: 60 }, (_, i) => jl(claudeUser('s' + i, `gen2 ${i}`))).join(''));
  await fs.rename(replacement, file);
  for (const cursor of [{ before: first.before }, { after: first.after }]) {
    await assert.rejects(request(file, 'claude', parent, cursor), { code: 'stale_cursor', status: 409 });
  }
  const fresh = (await request(file, 'claude', parent)).page;
  assert.equal(fresh.entries.at(-1).text, 'gen2 59');

  const again = (await request(file, 'claude', parent)).page;
  await fs.truncate(file, 0);
  await fs.writeFile(file, Array.from({ length: 80 }, (_, i) => jl(claudeUser('t' + i, `rewritten ${i}`))).join(''));
  await assert.rejects(request(file, 'claude', parent, { after: again.after }), { code: 'stale_cursor' });
  await assert.rejects(request(file, 'claude', parent, { before: again.before }), { code: 'stale_cursor' });
  await fs.truncate(file, 100);
  await assert.rejects(request(file, 'claude', parent, { after: again.after }), { code: 'stale_cursor', status: 409 });
});

test('an oversized record is skipped whole across bounded windows in both directions', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'oversized.jsonl');
  const big = jl(claudeUser('big', hidden.oversized + ' ' + 'x'.repeat(1536 * KiB)));
  await fs.writeFile(file, jl(claudeUser('o1', 'before the big record')) + big + jl(claudeUser('o2', 'after the big record')));
  const { pages, entries } = await walkBackward(file, 'claude', parent);
  assert.deepEqual(entries.map(e => e.text), ['before the big record', 'after the big record']);
  assert.ok(pages.length >= 4, 'the record spans several windows');
  for (const { bytes } of pages) assert.ok(bytes <= LIMITS.scanBytes, `read ${bytes} bytes in one call`);
  assert.equal(pages.reduce((n, { page }) => n + (page.gap?.reasons.oversized || 0), 0), 1);
  assert.ok(pages.slice(1, -1).some(({ page }) => page.entries.length === 0 && page.before), 'zero-entry continuation');
  for (const { page } of pages) assertOnly(page, []);

  // Forward: the same record appended after the first page, then a normal record.
  const tail = path.join(dir, 'forward.jsonl');
  await fs.writeFile(tail, jl(claudeUser('o1', 'start')));
  let cursor = (await request(tail, 'claude', parent)).page.after;
  await fs.appendFile(tail, big + jl(claudeUser('o3', 'resumed')));
  const seen = [];
  let oversized = 0;
  for (let guard = 0; guard < 20 && !seen.length; guard++) {
    const { page, bytes } = await request(tail, 'claude', parent, { after: cursor });
    assert.ok(bytes <= LIMITS.scanBytes);
    oversized += page.gap?.reasons.oversized || 0;
    seen.push(...page.entries.map(e => e.text));
    assertOnly(page, []);
    cursor = page.after;
  }
  assert.deepEqual(seen, ['resumed']);
  assert.equal(oversized, 1);
});

test('a giant unterminated tail neither blocks older history nor parses as messages', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'tail.jsonl');
  const big = jl(claudeUser('big', hidden.oversized + ' ' + 'y'.repeat(700 * KiB)));
  await fs.writeFile(file, jl(claudeUser('g1', 'older')) + big.slice(0, -2));
  const first = await request(file, 'claude', parent);
  assert.deepEqual(first.page.entries, []);
  assert.ok(first.page.before && first.page.after);
  let options = { before: first.page.before };
  const older = [];
  for (let guard = 0; guard < 10 && options.before; guard++) {
    const { page, bytes } = await request(file, 'claude', parent, options);
    assert.ok(bytes <= LIMITS.scanBytes);
    assertOnly(page, []);
    older.push(...page.entries.map(e => e.text));
    options = { before: page.before };
  }
  assert.deepEqual(older, ['older']);
  await fs.appendFile(file, big.slice(-2) + jl(claudeUser('g2', 'newer')));
  let cursor = first.page.after;
  const newer = [];
  for (let guard = 0; guard < 10 && !newer.length; guard++) {
    const { page } = await request(file, 'claude', parent, { after: cursor });
    newer.push(...page.entries.map(e => e.text));
    assertOnly(page, []);
    cursor = page.after;
  }
  assert.deepEqual(newer, ['newer']);
});

test('a window of filtered records returns a continuation with zero entries', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'filtered.jsonl');
  const results = Array.from({ length: 700 }, (_, i) => jl(claudeUser('tr' + i,
    [{ type: 'tool_result', tool_use_id: 'toolu_' + i, content: hidden.toolOutput + ' ' + 'z'.repeat(1000) }])));
  await fs.writeFile(file, jl(claudeUser('v1', 'visible prompt')) + results.join(''));
  const first = await request(file, 'claude', parent);
  assert.deepEqual(first.page.entries, []);
  assert.ok(first.page.before);
  assert.equal(first.page.gap, null);
  const { entries } = await walkBackward(file, 'claude', parent);
  assert.deepEqual(entries.map(e => e.text), ['visible prompt']);
});

test('cursors are bound to entity, direction, instance and integrity, and checked before any read', async t => {
  const f = await writeFixtures(await tempDir(t));
  const many = path.join(path.dirname(f.parentFile), 'many.jsonl');
  await fs.writeFile(many, Array.from({ length: 50 }, (_, i) => jl(claudeUser('m' + i, `m ${i}`))).join(''));
  const first = (await request(many, 'claude', parent)).page;
  const cases = [
    [{ before: first.before }, child, 'invalid_cursor'],            // the parent's cursor offered for its child
    [{ before: first.before }, sibling, 'invalid_cursor'],          // a sibling with the same label
    [{ after: first.before }, parent, 'invalid_cursor'],            // wrong direction
    [{ before: first.before.slice(0, -2) + 'AA' }, parent, 'invalid_cursor'],
    [{ before: 'x'.repeat(3000) }, parent, 'invalid_cursor'],
    [{ before: first.before, after: first.after }, parent, 'bad_request'],
  ];
  for (const [options, entity, code] of cases) {
    const opened = await openHistorySource({ provider: 'claude', files: [many] }, { roots: [path.dirname(many)] });
    const spy = spyHandle(opened.source.handle);
    try {
      await assert.rejects(reader.readHistory({ source: { ...opened.source, handle: spy }, selection: entity, ...options }), { code });
      assert.equal(spy.reads, 0, 'no bytes read for ' + code);
    } finally { await opened.close(); }
  }
  const restarted = createHistoryReader({ summarizeTool });
  await assert.rejects(request(many, 'claude', parent, { before: first.before }, { reader: restarted }), { code: 'stale_cursor', status: 409 });
  await assert.rejects(request(many, 'codex', parent, { before: first.before }), { code: 'invalid_cursor' });
  await assert.rejects(request(many, 'claude', { sessionId: '', agentId: null }), { code: 'bad_request', status: 400 });
});

test('the reader borrows the handle: it never closes it, and the service closes it exactly once', async t => {
  const f = await writeFixtures(await tempDir(t));
  const ok = await request(f.parentFile, 'claude', parent);
  assert.equal(ok.closes, 0);

  const opens = [], closes = [];
  const open = async (file, flags) => {
    const handle = await fs.open(file, flags);
    opens.push(file);
    const close = handle.close.bind(handle);
    handle.close = async () => { closes.push(file); return close(); };
    return handle;
  };
  const records = {
    [JSON.stringify(parent)]: { provider: 'claude', files: [f.parentFile] },
    [JSON.stringify(child)]: { provider: 'claude', files: [path.join(path.dirname(f.childFile), 'agent-missing.jsonl')], native: childNative },
  };
  const service = createHistoryService({ resolve: async entity => records[JSON.stringify(entity)] ?? null,
    readHistory: reader.readHistory, roots: { claude: [f.claudeRoot], codex: [f.codexRoot] }, open });
  const page = await service.history(parent);
  assert.equal(page.entries.length, 8);
  await assert.rejects(service.history(parent, { after: page.before ?? 'bad.cursor' }), { code: 'invalid_cursor' });
  const controller = new AbortController();
  const slow = createHistoryReader({ summarizeTool });
  const aborting = createHistoryService({ resolve: async () => records[JSON.stringify(parent)], roots: { claude: [f.claudeRoot] }, open,
    readHistory: options => { controller.abort(); return slow.readHistory(options); } });
  await assert.rejects(aborting.history(parent, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(opens.length, 3);
  assert.deepEqual(closes, opens, 'every open handle closed exactly once');

  // A missing child is unavailable; the parent transcript is never opened in its place.
  await assert.rejects(service.history(child), { code: 'unavailable', status: 404 });
  await assert.rejects(service.history(selection(sibling.sessionId, child.agentId)), { code: 'unavailable' });
  assert.equal(opens.length, 3);
});

test('source resolution: configured extra roots, conflicts and paths outside the roots', async t => {
  const dir = await tempDir(t);
  const f = await writeFixtures(dir);
  const extraRoot = path.join(dir, 'claude-work', 'projects');
  const extraFile = path.join(extraRoot, '-fixture-Ledger', 'session-fixture-A.jsonl');
  await fs.mkdir(path.dirname(extraFile), { recursive: true });
  await fs.writeFile(extraFile, jl(claudeUser('x1', 'from the second profile')));
  const outside = path.join(dir, 'elsewhere.jsonl');
  await fs.writeFile(outside, jl(claudeUser('x2', 'outside')));
  const roots = [f.claudeRoot, extraRoot];
  const page = (await request(extraFile, 'claude', parent, {}, { roots })).page;
  assert.deepEqual(shape(page), [['user', 'from the second profile']]);
  await assert.rejects(request(extraFile, 'claude', parent, {}, { roots: [f.claudeRoot] }), { code: 'unavailable' });
  await assert.rejects(request(outside, 'claude', parent, {}, { roots }), { code: 'unavailable' });
  await assert.rejects(openHistorySource({ provider: 'claude', files: [f.parentFile, extraFile] }, { roots }),
    err => err instanceof HistoryError && err.code === 'unavailable' && err.reason === 'conflict');
  const sameFile = path.join(path.dirname(f.parentFile), '.', path.basename(f.parentFile));
  const same = await openHistorySource({ provider: 'claude', files: [f.parentFile, sameFile] }, { roots });
  await same.close();
  await assert.rejects(openHistorySource({ provider: 'bedrock', files: [f.parentFile] }, { roots }), { code: 'unavailable' });
  // A directory link inside a root that points outside it is refused after realpath.
  const link = path.join(f.claudeRoot, 'linked');
  let linked = true;
  try { await fs.symlink(dir, link, 'junction'); } catch { linked = false; }
  if (linked) await assert.rejects(request(path.join(link, 'elsewhere.jsonl'), 'claude', parent, {}, { roots }), { code: 'unavailable' });
});

test('unknown, malformed, empty and oversized-entry content is explicit, never a silent empty conversation', async t => {
  const dir = await tempDir(t);
  const unknown = path.join(dir, 'unknown.jsonl');
  await fs.writeFile(unknown, jl({ type: 'future-record', text: hidden.foreign }) + jl({ kind: 'no-type' }) + 'not json\n');
  const page = (await request(unknown, 'claude', parent)).page;
  assert.deepEqual(page.entries, []);
  assert.deepEqual(page.gap, { records: 3, reasons: { malformed: 1, unknown: 2 } });
  assertOnly(page, []);

  const oldCodex = path.join(dir, 'rollout-old.jsonl');
  await fs.writeFile(oldCodex, jl(codex('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }))
    + jl(codex('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] })));
  const old = (await request(oldCodex, 'codex', sibling)).page;
  assert.deepEqual(old.entries, []);
  assert.deepEqual(old.gap, { records: 2, reasons: { unknown: 2 } });

  const empty = path.join(dir, 'empty.jsonl');
  await fs.writeFile(empty, '');
  const none = (await request(empty, 'claude', parent)).page;
  assert.deepEqual({ ...none, after: typeof none.after }, { entries: [], before: null, after: 'string', gap: null });

  const invalid = path.join(dir, 'invalid.jsonl');
  await fs.writeFile(invalid, Buffer.concat([Buffer.from('{"type":"user","message":{"content":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}}\n')]));
  assert.deepEqual((await request(invalid, 'claude', parent)).page.gap, { records: 1, reasons: { malformed: 1 } });

  const long = path.join(dir, 'long.jsonl');
  await fs.writeFile(long, jl(claudeUser('big', '請'.repeat(5000))));   // 15,000 bytes of three-byte characters
  const [entry] = (await request(long, 'claude', parent)).page.entries;
  assert.equal(entry.truncated, true);
  assert.ok(Buffer.byteLength(entry.text) <= LIMITS.entryBytes);
  assert.ok(entry.text.endsWith(' … [truncated]'));
  assert.ok(!entry.text.includes('�'));
});

test('history stays off the public paths: the tailer and publisher never import it', async () => {
  const source = name => fs.readFile(new URL('../src/' + name, import.meta.url), 'utf8');
  for (const name of ['app/live.mjs', 'app/publish.mjs', 'app/runtime.mjs', 'sources/tail-reader.mjs', 'sources/claude-transcripts.mjs',
    'sources/codex-rollouts.mjs', 'http/server.mjs']) {
    assert.ok(!/sources\/history|['"]\.\/history/.test(await source(name)), name + ' imports history');
  }
  for (const name of ['index.mjs', 'reader.mjs', 'cursor.mjs', 'claude.mjs', 'codex.mjs', 'source.mjs', 'errors.mjs']) {
    const text = await source('sources/history/' + name);
    assert.ok(!/tail-reader|app\/live|app\/publish|setInterval|watch\(/.test(text), name + ' reaches into the live runtime');
  }
});

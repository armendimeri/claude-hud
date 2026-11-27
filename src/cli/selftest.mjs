import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { HOOK_FIELDS, TOOL_INPUT_FIELDS, TOOL_RESPONSE_FIELDS, slimHookPayload } from '../../hud-hook.mjs';
import { createRedactor } from '../app/publish.mjs';
import { addPrompt, idWords, indexPlans, linkAgents, promptRefs, resolveWork } from '../domain/board-links.mjs';
import { boardState, followBoards } from '../domain/board-status.mjs';
import { modelInfo, normalizeModel, rawModel } from '../domain/models.mjs';
import { BOARD_HEADER, parsePlan } from '../domain/plan-parser.mjs';
import { createTranscriptInfo } from '../domain/sessions.mjs';
import { createToolSummary } from '../domain/tools.mjs';
import { hostAllowed, writeAllowed } from '../http/security.mjs';
import { createClaudeTranscripts } from '../sources/claude-transcripts.mjs';
import { notificationReason } from '../sources/hooks.mjs';
import { HOOK_COMMAND, HOOK_EVENTS, backupSettings, formatLike, installInto, isOurHook, ourGroup, parseSettings,
  removeOurs, uninstallFrom } from './hook-settings.mjs';

export function selftest({ port: PORT, hostname: HOSTNAME, unclaimedMs, stalledMs }) {
  const { redact } = createRedactor();
  const summarizeTool = createToolSummary(redact);
  // The fixtures exercise the line parser directly without opening transcripts.
  const claude = createClaudeTranscripts({ roots: [], lifetime: { task: fn => fn }, reader: {}, summarizeTool });
  let failed = 0;
  const check = (label, got, want) => {
    const ok = isDeepStrictEqual(got, want);
    if (!ok) failed++;
    console.log(`${ok ? 'pass' : 'FAIL'}  ${label}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  };
  check('model claude-opus-5-5', normalizeModel('claude-opus-5-5'), { model: 'claude-opus-5-5', provider: 'anthropic' });
  check('model anthropic.claude-opus-5-5-v1:0', normalizeModel('anthropic.claude-opus-5-5-v1:0'), { model: 'claude-opus-5-5', provider: 'bedrock' });
  check('model us.anthropic.claude-opus-5-5-v1:0', normalizeModel('us.anthropic.claude-opus-5-5-v1:0'), { model: 'claude-opus-5-5', provider: 'bedrock' });
  check('model global.anthropic.claude-sonnet-5-5-v1:0', normalizeModel('global.anthropic.claude-sonnet-5-5-v1:0'), { model: 'claude-sonnet-5-5', provider: 'bedrock' });
  check('model inference-profile ARN', normalizeModel('arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5-v1:0'), { model: 'claude-opus-5-5', provider: 'bedrock' });
  check('model unknown string', normalizeModel('gpt-4o-mini'), { model: 'gpt-4o-mini', provider: 'unknown' });
  check('model anthropic.claude-haiku-5-5 (Mantle id)', normalizeModel('anthropic.claude-haiku-5-5'), { model: 'claude-haiku-5-5', provider: 'bedrock' });
  check('model dated id', normalizeModel('claude-sonnet-4-5-20250929'), { model: 'claude-sonnet-4-5', provider: 'anthropic' });
  check('model [1m] id', normalizeModel('claude-opus-4-6[1m]'), { model: 'claude-opus-4-6', provider: 'anthropic' });

  // Provider from transcript lines, as Claude Code writes them (Bedrock shapes seen on a real Bedrock setup, 2026-10-29).
  const agentFrom = (...lines) => {
    const t = { info: createTranscriptInfo(), owner: null };
    for (const l of lines) claude.processLine(t, JSON.stringify(l));
    const raw = rawModel(t.info);
    return { raw, ...modelInfo(raw, t.info) };
  };
  const req = model => ({ type: 'api-request', sessionId: 's', params: { model, max_tokens: 64000 } });
  const reply = (model, id) => ({ type: 'assistant', sessionId: 's', message: { id, model, usage: { input_tokens: 1, output_tokens: 1 } } });
  check('provider: Bedrock request id + plain reply model', agentFrom(req('us.anthropic.claude-opus-5-5'), reply('claude-opus-5-5', 'msg_bdrk_01abc')),
    { raw: 'us.anthropic.claude-opus-5-5', model: 'claude-opus-5-5', provider: 'bedrock' });
  check('provider: msg_bdrk_ id alone', agentFrom(reply('claude-sonnet-5-5', 'msg_bdrk_01abc')),
    { raw: 'claude-sonnet-5-5', model: 'claude-sonnet-5-5', provider: 'bedrock' });
  check('provider: Anthropic API', agentFrom(req('claude-opus-5-5'), reply('claude-opus-5-5', 'msg_01abc')),
    { raw: 'claude-opus-5-5', model: 'claude-opus-5-5', provider: 'anthropic' });
  check('provider: model switched, new request not answered yet', agentFrom(reply('claude-opus-5-5', 'msg_bdrk_01abc'), req('us.anthropic.claude-sonnet-5-5')),
    { raw: 'claude-opus-5-5', model: 'claude-opus-5-5', provider: 'bedrock' });

  // D15: which Host headers and which peers are allowed, with LAN mode off and on.
  const hostOk = (host, lan) => hostAllowed(host, { port: PORT, hostname: HOSTNAME, lan });
  const isLoopback = address => writeAllowed(address, undefined, PORT);
  check('host: localhost, LAN off', [hostOk(`127.0.0.1:${PORT}`, false), hostOk(`localhost:${PORT}`, false)], [true, true]);
  check('host: IP address and PC name refused with LAN off', [hostOk(`192.168.1.20:${PORT}`, false), hostOk(`${HOSTNAME}:${PORT}`, false)], [false, false]);
  check('host: IPv4 address, PC name and name.local with LAN on', [hostOk(`192.168.1.20:${PORT}`, true), hostOk(`${HOSTNAME}:${PORT}`, true), hostOk(`${HOSTNAME.toUpperCase()}.local:${PORT}`, true)], [true, true, true]);
  check('host: IPv6 address with LAN on', hostOk(`[fe80::1]:${PORT}`, true), true);
  check('host: rebinding names and wrong ports refused with LAN on', [hostOk(`evil.test:${PORT}`, true), hostOk(`192.168.1.20.evil.test:${PORT}`, true), hostOk(`192.168.1.20:${PORT + 1}`, true), hostOk('', true)], [false, false, false, false]);
  check('peer: only this PC may report', [isLoopback('127.0.0.1'), isLoopback('::1'), isLoopback('::ffff:127.0.0.1'), isLoopback('192.168.1.20'), isLoopback('::ffff:192.168.1.20'), isLoopback(undefined)], [true, true, true, false, false, false]);

  check('notification: permission for Bash', notificationReason('permission_prompt', 'Claude needs your permission to use Bash'), { kind: 'permission', text: 'Permission: Bash' });
  check('notification: AskUserQuestion via a permission prompt', notificationReason('permission_prompt', 'Claude needs your permission to use AskUserQuestion'), { kind: 'question', text: 'Question for you' });
  check('notification: idle', notificationReason('idle_prompt', 'Claude is waiting for your input'), { kind: 'input', text: 'Waiting for your input' });

  const secret = 'sqlcmd -S db -U sa -P Secret123 -Q "x"; Server=db;User Id=sa;Password=abc; key AKIAABCDEFGHIJKLMNOP AWS_BEARER_TOKEN_BEDROCK=xyz';
  const r = redact(secret);
  check('redact: no secret survives', ['Secret123', 'abc;', 'AKIAABCDEFGHIJKLMNOP', 'xyz'].filter(x => r.includes(x)), []);
  check('redact: masks in each place', (r.match(/•••/g) || []).length, 5);
  console.log(`      ${r}`);
  check('redact: Bearer', redact('curl -H "Authorization: Bearer eyJhbGciOi.abc.def"'), 'curl -H "Authorization: Bearer •••"');
  check('redact: token=, api_key=, secret=', redact('a?token=t0k3n&api_key=k3y secret=s3cr3t'), 'a?token=•••&api_key=••• secret=•••');
  check('redact: aws_secret_access_key', redact('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'), 'aws_secret_access_key=•••');
  check('redact: long key-like run', redact('key sk-ant-api03-AbCdEf0123456789AbCdEf0123456789xyz'), 'key •••');
  check('redact: paths, slugs and UUIDs survive',
    redact('C:/Users/armen/source/repos/WasteManagement2/docs/plans/customer-history-and-change-requests/STATUS.md d2d3c4b1-a846-4eae-84ea-4a06c1d0c9d0'),
    'C:/Users/armen/source/repos/WasteManagement2/docs/plans/customer-history-and-change-requests/STATUS.md d2d3c4b1-a846-4eae-84ea-4a06c1d0c9d0');
  check('redact: max_tokens survives', redact('max_tokens: 64000'), 'max_tokens: 64000');

  check('summary Bash, 80 characters', summarizeTool('Bash', { command: 'x'.repeat(100) }, null).length, 80);
  const longCommand = 'echo --token private-' + 'x'.repeat(16_000) + ' ' + 'y'.repeat(100);
  check('summary Bash redacts long commands before truncating',
    summarizeTool('Bash', { command: longCommand }, null), 'echo --token ••• ' + 'y'.repeat(62) + '…');
  check('summary Read relative', summarizeTool('Read', { file_path: 'C:\\repo\\src\\a.cs' }, 'C:\\repo'), 'src/a.cs');
  check('summary WebFetch drops the query', summarizeTool('WebFetch', { url: 'https://x.test/a/b?token=1' }, null), 'x.test/a/b');

  const board = parsePlan(`# Thing: status and handoffs
## Board
| Phase | Agent | State | Since | Handoff | Notes |
|---|---|---|---|---|---|
| P0 Decisions | human | accepted | 2026-10-29 | — | |
| P1 Data | \`data\` | in-progress | 2026-10-29 | | Waits for P0 (done) |
| P2 UI | \`ui\` | todo | | | Waits for P1 · runs alongside P3 |
| P3 Requests | \`req\` | todo | | | Waits for P1 · runs alongside P2 |
| P4 Verify | \`verify\` | todo | | | Waits for P1–P3 |
## Kickoff
| Phase | Model | Effort | Why |
|---|---|---|---|
| P1 \`data\` | Opus 5.5 | high | x |
## Log
- one
- two
`, 'C:/r/docs/plans/thing/STATUS.md', 'C:/r', 'r');
  check('plan: board phases and edges', board.phases.map(p => [p.id, p.agent, p.state, p.waitsFor]),
    [['P0', 'human', 'accepted', []], ['P1', 'data', 'in-progress', ['P0']], ['P2', 'ui', 'todo', ['P1']], ['P3', 'req', 'todo', ['P1']], ['P4', 'verify', 'todo', ['P1', 'P2', 'P3']]]);
  check('plan: title, slug, kickoff model, log', [board.title, board.slug, board.phases[1].model, board.phases[1].effort, board.lastLog], ['Thing', 'thing', 'Opus 5.5', 'high', ['one', 'two']]);
  const chunks = parsePlan(`# Chunk status board
## Runs
| Run | Title | Chunks, in order | Model / effort | Start when | Lane | Status |
|---|---|---|---|---|---|---|
| R1 | Foundation | P0-01 → P0-02 | Sonnet 5.5 / medium | any time | A | done |
## Phase 0: Foundation — \`00-Foundation.md\`
| Chunk | Title | Depends on | Model / effort | Status | Handoff |
|---|---|---|---|---|---|
| P0-01 | Projects | — | — | done | |
| P0-02 | Packages | P0-01, O-4 | Opus 5.5 / medium | in progress (2026-10-21) | |
| UX-20 | Sweep | P0-01 to P0-02 | Opus 5.5 / high | partial (2026-10-22): owner review | |
## Owner inputs
| ID | Input | Status |
|---|---|---|
| O-4 | Samples | in (2026-10-21): 5 quotations |
`, 'C:/r/Documentation/Implementation/STATUS.md', 'C:/r', 'r');
  check('plan: chunk board', chunks.phases.map(p => [p.id, p.kind, p.state, p.waitsFor, p.group]),
    [['P0-01', 'chunk', 'done', [], 'Phase 0: Foundation'], ['P0-02', 'chunk', 'in-progress', ['P0-01', 'O-4'], 'Phase 0: Foundation'],
      ['UX-20', 'chunk', 'partial', ['P0-01', 'P0-02'], 'Phase 0: Foundation'], ['O-4', 'input', 'done', [], 'Owner inputs']]);
  check('plan: runs', chunks.runs.map(r => [r.id, r.state, r.chunks, r.lane, r.model, r.effort]), [['R1', 'done', ['P0-01', 'P0-02'], 'A', 'Sonnet 5.5', 'medium']]);
  check('plan: generic title falls back to the folder', chunks.title, 'Implementation');
  const handoff = parsePlan(`# Phone App: Handoff (after phase 6)
| Phase | State |
|---|---|
| 0: fix the call → order path | Done, committed (\`307e784\`). |
| 4: Blazor phone UI | **Built and verified on the emulator, uncommitted.** |
| 7: real phones | **Code side done, uncommitted**. The real-phone pass has not been run. |
`, 'C:/r/docs/phone-app/HANDOFF.md', 'C:/r', 'r');
  check('plan: Phase | State table', handoff.phases.map(p => [p.id, p.name, p.state]), [['0', 'fix the call → order path', 'done'], ['4', 'Blazor phone UI', 'done'], ['7', 'real phones', 'partial']]);
  const std = parsePlan(`# Thing: status
## Board

${BOARD_HEADER}
|---|---|---|---|---|---|---|---|---|
| P0 | Decisions | human | — | — | accepted | 2026-10-29 | — | |
| P1 | Data | \`data\` | P0, other-plan/P2 | Opus 5.5 / high | in-progress | 2026-10-29 | | port 5098 |
| P3-01 | Migrate A | \`migrate\` | P1 | Sonnet 5.5 / high | todo | | | lane A |
| P3-02 | Migrate B | \`migrate\` | P1, O-1 | Sonnet 5.5 / medium | blocked | 2026-10-29 | | Q1 |
| O-1 | Sample data | owner | — | — | todo | | | unlocks P3-02 |
| P4 | Review | \`review\` | P3-01–P3-02 | Opus 5.5 / high | todo | | | |

## Runs

| Run | Items, in order | Model / effort | Lane | Start when | State |
|---|---|---|---|---|---|
| R1 | P3-01 → P3-02 | Sonnet 5.5 / high | A | P1 | todo |

## Decisions (P0)

- [x] **D1** Port 7777.
- [ ] **D2** Keep the old price ★

## Questions

| # | Item | Question | Recommended | Answer |
|---|---|---|---|---|
| 1 | P3-02 | Cut or widen? | Widen | |
| 2 | P1 | Which port? | 5098 | 5098, user |
`, 'C:/r/docs/plans/thing/STATUS.md', 'C:/r', 'r', '# Thing\n\nStatus: **approved** 2026-10-28 · Written 2026-10-27\n');
  check('standard: items, kinds, deps and cross-plan deps', std.phases.map(p => [p.id, p.name, p.agent, p.kind, p.state, p.waitsFor, p.waitsForOther, p.model, p.effort]), [
    ['P0', 'Decisions', 'human', 'item', 'accepted', [], [], null, null],
    ['P1', 'Data', 'data', 'item', 'in-progress', ['P0'], ['other-plan/P2'], 'Opus 5.5', 'high'],
    ['P3-01', 'Migrate A', 'migrate', 'item', 'todo', ['P1'], [], 'Sonnet 5.5', 'high'],
    ['P3-02', 'Migrate B', 'migrate', 'item', 'blocked', ['P1', 'O-1'], [], 'Sonnet 5.5', 'medium'],
    ['O-1', 'Sample data', 'owner', 'input', 'todo', [], [], null, null],
    ['P4', 'Review', 'review', 'item', 'todo', ['P3-01', 'P3-02'], [], 'Opus 5.5', 'high']]);
  check('standard: runs', std.runs.map(r => [r.id, r.chunks, r.lane, r.waitsFor, r.state]), [['R1', ['P3-01', 'P3-02'], 'A', ['P1'], 'todo']]);
  check('standard: format, header state, needs you', [std.format, std.size, std.state, std.stateDate, std.needsYou], ['standard', 'phased', 'approved', '2026-10-28', [
    { kind: 'decision', id: 'D2', text: 'D2 Keep the old price ★' }, { kind: 'question', id: '1', item: 'P3-02', text: 'Cut or widen?' }]]);
  const smallStd = parsePlan(`# Plan: Booking changes

Status: **building** · Written 2026-10-27

## Board

${BOARD_HEADER}
|---|---|---|---|---|---|---|---|---|
| P1 | Dates | \`bookings\` | — | Sonnet 5.5 / high | handed-off | 2026-10-29 | — | |
`, 'C:/r/docs/plans/booking-changes.md', 'C:/r', 'r');
  check('standard: small plan', [smallStd.slug, smallStd.title, smallStd.size, smallStd.state, smallStd.phases.length], ['booking-changes', 'Booking changes', 'small', 'building', 1]);
  check('plan: no board → no plan', parsePlan('# Status\n| Module | What |\n|---|---|\n| a | b |\n', 'C:/r/docs/status.md', 'C:/r', 'r'), null);

  // hud-0-3 P4: board following (PLAN §4.2). Plans alpha and beta in project r, gamma in project q.
  const boardMd = (rows, more = '') => `# T: status\n## Board\n\n${BOARD_HEADER}\n|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n${more}`;
  const row = (id, state, deps = '—', agent = 'a', handoff = '') => `| ${id} | Item ${id} | ${agent} | ${deps} | Opus 5.5 / high | ${state} | | ${handoff} | |`;
  const RUNS = '\n## Runs\n\n| Run | Items, in order | Model / effort | Lane | Start when | State |\n|---|---|---|---|---|---|\n| R1 | P2 → P3 | Opus 5.5 / high | A | P1 | todo |\n';
  const alpha = parsePlan(boardMd([row('P0', 'accepted', '—', 'human', '—'), row('P1', 'handed-off', 'P0', 'a', '[P1](handoffs/P1-a.md)'), row('P2', 'todo', 'P1'),
    row('P3', 'todo', 'P2'), row('P5', 'accepted'), row('P6-02', 'todo')], RUNS), 'C:/r/docs/plans/alpha/STATUS.md', 'C:/r', 'r');
  const beta = parsePlan(boardMd([row('P5', 'todo'), row('P6-02', 'todo'), row('P7', 'todo')]), 'C:/r/docs/plans/beta/STATUS.md', 'C:/r', 'r');
  const gamma = parsePlan(boardMd([row('P1', 'todo')]), 'C:/q/docs/plans/gamma/STATUS.md', 'C:/q', 'q');
  const ix = indexPlans([alpha, beta, gamma]);
  const work = (ev, parent = null) => resolveWork({ project: 'r', label: null, refs: [], touched: [], branch: null, ...ev }, parent, ix);
  const A = 'r|alpha', B = 'r|beta', file = slug => `r|docs/plans/${slug}/status.md`;
  const W = (plan, ...items) => ({ plan, items: items.map(([id, via, p = plan]) => ({ id, via, plan: p })), role: 'worker' });
  check('board: the Handoff cell is kept as filled or not ("—" is not)', alpha.phases.map(n => [n.id, n.handoff]),
    [['P0', false], ['P1', true], ['P2', false], ['P3', false], ['P5', false], ['P6-02', false]]);
  check('board: ID-shaped words, in text order; paths and names are not IDs',
    idWords('Do `hud-0-3/P4`. Then P1, P2-ish, docs/plans/hud-0-3/P5, P3-stream.md, UX-10 (P6-02) R2 xP9'), ['hud-0-3/P4', 'P1', 'UX-10', 'P6-02', 'R2']);
  const held = { refs: [] };
  addPrompt(held, 'Do alpha/P2');
  addPrompt(held, Array.from({ length: 45 }, (_, i) => `P${i + 10}`).join(' '));
  check('board: 40 words are kept, bare IDs (mentions) dropped first', [held.refs.flat().length, held.refs[0], held.refs[1][0]], [40, ['alpha/P2'], 'P16']);
  check('board: system reminders and command output are not prompt text', promptRefs('<system-reminder>Do alpha/P3</system-reminder>hi <bash-stdout>beta/P7</bash-stdout>'), null);
  // Step 2, the home plan.
  check('resolve 2.1: the first <slug>/… naming a plan of the project (gamma is another project\'s)', work({ refs: [['P1', 'gamma/P1', 'alpha/P9']] }), W(A));
  check('resolve 2.1: the newest prompt first', work({ refs: [['alpha/P2'], ['beta/P7']] }), W(B, ['P7', 'ref']));
  check('resolve 2.2: the plan of the newest touched file', work({ touched: [{ file: file('alpha'), write: false, at: 1000 }, { file: file('beta'), write: true, at: 2000 }] }), W(B));
  check('resolve 2.2: a write beats a read made within 10 minutes', work({ touched: [{ file: file('alpha'), write: true, at: 0 }, { file: file('beta'), write: false, at: 5 * 60_000 }] }), W(A));
  check('resolve 2.2: a read 11 minutes after a write wins', work({ touched: [{ file: file('alpha'), write: true, at: 0 }, { file: file('beta'), write: false, at: 11 * 60_000 }] }), W(B));
  check('resolve 2.2: PLAN.md and handoffs/ belong to the board next to them',
    [work({ touched: [{ file: 'r|docs/plans/beta/plan.md', write: false, at: 1 }] })?.plan, work({ touched: [{ file: 'r|docs/plans/alpha/handoffs/p1-a.md', write: true, at: 1 }] })?.plan,
      work({ touched: [{ file: 'r|docs/notes.md', write: true, at: 1 }] })], [B, A, null]);
  check('resolve 2.3: a branch <slug> or <slug>/…', [work({ branch: 'beta' }), work({ branch: 'beta/feature' })], [W(B), W(B)]);
  check('resolve 2.4: the parent\'s plan', work({ label: 'P6-02 payments' }, { plan: B }), W(B, ['P6-02', 'name']));
  check('resolve 2.5: no evidence, no plan', work({}), null);
  // Step 3, the items.
  check('resolve 3.1: <slug>/<ID> in the prompt', work({ refs: [['P7', 'alpha/P2']] }), W(A, ['P2', 'ref']));
  check('resolve 3.1: a run links itself and its current item', work({ refs: [['alpha/R1']] }), W(A, ['R1', 'ref'], ['P2', 'ref']));
  check('resolve 3.2: a label ID in the home plan', work({ refs: [['alpha/P9']], label: 'P6-02 partial payments' }), W(A, ['P6-02', 'name']));
  check('resolve 3.2: else the only plan that has it', work({ label: 'P7 tests' }), W(B, ['P7', 'name']));
  check('resolve 3.2: else the only plan where it is not finished', work({ label: 'P5 cleanup' }), W(B, ['P5', 'name']));
  check('resolve 3.2: an item outside the home plan keeps its own plan', work({ branch: 'alpha', label: 'P7 tests' }), W(A, ['P7', 'name', B]));
  check('resolve 3.3: a branch <slug>/<ID>, in any case', work({ branch: 'beta/p7-tests' }), W(B, ['P7', 'branch']));
  check('resolve 3: at most three items, ref first', work({ refs: [['alpha/R1']], label: 'P1 and P0 review' }), W(A, ['R1', 'ref'], ['P2', 'ref'], ['P1', 'name']));
  // Links to nothing (D2).
  check('resolve: nothing for an ID in two plans, both open', work({ label: 'P6-02 partial payments' }), null);
  check('resolve: nothing for an ID no plan has', work({ label: 'P99 something' }), null);
  check('resolve: nothing for a bare ID in the prompt (a mention)', work({ refs: [['P7']] }), null);
  check('resolve: nothing for a prompt that lists six IDs', work({ refs: [['P1', 'P2', 'P3', 'P5', 'P7', 'P6-02']], label: 'Review the board' }), null);
  check('resolve: nothing for another project\'s <slug>/<ID>', work({ refs: [['gamma/P1']] }), null);
  check('resolve: a branch with an ID its plan lacks gives the plan only', work({ branch: 'beta/P99' }), W(B));
  // Step 4, the role, and the marks and lists (§4.2) on a clock that the checks move.
  const agent = (key, ev) => ({ key, parent: null, sessionId: 's1', agentId: null, view: {}, project: 'r', label: null, refs: [], touched: [], branch: null, active: true, ...ev });
  const lead = agent('s1', { refs: [['alpha/P2']] }), helper = agent('s1/a1', { parent: 's1', agentId: 'a1', label: 'P3 the next one' });
  linkAgents([lead, helper], ix);
  check('resolve 4: a session with a subagent linked in its plan coordinates', [lead.work, helper.work], [{ ...W(A, ['P2', 'ref']), role: 'coordinator' }, W(A, ['P3', 'name'])]);
  const delta = parsePlan(boardMd([row('P0', 'todo'), row('P1', 'in-progress', 'P0'), row('P2', 'blocked', 'O-1'), row('O-1', 'todo', '—', 'owner')]), 'C:/r/docs/plans/delta/STATUS.md', 'C:/r', 'r');
  const old = parsePlan(`# Old\n## Board\n| Chunk | Title | Depends on | Status |\n|---|---|---|---|\n| UX-1 | One | — | handed off |\n| UX-2 | Two | UX-1 | todo |\n`, 'C:/r/docs/old/STATUS.md', 'C:/r', 'r');
  const ix2 = indexPlans([alpha, delta, old]), track = new Map(), limits = { track, unclaimedMs: 1000, stalledMs: 5000, floor: 0 };
  const one = agent('s2', { refs: [['alpha/P6-02']] });
  linkAgents([one], ix2);
  const at = now => boardState([one], ix2, { ...limits, now });
  const first = at(100), later = at(1200);
  check('marks: in flight on a todo item, unclaimed only after the limit', [first.board.items['r|alpha#P6-02'].flags, later.board.items['r|alpha#P6-02'].flags, later.turnedOn.map(x => x.flag)], [[], ['unclaimed'], ['unclaimed']]);
  check('marks: in-progress with a dependency open is early at once, stalled after the limit',
    [first.board.items['r|delta#P1'].flags, at(5000).board.items['r|delta#P1'].flags], [['early'], ['stalled', 'early']]);
  check('lists: ready (a run instead of its items; not human rows), awaiting, owner inputs; none for older boards',
    [later.board.ready, later.board.awaiting, later.board.ownerInputs, later.board.plans],
    [[{ plan: A, id: 'R1', run: true }, { plan: 'r|delta', id: 'P0', run: false }], [{ plan: A, id: 'P1' }], [{ plan: 'r|delta', id: 'O-1', unlocks: ['P2'] }], { [A]: { active: 1 } }]);
  one.active = false;
  check('marks: off when nobody works on it', [at(1300).board.items['r|alpha#P6-02'].flags, at(1300).board.ready.some(x => x.id === 'P6-02')], [[], true]);

  // Cost (§8 hard parts): 14 plans with 300 items and 30 agents, resolved once per snapshot.
  const many = Array.from({ length: 14 }, (_, k) => parsePlan(boardMd(Array.from({ length: k < 4 ? 30 : 18 }, (_, i) =>
    row(`P${i + 1}`, ['todo', 'in-progress', 'handed-off', 'accepted'][i % 4], i ? `P${i}` : '—'))), `C:/r/docs/plans/plan-${k}/STATUS.md`, 'C:/r', 'r'));
  const fleet = () => Array.from({ length: 30 }, (_, i) => agent(i % 3 ? `s${i - (i % 3)}/a${i}` : `s${i}`, {
    parent: i % 3 ? `s${i - (i % 3)}` : null, agentId: i % 3 ? `a${i}` : null, label: `P${(i % 18) + 1} task ${i}`, branch: i % 2 ? `plan-${i % 14}/P2` : 'main',
    refs: [['P1', 'P2', `plan-${i % 14}/P${(i % 9) + 1}`], ['P3', 'D4', 'Q1']],
    touched: Array.from({ length: 20 }, (_, j) => ({ file: `r|docs/plans/plan-${(i + j) % 14}/status.md`, write: j % 3 === 0, at: j * 1000 })) }));
  const items = many.reduce((n, p) => n + p.phases.length, 0);
  let ms = 0;
  const runs = 200, track2 = new Map();
  for (let k = 0; k < runs; k++) {
    const list = fleet(), t0 = performance.now();
    followBoards(list, many, { now: k * 250, track: track2, unclaimedMs, stalledMs, floor: 0 });
    ms += performance.now() - t0;
  }
  console.log(`      cost: ${(ms / runs).toFixed(3)} ms per snapshot for ${items} items in ${many.length} plans and 30 agents (average of ${runs})`);
  check('cost: under 5 ms per snapshot for 300 items and 30 agents', [items, ms / runs < 5], [300, true]);

  check('install: our group for PreToolUse', ourGroup('PreToolUse'), { matcher: '*', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 2, async: true }] });
  check('install: SessionEnd runs synchronously', ourGroup('SessionEnd'), { hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 2 }] });
  const oldHook = { type: 'command', command: 'node "C:/previous folder/hud.mjs" hook', timeout: 2, async: true };
  check('install: recognises the legacy command in another folder', isOurHook(oldHook), true);
  check('install: recognises a moved forwarder', isOurHook({ type: 'command', command: 'node "C:/previous folder/hud-hook.mjs"' }), true);
  check('install: removeOurs keeps other hooks', removeOurs([{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }, oldHook, ourGroup('Stop').hooks[0]] }, ourGroup('Stop')]),
    [{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] }]);

  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hud-selftest-'));
  try {
    const fixture = path.join(fixtureDir, 'settings.json');
    const original = '\ufeff{\r\n\t"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo keep"}]}]}\r\n}\r\n';
    const settings = parseSettings(original, fixture);
    settings.hooks.Stop.push({ hooks: [oldHook] });
    const legacy = formatLike(original, settings);
    fs.writeFileSync(fixture, legacy);
    backupSettings(original, fixture);
    check('install: migrates the legacy entry', installInto(fixture).changed, true);
    const upgraded = fs.readFileSync(fixture, 'utf8');
    const upgradedHooks = parseSettings(upgraded, fixture).hooks;
    check('install: preserves other hooks and installs the new command', upgradedHooks.Stop, [
      { hooks: [{ type: 'command', command: 'echo keep' }] }, ourGroup('Stop'),
    ]);
    check('install: respects the migrated settings', installInto(fixture).changed, false);
    check('uninstall: restores the original bytes after migration', [uninstallFrom(fixture).removed, fs.readFileSync(fixture, 'utf8')],
      [HOOK_EVENTS.length, original]);
    fs.writeFileSync(fixture, legacy);
    check('uninstall: also removes the legacy command directly', [uninstallFrom(fixture).removed, fs.readFileSync(fixture, 'utf8')],
      [1, original]);
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }

  const exampleFields = keys => Object.fromEntries(keys.map(key => [key, 'x'.repeat(1200)]));
  const slim = slimHookPayload({ ...exampleFields(HOOK_FIELDS), prompt: 'private', model: { id: 'test-model' },
    tool_input: { ...exampleFields(TOOL_INPUT_FIELDS), prompt: 'private' },
    tool_response: { ...exampleFields(TOOL_RESPONSE_FIELDS), output: 'private' } }, 123);
  check('hook: preserves only the shared fields and caps their sizes', [
    slim.hud_at, slim.model, Object.keys(slim), Object.keys(slim.tool_input), Object.keys(slim.tool_response),
    slim.cwd.length, slim.tool_input.command.length, slim.tool_response.agentId.length,
  ], [123, 'test-model', ['hud_at', ...HOOK_FIELDS, 'model', 'tool_input', 'tool_response'], TOOL_INPUT_FIELDS, TOOL_RESPONSE_FIELDS, 1000, 300, 200]);
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  return failed ? 1 : 0;
}

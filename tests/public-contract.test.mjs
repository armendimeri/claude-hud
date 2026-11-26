import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { board, script, startHud } from './helpers.mjs';
import { boardText, hookInput, seedContract, sessionId } from './fixtures/contract/scenario.mjs';

const samples = JSON.parse(await fs.readFile(new URL('./fixtures/contract/snapshot.json', import.meta.url), 'utf8'));
const keys = (obj, expected) => assert.deepEqual(Object.keys(obj).sort(), [...expected].sort());
const pick = (obj, sample) => Object.fromEntries(Object.keys(sample).map(key => [key, obj[key]]));
const isTime = value => Number.isSafeInteger(value) && value > 1_000_000_000_000;

function checkSnapshot(snapshot, mode) {
  keys(snapshot, mode === false ? [...samples.commonKeys, 'codex'] : samples.commonKeys);
  assert.equal(snapshot.demo, mode);
  assert.equal(typeof snapshot.host, 'string');
  assert.match(snapshot.version, /^\d+\.\d+\.\d+/);
  assert.ok(isTime(snapshot.now));
  assert.ok(Number.isSafeInteger(snapshot.uptime) && snapshot.uptime >= 0);
  for (const field of ['alerts', 'external', 'feed', 'plans', 'projects', 'sessions']) assert.ok(Array.isArray(snapshot[field]), field);
  keys(snapshot.board, ['items', 'plans', 'ready', 'awaiting', 'ownerInputs']);
  keys(snapshot.totals, ['sessions', 'needsYou', 'busy', 'subagentsRunning', 'agentsRunning', 'tokensToday', 'plansInProgress', 'plansNeedingYou']);
}

test('live HTTP and SSE preserve snapshot shape, frame order and replacement behavior', { timeout: 30000 }, async t => {
  const hud = await startHud({ start: false });
  t.after(() => hud.close());
  await seedContract(hud);
  await hud.restart();
  await hud.until(s => s.plans.length === 1 && s.sessions[0]?.tokens.output === 2);

  const subscribe = async () => {
    const stream = await hud.stream();
    t.after(() => stream.close());
    assert.match(stream.headers.get('content-type'), /^text\/event-stream\b/);
    const first = await stream.next();
    assert.equal(first.event, 'state');
    const { full, ...snapshot } = first.data;
    assert.equal(full, true);
    checkSnapshot(snapshot, false);
    return { stream, first };
  };
  const subscribers = [await subscribe(), await subscribe()];
  const at = Date.now() - 100;
  const send = (extra, hud_at) => hud.post({ ...hookInput, cwd: hud.dir, ...extra, hud_at });
  assert.equal(await send({}, at), 204);
  assert.equal(await send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'fixture-tool', tool_input: { command: 'git status' } }, at + 1), 204);
  for (const { stream, first } of subscribers) {
    const feed = await stream.next(e => e.event === 'event' && e.data.text === samples.liveFeed.text);
    const later = await stream.next(e => e !== first && e.event === 'state' && e.data.sessions[0]?.currentTool?.name === 'Bash');
    assert.ok(stream.events.indexOf(feed) < stream.events.indexOf(later));
    keys(later.data, Object.keys(first.data).filter(k => !['feed', 'plans', 'full'].includes(k)));
    assert.deepEqual({ ...feed.data, at: samples.liveFeed.at, project: 'fixture' }, samples.liveFeed);
    assert.equal(feed.data.at, at + 1);
  }

  const snapshot = await hud.state();
  checkSnapshot(snapshot, false);
  assert.deepEqual(pick(snapshot, samples.live), samples.live);
  assert.deepEqual(snapshot.codex, { readable: true, error: null, directories: [hud.codex, hud.extraCodex] });
  const session = snapshot.sessions.find(s => s.id === sessionId);
  assert.equal(session.pid, process.pid);
  assert.equal(session.cwd, hud.dir);
  assert.equal(session.project, path.basename(hud.dir));
  assert.ok(isTime(session.startedAt) && isTime(session.pulse.start));
  assert.equal(session.lastActivityAt, at + 1);
  assert.equal(session.currentTool.since, at + 1);
  assert.equal(session.turn.startedAt, at);
  const expected = samples.liveSession;
  assert.deepEqual({ ...session, pid: expected.pid, cwd: expected.cwd, project: expected.project, startedAt: expected.startedAt,
    lastActivityAt: expected.lastActivityAt, pulse: { ...session.pulse, start: expected.pulse.start },
    currentTool: { ...session.currentTool, since: expected.currentTool.since }, turn: { ...session.turn, startedAt: expected.turn.startedAt } }, expected);
  keys(snapshot.totals.tokensToday, Object.keys(expected.tokens));
  const [plan] = snapshot.plans;
  assert.equal(plan.project, session.project);
  assert.equal(plan.path, path.join(hud.dir, 'docs', 'plans', 'contract-plan', 'STATUS.md'));
  assert.ok(isTime(plan.touchedAt));
  assert.deepEqual({ ...plan, project: 'fixture', path: samples.livePlan.path, touchedAt: samples.livePlan.touchedAt }, samples.livePlan);
  assert.ok(!JSON.stringify(snapshot).includes(hookInput.prompt));

  const health = await fetch(hud.base + '/api/health');
  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-type'), /^application\/json\b/);
  const { uptime, ...info } = await health.json();
  assert.ok(Number.isSafeInteger(uptime) && uptime >= 0);
  assert.deepEqual(info, { ok: true, sessions: 1, version: snapshot.version });

  await board(hud, 'contract-plan', boardText('in-progress'));
  for (const { stream } of subscribers) {
    const replacement = await stream.next(e => e.event === 'plans');
    keys(replacement.data, ['plans']);
    assert.deepEqual(replacement.data.plans.map(p => [p.slug, p.phases[0].state]), [['contract-plan', 'in-progress']]);
    const feed = await stream.next(e => e.event === 'event' && e.data.text.includes('P1 todo → in-progress'));
    assert.ok(stream.events.indexOf(feed) < stream.events.indexOf(replacement));
  }
  subscribers[0].stream.close();
  const { first } = await subscribe();
  assert.equal(first.data.plans[0].phases[0].state, 'in-progress');
  assert.equal(first.data.feed[0].kind, 'plan');
  assert.equal(first.data.feed[0].text, 'Contract fixture: P1 todo → in-progress');
});

test('both demo modes publish the demo contract without live Codex metadata', async t => {
  for (const mode of [true, 'dense']) {
    const hud = await startHud({ demo: mode });
    t.after(() => hud.close());
    const snapshot = await hud.state();
    checkSnapshot(snapshot, mode);
    const { account, ...sample } = samples.demo;
    assert.deepEqual(pick(snapshot, sample), { ...sample, demo: mode });
    keys(snapshot.account, Object.keys(account));
    for (const window of ['fiveHour', 'sevenDay']) {
      keys(snapshot.account[window], Object.keys(account[window]));
      const { pct, resetsAt } = snapshot.account[window];
      assert.ok(Number.isFinite(pct) && isTime(resetsAt));
    }
    assert.ok(isTime(snapshot.account.fetchedAt));
    const codex = snapshot.sessions.find(s => s.agent === 'codex');
    if (mode === true) assert.deepEqual(pick(codex, samples.demoCodex), samples.demoCodex);
    else assert.equal(codex, undefined);
    assert.ok(snapshot.sessions.some(s => s.agent === 'claude'));
    const stream = await hud.stream();
    t.after(() => stream.close());
    const { event, data: { full, ...initial } } = await stream.next();
    assert.equal(event, 'state');
    assert.equal(full, true);
    checkSnapshot(initial, mode);
    stream.close();
  }
});

test('CLI help, errors and settings round trip are compatible', async t => {
  const hud = await startHud({ start: false });
  t.after(() => hud.close());
  async function cli(arg) {
    const child = hud.spawnCli([script, arg], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { err += chunk; });
    const [status] = await once(child, 'close');
    return { status, out, err };
  }

  const help = await cli('help');
  assert.equal(help.status, 0);
  assert.equal(help.err, '');
  for (const command of ['--lan', '--demo=dense', 'install', 'uninstall', 'autostart on|off', 'lint [repo] [--json]', 'selftest', 'hud-hook.mjs']) {
    assert.ok(help.out.includes(command), command);
  }
  assert.deepEqual(await cli('--help'), help);
  assert.deepEqual(await cli('-h'), help);
  assert.deepEqual(await cli('contract-unknown'), { status: 1, out: '', err: `Unknown command: contract-unknown\n\n${help.out}` });

  const settings = path.join(hud.claude, 'settings.json');
  const original = '\uFEFF{\r\n\t"hooks": {"PreToolUse":[{"matcher":"Read","hooks":[{"type":"command","command":"echo fixture"}]}]},\r\n\t"model": "fixture"\r\n}\r\n';
  await fs.writeFile(settings, original);
  const installed = await cli('install');
  assert.equal(installed.status, 0, installed.err);
  assert.match(installed.out, /Installed Claude HUD hooks for 11 events/);
  assert.match(installed.out, /Backup of the previous file/);
  const bytes = await fs.readFile(settings, 'utf8');
  const { hooks, model } = JSON.parse(bytes.slice(1));
  assert.equal(model, 'fixture');
  assert.equal(hooks.PreToolUse[0].hooks[0].command, 'echo fixture');
  assert.match(hooks.PreToolUse[1].hooks[0].command, /^node ".*\/hud-hook\.mjs"$/);
  assert.equal(hooks.PreToolUse[1].hooks[0].async, true);
  assert.ok(!hooks.SessionEnd[0].hooks[0].async);
  const repeated = await cli('install');
  assert.equal(repeated.status, 0, repeated.err);
  assert.match(repeated.out, /already installed/);
  assert.equal(await fs.readFile(settings, 'utf8'), bytes);
  const uninstalled = await cli('uninstall');
  assert.equal(uninstalled.status, 0, uninstalled.err);
  assert.match(uninstalled.out, /byte for byte/);
  assert.equal(await fs.readFile(settings, 'utf8'), original);
  await fs.writeFile(settings, '{ broken');
  const invalid = await cli('install');
  assert.equal(invalid.status, 1);
  assert.match(invalid.err, /is not valid JSON/);
  assert.equal(await fs.readFile(settings, 'utf8'), '{ broken');
});

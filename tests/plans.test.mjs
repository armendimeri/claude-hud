import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const script = path.resolve('hud.mjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const board = (state = 'todo') => `# Example: status
| ID | Item | State |
|---|---|---|
| P1 | Build | ${state} |
`;
const rollout = `# Security release
## The board
| # | Step | Job | Model · effort | Needs | Status |
|---|---|---|---|---|---|
| | **Foundations** | | | | |
| 1 | [RP01](phases/RP01.md) | Shared contracts | Opus 5.5 · high | — | done 2026-11-09 |
| 2 | [SI01](phases/SI01.md) | Sign-ins | Sonnet 5.5 · medium | 1 | doing |
| 33a | [D1.6](PLAN.md#fixes) | Review fixes | Opus 5.5 · high | 1–2 | todo |
| 34 | Owner sign-off | Real devices | owner | 33a | ready, waiting for the owner |
`;

async function harness(t, { noWatch = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hud-plans-test-'));
  let child, errors = '';
  t.after(async () => {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const repo = path.join(dir, 'repo'), claude = path.join(dir, 'claude'), codex = path.join(dir, 'codex');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await fs.mkdir(path.join(claude, 'sessions'), { recursive: true });
  await fs.mkdir(path.join(claude, 'projects'), { recursive: true });
  await fs.mkdir(path.join(codex, 'sessions'), { recursive: true });
  await fs.writeFile(path.join(claude, 'sessions', `${process.pid}.json`), JSON.stringify({
    sessionId: 'plan-session', pid: process.pid, cwd: repo, status: 'idle',
  }));
  const write = async (relative, text) => {
    const file = path.join(repo, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const args = [];
  if (noWatch) {
    const preload = path.join(dir, 'no-watch.mjs');
    await fs.writeFile(preload, `import fs from 'node:fs';
import { EventEmitter } from 'node:events';
fs.watch = () => Object.assign(new EventEmitter(), { close() {} });
`);
    args.push('--import', pathToFileURL(preload).href);
  }
  const state = async () => (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  const until = async predicate => {
    const deadline = Date.now() + 20000;
    let last;
    while (Date.now() < deadline) {
      try { last = await state(); if (predicate(last)) return last; } catch {}
      await pause(100);
    }
    assert.fail(`Plan state did not converge: ${errors}\n${JSON.stringify(last?.plans)}`);
  };
  const start = async () => {
    child = spawn(process.execPath, [...args, script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: claude, HUD_CLAUDE_DIRS: '',
      CODEX_HOME: codex, HUD_CODEX_DIRS: '', HUD_NO_AUTOINSTALL: '1', HUD_PORT: String(port), HUD_LAN: '0', HUD_BEDROCK_REGION: '',
    } });
    child.stdout.resume(); child.stderr.on('data', b => { errors += b; });
    await until(s => s.sessions.some(session => session.id === 'plan-session'));
  };
  return { repo, write, start, state, until, checkErrors: () => assert.equal(errors, '') };
}

test('rollout replaces a superseded board and file events update its progress', { timeout: 30000 }, async t => {
  const h = await harness(t);
  await h.write('docs/security/STATUS.md', board() + '\n**Superseded by [ROLLOUT.md](ROLLOUT.md) §4.**\n');
  await h.write('docs/security/ROLLOUT.md', rollout);
  await h.write('docs/archive/old/PLAN.md', board());
  await h.write('docs/security/handoff/STATUS.md', board());
  await h.write('docs/plans/paired/STATUS.md', board('accepted'));
  await h.write('docs/plans/paired/PLAN.md', 'Status: **building**\n' + board());
  await h.write('docs/standalone/IMPLEMENTATION_PLAN.md', '\uFEFF' + board('doing'));
  await h.write('docs/missing/STATUS.md', board() + '\nSuperseded by [missing](ROLLOUT.md).\n');
  await h.start();
  let s = await h.until(s => s.plans.length === 4);
  const release = s.plans.find(p => p.path.endsWith('ROLLOUT.md'));
  assert.ok(release);
  assert.equal(s.plans.some(p => p.path.endsWith(path.join('security', 'STATUS.md'))), false);
  assert.deepEqual(release.phases.map(p => [p.id, p.name, p.state, p.model, p.effort, p.waitsFor]), [
    ['1', 'RP01 · Shared contracts', 'done', 'Opus 5.5', 'high', []],
    ['2', 'SI01 · Sign-ins', 'in-progress', 'Sonnet 5.5', 'medium', ['1']],
    ['33a', 'D1.6 · Review fixes', 'todo', 'Opus 5.5', 'high', ['1', '2']],
    ['34', 'Owner sign-off · Real devices', 'todo', null, null, ['33a']],
  ]);
  assert.equal(release.phases[0].since, '2026-11-09');
  assert.equal(s.plans.find(p => p.path.includes('paired')).state, 'building');
  const standalone = s.plans.find(p => p.path.endsWith('IMPLEMENTATION_PLAN.md'));
  assert.equal(standalone.title, 'Example');
  assert.equal(standalone.phases[0].state, 'in-progress');

  await h.write('docs/security/ROLLOUT.md', rollout.replace('| doing |', '| done 2026-11-10 |'));
  s = await h.until(s => s.plans.find(p => p.path.endsWith('ROLLOUT.md'))?.phases[1].state === 'done');
  assert.ok(s.feed.some(e => e.kind === 'plan' && e.text.includes('in-progress → done')));
  await h.write('docs/plans/paired/PLAN.md', 'Status: **verified**\n' + board());
  await h.until(s => s.plans.find(p => p.path.includes('paired'))?.state === 'verified');
  await fs.unlink(path.join(h.repo, 'docs/security/ROLLOUT.md'));
  await h.until(s => s.plans.some(p => p.path.endsWith(path.join('security', 'STATUS.md'))) && !s.plans.some(p => p.path.endsWith('ROLLOUT.md')));
  h.checkErrors();
});

test('polling discovers late docs folders and recovers updates and deletions with file events disabled', { timeout: 60000 }, async t => {
  const h = await harness(t, { noWatch: true });
  await h.start();
  await pause(500); // the first scan has no docs folder to watch
  assert.equal((await h.state()).plans.length, 0);
  await h.write('docs/new/ROLLOUT.md', rollout);
  await h.until(s => s.plans.length === 1);
  await h.write('docs/new/ROLLOUT.md', rollout.replace('| doing |', '| done |'));
  await h.until(s => s.plans[0]?.phases[1].state === 'done');
  await fs.unlink(path.join(h.repo, 'docs/new/ROLLOUT.md'));
  await h.until(s => s.plans.length === 0);
  h.checkErrors();
});

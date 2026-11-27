import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { startHud } from './helpers.mjs';
import { createDemo } from '../src/demo/scenario.mjs';

test('CLI and Windows task action resolve from the extracted distribution', { timeout: 15000 }, async t => {
  const hud = await startHud({ start: false });
  t.after(() => hud.close());
  const distribution = path.join(hud.dir, "operator's HUD");
  const entry = path.join(distribution, 'hud.mjs');
  const cwd = path.join(hud.dir, 'invoker');
  await fs.mkdir(distribution);
  await fs.mkdir(cwd);
  for (const name of ['hud.mjs', 'hud-hook.mjs', 'src']) {
    await fs.cp(new URL(`../${name}`, import.meta.url), path.join(distribution, name), { recursive: true });
  }

  async function cli(...args) {
    const child = hud.spawnCli([entry, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    const [status] = await once(child, 'close');
    return { status, stdout, stderr };
  }

  const fixture = path.join(cwd, 'fixture');
  await fs.mkdir(path.join(fixture, 'docs', 'reference'), { recursive: true });
  const boardHeader = '| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |';
  await fs.mkdir(path.join(fixture, 'docs', 'plans'));
  await fs.writeFile(path.join(fixture, 'docs', 'plans', 'example.md'), [
    '# Example', 'Status: **building**', '## Board', boardHeader, '|---|---|---|---|---|---|---|---|---|',
    '| P1 | Example | test | — | Sonnet 5.5 / high | todo | | | |', '',
  ].join('\n'));
  const lint = await cli('lint', 'fixture', '--json');
  assert.equal(lint.status, 1);
  assert.equal(lint.stderr, '');
  const report = JSON.parse(lint.stdout);
  assert.equal(report.repo, fixture);
  assert.deepEqual(report.plans, ['docs/plans/example.md']);
  assert.ok(report.problems.some(p => p.file === 'CLAUDE.md'));
  assert.ok(report.problems.every(p => p.file !== 'docs/plans/example.md'));
  assert.ok((await cli('lint', 'absent')).stderr.startsWith('Not a folder:'));

  const selftest = await cli('selftest');
  assert.equal(selftest.status, 0, selftest.stderr || selftest.stdout);
  assert.equal(selftest.stderr, '');
  assert.match(selftest.stdout, /all checks passed/);

  const settings = path.join(hud.claude, 'settings.json');
  const original = Buffer.from('\uFEFF{\r\n\t"model": "fixture"\r\n}\r\n');
  const older = 'node "C:/previous folder/hud.mjs" hook';
  const legacy = Buffer.from('\uFEFF' + JSON.stringify({
    model: 'fixture', hooks: { Stop: [{ hooks: [{ type: 'command', command: older }] }] },
  }, null, '\t').replaceAll('\n', '\r\n') + '\r\n');
  await fs.writeFile(settings, legacy);
  await fs.writeFile(settings + '.hud-backup-original', original);

  const installed = await cli('install');
  assert.equal(installed.status, 0, installed.stderr);
  const upgraded = await fs.readFile(settings);
  const command = `node "${path.join(distribution, 'hud-hook.mjs').replaceAll('\\', '/')}"`;
  assert.equal(JSON.parse(upgraded.toString('utf8').slice(1)).hooks.Stop[0].hooks[0].command, command);
  assert.match(installed.stdout, /Backup of the previous file/);
  const backups = (await fs.readdir(hud.claude)).filter(name => name.startsWith('settings.json.hud-backup-'));
  const migrationBackup = backups.find(name => name !== 'settings.json.hud-backup-original');
  assert.deepEqual(await fs.readFile(path.join(hud.claude, migrationBackup)), legacy);
  const repeated = await cli('install');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /already installed/);
  assert.deepEqual(await fs.readFile(settings), upgraded);
  assert.deepEqual((await fs.readdir(hud.claude)).filter(name => name.startsWith('settings.json.hud-backup-')), backups);
  const uninstalled = await cli('uninstall');
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.match(uninstalled.stdout, /byte for byte/);
  assert.deepEqual(await fs.readFile(settings), original);

  const taskModule = path.join(distribution, 'src', 'platform', 'windows-autostart.mjs');
  const { scheduledTaskScript } = await import(pathToFileURL(taskModule));
  const action = scheduledTaskScript('on', { port: hud.port, lan: true }).split('\n').find(line => line.startsWith('$action'));
  assert.equal(action, `$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\\conhost.exe') -Argument '--headless "${process.execPath.replaceAll("'", "''")}" "${entry.replaceAll("'", "''")}" --lan' -WorkingDirectory '${distribution.replaceAll("'", "''")}'`);
  assert.doesNotMatch(scheduledTaskScript('on', { port: hud.port, lan: false }), / --lan\b/);
  const invalid = await cli('autostart', 'unknown');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, process.platform === 'win32' ? /Usage:/ : /only available on Windows/);
});

test('standalone hook stays silent with network debugging and closes a stalled request on its budget', { timeout: 5000 }, async t => {
  const hud = await startHud({ start: false, env: { NODE_DEBUG: 'net' } });
  const hook = path.join(hud.dir, 'hud-hook.mjs');
  await fs.copyFile(new URL('../hud-hook.mjs', import.meta.url), hook);
  const requests = [];
  const server = http.createServer(async request => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await hud.close();
  });
  server.listen(hud.port, '127.0.0.1');
  await once(server, 'listening');
  const child = hud.spawnCli([hook], { cwd: hud.dir, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.stdin.end(JSON.stringify({ session_id: 'fixture', hook_event_name: 'Stop', prompt: 'private fixture' }));
  assert.deepEqual(await once(child, 'close'), [0, null]);
  assert.equal(output, '');
  assert.equal(requests.length, 1);
  const [{ method, url, body }] = requests;
  assert.equal(method, 'POST');
  assert.equal(url, '/event');
  assert.deepEqual(body, { hud_at: body.hud_at, session_id: 'fixture', hook_event_name: 'Stop' });
  const elapsed = Date.now() - body.hud_at;
  assert.ok(elapsed >= 350 && elapsed < 750, `expected a 400 ms timer, observed ${elapsed} ms`);

  const waiting = hud.spawnCli([hook], { cwd: hud.dir, stdio: ['pipe', 'pipe', 'pipe'] });
  let waitingOutput = '';
  for (const stream of [waiting.stdout, waiting.stderr]) stream.on('data', chunk => { waitingOutput += chunk; });
  const start = performance.now();
  const timeout = setTimeout(() => waiting.kill(), 1500);
  try {
    assert.deepEqual(await once(waiting, 'close'), [0, null]);
  } finally {
    clearTimeout(timeout);
  }
  assert.ok(performance.now() - start >= 350, 'the hook should wait for stdin until its budget');
  assert.equal(waitingOutput, '');
  assert.equal(requests.length, 1, 'open stdin must not forward a partial payload');
});

test('both demo modes advance board history and emit a matching feed line', () => {
  for (const mode of ['demo', 'dense']) {
    let now = Date.now();
    let tick;
    const feed = [];
    const demo = createDemo(mode, {}, { interval(callback) { tick = callback; } },
      { appendFeed: line => feed.push(line), invalidate() {} }, () => now);
    const inspect = () => demo.project(now).plans[0];
    assert.equal(inspect().phases[0].state, 'in-progress');
    now += 20_000;
    tick();
    assert.equal(inspect().phases[0].state, 'handed-off');
    assert.deepEqual(inspect().history.at(-1), { at: now, id: 'P1', from: 'in-progress', to: 'handed-off', sessionId: null, agentId: null });
    assert.ok(feed.some(line => line.at === now && line.action === 'item-changed' && line.text.endsWith('P1 in-progress → handed-off')));
    for (let step = 0; step < 100; step++) {
      now += 20_000;
      tick();
    }
    assert.equal(inspect().history.length, 50);
  }
});

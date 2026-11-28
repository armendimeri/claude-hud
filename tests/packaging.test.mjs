import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

// ---- operator cockpit P7: asset registration, request graph and archive contents ---------------------------------------

const WEB = fileURLToPath(new URL('../src/web/', import.meta.url));
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
const URL_CONSTANT = /\b[A-Z_]+_(?:URL|CSS)\s*=\s*['"](\.{1,2}\/[^'"]+)['"]/g;
const NEW_URL = /new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
const CSS_IMPORT = /@import\s+(?:url\()?["'](\.\/[^"']+)["']/g;

/** Files a module reaches. `kind` picks static imports only, or everything it can ever request. */
async function reaches(entry, kind) {
  const seen = new Set(), queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const body = await fs.readFile(path.join(WEB, file), 'utf8').catch(() => '');
    if (/^vendor\/three\//.test(file)) {
      // The vendored build: only its own relative import matters, and it is checked separately.
      for (const match of body.matchAll(/from"(\.\/[^"]+)"/g)) queue.push(path.posix.join(path.posix.dirname(file), match[1]));
      continue;
    }
    const patterns = file.endsWith('.css') ? [CSS_IMPORT]
      : kind === 'static' ? [STATIC_IMPORT] : [STATIC_IMPORT, DYNAMIC_IMPORT, URL_CONSTANT, NEW_URL];
    for (const pattern of patterns) {
      for (const match of body.matchAll(pattern)) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
    }
  }
  return seen;
}

test('every file the cockpit can request is registered with its type, and harnesses are not', async () => {
  const { readPublicAsset } = await import('../src/http/assets.mjs');
  const everything = new Set();
  for (const entry of ['entry.mjs', 'styles/hud.css', 'views/cockpit-page.mjs', 'inspector/panel.mjs', 'cockpit/scene.mjs']) {
    for (const file of await reaches(entry, 'all')) everything.add(file);
  }
  for (const file of [...everything].sort()) {
    const asset = await readPublicAsset('/assets/' + file);
    assert.ok(asset, `${file} is registered in the allowlist and exists`);
    const expected = file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('LICENSE') ? 'text/plain; charset=utf-8' : 'text/javascript; charset=utf-8';
    assert.equal(asset.contentType, expected, `${file} has its exact type`);
  }
  for (const file of ['vendor/three/three.module.min.js', 'vendor/three/three.core.min.js', 'inspector/inspector.css', 'cockpit/scene.css', 'styles/cockpit.css']) {
    assert.ok(everything.has(file), `${file} is part of the graph the test walked`);
  }
  const license = await readPublicAsset('/assets/vendor/three/LICENSE');
  assert.equal(license.contentType, 'text/plain; charset=utf-8');
  assert.match(license.body.toString('utf8'), /MIT License[\s\S]*three\.js authors/);
  for (const hidden of ['cockpit/harness/index.html', 'cockpit/harness/harness.mjs', 'cockpit/harness/run-evidence.mjs',
    'inspector/harness/index.html', 'inspector/harness/harness.mjs', 'vendor/three/VERSION.json', 'cockpit/harness/', '../../tests/fixtures/cockpit/public.mjs']) {
    assert.equal(await readPublicAsset('/assets/' + hidden), null, `${hidden} is not served`);
  }
});

test('the ordinary dashboard entry graph never reaches the cockpit, the inspector, history or Three.js', async () => {
  const cold = await reaches('entry.mjs', 'static');
  for (const file of await reaches('styles/hud.css', 'static')) cold.add(file);
  const heavy = [...cold].filter(file => /^(cockpit|inspector|vendor)\//.test(file) || /cockpit|inspector|operator|three/i.test(file));
  assert.deepEqual(heavy, [], 'the shared shell is the only entry point and loads no cockpit assets');
  const css = await fs.readFile(path.join(WEB, 'styles', 'hud.css'), 'utf8');
  assert.doesNotMatch(css, /cockpit|inspector|scene|three/i, 'hud.css imports no cockpit stylesheet');
  const server = await fs.readFile(new URL('../src/http/server.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(server, /rel="(?:modulepreload|preload|prefetch)"/, 'the page document preloads nothing');
});

test('Three.js 0.180.0 is vendored as two modules and a licence, with the recorded hashes and one relative import', async () => {
  const { createHash } = await import('node:crypto');
  const hashes = {
    'three.module.min.js': 'e2b5ee6bccd38fd6d8a2428546b83c5f2426d84b152ef82be8055556e3b40eb6',
    'three.core.min.js': '61ba0df005b05991361d040d8ff670e1aadfd0ce7aeebd1fdb0725957a8957de',
    LICENSE: 'bfe119ea4fd413f5f7ca3fcd63adb0c4a073ed39daa2fe7d3e6b769e21272601',
  };
  for (const [name, expected] of Object.entries(hashes)) {
    const body = await fs.readFile(path.join(WEB, 'vendor', 'three', name));
    assert.equal(createHash('sha256').update(body).digest('hex'), expected, `${name} matches the P2 handoff`);
  }
  const module = await fs.readFile(path.join(WEB, 'vendor', 'three', 'three.module.min.js'), 'utf8');
  assert.deepEqual([...new Set([...module.matchAll(/from"([^"]+)"/g)].map(match => match[1]))], ['./three.core.min.js']);
});

test('git archive leaves out the scene and inspector harnesses and keeps the shipped cockpit files', { timeout: 30000 }, async t => {
  const hud = await startHud({ start: false });
  t.after(() => hud.close());
  const repo = path.join(hud.dir, 'archive source');
  await fs.mkdir(repo);
  await fs.copyFile(new URL('../.gitattributes', import.meta.url), path.join(repo, '.gitattributes'));
  for (const file of ['src/web/cockpit/scene.mjs', 'src/web/cockpit/harness/index.html', 'src/web/inspector/panel.mjs',
    'src/web/inspector/harness/run.mjs', 'src/web/vendor/three/LICENSE']) {
    await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await fs.writeFile(path.join(repo, file), 'x');
  }
  // A throwaway repository inside the test's own temporary folder; the project repository is never touched.
  const git = (...args) => new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
      { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git ${args[0]} exited ${code}`)));
  });
  await git('init', '--quiet');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'fixture');
  const tar = await git('archive', '--format=tar', 'HEAD');
  const names = [];
  for (let offset = 0; offset + 512 <= tar.length && tar[offset] !== 0;) {
    const text = (from, to) => tar.toString('utf8', offset + from, offset + to).replace(/\0[\s\S]*$/, '');
    const size = parseInt(text(124, 136).trim() || '0', 8);
    names.push(text(0, 100));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const files = names.filter(name => !name.endsWith('/') && name !== 'pax_global_header');
  assert.deepEqual(files.sort(), ['.gitattributes', 'src/web/cockpit/scene.mjs', 'src/web/inspector/panel.mjs', 'src/web/vendor/three/LICENSE']);
});

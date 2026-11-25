import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pause, startHud, transcript } from './helpers.mjs';

async function receiver(t, status = () => 204) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(status(requests.length));
    res.end('receiver-private-response');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {
    requests,
    url: 'http://127.0.0.1:' + server.address().port + '/test-topic',
    async waitFor(count) {
      for (let i = 0; requests.length < count && i < 100; i++) await pause(30);
      assert.equal(requests.length, count);
    },
  };
}

async function hook(hud, id, cwd, event, extra = {}) {
  assert.equal(await hud.post({ session_id: id, cwd, hook_event_name: event, ...extra }), 204);
}

const permission = { notification_type: 'permission_prompt', message: 'Claude needs permission to use Bash' };
const input = { notification_type: 'idle_prompt', message: 'Waiting for your input' };

test('phone push sends only project and kind for a new needs-you transition', async t => {
  const sink = await receiver(t);
  const hud = await startHud({ env: { HUD_PUSH_URL: sink.url } });
  t.after(() => hud.close());
  const cwd = path.join(hud.dir, 'Demo Project');
  await fs.mkdir(cwd);
  const id = 'private-session-identifier', title = 'Private session title', command = 'echo private-test-command';
  const file = await transcript(hud, id, [{ type: 'custom-title', customTitle: title, cwd, sessionId: id }]);
  await hook(hud, id, cwd, 'PreToolUse', { transcript_path: file, tool_name: 'Bash', tool_use_id: 'tool', tool_input: { command } });
  const before = (await hud.until(s => s.sessions.some(x => x.id === id && x.title === title))).sessions.find(s => s.id === id);
  assert.equal(before.cwd, cwd);
  assert.equal(before.currentTool.summary, command);
  assert.equal(sink.requests.length, 0, 'ordinary tool activity produces no phone push');
  await hook(hud, id, cwd, 'Notification', permission);
  await sink.waitFor(1);
  assert.deepEqual((await hud.state()).push, { enabled: true, lastError: null });
  const message = sink.requests[0];
  assert.equal(message.method, 'POST');
  assert.equal(message.path, '/test-topic');
  assert.equal(message.headers.title, 'Claude HUD');
  assert.equal(message.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(message.body, 'Demo Project needs you: permission');
  const wire = [message.path, ...Object.values(message.headers), message.body].join('\n');
  for (const privateValue of [title, cwd, file, command, id]) {
    assert.ok(!wire.includes(privateValue), 'the request excludes private session details');
  }
  await hook(hud, id, cwd, 'Notification', input);
  await hook(hud, id, cwd, 'UserPromptSubmit');
  await hook(hud, id, cwd, 'Notification', input);
  assert.equal((await hud.state()).sessions.find(x => x.id === id).needsYou.kind, 'input');
  await pause(200);
  assert.equal(sink.requests.length, 1, 'updates and a second transition within the minute produce no push');
});

test('phone push is quiet when unset and rejects a file URL at startup', async t => {
  const sink = await receiver(t);
  const disabled = await startHud({ env: { HUD_PUSH_URL: undefined } });
  t.after(() => disabled.close());
  const invalid = await startHud({ env: { HUD_PUSH_URL: 'file:///private-test-target' } });
  t.after(() => invalid.close());
  for (const hud of [disabled, invalid]) {
    await hook(hud, 'disabled-test-session', hud.dir, 'Notification', permission);
    assert.equal((await hud.state()).sessions.find(x => x.id === 'disabled-test-session').status, 'needs-you');
  }
  assert.deepEqual((await disabled.state()).push, { enabled: false, lastError: null });
  assert.deepEqual((await invalid.state()).push, { enabled: false, lastError: 'HUD_PUSH_URL must be an HTTP or HTTPS URL' });
  assert.match(invalid.stderr(), /Phone push disabled/);
  assert.ok(!invalid.stderr().includes('private-test-target'), 'the startup error excludes the URL');
  await pause(100);
  assert.equal(sink.requests.length, 0);
});

test('phone push caps attempts at twenty an hour and reports a receiver failure', async t => {
  const sink = await receiver(t, n => n === 1 ? 503 : 204);
  const hud = await startHud({ env: { HUD_PUSH_URL: sink.url } });
  t.after(() => hud.close());
  const stream = await hud.stream();
  t.after(() => stream.close());
  await hook(hud, 'first', hud.dir, 'Notification', input);
  const failed = await stream.next(e => e.event === 'state' && e.data.push?.lastError === 'Phone push HTTP 503');
  assert.deepEqual(failed.data.push, { enabled: true, lastError: 'Phone push HTTP 503' });
  assert.equal(sink.requests[0].body, path.basename(hud.dir) + ' needs you: input');
  await hook(hud, 'second', hud.dir, 'Notification', { notification_type: 'elicitation_dialog' });
  await sink.waitFor(2);
  await hud.until(s => s.push.lastError === null);
  assert.equal(sink.requests[1].body, path.basename(hud.dir) + ' needs you: question');
  for (let i = 3; i <= 21; i++) await hook(hud, 'session-' + i, hud.dir, 'Notification', permission);
  await sink.waitFor(20);
  await pause(200);
  assert.equal(sink.requests.length, 20);
  assert.equal((await hud.state()).sessions.find(x => x.id === 'session-21').status, 'needs-you');
});

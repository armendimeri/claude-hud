// Test helpers (PLAN hud-0-3 §4.5): a HUD over temp folders, and the files it reads.
// Every HUD started here gets a free port from the OS, HUD_NO_AUTOINSTALL=1, and folders under the OS temp folder.
// `post` only knows its own HUD, so no test can reach the HUD on port 7777. Stop a HUD by its own handle (`stop`).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

export const script = fileURLToPath(new URL('../hud.mjs', import.meta.url));
export const pause = ms => new Promise(r => setTimeout(r, ms));

/** A port the OS says is free right now. */
export async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address();
  await new Promise(r => server.close(r));
  return port;
}

/**
 * Starts `hud.mjs` (or `hud.mjs --demo`, or `--demo=dense` with demo: 'dense') over a new temp folder `dir`:
 * `dir/claude` is CLAUDE_CONFIG_DIR (with `sessions/` and `projects/`), `dir/codex` is CODEX_HOME, `dir/extra-codex`
 * is HUD_CODEX_DIRS, and `dir` is HOME. `env` (an object, or a function of `dir` that returns one) overrides any of it. With `start: false` nothing runs until
 * `restart()`, so a test can write files the HUD must find at its start.
 *
 * Returns { base, port, dir, claude, codex, state(), until(predicate, ms), post(event), stream(), stop(), restart(),
 * stderr(), close() }. `close()` stops the HUD and deletes `dir`; call it from `t.after`.
 */
export async function startHud({ demo = false, env = {}, start = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hud-test-'));
  const claude = path.join(dir, 'claude'), codex = path.join(dir, 'codex'), extraCodex = path.join(dir, 'extra-codex');
  for (const d of [path.join(claude, 'sessions'), path.join(claude, 'projects'), codex, path.join(extraCodex, 'sessions')]) {
    await fs.mkdir(d, { recursive: true });
  }
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const args = [script, ...(demo ? [demo === 'dense' ? '--demo=dense' : '--demo'] : [])];
  const childEnv = { ...process.env,
    HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, HUD_CODEX_DIRS: extraCodex,
    HUD_CLAUDE_DIRS: '', HUD_NO_AUTOINSTALL: '1', HUD_PORT: String(port), HUD_LAN: '0', HUD_BEDROCK_REGION: '',
    HUD_RECORD: '', ...(typeof env === 'function' ? env(dir) : env) };
  let child = null, errors = '';

  const up = async () => {
    child = spawn(process.execPath, args, { windowsHide: true, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    child.stderr.on('data', b => { errors += b; });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) assert.fail(`hud.mjs exited with ${child.exitCode}: ${errors}`);
      try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
      await pause(50);
    }
    assert.fail('hud.mjs did not answer: ' + errors);
  };
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  };
  const hud = {
    base, port, dir, claude, codex, extraCodex,
    get child() { return child; },
    stderr: () => errors,
    state: async () => (await fetch(base + '/api/state')).json(),
    /** Polls /api/state until `predicate(state)` is truthy; returns that state. */
    async until(predicate, ms = 20000) {
      const deadline = Date.now() + ms;
      let last;
      while (Date.now() < deadline) {
        try { last = await hud.state(); if (predicate(last)) return last; } catch {}
        await pause(100);
      }
      assert.fail('State did not converge: ' + errors);
    },
    /** Posts one hook event (an object, as the forwarder sends it) to this HUD's /event. Returns the HTTP status. */
    async post(event) {
      const res = await fetch(base + '/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) });
      await res.arrayBuffer();
      return res.status;
    },
    /**
     * Opens /api/stream. Returns { headers, events, next(predicate, ms), close() }: `events` is every { event, data }
     * received so far (data parsed as JSON); `next` waits for the first one, old or new, that matches.
     */
    async stream() {
      const ac = new AbortController();
      const res = await fetch(base + '/api/stream', { signal: ac.signal });
      const events = [], waiters = new Set();
      const reader = res.body.getReader(), decoder = new TextDecoder();
      let buf = '';
      (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let cut;
            while ((cut = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, cut); buf = buf.slice(cut + 2);
              let event = 'message', data = '';
              for (const line of block.split('\n')) {
                if (line.startsWith('event: ')) event = line.slice(7);
                else if (line.startsWith('data: ')) data += line.slice(6);
              }
              if (!data) continue;
              let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
              const e = { event, data: parsed };
              events.push(e);
              for (const w of waiters) if (w.predicate(e)) { waiters.delete(w); w.resolve(e); }
            }
          }
        } catch {}
      })();
      return {
        headers: res.headers, events,
        next(predicate = () => true, ms = 20000) {
          const hit = events.find(predicate);
          if (hit) return Promise.resolve(hit);
          return new Promise((resolve, reject) => {
            const w = { predicate, resolve: e => { clearTimeout(timer); resolve(e); } };
            const timer = setTimeout(() => { waiters.delete(w); reject(new Error('No matching stream event')); }, ms);
            waiters.add(w);
          });
        },
        close: () => ac.abort(),
      };
    },
    stop,
    async restart() { await stop(); await up(); },
    async close() { await stop(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); },
  };
  if (start) await up();
  return hud;
}

const line = x => (typeof x === 'string' ? x.replace(/\n?$/, '\n') : JSON.stringify(x) + '\n');

/**
 * Appends lines (objects or JSON strings) to the transcript `claude/projects/<project>/<sessionId>.jsonl`,
 * creating it. Returns its path.
 */
export async function transcript(hud, sessionId, lines, { project = 'p' } = {}) {
  const folder = path.join(hud.claude, 'projects', project);
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, `${sessionId}.jsonl`);
  await fs.appendFile(file, lines.map(line).join(''));
  return file;
}

/**
 * Writes a registry entry `claude/sessions/<file>` (default `<pid>.json`) for `sessionId`, with cwd = hud.dir and
 * status 'idle' unless `fields` say otherwise. Returns its path.
 */
export async function registry(hud, sessionId, { pid, file, ...fields } = {}) {
  const target = path.join(hud.claude, 'sessions', file || `${pid}.json`);
  await fs.writeFile(target, JSON.stringify({ sessionId, pid, cwd: hud.dir, status: 'idle', ...fields }));
  return target;
}

/** Writes a phased plan board, `<hud.dir>/docs/plans/<slug>/STATUS.md`. Returns its path. */
export async function board(hud, slug, markdown) {
  const folder = path.join(hud.dir, 'docs', 'plans', slug);
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, 'STATUS.md');
  await fs.writeFile(file, markdown);
  return file;
}

/** One assistant transcript line for `sessionId` at `at` (a Date, epoch ms or ISO string), as a string ending in \n. */
export function said(sessionId, at = new Date(), extra = {}) {
  const timestamp = new Date(at).toISOString();
  return JSON.stringify({ type: 'assistant', sessionId, timestamp, ...extra,
    message: { id: `msg-${sessionId}-${extra.agentId || ''}`, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 2 } } }) + '\n';
}

#!/usr/bin/env node
// Claude Code's command hook. Read JSON from stdin and forward only the fields the HUD uses.
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOOPBACK = '127.0.0.1';
const HOOK_BUDGET_MS = 400;
const HOOK_STDIN_MAX = 32 << 20;

export const HOOK_FIELDS = ['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'permission_mode', 'tool_name', 'tool_use_id',
  'agent_id', 'agent_type', 'agent_transcript_path', 'notification_type', 'message', 'title', 'source', 'reason', 'trigger',
  'session_title', 'is_interrupt'];
export const TOOL_INPUT_FIELDS = ['command', 'description', 'file_path', 'notebook_path', 'path', 'pattern', 'glob', 'url', 'query',
  'subagent_type', 'run_in_background', 'model', 'skill', 'name'];
export const TOOL_RESPONSE_FIELDS = ['agentId', 'status', 'isAsync', 'resolvedModel', 'interrupted'];

export function portFrom(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function pickFields(src, keys, max) {
  const out = {};
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'string') out[k] = v.slice(0, max);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

export function slimHookPayload(p, at) {
  const out = { hud_at: at, ...pickFields(p, HOOK_FIELDS, 1000) };
  if (typeof p.model === 'string') out.model = p.model.slice(0, 200);
  else if (isObj(p.model) && typeof p.model.id === 'string') out.model = p.model.id.slice(0, 200);
  if (isObj(p.tool_input)) out.tool_input = pickFields(p.tool_input, TOOL_INPUT_FIELDS, 300);
  if (isObj(p.tool_response)) out.tool_response = pickFields(p.tool_response, TOOL_RESPONSE_FIELDS, 200);
  return out;
}

export function runHook() {
  const finish = () => process.exit(0);
  const quiet = () => true;
  process.stdout.write = quiet;
  process.stderr.write = quiet;
  process.on('uncaughtException', finish);
  process.on('unhandledRejection', finish);
  process.removeAllListeners('warning');
  setTimeout(finish, HOOK_BUDGET_MS);
  const at = Date.now();
  const port = portFrom(process.env.HUD_PORT) ?? 7777;
  const chunks = [];
  let size = 0;
  process.stdin.on('data', chunk => {
    size += chunk.length;
    if (size > HOOK_STDIN_MAX) return finish();
    chunks.push(chunk);
  });
  process.stdin.on('error', finish);
  process.stdin.on('end', () => {
    let body;
    try { body = JSON.stringify(slimHookPayload(JSON.parse(Buffer.concat(chunks).toString('utf8')), at)); } catch { return finish(); }
    // One fixed loopback POST. Drain the response until its connection closes.
    const socket = createConnection({ host: LOOPBACK, port });
    socket.on('error', finish);
    socket.on('end', finish);
    socket.resume();
    socket.write(
      `POST /event HTTP/1.1\r\nHost: ${LOOPBACK}:${port}\r\nConnection: close\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body,
    );
  });
}

function comparablePath(file) {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

if (process.argv[1] && comparablePath(process.argv[1]) === comparablePath(fileURLToPath(import.meta.url))) runHook();

#!/usr/bin/env node
// Claude HUD: one live dashboard for every Claude Code session on this PC.
// One file, Node 22 built-ins only, no build step. `node hud.mjs help` lists the commands; README.md has the rest.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

// =====================================================================================================================
// Settings

// Context window per model, in tokens (D13). A model missing here gets `context: null`: never a guess.
const CONTEXT_WINDOWS = {
  'claude-fable-5-1': 1_000_000,
  'claude-mythos-5-1': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-opus-5-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-5-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-5-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
};

const VERSION = '0.1.0';
const PORT = portFrom(process.env.HUD_PORT) ?? 7777;
const HOST = '127.0.0.1';
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

const SCRIPT = fileURLToPath(import.meta.url);
const HOME = os.homedir();
// CLAUDE_CONFIG_DIR moves Claude Code's folder (and its .claude.json) elsewhere; the HUD follows it.
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : null;
const CLAUDE_DIR = CONFIG_DIR ?? path.join(HOME, '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');      // <pid>.json only; the *.key files there are never read
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const CLAUDE_JSON = path.join(CONFIG_DIR ?? HOME, '.claude.json');   // only its `cachedUsageUtilization` key is kept

const HOOK_BUDGET_MS = 400;              // the forwarder gives up after this (PLAN §4.2)
const HOOK_STDIN_MAX = 32 << 20;
const EVENT_BODY_MAX = 256 << 10;
const USAGE_BODY_MAX = 16 << 10;
const FEED_MAX = 500;                    // D7
const FEED_SNAPSHOT = 200;
const ENDED_KEEP_MS = 2 * 3600_000;      // D7
const STATE_MIN_INTERVAL_MS = 250;       // at most 4 state pushes a second
const KEEPALIVE_MS = 15_000;
const POLL_MS = 3_000;
const SILENT_SUBAGENT_MS = 120_000;      // fallback close for a subagent nobody reported done
const SILENT_SESSION_MS = 10 * 60_000;   // a session outside the registry counts as ended after this much silence
const EXTERNAL_ROWS_MAX = 200;
const CLOUDWATCH_EVERY_MS = 60_000;
const ACCEPT_USAGE = process.env.HUD_ACCEPT_USAGE === '1';           // D12 (a), off by default
const BEDROCK_REGION = (process.env.HUD_BEDROCK_REGION || '').trim(); // D12 (b), off by default

// Hooks (PLAN §4.2, D3). Our entries are recognised by this exact command string.
const HOOK_COMMAND = `node "${SCRIPT.replace(/\\/g, '/')}" hook`;
const OUR_HOOK_RE = /^node "[^"]*\/hud\.mjs" hook$/;
const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact'];
const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const SYNC_EVENTS = new Set(['SessionEnd']);   // async hooks can be killed when a session exits

const REOPEN_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const NEEDS_INPUT_TOOLS = { AskUserQuestion: 'Question for you', ExitPlanMode: 'Plan approval' };

// =====================================================================================================================
// Small helpers

function portFrom(v) { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 65536 ? n : null; }
function num(v) { return Number.isFinite(v) && v > 0 ? v : 0; }
function str(v) { return typeof v === 'string' ? v : ''; }
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function zero() { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; }
function addTokens(into, t, sign = 1) {
  into.input += sign * t.input; into.output += sign * t.output;
  into.cacheRead += sign * t.cacheRead; into.cacheWrite += sign * t.cacheWrite;
  return into;
}
function truncate(s, n) { s = str(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function oneLine(s) { return str(s).replace(/\s+/g, ' ').trim(); }
function pad2(n) { return String(n).padStart(2, '0'); }
function dayKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function startOfDay(ts = Date.now()) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function readJsonSync(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }
async function readJson(file) { try { return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; } }
function capSet(set, max) { while (set.size > max) set.delete(set.values().next().value); }

// =====================================================================================================================
// Redaction (PLAN §4.5). Runs over every string before it leaves the process.

const MASK = '•••';
const VALUE = String.raw`("[^"]*"|'[^']*'|[^\s"';&,]+)`;
const REDACTIONS = [
  [new RegExp(String.raw`(^|[\s"'=(])-P\s*` + VALUE, 'g'), `$1-P ${MASK}`],
  [/\b(password|pwd|user ?id)\s*=\s*("[^"]*"|'[^']*'|[^;"'\s]*)/gi, `$1=${MASK}`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${MASK}`],
  [new RegExp(String.raw`\b(aws_secret_access_key|aws_session_token|aws_bearer_token_bedrock)["']?\s*[=:]\s*` + VALUE, 'gi'), `$1=${MASK}`],
  [new RegExp(String.raw`\b([A-Za-z0-9_.-]*(?:token|secret|api[_-]?key|apikey|passwd|password))["']?\s*[=:]\s*` + VALUE, 'gi'), `$1=${MASK}`],
  [new RegExp(String.raw`(--?(?:password|passwd|pwd|token|secret|api-?key|access-token))(?:\s+|=)` + VALUE, 'gi'), `$1 ${MASK}`],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
];
const redactCache = new Map();

function redact(s) {
  if (typeof s !== 'string' || s.length < 4) return s;
  const hit = redactCache.get(s);
  if (hit !== undefined) return hit;
  let out = s;
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  // Anything that looks like a key: 32+ characters of hex, or a long base64-ish run with digits and letters
  // and no word-like structure (paths, slugs and UUIDs are split by / _ - into short parts and survive).
  out = out.replace(/[A-Za-z0-9+/=_-]{32,}/g, run => {
    if (/^[0-9a-fA-F]{32,}$/.test(run)) return MASK;
    if (!/\d/.test(run) || !/[A-Za-z]/.test(run)) return run;
    return Math.max(...run.split(/[/_-]/).map(p => p.length)) >= 20 ? MASK : run;
  });
  if (redactCache.size > 20_000) redactCache.clear();
  redactCache.set(s, out);
  return out;
}

const NO_REDACT = new Set(['id', 'parentId', 'sessionId', 'startedBy', 'agentId']);
function redactDeep(v, key) {
  if (typeof v === 'string') return NO_REDACT.has(key) ? v : redact(v);
  if (Array.isArray(v)) return v.map(x => redactDeep(x, key));
  if (isObj(v)) { const o = {}; for (const k of Object.keys(v)) o[k] = redactDeep(v[k], k); return o; }
  return v;
}

// =====================================================================================================================
// Models and providers (D11)

const BEDROCK_PREFIX = /^(?:(?:us|eu|apac|ap|global|us-gov|jp|au|ca|sa|me|af)\.)?anthropic\.(claude-[a-z0-9.-]+?)(?:-\d{8})?(?:-v\d+(?::\d+)?)?(?::\d+)?$/i;
const BEDROCK_ARN = /^arn:aws[\w-]*:bedrock:[^:]*:\d*:(?:inference-profile|application-inference-profile|foundation-model|provisioned-model|custom-model|imported-model)\/(.+)$/i;

/** Normalise a model id for display: Bedrock ids, ARNs and dated or [1m] ids become e.g. `claude-opus-5-5`. */
function normalizeModel(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { model: null, provider: 'unknown' };
  let s = raw.trim();
  let bedrock = false;
  const arn = BEDROCK_ARN.exec(s);
  if (arn) { s = arn[1]; bedrock = true; }
  const b = BEDROCK_PREFIX.exec(s);
  if (b) return { model: b[1].toLowerCase(), provider: 'bedrock' };
  if (bedrock) return { model: raw, provider: 'bedrock' };        // e.g. an application inference profile: opaque id
  const a = /^(claude-[a-z0-9-]+?)(?:-\d{8})?(?:\[1m\])?$/i.exec(s);
  if (a) return { model: a[1].toLowerCase(), provider: 'anthropic' };
  return { model: raw, provider: 'unknown' };
}

let bedrockFlag = false;   // `env.CLAUDE_CODE_USE_BEDROCK` in ~/.claude/settings.json, the only key of that block read
function modelInfo(raw) {
  const m = normalizeModel(raw);
  if (m.provider === 'anthropic' && bedrockFlag) m.provider = 'bedrock';
  return m;
}
function contextFor(model, used) {
  const window = CONTEXT_WINDOWS[model];
  if (!window || !used) return null;
  return { used, window, pct: Math.round(used / window * 1000) / 10 };
}

// =====================================================================================================================
// Tool summaries (D4): a short, redacted line per tool call. Never full prompts, output or file contents.

function shortPath(p, cwd) {
  p = str(p);
  if (!p) return '';
  if (cwd) {
    const rel = path.relative(cwd, p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
  }
  return p;
}
function safeUrl(u) {
  try { const x = new URL(u); return x.host + (x.pathname === '/' ? '' : x.pathname); } catch { return ''; }
}
function summarizeTool(name, input, cwd) {
  if (!isObj(input)) return '';
  let out = '';
  switch (name) {
    case 'Bash': case 'PowerShell': out = str(input.command); break;
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': case 'NotebookRead':
      out = shortPath(str(input.file_path) || str(input.notebook_path), cwd); break;
    case 'Glob': case 'Grep':
      out = str(input.pattern) + (input.path ? ` in ${shortPath(input.path, cwd)}` : input.glob ? ` in ${str(input.glob)}` : ''); break;
    case 'WebFetch': out = safeUrl(str(input.url)); break;
    case 'WebSearch': case 'ToolSearch': out = str(input.query); break;
    case 'Agent': case 'Task': out = [str(input.subagent_type), str(input.description)].filter(Boolean).join(': '); break;
    case 'Skill': out = str(input.skill) || str(input.name); break;
    case 'TodoWrite': out = 'to-do list'; break;
  }
  return truncate(redact(oneLine(out)), 80);
}

// =====================================================================================================================
// Hook forwarder: `node hud.mjs hook`. Reads the event on stdin and posts a slimmed copy to /event.
// It never writes to stdout or stderr and always exits 0, whether the HUD runs or not (PLAN §4.2).

const HOOK_FIELDS = ['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'permission_mode', 'tool_name', 'tool_use_id',
  'agent_id', 'agent_type', 'agent_transcript_path', 'notification_type', 'message', 'title', 'source', 'reason', 'trigger',
  'session_title', 'is_interrupt'];
const TOOL_INPUT_FIELDS = ['command', 'description', 'file_path', 'notebook_path', 'path', 'pattern', 'glob', 'url', 'query',
  'subagent_type', 'run_in_background', 'model', 'skill', 'name'];
const TOOL_RESPONSE_FIELDS = ['agentId', 'status', 'isAsync', 'resolvedModel', 'interrupted'];

function pickFields(src, keys, max) {
  const out = {};
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'string') out[k] = v.slice(0, max);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}
function slimHookPayload(p, at) {
  const out = { hud_at: at, ...pickFields(p, HOOK_FIELDS, 1000) };
  if (typeof p.model === 'string') out.model = p.model.slice(0, 200);
  else if (isObj(p.model) && typeof p.model.id === 'string') out.model = p.model.id.slice(0, 200);
  if (isObj(p.tool_input)) out.tool_input = pickFields(p.tool_input, TOOL_INPUT_FIELDS, 300);
  if (isObj(p.tool_response)) out.tool_response = pickFields(p.tool_response, TOOL_RESPONSE_FIELDS, 200);
  return out;
}

function runHook() {
  const quiet = () => true;
  process.stdout.write = quiet;
  process.stderr.write = quiet;
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
  process.removeAllListeners('warning');
  setTimeout(() => process.exit(0), HOOK_BUDGET_MS);
  const at = Date.now();
  const chunks = [];
  let size = 0;
  process.stdin.on('data', c => { size += c.length; if (size <= HOOK_STDIN_MAX) chunks.push(c); });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    let body;
    try { body = JSON.stringify(slimHookPayload(JSON.parse(Buffer.concat(chunks).toString('utf8')), at)); } catch { process.exit(0); }
    const req = http.request({
      host: HOST, port: PORT, path: '/event', method: 'POST', agent: false,
      headers: { host: `${HOST}:${PORT}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => { res.resume(); res.on('end', () => process.exit(0)); res.on('error', () => process.exit(0)); });
    req.on('error', () => process.exit(0));
    req.end(body);
  });
}

// =====================================================================================================================
// Engine state

const hudStartedAt = Date.now();
const sessions = new Map();     // sessionId -> session
const tails = new Map();        // transcript file (lower-cased) -> tail
const feed = [];                // newest last
const feedSeen = new Set();     // de-duplicates feed lines that hooks and transcripts both report
const plans = new Map();        // `${project}|${relative path}` -> { plan, mtime, rootKey }
const roots = new Map();        // project root (lower-cased) -> { root, project, watchers, timer }
const rootCache = new Map();    // cwd (lower-cased) -> { root, mainRoot, project }
const external = new Map();     // D12 rows
let externalError = null;
let account = null;             // 5-hour and weekly usage from Claude Code's own cache in ~/.claude.json
let hooksInstalled = false;
let demo = null;

function newSession(id) {
  return {
    id, pid: null, cwd: null, project: null, name: null, entrypoint: null, version: null, kind: null,
    inRegistry: false, regStatus: null, regStatusAt: 0,
    hookStatus: null, hookStatusAt: 0, lastHookAt: 0, hookModel: null,
    needsYou: null, currentTool: null, hookTools: new Set(), doneTools: new Set(),
    startedAt: null, ended: false, endedAt: null, endReason: null,
    startedBy: null, chainChecked: false,
    tail: null, transcriptPath: null, lastFind: 0,
    subs: new Set(), byToolUse: new Map(), byAgent: new Map(),
  };
}
function getSession(id) {
  let s = sessions.get(id);
  if (!s) { s = newSession(id); sessions.set(id, s); }
  return s;
}

function pushFeed(s, kind, text, at = Date.now(), dedupeKey = null) {
  if (dedupeKey) { if (feedSeen.has(dedupeKey)) return; feedSeen.add(dedupeKey); capSet(feedSeen, 5000); }
  const line = { at: Math.min(at, Date.now()), sessionId: s?.id ?? null, project: s?.project ?? null, kind, text: truncate(oneLine(text), 200) };
  feed.push(line);
  if (feed.length > FEED_MAX) feed.splice(0, feed.length - FEED_MAX);
  broadcast('event', redactDeep(line));
  scheduleState();
}

// ---------------------------------------------------------------------------------------------------------------------
// Project roots (walk up from the session cwd to the folder with .git; a worktree belongs to its main repository)

function rootFor(cwd) {
  const key = cwd.toLowerCase();
  let r = rootCache.get(key);
  if (r) return r;
  let dir = path.resolve(cwd), root = null, mainRoot = null;
  for (let i = 0; i < 40; i++) {
    const git = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(git); } catch {}
    if (st) {
      root = dir; mainRoot = dir;
      if (st.isFile()) {
        const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(git, 'utf8'));
        const wt = m && m[1].trim().split(/[\\/]\.git[\\/]worktrees[\\/]/);
        if (wt && wt.length > 1) mainRoot = path.resolve(dir, wt[0]);
      }
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  root ??= path.resolve(cwd);
  mainRoot ??= root;
  r = { root, mainRoot, project: path.basename(mainRoot) || mainRoot };
  rootCache.set(key, r);
  return r;
}
function setCwd(s, cwd) {
  if (!cwd || s.cwd === cwd) return;
  s.cwd = cwd;
  const r = rootFor(cwd);
  s.project = r.project;
  ensureRoot(r.root, r.project);
  if (r.mainRoot !== r.root) ensureRoot(r.mainRoot, r.project);
}

// =====================================================================================================================
// Transcripts: tail each file from a remembered byte offset; skip lines that don't parse.

function newInfo() {
  return {
    title: null, customTitle: null, modelRaw: null, effort: null, branch: null, cwd: null, sessionId: null, agentId: null,
    tokens: zero(), byDay: new Map(), msgs: new Map(), lastUsed: 0, firstTs: 0, lastTs: 0,
    toolIds: new Set(), openTools: new Map(), agentCalls: new Map(),
  };
}
function getTail(file) {
  const key = file.toLowerCase();
  let t = tails.get(key);
  if (!t) { t = { file, offset: 0, rest: Buffer.alloc(0), reading: false, again: false, info: newInfo(), owner: null }; tails.set(key, t); }
  return t;
}

const SKIP_LINE_PREFIXES = ['{"type":"api-request', '{"type":"file-history', '{"type":"atis-latch', '{"type":"queue-operation', '{"type":"last-prompt'];

async function readTail(t) {
  if (t.reading) { t.again = true; return; }
  t.reading = true;
  let changed = false;
  try {
    do {
      t.again = false;
      let st;
      try { st = await fsp.stat(t.file); } catch { break; }
      if (st.size < t.offset) { t.offset = 0; t.rest = Buffer.alloc(0); t.info = newInfo(); }   // replaced or truncated
      if (st.size === t.offset) continue;
      const fh = await fsp.open(t.file, 'r');
      try {
        const buf = Buffer.allocUnsafe(1 << 22);
        while (t.offset < st.size) {
          const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, st.size - t.offset), t.offset);
          if (!bytesRead) break;
          t.offset += bytesRead;
          consume(t, buf.subarray(0, bytesRead));
          changed = true;
        }
      } finally { await fh.close(); }
    } while (t.again);
  } catch {
    // unreadable for now; the next poll tries again
  } finally { t.reading = false; }
  if (changed) scheduleState();
}

function consume(t, chunk) {
  const buf = t.rest.length ? Buffer.concat([t.rest, chunk]) : chunk;
  const nl = buf.lastIndexOf(10);
  if (nl < 0) { t.rest = Buffer.from(buf); return; }
  const text = buf.toString('utf8', 0, nl);
  t.rest = Buffer.from(buf.subarray(nl + 1));
  for (const line of text.split('\n')) if (line) processLine(t, line);
}

function processLine(t, line) {
  for (const p of SKIP_LINE_PREFIXES) if (line.startsWith(p)) return;
  let j;
  try { j = JSON.parse(line); } catch { return; }
  if (!isObj(j)) return;
  const info = t.info;
  if (typeof j.sessionId === 'string') info.sessionId ??= j.sessionId;
  if (typeof j.agentId === 'string') info.agentId ??= j.agentId;
  const ts = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) || 0 : 0;
  if (ts) { if (ts > info.lastTs) info.lastTs = ts; if (!info.firstTs) info.firstTs = ts; }
  if (typeof j.customTitle === 'string' && j.customTitle) info.customTitle = j.customTitle;
  if (j.type === 'ai-title' && typeof j.aiTitle === 'string') info.title = j.aiTitle;
  else if (j.type === 'summary' && typeof j.summary === 'string') info.title ??= j.summary;
  else if (j.type === 'assistant') onAssistantLine(t, j, ts);
  else if (j.type === 'user') onUserLine(t, j, ts);
}

function onAssistantLine(t, j, ts) {
  const info = t.info, m = j.message;
  if (!isObj(m)) return;
  if (typeof m.model === 'string' && m.model && !m.model.startsWith('<')) info.modelRaw = m.model;
  if (typeof j.effort === 'string' && j.effort) info.effort = j.effort;
  if (typeof j.gitBranch === 'string' && j.gitBranch) info.branch = j.gitBranch;
  if (typeof j.cwd === 'string' && j.cwd) info.cwd = j.cwd;
  const u = m.usage;
  if (isObj(u)) {
    // One message is often written as several lines that repeat the same usage: count each message id once.
    const tok = { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) };
    const id = typeof m.id === 'string' ? m.id : str(j.uuid);
    const day = ts ? dayKey(ts) : null;
    const prev = info.msgs.get(id);
    if (prev) { addTokens(info.tokens, prev.tok, -1); if (prev.day) addDay(info, prev.day, prev.tok, -1); info.msgs.delete(id); }
    addTokens(info.tokens, tok);
    if (day) addDay(info, day, tok, 1);
    info.msgs.set(id, { tok, day });
    if (info.msgs.size > 4000) info.msgs.delete(info.msgs.keys().next().value);
    info.lastUsed = tok.input + tok.cacheRead + tok.cacheWrite;   // context: the latest turn only (D13)
  }
  if (!Array.isArray(m.content)) return;
  for (const c of m.content) {
    if (!isObj(c) || c.type !== 'tool_use' || typeof c.id !== 'string' || info.toolIds.has(c.id)) continue;
    info.toolIds.add(c.id);
    const name = str(c.name) || '?';
    const summary = summarizeTool(name, c.input, info.cwd);
    info.openTools.set(c.id, { id: c.id, name, summary, since: ts || Date.now() });
    if (info.openTools.size > 50) info.openTools.delete(info.openTools.keys().next().value);
    if (AGENT_TOOLS.has(name)) onAgentCall(t, c.id, isObj(c.input) ? c.input : {}, ts);
    if (ts >= hudStartedAt - 2000 && t.owner) {
      const s = t.owner.session;
      feedTool(s, t.owner.agentId ? s.byAgent.get(t.owner.agentId) : null, c.id, name, summary, ts);
    }
  }
}
function addDay(info, day, tok, sign) {
  let d = info.byDay.get(day);
  if (!d) { d = zero(); info.byDay.set(day, d); }
  addTokens(d, tok, sign);
}

function onUserLine(t, j, ts) {
  const content = j.message?.content;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!isObj(b) || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
    t.info.openTools.delete(b.tool_use_id);
    if (t.info.agentCalls.has(b.tool_use_id)) onAgentResult(t, b.tool_use_id, j.toolUseResult, b.is_error === true, ts);
  }
}

// =====================================================================================================================
// Subagents and the tree. A subagent is known from its parent's Agent tool call (keyed by the tool_use id), from
// hooks (agent_id) and from <sessionId>/subagents/agent-<agentId>.meta.json, which links the two (toolUseId).

function newSub(s) {
  const sub = { agentId: null, toolUseId: null, parentKey: s.id, depth: null, description: null, type: null, modelHint: null,
    background: false, state: 'running', startedAt: null, endedAt: null, tail: null, currentTool: null, lastHookAt: 0 };
  s.subs.add(sub);
  return sub;
}
function subForToolUse(s, toolUseId) {
  let sub = s.byToolUse.get(toolUseId);
  if (!sub) { sub = newSub(s); sub.toolUseId = toolUseId; s.byToolUse.set(toolUseId, sub); }
  return sub;
}
function subForAgent(s, agentId, type) {
  let sub = s.byAgent.get(agentId);
  if (sub) return sub;
  // A SubagentStart before meta.json: take the oldest running Agent call of that type with no agent id yet.
  // meta.json corrects a wrong pairing as soon as it appears (assignAgentId).
  const free = [...s.subs].filter(x => !x.agentId && x.state === 'running' && (!type || !x.type || x.type === type))
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  sub = free[0] || newSub(s);
  if (!sub.type && type) sub.type = type;
  return assignAgentId(s, sub, agentId);
}
function assignAgentId(s, sub, agentId) {
  if (sub.agentId === agentId) return sub;
  const other = s.byAgent.get(agentId);
  if (other && other !== sub) {
    if (!other.toolUseId) {               // a placeholder made from a hook or file: fold it into this call
      sub.tail ??= other.tail;
      if (sub.tail && sub.tail === other.tail) sub.tail.owner = { session: s, agentId };
      sub.depth ??= other.depth;
      sub.type ??= other.type;
      sub.description ??= other.description;
      sub.startedAt = Math.min(sub.startedAt || Infinity, other.startedAt || Infinity) || null;
      if (other.state === 'done' && sub.state === 'running') { sub.state = 'done'; sub.endedAt = other.endedAt; }
      sub.currentTool ??= other.currentTool;
      s.subs.delete(other);
    } else {
      other.agentId = null;                // an earlier guess was wrong; that call waits for its own meta.json
    }
  }
  if (sub.agentId) s.byAgent.delete(sub.agentId);
  sub.agentId = agentId;
  s.byAgent.set(agentId, sub);
  const dir = subagentsDir(s);
  if (!sub.tail && dir) {
    const file = path.join(dir, `agent-${agentId}.jsonl`);
    if (fs.existsSync(file)) attachSubTail(s, sub, file);
  }
  return sub;
}
function attachSubTail(s, sub, file) {
  if (sub.tail) return;
  const t = getTail(file);
  t.owner = { session: s, agentId: sub.agentId };
  sub.tail = t;
  replayAgentCalls(t);
  readTail(t);
}
function subagentsDir(s) { return s.transcriptPath ? path.join(path.dirname(s.transcriptPath), s.id, 'subagents') : null; }

function onAgentCall(t, toolUseId, input, ts) {
  const call = {
    description: str(input.description) || null, type: str(input.subagent_type) || 'general-purpose', model: str(input.model) || null,
    background: input.run_in_background === true || input.run_in_background === 'true', at: ts || Date.now(),
    agentId: null, done: false, doneAt: null,
  };
  t.info.agentCalls.set(toolUseId, call);
  if (t.owner) applyAgentCall(t.owner.session, t, toolUseId, call);
}
function onAgentResult(t, toolUseId, result, isError, ts) {
  const call = t.info.agentCalls.get(toolUseId);
  const r = isObj(result) ? result : null;
  if (r && typeof r.agentId === 'string') call.agentId = r.agentId;
  const launched = r && (r.status === 'async_launched' || r.isAsync === true);
  if (launched) call.background = true;
  else if (!call.background || isError) { call.done = true; call.doneAt = ts || Date.now(); }
  if (t.owner) applyAgentCall(t.owner.session, t, toolUseId, call);
}
function applyAgentCall(s, t, toolUseId, call) {
  const sub = subForToolUse(s, toolUseId);
  sub.parentKey = t.owner.agentId || s.id;
  sub.description ??= call.description;
  sub.type ??= call.type;
  sub.modelHint ??= call.model;
  if (call.background) sub.background = true;
  sub.startedAt = sub.startedAt ? Math.min(sub.startedAt, call.at) : call.at;
  if (call.agentId) assignAgentId(s, sub, call.agentId);
  if (call.done) closeSub(s, sub, call.doneAt);
}
function replayAgentCalls(t) {
  if (!t.owner) return;
  for (const [toolUseId, call] of t.info.agentCalls) applyAgentCall(t.owner.session, t, toolUseId, call);
}
function closeSub(s, sub, at = Date.now()) {
  if (sub.state === 'done') return;
  sub.state = 'done';
  sub.endedAt = at;
  sub.currentTool = null;
  if (at >= hudStartedAt - 2000) {
    pushFeed(s, 'done', `Agent done · ${[sub.type, sub.description].filter(Boolean).join(': ')}`, at, `done:${sub.toolUseId || sub.agentId}`);
  }
}

async function readMeta(s, file) {
  const meta = await readJson(file);
  const m = /agent-(.+)\.meta\.json$/i.exec(path.basename(file));
  if (!isObj(meta) || !m) return;
  const agentId = m[1];
  let sub = (typeof meta.toolUseId === 'string' && s.byToolUse.get(meta.toolUseId)) || s.byAgent.get(agentId);
  if (!sub) sub = newSub(s);
  if (typeof meta.toolUseId === 'string' && !sub.toolUseId) { sub.toolUseId = meta.toolUseId; s.byToolUse.set(meta.toolUseId, sub); }
  assignAgentId(s, sub, agentId);
  if (Number.isInteger(meta.spawnDepth)) sub.depth = meta.spawnDepth;
  if (meta.spawnDepth === 1) sub.parentKey = s.id;
  else if (typeof meta.parentAgentId === 'string' && meta.parentAgentId) sub.parentKey = meta.parentAgentId;   // seen on 2.1.312
  sub.description ??= str(meta.description) || null;
  sub.type ??= str(meta.agentType) || null;
  if (typeof meta.requestShape === 'string' && meta.requestShape !== 'foreground') sub.background = true;
  let mtime = Date.now();
  try { const st = await fsp.stat(file); mtime = st.mtimeMs; sub.startedAt ??= st.birthtimeMs || st.mtimeMs; } catch {}
  if (meta.finished === true) closeSub(s, sub, mtime);    // Claude Code marks a finished subagent here
  const jsonl = file.replace(/\.meta\.json$/i, '.jsonl');
  if (!sub.tail && fs.existsSync(jsonl)) attachSubTail(s, sub, jsonl);
  scheduleState();
}

async function scanSubagents(s) {
  const dir = subagentsDir(s);
  if (!dir) return;
  const walk = async (d, depth) => {
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 3) await walk(f, depth + 1); }
      else if (/^agent-.+\.meta\.json$/i.test(e.name)) await readMeta(s, f);
    }
    for (const e of ents) {
      const m = /^agent-(.+)\.jsonl$/i.exec(e.name);
      if (m && !e.isDirectory()) ensureSubTail(s, m[1], path.join(d, e.name));
    }
  };
  await walk(dir, 0);
}
function ensureSubTail(s, agentId, file) {
  const sub = s.byAgent.get(agentId) || assignAgentId(s, newSub(s), agentId);
  if (!sub.tail) attachSubTail(s, sub, file);
  else readTail(sub.tail);
}

// =====================================================================================================================
// Sessions: the registry (~/.claude/sessions/<pid>.json), hooks and transcripts

function slugFor(cwd) { return cwd.replace(/[^A-Za-z0-9]/g, '-'); }
function findTranscript(s) {
  if (s.cwd) {
    const f = path.join(PROJECTS_DIR, slugFor(s.cwd), `${s.id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  if (Date.now() - s.lastFind < 10_000) return null;
  s.lastFind = Date.now();
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch {}
  for (const d of dirs) {
    const f = path.join(PROJECTS_DIR, d, `${s.id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
function attachSessionTranscript(s, hint) {
  if (s.tail) return;
  const file = hint && fs.existsSync(hint) ? hint : findTranscript(s);
  if (!file) return;
  s.transcriptPath = file;
  const t = getTail(file);
  t.owner = { session: s, agentId: null };
  s.tail = t;
  replayAgentCalls(t);
  readTail(t).then(() => {
    if (!s.cwd && t.info.cwd) setCwd(s, t.info.cwd);
    return scanSubagents(s);
  });
}

function endSession(s, at, reason) {
  if (s.ended) return;
  s.ended = true;
  s.endedAt = at;
  s.endReason = reason;
  s.currentTool = null;
  s.needsYou = null;
  for (const sub of s.subs) closeSub(s, sub, at);
  if (at >= hudStartedAt - 2000) pushFeed(s, 'session', `Session ended${reason ? ` (${reason})` : ''}`, at, `end:${s.id}`);
  scheduleState();
}
function reopenSession(s) {
  s.ended = false; s.endedAt = null; s.endReason = null;
  feedSeen.delete(`end:${s.id}`);
}

let registryScanning = false, registryReadable = false;
async function scanRegistry() {
  if (registryScanning) return;
  registryScanning = true;
  try {
    let names = [];
    try { names = await fsp.readdir(SESSIONS_DIR); registryReadable = true; } catch {}
    const seen = new Set();
    for (const n of names) {
      if (!/^\d+\.json$/.test(n)) continue;              // <pid>.json only, never *.key
      const j = await readJson(path.join(SESSIONS_DIR, n));
      if (!isObj(j) || typeof j.sessionId !== 'string') continue;
      const pid = Number.isInteger(j.pid) ? j.pid : Number(n.slice(0, -5));
      seen.add(j.sessionId);
      const s = getSession(j.sessionId);
      const isNew = !s.inRegistry;
      s.inRegistry = true;
      s.pid = pid;
      if (typeof j.cwd === 'string') setCwd(s, j.cwd);
      if (typeof j.name === 'string' && j.name) s.name = j.name;
      if (typeof j.entrypoint === 'string') s.entrypoint = j.entrypoint;
      if (typeof j.version === 'string') s.version = j.version;
      if (typeof j.kind === 'string') s.kind = j.kind;
      if (num(j.startedAt)) s.startedAt = j.startedAt;
      if (j.status === 'busy' || j.status === 'idle') {
        const at = num(j.statusUpdatedAt) || num(j.updatedAt) || Date.now();
        if (at >= s.regStatusAt) { s.regStatus = j.status; s.regStatusAt = at; }
      }
      if (!pidAlive(pid)) endSession(s, Date.now(), 'process gone');
      if (isNew) {
        attachSessionTranscript(s);
        queueChain(s);
        if (Date.now() - hudStartedAt > 5000) pushFeed(s, 'session', 'Session started', Date.now(), `start:${s.id}`);
      }
    }
    for (const s of sessions.values()) {
      if (s.inRegistry && !s.ended && !seen.has(s.id)) endSession(s, Date.now(), 'closed');
    }
  } finally { registryScanning = false; }
  scheduleState();
}

// Sessions started by other sessions (`startedBy`): one process-tree read per batch of new sessions, never polled.
const chainQueue = new Set();
let chainTimer = null;
function queueChain(s) {
  if (process.platform !== 'win32' || s.chainChecked || !s.pid || s.ended) return;
  chainQueue.add(s);
  chainTimer ??= setTimeout(runChain, 300);
}
function runChain(retry = false) {
  chainTimer = null;
  const batch = [...chainQueue];
  chainQueue.clear();
  if (!batch.length) return;
  const cmd = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 3000, windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => {
    if (err) {
      if (!retry) { for (const s of batch) chainQueue.add(s); setTimeout(() => runChain(true), 5000); }
      else for (const s of batch) s.chainChecked = true;
      return;
    }
    const parent = new Map();
    for (const line of out.split(/\r?\n/)) {
      const [a, b] = line.trim().split(/\s+/).map(Number);
      if (a) parent.set(a, b);
    }
    const byPid = new Map();
    for (const x of sessions.values()) if (x.pid && !x.ended) byPid.set(x.pid, x);
    for (const s of batch) {
      s.chainChecked = true;
      let pid = s.pid;
      for (let i = 0; i < 8; i++) {
        pid = parent.get(pid);
        if (!pid) break;
        const o = byPid.get(pid);
        if (o && o !== s && (!o.startedAt || !s.startedAt || o.startedAt <= s.startedAt)) { s.startedBy = o.id; break; }
      }
    }
    scheduleState();
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Hook events (POST /event)

function setHookStatus(s, status, at) {
  if (at >= s.hookStatusAt) { s.hookStatus = status; s.hookStatusAt = at; }
}
function setNeedsYou(s, reason, kind, at, agentId) {
  if (s.needsYou && s.needsYou.reason === reason) return;
  s.needsYou = { since: s.needsYou?.since ?? at, reason, kind, agentId: agentId ?? null };
}
function clearNeedsYou(s, agentId = undefined) {
  if (!s.needsYou) return;
  if (agentId !== undefined && s.needsYou.agentId !== agentId) return;
  s.needsYou = null;
}
function notificationReason(type, msg) {
  if (type === 'permission_prompt' || (!type && /permission/i.test(msg))) {
    const m = /permission to use (.+?)\.?$/i.exec(msg);
    // The VS Code extension asks AskUserQuestion / ExitPlanMode through a permission prompt: keep their own label.
    if (m && NEEDS_INPUT_TOOLS[m[1]]) return { kind: 'question', text: NEEDS_INPUT_TOOLS[m[1]] };
    return { kind: 'permission', text: m ? `Permission: ${m[1]}` : 'Permission needed' };
  }
  if (type === 'idle_prompt' || (!type && /waiting for your input/i.test(msg))) return { kind: 'input', text: 'Waiting for your input' };
  if (['elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'].includes(type)) return { kind: 'question', text: 'Question for you' };
  return null;
}
function feedTool(s, sub, id, name, summary, at) {
  const who = sub ? `${sub.type || 'agent'} › ` : '';
  if (AGENT_TOOLS.has(name)) pushFeed(s, 'agent', `${who}Agent started · ${summary}`, at, id ? `tool:${id}` : null);
  else pushFeed(s, 'tool', `${who}${name}${summary ? ` · ${summary}` : ''}`, at, id ? `tool:${id}` : null);
}

function onHook(p) {
  if (!isObj(p) || typeof p.session_id !== 'string' || !p.session_id) return;
  const now = Date.now();
  const at = Math.min(num(p.hud_at) || now, now);
  const ev = str(p.hook_event_name);
  const s = getSession(p.session_id);
  if (s.ended) {
    // Only new work reopens a session (a resume, or activity after a silence). Async hooks of a session that is
    // exiting (Stop, PostToolUse, SessionEnd) can arrive after its registry file is gone: they change nothing.
    if (!REOPEN_EVENTS.has(ev) || at <= (s.endedAt || 0) || (s.inRegistry && !pidAlive(s.pid))) return;
    reopenSession(s);
  }
  s.lastHookAt = Math.max(s.lastHookAt, at);
  if (typeof p.cwd === 'string' && !s.cwd) setCwd(s, p.cwd);
  if (typeof p.transcript_path === 'string') attachSessionTranscript(s, p.transcript_path);
  const sub = typeof p.agent_id === 'string' && p.agent_id ? subForAgent(s, p.agent_id, str(p.agent_type)) : null;
  if (sub) sub.lastHookAt = at;
  const id = str(p.tool_use_id);
  const name = str(p.tool_name) || '?';
  switch (ev) {
    case 'SessionStart':
      setHookStatus(s, 'idle', at);
      if (typeof p.model === 'string') s.hookModel = p.model;
      if (p.source === 'resume') pushFeed(s, 'session', 'Session resumed', at, `resume:${s.id}:${at}`);
      else if (!p.source || p.source === 'startup') pushFeed(s, 'session', 'Session started', at, `start:${s.id}`);   // the registry may have said so already
      break;
    case 'UserPromptSubmit':
      clearNeedsYou(s);
      setHookStatus(s, 'busy', at);
      break;
    case 'PreToolUse': {
      if (id) { s.hookTools.add(id); capSet(s.hookTools, 5000); }
      if (!sub) setHookStatus(s, 'busy', at);
      if (s.doneTools.has(id)) break;                 // async hooks can arrive out of order
      clearNeedsYou(s, sub?.agentId ?? null);
      if (NEEDS_INPUT_TOOLS[name]) setNeedsYou(s, NEEDS_INPUT_TOOLS[name], 'question', at, sub?.agentId);
      const summary = summarizeTool(name, p.tool_input, s.cwd);
      const tool = { id, name, summary, since: at };
      if (sub) sub.currentTool = tool; else s.currentTool = tool;
      if (AGENT_TOOLS.has(name) && id) {
        const input = isObj(p.tool_input) ? p.tool_input : {};
        const child = subForToolUse(s, id);
        child.parentKey = sub?.agentId || s.id;
        child.description ??= str(input.description) || null;
        child.type ??= str(input.subagent_type) || 'general-purpose';
        child.modelHint ??= str(input.model) || null;
        if (input.run_in_background === true || input.run_in_background === 'true') child.background = true;
        child.startedAt ??= at;
      }
      feedTool(s, sub, id, name, summary, at);
      break;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      if (id) { s.doneTools.add(id); capSet(s.doneTools, 1000); }
      const holder = sub || s;
      if (holder.currentTool && (!id || holder.currentTool.id === id)) holder.currentTool = null;
      clearNeedsYou(s, sub?.agentId ?? null);
      if (AGENT_TOOLS.has(name) && id) {
        const child = subForToolUse(s, id);
        const r = isObj(p.tool_response) ? p.tool_response : {};
        if (typeof r.agentId === 'string') assignAgentId(s, child, r.agentId);
        if (r.status === 'async_launched' || r.isAsync === true) child.background = true;
        if (!child.background || ev === 'PostToolUseFailure') closeSub(s, child, at);
      }
      break;
    }
    case 'Notification': {
      const msg = oneLine(p.message);
      const reason = notificationReason(str(p.notification_type), msg);
      if (reason) {
        setNeedsYou(s, reason.text, reason.kind, at, sub?.agentId);
        pushFeed(s, 'needs-you', reason.text, at);
      } else if (msg) pushFeed(s, 'session', msg, at);
      break;
    }
    case 'Stop':
      clearNeedsYou(s);
      s.currentTool = null;
      setHookStatus(s, 'idle', at);
      pushFeed(s, 'done', 'Turn finished', at);
      break;
    case 'SubagentStart':
      if (sub) { sub.startedAt ??= at; if (sub.state === 'done' && at > (sub.endedAt || 0)) { sub.state = 'running'; sub.endedAt = null; } }
      break;
    case 'SubagentStop':
      if (sub) {
        if (typeof p.agent_transcript_path === 'string' && fs.existsSync(p.agent_transcript_path)) attachSubTail(s, sub, p.agent_transcript_path);
        closeSub(s, sub, at);
      }
      break;
    case 'SessionEnd':
      endSession(s, at, str(p.reason) || null);
      break;
    case 'PreCompact':
      pushFeed(s, 'session', `Compacting context${p.trigger ? ` (${p.trigger})` : ''}`, at);
      break;
  }
  scheduleState();
}

// ---------------------------------------------------------------------------------------------------------------------
// Watching ~/.claude/projects (transcripts, subagent files) and the periodic poll

function onProjectsChange(rel) {
  if (!rel) return;
  const parts = String(rel).split(/[\\/]/);
  const base = parts[parts.length - 1];
  const file = path.join(PROJECTS_DIR, ...parts);
  if (parts.length === 2 && base.endsWith('.jsonl')) {
    const s = sessions.get(base.slice(0, -6));
    if (s?.tail) readTail(s.tail);
    else if (s) attachSessionTranscript(s, file);
    else readTail(getTail(file));            // a transcript nobody shows yet: still counted in "tokens today"
    return;
  }
  const si = parts.indexOf('subagents');
  if (si >= 2) {
    const s = sessions.get(parts[1]);
    const m = /^agent-(.+)\.jsonl$/i.exec(base);
    if (!s) { if (m) readTail(getTail(file)); return; }
    if (/\.meta\.json$/i.test(base)) readMeta(s, file);
    else if (m) ensureSubTail(s, m[1], file);
  }
}

// At start: read every transcript touched today ("tokens today" survives a restart) or in the last two hours
// (sessions that ended recently are shown as ended).
async function scanRecentTranscripts() {
  const since = Math.min(startOfDay(), Date.now() - ENDED_KEEP_MS);
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, d.name);
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const f = path.join(dir, e.name);
      let st;
      try { st = await fsp.stat(f); } catch { continue; }
      if (e.isFile() && e.name.endsWith('.jsonl') && st.mtimeMs >= since) {
        const id = e.name.slice(0, -6);
        const s = sessions.get(id);
        if (s) { attachSessionTranscript(s, f); continue; }
        const t = getTail(f);
        await readTail(t);
        if (st.mtimeMs >= Date.now() - ENDED_KEEP_MS && t.info.lastTs) {
          // Not in the registry, which lists every running session: it has ended (a later hook reopens it).
          // Without a readable registry, fall back to silence.
          const ns = getSession(id);
          attachSessionTranscript(ns, f);
          if (registryReadable || Date.now() - t.info.lastTs > SILENT_SESSION_MS) endSession(ns, t.info.lastTs, null);
        }
      } else if (e.isDirectory() && st.mtimeMs >= since) {
        const sub = path.join(f, 'subagents');
        let files = [];
        try { files = await fsp.readdir(sub); } catch { continue; }
        for (const n of files) {
          if (!n.endsWith('.jsonl')) continue;
          const sf = path.join(sub, n);
          try { if ((await fsp.stat(sf)).mtimeMs < since) continue; } catch { continue; }
          if (!sessions.has(e.name)) await readTail(getTail(sf));
        }
      }
    }
  }
  scheduleState();
}

function poll() {
  const now = Date.now();
  scanRegistry();
  for (const s of sessions.values()) {
    if (s.ended && now - s.endedAt > ENDED_KEEP_MS) { dropSession(s); continue; }
    if (!s.tail) attachSessionTranscript(s);
    if (s.ended) continue;
    if (s.tail) readTail(s.tail);
    const last = lastActivity(s);
    if (!s.inRegistry && last && now - last > SILENT_SESSION_MS) { endSession(s, last, null); continue; }
    const idle = sessionStatus(s, now) === 'idle';
    for (const sub of s.subs) {
      if (sub.state !== 'running') continue;
      if (sub.tail) readTail(sub.tail);
      const subLast = Math.max(sub.tail?.info.lastTs || 0, sub.lastHookAt, sub.startedAt || 0);
      const parentMovedOn = (s.tail?.info.lastTs || 0) > subLast || s.lastHookAt > subLast;
      if (now - subLast > SILENT_SUBAGENT_MS && (idle || (sub.background && parentMovedOn))) closeSub(s, sub, subLast);
    }
  }
  for (const [key, r] of roots) {
    if (![...sessions.values()].some(s => s.project === r.project)) dropRoot(key);
  }
  scheduleState();
}
function dropSession(s) {
  if (s.tail) s.tail.owner = null;
  for (const sub of s.subs) if (sub.tail) sub.tail.owner = null;
  sessions.delete(s.id);
}

// =====================================================================================================================
// Plans: every STATUS.md / *-STATUS.md / HANDOFF.md under docs/ or Documentation/ of a project the HUD sees, plus
// small plans (docs/plans/<slug>.md). A "board" is any table with an id column first and a State or Status column.
// Covers the standard's board (workflow/STANDARD.md §5: ID | Item | Agent | Depends on | Model / effort | State |
// Since | Handoff | Notes, with Runs, Decisions (P0) and Questions), and the formats in use before it: the
// WasteManagement2 board ("Waits for" in Notes), FidiaCRM's chunk board and the ImPOS-Maui Phase | State tables.

const PLAN_TOP_DIRS = ['docs', 'Documentation', 'doc'];
const PLAN_FILE_RE = /^(?:.*[-_])?status\.md$|^handoff\.md$/i;
const PLAN_SKIP_DIRS = new Set(['_template', 'node_modules', 'bin', 'obj', 'handoffs', '.git']);
const BOARD_HEADER = '| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |';
const COLUMN_ROLES = [
  ['id', /^(phase|chunk|run|step|slice|stage|id|#|task|milestone|item)$/],
  ['name', /^(title|name|what|input|goal|summary|part|item)$/],
  ['agent', /^(agent|owner|who|assignee)$/],
  ['state', /^(state|status)$/],
  ['since', /^(since|started|date)$/],
  ['deps', /^(depends on|dependencies|waits for|after|requires|prerequisites|blocked by|start when|needs)$/],
  ['notes', /^(notes?|comments?)$/],
  ['handoff', /^handoffs?$/],
  ['modelEffort', /^model\s*\/\s*effort$/],
  ['model', /^model$/],
  ['effort', /^effort$/],
  ['chunks', /^(chunks?|items?)(,? in order)?$/],
  ['lane', /^lane$/],
];

function cleanCell(c) {
  return oneLine(str(c)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*|__|`/g, ''));
}
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '', tick = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (ch === '`') tick = !tick;
    if (ch === '|' && !tick) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}
function parseIdCell(cell) {
  const m = /^([A-Za-z]{0,4}-?\d+(?:[-.]\d+)*[a-z]?)(?![\w])\s*[:.)\-–—]?\s*(.*)$/.exec(cell);
  return m ? { id: m[1], rest: m[2] } : { id: truncate(cell, 40), rest: cell };
}
function normalizeState(raw) {
  const t = raw.toLowerCase().trim();
  if (!t || t === '—' || t === '-') return 'todo';
  if (/\bbounced\b/.test(t)) return 'bounced';
  if (/\bblocked\b/.test(t)) return 'blocked';
  if (/\baccepted\b/.test(t)) return 'accepted';
  if (/\bhanded[- ]?off\b/.test(t)) return 'handed-off';
  if (/\bin[- ]progress\b|^(started|working|building|active|running)\b/.test(t)) return 'in-progress';
  if (/\bpartial(ly)?\b/.test(t)) return 'partial';
  if (/^(done|complete|completed|finished|built|merged|shipped|confirmed|in)\b/.test(t)) return 'done';
  if (/^(todo|to do|not started|planned|pending|open|waiting|next|later)\b/.test(t)) return 'todo';
  if (/\bdone\b/.test(t)) return 'partial';
  return 'unknown';
}
function splitModelEffort(v) {
  const t = cleanCell(v);
  if (!t || /^[—-]$/.test(t)) return { model: null, effort: null };
  const [m, e] = t.split('/').map(x => x.trim());
  return { model: m || null, effort: e || null };
}
function extractRefs(text, known, self) {
  if (!text || !known.length) return [];
  const re = new RegExp(`(?<![A-Za-z0-9-])(${known.map(k => k.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')})(?![A-Za-z0-9]|-\\d)`, 'g');
  const hits = [...text.matchAll(re)];
  const out = [];
  const push = id => { if (id !== self && !out.includes(id)) out.push(id); };
  for (let i = 0; i < hits.length; i++) {
    const a = hits[i], b = hits[i + 1];
    const between = b ? text.slice(a.index + a[0].length, b.index) : '';
    const pa = /^(.*?)(\d+)$/.exec(a[1]), pb = b && /^(.*?)(\d+)$/.exec(b[1]);
    if (b && /^\s*(–|—|-|to|through|\.\.)\s*$/.test(between) && pa && pb && pa[1] === pb[1]) {
      const lo = Number(pa[2]), hi = Number(pb[2]);
      for (const k of known) { const pk = /^(.*?)(\d+)$/.exec(k); if (pk && pk[1] === pa[1] && Number(pk[2]) >= lo && Number(pk[2]) <= hi) push(k); }
      i++;
      continue;
    }
    push(a[1]);
  }
  return out;
}

/** The plan header line (STANDARD §4.1): `Status: **<state>**`, with the date that may follow the state. */
function planHeader(text) {
  const m = /^Status:\s*\*\*([^*]+)\*\*\s*(\d{4}-\d{2}-\d{2})?/m.exec(text.split(/\r?\n/, 30).join('\n'));
  return m ? { state: m[1].trim().toLowerCase(), date: m[2] || null } : null;
}

function parsePlan(text, file, root, project, planText = null) {
  const lines = text.split(/\r?\n/);
  let title = null, section = '', fence = false, inLog = false, standard = false;
  const tables = [], log = [], decisions = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const txt = cleanCell(h[2]);
      if (h[1].length === 1) title ??= txt;
      else { section = txt; inLog = /^log\b/i.test(txt); }
      continue;
    }
    if (inLog && /^\s*[-*]\s+/.test(line)) { log.push(cleanCell(line.replace(/^\s*[-*]\s+/, ''))); continue; }
    const box = /^decisions\b/i.test(section) && /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (box) {
      const body = cleanCell(box[2]);
      decisions.push({ id: (/^(D\d+)\b/.exec(body) || [])[1] || null, text: truncate(body, 200), ticked: box[1] !== ' ' });
      continue;
    }
    if (line.trimStart().startsWith('|') && /^\s*\|[\s:|-]+$/.test(lines[i + 1] || '') && lines[i + 1].includes('-')) {
      if (/^board$/i.test(section) && line.trim() === BOARD_HEADER) standard = true;
      const header = splitRow(line).map(c => cleanCell(c).toLowerCase());
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trimStart().startsWith('|'); i++) rows.push(splitRow(lines[i]));
      i--;
      tables.push({ section, header, rows });
    }
  }

  // Unanswered questions: a Questions table row whose Answer cell is empty (STANDARD §5, §17).
  const questions = [];
  for (const tb of tables) {
    const q = tb.header.indexOf('question'), a = tb.header.indexOf('answer');
    if (!/^questions\b/i.test(tb.section) || q < 0 || a < 0) continue;
    for (const row of tb.rows) {
      const ask = cleanCell(row[q]);
      if (ask && !/^[—-]?$/.test(cleanCell(row[a]))) continue;
      if (ask) questions.push({ id: cleanCell(row[0]) || null, item: cleanCell(row[tb.header.indexOf('item')]) || null, text: truncate(ask, 300) });
    }
  }

  const phases = [], runs = [], byId = new Map(), enrich = [];
  for (const tb of tables) {
    const col = {};
    tb.header.forEach((h, k) => { for (const [role, re] of COLUMN_ROLES) if (re.test(h) && col[role] === undefined && (role !== 'id' || k === 0)) col[role] = k; });
    if (col.id !== 0 || /^questions\b/i.test(tb.section)) continue;
    const head = tb.header[0];
    const tableKind = head === 'run' ? 'run' : head === 'chunk' ? 'chunk' : /^(phase|step|stage|slice)$/.test(head) ? 'phase'
      : (/input/i.test(tb.section) || tb.header[col.name] === 'input') ? 'input' : 'item';
    const group = tb.section.replace(/\s+[—-]\s+\S+\.md$/i, '');
    const isBoard = col.state !== undefined;
    for (const row of tb.rows) {
      const cell = k => (k === undefined ? '' : cleanCell(row[k]));
      const idc = parseIdCell(cell(0));
      if (!idc.id) continue;
      const kind = tableKind === 'item' && /^O-\d+$/.test(idc.id) ? 'input' : tableKind;
      const me = col.modelEffort !== undefined ? splitModelEffort(row[col.modelEffort]) : { model: cell(col.model) || null, effort: cell(col.effort) || null };
      if (!isBoard) { if (me.model || me.effort) enrich.push({ id: idc.id, ...me }); continue; }
      const stateRaw = cell(col.state);
      const since = cell(col.since) || (/(\d{4}-\d{2}-\d{2})/.exec(stateRaw) || [])[1] || null;
      const node = {
        id: idc.id,
        name: truncate(cell(col.name) || idc.rest || idc.id, 140),
        agent: cell(col.agent) || null,
        state: normalizeState(stateRaw),
        stateRaw: truncate(stateRaw, 160),
        since: since && !/^[—-]$/.test(since) ? since : null,
        waitsFor: [],
        notes: truncate(cell(col.notes), 300) || null,
        group: group || null,
        kind,
        model: me.model && !/^[—-]$/.test(me.model) ? me.model : null,
        effort: me.effort,
        _deps: [cell(col.deps), (/waits? for\s+([^·;]+)/i.exec(cell(col.notes)) || [])[1] || ''].join(' '),
        _chunks: cell(col.chunks),
        lane: cell(col.lane) || null,
      };
      if (byId.has(node.id)) continue;
      byId.set(node.id, node);
      (kind === 'run' ? runs : phases).push(node);
    }
  }
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const small = /^docs\/plans\/[^/]+\.md$/i.test(rel);
  const header = planHeader(small ? text : planText ?? '');
  if (!phases.length && !runs.length && !(small && header)) return null;
  for (const e of enrich) { const n = byId.get(e.id); if (n) { n.model ??= e.model; n.effort ??= e.effort; } }
  const known = [...byId.keys()];
  const CROSS = /(?<![\w/-])([a-z0-9][\w.-]*)\/([A-Za-z]{0,4}-?\d+(?:-\d+)?)(?![\w-])/g;
  for (const n of [...phases, ...runs]) {
    n.waitsForOther = [...n._deps.matchAll(CROSS)].map(m => `${m[1]}/${m[2]}`);   // `<slug>/<ID>` in another plan
    n.waitsFor = extractRefs(n._deps.replace(CROSS, ' '), known, n.id);
    if (n.kind === 'run') { n.chunks = extractRefs(n._chunks, known, n.id); n.startWhen = truncate(n._deps.trim(), 200) || null; }
    delete n._deps; delete n._chunks;
    if (n.kind !== 'run') delete n.lane;
  }
  const slug = (/^docs\/plans\/([^/]+)\/status\.md$/i.exec(rel) || /^docs\/plans\/([^/]+)\.md$/i.exec(rel) || [])[1] || rel.replace(/\.md$/i, '');
  let t = (title || slug).replace(/^plan:\s*/i, '').replace(/:\s*(status( and handoffs?)?|handoffs?\b.*)$/i, '').trim();
  if (!t || /^(chunk\s+)?status(\s+board)?$/i.test(t)) t = path.basename(path.dirname(file));
  const openDecisions = decisions.filter(d => !d.ticked).map(({ id, text: dt }) => ({ id, text: dt }));
  return {
    project, slug, title: t, path: file, format: standard ? 'standard' : 'legacy', size: small ? 'small' : 'phased',
    state: header?.state ?? null, stateDate: header?.date ?? null,
    phases, runs,
    needsYou: [...openDecisions.map(d => ({ kind: 'decision', id: d.id, text: d.text })), ...questions.map(q => ({ kind: 'question', id: q.id, item: q.item, text: q.text }))],
    lastLog: log.slice(-5).map(l => truncate(l, 240)),
  };
}

function ensureRoot(root, project) {
  const key = root.toLowerCase();
  if (roots.has(key)) return;
  const rec = { root, project, watchers: [], timer: null };
  roots.set(key, rec);
  for (const top of PLAN_TOP_DIRS) {
    const dir = path.join(root, top);
    if (!fs.existsSync(dir)) continue;
    try {
      const w = fs.watch(dir, { recursive: true }, (e, f) => { if (!f || /\.md$/i.test(f)) scheduleRootScan(key); });
      w.on('error', () => {});
      rec.watchers.push(w);
    } catch {}
  }
  scanRoot(key);
}
function scheduleRootScan(key) {
  const rec = roots.get(key);
  if (!rec || rec.timer) return;
  rec.timer = setTimeout(() => { rec.timer = null; scanRoot(key); }, 400);
}
function dropRoot(key) {
  const rec = roots.get(key);
  if (!rec) return;
  for (const w of rec.watchers) try { w.close(); } catch {}
  clearTimeout(rec.timer);
  roots.delete(key);
  for (const [k, v] of plans) if (v.rootKey === key) plans.delete(k);
}
async function scanRoot(key) {
  const rec = roots.get(key);
  if (!rec) return;
  const files = [];
  const walk = async (dir, depth) => {
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    const smallPlans = depth === 1 && path.basename(dir).toLowerCase() === 'plans';
    for (const e of ents) {
      if (e.isDirectory()) { if (depth < 4 && !PLAN_SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.')) await walk(path.join(dir, e.name), depth + 1); }
      else if (PLAN_FILE_RE.test(e.name) || (smallPlans && /\.md$/i.test(e.name))) files.push(path.join(dir, e.name));
    }
  };
  for (const top of PLAN_TOP_DIRS) await walk(path.join(rec.root, top), 0);
  rec.info = await projectInfo(rec.root);
  const found = new Set();
  for (const f of files) {
    let st, text, planText = null;
    try { st = await fsp.stat(f); text = await fsp.readFile(f, 'utf8'); } catch { continue; }
    if (/status\.md$/i.test(f)) { try { planText = await fsp.readFile(path.join(path.dirname(f), 'PLAN.md'), 'utf8'); } catch {} }
    const plan = parsePlan(text, f, rec.root, rec.project, planText);
    if (!plan) continue;
    const pkey = `${rec.project}|${path.relative(rec.root, f)}`.toLowerCase();
    found.add(pkey);
    const prev = plans.get(pkey);
    if (prev && prev.rootKey !== key && prev.mtime > st.mtimeMs) continue;   // a newer copy in another worktree
    if (prev) diffPlan(prev.plan, plan);
    plans.set(pkey, { plan, mtime: st.mtimeMs, rootKey: key });
  }
  for (const [k, v] of plans) if (v.rootKey === key && !found.has(k)) plans.delete(k);
  scheduleState();
}
// The project's headline (the first section of docs/status.md) and the CLAUDE.md Workflow and Git lines (STANDARD §17).
async function projectInfo(root) {
  const read = async f => { try { return await fsp.readFile(path.join(root, f), 'utf8'); } catch { return null; } };
  const status = await read('docs/status.md');
  const claude = await read('CLAUDE.md');
  let headline = null;
  if (status) {
    const m = /^##\s+The project in one paragraph\s*$([\s\S]*?)(?=^#{1,2}\s|(?![\s\S]))/im.exec(status);
    headline = m ? truncate(oneLine(cleanCell(m[1])), 300) || null : null;
  }
  const git = claude && (/^\*\*Git:\*\*\s*(you commit|agents commit per item)/im.exec(claude) || [])[1];
  return { headline, standard: !!claude && /^\*\*Workflow:\*\*.*standard/im.test(claude), git: git ? git.toLowerCase() : null };
}

function diffPlan(a, b) {
  const old = new Map([...a.phases, ...a.runs].map(n => [n.id, n.state]));
  for (const n of [...b.phases, ...b.runs]) {
    const was = old.get(n.id);
    if (was && was !== n.state) pushFeed({ id: null, project: b.project }, 'plan', `${b.title}: ${n.id} ${was} → ${n.state}`);
  }
  const asked = new Set(a.needsYou.map(x => `${x.kind}:${x.id}:${x.text}`));
  for (const x of b.needsYou) {
    if (!asked.has(`${x.kind}:${x.id}:${x.text}`)) pushFeed({ id: null, project: b.project }, 'needs-you', `${b.title}: ${x.kind === 'decision' ? 'decision' : 'question'} ${x.id ?? ''} waiting on you`.replace(/\s+/g, ' '));
  }
}

// =====================================================================================================================
// Account usage (5-hour and weekly limits): Claude Code caches it in ~/.claude.json. Only that key is used.

function readAccount() {
  fs.readFile(CLAUDE_JSON, 'utf8', (err, txt) => {
    if (err) { account = null; scheduleState(); return; }
    let u;
    try { u = JSON.parse(txt.replace(/^\uFEFF/, ''))?.cachedUsageUtilization; } catch { return; }   // half-written: keep the last value
    const win = w => {
      if (!isObj(w) || !Number.isFinite(w.utilization)) return null;
      const resetsAt = Date.parse(w.resets_at) || null;
      return { pct: resetsAt && resetsAt < Date.now() ? null : Math.round(w.utilization * 10) / 10, resetsAt };
    };
    account = isObj(u) ? { fiveHour: win(u.utilization?.five_hour), sevenDay: win(u.utilization?.seven_day), fetchedAt: num(u.fetchedAtMs) || null } : null;
    scheduleState();
  });
}
function readSettingsFlags() {
  const j = readJsonSync(SETTINGS_FILE);
  const v = j?.env?.CLAUDE_CODE_USE_BEDROCK;
  bedrockFlag = v === true || v === 1 || /^(1|true|yes)$/i.test(String(v ?? ''));
  hooksInstalled = isObj(j?.hooks) && Object.values(j.hooks).some(arr => Array.isArray(arr) && arr.some(g => Array.isArray(g?.hooks) && g.hooks.some(isOurHook)));
  scheduleState();
}

// =====================================================================================================================
// External Bedrock usage (D12). Both sources are off unless switched on by environment variable.

function onUsage(j) {
  if (!isObj(j)) return [400, 'body must be a JSON object'];
  // Redact before cutting to length, so a secret is never cut short of what the patterns recognise.
  const app = truncate(oneLine(redact(str(j.app).trim())), 80);
  const model = truncate(redact(str(j.model).trim()), 160);
  if (!app) return [400, '`app` is required'];
  if (!model) return [400, '`model` is required'];
  const tok = zero();
  for (const k of Object.keys(tok)) {
    const v = j[k] ?? 0;
    if (!Number.isInteger(v) || v < 0 || v > 1e9) return [400, `\`${k}\` must be a whole number from 0 to 1000000000`];
    tok[k] = v;
  }
  let at = Date.now();
  if (j.at != null) {
    at = typeof j.at === 'number' ? j.at : Date.parse(j.at);
    if (!Number.isFinite(at)) return [400, '`at` must be epoch milliseconds or an ISO date'];
  }
  const key = `ingest\u0000${app}\u0000${model}`;
  let row = external.get(key);
  if (!row) {
    if ([...external.values()].filter(r => r.source === 'ingest').length >= EXTERNAL_ROWS_MAX) return [429, 'too many app and model rows'];
    const mi = normalizeModel(model);
    row = { source: 'ingest', app, provider: 'unknown', model: mi.model, modelRaw: model, tokens: zero(), windowStart: at, windowEnd: at, delayed: false };
    external.set(key, row);
  }
  row.provider = ['anthropic', 'bedrock'].includes(j.provider) ? j.provider : normalizeModel(model).provider;
  addTokens(row.tokens, tok);
  row.windowStart = Math.min(row.windowStart, at);
  row.windowEnd = Math.max(row.windowEnd, at);
  scheduleState();
  return [204, ''];
}

function pollCloudWatch() {
  const end = Date.now(), start = startOfDay(end);
  const period = Math.max(60, Math.ceil((end - start) / 60_000) * 60);
  const metrics = [['InputTokenCount', 'input'], ['OutputTokenCount', 'output'], ['CacheReadInputTokenCount', 'cacheRead'], ['CacheWriteInputTokenCount', 'cacheWrite']];
  const queries = metrics.map(([m], i) => ({ Id: `q${i}`, Expression: `SEARCH('{AWS/Bedrock,ModelId} MetricName="${m}"', 'Sum', ${period})`, ReturnData: true }));
  const args = ['cloudwatch', 'get-metric-data', '--region', BEDROCK_REGION, '--start-time', new Date(start).toISOString(),
    '--end-time', new Date(end).toISOString(), '--metric-data-queries', JSON.stringify(queries), '--output', 'json'];
  execFile('aws', args, { timeout: 10_000, windowsHide: true, maxBuffer: 8 << 20 }, (err, out, errOut) => {
    try {
      if (err) throw new Error(err.code === 'ENOENT' ? 'aws CLI not found' : oneLine(errOut) || err.message);
      const res = JSON.parse(out);
      const rows = new Map();
      for (const r of res.MetricDataResults || []) {
        const metric = metrics[Number(String(r.Id).slice(1))];
        if (!metric) continue;
        const modelId = str(r.Label).replace(new RegExp(`\\s*${metric[0]}\\s*$`), '').trim() || 'unknown';
        let row = rows.get(modelId);
        if (!row) {
          const mi = normalizeModel(modelId);
          row = { source: 'cloudwatch', app: null, provider: 'bedrock', model: mi.model, modelRaw: modelId, tokens: zero(), windowStart: start, windowEnd: end, delayed: true };
          rows.set(modelId, row);
        }
        row.tokens[metric[1]] += (r.Values || []).reduce((a, v) => a + num(v), 0);
      }
      for (const k of [...external.keys()]) if (k.startsWith('cloudwatch\u0000')) external.delete(k);
      for (const [m, row] of rows) external.set(`cloudwatch\u0000${m}`, row);
      externalError = null;
    } catch (e) {
      externalError = truncate(`CloudWatch: ${oneLine(e.message)}`, 200);
    }
    scheduleState();
  });
}

// =====================================================================================================================
// State snapshot (PLAN §4.4)

function lastActivity(s) {
  return Math.max(s.tail?.info.lastTs || 0, s.lastHookAt || 0, s.regStatusAt || 0) || null;
}
function sessionStatus(s, now) {
  if (s.ended) return 'ended';
  if (s.needsYou) return 'needs-you';
  if (s.hookStatus && s.hookStatusAt >= s.regStatusAt) return s.hookStatus;
  if (s.regStatus) return s.regStatus;
  const last = lastActivity(s);
  return last && now - last < 30_000 ? 'busy' : 'idle';
}
function latestOpenTool(info) {
  let best = null;
  for (const t of info?.openTools.values() || []) if (!best || t.since >= best.since) best = t;
  return best;
}
function toolView(t) { return t ? { name: t.name, summary: t.summary, since: t.since } : null; }

function subDepth(s, sub, seen = new Set()) {
  if (Number.isInteger(sub.depth)) return sub.depth;
  if (sub.parentKey === s.id || seen.has(sub)) return 1;
  seen.add(sub);
  const parent = s.byAgent.get(sub.parentKey);
  return parent ? subDepth(s, parent, seen) + 1 : 1;
}
function subView(s, sub, now) {
  const info = sub.tail?.info;
  const raw = info?.modelRaw || sub.modelHint;
  const mi = modelInfo(raw);
  const running = sub.state === 'running';
  let tool = running ? sub.currentTool : null;
  if (running && !tool) { const open = latestOpenTool(info); if (open && now - open.since < 30 * 60_000) tool = open; }
  return {
    id: sub.agentId || sub.toolUseId,
    parentId: sub.parentKey === s.id || !s.byAgent.has(sub.parentKey) ? s.id : sub.parentKey,
    depth: subDepth(s, sub),
    description: sub.description, type: sub.type,
    model: mi.model, modelRaw: raw || null, provider: mi.provider,
    state: sub.state, background: sub.background,
    startedAt: sub.startedAt || info?.firstTs || null, endedAt: sub.endedAt,
    tokens: info ? { ...info.tokens } : zero(),
    context: contextFor(mi.model, info?.lastUsed),
    currentTool: toolView(tool),
  };
}
function sessionView(s, now) {
  const info = s.tail?.info;
  const raw = info?.modelRaw || s.hookModel;
  const mi = modelInfo(raw);
  const status = sessionStatus(s, now);
  let tool = null;
  if (status === 'busy' || status === 'needs-you') {
    tool = s.currentTool;
    if (!tool) { const open = latestOpenTool(info); if (open && now - open.since < 30 * 60_000) tool = open; }
  }
  const subagents = [...s.subs].map(sub => subView(s, sub, now)).filter(x => x.id).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const tokens = info ? { ...info.tokens } : zero();
  const tokensTree = subagents.reduce((acc, x) => addTokens(acc, x.tokens), { ...tokens });
  let tools = s.hookTools.size;
  if (info) { tools = info.toolIds.size; for (const id of s.hookTools) if (!info.toolIds.has(id)) tools++; }
  return {
    id: s.id, pid: s.pid, project: s.project || (info?.cwd ? rootFor(info.cwd).project : null), cwd: s.cwd || info?.cwd || null,
    name: s.name, title: truncate(info?.customTitle || info?.title || s.name || null, 300) || null,
    entrypoint: s.entrypoint, version: s.version,
    status,
    needsYou: s.needsYou ? { since: s.needsYou.since, reason: s.needsYou.reason, kind: s.needsYou.kind } : null,
    provider: mi.provider, model: mi.model, modelRaw: raw || null, effort: info?.effort || null, branch: info?.branch || null,
    startedAt: s.startedAt || info?.firstTs || null, lastActivityAt: lastActivity(s), endedAt: s.endedAt,
    currentTool: toolView(tool),
    tools,
    startedBy: s.startedBy,
    tokens, tokensTree,
    context: contextFor(mi.model, info?.lastUsed),
    subagents,
  };
}
const STATUS_ORDER = { 'needs-you': 0, busy: 1, idle: 2, ended: 3 };
function totalsFor(list, planList, tokensToday) {
  const live = list.filter(x => x.status !== 'ended');
  const subagentsRunning = live.reduce((n, x) => n + x.subagents.filter(a => a.state === 'running').length, 0);
  return {
    sessions: live.length,
    needsYou: live.filter(x => x.status === 'needs-you').length,
    busy: live.filter(x => x.status === 'busy').length,
    subagentsRunning,
    agentsRunning: live.filter(x => x.status === 'busy' || x.status === 'needs-you').length + subagentsRunning,
    tokensToday,
    plansInProgress: planList.filter(p => [...p.phases, ...p.runs].some(n => n.state === 'in-progress')).length,
    plansNeedingYou: planList.filter(p => p.needsYou?.length).length,
  };
}
function projectsView() {
  const out = new Map();
  for (const r of roots.values()) {
    const prev = out.get(r.project);
    if (prev && (prev.headline || !r.info?.headline)) continue;
    out.set(r.project, { project: r.project, root: r.root, headline: r.info?.headline ?? null, standard: r.info?.standard ?? false, git: r.info?.git ?? null });
  }
  return [...out.values()].sort((a, b) => a.project.localeCompare(b.project));
}
function snapshot() {
  if (demo) return demo.snapshot();
  const now = Date.now();
  const list = [...sessions.values()]
    .filter(s => !(s.ended && now - s.endedAt > ENDED_KEEP_MS) && (s.inRegistry || s.tail || s.lastHookAt))
    .map(s => sessionView(s, now))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  const today = dayKey(now);
  const tokensToday = zero();
  for (const t of tails.values()) { const d = t.info.byDay.get(today); if (d) addTokens(tokensToday, d); }
  const planList = [...plans.values()].map(v => v.plan).sort((a, b) => a.project.localeCompare(b.project) || a.title.localeCompare(b.title));
  return {
    now, uptime: now - hudStartedAt, demo: false, version: VERSION, hooksInstalled,
    sessions: list,
    external: [...external.values()],
    externalError,
    projects: projectsView(),
    plans: planList,
    feed: feed.slice(-FEED_SNAPSHOT).reverse(),
    account,
    totals: totalsFor(list, planList, tokensToday),
  };
}

// =====================================================================================================================
// HTTP server and server-sent events (PLAN §4.3)

const clients = new Set();
let stateTimer = null, lastStateAt = 0, lastStateBody = '';
function broadcast(event, data) {
  if (!clients.size) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
function scheduleState() {
  if (stateTimer || !clients.size) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    lastStateAt = Date.now();
    const snap = redactDeep(snapshot());
    const { now, uptime, ...rest } = snap;
    const body = JSON.stringify(rest);
    if (body === lastStateBody) return;
    lastStateBody = body;
    broadcast('state', snap);
  }, Math.max(0, lastStateAt + STATE_MIN_INTERVAL_MS - Date.now()));
}

const BASE_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
const PAGE_HEADERS = {
  ...BASE_HEADERS,
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
function send(res, code, body, headers = {}) {
  res.writeHead(code, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}
function sendJson(res, obj) { send(res, 200, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' }); }
function readBody(req, res, max, done) {
  const chunks = [];
  let size = 0, over = false;
  req.on('data', c => {
    if (over) return;
    size += c.length;
    if (size <= max) { chunks.push(c); return; }
    over = true;
    chunks.length = 0;
    res.writeHead(413, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
    res.end('Too large\n', () => req.destroy());
  });
  req.on('end', () => { if (!over) done(Buffer.concat(chunks).toString('utf8')); });
}

function handle(req, res) {
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host || '')) return send(res, 403, 'Forbidden\n');   // DNS-rebinding guard
    const p = new URL(req.url, 'http://h').pathname;
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (p === '/') return send(res, 200, PAGE_HTML, PAGE_HEADERS);
      if (p === '/design') return send(res, 200, DESIGN_HTML, PAGE_HEADERS);
      if (p === '/api/state') return sendJson(res, redactDeep(snapshot()));
      if (p === '/api/health') {
        const snap = snapshot();
        return sendJson(res, { ok: true, uptime: Date.now() - hudStartedAt, sessions: snap.totals.sessions, version: VERSION });
      }
      if (p === '/api/stream') return openStream(req, res);
    }
    if (req.method === 'POST' && (p === '/event' || (p === '/usage' && ACCEPT_USAGE))) {
      // Browsers can't send application/json across origins without a preflight, which gets no CORS answer.
      const origin = req.headers.origin;
      if (origin && !ALLOWED_ORIGINS.has(origin)) return send(res, 403, 'Forbidden\n');
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, 'Use application/json\n');
      return readBody(req, res, p === '/event' ? EVENT_BODY_MAX : USAGE_BODY_MAX, text => {
        let j;
        try { j = JSON.parse(text); } catch { return send(res, 400, 'Bad JSON\n'); }
        if (p === '/event') { if (!demo) onHook(j); return send(res, 204, ''); }
        const [code, msg] = onUsage(j);
        return send(res, code, msg ? msg + '\n' : '');
      });
    }
    return send(res, 404, 'Not found\n');
  } catch (e) {
    console.error('request failed:', e);
    if (!res.headersSent) send(res, 500, 'Error\n');
  }
}
function openStream(req, res) {
  res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
  res.socket?.setNoDelay(true);
  res.write(`retry: 2000\n\nevent: state\ndata: ${JSON.stringify(redactDeep(snapshot()))}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

// The engine's page: the state as JSON, unstyled. P2 replaces it with the HUD.
const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude HUD</title>
<style>body{margin:0;background:#04070d;color:#d6f3ff;font:13px/1.45 Consolas,monospace}header{padding:8px 12px;border-bottom:1px solid #29e6ff38}a{color:#29e6ff}pre{margin:0;padding:12px;white-space:pre-wrap;word-break:break-word}#feed{border-bottom:1px solid #29e6ff38}</style>
</head><body>
<header>Claude HUD engine · <span id="status">connecting…</span> · <a href="/api/state">/api/state</a> · <a href="/design">/design</a></header>
<pre id="feed"></pre><pre id="state"></pre>
<script>
const statusEl = document.getElementById('status'), stateEl = document.getElementById('state'), feedEl = document.getElementById('feed');
const lines = [];
const es = new EventSource('/api/stream');
es.onopen = () => { statusEl.textContent = 'live'; };
es.onerror = () => { statusEl.textContent = 'reconnecting…'; };
es.addEventListener('state', e => { stateEl.textContent = JSON.stringify(JSON.parse(e.data), null, 2); });
es.addEventListener('event', e => {
  const f = JSON.parse(e.data);
  lines.unshift(new Date(f.at).toLocaleTimeString() + '  ' + f.kind.toUpperCase().padEnd(10) + (f.project || '-').padEnd(18) + f.text);
  lines.length = Math.min(lines.length, 25);
  feedEl.textContent = lines.join('\\n');
});
</script>
</body></html>`;

const DESIGN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Claude HUD · design</title>
<style>body{margin:0;padding:24px;background:#04070d;color:#d6f3ff;font:14px system-ui}</style></head>
<body><p>The component gallery is built in phase P2.</p></body></html>`;

// =====================================================================================================================
// Demo mode (`--demo`, `--demo=dense`): simulated sessions, subagents, plans and events covering every state.

function makeDemo(mode) {
  const dense = mode === 'dense';
  const t0 = Date.now();
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const repo = p => `C:\\Users\\demo\\source\\repos\\${p}`;
  const TOOLS = [
    ['Read', 'src/Quotations/QuotationTotals.cs'], ['Edit', 'src/Quotations/QuotationTotals.cs'], ['Bash', 'dotnet test -c Release --no-build --filter Quotation'],
    ['Grep', 'VatRate in src'], ['Glob', '**/*.razor'], ['Bash', 'git status --short'], ['WebFetch', 'learn.microsoft.com/en-us/aspnet/core/blazor'],
    ['Write', 'docs/plans/history/handoffs/P2-history-ui.md'], ['PowerShell', 'Get-ChildItem -Recurse -Filter *.sql | Measure-Object'],
    ['Read', 'Program.cs'], ['Bash', 'sqlcmd -S localhost -d WM2 -Q "SELECT COUNT(*) FROM Customers"'], ['WebSearch', 'Blazor virtualize grouped list'],
  ];
  const AGENT_JOBS = [['Explore', 'Map the quotation totals code'], ['general-purpose', 'Check the VAT rounding rules'], ['web-fetch', 'Read the Syncfusion grid docs'],
    ['Explore', 'Find every caller of SaveCustomer'], ['general-purpose', 'Write the migration script test']];
  const tok = scale => ({ input: Math.round(rnd(2, 40) * scale), output: Math.round(rnd(800, 9000) * scale), cacheRead: Math.round(rnd(40_000, 400_000) * scale), cacheWrite: Math.round(rnd(4_000, 40_000) * scale) });
  const sessionsList = [];
  const feedList = [];
  const addFeed = (s, kind, text) => { const line = { at: Date.now(), sessionId: s?.id ?? null, project: s?.project ?? null, kind, text }; feedList.push(line); if (feedList.length > FEED_MAX) feedList.shift(); broadcast('event', line); };

  function session(o) {
    const model = o.modelRaw || 'claude-opus-5-5';
    const mi = normalizeModel(model);
    const s = {
      id: randomUUID(), pid: rnd(2000, 60000), project: o.project, cwd: repo(o.project), name: `${o.project.toLowerCase()}-${rnd(16, 255).toString(16)}`,
      title: o.title, entrypoint: 'claude-vscode', version: '2.1.312', status: o.status,
      needsYou: o.needsYou ? { since: t0 - (o.needsFor || 60) * 1000, reason: o.needsYou, kind: o.needsKind || 'permission' } : null,
      provider: mi.provider, model: mi.model, modelRaw: model, effort: o.effort || 'high', branch: o.branch || 'main',
      startedAt: t0 - (o.age || 1800) * 1000, lastActivityAt: t0 - (o.quiet || 2) * 1000, endedAt: o.status === 'ended' ? t0 - (o.endedAgo || 180) * 1000 : null,
      currentTool: null, tools: rnd(6, 180), startedBy: null, tokens: tok(o.scale || 1), tokensTree: null, context: null, subagents: [],
      _ctx: o.ctx ?? rnd(6, 48),
    };
    if (s.status === 'busy' || s.status === 'needs-you') setTool(s);
    sessionsList.push(s);
    return s;
  }
  function sub(s, parentId, depth, [type, description], o = {}) {
    const model = o.modelRaw || pick(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
    const mi = normalizeModel(model);
    const a = { id: `a${randomUUID().replace(/-/g, '').slice(0, 16)}`, parentId, depth, description, type, model: mi.model, modelRaw: model, provider: s.provider,
      state: o.state || 'running', background: !!o.background, startedAt: Date.now() - (o.age || 40) * 1000, endedAt: o.state === 'done' ? Date.now() - 20_000 : null,
      tokens: tok(0.3), context: null, currentTool: null, _ctx: rnd(5, 40) };
    if (a.state === 'running') setTool(a);
    s.subagents.push(a);
    return a;
  }
  function setTool(x) { const [name, summary] = pick(TOOLS); x.currentTool = { name, summary, since: Date.now() - rnd(0, 20) * 1000 }; }
  function grow(x) { x.tokens.output += rnd(20, 400); x.tokens.cacheRead += rnd(2_000, 30_000); x.tokens.cacheWrite += rnd(0, 3_000); x.tokens.input += rnd(0, 3); }

  let coordinator, flipper, cycler = null;
  if (!dense) {
    session({ project: 'FidiaCRM', title: 'Quotation wizard: totals, VAT rows and the discount line', status: 'needs-you', needsYou: 'Permission: Bash', needsFor: 95, branch: 'ux/R14-quotation-wizard', scale: 2 });
    coordinator = session({ project: 'WasteManagement2', title: 'Coordinator: customer history plan, phases P2 and P3', status: 'busy', branch: 'customer-history', scale: 4, ctx: 42, age: 5400 });
    const explore = sub(coordinator, coordinator.id, 1, AGENT_JOBS[0], { age: 120 });
    sub(coordinator, explore.id, 2, AGENT_JOBS[1], { age: 50, modelRaw: 'claude-haiku-5-5' });
    cycler = sub(coordinator, coordinator.id, 1, AGENT_JOBS[2], { age: 10, modelRaw: 'claude-haiku-5-5' });
    session({ project: 'FidiaCRM', title: 'Clients: contact length limits (P3-06)', status: 'idle', branch: 'clients/P3-06', quiet: 900, effort: 'medium', modelRaw: 'claude-sonnet-5-5' });
    const ended = session({ project: 'WasteManagement2', title: 'Say hi', status: 'ended', endedAgo: 180, age: 240, effort: 'low', modelRaw: 'claude-haiku-5-5', scale: 0.1 });
    ended.startedBy = coordinator.id;
    flipper = session({ project: 'ImPOS-Maui', title: 'Phone app phase 7: battery and Xiaomi autostart switches, runbook for the real-phone pass on the Samsung and the support notes for the shop owners', status: 'busy', branch: 'phone-app', modelRaw: 'us.anthropic.claude-sonnet-5-5-v1:0', scale: 2 });
  } else {
    const projects = ['FidiaCRM', 'WasteManagement2', 'ImPOS-Maui', 'TourCMS', 'Aegis', 'fidiagraf.com'];
    const statuses = ['needs-you', 'busy', 'busy', 'idle', 'busy', 'idle', 'ended', 'busy'];
    for (let i = 0; i < 24; i++) {
      const status = statuses[i % statuses.length];
      const s = session({ project: projects[i % projects.length], title: `${pick(['Fix', 'Build', 'Review', 'Plan', 'Migrate'])} ${pick(['quotation totals', 'the history tab', 'Xiaomi autostart', 'booking changes', 'the tour calendar', 'invoice OCR', 'the deployment guide for the first agency server'])}`,
        status, needsYou: status === 'needs-you' ? pick(['Permission: Bash', 'Question for you', 'Permission: Edit']) : null, modelRaw: i % 7 === 3 ? 'global.anthropic.claude-opus-5-5-v1:0' : pick(['claude-opus-5-5', 'claude-sonnet-5-5']), quiet: status === 'idle' ? rnd(60, 3000) : 2 });
      if (status === 'busy' && i % 3 === 1) { const a = sub(s, s.id, 1, pick(AGENT_JOBS)); if (i % 2) sub(s, a.id, 2, pick(AGENT_JOBS)); }
    }
    coordinator = sessionsList[1];
  }

  const PLAN_STEPS = [
    ['in-progress', 'todo', 'todo', 'todo'], ['handed-off', 'todo', 'todo', 'todo'], ['accepted', 'in-progress', 'in-progress', 'todo'],
    ['accepted', 'handed-off', 'in-progress', 'todo'], ['accepted', 'handed-off', 'handed-off', 'todo'], ['accepted', 'accepted', 'bounced', 'in-progress'],
    ['accepted', 'accepted', 'in-progress', 'blocked'], ['accepted', 'accepted', 'handed-off', 'in-progress'], ['accepted', 'accepted', 'accepted', 'handed-off'],
  ];
  const plan = {
    project: 'WasteManagement2', slug: 'customer-history-and-change-requests', title: 'Customer change history and change requests',
    path: `${repo('WasteManagement2')}\\docs\\plans\\customer-history-and-change-requests\\STATUS.md`,
    phases: [['P1', 'Data and history', 'data', []], ['P2', 'History tab and header', 'history-ui', ['P1']], ['P3', 'Change requests in the service', 'requests', ['P1']], ['P4', 'Verification and cleanup', 'verify', ['P2', 'P3']]]
      .map(([id, name, agent, waitsFor]) => ({ id, name, agent, state: 'todo', stateRaw: 'todo', since: null, waitsFor, notes: waitsFor.length ? `Waits for ${waitsFor.join(' and ')}` : null, group: 'Board', kind: 'phase', model: 'Opus 5.5', effort: 'high' })),
    format: 'standard', size: 'phased', state: 'building', stateDate: null, needsYou: [],
    runs: [], lastLog: ['2026-10-29 · planner · — · Plan written.', '2026-10-29 · planner · P0 · All decisions confirmed. P1 can start.'],
  };
  const chunkPlan = {
    project: 'FidiaCRM', slug: 'Documentation/Implementation/STATUS', title: 'Implementation', path: `${repo('FidiaCRM')}\\Documentation\\Implementation\\STATUS.md`,
    phases: [
      ...['Spec, tokens, gates', 'Frame and action bars', 'Table system'].map((name, i) => ({ id: `UX-0${i + 1}`, name, agent: null, state: 'done', stateRaw: 'done (2026-10-28)', since: '2026-10-28', waitsFor: i ? [`UX-0${i}`] : [], notes: null, group: 'Phase 12: UI/UX upgrade', kind: 'chunk', model: 'Opus 5.5', effort: 'high' })),
      ...['Quotation wizard and case wizard', 'Quotations', 'Clients'].map((name, i) => ({ id: `UX-1${i}`, name, agent: null, state: i === 0 ? 'in-progress' : 'todo', stateRaw: i === 0 ? 'in progress (2026-10-29)' : 'todo', since: i === 0 ? '2026-10-29' : null, waitsFor: i === 2 ? ['UX-03', 'O-9'] : ['UX-03'], notes: null, group: 'Phase 12: UI/UX upgrade', kind: 'chunk', model: i ? 'Sonnet 5.5' : 'Opus 5.5', effort: 'high' })),
      { id: 'UX-20', name: 'Sweep and owner review', agent: null, state: 'todo', stateRaw: 'todo', since: null, waitsFor: ['UX-10', 'UX-11', 'UX-12'], notes: null, group: 'Phase 12: UI/UX upgrade', kind: 'chunk', model: 'Opus 5.5', effort: 'high' },
      { id: 'O-9', name: 'Production column sizes for client contacts', agent: null, state: 'todo', stateRaw: 'wanted', since: null, waitsFor: [], notes: null, group: 'Owner inputs', kind: 'input', model: null, effort: null },
    ],
    runs: [
      { id: 'R14', name: 'Quotation screens', agent: null, state: 'in-progress', stateRaw: 'in progress (2026-10-29)', since: '2026-10-29', waitsFor: ['UX-03'], notes: null, group: 'Runs', kind: 'run', model: 'Opus 5.5', effort: 'high', lane: 'A', chunks: ['UX-10', 'UX-11'], startWhen: 'UX-06 done' },
      { id: 'R15', name: 'Clients screens', agent: null, state: 'todo', stateRaw: 'todo', since: null, waitsFor: ['O-9'], notes: null, group: 'Runs', kind: 'run', model: 'Sonnet 5.5', effort: 'high', lane: 'B', chunks: ['UX-12'], startWhen: 'O-9 is in' },
    ],
    format: 'legacy', size: 'phased', state: null, stateDate: null,
    needsYou: [{ kind: 'question', id: '3', item: 'UX-12', text: 'Contact names longer than 60 characters: cut them, or widen the column to 120?' }],
    lastLog: [],
  };
  const smallPlan = {
    project: 'TourCMS', slug: 'booking-changes', title: 'Booking changes', path: `${repo('TourCMS')}\\docs\\plans\\booking-changes.md`,
    format: 'standard', size: 'small', state: 'approved', stateDate: '2026-10-28',
    needsYou: [{ kind: 'decision', id: 'D2', text: 'D2 A changed booking keeps its original price unless the tour price went down ★' }],
    phases: [['P1', 'Change dates', 'todo'], ['P2', 'Change people', 'todo']].map(([id, name, state], i) => ({ id, name, agent: 'bookings', state, stateRaw: state, since: null, waitsFor: i ? ['P1'] : [], notes: null, group: 'Board', kind: 'item', model: 'Sonnet 5.5', effort: 'high' })),
    runs: [], lastLog: [],
  };
  for (const n of [...plan.phases, ...chunkPlan.phases, ...chunkPlan.runs, ...smallPlan.phases]) n.waitsForOther = [];
  const projectList = [
    { project: 'FidiaCRM', root: repo('FidiaCRM'), headline: null, standard: false, git: null },
    { project: 'ImPOS-Maui', root: repo('ImPOS-Maui'), headline: 'Point of sale for small shops: a MAUI phone app and a Blazor back office.', standard: true, git: 'you commit' },
    { project: 'TourCMS', root: repo('TourCMS'), headline: 'Tour booking site and its back office.', standard: true, git: 'you commit' },
    { project: 'WasteManagement2', root: repo('WasteManagement2'), headline: 'Waste collection contracts, tickets and drivers for a municipal operator.', standard: true, git: 'you commit' },
  ];
  const external = dense ? [] : [
    { source: 'ingest', app: 'invoice-ocr', provider: 'bedrock', model: 'claude-haiku-5-5', modelRaw: 'anthropic.claude-haiku-5-5', tokens: tok(0.5), windowStart: startOfDay(), windowEnd: t0, delayed: false },
    { source: 'ingest', app: 'support-bot', provider: 'bedrock', model: 'claude-sonnet-5-5', modelRaw: 'us.anthropic.claude-sonnet-5-5-v1:0', tokens: tok(1), windowStart: startOfDay(), windowEnd: t0, delayed: false },
    { source: 'cloudwatch', app: null, provider: 'bedrock', model: 'claude-sonnet-5-5', modelRaw: 'us.anthropic.claude-sonnet-5-5-v1:0', tokens: tok(3), windowStart: startOfDay(), windowEnd: t0 - 300_000, delayed: true },
  ];
  const acct = { fiveHour: { pct: 42, resetsAt: t0 + 2.4 * 3600_000 }, sevenDay: { pct: 31, resetsAt: t0 + 3.2 * 86400_000 }, fetchedAt: t0 };
  let planStep = -1;

  function tick() {
    const now = Date.now();
    for (const s of sessionsList) {
      if (s.status === 'busy') { grow(s); s.lastActivityAt = now; if (Math.random() < 0.18) { setTool(s); s.tools++; addFeed(s, 'tool', `${s.currentTool.name} · ${s.currentTool.summary}`); } }
      for (const a of s.subagents) if (a.state === 'running') { grow(a); if (Math.random() < 0.15) { setTool(a); addFeed(s, 'tool', `${a.type} › ${a.currentTool.name} · ${a.currentTool.summary}`); } }
    }
    if (coordinator && coordinator.status === 'busy') {
      coordinator._ctx += 0.6;
      if (coordinator._ctx > 91) { coordinator._ctx = 34; addFeed(coordinator, 'session', 'Compacting context (auto)'); }
    }
    if (cycler) {   // a subagent that finishes and is replaced, so arrivals and the "done" moment can be designed
      const age = (now - cycler.startedAt) / 1000;
      if (cycler.state === 'running' && age > 16) { cycler.state = 'done'; cycler.endedAt = now; cycler.currentTool = null; addFeed(coordinator, 'done', `Agent done · ${cycler.type}: ${cycler.description}`); }
      else if (cycler.state === 'done' && (now - cycler.endedAt) > 9000) {
        coordinator.subagents = coordinator.subagents.filter(a => a !== cycler || coordinator.subagents.filter(x => x.state === 'done').length < 4);
        cycler = sub(coordinator, coordinator.id, 1, pick(AGENT_JOBS), { age: 0, modelRaw: 'claude-haiku-5-5' });
        addFeed(coordinator, 'agent', `Agent started · ${cycler.type}: ${cycler.description}`);
      }
    }
    if (flipper) {  // asks a question for 12 s out of every 45 s
      const phase = ((now - t0) / 1000) % 45;
      if (phase > 30 && !flipper.needsYou) { flipper.status = 'needs-you'; flipper.needsYou = { since: now, reason: 'Question for you', kind: 'question' }; addFeed(flipper, 'needs-you', 'Question for you'); }
      if (phase <= 30 && flipper.needsYou) { flipper.status = 'busy'; flipper.needsYou = null; }
    }
    const step = Math.floor((now - t0) / 20_000) % PLAN_STEPS.length;
    if (step !== planStep) {
      PLAN_STEPS[step].forEach((st, i) => {
        const ph = plan.phases[i];
        if (planStep >= 0 && ph.state !== st) addFeed({ project: plan.project }, 'plan', `${plan.title}: ${ph.id} ${ph.state} → ${st}`);
        ph.state = st; ph.stateRaw = st; ph.since = st === 'todo' ? null : '2026-10-29';
      });
      planStep = step;
    }
    acct.fiveHour.pct = Math.min(99, Math.round((acct.fiveHour.pct + 0.03) * 100) / 100);
    for (const r of external) if (!r.delayed && Math.random() < 0.3) { r.tokens.input += rnd(200, 2000); r.tokens.output += rnd(50, 500); r.windowEnd = now; }
    scheduleState();
  }

  function snapshot() {
    const now = Date.now();
    const list = sessionsList.map(s => {
      const out = { ...s, subagents: s.subagents.map(a => { const { _ctx, ...rest } = a; return { ...rest, context: contextFor(a.model, Math.round(_ctx / 100 * (CONTEXT_WINDOWS[a.model] || 0))) }; }) };
      delete out._ctx;
      out.context = contextFor(s.model, Math.round(s._ctx / 100 * (CONTEXT_WINDOWS[s.model] || 0)));
      out.tokensTree = out.subagents.reduce((acc, a) => addTokens(acc, a.tokens), { ...s.tokens });
      if (out.status === 'busy' || out.status === 'needs-you') out.lastActivityAt = now;
      return out;
    }).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
    const tokensToday = list.reduce((acc, s) => addTokens(acc, s.tokensTree), zero());
    const planList = dense ? [plan] : [plan, chunkPlan, smallPlan];
    return {
      now, uptime: now - t0, demo: dense ? 'dense' : true, version: VERSION, hooksInstalled: true,
      sessions: list, external, externalError: null, projects: projectList, plans: planList, feed: feedList.slice(-FEED_SNAPSHOT).reverse(),
      account: acct, totals: totalsFor(list, planList, tokensToday),
    };
  }

  for (const s of sessionsList) if (s.currentTool) addFeed(s, 'tool', `${s.currentTool.name} · ${s.currentTool.summary}`);
  tick();
  setInterval(tick, 1000);
  return { snapshot };
}

// =====================================================================================================================
// Serve

function serve(demoMode) {
  const server = http.createServer(handle);
  server.on('error', e => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is in use: is the HUD already running? (HUD_PORT picks another port)` : `Server error: ${e.message}`);
    process.exit(1);
  });
  process.on('uncaughtException', e => console.error('error:', e));
  process.on('unhandledRejection', e => console.error('error:', e));
  server.listen(PORT, HOST, () => console.log(`Claude HUD ${VERSION} on http://${HOST}:${PORT}${demoMode ? ` (demo${demoMode === 'dense' ? ', dense' : ''})` : ''}`));
  setInterval(() => { for (const c of clients) c.write(': keep-alive\n\n'); }, KEEPALIVE_MS);
  if (demoMode) { demo = makeDemo(demoMode); return; }

  readSettingsFlags();
  readAccount();
  fs.watchFile(SETTINGS_FILE, { interval: 5000 }, readSettingsFlags);
  fs.watchFile(CLAUDE_JSON, { interval: 10_000 }, readAccount);
  const watch = (dir, opts, fn) => { try { fs.watch(dir, opts, fn).on('error', () => {}); } catch {} };
  watch(SESSIONS_DIR, {}, (e, f) => { if (!f || /^\d+\.json$/.test(f)) scanRegistry(); });
  watch(PROJECTS_DIR, { recursive: true }, (e, f) => onProjectsChange(f));
  scanRegistry().then(scanRecentTranscripts);
  setInterval(poll, POLL_MS);
  if (BEDROCK_REGION) {
    if (/^[a-z]{2}(-[a-z]+)+-\d+$/.test(BEDROCK_REGION)) { pollCloudWatch(); setInterval(pollCloudWatch, CLOUDWATCH_EVERY_MS); }
    else externalError = 'CloudWatch: HUD_BEDROCK_REGION is not a region name';
  }
}

// =====================================================================================================================
// install / uninstall (PLAN §4.2): ~/.claude/settings.json is changed only here.

function isOurHook(h) { return isObj(h) && h.type === 'command' && typeof h.command === 'string' && (h.command === HOOK_COMMAND || OUR_HOOK_RE.test(h.command)); }
function ourGroup(event) {
  const handler = { type: 'command', command: HOOK_COMMAND, timeout: 2 };
  if (!SYNC_EVENTS.has(event)) handler.async = true;
  return MATCHER_EVENTS.has(event) ? { matcher: '*', hooks: [handler] } : { hooks: [handler] };
}
function removeOurs(groups) {
  const out = [];
  for (const g of groups) {
    if (!isObj(g) || !Array.isArray(g.hooks)) { out.push(g); continue; }
    const kept = g.hooks.filter(h => !isOurHook(h));
    if (kept.length === g.hooks.length) out.push(g);
    else if (kept.length) out.push({ ...g, hooks: kept });
  }
  return out;
}
function countOurs(groups) { return groups.reduce((n, g) => n + (Array.isArray(g?.hooks) ? g.hooks.filter(isOurHook).length : 0), 0); }
function fail(msg) { console.error(msg); process.exit(1); }
function readSettingsText() {
  try { return fs.readFileSync(SETTINGS_FILE, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function parseSettings(raw) {
  let obj;
  try { obj = raw == null ? {} : JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { fail(`${SETTINGS_FILE} is not valid JSON. Nothing was changed.`); }
  if (!isObj(obj)) fail(`${SETTINGS_FILE} does not hold a JSON object. Nothing was changed.`);
  if (obj.hooks !== undefined && !isObj(obj.hooks)) fail('"hooks" in settings.json is not an object. Nothing was changed.');
  return obj;
}
function formatLike(raw, obj) {
  const indent = (/^([ \t]+)"/m.exec(raw || '') || [null, '  '])[1];
  let out = JSON.stringify(obj, null, indent);
  if (raw == null || /\n$/.test(raw)) out += '\n';
  if (raw?.includes('\r\n')) out = out.replace(/\n/g, '\r\n');
  if (raw?.startsWith('\uFEFF')) out = '\uFEFF' + out;
  return out;
}
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}
function backupSettings(raw) {
  const base = `${SETTINGS_FILE}.hud-backup-${stamp()}`;
  for (let n = 1; ; n++) {
    const file = n === 1 ? base : `${base}-${n}`;
    try { fs.writeFileSync(file, raw, { flag: 'wx' }); return file; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}
function writeSettings(text) {
  const tmp = `${SETTINGS_FILE}.hud-tmp`;
  fs.writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, SETTINGS_FILE); return; } catch (e) {
      if (i >= 10) { fs.writeFileSync(SETTINGS_FILE, text); fs.rmSync(tmp, { force: true }); return; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);   // the file can be briefly locked by a reader
    }
  }
}

function install() {
  const raw = readSettingsText();
  const obj = parseSettings(raw);
  const next = structuredClone(obj);
  next.hooks = next.hooks ? next.hooks : {};
  for (const ev of HOOK_EVENTS) {
    const want = ourGroup(ev);
    const groups = next.hooks[ev] ?? [];
    if (!Array.isArray(groups)) fail(`"hooks.${ev}" in settings.json is not a list. Nothing was changed.`);
    const ok = countOurs(groups) === 1 && groups.some(g => isDeepStrictEqual(g, want));
    next.hooks[ev] = ok ? groups : [...removeOurs(groups), want];
  }
  if (isDeepStrictEqual(next, obj)) { console.log('Claude HUD hooks are already installed. settings.json was not changed.'); return; }
  const backup = raw == null ? null : backupSettings(raw);
  writeSettings(formatLike(raw, next));
  console.log(`Installed Claude HUD hooks for ${HOOK_EVENTS.length} events in ${SETTINGS_FILE}`);
  if (backup) console.log(`Backup of the previous file: ${backup}`);
  console.log(`Hook command: ${HOOK_COMMAND}`);
  console.log('Open sessions pick the change up by themselves. Remove the hooks with: node hud.mjs uninstall');
}

function uninstall() {
  const raw = readSettingsText();
  if (raw == null) { console.log('No settings.json: nothing to remove.'); return; }
  const obj = parseSettings(raw);
  if (!obj.hooks) { console.log('No hooks in settings.json: nothing to remove.'); return; }
  const next = structuredClone(obj);
  let removed = 0;
  for (const ev of Object.keys(next.hooks)) {
    const groups = next.hooks[ev];
    if (!Array.isArray(groups)) continue;
    const n = countOurs(groups);
    if (!n) continue;
    removed += n;
    const kept = removeOurs(groups);
    if (kept.length) next.hooks[ev] = kept; else delete next.hooks[ev];
  }
  if (!removed) { console.log('No Claude HUD hooks found. settings.json was not changed.'); return; }
  const emptied = Object.keys(next.hooks).length === 0;
  const withoutKey = structuredClone(next);
  if (emptied) delete withoutKey.hooks;
  // Restore the exact bytes of a backup when it holds this same content (keeps the file byte-identical).
  let text = null, from = null;
  const dir = path.dirname(SETTINGS_FILE);
  const backups = fs.readdirSync(dir).filter(f => f.startsWith('settings.json.hud-backup-')).sort().reverse();
  for (const f of backups) {
    const b = readSettingsTextAt(path.join(dir, f));
    let parsed;
    try { parsed = JSON.parse(b.replace(/^\uFEFF/, '')); } catch { continue; }
    if (isDeepStrictEqual(parsed, withoutKey) || (emptied && isDeepStrictEqual(parsed, next))) { text = b; from = f; break; }
  }
  const backup = backupSettings(raw);
  writeSettings(text ?? formatLike(raw, withoutKey));
  console.log(`Removed ${removed} Claude HUD hook entr${removed === 1 ? 'y' : 'ies'} from ${SETTINGS_FILE}`);
  if (from) console.log(`The file now matches ${from} byte for byte.`);
  console.log(`Backup of the previous file: ${backup}`);
}
function readSettingsTextAt(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }

// =====================================================================================================================
// autostart on|off (D8): a Task Scheduler task at logon. conhost --headless keeps the console window hidden.

function autostart(arg) {
  if (process.platform !== 'win32') fail('autostart is only available on Windows.');
  const q = s => `'${String(s).replace(/'/g, "''")}'`;
  const task = 'Claude HUD';
  let script;
  if (arg === 'on') {
    script = `$ErrorActionPreference = 'Stop'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\\conhost.exe') -Argument ${q(`--headless "${process.execPath}" "${SCRIPT}"`)} -WorkingDirectory ${q(path.dirname(SCRIPT))}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName ${q(task)} -Description 'Starts the Claude HUD dashboard (http://127.0.0.1:${PORT}) at logon, without a window.' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
'Autostart is on: the task "${task}" starts the HUD at logon. Start it now with: schtasks /run /tn "${task}"'`;
  } else if (arg === 'off') {
    script = `if (Get-ScheduledTask -TaskName ${q(task)} -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName ${q(task)} -Confirm:$false; 'Autostart is off: the task "${task}" was removed. A HUD that is running keeps running.' } else { 'Autostart was already off.' }`;
  } else if (!arg || arg === 'status') {
    script = `$t = Get-ScheduledTask -TaskName ${q(task)} -ErrorAction SilentlyContinue; if ($t) { 'Autostart is on (task state: ' + $t.State + ').' } else { 'Autostart is off.' }`;
  } else fail('Usage: node hud.mjs autostart on|off');
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30_000 }, (err, out, errOut) => {
    if (err) fail(`autostart ${arg || 'status'} failed: ${oneLine(errOut) || err.message}`);
    console.log(out.trim());
  });
}

// =====================================================================================================================
// lint <repo>: every place a repository differs from the agent workflow standard (workflow/STANDARD.md), i.e. the
// [lint] lines of workflow/conformance.md. Read-only. Exit code 1 when anything is found.

const LINT_STATES = new Set(['todo', 'in-progress', 'blocked', 'partial', 'handed-off', 'accepted', 'bounced']);
const LINT_ID = /^(P\d+(-\d{2})?|O-\d+|[A-Z]{1,4}-\d+)$/;
const LINT_MODEL_EFFORT = /^[A-Z][\w.]*(?: [\w.]+)* \/ (low|medium|high|xhigh|max)$/;
const LINT_TABLES = {
  Runs: '| Run | Items, in order | Model / effort | Lane | Start when | State |',
  Branches: '| Branch | From | Merges into | State | Who merges |',
  Questions: '| # | Item | Question | Recommended | Answer |',
};
const CLAUDE_MD_SECTIONS = ['Working with the owner', 'Build, run, test', 'Parallel work', 'Rules', 'Safety', 'Pitfalls already hit'];
const STATUS_MD_SECTIONS = ['The project in one paragraph', 'Where things stand', 'Active plans', 'What is next', 'Waiting on you', 'The last session'];
const ROADMAP_SECTIONS = ['Next', 'Later', 'On hold', 'Found while building'];
const OLD_HOMES = new Set(['backlog.md', 'follow-ups.md', 'browser-checklist.md']);

/** Markdown headings outside code fences: [{ level, title, line }]. */
function mdHeadings(text) {
  const out = [];
  let fence = false;
  text.split(/\r?\n/).forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const h = !fence && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) out.push({ level: h[1].length, title: h[2], line: i + 1 });
  });
  return out;
}
/** The first table after a `## <title>` heading: { header, headerLine, rows: [{ cells, line }] }, or null. */
function mdTableAfter(lines, title) {
  const at = lines.findIndex(l => new RegExp(`^##\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(l));
  if (at < 0) return null;
  let i = at + 1;
  while (i < lines.length && !lines[i].trimStart().startsWith('|') && !/^#{1,2}\s/.test(lines[i])) i++;
  if (i >= lines.length || !lines[i].trimStart().startsWith('|')) return { header: null, headerLine: at + 1, rows: [] };
  const rows = [];
  for (let k = i + 2; k < lines.length && lines[k].trimStart().startsWith('|'); k++) rows.push({ cells: splitRow(lines[k]), line: k + 1 });
  return { header: lines[i].trim(), headerLine: i + 1, rows };
}
function inOrder(found, wanted) {
  const idx = found.map(t => wanted.findIndex(w => w.toLowerCase() === t.title.trim().toLowerCase()));
  const stray = found.filter((t, k) => idx[k] < 0);
  const order = idx.filter(k => k >= 0).every((k, n, a) => !n || a[n - 1] < k);
  return { stray, order, missing: wanted.filter(w => !found.some(t => t.title.trim().toLowerCase() === w.toLowerCase())) };
}

function lintRepo(repo) {
  const problems = [];
  const rel = f => path.relative(repo, f).replace(/\\/g, '/') || '.';
  const add = (file, line, text) => problems.push({ file: rel(file), line: line || null, text });
  const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const docs = path.join(repo, 'docs');

  // Project files (§3)
  const claudeFile = path.join(repo, 'CLAUDE.md');
  const claude = read(claudeFile);
  if (claude == null) add(claudeFile, null, 'missing');
  else {
    if (!/^\*\*Workflow:\*\*.*\bstandard\b/im.test(claude)) add(claudeFile, null, 'no **Workflow:** line naming the agent workflow standard');
    if (!/^\*\*Git:\*\*\s*(you commit|agents commit per item)\s*$/im.test(claude)) add(claudeFile, null, 'no **Git:** line saying "you commit" or "agents commit per item"');
    const h2 = mdHeadings(claude).filter(h => h.level === 2);
    const o = inOrder(h2, CLAUDE_MD_SECTIONS);
    for (const s of o.stray) add(claudeFile, s.line, `section "${s.title}" is not one of the §3.1 sections`);
    if (!o.order) add(claudeFile, null, `sections are not in the §3.1 order (${CLAUDE_MD_SECTIONS.join(', ')})`);
  }
  const statusFile = path.join(docs, 'status.md');
  const status = read(statusFile);
  if (status == null) add(statusFile, null, 'missing');
  else {
    const o = inOrder(mdHeadings(status).filter(h => h.level === 2), STATUS_MD_SECTIONS);
    for (const s of o.stray) add(statusFile, s.line, `section "${s.title}" is not one of the six §3.2 sections`);
    for (const m of o.missing) add(statusFile, null, `section "${m}" is missing`);
    if (!o.order) add(statusFile, null, 'the six sections are not in the §3.2 order');
  }
  const roadmapFile = path.join(docs, 'roadmap.md');
  const roadmap = read(roadmapFile);
  if (roadmap == null) add(roadmapFile, null, 'missing');
  else {
    const o = inOrder(mdHeadings(roadmap).filter(h => h.level === 2), ROADMAP_SECTIONS);
    for (const s of o.stray) add(roadmapFile, s.line, `section "${s.title}" is not one of the §3.3 sections`);
    for (const m of o.missing) add(roadmapFile, null, `section "${m}" is missing`);
    if (!o.order) add(roadmapFile, null, 'sections are not in the §3.3 order');
    const seen = new Map();
    roadmap.split(/\r?\n/).forEach((l, i) => {
      if (!/^[-*]\s+/.test(l)) return;
      const m = /^[-*]\s+\*\*(B-\d+)\*\*/.exec(l);
      if (!m) return add(roadmapFile, i + 1, 'an item that does not start with **B-<n>**');
      if (seen.has(m[1])) add(roadmapFile, i + 1, `${m[1]} is used again (first on line ${seen.get(m[1])})`);
      else seen.set(m[1], i + 1);
      if (!l.split(/\s+·(?:\s+|$)/).some(p => /^(proposed|approved \d{4}-\d{2}-\d{2}|building|on hold)$/.test(p.trim()))) add(roadmapFile, i + 1, `${m[1]} has no state (proposed, approved yyyy-MM-dd, building or on hold)`);
    });
  }
  if (read(path.join(docs, 'checks.md')) == null) add(path.join(docs, 'checks.md'), null, 'missing');

  // Old homes, and a second status file: at the repository root or anywhere under docs/ outside docs/plans/
  const walk = (dir, depth, fn) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth > 0 && depth < 6 && !e.name.startsWith('.') && !PLAN_SKIP_DIRS.has(e.name.toLowerCase())) walk(f, depth + 1, fn); }
      else fn(f, e.name.toLowerCase());
    }
  };
  const plansDir = path.join(docs, 'plans');
  const statusFiles = [];
  const visit = (f, name) => {
    if (OLD_HOMES.has(name)) add(f, null, 'an old home: move it into docs/roadmap.md or docs/checks.md (§15)');
    const lower = f.toLowerCase();
    if (/(^|[-_])status\.md$/.test(name) && lower !== statusFile.toLowerCase()
      && ![plansDir, path.join(docs, 'adr')].some(d => lower.startsWith(d.toLowerCase() + path.sep))) statusFiles.push(f);
  };
  walk(repo, 0, visit);       // the root's own files only
  walk(docs, 1, visit);
  for (const f of statusFiles) add(f, null, 'a second status file: docs/status.md is the only one (§3.2)');
  if (fs.existsSync(path.join(plansDir, '_template'))) add(path.join(plansDir, '_template'), null, 'an old home: the templates live in ~/.claude/workflow/templates/');

  // ADRs (§3.5)
  const adrDir = path.join(docs, 'adr');
  let adrs = [];
  try { adrs = fs.readdirSync(adrDir); } catch {}
  for (const n of adrs) {
    const f = path.join(adrDir, n);
    if (!/^\d{4}-[a-z0-9]+(-[a-z0-9]+)*\.md$/.test(n)) add(f, null, 'not named NNNN-<kebab-title>.md');
    else if (!/^Status:/m.test(read(f) || '')) add(f, null, 'no Status: line');
  }

  // Plans (§4–§6)
  const plansSeen = [];
  let ents = [];
  try { ents = fs.readdirSync(plansDir, { withFileTypes: true }); } catch {}
  const boards = new Map();   // slug -> { ids, file }
  const checks = [];
  for (const e of ents) {
    const p = path.join(plansDir, e.name);
    if (e.isDirectory()) {
      if (e.name.toLowerCase() === '_template') continue;
      const st = path.join(p, 'STATUS.md'), pl = path.join(p, 'PLAN.md');
      if (!fs.existsSync(pl)) add(p, null, 'a phased plan folder without PLAN.md');
      if (!fs.existsSync(st)) { add(p, null, 'a phased plan folder without STATUS.md'); continue; }
      checks.push({ slug: e.name, file: st, headerFile: pl, phased: true });
    } else if (e.isFile() && /\.md$/i.test(e.name)) checks.push({ slug: e.name.slice(0, -3), file: p, headerFile: p, phased: false });
    else if (e.isFile()) add(p, null, 'not a plan: docs/plans/ holds <slug>.md files and <slug>/ folders');
  }
  for (const c of checks) {
    const text = read(c.file) ?? '';
    plansSeen.push(rel(c.file));
    const header = (read(c.headerFile) ?? '').split(/\r?\n/).find(l => /^Status:/.test(l));
    const hm = header && /^Status: \*\*(proposed|approved|building|verified)\*\*(\s+(\d{4}-\d{2}-\d{2}))?/.exec(header);
    if (!hm) add(c.headerFile, null, header ? `header line "${truncate(header, 80)}" does not start with Status: **proposed|approved|building|verified**` : 'no header line (Status: **<state>**)');
    else if (hm[1] === 'approved' && !hm[3]) add(c.headerFile, null, 'approved without its date (Status: **approved** yyyy-MM-dd)');
    const lines = text.split(/\r?\n/);
    const board = mdTableAfter(lines, 'Board');
    if (!board) { add(c.file, null, 'no "## Board"'); continue; }
    if (board.header !== BOARD_HEADER) add(c.file, board.headerLine, `board header is "${truncate(board.header ?? '(none)', 120)}"`);
    boards.set(c.slug.toLowerCase(), { ids: board.rows.map(r => cleanCell(r.cells[0])), c, board, lines, text });
  }
  for (const { ids, c, board, lines, text } of boards.values()) {
    if (board.header !== BOARD_HEADER) continue;   // the columns can't be trusted; the header problem says enough
    const dup = ids.filter((x, k) => ids.indexOf(x) !== k);
    for (const d of new Set(dup)) add(c.file, null, `ID ${d} is used more than once`);
    if (c.phased && ids[0] !== 'P0') add(c.file, board.rows[0]?.line ?? board.headerLine, 'a phased plan starts with P0');
    for (const { cells, line } of board.rows) {
      const [id, , agent, deps, me, state, since, handoff] = cells.map(x => x ?? '');
      const cid = cleanCell(id);
      if (cells.length !== 9) add(c.file, line, `${cid}: ${cells.length} cells, not 9`);
      if (!LINT_ID.test(cid)) add(c.file, line, `ID "${cid}" is not P<n>, P<n>-<nn>, O-<n> or <PREFIX>-<n>`);
      if (!LINT_STATES.has(state.trim())) add(c.file, line, `${cid}: state "${state}" is not one word from §6`);
      if (since.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(since.trim())) add(c.file, line, `${cid}: since "${since}" is not yyyy-MM-dd`);
      if (deps.trim() !== '—') {
        if (!deps.trim()) add(c.file, line, `${cid}: Depends on is empty (write — for none)`);
        else for (const d0 of deps.split(/,\s*/)) {
          const d = d0.replace(/[`*]/g, '').trim();
          const range = /^(.+?)\s*(?:–| to )\s*(.+)$/.exec(d);
          for (const x of range ? [range[1], range[2]] : [d]) {
            const other = /^([\w.-]+)\/(.+)$/.exec(x);
            if (other) {
              const b = boards.get(other[1].toLowerCase());
              if (b && !b.ids.includes(other[2])) add(c.file, line, `${cid} depends on ${x}, which ${other[1]} does not have`);
            } else if (!ids.includes(x)) add(c.file, line, `${cid} depends on unknown "${x}"${/\s-\s|—/.test(d) ? ' (write ranges as A–B)' : ''}`);
          }
        }
      }
      if (me.trim() !== '—' && !LINT_MODEL_EFFORT.test(me.trim())) add(c.file, line, `${cid}: Model / effort "${me}" is not "<Model> / <low|medium|high|xhigh|max>" or —`);
      if (c.phased && ['handed-off', 'accepted', 'bounced'].includes(state.trim()) && !/^(human|owner)$/.test(cleanCell(agent))) {
        const m = /\]\(([^)]+)\)/.exec(handoff);
        if (!m || !fs.existsSync(path.join(path.dirname(c.file), decodeURI(m[1])))) add(c.file, line, `${cid} is ${state.trim()} but its handoff link "${handoff}" does not resolve`);
      }
    }
    for (const [title, want] of Object.entries(LINT_TABLES)) {
      const t = mdTableAfter(lines, title);
      if (t && t.header && t.header !== want) add(c.file, t.headerLine, `${title} header is "${truncate(t.header, 120)}", not "${want}"`);
    }
    if (c.phased) {
      const h2 = mdHeadings(text).filter(h => h.level === 2).map(h => h.title.trim());
      if (!h2.includes('Decisions (P0)')) add(c.file, null, 'no "## Decisions (P0)"');
      else if (!/^##\s+Decisions \(P0\)\s*$[\s\S]*?^\s*- \[[ x]\] /m.test(text)) add(c.file, null, '"## Decisions (P0)" has no - [ ] or - [x] lines');
      for (const s of ['Log', 'Kickoff']) if (!h2.includes(s)) add(c.file, null, `no "## ${s}"`);
      if (h2.includes('Protocol')) add(c.file, null, 'copies the protocol: point to the workflow-run skill instead (§4.3)');
    }
  }

  // User level (§2), once per PC
  const user = [];
  const home = path.join(HOME, '.claude');
  if (!/^@~\/\.claude\/workflow\/CLAUDE\.user\.md\s*$/m.test(read(path.join(home, 'CLAUDE.md')) ?? '')) user.push('~/.claude/CLAUDE.md does not import @~/.claude/workflow/CLAUDE.user.md');
  for (const n of ['workflow', 'skills/workflow-plan', 'skills/workflow-run', 'skills/workflow-close']) {
    if (!fs.existsSync(path.join(home, n))) user.push(`~/.claude/${n} is not linked (node workflow/kit.mjs install)`);
  }
  return { repo, plans: plansSeen, problems, user };
}

function lint(args) {
  const json = args.includes('--json');
  const repo = path.resolve(args.find(a => !a.startsWith('--')) || '.');
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) fail(`Not a folder: ${repo}`);
  const r = lintRepo(repo);
  if (json) console.log(JSON.stringify(r, null, 1));
  else {
    console.log(`Lint ${r.repo} against the agent workflow standard`);
    console.log(`Plans: ${r.plans.length ? r.plans.join(', ') : 'none'}`);
    if (!r.problems.length) console.log('Repository: clean');
    else {
      console.log(`Repository: ${r.problems.length} problem${r.problems.length === 1 ? '' : 's'}`);
      for (const p of r.problems) console.log(`  ${p.file}${p.line ? `:${p.line}` : ''}  ${p.text}`);
    }
    console.log(r.user.length ? `User level (this PC):\n${r.user.map(u => `  ${u}`).join('\n')}` : 'User level (this PC): linked');
  }
  process.exit(r.problems.length ? 1 : 0);
}

// =====================================================================================================================
// selftest: the normaliser, redaction, summaries and the plan parser, without touching anything on disk.

function selftest() {
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

  check('install: our group for PreToolUse', ourGroup('PreToolUse'), { matcher: '*', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 2, async: true }] });
  check('install: SessionEnd runs synchronously', ourGroup('SessionEnd'), { hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 2 }] });
  check('install: removeOurs keeps other hooks', removeOurs([{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }, ourGroup('Stop').hooks[0]] }, ourGroup('Stop')]),
    [{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] }]);
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}

// =====================================================================================================================
// Command line

const HELP = `Claude HUD ${VERSION}: a live dashboard of every Claude Code session on this PC.

  node hud.mjs                 serve on http://127.0.0.1:${PORT} (HUD_PORT picks another port)
  node hud.mjs --demo          serve simulated sessions, subagents, plans and events
  node hud.mjs --demo=dense    the same with 24 sessions
  node hud.mjs install         add the HUD's hooks to ~/.claude/settings.json (backup first; safe to repeat)
  node hud.mjs uninstall       remove only the HUD's hooks from ~/.claude/settings.json
  node hud.mjs autostart on|off  start the HUD at logon (Task Scheduler, no window), or stop doing so
  node hud.mjs lint [repo] [--json]  check a repository against the agent workflow standard
  node hud.mjs selftest        check the model normaliser, redaction and plan parser
  node hud.mjs hook            the hook forwarder (Claude Code runs this; it prints nothing)`;

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'hook') runHook();
else if (!cmd) serve(null);
else if (cmd === '--demo' || cmd === '--demo=dense') serve(cmd === '--demo=dense' ? 'dense' : 'demo');
else if (cmd === 'install') install();
else if (cmd === 'uninstall') uninstall();
else if (cmd === 'autostart') autostart(arg);
else if (cmd === 'lint') lint(process.argv.slice(3));
else if (cmd === 'selftest') selftest();
else if (cmd === 'help' || cmd === '--help' || cmd === '-h') console.log(HELP);
else { console.error(`Unknown command: ${cmd}\n\n${HELP}`); process.exit(1); }

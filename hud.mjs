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
const HOSTNAME = os.hostname();          // labels the hub of the network view
const PORT = portFrom(process.env.HUD_PORT) ?? 7777;
const LAN = process.argv.includes('--lan') || process.env.HUD_LAN === '1';   // D15, off by default
const LOOPBACK = '127.0.0.1';            // where the hook forwarder connects
const HOST = LAN ? '0.0.0.0' : LOOPBACK; // what the server listens on
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

/**
 * Every Claude Code folder the HUD watches: the one above, then each in HUD_CLAUDE_DIRS (separated like PATH), then
 * every `~/.claude-*` that holds `sessions` or `projects` (a second install run with its own CLAUDE_CONFIG_DIR, e.g.
 * `~/.claude-bedrock`). Found once at start. `install`, `uninstall` and the HUD's start-up hook check cover all of them.
 */
const ROOTS = (() => {
  const found = new Map();
  const add = (dir, json) => {
    const d = path.resolve(dir);
    if (!found.has(d.toLowerCase())) {
      found.set(d.toLowerCase(), { dir: d, sessions: path.join(d, 'sessions'), projects: path.join(d, 'projects'),
        settings: path.join(d, 'settings.json'), json: json ?? path.join(d, '.claude.json'), bedrock: false, hooks: false });
    }
  };
  add(CLAUDE_DIR, CLAUDE_JSON);
  for (const d of (process.env.HUD_CLAUDE_DIRS ?? '').split(path.delimiter)) if (d.trim()) add(d.trim());
  try {
    for (const e of fs.readdirSync(HOME, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^\.claude-[\w.-]+$/.test(e.name)) continue;
      const d = path.join(HOME, e.name);
      if (fs.existsSync(path.join(d, 'sessions')) || fs.existsSync(path.join(d, 'projects'))) add(d);
    }
  } catch {}
  return [...found.values()];
})();
const rootOf = file => { const k = file.toLowerCase(); return ROOTS.find(r => k.startsWith(r.projects.toLowerCase() + path.sep)) ?? null; };

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

/**
 * Provider for one agent: its model id, then what its transcript shows (`info.bedrock`), then the flag of the Claude
 * Code folder it lives in (`info.rootBedrock`: `env.CLAUDE_CODE_USE_BEDROCK` in that folder's settings.json, the only key of that block read).
 */
function modelInfo(raw, info) {
  const m = normalizeModel(raw);
  if (m.provider === 'anthropic' && (info?.bedrock || info?.rootBedrock)) m.provider = 'bedrock';
  return m;
}
/**
 * The model id as sent. On Bedrock, `message.model` is the plain name (`claude-opus-5-5`) and only the request
 * carries the Bedrock id (`us.anthropic.claude-opus-5-5`), so the request id is used when both name the same model.
 */
function rawModel(info) {
  if (!info) return null;
  const req = info.requestModel, got = info.modelRaw;
  if (!got) return req;
  return req && normalizeModel(req).model === normalizeModel(got).model ? req : got;
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
      host: LOOPBACK, port: PORT, path: '/event', method: 'POST', agent: false,
      headers: { host: `${LOOPBACK}:${PORT}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
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
let account = null;             // 5-hour and weekly usage from Claude Code's own cache in ~/.claude.json (of the first folder that has one)
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
    tail: null, transcriptPath: null, lastFind: 0, root: null,
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
    title: null, customTitle: null, modelRaw: null, requestModel: null, bedrock: false, rootBedrock: false,
    effort: null, branch: null, cwd: null, sessionId: null, agentId: null,
    tokens: zero(), byDay: new Map(), msgs: new Map(), lastUsed: 0, firstTs: 0, lastTs: 0,
    toolIds: new Set(), openTools: new Map(), agentCalls: new Map(),
  };
}
function getTail(file) {
  const key = file.toLowerCase();
  let t = tails.get(key);
  if (!t) { t = { file, offset: 0, rest: Buffer.alloc(0), reading: false, again: false, info: newInfo(), owner: null }; tails.set(key, t); }
  t.info.rootBedrock = !!rootOf(file)?.bedrock;   // read again each time: the flag can change while the HUD runs
  return t;
}

// `api-request` lines are small and read for their model id; `api-request-blob` / `-shape` lines (up to ~200 KB) are not.
const API_REQUEST_PREFIX = '{"type":"api-request",';
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
  if (line.startsWith(API_REQUEST_PREFIX)) { onApiRequestLine(t, line); return; }
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

function onApiRequestLine(t, line) {
  if (line.length > 65536) return;
  let j;
  try { j = JSON.parse(line); } catch { return; }
  const model = j?.params?.model;
  if (typeof model !== 'string' || !model || model.length > 200) return;
  t.info.requestModel = model;
  if (normalizeModel(model).provider === 'bedrock') t.info.bedrock = true;
}

function onAssistantLine(t, j, ts) {
  const info = t.info, m = j.message;
  if (!isObj(m)) return;
  if (typeof m.model === 'string' && m.model && !m.model.startsWith('<')) info.modelRaw = m.model;
  if (typeof m.id === 'string' && m.id.startsWith('msg_bdrk_')) info.bedrock = true;   // Bedrock message ids, whatever the model id says
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
    for (const r of s.root ? [s.root, ...ROOTS.filter(x => x !== s.root)] : ROOTS) {
      const f = path.join(r.projects, slugFor(s.cwd), `${s.id}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  }
  if (Date.now() - s.lastFind < 10_000) return null;
  s.lastFind = Date.now();
  for (const r of ROOTS) {
    let dirs = [];
    try { dirs = fs.readdirSync(r.projects); } catch {}
    for (const d of dirs) {
      const f = path.join(r.projects, d, `${s.id}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
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
    const seen = new Set();
    const entries = [];
    for (const root of ROOTS) {
      try { for (const n of await fsp.readdir(root.sessions)) entries.push([root, n]); registryReadable = true; } catch {}
    }
    for (const [root, n] of entries) {
      if (!/^\d+\.json$/.test(n)) continue;              // <pid>.json only, never *.key
      const j = await readJson(path.join(root.sessions, n));
      if (!isObj(j) || typeof j.sessionId !== 'string') continue;
      const pid = Number.isInteger(j.pid) ? j.pid : Number(n.slice(0, -5));
      seen.add(j.sessionId);
      const s = getSession(j.sessionId);
      const isNew = !s.inRegistry;
      s.inRegistry = true;
      s.root = root;
      // The same session id under a new process (resumed, or the editor window reloaded): it is running again.
      const relaunched = s.ended && s.pid !== pid && pidAlive(pid);
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
      if (relaunched) {
        reopenSession(s);
        s.chainChecked = false;
        queueChain(s);
        pushFeed(s, 'session', 'Session resumed', Date.now(), `resume:${s.id}:${pid}`);
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

function onProjectsChange(root, rel) {
  if (!rel) return;
  const parts = String(rel).split(/[\\/]/);
  const base = parts[parts.length - 1];
  const file = path.join(root.projects, ...parts);
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
  const dirs = [];
  for (const r of ROOTS) {
    try { for (const d of await fsp.readdir(r.projects, { withFileTypes: true })) dirs.push([r, d]); } catch {}
  }
  for (const [root, d] of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root.projects, d.name);
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

async function readAccount() {
  let u = null, halfWritten = false;
  for (const root of ROOTS) {      // a Bedrock folder has no subscription usage; the first folder that has it is the account
    try { u = JSON.parse((await fsp.readFile(root.json, 'utf8')).replace(/^\uFEFF/, ''))?.cachedUsageUtilization; } catch (e) { if (e instanceof SyntaxError) halfWritten = true; }
    if (isObj(u)) break;
  }
  if (!isObj(u) && halfWritten) return;   // keep the last value
  const win = w => {
    if (!isObj(w) || !Number.isFinite(w.utilization)) return null;
    const resetsAt = Date.parse(w.resets_at) || null;
    return { pct: resetsAt && resetsAt < Date.now() ? null : Math.round(w.utilization * 10) / 10, resetsAt };
  };
  account = isObj(u) ? { fiveHour: win(u.utilization?.five_hour), sevenDay: win(u.utilization?.seven_day), fetchedAt: num(u.fetchedAtMs) || null } : null;
  scheduleState();
}
function readSettingsFlags() {
  for (const root of ROOTS) {
    const j = readJsonSync(root.settings);
    const v = j?.env?.CLAUDE_CODE_USE_BEDROCK;
    root.bedrock = v === true || v === 1 || /^(1|true|yes)$/i.test(String(v ?? ''));
    root.hooks = isObj(j?.hooks) && Object.values(j.hooks).some(arr => Array.isArray(arr) && arr.some(g => Array.isArray(g?.hooks) && g.hooks.some(isOurHook)));
  }
  hooksInstalled = ROOTS.every(r => r.hooks);   // one folder without the hooks is enough to show "Hooks off"
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
  const raw = rawModel(info) || sub.modelHint;
  const mi = modelInfo(raw, info);
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
  const raw = rawModel(info) || s.hookModel;
  const mi = modelInfo(raw, info);
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
  // A plan is being worked on when a busy session runs in its project; plans also carry when their board last changed.
  const busyBy = new Map();
  for (const s of list) if (s.status === 'busy' || s.status === 'needs-you') busyBy.set(s.project, (busyBy.get(s.project) || 0) + 1);
  const planList = [...plans.values()].map(v => ({ ...v.plan, working: busyBy.get(v.plan.project) || 0, touchedAt: Math.round(v.mtime) }))
    .sort((a, b) => a.project.localeCompare(b.project) || a.title.localeCompare(b.title));
  return {
    now, uptime: now - hudStartedAt, demo: false, version: VERSION, host: HOSTNAME, hooksInstalled,
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

// DNS-rebinding guard. In LAN mode (D15) the page is also reached by this PC's IP address or name. A rebinding page
// can only make the browser send its own domain name as Host, so any other name stays refused.
function hostAllowed(host, lan = LAN) {
  if (ALLOWED_HOSTS.has(host)) return true;
  if (!lan) return false;
  const m = /^(\[[0-9a-f:.]+\]|[^\s:/[\]]+)(?::(\d{1,5}))?$/i.exec(host);
  if (!m || Number(m[2] ?? 80) !== PORT) return false;
  const name = m[1].toLowerCase(), self = HOSTNAME.toLowerCase();
  return name === self || name === `${self}.local` || name.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(name);
}
const isLoopback = addr => typeof addr === 'string' && /^(::1|(::ffff:)?127\.\d+\.\d+\.\d+)$/i.test(addr);

function handle(req, res) {
  try {
    if (!hostAllowed(req.headers.host || '')) return send(res, 403, 'Forbidden\n');
    const p = new URL(req.url, 'http://h').pathname;
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (p === '/') return send(res, 200, pageHtml(), PAGE_HEADERS);
      if (p === '/design') return send(res, 200, designHtml(), PAGE_HEADERS);
      if (p === '/api/state') return sendJson(res, redactDeep(snapshot()));
      if (p === '/api/health') {
        const snap = snapshot();
        return sendJson(res, { ok: true, uptime: Date.now() - hudStartedAt, sessions: snap.totals.sessions, version: VERSION });
      }
      if (p === '/api/stream') return openStream(req, res);
    }
    if (req.method === 'POST' && (p === '/event' || (p === '/usage' && ACCEPT_USAGE))) {
      // Other devices only look (D15): a payload names a transcript file to read, so only this PC may report.
      if (!isLoopback(req.socket.remoteAddress)) return send(res, 403, 'Forbidden\n');
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

// =====================================================================================================================
// The HUD page and the component gallery (PLAN §6, docs/DESIGN.md)
//
// One stylesheet (HUD_CSS) and one client library (hudClient) serve both `/` and `/design`, so the gallery shows
// exactly what the page draws. The client code is written as plain functions here and inlined with
// Function.prototype.toString: Node checks its syntax, and nothing needs escaping. Data reaches the DOM only through
// textContent and attributes, never innerHTML.

const HUD_FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
  + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=JetBrains+Mono:wght@400;600&family=Orbitron:wght@500;700&family=Rajdhani:wght@600;700&display=swap">';

const HUD_CSS = `
@property --hl { syntax: '<color>'; inherits: true; initial-value: rgba(41, 230, 255, .22); }
@property --sc { syntax: '<color>'; inherits: true; initial-value: #29e6ff; }
:root {
  --void: #04070d; --deep: #08111c; --glass: rgba(16, 34, 52, .55);
  --arc: #29e6ff; --arc-35: rgba(41, 230, 255, .35); --arc-15: rgba(41, 230, 255, .15); --arc-06: rgba(41, 230, 255, .06);
  --line: rgba(41, 230, 255, .22); --bracket: rgba(41, 230, 255, .6);
  --amber: #ffb547; --alert: #ff4d5e; --ok: #4dffa6; --agent: #b28cff;
  --ink: #d6f3ff; --ink-2: rgba(214, 243, 255, .68); --ink-3: rgba(214, 243, 255, .42);
  --f-display: Orbitron, system-ui, sans-serif; --f-label: Rajdhani, system-ui, sans-serif;
  --f-body: Inter, system-ui, sans-serif; --f-mono: 'JetBrains Mono', Consolas, monospace;
  --ease: cubic-bezier(.2, .8, .2, 1);
  --hl: var(--line); --sc: var(--arc);
  color-scheme: dark;
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body { background: var(--void); color: var(--ink); font: 400 13px/20px var(--f-body); -webkit-font-smoothing: antialiased; overflow-x: hidden; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; margin: 0; cursor: pointer; text-align: inherit; }
h1, h2, h3, h4, p, ol, ul { margin: 0; padding: 0; }
ol, ul { list-style: none; }
:focus-visible { outline: 2px solid var(--arc); outline-offset: 2px; }
[hidden] { display: none !important; }
* { scrollbar-width: thin; scrollbar-color: var(--arc-15) transparent; }

/* ---- type ---- */
.label { font: 600 11px/16px var(--f-label); letter-spacing: .14em; text-transform: uppercase; }
.label-13 { font: 600 13px/16px var(--f-label); letter-spacing: .14em; text-transform: uppercase; }
.mono { font-family: var(--f-mono); font-variant-numeric: tabular-nums; }
.trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.c-arc { color: var(--arc); } .c-amber { color: var(--amber); } .c-alert { color: var(--alert); }
.c-ok { color: var(--ok); } .c-agent { color: var(--agent); } .c-dim { color: var(--ink-3); } .c-ink2 { color: var(--ink-2); }

/* ---- icons and status glyphs ---- */
.ic { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.ic * { vector-effect: non-scaling-stroke; }
.gl { width: 14px; height: 14px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; overflow: visible; }
.gl * { vector-effect: non-scaling-stroke; }
.gl .gf { fill: currentColor; stroke: none; }
.gl.spin { animation: spin 1.2s linear infinite; }

/* ---- background (layer 1 of depth) ---- */
.bg { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
.bg > div { position: absolute; inset: -48px; }
.bg-grid { opacity: .04; background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='48.5'%3E%3Cpath d='M14 0L28 8.08V24.25L14 32.33L0 24.25V8.08Z M14 32.33V48.5' fill='none' stroke='%2329e6ff' stroke-width='1'/%3E%3C/svg%3E") 0 0 / 28px 48.5px; }
.bg-vig { background: radial-gradient(ellipse 80% 70% at 50% 42%, transparent 35%, rgba(0, 0, 0, .6) 100%), radial-gradient(ellipse 60% 50% at 50% 0%, rgba(41, 230, 255, .05), transparent 70%); }
.bg-shim, .bg-dots { display: none; }
.scanlines { position: fixed; inset: 0; z-index: 60; pointer-events: none; background: repeating-linear-gradient(0deg, rgba(214, 243, 255, .03) 0 1px, transparent 1px 4px); }

/* ---- panels: glass, cut corners, hairline, corner brackets ---- */
.cutbox {
  clip-path: polygon(12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%, 0 12px);
  background:
    linear-gradient(var(--hl), var(--hl)) 12px 0 / calc(100% - 12px) 1px no-repeat,
    linear-gradient(var(--hl), var(--hl)) 0 12px / 1px calc(100% - 12px) no-repeat,
    linear-gradient(var(--hl), var(--hl)) 100% 0 / 1px calc(100% - 12px) no-repeat,
    linear-gradient(var(--hl), var(--hl)) 0 100% / calc(100% - 12px) 1px no-repeat,
    linear-gradient(135deg, transparent 50%, var(--hl) 50% calc(50% + 1px), transparent calc(50% + 1px)) 0 0 / 12px 12px no-repeat,
    linear-gradient(135deg, transparent calc(50% - 1px), var(--hl) calc(50% - 1px) 50%, transparent 50%) 100% 100% / 12px 12px no-repeat;
}
.panel { position: relative; min-width: 0; min-height: 0; display: flex; flex-direction: column; box-shadow: 0 0 40px rgba(41, 230, 255, .06); }
.panel::before, .panel::after { content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 2; }
.panel::before { background:
  linear-gradient(135deg, transparent 50%, var(--bracket) 50% calc(50% + 2px), transparent calc(50% + 2px)) 0 0 / 12px 12px no-repeat,
  linear-gradient(var(--bracket), var(--bracket)) 12px 0 / 16px 2px no-repeat,
  linear-gradient(var(--bracket), var(--bracket)) 0 12px / 2px 16px no-repeat,
  linear-gradient(135deg, transparent calc(50% - 2px), var(--bracket) calc(50% - 2px) 50%, transparent 50%) 100% 100% / 12px 12px no-repeat,
  linear-gradient(var(--bracket), var(--bracket)) right 12px bottom 0 / 16px 2px no-repeat,
  linear-gradient(var(--bracket), var(--bracket)) right 0 bottom 12px / 2px 16px no-repeat; }
.panel::after { background:
  linear-gradient(var(--bracket), var(--bracket)) right 0 top 0 / 16px 2px no-repeat,
  linear-gradient(var(--bracket), var(--bracket)) right 0 top 0 / 2px 16px no-repeat,
  linear-gradient(var(--bracket), var(--bracket)) left 0 bottom 0 / 16px 2px no-repeat,
  linear-gradient(var(--bracket), var(--bracket)) left 0 bottom 0 / 2px 16px no-repeat; }
.pb { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 20px; background-color: var(--glass); backdrop-filter: blur(14px); box-shadow: inset 0 0 32px rgba(41, 230, 255, .05); }
.ph { display: flex; align-items: center; gap: 12px; min-height: 24px; margin-bottom: 16px; flex: none; }
.ph:empty { display: none; }
.pt { font: 500 13px/16px var(--f-display); letter-spacing: .2em; text-transform: uppercase; color: var(--ink); white-space: nowrap; }
.ps { color: var(--ink-2); font-size: 13px; min-width: 0; }
.pc { position: relative; flex: 1; min-height: 0; overflow: auto; margin: 0 -8px; padding: 0 8px; }
.perr { position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 20px; text-align: center; background: rgba(8, 17, 28, .9); color: var(--ink-2); }
.perr .ic { width: 24px; height: 24px; color: var(--alert); }
.perr-t { color: var(--ink); font-weight: 600; }
.perr-m { font: 400 11px/16px var(--f-mono); color: var(--ink-2); max-width: 100%; }
/* "more below": pinned to the bottom of a scrolling panel, over a fade; takes no space of its own */
.more { position: sticky; bottom: 0; z-index: 3; flex: none; display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; margin-top: -32px; padding: 0 12px; background: rgba(8, 17, 28, .94); border-top: 1px solid var(--arc-35); font-size: 13px; line-height: 20px; color: var(--ink-2); text-align: left; white-space: nowrap; }
.more::before { content: ""; position: absolute; left: 0; right: 0; bottom: calc(100% + 1px); height: 24px; background: linear-gradient(rgba(8, 17, 28, 0), rgba(8, 17, 28, .9)); pointer-events: none; }
.more .ic { width: 14px; height: 14px; flex: none; color: var(--arc); }
.more .label { color: var(--ink); flex: none; }
.more-d { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.more:hover { background: rgba(12, 30, 44, .97); }
.col-l > .more { height: 24px; margin-top: -40px; font-size: 11px; line-height: 16px; }   /* a slim bar: the vitals above it stay readable */
.col-l > .more::before { display: none; }

/* ---- buttons, chips, badges ---- */
.chip { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px; border-radius: 10px; border: 1px solid var(--line); font: 600 11px/16px var(--f-label); letter-spacing: .14em; text-transform: uppercase; color: var(--ink-2); white-space: nowrap; min-width: 0; flex: none; }
.chip .ic { width: 12px; height: 12px; }
.chip > .trunc { max-width: 160px; }
.chip.prov[data-p=anthropic] { color: var(--ink); border-color: var(--arc-35); }
.chip.prov[data-p=bedrock] { color: var(--ink); border-color: rgba(214, 243, 255, .35); border-style: dashed; }
.chip.prov[data-p=unknown] { color: var(--ink-3); }
.chip.warn { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 45%, transparent); }
.chip.demo { color: var(--agent); border-color: color-mix(in srgb, var(--agent) 45%, transparent); }
button.chip:hover { border-color: var(--arc-35); color: var(--ink); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 32px; padding: 0 16px; border-radius: 16px; border: 1px solid var(--arc-35); color: var(--arc); background: var(--arc-06); font: 600 13px/16px var(--f-label); letter-spacing: .14em; text-transform: uppercase; transition: background-color .15s, border-color .15s; }
.btn:hover { background: var(--arc-15); }
.seg { display: inline-flex; height: 28px; padding: 2px; border-radius: 14px; border: 1px solid var(--line); margin-left: auto; flex: none; }
.seg button { display: inline-flex; align-items: center; gap: 8px; padding: 0 12px; border-radius: 12px; color: var(--ink-2); font: 600 11px/16px var(--f-label); letter-spacing: .14em; text-transform: uppercase; transition: color .2s, background-color .2s; }
.seg button[aria-pressed=true] { color: var(--void); background: var(--arc); }
.seg button:not([aria-pressed=true]):hover { color: var(--ink); }
.seg .ic { width: 14px; height: 14px; }
.tgl { position: relative; width: 32px; height: 32px; border-radius: 16px; display: grid; place-items: center; border: 1px solid var(--line); color: var(--ink-3); transition: color .3s, background-color .3s, border-color .3s, box-shadow .3s; }
.tgl:hover { color: var(--ink); border-color: var(--arc-35); }
.tgl[aria-pressed=true] { color: var(--arc); border-color: var(--arc-35); background: var(--arc-15); box-shadow: 0 0 12px rgba(41, 230, 255, .25); }
.tgl .slash { position: absolute; inset: 0; margin: auto; width: 18px; height: 18px; opacity: 1; transition: opacity .2s; }
.tgl[aria-pressed=true] .slash { opacity: 0; }

/* ---- status tag: glyph + word (+ timer) ---- */
.stag { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; flex: none; transition: color .3s var(--ease); }
.stag[data-c=alert] { color: var(--alert); } .stag[data-c=amber] { color: var(--amber); } .stag[data-c=arc] { color: var(--arc); }
.stag[data-c=ok] { color: var(--ok); } .stag[data-c=agent] { color: var(--agent); } .stag[data-c=dim] { color: var(--ink-3); }
.stag-x { font-size: 11px; letter-spacing: 0; color: var(--ink-2); }

/* ---- odometer ---- */
.odo { display: inline-flex; white-space: nowrap; font-variant-numeric: tabular-nums; }
.odo-s { display: inline-block; height: 1em; line-height: 1em; overflow: hidden; text-align: center; vertical-align: top; }
.odo-d { width: 1ch; }
.odo-strip { display: block; transition: transform .3s var(--ease); }
.odo-strip > span { display: block; height: 1em; }

/* ---- meters ---- */
.meters { display: grid; grid-template-columns: 88px minmax(0, 1fr) 64px minmax(0, max-content); gap: 4px 12px; align-items: center; }
.meter { display: contents; }
.ml { color: var(--ink-3); }
.mv { text-align: right; font-size: 13px; color: var(--ink); white-space: nowrap; }
.mn { font-size: 11px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.msplit { grid-column: 2 / -1; font-size: 11px; line-height: 16px; color: var(--ink-2); margin-top: -2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar { position: relative; display: block; height: 4px; background: rgba(214, 243, 255, .08); overflow: hidden; }
.bar-f { position: absolute; inset: 0; transform-origin: 0 50%; transform: scaleX(0); transition: transform .4s var(--ease), background-color .3s; }
.seg-out { background: var(--arc); } .seg-cw { background: color-mix(in srgb, var(--arc) 55%, transparent); } .seg-in { background: var(--ink); }
.bar-cr .bar-f { background: rgba(214, 243, 255, .3); }
.bar-ctx .bar-f { background: var(--arc); }
.m-ctx[data-lvl=warn] .bar-f { background: var(--amber); } .m-ctx[data-lvl=hot] .bar-f { background: var(--alert); }
.m-ctx[data-lvl=warn] .mv { color: var(--amber); } .m-ctx[data-lvl=hot] .mv { color: var(--alert); }
.m-ctx[data-lvl=none] .mv { color: var(--ink-3); }
.m-ctx[data-lvl=none] .bar { background: repeating-linear-gradient(90deg, rgba(214, 243, 255, .1) 0 4px, transparent 4px 8px); }
.bar-m { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(4, 7, 13, .9); }
.bar-m.m70 { left: 70%; } .bar-m.m90 { left: 90%; }
.bar-acct .bar-f { background: var(--arc); }

/* ---- session card ---- */
.cards { display: flex; flex-direction: column; gap: 12px; padding-bottom: 4px; container-type: inline-size; }
.card { position: relative; padding: 16px 20px; flex: none; background-color: rgba(8, 17, 28, .62); --sc: var(--arc); transition: --hl .3s var(--ease), --sc .3s var(--ease), opacity .3s var(--ease); }
.card[data-s=busy] { --sc: var(--amber); }
.card[data-s=needs-you] { --sc: var(--alert); --hl: rgba(255, 77, 94, .7); }
.card[data-s=ended] { --hl: rgba(214, 243, 255, .14); background-color: rgba(8, 17, 28, .3); }
.card[data-s=ended] .card-title { color: var(--ink-2); font-weight: 400; }
.card[data-s=ended] .card-chips, .card[data-s=ended] .meters, .card[data-s=ended] .subs, .card[data-s=ended] .card-br { display: none; }
.card-sum { display: none; margin-top: 4px; font: 400 11px/16px var(--f-mono); color: var(--ink-2); }
.card[data-s=ended] .card-sum { display: block; }
.card[data-s=ended] .now { margin-top: 8px; }
.card.flash { --hl: var(--arc); }
.card-scan { position: absolute; left: 0; top: 0; width: 40%; height: 1px; background: linear-gradient(90deg, transparent, var(--amber), transparent); transform: translateX(-100%); opacity: 0; pointer-events: none; }
.card[data-s=busy] .card-scan { opacity: 1; animation: scan 2.6s linear infinite; }
.card-glow { position: absolute; inset: 0; pointer-events: none; opacity: 0; box-shadow: inset 0 0 0 1px var(--alert), inset 0 0 28px rgba(255, 77, 94, .28); }
.card[data-s=needs-you] .card-glow { opacity: 1; animation: breathe 1.6s ease-in-out infinite; }
.card-h { display: flex; align-items: center; gap: 12px; height: 20px; }
.card-proj { display: flex; align-items: center; gap: 12px; color: var(--ink-2); min-width: 0; flex: 1; overflow: hidden; }
.card-proj .label { flex: none; max-width: 60%; }
.card-br { display: inline-flex; align-items: center; gap: 4px; min-width: 0; font-size: 11px; line-height: 16px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-br .ic { width: 12px; height: 12px; flex: none; }
.card-br > .trunc { min-width: 0; }
.card-tr { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; margin-top: 4px; min-width: 0; }
.card-tr .card-title { flex: 1 1 200px; margin-top: 0; min-width: 0; }
.card-tr .card-chips { margin-top: 0; flex: 0 1 auto; max-width: 100%; }
.card-chips > .chip { max-width: 100%; } .card-chips > button.chip { flex: 0 1 auto; } .card-chips > button.chip > .trunc { min-width: 0; }
.card-title { margin-top: 4px; font: 600 15px/20px var(--f-body); color: var(--ink); }
.card-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; min-width: 0; }
.card-meta { font-size: 11px; line-height: 16px; color: var(--ink-2); white-space: nowrap; flex: none; }
.now { display: flex; align-items: center; gap: 8px; height: 24px; margin-top: 8px; min-width: 0; }
.now-n { font: 600 13px/16px var(--f-label); letter-spacing: .08em; flex: none; }
.now-s { font: 400 13px/20px var(--f-mono); color: var(--ink-2); flex: 1; }
.now-t { font: 400 13px/20px var(--f-mono); color: var(--ink); flex: none; margin-left: auto; padding-left: 8px; }
.now .ic { color: var(--sc); }
.now[data-k=needs] { color: var(--alert); }
.now[data-k=needs] .now-n { font: 600 13px/20px var(--f-body); letter-spacing: 0; }
.now[data-k=needs] .now-t { color: var(--alert); }
.now[data-k=idle], .now[data-k=ended], .now[data-k=think] { color: var(--ink-2); }
.now[data-k=fresh] { color: var(--ok); }
.now[data-k=fresh] .ic { color: var(--ok); }
.card .meters { margin-top: 8px; }
.subs { margin-top: 12px; padding-top: 8px; border-top: 1px solid rgba(41, 230, 255, .12); display: flex; flex-direction: column; }
.sub { position: relative; display: grid; grid-template-columns: 14px minmax(0, 1fr) 72px 48px 40px 96px; gap: 8px; align-items: center; height: 28px; padding-left: calc((var(--d, 1) - 1) * 20px); color: var(--ink-2); }
.sub[data-d="2"]::before, .sub[data-d="3"]::before { content: ""; position: absolute; top: 4px; height: 10px; width: 10px; left: calc((var(--d) - 1) * 20px - 14px); border-left: 1px solid rgba(178, 140, 255, .4); border-bottom: 1px solid rgba(178, 140, 255, .4); }
.sub-g { color: var(--agent); display: flex; }
.sub[data-s=done] .sub-g { color: var(--ok); }
.sub.just-done .sub-g { animation: doneglow 1.5s var(--ease); }
.sub-n { color: var(--ink); }
.sub-n b { font: 600 13px/16px var(--f-label); letter-spacing: .08em; color: var(--agent); margin-right: 8px; }
.sub[data-s=done] .sub-n { color: var(--ink-2); }
.sub[data-s=done] .sub-n b { color: var(--ink-2); }
.sub-m { font: 400 11px/16px var(--f-mono); color: var(--ink-2); }
.sub-k, .sub-c { font: 400 11px/16px var(--f-mono); text-align: right; color: var(--ink-2); }
.sub-c[data-lvl=warn] { color: var(--amber); } .sub-c[data-lvl=hot] { color: var(--alert); }
.sub-s { justify-self: end; color: var(--agent); }
.sub[data-s=done] .sub-s { color: var(--ok); }
.sub-more { height: 24px; display: flex; align-items: center; color: var(--ink-2); padding-left: 22px; }
@container (max-width: 560px) {
  .sub { grid-template-columns: 14px minmax(0, 1fr) 48px 40px 96px; }
  .sub-m { display: none; }
  .card-meta { display: none; }
  .meters { grid-template-columns: 72px minmax(0, 1fr) 56px; }
  .meters .mn { display: none; }
}
@container (max-width: 380px) {
  .card { padding: 16px; }
  .sub { grid-template-columns: 14px minmax(0, 1fr) 40px 96px; }
  .sub-k { display: none; }
}

/* ---- compact rows (more than 8 sessions) ---- */
.cards.compact { gap: 0; }
.crow { position: relative; display: grid; grid-template-columns: 104px 112px minmax(0, 1fr) 64px 24px minmax(0, 168px) 48px 40px 28px; gap: 8px; align-items: center; height: 32px; padding: 0 12px; border-bottom: 1px solid rgba(41, 230, 255, .08); --sc: var(--arc); transition: --sc .3s, opacity .3s, background-color .3s; }
.crow:hover { background: var(--arc-06); }
.crow[data-s=busy] { --sc: var(--amber); }
.crow[data-s=needs-you] { --sc: var(--alert); background: rgba(255, 77, 94, .08); }
.crow[data-s=needs-you]::before { content: ""; position: absolute; left: 0; top: 4px; bottom: 4px; width: 2px; background: var(--alert); animation: breathe 1.6s ease-in-out infinite; }
.crow[data-s=ended] .cr-t { color: var(--ink-2); font-weight: 400; }
.crow[data-s=ended] .cr-v, .crow[data-s=ended] .cr-w .ic { opacity: .5; }
.crow.flash { background: var(--arc-15); }
.cr-p { color: var(--ink-2); }
.cr-t { color: var(--ink); font-weight: 600; }
.cr-m, .cr-k, .cr-c, .cr-n { font: 400 11px/16px var(--f-mono); color: var(--ink-2); }
.cr-k, .cr-c, .cr-n { text-align: right; }
.cr-c[data-lvl=warn] { color: var(--amber); } .cr-c[data-lvl=hot] { color: var(--alert); }
.cr-v { font: 600 11px/14px var(--f-label); text-align: center; color: var(--ink-2); border: 1px solid var(--line); width: 20px; height: 16px; justify-self: center; }
.cr-v[data-p=bedrock] { border-style: dashed; }
.cr-w { font: 400 11px/16px var(--f-mono); color: var(--ink-2); display: flex; align-items: center; gap: 8px; }
.cr-w .ic { width: 12px; height: 12px; color: var(--sc); }
.crow[data-s=needs-you] .cr-w { color: var(--alert); }
.cr-n { color: var(--agent); }
.cr-w { min-width: 0; overflow: hidden; }
.cr-w .trunc { flex: 1; }
.cr-w .mono { flex: none; }
@container (max-width: 720px) { .crow { grid-template-columns: 96px 80px minmax(0, 1.7fr) 24px minmax(0, 1fr) 48px 40px 24px; } .cr-m, .crow[data-s=needs-you] .cr-w .mono { display: none; } }   /* the time waiting stays in the banner and the card */
@container (max-width: 480px) { .crow { grid-template-columns: 96px minmax(0, 1fr) 48px 40px; height: 40px; } .cr-p, .cr-m, .cr-v, .cr-w, .cr-n { display: none; } }

/* ---- reactor ---- */
.reactor { position: relative; flex: none; margin: 0 auto; --rc: var(--arc); transition: opacity .6s var(--ease); }
.reactor[data-mode=alert] { --rc: var(--alert); }
.reactor[data-mode=idle] { opacity: .5; }
.r-l { position: absolute; inset: 0; }
.r-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; fill: none; }
.r-track { stroke: color-mix(in srgb, var(--rc) 22%, transparent); transition: stroke .3s; }
.r-tick { stroke: color-mix(in srgb, var(--rc) 45%, transparent); transition: stroke .3s; }
.r-arc { stroke: var(--rc); opacity: .7; transition: stroke .3s; }
.r-seg { stroke-linecap: butt; transition: stroke .3s; }
.r-seg[data-s=busy] { stroke: var(--amber); } .r-seg[data-s=needs-you] { stroke: var(--alert); } .r-seg[data-s=idle] { stroke: var(--arc-35); }
.r-slot { stroke: rgba(178, 140, 255, .14); transition: stroke .3s; }
.r-slot.on { stroke: var(--agent); }
.r-glow { position: absolute; inset: 14%; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--rc) 28%, transparent) 0%, color-mix(in srgb, var(--rc) 8%, transparent) 45%, transparent 70%); transition: background .3s; }
.reactor[data-mode=alert] .r-glow { animation: breathe 1.6s ease-in-out infinite; }
.r-core { position: absolute; inset: 31%; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--rc) 50%, transparent); box-shadow: 0 0 24px color-mix(in srgb, var(--rc) 35%, transparent), inset 0 0 24px color-mix(in srgb, var(--rc) 25%, transparent); transition: border-color .3s, box-shadow .3s; }
.r-num { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; pointer-events: none; }
.r-odo { font: 700 56px/56px var(--f-display); color: var(--ink); text-shadow: 0 0 18px color-mix(in srgb, var(--rc) 55%, transparent); }
.r-odo .odo-d { width: .9em; }
.r-lbl { margin-top: 4px; color: var(--ink-2); }
.reactor.mini .r-lbl, .reactor.mini .r-num { display: none; }

/* ---- vitals ---- */
.vitals { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 24px; }
.vital { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.vital.wide { grid-column: 1 / -1; }
.vital-l { color: var(--ink-3); }
.vital-n { font: 400 24px/28px var(--f-mono); color: var(--ink); }
.vital-n.alert { color: var(--alert); }
.vital-s { font: 400 11px/16px var(--f-mono); color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vital-s b { font-weight: 400; color: var(--ink); }
.vital-s .c-alert { color: var(--alert); }
.acct { display: grid; grid-template-columns: 56px minmax(0, 1fr) 40px auto; gap: 8px 12px; align-items: center; }
.acct .mn { font-size: 11px; }

/* ---- externals ---- */
.ext-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 4px 12px; align-items: center; padding: 8px 0; border-top: 1px solid rgba(41, 230, 255, .08); }
.ext-row:first-child { border-top: 0; padding-top: 0; }
.ext-n { color: var(--ink); font-weight: 600; }
.ext-k { font: 400 13px/20px var(--f-mono); color: var(--ink); text-align: right; }
.ext-d { grid-column: 2 / -1; font: 400 11px/16px var(--f-mono); color: var(--ink-2); display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
.ext-err { margin-top: 8px; font: 400 11px/16px var(--f-mono); color: var(--alert); }

/* ---- network ---- */
.net { position: relative; flex: 1; min-height: 360px; overflow: hidden; }
.net-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.net-nodes { position: absolute; inset: 0; pointer-events: none; }
.g-arc { fill: none; stroke: rgba(41, 230, 255, .2); stroke-width: 1.5; stroke-linecap: round; }
.g-tick { stroke: rgba(41, 230, 255, .45); stroke-width: 1.5; }
.g-lbl { fill: var(--ink-2); font: 600 11px var(--f-label); letter-spacing: .2em; text-transform: uppercase; }
.e { fill: none; stroke-linecap: round; transition: opacity .3s var(--ease), stroke .3s; }
.e-spoke { stroke: rgba(41, 230, 255, .16); stroke-width: 1; }
.e-spoke[data-s=needs-you] { stroke: rgba(255, 77, 94, .45); }
.e-run { stroke: rgba(178, 140, 255, .55); stroke-width: 1.5; }
.e-done { stroke: rgba(214, 243, 255, .14); stroke-width: 1; }
.net-flows, .pg-fx { position: absolute; inset: 0; pointer-events: none; }
.eflow { position: absolute; left: 0; top: 0; height: 4px; margin-top: -2px; transform-origin: 0 50%; overflow: hidden; transition: opacity .3s var(--ease); }
.eflow i { position: absolute; top: 0; bottom: 0; left: -12px; right: 0; background: radial-gradient(circle at 2px 2px, var(--agent) 1.2px, transparent 1.7px) 0 0 / 12px 4px repeat-x; animation: flowx .6s linear infinite; }
.eflow.plan i { background-image: radial-gradient(circle at 2px 2px, var(--arc) 1.1px, transparent 1.6px); animation-duration: .75s; }
@keyframes flowx { from { transform: translateX(0); } to { transform: translateX(12px); } }
.net.hl-on .eflow:not(.hl) { opacity: .25; }
.e-sby-o { stroke: var(--arc-35); stroke-width: 4; }
.e-sby-i { stroke: #0a1522; stroke-width: 1.6; }
.e-pulse { stroke: var(--ok); stroke-width: 3; filter: drop-shadow(0 0 4px var(--ok)); }
.e.flash { stroke: var(--ok); animation: efade .3s var(--ease) forwards; }
.net.hl-on .e:not(.hl) { opacity: .25; }
.net.hl-on .na:not(.hl) { opacity: .4; }
.e.hl { stroke: var(--arc); }
.e-sby-i.hl { stroke: #0a1522; }
.net-hub { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; }
.hub-core { position: absolute; left: -12px; top: -12px; width: 24px; height: 24px; transform: rotate(45deg); border: 1px solid var(--arc); background: rgba(41, 230, 255, .12); box-shadow: 0 0 16px rgba(41, 230, 255, .35); }
.hub-ring { position: absolute; left: -22px; top: -22px; width: 44px; height: 44px; border-radius: 50%; border: 1px dashed var(--arc-35); }
.hub-label { position: absolute; left: -80px; width: 160px; top: 28px; text-align: center; color: var(--ink-2); }
.net-sweep { position: absolute; left: 0; top: 0; border-radius: 50%; overflow: hidden; pointer-events: none; display: none; -webkit-mask-image: radial-gradient(closest-side, #000 55%, transparent 100%); mask-image: radial-gradient(closest-side, #000 55%, transparent 100%); }
.net-sweep i { position: absolute; border-radius: 50%; background: conic-gradient(from 0deg, transparent 0deg 285deg, rgba(41, 230, 255, .015) 305deg, rgba(41, 230, 255, .05) 345deg, rgba(41, 230, 255, .14) 359.4deg, transparent 360deg); }
.n-ring { fill: none; stroke: rgba(41, 230, 255, .08); stroke-width: 1; stroke-dasharray: 2 6; }
.n-ring.outer { stroke: rgba(41, 230, 255, .11); stroke-dasharray: none; }
.n-tick { stroke: rgba(41, 230, 255, .14); stroke-width: 1; }
.n-tick.long { stroke: rgba(41, 230, 255, .3); }
.nf-glyph { fill: none; stroke: var(--sc); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.nf-glyph .gf { fill: var(--sc); stroke: none; }
.nf-tag { fill: #08111c; stroke: color-mix(in srgb, var(--sc) 70%, transparent); stroke-width: 1; }
.nf-tag-t { fill: var(--ink); font: 700 11px var(--f-label); text-anchor: middle; dominant-baseline: central; }
.net-readout { position: absolute; top: 0; z-index: 5; width: min(340px, 70%); pointer-events: none; filter: drop-shadow(0 0 16px rgba(41, 230, 255, .18)) drop-shadow(0 8px 24px rgba(0, 0, 0, .6)); }
.net-readout.left { left: 0; } .net-readout.right { right: 0; } .net-readout.bottom { top: auto; bottom: 28px; }
.net-readout .tip-b { padding: 12px 16px; background-color: rgba(8, 17, 28, .97); --hl: var(--arc-35); }
.pkt { position: absolute; left: -3px; top: -3px; width: 6px; height: 6px; border-radius: 50%; background: var(--arc); box-shadow: 0 0 8px var(--arc); pointer-events: none; }
.pkt.sub { background: var(--agent); box-shadow: 0 0 8px var(--agent); }
.na[data-s=busy] .nf-glow, .na[data-s=running] .nf-glow { opacity: .3; }
.net-empty { position: absolute; left: 0; right: 0; text-align: center; color: var(--ink-2); pointer-events: none; }
.net-empty .label { color: var(--ink); }
.na { position: absolute; left: 0; top: 0; transition: opacity .3s var(--ease); }
.nf { position: relative; }
.nn { position: absolute; border-radius: 50%; pointer-events: auto; --sc: var(--arc); transition: --sc .3s; }
.nn:focus-visible { outline: none; }
.nn:focus-visible .nf-focus { opacity: 1; }
.nf-svg { position: absolute; overflow: visible; pointer-events: none; }
.nf-hex { fill: color-mix(in srgb, var(--sc) 14%, #08111c); stroke: var(--sc); stroke-width: 1.5; transition: fill .3s, stroke .3s; }
.nf-inner { fill: none; stroke: color-mix(in srgb, var(--sc) 35%, transparent); stroke-width: 1; }
.nf-ctx-t { fill: none; stroke: rgba(214, 243, 255, .08); stroke-width: 2; }
.nf-ctx { fill: none; stroke: var(--arc); stroke-width: 2; stroke-linecap: round; }
.nf-ctx[data-lvl=warn] { stroke: var(--amber); } .nf-ctx[data-lvl=hot] { stroke: var(--alert); }
.nf-letter { fill: var(--ink); font: 700 11px var(--f-label); letter-spacing: .04em; text-anchor: middle; dominant-baseline: central; }
.nf-badge { fill: #08111c; stroke: var(--sc); stroke-width: 1; }
.nf-badge-t { fill: var(--ink); font: 700 11px var(--f-label); text-anchor: middle; dominant-baseline: central; }
.nf-mark { fill: none; stroke: var(--sc); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.nf-focus { fill: none; stroke: var(--arc); stroke-width: 2; opacity: 0; }
.nf-spin { position: absolute; pointer-events: none; border-radius: 50%; animation: spin 2.4s linear infinite; }
.nf-spin svg { width: 100%; height: 100%; overflow: visible; fill: none; stroke: var(--sc); stroke-width: 1.25; stroke-linecap: round; display: block; opacity: .75; }
.nf-glow { position: absolute; border-radius: 50%; pointer-events: none; background: radial-gradient(circle, color-mix(in srgb, var(--sc) 45%, transparent), transparent 70%); opacity: 0; }
.na[data-s=needs-you] .nf-glow { opacity: 1; animation: breathe 1.6s ease-in-out infinite; }
.na.just-done .nf-glow { opacity: 0; animation: doneglow 1.5s var(--ease); }
.nf-spark, .nf-ping { position: absolute; border-radius: 50%; pointer-events: none; opacity: 0; }
.nf-spark { border: 1.5px solid var(--sc); }
.nf-ping { border: 1px solid var(--arc); box-shadow: 0 0 12px rgba(41, 230, 255, .4); display: none; }
.na[data-s=busy] .nn { --sc: var(--amber); } .na[data-s=needs-you] .nn { --sc: var(--alert); }
.na[data-s=running] .nn { --sc: var(--agent); } .na[data-s=done] .nn { --sc: var(--ok); }
.na[data-s=ended] .nn { --sc: rgba(214, 243, 255, .5); } .na[data-s=sat] .nn { --sc: var(--agent); }
.na[data-s=done] :is(.nf-hex, .nf-inner, .nf-glyph, .nf-ctx-t, .nf-ctx) { opacity: .8; }
.na[data-s=ended] :is(.nf-hex, .nf-inner, .nf-glyph, .nf-ctx-t, .nf-ctx) { opacity: .5; }
.na[data-s=ended] .nf-tag-t { fill: var(--ink-2); }
.na[data-s=ended] .nf-hex { stroke-dasharray: 3 3; }
.na[data-s=sat] .nf-hex { stroke-dasharray: 2 3; fill: #08111c; }
.nl { position: absolute; width: max-content; max-width: 180px; pointer-events: none; display: flex; flex-direction: column; }
.nl.side-b { left: 0; top: var(--R); transform: translateX(-50%); align-items: center; text-align: center; }
.nl.side-t { left: 0; top: calc(-1 * var(--R)); transform: translate(-50%, -100%); align-items: center; text-align: center; }
.nl.side-r { left: var(--R); top: 0; transform: translateY(-50%); align-items: flex-start; text-align: left; }
.nl.side-l { left: calc(-1 * var(--R)); top: 0; transform: translate(-100%, -50%); align-items: flex-end; text-align: right; }
.nl1 { max-width: 180px; font: 400 11px/16px var(--f-body); color: var(--ink); text-shadow: 0 0 4px var(--void), 0 0 8px var(--void); }
.nl1.is-type { font: 600 11px/16px var(--f-label); letter-spacing: .1em; text-transform: uppercase; color: var(--agent); }
.nl2 { font: 400 11px/16px var(--f-mono); color: var(--ink-2); text-shadow: 0 0 4px var(--void), 0 0 8px var(--void); white-space: nowrap; }
.na[data-s=done] .nl1.is-type, .na[data-s=ended] .nl1 { color: var(--ink-2); }
.net-pin { position: absolute; right: 0; bottom: 0; z-index: 4; width: min(440px, 100%); container-type: inline-size; }
.net-pin.left { right: auto; left: 0; }
.net-pin .card { background-color: rgba(8, 17, 28, .97); box-shadow: none; }
.pin-bar { display: flex; align-items: center; gap: 8px; justify-content: flex-end; padding: 8px 0 0; }
.net-legend { position: absolute; left: 0; bottom: 0; display: flex; gap: 16px; flex-wrap: wrap; color: var(--ink-2); pointer-events: none; }
.net-legend span { display: inline-flex; align-items: center; gap: 8px; }
.net-legend i { display: inline-block; width: 16px; height: 0; border-top: 1.5px solid var(--agent); }
.net-legend i.dbl { border-top: 1px solid var(--arc-35); border-bottom: 1px solid var(--arc-35); height: 4px; }
.net-legend i.dash { border-top: 2px dashed var(--agent); }

/* ---- plans ---- */
.plans { display: flex; flex-direction: column; gap: 0; container-type: inline-size; }
.plan { padding: 16px 0; border-top: 1px solid rgba(41, 230, 255, .12); }
.plan:first-child { border-top: 0; padding-top: 0; }
.plan-h { display: flex; align-items: center; gap: 8px; height: 20px; min-width: 0; }
.plan-p { color: var(--ink-2); min-width: 0; flex: 1; }
.plan-c { font: 400 11px/16px var(--f-mono); color: var(--ink-2); flex: none; }
.plan-t { margin-top: 4px; font: 600 15px/20px var(--f-body); color: var(--ink); }
.plan-g { margin-top: 12px; overflow-x: auto; overflow-y: hidden; }
.plan-g svg { display: block; overflow: visible; margin: 0 auto; }
.pe { fill: none; stroke: rgba(214, 243, 255, .18); stroke-width: 1; }
.pe.done { stroke: rgba(77, 255, 166, .3); }
.pe.flow { stroke: rgba(41, 230, 255, .45); stroke-width: 1.5; }
.pg-box { position: relative; margin: 0 auto; }
.pg-pulse { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; pointer-events: none; animation: pnpulse 2s var(--ease) infinite; }
.pg-pulse svg { width: 100%; height: 100%; display: block; overflow: visible; fill: none; stroke: var(--arc); stroke-width: 1; }
.pe.alert { stroke: rgba(255, 77, 94, .5); }
.pn { cursor: default; --sc: rgba(214, 243, 255, .42); }
.pn:focus-visible { outline: none; }
.pn:focus-visible .pn-focus { opacity: 1; }
.pn-focus { fill: none; stroke: var(--arc); stroke-width: 2; opacity: 0; }
.pn-hex { fill: #08111c; stroke: var(--sc); stroke-width: 1.5; transition: fill .3s, stroke .3s; }
.pn-id { fill: var(--ink); font: 700 11px var(--f-label); letter-spacing: .06em; text-anchor: middle; dominant-baseline: central; }
.pn-ag { fill: var(--ink-2); font: 600 11px var(--f-label); letter-spacing: .1em; text-transform: uppercase; text-anchor: middle; }
.pn-badge { fill: #08111c; stroke: var(--sc); stroke-width: 1; }
.pn-mark { fill: none; stroke: var(--sc); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.pn[data-s=todo] .pn-hex { stroke-dasharray: 3 3; }
.pn[data-s=todo] .pn-id { fill: var(--ink-2); }
.pn[data-s=in-progress] { --sc: var(--arc); } .pn[data-s=in-progress] .pn-hex { fill: rgba(41, 230, 255, .14); }
.pn[data-s=handed-off], .pn[data-s=accepted], .pn[data-s=done] { --sc: var(--ok); }
.pn[data-s=accepted] .pn-hex, .pn[data-s=done] .pn-hex { fill: rgba(77, 255, 166, .16); }
.pn[data-s=blocked], .pn[data-s=bounced] { --sc: var(--alert); } .pn[data-s=blocked] .pn-hex, .pn[data-s=bounced] .pn-hex { fill: rgba(255, 77, 94, .16); }
.pn[data-s=partial] { --sc: var(--amber); }
.pn[data-s=unknown] .pn-hex { stroke-dasharray: 1 3; }
.plan-need { display: flex; gap: 8px; align-items: flex-start; margin-top: 12px; color: var(--alert); }
.plan-need .ic { margin-top: 2px; }
.plan-need-t { color: var(--ink); font-size: 13px; line-height: 20px; min-width: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.plan-need-t b { font: 600 11px/20px var(--f-label); letter-spacing: .14em; text-transform: uppercase; color: var(--alert); margin-right: 8px; }
.plan-runs { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.plan-log { margin-top: 12px; font: 400 11px/16px var(--f-mono); color: var(--ink-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.plans-empty, .cards-empty { color: var(--ink-2); padding: 24px 0; text-align: center; }
.cards-empty .label { color: var(--ink); }

/* ---- floating layer: tooltip, banners, connection bar ---- */
.tip { position: fixed; left: 0; top: 0; z-index: 70; max-width: 360px; pointer-events: none; opacity: 0; transition: opacity .15s var(--ease); filter: drop-shadow(0 0 16px rgba(41, 230, 255, .18)) drop-shadow(0 8px 24px rgba(0, 0, 0, .6)); }
.tip.on { opacity: 1; }
.tip-b { padding: 12px 16px; background-color: rgba(8, 17, 28, .97); --hl: var(--arc-35); }
.tip-t { font-size: 13px; line-height: 20px; color: var(--ink); overflow-wrap: anywhere; }
.tc { display: flex; flex-direction: column; gap: 4px; min-width: 240px; }
.tc-h { display: flex; align-items: center; gap: 8px; }
.tc-t { font: 600 15px/20px var(--f-body); color: var(--ink); overflow-wrap: anywhere; }
.tc-r { display: flex; gap: 4px 8px; align-items: center; flex-wrap: wrap; font: 400 11px/16px var(--f-mono); color: var(--ink-2); }
.tc-r .trunc { white-space: normal; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.tc-r b { font-weight: 400; color: var(--ink); }
.tc-n { font-size: 13px; line-height: 20px; color: var(--ink-2); overflow-wrap: anywhere; }
.banners { grid-row: 2; display: flex; flex-direction: column; gap: 8px; margin-top: 12px; position: relative; z-index: 20; }
.ban { position: relative; display: flex; align-items: center; gap: 16px; height: 40px; padding: 0 8px 0 20px; background-color: rgba(30, 8, 14, .94); --hl: rgba(255, 77, 94, .7); box-shadow: 0 0 32px rgba(255, 77, 94, .2); animation: bandown .32s var(--ease) both; cursor: pointer; }
.ban::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--alert); animation: breathe 1.6s ease-in-out infinite; }
.ban-w { color: var(--alert); display: flex; align-items: center; gap: 8px; }
.ban-p { color: var(--ink); }
.ban-t { color: var(--ink); min-width: 0; flex: 1; }
.ban-w, .ban-p, .ban-r, .ban-tm, .ban-x { flex: none; }
.ban-t i { font-style: normal; color: var(--ink-2); }
.ban-r { color: var(--alert); font-weight: 600; white-space: nowrap; }
.ban-rs { display: none; }
.ban-tm { font: 400 13px/20px var(--f-mono); color: var(--ink); white-space: nowrap; }
.ban-x { width: 28px; height: 28px; border-radius: 14px; display: grid; place-items: center; color: var(--ink-2); }
.ban-x:hover { color: var(--ink); background: rgba(255, 77, 94, .15); }
.ban:focus-visible { outline: none; box-shadow: inset 0 0 0 2px rgba(30, 8, 14, .94), inset 0 0 0 4px var(--arc); }
.ban-more { padding: 2px 12px; border-radius: 10px; background: rgba(255, 77, 94, .12); border: 1px solid rgba(255, 77, 94, .5); color: var(--alert); white-space: nowrap; }
.ban-more:hover { background: rgba(255, 77, 94, .22); }
.conn { position: fixed; z-index: 45; top: 56px; left: 0; right: 0; height: 28px; display: flex; align-items: center; justify-content: center; gap: 12px; background: rgba(40, 26, 6, .92); border-bottom: 1px solid rgba(255, 181, 71, .5); color: var(--amber); }
.conn[data-s=down] { background: rgba(40, 8, 14, .92); border-color: rgba(255, 77, 94, .5); color: var(--alert); }
.conn .mono { color: var(--ink-2); font-size: 11px; }
.conn button { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
.stale .main, .stale .p-tick { opacity: .5; filter: saturate(.5); transition: opacity .3s, filter .3s; }

/* ---- top bar ---- */
.top { position: relative; z-index: 30; display: flex; align-items: center; gap: 24px; height: 56px; margin: 0 -24px; padding: 0 24px; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, rgba(8, 17, 28, .9), rgba(8, 17, 28, .55)); backdrop-filter: blur(14px); }
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; flex: none; }
.brand-mark { width: 28px; height: 28px; flex: none; }
.brand-mark circle { fill: none; stroke: var(--arc); }
.wordmark { font: 700 18px/24px var(--f-display); letter-spacing: .3em; color: var(--ink); padding-left: .3em; margin-left: -.3em; }
.brand-sub { color: var(--ink-2); }
.mini { display: none; align-items: center; gap: 8px; }
.mini .odo { font: 700 18px/24px var(--f-display); }
.mini .odo-d { width: .8em; }
.clock { display: flex; align-items: baseline; gap: 12px; margin: 0 auto; white-space: nowrap; }
.clock-t { font: 400 18px/24px var(--f-mono); color: var(--ink); }
.clock-d, .clock-u { color: var(--ink-2); }
.top-r { display: flex; align-items: center; gap: 8px; flex: none; }
.top-chips { display: flex; gap: 8px; align-items: center; }
.stream { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px 0 4px; color: var(--arc); }
.stream-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; box-shadow: 0 0 10px currentColor; }
.stream[data-s=reconnecting] { color: var(--amber); }
.stream[data-s=reconnecting] .stream-dot { animation: blink 1s ease-in-out infinite; }
.stream[data-s=down] { color: var(--alert); }
.stream[data-s=connecting] { color: var(--ink-3); }

/* ---- ticker ---- */
.p-tick .pb { padding: 12px 20px 12px; }
.p-tick .ph { margin-bottom: 8px; }
.tk-new { color: var(--ink-2); min-width: 0; flex: 1; display: flex; gap: 12px; align-items: center; }
.tk-last { color: var(--ink-2); min-width: 0; flex: 1; display: flex; gap: 12px; align-items: center; }
.tk-last .trunc { color: var(--ink-2); }
.tk-last .tk-tag, .tk-new .tk-tag, .tk-last .mono { flex: none; white-space: nowrap; }
.tk-collapse { margin-left: auto; flex: none; }
.p-tick.collapsed .tk-last { display: none; }
.p-tick:not(.collapsed) .tk-new { display: none; }
.tk-n { color: var(--ink-2); font-size: 11px; margin-left: 8px; }
.tk-list { position: relative; height: 72px; overflow: hidden; }
.p-tick.collapsed .tk-list { display: none; }
.p-tick.collapsed .ph { margin-bottom: 0; }
.tk { display: grid; grid-template-columns: 8ch 10ch 18ch minmax(0, 1fr); gap: 16px; align-items: center; height: 24px; font: 400 13px/24px var(--f-mono); color: var(--ink-2); }
.tk-time { color: var(--ink-2); font-size: 11px; }
.tk-tag { font: 600 11px/16px var(--f-mono); letter-spacing: .06em; height: 18px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid currentColor; text-transform: uppercase; }
.tk-tag[data-k=tool] { color: var(--arc); } .tk-tag[data-k=agent] { color: var(--agent); } .tk-tag[data-k=needs-you] { color: var(--alert); background: rgba(255, 77, 94, .12); }
.tk-tag[data-k=done] { color: var(--ok); } .tk-tag[data-k=plan] { color: var(--ink); } .tk-tag[data-k=session] { color: var(--ink-2); }
.tk-proj { color: var(--ink); }
.tk-text { color: var(--ink-2); }
.tk.type .tk-text { color: var(--arc); letter-spacing: .3em; }
.tk.enter { animation: tkin .3s var(--ease); }
.tk-collapse .ic { transition: transform .2s var(--ease); }
.p-tick.collapsed .tk-collapse .ic { transform: rotate(180deg); }

/* ---- page layout ---- */
.app { position: relative; z-index: 1; display: grid; grid-template-rows: 56px auto minmax(0, 1fr) auto; grid-template-columns: minmax(0, 1fr); height: 100vh; padding: 0 24px 16px; }
.app > .top { grid-row: 1; } .app > .main { grid-row: 3; margin-top: 16px; } .app > .p-tick { grid-row: 4; margin-top: 16px; }
.main { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); grid-template-rows: minmax(0, 1fr); column-gap: 24px; row-gap: 16px; min-height: 0; }
.col-l { grid-column: span 3; display: flex; flex-direction: column; gap: 16px; min-height: 0; overflow: hidden auto; margin: 0 -8px; padding: 0 8px; }
.p-reactor, .p-ext { flex: none; }
@media (min-width: 1440px) { .col-l > .p-reactor:has(+ .p-ext[hidden]), .col-l > .p-ext:not([hidden]) { flex: 1 0 auto; } }   /* bottoms line up with the centre */
@media (max-height: 959px) and (min-width: 900px) { .p-reactor .reactor { width: 200px !important; height: 200px !important; } }
.p-sess { grid-column: span 6; }
.p-sess .pc { display: flex; flex-direction: column; }
.p-plans { grid-column: span 3; }
@media (max-width: 1439px) {
  .app { height: auto; min-height: 100vh; }
  .main { grid-template-rows: auto auto; }
  .col-l { grid-column: 1 / span 4; grid-row: 1 / span 2; align-self: start; position: sticky; top: 72px; max-height: calc(100vh - 88px); }   /* the reactor stays in view while the sessions scroll */
  .p-sess { grid-column: 5 / span 8; }
  .p-sess .pc { overflow: visible; }
  .p-sess .net { min-height: 540px; }
  .p-plans { grid-column: 5 / span 8; }
  .p-plans .pc { overflow: visible; }
  .top { position: sticky; top: 0; }
}
@media (max-width: 899px) {
  .app { padding: 0 12px 12px; grid-template-rows: auto auto minmax(0, 1fr) auto; }
  .app > .main { margin-top: 12px; } .app > .p-tick { margin-top: 12px; }
  .ph { flex-wrap: wrap; row-gap: 8px; }
  .top { margin: 0 -12px; padding: 0 12px; gap: 12px; height: 56px; }
  .main { display: flex; flex-direction: column; gap: 12px; }
  .col-l { display: contents; }
  .p-reactor { order: 1; } .p-sess { order: 2; } .p-plans { order: 3; } .p-ext { order: 4; }
  .p-reactor .reactor, .brand-sub, .clock-d, .clock-u { display: none; }
  .p-reactor .vitals { margin-top: 0; grid-template-columns: 1fr 1fr; }
  .mini { display: flex; }
  .brand-mark { display: none; }
  .clock-t { font-size: 15px; }
  .pb { padding: 16px; }
  .p-sess .net { min-height: 380px; }
  .tk { grid-template-columns: 8ch 10ch minmax(0, 1fr); gap: 8px; }
  .tk-proj { display: none; }
  .ban { gap: 12px; padding-left: 16px; }
  .ban-t { display: none; }
  .ban-p { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ban-w > span:last-child { display: none; }
}
@media (max-width: 599px) {
  .top { flex-wrap: wrap; height: auto; min-height: 56px; padding-top: 8px; padding-bottom: 8px; row-gap: 8px; }
  .clock { display: none; }
  .top-r { margin-left: auto; gap: 4px; }
  .top-chips { order: 9; width: 100%; }
  .top-chips:not(:has(.chip:not([hidden]))) { display: none; }
  .stream .label { display: none; }
  .tgl { width: 32px; }
  .p-sess .ps { display: none; }
  .p-reactor .vitals { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .p-reactor .vital .vital-s, .p-reactor .vital.acct-v { display: none; }
  .p-reactor .vital.wide { grid-column: span 2; }
  .p-reactor .vital.wide .vital-s:first-of-type { display: block; }
  .ban-rl { display: none; } .ban-rs { display: inline; }
}

/* ---- motion: data and alert layers ---- */
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes breathe { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
@keyframes scan { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
@keyframes efade { from { opacity: 1; } to { opacity: .3; } }
@keyframes doneglow { 0% { filter: drop-shadow(0 0 0 transparent); opacity: 1; } 20% { filter: drop-shadow(0 0 6px var(--ok)); opacity: 1; } 100% { filter: drop-shadow(0 0 0 transparent); opacity: 1; } }
@keyframes bandown { from { transform: translateY(-16px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes tkin { from { transform: translateY(-100%); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes pnpulse { 0% { transform: scale(.85); opacity: .9; } 100% { transform: scale(1.35); opacity: 0; } }
.enter { animation: enter .22s var(--ease) both; }
@keyframes enter { from { transform: scale(.98); opacity: 0; } to { transform: none; opacity: 1; } }
.leave { animation: leave .2s var(--ease) both; pointer-events: none; }
@keyframes leave { to { transform: scaleY(.6); opacity: 0; } }

/* ---- motion: ambient layer (D14), only with EFFECTS on and no reduced motion ---- */
.fx .bg-shim { display: block; background: linear-gradient(100deg, transparent 42%, rgba(41, 230, 255, .045) 50%, transparent 58%); background-size: 100% 100%; animation: shimmer 14s var(--ease) infinite; }
.fx .bg-dots { display: block; background-image: radial-gradient(circle, rgba(41, 230, 255, .5) 0 1px, transparent 1.5px), radial-gradient(circle, rgba(214, 243, 255, .35) 0 .8px, transparent 1.3px); background-size: 220px 260px, 140px 170px; background-position: 0 0, 70px 90px; opacity: .35; animation: drift 70s linear infinite; inset: -260px -48px -48px; }
.fx .bg-dots.d2 { background-size: 320px 300px, 190px 230px; background-position: 40px 20px, 150px 130px; opacity: .22; animation-duration: 110s; }
@keyframes shimmer { 0% { transform: translateX(-60%); } 55%, 100% { transform: translateX(60%); } }
@keyframes drift { from { transform: translateY(0); } to { transform: translateY(-260px); } }
.fx .panel::before { animation: flicker 9s steps(1, end) infinite; }
.fx .main > :nth-child(2)::before, .fx .col-l > :nth-child(2)::before { animation-delay: -3s; }
.fx .main > :nth-child(3)::before { animation-delay: -6s; }
.fx .p-tick::before { animation-delay: -4.5s; animation-duration: 11s; }
@keyframes flicker { 0%, 100% { opacity: 1; } 62% { opacity: 1; } 62.4% { opacity: .35; } 62.8% { opacity: 1; } 63.4% { opacity: .55; } 64% { opacity: 1; } 88% { opacity: 1; } 88.3% { opacity: .5; } 88.7% { opacity: 1; } }
.fx .r-outer { animation: spin 80s linear infinite; }
.fx .r-mid { animation: spin 120s linear infinite reverse; }
.fx .r-inner { animation: spin 50s linear infinite; }
.fx .r-core { animation: beat var(--beat, 6s) ease-in-out infinite; }
.fx .reactor[data-mode=alert] .r-core { animation: none; }
@keyframes beat { 0%, 100% { transform: scale(1); opacity: .85; } 12% { transform: scale(1.06); opacity: 1; } 24% { transform: scale(1); opacity: .9; } 34% { transform: scale(1.03); opacity: 1; } 50% { transform: scale(1); opacity: .85; } }
.fx .net-sweep { display: block; }
.fx .nf { animation: float var(--fd, 8s) ease-in-out var(--fdl, 0s) infinite; }
@keyframes float { 0%, 100% { transform: translate(0, 0); } 30% { transform: translate(1.5px, -2px); } 65% { transform: translate(-1.5px, 1.5px); } }
.fx .nf-ping { display: block; }
.fx .hub-ring { animation: spin 30s linear infinite; }
.fx .brand-mark { animation: spin 20s linear infinite; }

/* ---- boot (D14 ambient: skipped with EFFECTS off or reduced motion) ---- */
.booting .bg { animation: bootfade .4s var(--ease) both; }
.booting .r-track, .booting .r-tick, .booting .r-arc { stroke-dasharray: 800; animation: bootdraw .7s var(--ease) .15s both; }
.booting .panel, .booting .top { animation: unfold .5s var(--ease) both; transform-origin: 0 0; }
.booting .top { animation-name: bootfade; }
.booting .col-l > .panel:nth-child(1) { animation-delay: .3s; } .booting .col-l > .panel:nth-child(2) { animation-delay: .36s; }
.booting .main > .p-sess { animation-delay: .42s; } .booting .main > .p-plans { animation-delay: .48s; } .booting .p-tick { animation-delay: .54s; }
@keyframes bootfade { from { opacity: 0; } to { opacity: 1; } }
@keyframes bootdraw { from { stroke-dashoffset: 800; } to { stroke-dashoffset: 0; } }
@keyframes unfold { 0% { transform: scale(.04, .01); opacity: 0; } 45% { transform: scale(1, .01); opacity: 1; } 100% { transform: none; opacity: 1; } }

/* ---- reduced motion ---- */
.rm *, .rm *::before, .rm *::after { animation-duration: .001s !important; animation-iteration-count: 1 !important; transition-duration: .15s !important; }
.rm .card[data-s=needs-you] .card-glow, .rm .na[data-s=needs-you] .nf-glow, .rm .reactor[data-mode=alert] .r-glow, .rm .ban::before, .rm .crow[data-s=needs-you]::before { animation: none !important; opacity: 1; }
.rm .card-scan, .rm .nf-spin { animation: none !important; }
.rm .eflow, .rm .pg-pulse { display: none; }
.rm .card[data-s=busy] .card-scan { opacity: 0; }
.rm .gl.spin { animation: none !important; }
.rm .enter { animation: rmfade .2s linear both !important; }
@keyframes rmfade { from { opacity: 0; } to { opacity: 1; } }

/* ---- gallery (/design) ---- */
.gallery .app { display: none; }
.gal { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 24px; padding: 0 24px 48px; max-width: 1600px; margin: 0 auto; }
.gal-head { position: sticky; top: 0; }
.gal-sec .pc { overflow: visible; }
.gal .pt { white-space: normal; }
.ctab-w { overflow-x: auto; max-width: 100%; }
.specs { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); gap: 32px 24px; }
.spec { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.spec.wide { grid-column: 1 / -1; }
.spec-l { color: var(--ink-2); }
.swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px 16px; }
.swatch { display: grid; grid-template-columns: 32px minmax(0, 1fr); column-gap: 12px; align-items: center; }
.sw-c { grid-row: 1 / 4; width: 32px; height: 32px; border: 1px solid var(--line); }
.sw-n { font-size: 13px; color: var(--ink); } .sw-v { font-size: 11px; color: var(--ink-2); } .sw-j { font-size: 13px; color: var(--ink-2); }
.ctab { border-collapse: collapse; font-size: 13px; }
.ctab th, .ctab td { padding: 4px 24px 4px 0; text-align: left; font-weight: 400; }
.ctab thead th { color: var(--ink-2); font: 600 11px/16px var(--f-label); letter-spacing: .14em; text-transform: uppercase; }
.ctab tbody th { color: var(--ink); }
.ctab td.pass { color: var(--ok); } .ctab td.large { color: var(--amber); } .ctab td.fail { color: var(--alert); }
.tline { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 16px; align-items: baseline; padding: 4px 0; min-width: 0; }
.tline > :last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tl-m { font-size: 11px; color: var(--ink-2); }
.icons { display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); gap: 12px; }
.icon-c { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 12px 4px; border: 1px solid rgba(41, 230, 255, .1); color: var(--ink); }
.icon-c .ic { width: 24px; height: 24px; }
.icon-c .mono { font-size: 11px; color: var(--ink-2); }
.col { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
.row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.gal-net { position: relative; display: flex; flex-direction: column; border: 1px solid rgba(41, 230, 255, .1); background: rgba(8, 17, 28, .4); }
.gal-net .net { min-height: 0; }
.gal-static.banners { position: static; transform: none; width: auto; }
.gal-static.tip { position: static; transform: none !important; opacity: 1; display: inline-block; }
.gal-static.conn { position: static; }
.gal-topbar .top { margin: 0; position: relative; }
.gal-main { display: block; }
.focus-demo { outline: 2px solid var(--arc); outline-offset: 2px; }
.booting .gal-sec { animation: unfold .5s var(--ease) both; transform-origin: 0 0; }
@media (max-width: 899px) { .gal { padding: 0 12px 32px; } .tline { grid-template-columns: 1fr; gap: 0; } .gal-head .brand-sub { display: none; } }
@media (max-width: 599px) { .gal-head .top-r { flex: 1 1 100%; flex-wrap: wrap; row-gap: 8px; } }
`;


// The client library: every component of the page and the gallery. Runs in the browser only.
function hudClient() {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const doc = document, root = doc.documentElement;
  const EASE = 'cubic-bezier(.2, .8, .2, 1)';

  // ---- DOM ----------------------------------------------------------------------------------------------------------
  function apply(el, p, isSvg) {
    for (const k in p) {
      const v = p[k];
      if (v == null || v === false) continue;
      if (k === 'class') { if (isSvg) el.setAttribute('class', v); else el.className = v; }
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') { if (typeof v === 'string') el.setAttribute('style', v); else Object.assign(el.style, v); }
      else if (k === 'on') { for (const e in v) el.addEventListener(e, v[e]); }
      else if (k === 'data') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  function add(el, kids) {
    for (const k of kids) {
      if (k == null || k === false) continue;
      if (Array.isArray(k)) add(el, k);
      else el.append(typeof k === 'object' ? k : doc.createTextNode(String(k)));
    }
    return el;
  }
  function h(tag, p, ...kids) { const el = doc.createElement(tag); if (p) apply(el, p, false); return add(el, kids); }
  function s(tag, p, ...kids) { const el = doc.createElementNS(NS, tag); if (p) apply(el, p, true); return add(el, kids); }
  function txt(el, t) { t = t == null ? '' : String(t); if (el.textContent !== t) el.textContent = t; }
  function setAttr(el, k, v) {
    if (v == null || v === false) { if (el.hasAttribute(k)) el.removeAttribute(k); return; }
    v = String(v); if (el.getAttribute(k) !== v) el.setAttribute(k, v);
  }
  function setData(el, k, v) {
    if (v == null || v === '') { if (k in el.dataset) delete el.dataset[k]; return; }
    v = String(v); if (el.dataset[k] !== v) el.dataset[k] = v;
  }
  function show(el, on) { if (el.hidden === !!on) el.hidden = !on; }

  // ---- time and numbers ----------------------------------------------------------------------------------------------
  let skew = 0;                                   // server clock minus browser clock
  const now = () => Date.now() + skew;
  function syncClock(serverNow) { if (Number.isFinite(serverNow)) { const k = serverNow - Date.now(); if (Math.abs(k - skew) > 250) skew = k; } }
  const pad2 = n => String(n).padStart(2, '0');
  function fmtTok(n) {
    n = Number(n) || 0;
    if (n < 999.5) return String(Math.round(n));
    const units = ['k', 'M', 'B'];
    let v = n / 1000, i = 0;
    while (v >= 999.5 && i < 2) { v /= 1000; i++; }
    return v.toFixed(v >= 99.95 ? 0 : v >= 9.995 ? 1 : 2) + units[i];
  }
  const fmtInt = n => Math.round(Number(n) || 0).toLocaleString('en-US');
  function fmtPct(p) { if (p == null || !Number.isFinite(p)) return '—'; if (p >= 99.95) return '100%'; return (p < 9.95 ? p.toFixed(1) : Math.round(p)) + '%'; }
  function fmtDur(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000)), hh = Math.floor(sec / 3600), mm = Math.floor(sec % 3600 / 60), ss = sec % 60;
    return hh ? `${hh}:${pad2(mm)}:${pad2(ss)}` : `${mm}:${pad2(ss)}`;
  }
  function fmtAge(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60); if (m < 60) return m + 'm';
    const hr = Math.floor(m / 60); if (hr < 24) return hr + 'h ' + (m % 60) + 'm';
    return Math.floor(hr / 24) + 'd ' + (hr % 24) + 'h';
  }
  function fmtClock(ts) { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
  function fmtDate(ts) { return new Date(ts).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }); }
  const headline = t => t ? (t.input || 0) + (t.output || 0) + (t.cacheWrite || 0) : 0;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  function shortModel(m) {
    if (!m) return '';
    const a = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(m);
    if (a) return a[1] + ' ' + a[2] + (a[3] ? '.' + a[3] : '');
    const b = /^claude-(\d+)(?:-(\d))?-([a-z]+)/.exec(m);
    if (b) return b[3] + ' ' + b[1] + (b[2] ? '.' + b[2] : '');
    return m.length > 16 ? m.slice(0, 15) + '…' : m;
  }
  const TOOL_ICONS = { Bash: 'terminal', PowerShell: 'terminal', BashOutput: 'terminal', KillShell: 'terminal', Read: 'file', NotebookRead: 'file',
    Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit', Grep: 'search', Glob: 'search', LS: 'search', WebFetch: 'web', WebSearch: 'web',
    Agent: 'agent', Task: 'agent', TodoWrite: 'plan', ExitPlanMode: 'plan', AskUserQuestion: 'bell' };
  const toolIcon = n => TOOL_ICONS[n] || 'tool';
  const ctxLevel = p => p == null ? 'none' : p >= 90 ? 'hot' : p >= 70 ? 'warn' : 'ok';
  const provName = p => p === 'bedrock' ? 'Bedrock' : p === 'anthropic' ? 'Anthropic' : 'Unknown';
  const provLetter = p => p === 'bedrock' ? 'B' : p === 'anthropic' ? 'A' : '?';
  // The needs-you reason where room is short: "Allow Bash", "Question".
  function shortReason(r) {
    const m = /^Permission:\s*(.+)$/i.exec(r || '');
    if (m) return 'Allow ' + m[1];
    return { 'Permission needed': 'Permission', 'Question for you': 'Question', 'Waiting for your input': 'Input' }[r] || r || 'Needs you';
  }
  // Sessions the network draws and the vitals count: open ones, plus ended ones for 15 minutes (or while a session
  // they launched is still open).
  function shownSessions(sessions) {
    const t = now(), live = sessions.filter(x => x.status !== 'ended');
    return sessions.filter(x => x.status !== 'ended' || live.some(l => l.startedBy === x.id) || (x.endedAt && t - x.endedAt < 15 * 60_000));
  }

  // ---- preferences and motion ----------------------------------------------------------------------------------------
  const prefs = {
    get(k, d) { try { const v = localStorage.getItem('hud.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('hud.' + k, JSON.stringify(v)); } catch {} },
  };
  const rmQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const motion = {
    rm: rmQuery.matches, fx: prefs.get('effects', true), listeners: new Set(),
    get ambient() { return this.fx && !this.rm; },
    apply() { root.classList.toggle('rm', this.rm); root.classList.toggle('fx', this.ambient); for (const f of this.listeners) f(); },
    setFx(on) { this.fx = !!on; prefs.set('effects', this.fx); this.apply(); },
    setRm(on) { this.rm = !!on; this.apply(); },
    on(f) { this.listeners.add(f); },
  };
  rmQuery.addEventListener('change', e => motion.setRm(e.matches));
  motion.apply();
  const easeOut = k => 1 - Math.pow(1 - k, 3);

  // Ambient glitch on entry and on a status change (layer 1: EFFECTS only).
  function glitch(el) {
    if (!motion.ambient || !el.animate) return;
    el.animate([
      { transform: 'translateX(0)', filter: 'none', opacity: 1 },
      { transform: 'translateX(-3px)', filter: 'brightness(1.7) hue-rotate(-25deg)', opacity: .75, offset: .2 },
      { transform: 'translateX(2px)', filter: 'brightness(1.3) hue-rotate(20deg)', opacity: 1, offset: .45 },
      { transform: 'translateX(-1px)', filter: 'none', opacity: .85, offset: .7 },
      { transform: 'translateX(0)', filter: 'none', opacity: 1 },
    ], { duration: 260, easing: 'steps(6, end)' });
  }

  // ---- icons (24-unit grid, 1.5 px stroke) and status glyphs (16-unit) ----------------------------------------------
  const ICONS = {
    terminal: [['rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2 }], ['path', { d: 'M7 9.5l3 2.5-3 2.5M12.5 15H17' }]],
    file: [['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }], ['path', { d: 'M14 3v5h5M9 13h6M9 17h4' }]],
    edit: [['path', { d: 'M4 20h4L19 9l-4-4L4 16z' }], ['path', { d: 'M13.5 6.5l4 4' }]],
    search: [['circle', { cx: 11, cy: 11, r: 6 }], ['path', { d: 'M20 20l-4.6-4.6' }]],
    web: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z' }]],
    agent: [['circle', { cx: 12, cy: 6.5, r: 2.5 }], ['circle', { cx: 6, cy: 17.5, r: 2.5 }], ['circle', { cx: 18, cy: 17.5, r: 2.5 }], ['path', { d: 'M10.7 8.7l-3.4 6.6M13.3 8.7l3.4 6.6' }]],
    plan: [['path', { d: 'M12 3l3 1.7v3.6L12 10l-3-1.7V4.7z' }], ['path', { d: 'M6 14l3 1.7v3.6L6 21l-3-1.7v-3.6z' }], ['path', { d: 'M18 14l3 1.7v3.6L18 21l-3-1.7v-3.6z' }], ['path', { d: 'M10.5 9.5L7.5 14M13.5 9.5l3 4.5' }]],
    bell: [['path', { d: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z' }], ['path', { d: 'M10 20.5a2 2 0 0 0 4 0' }]],
    voice: [['rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }], ['path', { d: 'M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6' }]],
    sound: [['path', { d: 'M4 9.5h3.5L12 6v12l-4.5-3.5H4z' }], ['path', { d: 'M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11' }]],
    effects: [['path', { d: 'M11 3.5l1.6 4.4 4.4 1.6-4.4 1.6L11 15.5l-1.6-4.4L5 9.5l4.4-1.6z' }], ['path', { d: 'M18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z' }]],
    tool: [['path', { d: 'M14.7 6.3a4 4 0 0 0-5.4 5.1L4 16.7 7.3 20l5.3-5.3a4 4 0 0 0 5.1-5.4l-2.4 2.4-2.6-.7-.7-2.6z' }]],
    network: [['circle', { cx: 12, cy: 12, r: 2.5 }], ['circle', { cx: 5, cy: 5, r: 1.8 }], ['circle', { cx: 19, cy: 5, r: 1.8 }], ['circle', { cx: 5, cy: 19, r: 1.8 }], ['circle', { cx: 19, cy: 19, r: 1.8 }], ['path', { d: 'M10.2 10.2L6.3 6.3M13.8 10.2l3.9-3.9M10.2 13.8l-3.9 3.9M13.8 13.8l3.9 3.9' }]],
    cards: [['rect', { x: 4, y: 4.5, width: 16, height: 6, rx: 1 }], ['rect', { x: 4, y: 13.5, width: 16, height: 6, rx: 1 }]],
    branch: [['circle', { cx: 7, cy: 6, r: 2 }], ['circle', { cx: 7, cy: 18, r: 2 }], ['circle', { cx: 17, cy: 8, r: 2 }], ['path', { d: 'M7 8v8M17 10a5 5 0 0 1-5 5H9' }]],
    check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
    alert: [['path', { d: 'M12 4l9 15.5H3z' }], ['path', { d: 'M12 10v4.5M12 17.3v.2' }]],
    close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
    pin: [['path', { d: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v7' }]],
    chevron: [['path', { d: 'M7 10l5 5 5-5' }]],
    clock: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 7.5V12l3 2' }]],
    slash: [['path', { d: 'M5 5l14 14' }]],
  };
  function icon(name, cls) {
    const svg = s('svg', { class: 'ic' + (cls ? ' ' + cls : ''), viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
    for (const [t, a] of ICONS[name] || ICONS.tool) svg.append(s(t, a));
    return svg;
  }
  const HEX16 = 'M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z';
  const GLYPHS = {
    busy: [['path', { d: 'M8 2.5a5.5 5.5 0 1 1-5.5 5.5' }], ['circle', { cx: 8, cy: 8, r: 1.6, class: 'gf' }]],
    needs: [['path', { d: 'M8 2l6.5 11.5h-13z' }], ['path', { d: 'M8 6.5v3M8 11.6v.1' }]],
    idle: [['circle', { cx: 8, cy: 8, r: 5 }]],
    ended: [['rect', { x: 3.5, y: 3.5, width: 9, height: 9 }], ['path', { d: 'M6 8h4' }]],
    running: [['circle', { cx: 8, cy: 8, r: 5.5, 'stroke-dasharray': '7 4.5' }]],
    done: [['circle', { cx: 8, cy: 8, r: 6 }], ['path', { d: 'M5.2 8.2l1.9 1.9 3.8-4' }]],
    todo: [['path', { d: HEX16, 'stroke-dasharray': '2 2' }]],
    inprog: [['path', { d: HEX16 }], ['circle', { cx: 8, cy: 8, r: 1.8, class: 'gf' }]],
    handoff: [['circle', { cx: 8, cy: 8, r: 6 }], ['path', { d: 'M5.5 8h5M8.6 5.8L10.8 8l-2.2 2.2' }]],
    bounced: [['path', { d: 'M5 6h5a3 3 0 0 1 0 6H6' }], ['path', { d: 'M7 3.5L4.5 6 7 8.5' }]],
    partial: [['circle', { cx: 8, cy: 8, r: 5.5 }], ['path', { d: 'M8 2.5a5.5 5.5 0 0 1 0 11z', class: 'gf' }]],
    unknown: [['circle', { cx: 8, cy: 8, r: 5.5, 'stroke-dasharray': '1.5 2.5' }]],
  };
  function glyph(name) {
    const svg = s('svg', { class: 'gl' + (name === 'running' ? ' spin' : ''), viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' });
    for (const [t, a] of GLYPHS[name] || GLYPHS.unknown) svg.append(s(t, a));
    return svg;
  }
  // state -> [glyph, word, colour]: status is always a word, a shape and a colour.
  const STATUS = {
    'needs-you': ['needs', 'Needs you', 'alert'], busy: ['busy', 'Busy', 'amber'], idle: ['idle', 'Idle', 'arc'], ended: ['ended', 'Ended', 'dim'],
    running: ['running', 'Running', 'agent'], done: ['done', 'Done', 'ok'],
    todo: ['todo', 'Todo', 'dim'], 'in-progress': ['inprog', 'In progress', 'arc'], 'handed-off': ['handoff', 'Handed off', 'ok'], accepted: ['done', 'Accepted', 'ok'],
    blocked: ['needs', 'Blocked', 'alert'], bounced: ['bounced', 'Bounced', 'alert'], partial: ['partial', 'Partial', 'amber'], unknown: ['unknown', 'Unknown', 'dim'],
  };
  function statusTag() {
    const g = h('span', { style: 'display:flex' }), w = h('span'), x = h('span', { class: 'stag-x mono', hidden: true });
    const el = h('span', { class: 'stag label' }, g, w, x);
    let cur = null;
    return {
      el,
      set(state, extra, word) {
        const [gl, wd, c] = STATUS[state] || STATUS.unknown;
        if (cur !== state) { cur = state; el.dataset.c = c; g.replaceChildren(glyph(gl)); }
        txt(w, word || wd); txt(x, extra || ''); show(x, !!extra);
      },
    };
  }
  function provBadge() {
    const el = h('span', { class: 'chip prov' });
    return { el, set(p, raw) { setData(el, 'p', p || 'unknown'); txt(el, provName(p)); setData(el, 'tip', 'Runs on ' + provName(p) + (raw ? ' · model id ' + raw : '')); } };
  }

  // ---- tooltip (floating layer) --------------------------------------------------------------------------------------
  const tip = (() => {
    const body = h('div', { class: 'tip-b cutbox' });
    const box = h('div', { class: 'tip', role: 'tooltip', id: 'hud-tip' }, body);
    let anchor = null, pending = null, timer = 0;
    function place(target) {
      const r = target.getBoundingClientRect(), bw = box.offsetWidth, bh = box.offsetHeight;
      let x = Math.max(8, Math.min(innerWidth - bw - 8, r.left + r.width / 2 - bw / 2));
      let y = r.top - bh - 10;
      if (y < 64) y = r.bottom + 10;
      if (y + bh > innerHeight - 8) y = Math.max(8, innerHeight - bh - 8);
      box.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
    function open(target, content) {
      if (!box.isConnected) doc.body.append(box);
      body.replaceChildren(typeof content === 'string' ? h('div', { class: 'tip-t', text: content }) : content);
      anchor = target; box.classList.add('on'); place(target);
    }
    function close(target) { if (target && target !== anchor && target !== pending) return; clearTimeout(timer); pending = null; anchor = null; box.classList.remove('on'); }
    function maybe(e) {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (!t || t === anchor || t === pending) return;
      if (t.dataset.tipIf === 'trunc' && t.scrollWidth <= t.clientWidth + 1) return;
      clearTimeout(timer); pending = t;
      timer = setTimeout(() => { pending = null; if (t.isConnected) open(t, t.dataset.tip); }, e.type === 'focusin' ? 0 : 350);
      const leave = () => { close(t); t.removeEventListener('pointerleave', leave); t.removeEventListener('focusout', leave); };
      t.addEventListener('pointerleave', leave); t.addEventListener('focusout', leave);
    }
    doc.addEventListener('pointerover', maybe);
    doc.addEventListener('focusin', maybe);
    addEventListener('scroll', () => close(), true);
    return { open, close, get anchor() { return anchor; } };
  })();

  // ---- live timers: [data-since] shows a running clock, [data-age] a coarse age ------------------------------------
  function tickTimers(scope = doc) {
    const t = now();
    for (const el of scope.querySelectorAll('[data-since]')) txt(el, fmtDur(t - Number(el.dataset.since)));
    for (const el of scope.querySelectorAll('[data-age]')) txt(el, (el.dataset.pre || '') + fmtAge(t - Number(el.dataset.age)) + (el.dataset.post || ''));
    for (const el of scope.querySelectorAll('[data-until]')) txt(el, (el.dataset.pre || '') + fmtAge(Number(el.dataset.until) - t));
  }
  function since(el, ts) { if (ts) { setData(el, 'since', ts); txt(el, fmtDur(now() - ts)); } else { setData(el, 'since', null); txt(el, ''); } }
  function age(el, ts, pre = '', post = '') {
    setData(el, 'pre', pre); setData(el, 'post', post);
    if (ts) { setData(el, 'age', ts); txt(el, pre + fmtAge(now() - ts) + post); } else { setData(el, 'age', null); txt(el, ''); }
  }

  // ---- odometer: digits roll (layer 2), widths never change ----------------------------------------------------------
  function odo(cls) {
    const sr = h('span', { class: 'sr' });
    const el = h('span', { class: 'odo' + (cls ? ' ' + cls : '') }, sr);
    let cur = null;
    const isD = ch => ch >= '0' && ch <= '9';
    function slot(ch) {
      if (!isD(ch)) { const sl = h('span', { class: 'odo-s', 'aria-hidden': 'true', text: ch }); sl._ch = ch; return sl; }
      const strip = h('span', { class: 'odo-strip' });
      for (let d = 0; d < 10; d++) strip.append(h('span', { text: String(d) }));
      const sl = h('span', { class: 'odo-s odo-d', 'aria-hidden': 'true' }, strip);
      sl._strip = strip; digit(sl, ch);
      return sl;
    }
    function digit(sl, ch) { sl._ch = ch; sl._strip.style.transform = `translateY(${-Number(ch)}em)`; }
    let lastAt = 0, pending = null, timer = 0;
    function set(v, opts = {}) {
      const str = String(v);
      if (str === cur && opts.from == null) { pending = null; return; }
      const wait = cur == null || opts.from != null ? 0 : lastAt + 1500 - Date.now();
      if (wait > 0) { pending = str; if (!timer) timer = setTimeout(() => { timer = 0; const p = pending; pending = null; if (p != null) set(p); }, wait); return; }
      lastAt = Date.now();
      txt(sr, str);
      const slots = [...el.children].slice(1);
      const same = cur != null && cur.length === str.length && slots.every((sl, i) => !!sl._strip === isD(str[i]));
      if (!same || opts.from != null) {
        const from = opts.from != null ? String(opts.from) : null;
        const kids = [...str].map(ch => slot(from != null && isD(ch) ? '0' : ch));
        el.replaceChildren(sr, ...kids);
        if (from != null) { void el.offsetWidth; kids.forEach((k, i) => { if (k._strip) digit(k, str[i]); }); }
      } else {
        slots.forEach((sl, i) => { if (sl._ch !== str[i]) { if (sl._strip) digit(sl, str[i]); else { sl.textContent = str[i]; sl._ch = str[i]; } } });
      }
      cur = str;
    }
    return { el, set, get value() { return cur; } };
  }

  // ---- keyed lists: enter, leave, and FLIP reordering -----------------------------------------------------------------
  function enterEl(el) {
    el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter');
    setTimeout(() => el.classList.remove('enter'), 260);
    glitch(el);
  }
  function leaveEl(el) { el.classList.add('leave'); setTimeout(() => el.remove(), 200); }
  function reconcile(container, map, items, keyOf, make, update, animate = true) {
    const want = [], seen = new Set();
    for (const it of items) {
      const k = keyOf(it); seen.add(k);
      let c = map.get(k); const fresh = !c;
      if (fresh) { c = make(it); map.set(k, c); }
      update(c, it);
      want.push([c, fresh]);
    }
    for (const [k, c] of map) if (!seen.has(k)) { map.delete(k); if (animate) leaveEl(c.el); else c.el.remove(); }
    const cur = [...container.children].filter(e => !e.classList.contains('leave'));
    const changed = cur.length !== want.length || want.some(([c], i) => cur[i] !== c.el);
    if (!changed) return;
    const before = new Map();
    if (animate) for (const [c, fresh] of want) if (!fresh && c.el.isConnected) before.set(c.el, c.el.getBoundingClientRect().top);
    let prev = null;
    for (const [c] of want) {
      const el = c.el;
      if (prev ? prev.nextElementSibling !== el : container.firstElementChild !== el) { if (prev) prev.after(el); else container.prepend(el); }
      prev = el;
    }
    if (!animate) return;
    for (const [c, fresh] of want) {
      if (fresh) { enterEl(c.el); continue; }
      const top = before.get(c.el); if (top == null) continue;
      const dy = top - c.el.getBoundingClientRect().top;
      if (Math.abs(dy) > 1 && !motion.rm) c.el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 300, easing: EASE });
    }
  }

  // ---- meters ----------------------------------------------------------------------------------------------------------
  function contextMeter(label = 'Context') {
    const fill = h('span', { class: 'bar-f' });
    const bar = h('span', { class: 'bar bar-ctx' }, fill, h('span', { class: 'bar-m m70' }), h('span', { class: 'bar-m m90' }));
    const val = h('span', { class: 'mv mono' }), note = h('span', { class: 'mn mono' });
    const el = h('div', { class: 'meter m-ctx' }, h('span', { class: 'ml label', text: label }), bar, val, note);
    return {
      el,
      set(c) {
        const p = c ? c.pct : null;
        setData(el, 'lvl', ctxLevel(p));
        fill.style.transform = `scaleX(${p == null ? 0 : Math.min(1, p / 100)})`;
        txt(val, fmtPct(p));
        txt(note, c ? `${fmtTok(c.used)} of ${fmtTok(c.window)}` : 'window unknown');
      },
    };
  }
  function tokenMeter() {
    const fo = h('span', { class: 'bar-f seg-out' }), fw = h('span', { class: 'bar-f seg-cw' }), fi = h('span', { class: 'bar-f seg-in' });
    const val = h('span', { class: 'mv mono' }), note = h('span', { class: 'mn mono', 'data-tip-if': 'trunc' }), split = h('span', { class: 'msplit mono', 'data-tip-if': 'trunc' });
    const el = h('div', { class: 'meter m-tok' }, h('span', { class: 'ml label', text: 'Tokens' }), h('span', { class: 'bar bar-tok' }, fo, fw, fi), val, note, h('span'), split);
    return {
      el,
      set(t, tree, max) {
        t = t || {}; const tot = headline(t), k = max > 0 ? Math.min(1, tot / max) : 0;
        const o = tot ? (t.output || 0) / tot * k : 0, w = tot ? (t.cacheWrite || 0) / tot * k : 0, i = tot ? (t.input || 0) / tot * k : 0;
        fo.style.transform = `scaleX(${o})`;
        fw.style.transform = `translateX(${o * 100}%) scaleX(${w})`;
        fi.style.transform = `translateX(${(o + w) * 100}%) scaleX(${i})`;
        txt(val, fmtTok(tot));
        const tt = headline(tree);
        txt(note, tree && tt > tot ? `incl. subagents ${fmtTok(tt)}` : '');
        txt(split, `in ${fmtTok(t.input)} · out ${fmtTok(t.output)} · cache write ${fmtTok(t.cacheWrite)}`); split.dataset.tip = split.textContent; note.dataset.tip = note.textContent;
      },
    };
  }
  function cacheMeter() {
    const f = h('span', { class: 'bar-f' }), val = h('span', { class: 'mv mono' });
    const el = h('div', { class: 'meter m-cr' }, h('span', { class: 'ml label', text: 'Cache read' }), h('span', { class: 'bar bar-cr' }, f), val, h('span', { class: 'mn mono', text: 'context re-read, shown apart', 'data-tip': 'Cache reads re-count the same context on every turn, so they are kept out of the token total', 'data-tip-if': 'trunc' }));
    return { el, set(n, max) { f.style.transform = `scaleX(${max > 0 ? Math.min(1, n / max) : 0})`; txt(val, fmtTok(n)); } };
  }

  // ---- the current-activity line of a card -----------------------------------------------------------------------------
  function nowLine() {
    const ic = h('span', { style: 'display:flex' }), name = h('span', { class: 'now-n' });
    const sum = h('span', { class: 'now-s trunc', 'data-tip-if': 'trunc' }), tm = h('span', { class: 'now-t mono' });
    const el = h('div', { class: 'now' }, ic, name, sum, tm);
    let icName = null;
    const setIcon = n => { if (n !== icName) { icName = n; ic.replaceChildren(icon(n)); } };
    return {
      el,
      set(x) {
        const tool = x.currentTool, t = now();
        let k, n, ss = '';
        since(tm, null); age(tm, null);
        if (x.status === 'needs-you') {
          k = 'needs'; setIcon('alert'); n = x.needsYou?.reason || 'Needs you';
          ss = tool ? `${tool.name}${tool.summary ? ' · ' + tool.summary : ''}` : '';
          since(tm, x.needsYou?.since);
        } else if (x.status === 'busy' && tool) {
          k = 'tool'; setIcon(toolIcon(tool.name)); n = tool.name; ss = tool.summary || ''; since(tm, tool.since);
        } else if (x.status === 'busy') {
          k = 'think'; setIcon('clock'); n = 'Working'; ss = 'between tools';
        } else if (x.status === 'idle') {
          const fresh = x.lastActivityAt && t - x.lastActivityAt < 90_000;
          k = fresh ? 'fresh' : 'idle'; setIcon(fresh ? 'check' : 'clock'); n = fresh ? 'Just finished' : 'Idle';
          age(tm, x.lastActivityAt, fresh ? '' : 'for ', fresh ? ' ago' : '');
        } else {
          k = 'ended'; setIcon('close'); n = 'Ended'; age(tm, x.endedAt || x.lastActivityAt, '', ' ago');
        }
        setData(el, 'k', k); txt(name, n); txt(sum, ss); setData(sum, 'tip', ss || null);
      },
    };
  }

  // ---- subagent rows ---------------------------------------------------------------------------------------------------
  function subRow() {
    const g = h('span', { class: 'sub-g' }), typ = h('b'), desc = h('span');
    const name = h('span', { class: 'sub-n trunc', 'data-tip-if': 'trunc' }, typ, desc);
    const model = h('span', { class: 'sub-m trunc' }), k = h('span', { class: 'sub-k' }), c = h('span', { class: 'sub-c' });
    const sw = h('span'), st = h('span', { class: 'mono', style: 'margin-left:8px;letter-spacing:0' });
    const el = h('div', { class: 'sub' }, g, name, model, k, c, h('span', { class: 'sub-s label' }, sw, st));
    let prev = null;
    return {
      el,
      set(a, d) {
        setData(el, 's', a.state); setData(el, 'd', d); el.style.setProperty('--d', d);
        if (prev !== a.state) {
          g.replaceChildren(glyph(a.state === 'done' ? 'done' : 'running'));
          if (prev === 'running' && a.state === 'done') { el.classList.remove('just-done'); void el.offsetWidth; el.classList.add('just-done'); setTimeout(() => el.classList.remove('just-done'), 1600); }
          prev = a.state;
        }
        txt(typ, a.type || 'agent'); txt(desc, a.description || '');
        name.dataset.tip = `${a.type || 'agent'} · ${a.description || ''}`;
        txt(model, shortModel(a.model)); setData(model, 'tip', a.modelRaw ? `${a.modelRaw} · ${provName(a.provider)}` : null);
        txt(k, fmtTok(headline(a.tokens)));
        txt(c, a.context ? fmtPct(a.context.pct) : '—'); setData(c, 'lvl', ctxLevel(a.context?.pct));
        if (a.state === 'running') { txt(sw, 'Running'); since(st, a.startedAt); } else { txt(sw, 'Done'); since(st, null); }
      },
    };
  }
  // A session's subagents in tree order; deeper than 3 levels, and old finished ones beyond 4, fold into one line.
  function subTree(subs, rootId) {
    const ids = new Set(subs.map(a => a.id)), kids = new Map();
    for (const a of subs) { const p = ids.has(a.parentId) ? a.parentId : rootId; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(a); }
    const out = [];
    const walk = (p, d) => { for (const a of (kids.get(p) || []).sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0))) { out.push([a, d]); walk(a.id, d + 1); } };
    walk(rootId, 1);
    return { list: out, kids };
  }
  function subList() {
    const rowsEl = h('div'), more = h('div', { class: 'sub-more label', hidden: true });
    const el = h('div', { class: 'subs', hidden: true }, rowsEl, more);
    const rows = new Map();
    return {
      el,
      update(subs, rootId) {
        show(el, subs.length > 0);
        const { list, kids } = subTree(subs, rootId);
        const keepUp = new Set();
        const runningBelow = id => (kids.get(id) || []).some(k => k.state === 'running' || runningBelow(k.id));
        for (const [a] of list) if (a.state === 'done' && runningBelow(a.id)) keepUp.add(a.id);
        let deeper = 0;
        let vis = list.filter(([, d]) => d <= 3 || (deeper++, false));
        const done = vis.filter(([a]) => a.state === 'done' && !keepUp.has(a.id)).sort((x, y) => (y[0].endedAt || 0) - (x[0].endedAt || 0));
        const hide = new Set(done.slice(4).map(([a]) => a.id));
        vis = vis.filter(([a]) => !hide.has(a.id));
        reconcile(rowsEl, rows, vis, ([a]) => a.id, () => subRow(), (r, [a, d]) => r.set(a, d));
        const bits = [];
        if (hide.size) bits.push(`+${hide.size} earlier finished`);
        if (deeper) bits.push(`+${deeper} more, deeper`);
        txt(more, bits.join(' · ')); show(more, bits.length > 0);
      },
    };
  }

  // ---- session card (comfortable) and compact row (dense) -------------------------------------------------------------
  function sessionCard(api = {}) {
    const projName = h('span'), projLbl = h('span', { class: 'label trunc', 'data-tip-if': 'trunc' }, projName), tag = statusTag();
    const title = h('h3', { class: 'card-title trunc', 'data-tip-if': 'trunc' });
    const mChip = h('span', { class: 'chip' });
    const bName = h('span', { class: 'trunc' }), bChip = h('span', { class: 'card-br mono', 'data-tip-if': 'trunc' }, icon('branch'), bName);
    const prov = provBadge();
    const sbyName = h('span', { class: 'trunc' });
    const sby = h('button', { class: 'chip', type: 'button', hidden: true }, icon('agent'), h('span', { text: 'Started by' }), sbyName);
    const ageEl = h('span'), toolsEl = h('span');
    const nowRow = nowLine(), tok = tokenMeter(), cr = cacheMeter(), ctx = contextMeter(), subs = subList();
    const sumEl = h('div', { class: 'card-sum' });
    const el = h('article', { class: 'card cutbox', tabindex: '-1' },
      h('div', { class: 'card-scan', 'aria-hidden': 'true' }), h('div', { class: 'card-glow', 'aria-hidden': 'true' }),
      h('header', { class: 'card-h' }, h('div', { class: 'card-proj' }, projLbl, bChip), h('span', { class: 'card-meta mono' }, ageEl, ' · ', toolsEl), tag.el),
      h('div', { class: 'card-tr' }, title, h('div', { class: 'card-chips' }, mChip, prov.el, sby)),
      sumEl, nowRow.el, h('div', { class: 'meters' }, tok.el, cr.el, ctx.el), subs.el);
    let st = null, sbyId = null;
    sby.addEventListener('click', e => { e.stopPropagation(); if (sbyId) api.jump?.(sbyId); });
    return {
      el,
      update(x, c = {}) {
        if (st && st !== x.status) glitch(el);
        st = x.status; setData(el, 's', st); setData(el, 'id', x.id);
        txt(projName, x.project || 'Unknown project'); projLbl.dataset.tip = x.project || 'Unknown project';
        tag.set(x.status);
        const t = x.title || x.name || 'Untitled session';
        txt(title, t); title.dataset.tip = t;
        txt(mChip, [shortModel(x.model) || 'model unknown', x.effort].filter(Boolean).join(' · '));
        setData(mChip, 'tip', x.modelRaw ? 'Model id: ' + x.modelRaw : null);
        show(bChip, !!x.branch); txt(bName, x.branch || ''); setData(bChip, 'tip', x.branch ? 'Branch ' + x.branch : null);
        prov.set(x.provider, x.modelRaw);
        sbyId = x.startedBy || null; show(sby, !!sbyId);
        if (sbyId) {
          const p = c.byId && c.byId.get(sbyId);
          const who = p ? (p.title || p.name || p.project) : 'session ' + sbyId.slice(0, 8);
          txt(sbyName, who); setData(sby, 'tip', `Launched from the shell of “${who}”. Click to go to it.`);
        }
        age(ageEl, x.startedAt); txt(toolsEl, plural(x.tools || 0, 'tool', 'tools'));
        nowRow.set(x);
        tok.set(x.tokens, x.tokensTree, c.maxTok);
        cr.set(x.tokens?.cacheRead || 0, c.maxCache);
        ctx.set(x.context);
        subs.update(x.subagents || [], x.id);
        if (st === 'ended') txt(sumEl, [shortModel(x.model), provName(x.provider), `${fmtTok(headline(x.tokens))} tokens`, plural(x.tools || 0, 'tool', 'tools'), (x.subagents || []).length ? plural(x.subagents.length, 'subagent', 'subagents') : null].filter(Boolean).join(' · '));
      },
    };
  }
  function compactRow(api = {}) {
    const tag = statusTag();
    const p = h('span', { class: 'cr-p label trunc', 'data-tip-if': 'trunc' }), t = h('span', { class: 'cr-t trunc', 'data-tip-if': 'trunc' });
    const m = h('span', { class: 'cr-m trunc' }), v = h('span', { class: 'cr-v' });
    const wIc = h('span', { style: 'display:flex' }), wT = h('span', { class: 'trunc', 'data-tip-if': 'trunc' }), wTm = h('span', { class: 'mono' });
    const k = h('span', { class: 'cr-k' }), c = h('span', { class: 'cr-c' }), n = h('span', { class: 'cr-n' });
    const el = h('div', { class: 'crow', tabindex: '-1' }, tag.el, p, t, m, v, h('span', { class: 'cr-w' }, wIc, wT, wTm), k, c, n);
    let icName = null, st = null;
    el.addEventListener('click', () => api.open?.(el.dataset.id));
    return {
      el,
      update(x) {
        if (st && st !== x.status) glitch(el);
        st = x.status; setData(el, 's', x.status); setData(el, 'id', x.id);
        tag.set(x.status);
        txt(p, x.project || '—'); setData(p, 'tip', x.project);
        const title = x.title || x.name || 'Untitled session'; txt(t, title); t.dataset.tip = title;
        txt(m, shortModel(x.model)); setData(m, 'tip', x.modelRaw);
        txt(v, provLetter(x.provider)); setData(v, 'p', x.provider); setData(v, 'tip', 'Runs on ' + provName(x.provider));
        let ic = 'clock', w = '';
        since(wTm, null); age(wTm, null);
        let tipW = '';
        if (x.status === 'needs-you') { ic = 'alert'; tipW = x.needsYou?.reason || 'Needs you'; w = shortReason(tipW); since(wTm, x.needsYou?.since); }
        else if (x.currentTool) { ic = toolIcon(x.currentTool.name); w = `${x.currentTool.name} · ${x.currentTool.summary || ''}`; }
        else if (x.status === 'idle') age(wTm, x.lastActivityAt, 'for ');   // the status tag already says idle / ended
        else if (x.status === 'ended') { ic = 'close'; age(wTm, x.endedAt, '', ' ago'); }
        if (ic !== icName) { icName = ic; wIc.replaceChildren(icon(ic)); }
        txt(wT, w); wT.dataset.tip = tipW || w;
        txt(k, fmtTok(headline(x.tokens))); setData(k, 'tip', `${fmtInt(headline(x.tokens))} tokens · cache read ${fmtTok(x.tokens?.cacheRead)}`);
        txt(c, x.context ? fmtPct(x.context.pct) : '—'); setData(c, 'lvl', ctxLevel(x.context?.pct));
        const running = (x.subagents || []).filter(a => a.state === 'running').length;
        txt(n, running ? '+' + running : ''); setData(n, 'tip', running ? plural(running, 'subagent running', 'subagents running') : null);
      },
    };
  }


  // ---- geometry ----------------------------------------------------------------------------------------------------------
  // Angles are degrees clockwise from the top.
  function arcD(cx, cy, r, a0, a1) {
    const P = a => { const t = (a - 90) * Math.PI / 180; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; };
    const [x0, y0] = P(a0), [x1, y1] = P(a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  function ellArc(cx, cy, rx, ry, a0, a1, ccw) {
    const P = a => { const t = (a - 90) * Math.PI / 180; return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)]; };
    const [x0, y0] = P(a0), [x1, y1] = P(a1);
    return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${rx.toFixed(1)} ${ry.toFixed(1)} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${ccw ? 0 : 1} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  function placeFlow(f, p, q) {
    const dx = q.x - p.x, dy = q.y - p.y;
    f.style.width = Math.hypot(dx, dy).toFixed(1) + 'px';
    f.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) rotate(${Math.atan2(dy, dx).toFixed(4)}rad)`;
  }
  const hexPts = R => [-90, -30, 30, 90, 150, 210].map(a => { const t = a * Math.PI / 180; return (R * Math.cos(t)).toFixed(2) + ',' + (R * Math.sin(t)).toFixed(2); }).join(' ');

  // ---- arc reactor ---------------------------------------------------------------------------------------------------------
  function reactor(opts = {}) {
    const S = opts.size || 232, C = S / 2, mini = !!opts.mini;
    const rSeg = mini ? C - 3 : C - 10, rTrack = mini ? C - 3 : C - 2, rTick = C - 26, rArc = C - 18, rSlot = C - 40, rIn = C - 47;
    const vb = `0 0 ${S} ${S}`;
    const svg = (...k) => s('svg', { class: 'r-svg', viewBox: vb, 'aria-hidden': 'true' }, ...k);
    const base = svg(s('circle', { class: 'r-track', cx: C, cy: C, r: rTrack, 'stroke-width': 1 }));
    if (!mini) base.append(s('circle', { class: 'r-track', cx: C, cy: C, r: rIn, 'stroke-width': 1 }));
    const segs = s('g');
    const mid = svg();
    if (!mini) {
      for (let a = 0; a < 360; a += 5) {
        const long = a % 30 === 0, t = (a - 90) * Math.PI / 180, r0 = rTick - (long ? 5 : 2), r1 = rTick + (long ? 5 : 2);
        mid.append(s('line', { class: 'r-tick', x1: C + r0 * Math.cos(t), y1: C + r0 * Math.sin(t), x2: C + r1 * Math.cos(t), y2: C + r1 * Math.sin(t), 'stroke-width': long ? 1.5 : 1 }));
      }
      for (const a of [20, 140, 260]) mid.append(s('path', { class: 'r-arc', d: arcD(C, C, rArc, a, a + 50), 'stroke-width': 1.5 }));
    }
    const slots = [];
    const inner = svg();
    if (!mini) for (let i = 0; i < 12; i++) { const p = s('path', { class: 'r-slot', d: arcD(C, C, rSlot, i * 30 + 4, i * 30 + 26), 'stroke-width': 4 }); inner.append(p); slots.push(p); }
    const num = odo('r-odo');
    const el = h('div', { class: 'reactor' + (mini ? ' mini' : ''), style: `width:${S}px;height:${S}px`, role: 'img', 'data-mode': 'idle' },
      h('div', { class: 'r-glow' }), h('div', { class: 'r-l' }, base), h('div', { class: 'r-l r-outer' }, svg(segs)), h('div', { class: 'r-l r-mid' }, mid),
      h('div', { class: 'r-l r-inner' }, inner), mini ? null : h('div', { class: 'r-core' }),
      h('div', { class: 'r-num' }, num.el, h('div', { class: 'r-lbl label', text: 'Agents working' })));
    let sig = null;
    return {
      el,
      update(sessions, totals, o = {}) {
        const live = sessions.filter(x => x.status !== 'ended');
        const running = totals.agentsRunning || 0;
        const mode = totals.needsYou > 0 ? 'alert' : running > 0 ? 'live' : live.length ? 'calm' : 'idle';
        setData(el, 'mode', mode);
        const rank = { 'needs-you': 0, busy: 1, idle: 2 };
        const list = live.map(x => x.status).sort((a, b) => rank[a] - rank[b]);
        if (list.join() !== sig) {
          sig = list.join();
          const n = list.length, gap = n > 1 ? Math.min(6, 90 / n) : 0, seg = n ? (360 - n * gap) / n : 0;
          segs.replaceChildren(...list.map((st, i) => {
            const a0 = n === 1 ? 0 : i * (seg + gap) + gap / 2, a1 = n === 1 ? 359.9 : a0 + seg;
            return s('path', { class: 'r-seg', 'data-s': st, d: arcD(C, C, rSeg, a0, a1), 'stroke-width': mini ? 3 : 6 });
          }));
        }
        slots.forEach((p, i) => p.classList.toggle('on', i < (totals.subagentsRunning || 0)));
        num.set(String(running), o.boot ? { from: 0 } : undefined);
        el.style.setProperty('--beat', (mode === 'idle' ? 8 : Math.max(4, 7 - 0.4 * running)).toFixed(2) + 's');
        el.setAttribute('aria-label', `${plural(running, 'agent', 'agents')} running, ${totals.needsYou || 0} waiting for you`);
      },
    };
  }

  // ---- vitals and account usage ----------------------------------------------------------------------------------------
  function vitals() {
    const mk = (label, wide) => {
      const n = odo(), sub = h('div', { class: 'vital-s', 'data-tip-if': 'trunc' }), num = h('div', { class: 'vital-n' }, n.el);
      return { el: h('div', { class: 'vital' + (wide ? ' wide' : '') }, h('div', { class: 'vital-l label', text: label }), num, sub), n, sub, num };
    };
    const S = mk('Sessions'), A = mk('Subagents'), T = mk('Tokens today', true), N = mk('Need you'), P = mk('Plans');
    const sub2 = h('div', { class: 'vital-s', 'data-tip-if': 'trunc' }); T.el.append(sub2);
    const acctRows = h('div', { class: 'acct' });
    const acct = h('div', { class: 'vital wide acct-v', hidden: true }, h('div', { class: 'vital-l label', text: 'Account limits' }), acctRows);
    const meter = label => {
      const f = h('span', { class: 'bar-f' }), v = h('span', { class: 'mv mono' }), note = h('span', { class: 'mn mono' });
      const row = [h('span', { class: 'ml label', text: label }), h('span', { class: 'bar bar-acct' }, f), v, note];
      return { row, set(w) { const p = w && w.pct; f.style.transform = `scaleX(${p == null ? 0 : Math.min(1, p / 100)})`; txt(v, fmtPct(p)); f.style.backgroundColor = p >= 90 ? 'var(--alert)' : p >= 70 ? 'var(--amber)' : ''; setData(note, 'pre', 'resets in '); setData(note, 'until', w && w.resetsAt); txt(note, w && w.resetsAt ? 'resets in ' + fmtAge(w.resetsAt - now()) : ''); } };
    };
    const five = meter('5-hour'), week = meter('Weekly');
    acctRows.append(...five.row, ...week.row);
    const el = h('div', { class: 'vitals' }, N.el, S.el, A.el, P.el, T.el, acct);
    return {
      el,
      update(st, o = {}) {
        const t = st.totals || {}, from = o.boot ? { from: 0 } : undefined;
        const live = (st.sessions || []).filter(x => x.status !== 'ended');
        const idle = live.filter(x => x.status === 'idle').length;
        S.n.set(String(t.sessions || 0), from);
        txt(S.sub, `${t.busy || 0} busy · ${idle} idle`);
        const doneSubs = shownSessions(st.sessions || []).reduce((n, x) => n + (x.subagents || []).filter(a => a.state === 'done').length, 0);   // the same sessions the network draws
        A.n.set(String(t.subagentsRunning || 0), from);
        txt(A.sub, `running · ${doneSubs} finished`);
        const tt = t.tokensToday || {};
        T.n.set(fmtTok(headline(tt)), from);
        txt(T.sub, `in ${fmtTok(tt.input)} · out ${fmtTok(tt.output)} · write ${fmtTok(tt.cacheWrite)}`);
        txt(sub2, `cache read ${fmtTok(tt.cacheRead)}, counted apart`);
        N.n.set(String(t.needsYou || 0), from);
        N.num.classList.toggle('alert', (t.needsYou || 0) > 0);
        txt(N.sub, t.plansNeedingYou ? `sessions + ${plural(t.plansNeedingYou, 'plan', 'plans')}` : 'sessions');
        P.n.set(String(t.plansInProgress || 0), from);
        txt(P.sub, `in progress of ${(st.plans || []).length}`);
        for (const e of [S.sub, A.sub, T.sub, N.sub, P.sub, sub2]) e.dataset.tip = e.textContent;
        const a = st.account;
        show(acct, !!(a && (a.fiveHour || a.sevenDay)));
        if (a) { five.set(a.fiveHour); week.set(a.sevenDay); }
      },
    };
  }

  // ---- usage from outside Claude Code (D12) --------------------------------------------------------------------------
  function externals() {
    const list = h('div'), err = h('div', { class: 'ext-err', hidden: true });
    const el = h('div', {}, list, err);
    const rows = new Map();
    const row = () => {
      const prov = provBadge(), name = h('span', { class: 'ext-n trunc', 'data-tip-if': 'trunc' }), k = h('span', { class: 'ext-k' });
      const src = h('span', { class: 'label' }), model = h('span'), win = h('span'), delayed = h('span', { class: 'chip warn', text: 'Delayed', hidden: true });
      const e = h('div', { class: 'ext-row' }, prov.el, name, k, h('div', { class: 'ext-d' }, src, model, win, delayed));
      return {
        el: e,
        set(x) {
          prov.set(x.provider, x.modelRaw);
          const n = x.app || shortModel(x.model) || x.model || 'unknown'; txt(name, n); name.dataset.tip = n;
          txt(k, fmtTok(headline(x.tokens))); setData(k, 'tip', `in ${fmtInt(x.tokens?.input)} · out ${fmtInt(x.tokens?.output)} · cache read ${fmtInt(x.tokens?.cacheRead)}`);
          txt(src, x.source === 'cloudwatch' ? 'CloudWatch' : 'Ingest'); txt(model, x.app ? shortModel(x.model) : '');
          txt(win, x.windowEnd ? 'to ' + fmtClock(x.windowEnd).slice(0, 5) : ''); show(delayed, !!x.delayed);
          setData(delayed, 'tip', x.delayed ? 'CloudWatch publishes a few minutes late, and per model, not per app' : null);
        },
      };
    };
    return {
      el,
      update(ext, error) {
        reconcile(list, rows, ext || [], x => x.source + '|' + (x.app || '') + '|' + x.model, row, (r, x) => r.set(x), false);
        txt(err, error || ''); show(err, !!error);
      },
    };
  }

  // ---- network: who started whom --------------------------------------------------------------------------------------------
  const SWEEP_MS = 8000;
  let netSeq = 0;
  function network(api = {}) {
    const uid = 'net' + (++netSeq);
    const sweepIn = h('i'), sweep = h('div', { class: 'net-sweep', 'aria-hidden': 'true' }, sweepIn);
    const gR = s('g', { class: 'net-rings' }), gG = s('g'), gE = s('g'), gP = s('g');
    const svg = s('svg', { class: 'net-svg', 'aria-hidden': 'true' }, gR, gG, gE, gP);
    const hubLabel = h('span', { class: 'hub-label label' });
    const hub = h('div', { class: 'net-hub', 'aria-hidden': 'true' }, h('span', { class: 'hub-ring' }), h('span', { class: 'hub-core' }), hubLabel);
    const layer = h('div', { class: 'net-nodes', role: 'group', 'aria-label': 'Agent network: who started whom. Arrow keys move between agents, Enter pins one, Escape unpins.' });
    const empty = h('div', { class: 'net-empty', hidden: true }, h('span', { class: 'label', text: 'No active sessions' }), h('span', { text: ' · systems nominal' }));
    const legend = h('div', { class: 'net-legend label', 'aria-hidden': 'true', hidden: true },
      h('span', {}, h('i', { class: 'dash' }), 'Running'), h('span', {}, h('i', { class: 'dbl' }), 'Launched by'),
      h('span', { text: 'Size = tokens' }), h('span', { text: 'Ring = context' }), h('span', { text: 'A / B = Anthropic / Bedrock' }));
    const readout = h('div', { class: 'net-readout', hidden: true }), readBox = h('div', { class: 'tip-b cutbox' });
    readout.append(readBox);
    const pinBox = h('div', { class: 'net-pin', hidden: true });
    const flowLayer = h('div', { class: 'net-flows', 'aria-hidden': 'true' });
    const el = h('div', { class: 'net' }, sweep, svg, flowLayer, hub, layer, empty, legend, readout, pinBox);
    const nodes = new Map(), edges = new Map(), expanded = new Set();
    let W = 0, H = 0, data = null, cx = {}, hubXY = { x: 0, y: 0 }, drawn = false, tween = 0, sweepAnim = null;
    let pinnedId = null, pinFor = null, pinCard = null, hoverId = null, rovingId = null, groupSig = '', ringSig = '';

    new ResizeObserver(() => {
      const w = el.clientWidth, hh = el.clientHeight;
      if (Math.abs(w - W) < 1 && Math.abs(hh - H) < 1) return;
      W = w; H = hh; if (data) render();
    }).observe(el);
    motion.on(() => retime(true));

    // Items: sessions (depth 0) and their subagents. A parent keeps its 3 newest finished subagents in view and folds
    // older ones into a numbered satellite, so its tree stays close to it; above 40 nodes every finished one folds.
    function graph(sessions) {
      const shown = shownSessions(sessions);
      if (!shown.some(x => x.status !== 'ended')) return [];
      let items = [];
      for (const x of shown) {
        items.push({ id: x.id, kind: 'session', parent: null, depth: 0, x, state: x.status, tokens: headline(x.tokens), project: x.project || 'Unknown', startedAt: x.startedAt || 0 });
        const ids = new Set((x.subagents || []).map(a => a.id));
        for (const a of x.subagents || []) items.push({ id: a.id, kind: 'sub', parent: ids.has(a.parentId) ? a.parentId : x.id, session: x.id, depth: 1, x: a, state: a.state === 'done' ? 'done' : 'running', tokens: headline(a.tokens), startedAt: a.startedAt || 0 });
      }
      const byId = new Map(items.map(i => [i.id, i]));
      for (const i of items) { let d = 0, p = i, g = 0; while (p && p.kind === 'sub' && g++ < 10) { d++; p = byId.get(p.parent); } i.depth = d; }
      const kids = new Map();
      for (const i of items) if (i.parent) { if (!kids.has(i.parent)) kids.set(i.parent, []); kids.get(i.parent).push(i); }
      const allDone = id => (kids.get(id) || []).every(k => k.state === 'done' && allDone(k.id));
      const keep = items.length > 40 ? 0 : 3, drop = new Set(), sats = [];
      for (const p of items) {
        if (expanded.has(p.id)) continue;
        const done = (kids.get(p.id) || []).filter(k => k.kind === 'sub' && k.state === 'done' && allDone(k.id)).sort((a, b) => (b.x.endedAt || 0) - (a.x.endedAt || 0));
        const fold = done.slice(keep);
        if (fold.length < 2) continue;
        let count = 0;
        const mark = k => { drop.add(k.id); count++; for (const kk of kids.get(k.id) || []) mark(kk); };
        fold.forEach(mark);
        sats.push({ id: 'sat:' + p.id, kind: 'sat', parent: p.id, session: p.session || p.id, depth: p.depth + 1, state: 'sat', count, tokens: 0, startedAt: Infinity, x: null });
      }
      if (drop.size) items = items.filter(i => !drop.has(i.id)).concat(sats.filter(t => !drop.has(t.parent)));   // a satellite folded into its parent's goes too
      return items;
    }

    // Radial tree: sessions on the inner ring grouped by project, one ring per depth, fitted into the panel.
    function layout(items) {
      const kids = new Map();
      for (const i of items) { const p = i.parent || 'hub'; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(i); }
      for (const l of kids.values()) l.sort((a, b) => a.startedAt - b.startedAt);
      // A subtree's share of the circle: its leaves, a finished (small, dim) leaf counting half.
      const wt = new Map();
      const weigh = i => { let n = 0; for (const k of kids.get(i.id) || []) n += weigh(k); const v = Math.max(i.kind === 'session' || i.state === 'running' ? 1 : 0.5, n); wt.set(i.id, v); return v; };
      // Order never depends on state, so a node doesn't swap places when its session starts or stops working.
      const sessions = (kids.get('hub') || []).slice().sort((a, b) => a.project.localeCompare(b.project) || a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
      sessions.forEach(weigh);
      const groups = new Map();
      for (const x of sessions) { if (!groups.has(x.project)) groups.set(x.project, []); groups.get(x.project).push(x); }
      const G = [...groups].map(([name, list]) => ({ name, list, w: list.reduce((n, x) => n + wt.get(x.id), 0) }));
      const total = G.reduce((n, g) => n + g.w, 0) || 1;
      const gap = G.length > 1 ? Math.min(14, 60 / G.length) : 0, avail = 360 - gap * G.length;
      const maxDepth = items.reduce((m, i) => Math.max(m, i.depth), 0);
      const S0 = Math.max(80, Math.min(W - 160, H - 128) / 2);
      const R0 = maxDepth === 0 ? 1 : Math.min(0.6, Math.max(0.46, sessions.length * 40 / (2 * Math.PI * S0)));
      const ring = d => maxDepth === 0 ? 1 : R0 + d * ((1 - R0) / maxDepth);
      // Children fan out only as far as they need (about 64 px of their ring per leaf), so a tree stays next to its parent.
      const place = (i, a0, a1) => {
        i.theta = (a0 + a1) / 2; i.ring = ring(i.depth);
        const ks = kids.get(i.id) || []; if (!ks.length) return;
        const perLeaf = 64 / (S0 * ring(i.depth + 1)) * 180 / Math.PI, tot = ks.reduce((n, k) => n + wt.get(k.id), 0);
        const spread = Math.min(a1 - a0, Math.max(1, tot) * perLeaf, i.depth === 0 ? 140 : 100);
        let c = i.theta - spread / 2;
        for (const k of ks) { const sp = spread * wt.get(k.id) / tot; place(k, c, c + sp); c += sp; }
      };
      let a = sessions.length === 1 ? 90 - avail / 2 : -gap / 2;
      for (const g of G) {
        const span = avail * g.w / total; g.a0 = a; g.a1 = a + span;
        let b = a; for (const x of g.list) { const sp = span * wt.get(x.id) / g.w; place(x, b, b + sp); b += sp; }
        a += span + gap;
      }
      // A crowded session ring: every other session (and its subtree) steps outwards, so neighbours don't overlap.
      const per = 2 * Math.PI * S0 * ring(0) * (avail / 360) / Math.max(1, sessions.length);
      if (sessions.length > 6 && per < 48) {
        const bump = (i, b) => { i.ring += b; for (const k of kids.get(i.id) || []) bump(k, b); };
        sessions.slice().sort((p, q) => p.theta - q.theta).forEach((x, k) => { if (k % 2) bump(x, maxDepth ? 0.11 : 0.16); });
      }
      for (const i of items) { const t = i.theta * Math.PI / 180; i.ux = Math.sin(t) * i.ring; i.uy = -Math.cos(t) * i.ring; }
      let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
      for (const i of items) { x0 = Math.min(x0, i.ux); x1 = Math.max(x1, i.ux); y0 = Math.min(y0, i.uy); y1 = Math.max(y1, i.uy); }
      const padX = W < 520 ? 56 : 96, padY = H < 300 ? 48 : 76, bottom = W >= 560 ? 24 : 0;
      let sx = (W - 2 * padX) / Math.max(x1 - x0, 0.5), sy = (H - 2 * padY - bottom) / Math.max(y1 - y0, 0.5);
      const sMin = Math.min(sx, sy), sMax = maxDepth === 0 ? Math.max(120, Math.min(220, Math.min(W, H) * 0.4)) : Math.min(W, H) * 0.8;
      sx = Math.min(sx, sMin * 1.7, sMax * 1.7); sy = Math.min(sy, sMin * 1.7, sMax);
      const ox = W / 2 - (x0 + x1) / 2 * sx, oy = (H - bottom) / 2 - (y0 + y1) / 2 * sy;
      for (const i of items) { i.px = ox + i.ux * sx; i.py = oy + i.uy * sy; }
      hubXY = { x: ox, y: oy };
      let dmin = Infinity;
      for (let p = 0; p < items.length; p++) {
        const A = items[p]; dmin = Math.min(dmin, Math.hypot(A.px - ox, A.py - oy));
        for (let q = p + 1; q < items.length; q++) dmin = Math.min(dmin, Math.hypot(A.px - items[q].px, A.py - items[q].py));
      }
      // Size = tokens: a square-root scale over a 3× range, so every token counts and the busiest agent is the biggest.
      const rMax = Math.max(14, Math.min(34, dmin * 0.4)), rMin = Math.max(7, rMax / 3);
      const tMax = Math.max(1, ...items.map(i => i.tokens));
      for (const i of items) {
        i.r = i.kind === 'sat' ? rMin + 3 : rMin + (rMax - rMin) * Math.sqrt(Math.min(1, i.tokens / tMax));
        if (i.state === 'needs-you') i.r = Math.max(i.r, rMin + 0.6 * (rMax - rMin));   // what needs you is never the smallest thing
      }
      return { G, sx, sy, ring, maxDepth, rMax, crowded: items.length > 12 || dmin < 70 };
    }

    // Labels: the title (or subagent type) and "model · context · tokens", on the side away from the hub when there is
    // room; shorter when crowded, but the numbers next to the ring are always there.
    const CHAR = { body: 6.1, mono: 6.7, label: 6.9 };
    function labelText(i, mode) {
      const x = i.x;
      if (i.kind === 'sat') return ['', 'finished'];
      const pct = x.context ? fmtPct(x.context.pct) : 'ctx —', tok = fmtTok(headline(x.tokens));
      if (mode === 'min') return ['', pct];
      const name = i.kind === 'session' ? (x.title || x.name || 'Untitled') : (x.type || 'agent');
      if (mode === 'short') return [name.length > 18 ? name.slice(0, 17).trimEnd() + '…' : name, `${pct} · ${tok}`];
      const meta = `${shortModel(x.model) || 'model ?'} · ${pct} · ${tok}`;
      if (mode === 'meta') return ['', meta];
      return [name, meta];
    }
    function labelBox(i, side, l1, l2) {
      const w = Math.max(l1 ? Math.min(180, l1.length * (i.kind === 'session' ? CHAR.body : CHAR.label)) : 0, Math.min(180, l2.length * CHAR.mono)) + 6;
      const hgt = (l1 ? 16 : 0) + 16, R = i.r + 14;
      if (side === 'b') return { x0: i.px - w / 2, x1: i.px + w / 2, y0: i.py + R, y1: i.py + R + hgt };
      if (side === 't') return { x0: i.px - w / 2, x1: i.px + w / 2, y0: i.py - R - hgt, y1: i.py - R };
      if (side === 'r') return { x0: i.px + R, x1: i.px + R + w, y0: i.py - hgt / 2, y1: i.py + hgt / 2 };
      return { x0: i.px - R - w, x1: i.px - R, y0: i.py - hgt / 2, y1: i.py + hgt / 2 };
    }
    const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
    function placeLabels(items, L) {
      const placed = [];
      const hw = hubLabel.textContent.length * CHAR.label / 2 + 6;
      placed.push({ x0: hubXY.x - hw, x1: hubXY.x + hw, y0: hubXY.y + 26, y1: hubXY.y + 44 }, { x0: hubXY.x - 24, x1: hubXY.x + 24, y0: hubXY.y - 24, y1: hubXY.y + 24 });
      const discs = items.map(i => ({ id: i.id, x0: i.px - i.r - 9, x1: i.px + i.r + 9, y0: i.py - i.r - 9, y1: i.py + i.r + 9 }));
      const prio = i => i.state === 'needs-you' ? 0 : i.kind === 'session' ? (i.state === 'busy' ? 1 : i.state === 'idle' ? 2 : 6) : i.kind === 'sub' ? (i.state === 'running' ? 3 : 4) : 5;
      const inPanel = b => b.x0 >= 2 && b.x1 <= W - 2 && b.y0 >= 2 && b.y1 <= H - (W >= 560 ? 26 : 2);
      for (const i of items.slice().sort((a, b) => prio(a) - prio(b) || b.r - a.r)) {
        const r = nodes.get(i.id), outward = i.py < hubXY.y - 4 ? 't' : 'b', other = outward === 't' ? 'b' : 't';
        const horiz = i.px < hubXY.x ? ['l', 'r'] : ['r', 'l'];
        // a name says what is running, so it comes before the model line; crowded nodes get a short name or just the number
        const modes = i.kind === 'sat' ? ['meta'] : !L.crowded || i.state === 'needs-you' ? ['full', 'short', 'meta', 'min'] : i.kind === 'session' || i.state === 'running' ? ['short', 'min'] : ['min'];
        const sides = [outward, ...horiz, other];
        const prev = r && r.lbl ? [[r.lbl.mode, r.lbl.side]] : [];
        let pick = null;
        const tryIt = (mode, side) => {
          if (!modes.includes(mode)) return false;
          const [l1, l2] = labelText(i, mode), b = labelBox(i, side, l1, l2);
          if (!inPanel(b) || placed.some(p => overlaps(p, b)) || discs.some(d => d.id !== i.id && overlaps(d, b))) return false;
          pick = { mode, side, l1, l2, b }; return true;
        };
        for (const [m, sd] of prev) if (tryIt(m, sd)) break;   // stable: keep last frame's placement while it still fits
        if (!pick) outer: for (const m of modes) for (const sd of sides) if (tryIt(m, sd)) break outer;
        if (!pick && i.state === 'needs-you') { const [l1, l2] = labelText(i, 'min'); pick = { mode: 'min', side: outward, l1, l2, b: labelBox(i, outward, l1, l2) }; }
        if (!pick) { i.lbl = { mode: 'none', side: outward, l1: '', l2: '' }; continue; }   // no room: no label, and no ring without its number
        placed.push(pick.b);
        i.lbl = pick;
      }
    }

    function makeNode(i) {
      const glowE = h('span', { class: 'nf-glow' }), ping = h('span', { class: 'nf-ping' }), spk = h('span', { class: 'nf-spark' });
      const spin = h('span', { class: 'nf-spin', hidden: true }), face = s('svg', { class: 'nf-svg', 'aria-hidden': 'true' });
      const btn = h('button', { class: 'nn', type: 'button', tabindex: '-1' }, glowE, ping, face, spin, spk);
      const l1 = h('span', { class: 'nl1 trunc' }), l2 = h('span', { class: 'nl2' }), lab = h('div', { class: 'nl side-b', 'aria-hidden': 'true' }, l1, l2);
      const nf = h('div', { class: 'nf', style: `--fd:${(7 + Math.random() * 4).toFixed(1)}s;--fdl:${(-Math.random() * 9).toFixed(1)}s` }, btn, lab);
      const r = { id: i.id, el: h('div', { class: 'na' }, nf), btn, face, spin, glowE, ping, spk, l1, l2, lab, x: null, y: null, tx: 0, ty: 0, rad: 0, sig: '', item: i, state: null, lbl: null };
      btn.addEventListener('pointerenter', () => hover(r, true));
      btn.addEventListener('pointerleave', () => hover(r, false));
      btn.addEventListener('focus', () => { rovingId = r.id; roving(); hover(r, true); });
      btn.addEventListener('blur', () => hover(r, false));
      btn.addEventListener('click', () => { if (r.item.kind === 'sat') { expanded.add(r.item.parent); render(); } else togglePin(r.id); });
      return r;
    }
    const FACE_GLYPH = { 'needs-you': 'needs', busy: 'busy', idle: 'idle', ended: 'ended', running: 'running', done: 'done' };
    function drawFace(r, i) {
      const R = Math.round(i.r * 2) / 2, x = i.x, prov = x ? x.provider : null, ringOn = !i.lbl || i.lbl.mode !== 'none';
      const pct = x && x.context && ringOn ? x.context.pct : null;
      const sig = [R, i.state, i.kind, pct == null ? '-' : Math.round(pct), prov, i.count || 0, ringOn].join('|');
      if (sig === r.sig) return;
      const oldR = r.rad; r.sig = sig; r.rad = R;
      const pad = 18, S = 2 * (R + pad), half = R + 6;
      Object.assign(r.btn.style, { left: -half + 'px', top: -half + 'px', width: 2 * half + 'px', height: 2 * half + 'px' });
      setAttr(r.face, 'width', S); setAttr(r.face, 'height', S); setAttr(r.face, 'viewBox', `${-R - pad} ${-R - pad} ${S} ${S}`);
      r.face.style.left = r.face.style.top = (half - R - pad) + 'px';
      const box = (e, rr) => Object.assign(e.style, { left: (half - rr) + 'px', top: (half - rr) + 'px', width: 2 * rr + 'px', height: 2 * rr + 'px' });
      box(r.glowE, R * 2); box(r.ping, R + 8); box(r.spk, R + 2); box(r.spin, R + 11);
      r.lab.style.setProperty('--R', (R + 14) + 'px');
      const k = [];
      if (i.kind !== 'sat' && ringOn) {
        k.push(s('circle', { class: 'nf-ctx-t', r: R + 6 }));
        if (pct != null) k.push(s('path', { class: 'nf-ctx', 'data-lvl': ctxLevel(pct), d: arcD(0, 0, R + 6, 0, Math.max(2, Math.min(359.5, pct * 3.6))) }));
      }
      k.push(s('polygon', { class: 'nf-hex', points: hexPts(R) }));
      if (i.kind === 'session' && R >= 18) k.push(s('polygon', { class: 'nf-inner', points: hexPts(R * 0.72) }));
      if (i.kind === 'sat') k.push(s('text', { class: 'nf-letter', y: 1 }, '+' + i.count));
      else {
        // the status shape sits in the centre, the same glyph as on the cards
        const gs = Math.max(9, Math.min(18, R * 0.9)), g = s('g', { class: 'nf-glyph', transform: `translate(${-gs / 2} ${-gs / 2}) scale(${gs / 16})` });
        for (const [t, a] of GLYPHS[FACE_GLYPH[i.state] || 'idle']) g.append(s(t, Object.assign({ 'vector-effect': 'non-scaling-stroke' }, a)));
        k.push(g);
        // provider: a one-letter tag on the rim
        const tx = R * 0.74 + 4, ty = -R * 0.74 - 4;
        k.push(s('rect', { class: 'nf-tag', x: tx - 7, y: ty - 6.5, width: 14, height: 13 }), s('text', { class: 'nf-tag-t', x: tx, y: ty + 0.5 }, provLetter(prov)));
      }
      k.push(s('circle', { class: 'nf-focus', r: R + 13 }));
      r.face.replaceChildren(...k);
      if (oldR && Math.abs(oldR - R) >= 1 && !motion.rm) r.face.animate([{ transform: `scale(${(oldR / R).toFixed(3)})` }, { transform: 'none' }], { duration: 400, easing: EASE });
    }
    function setSpinner(r, i) {
      const on = i.state === 'busy' || i.state === 'running';
      show(r.spin, on);
      if (on && r.spinR !== r.rad) {
        r.spinR = r.rad; const c = r.rad + 11;
        r.spin.replaceChildren(s('svg', { viewBox: `0 0 ${2 * c} ${2 * c}` }, ...[0, 120, 240].map(a => s('path', { d: arcD(c, c, c - 1, a, a + 46) }))));
      }
    }
    function setLabel(r, i) {
      const L = i.lbl || { mode: 'min', side: 'b', l1: '', l2: '' };
      if (r.lbl && r.lbl.side !== L.side) r.lab.classList.remove('side-' + r.lbl.side);
      r.lab.classList.add('side-' + L.side);
      r.lbl = { mode: L.mode, side: L.side };
      r.l1.classList.toggle('is-type', i.kind !== 'session');
      txt(r.l1, L.l1); show(r.l1, !!L.l1); txt(r.l2, L.l2); show(r.l2, !!L.l2);
    }
    function nodeLabel(i) {
      const x = i.x;
      if (i.kind === 'sat') return `${plural(i.count, 'finished subagent', 'finished subagents')}, folded. Enter expands them.`;
      const who = i.kind === 'session' ? `Session in ${x.project || 'an unknown project'}: ${x.title || x.name || 'untitled'}` : `Subagent ${x.type || ''}: ${x.description || ''}`;
      return `${who}. ${(STATUS[i.state] || STATUS.unknown)[1]}. ${shortModel(x.model) || 'Model unknown'} on ${provName(x.provider)}. ${fmtTok(headline(x.tokens))} tokens. Context ${x.context ? fmtPct(x.context.pct) : 'unknown'}.`;
    }
    function nodeCard(i) {
      const x = i.x;
      if (i.kind === 'sat') return h('div', { class: 'tc' }, h('div', { class: 'tc-t', text: plural(i.count, 'finished subagent', 'finished subagents') }), h('div', { class: 'tc-n', text: 'Folded to keep the network readable. Click to expand.' }));
      const tag = statusTag(); tag.set(i.state);
      const t = x.tokens || {}, tool = x.currentTool, end = x.endedAt || null;
      return h('div', { class: 'tc' },
        h('div', { class: 'tc-h' }, tag.el, h('span', { class: 'label c-ink2 trunc', text: i.kind === 'session' ? (x.project || '') : `Subagent · level ${i.depth}` })),
        h('div', { class: 'tc-t', text: i.kind === 'session' ? (x.title || x.name || 'Untitled session') : `${x.type || 'agent'}: ${x.description || ''}` }),
        h('div', { class: 'tc-r' }, h('b', { text: shortModel(x.model) || 'model unknown' }), x.effort ? h('span', { text: x.effort }) : null,
          h('span', { text: '· ' + provName(x.provider) }), h('span', { text: '· ' + (end ? 'ran ' + fmtAge(end - (x.startedAt || end)) : 'running ' + fmtAge(now() - (x.startedAt || now()))) })),
        x.needsYou ? h('div', { class: 'tc-r c-alert' }, icon('alert'), h('span', { text: x.needsYou.reason })) : null,
        tool ? h('div', { class: 'tc-r' }, icon(toolIcon(tool.name)), h('b', { text: tool.name }), h('span', { class: 'trunc', style: 'max-width:240px', text: tool.summary || '' })) : null,
        h('div', { class: 'tc-r' }, h('span', { text: 'Tokens' }), h('b', { text: fmtTok(headline(t)) }), h('span', { text: `in ${fmtTok(t.input)} · out ${fmtTok(t.output)} · write ${fmtTok(t.cacheWrite)}` })),
        h('div', { class: 'tc-r' }, h('span', { text: 'Cache read' }), h('b', { text: fmtTok(t.cacheRead) }),
          i.kind === 'session' && headline(x.tokensTree) > headline(t) ? h('span', { text: `· with subagents ${fmtTok(headline(x.tokensTree))}` }) : null),
        h('div', { class: 'tc-r' }, h('span', { text: 'Context' }), h('b', { text: x.context ? fmtPct(x.context.pct) : '—' }), h('span', { text: x.context ? `${fmtTok(x.context.used)} of ${fmtTok(x.context.window)}` : 'window unknown' })));
    }

    // A tool call: the node ripples, and a packet runs down the edge from whoever started it.
    function spark(r) {
      if (motion.rm || !r.spk.animate) return;
      r.spk.animate([{ opacity: .9, transform: 'scale(.85)' }, { opacity: 0, transform: 'scale(1.75)' }], { duration: 650, easing: 'ease-out' });
      const p = pos(r.item.parent), q = { x: r.tx, y: r.ty };
      if (Math.hypot(q.x - p.x, q.y - p.y) < 12) return;
      const dot = h('span', { class: 'pkt' + (r.item.kind === 'sub' ? ' sub' : '') });
      flowLayer.append(dot);
      const a = dot.animate([
        { transform: `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) scale(.5)`, opacity: 0 },
        { transform: `translate(${((p.x + q.x) / 2).toFixed(1)}px, ${((p.y + q.y) / 2).toFixed(1)}px) scale(1)`, opacity: 1, offset: .5 },
        { transform: `translate(${q.x.toFixed(1)}px, ${q.y.toFixed(1)}px) scale(.5)`, opacity: 0 }], { duration: 600, easing: 'cubic-bezier(.4, 0, .2, 1)' });
      a.onfinish = a.oncancel = () => dot.remove();
    }
    const toolSig = i => i.x && i.x.currentTool ? i.x.currentTool.name + '@' + i.x.currentTool.since : null;
    const pos = id => { if (id == null) return hubXY; const r = nodes.get(id); return r && r.x != null ? { x: r.x, y: r.y } : hubXY; };

    function syncEdges(items) {
      const ids = new Set(items.map(i => i.id)), want = [];
      for (const i of items) {
        if (i.kind === 'session') {
          want.push({ key: 'h' + i.id, kind: 'spoke', a: null, b: i.id, st: i.state });
          const sb = i.x.startedBy; if (sb && ids.has(sb)) want.push({ key: 's' + i.id, kind: 'sby', a: sb, b: i.id });
        } else want.push({ key: 't' + i.id, kind: i.state === 'running' ? 'run' : 'done', a: i.parent, b: i.id, at: i.startedAt });
      }
      const flowing = new Set(want.filter(e => e.kind === 'run').sort((p, q) => (q.at || 0) - (p.at || 0)).slice(0, 3).map(e => e.key));
      const seen = new Set();
      for (const e of want) {
        seen.add(e.key);
        let rec = edges.get(e.key);
        if (!rec) {
          rec = { key: e.key, base: s('path', { class: 'e' }) }; gE.append(rec.base);
          if (e.kind === 'sby') { rec.inner = s('path', { class: 'e e-sby-i' }); gE.append(rec.inner); }
          edges.set(e.key, rec);
        }
        Object.assign(rec, { kind: e.kind, a: e.a, b: e.b });
        rec.base.classList.remove('e-spoke', 'e-sby-o', 'e-run', 'e-done');
        rec.base.classList.add(e.kind === 'spoke' ? 'e-spoke' : e.kind === 'sby' ? 'e-sby-o' : e.kind === 'run' ? 'e-run' : 'e-done');
        if (e.kind === 'spoke') setData(rec.base, 's', e.st);
        const fl = flowing.has(e.key);
        if (fl && !rec.flow) { rec.flow = h('div', { class: 'eflow' }, h('i')); flowLayer.append(rec.flow); }
        if (!fl && rec.flow) { rec.flow.remove(); rec.flow = null; }
      }
      for (const [k, rec] of edges) if (!seen.has(k)) { rec.base.remove(); rec.inner?.remove(); rec.flow?.remove(); edges.delete(k); }
    }
    function edgeD(rec) {
      const p = pos(rec.a), q = pos(rec.b), f = n => n.toFixed(1);
      if (rec.kind === 'sby') {
        const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2, c = { x: mx + (hubXY.x - mx) * 0.45, y: my + (hubXY.y - my) * 0.45 };
        return `M${f(p.x)} ${f(p.y)}Q${f(c.x)} ${f(c.y)} ${f(q.x)} ${f(q.y)}`;
      }
      return `M${f(p.x)} ${f(p.y)}L${f(q.x)} ${f(q.y)}`;
    }
    function drawEdges() { for (const rec of edges.values()) { const d = edgeD(rec); setAttr(rec.base, 'd', d); if (rec.inner) setAttr(rec.inner, 'd', d); if (rec.flow) placeFlow(rec.flow, pos(rec.a), pos(rec.b)); } }
    // Depth rings with tick marks: the radar scope the tree sits on (one ring per level).
    function drawRings(L, any) {
      const sig = [W, H, hubXY.x, hubXY.y, L.sx, L.sy, L.maxDepth, any].join('|');
      if (sig === ringSig) return; ringSig = sig;
      if (!any) { gR.replaceChildren(); return; }
      const out = [];
      for (let d = 0; d <= L.maxDepth; d++) out.push(s('ellipse', { class: 'n-ring' + (d === L.maxDepth ? ' outer' : ''), cx: hubXY.x, cy: hubXY.y, rx: L.ring(d) * L.sx, ry: L.ring(d) * L.sy }));
      const rx = L.ring(L.maxDepth) * L.sx + 14, ry = L.ring(L.maxDepth) * L.sy + 14;
      for (let a = 0; a < 360; a += 10) {
        const t = (a - 90) * Math.PI / 180, long = a % 30 === 0, c = Math.cos(t), sn = Math.sin(t), k = long ? 6 : 3;
        out.push(s('line', { class: 'n-tick' + (long ? ' long' : ''), x1: hubXY.x + rx * c, y1: hubXY.y + ry * sn, x2: hubXY.x + (rx + k) * c, y2: hubXY.y + (ry + k) * sn }));
      }
      gR.replaceChildren(...out);
      // the radar: a circle turning about the hub, seen through an ellipse fitted to the rings that fades at its rim
      const ew = 2 * (rx + 28), eh = 2 * (ry + 28), dd = 2 * Math.max(rx, ry) + 60;
      Object.assign(sweep.style, { width: ew + 'px', height: eh + 'px', left: (hubXY.x - ew / 2) + 'px', top: (hubXY.y - eh / 2) + 'px' });
      Object.assign(sweepIn.style, { width: dd + 'px', height: dd + 'px', left: (ew - dd) / 2 + 'px', top: (eh - dd) / 2 + 'px' });
    }
    // Project names run along the inner arc, after the node labels are placed: a node's name and numbers come first, and
    // a project name that finds no free stretch of arc is left to the node cards.
    function drawGroups(L, items) {
      const R0 = L.ring(0), rx = R0 * L.sx, ry = R0 * L.sy, band = Math.round(L.rMax * 2 + 4);
      const lbls = items.filter(i => i.lbl && i.lbl.b).map(i => i.lbl.b);
      const sig = [W, H, hubXY.x, hubXY.y, rx, ry, band, ...L.G.map(g => g.name + g.a0.toFixed(1) + g.a1.toFixed(1)), ...items.map(i => i.r.toFixed(0)), ...lbls.map(b => [b.x0, b.y0, b.x1].map(v => Math.round(v / 4)).join(','))].join('|');
      if (sig === groupSig) return; groupSig = sig;
      const out = [];
      if (L.G.length < 2) { gG.replaceChildren(); return; }   // one project: its name sits under the hub instead
      const discs = items.map(i => ({ x: i.px, y: i.py, r: i.r + 18 }));   // + the glyphs, which sit up to 9 px off the path
      const free = p => !discs.some(d => Math.hypot(d.x - p.x, d.y - p.y) < d.r) && !lbls.some(b => p.x > b.x0 - 6 && p.x < b.x1 + 6 && p.y > b.y0 - 10 && p.y < b.y1 + 10);
      L.G.forEach((g, gi) => {
        const full = g.a1 - g.a0 >= 359, a0 = full ? 0 : g.a0 + 1.5, a1 = full ? 359.9 : g.a1 - 1.5;
        const ar = (r0, a) => { const t = (a - 90) * Math.PI / 180; return [hubXY.x + (rx + r0) * Math.cos(t), hubXY.y + (ry + r0) * Math.sin(t)]; };
        if (a1 > a0) {
          out.push(s('path', { class: 'g-arc', d: ellArc(hubXY.x, hubXY.y, rx - band / 2, ry - band / 2, a0, a1) }));
          if (!full) for (const a of [a0, a1]) { const [x0, y0] = ar(-band / 2 - 4, a), [x1, y1] = ar(-band / 2 + 4, a); out.push(s('line', { class: 'g-tick', x1: x0, y1: y0, x2: x1, y2: y1 })); }
        }
        const lrx = rx - band / 2 - 10, lry = ry - band / 2 - 10;
        if (lrx < 36 || lry < 36) return;
        const chars = g.name.length, need = chars * 8.4 + 8;                          // the label's arc length, in px
        const deg = need / (((lrx + lry) / 2) * Math.PI / 180);
        const pt = a => { const t = (a - 90) * Math.PI / 180; return { x: hubXY.x + lrx * Math.cos(t), y: hubXY.y + lry * Math.sin(t) }; };
        const clear = a => { for (let k = 0; k <= 8; k++) if (!free(pt(a - deg / 2 + k * deg / 8))) return false; return true; };
        let mid = (g.a0 + g.a1) / 2, best = null;
        for (const off of [0, -8, 8, -16, 16, -24, 24, -36, 36]) { const m = mid + off; if ((full || (m - deg / 2 >= g.a0 - 4 && m + deg / 2 <= g.a1 + 4)) && clear(m)) { best = m; break; } }
        if (best == null) return;   // no free stretch of arc: the project shows in the node's card instead
        mid = best;
        const b0 = mid - deg / 2 - 2, b1 = mid + deg / 2 + 2;
        const m = ((mid % 360) + 360) % 360, lower = m > 90 && m < 270, id = `${uid}-g${gi}`;
        out.push(s('path', { id, d: lower ? ellArc(hubXY.x, hubXY.y, lrx, lry, b1, b0, true) : ellArc(hubXY.x, hubXY.y, lrx, lry, b0, b1), fill: 'none' }));
        out.push(s('text', { class: 'g-lbl', dy: lower ? 10 : -2 }, s('textPath', { href: '#' + id, startOffset: '50%', 'text-anchor': 'middle' }, g.name)));
      });
      gG.replaceChildren(...out);
    }

    function placeNode(r) { r.el.style.transform = `translate3d(${r.x.toFixed(1)}px, ${r.y.toFixed(1)}px, 0)`; }
    function moveAll() {
      const list = [...nodes.values()];
      cancelAnimationFrame(tween); tween = 0;
      const moving = list.some(r => Math.abs(r.x - r.tx) > 0.5 || Math.abs(r.y - r.ty) > 0.5);
      if (!moving || motion.rm) { for (const r of list) { r.x = r.tx; r.y = r.ty; placeNode(r); } drawEdges(); settle(moving); return; }
      const from = list.map(r => [r, r.x, r.y]), t0 = performance.now();
      const step = t => {
        const k = Math.min(1, (t - t0) / 450), e = easeOut(k);
        for (const [r, fx, fy] of from) { r.x = fx + (r.tx - fx) * e; r.y = fy + (r.ty - fy) * e; placeNode(r); }
        drawEdges();
        if (k < 1) tween = requestAnimationFrame(step); else { tween = 0; settle(true); }
      };
      tween = requestAnimationFrame(step);
    }
    function settle(moved) { for (const r of nodes.values()) if (r.pulse) { r.pulse = false; returnPulse(r); } if (moved) retime(false); }
    // "Handed the result back": a bright pulse travels from the finished child to its parent, then the edge dims.
    function returnPulse(r) {
      r.el.classList.remove('just-done'); void r.el.offsetWidth; r.el.classList.add('just-done');
      setTimeout(() => r.el.classList.remove('just-done'), 1600);
      const rec = edges.get('t' + r.id), p = pos(r.item.parent), q = { x: r.x, y: r.y };
      if (motion.rm) { if (rec) { rec.base.classList.add('flash'); setTimeout(() => rec.base.classList.remove('flash'), 400); } return; }
      const len = Math.hypot(p.x - q.x, p.y - q.y); if (len < 4) return;
      const path = s('path', { class: 'e e-pulse', d: `M${q.x.toFixed(1)} ${q.y.toFixed(1)}L${p.x.toFixed(1)} ${p.y.toFixed(1)}`, 'stroke-dasharray': `14 ${Math.ceil(len + 28)}` });
      gP.append(path);
      const an = path.animate([{ strokeDashoffset: 14 }, { strokeDashoffset: -len }], { duration: Math.min(900, 380 + len * 1.6), easing: 'cubic-bezier(.4, 0, .2, 1)' });
      an.onfinish = an.oncancel = () => path.remove();
    }
    // Radar sweep (ambient): every node pings when the sweep passes it, on the shared document timeline.
    function retime(force) {
      if (!motion.ambient) {
        if (sweepAnim) { sweepAnim.cancel(); sweepAnim = null; }
        for (const r of nodes.values()) if (r.pingAnim) { r.pingAnim.cancel(); r.pingAnim = null; r.pingAng = null; }
        return;
      }
      if (!sweepAnim) { sweepAnim = sweepIn.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: SWEEP_MS, iterations: Infinity }); sweepAnim.startTime = 0; }
      for (const r of nodes.values()) {
        const ang = (Math.atan2(r.tx - hubXY.x, -(r.ty - hubXY.y)) * 180 / Math.PI + 360) % 360;
        if (!force && r.pingAnim && Math.abs(ang - r.pingAng) < 1) continue;
        if (r.pingAnim) r.pingAnim.cancel();
        r.pingAng = ang;
        r.pingAnim = r.ping.animate([{ opacity: 0, transform: 'scale(.9)' }, { opacity: .9, transform: 'scale(1)', offset: .004 }, { opacity: 0, transform: 'scale(1.45)', offset: .1 }, { opacity: 0, transform: 'scale(1.45)' }],
          { duration: SWEEP_MS, iterations: Infinity, delay: ang / 360 * SWEEP_MS - SWEEP_MS });
        r.pingAnim.startTime = 0;
      }
    }

    function chain(id) { const out = new Set(); let cur = nodes.get(id), g = 0; while (cur && g++ < 12) { out.add(cur.id); cur = cur.item.parent ? nodes.get(cur.item.parent) : null; } return out; }
    function highlight() {
      const id = hoverId || pinnedId, on = id && nodes.has(id) ? chain(id) : new Set();
      el.classList.toggle('hl-on', on.size > 0);
      for (const r of nodes.values()) { r.el.classList.toggle('hl', on.has(r.id)); r.el.classList.toggle('pinned', r.id === pinnedId); }
      for (const rec of edges.values()) {
        const lit = rec.kind !== 'sby' && on.has(rec.b) && (rec.a == null || on.has(rec.a));
        rec.base.classList.toggle('hl', lit); if (rec.flow) rec.flow.classList.toggle('hl', lit); if (rec.inner) rec.inner.classList.toggle('hl', lit);
      }
    }
    // Floating cards dock in a corner that covers neither the node they describe nor anything that needs you: the top
    // corner away from the node first, so the lit path to the hub stays in view.
    function dock(r, w, hh, spots) {
      const avoid = [...nodes.values()].filter(n => n === r || n.state === 'needs-you').map(n => ({ x0: n.tx - n.rad - 12, x1: n.tx + n.rad + 12, y0: n.ty - n.rad - 12, y1: n.ty + n.rad + 12 }));
      const away = r.tx > W / 2 ? 'left' : 'right', near = away === 'left' ? 'right' : 'left', bottom = W >= 560 ? 28 : 0;
      const box = ([sx, sy]) => { const x0 = sx === 'left' ? 0 : W - w, y0 = sy === 'top' ? 0 : H - bottom - hh; return { x0, x1: x0 + w, y0, y1: y0 + hh }; };
      const hits = sp => avoid.filter(a => overlaps(a, box(sp))).length;
      return spots.map(([a, y]) => [a === 'away' ? away : near, y]).reduce((b, sp) => hits(sp) < hits(b) ? sp : b);
    }
    function showReadout(r) {
      readBox.replaceChildren(nodeCard(r.item));
      show(readout, true);
      const [x, y] = dock(r, readout.offsetWidth, readout.offsetHeight, [['away', 'top'], ['near', 'top'], ['away', 'bottom'], ['near', 'bottom']]);
      readout.classList.toggle('left', x === 'left'); readout.classList.toggle('right', x === 'right'); readout.classList.toggle('bottom', y === 'bottom');
    }
    function hover(r, on) {
      if (on) { hoverId = r.id; if (r.id !== pinnedId) showReadout(r); }
      else if (hoverId === r.id) { hoverId = null; show(readout, false); }
      highlight();
    }
    function togglePin(id) { if (pinnedId === id) unpin(); else { pinnedId = id; show(readout, false); fillPin(); highlight(); } }
    function unpin() { pinnedId = null; pinFor = null; pinCard = null; pinBox.replaceChildren(); show(pinBox, false); show(legend, W >= 560 && nodes.size > 0); highlight(); }
    function fillPin() {
      const r = nodes.get(pinnedId); if (!r) { unpin(); return; }
      const i = r.item; show(pinBox, true); show(legend, false);
      if (pinFor !== pinnedId) {
        pinFor = pinnedId;
        const close = h('button', { class: 'btn', type: 'button' }, icon('close'), 'Unpin');
        close.addEventListener('click', () => { const b = r.btn; unpin(); b.focus(); });
        const toCards = h('button', { class: 'btn', type: 'button' }, icon('cards'), 'Show in cards');
        toCards.addEventListener('click', () => api.showCard?.(i.kind === 'session' ? i.id : i.session));
        if (i.kind === 'session') pinCard = sessionCard(api);
        else { const box = h('div', { class: 'card cutbox' }); pinCard = { el: box, update: ii => box.replaceChildren(nodeCard(ii)) }; }
        pinBox.replaceChildren(pinCard.el, h('div', { class: 'pin-bar' }, toCards, close));
      }
      if (i.kind === 'session') pinCard.update(i.x, cx); else pinCard.update(i);
      const [x] = dock(r, pinBox.offsetWidth, pinBox.offsetHeight, [['away', 'bottom'], ['near', 'bottom']]);
      pinBox.classList.toggle('left', x === 'left');
    }
    function roving() {
      if (!rovingId || !nodes.has(rovingId)) { const f = [...nodes.values()].find(r => r.item.kind === 'session') || nodes.values().next().value; rovingId = f ? f.id : null; }
      for (const r of nodes.values()) setAttr(r.btn, 'tabindex', r.id === rovingId ? '0' : '-1');
    }
    layer.addEventListener('keydown', e => {
      if (e.key === 'Escape') { if (pinnedId) { e.preventDefault(); unpin(); } return; }
      const cur = nodes.get(rovingId);
      const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[e.key];
      if (!cur || !dir) return;
      e.preventDefault();
      let best = null, bs = Infinity;
      for (const r of nodes.values()) {
        if (r === cur) continue;
        const vx = r.tx - cur.tx, vy = r.ty - cur.ty, along = vx * dir[0] + vy * dir[1];
        if (along <= 4) continue;
        const score = along + 2 * Math.abs(vx * dir[1] - vy * dir[0]);
        if (score < bs) { bs = score; best = r; }
      }
      if (best) { rovingId = best.id; roving(); best.btn.focus(); }
    });

    function render() {
      if (!data || !W || !H) return;
      const items = graph(data), L = layout(items);
      txt(hubLabel, L.G.length === 1 ? `${cx.host || 'This PC'} · ${L.G[0].name}` : cx.host || 'This PC');
      show(empty, items.length === 0); show(legend, items.length > 0 && W >= 560 && !pinnedId);
      hub.style.transform = `translate(${hubXY.x.toFixed(1)}px, ${hubXY.y.toFixed(1)}px)`;
      empty.style.top = Math.round(hubXY.y + 52) + 'px';
      drawRings(L, items.length > 0);
      placeLabels(items, L);
      drawGroups(L, items);
      const seen = new Set();
      for (const i of items) {
        let r = nodes.get(i.id);
        const fresh = !r;
        if (fresh) { r = makeNode(i); nodes.set(i.id, r); layer.append(r.el); }
        seen.add(i.id); r.item = i; r.tx = i.px; r.ty = i.py;
        if (fresh) {
          const p = i.parent ? nodes.get(i.parent) : null, o = drawn ? (p && p.x != null ? p : hubXY) : { x: i.px, y: i.py };
          r.x = o.x; r.y = o.y; placeNode(r); r.toolSig = toolSig(i);
          if (drawn && !motion.rm) r.btn.animate([{ opacity: 0, transform: 'scale(.3)' }, { opacity: 1, transform: 'none' }], { duration: 450, easing: EASE });
        }
        if (r.state === 'running' && i.state === 'done') r.pulse = true;
        r.state = i.state; setData(r.el, 's', i.state);
        drawFace(r, i); setSpinner(r, i); setLabel(r, i);
        const ts = toolSig(i); if (!fresh && ts && ts !== r.toolSig) spark(r); r.toolSig = ts;
        setAttr(r.btn, 'aria-label', nodeLabel(i));
      }
      for (const [id, r] of nodes) if (!seen.has(id)) { nodes.delete(id); r.pingAnim?.cancel(); r.el.style.opacity = '0'; setTimeout(() => r.el.remove(), 300); }
      syncEdges(items);
      moveAll();
      if (!drawn) retime(true);
      if (pinnedId) fillPin();
      if (hoverId && nodes.has(hoverId)) { if (!readout.hidden) showReadout(nodes.get(hoverId)); } else if (hoverId) { hoverId = null; show(readout, false); }
      highlight(); roving();
      drawn = true;
    }
    return {
      el, nodeCard,
      update(sessions, c) { data = sessions; cx = c || {}; render(); },
      pin(id) { if (nodes.has(id) && pinnedId !== id) togglePin(id); const r = nodes.get(id); if (r) { rovingId = id; roving(); r.btn.focus({ preventScroll: true }); } },
      hoverDemo(id) { const r = nodes.get(id); if (r) hover(r, true); },   // the gallery shows a lit path without a mouse
    };
  }


  // ---- plan graph ------------------------------------------------------------------------------------------------------------
  const DONE_STATES = new Set(['accepted', 'done', 'handed-off']);
  function planLayout(nodes, horizontal) {
    const ids = new Set(nodes.map(n => n.id));
    const deps = new Map(nodes.map(n => [n.id, (n.waitsFor || []).filter(d => ids.has(d) && d !== n.id)]));
    const layer = new Map();
    const lay = (id, stack) => {
      if (layer.has(id)) return layer.get(id);
      if (stack.has(id)) return 0;
      stack.add(id); let l = 0; for (const d of deps.get(id)) l = Math.max(l, lay(d, stack) + 1); stack.delete(id);
      layer.set(id, l); return l;
    };
    nodes.forEach(n => lay(n.id, new Set()));
    const L = [];
    for (const n of nodes) { const l = layer.get(n.id); (L[l] = L[l] || []).push(n); }
    const idx = new Map();
    L.forEach((list = [], li) => {
      if (li > 0) list.sort((a, b) => bary(a) - bary(b));
      list.forEach((n, k) => idx.set(n.id, k));
    });
    function bary(n) { const ds = deps.get(n.id); return ds.length ? ds.reduce((t, d) => t + (idx.get(d) ?? 0), 0) / ds.length : 99; }
    const per = Math.max(1, ...L.map(l => (l || []).length));
    const step = horizontal ? 80 : 84, cross = horizontal ? 60 : 64, pad = 26;
    const pos = new Map();
    L.forEach((list = [], li) => list.forEach((n, k) => {
      const c = pad + (k + (per - list.length) / 2) * cross, m = pad + li * step;
      pos.set(n.id, horizontal ? { x: m, y: c } : { x: c, y: m });
    }));
    const along = pad * 2 + Math.max(0, L.length - 1) * step, across = pad * 2 + (per - 1) * cross + 18;
    return { pos, deps, w: horizontal ? along : across, h: horizontal ? across : along + 18, horizontal };
  }
  function planNodeCard(n) {
    const tag = statusTag(); tag.set(STATUS[n.state] ? n.state : 'unknown', null, n.stateRaw && n.stateRaw !== n.state ? n.stateRaw : null);
    return h('div', { class: 'tc' },
      h('div', { class: 'tc-h' }, tag.el, n.group && n.group !== 'Board' ? h('span', { class: 'label c-ink2 trunc', text: n.group }) : null),
      h('div', { class: 'tc-t', text: `${n.id} · ${n.name || ''}` }),
      h('div', { class: 'tc-r' }, n.agent ? h('span', {}, 'agent ', h('b', { text: n.agent })) : null, n.model ? h('span', { text: [n.model, n.effort].filter(Boolean).join(' / ') }) : null, n.since ? h('span', { text: 'since ' + n.since }) : null),
      n.waitsFor && n.waitsFor.length ? h('div', { class: 'tc-r', text: 'waits for ' + n.waitsFor.join(', ') + (n.waitsForOther && n.waitsForOther.length ? ' · ' + n.waitsForOther.join(', ') : '') }) : null,
      n.notes ? h('div', { class: 'tc-n', text: n.notes }) : null);
  }
  // Circuit-style elbow from a to b; returns the SVG path and its straight segments (for the flow strips).
  function elbow(a, b, horizontal) {
    const segs = [];
    if (horizontal) {
      const mx = Math.round((a.x + b.x) / 2), dy = b.y - a.y, sg = Math.sign(dy), rr = Math.min(6, Math.abs(dy) / 2, (b.x - a.x) / 4);
      if (Math.abs(dy) < 1) return { d: `M${a.x} ${a.y}H${b.x}`, segs: [[a, b]] };
      segs.push([a, { x: mx, y: a.y }], [{ x: mx, y: a.y }, { x: mx, y: b.y }], [{ x: mx, y: b.y }, b]);
      return { d: `M${a.x} ${a.y}H${mx - rr}Q${mx} ${a.y} ${mx} ${a.y + sg * rr}V${b.y - sg * rr}Q${mx} ${b.y} ${mx + rr} ${b.y}H${b.x}`, segs };
    }
    const my = Math.round((a.y + b.y) / 2), dx = b.x - a.x, sg = Math.sign(dx), rr = Math.min(6, Math.abs(dx) / 2, (b.y - a.y) / 4);
    if (Math.abs(dx) < 1) return { d: `M${a.x} ${a.y}V${b.y}`, segs: [[a, b]] };
    segs.push([a, { x: a.x, y: my }], [{ x: a.x, y: my }, { x: b.x, y: my }], [{ x: b.x, y: my }, b]);
    return { d: `M${a.x} ${a.y}V${my - rr}Q${a.x} ${my} ${a.x + sg * rr} ${my}H${b.x - sg * rr}Q${b.x} ${my} ${b.x} ${my + rr}V${b.y}`, segs };
  }
  function planGraph() {
    const svg = s('svg', { role: 'group' });
    const fx = h('div', { class: 'pg-fx', 'aria-hidden': 'true' });
    const box = h('div', { class: 'pg-box' }, svg, fx);
    const wrap = h('div', { class: 'plan-g' }, box);
    let sig = '';
    function mark(n, x, y, R) {
      const bx = x + R * 0.72, by = y - R * 0.72, st = n.state;
      const d = st === 'accepted' || st === 'done' ? `M${bx - 3} ${by + 0.2}l2 2 4-4.2` : st === 'handed-off' ? `M${bx - 3.5} ${by}h6M${bx + 0.5} ${by - 2.5}l2.5 2.5-2.5 2.5`
        : st === 'blocked' ? `M${bx} ${by - 3.5}v3.8M${bx} ${by + 2.8}v.3` : st === 'bounced' ? `M${bx + 3} ${by - 2}h-4a2 2 0 0 0 0 4h1M${bx - 2.5} ${by - 4}l-2 2 2 2`
        : st === 'partial' ? `M${bx - 1.75} ${by - 3}v6M${bx + 1.75} ${by - 3}v6` : null;   // partial: paused part-way
      return d ? [s('circle', { class: 'pn-badge', cx: bx, cy: by, r: 7 }), s('path', { class: 'pn-mark', d })] : [];
    }
    return {
      el: wrap,
      update(nodes) {
        const width = wrap.clientWidth || 300;
        const sigNow = width + '|' + nodes.map(n => n.id + n.state + (n.waitsFor || []).join()).join(';');
        if (sigNow === sig) return; sig = sigNow;
        let G = planLayout(nodes, true);
        if (G.w > width) { const V = planLayout(nodes, false); if (V.w <= width) G = V; }
        setAttr(svg, 'width', G.w); setAttr(svg, 'height', G.h); setAttr(svg, 'viewBox', `0 0 ${G.w} ${G.h}`);
        box.style.width = G.w + 'px'; box.style.height = G.h + 'px';
        const byId = new Map(nodes.map(n => [n.id, n])), out = [], fxKids = [];
        for (const n of nodes) for (const d of G.deps.get(n.id)) {
          const a = G.pos.get(d), b = G.pos.get(n.id), from = byId.get(d);
          const cls = n.state === 'in-progress' ? 'pe flow' : n.state === 'blocked' || n.state === 'bounced' ? 'pe alert' : DONE_STATES.has(from.state) ? 'pe done' : 'pe';
          const E = G.horizontal ? elbow({ x: a.x + 20, y: a.y }, { x: b.x - 20, y: b.y }, true) : elbow({ x: a.x, y: a.y + 40 }, { x: b.x, y: b.y - 22 }, false);
          out.push(s('path', { class: cls, d: E.d }));
          if (n.state === 'in-progress') for (const [p, q] of E.segs) { if (Math.hypot(q.x - p.x, q.y - p.y) < 2) continue; const f = h('div', { class: 'eflow plan' }, h('i')); placeFlow(f, p, q); fxKids.push(f); }
        }
        for (const n of nodes) {
          const p = G.pos.get(n.id), st = STATUS[n.state] ? n.state : 'unknown', input = n.kind === 'input';
          const R = n.id.length > 4 ? 21 : 18, D = R + 2;   // a long id ("UX-10") gets a bigger shape, so it never touches the outline
          const shape = input ? `${p.x},${p.y - D} ${p.x + D},${p.y} ${p.x},${p.y + D} ${p.x - D},${p.y}` : hexPts(R).split(' ').map(q => { const [x, y] = q.split(',').map(Number); return (x + p.x).toFixed(2) + ',' + (y + p.y).toFixed(2); }).join(' ');
          const label = `${n.id} ${n.name || ''}: ${(STATUS[st] || STATUS.unknown)[1]}${n.agent ? ', agent ' + n.agent : ''}`;
          const g = s('g', { class: 'pn', 'data-s': st, tabindex: '0', role: 'img', 'aria-label': label },
            s('circle', { class: 'pn-focus', cx: p.x, cy: p.y, r: R + 6 }),
            s('polygon', { class: 'pn-hex', points: shape }),
            s('text', { class: 'pn-id', x: p.x, y: p.y + 0.5, style: n.id.length > 4 ? 'letter-spacing:0' : null }, n.id),
            mark(n, p.x, p.y, R),
            n.agent || input ? s('text', { class: 'pn-ag', x: p.x, y: p.y + R + 16 }, (input ? 'you' : n.agent).slice(0, 12)) : null);
          const open = () => tip.open(g, planNodeCard(n)), close = () => tip.close(g);
          g.addEventListener('pointerenter', open); g.addEventListener('pointerleave', close);
          g.addEventListener('focus', open); g.addEventListener('blur', close);
          out.push(g);
          if (st === 'in-progress') fxKids.push(h('div', { class: 'pg-pulse', style: `left:${p.x}px;top:${p.y}px` }, s('svg', { viewBox: '-22 -22 44 44' }, s('polygon', { points: input ? '0,-20 20,0 0,20 -20,0' : hexPts(Math.min(R, 21)) }))));
        }
        svg.replaceChildren(...out);
        fx.replaceChildren(...fxKids);
      },
    };
  }
  function planCard() {
    const proj = h('span', { class: 'plan-p label trunc' });
    const need = h('span', { class: 'chip', style: 'color:var(--alert);border-color:rgba(255,77,94,.5)', hidden: true }, icon('alert'), 'Needs you');
    const live = h('span', { class: 'chip', style: 'color:var(--arc);border-color:rgba(41,230,255,.5)', hidden: true }, 'Working');
    const stChip = h('span', { class: 'chip', hidden: true }), count = h('span', { class: 'plan-c' });
    const title = h('h3', { class: 'plan-t trunc', 'data-tip-if': 'trunc' });
    const graph = planGraph(), needs = h('div'), runs = h('div', { class: 'plan-runs', hidden: true }), log = h('p', { class: 'plan-log', hidden: true });
    const el = h('article', { class: 'plan' }, h('header', { class: 'plan-h' }, proj, live, need, stChip, count), title, graph.el, needs, runs, log);
    return {
      el,
      update(p) {
        const all = [...(p.phases || [])];
        txt(proj, p.project || ''); setData(proj, 'tip', p.path ? 'From ' + p.path : null);
        txt(title, p.title || p.slug); title.dataset.tip = p.title || p.slug;
        show(live, (p.working || 0) > 0); setData(live, 'tip', p.working ? `${p.working} session${p.working > 1 ? 's' : ''} running in ${p.project}` : null);
        show(stChip, !!p.state); txt(stChip, p.state ? p.state + (p.stateDate ? ' ' + p.stateDate : '') : '');
        const done = all.filter(n => DONE_STATES.has(n.state)).length;
        txt(count, `${done}/${all.length}`); setData(count, 'tip', `${done} of ${all.length} done, handed off or accepted`);
        const stuck = all.filter(n => n.state === 'blocked' || n.state === 'bounced');
        show(need, (p.needsYou && p.needsYou.length > 0) || stuck.length > 0);
        setData(el, 'project', p.project || ''); setData(el, 'need', need.hidden ? null : '1');
        graph.update(all);
        const rows = [
          // the id is in the label already, so a text that starts with it ("D2 A changed booking …") drops it
          ...(p.needsYou || []).map(q => [`${q.kind === 'decision' ? 'Decision' : 'Question'} ${q.id}${q.item ? ' · ' + q.item : ''}`, String(q.text || '').replace(new RegExp('^\\**' + String(q.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b\\**[\\s:·.–-]*'), '')]),
          ...stuck.map(n => [`${n.state === 'blocked' ? 'Blocked' : 'Bounced'} ${n.id}`, n.notes || n.name || '']),
        ];
        needs.replaceChildren(...rows.map(([b, t]) => h('div', { class: 'plan-need' }, icon('alert'), h('div', { class: 'plan-need-t', 'data-tip': t }, h('b', { text: b }), t))));
        const rs = p.runs || [];
        show(runs, rs.length > 0);
        runs.replaceChildren(...rs.map(r => {
          const tag = h('span', { class: 'chip', 'data-tip': [`Run ${r.id}: ${r.name || ''}`, r.lane ? 'lane ' + r.lane : '', r.chunks && r.chunks.length ? 'chunks ' + r.chunks.join(', ') : '', r.startWhen ? 'starts when ' + r.startWhen : ''].filter(Boolean).join(' · ') });
          const [gl, wd, c] = STATUS[r.state] || STATUS.unknown;
          tag.append(h('span', { class: 'c-' + (c === 'dim' ? 'dim' : c), style: 'display:flex' }, glyph(gl)), `${r.id} · ${wd}`);
          return tag;
        }));
        const last = (p.lastLog || []).filter(l => /^\d{4}-\d\d-\d\d/.test(l)).pop() || (p.lastLog || []).slice(-1)[0];
        show(log, !!last); txt(log, last || ''); setData(log, 'tip', last || null);
      },
    };
  }

  // ---- needs-you banners ------------------------------------------------------------------------------------------------------
  function banners(api = {}) {
    const list = h('div', { style: 'display:contents' });
    const more = h('button', { class: 'ban-more label', type: 'button', hidden: true });
    const el = h('div', { class: 'banners', role: 'region', 'aria-label': 'Sessions waiting for you', 'aria-live': 'polite', hidden: true }, list, more);
    const rows = new Map(), dismissed = new Set();
    let expanded = false, last = [];
    more.addEventListener('click', e => { e.stopPropagation(); expanded = !expanded; update(last); });
    function row(x) {
      const rl = h('span', { class: 'ban-rl' }), rs = h('span', { class: 'ban-rs' });   // the reason, and its short form for narrow screens
      const p = h('span', { class: 'ban-p label' }), t = h('span', { class: 'ban-t trunc' }), r = h('span', { class: 'ban-r' }, rl, rs), tm = h('span', { class: 'ban-tm' });
      const x1 = h('button', { class: 'ban-x', type: 'button', 'aria-label': 'Dismiss', 'data-tip': 'Dismiss until it asks again' }, icon('close'));
      const e = h('div', { class: 'ban cutbox', role: 'button', tabindex: '0' }, h('span', { class: 'ban-w label' }, glyph('needs'), h('span', { text: 'Needs you' })), p, t, r, tm, x1);
      let cur = x;
      x1.addEventListener('click', ev => { ev.stopPropagation(); dismissed.add(cur.id + ':' + cur.needsYou.since); update(last); });
      const go = () => api.jump?.(cur.id);
      e.addEventListener('click', go);
      e.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
      return { el: e, set(y) { cur = y; txt(p, y.project || ''); setData(p, 'tip', y.project || null); p.dataset.tipIf = 'trunc'; txt(t, y.title || y.name || 'Untitled session'); t.dataset.tip = y.title || y.name || ''; t.dataset.tipIf = 'trunc'; txt(rl, y.needsYou.reason); txt(rs, shortReason(y.needsYou.reason)); since(tm, y.needsYou.since); setAttr(e, 'aria-label', `${y.project}: ${y.needsYou.reason}. Go to the session.`); } };
    }
    function update(sessions) {
      last = sessions;
      const waiting = sessions.filter(x => x.status === 'needs-you' && x.needsYou && !dismissed.has(x.id + ':' + x.needsYou.since)).sort((a, b) => a.needsYou.since - b.needsYou.since);
      const shown = expanded ? waiting : waiting.slice(0, 1);
      reconcile(list, rows, shown, x => x.id, row, (r, x) => r.set(x), !motion.rm);
      show(el, waiting.length > 0);
      show(more, waiting.length > 1);
      txt(more, expanded ? 'Fewer' : `+${waiting.length - 1} more`);
      setAttr(more, 'aria-label', expanded ? 'Show only the longest-waiting session' : `Show all ${waiting.length} waiting sessions`);
      const first = list.firstElementChild;
      if (first && more.parentElement !== first) first.querySelector('.ban-tm').before(more);
      if (!first && more.parentElement !== el) el.append(more);
    }
    return { el, update };
  }

  // ---- ticker -------------------------------------------------------------------------------------------------------------------
  const FEED_TAGS = { tool: 'Tool', agent: 'Agent', 'needs-you': 'Needs you', done: 'Done', plan: 'Plan', session: 'Session' };
  function ticker(panelEl, header) {
    const list = h('ol', { class: 'tk-list-in' });
    const clip = h('div', { class: 'tk-list', 'aria-live': 'polite', 'aria-relevant': 'additions' }, list);
    const newest = h('span', { class: 'tk-new trunc' }), paused = h('span', { class: 'chip warn', hidden: true });
    const ldText = h('span', { class: 'trunc', text: 'Nothing has finished yet', 'data-tip': 'Nothing has finished yet', 'data-tip-if': 'trunc' }), ldAgo = h('span', { class: 'mono' });
    const lastDone = h('span', { class: 'tk-last' }, h('span', { class: 'tk-tag', 'data-k': 'done', style: 'padding:0 8px', text: 'Last done' }), ldText, ldAgo);
    let doneAt = -1;
    const btn = h('button', { class: 'tgl tk-collapse', type: 'button', 'aria-expanded': 'true', 'aria-label': 'Collapse the feed', 'data-tip': 'Collapse the feed' }, icon('chevron'));
    header.append(newest, lastDone, paused, btn);
    let hovered = false, queue = [];
    const seen = new Set();
    const key = f => f.at + '|' + (f.sessionId || '') + '|' + f.text;
    let collapsed = prefs.get('tickerCollapsed', false);
    function setCollapsed(v) {
      collapsed = v; prefs.set('tickerCollapsed', v); panelEl.classList.toggle('collapsed', v);
      btn.setAttribute('aria-expanded', String(!v)); const l = v ? 'Expand the feed' : 'Collapse the feed'; btn.setAttribute('aria-label', l); btn.dataset.tip = l;
    }
    setCollapsed(collapsed);
    btn.addEventListener('click', () => setCollapsed(!collapsed));
    clip.addEventListener('pointerenter', () => { hovered = true; });
    clip.addEventListener('pointerleave', () => { hovered = false; const q = queue; queue = []; show(paused, false); q.forEach(f => insert(f, false)); });
    function line(f) {
      const k = FEED_TAGS[f.kind] ? f.kind : 'session';
      return h('li', { class: 'tk' }, h('span', { class: 'tk-time', text: fmtClock(f.at) }), h('span', { class: 'tk-tag', 'data-k': k, text: FEED_TAGS[k] }),
        h('span', { class: 'tk-proj trunc', text: f.project || '—', 'data-tip': f.project || null, 'data-tip-if': 'trunc' }), h('span', { class: 'tk-text trunc', text: f.text, 'data-tip': f.text, 'data-tip-if': 'trunc' }));
    }
    function setNewest(f) { newest.replaceChildren(h('span', { class: 'tk-tag', 'data-k': FEED_TAGS[f.kind] ? f.kind : 'session', style: 'padding:0 8px', text: FEED_TAGS[f.kind] || 'Session' }), h('span', { class: 'trunc', text: `${f.project || ''} · ${f.text}` })); }
    function noteDone(f) {   // the newest finish stays in the header, so "what just finished" survives a busy feed
      if (!f || f.kind !== 'done' || f.at < doneAt) return;
      doneAt = f.at;
      const t = `${f.project || ''} · ${f.text}`; txt(ldText, t); ldText.dataset.tip = t;
      age(ldAgo, f.at, '', ' ago');
    }
    function insert(f, animate = true) {
      noteDone(f);
      const top = list.firstElementChild;
      if (f.kind === 'tool' && top && top._f && top._f.kind === 'tool' && top._f.sessionId && top._f.sessionId === f.sessionId) {
        top._n = (top._n || 1) + 1; top._f = f;   // the same session's next tool: update the line, count it
        top.querySelector('.tk-time').textContent = fmtClock(f.at);
        const tx = top.querySelector('.tk-text'); tx.textContent = f.text; tx.dataset.tip = f.text;
        let n = top.querySelector('.tk-n'); if (!n) { n = h('span', { class: 'tk-n' }); top.querySelector('.tk-proj').append(n); }
        n.textContent = '×' + top._n;
        setNewest(f);
        return;
      }
      const li = line(f); li._f = f;
      list.prepend(li);
      while (list.children.length > 40) list.lastElementChild.remove();
      setNewest(f);
      if (animate && !motion.rm && !collapsed) { list.animate([{ transform: 'translateY(-24px)' }, { transform: 'none' }], { duration: 300, easing: EASE }); li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 }); }
    }
    return {
      el: clip,
      add(f) {
        const k = key(f); if (seen.has(k)) return; seen.add(k); if (seen.size > 2000) seen.clear();
        if (hovered) { queue.push(f); show(paused, true); txt(paused, `Paused · ${queue.length} new`); return; }
        insert(f);
      },
      sync(feed) {   // a snapshot's feed, newest first: add what the stream did not deliver
        const fresh = (feed || []).filter(f => !seen.has(key(f)));
        if (!fresh.length) return;
        if (fresh.length > 12 || !list.children.length) {
          for (const f of feed) seen.add(key(f));
          list.replaceChildren(...feed.slice(0, 40).map(f => { const li = line(f); li._f = f; return li; })); if (feed[0]) setNewest(feed[0]);
          const d = feed.find(f => f.kind === 'done'); if (d) noteDone(d);
        } else fresh.reverse().forEach(f => { seen.add(key(f)); insert(f, false); });
      },
      done: noteDone,   // a finish known from the state (a subagent that ended before this page or this HUD started)
      type(text) {   // "SYSTEMS ONLINE" types into the ticker during boot
        const tx = h('span', { class: 'tk-text' });
        const li = h('li', { class: 'tk type' }, h('span', { class: 'tk-time', text: fmtClock(now()) }), h('span', { class: 'tk-tag', 'data-k': 'session', text: 'HUD' }), h('span', { class: 'tk-proj', text: 'Claude HUD' }), tx);
        list.prepend(li);
        let i = 0; const tm = setInterval(() => { txt(tx, text.slice(0, ++i)); if (i >= text.length) clearInterval(tm); }, 40);
      },
    };
  }

  // ---- sound, voice, notifications (D5, D6) --------------------------------------------------------------------------------
  const audio = (() => {
    let ctx = null, last = 0;
    const TONES = { needs: [[740, 0, .05], [554, .055, .05]], agent: [[523, 0, .04], [784, .045, .045]], done: [[1046, 0, .07]], session: [[440, 0, .06]],
      ended: [[330, 0, .07]], plan: [[659, 0, .05], [880, .05, .04]], idle: [[392, 0, .08]] };
    function ensure() { if (!ctx) { const A = window.AudioContext || window.webkitAudioContext; if (A) ctx = new A(); } if (ctx && ctx.state === 'suspended') ctx.resume(); return ctx; }
    function play(kind) {
      const t = performance.now(); if (t - last < 300) return; last = t;
      const c = ensure(); if (!c) return;
      const t0 = c.currentTime + 0.01;
      for (const [f, dt, d] of TONES[kind] || TONES.session) {
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0, t0 + dt); g.gain.linearRampToValueAtTime(0.07, t0 + dt + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + d);
        o.connect(g).connect(c.destination); o.start(t0 + dt); o.stop(t0 + dt + d + 0.02);
      }
    }
    return { ensure, play, kinds: Object.keys(TONES) };
  })();
  const voice = (() => {
    const q = [], synth = window.speechSynthesis;
    let last = 0, timer = 0, chosen = null;
    function pick() {
      if (chosen || !synth) return chosen;
      const vs = synth.getVoices();
      // Neural voices ("Online (Natural)" in Edge, "Google UK English" in Chrome) sound far less robotic than the local ones.
      for (const re of [/Natural.*(Ryan|Sonia|Thomas|Libby|Guy|Davis|Brian|Andrew|Jenny|Aria)/i, /Natural/i, /Online/i]) { const v = vs.find(v => re.test(v.name) && /^en/i.test(v.lang)); if (v) return chosen = v; }
      for (const re of [/Ryan/i, /George/i, /Daniel/i, /UK English Male/i, /Thomas/i, /Brian/i, /Arthur/i]) { const v = vs.find(v => re.test(v.name) && /^en/i.test(v.lang)); if (v) return chosen = v; }
      return chosen = vs.find(v => /en-GB/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null;
    }
    function pump() {
      if (timer || !q.length || !synth) return;
      const wait = Math.max(0, last + 4000 - Date.now());
      if (wait || synth.speaking) { timer = setTimeout(() => { timer = 0; pump(); }, Math.max(wait, 300)); return; }
      const u = new SpeechSynthesisUtterance(q.shift()), v = pick();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = 1; u.pitch = 1; u.volume = 0.9; u.onend = () => pump();
      last = Date.now(); synth.speak(u);
    }
    if (synth && synth.addEventListener) synth.addEventListener('voiceschanged', () => { chosen = null; });
    return {
      say(text) { if (!synth || q[q.length - 1] === text) return; if (q.length > 4) q.shift(); q.push(text); pump(); },
      get name() { const v = pick(); return v ? v.name : null; },
    };
  })();
  function notify(title, body, tag) {
    if (!prefs.get('notify', false) || !('Notification' in window) || Notification.permission !== 'granted' || !doc.hidden) return false;
    try { new Notification(title, { body, tag, silent: false }); return true; } catch { return false; }
  }
  // What changed between two snapshots, for sound, voice and notifications.
  function happenings(prev, next) {
    const out = [];
    if (!prev) return out;
    const pm = new Map(prev.sessions.map(x => [x.id, x]));
    for (const x of next.sessions) {
      const p = pm.get(x.id);
      if (!p) { if (x.status !== 'ended') out.push({ type: 'session-start', x }); if (x.status === 'needs-you') out.push({ type: 'needs-you', x }); continue; }
      if (x.status === 'needs-you' && x.needsYou && (p.status !== 'needs-you' || !p.needsYou || p.needsYou.since !== x.needsYou.since || p.needsYou.reason !== x.needsYou.reason)) out.push({ type: 'needs-you', x });
      if (x.status === 'ended' && p.status !== 'ended') out.push({ type: 'session-end', x });
      const ps = new Map((p.subagents || []).map(a => [a.id, a]));
      for (const a of x.subagents || []) {
        const q = ps.get(a.id);
        if (!q) { if (a.state === 'running') out.push({ type: 'sub-start', x, a }); } else if (q.state === 'running' && a.state === 'done') out.push({ type: 'sub-done', x, a });
      }
    }
    const pk = pl => pl.project + '|' + pl.slug, pp = new Map((prev.plans || []).map(pl => [pk(pl), pl]));
    for (const pl of next.plans || []) {
      const q = pp.get(pk(pl)); if (!q) continue;
      const qs = new Map([...(q.phases || []), ...(q.runs || [])].map(n => [n.id, n.state]));
      for (const n of [...(pl.phases || []), ...(pl.runs || [])]) { const was = qs.get(n.id); if (was && was !== n.state) out.push({ type: 'phase', plan: pl, n, from: was }); }
    }
    if ((prev.totals?.agentsRunning || 0) > 0 && (next.totals?.agentsRunning || 0) === 0) out.push({ type: 'all-idle' });
    return out;
  }
  function needsPhrase(x) {
    const p = x.project || 'A session', r = x.needsYou?.reason || '', k = x.needsYou?.kind;
    if (/plan approval/i.test(r)) return `${p} has a plan for your approval`;
    if (k === 'permission') return `${p} needs your approval`;
    if (k === 'question') return `${p} has a question for you`;
    if (k === 'input') return `${p} is waiting for you`;
    return `${p} needs you`;
  }
  function announcer() {
    let idleTimer = 0;
    return function announce(list, st) {
      const sound = prefs.get('sound', false), speak = prefs.get('voice', false);
      for (const e of list) {
        if (e.type === 'needs-you') {
          if (sound) audio.play('needs'); if (speak) voice.say(needsPhrase(e.x));
          notify(`${e.x.project || 'A session'} needs you`, `${e.x.needsYou.reason} · ${e.x.title || e.x.name || ''}`, 'needs-' + e.x.id);
        } else if (e.type === 'phase') {
          const big = ['handed-off', 'blocked', 'bounced'].includes(e.n.state);
          if (sound) audio.play('plan');
          if (big) {
            const w = e.n.state === 'handed-off' ? 'handed off' : e.n.state === 'blocked' ? 'is blocked' : 'bounced';
            if (speak) voice.say(`Phase ${e.n.id} ${w}`);
            notify(`${e.plan.title}: ${e.n.id} ${w}`, `${e.plan.project} · ${e.n.name || ''}`, 'plan-' + e.plan.slug + e.n.id);
          }
        } else if (e.type === 'sub-start') { if (sound) audio.play('agent'); }
        else if (e.type === 'sub-done') { if (sound) audio.play('done'); }
        else if (e.type === 'session-start') { if (sound) audio.play('session'); }
        else if (e.type === 'session-end') { if (sound) audio.play('ended'); }
        else if (e.type === 'all-idle') {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => { if (prefs.get('voice', false)) voice.say('All agents idle'); if (prefs.get('sound', false)) audio.play('idle'); }, 6000);
        }
      }
      if ((st.totals?.agentsRunning || 0) > 0) { clearTimeout(idleTimer); idleTimer = 0; }
    };
  }

  // ---- shells: panels, toggles, top bar -------------------------------------------------------------------------------------
  function panel(cls, title, opts = {}) {
    const head = h('header', { class: 'ph' }, title ? h('h2', { class: 'pt', text: title }) : null);
    const content = h('div', { class: 'pc' });
    const pb = h('div', { class: 'pb cutbox' }, head, content);
    const el = h('section', { class: 'panel ' + cls, 'aria-label': opts.label || title || null }, pb);
    let err = null;
    return {
      el, head, content, pb,
      guard(fn, retry) {
        try { fn(); if (err) { err.remove(); err = null; } }
        catch (e) {
          console.error(e);
          if (!err) {
            const b = h('button', { class: 'btn', type: 'button' }, 'Retry');
            err = h('div', { class: 'perr', role: 'alert' }, icon('alert'), h('div', { class: 'perr-t', text: 'This panel could not be drawn' }), h('div', { class: 'perr-m trunc', text: String(e && e.message || e).slice(0, 160), 'data-tip': String(e && e.message || e).slice(0, 300), 'data-tip-if': 'trunc' }), b);
            b.addEventListener('click', () => retry && retry());
            pb.append(err);
          }
        }
      },
    };
  }
  // ---- "more below": a panel that scrolls says what is out of sight, and a click brings it up ------------------------
  // describe(hidden elements) returns the summary: states, names. Nothing runs at rest: it repaints (in one animation
  // frame) on scroll, on resize and when the owner calls refresh() after a render.
  function moreBelow(scroller, list, describe) {
    const n = h('span', { class: 'label' }), d = h('span', { class: 'more-d', 'data-tip-if': 'trunc' });
    const el = h('button', { class: 'more', type: 'button', hidden: true }, icon('chevron'), n, d);
    let queued = 0, hidden = [];
    function paint() {
      queued = 0;
      const end = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      const bottom = scroller.getBoundingClientRect().bottom - 32;
      // out of sight: less than about 48 px of it shows above the bar (half, for something smaller)
      hidden = end ? [] : [...list.children].filter(e => {
        if (e === el || e.hidden || e.classList.contains('leave')) return false;
        const r = e.getBoundingClientRect();
        return r.height > 0 && bottom - r.top < Math.min(48, r.height / 2);
      });
      show(el, hidden.length > 0);
      if (!hidden.length) return;
      txt(n, `${hidden.length} more below`);
      d.replaceChildren(...describe(hidden).filter(Boolean).flatMap((p, i) => i ? [' · ', p] : [p])); d.dataset.tip = d.textContent;
      setAttr(el, 'aria-label', `${hidden.length} more below${d.textContent ? ': ' + d.textContent : ''}. Show them.`);
    }
    const later = () => { if (!queued) queued = requestAnimationFrame(paint); };
    scroller.addEventListener('scroll', later, { passive: true });
    new ResizeObserver(later).observe(scroller);
    el.addEventListener('click', () => {
      const first = hidden.find(e => e.isConnected);
      if (first) scroller.scrollBy({ top: first.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8, behavior: motion.rm ? 'auto' : 'smooth' });
    });
    return { el, refresh: later };
  }
  // Hidden cards or rows, counted by state ("1 busy · 2 idle"): a word and its colour.
  const COUNT_C = { 'needs-you': 'alert', busy: 'amber', idle: 'arc', ended: 'ink2' };
  function stateCounts(els) {
    const c = {}; for (const e of els) c[e.dataset.s] = (c[e.dataset.s] || 0) + 1;
    return Object.keys(COUNT_C).filter(k => c[k]).map(k => h('span', { class: 'c-' + COUNT_C[k], text: `${c[k]} ${STATUS[k][1].toLowerCase()}` }));
  }
  function toggle(name, label, on, onChange) {
    const b = h('button', { class: 'tgl', type: 'button', 'aria-label': label }, icon(name), icon('slash', 'slash'));
    const set = v => { b.setAttribute('aria-pressed', String(!!v)); b.dataset.tip = `${label}: ${v ? 'on' : 'off'}`; };
    set(on);
    b.addEventListener('click', () => onChange(b.getAttribute('aria-pressed') !== 'true', set));
    return { el: b, set };
  }
  function brandMark() {
    return s('svg', { class: 'brand-mark', viewBox: '0 0 28 28', 'aria-hidden': 'true' },
      s('circle', { class: 'bm-o', cx: 14, cy: 14, r: 12.5, 'stroke-width': 1.5, 'stroke-dasharray': '14 5.6' }),
      s('circle', { cx: 14, cy: 14, r: 7, 'stroke-width': 1, opacity: .6 }),
      s('circle', { cx: 14, cy: 14, r: 3, fill: 'var(--arc)', stroke: 'none' }));
  }
  function topBar(api = {}) {
    const sub = h('span', { class: 'brand-sub label' });
    const mini = reactor({ size: 36, mini: true }), miniN = odo();
    const clockT = h('span', { class: 'clock-t mono' }), clockD = h('span', { class: 'clock-d label' }), clockU = h('span', { class: 'clock-u label' });
    const demo = h('span', { class: 'chip demo', hidden: true, 'data-tip': 'Simulated sessions (node hud.mjs --demo)' }, 'Demo');
    const hooks = h('span', { class: 'chip warn', hidden: true, 'data-tip': 'Hooks are missing in a watched Claude Code folder: tool calls arrive late from transcripts, and “needs you” cannot be seen. Restart the HUD, or run node hud.mjs install.' }, 'Hooks off');
    const streamW = h('span', { class: 'label' }), stream = h('div', { class: 'stream', 'data-s': 'connecting', role: 'status' }, h('span', { class: 'stream-dot' }), streamW);
    const fx = toggle('effects', 'Effects', motion.fx, (v, set) => { motion.setFx(v); set(v); });
    const vo = toggle('voice', 'Voice', prefs.get('voice', false), (v, set) => { prefs.set('voice', v); set(v); if (v) voice.say('Voice announcements on'); });
    const so = toggle('sound', 'Sound', prefs.get('sound', false), (v, set) => { prefs.set('sound', v); set(v); if (v) { audio.ensure(); audio.play('done'); } });
    const no = toggle('bell', 'Notifications', prefs.get('notify', false) && 'Notification' in window && Notification.permission === 'granted', async (v, set) => {
      if (!v) { prefs.set('notify', false); set(false); return; }
      if (!('Notification' in window)) { set(false); return; }
      const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      prefs.set('notify', perm === 'granted'); set(perm === 'granted');
      if (perm === 'denied') no.el.dataset.tip = 'Notifications: blocked in the browser settings';
    });
    const el = h('header', { class: 'top' },
      h('div', { class: 'brand' }, brandMark(), h('span', { class: 'wordmark', text: 'HUD' }), sub),
      h('div', { class: 'mini', 'aria-hidden': 'true' }, mini.el, miniN.el),
      h('div', { class: 'clock' }, clockT, clockD, clockU),
      h('div', { class: 'top-chips' }, demo, hooks),
      h('div', { class: 'top-r' }, stream, fx.el, vo.el, so.el, no.el));
    let started = null;
    return {
      el,
      tick() { const t = now(); txt(clockT, fmtClock(t)); txt(clockD, fmtDate(t)); if (started) txt(clockU, 'up ' + fmtAge(t - started)); },
      update(st) {
        txt(sub, 'Claude · ' + (st.host || 'this PC')); started = st.now - st.uptime;
        show(demo, !!st.demo); show(hooks, !st.demo && st.hooksInstalled === false);
        mini.update(st.sessions || [], st.totals || {}); miniN.set(String(st.totals?.agentsRunning || 0));
        this.tick();
      },
      setStream(sv) { setData(stream, 's', sv); txt(streamW, { live: 'Live', reconnecting: 'Reconnecting', down: 'Down', connecting: 'Connecting' }[sv] || sv); },
      toggles: { fx, vo, so, no },
    };
  }

  // ---- the whole page --------------------------------------------------------------------------------------------------------------
  function createHud(mount, opts = {}) {
    const bg = h('div', { class: 'bg', 'aria-hidden': 'true' }, h('div', { class: 'bg-grid' }), h('div', { class: 'bg-dots' }), h('div', { class: 'bg-dots d2' }), h('div', { class: 'bg-shim' }), h('div', { class: 'bg-vig' }));
    const api = { jump: id => jump(id), showCard: id => { setView('cards', true); jump(id); }, open: id => jump(id) };
    const top = topBar(api), ban = banners(api);
    const conn = h('div', { class: 'conn', hidden: true, role: 'status' }, h('span', { class: 'label conn-w' }), h('span', { class: 'mono conn-m' }));
    const connRetry = h('button', { type: 'button', text: 'Retry now' }); conn.append(connRetry);
    connRetry.addEventListener('click', () => opts.reconnect && opts.reconnect());

    const rx = panel('p-reactor', null, { label: 'Agents and totals' });
    const react = reactor(), vit = vitals();
    rx.content.append(react.el, vit.el);
    const ex = panel('p-ext', 'Outside Claude Code'); ex.el.hidden = true;
    const exb = externals(); ex.content.append(exb.el);

    const se = panel('p-sess', 'Sessions');
    const seSum = h('span', { class: 'ps trunc' });
    const vCards = h('button', { type: 'button', 'aria-pressed': 'true' }, icon('cards'), 'Cards'), vNet = h('button', { type: 'button', 'aria-pressed': 'false' }, icon('network'), 'Network');
    se.head.append(seSum, h('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, vCards, vNet));
    const cardsBox = h('div', { class: 'cards' }), cardsEmpty = h('div', { class: 'cards-empty', hidden: true }, h('span', { class: 'label', text: 'No active sessions' }), ' · systems nominal');
    const cardsWrap = h('div', {}, cardsEmpty, cardsBox);
    const net = network(api);
    const seMore = moreBelow(se.content, cardsBox, stateCounts);
    se.content.append(cardsWrap, net.el, seMore.el);
    const cards = new Map(), rowsMap = new Map();
    let view = null, autoNet = false, compactMode = null;

    const pl = panel('p-plans', 'Plans');
    const plSum = h('span', { class: 'ps' }); pl.head.append(plSum);
    const plansBox = h('div', { class: 'plans' }), plansEmpty = h('div', { class: 'plans-empty', hidden: true, text: 'No plan boards in the watched projects' });
    const plMore = moreBelow(pl.content, plansBox, els => {
      const k = els.filter(e => e.dataset.need).length;
      return [k ? h('span', { class: 'c-alert', text: `${k} ${k === 1 ? 'needs' : 'need'} you` }) : null, h('span', { class: 'trunc', text: els.map(e => e.dataset.project).join(', ') })];
    });
    pl.content.append(plansEmpty, plansBox, plMore.el);
    const planMap = new Map();
    let plSig = '';

    const tk = panel('p-tick', 'Feed', { label: 'Live feed' });
    const tick = ticker(tk.el, tk.head);
    tk.content.replaceWith(tick.el);

    const colL = h('div', { class: 'col-l' }, rx.el, ex.el);
    const lMore = moreBelow(colL, colL, els => els.map(e => h('span', { text: e.getAttribute('aria-label') })));
    colL.append(lMore.el);
    const main = h('main', { class: 'main' }, colL, se.el, pl.el);
    const app = h('div', { class: 'app' }, top.el, ban.el, main, tk.el);
    mount.append(bg, app, conn, h('div', { class: 'scanlines', 'aria-hidden': 'true' }));

    let state = null, booted = false, exHidden = null;
    const announce = announcer();

    function setView(v, remember) {
      view = v; if (remember) { prefs.set('view', v); urlView = null; }
      vCards.setAttribute('aria-pressed', String(v === 'cards')); vNet.setAttribute('aria-pressed', String(v === 'network'));
      show(cardsWrap, v === 'cards'); show(net.el, v === 'network');
      if (state) renderSessions(state);
    }
    vCards.addEventListener('click', () => setView('cards', true));
    vNet.addEventListener('click', () => setView('network', true));
    let urlView = new URLSearchParams(location.search).get('view');   // ?view=cards|network, until the switch is used
    if (!/^(cards|network)$/.test(urlView || '')) urlView = null;
    function currentView(st) {
      if (urlView) return urlView;
      if (prefs.get('view', null)) return prefs.get('view');
      if (!autoNet && st.sessions.some(x => x.status !== 'ended' && (x.subagents || []).length)) autoNet = true;
      const crowdedNarrow = innerWidth < 600 && st.sessions.filter(x => x.status !== 'ended').length > 8;   // too many nodes for a narrow window: rows read better
      return autoNet && !crowdedNarrow ? 'network' : 'cards';
    }
    function jump(id) {
      if (!state) return;
      if (view === 'network') { net.pin(id); return; }
      const c = cards.get(id) || rowsMap.get(id); if (!c) return;
      c.el.scrollIntoView({ behavior: motion.rm ? 'auto' : 'smooth', block: 'center' });
      c.el.classList.add('flash'); setTimeout(() => c.el.classList.remove('flash'), 900);
      c.el.focus({ preventScroll: true });
    }
    function ctxFor(st) {
      const live = st.sessions.filter(x => x.status !== 'ended');
      return {
        byId: new Map(st.sessions.map(x => [x.id, x])), host: st.host,
        maxTok: Math.max(1, ...live.map(x => headline(x.tokens))), maxCache: Math.max(1, ...live.map(x => x.tokens?.cacheRead || 0)),
      };
    }
    function renderSessions(st) {
      se.guard(() => {
        const live = st.sessions.filter(x => x.status !== 'ended');
        const t = st.totals || {};
        txt(seSum, [`${live.length} open`, t.busy ? `${t.busy} busy` : null, t.needsYou ? `${t.needsYou} need you` : null].filter(Boolean).join(' · '));
        view = currentView(st);
        vCards.setAttribute('aria-pressed', String(view === 'cards')); vNet.setAttribute('aria-pressed', String(view === 'network'));
        show(cardsWrap, view === 'cards'); show(net.el, view === 'network');
        const c = ctxFor(st);
        if (view === 'network') { net.update(st.sessions, c); return; }
        show(cardsEmpty, live.length === 0);
        const compact = live.length > 8;
        if (compact !== compactMode) { compactMode = compact; cardsBox.classList.toggle('compact', compact); cardsBox.replaceChildren(); cards.clear(); rowsMap.clear(); }
        const rank = { 'needs-you': 0, busy: 1, idle: 2, ended: 3 };
        const list = st.sessions.slice().sort((a, b) => rank[a.status] - rank[b.status] || (a.startedAt || 0) - (b.startedAt || 0));
        if (compact) reconcile(cardsBox, rowsMap, list, x => x.id, () => compactRow(api), (r, x) => r.update(x, c), booted);
        else reconcile(cardsBox, cards, list, x => x.id, () => sessionCard(api), (r, x) => r.update(x, c), booted);
        seMore.refresh();
      }, () => renderSessions(st));
    }
    function renderPlans(st) {
      pl.guard(() => {
        const plans = (st.plans || []).slice();
        const needs = p => (p.needsYou && p.needsYou.length) || (p.phases || []).some(n => n.state === 'blocked' || n.state === 'bounced');
        const active = p => (p.phases || []).some(n => n.state === 'in-progress');
        // needs you, then a session is working in its project, then a phase in progress, then the board changed most recently
        plans.sort((a, b) => (needs(b) ? 1 : 0) - (needs(a) ? 1 : 0) || ((b.working || 0) > 0 ? 1 : 0) - ((a.working || 0) > 0 ? 1 : 0) || (active(b) ? 1 : 0) - (active(a) ? 1 : 0) || (b.touchedAt || 0) - (a.touchedAt || 0) || a.project.localeCompare(b.project) || (a.title || '').localeCompare(b.title || ''));
        show(plansEmpty, plans.length === 0);
        txt(plSum, plans.length ? [`${plans.length}`, st.totals?.plansInProgress ? `${st.totals.plansInProgress} in progress` : null].filter(Boolean).join(' · ') : '');
        reconcile(plansBox, planMap, plans, p => p.project + '|' + p.slug, () => planCard(), (c, p) => c.update(p), booted);
        const sig = plans.map(p => p.project + '|' + p.slug + (needs(p) ? '!' : '')).join();
        if (sig !== plSig) { plSig = sig; plMore.refresh(); }   // the hint only changes with the boards (scroll and resize repaint it too)
      }, () => renderPlans(st));
    }
    // The newest finished subagent in the state: "what just finished" is answered from the first frame, not only once
    // a finish arrives in the feed.
    function lastFinish(st) {
      let best = null;
      for (const x of st.sessions || []) for (const a of x.subagents || []) {
        if (a.state === 'done' && a.endedAt && (!best || a.endedAt > best.at)) best = { kind: 'done', at: a.endedAt, project: x.project, text: `Agent done · ${[a.type, a.description].filter(Boolean).join(': ')}` };
      }
      return best;
    }
    function render(st, o = {}) {
      syncClock(st.now);
      const prev = state; state = st;
      const boot = o.boot || (!booted && root.classList.contains('booting'));
      top.update(st);
      ban.update(st.sessions || []);
      rx.guard(() => { react.update(st.sessions || [], st.totals || {}, { boot }); vit.update(st, { boot }); }, () => render(state));
      ex.guard(() => { const has = (st.external || []).length > 0 || !!st.externalError; ex.el.hidden = !has; if (has) exb.update(st.external, st.externalError); }, () => render(state));
      if (ex.el.hidden !== exHidden) { exHidden = ex.el.hidden; lMore.refresh(); }
      renderSessions(st);
      renderPlans(st);
      tick.sync(st.feed || []);
      tick.done(lastFinish(st));
      if (prev) announce(happenings(prev, st), st);
      booted = true;
    }
    function setConn(sv, info = {}) {
      top.setStream(sv);
      const bad = sv === 'reconnecting' || sv === 'down';
      show(conn, bad); setData(conn, 's', sv);
      app.classList.toggle('stale', bad);
      conn.querySelector('.conn-w').textContent = sv === 'down' ? 'HUD server not answering' : 'Connection lost · reconnecting';
      conn.querySelector('.conn-m').textContent = info.lastAt ? 'last update ' + fmtAge(Date.now() - info.lastAt) + ' ago' : '';
    }
    setInterval(() => { top.tick(); tickTimers(); }, 1000);
    top.tick();
    return { render, feed: f => tick.add(f), setConn, typeLine: t => tick.type(t), get state() { return state; } };
  }

  // ---- boot sequence (ambient: skipped with EFFECTS off or reduced motion) -------------------------------------------------
  function boot(hud) {
    if (!motion.ambient) return false;
    root.classList.add('booting');
    const end = () => { root.classList.remove('booting'); removeEventListener('pointerdown', end, true); removeEventListener('keydown', end, true); };
    addEventListener('pointerdown', end, true); addEventListener('keydown', end, true);
    setTimeout(() => hud.typeLine('SYSTEMS ONLINE'), 900);
    setTimeout(end, 1600);
    return true;
  }

  return {
    h, s, txt, icon, glyph, ICONS, GLYPHS, STATUS, statusTag, provBadge, odo, tip, motion, prefs, now, syncClock, tickTimers,
    fmtTok, fmtPct, fmtDur, fmtAge, headline, shortModel, ctxLevel,
    contextMeter, tokenMeter, cacheMeter, sessionCard, compactRow, subList, reactor, vitals, externals, network, planCard, planNodeCard,
    banners, ticker, panel, toggle, topBar, createHud, boot, audio, voice, happenings, needsPhrase, reconcile, moreBelow, stateCounts, FEED_TAGS,
  };
}


// The page at `/`: the HUD on the live stream.
function pageMain(H) {
  'use strict';
  // lastAt: the last state received (the server sends state only on change, so it can be old on a healthy stream).
  // lostAt: when the stream was lost. Reconnecting (connecting before any state) for 10 s after that, then down.
  let es = null, lastAt = 0, lostAt = 0, retryTimer = 0;
  const hud = H.createHud(document.body, { reconnect: () => connect() });
  H.boot(hud);
  const setConn = sv => hud.setConn(sv, { lastAt });
  const judge = () => { if (lostAt && es && es.readyState !== 1) setConn(Date.now() - lostAt > 10000 ? 'down' : lastAt ? 'reconnecting' : 'connecting'); };
  function connect() {
    if (es) es.close();
    clearTimeout(retryTimer);
    es = new EventSource('/api/stream');
    es.onopen = () => { lostAt = 0; setConn('live'); };
    es.onerror = () => {
      if (!lostAt) lostAt = Date.now();
      judge();
      if (es.readyState === 2) retryTimer = setTimeout(connect, 3000);   // closed for good: start a new stream
    };
    es.addEventListener('state', e => { let st; try { st = JSON.parse(e.data); } catch { return; } lastAt = Date.now(); lostAt = 0; setConn('live'); hud.render(st); });
    es.addEventListener('event', e => { try { hud.feed(JSON.parse(e.data)); } catch {} });
  }
  connect();
  setInterval(judge, 1000);
}

// The component gallery at `/design`: every component in every state, from fixtures (PLAN §6.6).
function designMain(H) {
  'use strict';
  const { h, s, icon, glyph } = H;
  const t = Date.now();
  let seq = 0;
  const uid = p => p + (++seq).toString(16).padStart(6, '0');
  const tok = (output, cacheWrite, input = 120, cacheRead = 0) => ({ input, output, cacheWrite, cacheRead });
  const ctx = (pct, win = 1e6) => pct == null ? null : { used: Math.round(win * pct / 100), window: win, pct };
  const sum = list => list.reduce((a, x) => ({ input: a.input + x.tokens.input, output: a.output + x.tokens.output, cacheWrite: a.cacheWrite + x.tokens.cacheWrite, cacheRead: a.cacheRead + x.tokens.cacheRead }), tok(0, 0, 0, 0));
  function sub(o) {
    return Object.assign({ id: uid('a'), parentId: null, depth: 1, description: 'Map the quotation totals code', type: 'Explore', model: 'claude-haiku-5-5', modelRaw: 'claude-haiku-5-5', provider: 'anthropic',
      state: 'running', background: false, startedAt: t - 48e3, endedAt: null, tokens: tok(3200, 18000, 40, 210000), context: ctx(18), currentTool: { name: 'Grep', summary: 'VatRate in src', since: t - 4e3 } }, o);
  }
  function sess(o) {
    const x = Object.assign({ id: uid('s'), pid: 4242, project: 'FidiaCRM', cwd: '', name: 'fidiacrm-3f', title: 'Quotation wizard: totals, VAT rows and the discount line', entrypoint: 'claude-vscode', version: '2.1.312',
      status: 'busy', needsYou: null, provider: 'anthropic', model: 'claude-opus-5-5', modelRaw: 'claude-opus-5-5', effort: 'high', branch: 'ux/R14-quotation-wizard',
      startedAt: t - 42 * 60e3, lastActivityAt: t - 2e3, endedAt: null, currentTool: { name: 'Bash', summary: 'dotnet test -c Release --no-build --filter Quotation', since: t - 14e3 },
      tools: 48, startedBy: null, tokens: tok(86400, 274500, 222, 21043954), context: ctx(30.5), subagents: [] }, o);
    for (const a of x.subagents) { if (!a.parentId) a.parentId = x.id; a.provider = x.provider; }
    x.tokensTree = sum([x, ...x.subagents]);
    return x;
  }
  function nested(o = {}) {
    const a = sub({ type: 'Explore', description: 'Map the quotation totals code', tokens: tok(9200, 41000, 60, 610000), context: ctx(41) });
    const b = sub({ parentId: a.id, depth: 2, type: 'general-purpose', description: 'Check the VAT rounding rules', model: 'claude-sonnet-5-5', tokens: tok(5400, 26000, 30, 190000), context: ctx(22), startedAt: t - 30e3 });
    const c = sub({ parentId: b.id, depth: 3, type: 'web-fetch', description: 'Read the tax office rounding note', state: 'done', endedAt: t - 9e3, currentTool: null, tokens: tok(800, 9000, 10, 0), context: ctx(6), startedAt: t - 26e3 });
    const d = sub({ type: 'web-fetch', description: 'Read the Syncfusion grid docs', state: 'done', endedAt: t - 60e3, currentTool: null, tokens: tok(1400, 12000), context: ctx(9), startedAt: t - 120e3 });
    return sess(Object.assign({ project: 'WasteManagement2', title: 'Coordinator: customer history plan, phases P2 and P3', branch: 'customer-history', tokens: tok(126000, 291000, 216, 17166585), context: ctx(62), subagents: [a, b, c, d] }, o));
  }
  const host = 'STARK-01';
  const busy = nested();
  const needs = sess({ project: 'FidiaCRM', status: 'needs-you', needsYou: { since: t - 95e3, reason: 'Permission: Bash', kind: 'permission' }, currentTool: { name: 'Bash', summary: 'sqlcmd -S localhost -d WM2 -Q "SELECT COUNT(*) FROM Customers"', since: t - 95e3 }, context: ctx(76) });
  const fresh = sess({ project: 'TourCMS', status: 'idle', currentTool: null, lastActivityAt: t - 12e3, title: 'Booking changes: date and people edits', model: 'claude-sonnet-5-5', effort: 'medium', provider: 'bedrock', modelRaw: 'us.anthropic.claude-sonnet-5-5-v1:0', branch: 'booking-changes', context: ctx(91.5), tokens: tok(40200, 120000, 90, 6400000) });
  const idle = sess({ project: 'ImPOS-Maui', status: 'idle', currentTool: null, lastActivityAt: t - 17 * 60e3, title: 'Receipt printer: retry after paper out', model: 'claude-sonnet-5-5', effort: 'medium', branch: 'main', context: ctx(12), tokens: tok(12000, 64000, 40, 900000), startedBy: busy.id });
  const ended = sess({ project: 'WasteManagement2', status: 'ended', endedAt: t - 3 * 60e3, lastActivityAt: t - 3 * 60e3, currentTool: null, title: 'Say hi', model: 'claude-haiku-5-5', effort: 'low', branch: 'customer-history', tokens: tok(120, 3000, 8, 0), context: ctx(2, 200000), startedBy: busy.id, tools: 0 });
  const long = sess({ project: 'ImPOS-Maui', title: 'Phone app phase 7: battery and Xiaomi autostart switches, runbook for the real-phone pass on the Samsung and the support notes for the shop owners', branch: 'phone-app/xiaomi-autostart-and-battery-whitelist-runbook', model: 'claude-mythos-9-9', modelRaw: 'claude-mythos-9-9', context: null, provider: 'unknown', currentTool: { name: 'mcp__browser__screenshot', summary: 'https://localhost:5001/settings/battery?device=xiaomi-13t-pro&mode=strict', since: t - 3e3 } });
  const all = [needs, busy, fresh, idle, ended, long];
  const byId = new Map(all.map(x => [x.id, x]));
  const cardCtx = { byId, host, maxTok: Math.max(...all.map(x => H.headline(x.tokens))), maxCache: Math.max(...all.map(x => x.tokens.cacheRead)) };
  const totals = list => {
    const live = list.filter(x => x.status !== 'ended'), subs = live.reduce((n, x) => n + x.subagents.filter(a => a.state === 'running').length, 0);
    return { sessions: live.length, needsYou: live.filter(x => x.status === 'needs-you').length, busy: live.filter(x => x.status === 'busy').length, subagentsRunning: subs,
      agentsRunning: live.filter(x => x.status === 'busy' || x.status === 'needs-you').length + subs, tokensToday: sum(list), plansInProgress: 2, plansNeedingYou: 1 };
  };

  // ---- page frame ----
  const fxT = H.toggle('effects', 'Effects', H.motion.fx, (v, set) => { H.motion.setFx(v); set(v); });
  const rmT = H.toggle('clock', 'Reduced motion preview', H.motion.rm, (v, set) => { H.motion.setRm(v); set(v); });
  const bg = h('div', { class: 'bg', 'aria-hidden': 'true' }, h('div', { class: 'bg-grid' }), h('div', { class: 'bg-dots' }), h('div', { class: 'bg-dots d2' }), h('div', { class: 'bg-shim' }), h('div', { class: 'bg-vig' }));
  const head = h('header', { class: 'top gal-head' },
    h('div', { class: 'brand' }, h('span', { class: 'wordmark', text: 'HUD' }), h('span', { class: 'brand-sub label', text: 'Design system · every component, every state' })),
    h('div', { class: 'top-r', style: 'margin-left:auto' }, (() => { const b = h('button', { class: 'btn', type: 'button', text: 'Replay boot' }); b.addEventListener('click', () => { if (!H.motion.ambient) return; document.documentElement.classList.remove('booting'); void document.body.offsetWidth; document.documentElement.classList.add('booting'); setTimeout(() => document.documentElement.classList.remove('booting'), 1600); }); return b; })(), h('a', { class: 'btn', href: '/', text: 'Open the HUD' }), h('span', { class: 'label c-ink2', text: 'Effects' }), fxT.el, h('span', { class: 'label c-ink2', text: 'Reduced motion' }), rmT.el));
  const gal = h('div', { class: 'gal' }, head);
  document.body.append(bg, gal, h('div', { class: 'scanlines', 'aria-hidden': 'true' }));
  function section(title, note, ...specs) {
    const p = H.panel('gal-sec', title);
    if (note) p.head.append(h('span', { class: 'ps', text: note }));
    p.content.append(h('div', { class: 'specs' }, ...specs));
    gal.append(p.el);
    return p;
  }
  const spec = (label, ...kids) => h('div', { class: 'spec' }, h('div', { class: 'spec-l label', text: label }), ...kids);
  const wide = (label, ...kids) => { const e = spec(label, ...kids); e.classList.add('wide'); return e; };

  // ---- colour, with measured contrast ----
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const over = ([r, g, b, a], [R, G, B]) => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
  const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const VOID = rgb('#04070d'), DEEP = rgb('#08111c'), GLASS = over([16, 34, 52, .55], VOID), CARD = over([8, 17, 28, .62], GLASS), FLOAT = over([8, 17, 28, .94], GLASS);
  const tokens = [['--void', '#04070d', 'Background'], ['--deep', '#08111c', 'Panel base'], ['--glass', 'rgba(16, 34, 52, .55)', 'Panel fill, blurred'], ['--arc', '#29e6ff', 'Live, primary, focus'],
    ['--arc-35', '35%', 'Borders, glows'], ['--arc-15', '15%', 'Fills'], ['--arc-06', '6%', 'Faint washes'], ['--amber', '#ffb547', 'Working, waiting'], ['--alert', '#ff4d5e', 'Needs you, blocked, bounced'],
    ['--ok', '#4dffa6', 'Done, handed off'], ['--agent', '#b28cff', 'Subagents'], ['--ink', '#d6f3ff', 'Text'], ['--ink-2', '68%', 'Secondary text'], ['--ink-3', '42%', 'Labels only']];
  const sw = tokens.map(([n, v, job]) => h('div', { class: 'swatch' }, h('span', { class: 'sw-c', style: `background:var(${n})` }), h('span', { class: 'sw-n mono', text: n }), h('span', { class: 'sw-v mono', text: v }), h('span', { class: 'sw-j', text: job })));
  const texts = [['--ink', [214, 243, 255, 1]], ['--ink-2', [214, 243, 255, .68]], ['--ink-3 (labels)', [214, 243, 255, .42]], ['--arc', [41, 230, 255, 1]], ['--amber', [255, 181, 71, 1]], ['--alert', [255, 77, 94, 1]], ['--ok', [77, 255, 166, 1]], ['--agent', [178, 140, 255, 1]]];
  const bgs = [['void', VOID], ['panel glass', GLASS], ['card', CARD], ['floating', FLOAT]];
  const ctab = h('table', { class: 'ctab mono' }, h('thead', {}, h('tr', {}, h('th', { text: 'text on' }), ...bgs.map(([n]) => h('th', { text: n })))),
    h('tbody', {}, ...texts.map(([n, c]) => h('tr', {}, h('th', { text: n }), ...bgs.map(([, b]) => { const r = ratio(over(c, b), b); return h('td', { class: r >= 4.5 ? 'pass' : r >= 3 ? 'large' : 'fail', text: r.toFixed(2) }); })))));
  section('Colour', 'Each colour has one job. Ratios are computed from the token values over each real background.',
    wide('Tokens', h('div', { class: 'swatches' }, sw)), wide('Contrast (WCAG ratio; body text needs 4.5)', h('div', { class: 'ctab-w' }, ctab)));

  // ---- type ----
  const tline = (fam, size, weight, sample, cls) => h('div', { class: 'tline' }, h('span', { class: 'tl-m mono', text: `${fam} ${size}/${weight}` }), h('span', { class: cls || '', style: `font-family:var(--f-${fam === 'Orbitron' ? 'display' : fam === 'Rajdhani' ? 'label' : fam === 'Inter' ? 'body' : 'mono'});font-size:${size}px;font-weight:${weight};line-height:1.25`, text: sample }));
  section('Type', 'Scale 11 / 13 / 15 / 18 / 24 / 34 / 56. Two weights per family.',
    wide('Display: Orbitron', tline('Orbitron', 56, 700, '12'), tline('Orbitron', 34, 700, 'HUD'), tline('Orbitron', 24, 500, 'SESSIONS'), tline('Orbitron', 18, 700, 'HUD'), tline('Orbitron', 13, 500, 'PANEL TITLE', 'pt')),
    spec('Labels: Rajdhani, uppercase, +0.14em', tline('Rajdhani', 13, 600, 'In progress', 'label-13'), tline('Rajdhani', 11, 600, 'Cache read · Context · Needs you', 'label')),
    spec('Body: Inter', tline('Inter', 15, 600, 'Quotation wizard: totals, VAT rows'), tline('Inter', 13, 400, 'Launched from the shell of the coordinator.')),
    spec('Numbers: JetBrains Mono, tabular', tline('Mono', 24, 400, '1.23M 4,881,203'), tline('Mono', 18, 400, '21:42:07'), tline('Mono', 13, 400, 'dotnet test -c Release'), tline('Mono', 11, 400, 'in 216 · out 126.8k · write 291k')));

  // ---- icons, status, chips, controls ----
  section('Icons and status', 'Icons: 24-unit grid, 1.5 px stroke. Status is always a word, a shape and a colour.',
    spec('Icons', h('div', { class: 'icons' }, Object.keys(H.ICONS).filter(n => n !== 'slash').map(n => h('div', { class: 'icon-c' }, icon(n), h('span', { class: 'mono', text: n }))))),
    spec('Session and subagent states', h('div', { class: 'col' }, ['needs-you', 'busy', 'idle', 'ended', 'running', 'done'].map(st => { const g = H.statusTag(); g.set(st, st === 'needs-you' ? '1:35' : st === 'running' ? '0:42' : null); return g.el; }))),
    spec('Plan states', h('div', { class: 'col' }, ['todo', 'in-progress', 'handed-off', 'accepted', 'blocked', 'bounced', 'partial', 'unknown'].map(st => { const g = H.statusTag(); g.set(st); return g.el; }))),
    spec('Chips and badges', h('div', { class: 'row' }, (() => {
      const pa = H.provBadge(), pb = H.provBadge(), pu = H.provBadge(); pa.set('anthropic', 'claude-opus-5-5'); pb.set('bedrock', 'us.anthropic.claude-opus-5-5'); pu.set('unknown');
      return [h('span', { class: 'chip', text: 'opus 5.5 · xhigh' }), h('span', { class: 'chip' }, icon('branch'), h('span', { class: 'trunc', text: 'customer-history' })), pa.el, pb.el, pu.el,
        h('button', { class: 'chip', type: 'button' }, icon('agent'), 'Started by', h('span', { class: 'trunc', text: 'Coordinator' })), h('span', { class: 'chip demo', text: 'Demo' }), h('span', { class: 'chip warn', text: 'Hooks off' }), h('span', { class: 'chip warn', text: 'Delayed' })];
    })())),
    spec('Controls', h('div', { class: 'row' }, (() => {
      const on = H.toggle('voice', 'Voice', true, () => {}), off = H.toggle('voice', 'Voice', false, () => {});
      const seg = h('div', { class: 'seg', style: 'margin:0' }, h('button', { type: 'button', 'aria-pressed': 'true' }, icon('cards'), 'Cards'), h('button', { type: 'button', 'aria-pressed': 'false' }, icon('network'), 'Network'));
      return [on.el, h('span', { class: 'label c-ink2', text: 'on' }), off.el, h('span', { class: 'label c-ink2', text: 'off' }), seg, h('button', { class: 'btn', type: 'button', text: 'Retry' })];
    })())),
    spec('Stream light', h('div', { class: 'col' }, ['live', 'reconnecting', 'down', 'connecting'].map(sv => h('div', { class: 'stream', 'data-s': sv }, h('span', { class: 'stream-dot' }), h('span', { class: 'label', text: { live: 'Live', reconnecting: 'Reconnecting', down: 'Down', connecting: 'Connecting' }[sv] }))))));

  // ---- meters ----
  const cm = [30, 72, 91, 100, null].map(p => { const m = H.contextMeter(); m.set(ctx(p)); return m.el; });
  const tm = H.tokenMeter(); tm.set(busy.tokens, busy.tokensTree, H.headline(busy.tokens) * 1.2);
  const crm = H.cacheMeter(); crm.set(busy.tokens.cacheRead, busy.tokens.cacheRead * 1.3);
  section('Meters', 'Every bar has its number beside it. Context: amber from 70%, red from 90%, “—” when the window is unknown.',
    spec('Context × 4 levels + unknown', h('div', { class: 'meters' }, cm)), spec('Tokens and cache read', h('div', { class: 'meters' }, tm.el, crm.el)));

  // ---- reactor and vitals ----
  const rx = (label, list) => { const r = H.reactor(); r.update(list, totals(list)); return spec(label, r.el); };
  const vit = H.vitals();
  vit.update({ sessions: all, totals: totals(all), plans: [1, 2, 3], account: { fiveHour: { pct: 42, resetsAt: t + 2.4 * 3600e3 }, sevenDay: { pct: 31, resetsAt: t + 3.2 * 86400e3 } } });
  const vitNoAcct = H.vitals(); vitNoAcct.update({ sessions: [], totals: Object.assign(totals([]), { plansInProgress: 0, plansNeedingYou: 0 }), plans: [], account: null });
  section('Reactor and vitals', 'Rings turn and the core beats only with EFFECTS on. Red breathing while anything needs you.',
    rx('Idle', []), rx('Busy', [busy, fresh, idle, long]), rx('Alert: something needs you', all),
    spec('Vitals with account limits', vit.el), spec('Vitals, empty, no account source', vitNoAcct.el));

  // ---- session cards ----
  const card = (label, x) => { const c = H.sessionCard({ jump: () => {} }); c.update(x, cardCtx); return spec(label, h('div', { class: 'cards' }, c.el)); };
  const rows = H.h('div', { class: 'cards compact' });
  for (const x of all) { const r = H.compactRow(); r.update(x); rows.append(r.el); }
  const deep = sess({ project: 'claude-hud', title: 'Folding: deep trees and many finished subagents', subagents: (() => {
    const out = [], a = sub({ type: 'general-purpose', description: 'Level 1' }), b = sub({ parentId: a.id, depth: 2, description: 'Level 2' }), c = sub({ parentId: b.id, depth: 3, description: 'Level 3' }), d = sub({ parentId: c.id, depth: 4, description: 'Level 4, folded' });
    out.push(a, b, c, d);
    for (let i = 0; i < 6; i++) out.push(sub({ type: 'web-fetch', description: `Finished job ${i + 1}`, state: 'done', currentTool: null, endedAt: t - (i + 1) * 60e3, startedAt: t - (i + 2) * 60e3 }));
    return out;
  })() });
  section('Session card', 'Comfortable cards up to 8 live sessions; above that, compact rows switch on by themselves.',
    card('Busy, with a nested subagent tree', busy), card('Needs you', needs), card('Idle, just finished, on Bedrock, context 92%', fresh), card('Idle, launched from the coordinator’s shell', idle), card('Ended (started by the coordinator)', ended),
    card('Long title, long branch, unknown model and context window', long), card('Subagent folding: depth over 3, more than 4 finished', deep),
    wide('Compact rows (more than 8 sessions)', rows));

  // ---- network ----
  const nets = [];
  const netSpec = (label, list, height, cls, after) => {
    const n = H.network({ showCard: () => {} });
    const box = h('div', { class: 'gal-net' + (cls ? ' ' + cls : ''), style: `height:${height}px` }, n.el);
    nets.push([n, list, after]);
    return [spec(label, box), n, list];
  };
  const dense = [];
  const projects = ['FidiaCRM', 'WasteManagement2', 'ImPOS-Maui', 'TourCMS', 'Aegis', 'fidiagraf.com'], sts = ['needs-you', 'busy', 'busy', 'idle', 'busy', 'idle', 'ended', 'busy'];
  for (let i = 0; i < 24; i++) {
    const st = sts[i % sts.length];
    const subs = st === 'busy' && i % 3 === 1 ? [sub({ tokens: tok(2000 + i * 300, 9000), context: ctx(10 + i) })] : [];
    if (subs.length && i % 2) subs.push(sub({ parentId: subs[0].id, depth: 2, type: 'web-fetch', tokens: tok(900, 4000) }));
    dense.push(sess({ project: projects[i % 6], status: st, needsYou: st === 'needs-you' ? { since: t - 40e3, reason: 'Permission: Edit', kind: 'permission' } : null, currentTool: st === 'busy' ? { name: 'Read', summary: 'Program.cs', since: t - 2e3 } : null,
      title: `Session ${i + 1}`, tokens: tok(4000 + (i * 7919) % 90000, 20000 + (i * 104729) % 300000), context: ctx((i * 37) % 97), endedAt: st === 'ended' ? t - 60e3 : null, provider: i % 7 === 3 ? 'bedrock' : 'anthropic', subagents: subs }));
  }
  const one = sess({ project: 'claude-hud', title: 'HUD phase P2: page and design system', subagents: [] });
  const [n1] = netSpec('One session', [one], 340);
  const [n2] = netSpec('One session with nested subagents (3 levels)', [busy, ended], 420);
  const [n3] = netSpec('24 sessions', dense, 560, 'wide');
  n3.classList.add('wide');
  const nodeSpec = (label, x) => netSpec(label, [x], 220)[0];
  const runSess = sess({ project: 'Demo', title: 'Parent', subagents: [sub({ type: 'Explore', tokens: tok(30000, 80000), context: ctx(50) })] });
  const doneSess = sess({ project: 'Demo', status: 'idle', currentTool: null, title: 'Parent', subagents: [sub({ type: 'Explore', state: 'done', currentTool: null, endedAt: t - 5e3, tokens: tok(30000, 80000), context: ctx(50) })] });
  section('Network: who started whom', 'Hub = this PC. Sessions on the inner ring, grouped by project; subagents outwards, one ring per level. Size = tokens (square root, 3× range), outer ring = context, A / B = provider, double line = launched by.',
    n1, n2, n3,
    nodeSpec('Node: running subagent', runSess), nodeSpec('Node: finished subagent', doneSess), nodeSpec('Node: needs you', sess({ project: 'Demo', status: 'needs-you', needsYou: { since: t - 20e3, reason: 'Question for you', kind: 'question' }, title: 'Asks a question' })),
    nodeSpec('Node: context 50%', sess({ project: 'Demo', status: 'idle', currentTool: null, context: ctx(50), title: 'Half full' })), nodeSpec('Node: context 80%', sess({ project: 'Demo', status: 'idle', currentTool: null, context: ctx(80), title: 'Filling up' })),
    nodeSpec('Node: context 95%', sess({ project: 'Demo', status: 'idle', currentTool: null, context: ctx(95), title: 'Nearly full' })),
    nodeSpec('Node: Anthropic', sess({ project: 'Demo', provider: 'anthropic', title: 'Anthropic API' })), nodeSpec('Node: Bedrock', sess({ project: 'Demo', provider: 'bedrock', modelRaw: 'us.anthropic.claude-opus-5-5', title: 'Amazon Bedrock' })),
    netSpec('Empty', [], 220)[0],
    netSpec('Hover: the path to the hub lights up, the card docks away from it', [nested({ project: 'Demo' })], 360, null, (n, list) => n.hoverDemo(list[0].subagents[1].id))[0],
    netSpec('Pinned: the card stays, with “Show in cards”', [nested({ project: 'Demo' })], 420, null, (n, list) => n.pin(list[0].subagents[0].id))[0],
    netSpec('Launched by: a session started from another session’s shell (double line)', (() => { const a = sess({ project: 'Demo', title: 'Coordinator' }); const b = sess({ project: 'Other', title: 'claude -p "say hi"', status: 'idle', currentTool: null, lastActivityAt: t - 4e3, startedBy: a.id, tokens: tok(400, 6000) }); return [a, b]; })(), 300)[0],
    netSpec('Over 40 nodes: finished subagents fold into a numbered satellite (click to expand)', (() => { const out = []; for (let i = 0; i < 4; i++) { const subs = []; for (let k = 0; k < 11; k++) subs.push(sub({ type: 'web-fetch', description: 'Job ' + k, state: 'done', currentTool: null, endedAt: t - k * 6e4, tokens: tok(800 + k * 90, 4000) })); subs.push(sub({ type: 'Explore', description: 'Still running', tokens: tok(9000, 30000) })); out.push(sess({ project: ['FidiaCRM', 'TourCMS'][i % 2], title: 'Fan-out ' + (i + 1), subagents: subs })); } return out; })(), 420, 'wide')[0]);

  // ---- tooltip card ----
  const tipDemo = h('div', { class: 'tip on gal-static' }, h('div', { class: 'tip-b cutbox' }, H.network().nodeCard({ kind: 'session', id: busy.id, state: 'busy', depth: 0, x: busy })));
  const longTitle = 'Phone app phase 7: battery and Xiaomi autostart switches, runbook for the real-phone pass on the Samsung';
  const truncDemo = h('div', { class: 'col', style: 'max-width:300px' }, h('div', { class: 'card-title trunc', style: 'align-self:stretch', text: longTitle }), h('div', { class: 'tip on gal-static' }, h('div', { class: 'tip-b cutbox' }, h('div', { class: 'tip-t', text: longTitle }))));
  const focusDemo = h('div', { class: 'row' }, h('button', { class: 'tgl focus-demo', type: 'button', 'aria-pressed': 'true', 'aria-label': 'Effects' }, icon('effects')), h('button', { class: 'btn focus-demo', type: 'button', text: 'Retry' }), h('span', { class: 'chip focus-demo', text: 'Started by Coordinator' }), h('span', { class: 'label c-ink2', text: '2 px --arc ring, 2 px offset, on every control' }));
  section('Floating layer', 'Tooltips, the pinned card and the alerts sit above the panels: stronger glow, brighter border.', spec('Node tooltip card', tipDemo),
    spec('Long text truncates; the full text is in a tooltip', truncDemo), spec('Keyboard focus', focusDemo),
    spec('Plan node tooltip', h('div', { class: 'tip on gal-static' }, h('div', { class: 'tip-b cutbox' }, H.planNodeCard({ id: 'P3', name: 'Change requests in the service', agent: 'requests', state: 'in-progress', stateRaw: 'in-progress', since: '2026-10-29', model: 'Opus 5.5', effort: 'high', waitsFor: ['P1'], notes: 'Waits for P1. The service accepts change requests from the portal.' })))));

  // ---- plans ----
  const P = (id, name, agent, state, waitsFor = [], extra = {}) => Object.assign({ id, name, agent, state, stateRaw: state, since: state === 'todo' ? null : '2026-10-29', waitsFor, waitsForOther: [], notes: waitsFor.length ? 'Waits for ' + waitsFor.join(' and ') : null, group: 'Board', kind: 'phase', model: 'Opus 5.5', effort: 'high' }, extra);
  const plan = (o) => Object.assign({ project: 'WasteManagement2', slug: uid('plan'), title: 'Customer change history and change requests', path: 'docs/plans/customer-history/STATUS.md', format: 'standard', size: 'phased', state: 'building', stateDate: null, needsYou: [], runs: [], lastLog: ['2026-10-29 · data · P1 · Handed off: history tables and triggers, 14 tests.'] }, o);
  const pc = (label, p, cls) => { const c = H.planCard(); const box = h('div', { class: 'plans' }, c.el); const e = spec(label, box); if (cls) e.classList.add(cls); requestAnimationFrame(() => c.update(p)); return e; };
  section('Plan graph', 'Laid out from “waits for”; left to right when it fits, top to bottom when not. Edges into a running phase flow.',
    pc('Node × every state', plan({ title: 'Every state', phases: [P('P1', 'Accepted', 'a', 'accepted'), P('P2', 'Handed off', 'b', 'handed-off', ['P1']), P('P3', 'In progress', 'c', 'in-progress', ['P2']), P('P4', 'Partial', 'd', 'partial', ['P3']), P('P5', 'Blocked', 'e', 'blocked', ['P4']), P('P6', 'Bounced', 'f', 'bounced', ['P5']), P('P7', 'Todo', 'g', 'todo', ['P6']), P('P8', 'Unknown', 'h', 'unknown', ['P7'])] }), 'wide'),
    pc('Phased plan: P1 → (P2 ∥ P3) → P4', plan({ phases: [P('P1', 'Data and history', 'data', 'accepted'), P('P2', 'History tab and header', 'history-ui', 'in-progress', ['P1']), P('P3', 'Change requests in the service', 'requests', 'bounced', ['P1']), P('P4', 'Verification and cleanup', 'verify', 'todo', ['P2', 'P3'])] })),
    pc('Chunk board with runs, an owner input and a question', plan({ project: 'FidiaCRM', title: 'Implementation', format: 'legacy', state: null,
      phases: [P('UX-01', 'Spec, tokens, gates', null, 'done'), P('UX-02', 'Frame and action bars', null, 'done', ['UX-01']), P('UX-03', 'Table system', null, 'done', ['UX-02']), P('UX-10', 'Quotation wizard', null, 'in-progress', ['UX-03']), P('UX-11', 'Quotations', null, 'todo', ['UX-03']), P('UX-12', 'Clients', null, 'todo', ['UX-03', 'O-9']), P('O-9', 'Production column sizes', null, 'todo', [], { kind: 'input', group: 'Owner inputs' }), P('UX-20', 'Sweep and owner review', null, 'todo', ['UX-10', 'UX-11', 'UX-12'])],
      runs: [{ id: 'R14', name: 'Quotation screens', state: 'in-progress', lane: 'A', chunks: ['UX-10', 'UX-11'], startWhen: 'UX-06 done' }, { id: 'R15', name: 'Clients screens', state: 'todo', lane: 'B', chunks: ['UX-12'], startWhen: 'O-9 is in' }],
      needsYou: [{ kind: 'question', id: '3', item: 'UX-12', text: 'Contact names longer than 60 characters: cut them, or widen the column to 120?' }], lastLog: [] })),
    pc('Small plan with an open decision', plan({ project: 'TourCMS', title: 'Booking changes', size: 'small', state: 'approved', stateDate: '2026-10-28', phases: [P('P1', 'Change dates', 'bookings', 'todo'), P('P2', 'Change people', 'bookings', 'todo', ['P1'])], needsYou: [{ kind: 'decision', id: 'D2', text: 'A changed booking keeps its original price unless the tour price went down ★' }], lastLog: [] })));

  // ---- alerts, ticker, externals, states ----
  const b1 = H.banners({}), b4 = H.banners({});
  b1.update([needs]);
  b4.update([needs, sess({ project: 'TourCMS', status: 'needs-you', needsYou: { since: t - 30e3, reason: 'Question for you', kind: 'question' }, title: 'Booking changes' }), sess({ project: 'ImPOS-Maui', status: 'needs-you', needsYou: { since: t - 12e3, reason: 'Plan approval', kind: 'question' }, title: 'Phone app phase 7' }), sess({ project: 'Aegis', status: 'needs-you', needsYou: { since: t - 5e3, reason: 'Waiting for your input', kind: 'input' }, title: 'Rules engine' })]);
  b1.el.classList.add('gal-static'); b4.el.classList.add('gal-static');
  const tkP = H.panel('p-tick', 'Feed'), tkT = H.ticker(tkP.el, tkP.head); tkP.content.replaceWith(tkT.el);
  [['session', 'Session started', 'TourCMS'], ['tool', 'Bash · dotnet test -c Release --no-build', 'FidiaCRM'], ['agent', 'Agent started · Explore: map the quotation totals code', 'WasteManagement2'], ['needs-you', 'Permission: Bash', 'FidiaCRM'], ['done', 'Agent done · web-fetch: read the Syncfusion grid docs', 'WasteManagement2'], ['plan', 'Customer change history: P2 in-progress → handed-off', 'WasteManagement2']]
    .forEach(([kind, text, project], i) => tkT.add({ at: t - (6 - i) * 7000, sessionId: null, project, kind, text }));
  const exP = H.panel('p-ext', 'Outside Claude Code'), exB = H.externals(); exP.content.append(exB.el);
  exB.update([{ source: 'ingest', app: 'invoice-ocr', provider: 'bedrock', model: 'claude-haiku-5-5', modelRaw: 'anthropic.claude-haiku-5-5', tokens: tok(52000, 0, 410000), windowStart: t - 9e6, windowEnd: t, delayed: false },
    { source: 'ingest', app: 'support-bot', provider: 'bedrock', model: 'claude-sonnet-5-5', modelRaw: 'us.anthropic.claude-sonnet-5-5-v1:0', tokens: tok(120000, 0, 980000), windowStart: t - 9e6, windowEnd: t, delayed: false },
    { source: 'cloudwatch', app: null, provider: 'bedrock', model: 'claude-sonnet-5-5', modelRaw: 'us.anthropic.claude-sonnet-5-5-v1:0', tokens: tok(400000, 0, 3100000), windowStart: t - 9e6, windowEnd: t - 3e5, delayed: true }], 'CloudWatch: aws CLI not found');
  const moreP = H.panel('p-sess', 'Sessions'), moreBox = h('div', { class: 'cards' }), moreH = H.moreBelow(moreP.content, moreBox, H.stateCounts);
  moreP.el.style.height = '320px'; moreP.content.style.overflow = 'auto'; moreP.content.append(moreBox, moreH.el);   // gallery panels don't scroll; this one must
  for (const x of [fresh, idle, ended]) { const c = H.sessionCard({ jump: () => {} }); c.update(x, cardCtx); moreBox.append(c.el); }
  const errP = H.panel('p-plans', 'Plans'); errP.el.style.flex = '1'; errP.guard(() => { throw new Error('Cannot read properties of undefined (reading \'phases\')'); }, () => {});
  const emptyP = H.panel('p-sess', 'Sessions'); emptyP.content.append(h('div', { class: 'cards-empty' }, h('span', { class: 'label', text: 'No active sessions' }), ' · systems nominal'));
  const conn = h('div', { class: 'conn gal-static', 'data-s': 'reconnecting' }, h('span', { class: 'label', text: 'Connection lost · reconnecting' }), h('span', { class: 'mono', text: 'last update 12s ago' }), h('button', { type: 'button', text: 'Retry now' }));
  const connDown = h('div', { class: 'conn gal-static', 'data-s': 'down' }, h('span', { class: 'label', text: 'HUD server not answering' }), h('span', { class: 'mono', text: 'last update 41s ago' }), h('button', { type: 'button', text: 'Retry now' }));
  const topB = H.topBar(); topB.update({ host, demo: false, hooksInstalled: false, now: t, uptime: 2 * 3600e3 + 14 * 60e3, sessions: all, totals: totals(all) }); topB.setStream('live');
  section('Alerts, feed, externals, page states', null,
    wide('Top bar (hooks not installed)', h('div', { class: 'gal-topbar' }, topB.el)),
    wide('Needs-you banner: one', b1.el), wide('Needs-you banner: several stack, with a count', b4.el),
    wide('Ticker', tkP.el), spec('Feed tags', h('div', { class: 'row' }, ...Object.entries(H.FEED_TAGS).map(([k, w]) => h('span', { class: 'tk-tag', 'data-k': k, style: 'padding:0 8px', text: w })))),
    spec('More below: a panel that scrolls says what it hides; a click brings it up', moreP.el), spec('Externals panel (D12 on)', exP.el),
    spec('Empty', emptyP.el), spec('Error in one panel, with retry', h('div', { style: 'height:220px;display:flex' }, errP.el)),
    wide('Reconnecting, then down: the last state stays, dimmed', h('div', { class: 'col' }, conn, connDown, (() => { const c = H.sessionCard(); c.update(busy, cardCtx); return h('div', { class: 'stale', style: 'width:100%' }, h('div', { class: 'main gal-main' }, h('div', { class: 'cards' }, c.el))); })())));

  // ---- render the networks once they have a size; then keep the fixtures alive so the motion can be reviewed ----
  const netCtx = { byId: new Map([...all, ...dense, one].map(x => [x.id, x])), host, maxTok: 1, maxCache: 1 };
  requestAnimationFrame(() => nets.forEach(([n, list, after]) => { n.update(list, netCtx); if (after) after(n, list); }));
  let tickN = 0;
  setInterval(() => {
    tickN++;
    for (const x of [busy, one, ...dense]) if (x.status === 'busy') { x.tokens.output += 400; x.tokens.cacheWrite += 1200; if (tickN % 2 === 0) x.currentTool = { name: ['Read', 'Edit', 'Bash', 'Grep'][tickN % 4], summary: 'src/Quotations/QuotationTotals.cs', since: Date.now() }; }
    for (const a of busy.subagents) if (a.state === 'running') { a.tokens.output += 300; a.tokens.cacheWrite += 900; if (tickN % 3 === 0) a.currentTool = { name: 'Read', summary: 'Program.cs', since: Date.now() }; }
    if (tickN % 8 === 0) {   // a subagent finishes (return pulse) and another starts
      const run = busy.subagents.filter(a => a.state === 'running' && a.depth > 1).pop() || busy.subagents.find(a => a.state === 'running');
      if (run) { run.state = 'done'; run.endedAt = Date.now(); run.currentTool = null; }
      busy.subagents = busy.subagents.filter(a => a.state === 'running' || Date.now() - (a.endedAt || 0) < 40e3);
      busy.subagents.push(sub({ parentId: busy.subagents[0] ? busy.subagents[0].id : busy.id, depth: busy.subagents[0] ? 2 : 1, type: 'web-fetch', description: 'Fresh job ' + tickN, startedAt: Date.now(), provider: busy.provider }));
    }
    nets.forEach(([n, list]) => n.update(list, netCtx));
    H.tickTimers();
  }, 1500);
}

function hudPage(kind) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark">
<title>${kind === 'design' ? 'Claude HUD · design system' : 'Claude HUD'}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='13' fill='%2304070d' stroke='%2329e6ff' stroke-width='2' stroke-dasharray='14 6'/%3E%3Ccircle cx='16' cy='16' r='5' fill='%2329e6ff'/%3E%3C/svg%3E">
${HUD_FONTS}
<style>${HUD_CSS}</style>
</head><body${kind === 'design' ? ' class="gallery"' : ''}>
<script>
const H = (${hudClient})();
(${kind === 'design' ? designMain : pageMain})(H);
</script>
</body></html>`;
}
let pageHtmlCache = null, designHtmlCache = null;
const pageHtml = () => pageHtmlCache ??= hudPage('page');
const designHtml = () => designHtmlCache ??= hudPage('design');


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
      now, uptime: now - t0, demo: dense ? 'dense' : true, version: VERSION, host: 'STARK-01', hooksInstalled: true,   // a made-up machine, so demo screenshots carry no real one
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
  server.listen(PORT, HOST, () => {
    console.log(`Claude HUD ${VERSION} on http://${LAN ? 'localhost' : HOST}:${PORT}${demoMode ? ` (demo${demoMode === 'dense' ? ', dense' : ''})` : ''}`);
    if (!demoMode) console.log(`Watching Claude Code in: ${ROOTS.map(r => r.dir).join('  ')}`);
    if (!LAN) return;
    const urls = Object.values(os.networkInterfaces()).flat()
      .filter(a => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')).map(a => `http://${a.address}:${PORT}`);
    console.log(`Open on this network (view only): ${urls.join('  ') || 'no network address found'}`);
  });
  setInterval(() => { for (const c of clients) c.write(': keep-alive\n\n'); }, KEEPALIVE_MS);
  if (demoMode) { demo = makeDemo(demoMode); return; }

  autoInstall();
  readSettingsFlags();
  readAccount();
  const watch = (dir, opts, fn) => { try { fs.watch(dir, opts, fn).on('error', () => {}); } catch {} };
  for (const root of ROOTS) {
    fs.watchFile(root.settings, { interval: 5000 }, readSettingsFlags);
    fs.watchFile(root.json, { interval: 10_000 }, readAccount);
    watch(root.sessions, {}, (e, f) => { if (!f || /^\d+\.json$/.test(f)) scanRegistry(); });
    watch(root.projects, { recursive: true }, (e, f) => onProjectsChange(root, f));
  }
  scanRegistry().then(scanRecentTranscripts);
  setInterval(poll, POLL_MS);
  if (BEDROCK_REGION) {
    if (/^[a-z]{2}(-[a-z]+)+-\d+$/.test(BEDROCK_REGION)) { pollCloudWatch(); setInterval(pollCloudWatch, CLOUDWATCH_EVERY_MS); }
    else externalError = 'CloudWatch: HUD_BEDROCK_REGION is not a region name';
  }
}

// =====================================================================================================================
// install / uninstall (PLAN §4.2): a watched folder's settings.json is changed only here (by the commands, and by
// autoInstall when the HUD starts).

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
class SettingsError extends Error {}   // a settings.json the HUD will not touch; the message says why
function readSettingsText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function parseSettings(raw, file) {
  let obj;
  try { obj = raw == null ? {} : JSON.parse(raw.replace(/^﻿/, '')); } catch { throw new SettingsError(`${file} is not valid JSON. Nothing was changed.`); }
  if (!isObj(obj)) throw new SettingsError(`${file} does not hold a JSON object. Nothing was changed.`);
  if (obj.hooks !== undefined && !isObj(obj.hooks)) throw new SettingsError(`"hooks" in ${file} is not an object. Nothing was changed.`);
  return obj;
}
function formatLike(raw, obj) {
  const indent = (/^([ \t]+)"/m.exec(raw || '') || [null, '  '])[1];
  let out = JSON.stringify(obj, null, indent);
  if (raw == null || /\n$/.test(raw)) out += '\n';
  if (raw?.includes('\r\n')) out = out.replace(/\n/g, '\r\n');
  if (raw?.startsWith('﻿')) out = '﻿' + out;
  return out;
}
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}
function backupSettings(raw, file) {
  const base = `${file}.hud-backup-${stamp()}`;
  for (let n = 1; ; n++) {
    const backup = n === 1 ? base : `${base}-${n}`;
    try { fs.writeFileSync(backup, raw, { flag: 'wx' }); return backup; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}
function writeSettings(text, file) {
  const tmp = `${file}.hud-tmp`;
  fs.writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 10) { fs.writeFileSync(file, text); fs.rmSync(tmp, { force: true }); return; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);   // the file can be briefly locked by a reader
    }
  }
}

/** Puts the HUD's hooks into one settings.json (backup first). Returns { changed, backup }; throws SettingsError. */
function installInto(file) {
  const raw = readSettingsText(file);
  const obj = parseSettings(raw, file);
  const next = structuredClone(obj);
  next.hooks = next.hooks ? next.hooks : {};
  for (const ev of HOOK_EVENTS) {
    const want = ourGroup(ev);
    const groups = next.hooks[ev] ?? [];
    if (!Array.isArray(groups)) throw new SettingsError(`"hooks.${ev}" in ${file} is not a list. Nothing was changed.`);
    const ok = countOurs(groups) === 1 && groups.some(g => isDeepStrictEqual(g, want));
    next.hooks[ev] = ok ? groups : [...removeOurs(groups), want];
  }
  if (isDeepStrictEqual(next, obj)) return { changed: false, backup: null };
  const backup = raw == null ? null : backupSettings(raw, file);
  writeSettings(formatLike(raw, next), file);
  return { changed: true, backup };
}

/** `node hud.mjs install`: every folder the HUD watches, so the page never says "Hooks off" for one of them. */
function install() {
  let bad = 0;
  for (const root of ROOTS) {
    try {
      const { changed, backup } = installInto(root.settings);
      if (!changed) { console.log(`Claude HUD hooks are already installed in ${root.settings}. It was not changed.`); continue; }
      console.log(`Installed Claude HUD hooks for ${HOOK_EVENTS.length} events in ${root.settings}`);
      if (backup) console.log(`Backup of the previous file: ${backup}`);
    } catch (e) { bad++; console.error(e instanceof SettingsError ? e.message : `${root.settings}: ${e.message}`); }
  }
  console.log(`Hook command: ${HOOK_COMMAND}`);
  console.log('Open sessions pick the change up by themselves. Remove the hooks with: node hud.mjs uninstall');
  if (bad) process.exit(1);
}

/**
 * Run when the HUD starts, so the hooks need no command: a folder without them (a new `~/.claude-*`, or a moved
 * hud.mjs) gets them now. Only at start, so `uninstall` on a running HUD sticks. HUD_NO_AUTOINSTALL=1 turns it off.
 */
function autoInstall() {
  if (process.env.HUD_NO_AUTOINSTALL === '1') return;
  for (const root of ROOTS) {
    try {
      const { changed, backup } = installInto(root.settings);
      if (changed) console.log(`Installed the HUD's hooks in ${root.settings}${backup ? ` (backup: ${backup})` : ''}`);
    } catch (e) { console.error(`Could not install the HUD's hooks in ${root.settings}: ${e.message}`); }
  }
}

function uninstallFrom(file) {
  const raw = readSettingsText(file);
  if (raw == null) return { removed: 0, note: `No ${file}: nothing to remove.` };
  const obj = parseSettings(raw, file);
  if (!obj.hooks) return { removed: 0, note: `No hooks in ${file}: nothing to remove.` };
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
  if (!removed) return { removed: 0, note: `No Claude HUD hooks found in ${file}. It was not changed.` };
  const emptied = Object.keys(next.hooks).length === 0;
  const withoutKey = structuredClone(next);
  if (emptied) delete withoutKey.hooks;
  // Restore the exact bytes of a backup when it holds this same content (keeps the file byte-identical).
  let text = null, from = null;
  const dir = path.dirname(file), name = path.basename(file);
  const backups = fs.readdirSync(dir).filter(f => f.startsWith(`${name}.hud-backup-`)).sort().reverse();
  for (const f of backups) {
    const b = readSettingsTextAt(path.join(dir, f));
    let parsed;
    try { parsed = JSON.parse(b.replace(/^﻿/, '')); } catch { continue; }
    if (isDeepStrictEqual(parsed, withoutKey) || (emptied && isDeepStrictEqual(parsed, next))) { text = b; from = f; break; }
  }
  const backup = backupSettings(raw, file);
  writeSettings(text ?? formatLike(raw, withoutKey), file);
  return { removed, from, backup };
}

/** `node hud.mjs uninstall`: every watched folder. A running HUD does not put the hooks back (it only does at start). */
function uninstall() {
  let bad = 0;
  for (const root of ROOTS) {
    try {
      const r = uninstallFrom(root.settings);
      if (r.note) { console.log(r.note); continue; }
      console.log(`Removed ${r.removed} Claude HUD hook entr${r.removed === 1 ? 'y' : 'ies'} from ${root.settings}`);
      if (r.from) console.log(`The file now matches ${r.from} byte for byte.`);
      console.log(`Backup of the previous file: ${r.backup}`);
    } catch (e) { bad++; console.error(e instanceof SettingsError ? e.message : `${root.settings}: ${e.message}`); }
  }
  console.log('The HUD puts the hooks back each time it starts. Turn that off with HUD_NO_AUTOINSTALL=1, and remove autostart: node hud.mjs autostart off');
  if (bad) process.exit(1);
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
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\\conhost.exe') -Argument ${q(`--headless "${process.execPath}" "${SCRIPT}"${LAN ? ' --lan' : ''}`)} -WorkingDirectory ${q(path.dirname(SCRIPT))}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName ${q(task)} -Description 'Starts the Claude HUD dashboard (port ${PORT}${LAN ? ', open to the local network' : ', this PC only'}) at logon, without a window.' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
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

  // Provider from transcript lines, as Claude Code writes them (Bedrock shapes seen on a real Bedrock setup, 2026-10-29).
  const agentFrom = (...lines) => {
    const t = { info: newInfo(), owner: null };
    for (const l of lines) processLine(t, JSON.stringify(l));
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
  const hostOk = hostAllowed;
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
  node hud.mjs --lan           also open it to other devices on the network, view only (or set HUD_LAN=1)
  node hud.mjs --demo          serve simulated sessions, subagents, plans and events
  node hud.mjs --demo=dense    the same with 24 sessions
  node hud.mjs install         add the HUD's hooks to every watched Claude Code folder's settings.json (backup first;
                               safe to repeat; the HUD also does this by itself each time it starts)
  node hud.mjs uninstall       remove only the HUD's hooks from those files (HUD_NO_AUTOINSTALL=1 stops the re-adding)
  node hud.mjs autostart on|off  start the HUD at logon (Task Scheduler, no window), or stop doing so
                               (add --lan to autostart on to start it open to the network)
  node hud.mjs lint [repo] [--json]  check a repository against the agent workflow standard
  node hud.mjs selftest        check the model normaliser, redaction and plan parser
  node hud.mjs hook            the hook forwarder (Claude Code runs this; it prints nothing)`;

const ARGS = process.argv.slice(2).filter(a => a !== '--lan');
const [cmd, arg] = ARGS;
if (cmd === 'hook') runHook();
else if (!cmd) serve(null);
else if (cmd === '--demo' || cmd === '--demo=dense') serve(cmd === '--demo=dense' ? 'dense' : 'demo');
else if (cmd === 'install') install();
else if (cmd === 'uninstall') uninstall();
else if (cmd === 'autostart') autostart(arg);
else if (cmd === 'lint') lint(ARGS.slice(1));
else if (cmd === 'selftest') selftest();
else if (cmd === 'help' || cmd === '--help' || cmd === '-h') console.log(HELP);
else { console.error(`Unknown command: ${cmd}\n\n${HELP}`); process.exit(1); }

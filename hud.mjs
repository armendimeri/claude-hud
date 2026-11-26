#!/usr/bin/env node
// Claude HUD: one live dashboard for Claude Code and Codex sessions on this PC.
// Node 22 built-ins only and no build step. `node hud.mjs help` lists the commands; README.md has the rest.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readConfig, VERSION } from './src/config.mjs';
import { createRuntime } from './src/app/runtime.mjs';
import { createHttpServer } from './src/http/server.mjs';
import { hostAllowed, writeAllowed } from './src/http/security.mjs';
import { HOOK_FIELDS, TOOL_INPUT_FIELDS, TOOL_RESPONSE_FIELDS, runHook, slimHookPayload } from './hud-hook.mjs';

// =====================================================================================================================
// Settings

// Context window per model, in tokens (D13). A model missing here gets `context: null`: never a guess.
// The 5.2 rows: platform.claude.com/docs/en/models/fable-5-2/overview and .../mythos-5-2/overview ("Context window: 1M").
const CONTEXT_WINDOWS = {
  'claude-fable-5-2': 1_000_000,
  'claude-mythos-5-2': 1_000_000,
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

const ENDED_KEEP_MS = 2 * 3600_000;      // D7
const POLL_MS = 3_000;
const PLAN_POLL_MS = 10_000;             // recover missed file events and documentation folders created later
const SILENT_SUBAGENT_MS = 120_000;      // fallback close for a subagent nobody reported done
const MINUTE_MS = 60_000;
const PULSE_MINUTES = 30;
const TOOL_ALERT_MS = 10 * MINUTE_MS;
const SUB_ALERT_MS = 5 * MINUTE_MS;
const SILENT_SESSION_MS = 10 * 60_000;   // a session outside the registry counts as ended after this much silence
const SETTLE_MS = 8_000;                 // hud-0-3 D7: a session with no work yet is shown after this long
const SETTLE_WORK_MS = 60_000;           // work this long before the HUD first saw a session still counts as its first work
const STARTUP_MS = 5_000;                // sessions found this soon after the HUD starts are shown at once
const PLAN_WRITE_MS = 60_000;            // a board change this soon after an agent wrote the file is that agent's
const HISTORY_MAX = 50;                  // state changes kept per plan, in memory
const REFS_MAX = 40;                     // ID-shaped words kept per agent from its task text
const TOUCHED_MAX = 20;                  // plan files read or written, kept per agent
const ITEMS_MAX = 3;                     // board items one agent links to
const EXTERNAL_ROWS_MAX = 200;
const CLOUDWATCH_EVERY_MS = 60_000;
// Recognise both hook commands even if the HUD folder has moved.
const HOOK_COMMAND = `node "${fileURLToPath(new URL('./hud-hook.mjs', import.meta.url)).replace(/\\/g, '/')}"`;
const OUR_HOOK_RE = /^node "[^"]*[\\/]hud(?:\.mjs" hook|-hook\.mjs")$/;
const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact'];
const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const SYNC_EVENTS = new Set(['SessionEnd']);   // async hooks can be killed when a session exits

const REOPEN_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const runsInBackground = input => input?.run_in_background === true || input?.run_in_background === 'true';
const SCRIPT = fileURLToPath(import.meta.url);
const NEEDS_INPUT_TOOLS = { AskUserQuestion: 'Question for you', ExitPlanMode: 'Plan approval' };

// =====================================================================================================================
// Small helpers

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
const minuteOf = ts => Math.floor(ts / MINUTE_MS) * MINUTE_MS;
function startOfDay(ts = Date.now()) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function readJsonSync(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }
async function readJson(file) { try { return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; } }
function capSet(set, max) { while (set.size > max) set.delete(set.values().next().value); }

export function createHudRuntime(config = readConfig(), demoMode = false) {
  return createRuntime((lifetime, publisher) => createEngine(config, demoMode, lifetime, publisher));
}

function selftest(config) {
  let runChecks;
  createRuntime((lifetime, publisher) => {
    const engine = createEngine(config, false, lifetime, publisher);
    runChecks = engine.selftest;
    return engine;
  });
  runChecks(config.port);
}

// Keep the legacy collectors together until P6 and P7 can move them behind focused source interfaces.
function createEngine(config, demoMode, lifetime, publisher) {
  const {
    hostname: HOSTNAME, unclaimedMs: UNCLAIMED_MS, stalledMs: STALLED_MS, bedrockRegion: BEDROCK_REGION,
  } = config;
  const ROOTS = config.roots.map(root => ({ ...root, bedrock: false, hooks: false }));
  const CODEX_ROOTS = [...config.codexRoots];
  const { redact, redactDeep, appendFeed, invalidate: scheduleState } = publisher;
  const rootOf = file => {
    const key = file.toLowerCase();
    return ROOTS.find(root => key.startsWith(root.projects.toLowerCase() + path.sep)) ?? null;
  };

  function start() {
    hudStartedAt = Date.now();
    if (demoMode) {
      demo = makeDemo(demoMode);
      return;
    }

    configurePhonePush();
    if (!config.noAutoInstall) autoInstall(ROOTS);
    readSettingsFlags();
    void readAccount();
    const watch = (dir, options, listener) => {
      try { lifetime.watch(dir, options, listener)?.on('error', () => {}); } catch {}
    };
    for (const root of ROOTS) {
      lifetime.watchFile(root.settings, { interval: 5000 }, readSettingsFlags);
      lifetime.watchFile(root.json, { interval: 10_000 }, readAccount);
      watch(root.sessions, {}, (event, file) => { if (!file || /^\d+\.json$/.test(file)) void scanRegistry(); });
      watch(root.projects, { recursive: true }, (event, file) => onProjectsChange(root, file));
    }
    void scanRegistry().then(scanRecentTranscripts);
    for (const dir of CODEX_ROOTS) {
      const sessions = path.join(dir, 'sessions');
      watch(sessions, { recursive: true }, (event, file) => onCodexChange(sessions, file));
    }
    void scanCodex(true);
    lifetime.interval(poll, POLL_MS);
    if (!BEDROCK_REGION) return;
    if (/^[a-z]{2}(-[a-z]+)+-\d+$/.test(BEDROCK_REGION)) {
      pollCloudWatch();
      lifetime.interval(pollCloudWatch, CLOUDWATCH_EVERY_MS);
    } else externalError = 'CloudWatch: HUD_BEDROCK_REGION is not a region name';
  }

  function ingestHook(value) {
    // Omit prompts before recording as well as before passing a direct POST to the engine.
    let payload = value;
    if (isObj(value)) {
      const { prompt, ...fields } = value;
      if (isObj(fields.tool_input)) {
        const { prompt, ...input } = fields.tool_input;
        fields.tool_input = input;
      }
      payload = fields;
    }
    if (config.recordFile) {
      try { fs.appendFileSync(config.recordFile, JSON.stringify(redactDeep(payload)) + '\n'); }
      catch (error) { console.error(`HUD_RECORD: ${error.message}`); }
    }
    if (!demoMode) onHook(payload);
    return [204, ''];
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
    if (info?.codexProvider) m.provider = info.codexProvider;
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
  function contextFor(model, used, reportedWindow) {
    const window = num(reportedWindow) || CONTEXT_WINDOWS[model];
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
      case 'exec_command': out = str(input.cmd); break;
      case 'shell': case 'shell_command': out = Array.isArray(input.command) ? input.command.join(' ') : str(input.command); break;
      case 'read_file': out = shortPath(str(input.path), cwd); break;
      case 'spawn_agent': out = str(input.task_name) || str(input.agent_type); break;
      case 'request_user_input': case 'request_user_input_async': out = 'Question for you'; break;
      case 'apply_patch': out = 'Apply file changes'; break;
      case 'exec': out = 'Run tools'; break;
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
  // Engine state

  let hudStartedAt;
  const sessions = new Map();     // sessionId -> session
  const tails = new Map();        // transcript file (lower-cased) -> tail
  const feedSeen = new Set();     // de-duplicates feed lines that hooks and transcripts both report
  const plans = new Map();        // `${project}|${relative path}` -> { plan, mtime, rootKey }
  const roots = new Map();        // project root (lower-cased) -> { root, project, watchers, timer }
  const rootCache = new Map();    // cwd (lower-cased) -> { root, mainRoot, project }
  const external = new Map();     // D12 rows
  const planWrites = new Map();   // plan file key -> { sessionId, agentId, at }: the last agent that wrote it (hud-0-3 §4.2)
  const planHistory = new Map();  // planKey -> the plan's last HISTORY_MAX state changes, { at, id, from, to, sessionId, agentId }
  const boardTrack = new Map();   // itemKey -> { inFlightSince, lastInFlightAt, changedAt, on }: the marks' clocks, in memory
  let externalError = null;
  let account = null;             // 5-hour and weekly usage from Claude Code's own cache in ~/.claude.json (of the first folder that has one)
  let hooksInstalled = false;
  let demo = null;

  function newSession(id) {
    return {
      id, agent: 'claude', pid: null, cwd: null, project: null, name: null, entrypoint: null, version: null, kind: null,
      inRegistry: false, procStart: null, regStatus: null, regStatusAt: 0,
      hookStatus: null, hookStatusAt: 0, lastHookAt: 0, lastWorkAt: 0, hookModel: null,
      turn: { startedAt: null, lastMs: null }, turnAt: 0,
      needsYou: null, currentTool: null, hookTools: new Set(), doneTools: new Set(),
      startedAt: null, ended: false, endedAt: null, endReason: null,
      startedBy: null, chainChecked: false,
      tail: null, transcriptPath: null, lastFind: 0, root: null,
      subs: new Set(), byToolUse: new Map(), byAgent: new Map(),
      seenAt: Date.now(), shown: false, pendingLine: null, resumeAt: 0,
      touched: [],                  // plan files from PreToolUse hooks (hud-0-3 §4.2); the transcript's are on its tail
    };
  }
  function getSession(id) {
    let s = sessions.get(id);
    if (!s) {
      s = newSession(id); sessions.set(id, s);
      if (s.seenAt - hudStartedAt < STARTUP_MS) s.shown = true;
      else lifetime.timeout(() => settle(s), SETTLE_MS + 20);
    }
    return s;
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Settle time (hud-0-3 D7). When a VS Code window opens, old conversations get a process for a few seconds. A session
  // is therefore shown only at its first work (a hook other than SessionStart / SessionEnd, or a dated transcript line)
  // or SETTLE_MS after the HUD first saw it, and an ended session reopens the same way. Its "Session started" or
  // "Session resumed" line waits until then; "Session ended" is written only for a session that was shown.

  const workedSince = (s, at) => lastWork(s) >= at - SETTLE_WORK_MS;
  function sessionLine(s, text, at, key) {
    if (s.shown && !s.ended) { pushFeed(s, 'session', text, at, key); return; }
    if (!s.pendingLine || (text === 'Session resumed' && s.pendingLine.text !== text)) s.pendingLine = { text, at, key };
  }
  /** `worked`: a hook of work (anything but SessionStart / SessionEnd) has just arrived, whatever its own timestamp. */
  function settle(s, now = Date.now(), worked = false) {
    if (s.agent === 'codex') { s.shown = true; s.pendingLine = null; s.resumeAt = 0; return; }
    if (s.resumeAt) {
      const alive = !s.inRegistry || pidAlive(s.pid);
      if (!s.ended || !alive) s.resumeAt = 0;
      else if (worked || now - s.resumeAt >= SETTLE_MS || workedSince(s, s.resumeAt)) {
        const at = s.resumeAt;
        s.resumeAt = 0;
        reopenSession(s);
        s.chainChecked = false;
        queueChain(s);
        s.pendingLine = null;
        if (s.shown) pushFeed(s, 'session', 'Session resumed', at, `resume:${s.id}:${at}`);
        else s.pendingLine = { text: 'Session resumed', at, key: `resume:${s.id}:${at}` };
        scheduleState();
      }
    }
    if (s.shown || s.ended) return;      // a session that ended before it was shown stays hidden
    if (!worked && now - s.seenAt < SETTLE_MS && !workedSince(s, s.seenAt)) return;
    s.shown = true;
    const line = s.pendingLine;
    s.pendingLine = null;
    if (line) pushFeed(s, 'session', line.text, line.at, line.key);
    scheduleState();
  }
  /** An ended session asks to run again (a new process, or a SessionStart hook): it reopens once it settles. */
  function askResume(s, at) {
    if (!s.ended) return;
    if (!s.resumeAt) { s.resumeAt = at; lifetime.timeout(() => settle(s), Math.max(0, at + SETTLE_MS + 20 - Date.now())); }
    settle(s);
  }

  function pushFeed(s, kind, text, at = Date.now(), dedupeKey = null, action = null) {
    if (dedupeKey) { if (feedSeen.has(dedupeKey)) return; feedSeen.add(dedupeKey); capSet(feedSeen, 5000); }
    const line = { at: Math.min(at, Date.now()), sessionId: s?.id ?? null, project: s?.project ?? null, kind, text: truncate(oneLine(text), 200) };
    if (action) line.action = action;
    appendFeed(line);
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
      tokens: zero(), byDay: new Map(), byMinute: new Map(), msgs: new Map(), lastUsed: 0, firstTs: 0, lastTs: 0,
      toolIds: new Set(), openTools: new Map(), agentCalls: new Map(),
      refs: [], touched: [],        // hud-0-3 §4.2: ID-shaped words of each user prompt, and plan files read or written
    };
  }
  function getTail(file) {
    const key = file.toLowerCase();
    let t = tails.get(key);
    if (!t) { t = { file, offset: 0, rest: [], reading: false, again: false, info: newInfo(), owner: null }; tails.set(key, t); }
    t.info.rootBedrock = !!rootOf(file)?.bedrock;   // read again each time: the flag can change while the HUD runs
    return t;
  }

  // `api-request` lines are small and read for their model id; `api-request-blob` / `-shape` lines (up to ~200 KB) are not.
  const API_REQUEST_PREFIX = '{"type":"api-request",';
  const SKIP_LINE_PREFIXES = ['{"type":"api-request', '{"type":"file-history', '{"type":"atis-latch', '{"type":"queue-operation', '{"type":"last-prompt'];
  const TRANSCRIPT_READ_BYTES = 128 * 1024;

  const readTail = lifetime.task(async function (t) {
    if (t.reading) { t.again = true; return; }
    t.reading = true;
    let changed = false;
    try {
      do {
        t.again = false;
        let st;
        try { st = await fsp.stat(t.file); } catch { break; }
        if (st.size < t.offset) {
          t.offset = 0; t.rest.length = 0; t.info = newInfo();
          if (t.format === 'codex' && t.owner) {
            const s = t.owner.session;
            s.hookStatus = null; s.hookStatusAt = 0; s.needsYou = null;
            s.turn = { startedAt: null, lastMs: null }; s.turnAt = 0;
          }
        }   // replaced or truncated
        if (st.size === t.offset) continue;
        const fh = await fsp.open(t.file, 'r');
        try {
          const buf = Buffer.allocUnsafe(Math.min(TRANSCRIPT_READ_BYTES, st.size - t.offset));
          while (!lifetime.signal.aborted && t.offset < st.size) {
            const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, st.size - t.offset), t.offset);
            if (!bytesRead) break;
            t.offset += bytesRead;
            consume(t, buf.subarray(0, bytesRead));
            changed = true;
          }
        } finally { await fh.close(); }
      } while (t.again && !lifetime.signal.aborted);
    } catch {
      // unreadable for now; the next poll tries again
    } finally { t.reading = false; }
    if (changed) scheduleState();
  });

  function consume(t, chunk) {
    let start = 0;
    for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10, start)) {
      let line = chunk.subarray(start, nl);
      if (t.rest.length) {
        t.rest.push(line);
        line = Buffer.concat(t.rest);
        t.rest.length = 0;
      }
      if (line.length) processLine(t, line.toString('utf8'));
      start = nl + 1;
    }
    // The read buffer is reused. Copy only the fragments that outlive this read
    // and assemble them once, after the line's newline arrives.
    if (start < chunk.length) t.rest.push(Buffer.from(chunk.subarray(start)));
  }

  function processLine(t, line) {
    if (t.format === 'codex') { processCodexLine(t, line); return; }
    if (line.startsWith(API_REQUEST_PREFIX)) { onApiRequestLine(t, line); return; }
    for (const p of SKIP_LINE_PREFIXES) if (line.startsWith(p)) return;
    let j;
    try { j = JSON.parse(line); } catch { return; }
    if (!isObj(j)) return;
    const info = t.info;
    if (typeof j.sessionId === 'string') info.sessionId ??= j.sessionId;
    if (typeof j.agentId === 'string') info.agentId ??= j.agentId;
    const ts = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) || 0 : 0;
    if (ts) {
      if (ts > info.lastTs) info.lastTs = ts;
      if (!info.firstTs) info.firstTs = ts;
      const o = t.owner;
      if (o && !o.agentId && (!o.session.shown || o.session.resumeAt)) settle(o.session);   // a dated line is work (D7)
    }
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
      const minute = ts ? minuteOf(ts) : null;
      const prev = info.msgs.get(id);
      const bucketNow = minuteOf(Date.now());
      if (prev) {
        addTokens(info.tokens, prev.tok, -1);
        if (prev.day) addDay(info, prev.day, prev.tok, -1);
        addPulse(info.byMinute, prev.minute, -prev.tok.output, bucketNow);
        info.msgs.delete(id);
      }
      addTokens(info.tokens, tok);
      if (day) addDay(info, day, tok, 1);
      addPulse(info.byMinute, minute, tok.output, bucketNow);
      info.msgs.set(id, { tok, day, minute });
      if (info.msgs.size > 4000) info.msgs.delete(info.msgs.keys().next().value);
      info.lastUsed = tok.input + tok.cacheRead + tok.cacheWrite;   // context: the latest turn only (D13)
    }
    if (!Array.isArray(m.content)) return;
    for (const c of m.content) {
      if (!isObj(c) || c.type !== 'tool_use' || typeof c.id !== 'string' || info.toolIds.has(c.id)) continue;
      info.toolIds.add(c.id);
      const name = str(c.name) || '?';
      const summary = summarizeTool(name, c.input, info.cwd);
      info.openTools.set(c.id, { id: c.id, name, summary, since: ts || Date.now(), background: runsInBackground(c.input) });
      if (info.openTools.size > 50) info.openTools.delete(info.openTools.keys().next().value);
      if (PLAN_TOOLS.has(name) && isObj(c.input)) {
        const key = planFileKey(c.input.file_path, info.cwd || t.owner?.session.cwd);
        if (key) {
          const at = ts || Date.now();
          noteTouched(info.touched, c.id, key, name !== 'Read', at);
          if (name !== 'Read') noteWrite(key, t.owner?.session.id ?? info.sessionId, t.owner ? t.owner.agentId : info.agentId, at);
        }
      }
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
  function addPulse(buckets, minute, output, current) {
    const first = current - (PULSE_MINUTES - 1) * MINUTE_MS;
    if (minute == null || minute < first || minute > current || !output) return;
    if (buckets.size >= PULSE_MINUTES && !buckets.has(minute)) {
      for (const at of buckets.keys()) if (at < first) buckets.delete(at);
    }
    const total = (buckets.get(minute) || 0) + output;
    if (total > 0) buckets.set(minute, total);
    else buckets.delete(minute);
  }
  function pulseView(buckets, now) {
    const current = minuteOf(now), first = current - (PULSE_MINUTES - 1) * MINUTE_MS;
    let start = null, end = null;
    for (const at of buckets?.keys() || []) {
      if (at < first || at > current) continue;
      start = start == null ? at : Math.min(start, at);
      end = end == null ? at : Math.max(end, at);
    }
    const perMin = [];
    if (start != null) for (let at = start; at <= end; at += MINUTE_MS) perMin.push(buckets.get(at) || 0);
    return { start, perMin };
  }

  function onUserLine(t, j, ts) {
    const content = j.message?.content;
    // A prompt (hud-0-3 D3): only its ID-shaped words are kept, the text is dropped here. Lines Claude Code adds itself
    // (isMeta, a compaction summary) and tool results are not prompts.
    const prompt = !j.isMeta && !j.isCompactSummary && !j.isVisibleInTranscriptOnly;
    if (typeof content === 'string') { if (prompt) addPrompt(t.info, content); return; }
    if (!Array.isArray(content)) return;
    let results = false;
    for (const b of content) {
      if (!isObj(b) || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      results = true;
      t.info.openTools.delete(b.tool_use_id);
      if (t.info.agentCalls.has(b.tool_use_id)) onAgentResult(t, b.tool_use_id, j.toolUseResult, b.is_error === true, ts);
    }
    if (prompt && !results) addPrompt(t.info, content.filter(b => isObj(b) && b.type === 'text').map(b => str(b.text)).join('\n'));
  }

  // =====================================================================================================================
  // Codex rollouts. Read session metadata and selected event fields only; never retain reasoning, tool output,
  // instructions, or full prompts. Both older token_count and newer token_usage_record use cumulative counters.

  const codexId = id => `codex:${id}`;
  let codexScanning = false, codexLastScan = 0;
  const codexMonitoring = { readable: false, error: null };

  function codexTokens(u) {
    const cached = Math.min(num(u.cached_input_tokens), num(u.input_tokens));
    const written = Math.min(num(u.cache_write_input_tokens), num(u.input_tokens) - cached);
    return { input: num(u.input_tokens) - cached - written, output: num(u.output_tokens), cacheRead: cached, cacheWrite: written };
  }

  function codexUsage(info, usage, latest, window, ts) {
    if (num(window)) info.contextWindow = window;
    if (isObj(latest)) info.lastUsed = num(latest.total_tokens) || num(latest.input_tokens) + num(latest.output_tokens);
    if (!isObj(usage)) return;
    const tok = codexTokens(usage), delta = zero();
    for (const k of Object.keys(delta)) delta[k] = Math.max(0, tok[k] - info.tokens[k]);
    // Repeated cumulative records (including the paired token_count event) must never double count.
    info.tokens = tok;
    if (ts) {
      addDay(info, dayKey(ts), delta, 1);
      addPulse(info.byMinute, minuteOf(ts), delta.output, minuteOf(Date.now()));
    }
  }

  function codexToolName(name) { return str(name).replace(/^(?:functions|tools|collaboration)\./, ''); }

  function processCodexLine(t, line) {
    let j;
    try { j = JSON.parse(line); } catch { return; }
    if (!isObj(j) || !isObj(j.payload)) return;
    const p = j.payload, info = t.info;
    const ts = Date.parse(j.timestamp) || 0;
    if (j.type === 'session_meta') {
      if (!str(p.id)) return;
      const s = getSession(codexId(p.id));
      s.agent = 'codex'; s.tail = t; s.transcriptPath = t.file;
      t.owner = { session: s, agentId: null };
      info.sessionId = s.id;
      info.codexProvider = p.model_provider === 'openai' ? 'openai' : 'unknown';
      if (str(p.cwd)) { info.cwd = p.cwd; setCwd(s, p.cwd); }
      info.branch = str(p.git?.branch) || null;
      s.entrypoint = str(p.source) || str(p.originator) || 'codex';
      s.version = str(p.cli_version) || null;
      s.startedAt = Date.parse(p.timestamp) || ts || null;
      const spawn = p.source?.subagent?.thread_spawn;
      s.codexParent = str(spawn?.parent_thread_id) ? codexId(spawn.parent_thread_id) : null;
      s.codexInternal = !!p.source?.subagent?.other;
      s.kind = str(spawn?.agent_role) || str(spawn?.agent_type) || 'Codex';
      s.name = str(spawn?.agent_nickname) || null;
    }
    const s = t.owner?.session;
    if (!s) return;
    const advanced = ts > info.lastTs;
    if (ts) { info.firstTs ||= ts; info.lastTs = Math.max(info.lastTs, ts); }
    if (s.ended && advanced && ts > (s.endedAt || 0) && Date.now() - ts < SILENT_SESSION_MS) reopenSession(s);
    if (j.type === 'turn_context') {
      if (str(p.model)) info.modelRaw = p.model;
      if (str(p.effort)) info.effort = p.effort;
      if (str(p.cwd)) { info.cwd = p.cwd; setCwd(s, p.cwd); }
    } else if (j.type === 'token_usage_record') {
      codexUsage(info, p.thread_token_usage, p.usage, null, ts);
    } else if (j.type === 'event_msg') {
      switch (p.type) {
        case 'token_count':
          codexUsage(info, p.info?.total_token_usage, p.info?.last_token_usage, p.info?.model_context_window, ts);
          break;
        case 'task_started': case 'turn_started': case 'user_message':
          setHookStatus(s, 'busy', ts); clearNeedsYou(s);
          if (p.type !== 'user_message') startTurn(s, ts);
          if (p.type === 'user_message' && !info.title) info.title = truncate(redact(oneLine(p.message)), 300) || null;
          if (num(p.model_context_window)) info.contextWindow = p.model_context_window;
          break;
        case 'task_complete': case 'turn_complete': case 'turn_aborted':
          setHookStatus(s, 'idle', ts); clearNeedsYou(s); info.openTools.clear();
          finishTurn(s, ts, p.type !== 'turn_aborted');
          if (ts >= hudStartedAt - 2000) {
            const aborted = p.type === 'turn_aborted';
            pushFeed(s, aborted ? 'session' : 'done', aborted ? 'Codex turn interrupted' : 'Codex turn complete', ts,
              `codex-stop:${s.id}:${ts}`, aborted ? null : 'turn-finished');
          }
          break;
        case 'session_end': case 'shutdown_complete': endSession(s, ts, 'closed'); break;
      }
    } else if (j.type === 'response_item') {
      const id = str(p.call_id);
      if ((p.type === 'function_call' || p.type === 'custom_tool_call') && id && !info.toolIds.has(id)) {
        const name = codexToolName(p.name);
        let input = {};
        try { input = JSON.parse(p.arguments || '{}'); } catch {}
        const summary = summarizeTool(name, input, info.cwd);
        info.toolIds.add(id);
        info.openTools.set(id, { id, name, summary, since: ts, background: runsInBackground(input) });
        if (info.openTools.size > 50) info.openTools.delete(info.openTools.keys().next().value);
        setHookStatus(s, 'busy', ts);
        if (/^request_user_input(?:_async)?$/.test(name)) setNeedsYou(s, 'Question for you', 'question', ts);
        if (ts >= hudStartedAt - 2000) feedTool(s, null, id, name, summary, ts);
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const tool = info.openTools.get(id);
        if (tool && /^request_user_input(?:_async)?$/.test(tool.name)) clearNeedsYou(s);
        info.openTools.delete(id);
      }
    }
  }

  const scanCodex = lifetime.task(async function (force = false) {
    if (codexScanning || (!force && Date.now() - codexLastScan < 15_000)) return;
    codexScanning = true; codexLastScan = Date.now();
    const since = Math.min(startOfDay(), Date.now() - ENDED_KEEP_MS);
    let readable = false, error = null;
    const visit = async (dir, depth = 0) => {
      if (lifetime.signal.aborted) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); if (!depth) readable = true; }
      catch (e) { if (!depth && e.code !== 'ENOENT') error = `Codex sessions: ${e.code}`; return; }
      for (const e of entries) {
        if (lifetime.signal.aborted) return;
        const file = path.join(dir, e.name);
        // Do not follow symlinks or inspect other CODEX_HOME files (notably auth.json).
        if (e.isDirectory() && depth < 3 && /^\d+$/.test(e.name)) { await visit(file, depth + 1); continue; }
        if (!e.isFile() || !/^rollout-.*\.jsonl$/.test(e.name)) continue;
        let st;
        try { st = await fsp.stat(file); } catch { continue; }
        const existing = tails.get(file.toLowerCase());
        if (!existing && st.mtimeMs < since) continue;
        const t = existing || getTail(file);
        t.format = 'codex';
        await readTail(t);
        const s = t.owner?.session;
        if (s && !s.ended && t.info.lastTs && Date.now() - t.info.lastTs > SILENT_SESSION_MS) endSession(s, t.info.lastTs, 'no recent Codex activity');
      }
    };
    try { for (const dir of CODEX_ROOTS) await visit(path.join(dir, 'sessions')); }
    finally { codexScanning = false; codexMonitoring.readable = readable; codexMonitoring.error = error; scheduleState(); }
  });

  function onCodexChange(dir, rel) {
    if (!rel || !/^rollout-.*\.jsonl$/.test(path.basename(String(rel)))) return;
    const file = path.resolve(dir, String(rel));
    if (!file.startsWith(path.resolve(dir) + path.sep)) return;
    const t = tails.get(file.toLowerCase());
    if (t?.format === 'codex') readTail(t);
    else scanCodex(true);
  }

  function codexTree(list) {
    const byId = new Map(list.map(s => [s.id, s]));
    const hidden = new Set();
    for (const child of list) {
      const source = sessions.get(child.id);
      if (source?.codexInternal) { hidden.add(child.id); continue; }
      let parentId = source?.codexParent, root = null, depth = 0;
      const seen = new Set([child.id]);
      while (parentId && byId.has(parentId) && !seen.has(parentId)) {
        seen.add(parentId); root = byId.get(parentId); depth++;
        parentId = sessions.get(parentId)?.codexParent;
      }
      if (!root || (parentId && seen.has(parentId))) continue;
      root.subagents.push({ ...child, parentId: source.codexParent, depth, description: child.title || child.name,
        type: source.kind || 'Codex', state: child.status === 'busy' || child.status === 'needs-you' ? 'running' : 'done',
        endedAt: child.status === 'idle' ? child.lastActivityAt : child.endedAt, background: false });
      addTokens(root.tokensTree, child.tokens);
      if (child.status === 'busy' || child.status === 'needs-you') root.agentsRunning = (root.agentsRunning || 0) + 1;
      hidden.add(child.id);
    }
    return list.filter(s => !hidden.has(s.id));
  }

  // =====================================================================================================================
  // Subagents and the tree. A subagent is known from its parent's Agent tool call (keyed by the tool_use id), from
  // hooks (agent_id) and from <sessionId>/subagents/agent-<agentId>.meta.json, which links the two (toolUseId).

  function newSub(s) {
    const sub = { agentId: null, toolUseId: null, parentKey: s.id, depth: null, description: null, type: null, modelHint: null,
      background: false, state: 'running', startedAt: null, endedAt: null, tail: null, currentTool: null, lastHookAt: 0, startedByHook: false,
      refs: null, touched: [] };   // hud-0-3 §4.2: the words of its Agent call's prompt; plan files from its hooks
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
        sub.lastHookAt = Math.max(sub.lastHookAt, other.lastHookAt);
        sub.startedByHook ||= other.startedByHook;
        sub.refs ??= other.refs;
        sub.touched = mergeTouched(sub.touched, other.touched);
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
      background: runsInBackground(input), at: ts || Date.now(),
      agentId: null, done: false, doneAt: null,
      refs: promptRefs(input.prompt),   // hud-0-3 §4.2: the subagent's task, as ID-shaped words only (D3)
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
    if (call.refs?.length) sub.refs = call.refs;
    if (call.background) sub.background = true;
    sub.startedAt = sub.startedAt ? Math.min(sub.startedAt, call.at) : call.at;
    if (call.agentId) assignAgentId(s, sub, call.agentId);
    if (call.done) closeSub(s, sub, call.doneAt);
  }
  function replayAgentCalls(t) {
    if (!t.owner) return;
    for (const [toolUseId, call] of t.info.agentCalls) applyAgentCall(t.owner.session, t, toolUseId, call);
  }
  /**
   * A subagent only a hook has named (an agent_id, no agent_type, no Agent call, no transcript, no meta.json yet) is a
   * placeholder: it is not shown and writes no feed line (hud-0-3 D7). It stays in `s.subs`, so a meta.json or an Agent
   * call that arrives later still completes it.
   */
  function isPlaceholder(sub) { return !sub.toolUseId && !sub.tail && !sub.type && !sub.description; }
  function closeSub(s, sub, at = Date.now()) {
    if (sub.state === 'done') return;
    sub.state = 'done';
    sub.endedAt = at;
    sub.currentTool = null;
    if (at >= hudStartedAt - 2000 && !isPlaceholder(sub)) {
      pushFeed(s, 'done', `Agent done · ${[sub.type, sub.description].filter(Boolean).join(': ')}`, at,
        `done:${sub.toolUseId || sub.agentId}`, 'agent-done');
    }
  }

  const readMeta = lifetime.task(async function (s, file) {
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
  });

  const scanSubagents = lifetime.task(async function (s) {
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
  });
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
    if (s.agent === 'codex') return;
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
    s.turn.startedAt = null;
    s.needsYou = null;
    s.pendingLine = null; s.resumeAt = 0;
    for (const sub of s.subs) closeSub(s, sub, at);
    if (s.shown && at >= hudStartedAt - 2000) pushFeed(s, 'session', `Session ended${reason ? ` (${reason})` : ''}`, at, `end:${s.id}`);
    scheduleState();
  }
  function reopenSession(s) {
    s.ended = false; s.endedAt = null; s.endReason = null;
    feedSeen.delete(`end:${s.id}`);
  }

  let registryScanning = false, registryReadable = false;
  const windowsProcessStarts = new Map();
  const windowsPidDomain = `win32:${HOSTNAME.toLowerCase()}`;

  // Claude Code records Windows process creation times as decimal FILETIME strings. Keep the full precision.
  async function refreshWindowsProcessStarts(claims) {
    if (process.platform !== 'win32') return;
    for (const pid of windowsProcessStarts.keys()) if (!claims.has(pid)) windowsProcessStarts.delete(pid);
    const now = Date.now();
    const pending = [];
    for (const [pid, claimedStarts] of claims) {
      const cached = windowsProcessStarts.get(pid);
      if (!cached || cached.expiresAt <= now || [...claimedStarts].some(start => !cached.claims.has(start))) pending.push(pid);
    }
    if (!pending.length) return;

    const cmd = `Get-Process -Id ${pending.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { try { '{0} {1}' -f $_.Id, $_.StartTime.ToFileTimeUtc() } catch {} }`;
    const output = await new Promise(resolve => {
      lifetime.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 3000, windowsHide: true },
        (err, stdout) => resolve(err ? '' : stdout));
    });
    const starts = new Map();
    for (const line of output.split(/\r?\n/)) {
      const match = /^(\d+) (\d+)$/.exec(line.trim());
      if (match) starts.set(Number(match[1]), match[2]);
    }
    for (const pid of pending) {
      const value = starts.get(pid);
      windowsProcessStarts.set(pid, { value, claims: claims.get(pid), expiresAt: now + (value ? MINUTE_MS : 15_000) });
    }
  }

  const scanRegistry = lifetime.task(async function () {
    if (registryScanning) return;
    registryScanning = true;
    try {
      const seen = new Set();
      const entries = [];
      for (const root of ROOTS) {
        try { for (const n of await fsp.readdir(root.sessions)) entries.push([root, n]); registryReadable = true; } catch {}
      }
      const rows = [];
      if (lifetime.signal.aborted) return;
      const claims = new Map();
      for (const [root, n] of entries) {
        if (!/^\d+\.json$/.test(n)) continue;              // <pid>.json only, never *.key
        const j = await readJson(path.join(root.sessions, n));
        if (!isObj(j) || typeof j.sessionId !== 'string') continue;
        const pid = Number.isInteger(j.pid) ? j.pid : Number(n.slice(0, -5));
        const domain = str(j.pidDomain).toLowerCase();
        const procStart = (!domain || domain === windowsPidDomain) && /^\d{17,19}$/.test(str(j.procStart)) ? j.procStart : null;
        if (procStart && pidAlive(pid)) {
          if (!claims.has(pid)) claims.set(pid, new Set());
          claims.get(pid).add(procStart);
        }
        rows.push({ root, j, pid, procStart });
      }
      await refreshWindowsProcessStarts(claims);
      if (lifetime.signal.aborted) return;
      for (const { root, j, pid, procStart } of rows) {
        const actualStart = windowsProcessStarts.get(pid)?.value;
        if (procStart && actualStart && procStart !== actualStart) continue;
        seen.add(j.sessionId);
        const s = getSession(j.sessionId);
        const isNew = !s.inRegistry;
        s.inRegistry = true;
        s.root = root;
        // The session may resume in a new process, including one that reused its previous PID.
        const processChanged = s.pid !== pid || (procStart && actualStart && s.procStart && s.procStart !== procStart);
        const relaunched = s.ended && processChanged && pidAlive(pid);
        s.pid = pid;
        s.procStart = procStart;
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
        if (relaunched) askResume(s, Date.now());     // reopens once it works or has run for SETTLE_MS (D7)
        if (!pidAlive(pid)) endSession(s, Date.now(), 'process gone');
        if (isNew) {
          attachSessionTranscript(s);
          queueChain(s);
          if (Date.now() - hudStartedAt > STARTUP_MS) sessionLine(s, 'Session started', Date.now(), `start:${s.id}`);
        }
        settle(s);
      }
      for (const s of sessions.values()) {
        if (s.inRegistry && !seen.has(s.id)) { s.resumeAt = 0; if (!s.ended) endSession(s, Date.now(), 'closed'); }
      }
    } finally { registryScanning = false; }
    scheduleState();
  });

  // Sessions started by other sessions (`startedBy`): one process-tree read per batch of new sessions, never polled.
  const chainQueue = new Set();
  let chainTimer = null;
  function queueChain(s) {
    if (process.platform !== 'win32' || s.chainChecked || !s.pid || s.ended) return;
    chainQueue.add(s);
    chainTimer ??= lifetime.timeout(runChain, 300);
  }
  function runChain(retry = false) {
    chainTimer = null;
    const batch = [...chainQueue];
    chainQueue.clear();
    if (!batch.length) return;
    const cmd = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';
    lifetime.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 3000, windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => {
      if (lifetime.signal.aborted) return;
      if (err) {
        if (!retry) { for (const s of batch) chainQueue.add(s); lifetime.timeout(() => runChain(true), 5000); }
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
  function startTurn(s, at) {
    if (at > s.turnAt) { s.turn.startedAt = at; s.turnAt = at; }
  }
  function finishTurn(s, at, completed = true) {
    if (!at || at < s.turnAt) return;
    if (completed && s.turn.startedAt != null) s.turn.lastMs = at - s.turn.startedAt;
    s.turn.startedAt = null;
    s.turnAt = at;
  }
  function setNeedsYou(s, reason, kind, at, agentId) {
    if (s.needsYou && s.needsYou.reason === reason) return;
    const first = !s.needsYou;
    s.needsYou = { since: s.needsYou?.since ?? at, reason, kind, agentId: agentId ?? null };
    if (first && !s.ended && at >= hudStartedAt) void sendPhonePush(s, kind);
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
      // A SessionStart is not work: the session reopens once it works or has run for SETTLE_MS (D7).
      if (ev === 'SessionStart') { if (typeof p.model === 'string') s.hookModel = p.model; askResume(s, at); scheduleState(); return; }
      if (s.resumeAt) settle(s, now, true);    // a pending resume: reopens, with its "Session resumed" line
      if (s.ended) { s.resumeAt = 0; reopenSession(s); }
    }
    s.lastHookAt = Math.max(s.lastHookAt, at);
    const work = ev !== 'SessionStart' && ev !== 'SessionEnd';   // opening or closing is not work
    if (work) s.lastWorkAt = Math.max(s.lastWorkAt, at);
    if (typeof p.cwd === 'string' && !s.cwd) setCwd(s, p.cwd);
    if (typeof p.transcript_path === 'string') attachSessionTranscript(s, p.transcript_path);
    settle(s, now, work);                               // before this event's own feed lines, so "Session started" comes first
    const sub = typeof p.agent_id === 'string' && p.agent_id ? subForAgent(s, p.agent_id, str(p.agent_type)) : null;
    if (sub) sub.lastHookAt = Math.max(sub.lastHookAt, at);
    const id = str(p.tool_use_id);
    const name = str(p.tool_name) || '?';
    switch (ev) {
      case 'SessionStart':
        setHookStatus(s, 'idle', at);
        if (typeof p.model === 'string') s.hookModel = p.model;
        if (p.source === 'resume') sessionLine(s, 'Session resumed', at, `resume:${s.id}:${at}`);
        else if (!p.source || p.source === 'startup') sessionLine(s, 'Session started', at, `start:${s.id}`);   // the registry may have said so already
        break;
      case 'UserPromptSubmit':
        clearNeedsYou(s);
        setHookStatus(s, 'busy', at);
        startTurn(s, at);
        break;
      case 'PreToolUse': {
        if (id) { s.hookTools.add(id); capSet(s.hookTools, 5000); }
        hookTouch(s, sub, p, id, name, at);
        if (!sub) setHookStatus(s, 'busy', at);
        if (s.doneTools.has(id)) break;                 // async hooks can arrive out of order
        clearNeedsYou(s, sub?.agentId ?? null);
        if (NEEDS_INPUT_TOOLS[name]) setNeedsYou(s, NEEDS_INPUT_TOOLS[name], 'question', at, sub?.agentId);
        const summary = summarizeTool(name, p.tool_input, s.cwd);
        const tool = { id, name, summary, since: at, background: runsInBackground(p.tool_input) };
        if (sub) sub.currentTool = tool; else s.currentTool = tool;
        if (AGENT_TOOLS.has(name) && id) {
          const input = isObj(p.tool_input) ? p.tool_input : {};
          const child = subForToolUse(s, id);
          child.parentKey = sub?.agentId || s.id;
          child.description ??= str(input.description) || null;
          child.type ??= str(input.subagent_type) || 'general-purpose';
          child.modelHint ??= str(input.model) || null;
          if (tool.background) child.background = true;
          child.startedAt ??= at;
        }
        feedTool(s, sub, id, name, summary, at);
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        if (id) { s.doneTools.add(id); capSet(s.doneTools, 1000); }
        if (ev === 'PostToolUse') hookTouch(s, sub, p, id, name, at);   // the write has happened: its time is now
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
        finishTurn(s, at);
        pushFeed(s, 'done', 'Turn finished', at, null, 'turn-finished');
        break;
      case 'SubagentStart':
        if (sub) {
          sub.startedByHook = true;
          sub.startedAt ??= at;
          if (sub.state === 'done' && at > (sub.endedAt || 0)) { sub.state = 'running'; sub.endedAt = null; }
        }
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
    settle(s, now, work);
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
  const scanRecentTranscripts = lifetime.task(async function () {
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
            ns.shown = true;                       // found at start-up: shown at once (D7)
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
  });

  function poll() {
    const now = Date.now();
    scanRegistry();
    scanCodex();
    for (const s of sessions.values()) {
      // Keep Codex tails attached across idle expiry so appending to an old rollout reopens its session.
      if (s.agent === 'codex') {
        if (s.tail) readTail(s.tail);
        const last = lastActivity(s);
        if (!s.ended && last && now - last > SILENT_SESSION_MS) endSession(s, last, 'no recent Codex activity');
        continue;
      }
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
        // A confirmed worker can be silent while its parent waits. Keep it running until a completion or session end.
        if (sub.startedByHook) continue;
        const subLast = subLastActivity(sub);
        const parentMovedOn = (s.tail?.info.lastTs || 0) > subLast || s.lastHookAt > subLast;
        if (now - subLast > SILENT_SUBAGENT_MS && (idle || (sub.background && parentMovedOn))) closeSub(s, sub, subLast);
      }
    }
    for (const [key, r] of roots) {
      if (![...sessions.values()].some(s => s.project === r.project)) dropRoot(key);
      else if (now - r.lastScanAt >= PLAN_POLL_MS) scanRoot(key);
    }
    scheduleState();
  }
  function dropSession(s) {
    if (s.tail) s.tail.owner = null;
    for (const sub of s.subs) if (sub.tail) sub.tail.owner = null;
    sessions.delete(s.id);
  }

  // =====================================================================================================================
  // Plans: status, plan, rollout and handoff boards under docs/ or Documentation/ of a project the HUD sees, plus
  // small plans (docs/plans/<slug>.md). A "board" is any table with an id column first and a State or Status column.
  // Covers the standard's board (workflow/STANDARD.md §5: ID | Item | Agent | Depends on | Model / effort | State |
  // Since | Handoff | Notes, with Runs, Decisions (P0) and Questions), and the formats in use before it: the
  // WasteManagement2 board ("Waits for" in Notes), FidiaCRM's chunk board and the ImPOS-Maui Phase | State tables.

  const PLAN_TOP_DIRS = ['docs', 'Documentation', 'doc'];
  const PLAN_FILE_RE = /^(?:.*[-_])?(?:status|plan)\.md$|^(?:handoff|rollout)\.md$/i;
  const PLAN_SKIP_DIRS = new Set(['_template', 'node_modules', 'bin', 'obj', 'handoff', 'handoffs', 'archive', 'archives', '.git']);
  const BOARD_HEADER = '| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |';
  const COLUMN_ROLES = [
    ['id', /^(phase|chunk|run|step|slice|stage|id|#|task|milestone|item)$/],
    ['name', /^(title|name|what|what it is|input|goal|summary|part|item|job|work|description)$/],
    ['agent', /^(agent|owner|who|assignee)$/],
    ['state', /^(state|status)$/],
    ['since', /^(since|started|date)$/],
    ['deps', /^(depends on|dependencies|waits for|after|requires|prerequisites|blocked by|start when|needs)$/],
    ['notes', /^(notes?|comments?)$/],
    ['handoff', /^handoffs?$/],
    ['modelEffort', /^model\s*[/,·]\s*effort$/],
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
    if (/\bin[- ]progress\b|^(started|working|building|active|running|doing)\b/.test(t)) return 'in-progress';
    if (/\bpartial(ly)?\b/.test(t)) return 'partial';
    if (/^(done|complete|completed|finished|built|merged|shipped|confirmed|in)\b/.test(t)) return 'done';
    if (/^(todo|to do|not started|planned|pending|open|waiting|ready|next|later)\b/.test(t)) return 'todo';
    if (/\bdone\b/.test(t)) return 'partial';
    return 'unknown';
  }
  function splitModelEffort(v) {
    const t = cleanCell(v);
    if (!t || /^(?:[—-]|owner|human)$/i.test(t)) return { model: null, effort: null };
    const [m, e] = t.split(/[/,·]/).map(x => x.trim());
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
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
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
      // Numbered rollout boards have both a step reference and a human-readable job.
      const job = tb.header.indexOf('job'), step = tb.header.indexOf('step');
      if (job >= 0) col.name = job;
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
          name: truncate([step > 0 ? cell(step) : '', cell(col.name) || idc.rest || idc.id].filter(Boolean).join(' · '), 140),
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
          handoff: !!cell(col.handoff) && !/^[—-]$/.test(cell(col.handoff)),   // hud-0-3 P4: a handoff is linked ("—" says none will be)
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
    const header = planHeader(text) ?? planHeader(planText ?? '');
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

  /**
   * The board file of a parsed plan, relative to its project root, rebuilt from the slug parsePlan() gave it (a phased
   * plan `docs/plans/<slug>/STATUS.md`, a small one `docs/plans/<slug>.md`, any other board `<slug>.md`). Lower-cased,
   * with forward slashes: `planFile(p)` is the same key planFileKey() makes from a path an agent read or wrote.
   */
  function planFile(p) {
    const rel = p.slug.includes('/') ? `${p.slug}.md` : p.size === 'small' ? `docs/plans/${p.slug}.md` : `docs/plans/${p.slug}/STATUS.md`;
    return `${p.project}|${rel}`.toLowerCase();
  }
  const planKeyOf = p => `${p.project}|${p.slug}`;   // PLAN hud-0-3 §4.1, the key renderPlans uses

  function ensureRoot(root, project) {
    const key = root.toLowerCase();
    if (roots.has(key)) return;
    const rec = { root, project, watchers: new Map(), timer: null, scanning: false, scanAgain: false, lastScanAt: 0 };
    roots.set(key, rec);
    scanRoot(key);
  }
  function watchPlanDirs(key, rec) {
    for (const top of PLAN_TOP_DIRS) {
      const dir = path.join(rec.root, top);
      if (rec.watchers.has(dir) || !fs.existsSync(dir)) continue;
      try {
        const w = lifetime.watch(dir, { recursive: true }, (e, f) => { if (e === 'rename' || !f || /\.md$/i.test(f)) scheduleRootScan(key); });
        if (!w) return;
        w.on('error', () => { w.close(); rec.watchers.delete(dir); });
        rec.watchers.set(dir, w);
      } catch {}
    }
  }
  function scheduleRootScan(key) {
    const rec = roots.get(key);
    if (!rec || rec.timer) return;
    rec.timer = lifetime.timeout(() => { rec.timer = null; scanRoot(key); }, 400);
  }
  function dropRoot(key) {
    const rec = roots.get(key);
    if (!rec) return;
    for (const w of rec.watchers.values()) try { w.close(); } catch {}
    lifetime.clearTimer(rec.timer);
    roots.delete(key);
    for (const [k, v] of plans) if (v.rootKey === key) plans.delete(k);
  }
  const scanRoot = lifetime.task(async function (key) {
    const rec = roots.get(key);
    if (!rec) return;
    if (rec.scanning) { rec.scanAgain = true; return; }
    rec.scanning = true;
    try {
      watchPlanDirs(key, rec);
      await readRootPlans(key, rec);
    } finally {
      rec.lastScanAt = Date.now();
      rec.scanning = false;
      if (rec.scanAgain && roots.get(key) === rec) { rec.scanAgain = false; scheduleRootScan(key); }
    }
  });
  async function readRootPlans(key, rec) {
    const files = [];
    const walk = async (dir, depth) => {
      if (lifetime.signal.aborted) return;
      let ents;
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      const smallPlans = depth === 1 && path.basename(dir).toLowerCase() === 'plans';
      for (const e of ents) {
        if (e.isDirectory()) { if (depth < 4 && !PLAN_SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.')) await walk(path.join(dir, e.name), depth + 1); }
        else if (PLAN_FILE_RE.test(e.name) || (smallPlans && /\.md$/i.test(e.name))) files.push(path.join(dir, e.name));
      }
    };
    for (const top of PLAN_TOP_DIRS) await walk(path.join(rec.root, top), 0);
    const info = await projectInfo(rec.root);
    const candidates = new Map();
    for (const f of files) {
      if (lifetime.signal.aborted) return;
      let st, text, planText = null;
      try { st = await fsp.stat(f); text = await fsp.readFile(f, 'utf8'); } catch { continue; }
      if (/status\.md$/i.test(f)) { try { planText = await fsp.readFile(path.join(path.dirname(f), 'PLAN.md'), 'utf8'); } catch {} }
      const plan = parsePlan(text, f, rec.root, rec.project, planText);
      if (plan) candidates.set(f.toLowerCase(), { plan, mtime: st.mtimeMs, text });
    }
    // A STATUS board takes precedence over its companion design plan. An explicit supersession only
    // hides a board when its replacement was actually read and contains a usable board.
    const hidden = new Set();
    for (const [file, candidate] of candidates) {
      if (/[/\\]plan\.md$/i.test(file) && candidates.has(path.join(path.dirname(file), 'STATUS.md').toLowerCase())) hidden.add(file);
      const replacement = /\bsuperseded by\s+(?:\*\*)?\[([^\]]+)\]\(([^)]+)\)/i.exec(candidate.text);
      if (!replacement) continue;
      const target = path.resolve(path.dirname(file), replacement[2].split('#')[0]).toLowerCase();
      if (target !== file && candidates.has(target)) hidden.add(file);
    }
    if (roots.get(key) !== rec) return;   // a dropped root cannot publish the result of an old scan
    rec.info = info;
    const found = new Set();
    for (const [file, { plan, mtime }] of candidates) {
      if (hidden.has(file)) continue;
      const pkey = `${rec.project}|${path.relative(rec.root, plan.path)}`.toLowerCase();
      found.add(pkey);
      const prev = plans.get(pkey);
      if (prev && prev.rootKey !== key && prev.mtime > mtime) continue;   // a newer copy in another worktree
      if (prev) diffPlan(prev.plan, plan);
      plans.set(pkey, { plan, mtime, rootKey: key });
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

  /**
   * Feeds each state change, and records it in the plan's history (hud-0-3 §4.2). A change seen within PLAN_WRITE_MS of
   * an agent writing the board file is that agent's: "claimed by <title>" when it moved the item to in-progress.
   */
  function diffPlan(a, b, now = Date.now()) {
    const old = new Map([...a.phases, ...a.runs].map(n => [n.id, n.state]));
    const w = planWrites.get(planFile(b));
    const by = w && now - w.at <= PLAN_WRITE_MS ? w : null;
    const key = planKeyOf(b);
    for (const n of [...b.phases, ...b.runs]) {
      const was = old.get(n.id);
      if (!was || was === n.state) continue;
      const hist = planHistory.get(key) || [];
      hist.push({ at: now, id: n.id, from: was, to: n.state, sessionId: by?.sessionId ?? null, agentId: by?.agentId ?? null });
      if (hist.length > HISTORY_MAX) hist.splice(0, hist.length - HISTORY_MAX);
      planHistory.set(key, hist);
      const itemKey = `${key}#${n.id}`;
      boardTrack.set(itemKey, { ...newTrack(), ...boardTrack.get(itemKey), changedAt: now });
      const who = by && n.state === 'in-progress' ? agentLabel(by) : null;
      pushFeed({ id: null, project: b.project }, 'plan', who ? `${b.title}: ${n.id} claimed by ${truncate(oneLine(who), 80)}` : `${b.title}: ${n.id} ${was} → ${n.state}`,
        now, null, 'item-changed');
    }
    const asked = new Set(a.needsYou.map(x => `${x.kind}:${x.id}:${x.text}`));
    for (const x of b.needsYou) {
      if (!asked.has(`${x.kind}:${x.id}:${x.text}`)) pushFeed({ id: null, project: b.project }, 'needs-you', `${b.title}: ${x.kind === 'decision' ? 'decision' : 'question'} ${x.id ?? ''} waiting on you`.replace(/\s+/g, ' '));
    }
  }

  // =====================================================================================================================
  // Board following (hud-0-3 D1 to D5, PLAN §4.2). The HUD links agents to board items from evidence and marks where the
  // board and the agents disagree. It never writes to a board. The evidence is kept raw, as ID-shaped words and plan-file
  // keys, and resolved during publication: a transcript is often read before its plan. Nothing of it is kept on disk.

  const ID_WORD_RE = /(?<![\w/\\.-])(?:([a-z0-9][\w.-]*)\/)?([A-Z]{1,4}-?\d+(?:-\d+)?)(?![\w-])/g;
  const PROMPT_NOISE_RE = /<(system-reminder|bash-stdout|bash-stderr|local-command-stdout)>[\s\S]*?<\/\1>/g;
  const PLAN_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit']);
  const PLAN_PATH_RE = /(?:^|[\\/])(?:docs|documentation|doc)[\\/].*\.md$/i;
  const FINISHED = new Set(['handed-off', 'accepted', 'done']);
  const OWNER_AGENTS = /^(human|owner)$/i;
  const MARK_WORDS = { unclaimed: 'board not updated', stalled: 'stalled', early: 'started early' };

  /** ID-shaped words, in text order: `<slug>/<ID>` and bare `<ID>`, an ID being `[A-Z]{1,4}-?\d+(-\d+)?` (runs: R<n>, S<n>). */
  function idWords(text, max = 200) {
    const out = [];
    if (typeof text !== 'string' || !text) return out;
    for (const m of text.matchAll(ID_WORD_RE)) { out.push(m[1] ? `${m[1]}/${m[2]}` : m[2]); if (out.length >= max) break; }
    return out;
  }
  /**
   * Adds one prompt's ID-shaped words to holder.refs (prompts, oldest first, each a list of words) and drops the text
   * (D3). At most REFS_MAX words are kept: bare IDs go first, since they only count as mentions, so a `<slug>/<ID>`
   * assignment outlives the IDs that later prompts list.
   */
  function addPrompt(holder, text) {
    const words = idWords(typeof text === 'string' ? text.replace(PROMPT_NOISE_RE, ' ') : '');
    if (!words.length) return;
    const refs = holder.refs;
    refs.push(words);
    let n = refs.reduce((a, p) => a + p.length, 0);
    for (let i = 0; i < refs.length && n > REFS_MAX; i++) {
      const p = refs[i];
      for (let k = 0; k < p.length && n > REFS_MAX;) { if (p[k].includes('/')) k++; else { p.splice(k, 1); n--; } }
    }
    while (n > REFS_MAX && refs.length) { refs[0].shift(); n--; if (!refs[0].length) refs.shift(); }
    for (let i = refs.length - 1; i >= 0; i--) if (!refs[i].length) refs.splice(i, 1);
  }
  function promptRefs(text) { const h = { refs: [] }; addPrompt(h, text); return h.refs.length ? h.refs : null; }

  /**
   * The key of a plan file an agent read or wrote, `<project>|<path from the project root>` lower-cased with forward
   * slashes, or null outside a docs folder. Either slash and any case give the same key, and a file in a worktree gets
   * the main repository's project (rootFor), so it belongs to the main repository's plan.
   */
  function planFileKey(file, cwd) {
    file = str(file);
    if (!file || !PLAN_PATH_RE.test(file)) return null;
    if (!path.isAbsolute(file)) { if (!cwd) return null; file = path.resolve(cwd, file); }
    const abs = path.resolve(file);
    const r = rootFor(path.dirname(abs));
    const rel = path.relative(r.root, abs).replace(/\\/g, '/');
    return /^(?:docs|documentation|doc)\//i.test(rel) ? `${r.project}|${rel}`.toLowerCase() : null;
  }
  /** Records a plan file an agent read or wrote, once per tool-use id, oldest first, at most TOUCHED_MAX. */
  function noteTouched(list, id, file, write, at) {
    if (id && list.some(x => x.id === id)) return;
    let k = list.length;
    while (k > 0 && list[k - 1].at > at) k--;
    list.splice(k, 0, { id: id || null, file, write, at });
    if (list.length > TOUCHED_MAX) list.splice(0, list.length - TOUCHED_MAX);
  }
  function mergeTouched(a, b) {
    if (!b?.length) return a || [];
    if (!a?.length) return b;
    const out = [...a];
    for (const x of b) if (!x.id || !out.some(y => y.id === x.id)) out.push(x);
    return out.sort((p, q) => p.at - q.at).slice(-TOUCHED_MAX);
  }
  function noteWrite(file, sessionId, agentId, at) {
    if (!sessionId) return;
    const prev = planWrites.get(file);
    if (prev && prev.at > at) return;
    planWrites.delete(file);
    planWrites.set(file, { sessionId, agentId: agentId ?? null, at });
    if (planWrites.size > 500) planWrites.delete(planWrites.keys().next().value);
  }
  /** A Read, Edit, Write or MultiEdit hook on a plan file. PostToolUse moves the write's time to when it happened. */
  function hookTouch(s, sub, p, id, name, at) {
    if (!PLAN_TOOLS.has(name) || !isObj(p.tool_input)) return;
    const key = planFileKey(p.tool_input.file_path, str(p.cwd) || s.cwd);
    if (!key) return;
    noteTouched((sub || s).touched, id, key, name !== 'Read', at);
    if (name !== 'Read') noteWrite(key, s.id, sub?.agentId ?? null, at);
  }
  /** Who wrote a board, for its "claimed by" line: a subagent's description, or a session's title. */
  function agentLabel(w) {
    const s = sessions.get(w.sessionId);
    if (!s) return null;
    if (w.agentId) { const sub = s.byAgent.get(w.agentId); return sub ? sub.description || sub.type || null : null; }
    return s.tail?.info.customTitle || s.tail?.info.title || s.name || null;
  }

  /** The plans, indexed once per snapshot for resolveWork() and boardState(). */
  function indexPlans(planList) {
    const list = [], byProject = new Map(), byKey = new Map(), files = new Map(), dirs = new Map();
    for (const p of planList) {
      const nodes = new Map();
      for (const n of [...(p.phases || []), ...(p.runs || [])]) if (!nodes.has(n.id)) nodes.set(n.id, n);
      const P = { key: planKeyOf(p), slug: p.slug.toLowerCase(), plan: p, nodes, mtime: p.touchedAt || 0 };
      list.push(P); byKey.set(P.key, P);
      if (!byProject.has(p.project)) byProject.set(p.project, []);
      byProject.get(p.project).push(P);
      const file = planFile(p);
      files.set(file, P);
      // A plan folder's PLAN.md and handoffs/ belong to its board; with two boards in one folder, to neither.
      if (p.size !== 'small') { const dir = file.slice(0, file.lastIndexOf('/')); dirs.set(dir, dirs.has(dir) ? null : P); }
    }
    return { list, byProject, byKey, files, dirs };
  }
  /** The plan a plan-file key belongs to: its board, or the PLAN.md or a file in handoffs/ next to the board. */
  function planOfFile(file, ix) {
    const own = ix.files.get(file);
    if (own) return own;
    const cut = file.lastIndexOf('/'), dir = file.slice(0, cut), base = file.slice(cut + 1);
    if (base === 'plan.md') return ix.dirs.get(dir) || null;
    const up = dir.lastIndexOf('/');
    return up > 0 && dir.slice(up + 1) === 'handoffs' ? ix.dirs.get(dir.slice(0, up)) || null : null;
  }
  /** A branch `<slug>` or `<slug>/<ID or run>`, maybe followed by `-words`. Branch IDs may be in lower case. */
  function branchRef(branch) {
    const m = /^([^/\s]+)(?:\/([A-Za-z]{1,4}-?\d+(?:-\d+)?)(?=$|[-_./](?!\d)))?/.exec(str(branch));
    return m ? { slug: m[1].toLowerCase(), id: m[2] ? m[2].toUpperCase() : null } : null;
  }

  /**
   * The board items one agent works on (PLAN hud-0-3 §4.2 steps 1 to 3). Pure. `agent` is its evidence: { project,
   * label (a session's title or a subagent's description), refs (its prompts, oldest first, each a list of ID-shaped
   * words), touched ([{ file, write, at }], oldest first), branch }. `parentWork` is the work of whoever started it, and
   * `ix` is indexPlans(). Returns { plan, items: [{ id, via, plan }], role: 'worker' } or null.
   *
   * `<slug>/<ID>` words are read from the newest prompt back, so a session given a second item works on that one. An
   * item outside the home plan keeps its own `plan`; with no home plan, the first item's plan is the agent's plan.
   */
  function resolveWork(agent, parentWork, ix) {
    const cands = ix.byProject.get(agent.project);
    if (!cands?.length) return null;
    const bySlug = slug => cands.find(P => P.slug === slug.toLowerCase()) || null;
    const prompts = agent.refs || [];
    const slugRefs = [];
    for (let i = prompts.length - 1; i >= 0; i--) {
      for (const w of prompts[i]) { const cut = w.indexOf('/'); if (cut > 0) slugRefs.push([w.slice(0, cut), w.slice(cut + 1)]); }
    }
    // 2. The home plan: the first match wins.
    let home = null;
    for (const [slug] of slugRefs) if ((home = bySlug(slug))) break;
    if (!home) {
      let pick = null, write = null;
      for (const t of agent.touched || []) {
        const P = planOfFile(t.file, ix);
        if (!P || !cands.includes(P)) continue;
        pick = { t, P };
        if (t.write) write = pick;
      }
      if (pick && !pick.t.write && write && pick.t.at - write.t.at <= 10 * 60_000) pick = write;   // a write beats a read made soon after it
      home = pick?.P ?? null;
    }
    const br = branchRef(agent.branch);
    if (!home && br) home = bySlug(br.slug);
    if (!home && parentWork?.plan) home = cands.find(P => P.key === parentWork.plan) || null;
    // 3. The items, at most ITEMS_MAX. A run links itself and its current item (its first chunk not finished).
    const items = [];
    const add = (P, id, via) => {
      const n = P.nodes.get(id);
      if (!n) return;
      for (const x of n.kind === 'run' ? [id, (n.chunks || []).find(c => !FINISHED.has(P.nodes.get(c)?.state))] : [id]) {
        if (x && items.length < ITEMS_MAX && !items.some(i => i.plan === P.key && i.id === x)) items.push({ id: x, via, plan: P.key });
      }
    };
    for (const [slug, id] of slugRefs) { const P = bySlug(slug); if (P?.nodes.has(id)) { add(P, id, 'ref'); break; } }
    for (const w of idWords(agent.label || '')) {
      const cut = w.indexOf('/'), id = cut > 0 ? w.slice(cut + 1) : w;
      let P = cut > 0 ? bySlug(w.slice(0, cut)) : null;
      if (!P?.nodes.has(id)) {
        const having = cands.filter(c => c.nodes.has(id));
        const open = having.filter(c => !FINISHED.has(c.nodes.get(id).state));
        P = home?.nodes.has(id) ? home : having.length === 1 ? having[0] : open.length === 1 ? open[0] : null;   // else: nothing (D2)
      }
      if (P) add(P, id, 'name');
    }
    if (br?.id) { const P = bySlug(br.slug); if (P) add(P, br.id, 'branch'); }
    const plan = home?.key ?? items[0]?.plan ?? null;
    return plan ? { plan, items, role: 'worker' } : null;
  }
  /** Resolves every agent, parents first (step 2.4), then step 4: whoever has a subagent linked in its own plan coordinates. */
  function linkAgents(agents, ix) {
    const byKey = new Map(agents.map(e => [e.key, e]));
    const visit = (e, depth) => {
      if (e.work !== undefined) return e.work;
      e.work = null;                        // an agent in a cycle of parents resolves without one
      const p = e.parent ? byKey.get(e.parent) : null;
      return (e.work = resolveWork(e, p && depth < 20 ? visit(p, depth + 1) : null, ix));
    };
    for (const e of agents) visit(e, 0);
    for (const e of agents) {
      const p = e.agentId && e.parent ? byKey.get(e.parent) : null;
      if (p?.work && e.work?.items.some(i => i.plan === p.work.plan)) p.work.role = 'coordinator';
    }
  }
  function newTrack() { return { inFlightSince: null, lastInFlightAt: 0, changedAt: 0, on: new Set() }; }
  /**
   * state.board (PLAN hud-0-3 §4.2, §4.3) from resolved agents: links, marks and lists. `track` keeps each item's clocks
   * between calls (boardTrack; the demo has its own): when its current unbroken stretch in flight began, when it was last
   * in flight, when it last changed state (diffPlan), and its marks at the last call. Nothing before `floor` (the HUD's
   * start) counts, so after a restart `stalled` counts from the restart. Returns { board, turnedOn: [{ P, node, flag }] }.
   */
  function boardState(agents, ix, { now, track, unclaimedMs = UNCLAIMED_MS, stalledMs = STALLED_MS, floor = hudStartedAt }) {
    const items = {}, plans = {}, ready = [], awaiting = [], ownerInputs = [], turnedOn = [];
    const item = k => (items[k] ??= { agents: [], flags: [], since: null });
    for (const e of agents) {
      const w = e.work;
      if (!w) continue;
      if (e.active) for (const pk of new Set([w.plan, ...w.items.map(i => i.plan)])) (plans[pk] ??= { active: 0 }).active++;
      for (const i of w.items) item(`${i.plan}#${i.id}`).agents.push({ sessionId: e.sessionId, agentId: e.agentId, active: e.active, via: i.via, role: w.role });
    }
    const live = new Set();
    for (const P of ix.list) {
      const std = P.plan.format === 'standard';
      const inRun = new Set(std ? (P.plan.runs || []).flatMap(r => r.chunks || []) : []);
      const done = id => !P.nodes.has(id) || FINISHED.has(P.nodes.get(id).state);
      for (const n of P.nodes.values()) {
        const k = `${P.key}#${n.id}`;
        live.add(k);
        const x = items[k], deps = n.waitsFor || [];
        const inFlight = !!x && x.agents.some(a => a.active);
        let t = track.get(k);
        if (inFlight) { if (!t) track.set(k, (t = newTrack())); t.inFlightSince ??= now; t.lastInFlightAt = now; }
        else if (t) t.inFlightSince = null;
        const flags = [];
        let since = inFlight ? t.inFlightSince : null;
        if (n.state === 'todo' && inFlight && now - t.inFlightSince >= unclaimedMs) flags.push('unclaimed');
        if (n.state === 'in-progress' && !inFlight) {
          since = Math.max(floor, t?.lastInFlightAt || 0, t?.changedAt || 0, P.mtime);
          if (now - since >= stalledMs) flags.push('stalled');
        }
        if ((n.state === 'in-progress' || inFlight) && deps.some(d => !done(d))) flags.push('early');
        if (x || flags.length) { const it = item(k); it.flags = flags; it.since = since; }
        if (flags.length || t?.on.size) {
          if (!t) track.set(k, (t = newTrack()));
          for (const f of flags) if (!t.on.has(f)) turnedOn.push({ P, node: n, flag: f });
          t.on = new Set(flags);
        }
        if (!std) continue;   // the lists need the standard's states and owner inputs
        if (n.state === 'handed-off') awaiting.push({ plan: P.key, id: n.id });
        // Ready: an item to start, or a run. An item that is part of a run starts with its run, not on its own.
        if (n.state === 'todo' && !inFlight && n.kind !== 'input' && !OWNER_AGENTS.test(n.agent || '') && !inRun.has(n.id) && deps.every(done)) {
          ready.push({ plan: P.key, id: n.id, run: n.kind === 'run' });
        }
        if (n.kind === 'input' && n.state === 'todo') {
          const unlocks = [];
          for (const m of P.nodes.values()) if ((m.state === 'todo' || m.state === 'blocked') && m.kind !== 'input' && (m.waitsFor || []).includes(n.id)) unlocks.push(m.id);
          if (unlocks.length) ownerInputs.push({ plan: P.key, id: n.id, unlocks });
        }
      }
    }
    for (const k of track.keys()) if (!live.has(k)) track.delete(k);
    return { board: { items, plans, ready, awaiting, ownerInputs }, turnedOn };
  }
  /** Links `agents` (see liveAgents) to the boards of `planList`, puts `work` on each one's view, and builds state.board. */
  function followBoards(agents, planList, opts) {
    const ix = indexPlans(planList);
    linkAgents(agents, ix);
    for (const e of agents) e.view.work = e.work;
    return boardState(agents, ix, opts);
  }
  /** The evidence of every session and subagent in the state's list (§4.2): parents are keyed `<sessionId>` and `<sessionId>/<id>`. */
  function liveAgents(list) {
    const out = [];
    for (const x of list) {
      const s = sessions.get(x.id), info = s?.tail?.info;
      out.push({ key: x.id, parent: x.startedBy || null, sessionId: x.id, agentId: null, view: x, project: x.project,
        label: x.title, refs: info?.refs, touched: mergeTouched(info?.touched, s?.touched), branch: x.branch,
        active: x.status === 'busy' || x.status === 'needs-you' });
      for (const a of x.subagents || []) {
        const sub = s && (s.byAgent.get(a.id) || s.byToolUse.get(a.id));
        const own = sub ? sub.tail?.info : sessions.get(a.id)?.tail?.info;   // or a Codex child session drawn as a subagent
        out.push({ key: `${x.id}/${a.id}`, parent: a.parentId === x.id ? x.id : `${x.id}/${a.parentId}`, sessionId: x.id, agentId: a.id,
          view: a, project: x.project, label: a.description, refs: sub ? sub.refs || own?.refs : null,
          touched: sub ? mergeTouched(own?.touched, sub.touched) : [], branch: own?.branch || x.branch, active: a.state === 'running' });
      }
    }
    return out;
  }
  /** A mark that turns on writes one feed line, once per item and mark (D4). Marks already on at start are not news. */
  function announceMarks(turnedOn, now) {
    for (const { P, node, flag } of turnedOn) {
      const key = `mark:${P.key}#${node.id}:${flag}`;
      if (now - hudStartedAt < STARTUP_MS) { feedSeen.add(key); continue; }
      pushFeed({ id: null, project: P.plan.project }, 'plan', `${P.plan.title}: ${node.id} ${MARK_WORDS[flag]}`, now, key);
    }
  }

  // =====================================================================================================================
  // Account usage (5-hour and weekly limits): Claude Code caches it in ~/.claude.json. Only that key is used.

  const readAccount = lifetime.task(async function () {
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
  });
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
    lifetime.exec('aws', args, { timeout: 10_000, windowsHide: true, maxBuffer: 8 << 20 }, (err, out, errOut) => {
      if (lifetime.signal.aborted) return;
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
  /**
   * When the session last did something: a dated transcript line or a hook other than SessionStart / SessionEnd.
   * Opening an old conversation (the VS Code extension does it for a moment when a window opens) starts a process and
   * touches the registry and the transcript, but writes no dated line, so it does not count.
   */
  function lastWork(s) {
    return Math.max(s.tail?.info.lastTs || 0, s.lastWorkAt || 0);
  }
  /**
   * An ended session is shown for ENDED_KEEP_MS after it last worked, not after its process exited: a conversation
   * from last week that was opened and closed again is not "just ended". One that never worked is never shown as ended.
   */
  function endedLongAgo(s, now) {
    return s.ended && now - Math.min(s.endedAt || 0, lastWork(s)) > ENDED_KEEP_MS;
  }
  function sessionStatus(s, now) {
    if (s.ended) return 'ended';
    if (s.needsYou) return 'needs-you';
    if (s.hookStatus && s.hookStatusAt >= s.regStatusAt) return s.hookStatus;
    if (s.regStatus) return s.regStatus;
    const last = lastActivity(s);
    return last && now - last < 30_000 ? 'busy' : 'idle';
  }
  function latestOpenTool(info, after = 0, done) {
    let best = null;
    for (const t of info?.openTools.values() || []) {
      if (t.since >= after && !done?.has(t.id) && (!best || t.since >= best.since)) best = t;
    }
    return best;
  }
  function toolView(t) { return t ? { name: t.name, summary: t.summary, since: t.since } : null; }

  function currentSessionTool(s, now) {
    if (s.currentTool && s.currentTool.since >= s.turnAt) return s.currentTool;
    const open = latestOpenTool(s.tail?.info, s.turnAt, s.doneTools);
    return open && now - open.since < 30 * MINUTE_MS ? open : null;
  }
  function subLastActivity(sub) {
    return Math.max(sub.tail?.info.lastTs || 0, sub.lastHookAt, sub.startedAt || 0);
  }
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
      lastActivityAt: subLastActivity(sub) || null,
      tokens: info ? { ...info.tokens } : zero(),
      pulse: pulseView(info?.byMinute, now),
      context: contextFor(mi.model, info?.lastUsed, info?.contextWindow),
      currentTool: toolView(tool),
    };
  }
  function sessionView(s, now) {
    const info = s.tail?.info;
    const raw = rawModel(info) || s.hookModel;
    const mi = modelInfo(raw, info);
    const status = sessionStatus(s, now);
    const tool = status === 'busy' || status === 'needs-you' ? currentSessionTool(s, now) : null;
    const everySub = [...s.subs].filter(sub => !isPlaceholder(sub)).map(sub => subView(s, sub, now)).filter(x => x.id);
    const tokens = info ? { ...info.tokens } : zero();
    const tokensTree = everySub.reduce((acc, x) => addTokens(acc, x.tokens), { ...tokens });   // the whole conversation, like `tokens`
    // A resumed conversation lists the subagents of this run. Those that finished well before its process started
    // (`startedAt` is the process start, from the registry) belong to an earlier run and are not drawn.
    const runStart = s.startedAt ? s.startedAt - ENDED_KEEP_MS : 0;
    const subagents = everySub.filter(a => !(a.state === 'done' && a.endedAt && a.endedAt < runStart)).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    let tools = s.hookTools.size;
    if (info) { tools = info.toolIds.size; for (const id of s.hookTools) if (!info.toolIds.has(id)) tools++; }
    return {
      id: s.id, agent: s.agent, pid: s.pid, project: s.project || (info?.cwd ? rootFor(info.cwd).project : null), cwd: s.cwd || info?.cwd || null,
      name: s.name, title: truncate(info?.customTitle || info?.title || s.name || null, 300) || null,
      entrypoint: s.entrypoint, version: s.version,
      status,
      needsYou: s.needsYou ? { since: s.needsYou.since, reason: s.needsYou.reason, kind: s.needsYou.kind } : null,
      provider: mi.provider, model: mi.model, modelRaw: raw || null, effort: info?.effort || null, branch: info?.branch || null,
      startedAt: s.startedAt || info?.firstTs || null, lastActivityAt: lastActivity(s), endedAt: s.endedAt,
      currentTool: toolView(tool),
      tools,
      startedBy: s.startedBy,
      tokens, tokensTree, pulse: pulseView(info?.byMinute, now), turn: { ...s.turn },
      context: contextFor(mi.model, info?.lastUsed, info?.contextWindow),
      subagents,
      agentsRunning: subagents.filter(a => a.state === 'running').length,   // hud-0-3 D6: an idle parent with these reads "Agents working"
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
  const liveAlerts = new Map();
  function alertsFor(list, account, now, active, toolFor) {
    const next = new Map();
    function add(id, kind, text, session = null, agent = null, at = now) {
      next.set(id, { id, kind, sessionId: session?.id ?? null, agentId: agent?.id ?? null,
        project: session?.project ?? null, text, since: active.get(id)?.since ?? at });
    }
    function context(session, agent) {
      const pct = (agent || session).context?.pct;
      for (const level of [80, 90]) {
        const id = ['context', session.id, agent?.id, level].filter(v => v != null).join(':');
        if (pct >= level - (active.has(id) ? 5 : 0)) {
          add(id, 'context', `${agent ? 'Subagent context' : 'Context'} reached ${level}%`, session, agent);
        }
      }
    }
    for (const session of list) {
      if (session.status === 'ended') continue;
      context(session);
      if (session.status === 'busy') {
        const tool = toolFor(session);
        if (tool?.since && now - tool.since >= TOOL_ALERT_MS && !tool.background && !AGENT_TOOLS.has(tool.name)) {
          add(`tool:${session.id}:${tool.id || tool.since}`, 'tool', `${tool.name} running for 10 min`, session, null, tool.since + TOOL_ALERT_MS);
        }
      }
      for (const agent of session.subagents) {
        if (agent.state !== 'running') continue;
        context(session, agent);
        const at = agent.lastActivityAt || agent.startedAt;
        if (at && now - at >= SUB_ALERT_MS) {
          add(`subagent:${session.id}:${agent.id}`, 'subagent', 'Subagent silent for 5 min', session, agent, at + SUB_ALERT_MS);
        }
      }
    }
    for (const [key, label] of [['fiveHour', '5-hour usage'], ['sevenDay', 'Weekly usage']]) {
      const window = account?.[key];
      if (window?.pct >= 90 && (!window.resetsAt || window.resetsAt > now)) {
        add(`usage:account:${key}`, 'usage', `${label} reached 90%`);
      }
    }
    active.clear();
    for (const [id, alert] of next) active.set(id, alert);
    return [...next.values()];
  }
  function projectSnapshot(now) {
    if (demo) return { ...demo.project(now), push };
    const list = codexTree([...sessions.values()]
      .filter(s => (s.shown || s.agent === 'codex') && !endedLongAgo(s, now) && (s.inRegistry || s.tail || s.lastHookAt))
      .map(s => sessionView(s, now))
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.lastActivityAt || 0) - (a.lastActivityAt || 0)));
    const today = dayKey(now);
    const tokensToday = zero();
    for (const t of tails.values()) { const d = t.info.byDay.get(today); if (d) addTokens(tokensToday, d); }
    // Plans carry when their board last changed and their last state changes (history). Nothing in a plan changes with a
    // session, so the stream sends plans only when a board changes (hud-0-3 P3); what links sessions to boards is in
    // `board`, which goes with every state.
    const planList = [...plans.values()].map(v => ({ ...v.plan, touchedAt: Math.round(v.mtime), history: planHistory.get(planKeyOf(v.plan)) || [] }))
      .sort((a, b) => a.project.localeCompare(b.project) || a.title.localeCompare(b.title));
    const { board, turnedOn } = followBoards(liveAgents(list), planList, { now, track: boardTrack });
    announceMarks(turnedOn, now);
    const alerts = alertsFor(list, account, now, liveAlerts, x => currentSessionTool(sessions.get(x.id), now));
    return {
      now, uptime: now - hudStartedAt, demo: false, version: VERSION, host: HOSTNAME, hooksInstalled,
      codex: { ...codexMonitoring, directories: CODEX_ROOTS },
      sessions: list,
      external: [...external.values()],
      externalError,
      projects: projectsView(),
      plans: planList,
      board, alerts, push,
      account,
      totals: totalsFor(list, planList, tokensToday),
    };
  }

  // Phone push (hud-0-3 D13). Only new needs-you transitions can use this endpoint.
  const push = { enabled: false, lastError: null };
  const pushBySession = new Map(), pushTimes = [];
  let pushUrl = null;
  function configurePhonePush() {
    const configured = config.pushUrl;
    if (!configured) return;
    try {
      const url = new URL(configured);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      pushUrl = url;
      push.enabled = true;
    } catch {
      push.lastError = 'HUD_PUSH_URL must be an HTTP or HTTPS URL';
      console.error(push.lastError + '. Phone push disabled.');
    }
  }
  const sendPhonePush = lifetime.task(async function (session, kind) {
    if (!pushUrl || !['permission', 'question', 'input'].includes(kind)) return;
    const now = performance.now();
    for (const [id, sent] of pushBySession) if (now - sent >= MINUTE_MS) pushBySession.delete(id);
    while (pushTimes.length && now - pushTimes[0] >= 60 * MINUTE_MS) pushTimes.shift();
    if (pushBySession.has(session.id) || pushTimes.length >= 20) return;
    pushBySession.set(session.id, now);
    pushTimes.push(now);

    let error = null;
    try {
      const res = await fetch(pushUrl, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]),
        headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: 'Claude HUD' },
        body: redact(oneLine(session.project || 'Session')) + ' needs you: ' + kind,
      });
      if (!res.ok) error = 'Phone push HTTP ' + res.status;
      void res.body?.cancel().catch(() => {});
    } catch (err) {
      error = err?.name === 'TimeoutError' ? 'Phone push timed out' : 'Phone push request failed';
    }
    if (error !== push.lastError) {
      push.lastError = error;
      scheduleState();
    }
  });

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
    const addFeed = (s, kind, text, action = null, at = Date.now()) => {
      const line = { at, sessionId: s?.id ?? null, project: s?.project ?? null, kind, text };
      if (action) line.action = action;
      appendFeed(line);
    };
    // Board following (hud-0-3 P4): each agent's made-up evidence beside its label and branch, the marks' clocks, and the
    // marks already announced. The demo's state goes through the same followBoards() as the real one.
    const evidence = new Map();   // session or subagent id -> { refs, touched }
    const demoPulses = new WeakMap(), demoAlerts = new Map();
    const track = new Map(), announced = new Set();
    const WM2_SLUG = 'customer-history-and-change-requests';

    function session(o) {
      const model = o.modelRaw || 'claude-opus-5-5';
      const mi = normalizeModel(model);
      const s = {
        id: randomUUID(), agent: o.agent || 'claude', pid: rnd(2000, 60000), project: o.project, cwd: repo(o.folder || o.project), name: `${o.project.toLowerCase()}-${rnd(16, 255).toString(16)}`,
        title: o.title, entrypoint: o.entrypoint || 'claude-vscode', version: '2.1.312', status: o.status,
        needsYou: o.needsYou ? { since: t0 - (o.needsFor || 60) * 1000, reason: o.needsYou, kind: o.needsKind || 'permission' } : null,
        provider: o.agent === 'codex' ? 'openai' : mi.provider, model: mi.model, modelRaw: model, effort: o.effort || 'high', branch: o.branch || 'main',
        startedAt: t0 - (o.age || 1800) * 1000, lastActivityAt: t0 - (o.quiet || 2) * 1000, endedAt: o.status === 'ended' ? t0 - (o.endedAgo || 180) * 1000 : null,
        currentTool: null, tools: rnd(6, 180), startedBy: null, tokens: tok(o.scale || 1), tokensTree: null, context: null, subagents: [],
        turn: { startedAt: o.status === 'busy' ? t0 - 30_000 : null, lastMs: 94_000 },
        _ctx: o.ctx ?? rnd(6, 48),
      };
      if (s.status === 'busy' || s.status === 'needs-you') setTool(s);
      if (o.refs || o.touched) evidence.set(s.id, { refs: o.refs, touched: o.touched });
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
      if (o.refs || o.touched) evidence.set(a.id, { refs: o.refs, touched: o.touched });
      s.subagents.push(a);
      return a;
    }
    function setTool(x) { const [name, summary] = pick(TOOLS); x.currentTool = { name, summary, since: Date.now() - rnd(0, 20) * 1000 }; }
    function noteOutput(x, at, output, current) {
      let buckets = demoPulses.get(x);
      if (!buckets) { buckets = new Map(); demoPulses.set(x, buckets); }
      addPulse(buckets, minuteOf(at), output, current);
    }
    function grow(x, now) {
      const output = rnd(20, 400);
      x.tokens.output += output; x.tokens.cacheRead += rnd(2_000, 30_000); x.tokens.cacheWrite += rnd(0, 3_000); x.tokens.input += rnd(0, 3);
      noteOutput(x, now, output, minuteOf(now));
    }

    // Board links (hud-0-3 P4), one of each kind: the FidiaCRM session by the IDs in its title (R14, so its current chunk
    // UX-10 too), the coordinator by its title and the board it wrote, its first subagent by the `<slug>/<ID>` of its
    // prompt, the Codex session by its title (UX-12, started early), the TourCMS waiter by its branch, and its subagent by
    // its description (P4, worked on while todo: "board not updated").
    let coordinator, flipper, cycler = null, explore = null, codex = null, waiter = null;
    if (!dense) {
      const needs = session({ project: 'FidiaCRM', folder: 'Fidia CRM', title: 'R14 quotation screens: totals, VAT rows and the discount line', status: 'needs-you', needsYou: 'Permission: Bash', needsFor: 95, branch: 'ux/R14-quotation-wizard', scale: 2, ctx: 82 });
      noteOutput(needs, t0 - 4 * MINUTE_MS, 2100, minuteOf(t0));
      coordinator = session({ project: 'WasteManagement2', title: 'Coordinator: customer history plan, phases P2 and P3', status: 'busy', branch: 'customer-history', scale: 4, ctx: 42, age: 5400,
        touched: [{ id: 'demo-edit-1', file: `wastemanagement2|docs/plans/${WM2_SLUG}/status.md`, write: true, at: t0 - 600_000 }] });
      explore = sub(coordinator, coordinator.id, 1, ['general-purpose', 'P2 history tab and header'], { age: 120, refs: [[`${WM2_SLUG}/P2`]] });
      sub(coordinator, explore.id, 2, AGENT_JOBS[1], { age: 50, modelRaw: 'claude-haiku-5-5' });
      cycler = sub(coordinator, coordinator.id, 1, AGENT_JOBS[2], { age: 10, modelRaw: 'claude-haiku-5-5' });
      codex = session({ project: 'FidiaCRM', agent: 'codex', entrypoint: 'cli', title: 'Clients: contact length limits (UX-12)', status: 'idle', branch: 'clients/UX-12', quiet: 900, effort: 'medium', modelRaw: 'gpt-6-astra' });
      const ended = session({ project: 'WasteManagement2', title: 'Say hi', status: 'ended', endedAgo: 180, age: 240, effort: 'low', modelRaw: 'claude-haiku-5-5', scale: 0.1 });
      ended.startedBy = coordinator.id;
      waiter = session({ project: 'TourCMS', title: 'Booking changes: waiting on the review agent', status: 'idle', quiet: 40, branch: 'booking-changes/P4-price-check', modelRaw: 'claude-sonnet-5-5', effort: 'medium' });
      sub(waiter, waiter.id, 1, ['general-purpose', 'P4 price check for changed dates'], { age: 90, background: true });   // hud-0-3 D6: "Agents working"
      flipper = session({ project: 'ImPOS-Maui', title: 'Phone app phase 7: battery and Xiaomi autostart switches, runbook for the real-phone pass on the Samsung and the support notes for the shop owners', status: 'busy', branch: 'phone-app', modelRaw: 'us.anthropic.claude-sonnet-5-5-v1:0', scale: 2 });
      addFeed(undefined, 'done', 'Turn finished', 'turn-finished', t0 - 6 * MINUTE_MS);
      addFeed(needs, 'needs-you', 'Permission: Bash');
      addFeed(coordinator, 'done', 'Agent done · Explore: map the change history code', 'agent-done');
      addFeed(codex, 'done', 'Codex turn complete', 'turn-finished');
      addFeed(waiter, 'done', 'Turn finished', 'turn-finished');
      addFeed(waiter, 'plan', 'Booking changes: P1 in-progress → handed-off', 'item-changed');
    } else {
      const projects = ['FidiaCRM', 'WasteManagement2', 'ImPOS-Maui', 'TourCMS', 'Aegis', 'fidiagraf.com'];
      const statuses = ['needs-you', 'busy', 'busy', 'idle', 'busy', 'idle', 'ended', 'busy'];
      for (let i = 0; i < 24; i++) {
        const status = statuses[i % statuses.length];
        const s = session({ project: projects[i % projects.length], title: `${pick(['Fix', 'Build', 'Review', 'Plan', 'Migrate'])} ${pick(['quotation totals', 'the history tab', 'Xiaomi autostart', 'booking changes', 'the tour calendar', 'invoice OCR', 'the deployment guide for the first agency server'])}`,
          status, needsYou: status === 'needs-you' ? pick(['Permission: Bash', 'Question for you', 'Permission: Edit']) : null, modelRaw: i % 7 === 3 ? 'global.anthropic.claude-opus-5-5-v1:0' : pick(['claude-opus-5-5', 'claude-sonnet-5-5']), quiet: status === 'idle' ? rnd(60, 3000) : 2,
          refs: i === 1 ? [[`${WM2_SLUG}/P2`]] : undefined });
        if (status === 'busy' && i % 3 === 1) {
          const a = sub(s, s.id, 1, i === 1 ? ['general-purpose', 'P3 change requests'] : pick(AGENT_JOBS));
          if (i % 2) sub(s, a.id, 2, pick(AGENT_JOBS));
        }
        if (i === 3) sub(s, s.id, 1, pick(AGENT_JOBS), { background: true });   // an idle parent waiting on a subagent (D6)
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
        .map(([id, name, agent, waitsFor]) => ({ id, name, agent, state: 'todo', stateRaw: 'todo', since: null, waitsFor, notes: waitsFor.length ? `Waits for ${waitsFor.join(' and ')}` : null, group: 'Board', kind: 'phase', model: 'Opus 5.5', effort: 'high', handoff: false })),
      format: 'standard', size: 'phased', state: 'building', stateDate: null, needsYou: [],
      runs: [], lastLog: ['2026-10-29 · planner · — · Plan written.', '2026-10-29 · planner · P0 · All decisions confirmed. P1 can start.'],
      touchedAt: t0, history: [],
    };
    const chunkPlan = {
      project: 'FidiaCRM', slug: 'Documentation/Implementation/STATUS', title: 'Implementation', path: `${repo('FidiaCRM')}\\Documentation\\Implementation\\STATUS.md`,
      phases: [
        ...['Spec, tokens, gates', 'Frame and action bars', 'Table system'].map((name, i) => ({ id: `UX-0${i + 1}`, name, agent: null, state: 'done', stateRaw: 'done (2026-10-28)', since: '2026-10-28', waitsFor: i ? [`UX-0${i}`] : [], notes: null, group: 'Phase 12: UI/UX upgrade', kind: 'chunk', model: 'Opus 5.5', effort: 'high' })),
        // UX-12 was claimed before the owner input it waits for (started early); UX-13 has had nobody on it for 50 minutes (stalled).
        ...['Quotation wizard and case wizard', 'Quotations', 'Clients', 'Invoices'].map((name, i) => ({ id: `UX-1${i}`, name, agent: null, state: i === 1 ? 'todo' : 'in-progress', stateRaw: i === 1 ? 'todo' : 'in progress (2026-10-29)', since: i === 1 ? null : '2026-10-29', waitsFor: i === 2 ? ['UX-03', 'O-9'] : ['UX-03'], notes: null, group: 'Phase 12: UI/UX upgrade', kind: 'chunk', model: i % 2 ? 'Sonnet 5.5' : 'Opus 5.5', effort: 'high' })),
        { id: 'UX-20', name: 'Sweep and owner review', agent: null, state: 'todo', stateRaw: 'todo', since: null, waitsFor: ['UX-10', 'UX-11', 'UX-12', 'UX-13'], notes: null, group: 'Phase 12: UI/UX upgrade', kind: 'chunk', model: 'Opus 5.5', effort: 'high' },
        { id: 'O-9', name: 'Production column sizes for client contacts', agent: null, state: 'todo', stateRaw: 'wanted', since: null, waitsFor: [], notes: null, group: 'Owner inputs', kind: 'input', model: null, effort: null },
      ],
      runs: [
        { id: 'R14', name: 'Quotation screens', agent: null, state: 'in-progress', stateRaw: 'in progress (2026-10-29)', since: '2026-10-29', waitsFor: ['UX-03'], notes: null, group: 'Runs', kind: 'run', model: 'Opus 5.5', effort: 'high', lane: 'A', chunks: ['UX-10', 'UX-11'], startWhen: 'UX-06 done' },
        { id: 'R15', name: 'Clients screens', agent: null, state: 'todo', stateRaw: 'todo', since: null, waitsFor: ['O-9'], notes: null, group: 'Runs', kind: 'run', model: 'Sonnet 5.5', effort: 'high', lane: 'B', chunks: ['UX-12'], startWhen: 'O-9 is in' },
      ],
      format: 'legacy', size: 'phased', state: null, stateDate: null,
      needsYou: [{ kind: 'question', id: '3', item: 'UX-12', text: 'Contact names longer than 60 characters: cut them, or widen the column to 120?' }],
      lastLog: [],
      touchedAt: t0 - 50 * 60_000,
      history: [{ at: t0 - 50 * 60_000, id: 'UX-13', from: 'todo', to: 'in-progress', sessionId: null, agentId: null },
        ...(codex ? [{ at: t0 - 20 * 60_000, id: 'UX-12', from: 'todo', to: 'in-progress', sessionId: codex.id, agentId: null }] : [])],
    };
    // One of each list (D5): P1 waits to be accepted, P2 is ready, O-1 is the owner input P3 waits for. P4 is worked on.
    const smallPlan = {
      project: 'TourCMS', slug: 'booking-changes', title: 'Booking changes', path: `${repo('TourCMS')}\\docs\\plans\\booking-changes.md`,
      format: 'standard', size: 'small', state: 'approved', stateDate: '2026-10-28',
      needsYou: [{ kind: 'decision', id: 'D2', text: 'D2 A changed booking keeps its original price unless the tour price went down ★' }],
      phases: [['P1', 'Change dates', 'handed-off', [], 'bookings'], ['P2', 'Change people', 'todo', ['P1'], 'bookings'], ['P3', 'Refunds for changed bookings', 'todo', ['P1', 'O-1'], 'bookings'],
        ['O-1', 'Refund policy from the owner', 'todo', [], 'owner'], ['P4', 'Price check for changed dates', 'todo', [], 'pricing']]
        .map(([id, name, state, waitsFor, agent]) => ({ id, name, agent, state, stateRaw: state, since: state === 'todo' ? null : '2026-10-29', waitsFor, notes: null, group: 'Board', kind: id.startsWith('O-') ? 'input' : 'item',
          model: agent === 'owner' ? null : 'Sonnet 5.5', effort: agent === 'owner' ? null : 'high', handoff: id === 'P1' })),
      runs: [], lastLog: [],
      touchedAt: t0 - 2 * 3600_000,
      history: waiter ? [{ at: t0 - 3 * 3600_000, id: 'P1', from: 'todo', to: 'in-progress', sessionId: waiter.id, agentId: null },
        { at: t0 - 2 * 3600_000, id: 'P1', from: 'in-progress', to: 'handed-off', sessionId: waiter.id, agentId: null },
        ...[['unknown', 'todo'], ['todo', 'in-progress'], ['in-progress', 'partial'], ['partial', 'todo']].map(([from, to], i) => ({
          id: 'P4', from, to, at: t0 - (8 - i) * 60_000, sessionId: waiter.id, agentId: waiter.subagents[0].id,
        }))] : [],
    };
    const quietPlans = [
      { ...smallPlan, slug: 'currency-display', title: 'Currency display', path: `${repo('TourCMS')}\\docs\\plans\\currency-display.md`,
        state: 'closed', needsYou: [], touchedAt: t0 - 86_400_000, history: [],
        phases: [{ ...smallPlan.phases[0], state: 'accepted', stateRaw: 'accepted' }] },
      { ...smallPlan, slug: 'archived-booking-notes', title: 'Archived booking notes', path: `${repo('TourCMS')}\\docs\\plans\\archived-booking-notes.md`,
        format: 'legacy', state: null, needsYou: [], touchedAt: t0 - 16 * 86_400_000, history: [], phases: [smallPlan.phases[1]] },
    ];
    for (const n of [...plan.phases, ...chunkPlan.phases, ...chunkPlan.runs, ...smallPlan.phases]) { n.waitsForOther = []; n.handoff ??= false; }
    // The marks' clocks: P4 has been worked on for 4 minutes, UX-12's Codex session was last busy 15 minutes ago.
    track.set(`TourCMS|booking-changes#P4`, { ...newTrack(), inFlightSince: t0 - 4 * 60_000 });
    track.set(`FidiaCRM|${chunkPlan.slug}#UX-12`, { ...newTrack(), lastInFlightAt: t0 - 15 * 60_000 });
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
        if (s.status === 'busy') { grow(s, now); s.lastActivityAt = now; if (Math.random() < 0.18) { setTool(s); s.tools++; addFeed(s, 'tool', `${s.currentTool.name} · ${s.currentTool.summary}`); } }
        for (const a of s.subagents) if (a.state === 'running') { grow(a, now); a.lastActivityAt = now; if (Math.random() < 0.15) { setTool(a); addFeed(s, 'tool', `${a.type} › ${a.currentTool.name} · ${a.currentTool.summary}`); } }
      }
      if (coordinator && coordinator.status === 'busy') {
        if (now - coordinator.turn.startedAt >= 60_000) {
          coordinator.turn = { startedAt: now, lastMs: now - coordinator.turn.startedAt };
          addFeed(coordinator, 'done', 'Turn finished', 'turn-finished');
        }
        coordinator._ctx += 0.6;
        if (coordinator._ctx > 91) { coordinator._ctx = 34; addFeed(coordinator, 'session', 'Compacting context (auto)'); }
      }
      if (cycler) {   // a subagent that finishes and is replaced, so arrivals and the "done" moment can be designed
        const age = (now - cycler.startedAt) / 1000;
        if (cycler.state === 'running' && age > 16) { cycler.state = 'done'; cycler.endedAt = now; cycler.currentTool = null; addFeed(coordinator, 'done', `Agent done · ${cycler.type}: ${cycler.description}`, 'agent-done'); }
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
          if (planStep >= 0 && ph.state !== st) {
            // As diffPlan: P2 is written by the coordinator's first subagent, P3 by the coordinator (hud-0-3 P4).
            const by = !coordinator || ph.id === 'P1' || ph.id === 'P4' ? null : ph.id === 'P2' && explore ? { sessionId: coordinator.id, agentId: explore.id, label: explore.description } : { sessionId: coordinator.id, agentId: null, label: coordinator.title };
            plan.history.push({ at: now, id: ph.id, from: ph.state, to: st, sessionId: by?.sessionId ?? null, agentId: by?.agentId ?? null });
            if (plan.history.length > HISTORY_MAX) plan.history.shift();
            track.set(`${planKeyOf(plan)}#${ph.id}`, { ...newTrack(), ...track.get(`${planKeyOf(plan)}#${ph.id}`), changedAt: now });
            addFeed({ project: plan.project }, 'plan', by && st === 'in-progress' ? `${plan.title}: ${ph.id} claimed by ${by.label}` : `${plan.title}: ${ph.id} ${ph.state} → ${st}`, 'item-changed');
          }
          ph.state = st; ph.stateRaw = st; ph.since = st === 'todo' ? null : '2026-10-29';
        });
        plan.touchedAt = now;
        planStep = step;
      }
      acct.fiveHour.pct = Math.min(99, Math.round((acct.fiveHour.pct + 0.03) * 100) / 100);
      for (const r of external) if (!r.delayed && Math.random() < 0.3) { r.tokens.input += rnd(200, 2000); r.tokens.output += rnd(50, 500); r.windowEnd = now; }
      scheduleState();
    }

    function project(now) {
      const list = sessionsList.map(s => {
        const out = { ...s, pulse: pulseView(demoPulses.get(s), now), subagents: s.subagents.map(a => {
          const { _ctx, ...rest } = a;
          return { ...rest, context: contextFor(a.model, Math.round(_ctx / 100 * (CONTEXT_WINDOWS[a.model] || 0))), pulse: pulseView(demoPulses.get(a), now) };
        }) };
        delete out._ctx;
        out.context = contextFor(s.model, Math.round(s._ctx / 100 * (CONTEXT_WINDOWS[s.model] || 0)));
        out.tokensTree = out.subagents.reduce((acc, a) => addTokens(acc, a.tokens), { ...s.tokens });
        out.agentsRunning = out.subagents.filter(a => a.state === 'running').length;
        if (out.status === 'busy' || out.status === 'needs-you') out.lastActivityAt = now;
        return out;
      }).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
      const tokensToday = list.reduce((acc, s) => addTokens(acc, s.tokensTree), zero());
      const planList = dense ? [plan] : [plan, chunkPlan, smallPlan, ...quietPlans];
      const agents = [];
      for (const s of list) {
        agents.push({ key: s.id, parent: s.startedBy, sessionId: s.id, agentId: null, view: s, project: s.project,
          label: s.title, branch: s.branch, active: s.status === 'busy' || s.status === 'needs-you', ...evidence.get(s.id) });
        for (const a of s.subagents) {
          agents.push({ key: `${s.id}/${a.id}`, parent: a.parentId === s.id ? s.id : `${s.id}/${a.parentId}`,
            sessionId: s.id, agentId: a.id, view: a, project: s.project, label: a.description, branch: s.branch,
            active: a.state === 'running', ...evidence.get(a.id) });
        }
      }
      const { board, turnedOn } = followBoards(agents, planList, { now, track, floor: t0 - 3 * 3600_000 });
      for (const { P, node, flag } of turnedOn) {
        const key = `${P.key}#${node.id}:${flag}`;
        if (announced.has(key)) continue;
        announced.add(key);
        addFeed({ project: P.plan.project }, 'plan', `${P.plan.title}: ${node.id} ${MARK_WORDS[flag]}`);
      }
      const alerts = alertsFor(list, acct, now, demoAlerts, x => x.currentTool);
      return {
        now, uptime: now - t0, demo: dense ? 'dense' : true, version: VERSION, host: 'STARK-01', hooksInstalled: true,   // a made-up machine, so demo screenshots carry no real one
        sessions: list, external, externalError: null, projects: projectList, plans: planList, board, alerts,
        account: acct, totals: totalsFor(list, planList, tokensToday),
      };
    }

    for (const s of sessionsList) if (s.currentTool) addFeed(s, 'tool', `${s.currentTool.name} · ${s.currentTool.summary}`);
    tick();
    lifetime.interval(tick, 1000);
    return { project };
  }

  // =====================================================================================================================
  // selftest: the normaliser, redaction, summaries and the plan parser, without touching anything on disk.

  function selftest(PORT) {
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
      followBoards(list, many, { now: k * 250, track: track2, floor: 0 });
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
    process.exit(failed ? 1 : 0);
  }

  return { start, project: projectSnapshot, ingestHook, reportUsage: config.acceptUsage ? onUsage : undefined, selftest };
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
function install(ROOTS) {
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
 * HUD) gets them now. Older command hooks are replaced here too. HUD_NO_AUTOINSTALL=1 turns it off.
 */
function autoInstall(ROOTS) {
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
function uninstall(ROOTS) {
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

function autostart(arg, { port: PORT, lan: LAN }) {
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
  const home = path.join(os.homedir(), '.claude');
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
// Command line

async function serve(config, demoMode) {
  const { lan, host, port } = config;
  const runtime = createHudRuntime(config, demoMode);
  const http = createHttpServer({ config, source: runtime.source, writer: runtime.writer });
  const close = () => Promise.all([http.close(), runtime.close()]);
  process.on('uncaughtException', error => console.error('error:', error));
  process.on('unhandledRejection', error => console.error('error:', error));
  try {
    await http.start();
    runtime.start();
  } catch (error) {
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${port} is in use: is the HUD already running? (HUD_PORT picks another port)`
      : `Server error: ${error.message}`);
    process.exitCode = 1;
    await close();
    return;
  }
  process.once('SIGINT', () => { process.exitCode = 130; void close(); });
  process.once('SIGTERM', () => { process.exitCode = 143; void close(); });
  console.log(`Claude HUD ${VERSION} on http://${lan ? 'localhost' : host}:${port}${demoMode ? ` (demo${demoMode === 'dense' ? ', dense' : ''})` : ''}`);
  if (!demoMode) {
    console.log(`Watching Claude Code in: ${config.roots.map(root => root.dir).join('  ')}`);
    console.log(`Watching Codex in: ${config.codexRoots.join('  ')}`);
  }
  if (!lan) return;
  const urls = Object.values(os.networkInterfaces()).flat()
    .filter(address => address?.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.'))
    .map(address => `http://${address.address}:${port}`);
  console.log(`Open on this network (view only): ${urls.join('  ') || 'no network address found'}`);
}

function main(argv) {
  const config = readConfig({ argv });
  const { port: PORT } = config;
  const HELP = `Claude HUD ${VERSION}: a live dashboard of Claude Code and Codex sessions on this PC.

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
  node hud-hook.mjs             the silent hook forwarder (node hud.mjs hook still works)

  HUD_RECORD=<file>            while serving, also append each hook event received, redacted, to <file> as one
                               JSON line (off unless set; for building tests)`;

  const ARGS = argv.filter(a => a !== '--lan');
  const [cmd, arg] = ARGS;
  if (cmd === 'hook') runHook();
  else if (!cmd) void serve(config, false);
  else if (cmd === '--demo' || cmd === '--demo=dense') void serve(config, cmd === '--demo=dense' ? 'dense' : 'demo');
  else if (cmd === 'install') install(config.roots);
  else if (cmd === 'uninstall') uninstall(config.roots);
  else if (cmd === 'autostart') autostart(arg, config);
  else if (cmd === 'lint') lint(ARGS.slice(1));
  else if (cmd === 'selftest') selftest(config);
  else if (cmd === 'help' || cmd === '--help' || cmd === '-h') console.log(HELP);
  else { console.error(`Unknown command: ${cmd}\n\n${HELP}`); process.exit(1); }
}

function isMain() {
  try { return process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url; }
  catch { return false; }
}

if (isMain()) {
  main(process.argv.slice(2));
}

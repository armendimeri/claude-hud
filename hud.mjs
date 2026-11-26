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
import { CONTEXT_WINDOWS, MINUTE_MS, addPulse, addTokens, contextFor, dayKey, minuteOf, modelInfo, normalizeModel, num, pulseView, rawModel, startOfDay, zero } from './src/domain/models.mjs';
import { ENDED_KEEP_MS, SILENT_SESSION_MS, STARTUP_MS, clearNeedsYou, codexTree, createSessions, createTranscriptInfo, endedLongAgo, finishTurn, lastActivity, markNeedsYou, sessionStatus, sessionView, setHookStatus, startTurn } from './src/domain/sessions.mjs';
import { createSubagents, silentSubagentAt } from './src/domain/subagents.mjs';
import { AGENT_TOOLS, createToolSummary, currentSessionTool, isObj, oneLine, str, truncate } from './src/domain/tools.mjs';
import { createWindowsProcessLookup, pidAlive } from './src/platform/windows-process.mjs';
import { createClaudeRegistry } from './src/sources/claude-registry.mjs';
import { createClaudeTranscripts } from './src/sources/claude-transcripts.mjs';
import { createCodexRollouts } from './src/sources/codex-rollouts.mjs';
import { createHookHandler, createHookSource, notificationReason } from './src/sources/hooks.mjs';
import { createTailReader } from './src/sources/tail-reader.mjs';

// =====================================================================================================================
// Settings

const POLL_MS = 3_000;
const PLAN_POLL_MS = 10_000;             // recover missed file events and documentation folders created later

const TOOL_ALERT_MS = 10 * MINUTE_MS;
const SUB_ALERT_MS = 5 * MINUTE_MS;

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

const SCRIPT = fileURLToPath(import.meta.url);

// =====================================================================================================================
// Small helpers

function pad2(n) { return String(n).padStart(2, '0'); }

function readJsonSync(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }

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

// Compose the source adapters and domain state with publication and the remaining board and usage rules.
function createEngine(config, demoMode, lifetime, publisher) {
  const {
    hostname: HOSTNAME, unclaimedMs: UNCLAIMED_MS, stalledMs: STALLED_MS, bedrockRegion: BEDROCK_REGION,
  } = config;
  const ROOTS = config.roots.map(root => ({ ...root, bedrock: false, hooks: false }));
  const CODEX_ROOTS = [...config.codexRoots];
  const { redact, redactDeep, appendFeed, invalidate: scheduleState } = publisher;

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
    for (const root of ROOTS) {
      lifetime.watchFile(root.settings, { interval: 5000 }, readSettingsFlags);
      lifetime.watchFile(root.json, { interval: 10_000 }, readAccount);
    }
    registry.watch();
    claude.watch();
    void registry.scan().then(claude.scanRecentTranscripts);
    codex.watch();
    void codex.scan(true);
    lifetime.interval(poll, POLL_MS);
    if (!BEDROCK_REGION) return;
    if (/^[a-z]{2}(-[a-z]+)+-\d+$/.test(BEDROCK_REGION)) {
      pollCloudWatch();
      lifetime.interval(pollCloudWatch, CLOUDWATCH_EVERY_MS);
    } else externalError = 'CloudWatch: HUD_BEDROCK_REGION is not a region name';
  }

  // =====================================================================================================================
  // Engine state

  let hudStartedAt;

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

  const startedAt = () => hudStartedAt;
  const summarizeTool = createToolSummary(redact);
  const processLookup = createWindowsProcessLookup(lifetime.exec);
  const reader = createTailReader({ task: lifetime.task, signal: lifetime.signal, onChange: scheduleState, createInfo: createTranscriptInfo });
  const subagents = createSubagents({
    mergeTouched, promptRefs, startedAt, pushFeed,
    onAssign: (s, sub, agentId) => claude.attachKnownSubTail(s, sub, agentId),
  });
  const { onAgentCall, onAgentResult, replayAgentCalls, closeSub } = subagents;
  const sessions = createSessions({
    startedAt, timeout: lifetime.timeout, isAlive: pidAlive, pushFeed, closeSub, onChange: scheduleState,
    onResume(s) { s.chainChecked = false; queueChain(s); },
    onReopen(s) { feedSeen.delete('end:' + s.id); },
  });
  const { getSession, findSession, listSessions, settle, askResume, sessionLine, endSession, reopenSession, dropSession } = sessions;
  const registry = createClaudeRegistry({ roots: ROOTS, hostname: HOSTNAME, lifetime, processLookup, reconcile: reconcileRegistry });
  const claude = createClaudeTranscripts({
    roots: ROOTS, lifetime, reader, summarizeTool, findSession, onRecentSession, onTool: onClaudeTool,
    onActivity(s) { if (!s.shown || s.resumeAt) settle(s); },
    collectPrompt: addPrompt, onAgentCall, onAgentResult, onAttach: replayAgentCalls, onCwd: setCwd,
    onSubagentMeta: subagents.applyMetadata, findOrAssignSubagent: subagents.findOrAssign,
    closeSub, onChange: scheduleState,
  });
  const { attachSessionTranscript } = claude;
  const codex = createCodexRollouts({
    directories: CODEX_ROOTS, lifetime, reader, redact, summarizeTool, onCwd: setCwd,
    onSession(t, id, metadata) {
      const s = getSession(id);
      Object.assign(s, metadata);
      s.agent = 'codex'; s.tail = t; s.transcriptPath = t.file;
      return s;
    },
    onActivity(s, ts) {
      if (s.ended && ts > (s.endedAt || 0) && Date.now() - ts < SILENT_SESSION_MS) reopenSession(s);
    },
    onStatus: onCodexStatus,
    onTool(s, id, name, summary, ts) {
      setHookStatus(s, 'busy', ts);
      if (isCodexQuestion(name)) setNeedsYou(s, 'Question for you', 'question', ts);
      if (ts >= hudStartedAt - 2000) feedTool(s, null, id, name, summary, ts);
    },
    onToolDone(s, name) { if (isCodexQuestion(name)) clearNeedsYou(s); },
    onIdle: endSilentCodex, onChange: scheduleState,
  });
  const ingestHook = createHookSource({
    recordFile: config.recordFile, redactDeep,
    onEvent: demoMode ? null : createHookHandler({
      sessions, subagents, transcripts: claude, setCwd, isAlive: pidAlive, setNeedsYou,
      noteToolTouch: hookTouch, summarizeTool, feedTool, pushFeed, onChange: scheduleState,
    }),
  });

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

  // Source events are applied here before publication.
  function onClaudeTool(t, id, name, summary, file, ts) {
    if (PLAN_TOOLS.has(name) && file) {
      const key = planFileKey(file, t.info.cwd || t.owner?.session.cwd);
      if (key) {
        const at = ts || Date.now();
        noteTouched(t.info.touched, id, key, name !== 'Read', at);
        if (name !== 'Read') noteWrite(key, t.owner?.session.id ?? t.info.sessionId, t.owner ? t.owner.agentId : t.info.agentId, at);
      }
    }
    if (ts >= hudStartedAt - 2000 && t.owner) {
      const s = t.owner.session;
      feedTool(s, t.owner.agentId ? s.byAgent.get(t.owner.agentId) : null, id, name, summary, ts);
    }
  }

  function onRecentSession(id, file, lastTs) {
    // A readable registry lists the active sessions. Otherwise apply the transcript silence fallback.
    const s = getSession(id);
    s.shown = true;
    attachSessionTranscript(s, file);
    if (registry.isReadable() || Date.now() - lastTs > SILENT_SESSION_MS) endSession(s, lastTs, null);
  }

  function isCodexQuestion(name) { return /^request_user_input(?:_async)?$/.test(name); }

  function onCodexStatus(s, type, ts) {
    if (type === 'session_end' || type === 'shutdown_complete') { endSession(s, ts, 'closed'); return; }
    const busy = type === 'task_started' || type === 'turn_started' || type === 'user_message';
    setHookStatus(s, busy ? 'busy' : 'idle', ts);
    clearNeedsYou(s);
    if (busy) {
      if (type !== 'user_message') startTurn(s, ts);
      return;
    }
    const aborted = type === 'turn_aborted';
    finishTurn(s, ts, !aborted);
    if (ts >= hudStartedAt - 2000) {
      pushFeed(s, aborted ? 'session' : 'done', aborted ? 'Codex turn interrupted' : 'Codex turn complete', ts,
        `codex-stop:${s.id}:${ts}`, aborted ? null : 'turn-finished');
    }
  }


  function endSilentCodex(s, last, now) {
    if (!s.ended && last && now - last > SILENT_SESSION_MS) endSession(s, last, 'no recent Codex activity');
  }

  function reconcileRegistry(rows) {
    const seen = new Set();
    for (const row of rows) {
      const { root, pid, procStart, actualStart } = row;
      seen.add(row.sessionId);
      const s = getSession(row.sessionId);
      const isNew = !s.inRegistry;
      s.inRegistry = true;
      s.root = root;
      // The session may resume in a new process, including one that reused its previous PID.
      const processChanged = s.pid !== pid || (procStart && actualStart && s.procStart && s.procStart !== procStart);
      const relaunched = s.ended && processChanged && pidAlive(pid);
      s.pid = pid;
      s.procStart = procStart;
      if (typeof row.cwd === 'string') setCwd(s, row.cwd);
      if (typeof row.name === 'string' && row.name) s.name = row.name;
      if (typeof row.entrypoint === 'string') s.entrypoint = row.entrypoint;
      if (typeof row.version === 'string') s.version = row.version;
      if (typeof row.kind === 'string') s.kind = row.kind;
      if (num(row.startedAt)) s.startedAt = row.startedAt;
      if (row.status === 'busy' || row.status === 'idle') {
        const at = num(row.statusUpdatedAt) || num(row.updatedAt) || Date.now();
        if (at >= s.regStatusAt) { s.regStatus = row.status; s.regStatusAt = at; }
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
    for (const s of listSessions()) {
      if (s.inRegistry && !seen.has(s.id)) { s.resumeAt = 0; if (!s.ended) endSession(s, Date.now(), 'closed'); }
    }
    scheduleState();
  }

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
    processLookup.readParentPids((error, parent) => {
      if (lifetime.signal.aborted) return;
      if (error) {
        if (!retry) { for (const s of batch) chainQueue.add(s); lifetime.timeout(() => runChain(true), 5000); }
        else for (const s of batch) s.chainChecked = true;
        return;
      }
      const byPid = new Map();
      for (const x of listSessions()) if (x.pid && !x.ended) byPid.set(x.pid, x);
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

  function setNeedsYou(s, reason, kind, at, agentId) {
    const first = markNeedsYou(s, reason, kind, at, agentId);
    if (first && !s.ended && at >= hudStartedAt) void sendPhonePush(s, kind);
  }

  function feedTool(s, sub, id, name, summary, at) {
    const who = sub ? `${sub.type || 'agent'} › ` : '';
    if (AGENT_TOOLS.has(name)) pushFeed(s, 'agent', `${who}Agent started · ${summary}`, at, id ? `tool:${id}` : null);
    else pushFeed(s, 'tool', `${who}${name}${summary ? ` · ${summary}` : ''}`, at, id ? `tool:${id}` : null);
  }

  function poll() {
    const now = Date.now();
    registry.scan();
    codex.scan();
    for (const s of listSessions()) {
      // Keep Codex tails attached across idle expiry so appending to an old rollout reopens its session.
      if (s.agent === 'codex') {
        if (s.tail) reader.read(s.tail);
        endSilentCodex(s, lastActivity(s), now);
        continue;
      }
      if (s.ended && now - s.endedAt > ENDED_KEEP_MS) { dropSession(s); continue; }
      if (!s.tail) attachSessionTranscript(s);
      if (s.ended) continue;
      if (s.tail) reader.read(s.tail);
      const last = lastActivity(s);
      if (!s.inRegistry && last && now - last > SILENT_SESSION_MS) { endSession(s, last, null); continue; }
      const idle = sessionStatus(s, now) === 'idle';
      for (const sub of s.subs) {
        if (sub.state !== 'running') continue;
        if (sub.tail) reader.read(sub.tail);
        const silentAt = silentSubagentAt(s, sub, now, idle);
        if (silentAt !== null) closeSub(s, sub, silentAt);
      }
    }
    for (const [key, r] of roots) {
      if (![...listSessions()].some(s => s.project === r.project)) dropRoot(key);
      else if (now - r.lastScanAt >= PLAN_POLL_MS) scanRoot(key);
    }
    scheduleState();
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
    const s = findSession(w.sessionId);
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
      const s = findSession(x.id), info = s?.tail?.info;
      out.push({ key: x.id, parent: x.startedBy || null, sessionId: x.id, agentId: null, view: x, project: x.project,
        label: x.title, refs: info?.refs, touched: mergeTouched(info?.touched, s?.touched), branch: x.branch,
        active: x.status === 'busy' || x.status === 'needs-you' });
      for (const a of x.subagents || []) {
        const sub = s && (s.byAgent.get(a.id) || s.byToolUse.get(a.id));
        const own = sub ? sub.tail?.info : findSession(a.id)?.tail?.info;   // or a Codex child session drawn as a subagent
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
    const list = codexTree([...listSessions()]
      .filter(s => (s.shown || s.agent === 'codex') && !endedLongAgo(s, now) && (s.inRegistry || s.tail || s.lastHookAt))
      .map(s => sessionView(s, now, cwd => rootFor(cwd).project))
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.lastActivityAt || 0) - (a.lastActivityAt || 0)), findSession);
    const today = dayKey(now);
    const tokensToday = zero();
    for (const t of reader.values()) { const d = t.info.byDay.get(today); if (d) addTokens(tokensToday, d); }
    // Plans carry when their board last changed and their last state changes (history). Nothing in a plan changes with a
    // session, so the stream sends plans only when a board changes (hud-0-3 P3); what links sessions to boards is in
    // `board`, which goes with every state.
    const planList = [...plans.values()].map(v => ({ ...v.plan, touchedAt: Math.round(v.mtime), history: planHistory.get(planKeyOf(v.plan)) || [] }))
      .sort((a, b) => a.project.localeCompare(b.project) || a.title.localeCompare(b.title));
    const { board, turnedOn } = followBoards(liveAgents(list), planList, { now, track: boardTrack });
    announceMarks(turnedOn, now);
    const alerts = alertsFor(list, account, now, liveAlerts, x => currentSessionTool(findSession(x.id), now));
    return {
      now, uptime: now - hudStartedAt, demo: false, version: VERSION, host: HOSTNAME, hooksInstalled,
      codex: codex.monitoring(),
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
      const t = { info: createTranscriptInfo(), owner: null };
      for (const l of lines) claude.processLine(t, JSON.stringify(l));
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

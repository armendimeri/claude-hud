import path from 'node:path';
import { createRuntime } from './runtime.mjs';
import { createPhonePush } from './phone-push.mjs';
import { projectSnapshot, publicSessions } from './publish.mjs';
import { autoInstall, isOurHook } from '../cli/hook-settings.mjs';
import { num } from '../domain/models.mjs';
import { ENDED_KEEP_MS, SILENT_SESSION_MS, STARTUP_MS, clearNeedsYou, createSessions, createTranscriptInfo, finishTurn, lastActivity, markNeedsYou, sessionStatus, setHookStatus, startTurn } from '../domain/sessions.mjs';
import { createSubagents, silentSubagentAt } from '../domain/subagents.mjs';
import { createToolSummary, currentSessionTool, isObj, str } from '../domain/tools.mjs';
import { createWindowsProcessLookup, pidAlive } from '../platform/windows-process.mjs';
import { createClaudeRegistry } from '../sources/claude-registry.mjs';
import { createClaudeTranscripts } from '../sources/claude-transcripts.mjs';
import { createCodexRollouts } from '../sources/codex-rollouts.mjs';
import { createHookHandler, createHookSource } from '../sources/hooks.mjs';
import { createTailReader } from '../sources/tail-reader.mjs';
import { createProjectSource, projectsView } from '../sources/projects.mjs';
import { createPlanFiles } from '../sources/plan-files.mjs';
import { createAccountSource } from '../sources/account.mjs';
import { createExternalUsageSource } from '../sources/external-usage.mjs';
import { parsePlanCandidate, selectPlanFiles } from '../domain/plan-parser.mjs';
import { PLAN_TOOLS, addPrompt, liveAgents, mergeTouched, noteTouched, promptRefs } from '../domain/board-links.mjs';
import { boardMarkText, createPlanState, followBoards } from '../domain/board-status.mjs';
import { createFeed } from '../domain/feed.mjs';
import { alertsFor } from '../domain/alerts.mjs';
import { accountView, createExternalUsage, dailyTokens } from '../domain/usage.mjs';

const POLL_MS = 3_000;

/** @param {{operator?: object}} [options]  overrides for the private operator service (tests, P11 integration). */
export function createLiveRuntime(config, options) {
  return createRuntime((lifetime, publisher, events) => createLiveEngine(config, lifetime, publisher, events), options);
}

// Compose live sources and domain state with the application publisher.
function createLiveEngine(config, lifetime, publisher, events) {
  const {
    hostname: HOSTNAME, unclaimedMs, stalledMs, bedrockRegion,
  } = config;
  const ROOTS = config.roots.map(root => ({ ...root, bedrock: false, hooks: false }));
  const CODEX_ROOTS = [...config.codexRoots];
  const { redact, redactDeep, appendFeed, invalidate: scheduleState } = publisher;

  function start() {
    hudStartedAt = Date.now();
    phonePush.start();
    events.on('needs-you', phonePush.onNeedsYou);
    if (!config.noAutoInstall) autoInstall(ROOTS);
    accountSource.start();
    registry.watch();
    claude.watch();
    void registry.scan().then(claude.scanRecentTranscripts);
    codex.watch();
    void codex.scan(true);
    lifetime.interval(poll, POLL_MS);
    externalUsageSource.start();
  }

  // =====================================================================================================================
  // Engine state

  let hudStartedAt;

  const { pushFeed, feedTool, forget, remember } = createFeed(appendFeed);
  const { rootFor, planFileKey } = createProjectSource();
  const boardTrack = new Map();
  const liveAlerts = new Map();
  const planState = createPlanState({ boardTrack, agentLabel, pushFeed, clock: Date.now });
  const planFiles = createPlanFiles({
    lifetime, parseCandidate: parsePlanCandidate,
    onScan(key, root, candidates) {
      planState.applyScan(key, root, selectPlanFiles(candidates));
      scheduleState();
    },
    onDrop: planState.dropRoot,
  });
  let account = null;
  let hooksInstalled = false;
  const accountSource = createAccountSource({
    roots: ROOTS, lifetime, isOurHook,
    onAccount(value) {
      account = accountView(value, Date.now());
      scheduleState();
    },
    onSettings(value) {
      hooksInstalled = value;
      scheduleState();
    },
  });
  const externalUsage = createExternalUsage(redact);
  const externalUsageSource = createExternalUsageSource({
    region: bedrockRegion, lifetime,
    onRows(rows) {
      externalUsage.replaceCloudWatch(rows);
      scheduleState();
    },
    onError(error) {
      externalUsage.setError(error);
      scheduleState();
    },
  });
  const phonePush = createPhonePush({ url: config.pushUrl, lifetime, redact, onChange: scheduleState });

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
    onReopen(s) { forget('end:' + s.id); },
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
    onEvent: createHookHandler({
      sessions, subagents, transcripts: claude, setCwd, isAlive: pidAlive, setNeedsYou,
      noteToolTouch: hookTouch, summarizeTool, feedTool, pushFeed, onChange: scheduleState,
    }),
  });

  function setCwd(s, cwd) {
    if (!cwd || s.cwd === cwd) return;
    s.cwd = cwd;
    const r = rootFor(cwd);
    s.project = r.project;
    planFiles.ensureRoot(r.root, r.project);
    if (r.mainRoot !== r.root) planFiles.ensureRoot(r.mainRoot, r.project);
  }

  // Source events are applied here before publication.
  function onClaudeTool(t, id, name, summary, file, ts) {
    if (PLAN_TOOLS.has(name) && file) {
      const key = planFileKey(file, t.info.cwd || t.owner?.session.cwd);
      if (key) {
        const at = ts || Date.now();
        noteTouched(t.info.touched, id, key, name !== 'Read', at);
        if (name !== 'Read') planState.noteWrite(key, t.owner?.session.id ?? t.info.sessionId, t.owner ? t.owner.agentId : t.info.agentId, at);
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
    if (first && !s.ended && at >= hudStartedAt) events.emit('needs-you', s, kind);
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
    planFiles.poll(new Set([...listSessions()].map(s => s.project)), now);
    scheduleState();
  }

  /** A Read, Edit, Write or MultiEdit hook on a plan file. PostToolUse moves the write's time to when it happened. */
  function hookTouch(s, sub, p, id, name, at) {
    if (!PLAN_TOOLS.has(name) || !isObj(p.tool_input)) return;
    const key = planFileKey(p.tool_input.file_path, str(p.cwd) || s.cwd);
    if (!key) return;
    noteTouched((sub || s).touched, id, key, name !== 'Read', at);
    if (name !== 'Read') planState.noteWrite(key, s.id, sub?.agentId ?? null, at);
  }
  /** Who wrote a board, for its "claimed by" line: a subagent's description, or a session's title. */
  function agentLabel(w) {
    const s = findSession(w.sessionId);
    if (!s) return null;
    if (w.agentId) { const sub = s.byAgent.get(w.agentId); return sub ? sub.description || sub.type || null : null; }
    return s.tail?.info.customTitle || s.tail?.info.title || s.name || null;
  }

  function updateSnapshot(now) {
    const list = publicSessions(listSessions(), now, cwd => rootFor(cwd).project, findSession);
    // Plan records are independent of session changes. The changing links go out with the board.
    const plans = planState.views();
    const { board, turnedOn } = followBoards(liveAgents(list, findSession), plans, {
      now, track: boardTrack, unclaimedMs, stalledMs, floor: hudStartedAt,
    });
    for (const mark of turnedOn) {
      const key = `mark:${mark.P.key}#${mark.node.id}:${mark.flag}`;
      if (now - hudStartedAt < STARTUP_MS) remember(key);
      else pushFeed({ id: null, project: mark.P.plan.project }, 'plan', boardMarkText(mark), now, key);
    }
    const alerts = alertsFor(list, account, now, liveAlerts, x => currentSessionTool(findSession(x.id), now));
    return projectSnapshot({
      now, startedAt: hudStartedAt, host: HOSTNAME, hooksInstalled, codex: codex.monitoring(),
      sessions: list, projects: projectsView(planFiles.roots()), plans, board, alerts, account,
      externalUsage: externalUsage.view(), push: phonePush.status, tokensToday: dailyTokens(reader.values(), now),
    });
  }

  return {
    start, update: updateSnapshot, ingestHook,
    reportUsage: config.acceptUsage ? value => externalUsage.report(value, Date.now()) : undefined,
    // Private operator access (operator-cockpit P8): the runtime builds it lazily on the first private request.
    // History resolves through this registry and reads only inside the configured transcript and rollout roots.
    operator: {
      kind: 'live', findSession, summarizeTool, operatorDir: config.operatorDir,
      roots: { claude: ROOTS.map(root => root.projects), codex: CODEX_ROOTS.map(dir => path.join(dir, 'sessions')) },
    },
  };
}

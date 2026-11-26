import { addTokens, contextFor, modelInfo, pulseView, rawModel, zero } from './models.mjs';
import { currentSessionTool, toolView, truncate } from './tools.mjs';
import { isPlaceholder, subView } from './subagents.mjs';

export function createTranscriptInfo() {
  return {
    title: null, customTitle: null, modelRaw: null, requestModel: null, bedrock: false, rootBedrock: false,
    effort: null, branch: null, cwd: null, sessionId: null, agentId: null,
    tokens: zero(), byDay: new Map(), byMinute: new Map(), msgs: new Map(), lastUsed: 0, firstTs: 0, lastTs: 0,
    toolIds: new Set(), openTools: new Map(), agentCalls: new Map(),
    refs: [], touched: [],        // hud-0-3 §4.2: ID-shaped words of each user prompt, and plan files read or written
  };
}

export const ENDED_KEEP_MS = 2 * 3600_000;      // D7

export const SILENT_SESSION_MS = 10 * 60_000;   // a session outside the registry counts as ended after this much silence
const SETTLE_MS = 8_000;                 // hud-0-3 D7: a session with no work yet is shown after this long
const SETTLE_WORK_MS = 60_000;           // work this long before the HUD first saw a session still counts as its first work
export const STARTUP_MS = 5_000;                // sessions found this soon after the HUD starts are shown at once

export function lastActivity(s) {
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
export function endedLongAgo(s, now) {
  return s.ended && now - Math.min(s.endedAt || 0, lastWork(s)) > ENDED_KEEP_MS;
}
export function sessionStatus(s, now) {
  if (s.ended) return 'ended';
  if (s.needsYou) return 'needs-you';
  if (s.hookStatus && s.hookStatusAt >= s.regStatusAt) return s.hookStatus;
  if (s.regStatus) return s.regStatus;
  const last = lastActivity(s);
  return last && now - last < 30_000 ? 'busy' : 'idle';
}

export function setHookStatus(s, status, at) {
  if (at >= s.hookStatusAt) { s.hookStatus = status; s.hookStatusAt = at; }
}
export function startTurn(s, at) {
  if (at > s.turnAt) { s.turn.startedAt = at; s.turnAt = at; }
}
export function finishTurn(s, at, completed = true) {
  if (!at || at < s.turnAt) return;
  if (completed && s.turn.startedAt != null) s.turn.lastMs = at - s.turn.startedAt;
  s.turn.startedAt = null;
  s.turnAt = at;
}
export function clearNeedsYou(s, agentId = undefined) {
  if (!s.needsYou) return;
  if (agentId !== undefined && s.needsYou.agentId !== agentId) return;
  s.needsYou = null;
}

export function markNeedsYou(s, reason, kind, at, agentId) {
  if (s.needsYou?.reason === reason) return false;
  const first = !s.needsYou;
  s.needsYou = { since: s.needsYou?.since ?? at, reason, kind, agentId: agentId ?? null };
  return first;
}

export function sessionView(s, now, projectForCwd) {
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
    id: s.id, agent: s.agent, pid: s.pid, project: s.project || (info?.cwd ? projectForCwd(info.cwd) : null), cwd: s.cwd || info?.cwd || null,
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

export function codexTree(list, findSession) {
  const byId = new Map(list.map(s => [s.id, s]));
  const hidden = new Set();
  for (const child of list) {
    const source = findSession(child.id);
    if (source?.codexInternal) { hidden.add(child.id); continue; }
    let parentId = source?.codexParent, root = null, depth = 0;
    const seen = new Set([child.id]);
    while (parentId && byId.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId); root = byId.get(parentId); depth++;
      parentId = findSession(parentId)?.codexParent;
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

export function createSessions({ startedAt, timeout, isAlive, pushFeed, closeSub, onChange, onResume, onReopen }) {
  const sessions = new Map();

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
      if (s.seenAt - startedAt() < STARTUP_MS) s.shown = true;
      else timeout(() => settle(s), SETTLE_MS + 20);
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
      const alive = !s.inRegistry || isAlive(s.pid);
      if (!s.ended || !alive) s.resumeAt = 0;
      else if (worked || now - s.resumeAt >= SETTLE_MS || workedSince(s, s.resumeAt)) {
        const at = s.resumeAt;
        s.resumeAt = 0;
        reopenSession(s);
        onResume(s);
        s.pendingLine = null;
        if (s.shown) pushFeed(s, 'session', 'Session resumed', at, `resume:${s.id}:${at}`);
        else s.pendingLine = { text: 'Session resumed', at, key: `resume:${s.id}:${at}` };
        onChange();
      }
    }
    if (s.shown || s.ended) return;      // a session that ended before it was shown stays hidden
    if (!worked && now - s.seenAt < SETTLE_MS && !workedSince(s, s.seenAt)) return;
    s.shown = true;
    const line = s.pendingLine;
    s.pendingLine = null;
    if (line) pushFeed(s, 'session', line.text, line.at, line.key);
    onChange();
  }
  /** An ended session asks to run again (a new process, or a SessionStart hook): it reopens once it settles. */
  function askResume(s, at) {
    if (!s.ended) return;
    if (!s.resumeAt) { s.resumeAt = at; timeout(() => settle(s), Math.max(0, at + SETTLE_MS + 20 - Date.now())); }
    settle(s);
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
    if (s.shown && at >= startedAt() - 2000) pushFeed(s, 'session', `Session ended${reason ? ` (${reason})` : ''}`, at, `end:${s.id}`);
    onChange();
  }
  function reopenSession(s) {
    s.ended = false; s.endedAt = null; s.endReason = null;
    onReopen(s);
  }

  function dropSession(s) {
    if (s.tail) s.tail.owner = null;
    for (const sub of s.subs) if (sub.tail) sub.tail.owner = null;
    sessions.delete(s.id);
  }

  return { getSession, findSession: id => sessions.get(id), listSessions: () => sessions.values(),
    settle, askResume, sessionLine, endSession, reopenSession, dropSession };
}

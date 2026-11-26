import fs from 'node:fs';
import { num } from '../domain/models.mjs';
import { clearNeedsYou, finishTurn, setHookStatus, startTurn } from '../domain/sessions.mjs';
import { subForToolUse } from '../domain/subagents.mjs';
import { AGENT_TOOLS, NEEDS_INPUT_TOOLS, isObj, oneLine, runsInBackground, str } from '../domain/tools.mjs';

const REOPEN_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse']);

function capSet(set, max) { while (set.size > max) set.delete(set.values().next().value); }

export function notificationReason(type, msg) {
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

export function createHookSource({ recordFile, redactDeep, onEvent }) {
  return function ingestHook(value) {
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
    if (recordFile) {
      try { fs.appendFileSync(recordFile, JSON.stringify(redactDeep(payload)) + '\n'); }
      catch (error) { console.error(`HUD_RECORD: ${error.message}`); }
    }
    onEvent?.(payload);
    return [204, ''];
  };
}

/** Apply Claude hook events to the session lifecycle in arrival order. */
export function createHookHandler({ sessions, subagents, transcripts, setCwd, isAlive, setNeedsYou,
  noteToolTouch, summarizeTool, feedTool, pushFeed, onChange }) {
  const { getSession, settle, askResume, reopenSession, endSession, sessionLine } = sessions;
  const { subForAgent, assignAgentId, closeSub } = subagents;
  const { attachSessionTranscript, attachSubTailIfPresent } = transcripts;

  return function onHook(p) {
    if (!isObj(p) || typeof p.session_id !== 'string' || !p.session_id) return;
    const now = Date.now();
    const at = Math.min(num(p.hud_at) || now, now);
    const ev = str(p.hook_event_name);
    const s = getSession(p.session_id);
    if (s.ended) {
      // Only new work reopens a session (a resume, or activity after a silence). Async hooks of a session that is
      // exiting (Stop, PostToolUse, SessionEnd) can arrive after its registry file is gone: they change nothing.
      if (!REOPEN_EVENTS.has(ev) || at <= (s.endedAt || 0) || (s.inRegistry && !isAlive(s.pid))) return;
      // A SessionStart is not work: the session reopens once it works or has run for SETTLE_MS (D7).
      if (ev === 'SessionStart') { if (typeof p.model === 'string') s.hookModel = p.model; askResume(s, at); onChange(); return; }
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
        noteToolTouch(s, sub, p, id, name, at);
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
        if (ev === 'PostToolUse') noteToolTouch(s, sub, p, id, name, at);   // the write has happened: its time is now
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
          if (typeof p.agent_transcript_path === 'string') attachSubTailIfPresent(s, sub, p.agent_transcript_path);
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
    onChange();
  };
}

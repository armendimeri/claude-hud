import { contextFor, modelInfo, pulseView, rawModel, zero } from './models.mjs';
import { isObj, latestOpenTool, runsInBackground, str, toolView } from './tools.mjs';

function newSub(s) {
  const sub = { agentId: null, toolUseId: null, parentKey: s.id, depth: null, description: null, type: null, modelHint: null,
    background: false, state: 'running', startedAt: null, endedAt: null, tail: null, currentTool: null, lastHookAt: 0, startedByHook: false,
    refs: null, touched: [] };   // hud-0-3 §4.2: the words of its Agent call's prompt; plan files from its hooks
  s.subs.add(sub);
  return sub;
}
export function subForToolUse(s, toolUseId) {
  let sub = s.byToolUse.get(toolUseId);
  if (!sub) { sub = newSub(s); sub.toolUseId = toolUseId; s.byToolUse.set(toolUseId, sub); }
  return sub;
}

/**
 * A subagent only a hook has named (an agent_id, no agent_type, no Agent call, no transcript, no meta.json yet) is a
 * placeholder: it is not shown and writes no feed line (hud-0-3 D7). It stays in `s.subs`, so a meta.json or an Agent
 * call that arrives later still completes it.
 */
export function isPlaceholder(sub) { return !sub.toolUseId && !sub.tail && !sub.type && !sub.description; }

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
// A confirmed worker can be silent while its parent waits for it to finish.
export function silentSubagentAt(s, sub, now, idle) {
  if (sub.startedByHook) return null;
  const last = subLastActivity(sub);
  const parentMovedOn = (s.tail?.info.lastTs || 0) > last || s.lastHookAt > last;
  return now - last > 120_000 && (idle || (sub.background && parentMovedOn)) ? last : null;
}

export function subView(s, sub, now) {
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

export function createSubagents({ mergeTouched, onAssign, promptRefs, startedAt, pushFeed }) {
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
    onAssign(s, sub, agentId);
    return sub;
  }

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

  function closeSub(s, sub, at = Date.now()) {
    if (sub.state === 'done') return;
    sub.state = 'done';
    sub.endedAt = at;
    sub.currentTool = null;
    if (at >= startedAt() - 2000 && !isPlaceholder(sub)) {
      pushFeed(s, 'done', `Agent done · ${[sub.type, sub.description].filter(Boolean).join(': ')}`, at,
        `done:${sub.toolUseId || sub.agentId}`, 'agent-done');
    }
  }

  function applyMetadata(s, agentId, meta) {
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
    return sub;
  }

  function findOrAssign(s, agentId) {
    return s.byAgent.get(agentId) || assignAgentId(s, newSub(s), agentId);
  }

  return { applyMetadata, findOrAssign, subForAgent, assignAgentId, onAgentCall, onAgentResult, replayAgentCalls, closeSub };
}

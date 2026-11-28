// Store projection for the cockpit scene (P2): public snapshot -> the entities, groups and links the scene draws.
// No DOM and no Three.js. The scene draws what this returns and compares two results with `diffModels`, so a changing
// server clock never counts as a change.
import { shownSessions, viewStatus } from '../components/sessions.mjs';

export const FINISHED_MS = 90_000;
export const KEEP_FINISHED = 3;
export const COLLAPSE_IDLE_AT = 2;

/** Opaque, exact key of one session or subagent. Compare keys, never split them. */
export const entityKey = (sessionId, agentId = null) => JSON.stringify([sessionId, agentId]);

// Visible state word per scene state. Wording follows the design study (SPEC.md).
export const STATE = Object.freeze({
  'needs-you': { word: 'Needs you', glyph: 'needs', color: 'alert', prio: 1 },
  working: { word: 'Working', glyph: 'busy', color: 'amber', prio: 5 },
  agents: { word: 'Agents working', glyph: 'running', color: 'agent', prio: 5 },
  done: { word: 'Done', glyph: 'done', color: 'ok', prio: 3 },
  idle: { word: 'Idle', glyph: 'idle', color: 'arc', prio: 6 },
  ended: { word: 'Ended', glyph: 'ended', color: 'dim', prio: 7 },
  sub: { word: 'Working', glyph: 'busy', color: 'agent', prio: 4 },
  'sub-done': { word: 'Done', glyph: 'done', color: 'ok', prio: 4 },
  sat: { word: 'Idle', glyph: 'idle', color: 'arc', prio: 99 },
});

const toolText = tool => tool ? [tool.name, tool.summary].filter(Boolean).join(' · ') : null;

function sessionState(session, now) {
  const view = viewStatus(session);
  if (view === 'needs-you') return 'needs-you';
  if (view === 'busy') return 'working';
  if (view === 'agents') return 'agents';
  if (view === 'ended') return session.endedAt && now - session.endedAt < FINISHED_MS ? 'done' : 'ended';
  return 'idle';
}

/**
 * Project a public snapshot.
 * options: {expanded: Set<string>, project: string|null, now?: number}
 *   expanded  keys of satellites the operator expanded, and project names kept fully open
 *   project   the project the cockpit is scoped to (it is shown open, others are hidden from `visible`)
 */
export function projectSnapshot(snapshot, { expanded = new Set(), project = null, now = snapshot?.now ?? 0 } = {}) {
  const sessions = snapshot ? shownSessions(snapshot.sessions || [], now) : [];
  const entities = [];
  const byKey = new Map();
  const add = e => { if (!byKey.has(e.key)) { byKey.set(e.key, e); entities.push(e); } return byKey.get(e.key); };

  const idleByProject = new Map();
  for (const s of sessions) {
    const state = sessionState(s, now);
    const groupKey = s.project || 'Unknown';
    const idleLike = state === 'idle' && !(s.subagents || []).length;
    const open = expanded.has('project:' + groupKey) || project === groupKey;
    if (idleLike && !open) {
      if (!idleByProject.has(groupKey)) idleByProject.set(groupKey, []);
      idleByProject.get(groupKey).push(s);
      continue;
    }
    add({
      key: entityKey(s.id), kind: 'session', selection: { sessionId: s.id, agentId: null }, groupKey, parentKey: null,
      sortKey: s.startedAt || 0, state, title: s.title || s.project || 'Session', project: groupKey,
      provider: s.provider || null, tool: toolText(s.currentTool), since: s.needsYou?.since ?? s.currentTool?.since ?? null,
      reason: s.needsYou?.reason || null, askKind: s.needsYou?.kind || null, startedBy: s.startedBy || null,
      endedAt: s.endedAt || null, sessionId: s.id, agentId: null,
    });
  }
  // A collapsed project folds its idle sessions into one satellite when there are enough of them.
  for (const [groupKey, list] of idleByProject) {
    if (list.length < COLLAPSE_IDLE_AT) {
      for (const s of list) add({
        key: entityKey(s.id), kind: 'session', selection: { sessionId: s.id, agentId: null }, groupKey, parentKey: null,
        sortKey: s.startedAt || 0, state: 'idle', title: s.title || s.project || 'Session', project: groupKey,
        provider: s.provider || null, tool: null, since: null, reason: null, askKind: null, startedBy: s.startedBy || null,
        endedAt: null, sessionId: s.id, agentId: null,
      });
      continue;
    }
    add({
      key: 'sat:idle:' + groupKey, kind: 'sat', selection: null, groupKey, parentKey: null, sortKey: Infinity,
      state: 'sat', title: `${list.length} idle sessions`, project: groupKey, provider: null, tool: null, since: null,
      reason: null, askKind: null, startedBy: null, endedAt: null, count: list.length, folds: 'idle',
      sessionId: null, agentId: null,
    });
  }

  // Subagents of the sessions that are drawn.
  const drawn = new Set(entities.filter(e => e.kind === 'session').map(e => e.sessionId));
  const subs = [];
  for (const s of sessions) {
    if (!drawn.has(s.id)) continue;
    const ids = new Set((s.subagents || []).map(a => a.id));
    for (const a of s.subagents || []) {
      const parentKey = a.parentId && a.parentId !== a.id && ids.has(a.parentId) ? entityKey(s.id, a.parentId) : entityKey(s.id);
      subs.push({
        key: entityKey(s.id, a.id), kind: 'sub', selection: { sessionId: s.id, agentId: a.id }, groupKey: s.project || 'Unknown',
        parentKey, sortKey: a.startedAt || 0, state: a.state === 'done' ? 'sub-done' : 'sub',
        title: [a.type, a.description].filter(Boolean).join(': ') || 'Subagent', project: s.project || 'Unknown',
        provider: a.provider || null, tool: toolText(a.currentTool), since: a.currentTool?.since ?? null, reason: null,
        askKind: null, startedBy: null, endedAt: a.endedAt || null, sessionId: s.id, agentId: a.id,
      });
    }
  }
  // Finished subagents beyond the newest few fold into a satellite on their parent (every one above 40 nodes).
  const kids = new Map();
  for (const e of subs) { if (!kids.has(e.parentKey)) kids.set(e.parentKey, []); kids.get(e.parentKey).push(e); }
  const allDone = key => (kids.get(key) || []).every(k => k.state === 'sub-done' && allDone(k.key));
  const keep = entities.length + subs.length > 40 ? 0 : KEEP_FINISHED;
  const dropped = new Set(), folded = [];
  for (const parent of [...entities.filter(e => e.kind === 'session'), ...subs]) {
    if (dropped.has(parent.key)) continue;
    const satKey = 'sat:done:' + parent.key;
    const done = (kids.get(parent.key) || []).filter(k => k.state === 'sub-done' && allDone(k.key))
      .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
    const fold = done.slice(keep);
    if (fold.length < 2 || expanded.has(satKey)) continue;
    let count = 0;
    const mark = k => { dropped.add(k.key); count++; for (const kk of kids.get(k.key) || []) mark(kk); };
    fold.forEach(mark);
    folded.push({
      key: satKey, kind: 'sat', selection: null, groupKey: parent.groupKey, parentKey: parent.key, sortKey: Infinity,
      state: 'sat', title: `${count} finished subagents`, project: parent.groupKey, provider: null, tool: null, since: null,
      reason: null, askKind: null, startedBy: null, endedAt: null, count, folds: 'done', sessionId: null, agentId: null,
    });
  }
  for (const e of subs) if (!dropped.has(e.key)) add(e);
  for (const sat of folded) if (!dropped.has(sat.parentKey)) add(sat);

  // Links: delegation (parent to subagent or folded group) and shell linkage (a session launched by another).
  const links = [];
  for (const e of entities) {
    if (e.parentKey && byKey.has(e.parentKey)) links.push({ key: 'd:' + e.key, kind: 'delegation', from: e.parentKey, to: e.key });
    if (e.kind === 'session' && e.startedBy) {
      const from = entityKey(e.startedBy);
      if (byKey.has(from) && from !== e.key) links.push({ key: 'l:' + e.key, kind: 'shell', from, to: e.key });
    }
  }

  // Stable reading order: project, then start order; a child follows its parent; a satellite closes its project.
  const children = new Map();
  for (const e of entities) if (e.parentKey && byKey.has(e.parentKey)) {
    if (!children.has(e.parentKey)) children.set(e.parentKey, []);
    children.get(e.parentKey).push(e);
  }
  const cmp = (a, b) => (a.sortKey === b.sortKey ? 0 : a.sortKey < b.sortKey ? -1 : 1) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const groupNames = [...new Set(entities.map(e => e.groupKey))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const order = [];
  const walk = e => { order.push(e.key); for (const c of (children.get(e.key) || []).slice().sort(cmp)) walk(c); };
  const groups = groupNames.map(name => {
    const members = entities.filter(e => e.groupKey === name);
    const roots = members.filter(e => !e.parentKey || !byKey.has(e.parentKey)).sort(cmp);
    for (const root of roots) walk(root);
    const live = members.filter(e => e.kind === 'session' || e.kind === 'sat' && e.folds === 'idle');
    return {
      key: name, name, sessions: members.filter(e => e.kind === 'session').length,
      idleFolded: members.filter(e => e.kind === 'sat' && e.folds === 'idle').reduce((n, e) => n + e.count, 0),
      waiting: members.filter(e => e.state === 'needs-you').length,
      working: members.filter(e => e.state === 'working' || e.state === 'agents').length, total: live.length,
    };
  });
  const scoped = project ? new Set(entities.filter(e => e.groupKey === project).map(e => e.key)) : null;
  const visible = scoped ? order.filter(key => scoped.has(key)) : order.slice();
  return { entities, byKey, groups, links, order, visible, project };
}

/** The properties of one entity that change what is drawn or said. Excludes the clock and timers. */
export function entitySignature(e) {
  return [e.kind, e.state, e.title, e.tool, e.reason, e.askKind, e.provider, e.parentKey, e.groupKey, e.count ?? '', e.since ?? ''].join('\u0001');
}

/** Compare two projections. `layout`: the set or relationships changed; `visual`: a state changed; `text`: a label changed. */
export function diffModels(a, b) {
  const result = { layout: false, visual: false, text: false, changed: false };
  if (!a) return { layout: true, visual: true, text: true, changed: true };
  const keysA = a.entities.map(e => e.key).join('\u0002'), keysB = b.entities.map(e => e.key).join('\u0002');
  if (keysA !== keysB || a.project !== b.project) result.layout = true;
  for (const e of b.entities) {
    const old = a.byKey.get(e.key);
    if (!old) continue;
    if (old.parentKey !== e.parentKey || old.groupKey !== e.groupKey || old.kind !== e.kind) result.layout = true;
    if (old.state !== e.state || old.count !== e.count) result.visual = true;
    if (old.title !== e.title || old.tool !== e.tool || old.reason !== e.reason || old.provider !== e.provider || old.since !== e.since) result.text = true;
  }
  const linkSig = m => m.links.map(l => l.key + '>' + l.from).join('\u0002');
  if (linkSig(a) !== linkSig(b)) result.layout = true;
  result.changed = result.layout || result.visual || result.text;
  return result;
}

/** Accessible name of an entity: the same string drives the list row, the label and the node. */
export function accessibleName(e, alias = null) {
  const state = STATE[e.state] || STATE.idle;
  if (alias) return `${alias.group}, ${alias.entity}, ${state.word.toLowerCase()}${e.state === 'needs-you' ? ', waiting for you' : ''}`;
  if (e.kind === 'sat') return `${e.project}, ${e.title}, folded. Press Enter to expand`;
  const detail = e.state === 'needs-you' ? `, waiting${e.askKind === 'question' ? ' for an answer' : ''}` : e.tool ? `, ${e.tool}` : '';
  return `${e.project}, ${e.title}, ${state.word.toLowerCase()}${detail}${e.kind === 'sub' ? ', subagent' : ''}`;
}

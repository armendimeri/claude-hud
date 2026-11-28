import fs from 'node:fs';
import path from 'node:path';

// Private entity resolution (operator-cockpit P8, CONTRACTS "Selection and information boundaries" 1-3).
//
// A selection {sessionId, agentId} becomes a trusted server-side record only through the live engine registry:
// - the session must be in the current public snapshot (the same set of sessions the dashboard shows), and an agent
//   must be one of that session's published subagents;
// - a Claude subagent resolves through both of its known aliases (agent id and Agent tool-use id) on the same parent;
//   two different subagents claiming one alias are a conflict, and a subagent without its own transcript never falls
//   back to the parent's file;
// - a Codex child folded under a root must have a recorded ancestor chain that reaches that root;
// - two profiles holding a transcript for the same Claude session make history ambiguous (openHistorySource refuses).
// The resolver never opens files. It returns paths for openHistorySource and a target for capabilities and actions.

const MAX_ID = 1024;
const MAX_CODEX_DEPTH = 8;

export function validSelection(value) {
  return !!value && typeof value === 'object' && typeof value.sessionId === 'string' && !!value.sessionId
    && value.sessionId.length <= MAX_ID
    && (value.agentId === null || (typeof value.agentId === 'string' && !!value.agentId && value.agentId.length <= MAX_ID));
}

/** Transcript format for a target provider (CONTRACTS "History clarifications accepted with P4"). */
export const formatFor = provider => provider === 'openai' ? 'codex' : provider === 'anthropic' || provider === 'bedrock' ? 'claude' : null;

class Unresolved extends Error {
  constructor(reason) { super(reason); this.name = 'Unresolved'; this.reason = reason; }
}

function published(snapshot, { sessionId, agentId }) {
  const session = snapshot?.sessions?.find(s => s.id === sessionId);
  if (!session) throw new Unresolved('not published');
  return { session, agentIds: new Set((session.subagents || []).map(a => a.id)), wanted: agentId };
}

/**
 * @param {{findSession: (id: string) => object|undefined, readSnapshot: () => object,
 *   claudeProjects: string[]}} options  claudeProjects are the configured `projects` folders of every Claude profile.
 */
export function createLiveResolver({ findSession, readSnapshot, claudeProjects = [] }) {
  function claudeSessionFiles(s) {
    const file = s.tail?.file || s.transcriptPath;
    if (!file || s.tail?.owner?.session !== s) throw new Unresolved('no transcript');
    // Another profile with a transcript of the same name for this session makes the source ambiguous.
    const folder = path.basename(path.dirname(file)), name = path.basename(file);
    const others = claudeProjects.map(projects => path.join(projects, folder, name)).filter(other => other !== file && fs.existsSync(other));
    return [file, ...others];
  }

  function resolveClaude(s, view, selection) {
    const provider = view.session.provider === 'bedrock' ? 'bedrock' : 'anthropic';
    if (selection.agentId === null) {
      return {
        record: { provider: 'claude', files: claudeSessionFiles(s), native: { sessionId: s.id, agentId: null }, cwd: s.cwd ?? null },
        target: { selection, provider, nativeSessionId: s.id, connectionGeneration: null },
      };
    }
    const byAgent = s.byAgent.get(selection.agentId), byTool = s.byToolUse.get(selection.agentId);
    if (byAgent && byTool && byAgent !== byTool) throw new Unresolved('alias conflict');
    const sub = byAgent || byTool;
    if (!sub || !s.subs.has(sub)) throw new Unresolved('unknown agent');
    if (!view.agentIds.has(sub.agentId || sub.toolUseId)) throw new Unresolved('agent not published');
    const file = sub.tail?.file;
    if (!sub.agentId || !file || sub.tail.owner?.session !== s) throw new Unresolved('no agent transcript');
    // The file must be this agent's own transcript, never the parent's or a sibling's.
    if (path.basename(file).toLowerCase() !== `agent-${sub.agentId}.jsonl`.toLowerCase()) throw new Unresolved('agent file mismatch');
    return {
      record: { provider: 'claude', files: [file], native: { sessionId: s.id, agentId: sub.agentId }, cwd: s.cwd ?? null },
      target: { selection, provider, nativeSessionId: s.id, nativeAgentId: sub.agentId, connectionGeneration: null },
    };
  }

  function resolveCodex(root, view, selection) {
    let s = root;
    if (selection.agentId !== null) {
      if (!view.agentIds.has(selection.agentId)) throw new Unresolved('agent not published');
      s = findSession(selection.agentId);
      if (!s || s.agent !== 'codex' || s.codexInternal) throw new Unresolved('unknown child');
      // Validate the recorded ancestor chain up to the selected root before opening the child's own rollout.
      let parentId = s.codexParent, depth = 0;
      const seen = new Set([s.id]);
      while (parentId !== root.id) {
        if (!parentId || seen.has(parentId) || ++depth > MAX_CODEX_DEPTH) throw new Unresolved('ancestor chain');
        seen.add(parentId);
        const ancestor = findSession(parentId);
        if (!ancestor || ancestor.agent !== 'codex') throw new Unresolved('ancestor chain');
        parentId = ancestor.codexParent;
      }
    }
    const file = s.tail?.file || s.transcriptPath;
    if (!file || s.tail?.owner?.session !== s) throw new Unresolved('no rollout');
    return {
      record: { provider: 'codex', files: [file], native: { sessionId: s.id, agentId: null }, cwd: s.cwd ?? null },
      target: { selection, provider: 'openai', nativeSessionId: s.id.replace(/^codex:/, ''), connectionGeneration: null },
    };
  }

  /** @returns {{record: object, target: object}|null}  null when the selection is unknown or ambiguous. */
  function resolve(selection) {
    if (!validSelection(selection)) return null;
    try {
      const view = published(readSnapshot(), selection);
      const s = findSession(selection.sessionId);
      if (!s) return null;
      const resolved = s.agent === 'codex' ? resolveCodex(s, view, selection) : resolveClaude(s, view, selection);
      return formatFor(resolved.target.provider) === resolved.record.provider ? resolved : null;
    } catch (error) {
      if (error instanceof Unresolved) return null;
      throw error;
    }
  }

  return { resolve };
}

/**
 * The demo engine's resolver: synthetic records only, never a file path. History is generated from the session's
 * public fields, so a demo can show the panel even when real profile folders exist on this PC.
 */
export function createDemoResolver({ readSnapshot }) {
  function resolve(selection) {
    if (!validSelection(selection)) return null;
    let view;
    try { view = published(readSnapshot(), selection); } catch { return null; }
    if (selection.agentId !== null && !view.agentIds.has(selection.agentId)) return null;
    const agent = selection.agentId === null ? view.session : view.session.subagents.find(a => a.id === selection.agentId);
    const provider = view.session.agent === 'codex' ? 'openai' : view.session.provider === 'bedrock' ? 'bedrock' : 'anthropic';
    return {
      record: { provider: formatFor(provider), synthetic: { title: agent.title || agent.description || 'Demo session', tool: agent.currentTool }, files: [] },
      target: { selection, provider, nativeSessionId: null, connectionGeneration: null },
    };
  }
  return { resolve };
}

import { isObj, str } from '../../domain/tools.mjs';

// Codex rollout records -> visible history (CONTRACTS "History and capability wire examples").
//
// Canonical family: `event_msg` user_message and agent_message carry what the user saw. The same turn is also recorded
// as `response_item` message records, and those additionally hold developer/system instructions and injected
// context (environment, AGENTS.md) under role "user". Response-item messages are therefore never shown; they are
// counted so a window that has them but no canonical event can be reported as an unknown format.
// Shown: user_message and agent_message text, plus one redacted summary per function_call / custom_tool_call /
// local_shell_call / web_search_call. Hidden: reasoning, every tool output, session_meta, turn_context, token
// records and all other event_msg kinds (status events). A `compacted` record is a "compacted" gap; an unknown record
// type or response_item kind is an "unknown" gap.
//
// Merge precedence: tool calls fold by call_id (first occurrence wins). Event messages carry no stable id and are never
// folded, so two consecutive identical prompts stay distinct.

const HIDDEN_TOP = new Set(['session_meta', 'turn_context', 'token_usage_record']);
const HIDDEN_ITEMS = new Set(['reasoning', 'function_call_output', 'custom_tool_call_output', 'local_shell_call_output',
  'ghost_snapshot', 'compaction', 'compaction_summary', 'image_generation_call', 'tool_search_call', 'tool_search_output']);
const HIDDEN = { entries: [] };
const UNKNOWN = { entries: [], gap: 'unknown' };

const toolName = name => str(name).replace(/^(?:functions|tools|collaboration)\./, '');

function toolEntry(name, input, at, key, { cwd, summarizeTool }) {
  const summary = summarizeTool(name, input, cwd || '');
  return { entries: [{ kind: 'tool', text: summary ? name + ' · ' + summary : name, at, key }] };
}

export function classifyCodex(line, ctx) {
  let j;
  try { j = JSON.parse(line); } catch { return { entries: [], gap: 'malformed' }; }
  if (!isObj(j) || typeof j.type !== 'string') return UNKNOWN;
  const p = j.payload;
  const at = Date.parse(str(j.timestamp)) || null;
  if (HIDDEN_TOP.has(j.type)) return HIDDEN;
  if (j.type === 'compacted') return { entries: [], gap: 'compacted' };
  if (!isObj(p)) return UNKNOWN;
  if (j.type === 'event_msg') {
    if (p.type === 'user_message' || p.type === 'agent_message') {
      const text = str(p.message);
      if (!text.trim()) return { entries: [], canonical: true };
      return { entries: [{ kind: p.type === 'user_message' ? 'user' : 'assistant', text, at, key: null }], canonical: true };
    }
    return HIDDEN;
  }
  if (j.type !== 'response_item') return UNKNOWN;
  const callKey = str(p.call_id) || str(p.id);
  switch (p.type) {
    case 'message': return { entries: [], duplicate: p.role === 'user' || p.role === 'assistant' };
    case 'function_call': {
      let input = {};
      try { input = JSON.parse(p.arguments || '{}'); } catch {}
      return toolEntry(toolName(p.name) || 'tool', input, at, callKey ? 't:' + callKey : null, ctx);
    }
    case 'custom_tool_call':
      // Custom tool input is free text (for example a patch). Only the tool name is summarised.
      return toolEntry(toolName(p.name) || 'tool', {}, at, callKey ? 't:' + callKey : null, ctx);
    case 'local_shell_call':
      return toolEntry('shell', { command: p.action?.command }, at, callKey ? 't:' + callKey : null, ctx);
    case 'web_search_call': {
      const summary = ctx.summarizeTool('WebSearch', { query: str(p.action?.query) }, '');
      return { entries: [{ kind: 'tool', text: summary ? 'web_search · ' + summary : 'web_search', at, key: callKey ? 't:' + callKey : null }] };
    }
  }
  return HIDDEN_ITEMS.has(p.type) ? HIDDEN : UNKNOWN;
}

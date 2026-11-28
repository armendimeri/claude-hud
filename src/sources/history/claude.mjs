import { isObj, str } from '../../domain/tools.mjs';

// Claude Code transcript records -> visible history (CONTRACTS "History and capability wire examples").
//
// Shown: user prompt text (string content or `text` blocks), assistant `text` blocks, and one redacted summary per
// assistant `tool_use` block. Slash-command records are shown as "/name args".
// Hidden on purpose: isMeta / isCompactSummary / isVisibleInTranscriptOnly user records, user records carrying
// tool_result blocks, images, thinking / redacted_thinking and any other block type, <system-reminder> and local
// command output, and every known bookkeeping record type. A compact_boundary system record becomes a "compacted" gap.
// Any other record type is "unknown" and reported as a gap, never as an empty conversation.
//
// Merge precedence (fold keys): a user record folds by its `uuid`; an assistant text block folds by provider
// message.id + block text; a tool_use block folds by its block id. Claude Code writes one line per content block with a
// shared message.id and can repeat a block line; the first occurrence in source order wins. Two legitimate messages
// with the same text have different uuids / message ids and stay distinct.
//
// Isolation: a parent selection (agentId null) hides sidechain records and records stamped with an agentId (older
// transcripts kept subagent turns in the parent file). A child selection hides records stamped with a different
// agentId than the resolver's verified native agent id.

// Large bookkeeping records are recognised from their first bytes and never JSON-parsed.
export const SKIP_PREFIXES = ['{"type":"api-request', '{"type":"file-history', '{"type":"atis-latch', '{"type":"queue-operation',
  '{"type":"last-prompt', '{"type":"progress"', '{"type":"attachment"'];
const HIDDEN_TYPES = new Set(['system', 'summary', 'ai-title', 'custom-title', 'file-history-snapshot', 'queue-operation',
  'last-prompt', 'attachment', 'progress', 'api-request', 'api-request-blob', 'api-request-shape', 'atis-latch', 'tag',
  'agent-name', 'pr-link', 'mode', 'permission-mode', 'worktree-state']);
const HIDDEN_TEXT = /^\s*<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr)>/;
const HIDDEN = { entries: [] };
const UNKNOWN = { entries: [], gap: 'unknown' };

function slashCommand(text) {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
  return (name.startsWith('/') ? name : '/' + name) + (args ? ' ' + args : '');
}

function visibleUserText(text) {
  if (!text.trim() || HIDDEN_TEXT.test(text)) return null;
  if (/^\s*<command-(name|message|args)>/.test(text)) return slashCommand(text);
  return text;
}

export function classifyClaude(line, { selection, native, cwd, summarizeTool }) {
  if (SKIP_PREFIXES.some(prefix => line.startsWith(prefix))) return HIDDEN;
  let j;
  try { j = JSON.parse(line); } catch { return { entries: [], gap: 'malformed' }; }
  if (!isObj(j) || typeof j.type !== 'string') return UNKNOWN;
  if (selection.agentId === null) {
    if (j.isSidechain === true || typeof j.agentId === 'string') return HIDDEN;
  } else if (typeof native?.agentId === 'string' && typeof j.agentId === 'string' && j.agentId !== native.agentId) {
    return HIDDEN;
  }
  const at = Date.parse(str(j.timestamp)) || null;
  if (j.type === 'user') {
    if (j.isMeta || j.isCompactSummary || j.isVisibleInTranscriptOnly) return HIDDEN;
    const content = j.message?.content;
    let parts = [];
    if (typeof content === 'string') parts = [content];
    else if (Array.isArray(content)) {
      if (content.some(b => isObj(b) && b.type === 'tool_result')) return HIDDEN;
      parts = content.filter(b => isObj(b) && b.type === 'text' && typeof b.text === 'string').map(b => b.text);
    } else return UNKNOWN;
    const text = parts.map(visibleUserText).filter(Boolean).join('\n\n');
    if (!text) return HIDDEN;
    const uuid = str(j.uuid);
    return { entries: [{ kind: 'user', text, at, key: uuid ? 'u:' + uuid : null }] };
  }
  if (j.type === 'assistant') {
    const m = j.message;
    if (!isObj(m)) return UNKNOWN;
    const messageId = str(m.id) || str(j.uuid);
    if (typeof m.content === 'string') {
      return m.content.trim() ? { entries: [{ kind: 'assistant', text: m.content, at, key: messageId ? 'a:' + messageId + ':' + m.content : null }] } : HIDDEN;
    }
    if (!Array.isArray(m.content)) return UNKNOWN;
    const entries = [];
    const where = str(j.cwd) || cwd || '';
    for (const b of m.content) {
      if (!isObj(b)) continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        entries.push({ kind: 'assistant', text: b.text, at, key: messageId ? 'a:' + messageId + ':' + b.text : null });
      } else if (b.type === 'tool_use') {
        const name = str(b.name) || 'Tool';
        const summary = summarizeTool(name, b.input, where);
        entries.push({ kind: 'tool', text: summary ? name + ' · ' + summary : name, at, key: str(b.id) ? 't:' + b.id : null });
      }
    }
    return { entries };
  }
  if (j.type === 'system' && j.subtype === 'compact_boundary') return { entries: [], gap: 'compacted' };
  return HIDDEN_TYPES.has(j.type) ? HIDDEN : UNKNOWN;
}

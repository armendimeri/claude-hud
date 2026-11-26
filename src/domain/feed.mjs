import { AGENT_TOOLS, oneLine, truncate } from './tools.mjs';

export function createFeed(append) {
  const feedSeen = new Set();

  function pushFeed(s, kind, text, at = Date.now(), dedupeKey = null, action = null) {
    if (dedupeKey) { if (feedSeen.has(dedupeKey)) return; feedSeen.add(dedupeKey); if (feedSeen.size > 5000) feedSeen.delete(feedSeen.values().next().value); }
    const line = { at: Math.min(at, Date.now()), sessionId: s?.id ?? null, project: s?.project ?? null, kind, text: truncate(oneLine(text), 200) };
    if (action) line.action = action;
    append(line);
  }

  function feedTool(s, sub, id, name, summary, at) {
    const who = sub ? `${sub.type || 'agent'} › ` : '';
    if (AGENT_TOOLS.has(name)) pushFeed(s, 'agent', `${who}Agent started · ${summary}`, at, id ? `tool:${id}` : null);
    else pushFeed(s, 'tool', `${who}${name}${summary ? ` · ${summary}` : ''}`, at, id ? `tool:${id}` : null);
  }

  return { pushFeed, feedTool, forget: key => feedSeen.delete(key), remember: key => feedSeen.add(key) };
}

import { MINUTE_MS } from './models.mjs';
import { AGENT_TOOLS } from './tools.mjs';

const TOOL_ALERT_MS = 10 * MINUTE_MS;
const SUB_ALERT_MS = 5 * MINUTE_MS;

export function alertsFor(list, account, now, active, toolFor) {
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

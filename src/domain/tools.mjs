import path from 'node:path';
import { MINUTE_MS } from './models.mjs';

export function str(v) { return typeof v === 'string' ? v : ''; }
export function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
export function truncate(s, n) { s = str(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
export function oneLine(s) { return str(s).replace(/\s+/g, ' ').trim(); }

export const AGENT_TOOLS = new Set(['Agent', 'Task']);
export const runsInBackground = input => input?.run_in_background === true || input?.run_in_background === 'true';
export const NEEDS_INPUT_TOOLS = { AskUserQuestion: 'Question for you', ExitPlanMode: 'Plan approval' };

function shortPath(p, cwd) {
  p = str(p);
  if (!p) return '';
  if (cwd) {
    const rel = path.relative(cwd, p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
  }
  return p;
}
function safeUrl(u) {
  try { const x = new URL(u); return x.host + (x.pathname === '/' ? '' : x.pathname); } catch { return ''; }
}

export function createToolSummary(redact) {
  function summarizeTool(name, input, cwd) {
    if (!isObj(input)) return '';
    let out = '';
    switch (name) {
      case 'exec_command': out = str(input.cmd); break;
      case 'shell': case 'shell_command': out = Array.isArray(input.command) ? input.command.join(' ') : str(input.command); break;
      case 'read_file': out = shortPath(str(input.path), cwd); break;
      case 'spawn_agent': out = str(input.task_name) || str(input.agent_type); break;
      case 'request_user_input': case 'request_user_input_async': out = 'Question for you'; break;
      case 'apply_patch': out = 'Apply file changes'; break;
      case 'exec': out = 'Run tools'; break;
      case 'Bash': case 'PowerShell': out = str(input.command); break;
      case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': case 'NotebookRead':
        out = shortPath(str(input.file_path) || str(input.notebook_path), cwd); break;
      case 'Glob': case 'Grep':
        out = str(input.pattern) + (input.path ? ` in ${shortPath(input.path, cwd)}` : input.glob ? ` in ${str(input.glob)}` : ''); break;
      case 'WebFetch': out = safeUrl(str(input.url)); break;
      case 'WebSearch': case 'ToolSearch': out = str(input.query); break;
      case 'Agent': case 'Task': out = [str(input.subagent_type), str(input.description)].filter(Boolean).join(': '); break;
      case 'Skill': out = str(input.skill) || str(input.name); break;
      case 'TodoWrite': out = 'to-do list'; break;
    }
    return truncate(redact(oneLine(out)), 80);
  }
  return summarizeTool;
}

export function latestOpenTool(info, after = 0, done) {
  let best = null;
  for (const t of info?.openTools.values() || []) {
    if (t.since >= after && !done?.has(t.id) && (!best || t.since >= best.since)) best = t;
  }
  return best;
}
export function toolView(t) { return t ? { name: t.name, summary: t.summary, since: t.since } : null; }

export function currentSessionTool(s, now) {
  if (s.currentTool && s.currentTool.since >= s.turnAt) return s.currentTool;
  const open = latestOpenTool(s.tail?.info, s.turnAt, s.doneTools);
  return open && now - open.since < 30 * MINUTE_MS ? open : null;
}

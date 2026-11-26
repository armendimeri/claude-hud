export const pad2 = n => String(n).padStart(2, '0');
export function fmtTok(n) {
  n = Number(n) || 0;
  if (n < 999.5) return String(Math.round(n));
  const units = ['k', 'M', 'B'];
  let v = n / 1000, i = 0;
  while (v >= 999.5 && i < 2) { v /= 1000; i++; }
  return v.toFixed(v >= 99.95 ? 0 : v >= 9.995 ? 1 : 2) + units[i];
}
export const fmtInt = n => Math.round(Number(n) || 0).toLocaleString('en-US');
export function fmtPct(p) { if (p == null || !Number.isFinite(p)) return '—'; if (p >= 99.95) return '100%'; return (p < 9.95 ? p.toFixed(1) : Math.round(p)) + '%'; }
export function fmtDur(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000)), hh = Math.floor(sec / 3600), mm = Math.floor(sec % 3600 / 60), ss = sec % 60;
  return hh ? `${hh}:${pad2(mm)}:${pad2(ss)}` : `${mm}:${pad2(ss)}`;
}
export function fmtAge(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60); if (m < 60) return m + 'm';
  const hr = Math.floor(m / 60); if (hr < 24) return hr + 'h ' + (m % 60) + 'm';
  return Math.floor(hr / 24) + 'd ' + (hr % 24) + 'h';
}
export function fmtClock(ts) { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
export function fmtDate(ts) { return new Date(ts).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }); }
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export function shortModel(m) {
  if (!m) return '';
  const a = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(m);
  if (a) return a[1] + ' ' + a[2] + (a[3] ? '.' + a[3] : '');
  const b = /^claude-(\d+)(?:-(\d))?-([a-z]+)/.exec(m);
  if (b) return b[3] + ' ' + b[1] + (b[2] ? '.' + b[2] : '');
  return m.length > 16 ? m.slice(0, 15) + '…' : m;
}
const TOOL_ICONS = { Bash: 'terminal', PowerShell: 'terminal', BashOutput: 'terminal', KillShell: 'terminal', Read: 'file', NotebookRead: 'file',
  Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit', Grep: 'search', Glob: 'search', LS: 'search', WebFetch: 'web', WebSearch: 'web',
  Agent: 'agent', Task: 'agent', TodoWrite: 'plan', ExitPlanMode: 'plan', AskUserQuestion: 'bell',
  exec_command: 'terminal', shell_command: 'terminal', shell: 'terminal', read_file: 'file', apply_patch: 'edit',
  spawn_agent: 'agent', update_plan: 'plan', request_user_input: 'bell', request_user_input_async: 'bell' };
export const toolIcon = n => TOOL_ICONS[n] || 'tool';
export const ctxLevel = p => p == null ? 'none' : p >= 90 ? 'hot' : p >= 70 ? 'warn' : 'ok';
export const provName = p => p === 'openai' ? 'OpenAI' : p === 'bedrock' ? 'Bedrock' : p === 'anthropic' ? 'Anthropic' : 'Unknown';
export const provLetter = p => p === 'openai' ? 'O' : p === 'bedrock' ? 'B' : p === 'anthropic' ? 'A' : '?';
// The needs-you reason where room is short: "Allow Bash", "Question".
export function shortReason(r) {
  const m = /^Permission:\s*(.+)$/i.exec(r || '');
  if (m) return 'Allow ' + m[1];
  return { 'Permission needed': 'Permission', 'Question for you': 'Question', 'Waiting for your input': 'Input' }[r] || r || 'Needs you';
}

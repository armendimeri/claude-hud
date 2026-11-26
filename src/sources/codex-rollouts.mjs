import fsp from 'node:fs/promises';
import path from 'node:path';
import { addDay, addPulse, dayKey, minuteOf, num, startOfDay, zero } from '../domain/models.mjs';
import { isObj, oneLine, runsInBackground, str, truncate } from '../domain/tools.mjs';
import { ENDED_KEEP_MS } from '../domain/sessions.mjs';

export function createCodexRollouts({ directories, lifetime, reader, redact, summarizeTool,
  onSession, onCwd, onActivity, onStatus, onTool, onToolDone, onIdle, onChange }) {
  const codexId = id => `codex:${id}`;
  let codexScanning = false, codexLastScan = 0;
  const codexMonitoring = { readable: false, error: null };

  function codexTokens(u) {
    const cached = Math.min(num(u.cached_input_tokens), num(u.input_tokens));
    const written = Math.min(num(u.cache_write_input_tokens), num(u.input_tokens) - cached);
    return { input: num(u.input_tokens) - cached - written, output: num(u.output_tokens), cacheRead: cached, cacheWrite: written };
  }

  function codexUsage(info, usage, latest, window, ts) {
    if (num(window)) info.contextWindow = window;
    if (isObj(latest)) info.lastUsed = num(latest.total_tokens) || num(latest.input_tokens) + num(latest.output_tokens);
    if (!isObj(usage)) return;
    const tok = codexTokens(usage), delta = zero();
    for (const k of Object.keys(delta)) delta[k] = Math.max(0, tok[k] - info.tokens[k]);
    // Repeated cumulative records (including the paired token_count event) must never double count.
    info.tokens = tok;
    if (ts) {
      addDay(info, dayKey(ts), delta, 1);
      addPulse(info.byMinute, minuteOf(ts), delta.output, minuteOf(Date.now()));
    }
  }

  function codexToolName(name) { return str(name).replace(/^(?:functions|tools|collaboration)\./, ''); }

  function processCodexLine(t, line) {
    let j;
    try { j = JSON.parse(line); } catch { return; }
    if (!isObj(j) || !isObj(j.payload)) return;
    const p = j.payload, info = t.info;
    const ts = Date.parse(j.timestamp) || 0;
    if (j.type === 'session_meta') {
      if (!str(p.id)) return;
      const id = codexId(p.id);
      const spawn = p.source?.subagent?.thread_spawn;
      const s = onSession(t, id, {
        entrypoint: str(p.source) || str(p.originator) || 'codex',
        version: str(p.cli_version) || null, startedAt: Date.parse(p.timestamp) || ts || null,
        codexParent: str(spawn?.parent_thread_id) ? codexId(spawn.parent_thread_id) : null,
        codexInternal: !!p.source?.subagent?.other, kind: str(spawn?.agent_role) || str(spawn?.agent_type) || 'Codex',
        name: str(spawn?.agent_nickname) || null,
      });
      t.owner = { session: s, agentId: null };
      info.sessionId = s.id;
      info.codexProvider = p.model_provider === 'openai' ? 'openai' : 'unknown';
      if (str(p.cwd)) { info.cwd = p.cwd; onCwd(s, p.cwd); }
      info.branch = str(p.git?.branch) || null;
    }
    const s = t.owner?.session;
    if (!s) return;
    const advanced = ts > info.lastTs;
    if (ts) { info.firstTs ||= ts; info.lastTs = Math.max(info.lastTs, ts); }
    if (advanced) onActivity(s, ts);
    if (j.type === 'turn_context') {
      if (str(p.model)) info.modelRaw = p.model;
      if (str(p.effort)) info.effort = p.effort;
      if (str(p.cwd)) { info.cwd = p.cwd; onCwd(s, p.cwd); }
    } else if (j.type === 'token_usage_record') {
      codexUsage(info, p.thread_token_usage, p.usage, null, ts);
    } else if (j.type === 'event_msg') {
      switch (p.type) {
        case 'token_count':
          codexUsage(info, p.info?.total_token_usage, p.info?.last_token_usage, p.info?.model_context_window, ts);
          break;
        case 'task_started': case 'turn_started': case 'user_message':
          onStatus(s, p.type, ts);
          if (p.type === 'user_message' && !info.title) info.title = truncate(redact(oneLine(p.message)), 300) || null;
          if (num(p.model_context_window)) info.contextWindow = p.model_context_window;
          break;
        case 'task_complete': case 'turn_complete': case 'turn_aborted':
          info.openTools.clear();
          onStatus(s, p.type, ts);
          break;
        case 'session_end': case 'shutdown_complete': onStatus(s, p.type, ts); break;
      }
    } else if (j.type === 'response_item') {
      const id = str(p.call_id);
      if ((p.type === 'function_call' || p.type === 'custom_tool_call') && id && !info.toolIds.has(id)) {
        const name = codexToolName(p.name);
        let input = {};
        try { input = JSON.parse(p.arguments || '{}'); } catch {}
        const summary = summarizeTool(name, input, info.cwd);
        info.toolIds.add(id);
        info.openTools.set(id, { id, name, summary, since: ts, background: runsInBackground(input) });
        if (info.openTools.size > 50) info.openTools.delete(info.openTools.keys().next().value);
        onTool(s, id, name, summary, ts);
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const tool = info.openTools.get(id);
        if (tool) onToolDone(s, tool.name);
        info.openTools.delete(id);
      }
    }
  }

  function reset(t) {
    const s = t.owner?.session;
    if (!s) return;
    s.hookStatus = null; s.hookStatusAt = 0; s.needsYou = null;
    s.turn = { startedAt: null, lastMs: null }; s.turnAt = 0;
  }

  const scanCodex = lifetime.task(async function (force = false) {
    if (codexScanning || (!force && Date.now() - codexLastScan < 15_000)) return;
    codexScanning = true; codexLastScan = Date.now();
    const since = Math.min(startOfDay(), Date.now() - ENDED_KEEP_MS);
    let readable = false, error = null;
    const visit = async (dir, depth = 0) => {
      if (lifetime.signal.aborted) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); if (!depth) readable = true; }
      catch (e) { if (!depth && e.code !== 'ENOENT') error = `Codex sessions: ${e.code}`; return; }
      for (const e of entries) {
        if (lifetime.signal.aborted) return;
        const file = path.join(dir, e.name);
        // Do not follow symlinks or inspect other CODEX_HOME files (notably auth.json).
        if (e.isDirectory() && depth < 3 && /^\d+$/.test(e.name)) { await visit(file, depth + 1); continue; }
        if (!e.isFile() || !/^rollout-.*\.jsonl$/.test(e.name)) continue;
        let st;
        try { st = await fsp.stat(file); } catch { continue; }
        const existing = reader.find(file);
        if (!existing && st.mtimeMs < since) continue;
        const t = reader.open(file, processCodexLine, reset);
        await reader.read(t);
        const s = t.owner?.session;
        if (s) onIdle(s, t.info.lastTs, Date.now());
      }
    };
    try { for (const dir of directories) await visit(path.join(dir, 'sessions')); }
    finally { codexScanning = false; codexMonitoring.readable = readable; codexMonitoring.error = error; onChange(); }
  });

  function onCodexChange(dir, rel) {
    if (!rel || !/^rollout-.*\.jsonl$/.test(path.basename(String(rel)))) return;
    const file = path.resolve(dir, String(rel));
    if (!file.startsWith(path.resolve(dir) + path.sep)) return;
    const t = reader.find(file);
    if (t?.onLine === processCodexLine) reader.read(t);
    else scanCodex(true);
  }

  function watch() {
    for (const dir of directories) {
      const sessionsDir = path.join(dir, 'sessions');
      lifetime.watchDirectory(sessionsDir, { recursive: true }, (event, file) => onCodexChange(sessionsDir, file));
    }
  }

  return { scan: scanCodex, watch, monitoring: () => ({ ...codexMonitoring, directories }) };
}

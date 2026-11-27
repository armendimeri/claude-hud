import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { addDay, addPulse, addTokens, dayKey, minuteOf, normalizeModel, num, startOfDay, zero } from '../domain/models.mjs';
import { AGENT_TOOLS, isObj, runsInBackground, str } from '../domain/tools.mjs';
import { ENDED_KEEP_MS } from '../domain/sessions.mjs';

// `api-request` lines are small and read for their model id; `api-request-blob` / `-shape` lines (up to ~200 KB) are not.
const API_REQUEST_PREFIX = '{"type":"api-request",';
const SKIP_LINE_PREFIXES = ['{"type":"api-request', '{"type":"file-history', '{"type":"atis-latch', '{"type":"queue-operation', '{"type":"last-prompt'];
const API_REQUEST_CHAR_LIMIT = 65536;
const PREFIX_BYTES = Math.max(API_REQUEST_PREFIX.length, ...SKIP_LINE_PREFIXES.map(prefix => prefix.length));

function skipLargeLine(bytes) {
  if (bytes.length <= API_REQUEST_CHAR_LIMIT) return false;
  const prefix = bytes.toString('utf8', 0, PREFIX_BYTES);
  if (prefix.startsWith(API_REQUEST_PREFIX)) {
    // The model parser limits UTF-16 length. Leave multibyte records near that limit to the parser.
    return bytes.length > 3 * API_REQUEST_CHAR_LIMIT;
  }
  return SKIP_LINE_PREFIXES.some(skip => prefix.startsWith(skip));
}

async function readJson(file) { try { return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; } }

export function createClaudeTranscripts({ roots, lifetime, reader, summarizeTool, findSession, onRecentSession,
  onActivity, onTool, collectPrompt, onAgentCall, onAgentResult, onAttach, onCwd, onSubagentMeta, findOrAssignSubagent,
  closeSub, onChange }) {
  const readTail = reader.read;
  function getTail(file) {
    const t = reader.open(file, processLine, undefined, skipLargeLine);
    const key = file.toLowerCase();
    t.info.rootBedrock = !!roots.find(root => key.startsWith(root.projects.toLowerCase() + path.sep))?.bedrock;
    return t;
  }

  function processLine(t, line) {
    if (line.startsWith(API_REQUEST_PREFIX)) { onApiRequestLine(t, line); return; }
    for (const p of SKIP_LINE_PREFIXES) if (line.startsWith(p)) return;
    let j;
    try { j = JSON.parse(line); } catch { return; }
    if (!isObj(j)) return;
    const info = t.info;
    if (typeof j.sessionId === 'string') info.sessionId ??= j.sessionId;
    if (typeof j.agentId === 'string') info.agentId ??= j.agentId;
    const ts = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) || 0 : 0;
    if (ts) {
      if (ts > info.lastTs) info.lastTs = ts;
      if (!info.firstTs) info.firstTs = ts;
      if (t.owner && !t.owner.agentId) onActivity(t.owner.session);
    }
    if (typeof j.customTitle === 'string' && j.customTitle) info.customTitle = j.customTitle;
    if (j.type === 'ai-title' && typeof j.aiTitle === 'string') info.title = j.aiTitle;
    else if (j.type === 'summary' && typeof j.summary === 'string') info.title ??= j.summary;
    else if (j.type === 'assistant') onAssistantLine(t, j, ts);
    else if (j.type === 'user') onUserLine(t, j, ts);
  }

  function onApiRequestLine(t, line) {
    if (line.length > API_REQUEST_CHAR_LIMIT) return;
    let j;
    try { j = JSON.parse(line); } catch { return; }
    const model = j?.params?.model;
    if (typeof model !== 'string' || !model || model.length > 200) return;
    t.info.requestModel = model;
    if (normalizeModel(model).provider === 'bedrock') t.info.bedrock = true;
  }

  function onAssistantLine(t, j, ts) {
    const info = t.info, m = j.message;
    if (!isObj(m)) return;
    if (typeof m.model === 'string' && m.model && !m.model.startsWith('<')) info.modelRaw = m.model;
    if (typeof m.id === 'string' && m.id.startsWith('msg_bdrk_')) info.bedrock = true;   // Bedrock message ids, whatever the model id says
    if (typeof j.effort === 'string' && j.effort) info.effort = j.effort;
    if (typeof j.gitBranch === 'string' && j.gitBranch) info.branch = j.gitBranch;
    if (typeof j.cwd === 'string' && j.cwd) info.cwd = j.cwd;
    const u = m.usage;
    if (isObj(u)) {
      // One message is often written as several lines that repeat the same usage: count each message id once.
      const tok = { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) };
      const id = typeof m.id === 'string' ? m.id : str(j.uuid);
      const day = ts ? dayKey(ts) : null;
      const minute = ts ? minuteOf(ts) : null;
      const prev = info.msgs.get(id);
      const bucketNow = minuteOf(Date.now());
      if (prev) {
        addTokens(info.tokens, prev.tok, -1);
        if (prev.day) addDay(info, prev.day, prev.tok, -1);
        addPulse(info.byMinute, prev.minute, -prev.tok.output, bucketNow);
        info.msgs.delete(id);
      }
      addTokens(info.tokens, tok);
      if (day) addDay(info, day, tok, 1);
      addPulse(info.byMinute, minute, tok.output, bucketNow);
      info.msgs.set(id, { tok, day, minute });
      if (info.msgs.size > 4000) info.msgs.delete(info.msgs.keys().next().value);
      info.lastUsed = tok.input + tok.cacheRead + tok.cacheWrite;   // context: the latest turn only (D13)
    }
    if (!Array.isArray(m.content)) return;
    for (const c of m.content) {
      if (!isObj(c) || c.type !== 'tool_use' || typeof c.id !== 'string' || info.toolIds.has(c.id)) continue;
      info.toolIds.add(c.id);
      const name = str(c.name) || '?';
      const summary = summarizeTool(name, c.input, info.cwd);
      info.openTools.set(c.id, { id: c.id, name, summary, since: ts || Date.now(), background: runsInBackground(c.input) });
      if (info.openTools.size > 50) info.openTools.delete(info.openTools.keys().next().value);
      const input = isObj(c.input) ? c.input : null;
      if (AGENT_TOOLS.has(name)) {
        onAgentCall(t, c.id, {
          description: str(input?.description), subagent_type: str(input?.subagent_type), model: str(input?.model),
          run_in_background: runsInBackground(input), prompt: str(input?.prompt),
        }, ts);
      }
      onTool(t, c.id, name, summary, str(input?.file_path), ts);
    }
  }

  function onUserLine(t, j, ts) {
    const content = j.message?.content;
    // A prompt (hud-0-3 D3): only its ID-shaped words are kept, the text is dropped here. Lines Claude Code adds itself
    // (isMeta, a compaction summary) and tool results are not prompts.
    const prompt = !j.isMeta && !j.isCompactSummary && !j.isVisibleInTranscriptOnly;
    if (typeof content === 'string') { if (prompt) collectPrompt(t.info, content); return; }
    if (!Array.isArray(content)) return;
    let results = false;
    for (const b of content) {
      if (!isObj(b) || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      results = true;
      t.info.openTools.delete(b.tool_use_id);
      if (t.info.agentCalls.has(b.tool_use_id)) {
        const result = isObj(j.toolUseResult) ? j.toolUseResult : null;
        onAgentResult(t, b.tool_use_id, {
          agentId: result?.agentId, status: result?.status, isAsync: result?.isAsync,
        }, b.is_error === true, ts);
      }
    }
    if (prompt && !results) collectPrompt(t.info, content.filter(b => isObj(b) && b.type === 'text').map(b => str(b.text)).join('\n'));
  }

  function attachSubTail(s, sub, file) {
    if (sub.tail) return;
    const t = getTail(file);
    t.owner = { session: s, agentId: sub.agentId };
    sub.tail = t;
    onAttach(t);
    readTail(t);
  }
  function subagentsDir(s) { return s.transcriptPath ? path.join(path.dirname(s.transcriptPath), s.id, 'subagents') : null; }

  function attachKnownSubTail(s, sub, agentId) {
    const dir = subagentsDir(s);
    if (!sub.tail && dir) attachSubTailIfPresent(s, sub, path.join(dir, `agent-${agentId}.jsonl`));
  }

  function attachSubTailIfPresent(s, sub, file) {
    if (fs.existsSync(file)) attachSubTail(s, sub, file);
  }

  const readMeta = lifetime.task(async function (s, file) {
    const meta = await readJson(file);
    const m = /agent-(.+)\.meta\.json$/i.exec(path.basename(file));
    if (!isObj(meta) || !m) return;
    const agentId = m[1];
    const sub = onSubagentMeta(s, agentId, meta);
    let mtime = Date.now();
    try { const st = await fsp.stat(file); mtime = st.mtimeMs; sub.startedAt ??= st.birthtimeMs || st.mtimeMs; } catch {}
    if (meta.finished === true) closeSub(s, sub, mtime);    // Claude Code marks a finished subagent here
    const jsonl = file.replace(/\.meta\.json$/i, '.jsonl');
    if (!sub.tail && fs.existsSync(jsonl)) attachSubTail(s, sub, jsonl);
    onChange();
  });

  const scanSubagents = lifetime.task(async function (s) {
    const dir = subagentsDir(s);
    if (!dir) return;
    const walk = async (d, depth) => {
      let ents;
      try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) { if (depth < 3) await walk(f, depth + 1); }
        else if (/^agent-.+\.meta\.json$/i.test(e.name)) await readMeta(s, f);
      }
      for (const e of ents) {
        const m = /^agent-(.+)\.jsonl$/i.exec(e.name);
        if (m && !e.isDirectory()) ensureSubTail(s, m[1], path.join(d, e.name));
      }
    };
    await walk(dir, 0);
  });
  function ensureSubTail(s, agentId, file) {
    const sub = findOrAssignSubagent(s, agentId);
    if (!sub.tail) attachSubTail(s, sub, file);
    else readTail(sub.tail);
  }

  function slugFor(cwd) { return cwd.replace(/[^A-Za-z0-9]/g, '-'); }
  function findTranscript(s) {
    if (s.cwd) {
      for (const r of s.root ? [s.root, ...roots.filter(x => x !== s.root)] : roots) {
        const f = path.join(r.projects, slugFor(s.cwd), `${s.id}.jsonl`);
        if (fs.existsSync(f)) return f;
      }
    }
    if (Date.now() - s.lastFind < 10_000) return null;
    s.lastFind = Date.now();
    for (const r of roots) {
      let dirs = [];
      try { dirs = fs.readdirSync(r.projects); } catch {}
      for (const d of dirs) {
        const f = path.join(r.projects, d, `${s.id}.jsonl`);
        if (fs.existsSync(f)) return f;
      }
    }
    return null;
  }
  function attachSessionTranscript(s, hint) {
    if (s.agent === 'codex') return;
    if (s.tail) return;
    const file = hint && fs.existsSync(hint) ? hint : findTranscript(s);
    if (!file) return;
    s.transcriptPath = file;
    const t = getTail(file);
    t.owner = { session: s, agentId: null };
    s.tail = t;
    onAttach(t);
    readTail(t).then(() => {
      if (!s.cwd && t.info.cwd) onCwd(s, t.info.cwd);
      return scanSubagents(s);
    });
  }

  function onProjectsChange(root, rel) {
    if (!rel) return;
    const parts = String(rel).split(/[\\/]/);
    const base = parts[parts.length - 1];
    const file = path.join(root.projects, ...parts);
    if (parts.length === 2 && base.endsWith('.jsonl')) {
      const s = findSession(base.slice(0, -6));
      if (s?.tail) readTail(s.tail);
      else if (s) attachSessionTranscript(s, file);
      else readTail(getTail(file));            // a transcript nobody shows yet: still counted in "tokens today"
      return;
    }
    const si = parts.indexOf('subagents');
    if (si >= 2) {
      const s = findSession(parts[1]);
      const m = /^agent-(.+)\.jsonl$/i.exec(base);
      if (!s) { if (m) readTail(getTail(file)); return; }
      if (/\.meta\.json$/i.test(base)) readMeta(s, file);
      else if (m) ensureSubTail(s, m[1], file);
    }
  }

  // At start: read every transcript touched today ("tokens today" survives a restart) or in the last two hours
  // (sessions that ended recently are shown as ended).
  const scanRecentTranscripts = lifetime.task(async function () {
    const since = Math.min(startOfDay(), Date.now() - ENDED_KEEP_MS);
    const dirs = [];
    for (const r of roots) {
      try { for (const d of await fsp.readdir(r.projects, { withFileTypes: true })) dirs.push([r, d]); } catch {}
    }
    for (const [root, d] of dirs) {
      if (lifetime.signal.aborted) return;
      if (!d.isDirectory()) continue;
      const dir = path.join(root.projects, d.name);
      let ents = [];
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const f = path.join(dir, e.name);
        let st;
        try { st = await fsp.stat(f); } catch { continue; }
        if (e.isFile() && e.name.endsWith('.jsonl') && st.mtimeMs >= since) {
          const id = e.name.slice(0, -6);
          const s = findSession(id);
          if (s) { attachSessionTranscript(s, f); continue; }
          const t = getTail(f);
          await readTail(t);
          if (st.mtimeMs >= Date.now() - ENDED_KEEP_MS && t.info.lastTs) {
            onRecentSession(id, f, t.info.lastTs);
          }
        } else if (e.isDirectory() && st.mtimeMs >= since) {
          const sub = path.join(f, 'subagents');
          let files = [];
          try { files = await fsp.readdir(sub); } catch { continue; }
          for (const n of files) {
            if (!n.endsWith('.jsonl')) continue;
            const sf = path.join(sub, n);
            try { if ((await fsp.stat(sf)).mtimeMs < since) continue; } catch { continue; }
            if (!findSession(e.name)) await readTail(getTail(sf));
          }
        }
      }
    }
    onChange();
  });

  function watch() {
    for (const root of roots) lifetime.watchDirectory(root.projects, { recursive: true }, (event, file) => onProjectsChange(root, file));
  }

  return { watch, scanRecentTranscripts, attachSessionTranscript, attachKnownSubTail, attachSubTailIfPresent, processLine };
}

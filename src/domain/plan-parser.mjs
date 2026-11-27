import path from 'node:path';
import { oneLine, str, truncate } from './tools.mjs';

export const BOARD_HEADER = '| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |';
const COLUMN_ROLES = [
  ['id', /^(phase|chunk|run|step|slice|stage|id|#|task|milestone|item)$/],
  ['name', /^(title|name|what|what it is|input|goal|summary|part|item|job|work|description)$/],
  ['agent', /^(agent|owner|who|assignee)$/],
  ['state', /^(state|status)$/],
  ['since', /^(since|started|date)$/],
  ['deps', /^(depends on|dependencies|waits for|after|requires|prerequisites|blocked by|start when|needs)$/],
  ['notes', /^(notes?|comments?)$/],
  ['handoff', /^handoffs?$/],
  ['modelEffort', /^model\s*[/,·]\s*effort$/],
  ['model', /^model$/],
  ['effort', /^effort$/],
  ['chunks', /^(chunks?|items?)(,? in order)?$/],
  ['lane', /^lane$/],
];

export function cleanCell(c) {
  return oneLine(str(c)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*|__|`/g, ''));
}
export function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '', tick = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (ch === '`') tick = !tick;
    if (ch === '|' && !tick) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}
function parseIdCell(cell) {
  const m = /^([A-Za-z]{0,4}-?\d+(?:[-.]\d+)*[a-z]?)(?![\w])\s*[:.)\-–—]?\s*(.*)$/.exec(cell);
  return m ? { id: m[1], rest: m[2] } : { id: truncate(cell, 40), rest: cell };
}
function normalizeState(raw) {
  const t = raw.toLowerCase().trim();
  if (!t || t === '—' || t === '-') return 'todo';
  if (/\bbounced\b/.test(t)) return 'bounced';
  if (/\bblocked\b/.test(t)) return 'blocked';
  if (/\baccepted\b/.test(t)) return 'accepted';
  if (/\bhanded[- ]?off\b/.test(t)) return 'handed-off';
  if (/\bin[- ]progress\b|^(started|working|building|active|running|doing)\b/.test(t)) return 'in-progress';
  if (/\bpartial(ly)?\b/.test(t)) return 'partial';
  if (/^(done|complete|completed|finished|built|merged|shipped|confirmed|in)\b/.test(t)) return 'done';
  if (/^(todo|to do|not started|planned|pending|open|waiting|ready|next|later)\b/.test(t)) return 'todo';
  if (/\bdone\b/.test(t)) return 'partial';
  return 'unknown';
}
function splitModelEffort(v) {
  const t = cleanCell(v);
  if (!t || /^(?:[—-]|owner|human)$/i.test(t)) return { model: null, effort: null };
  const [m, e] = t.split(/[/,·]/).map(x => x.trim());
  return { model: m || null, effort: e || null };
}
function extractRefs(text, known, self) {
  if (!text || !known.length) return [];
  const re = new RegExp(`(?<![A-Za-z0-9-])(${known.map(k => k.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')})(?![A-Za-z0-9]|-\\d)`, 'g');
  const hits = [...text.matchAll(re)];
  const out = [];
  const push = id => { if (id !== self && !out.includes(id)) out.push(id); };
  for (let i = 0; i < hits.length; i++) {
    const a = hits[i], b = hits[i + 1];
    const between = b ? text.slice(a.index + a[0].length, b.index) : '';
    const pa = /^(.*?)(\d+)$/.exec(a[1]), pb = b && /^(.*?)(\d+)$/.exec(b[1]);
    if (b && /^\s*(–|—|-|to|through|\.\.)\s*$/.test(between) && pa && pb && pa[1] === pb[1]) {
      const lo = Number(pa[2]), hi = Number(pb[2]);
      for (const k of known) { const pk = /^(.*?)(\d+)$/.exec(k); if (pk && pk[1] === pa[1] && Number(pk[2]) >= lo && Number(pk[2]) <= hi) push(k); }
      i++;
      continue;
    }
    push(a[1]);
  }
  return out;
}

/** The plan header line (STANDARD §4.1): `Status: **<state>**`, with the date that may follow the state. */
function planHeader(text) {
  const m = /^Status:\s*\*\*([^*]+)\*\*\s*(\d{4}-\d{2}-\d{2})?/m.exec(text.split(/\r?\n/, 30).join('\n'));
  return m ? { state: m[1].trim().toLowerCase(), date: m[2] || null } : null;
}

export function parsePlan(text, file, root, project, planText = null) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let title = null, section = '', fence = false, inLog = false, standard = false;
  const tables = [], log = [], decisions = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const txt = cleanCell(h[2]);
      if (h[1].length === 1) title ??= txt;
      else { section = txt; inLog = /^log\b/i.test(txt); }
      continue;
    }
    if (inLog && /^\s*[-*]\s+/.test(line)) { log.push(cleanCell(line.replace(/^\s*[-*]\s+/, ''))); continue; }
    const box = /^decisions\b/i.test(section) && /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (box) {
      const body = cleanCell(box[2]);
      decisions.push({ id: (/^(D\d+)\b/.exec(body) || [])[1] || null, text: truncate(body, 200), ticked: box[1] !== ' ' });
      continue;
    }
    if (line.trimStart().startsWith('|') && /^\s*\|[\s:|-]+$/.test(lines[i + 1] || '') && lines[i + 1].includes('-')) {
      if (/^board$/i.test(section) && line.trim() === BOARD_HEADER) standard = true;
      const header = splitRow(line).map(c => cleanCell(c).toLowerCase());
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trimStart().startsWith('|'); i++) rows.push(splitRow(lines[i]));
      i--;
      tables.push({ section, header, rows });
    }
  }

  // Unanswered questions: a Questions table row whose Answer cell is empty (STANDARD §5, §17).
  const questions = [];
  for (const tb of tables) {
    const q = tb.header.indexOf('question'), a = tb.header.indexOf('answer');
    if (!/^questions\b/i.test(tb.section) || q < 0 || a < 0) continue;
    for (const row of tb.rows) {
      const ask = cleanCell(row[q]);
      if (ask && !/^[—-]?$/.test(cleanCell(row[a]))) continue;
      if (ask) questions.push({ id: cleanCell(row[0]) || null, item: cleanCell(row[tb.header.indexOf('item')]) || null, text: truncate(ask, 300) });
    }
  }

  const phases = [], runs = [], byId = new Map(), enrich = [];
  for (const tb of tables) {
    const col = {};
    tb.header.forEach((h, k) => { for (const [role, re] of COLUMN_ROLES) if (re.test(h) && col[role] === undefined && (role !== 'id' || k === 0)) col[role] = k; });
    // Numbered rollout boards have both a step reference and a human-readable job.
    const job = tb.header.indexOf('job'), step = tb.header.indexOf('step');
    if (job >= 0) col.name = job;
    if (col.id !== 0 || /^questions\b/i.test(tb.section)) continue;
    const head = tb.header[0];
    const tableKind = head === 'run' ? 'run' : head === 'chunk' ? 'chunk' : /^(phase|step|stage|slice)$/.test(head) ? 'phase'
      : (/input/i.test(tb.section) || tb.header[col.name] === 'input') ? 'input' : 'item';
    const group = tb.section.replace(/\s+[—-]\s+\S+\.md$/i, '');
    const isBoard = col.state !== undefined;
    for (const row of tb.rows) {
      const cell = k => (k === undefined ? '' : cleanCell(row[k]));
      const idc = parseIdCell(cell(0));
      if (!idc.id) continue;
      const kind = tableKind === 'item' && /^O-\d+$/.test(idc.id) ? 'input' : tableKind;
      const me = col.modelEffort !== undefined ? splitModelEffort(row[col.modelEffort]) : { model: cell(col.model) || null, effort: cell(col.effort) || null };
      if (!isBoard) { if (me.model || me.effort) enrich.push({ id: idc.id, ...me }); continue; }
      const stateRaw = cell(col.state);
      const since = cell(col.since) || (/(\d{4}-\d{2}-\d{2})/.exec(stateRaw) || [])[1] || null;
      const node = {
        id: idc.id,
        name: truncate([step > 0 ? cell(step) : '', cell(col.name) || idc.rest || idc.id].filter(Boolean).join(' · '), 140),
        agent: cell(col.agent) || null,
        state: normalizeState(stateRaw),
        stateRaw: truncate(stateRaw, 160),
        since: since && !/^[—-]$/.test(since) ? since : null,
        waitsFor: [],
        notes: truncate(cell(col.notes), 300) || null,
        group: group || null,
        kind,
        model: me.model && !/^[—-]$/.test(me.model) ? me.model : null,
        effort: me.effort,
        handoff: !!cell(col.handoff) && !/^[—-]$/.test(cell(col.handoff)),   // hud-0-3 P4: a handoff is linked ("—" says none will be)
        _deps: [cell(col.deps), (/waits? for\s+([^·;]+)/i.exec(cell(col.notes)) || [])[1] || ''].join(' '),
        _chunks: cell(col.chunks),
        lane: cell(col.lane) || null,
      };
      if (byId.has(node.id)) continue;
      byId.set(node.id, node);
      (kind === 'run' ? runs : phases).push(node);
    }
  }
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const small = /^docs\/plans\/[^/]+\.md$/i.test(rel);
  const header = planHeader(text) ?? planHeader(planText ?? '');
  if (!phases.length && !runs.length && !(small && header)) return null;
  for (const e of enrich) { const n = byId.get(e.id); if (n) { n.model ??= e.model; n.effort ??= e.effort; } }
  const known = [...byId.keys()];
  const CROSS = /(?<![\w/-])([a-z0-9][\w.-]*)\/([A-Za-z]{0,4}-?\d+(?:-\d+)?)(?![\w-])/g;
  for (const n of [...phases, ...runs]) {
    n.waitsForOther = [...n._deps.matchAll(CROSS)].map(m => `${m[1]}/${m[2]}`);   // `<slug>/<ID>` in another plan
    n.waitsFor = extractRefs(n._deps.replace(CROSS, ' '), known, n.id);
    if (n.kind === 'run') { n.chunks = extractRefs(n._chunks, known, n.id); n.startWhen = truncate(n._deps.trim(), 200) || null; }
    delete n._deps; delete n._chunks;
    if (n.kind !== 'run') delete n.lane;
  }
  const slug = (/^docs\/plans\/([^/]+)\/status\.md$/i.exec(rel) || /^docs\/plans\/([^/]+)\.md$/i.exec(rel) || [])[1] || rel.replace(/\.md$/i, '');
  let t = (title || slug).replace(/^plan:\s*/i, '').replace(/:\s*(status( and handoffs?)?|handoffs?\b.*)$/i, '').trim();
  if (!t || /^(chunk\s+)?status(\s+board)?$/i.test(t)) t = path.basename(path.dirname(file));
  const openDecisions = decisions.filter(d => !d.ticked).map(({ id, text: dt }) => ({ id, text: dt }));
  return {
    project, slug, title: t, path: file, format: standard ? 'standard' : 'legacy', size: small ? 'small' : 'phased',
    state: header?.state ?? null, stateDate: header?.date ?? null,
    phases, runs,
    needsYou: [...openDecisions.map(d => ({ kind: 'decision', id: d.id, text: d.text })), ...questions.map(q => ({ kind: 'question', id: q.id, item: q.item, text: q.text }))],
    lastLog: log.slice(-5).map(l => truncate(l, 240)),
  };
}

/** Parse one file while it is being read, retaining only the board and its supersession reference. */
export function parsePlanCandidate({ file, mtime, text, planText }, { root, project }) {
  const plan = parsePlan(text, file, root, project, planText);
  if (!plan) return null;
  const replacement = /\bsuperseded by\s+(?:\*\*)?\[([^\]]+)\]\(([^)]+)\)/i.exec(text);
  return { file: file.toLowerCase(), plan, mtime, replacement: replacement?.[2] ?? null };
}

/** A companion or explicit replacement takes precedence when it contains a usable board. */
export function selectPlanFiles(candidates) {
  const byFile = new Map(candidates.map(candidate => [candidate.file, candidate]));
  return [...byFile.values()].filter(({ file, replacement }) => {
    const parent = path.dirname(file);
    if (/[/\\]plan\.md$/i.test(file) && byFile.has(path.join(parent, 'STATUS.md').toLowerCase())) return false;
    if (!replacement) return true;
    const target = path.resolve(parent, replacement.split('#')[0]).toLowerCase();
    return target === file || !byFile.has(target);
  });
}

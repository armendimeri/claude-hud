import { MINUTE_MS } from './models.mjs';
import { str } from './tools.mjs';

const REFS_MAX = 40;                     // ID-shaped words kept per agent from its task text
const TOUCHED_MAX = 20;                  // plan files read or written, kept per agent
const ITEMS_MAX = 3;                     // board items one agent links to

const ID_WORD_RE = /(?<![\w/\\.-])(?:([a-z0-9][\w.-]*)\/)?([A-Z]{1,4}-?\d+(?:-\d+)?)(?![\w-])/g;
const PROMPT_NOISE_RE = /<(system-reminder|bash-stdout|bash-stderr|local-command-stdout)>[\s\S]*?<\/\1>/g;
export const PLAN_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit']);
export const FINISHED = new Set(['handed-off', 'accepted', 'done']);

/** ID-shaped words, in text order: `<slug>/<ID>` and bare `<ID>`, an ID being `[A-Z]{1,4}-?\d+(-\d+)?` (runs: R<n>, S<n>). */
export function idWords(text, max = 200) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;
  for (const m of text.matchAll(ID_WORD_RE)) { out.push(m[1] ? `${m[1]}/${m[2]}` : m[2]); if (out.length >= max) break; }
  return out;
}
/**
 * Adds one prompt's ID-shaped words to holder.refs (prompts, oldest first, each a list of words) and drops the text
 * (D3). At most REFS_MAX words are kept: bare IDs go first, since they only count as mentions, so a `<slug>/<ID>`
 * assignment outlives the IDs that later prompts list.
 */
export function addPrompt(holder, text) {
  const words = idWords(typeof text === 'string' ? text.replace(PROMPT_NOISE_RE, ' ') : '');
  if (!words.length) return;
  const refs = holder.refs;
  refs.push(words);
  let n = refs.reduce((a, p) => a + p.length, 0);
  for (let i = 0; i < refs.length && n > REFS_MAX; i++) {
    const p = refs[i];
    for (let k = 0; k < p.length && n > REFS_MAX;) { if (p[k].includes('/')) k++; else { p.splice(k, 1); n--; } }
  }
  while (n > REFS_MAX && refs.length) { refs[0].shift(); n--; if (!refs[0].length) refs.shift(); }
  for (let i = refs.length - 1; i >= 0; i--) if (!refs[i].length) refs.splice(i, 1);
}
export function promptRefs(text) { const h = { refs: [] }; addPrompt(h, text); return h.refs.length ? h.refs : null; }

/** Records a plan file an agent read or wrote, once per tool-use id, oldest first, at most TOUCHED_MAX. */
export function noteTouched(list, id, file, write, at) {
  if (id && list.some(x => x.id === id)) return;
  let k = list.length;
  while (k > 0 && list[k - 1].at > at) k--;
  list.splice(k, 0, { id: id || null, file, write, at });
  if (list.length > TOUCHED_MAX) list.splice(0, list.length - TOUCHED_MAX);
}
export function mergeTouched(a, b) {
  if (!b?.length) return a || [];
  if (!a?.length) return b;
  const out = [...a];
  for (const x of b) if (!x.id || !out.some(y => y.id === x.id)) out.push(x);
  return out.sort((p, q) => p.at - q.at).slice(-TOUCHED_MAX);
}

/**
 * The board file of a parsed plan, relative to its project root, rebuilt from the slug parsePlan() gave it (a phased
 * plan `docs/plans/<slug>/STATUS.md`, a small one `docs/plans/<slug>.md`, any other board `<slug>.md`). Lower-cased,
 * with forward slashes: `planFile(p)` is the same key planFileKey() makes from a path an agent read or wrote.
 */
export function planFile(p) {
  const rel = p.slug.includes('/') ? `${p.slug}.md` : p.size === 'small' ? `docs/plans/${p.slug}.md` : `docs/plans/${p.slug}/STATUS.md`;
  return `${p.project}|${rel}`.toLowerCase();
}
export const planKeyOf = p => `${p.project}|${p.slug}`;   // PLAN hud-0-3 §4.1, the key renderPlans uses

/** The plans, indexed once per snapshot for resolveWork() and boardState(). */
export function indexPlans(planList) {
  const list = [], byProject = new Map(), byKey = new Map(), files = new Map(), dirs = new Map();
  for (const p of planList) {
    const nodes = new Map();
    for (const n of [...(p.phases || []), ...(p.runs || [])]) if (!nodes.has(n.id)) nodes.set(n.id, n);
    const P = { key: planKeyOf(p), slug: p.slug.toLowerCase(), plan: p, nodes, mtime: p.touchedAt || 0 };
    list.push(P); byKey.set(P.key, P);
    if (!byProject.has(p.project)) byProject.set(p.project, []);
    byProject.get(p.project).push(P);
    const file = planFile(p);
    files.set(file, P);
    // A plan folder's PLAN.md and handoffs/ belong to its board; with two boards in one folder, to neither.
    if (p.size !== 'small') { const dir = file.slice(0, file.lastIndexOf('/')); dirs.set(dir, dirs.has(dir) ? null : P); }
  }
  return { list, byProject, byKey, files, dirs };
}
/** The plan a plan-file key belongs to: its board, or the PLAN.md or a file in handoffs/ next to the board. */
function planOfFile(file, ix) {
  const own = ix.files.get(file);
  if (own) return own;
  const cut = file.lastIndexOf('/'), dir = file.slice(0, cut), base = file.slice(cut + 1);
  if (base === 'plan.md') return ix.dirs.get(dir) || null;
  const up = dir.lastIndexOf('/');
  return up > 0 && dir.slice(up + 1) === 'handoffs' ? ix.dirs.get(dir.slice(0, up)) || null : null;
}
/** A branch `<slug>` or `<slug>/<ID or run>`, maybe followed by `-words`. Branch IDs may be in lower case. */
function branchRef(branch) {
  const m = /^([^/\s]+)(?:\/([A-Za-z]{1,4}-?\d+(?:-\d+)?)(?=$|[-_./](?!\d)))?/.exec(str(branch));
  return m ? { slug: m[1].toLowerCase(), id: m[2] ? m[2].toUpperCase() : null } : null;
}

/**
 * The board items one agent works on (PLAN hud-0-3 §4.2 steps 1 to 3). Pure. `agent` is its evidence: { project,
 * label (a session's title or a subagent's description), refs (its prompts, oldest first, each a list of ID-shaped
 * words), touched ([{ file, write, at }], oldest first), branch }. `parentWork` is the work of whoever started it, and
 * `ix` is indexPlans(). Returns { plan, items: [{ id, via, plan }], role: 'worker' } or null.
 *
 * `<slug>/<ID>` words are read from the newest prompt back, so a session given a second item works on that one. An
 * item outside the home plan keeps its own `plan`; with no home plan, the first item's plan is the agent's plan.
 */
export function resolveWork(agent, parentWork, ix) {
  const cands = ix.byProject.get(agent.project);
  if (!cands?.length) return null;
  const bySlug = slug => cands.find(P => P.slug === slug.toLowerCase()) || null;
  const prompts = agent.refs || [];
  const slugRefs = [];
  for (let i = prompts.length - 1; i >= 0; i--) {
    for (const w of prompts[i]) { const cut = w.indexOf('/'); if (cut > 0) slugRefs.push([w.slice(0, cut), w.slice(cut + 1)]); }
  }
  // 2. The home plan: the first match wins.
  let home = null;
  for (const [slug] of slugRefs) if ((home = bySlug(slug))) break;
  if (!home) {
    let pick = null, write = null;
    for (const t of agent.touched || []) {
      const P = planOfFile(t.file, ix);
      if (!P || !cands.includes(P)) continue;
      pick = { t, P };
      if (t.write) write = pick;
    }
    if (pick && !pick.t.write && write && pick.t.at - write.t.at <= 10 * 60_000) pick = write;   // a write beats a read made soon after it
    home = pick?.P ?? null;
  }
  const br = branchRef(agent.branch);
  if (!home && br) home = bySlug(br.slug);
  if (!home && parentWork?.plan) home = cands.find(P => P.key === parentWork.plan) || null;
  // 3. The items, at most ITEMS_MAX. A run links itself and its current item (its first chunk not finished).
  const items = [];
  const add = (P, id, via) => {
    const n = P.nodes.get(id);
    if (!n) return;
    for (const x of n.kind === 'run' ? [id, (n.chunks || []).find(c => !FINISHED.has(P.nodes.get(c)?.state))] : [id]) {
      if (x && items.length < ITEMS_MAX && !items.some(i => i.plan === P.key && i.id === x)) items.push({ id: x, via, plan: P.key });
    }
  };
  for (const [slug, id] of slugRefs) { const P = bySlug(slug); if (P?.nodes.has(id)) { add(P, id, 'ref'); break; } }
  for (const w of idWords(agent.label || '')) {
    const cut = w.indexOf('/'), id = cut > 0 ? w.slice(cut + 1) : w;
    let P = cut > 0 ? bySlug(w.slice(0, cut)) : null;
    if (!P?.nodes.has(id)) {
      const having = cands.filter(c => c.nodes.has(id));
      const open = having.filter(c => !FINISHED.has(c.nodes.get(id).state));
      P = home?.nodes.has(id) ? home : having.length === 1 ? having[0] : open.length === 1 ? open[0] : null;   // else: nothing (D2)
    }
    if (P) add(P, id, 'name');
  }
  if (br?.id) { const P = bySlug(br.slug); if (P) add(P, br.id, 'branch'); }
  const plan = home?.key ?? items[0]?.plan ?? null;
  return plan ? { plan, items, role: 'worker' } : null;
}
/** Resolves every agent, parents first (step 2.4), then step 4: whoever has a subagent linked in its own plan coordinates. */
export function linkAgents(agents, ix) {
  const byKey = new Map(agents.map(e => [e.key, e]));
  const visit = (e, depth) => {
    if (e.work !== undefined) return e.work;
    e.work = null;                        // an agent in a cycle of parents resolves without one
    const p = e.parent ? byKey.get(e.parent) : null;
    return (e.work = resolveWork(e, p && depth < 20 ? visit(p, depth + 1) : null, ix));
  };
  for (const e of agents) visit(e, 0);
  for (const e of agents) {
    const p = e.agentId && e.parent ? byKey.get(e.parent) : null;
    if (p?.work && e.work?.items.some(i => i.plan === p.work.plan)) p.work.role = 'coordinator';
  }
}

/** The evidence of every session and subagent in the state's list (§4.2): parents are keyed `<sessionId>` and `<sessionId>/<id>`. */
export function liveAgents(list, findSession) {
  const out = [];
  for (const x of list) {
    const s = findSession(x.id), info = s?.tail?.info;
    out.push({ key: x.id, parent: x.startedBy || null, sessionId: x.id, agentId: null, view: x, project: x.project,
      label: x.title, refs: info?.refs, touched: mergeTouched(info?.touched, s?.touched), branch: x.branch,
      active: x.status === 'busy' || x.status === 'needs-you' });
    for (const a of x.subagents || []) {
      const sub = s && (s.byAgent.get(a.id) || s.byToolUse.get(a.id));
      const own = sub ? sub.tail?.info : findSession(a.id)?.tail?.info;   // or a Codex child session drawn as a subagent
      out.push({ key: `${x.id}/${a.id}`, parent: a.parentId === x.id ? x.id : `${x.id}/${a.parentId}`, sessionId: x.id, agentId: a.id,
        view: a, project: x.project, label: a.description, refs: sub ? sub.refs || own?.refs : null,
        touched: sub ? mergeTouched(own?.touched, sub.touched) : [], branch: own?.branch || x.branch, active: a.state === 'running' });
    }
  }
  return out;
}

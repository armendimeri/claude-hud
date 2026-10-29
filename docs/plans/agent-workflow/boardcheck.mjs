// Check plan files against STANDARD §4-§6: header line, exact board header, IDs, states, dependencies (with ranges),
// model/effort, handoff links, required STATUS sections. Usage: node boardcheck.mjs <repo>
import fs from 'node:fs'; import path from 'node:path';
const repo = process.argv[2]; const plansDir = path.join(repo, 'docs', 'plans'); const problems = []; const seen = [];
const HEADER = '| ID | Item | Agent | Depends on | Model / effort | State | Since | Handoff | Notes |';
const STATES = new Set(['todo', 'in-progress', 'blocked', 'partial', 'handed-off', 'accepted', 'bounced']);
const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
function checkBoard(file, text, phased) {
  seen.push(path.relative(repo, file));
  const lines = text.split(/\r?\n/);
  const bi = lines.findIndex(l => /^## Board\s*$/.test(l));
  if (bi < 0) return problems.push(`${file}: no "## Board"`);
  const hi = lines.findIndex((l, i) => i > bi && l.startsWith('|'));
  if (lines[hi].trim() !== HEADER) problems.push(`${file}: board header is "${lines[hi].trim()}"`);
  const rows = []; for (let i = hi + 2; i < lines.length && lines[i].startsWith('|'); i++) rows.push(cells(lines[i]));
  const ids = rows.map(r => r[0]);
  if (new Set(ids).size !== ids.length) problems.push(`${file}: duplicate IDs`);
  if (phased && ids[0] !== 'P0') problems.push(`${file}: phased plan does not start with P0`);
  for (const r of rows) {
    const [id, , , deps, me, state, since, handoff] = r;
    if (!/^(P\d+(-\d{2})?|O-\d+|[A-Z]{1,4}-\d+)$/.test(id)) problems.push(`${file}: bad ID ${id}`);
    if (!STATES.has(state)) problems.push(`${file}: ${id} state "${state}"`);
    if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) problems.push(`${file}: ${id} since "${since}"`);
    if (deps !== '—') for (const d0 of deps.split(/,\s*/)) {
      const d = d0.replace(/[`*]/g, '');
      const range = /^(.+?)\s*(?:–|—| to )\s*(.+)$/.exec(d);
      for (const x of range ? [range[1], range[2]] : [d]) if (!ids.includes(x) && !x.includes('/')) problems.push(`${file}: ${id} depends on unknown "${x}"`);
    }
    if (me !== '—' && !/^[A-Z][\w. ]+ \/ (low|medium|high|xhigh|max)$/.test(me)) problems.push(`${file}: ${id} model/effort "${me}"`);
    if (phased && ['handed-off', 'accepted', 'bounced'].includes(state) && id !== 'P0') {
      const m = /\(([^)]+)\)/.exec(handoff || '');
      if (!m || !fs.existsSync(path.join(path.dirname(file), m[1]))) problems.push(`${file}: ${id} is ${state} but its handoff link "${handoff}" does not resolve`);
    }
  }
  const planFile = phased ? path.join(path.dirname(file), 'PLAN.md') : file;
  const head = fs.existsSync(planFile) ? fs.readFileSync(planFile, 'utf8').split(/\r?\n/).find(l => /^Status: \*\*/.test(l)) : null;
  if (!head || !/^Status: \*\*(proposed|approved|building|verified)\*\*/.test(head)) problems.push(`${planFile}: header line "${head}"`);
  return rows;
}
let ents = []; try { ents = fs.readdirSync(plansDir, { withFileTypes: true }); } catch {}
for (const e of ents) {
  const p = path.join(plansDir, e.name);
  if (e.isFile() && e.name.endsWith('.md')) checkBoard(p, fs.readFileSync(p, 'utf8'), false);
  if (e.isDirectory()) {
    const st = path.join(p, 'STATUS.md');
    if (!fs.existsSync(st)) { problems.push(`${p}: folder without STATUS.md`); continue; }
    const t = fs.readFileSync(st, 'utf8');
    checkBoard(st, t, true);
    for (const h of ['## Decisions (P0)', '## Log', '## Kickoff', '## Questions']) if (!t.includes(h)) problems.push(`${st}: missing "${h}"`);
    if (/^## Protocol/m.test(t)) problems.push(`${st}: copies the protocol`);
  }
}
console.log(JSON.stringify({ plans: seen, problems }, null, 1));

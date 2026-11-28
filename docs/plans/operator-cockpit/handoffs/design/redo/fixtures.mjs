// Synthetic public snapshots for the look study. Same shape as /api/state (only the fields the cockpit reads).
// Every name here is invented. `tick(snapshot, now)` advances a fixture by one simulated event so the prototype
// shows tool calls, subagents finishing (the green completion pulse) and new work starting.

const MIN = 60_000;
const tok = (o = 1) => ({ input: 2400 * o, output: 900 * o, cacheRead: 41000 * o, cacheWrite: 3100 * o });
let seq = 0;

function session(now, project, title, status, extra = {}) {
  const id = extra.id || `fx:${project.toLowerCase()}/${++seq}`;
  return {
    id, agent: extra.agent || 'claude', project, cwd: '/work/' + project.toLowerCase(), title, name: title,
    entrypoint: 'cli', status, needsYou: null, provider: extra.provider || 'anthropic',
    model: extra.model || 'Opus 5.5', modelRaw: 'claude-opus-5-5', effort: extra.effort || 'high', branch: extra.branch || 'main',
    startedAt: now - (extra.age ?? 20) * MIN, lastActivityAt: now - 4000, endedAt: null,
    currentTool: status === 'busy' ? { name: extra.tool?.[0] || 'Read', summary: extra.tool?.[1] || 'src/index.mjs', since: now - 3000 } : null,
    tools: 12, startedBy: extra.startedBy || null, tokens: tok(extra.o || 1), tokensTree: tok(extra.o || 1),
    context: { used: 0.42, window: 200000 }, subagents: extra.subagents || [], agentsRunning: (extra.subagents || []).filter(a => a.state === 'running').length,
    ...extra.fields,
  };
}
function sub(now, sessionId, type, description, state, extra = {}) {
  return {
    id: extra.id || `toolu_${type.toLowerCase()}_${++seq}`, parentId: extra.parentId || sessionId, depth: extra.depth || 1, type, description,
    model: 'Opus 5.5', provider: 'anthropic', state, background: false, startedAt: now - (extra.age ?? 3) * MIN,
    endedAt: state === 'done' ? now - (extra.doneAgo ?? 2) * MIN : null, lastActivityAt: now - 3000,
    currentTool: state === 'running' ? { name: extra.tool?.[0] || 'Grep', summary: extra.tool?.[1] || 'invoice', since: now - 2000 } : null,
    tokens: tok(0.3), context: null,
  };
}
function wait(s, now, reason = 'Which date should the export use?', kind = 'question') {
  s.status = 'needs-you';
  s.needsYou = { since: now - 42_000, kind, reason };
  s.currentTool = null;
  return s;
}
function finish(snapshot) {
  const live = snapshot.sessions.filter(s => s.status !== 'ended');
  const subs = live.reduce((n, s) => n + s.agentsRunning, 0);
  snapshot.totals = {
    sessions: live.length, needsYou: live.filter(s => s.status === 'needs-you').length,
    busy: live.filter(s => s.status === 'busy').length, subagentsRunning: subs,
    agentsRunning: live.filter(s => s.status === 'busy' || s.status === 'needs-you').length + subs,
  };
  return snapshot;
}
const base = (now, sessions) => finish({ now, uptime: 3 * 3600_000, demo: true, version: 'look-study', host: 'STUDIO', hooksInstalled: true,
  sessions, projects: [], plans: [], board: {}, alerts: [], feed: [], external: [], externalError: null, account: null });

export function sparse(now = Date.now()) {
  seq = 0;
  const a = session(now, 'Ledger', 'Reconcile the quarterly invoice export against the ledger', 'busy', { id: 'fx:ledger/reconcile', tool: ['Read', 'export.mjs'], age: 34, o: 3 });
  a.subagents = [
    sub(now, a.id, 'Explore', 'Review export totals', 'running', { id: 'toolu_explore_1', tool: ['Grep', 'cut-off date'] }),
    sub(now, a.id, 'Plan', 'Draft the migration', 'done', { id: 'toolu_plan_1', doneAgo: 4 }),
  ];
  a.agentsRunning = 1;
  const b = wait(session(now, 'Ledger', 'Export', 'busy', { id: 'fx:ledger/export', age: 12 }), now);
  const c = session(now, 'Reports', 'Weekly revenue summary', 'busy', { id: 'fx:reports/weekly', tool: ['Edit', 'summary.md'], provider: 'openai', agent: 'codex', model: 'GPT 6.2', age: 8 });
  return base(now, [a, b, c]);
}

const PROJECTS = {
  Ledger: ['Reconcile quarterly invoice totals', 'Export', 'Check totals', 'Audit trail for refunds', 'Close period checklist', 'Fix rounding in VAT lines', 'Ledger API pagination'],
  Reports: ['Weekly revenue summary', 'Churn cohort chart', 'Board pack figures', 'Fix report timezone', 'Margin by region', 'Archive old dashboards'],
  Imports: ['Stream the CSV importer', 'Bank feed retries', 'Map new supplier codes', 'Dedupe imported rows'],
  Invoices: ['PDF layout for credit notes', 'Late-payment reminders', 'Invoice numbering gaps', 'Currency on reprints'],
  Atlas: ['Upgrade the build to Node 24', 'Flaky e2e on checkout', 'Docs site search'],
};
const TOOLS = [['Read', 'export.mjs'], ['Edit', 'ledger/totals.mjs'], ['Bash', 'npm test'], ['Grep', 'roundHalfEven'], ['Write', 'report.md'], ['WebFetch', 'docs.example.com'], ['Glob', 'src/**/*.csv']];
const SUBS = [['Explore', 'Find the cut-off logic'], ['Plan', 'Plan the migration'], ['general-purpose', 'Check edge cases'], ['Explore', 'Trace the API calls'], ['code-review', 'Review the diff']];

export function dense(now = Date.now()) {
  seq = 0;
  const sessions = [];
  // State plan per session index: w = working, n = needs you, a = agents working, i = idle, d = idle with finished subs
  const plan = { Ledger: 'wnwaiid', Reports: 'wwiiad', Imports: 'wiid', Invoices: 'wiii', Atlas: 'wii' };
  let t = 0;
  for (const [project, titles] of Object.entries(PROJECTS)) {
    titles.forEach((title, i) => {
      const kind = plan[project][i] || 'i';
      const tool = TOOLS[(t++) % TOOLS.length];
      const s = session(now, project, title, kind === 'w' ? 'busy' : 'idle', { id: `fx:${project.toLowerCase()}/${i + 1}`, tool, age: 5 + ((t * 7) % 50), o: 1 + (t % 4),
        provider: t % 5 === 3 ? 'openai' : t % 7 === 4 ? 'bedrock' : 'anthropic' });
      if (kind === 'n') wait(s, now);
      if (kind === 'w' && t % 2 === 0) {
        const [type, desc] = SUBS[t % SUBS.length];
        s.subagents = [sub(now, s.id, type, desc, 'running', { tool: TOOLS[(t + 2) % TOOLS.length] })];
        if (t % 4 === 0) s.subagents.push(sub(now, s.id, ...SUBS[(t + 1) % SUBS.length], 'done', { doneAgo: 1 }));
      }
      if (kind === 'a') s.subagents = [sub(now, s.id, ...SUBS[t % SUBS.length], 'running'), sub(now, s.id, ...SUBS[(t + 2) % SUBS.length], 'running', { tool: ['Bash', 'npm run lint'] })];
      if (kind === 'd') s.subagents = [sub(now, s.id, ...SUBS[t % SUBS.length], 'done', { doneAgo: 6 })];
      s.agentsRunning = s.subagents.filter(a => a.state === 'running').length;
      sessions.push(s);
    });
  }
  return base(now, sessions);
}

/** One simulated event: a tool call, a subagent finishing, or a new subagent. Returns a new snapshot. */
export function tick(snapshot, now, step) {
  const next = structuredClone(snapshot);
  next.now = now;
  const working = next.sessions.filter(s => s.status === 'busy');
  const kind = step % 3;
  if (kind === 0 && working.length) {
    const s = working[step % working.length];
    s.currentTool = { name: TOOLS[step % TOOLS.length][0], summary: TOOLS[step % TOOLS.length][1], since: now };
  } else if (kind === 1) {
    // A running subagent finishes: the completion pulse.
    for (const s of next.sessions) {
      const running = s.subagents.find(a => a.state === 'running');
      if (running && (step + s.id.length) % 2 === 0) { running.state = 'done'; running.endedAt = now; running.currentTool = null; break; }
    }
  } else {
    // A working session starts a new subagent (and old finished ones fall away so the scene stays the same size).
    const s = working[(step >> 1) % Math.max(1, working.length)];
    if (s) {
      s.subagents = s.subagents.filter(a => a.state === 'running' || now - a.endedAt < 20_000);
      if (s.subagents.length < 3) s.subagents.push(sub(now, s.id, ...SUBS[step % SUBS.length], 'running', { age: 0, id: 'toolu_sim_' + step }));
    }
  }
  for (const s of next.sessions) s.agentsRunning = s.subagents.filter(a => a.state === 'running').length;
  return finish(next);
}

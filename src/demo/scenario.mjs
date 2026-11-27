import { randomUUID } from 'node:crypto';
import { compareSessions, projectSnapshot } from '../app/publish.mjs';
import { CONTEXT_WINDOWS, MINUTE_MS, addPulse, addTokens, contextFor, minuteOf, normalizeModel, pulseView, startOfDay, zero } from '../domain/models.mjs';
import { planKeyOf } from '../domain/board-links.mjs';
import { HISTORY_MAX, boardMarkText, followBoards, newTrack } from '../domain/board-status.mjs';
import { alertsFor } from '../domain/alerts.mjs';

// Simulated sessions, subagents, boards and feed for both demo sizes.
export function createDemo(mode, { unclaimedMs, stalledMs }, lifetime, publisher, clock = Date.now) {
  const { appendFeed, invalidate: scheduleState } = publisher;
  const push = { enabled: false, lastError: null };
  const dense = mode === 'dense';
  const t0 = clock();
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const repo = p => `C:\\Users\\demo\\source\\repos\\${p}`;
  const TOOLS = [
    ['Read', 'src/Quotations/QuotationTotals.cs'], ['Edit', 'src/Quotations/QuotationTotals.cs'], ['Bash', 'dotnet test -c Release --no-build --filter Quotation'],
    ['Grep', 'VatRate in src'], ['Glob', '**/*.razor'], ['Bash', 'git status --short'], ['WebFetch', 'learn.microsoft.com/en-us/aspnet/core/blazor'],
    ['Write', 'docs/plans/history/handoffs/P2-history-ui.md'], ['PowerShell', 'Get-ChildItem -Recurse -Filter *.sql | Measure-Object'],
    ['Read', 'Program.cs'], ['Bash', 'sqlcmd -S localhost -d WM2 -Q "SELECT COUNT(*) FROM Customers"'], ['WebSearch', 'Blazor virtualize grouped list'],
  ];
  const AGENT_JOBS = [['Explore', 'Map the quotation totals code'], ['general-purpose', 'Check the VAT rounding rules'], ['web-fetch', 'Read the Syncfusion grid docs'],
    ['Explore', 'Find every caller of SaveCustomer'], ['general-purpose', 'Write the migration script test']];
  const tok = scale => ({ input: Math.round(rnd(2, 40) * scale), output: Math.round(rnd(800, 9000) * scale), cacheRead: Math.round(rnd(40_000, 400_000) * scale), cacheWrite: Math.round(rnd(4_000, 40_000) * scale) });
  const sessionsList = [];
  const addFeed = (s, kind, text, action = null, at = clock()) => {
    const line = { at, sessionId: s?.id ?? null, project: s?.project ?? null, kind, text };
    if (action) line.action = action;
    appendFeed(line);
  };
  // Board following (hud-0-3 P4): each agent's made-up evidence beside its label and branch, the marks' clocks, and the
  // marks already announced. The demo's state goes through the same followBoards() as the real one.
  const evidence = new Map();   // session or subagent id -> { refs, touched }
  const demoPulses = new WeakMap(), demoAlerts = new Map();
  const track = new Map(), announced = new Set();
  const WM2_SLUG = 'customer-history-and-change-requests';

  function session(o) {
    const model = o.modelRaw || 'claude-opus-5-5';
    const mi = normalizeModel(model);
    const s = {
      id: randomUUID(), agent: o.agent || 'claude', pid: rnd(2000, 60000), project: o.project, cwd: repo(o.folder || o.project), name: `${o.project.toLowerCase()}-${rnd(16, 255).toString(16)}`,
      title: o.title, entrypoint: o.entrypoint || 'claude-vscode', version: '2.1.312', status: o.status,
      needsYou: o.needsYou ? { since: t0 - (o.needsFor || 60) * 1000, reason: o.needsYou, kind: o.needsKind || 'permission' } : null,
      provider: o.agent === 'codex' ? 'openai' : mi.provider, model: mi.model, modelRaw: model, effort: o.effort || 'high', branch: o.branch || 'main',
      startedAt: t0 - (o.age || 1800) * 1000, lastActivityAt: t0 - (o.quiet || 2) * 1000, endedAt: o.status === 'ended' ? t0 - (o.endedAgo || 180) * 1000 : null,
      currentTool: null, tools: rnd(6, 180), startedBy: null, tokens: tok(o.scale || 1), tokensTree: null, context: null, subagents: [],
      turn: { startedAt: o.status === 'busy' ? t0 - 30_000 : null, lastMs: 94_000 },
      _ctx: o.ctx ?? rnd(6, 48),
    };
    if (s.status === 'busy' || s.status === 'needs-you') setTool(s);
    if (o.refs || o.touched) evidence.set(s.id, { refs: o.refs, touched: o.touched });
    sessionsList.push(s);
    return s;
  }
  function sub(s, parentId, depth, [type, description], o = {}) {
    const model = o.modelRaw || pick(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
    const mi = normalizeModel(model);
    const a = { id: `a${randomUUID().replace(/-/g, '').slice(0, 16)}`, parentId, depth, description, type, model: mi.model, modelRaw: model, provider: s.provider,
      state: o.state || 'running', background: !!o.background, startedAt: clock() - (o.age || 40) * 1000, endedAt: o.state === 'done' ? clock() - 20_000 : null,
      tokens: tok(0.3), context: null, currentTool: null, _ctx: rnd(5, 40) };
    if (a.state === 'running') setTool(a);
    if (o.refs || o.touched) evidence.set(a.id, { refs: o.refs, touched: o.touched });
    s.subagents.push(a);
    return a;
  }
  function setTool(x) { const [name, summary] = pick(TOOLS); x.currentTool = { name, summary, since: clock() - rnd(0, 20) * 1000 }; }
  function noteOutput(x, at, output, current) {
    let buckets = demoPulses.get(x);
    if (!buckets) { buckets = new Map(); demoPulses.set(x, buckets); }
    addPulse(buckets, minuteOf(at), output, current);
  }
  function grow(x, now) {
    const output = rnd(20, 400);
    x.tokens.output += output; x.tokens.cacheRead += rnd(2_000, 30_000); x.tokens.cacheWrite += rnd(0, 3_000); x.tokens.input += rnd(0, 3);
    noteOutput(x, now, output, minuteOf(now));
  }

  // Board links (hud-0-3 P4), one of each kind: the FidiaCRM session by the IDs in its title (R14, so its current chunk
  // UX-10 too), the coordinator by its title and the board it wrote, its first subagent by the `<slug>/<ID>` of its
  // prompt, the Codex session by its title (UX-12, started early), the TourCMS waiter by its branch, and its subagent by
  // its description (P4, worked on while todo: "board not updated").
  let coordinator, flipper, cycler = null, explore = null, codex = null, waiter = null;
  if (!dense) {
    const needs = session({ project: 'FidiaCRM', folder: 'Fidia CRM', title: 'R14 quotation screens: totals, VAT rows and the discount line', status: 'needs-you', needsYou: 'Permission: Bash', needsFor: 95, branch: 'ux/R14-quotation-wizard', scale: 2, ctx: 82 });
    noteOutput(needs, t0 - 4 * MINUTE_MS, 2100, minuteOf(t0));
    coordinator = session({ project: 'WasteManagement2', title: 'Coordinator: customer history plan, phases P2 and P3', status: 'busy', branch: 'customer-history', scale: 4, ctx: 42, age: 5400,
      touched: [{ id: 'demo-edit-1', file: `wastemanagement2|docs/plans/${WM2_SLUG}/status.md`, write: true, at: t0 - 600_000 }] });
    explore = sub(coordinator, coordinator.id, 1, ['general-purpose', 'P2 history tab and header'], { age: 120, refs: [[`${WM2_SLUG}/P2`]] });
    sub(coordinator, explore.id, 2, AGENT_JOBS[1], { age: 50, modelRaw: 'claude-haiku-5-5' });
    cycler = sub(coordinator, coordinator.id, 1, AGENT_JOBS[2], { age: 10, modelRaw: 'claude-haiku-5-5' });
    codex = session({ project: 'FidiaCRM', agent: 'codex', entrypoint: 'cli', title: 'Clients: contact length limits (UX-12)', status: 'idle', branch: 'clients/UX-12', quiet: 900, effort: 'medium', modelRaw: 'gpt-6-astra' });
    const ended = session({ project: 'WasteManagement2', title: 'Say hi', status: 'ended', endedAgo: 180, age: 240, effort: 'low', modelRaw: 'claude-haiku-5-5', scale: 0.1 });
    ended.startedBy = coordinator.id;
    waiter = session({ project: 'TourCMS', title: 'Booking changes: waiting on the review agent', status: 'idle', quiet: 40, branch: 'booking-changes/P4-price-check', modelRaw: 'claude-sonnet-5-5', effort: 'medium' });
    sub(waiter, waiter.id, 1, ['general-purpose', 'P4 price check for changed dates'], { age: 90, background: true });   // hud-0-3 D6: "Agents working"
    flipper = session({ project: 'ImPOS-Maui', title: 'Phone app phase 7: battery and Xiaomi autostart switches, runbook for the real-phone pass on the Samsung and the support notes for the shop owners', status: 'busy', branch: 'phone-app', modelRaw: 'us.anthropic.claude-sonnet-5-5-v1:0', scale: 2 });
    addFeed(undefined, 'done', 'Turn finished', 'turn-finished', t0 - 6 * MINUTE_MS);
    addFeed(needs, 'needs-you', 'Permission: Bash');
    addFeed(coordinator, 'done', 'Agent done · Explore: map the change history code', 'agent-done');
    addFeed(codex, 'done', 'Codex turn complete', 'turn-finished');
    addFeed(waiter, 'done', 'Turn finished', 'turn-finished');
    addFeed(waiter, 'plan', 'Booking changes: P1 in-progress → handed-off', 'item-changed');
  } else {
    const projects = ['FidiaCRM', 'WasteManagement2', 'ImPOS-Maui', 'TourCMS', 'Aegis', 'fidiagraf.com'];
    const statuses = ['needs-you', 'busy', 'busy', 'idle', 'busy', 'idle', 'ended', 'busy'];
    for (let i = 0; i < 24; i++) {
      const status = statuses[i % statuses.length];
      const s = session({ project: projects[i % projects.length], title: `${pick(['Fix', 'Build', 'Review', 'Plan', 'Migrate'])} ${pick(['quotation totals', 'the history tab', 'Xiaomi autostart', 'booking changes', 'the tour calendar', 'invoice OCR', 'the deployment guide for the first agency server'])}`,
        status, needsYou: status === 'needs-you' ? pick(['Permission: Bash', 'Question for you', 'Permission: Edit']) : null, modelRaw: i % 7 === 3 ? 'global.anthropic.claude-opus-5-5-v1:0' : pick(['claude-opus-5-5', 'claude-sonnet-5-5']), quiet: status === 'idle' ? rnd(60, 3000) : 2,
        refs: i === 1 ? [[`${WM2_SLUG}/P2`]] : undefined });
      if (status === 'busy' && i % 3 === 1) {
        const a = sub(s, s.id, 1, i === 1 ? ['general-purpose', 'P3 change requests'] : pick(AGENT_JOBS));
        if (i % 2) sub(s, a.id, 2, pick(AGENT_JOBS));
      }
      if (i === 3) sub(s, s.id, 1, pick(AGENT_JOBS), { background: true });   // an idle parent waiting on a subagent (D6)
    }
    coordinator = sessionsList[1];
  }

  const PLAN_STEPS = [
    ['in-progress', 'todo', 'todo', 'todo'], ['handed-off', 'todo', 'todo', 'todo'], ['accepted', 'in-progress', 'in-progress', 'todo'],
    ['accepted', 'handed-off', 'in-progress', 'todo'], ['accepted', 'handed-off', 'handed-off', 'todo'], ['accepted', 'accepted', 'bounced', 'in-progress'],
    ['accepted', 'accepted', 'in-progress', 'blocked'], ['accepted', 'accepted', 'handed-off', 'in-progress'], ['accepted', 'accepted', 'accepted', 'handed-off'],
  ];
  const plan = {
    project: 'WasteManagement2', slug: 'customer-history-and-change-requests', title: 'Customer change history and change requests',
    path: `${repo('WasteManagement2')}\\docs\\plans\\customer-history-and-change-requests\\STATUS.md`,
    phases: [['P1', 'Data and history', 'data', []], ['P2', 'History tab and header', 'history-ui', ['P1']], ['P3', 'Change requests in the service', 'requests', ['P1']], ['P4', 'Verification and cleanup', 'verify', ['P2', 'P3']]]
      .map(([id, name, agent, waitsFor]) => ({ id, name, agent, state: 'todo', stateRaw: 'todo', since: null, waitsFor, notes: waitsFor.length ? `Waits for ${waitsFor.join(' and ')}` : null, group: 'Board', kind: 'phase', model: 'Opus 5.5', effort: 'high', handoff: false })),
    format: 'standard', size: 'phased', state: 'building', stateDate: null, needsYou: [],
    runs: [], lastLog: ['2026-10-29 · planner · — · Plan written.', '2026-10-29 · planner · P0 · All decisions confirmed. P1 can start.'],
    touchedAt: t0, history: [],
  };
  const chunkPlan = {
    project: 'FidiaCRM', slug: 'Documentation/Implementation/STATUS', title: 'Implementation', path: `${repo('FidiaCRM')}\\Documentation\\Implementation\\STATUS.md`,
    phases: [
      ...['Spec, tokens, gates', 'Frame and action bars', 'Table system'].map((name, i) => ({ id: `UX-0${i + 1}`, name, agent: null, state: 'done', stateRaw: 'done (2026-10-28)', since: '2026-10-28', waitsFor: i ? [`UX-0${i}`] : [], notes: null, group: 'Phase 12: UI/UX upgrade', kind: 'chunk', model: 'Opus 5.5', effort: 'high' })),
      // UX-12 was claimed before the owner input it waits for (started early); UX-13 has had nobody on it for 50 minutes (stalled).
      ...['Quotation wizard and case wizard', 'Quotations', 'Clients', 'Invoices'].map((name, i) => ({ id: `UX-1${i}`, name, agent: null, state: i === 1 ? 'todo' : 'in-progress', stateRaw: i === 1 ? 'todo' : 'in progress (2026-10-29)', since: i === 1 ? null : '2026-10-29', waitsFor: i === 2 ? ['UX-03', 'O-9'] : ['UX-03'], notes: null, group: 'Phase 12: UI/UX upgrade', kind: 'chunk', model: i % 2 ? 'Sonnet 5.5' : 'Opus 5.5', effort: 'high' })),
      { id: 'UX-20', name: 'Sweep and owner review', agent: null, state: 'todo', stateRaw: 'todo', since: null, waitsFor: ['UX-10', 'UX-11', 'UX-12', 'UX-13'], notes: null, group: 'Phase 12: UI/UX upgrade', kind: 'chunk', model: 'Opus 5.5', effort: 'high' },
      { id: 'O-9', name: 'Production column sizes for client contacts', agent: null, state: 'todo', stateRaw: 'wanted', since: null, waitsFor: [], notes: null, group: 'Owner inputs', kind: 'input', model: null, effort: null },
    ],
    runs: [
      { id: 'R14', name: 'Quotation screens', agent: null, state: 'in-progress', stateRaw: 'in progress (2026-10-29)', since: '2026-10-29', waitsFor: ['UX-03'], notes: null, group: 'Runs', kind: 'run', model: 'Opus 5.5', effort: 'high', lane: 'A', chunks: ['UX-10', 'UX-11'], startWhen: 'UX-06 done' },
      { id: 'R15', name: 'Clients screens', agent: null, state: 'todo', stateRaw: 'todo', since: null, waitsFor: ['O-9'], notes: null, group: 'Runs', kind: 'run', model: 'Sonnet 5.5', effort: 'high', lane: 'B', chunks: ['UX-12'], startWhen: 'O-9 is in' },
    ],
    format: 'legacy', size: 'phased', state: null, stateDate: null,
    needsYou: [{ kind: 'question', id: '3', item: 'UX-12', text: 'Contact names longer than 60 characters: cut them, or widen the column to 120?' }],
    lastLog: [],
    touchedAt: t0 - 50 * 60_000,
    history: [{ at: t0 - 50 * 60_000, id: 'UX-13', from: 'todo', to: 'in-progress', sessionId: null, agentId: null },
      ...(codex ? [{ at: t0 - 20 * 60_000, id: 'UX-12', from: 'todo', to: 'in-progress', sessionId: codex.id, agentId: null }] : [])],
  };
  // One of each list (D5): P1 waits to be accepted, P2 is ready, O-1 is the owner input P3 waits for. P4 is worked on.
  const smallPlan = {
    project: 'TourCMS', slug: 'booking-changes', title: 'Booking changes', path: `${repo('TourCMS')}\\docs\\plans\\booking-changes.md`,
    format: 'standard', size: 'small', state: 'approved', stateDate: '2026-10-28',
    needsYou: [{ kind: 'decision', id: 'D2', text: 'D2 A changed booking keeps its original price unless the tour price went down ★' }],
    phases: [['P1', 'Change dates', 'handed-off', [], 'bookings'], ['P2', 'Change people', 'todo', ['P1'], 'bookings'], ['P3', 'Refunds for changed bookings', 'todo', ['P1', 'O-1'], 'bookings'],
      ['O-1', 'Refund policy from the owner', 'todo', [], 'owner'], ['P4', 'Price check for changed dates', 'todo', [], 'pricing']]
      .map(([id, name, state, waitsFor, agent]) => ({ id, name, agent, state, stateRaw: state, since: state === 'todo' ? null : '2026-10-29', waitsFor, notes: null, group: 'Board', kind: id.startsWith('O-') ? 'input' : 'item',
        model: agent === 'owner' ? null : 'Sonnet 5.5', effort: agent === 'owner' ? null : 'high', handoff: id === 'P1' })),
    runs: [], lastLog: [],
    touchedAt: t0 - 2 * 3600_000,
    history: waiter ? [{ at: t0 - 3 * 3600_000, id: 'P1', from: 'todo', to: 'in-progress', sessionId: waiter.id, agentId: null },
      { at: t0 - 2 * 3600_000, id: 'P1', from: 'in-progress', to: 'handed-off', sessionId: waiter.id, agentId: null },
      ...[['unknown', 'todo'], ['todo', 'in-progress'], ['in-progress', 'partial'], ['partial', 'todo']].map(([from, to], i) => ({
        id: 'P4', from, to, at: t0 - (8 - i) * 60_000, sessionId: waiter.id, agentId: waiter.subagents[0].id,
      }))] : [],
  };
  const quietPlans = [
    { ...smallPlan, slug: 'currency-display', title: 'Currency display', path: `${repo('TourCMS')}\\docs\\plans\\currency-display.md`,
      state: 'closed', needsYou: [], touchedAt: t0 - 86_400_000, history: [],
      phases: [{ ...smallPlan.phases[0], state: 'accepted', stateRaw: 'accepted' }] },
    { ...smallPlan, slug: 'archived-booking-notes', title: 'Archived booking notes', path: `${repo('TourCMS')}\\docs\\plans\\archived-booking-notes.md`,
      format: 'legacy', state: null, needsYou: [], touchedAt: t0 - 16 * 86_400_000, history: [], phases: [smallPlan.phases[1]] },
  ];
  for (const n of [...plan.phases, ...chunkPlan.phases, ...chunkPlan.runs, ...smallPlan.phases]) { n.waitsForOther = []; n.handoff ??= false; }
  // The marks' clocks: P4 has been worked on for 4 minutes, UX-12's Codex session was last busy 15 minutes ago.
  track.set(`TourCMS|booking-changes#P4`, { ...newTrack(), inFlightSince: t0 - 4 * 60_000 });
  track.set(`FidiaCRM|${chunkPlan.slug}#UX-12`, { ...newTrack(), lastInFlightAt: t0 - 15 * 60_000 });
  const projectList = [
    { project: 'FidiaCRM', root: repo('FidiaCRM'), headline: null, standard: false, git: null },
    { project: 'ImPOS-Maui', root: repo('ImPOS-Maui'), headline: 'Point of sale for small shops: a MAUI phone app and a Blazor back office.', standard: true, git: 'you commit' },
    { project: 'TourCMS', root: repo('TourCMS'), headline: 'Tour booking site and its back office.', standard: true, git: 'you commit' },
    { project: 'WasteManagement2', root: repo('WasteManagement2'), headline: 'Waste collection contracts, tickets and drivers for a municipal operator.', standard: true, git: 'you commit' },
  ];
  const external = dense ? [] : [
    { source: 'ingest', app: 'invoice-ocr', provider: 'bedrock', model: 'claude-haiku-5-5', modelRaw: 'anthropic.claude-haiku-5-5', tokens: tok(0.5), windowStart: startOfDay(t0), windowEnd: t0, delayed: false },
    { source: 'ingest', app: 'support-bot', provider: 'bedrock', model: 'claude-sonnet-5-5', modelRaw: 'us.anthropic.claude-sonnet-5-5-v1:0', tokens: tok(1), windowStart: startOfDay(t0), windowEnd: t0, delayed: false },
    { source: 'cloudwatch', app: null, provider: 'bedrock', model: 'claude-sonnet-5-5', modelRaw: 'us.anthropic.claude-sonnet-5-5-v1:0', tokens: tok(3), windowStart: startOfDay(t0), windowEnd: t0 - 300_000, delayed: true },
  ];
  const acct = { fiveHour: { pct: 42, resetsAt: t0 + 2.4 * 3600_000 }, sevenDay: { pct: 31, resetsAt: t0 + 3.2 * 86400_000 }, fetchedAt: t0 };
  let planStep = -1;

  function tick() {
    const now = clock();
    for (const s of sessionsList) {
      if (s.status === 'busy') { grow(s, now); s.lastActivityAt = now; if (Math.random() < 0.18) { setTool(s); s.tools++; addFeed(s, 'tool', `${s.currentTool.name} · ${s.currentTool.summary}`); } }
      for (const a of s.subagents) if (a.state === 'running') { grow(a, now); a.lastActivityAt = now; if (Math.random() < 0.15) { setTool(a); addFeed(s, 'tool', `${a.type} › ${a.currentTool.name} · ${a.currentTool.summary}`); } }
    }
    if (coordinator && coordinator.status === 'busy') {
      if (now - coordinator.turn.startedAt >= 60_000) {
        coordinator.turn = { startedAt: now, lastMs: now - coordinator.turn.startedAt };
        addFeed(coordinator, 'done', 'Turn finished', 'turn-finished');
      }
      coordinator._ctx += 0.6;
      if (coordinator._ctx > 91) { coordinator._ctx = 34; addFeed(coordinator, 'session', 'Compacting context (auto)'); }
    }
    if (cycler) {   // a subagent that finishes and is replaced, so arrivals and the "done" moment can be designed
      const age = (now - cycler.startedAt) / 1000;
      if (cycler.state === 'running' && age > 16) { cycler.state = 'done'; cycler.endedAt = now; cycler.currentTool = null; addFeed(coordinator, 'done', `Agent done · ${cycler.type}: ${cycler.description}`, 'agent-done'); }
      else if (cycler.state === 'done' && (now - cycler.endedAt) > 9000) {
        coordinator.subagents = coordinator.subagents.filter(a => a !== cycler || coordinator.subagents.filter(x => x.state === 'done').length < 4);
        cycler = sub(coordinator, coordinator.id, 1, pick(AGENT_JOBS), { age: 0, modelRaw: 'claude-haiku-5-5' });
        addFeed(coordinator, 'agent', `Agent started · ${cycler.type}: ${cycler.description}`);
      }
    }
    if (flipper) {  // asks a question for 12 s out of every 45 s
      const phase = ((now - t0) / 1000) % 45;
      if (phase > 30 && !flipper.needsYou) { flipper.status = 'needs-you'; flipper.needsYou = { since: now, reason: 'Question for you', kind: 'question' }; addFeed(flipper, 'needs-you', 'Question for you'); }
      if (phase <= 30 && flipper.needsYou) { flipper.status = 'busy'; flipper.needsYou = null; }
    }
    const step = Math.floor((now - t0) / 20_000) % PLAN_STEPS.length;
    if (step !== planStep) {
      PLAN_STEPS[step].forEach((st, i) => {
        const ph = plan.phases[i];
        if (planStep >= 0 && ph.state !== st) {
          // As diffPlan: P2 is written by the coordinator's first subagent, P3 by the coordinator (hud-0-3 P4).
          const by = !coordinator || ph.id === 'P1' || ph.id === 'P4' ? null : ph.id === 'P2' && explore ? { sessionId: coordinator.id, agentId: explore.id, label: explore.description } : { sessionId: coordinator.id, agentId: null, label: coordinator.title };
          plan.history.push({ at: now, id: ph.id, from: ph.state, to: st, sessionId: by?.sessionId ?? null, agentId: by?.agentId ?? null });
          if (plan.history.length > HISTORY_MAX) plan.history.shift();
          track.set(`${planKeyOf(plan)}#${ph.id}`, { ...newTrack(), ...track.get(`${planKeyOf(plan)}#${ph.id}`), changedAt: now });
          addFeed({ project: plan.project }, 'plan', by && st === 'in-progress' ? `${plan.title}: ${ph.id} claimed by ${by.label}` : `${plan.title}: ${ph.id} ${ph.state} → ${st}`, 'item-changed');
        }
        ph.state = st; ph.stateRaw = st; ph.since = st === 'todo' ? null : '2026-10-29';
      });
      plan.touchedAt = now;
      planStep = step;
    }
    acct.fiveHour.pct = Math.min(99, Math.round((acct.fiveHour.pct + 0.03) * 100) / 100);
    for (const r of external) if (!r.delayed && Math.random() < 0.3) { r.tokens.input += rnd(200, 2000); r.tokens.output += rnd(50, 500); r.windowEnd = now; }
    scheduleState();
  }

  function project(now) {
    const list = sessionsList.map(s => {
      const out = { ...s, pulse: pulseView(demoPulses.get(s), now), subagents: s.subagents.map(a => {
        const { _ctx, ...rest } = a;
        return { ...rest, context: contextFor(a.model, Math.round(_ctx / 100 * (CONTEXT_WINDOWS[a.model] || 0))), pulse: pulseView(demoPulses.get(a), now) };
      }) };
      delete out._ctx;
      out.context = contextFor(s.model, Math.round(s._ctx / 100 * (CONTEXT_WINDOWS[s.model] || 0)));
      out.tokensTree = out.subagents.reduce((acc, a) => addTokens(acc, a.tokens), { ...s.tokens });
      out.agentsRunning = out.subagents.filter(a => a.state === 'running').length;
      if (out.status === 'busy' || out.status === 'needs-you') out.lastActivityAt = now;
      return out;
    }).sort(compareSessions);
    const tokensToday = list.reduce((acc, s) => addTokens(acc, s.tokensTree), zero());
    const planList = dense ? [plan] : [plan, chunkPlan, smallPlan, ...quietPlans];
    const agents = [];
    for (const s of list) {
      agents.push({ key: s.id, parent: s.startedBy, sessionId: s.id, agentId: null, view: s, project: s.project,
        label: s.title, branch: s.branch, active: s.status === 'busy' || s.status === 'needs-you', ...evidence.get(s.id) });
      for (const a of s.subagents) {
        agents.push({ key: `${s.id}/${a.id}`, parent: a.parentId === s.id ? s.id : `${s.id}/${a.parentId}`,
          sessionId: s.id, agentId: a.id, view: a, project: s.project, label: a.description, branch: s.branch,
          active: a.state === 'running', ...evidence.get(a.id) });
      }
    }
    const { board, turnedOn } = followBoards(agents, planList, { now, track, unclaimedMs, stalledMs, floor: t0 - 3 * 3600_000 });
    for (const mark of turnedOn) {
      const { P, node, flag } = mark;
      const key = `${P.key}#${node.id}:${flag}`;
      if (announced.has(key)) continue;
      announced.add(key);
      addFeed({ project: P.plan.project }, 'plan', boardMarkText(mark));
    }
    const alerts = alertsFor(list, acct, now, demoAlerts, x => x.currentTool);
    return projectSnapshot({
      now, startedAt: t0, demo: dense ? 'dense' : true, host: 'STARK-01', hooksInstalled: true,
      sessions: list, externalUsage: { external, externalError: null }, projects: projectList,
      plans: planList, board, alerts, account: acct, push, tokensToday,
    });
  }

  for (const s of sessionsList) if (s.currentTool) addFeed(s, 'tool', `${s.currentTool.name} · ${s.currentTool.summary}`);
  tick();
  lifetime.interval(tick, 1000);
  return { project };
}

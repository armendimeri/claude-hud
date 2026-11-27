import path from 'node:path';
import { FINISHED, indexPlans, linkAgents, planFile, planKeyOf } from './board-links.mjs';
import { MINUTE_MS } from './models.mjs';
import { oneLine, truncate } from './tools.mjs';

const PLAN_WRITE_MS = 60_000;            // a board change this soon after an agent wrote the file is that agent's
export const HISTORY_MAX = 50;                  // state changes kept per plan, in memory
const OWNER_AGENTS = /^(human|owner)$/i;
const MARK_WORDS = { unclaimed: 'board not updated', stalled: 'stalled', early: 'started early' };

export function newTrack() { return { inFlightSince: null, lastInFlightAt: 0, changedAt: 0, on: new Set() }; }
/**
 * state.board (PLAN hud-0-3 §4.2, §4.3) from resolved agents: links, marks and lists. `track` keeps each item's clocks
 * between calls (each runtime or demo owns its map): when its current unbroken stretch in flight began, when it was last
 * in flight, when it last changed state, and its marks at the last call. Nothing before `floor` (the HUD's
 * start) counts, so after a restart `stalled` counts from the restart. Returns { board, turnedOn: [{ P, node, flag }] }.
 */
export function boardState(agents, ix, { now, track, unclaimedMs = 3 * MINUTE_MS, stalledMs = 30 * MINUTE_MS, floor }) {
  const items = {}, plans = {}, ready = [], awaiting = [], ownerInputs = [], turnedOn = [];
  const item = k => (items[k] ??= { agents: [], flags: [], since: null });
  for (const e of agents) {
    const w = e.work;
    if (!w) continue;
    if (e.active) for (const pk of new Set([w.plan, ...w.items.map(i => i.plan)])) (plans[pk] ??= { active: 0 }).active++;
    for (const i of w.items) item(`${i.plan}#${i.id}`).agents.push({ sessionId: e.sessionId, agentId: e.agentId, active: e.active, via: i.via, role: w.role });
  }
  const live = new Set();
  for (const P of ix.list) {
    const std = P.plan.format === 'standard';
    const inRun = new Set(std ? (P.plan.runs || []).flatMap(r => r.chunks || []) : []);
    const done = id => !P.nodes.has(id) || FINISHED.has(P.nodes.get(id).state);
    for (const n of P.nodes.values()) {
      const k = `${P.key}#${n.id}`;
      live.add(k);
      const x = items[k], deps = n.waitsFor || [];
      const inFlight = !!x && x.agents.some(a => a.active);
      let t = track.get(k);
      if (inFlight) { if (!t) track.set(k, (t = newTrack())); t.inFlightSince ??= now; t.lastInFlightAt = now; }
      else if (t) t.inFlightSince = null;
      const flags = [];
      let since = inFlight ? t.inFlightSince : null;
      if (n.state === 'todo' && inFlight && now - t.inFlightSince >= unclaimedMs) flags.push('unclaimed');
      if (n.state === 'in-progress' && !inFlight) {
        since = Math.max(floor, t?.lastInFlightAt || 0, t?.changedAt || 0, P.mtime);
        if (now - since >= stalledMs) flags.push('stalled');
      }
      if ((n.state === 'in-progress' || inFlight) && deps.some(d => !done(d))) flags.push('early');
      if (x || flags.length) { const it = item(k); it.flags = flags; it.since = since; }
      if (flags.length || t?.on.size) {
        if (!t) track.set(k, (t = newTrack()));
        for (const f of flags) if (!t.on.has(f)) turnedOn.push({ P, node: n, flag: f });
        t.on = new Set(flags);
      }
      if (!std) continue;   // the lists need the standard's states and owner inputs
      if (n.state === 'handed-off') awaiting.push({ plan: P.key, id: n.id });
      // Ready: an item to start, or a run. An item that is part of a run starts with its run, not on its own.
      if (n.state === 'todo' && !inFlight && n.kind !== 'input' && !OWNER_AGENTS.test(n.agent || '') && !inRun.has(n.id) && deps.every(done)) {
        ready.push({ plan: P.key, id: n.id, run: n.kind === 'run' });
      }
      if (n.kind === 'input' && n.state === 'todo') {
        const unlocks = [];
        for (const m of P.nodes.values()) if ((m.state === 'todo' || m.state === 'blocked') && m.kind !== 'input' && (m.waitsFor || []).includes(n.id)) unlocks.push(m.id);
        if (unlocks.length) ownerInputs.push({ plan: P.key, id: n.id, unlocks });
      }
    }
  }
  for (const k of track.keys()) if (!live.has(k)) track.delete(k);
  return { board: { items, plans, ready, awaiting, ownerInputs }, turnedOn };
}
/** Links `agents` (see liveAgents) to the boards of `planList`, puts `work` on each one's view, and builds state.board. */
export function followBoards(agents, planList, opts) {
  const ix = indexPlans(planList);
  linkAgents(agents, ix);
  for (const e of agents) e.view.work = e.work;
  return boardState(agents, ix, opts);
}

export function boardMarkText({ P, node, flag }) {
  return `${P.plan.title}: ${node.id} ${MARK_WORDS[flag]}`;
}

/** Retains the newest board copies, writes used for attribution and bounded state history. */
export function createPlanState({ boardTrack, agentLabel, pushFeed, clock }) {
  const plans = new Map();        // project and relative path, possibly shared by multiple worktrees
  const planWrites = new Map();   // last write per board file
  const planHistory = new Map();  // state changes by public plan key

  function noteWrite(file, sessionId, agentId, at) {
    if (!sessionId) return;
    const prev = planWrites.get(file);
    if (prev && prev.at > at) return;
    planWrites.delete(file);
    planWrites.set(file, { sessionId, agentId: agentId ?? null, at });
    if (planWrites.size > 500) planWrites.delete(planWrites.keys().next().value);
  }

  /**
   * Feeds each state change, and records it in the plan's history (hud-0-3 §4.2). A change seen within PLAN_WRITE_MS of
   * an agent writing the board file is that agent's: "claimed by <title>" when it moved the item to in-progress.
   */
  function diffPlan(a, b) {
    const now = clock();
    const old = new Map([...a.phases, ...a.runs].map(n => [n.id, n.state]));
    const w = planWrites.get(planFile(b));
    const by = w && now - w.at <= PLAN_WRITE_MS ? w : null;
    const key = planKeyOf(b);
    for (const n of [...b.phases, ...b.runs]) {
      const was = old.get(n.id);
      if (!was || was === n.state) continue;
      const hist = planHistory.get(key) || [];
      hist.push({ at: now, id: n.id, from: was, to: n.state, sessionId: by?.sessionId ?? null, agentId: by?.agentId ?? null });
      if (hist.length > HISTORY_MAX) hist.splice(0, hist.length - HISTORY_MAX);
      planHistory.set(key, hist);
      const itemKey = `${key}#${n.id}`;
      boardTrack.set(itemKey, { ...newTrack(), ...boardTrack.get(itemKey), changedAt: now });
      const who = by && n.state === 'in-progress' ? agentLabel(by) : null;
      pushFeed({ id: null, project: b.project }, 'plan', who ? `${b.title}: ${n.id} claimed by ${truncate(oneLine(who), 80)}` : `${b.title}: ${n.id} ${was} → ${n.state}`,
        now, null, 'item-changed');
    }
    const asked = new Set(a.needsYou.map(x => `${x.kind}:${x.id}:${x.text}`));
    for (const x of b.needsYou) {
      if (!asked.has(`${x.kind}:${x.id}:${x.text}`)) pushFeed({ id: null, project: b.project }, 'needs-you', `${b.title}: ${x.kind === 'decision' ? 'decision' : 'question'} ${x.id ?? ''} waiting on you`.replace(/\s+/g, ' '), clock());
    }
  }

  function applyScan(key, { root, project }, candidates) {
    const found = new Set();
    for (const { plan, mtime } of candidates) {
      const pkey = `${project}|${path.relative(root, plan.path)}`.toLowerCase();
      found.add(pkey);
      const prev = plans.get(pkey);
      if (prev && prev.rootKey !== key && prev.mtime > mtime) continue;
      if (prev) diffPlan(prev.plan, plan);
      plans.set(pkey, { plan, mtime, rootKey: key });
    }
    removeMissing(key, found);
  }

  function removeMissing(key, found) {
    for (const [id, plan] of plans) if (plan.rootKey === key && !found?.has(id)) plans.delete(id);
  }

  function views() {
    return [...plans.values()].map(({ plan, mtime }) => ({
      ...plan, touchedAt: Math.round(mtime), history: planHistory.get(planKeyOf(plan)) || [],
    })).sort((a, b) => a.project.localeCompare(b.project) || a.title.localeCompare(b.title));
  }

  return { noteWrite, applyScan, dropRoot: key => removeMissing(key), views };
}

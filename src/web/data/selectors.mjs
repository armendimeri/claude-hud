export const boardPlanKey = plan => plan.project + '|' + plan.slug;

export function sessionsById(snapshot) {
  return new Map(snapshot.sessions.map(session => [session.id, session]));
}

export function plansByKey(snapshot) {
  return new Map(snapshot.plans.map(plan => [boardPlanKey(plan), plan]));
}

export function selectProject(items, project) {
  return project ? items.filter(item => item.project === project) : items;
}

export function selectActivityRows(snapshot, project) {
  const plans = plansByKey(snapshot);
  return selectProject(snapshot.sessions, project).map(session => ({
    session,
    work: (session.work?.items || []).map(item => {
      const planKey = item.plan || session.work.plan;
      const plan = plans.get(planKey);
      const node = plan?.phases?.find(node => node.id === item.id) || plan?.runs?.find(node => node.id === item.id);
      return { planKey, plan, item, node };
    }),
  }));
}

export const headline = t => t ? (t.input || 0) + (t.output || 0) + (t.cacheWrite || 0) : 0;

export function selectSessionContext(snapshot, live, project, kiosk = false) {
  const longestWaiting = kiosk && live.filter(session => session.status === 'needs-you' && session.needsYou)
    .sort((a, b) => a.needsYou.since - b.needsYou.since)[0];
  return {
    byId: sessionsById(snapshot), plans: plansByKey(snapshot), host: snapshot.host,
    project, autoPin: longestWaiting?.id,
    maxTok: Math.max(1, ...live.map(session => headline(session.tokens))),
    maxCache: Math.max(1, ...live.map(session => session.tokens?.cacheRead || 0)),
  };
}

// The newest finished subagent in the state: "what just finished" is answered from the first frame, not only once
// a finish arrives in the feed.
export function selectLastFinish(st, project) {
  let best = null;
  for (const x of selectProject(st.sessions, project)) for (const a of x.subagents || []) {
    if (a.state === 'done' && a.endedAt && (!best || a.endedAt > best.at)) best = { kind: 'done', at: a.endedAt, project: x.project, text: `Agent done · ${[a.type, a.description].filter(Boolean).join(': ')}` };
  }
  return best;
}

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

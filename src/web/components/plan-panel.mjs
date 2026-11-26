import { moreBelow, panel } from './controls.mjs';
import { h, show, txt } from './dom.mjs';
import { DONE_STATES, createPlanComponents } from './plans.mjs';
import { prefs } from './preferences.mjs';
import { queueRows, quietBoards, workQueue } from './work-queue.mjs';
import { boardPlanKey, plansByKey, selectProject, sessionsById } from '../data/selectors.mjs';

export function createPlanPanel({ lifetime, motion, tip, reconcile, api }) {
  const { planCard } = createPlanComponents(tip);
  let state = null, scopedProject = null;
  const pl = panel('p-plans', 'Plans');
  const plSum = h('span', { class: 'ps' }); pl.head.append(plSum);
  const plansBox = h('div', { class: 'plans' }), plansEmpty = h('div', { class: 'plans-empty', hidden: true, text: 'No plan boards in the watched projects' });
  const plMore = moreBelow(lifetime, motion, pl.content, plansBox, els => {
    const k = els.filter(e => e.dataset.need).length;
    return [k ? h('span', { class: 'c-alert', text: `${k} ${k === 1 ? 'needs' : 'need'} you` }) : null, h('span', { class: 'trunc', text: els.map(e => e.dataset.project).join(', ') })];
  });
  const planApi = { ...api, layout: plMore.refresh };
  const queue = workQueue(planApi);
  let showQuiet = prefs.get('quietBoardsExpanded', false);
  const quiet = quietBoards(() => {
    showQuiet = !showQuiet;
    prefs.set('quietBoardsExpanded', showQuiet);
    if (state) render(state, scopedProject);
    plMore.refresh();
  });
  pl.content.append(queue.el, plansEmpty, plansBox, quiet.el, plMore.el);
  const planMap = new Map(), quietMap = new Map();
  let plSig = '';
  function render(st, project, animate = true) {
    state = st;
    scopedProject = project;
    pl.guard(() => {
      const plans = selectProject(st.plans, project), board = st.board || {};
      const byPlan = plansByKey({ plans });
      const sessions = sessionsById(st);
      const nameOf = ({ sessionId, agentId }) => {
        const session = sessions.get(sessionId);
        if (agentId) {
          const agent = session?.subagents?.find(a => a.id === agentId);
          return agent?.description || agent?.type || 'Subagent ' + agentId.slice(0, 8);
        }
        return session?.title || session?.name || session?.project || 'Session ' + sessionId.slice(0, 8);
      };
      const owner = new Set((board.ownerInputs || []).map(item => item.plan));
      const nodes = p => [...(p.phases || []), ...(p.runs || [])];
      const needs = p => p.needsYou?.length || owner.has(boardPlanKey(p)) || nodes(p).some(n => n.state === 'blocked' || n.state === 'bounced');
      const active = p => nodes(p).some(n => n.state === 'in-progress');
      const working = p => board.plans?.[boardPlanKey(p)]?.active || 0;
      const staleBefore = st.now - 14 * 86_400_000;
      const isQuiet = p => {
        const all = nodes(p);
        return (all.length > 0 && all.every(n => DONE_STATES.has(n.state))) ||
          (p.touchedAt > 0 && p.touchedAt <= staleBefore && !working(p) && !needs(p));
      };
      const sorted = plans.toSorted((a, b) => (needs(b) ? 1 : 0) - (needs(a) ? 1 : 0) || (working(b) > 0 ? 1 : 0) - (working(a) > 0 ? 1 : 0) || (active(b) ? 1 : 0) - (active(a) ? 1 : 0) || (b.touchedAt || 0) - (a.touchedAt || 0) || a.project.localeCompare(b.project) || (a.title || '').localeCompare(b.title || ''));
      const visible = [], folded = [];
      for (const p of sorted) (isQuiet(p) ? folded : visible).push(p);
      queue.update(queueRows(st, byPlan, nameOf));
      show(queue.el, plans.length > 0);
      show(plansEmpty, plans.length === 0);
      quiet.update(folded.length, showQuiet);
      const inProgress = plans.filter(active).length;
      txt(plSum, plans.length ? [`${plans.length}`, inProgress ? `${inProgress} in progress` : null].filter(Boolean).join(' · ') : '');
      const update = (c, p) => c.update(p, board, nameOf);
      reconcile(plansBox, planMap, visible, boardPlanKey, () => planCard(planApi), update, animate);
      reconcile(quiet.list, quietMap, showQuiet ? folded : [], boardPlanKey, () => planCard(planApi), update, false);
      const sig = visible.map(p => boardPlanKey(p) + (needs(p) ? '!' : '')).join();
      if (sig !== plSig) { plSig = sig; plMore.refresh(); }   // the hint only changes with the boards (scroll and resize repaint it too)
    }, () => render(st, project, animate));
  }
  return { el: pl.el, update: render };
}

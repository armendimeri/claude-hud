import { CONNECTION_LABELS } from '../components/controls.mjs';
import { h } from '../components/dom.mjs';
import { FEED_TAGS } from '../components/feed.mjs';
import { statusTag } from '../components/status.mjs';
import { selectActivityRows, selectProject } from '../data/selectors.mjs';

const feedTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

export const activity = {
  key: 'activity',
  outlet: 'page',
  demoOnly: true,
  stylesheet: new URL('../styles/activity.css', import.meta.url).href,

  mount(element, { store, actions }) {
    const back = h('a', { class: 'activity-back', href: actions.dashboardUrl() }, '← Dashboard');
    const connectionLabel = h('span');
    const connection = h('span', { class: 'activity-connection', role: 'status' }, connectionLabel);
    const retry = h('button', { type: 'button', class: 'activity-retry', text: 'Retry now', hidden: true });
    const project = h('select', { id: 'activity-project' });
    const sessionList = h('ul', { class: 'activity-sessions' });
    const feedList = h('ol', { class: 'activity-feed' });
    const emptySessions = h('p', { class: 'activity-empty', text: 'No sessions in this scope.' });
    const emptyFeed = h('p', { class: 'activity-empty', text: 'No recent events in this scope.' });
    const root = h('main', { class: 'activity-page' },
      h('div', { class: 'activity-bar' }, back, h('div', { class: 'activity-stream' }, connection, retry)),
      h('header', { class: 'activity-heading' },
        h('h1', { text: 'Activity preview' }),
        h('label', { for: project.id }, 'Project', project)),
      h('div', { class: 'activity-columns' },
        h('section', { 'aria-labelledby': 'activity-sessions-heading' },
          h('h2', { id: 'activity-sessions-heading', text: 'Sessions' }), sessionList, emptySessions),
        h('section', { 'aria-labelledby': 'activity-feed-heading' },
          h('h2', { id: 'activity-feed-heading', text: 'Recent feed' }), feedList, emptyFeed)));
    element.append(root);

    function returnToDashboard(event) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      actions.leaveView();
    }
    function changeProject() {
      actions.setProject(project.value || null);
    }
    back.addEventListener('click', returnToDashboard);
    project.addEventListener('change', changeProject);
    retry.addEventListener('click', store.reconnect);

    let lastSnapshot = null, lastProject = null, lastProjects = '';
    function update() {
      const status = store.getConnection().status;
      connection.dataset.status = status;
      const statusText = CONNECTION_LABELS[status];
      if (connectionLabel.textContent !== statusText) connectionLabel.textContent = statusText;
      retry.hidden = status !== 'down' && status !== 'reconnecting';

      const snapshot = store.getSnapshot();
      const focused = actions.getProject();
      if (snapshot === lastSnapshot && focused === lastProject) return;
      const names = new Set(snapshot.projects.map(project => project.project).filter(Boolean));
      for (const session of snapshot.sessions) if (session.project) names.add(session.project);
      if (focused) names.add(focused);
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      const projects = JSON.stringify(sorted);
      if (projects !== lastProjects) {
        project.replaceChildren(h('option', { value: '', text: 'All projects' }),
          ...sorted.map(name => h('option', { value: name, text: name })));
        lastProjects = projects;
      }
      project.value = focused || '';
      back.href = actions.dashboardUrl();

      if (focused !== lastProject || snapshot.sessions !== lastSnapshot?.sessions || snapshot.plans !== lastSnapshot?.plans) {
        const rows = selectActivityRows(snapshot, focused);
        sessionList.replaceChildren(...rows.map(({ session, work }) => {
          const status = statusTag();
          status.set(session.status);
          return h('li', { 'data-project': session.project, 'data-session': session.id },
            h('div', { class: 'activity-session-head' },
              h('h3', { text: session.title || session.name || 'Untitled session' }), status.el),
            h('p', { class: 'activity-meta', text: session.project || 'No project' }),
            session.needsYou?.reason ? h('p', { class: 'activity-attention', text: session.needsYou.reason }) : null,
            ...work.map(({ plan, item, node }) => h('p', { class: 'activity-work' },
              h('span', { class: 'mono', text: item.id }),
              [plan?.title, node?.name].filter(Boolean).map(text => ' · ' + text).join(''))));
        }));
        emptySessions.hidden = rows.length > 0;
      }
      if (focused !== lastProject || snapshot.feed !== lastSnapshot?.feed) {
        const lines = selectProject(snapshot.feed, focused);
        feedList.replaceChildren(...lines.map(line => h('li', { 'data-project': line.project },
          h('div', { class: 'activity-event-meta' },
            h('time', { class: 'mono', text: feedTime.format(line.at) }),
            h('span', { text: line.project || FEED_TAGS[line.kind] || line.kind })),
          h('p', { text: line.text }))));
        emptyFeed.hidden = lines.length > 0;
      }
      lastSnapshot = snapshot;
      lastProject = focused;
    }

    const stopData = store.subscribe(update);
    const stopProject = actions.subscribeProject(update);
    update();
    return () => {
      stopData();
      stopProject();
      back.removeEventListener('click', returnToDashboard);
      project.removeEventListener('change', changeProject);
      retry.removeEventListener('click', store.reconnect);
      root.remove();
    };
  },
};

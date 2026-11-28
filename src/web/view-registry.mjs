import { CONNECTION_LABELS } from './components/controls.mjs';
import { h, txt } from './components/dom.mjs';
import { createSessionList } from './components/sessions.mjs';
import { activity } from './views/activity.mjs';
import { cards } from './views/cards.mjs';
import { network } from './views/network.mjs';

const cockpit = {
  key: 'cockpit',
  outlet: 'page',
  stylesheet: new URL('./styles/cockpit.css', import.meta.url).href,

  mount(element, context) {
    const { store, actions } = context;
    const controller = new AbortController();
    let impl = null;
    const exit = h('button', { class: 'btn cp-exit', type: 'button', 'aria-label': 'Return to dashboard',
      on: { click: actions.leaveView } }, h('span', { 'aria-hidden': 'true', text: '← ' }), h('span', { text: 'Dashboard' }));
    const connection = h('span', { class: 'cp-conn label', role: 'status' });
    const notice = h('p', { class: 'cp-pre-note', role: 'status', text: 'Loading the cockpit…' });
    const fallback = createSessionList({ store, actions, onSelect: (selection, opener) => actions.inspect(selection, { opener }) });
    const root = h('main', { class: 'cockpit cp-pre', 'data-phase': 'loading', 'data-discreet': actions.discreet.get() ? 'on' : 'off' },
      h('header', { class: 'cp-bar' }, exit, h('h1', { class: 'cp-title label', text: 'Cockpit' }), connection), notice, fallback.el);
    element.append(root);
    exit.focus({ preventScroll: true });

    const drawConnection = () => txt(connection, CONNECTION_LABELS[store.getConnection().status] || '');
    const stopConnection = store.subscribe(event => { if (event.type === 'connection') drawConnection(); });
    drawConnection();

    function closeFallback() {
      stopConnection();
      fallback.close();
      root.remove();
    }
    import('./views/cockpit-page.mjs').then(module => {
      if (controller.signal.aborted || !root.isConnected) return;
      closeFallback();
      impl = module.mountCockpitPage(element, { ...context, signal: controller.signal });
    }, () => {
      if (controller.signal.aborted) return;
      root.dataset.phase = 'failed';
      txt(notice, 'The cockpit view could not be loaded. The session list and Dashboard still work.');
    });

    function close() {
      if (controller.signal.aborted) return;
      controller.abort();
      if (impl) impl.close();
      else closeFallback();
    }
    return Object.assign(close, {
      clearProject: () => (impl ? impl.clearProject() : actions.setProject(null)),
      focusView: () => impl?.focusView(),
    });
  },
};

export const viewRegistry = new Map([cards, network, activity, cockpit].map(view => [view.key, view]));

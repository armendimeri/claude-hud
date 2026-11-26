import { createDisplayEffects } from '../components/animation.mjs';
import { createLifetime } from '../components/lifetime.mjs';
import { createNetworkMap } from '../components/network-map.mjs';
import { createSessionComponents } from '../components/sessions.mjs';
import { selectSessionContext } from '../data/selectors.mjs';

export const network = {
  key: 'network',
  outlet: 'sessions',

  mount(element, { store, actions, motion, timing, kiosk }) {
    const lifetime = createLifetime();
    const now = store.getServerTime;
    const effects = createDisplayEffects(lifetime, motion);
    const { sessionCard } = createSessionComponents({ lifetime, motion, now, timing, effects });
    const map = createNetworkMap({ lifetime, motion, now, sessionCard, activityLine: timing.activityLine }, actions);
    map.el.hidden = true;
    element.append(map.el);
    const disconnect = actions.connect({
      el: map.el,
      update({ sessions, live, project }) {
        map.update(sessions, selectSessionContext(store.getSnapshot(), live, project, kiosk));
      },
      jump(id, agentId) {
        if ((agentId && map.pin(agentId)) || map.pin(id)) {
          map.el.scrollIntoView({ behavior: motion.rm ? 'auto' : 'smooth', block: 'nearest' });
        }
      },
    });
    return () => {
      lifetime.close();
      disconnect();
      map.el.remove();
    };
  },
};

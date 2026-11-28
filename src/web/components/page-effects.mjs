import { createNotifications, happenings } from './notifications.mjs';
import { createAwayRefresh } from '../data/away.mjs';

/**
 * Effects that outlive a view: sound, speech and notifications for what changed between snapshots, and the
 * while-you-were-away summary. They belong to the page, not to the dashboard or the cockpit, so changing views can
 * neither repeat an announcement nor lose one.
 *
 * - The previous snapshot is kept here. The first frame after a connect or reconnect only reseeds it, so a reconnect
 *   does not announce history again. Only snapshots drive it: `snapshot.now` ticking is not a change.
 * - A summary goes to every view that is listening; with none, the latest waits for the next listener and is
 *   delivered once.
 * - Turning discreet display on silences queued speech. Identifying phrases and system notifications are suppressed
 *   by the notification policy itself, whatever view is active.
 */
export function createPageEffects({ store, transport, lifetime, discreet }) {
  const notifications = createNotifications(lifetime, { discreet: discreet.get });
  const awayListeners = new Set();
  let previous = null, reseed = true, pendingAway = null;

  const refresh = createAwayRefresh({
    transport, isHidden: () => document.hidden,
    onSummary(feed, since) {
      if (!awayListeners.size) { pendingAway = { feed, since }; return; }
      pendingAway = null;
      for (const listener of [...awayListeners]) listener(feed, since);
    },
  });
  lifetime.listen(document, 'visibilitychange', refresh.visibilityChanged);
  lifetime.onClose(refresh.close);
  lifetime.onClose(store.subscribe(update => {
    if (update.type === 'connection') {
      if (update.resumedSince !== undefined) {
        reseed = true;
        void refresh.resumed(update.resumedSince);
      }
    } else if (update.type === 'snapshot') {
      const next = store.getSnapshot();
      if (previous && !reseed && next) notifications.announce(happenings(previous, next), next);
      reseed = false;
      previous = next;
    }
  }));
  lifetime.onClose(discreet.subscribe(() => { if (discreet.get()) notifications.silence(); }));

  return {
    audio: notifications.audio,
    voice: notifications.voice,
    onAway(listener) {
      awayListeners.add(listener);
      if (pendingAway) {
        const { feed, since } = pendingAway;
        pendingAway = null;
        listener(feed, since);
      }
      return () => awayListeners.delete(listener);
    },
  };
}

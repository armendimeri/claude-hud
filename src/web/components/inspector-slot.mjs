import { h } from './dom.mjs';
import { entityKey, findEntityElement } from './entity-key.mjs';

const PANEL_URL = '../inspector/panel.mjs';
const STYLES = [
  new URL('../inspector/inspector.css', import.meta.url).href,
  new URL('../styles/cockpit.css', import.meta.url).href,
];

/**
 * The client the inspector gets until P7-01 binds a real private transport. It answers every private read with
 * "unavailable" locally, so opening an inspector never makes a network request.
 */
export const publicOnlyClient = Object.freeze({
  history: () => Promise.reject({ code: 'unavailable', message: 'Conversation history is not connected in this view.' }),
  capabilities: () => Promise.resolve({ epoch: 'public', revision: 'public', actionWindow: null, available: [],
    activeTurnId: null, pending: [], reason: 'observed_only' }),
  submit: () => Promise.reject({ code: 'unavailable', message: 'Follow-ups are not available in this view.' }),
  receipt: () => Promise.reject({ code: 'unavailable', message: 'No delivery to check.' }),
});

/**
 * One shared session inspector for the active page. Cards, rows, pinned cards and the cockpit all call open() with
 * a selection {sessionId, agentId}; the panel module and its stylesheets are imported only on the first call, so a
 * dashboard that never inspects anything never requests them.
 *
 *   open(selection, {host, opener, onClose, focusFallback})  reuse the mounted panel when the host is unchanged
 *   close()                                                 close it and drop its stylesheets
 *   selection()                                             the current selection or null
 *
 * A late import, or one that finishes after close(), is discarded by a generation check.
 */
export function createInspectorSlot({ store, client = publicOnlyClient, discreet, signal = null, load = () => import(PANEL_URL) }) {
  let generation = 0, mounted = null, mountedHost = null, current = null, links = null;

  function addStyles() {
    if (links) return;
    links = STYLES.map(href => h('link', { rel: 'stylesheet', href, 'data-inspector-style': '' }));
    document.head.append(...links);
  }
  function removeStyles() {
    for (const link of links || []) link.remove();
    links = null;
  }
  function teardown({ keepStyles = false } = {}) {
    generation++;
    const panel = mounted;
    mounted = null; mountedHost = null; current = null;
    panel?.close();
    if (!keepStyles) removeStyles();
  }

  async function open(selection, { host, opener = null, onClose = () => {}, focusFallback = null } = {}) {
    if (!selection || !host || signal?.aborted) return;
    if (discreet?.get()) return;
    const key = entityKey(selection.sessionId, selection.agentId);
    if (mounted && mountedHost === host) {
      current = { selection, key };
      mounted.select(selection);
      return;
    }
    if (mounted) teardown({ keepStyles: true });
    const mine = ++generation;
    current = { selection, key };
    addStyles();
    let module;
    try {
      module = await load();
    } catch {
      if (mine === generation) { current = null; removeStyles(); }
      return;
    }
    // The import can finish after the operator moved on, left the page or turned discreet display on.
    if (mine !== generation || signal?.aborted || discreet?.get() || !host.isConnected) return;
    const target = current.selection;
    mountedHost = host;
    mounted = module.mountInspector(host, {
      selection: target, store, client, signal,
      getDiscreet: discreet?.get, subscribeDiscreet: discreet?.subscribe,
      restoreFocus(selected) {
        // The control that opened the inspector first; if its row was rebuilt, the row for the same entity; otherwise
        // the view's own selector.
        if (opener?.isConnected && opener !== document.body) return opener;
        const found = findEntityElement(entityKey(selected.sessionId, selected.agentId));
        if (found) return found;
        return focusFallback?.() ?? null;
      },
      onClose(info) {
        if (mine !== generation) return;
        mounted = null; mountedHost = null; current = null;
        removeStyles();
        onClose(info);
      },
    });
  }

  return {
    open,
    close: () => teardown(),
    selection: () => current?.selection ?? null,
    isOpen: () => !!mounted,
  };
}

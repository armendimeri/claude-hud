// Inspector state (P3). DOM free, so the selection, request and draft rules are testable without a browser.
//
// One controller serves one open inspector. It owns:
//  - the selection and a monotonically increasing generation, plus one AbortController per selection;
//  - history rows per selection (keyed by entry ID), with loading/empty/partial/error/ready states;
//  - the capabilities document per selection;
//  - drafts, scoped to selection tuple + turn + request + kind, in memory only;
//  - delivery records, scoped to the entity they were sent from (never shown for another entity).
// Nothing here talks to the network: the injected `client` is the P1 client seam.

/** Same encoding as `entityKey` in cockpit/projection.mjs. Compare tuples, never split on punctuation. */
export const keyOf = ({ sessionId, agentId = null }) => JSON.stringify([sessionId, agentId ?? null]);
export const sameSelection = (a, b) => !!a && !!b && keyOf(a) === keyOf(b);
export const draftKey = (selection, turnId, requestId, kind) => JSON.stringify([keyOf(selection), turnId ?? null, requestId ?? null, kind]);

const isAbort = error => error?.name === 'AbortError' || error?.code === 20;
/** An error DTO from the client has a stable `code`; anything else is shown generically and never as provider text. */
export function describeError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'unavailable';
  const message = typeof error?.message === 'string' && error.code ? error.message : 'This conversation is unavailable.';
  return { code, message };
}

export const REASONS = {
  observed_only: 'Follow-up unavailable · observed only',
  unsupported_surface: 'Follow-up unavailable · this surface cannot be controlled from the HUD',
  disconnected: 'Source disconnected · live actions paused',
  unavailable: 'Follow-up unavailable',
};
export const reasonText = reason => REASONS[reason] || (reason ? REASONS.unavailable : REASONS.observed_only);

/**
 * Merge a page into the row list. Rows are keyed by entry ID, ascending source order.
 * `older` prepends unseen rows, `newer` appends unseen rows, `replace` starts over.
 */
export function mergeRows(rows, page, mode) {
  const entries = Array.isArray(page?.entries) ? page.entries : [];
  if (mode === 'replace') return dedupe(entries);
  const seen = new Set(rows.map(row => row.id));
  const fresh = dedupe(entries).filter(row => !seen.has(row.id));
  if (!fresh.length) return rows;
  return mode === 'older' ? [...fresh, ...rows] : [...rows, ...fresh];
}
function dedupe(entries) {
  const seen = new Set();
  return entries.filter(row => row && typeof row.id === 'string' && !seen.has(row.id) && seen.add(row.id));
}

export function historyStatus(rows, gap) {
  if (gap && (gap.records > 0 || gap.stale)) return 'partial';
  return rows.length ? 'ready' : 'empty';
}

const blankHistory = () => ({ status: 'idle', rows: [], before: null, after: null, gap: null, error: null, older: 'idle', newer: 'idle' });
const blankCaps = () => ({ status: 'idle', data: null, error: null });

export function createInspectorController({ client, signal, onChange = () => {} }) {
  let generation = 0;
  let selection = null;
  let key = null;
  let controller = null;           // abort for the current selection's reads
  let opened = false;              // conversation / interaction explicitly opened in this panel
  let closed = false;
  const history = new Map();       // entity key -> history state (current selection only is kept)
  const caps = new Map();
  const drafts = new Map();        // draftKey -> value
  const deliveries = new Map();    // entity key -> [{actionId, kind, requestId, status, message}]
  const notices = [];
  const inflight = { history: null, newer: null, older: null, caps: null };
  const changed = () => { if (!closed) onChange(); };

  function ensure() {
    if (!history.has(key)) history.set(key, blankHistory());
    if (!caps.has(key)) caps.set(key, blankCaps());
    return { h: history.get(key), c: caps.get(key) };
  }
  /** Run one read for the current selection. A response is applied only if its generation is still current. */
  async function guarded(slot, run, apply, fail) {
    if (inflight[slot]) return inflight[slot];
    const gen = generation, ctl = controller, at = key;
    const promise = (async () => {
      try {
        const result = await run(ctl.signal);
        if (gen !== generation || ctl.signal.aborted || closed || at !== key) return;
        apply(result);
      } catch (error) {
        if (isAbort(error) || gen !== generation || ctl.signal.aborted || closed || at !== key) return;
        fail(describeError(error));
      } finally {
        if (inflight[slot] === promise) inflight[slot] = null;
      }
      changed();
    })();
    inflight[slot] = promise;
    return promise;
  }

  function loadHistory() {
    if (!selection) return Promise.resolve();
    const { h } = ensure();
    h.status = 'loading'; h.error = null; changed();
    const sel = selection;
    return guarded('history', s => client.history(sel, { signal: s }), page => {
      h.rows = mergeRows([], page, 'replace');
      h.before = page.before ?? null; h.after = page.after ?? null; h.gap = page.gap ?? null; h.error = null;
      h.status = historyStatus(h.rows, h.gap);
    }, error => { h.status = 'error'; h.error = error; });
  }
  function loadOlder() {
    const { h } = ensure();
    if (!selection || !h.before || h.older === 'loading') return Promise.resolve();
    h.older = 'loading'; changed();
    const sel = selection, before = h.before;
    return guarded('older', s => client.history(sel, { before, signal: s }), page => {
      h.rows = mergeRows(h.rows, page, 'older');
      h.before = page.before ?? null; h.older = 'idle';
      if (page.gap) h.gap = page.gap;
      h.status = historyStatus(h.rows, h.gap);
    }, error => {
      h.older = 'idle';
      if (error.code === 'stale_cursor') { h.gap = { records: 0, reasons: {}, stale: true }; h.status = 'partial'; }
      else h.error = error;
    });
  }
  /** Catch up with the cursor from the initial page. Coalesced: one request in flight. */
  function loadNewer() {
    const { h } = ensure();
    if (!selection || !h.after || h.newer === 'loading' || h.status === 'loading') return Promise.resolve();
    h.newer = 'loading';
    const sel = selection, after = h.after;
    return guarded('newer', s => client.history(sel, { after, signal: s }), page => {
      h.rows = mergeRows(h.rows, page, 'newer');
      h.after = page.after ?? h.after; h.newer = 'idle';
      if (page.gap) h.gap = page.gap;
      h.status = historyStatus(h.rows, h.gap);
    }, error => {
      h.newer = 'idle';
      if (error.code === 'stale_cursor') { h.gap = { records: 0, reasons: {}, stale: true }; h.status = 'partial'; }
      else h.error = error;
    });
  }
  function loadCapabilities() {
    if (!selection) return Promise.resolve();
    const { c } = ensure();
    if (c.status !== 'ready') { c.status = 'loading'; c.error = null; changed(); }
    const sel = selection;
    return guarded('caps', s => client.capabilities(sel, { signal: s }), data => {
      const previous = c.data;
      c.data = data; c.status = 'ready'; c.error = null;
      reconcileDrafts(sel, previous, data);
    }, error => { c.status = 'error'; c.error = error; });
  }

  /** A request that left the capabilities document closed elsewhere: drop its draft and say so once. */
  function reconcileDrafts(sel, previous, next) {
    const live = new Set((next?.pending || []).map(p => draftKey(sel, p.turnId, p.id, p.kind === 'question' ? 'answer' : p.kind)));
    const liveTurn = next?.activeTurnId ?? null;
    for (const dk of [...drafts.keys()]) {
      const [owner, turnId, requestId, kind] = JSON.parse(dk);
      if (owner !== keyOf(sel)) continue;
      const gone = requestId ? !live.has(dk) : kind === 'steer' ? turnId !== liveTurn || !(next?.available || []).includes('steer')
        : kind === 'prompt' ? !(next?.available || []).includes('prompt') : false;
      if (!gone) continue;
      drafts.delete(dk);
      notices.push({ key: keyOf(sel), text: requestId ? 'A question closed elsewhere. Your unsent answer was discarded.'
        : 'The turn finished. Your unsent message was discarded.' });
    }
  }

  const api = {
    get selection() { return selection; },
    get key() { return key; },
    get generation() { return generation; },
    get opened() { return opened; },
    get closed() { return closed; },
    history: () => (key ? ensure().h : blankHistory()),
    caps: () => (key ? ensure().c : blankCaps()),
    deliveries: () => deliveries.get(key) || [],
    drafts,
    takeNotices() { return notices.splice(0).filter(n => n.key === key); },

    /** New selection: abort earlier reads, bump the generation, forget other entities' private rows. */
    select(next) {
      if (closed) return;
      const nextKey = keyOf(next);
      if (nextKey === key) { selection = next; return; }
      controller?.abort();
      generation += 1;
      controller = new AbortController();
      for (const slot of Object.keys(inflight)) inflight[slot] = null;
      history.clear(); caps.clear();
      notices.length = 0;
      selection = next; key = nextKey;
      changed();
      if (opened) api.open();
    },
    /** Explicit access to history and interaction. The only entry point to private reads. */
    open() {
      if (closed || !selection) return Promise.resolve();
      opened = true;
      const { h, c } = ensure();
      const jobs = [];
      if (h.status === 'idle' || h.status === 'error') jobs.push(loadHistory());
      if (c.status === 'idle' || c.status === 'error') jobs.push(loadCapabilities());
      changed();
      return Promise.all(jobs).then(() => {});
    },
    reload() { const { h } = ensure(); h.status = 'idle'; h.rows = []; h.before = h.after = null; h.gap = null; return api.open(); },
    loadOlder, loadNewer, loadCapabilities,
    /** Public signals changed for the open entity: refresh capabilities and catch up once. */
    refresh() { if (opened && selection) return Promise.all([loadCapabilities(), loadNewer()]).then(() => {}); return Promise.resolve(); },

    getDraft: (turnId, requestId, kind) => drafts.get(draftKey(selection, turnId, requestId, kind)),
    setDraft(turnId, requestId, kind, value) {
      const dk = draftKey(selection, turnId, requestId, kind);
      if (value == null || value === '' || (Array.isArray(value) && !value.length)) drafts.delete(dk); else drafts.set(dk, value);
    },
    clearDrafts() { drafts.clear(); },

    /**
     * Send one command. The entity key is captured now: the receipt belongs to that entity even if the operator
     * has moved on, and the delivery is never cancelled by a selection change (the provider may already have it).
     */
    async submit(command, { label } = {}) {
      const sel = selection, at = key;
      const list = deliveries.get(at) || [];
      deliveries.set(at, list);
      const record = { actionId: command.actionId, kind: command.kind, requestId: command.requestId, label: label || command.kind,
        status: 'pending', message: 'Sending…' };
      list.push(record);
      const dk = draftKey(sel, command.turnId, command.requestId, command.kind);
      changed();
      try {
        const receipt = await client.submit(sel, command, { signal });
        applyReceipt(record, receipt);
        if (receipt?.status === 'acknowledged') drafts.delete(dk);
      } catch (error) {
        if (error?.code === 'stale_request' || error?.code === 'stale_cursor' || error?.status === 409 || error?.code === 'action_id_conflict') {
          record.status = 'rejected'; record.message = describeError(error).message;
          drafts.delete(dk);
          if (at === key) loadCapabilities();
        } else if (typeof error?.code === 'string' && ['bad_request', 'unauthorized', 'forbidden', 'unavailable'].includes(error.code)) {
          record.status = 'rejected'; record.message = describeError(error).message;
        } else {
          // Transport failure: the provider may or may not have the action.
          record.status = 'delivery-unknown';
          record.message = 'Delivery unknown. Check the native session before sending again.';
        }
      }
      changed();
      return record;
    },
    /** Reconcile one delivery by its original action ID. Never resubmits. */
    async check(actionId) {
      const at = key, sel = selection;
      const record = (deliveries.get(at) || []).find(r => r.actionId === actionId);
      if (!record) return null;
      try {
        applyReceipt(record, await client.receipt(sel, actionId, { signal }));
      } catch (error) {
        if (isAbort(error)) return record;
        record.message = record.status === 'delivery-unknown'
          ? 'Still unknown. Check the native session before sending again.' : describeError(error).message;
      }
      changed();
      return record;
    },

    /** Privacy, discreet or close: abort everything, drop every private row, draft, receipt and notice. */
    close() {
      if (closed) return;
      closed = true;
      controller?.abort();
      generation += 1;
      for (const slot of Object.keys(inflight)) inflight[slot] = null;
      history.clear(); caps.clear(); drafts.clear(); deliveries.clear(); notices.length = 0;
      selection = null; key = null; opened = false;
    },
  };
  return api;
}

const RECEIPT = {
  pending: ['pending', 'Sending…'],
  acknowledged: ['acknowledged', 'Delivered to the session.'],
  rejected: ['rejected', 'The session did not accept this.'],
  'delivery-unknown': ['delivery-unknown', 'Delivery unknown. Check the native session before sending again.'],
};
function applyReceipt(record, receipt) {
  const [status, message] = RECEIPT[receipt?.status] || RECEIPT['delivery-unknown'];
  record.status = status; record.message = message;
}

/** Is the answer to one question complete? Choice count within bounds, or free text where allowed. */
export function questionComplete(question, value) {
  const n = (value?.choiceIds || []).length, text = (value?.text || '').trim();
  const min = question.minChoices ?? 1, max = question.maxChoices ?? 1;
  if (n > max) return false;
  if (n > 0 && n >= min) return true;
  return !!(question.allowText && text);
}

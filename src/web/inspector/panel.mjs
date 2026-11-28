// Shared session inspector (P3).
//
//   mountInspector(host, {selection, store, client, onClose, signal, ...optional}) => {select(selection), close()}
//
// Immediately renders the public header and current activity from the store. Private history and interaction are
// read only after an explicit "Show conversation" press (`open`). Provider text is only ever written with
// textContent. P7 wires this into the page; P7-01 supplies the real client.
//
// Optional additive members (P3): `getDiscreet()` / `subscribeDiscreet(fn)` close the panel and drop everything
// private when discreet turns on; `restoreFocus(selection)` lets the host focus the entity's compact row on close;
// `onSelect` is not needed because the host owns selection.
import { createLifetime } from '../components/lifetime.mjs';
import { h, setAttr, show, txt } from '../components/dom.mjs';
import { fmtDur, fmtPct, fmtTok, plural, provLetter, provName, shortModel } from '../components/format.mjs';
import { icon, statusTag } from '../components/status.mjs';
import { viewStatus } from '../components/sessions.mjs';
import { headline } from '../data/selectors.mjs';
import { createInspectorController, keyOf, questionComplete, reasonText } from './state.mjs';

const WHO = { user: 'You', assistant: 'Assistant', tool: 'Tool' };
const SHEET_QUERY = '(max-width: 599px)';
const uuid = () => (globalThis.crypto?.randomUUID?.() ?? 'a-' + Math.random().toString(16).slice(2) + Date.now().toString(16));

/** Find the public entity for a selection. Compare the tuple; a subagent matches its parent and its own ID. */
export function findEntity(snapshot, selection) {
  const session = snapshot?.sessions?.find(s => s.id === selection.sessionId);
  if (!session) return null;
  if (selection.agentId == null) return { kind: 'session', session, item: session };
  const sub = (session.subagents || []).find(a => a.id === selection.agentId);
  return sub ? { kind: 'sub', session, item: sub } : null;
}

/** The public card: header, status and current activity. Used by the inspector and reusable by card views. */
export function createEntityCard() {
  const title = h('h2', { class: 'insp-title', tabindex: '-1' });
  const status = statusTag();
  const prov = h('span', { class: 'chip prov insp-prov' });
  const meta = h('p', { class: 'insp-meta mono' });
  const now = h('p', { class: 'insp-now' });
  const vitals = h('p', { class: 'insp-vitals mono' });
  const el = h('div', { class: 'insp-card' }, h('div', { class: 'insp-chips' }, status.el, prov), title, meta, now, vitals);
  return {
    el, title,
    set(entity, serverTime) {
      if (!entity) {
        txt(title, 'No longer in the live snapshot'); status.set('ended', null, 'Gone'); show(prov, false);
        txt(meta, 'It may have ended or been removed.'); txt(now, ''); txt(vitals, ''); title.removeAttribute('title');
        return;
      }
      const { item, session, kind } = entity;
      const name = kind === 'sub' ? (item.description || item.type || 'Subagent') : (item.title || 'Untitled session');
      txt(title, name); setAttr(title, 'title', name);
      const state = kind === 'sub' ? (item.state === 'running' ? 'running' : 'done') : viewStatus(item);
      status.set(state);
      show(prov, true);
      prov.dataset.p = item.provider || 'unknown'; txt(prov, provName(item.provider));
      txt(meta, [kind === 'sub' ? 'Subagent of ' + (session.title || 'session') : session.project, shortModel(item.model || item.modelRaw), session.branch || null]
        .filter(Boolean).join(' · '));
      const tool = item.currentTool;
      let line;
      if (kind === 'session' && item.status === 'needs-you') {
        line = (item.needsYou?.reason || 'Needs you') + (item.needsYou?.since ? ' · ' + fmtDur(serverTime - item.needsYou.since) : '');
      } else if (tool) {
        line = [tool.name, tool.summary].filter(Boolean).join(' · ') + (tool.since ? ' · ' + fmtDur(serverTime - tool.since) : '');
      } else if (state === 'agents') line = plural(item.agentsRunning, 'subagent running', 'subagents running');
      else if (state === 'busy' || state === 'running') line = 'Working between tools';
      else line = state === 'ended' || state === 'done' ? 'Finished' : 'Idle';
      txt(now, line);
      const ctx = item.context, tokens = headline(item.tokens);
      txt(vitals, `Context ${ctx ? fmtPct(ctx.pct) : 'unknown'} · Tokens ${fmtTok(tokens)}`);
    },
  };
}

export function mountInspector(host, options) {
  const { selection, store, client, onClose = () => {}, signal: outer, getDiscreet, subscribeDiscreet, restoreFocus } = options;
  const doc = host.ownerDocument;
  const lifetime = createLifetime();
  const controller = createInspectorController({ client, signal: lifetime.signal, onChange: schedule });
  let closed = false, renderQueued = false;
  let opener = doc.activeElement && doc.activeElement !== doc.body && !host.contains(doc.activeElement) ? doc.activeElement : null;
  let lastSignature = null;

  // ---- skeleton ---------------------------------------------------------------------------------------------------
  const card = createEntityCard();
  const closeButton = h('button', { class: 'insp-close', type: 'button', 'aria-label': 'Close inspector', on: { click: () => close('close') } }, icon('close'));
  const backButton = h('button', { class: 'insp-back', type: 'button', on: { click: () => close('back') } }, 'Back to map');
  const connection = h('p', { class: 'insp-note insp-conn', role: 'status', hidden: true });
  const openButton = h('button', { class: 'insp-btn insp-open', type: 'button', on: { click: () => controller.open() } }, 'Show conversation');
  const openNote = h('p', { class: 'insp-note', text: 'Reads this session’s private conversation on this PC.' });
  const gate = h('div', { class: 'insp-gate' }, openButton, openNote);
  const state = h('div', { class: 'insp-state', role: 'status' });
  const older = h('button', { class: 'insp-btn insp-older', type: 'button', hidden: true, on: { click: () => controller.loadOlder() } }, 'Load earlier messages');
  const list = h('ol', { class: 'insp-log', role: 'log', 'aria-label': 'Conversation', tabindex: '0' });
  const interaction = h('div', { class: 'insp-interaction' });
  const conversation = h('section', { class: 'insp-conv', 'aria-label': 'Conversation', hidden: true }, state, older, list);
  const root = h('section', { class: 'insp', 'aria-labelledby': 'insp-h-' + uid(), 'data-mode': 'side' },
    h('div', { class: 'insp-bar' }, backButton, h('span', { class: 'insp-spacer' }), closeButton),
    card.el, connection, gate, conversation, interaction);
  root.setAttribute('aria-labelledby', (card.title.id = root.getAttribute('aria-labelledby')));
  host.replaceChildren(root);

  const sheet = globalThis.matchMedia?.(SHEET_QUERY);
  const applyMode = () => { root.dataset.mode = sheet?.matches ? 'sheet' : 'side'; };
  applyMode();
  if (sheet) lifetime.listen(sheet, 'change', applyMode);

  // ---- rendering --------------------------------------------------------------------------------------------------
  function schedule() {
    if (closed || renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => { renderQueued = false; if (!closed) render(); });
  }
  function live() { return (store.getConnection?.()?.status ?? 'live') === 'live'; }

  const rowEls = new Map();
  let renderedKey = null;
  function rowEl(row) {
    const el = h('li', { class: 'insp-row', 'data-kind': row.kind, 'data-id': row.id },
      h('span', { class: 'insp-who label', text: WHO[row.kind] || 'Message' }),
      h('span', { class: 'insp-text', text: String(row.text ?? '') }));
    if (row.truncated) el.append(h('span', { class: 'insp-trunc mono', text: '(truncated)' }));
    return el;
  }
  const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight <= 4;
  function renderLog(rows) {
    const reset = renderedKey !== controller.key;
    if (reset) { rowEls.clear(); list.replaceChildren(); renderedKey = controller.key; }
    const first = !list.firstChild;
    const bottom = first || atBottom();
    let anchor = null;
    for (const el of list.children) {
      if (el.offsetTop + el.offsetHeight > list.scrollTop) { anchor = { el, offset: el.offsetTop - list.scrollTop }; break; }
    }
    const lastBefore = list.lastElementChild?.dataset.id;
    const wanted = new Set(rows.map(r => r.id));
    for (const [id, el] of rowEls) if (!wanted.has(id)) { el.remove(); rowEls.delete(id); }
    let cursor = list.firstChild;
    for (const row of rows) {
      let el = rowEls.get(row.id);
      if (!el) { el = rowEl(row); rowEls.set(row.id, el); }
      if (el === cursor) cursor = cursor.nextSibling; else list.insertBefore(el, cursor);
    }
    const appended = list.lastElementChild?.dataset.id !== lastBefore;
    if (bottom && (first || appended)) list.scrollTop = list.scrollHeight;
    else if (anchor && anchor.el.isConnected) list.scrollTop = anchor.el.offsetTop - anchor.offset;
  }

  function renderConversation() {
    const opened = controller.opened;
    show(gate, !opened); show(conversation, opened);
    if (!opened) { if (rowEls.size) { rowEls.clear(); list.replaceChildren(); renderedKey = null; } return; }
    const hs = controller.history();
    let message = '', busy = false;
    if (hs.status === 'loading' || hs.status === 'idle') { message = 'Loading conversation…'; busy = true; }
    else if (hs.status === 'empty') message = 'No messages yet. This conversation is empty.';
    else if (hs.status === 'error') message = hs.error?.message || 'This conversation is unavailable.';
    else if (hs.status === 'partial') {
      const n = hs.gap?.records;
      message = hs.gap?.stale ? 'The conversation moved on while you were reading.'
        : `${n ? plural(n, 'record', 'records') : 'Some records'} could not be shown.`;
    }
    state.dataset.state = hs.status;
    state.replaceChildren(...(message ? [h('span', { text: message })] : []));
    if (hs.status === 'error') state.append(' ', h('button', { class: 'insp-btn', type: 'button', on: { click: () => { controller.history().status = 'idle'; controller.open(); } } }, 'Retry'));
    if (hs.status === 'partial' && hs.gap?.stale) state.append(' ', h('button', { class: 'insp-btn', type: 'button', on: { click: () => controller.reload() } }, 'Load a fresh page'));
    setAttr(state, 'aria-busy', busy ? 'true' : null);
    show(state, !!message);
    show(older, !!hs.before);
    older.disabled = hs.older === 'loading';
    txt(older, hs.older === 'loading' ? 'Loading…' : 'Load earlier messages');
    renderLog(hs.rows);
  }

  // Interaction cards, keyed by turn + request + kind so a form survives re-renders and a closed request goes away.
  const cards = new Map();
  let composer = null, noticeKey = null, deliveriesEl = h('ul', { class: 'insp-deliveries', 'aria-label': 'Delivery status' }), noticesEl = h('div', { class: 'insp-notices', role: 'status' }), reasonEl = h('p', { class: 'insp-note insp-reason' });
  interaction.append(noticesEl, reasonEl, deliveriesEl);

  const pendingFor = (kind, requestId) => controller.deliveries().some(d => (d.status === 'pending' || d.status === 'delivery-unknown') && d.kind === kind && d.requestId === requestId);
  function command(caps, kind, requestId, payload) {
    return { actionId: uuid(), epoch: caps.epoch, revision: caps.revision, actionWindow: caps.actionWindow, kind,
      turnId: caps.activeTurnId ?? null, requestId, payload };
  }
  function innerFocus() { const a = doc.activeElement; return !a || a === doc.body || a === openButton || (root.contains(a) && !a.closest('.insp-interaction')); }

  function questionCard(caps, request) {
    const turnId = request.turnId ?? null;
    const saved = controller.getDraft(turnId, request.id, 'answer') || {};
    const value = JSON.parse(JSON.stringify(saved));
    const send = h('button', { class: 'insp-btn insp-send', type: 'button' }, 'Send answer');
    const sets = request.questions.map(q => {
      const multi = (q.maxChoices ?? 1) > 1, type = multi ? 'checkbox' : 'radio';
      const name = `q-${request.id}-${q.id}`;
      const inputs = q.choices.map(c => {
        const input = h('input', { type, name, value: c.id, id: `${name}-${c.id}` });
        input.checked = !!value[q.id]?.choiceIds?.includes(c.id);
        return { input, el: h('label', { class: 'insp-choice' }, input, h('span', { text: c.label })) };
      });
      const textarea = q.allowText ? h('textarea', { class: 'insp-input', rows: 2, 'aria-label': q.label + ' (your own answer)' }) : null;
      if (textarea) textarea.value = value[q.id]?.text || '';
      return { q, inputs, textarea, el: h('fieldset', { class: 'insp-ask' }, h('legend', { text: q.label }), inputs.map(i => i.el), textarea) };
    });
    const el = h('section', { class: 'insp-req', 'data-kind': 'question', 'data-request': request.id, role: 'group', 'aria-label': 'Question' },
      h('p', { class: 'insp-req-text', text: request.text }), sets.map(s => s.el), send);
    const read = () => Object.fromEntries(sets.map(s => [s.q.id, { choiceIds: s.inputs.filter(i => i.input.checked).map(i => i.input.value),
      ...(s.textarea && s.textarea.value.trim() ? { text: s.textarea.value } : {}) }]));
    const sync = () => {
      const answers = read();
      controller.setDraft(turnId, request.id, 'answer', Object.values(answers).some(a => a.choiceIds.length || a.text) ? answers : null);
      el.dataset.complete = String(sets.every(s => questionComplete(s.q, answers[s.q.id])));
      update();
    };
    el.addEventListener('change', sync);
    el.addEventListener('input', sync);
    for (const s of sets) if (s.textarea) s.textarea.addEventListener('keydown', e => { if (e.key !== 'Escape') e.stopPropagation(); });
    let sending = false;
    send.addEventListener('click', async () => {
      if (sending || send.disabled) return;
      sending = true; update();
      const answers = read();
      const payload = { answers: sets.map(s => ({ questionId: s.q.id, choiceIds: answers[s.q.id].choiceIds, ...(answers[s.q.id].text ? { text: answers[s.q.id].text } : {}) })) };
      try { await controller.submit(command(controller.caps().data, 'answer', request.id, payload), { label: 'Answer' }); } finally { sending = false; }
    });
    function update() {
      const answers = read();
      const complete = sets.every(s => questionComplete(s.q, answers[s.q.id]));
      const writable = live() && !sending && !pendingFor('answer', request.id);
      send.disabled = !complete || !writable;
      for (const s of sets) { s.el.disabled = !live(); }
      send.title = !live() ? 'Live actions paused while reconnecting' : !complete ? 'Choose an answer first' : '';
    }
    const focusFirst = () => { const s = sets.find(x => !questionComplete(x.q, value[x.q.id])) || sets[0]; (s.inputs[0]?.input || s.textarea)?.focus(); };
    update(); el.dataset.complete = String(sets.every(s => questionComplete(s.q, read()[s.q.id])));
    return { el, update, focusFirst };
  }

  function permissionCard(caps, request) {
    const decisions = (request.decisions || []).filter(d => caps.available.includes(d));
    const buttons = decisions.map(d => h('button', { class: 'insp-btn insp-decision', type: 'button', 'data-decision': d,
      on: { click: async () => {
        if (b.busy || buttonOf(d).disabled) return;
        b.busy = true; update();
        try { await controller.submit(command(controller.caps().data, d, request.id, { decision: d }), { label: d === 'allow-once' ? 'Allow once' : 'Deny' }); } finally { b.busy = false; }
      } } }, d === 'allow-once' ? 'Allow once' : 'Deny'));
    const b = { busy: false };
    const buttonOf = d => buttons[decisions.indexOf(d)];
    const el = h('section', { class: 'insp-req', 'data-kind': 'permission', 'data-request': request.id, role: 'group', 'aria-label': 'Permission request' },
      h('p', { class: 'insp-req-text', text: request.operation }), h('p', { class: 'insp-note', text: request.scope }),
      h('div', { class: 'insp-actions' }, buttons));
    function update() {
      const writable = live() && !b.busy && !decisions.some(d => pendingFor(d, request.id));
      for (const btn of buttons) btn.disabled = !writable;
    }
    update();
    return { el, update, focusFirst: () => buttons[0]?.focus() };
  }

  function composerCard(caps, kind) {
    const turnId = caps.activeTurnId ?? null;
    const writable0 = !!kind;
    const area = h('textarea', { class: 'insp-input insp-compose', rows: 3,
      'aria-label': kind === 'steer' ? 'Steer the current turn' : 'Send a message', placeholder: kind === 'steer' ? 'Steer the current turn' : 'Message this session' });
    const send = h('button', { class: 'insp-btn insp-send', type: 'button' }, kind === 'steer' ? 'Send steer' : 'Send');
    const el = h('section', { class: 'insp-req insp-composer', 'data-kind': kind || 'none' }, area, send);
    if (writable0) area.value = controller.getDraft(turnId, null, kind) || '';
    let sending = false;
    const submit = async () => {
      if (!writable0 || sending || send.disabled) return;
      const text = area.value;
      if (!text.trim()) return;
      sending = true; update();
      try { await controller.submit(command(controller.caps().data, kind, null, { text }), { label: kind === 'steer' ? 'Steer' : 'Message' }); } finally { sending = false; update(); }
      if (!controller.getDraft(turnId, null, kind)) area.value = '';
    };
    area.addEventListener('input', () => { controller.setDraft(turnId, null, kind, area.value); update(); });
    area.addEventListener('keydown', e => {
      if (e.isComposing) return;
      if (e.key !== 'Escape') e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
    });
    send.addEventListener('click', submit);
    function update() {
      area.disabled = !writable0 || !live();
      send.disabled = area.disabled || sending || !area.value.trim() || pendingFor(kind, null);
    }
    update();
    return { el, update, focusFirst: () => area.focus(), area };
  }

  function renderInteraction() {
    const opened = controller.opened;
    show(interaction, opened);
    if (!opened) { clearCards(); return; }
    const cs = controller.caps();
    const caps = cs.status === 'ready' ? cs.data : null;
    // Notices (closed request, discarded draft).
    if (noticeKey !== controller.key) { noticesEl.replaceChildren(); noticeKey = controller.key; }
    for (const n of controller.takeNotices()) noticesEl.append(h('p', { class: 'insp-note insp-warn', text: n.text }));
    const want = new Map();
    if (caps) {
      for (const request of caps.pending || []) {
        const k = JSON.stringify([request.turnId ?? null, request.id, request.kind, request]);
        want.set(k, () => request.kind === 'permission' ? permissionCard(caps, request) : questionCard(caps, request));
      }
      const writeKind = (caps.available || []).includes('prompt') ? 'prompt' : (caps.available || []).includes('steer') ? 'steer' : null;
      const pendingOnly = (caps.pending || []).length > 0 && !writeKind;
      if (!pendingOnly) want.set('composer:' + (writeKind || 'none') + ':' + (caps.activeTurnId ?? ''), () => composerCard(caps, writeKind));
    }
    for (const [k, c] of cards) if (!want.has(k)) { c.el.remove(); cards.delete(k); if (c === composer) composer = null; }
    let created = null;
    for (const [k, make] of want) {
      if (cards.has(k)) { cards.get(k).update(); continue; }
      const c = make();
      cards.set(k, c);
      if (!created && c.focusFirst && !k.startsWith('composer:')) created = c;
      interaction.insertBefore(c.el, reasonEl);
    }
    const writable = !!caps && ((caps.available || []).some(a => a !== 'history') || (caps.pending || []).length);
    const reason = cs.status === 'loading' || cs.status === 'idle' ? 'Checking what this session accepts…'
      : cs.status === 'error' ? (cs.error?.message || 'Follow-up unavailable')
      : !writable ? reasonText(caps?.reason) : !live() ? REASONS_PAUSED : '';
    txt(reasonEl, reason); show(reasonEl, !!reason);
    // Delivery records for this entity only.
    deliveriesEl.replaceChildren(...controller.deliveries().map(d => h('li', { class: 'insp-delivery', 'data-status': d.status, 'data-action': d.actionId },
      h('span', { class: 'label', text: d.label }), h('span', { text: d.message }),
      d.status === 'delivery-unknown' ? h('button', { class: 'insp-btn', type: 'button', on: { click: () => controller.check(d.actionId) } }, 'Check status') : null)));
    if (created && innerFocus()) created.focusFirst();
  }
  function clearCards() { for (const c of cards.values()) c.el.remove(); cards.clear(); composer = null; }
  const REASONS_PAUSED = 'Live actions paused while reconnecting';

  function renderHeader() {
    const snapshot = store.getSnapshot();
    const sel = controller.selection;
    card.set(sel ? findEntity(snapshot, sel) : null, store.getServerTime?.() ?? snapshot?.now ?? 0);
    const down = !live();
    show(connection, down);
    if (down) txt(connection, 'Reconnecting · showing last known state · live actions paused');
    root.dataset.entityKey = controller.key || '';
  }
  function render() { renderHeader(); renderConversation(); renderInteraction(); }

  // ---- public signals ---------------------------------------------------------------------------------------------
  // Refresh private state only when something that changes the capability revision moved, never on a clock tick.
  function signature() {
    const entity = controller.selection && findEntity(store.getSnapshot(), controller.selection);
    if (!entity) return 'gone';
    const i = entity.item;
    return [entity.kind, i.status ?? i.state, i.needsYou?.since ?? '', i.currentTool?.name ?? '', i.agentsRunning ?? '', i.endedAt ?? ''].join('|');
  }
  const unsubscribeStore = store.subscribe?.(() => {
    if (closed) return;
    const next = signature();
    if (next !== lastSignature) { lastSignature = next; controller.refresh(); }
    schedule();
  });
  lifetime.onClose(() => unsubscribeStore?.());

  // ---- keyboard: Escape closes the innermost panel and nothing else ----------------------------------------------
  function onKey(event) {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    close('escape');
  }
  doc.addEventListener('keydown', onKey, { capture: true, signal: lifetime.signal });

  // ---- discreet, abort, close -------------------------------------------------------------------------------------
  const unsubscribeDiscreet = subscribeDiscreet?.(() => { if (getDiscreet?.()) close('discreet'); });
  if (unsubscribeDiscreet) lifetime.onClose(unsubscribeDiscreet);
  if (outer) {
    if (outer.aborted) queueMicrotask(() => close('signal'));
    else outer.addEventListener('abort', () => close('signal'), { once: true, signal: lifetime.signal });
  }

  function focusAfterClose(sel, key) {
    let target = null;
    if (sel && restoreFocus) { try { target = restoreFocus(sel) || null; } catch { target = null; } if (target === true) return; }
    if (!target && key) target = [...doc.querySelectorAll('[data-entity-key]')].find(el => el.dataset.entityKey === key) || null;
    if (!target && opener?.isConnected) target = opener;
    target?.focus?.();
  }
  function close(reason = 'close') {
    if (closed) return;
    closed = true;
    const sel = controller.selection, key = controller.key;
    controller.close();
    lifetime.close();
    rowEls.clear(); cards.clear(); composer = null;
    host.replaceChildren();
    if (reason !== 'signal') {
      try { onClose({ reason, selection: sel }); } finally { if (reason !== 'discreet') focusAfterClose(sel, key); }
    }
    opener = null;
  }

  // ---- go ---------------------------------------------------------------------------------------------------------
  if (getDiscreet?.()) { queueMicrotask(() => close('discreet')); }
  controller.select(selection);
  lastSignature = signature();
  render();
  card.title.focus({ preventScroll: true });

  return {
    select(next) {
      if (closed || !next) return;
      const changedEntity = keyOf(next) !== controller.key;
      controller.select(next);
      lastSignature = signature();
      render();
      if (changedEntity && innerFocus()) card.title.focus({ preventScroll: true });
    },
    close: () => close('close'),
    root,
    /** Read-only facts for tests and the host. */
    inspect: () => ({ key: controller.key, generation: controller.generation, opened: controller.opened, closed, drafts: controller.drafts.size }),
  };
}

let counter = 0;
function uid() { return String(++counter); }

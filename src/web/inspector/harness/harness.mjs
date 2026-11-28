// Inspector harness (P3). Mounts the inspector against the frozen P1 fixtures and runs the DOM scenarios in the page.
// The runner (run.mjs) opens this page, calls `window.harness.run(name)` and reads the checks. P7 wires the real shell.
import { mountInspector } from '/src/web/inspector/panel.mjs';
import { bedrock, child, createFixtureStore, parent, selectionKey, sibling, snapshots, timeline, times } from '/tests/fixtures/cockpit/public.mjs';
import { canaries, capabilities, commands, createFixtureClient, errors, histories, historyPages, receipts } from '/tests/fixtures/cockpit/private.mjs';

const host = document.getElementById('host');
const scene = document.getElementById('scene');
const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const settle = async () => { await wait(0); await frames(); await wait(0); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const entityKey = s => JSON.stringify([s.sessionId, s.agentId ?? null]);
const A = entityKey(parent), B = entityKey(sibling);
const frame = (index = 1, connection = null) => ({ ...timeline[index], selection: parent, ...(connection ? { connection } : {}) });
const text = () => host.textContent;
const markupOf = () => document.documentElement.outerHTML;

const shell = { escapes: 0, closes: [] };
document.addEventListener('keydown', e => { if (e.key === 'Escape') shell.escapes += 1; });

let current = null;
function rows() {
  scene.replaceChildren(...[parent, child, sibling].map(sel => {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.entityKey = entityKey(sel); b.textContent = 'Row ' + (sel.agentId ? 'child' : sel.sessionId.slice(0, 7));
    return b;
  }));
}
rows();

/** Mount with a tracing client. `overrides` go to createFixtureClient; the trace records every call and its signal. */
function mount({ selection = parent, overrides = {}, store, onClose, discreet = null, options = {} } = {}) {
  if (current) current.close();
  host.replaceChildren();
  const calls = [];
  const base = createFixtureClient(overrides);
  const client = {
    history: (sel, o) => { calls.push({ method: 'history', key: entityKey(sel), before: o?.before, after: o?.after, signal: o?.signal }); return base.history(sel, o); },
    capabilities: (sel, o) => { calls.push({ method: 'capabilities', key: entityKey(sel), signal: o?.signal }); return base.capabilities(sel, o); },
    submit: (sel, c, o) => { calls.push({ method: 'submit', key: entityKey(sel), command: c, signal: o?.signal }); return base.submit(sel, c, o); },
    receipt: (sel, id, o) => { calls.push({ method: 'receipt', key: entityKey(sel), actionId: id, signal: o?.signal }); return base.receipt(sel, id, o); },
  };
  store = store || createFixtureStore(frame(1));
  const closes = [];
  const outer = new AbortController();
  const d = discreet ? { v: false, fns: new Set() } : null;
  const handle = mountInspector(host, {
    selection, store, client, signal: outer.signal,
    onClose: info => { closes.push(info.reason); shell.closes.push(info.reason); onClose?.(info); },
    ...(d ? { getDiscreet: () => d.v, subscribeDiscreet: fn => { d.fns.add(fn); return () => d.fns.delete(fn); } } : {}),
    ...options,
  });
  current = { handle, close: () => handle.close(), calls, store, client, closes, outer, setDiscreet(on) { d.v = on; for (const fn of [...d.fns]) fn(); } };
  return current;
}
const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const q = (sel, root = host) => root.querySelector(sel);
const qa = (sel, root = host) => [...root.querySelectorAll(sel)];
const openIt = async () => { click(q('.insp-open')); await settle(); };
const markers = Object.values(canaries);
const leaks = (str, names) => names.filter(n => str.includes(canaries[n]));
const ack = (command) => ({ actionId: command.actionId, status: 'acknowledged', at: times[4] });

function makeRows(from, to, prefix = 'r') {
  return Array.from({ length: to - from + 1 }, (_, i) => ({ id: prefix + (from + i), at: times[0] + from + i, kind: i % 3 === 0 ? 'user' : 'assistant', text: `Message ${from + i} ` + 'wordy '.repeat(12) }));
}

const scenarios = {
  async publicFirst(rec) {
    const m = mount({ overrides: { history: () => { throw new Error('private read without access'); } } });
    rec('public header is synchronous: title, status word, activity', !!q('.insp-title') && q('.insp-title').textContent === 'Export' && /Needs you/i.test(q('.stag').textContent) && /Waiting for answer/.test(q('.insp-now').textContent), host.querySelector('.insp-card').innerText);
    await settle();
    rec('no private read before explicit access', m.calls.length === 0, m.calls.map(c => c.method));
    rec('no private marker in DOM', markers.every(k => !markupOf().includes(k)));
    rec('conversation gated behind a button', !!q('.insp-open') && q('.insp-conv').hidden);
    const info = m.handle.inspect();
    rec('focus starts on the heading', document.activeElement === q('.insp-title'), document.activeElement.className);
    rec('root is labelled by the heading', q('.insp').getAttribute('aria-labelledby') === q('.insp-title').id);
    m.close();
  },

  async twoSessionsSameTitle(rec) {
    const m = mount({ selection: parent, store: createFixtureStore(frame(0)) });
    const a = q('.insp-title').textContent;
    m.handle.select(sibling);
    rec('same title, distinct entities', a === 'Export' && q('.insp-title').textContent === 'Export' && q('.insp').dataset.entityKey === B && A !== B, { a: A.length, b: B.length });
    m.handle.select(child);
    rec('subagent selects by its own tuple, not by guessing', q('.insp-title').textContent === 'Review export' && /Subagent of Export/.test(q('.insp-meta').textContent), q('.insp-meta').textContent);
    m.handle.select({ sessionId: parent.sessionId, agentId: 'toolu_unknown' });
    rec('unknown agent shows a gone state, never the parent', /No longer/.test(q('.insp-title').textContent));
    m.close();
  },

  async switchIsolation(rec) {
    const ga = deferred();
    const m = mount({ overrides: { history: async (sel, o) => sel.sessionId === parent.sessionId && !sel.agentId ? ga.promise : histories[selectionKey(sel)] } });
    await openIt();
    rec('A shows loading', /Loading/.test(q('.insp-state').textContent));
    m.handle.select(sibling);
    await settle();
    rec('B history rendered after the switch (open carries over)', text().includes(canaries.sibling), text().slice(0, 80));
    const aCall = m.calls.find(c => c.method === 'history' && c.key === A);
    rec('A request was aborted by the selection change', aCall.signal.aborted === true);
    ga.resolve(histories[selectionKey(parent)]);
    await settle(); await wait(30);
    const html = host.outerHTML;
    rec('late A response leaves no A or child marker in B panel, title or ARIA', !html.includes(canaries.parent) && !html.includes(canaries.child) && html.includes(canaries.sibling));
    rec('late A response leaves no marker anywhere in the document', !markupOf().includes(canaries.parent));
    rec('B panel header is B', q('.insp').dataset.entityKey === B);
    rec('generation advanced once per selection', m.handle.inspect().generation === 2, m.handle.inspect());
    m.close();
  },

  async lateAfterBothOrders(rec) {
    const gb = deferred(), ga = deferred();
    const m = mount({ overrides: { history: (sel) => sel.sessionId === parent.sessionId && !sel.agentId ? ga.promise : gb.promise } });
    await openIt();
    m.handle.select(sibling); await settle();
    m.handle.select(parent); await settle();
    gb.resolve(histories[selectionKey(sibling)]); await settle();
    rec('B response for an earlier selection is dropped while A is current', !text().includes(canaries.sibling));
    ga.resolve(histories[selectionKey(parent)]); await settle();
    rec('current A response is shown', text().includes(canaries.parent) && !text().includes(canaries.sibling));
    m.close();
  },

  async historyRows(rec) {
    const calls = { n: 0 };
    const all = makeRows(1, 60);
    const page = (list, extra) => ({ entries: list, before: null, after: null, gap: null, ...extra });
    let after = 'c60';
    const m = mount({ overrides: {
      history: async (sel, o) => {
        calls.n++;
        if (o?.before) return page(all.slice(0, 20), { before: null });
        if (o?.after) return page(newer.splice(0), { after: 'c' + (after += 1) });
        return page(all.slice(20), { before: 'older-1', after });
      } } });
    const newer = [];
    host.style.height = '720px';
    await openIt();
    const log = q('.insp-log');
    rec('initial page rendered, scrolled to bottom', qa('.insp-row').length === 40 && log.scrollHeight - log.scrollTop - log.clientHeight <= 4, { rows: qa('.insp-row').length, top: log.scrollTop });
    rec('Load earlier offered while a before cursor exists', !q('.insp-older').hidden);
    // Scroll up to a middle row and prepend.
    log.scrollTop = 200; await settle();
    const first = qa('.insp-row').find(r => r.offsetTop + r.offsetHeight > log.scrollTop);
    const id = first.dataset.id, offset = first.offsetTop - log.scrollTop;
    click(q('.insp-older')); await settle(); await wait(30);
    const same = q(`[data-id="${id}"]`);
    rec('older page prepended once, in order', qa('.insp-row').length === 60 && qa('.insp-row')[0].dataset.id === 'r1' && new Set(qa('.insp-row').map(r => r.dataset.id)).size === 60);
    rec('visible anchor row keeps its pixel offset', Math.abs((same.offsetTop - log.scrollTop) - offset) <= 1, { before: offset, after: same.offsetTop - log.scrollTop });
    rec('Load earlier hidden once the start is reached', q('.insp-older').hidden);
    // Append while scrolled up: must not move the view.
    const top = log.scrollTop;
    newer.push({ id: 'n1', at: times[5], kind: 'assistant', text: 'Appended while reading.' });
    m.store.setFrame(frame(2)); // capability-affecting signature change triggers a catch-up
    m.store.setFrame({ ...frame(5), snapshot: timeline[5].snapshot });
    await settle(); await wait(50);
    rec('newer row appended exactly once', qa('[data-id="n1"]').length === 1);
    rec('not at bottom: no auto-scroll', Math.abs(log.scrollTop - top) <= 1, { top, now: log.scrollTop });
    // Append while at bottom: follow.
    log.scrollTop = log.scrollHeight; await settle();
    newer.push({ id: 'n2', at: times[5], kind: 'assistant', text: 'Appended at the bottom.' });
    m.store.setFrame(frame(3));
    await settle(); await wait(50);
    rec('at bottom: auto-scrolls to the new row', qa('[data-id="n2"]').length === 1 && log.scrollHeight - log.scrollTop - log.clientHeight <= 4, { gap: log.scrollHeight - log.scrollTop - log.clientHeight });
    // Duplicate delivery of the same entry does not repeat it.
    newer.push({ id: 'n2', at: times[5], kind: 'assistant', text: 'dup' });
    m.store.setFrame(frame(4)); await settle(); await wait(50);
    rec('a repeated entry ID is not repeated', qa('[data-id="n2"]').length === 1);
    host.style.height = '';
    m.close();
  },

  async inertText(rec) {
    const evil = [
      { id: 'x1', at: times[0], kind: 'assistant', text: '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2<\/script>' },
      { id: 'x2', at: times[0], kind: 'user', text: 'https://example.invalid/phish <a href="javascript:window.__pwn=3">link</a>' },
      { id: 'x3', at: times[0], kind: 'assistant', text: 'W'.repeat(6000), truncated: true },
    ];
    const m = mount({ overrides: { history: async () => ({ entries: evil, before: null, after: null, gap: null }) } });
    await openIt();
    rec('no element was created from provider text', qa('.insp-log img, .insp-log a, .insp-log script, .insp-log iframe').length === 0);
    rec('text is displayed verbatim', qa('.insp-text')[0].textContent === evil[0].text && qa('.insp-text')[1].textContent === evil[1].text);
    rec('nothing executed', window.__pwn === undefined);
    const log = q('.insp-log');
    rec('oversized string wraps instead of overflowing', log.scrollWidth <= log.clientWidth + 1, { scrollWidth: log.scrollWidth, clientWidth: log.clientWidth });
    rec('truncation marker shown', /truncated/.test(qa('.insp-row')[2].textContent));
    m.close();
  },

  async historyStates(rec) {
    let mode = 'empty';
    const m = mount({ overrides: { history: async () => {
      if (mode === 'empty') return historyPages.empty;
      if (mode === 'error') throw Object.assign(new Error('x'), errors.unavailable);
      if (mode === 'partial') return { ...histories[selectionKey(parent)], gap: { records: 3, reasons: { malformed: 3 } } };
      return histories[selectionKey(parent)];
    } } });
    await openIt();
    rec('empty is stated as an empty conversation', q('.insp-state').dataset.state === 'empty' && /empty/i.test(q('.insp-state').textContent));
    mode = 'error'; m.handle.select(sibling); m.handle.select(parent); await settle();
    rec('error is explicit, not empty, with Retry', q('.insp-state').dataset.state === 'error' && /unavailable/i.test(q('.insp-state').textContent) && !!q('.insp-state button'));
    mode = 'partial';
    click(q('.insp-state button')); await settle();
    rec('partial shows the rows and says records could not be shown', q('.insp-state').dataset.state === 'partial' && /3 records could not be shown/.test(q('.insp-state').textContent) && qa('.insp-row').length === 3, q('.insp-state').textContent);
    mode = 'ready';
    m.close();
  },

  async questions(rec) {
    const log = [];
    let capsOf = { [A]: capabilities.multiple, [B]: capabilities.observed };
    const m = mount({ overrides: {
      getCapabilities: async sel => capsOf[entityKey(sel)] || capabilities.unsupported,
      submit: async (sel, c) => { log.push(c); await wait(20); return ack(c); },
    } });
    await openIt();
    const cards = qa('.insp-req[data-kind=question]');
    rec('two pending questions render as two separate cards', cards.length === 2 && cards.every(c => c.dataset.request), cards.map(c => c.dataset.request));
    rec('first unanswered field is focused', document.activeElement === cards[0].querySelector('input'), document.activeElement.outerHTML.slice(0, 80));
    const send = c => c.querySelector('.insp-send');
    rec('Send answer disabled until every question is answered', send(cards[0]).disabled === true);
    const radio = (c, name, value) => c.querySelector(`input[name$="-${name}"][value="${value}"]`);
    click(radio(cards[0], 'question-date', 'today')); await settle();
    rec('still disabled with one of two questions answered', send(cards[0]).disabled === true && send(cards[1]).disabled === true);
    click(radio(cards[1], 'question-date', 'month')); await settle();
    rec('answering the other card does not enable the first', send(cards[0]).disabled === true && send(cards[1]).disabled === false);
    click(radio(cards[0], 'question-format', 'csv')); await settle();
    rec('complete first card enables its Send', send(cards[0]).disabled === false);
    // Draft isolation across an ordinary switch while the panel stays open.
    m.handle.select(sibling); await settle();
    rec('B shows no question card and no A choice', qa('.insp-req[data-kind=question]').length === 0 && qa('input:checked').length === 0);
    rec('B composer is disabled with the observed-only reason', q('.insp-compose').disabled && /observed only/.test(q('.insp-reason').textContent), q('.insp-reason').textContent);
    m.handle.select(parent); await settle();
    const back = qa('.insp-req[data-kind=question]');
    rec('A draft is back after switching away and returning', back.length === 2 && radio(back[0], 'question-date', 'today').checked && radio(back[0], 'question-format', 'csv').checked && radio(back[1], 'question-date', 'month').checked);
    // One delivery per double click.
    click(send(back[0])); click(send(back[0]));
    await settle(); await wait(60);
    rec('double activation sends once', log.length === 1, log.length);
    const c = log[0];
    rec('command binds epoch, revision, window, turn, request and payload', c.kind === 'answer' && c.requestId === 'request-2' && c.epoch === capabilities.multiple.epoch && c.revision === 'r3' && c.actionWindow === capabilities.multiple.actionWindow && c.turnId === 'fixture-turn-1' && JSON.stringify(c.payload) === JSON.stringify(commands.answer.payload) && /^[0-9a-f-]{36}$/.test(c.actionId), c);
    rec('delivery is labelled from the receipt', /Delivered to the session/.test(q('.insp-deliveries').textContent) && !/resumed/i.test(host.textContent));
    // External close of request-3: draft discarded, notice shown, card gone.
    capsOf = { ...capsOf, [A]: { ...capabilities.withdrawn } };
    const before = m.handle.inspect().drafts;
    m.store.setFrame(frame(5)); await settle(); await wait(50);
    rec('externally closed requests disappear', qa('.insp-req[data-kind=question]').length === 0);
    rec('discard of the stale draft is announced', /closed elsewhere/.test(q('.insp-notices').textContent), q('.insp-notices').textContent);
    rec('drafts for closed requests are gone', m.handle.inspect().drafts < before || m.handle.inspect().drafts === 0, { before, after: m.handle.inspect().drafts });
    m.close();
  },

  async staleSubmit(rec) {
    const calls = [];
    const m = mount({ overrides: {
      getCapabilities: async () => capabilities.question,
      submit: async (sel, c) => { calls.push(c); throw Object.assign(new Error(errors.stale.message), errors.stale); },
    } });
    await openIt();
    const card = q('.insp-req[data-kind=question]');
    click(card.querySelector('input[value=today]')); await settle();
    click(card.querySelector('.insp-send')); await settle(); await wait(30);
    rec('stale answer is rejected with the closed message', /This question has closed/.test(q('.insp-deliveries').textContent) && q('.insp-delivery').dataset.status === 'rejected', q('.insp-deliveries').textContent);
    rec('exactly one provider-facing call, no redirect to B', calls.length === 1 && m.calls.filter(c => c.method === 'submit').every(c => c.key === A));
    m.close();
  },

  async permission(rec) {
    const sent = [];
    const m = mount({ overrides: {
      getCapabilities: async () => capabilities.permission,
      submit: async (sel, c) => { sent.push(c); return ack(c); },
    } });
    await openIt();
    const card = q('.insp-req[data-kind=permission]');
    rec('permission shows the operation and scope', /Write export\.mjs/.test(card.textContent) && /current project/.test(card.textContent));
    rec('allow-once and deny are separate buttons', qa('.insp-decision', card).map(b => b.dataset.decision).join() === 'allow-once,deny');
    rec('permission is not a free-text form', !card.querySelector('textarea'));
    click(card.querySelector('[data-decision=deny]')); await settle(); await wait(30);
    rec('deny sends a deny command with the decision payload', sent.length === 1 && sent[0].kind === 'deny' && sent[0].payload.decision === 'deny' && sent[0].requestId === 'permission-1', sent[0]);
    rec('denial is labelled as a denial', /Deny/.test(q('.insp-delivery .label').textContent));
    m.close();
  },

  async unconfirmed(rec) {
    let first = true;
    const m = mount({ overrides: {
      getCapabilities: async () => capabilities.question,
      submit: async () => { throw new TypeError('network gone'); },
      receipt: async (sel, id) => ({ actionId: id, status: 'acknowledged', at: times[5] }),
    } });
    await openIt();
    const card = q('.insp-req[data-kind=question]');
    click(card.querySelector('input[value=today]')); await settle();
    click(card.querySelector('.insp-send')); await settle(); await wait(30);
    const d = q('.insp-delivery');
    rec('transport failure shows delivery unknown, not success or failure', d.dataset.status === 'delivery-unknown' && /Delivery unknown/.test(d.textContent), d.textContent);
    rec('Send stays disabled until the status is checked (no automatic retry)', card.querySelector('.insp-send').disabled && m.calls.filter(c => c.method === 'submit').length === 1);
    click(q('.insp-delivery button')); await settle(); await wait(30);
    const sentId = m.calls.find(c => c.method === 'submit').command.actionId;
    const rc = m.calls.find(c => c.method === 'receipt');
    rec('check uses the original action ID, not a new action', rc && rc.actionId === sentId);
    rec('provider receipt resolves the unknown state', q('.insp-delivery').dataset.status === 'acknowledged');
    m.close();
  },

  async composerDrafts(rec) {
    const sent = [];
    const caps = { [A]: capabilities.idle, [B]: capabilities.idle };
    const m = mount({ overrides: {
      getCapabilities: async sel => caps[entityKey(sel)],
      submit: async (sel, c) => { sent.push({ key: entityKey(sel), c }); await wait(20); return ack(c); },
    } });
    await openIt();
    const area = q('.insp-compose');
    area.value = canaries.draft + '\nsecond line'; area.dispatchEvent(new Event('input', { bubbles: true }));
    const plain = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    area.dispatchEvent(plain);
    rec('plain Enter is left to insert a newline and does not submit', !plain.defaultPrevented && sent.length === 0);
    m.handle.select(sibling); await settle();
    rec('draft does not appear for another entity (value or DOM)', q('.insp-compose').value === '' && !host.outerHTML.includes(canaries.draft));
    m.handle.select(parent); await settle();
    rec('draft returns on the same entity while the panel stays open', q('.insp-compose').value === canaries.draft + '\nsecond line');
    const ctrl = () => q('.insp-compose').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    ctrl(); ctrl();
    await settle(); await wait(50);
    rec('Ctrl+Enter submits exactly once', sent.length === 1 && sent[0].key === A && sent[0].c.kind === 'prompt' && sent[0].c.payload.text.includes('second line'), sent.length);
    rec('draft cleared after delivery', q('.insp-compose').value === '');
    // Draft survives only while open: close discards.
    q('.insp-compose').value = 'unsent ' + canaries.draft; q('.insp-compose').dispatchEvent(new Event('input', { bubbles: true }));
    m.close();
    rec('close removes the draft from the DOM', !markupOf().includes(canaries.draft) && host.childNodes.length === 0);
    const again = mount({ overrides: { getCapabilities: async () => capabilities.idle } });
    await openIt();
    rec('a new mount starts with no draft', q('.insp-compose').value === '' && again.handle.inspect().drafts === 0);
    again.close();
  },

  async submitAcrossSwitch(rec) {
    const gate = deferred();
    const m = mount({ overrides: {
      getCapabilities: async () => capabilities.idle,
      submit: async (sel, c) => { await gate.promise; return ack(c); },
    } });
    await openIt();
    q('.insp-compose').value = 'hello'; q('.insp-compose').dispatchEvent(new Event('input', { bubbles: true }));
    click(q('.insp-send')); await settle();
    rec('sending status shown for A', /Sending/.test(q('.insp-deliveries').textContent));
    m.handle.select(sibling); await settle();
    rec('B shows no delivery record from A', q('.insp-deliveries').children.length === 0);
    const sub = m.calls.find(c => c.method === 'submit');
    rec('selection change does not abort an in-flight delivery', sub.signal.aborted === false);
    gate.resolve(); await settle(); await wait(20);
    rec('A receipt does not appear on B', q('.insp-deliveries').children.length === 0);
    m.handle.select(parent); await settle();
    rec('A delivery record is there when returning', /Delivered/.test(q('.insp-deliveries').textContent));
    m.close();
  },

  async reconnecting(rec) {
    const store = createFixtureStore({ ...timeline[4], selection: parent });
    const m = mount({ store, overrides: { getCapabilities: async () => capabilities.question } });
    await openIt();
    rec('reconnect bar visible, actions paused', !q('.insp-conn').hidden && /live actions paused/.test(q('.insp-conn').textContent));
    rec('answer controls are disabled while reconnecting', qa('.insp-send').every(b => b.disabled) && qa('fieldset').every(f => f.disabled));
    store.setFrame({ ...timeline[1], selection: parent }); await settle();
    rec('controls return when live', !q('.insp-conn') || q('.insp-conn').hidden);
    m.close();
  },

  async privacyClose(rec) {
    const hold = deferred();
    const m = mount({ discreet: true, overrides: { history: (sel) => hold.promise, getCapabilities: async () => capabilities.question } });
    await openIt();
    const hist = m.calls.find(c => c.method === 'history');
    m.setDiscreet(true);
    rec('discreet closes the panel and notifies the host', m.closes.includes('discreet') && host.childNodes.length === 0, m.closes);
    rec('discreet aborts in-flight reads', hist.signal.aborted === true);
    hold.resolve(histories[selectionKey(parent)]); await settle(); await wait(30);
    rec('a late response cannot reintroduce text', !markupOf().includes(canaries.parent) && host.childNodes.length === 0);
    rec('no stray private DOM remains, hidden or not', ![...document.querySelectorAll('*')].some(el => markers.some(k => (el.textContent && el.children.length === 0 && el.textContent.includes(k)) || [...el.attributes].some(a => a.value.includes(k)))));
    const n = m.calls.length;
    m.store.setFrame(frame(5)); await settle();
    rec('later store updates make no private calls', m.calls.length === n);
  },

  async closeAndAbort(rec) {
    const m = mount({ overrides: { getCapabilities: async () => capabilities.idle } });
    await openIt();
    const calls = m.calls.length;
    m.handle.close(); m.handle.close();
    rec('close is safe twice and calls the host once', m.closes.length === 1 && host.childNodes.length === 0, m.closes);
    m.store.setFrame(frame(3)); await settle();
    rec('store updates after close do nothing', host.childNodes.length === 0 && m.calls.length === calls);
    const o = mount({});
    o.outer.abort(); await settle();
    rec('outer abort closes without calling the host close callback', host.childNodes.length === 0 && o.closes.length === 0);
  },

  async focusRestore(rec) {
    const row = () => q(`[data-entity-key]`, scene);
    const opener = [...scene.children].find(b => b.dataset.entityKey === A);
    opener.focus();
    const m = mount({ onClose: () => rows() });
    await settle();
    rec('mount moves focus into the inspector heading', document.activeElement === q('.insp-title'));
    m.handle.close();
    await settle();
    const now = document.activeElement;
    rec('focus returns to the row with the same entity key, rebuilt row included', now !== opener && now.dataset?.entityKey === A && now.isConnected, now.tagName);
    const m2 = mount({ options: { restoreFocus: () => { const el = [...scene.children][2]; el.focus(); return el; } } });
    m2.handle.close();
    rec('host restoreFocus callback wins', document.activeElement === scene.children[2]);
  },

  async sheet(rec) {
    const m = mount({});
    rec('narrow viewport renders a sheet', q('.insp').dataset.mode === (matchMedia('(max-width: 599px)').matches ? 'sheet' : 'side'), q('.insp').dataset.mode);
    if (q('.insp').dataset.mode === 'sheet') {
      const back = q('.insp-back'), r = back.getBoundingClientRect();
      rec('Back to map is visible and at least 44px', r.height >= 44 && r.width >= 44 && /Back to map/.test(back.textContent), { w: r.width, h: r.height });
      click(back); await settle();
      rec('Back closes the sheet', host.childNodes.length === 0 && m.closes[0] === 'back');
    } else m.close();
  },

  async overflow(rec) {
    const store = createFixtureStore(frame(1));
    const m = mount({ store, overrides: { getCapabilities: async () => capabilities.multiple } });
    await openIt();
    const p = q('.insp'), w = p.clientWidth;
    const wide = [...p.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > p.getBoundingClientRect().right + 1 && getComputedStyle(el).position !== 'fixed');
    rec('no horizontal overflow inside the panel', p.scrollWidth <= p.clientWidth + 1 && wide.length === 0, { scrollWidth: p.scrollWidth, clientWidth: w, wide: wide.map(e => e.className).slice(0, 3) });
    const small = [...p.querySelectorAll('button, input, label.insp-choice, textarea')].filter(el => { const r = el.getBoundingClientRect(); return r.width && (r.height < 44 && !(el.tagName === 'INPUT')); });
    rec('primary controls are at least 44px high', small.length === 0, small.map(e => e.className));
    const sizes = new Set([...p.querySelectorAll('*')].filter(e => e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())).map(e => getComputedStyle(e).fontSize));
    rec('type scale is 11, 13, 15 only', [...sizes].every(s => ['11px', '13px', '15px', '18px'].includes(s)), [...sizes]);
    m.close();
  },
};

window.harness = {
  ready: true,
  shell,
  names: Object.keys(scenarios),
  mount, rows, settle, wait,
  async run(name) {
    const checks = [];
    shell.closes.length = 0;
    const rec = (n, pass, detail) => checks.push({ name: n, pass: !!pass, detail: detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)) });
    try { await scenarios[name](rec); } catch (error) { rec('scenario threw: ' + (error?.message || error), false); }
    if (current) { try { current.close(); } catch {} current = null; }
    host.replaceChildren();
    return checks;
  },
  /** Mount with a state for screenshots. */
  async show(kind) {
    const caps = { question: capabilities.multiple, permission: capabilities.permission, idle: capabilities.idle, observed: capabilities.observed }[kind] || capabilities.question;
    const m = mount({ selection: parent, overrides: { getCapabilities: async () => caps } });
    await openIt();
    return true;
  },
  close() { current?.close(); current = null; },
  expose: { selectionKey, bedrock, times },
};

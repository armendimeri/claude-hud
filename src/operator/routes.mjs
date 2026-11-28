import { setMaxListeners } from 'node:events';
import { readJsonBody } from '../http/security.mjs';
import { createHistoryReader, createHistoryService, HistoryError } from '../sources/history/index.mjs';
import { createAccess, localRequestProblem, OperatorAccessError } from './access.mjs';
import { createDemoResolver, createLiveResolver, validSelection } from './resolver.mjs';

// Private operator routes under /api/operator (operator-cockpit P8, CONTRACTS "History and capability wire examples").
// The runtime constructs this service on the first private request. Every response is JSON with Cache-Control:
// no-store, errors are {code, message}, nothing redirects, and no CORS header is ever sent.
//
//   GET  /api/operator/instance                       loopback-only instance nonce for `node hud.mjs operator pair`
//   POST /api/operator/pair                           {code} -> session cookie
//   GET  /api/operator/bootstrap                      cookie -> {token, epoch, expiresAt} (the anti-forgery token)
//   GET  /api/operator/sessions/{key}/history         ?before= | ?after=  (P4 reader)
//   GET  /api/operator/sessions/{key}/capabilities
//   POST /api/operator/sessions/{key}/actions         injected dispatcher (P8-01, registered by P11)
//   GET  /api/operator/sessions/{key}/actions/{id}    injected dispatcher

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin', vary: 'Cookie, Origin',
};
const KEY_MAX = 2048;
const CURSOR_MAX = 2048;
const PAIR_BODY_MAX = 1024;
const ACTION_BODY_MAX = 16 << 10;
const MAX_INFLIGHT = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ERRORS = {
  forbidden: [403, 'This request is not allowed. Private HUD routes answer only same-origin requests on this PC.'],
  not_paired: [401, 'Pair this browser with the HUD first: run node hud.mjs operator pair on this PC.'],
  bad_request: [400, 'This request is not valid.'],
  not_found: [404, 'Not found.'],
  method_not_allowed: [405, 'This method is not allowed here.'],
  unsupported_media_type: [415, 'Use application/json.'],
  too_large: [413, 'This request is too large.'],
  busy: [503, 'The HUD is busy. Try again shortly.'],
  closing: [503, 'The HUD is closing.'],
  actions_unavailable: [503, 'Sending from the HUD is not available for this session yet.'],
  provider_unavailable: [503, 'The provider for this session is not connected right now.'],
  unknown_action: [404, 'This action is unknown.'],
  internal: [500, 'The HUD could not complete this request.'],
};

class RouteError extends Error {
  constructor(code, reason) {
    const [status, message] = ERRORS[code] ?? ERRORS.internal;
    super(message);
    this.code = code; this.status = status; this.reason = reason ?? null;
  }
}

function send(res, status, body, headers = {}) {
  if (res.destroyed || res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** Opaque selection key: base64url(UTF-8 JSON [sessionId, agentId]), canonical, at most 2 KiB. */
export function decodeKey(key) {
  if (typeof key !== 'string' || !key || key.length > KEY_MAX || !/^[A-Za-z0-9_-]+$/.test(key)) return null;
  const bytes = Buffer.from(key, 'base64url');
  if (bytes.toString('base64url') !== key) return null;
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return null; }
  if (!Array.isArray(value) || value.length !== 2) return null;
  const selection = { sessionId: value[0], agentId: value[1] };
  return validSelection(selection) ? selection : null;
}
export const encodeKey = ({ sessionId, agentId }) => Buffer.from(JSON.stringify([sessionId, agentId])).toString('base64url');

/**
 * @param {object} options
 * @param {'live'|'demo'} options.kind
 * @param {() => object} options.readSnapshot          the public snapshot (authorization set)
 * @param {(id: string) => object|undefined} [options.findSession]   live engine registry
 * @param {{claude: string[], codex: string[]}} [options.roots]     configured transcript/rollout roots
 * @param {Function} [options.summarizeTool]            the redacted tool summarizer
 * @param {string} options.operatorDir                 per-user private pairing folder
 * @param {typeof import('node:fs/promises').open} [options.open]  injectable opener (tests count opens and closes)
 * @param {(target: object) => object|null} [options.resolveAdapter]  provider adapter lookup; none means observed-only
 * @param {(deps: {clock: () => number, epoch: string, resolveAdapter: Function}) => object} [options.createDispatcher]
 * @param {() => number} [options.clock]
 * @param {(dir: string) => Promise<string|null>} [options.verifyAcl]
 */
export function createOperatorService({
  kind = 'live', readSnapshot, findSession, roots = { claude: [], codex: [] }, summarizeTool, operatorDir, open,
  resolveAdapter = () => null, createDispatcher = null, clock = Date.now, verifyAcl,
}) {
  const access = createAccess({ dir: operatorDir, clock, verifyAcl });
  const epoch = access.instance;
  const lifetime = new AbortController();
  setMaxListeners(0, lifetime.signal);
  const inflight = new Set();
  const demo = kind === 'demo';
  const resolver = demo ? createDemoResolver({ readSnapshot }) : createLiveResolver({
    findSession, readSnapshot, claudeProjects: roots.claude,
  });
  let reader = null, history = null, dispatcher = null, closing = null, lastPort = null;

  function historyService() {
    // The reader's random cursor key and instance live as long as this runtime: a restart makes old cursors stale.
    reader ??= createHistoryReader({ summarizeTool });
    return history ??= createHistoryService({
      resolve: async selection => resolver.resolve(selection)?.record ?? null,
      readHistory: reader.readHistory, roots, open,
    });
  }

  function demoHistory(selection, record, { before, after }) {
    if (before != null && after != null) throw new HistoryError('bad_request', 'both cursors');
    const tag = 'demo-' + encodeKey(selection).slice(0, 32);
    if ((before != null && before !== tag) || (after != null && after !== tag)) throw new HistoryError('invalid_cursor', 'demo');
    if (before != null || after != null) return { entries: [], before: null, after: after != null ? tag : null, gap: null };
    const at = clock();
    const { title, tool } = record.synthetic;
    const entries = [
      { id: tag + ':1', at: at - 2000, kind: 'user', text: `Demo request: ${title}` },
      ...(tool ? [{ id: tag + ':2', at: at - 1000, kind: 'tool', text: `${tool.name} · ${tool.summary}` }] : []),
      { id: tag + ':3', at, kind: 'assistant', text: 'This is simulated demo history. Demo mode never reads a transcript.' },
    ];
    return { entries, before: null, after: tag, gap: null };
  }

  function capabilitiesFor(adapterCaps) {
    const base = { epoch, revision: 'observed', actionWindow: null, available: ['history'], activeTurnId: null, pending: [], reason: 'observed_only' };
    if (!adapterCaps) return base;
    const available = Array.isArray(adapterCaps.available) ? adapterCaps.available.filter(x => typeof x === 'string') : [];
    // Without a registered dispatcher no write can be accepted, so only history stays available.
    const writes = dispatcher ? available.filter(x => x !== 'history') : [];
    return {
      epoch,
      revision: typeof adapterCaps.revision === 'string' ? adapterCaps.revision : 'observed',
      actionWindow: writes.length && typeof adapterCaps.actionWindow === 'string' ? adapterCaps.actionWindow : null,
      available: ['history', ...writes],
      activeTurnId: typeof adapterCaps.activeTurnId === 'string' ? adapterCaps.activeTurnId : null,
      pending: writes.length && Array.isArray(adapterCaps.pending) ? adapterCaps.pending : [],
      reason: writes.length ? (adapterCaps.reason ?? null) : (adapterCaps.reason || 'observed_only'),
    };
  }

  function getDispatcher() {
    if (!createDispatcher) return null;
    return dispatcher ??= createDispatcher({ clock, epoch, resolveAdapter });
  }

  function authorize(req, port, { write = false } = {}) {
    const problem = localRequestProblem(req, port, { requireOrigin: write });
    if (problem) throw new RouteError('forbidden', problem);
    const session = access.session(req, port);
    if (!session) throw new RouteError('not_paired');
    if (!access.tokenMatches(session, req.headers['x-hud-operator'])) throw new RouteError('forbidden', 'token');
    return session;
  }

  async function readBody(req, res, max) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new RouteError('unsupported_media_type');
    const body = await readJsonBody(req, max);
    if (!body) return null;   // the client went away
    if (body.code === 413) {
      send(res, 413, { code: 'too_large', message: ERRORS.too_large[1] }, { connection: 'close' });
      res.once('finish', () => req.destroy());
      return null;
    }
    if (body.code) throw new RouteError('bad_request', 'json');
    return body;
  }

  async function route(req, res, port, signal) {
    const [target, query = ''] = req.url.split('?', 2);
    const method = req.method;
    if (method === 'HEAD' || method === 'OPTIONS') {
      // HEAD never loads private content and OPTIONS never answers a CORS preflight.
      return send(res, 405, { code: 'method_not_allowed', message: ERRORS.method_not_allowed[1] }, { allow: 'GET, POST' });
    }

    if (target === '/api/operator/instance') {
      if (method !== 'GET') throw new RouteError('method_not_allowed');
      const problem = localRequestProblem(req, port);
      if (problem) throw new RouteError('forbidden', problem);
      return send(res, 200, access.describe(port));
    }

    if (target === '/api/operator/pair') {
      if (method !== 'POST') throw new RouteError('method_not_allowed');
      const problem = localRequestProblem(req, port, { requireOrigin: true });
      if (problem) throw new RouteError('forbidden', problem);
      const body = await readBody(req, res, PAIR_BODY_MAX);
      if (!body) return;
      if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value)) throw new RouteError('bad_request', 'shape');
      const issued = await access.pair(body.value.code, port);
      return send(res, 200, { paired: true, expiresAt: issued.expires }, { 'set-cookie': access.cookieHeader(port, issued) });
    }

    if (target === '/api/operator/bootstrap') {
      if (method !== 'GET') throw new RouteError('method_not_allowed');
      const problem = localRequestProblem(req, port);
      if (problem) throw new RouteError('forbidden', problem);
      const session = access.session(req, port);
      if (!session) throw new RouteError('not_paired');
      return send(res, 200, { token: session.token, epoch, expiresAt: session.expires });
    }

    const match = /^\/api\/operator\/sessions\/([^/]+)\/(history|capabilities|actions)(?:\/([^/]+))?$/.exec(target);
    if (!match) throw new RouteError('not_found');
    const [, key, kindOfRoute, actionId] = match;
    const write = kindOfRoute === 'actions' && actionId === undefined;
    if ((write && method !== 'POST') || (!write && method !== 'GET') || (kindOfRoute !== 'actions' && actionId !== undefined)) {
      throw new RouteError(kindOfRoute !== 'actions' && actionId !== undefined ? 'not_found' : 'method_not_allowed');
    }
    authorize(req, port, { write });
    const selection = decodeKey(key);
    if (!selection) throw new RouteError('bad_request', 'key');
    // A write's bounded body is read and checked before the target is resolved.
    let command = null;
    if (write) {
      const body = await readBody(req, res, ACTION_BODY_MAX);
      if (!body) return;
      command = body.value;
      if (!command || typeof command !== 'object' || Array.isArray(command) || typeof command.actionId !== 'string'
        || !UUID.test(command.actionId) || typeof command.kind !== 'string') throw new RouteError('bad_request', 'command');
    }

    if (kindOfRoute === 'history') {
      const params = new URLSearchParams(query);
      const before = params.getAll('before'), after = params.getAll('after');
      if (before.length > 1 || after.length > 1 || [...before, ...after].some(c => !c || c.length > CURSOR_MAX)) throw new RouteError('bad_request', 'cursor');
      const cursors = { before: before[0] ?? null, after: after[0] ?? null };
      if (cursors.before !== null && cursors.after !== null) throw new HistoryError('bad_request', 'both cursors');   // before any open
      if (demo) {
        const resolved = resolver.resolve(selection);
        if (!resolved) throw new HistoryError('unavailable', 'unknown selection');
        return send(res, 200, demoHistory(selection, resolved.record, cursors));
      }
      const page = await historyService().history(selection, { ...cursors, signal });
      return send(res, 200, page);
    }

    const resolved = resolver.resolve(selection);
    if (!resolved) throw new HistoryError('unavailable', 'unknown selection');
    const adapter = demo ? null : resolveAdapter(resolved.target);

    if (kindOfRoute === 'capabilities') {
      if (!demo) getDispatcher();
      let adapterCaps = null;
      if (adapter) {
        try { adapterCaps = await adapter.capabilities(resolved.target); }
        catch { throw new RouteError('provider_unavailable'); }
      }
      signal.throwIfAborted();
      return send(res, 200, capabilitiesFor(adapterCaps));
    }

    const active = demo ? null : getDispatcher();
    if (write) {
      if (!active) throw new RouteError('actions_unavailable');
      return send(res, 200, await active.submit(resolved.target, command));
    }
    if (!UUID.test(actionId)) throw new RouteError('bad_request', 'action id');
    if (!active) throw new RouteError('actions_unavailable');
    const receipt = await active.receipt(resolved.target, actionId);
    if (!receipt) throw new RouteError('unknown_action');
    return send(res, 200, receipt);
  }

  function respondError(res, error) {
    if (error instanceof HistoryError || error instanceof OperatorAccessError || error instanceof RouteError) {
      return send(res, error.status, { code: error.code, message: error.message });
    }
    if (error?.name === 'AbortError' || lifetime.signal.aborted) return send(res, 503, { code: 'closing', message: ERRORS.closing[1] });
    // A dispatcher error DTO: {code, message, status?}. Provider text must already be removed by the dispatcher.
    if (error && typeof error.code === 'string' && typeof error.message === 'string' && Number.isInteger(error.status)
      && error.status >= 400 && error.status < 600) {
      return send(res, error.status, { code: error.code, message: error.message });
    }
    // Never log request content, paths or secrets: only the error's class and code.
    console.error('operator request failed:', error?.name || 'Error', typeof error?.code === 'string' ? error.code : '');
    return send(res, 500, { code: 'internal', message: ERRORS.internal[1] });
  }

  async function handle(req, res, { port }) {
    lastPort = port;
    if (closing) return send(res, 503, { code: 'closing', message: ERRORS.closing[1] });
    if (inflight.size >= MAX_INFLIGHT) return send(res, 503, { code: 'busy', message: ERRORS.busy[1] });
    const request = new AbortController();
    const abort = () => request.abort();
    res.once('close', () => { if (!res.writableFinished) abort(); });   // the client went away before the answer
    const signal = AbortSignal.any([lifetime.signal, request.signal]);
    const work = (async () => {
      try {
        await route(req, res, port, signal);
      } catch (error) {
        respondError(res, error);
      }
    })();
    inflight.add(work);
    try { await work; } finally { inflight.delete(work); }
  }

  /** Aborts pending reads (their handles close in finally), invalidates every credential and removes this instance's ticket. */
  function close() {
    return closing ??= (async () => {
      lifetime.abort();
      await Promise.allSettled([...inflight]);
      await access.close(lastPort);
      try { await dispatcher?.close?.(); } catch {}
      reader = null; history = null; dispatcher = null;
    })();
  }

  return { handle, close, epoch, get inflight() { return inflight.size; } };
}

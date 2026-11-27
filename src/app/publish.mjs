import { VERSION } from '../config.mjs';
import { codexTree, endedLongAgo, sessionView } from '../domain/sessions.mjs';
import { totalsFor } from '../domain/usage.mjs';
import { withClock } from '../contract/snapshot.mjs';

const STATUS_ORDER = { 'needs-you': 0, busy: 1, idle: 2, ended: 3 };

export const compareSessions = (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.lastActivityAt || 0) - (a.lastActivityAt || 0);

export function publicSessions(sessions, now, projectFor, findSession) {
  return codexTree([...sessions]
    .filter(s => (s.shown || s.agent === 'codex') && !endedLongAgo(s, now) && (s.inRegistry || s.tail || s.lastHookAt))
    .map(s => sessionView(s, now, projectFor))
    .sort(compareSessions), findSession);
}

/** @returns {Omit<import('../contract/snapshot.mjs').HudSnapshot, 'feed'>} */
export function projectSnapshot({
  now, startedAt, demo = false, host, hooksInstalled, codex, sessions, projects, plans, board, alerts, account, externalUsage, push, tokensToday,
}) {
  return {
    now, uptime: now - startedAt, demo, version: VERSION, host, hooksInstalled,
    ...(codex !== undefined && { codex }), sessions, ...externalUsage, projects, plans, board, alerts, push, account,
    totals: totalsFor(sessions, plans, tokensToday),
  };
}

const MASK = '•••';
const VALUE = String.raw`("[^"]*"|'[^']*'|[^\s"';&,]+)`;
const REDACTIONS = [
  [new RegExp(String.raw`(^|[\s"'=(])-P\s*` + VALUE, 'g'), `$1-P ${MASK}`],
  [/\b(password|pwd|user ?id)\s*=\s*("[^"]*"|'[^']*'|[^;"'\s]*)/gi, `$1=${MASK}`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${MASK}`],
  [new RegExp(String.raw`\b(aws_secret_access_key|aws_session_token|aws_bearer_token_bedrock)["']?\s*[=:]\s*` + VALUE, 'gi'), `$1=${MASK}`],
  [new RegExp(String.raw`\b([A-Za-z0-9_.-]*(?:token|secret|api[_-]?key|apikey|passwd|password))["']?\s*[=:]\s*` + VALUE, 'gi'), `$1=${MASK}`],
  [new RegExp(String.raw`(--?(?:password|passwd|pwd|token|secret|api-?key|access-token))(?:\s+|=)` + VALUE, 'gi'), `$1 ${MASK}`],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
];

export function createRedactor() {
  const redactCache = new Map();

  function redact(s) {
    if (typeof s !== 'string' || s.length < 4) return s;
    const hit = redactCache.get(s);
    if (hit !== undefined) return hit;
    let out = s;
    for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
    // Anything that looks like a key: 32+ characters of hex, or a long base64-ish run with digits and letters
    // and no word-like structure (paths, slugs and UUIDs are split by / _ - into short parts and survive).
    out = out.replace(/[A-Za-z0-9+/=_-]{32,}/g, run => {
      if (/^[0-9a-fA-F]{32,}$/.test(run)) return MASK;
      if (!/\d/.test(run) || !/[A-Za-z]/.test(run)) return run;
      return Math.max(...run.split(/[/_-]/).map(p => p.length)) >= 20 ? MASK : run;
    });
    if (redactCache.size > 20_000) redactCache.clear();
    redactCache.set(s, out);
    return out;
  }

  const NO_REDACT = new Set(['id', 'parentId', 'sessionId', 'startedBy', 'agentId', 'plan']);
  function redactDeep(v, key) {
    if (typeof v === 'string') return NO_REDACT.has(key) ? v : redact(v);
    if (Array.isArray(v)) return Object.freeze(v.map(x => redactDeep(x, key)));
    if (v && typeof v === 'object') {
      return Object.freeze(Object.fromEntries(Object.entries(v).map(([k, value]) => [k, redactDeep(value, k)])));
    }
    return v;
  }
  return { redact, redactDeep };
}

const PUBLIC_FEED_LIMIT = 200;
const UPDATE_INTERVAL_MS = 250;

/** Owns the redacted projection and commits feed lines in the same update as their snapshot. */
export function createPublisher(updateState) {
  const { redact, redactDeep } = createRedactor();
  const listeners = new Set();
  let snapshot;
  let recent = [];
  let lines = [];
  let timer = null;
  let lastUpdateAt = 0;
  let projecting = false;
  let closed = false;

  function refresh() {
    if (closed) return;
    clearTimeout(timer);
    timer = null;
    const now = Date.now();
    projecting = true;
    try {
      const state = redactDeep(updateState(now));
      snapshot = Object.freeze({ ...state, feed: Object.freeze(recent.slice().reverse()) });
      lastUpdateAt = now;
    } finally {
      projecting = false;
    }
    const update = Object.freeze({ snapshot, lines: Object.freeze(lines) });
    lines = [];
    for (const listener of listeners) listener(update);
  }

  function invalidate() {
    if (closed || projecting || timer) return;
    const delay = Math.max(0, lastUpdateAt + UPDATE_INTERVAL_MS - Date.now());
    timer = setTimeout(refresh, delay);
  }

  function appendFeed(line) {
    if (closed) return;
    const safe = redactDeep(line);
    recent.push(safe);
    if (recent.length > PUBLIC_FEED_LIMIT) recent.shift();
    lines.push(safe);
    invalidate();
  }

  return {
    redact,
    redactDeep,
    refresh,
    invalidate,
    appendFeed,
    readSnapshot: () => withClock(snapshot, Date.now()),
    subscribeUpdates(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      clearTimeout(timer);
      listeners.clear();
      recent = [];
      lines = [];
    },
  };
}

import { addTokens, dayKey, normalizeModel, num, zero } from './models.mjs';
import { isObj, oneLine, str, truncate } from './tools.mjs';

const EXTERNAL_ROWS_MAX = 200;

export function accountView(u, now) {
  const win = w => {
    if (!isObj(w) || !Number.isFinite(w.utilization)) return null;
    const resetsAt = Date.parse(w.resets_at) || null;
    return { pct: resetsAt && resetsAt < now ? null : Math.round(w.utilization * 10) / 10, resetsAt };
  };
  return isObj(u) ? { fiveHour: win(u.utilization?.five_hour), sevenDay: win(u.utilization?.seven_day), fetchedAt: num(u.fetchedAtMs) || null } : null;
}

/** Daily usage is collected across all open transcript cursors, including subagents. */
export function dailyTokens(tails, now) {
  const today = dayKey(now);
  const tokens = zero();
  for (const { info } of tails) {
    const total = info.byDay.get(today);
    if (total) addTokens(tokens, total);
  }
  return tokens;
}

export function totalsFor(list, planList, tokensToday) {
  const live = list.filter(x => x.status !== 'ended');
  const subagentsRunning = live.reduce((n, x) => n + x.subagents.filter(a => a.state === 'running').length, 0);
  return {
    sessions: live.length,
    needsYou: live.filter(x => x.status === 'needs-you').length,
    busy: live.filter(x => x.status === 'busy').length,
    subagentsRunning,
    agentsRunning: live.filter(x => x.status === 'busy' || x.status === 'needs-you').length + subagentsRunning,
    tokensToday,
    plansInProgress: planList.filter(p => [...p.phases, ...p.runs].some(n => n.state === 'in-progress')).length,
    plansNeedingYou: planList.filter(p => p.needsYou?.length).length,
  };
}

export function createExternalUsage(redact) {
  const external = new Map();
  let externalError = null;

  function report(j, now) {
    if (!isObj(j)) return [400, 'body must be a JSON object'];
    // Redact before cutting to length, so a secret is never cut short of what the patterns recognise.
    const app = truncate(oneLine(redact(str(j.app).trim())), 80);
    const model = truncate(redact(str(j.model).trim()), 160);
    if (!app) return [400, '`app` is required'];
    if (!model) return [400, '`model` is required'];
    const tok = zero();
    for (const k of Object.keys(tok)) {
      const v = j[k] ?? 0;
      if (!Number.isInteger(v) || v < 0 || v > 1e9) return [400, `\`${k}\` must be a whole number from 0 to 1000000000`];
      tok[k] = v;
    }
    let at = now;
    if (j.at != null) {
      at = typeof j.at === 'number' ? j.at : Date.parse(j.at);
      if (!Number.isFinite(at)) return [400, '`at` must be epoch milliseconds or an ISO date'];
    }
    const key = `ingest\u0000${app}\u0000${model}`;
    let row = external.get(key);
    if (!row) {
      if ([...external.values()].filter(r => r.source === 'ingest').length >= EXTERNAL_ROWS_MAX) return [429, 'too many app and model rows'];
      const mi = normalizeModel(model);
      row = { source: 'ingest', app, provider: 'unknown', model: mi.model, modelRaw: model, tokens: zero(), windowStart: at, windowEnd: at, delayed: false };
      external.set(key, row);
    }
    row.provider = ['anthropic', 'bedrock'].includes(j.provider) ? j.provider : normalizeModel(model).provider;
    addTokens(row.tokens, tok);
    row.windowStart = Math.min(row.windowStart, at);
    row.windowEnd = Math.max(row.windowEnd, at);
    return [204, ''];
  }

  function replaceCloudWatch(rows) {
    for (const [key, row] of external) if (row.source === 'cloudwatch') external.delete(key);
    for (const [model, row] of rows) external.set('cloudwatch\u0000' + model, row);
    externalError = null;
  }

  return {
    report,
    replaceCloudWatch,
    setError: error => { externalError = error; },
    view: () => ({ external: [...external.values()], externalError }),
  };
}

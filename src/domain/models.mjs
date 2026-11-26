// Provider identity, context window and token accounting.

// Context window per model, in tokens (D13). A model missing here gets `context: null`: never a guess.
// The 5.2 rows: platform.claude.com/docs/en/models/fable-5-2/overview and .../mythos-5-2/overview ("Context window: 1M").
export const CONTEXT_WINDOWS = {
  'claude-fable-5-2': 1_000_000,
  'claude-mythos-5-2': 1_000_000,
  'claude-fable-5-1': 1_000_000,
  'claude-mythos-5-1': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-opus-5-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-5-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-5-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
};

export const MINUTE_MS = 60_000;
const PULSE_MINUTES = 30;

export function num(v) { return Number.isFinite(v) && v > 0 ? v : 0; }
export function zero() { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; }
export function addTokens(into, t, sign = 1) {
  into.input += sign * t.input; into.output += sign * t.output;
  into.cacheRead += sign * t.cacheRead; into.cacheWrite += sign * t.cacheWrite;
  return into;
}
function pad2(n) { return String(n).padStart(2, '0'); }
export function dayKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
export const minuteOf = ts => Math.floor(ts / MINUTE_MS) * MINUTE_MS;
export function startOfDay(ts = Date.now()) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }

const BEDROCK_PREFIX = /^(?:(?:us|eu|apac|ap|global|us-gov|jp|au|ca|sa|me|af)\.)?anthropic\.(claude-[a-z0-9.-]+?)(?:-\d{8})?(?:-v\d+(?::\d+)?)?(?::\d+)?$/i;
const BEDROCK_ARN = /^arn:aws[\w-]*:bedrock:[^:]*:\d*:(?:inference-profile|application-inference-profile|foundation-model|provisioned-model|custom-model|imported-model)\/(.+)$/i;

/** Normalise a model id for display: Bedrock ids, ARNs and dated or [1m] ids become e.g. `claude-opus-5-5`. */
export function normalizeModel(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { model: null, provider: 'unknown' };
  let s = raw.trim();
  let bedrock = false;
  const arn = BEDROCK_ARN.exec(s);
  if (arn) { s = arn[1]; bedrock = true; }
  const b = BEDROCK_PREFIX.exec(s);
  if (b) return { model: b[1].toLowerCase(), provider: 'bedrock' };
  if (bedrock) return { model: raw, provider: 'bedrock' };        // e.g. an application inference profile: opaque id
  const a = /^(claude-[a-z0-9-]+?)(?:-\d{8})?(?:\[1m\])?$/i.exec(s);
  if (a) return { model: a[1].toLowerCase(), provider: 'anthropic' };
  return { model: raw, provider: 'unknown' };
}

/**
 * Provider for one agent: its model id, then what its transcript shows (`info.bedrock`), then the flag of the Claude
 * Code folder it lives in (`info.rootBedrock`: `env.CLAUDE_CODE_USE_BEDROCK` in that folder's settings.json, the only key of that block read).
 */
export function modelInfo(raw, info) {
  const m = normalizeModel(raw);
  if (info?.codexProvider) m.provider = info.codexProvider;
  if (m.provider === 'anthropic' && (info?.bedrock || info?.rootBedrock)) m.provider = 'bedrock';
  return m;
}
/**
 * The model id as sent. On Bedrock, `message.model` is the plain name (`claude-opus-5-5`) and only the request
 * carries the Bedrock id (`us.anthropic.claude-opus-5-5`), so the request id is used when both name the same model.
 */
export function rawModel(info) {
  if (!info) return null;
  const req = info.requestModel, got = info.modelRaw;
  if (!got) return req;
  return req && normalizeModel(req).model === normalizeModel(got).model ? req : got;
}
export function contextFor(model, used, reportedWindow) {
  const window = num(reportedWindow) || CONTEXT_WINDOWS[model];
  if (!window || !used) return null;
  return { used, window, pct: Math.round(used / window * 1000) / 10 };
}

export function addDay(info, day, tok, sign) {
  let d = info.byDay.get(day);
  if (!d) { d = zero(); info.byDay.set(day, d); }
  addTokens(d, tok, sign);
}
export function addPulse(buckets, minute, output, current) {
  const first = current - (PULSE_MINUTES - 1) * MINUTE_MS;
  if (minute == null || minute < first || minute > current || !output) return;
  if (buckets.size >= PULSE_MINUTES && !buckets.has(minute)) {
    for (const at of buckets.keys()) if (at < first) buckets.delete(at);
  }
  const total = (buckets.get(minute) || 0) + output;
  if (total > 0) buckets.set(minute, total);
  else buckets.delete(minute);
}
export function pulseView(buckets, now) {
  const current = minuteOf(now), first = current - (PULSE_MINUTES - 1) * MINUTE_MS;
  let start = null, end = null;
  for (const at of buckets?.keys() || []) {
    if (at < first || at > current) continue;
    start = start == null ? at : Math.min(start, at);
    end = end == null ? at : Math.max(end, at);
  }
  const perMin = [];
  if (start != null) for (let at = start; at <= end; at += MINUTE_MS) perMin.push(buckets.get(at) || 0);
  return { start, perMin };
}

import { normalizeModel, num, startOfDay, zero } from '../domain/models.mjs';
import { oneLine, str, truncate } from '../domain/tools.mjs';

const CLOUDWATCH_EVERY_MS = 60_000;

export function createExternalUsageSource({ region, lifetime, onRows, onError }) {
  function pollCloudWatch() {
    const end = Date.now(), start = startOfDay(end);
    const period = Math.max(60, Math.ceil((end - start) / 60_000) * 60);
    const metrics = [['InputTokenCount', 'input'], ['OutputTokenCount', 'output'], ['CacheReadInputTokenCount', 'cacheRead'], ['CacheWriteInputTokenCount', 'cacheWrite']];
    const queries = metrics.map(([m], i) => ({ Id: `q${i}`, Expression: `SEARCH('{AWS/Bedrock,ModelId} MetricName="${m}"', 'Sum', ${period})`, ReturnData: true }));
    const args = ['cloudwatch', 'get-metric-data', '--region', region, '--start-time', new Date(start).toISOString(),
      '--end-time', new Date(end).toISOString(), '--metric-data-queries', JSON.stringify(queries), '--output', 'json'];
    lifetime.exec('aws', args, { timeout: 10_000, windowsHide: true, maxBuffer: 8 << 20 }, (err, out, errOut) => {
      if (lifetime.signal.aborted) return;
      try {
        if (err) throw new Error(err.code === 'ENOENT' ? 'aws CLI not found' : oneLine(errOut) || err.message);
        const res = JSON.parse(out);
        const rows = new Map();
        for (const r of res.MetricDataResults || []) {
          const metric = metrics[Number(String(r.Id).slice(1))];
          if (!metric) continue;
          const modelId = str(r.Label).replace(new RegExp(`\\s*${metric[0]}\\s*$`), '').trim() || 'unknown';
          let row = rows.get(modelId);
          if (!row) {
            const mi = normalizeModel(modelId);
            row = { source: 'cloudwatch', app: null, provider: 'bedrock', model: mi.model, modelRaw: modelId, tokens: zero(), windowStart: start, windowEnd: end, delayed: true };
            rows.set(modelId, row);
          }
          row.tokens[metric[1]] += (r.Values || []).reduce((a, v) => a + num(v), 0);
        }
        onRows(rows);
      } catch (e) {
        onError(truncate(`CloudWatch: ${oneLine(e.message)}`, 200));
      }
    });
  }

  function start() {
    if (!region) return;
    if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(region)) {
      onError('CloudWatch: HUD_BEDROCK_REGION is not a region name');
      return;
    }
    pollCloudWatch();
    lifetime.interval(pollCloudWatch, CLOUDWATCH_EVERY_MS);
  }

  return { start };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { createExternalUsage } from '../src/domain/usage.mjs';
import { createExternalUsageSource } from '../src/sources/external-usage.mjs';

test('CloudWatch replaces delayed rows, preserves reported usage and recovers from polling errors', () => {
  const usage = createExternalUsage(value => value);
  const model = 'us.anthropic.claude-haiku-5-5-v1:0';
  let reply, poll;
  const lifetime = {
    signal: new AbortController().signal,
    exec(command, args, options, callback) {
      assert.equal(command, 'aws');
      assert.deepEqual(args.slice(0, 4), ['cloudwatch', 'get-metric-data', '--region', 'us-east-1']);
      assert.equal(options.timeout, 10_000);
      assert.equal(JSON.parse(args[args.indexOf('--metric-data-queries') + 1]).length, 4);
      reply = callback;
    },
    interval(callback, ms) {
      assert.equal(ms, 60_000);
      poll = callback;
    },
  };
  const source = createExternalUsageSource({
    region: 'us-east-1', lifetime, onRows: usage.replaceCloudWatch, onError: usage.setError,
  });
  source.start();
  assert.deepEqual(usage.report({ app: 'fixture', model, input: 4 }, 1000), [204, '']);
  assert.deepEqual(usage.report({ app: 'fixture', model, output: 8, at: 900 }, 1100), [204, '']);
  reply(null, JSON.stringify({ MetricDataResults: [
    { Id: 'q0', Label: model + ' InputTokenCount', Values: [2, 3] },
    { Id: 'q1', Label: model + ' OutputTokenCount', Values: [11] },
    { Id: 'q2', Label: model + ' CacheReadInputTokenCount', Values: [13] },
    { Id: 'q3', Label: model + ' CacheWriteInputTokenCount', Values: [17] },
  ] }));
  const first = usage.view();
  const [reported, delayed] = first.external;
  assert.equal(first.externalError, null);
  assert.deepEqual([reported.source, reported.delayed, reported.windowStart, reported.windowEnd], ['ingest', false, 900, 1000]);
  assert.deepEqual(reported.tokens, { input: 4, output: 8, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual([delayed.source, delayed.delayed, delayed.provider, delayed.modelRaw], ['cloudwatch', true, 'bedrock', model]);
  assert.deepEqual(delayed.tokens, { input: 5, output: 11, cacheRead: 13, cacheWrite: 17 });

  poll();
  reply(Object.assign(new Error('missing command'), { code: 'ENOENT' }));
  assert.deepEqual(usage.view(), { external: [reported, delayed], externalError: 'CloudWatch: aws CLI not found' });

  poll();
  reply(null, '{"MetricDataResults":[]}');
  assert.deepEqual(usage.view(), { external: [reported], externalError: null });
});

test('CloudWatch stays off without a region and validates before starting a poll', () => {
  const errors = [];
  const lifetime = {
    exec() { assert.fail('unexpected external command'); },
    interval() { assert.fail('unexpected poll'); },
  };
  const options = { lifetime, onError: error => errors.push(error) };
  createExternalUsageSource({ ...options, region: '' }).start();
  assert.deepEqual(errors, []);
  createExternalUsageSource({ ...options, region: 'invalid region' }).start();
  assert.deepEqual(errors, ['CloudWatch: HUD_BEDROCK_REGION is not a region name']);
});

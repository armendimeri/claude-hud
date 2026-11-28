import { createRuntime } from '../app/runtime.mjs';
import { createExternalUsage } from '../domain/usage.mjs';
import { createHookSource } from '../sources/hooks.mjs';
import { createDemo } from './scenario.mjs';

/** @param {{operator?: object}} [options]  overrides for the private operator service (tests). */
export function createDemoRuntime(config, mode, options) {
  return createRuntime((lifetime, publisher) => {
    let demo;
    const ingestHook = createHookSource({ recordFile: config.recordFile, redactDeep: publisher.redactDeep, onEvent: null });
    const externalUsage = config.acceptUsage ? createExternalUsage(publisher.redact) : null;
    return {
      start() { demo = createDemo(mode, config, lifetime, publisher); },
      update: now => demo.project(now),
      ingestHook,
      reportUsage: externalUsage ? value => externalUsage.report(value, Date.now()) : undefined,
      // Demo history is synthetic: no roots, no file opener and no provider adapter, whatever profiles exist here.
      operator: { kind: 'demo', operatorDir: config.operatorDir },
    };
  }, options);
}

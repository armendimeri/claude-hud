import { createRuntime } from '../app/runtime.mjs';
import { createExternalUsage } from '../domain/usage.mjs';
import { createHookSource } from '../sources/hooks.mjs';
import { createDemo } from './scenario.mjs';

export function createDemoRuntime(config, mode) {
  return createRuntime((lifetime, publisher) => {
    let demo;
    const ingestHook = createHookSource({ recordFile: config.recordFile, redactDeep: publisher.redactDeep, onEvent: null });
    const externalUsage = config.acceptUsage ? createExternalUsage(publisher.redact) : null;
    return {
      start() { demo = createDemo(mode, config, lifetime, publisher); },
      update: now => demo.project(now),
      ingestHook,
      reportUsage: externalUsage ? value => externalUsage.report(value, Date.now()) : undefined,
    };
  });
}

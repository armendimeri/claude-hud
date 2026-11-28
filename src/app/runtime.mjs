import { execFile } from 'node:child_process';
import { EventEmitter, setMaxListeners } from 'node:events';
import fs from 'node:fs';
import { createPublisher } from './publish.mjs';

function createLifetime() {
  const controller = new AbortController();
  const { signal } = controller;
  setMaxListeners(0, signal); // Several independent watchers can share the lifetime of one instance.
  const timers = new Set();
  const cleanups = [];
  const pending = new Set();

  function track(promise) {
    pending.add(promise);
    const done = () => pending.delete(promise);
    promise.then(done, done);
    return promise;
  }

  function watch(file, options, listener) {
    if (!signal.aborted) return fs.watch(file, { ...options, signal }, listener);
  }

  return {
    signal,
    task: fn => (...args) => signal.aborted ? Promise.resolve() : track(fn(...args)),
    timeout(fn, delay) {
      if (signal.aborted) return null;
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, delay);
      timers.add(timer);
      return timer;
    },
    interval(fn, delay) {
      if (!signal.aborted) timers.add(setInterval(fn, delay));
    },
    clearTimer(timer) {
      clearTimeout(timer);
      timers.delete(timer);
    },
    watch,
    watchDirectory(dir, options, listener) {
      try { watch(dir, options, listener)?.on('error', () => {}); } catch {}
    },
    watchFile(file, options, listener) {
      if (signal.aborted) return;
      fs.watchFile(file, options, listener);
      cleanups.push(() => fs.unwatchFile(file, listener));
    },
    exec(file, args, options, callback) {
      const child = execFile(file, args, { ...options, signal }, callback);
      track(new Promise(resolve => child.once('close', resolve)));
    },
    async close() {
      controller.abort();
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      for (const cleanup of cleanups) cleanup();
      await Promise.allSettled(pending);
    },
  };
}

const OPERATOR_CLOSING = JSON.stringify({ code: 'closing', message: 'The HUD is closing.' });

/**
 * The optional private operator service (operator-cockpit P8). Nothing is imported or constructed until the first
 * private request, so a HUD that nobody pairs with never loads the operator modules or reads private history.
 * @param {() => Promise<{handle: Function, close: () => Promise<void>}>} load
 */
function createOperatorSlot(load) {
  let service = null;
  let closed = false;
  const unavailable = res => {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(OPERATOR_CLOSING);
  };
  return {
    async handle(req, res, context) {
      if (closed) return unavailable(res);
      service ??= load();
      let active;
      try {
        active = await service;
      } catch (error) {
        service = null;
        console.error('operator service failed to start:', error?.name || 'Error');
        return unavailable(res);
      }
      if (closed) return unavailable(res);
      return active.handle(req, res, context);
    },
    get loaded() { return service !== null; },
    async close() {
      closed = true;
      const active = service && await service.catch(() => null);
      await active?.close();
    },
  };
}

/**
 * Connects the application engine to an instance-local publisher, writer and lifecycle.
 * @param {Function} createEngine
 * @param {{operator?: object}} [options]  test and integration overrides for the operator service
 *   (open, resolveAdapter, createDispatcher, clock, verifyAcl).
 */
export function createRuntime(createEngine, { operator: operatorOptions = {} } = {}) {
  const lifetime = createLifetime();
  const events = new EventEmitter();
  const publisher = createPublisher(now => engine.update(now));
  const engine = createEngine(lifetime, publisher, events);
  const unavailable = [503, 'HUD is closing'];
  let started = false;
  let closing;
  let writes = [];
  const operator = engine.operator ? createOperatorSlot(() => import('../operator/routes.mjs').then(module => module.createOperatorService({
    ...engine.operator, readSnapshot: () => started && !closing ? publisher.readSnapshot() : null, ...operatorOptions,
  }))) : null;

  function flushWrites() {
    const batch = writes;
    writes = [];
    const results = batch.map(({ write, value }) => {
      try {
        return { result: write(value) };
      } catch (error) {
        return { error };
      }
    });
    try {
      // A successful response makes synchronous effects visible to the next read.
      publisher.refresh();
    } catch (error) {
      for (const { reject } of batch) reject(error);
      return;
    }
    batch.forEach(({ resolve, reject }, index) => {
      const outcome = results[index];
      if ('error' in outcome) reject(outcome.error);
      else resolve(outcome.result);
    });
  }

  function queue(write, value) {
    if (!started || closing) return Promise.resolve(unavailable);
    return new Promise((resolve, reject) => {
      if (!writes.length) lifetime.timeout(flushWrites, 0);
      writes.push({ write, value, resolve, reject });
    });
  }

  function start() {
    if (closing) throw new Error('HUD runtime is closed');
    if (started) return;
    started = true;
    engine.start();
    publisher.refresh();
  }

  function close() {
    return closing ??= closeRuntime();
  }

  async function closeRuntime() {
    // Abort pending private reads and invalidate operator credentials before the engine's sources stop.
    const operatorClosed = operator?.close();
    publisher.close();
    events.removeAllListeners();
    for (const { resolve } of writes) resolve(unavailable);
    writes = [];
    await operatorClosed;
    await lifetime.close();
  }

  return {
    start,
    source: { readSnapshot: publisher.readSnapshot, subscribeUpdates: publisher.subscribeUpdates, close },
    writer: {
      ingestHook: value => queue(engine.ingestHook, value),
      ...(engine.reportUsage && { reportUsage: value => queue(engine.reportUsage, value) }),
    },
    operator,
    close,
  };
}

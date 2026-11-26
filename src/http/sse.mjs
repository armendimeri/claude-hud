import { BASE_HEADERS } from './security.mjs';
import { streamState } from '../contract/snapshot.mjs';

const STATE_MIN_INTERVAL_MS = 250;
const KEEPALIVE_MS = 15_000;
const HEADERS = {
  ...BASE_HEADERS,
  'content-type': 'text/event-stream; charset=utf-8',
  connection: 'keep-alive',
};

/** @param {import('../contract/snapshot.mjs').HudSource} source */
export function createSse(source) {
  const clients = new Map();
  let pending;
  let timer = null;
  let lastStateAt = 0;

  const frame = (event, body) => `event: ${event}\ndata: ${body}\n\n`;

  function flush() {
    timer = null;
    if (!clients.size || !pending) return;
    const snapshot = pending;
    pending = null;
    lastStateAt = Date.now();
    const plansBody = JSON.stringify({ plans: snapshot.plans });
    const state = streamState(snapshot);
    const stateBody = JSON.stringify(state);
    let plansFrame, stateFrame;
    for (const [res, client] of clients) {
      if (client.plansBody !== plansBody) {
        res.write(plansFrame ??= frame('plans', plansBody));
        client.plansBody = plansBody;
      }
      if (client.stateBody !== stateBody) {
        res.write(stateFrame ??= frame('state', JSON.stringify({ now: snapshot.now, uptime: snapshot.uptime, ...state })));
        client.stateBody = stateBody;
      }
    }
  }

  const unsubscribe = source.subscribeUpdates(({ snapshot, lines }) => {
    if (!clients.size) return;
    for (const line of lines) {
      const message = frame('event', JSON.stringify(line));
      for (const res of clients.keys()) res.write(message);
    }
    pending = snapshot;
    timer ??= setTimeout(flush, Math.max(0, lastStateAt + STATE_MIN_INTERVAL_MS - Date.now()));
  });

  const keepalive = setInterval(() => {
    for (const res of clients.keys()) res.write(': keep-alive\n\n');
  }, KEEPALIVE_MS);

  function open(req, res) {
    res.writeHead(200, HEADERS);
    if (req.method === 'HEAD') return res.end();
    res.socket?.setNoDelay(true);
    // Reading, sending the seed and joining happen synchronously. Any pending broadcast sees the seed as delivered.
    const snapshot = source.readSnapshot();
    res.write('retry: 2000\n\n' + frame('state', JSON.stringify({ ...snapshot, full: true })));
    clients.set(res, {
      plansBody: JSON.stringify({ plans: snapshot.plans }),
      stateBody: JSON.stringify(streamState(snapshot)),
    });
    res.once('close', () => {
      clients.delete(res);
      if (!clients.size) {
        clearTimeout(timer);
        timer = null;
        pending = null;
      }
    });
  }

  function close() {
    unsubscribe();
    clearTimeout(timer);
    clearInterval(keepalive);
    pending = null;
    for (const res of clients.keys()) res.end();
    clients.clear();
  }

  return { open, close };
}

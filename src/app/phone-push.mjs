import { MINUTE_MS } from '../domain/models.mjs';
import { oneLine } from '../domain/tools.mjs';

/** Sends opt-in phone notices for fresh needs-you events. */
export function createPhonePush({ url: configured, lifetime, redact, onChange }) {
  const push = { enabled: false, lastError: null };
  const pushBySession = new Map(), pushTimes = [];
  let pushUrl = null;
  function start() {
    if (!configured) return;
    try {
      const url = new URL(configured);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      pushUrl = url;
      push.enabled = true;
    } catch {
      push.lastError = 'HUD_PUSH_URL must be an HTTP or HTTPS URL';
      console.error(push.lastError + '. Phone push disabled.');
    }
  }
  const onNeedsYou = lifetime.task(async function (session, kind) {
    if (!pushUrl || !['permission', 'question', 'input'].includes(kind)) return;
    const now = performance.now();
    for (const [id, sent] of pushBySession) if (now - sent >= MINUTE_MS) pushBySession.delete(id);
    while (pushTimes.length && now - pushTimes[0] >= 60 * MINUTE_MS) pushTimes.shift();
    if (pushBySession.has(session.id) || pushTimes.length >= 20) return;
    pushBySession.set(session.id, now);
    pushTimes.push(now);

    let error = null;
    try {
      const res = await fetch(pushUrl, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]),
        headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: 'Claude HUD' },
        body: redact(oneLine(session.project || 'Session')) + ' needs you: ' + kind,
      });
      if (!res.ok) error = 'Phone push HTTP ' + res.status;
      void res.body?.cancel().catch(() => {});
    } catch (err) {
      error = err?.name === 'TimeoutError' ? 'Phone push timed out' : 'Phone push request failed';
    }
    if (error !== push.lastError) {
      push.lastError = error;
      onChange();
    }
  });

  return { start, onNeedsYou, status: push };
}

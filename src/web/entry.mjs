import { hudClient } from './legacy-hud.mjs';

// The page at `/`: the HUD on the live stream.
function pageMain(H) {
  'use strict';
  // lastAt: the last state received (the server sends state only on change, so it can be old on a healthy stream).
  // lostAt: when the stream was lost. Reconnecting (connecting before any state) for 10 s after that, then down.
  // kept: the plans and feed of the last message that carried them.
  // last: the last state received, with the kept plans and feed put back.
  let es = null, lastAt = 0, lostAt = 0, retryTimer = 0, kept = null, last = null;
  const query = new URLSearchParams(location.search), kiosk = query.has('kiosk');
  document.documentElement.classList.toggle('kiosk', kiosk);
  if (kiosk) {
    let lock = null, acquiring = false;
    async function keepAwake() {
      if (!navigator.wakeLock || document.hidden || acquiring || (lock && !lock.released)) return;
      acquiring = true;
      try { lock = await navigator.wakeLock.request('screen'); } catch {}
      finally { acquiring = false; }
    }
    document.addEventListener('visibilitychange', keepAwake);
    void keepAwake();
  }
  const hud = H.createHud(document.body, {
    reconnect: () => connect(),
    kiosk, project: query.get('project'),
    onProject(name) {
      const url = new URL(location.href);
      if (name) url.searchParams.set('project', name);
      else url.searchParams.delete('project');
      history.replaceState(history.state, '', url);
    },
  });
  H.boot(hud);
  let hiddenAt = document.hidden ? Date.now() : null, pendingSince = null, summarizedAt = 0, fetching = false;
  async function refreshAway() {
    if (document.hidden || pendingSince === null || fetching) return;
    fetching = true;
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (!res.ok) return;
      const st = await res.json(), receivedAt = Date.now();
      if (document.hidden || !Array.isArray(st.feed)) return;
      // Feed times come from the HUD host. Translate the browser's absence into that clock.
      hud.showAway(st.feed, st.now - (receivedAt - pendingSince));
      pendingSince = null;
      summarizedAt = receivedAt;
    } catch { /* Try again on the next visibility change or successful connection. */ }
    finally { fetching = false; }
  }
  function returnFrom(since) {
    if (since != null) {
      const start = Math.max(since, summarizedAt);
      if (Date.now() - start >= 5 * 60_000) pendingSince = Math.min(pendingSince ?? start, start);
    }
    void refreshAway();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt ??= Date.now(); return; }
    returnFrom(hiddenAt);
    hiddenAt = null;
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hud.clearProject(); });

  const setConn = sv => hud.setConn(sv, { lastAt });
  const judge = () => { if (lostAt && es && es.readyState !== 1) setConn(Date.now() - lostAt > 10000 ? 'down' : lastAt ? 'reconnecting' : 'connecting'); };
  function connect() {
    if (es) es.close();
    clearTimeout(retryTimer);
    es = new EventSource('/api/stream');
    es.onopen = () => { const since = lostAt; lostAt = 0; setConn('live'); returnFrom(since || null); };
    es.onerror = () => {
      if (!lostAt) lostAt = Date.now();
      judge();
      if (es.readyState === 2) retryTimer = setTimeout(connect, 3000);   // closed for good: start a new stream
    };
    // The first state of a connection is full (`full: true`) and replaces what the page kept; later ones come without
    // plans and feed, so the kept ones are put back (PLAN hud-0-3 §4.4). A `plans` event replaces the kept plans.
    es.addEventListener('state', e => {
      let st; try { st = JSON.parse(e.data); } catch { return; }
      lastAt = Date.now(); lostAt = 0; setConn('live');
      if (st.full || !kept) kept = { plans: st.plans || [], feed: st.feed || [] };
      if (!st.plans) st.plans = kept.plans;
      if (!st.feed) st.feed = kept.feed;
      last = st;
      hud.render(st);
    });
    es.addEventListener('plans', e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (!kept || !last || !Array.isArray(m.plans)) return;
      kept.plans = m.plans;
      // The last state again with the new plans; its server time moves on by the time since it came, so the clock
      // keeps its offset.
      const dt = Date.now() - lastAt;
      hud.render(Object.assign({}, last, { plans: m.plans, now: last.now + dt, uptime: last.uptime + dt }));
    });
    es.addEventListener('event', e => { try { hud.feed(JSON.parse(e.data)); } catch {} });
  }
  connect();
  setInterval(judge, 1000);
}

const H = hudClient();
// Preserve the global client binding used by the browser smoke checks.
Object.defineProperty(globalThis, 'H', { value: H });
pageMain(H);

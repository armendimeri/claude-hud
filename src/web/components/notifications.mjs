import { BOARD_MARKS } from './plans.mjs';
import { prefs } from './preferences.mjs';
import { boardPlanKey } from '../data/selectors.mjs';

// What changed between two snapshots, for sound, voice and notifications.
export function happenings(prev, next) {
  const out = [];
  if (!prev) return out;
  const pm = new Map(prev.sessions.map(x => [x.id, x]));
  for (const x of next.sessions) {
    const p = pm.get(x.id);
    if (!p) { if (x.status !== 'ended') out.push({ type: 'session-start', x }); if (x.status === 'needs-you') out.push({ type: 'needs-you', x }); continue; }
    if (x.status === 'needs-you' && x.needsYou && (p.status !== 'needs-you' || !p.needsYou || p.needsYou.since !== x.needsYou.since || p.needsYou.reason !== x.needsYou.reason)) out.push({ type: 'needs-you', x });
    if (x.status === 'ended' && p.status !== 'ended') out.push({ type: 'session-end', x });
    const ps = new Map((p.subagents || []).map(a => [a.id, a]));
    for (const a of x.subagents || []) {
      const q = ps.get(a.id);
      if (!q) { if (a.state === 'running') out.push({ type: 'sub-start', x, a }); } else if (q.state === 'running' && a.state === 'done') out.push({ type: 'sub-done', x, a });
    }
  }
  const pp = new Map((prev.plans || []).map(pl => [boardPlanKey(pl), pl]));
  const boardTitles = new Map();
  for (const pl of next.plans || []) {
    const key = boardPlanKey(pl);
    boardTitles.set(key, pl.title || pl.slug);
    const q = pp.get(key); if (!q) continue;
    const qs = new Map([...(q.phases || []), ...(q.runs || [])].map(n => [n.id, n.state]));
    for (const n of [...(pl.phases || []), ...(pl.runs || [])]) { const was = qs.get(n.id); if (was && was !== n.state) out.push({ type: 'phase', plan: pl, n, from: was }); }
  }
  for (const [key, item] of Object.entries(next.board?.items || {})) {
    const previous = prev.board?.items?.[key]?.flags || [];
    const cut = key.lastIndexOf('#'), title = boardTitles.get(key.slice(0, cut));
    for (const flag of item.flags || []) {
      if (title && BOARD_MARKS[flag] && !previous.includes(flag)) out.push({ type: 'board-mark', text: `${title}: ${key.slice(cut + 1)} ${BOARD_MARKS[flag][0].toLowerCase()}` });
    }
  }
  const previousAlerts = new Set((prev.alerts || []).map(a => a.id));
  for (const alert of next.alerts || []) if (!previousAlerts.has(alert.id)) out.push({ type: 'warning', alert });
  if ((prev.totals?.agentsRunning || 0) > 0 && (next.totals?.agentsRunning || 0) === 0) out.push({ type: 'all-idle' });
  return out;
}
function needsPhrase(x) {
  const p = x.project || 'A session', r = x.needsYou?.reason || '', k = x.needsYou?.kind;
  if (/plan approval/i.test(r)) return `${p} has a plan for your approval`;
  if (k === 'permission') return `${p} needs your approval`;
  if (k === 'question') return `${p} has a question for you`;
  if (k === 'input') return `${p} is waiting for you`;
  return `${p} needs you`;
}
export function createNotifications(lifetime) {
  const audio = (() => {
    let ctx = null, last = 0;
    const TONES = { needs: [[740, 0, .05], [554, .055, .05]], agent: [[523, 0, .04], [784, .045, .045]], done: [[1046, 0, .07]], session: [[440, 0, .06]],
      ended: [[330, 0, .07]], plan: [[659, 0, .05], [880, .05, .04]], idle: [[392, 0, .08]] };
    function ensure() { if (!ctx) { const A = window.AudioContext || window.webkitAudioContext; if (A) ctx = new A(); } if (ctx && ctx.state === 'suspended') ctx.resume(); return ctx; }
    function play(kind) {
      const t = performance.now(); if (t - last < 300) return; last = t;
      const c = ensure(); if (!c) return;
      const t0 = c.currentTime + 0.01;
      for (const [f, dt, d] of TONES[kind] || TONES.session) {
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0, t0 + dt); g.gain.linearRampToValueAtTime(0.07, t0 + dt + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + d);
        o.connect(g).connect(c.destination); o.start(t0 + dt); o.stop(t0 + dt + d + 0.02);
      }
    }
    lifetime.onClose(() => { if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {}); });
    return { ensure, play, kinds: Object.keys(TONES) };
  })();
  const voice = (() => {
    const q = [], synth = window.speechSynthesis;
    let last = 0, timer = 0, chosen = null, utterance = null;
    function pick() {
      if (chosen || !synth) return chosen;
      const vs = synth.getVoices();
      // Neural voices ("Online (Natural)" in Edge, "Google UK English" in Chrome) sound far less robotic than the local ones.
      for (const re of [/Natural.*(Ryan|Sonia|Thomas|Libby|Guy|Davis|Brian|Andrew|Jenny|Aria)/i, /Natural/i, /Online/i]) { const v = vs.find(v => re.test(v.name) && /^en/i.test(v.lang)); if (v) return chosen = v; }
      for (const re of [/Ryan/i, /George/i, /Daniel/i, /UK English Male/i, /Thomas/i, /Brian/i, /Arthur/i]) { const v = vs.find(v => re.test(v.name) && /^en/i.test(v.lang)); if (v) return chosen = v; }
      return chosen = vs.find(v => /en-GB/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null;
    }
    function pump() {
      if (lifetime.signal.aborted || timer || !q.length || !synth) return;
      const wait = Math.max(0, last + 4000 - Date.now());
      if (wait || synth.speaking) { timer = lifetime.delay(() => { timer = 0; pump(); }, Math.max(wait, 300)); return; }
      const u = new SpeechSynthesisUtterance(q.shift()), v = pick();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = 1; u.pitch = 1; u.volume = 0.9; utterance = u;
      u.onend = u.onerror = () => { utterance = null; pump(); };
      last = Date.now(); synth.speak(u);
    }
    if (synth && synth.addEventListener) lifetime.listen(synth, 'voiceschanged', () => { chosen = null; });
    lifetime.onClose(() => {
      q.length = 0;
      if (utterance) synth.cancel();
    });
    return {
      say(text) { if (!synth || q[q.length - 1] === text) return; if (q.length > 4) q.shift(); q.push(text); pump(); },
      get name() { const v = pick(); return v ? v.name : null; },
    };
  })();
  function notify(title, body, tag) {
    if (!prefs.get('notify', false) || !('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return false;
    try { new Notification(title, { body, tag, silent: false }); return true; } catch { return false; }
  }
  function announcer() {
    let idleTimer = 0;
    return function announce(list, st) {
      const sound = prefs.get('sound', false), speak = prefs.get('voice', false);
      for (const e of list) {
        if (e.type === 'needs-you') {
          if (sound) audio.play('needs'); if (speak) voice.say(needsPhrase(e.x));
          notify(`${e.x.project || 'A session'} needs you`, `${e.x.needsYou.reason} · ${e.x.title || e.x.name || ''}`, 'needs-' + e.x.id);
        } else if (e.type === 'phase') {
          const big = ['handed-off', 'blocked', 'bounced'].includes(e.n.state);
          if (sound) audio.play('plan');
          if (big) {
            const w = e.n.state === 'handed-off' ? 'handed off' : e.n.state === 'blocked' ? 'is blocked' : 'bounced';
            if (speak) voice.say(`Phase ${e.n.id} ${w}`);
            notify(`${e.plan.title}: ${e.n.id} ${w}`, `${e.plan.project} · ${e.n.name || ''}`, 'plan-' + e.plan.slug + e.n.id);
          }
        } else if (e.type === 'board-mark') {
          if (sound) audio.play('plan'); if (speak) voice.say(e.text);
        } else if (e.type === 'warning') {
          const title = e.alert.project || (e.alert.sessionId ? 'Session' : 'Claude account');
          if (sound) audio.play('plan');
          if (speak) voice.say(`${title}. ${e.alert.text}`);
          notify(`${title} warning`, e.alert.text, e.alert.id);
        } else if (e.type === 'sub-start') { if (sound) audio.play('agent'); }
        else if (e.type === 'sub-done') { if (sound) audio.play('done'); }
        else if (e.type === 'session-start') { if (sound) audio.play('session'); }
        else if (e.type === 'session-end') { if (sound) audio.play('ended'); }
        else if (e.type === 'all-idle') {
          lifetime.cancelDelay(idleTimer);
          idleTimer = lifetime.delay(() => { if (prefs.get('voice', false)) voice.say('All agents idle'); if (prefs.get('sound', false)) audio.play('idle'); }, 6000);
        }
      }
      if ((st.totals?.agentsRunning || 0) > 0) { lifetime.cancelDelay(idleTimer); idleTimer = 0; }
    };
  }

  const announce = announcer();
  return { audio, voice, announce };
}

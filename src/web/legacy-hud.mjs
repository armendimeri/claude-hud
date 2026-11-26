// The client library: every component of the page and the gallery. Runs in the browser only.
export function hudClient() {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const doc = document, root = doc.documentElement;
  const EASE = 'cubic-bezier(.2, .8, .2, 1)';

  // ---- DOM ----------------------------------------------------------------------------------------------------------
  function apply(el, p, isSvg) {
    for (const k in p) {
      const v = p[k];
      if (v == null || v === false) continue;
      if (k === 'class') { if (isSvg) el.setAttribute('class', v); else el.className = v; }
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') { if (typeof v === 'string') el.setAttribute('style', v); else Object.assign(el.style, v); }
      else if (k === 'on') { for (const e in v) el.addEventListener(e, v[e]); }
      else if (k === 'data') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  function add(el, kids) {
    for (const k of kids) {
      if (k == null || k === false) continue;
      if (Array.isArray(k)) add(el, k);
      else el.append(typeof k === 'object' ? k : doc.createTextNode(String(k)));
    }
    return el;
  }
  function h(tag, p, ...kids) { const el = doc.createElement(tag); if (p) apply(el, p, false); return add(el, kids); }
  function s(tag, p, ...kids) { const el = doc.createElementNS(NS, tag); if (p) apply(el, p, true); return add(el, kids); }
  function txt(el, t) { t = t == null ? '' : String(t); if (el.textContent !== t) el.textContent = t; }
  function setAttr(el, k, v) {
    if (v == null || v === false) { if (el.hasAttribute(k)) el.removeAttribute(k); return; }
    v = String(v); if (el.getAttribute(k) !== v) el.setAttribute(k, v);
  }
  function setData(el, k, v) {
    if (v == null || v === '') { if (k in el.dataset) delete el.dataset[k]; return; }
    v = String(v); if (el.dataset[k] !== v) el.dataset[k] = v;
  }
  function show(el, on) { if (el.hidden === !!on) el.hidden = !on; }

  // ---- time and numbers ----------------------------------------------------------------------------------------------
  let skew = 0;                                   // server clock minus browser clock
  const now = () => Date.now() + skew;
  function syncClock(serverNow) { if (Number.isFinite(serverNow)) { const k = serverNow - Date.now(); if (Math.abs(k - skew) > 250) skew = k; } }
  const pad2 = n => String(n).padStart(2, '0');
  function fmtTok(n) {
    n = Number(n) || 0;
    if (n < 999.5) return String(Math.round(n));
    const units = ['k', 'M', 'B'];
    let v = n / 1000, i = 0;
    while (v >= 999.5 && i < 2) { v /= 1000; i++; }
    return v.toFixed(v >= 99.95 ? 0 : v >= 9.995 ? 1 : 2) + units[i];
  }
  const fmtInt = n => Math.round(Number(n) || 0).toLocaleString('en-US');
  function fmtPct(p) { if (p == null || !Number.isFinite(p)) return '—'; if (p >= 99.95) return '100%'; return (p < 9.95 ? p.toFixed(1) : Math.round(p)) + '%'; }
  function fmtDur(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000)), hh = Math.floor(sec / 3600), mm = Math.floor(sec % 3600 / 60), ss = sec % 60;
    return hh ? `${hh}:${pad2(mm)}:${pad2(ss)}` : `${mm}:${pad2(ss)}`;
  }
  function fmtAge(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60); if (m < 60) return m + 'm';
    const hr = Math.floor(m / 60); if (hr < 24) return hr + 'h ' + (m % 60) + 'm';
    return Math.floor(hr / 24) + 'd ' + (hr % 24) + 'h';
  }
  function fmtClock(ts) { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
  function fmtDate(ts) { return new Date(ts).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }); }
  const headline = t => t ? (t.input || 0) + (t.output || 0) + (t.cacheWrite || 0) : 0;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  function shortModel(m) {
    if (!m) return '';
    const a = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(m);
    if (a) return a[1] + ' ' + a[2] + (a[3] ? '.' + a[3] : '');
    const b = /^claude-(\d+)(?:-(\d))?-([a-z]+)/.exec(m);
    if (b) return b[3] + ' ' + b[1] + (b[2] ? '.' + b[2] : '');
    return m.length > 16 ? m.slice(0, 15) + '…' : m;
  }
  const TOOL_ICONS = { Bash: 'terminal', PowerShell: 'terminal', BashOutput: 'terminal', KillShell: 'terminal', Read: 'file', NotebookRead: 'file',
    Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit', Grep: 'search', Glob: 'search', LS: 'search', WebFetch: 'web', WebSearch: 'web',
    Agent: 'agent', Task: 'agent', TodoWrite: 'plan', ExitPlanMode: 'plan', AskUserQuestion: 'bell',
    exec_command: 'terminal', shell_command: 'terminal', shell: 'terminal', read_file: 'file', apply_patch: 'edit',
    spawn_agent: 'agent', update_plan: 'plan', request_user_input: 'bell', request_user_input_async: 'bell' };
  const toolIcon = n => TOOL_ICONS[n] || 'tool';
  const ctxLevel = p => p == null ? 'none' : p >= 90 ? 'hot' : p >= 70 ? 'warn' : 'ok';
  const provName = p => p === 'openai' ? 'OpenAI' : p === 'bedrock' ? 'Bedrock' : p === 'anthropic' ? 'Anthropic' : 'Unknown';
  const provLetter = p => p === 'openai' ? 'O' : p === 'bedrock' ? 'B' : p === 'anthropic' ? 'A' : '?';
  // The needs-you reason where room is short: "Allow Bash", "Question".
  function shortReason(r) {
    const m = /^Permission:\s*(.+)$/i.exec(r || '');
    if (m) return 'Allow ' + m[1];
    return { 'Permission needed': 'Permission', 'Question for you': 'Question', 'Waiting for your input': 'Input' }[r] || r || 'Needs you';
  }
  // Sessions the network draws and the vitals count: open ones, plus ended ones for 15 minutes (or while a session
  // they launched is still open).
  // hud-0-3 D6: an idle session with a running subagent is not waiting for you. The page shows it as "Agents working"
  // (a display state only: the API keeps its four statuses and adds `agentsRunning`).
  const viewStatus = x => x.status === 'idle' && x.agentsRunning > 0 ? 'agents' : x.status;
  function shownSessions(sessions) {
    const t = now(), live = sessions.filter(x => x.status !== 'ended');
    return sessions.filter(x => x.status !== 'ended' || live.some(l => l.startedBy === x.id) || (x.endedAt && t - x.endedAt < 15 * 60_000));
  }

  // ---- preferences and motion ----------------------------------------------------------------------------------------
  const prefs = {
    get(k, d) { try { const v = localStorage.getItem('hud.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('hud.' + k, JSON.stringify(v)); } catch {} },
  };
  const rmQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const motion = {
    rm: rmQuery.matches, fx: prefs.get('effects', true), listeners: new Set(),
    get ambient() { return this.fx && !this.rm; },
    apply() { root.classList.toggle('rm', this.rm); root.classList.toggle('fx', this.ambient); for (const f of this.listeners) f(); },
    setFx(on) { this.fx = !!on; prefs.set('effects', this.fx); this.apply(); },
    setRm(on) { this.rm = !!on; this.apply(); },
    on(f) { this.listeners.add(f); },
  };
  rmQuery.addEventListener('change', e => motion.setRm(e.matches));
  motion.apply();
  const easeOut = k => 1 - Math.pow(1 - k, 3);

  // Ambient glitch on entry and on a status change (layer 1: EFFECTS only).
  function glitch(el) {
    if (!motion.ambient || !el.animate) return;
    el.animate([
      { transform: 'translateX(0)', filter: 'none', opacity: 1 },
      { transform: 'translateX(-3px)', filter: 'brightness(1.7) hue-rotate(-25deg)', opacity: .75, offset: .2 },
      { transform: 'translateX(2px)', filter: 'brightness(1.3) hue-rotate(20deg)', opacity: 1, offset: .45 },
      { transform: 'translateX(-1px)', filter: 'none', opacity: .85, offset: .7 },
      { transform: 'translateX(0)', filter: 'none', opacity: 1 },
    ], { duration: 260, easing: 'steps(6, end)' });
  }

  // ---- icons (24-unit grid, 1.5 px stroke) and status glyphs (16-unit) ----------------------------------------------
  const ICONS = {
    terminal: [['rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2 }], ['path', { d: 'M7 9.5l3 2.5-3 2.5M12.5 15H17' }]],
    file: [['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }], ['path', { d: 'M14 3v5h5M9 13h6M9 17h4' }]],
    edit: [['path', { d: 'M4 20h4L19 9l-4-4L4 16z' }], ['path', { d: 'M13.5 6.5l4 4' }]],
    search: [['circle', { cx: 11, cy: 11, r: 6 }], ['path', { d: 'M20 20l-4.6-4.6' }]],
    web: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z' }]],
    agent: [['circle', { cx: 12, cy: 6.5, r: 2.5 }], ['circle', { cx: 6, cy: 17.5, r: 2.5 }], ['circle', { cx: 18, cy: 17.5, r: 2.5 }], ['path', { d: 'M10.7 8.7l-3.4 6.6M13.3 8.7l3.4 6.6' }]],
    plan: [['path', { d: 'M12 3l3 1.7v3.6L12 10l-3-1.7V4.7z' }], ['path', { d: 'M6 14l3 1.7v3.6L6 21l-3-1.7v-3.6z' }], ['path', { d: 'M18 14l3 1.7v3.6L18 21l-3-1.7v-3.6z' }], ['path', { d: 'M10.5 9.5L7.5 14M13.5 9.5l3 4.5' }]],
    bell: [['path', { d: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z' }], ['path', { d: 'M10 20.5a2 2 0 0 0 4 0' }]],
    voice: [['rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }], ['path', { d: 'M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6' }]],
    sound: [['path', { d: 'M4 9.5h3.5L12 6v12l-4.5-3.5H4z' }], ['path', { d: 'M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11' }]],
    effects: [['path', { d: 'M11 3.5l1.6 4.4 4.4 1.6-4.4 1.6L11 15.5l-1.6-4.4L5 9.5l4.4-1.6z' }], ['path', { d: 'M18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z' }]],
    tool: [['path', { d: 'M14.7 6.3a4 4 0 0 0-5.4 5.1L4 16.7 7.3 20l5.3-5.3a4 4 0 0 0 5.1-5.4l-2.4 2.4-2.6-.7-.7-2.6z' }]],
    network: [['circle', { cx: 12, cy: 12, r: 2.5 }], ['circle', { cx: 5, cy: 5, r: 1.8 }], ['circle', { cx: 19, cy: 5, r: 1.8 }], ['circle', { cx: 5, cy: 19, r: 1.8 }], ['circle', { cx: 19, cy: 19, r: 1.8 }], ['path', { d: 'M10.2 10.2L6.3 6.3M13.8 10.2l3.9-3.9M10.2 13.8l-3.9 3.9M13.8 13.8l3.9 3.9' }]],
    cards: [['rect', { x: 4, y: 4.5, width: 16, height: 6, rx: 1 }], ['rect', { x: 4, y: 13.5, width: 16, height: 6, rx: 1 }]],
    window: [['path', { d: 'M11 5H5v14h14v-6M13 5h6v6M19 5l-8 8' }]],
    branch: [['circle', { cx: 7, cy: 6, r: 2 }], ['circle', { cx: 7, cy: 18, r: 2 }], ['circle', { cx: 17, cy: 8, r: 2 }], ['path', { d: 'M7 8v8M17 10a5 5 0 0 1-5 5H9' }]],
    check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
    alert: [['path', { d: 'M12 4l9 15.5H3z' }], ['path', { d: 'M12 10v4.5M12 17.3v.2' }]],
    close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
    pin: [['path', { d: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v7' }]],
    chevron: [['path', { d: 'M7 10l5 5 5-5' }]],
    clock: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 7.5V12l3 2' }]],
    slash: [['path', { d: 'M5 5l14 14' }]],
  };
  function icon(name, cls) {
    const svg = s('svg', { class: 'ic' + (cls ? ' ' + cls : ''), viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
    for (const [t, a] of ICONS[name] || ICONS.tool) svg.append(s(t, a));
    return svg;
  }
  const HEX16 = 'M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z';
  const GLYPHS = {
    busy: [['path', { d: 'M8 2.5a5.5 5.5 0 1 1-5.5 5.5' }], ['circle', { cx: 8, cy: 8, r: 1.6, class: 'gf' }]],
    needs: [['path', { d: 'M8 2l6.5 11.5h-13z' }], ['path', { d: 'M8 6.5v3M8 11.6v.1' }]],
    idle: [['circle', { cx: 8, cy: 8, r: 5 }]],
    ended: [['rect', { x: 3.5, y: 3.5, width: 9, height: 9 }], ['path', { d: 'M6 8h4' }]],
    running: [['circle', { cx: 8, cy: 8, r: 5.5, 'stroke-dasharray': '7 4.5' }]],
    done: [['circle', { cx: 8, cy: 8, r: 6 }], ['path', { d: 'M5.2 8.2l1.9 1.9 3.8-4' }]],
    todo: [['path', { d: HEX16, 'stroke-dasharray': '2 2' }]],
    inprog: [['path', { d: HEX16 }], ['circle', { cx: 8, cy: 8, r: 1.8, class: 'gf' }]],
    handoff: [['circle', { cx: 8, cy: 8, r: 6 }], ['path', { d: 'M5.5 8h5M8.6 5.8L10.8 8l-2.2 2.2' }]],
    bounced: [['path', { d: 'M5 6h5a3 3 0 0 1 0 6H6' }], ['path', { d: 'M7 3.5L4.5 6 7 8.5' }]],
    partial: [['circle', { cx: 8, cy: 8, r: 5.5 }], ['path', { d: 'M8 2.5a5.5 5.5 0 0 1 0 11z', class: 'gf' }]],
    unknown: [['circle', { cx: 8, cy: 8, r: 5.5, 'stroke-dasharray': '1.5 2.5' }]],
  };
  function glyph(name) {
    const svg = s('svg', { class: 'gl' + (name === 'running' ? ' spin' : ''), viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' });
    for (const [t, a] of GLYPHS[name] || GLYPHS.unknown) svg.append(s(t, a));
    return svg;
  }
  // state -> [glyph, word, colour]: status is always a word, a shape and a colour.
  const STATUS = {
    'needs-you': ['needs', 'Needs you', 'alert'], busy: ['busy', 'Busy', 'amber'], idle: ['idle', 'Idle', 'arc'], ended: ['ended', 'Ended', 'dim'],
    agents: ['running', 'Agents working', 'agent'], running: ['running', 'Running', 'agent'], done: ['done', 'Done', 'ok'],
    todo: ['todo', 'Todo', 'dim'], 'in-progress': ['inprog', 'In progress', 'arc'], 'handed-off': ['handoff', 'Handed off', 'ok'], accepted: ['done', 'Accepted', 'ok'],
    blocked: ['needs', 'Blocked', 'alert'], bounced: ['bounced', 'Bounced', 'alert'], partial: ['partial', 'Partial', 'amber'], unknown: ['unknown', 'Unknown', 'dim'],
  };
  function statusTag() {
    const g = h('span', { style: 'display:flex' }), w = h('span'), x = h('span', { class: 'stag-x mono', hidden: true });
    const el = h('span', { class: 'stag label' }, g, w, x);
    let cur = null;
    return {
      el,
      set(state, extra, word) {
        const [gl, wd, c] = STATUS[state] || STATUS.unknown;
        if (cur !== state) { cur = state; el.dataset.c = c; g.replaceChildren(glyph(gl)); }
        txt(w, word || wd); txt(x, extra || ''); show(x, !!extra);
      },
    };
  }
  function provBadge() {
    const el = h('span', { class: 'chip prov' });
    return { el, set(p, raw) { setData(el, 'p', p || 'unknown'); txt(el, provName(p)); setData(el, 'tip', 'Runs on ' + provName(p) + (raw ? ' · model id ' + raw : '')); } };
  }

  // ---- tooltip (floating layer) --------------------------------------------------------------------------------------
  const tip = (() => {
    const body = h('div', { class: 'tip-b cutbox' });
    const box = h('div', { class: 'tip', role: 'tooltip', id: 'hud-tip' }, body);
    let anchor = null, pending = null, timer = 0;
    function place(target) {
      const r = target.getBoundingClientRect(), bw = box.offsetWidth, bh = box.offsetHeight;
      let x = Math.max(8, Math.min(innerWidth - bw - 8, r.left + r.width / 2 - bw / 2));
      let y = r.top - bh - 10;
      if (y < 64) y = r.bottom + 10;
      if (y + bh > innerHeight - 8) y = Math.max(8, innerHeight - bh - 8);
      box.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
    function open(target, content) {
      if (!box.isConnected) doc.body.append(box);
      body.replaceChildren(typeof content === 'string' ? h('div', { class: 'tip-t', text: content }) : content);
      anchor = target; box.classList.add('on'); place(target);
    }
    function close(target) { if (target && target !== anchor && target !== pending) return; clearTimeout(timer); pending = null; anchor = null; box.classList.remove('on'); }
    function maybe(e) {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (!t || t === anchor || t === pending) return;
      if (t.dataset.tipIf === 'trunc' && t.scrollWidth <= t.clientWidth + 1) return;
      clearTimeout(timer); pending = t;
      timer = setTimeout(() => { pending = null; if (t.isConnected) open(t, t.dataset.tip); }, e.type === 'focusin' ? 0 : 350);
      const leave = () => { close(t); t.removeEventListener('pointerleave', leave); t.removeEventListener('focusout', leave); };
      t.addEventListener('pointerleave', leave); t.addEventListener('focusout', leave);
    }
    doc.addEventListener('pointerover', maybe);
    doc.addEventListener('focusin', maybe);
    addEventListener('scroll', () => close(), true);
    return { open, close, get anchor() { return anchor; } };
  })();

  // ---- live timers: [data-since] shows a running clock, [data-age] a coarse age ------------------------------------
  function tickTimers(scope = doc) {
    const t = now();
    for (const el of scope.querySelectorAll('[data-since]')) txt(el, fmtDur(t - Number(el.dataset.since)));
    for (const el of scope.querySelectorAll('[data-age]')) txt(el, (el.dataset.pre || '') + fmtAge(t - Number(el.dataset.age)) + (el.dataset.post || ''));
    for (const el of scope.querySelectorAll('[data-until]')) txt(el, (el.dataset.pre || '') + fmtAge(Number(el.dataset.until) - t));
    const minute = Math.floor(t / 60000);
    for (const chart of scope.querySelectorAll('[data-pulse]')) {
      const state = activityData.get(chart);
      if (state.minute !== minute) drawActivity(chart, minute, state.pulse);
    }
  }
  function since(el, ts) { if (ts) { setData(el, 'since', ts); txt(el, fmtDur(now() - ts)); } else { setData(el, 'since', null); txt(el, ''); } }
  function age(el, ts, pre = '', post = '') {
    setData(el, 'pre', pre); setData(el, 'post', post);
    if (ts) { setData(el, 'age', ts); txt(el, pre + fmtAge(now() - ts) + post); } else { setData(el, 'age', null); txt(el, ''); }
  }

  // ---- odometer: digits roll (layer 2), widths never change ----------------------------------------------------------
  function odo(cls) {
    const sr = h('span', { class: 'sr' });
    const el = h('span', { class: 'odo' + (cls ? ' ' + cls : '') }, sr);
    let cur = null;
    const isD = ch => ch >= '0' && ch <= '9';
    function slot(ch) {
      if (!isD(ch)) { const sl = h('span', { class: 'odo-s', 'aria-hidden': 'true', text: ch }); sl._ch = ch; return sl; }
      const strip = h('span', { class: 'odo-strip' });
      for (let d = 0; d < 10; d++) strip.append(h('span', { text: String(d) }));
      const sl = h('span', { class: 'odo-s odo-d', 'aria-hidden': 'true' }, strip);
      sl._strip = strip; digit(sl, ch);
      return sl;
    }
    function digit(sl, ch) { sl._ch = ch; sl._strip.style.transform = `translateY(${-Number(ch)}em)`; }
    let lastAt = 0, pending = null, timer = 0;
    function set(v, opts = {}) {
      const str = String(v);
      if (str === cur && opts.from == null) { pending = null; return; }
      const wait = cur == null || opts.from != null ? 0 : lastAt + 1500 - Date.now();
      if (wait > 0) { pending = str; if (!timer) timer = setTimeout(() => { timer = 0; const p = pending; pending = null; if (p != null) set(p); }, wait); return; }
      lastAt = Date.now();
      txt(sr, str);
      const slots = [...el.children].slice(1);
      const same = cur != null && cur.length === str.length && slots.every((sl, i) => !!sl._strip === isD(str[i]));
      if (!same || opts.from != null) {
        const from = opts.from != null ? String(opts.from) : null;
        const kids = [...str].map(ch => slot(from != null && isD(ch) ? '0' : ch));
        el.replaceChildren(sr, ...kids);
        if (from != null) { void el.offsetWidth; kids.forEach((k, i) => { if (k._strip) digit(k, str[i]); }); }
      } else {
        slots.forEach((sl, i) => { if (sl._ch !== str[i]) { if (sl._strip) digit(sl, str[i]); else { sl.textContent = str[i]; sl._ch = str[i]; } } });
      }
      cur = str;
    }
    return { el, set, get value() { return cur; } };
  }

  // ---- keyed lists: enter, leave, and FLIP reordering -----------------------------------------------------------------
  function enterEl(el) {
    el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter');
    setTimeout(() => el.classList.remove('enter'), 260);
    glitch(el);
  }
  function leaveEl(el) { el.classList.add('leave'); setTimeout(() => el.remove(), 200); }
  function reconcile(container, map, items, keyOf, make, update, animate = true) {
    const want = [], seen = new Set();
    for (const it of items) {
      const k = keyOf(it); seen.add(k);
      let c = map.get(k); const fresh = !c;
      if (fresh) { c = make(it); map.set(k, c); }
      update(c, it);
      want.push([c, fresh]);
    }
    for (const [k, c] of map) if (!seen.has(k)) { map.delete(k); if (animate) leaveEl(c.el); else c.el.remove(); }
    const cur = [...container.children].filter(e => !e.classList.contains('leave'));
    const changed = cur.length !== want.length || want.some(([c], i) => cur[i] !== c.el);
    if (!changed) return;
    const before = new Map();
    if (animate) for (const [c, fresh] of want) if (!fresh && c.el.isConnected) before.set(c.el, c.el.getBoundingClientRect().top);
    let prev = null;
    for (const [c] of want) {
      const el = c.el;
      if (prev ? prev.nextElementSibling !== el : container.firstElementChild !== el) { if (prev) prev.after(el); else container.prepend(el); }
      prev = el;
    }
    if (!animate) return;
    for (const [c, fresh] of want) {
      if (fresh) { enterEl(c.el); continue; }
      const top = before.get(c.el); if (top == null) continue;
      const dy = top - c.el.getBoundingClientRect().top;
      if (Math.abs(dy) > 1 && !motion.rm) c.el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 300, easing: EASE });
    }
  }

  // ---- meters ----------------------------------------------------------------------------------------------------------
  function contextMeter(label = 'Context') {
    const fill = h('span', { class: 'bar-f' });
    const bar = h('span', { class: 'bar bar-ctx' }, fill, h('span', { class: 'bar-m m70' }), h('span', { class: 'bar-m m90' }));
    const val = h('span', { class: 'mv mono' }), note = h('span', { class: 'mn mono' });
    const el = h('div', { class: 'meter m-ctx' }, h('span', { class: 'ml label', text: label }), bar, val, note);
    return {
      el,
      set(c) {
        const p = c ? c.pct : null;
        setData(el, 'lvl', ctxLevel(p));
        fill.style.transform = `scaleX(${p == null ? 0 : Math.min(1, p / 100)})`;
        txt(val, fmtPct(p));
        txt(note, c ? `${fmtTok(c.used)} of ${fmtTok(c.window)}` : 'window unknown');
      },
    };
  }
  function tokenMeter() {
    const fo = h('span', { class: 'bar-f seg-out' }), fw = h('span', { class: 'bar-f seg-cw' }), fi = h('span', { class: 'bar-f seg-in' });
    const val = h('span', { class: 'mv mono' }), note = h('span', { class: 'mn mono', 'data-tip-if': 'trunc' }), split = h('span', { class: 'msplit mono', 'data-tip-if': 'trunc' });
    const el = h('div', { class: 'meter m-tok' }, h('span', { class: 'ml label', text: 'Tokens' }), h('span', { class: 'bar bar-tok' }, fo, fw, fi), val, note, h('span'), split);
    return {
      el,
      set(t, tree, max) {
        t = t || {}; const tot = headline(t), k = max > 0 ? Math.min(1, tot / max) : 0;
        const o = tot ? (t.output || 0) / tot * k : 0, w = tot ? (t.cacheWrite || 0) / tot * k : 0, i = tot ? (t.input || 0) / tot * k : 0;
        fo.style.transform = `scaleX(${o})`;
        fw.style.transform = `translateX(${o * 100}%) scaleX(${w})`;
        fi.style.transform = `translateX(${(o + w) * 100}%) scaleX(${i})`;
        txt(val, fmtTok(tot));
        const tt = headline(tree);
        txt(note, tree && tt > tot ? `incl. subagents ${fmtTok(tt)}` : '');
        txt(split, `in ${fmtTok(t.input)} · out ${fmtTok(t.output)} · cache write ${fmtTok(t.cacheWrite)}`); split.dataset.tip = split.textContent; note.dataset.tip = note.textContent;
      },
    };
  }
  function cacheMeter() {
    const f = h('span', { class: 'bar-f' }), val = h('span', { class: 'mv mono' });
    const el = h('div', { class: 'meter m-cr' }, h('span', { class: 'ml label', text: 'Cache read' }), h('span', { class: 'bar bar-cr' }, f), val, h('span', { class: 'mn mono', text: 'context re-read, shown apart', 'data-tip': 'Cache reads re-count the same context on every turn, so they are kept out of the token total', 'data-tip-if': 'trunc' }));
    return { el, set(n, max) { f.style.transform = `scaleX(${max > 0 ? Math.min(1, n / max) : 0})`; txt(val, fmtTok(n)); } };
  }

  // ---- the current-activity line of a card -----------------------------------------------------------------------------
  function nowLine() {
    const ic = h('span', { style: 'display:flex' }), name = h('span', { class: 'now-n' });
    const sum = h('span', { class: 'now-s trunc', 'data-tip-if': 'trunc' }), tm = h('span', { class: 'now-t mono' });
    const el = h('div', { class: 'now' }, ic, name, sum, tm);
    let icName = null;
    const setIcon = n => { if (n !== icName) { icName = n; ic.replaceChildren(icon(n)); } };
    return {
      el,
      set(x) {
        const tool = x.currentTool, t = now();
        let k, n, ss = '';
        since(tm, null); age(tm, null);
        if (x.status === 'needs-you') {
          k = 'needs'; setIcon('alert'); n = x.needsYou?.reason || 'Needs you';
          ss = tool ? `${tool.name}${tool.summary ? ' · ' + tool.summary : ''}` : '';
          since(tm, x.needsYou?.since);
        } else if (x.status === 'busy' && tool) {
          k = 'tool'; setIcon(toolIcon(tool.name)); n = tool.name; ss = tool.summary || ''; since(tm, tool.since);
        } else if (x.status === 'busy') {
          k = 'think'; setIcon('clock'); n = 'Working'; ss = 'between tools';
        } else if (viewStatus(x) === 'agents') {
          k = 'agents'; setIcon('agent'); n = 'Agents working'; ss = plural(x.agentsRunning, 'subagent running', 'subagents running');
        } else if (x.status === 'idle') {
          const fresh = x.lastActivityAt && t - x.lastActivityAt < 90_000;
          k = fresh ? 'fresh' : 'idle'; setIcon(fresh ? 'check' : 'clock'); n = fresh ? 'Just finished' : 'Idle';
          age(tm, x.lastActivityAt, fresh ? '' : 'for ', fresh ? ' ago' : '');
        } else {
          k = 'ended'; setIcon('close'); n = 'Ended'; age(tm, x.endedAt || x.lastActivityAt, '', ' ago');
        }
        setData(el, 'k', k); txt(name, n); txt(sum, ss); setData(sum, 'tip', ss || null);
      },
    };
  }

  // ---- subagent rows ---------------------------------------------------------------------------------------------------
  function workText(work, plans) {
    return (work?.items || []).map(item => {
      const key = item.plan || work.plan;
      const plan = plans?.get(key);
      return `On ${item.id} · ${plan?.title || plan?.slug || key.slice(key.indexOf('|') + 1)}`;
    }).join(' · ');
  }
  function workLabel(cls = '') {
    const el = h('span', { class: 'work-label trunc ' + cls, hidden: true, 'data-tip-if': 'trunc' });
    return { el, set(work, plans) {
      const text = workText(work, plans);
      txt(el, text); show(el, !!text); setData(el, 'tip', text);
      return !!text;
    } };
  }
  function subRow() {
    const g = h('span', { class: 'sub-g' }), typ = h('b'), desc = h('span');
    const name = h('span', { class: 'sub-n trunc', 'data-tip-if': 'trunc' }, typ, desc);
    const work = workLabel();
    const model = h('span', { class: 'sub-m trunc' }), k = h('span', { class: 'sub-k' }), c = h('span', { class: 'sub-c' });
    const sw = h('span'), st = h('span', { class: 'mono', style: 'margin-left:8px;letter-spacing:0' });
    const el = h('div', { class: 'sub', tabindex: '-1' }, g, h('span', { class: 'sub-label' }, name, work.el), model, k, c, h('span', { class: 'sub-s label' }, sw, st));
    let prev = null;
    return {
      el,
      set(a, d, plans) {
        setData(el, 's', a.state); setData(el, 'd', d); el.style.setProperty('--d', d);
        setData(el, 'id', a.id); setData(el, 'work', work.set(a.work, plans) ? '1' : null);
        if (prev !== a.state) {
          g.replaceChildren(glyph(a.state === 'done' ? 'done' : 'running'));
          if (prev === 'running' && a.state === 'done') { el.classList.remove('just-done'); void el.offsetWidth; el.classList.add('just-done'); setTimeout(() => el.classList.remove('just-done'), 1600); }
          prev = a.state;
        }
        txt(typ, a.type || 'agent'); txt(desc, a.description || '');
        name.dataset.tip = `${a.type || 'agent'} · ${a.description || ''}`;
        txt(model, shortModel(a.model)); setData(model, 'tip', a.modelRaw ? `${a.modelRaw} · ${provName(a.provider)}` : null);
        txt(k, fmtTok(headline(a.tokens)));
        txt(c, a.context ? fmtPct(a.context.pct) : '—'); setData(c, 'lvl', ctxLevel(a.context?.pct));
        if (a.state === 'running') { txt(sw, 'Running'); since(st, a.startedAt); } else { txt(sw, 'Done'); since(st, null); }
      },
    };
  }
  // A session's subagents in tree order; deeper than 3 levels, and old finished ones beyond 4, fold into one line.
  function subTree(subs, rootId) {
    const ids = new Set(subs.map(a => a.id)), kids = new Map();
    for (const a of subs) { const p = ids.has(a.parentId) ? a.parentId : rootId; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(a); }
    const out = [];
    const walk = (p, d) => { for (const a of (kids.get(p) || []).sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0))) { out.push([a, d]); walk(a.id, d + 1); } };
    walk(rootId, 1);
    return { list: out, kids };
  }
  function subList() {
    const rowsEl = h('div'), more = h('div', { class: 'sub-more label', hidden: true });
    const el = h('div', { class: 'subs', hidden: true }, rowsEl, more);
    const rows = new Map();
    return {
      el,
      update(subs, rootId, plans) {
        show(el, subs.length > 0);
        const { list, kids } = subTree(subs, rootId);
        const keepUp = new Set();
        const runningBelow = id => (kids.get(id) || []).some(k => k.state === 'running' || runningBelow(k.id));
        for (const [a] of list) if (a.state === 'done' && runningBelow(a.id)) keepUp.add(a.id);
        let deeper = 0;
        let vis = list.filter(([, d]) => d <= 3 || (deeper++, false));
        const done = vis.filter(([a]) => a.state === 'done' && !keepUp.has(a.id)).sort((x, y) => (y[0].endedAt || 0) - (x[0].endedAt || 0));
        const hide = new Set(done.slice(4).map(([a]) => a.id));
        vis = vis.filter(([a]) => !hide.has(a.id));
        reconcile(rowsEl, rows, vis, ([a]) => a.id, () => subRow(), (r, [a, d]) => r.set(a, d, plans));
        const bits = [];
        if (hide.size) bits.push(`+${hide.size} earlier finished`);
        if (deeper) bits.push(`+${deeper} more, deeper`);
        txt(more, bits.join(' · ')); show(more, bits.length > 0);
      },
    };
  }

  // Pad and age the stream's sparse series on the page, even when the HUD has nothing to push.
  const activityData = new WeakMap();
  function drawActivity(chart, minute, pulse) {
    activityData.set(chart, { minute, pulse });
    const offset = minute - 29 - Math.floor((pulse?.start || 0) / 60000);
    const values = Array.from({ length: 30 }, (_, i) => pulse?.perMin[offset + i] || 0);
    const peak = Math.max(...values);
    const points = peak ? values.map((n, i) => `${i * 3 + 2},${(16 - 14 * n / peak).toFixed(1)}`).join(' ') : '';
    setAttr(chart.lastElementChild, 'points', points);
    const label = peak ? `Output over the last 30 minutes. Peak ${fmtInt(peak)} tokens per minute.` : 'No output tokens in the last 30 minutes';
    setAttr(chart, 'aria-label', label);
    setData(chart, 'tip', label);
  }
  function activityLine() {
    const chart = s('svg', { class: 'activity-chart', 'data-pulse': '', viewBox: '0 0 91 18', role: 'img' },
      s('path', { class: 'activity-base', d: 'M2 16H89' }), s('polyline', { class: 'activity-path' }));
    const turn = h('span', { hidden: true });
    const el = h('div', { class: 'activity' }, chart, turn);
    return { el, set(pulse, timing) {
      drawActivity(chart, Math.floor(now() / 60000), pulse);
      const lastMs = timing?.lastMs;
      show(turn, lastMs != null);
      txt(turn, lastMs == null ? '' : 'Last turn ' + fmtDur(lastMs));
    } };
  }

  // ---- session card (comfortable) and compact row (dense) -------------------------------------------------------------
  function projectLabel(api, cls, fallback = '—') {
    const el = api.project ? h('button', { class: cls + ' project-button', type: 'button' }) : h('span', { class: cls });
    if (api.project) el.addEventListener('click', e => { e.stopPropagation(); api.project(el.dataset.project); });
    return { el, set(name) {
      txt(el, name || fallback);
      setData(el, 'project', name);
      setData(el, 'tip', name);
      if (api.project) {
        el.disabled = !name;
        setAttr(el, 'aria-pressed', String(!!name && api.focused?.() === name));
      }
    } };
  }
  function windowLink(compact = false) {
    const label = 'Open in VS Code';
    const el = h('a', { class: 'window-link chip', hidden: true, 'aria-label': label, 'data-tip': label },
      icon('window'), compact ? null : label);
    el.addEventListener('click', e => e.stopPropagation());
    return { el, set(session) {
      let href = null;
      if (['localhost', '127.0.0.1'].includes(location.hostname) && /vscode/i.test(session.entrypoint || '') && session.cwd) {
        const path = session.cwd.replace(/\\/g, '/');
        const parts = path.split('/');
        const encoded = parts.map((part, i) => i === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part)).join('/');
        href = 'vscode://file' + (path.startsWith('/') ? '' : '/') + encoded;
      }
      setAttr(el, 'href', href);
      show(el, !!href);
    } };
  }
  function sessionCard(api = {}) {
    const proj = projectLabel(api, 'label trunc', 'Unknown project'), tag = statusTag(), openWindow = windowLink();
    const title = h('h3', { class: 'card-title trunc', 'data-tip-if': 'trunc' });
    const mChip = h('span', { class: 'chip' });
    const bName = h('span', { class: 'trunc' }), bChip = h('span', { class: 'card-br mono', 'data-tip-if': 'trunc' }, icon('branch'), bName);
    const prov = provBadge();
    const sbyName = h('span', { class: 'trunc' });
    const sby = h('button', { class: 'chip', type: 'button', hidden: true }, icon('agent'), h('span', { text: 'Started by' }), sbyName);
    const ageEl = h('span'), toolsEl = h('span');
    const nowRow = nowLine(), tok = tokenMeter(), cr = cacheMeter(), ctx = contextMeter(), subs = subList();
    const sumEl = h('div', { class: 'card-sum' }), work = workLabel('card-work'), activity = activityLine();
    const el = h('article', { class: 'card cutbox', tabindex: '-1' },
      h('div', { class: 'card-scan', 'aria-hidden': 'true' }), h('div', { class: 'card-glow', 'aria-hidden': 'true' }),
      h('header', { class: 'card-h' }, h('div', { class: 'card-proj' }, proj.el, bChip), h('span', { class: 'card-meta mono' }, ageEl, ' · ', toolsEl), tag.el),
      h('div', { class: 'card-tr' }, title, h('div', { class: 'card-chips' }, mChip, prov.el, sby, openWindow.el)),
      sumEl, work.el, nowRow.el, h('div', { class: 'meters' }, tok.el, cr.el, ctx.el), activity.el, subs.el);
    let st = null, sbyId = null;
    sby.addEventListener('click', e => { e.stopPropagation(); if (sbyId) api.jump?.(sbyId); });
    return {
      el,
      update(x, c = {}) {
        const vs = viewStatus(x);
        if (st && st !== vs) glitch(el);
        st = vs; setData(el, 's', st); setData(el, 'id', x.id);
        proj.set(x.project); setData(el, 'project', x.project);
        openWindow.set(x);
        tag.set(vs);
        const t = x.title || x.name || 'Untitled session';
        txt(title, t); title.dataset.tip = t;
        txt(mChip, [x.agent === 'codex' ? 'Codex' : 'Claude Code', shortModel(x.model) || 'model unknown', x.effort].filter(Boolean).join(' · '));
        setData(mChip, 'tip', x.modelRaw ? 'Model id: ' + x.modelRaw : null);
        show(bChip, !!x.branch); txt(bName, x.branch || ''); setData(bChip, 'tip', x.branch ? 'Branch ' + x.branch : null);
        prov.set(x.provider, x.modelRaw);
        sbyId = x.startedBy || null; show(sby, !!sbyId);
        if (sbyId) {
          const p = c.byId && c.byId.get(sbyId);
          const who = p ? (p.title || p.name || p.project) : 'session ' + sbyId.slice(0, 8);
          txt(sbyName, who); setData(sby, 'tip', `Launched from the shell of “${who}”. Click to go to it.`);
        }
        age(ageEl, x.startedAt); txt(toolsEl, plural(x.tools || 0, 'tool', 'tools'));
        nowRow.set(x);
        tok.set(x.tokens, x.tokensTree, c.maxTok);
        cr.set(x.tokens?.cacheRead || 0, c.maxCache);
        ctx.set(x.context);
        activity.set(x.pulse, x.turn);
        work.set(x.work, c.plans);
        subs.update(x.subagents || [], x.id, c.plans);
        if (st === 'ended') txt(sumEl, [shortModel(x.model), provName(x.provider), `${fmtTok(headline(x.tokens))} tokens`, plural(x.tools || 0, 'tool', 'tools'), (x.subagents || []).length ? plural(x.subagents.length, 'subagent', 'subagents') : null].filter(Boolean).join(' · '));
      },
    };
  }
  function compactRow(api = {}) {
    const tag = statusTag();
    const p = projectLabel(api, 'cr-p label trunc'), t = h('span', { class: 'cr-t trunc', 'data-tip-if': 'trunc' });
    const openWindow = windowLink(true);
    const m = h('span', { class: 'cr-m trunc' }), v = h('span', { class: 'cr-v' });
    const wIc = h('span', { style: 'display:flex' }), wT = h('span', { class: 'trunc', 'data-tip-if': 'trunc' }), wTm = h('span', { class: 'mono' });
    const k = h('span', { class: 'cr-k' }), c = h('span', { class: 'cr-c' }), n = h('span', { class: 'cr-n' });
    const work = workLabel();
    const el = h('div', { class: 'crow', tabindex: '-1' }, tag.el, p.el,
      h('span', { class: 'cr-title' }, h('span', { class: 'cr-title-line' }, openWindow.el, t), work.el),
      m, v, h('span', { class: 'cr-w' }, wIc, wT, wTm), k, c, n);
    let icName = null, st = null;
    el.addEventListener('click', () => api.open?.(el.dataset.id));
    return {
      el,
      update(x, cxt = {}) {
        const vs = viewStatus(x);
        if (st && st !== vs) glitch(el);
        st = vs; setData(el, 's', vs); setData(el, 'id', x.id);
        tag.set(vs);
        p.set(x.project); setData(el, 'project', x.project);
        openWindow.set(x);
        const title = x.title || x.name || 'Untitled session'; txt(t, title); t.dataset.tip = title;
        setData(el, 'work', work.set(x.work, cxt.plans) ? '1' : null);
        txt(m, (x.agent === 'codex' ? 'Codex · ' : '') + shortModel(x.model)); setData(m, 'tip', x.modelRaw);
        txt(v, provLetter(x.provider)); setData(v, 'p', x.provider); setData(v, 'tip', 'Runs on ' + provName(x.provider));
        let ic = 'clock', w = '';
        since(wTm, null); age(wTm, null);
        let tipW = '';
        if (x.status === 'needs-you') { ic = 'alert'; tipW = x.needsYou?.reason || 'Needs you'; w = shortReason(tipW); since(wTm, x.needsYou?.since); }
        else if (x.currentTool) { ic = toolIcon(x.currentTool.name); w = `${x.currentTool.name} · ${x.currentTool.summary || ''}`; }
        else if (vs === 'agents') { ic = 'agent'; w = plural(x.agentsRunning, 'subagent running', 'subagents running'); }
        else if (x.status === 'idle') age(wTm, x.lastActivityAt, 'for ');   // the status tag already says idle / ended
        else if (x.status === 'ended') { ic = 'close'; age(wTm, x.endedAt, '', ' ago'); }
        if (ic !== icName) { icName = ic; wIc.replaceChildren(icon(ic)); }
        txt(wT, w); wT.dataset.tip = tipW || w;
        txt(k, fmtTok(headline(x.tokens))); setData(k, 'tip', `${fmtInt(headline(x.tokens))} tokens · cache read ${fmtTok(x.tokens?.cacheRead)}`);
        txt(c, x.context ? fmtPct(x.context.pct) : '—'); setData(c, 'lvl', ctxLevel(x.context?.pct));
        const running = (x.subagents || []).filter(a => a.state === 'running').length;
        txt(n, running ? '+' + running : ''); setData(n, 'tip', running ? plural(running, 'subagent running', 'subagents running') : null);
      },
    };
  }


  // ---- geometry ----------------------------------------------------------------------------------------------------------
  // Angles are degrees clockwise from the top.
  function arcD(cx, cy, r, a0, a1) {
    const P = a => { const t = (a - 90) * Math.PI / 180; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; };
    const [x0, y0] = P(a0), [x1, y1] = P(a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  function ellArc(cx, cy, rx, ry, a0, a1, ccw) {
    const P = a => { const t = (a - 90) * Math.PI / 180; return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)]; };
    const [x0, y0] = P(a0), [x1, y1] = P(a1);
    return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${rx.toFixed(1)} ${ry.toFixed(1)} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${ccw ? 0 : 1} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  function placeFlow(f, p, q) {
    const dx = q.x - p.x, dy = q.y - p.y;
    f.style.width = Math.hypot(dx, dy).toFixed(1) + 'px';
    f.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) rotate(${Math.atan2(dy, dx).toFixed(4)}rad)`;
  }
  const hexPts = R => [-90, -30, 30, 90, 150, 210].map(a => { const t = a * Math.PI / 180; return (R * Math.cos(t)).toFixed(2) + ',' + (R * Math.sin(t)).toFixed(2); }).join(' ');

  // ---- arc reactor ---------------------------------------------------------------------------------------------------------
  function reactor(opts = {}) {
    const S = opts.size || 232, C = S / 2, mini = !!opts.mini;
    const rSeg = mini ? C - 3 : C - 10, rTrack = mini ? C - 3 : C - 2, rTick = C - 26, rArc = C - 18, rSlot = C - 40, rIn = C - 47;
    const vb = `0 0 ${S} ${S}`;
    const svg = (...k) => s('svg', { class: 'r-svg', viewBox: vb, 'aria-hidden': 'true' }, ...k);
    const base = svg(s('circle', { class: 'r-track', cx: C, cy: C, r: rTrack, 'stroke-width': 1 }));
    if (!mini) base.append(s('circle', { class: 'r-track', cx: C, cy: C, r: rIn, 'stroke-width': 1 }));
    const segs = s('g');
    const mid = svg();
    if (!mini) {
      for (let a = 0; a < 360; a += 5) {
        const long = a % 30 === 0, t = (a - 90) * Math.PI / 180, r0 = rTick - (long ? 5 : 2), r1 = rTick + (long ? 5 : 2);
        mid.append(s('line', { class: 'r-tick', x1: C + r0 * Math.cos(t), y1: C + r0 * Math.sin(t), x2: C + r1 * Math.cos(t), y2: C + r1 * Math.sin(t), 'stroke-width': long ? 1.5 : 1 }));
      }
      for (const a of [20, 140, 260]) mid.append(s('path', { class: 'r-arc', d: arcD(C, C, rArc, a, a + 50), 'stroke-width': 1.5 }));
    }
    const slots = [];
    const inner = svg();
    if (!mini) for (let i = 0; i < 12; i++) { const p = s('path', { class: 'r-slot', d: arcD(C, C, rSlot, i * 30 + 4, i * 30 + 26), 'stroke-width': 4 }); inner.append(p); slots.push(p); }
    const num = odo('r-odo');
    const el = h('div', { class: 'reactor' + (mini ? ' mini' : ''), style: `width:${S}px;height:${S}px`, role: 'img', 'data-mode': 'idle' },
      h('div', { class: 'r-glow' }), h('div', { class: 'r-l' }, base), h('div', { class: 'r-l r-outer' }, svg(segs)), h('div', { class: 'r-l r-mid' }, mid),
      h('div', { class: 'r-l r-inner' }, inner), mini ? null : h('div', { class: 'r-core' }),
      h('div', { class: 'r-num' }, num.el, h('div', { class: 'r-lbl label', text: 'Agents working' })));
    let sig = null;
    return {
      el,
      update(sessions, totals, o = {}) {
        const live = sessions.filter(x => x.status !== 'ended');
        const running = totals.agentsRunning || 0;
        const mode = totals.needsYou > 0 ? 'alert' : running > 0 ? 'live' : live.length ? 'calm' : 'idle';
        setData(el, 'mode', mode);
        const rank = { 'needs-you': 0, busy: 1, idle: 2 };
        const list = live.map(x => viewStatus(x) === 'agents' ? 'busy' : x.status).sort((a, b) => rank[a] - rank[b]);   // a waiting parent counts with busy (D6)
        if (list.join() !== sig) {
          sig = list.join();
          const n = list.length, gap = n > 1 ? Math.min(6, 90 / n) : 0, seg = n ? (360 - n * gap) / n : 0;
          segs.replaceChildren(...list.map((st, i) => {
            const a0 = n === 1 ? 0 : i * (seg + gap) + gap / 2, a1 = n === 1 ? 359.9 : a0 + seg;
            return s('path', { class: 'r-seg', 'data-s': st, d: arcD(C, C, rSeg, a0, a1), 'stroke-width': mini ? 3 : 6 });
          }));
        }
        slots.forEach((p, i) => p.classList.toggle('on', i < (totals.subagentsRunning || 0)));
        num.set(String(running), o.boot ? { from: 0 } : undefined);
        el.style.setProperty('--beat', (mode === 'idle' ? 8 : Math.max(4, 7 - 0.4 * running)).toFixed(2) + 's');
        el.setAttribute('aria-label', `${plural(running, 'agent', 'agents')} running, ${totals.needsYou || 0} waiting for you`);
      },
    };
  }

  // ---- vitals and account usage ----------------------------------------------------------------------------------------
  function vitals() {
    const mk = (label, wide) => {
      const n = odo(), sub = h('div', { class: 'vital-s', 'data-tip-if': 'trunc' }), num = h('div', { class: 'vital-n' }, n.el);
      return { el: h('div', { class: 'vital' + (wide ? ' wide' : '') }, h('div', { class: 'vital-l label', text: label }), num, sub), n, sub, num };
    };
    const S = mk('Sessions'), A = mk('Subagents'), T = mk('Tokens today', true), N = mk('Need you'), P = mk('Plans');
    const sub2 = h('div', { class: 'vital-s', 'data-tip-if': 'trunc' }); T.el.append(sub2);
    const acctRows = h('div', { class: 'acct' });
    const acct = h('div', { class: 'vital wide acct-v', hidden: true }, h('div', { class: 'vital-l label', text: 'Claude account limits' }), acctRows);
    const meter = label => {
      const f = h('span', { class: 'bar-f' }), v = h('span', { class: 'mv mono' }), note = h('span', { class: 'mn mono' });
      const row = [h('span', { class: 'ml label', text: label }), h('span', { class: 'bar bar-acct' }, f), v, note];
      return { row, set(w) { const p = w && w.pct; f.style.transform = `scaleX(${p == null ? 0 : Math.min(1, p / 100)})`; txt(v, fmtPct(p)); f.style.backgroundColor = p >= 70 ? 'var(--amber)' : ''; setData(note, 'pre', 'resets in '); setData(note, 'until', w && w.resetsAt); txt(note, w && w.resetsAt ? 'resets in ' + fmtAge(w.resetsAt - now()) : ''); } };
    };
    const five = meter('5-hour'), week = meter('Weekly');
    acctRows.append(...five.row, ...week.row);
    const el = h('div', { class: 'vitals' }, N.el, S.el, A.el, P.el, T.el, acct);
    return {
      el,
      update(st, o = {}) {
        const t = st.totals || {}, from = o.boot ? { from: 0 } : undefined;
        const live = (st.sessions || []).filter(x => x.status !== 'ended');
        const idle = live.filter(x => viewStatus(x) === 'idle').length, waiting = live.filter(x => viewStatus(x) === 'agents').length;
        S.n.set(String(t.sessions || 0), from);
        txt(S.sub, `${(t.busy || 0) + waiting} busy · ${idle} idle`);   // a parent waiting on its subagents counts with busy (D6)
        const doneSubs = shownSessions(st.sessions || []).reduce((n, x) => n + (x.subagents || []).filter(a => a.state === 'done').length, 0);   // the same sessions the network draws
        A.n.set(String(t.subagentsRunning || 0), from);
        txt(A.sub, `running · ${doneSubs} finished`);
        const tt = t.tokensToday || {};
        T.n.set(fmtTok(headline(tt)), from);
        txt(T.sub, `in ${fmtTok(tt.input)} · out ${fmtTok(tt.output)} · write ${fmtTok(tt.cacheWrite)}`);
        txt(sub2, `cache read ${fmtTok(tt.cacheRead)}, counted apart`);
        N.n.set(String(t.needsYou || 0), from);
        N.num.classList.toggle('alert', (t.needsYou || 0) > 0);
        txt(N.sub, t.plansNeedingYou ? `sessions + ${plural(t.plansNeedingYou, 'plan', 'plans')}` : 'sessions');
        P.n.set(String(t.plansInProgress || 0), from);
        txt(P.sub, `in progress of ${(st.plans || []).length}`);
        for (const e of [S.sub, A.sub, T.sub, N.sub, P.sub, sub2]) e.dataset.tip = e.textContent;
        const a = st.account;
        show(acct, !!(a && (a.fiveHour || a.sevenDay)));
        if (a) { five.set(a.fiveHour); week.set(a.sevenDay); }
      },
    };
  }

  // ---- usage from outside Claude Code (D12) --------------------------------------------------------------------------
  function externals() {
    const list = h('div'), err = h('div', { class: 'ext-err', hidden: true });
    const el = h('div', {}, list, err);
    const rows = new Map();
    const row = () => {
      const prov = provBadge(), name = h('span', { class: 'ext-n trunc', 'data-tip-if': 'trunc' }), k = h('span', { class: 'ext-k' });
      const src = h('span', { class: 'label' }), model = h('span'), win = h('span'), delayed = h('span', { class: 'chip warn', text: 'Delayed', hidden: true });
      const e = h('div', { class: 'ext-row' }, prov.el, name, k, h('div', { class: 'ext-d' }, src, model, win, delayed));
      return {
        el: e,
        set(x) {
          prov.set(x.provider, x.modelRaw);
          const n = x.app || shortModel(x.model) || x.model || 'unknown'; txt(name, n); name.dataset.tip = n;
          txt(k, fmtTok(headline(x.tokens))); setData(k, 'tip', `in ${fmtInt(x.tokens?.input)} · out ${fmtInt(x.tokens?.output)} · cache read ${fmtInt(x.tokens?.cacheRead)}`);
          txt(src, x.source === 'cloudwatch' ? 'CloudWatch' : 'Ingest'); txt(model, x.app ? shortModel(x.model) : '');
          txt(win, x.windowEnd ? 'to ' + fmtClock(x.windowEnd).slice(0, 5) : ''); show(delayed, !!x.delayed);
          setData(delayed, 'tip', x.delayed ? 'CloudWatch publishes a few minutes late, and per model, not per app' : null);
        },
      };
    };
    return {
      el,
      update(ext, error) {
        reconcile(list, rows, ext || [], x => x.source + '|' + (x.app || '') + '|' + x.model, row, (r, x) => r.set(x), false);
        txt(err, error || ''); show(err, !!error);
      },
    };
  }

  // ---- network: who started whom --------------------------------------------------------------------------------------------
  const SWEEP_MS = 8000;
  let netSeq = 0;
  function network(api = {}) {
    const uid = 'net' + (++netSeq);
    const sweepIn = h('i'), sweep = h('div', { class: 'net-sweep', 'aria-hidden': 'true' }, sweepIn);
    const gR = s('g', { class: 'net-rings', 'aria-hidden': 'true' }), gG = s('g');
    const gE = s('g', { 'aria-hidden': 'true' }), gP = s('g', { 'aria-hidden': 'true' });
    const svg = s('svg', { class: 'net-svg', 'aria-hidden': api.project ? null : 'true' }, gR, gG, gE, gP);
    const hubProject = projectLabel(api, '', ''), hubHost = h('span');
    const hubLabel = h('span', { class: 'hub-label label trunc' }, hubHost, hubProject.el);
    const hub = h('div', { class: 'net-hub' }, h('span', { class: 'hub-ring' }), h('span', { class: 'hub-core' }), hubLabel);
    const layer = h('div', { class: 'net-nodes', role: 'group', 'aria-label': 'Agent network: who started whom. Arrow keys move between agents, Enter pins one, Escape unpins.' });
    const empty = h('div', { class: 'net-empty', hidden: true }, h('span', { class: 'label', text: 'No active sessions' }), h('span', { text: ' · systems nominal' }));
    const legend = h('div', { class: 'net-legend label', 'aria-hidden': 'true', hidden: true },
      h('span', {}, h('i', { class: 'dash' }), 'Running'), h('span', {}, h('i', { class: 'dbl' }), 'Launched by'),
      h('span', { text: 'Size = tokens' }), h('span', { text: 'Ring = context' }), h('span', { text: 'A / B / O = Anthropic / Bedrock / OpenAI' }));
    const readout = h('div', { class: 'net-readout', hidden: true }), readBox = h('div', { class: 'tip-b cutbox' });
    readout.append(readBox);
    const pinBox = h('div', { class: 'net-pin', hidden: true });
    const flowLayer = h('div', { class: 'net-flows', 'aria-hidden': 'true' });
    const el = h('div', { class: 'net' }, sweep, svg, flowLayer, hub, layer, empty, legend, readout, pinBox);
    const nodes = new Map(), edges = new Map(), expanded = new Set();
    let W = 0, H = 0, data = null, cx = {}, hubXY = { x: 0, y: 0 }, drawn = false, tween = 0, sweepAnim = null;
    let pinnedId = null, pinFor = null, pinCard = null, autoPin = null, hoverId = null, rovingId = null, groupSig = '', ringSig = '';

    new ResizeObserver(() => {
      const w = el.clientWidth, hh = el.clientHeight;
      if (Math.abs(w - W) < 1 && Math.abs(hh - H) < 1) return;
      W = w; H = hh; if (data) render();
    }).observe(el);
    motion.on(() => retime(true));

    // Items: sessions (depth 0) and their subagents. A parent keeps its 3 newest finished subagents in view and folds
    // older ones into a numbered satellite, so its tree stays close to it; above 40 nodes every finished one folds.
    function graph(sessions) {
      const shown = shownSessions(sessions);
      if (!shown.some(x => x.status !== 'ended')) return [];
      let items = [];
      for (const x of shown) {
        items.push({ id: x.id, kind: 'session', parent: null, depth: 0, x, state: viewStatus(x), tokens: headline(x.tokens), project: x.project || 'Unknown', startedAt: x.startedAt || 0 });
        const ids = new Set((x.subagents || []).map(a => a.id));
        for (const a of x.subagents || []) items.push({ id: a.id, kind: 'sub', parent: ids.has(a.parentId) ? a.parentId : x.id, session: x.id, depth: 1, x: a, state: a.state === 'done' ? 'done' : 'running', tokens: headline(a.tokens), startedAt: a.startedAt || 0 });
      }
      const byId = new Map(items.map(i => [i.id, i]));
      for (const i of items) { let d = 0, p = i, g = 0; while (p && p.kind === 'sub' && g++ < 10) { d++; p = byId.get(p.parent); } i.depth = d; }
      const kids = new Map();
      for (const i of items) if (i.parent) { if (!kids.has(i.parent)) kids.set(i.parent, []); kids.get(i.parent).push(i); }
      const allDone = id => (kids.get(id) || []).every(k => k.state === 'done' && allDone(k.id));
      const keep = items.length > 40 ? 0 : 3, drop = new Set(), sats = [];
      for (const p of items) {
        if (expanded.has(p.id)) continue;
        const done = (kids.get(p.id) || []).filter(k => k.kind === 'sub' && k.state === 'done' && allDone(k.id)).sort((a, b) => (b.x.endedAt || 0) - (a.x.endedAt || 0));
        const fold = done.slice(keep);
        if (fold.length < 2) continue;
        let count = 0;
        const mark = k => { drop.add(k.id); count++; for (const kk of kids.get(k.id) || []) mark(kk); };
        fold.forEach(mark);
        sats.push({ id: 'sat:' + p.id, kind: 'sat', parent: p.id, session: p.session || p.id, depth: p.depth + 1, state: 'sat', count, tokens: 0, startedAt: Infinity, x: null });
      }
      if (drop.size) items = items.filter(i => !drop.has(i.id)).concat(sats.filter(t => !drop.has(t.parent)));   // a satellite folded into its parent's goes too
      return items;
    }

    // Radial tree: sessions on the inner ring grouped by project, one ring per depth, fitted into the panel.
    function layout(items) {
      const kids = new Map();
      for (const i of items) { const p = i.parent || 'hub'; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(i); }
      for (const l of kids.values()) l.sort((a, b) => a.startedAt - b.startedAt);
      // A subtree's share of the circle: its leaves, a finished (small, dim) leaf counting half.
      const wt = new Map();
      const weigh = i => { let n = 0; for (const k of kids.get(i.id) || []) n += weigh(k); const v = Math.max(i.kind === 'session' || i.state === 'running' ? 1 : 0.5, n); wt.set(i.id, v); return v; };
      // Order never depends on state, so a node doesn't swap places when its session starts or stops working.
      const sessions = (kids.get('hub') || []).slice().sort((a, b) => a.project.localeCompare(b.project) || a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
      sessions.forEach(weigh);
      const groups = new Map();
      for (const x of sessions) { if (!groups.has(x.project)) groups.set(x.project, []); groups.get(x.project).push(x); }
      const G = [...groups].map(([name, list]) => ({ name, list, w: list.reduce((n, x) => n + wt.get(x.id), 0) }));
      const total = G.reduce((n, g) => n + g.w, 0) || 1;
      const gap = G.length > 1 ? Math.min(14, 60 / G.length) : 0, avail = 360 - gap * G.length;
      const maxDepth = items.reduce((m, i) => Math.max(m, i.depth), 0);
      const S0 = Math.max(80, Math.min(W - 160, H - 128) / 2);
      const R0 = maxDepth === 0 ? 1 : Math.min(0.6, Math.max(0.46, sessions.length * 40 / (2 * Math.PI * S0)));
      const ring = d => maxDepth === 0 ? 1 : R0 + d * ((1 - R0) / maxDepth);
      // Children fan out only as far as they need (about 64 px of their ring per leaf), so a tree stays next to its parent.
      const place = (i, a0, a1) => {
        i.theta = (a0 + a1) / 2; i.ring = ring(i.depth);
        const ks = kids.get(i.id) || []; if (!ks.length) return;
        const perLeaf = 64 / (S0 * ring(i.depth + 1)) * 180 / Math.PI, tot = ks.reduce((n, k) => n + wt.get(k.id), 0);
        const spread = Math.min(a1 - a0, Math.max(1, tot) * perLeaf, i.depth === 0 ? 140 : 100);
        let c = i.theta - spread / 2;
        for (const k of ks) { const sp = spread * wt.get(k.id) / tot; place(k, c, c + sp); c += sp; }
      };
      let a = sessions.length === 1 ? 90 - avail / 2 : -gap / 2;
      for (const g of G) {
        const span = avail * g.w / total; g.a0 = a; g.a1 = a + span;
        let b = a; for (const x of g.list) { const sp = span * wt.get(x.id) / g.w; place(x, b, b + sp); b += sp; }
        a += span + gap;
      }
      // A crowded session ring: every other session (and its subtree) steps outwards, so neighbours don't overlap.
      const per = 2 * Math.PI * S0 * ring(0) * (avail / 360) / Math.max(1, sessions.length);
      if (sessions.length > 6 && per < 48) {
        const bump = (i, b) => { i.ring += b; for (const k of kids.get(i.id) || []) bump(k, b); };
        sessions.slice().sort((p, q) => p.theta - q.theta).forEach((x, k) => { if (k % 2) bump(x, maxDepth ? 0.11 : 0.16); });
      }
      for (const i of items) { const t = i.theta * Math.PI / 180; i.ux = Math.sin(t) * i.ring; i.uy = -Math.cos(t) * i.ring; }
      let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
      for (const i of items) { x0 = Math.min(x0, i.ux); x1 = Math.max(x1, i.ux); y0 = Math.min(y0, i.uy); y1 = Math.max(y1, i.uy); }
      const padX = W < 520 ? 56 : 96, padY = H < 300 ? 48 : 76, bottom = W >= 560 ? 24 : 0;
      let sx = (W - 2 * padX) / Math.max(x1 - x0, 0.5), sy = (H - 2 * padY - bottom) / Math.max(y1 - y0, 0.5);
      const sMin = Math.min(sx, sy), sMax = maxDepth === 0 ? Math.max(120, Math.min(220, Math.min(W, H) * 0.4)) : Math.min(W, H) * 0.8;
      sx = Math.min(sx, sMin * 1.7, sMax * 1.7); sy = Math.min(sy, sMin * 1.7, sMax);
      const ox = W / 2 - (x0 + x1) / 2 * sx, oy = (H - bottom) / 2 - (y0 + y1) / 2 * sy;
      for (const i of items) { i.px = ox + i.ux * sx; i.py = oy + i.uy * sy; }
      hubXY = { x: ox, y: oy };
      let dmin = Infinity;
      for (let p = 0; p < items.length; p++) {
        const A = items[p]; dmin = Math.min(dmin, Math.hypot(A.px - ox, A.py - oy));
        for (let q = p + 1; q < items.length; q++) dmin = Math.min(dmin, Math.hypot(A.px - items[q].px, A.py - items[q].py));
      }
      // Size = tokens: a square-root scale over a 3× range, so every token counts and the busiest agent is the biggest.
      const rMax = Math.max(14, Math.min(34, dmin * 0.4)), rMin = Math.max(7, rMax / 3);
      const tMax = Math.max(1, ...items.map(i => i.tokens));
      for (const i of items) {
        i.r = i.kind === 'sat' ? rMin + 3 : rMin + (rMax - rMin) * Math.sqrt(Math.min(1, i.tokens / tMax));
        if (i.state === 'needs-you') i.r = Math.max(i.r, rMin + 0.6 * (rMax - rMin));   // what needs you is never the smallest thing
      }
      return { G, sx, sy, ring, maxDepth, rMax, crowded: items.length > 12 || dmin < 70 };
    }

    // Labels: the title (or subagent type) and "model · context · tokens", on the side away from the hub when there is
    // room; shorter when crowded, but the numbers next to the ring are always there.
    const CHAR = { body: 6.1, mono: 6.7, label: 6.9 };
    function labelText(i, mode) {
      const x = i.x;
      if (i.kind === 'sat') return ['', 'finished'];
      const pct = x.context ? fmtPct(x.context.pct) : 'ctx —', tok = fmtTok(headline(x.tokens));
      if (mode === 'min') return ['', pct];
      const name = i.kind === 'session' ? (x.title || x.name || 'Untitled') : (x.type || 'agent');
      if (mode === 'short') return [name.length > 18 ? name.slice(0, 17).trimEnd() + '…' : name, `${pct} · ${tok}`];
      const meta = `${x.agent === 'codex' ? 'Codex · ' : ''}${shortModel(x.model) || 'model ?'} · ${pct} · ${tok}`;
      if (mode === 'meta') return ['', meta];
      return [name, meta];
    }
    function labelBox(i, side, l1, l2) {
      const w = Math.max(l1 ? Math.min(180, l1.length * (i.kind === 'session' ? CHAR.body : CHAR.label)) : 0, Math.min(180, l2.length * CHAR.mono)) + 6;
      const hgt = (l1 ? 16 : 0) + 16, R = i.r + 14;
      if (side === 'b') return { x0: i.px - w / 2, x1: i.px + w / 2, y0: i.py + R, y1: i.py + R + hgt };
      if (side === 't') return { x0: i.px - w / 2, x1: i.px + w / 2, y0: i.py - R - hgt, y1: i.py - R };
      if (side === 'r') return { x0: i.px + R, x1: i.px + R + w, y0: i.py - hgt / 2, y1: i.py + hgt / 2 };
      return { x0: i.px - R - w, x1: i.px - R, y0: i.py - hgt / 2, y1: i.py + hgt / 2 };
    }
    const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
    function placeLabels(items, L) {
      const placed = [];
      const hw = hubLabel.textContent.length * CHAR.label / 2 + 6;
      placed.push({ x0: hubXY.x - hw, x1: hubXY.x + hw, y0: hubXY.y + 26, y1: hubXY.y + 44 }, { x0: hubXY.x - 24, x1: hubXY.x + 24, y0: hubXY.y - 24, y1: hubXY.y + 24 });
      const discs = items.map(i => ({ id: i.id, x0: i.px - i.r - 9, x1: i.px + i.r + 9, y0: i.py - i.r - 9, y1: i.py + i.r + 9 }));
      const prio = i => i.state === 'needs-you' ? 0 : i.kind === 'session' ? (i.state === 'busy' || i.state === 'agents' ? 1 : i.state === 'idle' ? 2 : 6) : i.kind === 'sub' ? (i.state === 'running' ? 3 : 4) : 5;
      const inPanel = b => b.x0 >= 2 && b.x1 <= W - 2 && b.y0 >= 2 && b.y1 <= H - (W >= 560 ? 26 : 2);
      for (const i of items.slice().sort((a, b) => prio(a) - prio(b) || b.r - a.r)) {
        const r = nodes.get(i.id), outward = i.py < hubXY.y - 4 ? 't' : 'b', other = outward === 't' ? 'b' : 't';
        const horiz = i.px < hubXY.x ? ['l', 'r'] : ['r', 'l'];
        // a name says what is running, so it comes before the model line; crowded nodes get a short name or just the number
        const modes = i.kind === 'sat' ? ['meta'] : !L.crowded || i.state === 'needs-you' ? ['full', 'short', 'meta', 'min'] : i.kind === 'session' || i.state === 'running' ? ['short', 'min'] : ['min'];
        const sides = [outward, ...horiz, other];
        const prev = r && r.lbl ? [[r.lbl.mode, r.lbl.side]] : [];
        let pick = null;
        const tryIt = (mode, side) => {
          if (!modes.includes(mode)) return false;
          const [l1, l2] = labelText(i, mode), b = labelBox(i, side, l1, l2);
          if (!inPanel(b) || placed.some(p => overlaps(p, b)) || discs.some(d => d.id !== i.id && overlaps(d, b))) return false;
          pick = { mode, side, l1, l2, b }; return true;
        };
        for (const [m, sd] of prev) if (tryIt(m, sd)) break;   // stable: keep last frame's placement while it still fits
        if (!pick) outer: for (const m of modes) for (const sd of sides) if (tryIt(m, sd)) break outer;
        if (!pick && i.state === 'needs-you') { const [l1, l2] = labelText(i, 'min'); pick = { mode: 'min', side: outward, l1, l2, b: labelBox(i, outward, l1, l2) }; }
        if (!pick) { i.lbl = { mode: 'none', side: outward, l1: '', l2: '' }; continue; }   // no room: no label, and no ring without its number
        placed.push(pick.b);
        i.lbl = pick;
      }
    }

    function makeNode(i) {
      const glowE = h('span', { class: 'nf-glow' }), ping = h('span', { class: 'nf-ping' }), spk = h('span', { class: 'nf-spark' });
      const spin = h('span', { class: 'nf-spin', hidden: true }), face = s('svg', { class: 'nf-svg', 'aria-hidden': 'true' });
      const btn = h('button', { class: 'nn', type: 'button', tabindex: '-1' }, glowE, ping, face, spin, spk);
      const l1 = h('span', { class: 'nl1 trunc' }), l2 = h('span', { class: 'nl2' }), lab = h('div', { class: 'nl side-b', 'aria-hidden': 'true' }, l1, l2);
      const nf = h('div', { class: 'nf', style: `--fd:${(7 + Math.random() * 4).toFixed(1)}s;--fdl:${(-Math.random() * 9).toFixed(1)}s` }, btn, lab);
      const r = { id: i.id, el: h('div', { class: 'na' }, nf), btn, face, spin, glowE, ping, spk, l1, l2, lab, x: null, y: null, tx: 0, ty: 0, rad: 0, sig: '', item: i, state: null, lbl: null };
      btn.addEventListener('pointerenter', () => hover(r, true));
      btn.addEventListener('pointerleave', () => hover(r, false));
      btn.addEventListener('focus', () => { rovingId = r.id; roving(); hover(r, true); });
      btn.addEventListener('blur', () => hover(r, false));
      btn.addEventListener('click', () => { if (r.item.kind === 'sat') { expanded.add(r.item.parent); render(); } else togglePin(r.id); });
      return r;
    }
    const FACE_GLYPH = { 'needs-you': 'needs', busy: 'busy', idle: 'idle', ended: 'ended', agents: 'running', running: 'running', done: 'done' };
    function drawFace(r, i) {
      const R = Math.round(i.r * 2) / 2, x = i.x, prov = x ? x.provider : null, ringOn = !i.lbl || i.lbl.mode !== 'none';
      const pct = x && x.context && ringOn ? x.context.pct : null;
      const sig = [R, i.state, i.kind, pct == null ? '-' : Math.round(pct), prov, i.count || 0, ringOn].join('|');
      if (sig === r.sig) return;
      const oldR = r.rad; r.sig = sig; r.rad = R;
      const pad = 18, S = 2 * (R + pad), half = R + 6;
      Object.assign(r.btn.style, { left: -half + 'px', top: -half + 'px', width: 2 * half + 'px', height: 2 * half + 'px' });
      setAttr(r.face, 'width', S); setAttr(r.face, 'height', S); setAttr(r.face, 'viewBox', `${-R - pad} ${-R - pad} ${S} ${S}`);
      r.face.style.left = r.face.style.top = (half - R - pad) + 'px';
      const box = (e, rr) => Object.assign(e.style, { left: (half - rr) + 'px', top: (half - rr) + 'px', width: 2 * rr + 'px', height: 2 * rr + 'px' });
      box(r.glowE, R * 2); box(r.ping, R + 8); box(r.spk, R + 2); box(r.spin, R + 11);
      r.lab.style.setProperty('--R', (R + 14) + 'px');
      const k = [];
      if (i.kind !== 'sat' && ringOn) {
        k.push(s('circle', { class: 'nf-ctx-t', r: R + 6 }));
        if (pct != null) k.push(s('path', { class: 'nf-ctx', 'data-lvl': ctxLevel(pct), d: arcD(0, 0, R + 6, 0, Math.max(2, Math.min(359.5, pct * 3.6))) }));
      }
      k.push(s('polygon', { class: 'nf-hex', points: hexPts(R) }));
      if (i.kind === 'session' && R >= 18) k.push(s('polygon', { class: 'nf-inner', points: hexPts(R * 0.72) }));
      if (i.kind === 'sat') k.push(s('text', { class: 'nf-letter', y: 1 }, '+' + i.count));
      else {
        // the status shape sits in the centre, the same glyph as on the cards
        const gs = Math.max(9, Math.min(18, R * 0.9)), g = s('g', { class: 'nf-glyph', transform: `translate(${-gs / 2} ${-gs / 2}) scale(${gs / 16})` });
        for (const [t, a] of GLYPHS[FACE_GLYPH[i.state] || 'idle']) g.append(s(t, Object.assign({ 'vector-effect': 'non-scaling-stroke' }, a)));
        k.push(g);
        // provider: a one-letter tag on the rim
        const tx = R * 0.74 + 4, ty = -R * 0.74 - 4;
        k.push(s('rect', { class: 'nf-tag', x: tx - 7, y: ty - 6.5, width: 14, height: 13 }), s('text', { class: 'nf-tag-t', x: tx, y: ty + 0.5 }, provLetter(prov)));
      }
      k.push(s('circle', { class: 'nf-focus', r: R + 13 }));
      r.face.replaceChildren(...k);
      if (oldR && Math.abs(oldR - R) >= 1 && !motion.rm) r.face.animate([{ transform: `scale(${(oldR / R).toFixed(3)})` }, { transform: 'none' }], { duration: 400, easing: EASE });
    }
    function setSpinner(r, i) {
      const on = i.state === 'busy' || i.state === 'running';
      show(r.spin, on);
      if (on && r.spinR !== r.rad) {
        r.spinR = r.rad; const c = r.rad + 11;
        r.spin.replaceChildren(s('svg', { viewBox: `0 0 ${2 * c} ${2 * c}` }, ...[0, 120, 240].map(a => s('path', { d: arcD(c, c, c - 1, a, a + 46) }))));
      }
    }
    function setLabel(r, i) {
      const L = i.lbl || { mode: 'min', side: 'b', l1: '', l2: '' };
      if (r.lbl && r.lbl.side !== L.side) r.lab.classList.remove('side-' + r.lbl.side);
      r.lab.classList.add('side-' + L.side);
      r.lbl = { mode: L.mode, side: L.side };
      r.l1.classList.toggle('is-type', i.kind !== 'session');
      txt(r.l1, L.l1); show(r.l1, !!L.l1); txt(r.l2, L.l2); show(r.l2, !!L.l2);
    }
    function nodeLabel(i) {
      const x = i.x;
      if (i.kind === 'sat') return `${plural(i.count, 'finished subagent', 'finished subagents')}, folded. Enter expands them.`;
      const who = i.kind === 'session' ? `Session in ${x.project || 'an unknown project'}: ${x.title || x.name || 'untitled'}` : `Subagent ${x.type || ''}: ${x.description || ''}`;
      return `${who}. ${x.agent === 'codex' ? 'Codex' : 'Claude Code'}. ${(STATUS[i.state] || STATUS.unknown)[1]}. ${shortModel(x.model) || 'Model unknown'} on ${provName(x.provider)}. ${fmtTok(headline(x.tokens))} tokens. Context ${x.context ? fmtPct(x.context.pct) : 'unknown'}.`;
    }
    function nodeCard(i) {
      const x = i.x;
      if (i.kind === 'sat') return h('div', { class: 'tc' }, h('div', { class: 'tc-t', text: plural(i.count, 'finished subagent', 'finished subagents') }), h('div', { class: 'tc-n', text: 'Folded to keep the network readable. Click to expand.' }));
      const tag = statusTag(); tag.set(i.state);
      const t = x.tokens || {}, tool = x.currentTool, end = x.endedAt || null, work = workText(x.work, cx.plans);
      const activity = activityLine(); activity.set(x.pulse, x.turn);
      return h('div', { class: 'tc' },
        h('div', { class: 'tc-h' }, tag.el, h('span', { class: 'label c-ink2 trunc', text: i.kind === 'session' ? (x.project || '') : `Subagent · level ${i.depth}` })),
        h('div', { class: 'tc-t', text: i.kind === 'session' ? (x.title || x.name || 'Untitled session') : `${x.type || 'agent'}: ${x.description || ''}` }),
        work ? h('div', { class: 'tc-r work-label', text: work }) : null,
        h('div', { class: 'tc-r' }, h('b', { text: shortModel(x.model) || 'model unknown' }), x.effort ? h('span', { text: x.effort }) : null,
          h('span', { text: '· ' + (x.agent === 'codex' ? 'Codex / ' : '') + provName(x.provider) }), h('span', { text: '· ' + (end ? 'ran ' + fmtAge(end - (x.startedAt || end)) : 'running ' + fmtAge(now() - (x.startedAt || now()))) })),
        x.needsYou ? h('div', { class: 'tc-r c-alert' }, icon('alert'), h('span', { text: x.needsYou.reason })) : null,
        tool ? h('div', { class: 'tc-r' }, icon(toolIcon(tool.name)), h('b', { text: tool.name }), h('span', { class: 'trunc', style: 'max-width:240px', text: tool.summary || '' })) : null,
        h('div', { class: 'tc-r' }, h('span', { text: 'Tokens' }), h('b', { text: fmtTok(headline(t)) }), h('span', { text: `in ${fmtTok(t.input)} · out ${fmtTok(t.output)} · write ${fmtTok(t.cacheWrite)}` })),
        h('div', { class: 'tc-r' }, h('span', { text: 'Cache read' }), h('b', { text: fmtTok(t.cacheRead) }),
          i.kind === 'session' && headline(x.tokensTree) > headline(t) ? h('span', { text: `· with subagents ${fmtTok(headline(x.tokensTree))}` }) : null),
        h('div', { class: 'tc-r' }, h('span', { text: 'Context' }), h('b', { text: x.context ? fmtPct(x.context.pct) : '—' }), h('span', { text: x.context ? `${fmtTok(x.context.used)} of ${fmtTok(x.context.window)}` : 'window unknown' })),
        activity.el);
    }

    // A tool call: the node ripples, and a packet runs down the edge from whoever started it.
    function spark(r) {
      if (motion.rm || !r.spk.animate) return;
      r.spk.animate([{ opacity: .9, transform: 'scale(.85)' }, { opacity: 0, transform: 'scale(1.75)' }], { duration: 650, easing: 'ease-out' });
      const p = pos(r.item.parent), q = { x: r.tx, y: r.ty };
      if (Math.hypot(q.x - p.x, q.y - p.y) < 12) return;
      const dot = h('span', { class: 'pkt' + (r.item.kind === 'sub' ? ' sub' : '') });
      flowLayer.append(dot);
      const a = dot.animate([
        { transform: `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) scale(.5)`, opacity: 0 },
        { transform: `translate(${((p.x + q.x) / 2).toFixed(1)}px, ${((p.y + q.y) / 2).toFixed(1)}px) scale(1)`, opacity: 1, offset: .5 },
        { transform: `translate(${q.x.toFixed(1)}px, ${q.y.toFixed(1)}px) scale(.5)`, opacity: 0 }], { duration: 600, easing: 'cubic-bezier(.4, 0, .2, 1)' });
      a.onfinish = a.oncancel = () => dot.remove();
    }
    const toolSig = i => i.x && i.x.currentTool ? i.x.currentTool.name + '@' + i.x.currentTool.since : null;
    const pos = id => { if (id == null) return hubXY; const r = nodes.get(id); return r && r.x != null ? { x: r.x, y: r.y } : hubXY; };

    function syncEdges(items) {
      const ids = new Set(items.map(i => i.id)), want = [];
      for (const i of items) {
        if (i.kind === 'session') {
          want.push({ key: 'h' + i.id, kind: 'spoke', a: null, b: i.id, st: i.state });
          const sb = i.x.startedBy; if (sb && ids.has(sb)) want.push({ key: 's' + i.id, kind: 'sby', a: sb, b: i.id });
        } else want.push({ key: 't' + i.id, kind: i.state === 'running' ? 'run' : 'done', a: i.parent, b: i.id, at: i.startedAt });
      }
      const flowing = new Set(want.filter(e => e.kind === 'run').sort((p, q) => (q.at || 0) - (p.at || 0)).slice(0, 3).map(e => e.key));
      const seen = new Set();
      for (const e of want) {
        seen.add(e.key);
        let rec = edges.get(e.key);
        if (!rec) {
          rec = { key: e.key, base: s('path', { class: 'e' }) }; gE.append(rec.base);
          if (e.kind === 'sby') { rec.inner = s('path', { class: 'e e-sby-i' }); gE.append(rec.inner); }
          edges.set(e.key, rec);
        }
        Object.assign(rec, { kind: e.kind, a: e.a, b: e.b });
        rec.base.classList.remove('e-spoke', 'e-sby-o', 'e-run', 'e-done');
        rec.base.classList.add(e.kind === 'spoke' ? 'e-spoke' : e.kind === 'sby' ? 'e-sby-o' : e.kind === 'run' ? 'e-run' : 'e-done');
        if (e.kind === 'spoke') setData(rec.base, 's', e.st);
        const fl = flowing.has(e.key);
        if (fl && !rec.flow) { rec.flow = h('div', { class: 'eflow' }, h('i')); flowLayer.append(rec.flow); }
        if (!fl && rec.flow) { rec.flow.remove(); rec.flow = null; }
      }
      for (const [k, rec] of edges) if (!seen.has(k)) { rec.base.remove(); rec.inner?.remove(); rec.flow?.remove(); edges.delete(k); }
    }
    function edgeD(rec) {
      const p = pos(rec.a), q = pos(rec.b), f = n => n.toFixed(1);
      if (rec.kind === 'sby') {
        const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2, c = { x: mx + (hubXY.x - mx) * 0.45, y: my + (hubXY.y - my) * 0.45 };
        return `M${f(p.x)} ${f(p.y)}Q${f(c.x)} ${f(c.y)} ${f(q.x)} ${f(q.y)}`;
      }
      return `M${f(p.x)} ${f(p.y)}L${f(q.x)} ${f(q.y)}`;
    }
    function drawEdges() { for (const rec of edges.values()) { const d = edgeD(rec); setAttr(rec.base, 'd', d); if (rec.inner) setAttr(rec.inner, 'd', d); if (rec.flow) placeFlow(rec.flow, pos(rec.a), pos(rec.b)); } }
    // Depth rings with tick marks: the radar scope the tree sits on (one ring per level).
    function drawRings(L, any) {
      const sig = [W, H, hubXY.x, hubXY.y, L.sx, L.sy, L.maxDepth, any].join('|');
      if (sig === ringSig) return; ringSig = sig;
      if (!any) { gR.replaceChildren(); return; }
      const out = [];
      for (let d = 0; d <= L.maxDepth; d++) out.push(s('ellipse', { class: 'n-ring' + (d === L.maxDepth ? ' outer' : ''), cx: hubXY.x, cy: hubXY.y, rx: L.ring(d) * L.sx, ry: L.ring(d) * L.sy }));
      const rx = L.ring(L.maxDepth) * L.sx + 14, ry = L.ring(L.maxDepth) * L.sy + 14;
      for (let a = 0; a < 360; a += 10) {
        const t = (a - 90) * Math.PI / 180, long = a % 30 === 0, c = Math.cos(t), sn = Math.sin(t), k = long ? 6 : 3;
        out.push(s('line', { class: 'n-tick' + (long ? ' long' : ''), x1: hubXY.x + rx * c, y1: hubXY.y + ry * sn, x2: hubXY.x + (rx + k) * c, y2: hubXY.y + (ry + k) * sn }));
      }
      gR.replaceChildren(...out);
      // the radar: a circle turning about the hub, seen through an ellipse fitted to the rings that fades at its rim
      const ew = 2 * (rx + 28), eh = 2 * (ry + 28), dd = 2 * Math.max(rx, ry) + 60;
      Object.assign(sweep.style, { width: ew + 'px', height: eh + 'px', left: (hubXY.x - ew / 2) + 'px', top: (hubXY.y - eh / 2) + 'px' });
      Object.assign(sweepIn.style, { width: dd + 'px', height: dd + 'px', left: (ew - dd) / 2 + 'px', top: (eh - dd) / 2 + 'px' });
    }
    // Project names run along the inner arc, after the node labels are placed: a node's name and numbers come first, and
    // a project name that finds no free stretch of arc is left to the node cards.
    function drawGroups(L, items) {
      const R0 = L.ring(0), rx = R0 * L.sx, ry = R0 * L.sy, band = Math.round(L.rMax * 2 + 4);
      const lbls = items.filter(i => i.lbl && i.lbl.b).map(i => i.lbl.b);
      const sig = [W, H, hubXY.x, hubXY.y, rx, ry, band, ...L.G.map(g => g.name + g.a0.toFixed(1) + g.a1.toFixed(1)), ...items.map(i => i.r.toFixed(0)), ...lbls.map(b => [b.x0, b.y0, b.x1].map(v => Math.round(v / 4)).join(','))].join('|');
      if (sig === groupSig) return; groupSig = sig;
      const out = [];
      if (L.G.length < 2) { gG.replaceChildren(); return; }   // one project: its name sits under the hub instead
      const discs = items.map(i => ({ x: i.px, y: i.py, r: i.r + 18 }));   // + the glyphs, which sit up to 9 px off the path
      const free = p => !discs.some(d => Math.hypot(d.x - p.x, d.y - p.y) < d.r) && !lbls.some(b => p.x > b.x0 - 6 && p.x < b.x1 + 6 && p.y > b.y0 - 10 && p.y < b.y1 + 10);
      L.G.forEach((g, gi) => {
        const full = g.a1 - g.a0 >= 359, a0 = full ? 0 : g.a0 + 1.5, a1 = full ? 359.9 : g.a1 - 1.5;
        const ar = (r0, a) => { const t = (a - 90) * Math.PI / 180; return [hubXY.x + (rx + r0) * Math.cos(t), hubXY.y + (ry + r0) * Math.sin(t)]; };
        if (a1 > a0) {
          out.push(s('path', { class: 'g-arc', d: ellArc(hubXY.x, hubXY.y, rx - band / 2, ry - band / 2, a0, a1) }));
          if (!full) for (const a of [a0, a1]) { const [x0, y0] = ar(-band / 2 - 4, a), [x1, y1] = ar(-band / 2 + 4, a); out.push(s('line', { class: 'g-tick', x1: x0, y1: y0, x2: x1, y2: y1 })); }
        }
        const lrx = rx - band / 2 - 10, lry = ry - band / 2 - 10;
        if (lrx < 36 || lry < 36) return;
        const chars = g.name.length, need = chars * 8.4 + 8;                          // the label's arc length, in px
        const deg = need / (((lrx + lry) / 2) * Math.PI / 180);
        const pt = a => { const t = (a - 90) * Math.PI / 180; return { x: hubXY.x + lrx * Math.cos(t), y: hubXY.y + lry * Math.sin(t) }; };
        const clear = a => { for (let k = 0; k <= 8; k++) if (!free(pt(a - deg / 2 + k * deg / 8))) return false; return true; };
        let mid = (g.a0 + g.a1) / 2, best = null;
        for (const off of [0, -8, 8, -16, 16, -24, 24, -36, 36]) { const m = mid + off; if ((full || (m - deg / 2 >= g.a0 - 4 && m + deg / 2 <= g.a1 + 4)) && clear(m)) { best = m; break; } }
        if (best == null) return;   // no free stretch of arc: the project shows in the node's card instead
        mid = best;
        const b0 = mid - deg / 2 - 2, b1 = mid + deg / 2 + 2;
        const m = ((mid % 360) + 360) % 360, lower = m > 90 && m < 270, id = `${uid}-g${gi}`;
        out.push(s('path', { id, d: lower ? ellArc(hubXY.x, hubXY.y, lrx, lry, b1, b0, true) : ellArc(hubXY.x, hubXY.y, lrx, lry, b0, b1), fill: 'none' }));
        const label = s('text', { class: 'g-lbl', dy: lower ? 10 : -2 }, s('textPath', { href: '#' + id, startOffset: '50%', 'text-anchor': 'middle' }, g.name));
        if (api.project) {
          setAttr(label, 'role', 'button');
          setAttr(label, 'tabindex', '0');
          setAttr(label, 'aria-label', g.name);
          setData(label, 'project', g.name);
          label.addEventListener('click', () => api.project(g.name));
          label.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); api.project(g.name); }
          });
        }
        out.push(label);
      });
      gG.replaceChildren(...out);
    }

    function placeNode(r) { r.el.style.transform = `translate3d(${r.x.toFixed(1)}px, ${r.y.toFixed(1)}px, 0)`; }
    function moveAll() {
      const list = [...nodes.values()];
      cancelAnimationFrame(tween); tween = 0;
      const moving = list.some(r => Math.abs(r.x - r.tx) > 0.5 || Math.abs(r.y - r.ty) > 0.5);
      if (!moving || motion.rm) { for (const r of list) { r.x = r.tx; r.y = r.ty; placeNode(r); } drawEdges(); settle(moving); return; }
      const from = list.map(r => [r, r.x, r.y]), t0 = performance.now();
      const step = t => {
        const k = Math.min(1, (t - t0) / 450), e = easeOut(k);
        for (const [r, fx, fy] of from) { r.x = fx + (r.tx - fx) * e; r.y = fy + (r.ty - fy) * e; placeNode(r); }
        drawEdges();
        if (k < 1) tween = requestAnimationFrame(step); else { tween = 0; settle(true); }
      };
      tween = requestAnimationFrame(step);
    }
    function settle(moved) { for (const r of nodes.values()) if (r.pulse) { r.pulse = false; returnPulse(r); } if (moved) retime(false); }
    // "Handed the result back": a bright pulse travels from the finished child to its parent, then the edge dims.
    function returnPulse(r) {
      r.el.classList.remove('just-done'); void r.el.offsetWidth; r.el.classList.add('just-done');
      setTimeout(() => r.el.classList.remove('just-done'), 1600);
      const rec = edges.get('t' + r.id), p = pos(r.item.parent), q = { x: r.x, y: r.y };
      if (motion.rm) { if (rec) { rec.base.classList.add('flash'); setTimeout(() => rec.base.classList.remove('flash'), 400); } return; }
      const len = Math.hypot(p.x - q.x, p.y - q.y); if (len < 4) return;
      const path = s('path', { class: 'e e-pulse', d: `M${q.x.toFixed(1)} ${q.y.toFixed(1)}L${p.x.toFixed(1)} ${p.y.toFixed(1)}`, 'stroke-dasharray': `14 ${Math.ceil(len + 28)}` });
      gP.append(path);
      const an = path.animate([{ strokeDashoffset: 14 }, { strokeDashoffset: -len }], { duration: Math.min(900, 380 + len * 1.6), easing: 'cubic-bezier(.4, 0, .2, 1)' });
      an.onfinish = an.oncancel = () => path.remove();
    }
    // Radar sweep (ambient): every node pings when the sweep passes it, on the shared document timeline.
    function retime(force) {
      if (!motion.ambient) {
        if (sweepAnim) { sweepAnim.cancel(); sweepAnim = null; }
        for (const r of nodes.values()) if (r.pingAnim) { r.pingAnim.cancel(); r.pingAnim = null; r.pingAng = null; }
        return;
      }
      if (!sweepAnim) { sweepAnim = sweepIn.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: SWEEP_MS, iterations: Infinity }); sweepAnim.startTime = 0; }
      for (const r of nodes.values()) {
        const ang = (Math.atan2(r.tx - hubXY.x, -(r.ty - hubXY.y)) * 180 / Math.PI + 360) % 360;
        if (!force && r.pingAnim && Math.abs(ang - r.pingAng) < 1) continue;
        if (r.pingAnim) r.pingAnim.cancel();
        r.pingAng = ang;
        r.pingAnim = r.ping.animate([{ opacity: 0, transform: 'scale(.9)' }, { opacity: .9, transform: 'scale(1)', offset: .004 }, { opacity: 0, transform: 'scale(1.45)', offset: .1 }, { opacity: 0, transform: 'scale(1.45)' }],
          { duration: SWEEP_MS, iterations: Infinity, delay: ang / 360 * SWEEP_MS - SWEEP_MS });
        r.pingAnim.startTime = 0;
      }
    }

    function chain(id) { const out = new Set(); let cur = nodes.get(id), g = 0; while (cur && g++ < 12) { out.add(cur.id); cur = cur.item.parent ? nodes.get(cur.item.parent) : null; } return out; }
    function highlight() {
      const id = hoverId || pinnedId, on = id && nodes.has(id) ? chain(id) : new Set();
      el.classList.toggle('hl-on', on.size > 0);
      for (const r of nodes.values()) { r.el.classList.toggle('hl', on.has(r.id)); r.el.classList.toggle('pinned', r.id === pinnedId); }
      for (const rec of edges.values()) {
        const lit = rec.kind !== 'sby' && on.has(rec.b) && (rec.a == null || on.has(rec.a));
        rec.base.classList.toggle('hl', lit); if (rec.flow) rec.flow.classList.toggle('hl', lit); if (rec.inner) rec.inner.classList.toggle('hl', lit);
      }
    }
    // Floating cards dock in a corner that covers neither the node they describe nor anything that needs you: the top
    // corner away from the node first, so the lit path to the hub stays in view.
    function dock(r, w, hh, spots) {
      const avoid = [...nodes.values()].filter(n => n === r || n.state === 'needs-you').map(n => ({ x0: n.tx - n.rad - 12, x1: n.tx + n.rad + 12, y0: n.ty - n.rad - 12, y1: n.ty + n.rad + 12 }));
      const away = r.tx > W / 2 ? 'left' : 'right', near = away === 'left' ? 'right' : 'left', bottom = W >= 560 ? 28 : 0;
      const box = ([sx, sy]) => { const x0 = sx === 'left' ? 0 : W - w, y0 = sy === 'top' ? 0 : H - bottom - hh; return { x0, x1: x0 + w, y0, y1: y0 + hh }; };
      const hits = sp => avoid.filter(a => overlaps(a, box(sp))).length;
      return spots.map(([a, y]) => [a === 'away' ? away : near, y]).reduce((b, sp) => hits(sp) < hits(b) ? sp : b);
    }
    function showReadout(r) {
      readBox.replaceChildren(nodeCard(r.item));
      show(readout, true);
      const [x, y] = dock(r, readout.offsetWidth, readout.offsetHeight, [['away', 'top'], ['near', 'top'], ['away', 'bottom'], ['near', 'bottom']]);
      readout.classList.toggle('left', x === 'left'); readout.classList.toggle('right', x === 'right'); readout.classList.toggle('bottom', y === 'bottom');
    }
    function hover(r, on) {
      if (on) { hoverId = r.id; if (r.id !== pinnedId) showReadout(r); }
      else if (hoverId === r.id) { hoverId = null; show(readout, false); }
      highlight();
    }
    function togglePin(id) { if (pinnedId === id) unpin(); else { pinnedId = id; show(readout, false); fillPin(); highlight(); } }
    function unpin() { pinnedId = null; pinFor = null; pinCard = null; pinBox.replaceChildren(); show(pinBox, false); show(legend, W >= 560 && nodes.size > 0); highlight(); }
    function fillPin() {
      const r = nodes.get(pinnedId); if (!r) { unpin(); return; }
      const i = r.item; show(pinBox, true); show(legend, false);
      if (pinFor !== pinnedId) {
        pinFor = pinnedId;
        const close = h('button', { class: 'btn', type: 'button' }, icon('close'), 'Unpin');
        close.addEventListener('click', () => { const b = r.btn; unpin(); b.focus(); });
        const toCards = api.showCard && h('button', { class: 'btn', type: 'button',
          on: { click: () => api.showCard(i.kind === 'session' ? i.id : i.session) } }, icon('cards'), 'Show in cards');
        if (i.kind === 'session') pinCard = sessionCard(api);
        else { const box = h('div', { class: 'card cutbox' }); pinCard = { el: box, update: ii => box.replaceChildren(nodeCard(ii)) }; }
        pinBox.replaceChildren(pinCard.el, h('div', { class: 'pin-bar' }, toCards, close));
      }
      if (i.kind === 'session') pinCard.update(i.x, cx); else pinCard.update(i);
      const [x] = dock(r, pinBox.offsetWidth, pinBox.offsetHeight, [['away', 'bottom'], ['near', 'bottom']]);
      pinBox.classList.toggle('left', x === 'left');
    }
    function roving() {
      if (!rovingId || !nodes.has(rovingId)) { const f = [...nodes.values()].find(r => r.item.kind === 'session') || nodes.values().next().value; rovingId = f ? f.id : null; }
      for (const r of nodes.values()) setAttr(r.btn, 'tabindex', r.id === rovingId ? '0' : '-1');
    }
    layer.addEventListener('keydown', e => {
      if (e.key === 'Escape') { if (pinnedId) { e.preventDefault(); unpin(); } return; }
      const cur = nodes.get(rovingId);
      const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[e.key];
      if (!cur || !dir) return;
      e.preventDefault();
      let best = null, bs = Infinity;
      for (const r of nodes.values()) {
        if (r === cur) continue;
        const vx = r.tx - cur.tx, vy = r.ty - cur.ty, along = vx * dir[0] + vy * dir[1];
        if (along <= 4) continue;
        const score = along + 2 * Math.abs(vx * dir[1] - vy * dir[0]);
        if (score < bs) { bs = score; best = r; }
      }
      if (best) { rovingId = best.id; roving(); best.btn.focus(); }
    });

    function render() {
      if (!data || !W || !H) return;
      const items = graph(data), L = layout(items);
      const singleProject = L.G.length === 1 ? L.G[0].name : null;
      txt(hubHost, (cx.host || 'This PC') + (singleProject ? ' · ' : ''));
      hubProject.set(singleProject); show(hubProject.el, !!singleProject);
      show(empty, items.length === 0); show(legend, items.length > 0 && W >= 560 && !pinnedId);
      hub.style.transform = `translate(${hubXY.x.toFixed(1)}px, ${hubXY.y.toFixed(1)}px)`;
      empty.style.top = Math.round(hubXY.y + 52) + 'px';
      drawRings(L, items.length > 0);
      placeLabels(items, L);
      drawGroups(L, items);
      const seen = new Set();
      for (const i of items) {
        let r = nodes.get(i.id);
        const fresh = !r;
        if (fresh) { r = makeNode(i); nodes.set(i.id, r); layer.append(r.el); }
        seen.add(i.id); r.item = i; r.tx = i.px; r.ty = i.py;
        if (fresh) {
          const p = i.parent ? nodes.get(i.parent) : null, o = drawn ? (p && p.x != null ? p : hubXY) : { x: i.px, y: i.py };
          r.x = o.x; r.y = o.y; placeNode(r); r.toolSig = toolSig(i);
          if (drawn && !motion.rm) r.btn.animate([{ opacity: 0, transform: 'scale(.3)' }, { opacity: 1, transform: 'none' }], { duration: 450, easing: EASE });
        }
        if (r.state === 'running' && i.state === 'done') r.pulse = true;
        r.state = i.state; setData(r.el, 's', i.state); setData(r.el, 'project', i.project || cx.byId?.get(i.session)?.project);
        drawFace(r, i); setSpinner(r, i); setLabel(r, i);
        const ts = toolSig(i); if (!fresh && ts && ts !== r.toolSig) spark(r); r.toolSig = ts;
        setAttr(r.btn, 'aria-label', nodeLabel(i));
      }
      for (const [id, r] of nodes) if (!seen.has(id)) {
        nodes.delete(id); r.pingAnim?.cancel();
        if (cx.project) r.el.remove();
        else { r.el.inert = true; r.el.style.opacity = '0'; setTimeout(() => r.el.remove(), 300); }
      }
      syncEdges(items);
      moveAll();
      if (!drawn) retime(true);
      // A changed TV target updates the pin after the nodes exist, without taking keyboard focus.
      const nextPin = cx.autoPin ?? null;
      if (nextPin !== autoPin) {
        if (nextPin) { pinnedId = nextPin; show(readout, false); }
        else if (pinnedId === autoPin) unpin();
        autoPin = nextPin;
      }
      if (pinnedId) fillPin();
      if (hoverId && nodes.has(hoverId)) { if (!readout.hidden) showReadout(nodes.get(hoverId)); } else if (hoverId) { hoverId = null; show(readout, false); }
      highlight(); roving();
      drawn = true;
    }
    return {
      el, nodeCard,
      update(sessions, c) { data = sessions; cx = c || {}; render(); },
      pin(id) {
        const r = nodes.get(id);
        if (!r) return false;
        if (pinnedId !== id) togglePin(id);
        rovingId = id; roving(); r.btn.focus({ preventScroll: true });
        return true;
      },
      hoverDemo(id) { const r = nodes.get(id); if (r) hover(r, true); },   // the gallery shows a lit path without a mouse
    };
  }


  // ---- plan graph ------------------------------------------------------------------------------------------------------------
  const DONE_STATES = new Set(['accepted', 'done', 'handed-off']);
  const BOARD_MARKS = { unclaimed: ['Board not updated', '!'], stalled: ['Stalled', 'Ⅱ'], early: ['Started early', '↑'] };
  const boardPlanKey = p => p.project + '|' + p.slug;
  const activeAgents = item => (item?.agents || []).filter(a => a.active);
  let planDetailId = 0;
  function planLayout(nodes, horizontal) {
    const ids = new Set(nodes.map(n => n.id));
    const deps = new Map(nodes.map(n => [n.id, (n.waitsFor || []).filter(d => ids.has(d) && d !== n.id)]));
    const layer = new Map();
    const lay = (id, stack) => {
      if (layer.has(id)) return layer.get(id);
      if (stack.has(id)) return 0;
      stack.add(id); let l = 0; for (const d of deps.get(id)) l = Math.max(l, lay(d, stack) + 1); stack.delete(id);
      layer.set(id, l); return l;
    };
    nodes.forEach(n => lay(n.id, new Set()));
    const L = [];
    for (const n of nodes) { const l = layer.get(n.id); (L[l] = L[l] || []).push(n); }
    const idx = new Map();
    L.forEach((list = [], li) => {
      if (li > 0) list.sort((a, b) => bary(a) - bary(b));
      list.forEach((n, k) => idx.set(n.id, k));
    });
    function bary(n) { const ds = deps.get(n.id); return ds.length ? ds.reduce((t, d) => t + (idx.get(d) ?? 0), 0) / ds.length : 99; }
    const per = Math.max(1, ...L.map(l => (l || []).length));
    const step = horizontal ? 80 : 84, cross = horizontal ? 60 : 64, pad = 26;
    const pos = new Map();
    L.forEach((list = [], li) => list.forEach((n, k) => {
      const c = pad + (k + (per - list.length) / 2) * cross, m = pad + li * step;
      pos.set(n.id, horizontal ? { x: m, y: c } : { x: c, y: m });
    }));
    const along = pad * 2 + Math.max(0, L.length - 1) * step, across = pad * 2 + (per - 1) * cross + 18;
    return { pos, deps, w: horizontal ? along : across, h: horizontal ? across : along + 18, horizontal };
  }
  function planNodeCard(n, info = {}, jump) {
    const tag = statusTag(); tag.set(STATUS[n.state] ? n.state : 'unknown', null, n.stateRaw && n.stateRaw !== n.state ? n.stateRaw : null);
    const agentRows = (info.agents || []).map(({ label, sessionId, active }) => {
      const text = label + (active ? ' · active' : ' · idle');
      return jump ? h('button', { type: 'button', class: 'btn plan-agent', text, on: { click: () => jump(sessionId) } }) : h('span', { text });
    });
    return h('div', { class: 'tc' },
      h('div', { class: 'tc-h' }, tag.el, n.group && n.group !== 'Board' ? h('span', { class: 'label c-ink2 trunc', text: n.group }) : null),
      h('div', { class: 'tc-t', text: `${n.id} · ${n.name || ''}` }),
      h('div', { class: 'tc-r' }, n.agent ? h('span', {}, 'agent ', h('b', { text: n.agent })) : null, n.model ? h('span', { text: [n.model, n.effort].filter(Boolean).join(' / ') }) : null, n.since ? h('span', { text: 'since ' + n.since }) : null),
      (n.waitsFor?.length || n.waitsForOther?.length) ? h('div', { class: 'tc-r', text: 'waits for ' + [...(n.waitsFor || []), ...(n.waitsForOther || [])].join(', ') }) : null,
      n.notes ? h('div', { class: 'tc-n', text: n.notes }) : null,
      agentRows.length ? h('div', { class: 'tc-r plan-agents', 'aria-label': 'Linked agents' }, agentRows) : null,
      info.flags?.length ? h('div', { class: 'tc-r plan-flags', text: info.flags.map(flag => BOARD_MARKS[flag][0]).join(' · ') }) : null,
      info.history?.length ? h('div', { class: 'tc-r plan-history', 'aria-label': 'Recent changes' }, info.history.map(entry => {
        const time = new Date(entry.at);
        const state = entry.to === 'in-progress' && entry.label ? `claimed by ${entry.label}` :
          `${entry.from} → ${entry.to}${entry.label ? ' by ' + entry.label : ''}`;
        return h('div', {}, h('time', { class: 'mono', datetime: time.toISOString(), text: pad2(time.getHours()) + ':' + pad2(time.getMinutes()) }), ' · ', state);
      })) : null);
  }
  // Circuit-style elbow from a to b; returns the SVG path and its straight segments (for the flow strips).
  function elbow(a, b, horizontal) {
    const segs = [];
    if (horizontal) {
      const mx = Math.round((a.x + b.x) / 2), dy = b.y - a.y, sg = Math.sign(dy), rr = Math.min(6, Math.abs(dy) / 2, (b.x - a.x) / 4);
      if (Math.abs(dy) < 1) return { d: `M${a.x} ${a.y}H${b.x}`, segs: [[a, b]] };
      segs.push([a, { x: mx, y: a.y }], [{ x: mx, y: a.y }, { x: mx, y: b.y }], [{ x: mx, y: b.y }, b]);
      return { d: `M${a.x} ${a.y}H${mx - rr}Q${mx} ${a.y} ${mx} ${a.y + sg * rr}V${b.y - sg * rr}Q${mx} ${b.y} ${mx + rr} ${b.y}H${b.x}`, segs };
    }
    const my = Math.round((a.y + b.y) / 2), dx = b.x - a.x, sg = Math.sign(dx), rr = Math.min(6, Math.abs(dx) / 2, (b.y - a.y) / 4);
    if (Math.abs(dx) < 1) return { d: `M${a.x} ${a.y}V${b.y}`, segs: [[a, b]] };
    segs.push([a, { x: a.x, y: my }], [{ x: a.x, y: my }, { x: b.x, y: my }], [{ x: b.x, y: my }, b]);
    return { d: `M${a.x} ${a.y}V${my - rr}Q${a.x} ${my} ${a.x + sg * rr} ${my}H${b.x - sg * rr}Q${b.x} ${my} ${b.x} ${my + rr}V${b.y}`, segs };
  }
  function planGraph(detailId, open, preview) {
    const svg = s('svg', { role: 'group' });
    const fx = h('div', { class: 'pg-fx', 'aria-hidden': 'true' });
    const box = h('div', { class: 'pg-box' }, svg, fx);
    const wrap = h('div', { class: 'plan-g' }, box);
    let sig = '';
    function mark(n, x, y, R) {
      const bx = x + R * 0.72, by = y - R * 0.72, st = n.state;
      const d = st === 'accepted' || st === 'done' ? `M${bx - 3} ${by + 0.2}l2 2 4-4.2` : st === 'handed-off' ? `M${bx - 3.5} ${by}h6M${bx + 0.5} ${by - 2.5}l2.5 2.5-2.5 2.5`
        : st === 'blocked' ? `M${bx} ${by - 3.5}v3.8M${bx} ${by + 2.8}v.3` : st === 'bounced' ? `M${bx + 3} ${by - 2}h-4a2 2 0 0 0 0 4h1M${bx - 2.5} ${by - 4}l-2 2 2 2`
        : st === 'partial' ? `M${bx - 1.75} ${by - 3}v6M${bx + 1.75} ${by - 3}v6` : null;   // partial: paused part-way
      return d ? [s('circle', { class: 'pn-badge', cx: bx, cy: by, r: 7 }), s('path', { class: 'pn-mark', d })] : [];
    }
    return {
      el: wrap,
      select(id) {
        for (const g of svg.querySelectorAll('.pn')) setAttr(g, 'aria-expanded', String(g.dataset.id === id));
      },
      focus(id) { [...svg.querySelectorAll('.pn')].find(g => g.dataset.id === id)?.focus(); },
      update(nodes, items, key, selected) {
        const width = wrap.clientWidth || 300;
        const views = new Map(nodes.map(n => {
          const item = items[`${key}#${n.id}`];
          return [n.id, { count: activeAgents(item).length, flags: (item?.flags || []).filter(flag => BOARD_MARKS[flag]) }];
        }));
        const sigNow = JSON.stringify([width, nodes.map(n => [n.id, n.name, n.state, n.agent, n.kind, n.waitsFor, views.get(n.id)])]);
        if (sigNow === sig) return; sig = sigNow;
        const focused = svg.contains(doc.activeElement) ? doc.activeElement.dataset.id : null;
        if (svg.contains(tip.anchor)) tip.close();
        let G = planLayout(nodes, true);
        if (G.w > width) { const V = planLayout(nodes, false); if (V.w <= width) G = V; }
        setAttr(svg, 'width', G.w); setAttr(svg, 'height', G.h); setAttr(svg, 'viewBox', `0 0 ${G.w} ${G.h}`);
        box.style.width = G.w + 'px'; box.style.height = G.h + 'px';
        const byId = new Map(nodes.map(n => [n.id, n])), out = [], fxKids = [];
        for (const n of nodes) for (const d of G.deps.get(n.id)) {
          const a = G.pos.get(d), b = G.pos.get(n.id), from = byId.get(d);
          const count = views.get(n.id).count, flowing = n.state === 'in-progress' || count > 0;
          const cls = flowing ? 'pe flow' : n.state === 'blocked' || n.state === 'bounced' ? 'pe alert' : DONE_STATES.has(from.state) ? 'pe done' : 'pe';
          const E = G.horizontal ? elbow({ x: a.x + 20, y: a.y }, { x: b.x - 20, y: b.y }, true) : elbow({ x: a.x, y: a.y + 40 }, { x: b.x, y: b.y - 22 }, false);
          out.push(s('path', { class: cls, d: E.d }));
          if (flowing) for (const [p, q] of E.segs) {
            if (Math.hypot(q.x - p.x, q.y - p.y) < 2) continue;
            const f = h('div', { class: 'eflow plan', 'data-active': count ? '1' : null }, h('i')); placeFlow(f, p, q); fxKids.push(f);
          }
        }
        for (const n of nodes) {
          const p = G.pos.get(n.id), st = STATUS[n.state] ? n.state : 'unknown', input = n.kind === 'input';
          const { count, flags } = views.get(n.id);
          const R = n.id.length > 4 ? 21 : 18, D = R + 2;   // a long id ("UX-10") gets a bigger shape, so it never touches the outline
          const shape = input ? `${p.x},${p.y - D} ${p.x + D},${p.y} ${p.x},${p.y + D} ${p.x - D},${p.y}` : hexPts(R).split(' ').map(q => { const [x, y] = q.split(',').map(Number); return (x + p.x).toFixed(2) + ',' + (y + p.y).toFixed(2); }).join(' ');
          const label = [`${n.id} ${n.name || ''}: ${(STATUS[st] || STATUS.unknown)[1]}`, n.agent && 'agent ' + n.agent,
            count && plural(count, 'active agent', 'active agents'), ...flags.map(flag => BOARD_MARKS[flag][0])].filter(Boolean).join(', ');
          const badge = (x, y, circle, text, word, r = 7) => [
            s('circle', { class: circle, cx: x, cy: y, r }), s('text', { class: text, x, y }, word),
          ];
          const g = s('g', { class: 'pn', 'data-id': n.id, 'data-s': st, 'data-active': count || null, tabindex: '0', role: 'button',
            'aria-label': label, 'aria-controls': detailId, 'aria-expanded': String(selected === n.id) },
            s('circle', { class: 'pn-focus', cx: p.x, cy: p.y, r: R + 6 }),
            s('polygon', { class: 'pn-hex', points: shape }),
            s('text', { class: 'pn-id', x: p.x, y: p.y + 0.5, style: n.id.length > 4 ? 'letter-spacing:0' : null }, n.id),
            mark(n, p.x, p.y, R),
            count ? badge(p.x - R * .72, p.y - R * .72, 'pn-active', 'pn-count', count > 99 ? '99+' : count, 8) : null,
            flags.map((flag, i) => s('g', { 'data-flag': flag },
              badge(p.x + (i - (flags.length - 1) / 2) * 13, p.y + R - 1, 'pn-drift', 'pn-flag', BOARD_MARKS[flag][1], 6))),
            n.agent || input ? s('text', { class: 'pn-ag', x: p.x, y: p.y + R + 16 }, (input ? 'you' : n.agent).slice(0, 12)) : null);
          const peek = () => { if (g.getAttribute('aria-expanded') === 'false') tip.open(g, preview(n.id)); };
          const close = () => tip.close(g);
          g.addEventListener('pointerenter', peek); g.addEventListener('pointerleave', close);
          g.addEventListener('focus', peek); g.addEventListener('blur', close);
          g.addEventListener('click', () => { close(); open(n.id); });
          g.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); close(); open(n.id); }
          });
          out.push(g);
          if (count || st === 'in-progress') fxKids.push(h('div', { class: 'pg-pulse', 'data-active': count ? '1' : null, 'data-id': n.id,
            style: `left:${p.x}px;top:${p.y}px` }, s('svg', { viewBox: '-22 -22 44 44' }, s('polygon', { points: input ? '0,-20 20,0 0,20 -20,0' : hexPts(Math.min(R, 21)) }))));
        }
        svg.replaceChildren(...out);
        fx.replaceChildren(...fxKids);
        if (focused) this.focus(focused);
      },
    };
  }
  function planCard(api = {}) {
    const proj = projectLabel(api, 'plan-p label trunc', '');
    const need = h('span', { class: 'chip', style: 'color:var(--alert);border-color:rgba(255,77,94,.5)', hidden: true }, icon('alert'), 'Needs you');
    const live = h('span', { class: 'chip', style: 'color:var(--arc);border-color:rgba(41,230,255,.5)', hidden: true }, 'Working');
    const stChip = h('span', { class: 'chip plan-state', hidden: true }), count = h('span', { class: 'plan-c' });
    const title = h('h3', { class: 'plan-t trunc', 'data-tip-if': 'trunc' });
    const detailId = 'plan-detail-' + ++planDetailId;
    const detailBody = h('div');
    const close = h('button', { type: 'button', class: 'tgl plan-detail-close', 'aria-label': 'Close item details',
      on: { click: closeDetail } }, icon('close'));
    const detail = h('div', { id: detailId, class: 'plan-detail', tabindex: '-1', hidden: true }, close, detailBody);
    const graph = planGraph(detailId, select, id => planNodeCard(nodes.get(id), infoFor(id)));
    const needs = h('div'), runs = h('div', { class: 'plan-runs', hidden: true }), log = h('p', { class: 'plan-log', hidden: true });
    const el = h('article', { class: 'plan' }, h('header', { class: 'plan-h' }, proj.el, live, need, stChip, count), title, graph.el, needs, runs, detail, log);
    let needSig = null, runSig = null;   // the need rows and run chips are rebuilt only when their text changed
    let plan, items = {}, labelOf = () => 'Agent', nodes = new Map(), selected = null, detailSig = '';
    function infoFor(id) {
      const item = items[`${boardPlanKey(plan)}#${id}`];
      return {
        agents: (item?.agents || []).map(a => ({ ...a, label: labelOf(a) })),
        flags: (item?.flags || []).filter(flag => BOARD_MARKS[flag]),
        history: (plan.history || []).filter(entry => entry.id === id).slice(-3).reverse().map(entry => ({
          ...entry, label: entry.sessionId ? labelOf(entry) : null,
        })),
      };
    }
    function drawDetail() {
      const node = nodes.get(selected);
      show(detail, !!node);
      if (!node) {
        if (detailSig) { detailSig = ''; detailBody.replaceChildren(); }
        return;
      }
      const info = infoFor(selected);
      const sig = JSON.stringify([node, info]);
      if (sig === detailSig) return;
      detailSig = sig;
      detailBody.replaceChildren(planNodeCard(node, info, api.jump));
    }
    function select(id) {
      selected = selected === id ? null : id;
      tip.close();
      graph.select(selected);
      for (const button of runs.children) setAttr(button, 'aria-expanded', String(button.dataset.id === selected));
      drawDetail();
      if (selected) detail.focus();
      api.layout?.();
    }
    function closeDetail() {
      const id = selected;
      select(id);
      const run = [...runs.children].find(button => button.dataset.id === id);
      if (run) run.focus(); else graph.focus(id);
    }
    detail.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetail(); });
    return {
      el,
      update(p, board = {}, nameOf = labelOf) {
        plan = p; items = board.items || {}; labelOf = nameOf;
        const all = p.phases || [], key = boardPlanKey(p), working = board.plans?.[key]?.active || 0;
        nodes = new Map([...all, ...(p.runs || [])].map(n => [n.id, n]));
        if (!nodes.has(selected)) selected = null;
        proj.set(p.project); setData(proj.el, 'tip', p.path ? 'From ' + p.path : null);
        txt(title, p.title || p.slug); title.dataset.tip = p.title || p.slug;
        show(live, working > 0); txt(live, 'Working ' + working);
        setData(live, 'tip', working ? plural(working, 'active agent', 'active agents') + ' linked to this board' : null);
        show(stChip, !!p.state); txt(stChip, p.state ? p.state + (p.stateDate ? ' ' + p.stateDate : '') : '');
        const done = all.filter(n => DONE_STATES.has(n.state)).length;
        txt(count, `${done}/${all.length}`); setData(count, 'tip', `${done} of ${all.length} done, handed off or accepted`);
        const stuck = all.filter(n => n.state === 'blocked' || n.state === 'bounced');
        show(need, (p.needsYou && p.needsYou.length > 0) || stuck.length > 0);
        setData(el, 'project', p.project || ''); setData(el, 'need', need.hidden ? null : '1');
        graph.update(all, items, key, selected);
        const rows = [
          // the id is in the label already, so a text that starts with it ("D2 A changed booking …") drops it
          ...(p.needsYou || []).map(q => [`${q.kind === 'decision' ? 'Decision' : 'Question'} ${q.id}${q.item ? ' · ' + q.item : ''}`, String(q.text || '').replace(new RegExp('^\\**' + String(q.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b\\**[\\s:·.–-]*'), '')]),
          ...stuck.map(n => [`${n.state === 'blocked' ? 'Blocked' : 'Bounced'} ${n.id}`, n.notes || n.name || '']),
        ];
        const ns = JSON.stringify(rows);
        if (ns !== needSig) { needSig = ns; needs.replaceChildren(...rows.map(([b, t]) => h('div', { class: 'plan-need' }, icon('alert'), h('div', { class: 'plan-need-t', 'data-tip': t }, h('b', { text: b }), t)))); }
        const rs = (p.runs || []).map(r => {
          const item = items[`${key}#${r.id}`];
          return [r.id, r.state, [`Run ${r.id}: ${r.name || ''}`, r.lane && 'lane ' + r.lane,
            r.chunks?.length && 'chunks ' + r.chunks.join(', '), r.startWhen && 'starts when ' + r.startWhen].filter(Boolean).join(' · '),
          activeAgents(item).length, (item?.flags || []).filter(flag => BOARD_MARKS[flag])];
        });
        show(runs, rs.length > 0);
        const rsig = JSON.stringify(rs);
        if (rsig !== runSig) {
          runSig = rsig;
          runs.replaceChildren(...rs.map(([id, state, summary, active, flags]) => {
            const tag = h('button', { type: 'button', class: 'chip', 'data-tip': summary, 'data-id': id,
              'aria-controls': detailId, 'aria-expanded': String(selected === id), on: { click: () => select(id) } });
            const [gl, wd, c] = STATUS[state] || STATUS.unknown;
            tag.append(h('span', { class: 'c-' + (c === 'dim' ? 'dim' : c), style: 'display:flex' }, glyph(gl)), `${id} · ${wd}`);
            if (active) tag.append(h('span', { class: 'c-arc', text: active + ' active' }));
            for (const flag of flags) tag.append(h('span', { class: 'c-amber', 'aria-label': BOARD_MARKS[flag][0], text: BOARD_MARKS[flag][1] }));
            return tag;
          }));
        }
        drawDetail();
        const last = (p.lastLog || []).filter(l => /^\d{4}-\d\d-\d\d/.test(l)).pop() || (p.lastLog || []).slice(-1)[0];
        show(log, !!last); txt(log, last || ''); setData(log, 'tip', last || null);
      },
    };
  }

  const QUEUE_LABELS = { need: 'Needs you', flight: 'In flight', ready: 'Ready', accept: 'To accept', drift: 'Drift' };
  const QUEUE_EMPTY = { need: 'No owner inputs waiting', flight: 'No items in flight', ready: 'No items ready to start',
    accept: 'No items waiting for acceptance', drift: 'No board drift' };
  function queueRows(st, plans, labelOf) {
    const board = st.board || {}, rows = { need: [], flight: [], ready: [], accept: [], drift: [] };
    const roots = new Map((st.projects || []).map(p => [p.project, p.root]));
    const nodes = new Map();
    for (const [key, p] of plans) {
      const folder = p.path?.split(/[\\/]docs[\\/]plans[\\/]/i)[0];
      const root = folder && folder !== p.path ? folder : roots.get(p.project);
      for (const n of [...(p.phases || []), ...(p.runs || [])]) {
        nodes.set(`${key}#${n.id}`, { id: n.id, project: p.project, plan: p.title || p.slug, slug: p.slug, title: n.name,
          model: [n.model, n.effort].filter(Boolean).join(' / '), folder: root });
      }
    }
    for (const [key, entries] of [['need', board.ownerInputs], ['ready', board.ready], ['accept', board.awaiting]]) {
      for (const entry of entries || []) {
        const row = nodes.get(`${entry.plan}#${entry.id}`);
        if (row) rows[key].push({ ...row, note: entry.unlocks?.length ? 'Unlocks ' + entry.unlocks.join(', ') : null });
      }
    }
    for (const [key, item] of Object.entries(board.items || {})) {
      const row = nodes.get(key);
      if (!row) continue;
      const agents = activeAgents(item);
      if (agents.length) rows.flight.push({ ...row, agents: agents.map(a => ({ ...a, label: labelOf(a) })) });
      const flags = (item.flags || []).filter(flag => BOARD_MARKS[flag]);
      if (flags.length) rows.drift.push({ ...row, note: flags.map(flag => BOARD_MARKS[flag][0]).join(' · ') });
    }
    return rows;
  }

  let queueId = 0;
  function workQueue(api = {}) {
    const id = 'work-queue-' + ++queueId;
    const list = h('div', { id, class: 'wq-list', role: 'region', hidden: true });
    const counts = h('div', { class: 'wq-counts' });
    const el = h('section', { class: 'work-queue', 'aria-label': 'Work queue' }, counts, list);
    const buttons = new Map();
    let current = null, rows = {}, listSig = '';
    for (const [key, label] of Object.entries(QUEUE_LABELS)) {
      const total = h('b', { text: 0 });
      const button = h('button', { class: 'wq-count', type: 'button', 'data-queue': key,
        'aria-controls': id, 'aria-expanded': 'false' }, total, h('span', { class: 'label', text: label }));
      button.addEventListener('click', () => { current = current === key ? null : key; draw(); api.layout?.(); });
      buttons.set(key, { button, total }); counts.append(button);
    }
    function copyAction(row) {
      const prompt = `Do ${row.slug}/${row.id}. Follow the workflow-run skill.`;
      const button = h('button', { class: 'btn wq-button', type: 'button', 'aria-label': 'Copy kickoff for ' + row.id, text: 'Copy' });
      const input = h('input', { type: 'text', readonly: true, value: prompt, 'aria-label': 'Kickoff prompt', hidden: true });
      const status = h('span', { role: 'status', class: 'wq-copy-status' });
      button.addEventListener('click', async () => {
        txt(status, '');
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(prompt);
            show(input, false); txt(status, 'Copied'); return;
          }
        } catch {} // Plain HTTP, denied permission, or unavailable clipboard.
        show(input, true); input.focus(); input.select();
        let copied = false;
        try { copied = doc.execCommand('copy'); } catch {}
        if (copied) { button.focus(); show(input, false); }
        txt(status, copied ? 'Copied' : 'Press Ctrl+C');
        api.layout?.();
      });
      return { button, details: h('div', { class: 'wq-copy' }, input, status) };
    }
    function entry(row) {
      const copy = current === 'ready' ? copyAction(row) : null;
      return h('li', { class: 'wq-row' },
        h('div', { class: 'wq-row-main' },
          h('div', { class: 'wq-meta', text: row.project + ' · ' + row.plan }),
          h('div', {}, h('b', { text: row.id }), row.title ? ' · ' + row.title : ''),
          row.model ? h('div', { class: 'wq-meta', text: row.model }) : null,
          row.note ? h('div', { class: current === 'drift' ? 'wq-meta c-amber' : 'wq-meta', text: row.note }) : null,
          copy && row.folder ? h('div', { class: 'wq-folder mono', text: row.folder }) : null),
        copy?.button,
        row.agents?.length ? h('div', { class: 'wq-actions' }, row.agents.map(a =>
          h('button', { type: 'button', class: 'btn plan-agent wq-button', text: a.label, on: { click: () => api.jump?.(a.sessionId, a.agentId) } }))) : null,
        copy?.details);
    }
    function draw() {
      for (const [key, { button, total }] of buttons) {
        const count = rows[key]?.length || 0;
        txt(total, count); setData(button, 'live', count ? key : null);
        setAttr(button, 'aria-expanded', String(current === key));
      }
      show(list, !!current);
      const entries = rows[current] || [], sig = JSON.stringify([current, entries]);
      if (listSig === sig) return;
      listSig = sig;
      setAttr(list, 'aria-label', QUEUE_LABELS[current]);
      if (current) list.replaceChildren(entries.length ? h('ul', { class: 'wq-rows' }, entries.map(entry)) :
        h('p', { class: 'wq-empty', text: QUEUE_EMPTY[current] }));
      else list.replaceChildren();
    }
    return { el, update(next, open = current) { rows = next; current = open; draw(); } };
  }

  function quietBoards(toggle) {
    const list = h('div', { class: 'plans', hidden: true });
    const button = h('button', { class: 'quiet-toggle label', type: 'button', 'aria-expanded': 'false',
      on: { click: () => toggle() } });
    const el = h('div', { class: 'quiet-boards', hidden: true }, button, list);
    return { el, list, update(count, expanded) {
      show(el, count > 0); show(list, expanded && count > 0);
      txt(button, `${expanded ? '−' : '+'}${count} quiet ${count === 1 ? 'board' : 'boards'}`);
      setAttr(button, 'aria-expanded', String(expanded && count > 0));
    } };
  }

  // ---- needs-you banners ------------------------------------------------------------------------------------------------------
  function banners(api = {}, summary = null) {
    const list = h('div', { style: 'display:contents' });
    const more = h('button', { class: 'ban-more label', type: 'button', hidden: true });
    const warnings = h('div', { class: 'warnings', role: 'group', 'aria-label': 'Warnings', hidden: true });
    const el = h('div', { class: 'banners', role: 'region', 'aria-label': 'HUD alerts', 'aria-live': 'polite', hidden: true }, list, more, warnings, summary);
    const rows = new Map(), dismissed = new Set();
    const warningRows = new Map(), dismissedWarnings = new Set();
    let expanded = false, last = [], latestWarnings = [], hasWaiting = false;
    const visibility = () => show(el, hasWaiting || !warnings.hidden || (summary && !summary.hidden));
    more.addEventListener('click', e => { e.stopPropagation(); expanded = !expanded; updateWaiting(last); });
    function row(x) {
      const rl = h('span', { class: 'ban-rl' }), rs = h('span', { class: 'ban-rs' });   // the reason, and its short form for narrow screens
      const p = h('span', { class: 'ban-p label' }), t = h('span', { class: 'ban-t trunc' }), r = h('span', { class: 'ban-r' }, rl, rs), tm = h('span', { class: 'ban-tm' });
      const x1 = h('button', { class: 'ban-x', type: 'button', 'aria-label': 'Dismiss', 'data-tip': 'Dismiss until it asks again' }, icon('close'));
      const e = h('div', { class: 'ban cutbox', role: 'button', tabindex: '0' }, h('span', { class: 'ban-w label' }, glyph('needs'), h('span', { text: 'Needs you' })), p, t, r, tm, x1);
      let cur = x;
      x1.addEventListener('click', ev => { ev.stopPropagation(); dismissed.add(cur.id + ':' + cur.needsYou.since); update(last); });
      const go = () => api.jump?.(cur.id);
      e.addEventListener('click', go);
      e.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
      return { el: e, set(y) { cur = y; txt(p, y.project || ''); setData(p, 'tip', y.project || null); p.dataset.tipIf = 'trunc'; txt(t, y.title || y.name || 'Untitled session'); t.dataset.tip = y.title || y.name || ''; t.dataset.tipIf = 'trunc'; txt(rl, y.needsYou.reason); txt(rs, shortReason(y.needsYou.reason)); since(tm, y.needsYou.since); setAttr(e, 'aria-label', `${y.project}: ${y.needsYou.reason}. Go to the session.`); } };
    }
    function updateWaiting(sessions) {
      last = sessions;
      const waiting = sessions.filter(x => x.status === 'needs-you' && x.needsYou && !dismissed.has(x.id + ':' + x.needsYou.since)).sort((a, b) => a.needsYou.since - b.needsYou.since);
      const shown = expanded ? waiting : waiting.slice(0, 1);
      reconcile(list, rows, shown, x => x.id, row, (r, x) => r.set(x), !motion.rm);
      hasWaiting = waiting.length > 0;
      visibility();
      show(more, waiting.length > 1);
      txt(more, expanded ? 'Fewer' : `+${waiting.length - 1} more`);
      setAttr(more, 'aria-label', expanded ? 'Show only the longest-waiting session' : `Show all ${waiting.length} waiting sessions`);
      const first = list.firstElementChild;
      if (first && more.parentElement !== first) first.querySelector('.ban-tm').before(more);
      if (!first && more.parentElement !== el) warnings.before(more);
    }
    function warningRow(alert) {
      let current = alert;
      const project = h('span', { class: 'warning-project label trunc', 'data-tip-if': 'trunc' });
      const reason = alert.sessionId && api.jump
        ? h('button', { class: 'warning-text', type: 'button', on: { click: () => api.jump(current.sessionId, current.agentId) } })
        : h('span', { class: 'warning-text' });
      const close = h('button', { class: 'ban-x', type: 'button', on: { click: () => {
        dismissedWarnings.add(current.id);
        updateWarnings(latestWarnings);
      } } }, icon('close'));
      const row = h('div', { class: 'warning', 'data-kind': alert.kind, 'data-alert-id': alert.id },
        h('span', { class: 'warning-label label' }, icon('alert'), h('span', { text: 'Warning' })), project, reason, close);
      return { el: row, set(next) {
        current = next;
        const name = next.project || (next.sessionId ? 'Session' : 'Claude account');
        txt(project, name); setData(project, 'tip', name);
        txt(reason, next.text);
        setAttr(close, 'aria-label', 'Dismiss warning: ' + next.text);
      } };
    }
    function updateWarnings(alerts) {
      latestWarnings = alerts;
      const ids = new Set(alerts.map(a => a.id));
      for (const id of dismissedWarnings) if (!ids.has(id)) dismissedWarnings.delete(id);
      const visible = alerts.filter(a => !dismissedWarnings.has(a.id));
      reconcile(warnings, warningRows, visible, a => a.id, warningRow, (row, a) => row.set(a));
      show(warnings, visible.length > 0);
      visibility();
    }
    return { el, visibility, update(sessions, alerts = []) { updateWaiting(sessions); updateWarnings(alerts); } };
  }

  function awaySummary(onChange = () => {}) {
    const metrics = [['turn-finished', 'turn finished', 'turns finished'], ['agent-done', 'agent done', 'agents done'],
      ['item-changed', 'item changed', 'items changed'], ['needs-you', 'needs-you event', 'needs-you events']];
    const counts = h('ul', { class: 'away-counts' }), needs = h('ul', { class: 'away-needs', 'aria-label': 'Needs-you events while away' });
    const title = h('h2', { class: 'label', text: 'While you were away' });
    const close = h('button', { class: 'ban-x', type: 'button', 'aria-label': 'Dismiss away summary',
      on: { click: () => { show(el, false); onChange(); } } }, icon('close'));
    const el = h('section', { class: 'away-summary', hidden: true }, h('div', { class: 'away-head' }, title, close), counts, needs);
    return { el, update(feed, since) {
      const totals = new Map(metrics.map(([key]) => [key, 0])), waiting = [];
      for (const f of feed) {
        if (f.at < since) continue;
        const key = f.kind === 'needs-you' ? f.kind : f.action;
        if (totals.has(key)) totals.set(key, totals.get(key) + 1);
        if (key === 'needs-you') waiting.push(h('li', {}, f.project ? h('b', { text: f.project + ' · ' }) : null, f.text));
      }
      counts.replaceChildren(...metrics.map(([key, one, many]) => {
        const n = totals.get(key);
        return h('li', {}, h('b', { 'data-action': key, text: n }), ' ' + (n === 1 ? one : many));
      }));
      needs.replaceChildren(...waiting);
      show(needs, waiting.length > 0);
      show(el, true); onChange();
    } };
  }

  // ---- ticker -------------------------------------------------------------------------------------------------------------------
  const FEED_TAGS = { tool: 'Tool', agent: 'Agent', 'needs-you': 'Needs you', done: 'Done', plan: 'Plan', session: 'Session' };
  function ticker(panelEl, header, api = {}) {
    const list = h('ol', { class: 'tk-list-in' });
    const clip = h('div', { class: 'tk-list', 'aria-live': 'polite', 'aria-relevant': 'additions' }, list);
    const newest = h('span', { class: 'tk-new trunc' }), paused = h('span', { class: 'chip warn', hidden: true });
    const ldText = h('span', { class: 'trunc', text: 'Nothing has finished yet', 'data-tip': 'Nothing has finished yet', 'data-tip-if': 'trunc' }), ldAgo = h('span', { class: 'mono' });
    const lastDone = h('span', { class: 'tk-last' }, h('span', { class: 'tk-tag', 'data-k': 'done', style: 'padding:0 8px', text: 'Last done' }), ldText, ldAgo);
    let doneAt = -1;
    const btn = h('button', { class: 'tgl tk-collapse', type: 'button', 'aria-expanded': 'true', 'aria-label': 'Collapse the feed', 'data-tip': 'Collapse the feed' }, icon('chevron'));
    header.append(newest, lastDone, paused, btn);
    let hovered = false, queue = [], project = null, lastFinish = null;
    const history = new Map();
    const key = f => JSON.stringify([f.at, f.sessionId, f.project, f.kind, f.text]);
    const matches = f => f && (!project || f.project === project);
    let collapsed = prefs.get('tickerCollapsed', false);
    function setCollapsed(v) {
      collapsed = v; prefs.set('tickerCollapsed', v); panelEl.classList.toggle('collapsed', v);
      btn.setAttribute('aria-expanded', String(!v)); const l = v ? 'Expand the feed' : 'Collapse the feed'; btn.setAttribute('aria-label', l); btn.dataset.tip = l;
    }
    setCollapsed(collapsed);
    btn.addEventListener('click', () => setCollapsed(!collapsed));
    clip.addEventListener('pointerenter', () => { hovered = true; });
    clip.addEventListener('pointerleave', () => { hovered = false; const q = queue; queue = []; show(paused, false); q.forEach(f => insert(f, false)); });
    function line(f) {
      const k = FEED_TAGS[f.kind] ? f.kind : 'session';
      const proj = projectLabel(api, 'tk-proj trunc');
      proj.set(f.project);
      const li = h('li', { class: 'tk', 'data-project': f.project }, h('span', { class: 'tk-time', text: fmtClock(f.at) }),
        h('span', { class: 'tk-tag', 'data-k': k, text: FEED_TAGS[k] }), h('span', { class: 'tk-project' }, proj.el),
        h('span', { class: 'tk-text trunc', text: f.text, 'data-tip': f.text, 'data-tip-if': 'trunc' }));
      li._f = f;
      return li;
    }
    function setNewest(f) {
      if (!f) { txt(newest, 'No feed events'); return; }
      const proj = projectLabel(api, 'tk-proj trunc');
      proj.set(f.project); show(proj.el, !!f.project);
      newest.replaceChildren(h('span', { class: 'tk-tag', 'data-k': FEED_TAGS[f.kind] ? f.kind : 'session', style: 'padding:0 8px', text: FEED_TAGS[f.kind] || 'Session' }),
        proj.el, h('span', { class: 'trunc', text: f.text }));
    }
    function noteDone(f) {   // the newest finish stays in the header, so "what just finished" survives a busy feed
      if (!matches(f) || f.kind !== 'done' || f.at <= doneAt) return;
      doneAt = f.at;
      const t = `${f.project || ''} · ${f.text}`; txt(ldText, t); ldText.dataset.tip = t;
      age(ldAgo, f.at, '', ' ago');
    }
    function insert(f, animate = true) {
      noteDone(f);
      const top = list.firstElementChild;
      if (f.kind === 'tool' && top?._f?.kind === 'tool' && top._f.sessionId && top._f.sessionId === f.sessionId && top._f.project === f.project) {
        top._n = (top._n || 1) + 1; top._f = f;   // the same session's next tool: update the line, count it
        top.querySelector('.tk-time').textContent = fmtClock(f.at);
        const tx = top.querySelector('.tk-text'); tx.textContent = f.text; tx.dataset.tip = f.text;
        let n = top.querySelector('.tk-n'); if (!n) { n = h('span', { class: 'tk-n' }); top.querySelector('.tk-project').append(n); }
        n.textContent = '×' + top._n;
        setNewest(f);
        return;
      }
      const li = line(f);
      list.prepend(li);
      while (list.children.length > 40) list.lastElementChild.remove();
      setNewest(f);
      if (animate && !motion.rm && !collapsed) { list.animate([{ transform: 'translateY(-24px)' }, { transform: 'none' }], { duration: 300, easing: EASE }); li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 }); }
    }
    function redraw(feed = [...history.values()].reverse()) {
      const visible = feed.filter(matches);
      queue = []; show(paused, false); hovered = false;
      list.replaceChildren(...visible.slice(0, 40).map(line));
      setNewest(visible[0]);
      doneAt = -1;
      txt(ldText, 'Nothing has finished yet'); ldText.dataset.tip = ldText.textContent;
      age(ldAgo, null);
      noteDone(visible.find(f => f.kind === 'done'));
      noteDone(lastFinish);
    }
    return {
      el: clip,
      focus(name) { if (project !== name) { project = name; redraw(); } },
      add(f) {
        const k = key(f);
        if (history.has(k)) return;
        history.set(k, f);
        if (history.size > 200) history.delete(history.keys().next().value);
        if (!matches(f)) return;
        if (hovered) { queue.push(f); show(paused, true); txt(paused, `Paused · ${queue.length} new`); return; }
        insert(f);
      },
      sync(feed) {   // merge the snapshot's history with events already delivered by the stream
        if (!feed.some(f => !history.has(key(f)))) return;
        const merged = new Map(feed.map(f => [key(f), f]));
        for (const [k, f] of history) if (!merged.has(k)) merged.set(k, f);
        const lines = [...merged.values()].sort((a, b) => b.at - a.at).slice(0, 200);
        history.clear();
        for (const f of lines.slice().reverse()) history.set(key(f), f);
        redraw(lines);
      },
      done(f) { lastFinish = f; noteDone(f); },   // a completion known from the state, even after it leaves the feed
      type(text) {   // "SYSTEMS ONLINE" types into the ticker during boot
        if (project) return;
        const tx = h('span', { class: 'tk-text' });
        const li = h('li', { class: 'tk type' }, h('span', { class: 'tk-time', text: fmtClock(now()) }), h('span', { class: 'tk-tag', 'data-k': 'session', text: 'HUD' }), h('span', { class: 'tk-proj', text: 'Claude HUD' }), tx);
        list.prepend(li);
        let i = 0; const tm = setInterval(() => { txt(tx, text.slice(0, ++i)); if (i >= text.length) clearInterval(tm); }, 40);
      },
    };
  }

  // ---- sound, voice, notifications (D5, D6) --------------------------------------------------------------------------------
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
    return { ensure, play, kinds: Object.keys(TONES) };
  })();
  const voice = (() => {
    const q = [], synth = window.speechSynthesis;
    let last = 0, timer = 0, chosen = null;
    function pick() {
      if (chosen || !synth) return chosen;
      const vs = synth.getVoices();
      // Neural voices ("Online (Natural)" in Edge, "Google UK English" in Chrome) sound far less robotic than the local ones.
      for (const re of [/Natural.*(Ryan|Sonia|Thomas|Libby|Guy|Davis|Brian|Andrew|Jenny|Aria)/i, /Natural/i, /Online/i]) { const v = vs.find(v => re.test(v.name) && /^en/i.test(v.lang)); if (v) return chosen = v; }
      for (const re of [/Ryan/i, /George/i, /Daniel/i, /UK English Male/i, /Thomas/i, /Brian/i, /Arthur/i]) { const v = vs.find(v => re.test(v.name) && /^en/i.test(v.lang)); if (v) return chosen = v; }
      return chosen = vs.find(v => /en-GB/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null;
    }
    function pump() {
      if (timer || !q.length || !synth) return;
      const wait = Math.max(0, last + 4000 - Date.now());
      if (wait || synth.speaking) { timer = setTimeout(() => { timer = 0; pump(); }, Math.max(wait, 300)); return; }
      const u = new SpeechSynthesisUtterance(q.shift()), v = pick();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = 1; u.pitch = 1; u.volume = 0.9; u.onend = () => pump();
      last = Date.now(); synth.speak(u);
    }
    if (synth && synth.addEventListener) synth.addEventListener('voiceschanged', () => { chosen = null; });
    return {
      say(text) { if (!synth || q[q.length - 1] === text) return; if (q.length > 4) q.shift(); q.push(text); pump(); },
      get name() { const v = pick(); return v ? v.name : null; },
    };
  })();
  function notify(title, body, tag) {
    if (!prefs.get('notify', false) || !('Notification' in window) || Notification.permission !== 'granted' || !doc.hidden) return false;
    try { new Notification(title, { body, tag, silent: false }); return true; } catch { return false; }
  }
  // What changed between two snapshots, for sound, voice and notifications.
  function happenings(prev, next) {
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
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => { if (prefs.get('voice', false)) voice.say('All agents idle'); if (prefs.get('sound', false)) audio.play('idle'); }, 6000);
        }
      }
      if ((st.totals?.agentsRunning || 0) > 0) { clearTimeout(idleTimer); idleTimer = 0; }
    };
  }

  // ---- shells: panels, toggles, top bar -------------------------------------------------------------------------------------
  function panel(cls, title, opts = {}) {
    const head = h('header', { class: 'ph' }, title ? h('h2', { class: 'pt', text: title }) : null);
    const content = h('div', { class: 'pc' });
    const pb = h('div', { class: 'pb cutbox' }, head, content);
    const el = h('section', { class: 'panel ' + cls, 'aria-label': opts.label || title || null }, pb);
    let err = null;
    return {
      el, head, content, pb,
      guard(fn, retry) {
        try { fn(); if (err) { err.remove(); err = null; } }
        catch (e) {
          console.error(e);
          if (!err) {
            const b = h('button', { class: 'btn', type: 'button' }, 'Retry');
            err = h('div', { class: 'perr', role: 'alert' }, icon('alert'), h('div', { class: 'perr-t', text: 'This panel could not be drawn' }), h('div', { class: 'perr-m trunc', text: String(e && e.message || e).slice(0, 160), 'data-tip': String(e && e.message || e).slice(0, 300), 'data-tip-if': 'trunc' }), b);
            b.addEventListener('click', () => retry && retry());
            pb.append(err);
          }
        }
      },
    };
  }
  // ---- "more below": a panel that scrolls says what is out of sight, and a click brings it up ------------------------
  // describe(hidden elements) returns the summary: states, names. Nothing runs at rest: it repaints (in one animation
  // frame) on scroll, on resize and when the owner calls refresh() after a render.
  function moreBelow(scroller, list, describe) {
    const n = h('span', { class: 'label' }), d = h('span', { class: 'more-d', 'data-tip-if': 'trunc' });
    const el = h('button', { class: 'more', type: 'button', hidden: true }, icon('chevron'), n, d);
    let queued = 0, hidden = [];
    function paint() {
      queued = 0;
      const end = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      const bottom = scroller.getBoundingClientRect().bottom - 32;
      // out of sight: less than about 48 px of it shows above the bar (half, for something smaller)
      hidden = end ? [] : [...list.children].filter(e => {
        if (e === el || e.hidden || e.classList.contains('leave')) return false;
        const r = e.getBoundingClientRect();
        return r.height > 0 && bottom - r.top < Math.min(48, r.height / 2);
      });
      show(el, hidden.length > 0);
      if (!hidden.length) return;
      txt(n, `${hidden.length} more below`);
      d.replaceChildren(...describe(hidden).filter(Boolean).flatMap((p, i) => i ? [' · ', p] : [p])); d.dataset.tip = d.textContent;
      setAttr(el, 'aria-label', `${hidden.length} more below${d.textContent ? ': ' + d.textContent : ''}. Show them.`);
    }
    const later = () => { if (!queued) queued = requestAnimationFrame(paint); };
    scroller.addEventListener('scroll', later, { passive: true });
    new ResizeObserver(later).observe(scroller);
    el.addEventListener('click', () => {
      const first = hidden.find(e => e.isConnected);
      if (first) scroller.scrollBy({ top: first.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8, behavior: motion.rm ? 'auto' : 'smooth' });
    });
    return { el, refresh: later };
  }
  // Hidden cards or rows, counted by state ("1 busy · 2 idle"): a word and its colour.
  const COUNT_C = { 'needs-you': 'alert', busy: 'amber', agents: 'agent', idle: 'arc', ended: 'ink2' };
  function stateCounts(els) {
    const c = {}; for (const e of els) c[e.dataset.s] = (c[e.dataset.s] || 0) + 1;
    return Object.keys(COUNT_C).filter(k => c[k]).map(k => h('span', { class: 'c-' + COUNT_C[k], text: `${c[k]} ${STATUS[k][1].toLowerCase()}` }));
  }
  function toggle(name, label, on, onChange) {
    const b = h('button', { class: 'tgl', type: 'button', 'aria-label': label }, icon(name), icon('slash', 'slash'));
    const set = v => { b.setAttribute('aria-pressed', String(!!v)); b.dataset.tip = `${label}: ${v ? 'on' : 'off'}`; };
    set(on);
    b.addEventListener('click', () => onChange(b.getAttribute('aria-pressed') !== 'true', set));
    return { el: b, set };
  }
  function brandMark() {
    return s('svg', { class: 'brand-mark', viewBox: '0 0 28 28', 'aria-hidden': 'true' },
      s('circle', { class: 'bm-o', cx: 14, cy: 14, r: 12.5, 'stroke-width': 1.5, 'stroke-dasharray': '14 5.6' }),
      s('circle', { cx: 14, cy: 14, r: 7, 'stroke-width': 1, opacity: .6 }),
      s('circle', { cx: 14, cy: 14, r: 3, fill: 'var(--arc)', stroke: 'none' }));
  }
  function topBar(api = {}) {
    const sub = h('span', { class: 'brand-sub label' });
    const mini = reactor({ size: 36, mini: true }), miniN = odo();
    const clockT = h('span', { class: 'clock-t mono' }), clockD = h('span', { class: 'clock-d label' }), clockU = h('span', { class: 'clock-u label' });
    const demo = h('span', { class: 'chip demo', hidden: true, 'data-tip': 'Simulated sessions (node hud.mjs --demo)' }, 'Demo');
    const hooks = h('span', { class: 'chip warn', hidden: true, 'data-tip': 'Hooks are missing in a watched Claude Code folder: tool calls arrive late from transcripts, and “needs you” cannot be seen. Restart the HUD, or run node hud.mjs install.' }, 'Hooks off');
    const streamW = h('span', { class: 'label' }), stream = h('div', { class: 'stream', 'data-s': 'connecting', role: 'status' }, h('span', { class: 'stream-dot' }), streamW);
    const fx = toggle('effects', 'Effects', motion.fx, (v, set) => { motion.setFx(v); set(v); });
    const vo = toggle('voice', 'Voice', prefs.get('voice', false), (v, set) => { prefs.set('voice', v); set(v); if (v) voice.say('Voice announcements on'); });
    const so = toggle('sound', 'Sound', prefs.get('sound', false), (v, set) => { prefs.set('sound', v); set(v); if (v) { audio.ensure(); audio.play('done'); } });
    const no = toggle('bell', 'Notifications', prefs.get('notify', false) && 'Notification' in window && Notification.permission === 'granted', async (v, set) => {
      if (!v) { prefs.set('notify', false); set(false); return; }
      if (!('Notification' in window)) { set(false); return; }
      const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      prefs.set('notify', perm === 'granted'); set(perm === 'granted');
      if (perm === 'denied') no.el.dataset.tip = 'Notifications: blocked in the browser settings';
    });
    const el = h('header', { class: 'top' },
      h('div', { class: 'brand' }, brandMark(), h('span', { class: 'wordmark', text: 'HUD' }), sub),
      h('div', { class: 'mini', 'aria-hidden': 'true' }, mini.el, miniN.el),
      h('div', { class: 'clock' }, clockT, clockD, clockU),
      h('div', { class: 'top-chips' }, demo, hooks),
      h('div', { class: 'top-r' }, stream, fx.el, vo.el, so.el, no.el));
    let started = null;
    return {
      el,
      tick() { const t = now(); txt(clockT, fmtClock(t)); txt(clockD, fmtDate(t)); if (started) txt(clockU, 'up ' + fmtAge(t - started)); },
      update(st) {
        txt(sub, 'Claude + Codex · ' + (st.host || 'this PC')); started = st.now - st.uptime;
        show(demo, !!st.demo); show(hooks, !st.demo && st.hooksInstalled === false);
        mini.update(st.sessions || [], st.totals || {}); miniN.set(String(st.totals?.agentsRunning || 0));
        this.tick();
      },
      setStream(sv) { setData(stream, 's', sv); txt(streamW, { live: 'Live', reconnecting: 'Reconnecting', down: 'Down', connecting: 'Connecting' }[sv] || sv); },
      toggles: { fx, vo, so, no },
    };
  }

  // ---- the whole page --------------------------------------------------------------------------------------------------------------
  function createHud(mount, opts = {}) {
    const bg = h('div', { class: 'bg', 'aria-hidden': 'true' }, h('div', { class: 'bg-grid' }), h('div', { class: 'bg-dots' }), h('div', { class: 'bg-dots d2' }), h('div', { class: 'bg-shim' }), h('div', { class: 'bg-vig' }));
    let project = opts.project || null;
    const matches = item => !project || item?.project === project;
    const api = { jump: (id, agentId) => jump(id, agentId),
      showCard: opts.kiosk ? null : id => { setView('cards', true); jump(id); }, open: id => jump(id),
      project: name => { if (name) setProject(project === name ? null : name); }, focused: () => project };
    const away = awaySummary(() => ban.visibility());
    const top = topBar(api), ban = banners(api, away.el);
    const conn = h('div', { class: 'conn', hidden: true, role: 'status' }, h('span', { class: 'label conn-w' }), h('span', { class: 'mono conn-m' }));
    const connRetry = h('button', { type: 'button', text: 'Retry now' }); conn.append(connRetry);
    connRetry.addEventListener('click', () => opts.reconnect && opts.reconnect());

    const rx = panel('p-reactor', null, { label: 'Agents and totals' });
    const react = reactor(), vit = vitals();
    rx.content.append(react.el, vit.el);
    const ex = panel('p-ext', 'Outside Claude Code'); ex.el.hidden = true;
    const exb = externals(); ex.content.append(exb.el);

    const se = panel('p-sess', 'Sessions');
    const seSum = h('span', { class: 'ps trunc' });
    const focusName = h('span', { class: 'trunc' });
    const clearFocus = h('button', { class: 'chip focus-clear', type: 'button', 'data-tip': 'Clear project focus (Escape)', hidden: true,
      on: { click: () => setProject(null) } }, focusName, icon('close'));
    const vCards = h('button', { type: 'button', 'aria-pressed': 'true' }, icon('cards'), 'Cards'), vNet = h('button', { type: 'button', 'aria-pressed': 'false' }, icon('network'), 'Network');
    se.head.append(seSum, clearFocus, h('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, vCards, vNet));
    const cardsBox = h('div', { class: 'cards' }), cardsEmpty = h('div', { class: 'cards-empty', hidden: true }, h('span', { class: 'label', text: 'No active sessions' }), ' · systems nominal');
    const cardsWrap = h('div', {}, cardsEmpty, cardsBox);
    const net = network(api);
    const seMore = moreBelow(se.content, cardsBox, stateCounts);
    se.content.append(cardsWrap, net.el, seMore.el);
    const cards = new Map(), rowsMap = new Map();
    let view = null, autoNet = false, compactMode = null;

    const pl = panel('p-plans', 'Plans');
    const plSum = h('span', { class: 'ps' }); pl.head.append(plSum);
    const plansBox = h('div', { class: 'plans' }), plansEmpty = h('div', { class: 'plans-empty', hidden: true, text: 'No plan boards in the watched projects' });
    const plMore = moreBelow(pl.content, plansBox, els => {
      const k = els.filter(e => e.dataset.need).length;
      return [k ? h('span', { class: 'c-alert', text: `${k} ${k === 1 ? 'needs' : 'need'} you` }) : null, h('span', { class: 'trunc', text: els.map(e => e.dataset.project).join(', ') })];
    });
    const planApi = { ...api, layout: plMore.refresh };
    const queue = workQueue(planApi);
    let showQuiet = prefs.get('quietBoardsExpanded', false);
    const quiet = quietBoards(() => {
      showQuiet = !showQuiet;
      prefs.set('quietBoardsExpanded', showQuiet);
      renderPlans(state);
      plMore.refresh();
    });
    pl.content.append(queue.el, plansEmpty, plansBox, quiet.el, plMore.el);
    const planMap = new Map(), quietMap = new Map();
    let plSig = '';

    const tk = panel('p-tick', 'Feed', { label: 'Live feed' });
    const tick = ticker(tk.el, tk.head, api);
    tk.content.replaceWith(tick.el);

    const colL = h('div', { class: 'col-l' }, rx.el, ex.el);
    const lMore = moreBelow(colL, colL, els => els.map(e => h('span', { text: e.getAttribute('aria-label') })));
    colL.append(lMore.el);
    const main = h('main', { class: 'main' }, colL, se.el, pl.el);
    const app = h('div', { class: 'app' }, top.el, ban.el, main, tk.el);
    mount.append(bg, app, conn, h('div', { class: 'scanlines', 'aria-hidden': 'true' }));

    let state = null, booted = false, exHidden = null, syncedFeed = null;
    const announce = announcer();

    function showFocus() {
      tick.focus(project);
      show(clearFocus, !!project);
      txt(focusName, project);
      setAttr(clearFocus, 'aria-label', project ? `Clear project focus: ${project}` : null);
    }
    function setProject(name) {
      if (project === name) return;
      const active = document.activeElement;
      project = name;
      tip.close();
      showFocus();
      if (state) { renderSessions(state, false); renderPlans(state, false); tick.done(lastFinish(state)); }
      if ((active === clearFocus && !project) || (active && !active.isConnected)) {
        (project ? clearFocus : view === 'network' ? vNet : vCards).focus({ preventScroll: true });
      }
      opts.onProject?.(project);
    }
    showFocus();

    function setView(v, remember) {
      view = v; if (remember) { prefs.set('view', v); urlView = null; }
      vCards.setAttribute('aria-pressed', String(v === 'cards')); vNet.setAttribute('aria-pressed', String(v === 'network'));
      show(cardsWrap, v === 'cards'); show(net.el, v === 'network');
      if (state) renderSessions(state);
    }
    vCards.addEventListener('click', () => setView('cards', true));
    vNet.addEventListener('click', () => setView('network', true));
    let urlView = new URLSearchParams(location.search).get('view');   // ?view=cards|network, until the switch is used
    if (!/^(cards|network)$/.test(urlView || '')) urlView = null;
    function currentView(sessions) {
      if (opts.kiosk) return 'network';
      if (urlView) return urlView;
      if (prefs.get('view', null)) return prefs.get('view');
      if (!autoNet && sessions.some(x => x.status !== 'ended' && (x.subagents || []).length)) autoNet = true;
      const crowdedNarrow = innerWidth < 600 && sessions.filter(x => x.status !== 'ended').length > 8;   // too many nodes for a narrow window: rows read better
      return autoNet && !crowdedNarrow ? 'network' : 'cards';
    }
    function jump(id, agentId) {
      if (!state) return;
      const targetSession = state.sessions.find(x => x.id === id);
      if (targetSession && !matches(targetSession)) setProject(null);
      const behavior = motion.rm ? 'auto' : 'smooth';
      if (view === 'network') {
        if ((agentId && net.pin(agentId)) || net.pin(id)) net.el.scrollIntoView({ behavior, block: 'nearest' });
        return;
      }
      const c = cards.get(id) || rowsMap.get(id); if (!c) return;
      const target = (agentId && c.el.querySelector(`.sub[data-id="${CSS.escape(agentId)}"]`)) || c.el;
      target.scrollIntoView({ behavior, block: 'center' });
      target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 900);
      target.focus({ preventScroll: true });
    }
    function ctxFor(st, live) {
      const firstWaiting = opts.kiosk && live.filter(x => x.status === 'needs-you' && x.needsYou)
        .sort((a, b) => a.needsYou.since - b.needsYou.since)[0];
      return {
        byId: new Map(st.sessions.map(x => [x.id, x])), plans: new Map((st.plans || []).map(p => [boardPlanKey(p), p])), host: st.host,
        project, autoPin: firstWaiting?.id,
        maxTok: Math.max(1, ...live.map(x => headline(x.tokens))), maxCache: Math.max(1, ...live.map(x => x.tokens?.cacheRead || 0)),
      };
    }
    function renderSessions(st, animate = booted) {
      se.guard(() => {
        const sessions = st.sessions.filter(matches), live = sessions.filter(x => x.status !== 'ended');
        const busy = live.filter(x => x.status === 'busy').length, needs = live.filter(x => x.status === 'needs-you').length;
        txt(seSum, [`${live.length} open`, busy ? `${busy} busy` : null, needs ? `${needs} need you` : null].filter(Boolean).join(' · '));
        view = currentView(sessions);
        vCards.setAttribute('aria-pressed', String(view === 'cards')); vNet.setAttribute('aria-pressed', String(view === 'network'));
        show(cardsWrap, view === 'cards'); show(net.el, view === 'network');
        const c = ctxFor(st, live);
        if (view === 'network') { net.update(sessions, c); seMore.refresh(); return; }
        show(cardsEmpty, live.length === 0);
        const compact = live.length > 8;
        if (compact !== compactMode) { compactMode = compact; cardsBox.classList.toggle('compact', compact); cardsBox.replaceChildren(); cards.clear(); rowsMap.clear(); }
        const rank = { 'needs-you': 0, busy: 1, idle: 2, ended: 3 };
        const list = sessions.sort((a, b) => rank[a.status] - rank[b.status] || (a.startedAt || 0) - (b.startedAt || 0));
        if (compact) reconcile(cardsBox, rowsMap, list, x => x.id, () => compactRow(api), (r, x) => r.update(x, c), animate);
        else reconcile(cardsBox, cards, list, x => x.id, () => sessionCard(api), (r, x) => r.update(x, c), animate);
        seMore.refresh();
      }, () => renderSessions(st));
    }
    function renderPlans(st, animate = booted) {
      pl.guard(() => {
        const plans = (st.plans || []).filter(matches), board = st.board || {};
        const byPlan = new Map(plans.map(p => [boardPlanKey(p), p]));
        const sessions = new Map(st.sessions.map(x => [x.id, x]));
        const nameOf = ({ sessionId, agentId }) => {
          const session = sessions.get(sessionId);
          if (agentId) {
            const agent = session?.subagents?.find(a => a.id === agentId);
            return agent?.description || agent?.type || 'Subagent ' + agentId.slice(0, 8);
          }
          return session?.title || session?.name || session?.project || 'Session ' + sessionId.slice(0, 8);
        };
        const owner = new Set((board.ownerInputs || []).map(item => item.plan));
        const nodes = p => [...(p.phases || []), ...(p.runs || [])];
        const needs = p => p.needsYou?.length || owner.has(boardPlanKey(p)) || nodes(p).some(n => n.state === 'blocked' || n.state === 'bounced');
        const active = p => nodes(p).some(n => n.state === 'in-progress');
        const working = p => board.plans?.[boardPlanKey(p)]?.active || 0;
        const staleBefore = st.now - 14 * 86_400_000;
        const isQuiet = p => {
          const all = nodes(p);
          return (all.length > 0 && all.every(n => DONE_STATES.has(n.state))) ||
            (p.touchedAt > 0 && p.touchedAt <= staleBefore && !working(p) && !needs(p));
        };
        plans.sort((a, b) => (needs(b) ? 1 : 0) - (needs(a) ? 1 : 0) || (working(b) > 0 ? 1 : 0) - (working(a) > 0 ? 1 : 0) || (active(b) ? 1 : 0) - (active(a) ? 1 : 0) || (b.touchedAt || 0) - (a.touchedAt || 0) || a.project.localeCompare(b.project) || (a.title || '').localeCompare(b.title || ''));
        const visible = [], folded = [];
        for (const p of plans) (isQuiet(p) ? folded : visible).push(p);
        queue.update(queueRows(st, byPlan, nameOf));
        show(queue.el, plans.length > 0);
        show(plansEmpty, plans.length === 0);
        quiet.update(folded.length, showQuiet);
        const inProgress = plans.filter(active).length;
        txt(plSum, plans.length ? [`${plans.length}`, inProgress ? `${inProgress} in progress` : null].filter(Boolean).join(' · ') : '');
        const update = (c, p) => c.update(p, board, nameOf);
        reconcile(plansBox, planMap, visible, boardPlanKey, () => planCard(planApi), update, animate);
        reconcile(quiet.list, quietMap, showQuiet ? folded : [], boardPlanKey, () => planCard(planApi), update, false);
        const sig = visible.map(p => boardPlanKey(p) + (needs(p) ? '!' : '')).join();
        if (sig !== plSig) { plSig = sig; plMore.refresh(); }   // the hint only changes with the boards (scroll and resize repaint it too)
      }, () => renderPlans(st));
    }
    // The newest finished subagent in the state: "what just finished" is answered from the first frame, not only once
    // a finish arrives in the feed.
    function lastFinish(st) {
      let best = null;
      for (const x of (st.sessions || []).filter(matches)) for (const a of x.subagents || []) {
        if (a.state === 'done' && a.endedAt && (!best || a.endedAt > best.at)) best = { kind: 'done', at: a.endedAt, project: x.project, text: `Agent done · ${[a.type, a.description].filter(Boolean).join(': ')}` };
      }
      return best;
    }
    function render(st, o = {}) {
      syncClock(st.now);
      const prev = state;
      // A state without plans or feed (the stream's later pushes, PLAN hud-0-3 §4.4) keeps the ones drawn: never clear.
      if (prev && (!st.plans || !st.feed)) st = Object.assign({}, st, { plans: st.plans || prev.plans, feed: st.feed || prev.feed });
      state = st;
      const boot = o.boot || (!booted && root.classList.contains('booting'));
      top.update(st);
      ban.update(st.sessions || [], st.alerts || []);
      rx.guard(() => { react.update(st.sessions || [], st.totals || {}, { boot }); vit.update(st, { boot }); }, () => render(state));
      ex.guard(() => { const has = (st.external || []).length > 0 || !!st.externalError; ex.el.hidden = !has; if (has) exb.update(st.external, st.externalError); }, () => render(state));
      if (ex.el.hidden !== exHidden) { exHidden = ex.el.hidden; lMore.refresh(); }
      renderSessions(st);
      renderPlans(st);
      // The feed is synced once per array: a kept feed put back on a later push is old, and the stream's `event`
      // lines have already gone past it.
      if (st.feed && st.feed !== syncedFeed) { syncedFeed = st.feed; tick.sync(st.feed); }
      tick.done(lastFinish(st));
      if (prev) announce(happenings(prev, st), st);
      booted = true;
    }
    function setConn(sv, info = {}) {
      top.setStream(sv);
      const bad = sv === 'reconnecting' || sv === 'down';
      show(conn, bad); setData(conn, 's', sv);
      app.classList.toggle('stale', bad);
      conn.querySelector('.conn-w').textContent = sv === 'down' ? 'HUD server not answering' : 'Connection lost · reconnecting';
      conn.querySelector('.conn-m').textContent = info.lastAt ? 'last update ' + fmtAge(Date.now() - info.lastAt) + ' ago' : '';
    }
    setInterval(() => { top.tick(); tickTimers(); }, 1000);
    top.tick();
    return { render, feed: f => tick.add(f), setConn, typeLine: t => tick.type(t),
      showAway: away.update, clearProject: () => setProject(null), get state() { return state; } };
  }

  // ---- boot sequence (ambient: skipped with EFFECTS off or reduced motion) -------------------------------------------------
  function boot(hud) {
    if (!motion.ambient) return false;
    root.classList.add('booting');
    const end = () => { root.classList.remove('booting'); removeEventListener('pointerdown', end, true); removeEventListener('keydown', end, true); };
    addEventListener('pointerdown', end, true); addEventListener('keydown', end, true);
    setTimeout(() => hud.typeLine('SYSTEMS ONLINE'), 900);
    setTimeout(end, 1600);
    return true;
  }

  return {
    h, s, txt, icon, glyph, ICONS, GLYPHS, STATUS, statusTag, provBadge, odo, tip, motion, prefs, now, syncClock, tickTimers,
    fmtTok, fmtPct, fmtDur, fmtAge, headline, shortModel, ctxLevel,
    contextMeter, tokenMeter, cacheMeter, activityLine, sessionCard, compactRow, subList, reactor, vitals, externals, network, planCard, planNodeCard, workQueue, quietBoards,
    banners, awaySummary, projectLabel, ticker, panel, toggle, topBar, createHud, boot, audio, voice, happenings, needsPhrase, reconcile, moreBelow, stateCounts, FEED_TAGS,
  };
}

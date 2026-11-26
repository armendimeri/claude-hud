import { hudClient } from './legacy-hud.mjs';

// The component gallery at `/design`: every component in every state, from fixtures (PLAN §6.6).
function designMain(H) {
  'use strict';
  const { h, s, icon, glyph } = H;
  const t = Date.now();
  let seq = 0;
  const uid = p => p + (++seq).toString(16).padStart(6, '0');
  const tok = (output, cacheWrite, input = 120, cacheRead = 0) => ({ input, output, cacheWrite, cacheRead });
  const ctx = (pct, win = 1e6) => pct == null ? null : { used: Math.round(win * pct / 100), window: win, pct };
  const sum = list => list.reduce((a, x) => ({ input: a.input + x.tokens.input, output: a.output + x.tokens.output, cacheWrite: a.cacheWrite + x.tokens.cacheWrite, cacheRead: a.cacheRead + x.tokens.cacheRead }), tok(0, 0, 0, 0));
  function sub(o) {
    return Object.assign({ id: uid('a'), parentId: null, depth: 1, description: 'Map the quotation totals code', type: 'Explore', model: 'claude-haiku-5-5', modelRaw: 'claude-haiku-5-5', provider: 'anthropic',
      state: 'running', background: false, startedAt: t - 48e3, endedAt: null, tokens: tok(3200, 18000, 40, 210000), context: ctx(18), currentTool: { name: 'Grep', summary: 'VatRate in src', since: t - 4e3 } }, o);
  }
  function sess(o) {
    const x = Object.assign({ id: uid('s'), pid: 4242, project: 'FidiaCRM', cwd: '', name: 'fidiacrm-3f', title: 'Quotation wizard: totals, VAT rows and the discount line', entrypoint: 'claude-vscode', version: '2.1.312',
      status: 'busy', needsYou: null, provider: 'anthropic', model: 'claude-opus-5-5', modelRaw: 'claude-opus-5-5', effort: 'high', branch: 'ux/R14-quotation-wizard',
      startedAt: t - 42 * 60e3, lastActivityAt: t - 2e3, endedAt: null, currentTool: { name: 'Bash', summary: 'dotnet test -c Release --no-build --filter Quotation', since: t - 14e3 },
      tools: 48, startedBy: null, tokens: tok(86400, 274500, 222, 21043954), context: ctx(30.5), subagents: [] }, o);
    for (const a of x.subagents) { if (!a.parentId) a.parentId = x.id; a.provider = x.provider; }
    x.tokensTree = sum([x, ...x.subagents]);
    return x;
  }
  function nested(o = {}) {
    const a = sub({ type: 'Explore', description: 'Map the quotation totals code', tokens: tok(9200, 41000, 60, 610000), context: ctx(41) });
    const b = sub({ parentId: a.id, depth: 2, type: 'general-purpose', description: 'Check the VAT rounding rules', model: 'claude-sonnet-5-5', tokens: tok(5400, 26000, 30, 190000), context: ctx(22), startedAt: t - 30e3 });
    const c = sub({ parentId: b.id, depth: 3, type: 'web-fetch', description: 'Read the tax office rounding note', state: 'done', endedAt: t - 9e3, currentTool: null, tokens: tok(800, 9000, 10, 0), context: ctx(6), startedAt: t - 26e3 });
    const d = sub({ type: 'web-fetch', description: 'Read the Syncfusion grid docs', state: 'done', endedAt: t - 60e3, currentTool: null, tokens: tok(1400, 12000), context: ctx(9), startedAt: t - 120e3 });
    return sess(Object.assign({ project: 'WasteManagement2', title: 'Coordinator: customer history plan, phases P2 and P3', branch: 'customer-history', tokens: tok(126000, 291000, 216, 17166585), context: ctx(62), subagents: [a, b, c, d] }, o));
  }
  const host = 'STARK-01';
  const busy = nested();
  const needs = sess({ project: 'FidiaCRM', status: 'needs-you', needsYou: { since: t - 95e3, reason: 'Permission: Bash', kind: 'permission' }, currentTool: { name: 'Bash', summary: 'sqlcmd -S localhost -d WM2 -Q "SELECT COUNT(*) FROM Customers"', since: t - 95e3 }, context: ctx(76) });
  const fresh = sess({ project: 'TourCMS', status: 'idle', currentTool: null, lastActivityAt: t - 12e3, title: 'Booking changes: date and people edits', model: 'claude-sonnet-5-5', effort: 'medium', provider: 'bedrock', modelRaw: 'us.anthropic.claude-sonnet-5-5-v1:0', branch: 'booking-changes', context: ctx(91.5), tokens: tok(40200, 120000, 90, 6400000) });
  const idle = sess({ project: 'ImPOS-Maui', status: 'idle', currentTool: null, lastActivityAt: t - 17 * 60e3, title: 'Receipt printer: retry after paper out', model: 'claude-sonnet-5-5', effort: 'medium', branch: 'main', context: ctx(12), tokens: tok(12000, 64000, 40, 900000), startedBy: busy.id });
  const ended = sess({ project: 'WasteManagement2', status: 'ended', endedAt: t - 3 * 60e3, lastActivityAt: t - 3 * 60e3, currentTool: null, title: 'Say hi', model: 'claude-haiku-5-5', effort: 'low', branch: 'customer-history', tokens: tok(120, 3000, 8, 0), context: ctx(2, 200000), startedBy: busy.id, tools: 0 });
  const long = sess({ project: 'ImPOS-Maui', title: 'Phone app phase 7: battery and Xiaomi autostart switches, runbook for the real-phone pass on the Samsung and the support notes for the shop owners', branch: 'phone-app/xiaomi-autostart-and-battery-whitelist-runbook', model: 'claude-mythos-9-9', modelRaw: 'claude-mythos-9-9', context: null, provider: 'unknown', currentTool: { name: 'mcp__browser__screenshot', summary: 'https://localhost:5001/settings/battery?device=xiaomi-13t-pro&mode=strict', since: t - 3e3 } });
  const waiting = sess({ project: 'TourCMS', status: 'idle', currentTool: null, lastActivityAt: t - 40e3, title: 'Booking changes: waiting on the review agent', model: 'claude-sonnet-5-5', effort: 'medium', branch: 'booking-changes', context: ctx(24), tokens: tok(18000, 52000, 30, 1200000),
    subagents: [sub({ type: 'general-purpose', description: 'Review the date-change edge cases', background: true, startedAt: t - 90e3 })] });
  waiting.agentsRunning = 1;
  const all = [needs, busy, waiting, fresh, idle, ended, long];
  const byId = new Map(all.map(x => [x.id, x]));
  const galleryPlan = { project: 'WasteManagement2', slug: 'customer-history', title: 'Customer change history' };
  const galleryPlanKey = 'WasteManagement2|customer-history', galleryPlans = new Map([[galleryPlanKey, galleryPlan]]);
  busy.work = { plan: galleryPlanKey, items: [{ id: 'P1' }], role: 'coordinator' };
  busy.subagents[0].work = { plan: galleryPlanKey, items: [{ id: 'P2' }], role: 'worker' };
  const cardCtx = { byId, plans: galleryPlans, host, maxTok: Math.max(...all.map(x => H.headline(x.tokens))), maxCache: Math.max(...all.map(x => x.tokens.cacheRead)) };
  const totals = list => {
    const live = list.filter(x => x.status !== 'ended'), subs = live.reduce((n, x) => n + x.subagents.filter(a => a.state === 'running').length, 0);
    return { sessions: live.length, needsYou: live.filter(x => x.status === 'needs-you').length, busy: live.filter(x => x.status === 'busy').length, subagentsRunning: subs,
      agentsRunning: live.filter(x => x.status === 'busy' || x.status === 'needs-you').length + subs, tokensToday: sum(list), plansInProgress: 2, plansNeedingYou: 1 };
  };

  // ---- page frame ----
  const fxT = H.toggle('effects', 'Effects', H.motion.fx, (v, set) => { H.motion.setFx(v); set(v); });
  const rmT = H.toggle('clock', 'Reduced motion preview', H.motion.rm, (v, set) => { H.motion.setRm(v); set(v); });
  const bg = h('div', { class: 'bg', 'aria-hidden': 'true' }, h('div', { class: 'bg-grid' }), h('div', { class: 'bg-dots' }), h('div', { class: 'bg-dots d2' }), h('div', { class: 'bg-shim' }), h('div', { class: 'bg-vig' }));
  const head = h('header', { class: 'top gal-head' },
    h('div', { class: 'brand' }, h('span', { class: 'wordmark', text: 'HUD' }), h('span', { class: 'brand-sub label', text: 'Design system · every component, every state' })),
    h('div', { class: 'top-r', style: 'margin-left:auto' }, (() => { const b = h('button', { class: 'btn', type: 'button', text: 'Replay boot' }); b.addEventListener('click', () => { if (!H.motion.ambient) return; document.documentElement.classList.remove('booting'); void document.body.offsetWidth; document.documentElement.classList.add('booting'); setTimeout(() => document.documentElement.classList.remove('booting'), 1600); }); return b; })(), h('a', { class: 'btn', href: '/', text: 'Open the HUD' }), h('span', { class: 'label c-ink2', text: 'Effects' }), fxT.el, h('span', { class: 'label c-ink2', text: 'Reduced motion' }), rmT.el));
  const gal = h('div', { class: 'gal' }, head);
  document.body.append(bg, gal, h('div', { class: 'scanlines', 'aria-hidden': 'true' }));
  function section(title, note, ...specs) {
    const p = H.panel('gal-sec', title);
    if (note) p.head.append(h('span', { class: 'ps', text: note }));
    p.content.append(h('div', { class: 'specs' }, ...specs));
    gal.append(p.el);
    return p;
  }
  const spec = (label, ...kids) => h('div', { class: 'spec' }, h('div', { class: 'spec-l label', text: label }), ...kids);
  const wide = (label, ...kids) => { const e = spec(label, ...kids); e.classList.add('wide'); return e; };

  // ---- colour, with measured contrast ----
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const over = ([r, g, b, a], [R, G, B]) => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
  const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const VOID = rgb('#04070d'), DEEP = rgb('#08111c'), GLASS = over([16, 34, 52, .55], VOID), CARD = over([8, 17, 28, .62], GLASS), FLOAT = over([8, 17, 28, .94], GLASS);
  const tokens = [['--void', '#04070d', 'Background'], ['--deep', '#08111c', 'Panel base'], ['--glass', 'rgba(16, 34, 52, .55)', 'Panel fill, blurred'], ['--arc', '#29e6ff', 'Live, primary, focus'],
    ['--arc-35', '35%', 'Borders, glows'], ['--arc-15', '15%', 'Fills'], ['--arc-06', '6%', 'Faint washes'], ['--amber', '#ffb547', 'Working, waiting'], ['--alert', '#ff4d5e', 'Needs you, blocked, bounced'],
    ['--ok', '#4dffa6', 'Done, handed off'], ['--agent', '#b28cff', 'Subagents'], ['--ink', '#d6f3ff', 'Text'], ['--ink-2', '68%', 'Secondary text'], ['--ink-3', '42%', 'Labels only']];
  const sw = tokens.map(([n, v, job]) => h('div', { class: 'swatch' }, h('span', { class: 'sw-c', style: `background:var(${n})` }), h('span', { class: 'sw-n mono', text: n }), h('span', { class: 'sw-v mono', text: v }), h('span', { class: 'sw-j', text: job })));
  const texts = [['--ink', [214, 243, 255, 1]], ['--ink-2', [214, 243, 255, .68]], ['--ink-3 (labels)', [214, 243, 255, .42]], ['--arc', [41, 230, 255, 1]], ['--amber', [255, 181, 71, 1]], ['--alert', [255, 77, 94, 1]], ['--ok', [77, 255, 166, 1]], ['--agent', [178, 140, 255, 1]]];
  const bgs = [['void', VOID], ['panel glass', GLASS], ['card', CARD], ['floating', FLOAT]];
  const ctab = h('table', { class: 'ctab mono' }, h('thead', {}, h('tr', {}, h('th', { text: 'text on' }), ...bgs.map(([n]) => h('th', { text: n })))),
    h('tbody', {}, ...texts.map(([n, c]) => h('tr', {}, h('th', { text: n }), ...bgs.map(([, b]) => { const r = ratio(over(c, b), b); return h('td', { class: r >= 4.5 ? 'pass' : r >= 3 ? 'large' : 'fail', text: r.toFixed(2) }); })))));
  section('Colour', 'Each colour has one job. Ratios are computed from the token values over each real background.',
    wide('Tokens', h('div', { class: 'swatches' }, sw)), wide('Contrast (WCAG ratio; body text needs 4.5)', h('div', { class: 'ctab-w' }, ctab)));

  // ---- type ----
  const tline = (fam, size, weight, sample, cls) => h('div', { class: 'tline' }, h('span', { class: 'tl-m mono', text: `${fam} ${size}/${weight}` }), h('span', { class: cls || '', style: `font-family:var(--f-${fam === 'Orbitron' ? 'display' : fam === 'Rajdhani' ? 'label' : fam === 'Inter' ? 'body' : 'mono'});font-size:${size}px;font-weight:${weight};line-height:1.25`, text: sample }));
  section('Type', 'Scale 11 / 13 / 15 / 18 / 24 / 34 / 56. Two weights per family.',
    wide('Display: Orbitron', tline('Orbitron', 56, 700, '12'), tline('Orbitron', 34, 700, 'HUD'), tline('Orbitron', 24, 500, 'SESSIONS'), tline('Orbitron', 18, 700, 'HUD'), tline('Orbitron', 13, 500, 'PANEL TITLE', 'pt')),
    spec('Labels: Rajdhani, uppercase, +0.14em', tline('Rajdhani', 13, 600, 'In progress', 'label-13'), tline('Rajdhani', 11, 600, 'Cache read · Context · Needs you', 'label')),
    spec('Body: Inter', tline('Inter', 15, 600, 'Quotation wizard: totals, VAT rows'), tline('Inter', 13, 400, 'Launched from the shell of the coordinator.')),
    spec('Numbers: JetBrains Mono, tabular', tline('Mono', 24, 400, '1.23M 4,881,203'), tline('Mono', 18, 400, '21:42:07'), tline('Mono', 13, 400, 'dotnet test -c Release'), tline('Mono', 11, 400, 'in 216 · out 126.8k · write 291k')));

  // ---- icons, status, chips, controls ----
  section('Icons and status', 'Icons: 24-unit grid, 1.5 px stroke. Status is always a word, a shape and a colour.',
    spec('Icons', h('div', { class: 'icons' }, Object.keys(H.ICONS).filter(n => n !== 'slash').map(n => h('div', { class: 'icon-c' }, icon(n), h('span', { class: 'mono', text: n }))))),
    spec('Session and subagent states', h('div', { class: 'col' }, ['needs-you', 'busy', 'agents', 'idle', 'ended', 'running', 'done'].map(st => { const g = H.statusTag(); g.set(st, st === 'needs-you' ? '1:35' : st === 'running' ? '0:42' : null); return g.el; }))),
    spec('Plan states', h('div', { class: 'col' }, ['todo', 'in-progress', 'handed-off', 'accepted', 'blocked', 'bounced', 'partial', 'unknown'].map(st => { const g = H.statusTag(); g.set(st); return g.el; }))),
    spec('Chips and badges', h('div', { class: 'row' }, (() => {
      const pa = H.provBadge(), pb = H.provBadge(), pu = H.provBadge(); pa.set('anthropic', 'claude-opus-5-5'); pb.set('bedrock', 'us.anthropic.claude-opus-5-5'); pu.set('unknown');
      return [h('span', { class: 'chip', text: 'opus 5.5 · xhigh' }), h('span', { class: 'chip' }, icon('branch'), h('span', { class: 'trunc', text: 'customer-history' })), pa.el, pb.el, pu.el,
        h('button', { class: 'chip', type: 'button' }, icon('agent'), 'Started by', h('span', { class: 'trunc', text: 'Coordinator' })), h('span', { class: 'chip demo', text: 'Demo' }), h('span', { class: 'chip warn', text: 'Hooks off' }), h('span', { class: 'chip warn', text: 'Delayed' })];
    })())),
    spec('Controls', h('div', { class: 'row' }, (() => {
      const on = H.toggle('voice', 'Voice', true, () => {}), off = H.toggle('voice', 'Voice', false, () => {});
      const seg = h('div', { class: 'seg', style: 'margin:0' }, h('button', { type: 'button', 'aria-pressed': 'true' }, icon('cards'), 'Cards'), h('button', { type: 'button', 'aria-pressed': 'false' }, icon('network'), 'Network'));
      return [on.el, h('span', { class: 'label c-ink2', text: 'on' }), off.el, h('span', { class: 'label c-ink2', text: 'off' }), seg, h('button', { class: 'btn', type: 'button', text: 'Retry' })];
    })())),
    spec('Stream light', h('div', { class: 'col' }, ['live', 'reconnecting', 'down', 'connecting'].map(sv => h('div', { class: 'stream', 'data-s': sv }, h('span', { class: 'stream-dot' }), h('span', { class: 'label', text: { live: 'Live', reconnecting: 'Reconnecting', down: 'Down', connecting: 'Connecting' }[sv] }))))));

  // ---- meters ----
  const cm = [30, 72, 91, 100, null].map(p => { const m = H.contextMeter(); m.set(ctx(p)); return m.el; });
  const tm = H.tokenMeter(); tm.set(busy.tokens, busy.tokensTree, H.headline(busy.tokens) * 1.2);
  const crm = H.cacheMeter(); crm.set(busy.tokens.cacheRead, busy.tokens.cacheRead * 1.3);
  section('Meters', 'Every bar has its number beside it. Context: amber from 70%, red from 90%, “—” when the window is unknown.',
    spec('Context × 4 levels + unknown', h('div', { class: 'meters' }, cm)), spec('Tokens and cache read', h('div', { class: 'meters' }, tm.el, crm.el)));

  // ---- reactor and vitals ----
  const rx = (label, list) => { const r = H.reactor(); r.update(list, totals(list)); return spec(label, r.el); };
  const vit = H.vitals();
  vit.update({ sessions: all, totals: totals(all), plans: [1, 2, 3], account: { fiveHour: { pct: 42, resetsAt: t + 2.4 * 3600e3 }, sevenDay: { pct: 31, resetsAt: t + 3.2 * 86400e3 } } });
  const vitNoAcct = H.vitals(); vitNoAcct.update({ sessions: [], totals: Object.assign(totals([]), { plansInProgress: 0, plansNeedingYou: 0 }), plans: [], account: null });
  section('Reactor and vitals', 'Rings turn and the core beats only with EFFECTS on. Red breathing while anything needs you.',
    rx('Idle', []), rx('Busy', [busy, fresh, idle, long]), rx('Alert: something needs you', all),
    spec('Vitals with account limits', vit.el), spec('Vitals, empty, no account source', vitNoAcct.el));

  // ---- session cards ----
  const card = (label, x) => { const c = H.sessionCard({ jump: () => {} }); c.update(x, cardCtx); return spec(label, h('div', { class: 'cards' }, c.el)); };
  const rows = H.h('div', { class: 'cards compact' });
  for (const x of all) { const r = H.compactRow(); r.update(x, cardCtx); rows.append(r.el); }
  const deep = sess({ project: 'claude-hud', title: 'Folding: deep trees and many finished subagents', subagents: (() => {
    const out = [], a = sub({ type: 'general-purpose', description: 'Level 1' }), b = sub({ parentId: a.id, depth: 2, description: 'Level 2' }), c = sub({ parentId: b.id, depth: 3, description: 'Level 3' }), d = sub({ parentId: c.id, depth: 4, description: 'Level 4, folded' });
    out.push(a, b, c, d);
    for (let i = 0; i < 6; i++) out.push(sub({ type: 'web-fetch', description: `Finished job ${i + 1}`, state: 'done', currentTool: null, endedAt: t - (i + 1) * 60e3, startedAt: t - (i + 2) * 60e3 }));
    return out;
  })() });
  section('Session card', 'Comfortable cards up to 8 live sessions; above that, compact rows switch on by themselves.',
    card('Busy, with a nested subagent tree', busy), card('Needs you', needs), card('Agents working: idle, with a subagent still running', waiting), card('Idle, just finished, on Bedrock, context 92%', fresh), card('Idle, launched from the coordinator’s shell', idle), card('Ended (started by the coordinator)', ended),
    card('Long title, long branch, unknown model and context window', long), card('Subagent folding: depth over 3, more than 4 finished', deep),
    wide('Compact rows (more than 8 sessions)', rows));

  // ---- network ----
  const nets = [];
  const netSpec = (label, list, height, cls, after) => {
    const n = H.network({ showCard: () => {} });
    const box = h('div', { class: 'gal-net' + (cls ? ' ' + cls : ''), style: `height:${height}px` }, n.el);
    nets.push([n, list, after]);
    return [spec(label, box), n, list];
  };
  const dense = [];
  const projects = ['FidiaCRM', 'WasteManagement2', 'ImPOS-Maui', 'TourCMS', 'Aegis', 'fidiagraf.com'], sts = ['needs-you', 'busy', 'busy', 'idle', 'busy', 'idle', 'ended', 'busy'];
  for (let i = 0; i < 24; i++) {
    const st = sts[i % sts.length];
    const subs = st === 'busy' && i % 3 === 1 ? [sub({ tokens: tok(2000 + i * 300, 9000), context: ctx(10 + i) })] : [];
    if (subs.length && i % 2) subs.push(sub({ parentId: subs[0].id, depth: 2, type: 'web-fetch', tokens: tok(900, 4000) }));
    dense.push(sess({ project: projects[i % 6], status: st, needsYou: st === 'needs-you' ? { since: t - 40e3, reason: 'Permission: Edit', kind: 'permission' } : null, currentTool: st === 'busy' ? { name: 'Read', summary: 'Program.cs', since: t - 2e3 } : null,
      title: `Session ${i + 1}`, tokens: tok(4000 + (i * 7919) % 90000, 20000 + (i * 104729) % 300000), context: ctx((i * 37) % 97), endedAt: st === 'ended' ? t - 60e3 : null, provider: i % 7 === 3 ? 'bedrock' : 'anthropic', subagents: subs }));
  }
  const one = sess({ project: 'claude-hud', title: 'HUD phase P2: page and design system', subagents: [] });
  const [n1] = netSpec('One session', [one], 340);
  const [n2] = netSpec('One session with nested subagents (3 levels)', [busy, ended], 420);
  const [n3] = netSpec('24 sessions', dense, 560, 'wide');
  n3.classList.add('wide');
  const nodeSpec = (label, x) => netSpec(label, [x], 220)[0];
  const runSess = sess({ project: 'Demo', title: 'Parent', subagents: [sub({ type: 'Explore', tokens: tok(30000, 80000), context: ctx(50) })] });
  const doneSess = sess({ project: 'Demo', status: 'idle', currentTool: null, title: 'Parent', subagents: [sub({ type: 'Explore', state: 'done', currentTool: null, endedAt: t - 5e3, tokens: tok(30000, 80000), context: ctx(50) })] });
  section('Network: who started whom', 'Hub = this PC. Sessions on the inner ring, grouped by project; subagents outwards, one ring per level. Size = tokens (square root, 3× range), outer ring = context, A / B / O = provider, double line = launched by.',
    n1, n2, n3,
    nodeSpec('Node: running subagent', runSess), nodeSpec('Node: finished subagent', doneSess), nodeSpec('Node: needs you', sess({ project: 'Demo', status: 'needs-you', needsYou: { since: t - 20e3, reason: 'Question for you', kind: 'question' }, title: 'Asks a question' })),
    nodeSpec('Node: context 50%', sess({ project: 'Demo', status: 'idle', currentTool: null, context: ctx(50), title: 'Half full' })), nodeSpec('Node: context 80%', sess({ project: 'Demo', status: 'idle', currentTool: null, context: ctx(80), title: 'Filling up' })),
    nodeSpec('Node: context 95%', sess({ project: 'Demo', status: 'idle', currentTool: null, context: ctx(95), title: 'Nearly full' })),
    nodeSpec('Node: Anthropic', sess({ project: 'Demo', provider: 'anthropic', title: 'Anthropic API' })), nodeSpec('Node: Bedrock', sess({ project: 'Demo', provider: 'bedrock', modelRaw: 'us.anthropic.claude-opus-5-5', title: 'Amazon Bedrock' })),
    nodeSpec('Node: Codex', sess({ project: 'Demo', agent: 'codex', provider: 'openai', model: 'gpt-6-astra', modelRaw: 'gpt-6-astra', title: 'Codex session' })),
    netSpec('Empty', [], 220)[0],
    netSpec('Hover: the path to the hub lights up, the card docks away from it', [nested({ project: 'Demo' })], 360, null, (n, list) => n.hoverDemo(list[0].subagents[1].id))[0],
    netSpec('Pinned: the card stays, with “Show in cards”', [nested({ project: 'Demo' })], 420, null, (n, list) => n.pin(list[0].subagents[0].id))[0],
    netSpec('Launched by: a session started from another session’s shell (double line)', (() => { const a = sess({ project: 'Demo', title: 'Coordinator' }); const b = sess({ project: 'Other', title: 'claude -p "say hi"', status: 'idle', currentTool: null, lastActivityAt: t - 4e3, startedBy: a.id, tokens: tok(400, 6000) }); return [a, b]; })(), 300)[0],
    netSpec('Over 40 nodes: finished subagents fold into a numbered satellite (click to expand)', (() => { const out = []; for (let i = 0; i < 4; i++) { const subs = []; for (let k = 0; k < 11; k++) subs.push(sub({ type: 'web-fetch', description: 'Job ' + k, state: 'done', currentTool: null, endedAt: t - k * 6e4, tokens: tok(800 + k * 90, 4000) })); subs.push(sub({ type: 'Explore', description: 'Still running', tokens: tok(9000, 30000) })); out.push(sess({ project: ['FidiaCRM', 'TourCMS'][i % 2], title: 'Fan-out ' + (i + 1), subagents: subs })); } return out; })(), 420, 'wide')[0]);

  // ---- tooltip card ----
  const tipDemo = h('div', { class: 'tip on gal-static' }, h('div', { class: 'tip-b cutbox' }, H.network().nodeCard({ kind: 'session', id: busy.id, state: 'busy', depth: 0, x: busy })));
  const longTitle = 'Phone app phase 7: battery and Xiaomi autostart switches, runbook for the real-phone pass on the Samsung';
  const truncDemo = h('div', { class: 'col', style: 'max-width:300px' }, h('div', { class: 'card-title trunc', style: 'align-self:stretch', text: longTitle }), h('div', { class: 'tip on gal-static' }, h('div', { class: 'tip-b cutbox' }, h('div', { class: 'tip-t', text: longTitle }))));
  const focusDemo = h('div', { class: 'row' }, h('button', { class: 'tgl focus-demo', type: 'button', 'aria-pressed': 'true', 'aria-label': 'Effects' }, icon('effects')), h('button', { class: 'btn focus-demo', type: 'button', text: 'Retry' }), h('span', { class: 'chip focus-demo', text: 'Started by Coordinator' }), h('span', { class: 'label c-ink2', text: '2 px --arc ring, 2 px offset, on every control' }));
  section('Floating layer', 'Tooltips, the pinned card and the alerts sit above the panels: stronger glow, brighter border.', spec('Node tooltip card', tipDemo),
    spec('Long text truncates; the full text is in a tooltip', truncDemo), spec('Keyboard focus', focusDemo),
    spec('Plan node tooltip', h('div', { class: 'tip on gal-static' }, h('div', { class: 'tip-b cutbox' }, H.planNodeCard({ id: 'P3', name: 'Change requests in the service', agent: 'requests', state: 'in-progress', stateRaw: 'in-progress', since: '2026-10-29', model: 'Opus 5.5', effort: 'high', waitsFor: ['P1'], notes: 'Waits for P1. The service accepts change requests from the portal.' })))));

  // ---- plans ----
  const P = (id, name, agent, state, waitsFor = [], extra = {}) => Object.assign({ id, name, agent, state, stateRaw: state, since: state === 'todo' ? null : '2026-10-29', waitsFor, waitsForOther: [], notes: waitsFor.length ? 'Waits for ' + waitsFor.join(' and ') : null, group: 'Board', kind: 'phase', model: 'Opus 5.5', effort: 'high' }, extra);
  const plan = (o) => Object.assign({ project: 'WasteManagement2', slug: uid('plan'), title: 'Customer change history and change requests', path: 'docs/plans/customer-history/STATUS.md', format: 'standard', size: 'phased', state: 'building', stateDate: null, needsYou: [], runs: [], lastLog: ['2026-10-29 · data · P1 · Handed off: history tables and triggers, 14 tests.'] }, o);
  const pc = (label, p, cls, board) => {
    const c = H.planCard(); const box = h('div', { class: 'plans' }, c.el); const e = spec(label, box);
    if (cls) e.classList.add(cls);
    requestAnimationFrame(() => c.update(p, board, a => a.agentId ? 'History UI subagent' : 'Customer history coordinator'));
    return e;
  };
  const following = plan({ ...galleryPlan, phases: [P('P1', 'Data and history', 'data', 'todo'),
    P('P2', 'History tab and header', 'history-ui', 'in-progress', ['P1']), P('P3', 'Change requests', 'requests', 'in-progress', ['P2'])],
    history: [{ id: 'P2', from: 'todo', to: 'in-progress', sessionId: busy.id, agentId: busy.subagents[0].id, at: t - 180_000 }] });
  const worker = { sessionId: busy.id, agentId: busy.subagents[0].id, active: true, label: 'History UI subagent' };
  const followBoard = { plans: { [galleryPlanKey]: { active: 2 } }, items: {
    [galleryPlanKey + '#P1']: { agents: [{ ...worker, agentId: null }], flags: ['unclaimed'] },
    [galleryPlanKey + '#P2']: { agents: [worker], flags: ['early'] },
    [galleryPlanKey + '#P3']: { agents: [], flags: ['stalled'] },
  } };
  section('Plan graph', 'Laid out from “waits for”; left to right when it fits, top to bottom when not. Edges into a running phase flow.',
    pc('In flight and all three drift marks', following, 'wide', followBoard),
    pc('Node × every state', plan({ title: 'Every state', phases: [P('P1', 'Accepted', 'a', 'accepted'), P('P2', 'Handed off', 'b', 'handed-off', ['P1']), P('P3', 'In progress', 'c', 'in-progress', ['P2']), P('P4', 'Partial', 'd', 'partial', ['P3']), P('P5', 'Blocked', 'e', 'blocked', ['P4']), P('P6', 'Bounced', 'f', 'bounced', ['P5']), P('P7', 'Todo', 'g', 'todo', ['P6']), P('P8', 'Unknown', 'h', 'unknown', ['P7'])] }), 'wide'),
    pc('Phased plan: P1 → (P2 ∥ P3) → P4', plan({ phases: [P('P1', 'Data and history', 'data', 'accepted'), P('P2', 'History tab and header', 'history-ui', 'in-progress', ['P1']), P('P3', 'Change requests in the service', 'requests', 'bounced', ['P1']), P('P4', 'Verification and cleanup', 'verify', 'todo', ['P2', 'P3'])] })),
    pc('Chunk board with runs, an owner input and a question', plan({ project: 'FidiaCRM', title: 'Implementation', format: 'legacy', state: null,
      phases: [P('UX-01', 'Spec, tokens, gates', null, 'done'), P('UX-02', 'Frame and action bars', null, 'done', ['UX-01']), P('UX-03', 'Table system', null, 'done', ['UX-02']), P('UX-10', 'Quotation wizard', null, 'in-progress', ['UX-03']), P('UX-11', 'Quotations', null, 'todo', ['UX-03']), P('UX-12', 'Clients', null, 'todo', ['UX-03', 'O-9']), P('O-9', 'Production column sizes', null, 'todo', [], { kind: 'input', group: 'Owner inputs' }), P('UX-20', 'Sweep and owner review', null, 'todo', ['UX-10', 'UX-11', 'UX-12'])],
      runs: [{ id: 'R14', name: 'Quotation screens', state: 'in-progress', lane: 'A', chunks: ['UX-10', 'UX-11'], startWhen: 'UX-06 done' }, { id: 'R15', name: 'Clients screens', state: 'todo', lane: 'B', chunks: ['UX-12'], startWhen: 'O-9 is in' }],
      needsYou: [{ kind: 'question', id: '3', item: 'UX-12', text: 'Contact names longer than 60 characters: cut them, or widen the column to 120?' }], lastLog: [] })),
    pc('Small plan with an open decision', plan({ project: 'TourCMS', title: 'Booking changes', size: 'small', state: 'approved', stateDate: '2026-10-28', phases: [P('P1', 'Change dates', 'bookings', 'todo'), P('P2', 'Change people', 'bookings', 'todo', ['P1'])], needsYou: [{ kind: 'decision', id: 'D2', text: 'A changed booking keeps its original price unless the tour price went down ★' }], lastLog: [] })));
  const emptyQueue = H.workQueue(), fullQueue = H.workQueue();
  emptyQueue.update({}, 'ready');
  const queueRow = { project: galleryPlan.project, plan: galleryPlan.title, slug: galleryPlan.slug, model: 'Opus 5.5 / high' };
  fullQueue.update({
    need: [{ ...queueRow, id: 'O-1', title: 'Review the refund policy', note: 'Unlocks P6', model: '' }],
    flight: [{ ...queueRow, id: 'P2', title: 'History tab and header', agents: [worker] }],
    ready: [{ ...queueRow, id: 'P4', title: 'Verification and cleanup', folder: 'C:/Users/demo/source/repos/WasteManagement2' }],
    accept: [{ ...queueRow, id: 'P5', title: 'Table system' }],
    drift: [{ ...queueRow, id: 'P3', title: 'Change requests', note: 'Stalled' }],
  }, 'ready');
  const quietPlan = H.planCard();
  let expanded = false;
  const quiet = H.quietBoards(() => {
    expanded = !expanded; quiet.update(1, expanded);
    if (expanded) quietPlan.update(plan({ title: 'Completed migration', phases: [P('P1', 'Move history', 'data', 'accepted')] }));
  });
  quiet.list.append(quietPlan.el); quiet.update(1, expanded);
  section('Work queue and quiet boards', null,
    wide('Work queue with entries · Ready open', fullQueue.el), wide('Empty work queue', emptyQueue.el), spec('Quiet board folded', quiet.el));

  const sampleWarnings = [
    ['context', 'Context reached 80%', needs], ['context', 'Context reached 90%', fresh],
    ['tool', 'Bash running for 10 min', busy], ['subagent', 'Subagent silent for 5 min', waiting, waiting.subagents[0]],
    ['usage', '5-hour usage reached 90%'], ['usage', 'Weekly usage reached 90%'],
  ].map(([kind, text, session, agent], i) => ({ id: `${kind}:spec:${i}`, kind, text, since: t,
    sessionId: session?.id ?? null, agentId: agent?.id ?? null, project: session?.project ?? null }));
  const warningGallery = H.banners();
  warningGallery.el.classList.add('gal-static');
  warningGallery.update([needs], sampleWarnings);
  section('Warnings', null, wide('Context, long-running tool, silent subagent and account limits', warningGallery.el));

  const firstMinute = Math.floor(t / 60000) * 60000 - 29 * 60000;
  const activitySpec = (label, perMin, lastMs) => {
    const line = H.activityLine();
    line.set({ start: firstMinute, perMin }, { lastMs });
    return spec(label, line.el);
  };
  section('Session activity', null,
    activitySpec('Empty', [], null),
    activitySpec('Steady output', Array.from({ length: 30 }, (_, i) => 900 + (i % 4) * 130), 94_000),
    activitySpec('One burst', Array.from({ length: 30 }, (_, i) => i === 23 ? 2400 : 0), 14_000));

  const away = H.awaySummary();
  away.update([
    { at: t, kind: 'needs-you', project: 'FidiaCRM', text: 'Permission: Bash' },
    { at: t - 1000, action: 'agent-done' },
    { at: t - 2000, action: 'turn-finished' },
    { at: t - 3000, action: 'item-changed' },
  ], t - 300_000);
  let focused = 'TourCMS';
  const focus = H.projectLabel({ project: name => { focused = focused ? null : name; focus.set(name); }, focused: () => focused },
    'chip focus-clear', '');
  focus.set('TourCMS');
  const editorCard = H.sessionCard();
  editorCard.update({ ...busy, cwd: 'C:\\Users\\demo\\source\\repos\\Customer Tools' }, cardCtx);
  section('Page extras', null, wide('While you were away', away.el), spec('Project focus', focus.el), spec('VS Code window', editorCard.el));

  const kioskNet = H.network();
  const kioskPreview = h('div', { class: 'kiosk gal-net', style: 'height:440px' }, kioskNet.el);
  section('Kiosk display', null, wide('Automatic pin for the oldest request', kioskPreview),
    spec(null, h('a', { class: 'btn', href: '/?kiosk' }, 'Open kiosk mode')));
  requestAnimationFrame(() => kioskNet.update([needs, idle], { ...cardCtx, host, autoPin: needs.id }));

  // ---- alerts, ticker, externals, states ----
  const b1 = H.banners({}), b4 = H.banners({});
  b1.update([needs]);
  b4.update([needs, sess({ project: 'TourCMS', status: 'needs-you', needsYou: { since: t - 30e3, reason: 'Question for you', kind: 'question' }, title: 'Booking changes' }), sess({ project: 'ImPOS-Maui', status: 'needs-you', needsYou: { since: t - 12e3, reason: 'Plan approval', kind: 'question' }, title: 'Phone app phase 7' }), sess({ project: 'Aegis', status: 'needs-you', needsYou: { since: t - 5e3, reason: 'Waiting for your input', kind: 'input' }, title: 'Rules engine' })]);
  b1.el.classList.add('gal-static'); b4.el.classList.add('gal-static');
  const tkP = H.panel('p-tick', 'Feed'), tkT = H.ticker(tkP.el, tkP.head); tkP.content.replaceWith(tkT.el);
  [['session', 'Session started', 'TourCMS'], ['tool', 'Bash · dotnet test -c Release --no-build', 'FidiaCRM'], ['agent', 'Agent started · Explore: map the quotation totals code', 'WasteManagement2'], ['needs-you', 'Permission: Bash', 'FidiaCRM'], ['done', 'Agent done · web-fetch: read the Syncfusion grid docs', 'WasteManagement2'], ['plan', 'Customer change history: P2 in-progress → handed-off', 'WasteManagement2']]
    .forEach(([kind, text, project], i) => tkT.add({ at: t - (6 - i) * 7000, sessionId: null, project, kind, text }));
  const exP = H.panel('p-ext', 'Outside Claude Code'), exB = H.externals(); exP.content.append(exB.el);
  exB.update([{ source: 'ingest', app: 'invoice-ocr', provider: 'bedrock', model: 'claude-haiku-5-5', modelRaw: 'anthropic.claude-haiku-5-5', tokens: tok(52000, 0, 410000), windowStart: t - 9e6, windowEnd: t, delayed: false },
    { source: 'ingest', app: 'support-bot', provider: 'bedrock', model: 'claude-sonnet-5-5', modelRaw: 'us.anthropic.claude-sonnet-5-5-v1:0', tokens: tok(120000, 0, 980000), windowStart: t - 9e6, windowEnd: t, delayed: false },
    { source: 'cloudwatch', app: null, provider: 'bedrock', model: 'claude-sonnet-5-5', modelRaw: 'us.anthropic.claude-sonnet-5-5-v1:0', tokens: tok(400000, 0, 3100000), windowStart: t - 9e6, windowEnd: t - 3e5, delayed: true }], 'CloudWatch: aws CLI not found');
  const moreP = H.panel('p-sess', 'Sessions'), moreBox = h('div', { class: 'cards' }), moreH = H.moreBelow(moreP.content, moreBox, H.stateCounts);
  moreP.el.style.height = '320px'; moreP.content.style.overflow = 'auto'; moreP.content.append(moreBox, moreH.el);   // gallery panels don't scroll; this one must
  for (const x of [fresh, idle, ended]) { const c = H.sessionCard({ jump: () => {} }); c.update(x, cardCtx); moreBox.append(c.el); }
  const errP = H.panel('p-plans', 'Plans'); errP.el.style.flex = '1'; errP.guard(() => { throw new Error('Cannot read properties of undefined (reading \'phases\')'); }, () => {});
  const emptyP = H.panel('p-sess', 'Sessions'); emptyP.content.append(h('div', { class: 'cards-empty' }, h('span', { class: 'label', text: 'No active sessions' }), ' · systems nominal'));
  const conn = h('div', { class: 'conn gal-static', 'data-s': 'reconnecting' }, h('span', { class: 'label', text: 'Connection lost · reconnecting' }), h('span', { class: 'mono', text: 'last update 12s ago' }), h('button', { type: 'button', text: 'Retry now' }));
  const connDown = h('div', { class: 'conn gal-static', 'data-s': 'down' }, h('span', { class: 'label', text: 'HUD server not answering' }), h('span', { class: 'mono', text: 'last update 41s ago' }), h('button', { type: 'button', text: 'Retry now' }));
  const topB = H.topBar(); topB.update({ host, demo: false, hooksInstalled: false, now: t, uptime: 2 * 3600e3 + 14 * 60e3, sessions: all, totals: totals(all) }); topB.setStream('live');
  section('Alerts, feed, externals, page states', null,
    wide('Top bar (hooks not installed)', h('div', { class: 'gal-topbar' }, topB.el)),
    wide('Needs-you banner: one', b1.el), wide('Needs-you banner: several stack, with a count', b4.el),
    wide('Ticker', tkP.el), spec('Feed tags', h('div', { class: 'row' }, ...Object.entries(H.FEED_TAGS).map(([k, w]) => h('span', { class: 'tk-tag', 'data-k': k, style: 'padding:0 8px', text: w })))),
    spec('More below: a panel that scrolls says what it hides; a click brings it up', moreP.el), spec('Externals panel (D12 on)', exP.el),
    spec('Empty', emptyP.el), spec('Error in one panel, with retry', h('div', { style: 'height:220px;display:flex' }, errP.el)),
    wide('Reconnecting, then down: the last state stays, dimmed', h('div', { class: 'col' }, conn, connDown, (() => { const c = H.sessionCard(); c.update(busy, cardCtx); return h('div', { class: 'stale', style: 'width:100%' }, h('div', { class: 'main gal-main' }, h('div', { class: 'cards' }, c.el))); })())));

  // ---- render the networks once they have a size; then keep the fixtures alive so the motion can be reviewed ----
  const netCtx = { byId: new Map([...all, ...dense, one].map(x => [x.id, x])), plans: galleryPlans, host, maxTok: 1, maxCache: 1 };
  requestAnimationFrame(() => nets.forEach(([n, list, after]) => { n.update(list, netCtx); if (after) after(n, list); }));
  let tickN = 0;
  setInterval(() => {
    tickN++;
    for (const x of [busy, one, ...dense]) if (x.status === 'busy') { x.tokens.output += 400; x.tokens.cacheWrite += 1200; if (tickN % 2 === 0) x.currentTool = { name: ['Read', 'Edit', 'Bash', 'Grep'][tickN % 4], summary: 'src/Quotations/QuotationTotals.cs', since: Date.now() }; }
    for (const a of busy.subagents) if (a.state === 'running') { a.tokens.output += 300; a.tokens.cacheWrite += 900; if (tickN % 3 === 0) a.currentTool = { name: 'Read', summary: 'Program.cs', since: Date.now() }; }
    if (tickN % 8 === 0) {   // a subagent finishes (return pulse) and another starts
      const run = busy.subagents.filter(a => a.state === 'running' && a.depth > 1).pop() || busy.subagents.find(a => a.state === 'running');
      if (run) { run.state = 'done'; run.endedAt = Date.now(); run.currentTool = null; }
      busy.subagents = busy.subagents.filter(a => a.state === 'running' || Date.now() - (a.endedAt || 0) < 40e3);
      busy.subagents.push(sub({ parentId: busy.subagents[0] ? busy.subagents[0].id : busy.id, depth: busy.subagents[0] ? 2 : 1, type: 'web-fetch', description: 'Fresh job ' + tickN, startedAt: Date.now(), provider: busy.provider }));
    }
    nets.forEach(([n, list]) => n.update(list, netCtx));
    H.tickTimers();
  }, 1500);
}

const H = hudClient();
// Preserve the global client binding used by the browser smoke checks.
Object.defineProperty(globalThis, 'H', { value: H });
designMain(H);

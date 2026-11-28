/* P1-01 frame audit. Runs in the page, writes JSON to #audit. Query flags: ?gray removes colour, ?annot shows callouts. */
(() => {
  const q = new URLSearchParams(location.search);
  if (q.has('gray')) document.documentElement.classList.add('gray');
  if (q.has('annot')) document.documentElement.classList.add('annot');
  const rect = el => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const hit = (a, b, pad = 0) => a.l < b.r + pad && a.r > b.l - pad && a.t < b.b + pad && a.b > b.t - pad;
  const inside = (a, b, tol = 0.5) => a.l >= b.l - tol && a.r <= b.r + tol && a.t >= b.t - tol && a.b <= b.b + tol;
  const sel = (s, root = document) => [...root.querySelectorAll(s)];
  const scale = new Set([11, 13, 15, 18, 24, 34, 56]);

  function run() {
    const out = { frame: document.body.dataset.frame, viewport: [innerWidth, innerHeight], fails: [], info: {} };
    const fail = (rule, detail) => out.fails.push({ rule, detail });

    // 1. no page overflow, and no nowrap text clipped without an ellipsis
    const de = document.documentElement;
    if (de.scrollWidth > innerWidth || de.scrollHeight > innerHeight) fail('page-overflow', [de.scrollWidth, de.scrollHeight]);
    for (const el of sel('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || el.closest('#audit') || el.closest('svg')) continue;
      if (cs.whiteSpace === 'nowrap' && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && cs.overflow !== 'visible')
        fail('clipped-nowrap', el.className + ' ' + (el.textContent || '').slice(0, 40));
      if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && !el.title && !el.dataset.tip) fail('truncated-without-tip', (el.textContent || '').slice(0, 40));
    }
    for (const el of sel('[data-primary]')) {
      const cs = getComputedStyle(el);
      if (el.classList.contains('hit')) continue;
      if (el.scrollWidth > el.clientWidth + 1) fail('control-text-overflow', (el.textContent || '').trim().slice(0, 40));
    }
    for (const box of sel('.strip, .tbar, .attn, .insp .hd, .sheet, .bar-recon, .qcard, .composer')) {
      const br = rect(box);
      for (const ch of box.querySelectorAll('*')) {
        if (ch.closest('svg') && ch.tagName !== 'svg') continue;
        const cs = getComputedStyle(ch);
        if (cs.display === 'none' || cs.position === 'absolute') continue;
        const r = rect(ch);
        if (r.w === 0 || r.h === 0) continue;
        if (r.r > br.r + 1 || r.l < br.l - 1 || r.b > br.b + 1 || r.t < br.t - 1) { fail('child-outside-container', (box.className.toString().split(' ')[0]) + ' > ' + (ch.className.toString() || ch.tagName) + ' ' + (ch.textContent || '').trim().slice(0, 24)); break; }
      }
    }
    // 2. type scale
    const sizes = {};
    for (const el of sel('body *')) {
      if (el.closest('#audit') || el.closest('svg') || el.closest('.badge')) continue;
      const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      const px = parseFloat(cs.fontSize);
      sizes[px] = (sizes[px] || 0) + 1;
      if (!scale.has(px)) fail('type-scale', px + 'px ' + (el.textContent || '').slice(0, 30));
    }
    out.info.fontSizes = sizes;
    // 3. primary targets >= 44 x 44
    const prim = sel('[data-primary]');
    out.info.primaryTargets = prim.length;
    for (const el of prim) {
      const r = rect(el);
      if (r.w < 43.5 || r.h < 43.5) fail('target-size', (el.getAttribute('aria-label') || el.textContent || el.className).trim().slice(0, 40) + ' ' + Math.round(r.w) + 'x' + Math.round(r.h));
    }
    // 4. labels do not overlap each other, other nodes or leave the scene
    const stage = document.querySelector('.stage');
    const labels = sel('.nlabel'), hexes = sel('.node svg.hex');
    out.info.labelled = labels.length;
    out.info.nodes = sel('.node').length;
    if (stage) {
      const sr = rect(stage);
      const lr = labels.map(rect);
      lr.forEach((a, i) => {
        if (!inside(a, sr, 1)) fail('label-outside-scene', labels[i].textContent.slice(0, 30));
        for (let j = i + 1; j < lr.length; j++) if (hit(a, lr[j])) fail('label-overlap', labels[i].textContent.slice(0, 20) + ' / ' + labels[j].textContent.slice(0, 20));
        hexes.forEach(h => { if (!labels[i].parentElement.contains(h) && hit(a, rect(h))) fail('label-over-node', labels[i].textContent.slice(0, 20)); });
      });
      for (const cl of sel('.cl')) { const c = rect(cl); lr.forEach((a, i) => { if (hit(a, c)) fail('label-over-cluster-name', labels[i].textContent.slice(0, 20)); }); }
      // crowded hit targets (information only: the accessible list is the guaranteed 44 px path)
      const centers = sel('.node').map(n => { const r = rect(n.querySelector('.hit')); return [r.l + 22, r.t + 22]; });
      let crowded = 0;
      centers.forEach((a, i) => { for (let j = i + 1; j < centers.length; j++) if (Math.hypot(a[0] - centers[j][0], a[1] - centers[j][1]) < 44) crowded++; });
      out.info.crowdedHitPairs = crowded;
    }
    // 5. selected node is visible in the uncovered scene rectangle
    const selNode = document.querySelector('.node[data-sel] svg.hex');
    const scene = document.querySelector('.scene');
    const insp = document.querySelector('.insp');
    out.info.inspectorMode = document.body.dataset.inspector || 'none';
    if (selNode && scene) {
      const sr = rect(scene.querySelector('.stage') || scene);
      let free = { l: sr.l, t: sr.t, r: sr.r, b: sr.b };
      if (insp && document.body.dataset.inspector === 'overlay') free.r = Math.min(free.r, rect(insp).l);
      if (insp && document.body.dataset.inspector === 'sheet') free.b = Math.min(free.b, rect(insp).t);
      const nr = rect(selNode);
      if (!inside(nr, free)) fail('selected-node-hidden', JSON.stringify(nr));
    }
    if (insp && scene && document.body.dataset.inspector === 'side' && hit(rect(insp), rect(scene))) fail('inspector-overlaps-scene', '');
    // 6. every node has a status word and glyph and an accessible name containing the word
    for (const n of sel('.node')) {
      const word = n.dataset.word, name = n.getAttribute('aria-label') || '';
      if (!word || !name.toLowerCase().includes(word.toLowerCase())) fail('node-name-lacks-status', name);
      if (!n.querySelector('svg.hex .gl, svg.hex .sat')) fail('node-lacks-glyph', name);
    }
    // 7. exit control present and primary
    if (!document.querySelector('[data-role=exit]')) fail('no-exit-control', '');
    if (document.body.dataset.needs !== 'none' && !document.querySelector('[data-role=attention]')) fail('no-attention-row', '');
    // 8. discreet frames carry none of the forbidden strings
    const forbid = JSON.parse(document.body.dataset.forbid || '[]');
    if (forbid.length) {
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll('#audit,script').forEach(e => e.remove());
      clone.querySelector('body').removeAttribute('data-forbid');
      const html = clone.outerHTML.toLowerCase();
      for (const f of forbid) if (html.includes(f.toLowerCase())) fail('discreet-leak', f);
      out.info.forbiddenChecked = forbid.length;
    }
    out.pass = out.fails.length === 0;
    document.getElementById('audit').textContent = JSON.stringify(out);

    // annotation badges
    if (q.has('annot')) {
      for (const el of sel('[data-annot]')) {
        const r = rect(el);
        const b = document.createElement('div');
        b.className = 'badge';
        b.textContent = el.dataset.annot;
        b.style.left = Math.max(2, Math.min(innerWidth - 26, r.l - 11)) + 'px';
        b.style.top = Math.max(2, Math.min(innerHeight - 26, r.t - 11)) + 'px';
        document.body.appendChild(b);
      }
    }
  }
  addEventListener('load', () => setTimeout(run, 50));
})();

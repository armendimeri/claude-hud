// P2-01 round 2: the structured "tactical map" layout. Pure (no DOM, no three.js), so P2-02 can port it into
// src/web/cockpit/layout.mjs and unit-test it in Node. Same input as createLayout().update():
//
//   update({groups: [{key}], entities: [{key, groupKey, parentKey|null, sortKey, kind}]})
//     -> {groups: Map<key, Platform>, nodes: Map<key, Node>, orbit, bounds, issues, first}
//
// World units, y up, +z towards the default camera. The rules (also in handoffs/P2-01.md "Round 2"):
//
//  1. HUB. This PC sits at the origin. Nothing else comes within ORBIT.hubClear of it.
//  2. PROJECTS sit as platforms on one orbit around the hub, evenly spaced. With N projects, project i (in project
//     order) sits at angle θi = π/2 − (i − (N−1)/2)·2π/N, i.e. x = R·cos θ, z = R·sin θ. N = 1 puts the platform straight
//     in front of the hub (balanced left/right), N = 2 puts them left and right, N = 3 makes a triangle with one in front.
//     Project order is first-seen order; newcomers in one update are sorted by key. Positions re-space when the set
//     of projects changes (the scene animates the move); a project's place in the order never changes while it lives.
//  3. ORBIT RADIUS R = max(hubClear + Rmax, (2·Rmax + gap) / (2·sin(π/N))) for N ≥ 2, and hubClear + Rmax for N = 1,
//     where Rmax is the largest platform radius. Neighbouring platforms are therefore at least `gap` apart.
//  4. PLATFORM RADIUS = slotRing[outermost ring in use] + platformPad. Every platform uses the same slot pattern.
//  5. SESSION SLOTS. Root members (sessions and folded "+n idle" chips) take the lowest free slot in their platform,
//     in start order, and keep it while they live (a returning key gets its old slot back when free). Ring k holds
//     slotCap[k] slots; slot j of ring k sits at angle φ = π/2 + order(j)·2π/cap (+ half a step on odd rings) at radius
//     slotRing[k], where order() is a bit-reversal spread so the first slots are far apart (0 = front, 1 = back, ...).
//  6. TIERS. Sessions stand on the platform (tier 0, crystal at tierY[0]). Subagents float on a separate tier above
//     their parent: depth d at y = tierY[min(d, 3)]. A child takes the lowest free child index under its parent and
//     sits on a small circle around the parent's xz: index c of ring k at radius childRing[k], angle π/2 + spread(c)·2π/cap.
//     Folded "+n finished" chips are children too.
//  7. LABELS. A project's name goes outside its platform, on the side away from the hub (rule in holo.mjs).
export const ORBIT = Object.freeze({
  hubClear: 5.2,
  gap: 5,
  slotRing: [3.3, 6.2, 9.1],
  slotCap: [6, 12, 18],
  platformPad: 2.3,
  tierY: [1.7, 4.2, 6.2, 8.0],
  childRing: [1.25, 2.3],
  childCap: [6, 12],
  historyLimit: 256,
});

const TAU = Math.PI * 2;
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const spreadCache = new Map();
/** Bit-reversal order of 0..n-1 (first slots far apart). */
export function spread(n) {
  if (spreadCache.has(n)) return spreadCache.get(n);
  let bits = 0;
  while (2 ** bits < n) bits++;
  const out = [];
  for (let i = 0; i < 2 ** bits; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    if (r < n) out.push(r);
  }
  spreadCache.set(n, out);
  return out;
}
function ringOf(slot, caps) {
  let start = 0;
  for (let k = 0; k < caps.length; k++) { if (slot < start + caps[k]) return { k, j: slot - start, cap: caps[k] }; start += caps[k]; }
  const k = caps.length - 1;
  return { k, j: (slot - start) % caps[k], cap: caps[k] };
}
/** Offset of a session slot from its platform centre. */
export function slotOffset(slot) {
  const { k, j, cap } = ringOf(slot, ORBIT.slotCap);
  const a = Math.PI / 2 + spread(cap)[j] * TAU / cap + (k % 2 ? Math.PI / cap : 0);
  const r = ORBIT.slotRing[k];
  return { x: Math.cos(a) * r, z: Math.sin(a) * r, ring: k };
}
/** Offset of a child from its parent (horizontal only; the height comes from the tier). */
export function childOffset(index) {
  const { k, j, cap } = ringOf(index, ORBIT.childCap);
  const a = Math.PI / 2 + spread(cap)[j] * TAU / cap + (k % 2 ? Math.PI / cap : 0);
  const r = ORBIT.childRing[k];
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}
export const platformRadius = ring => ORBIT.slotRing[Math.min(ring, ORBIT.slotRing.length - 1)] + ORBIT.platformPad;
/** Angle of project i of n on the orbit. */
export const orbitAngle = (i, n) => Math.PI / 2 - (i - (n - 1) / 2) * TAU / n;
export function orbitRadius(n, rMax) {
  const near = ORBIT.hubClear + rMax;
  return n <= 1 ? near : Math.max(near, (2 * rMax + ORBIT.gap) / (2 * Math.sin(Math.PI / n)));
}

function lowestFree(used) { let i = 0; while (used.has(i)) i++; return i; }
function remember(map, key, value) { map.delete(key); map.set(key, value); while (map.size > ORBIT.historyLimit) map.delete(map.keys().next().value); }

export function createOrbitLayout() {
  const order = [];                       // project keys in first-seen order
  const slotOf = new Map(), slotHistory = new Map();
  const childOf = new Map(), childHistory = new Map();
  let first = true;

  function update({ groups = [], entities = [] }) {
    const issues = [];
    const byKey = new Map();
    for (const e of entities) if (!byKey.has(e.key)) byKey.set(e.key, e);
    // Parents, defensively (same rules as createLayout): unknown, cross-project or cyclic parents become roots.
    const parentOf = new Map();
    for (const e of byKey.values()) {
      let p = e.parentKey && e.parentKey !== e.key && byKey.has(e.parentKey) ? e.parentKey : null;
      if (e.parentKey && !p) issues.push({ type: 'orphan', key: e.key });
      if (p && byKey.get(p).groupKey !== e.groupKey) { issues.push({ type: 'cross-group-parent', key: e.key }); p = null; }
      parentOf.set(e.key, p);
    }
    for (const e of byKey.values()) {
      const seen = new Set([e.key]);
      for (let k = parentOf.get(e.key); k; k = parentOf.get(k)) { if (seen.has(k)) { parentOf.set(e.key, null); issues.push({ type: 'cycle', key: e.key }); break; } seen.add(k); }
    }
    const depthCache = new Map();
    const depth = k => { if (depthCache.has(k)) return depthCache.get(k); const p = parentOf.get(k); const d = p ? depth(p) + 1 : 0; depthCache.set(k, d); return d; };

    // Projects: keep first-seen order, drop the departed, append newcomers sorted.
    const live = new Set(groups.map(g => g.key));
    for (const e of byKey.values()) live.add(e.groupKey);
    for (let i = order.length - 1; i >= 0; i--) if (!live.has(order[i])) order.splice(i, 1);
    for (const key of [...live].filter(k => !order.includes(k)).sort(byCode)) order.push(key);

    // Session slots per platform.
    for (const [key, slot] of slotOf) if (!byKey.has(key) || parentOf.get(key)) { slotOf.delete(key); remember(slotHistory, key, slot); }
    for (const [key, idx] of childOf) if (!byKey.has(key) || !parentOf.get(key)) { childOf.delete(key); remember(childHistory, key, idx); }
    const sortOrder = (a, b) => (a.sortKey ?? 0) - (b.sortKey ?? 0) || byCode(a.key, b.key);
    const byGroup = new Map();
    for (const e of byKey.values()) { if (!byGroup.has(e.groupKey)) byGroup.set(e.groupKey, []); byGroup.get(e.groupKey).push(e); }
    for (const list of byGroup.values()) {
      const used = new Set(list.filter(e => slotOf.has(e.key)).map(e => slotOf.get(e.key)));
      for (const e of list.filter(x => !parentOf.get(x.key) && !slotOf.has(x.key)).sort(sortOrder)) {
        const old = slotHistory.get(e.key);
        const slot = old != null && !used.has(old) ? old : lowestFree(used);
        used.add(slot); slotOf.set(e.key, slot); slotHistory.delete(e.key);
      }
    }
    const kids = new Map();
    for (const e of byKey.values()) { const p = parentOf.get(e.key); if (p) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(e); } }
    for (const list of kids.values()) {
      const used = new Set(list.filter(e => childOf.has(e.key)).map(e => childOf.get(e.key)));
      for (const e of list.filter(x => !childOf.has(x.key)).sort(sortOrder)) {
        const old = childHistory.get(e.key);
        const idx = old != null && !used.has(old) ? old : lowestFree(used);
        used.add(idx); childOf.set(e.key, idx); childHistory.delete(e.key);
      }
    }

    // Platform sizes, then the orbit.
    const ringUsed = new Map();
    for (const e of byKey.values()) if (!parentOf.get(e.key)) {
      const r = slotOffset(slotOf.get(e.key)).ring;
      ringUsed.set(e.groupKey, Math.max(ringUsed.get(e.groupKey) ?? 0, r));
    }
    const shown = order.filter(k => byGroup.has(k));
    const radii = shown.map(k => platformRadius(ringUsed.get(k) ?? 0));
    const rMax = Math.max(0, ...radii);
    const R = shown.length ? orbitRadius(shown.length, rMax) : 0;
    const platforms = new Map();
    shown.forEach((key, i) => {
      const angle = orbitAngle(i, shown.length);
      platforms.set(key, { key, index: i, angle, x: Math.cos(angle) * R, z: Math.sin(angle) * R, radius: radii[i], ring: ringUsed.get(key) ?? 0 });
    });

    const nodes = new Map();
    const place = key => {
      if (nodes.has(key)) return nodes.get(key);
      const e = byKey.get(key), p = parentOf.get(key), plat = platforms.get(e.groupKey);
      let x, z;
      if (!p) { const o = slotOffset(slotOf.get(key)); x = plat.x + o.x; z = plat.z + o.z; }
      else { const parent = place(p), o = childOffset(childOf.get(key)); x = parent.x + o.x; z = parent.z + o.z; }
      const d = depth(key);
      const node = { key, x, z, y: ORBIT.tierY[Math.min(d, ORBIT.tierY.length - 1)], depth: d, tier: Math.min(d, 3), groupKey: e.groupKey, parentKey: p,
        slot: p ? null : slotOf.get(key), child: p ? childOf.get(key) : null, orphan: !!e.parentKey && !p };
      nodes.set(key, node);
      return node;
    };
    for (const key of byKey.keys()) place(key);

    const bounds = { minX: -ORBIT.hubClear, maxX: ORBIT.hubClear, minZ: -ORBIT.hubClear, maxZ: ORBIT.hubClear, maxY: ORBIT.tierY[0] };
    for (const g of platforms.values()) {
      bounds.minX = Math.min(bounds.minX, g.x - g.radius); bounds.maxX = Math.max(bounds.maxX, g.x + g.radius);
      bounds.minZ = Math.min(bounds.minZ, g.z - g.radius); bounds.maxZ = Math.max(bounds.maxZ, g.z + g.radius);
    }
    for (const n of nodes.values()) bounds.maxY = Math.max(bounds.maxY, n.y);
    const wasFirst = first; first = false;
    return { groups: platforms, nodes, orbit: { radius: R, count: shown.length }, bounds, issues, first: wasFirst };
  }
  return {
    update,
    retained: () => ({ projects: order.length, slots: slotOf.size, children: childOf.size, slotHistory: slotHistory.size, childHistory: childHistory.size }),
  };
}

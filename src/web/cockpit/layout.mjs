// Pure keyed layout for the cockpit scene (P2). No DOM, no Three.js: it is unit-tested in Node.
//
// World units: a session node is about 1.8 wide. The ground plane is x/z; y is up.
//
// Rules that make the scene stable:
//  - A project owns one *cluster slot* and a session owns one *member slot*. Both are a fixed function of the slot
//    number, so a slot never moves. A new project or session takes the lowest free slot.
//  - Slots are kept for as long as the key exists. When a key disappears its slot is freed, and its old slot is kept
//    in a bounded history so a key that comes straight back (a session that ended and was resumed) gets it again if it
//    is still free.
//  - A child (subagent, folded group) sits at a fixed offset from its parent, chosen by a per-parent child index.
//  - Incoming groups and sessions in one update are sorted (first render stable) before slots are given out.

export const WORLD = Object.freeze({
  clusterRing0: 20,        // radius of the first ring of project clusters
  clusterRingStep: 21,
  memberRing0: 5.4,        // radius of a cluster's first member ring
  memberRingStep: 3.9,
  memberCap0: 6,           // members on ring 0; ring n holds memberCap0 * (n + 1)
  childStep: 3.1,          // distance from a parent to its first child
  childLateral: 2.4,
  maxDepth: 6,
  historyLimit: 256,
  groupHistoryLimit: 64,
});

const TAU = Math.PI * 2;
const codeUnitOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Bit-reversal order over 0..count-1, so the first slots of a ring are far apart (two sit opposite each other). */
function spreadOrder(count) {
  let bits = 0;
  while (2 ** bits < count) bits++;
  const order = [];
  for (let i = 0; i < 2 ** bits; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    if (r < count) order.push(r);
  }
  return order;
}
const spreadCache = new Map();
function spread(count) {
  if (!spreadCache.has(count)) spreadCache.set(count, spreadOrder(count));
  return spreadCache.get(count);
}

/** Which ring a cluster slot falls on and its position inside that ring. Ring n holds 2 + 4n slots. */
function clusterRingOf(slot) {
  let ring = 0, start = 0;
  for (;; ring++) {
    const cap = 2 + 4 * ring;
    if (slot < start + cap) return { ring, cap, index: slot - start };
    start += cap;
  }
}
/** Fixed centre of a project cluster. Pure function of the slot number. */
export function clusterSlotPosition(slot) {
  const { ring, cap, index } = clusterRingOf(slot);
  const j = spread(cap)[index];
  const step = TAU / cap;
  // Ring 0 starts to the left (180 degrees). Odd rings are rotated half a step so they never line up with ring 0.
  const angle = Math.PI + j * step + (ring % 2 ? step / 2 : 0);
  const radius = WORLD.clusterRing0 + ring * WORLD.clusterRingStep;
  return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius * 0.62 };
}

/** Ring and angle of a member slot inside its cluster. */
function memberRingOf(slot) {
  let ring = 0, start = 0;
  for (;; ring++) {
    const cap = WORLD.memberCap0 * (ring + 1);
    if (slot < start + cap) return { ring, cap, index: slot - start };
    start += cap;
  }
}
/** Offset of a member slot from its cluster centre. Pure function of the slot number. */
export function memberSlotOffset(slot) {
  const { ring, cap, index } = memberRingOf(slot);
  const j = spread(cap)[index];
  const step = TAU / cap;
  const angle = -Math.PI / 2 + j * step + (ring % 2 ? step / 2 : 0);
  const radius = WORLD.memberRing0 + ring * WORLD.memberRingStep;
  return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius * 0.82, ring, angle };
}
const childDirCache = new Map();
/**
 * Direction in which the first child of a root member sits: the one that keeps it farthest from every other member
 * slot of the first three rings. Depends only on the slot number, so it never changes while the parent keeps its slot.
 */
function childDirection(slot) {
  if (childDirCache.has(slot)) return childDirCache.get(slot);
  const me = memberSlotOffset(slot), others = [];
  for (let i = 0; i < WORLD.memberCap0 * 6; i++) if (i !== slot) others.push(memberSlotOffset(i));
  let best = null;
  for (let deg = 0; deg < 360; deg += 15) {
    const dx = Math.cos(rad(deg)), dz = Math.sin(rad(deg));
    const px = me.x + dx * WORLD.childStep, pz = me.z + dz * WORLD.childStep;
    const room = Math.min(...others.map(o => Math.hypot(o.x - px, o.z - pz)));
    // Prefer the outward direction when the room is about the same.
    const outward = (dx * me.x + dz * me.z) / (Math.hypot(me.x, me.z) || 1);
    const score = room + outward * 0.3;
    if (!best || score > best.score) best = { score, dx, dz };
  }
  const result = { dx: best.dx, dz: best.dz };
  childDirCache.set(slot, result);
  return result;
}
const rad = deg => deg * Math.PI / 180;

/** Radius of the platform under a cluster whose outermost occupied member ring is `ring`. */
export const platformRadius = ring => WORLD.memberRing0 + ring * WORLD.memberRingStep + 3.8;

function lowestFree(used) {
  let slot = 0;
  while (used.has(slot)) slot++;
  return slot;
}
function remember(history, key, slot, limit) {
  history.delete(key);
  history.set(key, slot);
  while (history.size > limit) history.delete(history.keys().next().value);
}

/**
 * Create a layout allocator.
 *
 * `update({groups, entities})` takes
 *   groups   [{key}]
 *   entities [{key, groupKey, parentKey|null, sortKey, kind}]   (sortKey: start time, ties broken by key)
 * and returns {groups: Map, nodes: Map, bounds, issues}. Positions are in world units.
 */
export function createLayout() {
  const groupSlot = new Map();          // groupKey -> cluster slot
  const groupHistory = new Map();       // groupKey -> slot it last held
  const memberSlot = new Map();         // entityKey -> member slot (depth 0 members only)
  const memberHistory = new Map();      // entityKey -> slot it last held
  const childIndex = new Map();         // entityKey -> child index under its parent
  const childHistory = new Map();       // entityKey -> index it last held
  let first = true;

  function update({ groups = [], entities = [] }) {
    const issues = [];
    const byKey = new Map();
    for (const e of entities) if (!byKey.has(e.key)) byKey.set(e.key, e);   // a repeated key keeps its first record

    // ---- parents: resolve relationships defensively ----
    const parentOf = new Map();
    for (const e of byKey.values()) {
      let parent = e.parentKey && byKey.has(e.parentKey) && e.parentKey !== e.key ? e.parentKey : null;
      if (e.parentKey && !parent) issues.push({ type: 'orphan', key: e.key });
      if (parent && byKey.get(parent).groupKey !== e.groupKey) { issues.push({ type: 'cross-group-parent', key: e.key }); parent = null; }
      parentOf.set(e.key, parent);
    }
    // Break cycles: the member that closes the loop becomes a root.
    for (const e of byKey.values()) {
      const seen = new Set([e.key]);
      for (let k = parentOf.get(e.key); k; k = parentOf.get(k)) {
        if (seen.has(k)) { parentOf.set(e.key, null); issues.push({ type: 'cycle', key: e.key }); break; }
        seen.add(k);
      }
    }
    const depthOf = new Map();
    const depth = key => {
      if (depthOf.has(key)) return depthOf.get(key);
      const p = parentOf.get(key);
      const d = p ? depth(p) + 1 : 0;
      depthOf.set(key, d);
      return d;
    };

    // ---- release what is gone ----
    const liveGroups = new Set(groups.map(g => g.key));
    for (const e of byKey.values()) liveGroups.add(e.groupKey);
    for (const [key, slot] of groupSlot) if (!liveGroups.has(key)) { groupSlot.delete(key); remember(groupHistory, key, slot, WORLD.groupHistoryLimit); }
    for (const [key, slot] of memberSlot) if (!byKey.has(key) || parentOf.get(key)) { memberSlot.delete(key); remember(memberHistory, key, slot, WORLD.historyLimit); }
    for (const [key, index] of childIndex) if (!byKey.has(key) || !parentOf.get(key)) { childIndex.delete(key); remember(childHistory, key, index, WORLD.historyLimit); }

    // ---- groups: stable sort of the newcomers, then the lowest free slot ----
    const newGroups = [...liveGroups].filter(key => !groupSlot.has(key)).sort(codeUnitOrder);
    const usedClusters = new Set(groupSlot.values());
    const wantedSlot = key => { const old = groupHistory.get(key); return old != null && !usedClusters.has(old) ? old : lowestFree(usedClusters); };
    for (const key of newGroups) {
      const slot = wantedSlot(key);
      usedClusters.add(slot);
      groupSlot.set(key, slot);
      groupHistory.delete(key);
    }

    // ---- members (depth 0) per group ----
    const byGroup = new Map();
    for (const e of byKey.values()) {
      if (!byGroup.has(e.groupKey)) byGroup.set(e.groupKey, []);
      byGroup.get(e.groupKey).push(e);
    }
    const order = (a, b) => (a.sortKey ?? 0) - (b.sortKey ?? 0) || codeUnitOrder(a.key, b.key);
    for (const list of byGroup.values()) {
      const used = new Set();
      for (const e of list) if (memberSlot.has(e.key)) used.add(memberSlot.get(e.key));
      for (const e of list.filter(x => !parentOf.get(x.key) && !memberSlot.has(x.key)).sort(order)) {
        const old = memberHistory.get(e.key);
        const slot = old != null && !used.has(old) ? old : lowestFree(used);
        used.add(slot);
        memberSlot.set(e.key, slot);
        memberHistory.delete(e.key);
      }
    }
    // ---- children per parent ----
    const kidsOf = new Map();
    for (const e of byKey.values()) {
      const p = parentOf.get(e.key);
      if (!p) continue;
      if (!kidsOf.has(p)) kidsOf.set(p, []);
      kidsOf.get(p).push(e);
    }
    for (const list of kidsOf.values()) {
      const used = new Set();
      for (const e of list) if (childIndex.has(e.key)) used.add(childIndex.get(e.key));
      for (const e of list.filter(x => !childIndex.has(x.key)).sort(order)) {
        const old = childHistory.get(e.key);
        const index = old != null && !used.has(old) ? old : lowestFree(used);
        used.add(index);
        childIndex.set(e.key, index);
        childHistory.delete(e.key);
      }
    }

    // ---- positions ----
    const groupOut = new Map();
    for (const [key, slot] of groupSlot) groupOut.set(key, { key, slot, ...clusterSlotPosition(slot), ring: 0, radius: platformRadius(0) });
    const nodes = new Map();
    const place = key => {
      if (nodes.has(key)) return nodes.get(key);
      const e = byKey.get(key);
      const center = groupOut.get(e.groupKey);
      const parent = parentOf.get(key);
      let x, z, ring = 0;
      if (!parent) {
        const o = memberSlotOffset(memberSlot.get(key));
        x = center.x + o.x; z = center.z + o.z; ring = o.ring;
      } else {
        const p = place(parent);
        // Away from the neighbouring member slots (outward for deeper levels), fanned sideways by child index: 0, +1, -1, +2, -2 ...
        let ux, uz;
        if (p.slot != null) ({ dx: ux, dz: uz } = childDirection(p.slot));
        else { ux = p.x - center.x; uz = p.z - center.z; const len = Math.hypot(ux, uz) || 1; ux /= len; uz /= len; }
        const k = childIndex.get(key);
        const lateral = Math.ceil(k / 2) * (k % 2 ? 1 : -1) * WORLD.childLateral;
        const out = WORLD.childStep + 0.25 * Math.ceil(k / 2);
        x = p.x + ux * out - uz * lateral;
        z = p.z + uz * out + ux * lateral;
        ring = p.ring;
      }
      const node = { key, x, z, depth: Math.min(depth(key), WORLD.maxDepth), groupKey: e.groupKey, parentKey: parent, slot: parent ? null : memberSlot.get(key), ring, orphan: !!e.parentKey && !parent };
      nodes.set(key, node);
      return node;
    };
    for (const key of byKey.keys()) place(key);
    for (const g of groupOut.values()) {
      let ring = 0;
      for (const n of nodes.values()) if (n.groupKey === g.key && !n.parentKey) ring = Math.max(ring, n.ring);
      g.ring = ring;
      g.radius = platformRadius(ring);
    }

    const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    const grow = (x, z, r) => {
      bounds.minX = Math.min(bounds.minX, x - r); bounds.maxX = Math.max(bounds.maxX, x + r);
      bounds.minZ = Math.min(bounds.minZ, z - r * 0.82); bounds.maxZ = Math.max(bounds.maxZ, z + r * 0.82);
    };
    for (const g of groupOut.values()) if ([...nodes.values()].some(n => n.groupKey === g.key)) grow(g.x, g.z, g.radius);
    for (const n of nodes.values()) grow(n.x, n.z, 1.4);
    if (!nodes.size) Object.assign(bounds, { minX: -WORLD.clusterRing0, maxX: WORLD.clusterRing0, minZ: -WORLD.clusterRing0 * 0.6, maxZ: WORLD.clusterRing0 * 0.6 });

    // Only groups that still hold something are returned: an empty group has nothing to draw.
    for (const key of [...groupOut.keys()]) if (![...nodes.values()].some(n => n.groupKey === key)) groupOut.delete(key);
    const wasFirst = first;
    first = false;
    return { groups: groupOut, nodes, bounds, issues, first: wasFirst };
  }

  return {
    update,
    /** Size of the retained state, for tests that check the history stays bounded. */
    retained: () => ({ groups: groupSlot.size, members: memberSlot.size, children: childIndex.size,
      groupHistory: groupHistory.size, memberHistory: memberHistory.size, childHistory: childHistory.size }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Label placement (screen space). Pure so the "a waiting node always keeps its label" rule is a unit test.
// ---------------------------------------------------------------------------------------------------------------

export const LABEL = Object.freeze({ gap: 6, extra: 30, margin: 4, nodePad: 5, selectedPad: 32, maxWidth: 176, height: 38 });

const STATE_WORD = { 'needs-you': 'Needs you', working: 'Working', agents: 'Agents working', done: 'Done', idle: 'Idle', ended: 'Ended', sub: 'Working', 'sub-done': 'Done' };
/** Estimated plate width for a label. The browser audit measures the real box; this keeps placement DOM-free. */
export function estimateLabelWidth(title, status = '') {
  const text = Math.max(String(title || '').length, 0);
  const top = Math.min(text, 26) * 7.2 + 14;
  // The state word is 11 px uppercase with 0.14em tracking (about 8.4 px a letter), plus glyph, gap and timer.
  const bottom = (STATE_WORD[status] || String(status || '')).length * 8.4 + 72;
  return Math.min(LABEL.maxWidth, Math.max(top, bottom, 64));
}

const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const hitsCircle = (box, c) => {
  const nx = Math.max(box.x, Math.min(c.x, box.x + box.w)), ny = Math.max(box.y, Math.min(c.y, box.y + box.h));
  return (nx - c.x) ** 2 + (ny - c.y) ** 2 < c.r * c.r;
};

function candidates(node, w, h, must = false) {
  const { x: cx, y: cy, r } = node;
  const at = (extra) => {
    const g = LABEL.gap + extra, d = r * 0.72 + g * 0.72;
    return [
      { side: 'right', x: cx + r + g, y: cy - h / 2 }, { side: 'left', x: cx - r - g - w, y: cy - h / 2 },
      { side: 'below', x: cx - w / 2, y: cy + r + g }, { side: 'above', x: cx - w / 2, y: cy - r - g - h },
      { side: 'se', x: cx + d, y: cy + d }, { side: 'sw', x: cx - d - w, y: cy + d },
      { side: 'ne', x: cx + d, y: cy - d - h }, { side: 'nw', x: cx - d - w, y: cy - d - h },
    ];
  };
  // Right, left, below, above, the four diagonals, then right, left, below, above again 30 px further out. A must label may go 60 and 120 px out in all eight.
  const list = [...at(0), ...at(LABEL.extra).filter(c => ['right', 'left', 'below', 'above'].includes(c.side))];
  // A label that must be shown (a waiting node) may stand further out, in the same eight directions.
  if (must) list.push(...at(LABEL.extra * 2), ...at(LABEL.extra * 4));
  return list;
}

/**
 * Place labels first-come by priority; a label that cannot be placed is hidden, except a `must` label, which takes the
 * candidate with the fewest conflicts and is reported in `forced`.
 *
 * nodes:   [{key, x, y, r, w, h?, prio, must?, selected?, label?: false}]   (screen px, sorted by `order`)
 * blocks:  [{x,y,w,h}] boxes that labels may not cover (project names)
 * rect:    {w, h}
 */
export function placeLabels(nodes, rect, blocks = []) {
  const placed = new Map(), hidden = [], forced = [];
  const boxes = [];
  const circles = nodes.map(n => ({ key: n.key, x: n.x, y: n.y, r: n.r + (n.selected ? LABEL.selectedPad : LABEL.nodePad) }));
  const queue = nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.label !== false)
    .sort((a, b) => a.n.prio - b.n.prio || a.i - b.i);
  const m = LABEL.margin;
  const conflicts = (box, key) => {
    let count = 0;
    if (box.x < m || box.y < m || box.x + box.w > rect.w - m || box.y + box.h > rect.h - m) count += 4;
    for (const c of circles) if (c.key !== key && hitsCircle(box, c)) count++;
    for (const b of boxes) if (intersects(box, b)) count++;
    for (const b of blocks) if (intersects(box, b)) count++;
    return count;
  };
  for (const { n } of queue) {
    const w = n.w, h = n.h || LABEL.height;
    let best = null;
    for (const c of candidates(n, w, h, n.must)) {
      const box = { x: c.x, y: c.y, w, h };
      const count = conflicts(box, n.key);
      if (count === 0) { best = { ...box, side: c.side, count }; break; }
      if (!best || count < best.count) best = { ...box, side: c.side, count };
    }
    if (best.count === 0) { placed.set(n.key, best); boxes.push(best); }
    else if (n.must) { placed.set(n.key, { ...best, forced: true }); boxes.push(best); forced.push(n.key); }
    else hidden.push(n.key);
  }
  return { placed, hidden, forced };
}

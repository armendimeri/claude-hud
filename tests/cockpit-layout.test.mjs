import assert from 'node:assert/strict';
import test from 'node:test';
import { WORLD, clusterSlotPosition, createLayout, estimateLabelWidth, memberSlotOffset, placeLabels, platformRadius } from '../src/web/cockpit/layout.mjs';
import { accessibleName, diffModels, entityKey, projectSnapshot } from '../src/web/cockpit/projection.mjs';
import { child, parent, sibling, bedrock, snapshots, timeline } from './fixtures/cockpit/public.mjs';

const input = model => ({
  groups: model.groups.map(({ key }) => ({ key })),
  entities: model.entities.map(({ key, groupKey, parentKey, sortKey, kind }) => ({ key, groupKey, parentKey, sortKey, kind })),
});
const positions = result => Object.fromEntries([...result.nodes].map(([key, n]) => [key, [n.x, n.z]]));
const entity = (key, groupKey, parentKey = null, sortKey = 0) => ({ key, groupKey, parentKey, sortKey, kind: parentKey ? 'sub' : 'session' });
const minDistance = result => {
  const list = [...result.nodes.values()];
  let min = Infinity;
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) min = Math.min(min, Math.hypot(list[i].x - list[j].x, list[i].z - list[j].z));
  return min;
};

test('slot positions are a fixed, collision-free function of the slot number', () => {
  const clusters = Array.from({ length: 40 }, (_, slot) => clusterSlotPosition(slot));
  const members = Array.from({ length: 80 }, (_, slot) => memberSlotOffset(slot));
  // Platforms are ellipses squashed to 0.82 in z, so measure with that squash.
  const nearest = (list, squash = 1) => Math.min(...list.flatMap((a, i) => list.slice(i + 1).map(b => Math.hypot(a.x - b.x, (a.z - b.z) / squash))));
  assert.ok(nearest(clusters.slice(0, 12), 0.82) > 2 * platformRadius(0), 'the first twelve projects never overlap their platforms');
  assert.ok(nearest(clusters, 0.82) > 2 * platformRadius(0), 'project platforms never overlap, at any of the first forty slots');
  assert.ok(nearest(members) > 3.3, 'members of one cluster never share a spot');
  assert.deepEqual(clusterSlotPosition(7), clusterSlotPosition(7));
  assert.ok(clusterSlotPosition(0).x < 0 && clusterSlotPosition(1).x > 0, 'the first two projects sit opposite each other');
});

test('first render is order independent: incoming groups and sessions are sorted before slots are given out', () => {
  const model = projectSnapshot(snapshots.dense, { expanded: new Set(['project:Ledger', 'project:Reports', 'project:Imports', 'project:Invoices']) });
  const a = createLayout().update(input(model));
  const reversed = { groups: input(model).groups.reverse(), entities: input(model).entities.reverse() };
  const b = createLayout().update(reversed);
  assert.deepEqual(positions(a), positions(b));
  assert.equal(a.nodes.size, 25, '24 sessions and the one subagent');
  assert.ok(minDistance(a) > 3, `nodes keep clear of each other (${minDistance(a).toFixed(2)})`);
});

test('adding unrelated work leaves every surviving position unchanged', () => {
  const layout = createLayout();
  const before = layout.update(input(projectSnapshot(snapshots.dense, { expanded: new Set(['project:Ledger']) })));
  const base = positions(before);
  const grown = projectSnapshot(snapshots.dense, { expanded: new Set(['project:Ledger']) });
  const extra = input(grown);
  extra.groups.push({ key: 'Aardvark' });                // sorts before every existing project
  extra.entities.push(entity('new-1', 'Aardvark'), entity('new-2', 'Aardvark', 'new-1', 5), entity('new-3', 'Ledger', null, -1));
  const after = layout.update(extra);
  for (const [key, xz] of Object.entries(base)) assert.deepEqual(positions(after)[key], xz, key);
  assert.ok(after.nodes.has('new-3') && after.nodes.has('new-1'));
  assert.ok(after.groups.get('Aardvark').slot > 3, 'the new project takes the next free slot, not an existing one');
});

test('expired entities free their slots, which the next newcomer reuses, and history stays bounded', () => {
  const layout = createLayout();
  layout.update({ groups: [{ key: 'A' }], entities: [entity('x', 'A', null, 1), entity('y', 'A', null, 2), entity('z', 'A', null, 3)] });
  const first = layout.update({ groups: [{ key: 'A' }], entities: [entity('x', 'A', null, 1), entity('z', 'A', null, 3)] });
  const slotOfZ = first.nodes.get('z').slot;
  const next = layout.update({ groups: [{ key: 'A' }], entities: [entity('x', 'A', null, 1), entity('z', 'A', null, 3), entity('w', 'A', null, 4)] });
  assert.equal(next.nodes.get('w').slot, 1, 'newcomer takes y\'s freed slot');
  assert.equal(next.nodes.get('z').slot, slotOfZ);
  // A session that comes straight back gets its old slot while it is free.
  const back = createLayout();
  const one = back.update({ groups: [{ key: 'A' }], entities: [entity('p', 'A', null, 1), entity('q', 'A', null, 2)] });
  back.update({ groups: [{ key: 'A' }], entities: [entity('p', 'A', null, 1)] });
  const again = back.update({ groups: [{ key: 'A' }], entities: [entity('p', 'A', null, 1), entity('q', 'A', null, 2)] });
  assert.deepEqual([again.nodes.get('q').x, again.nodes.get('q').z], [one.nodes.get('q').x, one.nodes.get('q').z]);
  // Churn of 2,000 short-lived sessions and projects keeps the retained history at its limits.
  const churn = createLayout();
  for (let i = 0; i < 2000; i++) churn.update({ groups: [{ key: 'G' + i }], entities: [entity('s' + i, 'G' + i), entity('c' + i, 'G' + i, 's' + i)] });
  const kept = churn.retained();
  assert.equal(kept.groups, 1);
  assert.ok(kept.memberHistory <= WORLD.historyLimit && kept.childHistory <= WORLD.historyLimit && kept.groupHistory <= WORLD.groupHistoryLimit, JSON.stringify(kept));
});

test('child depth and parent links come from the published relationships', () => {
  const layout = createLayout();
  const result = layout.update({ groups: [{ key: 'A' }], entities: [entity('root', 'A', null, 1), entity('kid', 'A', 'root', 2), entity('grandkid', 'A', 'kid', 3), entity('kid2', 'A', 'root', 4)] });
  assert.deepEqual(['root', 'kid', 'grandkid', 'kid2'].map(key => result.nodes.get(key).depth), [0, 1, 2, 1]);
  assert.equal(result.nodes.get('grandkid').parentKey, 'kid');
  const dist = (a, b) => Math.hypot(result.nodes.get(a).x - result.nodes.get(b).x, result.nodes.get(a).z - result.nodes.get(b).z);
  assert.ok(dist('root', 'kid') > 2.5 && dist('root', 'kid') < 5, 'a child sits close to its parent');
  assert.ok(dist('kid', 'kid2') > 2.4, 'siblings do not overlap');
});

test('orphan, self-parent, cross-group and cyclic edges are placed defensively', () => {
  const layout = createLayout();
  const result = layout.update({ groups: [{ key: 'A' }, { key: 'B' }], entities: [
    entity('orphan', 'A', 'missing', 1), entity('self', 'A', 'self', 2), entity('c1', 'A', 'c2', 3), entity('c2', 'A', 'c1', 4),
    entity('b', 'B', null, 1), entity('cross', 'A', 'b', 5)] });
  assert.equal(result.nodes.size, 6, 'every entity gets a position');
  for (const node of result.nodes.values()) assert.ok(Number.isFinite(node.x) && Number.isFinite(node.z));
  const types = result.issues.map(issue => issue.type);
  for (const type of ['orphan', 'cycle', 'cross-group-parent']) assert.ok(types.includes(type), type);
  assert.equal(result.nodes.get('orphan').parentKey, null);
  assert.ok(minDistance(result) > 2.4);
  // A 100-deep chain is clamped, not rejected.
  const deep = createLayout().update({ groups: [{ key: 'A' }], entities: Array.from({ length: 100 }, (_, i) => entity('n' + i, 'A', i ? 'n' + (i - 1) : null, i)) });
  assert.equal(deep.nodes.get('n99').depth, WORLD.maxDepth);
});

test('projection keeps same-title sessions distinct and uses tuple keys', () => {
  const model = projectSnapshot(snapshots.sameTitle, {});
  assert.deepEqual(model.entities.map(e => e.title).filter(t => t === 'Export').length, 2);
  assert.equal(new Set(model.entities.map(e => e.key)).size, model.entities.length);
  const sub = model.byKey.get(entityKey(child.sessionId, child.agentId));
  assert.deepEqual(sub.selection, child);
  assert.equal(sub.parentKey, entityKey(parent.sessionId));
  assert.equal(model.byKey.get(entityKey(sibling.sessionId)).selection.agentId, null);
  assert.ok(model.byKey.has(entityKey(parent.sessionId)));
  assert.equal(entityKey('a:b', null), JSON.stringify(['a:b', null]));
});

test('projection states and idle folding follow the design study', () => {
  const sparse = projectSnapshot(snapshots.sparse, {});
  const state = key => sparse.byKey.get(key).state;
  assert.equal(state(entityKey(parent.sessionId)), 'needs-you');
  assert.equal(state(entityKey(sibling.sessionId)), 'working');
  assert.equal(state(entityKey(bedrock.sessionId)), 'working');
  assert.deepEqual(sparse.groups.map(g => [g.name, g.waiting, g.working]), [['Ledger', 1, 1], ['Reports', 0, 1]]);
  const dense = projectSnapshot(snapshots.dense, {});
  const satellites = dense.entities.filter(e => e.kind === 'sat');
  assert.deepEqual(satellites.map(s => [s.groupKey, s.count]).sort(), [['Imports', 4], ['Invoices', 4], ['Ledger', 4], ['Reports', 4]], 'each project folds its four idle sessions, as in the design study');
  const open = projectSnapshot(snapshots.dense, { project: 'Ledger' });
  assert.ok(!open.entities.some(e => e.kind === 'sat' && e.groupKey === 'Ledger'), 'the focused project shows all of its members');
  assert.ok(open.visible.every(key => open.byKey.get(key).groupKey === 'Ledger'));
  assert.equal(projectSnapshot(snapshots.empty, {}).entities.length, 0);
  assert.equal(projectSnapshot(null, {}).entities.length, 0);
  assert.match(accessibleName(sparse.byKey.get(entityKey(parent.sessionId))), /Needs you/i);
});

test('the graph diff ignores the server clock and reports meaningful changes', () => {
  const at = index => projectSnapshot(timeline[index].snapshot, {});
  assert.deepEqual(diffModels(at(1), at(2)), { layout: false, visual: false, text: false, changed: false }, 'only snapshot.now differs');
  assert.equal(diffModels(at(2), at(3)).visual, true, 'the parent stops waiting');
  const once = projectSnapshot(snapshots.sparse, {});
  const moved = projectSnapshot({ ...snapshots.sparse, now: snapshots.sparse.now + 5000, uptime: 1 }, {});
  assert.equal(diffModels(once, moved).changed, false);
  assert.equal(diffModels(at(0), projectSnapshot(snapshots.empty, {})).layout, true);
  assert.equal(diffModels(null, once).changed, true);
});

// Project the world onto a rectangle the way the scene's top-down fit does, to test label placement without a browser.
function screenOf(model, layoutResult, width, height) {
  const { minX, maxX, minZ, maxZ } = layoutResult.bounds;
  const scale = Math.min((width - 120) / (maxX - minX), (height - 100) / (maxZ - minZ));
  const x = wx => width / 2 + (wx - (minX + maxX) / 2) * scale, y = wz => height / 2 + (wz - (minZ + maxZ) / 2) * scale;
  const nodes = model.order.map(key => {
    const e = model.byKey.get(key), n = layoutResult.nodes.get(key);
    return { key, x: x(n.x), y: y(n.z), r: e.kind === 'sub' ? 13 : e.kind === 'sat' ? 15 : 18,
      w: estimateLabelWidth(e.title, e.state), prio: e.kind === 'sat' ? 99 : e.state === 'needs-you' ? 1 : e.state === 'working' ? 5 : 6,
      must: e.state === 'needs-you', label: e.kind !== 'sat' };
  });
  const blocks = [...layoutResult.groups.values()].map(g => ({ x: x(g.x) - 50, y: y(g.z + g.radius * 0.82) + 4, w: 100, h: 18 }));
  return { nodes, blocks };
}

test('a waiting node always keeps its label in the sparse and the dense layout', () => {
  for (const [name, snapshot, expanded] of [['sparse', snapshots.sparse, new Set()], ['dense', snapshots.dense, new Set(['project:Ledger'])]]) {
    const model = projectSnapshot(snapshot, { expanded });
    const world = createLayout().update(input(model));
    const { nodes, blocks } = screenOf(model, world, 1392, 696);
    const result = placeLabels(nodes, { w: 1392, h: 696 }, blocks);
    const waiting = nodes.filter(n => n.must).map(n => n.key);
    assert.ok(waiting.length === 1, name);
    assert.ok(waiting.every(key => result.placed.has(key) && !result.forced.includes(key)), `${name}: the waiting label is placed without a conflict`);
    for (const [key, box] of result.placed) {   // no plate touches another plate or the scene edge
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= 1392 && box.y + box.h <= 696, key);
      for (const [other, ob] of result.placed) if (other !== key) assert.ok(box.x >= ob.x + ob.w || ob.x >= box.x + box.w || box.y >= ob.y + ob.h || ob.y >= box.y + box.h, `${key}/${other}`);
    }
  }
});

test('labels are suppressed by priority and a must label is forced and reported when there is no room', () => {
  const crowd = Array.from({ length: 12 }, (_, i) => ({ key: 'n' + i, x: 200 + (i % 4) * 24, y: 150 + Math.floor(i / 4) * 24, r: 12, w: 150, prio: i === 11 ? 1 : 5 + i, must: i === 11 }));
  const result = placeLabels(crowd, { w: 400, h: 300 });
  assert.ok(result.placed.has('n11'), 'the highest priority label is placed first');
  assert.ok(result.hidden.length > 0, 'the lowest priority labels are hidden');
  assert.ok(!result.hidden.includes('n11'));
  const squeezed = placeLabels([{ key: 'w', x: 40, y: 40, r: 20, w: 400, prio: 1, must: true }], { w: 100, h: 60 });
  assert.deepEqual(squeezed.forced, ['w'], 'reported so a layout test can fail');
  assert.ok(squeezed.placed.has('w'));
  assert.ok(estimateLabelWidth('x'.repeat(200)) <= 176);
});

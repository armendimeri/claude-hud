import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cockpitHref, dashboardHref, resolveRoute, routeTarget } from '../src/web/components/route.mjs';
import { createDiscreet } from '../src/web/components/discreet.mjs';
import { entityKey, findEntityElement } from '../src/web/components/entity-key.mjs';
import { entityKey as sceneKey } from '../src/web/cockpit/projection.mjs';
import { keyOf as inspectorKey } from '../src/web/inspector/state.mjs';

// The route rules of the page shell, without a browser (the real shell is exercised in tests/browser-smoke.mjs).
const registry = new Map([
  ['cards', { key: 'cards', outlet: 'sessions' }],
  ['network', { key: 'network', outlet: 'sessions' }],
  ['activity', { key: 'activity', outlet: 'page', demoOnly: true }],
  ['cockpit', { key: 'cockpit', outlet: 'page' }],
]);

test('kiosk wins over every view, an unknown view means the dashboard, and the cockpit is a page view', () => {
  assert.equal(resolveRoute('?kiosk&view=cockpit', registry).descriptor.key, 'network');
  assert.equal(resolveRoute('?kiosk', registry).descriptor.key, 'network');
  assert.equal(routeTarget(resolveRoute('?kiosk&view=cockpit', registry), { demo: false }).kind, 'dashboard');
  assert.equal(resolveRoute('?view=nope', registry).descriptor, null);
  assert.deepEqual(routeTarget(resolveRoute('?view=nope', registry), { demo: false }), { kind: 'dashboard', requested: null, id: 'dashboard' });
  assert.equal(routeTarget(resolveRoute('?view=cards', registry), { demo: false }).requested.key, 'cards');
  const cockpit = routeTarget(resolveRoute('?view=cockpit&project=A%20B', registry), { demo: false });
  assert.equal(cockpit.kind, 'page');
  assert.equal(cockpit.id, 'cockpit');
  assert.equal(resolveRoute('?view=cockpit&project=A%20B', registry).project, 'A B');
});

test('Activity stays demo-only: a live HUD falls back to the dashboard, a demo HUD shows it', () => {
  const route = resolveRoute('?view=activity', registry);
  assert.equal(routeTarget(route, { demo: false }).kind, 'dashboard');
  assert.equal(routeTarget(route, { demo: true }).kind, 'page');
  assert.equal(routeTarget(route, { demo: 'dense' }).kind, 'page');
});

test('dashboard and cockpit URLs keep the project and kiosk flag and only change the view', () => {
  assert.equal(dashboardHref('http://127.0.0.1:7777/?view=cockpit&project=A%20B'), 'http://127.0.0.1:7777/?project=A+B');
  assert.equal(dashboardHref('http://127.0.0.1:7777/?view=cockpit'), 'http://127.0.0.1:7777/');
  assert.equal(cockpitHref('http://127.0.0.1:7777/?view=network&project=A'), 'http://127.0.0.1:7777/?view=cockpit&project=A');
  assert.equal(cockpitHref('http://127.0.0.1:7777/'), 'http://127.0.0.1:7777/?view=cockpit');
});

test('discreet display is a tab-scoped flag that survives a reload and tolerates broken storage', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const first = createDiscreet({ storage });
  assert.equal(first.get(), false);
  const seen = [];
  const stop = first.subscribe(value => seen.push(value));
  first.set(true);
  first.set(true);
  assert.deepEqual(seen, [true], 'a repeated set is not a change');
  assert.equal(createDiscreet({ storage }).get(), true, 'a reload reads the flag');
  first.set(false);
  stop();
  first.set(true);
  assert.deepEqual(seen, [true, false], 'unsubscribed listeners hear nothing');
  assert.equal(createDiscreet({ storage: null }).get(), false);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const memory = createDiscreet({ storage: broken });
  memory.set(true);
  assert.equal(memory.get(), true, 'the flag stays in memory when storage throws');
});

test('one entity key everywhere: shell rows, the scene and the inspector agree and never split on punctuation', () => {
  for (const [id, agent] of [['a', null], ['codex:abc', null], ['id,with"punctuation', 'agent|1'], ['x', undefined]]) {
    assert.equal(entityKey(id, agent), sceneKey(id, agent ?? null));
    assert.equal(entityKey(id, agent), inspectorKey({ sessionId: id, agentId: agent }));
  }
  assert.notEqual(entityKey('a', 'b'), entityKey('a,b', null));
  const elements = [{ dataset: { entityKey: entityKey('a') } }, { dataset: { entityKey: entityKey('b', 'c') } }];
  const scope = { querySelectorAll: () => elements };
  assert.equal(findEntityElement(entityKey('b', 'c'), scope), elements[1]);
  assert.equal(findEntityElement(entityKey('gone'), scope), null);
});

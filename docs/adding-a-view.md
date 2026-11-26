# Add a HUD view

The demo-only [Activity preview](../src/web/views/activity.mjs) is the full-page example. Run
`node hud.mjs --demo` in an isolated profile with `HUD_NO_AUTOINSTALL=1` and an unused
`HUD_PORT`. Open `/?view=activity`. The route also works with `--demo=dense`.

1. Add an ES module under [views](../src/web/views) and export a descriptor with a unique
   `key`, an `outlet` of `page`, and `mount(element, { store, actions })`. Set `demoOnly`
   for demo previews. Register the descriptor in [view-registry.mjs](../src/web/view-registry.mjs).
2. Read `store.getSnapshot()` and `store.getConnection()` in the `store.subscribe(update)`
   callback. Use [selectors](../src/web/data/selectors.mjs) for filtering and joins. Use
   `actions.getProject()`, `setProject(name)` and `subscribeProject(listener)` for project
   focus. Use `dashboardUrl()` and `leaveView()` for dashboard navigation.
3. Import the DOM helpers and components the view uses from [components](../src/web/components).
   Return a cleanup function from `mount` that unsubscribes and removes the view's DOM. Use
   [createLifetime](../src/web/components/lifetime.mjs) when a component owns timers, observers,
   animations or global listeners. Close that lifetime as part of unmount.
4. Put styles under [styles](../src/web/styles) and set the descriptor's `stylesheet` URL for
   a page-specific sheet. Add shared dashboard rules to the relevant component stylesheet.
   [hud.css](../src/web/styles/hud.css) preserves cascade order, with responsive layout, motion
   and kiosk overrides after the component rules. Register browser modules and stylesheets in
   the [public asset allowlist](../src/http/assets.mjs).

[Cards](../src/web/views/cards.mjs) and [Network](../src/web/views/network.mjs) use the
`sessions` outlet. The [session panel](../src/web/components/session-panel.mjs) owns selection,
preference precedence and summary counts. A session descriptor mounts its DOM and calls
`actions.connect({ el, update, jump })`. The panel supplies the scoped sessions to the selected
view's `update` callback. Both views read context and links from the same store. They stay mounted
while switching so card instances, scroll targets and Network pins carry through the switch.

The [page shell](../src/web/components/page.mjs) waits for the first full frame and owns the
stream, route, project and kiosk lifetimes. The [dashboard shell](../src/web/legacy-hud.mjs)
coordinates panel focus, feed delivery and notifications. [/design](../src/web/design.mjs)
uses the same component factories with fixture data and its own lifetime.

Use the [store fixture tests](../tests/browser-store.test.mjs) for selectors and transport behavior.
The [Edge smoke test](../tests/browser-smoke.mjs) uses wire fixtures for Activity and for repeated
mounts of all three views. It also checks real demo streams, dashboard navigation, links, kiosk
and the Activity fallback on an isolated live-mode instance.

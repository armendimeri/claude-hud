# Add a HUD view

The demo-only [Activity preview](../src/web/views/activity.mjs) is the example. Run
`node hud.mjs --demo` in an isolated profile with `HUD_NO_AUTOINSTALL=1` and an unused `HUD_PORT`.
Open `/?view=activity` on that instance. The same route works with `--demo=dense`.

1. Add an ES module to [`src/web/views/`](../src/web/views/) with a descriptor that has a
   `key`, an `outlet` of `page`, and a `mount(element, { store, actions, ui })` function.
   Set `demoOnly` for demo previews. Cards and Network use the existing dashboard's session
   outlet.
2. Register the descriptor in [`view-registry.mjs`](../src/web/view-registry.mjs). The
   [entry module](../src/web/entry.mjs) resolves the URL after the first full snapshot. Page outlets
   use the URL. The dashboard switch continues to own the saved Cards and Network preference.
3. Put scoped styles in [`src/web/styles/`](../src/web/styles/) and set the descriptor's
   `stylesheet` URL. List the module and stylesheet in the
   [public asset allowlist](../src/http/assets.mjs).
4. Subscribe with `store.subscribe(update)` and read `store.getSnapshot()` and
   `store.getConnection()` in the callback. Keep display filtering and joins in
   [`data/selectors.mjs`](../src/web/data/selectors.mjs). Use the shell's project and dashboard
   actions to update the URL and navigate. Return a cleanup function that unsubscribes, removes
   listeners and removes the view's DOM.

Use [store fixture tests](../tests/browser-store.test.mjs) for selectors and transport behavior.
The [Edge smoke test](../tests/browser-smoke.mjs) drives wire frames through the same store while
checking the mounted Activity view, including project focus, recovery and navigation. It also
checks the actual demo streams and the fallback on an isolated live-mode instance.

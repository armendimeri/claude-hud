/**
 * Resolve the location into what the page shell should show. Pure: the registry and the search string go in.
 *   kiosk wins over everything and always means the Network view; an unknown or missing `view` means the dashboard
 *   with its stored preference; a registered `page` outlet (Activity, Cockpit) replaces the dashboard.
 *   Activity is demo-only, so on a live HUD it falls back to the dashboard (`target` below).
 */
export function resolveRoute(search, registry) {
  const query = new URLSearchParams(search);
  const kiosk = query.has('kiosk');
  const key = kiosk ? 'network' : query.get('view');
  const descriptor = registry.get(key) || null;
  return { kiosk, project: query.get('project') || null, key, descriptor };
}

/** The surface to mount for a route once the first snapshot is known. */
export function routeTarget(route, snapshot) {
  const { descriptor } = route;
  if (descriptor?.outlet === 'page' && (!descriptor.demoOnly || snapshot?.demo !== false)) {
    return { kind: 'page', view: descriptor, id: descriptor.key };
  }
  return { kind: 'dashboard', requested: descriptor?.outlet === 'sessions' ? descriptor : null, id: 'dashboard' };
}

/** The URL of the dashboard for a location: same project and kiosk flag, no `view`. */
export function dashboardHref(href) {
  const url = new URL(href);
  url.searchParams.delete('view');
  return url.href;
}

/** The URL of the cockpit for a location. */
export function cockpitHref(href) {
  const url = new URL(href);
  url.searchParams.set('view', 'cockpit');
  return url.href;
}

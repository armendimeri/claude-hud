import { activity } from './views/activity.mjs';

// Cards and Network share the existing dashboard and its session outlet.
export function createViewRegistry(mountDashboard) {
  const views = [
    { key: 'cards', outlet: 'sessions', mount: mountDashboard },
    { key: 'network', outlet: 'sessions', mount: mountDashboard },
    activity,
  ];
  return new Map(views.map(view => [view.key, view]));
}

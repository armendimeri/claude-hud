import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const ASSET_PREFIX = '/assets/';

const SOURCE_ROOT = new URL('../', import.meta.url);
const JS = 'text/javascript; charset=utf-8';
const TYPES = new Map([
  [ASSET_PREFIX + 'entry.mjs', JS],
  [ASSET_PREFIX + 'design.mjs', JS],
  [ASSET_PREFIX + 'view-registry.mjs', JS],
  [ASSET_PREFIX + 'views/activity.mjs', JS],
  [ASSET_PREFIX + 'legacy-hud.mjs', JS],
  [ASSET_PREFIX + 'data/away.mjs', JS],
  [ASSET_PREFIX + 'data/selectors.mjs', JS],
  [ASSET_PREFIX + 'data/store.mjs', JS],
  [ASSET_PREFIX + 'data/transport.mjs', JS],
  [ASSET_PREFIX + 'styles/hud.css', 'text/css; charset=utf-8'],
  [ASSET_PREFIX + 'styles/activity.css', 'text/css; charset=utf-8'],
  [ASSET_PREFIX + 'components/dom.mjs', JS],
  [ASSET_PREFIX + 'components/format.mjs', JS],
  [ASSET_PREFIX + 'components/status.mjs', JS],
  [ASSET_PREFIX + 'components/preferences.mjs', JS],
  [ASSET_PREFIX + 'components/lifetime.mjs', JS],
  [ASSET_PREFIX + 'components/timing.mjs', JS],
  [ASSET_PREFIX + 'components/animation.mjs', JS],
  [ASSET_PREFIX + 'components/tooltip.mjs', JS],
  [ASSET_PREFIX + 'components/sessions.mjs', JS],
  [ASSET_PREFIX + 'components/geometry.mjs', JS],
  [ASSET_PREFIX + 'components/vitals.mjs', JS],
  [ASSET_PREFIX + 'components/network-map.mjs', JS],
  [ASSET_PREFIX + 'components/plans.mjs', JS],
  [ASSET_PREFIX + 'components/work-queue.mjs', JS],
  [ASSET_PREFIX + 'components/alerts.mjs', JS],
  [ASSET_PREFIX + 'components/feed.mjs', JS],
  [ASSET_PREFIX + 'components/notifications.mjs', JS],
  [ASSET_PREFIX + 'components/controls.mjs', JS],
  [ASSET_PREFIX + 'components/plan-panel.mjs', JS],
  [ASSET_PREFIX + 'components/session-panel.mjs', JS],
  [ASSET_PREFIX + 'components/page.mjs', JS],
  [ASSET_PREFIX + 'views/cards.mjs', JS],
  [ASSET_PREFIX + 'views/network.mjs', JS],
  [ASSET_PREFIX + 'styles/foundation.css', 'text/css; charset=utf-8'],
  [ASSET_PREFIX + 'styles/sessions.css', 'text/css; charset=utf-8'],
  [ASSET_PREFIX + 'styles/vitals.css', 'text/css; charset=utf-8'],
  [ASSET_PREFIX + 'styles/network.css', 'text/css; charset=utf-8'],
  [ASSET_PREFIX + 'styles/plans.css', 'text/css; charset=utf-8'],
  [ASSET_PREFIX + 'styles/chrome.css', 'text/css; charset=utf-8'],
  [ASSET_PREFIX + 'styles/layout.css', 'text/css; charset=utf-8'],
  [ASSET_PREFIX + 'styles/motion.css', 'text/css; charset=utf-8'],
  [ASSET_PREFIX + 'styles/kiosk.css', 'text/css; charset=utf-8'],
  [ASSET_PREFIX + 'styles/gallery.css', 'text/css; charset=utf-8'],
]);

export async function readPublicAsset(target) {
  const contentType = TYPES.get(target);
  if (!contentType) return null;

  try {
    const root = path.join(await realpath(SOURCE_ROOT), 'web');
    const file = await realpath(path.join(root, target.slice(ASSET_PREFIX.length)));
    const relative = path.relative(root, file);
    // Keep an allowed URL within src/web even if a file or folder is a symlink or Windows junction.
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
    return { body: await readFile(file), contentType };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

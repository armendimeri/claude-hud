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

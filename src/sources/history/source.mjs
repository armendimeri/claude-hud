import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HistoryError } from './errors.mjs';

// Trusted source opening for private history (CONTRACTS "Selection and information boundaries" 3).
// P8's resolver turns a selection into a server-side record from the live registry; this module turns that record into
// one validated, open file handle and closes it exactly once. It never searches for files and never substitutes a
// parent transcript for a missing child.

const PROVIDERS = new Set(['claude', 'codex']);
const caseFold = p => process.platform === 'win32' ? p.toLowerCase() : p;

function inside(file, root) {
  const rel = path.relative(caseFold(root), caseFold(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function realPath(p) {
  try { return await fs.realpath(p); } catch { return null; }
}

/** A generation names one physical file: replacement or rotation produces a different value. */
export function sourceGeneration(stat) {
  const identity = stat.ino ? [stat.dev, stat.ino, stat.birthtimeNs ?? stat.birthtimeMs] : ['no-inode', stat.birthtimeNs ?? stat.birthtimeMs];
  return crypto.createHash('sha256').update(identity.map(String).join(':')).digest('base64url').slice(0, 22);
}

/**
 * @param {{provider: 'claude'|'codex', files: string[], native?: {sessionId?: string, agentId?: string|null}, cwd?: string}} record
 *   `files` are the paths attached to this one selection in server-side records. Two different real files for one
 *   identity (for example two profiles claiming it) are ambiguous and make history unavailable.
 * @param {{roots: string[], open?: typeof fs.open, signal?: AbortSignal}} options  configured transcript/rollout roots.
 * @returns {Promise<{source: {provider: string, generation: string, handle: import('node:fs/promises').FileHandle,
 *   native: object|null, cwd: string|null}, close: () => Promise<void>}>}
 */
export async function openHistorySource(record, { roots, open = fs.open, signal } = {}) {
  if (!record || !PROVIDERS.has(record.provider)) throw new HistoryError('unavailable', 'unsupported format');
  const files = Array.isArray(record.files) ? record.files.filter(f => typeof f === 'string' && f) : [];
  if (!files.length) throw new HistoryError('unavailable', 'no source');
  const real = new Map();
  for (const file of files) {
    const resolved = await realPath(file);
    if (resolved) real.set(caseFold(resolved), resolved);
  }
  if (!real.size) throw new HistoryError('unavailable', 'missing');
  if (real.size > 1) throw new HistoryError('unavailable', 'conflict');
  const [file] = real.values();
  const realRoots = (await Promise.all((roots || []).map(realPath))).filter(Boolean);
  if (!realRoots.some(root => inside(file, root))) throw new HistoryError('unavailable', 'outside configured roots');
  if (!/\.jsonl$/i.test(file)) throw new HistoryError('unavailable', 'not a transcript');
  signal?.throwIfAborted();

  const handle = await open(file, 'r');
  let closed = null;
  const close = () => (closed ??= Promise.resolve(handle.close()).catch(() => {}));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new HistoryError('unavailable', 'not a file');
    // The path can be replaced between realpath and open: the open handle must be the file the path names now.
    const named = await fs.stat(file, { bigint: true });
    // Windows path stat can report dev 0 while the handle reports the volume serial: compare dev only when both do.
    const sameDevice = !opened.dev || !named.dev || opened.dev === named.dev;
    if (!sameDevice || opened.ino !== named.ino || opened.birthtimeNs !== named.birthtimeNs) {
      throw new HistoryError('unavailable', 'replaced while opening');
    }
    signal?.throwIfAborted();
    return {
      source: { provider: record.provider, generation: sourceGeneration(opened), handle, native: record.native ?? null, cwd: record.cwd ?? null },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Reference composition for P8: resolve -> open -> read -> close in finally.
 * @param {{resolve: (selection: object, options: {signal?: AbortSignal}) => Promise<object|null>,
 *   readHistory: Function, roots: Record<string, string[]>, open?: typeof fs.open}} options
 */
export function createHistoryService({ resolve, readHistory, roots, open }) {
  async function history(selection, { before = null, after = null, signal } = {}) {
    const record = await resolve(selection, { signal });
    if (!record) throw new HistoryError('unavailable', 'unknown selection');
    const { source, close } = await openHistorySource(record, { roots: roots[record.provider] ?? [], open, signal });
    try {
      return await readHistory({ source, selection, before, after, signal });
    } finally {
      await close();
    }
  }
  return { history };
}

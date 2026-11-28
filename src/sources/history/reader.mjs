import { HistoryError } from './errors.mjs';
import { ANCHOR_BYTES, anchorTag, createCursorCodec, entityTag, foldTag } from './cursor.mjs';
import { classifyClaude } from './claude.mjs';
import { classifyCodex } from './codex.mjs';

// Bounded private history over one borrowed, already validated file handle (CONTRACTS P4 -> P8 seam).
//
// readHistory({source, selection, before?, after?, signal}) -> {entries, before, after, gap}
//   source    {provider: 'claude'|'codex', generation: string, handle: FileHandle-like {read, stat}, native?, cwd?}
//             The resolver opened and validated it and closes it; this module never calls handle.close().
//   initial   newest page: anchored to the EOF snapshot taken at the start of the call. The forward boundary is
//             after the last complete (LF-terminated) line; a partial final record is left for a later `after`.
//   before    older page, scanned backwards in fixed blocks from the cursor.
//   after     newer page, scanned forwards from the cursor up to the size snapshot taken at the start of the call.
//
// Every call reads at most `scanBytes` from the file, counting the anchor reads. Lines are split on LF bytes and
// decoded only when complete, so a code point or record is never split. A record that does not fit in one call's
// budget is skipped as a whole across as many calls as needed and reported as an "oversized" gap; it is never parsed in
// pieces. A call that runs out of budget in filtered records returns a continuation cursor with zero entries.
// Pages return entries in ascending source order; ties in `at` keep source order. Entry ids bind the file generation,
// the record's byte offset and the block index, so overlapping pages deduplicate by id.

export const LIMITS = Object.freeze({ entries: 40, scanBytes: 512 * 1024, blockBytes: 64 * 1024, entryBytes: 8 * 1024 });
const CLASSIFIERS = { claude: classifyClaude, codex: classifyCodex };
const TRUNCATION = ' … [truncated]';
const FOLD_KEYS = 8;
const decoder = new TextDecoder('utf-8', { fatal: true });

function capText(text, max) {
  if (text.length * 3 <= max || Buffer.byteLength(text) <= max) return null;
  const bytes = Buffer.from(text);
  let end = max - Buffer.byteLength(TRUNCATION);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;   // cut before a continuation byte: whole code points only
  return bytes.toString('utf8', 0, end) + TRUNCATION;
}

function validSelection(selection) {
  return selection && typeof selection === 'object' && typeof selection.sessionId === 'string' && selection.sessionId
    && selection.sessionId.length <= 1024 && (selection.agentId === null
      || (typeof selection.agentId === 'string' && selection.agentId && selection.agentId.length <= 1024));
}

/**
 * @param {{summarizeTool: (name: string, input: unknown, cwd: string) => string, key?: Buffer, instance?: string,
 *   limits?: Partial<typeof LIMITS>}} options  `summarizeTool` is the existing redacted summarizer
 *   (createToolSummary(redact)); `key`/`instance` default to fresh random values for this runtime.
 */
export function createHistoryReader({ summarizeTool, key, instance, limits = {} } = {}) {
  if (typeof summarizeTool !== 'function') throw new TypeError('createHistoryReader needs the redacted tool summarizer');
  const L = { ...LIMITS, ...limits };
  if (L.scanBytes <= 4 * ANCHOR_BYTES || L.blockBytes < 1 || L.entries < 1 || L.entryBytes < 64) throw new RangeError('history limits');
  const codec = createCursorCodec({ key, instance });

  async function readHistory({ source, selection, before = null, after = null, signal } = {}) {
    if (!validSelection(selection)) throw new HistoryError('bad_request', 'selection');
    if (before != null && after != null) throw new HistoryError('bad_request', 'both cursors');
    const classify = CLASSIFIERS[source?.provider];
    if (!classify) throw new HistoryError('unavailable', 'unsupported format');
    const { handle, generation } = source;
    if (!handle || typeof handle.read !== 'function' || typeof handle.stat !== 'function' || typeof generation !== 'string' || !generation) {
      throw new HistoryError('unavailable', 'source');
    }
    const entity = entityTag(source.provider, selection);
    const direction = after != null ? 'f' : 'b';
    // Cursor validation happens before any byte is read.
    const cursor = before != null ? codec.decode(before, { entity, direction: 'b' })
      : after != null ? codec.decode(after, { entity, direction: 'f' }) : null;
    if (cursor && cursor.g !== generation) throw new HistoryError('stale_cursor', 'generation');
    signal?.throwIfAborted();

    let used = 0;
    async function read(position, length) {
      signal?.throwIfAborted();
      if (used + length > L.scanBytes) throw new Error('history read budget exceeded');   // unreachable by construction
      used += length;
      const buffer = Buffer.allocUnsafe(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
        if (!bytesRead) throw new HistoryError('stale_cursor', 'file shrank during read');
        filled += bytesRead;
      }
      signal?.throwIfAborted();
      return buffer;
    }
    const anchorAt = async offset => anchorTag(offset ? await read(Math.max(0, offset - ANCHOR_BYTES), Math.min(offset, ANCHOR_BYTES)) : Buffer.alloc(0));
    const budget = L.scanBytes - 3 * ANCHOR_BYTES;   // room for one incoming and two outgoing anchors

    const size = Number((await handle.stat()).size);
    if (cursor) {
      if (cursor.o > size) throw new HistoryError('stale_cursor', 'truncated');
      if (await anchorAt(cursor.o) !== cursor.a) throw new HistoryError('stale_cursor', 'rewritten');
    }

    const gTag = anchorTag(Buffer.from(generation)).slice(0, 6);
    const ctx = { selection, native: source.native ?? null, cwd: source.cwd ?? null, summarizeTool };
    const page = createCollector(direction, cursor?.k ?? [], L.entries);
    const onLine = (start, bytes) => {
      let end = bytes.length;
      if (end && bytes[end - 1] === 13) end--;          // CRLF
      let text;
      try { text = decoder.decode(bytes.subarray(0, end)); } catch { return page.add(start, { entries: [], gap: 'malformed' }); }
      if (start === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      if (!text.trim()) return 'more';
      const result = classify(text, ctx);
      return page.add(start, {
        ...result,
        entries: result.entries.map((entry, index) => {
          const capped = capText(entry.text, L.entryBytes);
          return { id: gTag + ':' + start + ':' + index, at: entry.at, kind: entry.kind, text: capped ?? entry.text,
            ...(capped && { truncated: true }), key: entry.key };
        }),
      });
    };

    const scan = { read, budget, block: L.blockBytes, onLine, gap: reason => page.gap(reason) };
    if (direction === 'f') {
      const end = await scanForward({ ...scan, from: cursor.o, skip: cursor.s, size });
      return page.finish({
        before: null,
        after: codec.encode({ e: entity, g: generation, d: 'f', o: end.boundary, s: end.skip, a: await anchorAt(end.boundary), k: page.keys('newest') }),
      });
    }
    const start = cursor ? { from: cursor.o, mode: cursor.s ? 'skip' : 'line' } : { from: size, mode: 'seek' };
    const end = await scanBackward({ ...scan, ...start });
    const older = end.boundary === 0 && !end.skip ? null
      : codec.encode({ e: entity, g: generation, d: 'b', o: end.boundary, s: end.skip, a: await anchorAt(end.boundary), k: page.keys('oldest') });
    let newer = null;
    if (!cursor) {
      // Initial page: catch up from after the last complete line (or keep skipping a giant unterminated tail).
      const forward = end.eofEnd ?? end.boundary;
      newer = codec.encode({ e: entity, g: generation, d: 'f', o: forward, s: end.eofEnd == null && end.skip,
        a: await anchorAt(forward), k: page.keys('newest') });
    }
    return page.finish({ before: older, after: newer });
  }

  return { readHistory, instance: codec.instance };
}

/** Collects one page: folds repeated blocks (first occurrence in source order wins), enforces the entry limit. */
function createCollector(direction, incoming, max) {
  const backward = direction === 'b';
  const suppressed = new Set(incoming);
  const list = [];            // scan order: newest first when backward
  const byTag = new Map();    // fold tag -> index in list
  const gaps = {};
  let count = 0, canonical = 0, duplicates = 0;
  const gap = reason => { gaps[reason] = (gaps[reason] || 0) + 1; };

  function add(start, result) {
    const fresh = [];
    const inRecord = new Set();
    let added = 0;
    for (const entry of result.entries) {
      const tag = entry.key ? foldTag(entry.key) : null;
      if (tag && (suppressed.has(tag) || inRecord.has(tag))) continue;   // shown on the adjacent page / earlier in this record
      if (tag) inRecord.add(tag);
      const seen = tag ? byTag.get(tag) : undefined;
      if (seen !== undefined && !backward) continue;      // a later repeat of a block already on this page
      if (seen === undefined) added++;
      fresh.push({ entry, tag, replaces: seen });
    }
    if (count && count + added > max) return 'reject';    // stop before this record; the next page starts with it
    if (result.gap) gap(result.gap);
    if (result.canonical) canonical++;
    if (result.duplicate) duplicates++;
    if (count + added > max) {                            // one record alone holds more than a page (count is 0 here)
      const overflow = count + added - max;
      fresh.length -= overflow;
      gaps.overflow = (gaps.overflow || 0) + overflow;
    }
    for (const item of backward ? fresh.reverse() : fresh) {
      if (item.replaces !== undefined) list[item.replaces] = null;   // backward: this older copy is the first occurrence
      else count++;
      const { key, ...entry } = item.entry;
      if (item.tag) byTag.set(item.tag, list.length);
      list.push({ ...entry, tag: item.tag });
    }
    return count >= max ? 'full' : 'more';
  }

  function ordered() {
    const kept = list.filter(Boolean);
    return backward ? kept.reverse() : kept;
  }

  function keys(edge) {
    const entries = ordered();
    const near = edge === 'oldest' ? entries.slice(0, FOLD_KEYS) : entries.slice(-FOLD_KEYS);
    const tags = near.map(entry => entry.tag).filter(Boolean);
    return entries.length ? tags : [...suppressed].slice(0, FOLD_KEYS);
  }

  function finish(cursors) {
    // A backward window with response-item messages but no canonical event is a format this reader does not know.
    if (backward && duplicates && !canonical) gaps.unknown = (gaps.unknown || 0) + duplicates;
    const records = Object.values(gaps).reduce((sum, n) => sum + n, 0);
    return {
      entries: ordered().map(({ tag, ...entry }) => entry),
      before: cursors.before, after: cursors.after,
      gap: records ? { records, reasons: Object.fromEntries(Object.entries(gaps).sort(([a], [b]) => a.localeCompare(b))) } : null,
    };
  }

  return { add, gap, keys, finish };
}

/**
 * Backward scan from `from`. Modes: 'seek' (initial: find the last LF; bytes after it are a partial record),
 * 'skip' (inside an oversized record: discard to the previous LF) and 'line' (collect the line ending at contentEnd).
 * Returns {boundary, skip, eofEnd?}: boundary is the offset of the oldest consumed record, or a position inside an
 * oversized record when skip is true.
 */
async function scanBackward({ read, budget, block, onLine, gap, from, mode }) {
  let pos = mode === 'line' ? Math.max(0, from - 1) : from;   // a line-mode cursor sits just after an LF
  let contentEnd = pos, boundary = from, eofEnd;
  let parts = [];
  let used = 0;
  if (from === 0) return { boundary: 0, skip: false, eofEnd: 0 };
  for (;;) {
    if (pos === 0) {
      if (mode === 'line') {
        const verdict = onLine(0, Buffer.concat(parts));
        if (verdict === 'reject') return { boundary: contentEnd + 1, skip: false, eofEnd };
      } else if (mode === 'seek') eofEnd = 0;                // no LF at all: the whole file is one partial record
      else gap('oversized');
      return { boundary: 0, skip: false, eofEnd };
    }
    if (used >= budget) break;
    const length = Math.min(block, pos, budget - used);
    const buffer = await read(pos - length, length);
    used += length;
    const base = pos - length;
    let hi = length;
    while (hi > 0) {
      const k = buffer.lastIndexOf(10, hi - 1);
      if (k < 0) break;
      const q = base + k;
      if (mode === 'line') {
        const verdict = onLine(q + 1, parts.length ? Buffer.concat([buffer.subarray(k + 1, hi), ...parts]) : buffer.subarray(k + 1, hi));
        if (verdict === 'reject') return { boundary: contentEnd + 1, skip: false, eofEnd };
        boundary = q + 1;
        if (verdict === 'full') return { boundary, skip: false, eofEnd };
      } else {
        if (mode === 'seek') eofEnd = q + 1;
        else gap('oversized');
        boundary = q + 1;
        mode = 'line';
      }
      contentEnd = q;
      parts = [];
      hi = k;
    }
    if (mode === 'line' && hi > 0) parts.unshift(buffer.subarray(0, hi));
    pos = base;
  }
  // Budget spent before the start of the file.
  if (mode === 'line' && contentEnd - pos < budget) return { boundary, skip: false, eofEnd };   // retry this record next call
  return { boundary: pos, skip: true, eofEnd };          // still seeking/skipping, or the record cannot fit in one call
}

/** Forward scan from `from` to `size`. Returns {boundary, skip} for the next forward cursor. */
async function scanForward({ read, budget, block, onLine, gap, from, skip, size }) {
  let pos = from, lineStart = from, parts = [], used = 0;
  let mode = skip ? 'skip' : 'line';
  while (pos < size && used < budget) {
    const length = Math.min(block, size - pos, budget - used);
    const buffer = await read(pos, length);
    used += length;
    let lo = 0;
    for (let k = buffer.indexOf(10, lo); k >= 0; k = buffer.indexOf(10, lo)) {
      if (mode === 'skip') { gap('oversized'); mode = 'line'; }
      else {
        const verdict = onLine(lineStart, parts.length ? Buffer.concat([...parts, buffer.subarray(lo, k)]) : buffer.subarray(lo, k));
        if (verdict === 'reject') return { boundary: lineStart, skip: false };
        if (verdict === 'full') return { boundary: pos + k + 1, skip: false };
      }
      lineStart = pos + k + 1;
      parts = [];
      lo = k + 1;
    }
    if (mode === 'line' && lo < length) parts.push(buffer.subarray(lo, length));
    pos += length;
  }
  if (mode === 'skip') return { boundary: pos, skip: true };
  // An unterminated record is retried once complete, unless it already filled a whole call's budget.
  if (pos - lineStart >= budget) return { boundary: pos, skip: true };
  return { boundary: lineStart, skip: false };
}

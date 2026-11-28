import crypto from 'node:crypto';
import { HistoryError } from './errors.mjs';

// An opaque, integrity-checked history cursor: base64url(JSON payload) + '.' + base64url(HMAC-SHA256, 16 bytes).
// The payload names the runtime instance, the entity (provider + selection tuple), the file generation, the direction,
// the byte offset, whether that offset lies inside an oversized record still being skipped, an anchor over the 32 bytes
// before the offset (detects truncate-and-rewrite under the same file identity) and up to 8 fold keys of the entries
// next to the boundary (so a repeated block split across two pages is shown once).

export const MAX_CURSOR_LENGTH = 2048;
export const ANCHOR_BYTES = 32;
const MAX_FOLD_KEYS = 8;
const b64 = buffer => Buffer.from(buffer).toString('base64url');
const digest = (...parts) => crypto.createHash('sha256').update(parts.join('\u0000')).digest();

export const entityTag = (provider, { sessionId, agentId }) => b64(digest('entity', provider, JSON.stringify([sessionId, agentId])).subarray(0, 12));
export const anchorTag = bytes => b64(crypto.createHash('sha256').update(bytes).digest().subarray(0, 8));
export const foldTag = key => b64(digest('fold', key).subarray(0, 8));

export function createCursorCodec({ key = crypto.randomBytes(32), instance = b64(crypto.randomBytes(9)) } = {}) {
  const mac = body => b64(crypto.createHmac('sha256', key).update(body).digest().subarray(0, 16));

  /** @param {{e:string,g:string,d:'b'|'f',o:number,s:boolean,a:string,k:string[]}} c */
  function encode(c) {
    const body = b64(JSON.stringify({ v: 1, i: instance, e: c.e, g: c.g, d: c.d, o: c.o, s: c.s ? 1 : 0, a: c.a,
      k: c.k.slice(0, MAX_FOLD_KEYS) }));
    return body + '.' + mac(body);
  }

  /** Validates shape, instance, signature, entity and direction. Generation/offset checks need the file (reader). */
  function decode(text, { entity, direction }) {
    if (typeof text !== 'string' || !text || text.length > MAX_CURSOR_LENGTH) throw new HistoryError('invalid_cursor', 'shape');
    const dot = text.indexOf('.');
    if (dot <= 0 || dot !== text.lastIndexOf('.')) throw new HistoryError('invalid_cursor', 'shape');
    const body = text.slice(0, dot), sig = text.slice(dot + 1);
    let c;
    try { c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new HistoryError('invalid_cursor', 'shape'); }
    if (!c || typeof c !== 'object' || c.v !== 1) throw new HistoryError('invalid_cursor', 'version');
    // A cursor from an earlier runtime instance is expired rather than forged: offer a fresh page (409).
    if (c.i !== instance) throw new HistoryError('stale_cursor', 'instance');
    const expected = Buffer.from(mac(body)), given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) throw new HistoryError('invalid_cursor', 'signature');
    if (c.e !== entity) throw new HistoryError('invalid_cursor', 'entity');
    if (c.d !== direction) throw new HistoryError('invalid_cursor', 'direction');
    if (!Number.isSafeInteger(c.o) || c.o < 0 || typeof c.g !== 'string' || typeof c.a !== 'string' || !Array.isArray(c.k)
      || c.k.length > MAX_FOLD_KEYS || !c.k.every(k => typeof k === 'string')) throw new HistoryError('invalid_cursor', 'fields');
    return { e: c.e, g: c.g, d: c.d, o: c.o, s: c.s === 1, a: c.a, k: c.k };
  }

  return { encode, decode, instance };
}

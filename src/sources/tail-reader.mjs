import fs from 'node:fs/promises';

// Track byte offsets independently for each file and decode UTF-8 only at a newline.
const TRANSCRIPT_READ_BYTES = 128 * 1024;
const fileIdentity = stat => stat.ino ? stat.dev + ':' + stat.ino : null;

export function createTailReader({ task, signal, onChange, createInfo }) {
  const tails = new Map();
  function open(file, onLine, onReset, skipLine) {
    const key = file.toLowerCase();
    let tail = tails.get(key);
    if (!tail) {
      tail = { file, offset: 0, identity: null, rest: [], reading: false, again: false,
        info: createInfo(), owner: null, onLine, onReset, skipLine };
      tails.set(key, tail);
    }
    return tail;
  }

  const read = task(async function (t) {
    if (t.reading) { t.again = true; return; }
    t.reading = true;
    let changed = false;
    try {
      do {
        t.again = false;
        if (t.identity || t.offset) {
          const stat = await fs.stat(t.file);
          if (stat.size === t.offset && fileIdentity(stat) === t.identity) continue;
        }
        const fh = await fs.open(t.file, 'r');
        try {
          // The path can be replaced between stat and open. Read against the open file's identity and size.
          const st = await fh.stat();
          const openedIdentity = fileIdentity(st);
          if (st.size < t.offset || (t.identity && openedIdentity && openedIdentity !== t.identity)) {
            t.offset = 0;
            t.rest.length = 0;
            t.info = createInfo();
            t.onReset?.(t);
            changed = true;
          }
          t.identity = openedIdentity;
          if (st.size === t.offset) continue;
          const buf = Buffer.allocUnsafe(Math.min(TRANSCRIPT_READ_BYTES, st.size - t.offset));
          while (!signal.aborted && t.offset < st.size) {
            const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, st.size - t.offset), t.offset);
            if (!bytesRead) break;
            t.offset += bytesRead;
            consume(t, buf.subarray(0, bytesRead));
            changed = true;
          }
        } finally { await fh.close(); }
      } while (t.again && !signal.aborted);
    } catch {
      // Unreadable for now. The next poll tries again.
    } finally { t.reading = false; }
    if (changed) onChange();
  });

  function consume(t, chunk) {
    let start = 0;
    for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10, start)) {
      let line = chunk.subarray(start, nl);
      if (t.rest.length) {
        t.rest.push(line);
        line = Buffer.concat(t.rest);
        t.rest.length = 0;
      }
      if (line.length && !t.skipLine?.(line)) t.onLine(t, line.toString('utf8'));
      start = nl + 1;
    }
    // The read buffer is reused. Copy only the fragments that outlive this read
    // and assemble them once, after the line's newline arrives.
    if (start < chunk.length) t.rest.push(Buffer.from(chunk.subarray(start)));
  }

  return { open, read, find: file => tails.get(file.toLowerCase()), values: () => tails.values() };
}

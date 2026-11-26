import fs from 'node:fs/promises';
import path from 'node:path';
import { pidAlive } from '../platform/windows-process.mjs';
import { isObj, str } from '../domain/tools.mjs';

async function readJson(file) { try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; } }

export function createClaudeRegistry({ roots, hostname, lifetime, processLookup, reconcile }) {
  let registryScanning = false, registryReadable = false;
  const windowsPidDomain = `win32:${hostname.toLowerCase()}`;

  const scan = lifetime.task(async function () {
    if (registryScanning) return;
    registryScanning = true;
    try {
      const entries = [];
      for (const root of roots) {
        try { for (const n of await fs.readdir(root.sessions)) entries.push([root, n]); registryReadable = true; } catch {}
      }
      const rows = [];
      if (lifetime.signal.aborted) return;
      const claims = new Map();
      for (const [root, n] of entries) {
        if (!/^\d+\.json$/.test(n)) continue;              // <pid>.json only, never *.key
        const j = await readJson(path.join(root.sessions, n));
        if (!isObj(j) || typeof j.sessionId !== 'string') continue;
        const pid = Number.isInteger(j.pid) ? j.pid : Number(n.slice(0, -5));
        const domain = str(j.pidDomain).toLowerCase();
        const procStart = (!domain || domain === windowsPidDomain) && /^\d{17,19}$/.test(str(j.procStart)) ? j.procStart : null;
        if (procStart && pidAlive(pid)) {
          if (!claims.has(pid)) claims.set(pid, new Set());
          claims.get(pid).add(procStart);
        }
        const { sessionId, cwd, name, entrypoint, version, kind, startedAt, status, statusUpdatedAt, updatedAt } = j;
        rows.push({ root, pid, procStart, sessionId, cwd, name, entrypoint, version, kind, startedAt, status, statusUpdatedAt, updatedAt });
      }
      await processLookup.refreshStarts(claims);
      if (lifetime.signal.aborted) return;
      const active = [];
      for (const row of rows) {
        const actualStart = processLookup.startOf(row.pid);
        if (row.procStart && actualStart && row.procStart !== actualStart) continue;
        active.push({ ...row, actualStart });
      }
      reconcile(active);
    } finally { registryScanning = false; }
  });

  function watch() {
    for (const root of roots) {
      lifetime.watchDirectory(root.sessions, {}, (event, file) => { if (!file || /^\d+\.json$/.test(file)) void scan(); });
    }
  }

  return { scan, watch, isReadable: () => registryReadable };
}

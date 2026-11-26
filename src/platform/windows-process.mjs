import { MINUTE_MS } from '../domain/models.mjs';

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function createWindowsProcessLookup(exec) {
  const windowsProcessStarts = new Map();

  // Claude Code records Windows process creation times as decimal FILETIME strings. Keep the full precision.
  async function refreshStarts(claims) {
    if (process.platform !== 'win32') return;
    for (const pid of windowsProcessStarts.keys()) if (!claims.has(pid)) windowsProcessStarts.delete(pid);
    const now = Date.now();
    const pending = [];
    for (const [pid, claimedStarts] of claims) {
      const cached = windowsProcessStarts.get(pid);
      if (!cached || cached.expiresAt <= now || [...claimedStarts].some(start => !cached.claims.has(start))) pending.push(pid);
    }
    if (!pending.length) return;

    const cmd = `Get-Process -Id ${pending.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { try { '{0} {1}' -f $_.Id, $_.StartTime.ToFileTimeUtc() } catch {} }`;
    const output = await new Promise(resolve => {
      exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 3000, windowsHide: true },
        (err, stdout) => resolve(err ? '' : stdout));
    });
    const starts = new Map();
    for (const line of output.split(/\r?\n/)) {
      const match = /^(\d+) (\d+)$/.exec(line.trim());
      if (match) starts.set(Number(match[1]), match[2]);
    }
    for (const pid of pending) {
      const value = starts.get(pid);
      windowsProcessStarts.set(pid, { value, claims: claims.get(pid), expiresAt: now + (value ? MINUTE_MS : 15_000) });
    }
  }

  function readParentPids(callback) {
    const cmd = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';
    exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 3000, windowsHide: true, maxBuffer: 8 << 20 }, (error, output) => {
      if (error) { callback(error); return; }
      const parent = new Map();
      for (const line of output.split(/\r?\n/)) {
        const [a, b] = line.trim().split(/\s+/).map(Number);
        if (a) parent.set(a, b);
      }
      callback(null, parent);
    });
  }

  return { refreshStarts, startOf: pid => windowsProcessStarts.get(pid)?.value, readParentPids };
}

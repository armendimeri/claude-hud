import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

// Local operator pairing and access (operator-cockpit P8, CONTRACTS "Operator access and action delivery" 1-2).
//
// `node hud.mjs operator pair` asks the running HUD for its instance nonce on a loopback-only route, then writes a
// ticket into a per-user private folder: the SHA-256 digest of a fresh 256-bit code, the instance, the port and an
// expiry five minutes away. The code itself is printed only in the invoking terminal. The browser exchanges the code
// once through POST /api/operator/pair; the HUD consumes the ticket with an atomic rename before it issues a session.
// The session is an HttpOnly, SameSite=Strict, host-only cookie scoped to /api/operator and named after the port, plus
// an anti-forgery token that a same-origin bootstrap returns to the tab. Both live only in this runtime's memory, so a
// restart, another port or another HUD instance invalidates them.

export const PAIR_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 12 * 60 * 60_000;
const MAX_SESSIONS = 16;
const MAX_FAILURES_PER_TICKET = 5;
const ATTEMPT_WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_WINDOW = 20;
const TICKET_MAX_BYTES = 1024;
const b64 = bytes => Buffer.from(bytes).toString('base64url');
const sha256 = value => crypto.createHash('sha256').update(value).digest();
const caseFold = p => process.platform === 'win32' ? p.toLowerCase() : p;

export const ticketPath = (dir, port) => path.join(dir, `pair-${port}.json`);
export const cookieName = port => `hud_operator_${port}`;
/** A stable, non-reversible tag for the operator folder, so the CLI can tell when it and the HUD disagree on it. */
export const storeTag = dir => b64(sha256('store\0' + caseFold(path.resolve(dir))).subarray(0, 12));

/** A pairing failure that the HUD and CLI can explain. `reason` never contains a secret. */
export class OperatorAccessError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'OperatorAccessError';
    this.code = code;
    this.status = status;
  }
  toJSON() { return { code: this.code, message: this.message }; }
}

const PAIRING_FAILED = () => new OperatorAccessError('pairing_failed',
  'This pairing code is not valid. Run node hud.mjs operator pair and use the new code.', 401);
const STORAGE_FAILED = detail => new OperatorAccessError('pairing_unavailable',
  'The HUD could not verify its private pairing folder, so pairing is off. The dashboard keeps working. ' + detail, 503);

// ---------------------------------------------------------------------------------------------------------------------
// Private folder

const ALLOWED_WINDOWS_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544', 'S-1-3-0']);   // SYSTEM, Administrators, CREATOR OWNER
// With HUD_OPERATOR_ACL_RESTRICT=1 (a folder this HUD just created) the inherited entries are first replaced by this
// user, SYSTEM and Administrators only: a profile folder can carry extra inherited entries (for example a sandbox group).
const ACL_SCRIPT = `$ErrorActionPreference = 'Stop'
$d = $env:HUD_OPERATOR_ACL_DIR
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($env:HUD_OPERATOR_ACL_RESTRICT -eq '1') {
  & icacls.exe $d /inheritance:r /grant:r ('*' + $me + ':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }
}
$acl = Get-Acl -LiteralPath $d
'me ' + $me
'owner ' + $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
foreach ($r in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) { 'ace ' + $r.IdentityReference.Value + ' ' + $r.AccessControlType }`;

/**
 * Reads a folder's owner and allow entries by SID (locale-independent) and accepts only this user, SYSTEM and
 * Administrators. With `restrict`, first replaces inherited entries with exactly those three.
 * @returns {Promise<string|null>}  null when private, otherwise an explanation without the path
 */
export function verifyWindowsAcl(dir, { restrict = false } = {}) {
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ACL_SCRIPT, 'utf16le').toString('base64')],
      { env: { ...process.env, HUD_OPERATOR_ACL_DIR: dir, HUD_OPERATOR_ACL_RESTRICT: restrict ? '1' : '0' }, windowsHide: true, timeout: 15_000 }, (error, stdout) => {
        if (error) return resolve('Windows did not report the folder\'s permissions.');
        let me = null, owner = null;
        const allowed = [];
        for (const line of String(stdout).split(/\r?\n/)) {
          const [kind, sid, type] = line.trim().split(' ');
          if (kind === 'me') me = sid;
          else if (kind === 'owner') owner = sid;
          else if (kind === 'ace' && type === 'Allow') allowed.push(sid);
        }
        if (!me || !owner) return resolve('Windows did not report the folder\'s permissions.');
        if (owner !== me && owner !== 'S-1-5-32-544' && owner !== 'S-1-5-18') return resolve('The folder belongs to another account.');
        if (allowed.some(sid => sid !== me && !ALLOWED_WINDOWS_SIDS.has(sid))) return resolve('Another account can open the folder.');
        resolve(null);
      });
  });
}

async function verifyPosix(dir) {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return 'The pairing path is not a plain folder.';
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return 'The folder belongs to another account.';
  if (stat.mode & 0o077) return 'Other accounts can open the folder (it needs mode 0700).';
  return null;
}

/**
 * Creates the per-user operator folder if needed, restricts a folder it just created to this account, and verifies
 * that only this account (plus SYSTEM and Administrators on Windows) can use it. An existing folder is never changed.
 * @param {string} dir
 * @param {{verifyAcl?: (dir: string, options: {restrict: boolean}) => Promise<string|null>}} [options]  Windows check.
 */
export async function ensurePrivateDir(dir, { verifyAcl = verifyWindowsAcl } = {}) {
  try {
    const created = (await fs.mkdir(dir, { recursive: true, mode: 0o700 })) !== undefined;
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw STORAGE_FAILED('The pairing path is not a plain folder.');
    if (created && process.platform !== 'win32') await fs.chmod(dir, 0o700);
    const problem = process.platform === 'win32' ? await verifyAcl(dir, { restrict: created }) : await verifyPosix(dir);
    if (problem) throw STORAGE_FAILED(problem);
  } catch (error) {
    if (error instanceof OperatorAccessError) throw error;
    throw STORAGE_FAILED('The folder could not be created or read.');
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Tickets

/** Writes a new ticket for this port, replacing any earlier one atomically. Returns the code (to print, never to store). */
export async function writeTicket(dir, { port, instance, clock = Date.now, verifyAcl } = {}) {
  await ensurePrivateDir(dir, { verifyAcl });
  const code = b64(crypto.randomBytes(32));
  const ticket = { v: 1, instance, port, digest: b64(sha256(code)), expires: clock() + PAIR_TTL_MS };
  const target = ticketPath(dir, port);
  const temp = `${target}.${b64(crypto.randomBytes(9))}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(ticket));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
  return { code, expires: ticket.expires };
}

async function readTicket(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > TICKET_MAX_BYTES) return null;
  if (process.platform !== 'win32' && ((stat.mode & 0o077) || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) return null;
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    return value && typeof value === 'object' && value.v === 1 && typeof value.digest === 'string' && typeof value.instance === 'string'
      && Number.isInteger(value.port) && Number.isFinite(value.expires) ? value : null;
  } catch {
    return null;
  }
}

const sameDigest = (a, b) => {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

// ---------------------------------------------------------------------------------------------------------------------
// Request checks

const LOOPBACK_PEER = /^(::1|(::ffff:)?127\.\d+\.\d+\.\d+)$/i;
const FORWARDED = /^(forwarded|via|x-forwarded-.*|x-real-ip|x-original-forwarded-for|x-client-ip|true-client-ip|cf-connecting-ip)$/i;

/**
 * The checks every private route shares: a loopback socket peer, an exact loopback Host for this port, no proxy
 * headers, the operator marker header, a same-origin fetch, and an Origin that matches the Host (required for writes).
 * @returns {string|null}  null when allowed, otherwise a short internal reason (never sent).
 */
export function localRequestProblem(req, port, { requireOrigin = false } = {}) {
  if (!LOOPBACK_PEER.test(req.socket.remoteAddress || '')) return 'peer';
  const host = req.headers.host || '';
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return 'host';
  if (Object.keys(req.headers).some(name => FORWARDED.test(name))) return 'forwarded';
  if (!req.headers['x-hud-operator']) return 'marker';
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return 'site';
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) return 'origin';
  if (requireOrigin && origin === undefined) return 'origin';
  return null;
}

function parseCookies(header = '') {
  const out = new Map();
  for (const part of String(header).split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Runtime access state

/**
 * @param {{dir: string, clock?: () => number, verifyAcl?: (dir: string) => Promise<string|null>}} options
 */
export function createAccess({ dir, clock = Date.now, verifyAcl } = {}) {
  const instance = b64(crypto.randomBytes(18));
  const sessions = new Map();        // sha256(cookie) -> {token, expires}
  const failures = new Map();        // ticket digest -> failed attempts
  let attempts = [];
  let pairing = Promise.resolve();
  let closed = false;

  function prune(now) {
    for (const [key, session] of sessions) if (session.expires <= now) sessions.delete(key);
    attempts = attempts.filter(at => now - at < ATTEMPT_WINDOW_MS);
  }

  async function consume(code, port) {
    const now = clock();
    prune(now);
    if (attempts.length >= MAX_ATTEMPTS_PER_WINDOW) throw new OperatorAccessError('too_many_attempts', 'Too many pairing attempts. Wait a minute and try again.', 429);
    attempts.push(now);
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw PAIRING_FAILED();
    await ensurePrivateDir(dir, { verifyAcl });
    const file = ticketPath(dir, port);
    let ticket;
    try { ticket = await readTicket(file); } catch { throw PAIRING_FAILED(); }
    if (!ticket) throw PAIRING_FAILED();
    if (ticket.instance !== instance || ticket.port !== port || ticket.expires <= now || ticket.expires > now + PAIR_TTL_MS + 60_000) {
      if (ticket.expires <= now) await fs.rm(file, { force: true }).catch(() => {});
      throw PAIRING_FAILED();
    }
    if (!sameDigest(ticket.digest, b64(sha256(code)))) {
      const count = (failures.get(ticket.digest) || 0) + 1;
      failures.set(ticket.digest, count);
      if (count >= MAX_FAILURES_PER_TICKET) await fs.rm(file, { force: true }).catch(() => {});
      throw PAIRING_FAILED();
    }
    // Consume atomically: only one rename of this ticket can succeed, in this process or any other.
    const claimed = `${file}.${b64(crypto.randomBytes(9))}.claimed`;
    try { await fs.rename(file, claimed); } catch { throw PAIRING_FAILED(); }
    try {
      const again = await readTicket(claimed);   // the ticket may have been replaced between read and rename
      if (!again || !sameDigest(again.digest, ticket.digest) || again.instance !== instance) throw PAIRING_FAILED();
    } finally {
      await fs.rm(claimed, { force: true }).catch(() => {});
    }
    failures.delete(ticket.digest);
    if (closed) throw new OperatorAccessError('closing', 'The HUD is closing.', 503);
    const cookie = b64(crypto.randomBytes(32));
    const session = { token: b64(crypto.randomBytes(32)), expires: now + SESSION_TTL_MS };
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    sessions.set(b64(sha256(cookie)), session);
    return { cookie, expires: session.expires };
  }

  return {
    instance,
    /** What the loopback-only instance route returns to the CLI. */
    describe: port => ({ instance, port, store: storeTag(dir) }),
    /** Serialized in this process; the rename makes it atomic across processes. */
    pair(code, port) {
      if (closed) return Promise.reject(new OperatorAccessError('closing', 'The HUD is closing.', 503));
      const result = pairing.then(() => consume(code, port));
      pairing = result.catch(() => {});
      return result;
    },
    cookieHeader: (port, { cookie, expires }) => `${cookieName(port)}=${cookie}; Path=/api/operator; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.floor((expires - clock()) / 1000))}`,
    /** @returns {{token: string, expires: number}|null} */
    session(req, port) {
      if (closed) return null;
      const value = parseCookies(req.headers.cookie).get(cookieName(port));
      if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
      const session = sessions.get(b64(sha256(value)));
      if (!session) return null;
      if (session.expires <= clock()) { sessions.delete(b64(sha256(value))); return null; }
      return session;
    },
    tokenMatches: (session, value) => typeof value === 'string' && sameDigest(session.token, value),
    async close(port) {
      closed = true;
      sessions.clear();
      failures.clear();
      if (!port) return;
      // Remove an unused ticket for this instance so it cannot outlive the runtime that it names.
      const file = ticketPath(dir, port);
      try {
        const ticket = await readTicket(file);
        if (ticket?.instance === instance) await fs.rm(file, { force: true });
      } catch {}
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// CLI: node hud.mjs operator pair [--port=<n>]

export async function operatorCommand(args, config, { fetch: fetchImpl = fetch, log = console.log, error = console.error } = {}) {
  const [sub, ...rest] = args;
  if (sub !== 'pair') {
    error('Usage: node hud.mjs operator pair [--port=<n>]');
    return 1;
  }
  const portArg = rest.find(arg => arg.startsWith('--port='));
  const port = portArg ? Number(portArg.slice(7)) : config.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    error('Use --port=<n> with a port between 1 and 65535.');
    return 1;
  }
  let described;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/operator/instance`, {
      headers: { 'x-hud-operator': '1' }, signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    described = res.ok ? await res.json() : null;
    if (!res.ok && res.status !== 404) {
      const body = described ?? await res.json().catch(() => null);
      error(`The HUD on port ${port} refused pairing: ${body?.message || 'HTTP ' + res.status}`);
      return 1;
    }
  } catch {
    error(`No HUD answered on http://127.0.0.1:${port}. Start it with node hud.mjs (or schtasks /run /tn "Claude HUD"), `
      + 'or pass --port=<n> (HUD_PORT) for a HUD on another port.');
    return 1;
  }
  if (!described || typeof described.instance !== 'string' || described.port !== port) {
    error(`The program on port ${port} is not a HUD that supports operator pairing.`);
    return 1;
  }
  if (described.store !== storeTag(config.operatorDir)) {
    error('The running HUD keeps pairing tickets in a different folder than this terminal. Run this command with the same '
      + 'HUD_OPERATOR_DIR (and the same user account) as the HUD.');
    return 1;
  }
  let ticket;
  try {
    ticket = await writeTicket(config.operatorDir, { port, instance: described.instance });
  } catch (e) {
    error(e instanceof OperatorAccessError
      ? `${e.message}\nFolder: ${config.operatorDir}`
      : `Could not write the pairing ticket: ${e.code || e.message}`);
    return 1;
  }
  const minutes = Math.round(PAIR_TTL_MS / 60_000);
  log(`Pairing code for the HUD on http://127.0.0.1:${port} (use once, within ${minutes} minutes):\n\n  ${ticket.code}\n\n`
    + 'Enter it in the HUD on this PC when it asks to pair. Do not share it. Running this command again replaces the code.');
  return 0;
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { isObj } from '../domain/tools.mjs';

// Recognise both hook commands even if the HUD folder has moved.
const HOOK_COMMAND = `node "${fileURLToPath(new URL('../../hud-hook.mjs', import.meta.url)).replace(/\\/g, '/')}"`;
const OUR_HOOK_RE = /^node "[^"]*[\\/]hud(?:\.mjs" hook|-hook\.mjs")$/;
const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact'];
const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const SYNC_EVENTS = new Set(['SessionEnd']);   // async hooks can be killed when a session exits

function pad2(n) { return String(n).padStart(2, '0'); }

function isOurHook(h) { return isObj(h) && h.type === 'command' && typeof h.command === 'string' && (h.command === HOOK_COMMAND || OUR_HOOK_RE.test(h.command)); }
function ourGroup(event) {
  const handler = { type: 'command', command: HOOK_COMMAND, timeout: 2 };
  if (!SYNC_EVENTS.has(event)) handler.async = true;
  return MATCHER_EVENTS.has(event) ? { matcher: '*', hooks: [handler] } : { hooks: [handler] };
}
function removeOurs(groups) {
  const out = [];
  for (const g of groups) {
    if (!isObj(g) || !Array.isArray(g.hooks)) { out.push(g); continue; }
    const kept = g.hooks.filter(h => !isOurHook(h));
    if (kept.length === g.hooks.length) out.push(g);
    else if (kept.length) out.push({ ...g, hooks: kept });
  }
  return out;
}
function countOurs(groups) { return groups.reduce((n, g) => n + (Array.isArray(g?.hooks) ? g.hooks.filter(isOurHook).length : 0), 0); }
class SettingsError extends Error {}   // a settings.json the HUD will not touch; the message says why
function readSettingsText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function parseSettings(raw, file) {
  let obj;
  try { obj = raw == null ? {} : JSON.parse(raw.replace(/^﻿/, '')); } catch { throw new SettingsError(`${file} is not valid JSON. Nothing was changed.`); }
  if (!isObj(obj)) throw new SettingsError(`${file} does not hold a JSON object. Nothing was changed.`);
  if (obj.hooks !== undefined && !isObj(obj.hooks)) throw new SettingsError(`"hooks" in ${file} is not an object. Nothing was changed.`);
  return obj;
}
function formatLike(raw, obj) {
  const indent = (/^([ \t]+)"/m.exec(raw || '') || [null, '  '])[1];
  let out = JSON.stringify(obj, null, indent);
  if (raw == null || /\n$/.test(raw)) out += '\n';
  if (raw?.includes('\r\n')) out = out.replace(/\n/g, '\r\n');
  if (raw?.startsWith('﻿')) out = '﻿' + out;
  return out;
}
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}
function backupSettings(raw, file) {
  const base = `${file}.hud-backup-${stamp()}`;
  for (let n = 1; ; n++) {
    const backup = n === 1 ? base : `${base}-${n}`;
    try { fs.writeFileSync(backup, raw, { flag: 'wx' }); return backup; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}
function writeSettings(text, file) {
  const tmp = `${file}.hud-tmp`;
  fs.writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 10) { fs.writeFileSync(file, text); fs.rmSync(tmp, { force: true }); return; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);   // the file can be briefly locked by a reader
    }
  }
}

/** Puts the HUD's hooks into one settings.json (backup first). Returns { changed, backup }; throws SettingsError. */
function installInto(file) {
  const raw = readSettingsText(file);
  const obj = parseSettings(raw, file);
  const next = structuredClone(obj);
  next.hooks = next.hooks ? next.hooks : {};
  for (const ev of HOOK_EVENTS) {
    const want = ourGroup(ev);
    const groups = next.hooks[ev] ?? [];
    if (!Array.isArray(groups)) throw new SettingsError(`"hooks.${ev}" in ${file} is not a list. Nothing was changed.`);
    const ok = countOurs(groups) === 1 && groups.some(g => isDeepStrictEqual(g, want));
    next.hooks[ev] = ok ? groups : [...removeOurs(groups), want];
  }
  if (isDeepStrictEqual(next, obj)) return { changed: false, backup: null };
  const backup = raw == null ? null : backupSettings(raw, file);
  writeSettings(formatLike(raw, next), file);
  return { changed: true, backup };
}

/** `node hud.mjs install`: every folder the HUD watches, so the page never says "Hooks off" for one of them. */
function install(ROOTS) {
  let bad = 0;
  for (const root of ROOTS) {
    try {
      const { changed, backup } = installInto(root.settings);
      if (!changed) { console.log(`Claude HUD hooks are already installed in ${root.settings}. It was not changed.`); continue; }
      console.log(`Installed Claude HUD hooks for ${HOOK_EVENTS.length} events in ${root.settings}`);
      if (backup) console.log(`Backup of the previous file: ${backup}`);
    } catch (e) { bad++; console.error(e instanceof SettingsError ? e.message : `${root.settings}: ${e.message}`); }
  }
  console.log(`Hook command: ${HOOK_COMMAND}`);
  console.log('Open sessions pick the change up by themselves. Remove the hooks with: node hud.mjs uninstall');
  return bad ? 1 : 0;
}

/**
 * Run when the HUD starts, so the hooks need no command: a folder without them (a new `~/.claude-*`, or a moved
 * HUD) gets them now. Older command hooks are replaced here too. HUD_NO_AUTOINSTALL=1 turns it off.
 */
function autoInstall(ROOTS) {
  for (const root of ROOTS) {
    try {
      const { changed, backup } = installInto(root.settings);
      if (changed) console.log(`Installed the HUD's hooks in ${root.settings}${backup ? ` (backup: ${backup})` : ''}`);
    } catch (e) { console.error(`Could not install the HUD's hooks in ${root.settings}: ${e.message}`); }
  }
}

function uninstallFrom(file) {
  const raw = readSettingsText(file);
  if (raw == null) return { removed: 0, note: `No ${file}: nothing to remove.` };
  const obj = parseSettings(raw, file);
  if (!obj.hooks) return { removed: 0, note: `No hooks in ${file}: nothing to remove.` };
  const next = structuredClone(obj);
  let removed = 0;
  for (const ev of Object.keys(next.hooks)) {
    const groups = next.hooks[ev];
    if (!Array.isArray(groups)) continue;
    const n = countOurs(groups);
    if (!n) continue;
    removed += n;
    const kept = removeOurs(groups);
    if (kept.length) next.hooks[ev] = kept; else delete next.hooks[ev];
  }
  if (!removed) return { removed: 0, note: `No Claude HUD hooks found in ${file}. It was not changed.` };
  const emptied = Object.keys(next.hooks).length === 0;
  const withoutKey = structuredClone(next);
  if (emptied) delete withoutKey.hooks;
  // Restore the exact bytes of a backup when it holds this same content (keeps the file byte-identical).
  let text = null, from = null;
  const dir = path.dirname(file), name = path.basename(file);
  const backups = fs.readdirSync(dir).filter(f => f.startsWith(`${name}.hud-backup-`)).sort().reverse();
  for (const f of backups) {
    const b = readSettingsTextAt(path.join(dir, f));
    let parsed;
    try { parsed = JSON.parse(b.replace(/^﻿/, '')); } catch { continue; }
    if (isDeepStrictEqual(parsed, withoutKey) || (emptied && isDeepStrictEqual(parsed, next))) { text = b; from = f; break; }
  }
  const backup = backupSettings(raw, file);
  writeSettings(text ?? formatLike(raw, withoutKey), file);
  return { removed, from, backup };
}

/** `node hud.mjs uninstall`: every watched folder. A running HUD does not put the hooks back (it only does at start). */
function uninstall(ROOTS) {
  let bad = 0;
  for (const root of ROOTS) {
    try {
      const r = uninstallFrom(root.settings);
      if (r.note) { console.log(r.note); continue; }
      console.log(`Removed ${r.removed} Claude HUD hook entr${r.removed === 1 ? 'y' : 'ies'} from ${root.settings}`);
      if (r.from) console.log(`The file now matches ${r.from} byte for byte.`);
      console.log(`Backup of the previous file: ${r.backup}`);
    } catch (e) { bad++; console.error(e instanceof SettingsError ? e.message : `${root.settings}: ${e.message}`); }
  }
  console.log('The HUD puts the hooks back each time it starts. Turn that off with HUD_NO_AUTOINSTALL=1, and remove autostart: node hud.mjs autostart off');
  return bad ? 1 : 0;
}
function readSettingsTextAt(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }

export { HOOK_COMMAND, HOOK_EVENTS, autoInstall, backupSettings, formatLike, install, installInto, isOurHook,
  ourGroup, parseSettings, removeOurs, uninstall, uninstallFrom };

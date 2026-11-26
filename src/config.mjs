import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOOPBACK, portFrom } from '../hud-hook.mjs';

export const VERSION = '0.3.0';

/** Discover profiles once per configuration. The engine keeps mutable flags on its own copies. */
export function readConfig({ env = process.env, argv = process.argv.slice(2), home = os.homedir(), hostname = os.hostname() } = {}) {
  const lan = argv.includes('--lan') || env.HUD_LAN === '1';
  const configDir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : null;
  const codexRoots = [...new Set([
    env.CODEX_HOME || path.join(home, '.codex'),
    ...splitPaths(env.HUD_CODEX_DIRS),
  ].map(dir => path.resolve(dir.trim())))];

  return {
    home, hostname, lan, host: lan ? '0.0.0.0' : LOOPBACK,
    port: portFrom(env.HUD_PORT) ?? 7777,
    roots: discoverClaudeRoots(home, configDir, env.HUD_CLAUDE_DIRS),
    codexRoots,
    noAutoInstall: env.HUD_NO_AUTOINSTALL === '1',
    acceptUsage: env.HUD_ACCEPT_USAGE === '1',
    recordFile: env.HUD_RECORD ? path.resolve(env.HUD_RECORD) : null,
    bedrockRegion: (env.HUD_BEDROCK_REGION || '').trim(),
    pushUrl: env.HUD_PUSH_URL?.trim(),
    unclaimedMs: positiveNumber(env.HUD_UNCLAIMED_MS, 3 * 60_000),
    stalledMs: positiveNumber(env.HUD_STALLED_MS, 30 * 60_000),
  };
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return number > 0 ? number : fallback;
}

function splitPaths(value = '') {
  return value.split(path.delimiter).map(dir => dir.trim()).filter(Boolean);
}

function discoverClaudeRoots(home, configDir, extraDirs) {
  const found = new Map();
  const add = (dir, json) => {
    const d = path.resolve(dir);
    if (!found.has(d.toLowerCase())) {
      found.set(d.toLowerCase(), {
        dir: d,
        sessions: path.join(d, 'sessions'),
        projects: path.join(d, 'projects'),
        settings: path.join(d, 'settings.json'),
        json: json ?? path.join(d, '.claude.json'),
      });
    }
  };
  add(configDir ?? path.join(home, '.claude'), path.join(configDir ?? home, '.claude.json'));
  for (const dir of splitPaths(extraDirs)) add(dir);
  try {
    for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\.claude-[\w.-]+$/.test(entry.name)) continue;
      const dir = path.join(home, entry.name);
      if (fs.existsSync(path.join(dir, 'sessions')) || fs.existsSync(path.join(dir, 'projects'))) add(dir);
    }
  } catch {}
  return [...found.values()];
}

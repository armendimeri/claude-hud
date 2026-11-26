import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { isObj } from '../domain/tools.mjs';

function readJsonSync(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }

export function createAccountSource({ roots, lifetime, isOurHook, onAccount, onSettings }) {
  const readAccount = lifetime.task(async function () {
    let u = null, halfWritten = false;
    for (const root of roots) {      // a Bedrock folder has no subscription usage; the first folder that has it is the account
      try { u = JSON.parse((await fsp.readFile(root.json, 'utf8')).replace(/^\uFEFF/, ''))?.cachedUsageUtilization; } catch (e) { if (e instanceof SyntaxError) halfWritten = true; }
      if (isObj(u)) break;
    }
    if (!isObj(u) && halfWritten) return;   // keep the last value
    onAccount(isObj(u) ? u : null);
  });
  function readSettingsFlags() {
    for (const root of roots) {
      const j = readJsonSync(root.settings);
      const v = j?.env?.CLAUDE_CODE_USE_BEDROCK;
      root.bedrock = v === true || v === 1 || /^(1|true|yes)$/i.test(String(v ?? ''));
      root.hooks = isObj(j?.hooks) && Object.values(j.hooks).some(arr => Array.isArray(arr) && arr.some(g => Array.isArray(g?.hooks) && g.hooks.some(isOurHook)));
    }
    onSettings(roots.every(r => r.hooks));
  }

  function start() {
    readSettingsFlags();
    void readAccount();
    for (const root of roots) {
      lifetime.watchFile(root.settings, { interval: 5000 }, readSettingsFlags);
      lifetime.watchFile(root.json, { interval: 10_000 }, readAccount);
    }
  }

  return { start };
}

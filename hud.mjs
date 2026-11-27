#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function isMain() {
  try { return process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; }
  catch { return false; }
}

let createHudRuntime;
if (isMain()) {
  const argv = process.argv.slice(2);
  const args = argv.filter(arg => arg !== '--lan');
  if (args[0] === 'hook') {
    (await import('./hud-hook.mjs')).runHook();
  } else {
    const { runCommand } = await import('./src/cli/commands.mjs');
    const status = await runCommand(argv, args);
    if (status !== undefined) process.exitCode = status;
  }
} else {
  const [{ readConfig }, { createLiveRuntime }, { createDemoRuntime }] = await Promise.all([
    import('./src/config.mjs'),
    import('./src/app/live.mjs'),
    import('./src/demo/runtime.mjs'),
  ]);
  createHudRuntime = (config = readConfig(), demoMode = false) => demoMode
    ? createDemoRuntime(config, demoMode)
    : createLiveRuntime(config);
}

export { createHudRuntime };

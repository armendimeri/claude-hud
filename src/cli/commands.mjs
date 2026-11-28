import os from 'node:os';
import { readConfig, VERSION } from '../config.mjs';

async function serve(config, demoMode) {
  const [{ createHttpServer }, runtimeModule] = await Promise.all([
    import('../http/server.mjs'),
    demoMode ? import('../demo/runtime.mjs') : import('../app/live.mjs'),
  ]);
  const { lan, host, port } = config;
  const runtime = demoMode ? runtimeModule.createDemoRuntime(config, demoMode) : runtimeModule.createLiveRuntime(config);
  const http = createHttpServer({ config, source: runtime.source, writer: runtime.writer, operator: runtime.operator });
  const close = () => Promise.all([http.close(), runtime.close()]);
  process.on('uncaughtException', error => console.error('error:', error));
  process.on('unhandledRejection', error => console.error('error:', error));
  try {
    await http.start();
    runtime.start();
  } catch (error) {
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${port} is in use: is the HUD already running? (HUD_PORT picks another port)`
      : `Server error: ${error.message}`);
    process.exitCode = 1;
    await close();
    return;
  }
  process.once('SIGINT', () => { process.exitCode = 130; void close(); });
  process.once('SIGTERM', () => { process.exitCode = 143; void close(); });
  console.log(`Claude HUD ${VERSION} on http://${lan ? 'localhost' : host}:${port}${demoMode ? ` (demo${demoMode === 'dense' ? ', dense' : ''})` : ''}`);
  if (!demoMode) {
    console.log(`Watching Claude Code in: ${config.roots.map(root => root.dir).join('  ')}`);
    console.log(`Watching Codex in: ${config.codexRoots.join('  ')}`);
  }
  if (!lan) return;
  const urls = Object.values(os.networkInterfaces()).flat()
    .filter(address => address?.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.'))
    .map(address => `http://${address.address}:${port}`);
  console.log(`Open on this network (view only): ${urls.join('  ') || 'no network address found'}`);
}

function helpText(PORT) {
  return `Claude HUD ${VERSION}: a live dashboard of Claude Code and Codex sessions on this PC.

  node hud.mjs                 serve on http://127.0.0.1:${PORT} (HUD_PORT picks another port)
  node hud.mjs --lan           also open it to other devices on the network, view only (or set HUD_LAN=1)
  node hud.mjs --demo          serve simulated sessions, subagents, plans and events
  node hud.mjs --demo=dense    the same with 24 sessions
  node hud.mjs install         add the HUD's hooks to every watched Claude Code folder's settings.json (backup first;
                               safe to repeat; the HUD also does this by itself each time it starts)
  node hud.mjs uninstall       remove only the HUD's hooks from those files (HUD_NO_AUTOINSTALL=1 stops the re-adding)
  node hud.mjs autostart on|off  start the HUD at logon (Task Scheduler, no window), or stop doing so
                               (add --lan to autostart on to start it open to the network)
  node hud.mjs operator pair    print a one-time code (5 minutes) that pairs a browser on this PC with the running HUD
                               for private history (add --port=<n> for a HUD on another port)
  node hud.mjs lint [repo] [--json]  check a repository against the agent workflow standard
  node hud.mjs selftest        check the model normaliser, redaction and plan parser
  node hud-hook.mjs             the silent hook forwarder (node hud.mjs hook still works)

  HUD_RECORD=<file>            while serving, also append each hook event received, redacted, to <file> as one
                               JSON line (off unless set; for building tests)`;
}

export async function runCommand(argv, args) {
  const [command, argument] = args;
  switch (command) {
    case undefined:
      return serve(readConfig({ argv }), false);
    case '--demo':
    case '--demo=dense':
      return serve(readConfig({ argv }), command === '--demo=dense' ? 'dense' : 'demo');
    case 'install':
    case 'uninstall':
      return (await import('./hook-settings.mjs'))[command](readConfig({ argv }).roots);
    case 'autostart':
      return (await import('../platform/windows-autostart.mjs')).autostart(argument, readConfig({ argv }));
    case 'lint':
      return (await import('./lint.mjs')).lint(args.slice(1));
    case 'operator':
      return (await import('../operator/access.mjs')).operatorCommand(args.slice(1), readConfig({ argv }));
    case 'selftest':
      return (await import('./selftest.mjs')).selftest(readConfig({ argv }));
    case 'help':
    case '--help':
    case '-h':
      console.log(helpText(readConfig({ argv }).port));
      return 0;
    default:
      console.error('Unknown command: ' + command + '\n\n' + helpText(readConfig({ argv }).port));
      return 1;
  }
}

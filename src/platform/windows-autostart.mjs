import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { oneLine } from '../domain/tools.mjs';

const SCRIPT = fileURLToPath(new URL('../../hud.mjs', import.meta.url));
const run = promisify(execFile);

// autostart on|off (D8): a Task Scheduler task at logon. conhost --headless keeps the console window hidden.

export function scheduledTaskScript(arg, { port: PORT, lan: LAN }) {
  const q = s => `'${String(s).replace(/'/g, "''")}'`;
  const task = 'Claude HUD';
  let script;
  if (arg === 'on') {
    script = `$ErrorActionPreference = 'Stop'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\\conhost.exe') -Argument ${q(`--headless "${process.execPath}" "${SCRIPT}"${LAN ? ' --lan' : ''}`)} -WorkingDirectory ${q(path.dirname(SCRIPT))}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName ${q(task)} -Description 'Starts the Claude HUD dashboard (port ${PORT}${LAN ? ', open to the local network' : ', this PC only'}) at logon, without a window.' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
'Autostart is on: the task "${task}" starts the HUD at logon. Start it now with: schtasks /run /tn "${task}"'`;
  } else if (arg === 'off') {
    script = `if (Get-ScheduledTask -TaskName ${q(task)} -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName ${q(task)} -Confirm:$false; 'Autostart is off: the task "${task}" was removed. A HUD that is running keeps running.' } else { 'Autostart was already off.' }`;
  } else if (!arg || arg === 'status') {
    script = `$t = Get-ScheduledTask -TaskName ${q(task)} -ErrorAction SilentlyContinue; if ($t) { 'Autostart is on (task state: ' + $t.State + ').' } else { 'Autostart is off.' }`;
  }
  return script;
}

export async function autostart(arg, config) {
  if (process.platform !== 'win32') {
    console.error('autostart is only available on Windows.');
    return 1;
  }
  const script = scheduledTaskScript(arg, config);
  if (!script) {
    console.error('Usage: node hud.mjs autostart on|off');
    return 1;
  }
  try {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30_000 });
    console.log(stdout.trim());
    return 0;
  } catch (error) {
    console.error('autostart ' + (arg || 'status') + ' failed: ' + (oneLine(error.stderr) || error.message));
    return 1;
  }
}

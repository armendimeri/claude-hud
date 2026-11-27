# Claude HUD architecture

Claude HUD runs directly on Node.js 22 with native ES modules. The two root paths are the
deployment entry points. The CLI loads the requested command, and the standalone hook
uses only Node built-ins. The legacy `node hud.mjs hook` command still forwards events.

## Runtime and browser

| Area | Ownership |
|---|---|
| `src/cli/` and `src/config.mjs` | Dispatch commands, resolve environment and profile settings, and install hooks. `src/platform/` owns Windows process identity and Task Scheduler integration. |
| `src/sources/` | Read Claude registry entries and transcripts, Codex rollouts, projects, plans, account usage and external usage. The tail reader keeps byte offsets, file identity and incomplete UTF-8 records together. It resets when it observes truncation or a replacement. |
| `src/domain/` | Resolve sessions, subagents, usage, alerts, board links and work clocks from source data. Windows registry liveness compares decimal process creation times exactly when available and accepts legacy entries that lack them. |
| `src/app/` and `src/demo/` | Compose a fresh live or demo engine. Each instance owns its timers, watchers, feed and publisher. Demo and live use the same HTTP and projection code. |
| `src/http/` and `src/contract/` | Serve public assets and the JSON and SSE contract. The HTTP layer reads the projected snapshot through `readSnapshot()` and `subscribeUpdates()` and routes accepted ingress through a separate writer. |
| `src/web/` | The page shell owns the connection, preferences and navigation. The store combines independent frame types into a complete snapshot. Views subscribe to the store, render with shared components and clean up when unmounted. |

The runtime batches writes, advances board clocks and alert latches, then commits a redacted
snapshot and its new feed lines together. Reading state or opening a stream has no effect on
those transitions. Closing a runtime releases its subscriptions, watchers and timers. The
HTTP layer closes its SSE connections separately. [Snapshot contract](../src/contract/snapshot.mjs)

`GET /api/state` returns the whole snapshot. Each SSE connection begins with a full `state`
frame carrying `full: true`. Later `state` frames omit `plans` and `feed`. A `plans` frame replaces the
plan array, and `event` delivers a redacted feed line. Board links live in the session and board
state and can change independently of a plan replacement. The browser reseeds on reconnect
and reconciles feed history across connections. [SSE implementation](../src/http/sse.mjs)

The shared tail reader decodes complete records and keeps the byte offset and file identity
together. The Claude adapter can discard large, recognized metadata records before decoding
the whole line. Small API model records still use the transcript's original character limit,
including multibyte input. Codex discovery uses the tail reader's existing file check for
known rollouts.

Board discovery checks both a board file and its companion before reusing a parsed record.
The publisher and SSE encoder reuse the unchanged plan payload across session updates.
The redaction cache limits both the size of a cached string and its total character count.
Tool summaries redact the full input before truncating and copy short display strings
from large transcript inputs.

The asset allowlist serves browser files from `src/web/`. Keep raw transcripts, local settings
and server modules outside it. See the view guide for the Activity example, its fixture transport,
and the browser checks. [Add a HUD view](adding-a-view.md)

## Verification

Use temporary profiles for fixture runs. The contract fixtures exercise live-mode collection,
both demo modes, settings migration and the distribution from another working directory.
Edge smoke opens the dashboard, kiosk, gallery and Activity preview with isolated fixture data.

```powershell
$env:HUD_NO_AUTOINSTALL = '1'
node hud.mjs selftest
node --test tests/
node tests/browser-smoke.mjs
node hud.mjs lint .
node tests/tools/stream-size.mjs --demo=dense --seconds=30
node tests/tools/stream-size.mjs --baseline --seconds=30
node tests/tools/stream-size.mjs --hooks
```

The dense-demo budget is 30,000 bytes per later state frame, including SSE framing. On Windows,
run the P1 fixture workload from a fresh archive of `5c1a51c` and the candidate under the same
process permissions. The workload has 16 Claude and eight Codex sessions, 256 transcript
records per session, one board and one SSE subscriber. Compare the median of seven launches
to the first full frame and the lifetime peak working set. The tolerances are +100 ms and +10%.
The standalone hook budget is +15 ms p95 over bare Node across 30 interleaved launches per
command. The receiver must get all 60 synthetic posts and both hook commands must exit 0
silently. [Benchmark harness](../tests/tools/stream-size.mjs)

For a release comparison, sample both builds for ten minutes against the same live folders
with auto-install, recording, external usage and push disabled. Use loopback, with port 7790 for
the candidate and a separate free port for the baseline. Use the same polling cadence and one
SSE subscriber per build, and report only aggregate observations. Calculate CPU as processor
seconds divided by elapsed seconds on one core. Report mean CPU, peak rolling 30-second CPU
and lifetime peak working set against the 1% mean CPU and 150 MB limits. Track visible ended
cards separately from removals, and check board links and feed delivery during the run.

## Windows deployment and rollback

Build a ZIP in the checkout at the chosen revision. Extract the archive into a separate folder and keep
the previous installation available for rollback. The entry paths, imported modules and browser
assets must come from the same revision.

```powershell
git archive --format=zip --prefix=claude-hud/ -o ../claude-hud.zip HEAD
Expand-Archive -LiteralPath ../claude-hud.zip -DestinationPath C:/staging/hud-release
$candidateEntry = 'C:/staging/hud-release/claude-hud/hud.mjs'
$env:HUD_PORT = '7790'
$env:HUD_NO_AUTOINSTALL = '1'
node $candidateEntry selftest
node $candidateEntry --demo
```

Run the Node commands from any working directory after extraction. Open the isolated HUD on
`http://127.0.0.1:7790/` and verify that `/api/health`, `/api/state`, `/design` and the browser
assets load. Stop the isolated instance before reusing port 7790. The staged verification
exercises the registrar's generated task action, including the installed path, working directory
and LAN flag. It also exercises install and rollback against disposable settings.

After owner approval, use a fresh PowerShell session with the normal production environment.
Save the current task definition for rollback. The following example preserves the existing
LAN mode on port 7777.

```powershell
$ErrorActionPreference = 'Stop'
$taskName = 'Claude HUD'
$candidateEntry = 'C:/staging/hud-release/claude-hud/hud.mjs'
$hudTaskBackup = 'C:/staging/claude-hud-previous-task.xml'

function Wait-HudHealth {
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        try {
            return Invoke-RestMethod -Uri 'http://127.0.0.1:7777/api/health' -TimeoutSec 2
        } catch {
            Start-Sleep -Seconds 1
        }
    }
    throw 'Claude HUD did not answer on port 7777.'
}

Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath $hudTaskBackup -Encoding Unicode
Stop-ScheduledTask -TaskName $taskName
node $candidateEntry autostart on --lan
if ($LASTEXITCODE -ne 0) { throw 'Claude HUD task registration failed.' }
Start-ScheduledTask -TaskName $taskName
Wait-HudHealth
```

Inspect the task action for the target entry and working directory. Open the dashboard and
confirm a fresh Claude action produces live hook activity. The runtime installs or migrates
hook paths on normal startup and keeps backups of changed settings.

To roll back, stop the candidate task, restore the saved task definition and restart it.

```powershell
Stop-ScheduledTask -TaskName $taskName
Register-ScheduledTask -TaskName $taskName -Xml (Get-Content -LiteralPath $hudTaskBackup -Raw) -Force
Start-ScheduledTask -TaskName $taskName
Wait-HudHealth
```

Confirm the restored task points to the prior complete installation and a fresh Claude action
reaches it. Its normal startup restores the previous hook path. If settings need manual
restoration, use the migration backup for each changed profile and account for settings edits made
since the backup. [Owner checks](checks.md)

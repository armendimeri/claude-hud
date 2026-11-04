# Plan: Codex support

Status: **done** · Written 2026-11-04 · Deployed 2026-11-04

Add automatic local Codex monitoring alongside Claude Code while keeping the single-file, Node built-ins-only deployment.

| ID | Item | State | Notes |
|---|---|---|---|
| P1 | Discover and parse Codex sessions | accepted | CODEX_HOME and extra roots; incremental reads, watcher and polling fallback. |
| P2 | Integrate Codex into cards and network | accepted | Agent labels, OpenAI badge, reported context, tools, activity, nested subagents. |
| P3 | Regression and integration tests | accepted | 47 self-tests and 7 integration tests passed; Edge cards/network render without JS errors. |
| P4 | Redeploy and verify local installation | accepted | Restarted existing Claude HUD task; version 0.2.0 healthy on port 7777, --lan and autostart preserved. |

Implementation decisions:
- Read only Codex session rollouts, never auth.json or configuration secrets. No model/API calls.
- Use local logs for automatic attachment; do not install or trust Codex hooks. Official hook reference: https://learn.chatgpt.com/docs/hooks.
- Namespace Codex IDs so Claude and Codex cannot collide. Keep agent identity separate from model provider.
- Use reported context capacity. Cached input is included in Codex input counts, so subtract it from uncached input; reasoning output is already included in output.
- Treat turn completion as idle, not session exit. With no process registry, expire silent sessions after ten minutes and reopen when logs advance.
- Rollout format is based on the installed Codex 0.162.0-alpha.17.2 logs. Ignore unknown records; test older token_count and current token_usage_record shapes.

Validation performed:
- `node --check hud.mjs` and `git diff --check`: passed.
- `node hud.mjs selftest`: 47 checks passed.
- `node --test tests/codex.test.mjs`: 7 tests passed, covering mixed agents and ID collisions, nested subagents,
  cumulative token deduplication, secrets, partial UTF-8 lines, malformed records, questions, completion, discovery,
  stale-session resume, restart persistence, truncation, custom tools, HTTP, SSE and generated browser script syntax.
- `node tests/browser-smoke.mjs http://127.0.0.1:7777`: deployed cards and network have visible session geometry,
  Codex model details, live SSE, no horizontal page overflow and no browser runtime exceptions. The check uses
  accessible labels because dense network layouts abbreviate visible model labels. Screenshots in ignored `.hud-tmp/`.
- Live deployment: `Claude HUD` scheduled task running from this checkout with `--lan`; `/api/health` reports
  version 0.2.0. `/api/state` reports three real Codex sessions, existing Claude sessions, readable Codex logs,
  no Codex read errors and installed Claude hooks. Temporary port 7778 server stopped.

Remaining limitations: rollout logs are an internal Codex format; silent sessions use a ten-minute activity timeout;
permission dialogs and tools nested in opaque execution code are not guaranteed to appear. Codex account quotas
are not read; the existing account panel is explicitly labeled Claude account limits.

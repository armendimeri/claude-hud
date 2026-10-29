# Claude HUD

One local web page, `http://127.0.0.1:7777`, that shows every Claude Code session running on this PC, live, in
every project:
- what each session is doing, and which subagents it has started (and which subagent started which);
- tokens per session and per subagent, and how full each one's context window is;
- which sessions need you (a permission prompt, a question, waiting for input);
- the boards of the plans in those projects;
- your account's 5-hour and weekly usage, as Claude Code itself last cached it.

It's one file, `hud.mjs`, using Node 22 built-ins only: there's no `npm install` and no build step. It makes no model
or API calls, so it costs no Claude usage. It listens on 127.0.0.1 only.

> The page at `/` is still the engine's plain JSON view. The designed HUD comes next.

## Commands

```
node hud.mjs                     serve on http://127.0.0.1:7777 (HUD_PORT picks another port)
node hud.mjs --demo              serve simulated sessions, subagents, plans and events
node hud.mjs --demo=dense        the same with 24 sessions
node hud.mjs install             add the HUD's hooks to ~/.claude/settings.json (backup first; safe to repeat)
node hud.mjs uninstall           remove only the HUD's hooks from ~/.claude/settings.json
node hud.mjs autostart on|off    start the HUD at logon (Task Scheduler, no window), or stop doing so
node hud.mjs lint [repo] [--json]  check a repository against the agent workflow standard (workflow/STANDARD.md)
node hud.mjs selftest            check the model normaliser, redaction and plan parser
```

Routes: `/` (the page), `/design` (the component gallery), `/api/state` (the full state as JSON), `/api/stream`
(server-sent events), `/api/health`, and `POST /event`, which the hooks use. Requests whose `Host` header is not
`127.0.0.1:<port>` or `localhost:<port>` are refused.

## Setting it up

1. `node hud.mjs` (or `node hud.mjs autostart on` to have it start at every logon).
2. `node hud.mjs install`. Open sessions pick the hooks up by themselves.

Without the hooks the HUD still works: it reads the session list and the transcripts, so you see sessions, titles,
models, tokens and subagents. The hooks add the live parts: the tool running right now, "needs you", and
instant updates.

## What it reads, and what it never touches

| Source | What the HUD takes from it |
|---|---|
| `~/.claude/sessions/<pid>.json` | The list of running sessions: id, folder, name, busy or idle. The `*.key` files next to them are never opened. |
| `~/.claude/projects/<project>/<session>.jsonl` and `<session>/subagents/` | Title, model, effort, branch, tokens, tool names, and subagents (their `meta.json` gives the parent). Read from where it left off, a line at a time. |
| Hook events (`POST /event`) | What the hooks send: event name, tool name and the few input fields a short summary needs. |
| `docs/**/STATUS.md`, `docs/plans/*.md` and `docs/status.md` in each project with a session | Plan boards, the plan's state, unticked decisions and open questions, and the project's one-line headline. |
| `~/.claude/settings.json` | Only `env.CLAUDE_CODE_USE_BEDROCK` (to label sessions as Bedrock) and whether the HUD's hooks are installed. |
| `~/.claude.json` | Only `cachedUsageUtilization`: the 5-hour and weekly usage Claude Code caches itself. |

It never reads `~/.claude/.credentials.json`, the session `*.key` files, `~/.aws/` or any `AWS_*` environment
variable. If `CLAUDE_CONFIG_DIR` is set, the HUD looks there instead of `~/.claude`, as Claude Code does.

**Text shown is short and redacted.** Titles, models, tool names, and a summary of each tool call (a file path, the
first 80 characters of a command) are shown. Full prompts, tool output and file contents never are. Before anything
leaves the process, passwords (`-P …`, `Password=…`), tokens, API keys, AWS keys and anything that looks like a
key are replaced with `•••`.

## The hooks

`install` adds one entry for each of these events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse,
PostToolUse, PostToolUseFailure, Notification, Stop, SubagentStart, SubagentStop and PreCompact. Each runs
`node "<path>/hud.mjs" hook`. That command reads the event, posts it to the HUD, and:
- **prints nothing**, so nothing is added to Claude's context;
- **always exits 0**, so it can never block a tool or show an error;
- gives up after 400 ms, so a HUD that isn't running costs about 70 ms a call;
- runs `async` (except SessionEnd), so Claude Code doesn't wait for it.

`install` writes a backup (`settings.json.hud-backup-<date>`) first and leaves every other setting and hook as it
was. Running it twice changes nothing. `uninstall` removes only the HUD's entries; when the result matches a backup,
it restores that backup's exact bytes.

## Bedrock

Sessions and subagents carry a provider (`anthropic`, `bedrock` or `unknown`), detected from the model id
(`us.anthropic.claude-…-v1:0`, inference-profile ARNs) and from `CLAUDE_CODE_USE_BEDROCK`. Model ids are shown
normalised (`claude-opus-5-5`); the raw id stays in the state as `modelRaw`.

Bedrock usage from your own apps (outside Claude Code) can be added. Both ways are **off by default**:
- **Ingest:** start the HUD with `HUD_ACCEPT_USAGE=1`, and after each Bedrock response post the usage:

  ```js
  // After a Bedrock InvokeModel / Converse response `res` (fails silently when the HUD isn't running)
  fetch('http://127.0.0.1:7777/usage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      app: 'invoice-ocr', provider: 'bedrock', model: modelId,
      input: res.usage.inputTokens, output: res.usage.outputTokens,
      cacheRead: res.usage.cacheReadInputTokens ?? 0, cacheWrite: res.usage.cacheWriteInputTokens ?? 0,
    }),
  }).catch(() => {});
  ```
- **CloudWatch:** start the HUD with `HUD_BEDROCK_REGION=<region>`. Once a minute it runs `aws cloudwatch
  get-metric-data` with your own AWS CLI profile and shows today's token counts per model, a few minutes late and not
  split by app. CloudWatch API calls can carry a very small AWS charge: the only thing here that can cost money.

## Removing it completely

1. `node hud.mjs uninstall` (removes the hooks from `~/.claude/settings.json`).
2. `node hud.mjs autostart off` (removes the Task Scheduler task, if you turned it on).
3. Stop the HUD if it's running, then delete this folder.
4. Optionally delete the backups `install` and `uninstall` left in `~/.claude/`: `settings.json.hud-backup-*`.

The HUD keeps everything else in memory only, so nothing else is left behind.

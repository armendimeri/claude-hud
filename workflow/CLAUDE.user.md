# Rules for every project on this PC

Where a project's `CLAUDE.md` or the owner says otherwise, they win.

- **Start** with the plan you were given (its board), then the project's `CLAUDE.md`. Without a plan, start with
  the project's `docs/status.md`. Don't explore the repository when a plan names the files.
- **Workflow:** if the project's `CLAUDE.md` says it follows the agent workflow standard, use the skills
  `workflow-plan` (to plan), `workflow-run` (to do an item or a run) and `workflow-close` (to finish a plan);
  the standard itself is `~/.claude/workflow/STANDARD.md`. Otherwise, follow the project's own protocol exactly.
- **Plans before code** for new features: write the plan as files and wait for a go-ahead. Small fixes are exempt.
- **Git:** no commit, stage, branch, stash or push unless the project or the owner says so. Never add a remote.
- **Never** copy a password, connection string, key or token into anything you write, and never read credential
  files (`~/.claude/.credentials.json`, `~/.claude/sessions/*.key`, `~/.aws/`, user secrets).
- **Never** stop or rebuild over the owner's running app: use your own port or a scratch copy.
- **Stay** in the repository you were opened in, unless a plan names another path.
- **Questions:**
  - At most four, each with the recommended answer first and the reason.
  - Decide sensible defaults yourself and report them.
  - Write the answers into the repository the same day.
- **Evidence:** say what you verified (the command and its result), what you didn't, and which pages you didn't open
  in a browser.
- **End every session** with the report in STANDARD §11, ending with ready-to-paste Next prompts (model and
  effort included).

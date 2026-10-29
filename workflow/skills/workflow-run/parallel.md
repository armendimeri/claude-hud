# Parallel lanes, worktree mode and waiting (STANDARD §9)

## Lanes

- Your lane and port are on the board (Notes, or the Runs table) and in `CLAUDE.md` "Build, run, test".
- Never use another lane's port, and never stop the owner's app.
- **Shared-tree mode:** other agents edit files next to yours. Stay strictly inside your item's scope. Shared files
  follow the rules in `CLAUDE.md` "Parallel work"; anything else that two items would both touch means stop and
  set your item `blocked`.

## Worktree mode ("Git: agents commit per item")

- You work in your run's worktree, on branch `<slug>/<run>`. The owner made it with
  `git worktree add ../<repo>-<run> -b <slug>/<run> <integration branch>`.
- When the run starts, add your row to the Branches table.
- After each item:
  1. Commit, with the message `[<ID>] <title>`.
  2. `git merge <integration branch>`, then rebuild and test. A conflict outside the shared-file rules means stop
     the run, set the item `blocked`, and describe the conflict in the handoff.
  3. `git -C <main folder> merge --ff-only <slug>/<run>`. If the integration branch moved, go back to step 2. An
     `index.lock` error means another agent is merging: wait a minute and retry.
- When the run ends:
  1. Set the run's state, and remove your Branches row in the last commit.
  2. `git -C <main folder> worktree remove ../<repo>-<run>`, then `git -C <main folder> branch -d <slug>/<run>`.

## Waiting for another run

Before an item starts, look up each of its dependencies:
- **`handed-off` or `accepted`:** start.
- **Not done, but its run is still going** (in worktree mode, `git worktree list` shows its branch): do another of
  your items first if you can. Otherwise wait, as a background command. Waiting costs nothing.

  ```bash
  # wait up to 8 hours for <ID>; worktree mode: replace the cat with git show <integration branch>:docs/plans/<slug>/STATUS.md
  for i in $(seq 48); do
    s=$(cat docs/plans/<slug>/STATUS.md | awk -F'|' -v id="<ID>" '$2 ~ "^ *"id" *$" {gsub(/ /,"",$7); print $7}')
    case "$s" in handed-off|accepted|blocked|partial|bounced) break;; esac
    sleep 600
  done; echo "<ID>:$s"
  ```

  In worktree mode, when it's done, `git merge <integration branch>` before you start.
- **Not done, and no run has it** (never started, `blocked`, `partial`, or the 8 hours ran out): skip the item and
  every item that needs it, and list them in the report.

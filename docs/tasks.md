# Tasks and the workflow

A run progresses through a small state machine; terminal states map
1-to-1 onto process exit codes.

When a run starts, the runner renders the assignment's task list to
the workspace `assignment.md` as a fenced markdown document with one
section per task. Each task section contains a `**Status:**` field and
a `<!-- notes:start --> ... <!-- notes:end -->` block.

The runner injects a workflow preamble into the agent's first prompt
that says, in essence: "for each task, set Status to `in_progress`, do
the work, write your findings into the Notes block, set Status to
`completed`. Use `blocked` if you can't finish; the runner will stop
and surface that to the user instead of retrying."

After every backend invocation, the runner re-reads the workspace
`assignment.md`, parses out the per-task updates, and:

- If every task is `completed` → success, run ends.
- If any task is `blocked` → blocked, run ends, exit code 2.
- If retries are exhausted with incomplete tasks → exhausted, exit 1.
- Otherwise → re-invoke with a nudge listing what's still pending.

Task ids are stable across invocations so retries can address
incomplete work precisely.

## What the checklist does and doesn't do

The runner trusts the `**Status:**` string the agent writes — it does
not independently verify that a task's work was actually done. What the
structure *does* buy you is that the agent cannot silently skip an
item: every task must be explicitly accounted for (`completed`,
`blocked`, or left `pending` and retried), and the per-task Notes block
captures evidence you can audit after the fact.

If you need harder guarantees, encode them into the task body itself —
e.g., "run `npm test` and paste the exit code into Notes," or "open
the file at `src/foo.ts` and paste the top-level exports."

## `taskMode: file` vs `taskMode: cli`

Assignments default to `taskMode: file` when the field is omitted. A
fresh `run` or `init` may override the assignment with
`--task-mode <file|cli>`; resume reads the frozen manifest value.

- **`taskMode=file`**: the agent is oriented around the workspace
  `assignment.md` path and updates task status/notes by editing the
  file. While a non-passive run is `running`, task CLI mutation stays
  rejected.
- **`taskMode=cli`**: the agent is oriented around the run id plus task
  commands (`task list`, `task show`, `task set`, `task append-notes`,
  `status`). `run.json.finalTasks` is the live source of truth,
  `assignment.md` is rendered from that state for human audit, and
  `task set` / `task append-notes` are allowed while a non-passive run
  is `running`.
- **`task add`** remains rejected while a non-passive run is `running`,
  even in `taskMode=cli`. Live mutation in v1 is limited to status and
  notes on existing tasks.

## `task-runner task` commands

Mutate a run's task list **without invoking the agent**. The canonical
use case is a *sidecar* flow: you have an agent that can't (or
shouldn't) be invoked as a task-runner subprocess, but you still want
it to work through a structured task list. `init` seeds the list, the
external agent reads it via `status`, works each task, and reports
progress back through the task CLI.

The task subcommands are:

- `task list <run-id>` — list tasks in stable order.
- `task show <run-id> <task-id>` — show one task snapshot.
- `task set <run-id> <task-id>` — replace status and/or notes.
- `task append-notes <run-id> <task-id>` — append notes with a single
  newline join rule.
- `task add <run-id>` — add a new pending task, with optional `--body`.

Read commands (`task list`, `task show`) always read canonical task
state from `run.json.finalTasks`; they never invoke a backend.

Mutation commands:

- Require an existing run (as id or workspace path).
- Use a shared per-run persistence lock so `run.json` and rendered
  `assignment.md` stay in sync.
- `taskMode=file`: reject mutation while a non-passive run is
  `running`.
- `taskMode=cli`: allow `task set` and `task append-notes` while a
  non-passive run is `running`; canonical task state lives in
  `run.json.finalTasks` and `assignment.md` is rendered from it.
- On terminal non-passive runs, only notes-only `task set` /
  `task append-notes` are allowed; `task add` and status-changing
  `task set` are rejected.

### Examples

```bash
# Inspect tasks
task-runner task list <run-id>
task-runner task show <run-id> <task-id>

# Mark a task in-progress
task-runner task set <run-id> <task-id> --status in_progress

# Add a notes block without changing status
task-runner task set <run-id> <task-id> --notes "Investigating the parser."

# Append to the existing notes body
task-runner task append-notes <run-id> <task-id> --text "Captured CLI-mode details."

# Complete a task with a note in one call
task-runner task set <run-id> <task-id> --status completed --notes "Done."

# Append a new task to an initialized run
task-runner task add <run-id> --title "Follow-up cleanup" --body "Update docs."

# JSON output returns the updated task snapshot (handy for scripts)
task-runner task set <run-id> <task-id> --status completed --output-format json
```

### Options

`task set`:

| Flag | Purpose |
|---|---|
| `--status <s>` | Target status (`pending`, `in_progress`, `completed`, `blocked`). |
| `--notes <text>` | Replacement notes body (replaces, does not append). |
| `--output-format <text\|json>` | Default `text`. `json` prints the updated task snapshot. |

At least one of `--status` / `--notes` must be supplied.

`task append-notes`:

| Flag | Purpose |
|---|---|
| `--text <text>` (required) | Appended note text. Trimmed before joining. |
| `--output-format <text\|json>` | Default `text`. `json` prints the updated task snapshot. |

`task add`:

| Flag | Purpose |
|---|---|
| `--title <text>` (required) | Title for the new task. Non-empty, single-line, ≤ 200 chars. |
| `--body <text>` | Optional task body. Defaults to empty string. |
| `--output-format <text\|json>` | Default `text`. `json` prints the new task snapshot. |

`task add` honors the `tasks` locked field the same way `--add-task`
does on a fresh run: if either the agent or the assignment locks
`tasks`, the command is rejected. Generated ids follow the same
`cli-<short-id>` scheme as `--add-task`.

## Sidecar pattern

Drive an initialized run from an external agent/script without ever
invoking a backend through task-runner:

```bash
# 1. Seed the workspace (no backend call)
task-runner init \
  --agent ./agents/code-reviewer/agent.md \
  --assignment ./assignments/code-review/assignment.md \
  --var repo_path=. --var range=main..HEAD
# -> prints: task-runner: initialized agent=code-reviewer run=abc123

# 2. External agent asks: "what's left to do?"
task-runner status abc123 --output-format json --field tasks

# 3. External agent works a task and reports progress
task-runner task set abc123 review_accessibility --status in_progress
# ...agent does the work...
task-runner task set abc123 review_accessibility --status completed --notes "LGTM"

# 4. Optionally add a task the script discovered along the way
task-runner task add abc123 --title "Follow-up: address flakey test"

# 5. Loop until status JSON shows all tasks terminal.
```

For a **non-passive backend** (claude or codex), the run stays in
`initialized` state the whole time and is still fully resumable: if you
later want to hand it to a subprocess agent, `task-runner run
--resume-run abc123` executes it normally. The CLI task commands and
the subprocess execution path compose cleanly.

For a **passive backend** the contract is different: task mutations
*auto-finalize* the manifest (success / blocked / initialized is
re-derived from the task map on every call), and `task-runner run`
is rejected outright. See [backends.md#passive](backends.md#passive)
for the full lifecycle.

Read surfaces still distinguish between canonical and effective
status: passive work with any `in_progress` task is presented as
effectively `running` in `status`, `list runs`, daemon JSON, and the
web dashboard, even though the canonical manifest lifecycle remains
`initialized` until the work is terminal.

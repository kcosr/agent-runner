# Tasks and the workflow

Task state is **canonical in the manifest** (`run.json.finalTasks`)
for every run. Workers read and mutate tasks through the task CLI.
There's no "task mode" switch and no workspace markdown file for the
agent to edit in place — task-runner drives the structured state
through commands.

## Statuses

Every task carries one of four statuses:

- `pending`
- `in_progress`
- `completed`
- `blocked`

## Worker handoff

When a run starts, the worker receives a **brief** — text composed from
the agent instructions, the assignment instructions, task-runner's
worker workflow template, and the caller's run message. The brief
teaches the worker to use:

- `task-runner task list <run-id>`
- `task-runner task show <run-id> <task-id>`
- `task-runner task set <run-id> <task-id> --status ...`
- `task-runner task append-notes <run-id> <task-id> --text ...`
- `task-runner status <run-id>`

You can fetch the worker brief at any time with:

```bash
task-runner brief <run-id>
```

`brief` is text-only; it is not projected through `status --field ...`.
See [agents-and-assignments.md#brief-and-caller-instructions](agents-and-assignments.md#brief-and-caller-instructions)
for the composition rules and the audience split between `brief` and
`callerInstructions`.

## Run loop

After every backend invocation, the runner re-reads canonical task
state from `run.json.finalTasks` and:

- If every task is `completed` → success, run ends.
- If any task is `blocked` → blocked, run ends, exit code 2.
- If retries are exhausted with incomplete tasks → exhausted, exit 1.
- Otherwise → re-invoke with a nudge that points the worker back at
  the task CLI and names the incomplete tasks.

Task ids are stable across invocations so retries can address
incomplete work precisely.

### Why a CLI-driven task workflow?

Earlier generations of task-runner had the agent edit a workspace
`assignment.md` in place. That approach was removed: markdown-file
editing is wonderful for *composing* plans but a poor fit for
*mutating* status on many small atomic units. The CLI gives each
mutation a clean contract (`task set`, `task append-notes`, `task
add`), lets sidecar scripts and the runner share one code path, and
keeps `run.json.finalTasks` as a single authoritative source.

## What the checklist does and doesn't do

The runner trusts the status the agent writes — it does not
independently verify that a task's work was actually done. What the
structure *does* buy you is that the agent cannot silently skip an
item: every task must be explicitly accounted for (`completed`,
`blocked`, or left `pending` and retried), and the per-task Notes
block captures evidence you can audit after the fact.

If you need harder guarantees, encode them into the task body itself —
e.g., "run `npm test` and paste the exit code into Notes," or "open
the file at `src/foo.ts` and paste the top-level exports."

## `task-runner task` commands

The task subcommands are:

- `task list <run-id>` — list tasks in stable order.
- `task show <run-id> <task-id>` — show one task snapshot.
- `task set <run-id> <task-id>` — replace status and/or notes.
- `task append-notes <run-id> <task-id>` — append notes with a single
  newline join rule.
- `task add <run-id>` — add a new pending task, with optional `--body`.

Read commands (`task list`, `task show`) always read canonical task
state from `run.json.finalTasks`; they never invoke a backend.

### Mutation rules

Mutation commands use a shared per-run persistence lock so every
writer sees a coherent `run.json` snapshot. Which mutations are
allowed depends on the run's lifecycle state:

| Run state | `task set` / `task append-notes` | `task add` |
|---|---|---|
| `initialized` (non-passive or passive) | ✅ | ✅ |
| Non-passive `running` | ✅ | ❌ |
| Non-passive terminal (`success`/`blocked`/`exhausted`/`aborted`/`error`) | Notes-only (status changes rejected) | ❌ |
| Passive (any non-terminal state) | ✅ | ✅ |

`task add` also honors the `tasks` locked field: if either the agent
or the assignment locks `tasks`, `task add` is rejected. Generated ids
follow the `cli-<short-id>` scheme.

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

## Sidecar pattern

Drive an initialized run from an external agent or script without ever
invoking a backend through task-runner:

```bash
# 1. Seed the workspace (no backend call)
task-runner init \
  --agent ./agents/code-reviewer/agent.md \
  --assignment ./assignments/code-review/assignment.md \
  --var repo_path=. --var range=main..HEAD
# -> prints: task-runner: initialized agent=code-reviewer run=abc123

# 2. Fetch the worker-facing brief (what the agent needs to know)
task-runner brief abc123

# 3. External agent asks: "what's left to do?"
task-runner status abc123 --output-format json --field tasks

# 4. External agent works a task and reports progress
task-runner task set abc123 review_accessibility --status in_progress
# ...agent does the work...
task-runner task set abc123 review_accessibility --status completed --notes "LGTM"

# 5. Optionally add a task the script discovered along the way
task-runner task add abc123 --title "Follow-up: address flakey test"

# 6. Loop until status JSON shows all tasks terminal.
```

For a **non-passive backend** (claude, codex, or cursor), the run
stays in `initialized` state and is still fully resumable: when you
want to hand it to a subprocess agent, `task-runner run --resume-run
abc123` executes it normally. The CLI task commands and the subprocess
execution path compose cleanly.

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

# Tasks

Tasks are the canonical unit of work. Task state is stored in
`manifest.finalTasks` and is mutated through the `agent-runner task ...`
CLI, never through workspace files.

Task commands operate on run task state only. They do not expose or
mutate the run's frozen selected `backendConfig`, custom backend
selection, or `backendArgs`; those are runtime fields captured when the
run is created.

Reusable task definition files are a separate authoring surface under
`${AGENT_RUNNER_CONFIG_DIR}/tasks`. Inspect them with
`agent-runner list tasks` and `agent-runner show task <name|path>`. Those
commands read markdown definition source files only; they do not read or
mutate run task status, notes, or manifests.

## Task shape

```ts
{
  id: string       // [A-Za-z0-9._:/-]+, max 128 chars
  title: string    // 1-200 chars, single line
  body: string     // optional; free-form markdown
  status: "pending" | "in_progress" | "completed" | "blocked"
  notes: string    // worker-authored evidence/progress
}
```

Task IDs must be unique within a run. Notes are free-form text; structural
marker lines are escaped on write and unescaped on read.

## Status values

- `pending` — awaiting work
- `in_progress` — actively being worked on
- `completed` — done
- `blocked` — cannot proceed; requires human intervention

For non-passive runs, `blocked` is a terminal-ish outcome: any blocked task
causes the run to exit with status `blocked` and exit code 2. For passive
runs, the overall status is derived from the task set:

- all tasks completed → `success`
- all tasks completed or blocked, with at least one blocked → `blocked`
- otherwise → `initialized` (waiting for more work)

## Task CLI

### List and show

```bash
agent-runner task list <run-id>
agent-runner task show <run-id> <task-id>
```

Both accept `--output-format json` for machine-readable output.

### Update status and notes

```bash
agent-runner task set <run-id> <task-id> --status in_progress
agent-runner task set <run-id> <task-id> --status completed
agent-runner task set <run-id> <task-id> --status blocked --notes "Reason..."
agent-runner task set <run-id> <task-id> --notes "Replacement notes body"
```

`--status` and `--notes` can be used together or separately, but at least
one must be provided. `--notes` replaces the entire notes body.

### Append notes (non-destructive)

```bash
agent-runner task append-notes <run-id> <task-id> --text "Observed ..."
```

Preserves existing notes and appends the new text.

### Add a task

```bash
agent-runner task add <run-id> --title "New task title" [--body "..."]
```

Generates a new task with a `cli-<shortid>` identifier. Only allowed when
the run state permits adding tasks (see [mutation rules](#mutation-rules)).

## Mutation rules

Task mutation is gated by two dimensions: run lifecycle state and whether
the backend is passive. The daemon and CLI expose these gates via the
`taskMutation` sub-capability on `RunCapabilities`:

```ts
taskMutation: {
  canSetStatus: boolean
  canEditNotes: boolean
  canAdd: boolean
  canEditPending: boolean
  canDeletePending: boolean
}
```

### Non-passive runs

| State           | `canSetStatus` | `canEditNotes` | `canAdd` | `canEditPending` | `canDeletePending` |
|-----------------|----------------|----------------|----------|------------------|--------------------|
| `initialized`   | true           | true           | true*    | true*            | true*              |
| `ready`         | false          | true           | false    | false            | false              |
| `running`       | true           | true           | true*    | false            | false              |
| terminal (any)  | true           | true           | true*    | true*            | true*              |

`canEditPending` and `canDeletePending` permit title/body edits and deletes
only for tasks whose status is still `pending`. These operations are
disabled when `tasks` is in `lockedFields`, when the run is archived, and
for non-pending tasks. `canAdd` follows the same lock/archive gate and
remains available while non-passive runs are `running`.

### Passive runs

| State           | `canSetStatus` | `canEditNotes` | `canAdd` | `canEditPending` | `canDeletePending` |
|-----------------|----------------|----------------|----------|------------------|--------------------|
| `running`       | false          | false          | false    | false            | false              |
| not `running`   | true           | true           | true*    | true*            | true*              |

`canAdd`, `canEditPending`, and `canDeletePending` are disabled when
`tasks` is in `lockedFields` or the run is archived.

Passive runs are always driven externally through the task CLI; there is no
backend to invoke.

Status and notes changes remain valid independently: a PATCH or CLI
`task set` can update only status, only notes, or both. Title/body edits
are accepted only through the pending-task edit path, and deletes remove
only pending tasks. Every successful mutation refreshes the run's
canonical task map and emits compact audit records.

## Worker workflow template

When a run has tasks, the composed brief includes the agent-runner worker
workflow template. It teaches the worker to use the task CLI as the work
interface:

- Inspect the task list (`task list`, `task show`).
- Claim a task (`task set ... --status in_progress`).
- Do the work.
- Record evidence (`task append-notes ... --text "..."`).
- Mark completion (`task set ... --status completed`).
- Mark blockers (`task set ... --status blocked --notes "..."`).
- Check overall status (`run status <run-id>`).

The worker does not edit `assignment.md` or any workspace file to change
task state.

## Retry nudges and added tasks

If tasks remain incomplete when an attempt ends or a run is resumed with
unfinished work, agent-runner composes a prompt that points the worker
back at the task CLI and identifies the incomplete tasks.

If new tasks are added on resume (via `--add-task` or `task add`) and no
explicit follow-up message is supplied, the implicit continue prompt tells
the worker to check the task list before continuing.

## Notes escaping

When notes are rendered to disk (e.g. in the audit `assignment-seed.md` or
internal snapshots), lines that look like structural markers
(`<!-- task-id: ... -->`, `**Status:**`, `**Notes:**`, the notes
start/end markers) are escaped with a leading backslash. Unescaping happens
on read. This keeps worker notes from accidentally breaking the task file
round-trip.

## Exit codes

The CLI surfaces task-related outcomes via its exit code:

- `0` — success; all tasks completed (or initialized run)
- `1` — retries exhausted with incomplete tasks
- `2` — one or more tasks reported blocked
- `130` — user cancellation

See [cli.md](cli.md) for the full exit-code table.

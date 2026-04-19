# Runs

A run is the persisted execution instance created from one agent and
(optionally) one assignment. Every run has a short id and lives under:

```text
${TASK_RUNNER_STATE_DIR}/runs/<repo>/<run-id>/
```

## Run workspace layout

```text
<workspace>/
├── run.json               # canonical manifest (schema version 8)
├── run-events.jsonl       # optional append-only diagnostic audit history
├── assignment-seed.md     # only when the run started from an assignment file
├── attempts/
│   ├── 00.json
│   └── 01.json
└── attachments/
    └── <attachment-id>/
        └── <file>
```

`assignment-seed.md` is an immutable audit snapshot of the assignment at
run-creation time. It is *not* a work surface — task state is canonical in
`run.json.finalTasks`. When present, `run-events.jsonl` is also diagnostic
only: it records compact lifecycle/task provenance but is never replayed to
derive current run state.

## Manifest (`run.json`)

The manifest is the source of truth. Important fields:

| Field | Purpose |
|-------|---------|
| `schemaVersion` | currently `8`; older manifests are not silently upgraded |
| `runId`, `repo`, `cwd` | identity and scope |
| `agent` | frozen `{ name, sourcePath, instructions }` |
| `assignment` | frozen `{ name, sourcePath, workspacePath }` or `null` |
| `backend`, `model`, `effort` | resolved runtime config |
| `timeoutSec`, `maxAttempts`, `unrestricted` | per-attempt limits |
| `lockedFields` | union of agent + assignment locks, frozen |
| `message` | default run message (from CLI positional or assignment) |
| `name` | user-provided display name (mutable via `run set-name`) |
| `status` | current lifecycle state |
| `startedAt`, `endedAt` | ISO 8601 timestamps |
| `archivedAt` | ISO timestamp when archived, else `null` |
| `exitCode` | final exit code or `null` |
| `finalTasks` | canonical task state |
| `tasksCompleted`, `tasksTotal` | derived counts |
| `brief` | composed worker handoff, frozen |
| `callerInstructions` | operator-facing docs, never sent to backend |
| `backendSessionId` | backend-native resume handle |
| `dependencyRunIds` | upstream runs that must succeed before execution |
| `attachments` | metadata for files under `attachments/` |
| `attempts`, `attemptRecords` | per-attempt execution log |
| `sessionCount`, `sessions` | session-level summaries |
| `runtimeVars` | resolved vars (env-sourced values redacted) |
| `resetSeed` | snapshot used by `run reset` |
| `execution` | `{ hostMode: "embedded" \| "daemon", controller }`; for daemon runs, `controller.daemonInstanceId` links back to the daemon instance |

## Lifecycle states

- `initialized` — created by `init`, awaiting first execution
- `running` — actively executing
- `success` — all tasks completed
- `blocked` — at least one task reported blocked
- `exhausted` — max attempts reached with incomplete tasks
- `aborted` — user or system cancellation
- `error` — backend or runtime failure

Passive runs derive their status from the task set rather than attempt
execution (see [tasks.md](tasks.md)).

## Creating a run

### Fresh run

```bash
task-runner run \
  --agent ./agents/implementer/agent.md \
  --assignment ./assignments/repo-orientation/assignment.md \
  "Optional message to the worker"
```

Fresh `run` resolves agent and assignment, resolves cwd
(`--cwd` → assignment `cwd` → caller cwd), resolves variables, enforces
locked fields, creates the workspace, freezes the manifest, composes the
brief, and invokes the backend — except for passive runs, which stop after
initialization.

### Init, then execute later

```bash
task-runner init \
  --agent ./agents/implementer/agent.md \
  --assignment ./assignments/repo-orientation/assignment.md

task-runner run --resume-run <run-id>
```

`init` performs the same setup work but does not invoke the backend. This
is useful for passive runs, planning flows, or delayed execution. `init`
does not dump the worker brief to stdout — fetch it explicitly with
`task-runner run brief <run-id>`.

## Read surfaces

```bash
task-runner status
task-runner run status <run-id> [--output-format json] [--field <name>]...
task-runner run brief <run-id>
task-runner task list <run-id>
task-runner task show <run-id> <task-id>
task-runner attachment list <run-id> [--cwd-scope]
```

- Top-level `status` reports system/environment status and takes no run id.
- `run status` and `run brief` are run-id-only.
- `run brief` is text-only; no `--output-format` or `--field`.
- `run status --output-format json` returns the shared `RunDetail` DTO.

## Mutation surfaces

```bash
task-runner run reset <id>
task-runner run archive <id>
task-runner run unarchive <id>
task-runner run delete <id>                # archived runs only
task-runner run set-name <id> <name>
task-runner run set-name <id> --clear
task-runner run set-backend-session <id> <session-id>   # passive only
task-runner run clear-backend-session <id>              # passive only
task-runner run add-dep <id> <dep-run-id>
task-runner run remove-dep <id> <dep-run-id>
task-runner run clear-deps <id>
```

### Reset

`run reset` restores the initialized-state seed from `manifest.resetSeed`
(model, effort, name, dependencies, timeoutSec, maxAttempts, brief, final
task snapshot). Attempt and session history, endedAt, exitCode, and the
live status are cleared. Existing `run-events.jsonl` history is preserved
and reset appends one more diagnostic record instead of truncating the file.
Only non-running runs can be reset.

### Archive, unarchive, delete

- `run archive` sets `archivedAt` on a non-running run.
- `run unarchive` clears `archivedAt`.
- `run delete` permanently removes the workspace. Only archived,
  non-running runs are deletable. The workspace is removed, not moved to
  trash, so any `run-events.jsonl` file disappears with the rest of the run.

### set-name

Update or clear the human-facing display name. Use `--clear` to remove it.
Does not change run state or task state.

### set-backend-session / clear-backend-session

Passive-only metadata mutations. Update `manifest.backendSessionId` without
changing task state, lifecycle status, attempts, archive state, or
dependency projections.

### Dependencies

`add-dep`, `remove-dep`, and `clear-deps` are only allowed on initialized
runs. See [dependencies.md](dependencies.md).

## Listing runs

```bash
task-runner list runs
task-runner list runs --cwd <path>
task-runner list runs --repo <name>
task-runner list runs --global
task-runner list runs --include-archived
```

By default, `list runs` scopes to the caller's exact cwd. `--repo <name>`
scopes to an exact repo bucket. `--global` lists across all buckets.
`--include-archived` adds archived runs to any of the above.

## Execution modes

Every run persists an `execution` record:

- `hostMode: "embedded"` — ran in the CLI process
- `hostMode: "daemon"` — ran inside `task-runner serve`, with
  `controller.daemonInstanceId` linking back to that daemon instance

See [daemon.md](daemon.md) for how the daemon adopts and publishes runs.

## Capabilities

The daemon and CLI expose a `RunCapabilities` boolean block on each run so
clients do not reimplement lifecycle gates:

- `canArchive`, `canUnarchive`, `canReset`, `canDelete`, `canResume`,
  `canAbort`
- `taskMutation.canSetStatus`, `taskMutation.canEditNotes`,
  `taskMutation.canAdd`

When `canAbort` is `false`, the `abortReason` field explains why
(`"already_terminal"` or `"not_active_in_daemon"`).

## Resume

Resume is its own topic — see [resume.md](resume.md).

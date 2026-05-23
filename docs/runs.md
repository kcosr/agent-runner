# Runs

A run is the persisted execution instance created from one agent and
(optionally) one assignment. Every run has a short id and lives under:

```text
${AGENT_RUNNER_STATE_DIR}/runs/<repo>/<run-id>/
```

## Run workspace layout

```text
<workspace>/
├── run.json               # canonical manifest (schema version 25)
├── run-events.jsonl       # append-only audit history with monotonic cursors
├── assignment-seed.md     # only when the run started from an assignment file
├── agent-seed.md          # only when the run started from an agent file
├── attempts/
│   ├── 00.json
│   ├── 01.json
│   └── 01.stdout.log      # optional, when AGENT_RUNNER_CAPTURE_BACKEND_STDOUT=1
└── attachments/
    └── <attachment-id>/
        └── <file>
```

`assignment-seed.md` and `agent-seed.md` are immutable audit snapshots of
the assignment and agent at run-creation time. They are *not* work
surfaces — task state is canonical in `run.json.finalTasks`. Older
initialized runs created before agent snapshots were persisted can be
backfilled with `scripts/migrate-agent-seeds.mjs`. Runs created by
current code also include
`run-events.jsonl`; older workspaces may still need
`scripts/migrate-run-events-v2.mjs` before the audit history has canonical
cursors. The file records compact lifecycle/task provenance, including
`run.hook_recorded` hook execution records. It is durable history surfaced
via `agent-runner run audit <run-id>` and daemon audit APIs, but it is
never replayed to derive current run state.

## Manifest (`run.json`)

The manifest is the source of truth. Important fields:

| Field | Purpose |
|-------|---------|
| `schemaVersion` | currently `25`; older manifests are not silently upgraded |
| `runId`, `repo`, `cwd` | identity and scope |
| `agent` | frozen `{ name, sourcePath, instructions }` |
| `assignment` | frozen `{ name, sourcePath }` or `null` |
| `backend`, `model`, `effort` | resolved runtime config |
| `backendConfig`, `resolvedBackendArgs` | frozen selected backend-owned config and selected backend argv extras |
| `timeoutSec`, `maxAttemptsPerSession`, `unrestricted` | per-attempt limits |
| `lockedFields` | union of agent + assignment locks, frozen |
| `message` | default run message (from CLI positional or assignment) |
| `name` | user-provided display name (mutable via `run set-name`) |
| `note` | optional markdown note for humans (mutable via `run set-note`) |
| `pinned` | persisted board-order hint for summaries and the web dashboard |
| `schedule` | persisted `RunSchedule` or `null`; source of truth for delayed and recurring execution |
| `status` | current lifecycle state |
| `startedAt`, `updatedAt`, `endedAt` | ISO 8601 timestamps |
| `archivedAt` | ISO timestamp when archived, else `null` |
| `exitCode` | final exit code or `null` |
| `finalTasks` | canonical task state |
| `tasksCompleted`, `tasksTotal` | derived counts |
| `brief` | composed worker handoff, frozen |
| `callerInstructions` | operator-facing docs, never sent to backend |
| `backendSessionId` | backend-native resume handle |
| `backendSessionSync` | backend-owned history sync state or `null` |
| `runGroupId` | grouping key for run-group filters, group attachments, and group dependencies |
| `dependencies` | typed upstream run or group refs that must be satisfied before execution |
| `parentRunId` | direct lineage edge to the parent run when this run was launched from another run |
| `queuedResumeMessages` | daemon-owned pending resume messages; ordinary messages have `source: null`, while detached child completion messages identify the child notification source |
| `parentCompletionNotifications` | child-owned delivery records for detached parent-completion callbacks |
| `attachments` | metadata for files under `attachments/` |
| `totalAttemptCount`, `attemptRecords` | per-attempt execution log with `task_runner` or `backend_session` provenance |
| `totalSessionCount`, `sessions` | session-level summaries with `task_runner` or `backend_session` provenance; daemon-delivered parent-completion resumes set `resumeSource` |
| `runtimeVars` | frozen resolved vars |
| `runtimeVarSources` | frozen provenance for each resolved var |
| `resetSeed` | snapshot used by `run reset` |
| `execution` | `{ hostMode: "embedded" \| "daemon", controller }`; for daemon runs, `controller.daemonInstanceId` links back to the daemon instance |

Timeline history exposes compact attempt provenance (`task_runner` or
`backend_session` with `bootstrap`/`sync` mode) so clients can distinguish
agent-runner-authored attempts from backend-imported turns without reading
the manifest directly.

`RunSummary` and `RunDetail` also expose derived `scheduleState`:
`none`, `paused`, `future`, or `due`. It is recomputed from
`manifest.schedule` and the current time; it is not stored in
`run.json`.

`resolvedBackendArgs` is intentionally local to `run.json`. It is used for
backend invocation and audit/replay semantics, while normal CLI, daemon,
and web status DTOs omit it.

## Run/session/attempt model

A run is the durable lifecycle record. Each backend execution window is a
session: the fresh execution creates session `0`, and each resume creates
the next session. Attempts are backend invocations within a session.
`maxAttemptsPerSession` is the per-session retry budget. Attempt numbers
are monotonic across the run, while `attemptIndexInSession` is zero-based
within its session.

Agent-runner-created attempts and sessions carry
`provenance: { kind: "task_runner" }`. Attempts and sessions imported
from a backend-owned session history carry `kind: "backend_session"` plus
the backend name, backend session id, backend turn id, import/sync
timestamps, sync mode, and source descriptor. Imported backend turns are
inserted into the same monotonic attempt/session sequence, so later
agent-runner-owned resume attempts allocate after the imported history.
The `task_runner` provenance literal is an intentionally preserved manifest
schema value from before the Agent Runner rename, not a user-facing product
name.

## Backend session history

When a backend supports session history reads, `--backend-session-id`
bootstrap import can materialize complete prior backend turns into the
new run before the first agent-runner-owned attempt. The import writes
canonical `sessions`, `attemptRecords`, attempt logs, and
`backendSessionSync` state. Open backend turns are recorded only in
`backendSessionSync.openTurnIds`; they are not attempts until a later
sync reports them complete.

Before `agent-runner run --resume-run <id>` allocates a new session or
attempt, agent-runner syncs backend-owned history for runs with a backend
session id and a backend that implements history reads. This pre-resume
sync is independent of daemon subscriptions. If the source changed and
history cannot be read or persisted safely, resume fails before any new
attempt/session numbers are allocated. When previous sync metadata exists,
`backendSessionSync.lastError` records the failure.

The daemon also polls subscribed non-running run detail, timeline, and
audit streams. Changed backend history updates `run.json`, refreshes run
indexes, publishes fresh summary/detail projections, and emits audit
`run.backend_session_history_synced` events for synced backend turns.
Daemon sync failures emit `run.backend_session_history_sync_failed` audit
events. Summary-only subscriptions do not start history polling. Set
`AGENT_RUNNER_BACKEND_SESSION_SYNC=false` (also accepts `0`, `no`, or
`off`) to disable backend-owned session history import/sync for the
current process.

## Lifecycle states

- `initialized` — created by `init`, awaiting approval for first execution
- `ready` — approved for execution, awaiting first start
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
agent-runner run \
  --agent ./agents/implementer/agent.md \
  --assignment ./assignments/repo-orientation/assignment.md \
  "Optional message to the worker"
```

Fresh `run` resolves agent and assignment, resolves variables, selects the
run id and run group id, resolves cwd (`--cwd` → assignment `cwd` →
caller cwd) with injected variables such as `{{run_group_id}}`, enforces
locked fields, creates the workspace, resolves the selected backend's
extra argv and launcher, freezes the manifest, composes the brief, and
invokes the backend — except for passive runs, which stop after
initialization and freeze an empty backend-args list.

If a run launches another `agent-runner` process from inside a worker, the
child run automatically freezes `parentRunId` and can inherit parent vars
through assignment `sources: [parent]`. This is how planner →
implementer → descendant worktree flows reuse values such as
`worktree_path` and `worktree_base_ref` without repeating `--var` flags.
Fresh child runs also inherit the parent's `runGroupId` by default. That
group controls group-scoped attachments, filtering, and group
dependencies; it is separate from parent lineage.

Use `--no-inherit-run-group` with fresh `run` or `init` when a child
should keep parent lineage through `parentRunId` but start in its own run
group. The group resolution order is explicit `--group-id`, then
`AGENT_RUNNER_RUN_GROUP_ID`, then the parent lineage run group, then the
new run id. `--no-inherit-run-group` is mutually exclusive with
`--group-id` and skips both ambient and parent group inheritance, so the
new run's own id becomes its group id.

Manifest schema v25 adds detached parent-completion notification state and
session/queued-message source metadata. Existing v24 manifests must be
migrated explicitly with `node scripts/migrate-manifests-v25.mjs --write`;
older manifests are not upgraded by readers.

Detached child runs started through a daemon also preserve parent callback
lineage. Unless `--no-notify-parent-on-complete` is set, the child
manifest stores a pending `parentCompletionNotifications[]` record after
the child session is allocated. When that session reaches terminal state,
daemon delivery either queues a sourced resume message on an active parent
or starts a sourced resume session on an idle resumable parent. Reset
clears `parentCompletionNotifications`, since notifications are tied to
specific sessions that no longer exist after reset. Recurring clones start
without stale delivery records from the completed source run.

### Init, then execute later

```bash
agent-runner init \
  --agent ./agents/implementer/agent.md \
  --assignment ./assignments/repo-orientation/assignment.md

agent-runner run ready <run-id>
agent-runner run --resume-run <run-id>
```

`init` performs the same setup work but does not invoke the backend. This
is useful for passive runs, planning flows, or delayed execution. `init`
does not dump the worker brief to stdout — fetch it explicitly with
`agent-runner run brief <run-id>`. Non-passive initialized runs must be
promoted with `agent-runner run ready <run-id>` before the first
`run --resume-run`.

When `init` reinitializes an existing initialized run with `--run-id`, the
run preserves its frozen run group. `--group-id` and
`AGENT_RUNNER_RUN_GROUP_ID` are fresh-workspace defaults; use
`agent-runner run set-group` or `clear-group` to change an existing run's
membership.

`init` and `run ready` accept schedule input through `--schedule-at
<iso>`, `--schedule-delay <duration>`, or `--schedule-cron <expr>`.
Exactly one source is required when schedule flags are present.
`--schedule-timezone`, `--schedule-mode reuse|reset|clone`, and
`--schedule-continue-on-failure` are valid only with `--schedule-cron`.
Schedule flags are rejected on resume and ready-start after the run's
initial ready transition has frozen the schedule contract.

## Scheduled runs

A scheduled run stays in `ready` while `scheduleState` is `future` or
`paused`. The daemon starts an enabled ready run when `scheduleState`
becomes `due` and all normal runnability gates pass. Manual start is
still allowed for ready scheduled runs:

- starting a one-time scheduled run consumes `manifest.schedule` before
  execution
- starting a recurring run before its `runAt` leaves `runAt` unchanged,
  and completion returns the run to `ready` for the pending recurrence

Schedule input can also be changed after creation:

```bash
agent-runner run schedule <id|path> --at <iso>
agent-runner run schedule <id|path> --delay 30m
agent-runner run schedule <id|path> --cron "0 9 * * *" --timezone UTC --mode clone
agent-runner run schedule enable <id|path>
agent-runner run schedule disable <id|path>
agent-runner run schedule clear <id|path>
```

`run schedule clear` removes one-time schedules only. Recurring
schedules must be disabled instead, so their recurrence definition stays
auditable.

One-time schedules below `AGENT_RUNNER_MIN_SCHEDULE_DELAY_SEC` are
rejected; recurring schedules below
`AGENT_RUNNER_MIN_RECURRENCE_INTERVAL_SEC` are rejected at input and are
disabled if a later recurrence advance violates the same guardrail. Both
defaults are `300` seconds. Cron validation samples bounded future
occurrences rather than scanning indefinitely.

Recurring completion behavior depends on `schedule.recurrence.mode`:

- `reuse` advances `runAt` on the same run and returns it to `ready`
- `reset` restores the same run from its frozen `resetSeed`, advances
  `runAt`, and returns it to `ready`
- `clone` creates a new ready child run from the frozen reset seed and
  frozen `assignment-seed.md`, then attaches the advanced recurrence to
  that clone

Failed recurring executions stop the schedule unless
`continueOnFailure` is `true`. `reset` and `clone` never re-read current
agent or assignment source files; they use the frozen manifest/reset
seed contract.

Reinitializing an initialized run applies assignment-authored schedule
config and explicit schedule overrides to the replacement initial
manifest. Once a run has been promoted to `ready`, start/resume uses the
frozen manifest schedule and rejects new `--schedule-*` input.

## Read surfaces

```bash
agent-runner status
agent-runner run status <run-id> [--output-format json] [--field <name>]...
agent-runner run brief <run-id>
agent-runner run audit <run-id> [--output-format text|json] [--limit <n>]
agent-runner task list <run-id>
agent-runner task show <run-id> <task-id>
agent-runner attachment list <run-id> [--scope run|group]
```

- Top-level `status` reports system/environment status and takes no run id.
- `run status`, `run brief`, and `run audit` are run-id-only.
- `run brief` is text-only; no `--output-format` or `--field`.
- `run audit --output-format json` returns `{ runId, events, lastCursor }`.
- `run audit` text output is chronological rendering from the persisted
  audit envelopes.
- `run status --output-format json` returns the shared `RunDetail` DTO.
- `RunSummary` and `RunDetail` include `parentRunId` when lineage exists
  and always include `runGroupId`.
- `RunSummary` and `RunDetail` include persisted `schedule` plus derived
  `scheduleState`.
- `RunSummary` and `RunDetail` include persisted `updatedAt`, which
  reflects the latest meaningful `run.json` write.
- `RunDetail` includes full `note` plus `pinned`; `RunSummary` includes
  `notePresent` plus `pinned`.
- Text `run status` may show `Pinned: yes` and `Note: present`, but does
  not print the note body.
- Run notes stay in run metadata only; they are not appended to `brief`,
  `callerInstructions`, or backend prompts automatically.

## Mutation surfaces

```bash
agent-runner run ready <id>
agent-runner run reconfigure <id> [--var key=value ...] [--message-file <path> | <message...>]
agent-runner run reset <id>
agent-runner run archive <id>
agent-runner run unarchive <id>
agent-runner run delete <id>                # archived runs only
agent-runner run set-name <id> <name>
agent-runner run set-name <id> --clear
agent-runner run set-note <id> <markdown>
agent-runner run clear-note <id>
agent-runner run pin <id>
agent-runner run unpin <id>
agent-runner run set-backend-session <id> <session-id>   # passive only
agent-runner run clear-backend-session <id>              # passive only
agent-runner run set-group <id> <group-id>
agent-runner run clear-group <id>
agent-runner run add-dep <id> --run <dep-run-id>
agent-runner run add-dep <id> --group <group-id>
agent-runner run remove-dep <id> --run <dep-run-id>
agent-runner run remove-dep <id> --group <group-id>
agent-runner run clear-deps <id>
agent-runner run schedule <id|path> --at <iso>
agent-runner run schedule <id|path> --delay <duration>
agent-runner run schedule <id|path> --cron <expr> [--timezone <iana>] [--mode reuse|reset|clone] [--continue-on-failure]
agent-runner run schedule enable <id|path>
agent-runner run schedule disable <id|path>
agent-runner run schedule clear <id|path>
```

### Reset

`run reset` restores the initialized-state seed from `manifest.resetSeed`
(model, effort, name, run group, dependencies, timeoutSec,
maxAttemptsPerSession, selected backendConfig, resolved backend args,
brief, final task snapshot). Attempt and session history, endedAt,
exitCode, backend session id, backend-session sync state, and the live
status are cleared. Existing `run-events.jsonl` history is preserved and
reset appends one more diagnostic record instead of truncating the file.
Only non-running runs can be reset.
`manifest.schedule` is preserved across manual reset because it is not
part of the reset seed.

### Reconfigure

`run reconfigure` patches runtime vars and/or the initial message on an
unarchived `initialized` run. The mutation rerenders the composed brief
and reset seed while preserving frozen identity/runtime fields including
agent, assignment, backend, cwd, tasks, schedule, launcher, hooks, and
selected backendConfig, including Codex stdio, websocket, or UDS
transport, plus the selected backend's frozen args.

The operation is all-or-nothing. Validation failures, required-var
failures, locked `message` / rendered task fields, and prepare/render
errors leave the previous manifest unchanged. Accepted changes append a
`run.reconfigured` audit row that records changed var keys and whether
the message changed, not var values or message text.

### Archive, unarchive, delete

- `run archive` sets `archivedAt` on a non-running run.
- `run unarchive` clears `archivedAt`.
- `run delete` permanently removes the workspace. Only archived,
  non-running runs are deletable. The workspace is removed, not moved to
  trash, so any `run-events.jsonl` file disappears with the rest of the run.

### set-name

Update or clear the human-facing display name. Use `--clear` to remove it.
Does not change run state or task state.

### set-note / clear-note

Persist or clear a markdown note on the run. Whitespace-only note writes
clear the field. Text output never prints the note body; it only reports
whether the mutation changed state.

### pin / unpin

Persist or clear the run's `pinned` flag. Pinning is metadata only: it
does not change lifecycle state, task state, archive state, or
dependency readiness.

### set-backend-session / clear-backend-session

Passive-only metadata mutations. Update `manifest.backendSessionId` without
changing task state, lifecycle status, attempt history, archive state, or
dependency projections. Both mutations clear `manifest.backendSessionSync`
because externally tracked passive session ids have no agent-runner-owned
history reader.

### set-group / clear-group

`run set-group` moves a non-running run into an explicit group and stores
the same value in `manifest.resetSeed`. `run clear-group` resets a
non-running run to its singleton group, where `runGroupId` equals
`runId`. Both mutations are cycle-checked because group membership can
affect dependency reachability.

Group mutation does not re-interpolate frozen run surfaces. Existing
`manifest.cwd`, `manifest.launcher`, brief text, task text, and reset-seed
launcher/cwd values keep the concrete strings resolved when the run was
created. Initialized-run reconfigure can replace frozen launcher values
from the rebuilt seed, but group mutation still does not re-interpolate
them.

Runs with group-scoped execution environment resources are stricter:
`run set-group` and `run clear-group` reject them because their frozen
container name and workspace mount paths are already tied to the original
group id.

### Dependencies

`add-dep`, `remove-dep`, and `clear-deps` are only allowed on initialized
runs. See [dependencies.md](dependencies.md).

## Listing runs

```bash
agent-runner list runs
agent-runner list runs --cwd <path>
agent-runner list runs --repo <name>
agent-runner list runs --global
agent-runner list runs --include-archived
agent-runner list runs --group-id <group-id>
```

By default, `list runs` scopes to the caller's exact cwd. `--repo <name>`
scopes to an exact repo bucket. `--global` lists across all buckets.
`--include-archived` adds archived runs to any of the above. `--group-id`
scopes to one run group and is mutually exclusive with `--cwd`, `--repo`,
and `--global`.

## Execution modes

Every run persists an `execution` record:

- `hostMode: "embedded"` — ran in the CLI process
- `hostMode: "daemon"` — ran inside `agent-runner serve`, with
  `controller.daemonInstanceId` linking back to that daemon instance

See [daemon.md](daemon.md) for how the daemon adopts and publishes runs.

## Capabilities

The daemon and CLI expose a `RunCapabilities` boolean block on each run so
clients do not reimplement lifecycle gates:

- `canArchive`, `canUnarchive`, `canReset`, `canDelete`, `canReady`,
  `canResume`, `canAbort`, `canReconfigure`
- `taskMutation.canSetStatus`, `taskMutation.canEditNotes`,
  `taskMutation.canAdd`

When `canAbort` is `false`, the `abortReason` field explains why
(`"already_terminal"` or `"not_active_in_daemon"`).
When `canReconfigure` is `false`, `reconfigureReason` is `"archived"`
or `"not_initialized"` when applicable.

## Resume

Resume is its own topic — see [resume.md](resume.md).

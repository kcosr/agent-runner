# task-runner Design

This is the canonical design document. It describes the end-state model,
schema, lifecycle rules, and repo layout that the implementation and the
other docs agree on.

For a friendlier tour of the same concepts, start with
[concepts.md](concepts.md).

## Purpose

`task-runner` is a manifest-canonical CLI for running agents against a
structured task list. The system is designed around a small number of
explicit concepts:

- runs are persisted in `run.json`
- task state is canonical in the manifest
- workers interact through the task CLI
- `brief` is the canonical worker handoff
- caller-facing documentation stays separate from worker-facing
  instructions

The current manifest schema is version `23`. Older manifest shapes are not
silently upgraded or dual-read at runtime.

## Non-goals

- a remote multi-user control plane
- workspace-file task editing as a first-class workflow
- backward-compatibility shims for removed manifest or CLI contracts
- automatic proof that a worker really performed a task

## End-state model

### Agent

An agent definition provides backend/runtime configuration and role
instructions:

- `backend`
- `model`
- `effort`
- `timeoutSec`
- `unrestricted`
- optional `launcher`
- optional `executionEnvironment`
- optional `backendConfig` runtime config keyed by backend name
- optional `backendArgs` entries keyed by backend name
- `lockedFields`
- role instructions (markdown body)

Agents are parsed from `agent.md` files in the config tree or direct
paths; see [agents-and-assignments.md](agents-and-assignments.md).
Custom backend modules are parsed from
`${TASK_RUNNER_CONFIG_DIR}/backends/<backend-name>/backend.(ts|mts|js|mjs)`.
They are trusted local code, loaded without sandboxing, cached for the
process lifetime, and daemon changes require restart.

### Launcher

A launcher definition is a named subprocess prefix stored under
`${TASK_RUNNER_CONFIG_DIR}/launchers/*.yaml|*.yml`.

- built-in `direct` means "spawn the backend directly"
- agents may author `launcher` as either a named string or an inline
  launcher object
- fresh-run/init callers may override with named-only `--launcher`
- launchers are resolved once at fresh-run/init time and frozen into the
  manifest and reset seed

### Execution Environment

An execution environment is a named container definition stored under
`${TASK_RUNNER_CONFIG_DIR}/environments/*.yaml|*.yml`. Agents may select
one with `executionEnvironment`, and fresh `run` / `init` callers may
override that selection with `--environment <name|path>`.

The current environment implementation supports `kind: container` with
two modes:

- `existing` validates and executes inside an already-running Docker or
  Podman container without stopping or removing it.
- `managed` creates an idle run- or group-scoped container, executes
  backend subprocesses through `docker exec` / `podman exec`, and records
  cleanup state on terminal cleanup.

Managed environments may define a first-class `workspace` mount. The
workspace resolves a host path by run or run group, creates that host
directory when requested, bind-mounts it at a container path, and rewrites
environment cwd values inside the host workspace to the matching
container path. Managed environments may also define `sessionMounts`
presets for backend session stores used by host-side session sync.
Generic `mounts` remain for auth stores, caches, sockets, and other
non-workspace paths.

Execution environments are resolved after final cwd/runtime vars are
known, frozen into `manifest.executionEnvironment`, and copied into
`manifest.resetSeed.executionEnvironment`. They are separate from
`manifest.execution`, which records embedded vs daemon controller
provenance.

### Assignment

An assignment definition provides reusable work:

- `cwd`
- `vars` schema
- `tasks`
- optional default `message`
- optional `callerInstructions`
- optional `schedule`
- assignment instructions (markdown body)
- `maxRetries`, `lockedFields`

Assignments are markdown definitions in the config tree or direct paths
supplied by the caller. They are inputs to run creation, not a live
workspace surface.

Assignment `tasks:` authoring is loader-centric. The authored list may
mix inline task objects, named task refs under
`${TASK_RUNNER_CONFIG_DIR}/tasks/<task-id>.md`, and explicit task file
paths. `loadAssignmentConfig()` resolves those refs into the existing
plain task shape before run creation; runtime still performs later
`{{var}}` interpolation against the resolved tasks during brief
construction.

Canonical definition identity comes from the on-disk key:

- agents: slash-relative directory under `agents/`
- assignments: slash-relative directory under `assignments/`
- tasks: slash-relative file under `tasks/`
- launchers: slash-relative file under `launchers/`
- environments: slash-relative file under `environments/`

Discovery warns and skips definitions whose authored internal id does
not match that canonical key, while direct named/path loads of the same
definition still fail clearly.

### Run

A run is a frozen execution record in:

```text
${TASK_RUNNER_STATE_DIR}/runs/<repo-name>/<run-id>/
```

The canonical record is `run.json`. Important persisted fields:

- frozen agent metadata
- frozen assignment metadata (or `null` for chat-style runs)
- `repo`, `cwd`
- `backend`, `model`, `effort`, `backendConfig`,
  `resolvedBackendArgs`, `timeoutSec`, `unrestricted`,
  `maxAttemptsPerSession`, `launcher`
- `executionEnvironment` (`null` for host execution)
- `lockedFields` (union of agent and assignment locks)
- `status`, `exitCode`
- `startedAt`, `updatedAt`, `endedAt`, `archivedAt`
- `schedule` (`RunSchedule | null`)
- `finalTasks` (canonical task state)
- `tasksCompleted`, `tasksTotal`
- `brief` (composed worker handoff)
- `callerInstructions`
- `backendSessionId` (backend-native resume handle; Claude, Codex,
  Cursor, OpenCode, Pi, etc. each store their own flavor here)
- `backendSessionSync` (backend-owned history source, cursor, imported
  turn ids, open turn ids, and last sync/error metadata)
- `runGroupId`
- `dependencies` (typed upstream run or group refs)
- `parentRunId` (lineage only)
- `resolvedHooks` (the frozen hook descriptors selected at first write)
- `hookState` (hook-owned state bag)
- `hookAudits` (per-hook execution audit records)
- attachment metadata
- queued resume messages (`queuedResumeMessages`)
- attempt and session history with `task_runner` or `backend_session`
  provenance
- `runtimeVars` (frozen concrete values)
- `runtimeVarSources` (frozen var provenance for projection-time redaction)
- `resetSeed` (snapshot used by `run reset`)
- `execution` (host mode and controller)

A run is the durable lifecycle record. Each backend execution window is a
session: the fresh execution creates session `0`, and each resume creates
the next session. Attempts are backend invocations within a session.
`maxAttemptsPerSession` is the per-session retry budget. Attempt numbers
are monotonic across the run, while `attemptIndexInSession` is zero-based
within its session.

Manifest schema version 23 adds resolved managed-container workspace
lifecycle state.
Manifest schema version 22 adds resolved backend session mount presets.
Manifest schema version 21 adds managed-container workspace mount state
and group-scoped container lifetimes. Manifest schema version 20 adds
frozen execution environment state for host or containerized execution.
Manifest schema version 19 adds
backend-session history provenance and
sync state. Task-runner-owned records carry
`provenance.kind: "task_runner"`. Backend-imported records carry
`provenance.kind: "backend_session"` plus backend name, backend session
id, backend turn id, import/sync timestamps, mode (`bootstrap` or
`sync`), and source descriptor. `manifest.backendSessionSync` stores the
last resolved source, cursor, imported turn ids, open turn ids, last sync
timestamp, and last error.

If the run started from an assignment file, task-runner also stores
`assignment-seed.md` as an immutable audit snapshot. Runs created by
current code also include `run-events.jsonl`; pre-feature workspaces may
still lack it. The file is append-only diagnostic history for major
lifecycle/task mutations, survives `run reset`, is surfaced through
`task-runner run audit <run-id>` plus daemon audit APIs, and is never
used to reconstruct canonical state.
Manifest and DTO assignment metadata store identity only (`name` and
`sourcePath`); the audit snapshot path is derived from the workspace and
is not part of the public run contract.

Scheduling is manifest-canonical. The persisted contract is
`manifest.schedule`, not an external queue or daemon-local database.
Projection surfaces derive `scheduleState` (`none`, `paused`, `future`,
or `due`) from `manifest.schedule` and the current time. `scheduleState`
is not persisted, migrated, or accepted as input.

Queued resume messages are also manifest-canonical. The persisted
contract is `manifest.queuedResumeMessages`, an ordered array of `{ id,
text, createdAt }` records. These records represent user intent that
should be applied to a later resume/start opportunity; they are not
backend live interrupts and they are not stored in daemon-local memory.

## Brief and caller instructions

task-runner maintains two separate instruction surfaces.

### Worker brief

`brief` is the worker-facing handoff. It is composed from:

1. agent role instructions
2. assignment instructions
3. task-runner's worker workflow template (when tasks exist)
4. the run message

The workflow template teaches the worker to use:

- `task-runner task list <run-id>`
- `task-runner task show <run-id> <task-id>`
- `task-runner task set <run-id> <task-id> --status ...`
- `task-runner task append-notes <run-id> <task-id> --text ...`
- `task-runner run status <run-id>`

The public read surface is:

```bash
task-runner run brief <run-id>
task-runner run audit <run-id>
```

`run brief` is text-only. It is not projected through `run status --field ...`.
`run audit` is the raw persisted audit-history read surface.

### Caller instructions

`callerInstructions` are assignment docs for the human or script using
task-runner. They are:

- interpolated at run creation time
- printed on fresh `run` / `init`
- available in `run status --output-format json`
- never sent to the backend

This split keeps operator workflow text out of worker prompts.

## Hooks

Assignment hooks are part of the frozen manifest contract, not an
ephemeral loader detail.

Fresh `run` / `init`:

1. load the authored assignment hook entries
2. resolve `builtin` / named / path hook descriptors
3. run `prepare` hooks before the first manifest write
4. freeze the resolved descriptors plus any prepare-time mutations into
   `manifest.resolvedHooks`, `manifest.runtimeVars`, `manifest.cwd`,
   `manifest.hookState`, prompt state, attachments, and reset seed

Resume and reset do not re-run prepare hooks from current source files.
They reuse the frozen manifest descriptor/config and the prepare outputs
captured at first write.

Phase behavior:

- `prepare` may mutate runtime vars and all other hook-owned run state.
- `beforeAttempt`, `afterAttempt`, and `afterExit` may continue, block,
  or request a follow-up prompt reinvocation.
- `taskTransition` wraps all task mutations from the run loop and task
  command surfaces. Task-local `tasks[].hooks[]` run before root
  `hooks.taskTransition[]`, and rejections roll back the requested task
  edit while preserving the hook's own accepted side effects such as
  notes, pins, attachments, or task patches.

The built-in `command` hook supports:

- `mode: status` — zero exit is success, non-zero blocks/rejects
- `mode: json` — zero exit plus JSON stdout returning the full hook
  result payload; malformed JSON is a runtime error

The built-in `require-children-success` hook is task-transition only. It
checks direct child runs by `parentRunId` inside core state and rejects
completion until every direct child is `success`. Target task selection
is handled natively by task-local placement or task-transition
`when.taskId` / `when.taskIds`, not by builtin-local config.

The built-in `git-worktree` hook runs in `prepare` and `beforeAttempt`.
It creates or reuses a worktree, switches the run cwd to that path, and
in `prepare` also projects `worktree_path` into runtime vars.

Declarative `when` support remains narrow: attempt-phase hooks support
`when.sessionIndex` and `when.attemptIndexInSession`, while task-transition
hooks support `when.taskId`, `when.taskIds`, `when.fromStatus`,
`when.toStatus`, and `when.source`.

## Task state model

Task state is canonical in `manifest.finalTasks` for all runs.

Statuses:

- `pending`
- `in_progress`
- `completed`
- `blocked`

There is one task workflow. The system does not branch between multiple
task interaction modes.

Mutation rules (non-passive):

- initialized runs allow `task set`, `task append-notes`, and `task add`
  (unless `tasks` is locked)
- ready runs allow `task append-notes`, but not status changes or
  `task add`
- running runs allow `task set` and `task append-notes`, but not
  `task add`
- terminal non-passive runs allow `task set` and `task append-notes`,
  but not `task add`; these edits update coordination task state while
  lifecycle fields such as `status`, `endedAt`, `exitCode`, sessions,
  attempts, and backend session id remain the historical execution
  record until a later run execution changes them normally

Passive runs are driven externally through the task CLI. Their effective
status is derived from the task set (all completed → `success`; any
blocked with the rest completed or blocked → `blocked`; otherwise
`initialized`).

## Lifecycle

### Fresh run

`task-runner run`:

1. resolves agent and assignment definitions
   (parse frontmatter, apply config-time `${...}` env interpolation on
   allowed scalar surfaces, then schema-validate)
   Named and explicit-path task refs are resolved here, before runtime
   interpolation.
2. enforces locked fields
3. loads the selected execution environment, merges any environment
   `vars` with assignment `vars`, resolves the merged vars in authored
   `sources` order (`cli`, `web`, `env`, `parent`), and applies
   `default` / `required` only after every source fails
4. allocates or reuses the run id and resolves `runGroupId`. Fresh
   workspaces use explicit request, `TASK_RUNNER_RUN_GROUP_ID`, nearest
   parent lineage, or the singleton run id; reinitializing an existing
   initialized run preserves the frozen manifest group.
5. builds injected runtime variables, then resolves cwd:
   `--cwd` → assignment `cwd` → caller cwd
6. rebuilds injected variables with the final cwd
7. captures `repo` from the resolved cwd and creates the run workspace
8. resolves selected backendConfig through the backend (for Codex
   transport: authored backendConfig → request override → current process
   UDS/WS env → stdio default)
9. resolves the selected backend's authored `backendArgs` into frozen
   `resolvedBackendArgs` (passive resolves to `[]`)
10. resolves launcher precedence (`--launcher` override → agent launcher →
   `direct`, with passive and Codex websocket/UDS forced to `direct`) and
   runtime-interpolates prefix launcher command/args
11. builds the provisional prepare manifest
12. runs prepare hooks, then freezes final cwd/runtime vars/backend
    outputs, task text, and launcher values
13. composes and stores `brief`
14. imports complete backend-owned history when `--backend-session-id`
   is present and the backend supports history reads
15. invokes the backend, or leaves the run initialized if the backend is
   `passive`

Nested `task-runner` invocations automatically carry
`TASK_RUNNER_PARENT_RUN_ID`, so child runs freeze an explicit lineage
edge at creation time. Descendants read inherited vars from the nearest
ancestor that already froze the value. Nested invocations also carry
`TASK_RUNNER_RUN_GROUP_ID`, so child runs join the parent's run group by
default. The parent edge remains lineage for variable inheritance and
child-run hooks; run groups control group-scoped attachments, filters,
and group dependencies.

### Init

`task-runner init` performs the same setup work without invoking the
backend. This is important for:

- passive runs
- delayed execution
- planning flows where the caller wants to inspect the run before
  executing it

`init` no longer dumps the worker handoff body to stdout. Operators
fetch it explicitly with `task-runner run brief <run-id>`.

### Ready and start

For non-passive initialized runs:

```bash
task-runner run ready <run-id>
task-runner run --resume-run <run-id>
```

`run ready` promotes the run from `initialized` to `ready` without
starting the backend. The subsequent first `run --resume-run` reuses the
stored `manifest.brief` verbatim as the execution handoff.

`run ready` may also attach a schedule with one of `--schedule-at`,
`--schedule-delay`, or `--schedule-cron`. The run remains `ready` until
the schedule is due. A manual start is still legal: one-time schedules
are consumed before execution, while recurring schedules keep their
current `runAt` if they are manually started early.

### Scheduling

Schedules are frozen into `manifest.schedule` at initialization/ready
time or through explicit schedule mutation commands. The input contract
is a flat shape with exactly one of `at`, `delay`, or `cron`.
`timezone`, `mode`, and `continueOnFailure` are cron-only. Assignment
frontmatter may author the same schedule shape, and `schedule` is a
lockable field.

One-time schedules persist as:

```ts
{ enabled: true, runAt: string, recurrence: null }
```

Recurring schedules persist the next `runAt` plus:

```ts
{
  schedule: { type: "cron", expression: string, timezone: string },
  mode: "reuse" | "reset" | "clone",
  continueOnFailure: boolean
}
```

The schedule guardrails are enforced at trust boundaries:

- `TASK_RUNNER_MIN_SCHEDULE_DELAY_SEC` rejects too-soon one-time
  schedules
- `TASK_RUNNER_MIN_RECURRENCE_INTERVAL_SEC` rejects too-frequent cron
  schedules and disables an already-persisted recurrence if a later
  advancement violates the same minimum
- cron recurrence interval checks use a bounded sample of future
  occurrences

Recurring completion is determined by the persisted `mode`:

- `reuse` advances `runAt` on the existing run
- `reset` resets the existing run from its frozen `resetSeed`, then
  advances `runAt`
- `clone` creates a new ready child run from the frozen reset seed and
  frozen `assignment-seed.md`, then attaches the advanced schedule to
  the clone

Failures stop recurrence unless `continueOnFailure` is true. Reset,
resume, and clone do not re-read current source definitions for schedule
data. This is a hot-cut schema-v12 contract; there is no compatibility
fallback or dual-shape parser for earlier manifest scheduling shapes.

Reinitialize is allowed only while a run is still `initialized`. It
rebuilds the initial manifest and applies assignment-authored schedule
config plus explicit schedule overrides at that boundary. After the run
is `ready`, schedule changes go through `run schedule` mutations rather
than ready-start overrides.

Reconfigure is a narrower initialized-only mutation for changing
runtime vars and/or the initial message without changing run identity.
It uses the frozen agent, assignment, hooks, launcher, tasks, cwd,
schedule, selected backend args, and backend-specific config already
stored on the manifest, rerenders the brief/reset seed, and commits the
replacement manifest only after validation and prepare/rendering succeed.
It appends
`run.reconfigured` with changed var keys and a message-changed boolean,
not secret values or message text.

### Resume

Resume is manifest-based. Source agent and assignment files are not
re-read.

Important rules:

- `--agent`, `--assignment`, `--backend`, `--backend-session-id`,
  `--cwd`, `--name`, and `--var` are forbidden on resume
- resume reuses the frozen `manifest.backendConfig`; it does not
  re-resolve Codex transport from current env or new daemon request
  overrides
- resume reuses the frozen `manifest.resolvedBackendArgs`; it does not
  re-read current agent `backendArgs`
- resume reuses the frozen `manifest.launcher`; `--launcher` is
  forbidden on resume and ready-start
- incomplete-task resumes may omit a follow-up message (an implicit
  continue message is used)
- resumes of otherwise-complete runs must supply a follow-up message
  or `--add-task`
- archived runs must be unarchived first
- passive runs are not executed through `run --resume-run`
- dependencies gate execution: declared run dependencies must be in
  `success`, and declared group dependencies require every non-archived
  group member to be `success`
- backend-owned session history sync runs before allocating the next
  session index or attempt number when the backend supports it; this is
  subscriber-independent, and a changed source that cannot be synced
  safely fails resume before allocation

See [resume.md](resume.md).

### Queued resume messages

`task-runner run queue-message <id|path> <text>` appends a normalized
message to `manifest.queuedResumeMessages`. `task-runner run
queued-messages <id|path>` reads the existing run detail projection, and
`task-runner run remove-queued-message <id|path> <message-id>` removes one
pending message. Daemon HTTP and WebSocket RPC expose the same queue and
remove mutations.

Queued resume message mutations are allowed only for runs that can accept
pending resume intent under the shared command service rules. Connected
CLI mutations route through daemon WebSocket RPC so daemon projections,
audit, and the web dashboard stay synchronized. The web Chat composer
switches to `Queue` when `RunDetail.isLive` is true, even though live
runs do not expose normal `canResume` capability.

When a daemon-managed run finishes, the daemon checks for queued resume
messages before it publishes the terminal projection and before it
evaluates schedule/dependency follow-on work. Drained messages are
combined into the resume message for the next session and removed from
the manifest only after the resume start path accepts them. If automatic
resume fails before the queued intent is accepted, the messages remain
queued for retry or manual removal and the normal terminal
schedule/dependency evaluation still runs.

### Reset

`run reset <id|path>` restores the initialized-state seed stored in the
manifest for non-running runs. Reset does not re-read current source
definitions. It reuses the frozen launcher and other initialized
runtime config captured in the reset seed. Manual reset preserves
`manifest.schedule`; reset-seed data does not overwrite it.

### Delete archived runs

`run delete <id|path>` permanently removes an archived, non-running run
workspace. Only archived runs are eligible, and the workspace is removed
rather than moved to trash.

## Backend config freezing

Authored `backendConfig` is keyed by backend name. Fresh-run/init selects
only the active backend's config, passes it to the selected backend's
optional `resolveConfig(ctx)`, and stores only the selected resolved value
on both `manifest.backendConfig` and `manifest.resetSeed.backendConfig`.
Custom backends own their config shape and receive the final run cwd as
`ctx.cwd` when invoked.

For Codex, fresh runs resolve:

`backendConfig.codex.transport` → request
`overrides.backendConfig.codex.transport` → current process
`TASK_RUNNER_CODEX_UDS_PATH` or `TASK_RUNNER_CODEX_WS_URL` →
`{ type: "stdio" }`.

Connected CLI calls do not forward caller-local Codex transport env; the
daemon resolves Codex env from the daemon process.

The transport union is exactly `{ type: "stdio" }`, `{ type: "ws", url:
"<absolute ws:// or wss:// URL>" }`, or `{ type: "uds", path:
"/absolute/socket/path" }`. UDS is WebSocket-over-UDS for Codex
app-server, not raw socket bytes. If both UDS and WS env vars are set
without a higher-precedence transport, resolution fails fast.

This is an explicit Codex-only env contract. There is no generic
backend-specific env passthrough layer for other backends.

## Backend argument freezing

Agent frontmatter may author `backendArgs.<backend>.extraArgs` arrays for
backend-owned flags. The selected backend's args are resolved at
fresh-run/init time, after prepare hooks have settled the final backend,
and stored on `manifest.resolvedBackendArgs` and
`manifest.resetSeed.resolvedBackendArgs`.

The selected backend receives those args after task-runner's generated
flags. Duplicate backend flags are passed through without validation so
the underlying tool owns interpretation. Passive runs freeze `[]`; Codex
stdio receives the args as `codex app-server ...`, while Codex websocket
and UDS runs ignore them because task-runner is connecting to an existing
app-server.

`run.json` is a local audit record and stores the frozen args. Shared
status projections and normal daemon/web DTOs do not expose them. Reset,
resume, ready-start, reconfigure, and recurring reuse/clone flows use the
frozen manifest or reset seed rather than current agent files.

## Launcher freezing

Launcher resolution also happens exactly once, at fresh-run/init time.
The resolved launcher is runtime-interpolated and stored on both
`manifest.launcher` and `manifest.resetSeed.launcher`.

- Embedded / local fresh runs resolve named launchers from the caller's
  config root.
- Connected / daemon-owned fresh runs resolve named launchers on the
  daemon host.
- The built-in `direct` launcher is always available and reserved.
- Launchers only affect subprocess-backed execution. Passive runs and
  Codex websocket/UDS transport keep `direct`.
- Resume, ready-start, reset, and recurring reset/clone reuse the frozen
  launcher. Initialized-run reconfigure rebuilds initialized surfaces from
  the frozen seeds and re-freezes launcher values when vars or message
  changes require a new seed.

Run group mutation is intentionally not a re-interpolation operation.
`run set-group` and `run clear-group` update `manifest.runGroupId` and
`manifest.resetSeed.runGroupId`, but previously frozen cwd, launcher,
brief, and task strings keep the values resolved when the initialized
manifest was built.

## Public command contract

### Read surfaces

- `task-runner status`
- `task-runner run status <run-id>`
- `task-runner run brief <run-id>`
- `task-runner run audit <run-id>`
- `task-runner task list <run-id>`
- `task-runner task show <run-id> <task-id>`
- `task-runner attachment list <run-id> [--scope run|group]`

Rules:

- Top-level `status` reports system/environment status and takes no run id.
- `run status`, `run brief`, and `run audit` are run-id-only.
- `attachment list` defaults to `group`, which includes every run whose
  `runGroupId` matches the target run. Use `--scope run` for target-only
  attachment listing.

### Mutation surfaces

- `task-runner task set|append-notes|add`
- `task-runner attachment add|remove`
- `task-runner run reset|archive|unarchive|delete|set-name|`
  `set-backend-session|clear-backend-session`
- `task-runner run queue-message|remove-queued-message`
- `task-runner run schedule [set]|enable|disable|clear`
- `task-runner run set-group|clear-group`
- `task-runner run add-dep|remove-dep|clear-deps`

`run set-backend-session` / `run clear-backend-session` are
passive-only metadata mutations. They update `manifest.backendSessionId`
without changing task state, lifecycle status, attempt history, archive state,
or dependency projections, and clear `manifest.backendSessionSync`.

Dependency mutations are only allowed on `initialized` runs. Group
mutations are allowed only for non-running runs and are cycle-checked.

Queue mutations update `manifest.queuedResumeMessages`, append queue audit
events, and publish fresh summary/detail projections. They do not create
an attempt or session by themselves.

### Daemon surface

`task-runner serve` hosts:

- WebSocket JSON-RPC for CLI clients
- HTTP and SSE for browser clients
- the bundled web UI

CLI commands can route through the daemon with `--connect` or
`TASK_RUNNER_CONNECT`.

The daemon evaluates schedules from manifests on startup and after
schedule mutations, ready/reset/archive/unarchive changes, dependency
changes, and run completion. Future schedules are armed with timers.
Due schedules found during daemon startup are treated as missed/skipped
instead of being started immediately: one-time schedules are cleared
with an audit reason, while recurring schedules advance to the next
eligible occurrence. This avoids replaying stale work after downtime.

The daemon treats queued resume messages as daemon-owned pending user
intent. It reads them from the manifest, publishes their count on run
summaries and the full list on run details, drains them at automatic
start boundaries, and leaves them persisted if the start attempt fails
before the backend accepts the resume message.

The daemon also owns subscribed-run backend-session sync for non-running
runs with a backend session id and a backend history reader. Detail,
timeline, and audit subscriptions start polling; summary-only
subscriptions do not. A changed source is synced into the manifest with
the same backend-session sync helper used by pre-resume, under the
workspace task-state lock. The daemon refreshes indexes and publishes
normal summary/detail projections plus
`run.backend_session_history_synced` audit envelopes for imported turns,
and a timeline invalidation event so selected Chat/Attempts views refetch
history. Sync failures publish `run.backend_session_history_sync_failed`
audit envelopes and update `backendSessionSync.lastError` when previous
sync metadata exists.

Live subscriptions are split by responsibility instead of sharing one
mixed event bus:

- global summary stream: `GET /api/events/run-summaries` (`summary_upsert`
  and `summary_removed`)
- per-run detail stream: `GET /api/runs/:runId/events/detail`
- per-run audit history query: `GET /api/runs/:runId/audit`
- per-run audit stream: `GET /api/runs/:runId/events/audit`
- per-run timeline history query: `GET /api/runs/:runId/timeline`
- per-run timeline stream: `GET /api/runs/:runId/events/timeline`

The WebSocket subscription contract mirrors that split:

- `events.subscribe { channel: "run_summary" }`
- `events.subscribe { channel: "run_detail", runId }`
- `events.subscribe { channel: "run_audit", runId }`
- `events.subscribe { channel: "run_timeline", runId }`

Notifications:

- `run.summary` carries a `summary_upsert` with a fresh `RunSummary` or a
  `summary_removed` with a `runId`
- `run.detail` carries a fresh `RunDetail`
- `run.audit` carries one `RunAuditEnvelope { runId, cursor, event }`
- `run.timeline` carries one `RunTimelineEnvelope { runId, cursor, event }`

Hooks do not add a fourth daemon event channel. Their externally visible
state is carried inside the existing `RunSummary` and `RunDetail`
projections (`hookCount` on summaries; `resolvedHooks`, `hookState`, and
`hookAudits` on detail), and hook-driven task/note/attachment changes
reuse the existing summary/detail/timeline publication flow.

Shared run capabilities remain the canonical UX gate for lifecycle
actions. `RunCapabilities` includes `canArchive`, `canUnarchive`,
`canReset`, `canDelete`, `canReady`, `canResume`, `canAbort`, and the
initialized-only `canReconfigure` gate, plus the `taskMutation`
sub-booleans. Browser and daemon clients should use those booleans
directly instead of reproducing lifecycle state checks locally.

Passive backend-session editing is an explicit detail-surface mutation.
Because set/clear writes `run.json` and advances `updatedAt`, the daemon
publishes fresh `RunSummary` and `RunDetail` projections after changed
backend-session edits so update-order consumers stay synchronized.

`RunSummary` and `RunDetail` both expose derived `activeTask` data so
live consumers do not need to re-scan task arrays to render the current
in-progress task label. Timeline and audit consumers subscribe first,
fetch `/api/runs/:runId/timeline` or `/api/runs/:runId/audit`, then
apply buffered live envelopes where `cursor > history.lastCursor`.

`RunSummary` and `RunDetail` also expose the persisted manifest
`updatedAt` timestamp. Browser and daemon clients use that factual
timestamp for durable dashboard ordering; the daemon does not persist
dashboard-specific ordering fields.

## Workspace layout

Typical workspace:

```text
${TASK_RUNNER_STATE_DIR}/runs/<repo-name>/<run-id>/
├── run.json
├── assignment-seed.md
├── attempts/
│   ├── 01.json
│   └── 01.stdout.log      # optional, when TASK_RUNNER_CAPTURE_BACKEND_STDOUT=1
└── attachments/
    └── <attachment-id>/
```

Notes:

- `assignment-seed.md` exists only when the run started from an assignment
  file.
- Attempt logs are append-only audit records.
- Attachment metadata lives in the manifest; attachment bytes live under
  `attachments/`.
- Family-scoped attachment grouping is derived at read time only;
  ownership and storage remain per-run, and cross-run rows stay preview
  / download-only.

## Prompt and retry behavior

On first execution, the backend receives the composed `brief`.

If tasks remain incomplete at the end of an attempt, task-runner composes
a retry nudge that:

- points the worker back at the task CLI
- identifies incomplete tasks
- preserves the run id as the operating handle

Added tasks on resume trigger a reminder that new work was appended and
should be reviewed through the task CLI.

## Recursion guard

`TASK_RUNNER_MAX_CALL_DEPTH` (default `1`) bounds the depth of nested
`task-runner` invocations, propagated via `TASK_RUNNER_CALL_DEPTH` on
each child process. Exceeding the cap raises `RecursionDepthError`.

## Repo layout

High-signal code paths:

- `apps/cli/src/cli.ts`
- `apps/cli/src/cli/parse-args.ts`
- `apps/cli/src/commands/render.ts`
- `apps/cli/src/daemon/`
- `packages/core/src/core/run/run-loop.ts`
- `packages/core/src/core/run/manifest.ts`
- `packages/core/src/core/run/workspace-state.ts`
- `packages/core/src/core/commands/service.ts`
- `packages/core/src/contracts/`
- `packages/core/src/backends/`

Bundled agents and assignments live under `agents/` and `assignments/`.

## Development checks

Standard verification:

```bash
npm run build
npm run lint
npm run lint:fix
npm run format
npm run format:check
npm run imports:fix
npm run imports:check
npm run check:knip
npm run test:all:local
npm test
npm run check
```

The root `test` pipeline runs:

1. `npm run build`
2. test gate

The root `check` pipeline runs:

1. `npm run build`
2. `npm run lint`
3. `npm run format:check`
4. `npm run imports:check`
5. test gate

`npm run lint` runs Biome linting only, with warnings treated as
failures, and `npm run lint:fix` applies Biome lint autofixes. `npm run
format` writes Biome formatting, `npm run format:check` verifies
formatting without writing, `npm run imports:fix` applies Biome import
organization, and `npm run imports:check` verifies import organization
without writing. `npm run test:all:local` runs Node and web tests locally.
The test gate runs `npm run test:all:local` by default. When
`TASK_RUNNER_TEST_REMOTE_HOST` is set, the test gate syncs the worktree to
that remote host, runs `node --test --test-reporter=dot
"test/**/*.test.mjs"`, and then runs `npm run test:web`.
`npm run check:knip` runs the unused-file/export/dependency baseline
separately from the standard `check` pipeline.

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

The current manifest schema is version `13`. Older manifest shapes are not
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
- optional `backendSpecific` runtime config
- optional `backendArgs` entries keyed by backend id
- `lockedFields`
- role instructions (markdown body)

Agents are parsed from `agent.md` files in the config tree or direct
paths; see [agents-and-assignments.md](agents-and-assignments.md).

### Launcher

A launcher definition is a named subprocess prefix stored under
`${TASK_RUNNER_CONFIG_DIR}/launchers/*.yaml|*.yml`.

- built-in `direct` means "spawn the backend directly"
- agents may author `launcher` as either a named string or an inline
  launcher object
- fresh-run/init callers may override with named-only `--launcher`
- launchers are resolved once at fresh-run/init time and frozen into the
  manifest and reset seed

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
- `backend`, `model`, `effort`, `backendSpecific`,
  `resolvedBackendArgs`, `timeoutSec`, `unrestricted`,
  `maxAttemptsPerSession`, `launcher`
- `lockedFields` (union of agent and assignment locks)
- `status`, `exitCode`
- `startedAt`, `endedAt`, `archivedAt`
- `schedule` (`RunSchedule | null`)
- `finalTasks` (canonical task state)
- `tasksCompleted`, `tasksTotal`
- `brief` (composed worker handoff)
- `callerInstructions`
- `backendSessionId` (backend-native resume handle; Pi, Codex, Claude,
  etc. each store their own flavor here)
- `dependencyRunIds`
- `parentRunId`
- `resolvedHooks` (the frozen hook descriptors selected at first write)
- `hookState` (hook-owned state bag)
- `hookAudits` (per-hook execution audit records)
- attachment metadata
- attempt and session history
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

If the run started from an assignment file, task-runner also stores
`assignment-seed.md` as an immutable audit snapshot. Runs created by
current code also include `run-events.jsonl`; pre-feature workspaces may
still lack it. The file is append-only diagnostic history for major
lifecycle/task mutations, survives `run reset`, is surfaced through
`task-runner run audit <run-id>` plus daemon audit APIs, and is never
used to reconstruct canonical state.

Scheduling is manifest-canonical. The persisted contract is
`manifest.schedule`, not an external queue or daemon-local database.
Projection surfaces derive `scheduleState` (`none`, `paused`, `future`,
or `due`) from `manifest.schedule` and the current time. `scheduleState`
is not persisted, migrated, or accepted as input.

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
- terminal runs allow notes edits, not status changes

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
2. resolves cwd: `--cwd` → assignment `cwd` → caller cwd
3. resolves vars in authored `sources` order (`cli`, `env`, `parent`)
   and applies `default` / `required` only after every source fails
4. enforces locked fields
5. captures `repo` from the resolved cwd and creates the run workspace
6. resolves backend-specific runtime config (for Codex transport:
   frontmatter → daemon request override → UDS/WS env → stdio default)
7. resolves the selected backend's authored `backendArgs` into frozen
   `resolvedBackendArgs` (passive resolves to `[]`)
8. resolves launcher precedence (`--launcher` override → agent launcher →
   `direct`, with passive and Codex websocket/UDS forced to `direct`)
9. freezes the initial manifest
10. composes and stores `brief`
11. invokes the backend, or leaves the run initialized if the backend is
   `passive`

Nested `task-runner` invocations automatically carry
`TASK_RUNNER_PARENT_RUN_ID`, so child runs freeze an explicit lineage
edge at creation time. Descendants read inherited vars from the nearest
ancestor that already froze the value.

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
- resume reuses the frozen `manifest.backendSpecific` runtime config; it
  does not re-resolve Codex transport from current env or new daemon
  request overrides
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
- dependencies gate execution: all declared dependency runs must be in
  `success`

See [resume.md](resume.md).

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

## Codex transport freezing

Codex is the only backend that currently uses persisted
`backendSpecific`. The run loop resolves exactly one transport shape at
fresh-run/init time and stores it on both `manifest.backendSpecific` and
`manifest.resetSeed.backendSpecific`.

- Embedded fresh runs resolve:
  frontmatter `backendSpecific.codex.transport` →
  `TASK_RUNNER_CODEX_UDS_PATH` or `TASK_RUNNER_CODEX_WS_URL` →
  `{ type: "stdio" }`
- Connected / daemon-owned fresh runs resolve:
  frontmatter `backendSpecific.codex.transport` →
  daemon request override
  `overrides.backendSpecific.codex.transport` →
  client-provided `TASK_RUNNER_CODEX_UDS_PATH` or
  `TASK_RUNNER_CODEX_WS_URL` →
  daemon process `TASK_RUNNER_CODEX_UDS_PATH` or
  `TASK_RUNNER_CODEX_WS_URL` →
  `{ type: "stdio" }`

The transport union is exactly `{ type: "stdio" }`, `{ type: "ws", url:
"<absolute ws:// or wss:// URL>" }`, or `{ type: "uds", path:
"/absolute/socket/path" }`. UDS is WebSocket-over-UDS for Codex
app-server, not raw socket bytes. If both UDS and WS env vars are set
without a higher-precedence transport, resolution fails fast.

This is an explicit Codex-only contract. There is no generic
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
The resolved launcher is stored on both `manifest.launcher` and
`manifest.resetSeed.launcher`.

- Embedded / local fresh runs resolve named launchers from the caller's
  config root.
- Connected / daemon-owned fresh runs resolve named launchers on the
  daemon host.
- The built-in `direct` launcher is always available and reserved.
- Launchers only affect subprocess-backed execution. Passive runs and
  Codex websocket/UDS transport keep `direct`.

## Public command contract

### Read surfaces

- `task-runner status`
- `task-runner run status <run-id>`
- `task-runner run brief <run-id>`
- `task-runner run audit <run-id>`
- `task-runner task list <run-id>`
- `task-runner task show <run-id> <task-id>`
- `task-runner attachment list <run-id> [--scope run|family]`

Rules:

- Top-level `status` reports system/environment status and takes no run id.
- `run status`, `run brief`, and `run audit` are run-id-only.
- `attachment list` defaults to `family`, which walks the target run's
  parent chain to the lineage root and includes every run that shares
  that root. Use `--scope run` for target-only attachment listing.

### Mutation surfaces

- `task-runner task set|append-notes|add`
- `task-runner attachment add|remove`
- `task-runner run reset|archive|unarchive|delete|set-name|`
  `set-backend-session|clear-backend-session`
- `task-runner run schedule [set]|enable|disable|clear`
- `task-runner run add-dep|remove-dep|clear-deps`

`run set-backend-session` / `run clear-backend-session` are
passive-only metadata mutations. They update `manifest.backendSessionId`
without changing task state, lifecycle status, attempt history, archive state,
or dependency projections.

Dependency mutations are only allowed on `initialized` runs.

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

Passive backend-session editing is an explicit detail-surface mutation,
not a summary mutation: the daemon publishes a fresh `RunDetail` after
set/clear, but does not fan out summary or dependent-run updates because
`backendSessionId` does not participate in `RunSummary`.

`RunSummary` and `RunDetail` both expose derived `activeTask` data so
live consumers do not need to re-scan task arrays to render the current
in-progress task label. Timeline and audit consumers subscribe first,
fetch `/api/runs/:runId/timeline` or `/api/runs/:runId/audit`, then
apply buffered live envelopes where `cursor > history.lastCursor`.

## Workspace layout

Typical workspace:

```text
${TASK_RUNNER_STATE_DIR}/runs/<repo-name>/<run-id>/
├── run.json
├── assignment-seed.md
├── attempts/
│   └── 01.json
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
npm test
npm run check
```

The root `check` pipeline is:

1. `npm run build`
2. `npm run lint`
3. `npm run format:check`
4. `npm run imports:check`
5. `npm run test:node`
6. `npm run test:web`

`npm run lint` runs Biome linting only, with warnings treated as
failures, and `npm run lint:fix` applies Biome lint autofixes. `npm run
format` writes Biome formatting, `npm run format:check` verifies
formatting without writing, `npm run imports:fix` applies Biome import
organization, and `npm run imports:check` verifies import organization
without writing. `npm run check:knip` runs the unused-file/export/
dependency baseline separately from the standard `check` pipeline.

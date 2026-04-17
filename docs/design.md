# task-runner Design

## Purpose

`task-runner` is a manifest-canonical CLI for running agents against a structured
task list. The system is designed around a small number of explicit concepts:

- runs are persisted in `run.json`
- task state is canonical in the manifest
- workers interact through the task CLI
- `brief` is the canonical worker handoff
- caller-facing documentation stays separate from worker-facing instructions

The current manifest generation is schema version `8`. Older manifest shapes are
not silently upgraded or dual-read at runtime.

## Non-Goals

- a remote multi-user control plane
- workspace-file task editing as a first-class workflow
- backward-compatibility shims for removed manifest or CLI contracts
- automatic proof that a worker really performed a task

## End-State Model

### Agent

An agent definition provides backend/runtime configuration and role instructions:

- backend
- model
- effort
- timeout
- unrestricted
- locked fields
- role instructions

### Assignment

An assignment definition provides reusable work:

- cwd
- vars schema
- task list
- optional default message
- optional caller instructions
- assignment instructions

Assignments remain markdown definitions (`assignment.md`) in the config tree or
direct paths supplied by the caller. They are inputs to run creation, not a live
workspace surface.

### Run

A run is a frozen execution record in:

```text
${TASK_RUNNER_STATE_DIR}/runs/<repo-name>/<run-id>/
```

The canonical record is `run.json`. Important persisted fields:

- frozen agent metadata
- frozen assignment metadata
- `repo`
- `cwd`
- `finalTasks`
- `brief`
- `callerInstructions`
- `dependencyRunIds`
- attachment metadata
- attempt history
- session history
- reset seed

If the run started from an assignment file, task-runner also stores:

```text
assignment-seed.md
```

That file is an immutable audit snapshot only.

## Brief And Caller Instructions

task-runner maintains two separate instruction surfaces.

### Worker Brief

`brief` is the worker-facing handoff. It is composed from:

1. agent instructions
2. assignment instructions
3. task-runner's worker workflow template
4. the run message

The workflow template teaches the worker to use:

- `task-runner task list <run-id>`
- `task-runner task show <run-id> <task-id>`
- `task-runner task set <run-id> <task-id> --status ...`
- `task-runner task append-notes <run-id> <task-id> --text ...`
- `task-runner status <run-id>`

The public read surface is:

```bash
task-runner brief <run-id>
```

`brief` is text-only. It is not projected through `status --field ...`.

### Caller Instructions

`callerInstructions` are assignment docs for the human or script using
task-runner. They are:

- interpolated at run creation time
- printed on fresh `run` / `init`
- available in `status --output-format json`
- never sent to the backend

This split keeps operator workflow text out of worker prompts.

## Task State Model

Task state is canonical in `manifest.finalTasks` for all runs.

Statuses:

- `pending`
- `in_progress`
- `completed`
- `blocked`

There is one task workflow. The system no longer branches between multiple task
interaction modes.

Mutation rules:

- initialized runs allow `task set`, `task append-notes`, and `task add`
- running non-passive runs allow `task set` and `task append-notes`, but not
  `task add`
- terminal non-passive runs allow notes edits, not status changes
- passive runs are driven externally through the task CLI

## Lifecycle

### Fresh Run

`task-runner run`:

1. resolves agent and assignment
2. resolves cwd from `--cwd` -> assignment `cwd` -> caller cwd
3. resolves vars
4. enforces locked fields
5. captures `repo` from the resolved cwd and creates the run workspace
6. freezes the initial manifest
7. composes and stores `brief`
8. either invokes the backend or, for passive runs, leaves the run initialized

### Init

`task-runner init` performs the same setup work without invoking the backend.

This is important for:

- passive runs
- delayed execution
- planning flows where the caller wants to inspect the run before executing it

`init` no longer dumps the worker handoff body to stdout. Operators fetch it
explicitly with `task-runner brief <run-id>`.

### Execute-After-Init

For non-passive initialized runs:

```bash
task-runner run --resume-run <run-id>
```

The stored `manifest.brief` is reused as the execution handoff.

### Resume

Resume is manifest-based. Source agent and assignment files are not re-read.

Important rules:

- `--assignment` is forbidden on resume
- `--var` is forbidden on resume
- incomplete-task resumes may omit a follow-up message
- archived runs must be unarchived first
- passive runs are not executed through `run --resume-run`

### Reset

`task-runner run reset <id|path>` restores the initialized-state seed stored in
the manifest for non-running runs. Reset does not re-read current source
definitions.

### Delete Archived Runs

`task-runner run delete <id|path>` permanently removes an archived,
non-running run workspace. Delete is a hot-cut lifecycle mutation: only
archived runs are eligible, and the workspace is removed rather than moved to
trash or soft-deleted.

## Public Command Contract

### Read Surfaces

- `task-runner status <run-id>`
- `task-runner brief <run-id>`
- `task-runner task list <run-id>`
- `task-runner task show <run-id> <task-id>`
- `task-runner attachment list <run-id> [--cwd-scope]`

Important rule:

- `status` and `brief` are run-id-only read surfaces
- `attachment list --cwd-scope` uses the target run's persisted `cwd` as an exact-match scope key; it does not infer groups from the caller cwd, repo bucket, or path prefixes

### Mutation Surfaces

- `task-runner task set`
- `task-runner task append-notes`
- `task-runner task add`
- `task-runner attachment add|remove`
- `task-runner run reset|archive|unarchive|delete|set-name|set-backend-session|clear-backend-session`
- `task-runner run add-dep|remove-dep|clear-deps`

`run set-backend-session` / `run clear-backend-session` are passive-only
metadata mutations. They update `manifest.backendSessionId` without changing
task state, lifecycle status, attempts, archive state, or dependency
projections.

### Daemon Surface

`task-runner serve` hosts:

- WebSocket JSON-RPC for CLI clients
- HTTP and SSE for browser clients
- the bundled web UI

CLI commands can route through the daemon with `--connect` or
`TASK_RUNNER_CONNECT`.

Live subscriptions are split by responsibility instead of sharing one mixed
event bus:

- global summary stream: `/api/events/run-summaries` (`summary_upsert` and `summary_removed`)
- per-run detail stream: `/api/runs/:runId/events/detail`
- per-run timeline history query: `/api/runs/:runId/timeline`
- per-run timeline stream: `/api/runs/:runId/events/timeline`

The WebSocket subscription contract mirrors that split:

Shared run capabilities remain the canonical UX gate for lifecycle actions.
`RunCapabilities` includes `canReset` and `canDelete`, and browser/daemon
clients should use those booleans directly instead of reproducing lifecycle
state checks locally.
Passive backend-session editing is an explicit detail-surface mutation, not a
summary mutation: the daemon publishes a fresh `RunDetail` after set/clear, but
does not fan out summary or dependent-run updates because `backendSessionId`
does not participate in `RunSummary`.

- `events.subscribe { channel: "run_summary" }`
- `events.subscribe { channel: "run_detail", runId }`
- `events.subscribe { channel: "run_timeline", runId }`

Notifications are likewise explicit:

- `run.summary` carries either a `summary_upsert` with a fresh `RunSummary` or a `summary_removed` with a `runId`
- `run.detail` carries a fresh `RunDetail`
- `run.timeline` carries one `RunTimelineEnvelope` (`runId`, `cursor`, `event`)

This keeps board/detail projections manifest-canonical while preserving the
execution timeline as a separate per-run surface. `RunSummary` and `RunDetail`
both expose derived `activeTask` data so live consumers do not need to re-scan
task arrays to render the current in-progress task label. Timeline consumers
subscribe first, fetch `/api/runs/:runId/timeline`, then apply buffered live
envelopes where `cursor > history.lastCursor`.

## Workspace Layout

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

- `assignment-seed.md` exists only when the run started from an assignment file
- attempt logs are append-only audit records
- attachment metadata lives in the manifest; attachment bytes live under
  `attachments/`
- cwd-scoped attachment grouping is derived at read time only; ownership and storage remain per-run, and web `Group` rows stay preview/download-only

## Prompt And Retry Behavior

On first execution, the backend receives the composed `brief`.

If tasks remain incomplete, task-runner composes a retry nudge that:

- points the worker back at the task CLI
- identifies incomplete tasks
- preserves the run id as the operating handle

Added tasks on resume also trigger a reminder that new work was appended and
should be reviewed through the task CLI.

## Repo Layout

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

Bundled assignments live under `assignments/`.

## Development Checks

Standard verification:

```bash
npm run build
npm run lint
npm test
npm run check
```

The root `check` pipeline is:

1. `npm run build`
2. `npm run lint`
3. `npm run test:node`
4. `npm run test:web`

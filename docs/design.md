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

The current manifest schema is version `10`. Older manifest shapes are not
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
- assignment instructions (markdown body)
- `maxRetries`, `lockedFields`

Assignments are markdown definitions in the config tree or direct paths
supplied by the caller. They are inputs to run creation, not a live
workspace surface.

### Run

A run is a frozen execution record in:

```text
${TASK_RUNNER_STATE_DIR}/runs/<repo-name>/<run-id>/
```

The canonical record is `run.json`. Important persisted fields:

- frozen agent metadata
- frozen assignment metadata (or `null` for chat-style runs)
- `repo`, `cwd`
- `backend`, `model`, `effort`, `backendSpecific`, `timeoutSec`,
  `unrestricted`, `maxAttempts`, `launcher`
- `lockedFields` (union of agent and assignment locks)
- `status`, `exitCode`
- `startedAt`, `endedAt`, `archivedAt`
- `finalTasks` (canonical task state)
- `tasksCompleted`, `tasksTotal`
- `brief` (composed worker handoff)
- `callerInstructions`
- `backendSessionId` (backend-native resume handle; Pi, Codex, Claude,
  etc. each store their own flavor here)
- `dependencyRunIds`
- `resolvedHooks` (the frozen hook descriptors selected at first write)
- `hookState` (hook-owned state bag)
- `hookAudits` (per-hook execution audit records)
- attachment metadata
- attempt and session history
- `runtimeVars` (env-sourced values redacted)
- `resetSeed` (snapshot used by `run reset`)
- `execution` (host mode and controller)

If the run started from an assignment file, task-runner also stores
`assignment-seed.md` as an immutable audit snapshot. Runs created by
current code also include `run-events.jsonl`; pre-feature workspaces may
still lack it. The file is append-only diagnostic history for major
lifecycle/task mutations, survives `run reset`, and is never used to
reconstruct canonical state.

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
```

`run brief` is text-only. It is not projected through `run status --field ...`.

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
  command surfaces. Rejections roll back the requested task edit while
  preserving the hook's own accepted side effects such as notes, pins,
  attachments, or task patches.

The built-in `command` hook supports:

- `mode: status` — zero exit is success, non-zero blocks/rejects
- `mode: json` — zero exit plus JSON stdout returning the full hook
  result payload; malformed JSON is a runtime error

The built-in `git-worktree` hook is prepare-only. It creates or reuses a
worktree, switches the run cwd to that path, and projects
`worktree_path` into runtime vars.

The built-in `git-sync-base` hook is also prepare-only. It requires a
clean current branch/worktree and rebases that branch onto an explicit
configured base ref before backend work begins.

Declarative `when` support remains narrow: attempt-phase hooks support
`when.sessionIndex`, while task-transition hooks support `when.toStatus`.

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
2. resolves cwd: `--cwd` → assignment `cwd` → caller cwd
3. resolves vars
4. enforces locked fields
5. captures `repo` from the resolved cwd and creates the run workspace
6. resolves backend-specific runtime config (for Codex transport:
   frontmatter → daemon request override → env → stdio default)
7. resolves launcher precedence (`--launcher` override → agent launcher →
   `direct`, with passive and Codex websocket forced to `direct`)
8. freezes the initial manifest
9. composes and stores `brief`
10. invokes the backend, or leaves the run initialized if the backend is
   `passive`

### Init

`task-runner init` performs the same setup work without invoking the
backend. This is important for:

- passive runs
- delayed execution
- planning flows where the caller wants to inspect the run before
  executing it

`init` no longer dumps the worker handoff body to stdout. Operators
fetch it explicitly with `task-runner run brief <run-id>`.

### Execute-after-init

For non-passive initialized runs:

```bash
task-runner run --resume-run <run-id>
```

The stored `manifest.brief` is reused verbatim as the execution handoff.

### Resume

Resume is manifest-based. Source agent and assignment files are not
re-read.

Important rules:

- `--agent`, `--assignment`, `--backend`, `--backend-session-id`,
  `--cwd`, `--name`, and `--var` are forbidden on resume
- resume reuses the frozen `manifest.backendSpecific` runtime config; it
  does not re-resolve Codex transport from current env or new daemon
  request overrides
- resume reuses the frozen `manifest.launcher`; `--launcher` is
  forbidden on resume and execute-after-init
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
runtime config captured in the reset seed.

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
  `TASK_RUNNER_CODEX_WS_URL` →
  `{ type: "stdio" }`
- Connected / daemon-owned fresh runs resolve:
  frontmatter `backendSpecific.codex.transport` →
  daemon request override
  `overrides.backendSpecific.codex.transport` →
  daemon process `TASK_RUNNER_CODEX_WS_URL` →
  `{ type: "stdio" }`

This is an explicit Codex-only contract. There is no generic
backend-specific env passthrough layer for other backends.

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
  Codex websocket transport keep `direct`.

## Public command contract

### Read surfaces

- `task-runner status`
- `task-runner run status <run-id>`
- `task-runner run brief <run-id>`
- `task-runner task list <run-id>`
- `task-runner task show <run-id> <task-id>`
- `task-runner attachment list <run-id> [--cwd-scope]`

Rules:

- Top-level `status` reports system/environment status and takes no run id.
- `run status` and `run brief` are run-id-only.
- `attachment list --cwd-scope` uses the target run's persisted `cwd` as
  an exact-match scope key. It does not infer groups from caller cwd,
  repo buckets, or path prefixes.

### Mutation surfaces

- `task-runner task set|append-notes|add`
- `task-runner attachment add|remove`
- `task-runner run reset|archive|unarchive|delete|set-name|`
  `set-backend-session|clear-backend-session`
- `task-runner run add-dep|remove-dep|clear-deps`

`run set-backend-session` / `run clear-backend-session` are
passive-only metadata mutations. They update `manifest.backendSessionId`
without changing task state, lifecycle status, attempts, archive state,
or dependency projections.

Dependency mutations are only allowed on `initialized` runs.

### Daemon surface

`task-runner serve` hosts:

- WebSocket JSON-RPC for CLI clients
- HTTP and SSE for browser clients
- the bundled web UI

CLI commands can route through the daemon with `--connect` or
`TASK_RUNNER_CONNECT`.

Live subscriptions are split by responsibility instead of sharing one
mixed event bus:

- global summary stream: `GET /api/events/run-summaries` (`summary_upsert`
  and `summary_removed`)
- per-run detail stream: `GET /api/runs/:runId/events/detail`
- per-run timeline history query: `GET /api/runs/:runId/timeline`
- per-run timeline stream: `GET /api/runs/:runId/events/timeline`

The WebSocket subscription contract mirrors that split:

- `events.subscribe { channel: "run_summary" }`
- `events.subscribe { channel: "run_detail", runId }`
- `events.subscribe { channel: "run_timeline", runId }`

Notifications:

- `run.summary` carries a `summary_upsert` with a fresh `RunSummary` or a
  `summary_removed` with a `runId`
- `run.detail` carries a fresh `RunDetail`
- `run.timeline` carries one `RunTimelineEnvelope { runId, cursor, event }`

Hooks do not add a fourth daemon event channel. Their externally visible
state is carried inside the existing `RunSummary` and `RunDetail`
projections (`hookCount` on summaries; `resolvedHooks`, `hookState`, and
`hookAudits` on detail), and hook-driven task/note/attachment changes
reuse the existing summary/detail/timeline publication flow.

Shared run capabilities remain the canonical UX gate for lifecycle
actions. `RunCapabilities` includes `canArchive`, `canUnarchive`,
`canReset`, `canDelete`, `canResume`, `canAbort`, and the `taskMutation`
sub-booleans. Browser and daemon clients should use those booleans
directly instead of reproducing lifecycle state checks locally.

Passive backend-session editing is an explicit detail-surface mutation,
not a summary mutation: the daemon publishes a fresh `RunDetail` after
set/clear, but does not fan out summary or dependent-run updates because
`backendSessionId` does not participate in `RunSummary`.

`RunSummary` and `RunDetail` both expose derived `activeTask` data so
live consumers do not need to re-scan task arrays to render the current
in-progress task label. Timeline consumers subscribe first, fetch
`/api/runs/:runId/timeline`, then apply buffered live envelopes where
`cursor > history.lastCursor`.

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
- cwd-scoped attachment grouping is derived at read time only; ownership
  and storage remain per-run, and web `Group` rows stay preview /
  download-only.

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
npm test
npm run check
```

The root `check` pipeline is:

1. `npm run build`
2. `npm run lint`
3. `npm run test:node`
4. `npm run test:web`

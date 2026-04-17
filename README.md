# task-runner

`task-runner` drives an agent through a structured task list and keeps the
run state in a manifest-canonical workspace. It supports embedded CLI
execution, a local daemon, a browser dashboard, resumable runs, attachments,
dependencies, and a first-class `brief` surface for handing a run to a worker.

The current model is a hot cut:

- task state is canonical in `run.json`
- workers use the task CLI, not workspace files
- `task-runner brief <run-id>` is the canonical worker handoff
- `status` and `brief` are run-id-only read surfaces
- fresh runs created from an assignment capture `assignment-seed.md` for audit,
  but do not generate a live workspace `assignment.md`

## Install

Requirements:

- Node.js 20+
- a supported backend when you want live execution:
  - `claude`
  - `codex` or a Codex app-server
  - `cursor-agent`

Build from the repo root:

```bash
npm install
npm run build
```

The built CLI entrypoint is `node apps/cli/dist/cli.js`. You can also use:

```bash
npm run task-runner -- <args>
```

## Core Model

- **Agent**: backend, model, timeout, and role instructions.
- **Assignment**: reusable task list, vars schema, optional authored `cwd`,
  optional caller-facing docs, and assignment instructions.
- **Run**: one persisted execution instance under
  `${TASK_RUNNER_STATE_DIR}/runs/<repo>/<run-id>/`.
- **Brief**: the composed worker-facing handoff for a run. Re-fetch it with
  `task-runner brief <run-id>`.
- **Caller instructions**: assignment docs for the human or script invoking
  task-runner. These are never sent to the backend.

Assignments are source definitions. They can be named definitions under
`${TASK_RUNNER_CONFIG_DIR}/assignments/<name>/assignment.md` or direct paths.
If a run starts from an assignment file, task-runner stores an immutable
`assignment-seed.md` snapshot in the run workspace for audit/debug only.

## Quickstart

Fresh run:

```bash
task-runner run \
  --agent ./agents/implementer/agent.md \
  --assignment ./assignments/repo-orientation/assignment.md
```

Inspect a run:

```bash
task-runner status <run-id>
task-runner brief <run-id>
task-runner task list <run-id>
task-runner task show <run-id> <task-id>
```

Prepare a run without executing it:

```bash
task-runner init \
  --agent ./agents/implementer/agent.md \
  --assignment ./assignments/repo-orientation/assignment.md

task-runner run --resume-run <run-id>
```

Passive / externally driven run:

```bash
task-runner init \
  --backend passive \
  --assignment plan-feature \
  --name "Web dashboard" \
  "Design the dashboard work"

task-runner brief <run-id>
task-runner task set <run-id> <task-id> --status in_progress
task-runner task append-notes <run-id> <task-id> --text "Observed ..."
task-runner run set-backend-session <run-id> <session-id>
task-runner run clear-backend-session <run-id>
task-runner task set <run-id> <task-id> --status completed
```

Passive runs can also mutate the persisted `backendSessionId` metadata through
`run set-backend-session` / `run clear-backend-session`. The web detail drawer
surfaces the same edit/clear flow inline for passive runs, including archived
passive runs.

## Command Surface

Top-level commands:

- `task-runner run`
- `task-runner init`
- `task-runner serve`
- `task-runner status <run-id>`
- `task-runner brief <run-id>`
- `task-runner task list|show|set|append-notes|add`
- `task-runner attachment add|list|download|remove`
- `task-runner list agents|assignments|runs [--cwd <path> | --repo <name> | --global] [--include-archived]`
- `task-runner show agent|assignment <name|path>`
- `task-runner run reset|archive|unarchive|delete|set-name|set-backend-session|clear-backend-session|add-dep|remove-dep|clear-deps`

Important read-surface rule:

- `status` and `brief` accept a run id, not a workspace path.
- `brief` is text-only. It does not support `--output-format` or `--field`.
- `status --output-format json` returns the shared `RunDetail` DTO.
- `list runs` defaults to the caller's cwd. Use `--cwd <path>` for a different exact cwd, `--repo <name>` for an exact repo bucket, or `--global` to restore the previous global listing behavior.

## Workflow

### Fresh Runs

`task-runner run` resolves the agent and assignment, freezes a manifest, composes
the worker brief, and invokes the backend immediately unless the backend is
`passive`.

Fresh-run cwd precedence is:

1. `--cwd` override
2. authored assignment `cwd`
3. caller cwd

Prompt composition is:

1. agent instructions
2. assignment instructions
3. task-runner's worker workflow text
4. caller message

### Init And Execute-After-Init

`task-runner init` creates the run workspace and persists the composed brief
without invoking a backend.

For non-passive runs, later execution is:

```bash
task-runner run --resume-run <run-id>
```

For passive runs, the caller or an outer agent drives the run through the task
commands. `init` no longer prints the full worker handoff automatically; use
`task-runner brief <run-id>`.

### Resume

Resume reuses the frozen manifest state. The source agent/assignment files are
not re-read.

- `--assignment` and `--var` are forbidden on resume.
- resume with incomplete tasks can omit a follow-up message
- non-passive archived runs must be unarchived before resume
- passive runs remain externally driven; `run --resume-run` is rejected for them

### Task Mutation

The task CLI mutates canonical task state in `run.json.finalTasks`.

- `task set` and `task append-notes` are allowed on initialized runs
- while a non-passive run is in flight, `task set` and `task append-notes`
  remain allowed
- `task add` is rejected while a non-passive run is in flight
- terminal non-passive runs allow notes-only edits, not status changes
- passive runs can be driven entirely through the task CLI

## Workspace And State

Default roots:

- `TASK_RUNNER_CONFIG_DIR`: `${XDG_CONFIG_HOME}/task-runner` or
  `~/.config/task-runner`
- `TASK_RUNNER_STATE_DIR`: `${XDG_STATE_HOME}/task-runner` or
  `~/.local/state/task-runner`

Typical run workspace:

```text
${TASK_RUNNER_STATE_DIR}/runs/<repo-name>/<run-id>/
├── run.json
├── assignment-seed.md        # only when the run started from an assignment file
├── attempts/
│   └── 01.json
└── attachments/
```

`run.json` is the canonical record. It stores:

- the frozen agent and assignment metadata
- frozen `repo` and `cwd`
- canonical task snapshots
- `brief`
- caller instructions
- dependency and attachment metadata
- attempt and session history

## Daemon And Web

`task-runner serve` starts the local control plane:

- WebSocket JSON-RPC for CLI clients via `--connect` / `TASK_RUNNER_CONNECT`
- HTTP request/response plus SSE for browser clients
- the bundled web dashboard from `apps/web`

Embedded mode still works without the daemon. Daemon mode is local infrastructure,
not a multi-user remote service.

Live browser/daemon surfaces are split by projection type:

- `GET /api/events/run-summaries` streams `summary_upsert` events carrying full
  `RunSummary` snapshots for board cards and `summary_removed` events carrying
  deleted `runId` values
- `GET /api/runs/:runId/events/detail` streams `detail_updated` events carrying
  full `RunDetail` snapshots for the selected run
- `GET /api/runs/:runId/timeline` returns normalized per-attempt
  `RunTimelineHistory` plus the last applied timeline cursor for bootstrap
- `GET /api/runs/:runId/events/timeline` streams per-run execution timeline
  envelopes (`RunTimelineEnvelope`) with monotonically increasing `cursor`
  values and SSE `id:` framing for live continuation after the history fetch

The shared app config surface is:

- `apiBasePath`
- `runSummaryEventsPath`

Per-run detail and timeline paths are derived from `apiBasePath` and the active
run id. The global summary stream is projection-only and does not carry
transcript deltas.

Shared lifecycle actions are gated from backend-derived run capabilities:
`RunCapabilities` now includes `canReset` and `canDelete`, and browser clients
should use those booleans directly rather than re-implementing lifecycle checks.
Passive run detail views can also edit or clear `backendSessionId` inline; the
dashboard routes those mutations through the same dedicated daemon HTTP/RPC
surfaces as the CLI grouped commands.

## Built-In Assignments

The repo ships these bundled assignments:

- `repo-orientation`
- `test`
- `plan-feature`
- `plan-review`
- `code-review`
- `doc-review`
- `familiarize`

## Built-In Agents

The repo ships these bundled agents:

- `planner`
- `implementer`
- `code-reviewer`
- `doc-reviewer`
- `test`

Planning/review flows are run-id-centric. Current-run transport instructions
should use `task-runner brief <run-id>` and task CLI commands, not scraped
status fields or workspace file paths.

## Output And Exit Codes

Common exit codes:

- `0`: success
- `1`: retries exhausted with incomplete tasks
- `2`: blocked
- `3`: validation, config, or daemon connectivity error
- `4`: runtime or backend failure
- `130`: confirmed interrupt / cancellation

Useful output modes:

- default text output for operator-facing status
- `--output-format json` on supported commands
- `--field ...` on `status` to project top-level JSON fields

## Environment Variables

Common environment variables:

- `TASK_RUNNER_CONFIG_DIR`
- `TASK_RUNNER_STATE_DIR`
- `TASK_RUNNER_CONNECT`
- `TASK_RUNNER_LISTEN`
- `TASK_RUNNER_CMD`
- `TASK_RUNNER_CLAUDE_BIN`
- `TASK_RUNNER_CURSOR_BIN`
- `TASK_RUNNER_CODEX_WS_URL`
- `TASK_RUNNER_MAX_CALL_DEPTH`

## Development

Repo checks:

```bash
npm install
npm run build
npm run lint
npm run test:node
npm run test:web
npm run check
```

Primary entry points:

- `apps/cli/src/cli.ts`
- `apps/cli/src/daemon/`
- `packages/core/src/core/run/run-loop.ts`
- `packages/core/src/core/run/manifest.ts`
- `packages/core/src/core/commands/service.ts`

For design details, see [docs/design.md](docs/design.md).

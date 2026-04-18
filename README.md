# task-runner

`task-runner` drives an agent through a structured task list and keeps
run state in a manifest-canonical workspace. It supports embedded CLI
execution, a local daemon, a browser dashboard, resumable runs,
attachments, dependencies, and a first-class `brief` surface for handing
a run to a worker.

- Task state is canonical in `run.json`.
- Workers use the task CLI, not workspace files.
- `task-runner brief <run-id>` is the canonical worker handoff.
- `status` and `brief` are run-id-only read surfaces.
- Fresh runs created from an assignment capture `assignment-seed.md` for
  audit, but do not generate a live workspace `assignment.md`.

## Install

Requirements:

- Node.js 20+
- a supported backend when you want live execution:
  - `claude`
  - `codex` (or a Codex app-server)
  - `cursor-agent`
  - `pi`

Build from the repo root:

```bash
npm install
npm run build
```

The built CLI entrypoint is `node apps/cli/dist/cli.js`. The workspace
also exposes:

```bash
npm run task-runner -- <args>
```

## Quickstart

### Fresh run

```bash
task-runner run \
  --agent ./agents/implementer/agent.md \
  --assignment ./assignments/repo-orientation/assignment.md
```

### Inspect a run

```bash
task-runner status <run-id>
task-runner brief <run-id>
task-runner task list <run-id>
task-runner task show <run-id> <task-id>
```

### Prepare a run without executing it

```bash
task-runner init \
  --agent ./agents/implementer/agent.md \
  --assignment ./assignments/repo-orientation/assignment.md

task-runner run --resume-run <run-id>
```

### Passive / externally driven run

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
task-runner task set <run-id> <task-id> --status completed
```

### Browser dashboard

```bash
task-runner serve
# Open the printed HTTP base URL in a browser.
```

## Command index

| Command | Purpose |
|---------|---------|
| `run` | Execute a fresh run, resume, or execute-after-init |
| `init` | Prepare a run workspace without invoking the backend |
| `serve` | Start the local daemon (WS JSON-RPC + HTTP/SSE + web UI) |
| `status <run-id>` | Print run state (text or JSON) |
| `brief <run-id>` | Print the composed worker handoff |
| `task list\|show\|set\|append-notes\|add` | Task inspection and mutation |
| `attachment add\|list\|download\|remove` | Attachment management |
| `list agents\|assignments\|runs` | Enumerate definitions and runs |
| `show agent\|assignment` | Render a single definition |
| `run reset\|archive\|unarchive\|delete` | Lifecycle mutations |
| `run set-name` | Set/clear persisted display name |
| `run set-backend-session\|clear-backend-session` | Passive-only session metadata |
| `run add-dep\|remove-dep\|clear-deps` | Dependency graph mutations |

See [docs/cli.md](docs/cli.md) for the full flag-by-flag reference.

Key rules:

- `status` and `brief` accept a run id, not a workspace path.
- `brief` is text-only (no `--output-format`, no `--field`).
- `status --output-format json` returns the shared `RunDetail` DTO.
- `list runs` defaults to the caller's cwd; use `--cwd`, `--repo`, or
  `--global` to scope otherwise; `--include-archived` adds archived
  runs.
- `attachment list --cwd-scope` anchors at the target run but includes
  peer runs with the exact same persisted `cwd`.

## Documentation

Core concepts:

- [docs/concepts.md](docs/concepts.md) — tour of the model
- [docs/agents-and-assignments.md](docs/agents-and-assignments.md) — definition format
- [docs/tasks.md](docs/tasks.md) — task model and CLI
- [docs/runs.md](docs/runs.md) — run lifecycle, workspace, manifest
- [docs/variables.md](docs/variables.md) — typed vars and interpolation

Runtime and operations:

- [docs/resume.md](docs/resume.md) — resume, execute-after-init, nudges
- [docs/dependencies.md](docs/dependencies.md) — dependency graph and gate
- [docs/attachments.md](docs/attachments.md) — file handoff between runs
- [docs/backends.md](docs/backends.md) — claude, codex, cursor, pi, passive
- [docs/configuration.md](docs/configuration.md) — env vars, XDG, state roots

Interfaces:

- [docs/cli.md](docs/cli.md) — full CLI reference
- [docs/daemon.md](docs/daemon.md) — control plane, HTTP/SSE, JSON-RPC
- [docs/web-dashboard.md](docs/web-dashboard.md) — bundled dashboard

Design and examples:

- [docs/design.md](docs/design.md) — canonical design, schema, lifecycle
- [docs/examples.md](docs/examples.md) — bundled agents and assignments

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success (all tasks completed, or initialized run) |
| `1` | Retries exhausted with incomplete tasks |
| `2` | One or more tasks reported blocked |
| `3` | Validation, config, or daemon connectivity error |
| `4` | Backend or runtime failure |
| `130` | User cancellation / confirmed interrupt |

## Environment variables

| Variable | Effect |
|----------|--------|
| `TASK_RUNNER_CONFIG_DIR` | Agent/assignment definitions root |
| `TASK_RUNNER_STATE_DIR` | Run workspaces root |
| `TASK_RUNNER_CONNECT` | Route client commands through a daemon |
| `TASK_RUNNER_LISTEN` | Daemon listen URL |
| `TASK_RUNNER_CLAUDE_BIN` | Claude CLI binary |
| `TASK_RUNNER_CODEX_BIN` | Codex stdio binary |
| `TASK_RUNNER_CODEX_WS_URL` | WebSocket URL for a running Codex app-server |
| `TASK_RUNNER_CURSOR_BIN` | Cursor CLI binary |
| `TASK_RUNNER_PI_BIN` | Pi CLI binary |
| `PI_HOME` | Pi session storage root (default `~/.pi`) |
| `TASK_RUNNER_MAX_CALL_DEPTH` | Recursion cap (default `1`) |

See [docs/configuration.md](docs/configuration.md) for XDG resolution
and full details.

## Bundled definitions

Agents (under `agents/`):

- `planner`, `implementer`, `code-reviewer`, `doc-reviewer`, `test`

Assignments (under `assignments/`):

- `repo-orientation`, `test`, `plan-feature`, `plan-review`,
  `code-review`, `doc-review`, `familiarize`

Walkthrough in [docs/examples.md](docs/examples.md).

## Development

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

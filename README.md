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

## Why

If you've used a coding agent for any non-trivial task, you've seen
this loop:

1. You give the agent a list of things to do.
2. The agent confidently announces "all done!"
3. You check, and two of the five things weren't actually done.
4. You write another prompt: "you didn't finish X and Y, try again."
5. Repeat.

`task-runner` wraps that loop. The task list is structured (each task
has a stable id, a title, and a status the agent updates in place),
the runner inspects state after every turn, and a partial completion
becomes another iteration with a programmatic nudge instead of a
hand-typed follow-up. When the agent gets it right, the run ends and
the runner emits a structured record with the per-task final
statuses and the agent's notes.

It is also a useful primitive for orchestration — an outer agent can
compose an assignment, hand it to `task-runner`, and get back a
structured success/failure without parsing free-form chat output.

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

Start with [docs/concepts.md](docs/concepts.md) for the mental model.
The rest are focused topic pages:

| Doc | Topic |
|---|---|
| [docs/concepts.md](docs/concepts.md) | Mental model — agents, assignments, runs, briefs |
| [docs/agents-and-assignments.md](docs/agents-and-assignments.md) | Definition format, locked fields, prompt composition |
| [docs/tasks.md](docs/tasks.md) | Task model, status values, task CLI, mutation rules |
| [docs/runs.md](docs/runs.md) | Workspace layout, manifest, lifecycle, capabilities |
| [docs/variables.md](docs/variables.md) | Typed vars, resolution, interpolation, redaction |
| [docs/resume.md](docs/resume.md) | Resume rules, execute-after-init, retry nudges |
| [docs/dependencies.md](docs/dependencies.md) | Dependency graph and execution gate |
| [docs/attachments.md](docs/attachments.md) | File handoff, cwd-scope grouping, limits |
| [docs/backends.md](docs/backends.md) | Claude, Codex, Cursor, Pi, Passive |
| [docs/configuration.md](docs/configuration.md) | Env vars, XDG roots, manifest upgrades |
| [docs/cli.md](docs/cli.md) | Full CLI reference — every command and flag |
| [docs/daemon.md](docs/daemon.md) | Control plane, HTTP/SSE, JSON-RPC |
| [docs/web-dashboard.md](docs/web-dashboard.md) | Bundled browser UI |
| [docs/design.md](docs/design.md) | Canonical design, schema, lifecycle rules |
| [docs/examples.md](docs/examples.md) | Bundled agents and assignments |

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

## Roadmap

Directions task-runner is likely to grow in next. Nothing below is
implemented yet — the list is here so you can see where things are
heading and flag anything that conflicts with how you're using
task-runner today.

- **More backends** — Gemini and an in-process SDK client (or similar)
  so callers can embed a backend directly instead of always shelling
  out to a CLI or RPC server.
- **Pluggable storage backend** — today the run manifest and workspace
  live on the filesystem. A sqlite or postgres backend would make
  larger run populations, richer queries, and multi-host scenarios
  tractable.
- **Definitions and run creation from the web dashboard** — browse and
  manage agents and assignment templates in the UI, and kick off new
  runs from there instead of dropping to the CLI.
- **Richer attachment previews in the web dashboard** — text and
  Mermaid previews render inline today; image and PDF previews would
  close the loop.
- **Dependency auto-invocation** — today declaring a dependency only
  gates resume. A future step is to automatically start a dependent
  run when all its prerequisites reach `status=success`. See
  [docs/dependencies.md](docs/dependencies.md).
- **Run lifecycle hooks with re-invocation** — a pluggable pre-run /
  post-run hook surface. This generalizes the one built-in validation
  task-runner ships with today (did the agent mark every task
  completed?): hooks could run arbitrary checks — tests, linters,
  custom scripts — and re-invoke the agent when they fail, even if
  the task checklist claims the work is done.
- **Improved run provenance tracking** — today manifests record which
  host/controller executed the latest session (`execution.hostMode`,
  `execution.controller.daemonInstanceId`). A richer audit trail —
  who/what originally launched the run, which parent spawned which
  nested child, which caller issued which mid-run mutation — would
  make cross-run forensics and orchestration replay tractable.
- **Parent/child run linking for UI filtering** — when one run spawns
  another through the recursion path, capture the parent-child edge
  explicitly and let the web dashboard filter, group, and collapse
  by ancestry so an orchestrator run and its generated implementer /
  reviewer runs can be viewed as a single tree.
- **External webhook support** — emit run lifecycle events
  (`run_started`, `run_finished`, `attempt_started`, per-task updates,
  etc.) to configured external HTTP endpoints so task-runner can
  notify CI systems, chat-ops bots, or dashboards without each
  consumer having to subscribe over SSE directly.
- **Agent and assignment inheritance** — let an agent or assignment
  declare an `extends:` parent and inherit frontmatter defaults,
  locked fields, role instructions, and (for assignments) task lists.
  Child definitions could override individual fields, append tasks,
  or redact inherited locks, avoiding today's copy-paste when you
  want a family of related agents/assignments that share a base.

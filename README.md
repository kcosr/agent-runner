# task-runner

`task-runner` drives agents through structured task lists and keeps run
state in a manifest-canonical workspace. It supports embedded CLI
execution, active backend invocation, passive sidecar operation, a local
daemon, a browser dashboard, resumable runs, attachments, dependencies,
and a first-class `run brief` surface for handing a run to a worker.

- Task state is canonical in `run.json`.
- `run-events.jsonl` is a per-run diagnostic audit trail for runs created by current code; it is append-only history, not canonical state.
- Workers use the task CLI, not workspace files.
- `task-runner run brief <run-id>` is the canonical worker handoff.
- `task-runner status` reports the current system/environment context.
- Run-targeted read surfaces live under `task-runner run`.

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

When you need to debug how a run got from one lifecycle/task state to
another, runs created by current code include `run-events.jsonl`: a
compact append-only audit trail for major lifecycle and task-mutation
events. Pre-feature workspaces may still lack the file. It is
diagnostic only; `run.json` remains the source of truth and there is no
separate CLI or API read surface for the file in this first pass.

It is also a useful primitive for orchestration — an outer agent can
compose an assignment, hand it to `task-runner`, and get back a
structured success/failure without parsing free-form chat output.

You can use `task-runner` in two main modes:

- **Passive / sidecar mode** — initialize or inspect runs, then drive the
  work from your existing interactive coding tool while updating task
  state through the task CLI. This is useful when you want task
  tracking, briefs, attachments, and durable run state without handing
  execution over to task-runner.
- **Active backend mode** — execute the run through a supported backend
  (`claude`, `codex`, `cursor-agent`, `pi`). In this mode task-runner
  performs the run/retry loop itself and validates whether tasks were
  actually marked complete before the run is treated as done.

Today the built-in validation is task-state based: did the worker
actually complete the checklist it was given? Assignments can also
declare deterministic hooks that run at prepare time, around attempts,
or during task transitions to block, re-invoke, mutate run metadata, or
stage attachments before the run continues.

## What task-runner is not

`task-runner` is not a polished chat-first UI for interacting with
agents. It streams backend output and you can follow up on runs that are
not currently active, but the product center is durable run state and
structured execution — not chat bubbles, rich tool-call rendering, or a
full conversational workspace.

In practice that means it is best used as either:

- a sidecar for your existing interactive coding agents, or
- a runner for prepared/background tasks that need a durable checklist
  and audit trail.

## Install

Requirements:

- Node.js 20+
- a supported backend when you want live execution:
  - `claude`
  - `codex` (or a Codex app-server)
  - `cursor-agent`
  - `pi`

### Option 1: local build / linked development install

Build from the repo root:

```bash
npm install
npm run build
npm link
```

The built CLI entrypoint is `node apps/cli/dist/cli.js`. The workspace
also exposes:

```bash
npm run task-runner -- <args>
```

### Option 2: package-style invocation

Once task-runner is published as a package, the intended no-install path
is:

```bash
npx task-runner <args>
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
task-runner status
task-runner run status <run-id>
task-runner run brief <run-id>
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

task-runner run brief <run-id>
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

`task-runner serve` starts the local daemon. The web UI talks to that
same daemon and is not a standalone app.

### Hooked assignment

```yaml
---
schemaVersion: 1
name: repo-work
vars:
  worktree_path:
    type: string
    required: true
    requiredAt: prepare
hooks:
  prepare:
    - builtin: git-worktree
      with:
        repo: "{{cwd}}"
        from: main
        branch: review-worktree
        path: "{{cwd}}/.worktrees/review-worktree"
    - builtin: git-sync-base
      with:
        repo: "{{cwd}}/.worktrees/review-worktree"
        baseRef: origin/main
  beforeAttempt:
    - builtin: command
      when:
        sessionIndex: [0]
      with:
        mode: status
        command: npm
        args: ["test", "--", "smoke"]
---
Work on the repo.
```

Named hooks resolve from `${TASK_RUNNER_CONFIG_DIR}/hooks/<hook-name>/hook.(ts|mts|js|mjs)`.
Assignment-local path hooks resolve relative to the authored
`assignment.md`. Raw `.ts` / `.mts` hooks load directly through the core
runtime's `jiti` loader, so hook authors do not need to precompile them.

CLI commands can either:

- run **embedded** against the shared filesystem state, or
- route through the daemon with `--connect <ws-url>` (or
  `TASK_RUNNER_CONNECT`).

Connected CLI commands can also tunnel through SSH with
`--connect-host <host>` / `TASK_RUNNER_CONNECT_HOST`. The CLI then keeps
the logical `--connect` URL for user-facing output while forwarding the
actual daemon traffic through an invocation-scoped loopback port
(`--connect-local-port` / `TASK_RUNNER_CONNECT_LOCAL_PORT` overrides the
default port reuse). Anything more advanced than that belongs in your
SSH config, not in `task-runner`.

Both modes operate on the same persisted runs. The important difference
is that connected mode lets the daemon observe and broadcast changes in
real time, which is how the browser UI stays live as commands mutate
runs. If you want the web dashboard to reflect CLI changes immediately,
issue those CLI commands through `--connect`.

For Codex runs, embedded and connected mode both resolve an explicit
transport intent. Connected mode does not forward arbitrary env vars, but
it does synthesize a Codex-only websocket override from the caller's
local `TASK_RUNNER_CODEX_WS_URL` when that env var is set.

## Command index

| Command | Purpose |
|---------|---------|
| `run` | Execute a fresh run, resume, or execute-after-init |
| `init` | Prepare a run workspace without invoking the backend |
| `serve` | Start the local daemon (WS JSON-RPC + HTTP/SSE + web UI) |
| `status` | Print system/environment status |
| `run status\|brief` | Print run state or the composed worker handoff |
| `task list\|show\|set\|append-notes\|add` | Task inspection and mutation |
| `attachment add\|list\|download\|remove` | Attachment management |
| `list agents\|assignments\|runs` | Enumerate definitions and runs |
| `show agent\|assignment` | Render a single definition |
| `run reset\|archive\|unarchive\|delete` | Lifecycle mutations |
| `run set-name` | Set/clear persisted display name |
| `run set-note\|clear-note` | Set/clear persisted human note metadata |
| `run pin\|unpin` | Set/clear persisted pin metadata |
| `run set-backend-session\|clear-backend-session` | Passive-only session metadata |
| `run add-dep\|remove-dep\|clear-deps` | Dependency graph mutations |

See [docs/cli.md](docs/cli.md) for the full flag-by-flag reference.

Key rules:

- `task-runner status` takes no run id and reports config/state/daemon info.
- `task-runner run status` and `task-runner run brief` accept a run id, not a workspace path.
- `run brief` is text-only (no `--output-format`, no `--field`).
- `run status --output-format json` returns the shared `RunDetail` DTO, including full `note` text plus `pinned`.
- Text `run status` surfaces note/pin metadata compactly (`Pinned: yes`, `Note: present`) and never prints the note body.
- Run notes are human metadata only: they persist on the run but are not auto-injected into worker briefs or backend prompts.
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
| `TASK_RUNNER_CODEX_WS_URL` | Default websocket transport for fresh Codex runs when no explicit `backendSpecific.codex.transport` was authored |
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

- **More backends** — Gemini, ACP-style integrations, and an in-process
  SDK client (or similar) so callers can embed a backend directly
  instead of always shelling out to a CLI or RPC server.
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

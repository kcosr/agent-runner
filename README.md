# task-runner

`task-runner` runs a coding agent against a structured task list and
keeps the run durable. You hand it an agent definition, an assignment
(the work, including the task list), and a backend (`claude`, `codex`,
`cursor`, `opencode`, or `pi`) — task-runner spawns the backend,
sends the worker brief, observes task state after every turn, retries
with a programmatic nudge on partial completion, and exits with a
structured success/failure record.

Use it when you want a coding agent to grind through a checklist on
its own and stop when the checklist is actually done — rather than
when the agent thinks it is. Schedule it, resume it, depend one run
on another, hand off artifacts as attachments, audit it after the
fact. For workflows you'd rather drive yourself, the same
state/brief/audit surface is available as a passive sidecar.

> **New here?** Read [docs/concepts.md](docs/concepts.md) for the
> mental model (agents, assignments, runs, briefs) before diving in.

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

The default is **active**: task-runner owns execution. It spawns the
backend, sends the brief, observes task state after every turn,
retries with a nudge on partial completion, and exits with a clean
status code that an outer system (CI, a scheduler, another agent) can
read directly instead of parsing chat output.

There is also a **passive / sidecar** option for when you'd rather
drive the work yourself from an interactive coding tool. task-runner
still owns task state, briefs, attachments, and audit; you update
state through the task CLI as you go.

Assignments can declare deterministic hooks that run around attempts
and task transitions — set up a worktree, run smoke tests, gate task
completion on child runs — without leaving the assignment file.

## Features at a glance

- Run an agent against a structured task list with per-turn state
  inspection and partial-completion retries
- Backends: `claude`, `codex`, `cursor`, `opencode`, `pi`, plus
  custom backend modules; `passive` for sidecar-style runs you drive
  yourself
- Resumable runs with a retry budget, `run audit` history, and a
  frozen `run brief` worker handoff
- Schedules (one-time and cron), dependencies, attachments, and run
  groups
- Local daemon (WebSocket JSON-RPC + HTTP/SSE) and bundled browser
  dashboard at `task-runner serve`
- Launchers for subprocess backends and first-class container
  execution environments

## Scope

task-runner is an orchestration and state-tracking layer. It executes
agent runs, holds their state, and surfaces audit + structured
handoffs. It is not an interactive coding environment — when you want
to chat with an agent in real time, you still use Claude Code,
Cursor, Codex, or whatever you already prefer. See
[docs/scope.md](docs/scope.md) for the full product stance and a
feature-triage heuristic.

## Install

### Requirements

- Linux or macOS (Windows: use WSL2; some launcher and Codex UDS
  features require Unix domain sockets)
- Node.js 20.19+ or 22.12+
- For active execution, at least one of the supported backend CLIs
  installed and authenticated:
  - `claude` (Anthropic Claude Code)
  - `codex` (OpenAI Codex CLI, or a running Codex app-server)
  - `cursor-agent` (Cursor headless agent — backend id `cursor`)
  - `opencode` (OpenCode CLI)
  - `pi` (Pi CLI)

See [docs/backends.md](docs/backends.md) for per-backend install and
auth notes. For a no-backend smoke test, use `--backend passive`.

### Install from source

task-runner is not yet published on npm. Install from a clone:

```bash
git clone https://github.com/kcosr/task-runner.git
cd task-runner
npm install
npm run build
npm link -w task-runner
```

This puts `task-runner` on your `PATH`. The `-w task-runner` flag is
required because the published CLI lives in the `task-runner`
workspace under `apps/cli/` — a bare `npm link` from the repo root
would link the private workspace root instead.

If you'd rather not link globally, run from the repo root:

```bash
npm run task-runner -- <args>
```

A published `npx task-runner` path is on the [roadmap](#roadmap).

### Install the bundled templates

task-runner ships a starter library of agent definitions, assignment
definitions, and shared task definitions under `agents/`,
`assignments/`, and `tasks/`. Copying them into your config directory
lets you refer to them by name (`--agent implementer`) instead of by
path (`--agent ./agents/implementer/agent.md`).

```bash
CONFIG_DIR="${TASK_RUNNER_CONFIG_DIR:-$HOME/.config/task-runner}"
mkdir -p "$CONFIG_DIR"
cp -R agents assignments tasks "$CONFIG_DIR"/
```

Copy all three directories together — bundled assignments reference
shared task definitions under `tasks/` (`review/architecture`,
`feature-plan/orient`, etc.), and those refs only resolve when the
matching `tasks/` directory is present.

After this step, list what's available:

```bash
task-runner list agents
task-runner list assignments
task-runner list tasks
```

To inspect one definition:

```bash
task-runner show agent implementer
task-runner show assignment repo-orientation
```

If you skip this step, use direct paths from inside the repo:
`--agent ./agents/<name>/agent.md`,
`--assignment ./assignments/<name>/assignment.md`.

### Uninstall / clean up

```bash
npm unlink task-runner               # remove the linked CLI
rm -rf ~/.config/task-runner         # remove definitions
rm -rf ~/.local/state/task-runner    # remove all run state
```

Per-run cleanup is safer than wiping the state root: use
`task-runner run archive <run-id>` to retire one, then
`task-runner run delete <run-id>` to remove it.

## Quickstart

These examples assume `task-runner` is on your `PATH`. If you skipped
`npm link`, prefix every command with `npm run task-runner --`.

### Verify the install

```bash
task-runner status
```

Prints config dir, state dir, and daemon connection (if any). If you
haven't installed a backend CLI yet, the **No-backend smoke check**
recipe below lets you exercise the surfaces with `--backend passive`.

### Run an active backend

With the bundled templates installed (see [Install the bundled
templates](#install-the-bundled-templates)):

```bash
task-runner run --agent implementer --assignment repo-orientation
```

Or from a repo clone using direct paths:

```bash
task-runner run \
  --agent ./agents/implementer/agent.md \
  --assignment ./assignments/repo-orientation/assignment.md
```

task-runner spawns the agent's backend (`codex` for `implementer`),
sends the brief, watches task state on each turn, retries with a nudge
on partial completion, and exits when the checklist is done (or after
the retry budget). The run id and workspace path print on stderr —
save the id for inspection:

```bash
task-runner run status <run-id>      # current state
task-runner run brief <run-id>       # the worker handoff
task-runner run audit <run-id>       # persisted event history
task-runner task list <run-id>       # tasks and their statuses
```

### Browser dashboard

```bash
task-runner serve
# Open the printed HTTP URL.
```

The web UI talks to the same local daemon. Connected CLI commands
(`--connect <ws-url>` or `TASK_RUNNER_CONNECT`) appear in the UI live.

### No-backend smoke check

If you don't have one of the backend CLIs installed yet, you can still
exercise task-runner's state surfaces with a passive run:

```bash
# Initialize a passive smoke run (no backend; you drive task state).
task-runner init --backend passive --assignment ./assignments/test/assignment.md
# Note the run id printed (e.g. `run=3mackw`).

task-runner run brief <run-id>
task-runner task list <run-id>
task-runner task set <run-id> <task-id> --status completed
```

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `task-runner: command not found` | Not on `PATH`. | Re-run `npm link -w task-runner` (note the `-w`), or use `npm run task-runner -- <args>`. |
| `Backend 'claude' not available` (or codex/cursor/...) | Backend CLI not installed or not on `PATH`. | Install the backend's CLI and verify it runs standalone. Or use `--backend passive` for a no-backend run. |
| `EADDRINUSE` on `task-runner serve` | A daemon is already listening. | Run `task-runner status` to see the URL. |
| `--agent implementer` errors with "not found" | Bundled templates not copied into the config dir. | Run the copy step in [Install the bundled templates](#install-the-bundled-templates), or use the direct path. |
| `npx task-runner ...` errors | Not yet published. | Use the source install above. |

See [docs/cli.md](docs/cli.md) for the full command reference.

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
| [docs/resume.md](docs/resume.md) | Resume rules, ready-start, retry nudges |
| [docs/dependencies.md](docs/dependencies.md) | Dependency graph and execution gate |
| [docs/attachments.md](docs/attachments.md) | File handoff, run group scope, limits |
| [docs/backends.md](docs/backends.md) | Built-in and custom backends |
| [docs/container-lifecycle.md](docs/container-lifecycle.md) | Container execution environment and lifecycle design |
| [docs/configuration.md](docs/configuration.md) | Env vars, XDG roots, manifest upgrades |
| [docs/cli.md](docs/cli.md) | Full CLI reference — every command and flag |
| [docs/daemon.md](docs/daemon.md) | Control plane, HTTP/SSE, JSON-RPC |
| [docs/web-dashboard.md](docs/web-dashboard.md) | Bundled browser UI |
| [docs/design.md](docs/design.md) | Canonical design, schema, lifecycle rules |
| [docs/examples.md](docs/examples.md) | Bundled agents and assignments tour |
| [docs/scope.md](docs/scope.md) | Product scope and feature-triage heuristic |

## Recipes

Common workflows, each linked to the detail doc that covers them in
full.

### Prepare a run, edit it, then start it

`init` creates an `initialized` run without invoking the backend.
`reconfigure` patches vars or the message before the run starts. `run
ready` promotes the run, and `run --resume-run` starts it.

```bash
task-runner init --agent implementer --assignment repo-orientation

# Optional: tweak the prepared run before starting.
task-runner run reconfigure <run-id> --var target=next

task-runner run ready <run-id>
task-runner run --resume-run <run-id>
```

`run reconfigure` is for unarchived `initialized` runs only. See
[docs/resume.md](docs/resume.md).

### Drive a passive run (no backend invocation)

Passive runs let your existing interactive coding tool do the work
while task-runner owns task state and audit.

```bash
task-runner init --backend passive --assignment plan-feature \
  --name "Web dashboard" "Design the dashboard work"

task-runner run brief <run-id>     # hand this to your tool
task-runner task set <run-id> <task-id> --status in_progress
task-runner task append-notes <run-id> <task-id> --text "Observed ..."
task-runner run set-backend-session <run-id> <session-id>
task-runner task set <run-id> <task-id> --status completed
```

### Queue a follow-up message for a live run

```bash
task-runner run queue-message <run-id> "Check the logs before continuing"
task-runner run queued-messages <run-id>
task-runner run remove-queued-message <run-id> <message-id>
```

Queued messages persist on the run. The web Chat composer uses
`Queue` for live runs and `Send` for non-live resumable runs.

### Schedule a run

```bash
task-runner init --agent implementer --assignment repo-orientation \
  --schedule-delay 30m
task-runner run ready <run-id>
```

One-time schedules use `--schedule-at <iso>` or `--schedule-delay
<duration>`. Recurring schedules use `--schedule-cron <expr>` with
optional `--schedule-timezone <iana>`, `--schedule-mode
reuse|reset|clone`, and `--schedule-continue-on-failure`.

Mutate schedules on an existing run:

```bash
task-runner run schedule <run-id> --cron "0 9 * * *" --timezone UTC --mode clone
task-runner run schedule disable <run-id>
task-runner run schedule enable <run-id>
task-runner run schedule clear <run-id>   # one-time only; disable for recurring
```

### Launcher-backed subprocess runs

A launcher prepends a command (e.g. `ssh`, `docker exec`, `flatpak
run`) to the backend invocation.

```yaml
# ${TASK_RUNNER_CONFIG_DIR}/launchers/ssh-docker.yaml
schemaVersion: 1
name: ssh-docker
command: ssh
args: [worker, docker, exec, agent]
```

```yaml
# ${TASK_RUNNER_CONFIG_DIR}/agents/remote/agent.md
---
schemaVersion: 1
name: remote
backend: claude
launcher: ssh-docker
---
Operate remotely.
```

```bash
task-runner run --agent remote --launcher ssh-docker
task-runner list launchers
task-runner show launcher ssh-docker
```

Launchers apply only to subprocess-backed execution (`claude`,
`cursor`, `opencode`, `pi`, and Codex stdio). Passive runs and Codex
websocket/UDS runs keep the built-in `direct` launcher. For
containers, prefer first-class execution environments (next recipe)
over launcher wrappers.

### Container execution environment

```yaml
# ${TASK_RUNNER_CONFIG_DIR}/environments/agent-dev.yaml
schemaVersion: 1
name: agent-dev
kind: container
mode: managed
engine: podman
image: agent-dev:latest
lifetime: group
cwd: "{{workspace_host_path}}"
workspace:
  scope: group
  hostRoot: "{{state_dir}}/workspaces"
  containerPath: /workspace
lifecycle:
  onWorkspaceCreate:
    - kind: command
      target: container
      command: npm
      args: [install]
sessionMounts: backend
```

Managed environments create host workspace directories, mount them
into the container, rewrite cwd, and keep a group-scoped container
alive until the group is done. See
[docs/container-lifecycle.md](docs/container-lifecycle.md) for the
full lifecycle and var model.

### Hooked assignment

Hooks run deterministically around attempts and task transitions
(e.g. set up a worktree, run smoke tests, gate task completion):

```yaml
---
schemaVersion: 1
name: repo-work
hooks:
  beforeAttempt:
    - builtin: git-worktree
      when: { sessionIndex: [0], attemptIndexInSession: [0] }
      with:
        repo: "{{cwd}}"
        from: main
        branch: review-worktree
        path: "{{cwd}}/.worktrees/review-worktree"
    - builtin: command
      when: { sessionIndex: [0] }
      with:
        mode: status
        command: npm
        args: ["test", "--", "smoke"]
---
Work on the repo.
```

Hooks can also gate task completion on children. This blocks
`peer_review` until every direct child run reaches `success`:

```yaml
tasks:
  - id: peer_review
    title: Peer review
    hooks:
      - builtin: require-children-success
        with: { requireAny: false }
```

Named hooks resolve from
`${TASK_RUNNER_CONFIG_DIR}/hooks/<hook-name>/hook.(ts|mts|js|mjs)`.
Assignment-local path hooks resolve relative to the authored
`assignment.md`. See [docs/agents-and-assignments.md](docs/agents-and-assignments.md).

### Custom backend module

Named custom backends live under:

```text
${TASK_RUNNER_CONFIG_DIR}/backends/<backend-name>/backend.(ts|mts|js|mjs)
```

The module must default-export a backend object whose `id` matches
the directory name. Built-in names (`claude`, `codex`, `cursor`,
`opencode`, `pi`, `passive`) are reserved. Custom backend code is
trusted local code — install its dependencies under the config dir:

```bash
cd "${TASK_RUNNER_CONFIG_DIR:-$HOME/.config/task-runner}"
npm install <package>
```

See [docs/backends.md](docs/backends.md).

### Run through the daemon (or over SSH)

CLI commands can run **embedded** (direct filesystem access) or
**connected** to the daemon (`--connect <ws-url>` or
`TASK_RUNNER_CONNECT`). Connected mode broadcasts changes to other
clients (the browser UI updates live). Use it when you want the
dashboard to reflect CLI changes immediately.

To reach a remote daemon through SSH:

```bash
export TASK_RUNNER_CONNECT=ws://remote-host:4773/
export TASK_RUNNER_CONNECT_HOST=remote-host
task-runner list runs
```

The CLI opens an invocation-scoped local forward and tunnels
WebSocket/HTTP traffic through it. Anything fancier belongs in your
SSH config. See [docs/daemon.md](docs/daemon.md).

## Command index

| Command | Purpose |
|---------|---------|
| `run` | Execute a fresh run, promote an initialized run to ready, start a ready run, or resume |
| `init` | Prepare a run workspace without invoking the backend |
| `serve` | Start the local daemon (WS JSON-RPC + HTTP/SSE + web UI) |
| `status` | Print system/environment status |
| `run status\|brief\|audit` | Print run state, the composed worker handoff, or persisted audit history |
| `run environment status\|validate\|cleanup` | Inspect, validate, or clean up a run execution environment |
| `task list\|show\|set\|append-notes\|add` | Run task-state inspection and mutation |
| `attachment add\|list\|download\|remove` | Attachment management |
| `list agents\|assignments\|launchers\|environments\|tasks\|runs` | Enumerate definitions and runs |
| `show agent\|assignment\|launcher\|environment\|task` | Render a single definition |
| `run reconfigure` | Patch vars/message on an unarchived initialized run |
| `run queue-message\|queued-messages\|remove-queued-message` | Manage queued resume messages for live runs |
| `run reset\|archive\|unarchive\|delete` | Lifecycle mutations |
| `run schedule [set]\|enable\|disable\|clear` | Schedule mutations |
| `run set-name` | Set/clear persisted display name |
| `run set-note\|clear-note` | Set/clear persisted human note metadata |
| `run pin\|unpin` | Set/clear persisted pin metadata |
| `run set-backend-session\|clear-backend-session` | Passive-only session metadata |
| `run set-group\|clear-group` | Set/clear a run's group |
| `run add-dep\|remove-dep\|clear-deps` | Dependency graph mutations |

See [docs/cli.md](docs/cli.md) for the full flag-by-flag reference.

Key rules:

- `task-runner status` takes no run id and reports config/state/daemon info.
- `task-runner run status`, `task-runner run brief`, and `task-runner run audit` accept a run id, not a workspace path.
- `run brief` is text-only (no `--output-format`, no `--field`).
- `run audit --output-format json` returns `{ runId, events, lastCursor }`; text output renders the persisted audit envelopes chronologically.
- `run status --output-format json` returns the shared `RunDetail` DTO, including full `note` text plus `pinned`.
- Text `run status` surfaces note/pin metadata compactly (`Pinned: yes`, `Note: present`) and never prints the note body.
- `run queued-messages` reads the existing run detail surface; queue and
  remove mutations update the run manifest and daemon projections.
- Run notes are human metadata only: they persist on the run but are not auto-injected into worker briefs or backend prompts.
- `--message-file <path>` reads UTF-8 message text for fresh `run`,
  `init`, `run --resume-run`, and `run reconfigure`; it cannot be
  combined with positional message text.
- `list runs` defaults to the caller's cwd; use `--cwd`, `--repo`, or
  `--global` to scope otherwise; `--include-archived` adds archived
  runs.
- `list runs --group-id <group-id>` scopes to one run group.
- `attachment list` defaults to `--scope group`, which includes
  attachments owned by every run in the target run's group. Use
  `--scope run` for the target run only.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success (all tasks completed, or initialized run) |
| `1` | Retries exhausted with incomplete tasks |
| `2` | One or more tasks reported blocked |
| `3` | Validation, config, or daemon connectivity error |
| `4` | Backend or runtime failure |
| `130` | User cancellation / confirmed interrupt |

Exit code `2` is also the canonical "no-go" signal for review-style
assignments — `plan-review` and `code-review` mark their `approval`
task `blocked` to deliberately fail the run when the reviewer rejects.

## Environment variables

| Variable | Effect |
|----------|--------|
| `TASK_RUNNER_CONFIG_DIR` | Agent/assignment definitions root |
| `TASK_RUNNER_STATE_DIR` | Run workspaces root |
| `TASK_RUNNER_CONNECT` | Route client commands through a daemon |
| `TASK_RUNNER_LISTEN` | Daemon listen URL |
| `TASK_RUNNER_DAEMON_AUTH_ENABLED` | Enable shared-token guard for the daemon control plane (`true`/`1`/`yes`/`on`) |
| `TASK_RUNNER_DAEMON_TOKEN` | Bearer token for daemon auth; set the same value in `serve` and connected CLI environments |
| `TASK_RUNNER_DAEMON_FILESYSTEM_LOCKS` | Set to `true` to make daemon projection refreshes wait on task-state filesystem locks |
| `TASK_RUNNER_PARENT_RUN_ID` | Default lineage parent for fresh runs when `--parent-run` is omitted |
| `TASK_RUNNER_RUN_ID` | Active run id provided to backend wrapper processes |
| `TASK_RUNNER_RUN_GROUP_ID` | Default run group for fresh runs when `--group-id` is omitted; active run group id provided to backend wrapper processes |
| `TASK_RUNNER_CWD` | Active backend attempt cwd provided to backend wrapper processes |
| `TASK_RUNNER_CLAUDE_BIN` | Claude CLI binary |
| `TASK_RUNNER_CODEX_BIN` | Codex stdio binary |
| `TASK_RUNNER_CODEX_UDS_PATH` | Default WebSocket-over-UDS transport socket path for fresh Codex runs when no explicit `backendConfig.codex.transport` was authored |
| `TASK_RUNNER_CODEX_WS_URL` | Default websocket transport for fresh Codex runs when no explicit `backendConfig.codex.transport` was authored |
| `TASK_RUNNER_CURSOR_BIN` | Cursor CLI binary |
| `TASK_RUNNER_OPENCODE_BIN` | OpenCode CLI binary |
| `TASK_RUNNER_OPENCODE_DATA_DIR` | OpenCode data directory for session-history validation/sync; falls back to `OPENCODE_DATA_DIR` |
| `TASK_RUNNER_CAPTURE_BACKEND_STDOUT` | Write raw backend stdout sidecars to `attempts/NN.stdout.log` for local debugging |
| `TASK_RUNNER_BACKEND_SESSION_SYNC` | Set to `false`, `0`, `no`, or `off` to disable backend-owned session history import/sync |
| `TASK_RUNNER_MIN_SCHEDULE_DELAY_SEC` | Minimum accepted one-time schedule delay (default `300`) |
| `TASK_RUNNER_MIN_RECURRENCE_INTERVAL_SEC` | Minimum accepted recurring schedule interval, sampled across cron occurrences (default `300`) |
| `TASK_RUNNER_PI_BIN` | Pi CLI binary |
| `PI_HOME` | Pi session storage root (default `~/.pi`) |
| `TASK_RUNNER_MAX_CALL_DEPTH` | Recursion cap (default `1`) |

See [docs/configuration.md](docs/configuration.md) for XDG resolution
and full details.

## Bundled definitions

Agents (under `agents/`):

- `generic`, `planner`, `implementer`, `code-reviewer`, `doc-reviewer`, `test`

Assignments (under `assignments/`):

- `repo-orientation`, `test`, `plan-feature`, `plan-implement-feature`,
  `plan-review`, `code-review`, `code-review-direct`, `doc-review`,
  `familiarize`

Shared task definitions (under `tasks/`):

- reusable `review/architecture` through `review/docs-drift`
  code-review dimensions used by both code-review assignments
- reusable `feature-plan/*` and `feature-implement/*` task definitions
  used by bundled feature-planning and single-run implementation flows
- inspect reusable task definitions with `task-runner list tasks` and
  `task-runner show task <name|path>`; these are read-only definition
  surfaces, distinct from `task-runner task ...` run task-state commands

Walkthrough in [docs/examples.md](docs/examples.md).

## Development

```bash
npm install
npm run build
npm run lint
npm run lint:fix
npm run format
npm run format:check
npm run imports:fix
npm run imports:check
npm run test:node
npm run test:web
npm run test:all:local
npm run check:knip
npm run check
```

`npm run lint` runs Biome linting with warnings treated as failures,
and `npm run lint:fix` applies Biome lint autofixes. `npm run format`
writes Biome formatting, `npm run format:check` checks formatting
without writing, `npm run imports:fix` applies Biome import
organization, and `npm run imports:check` verifies import organization
without writing. `npm run test:all:local` runs the Node and web tests
locally. `npm run check:knip` runs the unused-file/export/dependency
baseline. `npm test` runs build plus tests, and `npm run check` runs
build, lint, format-check, import-check, and tests. Set
`TASK_RUNNER_TEST_REMOTE_HOST` to sync the worktree and run the test gate
on a remote host; otherwise tests run locally.

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
- **Improved run provenance tracking** — today manifests record which
  host/controller executed the latest session (`execution.hostMode`,
  `execution.controller.daemonInstanceId`). A richer audit trail —
  who/what originally launched the run, which parent spawned which
  nested child, which caller issued which mid-run mutation — would
  make cross-run forensics and orchestration replay tractable.
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

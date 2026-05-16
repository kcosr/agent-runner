# agent-runner

> [!WARNING]
> Agent Runner is early experimental software. Its CLI, config schema,
> manifest schema, hooks, daemon API, web UI behavior, and internal
> workflow contracts may change without compatibility guarantees. Expect
> migrations and breaking changes while the project is still taking
> shape.

`agent-runner` runs a coding agent against a structured checklist and
keeps the run going — re-prompting and retrying — until every task is
actually done, blocked, or out of retries. Instead of trusting the
agent's final "all done" message, it inspects the task list the agent
updated and acts on what it finds.

Every run is recorded durably: per-task final status, the agent's
notes, and an audit trail of how the run got there. When a run ends you
get a structured pass/fail result and [exit code](#exit-codes), not a
chat log to re-read.

## Why

If you've used a coding agent for any non-trivial task, you've seen
this loop:

1. You give the agent a list of things to do.
2. The agent confidently announces "all done!"
3. You check, and two of the five things weren't actually done.
4. You write another prompt: "you didn't finish X and Y, try again."
5. Repeat.

`agent-runner` wraps that loop. The task list is structured — each task
has a stable id, a title, and a status the agent updates in place. The
runner inspects state after every turn, and a partial completion
becomes another iteration with a programmatic nudge instead of a
hand-typed follow-up. When the agent gets it right, the run ends and
the runner emits a structured record with the per-task final statuses
and the agent's notes.

It is also a useful primitive for orchestration: an outer agent can
compose an assignment, hand it to `agent-runner`, and get back a
structured success/failure without parsing free-form chat output.

## Two ways to use it

- **Sidecar mode** — initialize and inspect runs here, but drive the
  work from your existing interactive coding tool, updating task state
  through the task CLI. You get task tracking, briefs, attachments, and
  durable run state without handing execution over to agent-runner.
- **Active backend mode** — execute the run through a supported backend
  (`claude`, `codex`, `cursor`, `opencode`, `pi`). agent-runner performs
  the run/retry loop itself and validates whether tasks were actually
  marked complete before the run is treated as done. Backend-native
  capabilities (skills, subagents, MCP servers, custom slash commands)
  keep working — agent-runner controls when and how the backend is
  invoked, not what it does once running.

Validation today is task-state based: did the worker actually complete
the checklist it was given? Assignments can also declare deterministic
hooks that run at prepare time, around attempts, or during task
transitions — see [Beyond the basics](#beyond-the-basics).

## How it works

Three definitions and one record:

- An **agent** supplies the backend, model, and role instructions.
- An **assignment** supplies a reusable task list and work context.
- A **run** is the persisted execution instance created from one agent
  and (optionally) one assignment. Task state is canonical in the run's
  `run.json` manifest; workers mutate it through the `agent-runner task`
  CLI, not workspace files.

Start with [docs/concepts.md](docs/concepts.md) for the full mental
model.

## Standalone CLI or local daemon

agent-runner works as a standalone CLI with no daemon. Commands run
*embedded* — they read and write run state directly on the filesystem,
so a single terminal needs nothing else running.

A local daemon is optional. `agent-runner serve` adds the browser
dashboard and broadcasts run changes in real time, so multiple terminals
and the web UI stay in sync. The recommended local setup runs one daemon
and points the CLI at it:

```bash
export AGENT_RUNNER_LISTEN=ws://127.0.0.1:4773/
export AGENT_RUNNER_CONNECT=ws://127.0.0.1:4773/
export AGENT_RUNNER_MAX_CALL_DEPTH=2
```

`AGENT_RUNNER_LISTEN` is the address `agent-runner serve` binds;
`AGENT_RUNNER_CONNECT` routes CLI commands through that daemon so its
projections and the dashboard stay current. `AGENT_RUNNER_MAX_CALL_DEPTH=2`
raises the recursion cap one level so a run can launch a nested
`agent-runner` run, which is useful for orchestration. With
`AGENT_RUNNER_CONNECT` exported, keep `agent-runner serve` running —
connected commands fail fast if the daemon is unreachable. For pure
standalone use, leave `AGENT_RUNNER_CONNECT` unset.

## Scope and direction

agent-runner is an orchestration and state-tracking layer for agent
runs, not an interactive coding environment. Upstream design and
ideation happen elsewhere; agent-runner takes a plan (or the
requirements to produce one), runs it, and surfaces durable state,
audit, and structured handoffs at each user gate. It does not replace
the interactive tool you use to converse with an agent in the moment.

See [`docs/scope.md`](docs/scope.md) for the full product stance,
including a triage heuristic for evaluating feature requests against
scope.

## Install

Requirements:

- Node.js 20.19+ or 22.12+
- a supported backend when you want live execution: `claude`, `codex`
  (or a Codex app-server), `cursor-agent`, `opencode`, or `pi`

### Option 1: local build / linked development install

```bash
npm install
npm run build
npm link --workspace @kcosr/agent-runner
```

The built CLI entrypoint is `node apps/cli/dist/cli.js`. The workspace
also exposes `npm run agent-runner -- <args>`.

### Option 2: package-style invocation

Once agent-runner is published as a package, the intended no-install
path is:

```bash
npx @kcosr/agent-runner <args>
```

## Quickstart

### Set up your config directory

Named definitions — agents, assignments, and tasks — live in your config
directory (`~/.config/agent-runner/` by default). Copy the bundled
definitions there from the repository root so you can refer to them by
name from any directory:

```bash
mkdir -p ~/.config/agent-runner
cp -R agents assignments tasks ~/.config/agent-runner/
```

`--agent implementer` and `--assignment repo-orientation` now resolve by
name, and the same directory is where you author your own definitions. A
`--agent` / `--assignment` value is instead treated as a file path when
it is absolute or starts with `./` or `../`, so you can still point at a
definition outside the config directory.

### Run an agent against an assignment

```bash
agent-runner run --agent implementer --assignment repo-orientation
```

The runner executes the backend, inspects task state after each turn,
retries incomplete work, and exits with a [status code](#exit-codes)
reflecting the outcome.

### Inspect a run

```bash
agent-runner status                       # system / environment context
agent-runner run status <run-id>          # lifecycle and task state
agent-runner run brief <run-id>           # the worker handoff
agent-runner run audit <run-id>           # persisted audit history
agent-runner task list <run-id>
agent-runner task show <run-id> <task-id>
```

### Prepare a run without executing it

```bash
agent-runner init --agent implementer --assignment repo-orientation

agent-runner run ready <run-id>
agent-runner run --resume-run <run-id>
```

`init` creates the run in the `initialized` state, `run ready` promotes
it to `ready`, and `run --resume-run` starts it. An initialized run can
still be adjusted before it starts with `run reconfigure` — see
[docs/cli.md](docs/cli.md).

### Drive a run yourself (sidecar mode)

```bash
agent-runner init \
  --backend passive \
  --assignment plan-feature \
  --name "Web dashboard" \
  "Design the dashboard work"

agent-runner run brief <run-id>
agent-runner task set <run-id> <task-id> --status in_progress
agent-runner task append-notes <run-id> <task-id> --text "Observed ..."
agent-runner task set <run-id> <task-id> --status completed
```

A `passive` run invokes no backend. You do the work in your own tool
and report progress through the task CLI; agent-runner keeps the
durable record. See [docs/backends.md](docs/backends.md) for the full
passive / external-driver workflow.

### Browser dashboard

```bash
agent-runner serve
# Open the printed HTTP base URL in a browser.
```

`agent-runner serve` starts the local daemon; the web UI talks to that
same daemon and is not a standalone app. See
[docs/web-dashboard.md](docs/web-dashboard.md).

## Beyond the basics

agent-runner has a deeper feature set than the quickstart shows. Each
row links to the section that documents it:

| Topic | What it does | Where it's documented |
|---|---|---|
| Hooks | Deterministic checks around attempts and task transitions | [docs/hooks.md](docs/hooks.md) |
| Custom backends | Author your own backend module | [docs/custom-backends.md](docs/custom-backends.md) |
| Launchers | Wrap subprocess backends (e.g. SSH into a worker) | [docs/agents-and-assignments.md (Launcher definitions)](docs/agents-and-assignments.md#launcher-definitions) |
| Container environments | Run inside a managed container | [docs/execution-environments.md](docs/execution-environments.md) |
| Scheduling | One-time and recurring (cron) runs | [docs/runs.md (Scheduled runs)](docs/runs.md#scheduled-runs) |
| Queued messages | Queue resume messages for a live run | [docs/resume.md (Queued resume messages)](docs/resume.md#queued-resume-messages) |
| Attachments | File handoff between runs | [docs/attachments.md](docs/attachments.md) |
| Dependencies | Gate a run until upstream runs succeed | [docs/dependencies.md](docs/dependencies.md) |
| Connected mode | Route CLI commands through the daemon, optionally over SSH | [docs/daemon.md (CLI clients)](docs/daemon.md#cli-clients-embedded-vs-connected) |

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

See [docs/cli.md](docs/cli.md) for the full flag-by-flag reference,
including per-command rules and JSON output shapes.

## Documentation

Start with [docs/concepts.md](docs/concepts.md) for the mental model.
The rest are focused topic pages:

| Doc | Topic |
|---|---|
| [docs/concepts.md](docs/concepts.md) | Mental model — agents, assignments, runs, briefs |
| [docs/agents-and-assignments.md](docs/agents-and-assignments.md) | Definition format, locked fields, prompt composition |
| [docs/hooks.md](docs/hooks.md) | Hook phases, built-in hooks, the authoring API |
| [docs/tasks.md](docs/tasks.md) | Task model, status values, task CLI, mutation rules |
| [docs/runs.md](docs/runs.md) | Workspace layout, manifest, lifecycle, capabilities |
| [docs/variables.md](docs/variables.md) | Typed vars, resolution, interpolation, redaction |
| [docs/resume.md](docs/resume.md) | Resume rules, ready-start, retry nudges |
| [docs/dependencies.md](docs/dependencies.md) | Dependency graph and execution gate |
| [docs/attachments.md](docs/attachments.md) | File handoff, run group scope, limits |
| [docs/backends.md](docs/backends.md) | Built-in backends, selection, per-backend notes |
| [docs/custom-backends.md](docs/custom-backends.md) | Authoring a custom backend module |
| [docs/execution-environments.md](docs/execution-environments.md) | Container execution environments — definition and lifecycle |
| [docs/configuration.md](docs/configuration.md) | Env vars, XDG roots, manifest upgrades |
| [docs/cli.md](docs/cli.md) | Full CLI reference — every command and flag |
| [docs/daemon.md](docs/daemon.md) | Control plane, HTTP/SSE, JSON-RPC |
| [docs/web-dashboard.md](docs/web-dashboard.md) | Bundled browser UI |
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
| `AGENT_RUNNER_CONFIG_DIR` | Agent/assignment definitions root |
| `AGENT_RUNNER_STATE_DIR` | Run workspaces root |
| `AGENT_RUNNER_CONNECT` | Route client commands through a daemon |
| `AGENT_RUNNER_CONNECT_HOST` | SSH host used to create an invocation-scoped local forward for connected commands |
| `AGENT_RUNNER_CONNECT_LOCAL_PORT` | Loopback port for the `AGENT_RUNNER_CONNECT_HOST` SSH forward |
| `AGENT_RUNNER_LISTEN` | Daemon listen URL |
| `AGENT_RUNNER_DAEMON_AUTH_ENABLED` | Set to `true` in the daemon environment to require bearer-token auth for daemon API and WebSocket access |
| `AGENT_RUNNER_DAEMON_TOKEN` | Shared daemon bearer token for auth-enabled daemon servers and clients |
| `AGENT_RUNNER_DAEMON_FILESYSTEM_LOCKS` | Set to `true` to make daemon projection refreshes wait on task-state filesystem locks |
| `AGENT_RUNNER_PARENT_RUN_ID` | Default lineage parent for fresh runs when `--parent-run` is omitted |
| `AGENT_RUNNER_RUN_ID` | Active run id provided to backend wrapper processes |
| `AGENT_RUNNER_RUN_GROUP_ID` | Default run group for fresh runs when `--group-id` is omitted; active run group id provided to backend wrapper processes |
| `AGENT_RUNNER_CWD` | Active backend attempt cwd provided to backend wrapper processes |
| `AGENT_RUNNER_CLAUDE_BIN` | Claude CLI binary |
| `AGENT_RUNNER_CODEX_BIN` | Codex stdio binary |
| `AGENT_RUNNER_CODEX_UDS_PATH` | Default WebSocket-over-UDS transport socket path for fresh Codex runs when no explicit `backendConfig.codex.transport` was authored |
| `AGENT_RUNNER_CODEX_WS_URL` | Default websocket transport for fresh Codex runs when no explicit `backendConfig.codex.transport` was authored |
| `AGENT_RUNNER_CURSOR_BIN` | Cursor CLI binary |
| `AGENT_RUNNER_OPENCODE_BIN` | OpenCode CLI binary |
| `AGENT_RUNNER_OPENCODE_DATA_DIR` | OpenCode data directory for session-history validation/sync; falls back to `OPENCODE_DATA_DIR` |
| `AGENT_RUNNER_CAPTURE_BACKEND_STDOUT` | Write raw backend stdout sidecars to `attempts/NN.stdout.log` for local debugging |
| `AGENT_RUNNER_BACKEND_SESSION_SYNC` | Set to `false`, `0`, `no`, or `off` to disable backend-owned session history import/sync |
| `AGENT_RUNNER_MIN_SCHEDULE_DELAY_SEC` | Minimum accepted one-time schedule delay (default `300`) |
| `AGENT_RUNNER_MIN_RECURRENCE_INTERVAL_SEC` | Minimum accepted recurring schedule interval, sampled across cron occurrences (default `300`) |
| `AGENT_RUNNER_PI_BIN` | Pi CLI binary |
| `PI_HOME` | Pi session storage root (default `~/.pi`) |
| `AGENT_RUNNER_MAX_CALL_DEPTH` | Recursion cap (default `1`) |

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
- inspect reusable task definitions with `agent-runner list tasks` and
  `agent-runner show task <name|path>`; these are read-only definition
  surfaces, distinct from `agent-runner task ...` run task-state commands

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
baseline. For the standard pre-commit gate, run `npm run check`.
`npm test` runs build plus tests, and `npm run check` runs build, lint,
format-check, import-check, and tests. Set
`AGENT_RUNNER_TEST_REMOTE_HOST` to sync the worktree and run the test gate
on a remote host; otherwise tests run locally.

Primary entry points:

- `apps/cli/src/cli.ts`
- `apps/cli/src/daemon/`
- `packages/core/src/core/run/run-loop.ts`
- `packages/core/src/core/run/manifest.ts`
- `packages/core/src/core/commands/service.ts`

## Roadmap

Directions agent-runner is likely to grow in next. Nothing below is
implemented yet — the list is here so you can see where things are
heading and flag anything that conflicts with how you're using
agent-runner today.

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
  etc.) to configured external HTTP endpoints so agent-runner can
  notify CI systems, chat-ops bots, or dashboards without each
  consumer having to subscribe over SSE directly.
- **Agent and assignment inheritance** — let an agent or assignment
  declare an `extends:` parent and inherit frontmatter defaults,
  locked fields, role instructions, and (for assignments) task lists.
  Child definitions could override individual fields, append tasks,
  or redact inherited locks, avoiding today's copy-paste when you
  want a family of related agents/assignments that share a base.

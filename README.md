# task-runner

`task-runner` drives agents through structured task lists and keeps run
state in a manifest-canonical workspace. It supports embedded CLI
execution, active backend invocation, passive sidecar operation, a local
daemon, a browser dashboard, resumable runs, attachments, dependencies,
scheduled runs, launcher prefixes for subprocess backends, a first-class
`run brief` surface for handing a run to a worker, and `task-runner run
audit` for reading durable run audit history. Live runs can also hold
queued resume messages as daemon-owned pending user intent for the next
runnable resume opportunity.

- Task state is canonical in `run.json`.
- `run-events.jsonl` is a per-run append-only audit trail with monotonic
  cursors for current runs; it is durable history, not canonical state.
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
events. Older workspaces may still carry uncursored schema v1 rows and
should be upgraded with `scripts/migrate-run-events-v2.mjs` before you
rely on the audit surface. `run.json` remains the source of truth, while
`task-runner run audit <run-id>` and the daemon `/api/runs/:runId/audit`
surface the persisted audit history for humans and clients.

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
  Backend-native capabilities like skills, subagents, MCP servers, and
  custom slash commands continue to work; task-runner controls when and
  how the backend is invoked, not what it does once running.

Today the built-in validation is task-state based: did the worker
actually complete the checklist it was given? Assignments can also
declare deterministic hooks that run at prepare time, around attempts,
or during task transitions to block, re-invoke, mutate run metadata, or
stage attachments before the run continues.

## Scope and direction

task-runner is an orchestration and state-tracking layer for agent runs,
not an interactive coding environment. Upstream design and ideation
happen elsewhere; task-runner takes a plan (or the requirements to
produce one), runs it, and surfaces durable state, audit, and structured
handoffs at each user gate. In practice it is used either as a sidecar
for your existing interactive coding agents, or as a runner for
prepared/background tasks that need a durable checklist and audit trail.

See [`docs/scope.md`](docs/scope.md) for the full product stance,
including a triage heuristic for evaluating feature requests against
scope.

## Install

Requirements:

- Node.js 20.19+ or 22.12+
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
task-runner run audit <run-id>
task-runner task list <run-id>
task-runner task show <run-id> <task-id>
```

### Prepare a run without executing it

```bash
task-runner init \
  --agent ./agents/implementer/agent.md \
  --assignment ./assignments/repo-orientation/assignment.md

task-runner run reconfigure <run-id> \
  --var target=next \
  --message-file ./handoff.md

task-runner run ready <run-id>
task-runner run --resume-run <run-id>
```

`run reconfigure` is only for unarchived `initialized` runs. It patches
runtime vars and/or the initial message, rerenders the brief and reset
seed all-or-nothing, and preserves frozen identity/runtime fields such
as agent, assignment, launcher, hooks, tasks, cwd, selected
`backendConfig`, plus selected backend extra args.

### Queue a message for a live run

```bash
task-runner run queue-message <run-id-or-path> "Check the logs before continuing"
task-runner run queued-messages <run-id-or-path>
task-runner run remove-queued-message <run-id-or-path> <message-id>
```

Queued resume messages are persisted on the run. Connected CLI mutations
route through the daemon with `--connect`, so the web dashboard and other
daemon clients see the updated queued-message count immediately. The web
Chat composer uses `Queue` for live runs and keeps `Send` for non-live
resumable runs.

### Schedule a run

```bash
task-runner init \
  --agent ./agents/implementer/agent.md \
  --assignment ./assignments/repo-orientation/assignment.md \
  --schedule-delay 30m

task-runner run ready <run-id>
```

Scheduled runs remain in `ready` until their schedule is due. One-time
schedules use `--schedule-at <iso>` or `--schedule-delay <duration>`;
recurring schedules use `--schedule-cron <expr>` with optional
`--schedule-timezone <iana>`, `--schedule-mode reuse|reset|clone`, and
`--schedule-continue-on-failure`.

Existing runs can be changed with:

```bash
task-runner run schedule <run-id> --cron "0 9 * * *" --timezone UTC --mode clone
task-runner run schedule disable <run-id>
task-runner run schedule enable <run-id>
task-runner run schedule clear <run-id>
```

`run schedule clear` is for one-time schedules only; disable recurring
schedules when they should stop firing. Manual start is still allowed:
starting a one-time scheduled run consumes the schedule, while starting a
recurring run before its `runAt` leaves the next recurrence intact.

### Launcher-backed subprocess runs

```yaml
# ~/.config/task-runner/launchers/ssh-docker.yaml
schemaVersion: 1
name: ssh-docker
command: ssh
args: [worker, docker, exec, agent]
```

```yaml
# ~/.config/task-runner/agents/remote/agent.md
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

Launchers apply only to subprocess-backed execution (`claude`, `cursor`,
`pi`, and Codex stdio). Passive runs and Codex websocket/UDS runs keep
the built-in `direct` launcher.

Launcher command and args are runtime-interpolated before they are frozen
into the manifest. A short-term persistent-container workflow can combine
a run-group workspace path with a launcher wrapper:

```yaml
# assignment.md
cwd: "/home/kevin/agent-workspaces/{{run_group_id}}/repo"
```

```yaml
# agent.md
launcher:
  command: aw-tr-launch
  args:
    - agent-dev
    - "{{cwd}}"
    - "{{run_group_id}}"
```

Task-runner does not manage the container lifecycle or cleanup. The
wrapper receives the frozen cwd and run group id so it can enter a
workspace that another process prepared.

Agents may also author backend-owned argv tokens:

```yaml
backendArgs:
  claude:
    extraArgs: ["--profile", "default"]
  codex:
    extraArgs: ["--model", "gpt-5.4"]
```

The selected backend's args are frozen into local `run.json` at run
creation; status APIs do not expose them. Codex stdio receives the args
when launching `app-server`, while Codex websocket/UDS transports connect
to an already-running server and ignore them.

### Custom backend modules

Named custom backends live under:

```text
${TASK_RUNNER_CONFIG_DIR}/backends/<backend-name>/backend.(ts|mts|js|mjs)
```

The module must default-export a backend object whose `id` exactly matches
the directory name. Built-in names (`claude`, `codex`, `cursor`, `pi`,
`passive`) are reserved. Custom backend code is trusted local code: it is
loaded into the task-runner process without sandboxing, cached for the
process lifetime, and daemon changes require a daemon restart. Install any
custom backend dependencies under the config directory, for example
`cd ~/.config/task-runner && npm install <package>`.

Custom backends receive the resolved run `cwd` in `ctx.cwd`; native
backends are responsible for applying that cwd to any subprocess, RPC, or
SDK they call. Authored `backendConfig.<backend-name>` is backend-owned
JSON-like data, kept separate from `backendArgs.<backend-name>.extraArgs`,
and only the selected backend's resolved config is frozen into the run
manifest.

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
same daemon and is not a standalone app. The runs board supports
exact-match filters for repo, agent, backend, and run group, and run
cards expose a run-group chip that scopes the board to that group.
Scheduled runs show a compact clock indicator on cards, and the detail
drawer exposes the next run time plus enable/disable controls and
one-time schedule clearing. The dashboard also includes a dedicated
full-screen `New Run` flow at `/runs/new` that resolves the static run
input surface from the daemon before enabling `Initialize` and `Start
now`. In Chat, live runs queue submitted messages instead of starting a
resume immediately; queued messages appear in an expandable panel with
remove controls, and run cards show the queued-message count.

### Hooked assignment

```yaml
---
schemaVersion: 1
name: repo-work
hooks:
  beforeAttempt:
    - builtin: git-worktree
      when:
        sessionIndex: [0]
        attemptIndexInSession: [0]
      with:
        repo: "{{cwd}}"
        from: main
        branch: review-worktree
        path: "{{cwd}}/.worktrees/review-worktree"
    - builtin: command
      when:
        sessionIndex: [0]
        attemptIndexInSession: [0]
      with:
        mode: status
        command: bash
        args:
          ["-lc", "git fetch origin --prune && git merge --ff-only origin/main"]
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

When a run launches a descendant `task-runner` process, the child run
automatically freezes `parentRunId`. Author descendant assignments with
`sources: [parent]` for values like `worktree_path` or a validated
`worktree_base_ref` instead of manually repeating `--var` flags.

Task-completion guards that depend on spawned child runs can stay fully
declarative. For example, this blocks `peer_review` from being marked
`completed` until every direct child run reaches `success`; with
`requireAny: false`, the task may still complete if no child run exists:

```yaml
tasks:
  - id: peer_review
    title: Peer review
    hooks:
      - builtin: require-children-success
        with:
          requireAny: false
```

The same targeting also works at the assignment root with native
`taskTransition.when.taskId` / `when.taskIds` filters.

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

For Codex runs, embedded mode resolves transport from authored
`backendConfig.codex.transport`, then the current process
`TASK_RUNNER_CODEX_UDS_PATH` or `TASK_RUNNER_CODEX_WS_URL`, then stdio.
Connected mode does not forward caller-local Codex transport env vars or
arbitrary env vars; the daemon resolves Codex transport from its own
current process env after authored/request `backendConfig`.
Connected mode only synthesizes structured daemon request fields for
these caller-local inputs:

- `--parent-run <run-id>` or local `TASK_RUNNER_PARENT_RUN_ID` becomes
  request `parentRunId` for fresh `run` / `init`
- `--group-id <group-id>` or local `TASK_RUNNER_RUN_GROUP_ID` becomes
  request `runGroupId` for fresh `run` / new `init`

The Codex UDS transport shape is `{ type: "uds", path:
"/absolute/socket/path" }`; it is WebSocket-over-UDS for Codex
app-server, not raw UDS bytes. `TASK_RUNNER_CODEX_UDS_PATH` must be an
absolute socket path and `TASK_RUNNER_CODEX_WS_URL` must be an absolute
`ws://` or `wss://` URL. If both env vars are set and no higher-precedence
transport was authored or explicitly overridden, task-runner fails fast
instead of guessing. Resume reuses the frozen manifest transport. These
env vars remain Codex-specific inputs, not generic daemon env passthrough.

Named launcher lookup follows the same freeze-first model. Fresh runs
resolve and interpolate the final launcher once, store it on the manifest
and reset seed, and reuse it on resume/reset. In connected mode the daemon
is authoritative for named launcher resolution because it owns the config
root. Changing a run's group later updates `runGroupId`, but it does not
rewrite already frozen cwd, launcher, brief, or task text.
Reinitializing an existing initialized run preserves its frozen run group;
use `task-runner run set-group` or `clear-group` to mutate membership.

## Command index

| Command | Purpose |
|---------|---------|
| `run` | Execute a fresh run, promote an initialized run to ready, start a ready run, or resume |
| `init` | Prepare a run workspace without invoking the backend |
| `serve` | Start the local daemon (WS JSON-RPC + HTTP/SSE + web UI) |
| `status` | Print system/environment status |
| `run status\|brief\|audit` | Print run state, the composed worker handoff, or persisted audit history |
| `task list\|show\|set\|append-notes\|add` | Run task-state inspection and mutation |
| `attachment add\|list\|download\|remove` | Attachment management |
| `list agents\|assignments\|launchers\|tasks\|runs` | Enumerate definitions and runs |
| `show agent\|assignment\|launcher\|task` | Render a single definition |
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

- `planner`, `implementer`, `code-reviewer`, `doc-reviewer`, `test`

Assignments (under `assignments/`):

- `repo-orientation`, `test`, `plan-feature`, `plan-review`,
  `code-review`, `code-review-direct`, `doc-review`, `familiarize`

Shared task definitions (under `tasks/`):

- reusable `review/architecture` through `review/docs-drift`
  code-review dimensions used by both code-review assignments
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

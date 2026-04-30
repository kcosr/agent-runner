# CLI Reference

This is the complete `task-runner` command reference. For conceptual
context, see [concepts.md](concepts.md) and [runs.md](runs.md).

All commands accept `--help` / `-h`.

## Command index

| Command | Purpose |
|---------|---------|
| `run` | Execute a fresh run, promote an initialized run to ready, start a ready run, or resume |
| `init` | Prepare a run workspace without invoking the backend |
| `serve` | Start the local daemon / control plane |
| `status` | Print system/environment status |
| `run status\|brief\|audit` | Print run state, the composed worker handoff, or persisted audit history |
| `task list\|show\|set\|append-notes\|add` | Run task-state inspection and mutation |
| `attachment add\|list\|download\|remove` | Attachment management |
| `list agents\|assignments\|launchers\|tasks\|runs` | Enumerate definitions and runs |
| `show agent\|assignment\|launcher\|task` | Render a single definition |
| `run reset\|archive\|unarchive\|delete` | Lifecycle mutations |
| `run schedule [set]\|enable\|disable\|clear` | Schedule mutations |
| `run set-name\|set-backend-session\|clear-backend-session` | Metadata mutations |
| `run set-group\|clear-group` | Run group mutations |
| `run add-dep\|remove-dep\|clear-deps` | Dependency graph mutations |

## Global flags

| Flag | Applies to | Effect |
|------|-----------|--------|
| `--help`, `-h` | any | Print command help |
| `--connect <ws-url>` | client commands | Route command through a daemon (also `TASK_RUNNER_CONNECT`) |
| `--connect-host <host>` | connected client commands | Open an invocation-scoped SSH local forward before dialing `--connect` (also `TASK_RUNNER_CONNECT_HOST`) |
| `--connect-local-port <port>` | connected client commands | Override the loopback port used by `--connect-host` (also `TASK_RUNNER_CONNECT_LOCAL_PORT`) |
| `--output-format text\|json` | most commands | Output format (default `text`) |

Commands reject flags they do not consume — unknown flag combinations
error out rather than being silently ignored.

Reusable task definition inspection uses top-level `list tasks` and
`show task <name|path>`. Run task state remains under
`task-runner task ...`.

`--connect-host` requires connected mode via `--connect` or
`TASK_RUNNER_CONNECT`. When present, the CLI keeps the logical daemon URL
for user-facing output, but tunnels the actual WebSocket/HTTP traffic
through `127.0.0.1:<local-port>` for the lifetime of the invocation.

## `run`

Execute a run. With no subcommand it creates a fresh run, starts a ready
run (`run ready` then `run --resume-run`), or resumes an existing run.
See [resume.md](resume.md) for the rules.

```bash
task-runner run \
  [--agent <name|path>] \
  [--assignment <name|path>] \
  [--cwd <path>] \
  [--backend <id>] \
  [--launcher <name>] \
  [--model <id>] \
  [--effort <level>] \
  [--timeout-sec <n>] \
  [--max-retries <n>] \
  [--unrestricted] \
  [--name <name>] \
  [--group-id <group-id>] \
  [--var <key>=<value> ...] \
  [--add-task <title> ...] \
  [--backend-session-id <id>] \
  [--resume-run <id|path>] \
  [--detach] \
  [--message-file <path>] \
  [<message tokens...>]
```

Flags:

- `--agent <name|path>` — bare name resolved under the config dir, or a
  direct path to `agent.md`.
- `--assignment <name|path>` — same resolution as `--agent`. Optional; a
  run without an assignment is a "chat" run with no tasks.
- `--cwd <path>` — override the run cwd. Fresh-run precedence is
  `--cwd` → assignment `cwd` → caller cwd.
- `--backend <id>` — override the agent's backend. Valid ids:
  `claude`, `codex`, `cursor`, `pi`, `passive`.
- `--launcher <name>` — override the agent's launcher by named launcher
  id. Fresh-run/init only; forbidden on resume and ready-start.
  The built-in `direct` launcher is always available.
- `--model <id>` — override the agent's model.
- `--effort <level>` — one of `off`, `minimal`, `low`, `medium`, `high`,
  `xhigh`, `max`.
- `--timeout-sec <n>` — positive integer per-attempt wall-clock budget.
- `--max-retries <n>` — non-negative integer; `maxAttemptsPerSession = retries + 1`.
- `--unrestricted` — pass the backend's safety-bypass flag.
- `--name <name>` — set the persisted display name.
- `--group-id <group-id>` — set the explicit run group for a fresh run.
  Forbidden on resume and ready-start.
- `--var <key>=<value>` — repeatable. Split on the first `=`. Forbidden
  on resume.
  Descendant runs usually should prefer assignment `sources: [parent]`
  over manually re-passing inherited vars.
- `--add-task <title>` — repeatable. Append a task to the run's list.
  Allowed on resume (non-passive runs); forbidden on ready-start.
- `--backend-session-id <id>` — bootstrap-import an existing backend
  session. Forbidden on resume.
- `--resume-run <id|path>` — continue an existing run. Many flags are
  forbidden in combination with this; see [resume.md](resume.md).
- `--detach` — daemon mode only; dispatch the run and exit after the
  daemon accepts it.
- `--message-file <path>` — read UTF-8 message text from a file instead
  of positional message text.

Positional args are joined with spaces into the message body.
`--message-file` cannot be combined with positional message text.

A run is the durable lifecycle record. Each backend execution window is a
session: the fresh execution creates session `0`, and each resume creates
the next session. Attempts are backend invocations within a session.
`maxAttemptsPerSession` is the per-session retry budget. Attempt numbers
are monotonic across the run, while `attemptIndexInSession` is zero-based
within its session.

Assignment task refs follow the same explicit loader model:

- bare strings are named task refs under `${TASK_RUNNER_CONFIG_DIR}/tasks`
- only absolute paths and strings beginning with `./` or `../` are path
  refs
- slashful ids such as `review/reuse` are named refs, not implicit paths
- bundled assignments that need shared review tasks use named refs such
  as `review/architecture`

## `init`

Same inputs as `run` (except no `--detach`, `--max-retries`,
`--timeout-sec`), but the backend is never invoked. Used for passive
runs or to inspect a run before executing it.

```bash
task-runner init \
  --agent <name|path> \
  --assignment <name|path> \
  [--cwd <path>] [--backend <id>] [--model <id>] [--effort <level>] \
  [--unrestricted] [--name <name>] [--group-id <group-id>] [--var key=value ...] \
  [--add-task <title> ...] [--backend-session-id <id>] \
  [--schedule-at <iso> | --schedule-delay <duration> | --schedule-cron <expr>] \
  [--schedule-timezone <iana>] [--schedule-mode reuse|reset|clone] \
  [--schedule-continue-on-failure] \
  [--message-file <path>] \
  [<message tokens...>]
```

`init` does not dump the worker brief to stdout — fetch it with
`task-runner run brief <run-id>`.

Launcher precedence on fresh run/init is:

1. `--launcher <name>`
2. agent-authored `launcher`
3. built-in `direct`

In connected mode the daemon resolves named launchers against its own
config root, then freezes the result into the manifest and reset seed.
Launchers apply to subprocess-backed execution only; passive runs and
Codex websocket/UDS transports keep the built-in `direct` launcher.

Schedule flags are accepted on `init` and `run ready`. Exactly one of
`--schedule-at`, `--schedule-delay`, or `--schedule-cron` is required
when scheduling. `--schedule-timezone`, `--schedule-mode`, and
`--schedule-continue-on-failure` are cron-only. Schedule flags are
rejected on fresh `run`, `run --resume-run`, and ready-start execution.

## `serve`

Start the daemon. Hosts WebSocket JSON-RPC, HTTP, and the bundled web UI.

```bash
task-runner serve [--listen <ws-url>]
```

- `--listen <ws-url>` — defaults to `ws://127.0.0.1:4773/` (or
  `TASK_RUNNER_LISTEN`).
- Rejects `--connect`, `--connect-host`, and `--connect-local-port`.

Set `TASK_RUNNER_DAEMON_AUTH_ENABLED=true` and
`TASK_RUNNER_DAEMON_TOKEN=<token>` in the daemon environment to require a
shared bearer token for daemon `/api/*` and WebSocket access. This is
daemon access protection only; anyone with the token has full daemon
access.

See [daemon.md](daemon.md).

## `status`

Print the current task-runner system/environment context for this
invocation.

```bash
task-runner status [--output-format text|json]
```

- Takes no positional arguments.
- Text output prints the resolved config dir, state dir, host mode,
  connect URL, and daemon connectivity state.
- JSON output returns `{ configDir, stateDir, hostMode, connectUrl, daemon }`.
- `--field` is not supported.

## `run status <run-id>`

Print the run's current state.

```bash
task-runner run status <run-id> [--output-format json] [--field <name> ...]
```

- Run-id-only. Paths are not accepted.
- `--output-format json` returns the shared `RunDetail` DTO.
- `--field <name>` — repeatable. Projects top-level JSON fields.
- JSON detail includes `parentRunId` when the run belongs to a lineage
  and always includes `runGroupId`.
- JSON detail includes `note`, `pinned`, persisted `schedule`, and
  derived `scheduleState`.
- Text output may show `Pinned: yes` and `Note: present`, but it never
  prints the note markdown body. It prints `Schedule: none` or the
  formatted schedule plus derived state.

## `run brief <run-id>`

Print the composed worker handoff for a run. Text-only — does not support
`--output-format` or `--field`. Run-id-only.

```bash
task-runner run brief <run-id>
```

## `run audit <run-id>`

Print the persisted audit history for a run. Text is the default output;
JSON returns the shared `RunAuditHistory` DTO.

```bash
task-runner run audit <run-id> [--output-format text|json] [--limit <n>]
```

- Run-id-only. Paths are not accepted.
- `--output-format text|json` — defaults to `text`.
- `--limit <n>` — optional positive integer; keeps only the newest `n`
  audit envelopes after history load.
- Text output is deterministic chronological rendering from the raw audit
  envelopes. Unknown event types fall back to raw field rendering instead
  of failing.
- JSON output returns `{ runId, events, lastCursor }`.
- Exit codes:
  - `0` success
  - `1` usage / validation error
  - `2` run not found
  - `3` daemon / transport / other runtime error

## `task`

Canonical task state commands. All subcommands accept `--connect` and
`--output-format`.

```bash
task-runner task list <run-id>
task-runner task show <run-id> <task-id>

task-runner task set <run-id> <task-id> \
  [--status pending|in_progress|completed|blocked] \
  [--notes <text>]

task-runner task append-notes <run-id> <task-id> --text <text>

task-runner task add <run-id> --title <title> [--body <body>]
```

Mutation rules depend on run state and backend type; see
[tasks.md](tasks.md).

## `attachment`

```bash
task-runner attachment add <run-id|path> <source-file> \
  [--name <text>] [--mime-type <type>]

task-runner attachment list <run-id|path> [--scope run|group]

task-runner attachment download <run-id|path> <attachment-id> <output-path>

task-runner attachment remove <run-id|path> <attachment-id>
```

All attachment subcommands accept connected mode through the global
`--connect <ws-url>` flag. In connected mode, add and download transfer
bytes over the existing daemon WebSocket stream notifications, while list
and remove use WebSocket JSON-RPC. The daemon HTTP attachment endpoints
remain available for browser/API callers.

See [attachments.md](attachments.md).

## `list`

```bash
task-runner list agents
task-runner list assignments
task-runner list launchers
task-runner list tasks
task-runner list runs \
  [--cwd <path> | --repo <name> | --global] \
  [--group-id <group-id>] \
  [--include-archived]
```

- `list agents`, `list assignments`, `list launchers`, and `list tasks`
  enumerate reusable definitions from `${TASK_RUNNER_CONFIG_DIR}`.
- `list tasks` lists markdown task definition files under
  `${TASK_RUNNER_CONFIG_DIR}/tasks`; invalid task definitions are warned
  to stderr in text mode and included in the JSON payload's `warnings`
  array in JSON mode.
- `list runs` defaults to the caller's exact cwd.
- `--cwd <path>` filters by exact persisted cwd.
- `--repo <name>` filters by repo bucket.
- `--global` disables cwd scoping.
- `--group-id <group-id>` filters by exact run group and is mutually
  exclusive with `--cwd`, `--repo`, and `--global`.
- `--include-archived` adds archived runs.

## `show`

```bash
task-runner show agent <name|path>
task-runner show assignment <name|path>
task-runner show launcher <name|path>
task-runner show task <name|path>
```

Renders the parsed frontmatter, declared vars (for assignments), task
lists, launcher definitions, or reusable task definition title/body/hooks.
For `show task`, bare strings are named ids under
`${TASK_RUNNER_CONFIG_DIR}/tasks`; absolute paths and strings beginning
with `./` or `../` are direct markdown file paths.

## `run` groupings

### Lifecycle

```bash
task-runner run reconfigure <id> [--var key=value ...] [--message-file <path> | <message...>]
task-runner run ready    <id|path> [--schedule-at <iso> | --schedule-delay <duration> | --schedule-cron <expr>]
task-runner run reset     <id|path>
task-runner run archive   <id|path>
task-runner run unarchive <id|path>
task-runner run delete    <id|path>    # archived only
```

`run ready` can attach or replace the run's schedule during the
initialized-to-ready transition. A scheduled run remains in `ready`
until the daemon observes it as due, but a caller can still start it
manually with `run --resume-run <id|path>`.

`run reconfigure` is only valid for unarchived initialized runs. It
patches runtime vars and/or the initial message, then rerenders the
brief and reset seed as one atomic mutation. If var validation, required
inputs, locked fields, or prepare/rendering fail, the existing manifest
is left unchanged. Reconfigure does not support identity/runtime
changes: agent, assignment, backend, cwd, tasks, schedule, launcher,
hooks, and backend-specific Codex transport remain the frozen values
from the initialized run.

Exit codes are `0` for success, `2` when the run id is not found, `3`
for invalid input/lifecycle/var/lock/prepare failures, and `4` for
unexpected runtime errors.

### Schedule

```bash
task-runner run schedule <id|path> --at <iso>
task-runner run schedule <id|path> --delay <duration>
task-runner run schedule <id|path> --cron <expr> \
  [--timezone <iana>] [--mode reuse|reset|clone] [--continue-on-failure]
task-runner run schedule enable <id|path>
task-runner run schedule disable <id|path>
task-runner run schedule clear <id|path>
```

The default `run schedule` action is `set`; `run schedule set <id|path>
...` is also accepted. Set requires exactly one of `--at`, `--delay`, or
`--cron`. `--timezone`, `--mode`, and `--continue-on-failure` are valid
only with `--cron`. `clear` removes one-time schedules only; recurring
schedules must be disabled.

One-time schedules stay subject to `TASK_RUNNER_MIN_SCHEDULE_DELAY_SEC`.
Recurring schedules are validated with `TASK_RUNNER_MIN_RECURRENCE_INTERVAL_SEC`
and can run in `reuse`, `reset`, or `clone` mode.

### Metadata

```bash
task-runner run set-name <id|path> <name>
task-runner run set-name <id|path> --clear
task-runner run set-note <id|path> <markdown>
task-runner run clear-note <id|path>
task-runner run pin <id|path>
task-runner run unpin <id|path>
task-runner run set-group <id|path> <group-id>
task-runner run clear-group <id|path>
task-runner run set-backend-session   <id|path> <session-id>   # passive only
task-runner run clear-backend-session <id|path>                # passive only
```

- `run set-note` trims only for empty/whitespace detection; a
  whitespace-only value clears the note.
- `run clear-note` clears the note without a second positional.
- `run pin` / `run unpin` toggle persisted pin metadata without moving a
  run across status columns.
- `run set-group` and `run clear-group` apply to non-running runs. A
  cleared group becomes the run's singleton group (`runGroupId === runId`).
- Metadata mutations accept `--output-format text|json` and `--connect`.
- Note text is never echoed back in text output; use JSON or the web UI
  to inspect the full stored note.

### Dependencies

```bash
task-runner run add-dep    <id> --run <dependency-run-id>
task-runner run add-dep    <id> --group <group-id>
task-runner run remove-dep <id> --run <dependency-run-id>
task-runner run remove-dep <id> --group <group-id>
task-runner run clear-deps <id>
```

Dependency mutations are only allowed on `initialized` runs and require a
typed ref for add/remove: exactly one of `--run` or `--group`. See
[dependencies.md](dependencies.md).

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

Recognized by the CLI:

- `TASK_RUNNER_CONFIG_DIR`, `TASK_RUNNER_STATE_DIR`
- `TASK_RUNNER_LISTEN`, `TASK_RUNNER_CONNECT`
- `TASK_RUNNER_PARENT_RUN_ID`, `TASK_RUNNER_RUN_GROUP_ID`
- `TASK_RUNNER_CLAUDE_BIN`, `TASK_RUNNER_CODEX_BIN`,
  `TASK_RUNNER_CODEX_UDS_PATH`, `TASK_RUNNER_CODEX_WS_URL`,
  `TASK_RUNNER_CURSOR_BIN`, `TASK_RUNNER_PI_BIN`, `PI_HOME`
- `TASK_RUNNER_MIN_SCHEDULE_DELAY_SEC`,
  `TASK_RUNNER_MIN_RECURRENCE_INTERVAL_SEC`
- `TASK_RUNNER_CALL_DEPTH`, `TASK_RUNNER_MAX_CALL_DEPTH`
- `TASK_RUNNER_DAEMON_AUTH_ENABLED`, `TASK_RUNNER_DAEMON_TOKEN`

See [configuration.md](configuration.md).

## Daemon vs embedded

Every client command (except `serve`) can run embedded (no daemon) or
route through a daemon with `--connect <ws-url>` or
`TASK_RUNNER_CONNECT`. Daemon-routed commands use the same WebSocket
JSON-RPC surface that the web dashboard uses.

When connecting to an auth-enabled daemon, set `TASK_RUNNER_DAEMON_TOKEN`
in the client environment. Connected CLI requests trim that value and send
`Authorization: Bearer <token>` on WebSocket handshakes and direct daemon
HTTP helper requests. Empty or unset client tokens omit Authorization and
will be rejected by auth-enabled daemons.

The token is not a transport security layer. For remote daemons, use
`--connect-host` SSH forwarding, HTTPS, WireGuard, Tailscale, a VPN, or an
equivalent secure channel, and keep tokens and Authorization headers out
of logs. The MVP does not provide per-user isolation.

`run --detach` is daemon-only: the CLI dispatches the run and exits
after the daemon accepts it.

# CLI Reference

This is the complete `task-runner` command reference. For conceptual
context, see [concepts.md](concepts.md) and [runs.md](runs.md).

All commands accept `--help` / `-h`.

## Command index

| Command | Purpose |
|---------|---------|
| `run` | Execute a fresh run, resume an existing run, or execute-after-init |
| `init` | Prepare a run workspace without invoking the backend |
| `serve` | Start the local daemon / control plane |
| `status <run-id>` | Print the run's current state |
| `brief <run-id>` | Print the composed worker handoff |
| `task list\|show\|set\|append-notes\|add` | Task state inspection and mutation |
| `attachment add\|list\|download\|remove` | Attachment management |
| `list agents\|assignments\|runs` | Enumerate definitions and runs |
| `show agent\|assignment` | Render a single definition |
| `run reset\|archive\|unarchive\|delete` | Lifecycle mutations |
| `run set-name\|set-backend-session\|clear-backend-session` | Metadata mutations |
| `run add-dep\|remove-dep\|clear-deps` | Dependency graph mutations |

## Global flags

| Flag | Applies to | Effect |
|------|-----------|--------|
| `--help`, `-h` | any | Print command help |
| `--connect <ws-url>` | client commands | Route command through a daemon (also `TASK_RUNNER_CONNECT`) |
| `--output-format text\|json` | most commands | Output format (default `text`) |

Commands reject flags they do not consume — unknown flag combinations
error out rather than being silently ignored.

## `run`

Execute a run. With no subcommand it creates a fresh run, resumes an
existing run (`--resume-run`), or executes an initialized run
(`--resume-run`). See [resume.md](resume.md) for the rules.

```bash
task-runner run \
  [--agent <name|path>] \
  [--assignment <name|path>] \
  [--cwd <path>] \
  [--backend <id>] \
  [--model <id>] \
  [--effort <level>] \
  [--timeout-sec <n>] \
  [--max-retries <n>] \
  [--unrestricted] \
  [--name <name>] \
  [--var <key>=<value> ...] \
  [--add-task <title> ...] \
  [--backend-session-id <id>] \
  [--resume-run <id|path>] \
  [--detach] \
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
- `--model <id>` — override the agent's model.
- `--effort <level>` — one of `off`, `minimal`, `low`, `medium`, `high`,
  `xhigh`, `max`.
- `--timeout-sec <n>` — positive integer per-attempt wall-clock budget.
- `--max-retries <n>` — non-negative integer; `maxAttempts = retries + 1`.
- `--unrestricted` — pass the backend's safety-bypass flag.
- `--name <name>` — set the persisted display name.
- `--var <key>=<value>` — repeatable. Split on the first `=`. Forbidden
  on resume.
- `--add-task <title>` — repeatable. Append a task to the run's list.
  Allowed on resume (non-passive runs); forbidden on execute-after-init.
- `--backend-session-id <id>` — bootstrap-import an existing backend
  session. Forbidden on resume.
- `--resume-run <id|path>` — continue an existing run. Many flags are
  forbidden in combination with this; see [resume.md](resume.md).
- `--detach` — daemon mode only; dispatch the run and exit after the
  daemon accepts it.

Positional args are joined with spaces into the message body.

## `init`

Same inputs as `run` (except no `--detach`, `--max-retries`,
`--timeout-sec`), but the backend is never invoked. Used for passive
runs or to inspect a run before executing it.

```bash
task-runner init \
  --agent <name|path> \
  --assignment <name|path> \
  [--cwd <path>] [--backend <id>] [--model <id>] [--effort <level>] \
  [--unrestricted] [--name <name>] [--var key=value ...] \
  [--add-task <title> ...] [--backend-session-id <id>] \
  [<message tokens...>]
```

`init` does not dump the worker brief to stdout — fetch it with
`task-runner brief <run-id>`.

## `serve`

Start the daemon. Hosts WebSocket JSON-RPC, HTTP, and the bundled web UI.

```bash
task-runner serve [--listen <ws-url>]
```

- `--listen <ws-url>` — defaults to `ws://127.0.0.1:4773/` (or
  `TASK_RUNNER_LISTEN`).
- Rejects `--connect`.

See [daemon.md](daemon.md).

## `status <run-id>`

Print the run's current state.

```bash
task-runner status <run-id> [--output-format json] [--field <name> ...]
```

- Run-id-only. Paths are not accepted.
- `--output-format json` returns the shared `RunDetail` DTO.
- `--field <name>` — repeatable. Projects top-level JSON fields.

## `brief <run-id>`

Print the composed worker handoff for a run. Text-only — does not support
`--output-format` or `--field`. Run-id-only.

```bash
task-runner brief <run-id>
```

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

task-runner attachment list <run-id|path> [--cwd-scope]

task-runner attachment download <run-id|path> <attachment-id> <output-path>

task-runner attachment remove <run-id|path> <attachment-id>
```

See [attachments.md](attachments.md).

## `list`

```bash
task-runner list agents
task-runner list assignments
task-runner list runs \
  [--cwd <path> | --repo <name> | --global] \
  [--include-archived]
```

- `list runs` defaults to the caller's exact cwd.
- `--cwd <path>` filters by exact persisted cwd.
- `--repo <name>` filters by repo bucket.
- `--global` disables cwd scoping.
- `--include-archived` adds archived runs.

## `show`

```bash
task-runner show agent <name|path>
task-runner show assignment <name|path>
```

Renders the parsed frontmatter, declared vars (for assignments), and
task list.

## `run` groupings

### Lifecycle

```bash
task-runner run reset     <id|path>
task-runner run archive   <id|path>
task-runner run unarchive <id|path>
task-runner run delete    <id|path>    # archived only
```

### Metadata

```bash
task-runner run set-name <id|path> <name>
task-runner run set-name <id|path> --clear
task-runner run set-backend-session   <id|path> <session-id>   # passive only
task-runner run clear-backend-session <id|path>                # passive only
```

### Dependencies

```bash
task-runner run add-dep    <id> <dependency-run-id>
task-runner run remove-dep <id> <dependency-run-id>
task-runner run clear-deps <id>
```

Dependency mutations are only allowed on `initialized` runs. See
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
- `TASK_RUNNER_CLAUDE_BIN`, `TASK_RUNNER_CODEX_BIN`,
  `TASK_RUNNER_CODEX_WS_URL`, `TASK_RUNNER_CURSOR_BIN`,
  `TASK_RUNNER_PI_BIN`, `PI_HOME`
- `TASK_RUNNER_CALL_DEPTH`, `TASK_RUNNER_MAX_CALL_DEPTH`

See [configuration.md](configuration.md).

## Daemon vs embedded

Every client command (except `serve`) can run embedded (no daemon) or
route through a daemon with `--connect <ws-url>` or
`TASK_RUNNER_CONNECT`. Daemon-routed commands use the same WebSocket
JSON-RPC surface that the web dashboard uses.

`run --detach` is daemon-only: the CLI dispatches the run and exits
after the daemon accepts it.

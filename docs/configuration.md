# Configuration

task-runner is configured through environment variables and on-disk
definition directories. There is no single settings file — configuration
is keyed off XDG-aware roots and per-backend env vars.

## State and config roots

### Config directory

```
TASK_RUNNER_CONFIG_DIR (if set)
  ↓
${XDG_CONFIG_HOME}/task-runner
  ↓
~/.config/task-runner
```

Contains named agent and assignment definitions:

```text
${TASK_RUNNER_CONFIG_DIR}/
├── agents/<agent-name>/agent.md
├── launchers/<launcher-name>.yaml
├── hooks/<hook-name>/hook.(ts|mts|js|mjs)
└── assignments/<assignment-name>/
    ├── assignment.md
    └── hooks/
```

See [agents-and-assignments.md](agents-and-assignments.md).

### State directory

```
TASK_RUNNER_STATE_DIR (if set)
  ↓
${XDG_STATE_HOME}/task-runner
  ↓
~/.local/state/task-runner
```

Contains persistent run state:

```text
${TASK_RUNNER_STATE_DIR}/
└── runs/<repo>/<run-id>/
    ├── run.json
    ├── assignment-seed.md
    ├── attempts/
    └── attachments/
```

Repo buckets are derived from the enclosing git common dir; runs that
cannot find a git dir fall into an `unknown` bucket.

## Environment variables

### Paths

| Variable | Effect |
|----------|--------|
| `TASK_RUNNER_CONFIG_DIR` | Override config dir |
| `TASK_RUNNER_STATE_DIR` | Override state dir |
| `XDG_CONFIG_HOME` | Standard XDG config root |
| `XDG_STATE_HOME` | Standard XDG state root |
| `HOME` | Home directory (affects `~` expansion) |

### Daemon

| Variable | Effect |
|----------|--------|
| `TASK_RUNNER_LISTEN` | Listen URL for `task-runner serve` (default `ws://127.0.0.1:4773/`) |
| `TASK_RUNNER_CONNECT` | WebSocket URL the CLI should connect to instead of executing embedded |
| `TASK_RUNNER_CONNECT_HOST` | SSH host the CLI should tunnel through before dialing `TASK_RUNNER_CONNECT` / `--connect` |
| `TASK_RUNNER_CONNECT_LOCAL_PORT` | Loopback port to bind for `TASK_RUNNER_CONNECT_HOST`; defaults to the daemon port from `TASK_RUNNER_CONNECT` / `--connect` |

Both can be overridden on the CLI via `--listen` (on `serve`) and
`--connect` (on client commands). SSH-assisted connected mode uses
`--connect-host` and `--connect-local-port`. See [daemon.md](daemon.md).

### Backends

| Variable | Effect |
|----------|--------|
| `TASK_RUNNER_CLAUDE_BIN` | Claude CLI binary (default `claude`) |
| `TASK_RUNNER_CODEX_BIN` | Codex stdio binary (default `codex`) |
| `TASK_RUNNER_CODEX_WS_URL` | Fresh Codex runs use this websocket URL when no explicit `backendSpecific.codex.transport` was authored; daemon-connected CLI calls forward it only as a Codex-specific structured override |
| `TASK_RUNNER_CURSOR_BIN` | Cursor CLI binary (default `cursor-agent`) |
| `TASK_RUNNER_FULL_ATTEMPT_LOGS` | Keep full stdout in per-attempt log records instead of the default compact stderr/metadata-only capture |
| `TASK_RUNNER_PI_BIN` | Pi CLI binary (default `pi`) |
| `PI_HOME` | Pi session storage root (default `~/.pi`) |

See [backends.md](backends.md).

`TASK_RUNNER_CODEX_WS_URL` is not a generic daemon env passthrough knob.
Only Codex reads it, and only during fresh-run transport resolution.
Malformed values are rejected unless they are absolute `ws://` or
`wss://` URLs.

`TASK_RUNNER_FULL_ATTEMPT_LOGS` is an opt-in local debugging knob. When
unset, per-attempt records keep stderr and structured metadata but omit
captured stdout to reduce noisy manifest-side log output.

### Recursion guard

| Variable | Effect |
|----------|--------|
| `TASK_RUNNER_CALL_DEPTH` | Current recursion depth; set automatically by task-runner when it invokes itself from a worker |
| `TASK_RUNNER_MAX_CALL_DEPTH` | Hard cap on recursion depth (default `1`) |

A user-initiated invocation starts at depth 0. If a worker invokes
`task-runner` via its backend, the child starts at depth 1. Any
invocation where the current depth would exceed
`TASK_RUNNER_MAX_CALL_DEPTH` is rejected with a `RecursionDepthError`.
Raise the cap only when deliberate nesting is required.

## Variable-sourced env

Assignment variables with `source: env` (or `either`) read from an env
var named by the var's `envName` (or the var key itself). See
[variables.md](variables.md). These values are redacted in the manifest's
`runtimeVars`.

## Manifest upgrades

The current manifest schema is version `10`. Older manifests are not
silently upgraded at runtime — resuming a run with an older schema fails
with a clear error. The repo ships migration scripts under `scripts/`:

- `scripts/migrate-manifests-v6.mjs` — v5 → v6 (adds `attachments: []`)
- `scripts/migrate-manifests-v7.mjs` — v6 → v7 (converts
  `pendingPrompt` / `taskMode` into persisted `brief`)
- `scripts/migrate-manifests-v8.mjs` — v7 → v8 (backfills persisted
  `repo` from the frozen `cwd`; supports repeated `--repo <name>`
  filters for selective upgrades, and a `--root <path>` flag for
  legacy state roots)
- `scripts/migrate-manifests-v9.mjs` — v8 → v9 (adds frozen hook
  descriptor/state/audit surfaces with empty defaults for pre-hook runs,
  repairs `assignment-seed.md` workspace paths, and backfills the full
  frozen `resetSeed` shape expected by current resume/discovery;
  supports repeated `--repo <name>` filters and `--root <path>`)

Schema v10 adds frozen launcher state on both `manifest.launcher` and
`manifest.resetSeed.launcher`. Resume and reset use that frozen value
instead of re-resolving current launcher files or daemon/client
overrides.

Run the scripts explicitly; or recreate affected runs if an upgrade
path isn't important. New runs are always created at the latest
schema version.

## Git environment isolation

When task-runner probes a cwd to derive the repo bucket, it clears all
`GIT_*` environment variables to avoid interference from hook-exported
vars. User-initiated git operations you run outside task-runner are
unaffected.

## Inspecting effective configuration

- `task-runner list agents` / `list assignments` print the resolved
  config dir contents.
- `task-runner list runs [--cwd <path> | --repo <name> | --global]`
  prints the resolved state dir contents.
- `task-runner run status <run-id> --output-format json` exposes the
  `runtimeVars`, `lockedFields`, and per-run environment snapshot.

## Typical host setup

```bash
# XDG defaults are usually fine; override only if needed.
export TASK_RUNNER_CLAUDE_BIN=/opt/claude/bin/claude
export TASK_RUNNER_PI_BIN=/opt/pi/bin/pi

# Local daemon mode for shared state across terminals.
export TASK_RUNNER_CONNECT=ws://127.0.0.1:4773/

# Optional instead: reach a remote daemon through an invocation-scoped SSH forward.
# Replace the local TASK_RUNNER_CONNECT above with the remote daemon URL when using this mode.
# export TASK_RUNNER_CONNECT=ws://task-runner.remote.example:4773/
export TASK_RUNNER_CONNECT_HOST=prod-box
# export TASK_RUNNER_CONNECT_LOCAL_PORT=5773
```

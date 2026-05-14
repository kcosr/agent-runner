# Configuration

agent-runner is configured through environment variables and on-disk
definition directories. There is no single settings file — configuration
is keyed off XDG-aware roots and per-backend env vars.

## State and config roots

### Migrating Renamed Local Data

Agent Runner does not read the former TaskRunner env vars, package names,
headers, template variables, or default roots as aliases. To inspect existing
local data before switching shells and services over, run:

```sh
node scripts/migrate-task-runner-to-agent-runner.mjs
```

The migration is dry-run by default. After reviewing the planned root moves,
path rewrites, content rewrites, and shell rc env export rewrites, apply it
explicitly:

```sh
node scripts/migrate-task-runner-to-agent-runner.mjs --write
```

Use `--home`, `--state-root`, `--target-state-root`, `--config-root`,
`--target-config-root`, `--bashrc`, or `--skip-bashrc` to target a staged
fixture or to split state/config migration from shell environment updates.

### Config directory

```
AGENT_RUNNER_CONFIG_DIR (if set)
  ↓
${XDG_CONFIG_HOME}/agent-runner
  ↓
~/.config/agent-runner
```

Contains named agent and assignment definitions:

```text
${AGENT_RUNNER_CONFIG_DIR}/
├── agents/<agent-name>/agent.md
├── tasks/<task-id>.md
├── launchers/<launcher-name>.yaml
├── environments/<environment-name>.yaml
├── hooks/<hook-name>/hook.(ts|mts|js|mjs)
└── assignments/<assignment-name>/
    ├── assignment.md
    └── hooks/
```

See [agents-and-assignments.md](agents-and-assignments.md).

Environment definitions under `environments/*.yaml|*.yml` describe
Docker/Podman execution environments for subprocess-backed runs. Agents
select them with `executionEnvironment`, and fresh callers may override
with `--environment`. Managed environments can define a first-class
workspace mount with run or group scope; after that workspace resolves,
`workspace_host_path` and `workspace_container_path` are available to
environment interpolation. Environment definitions can declare `vars`
using the same schema as assignments; selected environment vars are
merged into the run var schema before interpolation. They can also define
`sessionMounts` presets for same-path backend session-store mounts used
by session sync.

Assignment `tasks:` entries may mix inline objects, named task refs such
as `review/reuse`, and explicit path refs. Bare strings resolve only
from `${AGENT_RUNNER_CONFIG_DIR}/tasks`; strings are treated as paths
only when they are absolute or begin with `./` or `../`.
The bundled repo also ships shared review task definitions under
`tasks/review/`, planning task definitions under `tasks/feature-plan/`,
and implementation task definitions under `tasks/feature-implement/`.
Bundled assignments reference those files with named refs such as
`review/architecture`, `feature-plan/orient`, and
`feature-implement/check-gate`, resolved from
`${AGENT_RUNNER_CONFIG_DIR}/tasks`. Some files in those directories are
currently reused by multiple bundled assignments, while others are
named refs owned by a single bundled workflow. If you copy bundled
assignments into another config directory, copy the referenced task
directories with them so those named refs continue to resolve.

### State directory

```
AGENT_RUNNER_STATE_DIR (if set)
  ↓
${XDG_STATE_HOME}/agent-runner
  ↓
~/.local/state/agent-runner
```

Contains persistent run state:

```text
${AGENT_RUNNER_STATE_DIR}/
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
| `AGENT_RUNNER_CONFIG_DIR` | Override config dir |
| `AGENT_RUNNER_STATE_DIR` | Override state dir |
| `XDG_CONFIG_HOME` | Standard XDG config root |
| `XDG_STATE_HOME` | Standard XDG state root |
| `HOME` | Home directory (affects `~` expansion) |

### Daemon

| Variable | Effect |
|----------|--------|
| `AGENT_RUNNER_LISTEN` | Listen URL for `agent-runner serve` (default `ws://127.0.0.1:4773/`) |
| `AGENT_RUNNER_CONNECT` | WebSocket URL the CLI should connect to instead of executing embedded |
| `AGENT_RUNNER_CONNECT_HOST` | SSH host the CLI should tunnel through before dialing `AGENT_RUNNER_CONNECT` / `--connect` |
| `AGENT_RUNNER_CONNECT_LOCAL_PORT` | Loopback port to bind for `AGENT_RUNNER_CONNECT_HOST`; defaults to the daemon port from `AGENT_RUNNER_CONNECT` / `--connect` |
| `AGENT_RUNNER_DAEMON_AUTH_ENABLED` | Enable shared bearer-token daemon access protection when set to `true`, `1`, `yes`, or `on` |
| `AGENT_RUNNER_DAEMON_TOKEN` | Server token required when daemon auth is enabled; connected CLI clients also read it and send `Authorization: Bearer <token>` |
| `AGENT_RUNNER_DAEMON_FILESYSTEM_LOCKS` | Set to `true` to make daemon projection refreshes wait on task-state filesystem locks; by default daemon projections skip those locks to avoid stale-lock stalls |

Listen and connect URLs can be overridden on the CLI via `--listen` (on
`serve`) and `--connect` (on client commands). SSH-assisted connected
mode uses `--connect-host` and `--connect-local-port`. See
[daemon.md](daemon.md).

Daemon auth is a single shared-token control-plane guard. It protects
`/api/*`, SSE, and WebSocket JSON-RPC access, but it is not multi-user
isolation. Anyone with `AGENT_RUNNER_DAEMON_TOKEN` has full daemon access.
Keep the token and Authorization headers out of logs. For non-loopback or
remote access, use SSH tunnels, HTTPS, WireGuard, Tailscale, a VPN, or an
equivalent secure transport; the bearer token itself does not encrypt
traffic.

### Scheduling

| Variable | Effect |
|----------|--------|
| `AGENT_RUNNER_MIN_SCHEDULE_DELAY_SEC` | Minimum allowed one-time schedule delay in seconds (default `300`) |
| `AGENT_RUNNER_MIN_RECURRENCE_INTERVAL_SEC` | Minimum observed interval allowed for recurring schedules in seconds (default `300`) |

### Backends

| Variable | Effect |
|----------|--------|
| `AGENT_RUNNER_CLAUDE_BIN` | Claude CLI binary (default `claude`) |
| `AGENT_RUNNER_CODEX_BIN` | Codex stdio binary (default `codex`) |
| `AGENT_RUNNER_CODEX_UDS_PATH` | Fresh Codex runs use this absolute socket path for WebSocket-over-UDS when no explicit `backendConfig.codex.transport` was authored |
| `AGENT_RUNNER_CODEX_WS_URL` | Fresh Codex runs use this websocket URL when no explicit `backendConfig.codex.transport` was authored |
| `AGENT_RUNNER_CURSOR_BIN` | Cursor CLI binary (default `cursor-agent`) |
| `AGENT_RUNNER_OPENCODE_BIN` | OpenCode CLI binary (default `opencode`) |
| `AGENT_RUNNER_OPENCODE_DATA_DIR` | OpenCode data directory for session-history validation/sync; falls back to `OPENCODE_DATA_DIR`, then `${XDG_DATA_HOME:-~/.local/share}/opencode` |
| `AGENT_RUNNER_CAPTURE_BACKEND_STDOUT` | Write raw backend stdout sidecars to `attempts/NN.stdout.log` for local debugging |
| `AGENT_RUNNER_BACKEND_SESSION_SYNC` | Set to `false`, `0`, `no`, or `off` to disable backend-owned session history import, pre-resume sync, and daemon subscribed-run polling |
| `AGENT_RUNNER_PI_BIN` | Pi CLI binary (default `pi`) |
| `PI_HOME` | Pi session storage root (default `~/.pi`) |

See [backends.md](backends.md).

Custom backend modules are configuration-root source files under
`${AGENT_RUNNER_CONFIG_DIR}/backends/<backend-name>/backend.(ts|mts|js|mjs)`.
They are trusted local code loaded without sandboxing. The daemon loads
them at startup and caches them for its process lifetime, so backend code
or dependency changes require a daemon restart. Install custom backend
dependencies from the config directory so normal Node/jiti resolution can
find them.

`AGENT_RUNNER_CODEX_UDS_PATH` and `AGENT_RUNNER_CODEX_WS_URL` are not
generic daemon env passthrough knobs. Only Codex reads them, and only
during fresh-run transport resolution by the process that owns the run.
Connected CLI calls do not forward caller-local Codex transport env; the
daemon resolves from its own env after authored/request `backendConfig`.
Resume reuses the frozen manifest transport. Malformed UDS values are
rejected unless they are absolute socket paths; malformed websocket values
are rejected unless they are absolute `ws://` or `wss://` URLs. If both
env vars are set and no higher-precedence transport is authored or
explicitly overridden, Agent Runner fails fast instead of guessing.

The authored Codex transport union is exactly `{ type: "stdio" }`,
`{ type: "ws", url: "<absolute ws:// or wss:// URL>" }`, or
`{ type: "uds", path: "/absolute/socket/path" }`. UDS uses the Codex
app-server WebSocket protocol over the Unix-domain socket rather than raw
UDS bytes.

`AGENT_RUNNER_CAPTURE_BACKEND_STDOUT=1` is an opt-in local debugging
knob. It writes raw backend stdout to `attempts/NN.stdout.log` sidecars
as Agent Runner observes it. Sidecars are local debug artifacts: Agent
Runner does not read them for timeline, history, API, daemon, or web
surfaces. Attempt JSON schemaVersion 3 omits stdout; stderr remains in
`attempts/NN.json` because timeline and history project it as attempt notices. The removed
`AGENT_RUNNER_FULL_ATTEMPT_LOGS` variable no longer enables capture.

### Recursion guard

| Variable | Effect |
|----------|--------|
| `AGENT_RUNNER_CALL_DEPTH` | Current recursion depth; set automatically by agent-runner when it invokes itself from a worker |
| `AGENT_RUNNER_MAX_CALL_DEPTH` | Hard cap on recursion depth (default `1`) |
| `AGENT_RUNNER_PARENT_RUN_ID` | Current parent run id for nested launches; set automatically for child `agent-runner` invocations |

A user-initiated invocation starts at depth 0. If a worker invokes
`agent-runner` via its backend, the child starts at depth 1. Any
invocation where the current depth would exceed
`AGENT_RUNNER_MAX_CALL_DEPTH` is rejected with a `RecursionDepthError`.
Raise the cap only when deliberate nesting is required.

## Variable-sourced env

Assignment variables can declare ordered `sources`, including `env` and
`parent`. `env` reads from `envName` (or the var key itself), and
`parent` resolves from the nearest ancestor run in the frozen lineage
chain. See [variables.md](variables.md). Concrete values remain in
`manifest.runtimeVars`; CLI/daemon/web read projections redact env-backed
values using `runtimeVarSources`.

## Manifest upgrades

The current manifest schema is version `24`. Older manifests are not
silently upgraded at runtime — resuming a run with an older schema fails
with a clear error. The repo ships migration scripts under `scripts/`:

- `scripts/migrate-agent-seeds.mjs` — backfills missing `agent-seed.md`
  files for initialized runs created before agent snapshots were
  persisted; dry-run by default, `--write` for in-place creation,
  supports repeated `--repo <name>` and `--file <path>` filters plus
  `--root <path>`
- `scripts/migrate-manifests-v24.mjs` — v19-v23 → v24 (adds
  `executionEnvironment` defaults and moves managed container workspace
  lifecycle state to top-level environment lifecycle state; dry-run by
  default, `--write` to apply, supports repeated `--repo <name>` and
  `--file <path>` filters plus `--root <path>`)
- `scripts/migrate-manifests-v12.mjs` — v11 → v12 (adds `schedule:
  null`; supports repeated `--file <path>` targets for single-manifest
  migrations)
- `scripts/migrate-manifests-v13.mjs` — v12 → v13 (adds
  `resolvedBackendArgs: []` to manifests and reset seeds; dry-run by
  default, `--write` to apply, supports repeated `--repo <name>` and
  `--file <path>` filters plus `--root <path>`)
- `scripts/migrate-manifests-v14.mjs` — v13 → v14 (removes the public
  assignment seed path fields from manifests; dry-run by default,
  `--write` to apply, supports repeated `--repo <name>` and `--file
  <path>` filters plus `--root <path>`)
- `scripts/migrate-manifests-v15.mjs` — v14 → v15 (adds `runGroupId`
  and typed dependencies; dry-run by default, `--write` to apply,
  supports repeated `--repo <name>` and `--file <path>` filters plus
  `--root <path>`)
- `scripts/migrate-manifests-v16.mjs` — v15 → v16 (adds canonical
  `updatedAt`; dry-run by default, `--write` to apply, supports repeated
  `--repo <name>` and `--file <path>` filters plus `--root <path>`)
- `scripts/migrate-manifests-v17.mjs` — v16 → v17 (renames selected
  Codex `backendSpecific` data to `backendConfig` and removes obsolete
  config fields; dry-run by default, `--write` to apply, supports
  repeated `--repo <name>` and `--file <path>` filters plus `--root
  <path>`)
- `scripts/migrate-attempt-stdout-field.mjs` — migrates schemaVersion 2
  `attempts/NN.json` logs to schemaVersion 3 by removing `stdout` after
  raw stdout moved to opt-in sidecars; dry-run by default, `--write` to apply,
  supports repeated `--repo <name>` and `--file <path>` filters plus
  `--root <path>`
- `scripts/migrate-manifests-v11.mjs` — v10 → v11 (normalizes session
  and attempt records plus hook audits)
- `scripts/migrate-manifests-v10.mjs` — v9 → v10 (freezes launcher
  capture plus `callerInstructions`)
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
- `scripts/migrate-run-events-v2.mjs` — audit-event schema v1 → v2
  (canonicalizes per-run cursors in `run-events.jsonl`; dry-run by
  default, `--write` for in-place rewrite, supports repeated `--repo
  <name>` filters plus `--root <path>`)

Schema v14 removes assignment seed path fields from run manifests and
public DTOs. Assignment-backed runs still write `assignment-seed.md` as an
internal workspace audit snapshot. Reverting this feature branch after
users migrate manifests to v14 requires either restoring the branch or
manually downgrading/recreating those runs, because older code will reject
v14 manifests.

Run the scripts explicitly; or recreate affected runs if an upgrade path
isn't important. New manifests and new audit-event files are always
created at the latest schema version.

Other maintained root scripts are intentionally callable outside the
normal CLI surface:

- `scripts/analyze-perf-log.mjs` — summarizes `AGENT_RUNNER_DEBUG_PERF`
  output captured from local debugging sessions
- `scripts/task-list-markdown.mjs` — renders
  `agent-runner task list <run-id> --output-format json` as Markdown,
  using `AGENT_RUNNER_BIN` when set or `agent-runner` on `PATH`

## Git environment isolation

When agent-runner probes a cwd to derive the repo bucket, it clears all
`GIT_*` environment variables to avoid interference from hook-exported
vars. User-initiated git operations you run outside agent-runner are
unaffected.

## Inspecting effective configuration

- `agent-runner list agents` / `list assignments` print the resolved
  config dir contents.
- `agent-runner list runs [--cwd <path> | --repo <name> | --global]`
  prints the resolved state dir contents.
- `agent-runner run status <run-id> --output-format json` exposes the
  `runtimeVars`, `lockedFields`, and per-run environment snapshot.

## Typical host setup

```bash
# XDG defaults are usually fine; override only if needed.
export AGENT_RUNNER_CLAUDE_BIN=/opt/claude/bin/claude
export AGENT_RUNNER_OPENCODE_BIN=/opt/opencode/bin/opencode
export AGENT_RUNNER_PI_BIN=/opt/pi/bin/pi

# Local daemon mode for shared state across terminals.
export AGENT_RUNNER_CONNECT=ws://127.0.0.1:4773/
# Optional: protect daemon access with one shared token.
# Use the same AGENT_RUNNER_DAEMON_TOKEN in serve and connected CLI environments.
# export AGENT_RUNNER_DAEMON_AUTH_ENABLED=true
# export AGENT_RUNNER_DAEMON_TOKEN='a-long-random-token'

# Optional instead: reach a remote daemon through an invocation-scoped SSH forward.
# Replace the local AGENT_RUNNER_CONNECT above with the remote daemon URL when using this mode.
# export AGENT_RUNNER_CONNECT=ws://agent-runner.remote.example:4773/
export AGENT_RUNNER_CONNECT_HOST=prod-box
# export AGENT_RUNNER_CONNECT_LOCAL_PORT=5773
```

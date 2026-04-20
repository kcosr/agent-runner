# Backends

A backend is the runtime that executes the worker. task-runner ships with
five backends; each owns its own CLI/RPC shape, session handle, and cwd
binding semantics.

| Backend   | Binary / Transport                   | Session handle        |
|-----------|--------------------------------------|-----------------------|
| `claude`  | `claude` CLI (`--print`, streaming)  | session UUID on disk  |
| `codex`   | `codex app-server` (stdio or WS)     | thread id             |
| `cursor`  | `cursor-agent` CLI                   | session id (deferred) |
| `pi`      | `pi` CLI (`--mode rpc`)              | session id + cwd hdr  |
| `passive` | none                                 | free-form string      |

## Selection

A backend is chosen by (in order of precedence):

1. `--backend <id>` on the CLI (ad-hoc agent synthesis).
2. `agent.backend` in the agent frontmatter.

Valid backend ids: `claude`, `codex`, `cursor`, `pi`, `passive`.

## Common env and overrides

All non-passive backends accept per-agent:

- `model` — backend-specific model id (optional)
- `effort` — mapped per backend (see below)
- `timeoutSec` — per-attempt wall-clock budget
- `unrestricted` — pass a safety bypass flag to the underlying CLI
- `launcher` — optional subprocess prefix selection

Every backend receives a `cwd`, a resume session id (when present), and a
display name. Session state is bound to the resolved cwd.

Launchers are subprocess-only. They wrap the spawned backend command for
`claude`, `cursor`, `pi`, and Codex stdio. They do not apply to the
`passive` backend or Codex websocket transport.

## `claude`

- Binary: `$TASK_RUNNER_CLAUDE_BIN` or `claude`.
- Args: `--print --output-format stream-json --verbose
  [--model ...] [--effort ...] [--dangerously-skip-permissions]
  [--name ...] [--resume <session-id>] <prompt>`
- Session id captured from JSON stream events.
- Sessions are stored under Claude's project directory encoded from the
  cwd (`/` and `.` → `-`). Resume is validated against that on-disk path.
- Effort mapping: `off` → no flag; `minimal` / `low` → `low`; `medium`,
  `high`, `max` map to themselves; `xhigh` → `max`.

## `codex`

- Transport is chosen from the resolved structured
  `backendSpecific.codex.transport` contract:
  - `{ type: "stdio" }` spawns `$TASK_RUNNER_CODEX_BIN` (default
    `codex`) with `app-server
    [--dangerously-bypass-approvals-and-sandbox]`.
  - `{ type: "ws", url }` connects to a remote Codex app-server over an
    absolute `ws://` or `wss://` URL.
- Fresh-run precedence:
  - Embedded CLI: agent frontmatter
    `backendSpecific.codex.transport` →
    `TASK_RUNNER_CODEX_WS_URL` →
    stdio default.
  - Connected / daemon-owned CLI: agent frontmatter
    `backendSpecific.codex.transport` →
    daemon request override
    `overrides.backendSpecific.codex.transport` →
    daemon process `TASK_RUNNER_CODEX_WS_URL` →
    stdio default.
- The connected CLI only synthesizes that daemon override for Codex, and
  only from the caller's local `TASK_RUNNER_CODEX_WS_URL`. This does not
  add generic env passthrough and does not affect other backends.
- Codex stdio honors the resolved launcher prefix; Codex websocket does
  not because there is no local subprocess to wrap.
- Uses JSON-RPC 2.0 with a thread/turn model:
  `thread/start`, `thread/resume`, `thread/read`, `turn/start`,
  `thread/name/set`.
- Session handle is the thread id.
- Resume validates the thread exists and the cwd matches exactly via
  `thread/read`.
- The resolved transport is frozen into the manifest and reset seed at
  fresh-run/init time. Resume and execute-after-init reuse that frozen
  transport even if later client or daemon env changes.
- Detects external interrupts when another client cancels the turn, and
  authentication failures via stderr markers.
- Effort mapping: `minimal`, `low`, `medium`, `high`, `xhigh`; `max` →
  `xhigh`.

## `cursor`

- Binary: `$TASK_RUNNER_CURSOR_BIN` or `cursor-agent`.
- Args: `-p --trust --output-format stream-json --stream-partial-output
  --workspace <cwd> [--model ...] [--force] [--resume <session-id>]
  <prompt>`
- Session id extracted from JSON stream events.
- No effort support.
- No session-on-disk validation; resume validity is determined on first
  invocation.

## `pi`

- Binary: `$TASK_RUNNER_PI_BIN` or `pi`.
- Args: `--mode rpc --no-themes [--model ...] [--thinking <effort>]
  [--session <session-id>]`
- RPC commands: `get_state`, `set_session_name`, `prompt`. Events:
  `message_start`, `message_update`, `message_end`, `agent_end`,
  `extension_ui_request`, `extension_error`.
- Session storage: under `PI_HOME` (or `~/.pi`) at
  `agent/sessions/<cwd-encoded>/<session-id>.jsonl`. The cwd encoding
  replaces `/` with `-` and wraps the whole path in `--...--` sentinels.
- Resume requires the session file to exist and its header `cwd` to match
  the current run cwd exactly. Mismatches are rejected.
- When bootstrap-importing an existing session via
  `--backend-session-id`, the same cwd validation applies.
- Effort mapping: each level maps through `--thinking off|minimal|low|
  medium|high|xhigh`.
- Unsupported extension UI prompts from Pi are automatically cancelled
  so they do not stall the run; installed extensions remain usable.

## `passive`

The passive backend is a null-object backend. It never invokes an
external process. Passive runs can be initialized (`task-runner init`) or
driven by an outer tool, and all task state is mutated through the task
CLI. Calling `run --resume-run` on a passive run is rejected.

Passive-only metadata mutations:

```bash
task-runner run set-backend-session <id> <session-id>
task-runner run clear-backend-session <id>
```

These let an external driver record the session id it is tracking
without perturbing task state.

## Environment variables

| Variable                       | Effect |
|--------------------------------|--------|
| `TASK_RUNNER_CLAUDE_BIN`       | Claude CLI binary (default `claude`) |
| `TASK_RUNNER_CODEX_BIN`        | Codex stdio binary (default `codex`) |
| `TASK_RUNNER_CODEX_WS_URL`     | Fresh Codex runs use this as the default websocket transport when no explicit `backendSpecific.codex.transport` was authored |
| `TASK_RUNNER_CURSOR_BIN`       | Cursor CLI binary (default `cursor-agent`) |
| `TASK_RUNNER_PI_BIN`           | Pi CLI binary (default `pi`) |
| `PI_HOME`                      | Pi session storage root (default `~/.pi`) |

See [configuration.md](configuration.md) for the full env var catalog.

## Recursion guard

Backends that themselves can invoke `task-runner` (e.g. Claude in an agent
loop) could in principle recurse indefinitely. task-runner enforces a
`TASK_RUNNER_MAX_CALL_DEPTH` (default `1`) via a child env var
`TASK_RUNNER_CALL_DEPTH` that is incremented on each nested invocation.
Deeper recursion is rejected with a `RecursionDepthError`. See
[configuration.md](configuration.md#recursion-guard).

## Picking a backend

- Use `passive` whenever the work is driven externally (outer agent,
  manual operator, external orchestrator). You still get full manifest,
  attachments, dependencies, and audit trail.
- Use `claude`, `codex`, `cursor`, or `pi` for interactive backend
  invocation. Pick the backend that corresponds to the CLI/app-server you
  have installed and authenticated.

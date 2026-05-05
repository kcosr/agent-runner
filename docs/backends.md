# Backends

A backend is the runtime that executes the worker. task-runner ships with
six built-in backends and can load trusted local custom backends. Each
backend owns its own CLI/RPC shape, session handle, and cwd binding
semantics.

| Backend   | Binary / Transport                   | Session handle        |
|-----------|--------------------------------------|-----------------------|
| `claude`  | `claude` CLI (`--print`, streaming)  | session UUID on disk  |
| `codex`   | `codex app-server` (stdio, WS, UDS)  | thread id             |
| `cursor`  | `cursor-agent` CLI                   | session id + store db |
| `opencode` | `opencode run --format json`        | session id + sqlite db |
| `pi`      | `pi` CLI (`--mode rpc`)              | session id + cwd hdr  |
| `passive` | none                                 | free-form string      |

## Selection

A backend is chosen by (in order of precedence):

1. `--backend <id>` on the CLI (ad-hoc agent synthesis).
2. `agent.backend` in the agent frontmatter.

Built-in backend ids: `claude`, `codex`, `cursor`, `opencode`, `pi`, `passive`.
Custom backend names are any non-empty string that does not conflict with
a built-in name.

## Common env and overrides

All non-passive backends accept per-agent:

- `model` — backend-specific model id (optional)
- `effort` — mapped per backend (see below)
- `timeoutSec` — per-attempt wall-clock budget
- `unrestricted` — pass a safety bypass flag to the underlying CLI
- `launcher` — optional subprocess prefix selection
- `backendArgs.<backend>.extraArgs` — optional backend-owned argv tokens

Every backend receives a `cwd`, a resume session id (when present), and a
display name. Session state is bound to the resolved cwd.

Backend invoke contexts also receive a small runtime env overlay for
wrapper scripts:

| Variable | Value |
|----------|-------|
| `TASK_RUNNER_RUN_ID` | active manifest run id |
| `TASK_RUNNER_RUN_GROUP_ID` | active manifest run group id |
| `TASK_RUNNER_CWD` | active backend attempt cwd |

These values override same-named variables inherited from the parent
process. `TASK_RUNNER_RUN_GROUP_ID` keeps its existing role as the default
group source for nested task-runner runs. Runtime vars, backend config,
messages, model, effort, and resolved backend args are not exported as env
vars.

Launchers are subprocess-only. They wrap the spawned backend command for
`claude`, `cursor`, `opencode`, `pi`, and Codex stdio. They do not apply
to the `passive` backend, Codex websocket transport, or Codex UDS
transport.

Backend args are also resolved once for the selected backend and frozen
into the local run manifest. They are appended after task-runner's
generated structured flags so duplicate backend-owned flags pass through
to the underlying tool without task-runner validation. Normal status DTOs
do not expose the frozen args.

Authored `backendConfig.<backend-name>` is backend-owned JSON-like data.
Fresh/init selects only the active backend's keyed config, lets that
backend resolve or validate it, and freezes the resolved selected value
as `manifest.backendConfig`. This is separate from
`backendArgs.<backend-name>.extraArgs`, which is only argv-style token
data.

## Custom backends

Custom backend modules live under the config root:

```text
${TASK_RUNNER_CONFIG_DIR}/backends/<backend-name>/backend.ts
${TASK_RUNNER_CONFIG_DIR}/backends/<backend-name>/backend.mts
${TASK_RUNNER_CONFIG_DIR}/backends/<backend-name>/backend.js
${TASK_RUNNER_CONFIG_DIR}/backends/<backend-name>/backend.mjs
```

When multiple files exist, task-runner uses that order. Missing
`backends/` means no custom backends; a named backend directory without a
candidate module is a config error.

The module must default-export a backend object with:

- `id` equal to the backend directory name
- `invoke(ctx)` as a function
- optional `resolveConfig(ctx)` as a function
- optional `validateSessionId(ctx)` as a function
- optional `resolveSessionHistorySource(ctx)` as a function
- optional `readSessionHistory(ctx)` as a function
- optional `taskRunnerPromptMatchesSyncedTurn(ctx)` as a function
- optional `taskRunnerAttemptTimingMatchesSyncedTurn(ctx)` as a function
- optional `supportsBootstrapSessionImport` as a boolean
- optional `launcherApplies(ctx)` as a function
- optional `launcherMode` as `"applies"` or `"direct"`
- optional `renameSession(ctx)` as a function

Built-in names (`claude`, `codex`, `cursor`, `opencode`, `pi`,
`passive`) are reserved. Import and validation errors include the backend
name and resolved module path.

Built-ins and custom backends use the same `Backend` contract. The run
loop resolves a backend object, passes the same invoke context shape, and
persists the same invoke result fields for both built-in and custom
backends. A backend can stream visible assistant text with
`ctx.emit({ type: "agent_message_delta", text })`, capture a resumable
backend session by returning `sessionId`, and receive that id on the next
invoke as `ctx.resumeSessionId`.

Minimal direct SDK-style backend:

```js
const backend = {
  id: "my-backend",
  launcherMode: "direct",
  supportsBootstrapSessionImport: false,

  resolveConfig(ctx) {
    return {
      ...recordOrEmpty(ctx.authoredConfig),
      ...recordOrEmpty(ctx.overrideConfig),
    };
  },

  async invoke(ctx) {
    // Apply ctx.cwd yourself when calling an SDK, RPC client, or subprocess.
    const text = await callMyModel({
      prompt: ctx.prompt,
      cwd: ctx.cwd,
      model: ctx.model,
      effort: ctx.effort,
      config: ctx.backendConfig,
      resumeSessionId: ctx.resumeSessionId,
      signal: ctx.abortSignal,
    });

    ctx.emit?.({ type: "agent_message_delta", text });

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: ctx.abortSignal?.aborted === true,
      sessionId: null,
      transcript: text,
      rawStdout: text,
      rawStderr: "",
    };
  },
};

function recordOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export default backend;
```

For resumable backends, return a stable non-null `sessionId` from
`invoke()`. Task-runner persists it as the run's backend session id and
passes it back as `ctx.resumeSessionId` on resume. Implement
`validateSessionId(ctx)` when the backend can cheaply verify imported
`--backend-session-id` values before the first invocation. Set
`supportsBootstrapSessionImport: false` when public resume ids are not
self-validating enough to import safely.

### Session history import and sync

Backends can opt into backend-owned session history import by implementing
both `resolveSessionHistorySource(ctx)` and `readSessionHistory(ctx)`.
Task-runner calls them for `--backend-session-id` bootstrap import and
before `task-runner run --resume-run <id>` allocates a new session or
attempt.

Set `TASK_RUNNER_BACKEND_SESSION_SYNC=false` (also accepts `0`, `no`, or
`off`) to disable backend-owned session history import/sync for the
current process, including daemon subscribed-run polling.

`resolveSessionHistorySource(ctx)` receives `sessionId`, `cwd`, `env`,
resolved backend config/args, and the previous source when one exists. It
returns either:

- `{ available: false, reason }` when no durable history source can be
  read for that session
- `{ available: true, source }` with a persistable source descriptor

Most built-ins use `file` sources for local history files. Custom backends
can return `{ kind: "custom", label, changeToken }`; `changeToken` must be
JSON-persistable and should change whenever `readSessionHistory` needs to
run again. `label` is a human-readable source name for diagnostics and
audit context. For `file` sources, task-runner stores path, size, and
mtime as the source change token. Cursor uses a custom SQLite source token
based on its session root pointer instead of filesystem mtime.

`readSessionHistory(ctx)` receives the resolved source, the previous
cursor when one exists, and a mode of `"bootstrap"` or `"sync"`. It
returns:

- the current `source`
- a JSON-persistable `cursor`
- ordered turns with `backendTurnId`, `status`, timestamps, user text,
  and assistant text

Complete turns are imported as canonical session and attempt records with
`backend_session` provenance. Open turns are tracked in
`manifest.backendSessionSync.openTurnIds` but are not persisted as
attempts until a later sync reports them complete. If a backend returns a
non-persistable cursor, source change token, or malformed turn,
task-runner aborts the sync and leaves the prior manifest unchanged.

When sync sees a backend history turn that may correspond to an
already-recorded task-runner attempt, exact prompt equality is matched
first. Backends with storage quirks can additionally implement
`taskRunnerPromptMatchesSyncedTurn({ prompt, turn })` so sync can upgrade
the existing attempt instead of importing a duplicate turn. Backends with
history timestamps that do not overlap task-runner attempt timestamps can
implement `taskRunnerAttemptTimingMatchesSyncedTurn(ctx)` to own that
matching policy.

Custom backend code is trusted local code. It is loaded into the
task-runner process without sandboxing and cached for the process
lifetime; daemon changes require a daemon restart, including the first
creation of the `backends/` root after daemon startup. Dependencies
resolve normally from the backend file location. Install them under the
config directory, for example:

```bash
cd ~/.config/task-runner
npm install <package>
```

Native backend implementations receive the resolved run cwd as `ctx.cwd`.
They are responsible for applying that cwd to any subprocess, RPC client,
or SDK they invoke.

Use built-ins as reference implementations, but do not treat their helper
imports as public API for custom modules:

- [`passive`](../packages/core/src/backends/passive.ts) is the smallest
  backend result shape.
- [`claude`](../packages/core/src/backends/claude.ts) and
  [`cursor`](../packages/core/src/backends/cursor.ts) show subprocess
  backend patterns.
- [`codex`](../packages/core/src/backends/codex.ts) shows backend-owned
  `resolveConfig()` and config validation.
- [`opencode`](../packages/core/src/backends/opencode.ts) shows a
  subprocess JSON-event backend with SQLite-backed session history.
- [`pi`](../packages/core/src/backends/pi.ts) shows backend session
  validation, history import/sync, and resume id handling.

A few built-in backends use optional backend hooks: `codex` owns
transport-specific launcher applicability and thread rename propagation,
`pi` owns session rename propagation, `cursor` owns its sync timestamp
matching policy, and `opencode` owns its stored-prompt equivalence rule.
`passive` still has externally driven run behavior in core because it is
a task-runner lifecycle mode, not an invokable subprocess backend.

## `claude`

- Binary: `$TASK_RUNNER_CLAUDE_BIN` or `claude`.
- Args: `--print --output-format stream-json --verbose
  [--model ...] [--effort ...] [--dangerously-skip-permissions]
  [--name ...] [--resume <session-id>] [extra args...] <prompt>`
- Session id captured from JSON stream events.
- Sessions are stored under Claude's project directory encoded from the
  cwd (`/` and `.` → `-`). Resume is validated against that on-disk path.
- Session history import reads the cwd-bound Claude JSONL file, ignores
  sidechains, tool-only user events, and task notifications. Bootstrap
  import finalizes the latest turn as complete; sync mode keeps the latest
  turn open until Claude writes a terminal turn-duration marker or a later
  user turn completes it.
- Effort mapping: `off` → no flag; `minimal` / `low` → `low`; `medium`,
  `high`, `max` map to themselves; `xhigh` → `max`.

## `codex`

- Transport is chosen from the resolved structured
  `backendConfig.codex.transport` contract:
  - `{ type: "stdio" }` spawns `$TASK_RUNNER_CODEX_BIN` (default
    `codex`) with `app-server
    [--dangerously-bypass-approvals-and-sandbox] [extra args...]`.
  - `{ type: "ws", url }` connects to a remote Codex app-server over an
    absolute `ws://` or `wss://` URL.
  - `{ type: "uds", path: "/absolute/socket/path" }` connects to a Codex
    app-server over WebSocket-over-Unix-domain-socket, where `path` must
    be an absolute socket path. This is still the Codex app-server
    WebSocket protocol, not raw UDS bytes.
- Fresh-run precedence: authored `backendConfig.codex.transport` →
  request `overrides.backendConfig.codex.transport` when supplied by the
  daemon/API caller → current process `TASK_RUNNER_CODEX_UDS_PATH` or
  `TASK_RUNNER_CODEX_WS_URL` → stdio default.
- `TASK_RUNNER_CODEX_UDS_PATH` and `TASK_RUNNER_CODEX_WS_URL` are
  Codex-specific defaults, not generic daemon env passthrough. If both are
  set and no higher-precedence transport was authored or explicitly
  overridden, the
  run fails fast.
- The connected CLI does not forward caller-local Codex transport env.
  Daemon-owned runs resolve Codex env from the daemon process. Resume
  reuses the frozen manifest transport.
- Codex stdio honors the resolved launcher prefix; Codex websocket and
  UDS keep `direct` because there is no local subprocess to wrap.
- Codex websocket and UDS connect to an already-running app-server, so
  `backendArgs.codex.extraArgs` are ignored for those transports. Author
  app-server flags where that remote server is launched.
- Uses JSON-RPC 2.0 with a thread/turn model:
  `thread/start`, `thread/resume`, `thread/read`, `turn/start`,
  `thread/name/set`.
- Session handle is the thread id.
- Resume validates the thread exists and the cwd matches exactly via
  `thread/read`.
- Session history import resolves the matching
  `~/.codex/sessions/**/rollout-*.jsonl` file by `session_meta` payload
  id and imports complete user/assistant turns in source order.
- The resolved transport is frozen into the manifest and reset seed at
  fresh-run/init time. Resume and ready-start reuse that frozen transport
  even if later client or daemon env changes.
- Detects external interrupts when another client cancels the turn, and
  authentication failures via stderr markers.
- Effort mapping: `minimal`, `low`, `medium`, `high`, `xhigh`; `max` →
  `xhigh`.

## `cursor`

- Binary: `$TASK_RUNNER_CURSOR_BIN` or `cursor-agent`.
- Args: `-p --trust --output-format stream-json --stream-partial-output
  --workspace <cwd> [--model ...] [--force] [--resume <session-id>]
  [extra args...] <prompt>`
- Session id extracted from JSON stream events.
- No effort support.
- Session storage: Cursor stores chat state at
  `~/.cursor/chats/<md5(cwd)>/<session-id>/store.db`. The cwd hash uses
  the exact run cwd string.
- Bootstrap `--backend-session-id` validation opens that deterministic
  SQLite store read-only, decodes `meta[0]`, and requires its `agentId` to
  match the supplied session id. Empty/path-like ids, missing stores,
  malformed metadata, and agent id mismatches are rejected before import or
  resume.
- Session history import/sync reads the ordered root blob ids from the
  store, imports visible user/assistant JSON message blobs as complete
  turns, ignores Cursor internal context blobs, unwraps `<user_query>`
  content, and prefers Cursor `final_answer` assistant text when present.
  Sync mode tracks the latest no-answer user turn as open. Cursor sync uses
  `meta[0].latestRootBlobId` as its change token so active SQLite WAL writes
  are detected before a store checkpoint updates `store.db` mtime.

## `opencode`

- Binary: `$TASK_RUNNER_OPENCODE_BIN` or `opencode`.
- Args: `run --format json [--model ...] [--variant <effort>]
  [--session <session-id>] [--title ...]
  [--dangerously-skip-permissions] [extra args...] <prompt>`.
- Session id is captured from OpenCode JSON events as `sessionID`.
- The OpenCode CLI is itself a headless/server-backed runtime: `opencode
  run` starts an in-process server by default, while user-supplied extra
  args may select OpenCode's own attach/agent behavior.
- Live output is captured from `run --format json` text events when
  OpenCode emits them. This is not a token-delta contract; OpenCode may
  report a final text event for the completed response.
- `--title` is passed during `run` invocation when task-runner has a run
  name. The current OpenCode CLI does not expose a supported post-hoc
  session rename command, so later `run set-name` changes remain
  task-runner-local for OpenCode.
- Session storage is OpenCode's SQLite database at
  `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`; tests and
  wrappers can override it with `TASK_RUNNER_OPENCODE_DATA_DIR`, and
  task-runner also honors OpenCode's `OPENCODE_DATA_DIR` when the
  task-runner-specific override is unset.
- Resume/import validation opens the SQLite database read-only, requires
  the session id to exist, and requires the stored session `directory` to
  equal the run cwd exactly. Empty/path-like ids are rejected. Read-only
  SQLite opens use a 30s busy timeout; transient busy/locked reads are
  reported as `source_busy` so sync can retry later instead of failing a
  resume.
- Session history import/sync reads OpenCode `message` and `part` rows,
  pairs visible user text with assistant text parts by `parentID`, imports
  complete turns, and tracks the latest unfinished sync turn as open until
  OpenCode records completion metadata or a later user turn supersedes it.
- OpenCode implements the backend prompt-match hook so sync recognizes
  already-recorded task-runner attempts even when OpenCode stores the
  user message with an extra JSON-string quoting layer.
- Effort mapping passes `minimal`, `low`, `medium`, `high`; `xhigh` and
  `max` map to `--variant max`; `off` omits `--variant`.

## `pi`

- Binary: `$TASK_RUNNER_PI_BIN` or `pi`.
- Args: `--mode rpc --no-themes [--model ...] [--thinking <effort>]
  [--session <session-id>] [extra args...]`
- RPC commands: `get_state`, `set_session_name`, `prompt`. Events:
  `message_start`, `message_update`, `message_end`, `agent_end`,
  `extension_ui_request`, `extension_error`.
- Session storage: under `PI_HOME` (or `~/.pi`) at
  `agent/sessions/<cwd-encoded>/<timestamp>_<session-id>.jsonl`. The cwd
  encoding replaces `/` with `-` and wraps the whole path in `--...--`
  sentinels.
- Resume requires the session file to exist and its header `cwd` to match
  the current run cwd exactly. Mismatches are rejected.
- When bootstrap-importing an existing session via
  `--backend-session-id`, the same cwd validation applies.
- Session history import/sync reads the cwd-bound JSONL file, imports
  complete visible user/assistant turns, ignores thinking/tool-only
  assistant content, and tracks the latest sync-mode no-answer user turn as
  open.
- Effort mapping: each level maps through `--thinking off|minimal|low|
  medium|high|xhigh`.
- Unsupported extension UI prompts from Pi are automatically cancelled
  so they do not stall the run; installed extensions remain usable.

## `passive`

The passive backend is a null-object backend. It never invokes an
external process. Passive runs can be initialized (`task-runner init`) or
driven by an outer tool, and all task state is mutated through the task
CLI. Calling `run --resume-run` on a passive run is rejected.

`backendArgs.passive.extraArgs` is accepted by the agent schema but
resolves to an empty frozen argv list because there is no backend process.

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
| `TASK_RUNNER_CODEX_UDS_PATH`   | Fresh Codex runs use this absolute socket path as the default WebSocket-over-UDS transport when no explicit `backendConfig.codex.transport` was authored |
| `TASK_RUNNER_CODEX_WS_URL`     | Fresh Codex runs use this as the default websocket transport when no explicit `backendConfig.codex.transport` was authored |
| `TASK_RUNNER_CURSOR_BIN`       | Cursor CLI binary (default `cursor-agent`) |
| `TASK_RUNNER_OPENCODE_BIN`     | OpenCode CLI binary (default `opencode`) |
| `TASK_RUNNER_OPENCODE_DATA_DIR` | OpenCode data directory for session-history validation/sync; falls back to `OPENCODE_DATA_DIR`, then `${XDG_DATA_HOME:-~/.local/share}/opencode` |
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
- Use `claude`, `codex`, `cursor`, `opencode`, or `pi` for interactive
  built-in invocation. Pick the backend that corresponds to the
  CLI/app-server you have installed and authenticated.
- Use a custom backend when the runtime is local trusted code that can own
  its config parsing and invocation semantics.

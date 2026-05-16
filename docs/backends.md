# Backends

A backend is the runtime that executes the worker. agent-runner ships with
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
- `executionEnvironment` — optional container execution environment
- `backendArgs.<backend>.extraArgs` — optional backend-owned argv tokens

Every backend receives a `cwd`, a resume session id (when present), and a
display name. Session state is bound to the resolved cwd.

Backend invoke contexts also receive a small runtime env overlay for
wrapper scripts:

| Variable | Value |
|----------|-------|
| `AGENT_RUNNER_CALL_DEPTH` | recursion guard depth for nested agent-runner invocations |
| `AGENT_RUNNER_MAX_CALL_DEPTH` | recursion guard cap for nested agent-runner invocations |
| `AGENT_RUNNER_PARENT_RUN_ID` | active manifest run id, used as the parent for nested agent-runner runs |
| `AGENT_RUNNER_RUN_ID` | active manifest run id |
| `AGENT_RUNNER_RUN_GROUP_ID` | active manifest run group id |
| `AGENT_RUNNER_CWD` | active backend attempt cwd |

These values override same-named variables inherited from the parent
process. `AGENT_RUNNER_PARENT_RUN_ID` and `AGENT_RUNNER_RUN_GROUP_ID`
keep their existing roles as the default lineage and group sources for
nested agent-runner runs. Runtime vars, backend config, messages, model,
effort, and resolved backend args are not exported as env vars.

Launchers are subprocess-only. They wrap the spawned backend command for
`claude`, `cursor`, `opencode`, `pi`, and Codex stdio. They do not apply
to the `passive` backend, Codex websocket transport, or Codex UDS
transport.

Execution environments are also subprocess-only. When a run has a frozen
container environment, agent-runner validates or starts the container and
passes subprocess-backed backend invocations through a generated
`docker exec` / `podman exec` prefix with the container cwd and merged
env. Container environments are mutually exclusive with non-direct
launchers, and do not apply to passive runs or Codex websocket/UDS
transports.

Backend args are also resolved once for the selected backend and frozen
into the local run manifest. They are appended after agent-runner's
generated structured flags so duplicate backend-owned flags pass through
to the underlying tool without agent-runner validation. Normal status DTOs
do not expose the frozen args.

Authored `backendConfig.<backend-name>` is backend-owned JSON-like data.
Fresh/init selects only the active backend's keyed config, lets that
backend resolve or validate it, and freezes the resolved selected value
as `manifest.backendConfig`. This is separate from
`backendArgs.<backend-name>.extraArgs`, which is only argv-style token
data.

## Custom backends

Beyond the built-ins, agent-runner can load trusted local custom backend
modules from `${AGENT_RUNNER_CONFIG_DIR}/backends/<backend-name>/`. A
custom backend owns its own invocation, config resolution, session
handling, and optional session-history import, and uses the same
`Backend` contract as the built-ins.

See [custom-backends.md](custom-backends.md) for the module location and
contract, the `Backend` interface, resumable sessions, session-history
import and sync, trusted-code rules, and a minimal example.

## `claude`

- Binary: `$AGENT_RUNNER_CLAUDE_BIN` or `claude`.
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
  - `{ type: "stdio" }` spawns `$AGENT_RUNNER_CODEX_BIN` (default
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
  daemon/API caller → current process `AGENT_RUNNER_CODEX_UDS_PATH` or
  `AGENT_RUNNER_CODEX_WS_URL` → stdio default.
- `AGENT_RUNNER_CODEX_UDS_PATH` and `AGENT_RUNNER_CODEX_WS_URL` are
  Codex-specific defaults, not generic daemon env passthrough. If both are
  set and no higher-precedence transport was authored or explicitly
  overridden, the
  run fails fast.
- The connected CLI does not forward caller-local Codex transport env.
  Daemon-owned runs resolve Codex env from the daemon process. Resume
  reuses the frozen manifest transport.
- Codex `thread/start` and `thread/resume` also receive the fixed
  agent-runner runtime env overlay above through
  `shell_environment_policy.set.*` config overrides. This lets shell
  tools inside Codex websocket and UDS sessions preserve agent-runner
  lineage and recursion guard state without forwarding arbitrary env.
- Codex stdio honors the resolved launcher prefix; Codex websocket and
  UDS keep `direct` because there is no local subprocess to wrap.
- Codex websocket and UDS connect to an already-running app-server, so
  `backendArgs.codex.extraArgs` are ignored for those transports. Author
  app-server flags where that remote server is launched.
- Ownership differs by transport. `stdio` is local-owned because
  agent-runner launches the app-server child process, so daemon shutdown
  aborts it with other subprocess-backed runs. `ws` and `uds` are
  remote-detachable: daemon shutdown closes agent-runner's connection
  without interrupting the remote turn, and daemon startup can reconnect
  to the frozen transport and saved thread id.
- During daemon startup recovery, `thread/read` status drives
  reconciliation. `Active` threads are re-adopted with `thread/resume`
  and no new `turn/start`; `Idle` threads import available session
  history before finalization; `SystemError`, `NotLoaded`, and
  unreachable app-servers become terminal agent-runner errors with audit
  detail.
- Recovery decisions are recorded on the affected run as
  `run.controller_detached` and `run.controller_reconciled` audit events.
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

- Binary: `$AGENT_RUNNER_CURSOR_BIN` or `cursor-agent`.
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

- Binary: `$AGENT_RUNNER_OPENCODE_BIN` or `opencode`.
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
- `--title` is passed during `run` invocation when agent-runner has a run
  name. The current OpenCode CLI does not expose a supported post-hoc
  session rename command, so later `run set-name` changes remain
  agent-runner-local for OpenCode.
- Session storage is OpenCode's SQLite database at
  `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`; tests and
  wrappers can override it with `AGENT_RUNNER_OPENCODE_DATA_DIR`, and
  agent-runner also honors OpenCode's `OPENCODE_DATA_DIR` when the
  agent-runner-specific override is unset.
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
  already-recorded agent-runner attempts even when OpenCode stores the
  user message with an extra JSON-string quoting layer.
- Effort mapping passes `minimal`, `low`, `medium`, `high`; `xhigh` and
  `max` map to `--variant max`; `off` omits `--variant`.

## `pi`

- Binary: `$AGENT_RUNNER_PI_BIN` or `pi`.
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

The passive backend is a null-object backend: it never invokes an
external process. A passive run exists so that work driven somewhere
else — an interactive coding tool, a human operator, or an outer
orchestrator — still gets a durable manifest, task checklist,
attachments, dependencies, and audit trail.

Use passive mode when agent-runner should *track* a run but not *drive*
it. This is the sidecar pattern: you keep working in Claude Code,
Cursor, Codex, or similar, and report progress into agent-runner
through the task CLI.

### Lifecycle

A passive run has no run/retry loop and no backend attempts. Its
lifecycle is driven entirely by task state:

1. Create it with `agent-runner init --backend passive ...`. The run
   starts in `initialized`.
2. Fetch the worker handoff with `agent-runner run brief <run-id>` and
   do the work in whatever tool you are using.
3. Report progress through the task CLI as you go.
4. The overall run status is *derived* from the task set, not from a
   backend exit code (see [Derived status](#derived-status) below).

`agent-runner run --resume-run` is rejected for passive runs — there is
no backend session to resume. The `ready` promotion and ready-start
path also do not apply; a passive run is worked directly from
`initialized`.

`backendArgs.passive.extraArgs` is accepted by the agent schema but
resolves to an empty frozen argv list because there is no backend
process.

### Driving a passive run

```bash
agent-runner init \
  --backend passive \
  --assignment plan-feature \
  --name "Web dashboard" \
  "Design the dashboard work"

agent-runner run brief <run-id>
agent-runner task list <run-id>
agent-runner task set <run-id> <task-id> --status in_progress
agent-runner task append-notes <run-id> <task-id> --text "Observed ..."
agent-runner task set <run-id> <task-id> --status completed
```

Task mutation on a passive run is allowed in every lifecycle state
except `running`, including adding tasks unless `tasks` is locked. See
[tasks.md](tasks.md#passive-runs) for the full mutation-rule table.

### Derived status

A passive run's overall status is computed from its tasks:

- all tasks `completed` → `success`
- all tasks `completed` or `blocked`, with at least one `blocked` →
  `blocked`
- otherwise → `initialized` (still waiting for work)

There is no `exhausted` or retry outcome for passive runs because
agent-runner never invokes a backend on their behalf.

### External session tracking

An external driver often does have a backend session of its own — a
Claude session id, a Codex thread id, the conversation it is running
the work in. Passive runs can record that id as metadata:

```bash
agent-runner run set-backend-session   <id|path> <session-id>
agent-runner run clear-backend-session <id|path>
```

Both are passive-only mutations and reject non-passive runs. Setting a
session id:

- stores the supplied id as `manifest.backendSessionId` so read
  surfaces, the daemon, and the web dashboard can show which external
  conversation a run corresponds to;
- clears any imported backend-session sync state
  (`manifest.backendSessionSync`) and drops previously imported
  session-history attempt logs, because the tracked session changed;
- emits a `run.backend_session_updated` audit event.

The session id must be a bare id, not a path — values containing `/`,
`\`, or `..` are rejected — and setting the same id twice is a no-op.
What it does *not* do: it never touches task state, and it does not
make a passive run resumable. Passive runs are still driven only
through the task CLI.

## Environment variables

| Variable                       | Effect |
|--------------------------------|--------|
| `AGENT_RUNNER_CLAUDE_BIN`       | Claude CLI binary (default `claude`) |
| `AGENT_RUNNER_CODEX_BIN`        | Codex stdio binary (default `codex`) |
| `AGENT_RUNNER_CODEX_UDS_PATH`   | Fresh Codex runs use this absolute socket path as the default WebSocket-over-UDS transport when no explicit `backendConfig.codex.transport` was authored |
| `AGENT_RUNNER_CODEX_WS_URL`     | Fresh Codex runs use this as the default websocket transport when no explicit `backendConfig.codex.transport` was authored |
| `AGENT_RUNNER_CURSOR_BIN`       | Cursor CLI binary (default `cursor-agent`) |
| `AGENT_RUNNER_OPENCODE_BIN`     | OpenCode CLI binary (default `opencode`) |
| `AGENT_RUNNER_OPENCODE_DATA_DIR` | OpenCode data directory for session-history validation/sync; falls back to `OPENCODE_DATA_DIR`, then `${XDG_DATA_HOME:-~/.local/share}/opencode` |
| `AGENT_RUNNER_PI_BIN`           | Pi CLI binary (default `pi`) |
| `PI_HOME`                      | Pi session storage root (default `~/.pi`) |

See [configuration.md](configuration.md) for the full env var catalog.

## Recursion guard

Backends that themselves can invoke `agent-runner` (e.g. Claude in an agent
loop) could in principle recurse indefinitely. agent-runner enforces a
`AGENT_RUNNER_MAX_CALL_DEPTH` (default `1`) via a child env var
`AGENT_RUNNER_CALL_DEPTH` that is incremented on each nested invocation.
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

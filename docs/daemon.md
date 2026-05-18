# Daemon

`agent-runner serve` starts a local control plane. It exposes:

- **WebSocket JSON-RPC** for CLI clients (via `--connect` /
  `AGENT_RUNNER_CONNECT`) and for the bundled web UI. The same WebSocket
  also carries multiplexed byte-stream notifications for connected CLI
  features that need bounded file transfer.
- **HTTP API** for browser clients and scripting.
- **Server-Sent Events (SSE)** for live summary, detail, and timeline
  projections.
- **Static assets** for the bundled web dashboard out of the same port.

The daemon is local infrastructure, not a multi-user remote service. It
binds to `127.0.0.1` by default and can optionally require one shared
bearer token for daemon API/WebSocket access.

## Starting the daemon

```bash
agent-runner serve [--listen <ws-url>]
```

- `--listen <ws-url>` — defaults to `ws://127.0.0.1:4773/` (or
  `AGENT_RUNNER_LISTEN`).
- Prints `serving on <ws-url>` and `http api on <http-base-url>/api/`.
- HTTP base URL is derived from the listen URL by substituting `ws` →
  `http`.
- Graceful shutdown on `SIGINT` (exit 130) and `SIGTERM` (exit 0).

When a reverse proxy exposes the bundled web dashboard from a subpath,
set `AGENT_RUNNER_WEB_BASE_PATH` to the external mount path, for example
`/agent-runner`. The daemon returns that path from `/app-config.json`,
uses it when serving the dashboard HTML, and accepts prefixed HTTP routes
for pass-through proxy setups.

## Startup and shutdown recovery

Graceful daemon shutdown still aborts active runs whose controller is
local to agent-runner. This includes subprocess-backed backends and Codex
`stdio`, where agent-runner owns the local `codex app-server` child
process.

Codex runs using frozen `ws` or `uds` transport and a non-null backend
session id are remote-detachable. On graceful daemon shutdown, the daemon
does not send `turn/interrupt` only because the daemon is exiting. It
records a `run.controller_detached` audit event, closes its Codex
connection, and leaves the run manifest `running` so the remote Codex
app-server thread can continue.

On startup, before serving clients or evaluating schedules, the daemon
reconciles manifests still persisted as `running`:

- non-recoverable runs, including non-Codex backends and Codex `stdio`,
  are finalized as `error` with a `run.controller_reconciled` audit event
  because the previous local controller is gone
- Codex `ws`/`uds` runs reconnect to the frozen transport and call
  `thread/read` for the saved thread id
- `Active` Codex threads are re-adopted with `thread/resume`, without a
  new `turn/start`, and project as live/abortable in daemon list and
  detail responses
- `Idle`, `SystemError`, `NotLoaded`, unreachable app-server, and
  `thread/read` failures are reconciled to terminal state with audit
  detail; `Idle` imports available backend history before finalizing when
  there is enough task/run evidence

The recovery audit events are structured for tooling. `run.controller_detached`
records `backend`, `backendSessionId`, `transportType`, and `reason`.
`run.controller_reconciled` records those fields plus `decision`,
`remoteStatus`, `error`, and a reconciliation `reason` such as
`remote_active`, `remote_unreachable`, `thread_read_failed`, or
`aborted_after_recovery`.

Codex `ws`/`uds` Idle history import depends on the Codex session file being
available on the agent-runner host. Remote-only session history cannot be
imported by the current file-based history reader, so zero-task remote Idle
runs without imported turns finalize as `error / insufficient_idle_evidence`.

This startup reconciliation is scoped to daemon restart recovery. If a
Codex app-server websocket or UDS connection disappears while the daemon
is still running, the active backend invocation fails through the normal
attempt/retry/exhaustion path.

### Bearer token access

Daemon access protection is opt-in:

```bash
export AGENT_RUNNER_DAEMON_AUTH_ENABLED=true
export AGENT_RUNNER_DAEMON_TOKEN='a-long-random-token'
agent-runner serve
```

`AGENT_RUNNER_DAEMON_AUTH_ENABLED` accepts `true`, `1`, `yes`, or `on`
after trimming and lowercasing. Other values leave daemon auth disabled.
When auth is enabled, `AGENT_RUNNER_DAEMON_TOKEN` must be non-empty after
trimming or `agent-runner serve` fails before binding.

With auth enabled, every `/api/*` HTTP/SSE request and every WebSocket
JSON-RPC connection must send:

```http
Authorization: Bearer <AGENT_RUNNER_DAEMON_TOKEN>
```

For HTTP and SSE, missing, malformed, or wrong tokens return the normal
JSON error envelope with `code: "UNAUTHENTICATED"` and status 401. SSE
auth failures happen before event-stream headers are sent, so callers
receive JSON rather than `data:` frames. WebSocket connections with
missing or wrong tokens are rejected during the handshake with HTTP 401.

`GET /app-config.json` and static dashboard assets stay public so the web
app can boot and show a token-required state. Those public routes do not
grant daemon access.

Anyone with the token has full daemon access. This is not per-user
isolation or RBAC. Do not log token values or Authorization
headers.

On startup the daemon mints a short `daemonInstanceId` and exposes it via
`GET /api/daemon`:

```json
{
  "daemon": {
    "daemonInstanceId": "daemon-<shortid>",
    "pid": 12345,
    "listenUrl": "ws://127.0.0.1:4773/",
    "version": "0.1.0",
    "startedAt": "2026-04-18T10:35:00.000Z"
  }
}
```

## CLI clients: embedded vs connected

Any client command (e.g. `run`, `list`, `task set`, `attachment add`)
runs in one of two modes:

- **Embedded** — no `--connect`, no `AGENT_RUNNER_CONNECT`. The CLI
  executes the command directly in-process.
- **Connected** — `--connect <ws-url>` (or `AGENT_RUNNER_CONNECT` env).
  The CLI opens a WebSocket, makes JSON-RPC calls, and prints the
  response.

Connected mode can optionally add an invocation-scoped SSH tunnel:

- `--connect-host <host>` (or `AGENT_RUNNER_CONNECT_HOST`) tells the CLI
  to run `ssh -N -L 127.0.0.1:<local-port>:<daemon-host>:<daemon-port>`
  before it dials the daemon.
- `--connect-local-port <port>` (or `AGENT_RUNNER_CONNECT_LOCAL_PORT`)
  overrides the loopback port used for that local forward. Without it,
  the CLI reuses the daemon port from `--connect`.
- The logical `--connect` URL remains the user-facing daemon address in
  status output and error hints; the tunneled loopback URL is internal.
- This helper is per-invocation only. Advanced SSH behavior such as jump
  hosts, identities, or multiplexing belongs in the user's SSH config.
- `agent-runner serve` is still local-only infrastructure and rejects
  `--connect`, `--connect-host`, and `--connect-local-port`.

Connected mode is how multiple terminals can share state and how the web
UI and CLI stay in sync. `run --detach` only works in connected mode.

If the daemon requires auth, connected CLI invocations read
`AGENT_RUNNER_DAEMON_TOKEN` from the client environment and send it as an
Authorization bearer header on WebSocket and direct HTTP helper requests.
The token is not forwarded as a generic daemon environment variable.

Connected clients use JSON-RPC requests/responses for commands. Byte
streams are JSON-RPC 2.0 notifications whose methods begin with
`stream.`:

- `stream.data` carries base64 bytes with a zero-based `seq`.
- `stream.end` marks EOF with the next expected `seq`.
- `stream.error` fails a stream.
- `stream.cancel` requests cleanup.
- `stream.window` grants byte credit back to an outgoing sender after
  the receiver consumes buffered data.

Stream IDs are scoped to one WebSocket connection and multiple streams
can be active concurrently on that connection. The daemon enforces these
limits:

- Max decoded stream chunk: **65,536 bytes**
- Max active streams per WebSocket: **8**
- Initial outgoing byte credit per stream: **512 KiB**
- Max buffered unread bytes per stream: **1 MiB**
- Max buffered unread bytes per WebSocket: **4 MiB**
- Stream idle timeout: **30 seconds**

Senders must honor receiver-issued `stream.window` credit grants before
sending more `stream.data` frames. The buffer limits remain hard safety
checks at the receiver boundary.

Connected CLI attachments use this stream facility for upload and
download. Listing and removal use WebSocket JSON-RPC methods
(`attachments.list` and `attachments.remove`). SSH-agent forwarding is a
possible future stream consumer; it is not implemented.

Nested `agent-runner` invocations launched by a worker also preserve
lineage through `AGENT_RUNNER_PARENT_RUN_ID`. Shared `RunSummary` /
`RunDetail` payloads surface that edge as `parentRunId`.
Nested invocations also preserve run grouping through
`AGENT_RUNNER_RUN_GROUP_ID`. Shared payloads surface that grouping key as
`runGroupId`; it is independent of parent lineage.

Connected-mode runtime selection stays explicit:

- the client does not forward arbitrary env vars to the daemon
- if the client passes `--parent-run <run-id>` or has
  `AGENT_RUNNER_PARENT_RUN_ID` set, fresh `run` / new `init` requests
  synthesize structured `parentRunId`
- if the client passes `--group-id <group-id>` or has
  `AGENT_RUNNER_RUN_GROUP_ID` set, fresh `run` / new `init` requests
  synthesize structured `runGroupId`
- caller-local `AGENT_RUNNER_CODEX_UDS_PATH` and
  `AGENT_RUNNER_CODEX_WS_URL` are not forwarded; daemon-owned Codex runs
  resolve transport from authored/request `backendConfig` and then the
  daemon process env
- agent-runner-owned lineage/runtime values such as
  `AGENT_RUNNER_PARENT_RUN_ID`, `AGENT_RUNNER_RUN_GROUP_ID`, and recursion
  guard depth are injected into Codex thread config for backend shell
  tools; this fixed allowlist is separate from caller-local env
  forwarding
- resume requests reuse the frozen manifest `backendConfig`
- if the client passes `--launcher <name>`, the daemon resolves that
  named launcher against its own config root and freezes the result into
  the manifest
- malformed `overrides.backendConfig` values are rejected at the daemon
  request boundary before any run is created; Codex-specific transport
  shape validation is owned by the Codex backend
- malformed launcher overrides are rejected at the same request boundary

The UDS transport shape is `{ type: "uds", path:
"/absolute/socket/path" }`. It is WebSocket-over-UDS for Codex app-server,
not raw UDS bytes. For daemon-owned Codex runs, the daemon process must
be able to access that absolute socket path.

That special case exists only for Codex transport selection.
`AGENT_RUNNER_CODEX_UDS_PATH` is not a generic env passthrough mechanism,
and launcher override handling is still explicit and named-only; no
generic daemon-side env passthrough exists for other backends.

The daemon loads custom backend modules from
`${AGENT_RUNNER_CONFIG_DIR}/backends/<backend-name>/backend.(ts|mts|js|mjs)`
before accepting requests. Custom backend code is trusted local code,
runs without sandboxing, and is cached for the daemon lifetime; restart
the daemon after changing a backend module or its dependencies.

## HTTP API

All routes are under `/api/`.

### Daemon

- `GET /api/daemon` → `{ daemon: DaemonInfo }`

### Runs

| Method | Path | Effect |
|--------|------|--------|
| `GET` | `/api/runs` | List runs. Query: `includeArchived`, plus exactly one of `cwd`, `repo`, `global=true`, or `runGroupId=<group-id>` |
| `GET` | `/api/runs/:runId` | Full `RunDetail` (including frozen hook descriptors/state/audits when present) |
| `POST` | `/api/runs/init` | Initialize a run |
| `POST` | `/api/runs` | Start a run |
| `POST` | `/api/runs/:runId/ready` | Promote initialized run to ready |
| `POST` | `/api/runs/:runId/reconfigure` | Patch vars/message on an initialized run |
| `POST` | `/api/runs/:runId/resume` | Resume an initialized/terminal run |
| `POST` | `/api/runs/:runId/queued-resume-messages` | Queue a pending resume message for a live run |
| `DELETE` | `/api/runs/:runId/queued-resume-messages/:messageId` | Remove a pending resume message |
| `POST` | `/api/runs/:runId/abort` | Abort an active run |
| `POST` | `/api/runs/:runId/archive` | Archive |
| `POST` | `/api/runs/:runId/unarchive` | Unarchive |
| `POST` | `/api/runs/:runId/reset` | Reset to initialized |
| `DELETE` | `/api/runs/:runId` | Delete (archived only) |
| `POST` | `/api/runs/:runId/name` | Set display name (`null` to clear) |
| `POST` | `/api/runs/:runId/note` | Set note (`string` or `null` to clear) |
| `POST` | `/api/runs/:runId/pinned` | Set pinned state (`boolean`) |
| `POST` | `/api/runs/:runId/backend-session` | Set `backendSessionId` (passive only) |
| `POST` | `/api/runs/:runId/backend-session/clear` | Clear `backendSessionId` (passive only) |
| `POST` | `/api/runs/:runId/group` | Set run group (`{ runGroupId }`) |
| `POST` | `/api/runs/:runId/group/clear` | Reset run to its singleton group |
| `POST` | `/api/runs/:runId/dependencies` | Add a dependency |
| `DELETE` | `/api/runs/:runId/dependencies` | Remove a dependency (`{ type: "run", runId }` or `{ type: "group", groupId }`) |
| `POST` | `/api/runs/:runId/dependencies/clear` | Clear all dependencies |
| `PUT` | `/api/runs/:runId/schedule` | Set a one-time or recurring schedule |
| `DELETE` | `/api/runs/:runId/schedule` | Clear a one-time schedule |
| `POST` | `/api/runs/:runId/schedule/enable` | Enable an existing schedule |
| `POST` | `/api/runs/:runId/schedule/disable` | Disable an existing schedule |

`runGroupId=<group-id>` returns every run in that group. It is mutually
exclusive with `cwd`, `repo`, and `global=true`; empty or malformed
`runGroupId` values are rejected as invalid requests.

Fresh-run HTTP requests reuse the same generic run-start contract as
the WebSocket methods:

```json
{
  "agent": "planner",
  "assignment": "implement-feature",
  "definitionCwd": "/repo",
  "callerCwd": "/repo",
  "parentRunId": "abcd12",
  "runGroupId": "planning-wave",
  "backendSessionId": "session-123",
  "cliVars": {},
  "overrides": {}
}
```

Browser callers should send an explicit `callerCwd` on `POST
/api/runs/init` and `POST /api/runs`. The daemon keeps `callerCwd`
distinct from `overrides.cwd`; it is not a browser-only alias.

Schedule bodies use the same flat input contract as the CLI:

```json
{ "delay": "30m" }
```

or:

```json
{
  "cron": "0 9 * * *",
  "timezone": "UTC",
  "mode": "clone",
  "continueOnFailure": false
}
```

Exactly one of `at`, `delay`, or `cron` is accepted. `timezone`,
`mode`, and `continueOnFailure` are valid only with `cron`. Clearing is
limited to one-time schedules; recurring schedules are disabled instead.

Reconfigure request bodies accept only `vars` and `message`:

```json
{ "vars": { "target": "next" }, "message": "Updated initial ask" }
```

The HTTP and WebSocket surfaces share the core initialized-only,
all-or-nothing behavior. Locked `message`/task fields and stale lifecycle
state are conflicts; unknown body keys are invalid requests.
Omit `message` to keep the current value; send `"message": ""` to replace
it with an empty message. `null` is rejected.

### Definitions

| Method | Path | Effect |
|--------|------|--------|
| `GET` | `/api/agents` | List agents. Returns `{ agents: DefinitionListResult }` |
| `GET` | `/api/agents/:target` | Read one agent. Returns `{ agent: DefinitionDetail }` |
| `GET` | `/api/assignments` | List assignments. Returns `{ assignments: DefinitionListResult }` |
| `GET` | `/api/assignments/:target` | Read one assignment. Returns `{ assignment: DefinitionDetail }` |
| `GET` | `/api/launchers` | List launchers. Returns `{ launchers: DefinitionListResult }` |
| `GET` | `/api/launchers/:target` | Read one launcher. Returns `{ launcher: DefinitionDetail }` |
| `GET` | `/api/task-definitions` | List reusable task definitions. Returns `{ taskDefinitions: DefinitionListResult }` |
| `GET` | `/api/task-definitions/:target` | Read one reusable task definition. Returns `{ taskDefinition: TaskDefinitionDetail }` |

Definition routes share the same payloads as the WebSocket RPC methods:
HTTP is the browser-facing transport, while connected CLI clients keep
using WebSocket JSON-RPC for definitions and orchestration.

Definition detail routes accept:

- `:target` as either a named definition (for example `planner`) or a
  percent-encoded direct path target (for example
  `./agents/planner/agent.md` or `./tasks/review/check.md`).
- Optional `?cwd=<path>` when a relative direct path needs an explicit
  resolution base.

List routes return the shared `DefinitionListResult` shape with
`kind`, `entries`, and `warnings`. Agent, assignment, and launcher detail
routes return the shared `DefinitionDetail` union branch for the requested
resource kind; task-definition detail routes return the task-specific
`TaskDefinitionDetail` shape
`{ kind: "task", task: { id, title, body, hooks }, sourcePath }`. These
are reusable task-definition fields, not run task-state fields such as
`status` or `notes`.

### Tasks

| Method | Path | Effect |
|--------|------|--------|
| `GET` | `/api/runs/:runId/tasks` | List tasks |
| `GET` | `/api/runs/:runId/tasks/:taskId` | Single task |
| `PATCH` | `/api/runs/:runId/tasks/:taskId` | Update status, notes, or pending title/body fields |
| `POST` | `/api/runs/:runId/tasks/:taskId/append-notes` | Append to notes |
| `POST` | `/api/runs/:runId/tasks` | Add a task |
| `DELETE` | `/api/runs/:runId/tasks/:taskId` | Delete a pending task |

Task PATCH bodies accept any valid subset of `status`, `notes`, `title`,
and `body`, subject to the `taskMutation` gates on `RunCapabilities`.
`status` and `notes` can be changed independently. `title` and `body` are
accepted only for pending tasks when pending edits are enabled. DELETE uses
the same pending-task gate and returns `{ result: { runId, taskId, deleted,
updatedAt } }`.

### Workspace files

| Method | Path | Effect |
|--------|------|--------|
| `GET` | `/api/runs/:runId/workspace/files` | List a cwd-relative directory. Query: optional `path` |
| `GET` | `/api/runs/:runId/workspace/search` | Search cwd-relative text paths. Query: `q`, optional `limit` |
| `GET` | `/api/runs/:runId/workspace/file` | Read a text file. Query: `path` |

Workspace file routes are scoped to the selected run's `cwd`. Paths are
cwd-relative and must stay inside that tree after normalization and symlink
resolution. Traversal, missing files, unreadable binary content, and
oversized reads return the normal daemon error envelope; the daemon never
serves arbitrary absolute paths from these routes.

### Attachments

| Method | Path | Effect |
|--------|------|--------|
| `GET` | `/api/runs/:runId/attachments` | List. Query: `scope=run\|group` (default `group`) |
| `POST` | `/api/runs/:runId/attachments` | Upload; requires `x-agent-runner-attachment-name` header |
| `DELETE` | `/api/runs/:runId/attachments/:attachmentId` | Delete |
| `GET` | `/api/runs/:runId/attachments/:attachmentId/content` | Download; sets `content-disposition`, `x-agent-runner-attachment-id`, `x-agent-runner-sha256` |

These HTTP attachment endpoints remain the browser/API surface. Connected
CLI attachment commands use the daemon WebSocket instead of these HTTP
routes.

### Streams

| Path | Stream |
|------|--------|
| `GET /api/events/run-summaries` | Global summary SSE |
| `GET /api/runs/:runId/events/detail` | Per-run detail SSE |
| `GET /api/runs/:runId/audit` | Per-run audit history (JSON, plus `lastCursor`) |
| `GET /api/runs/:runId/timeline` | Per-run timeline history (JSON, plus `lastCursor`) |
| `GET /api/runs/:runId/events/audit` | Per-run audit SSE (live envelopes with SSE `id: <cursor>`) |
| `GET /api/runs/:runId/events/timeline` | Per-run timeline SSE (live envelopes with SSE `id: <cursor>`) |

### App config

- `GET /app-config.json` → `{ webBasePath }`

The web UI fetches this before initialization, then derives API, summary
event, per-run detail, audit, and timeline paths from `webBasePath`.
When `AGENT_RUNNER_WEB_BASE_PATH` is set, the daemon also accepts the
configured prefix on HTTP routes, for example
`/agent-runner/app-config.json` and `/agent-runner/api/runs`.

## WebSocket JSON-RPC

Messages are JSON-RPC 2.0.

```jsonc
// Request
{ "jsonrpc": "2.0", "id": 7, "method": "runs.list", "params": {} }
// Response
{ "jsonrpc": "2.0", "id": 7, "result": { "runs": [...] } }
// Notification (server → client)
{ "jsonrpc": "2.0", "method": "run.detail", "params": {...} }
```

Error codes:

- `-32700` parse error
- `-32600` invalid request
- `-32601` method not found
- `-32003` known control-plane error (validation, conflict, not found,
  locked field)
- `-32004` unexpected runtime error

### Methods

**Daemon**

- `daemon.info`

**Runs**

- `runs.list`, `runs.get`, `runs.brief`, `runs.timelineHistory`
- `runs.init`, `runs.start`, `runs.ready`, `runs.resume`, `runs.abort`
- `runs.reconfigure`
- `runs.queueResumeMessage`, `runs.removeQueuedResumeMessage`
- `runs.archive`, `runs.unarchive`, `runs.reset`, `runs.delete`
- `runs.setName`, `runs.setNote`, `runs.setPinned`
- `runs.setBackendSession`, `runs.clearBackendSession`
- `runs.setGroup`, `runs.clearGroup`
- `runs.addDependency`, `runs.removeDependency`, `runs.clearDependencies`
- `runs.setSchedule`, `runs.clearSchedule`, `runs.enableSchedule`,
  `runs.disableSchedule`

`runs.ready` accepts optional `schedule` params so connected CLI
`agent-runner run ready --schedule-*` can promote and schedule in one
mutation. The HTTP ready route is a promotion-only endpoint; browser
callers set schedules through the explicit schedule routes.

**Tasks**

- `tasks.list`, `tasks.get`, `tasks.set`, `tasks.appendNotes`,
  `tasks.add`, `tasks.delete`

**Definitions**

- `agents.list`, `agents.get`
- `assignments.list`, `assignments.get`
- `launchers.list`, `launchers.get`
- `taskDefinitions.list`, `taskDefinitions.get`

**Attachments**

- `attachments.list`, `attachments.remove`
- `attachments.upload.open`, `attachments.upload.finish`
- `attachments.download`

Attachment upload and download pair JSON-RPC metadata with `stream.*`
notifications on the same WebSocket connection.

**Subscriptions**

- `events.subscribe { channel, runId? }` — returns `{ subscriptionId }`
- `events.unsubscribe { subscriptionId }`

Valid `channel` values: `"run_summary"`, `"run_detail"`,
`"run_timeline"`, `"run_audit"`. Detail, timeline, and audit require a
`runId`.

## Schedule evaluation

The daemon does not keep a separate scheduling database. It scans
manifest `schedule` fields on startup, arms timers for future enabled
schedules, and re-evaluates affected runs after schedule mutations,
ready/reset/archive/unarchive changes, dependency changes, and run
completion.

Startup intentionally does not immediately launch overdue work. If an
enabled schedule is already due when the daemon starts, the occurrence
is treated as missed/skipped with an audit record:

- one-time schedules are cleared
- recurring schedules are advanced to the next occurrence
- recurrence is disabled if advancing violates
  `AGENT_RUNNER_MIN_RECURRENCE_INTERVAL_SEC`

For normal due schedules, the daemon uses the same runnability checks as
manual start. It skips and audits schedules when dependencies are unmet,
the run is archived, the run is already active or pending start, the run
is not `ready`, or the backend is passive. Runnable due schedules start
through the daemon-managed resume path, so duplicate starts are
suppressed by the same active/pending sets used for manual daemon work.

## Event projections

Live state is split into four independent channels; each has a matching
HTTP SSE route and WebSocket notification method.

### Global summary

- HTTP: `GET /api/events/run-summaries`
- WS channel: `run_summary`
- WS notification method: `run.summary`
- Event shapes:
  ```ts
  { type: "summary_upsert", summary: RunSummary }
  { type: "summary_removed", runId: string }
  ```

Drives board cards. The global summary stream is projection-only — it
never carries transcript deltas. `RunSummary` includes persisted
`pinned`, derived `notePresent`, `hookCount`, `runGroupId`, persisted
`schedule`, and derived `scheduleState` so cards and filters can react
without fetching full detail.

### Per-run detail

- HTTP: `GET /api/runs/:runId/events/detail`
- WS channel: `run_detail`
- WS notification method: `run.detail`
- Event carries a full `RunDetail` snapshot.

Drives the detail drawer. Passive backend-session edits publish fresh
`RunDetail` and `RunSummary` projections on changed set/clear operations
because the persisted manifest `updatedAt` changes. Note and pin
mutations also publish both detail and summary updates so the board and
the selected drawer stay synchronized.

`RunDetail` now carries hook data inside the existing payload:

- `resolvedHooks`
- `hookState`
- `hookAudits`

### Per-run timeline

- History (bootstrap): `GET /api/runs/:runId/timeline` →
  `RunTimelineHistory { attempts[], lastCursor }`
- Live SSE: `GET /api/runs/:runId/events/timeline` — envelopes framed
  with `id: <cursor>` for reconnection.
- WS channel: `run_timeline`
- WS notification method: `run.timeline`
- Event shape: `RunTimelineEnvelope { runId, cursor, event }`

Cursor is a monotonic opaque sequence number. The bootstrap flow is:

1. Subscribe to `run_timeline`.
2. Fetch the history once.
3. Apply buffered live envelopes where `cursor > history.lastCursor`.

The daemon retains a short in-memory window of recent timeline events so
late subscribers can catch up during and shortly after a run completes.
Hook executions do not mint new event names. Hook-driven task, note,
pin, and attachment mutations surface through the same summary/detail
channels above, while attempt lifecycle hooks still appear through the
normal timeline envelopes.

A run is the durable lifecycle record. Each backend execution window is a
session: the fresh execution creates session `0`, and each resume creates
the next session. Attempts are backend invocations within a session.
`maxAttemptsPerSession` is the per-session retry budget. Attempt numbers
are monotonic across the run, while `attemptIndexInSession` is zero-based
within its session. Timeline attempt rows expose the monotonic
`attemptNumber`, `sessionIndex`, and `attemptIndexInSession`.

### Per-run audit

- History (bootstrap): `GET /api/runs/:runId/audit` →
  `RunAuditHistory { events[], lastCursor }`
- Live SSE: `GET /api/runs/:runId/events/audit` — envelopes framed with
  `id: <cursor>` for reconnection
- WS channel: `run_audit`
- WS notification method: `run.audit`
- Event shape: `RunAuditEnvelope { runId, cursor, event }`

Audit cursor ordering is monotonic per run. Consumers use the same
bootstrap pattern as timeline: subscribe, fetch history once, then apply
buffered live envelopes where `cursor > history.lastCursor`. Audit
events are compact lifecycle/task records, not transcript deltas.

## Shared DTOs

The contracts shared between CLI, daemon, and web are in
`packages/core/src/contracts/`:

- `RunSummary` — board projection, includes `dependencyState`,
  `activeTask`, `pinned`, `notePresent`, `totalAttemptCount`,
  `totalSessionCount`, `maxAttemptsPerSession`, current/last session
  summaries, `runGroupId`, `hookCount`, and `capabilities`.
- `RunDetail` — drawer projection: tasks, dependencies, dependents,
  attachments, locked fields, runtime vars, session history, backend
  session, `runGroupId`, full `note`, `pinned`, `resolvedHooks`,
  `hookState`, and `hookAudits`.
- `RunCapabilities` — lifecycle gates: `canArchive`, `canUnarchive`,
  `canReset`, `canDelete`, `canReady`, `canResume`, `canAbort`
  (+ `abortReason`), `canReconfigure` (+ `reconfigureReason`), and
  `taskMutation` sub-booleans.
- `RunTimelineHistory` / `RunTimelineEnvelope` — per-run execution
  timeline.

Clients should use capability booleans directly rather than
reimplementing lifecycle checks locally.

## Security model

- Local-only: bind to `127.0.0.1` by default.
- Optional shared bearer token auth protects daemon `/api/*` and
  WebSocket access. It is daemon access protection only: anyone with the
  token has full daemon access.
- The MVP intentionally does not provide per-user isolation or RBAC.
- Remote daemon access still requires transport security such as SSH
  tunnels, HTTPS termination, WireGuard, Tailscale, a VPN, or an
  equivalent trusted channel. The bearer token does not encrypt traffic.
- Tokens and Authorization headers must not be logged.
- No CORS headers. Single-origin; the daemon itself serves the web UI.
- Input validation via Zod schemas. Known control-plane errors return
  HTTP 422; unknown errors return 500.
- Cancellation via `SIGINT` / `SIGTERM`; in-flight local/subprocess runs are
  aborted gracefully, while Codex `ws`/`uds` runs are detached as described in
  startup and shutdown recovery.

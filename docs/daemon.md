# Daemon

`task-runner serve` starts a local control plane. It exposes:

- **WebSocket JSON-RPC** for CLI clients (via `--connect` /
  `TASK_RUNNER_CONNECT`) and for the bundled web UI.
- **HTTP API** for browser clients and scripting.
- **Server-Sent Events (SSE)** for live summary, detail, and timeline
  projections.
- **Static assets** for the bundled web dashboard out of the same port.

The daemon is local infrastructure, not a multi-user remote service: no
auth, no CORS, bind to `127.0.0.1` by default.

## Starting the daemon

```bash
task-runner serve [--listen <ws-url>]
```

- `--listen <ws-url>` — defaults to `ws://127.0.0.1:4773/` (or
  `TASK_RUNNER_LISTEN`).
- Prints `serving on <ws-url>` and `http api on <http-base-url>/api/`.
- HTTP base URL is derived from the listen URL by substituting `ws` →
  `http`.
- Graceful shutdown on `SIGINT` (exit 130) and `SIGTERM` (exit 0).

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

- **Embedded** — no `--connect`, no `TASK_RUNNER_CONNECT`. The CLI
  executes the command directly in-process.
- **Connected** — `--connect <ws-url>` (or `TASK_RUNNER_CONNECT` env).
  The CLI opens a WebSocket, makes JSON-RPC calls, and prints the
  response.

Connected mode can optionally add an invocation-scoped SSH tunnel:

- `--connect-host <host>` (or `TASK_RUNNER_CONNECT_HOST`) tells the CLI
  to run `ssh -N -L 127.0.0.1:<local-port>:<daemon-host>:<daemon-port>`
  before it dials the daemon.
- `--connect-local-port <port>` (or `TASK_RUNNER_CONNECT_LOCAL_PORT`)
  overrides the loopback port used for that local forward. Without it,
  the CLI reuses the daemon port from `--connect`.
- The logical `--connect` URL remains the user-facing daemon address in
  status output and error hints; the tunneled loopback URL is internal.
- This helper is per-invocation only. Advanced SSH behavior such as jump
  hosts, identities, or multiplexing belongs in the user's SSH config.
- `task-runner serve` is still local-only infrastructure and rejects
  `--connect`, `--connect-host`, and `--connect-local-port`.

Connected mode is how multiple terminals can share state and how the web
UI and CLI stay in sync. `run --detach` only works in connected mode.

Connected-mode runtime selection stays explicit:

- the client does not forward arbitrary env vars to the daemon
- if the client has `TASK_RUNNER_CODEX_WS_URL` set, `run`, `init`, and
  `resume` synthesize
  `overrides.backendSpecific.codex.transport = { type: "ws", url }`
- if the client passes `--launcher <name>`, the daemon resolves that
  named launcher against its own config root and freezes the result into
  the manifest
- malformed Codex transport overrides are rejected at the daemon request
  boundary before any run is created
- malformed launcher overrides are rejected at the same request boundary

That special case exists only for Codex transport selection. Launcher
override handling is still explicit and named-only; no generic
daemon-side env passthrough exists for other backends.

## HTTP API

All routes are under `/api/`.

### Daemon

- `GET /api/daemon` → `{ daemon: DaemonInfo }`

### Runs

| Method | Path | Effect |
|--------|------|--------|
| `GET` | `/api/runs` | List runs. Query: `includeArchived`, `cwd`, `repo`, `global` |
| `GET` | `/api/runs/:runId` | Full `RunDetail` (including frozen hook descriptors/state/audits when present) |
| `POST` | `/api/runs/init` | Initialize a run |
| `POST` | `/api/runs` | Start a run |
| `POST` | `/api/runs/:runId/resume` | Resume an initialized/terminal run |
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
| `POST` | `/api/runs/:runId/dependencies` | Add a dependency |
| `DELETE` | `/api/runs/:runId/dependencies/:depRunId` | Remove a dependency |
| `POST` | `/api/runs/:runId/dependencies/clear` | Clear all dependencies |

### Tasks

| Method | Path | Effect |
|--------|------|--------|
| `GET` | `/api/runs/:runId/tasks` | List tasks |
| `GET` | `/api/runs/:runId/tasks/:taskId` | Single task |
| `PATCH` | `/api/runs/:runId/tasks/:taskId` | Update status and/or notes |
| `POST` | `/api/runs/:runId/tasks/:taskId/append-notes` | Append to notes |
| `POST` | `/api/runs/:runId/tasks` | Add a task |

### Attachments

| Method | Path | Effect |
|--------|------|--------|
| `GET` | `/api/runs/:runId/attachments` | List. Query: `cwdScope=true` for cwd-scoped group view |
| `POST` | `/api/runs/:runId/attachments` | Upload; requires `x-task-runner-attachment-name` header |
| `DELETE` | `/api/runs/:runId/attachments/:attachmentId` | Delete |
| `GET` | `/api/runs/:runId/attachments/:attachmentId/content` | Download; sets `content-disposition`, `x-task-runner-attachment-id`, `x-task-runner-sha256` |

### Streams

| Path | Stream |
|------|--------|
| `GET /api/events/run-summaries` | Global summary SSE |
| `GET /api/runs/:runId/events/detail` | Per-run detail SSE |
| `GET /api/runs/:runId/timeline` | Per-run timeline history (JSON, plus `lastCursor`) |
| `GET /api/runs/:runId/events/timeline` | Per-run timeline SSE (live envelopes with SSE `id: <cursor>`) |

### App config

- `GET /app-config.json` → `{ apiBasePath, runSummaryEventsPath }`

The web UI fetches this before initialization. Per-run detail and
timeline paths are derived from `apiBasePath` and the active run id.

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
- `runs.init`, `runs.start`, `runs.resume`, `runs.abort`
- `runs.archive`, `runs.unarchive`, `runs.reset`, `runs.delete`
- `runs.setName`, `runs.setNote`, `runs.setPinned`
- `runs.setBackendSession`, `runs.clearBackendSession`
- `runs.addDependency`, `runs.removeDependency`, `runs.clearDependencies`

**Tasks**

- `tasks.list`, `tasks.get`, `tasks.set`, `tasks.appendNotes`, `tasks.add`

**Definitions**

- `agents.list`, `agents.get`
- `assignments.list`, `assignments.get`
- `launchers.list`, `launchers.get`

**Subscriptions**

- `events.subscribe { channel, runId? }` — returns `{ subscriptionId }`
- `events.unsubscribe { subscriptionId }`

Valid `channel` values: `"run_summary"`, `"run_detail"`,
`"run_timeline"`. Detail and timeline require a `runId`.

## Event projections

Live state is split into three independent channels; each has a matching
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
never carries transcript deltas. `RunSummary` now includes persisted
`pinned`, derived `notePresent`, and `hookCount` so cards and filters
can react without fetching full detail.

### Per-run detail

- HTTP: `GET /api/runs/:runId/events/detail`
- WS channel: `run_detail`
- WS notification method: `run.detail`
- Event carries a full `RunDetail` snapshot.

Drives the detail drawer. Passive backend-session edits are detail
mutations: the daemon publishes a fresh `RunDetail` on set/clear. Note
and pin mutations publish both detail and summary updates so the board
and the selected drawer stay synchronized.

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

## Shared DTOs

The contracts shared between CLI, daemon, and web are in
`packages/core/src/contracts/`:

- `RunSummary` — board projection, includes `dependencyState`,
  `activeTask`, `pinned`, `notePresent`, `hookCount`, and
  `capabilities`.
- `RunDetail` — drawer projection: tasks, dependencies, dependents,
  attachments, locked fields, runtime vars, session history, backend
  session, full `note`, `pinned`, `resolvedHooks`, `hookState`, and
  `hookAudits`.
- `RunCapabilities` — lifecycle gates: `canArchive`, `canUnarchive`,
  `canReset`, `canDelete`, `canResume`, `canAbort` (+ `abortReason`),
  and `taskMutation` sub-booleans.
- `RunTimelineHistory` / `RunTimelineEnvelope` — per-run execution
  timeline.

Clients should use capability booleans directly rather than
reimplementing lifecycle checks locally.

## Security model

- Local-only: bind to `127.0.0.1` by default.
- No authentication. Assumes a trusted local machine.
- No CORS headers. Single-origin; the daemon itself serves the web UI.
- Input validation via Zod schemas. Known control-plane errors return
  HTTP 422; unknown errors return 500.
- Cancellation via `SIGINT` / `SIGTERM`; in-flight runs are aborted
  gracefully.

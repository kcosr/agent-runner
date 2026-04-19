# Daemon and control plane

task-runner runs in one of two host modes:

- **Embedded mode** — the foreground CLI process owns execution and
  calls the shared app services in-process. This is the default when
  you don't pass `--connect` or set `TASK_RUNNER_CONNECT`.
- **Daemon mode** — a long-lived local `task-runner serve` process
  owns live-run execution, event streaming, and external abort
  control. CLI commands route through WebSocket JSON-RPC; browser
  clients use HTTP + SSE on the same listener.

The daemon is local-only and exists to stabilize run control and future
local clients, not to become a remote multi-user service.

## Starting the daemon

```bash
task-runner serve
task-runner serve --listen ws://127.0.0.1:4773/
```

Rules:

- `--listen` overrides `TASK_RUNNER_LISTEN`; both fall back to
  `ws://127.0.0.1:4773/`.
- The daemon keeps the JSON-RPC 2.0 WebSocket control plane for CLI
  clients.
- The same listener also serves browser-facing HTTP endpoints under
  `/api/...` and split live SSE streams (run-summary, per-run detail,
  per-run timeline) — see [Live event subscriptions](#live-event-subscriptions).
- The health payload carries a stable `daemonInstanceId`, and
  daemon-projected run DTOs expose persisted `execution` provenance
  plus daemon-local abort capability (`canAbort`, `abortReason`).
- Run-scoped commands, `list runs`, and definition read commands opt
  into daemon mode with `--connect <ws-url>` or `TASK_RUNNER_CONNECT`.
- External live abort control exists only in daemon mode.

## Transport split

- CLI uses the WebSocket JSON-RPC transport.
- Browser/local web code should use HTTP for normal request/response
  and SSE for live updates — see [Live event subscriptions](#live-event-subscriptions).
- A default listener such as `ws://127.0.0.1:4773/` therefore also
  exposes HTTP at `http://127.0.0.1:4773/api/`.
- The same host also serves the built web app and runtime config:
  `http://127.0.0.1:4773/` for the SPA and
  `http://127.0.0.1:4773/app-config.json` for the frontend config
  payload. The config exposes `apiBasePath` and
  `runSummaryEventsPath`; per-run detail and timeline paths are
  derived from `apiBasePath` and the active run id.

## Live event subscriptions

Live surfaces are split by responsibility instead of sharing a single
mixed event bus. That lets the board/detail projections stay
manifest-canonical while keeping execution transcripts as a separate
per-run surface.

| Responsibility | HTTP SSE endpoint | WebSocket channel | Notification method | Payload |
|---|---|---|---|---|
| Global run-summary feed (board cards) | `GET /api/events/run-summaries` | `events.subscribe { channel: "run_summary" }` | `run.summary` | `summary_upsert` carrying a fresh `RunSummary` |
| Selected-run detail feed (drawer / `status` consumers) | `GET /api/runs/:runId/events/detail` | `events.subscribe { channel: "run_detail", runId }` | `run.detail` | `detail_updated` carrying a fresh `RunDetail` |
| Selected-run execution timeline (agent transcript) | `GET /api/runs/:runId/events/timeline` | `events.subscribe { channel: "run_timeline", runId }` | `run.timeline` | One `RunTimelineEvent` per message (e.g. `agent_message_delta`) |

Rules:

- The global summary stream is **projection-only** and does not carry
  transcript deltas. Subscribers hydrate board cards from
  `RunSummary` snapshots.
- Per-run detail and timeline streams are scoped to a single run id
  at subscribe time.
- Both `RunSummary` and `RunDetail` expose a derived `activeTask`
  projection so consumers can render the current in-progress task
  label without re-scanning the task array.
- `events.unsubscribe { subscriptionId }` tears down a WebSocket
  subscription; closing the SSE connection is the HTTP equivalent.

See [web-dashboard.md](web-dashboard.md) for the browser UI hosted on
top of this transport.

## Connecting CLI clients

```bash
# Per-command
task-runner run --connect ws://127.0.0.1:4773/ --agent ... --assignment ...

# Process-wide
export TASK_RUNNER_CONNECT=ws://127.0.0.1:4773/
task-runner run --agent ... --assignment ...
```

If nothing is listening at `--connect` / `TASK_RUNNER_CONNECT`, the
command fails with exit code `3`; it does not silently fall back to
embedded mode.

## Detached dispatch

`task-runner run --detach ...` and `task-runner run --detach
--resume-run <id>` send `runs.start` / `runs.resume` to the daemon and
return immediately after the daemon responds with a `runId`. Detached
mode does **not** wait for `run_finished`, does not stream run events,
and does not change any manifest/session semantics.

Attached behavior (stream events until run_finished) remains the
default — omit `--detach` and a daemon-connected `run` blocks and
streams normally.

## Execution provenance

`RunDetail.execution` records the persisted execution context for the
latest stored session:

- Embedded runs record `{ hostMode: "embedded", controller: { kind: "embedded" } }`.
- Daemon-run sessions record daemon ownership and the daemon instance id.

Resume rewrites this block to the controller that most recently ran
the session, so `status` and the web dashboard always reflect who owns
the live session (if any).

Capabilities:

- `canAbort` / `abortReason` — daemon-owned active runs are the only
  runs that accept external abort.
- Terminal runs: `canAbort=false`, `abortReason="already_terminal"`.
- Nonterminal runs that are merely persisted rather than actively
  owned by the serving daemon: `canAbort=false`,
  `abortReason="not_active_in_daemon"`.

## Protocol surfaces

- **WebSocket JSON-RPC 2.0** (CLI): `runs.start`, `runs.resume`,
  `runs.abort`, `runs.reset`, `runs.archive`, `runs.unarchive`,
  `runs.setName`, `runs.brief`, `runs.addDependency`,
  `runs.removeDependency`, `runs.clearDependencies`, `tasks.set`,
  `tasks.appendNotes`, `tasks.add`, `attachments.add`,
  `attachments.list`, `attachments.remove`, `attachments.download`,
  `agents.list`, `assignments.list`, `agents.show`,
  `assignments.show`, `runs.list`, `runs.get`, plus
  `events.subscribe` / `events.unsubscribe` for live updates. See
  [Live event subscriptions](#live-event-subscriptions) for channel
  semantics. Attachment byte transfers fall back to HTTP rather than
  riding the WebSocket.
- **HTTP** (`/api/...`): the same surface for browser clients, plus
  attachment byte uploads/downloads and the split SSE endpoints for
  run-summary, per-run detail, and per-run timeline streams.

The authoritative protocol contracts live in
`packages/core/src/contracts/` and the daemon routes in
`apps/cli/src/daemon/`.

## Health

A basic health endpoint returns the daemon instance id:

```bash
curl http://127.0.0.1:4773/api/health
```

Restarting `task-runner serve` generates a new `daemonInstanceId`, so
clients can distinguish the "same daemon still up" case from "a
different daemon took over this port".

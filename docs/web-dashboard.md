# Web Dashboard

The bundled web dashboard lives in `apps/web`. It is a React app built
with Vite, served by the daemon over the same listen address as the HTTP
API. It is a client of the daemon only — there is no standalone mode.

## Running the dashboard

1. Start the daemon:
   ```bash
   task-runner serve
   ```
2. Open the HTTP base URL printed on startup (e.g.
   `http://127.0.0.1:4773/`).

The daemon serves the bundled assets plus `GET /app-config.json`, which
tells the UI where to reach the API (`apiBasePath`) and summary event
stream (`runSummaryEventsPath`). All other endpoints are derived from
those plus the active run id.

## Views

- `/` — Runs dashboard (board + detail drawer).
- `/runs/:runId` — Same dashboard with a specific run's detail drawer
  open.
- `/settings/general` — General preferences.
- `/settings/keybindings` — Keyboard shortcut reference.

### Runs dashboard

A three-pane layout:

- **Left** — filters, repo selector, preference toggles.
- **Center** — kanban board grouped by run status.
- **Right** — resizable detail drawer (hidden by default until you select
  a run).

### Board

The board groups runs into status columns (pending, running, terminal
variants). Cards are populated from the global `RunSummary` SSE stream,
so state stays live without polling.

Each card shows:

- Run name (or assignment name if unnamed).
- Status badge and task progress (e.g. `3 / 7`).
- Dependency readiness icon (warning if unsatisfied).
- Attachment count.
- Active task label when the run is running (from the derived
  `activeTask` projection on `RunSummary`/`RunDetail`).

Above the board, a **jump strip** exposes only the currently rendered
non-empty columns and scrolls them into view when the board overflows
horizontally.

Motion animations highlight insertions and reorders. Empty columns can
be auto-hidden.

### Detail drawer

Opening a run subscribes to its detail stream (`RunDetail`) and its
timeline stream (`RunTimelineEnvelope`). The drawer surfaces:

- Header: run id, editable display name, status badge, capability-gated
  action buttons, and a full-width toggle (desktop only) that expands
  the drawer to fill the main content area while keeping the top bar
  and left sidebar interactive.
- Tasks tab: expandable task rows with inline notes and status editing,
  gated by `taskMutation` capabilities.
- Attachments tab: **Run** and **Group** sub-tabs. Group is read-only and
  aggregates by persisted cwd. In-app preview is available for
  `text/markdown` and `text/plain` attachments; fenced `mermaid` blocks
  render inline (with an inline error if a diagram fails to load). The
  attachment preview drawer is itself resizable (edge drag or keyboard
  handle) and supports the same full-width toggle as the detail drawer.
  See [attachments.md](attachments.md).
- Dependencies tab: upstream and downstream runs (`RunDependencyDetail`).
- Timing tab: attempt and session history.
- Events tab: live terminal/transcript view from the timeline stream.

## Live projections

The dashboard consumes three independent streams:

| Stream | Source | Consumer |
|--------|--------|----------|
| `run_summary` | `/api/events/run-summaries` | Board cards |
| `run_detail` | `/api/runs/:runId/events/detail` | Drawer header, tabs |
| `run_timeline` | `/api/runs/:runId/events/timeline` (+ `/timeline` history) | Events tab |

The timeline stream uses a monotonically increasing cursor for ordering
and reconnect safety. The detail drawer delays its initial fetch by a
short debounce to avoid flashing when the user is tabbing through cards
quickly; a "settling" indicator appears until the first snapshot lands.

If the summary stream drops, the board shows a stale banner with a
retry button. Reconnects reconcile through the cached query state.

## Capability-gated actions

Every action button consults the run's `RunCapabilities`:

| Button | Gate |
|--------|------|
| Archive | `canArchive` |
| Unarchive | `canUnarchive` |
| Reset | `canReset` |
| Delete | `canDelete` (archived only) |
| Resume | `canResume` and dependency readiness |
| Abort | `canAbort` (with `abortReason` when disabled) |
| Edit backend session | passive runs only |
| Add/remove dependency | initialized runs only |
| Task status dropdown | `taskMutation.canSetStatus` |
| Task notes input | `taskMutation.canEditNotes` |
| Add task button | `taskMutation.canAdd` |

Destructive actions (delete, reset, abort) use inline confirmations
rather than modal prompts.

## Keyboard shortcuts

The dashboard's shortcut system is customizable from
`/settings/keybindings`. Default bindings:

| Shortcut | Action |
|----------|--------|
| `/` or `Ctrl+K` | Focus search |
| `Esc` (in search) | Clear search and blur |
| `Esc` (drawer open) | Close drawer |
| `Esc` (attachment preview) | Back to attachments |
| `Enter` | Primary action for the selected card (Resume, etc.) |
| `↑` / `↓` / `←` / `→` | Move the board selection |

Shortcuts are suppressed while typing in inputs or when a modal dialog
is open.

## Preferences

Preferences are persisted to `localStorage` and include:

- Hide empty columns.
- Collapse failure states into a single column.
- Sort by recent updates.
- Show archived runs.
- Detail drawer width.

## Development

The web package is a workspace under `apps/web`.

```bash
# In one terminal: run the daemon the dashboard talks to.
task-runner serve

# In another terminal: start the Vite dev server (proxies /api to the daemon).
cd apps/web
npm run dev
```

The dev server listens on port 4174 and proxies `/api` and
`/app-config.json` to `TASK_RUNNER_WEB_PROXY_TARGET` (default
`http://127.0.0.1:4773`).

Build and tests:

```bash
npm run build    # tsc --noEmit && vite build (output to dist/)
npm run test     # vitest run
```

The production build is bundled and served by `task-runner serve`; there
is no standalone web server in the shipped runtime.

## Data flow summary

1. App boots and fetches `/app-config.json` for the API paths.
2. Subscribes to the global summary stream; mutations arrive as
   `summary_upsert` / `summary_removed` events and update the
   TanStack React Query cache.
3. Selecting a run subscribes to its detail and timeline streams.
4. User actions call the HTTP API; responses feed the cache and the
   daemon broadcasts matching detail/summary updates back to all
   subscribers.
5. `RunCapabilities` on each projection decides which buttons are
   enabled, which keeps the UI consistent with the CLI and daemon.

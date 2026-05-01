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

## Daemon Token

If the daemon was started with `TASK_RUNNER_DAEMON_AUTH_ENABLED=true`,
open Settings -> General and enter the shared daemon token. The dashboard
stores the trimmed value in `localStorage` under
`task-runner.daemonToken`. Save updates future API, attachment, and SSE
requests without a page reload; Clear removes the stored value and future
requests omit Authorization.

The web client sends the token as:

```http
Authorization: Bearer <token>
```

It never puts daemon tokens in URLs or query strings. `/app-config.json`
and static assets remain public so the app can load, but `/api/*`,
attachment content, and header-capable SSE requests require the bearer
token when daemon auth is enabled. Unauthorized run-list or run-detail
responses show a token-required state with navigation to Settings.

This is daemon access protection only. Anyone with the token has full
daemon access, and the MVP intentionally does not provide per-user
isolation. Do not log tokens or Authorization headers. For remote access,
serve the dashboard over SSH tunnels, HTTPS, WireGuard, Tailscale, a VPN,
or an equivalent secure transport; the token does not encrypt traffic.

The dashboard gets run-input metadata from the daemon. Backend choices
include built-ins plus custom backends already loaded by the daemon, but
normal run detail/status DTOs do not expose the run's frozen
`backendConfig` or `resolvedBackendArgs`.

## Views

- `/` — Runs dashboard with Board, Chat, Detail, Notes, and Tasks surfaces.
- `/runs/:runId` — Same dashboard with a specific run selected for the
  selected-run surfaces.
- `/settings/general` — General preferences.
- `/settings/keybindings` — Keyboard shortcut reference.

### Runs dashboard

A multi-surface workspace:

- **Left** — search, grouped Filters control, and preference toggles.
- **Center** — Board, the kanban run list grouped by run status.
- **Right** — one selected-run panel with Chat, Detail, Notes, and Tasks tabs.

Board is always visible. Selecting a run opens one resizable selected-run
panel. Its header owns the run identity plus action toolbar, and the tabs
below the toolbar switch between Chat, Detail, Notes, and Tasks. Chat does not
create a separate chat route or backend chat contract; it follows the
selected run, derives messages from `RunDetail` plus timeline history,
and streams live output through the existing timeline stream.

Closing the selected-run panel navigates back to `/` and clears the
selected run. Chat, Detail, Notes, and Tasks tab choice persists as the active right
surface.

Dashboard view state persists the durable surface layout fields:
collapsed board columns, selected-run panel width, and the active
Chat/Detail/Notes/Tasks tab. Search text, fullscreen state, per-run drawer tabs, and
the active board column remain transient.

On desktop layouts, the selected-run panel renders inline to the right of
the board. On narrow mobile layouts, the selected-run panel becomes an
in-layout sheet over the board.

The grouped **Filters** control opens an anchored popover on desktop and a
sheet-style overlay on narrow/mobile layouts. It applies exact-match
structured filters for repo, agent, backend, and run group, while
free-text search remains separate. Structured filter state persists
across reloads, and the repo/agent/backend badges plus the run-group
chip on run cards act as shortcuts that apply, replace, or clear those
exact-match filters.

Dashboard preferences also persist `showPinnedOnly`. The toolbar and
Settings > General expose the same toggle, and both stay synchronized
through the shared preferences store.

### Board

The board groups runs into status columns (`Initialized`, `Ready`,
`Running`, and terminal variants). Cards are populated from the global
`RunSummary` SSE stream, so state stays live without polling.

Each card shows:

- Run name (or assignment name if unnamed).
- Status badge and task progress (e.g. `3 / 7`).
- Run-group chip (`runGroupId/runId`); clicking it scopes the board to
  that run group.
- Pin toggle plus note affordance.
- Compact schedule indicator when `schedule` is present. Future
  schedules render as normal, paused schedules as muted, and due
  schedules as warning.
- Dependency readiness icon (warning if unsatisfied).
- Attachment count.
- Active task label when the run is running (from the derived
  `activeTask` projection on `RunSummary`/`RunDetail`).

Pinned runs sort first within their current status column while still
using the active column comparator inside the pinned and unpinned
buckets. Pinning does not move a run across columns.

The board has one global sort field and direction, applied independently
inside every status column after pinned-first bucketing. The sortable
fields are started time, last updated, and ended time. Last updated uses
the canonical `RunSummary.updatedAt` timestamp from the manifest, not
event arrival order. Ended-time sorting keeps active runs with no
`endedAt` last in both directions.

The note affordance opens a rendered-markdown preview on desktop
hover/focus when a note exists, and clicking/tapping opens the shared
note editor. Desktop defaults that editor to **Edit** mode; touch-style
layouts default to **Preview** mode first.

Above the board, a **jump strip** exposes only the currently rendered
non-empty columns and scrolls them into view when the board overflows
horizontally.

Motion animations highlight insertions and reorders. Empty columns can
be auto-hidden.

### Detail drawer

Opening a run subscribes to its detail stream (`RunDetail`). Attempts
timeline history and Audit history start only when those tabs are first
opened, then keep their streams active while that run remains selected.
The drawer surfaces:

- Header: run id, editable display name, status badge, capability-gated
  action buttons, and a full-width toggle (desktop only) that expands
  the drawer to fill the main content area while keeping the top bar
  and left sidebar interactive.
- Summary metadata: top-level run metadata plus full-width `CWD`,
  `Workspace`, and passive `Backend session` rows with inline copy/edit
  affordances. Completed runs also surface `Ended` and `Exit code`
  directly in the summary.
- Schedule section when the run has a schedule. It shows enabled/paused
  state, derived schedule state, next run time, one-time versus
  recurring kind, humanized recurrence, raw cron, timezone, recurrence
  mode, and continue-on-failure. The drawer can enable/disable existing
  schedules and clear one-time schedules; recurring schedules can be
  disabled but not cleared.
- Run group metadata and editor. Non-running runs can be moved into a
  different group or reset to their singleton group.
- Notes surface: rendered markdown by default, an Edit action that exposes
  save/cancel controls, and the same shared note mutation used by the card
  editor. `N` opens the surface; pressing `N` again focuses the editor.
- Tasks surface: expandable task rows with inline notes and status editing,
  gated by `taskMutation` capabilities.
- Attachments tab: one combined group-scoped list. Rows show
  `ownerRunId`; selected-run attachments can be uploaded, previewed,
  downloaded, and deleted, while attachments owned by other runs in the
  group are read-only but still support preview and download. In-app
  preview is available for `text/markdown` and `text/plain`
  attachments; fenced `mermaid` blocks render inline (with an inline
  error if a diagram fails to load). The attachment preview drawer is
  itself resizable (edge drag or keyboard handle) and supports the same
  full-width toggle as the detail drawer. See [attachments.md](attachments.md).
- Dependencies tab: upstream and downstream run and group dependency
  details (`RunDependencyDetail` / `RunDependentDetail`).
- Data tab: read-only `Vars` and `Hook state` subtabs exposing
  `RunDetail.runtimeVars` and `RunDetail.hookState`. Scalar values render
  inline; objects and arrays render as pretty JSON blocks. When
  `canReconfigure` is true, initialized runs can edit vars inline;
  redacted values are omitted from the patch unless explicitly replaced.
- Attempts tab: attempt history plus prompt/response/diagnostics detail
  for non-passive runs from the timeline stream. On initialized runs with
  `canReconfigure`, the message tab can edit the initial run message.
  Failed saves keep drafts open with the daemon error visible. On narrow layouts, the
  top-level drawer section tabs stay on one line and scroll horizontally
  instead of wrapping.

A run is the durable lifecycle record. Each backend execution window is a
session: the fresh execution creates session `0`, and each resume creates
the next session. Attempts are backend invocations within a session.
`maxAttemptsPerSession` is the per-session retry budget. Attempt numbers
are monotonic across the run, while `attemptIndexInSession` is zero-based
within its session. The Attempts tab groups timeline rows by session and
labels each row with its monotonic attempt number plus session-local
attempt position.

The Detail Attempts tab remains the operational timeline view. It shares
the same timeline state as Chat, so opening Chat can activate timeline
history and streaming without starting a duplicate timeline subscription.

### Chat

Chat renders the selected run as a conversational thread derived from
`RunDetail` plus timeline history. Before the first attempt starts,
initialized and ready runs with a non-empty `pendingPrompt` show that
pending prompt as a muted System card labeled `Pending prompt`; runs
without a pending prompt keep the empty conversation state. Once timeline
history contains the first real attempt, Chat renders session 0 attempt 0
from `attempt.prompt` as a normal System card, even when the run has an
initial message, because before-attempt hooks may rewrite the prompt. Later
resume sessions keep their stored session message as a user bubble, and
automatic follow-up or retry prompts continue to render as System cards.
Chat shows the existing loading skeleton until timeline history is available,
so detail-only run/session messages do not appear as standalone user bubbles
before the matching attempt/assistant row can be projected. Assistant output
renders each attempt transcript chronologically and inline, without a bubble,
so the thread reads like output with user interjections and automatic
follow-up prompts. User bubbles preserve their text verbatim. Backend notices
and diagnostics stay out of Chat.

When selected-run attachments were added during an attempt window, Chat
synthesizes artifact cards at the end of that assistant response from the
current `RunDetail.attachments` list and timeline attempt timestamps.
Previewable cards open the existing attachment preview drawer, and every
card can use the existing browser download flow. Removing an attachment from
the selected run removes its synthesized Chat card on the next detail
projection.

The composer is fixed at the bottom of the Chat panel for a selected
run. For resumable non-live runs, it sends only non-empty trimmed
messages through the existing resume API, using the same resume mutation
path as the Detail Resume dialog. For live runs, the composer switches
to Queue mode and appends normalized text to the run's queued resume
messages instead of trying to resume an active backend session. The
queued panel shows the current count and allows removing individual
queued messages. The composer submits from the Send button or
`Cmd/Ctrl+Enter`. Success clears the draft and lets live timeline output
or the queued panel update appear in Chat; failure keeps the draft
visible with the daemon error in the panel. No selected run disables the
text field. Runs that cannot resume and pending resume requests keep the
draft editable but disable submission. The Detail Resume dialog remains
available for existing resume flows, including resume-without-message
where allowed.

## Live projections

The dashboard consumes four independent streams:

| Stream | Source | Consumer |
|--------|--------|----------|
| `run_summary` | `/api/events/run-summaries` | Board cards |
| `run_detail` | `/api/runs/:runId/events/detail` | Drawer header, tabs |
| `run_audit` | `/api/runs/:runId/events/audit` (+ `/audit` history) | Audit tab |
| `run_timeline` | `/api/runs/:runId/events/timeline` (+ `/timeline` history) | Attempts tab and Chat |

The timeline and audit streams both use monotonically increasing cursors
for ordering and reconnect safety after their tabs are first opened. Those
streams remain active while the run stays selected. The detail drawer delays
its initial fetch by a short debounce to avoid flashing
when the user is tabbing through cards quickly; a "settling" indicator
appears until the first snapshot lands.

If the summary stream drops, the board shows a stale banner with a
retry button. Reconnects reconcile through the cached query state.

Hook-visible state follows the same summary/detail channels. The board
can observe `RunSummary.hookCount`, and the drawer's backing `RunDetail`
includes `resolvedHooks`, `hookState`, and `hookAudits`. The drawer now
surfaces `runtimeVars` and `hookState` through the read-only `Data` tab;
the top-level `Audit` tab renders compact lifecycle/task history from the
audit stream; hook-driven task, note, pin, and attachment mutations still
appear live because they reuse the existing summary/detail/audit/timeline
caches.

## Capability-gated actions

Every action button consults the run's `RunCapabilities`:

| Button | Gate |
|--------|------|
| Archive | `canArchive` |
| Unarchive | `canUnarchive` |
| Reset | `canReset` |
| Delete | `canDelete` (archived only) |
| Primary action (`Ready`, `Start`, or `Resume`) | `canReady` for `Ready`; `canResume` for `Start` / `Resume` |
| Abort | `canAbort` (with `abortReason` when disabled) |
| Edit vars/message | `canReconfigure` |
| Edit backend session | passive runs only |
| Add/remove dependency | initialized runs only |
| Enable/disable schedule | existing schedule |
| Clear schedule | one-time schedule only |
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
| `Esc` (in chat composer) | Blur the composer without closing the drawer |
| `Esc` (drawer open) | Close drawer |
| `Esc` (attachment preview) | Back to attachments |
| `Enter` | Primary action for the selected card (Resume, etc.) |
| `↑` / `↓` / `←` / `→` | Move the board selection |
| `Ctrl+Shift+F` | Toggle Filters panel |
| `Ctrl+Shift+P` | Toggle pinned-only filter |
| `Ctrl+Shift+N` | Toggle notes-only filter |
| `Ctrl+Shift+A` | Toggle archived filter |
| `Ctrl+Shift+E` | Toggle hide-empty-columns |
| `P` | Pin or unpin the selected run |
| `C` | Show the selected run's Chat tab, or focus its composer when Chat is open |
| `D` | Show the selected run's Detail tab |
| `N` | Show the selected run's Notes tab, or focus its editor when Notes is open |
| `T` | Show the selected run's Tasks tab |
| `A` | Archive or restore the selected run |
| `F` | Toggle the detail drawer fullscreen |

Shortcuts are suppressed while typing in inputs or when a modal dialog
is open. Native modal dialogs, including Resume and the run-note editor,
handle Escape/back dismissal before dashboard shortcuts.

When the detail drawer is fullscreen, selected-run shortcuts including
`Enter`, `N`, `P`, `A`, and `C`/`D`/`N`/`T` remain active. Board movement,
search, and filter shortcuts remain suppressed in fullscreen drawer
mode. Attachment preview keeps only surface navigation, fullscreen
toggle, and Escape shortcuts active so hidden header actions do not fire.
If the primary action opens the Resume dialog, the dialog appears above
the fullscreen drawer or preview surface. While the Resume or run-note
dialog is open, the first `Esc` closes the dialog; later presses follow
the existing fullscreen and drawer close behavior.

## Preferences

Preferences are persisted to `localStorage` and include:

- Hide empty columns.
- Collapse failure states into a single column.
- Board sort field (`startedAt`, `updatedAt`, or `endedAt`) and direction
  (`desc` or `asc`).
- Show archived runs.
- Show runs with notes only.
- Show pinned runs only.
- Structured filters (repo, agent, backend, run group).
- Visible focus indicators.
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
2. Reads the optional Settings -> General daemon token and attaches it as
   an Authorization bearer header on API, attachment, and fetch-backed SSE
   requests.
3. Subscribes to the global summary stream; mutations arrive as
   `summary_upsert` / `summary_removed` events and update the
   TanStack React Query cache. Board sorting is recomputed from cached
   canonical summary timestamps.
4. Selecting a run subscribes to its detail stream; opening Attempts or
   Audit starts the corresponding history load and live stream, which remain
   active while that run stays selected.
5. User actions call the HTTP API; responses feed the cache and the
   daemon broadcasts matching detail/summary updates back to all
   subscribers.
6. `RunCapabilities` on each projection decides which buttons are
   enabled, which keeps the UI consistent with the CLI and daemon.

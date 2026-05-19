# Web Dashboard

The bundled web dashboard lives in `apps/web`. It is a React app built
with Vite, served by the daemon over the same listen address as the HTTP
API. It is a client of the daemon only — there is no standalone mode.

## Running the dashboard

1. Start the daemon:
   ```bash
   agent-runner serve
   ```
2. Open the HTTP base URL printed on startup (e.g.
   `http://127.0.0.1:4773/`).

The daemon serves the bundled assets plus `GET /app-config.json`, which
tells the UI the configured web mount path (`webBasePath`). The browser
derives API and event stream paths from that base path.

## Daemon Token

If the daemon was started with `AGENT_RUNNER_DAEMON_AUTH_ENABLED=true`,
open Settings -> General and enter the shared daemon token. The dashboard
stores the trimmed value in `localStorage` under
`agent-runner.daemonToken`. Save updates future API, attachment, and SSE
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

- `/` — Runs dashboard with Board/List plus Chat, Detail, Notes, Tasks,
  and Attachments selected-run surfaces.
- `/runs/:runId` — Same dashboard with a specific run selected for the
  selected-run surfaces.
- `/settings/general` — General preferences.
- `/settings/keybindings` — Keyboard shortcut reference.

### Runs dashboard

A multi-surface workspace:

- **Left** — search, grouped Filters control, and preference toggles.
- **Center** — Board or List, switchable from the toolbar.
- **Right** — one selected-run panel with Chat, Detail, Notes, Tasks,
  and Attachments tabs.

The center surface defaults to Board. The toolbar view-mode toggle switches
between Board and List, and the durable mode choice persists in
`agent-runner:web:dashboard-view-state.viewMode`. Selecting a run opens one
resizable selected-run panel. Its header owns the run identity plus action
toolbar, and the tabs below the toolbar switch between Chat, Detail,
Notes, Tasks, and Attachments. Chat does not create a separate chat route
or backend chat contract; it follows the selected run, derives messages
from `RunDetail` plus timeline history, and streams live output through
the existing timeline stream.

Closing the selected-run panel navigates back to `/` and clears the
selected run. Chat, Detail, Notes, Tasks, and Attachments tab choice
persists as the active right surface.

Dashboard view state persists the durable surface layout fields:
center-surface view mode, collapsed board columns, selected-run panel width,
fullscreen state, and the active Chat/Detail/Notes/Tasks/Attachments tab.
Search text, per-run drawer tabs, the active board column, and the active
list status chip remain transient.

On desktop layouts, the selected-run panel renders inline to the right of
the center surface. On narrow mobile layouts, the selected-run panel becomes
an in-layout sheet over the center surface.

The grouped **Filters** control opens an anchored popover on desktop and a
sheet-style overlay on narrow/mobile layouts. It applies exact-match
structured filters for repo, agent, backend, and run group, while
free-text search remains separate. Structured filter state persists
across reloads, and the repo/agent/backend badges plus the run-group
chip on run cards act as shortcuts that apply, replace, or clear those
exact-match filters.

Dashboard preferences also persist `showPinnedOnly` and theme mode.
The toolbar and Settings > General expose the pinned-only toggle, and
Settings > General exposes the Auto/Light/Dark theme mode setting.
These controls stay synchronized through the shared preferences store.

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
horizontally. Jumpbar behavior is board-only; switching to List hides the
jump strip and disables board column movement shortcuts until Board is active
again.

Motion animations highlight insertions and reorders. Empty columns can
be auto-hidden.

### List

The list view shows the same filtered `RunSummary` collection as the board
as compact rows sorted by the active sort field and direction, with pinned
runs kept at the top before the same sort is applied within pinned and
unpinned groups. It does not bucket rows by status.

Status chips above the rows show `All` plus only statuses that currently
have at least one visible run. The status labels are `Initialized`, `Ready`,
`Running`, `Blocked`, `Exhausted`, `Error`, `Aborted`, and `Completed`.
Choosing a status filters the list rows; choosing `All` clears only that
status chip. Search and structured filters compose with the selected status
chip, and reset actions clear the same dashboard filters used by the board.

Each desktop compact row opens the selected-run panel, exposes
repo/agent/backend and run-group filter shortcuts, shows a compact task count,
keeps schedule, dependency, attachment, queued-message, and active-task
indicators in the metadata area, and exposes note, pin, and overflow actions.
The sorted timestamp column uses relative-only text for started, updated,
and ended sorting; absolute timestamps remain available in the detail
surface.
On mobile, List uses the same board card layout and full-card tap,
right-click, and long-press behavior as Board.

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
- Attachments surface: preview-only view of the selected run's
  group-scoped attachments. It shows one attachment at a time under the
  selected-run header and tabs, supports previous/next controls, and
  shows `No attachments available.` when the selected run's group has no
  attachments. Opening a preview from Chat or from Detail -> Attachments
  switches to this surface without changing the selected-run route.
- Detail -> Attachments section: one combined group-scoped list. Rows
  show `ownerRunId`; selected-run attachments can be uploaded,
  previewed, downloaded, and deleted, while attachments owned by other
  runs in the group are read-only but still support preview and download.
  In-app preview is available for `text/markdown`, `text/plain`,
  `image/png`, `image/jpeg`, `image/gif`, `image/webp`, and
  `image/svg+xml` attachments; fenced `mermaid` blocks render inline
  (with an inline error if a diagram fails to load). See
  [attachments.md](attachments.md).
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
pending prompt as a normal System card labeled `System (PENDING)`; runs
without a pending prompt keep the empty conversation state. Once timeline
history contains the first real attempt, Chat renders session 0 attempt 0
from `attempt.prompt` as a normal System card, even when the run has an
initial message, because before-attempt hooks may rewrite the prompt. If a
hook clears `attempt.prompt`, Chat does not fall back to the original run
message. Attempts imported from a bootstrapped backend session suppress
that System prompt card because the message came from backend-owned
history rather than an agent-runner-authored handoff. Later resume sessions
keep their stored session message as a user bubble, and automatic
follow-up or retry prompts continue to render as System cards.
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
Previewable cards open the top-level Attachments surface, and every card
can use the existing browser download flow. Removing an attachment from the
selected run removes its synthesized Chat card on the next detail projection.
Markdown code blocks rendered in Chat, attachment previews, notes, tasks, and
timeline content include a top-right copy button. The button appears on
hover/focus on pointer-based layouts and stays visible on touch layouts.

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
| `run_summary` | `/api/events/run-summaries` | Board cards and List rows |
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

Detail-drawer destructive actions (delete, reset, abort) use inline
confirmations. The selected-run `Shift+D` cleanup shortcut and run-card
action menu use modal confirmation before archive/delete cleanup. Open
the run-card action menu by right-clicking a run card on desktop or
long-pressing a run card on touch devices; there is no visible overflow
button.

## Keyboard shortcuts

The dashboard's shortcut system is customizable from
`/settings/keybindings`. Default bindings:

| Shortcut | Action |
|----------|--------|
| `/` or `Ctrl+K` | Focus search |
| `Esc` (in search) | Clear search and blur |
| `Esc` (in chat composer) | Blur the composer without closing the drawer |
| `Esc` (drawer open) | Close drawer |
| `Enter` | Primary action for the selected card (Resume, etc.) |
| `↑` / `↓` | Move selection through visible list rows, or through board cards in Board mode |
| `←` / `→` | Move the board selection between columns |
| `Ctrl+Shift+F` | Toggle Filters panel |
| `Ctrl+Shift+P` | Toggle pinned-only filter |
| `Ctrl+Shift+N` | Toggle notes-only filter |
| `Ctrl+Shift+A` | Toggle archived filter |
| `Ctrl+Shift+E` | Toggle hide-empty-columns |
| `V` | Cycle the center surface between Board and List |
| `P` | Pin or unpin the selected run |
| `A` | Show the selected run's Attachments tab |
| `C` | Show the selected run's Chat tab, or focus its composer when Chat is open |
| `D` | Show the selected run's Detail tab |
| `N` | Show the selected run's Notes tab, or focus its editor when Notes is open |
| `T` | Show the selected run's Tasks tab |
| `Shift+A` | Archive or restore the selected run |
| `Shift+D` | Confirm archive/delete cleanup for the selected run |
| `F` | Toggle the detail drawer fullscreen |
| `←` / `→` (fullscreen attachment preview) | Previous or next attachment |

Shortcuts are suppressed while typing in inputs or when a modal dialog
is open. Native modal dialogs, including Resume and the run-note editor,
handle Escape/back dismissal before dashboard shortcuts.

When the detail drawer is fullscreen, selected-run shortcuts including
`Enter`, `P`, `A`, `Shift+A`, `Shift+D`, and `C`/`D`/`N`/`T` remain
active. Board movement, search, and filter shortcuts remain suppressed in
fullscreen drawer mode. Attachment preview left/right navigation is active
only while the drawer is fullscreen; otherwise the Attachments surface uses
the visible previous/next controls.
If the primary action opens the Resume dialog, the dialog appears above
the fullscreen drawer or preview surface. While the Resume or run-note
dialog is open, the first `Esc` closes the dialog; later presses follow
the existing fullscreen and drawer close behavior.

## Preferences

Preferences are persisted to `localStorage` and include:

- Center-surface view mode (`board` or `list`).
- Hide empty columns.
- Collapse failure states into a single column.
- Board sort field (`startedAt`, `updatedAt`, or `endedAt`) and direction
  (`desc` or `asc`).
- Show archived runs.
- Show runs with notes only.
- Show pinned runs only.
- Structured filters (repo, agent, backend, run group).
- Visible focus indicators.
- Theme mode (`auto`, `light`, or `dark`).
- Detail drawer width.

## Development

The web package is a workspace under `apps/web`.

```bash
# In one terminal: run the daemon the dashboard talks to.
agent-runner serve

# In another terminal: start the Vite dev server (proxies /api to the daemon).
cd apps/web
npm run dev
```

The dev server listens on port 4174 and proxies `/api` and
`/app-config.json` to `AGENT_RUNNER_WEB_PROXY_TARGET` (default
`http://127.0.0.1:4773`). When `AGENT_RUNNER_WEB_BASE_PATH` is set, the
dev server also proxies the same config and API paths under that prefix.

Build and tests:

```bash
npm run build    # tsc --noEmit && vite build (output to dist/)
npm run test     # vitest run
```

The production build is bundled and served by `agent-runner serve`; there
is no standalone web server in the shipped runtime. When the dashboard is
mounted behind a reverse proxy at a subpath, set
`AGENT_RUNNER_WEB_BASE_PATH` in the daemon environment, for example
`AGENT_RUNNER_WEB_BASE_PATH=/agent-runner`.

For pass-through prefix proxies, build the bundled dashboard with the
same `AGENT_RUNNER_WEB_BASE_PATH` value used by the daemon. The daemon
rewrites entry asset URLs at runtime, but Vite's module preload hints are
emitted with the build-time base path.

## Data flow summary

1. App boots and fetches `app-config.json` from the configured web base
   path, then derives API and event stream paths.
2. Reads the optional Settings -> General daemon token and attaches it as
   an Authorization bearer header on API, attachment, and fetch-backed SSE
   requests.
3. Subscribes to the global summary stream; mutations arrive as
   `summary_upsert` / `summary_removed` events and update the
   TanStack React Query cache. Board and List ordering are recomputed from
   cached canonical summary timestamps.
4. Selecting a run subscribes to its detail stream; opening Attempts or
   Audit starts the corresponding history load and live stream, which remain
   active while that run stays selected.
5. User actions call the HTTP API; responses feed the cache and the
   daemon broadcasts matching detail/summary updates back to all
   subscribers.
6. `RunCapabilities` on each projection decides which buttons are
   enabled, which keeps the UI consistent with the CLI and daemon.

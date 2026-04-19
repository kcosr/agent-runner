# Web dashboard

`apps/web` is a real workspace package built with Vite + React, served
same-origin by `task-runner serve`. It shows run status, filters,
archive toggles, and a deep-linkable run detail drawer.

## Hosting model

- Normal local use is same-origin: `task-runner serve` hosts the built
  frontend plus `/api/*` endpoints on one listener.
- The app loads runtime config from `/app-config.json`. The config
  exposes `apiBasePath` and `runSummaryEventsPath`; per-run detail
  and timeline stream paths are derived from the base path and the
  active run id.
- Reads and actions go over HTTP; the UI stays fresh over split SSE
  streams — see the [daemon docs](daemon.md#live-event-subscriptions)
  for the `run-summaries` / `runs/:id/events/detail` / timeline
  split.
- The web detail drawer uses the same HTTP attachment download/remove
  flows as daemon-routed CLI commands.

## Live updates

The dashboard consumes two of the three live streams today:

- **Global run-summary stream** drives the board grid. Each
  `summary_upsert` applies a fresh `RunSummary` to the board cache,
  so card progress counts, attachment/dependency badges, and
  `activeTask` labels update without refetching or invalidating
  selected-run state.
- **Per-run detail stream** drives the drawer. Each `detail_updated`
  replaces the `RunDetail` in the detail cache, so task state,
  dependency readiness, and attachment metadata refresh in place.

The per-run **timeline stream** (transcript / `agent_message_delta`)
is plumbed through the daemon but not yet consumed by the dashboard
— the drawer shows a "live timeline deferred in phase 1" placeholder.
Live transcript rendering in the dashboard is on the README roadmap.

## Routing

Client routing is deep-linkable:

- `/` shows the board.
- `/runs/:runId` opens the selected-run drawer/sheet.

## Status model

Primary badges and board grouping use the shared derived
`effectiveStatus` (so passive runs with in-progress work show as
running), while control actions still follow the canonical lifecycle
`status`.

## Visual contract

The canonical visual contract lives in:

- `apps/web/mockups/run-dashboard.html`
- `apps/web/mockups/run-dashboard.css`

The React UI should match that layout and visual language unless a
later change explicitly justifies divergence.

## Development

Development uses the Vite dev server in `apps/web` with a proxy for
`/api/*` and `/app-config.json` back to the local daemon host:

```bash
# In one terminal
task-runner serve

# In another
cd apps/web
npm run dev
```

The dev server forwards API traffic to the daemon so the React app
behaves the same as in the packaged same-origin deployment.

See [daemon.md](daemon.md) for the transport split and protocol
surfaces the web app consumes.

# Web dashboard

`apps/web` is a real workspace package built with Vite + React, served
same-origin by `task-runner serve`. It shows run status, filters,
archive toggles, and a deep-linkable run detail drawer.

## Hosting model

- Normal local use is same-origin: `task-runner serve` hosts the built
  frontend plus `/api/*` and `/api/events/*` on one listener.
- The app loads runtime config from `/app-config.json`.
- Reads and actions go over HTTP; the UI stays fresh over SSE.
- The web detail drawer uses the same HTTP attachment download/remove
  flows as daemon-routed CLI commands.

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
`/api/*`, `/api/events/*`, and `/app-config.json` back to the local
daemon host:

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

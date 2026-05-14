# Attachments

Attachments are files stored with a run. Metadata lives in the manifest;
bytes live under the run workspace. Attachments are immutable once stored:
name and MIME type are captured at add time, and content integrity is
verified against a SHA-256 digest.

## Storage

Metadata is in `manifest.attachments` as an array of `RunAttachment`:

```ts
{
  id: string                // "att-<shortid>"
  name: string              // validated, sanitized filename
  mimeType: string          // resolved from extension or override
  size: number              // bytes
  sha256: string            // hex digest
  addedAt: string           // ISO 8601 timestamp
  relativePath: string      // "attachments/<id>/<filename>"
}
```

Files live at:

```text
<workspace>/attachments/<attachment-id>/<filename>
```

## Limits

- Max file size: **25 MiB**
- Max attachments per run: **100**
- Max total size per run: **100 MiB**

Additions that would violate any of these are rejected before the file is
written.

## Filename validation and sanitization

Incoming names are validated and sanitized:

- Control characters are rejected.
- `/` and `\` are rejected in the provided name, and replaced with `-`
  during sanitization of the on-disk filename.
- Names cannot be `.` or `..`.
- Leading `.` sequences are stripped from the on-disk filename.

MIME type is resolved from the filename extension with a fallback of
`application/octet-stream`. `--mime-type` on add lets you override it.

## CLI

### Add

```bash
task-runner attachment add <run-id> <path> \
  [--name "override-name.txt"] \
  [--mime-type "text/plain"]
```

The file is streamed to the workspace; size and SHA-256 are computed
during the stream.

With `--connect`, the CLI uploads over the existing daemon WebSocket:
metadata is exchanged with JSON-RPC and file bytes are sent as bounded
`stream.*` notifications. The connected path does not call the daemon
HTTP attachment upload route. Connected upload includes a `size` hint; if
it exceeds 25 MiB the daemon rejects the open request before any bytes are
sent.

### List

```bash
task-runner attachment list <run-id>
task-runner attachment list <run-id> --scope run
task-runner attachment list <run-id> --scope group
```

`attachment list` defaults to `--scope group`.

- `--scope run` lists only the target run's attachments.
- `--scope group` lists attachments from every run whose `runGroupId`
  matches the target run's group.

JSON rows include `ownerRunId` so you can tell which run owns each file.
With `--connect`, list uses the `attachments.list` WebSocket JSON-RPC
method.

### Download

```bash
task-runner attachment download <run-id> <attachment-id> <output-path>
```

If `<output-path>` ends with `/`, it is treated as a directory and the
filename is derived from the attachment. Otherwise it is treated as an
exact file path. The command errors if the destination already exists or
the parent directory is missing.

With `--connect`, metadata is returned by `attachments.download` and
file bytes are streamed over the same WebSocket. If the stream fails
after the destination file is created, the CLI removes the partial file.

### Remove

```bash
task-runner attachment remove <run-id> <attachment-id>
```

Removes the file and its per-attachment directory, then removes the empty
`attachments/` directory if it was the last one. Manifest metadata is
updated by filtering out the removed entry.

With `--connect`, remove uses the `attachments.remove` WebSocket JSON-RPC
method.

## Daemon transports

Browser and API callers continue to use the daemon HTTP attachment
endpoints:

- `GET /api/runs/:runId/attachments`
- `POST /api/runs/:runId/attachments`
- `DELETE /api/runs/:runId/attachments/:attachmentId`
- `GET /api/runs/:runId/attachments/:attachmentId/content`

Connected CLI callers use the daemon WebSocket instead. Stream limits are
65,536 bytes per decoded chunk, 8 active streams per WebSocket, 512 KiB
of initial outgoing byte credit per stream, 1 MiB of buffered unread
bytes per stream, 4 MiB buffered per WebSocket, and a 30-second idle
timeout. Upload and download streams pace `stream.data` frames with
receiver-issued `stream.window` credit grants. The core attachment
limits above still apply to committed attachments.

## Web dashboard

The selected-run panel has two attachment surfaces:

- The top-level Attachments tab is a preview surface. It uses the same
  selected-run plus run-group attachment order as the detail list, shows
  one attachment at a time, and supports previous/next navigation. If no
  attachments are available, it shows `No attachments available.`.
- Detail -> Attachments remains the management list. It shows one
  combined list for the selected run's group, matching
  `attachment list --scope group`.

- Attachments owned by the selected run support upload, download,
  in-app preview, and delete.
- Attachments owned by other runs in the group are read-only. They still
  support preview and download, and each row shows the source
  `ownerRunId`.
- In-app preview supports `text/markdown`, `text/plain`, `image/png`,
  `image/jpeg`, `image/gif`, `image/webp`, and `image/svg+xml`.
  Markdown fenced `mermaid` blocks render inline, and non-Mermaid fenced
  code blocks include a copy button.
- Preview actions from Chat artifact cards and Detail -> Attachments rows
  switch to the top-level Attachments tab without changing the selected-run
  route.

## Common patterns

- **Seed context**: drop a file into the run before resume (e.g. a diff, a
  report, a summary).
- **Handoff between grouped runs**: attach artifacts to a planning run so
  an implementation or review run in the same run group can discover
  them via `--scope group`.
- **Single-run approval pause**: `plan-implement-feature` attaches only
  `assignment-summary.md` to the current run, blocks for caller approval,
  and resumes implementation in the same run. It does not create
  `assignment-seed.md` or a separate implementer run.
- **Audit trail**: attach the exact generated draft so the manifest
  captures byte-for-byte what was handed to the next stage.

See [examples.md](examples.md) for how the bundled `plan-feature` and
`plan-implement-feature` assignments use attachments as handoff and
approval surfaces.

# Attachments

Runs can carry immutable file blobs alongside the manifest — screenshots,
logs, build artifacts, or anything else the caller wants to bind to a
run. Canonical bytes live inside the run workspace; `run.json` persists
only attachment metadata and workspace-relative paths.

## Limits

- 20 attachments per run
- 25 MiB per file
- 100 MiB total bytes per run

## CLI surface

```bash
task-runner attachment add <run-id|path> <source-file>
task-runner attachment add <run-id> ./build.zip --name artifacts.zip --mime-type application/zip
task-runner attachment list <run-id|path>
task-runner attachment download <run-id|path> <attachment-id> <output-path>
task-runner attachment remove <run-id|path> <attachment-id>
```

These commands work for initialized, running, terminal, and archived
runs. Attachments do not mutate the prompt or backend session state.

### Options

| Flag | Purpose |
|---|---|
| `--name <text>` | `attachment add` only. Optional display name; defaults to the source basename. |
| `--mime-type <type>` | `attachment add` only. Optional MIME override; otherwise task-runner derives from filename extension and falls back to `application/octet-stream`. |
| `--connect <ws-url>` | Route through the daemon. Attachment bytes use the daemon's HTTP attachment endpoints rather than WebSocket JSON-RPC payloads. |
| `--output-format <text\|json>` | Default `text`. `json` returns the created attachment row, the attachment array, the remove result, or the download result including `outputPath`. |

Downloads are intentionally conservative: task-runner never overwrites
an existing destination file, and a path ending in `/` is treated as a
directory that must already exist.

## Metadata in `RunDetail`

`RunDetail` includes an `attachments` array and `list runs
--output-format json` exposes `attachmentCount`. Text `status` shows
the attachment count, and the web detail drawer uses the same HTTP
download/remove flows as daemon-routed CLI commands.

## Storage layout

```
${TASK_RUNNER_STATE_DIR}/runs/<repo-name>/<run-id>/attachments/
└── <attachment-id>/<sanitized-name>
```

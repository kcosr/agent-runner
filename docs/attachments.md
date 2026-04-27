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

### Download

```bash
task-runner attachment download <run-id> <attachment-id> <output-path>
```

If `<output-path>` ends with `/`, it is treated as a directory and the
filename is derived from the attachment. Otherwise it is treated as an
exact file path. The command errors if the destination already exists or
the parent directory is missing.

### Remove

```bash
task-runner attachment remove <run-id> <attachment-id>
```

Removes the file and its per-attachment directory, then removes the empty
`attachments/` directory if it was the last one. Manifest metadata is
updated by filtering out the removed entry.

## Web dashboard

The detail drawer's Attachments panel shows one combined list for the
selected run's group, matching `attachment list --scope group`.

- Attachments owned by the selected run support upload, download,
  in-app preview for `text/markdown` and `text/plain` (fenced
  `mermaid` blocks render inline), and delete.
- Attachments owned by other runs in the group are read-only. They still
  support preview and download, and each row shows the source
  `ownerRunId`.

## Common patterns

- **Seed context**: drop a file into the run before resume (e.g. a diff, a
  report, a summary).
- **Handoff between grouped runs**: attach artifacts to a planning run so
  an implementation or review run in the same run group can discover
  them via `--scope group`.
- **Audit trail**: attach the exact generated draft so the manifest
  captures byte-for-byte what was handed to the next stage.

See [examples.md](examples.md) for how the bundled `plan-feature`
assignment uses attachments as a handoff surface.

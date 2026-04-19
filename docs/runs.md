# Runs, workspaces, and the manifest

Each run gets a workspace directory at
`${TASK_RUNNER_STATE_DIR}/runs/<repo-name>/<run-id>/`:

```text
${TASK_RUNNER_STATE_DIR}/runs/<repo-name>/<run-id>/
├── run.json
├── assignment-seed.md        # only when the run started from an assignment file
├── attempts/
│   └── 01.json
└── attachments/
    └── <attachment-id>/
```

- **`run.json`** — the canonical record, written at run start,
  rewritten after every attempt, and one final time on terminal
  state. A single JSON document — never JSONL, never append-only —
  so you can `cat` or `jq` it at any moment. Contains the agent
  identity *and* a frozen snapshot of the agent's role instructions,
  locked fields, and timeout budget, plus the assignment metadata,
  the composed worker `brief`, every attempt record, the canonical
  task snapshots, the resolved vars, caller instructions, dependency
  and attachment metadata, and the captured backend session id.
- **`assignment-seed.md`** — an **immutable** snapshot of the source
  assignment file at run-start time. Present only when the run was
  created from an assignment file; audit/debug only. The worker does
  not edit this file; canonical task state lives in `run.json`.
- **`attempts/NN.json`** — raw per-attempt logs (stdout, stderr,
  start/end timestamps), one per backend invocation.
- **`attachments/<attachment-id>/<sanitized-name>`** — canonical file
  storage for run attachments. Bytes live here; `run.json` persists
  attachment metadata and workspace-relative paths. See
  [attachments.md](attachments.md).

## The manifest is canonical

The manifest is the load-bearing piece: **it is the canonical source
of truth for a run after first write**. Every other CLI command
(`status`, `brief`, `task list` / `show` / `set` / `add`,
`run --resume-run`) reads from the manifest and **never re-reads the
agent's source file on resume**. Moving, editing, or deleting
`agent.md` or the source assignment file after a run has started has
no effect on that run — it lives off the frozen snapshot in
`run.json`. This is also what makes ad-hoc agents possible: once the
manifest is written, the agent had no source file to begin with and
the run doesn't care.

`run.json` carries the composed worker brief under `manifest.brief`.
Operators fetch that text with `task-runner brief <run-id>` rather
than reading the JSON field directly. See
[agents-and-assignments.md#brief-and-caller-instructions](agents-and-assignments.md#brief-and-caller-instructions).

## Schema versioning

Manifest schema is versioned — the current generation is
`schemaVersion: 7`. Runtime reads are a **hot cut**: manifests at
earlier schema versions are not silently upgraded and cannot be
resumed. Create a fresh run (`task-runner init` / `run`) instead.
There is no migration script from schema 6 to schema 7.

For the full schema and the rationale, see [`design.md`](design.md).

## Attempts and retries

Every backend invocation writes an `attempts/NN.json` record with
captured stdout/stderr and timing. The run loop uses the assignment's
`maxRetries` (default `3`, overridable per run) as its retry budget.
Retries only happen when the agent left some tasks `pending`; a
`blocked` task short-circuits the loop immediately.

## Resetting and archiving

- `task-runner run reset <id>` restores the initialized-state seed
  stored in the manifest, clears the captured backend session id, and
  removes stale `attempts/` artifacts. Reset does not re-read current
  source definitions, and the run no longer regenerates a live
  workspace task file — canonical task state lives in
  `run.json.finalTasks` either way. Works for any non-running run.
- `task-runner run archive <id>` toggles a run-level archive marker
  (`manifest.archivedAt`) without changing the lifecycle `status`.
  Archived runs are hidden from default `list runs` and rejected by
  `--resume-run` until unarchived.

See [cli.md](cli.md) for the full set of run-subcommand options.

## Run dependencies

Initialized runs can declare prerequisite run ids that must reach
`status=success` before resume is allowed. See
[dependencies.md](dependencies.md).

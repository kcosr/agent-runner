# Runs, workspaces, and the manifest

Each run gets a workspace directory at
`${TASK_RUNNER_STATE_DIR}/runs/<repo-name>/<run-id>/` with four things
in it:

- **`run.json`** — the canonical record, written at run start,
  rewritten after every attempt, and one final time on terminal state.
  A single JSON document — never JSONL, never append-only — so you can
  `cat` or `jq` it at any moment. Contains the agent identity *and* a
  frozen snapshot of the agent's role instructions, locked fields, and
  timeout budget, plus the assignment metadata, every attempt record,
  the final per-task snapshot, the resolved vars, and the captured
  backend session id.
- **`assignment.md`** — the I/O buffer the agent edits in place. The
  *source* assignment file is never mutated; the runner copies it here
  on a fresh run and re-reads it after every turn. For
  `taskMode=cli`, this file is render-only — the source of truth is
  `run.json.finalTasks`.
- **`attempts/NN.json`** — raw per-attempt logs (stdout, stderr,
  start/end timestamps), one per backend invocation. Useful for
  forensics.
- **`attachments/<attachment-id>/<sanitized-name>`** — canonical file
  storage for run attachments. The bytes live here; `run.json`
  persists only attachment metadata and workspace-relative paths. See
  [attachments.md](attachments.md).

## The manifest is canonical

The manifest is the load-bearing piece: **it is the canonical source
of truth for a run after first write**. Every other CLI command
(`status`, `run --resume-run`, `task set` / `task add`) reads from the
manifest and **never re-reads the agent's source file on resume**.
Moving, editing, or deleting `agent.md` after a run has started has no
effect on that run — it lives off the frozen snapshot in `run.json`.
This also makes ad-hoc agents possible: once the manifest is written,
the agent had no source file to begin with and the run doesn't care.

## Schema versioning

Manifest schema is versioned — the current generation is
`schemaVersion: 6`. Runtime reads are a hot cut: older manifests are
not silently upgraded while reading or resuming. If you still have
`schemaVersion: 5` runs from before attachments landed, use the
offline migration script first:

```bash
# Dry-run existing state
node scripts/migrate-manifests-v6.mjs --root "${TASK_RUNNER_STATE_DIR:-$HOME/.local/state/task-runner}"

# Apply the upgrade in place
node scripts/migrate-manifests-v6.mjs --root "${TASK_RUNNER_STATE_DIR:-$HOME/.local/state/task-runner}" --write
```

For the full schema and the rationale, see [`design.md`](design.md).

## Attempts and retries

Every backend invocation writes an `attempts/NN.json` record with
captured stdout/stderr and timing. The run loop uses the assignment's
`maxRetries` (default `3`, overridable per run) as its retry budget.
Retries only happen when the agent left some tasks `pending`; a
`blocked` task short-circuits the loop immediately.

## Resetting and archiving

- `task-runner run reset <id>` rewrites `run.json` and `assignment.md`
  from the manifest's frozen initialized-state seed, clears the
  captured backend session id, and removes stale `attempts/` artifacts.
  Works for any non-running run.
- `task-runner run archive <id>` toggles a run-level archive marker
  (`manifest.archivedAt`) without changing the lifecycle `status`.
  Archived runs are hidden from default `list runs` and rejected by
  `--resume-run` until unarchived.

See [cli.md](cli.md) for the full set of run-subcommand options.

## Run dependencies

Initialized runs can declare prerequisite run ids that must reach
`status=success` before resume is allowed. See
[dependencies.md](dependencies.md).

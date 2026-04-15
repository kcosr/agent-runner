# CLI reference

Host selection:

- Without `--connect` / `TASK_RUNNER_CONNECT`, commands run in
  **embedded mode** and call the shared app services in-process.
- With `--connect <ws-url>` or `TASK_RUNNER_CONNECT=<ws-url>`, the CLI
  runs in **daemon mode** and routes the entire command through the
  local daemon API. If nothing is listening there, the command fails
  with exit code `3`; it does not silently fall back to embedded mode.

See [daemon.md](daemon.md) for the full daemon contract.

## `task-runner run`

Execute an agent. Three modes, distinguished by which flags you pass:

```bash
# Fresh run
task-runner run --agent <name> [--assignment <name>] [options] [message]

# Resume an existing run (follow-up message optional when incomplete tasks remain)
task-runner run --resume-run <id> [options] [message]

# Execute a previously initialized run (see `init` below)
task-runner run --resume-run <id>
```

### Common options

| Flag | Purpose |
|---|---|
| `--agent <name\|path>` | Agent name or direct path. **Optional on fresh runs** — when omitted, task-runner synthesizes an ad-hoc agent from CLI overrides (in that case `--backend` is required). **Forbidden with `--resume-run`** — the agent is reconstructed from the frozen manifest, not re-read from disk. |
| `--assignment <name\|path>` | Assignment name or direct path. Optional on fresh runs. Forbidden on resume. |
| `--resume-run <id\|path>` | Continue an existing run by short id, workspace path, or direct `run.json` path. Archived runs must be unarchived first. See [resume.md](resume.md) for the full resume-override policy. |
| `--var key=value` (repeatable) | Set an input variable. Validated against the assignment's `vars` schema. **Forbidden with `--resume-run`** — vars are resolved once at first write and frozen into the manifest; they aren't re-resolved on resume. |
| `--add-task "<title>"` (repeatable) | Append an ad-hoc task with auto-generated id `cli-<short>`. |
| `--cwd <path>` | Override the agent's `cwd`. **Forbidden with `--resume-run`** — backend sessions are bound to their creation cwd, so a new cwd would invalidate the captured session id. Create a fresh run if you need a different cwd. |
| `--backend <claude\|codex\|cursor\|passive>` | Override the agent's backend. Drops the agent's `model` unless `--model` is also passed. Forbidden with `--resume-run` (the backend is locked to the session that created the run). Required when `--agent` is omitted (ad-hoc synthesis). |
| `--task-mode <file\|cli>` | Override the assignment's task workflow mode for a fresh `run` or `init`. Forbidden with `--resume-run` because the chosen mode is frozen into the manifest at first write. |
| `--model <id>` | Override the model. Backend-specific (`claude-sonnet-4-6`, `gpt-5.4`, etc.). |
| `--effort <off\|minimal\|low\|medium\|high\|xhigh\|max>` | Reasoning effort. Mapped per backend; accepted but ignored by Cursor v1. |
| `--max-retries <n>` | Override the per-run retry budget (default 3). |
| `--timeout-sec <n>` | Override the per-attempt timeout (default 3600). |
| `--unrestricted` | Bypass the backend's approval prompts. Cursor maps this to `cursor-agent --force`. |
| `--name <name>` | Set the fresh run's persisted display name (`run.name`). Omitted means unnamed. Forbidden with `--resume-run`. |
| `--backend-session-id <id>` | Adopt an existing backend session id (claude UUID, codex thread id). Validated before workspace creation. Cursor does not support bootstrap import and rejects this flag. Forbidden with `--resume-run` (the resume target already carries one). |
| `--connect <ws-url>` | Route the command through the local daemon instead of embedded mode. Also honored from `TASK_RUNNER_CONNECT`. |
| `--detach` | **Daemon mode only.** Dispatch the daemon-owned run and exit immediately after the daemon accepts it. Valid only on plain `task-runner run`; rejected in embedded mode, on `init`, and on grouped `run` subcommands. |
| `--output-format <text\|json>` | Default `text`. `json` writes the final manifest-shaped run record to stdout once at end of run. |

### Detached daemon dispatch

- `task-runner run --detach ...` and `task-runner run --detach --resume-run <id>`
  send `runs.start` / `runs.resume` to the daemon and return immediately
  after the daemon responds with a `runId`.
- Detached mode does **not** wait for `run_finished`, does not stream
  run events, and does not change any manifest/session semantics.
- Attached behavior remains the default. If you omit `--detach`, a
  daemon-connected `run` keeps the existing blocking/event-streaming
  behavior.

Detached success output:

```text
task-runner: detached run abc123
Resume later with: task-runner run --resume-run abc123 "..."
Check status with: task-runner status abc123
```

```json
{
  "runId": "abc123",
  "detached": true
}
```

### Resume overrides

On `--resume-run`, the "legitimate mid-run" overrides — `--model`,
`--effort`, `--timeout-sec`, `--max-retries`, `--unrestricted` — are
still accepted (and still vetted against the frozen
`manifest.lockedFields`). **Execute-after-init** (resuming a run whose
prior status was `initialized`) rejects **every** override. See
[resume.md](resume.md) for the full matrix.

## `task-runner init`

Prepare a run *without* invoking the backend. Same flags as `run`, but
stops after writing the workspace, manifest (`status: "initialized"`),
and the frozen prompt. Returns the run id; resume later with
`task-runner run --resume-run <id>`.

```bash
task-runner init \
  --agent ./agents/example/agent.md \
  --assignment ./assignments/repo-orientation/assignment.md \
  --var repo_path=/some/repo
# task-runner: initialized agent=example run=abc123
#              ...
#              resume with: task-runner run --resume-run abc123
```

Useful when an outer process wants a resumable handle before committing
to execution, or wants to inspect the prepared workspace before kicking
off the actual work.

`init` does not accept `--detach`; detached dispatch is only for
daemon-connected `run`.

## `task-runner serve`

Start the local daemon host. See [daemon.md](daemon.md) for the
architecture, transports, and web-dashboard hosting.

```bash
task-runner serve
task-runner serve --listen ws://127.0.0.1:4773/
```

## `task-runner run add-dep / remove-dep / clear-deps`

Manage prerequisite runs for an initialized run. See
[dependencies.md](dependencies.md) for semantics.

```bash
task-runner run add-dep <run-id> <dependency-run-id>
task-runner run remove-dep <run-id> <dependency-run-id>
task-runner run clear-deps <run-id>
task-runner run add-dep <run-id> <dependency-run-id> --output-format json
```

## `task-runner run set-name`

Update the persisted display name for an existing run without otherwise
changing run state.

```bash
task-runner run set-name <run-id> "Review auth hot cut"
task-runner run set-name <run-id> --clear
task-runner run set-name <run-id> --output-format json --clear
```

- Allowed for existing runs in embedded mode or daemon mode via
  `--connect`.
- `<name>` is required unless `--clear` is present. Trimmed names must
  be non-empty.
- Updates `manifest.name` immediately and mirrors the value into the
  persisted reset seed so later `run reset` keeps the renamed value.
- Codex best-effort attempts a live thread-title rename when the run
  already has a backend session id. Claude picks up the changed name on
  the next invocation.
- Idempotent: setting the same name again or clearing an already
  unnamed run succeeds with `changed: false` in JSON mode.

## `task-runner run reset`

Restore an existing non-running run to the same initialized state it
had immediately after `task-runner init` or first-write on a fresh run.

```bash
task-runner run reset <run-id>
task-runner run reset <run-id> --output-format json
```

- Allowed for `initialized`, `success`, `blocked`, `exhausted`,
  `aborted`, and `error` runs.
- Rejected while `status=running`, regardless of `taskMode`.
- Works for both passive and non-passive runs.
- Rewrites `run.json` and the workspace `assignment.md` from the
  manifest's frozen initialized-state seed; it does **not** re-read
  the current agent or assignment source files from disk.
- Restores the initialized prompt/task snapshot, clears
  `backendSessionId`, zeroes session/attempt history, and removes
  stale `attempts/` artifacts so the next execution starts clean.

## `task-runner run archive / unarchive`

Archive toggles are orthogonal to `status`: they keep the run's current
lifecycle state but add or clear `manifest.archivedAt`. By default
`task-runner list runs` hides archived runs, and
`task-runner run --resume-run <id>` rejects them until unarchived.

```bash
task-runner run archive <run-id>
task-runner run archive <run-id> --output-format json

task-runner run unarchive <run-id>
task-runner run unarchive <run-id> --output-format json
```

- Allowed for any non-running run.
- Rejected while `status=running`.
- Idempotent: archiving an already archived run and unarchiving an
  unarchived run both succeed with `changed: false` in JSON mode.
- `status`, `endedAt`, task state, and attempt/session history are
  preserved; only `archivedAt` changes.

## `task-runner status`

Read-only inspector. Resolves a run by short id (looked up in the
current repo-name bucket under `${TASK_RUNNER_STATE_DIR}/runs/`, then
`runs/unknown/`), workspace path, or direct `run.json` path.

```bash
# Human-readable status block + per-task checklist
task-runner status <id>

# Full run detail as JSON
task-runner status <id> --output-format json

# Just the fields you care about
task-runner status <id> --output-format json \
  --field status --field tasksCompleted --field tasksTotal
```

### Options

| Flag | Purpose |
|---|---|
| `--output-format <text\|json>` | Default `text`. `json` prints the full `RunDetail` JSON contract. |
| `--field <name>` (repeatable) | When `--output-format json`, restrict output to these top-level `RunDetail` fields. |

When the resolved manifest's status is `running`, `status` behaves by
task mode:

- `taskMode=file`: parse the workspace `assignment.md` and overlay the
  live task statuses + notes onto the output.
- `taskMode=cli`: read canonical task state directly from
  `run.json.finalTasks`. `assignment.md` is render-only in this mode,
  so there is no live file overlay.

When `manifest.archivedAt` is non-null, text output includes the
archive timestamp plus an unarchive hint, and JSON output exposes the
same top-level `archivedAt` field.

`RunDetail` carries both the canonical lifecycle `status` and a derived
`effectiveStatus`. Text output uses `effectiveStatus` for the primary
`Status:` line and shows `Lifecycle status:` when the two diverge. For
passive runs, `effectiveStatus` becomes `running` when any task is
`in_progress`, while the canonical manifest status stays `initialized`
until the task set reaches a terminal state.

Attachment metadata is part of the same JSON contract: `RunDetail`
includes `attachments`, `list runs --output-format json` exposes
`attachmentCount`, text `status` shows the attachment count, and the
web detail drawer uses the same data for its attachment tab.

The JSON `RunDetail` contract also carries a machine-facing `execution`
block plus a machine-facing `capabilities` block:

- `execution.hostMode`
- `execution.controller.kind`
- `execution.controller.daemonInstanceId` when the controller is daemon-owned
- `canAbort`, `abortReason`
- `canArchive`, `canUnarchive`, `canResume`
- `taskMutation.canSetStatus`
- `taskMutation.canEditNotes`
- `taskMutation.canAdd`

`execution` is the persisted execution context for the latest stored
session: embedded runs record
`{ hostMode: "embedded", controller: { kind: "embedded" } }`, while
daemon-run sessions record daemon ownership and the daemon instance id.
Resume rewrites this block to the controller that most recently ran
the session.

Capabilities reflect the current lifecycle and host-ownership rules.
In particular, passive runs are never resumable through `run`, running
`taskMode=cli` runs allow `task set` / `task append-notes` but not
`task add`, terminal runs report `canAbort=false` with
`abortReason="already_terminal"`, and nonterminal runs that are merely
persisted rather than actively owned by the serving daemon report
`canAbort=false` with `abortReason="not_active_in_daemon"`.

In daemon mode, external live abort control is available through the
daemon-owned run lifecycle. Embedded mode remains single-process and
does not expose external live control.

## `task-runner attachment`

See [attachments.md](attachments.md) for the full attachment surface.

```bash
task-runner attachment add <run-id|path> <source-file>
task-runner attachment list <run-id|path>
task-runner attachment download <run-id|path> <attachment-id> <output-path>
task-runner attachment remove <run-id|path> <attachment-id>
```

## `task-runner task` commands

See [tasks.md](tasks.md) for the full task-mutation surface and the
sidecar pattern.

```bash
task-runner task list <run-id>
task-runner task show <run-id> <task-id>
task-runner task set <run-id> <task-id> --status in_progress
task-runner task append-notes <run-id> <task-id> --text "note"
task-runner task add <run-id> --title "Follow-up" --body "..."
```

## `task-runner list`

Enumerate available agent or assignment definitions, or known runs.
Definition discovery is config-root only; run discovery scans
`${TASK_RUNNER_STATE_DIR}/runs/*/*/run.json` and returns
current-generation manifests whose recorded workspace paths still
match the containing directory. `list` is read-only in all modes.

```bash
# List all agents
task-runner list agents

# List all assignments (JSON output)
task-runner list assignments --output-format json

# List non-archived runs
task-runner list runs

# Include archived runs in the inventory
task-runner list runs --include-archived --output-format json
```

### Options

| Flag | Purpose |
|---|---|
| `--output-format <text\|json>` | Default `text`. Definition JSON returns `{ name, path, root }[]`; run JSON returns `RunListEntry[]` including `runId`, `status`, `archivedAt`, repo/agent/assignment names, cwd, timestamps, task counts, and `capabilities` so list/board consumers can render available actions without extra `status` reads. |
| `--include-archived` | `list runs` only. Include runs whose `archivedAt` is non-null. |

## `task-runner show`

Print details of a specific agent or assignment definition. Accepts a
bare name resolved from the config root or a direct file path.
Read-only.

```bash
task-runner show agent ./agents/example/agent.md
task-runner show assignment ./assignments/repo-orientation/assignment.md \
  --output-format json
```

### Options

| Flag | Purpose |
|---|---|
| `--output-format <text\|json>` | Default `text`. `json` returns `{ config, instructions, sourcePath }`. |

## Output modes

### `--output-format text` (default)

- **stdout**: the agent's text, streamed live during each attempt. For
  passive `init`, the composed bootstrap prompt is also written here
  so it can be piped elsewhere.
- **stderr**: runner chrome rendered from typed events at the CLI edge
  — startup banner, caller-instructions banner, attempt dividers,
  retry notifications, and the final summary block with per-task
  results and notes.

### `--output-format json`

- **stdout**: the full `RunManifest` as pretty-printed JSON, written
  once at the end of the run. Byte-identical to `run.json` on disk.
- **stderr**: silent.

Makes `task-runner run --agent X --output-format json > result.json`
trivially correct — no filtering, no stream interleaving.

The manifest is always written to `run.json` regardless of output
mode; `--output-format json` only controls whether it's also printed
to stdout.

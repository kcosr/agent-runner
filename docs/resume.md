# Resume

Resume continues an existing run from its frozen manifest state.
task-runner does *not* re-read the source agent or assignment files on
resume — everything the backend needs is in `run.json`, including the
selected backend name, frozen backendConfig, resolved backend args, and
backend session id.

## Command

```bash
task-runner run --resume-run <run-id-or-path>
```

`--resume-run` accepts either a run id or a workspace path. When present,
several flags are rejected because their inputs are locked in at creation
time (see [Forbidden flags](#forbidden-flags)).

## When to resume

Resume is how you:

- start a ready run you earlier created with `task-runner init`
- re-run a run that exited with incomplete tasks
- follow up with a continuation message
- append new tasks to an in-flight workflow

## Forbidden flags

On resume, the following flags are rejected:

- `--agent` — the agent is frozen in the run.
- `--assignment` — the assignment is frozen; use `--add-task` to append
  new work.
- `--backend` — backend identity is tied to the session.
- `--backend-session-id` — the run already carries its own session id.
- `--cwd` — sessions are bound to the cwd they were created in.
- `--name` — cannot be changed on resume; use `run set-name` instead.
- `--var` — runtime vars are frozen at first write.

For custom backends, resume uses the backend already frozen on the
manifest. The backend module must still be loadable by that name, but
current agent frontmatter, current `backendConfig`, and current
`backendArgs` are not consulted.

Initialized runs are not directly executable. Promote them first:

```bash
task-runner run ready <run-id>
task-runner run --resume-run <run-id>
```

For ready-start, `run --resume-run` additionally rejects `--model`,
`--effort`, `--timeout-sec`, `--max-retries`, `--unrestricted`,
`--add-task`, and positional messages — init already composed and froze
the execution handoff.

## Input requirements

For non-initialized (previously-run) runs, resume requires at least one of:

- an explicit follow-up message (positional arg)
- newly added tasks via `--add-task` (repeatable)
- incomplete tasks remaining in the manifest

If all tasks are already `completed` and no follow-up message or new tasks
are supplied, resume errors rather than re-sending a stale prompt.

If the run has incomplete tasks and no explicit message, task-runner
injects an implicit continue message:

> Continue working through the remaining task list items.

## Archived runs

Non-passive archived runs must be unarchived before resume:

```bash
task-runner run unarchive <run-id>
task-runner run --resume-run <run-id>
```

## Passive runs

Passive runs are externally driven; `run --resume-run` is rejected for
them. Drive them through the task CLI instead:

```bash
task-runner run brief <run-id>
task-runner task set <run-id> <task-id> --status in_progress
task-runner task append-notes <run-id> <task-id> --text "Observed ..."
task-runner task set <run-id> <task-id> --status completed
```

Passive runs also accept `run set-backend-session` and
`run clear-backend-session` for external session tracking.

## Dependencies

Resume cannot start execution of a run whose dependencies have not all
reached `success`. Resolve the upstream runs first, or remove the
dependency with `run remove-dep`. See [dependencies.md](dependencies.md).

## Prompt composition on resume

On resume, the brief sent to the backend is composed as follows:

1. If this is the first attempt with tasks (tasks were absent and are now
   present), the worker workflow template is prepended.
2. If new tasks were added since the last attempt, an added-tasks reminder
   is prepended instead.
3. The follow-up message is appended, or the implicit continue message is
   used if incomplete tasks remain.

Queued resume messages are separate daemon-owned pending intent for live
runs. `task-runner run queue-message <id|path> <text>` appends a
message while a run is live, `task-runner run queued-messages <id|path>`
prints the current queue, and `task-runner run remove-queued-message
<id|path> <message-id>` removes one queued message. When a managed run
finishes and queued messages remain, the daemon starts the next resume
session with those messages combined into one follow-up prompt. The
messages are removed from the manifest only after that resume start is
accepted, so a failed automatic resume keeps the queue available for
retry or manual cleanup.

For ready-start (running a `ready` run with zero prior attempts), the
stored `manifest.brief` is reused verbatim.

## Retry nudges

Within a single `run` invocation, task-runner may retry the backend up to
`maxAttemptsPerSession` times. A run is the durable lifecycle record. Each
backend execution window is a session: the fresh execution creates session
`0`, and each resume creates the next session. Attempts are backend
invocations within a session. `maxAttemptsPerSession` is the per-session
retry budget. Attempt numbers are monotonic across the run, while
`attemptIndexInSession` is zero-based within its session. If tasks remain
incomplete at the end of an attempt, the retry prompt points the worker
back at the task CLI and identifies the incomplete tasks. This is not a
resume — it is a retry inside the same session.

## Reset vs resume

`run reset` is not a form of resume. It clears attempt/session history and
restores the initialized seed so the run is executed from scratch on the
next `run --resume-run` or fresh `run`. Reset does not re-read source
definitions — it uses `manifest.resetSeed` captured at run creation.

## Daemon and backend sessions

The backend session id (`manifest.backendSessionId`) is the resume handle
the backend itself uses — Claude session id, Codex thread id, Pi session
id, etc. task-runner passes it to the backend on resume and validates it
when possible:

- **Claude** — session storage encoded by cwd; validated on-disk.
- **Codex** — `thread/read` RPC validates the thread exists and cwd
  matches.
- **Cursor** — validation deferred to first invocation.
- **Pi** — session file must exist under `PI_HOME` / `~/.pi` with a
  matching `cwd` header.

If a backend reports the session as gone, task-runner surfaces the failure
rather than silently restarting.

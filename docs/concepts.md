# Concepts

The mental model behind task-runner, in one page. For detailed
references on any piece, follow the links.

## The moving parts

- **[Agent](agents-and-assignments.md)** — the *identity* (backend,
  model, effort, role instructions, locked fields). Reusable across
  many work packages.
- **[Assignment](agents-and-assignments.md)** — the *work* (task list,
  input variables, optional default message). Reusable across many
  agents.
- **[Run](runs.md)** — a specific agent × assignment × variable
  binding, executed through the run loop, persisted as a manifest on
  disk.
- **[Backend](backends.md)** — the adapter that turns the run loop's
  abstract "invoke the agent" call into concrete subprocess or RPC
  traffic. Claude, Codex, Cursor, or Passive.
- **[Brief](agents-and-assignments.md#brief-and-caller-instructions)**
  — the composed worker-facing handoff for a run (agent instructions
  + assignment instructions + task-runner's worker workflow template
  + caller message). Stored in the manifest and fetched with
  `task-runner brief <run-id>`.
- **[Caller instructions](agents-and-assignments.md#caller-instructions)**
  — operator-facing docs on the assignment; never sent to the
  backend.

A run is the composition of an agent and an assignment with the
variables resolved. `--agent` and `--assignment` are both optional;
omit them for ad-hoc runs or chat-mode runs.

## Run lifecycle

```mermaid
stateDiagram-v2
    [*] --> initialized: task-runner init
    [*] --> running: task-runner run
    initialized --> running: run --resume-run <id>
    running --> running: retry (tasks still pending)
    running --> success: all tasks completed (exit 0)
    running --> exhausted: retries out, tasks incomplete (exit 1)
    running --> blocked: any task blocked (exit 2)
    running --> aborted: Ctrl+C or external interrupt (exit 130)
    running --> error: backend invocation failure (exit 4)
    aborted --> running: run --resume-run <id>
    success --> [*]
    exhausted --> [*]
    blocked --> [*]
    error --> [*]
```

Terminal states map 1-to-1 onto process exit codes — see the README's
exit-code table.

## What one attempt looks like

```mermaid
sequenceDiagram
    participant User
    participant CLI as task-runner run
    participant Runner as run-loop
    participant Manifest as run.json
    participant Backend as Backend adapter
    participant Agent as Agent process
    User->>CLI: --agent X --assignment Y
    CLI->>Runner: runAgent(opts)
    Runner->>Manifest: freeze manifest (brief, tasks, caller instructions)
    Runner->>Manifest: status=running
    loop until done or retries exhausted
        Runner->>Backend: invoke(brief or nudge, sessionId)
        Backend->>Agent: spawn / JSON-RPC
        Agent->>Manifest: task set / task append-notes (via task CLI)
        Agent-->>Backend: turn complete
        Backend-->>Runner: result + new sessionId
        Runner->>Manifest: read finalTasks
        alt all tasks completed
            Runner->>Manifest: status=success
        else tasks blocked
            Runner->>Manifest: status=blocked
        else incomplete, retries left
            Runner->>Runner: build nudge pointing at task CLI
        else retries exhausted
            Runner->>Manifest: status=exhausted
        end
    end
    Runner-->>CLI: RunOutcome
    CLI-->>User: summary + exit code
```

Canonical task state lives in `run.json.finalTasks`. The agent mutates
it through the `task` CLI (`task set`, `task append-notes`,
`task add`), never by editing a workspace markdown file. See
[runs.md](runs.md) for manifest details and the workspace layout, and
[tasks.md](tasks.md) for the task model and task-CLI workflow.

## Where everything lives

Each run has a workspace at
`${TASK_RUNNER_STATE_DIR}/runs/<repo-name>/<run-id>/`:

- **`run.json`** — the canonical manifest, written after every
  attempt and on terminal state. Holds the agent identity, the frozen
  role instructions and locks, the composed worker `brief`, the
  canonical task snapshots, caller instructions, dependency and
  attachment metadata, and every attempt record.
- **`assignment-seed.md`** — an immutable snapshot of the source
  assignment file at run-start time, **only** when the run started
  from an assignment file. Audit/debug only; nothing in the system
  reads it back at runtime.
- **`attempts/NN.json`** — raw per-attempt logs.
- **`attachments/<id>/<name>`** — file blobs bound to the run.

The manifest is the load-bearing piece: it is the canonical source of
truth for a run after first write. Moving, editing, or deleting the
source `agent.md` / `assignment.md` after a run has started has no
effect on that run — it lives off the frozen snapshot in `run.json`.
See [runs.md](runs.md) for the schema-version policy (currently
`schemaVersion: 7`, a hot cut from earlier generations).

## Host modes

- **Embedded mode** — the foreground CLI process owns execution.
- **Daemon mode** — `task-runner serve` owns live runs; CLI commands
  route through WebSocket JSON-RPC with `--connect /
  TASK_RUNNER_CONNECT`, while browser clients use HTTP + SSE on the
  same listener.

See [daemon.md](daemon.md) for the full control-plane contract.

---

The inline links above cover the per-topic deep dives. For the full
index of docs, see the [Documentation table in the
README](../README.md#documentation).

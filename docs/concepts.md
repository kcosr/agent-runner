# Concepts

The mental model behind task-runner, in one page. For detailed
references on any piece, follow the links.

## The four moving parts

- **[Agent](agents-and-assignments.md)** — the *identity* (backend,
  model, effort, role instructions, locked fields). Reusable across
  many work packages.
- **[Assignment](agents-and-assignments.md)** — the *work* (task list,
  input variables, optional default message). Reusable across many
  agents.
- **[Run](runs.md)** — a specific agent × assignment × variable binding,
  executed through the run loop, persisted as a manifest on disk.
- **[Backend](backends.md)** — the adapter that turns the run loop's
  abstract "invoke the agent" call into concrete subprocess or RPC
  traffic. Claude, Codex, Cursor, or Passive.

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
    participant Backend as Backend adapter
    participant Agent as Agent process
    participant WS as workspace/
    User->>CLI: --agent X --assignment Y
    CLI->>Runner: runAgent(opts)
    Runner->>WS: write assignment.md
    Runner->>WS: write run.json (status=running)
    loop until done or retries exhausted
        Runner->>Backend: invoke(prompt, sessionId)
        Backend->>Agent: spawn / JSON-RPC
        Agent->>WS: edit assignment.md in place
        Agent-->>Backend: turn complete
        Backend-->>Runner: result + new sessionId
        Runner->>WS: parse assignment.md
        alt all tasks completed
            Runner->>WS: run.json (status=success)
        else tasks blocked
            Runner->>WS: run.json (status=blocked)
        else incomplete, retries left
            Runner->>Runner: build nudge message
        else retries exhausted
            Runner->>WS: run.json (status=exhausted)
        end
    end
    Runner-->>CLI: RunOutcome
    CLI-->>User: summary + exit code
```

See [runs.md](runs.md) for manifest details and the workspace layout,
and [tasks.md](tasks.md) for the task model and workflow preamble.

## Where everything lives

Each run has a workspace at
`${TASK_RUNNER_STATE_DIR}/runs/<repo-name>/<run-id>/`:

- **`run.json`** — the canonical manifest, written after every attempt
  and on terminal state.
- **`assignment.md`** — the I/O buffer the agent edits in place (for
  `taskMode=file`; render-only for `taskMode=cli`).
- **`attempts/NN.json`** — raw per-attempt logs.
- **`attachments/<id>/<name>`** — file blobs bound to the run.

The manifest is the load-bearing piece: it is the canonical source of
truth for a run after first write. Moving, editing, or deleting
`agent.md` after a run has started has no effect on that run — it lives
off the frozen snapshot in `run.json`. See [runs.md](runs.md) for the
schema-version policy.

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

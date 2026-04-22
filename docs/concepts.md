# Concepts

`task-runner` drives an agent through a structured list of tasks and persists
the run state in a manifest-canonical workspace. This page gives a tour of the
core concepts. Each concept has its own detailed doc — follow the links when
you need specifics.

## The model in one paragraph

An **agent** supplies backend, model, and role instructions. An **assignment**
supplies a reusable task list and work context. A **run** is the persisted
execution instance created from one agent and (optionally) one assignment. A
run exposes two distinct instruction surfaces: the **worker brief** that is
sent to the backend and the **caller instructions** that are printed for the
human or script invoking the CLI. Task state is canonical in `run.json` and
workers mutate it through the `task-runner task ...` CLI.

## Agents

An agent is a markdown file with YAML frontmatter. The frontmatter declares
`backend`, `model`, `effort`, `timeoutSec`, `unrestricted`, and
`lockedFields`. The body is the agent's role instructions.

Bundled examples live under `agents/`. See
[agents-and-assignments.md](agents-and-assignments.md) for the full schema.

## Assignments

An assignment is a markdown file with YAML frontmatter that describes the
work: `cwd`, `vars`, `message`, `maxRetries`, `callerInstructions`, `tasks`,
and `lockedFields`. The body is the assignment instructions sent to the
worker.

Assignments are source definitions. They can be named definitions under
`${TASK_RUNNER_CONFIG_DIR}/assignments/<name>/assignment.md` or direct paths.
They are not a live workspace surface — task state lives in the manifest, not
in a workspace markdown file.

See [agents-and-assignments.md](agents-and-assignments.md).

## Runs

A run is a frozen execution record at:

```text
${TASK_RUNNER_STATE_DIR}/runs/<repo>/<run-id>/
```

The canonical record is `run.json`. If the run was created from an assignment
file, an immutable `assignment-seed.md` snapshot is also stored for audit.

Lifecycle states:

- `initialized` — created by `init`, awaiting execution
- `running` — actively executing
- `success` | `blocked` | `exhausted` | `aborted` | `error` — terminal states

Runs can be archived, reset, or deleted (archived-only). See
[runs.md](runs.md) and [resume.md](resume.md).

## Tasks

Tasks are the canonical unit of work. Each has `id`, `title`, `body`,
`status`, and `notes`. Statuses are `pending`, `in_progress`, `completed`,
and `blocked`.

Workers drive tasks through the CLI:

```bash
task-runner task list <run-id>
task-runner task show <run-id> <task-id>
task-runner task set <run-id> <task-id> --status in_progress
task-runner task append-notes <run-id> <task-id> --text "..."
```

Mutation rules depend on run lifecycle state and whether the backend is
passive. See [tasks.md](tasks.md).

## Brief and caller instructions

task-runner maintains two separate instruction surfaces:

- **Worker brief** (`brief`) is the worker-facing handoff. It is composed
  from agent instructions, assignment instructions, the task-runner workflow
  template, and the run message. It is frozen in the manifest and re-used on
  every attempt. Fetch it with `task-runner run brief <run-id>`.
- **Caller instructions** (`callerInstructions`) are assignment docs for the
  human or script invoking task-runner. They are printed to stderr on fresh
  `run` / `init`, exposed through `run status --output-format json`, and never
  sent to the backend.

## Variables

Assignments can declare typed variables with ordered
`sources: [cli | env | parent, ...]`. Values are resolved at run
creation, frozen in `manifest.runtimeVars`, and annotated in
`manifest.runtimeVarSources`. Nested runs launched from workers
automatically link to their parent run, so descendant assignments can
inherit values such as `worktree_path` without repeating `--var` flags.
Read surfaces redact env-backed values even though the frozen manifest
keeps the concrete value for descendant resolution. `{{var}}` references
are interpolated into titles, bodies, and instructions.

See [variables.md](variables.md).

## Backends

A backend is the runtime that actually executes the worker:

- `claude`
- `codex` (stdio or WebSocket app-server)
- `cursor` (`cursor-agent`)
- `pi`
- `passive` — no backend invocation; the run is driven externally through
  the task CLI

See [backends.md](backends.md).

## Attachments and dependencies

Runs can carry **attachments** (files stored under the run workspace with
SHA-256 integrity). `attachment list --cwd-scope` groups attachments across
peer runs with the same persisted `cwd`. See
[attachments.md](attachments.md).

Runs can declare **dependencies** on other runs. Dependencies are metadata
on initialized runs; execution is gated until all dependencies reach
`success`. See [dependencies.md](dependencies.md).

## Daemon and web dashboard

`task-runner serve` hosts a local control plane: WebSocket JSON-RPC for CLI
clients, HTTP + SSE for browser clients, and the bundled web dashboard from
`apps/web`. The CLI can route through the daemon with `--connect` or
`TASK_RUNNER_CONNECT`. See [daemon.md](daemon.md) and
[web-dashboard.md](web-dashboard.md).

## Where to go next

- [design.md](design.md) — canonical design, schema, lifecycle, repo layout
- [cli.md](cli.md) — full command/flag reference
- [configuration.md](configuration.md) — env vars, state roots, XDG
- [examples.md](examples.md) — bundled agents and assignments

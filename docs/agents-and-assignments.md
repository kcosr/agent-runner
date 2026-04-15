# Agents and assignments

A run is the composition of two files:

- **Agent** (`agents/<name>/agent.md`) is the *identity* — backend,
  model, effort level, working directory, role instructions, and any
  locks the agent wants to enforce. Reusable across many different work
  packages.
- **Assignment** (`assignments/<name>/assignment.md`) is the *work* —
  task list, input variables, optional default message, optional
  session display name. Reusable across many different agents.

## Minimal agent

```yaml
---
schemaVersion: 1
name: example
backend: claude
model: claude-sonnet-4-6
effort: medium
unrestricted: true
---
You are a repository orientation assistant. Be concrete and cite
file paths and line numbers.
```

## Minimal assignment

```yaml
---
schemaVersion: 1
name: repo-orientation
maxRetries: 3                          # retry budget per session, default 3
vars:
  repo_path:
    type: string
    required: true
    source: cli
# Optional: documentation printed to the CALLER (the human or script
# running task-runner), never sent to the backend. Shown on stderr at
# fresh `run` / `init` only. Interpolates {{vars}} like other body
# fields. Re-fetch any time with:
#   task-runner status <id> --output-format json --field callerInstructions
callerInstructions: |
  Your run id is {{run_id}}. The structured report lands in
  {{assignment_path}} — parse per-task notes blocks for findings.
tasks:
  - id: read_conventions
    title: Check repo conventions
    body: |
      Read AGENTS.md and CLAUDE.md (if present). Capture the coding
      style, test requirements, and PR conventions in this task's
      Notes block.
  - id: inventory_packages
    title: Inventory packages
    body: List the top-level packages and what each one does.
---
You are working on the repository at `{{repo_path}}`. Plan at
{{assignment_path}}.
```

## Resolution

Both can be passed by direct path, or by bare name if the definition
is installed under `TASK_RUNNER_CONFIG_DIR` (default:
`$XDG_CONFIG_HOME/task-runner` or `~/.config/task-runner`). Bare names
do not fall back to `./agents/` or `./assignments/`; definitions in the
repo checkout should be referenced by path unless you export
`TASK_RUNNER_CONFIG_DIR=$PWD`.

`--assignment` is optional — running an agent with no assignment is
"chat mode" (no enforced task list, just a single backend invocation).

## Ad-hoc agents

`--agent` is also optional. When omitted, task-runner synthesizes an
**ad-hoc agent** from CLI overrides — useful for quick one-off runs,
scripted orchestration, or any flow where a dedicated `agent.md` file
would be overkill.

Ad-hoc agents:

- are named `ad-hoc` (a reserved name — on-disk agents can't use it)
- have no role instructions body
- have `lockedFields: []` (nothing is locked by default)
- require `--backend` to be passed explicitly

Everything else falls back to sensible defaults. For example:

```bash
# Passive ad-hoc run — no agent file, no model calls, just a
# structured checklist driven by task set / task add.
task-runner init --backend passive \
  --assignment ./assignments/repo-diagnostics/assignment.md \
  --var repo_path=.

# Codex ad-hoc run — backend + model from the CLI, assignment for
# the task list, no agent.md required.
task-runner run --backend codex --model gpt-5.4 --effort high \
  --assignment ./assignments/code-review/assignment.md \
  --var repo_path=. --var range=HEAD~3..HEAD

# Cursor ad-hoc run — public headless print mode via cursor-agent,
# with unrestricted mapping to Cursor's --force flag.
task-runner run --backend cursor --unrestricted \
  --assignment ./assignments/repo-diagnostics/assignment.md \
  --var repo_path=.
```

If you need role instructions or locks, create a real `agent.md`.

## Caller instructions

Assignments can carry a `callerInstructions` field with documentation
for the *human or script* invoking task-runner, as opposed to the
agent doing the work. It is:

- printed to stderr on fresh `run` / `init` only
- interpolated with `{{var}}` like other body fields
- never sent to the backend
- always retrievable via `task-runner status <id> --output-format json
  --field callerInstructions`

The audience split — one text block for the agent, one for the caller
— keeps each free of noise meant for the other.

## Locked fields

Either an agent or an assignment can declare a `lockedFields` list. At
run time the two lists are unioned, and any caller-provided override
for a locked field is rejected with `LockedFieldError` and exit code
`3`.

Lockable fields:

```
cwd  backend  model  effort  instructions  message
timeoutSec  unrestricted  maxRetries  tasks  taskMode
```

Use this to distribute an agent that pins its own model
(`lockedFields: [model]`), or an assignment with a fixed message the
caller cannot override (`lockedFields: [message]`), or an agent that
refuses to be pointed at any other backend (`lockedFields: [backend]`).

For the full ownership table and edge cases see
[`design.md`](design.md#locked-fields).

## What freezes at first write

Once the manifest is written (on `init` or first `run` attempt):

- The agent's role instructions, locked fields, timeout budget, and
  top-level config are **snapshotted** into `run.json`.
- Vars are resolved and **frozen** into the manifest.
- The backend session id (once captured) is **bound** to the run's cwd.

Resume reads from the manifest and never re-reads the source files.
This is what makes ad-hoc agents work: once the manifest is written,
there's no source file and the run doesn't care. See
[resume.md](resume.md) for the full override matrix on resume.

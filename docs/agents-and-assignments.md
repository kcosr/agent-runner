# Agents and Assignments

Agents and assignments are the two source-definition surfaces that together
configure a run. An **agent** supplies the backend, runtime parameters, and
role instructions. An **assignment** supplies a reusable task list, vars, and
work context.

## Definition layout

Definitions live under `${TASK_RUNNER_CONFIG_DIR}` (default
`~/.config/task-runner`) or can be passed as direct paths:

```text
${TASK_RUNNER_CONFIG_DIR}/
├── agents/
│   └── <agent-name>/
│       └── agent.md
└── assignments/
    └── <assignment-name>/
        └── assignment.md
```

Bundled examples live in this repo under `agents/` and `assignments/`. See
[examples.md](examples.md).

CLI references to agents and assignments accept either a bare name (resolved
against the config dir) or a path to a specific `agent.md` / `assignment.md`.

## Agent definition

An agent file is markdown with a YAML frontmatter block followed by the role
instructions.

### Frontmatter schema

```yaml
---
schemaVersion: 1            # required, must be 1
name: implementer           # required, min 1 char; "ad-hoc" is reserved
backend: codex              # required: claude | codex | cursor | pi | passive
model: gpt-5.4              # optional backend-specific id
effort: high                # optional: off | minimal | low | medium | high | xhigh | max
timeoutSec: 3600            # optional positive integer (default 3600)
unrestricted: true          # optional boolean (default false)
lockedFields: []            # optional list of lockable fields
---
```

### Body

Everything after the frontmatter is the agent's role instructions. The body
is trimmed, interpolated against the run's resolved variables, and frozen
into `manifest.agent.instructions` at run creation. Resume never re-reads
the source file.

### Locked fields

`lockedFields` is a list of fields that CLI overrides cannot change at
fresh-run time. The lock set is the union of the agent's and assignment's
`lockedFields` and is frozen into `manifest.lockedFields`.

Supported lockable fields:

- `cwd`
- `backend`
- `model`
- `effort`
- `instructions`
- `message`
- `timeoutSec`
- `unrestricted`
- `maxRetries`
- `tasks`

Violations raise `LockedFieldError` with the current value shown.

## Assignment definition

An assignment file is markdown with a YAML frontmatter block followed by the
assignment instructions.

### Frontmatter schema

```yaml
---
schemaVersion: 1
name: repo-orientation              # required
cwd: /absolute/or/relative/path     # optional; defaults to caller cwd
message: optional default message   # optional
maxRetries: 3                       # optional int 0-20, default 3
callerInstructions: |               # optional; not sent to backend
  Operator docs for this assignment.
vars:                               # optional variable schema
  range:
    type: string
    source: cli
    default: full
tasks:                              # optional, max 100, ids unique
  - id: orient
    title: Orient to the repo
    body: |
      Read README.md and AGENTS.md.
lockedFields: []                    # optional lockable fields
---
```

Task definitions must match:

- `id`: `[A-Za-z0-9._:-]+`, max 128 chars, unique within the assignment
- `title`: 1–200 chars, single line
- `body`: optional free-form markdown

### Body

Everything after the frontmatter is the assignment instructions. The body
is interpolated against resolved variables and frozen into the composed
brief at run creation.

Assignments are markdown definitions, not a live workspace surface. Task
state is canonical in the run manifest — not in the assignment file.

## cwd resolution

Fresh-run cwd precedence:

1. `--cwd` CLI override
2. Assignment `cwd` (absolute, or resolved relative to caller cwd)
3. Caller cwd

The resolved path is used to derive the `repo` bucket (via the enclosing
`.git` common dir) and to bind backend sessions to the cwd.

## Prompt composition

The worker brief is composed at run creation (and rewritten on resume when
newly-added tasks appear):

1. Agent role instructions
2. Assignment instructions
3. task-runner worker workflow template (only if tasks exist)
4. Run message (CLI positional message, or the assignment's default
   `message`, or an implicit continue message on resume with incomplete
   tasks)

The workflow template teaches the worker to drive tasks through the
task CLI. See [tasks.md](tasks.md).

Caller instructions are never part of the brief — they are a separate
operator-facing surface.

## Variable interpolation

All of the following are interpolated against resolved variables before
being frozen into the manifest:

- Agent role instructions
- Assignment instructions
- Task titles and bodies
- Caller instructions

The syntax is `{{key}}` (whitespace permitted). Always-available variables
include `run_id`, `cwd`, `assignment_path`, and `task_runner_cmd`. See
[variables.md](variables.md).

## Inspecting definitions

```bash
task-runner list agents
task-runner list assignments

task-runner show agent <name|path>
task-runner show assignment <name|path>
```

These surfaces render the parsed frontmatter, interpolation hooks, and task
list for human review.

## Authoring tips

- Keep agent instructions focused on role (tone, approach, standards).
  Leave work-specific instructions in the assignment.
- Use `callerInstructions` for anything the human invoking task-runner needs
  but the worker does not. The worker never sees it.
- Use `lockedFields: [tasks]` on assignments whose task list must not be
  dropped or reordered at runtime.
- `unrestricted: true` bypasses the backend's approval prompts — use only
  for trusted agents.

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
backendSpecific:            # optional backend-specific runtime config
  codex:
    transport:
      type: ws
      url: ws://127.0.0.1:4773/
lockedFields: []            # optional list of lockable fields
---
```

Only Codex currently defines `backendSpecific`. Its transport contract is
exactly one of:

- `{ type: "stdio" }`
- `{ type: "ws", url: "<absolute ws:// or wss:// URL>" }`

Other backends do not accept `backendSpecific`, and this pass does not
add generic backend-specific env passthrough.

Frontmatter scalar values are resolved for `${...}` env expressions before
schema validation. Typed surfaces such as `name`, `backend`, `model`,
`timeoutSec`, `unrestricted`, and `backendSpecific.codex.transport.url`
require the whole value to be exactly one env expression:

```yaml
---
name: ${AGENT_NAME}
timeoutSec: ${AGENT_TIMEOUT:-3600}
backendSpecific:
  codex:
    transport:
      type: ws
      url: ${CODEX_URL}
---
```

Partial `${...}` interpolation is rejected for those typed fields, so
`name: "agent-${AGENT_NAME}"` fails at load time. `${...}` also cannot
replace whole objects or arrays such as `backendSpecific`.

### Body

Everything after the frontmatter is the agent's role instructions. The body
is trimmed, interpolated against the run's resolved variables, and frozen
into `manifest.agent.instructions` at run creation. Resume never re-reads
the source file.

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

Assignment frontmatter uses the same config-time `${...}` loader pass.
Typed fields such as `cwd`, `maxRetries`, task ids, var metadata, and lock
entries require exact-match env expressions. Prose fields such as
`message`, `callerInstructions`, var descriptions, and task title/body may
embed `${...}` within larger strings:

```yaml
---
cwd: ${WORKTREE_DIR}
maxRetries: ${MAX_RETRIES:-3}
message: Review ${TARGET_BRANCH} before shipping
callerInstructions: Check ${ENVIRONMENT} first
vars:
  retries:
    type: number
    default: ${DEFAULT_RETRIES:-5}
    description: Retry budget for ${ENVIRONMENT}
tasks:
  - id: review
    title: Review ${TARGET_BRANCH}
    body: Validate ${ENVIRONMENT} before merge.
---
```

If a required env var is missing or empty, a typed value cannot be
coerced, or `${...}` is used on a disabled object or array surface,
definition loading fails with a config error that names the config path
and env var.

## Locked fields

Both agents and assignments can declare `lockedFields`. The two sets are
merged and frozen into `manifest.lockedFields` at run creation. A locked
field rejects CLI overrides of the final resolved value at fresh run,
regardless of which definition authored that value.

The set of fields that can be locked is shared between the two schemas:

| Field | Typically authored by |
|-------|-----------------------|
| `backend` | agent |
| `model` | agent |
| `effort` | agent |
| `instructions` | agent (role) and assignment (work) |
| `timeoutSec` | agent |
| `unrestricted` | agent |
| `cwd` | assignment |
| `message` | assignment |
| `maxRetries` | assignment |
| `tasks` | assignment |

Either side can lock any field. In practice you usually lock what your
definition owns — an agent locks `model` / `effort` / `unrestricted`; an
assignment locks `tasks` / `cwd` / `message`. A locked `tasks` set on an
assignment, for example, prevents `--add-task` CLI overrides and prevents
the runtime from dropping or reordering the list.

Violations raise `LockedFieldError` with the current value shown.

## cwd resolution

Fresh-run cwd precedence:

1. `--cwd` CLI override
2. Assignment `cwd` (absolute, or resolved relative to caller cwd)
3. Caller cwd

The resolved path is used to derive the `repo` bucket (via the enclosing
`.git` common dir) and to bind backend sessions to the cwd.

## Codex transport resolution

When `backend: codex`, the resolved transport is frozen at fresh-run or
init time and then reused on resume:

1. Agent frontmatter `backendSpecific.codex.transport`
2. Connected/daemon-only request override
   `overrides.backendSpecific.codex.transport`
3. `TASK_RUNNER_CODEX_WS_URL`
4. `{ type: "stdio" }`

Once frozen into the manifest, later env drift does not change the run's
Codex transport.

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
include `run_id`, `cwd`, `config_dir`, `state_dir`, `assignment_name`,
`assignment_path`, and `task_runner_cmd`. See [variables.md](variables.md).

This runtime `{{key}}` interpolation is distinct from the config-time
`${...}` env interpolation used while loading frontmatter.

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

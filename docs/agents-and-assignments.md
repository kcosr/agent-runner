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
├── tasks/
│   └── <task-id>.md
├── launchers/
│   └── <launcher-name>.yaml
├── hooks/
│   └── <hook-name>/
│       └── hook.ts
└── assignments/
    └── <assignment-name>/
        ├── assignment.md
        └── hooks/
            └── local-hook.mts
```

Bundled examples live in this repo under `agents/`, `assignments/`, and
shared task definitions under `tasks/`. See [examples.md](examples.md).

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
backendArgs:                # optional per-backend extra argv tokens
  claude:
    extraArgs: ["--profile", "default"]
  codex:
    extraArgs: ["--model", "gpt-5.4"]
lockedFields: []            # optional list of lockable fields
launcher: ssh-docker        # optional named launcher or inline object
---
```

`launcher` supports exactly these authored shapes:

- bare string: a named launcher id such as `ssh-docker`
- inline object with `command` and optional `args`

The built-in `direct` launcher is always available and means "no
prefix". User-authored launcher files live under
`${TASK_RUNNER_CONFIG_DIR}/launchers/*.yaml|*.yml`; their canonical id is
the filename stem, and authored `name`, when present, must match that
stem exactly.

Only Codex currently defines `backendSpecific`. Its transport contract is
exactly one of:

- `{ type: "stdio" }`
- `{ type: "ws", url: "<absolute ws:// or wss:// URL>" }`
- `{ type: "uds", path: "/absolute/socket/path" }`

Other backends do not accept `backendSpecific`, and this pass does not
add generic backend-specific env passthrough.

`backendArgs` lets an agent append backend-owned CLI flags without adding
a new task-runner option. It is keyed by backend id, and each entry has an
`extraArgs` string array:

```yaml
---
schemaVersion: 1
name: claude-extra
backend: claude
backendArgs:
  claude:
    extraArgs:
      - --profile
      - ${CLAUDE_PROFILE:-default}
---
```

```yaml
---
schemaVersion: 1
name: codex-extra
backend: codex
backendArgs:
  codex:
    extraArgs:
      - --model
      - gpt-5.4
---
```

Backend keys must be one of `claude`, `codex`, `cursor`, `pi`, or
`passive`; unknown keys and unknown entry fields are config errors.
Tokens must be non-empty strings. Dormant entries are allowed, so an
agent can carry both `claude` and `codex` entries and activate the
selected one when `--backend` chooses that backend. Passive entries are
accepted for schema symmetry but inert: passive runs resolve no backend
argv.

The selected backend's `extraArgs` are resolved at fresh-run/init time and
frozen into `manifest.resolvedBackendArgs` and
`manifest.resetSeed.resolvedBackendArgs`. Resume, reset, ready-start, and
reconfigure reuse the frozen values instead of re-reading current agent
frontmatter. Local `run.json` stores those frozen args; normal CLI,
daemon, and web status DTOs do not expose them.

Frontmatter scalar values are resolved for `${...}` env expressions before
schema validation. Typed surfaces such as `name`, `backend`, `model`,
`timeoutSec`, `unrestricted`, `backendSpecific.codex.transport.url`,
`backendSpecific.codex.transport.path`, and individual
`backendArgs.<backend>.extraArgs[]` tokens require the whole value to be
exactly one env expression:

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
`name: "agent-${AGENT_NAME}"` and `--flag=${VALUE}` fail at load time.
`${...}` also cannot replace whole objects or arrays such as
`backendSpecific` or `backendArgs`.

### Body

Everything after the frontmatter is the agent's role instructions. The body
is trimmed, interpolated against the run's resolved variables, and frozen
into `manifest.agent.instructions` at run creation. Resume never re-reads
the source file.

## Launcher definitions

A launcher file is YAML only, not markdown:

```yaml
schemaVersion: 1
name: ssh-docker
command: ssh
args: [worker, docker, exec, agent]
```

- `schemaVersion` must be `1`
- `command` is the executable to prepend
- `args` is an optional string array inserted before the backend command
- `direct` is reserved; user files may not claim that id

List/show commands resolve launchers the same way as agents and
assignments:

```bash
task-runner list launchers
task-runner show launcher ssh-docker
```

Fresh-run launcher precedence is:

1. CLI/daemon override `--launcher <name>` / `overrides.launcher`
2. agent-authored `launcher`
3. built-in `direct`

The override is named-only by design. Inline launchers are authored on
agents, not supplied ad hoc on the CLI or daemon request boundary.

Connected mode is daemon-authoritative for named launchers: the daemon
resolves the name against its own `${TASK_RUNNER_CONFIG_DIR}` and freezes
the result into the manifest. Resume and reset reuse that frozen
launcher; they do not re-read current launcher files.

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
schedule:                           # optional delayed/recurring start
  cron: "0 9 * * *"                 # exactly one of at, delay, cron
  timezone: UTC                     # cron-only, default local timezone
  mode: clone                       # cron-only: reuse, reset, clone
  continueOnFailure: false          # cron-only
callerInstructions: |               # optional; not sent to backend
  Operator docs for this assignment.
vars:                               # optional variable schema
  range:
    type: string
    sources: [cli]
    default: full
tasks:                              # optional, max 100, ids unique
  - id: orient
    title: Orient to the repo
    body: |
      Read README.md and AGENTS.md.
    hooks:
      - builtin: require-children-success
        with:
          requireAny: true
hooks:                              # optional hook arrays by phase
  prepare:
    - name: freeze-prepare
  beforeAttempt:
    - builtin: command
      when:
        sessionIndex: [0]
  taskTransition:
    - path: ./hooks/guard.mts
      when:
        toStatus: [completed]
lockedFields: []                    # optional lockable fields
---
```

Task definitions must match:

- `id`: `[A-Za-z0-9._:/-]+`, max 128 chars, unique within the assignment
- `title`: 1–200 chars, single line
- `body`: optional free-form markdown
- `hooks`: optional task-local `taskTransition` hook entries using the
  same `builtin` / `name` / `path`, `when`, and `with` authoring shape
  as root `hooks.taskTransition[]`

Assignments may also mix reusable task refs with inline task objects:

- bare strings such as `orient` or `review/reuse` resolve as named task
  refs under `${TASK_RUNNER_CONFIG_DIR}/tasks`
- only absolute paths and strings beginning with `./` or `../` resolve
  as explicit task file paths
- inline objects stay local to the assignment

Named task definitions are markdown files under
`${TASK_RUNNER_CONFIG_DIR}/tasks/<task-id>.md`:

```md
---
schemaVersion: 1
id: review/reuse
title: Reuse review
hooks: []
---
Read the shared review checklist.
```

- the canonical task id is the slash-relative file key under `tasks/`
  without the `.md` suffix
- frontmatter `id`, when present on a config-root named task, must match
  that canonical id
- explicit task file paths outside the config root may use an authored
  `id` that differs from the filesystem-derived id; that authored `id`
  becomes the resolved task id for that direct-path load
- the markdown body becomes the resolved task `body`
- `loadAssignmentConfig()` resolves named and path refs into the normal
  plain task objects before runtime; later `{{var}}` interpolation still
  happens during run construction
- named tasks are loader-only in this pass; there is no top-level
  `task-runner list tasks` or `show task` definition surface

Assignment schedules use the same input shape as CLI/API schedule
requests. Define exactly one of:

- `at`: absolute ISO timestamp for a one-time schedule
- `delay`: duration such as `30m`, `2h`, or `1d` for a one-time schedule
- `cron`: recurring cron expression

`timezone`, `mode`, and `continueOnFailure` are valid only with `cron`.
`mode` controls recurring completion behavior: `reuse` advances the same
run, `reset` resets the same run from its frozen reset seed, and `clone`
creates a ready child run from the frozen seed. Schedule fields support
the same scalar interpolation used by other config values; interpolation
does not replace the schedule object as a blob. Resume, reset, and clone
reuse the frozen manifest schedule and do not re-read assignment source.

Canonical identity comes from the on-disk key for every authored
definition:

- agents: slash-relative directory under `agents/`
- assignments: slash-relative directory under `assignments/`
- tasks: slash-relative file under `tasks/`
- launchers: slash-relative file under `launchers/`

Discovery warns and skips config-root definitions whose authored
internal id does not match that canonical key. Direct named/path loads of
those skipped config-root definitions still fail clearly.

Direct path loads outside `TASK_RUNNER_CONFIG_DIR` are one-off file loads,
not named config-root discovery. They may use authored agent,
assignment, task, and launcher identities that differ from the
filesystem-derived fallback id; when an outside-root task `id` or launcher
`name` is present, that authored value is the loaded identity. This keeps
generated drafts and other one-off definition files usable without adding
them to the named-definition namespace.

Launcher follow-up remains aligned with the same explicit reference
model: launcher strings should keep meaning named launchers unless they
are absolute paths or begin with `./` or `../`.

### Body

Everything after the frontmatter is the assignment instructions. The body
is interpolated against resolved variables and frozen into the composed
brief at run creation.

Variable authoring is order-preserving. Use `sources: [...]` to declare
explicit precedence across `cli`, `env`, and `parent`. Nested runs
launched from a worker automatically carry `parentRunId`, so descendant
assignments can inherit values such as `worktree_path` and
`worktree_base_ref` from the nearest ancestor without manual `--var`
handoff.

Assignments are markdown definitions, not a live workspace surface. Task
state is canonical in the run manifest — not in the assignment file.

Assignment frontmatter uses the same config-time `${...}` loader pass.
Typed fields such as `cwd`, `maxRetries`, task ids, var metadata, and lock
entries require exact-match env expressions. String prose fields such as
`message`, `callerInstructions`, var descriptions, task title/body, and
the markdown body text only interpolate when the whole field is exactly one
`${...}` expression; partial `${...}` inside a larger prose string stays
literal:

```yaml
---
cwd: ${WORKTREE_DIR}
maxRetries: ${MAX_RETRIES:-3}
message: ${MESSAGE_TEXT}
callerInstructions: ${CALLER_TEXT}
vars:
  retries:
    type: number
    default: ${DEFAULT_RETRIES:-5}
    description: ${RETRY_DESCRIPTION}
tasks:
  - id: review
    title: ${REVIEW_TITLE}
    body: ${REVIEW_BODY}
---
```

Literal examples such as `message: Review ${TARGET_BRANCH} before shipping`
remain authored text; they do not trigger config-time env interpolation.

If a required env var is missing or empty, a typed value cannot be
coerced, or `${...}` is used on a disabled object or array surface,
definition loading fails with a config error that names the config path
and env var.

## Assignment hooks

Assignments can declare hook arrays under these phases:

- `prepare`
- `beforeAttempt`
- `afterAttempt`
- `afterExit`
- `taskTransition`

Each hook entry must select exactly one source:

```yaml
hooks:
  prepare:
    - builtin: git-worktree
      with:
        repo: "{{cwd}}"
        from: main
        branch: feature-review
        path: "{{cwd}}/.worktrees/feature-review"
    - name: freeze-prepare
      with:
        mode: strict
    - path: ./hooks/seed-context.mts
```

Resolution rules:

- `builtin` loads one of the first-party hooks shipped by core.
- `name` resolves from `${TASK_RUNNER_CONFIG_DIR}/hooks/<name>/hook.(ts|mts|js|mjs)`.
- `path` resolves relative to the authored `assignment.md`.
- Raw `.ts` / `.mts` hook files load directly through the runtime's
  `jiti` loader. Hook authors do not need a separate build step.

Supported `when` filters are intentionally narrow:

- attempt phases (`beforeAttempt`, `afterAttempt`, `afterExit`) support
  `when.sessionIndex` and `when.attemptIndexInSession`, each as one integer or
  an array of integers. Session index `0` is the first execution session;
  attempt-in-session `0` is the first backend attempt within that
  execution session.
- `taskTransition` supports:
  - `when.taskId`
  - `when.taskIds`
  - `when.fromStatus`
  - `when.toStatus`
  - `when.source`

Task-local `tasks[].hooks[]` are always `taskTransition` hooks scoped to
the enclosing task. They do not use a nested `taskTransition:` key under
the task.

Prepare hooks run once during fresh `run` / `init`, before the first
manifest write. Their resolved descriptor, config, mutated prompts, vars,
cwd, and hook state are then frozen into the manifest. Resume and reset
reuse that frozen prepare output instead of re-reading the current hook
source.

Hook mutation boundaries:

- `prepare` may mutate run config (`cwd`, backend/model/effort,
  timeout/unrestricted, prompts, locked fields), runtime vars, hook
  state, note/pin metadata, task patches, and attachments. Backend args
  are resolved from the final selected backend after prepare changes.
- non-prepare phases may mutate run config, hook state, note/pin
  metadata, task patches, and attachments, but not runtime vars.
- task-transition hooks run transactionally around `task set`,
  `task append-notes`, `task add`, and the run loop's own task writes.
  If a task-transition hook rejects, the requested task edit rolls back,
  but the hook's own accepted side effects such as notes, pins,
  attachments, or task patches still persist.

Built-in hooks:

- `git-worktree` runs in `prepare` and `beforeAttempt`. It ensures a git
  worktree, switches the run `cwd` to that path, and in `prepare` also
  projects `worktree_path` into runtime vars.
- `git-clone` runs in `prepare` only. It clones a remote or local Git URL
  into a checkout, switches the run `cwd` to that checkout before the
  manifest is first written, and projects clone metadata into runtime
  vars. Resume and reset reuse the frozen cwd and vars; they do not
  re-contact the remote.
- `command` runs in every phase. `mode: status` treats exit code `0` as
  success and a non-zero exit code as block/reject. `mode: json`
  requires exit code `0` and parses a full hook result from stdout;
  malformed JSON is a runtime error.
- `require-children-success` runs in `taskTransition`. It guards
  completion until all direct child runs of the current run are
  `success`. Scope it with task-local placement or native
  `when.taskId` / `when.taskIds`, and set `requireAny: true` only when
  the task must refuse completion until at least one child run exists.

`git-clone` hook config uses snake_case fields only:

```yaml
hooks:
  prepare:
    - builtin: git-clone
      with:
        repo_url: git@github.com:org/repo.git
        ref: feature-branch
        path: /tmp/task-runner-review-checkout
        remote_name: origin
        depth: 1
```

- `repo_url` is required and must be a non-empty string.
- `ref` is optional. Empty interpolated values are treated as omitted; when
  omitted, git leaves the clone on the remote default branch.
- `path` is optional. When omitted, the checkout path defaults to
  `${TASK_RUNNER_STATE_DIR}/checkouts/<repo_slug>-<run_id>`, where the
  slug is derived from the repo URL and sanitized to one filesystem-safe
  path segment.
- `remote_name` is optional and defaults to `origin`.
- `depth` is optional and must be a positive integer.

If the checkout path already exists and is non-empty, `git-clone` fails
before cloning. On success it emits `repo_slug`, `checkout_path`,
`commit_sha`, and `resolved_ref` when the ref can be determined reliably.
Do not put credentials in `repo_url`: runtime vars are persisted in
`run.json`. Use SSH agents or Git credential helpers instead.

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
| `schedule` | assignment |

Either side can lock any field. In practice you usually lock what your
definition owns — an agent locks `model` / `effort` / `unrestricted`; an
assignment locks `tasks` / `cwd` / `message` / `schedule`. A locked
`tasks` set on an assignment, for example, prevents `--add-task` CLI
overrides and prevents the runtime from dropping or reordering the list.
A locked `schedule` rejects CLI/API replacement at initialization, ready
promotion, `run schedule` set, and one-time clear. Enable/disable can
still pause or resume the already-authored schedule definition.

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
3. `TASK_RUNNER_CODEX_UDS_PATH` or `TASK_RUNNER_CODEX_WS_URL` forwarded by
   the connected client
4. `TASK_RUNNER_CODEX_UDS_PATH` or `TASK_RUNNER_CODEX_WS_URL` from the daemon
   process environment
5. `{ type: "stdio" }`

UDS transport uses WebSocket-over-UDS for Codex app-server, not raw UDS
bytes, and `path` must be absolute. If both UDS and WS env vars are set
with no higher-precedence transport, Task Runner fails fast. Resume does
not re-read these env vars because the transport is already frozen.

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
and `task_runner_cmd`. See [variables.md](variables.md).

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

Reusable named task definitions are intentionally not a first-class
`list/show` CLI kind yet. They are inspected through assignment loading
and rendering only.

## Authoring hook modules

First-party and custom hooks share the public authoring surface exported
from `@task-runner/core/hooks`:

```ts
import { defineHook, type PrepareHookContext } from "@task-runner/core/hooks";

export default defineHook({
  name: "freeze-prepare",
  prepare(ctx: PrepareHookContext) {
    return {
      action: "continue",
      mutate: {
        state: { prepared: true },
        note: `prepared in ${ctx.run.cwd}`,
      },
    };
  },
});
```

Use `defineHook(...)` for type inference and return one of:

- `action: "continue"` to keep going
- `action: "reinvoke"` with `followUpPrompt` to rewrite the next prompt
- `action: "block"` with `reason` to stop the run

Task-transition hooks return `{ accept: true }` or
`{ accept: false, reason }` instead.

## Authoring tips

- Keep agent instructions focused on role (tone, approach, standards).
  Leave work-specific instructions in the assignment.
- Use `callerInstructions` for anything the human invoking task-runner needs
  but the worker does not. The worker never sees it.
- Use `lockedFields: [tasks]` on assignments whose task list must not be
  dropped or reordered at runtime.
- `unrestricted: true` bypasses the backend's approval prompts — use only
  for trusted agents.

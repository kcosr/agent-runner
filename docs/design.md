# task-runner — Design

## Purpose

`task-runner` is a minimal CLI that invokes an AI agent (starting with Claude)
with a pre-seeded task list and loops until the agent has accounted for every
task. If the agent leaves any task marked `pending` at the end of a turn, the
runner re-invokes it up to a configurable number of retries. If the agent
reports a task as `blocked`, the runner stops and surfaces the blocker instead
of spinning.

Task status is self-reported by the agent via the `**Status:**` field in the
workspace `assignment.md`; the runner parses that field but does not
independently verify that the work was actually performed. The value of the
structure is that the agent cannot silently skip an item — every task must be
explicitly accounted for, and the per-task Notes block captures evidence for
after-the-fact audit. For stronger guarantees, encode verification into the
task body (e.g., "run `npm test` and paste the exit code into Notes").

It is a deliberate strip-down of concepts from `agent-runner`. The goal is a
small, focused tool — no daemon, no web console, no storage layer, no fully
customizable hook framework. Just: "invoke an agent with this config, drive it
through this task list with retries, return the output."

The canonical record of every run is a machine-readable manifest
(`run.json`) written to the per-run workspace directory. Each run also
writes an ephemeral scratch file (`assignment.md`) that the agent edits in place
during the run; after the run ends, `assignment.md` is purely diagnostic — the
manifest is the source of truth.

## Non-goals

- Interactive sessions (TTY passthrough). We do resume sessions across
  retries, but non-interactively and only within a single run — see
  [Session resume](#session-resume-across-retries) below.
- Streaming event protocol (JSONL, WebSocket, etc.) exposed to the user
- Multi-agent orchestration / handles / lineage
- Persistent run history or a daemon/server component
- Fully customizable hooks (pre-invoke, post-invoke, event masks, mutation
  policies). `task-runner` has exactly one baked-in behavior: parse the
  agent's self-reported task statuses after each turn and retry when any are
  still `pending`.
- Verification that an agent *actually* performed the work for a task. The
  runner reads the `**Status:**` string the agent wrote; it never checks the
  agent's claims against reality. See Purpose above.
- Tool/MCP management
- Web UI

## High-level flow

```
task-runner run --agent <name> [--assignment <name>] [--var k=v]...
                               [--output-format text|json] [message]
   │
   ▼
1. Load + validate agent.md (identity, config, role instructions)
2. If --assignment: load + validate assignment.md (vars, tasks, message)
3. Resolve vars (CLI → env → defaults) against the assignment's schema
4. Check locks (union of agent.lockedFields + assignment.lockedFields)
5. Create workspace: <cwd>/.task-runner/<short-id>/
6. Build in-memory task map from the assignment's `tasks:` (+ CLI --add-task)
7. Re-render a fresh assignment.md into the workspace; source file is never
   touched
8. Compose prompt: agent instructions → assignment instructions → workflow
   → message (non-empty parts only, joined with blank lines)
9. Loop:
     a. Invoke backend (Claude subprocess or Codex app-server JSON-RPC)
     b. Parse workspace assignment.md back, merge status/notes into in-memory
     c. Snapshot into manifest + rewrite run.json
     d. Decide: done? blocked? retry? fail?
     e. If retry: merge missing sections, build nudge, re-invoke with
        backend session resume
10. Rewrite run.json with terminal state
11. Emit final output (text summary on stderr, or full manifest on stdout
    when --output-format json)
12. Exit with status code
```

## Repo layout

```
task-runner/
├── package.json           # single-package (no workspaces)
├── tsconfig.json
├── biome.json
├── .husky/pre-commit
├── .gitignore
├── README.md
├── docs/
│   └── design.md          # this file
├── src/
│   ├── cli.ts             # argv parsing, entry point
│   ├── cli/
│   │   └── parse-args.ts  # argv → ParsedArgs + overridesFromParsedArgs
│   ├── config/
│   │   ├── schema.ts      # zod AgentConfig + AssignmentConfig schemas
│   │   ├── loader.ts      # locate + parse agent.md AND assignment.md
│   │   └── interpolate.ts # {{var}} substitution
│   ├── assignment/
│   │   ├── model.ts       # TaskState types
│   │   ├── writer.ts      # serialize in-memory map -> assignment.md
│   │   ├── parser.ts      # parse assignment.md -> status/notes updates
│   │   └── merge.ts       # merge: missing sections only, preserve edits
│   ├── backends/
│   │   ├── types.ts       # Backend interface
│   │   ├── registry.ts    # name → adapter lookup
│   │   ├── claude.ts      # Claude CLI subprocess adapter
│   │   └── codex.ts       # Codex JSON-RPC adapter (stdio + ws transports)
│   ├── runner/
│   │   ├── run-loop.ts    # seed → invoke → parse → retry
│   │   ├── manifest.ts    # RunManifest types + writer for run.json
│   │   ├── task-workflow.ts # injected task workflow template + reminder
│   │   ├── nudge.ts       # retry prompt builder
│   │   └── output.ts      # summary for text mode
│   └── util/
│       ├── short-id.ts    # 6-char base32 nonce
│       └── spawn.ts       # subprocess helper (timeout, SIGINT/SIGKILL)
├── agents/
│   ├── example/agent.md           # reference agent — identity only
│   ├── basic/agent.md
│   ├── chat/agent.md              # 0-task chat agent
│   ├── codex-example/agent.md
│   └── codex-chat/agent.md
├── assignments/
│   ├── repo-orientation/assignment.md   # tasks + vars for repo tour
│   └── repo-diagnostics/assignment.md   # tasks for quick diagnostics
└── test/
    ├── assignment-roundtrip.test.mjs
    ├── config-loader.test.mjs
    ├── manifest.test.mjs
    ├── run-loop.test.mjs
    ├── resume.test.mjs
    ├── add-task.test.mjs
    ├── auto-workflow.test.mjs
    ├── empty-prompt.test.mjs
    ├── locked-fields.test.mjs
    ├── nudge.test.mjs
    ├── claude-effort.test.mjs
    ├── codex-effort.test.mjs
    ├── backend-registry.test.mjs
    └── cli-parse-args.test.mjs
```

## Agent and assignment definitions

A run is defined by two files:

- **`agent.md`** — stable identity. Backend config, role instructions,
  locks. No tasks, no vars, no message. Used across many different
  assignments without change.
- **`assignment.md`** — the work. Task list, var schema, optional
  message default, optional work-context instructions, optional locks.

Both are Markdown files with YAML frontmatter, parsed with `gray-matter`
and validated with `zod`. Types are inferred from the zod schemas so the
two never drift.

### Agent schema

```yaml
---
schemaVersion: 1                  # required, must be 1
name: claude-worker               # required, string
backend: claude                   # required; "claude" | "codex" | "passive"
model: claude-sonnet-4-6          # optional; ignored for backend=passive
effort: medium                    # optional; off|minimal|low|medium|high|xhigh|max
timeoutSec: 3600                  # optional, default 3600; ignored for backend=passive
unrestricted: false               # optional, default false
cwd: .                            # optional, default "."
lockedFields: [model, effort]     # optional; caller cannot override these
---
You are a coding assistant working on `{{repo_path}}`.
Record findings in each task's notes block.
```

**Agent fields** — identity and capability only:

| Field | Purpose |
|---|---|
| `schemaVersion` | Future migrations |
| `name` | Identity in errors/logs |
| `backend` | Adapter dispatch (`claude`, `codex`, or `passive`) |
| `model` | Model identifier; per-backend namespace prefix is stripped. Ignored for `passive` |
| `effort` | Canonical effort enum; mapped per-adapter. Ignored for `passive` |
| `timeoutSec` | Per-invocation wall clock. Ignored for `passive` (no invocation) |
| `unrestricted` | Backend permission bypass |
| `cwd` | Subprocess / invocation working directory |
| `lockedFields` | Fields the caller cannot override |
| _(body)_ | Agent's **role instructions** — renders as part of every fresh-run prompt (and into `pendingPrompt` for `passive` agents so the external driver can re-fetch it) |

Agent frontmatter **does not contain** `vars`, `tasks`, `message`, or
`maxRetries` — those are assignment-level concepts.

**Reserved name.** `name: ad-hoc` is reserved for CLI-synthesized
ad-hoc agents (see [Ad-hoc agents](#ad-hoc-agents) below).
`loadAgentConfig` rejects any on-disk agent file that tries to claim
this name so there can't be ambiguity between "a run created with
`--agent ad-hoc`" and "a CLI-synthesized one".

### Ad-hoc agents

An **ad-hoc agent** is an `AgentConfig` synthesized on-the-fly from
CLI overrides, used when `task-runner run` / `init` is invoked
without `--agent`. The synthesized config has:

- `name: "ad-hoc"` (hardcoded, reserved)
- `sourcePath: null` (no file)
- Empty role instructions body (there is no `--instructions` flag;
  ad-hoc agents rely on assignment instructions + positional
  `[message]` to supply context if needed)
- `lockedFields: []` (nothing is locked — ad-hoc runs have no
  authored contract to enforce)
- `backend`, `model`, `effort`, `timeoutSec`, `unrestricted`, `cwd`
  all come from the corresponding CLI flags (with schema defaults
  applied for anything unset)

**`--backend` is required** when `--agent` is omitted — the runner
needs to know which backend to dispatch to, and there's no defensible
default. Missing `--backend` exits with code 3 and a clear error.

Ad-hoc agents pair naturally with the `passive` backend for pure
sidecar flows:

```bash
task-runner init --backend passive --assignment repo-diagnostics \
  --var repo_path=.
```

and with codex/claude for scripted orchestration:

```bash
task-runner run --backend codex --model gpt-5.4 --effort high \
  --assignment code-review --var repo_path=. --var range=HEAD~3..HEAD
```

Once the manifest is written, an ad-hoc run is indistinguishable
from a file-backed run in terms of resume/status/task semantics —
every field needed is frozen under `manifest.agent.*` and reachable
via the same code paths as any other manifest. No special-casing
past the first-write synthesis.

### Assignment schema

```yaml
---
schemaVersion: 1
name: repo-orientation
sessionName: orient {{repo_path}}      # optional display name on the backend
maxRetries: 3                          # optional, default 3; retry budget per session
vars:
  repo_path:
    type: string                  # string | number | boolean | enum
    required: true                # default false
    source: cli                   # cli | env | either
    envName: REPO_PATH            # only when source includes env
    default: null                 # optional fallback
    description: Path to target repo
    sensitive: false              # default false
    values: [a, b, c]             # only for type: enum
message: "focus on the auth layer first"   # optional default
lockedFields: [message]           # optional
callerInstructions: |             # optional; printed to the CALLER,
  Run this with --output-format   # not sent to the backend. See
  json to get a structured        # "Caller instructions" section below.
  report for run {{run_id}}.
tasks:
  - id: t1_conventions            # stable ID, [A-Za-z0-9._:-]+, max 128 chars
    title: Check repo conventions # required, short label
    body: |                       # optional, multi-line description
      Read AGENTS.md and CLAUDE.md.
  - id: t2_inventory
    title: Inventory packages
---
This is a repository orientation. Capture findings in each task's notes
block; no code changes.
```

**Assignment fields** — the work:

| Field | Purpose |
|---|---|
| `schemaVersion` | Future migrations |
| `name` | Identity in errors/logs |
| `sessionName` | Display name for the backend session (claude `--name`, codex `thread/name/set`). Vars are interpolated. Optional |
| `maxRetries` | Retry budget per session (int, 0–20, default 3). Caps the number of attempts the run loop makes against this assignment before giving up. |
| `vars` | CLI/env input schema (validated at run time) |
| `message` | Default follow-up message for the run |
| `callerInstructions` | Optional documentation text for the **caller** of task-runner. Printed to stderr on fresh `run` and `init` (never on `--resume-run`). Never composed into the prompt sent to the backend. See [Caller instructions](#caller-instructions) below. |
| `tasks` | Task checklist, stable IDs, max 100 per assignment |
| `lockedFields` | Fields the caller cannot override (union with agent's) |
| _(body)_ | Assignment's **work-context instructions** — renders after the agent body |

Assignments **do not contain** `backend`, `model`, `effort`, `cwd`,
`timeoutSec`, or `unrestricted` — those are agent-level.

#### Caller instructions

`callerInstructions` is an assignment-level field that exists purely
to let the assignment author leave explanatory text for the *human
or script invoking task-runner*. It is **never composed into the
prompt sent to the backend** — neither the claude/codex subprocess
prompt nor the passive bootstrap (`pendingPrompt`) contains it. The
model / sidecar driver never sees it.

**Audience split.** task-runner has two distinct audiences to brief:

1. The **callee** (the AI agent doing the work): briefed via the
   agent body, assignment body, and the workflow template. All of
   this gets composed into the backend prompt.
2. The **caller** (the human or script running `task-runner run` /
   `init`): briefed via `callerInstructions`. Shown to them on
   stderr when they first meet the assignment.

**Freeze and interpolation.** `callerInstructions` is read from
`assignmentConfig.callerInstructions` at first write, interpolated
against the same `injectedVars` as other body fields
(`{{run_id}}`, `{{repo_path}}`, `{{assignment_path}}`, etc.), and
frozen into `manifest.callerInstructions` as a top-level `string |
null` field. Resume never re-reads the source assignment, so the
frozen manifest value is the authoritative copy.

**Print rule.** Shown on stderr with a visible separator:

```
── caller instructions ──
<interpolated text>
── end caller instructions ──
```

Printed on `task-runner init` and on fresh `task-runner run`
(without `--resume-run`). **Not printed** on any `--resume-run`
invocation, including execute-after-init and true resume — the
caller already saw the instructions at init or fresh-run time, and
reprinting on every session adds noise.

**Re-fetching after the fact.** A caller who needs the instructions
again can always read them via the JSON status inspector:

```bash
task-runner status <run-id> --output-format json --field callerInstructions
```

`status` text output deliberately does **not** reprint the field —
it's a read-only inspector, not a UX surface.

**Absent or empty field.** Assignments that don't carry
`callerInstructions` (or that set it to an empty string) end up
with `manifest.callerInstructions: null`, and nothing is printed.
The field is purely opt-in.

#### Session naming

`sessionName` is a backend-side display label for the underlying
session/thread. It is *not* the runner's `runId` (which stays the
short slug for filesystem use) — it's what shows up in `claude
/resume` listings, terminal titles, and codex thread listings.

- **claude**: passed as `--name <value>` on every attempt. Claude
  persists it to `~/.claude/projects/.../<session>.jsonl` as
  `customTitle` and uses it in `/resume` and the terminal title.
- **codex**: after `thread/start` (or `thread/resume`) returns the
  `threadId`, the runner sends `thread/name/set` with `{threadId,
  name}`. Codex broadcasts a `thread/name/updated` notification to
  all clients. Failures are logged to stderr but don't fail the
  attempt — naming is best-effort.
- **Var interpolation**: the value is run through `interpolate()`
  with the same injected vars used elsewhere, so
  `sessionName: "build {{repo_name}}"` works. Static names like
  `sessionName: nightly-cleanup` pass through unchanged.
- **CLI override**: `--session-name <value>` overrides the
  assignment's value (and is itself interpolated against the run's
  vars). Listing `sessionName` in `lockedFields` makes the
  override fail with `LockedFieldError`.
- **Resume**: the resolved name is persisted into `manifest.sessionName`
  on the first session. On resume the manifest is canonical (the
  assignment isn't loaded), so the name carries forward unchanged
  unless `--session-name` is passed, which updates it for the new
  session and beyond.
- **init**: the resolved name is stored in the manifest at init
  time and replayed on execute-after-init. `--session-name` may
  also be passed at execute-after-init time to override the
  init-time value.

### Invocation shape

```bash
task-runner run --agent <name-or-path> \
                [--assignment <name-or-path>] \
                [--var k=v]... \
                [--add-task <title>]... \
                [--model ...] [--effort ...] [other overrides] \
                [message]
```

Fresh run with a named assignment:

```bash
task-runner run --agent claude-worker --assignment repo-orientation \
                --var repo_path=/home/kevin/repo
```

Fresh run with an orchestrator-generated assignment file:

```bash
task-runner run --agent claude-worker \
                --assignment /tmp/work-abc/assignment.md
```

Chat mode (no assignment, no tasks):

```bash
task-runner run --agent chat "hello"
```

### Resolution

`--agent <arg>`:
1. If `<arg>` contains `/`, `\`, or starts with `.` → direct path
2. Else look for `<cwd>/agents/<arg>/agent.md`
3. Else look for `<TASK_RUNNER_HOME>/agents/<arg>/agent.md`
4. Else → `AgentNotFoundError`

`--assignment <arg>`: same pattern, `assignments/` directory and
`assignment.md` filename.

### Workspace layout

The runner **copies**, never mutates, the caller's assignment file:

1. Generate short ID, create `<cwd>/.task-runner/<short-id>/`
2. Re-render a fresh `assignment.md` into the workspace from the parsed
   task list. This is the runner's ephemeral scratch copy — the agent
   edits it in place during the run.
3. Source file (the caller's `--assignment` target) is never touched.
4. `run.json.assignment` captures both paths so tooling can correlate:

   ```json
   "assignment": {
     "name": "repo-orientation",
     "sourcePath": "/tmp/work-abc/assignment.md",
     "workspacePath": "/abs/.task-runner/k7m2xq/assignment.md"
   }
   ```

## Message

The `message` field is a caller-provided ask. Resolution order:

1. **CLI positional argument** — `task-runner run --agent X "focus on auth"`
2. **`message:` in assignment.md frontmatter** — default if no positional
3. **Unset** — no message at all

The resolved message goes at the **end** of the composed prompt, after
the agent instructions, the assignment instructions, and the workflow
template. See [Automatic task workflow](#automatic-task-workflow) for
the full composition order.

Resolved message appears at the top of `run.json` as `manifest.message`,
and on each session record as `sessions[N].message`. The per-attempt
`AttemptRecord.prompt` field contains the full composed text.

## Locked fields

Both agents and assignments can declare `lockedFields`. At run time the
two lists are unioned; a field locked on either side rejects overrides.

Valid entries:

```
cwd  backend  model  effort  instructions  message  sessionName
timeoutSec  unrestricted  maxRetries  tasks
```

The zod schemas reject any entry outside this set at load time, so typos
fail fast.

**Who typically locks what**:

| Field | Typical lock owner |
|---|---|
| `cwd`, `backend`, `model`, `effort`, `timeoutSec`, `unrestricted` | agent — agent-owned config, agent decides CLI override rules |
| `instructions` | agent — refuses assignments with non-empty body |
| `message`, `tasks`, `sessionName`, `maxRetries` | either — agent-wide prohibition OR per-assignment canonical value |

**Runtime check** — early in `runAgent()`, before any work starts, the
runner builds the union of `agentConfig.lockedFields` and
`assignmentConfig?.lockedFields` and checks every override against it.
On violation, throws `LockedFieldError` with the field name and current
value. CLI catches it and exits with code 3:

```
task-runner: cannot override locked field: model
  this run fixes it to "claude-sonnet-4-6"
```

**Semantics**:

- Locking only prevents *overrides*. If the caller doesn't pass a value
  for a locked field, the frontmatter default (from agent or assignment)
  is used silently.
- `lockedFields: [tasks]` means `--add-task` is rejected.
- `lockedFields: [instructions]` on an **agent** means `--assignment`
  values with non-empty body are rejected.
- `lockedFields: [message]` on an **assignment** means a CLI positional
  message is rejected (and the assignment's default message is used).
- Locks do not cover `vars`: those have their own schema (`required`,
  `source`, `sensitive`) and are outside the lock mechanism.

**What this replaces** — agent-runner had a richer `overridePolicy` with
`{default: allow|deny, allow: [...], deny: [...]}`. We took the simplest
shape that solves the real concern. A full allow/deny with a tri-state
default is easy to add if it becomes needed.

## Adding tasks from the CLI

Callers can append ad-hoc tasks at invocation time using the repeatable
`--add-task <title>` flag:

```
task-runner run --agent example \
  --add-task "Check the logs" \
  --add-task "Verify the backup"
```

**Semantics:**

- Each `--add-task` appends one task to the end of the task list.
- The value is the task **title** only. No body, no structured fields.
  For structured tasks, edit the agent's `agent.md` frontmatter.
- IDs are auto-generated as `cli-<6-char-short-id>`, collision-resistant
  against frontmatter IDs.
- Added tasks start as `pending`.
- Title is validated: non-empty, max 200 characters. Violations throw
  `InvalidAddedTaskError` (exit 3).

**Interaction with fresh vs resume runs:**

- **Fresh run**: added tasks are appended after the assignment's tasks
  (if an assignment was provided) or start as the entire task list (if
  no assignment).
- **Resume run**: after loading `parent.finalTasks` and normalizing
  non-completed tasks to `pending`, added tasks are appended with fresh
  IDs. They enter the resumed session as `pending`. Note: `--assignment`
  is forbidden on resume; only `--add-task` can extend the task list.

**Zero-task runs are valid:**

Chat mode is `--agent X` with no `--assignment`. The runner invokes the
backend once with just the agent's role instructions and any positional
message, captures the transcript, and exits `success`. The run loop's
0-task branch bypasses retries — one attempt, success if the backend
exited cleanly.

```yaml
---
# agents/chat/agent.md — minimal chat agent
schemaVersion: 1
name: chat
backend: claude
unrestricted: true
---
```

Invocation:

```bash
task-runner run --agent chat "what is 2 plus 2?"
```

This pattern lets `task-runner` double as a generic backend wrapper for
one-shot Q&A, with the full manifest/session/resume machinery still
available. A resume of a zero-task run can later introduce tasks via
`--add-task`; see [Automatic task workflow](#automatic-task-workflow)
for how the workflow instructions get injected on that transition.

**Locked tasks:**

If either the agent or the assignment has `lockedFields: [tasks]`, any
`--add-task` from the CLI triggers `LockedFieldError` (exit 3). The run
still works without `--add-task` — locking only prevents extension, not
normal execution.

## Automatic task workflow

Agent authors do not write the "how to interact with tasks" boilerplate
in their `agent.md` bodies. The runner injects a fixed workflow block
automatically whenever the run has tasks:

```
Your assignment is at `{{assignment_path}}`. Read it first. Work through
each task in order. For each task:

1. Set the task's **Status** to `in_progress`.
2. Do the work described in the task body.
3. Record your findings in the task's **Notes** block.
4. Set the task's **Status** to `completed`.

Valid statuses are `pending`, `in_progress`, `completed`, and `blocked`.
If you cannot complete a task, set its status to `blocked` and explain
why in the Notes block — the runner will stop and surface the blocker
rather than retrying.

Do not delete or reorder tasks in `{{assignment_path}}`.
```

There is no opt-out toggle. The block is interpolated with the same
`{{assignment_path}}` value used elsewhere.

### Injection rules

The exact behavior depends on what kind of session is starting and
whether tasks existed before. Composition uses a parts array joined with
blank lines, non-empty parts only:

| Scenario | Prompt composition |
|---|---|
| Fresh, `tasks.size > 0` | `<agent instructions>` → `<assignment instructions>` → `<workflow>` → `<message>` |
| Fresh, `tasks.size === 0` | `<agent instructions>` → `<assignment instructions>` → `<message>` |
| Resume, prior had tasks, no `--add-task` | `<message>` only |
| Resume, prior had tasks, `--add-task` used | short "new tasks" reminder → `<message>` |
| Resume, prior had 0 tasks, this session has tasks | `<workflow>` → `<message>` |

The order goes **broad to specific**: role identity first, work context
second, mechanical task instructions third, the caller's immediate ask
last. Matches standard prompt engineering patterns where the specific
request comes after all the setup.

On resume sessions, neither the agent's role instructions nor the
assignment's work instructions are re-sent — the backend's cached
conversation already has them. The workflow is only injected on the
first session that has tasks (session 0 for runs that start with tasks;
the later resume session for runs that started with zero and later
added some).

### New-tasks reminder

When `--add-task` is used on a resume session and the prior sessions
already had tasks, the backend has the workflow cached but doesn't know
new tasks were just written to `assignment.md`. The runner prepends a
short parenthetical reminder before the caller's follow-up message:

```
(task-runner: 2 new tasks have been added to your assignment since
the last session — please re-read /abs/path/assignment.md before
continuing.)

<caller's message>
```

Just enough to make the agent re-read the file. Not the full workflow.
If no positional message was provided (`--add-task` alone), the reminder
becomes the entire follow-up prompt.

### Empty prompt guard

The four prompt parts — agent instructions, assignment instructions,
auto-workflow, and message — are independently optional. Any
combination works, except all four empty:

| agent instr | assignment instr | tasks | message | outcome |
|---|---|---|---|---|
| ✓ | ✓ | ✓ | ✓ | agent + assignment + workflow + message |
| ✓ | ✓ | ✓ |   | agent + assignment + workflow |
| ✓ | ✓ |   | ✓ | agent + assignment + message |
| ✓ |   |   | ✓ | agent + message |
| ✓ |   |   |   | agent only |
|   |   | ✓ |   | workflow only (agent reads assignment.md) |
|   |   |   | ✓ | message only (pure Q&A) |
|   |   |   |   | **EmptyPromptError** (exit 3) |

`EmptyPromptError` is thrown before any backend invocation if the
composed prompt would be empty. Error shape:

```
task-runner: agent has no prompt content
  the agent has no instructions, no assignment instructions, no tasks,
  and no `message` (assignment frontmatter or CLI positional). At
  least one is required. Add instructions to the agent.md or
  assignment.md body, pass a positional message, or add tasks via
  `tasks:` in an assignment or `--add-task`.
```

The composition itself is built as a parts array: each non-empty part
is pushed in Option B order (agent instructions, assignment
instructions, workflow, message) and joined with a single blank line.
This avoids stray `\n\n` sequences when any part is missing.

## Agent and assignment resolution

Given `--agent <name>`:

1. If `<name>` contains `/`, `\`, or starts with `.` → treat as a direct path
2. Else look for `<cwd>/agents/<name>/agent.md`
3. Else look for `<TASK_RUNNER_HOME>/agents/<name>/agent.md`
   (`TASK_RUNNER_HOME` defaults to `~/.task-runner`)
4. Else → `AGENT_NOT_FOUND`

Given `--assignment <name>` (optional):

1. If `<name>` contains `/`, `\`, or starts with `.` → treat as a direct path
2. Else look for `<cwd>/assignments/<name>/assignment.md`
3. Else look for `<TASK_RUNNER_HOME>/assignments/<name>/assignment.md`
4. Else → `ASSIGNMENT_NOT_FOUND`

The source assignment file is never mutated. On a fresh run the runner
copies it into the workspace as `assignment.md`; that copy is the
ephemeral buffer the agent edits. On resume the existing workspace
copy is reused and `--assignment` is not accepted.

## Variable interpolation

```ts
input.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (full, key) => {
  const value = vars[key];
  return value === undefined ? full : String(value);
});
```

Applied to:

- The agent's instructions body.
- The assignment's instructions body.
- Every **task `title` and `body`** from the assignment frontmatter
  (interpolated once at fresh-run build time, before tasks are
  rendered to the workspace `assignment.md` and before the first
  snapshot lands in the manifest). On resume and execute-after-init
  the assignment isn't reloaded — tasks come from the manifest's
  `finalTasks` snapshot, which already carries the interpolated text
  from the original fresh-run build.
- `sessionName`, `cwd`, and any other string field the runner renders
  into user-visible text.

`--add-task` titles are **not** interpolated — they come from the
CLI directly, so `{{}}` sequences are preserved as-is.

### Runner-injected vars

In addition to user-declared vars from the CLI/env, the runner provides:

- `{{assignment_path}}` — absolute path to `assignment.md` for this run
- `{{run_id}}` — the short ID for this run
- `{{cwd}}` — resolved absolute working directory

## Workspace layout

One directory per logical run, generated by the runner on the first
invocation and **reused** across any subsequent `--resume-run`
invocations:

```
<cwd>/.task-runner/<short-id>/
├── run.json              # canonical manifest (accumulates across sessions)
├── assignment.md              # ephemeral scratch file the agent edits in place
└── attempts/
    ├── 01.json           # session 0, attempt 1
    ├── 02.json           # session 0, attempt 2
    ├── 03.json           # session 0, attempt 3 (e.g., ended blocked)
    ├── 04.json           # session 1, attempt 1 (first resume)
    ├── 05.json           # session 1, attempt 2
    └── ...
```

`<short-id>` is a 6-character base32 nonce (e.g., `k7m2xq`), generated
once at the initial invocation. It is the identity of the logical run —
every resume targets the same slug, same workspace, same manifest.
Multiple concurrent fresh runs in the same cwd get distinct short IDs
and do not collide.

Attempt numbers are **monotonic** across the entire run — session 1's
first attempt follows session 0's last attempt, so filenames never
collide. Each `AttemptRecord` and `AttemptLog` carries a `sessionIndex`
field so you can filter which attempts belonged to which session.

The directory is left on disk after each invocation (success or failure)
for inspection and for future resume invocations. `run.json` is the
thing you archive, share, or grep; `assignment.md` is a diagnostic artifact
that shows what the markdown looked like at the end of the latest
session; `attempts/NN.json` holds the raw, unfiltered backend output for
each attempt (see [Attempt logs](#attempt-logs) below). Users should add
`.task-runner/` to `.gitignore`.

## One run, many sessions

A logical run may span multiple `task-runner run` invocations. Each
invocation is a "session" within the run:

- Session 0 is the initial invocation (`task-runner run --agent ...`).
- Each `task-runner run --resume-run <id>` invocation opens a new
  session (session 1, 2, 3, ...) in the same workspace.

Every session:

- Gets its own `SessionRecord` in `manifest.sessions[]`
- Has its own `maxAttempts` budget (the retry counter resets per session)
- Contributes its attempts to the single flat `manifest.attemptRecords[]`
  array with monotonic attempt numbers
- Reads the workspace `assignment.md` to pick up mid-run status /
  notes edits (either from the agent's own writes during the prior
  session, or from `task set` / `task add` CLI calls made against
  the run in between sessions)
- Re-checks any CLI overrides it accepts against the **frozen**
  `manifest.lockedFields` — the union of agent ∪ assignment locks
  captured at first write
- For resume sessions (index > 0), the first attempt's prompt is
  **only the follow-up message** (plus the new-tasks reminder if
  applicable) — the role instructions and workflow template aren't
  re-rendered because the backend has them in the cached
  conversation

**Resume under the manifest-canonical rule.** Every resume reads the
agent definition from the frozen manifest via
`loadedAgentFromManifest`, not from the original `agent.md`. Once
the run is created, the source `agent.md` has **no further effect**
on any session — it can be moved, edited, or deleted and the run is
unaffected. Likewise for the assignment: task data lives in the
workspace `assignment.md` and `manifest.finalTasks` exclusively, and
the assignment's locked-field set is frozen into `manifest.lockedFields`
at first write (so a post-init change to the assignment file cannot
bypass or tighten a lock mid-run). The only per-run state that
evolves between sessions is what's explicitly writable: the workspace
`assignment.md` (task status + notes), manifest fields managed by
the run loop (attempts, sessions, finalTasks, status/exitCode/endedAt),
and whatever CLI overrides each resume legally applies (model,
effort, timeoutSec, maxRetries, unrestricted, sessionName — see
[CLI shape → resume overrides](#--resume-run-idpath) for the full
matrix).

The top-level `manifest.status`, `manifest.exitCode`, and
`manifest.endedAt` always reflect the **latest** session. Earlier
sessions' terminal states are preserved in their individual session
records.

## Run manifest

`run.json` is written at run start, rewritten after every attempt, and
rewritten one last time when the run reaches a terminal state. It is a
single JSON document — never JSONL, never append-only — so you can always
`cat` or `jq` the latest version.

**Manifest-canonical rule.** The manifest is the **sole source of
truth for a run after first write**. Every field needed to resume or
inspect a run — including the agent's role instructions, locked
fields, and per-attempt timeout budget — is frozen into the manifest
at first write (fresh run or `init`) and read from the manifest on
every subsequent operation. Resume never re-reads the source
`agent.md`. Consequences:

- CLI overrides for model / effort / cwd / timeoutSec / etc. on
  resume persist across further resumes (the new value is written
  into the manifest, not transiently applied to the session).
- Moving, editing, or deleting the original `agent.md` after a run
  has started has no effect on that run.
- Ad-hoc agents — runs created with `--agent` omitted and the agent
  config synthesized from CLI overrides — work naturally: the
  reserved `name: "ad-hoc"`, `sourcePath: null`, and empty role
  instructions are written into the manifest at first write and
  carried forward like any other agent.

**Schema versioning.** `schemaVersion: 2` is the manifest-canonical
generation. Manifests written by earlier task-runner versions have
`schemaVersion: 1` and are **not resumable** by this version —
`resolveResumeTarget` rejects them with a clear error and tells the
caller to start a fresh run. No automatic migration.

```ts
type ManifestStatus =
  | "initialized"   // `init` prepared the workspace but no session has run
  | "running"
  | "success"
  | "blocked"
  | "exhausted"
  | "aborted"       // user pressed Ctrl+C; backend was interrupted cleanly
  | "error";

interface RunManifest {
  schemaVersion: 2;
  runId: string;
  agent: {
    name: string;
    sourcePath: string | null;     // null for ad-hoc agents (no source file)
    instructions: string;          // frozen role-instructions body (interpolated)
  };
  assignment: {                    // null if the run had no --assignment
    name: string;
    sourcePath: string;            // source path the assignment was loaded from
    workspacePath: string;         // copied workspace assignment.md
  } | null;
  backend: string;
  model: string | null;
  effort: string | null;
  message: string | null;          // session 0's initial message
  sessionName: string | null;      // backend-side display name (resolved + interpolated)
  unrestricted: boolean;
  cwd: string;
  lockedFields: LockableField[];   // union of agent + assignment locks, frozen
  timeoutSec: number;              // per-attempt wall clock, frozen
  assignmentPath: string;          // workspace assignment.md (the I/O buffer)
  workspaceDir: string;
  runtimeVars: Record<string, unknown>;  // resolved vars used for this run
  startedAt: string;               // ISO-8601; session 0 start
  endedAt: string | null;          // latest session's end, null while running
  status: ManifestStatus;          // latest session's terminal state
  exitCode: number | null;         // latest session's exit code
  attempts: number;                // total across all sessions
  maxAttempts: number;              // latest session's retry budget
  tasksCompleted: number;
  tasksTotal: number;
  backendSessionId: string | null; // most recently captured claude session id
  pendingPrompt: string | null;    // frozen by `init`; cleared once session 0 runs
  callerInstructions: string | null; // assignment documentation for the CALLER (not sent to the backend); see "Caller instructions" under Assignment schema
  finalTasks: Record<string, TaskSnapshot>;
  sessionCount: number;            // 0 for initialized-only runs, 1 for initial
                                   // executed run, 2 after first resume, etc.
  sessions: SessionRecord[];       // one per session, in order
  attemptRecords: AttemptRecord[]; // flat, monotonic across all sessions
}

interface SessionRecord {
  sessionIndex: number;                      // 0 = initial invocation
  startedAt: string;
  endedAt: string | null;
  status: ManifestStatus;
  exitCode: number | null;
  message: string | null;                    // the prompt message for this session
  firstAttempt: number | null;               // attemptRecords[].attempt
  lastAttempt: number | null;
  maxAttempts: number;
  backendSessionIdAtStart: string | null;    // what we passed to --resume
  backendSessionIdAtEnd: string | null;      // captured by session end
}

interface TaskSnapshot {
  id: string;
  title: string;
  body: string;
  status: TaskStatus;
  notes: string;
}

interface AttemptRecord {
  attempt: number;                  // monotonic across sessions
  sessionIndex: number;             // which session this attempt belongs to
  startedAt: string;
  endedAt: string;
  prompt: string;                   // full prompt sent to the backend
  sessionIdAtStart: string | null;
  sessionIdCaptured: string | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  transcript: string | null;        // full assistant output for this attempt
  logPath: string;                  // relative path to attempts/NN.json
  tasksAfter: Record<string, TaskSnapshot>;
  invalidStatuses: { taskId: string; rawValue: string }[];
}
```

**Transcript, not summary**: `AttemptRecord.transcript` carries the full
assistant-side text across every turn in the attempt, in order — the same
thing the user sees streamed in text mode. It is **not** Claude's one-line
`result.result` summary. If the assistant says useful things in
intermediate turns and then drops them from the summary, the transcript
preserves them; the summary does not. Raw, unfiltered backend output
(including tool-use events, rate-limit events, and everything else claude
emits) lives in a sidecar file at `logPath` — see
[Attempt logs](#attempt-logs).

**Task snapshots**: `finalTasks` is the authoritative state of every task
at the end of the run. Each `AttemptRecord.tasksAfter` is a point-in-time
snapshot after that attempt's parse/merge step. Because `tasksAfter` contains
the full `TaskSnapshot` (including `title`, `body`, and `notes`), you can
reconstruct a complete history of the run from the manifest alone — no need
to look at `assignment.md`.

**Session ID**: `backendSessionId` is the claude session ID captured from
attempt 1 and used for `--resume` on subsequent attempts. The per-attempt
`sessionIdAtStart` / `sessionIdCaptured` fields let you audit exactly what
was passed in and what came out on each attempt (useful for diagnosing
resume failures).

**Passive runs.** The manifest shape is identical for `backend:
passive` runs, but several fields have different lifecycles:

- **`pendingPrompt`** is written at init time like any other run, but
  **never cleared**. For claude/codex, `pendingPrompt` is consumed
  (set to `null`) when execute-after-init flips the run to `running`.
  For passive, there is no execute step, so the composed bootstrap
  persists for the lifetime of the run and is queryable via
  `task-runner status <id> --output-format json --field pendingPrompt`.
- **`status` / `endedAt` / `exitCode`** are managed by
  `applyPassiveFinalization`, not the run loop. After every successful
  `task set` / `task add`, the function re-derives the status from the
  task map:
  - any `pending` or `in_progress` task → `initialized` (clears
    `endedAt` and `exitCode` if they were set)
  - all terminal, at least one `blocked` → `blocked`, `exitCode: 2`
  - all `completed` → `success`, `exitCode: 0`
  
  `endedAt` is stamped only on an **actual transition** into a
  terminal state. A notes-only edit on an already-finalized passive
  run preserves the prior `endedAt` so the audit trail records the
  real completion time, not the last time someone touched the notes.
- **`attempts`, `maxAttempts`, `sessionCount`**, and the `sessions`
  and `attemptRecords` arrays stay at their zero/empty values —
  passive runs have no backend attempts and no sessions. The
  `task-runner status` text renderer hides the `Attempts` / `Sessions`
  lines for passive runs to avoid the noise; the JSON output still
  carries all zero-valued fields for schema stability.
- **`backendSessionId`** stays `null` forever — there is no backend
  session to capture.

### Attempt logs

Each attempt writes one sidecar file at `attempts/NN.json` (zero-padded
two-digit index, up to attempt 21 given our `maxRetries ≤ 20` schema
cap). The file contains the raw, unfiltered backend output for that
attempt — for Claude, that means the full stream-json event stream — and
is always captured, regardless of output mode.

```ts
interface AttemptLog {
  schemaVersion: 1;
  runId: string;         // cross-reference so a stray file is self-identifying
  attempt: number;       // monotonic across sessions
  sessionIndex: number;  // which session this attempt belongs to
  startedAt: string;
  endedAt: string;
  stdout: string;        // full raw backend stdout
  stderr: string;        // full raw backend stderr
}
```

Keeping the raw output out of `run.json` keeps the manifest compact and
easy to `jq` without wading through verbose JSON. If you need to forensically
debug a single attempt, open the file at `AttemptRecord.logPath`. The
`runId` field in the log file cross-references the parent manifest so a
log file pulled in isolation can still be traced back to its run.

### Safety property

Session IDs written to `run.json` are **write-only, never read back**. The
runner never loads a manifest from a prior run to recover state, and never
uses a session ID it didn't extract during the current in-process run. A
stray `run.json` in an old workspace dir cannot pollute a new run. If
cross-run resume becomes desirable later, it will be an explicit opt-in
(`--resume-run <id>`), never implicit.

## Task state model

The runner holds an in-memory `Map<taskId, TaskState>` that drives the run.
`assignment.md` is an I/O buffer between the runner and the agent. `run.json` is
the canonical record. The relationship:

```
assignment.md `tasks:`  ──►  in-memory Map  ──►  rendered to workspace assignment.md
                                   │                      │
                                   │                      ▼
                                   │                agent edits
                                   │                      │
                                   ▼                      │
                           snapshot into run.json   ◄─────┘
                                (canonical)        parsed back
```

```ts
type TaskStatus = "pending" | "in_progress" | "completed" | "blocked";

interface TaskState {
  id: string;           // from assignment.md, stable
  title: string;        // from assignment.md, never updated from file
  body: string;         // from assignment.md, never updated from file
  status: TaskStatus;   // updated from file each round
  notes: string;        // updated from file each round
}
```

## `assignment.md` format

Written by the runner, edited by the agent. Ephemeral — the definitive
state lives in `run.json.finalTasks`.

```markdown
# Assignment

The runner tracks your progress through this file. For each task below,
update the **Status** and **Notes** fields as you work. Do not delete or
reorder tasks. Valid statuses: `pending`, `in_progress`, `completed`,
`blocked`.

If a task cannot be completed, set its status to `blocked` and explain why
in **Notes**. The runner will stop and surface that to the user instead of
retrying.

---

<!-- task-id: t1_read_conventions -->
## Task 1: Check repo conventions

Read AGENTS.md and CLAUDE.md.

**Status:** pending

**Notes:**
<!-- notes:start -->
<!-- notes:end -->

---
```

### Parser rules

For each `<!-- task-id: X -->` marker found in the file:

- `X` unknown to the in-memory map → ignore
- Missing `**Status:**` line → keep in-memory status unchanged
- Status value ∉ {`pending`, `in_progress`, `completed`, `blocked`} → record
  invalid-status error for the nudge; keep in-memory status unchanged
- Valid status → update in-memory `status`
- `<!-- notes:start -->` / `<!-- notes:end -->` fence missing → leave notes
  unchanged
- Fence present → capture the content between markers verbatim

For each task ID in memory **not** found in the file:

- Keep in-memory state untouched (delete-proofing)
- Flag for restoration on next write

### Merge / write policy

**Initial seed**: write full file — header block + all task sections.

**On retry**:

1. Read current `assignment.md`. If missing/empty/unparseable → fall back to full
   re-seed from memory.
2. Find all `<!-- task-id: X -->` markers currently present.
3. For each task ID in memory **not** present in the file: append a fresh
   section at the end, using last-known status/notes from memory.
4. Write merged content back.
5. Don't touch sections still present, even if their status is invalid —
   the nudge prompt tells the agent to fix it on the next turn.

Effects:

- Agent's notes, partial edits, and free-form scratch content survive retries
- Deleted tasks come back (possibly at the bottom); order isn't preserved
- Invalid statuses are communicated via the nudge, not force-rewritten
- A nuked file re-seeds completely

## Run loop decision table

After each invocation (and after each attempt's manifest snapshot):

| State of tasks | Action |
|---|---|
| all `completed`, no invalid statuses | success → finalize manifest → exit 0 |
| any `blocked` | stop → surface blocked tasks + notes → exit 2 |
| any `pending`/`in_progress` OR any invalid status, retries left | reinvoke with nudge |
| any `pending`/`in_progress` OR any invalid status, retries exhausted | fail → exit 1 |

### Nudge message (not configurable)

Built from the in-memory map + any invalid-status errors captured during parse:

```
Some tasks in /abs/path/assignment.md are not yet completed. Please continue.

Remaining tasks:
- t1_read_conventions (status: pending) — Check repo conventions
- t3_run_tests (status: in_progress) — Run the test suite

Invalid status values:
- t2_audit_auth had status "done"; use one of the valid statuses instead.

Valid statuses: pending, in_progress, completed, blocked.
Update each task's Status to `completed` when done. If you cannot complete
a task, set its status to `blocked` and explain in Notes — the runner will
stop and report it instead of retrying.
```

## Backend interface

One small interface. Backends live under `src/backends/` and are registered
in `src/backends/registry.ts`. Current backends: **claude** (subprocess),
**codex** (JSON-RPC over stdio or WebSocket), and **passive** (null-object
for sidecar-only runs; see [Passive implementation](#passive-implementation)
below).

```ts
type EffortLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

interface BackendInvokeContext {
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  model?: string;
  effort?: EffortLevel;
  unrestricted?: boolean;
  timeoutSec: number;
  resumeSessionId?: string;
  onStdoutText?: (text: string) => void;
  onStderrText?: (text: string) => void;
}

interface BackendInvokeResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  sessionId: string | null;        // extracted from output events
  transcript: string | null;       // full assistant text across all turns
  rawStdout: string;               // full unfiltered backend stdout
  rawStderr: string;
}

interface Backend {
  id: string;
  invoke(ctx: BackendInvokeContext): Promise<BackendInvokeResult>;
}
```

### Claude implementation

Spawns the `claude` CLI as a subprocess. Binary resolved from
`process.env.TASK_RUNNER_CLAUDE_BIN` or falls back to `"claude"` on `PATH`.

Command shape:

```
claude --print --output-format stream-json --verbose \
       [--model <model>] \
       [--effort <level>] \
       [--dangerously-skip-permissions] \
       [--resume <session-id>] \
       "<prompt>"
```

- **Output format**: `stream-json` (always). The adapter parses events
  line-by-line as they arrive and extracts:
  1. **Session ID** from `session_id`, `sessionId`, or nested `session.id`
     on any event (the claude system init event carries it).
  2. **Live assistant text** — text comes from two sources: the delta
     stream (`stream_event.content_block_delta` with `delta.type ===
     "text_delta"`) when partial messages are enabled, and the terminating
     `assistant` event's `message.content[].text` blocks otherwise. The
     adapter calls the `onStdoutText` callback for whichever source appears,
     guarded so it never double-prints if both are present.
  3. **Transcript** — accumulated across the whole attempt: streamed text
     deltas if present, otherwise every `assistant` event's text content
     concatenated in order. Captures every turn, not just the final one.
     The `result` event's `result` field is only used as a last-resort
     fallback if no assistant events were seen at all.
- **Prompt** is passed as the final positional argument, not stdin.
- **Env**: `process.env` by default. Future hook point if we add an env
  policy.
- **Timeout**: `setTimeout(() => child.kill("SIGINT"), timeoutMs)`, escalate
  to SIGKILL after 5 seconds.
- **Completion detection**: process exit. Non-zero exit code counts as a
  failed attempt (and a failed attempt still produces a manifest entry).

### Codex implementation

Speaks codex's JSON-RPC 2.0 app-server protocol with a pluggable transport:

- **Stdio transport (default)** — spawns `codex app-server` with the binary
  from `process.env.TASK_RUNNER_CODEX_BIN` (fallback `"codex"`), wires
  stdin/stdout as the JSON-RPC channel. One subprocess per `invoke()`.
- **WebSocket transport** — activated by setting
  `process.env.TASK_RUNNER_CODEX_WS_URL` to a `ws://` or `wss://` URL.
  The adapter connects as a client to an externally-started
  `codex app-server --listen ws://...`, sending/receiving JSON-RPC frames
  over the WebSocket. Nothing is spawned locally.

The protocol client is transport-agnostic; selecting stdio vs ws is a
runtime decision based on the env var. Agent.md frontmatter is unchanged
— it just says `backend: codex`.

#### Protocol flow per invoke

Every `invoke()` call opens a fresh transport and runs one full lifecycle:

1. **`initialize`** — handshake request with `clientInfo` and
   `capabilities`. Client/server negotiate version and supported
   features.
2. **`initialized`** — bare notification (no id, no params,
   just `{jsonrpc: "2.0", method: "initialized"}`). LSP-style handshake
   completion. Codex expects this between the `initialize` response and
   any subsequent request.
3. **`thread/start`** (fresh) or **`thread/resume`** (with
   `ctx.resumeSessionId` as `threadId`). Params include `cwd`, normalized
   `model`, mapped `effort`, and when `unrestricted` is true,
   `approvalPolicy: "never"`. The `sandbox` field is never set —
   `approvalPolicy: "never"` is sufficient to bypass approvals, and
   codex's SandboxPolicy enum has inconsistent wire formats across
   versions. Matches agent-runner's managed.ts.
4. **`turn/start`** — sends the prompt as
   `{threadId, input: [{type: "text", text: prompt}]}`. Nothing else —
   `model`, `effort`, and `approvalPolicy` are set once at the thread
   level and apply for the thread's lifetime. Awaits both the response
   and a `turn/completed` notification before returning.
5. **Notification stream** — while the turn runs, the client receives
   notifications:
   - `thread/started` → capture `thread.id` as session ID
   - `turn/started` → capture `turn.id` (needed for interrupt)
   - `item/agentMessage/delta` → stream `params.delta` to `onStdoutText`
   - `item/completed` with `item.type === "agentMessage"` → capture
     `item.text` as the definitive transcript for the turn
   - `turn/completed` → capture `turn.status` (`completed` / `failed` /
     `interrupted`) and any `turn.error.message`; resolves the waiting
     promise
   - Everything else (reasoning deltas, command execution, file change
     deltas, etc.) is silent
6. **Transport close** — after the turn completes (or times out), the
   transport is closed. For stdio, this sends `SIGINT` to the subprocess
   and escalates to `SIGKILL` after 5s. For ws, this closes the socket.

#### Raw capture for the attempt log

Every inbound and outbound JSON-RPC frame is tee'd into the attempt log
(`attempts/NN.json`) via `CreateClientOptions.onRawIncoming` and
`onRawOutgoing`. Incoming frames are prefixed with `>` and outgoing with
`<` so the log reads as a transcript of the conversation with the
server. This gives full forensic visibility into any failed or
unexpected run without needing to enable debug flags.

#### Timeout and cancel

On timeout (`ctx.timeoutSec` elapsed before `turn/completed`), the adapter
sends a `turn/interrupt` request with `{threadId, turnId}` (both captured
during the turn — threadId from `thread/start` response, turnId from the
`turn/started` notification or the `turn/start` response, whichever
arrives first). Then closes the transport. The invoke returns with
`timedOut: true`. If the turnId was never captured (e.g., timeout fired
before the server produced it), the interrupt is skipped and only the
transport close happens.

#### Session ID

The session ID exposed to the runner is the codex **`threadId`**. On
cross-invocation resume (`--resume-run`), the runner passes the stored
`threadId` back as `ctx.resumeSessionId`, and the adapter uses
`thread/resume` instead of `thread/start`.

#### What the adapter does NOT do

- **`turn/steer`**: not used. Every retry attempt is a new `turn/start`
  on the same thread. The adapter doesn't keep a long-lived connection
  across attempts — connection is opened and closed per `invoke()`. If
  future work wants in-session steering for efficiency, that's an
  `openSession()` interface extension, not a codex-specific change.
- **Multi-turn batching**: one invoke = one turn. No history caching.
- **Interactive mode**: codex supports a TTY mode; task-runner doesn't
  use it.

#### Effort and model mapping

Task-runner's canonical `EffortLevel` enum is a superset. Per-backend
mapping tables:

| canonical | claude (`--effort`) | codex (`effort` param) |
|---|---|---|
| `off` | *(omit)* | *(omit)* |
| `minimal` | `low` | `minimal` |
| `low` | `low` | `low` |
| `medium` | `medium` | `medium` |
| `high` | `high` | `high` |
| `xhigh` | `max` | `xhigh` |
| `max` | `max` | `xhigh` |

Each adapter has a small local `mapEffortTo<Backend>()` function with
this table. The canonical enum is validated at schema load time.

Model names are normalized by stripping any provider-namespace prefix
(e.g., `openai-codex/gpt-5.4` → `gpt-5.4`, `anthropic/claude-sonnet-4-6`
→ `claude-sonnet-4-6`). Each adapter does its own normalization.

### Passive implementation

A **null-object** backend used for sidecar-only runs. `src/backends/
passive.ts` exports a `Backend` whose `invoke()` throws
`PassiveBackendNotInvokableError` unconditionally. Defense in depth —
the CLI rejects `task-runner run` on passive agents before control
ever reaches `invoke()` (see [`task-runner init`](#task-runner-init)
and [`--resume-run <id|path>`](#--resume-run-idpath) for the lifecycle
rules), so `.invoke()` should only fire if something tries to drive a
passive backend programmatically — in which case the throw surfaces
the contract violation loudly.

The passive backend has:

- `id: "passive"` for registry resolution.
- **No `validateSessionId` method** — passive runs have no sessions
  to validate. The `--backend-session-id` import flow doesn't apply.
- **No effort / model / timeout handling** — these fields are
  accepted on the agent schema but ignored at runtime because nothing
  is ever invoked. Agents declaring `backend: passive` typically omit
  them. The `unrestricted` flag and `cwd` are still persisted to the
  manifest for audit / workspace-path purposes.

**Who drives a passive run?** An external agent or script, through
the task commands:

- `task-runner init` writes the workspace + manifest and (for passive)
  prints the composed bootstrap to stdout
- `task-runner task set <run> <task-id> [--status ...] [--notes ...]`
  updates a single task
- `task-runner task add <run> --title "..."` appends a new task
- `task-runner status <run>` reads progress

All four commands go through the same `resolveResumeTarget` →
manifest-load pipeline as resume. `task set` / `task add` then call
`applyPassiveFinalization` to re-derive the manifest status from the
task map after each mutation (see
[Passive auto-finalization](#--resume-run-idpath)).

**Prompt composition for passive init.** Passive agents use a
distinct `PASSIVE_TASK_WORKFLOW_TEMPLATE` in place of the default
`TASK_WORKFLOW_TEMPLATE`. The difference: the passive template
teaches the external driver to use the CLI (`task-runner task set
<run> <task-id> --status in_progress`) instead of editing
`assignment.md` directly. The composed prompt — agent role
instructions + assignment instructions + passive workflow template +
message — is stored in `manifest.pendingPrompt` and **never cleared**
(execute-after-init never fires for passive runs), so the driver can
re-fetch it at any time with
`task-runner status <run> --output-format json --field pendingPrompt`.

**Locking recommendation.** A passive agent should declare
`lockedFields: [backend]` so callers can't subvert it with
`--backend claude` / `--backend codex` at init time and turn a
sidecar-only agent into an executable one. The bundled
`agents/passive-example/` does this and serves as the reference shape.
The lock check uses the same `checkLockedFields` machinery as every
other locked field — no passive-specific lock handling exists.

## Session resume

Session resume comes in two flavors that share the same underlying
mechanism: `claude --resume <session-id>`.

1. **In-run retries** — after each incomplete attempt in a session, the
   next attempt within that same session reuses the captured session id
   so claude keeps its context across attempts.
2. **Cross-invocation resume** — a later `task-runner run --resume-run <id>`
   invocation picks up an existing run and opens a new session that
   continues from the prior one.

### Why `--resume` and not `--continue`

`claude --continue` resumes the **most recent** session in the user's
Claude state directory. That is unsafe — another `task-runner` run, a
manual `claude` invocation in another terminal, or any other process could
have created a newer session in between our attempts, and `--continue`
would silently pick up the wrong one.

`claude --resume <session-id>` takes an **explicit** session ID. We extract
the ID from the first attempt's output and store it on the in-memory run
context. Each retry passes the same explicit ID. Never `--continue`, never
"resume the last session," never implicit.

### Extraction

The Claude adapter scans every parsed event for (in order of preference):

1. Top-level `session_id` or `sessionId` string
2. Nested `session.id` string

The first match wins. The extracted ID is stored on the in-memory run
context, recorded into the manifest as `backendSessionId`, and passed back
into every subsequent `backend.invoke()` call for the remainder of the run.

### Failure handling

There is no fallback path. Both in-run and cross-invocation resume use
one rule: **if resume fails, the run fails**.

- **In-run retry, claude rejects the session** (non-zero exit with stderr
  matching "session not found", "no such session", or equivalent): the
  run terminates with status `error` and exit code 4. No fallback to
  fresh conversation. If resume ever succeeded once in the same session
  and then fails later, we do not silently degrade — the caller sees the
  failure and can decide what to do (usually: start a fresh run).
- **Cross-invocation resume, manifest has `backendSessionId: null`**:
  `--resume-run` exits 3 before starting. There is nothing to resume.
- **Cross-invocation resume, claude rejects the inherited session** on
  the first attempt of the resumed session: exit 4 with the same error.
- **Session ID storage for forensics**: always written into `run.json`.
  The runner reads it back when explicitly resuming via `--resume-run`,
  and never otherwise. Each fresh `task-runner run` (without
  `--resume-run`) starts with no session knowledge.

### Upstream printing normalization

Because we invoke claude with `--output-format stream-json`, the raw stdout
is verbose JSON events. The user never sees that in text mode. The adapter
classifies each event and decides what to show:

| Event shape | User output |
|---|---|
| `stream_event.content_block_delta` with `text_delta` | the `text` field, verbatim, streamed |
| `assistant` message with content blocks | extracted text (only if no deltas were seen) |
| `result` (terminating event) | used for the attempt's final-message buffer, not echoed |
| anything else (session init, tool_use, rate_limit, metadata) | silent |

The raw JSON events are still captured verbatim into
`attempts/NN.json` for forensics, regardless of output mode.

## CLI shape

```
task-runner <run|init|status|task> [options] [args]

# run / init shared flag set
task-runner <run|init>
               [--agent <name-or-path>]
               [--assignment <name-or-path>]
               [--resume-run <id|path>]         (run only)
               [--backend-session-id <id>]      (fresh run only)
               [--var k=v]...
               [--add-task <title>]...
               [--cwd <path>]
               [--backend <claude|codex|passive>]
               [--model <model>]
               [--effort <level>]
               [--max-retries <n>]
               [--timeout-sec <n>]
               [--unrestricted]
               [--session-name <name>]
               [--output-format <text|json>]
               [message]

# status — read-only inspector
task-runner status <id|path>
               [--output-format <text|json>]
               [--field <name>]...              (json only; repeatable)

# task — mutate an existing run's checklist without invoking a backend
task-runner task set <id> <task-id>
               [--status <pending|in_progress|completed|blocked>]
               [--notes <text>]
               [--output-format <text|json>]

task-runner task add <id>
               --title <text>
               [--output-format <text|json>]
```

Subcommands:

- **`run`** — execute an agent. Either a fresh run, a resume of an
  already-executed run, or an execute-after-init (when `--resume-run`
  points at a manifest with `status: "initialized"`). **Rejected on
  passive agents** — use `init` + `task set` / `task add` instead.
- **`init`** — prepare a run without invoking the backend. Resolves
  agent + assignment, composes the full fresh-run prompt, writes the
  workspace (`assignment.md` with task fences, `run.json` with
  `status: "initialized"` and a frozen `pendingPrompt`), then exits.
  For non-passive agents, the caller picks the run up later with
  `task-runner run --resume-run <id>`. For passive agents, the caller
  drives the run through `task set` / `task add`; there is no
  execute step.
- **`status`** — read-only inspector. Resolves a run by short id or
  workspace path, parses the manifest, and prints either a
  human-readable status block (with task checklist and notes) or the
  full manifest JSON. When the run's manifest status is `running`,
  status also parses the workspace `assignment.md` and overlays the
  live task states onto the output — useful for watching an in-flight
  attempt without attaching to the process.
- **`task set`** / **`task add`** — mutate a run's task list without
  invoking a backend. Both go through the same manifest-resolve
  pipeline as `resume`, apply the mutation (merging any live
  assignment.md edits first), rewrite both `assignment.md` and
  `manifest.finalTasks` atomically, and for passive runs re-derive
  the manifest status via `applyPassiveFinalization`. Both commands
  are rejected while manifest `status == "running"` — a live backend
  attempt owns the workspace and a concurrent CLI write would race
  the attempt's parse/merge cycle. Allowed on `initialized` and every
  terminal state. `task add` respects the `tasks` locked field via
  the same `checkLockedFields` path used by `--add-task` on fresh
  runs.

`--agent` is **optional**:

- **With `--resume-run`**: the agent config is reconstructed from
  the frozen manifest (`loadedAgentFromManifest`). `agent.md` is
  never re-read. If `--agent` is also passed on resume, it is
  ignored for field resolution — the manifest wins. (Passing it is
  harmless but unnecessary.)
- **Fresh run / init with `--agent <name|path>`**: the on-disk
  `agent.md` is loaded normally and the frozen snapshot is written
  into the manifest on first write.
- **Fresh run / init without `--agent`**: the agent is synthesized
  on-the-fly as an **ad-hoc agent** (`name: "ad-hoc"`,
  `sourcePath: null`, empty role instructions, empty locks).
  **`--backend` is required** in this case — missing it exits with
  code 3. See [Ad-hoc agents](#ad-hoc-agents) for the full
  synthesis rules.

`--assignment` is optional on fresh runs. When supplied, the named or
pathed `assignment.md` is loaded, its tasks and `message` seed the run,
and a copy is placed in the workspace as `assignment.md`. The source
file is never mutated. When omitted, the run starts with no tasks
unless `--add-task` is used.

`--assignment` is **forbidden** with `--resume-run`. The existing
workspace `assignment.md` is authoritative on resume; use `--add-task`
and/or a follow-up `[message]` to extend the run.

### `task-runner status`

`task-runner status <id|path>` is a read-only inspector for an
existing run. It resolves the manifest the same way `--resume-run`
does (slug under `.task-runner/`, workspace dir, or direct
`run.json` path) and prints either a human-readable summary or the
manifest as JSON. It never invokes a backend, never writes to disk,
never touches state.

- **Default (text)**: a status block with the run id, agent,
  assignment, backend/model, sessionName, cwd, workspace path,
  start/end timestamps, attempt counts, and the per-task checklist
  with statuses and notes. Trailing hint matches the run's status
  (resume command for terminal states, execute command for
  initialized runs).
- **`--output-format json`**: prints the manifest verbatim as
  pretty-printed JSON. Byte-identical to `cat run.json`.
- **`--field <name>` (repeatable, json mode only)**: projects to
  the named top-level manifest fields and prints just those as a
  JSON object. Unknown field names exit with code 3. Use this for
  scripts that only care about, say, `status` and `tasksCompleted`.

#### Live overlay during a `running` attempt

`run.json` is only persisted *between* attempts (see "When the
manifest is written") so it's stale during a long-running attempt.
To avoid that, when `status` resolves a manifest with
`status: "running"` it also reads the workspace `assignment.md`,
parses it with the same parser the run loop uses, and overlays
the live task statuses + notes onto the rendered output.

- The overlay is **read-only**. The status command never writes
  to `run.json` or `assignment.md`.
- The overlay only fires when `manifest.status === "running"`.
  Terminal manifests (success / blocked / exhausted / aborted /
  error / initialized) use the snapshot — there's nothing live to
  read.
- Both text and JSON output are overlaid: `finalTasks` and
  `tasksCompleted` reflect the live values, so a script reading
  `--field tasksCompleted` mid-attempt sees the agent's progress.
- The top-level `manifest.status` is **not** changed by the
  overlay. A run with all tasks marked complete on disk is still
  `running` until the run loop sees that and writes the terminal
  state itself. Status flipping is the run loop's job, not the
  inspector's.
- Invalid status strings in the workspace file (anything not in
  the `TaskStatus` enum) fall back to the manifest's snapshot
  value for that task. Better to under-report progress than to
  surface a corrupt status.
- Missing or unparseable workspace files fall through silently to
  the manifest snapshot — the overlay is best-effort.
- Text output adds a marker line:
  `(task statuses above are read live from the workspace
  assignment.md; the current attempt may still be in progress)`

### `task-runner init`

`init` is `run` that stops short of invoking the backend. It:

1. Resolves agent + assignment and runs the same locked-field checks,
   var resolution, and prompt composition as a fresh run.
2. Creates the workspace directory (`.task-runner/<short-id>/`),
   writes the task-fenced `assignment.md`, and writes `run.json` with
   `status: "initialized"`, `sessionCount: 0`, empty `sessions` and
   `attemptRecords`, and the composed prompt frozen in
   `pendingPrompt`.
3. Prints the run id and the exact resume command on stderr and exits
   with code 0.

`init` is forbidden with `--resume-run` (you cannot initialize a run
that already exists). An `init` run does nothing that a later `run`
can't also do on the first session — its purpose is to separate the
*seeding* step from the *execution* step, so an orchestrator can
prepare work for an agent and hand off a resumable run id without
committing to running it immediately.

**Passive backend exception.** When the agent declares
`backend: passive`, `init` still writes the workspace and the
manifest, but there is no later execution step. The run is
sidecar-only: callers drive it through `task set` / `task add` and
read progress through `status`. Specifically:

- The composed `pendingPrompt` uses `PASSIVE_TASK_WORKFLOW_TEMPLATE`
  (CLI-based workflow) instead of `TASK_WORKFLOW_TEMPLATE` (file-edit
  workflow). The frozen prompt exists as a re-orientation payload,
  not as text that will be sent to a model.
- The bootstrap (composed prompt) is printed to **stdout** for
  piping; the brief progress lines stay on stderr.
- The stderr footer hints at `task set`, not `run --resume-run`.
- Task mutations auto-finalize the manifest (see "Passive
  auto-finalization" below).

### `--resume-run <id|path>`

`--resume-run` serves two modes depending on the prior manifest's
`status`:

**Execute-after-init** (`status: "initialized"`, non-passive backend):

- Starts session 0 — the first real session for this run.
- The stored `pendingPrompt` is sent verbatim as the first attempt's
  prompt. The agent config is reconstructed from the frozen manifest
  via `loadedAgentFromManifest` (no re-read of the source `agent.md`
  under the manifest-canonical design). Role instructions, locked
  fields, backend, model, effort, timeoutSec, etc. all come from the
  manifest.
- **No overrides are accepted.** Init deliberately froze every
  resolvable field at creation time, so the only valid invocation
  is `task-runner run --resume-run <id>` — any of `message`,
  `--add-task`, `--var`, `--agent`, `--assignment`, `--backend`,
  `--backend-session-id`, `--cwd`, `--model`, `--effort`,
  `--timeout-sec`, `--max-retries`, `--unrestricted`, or
  `--session-name` will exit 3 with a clear error. If you need
  different values, create a fresh run.
- `backendSessionId` is *not* required to be non-null (init leaves it
  `null` by definition).
- After this call, `pendingPrompt` is cleared and `sessionCount` goes
  to 1.

**Passive-backend exception**: `task-runner run` (fresh or
`--resume-run`) is rejected with exit code 3 when the resolved
backend is `passive`. Execute-after-init does not apply. The stored
`pendingPrompt` persists for the lifetime of the run as a
re-orientation payload for the external driver, accessible via
`task-runner status <id> --output-format json --field pendingPrompt`.

**Passive auto-finalization**: for a passive run, every successful
`task set` / `task add` re-derives `manifest.status` from the task
map after the mutation:

- any `pending` / `in_progress` → `initialized`
- all terminal, any `blocked`   → `blocked` (exit code 2)
- all `completed`               → `success` (exit code 0)

`endedAt` and `exitCode` are stamped only on an actual transition
into a terminal state (so a notes-only edit on an already-finalized
run preserves the recorded completion time). Self-healing: reopening
a completed task on a terminal passive run transitions back to
`initialized` and clears `endedAt` / `exitCode`.

**Resume of an already-executed run** (`status` is a terminal state
from a prior session):

- `<id>` is the short slug from `.task-runner/<id>/`, resolved against
  the current cwd.
- `<path>` can be a workspace directory or a direct path to a `run.json`
  file.
- At least one of a positional `[message]` **or** one or more
  `--add-task` flags is required when `--resume-run` is set. The runner
  throws `ResumeError` if both are absent. `--add-task` alone is valid:
  the "new tasks added" reminder becomes the entire follow-up prompt
  and tells the agent to re-read the assignment file.
- The prior manifest's `backendSessionId` must be non-null — else
  `ResumeError` and exit 3.
- Non-completed tasks from the prior run are normalized to `pending`
  (with their notes preserved); completed tasks stay completed.
- The agent config is reconstructed from the frozen manifest via
  `loadedAgentFromManifest`. The source `agent.md` is not re-read.
  `manifest.lockedFields` is consulted directly for override checks
  (the assignment's lock contribution was frozen into the same
  union at first write).
- The first attempt of the new session sends **only the follow-up
  message** (plus the new-tasks reminder if applicable) as its prompt.
  The instructions are not re-rendered, because the backend already
  has them in the cached session from the prior run.

**Resume override matrix.** All override validation for `--resume-run`
lives in a single `validateResumeOverrides` function in `src/cli.ts`
that runs right after `resolveResumeTarget`. The rules:

| Flag | Regular resume | Execute-after-init | Reason |
|---|---|---|---|
| `--agent` | rejected | rejected | Manifest is the source of truth for agent state; silently ignoring would mislead users who edit `agent.md` and expect it to take effect |
| `--assignment` | rejected | rejected | Baked into the workspace at first write |
| `--backend` | rejected | rejected | Backend session ids aren't portable across backends |
| `--backend-session-id` | rejected | rejected | The resume target already carries one |
| `--cwd` | rejected | rejected | Backend sessions are cwd-bound — a new cwd would invalidate `manifest.backendSessionId`. Create a fresh run if a different cwd is needed |
| `--var` | rejected | rejected | Vars are resolved from the assignment once at first write and frozen into `manifest.runtimeVars`; they're not re-resolved on resume, so passing `--var` was previously a silent no-op |
| `--model` | allowed | rejected | Per-turn setting; safe to change mid-thread. Init freezes it |
| `--effort` | allowed | rejected | Per-turn setting. Init freezes it |
| `--timeout-sec` | allowed | rejected | Per-attempt wall clock. Init freezes it |
| `--max-retries` | allowed | rejected | Per-session retry budget. Init freezes it |
| `--unrestricted` | allowed | rejected | Per-attempt spawn flag. Init freezes it |
| `--session-name` | allowed | rejected | Display-only label. Init freezes it (and an assignment-locked `sessionName` could otherwise be bypassed via init-then-resume) |
| `--add-task` | allowed | rejected | Legitimate mid-run task list extension. Init froze the task list |
| `[message]` | required | rejected | Required on regular resume; init pre-composed the prompt |
| `--output-format`, `--field` | allowed | allowed | Read-only; no state effect |

The `allowed` overrides on regular resume are still vetted by
`checkLockedFields` against the frozen `manifest.lockedFields` — so
a run that locked any of them (e.g. `lockedFields: [model]`) still
rejects the override with `LockedFieldError`.

Vars are passed via repeated `--var key=value` flags at fresh-run /
init time only. Env-sourced vars read from `process.env[envName]`.
The CLI validates each var against the schema before starting the
run. On resume, `--var` is rejected (vars are frozen into
`manifest.runtimeVars` at first write).

## Output modes

`--output-format` controls what goes to stdout:

### text (default)

- **Stdout**: the agent's text output, verbatim, piped live during each
  attempt. Between attempts, a divider is printed so concatenation is
  still readable:
  ```
  ── attempt 1 ──
  <agent stdout>

  ── attempt 2 ──
  <agent stdout>
  ```
- **Stderr**: runner chrome — startup banner (agent name, run ID,
  assignment path, cwd), attempt dividers, retry notifications, final
  summary.

Final summary on stderr, including per-task results with notes:

```
── summary ──
Status: success
Tasks completed: 3/3
Attempts: 2/4
Assignment file: /abs/path/.task-runner/k7m2xq/assignment.md

Task results:
  - t1_read_conventions — Check repo conventions [completed]
      2-space indent; prefer node:test; PRs squash-merge to main.
  - t2_audit_auth — Audit authentication flow [completed]
      OAuth2 via middleware/auth.ts; no session tokens stored at rest.
  - t3_summary — Summary [completed]
      Small monorepo for agent tooling; three packages under src/.

Review /abs/path/.task-runner/k7m2xq/assignment.md for additional agent output.
```

The `Task results` section is built from the in-memory task map, so it
always shows every declared task with its final status and any notes the
agent wrote. The final review hint is a reminder that the assignment
file on disk may contain content outside the structured notes fences
(the agent sometimes edits task bodies or adds scratch paragraphs) — if
the structured per-task notes above look thin, the file itself is worth
a glance.

### json

- **Stdout**: the full `RunManifest` as pretty-printed JSON, written once
  at the end of the run. This is byte-identical to `run.json` on disk.
- **Stderr**: silent. All runner chrome and live agent text are suppressed.

This makes `task-runner run --agent X --output-format json > result.json`
trivially correct — no filtering, no stream interleaving, just the manifest.

The manifest is always written to `run.json` on disk regardless of output
mode. `--output-format json` only controls whether it's also printed to
stdout.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | All tasks completed successfully |
| 1 | Retries exhausted with tasks still incomplete |
| 2 | One or more tasks reported as blocked |
| 3 | Config / validation error before any run started |
| 4 | Backend invocation error (binary not found, spawn failed, etc.) |
| 130 | Run interrupted by the user (Ctrl+C / SIGINT) |

## Importing an existing backend session

`task-runner` can adopt an existing backend session (claude session
UUID, codex thread id) instead of starting a fresh one. The flag is
`--backend-session-id <id>` and works on `init` and on a fresh
`run` (forbidden with `--resume-run`, since the resume target
already carries one).

### Validation

Before any workspace creation, `runAgent` calls
`backend.validateSessionId(...)` — a cheap, read-only check that
the id exists *and* was created under the same `cwd` we're about
to operate under. On failure it throws `InvalidBackendSessionError`
and the CLI exits with code 3.

- **claude**: filesystem-only. The session is stored at
  `~/.claude/projects/<encoded-cwd>/<id>.jsonl` where
  `<encoded-cwd>` is the cwd path with every `/` and `.` replaced
  by `-`. We `existsSync` that path. No subprocess, no network.
- **codex**: opens the JSON-RPC transport (stdio or websocket),
  completes the `initialize` + `initialized` handshake, sends one
  `thread/read { threadId }` call, closes the transport. The
  response carries a `Thread` whose `cwd: PathBuf` field is
  compared to ours; mismatched cwd is a hard error even though
  codex itself allows it on resume (mismatched cwd almost always
  means the user is confused, and silent semantic drift is worse
  than a hard error).

Backends that don't implement `validateSessionId` are treated as
"always valid" and the first real invocation discovers the truth.

### Wiring

If validation passes, the imported id is persisted to the
manifest's `backendSessionId` at construction time and used as the
initial `resumeSessionId` for the very first attempt. From there
the run flows through the existing resume path — retries, abort,
status, and resume all work without any new code. An init that
imported a session writes the id into the initialized manifest;
the subsequent execute-after-init reads it back from the manifest
and continues normally.

The cwd lock is the main constraint: if you imported a claude
session created under `/home/kevin/foo`, you must pass `--cwd
/home/kevin/foo` (or have it as the agent's default) on the
import call. Otherwise validation fails with a clear "expected
file" / "cwd mismatch" message.

## Recursion depth guard

When an orchestrator agent itself shells out to `task-runner run` to
spawn a child agent, the child can in turn spawn another, and so on.
Without a guard a misbehaving agent can recurse indefinitely. Two
env vars travel through every backend child invocation to enforce a
hard cap:

```
TASK_RUNNER_CALL_DEPTH       — current depth (0 at the outermost call)
TASK_RUNNER_MAX_CALL_DEPTH   — hard cap, default 1
```

On entry, `runAgent` reads the current depth from its own env. If
`currentDepth >= maxDepth` it throws `RecursionDepthError` *before*
creating the workspace or invoking any backend, and the CLI exits
with code 3. When constructing the env for the backend child
process, the runner overlays an incremented depth so a nested
`task-runner run` spawned by that backend inherits it.

- **Default cap is 1.** Only one level of nesting is allowed: a
  user invocation (depth 0) can spawn one agent that itself runs
  `task-runner run` (depth 1), but that nested invocation refuses
  to spawn another. Two-level recursion has not yet shown up as a
  real use case and almost every "agent calls agent calls agent"
  scenario is a confused agent looping on itself.
- Override with `TASK_RUNNER_MAX_CALL_DEPTH=N task-runner run ...`
  if you genuinely need deeper chains.
- Invalid / non-numeric env values fall back to defaults silently.
  A malformed env var must never disable the cap.
- The check is depth-first: it fires at the top of `runAgent`, so a
  runaway recursive chain dies cheaply with no workspace, no
  manifest, no attempt log written.

## External codex interrupts

Codex managed mode (especially over websocket) lets multiple clients
attach to the same thread at once — useful for "watch what the agent
is doing" or "step in mid-task". When another client cancels the
turn from the side, codex emits `turn/completed` with
`status: "interrupted"` to *all* connected clients, including
task-runner.

Without special handling, task-runner sees the interrupted status,
counts it as "tasks not all done", and re-invokes the agent on its
next retry — exactly the wrong thing if the user wanted to take
over the conversation.

The runner detects this case and treats it like a Ctrl+C:
`status: "aborted"`, exit 130, no retry, fully resumable. The check
is `state.turnStatus === "interrupted" && !timedOut && !aborted` —
both the timeout path and the runner's own SIGINT path also produce
`status: "interrupted"` (since the runner calls `turn/interrupt`
itself), but in those cases the corresponding flag is already set.
An interrupted status with neither flag set means the cancellation
came from outside.

When detected, the codex backend writes a hint to stderr telling the
user that the turn was interrupted externally and how to resume.
The pure detection helper `isExternalInterrupt(turnStatus,
timedOut, aborted)` is exported from `src/backends/codex.ts` and
unit-tested directly.

## User interrupts (Ctrl+C)

The CLI installs a `SIGINT` handler that:

1. **First Ctrl+C**: aborts the in-flight `backend.invoke()` via an
   `AbortController`. Each backend handles the abort cleanly:
   - **claude**: sends `SIGINT` to the child, then `SIGKILL` after a
     5s grace period.
   - **codex**: races the abort signal alongside the per-attempt
     timeout in the turn-wait loop. On abort, sends `turn/interrupt`
     to the codex app-server (same path the timeout takes), then
     closes the transport.
   The run loop sees `invokeResult.aborted === true`, sets
   `manifest.status = "aborted"`, persists the manifest, and exits
   with code 130. The aborted run is resumable like any other
   terminal state.
2. **Second Ctrl+C**: bypasses the run loop entirely and force-exits
   the process with 130. Use this if the backend is wedged and
   doesn't respond to the interrupt within a few seconds.

The `aborted` manifest status is distinct from `error` (backend
failure) and `exhausted` (out of retries). It signals "user pulled
the plug; nothing went wrong." A subsequent `task-runner run
--resume-run <id>` picks up exactly where the aborted run left off.

## Milestones

1. **M1 — Scaffold**: repo layout, package.json, biome/husky, tsconfig,
   design doc, example agent.md, README.
2. **M2 — Happy path**: config loader, assignment writer, Claude subprocess
   backend with stream-json parsing + session ID extraction, minimal run
   loop, manifest module, single-task happy path. Tests with a mock
   backend.
3. **M3 — Retry + merge + resume + manifest**: parser, merge writer, nudge
   builder, retry loop with `--resume`, `blocked` handling, invalid-status
   handling, session ID fallback, per-attempt manifest writes with full
   task snapshots. Full decision table.
4. **M4 — Output formats + polish**: `--output-format json` with manifest
   stdout dump, final summary polish, interpolation for all runner-injected
   vars, example agent.md demonstrating realistic usage, README quickstart.

## Open questions / deferred

- **Sensitive var redaction**: `sensitive: true` fields should be redacted
  from manifest `prompt` fields and from logs. Not yet implemented.
- **Tool permissions / allowlists**: Claude CLI supports `--allowedTools`,
  `--permission-mode`, etc. Not in scope until an agent actually needs it.
  A middle-ground permission mode (e.g., `acceptEdits` only) would be a
  nice alternative to the blunt `unrestricted: true` toggle.
- **Additional backends**: Codex shipped in M5 (JSON-RPC over stdio
  and websocket transports). Passive shipped as a null-object backend
  for sidecar-only runs. Future adapters (Gemini, Ollama, etc.) can
  be added to `src/backends/registry.ts` by implementing the `Backend`
  interface — no other code should need to know about them.
- **Task ID uniqueness**: enforced via zod `refine` at load time.
- **Max task count**: enforced at 100 in schema.
- **Concurrent resume**: two `task-runner run --resume-run <id>`
  processes targeting the same run would race on `run.json` and
  `attempts/NN.json`. Unsupported; no lock file. Document as
  caller's responsibility.
- **Attempt log compression**: raw stream-json output can be large for
  long runs. If disk becomes a concern we could gzip the sidecar files or
  switch to parsed-events JSON (dropping unknown event types). Not a
  concern at current scale.

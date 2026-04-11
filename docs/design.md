# task-runner — Design

## Purpose

`task-runner` is a minimal CLI that invokes an AI agent (starting with Claude)
with a pre-seeded task list and enforces completion. If the agent does not
finish every task, the runner re-invokes it up to a configurable number of
retries. If the agent reports a task as blocked, the runner stops and surfaces
the blocker instead of spinning.

It is a deliberate strip-down of concepts from `agent-runner`. The goal is a
small, focused tool — no daemon, no web console, no storage layer, no fully
customizable hook framework. Just: "invoke an agent with this config, make
sure it completes this list, return the output."

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
  policies). `task-runner` has exactly one baked-in behavior: enforce task
  completion and retry.
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
backend: claude                   # required; "claude" | "codex"
model: claude-sonnet-4-6          # optional
effort: medium                    # optional; off|minimal|low|medium|high|xhigh|max
timeoutSec: 3600                  # optional, default 3600
unrestricted: false               # optional, default false
cwd: .                            # optional, default "."
maxRetries: 3                     # optional, default 3
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
| `backend` | Adapter dispatch (`claude` or `codex`) |
| `model` | Model identifier; per-backend namespace prefix is stripped |
| `effort` | Canonical effort enum; mapped per-adapter |
| `timeoutSec` | Per-invocation wall clock |
| `unrestricted` | Backend permission bypass |
| `cwd` | Subprocess / invocation working directory |
| `maxRetries` | Retry budget per session |
| `lockedFields` | Fields the caller cannot override |
| _(body)_ | Agent's **role instructions** — renders as part of every fresh-run prompt |

Agent frontmatter **does not contain** `vars`, `tasks`, or `message` —
those are assignment-level concepts.

### Assignment schema

```yaml
---
schemaVersion: 1
name: repo-orientation
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
| `vars` | CLI/env input schema (validated at run time) |
| `message` | Default follow-up message for the run |
| `tasks` | Task checklist, stable IDs, max 100 per assignment |
| `lockedFields` | Fields the caller cannot override (union with agent's) |
| _(body)_ | Assignment's **work-context instructions** — renders after the agent body |

Assignments **do not contain** `backend`, `model`, `effort`, `cwd`,
`timeoutSec`, `unrestricted`, or `maxRetries` — those are agent-level.

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
cwd  backend  model  effort  instructions  message  timeoutSec  unrestricted  maxRetries  tasks
```

The zod schemas reject any entry outside this set at load time, so typos
fail fast.

**Who typically locks what**:

| Field | Typical lock owner |
|---|---|
| `cwd`, `backend`, `model`, `effort`, `timeoutSec`, `unrestricted`, `maxRetries` | agent — agent-owned config, agent decides CLI override rules |
| `instructions` | agent — refuses assignments with non-empty body |
| `message`, `tasks` | either — agent-wide prohibition OR per-assignment canonical value |

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

Applied to: the instructions body, `cwd`, and any string field the runner
renders into user-visible text.

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
- Starts by reloading the latest `agent.md` and the workspace
  `assignment.md` (changes since the prior session are picked up)
- Re-checks overrides against the combined `lockedFields`
  (agent ∪ assignment)
- For resume sessions (index > 0), the first attempt's prompt is
  **only the follow-up message** (plus the new-tasks reminder if
  applicable) — the instructions are not re-rendered because the
  backend has them in the cached conversation

The top-level `manifest.status`, `manifest.exitCode`, and
`manifest.endedAt` always reflect the **latest** session. Earlier
sessions' terminal states are preserved in their individual session
records.

## Run manifest

`run.json` is written at run start, rewritten after every attempt, and
rewritten one last time when the run reaches a terminal state. It is a
single JSON document — never JSONL, never append-only — so you can always
`cat` or `jq` the latest version.

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
  schemaVersion: 1;
  runId: string;
  agent: { name: string; sourcePath: string };
  assignment: {                    // null if the run had no --assignment
    name: string;
    sourcePath: string;            // source path the assignment was loaded from
    workspacePath: string;         // copied workspace assignment.md
  } | null;
  backend: string;
  model: string | null;
  effort: string | null;
  message: string | null;          // session 0's initial message
  unrestricted: boolean;
  cwd: string;
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
**codex** (JSON-RPC over stdio or WebSocket).

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
task-runner <run|init>
               [--agent <name-or-path>]
               [--assignment <name-or-path>]
               [--resume-run <id|path>]       (run only)
               [--var k=v]...
               [--add-task <title>]...
               [--cwd <path>]
               [--backend <claude|codex>]
               [--model <model>]
               [--effort <level>]
               [--max-retries <n>]
               [--timeout-sec <n>]
               [--unrestricted]
               [--output-format <text|json>]
               [message]
```

Two subcommands share the same flag set:

- **`run`** — execute an agent. Either a fresh run, a resume of an
  already-executed run, or an execute-after-init (when `--resume-run`
  points at a manifest with `status: "initialized"`).
- **`init`** — prepare a run without invoking the backend. Resolves
  agent + assignment, composes the full fresh-run prompt, writes the
  workspace (`assignment.md` with task fences, `run.json` with
  `status: "initialized"` and a frozen `pendingPrompt`), then exits.
  The caller picks the run up later with
  `task-runner run --resume-run <id>`.

`--agent` is required for fresh runs. When `--resume-run` is supplied,
`--agent` becomes optional — the runner reloads `agent.md` from the path
stored in the prior manifest.

`--assignment` is optional on fresh runs. When supplied, the named or
pathed `assignment.md` is loaded, its tasks and `message` seed the run,
and a copy is placed in the workspace as `assignment.md`. The source
file is never mutated. When omitted, the run starts with no tasks
unless `--add-task` is used.

`--assignment` is **forbidden** with `--resume-run`. The existing
workspace `assignment.md` is authoritative on resume; use `--add-task`
and/or a follow-up `[message]` to extend the run.

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

### `--resume-run <id|path>`

`--resume-run` serves two modes depending on the prior manifest's
`status`:

**Execute-after-init** (`status: "initialized"`):

- Starts session 0 — the first real session for this run.
- The stored `pendingPrompt` is sent verbatim as the first attempt's
  prompt. The current `agent.md` is reloaded only to resolve the
  backend; role instructions are not re-composed.
- No `--message`, `--add-task`, `--var`, or override flags are
  accepted. If the workflow needs to change, re-run `init`. (This
  keeps the init → execute handoff honest: whatever was composed at
  init time is what runs.)
- `--assignment` is forbidden (it's baked into the stored prompt and
  workspace).
- `backendSessionId` is *not* required to be non-null (init leaves it
  `null` by definition).
- After this call, `pendingPrompt` is cleared and `sessionCount` goes
  to 1.

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
- The reloaded `agent.md` is authoritative for all agent fields, and
  the reloaded assignment info is re-checked against the prior
  workspace `assignment.md` — `lockedFields` from both files union and
  override attempts are re-checked.
- The first attempt of the new session sends **only the follow-up
  message** (plus the new-tasks reminder if applicable) as its prompt.
  The instructions are not re-rendered, because the backend already
  has them in the cached session from the prior run.

CLI flags (and the positional `message`) override agent/assignment
values for: `cwd`, `backend`, `model`, `effort`, `message`,
`timeoutSec`, `unrestricted`, `maxRetries`. `--add-task` extends the
assignment's `tasks:` array. Any field listed in the combined
`lockedFields` (agent ∪ assignment) rejects override attempts with
`LockedFieldError` and exit code 3 — see [Locked fields](#locked-fields).

`--backend <claude|codex>` is special:

- Forbidden with `--resume-run`. Backend session ids aren't portable
  across backends, so a resume must use the same backend the run was
  created with. The CLI reads `backend` from the prior manifest on
  resume, ignoring the reloaded agent.md.
- When set on a fresh run, the agent's `model` is **dropped** unless
  `--model` is also passed. Model strings are backend-specific
  (`claude-sonnet-4-6` vs `gpt-5.4`), so an agent declared with a
  claude model would otherwise fail at backend invocation. The
  pattern is `--backend codex --model gpt-5.4`.
- The `backend` field stored in the manifest is the override value
  (or the agent's default if no override), so `run.json` always
  reflects what was actually used.

Vars are passed via repeated `--var key=value` flags. Env-sourced vars
read from `process.env[envName]`. The CLI validates each var against the
schema before starting the run.

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
- **Non-Claude backends**: Codex, Gemini, etc. Backend interface is
  designed to admit them; implementation is not yet in scope.
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

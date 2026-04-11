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
task-runner run --agent <name> [--var k=v]... [extra prompt]
   │
   ▼
1. Load + validate agent.md (zod schema)
2. Resolve vars (CLI → env → defaults)
3. Create workspace: <cwd>/.task-runner/<short-id>/
4. Build in-memory task map from agent.md `tasks:`
5. Write tasks.md from the map
6. Render prompt with {{var}} + {{plan_path}} + {{run_id}} substitution
7. Loop:
     a. Invoke Claude subprocess (streams stdout to user, captures to buffer)
     b. Parse tasks.md back, merge status/notes into in-memory map
     c. Decide: done? blocked? retry? fail?
     d. If retry: build nudge message, merge missing sections back into
        tasks.md, re-invoke
8. Print summary (stderr) + concatenated final messages (stdout)
9. Exit with status code
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
│   ├── config/
│   │   ├── schema.ts      # zod AgentConfig schema
│   │   ├── loader.ts      # locate + parse agent.md with gray-matter
│   │   └── interpolate.ts # {{var}} substitution
│   ├── plan/
│   │   ├── model.ts       # TaskState types
│   │   ├── writer.ts      # serialize in-memory map -> tasks.md
│   │   ├── parser.ts      # parse tasks.md -> status/notes updates
│   │   └── merge.ts       # merge: missing sections only, preserve agent edits
│   ├── backends/
│   │   ├── types.ts       # Backend interface
│   │   └── claude.ts      # Claude CLI subprocess adapter
│   ├── runner/
│   │   ├── run-loop.ts    # seed → invoke → parse → retry
│   │   ├── nudge.ts       # retry prompt builder
│   │   └── output.ts      # summary + concat'd final messages
│   └── util/
│       ├── short-id.ts    # 6-char base32 nonce
│       └── spawn.ts       # subprocess helper (timeout, SIGINT/SIGKILL)
├── agents/
│   └── example/agent.md   # reference agent definition
└── test/
    ├── plan-roundtrip.test.mjs
    ├── backend-mock.test.mjs
    └── cli.test.mjs
```

## Agent definition schema

Agent definitions are Markdown files with YAML frontmatter, parsed with
`gray-matter` and validated with `zod`. The type is inferred from the zod
schema so the two never drift.

```yaml
---
schemaVersion: 1                  # required, must be 1
name: example                     # required, string
backend: claude                   # required; "claude" only for now
model: claude-sonnet-4-6          # optional, plain string (no enum wrapper)
effort: medium                    # optional; low | medium | high | max
timeoutSec: 3600                  # optional, default 3600
unrestricted: false               # optional, default false; maps to --dangerously-skip-permissions
cwd: .                            # optional, interpolatable with {{var}}
maxRetries: 3                     # optional, default 3
vars:
  repo_path:
    type: string                  # string | number | boolean | enum
    required: true                # default false
    source: cli                   # cli | env | either; default "cli"
    envName: REPO_PATH            # only when source includes env
    default: null                 # optional fallback
    description: Path to target repo
    sensitive: false              # default false
    values: [a, b, c]             # only for type: enum
tasks:
  - id: t1_read_conventions       # stable ID, [A-Za-z0-9._:-]+, max 128 chars
    title: Check repo conventions # required, short label
    body: |                       # optional, multi-line description
      Read AGENTS.md and CLAUDE.md.
---
You are a code exploration assistant working on {{repo_path}}.

Your plan is at `{{plan_path}}`. Read it, complete each task, and update
the Status field for each task as you go.
```

### Field rationale

| Field | Why kept | What was dropped |
|---|---|---|
| `schemaVersion` | Future migrations | — |
| `name` | Identity in errors/logs | — |
| `backend` | Adapter dispatch, extension point | — |
| `model` | Simple string; agent-runner's `{type, values, default}` enum wrapper is overkill here | — |
| `effort` | Maps to Claude CLI `--effort <low|medium|high|max>` | — |
| `timeoutSec` | Per-run wall clock | — |
| `unrestricted` | Claude permission bypass | — |
| `cwd` | Subprocess working directory | — |
| `maxRetries` | The point of the retry loop | `hooks.maxReinvokes` — renamed |
| `vars` | CLI input validation + template substitution | `requiredAt` phase split |
| `tasks` | Seeds the plan | Per-task `completed`/`active` state — runner owns that |
| instructions (body) | Rendered prompt with `{{var}}` | — |

Dropped entirely from agent-runner: `executionMode`, `adapterExecutionMode`,
`outputFormat`, `handleMode`, `passArgs`, `tools`, `events`, `hooks`,
`overridePolicy`, `hookMutationPolicy`, `runtimeRequirements`, `environment`,
`lineage`.

## Agent resolution

Given `--agent <name>`:

1. If `<name>` contains `/`, `\`, or starts with `.` → treat as a direct path
2. Else look for `<cwd>/agents/<name>/agent.md`
3. Else look for `<TASK_RUNNER_HOME>/agents/<name>/agent.md`
   (`TASK_RUNNER_HOME` defaults to `~/.task-runner`)
4. Else → `AGENT_NOT_FOUND`

## Variable interpolation

Lifted from `packages/core/config/src/index.ts` in agent-runner:

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

- `{{plan_path}}` — absolute path to `tasks.md` for this run
- `{{run_id}}` — the short ID for this run
- `{{cwd}}` — resolved absolute working directory

## Workspace layout

One directory per run, generated by the runner:

```
<cwd>/.task-runner/<short-id>/
└── tasks.md
```

`<short-id>` is a 6-character base32 nonce (e.g., `k7m2xq`). Multiple
concurrent runs in the same cwd get distinct directories and do not collide.

The directory is left on disk after the run (success or failure) for
inspection. Users should add `.task-runner/` to `.gitignore`.

## Task state model

The runner holds an in-memory `Map<taskId, TaskState>` that is authoritative
for the entire run. The file on disk is an I/O buffer.

```ts
type TaskStatus = "pending" | "in_progress" | "completed" | "blocked";

interface TaskState {
  id: string;           // from agent.md, stable
  title: string;        // from agent.md, never updated from file
  body: string;         // from agent.md, never updated from file
  status: TaskStatus;   // updated from file each round
  notes: string;        // updated from file each round
}
```

## `tasks.md` format

Written by the runner, edited by the agent.

```markdown
# Plan

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

**Status:** pending
**Notes:**

Read AGENTS.md and CLAUDE.md.

---

<!-- task-id: t2_audit_auth -->
## Task 2: Audit authentication flow

**Status:** pending
**Notes:**

...
```

### Parser rules

For each `<!-- task-id: X -->` marker found in the file:

- `X` unknown to the in-memory map → ignore
- Missing `**Status:**` line → keep in-memory status unchanged
- Status value ∉ {`pending`, `in_progress`, `completed`, `blocked`} → record
  invalid-status error for the nudge; keep in-memory status unchanged
- Valid status → update in-memory `status`
- `**Notes:**` block missing or empty → set notes to `""`
- `**Notes:**` block present → capture verbatim

For each task ID in memory **not** found in the file:

- Keep in-memory state untouched (delete-proofing)
- Flag for restoration on next write

### Merge / write policy

**Initial seed**: write full file — header block + all task sections.

**On retry**:

1. Read current `tasks.md`. If missing/empty/unparseable → fall back to full
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

After each invocation:

| State of tasks | Action |
|---|---|
| all `completed`, no invalid statuses | success → concat messages → exit 0 |
| any `blocked` | stop → surface blocked tasks + notes → exit 2 |
| any `pending`/`in_progress` OR any invalid status, retries left | reinvoke with nudge |
| any `pending`/`in_progress` OR any invalid status, retries exhausted | fail → exit 1 |

### Nudge message (not configurable)

Built from the in-memory map + any invalid-status errors captured during parse:

```
Some tasks in tasks.md are not yet completed. Please continue.

Remaining tasks:
- t1_read_conventions (status: pending) — Check repo conventions
- t3_run_tests (status: in_progress) — Run the test suite

Invalid status values:
- t2_audit_auth had status "done"; use "completed" instead.

Valid statuses: pending, in_progress, completed, blocked.
Update each task's Status to `completed` when done. If you cannot complete
a task, set its status to `blocked` and explain in Notes — the runner will
stop and report it instead of retrying.
```

## Backend interface

One small interface. Claude is the first (and only) implementation for now;
new backends are drop-in additions under `src/backends/`.

```ts
interface BackendInvokeContext {
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  model?: string;
  unrestricted?: boolean;
  timeoutSec: number;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
}

interface BackendInvokeResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutText: string;  // full captured stdout (== concatenated onStdout chunks)
  stderrText: string;
  timedOut: boolean;
}

interface Backend {
  id: string;
  invoke(ctx: BackendInvokeContext): Promise<BackendInvokeResult>;
}
```

### Claude implementation

Mirrors `packages/adapters/claude/src/index.ts` in agent-runner, trimmed,
with session-resume support baked in.

- **Binary**: `process.env.TASK_RUNNER_CLAUDE_BIN ?? "claude"`
- **Command shape**:
  ```
  claude --print --output-format stream-json --verbose \
         [--model <model>] \
         [--dangerously-skip-permissions] \
         [--resume <session-id>] \
         "<prompt>"
  ```
- **Output format**: `stream-json` (not raw text). The adapter parses
  events line-by-line as they arrive and extracts:
  1. **Text deltas** (`stream_event.content_block_delta` with
     `delta.type === "text_delta"`) → printed to the user's stdout as plain
     text, live, so the run does not look hung. This is the "normalize for
     upstream printing" step — the user never sees raw JSON.
  2. **Session ID** (`session_id`, `sessionId`, or nested `session.id` on
     any event) → captured into the run context on first sight. Used for
     `--resume` on retries.
  3. **Final assistant message** (accumulated text deltas, or a terminating
     `event.type === "result"` with a `result` field) → used for the
     attempt's entry in the concatenated summary.
- **Prompt** is passed as the final positional argument, not stdin.
- **Env**: `process.env` by default. Future hook point if we add an env policy.
- **Timeout**: `setTimeout(() => child.kill("SIGINT"), timeoutMs)`, escalate to
  SIGKILL after 5 seconds.
- **Completion detection**: process exit. Non-zero exit code is a failed
  attempt (counts against retries just like an incomplete task).

The `BackendInvokeResult` gains two fields for session handling:

```ts
interface BackendInvokeResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutText: string;          // raw captured stdout (stream-json)
  stderrText: string;
  timedOut: boolean;
  sessionId: string | null;    // extracted from events, or null if not found
  assistantMessage: string | null;  // extracted, not raw stdout
}
```

The runner passes the previous attempt's `sessionId` back in via a new
`resumeSessionId?: string` field on `BackendInvokeContext`. The Claude
adapter appends `--resume <id>` when present and omits the flag otherwise.

## Session resume across retries

This is the one piece of conversation continuity we care about: when the
runner re-invokes Claude after an incomplete attempt, it should pick up
where it left off (same context, same cache, less token churn), not start
a fresh conversation from zero.

### Why `--resume` and not `--continue`

`claude --continue` resumes the **most recent** session in the user's
Claude state directory. That is unsafe — another `task-runner` run, a
manual `claude` invocation in another terminal, or any other process could
have created a newer session in between our attempts, and `--continue`
would silently pick up the wrong one.

`claude --resume <session-id>` takes an **explicit** session ID. We extract
the ID from the first attempt's output (via `session_id` fields in
stream-json events) and store it on the in-memory run context. Each retry
passes the same explicit ID. Never `--continue`, never "resume the last
session," never implicit.

### Extraction

The Claude adapter scans every parsed event in the first attempt's stdout
for (in order of preference):

1. Top-level `session_id` or `sessionId` string
2. Nested `session.id` string
3. Nested `session.path` string (used as a fallback identifier)

The first match wins. The extracted ID is stored on the run context
(`runState.claudeSessionId`) and passed back into every subsequent
`backend.invoke()` call for the remainder of the run.

### Fallbacks and safety

- **Extraction fails on attempt 1** (no session ID in any event): the
  adapter returns `sessionId: null`. The runner logs a warning to stderr
  and falls back to fresh invocations on retries — the agent loses
  conversation context but still receives the full task state through
  `tasks.md` (which is the canonical source of truth anyway). The retry
  nudge message includes the task list in prose form so the agent has
  enough to pick up.
- **Claude refuses the resume** (non-zero exit classified as a resume
  failure via stderr patterns like "session not found", "no such session"):
  the runner clears the stored session ID and falls back to fresh
  invocation for the remaining retries.
- **Session ID storage**: in-memory only. Never persisted, never written to
  disk, never read from a previous run. Each `task-runner run` invocation
  starts with no session knowledge and only uses IDs it extracted during
  the current run.
- **No cross-run resumption**: `task-runner` never reads session IDs from
  the workspace directory, a config file, or env vars. The session ID
  lifecycle is strictly confined to the lifetime of a single `run`
  invocation.

### Upstream printing normalization

Because we now invoke with `--output-format stream-json`, the raw stdout
is verbose JSON events. The user never sees that. The adapter's event
parser classifies each event and decides what to show:

| Event shape | User output |
|---|---|
| `stream_event.content_block_delta` with `text_delta` | the `text` field, verbatim, streamed |
| `assistant` message with content blocks | extracted text, if not already streamed via deltas |
| `result` (terminating event) | used for the attempt's final-message buffer, not echoed |
| anything else (session init, tool_use, metadata) | silent |

The net effect is that user stdout looks identical to what `claude --print`
in text mode would produce, with no visible JSON chrome, while the runner
gets the structured data it needs for session resume and final-message
extraction.

Tool-use events (e.g., "Reading file X...") are silent for now. Adding a
compact tool-use indicator line is a future polish item, not M2.

## CLI shape

```
task-runner run --agent <name>
               [--var k=v]...
               [--cwd <path>]
               [--max-retries <n>]
               [--model <model>]
               [--timeout-sec <n>]
               [--unrestricted]
               [extra prompt text]
```

CLI flags override agent.md values for:

- `cwd`, `model`, `timeoutSec`, `unrestricted`, `maxRetries`

Vars are passed via repeated `--var key=value` flags. Env-sourced vars read
from `process.env[envName]`. The CLI validates each var against the schema
before starting the run.

## Output

- **Stdout**: the agent's text output, verbatim, piped live during each
  attempt. Between attempts, a divider is printed to stdout so concatenation
  is still readable:
  ```
  ── attempt 1 ──
  <agent stdout>

  ── attempt 2 ──
  <agent stdout>
  ```
- **Stderr**: runner chrome — startup banner (agent name, run ID, plan path),
  validation errors, nudge notifications, final summary.

### Final summary (stderr)

```
── summary ──
Status: success            # success | blocked | exhausted | error
Tasks completed: 3/3
Attempts: 2 (of max 3)
Plan file: /abs/path/.task-runner/k7m2xq/tasks.md
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | All tasks completed successfully |
| 1 | Retries exhausted with tasks still incomplete |
| 2 | One or more tasks reported as blocked |
| 3 | Config / validation error before any run started |
| 4 | Backend invocation error (binary not found, spawn failed, etc.) |

## Milestones

1. **M1 — Scaffold** (this commit): repo layout, package.json, biome/husky,
   tsconfig, design doc, example agent.md, README.
2. **M2 — Happy path**: config loader, plan writer, Claude subprocess backend
   with stream-json parsing + session ID extraction, minimal run loop.
   Single task, agent marks it complete, exit 0. No retry logic yet. Tests
   with a mock backend.
3. **M3 — Retry + merge + resume**: parser, merge writer, nudge builder,
   retry loop with `--resume`, `blocked` handling, invalid-status handling,
   session ID fallback logic. Full decision table.
4. **M4 — Polish**: interpolation for all runner-injected vars, final
   summary, example agent.md demonstrating realistic usage, README
   quickstart, optional tool-use indicator lines.

## Open questions / deferred

- **Sensitive var redaction**: `sensitive: true` fields should be redacted
  from logs, but we don't have a log layer yet. Defer until M4.
- **Prompt caching**: agent-runner supports session resume via
  `--resume <id>`. Not needed for single-shot task completion; skip entirely.
- **Tool permissions / allowlists**: Claude CLI supports `--allowedTools` etc.
  Not in scope until an agent actually needs it.
- **Non-Claude backends**: Codex, Gemini, etc. Backend interface is designed
  to admit them; implementation is not yet in scope.
- **Task ID uniqueness**: schema will enforce via zod `refine`.
- **Max task count**: enforce 100 in schema (agent-runner allows 1000; we
  don't need that many for a retry loop).

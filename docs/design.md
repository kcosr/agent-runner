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
writes an ephemeral scratch file (`tasks.md`) that the agent edits in place
during the run; after the run ends, `tasks.md` is purely diagnostic — the
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
task-runner run --agent <name> [--var k=v]... [--output-format text|json]
                               [message]
   │
   ▼
1. Load + validate agent.md (zod schema)
2. Resolve vars (CLI → env → defaults)
3. Create workspace: <cwd>/.task-runner/<short-id>/
4. Build in-memory task map from agent.md `tasks:`
5. Write initial tasks.md + run.json
6. Render prompt with {{var}} + {{plan_path}} + {{run_id}} substitution
7. Loop:
     a. Invoke Claude subprocess (stream-json, normalize for user output)
     b. Parse tasks.md back, merge status/notes into in-memory map
     c. Snapshot everything into the manifest + rewrite run.json
     d. Decide: done? blocked? retry? fail?
     e. If retry: merge missing sections back into tasks.md, build nudge,
        re-invoke with --resume <session-id>
8. Rewrite run.json with terminal state
9. Emit final output (text mode: stderr summary; json mode: print manifest
   to stdout)
10. Exit with status code
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
│   │   ├── manifest.ts    # RunManifest types + writer for run.json
│   │   ├── nudge.ts       # retry prompt builder
│   │   └── output.ts      # summary for text mode
│   └── util/
│       ├── short-id.ts    # 6-char base32 nonce
│       └── spawn.ts       # subprocess helper (timeout, SIGINT/SIGKILL)
├── agents/
│   └── example/agent.md   # reference agent definition
└── test/
    ├── plan-roundtrip.test.mjs
    ├── config-loader.test.mjs
    ├── nudge.test.mjs
    ├── manifest.test.mjs
    └── run-loop.test.mjs
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
message: "focus on auth"          # optional default message (see `message` below)
timeoutSec: 3600                  # optional, default 3600
unrestricted: false               # optional, default false; maps to --dangerously-skip-permissions
cwd: .                            # optional, interpolatable with {{var}}
maxRetries: 3                     # optional, default 3
lockedFields: [model, effort]     # optional; caller cannot override these
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
| `message` | First-class caller input, appended to instructions; overridable via CLI positional arg | — |
| `timeoutSec` | Per-run wall clock | — |
| `unrestricted` | Claude permission bypass | — |
| `cwd` | Subprocess working directory | — |
| `maxRetries` | The point of the retry loop | `hooks.maxReinvokes` — renamed |
| `lockedFields` | Simple allowlist-style version of agent-runner's `overridePolicy` | `overridePolicy.default` toggle, nested key paths |
| `vars` | CLI input validation + template substitution | `requiredAt` phase split |
| `tasks` | Seeds the plan and the manifest | Per-task `completed`/`active` state — runner owns that |
| instructions (body) | Rendered prompt with `{{var}}` | — |

Dropped entirely from agent-runner: `executionMode`, `adapterExecutionMode`,
`outputFormat` (as a per-agent config — we have a per-invocation CLI flag
instead), `handleMode`, `passArgs`, `tools`, `events`, `hooks`,
`hookMutationPolicy`, `runtimeRequirements`, `environment`, `lineage`.

## Message

The `message` field is first-class caller input. It can be set three ways,
in precedence order:

1. **CLI positional argument** — `task-runner run --agent X "focus on auth"`
2. **`message:` in agent.md frontmatter** — a default if no positional is given
3. **Unset** — no message at all

When set, the resolved message is appended to the rendered instructions
with a blank-line separator:

```
<rendered instructions body>

<message>
```

That's the only mechanism. No template placeholder (no `{{message}}`
interpolation), no system/user split — just concatenation. If the agent
author wants to control where the message lands, they write the rest of
the instructions accordingly (i.e., end the instructions at the point the
message should appear).

The resolved message is exposed at the top of `run.json` as
`manifest.message`, alongside `model`, `effort`, etc. The per-attempt
`AttemptRecord.prompt` field contains the full composed text that was
sent to the backend, including the message.

## Locked fields

`lockedFields: [<key>, ...]` in agent.md frontmatter declares which
top-level override fields cannot be overridden at run time. Valid entries:

```
cwd  model  effort  message  timeoutSec  unrestricted  maxRetries
```

The zod schema rejects any entry outside this set at load time, so typos
fail fast instead of silently granting no protection.

**Runtime check** — early in `runAgent()`, before any work starts, the
runner iterates over the provided overrides and throws `LockedFieldError`
if any locked field has a non-undefined value in the overrides. The CLI
catches the error and exits with code 3:

```
task-runner: cannot override locked field: model
  this agent fixes it to "claude-sonnet-4-6"
```

**Semantics** — locking only prevents *overrides*. If the caller doesn't
pass any value for a locked field, the frontmatter value is used silently,
same as any other field. Locking also doesn't affect `vars`: those have
their own schema (`required`, `source`, `sensitive`) and are outside this
mechanism.

**What this replaces** — agent-runner had a richer `overridePolicy` with
`{default: allow|deny, allow: [...], deny: [...]}`. We took the simplest
shape that solves the real concern (preventing callers from bumping
`effort` to `max` on a cost-sensitive agent, or flipping `unrestricted`
on a safety-sensitive one). A full allow/deny with a tri-state default is
easy to add if it becomes needed.

## Agent resolution

Given `--agent <name>`:

1. If `<name>` contains `/`, `\`, or starts with `.` → treat as a direct path
2. Else look for `<cwd>/agents/<name>/agent.md`
3. Else look for `<TASK_RUNNER_HOME>/agents/<name>/agent.md`
   (`TASK_RUNNER_HOME` defaults to `~/.task-runner`)
4. Else → `AGENT_NOT_FOUND`

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

- `{{plan_path}}` — absolute path to `tasks.md` for this run
- `{{run_id}}` — the short ID for this run
- `{{cwd}}` — resolved absolute working directory

## Workspace layout

One directory per logical run, generated by the runner on the first
invocation and **reused** across any subsequent `--resume-run`
invocations:

```
<cwd>/.task-runner/<short-id>/
├── run.json              # canonical manifest (accumulates across sessions)
├── tasks.md              # ephemeral scratch file the agent edits in place
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
thing you archive, share, or grep; `tasks.md` is a diagnostic artifact
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
- Starts by reloading the latest `agent.md` (changes since the prior
  session are picked up)
- Re-checks overrides against the reloaded agent's `lockedFields`
- For resume sessions (index > 0), the first attempt's prompt is
  **only the follow-up message** — the instructions body is not
  re-rendered because claude has it in the cached conversation

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
type ManifestStatus = "running" | "success" | "blocked" | "exhausted" | "error";

interface RunManifest {
  schemaVersion: 1;
  runId: string;
  agent: { name: string; sourcePath: string };
  backend: string;
  model: string | null;
  effort: string | null;
  message: string | null;          // session 0's initial message
  unrestricted: boolean;
  cwd: string;
  planPath: string;
  workspaceDir: string;
  startedAt: string;               // ISO-8601; session 0 start
  endedAt: string | null;          // latest session's end, null while running
  status: ManifestStatus;          // latest session's terminal state
  exitCode: number | null;         // latest session's exit code
  attempts: number;                // total across all sessions
  maxAttempts: number;              // latest session's retry budget
  tasksCompleted: number;
  tasksTotal: number;
  backendSessionId: string | null; // most recently captured claude session id
  finalTasks: Record<string, TaskSnapshot>;
  sessionCount: number;            // 1 for initial, 2 after first resume, etc.
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
to look at `tasks.md`.

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
`tasks.md` is an I/O buffer between the runner and the agent. `run.json` is
the canonical record. The relationship:

```
agent.md `tasks:`  ──►  in-memory Map  ──►  rendered to tasks.md
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
  id: string;           // from agent.md, stable
  title: string;        // from agent.md, never updated from file
  body: string;         // from agent.md, never updated from file
  status: TaskStatus;   // updated from file each round
  notes: string;        // updated from file each round
}
```

## `tasks.md` format

Written by the runner, edited by the agent. Ephemeral — the definitive
state lives in `run.json.finalTasks`.

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
Some tasks in /abs/path/tasks.md are not yet completed. Please continue.

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

One small interface. Claude is the first (and only) implementation for now;
new backends are drop-in additions under `src/backends/`.

```ts
type EffortLevel = "low" | "medium" | "high" | "max";

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
task-runner run [--agent <name-or-path>]
               [--resume-run <id|path>]
               [--var k=v]...
               [--cwd <path>]
               [--model <model>]
               [--effort <level>]
               [--max-retries <n>]
               [--timeout-sec <n>]
               [--unrestricted]
               [--output-format <text|json>]
               [message]
```

`--agent` is required for fresh runs. When `--resume-run` is supplied,
`--agent` becomes optional — the runner reloads `agent.md` from the path
stored in the prior manifest.

`--resume-run <id|path>` extends an existing run:

- `<id>` is the short slug from `.task-runner/<id>/`, resolved against
  the current cwd.
- `<path>` can be a workspace directory or a direct path to a `run.json`
  file.
- A positional `[message]` is **required** when `--resume-run` is set —
  the runner throws `ResumeError` without one.
- The prior manifest's `backendSessionId` must be non-null — else
  `ResumeError` and exit 3.
- Non-completed tasks from the prior run are normalized to `pending`
  (with their notes preserved); completed tasks stay completed.
- The reloaded `agent.md` is authoritative for all fields, including
  `lockedFields` — overrides are re-checked against the fresh file.
- The first attempt of the new session sends **only the follow-up
  message** as its prompt. The instructions body is not re-rendered,
  because claude already has it in the cached session from the prior
  run.

CLI flags (and the positional `message`) override agent.md values for:
`cwd`, `model`, `effort`, `message`, `timeoutSec`, `unrestricted`,
`maxRetries`. Any field listed in the agent's `lockedFields` rejects
override attempts with `LockedFieldError` and exit code 3 — see
[Locked fields](#locked-fields).

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
- **Stderr**: runner chrome — startup banner (agent name, run ID, plan
  path, cwd), attempt dividers, retry notifications, final summary.

Final summary on stderr, including per-task results with notes:

```
── summary ──
Status: success
Tasks completed: 3/3
Attempts: 2/4
Plan file: /abs/path/.task-runner/k7m2xq/tasks.md

Task results:
  - t1_read_conventions — Check repo conventions [completed]
      2-space indent; prefer node:test; PRs squash-merge to main.
  - t2_audit_auth — Audit authentication flow [completed]
      OAuth2 via middleware/auth.ts; no session tokens stored at rest.
  - t3_summary — Summary [completed]
      Small monorepo for agent tooling; three packages under src/.

Review /abs/path/.task-runner/k7m2xq/tasks.md for additional agent output.
```

The `Task results` section is built from the in-memory task map, so it
always shows every declared task with its final status and any notes the
agent wrote. The final review hint is a reminder that the plan file on
disk may contain content outside the structured notes fences (the agent
sometimes edits task bodies or adds scratch paragraphs) — if the
structured per-task notes above look thin, the file itself is worth a
glance.

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

## Milestones

1. **M1 — Scaffold**: repo layout, package.json, biome/husky, tsconfig,
   design doc, example agent.md, README.
2. **M2 — Happy path**: config loader, plan writer, Claude subprocess
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

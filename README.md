# task-runner

A small, focused CLI for invoking an AI coding agent against a structured
task list and making sure it actually finishes.

You write a checklist. `task-runner` hands it to a backend (Claude or
Codex), the agent works through it and updates each task as it goes,
and the runner enforces completion: if any task is still `pending` when
the agent ends its turn, the agent gets re-invoked with a nudge — up
to a configurable retry budget. Blocked tasks halt the run cleanly.
Aborted runs (Ctrl+C, external interrupt, timeout) persist their state
and can be resumed later.

It is intentionally not a daemon, not a web console, and not an
orchestration framework. It is one binary that runs an agent, watches
the work, and writes a single canonical record per run.

---

## Table of contents

- [Why](#why)
- [Features](#features)
- [Install](#install)
- [Quickstart](#quickstart)
- [Concepts](#concepts)
  - [Agents and assignments](#agents-and-assignments)
  - [Tasks and the workflow](#tasks-and-the-workflow)
  - [Workspaces and the run manifest](#workspaces-and-the-run-manifest)
- [Commands](#commands)
  - [`task-runner run`](#task-runner-run)
  - [`task-runner init`](#task-runner-init)
  - [`task-runner status`](#task-runner-status)
- [Backends](#backends)
- [Resuming, aborting, importing](#resuming-aborting-importing)
- [Variables and interpolation](#variables-and-interpolation)
- [Locked fields](#locked-fields)
- [Output modes](#output-modes)
- [Exit codes](#exit-codes)
- [Environment variables](#environment-variables)
- [Bundled examples](#bundled-examples)
- [Development](#development)
- [Project layout](#project-layout)

---

## Why

If you've used a coding agent for any non-trivial task, you've seen
this loop:

1. You give the agent a list of things to do.
2. The agent confidently announces "all done!"
3. You check, and two of the five things weren't actually done.
4. You write another prompt: "you didn't finish X and Y, try again."
5. Repeat.

`task-runner` wraps that loop. The task list is structured (each task
has a stable id, a title, and a status the agent updates in place),
the runner parses the file after every turn, and a partial completion
just becomes another iteration with a programmatic nudge instead of a
hand-typed follow-up. When the agent gets it right, the run ends and
the runner emits a single JSON record with the full transcript, the
final per-task statuses, and the agent's notes.

It is also a useful primitive for orchestration scenarios — an outer
agent can compose an `assignment.md`, hand it to `task-runner`, and
get back a structured success/failure with no parsing of free-form
chat output.

## Features

- **Two backends**: Claude (subprocess wrapping `claude --print`) and
  Codex (JSON-RPC managed mode over stdio or websocket).
- **Structured task enforcement**: tasks have stable ids and statuses
  (`pending`, `in_progress`, `completed`, `blocked`); the runner
  parses the workspace `assignment.md` after every turn and re-invokes
  the agent with a precise list of what's still incomplete.
- **Retries with budget**: configurable per-attempt timeout and per-run
  retry count. Blocked tasks short-circuit the loop.
- **Resumable runs**: every run persists a canonical `run.json`
  manifest plus per-attempt logs. `--resume-run <id>` continues an
  existing run, reuses the backend's session id where supported, and
  can carry forward task statuses and notes.
- **Init then execute**: `task-runner init` prepares the workspace
  without invoking the backend, returns a run id, and `task-runner
  run --resume-run <id>` later picks it up. Useful when an outer
  process wants to compose a run before committing to it.
- **Live status inspection**: `task-runner status <id>` reads the
  manifest and (for in-flight runs) overlays the live workspace
  `assignment.md` so you can see mid-attempt progress without
  attaching to anything.
- **Clean Ctrl+C**: SIGINT aborts the in-flight backend invocation
  cleanly (claude gets SIGINT, codex gets `turn/interrupt`), persists
  the manifest as `aborted`, and exits 130. Resume any time with
  `--resume-run`.
- **External interrupt detection**: when running against codex
  managed mode, if another client cancels the turn from the side
  (e.g. you attached the codex CLI to the same thread), task-runner
  notices and stops cleanly instead of treating it as a failure to
  retry.
- **Import existing sessions**: `--backend-session-id <id>` adopts an
  existing claude session UUID or codex thread id. Validated
  read-only before any workspace creation.
- **Locked fields**: agents and assignments can declare which fields
  the caller is allowed to override. Useful for distributing an
  agent that pins its own model or working directory.
- **Recursion guard**: a hard cap (default 1) on nested
  `task-runner run` invocations, propagated through the env, so an
  orchestrator agent can't accidentally fork-bomb itself.
- **JSON output mode** for scripting: the full manifest as
  pretty-printed JSON, byte-identical to `run.json` on disk.

## Install

Requirements:

- **Node.js 20+**
- **Claude CLI** (`claude`) on your `PATH` if you want to use the
  Claude backend, or set `TASK_RUNNER_CLAUDE_BIN` to point at it.
- **Codex CLI** (`codex`) for stdio mode, or a running codex
  app-server reachable over WebSocket via
  `TASK_RUNNER_CODEX_WS_URL=ws://host:port`.

Build:

```bash
git clone <this-repo>
cd task-runner
npm install
npm run build
```

The CLI is now at `node dist/cli.js`. Either alias it, add the bin
via `npm link`, or invoke it through `npm run task-runner -- ...`.

## Quickstart

```bash
# Run the bundled "example" agent against the bundled "repo-orientation"
# assignment, pointed at any repo:
task-runner run \
  --agent example \
  --assignment repo-orientation \
  --var repo_path=/path/to/some/repo

# Inspect the run after the fact (or during, with live overlay):
task-runner status <run-id>

# Get the full manifest as JSON:
task-runner status <run-id> --output-format json
```

A run produces a workspace at `./.task-runner/<run-id>/` with:

- `run.json` — canonical manifest, written after every attempt
- `assignment.md` — the per-task checklist the agent edits in place
- `attempts/NN.json` — raw per-attempt stdout/stderr capture

The text output looks roughly like:

```
task-runner: agent=example run=abc123
             source=/.../assignments/repo-orientation/assignment.md
             assignment=/.../.task-runner/abc123/assignment.md
             cwd=/path/to/some/repo

── attempt 1 ──
<agent output streams here>

── summary ──
Status: success
Tasks completed: 3/3
Attempts: 1/4
Assignment file: /.../.task-runner/abc123/assignment.md

Task results:
  - t1_read_conventions — Check repo conventions [completed]
      2-space indent; biome for lint/format; tests via node:test.
  - t2_inventory_packages — Inventory top-level packages [completed]
      ...
  - t3_summary — Summary [completed]
      Small TS monorepo for an AI agent runner with two backends.

To continue this run with a follow-up message:
  task-runner run --resume-run abc123 "..."
```

---

## Concepts

### Agents and assignments

A run is the composition of two files:

- **Agent** (`agents/<name>/agent.md`) is the *identity* — backend,
  model, effort level, working directory, role instructions, and
  any locks the agent wants to enforce. Reusable across many
  different work packages.
- **Assignment** (`assignments/<name>/assignment.md`) is the *work* —
  task list, input variables, optional default message, optional
  session display name. Reusable across many different agents.

A minimal agent:

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

A minimal assignment:

```yaml
---
schemaVersion: 1
name: repo-orientation
sessionName: orient {{repo_path}}      # optional display label
maxRetries: 3                          # retry budget per session, default 3
vars:
  repo_path:
    type: string
    required: true
    source: cli
tasks:
  - id: t1_read_conventions
    title: Check repo conventions
    body: |
      Read AGENTS.md and CLAUDE.md (if present). Capture the coding
      style, test requirements, and PR conventions in this task's
      Notes block.
  - id: t2_inventory_packages
    title: Inventory packages
    body: List the top-level packages and what each one does.
---
You are working on the repository at `{{repo_path}}`. Plan at
{{assignment_path}}.
```

Both can be passed by name (resolved against `./agents/<name>/`,
`./assignments/<name>/`, or `$TASK_RUNNER_HOME/...`) or by direct
path. `--assignment` is optional — running an agent with no
assignment is "chat mode" (no enforced task list, just a single
backend invocation).

### Tasks and the workflow

When a run starts, the runner renders the assignment's task list to
the workspace `assignment.md` as a fenced markdown document with one
section per task. Each task section contains a `**Status:**` field
and a `<!-- notes:start --> ... <!-- notes:end -->` block.

The runner injects a workflow preamble into the agent's first prompt
that says, in essence: "for each task, set Status to `in_progress`,
do the work, write your findings into the Notes block, set Status
to `completed`. Use `blocked` if you can't finish; the runner will
stop and surface that to the user instead of retrying."

After every backend invocation, the runner re-reads the workspace
`assignment.md`, parses out the per-task updates, and:

- If every task is `completed` → success, run ends.
- If any task is `blocked` → blocked, run ends, exit code 2.
- If retries are exhausted with incomplete tasks → exhausted, exit 1.
- Otherwise → re-invoke with a nudge listing what's still pending.

Task ids are stable across invocations so retries can address
incomplete work precisely.

### Workspaces and the run manifest

Each run gets a workspace directory at `<cwd>/.task-runner/<run-id>/`
with three things in it:

- **`run.json`** — the canonical record, written at run start,
  rewritten after every attempt, and one final time on terminal
  state. A single JSON document — never JSONL, never append-only —
  so you can `cat` or `jq` it at any moment. Contains the agent
  identity, the assignment metadata, every attempt record, the
  final per-task snapshot, the resolved vars, and the captured
  backend session id.
- **`assignment.md`** — the I/O buffer the agent edits in place. The
  *source* assignment file is never mutated; the runner copies it
  here on a fresh run and re-reads it after every turn.
- **`attempts/NN.json`** — raw per-attempt logs (stdout, stderr,
  start/end timestamps), one per backend invocation. Useful for
  forensics.

The manifest is the load-bearing piece: every other CLI command
(`status`, `run --resume-run`) operates by reading it.

For the full schema and the rationale, see
[`docs/design.md`](docs/design.md).

---

## Commands

### `task-runner run`

Execute an agent. Three modes, distinguished by which flags you pass:

```bash
# Fresh run
task-runner run --agent <name> [--assignment <name>] [options] [message]

# Resume an existing run (sends a follow-up message and/or new tasks)
task-runner run --resume-run <id> [options] [message]

# Execute a previously initialized run (see `init` below)
task-runner run --resume-run <id>
```

Common options:

| Flag | Purpose |
|---|---|
| `--agent <name|path>` | Agent name or direct path. Required for fresh runs; optional on resume (taken from the prior manifest). |
| `--assignment <name|path>` | Assignment name or direct path. Optional on fresh runs. Forbidden on resume. |
| `--var key=value` (repeatable) | Set an input variable. Validated against the assignment's `vars` schema. |
| `--add-task "<title>"` (repeatable) | Append an ad-hoc task with auto-generated id `cli-<short>`. |
| `--cwd <path>` | Override the agent's `cwd`. |
| `--backend <claude|codex>` | Override the agent's backend. Drops the agent's `model` unless `--model` is also passed. |
| `--model <id>` | Override the model. Backend-specific (`claude-sonnet-4-6`, `gpt-5.4`, etc.). |
| `--effort <off|minimal|low|medium|high|xhigh|max>` | Reasoning effort. Mapped per backend. |
| `--max-retries <n>` | Override the per-run retry budget (default 3). |
| `--timeout-sec <n>` | Override the per-attempt timeout (default 3600). |
| `--unrestricted` | Bypass the backend's approval prompts. |
| `--session-name <name>` | Override the assignment's `sessionName` (the backend display label). |
| `--backend-session-id <id>` | Adopt an existing backend session id (claude UUID, codex thread id). Validated before workspace creation. |
| `--output-format <text|json>` | Default `text`. `json` writes the full manifest to stdout once at end of run. |

### `task-runner init`

Prepare a run *without* invoking the backend. Same flags as `run`,
but stops after writing the workspace, manifest (`status:
"initialized"`), and the frozen prompt. Returns the run id; resume
later with `task-runner run --resume-run <id>`.

```bash
task-runner init --agent example --assignment repo-orientation \
  --var repo_path=/some/repo
# task-runner: initialized agent=example run=abc123
#              ...
#              resume with: task-runner run --resume-run abc123
```

Useful when an outer process wants a resumable handle before
committing to execution, or wants to inspect the prepared workspace
before kicking off the actual work.

### `task-runner status`

Read-only inspector. Resolves a run by short id (looked up in
`./.task-runner/`), workspace path, or direct `run.json` path.

```bash
# Human-readable status block + per-task checklist
task-runner status <id>

# Full manifest as JSON
task-runner status <id> --output-format json

# Just the fields you care about
task-runner status <id> --output-format json \
  --field status --field tasksCompleted --field tasksTotal
```

When the resolved manifest's status is `running` (i.e. an attempt is
currently in flight), `status` *also* parses the workspace
`assignment.md` and overlays the live task statuses + notes onto the
output. Both the text checklist and the JSON `finalTasks` /
`tasksCompleted` reflect the agent's mid-attempt edits — useful for
watching long-running attempts without attaching to anything. The
overlay never writes back to disk.

---

## Backends

### Claude

Wraps the `claude` CLI in `--print --output-format stream-json`
mode. Streams partial assistant text to stdout, captures the session
id from the system init event, persists it for resume, and uses
`--resume <id>` to continue. Set `TASK_RUNNER_CLAUDE_BIN` to use a
custom binary.

### Codex

Speaks the codex JSON-RPC app-server protocol in managed mode.
Default transport is stdio (spawns the `codex` CLI as a subprocess);
set `TASK_RUNNER_CODEX_WS_URL=ws://host:port` to connect to a
running app-server over WebSocket instead. Codex over WebSocket has
a useful property: multiple clients can attach to the same thread,
so you can connect with the codex CLI in another terminal and watch
or even interact while task-runner is driving the agent.

If you cancel the turn from another client mid-attempt, task-runner
notices the external interrupt and stops cleanly with status
`aborted` instead of retrying — see [Resuming, aborting,
importing](#resuming-aborting-importing).

The runner sends `thread/start` (or `thread/resume`) at session
start, optionally `thread/name/set` if the assignment provided a
`sessionName`, then `turn/start` for each attempt and `turn/interrupt`
on timeout, abort, or external Ctrl+C.

---

## Resuming, aborting, importing

### Resume

```bash
task-runner run --resume-run <id> "follow-up message"
```

Picks up the prior run from its workspace, normalizes any
non-completed tasks back to `pending` (preserving their notes),
and starts a new session. The first attempt of the new session
sends *only* the follow-up message — the role instructions and task
workflow are not re-rendered, because the backend already has them
cached in the session it's resuming.

`--add-task "<title>"` works alongside (or instead of) a follow-up
message; the runner prepends a short reminder telling the agent
to re-read the workspace `assignment.md`.

### Abort (Ctrl+C)

The first Ctrl+C aborts the in-flight backend invocation cleanly
(claude gets SIGINT, codex gets `turn/interrupt`), the run loop
sets `manifest.status = "aborted"`, persists, and exits 130. The
second Ctrl+C force-exits if the backend doesn't respond. Aborted
runs are fully resumable like any other terminal state.

### External interrupt (codex only)

If you've attached another client to the same codex thread and
cancel the turn from there, codex emits `turn/completed { status:
"interrupted" }` to all attached clients, including task-runner.
The runner detects this case (interrupted with no internal cause)
and stops with status `aborted` instead of treating it as a failure
to retry. You can take over the conversation by hand and then
resume task-runner whenever you're ready.

### Import an existing backend session

```bash
task-runner init --agent <name> [--assignment <name>] \
  --backend-session-id <existing-session-or-thread-id> \
  --cwd /the/cwd/that/session/was/created/under

task-runner run --resume-run <id>
```

Validates the id read-only before any workspace creation:

- **claude**: stats the session JSONL file under
  `~/.claude/projects/<encoded-cwd>/`.
- **codex**: opens the JSON-RPC transport, calls `thread/read`, and
  enforces that the thread's recorded `cwd` matches the cwd you're
  about to operate under. Mismatched cwd is a hard error — codex
  itself allows it but it almost always means the user is confused.

If validation passes, the id is persisted in the manifest and used
as the resume target on the very first invocation. From then on,
the run flows through the existing resume path.

`--backend-session-id` also works on `task-runner run` directly
(without going through `init`) for one-shot import. It is forbidden
with `--resume-run` (the resume target already carries one).

---

## Variables and interpolation

Assignments declare typed input variables in frontmatter:

```yaml
vars:
  repo_path:
    type: string                # string | number | boolean | enum
    required: true              # default false
    source: cli                 # cli | env | either
    envName: REPO_PATH          # only when source includes env
    default: null               # optional fallback
    description: Path to target repo
    sensitive: false            # default false
    values: [a, b, c]           # only for type: enum
```

Vars are passed via repeated `--var key=value` flags (or read from
`process.env[envName]` if the source allows it). They're validated
at run start; missing required vars or type mismatches exit with
code 3 before any backend is invoked.

Interpolation uses `{{key}}` syntax and is applied to the
assignment instructions body, the agent instructions body, the
session name, and any other string field rendered into a
user-visible prompt. In addition to user-declared vars, the runner
injects:

- `{{assignment_path}}` — absolute path to the workspace `assignment.md`
- `{{run_id}}` — short run id
- `{{cwd}}` — resolved absolute working directory

## Locked fields

Either an agent or an assignment can declare a `lockedFields` list.
At run time the two lists are unioned, and any caller-provided
override for a locked field is rejected with `LockedFieldError` and
exit code 3.

Lockable fields:

```
cwd  backend  model  effort  instructions  message  sessionName
timeoutSec  unrestricted  maxRetries  tasks
```

Use this to distribute an agent that pins its own model
(`lockedFields: [model]`), or an assignment with a fixed message
the caller cannot override (`lockedFields: [message]`), or an
agent that refuses to be pointed at any other backend
(`lockedFields: [backend]`).

For the full ownership table and edge cases see
[`docs/design.md`](docs/design.md#locked-fields).

## Output modes

### `--output-format text` (default)

- **stdout**: the agent's text, streamed live during each attempt.
  Between attempts, a divider is printed: `── attempt 2 ──`.
- **stderr**: runner chrome — startup banner, attempt dividers,
  retry notifications, final summary block with per-task results
  and notes.

### `--output-format json`

- **stdout**: the full `RunManifest` as pretty-printed JSON, written
  once at the end of the run. Byte-identical to `run.json` on disk.
- **stderr**: silent.

Makes `task-runner run --agent X --output-format json > result.json`
trivially correct — no filtering, no stream interleaving.

The manifest is always written to `run.json` regardless of output
mode; `--output-format json` only controls whether it's also
printed to stdout.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | All tasks completed successfully (or 0-task chat run succeeded) |
| 1 | Retries exhausted with tasks still incomplete |
| 2 | One or more tasks reported as `blocked` |
| 3 | Config / validation error before any backend was invoked |
| 4 | Backend invocation error (binary not found, spawn failed, etc.) |
| 130 | Run interrupted by user (Ctrl+C) or external cancellation |

## Environment variables

| Var | Purpose |
|---|---|
| `TASK_RUNNER_HOME` | Where named agents/assignments are looked up if not found under `./agents/` / `./assignments/`. Defaults to `~/.task-runner`. |
| `TASK_RUNNER_CLAUDE_BIN` | Path to the `claude` binary. Defaults to `claude` on `PATH`. |
| `TASK_RUNNER_CODEX_BIN` | Path to the `codex` binary for stdio mode. Defaults to `codex` on `PATH`. |
| `TASK_RUNNER_CODEX_WS_URL` | If set, the codex backend connects to this WebSocket URL instead of spawning a stdio subprocess. |
| `TASK_RUNNER_CALL_DEPTH` | Internal: current recursion depth. Set automatically when one task-runner spawns another via the backend env. |
| `TASK_RUNNER_MAX_CALL_DEPTH` | Hard cap on nested task-runner invocations. Default `1` — a top-level run can spawn one nested run, no deeper. Override with `TASK_RUNNER_MAX_CALL_DEPTH=N`. |

## Bundled examples

### Agents

- **`agents/example/`** — repo orientation assistant (Claude).
- **`agents/basic/`** — minimal Claude agent with no special setup.
- **`agents/chat/`** — 0-task Claude "chat mode" agent.
- **`agents/codex-example/`** — Codex equivalent of `example`.
- **`agents/codex-chat/`** — 0-task Codex chat mode agent.
- **`agents/code-reviewer/`** — senior staff engineer tuned for
  deep code review (Codex `gpt-5.3-codex`, high effort,
  unrestricted, severity-tagged findings with file:line citations).
- **`agents/doc-reviewer/`** — senior technical writer tuned for
  documentation review. Same model/effort as code-reviewer but a
  different mindset: drift detection, example runnability,
  completeness, and proposing mermaid diagrams where they'd help.

### Assignments

- **`assignments/repo-orientation/`** — three-task tour for getting
  oriented in any repo. Takes a `repo_path` var.
- **`assignments/repo-diagnostics/`** — two simple shell tasks
  (`pwd`, `date`) used as a smoke test.
- **`assignments/familiarize/`** — eight-task deep onboarding:
  read the primary docs, run `codemap --budget 15000` for a
  compact code map, inventory the directory structure, identify
  entry points, sketch the subsystem map, capture conventions,
  list known unknowns, and run a self-check summary. Designed to
  be the *first* step of a conversation: run this once, then
  follow up in the same session with `--resume-run <id> "your
  real task"` and the agent already has the repo loaded.
- **`assignments/code-review/`** — twelve-task deep code review
  (orientation, architecture, concurrency, error handling, state
  machine, resources, security, types/schema, simplification &
  duplication, test coverage, doc drift, synthesis). Takes a
  `range` var defaulting to `full`; pass any git-style spec
  (`unstaged`, `staged`, `last commit`, `HEAD~3..HEAD`,
  `main..branch`) to scope the review to that range.
- **`assignments/doc-review/`** — twelve-task documentation review
  (inventory, elevator pitch, quickstart, concepts, commands/API
  accuracy, examples, completeness gaps, structure & navigation,
  mermaid diagram proposals, voice consistency, accessibility,
  synthesis). Takes a `repo_path` var, works on any project
  (language-agnostic).

### Running them

```bash
# Load a repo into an agent's context first, then drive it
# conversationally after familiarization finishes.
task-runner run \
  --agent code-reviewer \
  --assignment familiarize \
  --var repo_path=/home/you/path/to/some/project
# ... familiarization tasks complete ...
task-runner run --resume-run <id> "now review the auth layer for security issues"

# Full code review of this repo
task-runner run \
  --agent code-reviewer \
  --assignment code-review \
  --var repo_path=/home/you/path/to/task-runner

# Review just the unstaged changes
task-runner run \
  --agent code-reviewer \
  --assignment code-review \
  --var repo_path=/home/you/path/to/task-runner \
  --var range=unstaged

# Review the last commit
task-runner run \
  --agent code-reviewer \
  --assignment code-review \
  --var repo_path=/home/you/path/to/task-runner \
  --var "range=last commit"

# Full documentation review
task-runner run \
  --agent doc-reviewer \
  --assignment doc-review \
  --var repo_path=/home/you/path/to/some/project
```

## Development

```bash
npm install
npm run build       # tsc -b
npm run test        # builds and runs all node:test suites
npm run lint        # biome check
npm run format      # biome format --write
```

Pre-commit runs `lint-staged` + `biome check` via husky.

Tests are vanilla `node:test`. Backend integration tests use mock
Backend objects to keep them hermetic; the only tests that touch
real subprocesses are a couple of `runProcess` smoke tests against
`/bin/sleep` for the abort path.

## Project layout

```
src/
├── cli.ts                  # CLI entry point and dispatcher
├── cli/parse-args.ts       # argv parser
├── config/                 # frontmatter loaders + zod schemas
├── assignment/             # task model, parser, writer, merge logic
├── backends/
│   ├── types.ts            # Backend interface
│   ├── claude.ts           # Claude subprocess backend
│   ├── codex.ts            # Codex JSON-RPC backend (stdio + ws)
│   └── registry.ts
├── runner/
│   ├── run-loop.ts         # the core runAgent function
│   ├── manifest.ts         # RunManifest types + persistence
│   ├── output.ts           # text rendering helpers
│   ├── recursion-guard.ts  # TASK_RUNNER_CALL_DEPTH safety
│   ├── nudge.ts            # retry-prompt builder
│   └── task-workflow.ts    # injected workflow preamble
└── util/spawn.ts           # subprocess wrapper with abort/timeout

agents/                     # reference agent definitions
assignments/                # reference assignments
docs/design.md              # complete design doc — read this for the deep
                            # rationale, schema details, and edge cases
test/                       # node:test suites
```

For the full design — schema, run lifecycle, manifest format,
locked-field semantics, recursion guard, abort handling, and
everything else — see [`docs/design.md`](docs/design.md).

## License

TBD.

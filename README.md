# task-runner

A small, focused CLI that drives an AI coding agent through a structured
task list, tracks per-task status, and retries until every task is
marked done or blocked.

You write a checklist. `task-runner` hands it to a backend (Claude or
Codex), the agent works through it and updates each task's status in
place, and the runner loops until the agent has accounted for every
task: if any are still `pending` when the agent ends its turn, it gets
re-invoked with a nudge — up to a configurable retry budget. Blocked
tasks halt the run cleanly. Aborted runs (Ctrl+C, external interrupt,
timeout) persist their state and can be resumed later.

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
  - [`task-runner task set` / `task add`](#task-runner-task-set--task-runner-task-add)
- [Backends](#backends)
  - [Claude](#claude)
  - [Codex](#codex)
  - [Passive](#passive)
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

- **Three backends**: Claude (subprocess wrapping `claude --print`),
  Codex (JSON-RPC managed mode over stdio or websocket), and Passive
  (null-object for sidecar flows — `init` + `task set` / `task add`
  only, task-runner never invokes a model).
- **Structured task tracking**: tasks have stable ids and statuses
  (`pending`, `in_progress`, `completed`, `blocked`) that the agent
  updates in place; the runner parses the workspace `assignment.md`
  after every turn and re-invokes with a precise list of what the
  agent hasn't yet marked done. The runner does not independently
  verify work — it trusts the status the agent wrote — so the checklist
  acts as a structured reminder and audit trail, not a proof of
  completion. See [What the checklist does and doesn't do](#what-the-checklist-does-and-doesnt-do).
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
- **Sidecar task mutation**: `task-runner task set` / `task add` let
  an external agent or script drive a run's task list through the CLI
  without task-runner ever invoking a backend. Pair with the
  [Passive backend](#passive) for a first-class sidecar agent that
  rejects `run` entirely and auto-finalizes the manifest to `success`
  or `blocked` once every task reaches a terminal status.
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
  orchestrator agent can't accidentally fork-bomb itself. If the cap
  is hit, the runner exits with a clear error telling you to raise
  `TASK_RUNNER_MAX_CALL_DEPTH` if the nesting is intentional.
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

Build (from the repo root):

```bash
npm install
npm run build
```

The CLI is now at `node dist/cli.js`. Either alias it, add the bin
via `npm link`, or invoke it through `npm run task-runner -- ...`.

## Quickstart

The examples below assume `task-runner` is on your `PATH` (via
`npm link` or a shell alias). If it isn't, substitute `node
dist/cli.js` for `task-runner` in every command.

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

A run progresses through a small state machine; terminal states map
1-to-1 onto process exit codes.

```mermaid
stateDiagram-v2
    [*] --> initialized: task-runner init
    [*] --> running: task-runner run
    initialized --> running: run --resume-run <id>
    running --> running: retry (tasks still pending)
    running --> success: all tasks completed (exit 0)
    running --> exhausted: retries out, tasks incomplete (exit 1)
    running --> blocked: any task blocked (exit 2)
    running --> aborted: Ctrl+C or external interrupt (exit 130)
    running --> error: backend invocation failure (exit 4)
    aborted --> running: run --resume-run <id>
    success --> [*]
    exhausted --> [*]
    blocked --> [*]
    error --> [*]
```

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

#### What the checklist does and doesn't do

The runner trusts the `**Status:**` string the agent writes — it does
not independently verify that a task's work was actually done. What
the structure *does* buy you is that the agent cannot silently skip
an item: every task must be explicitly accounted for (`completed`,
`blocked`, or left `pending` and retried), and the per-task Notes
block captures evidence you can audit after the fact. If you need
harder guarantees, encode them into the task body itself — e.g.,
"run `npm test` and paste the exit code into Notes," or "open the
file at `src/foo.ts` and paste the top-level exports."

One run attempt, from CLI to backend and back:

```mermaid
sequenceDiagram
    participant User
    participant CLI as task-runner run
    participant Runner as run-loop
    participant Backend as Backend adapter
    participant Agent as Agent process
    participant WS as workspace/
    User->>CLI: --agent X --assignment Y
    CLI->>Runner: runAgent(opts)
    Runner->>WS: write assignment.md
    Runner->>WS: write run.json (status=running)
    loop until done or retries exhausted
        Runner->>Backend: invoke(prompt, sessionId)
        Backend->>Agent: spawn / JSON-RPC
        Agent->>WS: edit assignment.md in place
        Agent-->>Backend: turn complete
        Backend-->>Runner: result + new sessionId
        Runner->>WS: parse assignment.md
        alt all tasks completed
            Runner->>WS: run.json (status=success)
        else tasks blocked
            Runner->>WS: run.json (status=blocked)
        else incomplete, retries left
            Runner->>Runner: build nudge message
        else retries exhausted
            Runner->>WS: run.json (status=exhausted)
        end
    end
    Runner-->>CLI: RunOutcome
    CLI-->>User: summary + exit code
```

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
| `--resume-run <id|path>` | Continue an existing run by short id or workspace path. See [Resuming, aborting, importing](#resuming-aborting-importing). |
| `--var key=value` (repeatable) | Set an input variable. Validated against the assignment's `vars` schema. |
| `--add-task "<title>"` (repeatable) | Append an ad-hoc task with auto-generated id `cli-<short>`. |
| `--cwd <path>` | Override the agent's `cwd`. |
| `--backend <claude|codex>` | Override the agent's backend. Drops the agent's `model` unless `--model` is also passed. Forbidden with `--resume-run` (the backend is locked to the session that created the run). |
| `--model <id>` | Override the model. Backend-specific (`claude-sonnet-4-6`, `gpt-5.4`, etc.). |
| `--effort <off|minimal|low|medium|high|xhigh|max>` | Reasoning effort. Mapped per backend. |
| `--max-retries <n>` | Override the per-run retry budget (default 3). |
| `--timeout-sec <n>` | Override the per-attempt timeout (default 3600). |
| `--unrestricted` | Bypass the backend's approval prompts. |
| `--session-name <name>` | Override the assignment's `sessionName` (the backend display label). Vars are interpolated. |
| `--backend-session-id <id>` | Adopt an existing backend session id (claude UUID, codex thread id). Validated before workspace creation. Forbidden with `--resume-run` (the resume target already carries one). |
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

Options:

| Flag | Purpose |
|---|---|
| `--output-format <text|json>` | Default `text`. `json` prints the full manifest as JSON. |
| `--field <name>` (repeatable) | When `--output-format json`, restrict output to these top-level manifest fields. |

When the resolved manifest's status is `running` (i.e. an attempt is
currently in flight), `status` *also* parses the workspace
`assignment.md` and overlays the live task statuses + notes onto the
output. Both the text checklist and the JSON `finalTasks` /
`tasksCompleted` reflect the agent's mid-attempt edits — useful for
watching long-running attempts without attaching to anything. The
overlay never writes back to disk.

### `task-runner task set` / `task-runner task add`

Mutate a run's task list **without invoking the agent**. The canonical
use case is a *sidecar* flow: you have an agent that can't (or
shouldn't) be invoked as a task-runner subprocess, but you still want
it to work through a structured task list. `init` seeds the list, the
external agent reads it via `status`, works each task, and reports
progress back through `task set`.

Both commands:

- Require an existing run (as id or workspace path).
- Are **rejected while the manifest status is `running`** — a live
  backend attempt owns the workspace, and a concurrent CLI write would
  race the attempt's parse/merge cycle. Allowed on `initialized` and
  all terminal states (`success`, `blocked`, `exhausted`, `aborted`,
  `error`).
- Rewrite both the workspace `assignment.md` and `run.json.finalTasks`
  atomically (`status` consumers stay coherent).
- Respect any status/notes edits already present in `assignment.md`
  that aren't yet reflected in the manifest snapshot (they are merged
  in before the CLI mutation is applied, CLI wins on conflict).

```bash
# Mark a task in-progress
task-runner task set <run-id> t1 --status in_progress

# Add a notes block without changing status
task-runner task set <run-id> t1 --notes "Investigating the parser."

# Complete a task with a note in one call
task-runner task set <run-id> t1 --status completed --notes "Done."

# Append a new task to an initialized run
task-runner task add <run-id> --title "Follow-up cleanup"

# JSON output returns the updated task snapshot (handy for scripts)
task-runner task set <run-id> t1 --status completed --output-format json
```

`task set` options:

| Flag | Purpose |
|---|---|
| `--status <s>` | Target status (`pending`, `in_progress`, `completed`, `blocked`). |
| `--notes <text>` | Replacement notes body (replaces, does not append). |
| `--output-format <text\|json>` | Default `text`. `json` prints the updated task snapshot. |

At least one of `--status` / `--notes` must be supplied.

`task add` options:

| Flag | Purpose |
|---|---|
| `--title <text>` (required) | Title for the new task. Non-empty, ≤ 200 chars. |
| `--output-format <text\|json>` | Default `text`. `json` prints the new task snapshot. |

`task add` honors the `tasks` locked field the same way `--add-task`
does on a fresh run: if either the agent or the assignment locks
`tasks`, the command is rejected. Generated ids follow the same
`cli-<short-id>` scheme as `--add-task`.

**Sidecar example.** Drive an initialized run from an external
agent/script without ever invoking a backend through task-runner:

```bash
# 1. Seed the workspace (no backend call)
task-runner init --agent code-reviewer --assignment code-review \
  --var repo_path=. --var range=main..HEAD
# -> prints: task-runner: initialized agent=code-reviewer run=abc123

# 2. External agent asks: "what's left to do?"
task-runner status abc123 --output-format json --field finalTasks

# 3. External agent works task t1 and reports progress
task-runner task set abc123 t1 --status in_progress
# ...agent does the work...
task-runner task set abc123 t1 --status completed --notes "LGTM"

# 4. Optionally add a task the script discovered along the way
task-runner task add abc123 --title "Follow-up: address flakey test"

# 5. Loop until status JSON shows all tasks terminal.
```

For a **non-passive backend** (claude or codex), the run stays in
`initialized` state the whole time and is still fully resumable: if
you later want to hand it to a subprocess agent, `task-runner run
--resume-run abc123` executes it normally. The CLI task commands and
the subprocess execution path compose cleanly.

For a **passive backend** the contract is different: task mutations
*auto-finalize* the manifest (success / blocked / initialized is
re-derived from the task map on every call), and `task-runner run`
is rejected outright. See the [Passive backend](#passive) section
below for the full lifecycle.

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

### Passive

A null-object backend for runs that task-runner will never execute.
Passive agents are driven externally — a script or out-of-process
agent calls `task-runner init` to create the run, reads the task list
and role instructions via `status`, and reports progress back
through `task set` / `task add`. task-runner acts purely as a
structured checklist service, with no LLM involvement.

Declare a passive agent like any other:

```yaml
---
schemaVersion: 1
name: my-passive-agent
backend: passive
lockedFields:
  - backend
---
Role instructions for the external driver (a human reader or the
agent that will run the task list).
```

Passive-specific behavior:

- **`task-runner run` is rejected** on passive agents with a clear
  pointer to `init` and `task set`. Applies to fresh runs and
  `--resume-run` alike.
- **`task-runner init` prints the full bootstrap** — the composed
  agent instructions + assignment context + CLI workflow reminder —
  to **stdout**, so you can pipe it: `task-runner init ... >
  /tmp/brief.txt`. Brief progress lines still go to stderr.
- **`task set` / `task add` auto-finalize** the run. After every
  mutation, the manifest status is re-derived from the task map:
  - any `pending` or `in_progress` task → `initialized`
  - all terminal, at least one `blocked` → `blocked` (exit code 2)
  - all `completed` → `success` (exit code 0)
  
  Self-healing: reopening a completed task or adding a new one on a
  `success` run flips the status back to `initialized`.
- **Locking `backend`** in the agent's `lockedFields` is strongly
  recommended. It prevents callers from overriding the backend at
  `init` time (e.g. `--backend claude`) and turning a passive agent
  into an executable one. The bundled `agents/passive-example/`
  does this.
- **Hidden status fields**: `task-runner status` omits the
  `Attempts:` and `Sessions:` lines for passive runs since they're
  always zero.
- **Re-orient an external driver**: the composed bootstrap is
  persisted in `manifest.pendingPrompt` and never consumed, so an
  agent can refetch it any time with:
  
  ```bash
  task-runner status <run-id> --output-format json --field pendingPrompt
  ```

Sidecar driver loop:

```bash
# 1. Prepare the run (prints the full bootstrap to stdout)
task-runner init --agent passive-example --assignment <work> \
  --var repo_path=. 2>/dev/null > /tmp/brief.txt

# 2. Parse out the run id from the earlier stderr, or from JSON mode:
RUN=$(task-runner init --agent passive-example --assignment <work> \
  --var repo_path=. --output-format json | jq -r .runId)

# 3. Walk the task list (agent-specific logic omitted)
task-runner task set $RUN t1 --status in_progress
# ...do the work...
task-runner task set $RUN t1 --status completed --notes "..."

# 4. When every task is terminal, the run auto-finalizes.
task-runner status $RUN | grep "Status: success"
```

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
- **`agents/chat/`** — 0-task Claude "chat mode" agent. Requires a
  positional message — with no agent body, no assignment, and no
  tasks, there's nothing else to prompt with.
- **`agents/codex-example/`** — Codex equivalent of `example`.
- **`agents/codex-chat/`** — 0-task Codex chat mode agent.
- **`agents/code-reviewer/`** — senior staff engineer tuned for
  deep code review (Codex `gpt-5.3-codex`, high effort,
  unrestricted, severity-tagged findings with file:line citations).
- **`agents/doc-reviewer/`** — senior technical writer tuned for
  documentation review. Same model/effort as code-reviewer but a
  different mindset: drift detection, example runnability,
  completeness, and proposing mermaid diagrams where they'd help.
- **`agents/passive-example/`** — sidecar-only agent with
  `backend: passive` and `lockedFields: [backend]`. task-runner
  never invokes it; callers use `init` to seed the workspace and
  `task set` / `task add` to drive the checklist externally. See
  [Passive backend](#passive).

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

Subsystem boundaries: the run loop is the center of gravity; backends
are swappable, persistence is a flat workspace directory.

```mermaid
flowchart TD
    subgraph CLI["CLI layer"]
        cli["cli.ts"]
        parse["cli/parse-args.ts"]
    end
    subgraph Config["Config"]
        loader["config/loader.ts"]
        schema["config/schema.ts"]
        interp["config/interpolate.ts"]
    end
    subgraph Runner["Runner"]
        loop["runner/run-loop.ts"]
        manifest["runner/manifest.ts"]
        nudge["runner/nudge.ts"]
        workflow["runner/task-workflow.ts"]
        guard["runner/recursion-guard.ts"]
        output["runner/output.ts"]
    end
    subgraph Assignment["Assignment I/O"]
        parser["assignment/parser.ts"]
        writer["assignment/writer.ts"]
        merge["assignment/merge.ts"]
    end
    subgraph Backends["Backends"]
        registry["backends/registry.ts"]
        claude["backends/claude.ts"]
        codex["backends/codex.ts"]
    end
    subgraph Workspace[".task-runner/&lt;run-id&gt;/"]
        runjson["run.json"]
        assignmd["assignment.md"]
        attempts["attempts/NN.json"]
    end
    cli --> parse
    cli --> loop
    cli --> manifest
    cli --> output
    loop --> loader
    loop --> registry
    loop --> writer
    loop --> parser
    loop --> merge
    loop --> nudge
    loop --> workflow
    loop --> guard
    loop --> manifest
    loop --> Workspace
    registry --> claude
    registry --> codex
```

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
└── util/
    ├── spawn.ts            # subprocess wrapper with abort/timeout
    └── short-id.ts         # 6-char base32 run id generator

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

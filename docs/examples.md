# Bundled examples

The repo ships with a handful of agent and assignment definitions under
`agents/` and `assignments/` that double as references and as useful
tools you can run against any repo.

## Agents

- **`agents/example/`** — repo orientation assistant (Claude).
- **`agents/basic/`** — minimal Claude agent with no special setup.
- **`agents/chat/`** — 0-task Claude "chat mode" agent. Requires a
  positional message — with no agent body, no assignment, and no
  tasks, there's nothing else to prompt with.
- **`agents/codex-example/`** — Codex equivalent of `example`.
- **`agents/codex-chat/`** — 0-task Codex chat mode agent.
- **`agents/code-reviewer/`** — senior staff engineer tuned for deep
  code review (Codex `gpt-5.3-codex`, high effort, unrestricted,
  severity-tagged findings with file:line citations).
- **`agents/doc-reviewer/`** — senior technical writer tuned for
  documentation review. Same model/effort as code-reviewer but a
  different mindset: drift detection, example runnability,
  completeness, and proposing mermaid diagrams where they'd help.
- **`agents/passive-example/`** — sidecar-only agent with
  `backend: passive` and `lockedFields: [backend]`. task-runner never
  invokes it; callers use `init` to seed the workspace and `task set`
  / `task add` to drive the checklist externally. See
  [backends.md#passive](backends.md#passive).

## Assignments

- **`assignments/repo-orientation/`** — three-task tour for getting
  oriented in any repo. Takes a `repo_path` var.
- **`assignments/repo-diagnostics/`** — two simple shell tasks (`pwd`,
  `date`) used as a smoke test.
- **`assignments/familiarize/`** — eight-task deep onboarding: read
  the primary docs, run `codemap --budget 15000` for a compact code
  map, inventory the directory structure, identify entry points,
  sketch the subsystem map, capture conventions, list known unknowns,
  and run a self-check summary. Designed to be the *first* step of a
  conversation: run this once, then follow up in the same session with
  `--resume-run <id> "your real task"` and the agent already has the
  repo loaded.
- **`assignments/code-review/`** — fourteen-task deep code review
  (orientation, architecture, concurrency, error handling, state
  machine, resources, security, types/schema, simplification &
  duplication, test coverage, doc drift, plan coverage, synthesis,
  approval). Takes a `range` var defaulting to `full`; pass any
  git-style spec (`unstaged`, `staged`, `last commit`, `HEAD~3..HEAD`,
  `main..branch`) to scope the review to that range. Also accepts an
  optional `implementation_plan` var pointing at a task-runner
  workspace `assignment.md`; when set (typically from a
  `plan-feature`-driven implementer run) the reviewer verifies every
  planned task actually shipped and flags silent deferrals. The final
  `approval` task is an explicit ship / no-ship decision: runs that
  approve exit `success` (code 0); runs where the reviewer cannot
  approve exit `blocked` (code 2), so scripts can gate on the terminal
  status directly.
- **`assignments/plan-feature/`** — meta-assignment that turns a
  free-form feature description into an executable task-runner plan.
  Takes a `repo_path` var; the feature brief comes in as the
  positional message body so it is not length-limited. The planner
  surveys conventions, impact, reuse opportunities, and risks; copies
  a template from the configured task-runner config root into the
  repo-name drafts area under `${TASK_RUNNER_STATE_DIR}/drafts/`;
  fills in every placeholder with concrete file-level detail; runs a
  nested `plan-review` pass against the draft and planning workspace;
  then hands the caller the exact `task-runner init ...` command to
  run. Both the planner run and the generated implementation run
  require `TASK_RUNNER_MAX_CALL_DEPTH=2`: the planner nests
  `plan-review`, and the generated implementation plan nests
  `code-review`.
- **`assignments/plan-review/`** — six-task draft-plan review for
  `plan-feature`. It reads the generated draft assignment plus the
  planner's own workspace `assignment.md`, checks contract fidelity,
  task quality, workflow wiring, and handoff clarity, then ends with
  an explicit `approval` gate. Runs exit `success` only when the draft
  is ready to hand back to the caller; otherwise they exit `blocked`
  so the planner can revise and request a delta re-review.
- **`assignments/doc-review/`** — twelve-task documentation review
  (inventory, elevator pitch, quickstart, concepts, commands/API
  accuracy, examples, completeness gaps, structure & navigation,
  mermaid diagram proposals, voice consistency, accessibility,
  synthesis). Takes a `repo_path` var, works on any project
  (language-agnostic).

## Running them

```bash
# Load a repo into an agent's context first, then drive it
# conversationally after familiarization finishes.
task-runner run \
  --agent ./agents/code-reviewer/agent.md \
  --assignment ./assignments/familiarize/assignment.md \
  --var repo_path=/home/you/path/to/some/project
# ... familiarization tasks complete ...
task-runner run --resume-run <id> "now review the auth layer for security issues"

# Full code review of this repo
task-runner run \
  --agent ./agents/code-reviewer/agent.md \
  --assignment ./assignments/code-review/assignment.md \
  --var repo_path=/home/you/path/to/task-runner

# Review just the unstaged changes
task-runner run \
  --agent ./agents/code-reviewer/agent.md \
  --assignment ./assignments/code-review/assignment.md \
  --var repo_path=/home/you/path/to/task-runner \
  --var range=unstaged

# Review the last commit
task-runner run \
  --agent ./agents/code-reviewer/agent.md \
  --assignment ./assignments/code-review/assignment.md \
  --var repo_path=/home/you/path/to/task-runner \
  --var "range=last commit"

# Full documentation review
task-runner run \
  --agent ./agents/doc-reviewer/agent.md \
  --assignment ./assignments/doc-review/assignment.md \
  --var repo_path=/home/you/path/to/some/project
```

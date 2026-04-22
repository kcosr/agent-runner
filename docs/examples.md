# Examples

This repo ships a small library of reusable agents and assignments under
`agents/` and `assignments/`. Every one is a plain markdown file you can
copy, read, or pass directly via `--agent` / `--assignment`.

## Bundled agents

### `implementer`

- Path: `agents/implementer/agent.md`
- Backend: `codex` (model `gpt-5.4`, `effort: high`, `unrestricted: true`)

Senior staff engineer persona. Reads code deeply, cites file paths and
line numbers, follows repo conventions, and prefers first-attempt
lint/build/test-passing changes. Records concrete evidence in task notes
and marks infeasible tasks as `blocked` rather than silently adapting.

### `planner`

- Path: `agents/planner/agent.md`
- Backend: `codex` (`unrestricted: true`)

Gathers feature requirements, identifies ambiguity along contract
dimensions (CLI, API, schema, UI, refactoring), scans for reusable code,
and produces concrete plans with ordered tasks, dependencies, risks, and
validation steps. Designed to drive the `plan-feature` assignment.

### `code-reviewer`

- Path: `agents/code-reviewer/agent.md`
- Backend: `claude` (model `claude-opus-4-6`, `effort: high`,
  `unrestricted: true`)

Review-only persona. Produces severity-tagged findings
(`[SEVERITY] file:line — title`) with observation, rationale, and
suggested fix. Calibrates severity, treats duplication and simplification
as first-class findings, and never edits files.

### `doc-reviewer`

- Path: `agents/doc-reviewer/agent.md`
- Backend: `codex` (model `gpt-5.3-codex`, `effort: high`,
  `unrestricted: true`)

Documentation reviewer. Reads as a skeptical new contributor. Flags
drift, non-runnable examples, and code/doc mismatches; promotes
actively-misleading claims to `CRITICAL`. Proposes ready-to-paste
mermaid blocks only where they genuinely help.

### `test`

- Path: `agents/test/agent.md`
- Backend: `codex` (`unrestricted: true`)

Minimal validation agent used for smoke-checking the runtime.

## Bundled assignments

### `repo-orientation`

- Path: `assignments/repo-orientation/assignment.md`

Lightweight onboarding: check repo conventions (AGENTS.md, CLAUDE.md,
testing/PR conventions), inventory top-level packages, and produce a
short summary. Good pairing with `implementer` or `planner` when
starting work in an unfamiliar repo.

### `familiarize`

- Path: `assignments/familiarize/assignment.md`

Deep orientation pass designed as preparation work — the notes are
scratch space for the agent, not a user-facing deliverable. Runs
codemap (if installed), inventories directory structure, maps
subsystems, captures conventions, and explicitly lists unknowns. Ends
with a self-check gate.

### `test`

- Path: `assignments/test/assignment.md`

Minimal smoke assignment: runs `date` and `pwd`. Useful for validating
installation, wiring, or a new agent/backend combination.

### `plan-feature`

- Path: `assignments/plan-feature/assignment.md`
- `maxRetries: 4`, `lockedFields: [tasks]`

Meta-assignment that converts a free-form feature brief into an
executable task-runner plan. The driver agent orients, captures the
feature, checks contract dimensions (with an ambiguity gate), surveys
impact, scans for duplication, assesses risks, produces a contract
artifact, drafts a plan from a template, runs a nested `plan-review`,
applies fixes until approval, produces a human-facing summary, attaches
both artifacts to the planning run, blocks on caller approval for
delayed implementer creation, and emits generated implementation plans
that end with a terminal `push_branch_and_create_pr` task.

Notable feature uses:

- **Ambiguity gate**: `capture_feature` blocks the run with targeted
  questions when contract dimensions are unresolved.
- **Locked task list** prevents silent deferrals.
- **Nested reviews** via `plan-review` invoked as a child `task-runner
  run`.
- **Attachment coupling**: approved draft (`assignment-seed.md`) and
  summary are attached to the planning run and later discovered by
  implementation via `attachment list --scope family`.
- **Lineage-backed inheritance**: planner-created child runs auto-link to
  the planning run and can inherit vars such as `worktree_path` through
  `sources: [parent]` instead of repeating `--var`.
- **Approval-gated delayed creation**: the planning run prepares the
  draft/summary/handoff first, then blocks on
  `create_implementer_run_after_approval` until the caller resumes the
  same run with approval.
- **Backend-accurate handoff**: after delayed `init`, the caller
  inspects `run brief <new-run-id>` and then executes the initialized
  implementer run with `run --resume-run <new-run-id>`.
- **Terminal publish step**: generated implementation plans end with
  `push_branch_and_create_pr`, which records branch/push/PR evidence as
  part of the normal successful workflow.

### `plan-review`

- Path: `assignments/plan-review/assignment.md`
- Vars:
  - `plan_draft` (string, required) — absolute path to the draft
    assignment file being reviewed.
  - `planning_run_id` (string, required) — canonical run id whose task
    notes carry the brief, contract, assumptions, and evidence.

Nested review assignment for `plan-feature`. Checks contract fidelity,
task graph structure, task-id/verifiability, and workflow wiring.
Produces a synthesis and an explicit approval decision in the
`approval` task — exit code 0 signals approval, exit code 2 signals
blocked. On resume, performs a delta-focused re-review rather than a
full re-walk. Review checks now also cover the `sources` var model and
descendant worktree inheritance wiring.

### `code-review`

- Path: `assignments/code-review/assignment.md`
- Vars:
  - `range` (string, optional, default `full`) — git range to review
    (`full`, `unstaged`, `staged`, `last commit`, `HEAD~N..HEAD`,
    `main..<branch>`, etc.).
  - `implementation_run_id` (string, required) — implementation run
    whose task state the reviewer cross-checks.

Structured 14-dimension review with an explicit ship / no-ship
decision. Covers architecture, concurrency, error handling, state
machine, resources, security, type safety, simplification/duplication,
test coverage, documentation accuracy, and plan coverage. Produces a
top-findings synthesis and an approval task whose exit code carries the
decision. On resume, performs a delta re-review over the prior findings
and recent changes rather than a full re-walk.

### `doc-review`

- Path: `assignments/doc-review/assignment.md`

Documentation review across inventory, elevator pitch, quickstart
runnability, conceptual clarity, commands/flags accuracy, examples,
completeness, structure, diagrams, voice, and accessibility. Produces a
top-findings synthesis. Can delegate independent dimensions to
subagents for parallelism.

## Common pairings

| Agent | Typical assignment | Notes |
|-------|-------------------|-------|
| `planner` | `plan-feature` | Produces an executable plan and a summary; uses nested `plan-review` and blocks for caller approval before delayed implementer creation. |
| `implementer` | generated plan assignment | Created by `plan-feature` after approval; inspect `run brief` and then execute with `run --resume-run`. |
| `code-reviewer` | `plan-review` or `code-review` | Nested review surfaces (both assignments). |
| `doc-reviewer` | `doc-review` | Review-only, writes no files. |
| any | `repo-orientation` / `familiarize` | Quick or deep onboarding before other work. |
| any | `test` | Smoke-check for installation or a new agent/backend combination. |

## Special features in use

- **Ambiguity gate** — `plan-feature` `capture_feature` task.
- **Approval-gated creation** — `plan-feature` keeps the planning run
  blocked until the caller resumes it with approval to create the
  implementer run.
- **Backend-accurate execution handoff** — after delayed `init`, callers
  inspect `run brief` and then execute the initialized implementer run
  with `run --resume-run` instead of assuming a passive-only workflow.
- **Locked tasks** — `plan-feature` template locks the task list so
  executors cannot silently drop or reorder tasks.
- **Dependencies** — planning → implementation → code-review workflows
  link runs with `run add-dep`.
- **Attachments as handoff** — planning artifacts attached to the
  planning run and later discovered via `attachment list --scope family`.
- **Multiple delta re-reviews** — `plan-review` and `code-review` both
  switch into delta mode on resume.
- **Subagent delegation** — `plan-feature`, `code-review`, `doc-review`,
  `familiarize` allow independent tasks to be parallelized while
  synthesis tasks stay in the main context.

## Using a bundled definition

```bash
task-runner run \
  --agent ./agents/implementer/agent.md \
  --assignment ./assignments/repo-orientation/assignment.md
```

Or with bare names if you've installed them under
`${TASK_RUNNER_CONFIG_DIR}`:

```bash
task-runner run --agent implementer --assignment repo-orientation
```

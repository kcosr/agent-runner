# Examples

This repo ships a small library of reusable agents, assignments, and
shared task definitions under `agents/`, `assignments/`, and `tasks/`.
Every agent and assignment is a plain markdown file you can copy, read,
or pass directly via `--agent` / `--assignment`.

These definitions are shaped to this project's own development workflow,
and several perform real side effects — creating git worktrees, pushing
branches, opening pull requests, merging after approval. Read an agent
or assignment before you run it, and copy it as a starting point for a
definition of your own rather than assuming it matches your workflow.

Bundled agents use built-in backends. Agents can also select a custom
backend by name and provide backend-owned `backendConfig.<name>` plus
separate `backendArgs.<name>.extraArgs` tokens. Custom backend modules
live under `${AGENT_RUNNER_CONFIG_DIR}/backends/<backend-name>/` and are
trusted local code, not sandboxed plugin packages.

## Bundled agents

### `generic`

- Path: `agents/generic/agent.md`
- Backend: `codex` (model `gpt-5.5`, `effort: high`, `unrestricted: true`)

No role instructions. Use this agent when the assignment should own the
full workflow prompt and the agent should only provide runtime settings.

### `implementer`

- Path: `agents/implementer/agent.md`
- Backend: `codex` (model `gpt-5.5`, `effort: high`, `unrestricted: true`)

Senior staff engineer persona. Reads code deeply, cites file paths and
line numbers, follows repo conventions, and prefers first-attempt
lint/build/test-passing changes. Records concrete evidence in task notes
and marks infeasible tasks as `blocked` rather than silently adapting.

### `planner`

- Path: `agents/planner/agent.md`
- Backend: `codex` (model `gpt-5.5`, `effort: high`, `unrestricted: true`)

Gathers feature requirements, identifies ambiguity along contract
dimensions (CLI, API, schema, UI, refactoring), scans for reusable code,
and produces concrete plans with ordered tasks, dependencies, risks, and
validation steps. Designed to drive the `plan-feature` assignment.

### `code-reviewer`

- Path: `agents/code-reviewer/agent.md`
- Backend: `claude` (model `claude-opus-4-7`, `effort: xhigh`,
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
- `maxRetries: 4`

Meta-assignment that converts a free-form feature brief into an
executable agent-runner plan. The driver agent orients, captures the
feature, checks contract dimensions (with an ambiguity gate), surveys
impact, scans for duplication, assesses risks, produces a contract
artifact, drafts a plan from a template, runs a nested `plan-review`,
applies fixes until approval, produces a human-facing summary, attaches
both artifacts to the planning run, initializes a separate implementer
run, and emits generated implementation plans that end with a terminal
`push_branch_and_create_pr` task.

Notable feature uses:

- **Shared planning tasks**: the initial planning pass uses named refs
  under `tasks/feature-plan/` from `feature-plan/orient` through
  `feature-plan/surface-inventory`; the draft/review/init pipeline stays
  inline so the planner can fill placeholders.
- **Locked generated task list** prevents silent deferrals in the
  implementation assignment produced by the planner.
- **Nested reviews** via `plan-review` invoked as a child `agent-runner
  run`.
- **Attachment coupling**: approved draft (`assignment-seed.md`) and
  summary are attached to the planning run and later discovered by
  implementation via `attachment list --scope group`.
- **Lineage-backed inheritance**: planner-created child runs auto-link to
  the planning run and can inherit vars such as `worktree_path` and
  `worktree_base_ref` through `sources: [parent]` instead of repeating
  `--var`.
- **Configurable implementation base ref**: `worktree_base_ref` defaults
  to `origin/main`, but callers can override it for pre-merge
  end-to-end tests that should create generated implementation worktrees
  from another ref.
- **Separate implementer run**: the planning run creates or refreshes an
  initialized implementer run from the approved draft and leaves it for
  the caller to inspect and promote with `run ready`.
- **Backend-accurate handoff**: after `init`, the caller
  inspects `run brief <new-run-id>` and then executes the initialized
  implementer run with `run --resume-run <new-run-id>`.
- **Terminal publish step**: generated implementation plans end with
  `push_branch_and_create_pr`, which records branch/push/PR evidence as
  part of the normal successful workflow.

### `plan-implement-feature`

- Path: `assignments/plan-implement-feature/assignment.md`
- `maxRetries: 4`, `lockedFields: [tasks]`

Single-run feature workflow for smaller changes. It composes the shared
`tasks/feature-plan/*` and `tasks/feature-implement/*` named task
definitions in one run: plan, render and attach `assignment-summary.md`,
block for user approval, then implement in the same task state after
resume.

This flow deliberately skips the heavyweight handoff pieces:

- It does not generate `assignment-seed.md`.
- It does not run `plan-review`.
- It does not create a separate initialized implementer run.

The `assignment-summary.md` artifact uses the same
`assignments/plan-feature/summary-template.md` template as
`plan-feature`; the run's planning Notes remain the canonical execution
contract for the implementation tasks.

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

Implementation-run review with an explicit ship / no-ship decision.
Requires `implementation_run_id`, checks the implementation run's task
state for plan coverage, and reuses the shared `review/...` task
definitions for architecture, concurrency, error handling, state
machine, resources, security, type safety, simplification/duplication,
test coverage, and documentation accuracy. Produces a top-findings
synthesis and an approval task whose exit code carries the decision. On
resume, performs a delta re-review over the prior findings and recent
changes rather than a full re-walk.

### `code-review-direct`

- Path: `assignments/code-review-direct/assignment.md`
- Vars:
  - `range` (string, optional, default `full`) — git range to review
    (`full`, `unstaged`, `staged`, `last commit`, `HEAD~N..HEAD`,
    `main..<branch>`, etc.).

Direct/user/Web UI code review for work that is not tied to an
implementation run. It has no `implementation_run_id`, no plan-coverage
task, and no lineage attachment lookup. It reuses the same shared
`review/...` dimension tasks as `code-review`, then produces a direct
synthesis and approval decision.

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
| `planner` | `plan-feature` | Produces an executable plan and a summary; uses nested `plan-review` and creates an initialized implementer run for caller approval. |
| `generic` | `plan-implement-feature` | Single-run plan, approval pause, implementation, review, and PR flow using assignment-owned hybrid instructions and shared feature tasks. |
| `implementer` | generated plan assignment | Created by `plan-feature` after approval; inspect `run brief` and then execute with `run --resume-run`. |
| `code-reviewer` | `plan-review`, `code-review`, or `code-review-direct` | Nested and direct review surfaces. |
| `doc-reviewer` | `doc-review` | Review-only, writes no files. |
| any | `repo-orientation` / `familiarize` | Quick or deep onboarding before other work. |
| any | `test` | Smoke-check for installation or a new agent/backend combination. |

## Special features in use

- **Ambiguity gate** — shared `feature-plan/capture-feature` task.
- **Approval-gated single-run implementation** — `plan-implement-feature`
  attaches `assignment-summary.md`, blocks in
  `feature-plan/await-user-approval`, and continues implementation in the
  same run after explicit approval.
- **Backend-accurate execution handoff** — after `init`, callers
  inspect `run brief` and then execute the initialized implementer run
  with `run --resume-run` instead of assuming a passive-only workflow.
- **Locked tasks** — `plan-feature` template locks the task list so
  executors cannot silently drop or reorder tasks.
- **Dependencies** — planning → implementation → code-review workflows
  link runs with typed `run add-dep --run` or `run add-dep --group`
  dependencies.
- **Attachments as handoff** — planning artifacts attached to the
  planning run and later discovered via `attachment list --scope group`.
- **Multiple delta re-reviews** — `plan-review`, `code-review`, and
  `code-review-direct` switch into delta mode on resume.
- **Subagent delegation** — `plan-feature`, `code-review`,
  `code-review-direct`, `doc-review`, and `familiarize` allow
  independent tasks to be parallelized while synthesis tasks stay in the
  main context.

## Using a bundled definition

```bash
agent-runner run \
  --agent ./agents/implementer/agent.md \
  --assignment ./assignments/repo-orientation/assignment.md
```

Or with bare names if you've installed them under
`${AGENT_RUNNER_CONFIG_DIR}`:

```bash
agent-runner run --agent implementer --assignment repo-orientation
```

## Skills

`skills/` holds skills for the coding agent that drives agent-runner —
not agent-runner definitions themselves:

- `agent-runner-seed-plan-run` — seeds a `plan-feature` run
- `agent-runner-seed-plan-implement-run` — seeds a `plan-implement-feature` run

Copy them into your coding agent's skills directory (for example
`~/.agents/skills/`) to use them. Like the bundled agents and assignments,
they are examples — read and adapt them to your own setup.

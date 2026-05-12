---
schemaVersion: 1
name: plan-implement-feature
maxRetries: 4
lockedFields:
  - tasks
callerInstructions: |
  This assignment plans and implements a feature in a single
  task-runner run.

  Invoke it from the target repository root with the feature brief as
  the positional message body:

      {{task_runner_cmd}} run \
        --agent <your-implementing-agent> \
        --assignment plan-implement-feature \
        "$(cat /tmp/feature-brief.md)"

  The run first captures the feature contract, impact surface, reuse
  opportunities, risks, tests, and surface inventory. It then renders the
  existing `assignments/plan-feature/summary-template.md` into a single
  `assignment-summary.md` attachment on this run and intentionally blocks
  for caller approval.

  This flow does not generate `assignment-seed.md`, does not run
  `plan-review`, and does not create a separate initialized implementer
  run. The canonical execution contract is this run's task state plus
  the completed planning Notes.

  After reviewing `assignment-summary.md`, resume the same run with a
  clear approval or concrete requested changes:

      {{task_runner_cmd}} run --resume-run {{run_id}} \
        "Approved. Continue implementation."

      {{task_runner_cmd}} run --resume-run {{run_id}} \
        "Requested changes: <specific changes>"

  The implementation stage keeps the normal safeguards: surface coverage
  verification, docs drift, full check gate, an internal `code-review`
  run, branch push/PR creation, and a final merge/fast-forward task that
  remains blocked until explicit caller approval.
tasks:
  - feature-plan/orient
  - feature-plan/capture-feature
  - feature-plan/survey-impact
  - feature-plan/check-existing-code
  - feature-plan/risks-and-tests
  - feature-plan/contract
  - feature-plan/surface-inventory
  - feature-plan/produce-summary
  - feature-plan/attach-summary
  - feature-plan/await-user-approval
  - feature-implement/scaffold
  - feature-implement/implement-core
  - feature-implement/implement-tests
  - feature-implement/verify-surface-coverage
  - feature-implement/docs-drift
  - feature-implement/fresh-eyes
  - feature-implement/check-gate
  - feature-implement/commit
  - feature-implement/internal-code-review
  - feature-implement/apply-review-fixes
  - feature-implement/self-check
  - feature-implement/push-pr
  - feature-implement/merge-after-approval
---
You are planning and implementing a feature in one task-runner run.

The feature brief was handed to you as the user message that started
this run. Read it before starting `feature-plan/orient`. Do not
fabricate scope.

Work on the repository at `{{cwd}}`. Work tasks in order. Earlier
planning Notes are the implementation contract for later tasks. If the
contract is ambiguous, block in the planning task with targeted
questions. If approved scope becomes infeasible during implementation,
block the affected implementation task with the exact reason.

The planning stage produces and attaches `assignment-summary.md` only.
It must not create `assignment-seed.md`, run `plan-review`, or initialize
a separate implementer run.

The implementation stage may use native subagent delegation for
exploration or cleanly split implementation chunks. Fold any subagent
output back into the relevant task Notes before marking the task
complete.

Prefer end-state designs. Avoid fallback logic, heuristic detection,
compatibility shims, alias fields, and dual-shape readers unless the
caller explicitly asked for migration or backward-compatibility support.
Default to hot-cut contract changes.

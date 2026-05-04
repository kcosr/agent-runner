---
schemaVersion: 1
name: plan-review
vars:
  initialized_run_id:
    type: string
    required: true
    sources: [cli, web]
    description: Initialized implementer run id whose frozen task state is being reviewed.
  planning_run_id:
    type: string
    required: true
    sources: [cli, web]
    description: |
      Canonical planning run id whose task notes and group attachments
      carry the feature brief, contract, assumptions, summary, and
      assignment seed.
callerInstructions: |
  This run reviews an initialized implementer run before it is
  handed back to the caller for `run ready`. It is typically
  launched as a nested review from `plan-feature`, but it can
  also be run directly against any initialized-run/planning-run
  pair.

  The initialized implementer run is the canonical execution
  object. Planning-run `assignment-seed.md` and
  `assignment-summary.md` attachments are supporting audit and
  human-review artifacts; use group-scoped attachment listing to
  discover them from the initialized run.

  The final decision lives in `approval.notes`. Exit semantics
  match the code reviewer: `success` (code 0) means the
  initialized run is approved for handoff; `blocked` (code 2)
  means the planner must refresh the planning artifacts,
  reinitialize the same initialized run, and resume this same
  review run for a delta pass.

      {{task_runner_cmd}} run status {{run_id}} --output-format json \
        --field tasks | jq -r '.tasks[] | select(.id=="approval") | .notes'

  On resume, inspect the current initialized run and refreshed
  group attachments again before deciding whether prior findings
  are resolved.
tasks:
  - id: orient_inputs
    title: Load initialized run and planning artifacts
    body: |
      Treat run `{{initialized_run_id}}` as the canonical
      execution object. Read it and the planning evidence before
      reviewing anything, saving the outputs in
      `/tmp/task-runner-plan-review-{{run_id}}` for later review
      tasks to reuse:

          mkdir -p /tmp/task-runner-plan-review-{{run_id}}
          {{task_runner_cmd}} run inspect {{initialized_run_id}} > /tmp/task-runner-plan-review-{{run_id}}/initialized-inspect.txt
          {{task_runner_cmd}} run status {{initialized_run_id}} --output-format json > /tmp/task-runner-plan-review-{{run_id}}/initialized-status.json
          {{task_runner_cmd}} run status {{planning_run_id}} --output-format json --field tasks > /tmp/task-runner-plan-review-{{run_id}}/planning-tasks.json
          {{task_runner_cmd}} attachment list {{initialized_run_id}} --scope group --output-format json > /tmp/task-runner-plan-review-{{run_id}}/group-attachments.json

      In `group-attachments.json`, find rows whose `name` is
      `assignment-seed.md` and `assignment-summary.md`. Download
      each one using that row's `ownerRunId` plus that row's `id`:

          {{task_runner_cmd}} attachment download <ownerRunId> <id> /tmp/task-runner-plan-review-{{run_id}}/

      Do not infer ownership from the initialized run id. Group
      attachments commonly belong to the planning run, and the
      download command must use the row owner.

      If either artifact is missing, keep reviewing the initialized
      run and mark this task `blocked` only when the missing artifact
      prevents a faithful review. Otherwise record the missing item
      as review context.

      Summarize in Notes:
        - initialized run id, lifecycle status, effective status,
          cwd, run group, and display name
        - the feature the initialized run claims to implement
        - high-level task shape from the initialized run's tasks
        - whether `assignment-seed.md` and `assignment-summary.md`
          were found and downloaded, including each row's
          `ownerRunId`, `id`, and local download path
        - planning evidence from the planning run task notes

      This is context for the rest of the review, not a findings
      section.
  - id: review_contract_fidelity
    title: Review contract fidelity and scope discipline
    body: |
      Compare the initialized implementer run against the planning
      evidence and downloaded artifacts. The initialized run's
      frozen task state and brief are canonical for execution; the
      downloaded `assignment-seed.md` and `assignment-summary.md`
      are supporting evidence.

      Compare:
        - planning run task notes from `planning-tasks.json`
        - initialized run orient/feature context and task bodies
        - downloaded `assignment-summary.md`
        - downloaded `assignment-seed.md`
        - worker brief from `initialized-inspect.txt`
        - caller instructions from `initialized-status.json` or
          `initialized-inspect.txt`

      Look for:
        - feature brief details that disappeared or drifted
        - contract fields, flags, outputs, error cases, or
          assumptions that were captured by the planner but are
          missing or weakened in the initialized run
        - Surface Inventory entries captured by the planner but
          missing or weakened in the initialized run, including
          symmetric peers or removal twins
        - an explicit "no surfaces" inventory when the captured
          contract plainly introduces, modifies, or removes
          user-facing flags, routes, config keys, UI controls, or
          documented public surfaces
        - new scope added by the initialized run that the planning
          evidence does not justify
        - shared-path changes that test only the new behavior while
          omitting representative existing sibling behaviors flowing
          through the same parser, dispatcher, request/response
          builder, state reducer, serializer, config loader,
          lifecycle/workflow handler, database access layer, UI state
          transition, or other reused infrastructure
        - instructions that quietly add fallback logic, heuristics,
          alias fields, bridge routes, or compatibility layers even
          though the planning evidence called for a hot cut

      A meaningful drift between planning notes, summary, seed,
      initialized run state, run brief, or caller instructions is a
      finding. A change that weakens the contract or sneaks in
      compatibility machinery the plan did not call for is HIGH
      severity.
  - id: review_task_structure
    title: Review initialized task graph, ids, and verifiability
    body: |
      Walk every task in the initialized run's `RunDetail.tasks`
      order. Do not review a construction file as the source of
      truth; the initialized run's task state is what will execute.

      Check for:
        - semantic task ids that describe the work, rather than
          numeric prefixes or opaque labels
        - task ordering that matches the dependency chain
        - required workflow tasks still present when applicable:
          orient or scaffold preflight, check_gate, fresh-eyes
          simplification, commit, internal_review, docs_drift,
          self_check, and push_branch_and_create_pr
        - the scaffold/setup task explicitly requires the
          implementer to confirm the inherited `repo_root`,
          `worktree_slug`, `worktree_path`, and `worktree_base_ref`
          values, ensure the repo root is clean before execution,
          and verify that the assignment's first-attempt hooks create
          or reuse the target worktree from the inherited
          `worktree_base_ref` and fast-forward/merge to that same ref
          before backend work begins
        - every code-bearing task has a concrete `**Done when:**`
          block with test-backed completion criteria
        - code-bearing tasks that change a shared path include
          preservation tests for representative existing sibling
          behaviors, or explicitly justify that existing coverage is
          already sufficient
        - every task body has concrete file paths, commands, or
          evidence requirements rather than vague placeholders
        - no `<<PLACEHOLDER>>` markers remain anywhere in the
          initialized task bodies, caller instructions, or brief
        - the generated implementation workflow includes a Surface
          Inventory block in orientation and a later task that
          verifies each inventory entry's declaration/parser,
          consumer, and integration test evidence
        - the internal review task launches the bundled
          `code-review` assignment from the initialized run worktree
          and passes:

              --var implementation_run_id={{initialized_run_id}}

        - check-gate commands match the target repo's required
          build, lint, test, and full-check commands
        - docs-drift coverage exists when user-facing behavior,
          commands, assignments, or docs change

      A placeholder left in the initialized run, a code-bearing task
      with no meaningful Done when block, a missing first-attempt
      worktree/setup preflight, or an id scheme that encodes array
      position instead of meaning is a finding.
  - id: review_workflow_and_handoff
    title: Review workflow wiring and caller handoff
    body: |
      Review initialized run state, planning artifacts, and handoff
      instructions for workflow correctness.

      Verify the initialized run:
        - status is `initialized`, not `ready` or already executed
        - inherited vars include `repo_root`, `worktree_slug`,
          `worktree_path`, and `worktree_base_ref` with source
          metadata showing parent inheritance where expected
        - cwd is the intended target worktree path
        - run group matches the planning run group so group
          attachments are discoverable
        - brief matches the initialized tasks and tells the worker
          to use the task CLI for progress
        - caller instructions point the human at `run inspect`,
          group attachments, `run brief`, `run ready`, and
          `run --resume-run`
        - dependencies, schedule, backend, model, launcher, and
          unrestricted mode match the plan

      Verify the generated implementation workflow:
        - descendant vars use `sources: [parent]` for inherited
          worktree or lineage values instead of old singular
          `source` / `either` contracts or manual `--var`
          repetition
        - first-attempt hooks use the inherited worktree values
          instead of recomputing them inside task prose
        - `apply_review_fixes` is guarded with a task-local
          `require-children-success` hook or equivalent native
          `taskTransition` hook with `requireAny: true`
        - internal review keeps the reviewer in the same worktree
          with `--cwd {{cwd}}` and uses a short descriptive `--name`
        - the implementation workflow ends with
          `push_branch_and_create_pr` and requires concrete branch,
          push, and PR evidence

      Verify the planning workflow and attachments:
        - the planning run owns or still exposes
          `assignment-seed.md` and `assignment-summary.md` through
          group-scoped attachment listing
        - downloaded attachment rows used explicit `ownerRunId` plus
          row `id`
        - artifacts were not duplicated onto the initialized run just
          to simplify review
        - if caller feedback arrives after the first initialized run,
          the fix loop updates the temp assignment and summary,
          removes/replaces planning-run attachments, reinitializes
          the same initialized implementer run with
          `init --run-id <implementer-run-id>`, then resumes this
          same review run for a delta pass
        - handoff tells the caller to review group attachments and
          the initialized implementer run before promoting with
          `run ready`

      Missing or incorrect workflow wiring is usually HIGH severity
      because it causes the caller or implementer to fail even if the
      task list itself looks sound.
  - id: synthesis
    title: Top findings synthesis
    body: |
      Read back through the notes you wrote on
      `review_contract_fidelity`, `review_task_structure`, and
      `review_workflow_and_handoff`, then build a ranked list of the
      top findings.

      Include:
        - top findings ordered by severity
        - one sentence on whether the initialized run is close to
          ready or needs significant revision
        - a one-sentence recommendation: approve or block

      If there are no real issues, say so plainly rather than
      padding the review.
  - id: approval
    title: Final initialized-run approval decision
    body: |
      This task is the gate. `completed` means "this initialized
      run is ready to hand back to the caller." `blocked` means
      "the planner must revise artifacts, reinitialize the same run,
      and resume this review."

      Mark this task `blocked` if any of the following are true:
        - any HIGH or CRITICAL finding from the review is still open
        - the synthesis recommendation is "block"
        - you are unsure whether the initialized run faithfully
          captures the feature contract or workflow

      Mark this task `completed` only if all of the following hold:
        - every HIGH / CRITICAL finding is resolved or explicitly
          declined with written justification
        - the synthesis recommendation is "approve"
        - you would stand behind this initialized run being handed
          back to the caller as the execution plan

      Write one of these decision records verbatim in Notes:

      Approval:

          APPROVED for handoff.
          Rationale: <one to three sentences on why the initialized run meets the bar.>
          Residual findings: <open MEDIUM/LOW items or "none".>

      Block:

          BLOCKED - cannot approve.
          Unresolved: <bulleted list of the specific open conditions, each
            citing the underlying finding.>
          Path to approval: <short, concrete instructions on what the planner
            must revise, refresh, reinitialize, or hand off.>
---

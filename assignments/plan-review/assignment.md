---
schemaVersion: 1
name: plan-review
sessionName: plan review · {{repo_path}}
vars:
  repo_path:
    type: string
    required: true
    source: cli
    description: Absolute path to the repository the reviewed plan targets.
  plan_draft:
    type: string
    required: true
    source: cli
    description: Absolute path to the draft assignment file being reviewed.
  planning_workspace:
    type: string
    required: true
    source: cli
    description: |
      Absolute path to the planner run's workspace `assignment.md`,
      which contains the captured brief, contract, assumptions, and
      planning evidence the draft should reflect.
callerInstructions: |
  This run reviews a draft implementation plan before it is
  handed back to the caller. It is typically launched as a
  nested review from `plan-feature`, but it can also be run
  directly against any draft-plus-planning-workspace pair.

  The final decision lives in `approval.notes`. Exit semantics
  match the code reviewer: `success` (code 0) means the draft is
  approved for handoff; `blocked` (code 2) means the planner must
  revise the draft and resume this same review run for a delta
  pass.

      {{task_runner_cmd}} status {{run_id}} --output-format json \
        --field finalTasks | jq -r '.[] | select(.id=="approval") | .notes'

  The planner should read both `synthesis` and `approval`, apply
  the fixes it agrees with, then resume this same run with a
  follow-up message describing what changed in the draft.
tasks:
  - id: orient_inputs
    title: Load the draft and planning artifacts
    body: |
      Read both review inputs in full:

          {{plan_draft}}
          {{planning_workspace}}

      First, confirm the files exist and are readable. If either
      one is missing or obviously not a task-runner assignment,
      mark this task `blocked` with the exact path and problem.

      Then summarize in Notes:
        - what feature the draft claims to implement
        - the draft's task shape at a high level
        - the feature brief / contract / assumptions captured in
          the planning workspace

      This is context for the rest of the review, not a finding
      section.
  - id: review_contract_fidelity
    title: Review contract fidelity and scope discipline
    body: |
      Compare the draft against the planner's captured evidence in
      `{{planning_workspace}}`.

      Look for:
        - feature brief details that disappeared or drifted
        - contract fields, flags, outputs, error cases, or
          assumptions that were captured by the planner but are
          missing or weakened in the draft
        - new scope added by the draft that the planning evidence
          does not justify
        - instructions that quietly add fallback logic,
          heuristics, alias fields, bridge routes, or
          compatibility layers even though the planning evidence
          called for a hot cut

      A draft that silently changes the contract, weakens it, or
      sneaks in compatibility machinery the plan did not call for
      is a HIGH-severity finding.
  - id: review_task_structure
    title: Review task graph, ids, and verifiability
    body: |
      Walk every task in `{{plan_draft}}`.

      Check for:
        - semantic task ids that describe the work, rather than
          numeric prefixes or opaque labels
        - task ordering that matches the dependency chain
        - required workflow tasks still present when applicable:
          orient, check gate, fresh-eyes pass, commit,
          internal review, docs drift, self-check, final_commit
        - every code-bearing task has a concrete `**Done when:**`
          block with test-backed completion criteria
        - every task body has concrete file paths, commands, or
          evidence requirements rather than vague placeholders
        - no `<<PLACEHOLDER>>` markers remain anywhere in the draft

      A placeholder left in the draft, a code-bearing task with no
      meaningful `Done when:`, or an id scheme that encodes array
      position instead of meaning are all findings.
  - id: review_workflow_and_handoff
    title: Review workflow wiring and caller handoff
    body: |
      Review both the draft and the planner workspace for workflow
      correctness.

      In the draft, verify:
        - the internal review step passes
          `implementation_plan={{assignment_path}}` so the code
          reviewer sees the implementer workspace
        - the draft explains the recursion-depth requirement for
          the nested code-review run

      In the planning workspace, verify:
        - the planner instructs the caller to run init manually
          instead of initializing the implementer run itself
        - the init command hard-codes `--agent implementer`
        - the handoff tells the caller how to run the resulting
          implementer run and where the new run id comes from
        - the draft-review loop itself is reflected accurately in
          the planner tasks and handoff notes

      Missing or incorrect workflow wiring is usually HIGH
      severity because it causes the caller or implementer to
      fail even if the task list itself looks sound.
  - id: synthesis
    title: Top findings synthesis
    body: |
      Read back through the notes you wrote on
      `review_contract_fidelity`, `review_task_structure`, and
      `review_workflow_and_handoff`, then build a ranked list of
      the top findings.

      Include:
        - the top findings ordered by severity
        - one sentence on whether the draft is close to ready or
          needs significant revision
        - a one-sentence recommendation: approve or block

      If there are no real issues, say so plainly rather than
      padding the review.
  - id: approval
    title: Final draft approval decision
    body: |
      This task is the gate. `completed` means "this draft is
      ready to hand back to the caller." `blocked` means "the
      planner must revise the draft and rerun review."

      Mark this task `blocked` if any of the following are true:
        - any HIGH or CRITICAL finding from the review is still open
        - the synthesis recommendation is "block"
        - you are unsure whether the draft faithfully captures the
          feature contract or workflow

      Mark this task `completed` only if all of the following hold:
        - every HIGH / CRITICAL finding is resolved or explicitly
          declined with written justification
        - the synthesis recommendation is "approve"
        - you would stand behind this draft being handed back to
          the caller as the plan to execute

      Write one of these decision records verbatim in Notes:

      Approval:

          APPROVED for handoff.
          Rationale: <one to three sentences on why the draft meets the bar.>
          Residual findings: <open MEDIUM/LOW items or "none".>

      Block:

          BLOCKED — cannot approve.
          Unresolved: <bulleted list of the specific open conditions, each
            citing the underlying finding.>
          Path to approval: <short, concrete instructions on what the planner
            must revise in the draft or handoff.>
---
You are reviewing a task-runner draft assignment, not the
implementation code itself. Treat `{{repo_path}}` as context for
the repo the draft targets, but the primary review artifacts are:

  - `{{plan_draft}}`
  - `{{planning_workspace}}`

Do not modify any file under `{{repo_path}}`, `{{plan_draft}}`, or
`{{planning_workspace}}`. The only file you should write is your
own workspace plan at `{{assignment_path}}`.

Work the tasks in order. Earlier tasks establish the contract and
workflow context the later tasks depend on.

Each finding in a task's notes block should use this format:

    [SEVERITY] file:line — short title
      Observation: ...
      Why it matters: ...
      Suggested fix: ...

Severity tags range from NIT → LOW → MEDIUM → HIGH → CRITICAL.

If this run is resumed after the planner updates the draft, do a
focused delta pass:

1. Re-read your prior findings and prior `approval` notes.
2. Inspect what changed in `{{plan_draft}}` and, if relevant, in
   `{{planning_workspace}}`.
3. For each prior finding, decide whether it is resolved, still
   open, or only partially addressed.
4. Scan the updated draft for any new issues introduced by the
   revisions.
5. Rewrite `synthesis` as a delta review, then re-evaluate
   `approval` from scratch against the current draft.

Do not delegate the synthesis or approval tasks. Those judgment
calls need to stay in your own context.

---
schemaVersion: 1
id: feature-plan/await-user-approval
title: Await user approval before implementation
---
**Category**: process

This task is the intentional planning-to-implementation pause for the single-run flow.

On the initial pass, immediately mark this task `blocked` after `assignment-summary.md` has been attached. Notes must tell the caller:
  - the `assignment-summary.md` attachment id from `feature-plan/attach-summary`
  - that no `assignment-seed.md` was generated
  - that no `plan-review` run was launched
  - that no separate implementer run was initialized
  - the exact command to inspect attachments:

        {{task_runner_cmd}} attachment list {{run_id}}

  - the exact resume shape for approval or requested changes:

        {{task_runner_cmd}} run --resume-run {{run_id}} "Approved. Continue implementation."
        {{task_runner_cmd}} run --resume-run {{run_id}} "Requested changes: <specific changes>"

On resume, read the caller's latest message carefully:
  - If the caller clearly approved implementation, record the approval text in Notes and mark this task `completed`.
  - If the caller requested changes, revise the affected planning task Notes, regenerate and reattach `assignment-summary.md`, then mark this task `blocked` again with the new attachment evidence.
  - If the caller response is ambiguous, keep this task `blocked` with up to three targeted questions.

Do not proceed to implementation tasks unless approval is explicit.

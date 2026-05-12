---
schemaVersion: 1
id: feature-plan/attach-summary
title: Attach the summary artifact to this run
---
**Category**: process

Attach the summary file produced by `feature-plan/produce-summary` to this run as exactly:

    assignment-summary.md

Use:

    {{task_runner_cmd}} attachment add {{run_id}} <summary-path> --name assignment-summary.md
    {{task_runner_cmd}} attachment list {{run_id}}

If you are re-running this task after revising the summary, remove any older `assignment-summary.md` attachments first so the run ends with one current copy.

Do not attach `assignment-seed.md`. Do not attach artifacts to a separate implementer run; this flow does not create one.

Completion Notes must include the summary path, the attachment id, the exact add/list commands, their exit codes, and the final attachment listing.

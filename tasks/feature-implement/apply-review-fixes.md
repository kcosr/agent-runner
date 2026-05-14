---
schemaVersion: 1
id: feature-implement/apply-review-fixes
title: Apply agreed review fixes and request delta re-review
hooks:
  - builtin: require-children-success
    with:
      requireAny: true
---
**Category**: hybrid

Work through the findings from `feature-implement/internal-code-review`:
  - For each finding you agree with, implement the
    fix here. Cite the file:line you edited in Notes.
  - For each finding you disagree with, write a
    short justification in Notes explaining why.
    The reviewer accepts caller decisions and will
    not re-flag declined findings on the delta pass.
  - For each **plan-coverage** finding, either
    implement the missing scope or explicitly
    document why the deferral is acceptable. Silent
    plan deferrals are the exact failure mode the
    plan-coverage task is defending against.

After applying fixes, resume the review run for a
delta pass:

    {{agent_runner_cmd}} run --resume-run <review-run-id> \
      "Fixes applied. <one-line summary per prior finding>."

The reviewer does a focused delta pass, not a full
re-walk. **Iterate until the review run's terminal
status is `success`** — that is the reviewer's
approval gate, and the only signal that the change
is cleared to ship. Check after each delta pass:

    {{agent_runner_cmd}} run status <review-run-id> --output-format json \
      --field status

If it still returns `blocked`, read the updated
`approval` decision record for the new "Path to
approval" list, apply the remaining fixes, and
resume again. Do not mark this task `completed`
until the review run hits `success`.

Paste the final delta synthesis and the final
(APPROVED) `approval` decision record into this
task's Notes, replacing the earlier (BLOCKED)
versions. The audit trail of earlier passes lives
in the review run itself; this task's Notes should
reflect the final state.

If a finding legitimately needs more discussion than
a one-shot exchange supports, it is fine to resume
the review multiple times. A review that takes three
delta passes to converge is better than one that
shipped with unaddressed critical findings. If after
several passes the reviewer still refuses to approve
and you disagree with the remaining blockers, mark
**this** task `blocked` with an explanation — do not
fake an approval by editing the review's `approval` block
directly. The caller escalates from there.

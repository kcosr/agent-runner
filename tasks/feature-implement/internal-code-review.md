---
schemaVersion: 1
id: feature-implement/internal-code-review
title: Internal code review via agent-runner
---
**Category**: process

**Preflight: finalize every prior task.** The reviewer
will read this run's canonical task state via
`implementation_run_id={{run_id}}`, and its
plan-coverage task consumes exactly what you have written
into those task notes. Before
launching the reviewer:

  1. Inspect this run with
     `{{agent_runner_cmd}} run status {{run_id}} --output-format json --field tasks`
     and scan every task above this one.
  2. Every prior task must have status `completed`.
     If a prior task is still `in_progress`, `pending`,
     or `blocked`, fix that first — either by actually
     finishing the work and updating the status, or by
     escalating the blocker.
  3. Every prior task must have a non-empty Notes block
     with **concrete evidence** of what was done: file
     paths for code-bearing tasks, exit codes for check-
     gate tasks, one-line summaries for fresh-eyes
     tasks. Placeholder text, empty notes, and single-
     word summaries like "Done." will be flagged by the
     reviewer as silent deferrals.
  4. Do not launch the reviewer against a half-finished
     workspace. A wasted review cycle is worse than a
     delayed one.

Once every prior task is finalized, launch the bundled
`code-review` assignment as a nested `{{agent_runner_cmd}} run`,
passing this plan's run id as the implementation context:

    {{agent_runner_cmd}} run \
      --agent code-reviewer \
      --assignment code-review \
      --name "<same-short-topic-name>" \
      --cwd {{cwd}} \
      --var "range=<review-range>" \
      --var implementation_run_id={{run_id}}

Substitute `<review-range>` with the
appropriate git-range spec for the changes you
produced (e.g. `HEAD~N..HEAD`, `main..HEAD`, or
`staged`). The `implementation_run_id` var points the
reviewer at this plan so it can cross-check that
every planned task actually shipped — that is what
the reviewer's plan-coverage task consumes.

Keep `--cwd {{cwd}}` on the nested review command so the
reviewer inspects the same checkout this run used, without
recomputing the repository path.

Use the same short topic label the caller used when they
initialized this run:
  - first word capitalized
  - target 2-4 words and about 32 characters or less
  - omit redundant words already covered by the assignment
    such as `Review` or `Implementation`
  - never include cwd paths, repo names, or git ranges

The review produces its own agent-runner run with its
own run id. Capture that review run id in this task's
Notes immediately after launching. Once the review
finishes, check its **terminal status** first — not
just its synthesis:

    {{agent_runner_cmd}} run status <review-run-id> --output-format json \
      --field status

The code-review assignment has a final `approval`
task that gates ship/no-ship, and the run's exit code
reflects it:
  - `status: "success"` → reviewer approved. Proceed.
    There may still be MEDIUM/LOW findings the
    reviewer flagged for your attention, but nothing
    is HIGH or CRITICAL-severity blocking.
  - `status: "blocked"` → reviewer could NOT approve.
    This is the expected first-pass outcome when any
    HIGH / CRITICAL finding or plan-coverage gap
    exists. Treat it as a normal delta cycle, not a
    failure.

Pull the synthesis and the approval decision record:

    {{agent_runner_cmd}} run status <review-run-id> --output-format json \
      --field tasks | jq -r '.tasks[] | select(.id=="synthesis") | .notes'

    {{agent_runner_cmd}} run status <review-run-id> --output-format json \
      --field tasks | jq -r '.tasks[] | select(.id=="approval") | .notes'

Paste the reviewer's top-findings synthesis and the
`approval` decision record into this task's Notes
— raw, not summarized. If the reviewer flagged plan-
coverage findings, call them out explicitly: they are
the ones that say "the plan promised X but the diff
does not contain X." If `approval` is BLOCKED, copy its
"Path to approval" list here so
`feature-implement/apply-review-fixes` knows exactly what must be
fixed.

This nested agent-runner invocation consumes one level
of nested review (implementer → reviewer). If the
review launch is rejected by recursion policy, block
and surface that to the caller instead of continuing.

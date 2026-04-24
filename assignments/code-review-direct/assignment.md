---
schemaVersion: 1
name: code-review-direct
vars:
  range:
    type: string
    required: false
    sources: [cli, web]
    default: full
    description: |
      What scope to review. One of:
        - `full`                        — entire codebase (default)
        - `unstaged`                    — `git diff` (working tree)
        - `staged`                      — `git diff --cached`
        - `last commit`                 — `git show HEAD`
        - `HEAD~N..HEAD`                — N commits back to HEAD
        - `main..<branch>`              — branch divergence
        - any other git range spec      — passed through to git
callerInstructions: |
  This run produces a structured direct code review in the task
  notes, gated by an explicit ship / no-ship decision at the end.
  Use it for user-launched or Web UI reviews that are not tied to
  an implementation run.

  The reviewer's synthesis in `synthesis.notes` is the ranked
  top-findings list. Each shared review task (`review/architecture`,
  `review/concurrency`, ..., `review/docs-drift`) carries the raw
  findings for its dimension with severity tags. The final decision
  lives in `approval.notes`.

  **Exit code carries the decision.** The run exits `success`
  (code 0) only if the reviewer approved the direct review target in
  `approval`; `blocked` (code 2) means the reviewer could not
  approve and a delta pass is needed after fixes. Scripts should gate
  on the terminal status, not on the existence of a synthesis block.
tasks:
  - id: orient
    title: Direct review orientation and scope resolution
    body: |
      First, understand the project. Read the high-signal entry
      points for the repository at `{{cwd}}`:
        - AGENTS.md, CLAUDE.md, CONTRIBUTING.md at the repo root
        - README.md
        - Build manifest (package.json, Cargo.toml, go.mod,
          pyproject.toml, etc.) for scripts, dependencies, and
          language toolchain
        - docs/ directory (design docs, architecture notes)
        - Primary entry-point files (`src/cli.ts`, `main.rs`,
          `main.go`, `src/index.*`, or what the build manifest
          points at)

      Second, resolve the review scope from `range = "{{range}}"`:
        - If `range` is `full`, the scope is the whole codebase.
          Proceed through the review-dimension tasks with the whole
          codebase in mind.
        - If `range` is a git-style spec (`unstaged`, `staged`,
          `last commit`, `HEAD~N..HEAD`, `main..branch`, or any
          other phrase), translate it to a concrete git invocation
          and identify the exact set of files and hunks that changed.
          Run the appropriate command:
            - `unstaged`        -> `git diff`
            - `staged`          -> `git diff --cached`
            - `last commit`     -> `git show HEAD`
            - a git range spec  -> `git diff <spec>`
          Capture the list of touched files. For the rest of the
          review, also read each touched file in full (not just the
          diff) so you can judge the change in context.

      Third, state explicitly in Notes that this is a direct/ad hoc
      review. There is no implementation run, no `implementation_run_id`,
      no planning lineage, and no plan-coverage pass in this assignment.

      Notes: a 5-10 line summary of what the project is, its major
      modules, whether this is full-codebase or ranged, and -- if scoped --
      the concrete set of files and hunks under review. This is context for
      the rest of the review, not a finding section.
  - review/architecture
  - review/concurrency
  - review/error-handling
  - review/state-machine
  - review/resources
  - review/security
  - review/types-schema
  - review/simplification-and-duplication
  - review/test-coverage
  - review/docs-drift
  - id: synthesis
    title: Direct review synthesis
    body: |
      Now read back through the notes from the review-dimension tasks
      (`review/architecture` through `review/docs-drift`) and build a
      single ranked list of the **top 10 highest-leverage findings** from
      the direct review. Order by severity (CRITICAL first, then HIGH,
      MEDIUM, LOW) and within a severity by impact. Each entry must
      reference the original finding's file:line so the reader can jump
      back.

      If you found fewer than 10 real issues, list the real ones and stop.
      Padding the list with NITs is not a synthesis.

      Also include:
        - One sentence on the project's overall health
        - The single highest-leverage refactor (if any) that would make
          several findings disappear at once
        - A one-sentence ship / ship-with-changes / block recommendation.
          Required for every review. For ranged reviews, this answers
          "should this change land?" For full-codebase reviews, this
          answers "would you ship this codebase as-is if a maintainer
          asked you to tag a release right now?" Use exactly one of the
          three outcomes.
  - id: approval
    title: Direct review ship / no-ship decision
    body: |
      This task is the gate. It is not a synthesis, a summary, or an
      end-of-run checkbox -- it is a decision with a consequence.
      `completed` means "I approve this direct review target for ship."
      `blocked` means "I cannot approve; halt cleanly for a delta pass."
      Both are first-class outcomes; neither is a failure of the review.
      The run's exit code carries this decision (0 on approved, 2 on
      blocked), so scripts and callers will gate on it.

      **Lead with the blocked case.** If any of the following are true,
      mark this task `blocked` with a short Notes block explaining which
      condition held and stop:

        - Any HIGH or CRITICAL finding from the review-dimension tasks is
          unresolved in the current diff or codebase.
        - The `synthesis` recommendation is "block" or "ship with
          changes" -- both mean more work is required.
        - You were unable to trace a finding deeply enough to judge whether
          it is real. Uncertainty blocks.

      **Completion criteria.** Only mark this task `completed` if all of
      the following hold:

        - Every HIGH / CRITICAL finding is either resolved in the current
          diff/codebase or explicitly declined by the caller upstream with a
          written justification.
        - The `synthesis` recommendation is "ship."
        - You personally would stand behind this change or codebase landing
          on the main branch as-is. If you would not, block.

      **Write-in requirement.** Whether you approve or block, paste a
      one-paragraph decision record into this task's Notes block. Use these
      formats verbatim so downstream scripts can grep them:

      Approval:

          APPROVED for ship.
          Rationale: <one to three sentences on why the work meets the bar.>
          Residual findings: <file:line references to any open MEDIUM/LOW
            items the caller chose to accept, or "none".>

      Block:

          BLOCKED -- cannot approve.
          Unresolved: <bulleted list of the specific conditions above that
            held, each citing file:line for the underlying finding.>
          Path to approval: <short, concrete instruction on what would flip
            this to approved in a delta pass -- which findings must be fixed
            or declined with justification.>

      Do not delegate this task to a subagent. The approval decision must
      live in the main reviewer's own context.
---
You are reviewing the repository at `{{cwd}}` with scope
`{{range}}`. Treat `{{cwd}}` as the root for everything you
read. Do not modify any file inside that repo. Use the task CLI as
the task interface for this run; do not rely on workspace files.

Work the tasks in order. Earlier tasks build context the later
ones depend on. The synthesis task at the end pulls from your
accumulated notes, so be specific in each task's notes block.

A dimension with no real issues produces no findings in that
task. Say "No issues found in this dimension" and move on.
Padding the review to look thorough is worse than a short honest
review.

**Delegating via subagents.** For a large review, you may
delegate independent review dimensions to subagents to parallelize,
for example running the concurrency review and the security review
as separate subagents while you continue other dimensions. Do not
delegate `orient`, `synthesis`, or `approval`; all three depend on
your own accumulated context and, in the case of `approval`, on a
judgment call that cannot be outsourced.

When a subagent returns, fold its findings into the task's Notes
block in the same severity/format used by the rest of the review so
the synthesis pass sees a consistent shape. Delegation is optional;
for a small or ranged review, working the tasks yourself is usually
faster.

**Re-review after agreed-upon fixes.** If this run is resumed with
a follow-up message asking you to re-check your prior findings, do
not re-walk all 13 tasks from scratch. Instead:

1. Re-read your prior notes on `review/architecture` through
   `review/docs-drift`, plus `synthesis`. Those are your original
   findings and synthesis. Also re-read the prior `approval`
   decision record if it exists.
2. Inspect what has changed in the repository since your prior
   review. You are in a resumed session with full context of your
   previous findings, so figure out what moved: new commits on the
   branch, unstaged edits, or a widened scope. Do not assume the
   original `range` spec is still stable. Use `git log`,
   `git status`, `git diff`, and the commit history from your first
   pass to orient yourself to the actual delta between the review
   you already did and the current working tree.
3. For each prior finding, decide whether it is resolved, partially
   resolved, not addressed, or explicitly declined by the caller.
4. Scan the new changes for any new issues introduced by the fixes
   themselves. Hold these to the same severity bar as the original
   review.
5. Write the delta as a fresh synthesis into `synthesis`'s Notes
   block, replacing the prior synthesis. Include findings resolved,
   findings still open, new findings introduced by the fixes, and a
   one-sentence ship, ship-with-changes, or block recommendation.
6. Leave the Notes on `review/architecture` through
   `review/docs-drift` as the original audit trail and put the delta
   in `synthesis` only.
7. Re-evaluate `approval` against the post-fix state. If every
   HIGH/CRITICAL finding is now resolved or was explicitly declined
   with justification and the synthesis recommendation is "ship",
   mark `approval` `completed` with a fresh approval decision record.
   Otherwise, mark it `blocked` again with an updated reason and
   expect another delta pass.

---
schemaVersion: 1
name: code-review
vars:
  repo_root:
    type: string
    required: false
    sources: [parent]
    description: |
      Optional inherited repo root from the parent implementation
      run when this review is launched by a lineage-aware plan.
  worktree_slug:
    type: string
    required: false
    sources: [parent]
    description: |
      Optional inherited worktree slug from the parent
      implementation run when present.
  worktree_path:
    type: string
    required: false
    sources: [parent]
    description: |
      Optional inherited worktree path from the parent
      implementation run when present.
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
  implementation_run_id:
    type: string
    required: true
    sources: [cli, web]
    description: |
      Canonical task-runner run id for the implementation run
      being reviewed. The reviewer reads the implementation run's
      canonical task state and attachments by run id for the
      plan-coverage pass.
callerInstructions: |
  This run produces a structured code review in the task notes,
  gated by an explicit ship / no-ship decision at the end. Read
  the findings, implement the fixes you agree with, then resume
  this same run for a delta re-review. The reviewer's synthesis
  in `synthesis.notes` is the ranked top-findings list; each
  individual task (`review/architecture`, `review/concurrency`, ...,
  `review/docs-drift`, `plan_coverage`) carries the raw findings for its
  dimension with severity tags. The final decision lives in
  `approval.notes`.

  **Exit code carries the decision.** The run exits `success`
  (code 0) only if the reviewer approved the change in `approval`;
  `blocked` (code 2) means the reviewer could not approve and
  a delta pass is needed after fixes. The first call will
  almost always exit blocked — that is the expected contract,
  not a failure. Scripts should gate on the terminal status,
  not on the existence of a synthesis block. The approval
  decision record in `approval.notes` follows a fixed
  format (`APPROVED for ship` or `BLOCKED -- cannot approve`)
  so you can grep it directly:

      {{task_runner_cmd}} run status {{run_id}} --output-format json \
        --field tasks | jq -r '.tasks[] | select(.id=="approval") | .notes'

  This review expects `--var implementation_run_id=<run-id>`.
  The reviewer verifies that every task in the referenced
  implementation run actually landed in the diff under review.
  Silent deferrals and dropped review fixes are flagged at
  HIGH/CRITICAL severity, and any unresolved HIGH/CRITICAL from
  the plan-coverage pass blocks `approval`.

  When this run is launched from a lineage-aware implementation
  plan, `repo_root`, `worktree_slug`, and `worktree_path` may be
  inherited automatically from the parent run. The bundled
  implementation workflow also passes `--cwd {{cwd}}` so git
  inspection stays rooted in the same sibling worktree.

  ## Reviewing findings

  Pull the full review:

      {{task_runner_cmd}} run status {{run_id}}                         # human-readable
      {{task_runner_cmd}} run status {{run_id}} --output-format json    # machine-readable

  Each finding in a task's notes block follows this format:

      [SEVERITY] file:line — short title
        Observation: ...
        Why it matters: ...
        Suggested fix: ...

  Severity tags range from NIT → LOW → MEDIUM → HIGH → CRITICAL.
  Not every finding requires a fix. The reviewer has been
  calibrated to surface real issues (including "no issues found in
  this dimension" as a valid answer), so feel free to be
  selective: decline findings that are out of scope for your
  current change, pre-existing issues you've already triaged, or
  ones you genuinely disagree with.

  ## Implementing fixes

  Apply the changes you agree with, run your normal check
  pipeline (tests, lint, build), and commit. Keep the diff small
  and targeted — a focused fix commit is easier to delta-review
  than a sprawling one.

  ## Requesting a delta re-review

  After implementing fixes, resume this same run with a follow-up
  message that tells the reviewer what you did:

      {{task_runner_cmd}} run --resume-run {{run_id}} "<your follow-up>"

  The follow-up message should cover, for each prior finding:
    - **resolved** — cite the file:line or commit of the fix so
      the reviewer can verify it landed correctly
    - **declined** — explain why the finding isn't worth
      addressing (out of scope, disagree with framing, etc.)
    - **deferred** — if you agree but are tracking it for a
      follow-up branch, say so

  Any context that matters for the delta pass — pre-existing bugs
  you're leaving alone, design decisions you made along the way,
  scope limitations — should also go in the follow-up.

  The reviewer has been instructed to do a **focused delta pass**
  on resume, not a full 14-task re-walk. It will verify each prior
  finding's resolution status, scan for any new issues the fixes
  may have introduced, rewrite the `synthesis` task with a "Delta
  review" structure, and re-evaluate `approval` from scratch
  against the post-fix state. Tasks `review/architecture` through
  `review/docs-drift`, plus `plan_coverage`, retain their original
  findings as the audit trail from the first pass, so you can
  always see how findings evolved across rounds. The `approval`
  block preserves the prior decision in its Notes history, so you
  can see what blocked the previous pass.

  Typical reviews settle in one or two delta passes. If a finding
  legitimately needs more discussion than a one-shot exchange
  supports, resume, discuss, and iterate as needed.

  ## Disagreements

  If you disagree with a finding, say so in the follow-up message
  with your reasoning. The reviewer is instructed to accept caller
  decisions and not re-flag declined findings on the next pass —
  the audit trail preserves the original finding, and the delta
  synthesis records that you declined it. A finding you push back
  on is not a failed review; it's a calibration datapoint.
tasks:
  - id: orient
    title: Repo orientation and scope resolution
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
          Proceed through the following tasks with the whole
          codebase in mind.
        - If `range` is a git-style spec (`unstaged`, `staged`,
          `last commit`, `HEAD~N..HEAD`, `main..branch`, or any
          other phrase), translate it to a concrete git
          invocation and identify the exact set of files and
          hunks that changed. Run the appropriate command:
            - `unstaged`        -> `git diff`
            - `staged`          -> `git diff --cached`
            - `last commit`     -> `git show HEAD`
            - a git range spec  -> `git diff <spec>`
          Capture the list of touched files. For the rest of the
          review, *also* read each touched file in full (not just
          the diff) so you can judge the change in context.

      Third, inspect the implementation run's group-scoped
      attachment view and, if it includes an
      `assignment-summary.md` row from a planning run in the
      same run group,
      download it to a temp directory and review it for
      supplemental context. The summary is
      supplemental only; the authoritative review inputs remain
      the repository state, the requested scope, and
      `implementation_run_id`.

          {{task_runner_cmd}} attachment list "{{implementation_run_id}}" --scope group --output-format json
          mkdir -p /tmp/task-runner-review-artifacts-{{run_id}}
          {{task_runner_cmd}} attachment download <owner-run-id> <summary-attachment-id> /tmp/task-runner-review-artifacts-{{run_id}}/

      In the group-scoped JSON output, find the row whose `name` is
      `assignment-summary.md` and use that row's `ownerRunId` plus
      `id` in the download command above. If no such row exists,
      continue without blocking.

      Notes: a 5-10 line summary of what the project is, its
      major modules, and — if scoped — the concrete set of files
      and hunks under review. This is context for the rest of the
      review, not a finding section.
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
  - id: plan_coverage
    title: Plan coverage verification
    body: |
      Read the implementation run's canonical task state:

          {{task_runner_cmd}} run status {{implementation_run_id}} --output-format json --field tasks

      Your job is to verify that what shipped matches what the
      implementation run claimed to complete, with no silent
      deferrals.

      Also check the plan for explicit design constraints.
      When the plan or repo conventions say to avoid fallback
      logic, heuristics, alias fields, compatibility shims,
      or dual-shape readers unless compatibility was explicitly
      requested, enforce that rule here. A change that quietly
      adds transitional compatibility machinery despite a
      hot-cut plan is a plan-coverage/design finding, not an
      implementation detail to wave through.

      Walk **every task** in the plan. Do not hardcode specific
      task ids — the plan's task list is whatever shape its
      planner produced.

      **Step 1: determine each task's category.**

      Look for an explicit `**Category**: <value>` line at the
      top of the task's body. Plans produced by the
      `plan-feature` meta-assignment are required to tag every
      task, so this line should be present. Valid values:

      - **code-bearing** — the task produces diff artifacts
        (code, tests, docs, changelog). Verify the claimed
        work against the diff.
      - **process** — the task produces notes-only artifacts
        (orientation, check-gate exit codes, review run ids,
        summaries, handoff). Verify status + notes only; do
        not look for a diff footprint.
      - **hybrid** — the task may or may not produce diff
        artifacts depending on what was needed (typical
        examples: a fresh-eyes simplification pass, an
        apply-review-fixes task, a scaffold task that
        sometimes edits config). Read the task's Notes: if
        the Notes claim diff artifacts were produced (files
        edited, lines changed, commits made), verify each
        one against the diff; if the Notes say "no changes
        needed" or equivalent, accept it like a process task.

      **Inference for untagged plans.** If the Category tag is
      missing (legacy plans, manually-authored assignments,
      or a planner that failed to tag), flag it as a [LOW]
      finding (`untagged task requires inference`) and fall
      back to signal-based inference:
        - **code-bearing signals** in the title or body:
          `implement`, `add`, `update`, `fix`, `refactor`,
          `write`, `create`, explicit file paths or
          function names
        - **process signals**: `orient`, `check gate`,
          `self-check`, `handoff`, `review` (the act of
          launching a review, not applying its findings),
          or the task's deliverable is entirely in Notes
          (exit codes, run ids, summaries)
        - **hybrid signals**: `scaffold`, `simplify`,
          `fresh eyes`, `apply review fixes`, or the task
          description explicitly says "only if needed"
        Apply the corresponding verification rule below.

      **Step 2: verify each task based on its category.**

      For **every task**, regardless of category:
        - Status must be `completed`. `blocked`, `pending`, or
          `in_progress` on a plan the implementer claims is
          done is a finding.
        - Notes block must be non-empty and contain concrete
          evidence (not placeholder text, not "Done.", not an
          empty line). Vague completion is a finding.

      For **code-bearing tasks**, additionally:
        - Cross-reference the task body against the diff. If
          the task says "add `foo()` to `src/bar.ts`", verify
          the diff contains that edit. If the task says "add
          tests covering the retry path", verify new tests
          exist for that path.
        - If the Notes claim specific files/functions/tests/
          docs/CHANGELOG entries, verify each one is present in
          the diff.
        - Look for a `**Done when:**` block in the task body
          (plans generated by `plan-feature` are required to
          carry one on every code-bearing task). If present,
          verify each completion criterion it lists is
          satisfied by the diff and the implementer's Notes
          — not just the general shape of the work. A missing
          "Done when" criterion on a `completed` task is
          [HIGH] (`done-when criterion not satisfied`). A
          missing "Done when" block on a code-bearing task is
          [LOW] (`code-bearing task lacks Done when`) — the
          plan is weaker than it should be, but not
          necessarily wrong.

      For **process tasks**, additionally:
        - Trust the status-plus-Notes contract. Do **not** try
          to find diff artifacts for a process task — it does
          not produce them by design.
        - Verify Notes contains the evidence the task asked
          for: exit codes for check-gate tasks, a review run
          id for internal-review tasks, a synthesis block for
          self-check tasks.

      For **hybrid tasks**, additionally:
        - Read the Notes to determine whether the task
          produced diff artifacts on this run. The Notes
          should make this unambiguous: either "applied
          <specific changes>" or "no changes needed /
          simplified nothing / all review fixes declined".
        - If the Notes claim diff artifacts: verify each
          claimed artifact is present in the diff, like a
          code-bearing task. Missing = finding.
        - If the Notes claim no diff artifacts were needed:
          accept the task like a process task and trust the
          status-plus-notes contract. Do not flag the
          absence of a diff footprint.
        - Ambiguous Notes that neither claim nor disclaim
          diff artifacts for a hybrid task are themselves a
          finding ([MEDIUM] — `hybrid task notes do not
          make diff footprint explicit`), because the
          reviewer cannot verify without knowing what the
          task actually did.

      **Step 3: findings.**

        - [HIGH] Any task marked `completed` with an empty or
          placeholder Notes block. Evidence-less completion is
          a silent deferral.
        - [HIGH] Any task with status `blocked`, `pending`, or
          `in_progress`. Cite the task id and the status.
        - [HIGH] Any code-bearing task whose claimed work is
          not present in the diff. Cite the task id and the
          specific missing artifact (file, function, test,
          CHANGELOG entry).
        - [CRITICAL] Any review-application task whose Notes
          claim fixes were applied that are not reflected in
          the diff. Cite the review run id and the unaddressed
          finding.
        - [MEDIUM] Scope creep — code in the diff that no plan
          task calls for, and that introduces non-trivial risk
          or surface area. Not all scope creep is a finding;
          trivial fixups along the way are expected.
        - [LOW] Plan drift — the plan text describes an
          approach that differs from what was implemented,
          even though the outcome is equivalent. Mostly
          informational; the plan's audit trail is now stale.

      **Step 4: verify planning assumptions.** If the plan's
      orient task (typically `orient`) or feature-context section
      lists explicit assumptions the planner made, verify each
      one still holds for the final implementation. A silently
      broken assumption is [HIGH] — cite the assumption and
      the place where the code contradicts it.

      **Step 5: verify design-discipline constraints.** If the
      plan, repo guidance, or task notes say the change should
      be a hot cut with no compatibility layer, check for:
        - fallback readers/writers for old shapes
        - heuristic format detection instead of an explicit
          contract
        - alias fields kept in sync with the new field
        - bridge routes or dual command/code paths
        - compatibility-only migrations the plan did not call for

      Findings here are usually:
        - [HIGH] unplanned compatibility layer or fallback
          logic that materially widens the maintenance surface
        - [MEDIUM] heuristic detection where the plan called
          for an explicit contract
        - [LOW] leftover transitional comments/TODOs pointing
          at a migration that the implemented change no longer needs

      If every plan task is `completed` with concrete evidence
      and the diff matches the code-bearing tasks and no
      assumptions broke, write "Plan coverage verified: every
      planned task has status `completed` with evidence, and
      all code-bearing tasks are reflected in the diff." in
      Notes and mark `completed`. A clean result is the
      correct outcome when the work is clean — do not pad
      with fabricated findings.
  - id: synthesis
    title: Top findings synthesis
    body: |
      Now read back through the notes you wrote on
      `review/architecture` through `review/docs-drift`,
      plus `plan_coverage`, and build a single ranked list of the **top 10
      highest-leverage findings** from the entire review. Order
      by severity (CRITICAL first, then HIGH, MEDIUM, LOW) and
      within a severity by impact. Each entry must reference the
      original finding's file:line so the reader can jump back.

      If you found fewer than 10 real issues, list the real
      ones and stop. Padding the list with NITs is not a
      synthesis.

      Also include:
        - One sentence on the project's overall health
        - The single highest-leverage refactor (if any) that
          would make several findings disappear at once
        - A one-sentence ship / ship-with-changes / block
          recommendation. **Required for every review, not
          just ranged ones**, because approval gates on
          it. For **ranged** reviews, this answers "should
          this change land?" For **full-codebase** reviews,
          this answers "would you ship this codebase as-is if
          a maintainer asked you to tag a release right now?"
          — same three outcomes (ship = healthy; ship with
          changes = real issues to address but no immediate
          crisis; block = critical issues that demand
          immediate attention). Do not omit this field.
        - If `plan_coverage` ran (i.e. a plan was provided),
          fold its findings into the ranked list above and
          state explicitly in the recommendation whether plan
          scope was fully met, partially met, or materially
          deferred
  - id: approval
    title: Final ship / no-ship decision
    body: |
      This task is the gate. It is not a synthesis, a summary,
      or an end-of-run checkbox — it is a decision with a
      consequence. `completed` means "I approve this change for
      ship." `blocked` means "I cannot approve; halt cleanly
      for a delta pass." Both are first-class outcomes; neither
      is a failure of the review. The run's exit code carries
      this decision (0 on approved, 2 on blocked), so scripts
      and callers will gate on it — do not mark this
      `completed` reflexively just because you reached the end
      of the task list.

      **Lead with the blocked case.** If **any** of the
      following are true, mark this task `blocked` with a
      short Notes block explaining which condition held and
      stop — the runner will halt the session cleanly and the
      caller will resume for a delta pass after fixes.

        - Any finding at HIGH or CRITICAL severity from
          `review/architecture` through `review/docs-drift`,
          plus `plan_coverage`, is unresolved in the current diff.
        - `plan_coverage` surfaced any HIGH or
          CRITICAL finding that is not resolved.
        - The `synthesis` recommendation is "block" or "ship
          with changes" — both mean more work is required.
        - You were unable to trace a finding deeply enough to
          judge whether it is real. Uncertainty blocks.
        - Any assumption from the implementation run identified
          by `implementation_run_id` appears to
          have broken silently during execution and you have
          not confirmed with the caller that the break is
          intentional.

      **Completion criteria.** Only mark this task `completed`
      if **all** of the following hold. Walk the list
      explicitly; do not skip any.

        - Every HIGH / CRITICAL finding is either (a) resolved
          in the current diff or (b) explicitly declined by
          the caller upstream with a written justification —
          typically in the resume follow-up message that
          triggered this delta pass.
        - The `plan_coverage` pass ran cleanly with no HIGH /
          CRITICAL findings open.
        - The `synthesis` recommendation is "ship."
        - You personally would stand behind this change
          landing on the main branch as-is. If you would not,
          block.

      **Write-in requirement.** Whether you approve or block,
      paste a one-paragraph decision record into this task's
      Notes block. Use these formats verbatim so downstream
      scripts can grep them:

      Approval:

          APPROVED for ship.
          Rationale: <one to three sentences on why the work
            meets the bar.>
          Residual findings: <file:line references to any
            open MEDIUM/LOW items the caller chose to accept,
            or "none".>

      Block:

          BLOCKED -- cannot approve.
          Unresolved: <bulleted list of the specific
            conditions above that held, each citing file:line
            for the underlying finding.>
          Path to approval: <short, concrete instruction on
            what would flip this to approved in a delta
            pass — which findings must be fixed, which
            assumptions must be confirmed.>

      Do not delegate this task to a subagent. The approval
      decision must live in the main reviewer's own context,
      grounded in the findings it produced.
---
You are reviewing the repository at `{{cwd}}` with scope
`{{range}}`. Treat `{{cwd}}` as the root for everything you
read. Do not modify any file inside that repo. Use the task CLI as
the task interface for this run; do not rely on workspace files.

Work the tasks in order. Earlier tasks build context the later
ones depend on — don't skip ahead. The synthesis task at the end
pulls from your accumulated notes, so be specific in each task's
notes block.

A dimension with no real issues produces no findings in that
task. Say "No issues found in this dimension" and move on.
Padding the review to look thorough is worse than a short honest
review.

**Delegating via subagents.** For a large review, you may
delegate independent task dimensions to subagents to
parallelize — e.g. run the concurrency review and the security
review as separate subagents while you prepare the synthesis.
Do not delegate the `orient`, `plan_coverage`, `synthesis`, or
`approval` tasks; all four depend on your own accumulated
context and, in the case of `approval`, on a judgment call
that cannot be outsourced.
When a subagent returns, fold its findings into the task's
Notes block in the same severity/format used by the rest of
the review so the synthesis pass sees a consistent shape.
Delegation is optional — for a small or ranged review,
working the tasks yourself is usually faster.

**Re-review after agreed-upon fixes.** If this run is resumed
with a follow-up message asking you to re-check your prior
findings, do **not** re-walk all 14 tasks from scratch. Instead:

1. Re-read your prior notes on `review/architecture` through
   `review/docs-drift`, plus `plan_coverage` and
   `synthesis` — those are your original findings and
   synthesis. Also re-read the prior `approval` decision
   record if it exists (the runner
   preserves Notes on resume); it tells you exactly what
   blocked approval last time.
2. Inspect what has changed in the repository since your prior
   review. You are in a resumed session with full context of
   your previous findings, so figure out what moved: new
   commits on the branch, unstaged edits, or a widened scope.
   Do **not** assume the original `range` spec is still stable —
   moving specs like `HEAD~N..HEAD`, `last commit`, `unstaged`,
   and `staged` point at different work now that fix commits
   have landed. Use `git log`, `git status`, `git diff`, and
   the commit history from your first pass (captured in your
   notes or available via `git reflog`) to orient yourself to
   the actual delta between the review you already did and the
   current working tree.
3. For each prior finding, decide whether it is:
   - **Resolved**: the fix landed and looks correct. Note the
     commit/hunk that addresses it.
   - **Partially resolved**: the fix is incomplete or has a
     new flaw. Explain what's still wrong.
   - **Not addressed**: the finding stands. Restate it
     briefly so the caller sees it again.
4. Scan the new changes (the delta since the prior review) for
   any **new issues** introduced by the fixes themselves. Hold
   these to the same severity bar as the original review.
5. Write the delta as a fresh synthesis into `synthesis`'s
   Notes block, replacing the prior synthesis. Structure:
   ```
   ## Delta review (re-run)
   
   ### Findings resolved
   - [SEVERITY] original finding — status: resolved. Fix
     location: file:line. Brief confirmation.
   
   ### Findings still open
   - [SEVERITY] original finding — status: open / partial.
     Explanation.
   
   ### New findings introduced by the fixes
   - [SEVERITY] new finding in the same file:line format.
   
   ### Overall recommendation
   One sentence: ship, ship with changes, or block.
   ```
6. You do not need to rewrite the Notes on `review/architecture`
   through `review/docs-drift` or `plan_coverage` — leave the
   original findings (including any plan-coverage findings)
   intact there as an audit trail and put the delta in
   `synthesis` only.
   Re-verify plan coverage against the post-fix diff as part of
   step 3 — a plan-coverage finding that was originally HIGH
   because scope was deferred becomes "resolved" once the
   scope lands, or remains open if it did not.
7. Re-evaluate `approval` against the post-fix state. The
   runner reset it to `pending` on resume and preserved the
   prior Notes block, so you have the previous decision record
   as context. Apply the approval criteria from scratch against
   the delta synthesis in `synthesis` and the current diff. If every
   HIGH/CRITICAL finding is now resolved or was explicitly
   declined with justification and the synthesis recommendation
   is "ship", mark `approval` `completed` with a fresh approval
   decision record. Otherwise, mark it `blocked` again with an
   updated reason — and expect another delta pass. Exit code
   semantics are unchanged: `completed` → success (exit 0),
   `blocked` → blocked (exit 2), and scripts will gate on the
   terminal status.

Re-review mode is strictly additive over prior context: your
goal is speed and targeted verification, not thoroughness for
its own sake. A re-review that concludes "all findings
resolved, no new issues, ship" in 2 minutes is the correct
outcome if that's what the code shows — approve it in
`approval` and finish.

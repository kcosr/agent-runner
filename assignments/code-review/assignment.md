---
schemaVersion: 1
name: code-review
sessionName: code review {{range}} · {{repo_path}}
vars:
  repo_path:
    type: string
    required: true
    source: cli
    description: Absolute path to the repository to review.
  range:
    type: string
    required: false
    source: cli
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
  implementation_plan:
    type: string
    required: false
    source: cli
    default: ""
    description: |
      Optional absolute path to a task-runner workspace
      `assignment.md` representing the implementation plan the
      work under review was produced from. When set, the reviewer
      adds a plan-coverage pass that verifies every task in the
      plan actually shipped — catching silent deferrals, dropped
      review fixes, and unplanned scope creep. Leave unset for
      reviews that are not driven by a `plan-feature` run; the
      plan-coverage task becomes a no-op in that case.
callerInstructions: |
  This run produces a structured code review in the task notes,
  gated by an explicit ship / no-ship decision at the end. Read
  the findings, implement the fixes you agree with, then resume
  this same run for a delta re-review. The reviewer's synthesis
  in `t13_synthesis.notes` is the ranked top-findings list; each
  individual task (t02 architecture, t03 concurrency, …, t11 docs
  drift, t12 plan coverage) carries the raw findings for its
  dimension with severity tags. The final decision lives in
  `t14_approval.notes`.

  **Exit code carries the decision.** The run exits `success`
  (code 0) only if the reviewer approved the change in t14;
  `blocked` (code 2) means the reviewer could not approve and
  a delta pass is needed after fixes. The first call will
  almost always exit blocked — that is the expected contract,
  not a failure. Scripts should gate on the terminal status,
  not on the existence of a synthesis block. The approval
  decision record in `t14_approval.notes` follows a fixed
  format (`APPROVED for ship` or `BLOCKED — cannot approve`)
  so you can grep it directly:

      task-runner status {{run_id}} --output-format json \
        --field finalTasks | jq -r '.[] | select(.id=="t14_approval") | .notes'

  If this review was launched with `--var implementation_plan=<path>`
  — typically from a `plan-feature`-generated implementer run —
  the reviewer verifies that every task in the referenced plan
  actually landed in the diff under review. Silent deferrals and
  dropped review fixes are flagged at HIGH/CRITICAL severity,
  and any unresolved HIGH/CRITICAL from the plan-coverage pass
  blocks t14 approval. Runs launched without the var skip the
  plan-coverage pass cleanly.

  ## Reviewing findings

  Pull the full review:

      task-runner status {{run_id}}                         # human-readable
      task-runner status {{run_id}} --output-format json    # machine-readable

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

      task-runner run --resume-run {{run_id}} "<your follow-up>"

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
  may have introduced, rewrite the t13 synthesis with a "Delta
  review" structure, and re-evaluate t14 approval from scratch
  against the post-fix state. Tasks t02–t12 retain their original
  findings as the audit trail from the first pass, so you can
  always see how findings evolved across rounds. The t14 approval
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
  - id: t01_orient
    title: Repo orientation and scope resolution
    body: |
      First, understand the project. Read the high-signal entry
      points for the repository at `{{repo_path}}`:
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
            - `unstaged`        → `git diff`
            - `staged`          → `git diff --cached`
            - `last commit`     → `git show HEAD`
            - a git range spec  → `git diff <spec>`
          Capture the list of touched files. For the rest of the
          review, *also* read each touched file in full (not just
          the diff) so you can judge the change in context.

      Notes: a 5-10 line summary of what the project is, its
      major modules, and — if scoped — the concrete set of files
      and hunks under review. This is context for the rest of the
      review, not a finding section.
  - id: t02_architecture
    title: Architecture & module boundaries
    body: |
      Review the module layout and component boundaries for
      design smells. If the scope is ranged, focus on whether the
      change introduces or worsens any of these, not on
      pre-existing architecture you can't affect.

      Look for:
        - Modules doing more than one thing
        - Coupling that should be inverted (low-level depending
          on high-level)
        - Abstractions that exist but aren't pulling weight
        - Abstractions that should exist but don't (duplicated
          logic across sibling modules — also see t09)
        - Layer violations (e.g. a backend module reaching into
          runner state, a UI module calling a DB layer directly)
        - Asymmetries between sibling modules that suggest one is
          wrong
        - Circular dependencies

      If the scope is too small for this dimension to produce
      real findings, say so and move on. Format per role
      instructions.
  - id: t03_concurrency
    title: Concurrency & async safety
    body: |
      This is usually the highest-leverage dimension. Look for:
        - Promise/future rejections that are silently swallowed
          (`.catch(() => {})`, bare `try { } catch {}` without
          rethrow/log, Go `_ = err`, Rust `.unwrap()` on a
          genuinely fallible result, etc.)
        - Race conditions: shared mutable state touched from
          multiple async paths without ordering guarantees
        - Listeners (`.on`, `addEventListener`, channels,
          observers) that aren't removed on every completion
          path, especially error/close paths
        - Timers (`setTimeout`, `setInterval`, select timeouts)
          that aren't cleared on every exit
        - AbortSignal / cancellation handling: pre-cancelled
          signals, listeners that fire after the awaited
          operation already settled
        - Child processes, file handles, and sockets that aren't
          cleaned up on failure paths
        - `Promise.race` / `select` patterns where the losing
          branch keeps running and may still cause side effects
        - `async`/`await` mistakes: forgotten `await`, awaiting
          in a loop when parallel would be correct, awaiting
          outside a `try` so errors bypass handlers

      Read every backend adapter, every subprocess wrapper, and
      the main loop(s) for the code. Format per role instructions.
  - id: t04_error_handling
    title: Error handling & edge cases
    body: |
      For each user-visible operation in scope, ask: what happens
      when it fails? Specifically walk through:
        - Malformed config files (truncated, wrong type, extra
          fields, schema-version mismatch)
        - Missing files or directories
        - Permission errors on read or write
        - Network failures mid-request (for any network-touching
          code)
        - Subprocess crashes vs subprocess non-zero exit vs
          subprocess hang
        - Empty input where the code assumes non-empty
        - Concurrent processes writing to the same file
        - Disk full / EIO mid-write

      Are errors actionable to a user (with file:line, suggested
      fix)? Are partial states left on disk if a write fails
      halfway? Look especially at any code that writes to disk
      and any code that parses external input.
  - id: t05_state_machine
    title: State machine & lifecycle correctness
    body: |
      Identify the explicit and implicit state machines in the
      code. Examples: persisted status enums, session lifecycles,
      build-phase transitions, resource acquire/release cycles.

      For each, ask:
        - Are all states reachable? Are any unreachable?
        - Are illegal transitions guarded against, or just
          unreachable by accident? (Defense in depth: can a
          corrupted input trigger an illegal start state?)
        - On failure mid-transition, does the persisted state
          make sense, or is it stuck between two consistent
          states?
        - Are status fields ever stale relative to the truth
          (e.g. `running` after the process died)?
  - id: t06_resources
    title: Resource management & cleanup
    body: |
      Any code that allocates a non-memory resource is suspect.
      Look for:
        - File handles (open()/createReadStream/etc.)
        - Child processes (spawn/fork/exec)
        - Sockets, WebSockets, DB connections
        - Directories or temp files created but never cleaned up
        - Anything in `os.tmpdir()` or equivalent

      For each, is there a guaranteed release path on success
      AND every failure mode? Trace the close() chain by reading
      code, not by trusting "the process will exit eventually" —
      long-lived runs cannot rely on process exit.

      Also flag anything that grows unboundedly (arrays, maps,
      log buffers, caches) without a cap.
  - id: t07_security
    title: Security & untrusted-input handling
    body: |
      Identify the trust boundaries — where untrusted input
      crosses into the code. Typical sources: CLI args, env
      variables, files written by another process or an AI
      agent, HTTP/RPC request bodies, user-supplied regex or
      queries, config files from a shared directory.

      For each input, trace where it lands:
        - Does it become part of a shell command? (command
          injection — `exec` vs `spawn(args-array)`)
        - Does it become a file path? (path traversal, `..`
          segments, symlink following)
        - Does it become part of a prompt sent to an AI? (prompt
          injection — limit by design, not promise)
        - Are secrets (API keys, env vars marked sensitive) ever
          logged, persisted to disk, or included in error
          messages?
        - Is there any `eval`, `Function`, dynamic `require`,
          or user-supplied regex with potential ReDoS?
  - id: t08_types_schema
    title: Type safety & schema rigor
    body: |
      Is the type system load-bearing or decorative?
        - `any`, `as unknown as T`, `@ts-ignore`,
          `@ts-expect-error`, Rust `unsafe`, Go
          `interface{}`/`reflect` — where, and is each
          justified?
        - Untyped `JSON.parse` results (or equivalents in other
          languages) that flow into typed code without a runtime
          check (zod, serde, pydantic, type guards)
        - Discriminated unions with implicit fall-through cases
        - Schemas where the library's default behavior silently
          drops fields the author probably wanted to validate
        - Schema versioning: how does the code handle a v2
          payload when only v1 is understood? Loud failure or
          silent misinterpret?
        - Optional fields where code assumes presence
  - id: t09_simplification_and_duplication
    title: Simplification & duplication
    body: |
      Two related dimensions that often pay for themselves
      immediately:

      **Simplification.** Look for code that's more complex than
      the problem it solves:
        - Functions doing multiple unrelated things
        - Class hierarchies where a tagged union or plain
          function would do
        - Conditional chains longer than three branches that
          could be a lookup table, map, or polymorphic dispatch
        - 20-40 line blocks that express what 5-10 well-named
          helper calls would
        - "Clever" patterns (bitwise flags, stringly-typed
          registries, reflection gymnastics) where the intent
          isn't obvious from the code
        - Layered indirection where the layers don't add
          anything (e.g. wrapper classes that just forward
          every method)
        - Pre-optimizations: caches, pools, or batching for
          operations that aren't actually hot

      For each, quote the current shape (a few lines) and
      sketch the simpler shape in the suggested fix.

      **Duplication.** Look for repeated logic whose invariants
      must stay in sync:
        - The same computation inlined in multiple call sites
        - Parallel code paths that differ only in one parameter
        - Copy-pasted error handling blocks
        - Validation logic duplicated between the schema and
          the runtime check
        - Cross-language duplication (e.g. a type defined in
          both a TS file and a Rust file that will silently
          diverge)

      For each, cite every instance. Propose the extraction
      point — the shared helper, the shared type, the shared
      module — and note which invariant the consolidation
      protects.

      Be specific: "this is duplicated" is not a finding.
      "`src/a.ts:12-28` and `src/b.ts:40-56` both implement
      retry with exponential backoff; if the backoff constant
      changes in one, the other silently diverges" is.
  - id: t10_test_coverage
    title: Test coverage gaps
    body: |
      Skim the test directory. For each fragile area you flagged
      in earlier tasks, check whether a test exercises it.
      Specifically:
        - Code paths in async error handlers that have no test
        - Edge cases (empty, max, boundary) that have no test
        - Modules where only the happy path is tested
        - Lifecycle interactions (retries, resume, abort, init,
          cleanup) that aren't combinatorially covered
        - Tests that exercise the type but not the value (e.g.
          "calls succeed" without checking what they returned)

      If the project has a test command, run it once and report
      whether everything currently passes. If the scope is
      ranged, check whether the change added tests for its own
      new code paths.
  - id: t11_docs_drift
    title: Documentation accuracy
    body: |
      Compare the code in scope against the documentation that
      describes it. Specifically:
        - Field names and types in interface blocks
        - CLI flag lists and behavior
        - File path examples
        - Status enum values
        - Behavior claims ("the runner does X on resume")

      Drift between docs and code is a finding. Stale claims are
      a higher-severity finding than missing docs because they
      actively mislead.

      (This is a code review, not a doc review — keep it to
      inaccuracies and contradictions. For a full doc pass use
      the `doc-review` assignment.)
  - id: t12_plan_coverage
    title: Plan coverage verification
    body: |
      This task is conditional on the `implementation_plan` var.
      Its value for this run is:

          {{implementation_plan}}

      If the indented line above is blank (nothing after the
      four-space indent), no implementation plan was provided —
      write "No implementation plan provided; plan-coverage pass skipped."
      in Notes, mark this task `completed`, and move on. Do not
      invent findings for a skipped pass.

      Otherwise, read the file at the path above. It is a
      task-runner workspace `assignment.md` for an implementer run
      that claims to have finished the work you are now reviewing.
      Your job is to verify that what shipped matches what was
      planned, with no silent deferrals.

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

      **Fallback for untagged plans.** If the Category tag is
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
      orient task (typically t01) or feature-context section
      lists explicit assumptions the planner made, verify each
      one still holds for the final implementation. A silently
      broken assumption is [HIGH] — cite the assumption and
      the place where the code contradicts it.

      If every plan task is `completed` with concrete evidence
      and the diff matches the code-bearing tasks and no
      assumptions broke, write "Plan coverage verified: every
      planned task has status `completed` with evidence, and
      all code-bearing tasks are reflected in the diff." in
      Notes and mark `completed`. A clean result is the
      correct outcome when the work is clean — do not pad
      with fabricated findings.
  - id: t13_synthesis
    title: Top findings synthesis
    body: |
      Now read back through the notes you wrote on tasks t02-t12
      and build a single ranked list of the **top 10
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
          just ranged ones**, because t14_approval gates on
          it. For **ranged** reviews, this answers "should
          this change land?" For **full-codebase** reviews,
          this answers "would you ship this codebase as-is if
          a maintainer asked you to tag a release right now?"
          — same three outcomes (ship = healthy; ship with
          changes = real issues to address but no immediate
          crisis; block = critical issues that demand
          immediate attention). Do not omit this field.
        - If t12 plan-coverage ran (i.e. a plan was provided),
          fold its findings into the ranked list above and
          state explicitly in the recommendation whether plan
          scope was fully met, partially met, or materially
          deferred
  - id: t14_approval
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

        - Any finding at HIGH or CRITICAL severity from t02–t12
          is unresolved in the current diff.
        - t12 plan-coverage (if it ran) surfaced any HIGH or
          CRITICAL finding that is not resolved.
        - The t13 synthesis recommendation is "block" or "ship
          with changes" — both mean more work is required.
        - You were unable to trace a finding deeply enough to
          judge whether it is real. Uncertainty blocks.
        - Any assumption from the implementation plan (if one
          was provided via `implementation_plan`) appears to
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
        - The t12 plan-coverage pass either did not run (no
          plan provided) or ran cleanly with no HIGH /
          CRITICAL findings open.
        - The t13 synthesis recommendation is "ship."
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

          BLOCKED — cannot approve.
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
You are reviewing the repository at `{{repo_path}}` with scope
`{{range}}`. Treat `{{repo_path}}` as the root for everything you
read. Do not modify any file inside that repo — the only file you
should write is your workspace plan at `{{assignment_path}}`.

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
Do not delegate the orient task (t01), the plan-coverage task
(t12), the synthesis task (t13), or the approval task (t14);
all four depend on your own accumulated context and, in the
case of t14, on a judgment call that cannot be outsourced.
When a subagent returns, fold its findings into the task's
Notes block in the same severity/format used by the rest of
the review so the synthesis pass sees a consistent shape.
Delegation is optional — for a small or ranged review,
working the tasks yourself is usually faster.

**Re-review after agreed-upon fixes.** If this run is resumed
with a follow-up message asking you to re-check your prior
findings, do **not** re-walk all 14 tasks from scratch. Instead:

1. Re-read your prior notes on tasks t02–t13 — those are your
   original findings and synthesis. Also re-read the prior
   t14 approval decision record if it exists (the runner
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
5. Write the delta as a fresh synthesis into `t13_synthesis`'s
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
6. You do not need to rewrite the Notes on t02–t12 — leave the
   original findings (including any plan-coverage findings)
   intact there as an audit trail and put the delta in t13 only.
   If an implementation plan was provided for the original run,
   re-verify plan coverage against the post-fix diff as part of
   step 3 — a plan-coverage finding that was originally HIGH
   because scope was deferred becomes "resolved" once the
   scope lands, or remains open if it did not.
7. Re-evaluate `t14_approval` against the post-fix state. The
   runner reset it to `pending` on resume and preserved the
   prior Notes block, so you have the previous decision record
   as context. Apply the t14 criteria from scratch against the
   delta synthesis in t13 and the current diff. If every
   HIGH/CRITICAL finding is now resolved or was explicitly
   declined with justification and the synthesis recommendation
   is "ship", mark t14 `completed` with a fresh approval
   decision record. Otherwise, mark it `blocked` again with an
   updated reason — and expect another delta pass. Exit code
   semantics are unchanged: `completed` → success (exit 0),
   `blocked` → blocked (exit 2), and scripts will gate on the
   terminal status.

Re-review mode is strictly additive over prior context: your
goal is speed and targeted verification, not thoroughness for
its own sake. A re-review that concludes "all findings
resolved, no new issues, ship" in 2 minutes is the correct
outcome if that's what the code shows — approve it in t14 and
finish.

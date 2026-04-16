---
schemaVersion: 1
name: plan-feature
maxRetries: 4
vars:
  repo_path:
    type: string
    required: true
    source: cli
    description: Absolute path to the repository the feature will be added to.
callerInstructions: |
  This assignment turns a free-form feature description into an
  executable task-runner plan. The feature summary and any
  rough implementation notes go in as the positional message
  body when you invoke task-runner — not as a var — so there
  is no length limit.

  ## Invoking the planner

      {{task_runner_cmd}} run \
        --agent <your-planner-agent> \
        --assignment plan-feature \
        --var repo_path=/abs/path/to/target/repo \
        "$(cat /tmp/feature-brief.md)"

  Use the bundled `planner` agent or another unrestricted
  general-purpose agent. The planner doesn't need special role
  instructions beyond what this assignment provides, but it
  does need shell access (`unrestricted: true`) so it can
  inspect the repo and validate the generated draft
  assignment. The caller environment must allow one nested
  `task-runner run`, because the planner runs `plan-review`
  before handing the draft back.

  ## What the planner does

    1. Reads the target repo's conventions, identifies the
       impact surface, checks for reusable existing code, and
       maps out risks and tests.
    2. Copies the reference template from
       `${TASK_RUNNER_CONFIG_DIR}/assignments/plan-feature/template.md`
       into
       `${TASK_RUNNER_STATE_DIR}/drafts/<repo-name>/plan-<slug>-<shortid>.md`,
       adjusts the task list to fit the feature, and fills in
       every `<<PLACEHOLDER>>` with concrete steps. The
       template's task list is a starting shape; the planner
       may add, remove, or rename tasks so long as the
       `lockedFields: [tasks]` line stays in the frontmatter.
    3. Runs the bundled `plan-review` assignment against the
       draft, passing both the draft path and the planner's own
       run id so the reviewer can validate the draft against
       the planning evidence. The planner
       applies fixes and reruns the draft review until it is
       approved.
    4. Produces a human-facing summary next to the approved
       draft, then attaches both artifacts to the planning run
       itself as `assignment-seed.md` and
       `assignment-summary.md` so the caller can review them
       directly from the run.
    5. Prepares the follow-up creation workflow for the later
       approval step. The planner does **not** init the
       implementer run during the initial planning pass; if the
       caller approves and asks for creation, the planner first
       confirms the target directory or worktree path, then runs
       `init` and attaches the same two artifacts to the new
       implementer run.

  ## After planning

  Pull the handoff summary and attachment info from the
  `handoff` task's notes block:

      {{task_runner_cmd}} status {{run_id}}
      {{task_runner_cmd}} status {{run_id}} --output-format json \
        --field tasks

  Review the planning-run attachments first:

      {{task_runner_cmd}} attachment list {{run_id}}

  If `assignment-summary.md` exists there, download it and
  review it before deciding whether to create the implementer
  run. If you approve the plan and want the implementer run
  created, resume this same planning run and ask for creation.
  The planner will confirm the target directory or worktree
  path before it runs `init`.

  After the planner creates the implementer run, hand off the
  new run id via:

      {{task_runner_cmd}} brief <new-run-id>

  The implementer run is created with the `implementer` agent
  on the passive backend, so execution continues through the
  passive task workflow described in the brief rather than
  `run --resume-run`.

  Nested review must be allowed at both stages:
  - the planner run nests `plan-review`
  - the generated implementation plan nests `code-review`

  If nested `task-runner run` invocations are disallowed in the
  surrounding environment, the review step will be rejected.

  The executor may be the same agent that did the planning, or
  a different agent entirely — anchor the handoff on the run
  id, not the planning agent. Task-runner reconstructs agent
  identity from the frozen manifest either way.

  ## What happens to the draft file

  The draft under `${TASK_RUNNER_STATE_DIR}/drafts/<repo-name>/`
  remains the planner's source artifact, and the planning run
  also carries it as `assignment-seed.md` plus the human-facing
  `assignment-summary.md` attachment. Once a later `init`
  succeeds, the canonical execution artifact becomes the new
  implementer run id plus its canonical task state in
  `run.json`. Edits to the draft file after init have no
  effect on the run.
tasks:
  - id: orient
    title: Target repo orientation and conventions
    body: |
      Read the high-signal entry points for the repository at
      `{{repo_path}}`:
        - AGENTS.md, CLAUDE.md, CONTRIBUTING.md at the repo
          root
        - README.md
        - Build manifest (package.json, Cargo.toml, go.mod,
          pyproject.toml, etc.) for scripts, dependencies,
          and language toolchain
        - docs/ directory (design docs, architecture notes)
        - Primary entry-point files

      Capture in Notes: the exact build, test, lint, and
      format commands, the test framework, any pre-commit
      hooks, PR conventions, and any non-obvious repo-specific
      rules the generated plan must respect. These command
      strings will be cited verbatim by the implementer's
      check-gate task, so copy them accurately.
  - id: capture_feature
    title: Capture the feature and implementation brief
    body: |
      The feature you are planning for was handed to you as
      the user message that started this run. Read it in
      full, then restate it in your own words in Notes:
        - What is the feature? (one paragraph, concrete)
        - What problem does it solve? What's the motivation?
        - What is explicitly in scope?
        - What is explicitly out of scope?

      If the brief included a rough implementation plan,
      capture every concrete step mentioned, even the ones
      you don't yet fully understand. Your job as planner is
      to refine those steps into an executable task list,
      not to discard them.

      ## Contract dimensions (ambiguity gate)

      Before you move on, walk the list of **contract
      dimensions** relevant to the type of feature you are
      planning and check whether the brief actually pins
      each one down. Do not guess; do not fill gaps with
      assumptions. An unanswered contract question at this
      stage becomes silently-wrong code later.

      When the feature changes a config/schema/API contract,
      plan for the end-state shape directly unless the caller
      explicitly asks for compatibility or migration support.
      Do not quietly introduce fallback parsing, heuristics,
      alias fields, bridge routes, or dual-shape readers just
      to smooth over a redesign.

      Identify the feature type first:
        - **CLI feature** — adds or changes a command,
          subcommand, flag, or argument.
        - **API / library feature** — adds or changes an
          exported function, HTTP endpoint, RPC method,
          or public type.
        - **Data / schema feature** — adds or changes a
          persisted shape, config file, database schema,
          or migration.
        - **UI feature** — adds or changes a screen, flow,
          component, or interaction model.
        - **Refactor** — restructures existing code
          without an intended external behavior change.
        - **Other** — infrastructure, tooling, build, etc.

      Then apply the dimension checklist for that type:

      **CLI**: exact command/subcommand name, exact flag
      names and short/long forms, required vs optional
      args, default values, text output format, JSON
      output format if any, exit codes per failure mode,
      behavior on malformed input, behavior on duplicate
      or missing resources.

      **API / library**: function/endpoint name, argument
      types and names, return type, error types and when
      each is raised, auth/permission model, request
      schema, response schema, backwards compatibility
      requirements.

      **Data / schema**: exact field names and types,
      nullability, defaults, indexes, migration direction
      (additive only vs destructive), rollback plan,
      behavior on pre-existing data.

      **UI**: entry point, state transitions, loading
      and error states, empty states, keyboard /
      accessibility requirements, responsive behavior.

      **Refactor**: scope boundaries (what files are in
      and out), behavior-preservation criteria (what
      existing tests must still pass), rollback plan.

      For **every** dimension above that is relevant to
      the feature type, ask: does the brief give me the
      answer, or am I about to make it up? Write each
      dimension and its status into Notes as:

          - <dimension>: <answer from brief> — OR —
          - <dimension>: **ambiguous**

      ## If anything is ambiguous, block

      If any relevant dimension is `ambiguous`, **mark this
      task `blocked`** with the following in Notes:

        1. The list of ambiguous dimensions.
        2. Up to three **targeted, concrete** questions
           you need the caller to answer before you can
           plan. "What should this do?" is not targeted;
           "Should `task list agents` print JSON by
           default, or only with `--output-format json`
           like the other commands?" is.
        3. A one-sentence summary of what you have
           understood so far, so the caller can confirm
           your framing.

      Task-runner will halt the run cleanly (exit 2). The
      caller resumes with a follow-up message answering
      your questions:

          {{task_runner_cmd}} run --resume-run {{run_id}} \
            "answers: <your answers here>"

      On resume, the runner normalizes `blocked` back to
      `pending` and you re-enter this task with the
      caller's answers in the new turn. Update the Notes
      block with the resolved dimensions and mark the
      task `completed`.

      **Do not assume**. Do not proceed to `survey_impact` with
      unresolved ambiguity — your whole plan will be
      built on a guess, and the ambiguity compounds
      through impact survey, implementation tasks, and
      review. A blocked run with three targeted
      questions is faster than a bad plan you have to
      throw away.

      ## After the gate

      Once every contract dimension is resolved (either
      from the brief or from a caller follow-up), also
      list in Notes any **remaining** assumptions you are
      making on non-contract details (naming, directory
      placement, test file naming, etc.). These become
      validation points the reviewer will check in its
      plan-coverage pass later, but they do not block —
      the contract gate only fires on the enumerated
      dimensions above.
  - id: survey_impact
    title: Survey the impact surface
    body: |
      Find every part of the repository the feature will
      touch. For each area, list in Notes:
        - File paths (repo-relative)
        - The function / class / module responsible
        - Existing behavior the feature must preserve
        - Existing tests covering the area (if any)

      Read the identified files in full, not just skim. This
      is the context the generated plan's implementation
      tasks will cite. Vague impact surveys produce vague
      plans, which produce sloppy implementations.

      You may delegate impact-surface exploration to native
      subagents (Claude's Agent tool, Codex subagents,
      whatever your backend supports) if that would
      parallelize the survey. Native subagents do not count
      against task-runner's recursion depth.
  - id: check_existing_code
    title: Existing-code and duplication check
    body: |
      Before planning new code, check what already exists.
      Specifically search for:
        - Helpers or utilities that already do what the
          feature needs — so the plan can reuse rather than
          reimplement.
        - Similar patterns elsewhere in the repo that the
          feature should match for consistency (error
          handling, config loading, state-machine shapes,
          naming conventions).
        - Near-duplicates of the logic the feature would
          introduce, which may mean an extraction point
          already exists and the plan should consolidate
          rather than add a third copy.

      For each reusable piece, cite `file:line` in Notes and
      describe how the plan can use it. If you find
      near-duplicates that complicate the clean landing of
      the feature, note them — the plan may need a
      pre-refactor task.

      Also flag any proposed approach that relies on fallback
      logic, heuristic detection, or compatibility shims where
      a direct hot-cut design would be cleaner. The generated
      plan should prefer explicit contracts over transitional
      glue unless the caller asked for migration support.

      This task is the primary defense against the plan
      producing accidental duplication. Take it seriously.
  - id: assess_risks_and_tests
    title: Risks, edge cases, and test strategy
    body: |
      For each impact area from `survey_impact`, identify in Notes:
        - Concurrency, state-machine, or lifecycle risks
        - Error paths and edge cases the feature must
          handle (malformed inputs, missing files,
          permission errors, partial writes, cancellation)
        - Existing test coverage on the area, or the
          absence of it
        - New tests the feature will need — unit,
          integration, or end-to-end — and where they will
          live (file paths from `orient` conventions)

      Also capture the exact check command(s) the project
      uses to gate commits (e.g. `npm run check`,
      `cargo test`, `pytest`). These will be cited verbatim
      by the generated plan's check-gate task.

      If the feature changes a persisted or user-facing
      contract, state explicitly whether the intended landing
      is a hot cut or a compatibility-preserving migration.
      Default to hot cut unless the caller said otherwise.
  - id: produce_contract_artifact
    title: Produce the feature contract artifact
    body: |
      Before you draft the plan, pin down the exact shape
      of what the implementer is going to build. The
      contract dimensions you walked in `capture_feature` were the
      *requirements check*; this task is the *deliverable*
      — a concrete, greppable artifact the implementer and
      reviewer both work from.

      Write the contract into this task's Notes using the
      format appropriate for the feature type. The contract
      must be specific enough that two people reading it
      would produce identical implementations on the
      observable surface. Vague contracts produce drifting
      implementations and weak reviews.

      **CLI features** — a command reference table:

          ## `<command-name>`

          **Synopsis**: `<binary> <command> [flags] <args>`

          **Description**: one sentence on what it does.

          **Args**:
            - `<arg1>` — type, required/optional, default.

          **Flags**:
            - `--flag-name` — type, required/optional,
              default, one-sentence description.

          **Output (text)**:
              <paste a sample block showing exactly what
              the text output looks like for the happy
              path>

          **Output (json)**:
              ```json
              { "example": "exact shape" }
              ```

          **Exit codes**:
            - 0 — success case
            - 1 — specific failure case
            - ... etc.

          **Error behaviors**:
            - malformed input → exit code, stderr message
            - missing resource → exit code, stderr message
            - duplicate / ambiguous match → exit code,
              stderr message

          **Examples**:
              <2-3 real invocations with their output>

      **API / library features** — a signature block plus
      error matrix:

          ## `<function-or-endpoint>`

          **Signature**: exact type signature (TS, Go,
          Python, etc.) or HTTP method/path + request
          body schema.

          **Returns**: exact return type / response shape.

          **Errors**: table of `Error type → When raised
          → Caller remediation`.

          **Auth**: required permissions / tokens, if any.

          **Migration / compatibility**: hot cut unless the
          brief explicitly requires compatibility or an
          additive/deprecation path.

      **Data / schema features** — a schema diff plus
      migration:

          ## Schema change

          **Before**: existing shape.
          **After**: new shape.
          **Migration**: hot cut / additive / rollback plan,
          whichever the brief explicitly requires.
          **Pre-existing data**: how it is handled.

      **UI features** — a state-transition sketch:

          ## Interaction model

          **Entry points**: where the user enters.
          **States**: list of states and transitions.
          **Loading / empty / error states**: each with
          a one-line description of what the user sees.
          **Accessibility**: keyboard, screen-reader,
          responsive requirements.

      **Refactor** — a scope and behavior-preservation
      statement:

          ## Scope
          **Files in scope**: list.
          **Files out of scope**: list.
          **Behavior preserved**: list of existing tests
          that must still pass verbatim.
          **Rollback**: one-line plan.

      **Other** — adapt the nearest format above, or
      produce a short "what success looks like" bullet
      list if none of the above fit.

      Once the contract artifact is written, paste the
      entire block into this task's Notes. It will be
      copied verbatim into the generated plan's
      `<<PLACEHOLDER_FEATURE_CONTRACT>>` marker in `draft_plan`,
      so the implementer reads it on every fresh task
      attempt and the reviewer cross-checks the final
      code against it in plan-coverage.

      If you are mid-task and realize the contract is
      still ambiguous on a dimension you missed in `capture_feature`,
      mark **this** task `blocked` with the missing
      dimension and targeted questions — same gate as
      `capture_feature`. It is better to catch a contract gap here
      than to let the implementer discover it.
  - id: draft_plan
    title: Draft the plan assignment file
    body: |
      Locate the reference template. It lives alongside this
      assignment's source file in one of:
        - `{{cwd}}/assignments/plan-feature/template.md`
        - `${TASK_RUNNER_CONFIG_DIR}/assignments/plan-feature/template.md`
        - under the task-runner install root

      Copy it to a new draft file at:

          ${TASK_RUNNER_STATE_DIR}/drafts/<repo-name>/plan-<slug>-<shortid>.md

      Create the repo-name drafts directory if it does not
      exist. `<repo-name>` is the basename of task-runner's
      resolved repo root for the current checkout, `<slug>` is the feature's kebab-cased
      short title (5 words or fewer), and `<shortid>` is any
      4-character base32 string, just to disambiguate multiple
      drafts for the same feature.

      The template's task list is a starting shape — not a
      fixed skeleton. Adjust it as the feature warrants:
        - Remove tasks that don't apply (e.g. no docs drift
          for an internal-only change).
        - Add feature-specific tasks where the default shape
          is too coarse (e.g. a data migration task, a
          schema-version bump task).
        - Rename tasks whose titles aren't descriptive for
          this feature.
        - Re-order where the dependency chain demands it.

      Rules you must not break:
        - Keep `schemaVersion: 1` and the `lockedFields:
          [tasks]` line in the frontmatter — once the draft
          is init'd, the executor must not be able to
          silently drop tasks at runtime.
        - Use semantic task ids that describe the work
          (`implement_core`, not `step_three`).
          Array order defines execution order; do not encode
          ordinals into ids.
        - Every task in the plan must begin its body with a
          `**Category**: <code-bearing|process|hybrid>` line.
          The reviewer's plan-coverage pass reads this tag
          to decide how to verify the task. Categories:
            - **code-bearing** — the task produces diff
              artifacts (code, tests, docs, changelog).
              The reviewer will cross-check the claimed
              work against the diff.
            - **process** — the task produces notes-only
              artifacts (orientation, check-gate exit
              codes, review run ids, summaries). The
              reviewer trusts status + notes without
              looking for a diff.
            - **hybrid** — the task MAY produce diff
              artifacts depending on what's needed (e.g.
              a fresh-eyes simplification pass that
              applies changes or finds none, a
              review-fix task that applies fixes or
              declines them all). The reviewer reads
              the task's Notes: if Notes claim diff
              artifacts, it verifies them; if Notes say
              "no changes needed", it accepts like a
              process task.
          The template's default task list is already
          tagged. If you add, rename, or replace tasks,
          you must tag every new or modified task.
        - Every **code-bearing** task in the plan must
          include a `**Done when:**` block immediately
          after the Category line. The block lists
          specific, test-backed completion criteria: not
          "implement foo" but "implement `foo()` in
          `src/bar.ts` such that `npm test -- bar.test.ts`
          passes and contains at least 3 new test cases
          covering the happy path, error path, and empty
          input." Vague "Done when" fields ("the feature
          works") defeat the purpose — the reviewer will
          flag them in plan-coverage. Hybrid tasks should
          include a "Done when" block only if they
          produce code; skip it for purely-process hybrid
          cases. Process tasks do not need "Done when"
          lines — their deliverable is the Notes block
          itself.
        - Keep a dedicated internal-review task that
          launches `{{task_runner_cmd}} run --agent code-reviewer
          --assignment code-review --var
          implementation_run_id={{run_id}} ...` so
          the reviewer sees the full plan context.
        - Keep a dedicated fresh-eyes simplification task
          that runs *before* the internal review — the
          point is to shorten the diff the reviewer has to
          read.
        - Keep a dedicated check-gate task citing the
          project's exact lint/build/test commands from
          `orient`.
        - Keep a dedicated docs-drift task unless the
          feature genuinely touches no documentation.
        - Make contract changes explicit. The generated plan
          should not tell the implementer to add fallback
          readers, heuristic detection, alias fields, or
          compatibility shims unless the caller explicitly
          requested that migration behavior.
        - The `<<PLACEHOLDER_FEATURE_CONTRACT>>` and
          `<<PLACEHOLDER_FEATURE_ASSUMPTIONS>>` blocks in the
          draft are the canonical copies. The later
          `produce_summary` task will diff its own Contract and
          Assumptions sections against these. If you edit the
          draft after `produce_summary` has run, re-run the
          summary step so the two stay in sync.

      Fill in every `<<PLACEHOLDER>>` marker with concrete,
      file-level detail from tasks `orient` through
      `produce_contract_artifact`. Placeholders
      that remain are a draft-quality failure — they leak
      into the implementer's workspace and produce vague
      execution.

      Three placeholders are load-bearing for the reviewer's
      plan-coverage pass:
        - `<<PLACEHOLDER_FEATURE_BRIEF>>` in the generated
          plan's first task — paste a 3-5 sentence summary
          of the feature from your `capture_feature` notes (what it is,
          why, in-scope, out-of-scope). The reviewer reads
          this via `implementation_run_id` to know what it is
          verifying.
        - `<<PLACEHOLDER_FEATURE_CONTRACT>>` in the same
          task — paste the entire contract artifact from
          your `produce_contract_artifact` notes, verbatim, inside a fenced block.
          The reviewer cross-checks the final implementation
          against this contract: every listed flag,
          every listed exit code, every listed sample
          output. A missing or stale contract here makes
          plan-coverage weaker than it should be.
        - `<<PLACEHOLDER_FEATURE_ASSUMPTIONS>>` in the same
          task — paste the explicit assumptions list you
          captured in `capture_feature` as a bulleted list. The reviewer
          cross-checks each assumption against the final
          implementation; silent assumption breakage is
          graded HIGH.

      Also fill `<<PLACEHOLDER_PLANNING_RUN_ID>>` with this
      run's id ({{run_id}}) so the implementer can pull
      additional planning context via `{{task_runner_cmd}} status`
      if needed.

      Validate frontmatter parses by eye before moving on:
      correct YAML indentation, balanced quoting, no TAB
      characters. Report the final draft path in this
      task's Notes.
  - id: review_draft
    title: Review the draft plan via task-runner
    body: |
      Before launching the draft review, finalize the planning
      evidence the reviewer depends on:

        1. Inspect this run's task state with
           `{{task_runner_cmd}} status {{run_id}} --output-format json --field tasks`
           and scan every task above this one.
           every task above this one.
        2. Every prior task must have status `completed`.
           If a prior task is still `in_progress`, `pending`,
           or `blocked`, fix that first.
        3. Every prior task must have a non-empty Notes block
           with concrete evidence: repo file paths, commands,
           contract details, reusable code references, and
           risks. The draft reviewer uses this run's canonical
           task state as
           ground truth for the feature brief, contract, and
           assumptions.
        4. Do not launch the draft reviewer against a half-
           finished planning workspace. A wasted review cycle
           is worse than a delayed one.

      Once the draft and planning evidence are finalized,
      launch the bundled `plan-review` assignment as a nested
      `{{task_runner_cmd}} run`:

          {{task_runner_cmd}} run \
            --agent code-reviewer \
            --assignment plan-review \
            --name <short-descriptive-name> \
            --var repo_path={{repo_path}} \
            --var plan_draft=<draft-path-from-draft_plan> \
            --var planning_run_id={{run_id}}

      The reviewer reads both artifacts:
        - `plan_draft` is the exact draft the caller will init.
        - `planning_run_id` is this planner run's own run id,
          which exposes the captured brief, contract, risks,
          and assumptions through canonical task state.

      Set `--name` to the same short topic label you expect the
      caller to use for the eventual implementer run:
        - first word capitalized
        - target 2-4 words and about 32 characters or less
        - omit redundant words already covered by the assignment
          such as `Plan`, `Review`, or `Implementation`
        - never include cwd paths, repo names, or git ranges
      Examples: `Run naming`, `Web dashboard`, `Daemon control plane`.

      The review produces its own run id. Capture that run id
      in this task's Notes immediately after launch. Once the
      review finishes, check its terminal status first:

          {{task_runner_cmd}} status <review-run-id> --output-format json \
            --field status

      The `plan-review` assignment ends with an `approval`
      task that gates whether the draft is ready to hand back:
        - `status: "success"` → the draft is approved.
        - `status: "blocked"` → the draft still needs fixes.

      Pull the reviewer's synthesis and approval decision:

          {{task_runner_cmd}} status <review-run-id> --output-format json \
            --field tasks | jq -r '.tasks[] | select(.id=="synthesis") | .notes'

          {{task_runner_cmd}} status <review-run-id> --output-format json \
            --field tasks | jq -r '.tasks[] | select(.id=="approval") | .notes'

      Paste the reviewer's synthesis and `approval` decision
      record into this task's Notes — raw, not summarized. If
      approval is BLOCKED, copy its "Path to approval" list
      here so `apply_review_fixes` knows exactly what to fix.

      This nested review consumes one level of `task-runner`
      recursion (planner → plan-review). If your environment
      disallows nested `task-runner run` calls, block here and
      surface that to the caller instead of continuing.
  - id: apply_review_fixes
    title: Apply draft-review fixes and request delta re-review
    body: |
      Work through the findings from `review_draft`:
        - For each finding you agree with, update the draft
          file and cite the changed section or line context in
          Notes.
        - For each finding you disagree with, write a short
          justification in Notes explaining why.
        - If the reviewer flags placeholders, vague task ids,
          missing `Done when:` criteria, weak handoff wording,
          or fallback/compatibility instructions that violate
          the plan, fix them here in the draft — do not defer
          them to the implementer.

      After applying fixes, resume the draft review run for a
      delta pass:

          {{task_runner_cmd}} run --resume-run <review-run-id> \
            "Draft updated. <one-line summary per prior finding>."

      The reviewer does a focused delta pass, not a full
      re-walk. Iterate until the review run's terminal status
      is `success`:

          {{task_runner_cmd}} status <review-run-id> --output-format json \
            --field status

      If it still returns `blocked`, read the updated
      `approval` decision record for the new "Path to
      approval" list, apply the remaining fixes, and resume
      again. Do not mark this task `completed` until the draft
      review run hits `success`.

      Paste the final delta synthesis and the final approved
      `approval` decision record into this task's Notes,
      replacing the earlier blocked versions. The audit trail
      of earlier passes lives in the review run itself.

      If the reviewer still refuses to approve after several
      passes and you disagree with the remaining blockers, mark
      **this** task `blocked` with an explanation — do not fake
      an approval by editing the review run directly.
  - id: produce_summary
    title: Produce human-facing summary artifact
    body: |
      **Category**: process

      Render the approved draft and your planning notes into a
      human-facing markdown summary the caller can skim before
      running the init command. This task is pure transformation
      of evidence you already captured — do **not** perform new
      analysis here. If something is missing, fix it in the
      upstream task's Notes and come back.

      Locate the summary reference template. It lives alongside
      this assignment's source file in one of:
        - `{{cwd}}/assignments/plan-feature/summary-template.md`
        - `${TASK_RUNNER_CONFIG_DIR}/assignments/plan-feature/summary-template.md`
        - under the task-runner install root

      Copy it to a new summary file next to the approved draft:

          ${TASK_RUNNER_STATE_DIR}/drafts/<repo-name>/plan-<slug>-<shortid>.summary.md

      Reuse the **exact** `<repo-name>`, `<slug>`, and `<shortid>`
      from the draft path captured in `draft_plan` so the two
      files remain a greppable pair.

      Fill each `<<PLACEHOLDER_*>>` marker in the template from
      your existing Notes:

        - `<<PLACEHOLDER_FEATURE_SHORT_TITLE>>` — the feature's
          short title (same one used in the draft filename and
          title).
        - `<<PLACEHOLDER_OVERVIEW>>` — one paragraph, plain
          language. Source: `capture_feature` (what is it).
        - `<<PLACEHOLDER_MOTIVATION>>` — one or two sentences.
          Source: `capture_feature` (why / what problem).
        - `<<PLACEHOLDER_IN_SCOPE>>` — bullet list. Source:
          `capture_feature`.
        - `<<PLACEHOLDER_OUT_OF_SCOPE>>` — bullet list. Source:
          `capture_feature`.
        - `<<PLACEHOLDER_CONTRACT>>` — paste the contract
          artifact **verbatim** from `produce_contract_artifact`
          Notes. Do not re-derive it; it must match the
          `<<PLACEHOLDER_FEATURE_CONTRACT>>` block you already
          pasted into the draft, character-for-character.
        - `<<PLACEHOLDER_SCHEMA>>` — for data/schema features,
          paste the before/after schema diff from
          `produce_contract_artifact`. For non-schema features,
          replace with `_No schema changes._`.
        - `<<PLACEHOLDER_IMPACT_TABLE>>` — markdown table with
          columns `File | Responsibility | Existing tests`.
          Source: `survey_impact`.
        - `<<PLACEHOLDER_HIGHER_LEVEL_STEPS>>` — 5 to 10 bullets
          describing the shape of the work, not the task-level
          detail. Source: synthesize from the draft's task
          titles and bodies. Aim for the level of detail a
          reviewer could skim in under a minute.
        - `<<PLACEHOLDER_DIAGRAMS>>` — Mermaid fenced blocks
          where they add signal (flowchart, sequence, ER,
          state). If no diagram would help, replace this marker
          with the literal line `_No diagrams applicable._` —
          do not invent diagrams to fill the section.
        - `<<PLACEHOLDER_RISKS>>` — bullet list. Source:
          `assess_risks_and_tests`.
        - `<<PLACEHOLDER_TEST_STRATEGY>>` — short paragraph or
          bullet list describing new tests and where they live.
          Source: `assess_risks_and_tests`.
        - `<<PLACEHOLDER_ASSUMPTIONS>>` — bullet list of the
          non-contract assumptions captured in `capture_feature`.
          Must match `<<PLACEHOLDER_FEATURE_ASSUMPTIONS>>` in
          the draft.

      Two consistency rules the reviewer and caller both rely
      on:

        1. The Contract block in the summary must match the
           `<<PLACEHOLDER_FEATURE_CONTRACT>>` block in the draft
           verbatim. Diff them by eye before you finish.
        2. The Open Assumptions block must match
           `<<PLACEHOLDER_FEATURE_ASSUMPTIONS>>` in the draft.
           Drift here is a silent failure — the summary tells
           the caller one story and the implementer reads
           another.

      Do not include resume instructions, redirect instructions,
      or meta-commentary about how to use the summary. The
      caller already knows how to resume planning or adjust the
      draft. The summary is purely a rendering of what the
      approved plan contains.

      Do not leave any `<<PLACEHOLDER_*>>` markers in the final
      file. Unfilled placeholders are a draft-quality failure.

      Report the final summary path in this task's Notes, plus
      a one-line confirmation that you diffed the Contract and
      Assumptions blocks against the draft and they match.
  - id: attach_artifacts
    title: Attach the approved draft artifacts to the planning run
    body: |
      **Category**: process

      Attach the two approved planning artifacts to **this**
      planning run so the caller can review them directly from
      the run context:

        - `assignment-seed.md` from `draft_plan`
        - `assignment-summary.md` from `produce_summary`

      Use `{{task_runner_cmd}} attachment add {{run_id}} ...` and
      record the resulting attachment ids in Notes.

      If you are re-running this task after revising the draft or
      summary, remove any older attachments with those same names
      first so the planning run ends with one current copy of
      each artifact.

      Verify the final state with `{{task_runner_cmd}} attachment list {{run_id}}`
      and paste the command output or equivalent attachment-id
      summary into Notes.
  - id: prepare_creation_followup
    title: Prepare the delayed implementer-run creation flow
    body: |
      Prepare the exact `{{task_runner_cmd}} init` command shape
      the planner will run **later** if the caller approves the
      plan and asks for implementer-run creation:

          {{task_runner_cmd}} init \
            --agent implementer \
            --backend passive \
            --assignment <draft-path-from-draft_plan> \
            --name <short-descriptive-name> \
            --var repo_path=<confirmed-worktree-dir>

      **Always use `--agent implementer --backend passive`.**
      The planner's job is to hand back an approved draft and
      later create an implementer run that carries the shared
      implementer instructions while keeping execution
      externally driven through the passive workflow.

      **Do not guess the target path.** If the caller later asks
      you to create the implementer run, first confirm the
      directory or worktree path they want. They may want a fresh
      worktree rather than the current repo path.

      **Always use a short descriptive `--name`.** It should:
      - start with a capitalized first word
      - target 2-4 words and about 32 characters or less
      - omit redundant words already covered by the assignment
        such as `Plan`, `Review`, or `Implementation`
      - never include cwd paths, repo names, or git ranges
      Examples: `Run naming`, `Web dashboard`, `Daemon control plane`.

      Capture the command shape in this task's Notes, but do
      **not** run it during the initial planning pass.

      Also capture the exact attachment-add commands the planner
      should run immediately after the later `init` succeeds:

          {{task_runner_cmd}} attachment add <new-run-id> <draft-path> --name assignment-seed.md
          {{task_runner_cmd}} attachment add <new-run-id> <summary-path> --name assignment-summary.md

      Also note:
      - the approved draft path from `draft_plan`
      - the approved summary path from `produce_summary`
      - the draft-review run id from `review_draft`
      - that the later `init` stdout/stderr will produce the new
        run id
      - that after the later `init` succeeds, the canonical
        execution surface is the new run id plus `task-runner brief <new-run-id>`
      - that the planner should attach the same two artifacts to
        the new run immediately after creation
  - id: handoff
    title: Handoff summary
    body: |
      Write a short Notes block capturing everything the
      caller needs to review the plan and decide whether to ask
      for implementer-run creation.

      Include:
        - **Draft path** from `draft_plan`.
        - **Summary path** from `produce_summary` — the human-
          facing markdown rendering of the approved plan. The
          caller can skim this to sanity-check scope and
          contract.
        - **Planning-run attachments** — explicitly name
          `assignment-seed.md` and `assignment-summary.md` and
          tell the caller those are attached to the planning run
          for review. Include the exact listing command:

              {{task_runner_cmd}} attachment list {{run_id}}
        - **Draft-review run id** from `review_draft`, so the
          caller can inspect the final draft-approval audit
          trail if desired.
        - **Feature summary** (one or two sentences from
          `capture_feature`).
        - **Follow-up workflow** from `prepare_creation_followup`:
          the caller should resume this planning run if they
          approve the plan and want you to create the
          implementer run.
        - A note that when resumed for creation, you will first
          confirm the target directory or worktree path before
          running `init`.
        - **Execution handoff** — the implementer execution
          surface is:

              {{task_runner_cmd}} brief <new-run-id>

          Because the implementer run is created with the
          `implementer` agent on the passive backend, do not
          tell the caller/executing agent to use
          `run --resume-run` here. Instruct them to use the run
          id plus `brief` and follow the task workflow from
          there.

        - A note that `<new-run-id>` comes from the later `init`
          output, not from the planning run itself.
        - A note that the caller environment must allow one
          nested `task-runner run`, because the generated plan
          runs a bundled `code-review` step.

        - **Open assumptions** from `capture_feature` that the caller
          should confirm before kicking off execution.
        - **Known risks or scope concerns** from `survey_impact`,
          `check_existing_code`, and `assess_risks_and_tests`
          that deserve a pre-execution sanity check.

      Keep this block tight. The caller will read it via
      `{{task_runner_cmd}} status {{run_id}}` and decide to
      proceed, request creation, adjust the plan, or hand off to
      a different agent. If there is nothing to flag, say so
      plainly.
---
You are planning, not implementing. Your output is a concrete,
executable `task-runner` assignment file — not the feature
itself.

The feature you are planning for was handed to you as the user
message that started this run. Read it before you start `orient`.
Do not fabricate scope.

Work on the repository at `{{repo_path}}`. You may read any
file under that repo freely. Do not modify any file under
`{{repo_path}}` — the only files you should write are:
  - This run's canonical task state via the task CLI.
  - The draft plan file you create in `draft_plan` under
    `${TASK_RUNNER_STATE_DIR}/drafts/<repo-name>/`.

Work the tasks in order. Earlier tasks build context the
later ones depend on. The draft plan in `draft_plan` should cite
specific files, functions, and commands from your earlier
notes — vague plans produce vague execution.

This run itself launches a nested `plan-review` task-runner
review against the draft. The caller environment must allow
that nested review. Surface the same requirement for the
implementer run in the final handoff, because the generated
plan also launches a nested `code-review` run.

The generated plan will use task-runner's existing
code-review assignment for its internal review step, invoked
as a nested `{{task_runner_cmd}} run`. This means whoever executes
the plan must run it in an environment that permits one nested
`task-runner run`. Surface this
requirement in the `handoff` summary so the caller does not
get bitten by it.

Prefer end-state designs in the generated plan. Avoid fallback
logic, heuristic detection, compatibility shims, alias fields,
and dual-shape readers unless the caller explicitly asked for
migration or backward-compatibility support. Default to hot-cut
contract changes.

You may delegate repo exploration (`survey_impact`) or
duplication scanning (`check_existing_code`) to native
subagents if that would parallelize your work. Do not
delegate `capture_feature` (the ambiguity gate must live in
your own context), `produce_contract_artifact` (the contract
is your deliverable), `draft_plan`, `review_draft`,
`apply_review_fixes`, `attach_artifacts`,
`prepare_creation_followup`, or `handoff` — those need to
live in your own context.

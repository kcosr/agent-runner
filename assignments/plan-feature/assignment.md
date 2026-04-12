---
schemaVersion: 1
name: plan-feature
sessionName: plan feature · {{repo_path}}
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

  Any general-purpose agent works (for example `example`). The
  planner doesn't need special role instructions — the detail
  lives in this assignment's task bodies. It does need shell
  access (`unrestricted: true`) so it can run
  `{{task_runner_cmd}} init` in `t08_init_run`.

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
    3. Runs `{{task_runner_cmd}} init --assignment <draft-path>` to
       freeze the draft into a new run workspace. This creates
       a new run id — the implementer's run id — which the
       planner records in its handoff task's notes.

  ## After planning

  Pull the new run id from the `t09_handoff` task's notes block:

      {{task_runner_cmd}} status {{run_id}}
      {{task_runner_cmd}} status {{run_id}} --output-format json \
        --field finalTasks

  To execute the plan:

      TASK_RUNNER_MAX_CALL_DEPTH=2 {{task_runner_cmd}} run \
        --resume-run <new-run-id>

  The depth override is required because the generated plan
  nests a `{{task_runner_cmd}} run` against the code-reviewer agent
  inside its review task. Default depth is 1; the implementer
  runs at depth 1 and the reviewer at depth 2, so without the
  override the review invocation is rejected.

  The executor may be the same agent that did the planning, or
  a different agent entirely — anchor the handoff on the run
  id, not the planning agent. Task-runner reconstructs agent
  identity from the frozen manifest either way.

  ## What happens to the draft file

  The draft under `${TASK_RUNNER_STATE_DIR}/drafts/<repo-name>/`
  is **superseded** the moment `{{task_runner_cmd}} init` succeeds.
  From that point on, the canonical artifact is the workspace
  `assignment.md` inside the new run directory. Edits to the
  draft file after init have no effect on the run. To change
  an initialized plan before execution, use `task set` /
  `task add` against the new run id, or resume the run with a
  follow-up message.

  The planner is instructed to delete the draft (or rename it
  to `*.init-source` for audit) at the end of `t08_init_run`
  so it cannot be confused with the live plan. If you see a
  leftover draft, the planning run did not finish cleanly —
  ignore it and work from the new run id.
tasks:
  - id: t01_orient
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
  - id: t02_capture_feature
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

      **Do not assume**. Do not proceed to t03 with
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
  - id: t03_impact_survey
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
  - id: t04_duplication_check
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

      This task is the primary defense against the plan
      producing accidental duplication. Take it seriously.
  - id: t05_risk_and_testing
    title: Risks, edge cases, and test strategy
    body: |
      For each impact area from t03, identify in Notes:
        - Concurrency, state-machine, or lifecycle risks
        - Error paths and edge cases the feature must
          handle (malformed inputs, missing files,
          permission errors, partial writes, cancellation)
        - Existing test coverage on the area, or the
          absence of it
        - New tests the feature will need — unit,
          integration, or end-to-end — and where they will
          live (file paths from t01 conventions)

      Also capture the exact check command(s) the project
      uses to gate commits (e.g. `npm run check`,
      `cargo test`, `pytest`). These will be cited verbatim
      by the generated plan's check-gate task.
  - id: t06_contract_artifact
    title: Produce the feature contract artifact
    body: |
      Before you draft the plan, pin down the exact shape
      of what the implementer is going to build. The
      contract dimensions you walked in t02 were the
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

          **Backwards-compat**: additive-only, deprecation
          path, or breaking with migration notes.

      **Data / schema features** — a schema diff plus
      migration:

          ## Schema change

          **Before**: existing shape.
          **After**: new shape.
          **Migration**: forward and rollback commands.
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
      `<<PLACEHOLDER_FEATURE_CONTRACT>>` marker in t07,
      so the implementer reads it on every fresh task
      attempt and the reviewer cross-checks the final
      code against it in plan-coverage.

      If you are mid-task and realize the contract is
      still ambiguous on a dimension you missed in t02,
      mark **this** task `blocked` with the missing
      dimension and targeted questions — same gate as
      t02. It is better to catch a contract gap here
      than to let the implementer discover it.
  - id: t07_draft_plan
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
          implementation_plan={{assignment_path}} ...` so
          the reviewer sees the full plan context.
        - Keep a dedicated fresh-eyes simplification task
          that runs *before* the internal review — the
          point is to shorten the diff the reviewer has to
          read.
        - Keep a dedicated check-gate task citing the
          project's exact lint/build/test commands from
          t01.
        - Keep a dedicated docs-drift task unless the
          feature genuinely touches no documentation.

      Fill in every `<<PLACEHOLDER>>` marker with concrete,
      file-level detail from tasks t01–t06. Placeholders
      that remain are a draft-quality failure — they leak
      into the implementer's workspace and produce vague
      execution.

      Three placeholders are load-bearing for the reviewer's
      plan-coverage pass:
        - `<<PLACEHOLDER_FEATURE_BRIEF>>` in the generated
          plan's first task — paste a 3-5 sentence summary
          of the feature from your t02 notes (what it is,
          why, in-scope, out-of-scope). The reviewer reads
          this via `implementation_plan` to know what it is
          verifying.
        - `<<PLACEHOLDER_FEATURE_CONTRACT>>` in the same
          task — paste the entire contract artifact from
          your t06 notes, verbatim, inside a fenced block.
          The reviewer cross-checks the final implementation
          against this contract: every listed flag,
          every listed exit code, every listed sample
          output. A missing or stale contract here makes
          plan-coverage weaker than it should be.
        - `<<PLACEHOLDER_FEATURE_ASSUMPTIONS>>` in the same
          task — paste the explicit assumptions list you
          captured in t02 as a bulleted list. The reviewer
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
  - id: t08_init_run
    title: Initialize the plan run
    body: |
      Run `{{task_runner_cmd}} init` against the draft from t07:

          {{task_runner_cmd}} init \
            --agent implementer \
            --assignment <draft-path-from-t07> \
            --var repo_path={{repo_path}}

      **Always use `--agent implementer`.** This is the
      bundled agent dedicated to plan execution — it is
      tuned to follow existing conventions, cite file paths,
      and capture concrete evidence in task Notes for the
      reviewer to consume. Do not substitute your own
      judgment on agent selection:

        - Do **not** use `code-reviewer`. It is explicitly
          instructed to read-only review work and will
          refuse to edit files. Using it as the implementer
          is the most common bad outcome of a free-form
          "pick an agent" instruction.
        - Do **not** reuse an ad-hoc agent configuration
          from your own planning invocation. The planner
          and the implementer have different jobs; the
          planner should not be leaking its own backend,
          model, or role into the frozen implementer
          manifest.
        - Do **not** accept an agent override from the
          feature brief. The caller should not specify an
          agent in the brief, and even if they do,
          `implementer` still wins at init time. The caller
          can override the agent on a later resume if they
          genuinely need to, but init's default must be
          stable and unambiguous.

      Capture the new run id from the init output in this
      task's Notes. From the moment init succeeds, the
      draft file under `${TASK_RUNNER_STATE_DIR}/drafts/<repo-name>/`
      is **no longer the working artifact** — the workspace
      `assignment.md` inside the new run directory is the
      canonical source of truth.

      **Delete the draft file after init succeeds.** Leaving
      it around is a UX footgun: a future reader might edit
      the draft and assume they changed the executable
      plan. Once `{{task_runner_cmd}} status <new-run-id>` confirms
      the workspace is healthy, `rm` the draft and note the
      deletion in this task's Notes. If you need the draft
      preserved for audit, rename it to
      `plan-<slug>-<shortid>.md.init-source` so it is
      obviously non-live.

      If init rejects the draft (missing required vars,
      invalid schema, unparseable frontmatter, locked-field
      conflict), do NOT silently retry with a different
      path. Fix the draft in place, re-run init, and record
      both the failure and the fix in Notes. A rejected
      draft is usually a frontmatter bug.
  - id: t09_handoff
    title: Handoff summary
    body: |
      Write a short Notes block capturing everything the
      caller needs to execute the plan. The new run id is
      the only artifact they need — do **not** surface the
      draft path here; the draft was deleted (or archived)
      at the end of t07, and treating it as a
      first-class output confuses the caller into editing
      the wrong file.

      Include:
        - **New run id** from t08 (this is the primary
          handoff — the caller resumes this id to execute).
        - **Feature summary** (one or two sentences from
          t02).
        - **Exact command** the caller should run to
          execute the plan, including the
          `TASK_RUNNER_MAX_CALL_DEPTH=2` export:

              TASK_RUNNER_MAX_CALL_DEPTH=2 {{task_runner_cmd}} run \
                --resume-run <new-run-id>

        - **Open assumptions** from t02 that the caller
          should confirm before kicking off execution.
        - **Known risks or scope concerns** from t03–t05
          that deserve a pre-execution sanity check.

      Keep this block tight. The caller will read it via
      `{{task_runner_cmd}} status {{run_id}}` and decide to
      proceed, adjust the plan, or hand off to a different
      agent. If there is nothing to flag, say so plainly.
---
You are planning, not implementing. Your output is a concrete,
executable `task-runner` assignment file — not the feature
itself.

The feature you are planning for was handed to you as the user
message that started this run. Read it before you start t01.
Do not fabricate scope.

Work on the repository at `{{repo_path}}`. You may read any
file under that repo freely. Do not modify any file under
`{{repo_path}}` — the only files you should write are:
  - Your own workspace plan at `{{assignment_path}}`.
  - The draft plan file you create in t07 under
    `${TASK_RUNNER_STATE_DIR}/drafts/<repo-name>/`.

Work the tasks in order. Earlier tasks build context the
later ones depend on. The draft plan in t07 should cite
specific files, functions, and commands from your earlier
notes — vague plans produce vague execution.

The generated plan will use task-runner's existing
code-review assignment for its internal review step, invoked
as a nested `{{task_runner_cmd}} run`. This means whoever executes
the plan must export `TASK_RUNNER_MAX_CALL_DEPTH=2` before
calling `{{task_runner_cmd}} run --resume-run`. Surface this
requirement in the t09 handoff summary so the caller does not
get bitten by it.

You may delegate repo exploration (t03) or duplication
scanning (t04) to native subagents if that would parallelize
your work. Do not delegate t02 (feature capture — the
ambiguity gate must live in your own context), t06 (contract
artifact — the contract is your deliverable), t07 (draft
writing), t08 (init run), or t09 (handoff) — those need to
live in your own context.

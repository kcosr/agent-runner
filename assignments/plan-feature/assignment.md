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

      task-runner run \
        --agent <your-planner-agent> \
        --assignment plan-feature \
        --var repo_path=/abs/path/to/target/repo \
        "$(cat /tmp/feature-brief.md)"

  Any general-purpose agent works (for example `example`). The
  planner doesn't need special role instructions — the detail
  lives in this assignment's task bodies. It does need shell
  access (`unrestricted: true`) so it can run
  `task-runner init` in `t07_init_run`.

  ## What the planner does

    1. Reads the target repo's conventions, identifies the
       impact surface, checks for reusable existing code, and
       maps out risks and tests.
    2. Copies the reference template from
       `assignments/plan-feature/template.md` into
       `.task-runner/drafts/plan-<slug>-<shortid>.md`, adjusts
       the task list to fit the feature, and fills in every
       `<<PLACEHOLDER>>` with concrete steps. The template's
       task list is a starting shape; the planner may add,
       remove, or rename tasks so long as the
       `lockedFields: [tasks]` line stays in the frontmatter.
    3. Runs `task-runner init --assignment <draft-path>` to
       freeze the draft into a new run workspace. This creates
       a new run id — the implementer's run id — which the
       planner records in its handoff task's notes.

  ## After planning

  Pull the new run id from the `t08_handoff` task's notes block:

      task-runner status {{run_id}}
      task-runner status {{run_id}} --output-format json \
        --field finalTasks

  To execute the plan:

      TASK_RUNNER_MAX_CALL_DEPTH=2 task-runner run \
        --resume-run <new-run-id>

  The depth override is required because the generated plan
  nests a `task-runner run` against the code-reviewer agent
  inside its review task. Default depth is 1; the implementer
  runs at depth 1 and the reviewer at depth 2, so without the
  override the review invocation is rejected.

  The executor may be the same agent that did the planning, or
  a different agent entirely — anchor the handoff on the run
  id, not the planning agent. Task-runner reconstructs agent
  identity from the frozen manifest either way.

  ## What happens to the draft file

  The draft under `.task-runner/drafts/` is **superseded** the
  moment `task-runner init` succeeds. From that point on, the
  canonical artifact is the workspace `assignment.md` inside
  the new run directory. Edits to the draft file after init
  have no effect on the run. To change an initialized plan
  before execution, use `task set` / `task add` against the
  new run id, or resume the run with a follow-up message.

  The planner is instructed to delete the draft (or rename it
  to `*.init-source` for audit) at the end of `t07_init_run`
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
        - What assumptions are you making where the brief is
          silent? List each one — they become validation
          points for the review step later.

      If the brief included a rough implementation plan,
      capture every concrete step mentioned, even the ones
      you don't yet fully understand. Your job as planner is
      to refine those steps into an executable task list,
      not to discard them.

      If the brief is ambiguous on something material, write
      the ambiguity down and state the assumption you are
      making. Do not block — the caller will confirm or
      correct in the handoff review.
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
  - id: t06_draft_plan
    title: Draft the plan assignment file
    body: |
      Locate the reference template. It lives alongside this
      assignment's source file in one of:
        - `{{cwd}}/assignments/plan-feature/template.md`
        - `$TASK_RUNNER_HOME/assignments/plan-feature/template.md`
        - under the task-runner install root

      Copy it to a new draft file at:

          {{cwd}}/.task-runner/drafts/plan-<slug>-<shortid>.md

      Create the `drafts` directory if it does not exist.
      `<slug>` is the feature's kebab-cased short title
      (5 words or fewer); `<shortid>` is any 4-character
      base32 string, just to disambiguate multiple drafts
      for the same feature.

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
        - Keep a dedicated internal-review task that
          launches `task-runner run --agent code-reviewer
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
      file-level detail from tasks t01–t05. Placeholders
      that remain are a draft-quality failure — they leak
      into the implementer's workspace and produce vague
      execution.

      Two placeholders are load-bearing for the reviewer's
      plan-coverage pass:
        - `<<PLACEHOLDER_FEATURE_BRIEF>>` in the generated
          plan's first task — paste a 3-5 sentence summary
          of the feature from your t02 notes (what it is,
          why, in-scope, out-of-scope). The reviewer reads
          this via `implementation_plan` to know what it is
          verifying.
        - `<<PLACEHOLDER_FEATURE_ASSUMPTIONS>>` in the same
          task — paste the explicit assumptions list you
          captured in t02 as a bulleted list. The reviewer
          cross-checks each assumption against the final
          implementation; silent assumption breakage is
          graded HIGH.

      Also fill `<<PLACEHOLDER_PLANNING_RUN_ID>>` with this
      run's id ({{run_id}}) so the implementer can pull
      additional planning context via `task-runner status`
      if needed.

      Validate frontmatter parses by eye before moving on:
      correct YAML indentation, balanced quoting, no TAB
      characters. Report the final draft path in this
      task's Notes.
  - id: t07_init_run
    title: Initialize the plan run
    body: |
      Run `task-runner init` against the draft from t06:

          task-runner init \
            --agent <planner-or-caller-choice> \
            --assignment <draft-path-from-t06> \
            --var repo_path={{repo_path}}

      Pick the agent the caller is most likely to use for
      execution. If you are uncertain, use the same agent
      that is executing this planning run — the handoff
      summary in t08 will make it clear the caller can pick
      a different agent if they prefer.

      Capture the new run id from the init output in this
      task's Notes. From the moment init succeeds, the
      draft file under `.task-runner/drafts/` is **no
      longer the working artifact** — the workspace
      `assignment.md` inside the new run directory is the
      canonical source of truth.

      **Delete the draft file after init succeeds.** Leaving
      it around is a UX footgun: a future reader might edit
      the draft and assume they changed the executable
      plan. Once `task-runner status <new-run-id>` confirms
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
  - id: t08_handoff
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
        - **New run id** from t07 (this is the primary
          handoff — the caller resumes this id to execute).
        - **Feature summary** (one or two sentences from
          t02).
        - **Exact command** the caller should run to
          execute the plan, including the
          `TASK_RUNNER_MAX_CALL_DEPTH=2` export:

              TASK_RUNNER_MAX_CALL_DEPTH=2 task-runner run \
                --resume-run <new-run-id>

        - **Open assumptions** from t02 that the caller
          should confirm before kicking off execution.
        - **Known risks or scope concerns** from t03–t05
          that deserve a pre-execution sanity check.

      Keep this block tight. The caller will read it via
      `task-runner status {{run_id}}` and decide to
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
  - The draft plan file you create in t06 under
    `{{cwd}}/.task-runner/drafts/`.

Work the tasks in order. Earlier tasks build context the
later ones depend on. The draft plan in t06 should cite
specific files, functions, and commands from your earlier
notes — vague plans produce vague execution.

The generated plan will use task-runner's existing
code-review assignment for its internal review step, invoked
as a nested `task-runner run`. This means whoever executes
the plan must export `TASK_RUNNER_MAX_CALL_DEPTH=2` before
calling `task-runner run --resume-run`. Surface this
requirement in the t08 handoff summary so the caller does not
get bitten by it.

You may delegate repo exploration (t03) or duplication
scanning (t04) to native subagents if that would parallelize
your work. Do not delegate t02 (feature capture), t06 (draft
writing), t07 (init run), or t08 (handoff) — those need to
live in your own context.

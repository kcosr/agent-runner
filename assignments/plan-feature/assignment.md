---
schemaVersion: 1
name: plan-feature
vars:
  worktree_slug:
    type: string
    required: true
    sources: [cli, web]
    description: |
      Git-safe slug used to derive the sibling implementer
      worktree path and branch name.
  worktree_base_ref:
    type: string
    required: false
    sources: [cli, web]
    default: origin/main
    description: |
      Git ref used as the base for generated implementation
      worktrees. Defaults to origin/main. Override for pre-merge
      end-to-end testing from a feature branch, for example
      origin/my-feature-branch. Must match
      [A-Za-z0-9][A-Za-z0-9._/-]* so generated git commands
      receive a shell-safe ref value.
hooks:
  prepare:
    - path: hooks/derive-worktree-vars.ts
maxRetries: 4
callerInstructions: |
  This assignment turns a free-form feature description into an
  executable task-runner plan. The feature summary and any
  rough implementation notes go in as the positional message
  body when you invoke task-runner — not as a var — so there
  is no length limit.

  ## Invoking the planner

  Run this from the target repo root. Pass a short slug that
  the planner can freeze into descendant worktree vars:

      {{task_runner_cmd}} run \
        --agent <your-planner-agent> \
        --assignment plan-feature \
        --var worktree_slug=<git-safe-slug> \
        --var worktree_base_ref=origin/<feature-branch> \
        "$(cat /tmp/feature-brief.md)"

  `worktree_base_ref` is optional. Omit it for normal main-based
  planning; pass it only when pre-merge end-to-end testing should
  generate implementation worktrees from another safe git ref.

  Use the bundled `planner` agent or another unrestricted
  general-purpose agent. The planner needs shell access
  (`unrestricted: true`) so it can inspect the repo, create
  temporary construction artifacts, initialize the implementer
  run, and launch `plan-review`. The caller environment must
  allow one nested `task-runner run`.

  ## What the planner does

    1. Reads the target repo's conventions, identifies the
       impact surface, checks for reusable existing code, and
       maps out risks and tests.
    2. Copies the reference template into a temporary scratch
       `assignment-seed.md`, adjusts the task list to fit the
       feature, and fills in every `<<PLACEHOLDER>>` with
       concrete steps. The temp file is a construction artifact,
       not the durable handoff surface.
    3. Produces `assignment-summary.md` in the same temp
       scratch directory and attaches both artifacts to the
       planning run.
    4. Initializes the implementer run in `initialized` state.
       The initialized run is the canonical execution object.
    5. Runs the bundled `plan-review` assignment against the
       initialized run, passing `initialized_run_id` and
       `planning_run_id`. The reviewer inspects run state,
       brief, caller instructions, planning notes, and
       group-scoped attachments.
    6. Applies review fixes by updating temp artifacts,
       replacing planning-run attachments, reinitializing the
       same initialized implementer run with `init --run-id`,
       and resuming the same review run for a delta pass.
    7. Finishes with a handoff that tells the caller to review
       `run inspect`, group attachments, `run brief`, `run ready`,
       and `run --resume-run`.

  ## After planning

  Pull the handoff summary and attachment info from the
  `handoff` task's notes block:

      {{task_runner_cmd}} run status {{run_id}}
      {{task_runner_cmd}} run status {{run_id}} --output-format json \
        --field tasks

  Review the initialized implementer run and group attachments:

      {{task_runner_cmd}} run inspect <implementer-run-id>
      {{task_runner_cmd}} attachment list <implementer-run-id> --scope group
      {{task_runner_cmd}} attachment list <implementer-run-id> --scope group --output-format json
      {{task_runner_cmd}} attachment download <ownerRunId> <id> /tmp/some-dir/
      {{task_runner_cmd}} run brief <implementer-run-id>
      {{task_runner_cmd}} run ready <implementer-run-id>
      {{task_runner_cmd}} run --resume-run <implementer-run-id>

  In group-scoped attachment JSON, download rows using the row
  `ownerRunId` plus row `id`; planning artifacts usually remain
  owned by the planning run.

  Nested review must be allowed at both stages:
  - the planner run nests `plan-review`
  - the generated implementation plan nests `code-review`

  If nested `task-runner run` invocations are disallowed in the
  surrounding environment, the review step will be rejected.

  The executor may be the same agent that did the planning, or
  a different agent entirely — anchor the handoff on the run
  id, not the planning agent. Task-runner reconstructs agent
  identity from the frozen manifest either way.

  ## What happens to temp files

  Draft and summary files are temporary construction artifacts.
  The durable handoff surfaces are the initialized implementer
  run and the planning-run attachments. Edits to temp files after
  init have no effect on the initialized run unless the planner
  explicitly reruns `init --run-id <implementer-run-id>` against
  the updated draft and refreshes the planning-run attachments.
tasks:
  - id: orient
    title: Target repo orientation and conventions
    body: |
      Read the high-signal entry points for the repository at
      `{{cwd}}`:
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
        - Shared paths the change would touch: parsers,
          dispatchers, request/response builders, state reducers,
          serializers, config loaders, lifecycle/workflow handlers,
          database access layers, UI state transitions, or other
          reused infrastructure, plus representative existing sibling
          behaviors that also flow through that path

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
        - For any shared path that will be reordered, hoisted,
          cached, centralized, split, or otherwise changed around
          parsing, normalization, validation, state construction,
          lifecycle transitions, or request/response projection:
          representative existing sibling behaviors to test, or the
          exact existing coverage that is sufficient and can be cited

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

      Also include a Surface Inventory section in these Notes.
      For every named user-facing entity this feature introduces,
      modifies, or removes, list the literal name, disposition
      (`added`, `changed`, or `removed`), layers it must traverse,
      symmetric peers, and removal twin if any. If the feature has
      no user-visible surface change, write the explicit line:

          No user-visible surfaces are introduced, changed, or removed by this feature.

      The `draft_plan` and `produce_summary` tasks copy this
      section into the generated implementer plan and summary.

      If you are mid-task and realize the contract is
      still ambiguous on a dimension you missed in `capture_feature`,
      mark **this** task `blocked` with the missing
      dimension and targeted questions — same gate as
      `capture_feature`. It is better to catch a contract gap here
      than to let the implementer discover it.
  - id: draft_plan
    title: Draft the plan assignment file
    body: |
      Locate the reference template in `{{cwd}}/assignments/plan-feature/template.md`,
      `{{config_dir}}/assignments/plan-feature/template.md`, or under the task-runner
      install root.

      Create a temporary scratch directory and copy the template there as
      `assignment-seed.md`:

          scratch_dir=$(mktemp -d)
          draft_path="$scratch_dir/assignment-seed.md"

      The temp draft is a construction file only. The durable execution surface
      will be the initialized implementer run; the durable human/audit artifacts
      will be planning-run attachments.

      Adjust the template as the feature warrants. Keep `schemaVersion: 1` and
      `lockedFields: [tasks]`, use semantic task ids, tag every task body with
      `**Category**: ...`, and give every code-bearing task a concrete
      `**Done when:**` block. Keep check-gate, docs-drift when relevant,
      fresh-eyes, commit, internal_review, apply_review_fixes, self_check,
      and push_branch_and_create_pr coverage.

      Fill every placeholder with concrete file paths, commands, checks, and
      evidence from earlier Notes. The generated plan must include the feature
      brief, contract, surface inventory or explicit no-surfaces statement,
      assumptions, and planning run id `{{run_id}}`.

      Report the temp scratch directory and final draft path in Notes. Also
      record that the draft is a temp construction artifact, not a durable
      handoff surface.
  - id: produce_summary
    title: Produce human-facing summary artifact
    body: |
      **Category**: process

      Render the draft and planning notes into a human-facing markdown summary.
      Use the summary template from `{{cwd}}/assignments/plan-feature/summary-template.md`,
      `{{config_dir}}/assignments/plan-feature/summary-template.md`, or under
      the task-runner install root.

      Write the summary into the same temp scratch directory as the draft, named
      `assignment-summary.md`. The summary is also a construction file until
      `attach_artifacts` stores it on the planning run.

      Fill every placeholder from existing Notes. The Contract, Surface Inventory,
      and Assumptions sections must match the corresponding blocks in the draft.
      Do not perform new analysis here; fix upstream Notes first if evidence is
      missing.

      Report the summary path in Notes plus a one-line confirmation that Contract,
      Surface Inventory, and Assumptions match the draft.
  - id: attach_artifacts
    title: Attach planning artifacts to the planning run
    body: |
      **Category**: process

      Attach the current temp artifacts to this planning run:
        - `assignment-seed.md` from `draft_plan`
        - `assignment-summary.md` from `produce_summary`

      Use:

          {{task_runner_cmd}} attachment add {{run_id}} <draft-path> --name assignment-seed.md
          {{task_runner_cmd}} attachment add {{run_id}} <summary-path> --name assignment-summary.md

      If this is a replacement pass, remove older attachments with those same
      names first so the planning run has one current copy of each artifact.
      Do not duplicate these artifacts onto the implementer run.

      Verify with:

          {{task_runner_cmd}} attachment list {{run_id}}
          {{task_runner_cmd}} attachment list {{run_id}} --scope group --output-format json

      Notes must include attachment ids, names, owner run ids, and commands/results.
  - id: create_initialized_implementer_run
    title: Create the initialized implementer run
    body: |
      **Category**: process

      Create the implementer run during the initial planning pass, after the
      summary and planning-run attachments exist and before `plan-review` runs.

      Confirm the target repo root, `worktree_slug`, derived `worktree_path`,
      and inherited `worktree_base_ref` before running `init`. If the draft
      declares descendant vars with `sources: [parent]`, rely on lineage
      inheritance; do not add redundant `--var` flags.

      First-pass init command:

          {{task_runner_cmd}} init \
            --agent implementer \
            --assignment <draft-path-from-draft_plan> \
            --name <short-descriptive-name>

      Do not force `--backend passive`. Do not override `--cwd` when the draft
      authors cwd from inherited vars. Use a short descriptive name: capitalized
      first word, 2-4 words, about 32 characters or less, no cwd/repo/range
      noise, and no redundant Plan/Review/Implementation wording.

      This task covers first-pass init only. If initialized-plan review blocks,
      reinitialization happens in `apply_review_fixes`. Final approval/execution
      instructions belong in `handoff`.

      Completion Notes must include the draft path, summary path, exact init
      command, confirmed target directory/worktree path, implementer run id,
      and proof that the run is left `initialized`, not `ready`. Also state
      that planning artifacts remain attached to the planning run and are
      discoverable from the implementer run via group-scoped attachment listing.
  - id: review_initialized_plan
    title: Review the initialized implementer run
    body: |
      **Category**: process

      Launch the bundled `plan-review` assignment against the initialized
      implementer run and this planning run:

          {{task_runner_cmd}} run \
            --agent code-reviewer \
            --assignment plan-review \
            --name <short-descriptive-name> \
            --cwd {{cwd}} \
            --var initialized_run_id=<implementer-run-id> \
            --var planning_run_id={{run_id}}

      The reviewer must inspect the initialized run, status JSON, planning
      task JSON, group attachment JSON, downloaded `assignment-seed.md`,
      downloaded `assignment-summary.md`, run brief, and caller instructions.

      Capture the review run id in Notes. When it finishes, record terminal
      status plus raw synthesis and approval notes:

          {{task_runner_cmd}} run status <review-run-id> --output-format json --field status
          {{task_runner_cmd}} run status <review-run-id> --output-format json --field tasks | jq -r '.tasks[] | select(.id=="synthesis") | .notes'
          {{task_runner_cmd}} run status <review-run-id> --output-format json --field tasks | jq -r '.tasks[] | select(.id=="approval") | .notes'

      If approval is blocked, copy the Path to approval into Notes for
      `apply_review_fixes`. This nested review consumes one level of
      `task-runner` recursion; block here if the environment disallows nested runs.
  - id: apply_review_fixes
    title: Apply initialized-review fixes and request delta re-review
    hooks:
      - builtin: require-children-success
        with:
          requireAny: true
    body: |
      **Category**: hybrid

      Work through findings from `review_initialized_plan`. For each finding
      you agree with, apply the fix and cite changed files or artifact sections
      in Notes. For each finding you decline, write a short justification.

      Before resuming the same review run, perform all five steps:

      1. Update or recreate the draft assignment file in the temp scratch directory.
      2. Regenerate or update `assignment-summary.md` in the same temp scratch directory.
      3. Remove and replace the planning-run `assignment-seed.md` and
         `assignment-summary.md` attachments.
      4. Reinitialize the same initialized implementer run:

             {{task_runner_cmd}} init --run-id <existing-implementer-run-id> \
               --agent implementer \
               --assignment <updated-draft-path> \
               --name <same-short-descriptive-name>

      5. Resume the same plan-review run:

             {{task_runner_cmd}} run --resume-run <review-run-id> \
               "Updated initialized run and refreshed attachments. <summary of fixes>."

      Iterate until the review run reaches `success`. Paste final delta synthesis
      and approval notes here. Do not complete this task while initialized-plan
      review is still blocked.
  - id: handoff
    title: Handoff summary
    body: |
      **Category**: process

      Write a concise Notes block with everything the caller needs to review
      and approve execution.

      Include the temp draft path and temp summary path for audit context,
      planning-run attachment ids for `assignment-seed.md` and
      `assignment-summary.md`, initialized plan-review run id, implementer
      run id, feature summary, open assumptions, notable risks, whether this
      follows reinitialization after review fixes, and a clear statement that
      the durable handoff surfaces are the initialized implementer run and
      planning-run attachments.

      Include these exact caller commands:

          {{task_runner_cmd}} run inspect <implementer-run-id>
          {{task_runner_cmd}} attachment list <implementer-run-id> --scope group
          {{task_runner_cmd}} attachment list <implementer-run-id> --scope group --output-format json
          {{task_runner_cmd}} attachment download <ownerRunId> <id> /tmp/some-dir/
          {{task_runner_cmd}} run brief <implementer-run-id>
          {{task_runner_cmd}} run ready <implementer-run-id>
          {{task_runner_cmd}} run --resume-run <implementer-run-id>

      Remind the caller that group-scoped attachment downloads must use row
      `ownerRunId` plus row `id`, and that the generated implementation plan
      launches one nested `code-review` run.
---
You are planning, not implementing. Your output is an initialized
implementer run plus planning-run attachments, not just a file path.

The feature you are planning for was handed to you as the user
message that started this run. Read it before you start `orient`.
Do not fabricate scope.

Work on the repository at `{{cwd}}`. You may read any file under that
repo freely. Do not modify source files under `{{cwd}}`; write only
this run's canonical task state and temporary scratch artifacts created by
`draft_plan` / `produce_summary`.

Work the tasks in order. Earlier tasks build context the later ones
depend on. The temp assignment and summary files are construction
artifacts; the durable handoff is the initialized implementer run plus
planning-run attachments.

This run launches a nested `plan-review` task-runner review against the
initialized implementer run. The generated implementation plan also
launches a nested `code-review` run, so surface the recursion requirement
in `handoff`.

Prefer end-state designs in the generated plan. Avoid fallback logic,
heuristic detection, compatibility shims, alias fields, and dual-shape
readers unless the caller explicitly asked for migration or
backward-compatibility support.

You may delegate repo exploration (`survey_impact`) or duplication
scanning (`check_existing_code`) to native subagents if that would
parallelize your work. Do not delegate `capture_feature`,
`produce_contract_artifact`, `draft_plan`, `produce_summary`,
`attach_artifacts`, `create_initialized_implementer_run`,
`review_initialized_plan`, `apply_review_fixes`, or `handoff`; those
need to live in your own context.

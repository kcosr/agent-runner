# Changelog

## [Unreleased]

### Breaking Changes

- Replaced the previous single-root runtime env var and cwd-local bare-name definition lookup with split XDG-style roots: `TASK_RUNNER_CONFIG_DIR` for named agent/assignment definitions and `TASK_RUNNER_STATE_DIR` for runtime state. Bare names now resolve only from the config root, and run workspaces now live under repo-scoped state buckets instead of `<cwd>/.task-runner/`. ([#8](https://github.com/kcosr/task-runner/pull/8))
- Direct file-path args are now recognized only when the argument contains `/` or starts with `./`; bare names no longer implicitly resolve from the repo checkout. ([#8](https://github.com/kcosr/task-runner/pull/8))
- Run workspace and draft buckets under `${TASK_RUNNER_STATE_DIR}/runs/` and `${TASK_RUNNER_STATE_DIR}/drafts/` now use the repo basename (for example `task-runner`) instead of a slugified absolute repo path. Existing runs remain on disk at their old locations, but short-id lookup now resolves against the new basename bucket unless you resume by explicit workspace path. ([#10](https://github.com/kcosr/task-runner/pull/10))

### Added

- Added `task-runner task list`, `task show`, and `task append-notes`, plus `task add --body`, for a fuller CLI task workflow surface. The new read commands return stable task snapshots in text or JSON, and append-notes uses deterministic single-newline joining.
- Added `--task-mode <file|cli>` as a fresh run / init override for assignment task workflow mode. The selected mode is now also lockable via `lockedFields: [taskMode]` and remains frozen on resume. ([#10](https://github.com/kcosr/task-runner/pull/10))
- Added `agents/implementer/` — a bundled plan-feature execution agent (backend `codex`, model `gpt-5.4`, effort `high`, unrestricted). Tuned to read task bodies and `Done when:` criteria end-to-end, cite file paths in task Notes, and capture concrete evidence (file paths, exit codes, commit shas) for the reviewer's plan-coverage pass to consume. The `plan-feature` meta-assignment now hard-codes `--agent implementer` at `task-runner init` time, so every generated plan inherits a dedicated implementer agent instead of whatever the planner happened to pick.
- Added `task-runner list <agents|assignments>` and `task-runner show <agent|assignment> <name|path>` commands for read-only definition inspection. Both discover named definitions from the configured task-runner config root, support `--output-format json`, and create no run artifacts. ([#8](https://github.com/kcosr/task-runner/pull/8))
- Added agent onboarding guidance in `AGENTS.md` and a `CLAUDE.md` symlink to the same content. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Added a root `CHANGELOG.md` with unreleased and release-section structure for future updates. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Added stricter assignment/task regression coverage for structural markdown escaping, task-command terminal-state handling, runtime var validation, Codex interruption, and subprocess abort paths. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Added `assignments/plan-feature/` — a meta-assignment that turns a free-form feature description (passed as the positional message body) into an executable task-runner plan. The planner surveys repo conventions, impact surface, reuse opportunities, and risks, then copies a reference template into the repo-name task-runner drafts area under `${TASK_RUNNER_STATE_DIR}/drafts/`, fills in every placeholder with concrete file-level detail, and runs `task-runner init` to freeze the draft into a new run workspace that any agent can resume. ([#8](https://github.com/kcosr/task-runner/pull/8))
- Added `TASK_RUNNER_CMD` and the runner-injected `{{task_runner_cmd}}` template variable so user-facing workflow instructions can point at the installed `task-runner` command path instead of hardcoding the bare command name. ([#9](https://github.com/kcosr/task-runner/pull/9))

### Changed

- Assignment config now supports `taskMode: file | cli` with default `file`. `taskMode=cli` switches prompts to a run-id-and-command workflow, treats `run.json.finalTasks` as canonical live task state, and renders `assignment.md` as an audit projection instead of a live input surface.
- Running non-passive CLI-mode runs now allow `task set` and `task append-notes` during execution through a shared per-run persistence lock. `task add` remains rejected while a run is in flight.
- `agents/code-reviewer/` flipped from `codex` / `gpt-5.3-codex` to `claude` / `claude-opus-4-6`. The role body and severity format are unchanged; only the backend and model. Plan-feature-driven reviews now run on opus without needing template-level `--backend` / `--model` overrides. Callers that want the old configuration can still override via `--backend codex --model gpt-5.3-codex` at run time.
- Shared workspace task-state loading and persistence between the run loop and CLI task commands so assignment overlays, manifest snapshots, and canonical writes follow one code path. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Updated the standard verification workflow so `npm run check` runs build, lint, and test coverage together. ([#6](https://github.com/kcosr/task-runner/pull/6))
- `assignments/code-review/` now accepts an optional `implementation_plan` var pointing at a task-runner workspace `assignment.md`. When set, a new `t12_plan_coverage` task verifies that every task in the referenced plan actually shipped in the diff — flagging silent deferrals and dropped review fixes at HIGH/CRITICAL severity. The synthesis task is renumbered to `t13_synthesis` and folds plan-coverage findings into its ranked list. Reviews launched without the var skip the plan-coverage pass cleanly.
- `assignments/code-review/` now ends with an explicit `t14_approval` ship / no-ship decision task. The task lives separately from the synthesis so the reviewer's *decision* ("I approve this work") is distinct from the synthesis *deliverable* ("here is the ranked findings list"). Review runs exit `success` (code 0) only when the reviewer approves; unresolved HIGH/CRITICAL findings or open plan-coverage gaps mark the task `blocked` and the run exits `blocked` (code 2), giving scripts a first-class ship gate. Delta re-reviews re-evaluate the approval against the post-fix state and preserve prior decision records for audit.
- `assignments/plan-feature/` now runs an ambiguity gate in `t02_capture_feature` that enumerates contract dimensions by feature type (CLI, API, data/schema, UI, refactor, other) and requires the planner to mark the task `blocked` with up to three targeted questions if any dimension is unanswered — preventing guessed requirements from silently propagating into the plan. Adds a new `t06_contract_artifact` task that produces a concrete, greppable contract deliverable (command tables, signatures, schema diffs, etc.) which the implementer and reviewer both work from. Requires every code-bearing task in the generated plan to carry a `**Done when:**` block with test-backed completion criteria, verified by the reviewer's plan-coverage pass. The implementer template's `t01_orient` now inlines `<<PLACEHOLDER_FEATURE_CONTRACT>>` so the reviewer sees the contract when reading the implementer's workspace, and the template's `callerInstructions` explain the reviewer-reads-the-implementer's-workspace wiring directly to reduce misconceptions. A new `t11_commit` task finalizes git state at the end of every plan run.

### Fixed

- Fixed `assignments/plan-feature/` `t08_init_run` to hard-code `--agent implementer` at init time instead of letting the planner pick an arbitrary agent. The previous "pick the agent the caller is most likely to use" guidance was too vague for ad-hoc planner invocations, which in the first live plan-feature run produced an implementer workspace frozen to `code-reviewer` — a read-only agent that would have refused to edit files. The new wording lists explicit anti-patterns (don't use `code-reviewer`, don't reuse the planner's ad-hoc config, don't accept overrides from the feature brief) to make the correct choice unambiguous.
- Fixed workspace persistence to use atomic writes for manifests, attempt logs, and assignment files, and reject resume targets whose manifest paths do not match the workspace they were loaded from. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Fixed Codex timeout/abort cleanup to wait for late-arriving turn ids and retry interruption, reducing the risk of orphaned remote turns. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Fixed assignment/task mutation hardening around structural marker escaping, single-line task titles, terminal non-passive notes-only edits, and undeclared or mistyped runtime vars. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Fixed subprocess handling to short-circuit pre-aborted launches before spawning child processes. ([#6](https://github.com/kcosr/task-runner/pull/6))

### Removed

## [0.1.0] - 2026-04-11

### Breaking Changes

### Added

- Initial `task-runner` release: CLI support for `run`, `init`, `status`, and `task` workflows backed by manifest-canonical workspaces.
- Built-in Claude, Codex, and passive backend support, markdown assignment/task parsing, and resume-aware run persistence.
- Test coverage for lifecycle, resume, passive mode, validation, subprocess handling, and task mutation flows.
- Project documentation covering usage and runtime design.

### Changed

### Fixed

### Removed

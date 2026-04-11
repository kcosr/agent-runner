# Changelog

## [Unreleased]

### Breaking Changes

### Added

- Added agent onboarding guidance in `AGENTS.md` and a `CLAUDE.md` symlink to the same content. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Added a root `CHANGELOG.md` with unreleased and release-section structure for future updates. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Added stricter assignment/task regression coverage for structural markdown escaping, task-command terminal-state handling, runtime var validation, Codex interruption, and subprocess abort paths. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Added `assignments/plan-feature/` — a meta-assignment that turns a free-form feature description (passed as the positional message body) into an executable task-runner plan. The planner surveys repo conventions, impact surface, reuse opportunities, and risks, then copies a reference template into `.task-runner/drafts/`, fills in every placeholder with concrete file-level detail, and runs `task-runner init` to freeze the draft into a new run workspace that any agent can resume.

### Changed

- Shared workspace task-state loading and persistence between the run loop and CLI task commands so assignment overlays, manifest snapshots, and canonical writes follow one code path. ([#6](https://github.com/kcosr/task-runner/pull/6))
- Updated the standard verification workflow so `npm run check` runs build, lint, and test coverage together. ([#6](https://github.com/kcosr/task-runner/pull/6))
- `assignments/code-review/` now accepts an optional `implementation_plan` var pointing at a task-runner workspace `assignment.md`. When set, a new `t12_plan_coverage` task verifies that every task in the referenced plan actually shipped in the diff — flagging silent deferrals and dropped review fixes at HIGH/CRITICAL severity. The synthesis task is renumbered to `t13_synthesis` and folds plan-coverage findings into its ranked list. Reviews launched without the var skip the plan-coverage pass cleanly.
- `assignments/code-review/` now ends with an explicit `t14_approval` ship / no-ship decision task. The task lives separately from the synthesis so the reviewer's *decision* ("I approve this work") is distinct from the synthesis *deliverable* ("here is the ranked findings list"). Review runs exit `success` (code 0) only when the reviewer approves; unresolved HIGH/CRITICAL findings or open plan-coverage gaps mark the task `blocked` and the run exits `blocked` (code 2), giving scripts a first-class ship gate. Delta re-reviews re-evaluate the approval against the post-fix state and preserve prior decision records for audit.

### Fixed

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

# Changelog

## [Unreleased]

### Breaking Changes

### Added

- Added agent onboarding guidance in `AGENTS.md` and a `CLAUDE.md` symlink to the same content.
- Added a root `CHANGELOG.md` with unreleased and release-section structure for future updates.
- Added stricter assignment/task regression coverage for structural markdown escaping, task-command terminal-state handling, runtime var validation, Codex interruption, and subprocess abort paths.

### Changed

- Shared workspace task-state loading and persistence between the run loop and CLI task commands so assignment overlays, manifest snapshots, and canonical writes follow one code path.
- Updated the standard verification workflow so `npm run check` runs build, lint, and test coverage together.

### Fixed

- Fixed workspace persistence to use atomic writes for manifests, attempt logs, and assignment files, and reject resume targets whose manifest paths do not match the workspace they were loaded from.
- Fixed Codex timeout/abort cleanup to wait for late-arriving turn ids and retry interruption, reducing the risk of orphaned remote turns.
- Fixed assignment/task mutation hardening around structural marker escaping, single-line task titles, terminal non-passive notes-only edits, and undeclared or mistyped runtime vars.
- Fixed subprocess handling to short-circuit pre-aborted launches before spawning child processes.

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

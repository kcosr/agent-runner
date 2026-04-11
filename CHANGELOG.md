# Changelog

## [Unreleased]

### Breaking Changes

### Added

- Added agent onboarding guidance in `AGENTS.md` and a `CLAUDE.md` symlink to the same content.
- Added a root `CHANGELOG.md` with unreleased and release-section structure for future updates.

### Changed

- Updated the standard verification workflow so `npm run check` runs build, lint, and test coverage together.

### Fixed

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

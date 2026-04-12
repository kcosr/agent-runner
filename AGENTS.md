# Agent Onboarding (task-runner)

This file is a lightweight, internal onboarding note for agents working in this repo. It is not part of the product output.

## Start Here

- Read `README.md` for the CLI surface, workflow model, and run/assignment semantics.
- Read `docs/design.md` for the manifest-canonical design, lifecycle rules, and resume policy.
- Primary entry points are `src/cli.ts`, `src/runner/run-loop.ts`, and `src/runner/manifest.ts`.
- Task parsing/rendering lives in `src/assignment/*`; config loading and schemas live in `src/config/*`; backend adapters live in `src/backends/*`.
- Built-in agents and assignments live in `agents/` and `assignments/`.

## Conventions

- TypeScript, ESM modules, Node CLI.
- Source of truth lives in `src/`; distributable CLI output is generated into `dist/` via `npm run build`.
- Formatting and linting are handled by Biome (`biome.json`); pre-commit runs `lint-staged`.
- Keep edits ASCII-only unless a file already uses Unicode.
- Prefer small, focused changes that preserve the existing CLI and manifest invariants.
- Prefer end-state implementations over transitional ones.
- Avoid fallback logic and heuristic shape-detection when the contract can be made explicit.
- Treat config/schema/API redesigns and migrations as hot cuts unless the caller explicitly asks for backward compatibility.

## Testing Requirements

- Run `npm install` to install dependencies.
- Run `npm run build` when you change anything under `src/` or otherwise affect generated `dist/`.
- Run `npm test` for functional changes.
- Run `npm run lint` to check formatting and lint rules.
- Run `npm run check` to run the standard verification pipeline (`build`, `lint`, `test`).
- If you change `src/`, commit the corresponding `dist/` output.
- If you cannot run the relevant checks, call that out explicitly.

## Changelog

Location: `CHANGELOG.md` (root)

### Format

Use these sections under `## [Unreleased]`:
- `### Breaking Changes` - API or workflow changes requiring migration
- `### Added` - New features
- `### Changed` - Changes to existing behavior
- `### Fixed` - Bug fixes
- `### Removed` - Removed features

### Rules

- New entries always go under `## [Unreleased]`.
- Append to existing subsections; do not create duplicate subsection headers.
- Do not rewrite already-released sections unless you are correcting a factual error.
- Keep entries concise and user-facing.
- Include PR links when they exist; otherwise use plain bullets.

## Releasing

### During Development

- Add changelog entries under `## [Unreleased]` as part of the same branch that introduces the change.
- Keep release notes scoped to behavior that users or maintainers would care about.

### When Ready to Release

1. Make sure `CHANGELOG.md` under `## [Unreleased]` reflects the release contents.
2. Run `npm run check`.
3. Bump the package version with `npm version patch`, `npm version minor`, or `npm version major`.
4. Move the unreleased entries into a dated release section in `CHANGELOG.md`.

Notes:
- This repo does not currently ship with an automated release script.
- If release automation is added later, update this file instead of carrying stale manual instructions.

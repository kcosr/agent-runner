# Agent Onboarding (task-runner)

This file is a lightweight, internal onboarding note for agents working in this repo. It is not part of the product output.

## Start Here

- Read `README.md` for the CLI surface, workflow model, and run/assignment semantics.
- Read `docs/design.md` for the manifest-canonical design, lifecycle rules, and resume policy.
- Read `docs/scope.md` for product scope and direction. When triaging feature requirements, raise likely scope concerns before planning or implementing.
- Primary entry points are `apps/cli/src/cli.ts`, `packages/core/src/core/run/run-loop.ts`, and `packages/core/src/core/run/manifest.ts`.
- Task parsing/rendering lives in `packages/core/src/assignment/*`; config loading lives in `packages/core/src/config/*`; backend adapters live in `packages/core/src/backends/*`; daemon transports live in `apps/cli/src/daemon/*`.
- Built-in agents and assignments live in `agents/` and `assignments/`.

## Conventions

- TypeScript, ESM modules, Node CLI.
- Source of truth lives in `apps/cli/src/` and `packages/core/src/`; distributable output is generated into workspace `dist/` directories via `npm run build`.
- Formatting and linting are handled by Biome (`biome.json`); pre-commit runs `lint-staged`.
- Keep edits ASCII-only unless a file already uses Unicode.
- Prefer small, focused changes that preserve the existing CLI and manifest invariants.
- Prefer end-state implementations over transitional ones.
- Avoid fallback logic and heuristic shape-detection when the contract can be made explicit.
- Treat config/schema/API redesigns and migrations as hot cuts unless the caller explicitly asks for backward compatibility.

### Validation and defensive code

- Validate data at trust boundaries, not repeatedly in internal code.
- Do not add duplicate runtime guards for values already guaranteed by parsing, schema validation, control flow, or TypeScript types.
- In reviews, flag redundant null checks, shape checks, and fallback branches that do not protect a real boundary or invariant.

TypeScript specifics:

- Prefer narrowing once and passing strongly typed values downstream.
- Prefer stricter parameter types over re-checking broad inputs in private helpers.
- Do not add `if (!x)`, `typeof`, `Array.isArray`, or property-existence checks in internal code when the type and calling path already guarantee them.

Repeated checks remain legitimate when:

- the inner function is public or reusable across trust boundaries
- async/stateful code can invalidate assumptions between checks
- the second check enforces a different business invariant, not the same input shape

## Testing Requirements

- Run `npm install` to install dependencies.
- Run `npm run build` when you change anything under `apps/cli/src/`, `packages/core/src/`, or otherwise affect generated workspace `dist/` output.
- Run `npm test` for functional changes.
- Run `npm run lint` to check Biome lint rules with warnings treated as failures.
- Run `npm run lint:fix` to apply Biome lint autofixes.
- Run `npm run format` to apply Biome formatting.
- Run `npm run format:check` to verify Biome formatting without writing.
- Run `npm run imports:fix` to apply Biome import organization.
- Run `npm run imports:check` to verify Biome import organization without writing.
- Run `npm run check:knip` when dependency, export, or entry-point metadata changes.
- Run `npm run check` to sync to `r10` and run the standard verification pipeline (`build`, `lint`, `format:check`, `imports:check`, `test`).
- Do not commit `dist/`; build artifacts are generated locally and during packaging.
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

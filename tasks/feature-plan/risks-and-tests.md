---
schemaVersion: 1
id: feature-plan/risks-and-tests
title: Risks, edge cases, and test strategy
---
For each impact area from `feature-plan/survey-impact`, identify in Notes:
  - Concurrency, state-machine, or lifecycle risks
  - Error paths and edge cases the feature must
    handle (malformed inputs, missing files,
    permission errors, partial writes, cancellation)
  - Existing test coverage on the area, or the
    absence of it
  - New tests the feature will need — unit,
    integration, or end-to-end — and where they will
    live (file paths from `feature-plan/orient`
    conventions)
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

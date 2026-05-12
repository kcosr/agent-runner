---
schemaVersion: 1
id: feature-plan/check-existing-code
title: Existing-code and duplication check
---
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
